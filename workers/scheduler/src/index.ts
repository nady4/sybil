import { stableHash } from "@agentsre/shared";
import type { Env } from "./env.js";
import { FeatureCoordinator } from "./coordinator.js";
import type { RunEvent } from "./types.js";

const SAMPLER_CRON = "*/15 * * * *";
const USAGE_CRON = "0 3 * * *";
const RETENTION_CRON = "0 4 * * *";
const MONITOR_CRON = "*/5 * * * *";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/internal/coordinator" && req.method === "POST") {
      const event = (await req.json()) as RunEvent;
      const doId = env.FEATURE_COORDINATOR.idFromName(await stableHash(`${event.orgId}:${event.featureId}`));
      const stub = env.FEATURE_COORDINATOR.get(doId);
      return stub.fetch("https://do/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    }

    if (url.pathname === "/internal/tick" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const instance = await env.SCHEDULER.create({
        id: `manual-${crypto.randomUUID()}`,
        params: { tick: "manual" },
      });
      return Response.json({ ok: true, id: instance.id });
    }

    if (url.pathname === "/internal/tick-sampler" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const instance = await env.SAMPLER.create({
        id: `sampler-${crypto.randomUUID()}`,
        params: { tick: "manual" },
      });
      return Response.json({ ok: true, id: instance.id });
    }

    if (url.pathname === "/internal/tick-usage" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const instance = await env.USAGE_REPORTER.create({
        id: `usage-${crypto.randomUUID()}`,
        params: { tick: "manual" },
      });
      return Response.json({ ok: true, id: instance.id });
    }

    if (url.pathname === "/internal/tick-retention" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const instance = await env.RETENTION_WORKFLOW.create({
        id: `retention-${crypto.randomUUID()}`,
        params: { tick: "manual" },
      });
      return Response.json({ ok: true, id: instance.id });
    }

    if (url.pathname === "/internal/tick-monitor" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const instance = await env.MONITOR_WORKFLOW.create({
        id: `monitor-${crypto.randomUUID()}`,
        params: { tick: "manual" },
      });
      return Response.json({ ok: true, id: instance.id });
    }

    if (url.pathname === "/internal/run-check" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const { checkId } = (await req.json()) as { checkId?: string };
      if (!checkId) return Response.json({ error: "checkId required" }, { status: 400 });
      const instance = await env.SCHEDULER.create({
        id: `run-check-${crypto.randomUUID()}`,
        params: { checkId },
      });
      return Response.json({ ok: true, id: instance.id });
    }

    if (url.pathname === "/internal/sample-rate" && req.method === "POST") {
      const token = req.headers.get("x-admin-token");
      if (token !== env.ADMIN_TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
      const { orgId, rate } = (await req.json()) as { orgId?: string; rate?: number };
      if (!orgId || typeof rate !== "number" || rate < 0 || rate > 1) {
        return Response.json({ error: "orgId and 0<=rate<=1 required" }, { status: 400 });
      }
      await env.JUDGE_CACHE.put(`sample_rate:${orgId}`, String(rate));
      return Response.json({ ok: true, orgId, rate });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === SAMPLER_CRON) {
      await env.SAMPLER.create({ id: `sampler-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, params: { tick: event.cron } });
      return;
    }
    if (event.cron === USAGE_CRON) {
      await env.USAGE_REPORTER.create({ id: `usage-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, params: { tick: event.cron } });
      return;
    }
    if (event.cron === RETENTION_CRON) {
      await env.RETENTION_WORKFLOW.create({ id: `retention-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, params: { tick: event.cron } });
      return;
    }
    if (event.cron === MONITOR_CRON) {
      await env.MONITOR_WORKFLOW.create({ id: `monitor-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, params: { tick: event.cron } });
      return;
    }
    const id = `cron-${event.cron}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await env.SCHEDULER.create({ id, params: { tick: event.cron } });
  },
} satisfies ExportedHandler<Env>;

export { FeatureCoordinator, OrgRateLimiter } from "./coordinator.js";
export { SchedulerWorkflow } from "./workflow.js";
export { SamplerWorkflow } from "./sampler.js";
export { UsageReporterWorkflow } from "./usage.js";
export { RetentionWorkflow } from "./retention.js";
export { MonitorWorkflow } from "./monitor.js";
