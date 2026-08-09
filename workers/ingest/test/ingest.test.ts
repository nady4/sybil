import { env, applyD1Migrations, SELF, createMessageBatch, createExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeEnvelope, sha256Hex, stableHash, type Run } from "@agentsre/shared";
import worker from "../src/index.js";
import sql0001 from "../../scheduler/migrations/0001_identity.sql?raw";
import sql0002 from "../../scheduler/migrations/0002_telemetry.sql?raw";
import sql0003 from "../../scheduler/migrations/0003_billing.sql?raw";
import sql0004 from "../../scheduler/migrations/0004_org_scoping.sql?raw";
import sql0005 from "../../scheduler/migrations/0005_platform_alerts.sql?raw";
import sql0006 from "../../scheduler/migrations/0006_target_headers.sql?raw";

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

const ORG_ID = "org_ingest";
const ORG_HASH = (await stableHash(ORG_ID)).slice(0, 8);
const API_KEY = "ars_test_ingest_key_0001";

async function seedOrg(plan = "team", key = API_KEY, revoked = false): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, 'Ingest', ?)").bind(ORG_ID, plan),
    env.DB.prepare(
      "INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, revoked_at) VALUES ('key_1', ?, 'test', ?, ?, ?)",
    ).bind(ORG_ID, await sha256Hex(key), key.slice(0, 12), revoked ? new Date().toISOString() : null),
  ]);
}

function envelope(id: string, featureId = "checkout"): string {
  return JSON.stringify({
    trace: { id, featureId, startedAt: new Date().toISOString() },
    observations: [
      { model: "gpt-4o-mini", inputTokens: 100, outputTokens: 50, latencyMs: 700, status: "success", input: "hi", output: "hello" },
    ],
  });
}

async function postTraces(body: string, key = API_KEY): Promise<Response> {
  return SELF.fetch("http://example.com/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
  });
}

/** The pool does not auto-deliver queue messages; run the consumer manually. */
async function drainQueue(body: string): Promise<void> {
  const { runs } = normalizeEnvelope(JSON.parse(body));
  const batch = createMessageBatch<{ orgId: string; runs: Run[] }>("agentsre-ingest", [
    { body: { orgId: ORG_ID, runs }, timestamp: new Date(), attempts: 1 },
  ]);
  await worker.queue(batch, env);
}

async function countRuns(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = ?").bind(id).first<{ n: number }>();
  return row?.n ?? 0;
}

async function waitForRuns(id: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await countRuns(id)) >= expected) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("ingest worker", () => {
  beforeAll(() => applyD1Migrations(env.DB, MIGRATIONS, "d1_migrations"), 30_000);

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs"),
      env.DB.prepare("DELETE FROM tool_calls"),
      env.DB.prepare("DELETE FROM baselines"),
      env.DB.prepare("DELETE FROM alerts"),
      env.DB.prepare("DELETE FROM api_keys"),
      env.DB.prepare("DELETE FROM failed_deliveries"),
      env.DB.prepare("DELETE FROM orgs"),
    ]);
  }, 30_000);

  it("rejects unauthenticated and unknown-key requests", async () => {
    await seedOrg();
    expect((await postTraces(envelope("t1"), "")).status).toBe(401);
    expect((await postTraces(envelope("t1"), "ars_wrong_key_0000000000")).status).toBe(401);
  });

  it("rejects revoked keys", async () => {
    await seedOrg("team", API_KEY, true);
    expect((await postTraces(envelope("t1"))).status).toBe(401);
  });

  it("accepts an envelope and lands a unified production run", async () => {
    await seedOrg();
    const res = await postTraces(envelope("t1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(1);

    await drainQueue(envelope("t1"));
    await waitForRuns(`prod_${ORG_HASH}_t1`, 1);
    expect(await countRuns(`prod_${ORG_HASH}_t1`)).toBe(1);

    const run = await env.DB.prepare(
      "SELECT org_id, source, status, cost_usd, input_tokens, output_tokens FROM runs WHERE id = ?",
    ).bind(`prod_${ORG_HASH}_t1`).first<{ org_id: string; source: string; status: string; cost_usd: number; input_tokens: number; output_tokens: number }>();
    expect(run?.org_id).toBe(ORG_ID); // payload orgId is never trusted
    expect(run?.source).toBe("production");
    expect(run?.status).toBe("success");
    expect(run?.cost_usd).toBeCloseTo(0.000045, 6);
    expect(run?.input_tokens).toBe(100);
    expect(run?.output_tokens).toBe(50);
  }, 60_000);

  it("accepts OTLP payloads", async () => {
    await seedOrg();
    const otlp = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "otlp1",
                  startTimeUnixNano: "1754726400000000000",
                  endTimeUnixNano: "1754726400200000000",
                  attributes: { "gen_ai.response.model": "gpt-4o-mini", "gen_ai.usage.input_tokens": 300, "gen_ai.usage.output_tokens": 60 },
                },
              ],
            },
          ],
        },
      ],
    });
    const res = await SELF.fetch("http://example.com/v1/otlp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: otlp,
    });
    expect(res.status).toBe(200);
  });

  it("enforces the daily run cap", async () => {
    await seedOrg("hobby"); // 300 runs/day
    const day = new Date().toISOString().slice(0, 10);
    await env.DAILY_CAPS.put(`daily:${ORG_ID}:${day}`, "300");
    const res = await postTraces(envelope("t1"));
    expect(res.status).toBe(429);
  });

  it("is idempotent for duplicate trace ids", async () => {
    await seedOrg();
    expect((await postTraces(envelope("dup1"))).status).toBe(200);
    expect((await postTraces(envelope("dup1"))).status).toBe(200);
    await drainQueue(envelope("dup1"));
    await drainQueue(envelope("dup1"));
    await waitForRuns(`prod_${ORG_HASH}_dup1`, 1);
    expect(await countRuns(`prod_${ORG_HASH}_dup1`)).toBe(1);
  }, 60_000);

  it("routes retry-exhausted messages to failed_deliveries", async () => {
    await seedOrg();
    const batch = createMessageBatch<{ orgId: string; runs: Run[] }>("agentsre-ingest-dlq", [
      { body: { orgId: ORG_ID, runs: [] }, timestamp: new Date(), attempts: 1 },
    ]);
    await worker.queue(batch, env);
    const row = await env.DB.prepare("SELECT queue, body FROM failed_deliveries").first<{ queue: string; body: string }>();
    expect(row?.queue).toBe("agentsre-ingest");
    expect(row?.body).toContain(ORG_ID);
  });
});
