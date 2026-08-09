import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@agentsre/shared";
import sql0001 from "../migrations/0001_identity.sql?raw";
import sql0002 from "../migrations/0002_telemetry.sql?raw";
import sql0003 from "../migrations/0003_billing.sql?raw";
import sql0004 from "../migrations/0004_org_scoping.sql?raw";
import sql0005 from "../migrations/0005_platform_alerts.sql?raw";
import sql0006 from "../migrations/0006_target_headers.sql?raw";

const MIGRATIONS = [
  { name: "0001_identity.sql", queries: splitSql(sql0001) },
  { name: "0002_telemetry.sql", queries: splitSql(sql0002) },
  { name: "0003_billing.sql", queries: splitSql(sql0003) },
  { name: "0004_org_scoping.sql", queries: splitSql(sql0004) },
  { name: "0005_platform_alerts.sql", queries: splitSql(sql0005) },
  { name: "0006_target_headers.sql", queries: splitSql(sql0006) },
];

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

async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, MIGRATIONS);
}

const AFTERNOON = "2026-08-09T14:00:00.000Z";

// Each test gets a unique feature id so it maps to a fresh DO instance
// (DO storage is not reset between tests within a file).
let featureCounter = 0;
let currentFeature = "checkout";

function nextFeature(): string {
  featureCounter++;
  currentFeature = `checkout_${featureCounter}`;
  return currentFeature;
}

function run(partial: Partial<RunEvent>): RunEvent {
  return {
    runId: `run_${Math.random().toString(36).slice(2, 10)}`,
    orgId: "org_test",
    featureId: currentFeature,
    model: "gpt-4o-mini",
    latencyMs: 800,
    costUsd: 0.0001,
    evalScore: 0.9,
    status: "success",
    completedAt: AFTERNOON,
    ...partial,
  };
}

async function send(e: RunEvent): Promise<void> {
  const id = env.FEATURE_COORDINATOR.idFromName(currentFeature);
  const stub = env.FEATURE_COORDINATOR.get(id);
  const res = await stub.fetch("https://do/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(e),
  });
  expect(res.status).toBe(200);
}

async function countAlerts(where = ""): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM alerts${where ? ` WHERE ${where}` : ""}`;
  const res = await env.DB.prepare(sql).first<{ n: number }>();
  return res?.n ?? 0;
}

async function openLatencyAlerts(): Promise<Array<{ id: string; message: string }>> {
  const res = await env.DB.prepare(
    "SELECT id, message FROM alerts WHERE type = 'latency' AND status = 'open' ORDER BY opened_at",
  ).all<{ id: string; message: string }>();
  return res.results;
}

describe("FeatureCoordinator", () => {
  beforeAll(applyMigrations, 30_000);

  beforeEach(async () => {
    nextFeature();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs"),
      env.DB.prepare("DELETE FROM baselines"),
      env.DB.prepare("DELETE FROM alerts"),
      env.DB.prepare("DELETE FROM orgs"),
      env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES ('org_test', 'Test', 'team')"),
    ]);
  }, 30_000);

  it("arms a decimated baseline after 60 normal runs", async () => {
    for (let i = 0; i < 60; i++) {
      await send(run({ latencyMs: 800 }));
    }
    const base = await env.DB.prepare(
      "SELECT sample_count, p95_latency_ms, p99_latency_ms FROM baselines WHERE feature_id = ? AND model = 'gpt-4o-mini' AND period = 'afternoon'",
    ).bind(currentFeature).first<{ sample_count: number; p95_latency_ms: number; p99_latency_ms: number }>();
    expect(base).toBeDefined();
    expect(base!.sample_count).toBe(20); // 60 events / 3 decimation
    expect(base!.p95_latency_ms).toBeCloseTo(800, 0);
    expect(base!.p99_latency_ms).toBeCloseTo(800, 0);
  });

  it("fires exactly one latency alert after a 2-run spike (2-of-3 + suppression)", async () => {
    for (let i = 0; i < 60; i++) await send(run({ latencyMs: 800 }));
    await send(run({ latencyMs: 20000 }));
    await send(run({ latencyMs: 20000 }));
    const alerts = await openLatencyAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain("exceeds baseline p99");
    // A third spike within the suppression window must not create a second alert.
    await send(run({ latencyMs: 20000 }));
    expect(await openLatencyAlerts()).toHaveLength(1);
  });

  it("does not alert below the absolute floor", async () => {
    for (let i = 0; i < 60; i++) await send(run({ latencyMs: 800 }));
    await send(run({ latencyMs: 1500 })); // below 2000ms floor
    expect(await countAlerts()).toBe(0);
  });

  it("does not alert before the baseline arms", async () => {
    await send(run({ latencyMs: 99999 }));
    await send(run({ latencyMs: 99999 }));
    expect(await countAlerts()).toBe(0);
  });

  it("auto-resolves an alert after 3 consecutive clean runs", async () => {
    for (let i = 0; i < 60; i++) await send(run({ latencyMs: 800 }));
    await send(run({ latencyMs: 20000 }));
    await send(run({ latencyMs: 20000 }));
    expect(await openLatencyAlerts()).toHaveLength(1);

    // Age the alert past the auto-resolve grace period.
    await env.DB.prepare("UPDATE alerts SET opened_at = ? WHERE status = 'open'")
      .bind(new Date(Date.now() - 10 * 60_000).toISOString())
      .run();

    for (let i = 0; i < 3; i++) await send(run({ latencyMs: 800 }));
    const res = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alerts WHERE status = 'resolved'",
    ).first<{ n: number }>();
    expect(res?.n).toBe(1);
  });

  it("does not compare a spike run against a baseline it polluted", async () => {
    // Regression check: the persisted baseline (from the decimated reference
    // ring) stays clean after spikes, so a fresh spike still fires.
    for (let i = 0; i < 60; i++) await send(run({ latencyMs: 800 }));
    await send(run({ latencyMs: 20000 })); // spike 1: verdict
    await send(run({ latencyMs: 20000 })); // spike 2: verdict -> confirmed
    const alerts = await openLatencyAlerts();
    expect(alerts).toHaveLength(1);
    // The reference baseline must NOT have been rewritten by the spikes.
    const base = await env.DB.prepare(
      "SELECT p99_latency_ms FROM baselines WHERE feature_id = ? AND period = 'afternoon'",
    ).bind(currentFeature).first<{ p99_latency_ms: number }>();
    expect(base!.p99_latency_ms).toBeCloseTo(800, 0);
  });

  it("scores refusal as a verdict against a zero-refusal baseline", async () => {
    for (let i = 0; i < 60; i++) await send(run({ status: "success" }));
    await send(run({ status: "refused" }));
    await send(run({ status: "refused" }));
    const res = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alerts WHERE type = 'refusal_spike' AND status = 'open'",
    ).first<{ n: number }>();
    expect(res?.n).toBe(1);
  });
});
