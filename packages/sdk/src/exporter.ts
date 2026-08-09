/**
 * AgentsReExporter — drop-in production telemetry for agent runtimes.
 *
 * Wrap LLM calls (or observe steps explicitly) and the exporter batches
 * observations into one envelope per trace, POSTed to the ingest worker
 * (/v1/traces). Runs in Node and Workers; no dependencies. Never throws
 * into the host application: failures are retried twice, then dropped
 * (optionally reported via `onError`).
 */

export interface ExporterObservation {
  name?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  latencyMs?: number;
  status?: "success" | "failed" | "error" | "refused";
  errorType?: string;
  guardrailTripped?: boolean;
  toolCalls?: Array<{ name: string; input?: unknown; output?: unknown; latencyMs?: number; error?: string }>;
  input?: unknown;
  output?: unknown;
}

export interface ExporterOptions {
  /** Ingest base URL (defaults to https://api.agentsre.dev). */
  ingestUrl?: string;
  apiKey: string;
  featureId: string;
  agentId?: string;
  tenantId?: string;
  /** Regex rules applied server-side to stored content (PII scrub). */
  redactionRules?: string[];
  /** Flush when the buffer exceeds this many observations (default 50). */
  maxBuffer?: number;
  /** Fallback flush interval in ms for long-running agents (default 5000). */
  intervalMs?: number;
  onError?: (err: Error) => void;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INGEST = "https://api.agentsre.dev";

export class AgentsReExporter {
  private readonly ingestUrl: string;
  private readonly apiKey: string;
  private readonly featureId: string;
  private readonly agentId?: string;
  private readonly tenantId?: string;
  private readonly redactionRules?: string[];
  private readonly maxBuffer: number;
  private readonly onError?: (err: Error) => void;
  private readonly fetchImpl: typeof fetch;

  private traceId = "";
  private startedAt = "";
  private observations: ExporterObservation[] = [];
  private flushing = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(opts: ExporterOptions) {
    this.ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.featureId = opts.featureId;
    this.agentId = opts.agentId;
    this.tenantId = opts.tenantId;
    this.redactionRules = opts.redactionRules;
    this.maxBuffer = opts.maxBuffer ?? 50;
    this.onError = opts.onError;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.newTrace();
  }

  /** Start a fresh trace (call between agent runs if you reuse the exporter). */
  newTrace(): void {
    this.traceId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();
    this.observations = [];
  }

  /** Wrap one LLM call: your fn runs, you report usage via the callback. */
  async capture<T>(fn: (observe: (o: ExporterObservation) => void) => Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await fn((o) => {
      if (o.latencyMs === undefined) o.latencyMs = Math.max(0, Math.round(performance.now() - started));
      this.observe(o);
    });
    return result;
  }

  /** Record one observation (a generation/span step of the trace). */
  observe(o: ExporterObservation): void {
    if (this.closed) return;
    this.observations.push(o);
    if (this.observations.length >= this.maxBuffer) {
      void this.flush();
    }
  }

  /** Send the current trace immediately. Resolves without throwing. */
  async flush(): Promise<boolean> {
    if (this.flushing) return false;
    if (this.observations.length === 0) return false;
    this.flushing = true;
    const traceId = this.traceId;
    const startedAt = this.startedAt;
    const observations = this.observations;
    this.newTrace();
    try {
      return await this.post(traceId, startedAt, observations);
    } finally {
      this.flushing = false;
    }
  }

  /** Stop background flushing (call on shutdown after a final flush). */
  close(): void {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
  }

  private async post(
    traceId: string,
    startedAt: string,
    observations: ExporterObservation[],
  ): Promise<boolean> {
    const body = {
      schemaVersion: "1.0",
      trace: {
        id: traceId,
        featureId: this.featureId,
        agentId: this.agentId,
        tenantId: this.tenantId,
        startedAt,
        redactionRules: this.redactionRules,
      },
      observations,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.ingestUrl}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
        });
        if (res.ok) return true;
        if (res.status === 401 || res.status === 429) return false; // not retryable
      } catch (e) {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    this.onError?.(new Error("exporter: trace delivery failed after retries"));
    return false;
  }
}

/** Start an interval-based fallback flush; returns a disposer. */
export function startAutoFlush(exporter: AgentsReExporter, intervalMs = 5000): () => void {
  const t = setInterval(() => {
    void exporter.flush();
  }, intervalMs);
  return () => clearInterval(t);
}
