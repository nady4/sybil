import type { Run } from "./types.js";

/**
 * Langfuse-compat adapter.
 *
 * Langfuse SDKs post to POST /api/public/ingestion ({ batch, metadata })
 * and, on older paths, single traces to POST /api/public/trace. Mapping
 * their payloads into our envelope lets Langfuse users point their SDK at
 * AgentsRE with zero code changes — the capture-the-migration-wave path.
 */

/** One ingestion event: { id, type, timestamp, body, metadata? }. */
export interface LangfuseIngestionEvent {
  id: string;
  type: string;
  timestamp?: string;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LangfuseIngestionPayload {
  batch?: LangfuseIngestionEvent[];
  metadata?: Record<string, unknown>;
}

interface LangfuseObservation {
  id?: string;
  type?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  usage?: { input?: number; output?: number; total?: number; unit?: string };
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  level?: string;
  statusMessage?: string;
}

interface LangfuseTracePayload {
  id?: string;
  timestamp?: string;
  name?: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  observations?: LangfuseObservation[];
}

function msBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.max(0, b - a);
}

function statusOf(level?: string, statusMessage?: string): Run["status"] {
  if (level === "ERROR" || level === "FATAL") return "error";
  if (level === "WARNING") return "failed";
  if (statusMessage && statusMessage !== "Success") return "error";
  return "success";
}

/** Convert a Langfuse trace payload into our ingest envelope. */
export function langfuseTraceToEnvelope(payload: LangfuseTracePayload): {
  trace: { id: string; featureId: string; agentId?: string; tenantId?: string; startedAt?: string };
  observations: unknown[];
} {
  const meta = payload.metadata ?? {};
  const featureId =
    (typeof meta.featureId === "string" && meta.featureId) ||
    (typeof meta.feature_id === "string" && meta.feature_id) ||
    payload.name ||
    "langfuse-import";
  return {
    trace: {
      id: payload.id ?? crypto.randomUUID(),
      featureId,
      agentId: typeof meta.agentId === "string" ? meta.agentId : payload.userId,
      tenantId: typeof meta.tenantId === "string" ? meta.tenantId : payload.sessionId,
      startedAt: payload.timestamp,
    },
    observations: (payload.observations ?? []).map((o) => {
      const inputTokens = o.usage?.input ?? o.promptTokens;
      const outputTokens = o.usage?.output ?? o.completionTokens;
      const obsMeta = o.metadata ?? {};
      const toolCalls = Array.isArray(obsMeta.toolCalls) ? obsMeta.toolCalls : undefined;
      return {
        id: o.id,
        name: o.name,
        model: o.model,
        inputTokens,
        outputTokens,
        costUsd: o.cost,
        latencyMs: msBetween(o.startTime, o.endTime),
        status: statusOf(o.level, o.statusMessage),
        errorType: typeof obsMeta.errorType === "string" ? obsMeta.errorType : o.level === "ERROR" ? o.statusMessage : undefined,
        toolCalls,
        startTime: o.startTime,
        endTime: o.endTime,
      };
    }),
  };
}

/**
 * Convert a batch of ingestion events into one envelope per trace.
 *
 * Event types (documented Langfuse contract):
 *  - trace-create            -> the envelope trace
 *  - observation-create      -> an observation (GENERATION / SPAN / EVENT)
 *  - generation-create       -> same shape; treated as GENERATION
 *  - observation-update / generation-update -> merged onto the observation
 *
 * Observations reference their trace via body.traceId. Events without a
 * trace-create are folded into a synthetic trace keyed by traceId.
 */
export function langfuseIngestionToEnvelopes(payload: LangfuseIngestionPayload): Array<{
  trace: { id: string; featureId: string; agentId?: string; tenantId?: string; startedAt?: string };
  observations: unknown[];
}> {
  const events = payload.batch ?? [];
  const byTrace = new Map<string, LangfuseIngestionEvent[]>();
  const traceCreates = new Map<string, LangfuseIngestionEvent>();
  const updates = new Map<string, LangfuseIngestionEvent>();

  for (const ev of events) {
    const body = ev.body ?? {};
    if (ev.type === "trace-create" && typeof body.id === "string") {
      traceCreates.set(body.id, ev);
    } else if (ev.type.endsWith("-update") && typeof body.id === "string") {
      updates.set(body.id, ev);
    } else if (
      (ev.type === "observation-create" || ev.type === "generation-create") &&
      typeof body.traceId === "string"
    ) {
      const list = byTrace.get(body.traceId) ?? [];
      list.push(ev);
      byTrace.set(body.traceId, list);
    }
  }

  const envelopes: Array<{
    trace: { id: string; featureId: string; agentId?: string; tenantId?: string; startedAt?: string };
    observations: unknown[];
  }> = [];

  const allTraceIds = new Set<string>([...traceCreates.keys(), ...byTrace.keys()]);
  for (const traceId of allTraceIds) {
    const create = traceCreates.get(traceId);
    const createBody = (create?.body ?? {}) as Record<string, unknown>;
    const createMeta = (create?.metadata ?? (createBody.metadata as Record<string, unknown> | undefined)) ?? {};
    const featureId =
      (typeof createMeta.featureId === "string" && createMeta.featureId) ||
      (typeof createMeta.feature_id === "string" && createMeta.feature_id) ||
      (typeof createBody.name === "string" && createBody.name) ||
      "langfuse-import";

    const observations: unknown[] = [];
    for (const ev of byTrace.get(traceId) ?? []) {
      const body = ev.body ?? {};
      const merged = { ...body, ...(updates.get(String(body.id ?? ""))?.body ?? {}) };
      const inputTokens =
        (merged.usage as { input?: number } | undefined)?.input ??
        (merged.inputTokens as number | undefined) ??
        (merged.promptTokens as number | undefined);
      const outputTokens =
        (merged.usage as { output?: number } | undefined)?.output ??
        (merged.outputTokens as number | undefined) ??
        (merged.completionTokens as number | undefined);
      const meta = (merged.metadata as Record<string, unknown> | undefined) ?? {};
      const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : undefined;
      observations.push({
        id: body.id,
        name: (body.name as string | undefined) ?? (body.type as string | undefined),
        model: body.model as string | undefined,
        inputTokens,
        outputTokens,
        costUsd: (body.cost as number | undefined) ?? (merged.cost as number | undefined),
        latencyMs: msBetween(body.startTime as string | undefined, body.endTime as string | undefined),
        status: statusOf(body.level as string | undefined, body.statusMessage as string | undefined),
        errorType:
          typeof meta.errorType === "string"
            ? meta.errorType
            : body.level === "ERROR"
              ? (body.statusMessage as string | undefined)
              : undefined,
        toolCalls,
        startTime: body.startTime as string | undefined,
        endTime: body.endTime as string | undefined,
      });
    }

    envelopes.push({
      trace: {
        id: traceId,
        featureId,
        agentId:
          typeof createMeta.agentId === "string"
            ? createMeta.agentId
            : (createBody.userId as string | undefined),
        tenantId:
          typeof createMeta.tenantId === "string"
            ? createMeta.tenantId
            : (createBody.sessionId as string | undefined),
        startedAt: (createBody.timestamp as string | undefined) ?? create?.timestamp,
      },
      observations,
    });
  }
  return envelopes;
}
