import type { Alert, AlertChannelType, AlertStatus, Check, Run } from "@agentsre/shared";
import { createCheckSchema, type SuccessCriterion } from "@agentsre/shared";

/**
 * AgentsRE SDK. Checks-as-code: define checks in TypeScript, deploy via
 * the API worker. The same definitions the CLI uploads can be committed
 * to the customer's repo and reviewed in CI.
 */

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Where telemetry endpoints (/v1/traces, /v1/otlp) live; defaults to baseUrl. */
  ingestUrl?: string;
  fetchImpl?: typeof fetch;
}

export class Client {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly ingestUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.ingestUrl = (opts.ingestUrl ?? opts.baseUrl).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, base?: string): Promise<T> {
    const res = await this.fetchImpl(`${base ?? this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ""}`);
    }
    return data;
  }

  checksList(featureId?: string): Promise<{ checks: Check[] }> {
    const q = featureId ? `?featureId=${encodeURIComponent(featureId)}` : "";
    return this.request("GET", `/v1/checks${q}`);
  }

  checkCreate(check: CheckDefinition): Promise<{ check: Check }> {
    return this.request("POST", "/v1/checks", check);
  }

  checkUpdate(id: string, patch: Partial<CheckDefinition>): Promise<{ check: Check }> {
    return this.request("PATCH", `/v1/checks/${id}`, patch);
  }

  checkDelete(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/v1/checks/${id}`);
  }

  /** Idempotent deploy: upsert by (featureId, name). */
  async deployCheck(def: CheckDefinition): Promise<Check> {
    const { checks } = await this.checksList(def.featureId);
    const existing = checks.find((c) => c.name === def.name && c.featureId === def.featureId);
    if (existing) {
      const { check } = await this.checkUpdate(existing.id, def);
      return check;
    }
    const { check } = await this.checkCreate(def);
    return check;
  }

  runsList(filters: { featureId?: string; source?: "synthetic" | "production"; status?: string; limit?: number } = {}): Promise<{ runs: Run[] }> {
    const q = new URLSearchParams();
    if (filters.featureId) q.set("featureId", filters.featureId);
    if (filters.source) q.set("source", filters.source);
    if (filters.status) q.set("status", filters.status);
    if (filters.limit) q.set("limit", String(filters.limit));
    const qs = q.toString();
    return this.request("GET", `/v1/runs${qs ? `?${qs}` : ""}`);
  }

  /** Direct production-run ingest (used by the Helicone importer). */
  ingestRun(run: {
    id: string;
    featureId: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    costUsd?: number;
    status: string;
    errorType?: string;
    meta?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
  }): Promise<{ ok: boolean; accepted: number; rejected: number }> {
    const now = new Date().toISOString();
    const startedAt = run.startedAt ?? now;
    return this.request("POST", "/v1/traces", {
      trace: { id: run.id, featureId: run.featureId, startedAt },
      observations: [
        {
          name: run.id,
          model: run.model,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          latencyMs: run.latencyMs,
          costUsd: run.costUsd,
          status: run.status,
          errorType: run.errorType,
          startTime: startedAt,
          endTime: run.completedAt ?? startedAt,
          metadata: run.meta,
        },
      ],
    }, this.ingestUrl);
  }

  runGet(id: string): Promise<{ run: Run }> {
    return this.request("GET", `/v1/runs/${id}`);
  }

  alertsList(status?: AlertStatus): Promise<{ alerts: Alert[] }> {
    return this.request("GET", `/v1/alerts${status ? `?status=${status}` : ""}`);
  }

  alertAck(id: string): Promise<{ ok: true }> {
    return this.request("POST", `/v1/alerts/${id}/ack`);
  }

  alertResolve(id: string): Promise<{ ok: true }> {
    return this.request("POST", `/v1/alerts/${id}/resolve`);
  }

  baselinesList(featureId?: string): Promise<{ baselines: unknown[] }> {
    return this.request("GET", `/v1/baselines${featureId ? `?featureId=${encodeURIComponent(featureId)}` : ""}`);
  }

  /** The fused view: synthetic + production shape + baselines + alerts for one feature. */
  correlation(featureId: string): Promise<{
    featureId: string;
    checks: unknown[];
    baselines: unknown[];
    recentAlerts: unknown[];
    synthetic: { runs24h: number; passRate?: number; avgEval?: number; cost24hUsd: number };
    production: {
      runs24h: number;
      passRate?: number;
      avgEval?: number;
      cost24hUsd: number;
      p50LatencyMs?: number;
      p95LatencyMs?: number;
      errorRate?: number;
      refusalRate?: number;
    };
    correlation: { last15m: { syntheticRuns: number; syntheticFailures: number; productionRuns: number; productionErrors: number } };
  }> {
    return this.request("GET", `/v1/features/${encodeURIComponent(featureId)}/correlation`);
  }

  summary(): Promise<{
    openAlerts: number;
    runsToday: number;
    successRate: number | null;
    byStatus: Record<string, number>;
    costTodayUsd: number;
  }> {
    return this.request("GET", "/v1/summary");
  }

  apiKeyCreate(name: string): Promise<{ apiKey: { id: string; name: string; key: string } }> {
    return this.request("POST", "/v1/api-keys", { name });
  }

  providerKeySet(provider: string, key: string, label?: string): Promise<{ ok: true }> {
    return this.request("PUT", "/v1/provider-keys", { provider, key, label });
  }

  alertChannelCreate(name: string, type: AlertChannelType, config: Record<string, string>): Promise<{ channel: { id: string } }> {
    return this.request("POST", "/v1/alert-channels", { name, type, config });
  }
}

export type CheckDefinition = {
  featureId: string;
  name: string;
  description?: string;
  prompt: string;
  system?: string;
  target?: string;
  allowedDomains?: string[];
  successCriteria: SuccessCriterion[];
  intervalMinutes?: number;
  regions?: string[];
  provider?: "openai" | "anthropic" | "bedrock";
  model?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  redactionRules?: string[];
  alertChannelIds?: string[];
  /** Static request headers for auth'd targets (encrypted at rest). */
  headers?: Record<string, string>;
};

/** Build-time validation so config errors fail `agentsre deploy`, not at 3am. */
export function defineCheck(def: CheckDefinition): CheckDefinition {
  const parsed = createCheckSchema.safeParse(def);
  if (!parsed.success) {
    throw new Error(
      `invalid check "${def.name}": ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return def;
}
