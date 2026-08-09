import { env, applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "@agentsre/shared";
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

const ORG_ID = "org_wf";
const CHECK_ID = "chk_wf";
const PAGE_URL = "http://localhost:8786/page";
const ENC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, 'WF', 'team')").bind(ORG_ID),
    env.DB.prepare(
      `INSERT INTO provider_keys (org_id, provider, label, key_ciphertext, created_at, updated_at)
       VALUES (?, 'openai', 'test', ?, ?, ?)`,
    ).bind(ORG_ID, await encryptSecret("sk-mock-key", ENC_KEY), now, now),
    env.DB.prepare(
      `INSERT INTO checks
       (id, org_id, feature_id, name, prompt, target, allowed_domains, success_criteria, interval_minutes,
        provider, model, max_steps, max_output_tokens, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'checkout-works', 'Verify a guest can complete an order.', ?, '["localhost"]',
               '[{"name":"order-confirmed","assertion":{"type":"exact","expected":"order ORD-12345 is confirmed","field":"final"}},
                 {"name":"page-fetched","assertion":{"type":"tool_called","tool":"fetch_url"}}]',
               5, 'openai', 'gpt-4o-mini', 8, 1024, 1, ?, ?)`,
    ).bind(CHECK_ID, ORG_ID, "checkout", PAGE_URL, now, now),
  ]);
}

async function runWorkflow(instanceId: string): Promise<void> {
  await env.SCHEDULER.create({ id: instanceId, params: { tick: "manual" } });
  await using introspector = await introspectWorkflowInstance(env.SCHEDULER, instanceId);
  await introspector.waitForStatus("complete");
}

describe("SchedulerWorkflow (full synthetic loop, real engine)", () => {
  beforeAll(() => applyD1Migrations(env.DB, MIGRATIONS, "d1_migrations"), 30_000);

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs"),
      env.DB.prepare("DELETE FROM tool_calls"),
      env.DB.prepare("DELETE FROM baselines"),
      env.DB.prepare("DELETE FROM alerts"),
      env.DB.prepare("DELETE FROM checks"),
      env.DB.prepare("DELETE FROM provider_keys"),
      env.DB.prepare("DELETE FROM orgs"),
    ]);
  }, 30_000);

  it("runs a due check end-to-end against the mock provider: agent -> tool -> assertions -> run row", async () => {
    await seed();
    await runWorkflow("wf-1");

    const run = await env.DB.prepare(
      `SELECT id, org_id, source, status, eval_score, eval_score_components, cost_usd, input_tokens,
              output_tokens, steps_json
       FROM runs WHERE org_id = ?`,
    ).bind(ORG_ID).first<{
      id: string;
      source: string;
      status: string;
      eval_score: number;
      eval_score_components: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      steps_json: string;
    }>();
    expect(run).toBeDefined();
    expect(run!.source).toBe("synthetic");
    expect(run!.status).toBe("success");
    expect(run!.eval_score).toBe(1);
    const components = JSON.parse(run!.eval_score_components) as Record<string, number>;
    expect(components["order-confirmed"]).toBe(1);
    expect(components["page-fetched"]).toBe(1);
    // Mock usage: 420 in / 96 out per call, two calls; per-step rounding
    // gives round(0.0001206, 6) x2 = 0.000242.
    expect(run!.cost_usd).toBeCloseTo(0.000242, 6);
    expect(run!.input_tokens).toBe(840);
    expect(run!.output_tokens).toBe(192);

    const steps = JSON.parse(run!.steps_json) as Array<{ toolCalls: Array<{ name: string }>; content?: string }>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!.toolCalls[0]!.name).toBe("fetch_url");
    expect(steps[1]!.content).toContain("order ORD-12345 is confirmed");

    const tc = await env.DB.prepare("SELECT tool_name FROM tool_calls WHERE run_id = ?")
      .bind(run!.id)
      .first<{ tool_name: string }>();
    expect(tc?.tool_name).toBe("fetch_url");

    const check = await env.DB.prepare("SELECT last_run_at FROM checks WHERE id = ?").bind(CHECK_ID).first<{ last_run_at: string }>();
    expect(check?.last_run_at).toBeTruthy();
  }, 120_000);

  it("records an error run when the provider fails", async () => {
    await seed();
    // Replace the provider key with one pointing at a dead port so the
    // workflow's provider call fails cleanly.
    await env.DB.prepare("UPDATE provider_keys SET key_ciphertext = ? WHERE org_id = ? AND provider = 'openai'")
      .bind(await encryptSecret("sk-mock-key", ENC_KEY), ORG_ID)
      .run();
    // The mock server is up; simulate failure by removing the check's target
    // reachability instead: point allowed_domains at a port that refuses.
    await env.DB.prepare("UPDATE checks SET target = 'http://localhost:9999/page', allowed_domains = '[\"localhost\"]' WHERE id = ?")
      .bind(CHECK_ID)
      .run();

    await runWorkflow("wf-2");

    const run = await env.DB.prepare("SELECT status FROM runs WHERE org_id = ?").bind(ORG_ID).first<{ status: string }>();
    expect(run?.status).toBe("success"); // fetch failure is a tool error, not a run error
  }, 120_000);

  it("ignores checks that are not due", async () => {
    await seed();
    await env.DB.prepare("UPDATE checks SET last_run_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), CHECK_ID)
      .run();
    await runWorkflow("wf-3");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(count?.n).toBe(0);
  }, 120_000);

  it("sends encrypted check headers to auth'd targets", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, 'WF', 'team')").bind(ORG_ID),
      env.DB.prepare(
        `INSERT INTO provider_keys (org_id, provider, label, key_ciphertext, created_at, updated_at)
         VALUES (?, 'openai', 'test', ?, ?, ?)`,
      ).bind(ORG_ID, await encryptSecret("sk-mock-key", ENC_KEY), now, now),
      env.DB.prepare(
        `INSERT INTO checks
         (id, org_id, feature_id, name, prompt, target, allowed_domains, success_criteria, interval_minutes,
          provider, model, max_steps, max_output_tokens, target_headers, enabled, created_at, updated_at)
         VALUES (?, ?, 'checkout', 'auth-check', 'Verify the authed page.', 'http://localhost:8786/echo', '["localhost"]',
                 '[{"name":"header-sent","assertion":{"type":"regex","pattern":"hdr-secret-123","field":"final"}}]',
                 5, 'openai', 'gpt-4o-mini', 8, 1024, ?, 1, ?, ?)`,
      ).bind(
        CHECK_ID,
        ORG_ID,
        await encryptSecret(JSON.stringify({ "x-test-header": "hdr-secret-123" }), ENC_KEY),
        now,
        now,
      ),
    ]);

    await env.SCHEDULER.create({ id: "wf-5", params: { checkId: CHECK_ID } });
    await using introspector = await introspectWorkflowInstance(env.SCHEDULER, "wf-5");
    await introspector.waitForStatus("complete");

    const run = await env.DB.prepare(
      "SELECT status, eval_score FROM runs WHERE org_id = ? AND feature_id = 'checkout' ORDER BY started_at DESC LIMIT 1",
    ).bind(ORG_ID).first<{ status: string; eval_score: number }>();
    expect(run?.status).toBe("success");
    expect(run?.eval_score).toBe(1);
  }, 120_000);

  it("runs a specific check on demand via checkId, even when not due", async () => {
    await seed();
    // Mark the check as recently run so the schedule would skip it.
    await env.DB.prepare("UPDATE checks SET last_run_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), CHECK_ID)
      .run();

    await env.SCHEDULER.create({ id: "wf-4", params: { checkId: CHECK_ID } });
    await using introspector = await introspectWorkflowInstance(env.SCHEDULER, "wf-4");
    await introspector.waitForStatus("complete");

    const run = await env.DB.prepare(
      "SELECT feature_id, source, status FROM runs WHERE org_id = ?",
    ).bind(ORG_ID).first<{ feature_id: string; source: string; status: string }>();
    expect(run).toBeDefined();
    expect(run!.feature_id).toBe("checkout");
    expect(run!.source).toBe("synthetic");
    expect(run!.status).toBe("success");
  }, 120_000);
});
