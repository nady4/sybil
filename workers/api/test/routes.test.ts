import { env, applyD1Migrations, SELF } from "cloudflare:test";
import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Org } from "@agentsre/shared";
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

const ORIGIN = "http://example.com";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Raw-body variant for webhook tests (signatures cover the exact bytes). */
async function rawApi(method: string, path: string, raw: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { method, headers, body: raw });
}

function svix(payload: string, secret: string, ts = String(Math.floor(Date.now() / 1000))): { id: string; ts: string; sig: string } {
  const id = `msg_${Math.random().toString(36).slice(2, 8)}`;
  const sig = createHmac("sha256", secret).update(`${id}.${ts}.${payload}`).digest("hex");
  return { id, ts, sig };
}

function stripeSig(payload: string, secret: string, ts = String(Math.floor(Date.now() / 1000))): string {
  const sig = createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

describe("API routes", () => {
  beforeAll(() => applyD1Migrations(env.DB, MIGRATIONS, "d1_migrations"), 30_000);

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs"),
      env.DB.prepare("DELETE FROM baselines"),
      env.DB.prepare("DELETE FROM alerts"),
      env.DB.prepare("DELETE FROM api_keys"),
      env.DB.prepare("DELETE FROM checks"),
      env.DB.prepare("DELETE FROM orgs"),
      env.DB.prepare("DELETE FROM clerk_users"),
      env.DB.prepare("DELETE FROM baselines"),
    ]);
  }, 30_000);

  it("rejects unauthenticated requests", async () => {
    expect((await api("GET", "/v1/checks")).status).toBe(401);
  });

  it("rejects a forged bootstrap token on setup", async () => {
    const res = await api("POST", "/v1/setup", { orgName: "X" }, { "x-bootstrap-token": "wrong" });
    expect(res.status).toBe(403);
  });

  it("bootstraps an org + API key", async () => {
    const res = await api("POST", "/v1/setup", { orgName: "Acme", plan: "indie" }, { "x-bootstrap-token": "dev-bootstrap" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { orgId: string; plan: string; apiKey: string };
    expect(body.apiKey).toMatch(/^ars_/);
    const org = await env.DB.prepare("SELECT id, plan FROM orgs WHERE id = ?").bind(body.orgId).first<{ id: string; plan: string }>();
    expect(org?.plan).toBe("indie");
  });

  it("creates checks and enforces plan limits", async () => {
    const setup = (await api("POST", "/v1/setup", { orgName: "HobbyCo" }, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as { apiKey: string };
    const auth = { authorization: `Bearer ${setup.apiKey}` };
    const check = { featureId: "f", name: "c", prompt: "p", successCriteria: [{ name: "x", assertion: { type: "exact", expected: "y", field: "final" } }] };

    const created = await api("POST", "/v1/checks", check, auth);
    expect(created.status).toBe(201);

    // hobby plan allows 3 checks: two more pass, the 4th is rejected.
    for (let i = 0; i < 2; i++) {
      expect((await api("POST", "/v1/checks", { ...check, name: `c${i}` }, auth)).status).toBe(201);
    }
    const fourth = await api("POST", "/v1/checks", { ...check, name: "c4" }, auth);
    expect(fourth.status).toBe(403);

    // PATCH toggle works
    const list = (await api("GET", "/v1/checks", undefined, auth).then((r) => r.json())) as { checks: Array<{ id: string }> };
    const patched = await api("PATCH", `/v1/checks/${list.checks[0]!.id}`, { enabled: false }, auth);
    expect(patched.status).toBe(200);
    const detail = (await api("GET", `/v1/checks/${list.checks[0]!.id}`, undefined, auth).then((r) => r.json())) as {
      check: { enabled: boolean };
    };
    expect(detail.check.enabled).toBe(false);
  });

  it("rejects invalid check payloads with 400", async () => {
    const setup = (await api("POST", "/v1/setup", {}, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as { apiKey: string };
    const res = await api("POST", "/v1/checks", { featureId: "", name: "" }, { authorization: `Bearer ${setup.apiKey}` });
    expect(res.status).toBe(400);
  });

  it("returns the correlation view for a feature", async () => {
    const setup = (await api("POST", "/v1/setup", {}, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as {
      apiKey: string;
      orgId: string;
    };
    const auth = { authorization: `Bearer ${setup.apiKey}` };
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO runs (id, org_id, feature_id, source, status, cost_usd, latency_ms, eval_score, started_at, completed_at)
       VALUES ('r1', ?, 'checkout', 'synthetic', 'success', 0.001, 800, 0.9, ?, ?)`,
    )
      .bind(setup.orgId, now, now)
      .run();
    const res = await api("GET", "/v1/features/checkout/correlation", undefined, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synthetic: { runs24h: number } };
    expect(body.synthetic.runs24h).toBe(1);
  });

  it("provisions orgs from signed Clerk webhooks and rejects forged ones", async () => {
    const payload = JSON.stringify({ type: "organization.created", data: { id: "org_clerk1", name: "Web Org" } });
    const { id, ts, sig } = svix(payload, "whsec_devsecret0123456789");
    const ok = await rawApi("POST", "/v1/auth/clerk-webhook", payload, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
    });
    expect(ok.status).toBe(200);
    const org = await env.DB.prepare("SELECT id, name FROM orgs WHERE id = 'org_clerk1'").first<{ id: string; name: string }>();
    expect(org?.name).toBe("Web Org");

    const forged = await rawApi("POST", "/v1/auth/clerk-webhook", payload, {
      "svix-id": "x",
      "svix-timestamp": ts,
      "svix-signature": "v1,deadbeef",
    });
    expect(forged.status).toBe(401);
  });

  it("upgrades plans from signed Stripe webhooks and rejects forged ones", async () => {
    const setup = (await api("POST", "/v1/setup", {}, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as {
      orgId: string;
    };
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { customer: "cus_1", subscription: "sub_1", metadata: { orgId: setup.orgId, plan: "team" } } },
    });
    const sig = stripeSig(payload, "whsec_stripe_mock_0123456789");
    const res = await rawApi("POST", "/v1/billing/webhook", payload, { "stripe-signature": sig });
    expect(res.status).toBe(200);
    const org = await env.DB.prepare("SELECT plan FROM orgs WHERE id = ?").bind(setup.orgId).first<{ plan: Org["plan"] }>();
    expect(org?.plan).toBe("team");

    const forged = await rawApi("POST", "/v1/billing/webhook", payload, { "stripe-signature": "t=1754726400,v1=deadbeef" });
    expect(forged.status).toBe(401);
  });

  it("exposes baselines for features without a synthetic check", async () => {
    const setup = (await api("POST", "/v1/setup", {}, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as {
      apiKey: string;
      orgId: string;
    };
    await env.DB.prepare(
      "INSERT INTO baselines (org_id, feature_id, model, period, sample_count, p95_latency_ms, updated_at) VALUES (?, 'prod-only', 'gpt-4o-mini', 'afternoon', 25, 800, ?)",
    )
      .bind(setup.orgId, new Date().toISOString())
      .run();
    const res = await api("GET", "/v1/baselines?featureId=prod-only", undefined, { authorization: `Bearer ${setup.apiKey}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baselines: Array<{ feature_id: string; sample_count: number }> };
    expect(body.baselines).toHaveLength(1);
    expect(body.baselines[0]!.sample_count).toBe(25);
  });

  it("requires the admin token for /internal/admin endpoints", async () => {
    expect((await api("GET", "/internal/admin/health")).status).toBe(403);
    expect((await api("GET", "/internal/admin/health", undefined, { "x-admin-token": "wrong" })).status).toBe(403);
    const ok = await api("GET", "/internal/admin/health", undefined, { "x-admin-token": "test-admin" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { orgs: number; failedDeliveries: number };
    expect(typeof body.orgs).toBe("number");
  });

  it("reports cost by feature", async () => {
    const setup = (await api("POST", "/v1/setup", {}, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as {
      apiKey: string;
      orgId: string;
    };
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO runs (id, org_id, feature_id, source, status, cost_usd, input_tokens, output_tokens, started_at, completed_at)
         VALUES ('c1', ?, 'checkout', 'synthetic', 'success', 0.001, 100, 50, ?, ?)`,
      ).bind(setup.orgId, now, now),
      env.DB.prepare(
        `INSERT INTO runs (id, org_id, feature_id, source, status, cost_usd, input_tokens, output_tokens, started_at, completed_at)
         VALUES ('c2', ?, 'checkout', 'production', 'success', 0.002, 200, 100, ?, ?)`,
      ).bind(setup.orgId, now, now),
      env.DB.prepare(
        `INSERT INTO runs (id, org_id, feature_id, source, status, cost_usd, input_tokens, output_tokens, started_at, completed_at)
         VALUES ('c3', ?, 'support', 'production', 'success', 0.0005, 50, 20, ?, ?)`,
      ).bind(setup.orgId, now, now),
    ]);
    const res = await api("GET", "/v1/features/costs?days=7", undefined, { authorization: `Bearer ${setup.apiKey}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: Array<{ feature_id: string; cost_usd: number; runs: number }> };
    const checkout = body.features.filter((f) => f.feature_id === "checkout");
    expect(checkout.reduce((n, f) => n + f.cost_usd, 0)).toBeCloseTo(0.003, 6);
  });

  it("acknowledges and resolves alerts", async () => {
    const setup = (await api("POST", "/v1/setup", {}, { "x-bootstrap-token": "dev-bootstrap" }).then((r) => r.json())) as {
      orgId: string;
      apiKey: string;
    };
    await env.DB.prepare(
      "INSERT INTO alerts (id, org_id, feature_id, type, severity, message, status, opened_at) VALUES ('alrt_1', ?, 'f', 'latency', 'warning', 'slow', 'open', ?)",
    )
      .bind(setup.orgId, new Date().toISOString())
      .run();
    const auth = { authorization: `Bearer ${setup.apiKey}` };
    expect((await api("POST", "/v1/alerts/alrt_1/ack", {}, auth)).status).toBe(200);
    const acked = (await api("GET", "/v1/alerts/alrt_1", undefined, auth).then((r) => r.json())) as { alert: { status: string } };
    expect(acked.alert.status).toBe("acknowledged");
    expect((await api("POST", "/v1/alerts/alrt_1/resolve", {}, auth)).status).toBe(200);
    const resolved = (await api("GET", "/v1/alerts/alrt_1", undefined, auth).then((r) => r.json())) as { alert: { status: string } };
    expect(resolved.alert.status).toBe("resolved");
  });
});
