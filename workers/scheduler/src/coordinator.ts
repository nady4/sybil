import {
  DEFAULT_ALERT_POLICY,
  detectRegressions,
  id,
  isConfirmed,
  PercentileBuffer,
  seasonPeriodOf,
  type AlertType,
  type AlertDispatchMessage,
  type RunEvent,
  type RunStatus,
} from "@agentsre/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { loadAlertChannels } from "./db.js";

/**
 * FeatureCoordinator — one Durable Object per (org, feature).
 *
 * Maintains percentile ring buffers per (model, season period), persists
 * rolling baselines to D1, detects regressions against them, confirms
 * with a 2-of-3 policy, dedupes (15 min suppression per type), writes the
 * alert row, and enqueues dispatch. This is the heart of the alerting
 * product; it must stay single-instance per feature, hence the DO.
 */

const SUPPRESSION_MS = 15 * 60_000;
/** Persist the baseline every 20 decimated reference samples. */
const BASELINE_WRITE_EVERY = 20;
/** Reference-ring decimation: 1 in 3 events feed the baseline ring so
 *  short bursts of spikes cannot hijack the alerting reference. */
const REF_SAMPLE_EVERY = 3;

interface Ring {
  latency: number[];
  cost: number[];
  evalScores: number[];
  /** Decimated reference rings feeding the persisted baseline. */
  refLatency: number[];
  refCost: number[];
  refEval: number[];
  refTotal: number;
  counts: Record<RunStatus, number>;
  total: number;
  /** Per-alert-type recent verdict ring (for 2-of-3 confirmation). */
  verdicts: Partial<Record<AlertType, boolean[]>>;
  lastAlertAt: Partial<Record<AlertType, number>>;
}

function emptyRing(): Ring {
  return {
    latency: [],
    cost: [],
    evalScores: [],
    refLatency: [],
    refCost: [],
    refEval: [],
    refTotal: 0,
    counts: { success: 0, failed: 0, error: 0, refused: 0 },
    total: 0,
    verdicts: {},
    lastAlertAt: {},
  };
}

export class FeatureCoordinator extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const event = (await req.json()) as RunEvent;
      await this.handleRun(event);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/state" && req.method === "GET") {
      return Response.json(await this.ctx.storage.list());
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async loadBaseline(
    orgId: string,
    featureId: string,
    model: string,
    period: string,
  ): Promise<{
    sampleCount: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    p99LatencyMs?: number;
    p50CostUsd?: number;
    p95CostUsd?: number;
    p50EvalScore?: number;
    p95EvalScore?: number;
    refusalRate?: number;
    errorRate?: number;
  } | undefined> {
    const row = await this.env.DB.prepare(
      `SELECT sample_count, p50_latency_ms, p95_latency_ms, p99_latency_ms, p50_cost_usd, p95_cost_usd,
              p50_eval_score, p95_eval_score, refusal_rate, error_rate
       FROM baselines WHERE org_id = ? AND feature_id = ? AND model = ? AND period = ?`,
    )
      .bind(orgId, featureId, model, period)
      .first<{
        sample_count: number;
        p50_latency_ms: number | null;
        p95_latency_ms: number | null;
        p99_latency_ms: number | null;
        p50_cost_usd: number | null;
        p95_cost_usd: number | null;
        p50_eval_score: number | null;
        p95_eval_score: number | null;
        refusal_rate: number | null;
        error_rate: number | null;
      }>();
    if (!row) return undefined;
    return {
      sampleCount: row.sample_count,
      p50LatencyMs: row.p50_latency_ms ?? undefined,
      p95LatencyMs: row.p95_latency_ms ?? undefined,
      p99LatencyMs: row.p99_latency_ms ?? undefined,
      p50CostUsd: row.p50_cost_usd ?? undefined,
      p95CostUsd: row.p95_cost_usd ?? undefined,
      p50EvalScore: row.p50_eval_score ?? undefined,
      p95EvalScore: row.p95_eval_score ?? undefined,
      refusalRate: row.refusal_rate ?? undefined,
      errorRate: row.error_rate ?? undefined,
    };
  }

  private async ringKey(model: string): Promise<string> {
    return `ring|${model}`;
  }

  private async loadRings(): Promise<Map<string, Ring>> {
    const stored = await this.ctx.storage.list<Ring>({ prefix: "ring|" });
    const rings = new Map<string, Ring>();
    for (const [k, v] of stored) rings.set(k.replace(/^ring\|/, ""), v);
    return rings;
  }

  private async handleRun(e: RunEvent): Promise<void> {
    const period = seasonPeriodOf(e.completedAt);
    const modelKey = `${e.model}|${period}`;
    const rings = await this.loadRings();
    const ring = rings.get(modelKey) ?? emptyRing();

    // Regression detection compares against the PERSISTED baseline row
    // (refreshed every 20 samples), not the live ring: a latency spike
    // must not raise the very baseline it is confirmed against — the
    // 2-of-3 confirmation needs a stable reference.
    const lat = PercentileBuffer.from(ring.latency);
    const cost = PercentileBuffer.from(ring.cost);
    const evals = PercentileBuffer.from(ring.evalScores);
    const liveStats = {
      sampleCount: ring.total,
      p50LatencyMs: lat.quantile(0.5),
      p95LatencyMs: lat.quantile(0.95),
      p99LatencyMs: lat.quantile(0.99),
      p50CostUsd: cost.quantile(0.5),
      p95CostUsd: cost.quantile(0.95),
      p50EvalScore: evals.quantile(0.5),
      p95EvalScore: evals.quantile(0.95),
      refusalRate: ring.total ? ring.counts.refused / ring.total : undefined,
      errorRate: ring.total ? (ring.counts.error + ring.counts.failed) / ring.total : undefined,
    };

    const persisted = await this.loadBaseline(e.orgId, e.featureId, e.model, period);
    const reference =
      persisted && persisted.sampleCount >= DEFAULT_ALERT_POLICY.minSamples ? persisted : liveStats;

    const verdicts = reference.sampleCount >= DEFAULT_ALERT_POLICY.minSamples
      ? detectRegressions(reference, {
          latencyMs: e.latencyMs,
          costUsd: e.costUsd,
          evalScore: e.evalScore,
          status: e.status,
          completedAt: e.completedAt,
        })
      : [];

    if (e.latencyMs !== undefined) {
      const buf = PercentileBuffer.from(ring.latency);
      buf.push(e.latencyMs);
      ring.latency = buf.toJSON();
    }
    if (e.costUsd !== undefined) {
      const buf = PercentileBuffer.from(ring.cost);
      buf.push(e.costUsd);
      ring.cost = buf.toJSON();
    }
    if (e.evalScore !== undefined) {
      const buf = PercentileBuffer.from(ring.evalScores);
      buf.push(e.evalScore);
      ring.evalScores = buf.toJSON();
    }
    ring.counts[e.status] = (ring.counts[e.status] ?? 0) + 1;
    ring.total += 1;

    // Decimated reference ring: 1 in REF_SAMPLE_EVERY events feed the
    // persisted baseline so a short burst of spike runs cannot become
    // the baseline before the 2-of-3 confirmation can fire.
    if (ring.total % REF_SAMPLE_EVERY === 0) {
      if (e.latencyMs !== undefined) {
        const buf = PercentileBuffer.from(ring.refLatency);
        buf.push(e.latencyMs);
        ring.refLatency = buf.toJSON();
      }
      if (e.costUsd !== undefined) {
        const buf = PercentileBuffer.from(ring.refCost);
        buf.push(e.costUsd);
        ring.refCost = buf.toJSON();
      }
      if (e.evalScore !== undefined) {
        const buf = PercentileBuffer.from(ring.refEval);
        buf.push(e.evalScore);
        ring.refEval = buf.toJSON();
      }
      ring.refTotal += 1;
    }

    if (ring.refTotal % BASELINE_WRITE_EVERY === 0) {
      const refLat = PercentileBuffer.from(ring.refLatency);
      const refCost = PercentileBuffer.from(ring.refCost);
      const refEval = PercentileBuffer.from(ring.refEval);
      const baselineStats = {
        p50LatencyMs: refLat.quantile(0.5),
        p95LatencyMs: refLat.quantile(0.95),
        p99LatencyMs: refLat.quantile(0.99),
        p50CostUsd: refCost.quantile(0.5),
        p95CostUsd: refCost.quantile(0.95),
        p50EvalScore: refEval.quantile(0.5),
        p95EvalScore: refEval.quantile(0.95),
      };
      await this.env.DB.prepare(
        `INSERT INTO baselines
         (org_id, feature_id, model, period, sample_count, p50_latency_ms, p95_latency_ms, p99_latency_ms,
          p50_cost_usd, p95_cost_usd, p50_eval_score, p95_eval_score, refusal_rate, error_rate, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, feature_id, model, period) DO UPDATE SET
          sample_count = excluded.sample_count,
          p50_latency_ms = excluded.p50_latency_ms,
          p95_latency_ms = excluded.p95_latency_ms,
          p99_latency_ms = excluded.p99_latency_ms,
          p50_cost_usd = excluded.p50_cost_usd,
          p95_cost_usd = excluded.p95_cost_usd,
          p50_eval_score = excluded.p50_eval_score,
          p95_eval_score = excluded.p95_eval_score,
          refusal_rate = excluded.refusal_rate,
          error_rate = excluded.error_rate,
          updated_at = excluded.updated_at`,
      )
        .bind(
          e.orgId,
          e.featureId,
          e.model,
          period,
          ring.refTotal,
          baselineStats.p50LatencyMs ?? null,
          baselineStats.p95LatencyMs ?? null,
          baselineStats.p99LatencyMs ?? null,
          baselineStats.p50CostUsd ?? null,
          baselineStats.p95CostUsd ?? null,
          baselineStats.p50EvalScore ?? null,
          baselineStats.p95EvalScore ?? null,
          liveStats.refusalRate ?? null,
          liveStats.errorRate ?? null,
          e.completedAt,
        )
        .run();
    }

    for (const v of verdicts) {
      const ringVerdicts = (ring.verdicts[v.type] ??= []);
      ringVerdicts.push(true);
      if (ringVerdicts.length > 3) ringVerdicts.shift();
      if (!isConfirmed(ringVerdicts)) continue;

      const now = Date.now();
      const last = ring.lastAlertAt[v.type] ?? 0;
      if (now - last < SUPPRESSION_MS) continue;
      ring.lastAlertAt[v.type] = now;

      const alertId = id("alrt");
      const openedAt = new Date().toISOString();
      await this.env.DB.prepare(
        `INSERT INTO alerts (id, org_id, feature_id, model, type, severity, message, status, run_id, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).bind(
        alertId,
        e.orgId,
        e.featureId,
        e.model,
        v.type,
        v.severity,
        v.message,
        e.runId ?? null,
        openedAt,
      ).run();

      const channels = await loadAlertChannels(this.env, e.orgId, await this.channelIdsForFeature(e.featureId));
      if (channels.length > 0) {
        const msg: AlertDispatchMessage = {
          alertId,
          orgId: e.orgId,
          featureId: e.featureId,
          model: e.model,
          type: v.type,
          severity: v.severity,
          message: v.message,
          runId: e.runId,
          openedAt,
          status: "open",
          channels,
        };
        await this.env.ALERTS_QUEUE.send(msg);
      }
    }

    // Record non-triggering verdicts so the confirmation ring decays correctly,
    // and auto-resolve open alerts after 3 consecutive clean runs per type.
    const ALERT_TYPES = ["latency", "score_drop", "refusal_spike", "cost_spike", "error_rate"] as const;
    for (const t of ALERT_TYPES) {
      const ringVerdicts = (ring.verdicts[t] ??= []);
      ringVerdicts.push(verdicts.some((v) => v.type === t) ? true : false);
      if (ringVerdicts.length > 3) ringVerdicts.shift();
      if (ringVerdicts.length >= 3 && ringVerdicts.slice(-3).every((v) => v === false)) {
        await this.env.DB.prepare(
          `UPDATE alerts SET status = 'resolved', resolved_at = ?
           WHERE org_id = ? AND feature_id = ? AND model = ? AND type = ? AND status = 'open'
             AND opened_at < ?`,
        )
          .bind(
            new Date().toISOString(),
            e.orgId,
            e.featureId,
            e.model,
            t,
            new Date(Date.now() - 5 * 60_000).toISOString(),
          )
          .run();
      }
    }

    rings.set(modelKey, ring);
    await this.ctx.storage.put(`ring|${modelKey}`, ring);
  }

  private async channelIdsForFeature(featureId: string): Promise<string[]> {
    const row = await this.env.DB.prepare("SELECT alert_channel_ids FROM checks WHERE feature_id = ? LIMIT 1")
      .bind(featureId)
      .first<{ alert_channel_ids: string | null }>();
    if (!row?.alert_channel_ids) return [];
    try {
      const v = JSON.parse(row.alert_channel_ids) as unknown;
      return Array.isArray(v) ? (v as string[]) : [];
    } catch {
      return [];
    }
  }
}

/**
 * OrgRateLimiter — token-bucket burst control for inbound telemetry.
 * One DO per org. Soft daily caps live in KV in the ingest worker.
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
