import { env, applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import sql0001 from "../migrations/0001_identity.sql?raw";
import sql0002 from "../migrations/0002_telemetry.sql?raw";
import sql0003 from "../migrations/0003_billing.sql?raw";
import sql0004 from "../migrations/0004_org_scoping.sql?raw";
import sql0005 from "../migrations/0005_platform_alerts.sql?raw";
import sql0006 from "../migrations/0006_target_headers.sql?raw";

function splitSql(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MIGRATIONS = [
  { name: "0001_identity.sql", queries: splitSql(sql0001) },
  { name: "0002_telemetry.sql", queries: splitSql(sql0002) },
  { name: "0003_billing.sql", queries: splitSql(sql0003) },
  { name: "0004_org_scoping.sql", queries: splitSql(sql0004) },
  { name: "0005_platform_alerts.sql", queries: splitSql(sql0005) },
  { name: "0006_target_headers.sql", queries: splitSql(sql0006) },
];

async function runMonitor(instanceId: string): Promise<unknown> {
  await env.MONITOR_WORKFLOW.create({ id: instanceId, params: { tick: "manual" } });
  await using introspector = await introspectWorkflowInstance(env.MONITOR_WORKFLOW, instanceId);
  await introspector.waitForStatus("complete");
  return introspector.getOutput();
}

describe("MonitorWorkflow", () => {
  beforeAll(() => applyD1Migrations(env.DB, MIGRATIONS, "d1_migrations"), 30_000);

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs"),
      env.DB.prepare("DELETE FROM alerts"),
      env.DB.prepare("DELETE FROM failed_deliveries"),
      env.DB.prepare("DELETE FROM orgs"),
    ]);
  }, 30_000);

  it("raises a critical alert for new DLQ deliveries and suppresses repeats", async () => {
    await env.DB.prepare(
      "INSERT INTO failed_deliveries (id, queue, body) VALUES ('fd_1', 'agentsre-ingest', '{}')",
    ).run();

    await runMonitor("mon-1");
    const alerts = await env.DB.prepare(
      "SELECT type, severity, feature_id, message FROM alerts",
    ).all<{ type: string; severity: string; feature_id: string; message: string }>();
    expect(alerts.results).toHaveLength(1);
    expect(alerts.results[0]!.type).toBe("platform");
    expect(alerts.results[0]!.severity).toBe("critical");
    expect(alerts.results[0]!.feature_id).toBe("platform");
    expect(alerts.results[0]!.message).toContain("failed-deliveries");

    // Suppressed: a second run with the same signal must not re-alert.
    await runMonitor("mon-2");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first<{ n: number }>();
    expect(after?.n).toBe(1);
  }, 120_000);

  it("flags a retention backlog", async () => {
    await env.DB.prepare(
      `INSERT INTO runs (id, org_id, feature_id, source, status, steps_json, started_at, completed_at)
       VALUES ('r_old', 'org_x', 'f', 'production', 'success', '[]', ?, ?)`,
    )
      .bind(
        new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
        new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
      )
      .run();

    await runMonitor("mon-3");
    const alerts = await env.DB.prepare("SELECT message FROM alerts").all<{ message: string }>();
    expect(alerts.results.some((a) => a.message.includes("retention"))).toBe(true);
  }, 120_000);

  it("flags an error spike", async () => {
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < 60; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO runs (id, org_id, feature_id, source, status, started_at, completed_at)
           VALUES (?, 'org_x', 'f', 'production', 'error', ?, ?)`,
        ).bind(`r_err_${i}`, now, now),
      );
    }
    await env.DB.batch(stmts);

    await runMonitor("mon-4");
    const alerts = await env.DB.prepare("SELECT message FROM alerts").all<{ message: string }>();
    expect(alerts.results.some((a) => a.message.includes("error/failed runs"))).toBe(true);
  }, 120_000);

  it("stays quiet on a healthy platform", async () => {
    await runMonitor("mon-5");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first<{ n: number }>();
    expect(count?.n).toBe(0);
  }, 120_000);
});
