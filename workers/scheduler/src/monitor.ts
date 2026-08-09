import { id, type AlertChannel, type AlertDispatchMessage } from "@agentsre/shared";
import type { Env } from "./env.js";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * MonitorWorkflow — the product watches itself.
 *
 * Every 5 minutes it checks platform signals and raises an operator
 * alert (alert row + queue dispatch) when any is unhealthy. Suppressed
 * per signal for 30 minutes.
 *
 * Signals (all D1/KV-computable — the Workflow binding has no list API):
 *  - DLQ depth: new failed_deliveries rows since the last check
 *  - Retention backlog: runs with steps_json older than the raw window
 *  - Judge budget exhaustion: orgs at their daily judge cap
 *  - Daily caps hit: orgs at their plan's maxRunsPerDay
 *  - Error spike: >50 error runs in the last 5 minutes
 *
 * Operator dispatch: env.OPERATOR_CHANNEL = JSON {type, config} (Slack
 * webhook etc.) reuses the alerts worker's retryable delivery.
 */

const SUPPRESSION_TTL_SEC = 30 * 60;
const ERROR_SPIKE = 50;
const RETENTION_BACKLOG_DAYS = 35;

interface Signal {
  name: string;
  severity: "warning" | "critical";
  message: string;
}

export class MonitorWorkflow extends WorkflowEntrypoint<Env, { tick?: string }> {
  async run(event: WorkflowEvent<{ tick?: string }>, step: WorkflowStep) {
    const signals = await step.do(
      "collect platform signals",
      { timeout: "2 minutes" },
      async () => this.collectSignals(),
    );
    const raised = await step.do(
      "raise operator alerts",
      { timeout: "2 minutes" },
      async () => this.raiseAlerts(signals),
    );
    return { signals: signals.length, raised };
  }

  private async collectSignals(): Promise<Signal[]> {
    const signals: Signal[] = [];

    // 1. DLQ depth since last check.
    const lastDlq = Number((await this.env.JUDGE_CACHE.get("monitor:last:dlq").catch(() => null)) ?? "0");
    const dlqRows = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM failed_deliveries WHERE created_at > ?",
    )
      .bind(new Date(lastDlq).toISOString())
      .first<{ n: number }>();
    if ((dlqRows?.n ?? 0) > 0) {
      signals.push({
        name: "dlq",
        severity: "critical",
        message: `${dlqRows!.n} retry-exhausted deliveries since last check — inspect /internal/admin/failed-deliveries`,
      });
    }
    await this.env.JUDGE_CACHE.put("monitor:last:dlq", String(Date.now()));

    // 2. Retention backlog: steps_json older than the raw window.
    const backlog = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE steps_json IS NOT NULL AND started_at < ?",
    )
      .bind(new Date(Date.now() - RETENTION_BACKLOG_DAYS * 24 * 3600_000).toISOString())
      .first<{ n: number }>();
    if ((backlog?.n ?? 0) > 0) {
      signals.push({
        name: "retention",
        severity: "warning",
        message: `${backlog!.n} runs past the raw-retention window still in D1 — RetentionWorkflow not keeping up`,
      });
    }

    // 3. Judge budget exhaustion: orgs at cap today.
    const today = new Date().toISOString().slice(0, 10);
    const orgs = await this.env.DB.prepare("SELECT id, plan FROM orgs").all<{ id: string; plan: string }>();
    const capLimits: Record<string, number> = { hobby: 0.5, indie: 1, team: 3, enterprise: 10 };
    let atCap = 0;
    for (const org of orgs.results) {
      const spent = Number(
        (await this.env.JUDGE_CACHE.get(`judge:budget:${org.id}:${today}`).catch(() => null)) ?? "0",
      );
      if (spent >= (capLimits[org.plan] ?? 1)) atCap++;
    }
    if (atCap > 0) {
      signals.push({
        name: "judge_budget",
        severity: "warning",
        message: `${atCap} org(s) hit their daily judge budget — sampled scoring is skipping them`,
      });
    }

    // 4. Org daily caps hit.
    const dayStart = new Date().toISOString().slice(0, 10);
    const caps = await this.env.DB.prepare(
      `SELECT o.id, o.plan, COUNT(r.id) AS n FROM orgs o
       LEFT JOIN runs r ON r.org_id = o.id AND r.started_at >= ?
       GROUP BY o.id`,
    )
      .bind(dayStart)
      .all<{ id: string; plan: string; n: number }>();
    const planCaps: Record<string, number> = { hobby: 300, indie: 2500, team: 10000, enterprise: 100000 };
    const atDailyCap = caps.results.filter((o) => o.n >= (planCaps[o.plan] ?? 300)).length;
    if (atDailyCap > 0) {
      signals.push({
        name: "daily_caps",
        severity: "warning",
        message: `${atDailyCap} org(s) at their daily run cap — ingest returning 429 for them`,
      });
    }

    // 5. Error spike in the last 5 minutes.
    const spike = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE status IN ('error', 'failed') AND started_at >= ?",
    )
      .bind(new Date(Date.now() - 5 * 60_000).toISOString())
      .first<{ n: number }>();
    if ((spike?.n ?? 0) > ERROR_SPIKE) {
      signals.push({
        name: "error_spike",
        severity: "critical",
        message: `${spike!.n} error/failed runs in the last 5 minutes — provider or platform problem`,
      });
    }

    return signals;
  }

  private async raiseAlerts(signals: Signal[]): Promise<number> {
    let raised = 0;
    for (const s of signals) {
      const suppressKey = `monitor:alert:${s.name}`;
      if (await this.env.JUDGE_CACHE.get(suppressKey).catch(() => null)) continue;
      await this.env.JUDGE_CACHE.put(suppressKey, "1", { expirationTtl: SUPPRESSION_TTL_SEC });

      const orgId = this.env.OPERATOR_ORG ?? "platform";
      const alertId = id("alrt");
      const openedAt = new Date().toISOString();
      await this.env.DB.prepare(
        `INSERT INTO alerts (id, org_id, feature_id, model, type, severity, message, status, opened_at)
         VALUES (?, ?, 'platform', NULL, 'platform', ?, ?, 'open', ?)`,
      )
        .bind(alertId, orgId, s.severity, s.message, openedAt)
        .run();
      raised++;

      const channel = this.operatorChannel();
      if (channel) {
        const msg: AlertDispatchMessage = {
          alertId,
          orgId,
          featureId: "platform",
          type: "platform",
          severity: s.severity,
          message: s.message,
          openedAt,
          status: "open",
          channels: [channel],
        };
        await this.env.ALERTS_QUEUE.send(msg);
      }
    }
    return raised;
  }

  private operatorChannel(): AlertChannel | undefined {
    const raw = this.env.OPERATOR_CHANNEL;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { type?: AlertChannel["type"]; config?: Record<string, string> };
      if (!parsed.type || !parsed.config) return undefined;
      return {
        id: "operator",
        orgId: "platform",
        name: "operator",
        type: parsed.type,
        config: parsed.config,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
    } catch {
      return undefined;
    }
  }
}
