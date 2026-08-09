import { costFor } from "./pricing.js";
import { redactValue } from "./redact.js";
import type { AgentStep, Run } from "./types.js";

/**
 * Normalization of inbound telemetry into unified Run records.
 *
 * Two shapes are accepted:
 *  - the AgentsRE envelope (Langfuse-shaped): { trace, observations }
 *  - OTLP HTTP JSON (resourceSpans / gen_ai semantic conventions)
 *
 * Every normalized Run carries cost fields — computed from the pricing
 * table when the client does not supply them.
 */

export interface IngestPayload {
  orgId: string;
  runs: Run[];
  rejected: number;
}

function iso(ts?: string, fallback = new Date()): string {
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

function stringifyContent(v: unknown): string | undefined {
  if (typeof v === "string") return v.slice(0, 4000);
  try {
    return JSON.stringify(v).slice(0, 4000);
  } catch {
    return undefined;
  }
}

/** Normalize the AgentsRE envelope into one Run per trace. */
export function normalizeEnvelope(body: unknown): IngestPayload {
  const envelope = body as {
    trace?: {
      id?: string;
      orgId?: string;
      featureId?: string;
      agentId?: string;
      tenantId?: string;
      startedAt?: string;
      redactionRules?: string[];
    };
    observations?: Array<{
      id?: string;
      name?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
      latencyMs?: number;
      status?: string;
      errorType?: string;
      guardrailTripped?: boolean;
      toolCalls?: Array<{ name: string; input?: unknown; output?: unknown; latencyMs?: number; error?: string }>;
      input?: unknown;
      output?: unknown;
      startTime?: string;
      endTime?: string;
    }>;
  };
  const trace = envelope?.trace;
  if (!trace?.featureId) return { orgId: "", runs: [], rejected: 1 };

  const startedAt = iso(trace.startedAt);
  const completedAt = iso(undefined, new Date(new Date(startedAt).getTime() + 1));
  const obs = envelope?.observations ?? [];
  const redactionRules = trace.redactionRules ?? [];

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let latencyMs = 0;
  let status: Run["status"] = "success";
  let errorType: string | undefined;
  let guardrailTripped = false;

  const steps = obs.map((o, i) => {
    inputTokens += o.inputTokens ?? 0;
    outputTokens += o.outputTokens ?? 0;
    reasoningTokens += o.reasoningTokens ?? 0;
    if (o.latencyMs !== undefined) latencyMs += o.latencyMs;
    if (o.guardrailTripped) guardrailTripped = true;
    if (o.status && o.status !== "success") {
      status = o.status as Run["status"];
      if (o.errorType) errorType = o.errorType;
    }
    const stepCost = o.model
      ? o.costUsd ?? costFor(o.model, {
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          reasoningTokens: o.reasoningTokens,
        })
      : undefined;
    if (stepCost !== undefined) costUsd += stepCost;
    const redact = (v: unknown) => (redactionRules.length ? redactValue(v, redactionRules) : v);
    return {
      index: i,
      model: o.model ?? "",
      latencyMs: o.latencyMs ?? 0,
      usage: {
        inputTokens: o.inputTokens ?? 0,
        outputTokens: o.outputTokens ?? 0,
        reasoningTokens: o.reasoningTokens ?? 0,
      },
      costUsd: stepCost,
      toolCalls: (o.toolCalls ?? []).map((t) => ({
        name: t.name,
        input: redact(t.input),
        output: redact(t.output),
        latencyMs: t.latencyMs,
        error: t.error,
      })),
      refused: (o.status ?? "") === "refused",
      content: o.output !== undefined ? stringifyContent(redact(o.output)) : o.name,
    };
  });

  const run: Run = {
    id: `prod_${trace.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
    orgId: trace.orgId ?? "",
    featureId: trace.featureId,
    tenantId: trace.tenantId,
    source: "production",
    agentId: trace.agentId,
    model: obs.find((o) => o.model)?.model,
    inputTokens: inputTokens || undefined,
    outputTokens: outputTokens || undefined,
    reasoningTokens: reasoningTokens || undefined,
    costUsd: costUsd || undefined,
    latencyMs: latencyMs || undefined,
    status,
    errorType,
    guardrailTripped,
    steps: steps.length ? steps : undefined,
    startedAt,
    completedAt,
  };

  return { orgId: trace.orgId ?? "", runs: [run], rejected: 0 };
}

const GEN_AI_USAGE_INPUT = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT = "gen_ai.usage.output_tokens";
const GEN_AI_USAGE_REASONING = "gen_ai.usage.reasoning_tokens";
const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_ERROR_TYPE = "gen_ai.error.type";
const GEN_AI_OPERATION = "gen_ai.operation.name";

interface OtlpSpan {
  traceId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: Record<string, unknown>;
  status?: { code?: number; message?: string };
}

interface OtlpResourceSpans {
  resource?: { attributes?: Record<string, unknown> };
  scopeSpans?: Array<{ scope?: unknown; spans?: OtlpSpan[] }>;
}

function attr(map: Record<string, unknown> | undefined, key: string): unknown {
  return map?.[key] ?? map?.[key.replace(/\./g, "_")];
}

function int(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function spanToStep(span: OtlpSpan, i: number): AgentStep {
  const a = span.attributes ?? {};
  const model =
    (attr(a, GEN_AI_RESPONSE_MODEL) as string | undefined) ??
    (attr(a, GEN_AI_REQUEST_MODEL) as string | undefined) ??
    span.name ??
    "";
  const inputTokens = int(attr(a, GEN_AI_USAGE_INPUT));
  const outputTokens = int(attr(a, GEN_AI_USAGE_OUTPUT));
  const reasoningTokens = int(attr(a, GEN_AI_USAGE_REASONING));
  const start = span.startTimeUnixNano ? Number(span.startTimeUnixNano) / 1e6 : Date.now();
  const end = span.endTimeUnixNano ? Number(span.endTimeUnixNano) / 1e6 : start;
  const failed =
    span.status?.code === 2 || attr(a, GEN_AI_ERROR_TYPE) !== undefined || attr(a, "error.type") !== undefined;
  return {
    index: i,
    model,
    latencyMs: Math.max(0, end - start),
    usage: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      reasoningTokens: reasoningTokens ?? 0,
    },
    costUsd: model ? costFor(model, { inputTokens, outputTokens, reasoningTokens }) : undefined,
    toolCalls: [],
    refused: false,
  };
}

/** Normalize OTLP HTTP JSON (JSON/Protobuf encoding) into one Run per trace. */
export function normalizeOtlp(body: unknown, orgId: string): IngestPayload {
  const root = body as { resourceSpans?: OtlpResourceSpans[] };
  const spans = (root?.resourceSpans ?? [])
    .flatMap((rs) => rs.scopeSpans ?? [])
    .flatMap((ss) => ss.spans ?? []);
  if (spans.length === 0) return { orgId, runs: [], rejected: 0 };

  const byTrace = new Map<string, OtlpSpan[]>();
  for (const s of spans) {
    const key = s.traceId ?? "unknown";
    const list = byTrace.get(key);
    if (list) list.push(s);
    else byTrace.set(key, [s]);
  }

  const runs: Run[] = [];
  for (const [traceId, traceSpans] of byTrace) {
    const genSpans = traceSpans.filter(
      (s) => s.attributes && Object.keys(s.attributes).some((k) => k.startsWith("gen_ai")),
    );
    const model = genSpans.find((s) => attr(s.attributes, GEN_AI_RESPONSE_MODEL) || attr(s.attributes, GEN_AI_REQUEST_MODEL));
    const steps = (genSpans.length ? genSpans : traceSpans)
      .slice()
      .sort((a, b) => Number(a.startTimeUnixNano ?? 0) - Number(b.startTimeUnixNano ?? 0))
      .map((s, i) => spanToStep(s, i));
    const first = traceSpans[0];
    const startNano = first?.startTimeUnixNano ?? String(Date.now() * 1e6);
    const endNano = traceSpans[traceSpans.length - 1]?.endTimeUnixNano ?? startNano;
    const startedAt = new Date(Number(startNano) / 1e6).toISOString();
    const completedAt = new Date(Number(endNano) / 1e6).toISOString();

    const inT = steps.reduce((n, s) => n + s.usage.inputTokens, 0);
    const outT = steps.reduce((n, s) => n + s.usage.outputTokens, 0);
    const reasT = steps.reduce((n, s) => n + (s.usage.reasoningTokens ?? 0), 0);
    const anyError = steps.some((s) => s.model && s.usage.inputTokens === 0 && s.usage.outputTokens === 0 && s.latencyMs === 0) ||
      traceSpans.some((s) => s.status?.code === 2);
    const modelName =
      (model ? attr(model.attributes, GEN_AI_RESPONSE_MODEL) : undefined) ??
      (model ? attr(model.attributes, GEN_AI_REQUEST_MODEL) : undefined) ??
      genSpans[0]?.name;

    runs.push({
      id: `prod_${(traceId ?? crypto.randomUUID().replace(/-/g, "")).slice(0, 18)}`,
      orgId,
      featureId: "otlp-unknown",
      source: "production",
      model: typeof modelName === "string" ? modelName : undefined,
      inputTokens: inT || undefined,
      outputTokens: outT || undefined,
      reasoningTokens: reasT || undefined,
      costUsd: modelName ? costFor(String(modelName), { inputTokens: inT, outputTokens: outT, reasoningTokens: reasT }) : undefined,
      latencyMs: Math.max(0, Number(endNano) - Number(startNano)) / 1e6,
      status: anyError ? "error" : "success",
      guardrailTripped: false,
      steps,
      startedAt,
      completedAt,
    });
  }

  return { orgId, runs, rejected: 0 };
}
