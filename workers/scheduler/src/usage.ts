import type { Env } from "./env.js";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * UsageReporterWorkflow — daily Stripe Billing Meter reporting.
 *
 * For every org with an active subscription, count yesterday's runs and
 * report them as a metered usage event (billing meter "agent_runs").
 * Runs on cron "0 3 * * *"; STRIPE_API_URL can point at a mock.
 */

const METER_EVENT = "agent_runs";

interface MeterEventPayload {
  event_name: string;
  identifier: string;
  payload: { value: string };
  timestamp: number;
}

export class UsageReporterWorkflow extends WorkflowEntrypoint<Env, { tick?: string }> {
  async run(event: WorkflowEvent<{ tick?: string }>, step: WorkflowStep) {
    const orgIds = await step.do("load billed orgs", async () => this.loadBilledOrgs());
    let reported = 0;
    for (const orgId of orgIds) {
      const n = await step.do(
        `report usage for ${orgId}`,
        { retries: { limit: 2, delay: "1 minute", backoff: "constant" }, timeout: "2 minutes" },
        async () => this.reportOrg(orgId),
      );
      if (n) reported++;
    }
    return { orgs: orgIds.length, reported };
  }

  private async loadBilledOrgs(): Promise<string[]> {
    if (!this.env.STRIPE_SECRET_KEY) return [];
    const res = await this.env.DB.prepare(
      "SELECT id FROM orgs WHERE stripe_subscription_id IS NOT NULL",
    ).all<{ id: string }>();
    return res.results.map((r) => r.id);
  }

  private async reportOrg(orgId: string): Promise<boolean> {
    if (!this.env.STRIPE_SECRET_KEY) return false;
    const org = await this.env.DB.prepare("SELECT stripe_customer_id, stripe_subscription_id FROM orgs WHERE id = ?")
      .bind(orgId)
      .first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
    if (!org?.stripe_customer_id) {
      console.log(`usage: org ${orgId} has no stripe customer`);
      return false;
    }

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    dayStart.setUTCDate(dayStart.getUTCDate() - 1);
    const periodStart = dayStart.toISOString();
    const periodEnd = new Date(dayStart.getTime() + 24 * 3600_000).toISOString();

    const countRes = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE org_id = ? AND started_at >= ? AND started_at < ?",
    ).bind(orgId, periodStart, periodEnd).first<{ n: number }>();
    const n = countRes?.n ?? 0;

    await this.env.DB.prepare(
      `INSERT INTO usage_periods (org_id, period_start, run_count) VALUES (?, ?, ?)
       ON CONFLICT(org_id, period_start) DO UPDATE SET run_count = excluded.run_count`,
    ).bind(orgId, periodStart, n).run();

    if (n === 0 || !this.env.STRIPE_API_URL) {
      console.log(`usage: org ${orgId} n=${n} apiUrl=${this.env.STRIPE_API_URL ?? "none"}`);
      return false;
    }
    const body: MeterEventPayload = {
      event_name: METER_EVENT,
      identifier: org.stripe_customer_id,
      payload: { value: String(n) },
      timestamp: dayStart.getTime() / 1000,
    };
    const res = await fetch(`${this.env.STRIPE_API_URL}/v1/billing/meter_events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`meter event ${res.status}`);
    await this.env.DB.prepare("UPDATE usage_periods SET reported = 1 WHERE org_id = ? AND period_start = ?")
      .bind(orgId, periodStart)
      .run();
    return true;
  }
}
