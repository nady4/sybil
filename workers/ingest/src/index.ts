import {
  langfuseIngestionToEnvelopes,
  langfuseTraceToEnvelope,
  normalizeEnvelope,
  normalizeOtlp,
  PLAN_LIMITS,
  sha256Hex,
  stableHash,
  type Org,
  type Run,
} from "@agentsre/shared";
import { DurableObject } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
  INGEST_QUEUE: Queue<{ orgId: string; runs: Run[] }>;
  SCHEDULER_SERVICE: Fetcher;
  DAILY_CAPS: KVNamespace;
  ORG_RATE_LIMITER: DurableObjectNamespace<OrgRateLimiter>;
}

export interface AuthContext {
  orgId: string;
  org: Org;
}

/** Bearer API key auth: hash -> api_keys -> org. Never compares raw keys. */
export async function authenticate(req: Request, env: Env): Promise<AuthContext | undefined> {
  const header = req.headers.get("authorization") ?? "";
  // Bearer (AgentsRE SDK/CLI) or Basic (Langfuse SDK sends base64(publicKey:secretKey)).
  let token = "";
  if (header.startsWith("Bearer ")) {
    token = header.slice(7);
  } else if (header.startsWith("Basic ")) {
    try {
      token = atob(header.slice(6)).split(":")[0] ?? "";
    } catch {
      return undefined;
    }
  }
  if (!token) return undefined;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT k.org_id, k.revoked_at, o.name, o.plan, o.created_at
     FROM api_keys k JOIN orgs o ON o.id = k.org_id
     WHERE k.key_hash = ?`,
  ).bind(hash).first<{ org_id: string; revoked_at: string | null; name: string; plan: Org["plan"]; created_at: string }>();
  if (!row || row.revoked_at) return undefined;
  return {
    orgId: row.org_id,
    org: {
      id: row.org_id,
      name: row.name,
      plan: row.plan,
      limits: PLAN_LIMITS[row.plan],
      createdAt: row.created_at,
    },
  };
}

/**
 * OrgRateLimiter — token-bucket burst control for inbound telemetry.
 * One DO per org. The same class lives in the scheduler worker; each
 * worker owns its own namespace.
 */
export class OrgRateLimiter extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/take" && req.method === "POST") {
      const { n } = (await req.json()) as { n?: number };
      const cost = Math.max(1, Math.floor(n ?? 1));
      const now = Date.now();
      const state = (await this.ctx.storage.get<{ tokens: number; lastRefill: number }>("bucket")) ?? {
        tokens: 1000,
        lastRefill: now,
      };
      const elapsed = (now - state.lastRefill) / 1000;
      state.tokens = Math.min(1000, state.tokens + elapsed * 100);
      state.lastRefill = now;
      const allowed = state.tokens >= cost;
      if (allowed) state.tokens -= cost;
      await this.ctx.storage.put("bucket", state);
      return Response.json({ allowed, retryAfterSec: allowed ? 0 : Math.ceil((cost - state.tokens) / 100) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

const MAX_BODY = 5 * 1024 * 1024;

interface LangfuseTraceState {
  trace?: import("@agentsre/shared").LangfuseIngestionEvent;
  observations: import("@agentsre/shared").LangfuseIngestionEvent[];
  updatedAt: number;
}

const LF_TTL_SEC = 600;

/**
 * Assemble Langfuse ingestion events across requests. The SDK batches
 * per-event-type when flushAt is small, so trace-create may arrive after
 * its observations (or vice versa). KV holds partial state per
 * (org, traceId); the run is emitted once both sides are present.
 * Deterministic trace ids make re-emits idempotent downstream.
 */
async function assembleLangfuseIngestion(
  env: Env,
  orgId: string,
  body: Parameters<typeof langfuseIngestionToEnvelopes>[0],
): Promise<{ orgId: string; runs: Run[]; rejected: number }> {
  const runs: Run[] = [];
  const keyOf = (traceId: string) => `lf:${orgId}:${traceId}`;

  const emitIfComplete = async (key: string, state: LangfuseTraceState): Promise<void> => {
    if (!state.trace || state.observations.length === 0) return;
    const envelope = langfuseIngestionToEnvelopes({ batch: [state.trace, ...state.observations] })[0];
    if (!envelope) return;
    runs.push(...normalizeEnvelope(envelope).runs);
    await env.DAILY_CAPS.delete(key);
  };

  for (const ev of body.batch ?? []) {
    const bodyObj = (ev.body ?? {}) as Record<string, unknown>;
    const traceId =
      ev.type === "trace-create" ? (bodyObj.id as string | undefined) : (bodyObj.traceId as string | undefined);
    if (!traceId) continue;
    const key = keyOf(traceId);
    const state: LangfuseTraceState = ((await env.DAILY_CAPS.get(key, "json")) as LangfuseTraceState | null) ?? {
      trace: undefined,
      observations: [],
      updatedAt: Date.now(),
    };
    if (ev.type === "trace-create") {
      state.trace = ev;
    } else if (ev.type.endsWith("-create")) {
      state.observations = [...state.observations, ev];
    } else {
      continue; // updates merge onto the emitted run's row elsewhere; ignore here
    }
    state.updatedAt = Date.now();
    await env.DAILY_CAPS.put(key, JSON.stringify(state), { expirationTtl: LF_TTL_SEC });
    await emitIfComplete(key, state);
  }
  return { orgId, runs, rejected: 0 };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    const auth = await authenticate(req, env);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });

    const limiter = env.ORG_RATE_LIMITER.get(env.ORG_RATE_LIMITER.idFromName(auth.orgId));
    const take = await limiter.fetch("https://do/take", {
      method: "POST",
      body: JSON.stringify({ n: 1 }),
    }).then((r) => r.json() as Promise<{ allowed: boolean; retryAfterSec: number }>);
    if (!take.allowed) {
      return Response.json(
        { error: "rate limited" },
        { status: 429, headers: { "retry-after": String(take.retryAfterSec) } },
      );
    }

    const dayKey = `daily:${auth.orgId}:${new Date().toISOString().slice(0, 10)}`;
    const usedToday = Number((await env.DAILY_CAPS.get(dayKey).catch(() => null)) ?? "0");

    let payload: { orgId: string; runs: Run[]; rejected: number };
    if (url.pathname === "/v1/otlp") {
      const body = await req.json();
      payload = normalizeOtlp(body, auth.orgId);
    } else if (url.pathname === "/v1/traces" || url.pathname === "/v1/runs") {
      const body = await req.json();
      payload = normalizeEnvelope(body);
    } else if (url.pathname === "/api/public/trace" || url.pathname === "/v1/langfuse") {
      // Langfuse-compatible single-trace endpoint: SDK baseUrl points at us.
      const body = (await req.json()) as Parameters<typeof langfuseTraceToEnvelope>[0];
      payload = normalizeEnvelope(langfuseTraceToEnvelope(body));
    } else if (url.pathname === "/api/public/ingestion") {
      // Langfuse batch ingestion ({ batch, metadata }) — what the real SDK sends.
      // The SDK splits events across requests when flushAt is small, so
      // trace-creates and observations are assembled in KV per trace.
      const body = (await req.json()) as Parameters<typeof langfuseIngestionToEnvelopes>[0];
      payload = await assembleLangfuseIngestion(env, auth.orgId, body);
    } else {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    if (payload.runs.length === 0) {
      return Response.json({ ok: true, accepted: 0, rejected: payload.rejected });
    }

    if (usedToday + payload.runs.length > auth.org.limits.maxRunsPerDay) {
      return Response.json({ error: "daily run cap exceeded" }, { status: 429 });
    }

    await env.DAILY_CAPS.put(dayKey, String(usedToday + payload.runs.length));
    await env.INGEST_QUEUE.send({ orgId: auth.orgId, runs: payload.runs });

    return Response.json({ ok: true, accepted: payload.runs.length, rejected: payload.rejected });
  },

  async queue(batch: MessageBatch<{ orgId: string; runs: Run[] }>, env: Env): Promise<void> {
    if (batch.queue === "agentsre-ingest-dlq") {
      for (const msg of batch.messages) {
        await env.DB.prepare(
          "INSERT INTO failed_deliveries (id, queue, body) VALUES (?, 'agentsre-ingest', ?)",
        )
          .bind(`fd_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`, JSON.stringify(msg.body).slice(0, 100_000))
          .run();
      }
      return;
    }
    const statements: D1PreparedStatement[] = [];
    const events: Array<{
      runId: string;
      orgId: string;
      featureId: string;
      model: string;
      latencyMs?: number;
      costUsd?: number;
      evalScore?: number;
      status: Run["status"];
      completedAt: string;
    }> = [];

    for (const msg of batch.messages) {
      const { orgId, runs } = msg.body;
      // Org-scoped, deterministic run ids: no cross-org PK collisions, and
      // queue retries replay to the same id (INSERT OR IGNORE stays idempotent).
      const orgHash = (await stableHash(orgId)).slice(0, 8);
      for (const run of runs) {
        // The authenticated org wins; the payload's orgId field is never trusted.
        run.orgId = orgId;
        run.id = `prod_${orgHash}_${run.id.replace(/^prod_/, "")}`;
        statements.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO runs
             (id, org_id, feature_id, tenant_id, source, agent_id, model, input_tokens, output_tokens,
              reasoning_tokens, cost_usd, latency_ms, status, error_type, guardrail_tripped, eval_score,
              eval_score_components, steps_json, meta_json, started_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            run.id,
            run.orgId,
            run.featureId,
            run.tenantId ?? null,
            run.source,
            run.agentId ?? null,
            run.model ?? null,
            run.inputTokens ?? null,
            run.outputTokens ?? null,
            run.reasoningTokens ?? null,
            run.costUsd ?? null,
            run.latencyMs ?? null,
            run.status,
            run.errorType ?? null,
            run.guardrailTripped ? 1 : 0,
            run.evalScore ?? null,
            run.evalScoreComponents ? JSON.stringify(run.evalScoreComponents) : null,
            run.steps ? JSON.stringify(run.steps) : null,
            run.meta ? JSON.stringify(run.meta) : null,
            run.startedAt,
            run.completedAt,
          ),
        );
        for (const [si, step] of (run.steps ?? []).entries()) {
          for (const tc of step.toolCalls) {
            statements.push(
              env.DB.prepare(
                `INSERT OR IGNORE INTO tool_calls (id, run_id, step_index, tool_name, tool_input, tool_output, latency_ms, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              ).bind(
                `${run.id}_tc_${si}`,
                run.id,
                si,
                tc.name,
                tc.input !== undefined ? JSON.stringify(tc.input) : null,
                tc.output !== undefined ? JSON.stringify(tc.output) : null,
                tc.latencyMs ?? null,
                tc.error ?? null,
              ),
            );
          }
        }
        events.push({
          runId: run.id,
          orgId,
          featureId: run.featureId,
          model: run.model ?? "unknown",
          latencyMs: run.latencyMs,
          costUsd: run.costUsd,
          evalScore: run.evalScore,
          status: run.status,
          completedAt: run.completedAt,
        });
      }
    }

    if (statements.length) await env.DB.batch(statements);

    for (const ev of events) {
      let notified = false;
      for (let attempt = 0; attempt < 3 && !notified; attempt++) {
        try {
          const res = await env.SCHEDULER_SERVICE.fetch("https://scheduler/internal/coordinator", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ev),
          });
          if (res.ok) {
            notified = true;
          } else {
            console.error(`coordinator notify ${res.status} for ${ev.runId} (attempt ${attempt + 1}): ${(await res.text()).slice(0, 200)}`);
          }
        } catch (e) {
          console.error(`coordinator notify failed for ${ev.runId} (attempt ${attempt + 1}): ${e instanceof Error ? e.message : e}`);
        }
        if (!notified && attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      // If a run's event cannot reach the coordinator, fail the batch so the
      // queue retries it (inserts are idempotent via INSERT OR IGNORE).
      if (!notified) throw new Error(`coordinator unreachable for ${ev.runId}`);
    }
  },
};
