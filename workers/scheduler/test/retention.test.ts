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

const ORG_ID = "org_ret";
const STEPS = JSON.stringify([{ index: 0, model: "gpt-4o-mini", latencyMs: 700, usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [{ name: "search", input: { q: "x" }, output: "hit" }] }]);

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600_000).toISOString();
}

async function seedRun(id: string, daysOld: number, steps: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, org_id, feature_id, source, status, steps_json, started_at, completed_at)
     VALUES (?, ?, 'f', 'production', 'success', ?, ?, ?)`,
  )
    .bind(id, ORG_ID, steps, daysAgo(daysOld), daysAgo(daysOld))
    .run();
}

async function runRetention(instanceId: string): Promise<void> {
  await env.RETENTION_WORKFLOW.create({ id: instanceId, params: { tick: "manual" } });
  await using introspector = await introspectWorkflowInstance(env.RETENTION_WORKFLOW, instanceId);
  await introspector.waitForStatus("complete");
}

describe("RetentionWorkflow", () => {
  beforeAll(() => applyD1Migrations(env.DB, MIGRATIONS, "d1_migrations"), 30_000);

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs"),
      env.DB.prepare("DELETE FROM orgs"),
      env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, 'Ret', 'team')").bind(ORG_ID),
    ]);
  }, 30_000);

  it("archives old steps to R2 and truncates D1", async () => {
    await seedRun("run_old", 40, STEPS);
    await runRetention("rt-1");

    const run = await env.DB.prepare("SELECT steps_json FROM runs WHERE id = 'run_old'").first<{ steps_json: string | null }>();
    expect(run?.steps_json).toBeNull();

    const month = daysAgo(40).slice(0, 7);
    const obj = await env.RUNS_BUCKET.get(`runs/${ORG_ID}/${month}/run_old.json`);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toContain("search");
  }, 120_000);

  it("keeps fresh steps in D1", async () => {
    await seedRun("run_fresh", 2, STEPS);
    await runRetention("rt-2");
    const run = await env.DB.prepare("SELECT steps_json FROM runs WHERE id = 'run_fresh'").first<{ steps_json: string | null }>();
    expect(run?.steps_json).toBe(STEPS);
  }, 120_000);

  it("purges runs older than the purge window", async () => {
    await seedRun("run_ancient", 100, null);
    await runRetention("rt-3");
    const run = await env.DB.prepare("SELECT id FROM runs WHERE id = 'run_ancient'").first<{ id: string }>();
    expect(run).toBeNull();
  }, 120_000);
});
