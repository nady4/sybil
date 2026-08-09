import {
  apiKeySchema,
  alertChannelSchema,
  createCheckSchema,
  encryptSecret,
  id,
  providerKeySchema,
  sha256Hex,
  verifySvixSignature,
  type Alert,
  type AlertChannel,
  type Check,
  type Org,
} from "@agentsre/shared";
import { authenticate, authenticateWeb, error, json, type Env } from "./auth.js";
import { handleBillingApi } from "./billing.js";
import { handleFeatureCosts } from "./admin.js";

interface CheckRow {
  id: string;
  org_id: string;
  feature_id: string;
  name: string;
  description: string | null;
  prompt: string;
  system: string | null;
  target: string | null;
  allowed_domains: string | null;
  success_criteria: string;
  interval_minutes: number;
  regions: string | null;
  provider: string;
  model: string;
  max_steps: number;
  max_output_tokens: number;
  redaction_rules: string | null;
  alert_channel_ids: string | null;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null): T[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : undefined;
  } catch {
    return undefined;
  }
}

function mapCheck(row: CheckRow): Check {
  return {
    id: row.id,
    orgId: row.org_id,
    featureId: row.feature_id,
    name: row.name,
    description: row.description ?? undefined,
    prompt: row.prompt,
    system: row.system ?? undefined,
    target: row.target ?? undefined,
    allowedDomains: parseJson<string>(row.allowed_domains),
    successCriteria: parseJson(row.success_criteria) ?? [],
    intervalMinutes: row.interval_minutes,
    regions: parseJson<string>(row.regions),
    provider: row.provider as Check["provider"],
    model: row.model,
    maxSteps: row.max_steps,
    maxOutputTokens: row.max_output_tokens,
    redactionRules: parseJson<string>(row.redaction_rules),
    alertChannelIds: parseJson<string>(row.alert_channel_ids) ?? [],
    // Headers are write-only: ciphertext stays in the DB, never returned.
    headers: undefined,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listChecks(env: Env, orgId: string, featureId?: string): Promise<Check[]> {
  const sql = featureId
    ? "SELECT * FROM checks WHERE org_id = ? AND feature_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM checks WHERE org_id = ? ORDER BY created_at DESC";
  const stmt = featureId ? env.DB.prepare(sql).bind(orgId, featureId) : env.DB.prepare(sql).bind(orgId);
  const res = await stmt.all<CheckRow>();
  return res.results.map(mapCheck);
}

export async function handleApi(req: Request, env: Env, url: URL, path: string): Promise<Response> {
  const auth = (await authenticate(req, env)) ?? (await authenticateWeb(req, env));
  if (!auth) return error("unauthorized", 401, env);
  const { orgId, org } = auth;

  switch (path) {
    case "/v1/org":
      if (req.method === "GET") return json(org, 200, env);
      if (req.method === "PUT") {
        const { name } = (await req.json()) as { name?: string };
        if (!name || name.length > 100) return error("name required", 400, env);
        await env.DB.prepare("UPDATE orgs SET name = ? WHERE id = ?").bind(name, orgId).run();
        return json({ ...org, name }, 200, env);
      }
      break;

    case "/v1/summary": {
      if (req.method !== "GET") break;
      const day = new Date().toISOString().slice(0, 10);
      const [openAlerts, runsToday, success, cost] = (await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE org_id = ? AND status = 'open'").bind(orgId),
        env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE org_id = ? AND started_at >= ?").bind(orgId, day),
        env.DB.prepare(
          "SELECT status, COUNT(*) AS n FROM runs WHERE org_id = ? AND started_at >= ? GROUP BY status",
        ).bind(orgId, day),
        env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE org_id = ? AND started_at >= ?").bind(orgId, day),
      ])) as [D1Result, D1Result, D1Result, D1Result];
      const open = (openAlerts.results[0] as { n: number } | undefined)?.n ?? 0;
      const total = (runsToday.results[0] as { n: number } | undefined)?.n ?? 0;
      const byStatus = (success.results as Array<{ status: string; n: number }>).reduce<Record<string, number>>(
        (acc, r) => ((acc[r.status] = r.n), acc),
        {},
      );
      const totalCost = (cost.results[0] as { total: number } | undefined)?.total ?? 0;
      return json({
        openAlerts: open,
        runsToday: total,
        successRate: total ? (byStatus.success ?? 0) / total : null,
        byStatus,
        costTodayUsd: totalCost,
        limits: org.limits,
        plan: org.plan,
      }, 200, env);
    }

    case "/v1/checks":
      if (req.method === "GET") {
        const featureId = url.searchParams.get("featureId") ?? undefined;
        return json({ checks: await listChecks(env, orgId, featureId) }, 200, env);
      }
      if (req.method === "POST") {
        const parsed = createCheckSchema.safeParse(await req.json());
        if (!parsed.success) return error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400, env);
        const existing = await listChecks(env, orgId);
        if (existing.length >= org.limits.maxChecks) {
          return error(`plan ${org.plan} allows at most ${org.limits.maxChecks} checks`, 403, env);
        }
        const v = parsed.data;
        const checkId = id("chk");
        const now = new Date().toISOString();
        const headersCipher = v.headers ? await encryptSecret(JSON.stringify(v.headers), env.KEYS_ENC_KEY) : null;
        await env.DB.prepare(
          `INSERT INTO checks
           (id, org_id, feature_id, name, description, prompt, system, target, allowed_domains,
            success_criteria, interval_minutes, regions, provider, model, max_steps, max_output_tokens,
            redaction_rules, alert_channel_ids, target_headers, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(
          checkId,
          orgId,
          v.featureId,
          v.name,
          v.description ?? null,
          v.prompt,
          v.system ?? null,
          v.target ?? null,
          v.allowedDomains ? JSON.stringify(v.allowedDomains) : null,
          JSON.stringify(v.successCriteria),
          v.intervalMinutes,
          v.regions ? JSON.stringify(v.regions) : null,
          v.provider,
          v.model,
          v.maxSteps,
          v.maxOutputTokens,
          v.redactionRules ? JSON.stringify(v.redactionRules) : null,
          v.alertChannelIds ? JSON.stringify(v.alertChannelIds) : null,
          headersCipher,
          now,
          now,
        ).run();
        const [created] = await listChecks(env, orgId);
        const check = created ? created : await listChecks(env, orgId).then((c) => c.find((c) => c.id === checkId));
        return json({ check }, 201, env);
      }
      break;

    case "/v1/runs": {
      if (req.method !== "GET") break;
      const featureId = url.searchParams.get("featureId");
      const source = url.searchParams.get("source");
      const status = url.searchParams.get("status");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
      const where = ["org_id = ?"];
      const args: string[] = [orgId];
      if (featureId) { where.push("feature_id = ?"); args.push(featureId); }
      if (source) { where.push("source = ?"); args.push(source); }
      if (status) { where.push("status = ?"); args.push(status); }
      const res = await env.DB.prepare(
        `SELECT id, feature_id, tenant_id, source, agent_id, model, input_tokens, output_tokens, cost_usd,
                latency_ms, status, error_type, eval_score, guardrail_tripped, started_at, completed_at
         FROM runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`,
      )
        .bind(...args, limit)
        .all();
      return json({ runs: res.results }, 200, env);
    }

    case "/v1/alerts": {
      if (req.method !== "GET") break;
      const status = url.searchParams.get("status");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
      const sql = status
        ? "SELECT * FROM alerts WHERE org_id = ? AND status = ? ORDER BY opened_at DESC LIMIT ?"
        : "SELECT * FROM alerts WHERE org_id = ? ORDER BY opened_at DESC LIMIT ?";
      const stmt = status ? env.DB.prepare(sql).bind(orgId, status, limit) : env.DB.prepare(sql).bind(orgId, limit);
      const res = await stmt.all<Alert>();
      return json({ alerts: res.results }, 200, env);
    }

    case "/v1/baselines": {
      if (req.method !== "GET") break;
      const featureId = url.searchParams.get("featureId");
      const sql = featureId
        ? "SELECT * FROM baselines WHERE org_id = ? AND feature_id = ? ORDER BY updated_at DESC"
        : "SELECT * FROM baselines WHERE org_id = ? ORDER BY updated_at DESC";
      const res = featureId
        ? await env.DB.prepare(sql).bind(orgId, featureId).all()
        : await env.DB.prepare(sql).bind(orgId).all();
      return json({ baselines: res.results }, 200, env);
    }

    case "/v1/features/costs":
      return handleFeatureCosts(req, env, url, orgId);

    case "/v1/billing/checkout":
    case "/v1/billing/portal":
    case "/v1/billing":
      return handleBillingApi(req, env, auth, path);

    case "/v1/api-keys":
      if (req.method === "GET") {
        const res = await env.DB.prepare(
          "SELECT id, name, key_prefix, created_at, revoked_at FROM api_keys WHERE org_id = ?",
        ).bind(orgId).all();
        return json({ apiKeys: res.results }, 200, env);
      }
      if (req.method === "POST") {
        const parsed = apiKeySchema.safeParse(await req.json());
        if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "invalid", 400, env);
        const raw = `ars_${crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
        const keyId = id("key");
        await env.DB.prepare(
          "INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)",
        ).bind(keyId, orgId, parsed.data.name, await sha256Hex(raw), raw.slice(0, 12)).run();
        return json({ apiKey: { id: keyId, name: parsed.data.name, key: raw } }, 201, env);
      }
      break;

    case "/v1/provider-keys":
      if (req.method === "GET") {
        const res = await env.DB.prepare(
          "SELECT provider, label, created_at, updated_at FROM provider_keys WHERE org_id = ?",
        ).bind(orgId).all();
        return json({ providerKeys: res.results }, 200, env);
      }
      if (req.method === "PUT") {
        const parsed = providerKeySchema.safeParse(await req.json());
        if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "invalid", 400, env);
        const cipher = await encryptSecret(parsed.data.key, env.KEYS_ENC_KEY);
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO provider_keys (org_id, provider, label, key_ciphertext, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id, provider) DO UPDATE SET label = excluded.label, key_ciphertext = excluded.key_ciphertext, updated_at = excluded.updated_at`,
        ).bind(orgId, parsed.data.provider, parsed.data.label ?? null, cipher, now, now).run();
        return json({ ok: true }, 200, env);
      }
      break;

    case "/v1/alert-channels":
      if (req.method === "GET") {
        const res = await env.DB.prepare(
          "SELECT id, org_id, name, type, config, enabled, created_at FROM alert_channels WHERE org_id = ? ORDER BY created_at DESC",
        ).bind(orgId).all<Omit<AlertChannel, "config"> & { config: string }>();
        return json({ channels: res.results.map((r) => ({ ...r, config: JSON.parse(r.config) })) }, 200, env);
      }
      if (req.method === "POST") {
        const parsed = alertChannelSchema.safeParse(await req.json());
        if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "invalid", 400, env);
        const channelId = id("chan");
        await env.DB.prepare(
          "INSERT INTO alert_channels (id, org_id, name, type, config) VALUES (?, ?, ?, ?, ?)",
        ).bind(channelId, orgId, parsed.data.name, parsed.data.type, JSON.stringify(parsed.data.config)).run();
        return json({ channel: { id: channelId, orgId, ...parsed.data, enabled: true } }, 201, env);
      }
      break;
  }

  // /v1/checks/:id, /v1/runs/:id, /v1/alerts/:id/ack|resolve, /v1/alert-channels/:id
  const parts = path.split("/").filter(Boolean).slice(1);
  if (parts.length === 3 || parts.length === 2) {
    const [scope, sub, action] = parts as [string, string, string | undefined];

    if (scope === "checks") {
      if (req.method === "GET") {
        const res = await env.DB.prepare("SELECT * FROM checks WHERE org_id = ? AND id = ?").bind(orgId, sub).first<CheckRow>();
        if (!res) return error("not found", 404, env);
        return json({ check: mapCheck(res) }, 200, env);
      }
      if (req.method === "PATCH") {
        const patch = (await req.json()) as Partial<Check>;
        const existing = await env.DB.prepare("SELECT * FROM checks WHERE org_id = ? AND id = ?").bind(orgId, sub).first<CheckRow>();
        if (!existing) return error("not found", 404, env);
        const next = { ...mapCheck(existing), ...patch };
        const sets: string[] = [];
        const args: (string | number | null)[] = [];
        const fields: Array<[string, unknown]> = [
          ["name", next.name],
          ["description", next.description],
          ["prompt", next.prompt],
          ["system", next.system],
          ["target", next.target],
          ["enabled", next.enabled ? 1 : 0],
          ["interval_minutes", next.intervalMinutes],
          ["max_steps", next.maxSteps],
          ["max_output_tokens", next.maxOutputTokens],
          ["provider", next.provider],
          ["model", next.model],
        ];
        for (const [col, val] of fields) {
          if (patch[col as keyof Check] !== undefined || col === "enabled") {
            sets.push(`${col} = ?`);
            args.push(val as string | number | null);
          }
        }
        if (patch.allowedDomains !== undefined) { sets.push("allowed_domains = ?"); args.push(JSON.stringify(next.allowedDomains)); }
        if (patch.successCriteria !== undefined) { sets.push("success_criteria = ?"); args.push(JSON.stringify(next.successCriteria)); }
        if (patch.regions !== undefined) { sets.push("regions = ?"); args.push(JSON.stringify(next.regions)); }
        if (patch.redactionRules !== undefined) { sets.push("redaction_rules = ?"); args.push(JSON.stringify(next.redactionRules)); }
        if (patch.alertChannelIds !== undefined) { sets.push("alert_channel_ids = ?"); args.push(JSON.stringify(next.alertChannelIds)); }
        if (patch.headers !== undefined) {
          sets.push("target_headers = ?");
          args.push(patch.headers ? await encryptSecret(JSON.stringify(patch.headers), env.KEYS_ENC_KEY) : null);
        }
        sets.push("updated_at = ?");
        args.push(new Date().toISOString());
        await env.DB.prepare(`UPDATE checks SET ${sets.join(", ")} WHERE org_id = ? AND id = ?`).bind(...args, orgId, sub).run();
        const res = await env.DB.prepare("SELECT * FROM checks WHERE org_id = ? AND id = ?").bind(orgId, sub).first<CheckRow>();
        return json({ check: res ? mapCheck(res) : undefined }, 200, env);
      }
      if (req.method === "DELETE") {
        await env.DB.prepare("DELETE FROM checks WHERE org_id = ? AND id = ?").bind(orgId, sub).run();
        return json({ ok: true }, 200, env);
      }
    }

    if (scope === "runs" && req.method === "GET") {
      const res = await env.DB.prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = r.id) AS tool_call_count
         FROM runs r WHERE r.org_id = ? AND r.id = ?`,
      ).bind(orgId, sub).first();
      if (!res) return error("not found", 404, env);
      return json({ run: res }, 200, env);
    }

    if (scope === "features" && action === "correlation" && req.method === "GET") {
      const featureId = sub;
      const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      const q15 = new Date(Date.now() - 15 * 60_000).toISOString();

      const [checksRes, baselinesRes, alertsRes, synthRes, prodRes, corrRes] = (await env.DB.batch([
        env.DB.prepare("SELECT * FROM checks WHERE org_id = ? AND feature_id = ?").bind(orgId, featureId),
        env.DB.prepare(
          "SELECT * FROM baselines WHERE org_id = ? AND feature_id = ? ORDER BY updated_at DESC",
        ).bind(orgId, featureId),
        env.DB.prepare(
          "SELECT id, type, severity, status, message, opened_at FROM alerts WHERE org_id = ? AND feature_id = ? AND status != 'resolved' ORDER BY opened_at DESC LIMIT 10",
        ).bind(orgId, featureId),
        env.DB.prepare(
          "SELECT status, eval_score, latency_ms, cost_usd, started_at FROM runs WHERE org_id = ? AND feature_id = ? AND source = 'synthetic' AND started_at >= ?",
        ).bind(orgId, featureId, dayAgo),
        env.DB.prepare(
          "SELECT status, latency_ms, cost_usd, started_at FROM runs WHERE org_id = ? AND feature_id = ? AND source = 'production' AND started_at >= ?",
        ).bind(orgId, featureId, dayAgo),
        env.DB.prepare(
          `SELECT source, status, COUNT(*) AS n FROM runs
           WHERE org_id = ? AND feature_id = ? AND started_at >= ?
           GROUP BY source, status`,
        ).bind(orgId, featureId, q15),
      ])) as [D1Result, D1Result, D1Result, D1Result, D1Result, D1Result];

      type Row = { status: string; eval_score?: number; latency_ms?: number; cost_usd?: number };
      const synth = synthRes.results as Row[];
      const prod = prodRes.results as Row[];
      const pcts = (xs: number[]) => {
        if (xs.length === 0) return {};
        const s = [...xs].sort((a, b) => a - b);
        const q = (p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
        return { p50LatencyMs: q(0.5), p95LatencyMs: q(0.95) };
      };
      const prodLat = pcts(prod.filter((r) => r.latency_ms !== undefined).map((r) => r.latency_ms!));

      const corrBySource = (corrRes.results as Array<{ source: string; status: string; n: number }>).reduce<
        Record<string, { total: number; failed: number }>
      >((acc, r) => {
        const e = (acc[r.source] ??= { total: 0, failed: 0 });
        e.total += r.n;
        if (r.status !== "success") e.failed += r.n;
        return acc;
      }, {});

      const summarize = (rows: Row[]) => ({
        runs24h: rows.length,
        passRate: rows.length ? rows.filter((r) => r.status === "success").length / rows.length : undefined,
        avgEval: rows.some((r) => r.eval_score !== undefined)
          ? rows.filter((r) => r.eval_score !== undefined).reduce((n, r) => n + r.eval_score!, 0) / rows.filter((r) => r.eval_score !== undefined).length
          : undefined,
        cost24hUsd: rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
      });

      return json({
        featureId,
        checks: checksRes.results,
        baselines: baselinesRes.results,
        recentAlerts: alertsRes.results,
        synthetic: summarize(synth),
        production: {
          ...summarize(prod),
          ...prodLat,
          errorRate: prod.length ? prod.filter((r) => r.status === "error" || r.status === "failed").length / prod.length : undefined,
          refusalRate: prod.length ? prod.filter((r) => r.status === "refused").length / prod.length : undefined,
        },
        correlation: {
          last15m: {
            syntheticRuns: corrBySource.synthetic?.total ?? 0,
            syntheticFailures: corrBySource.synthetic?.failed ?? 0,
            productionRuns: corrBySource.production?.total ?? 0,
            productionErrors: corrBySource.production?.failed ?? 0,
          },
        },
      }, 200, env);
    }

    if (scope === "runs" && action === "raw" && req.method === "GET") {
      // Archived raw steps: read from R2 when D1's steps_json was truncated.
      const row = await env.DB.prepare(
        "SELECT id, org_id, started_at, steps_json FROM runs WHERE org_id = ? AND id = ?",
      ).bind(orgId, sub).first<{ id: string; org_id: string; started_at: string; steps_json: string | null }>();
      if (!row) return error("not found", 404, env);
      if (row.steps_json) return json({ runId: row.id, archived: false, steps: JSON.parse(row.steps_json) }, 200, env);
      if (!env.RUNS_BUCKET) return error("archive not configured", 503, env);
      const month = row.started_at.slice(0, 7);
      const obj = await env.RUNS_BUCKET.get(`runs/${row.org_id}/${month}/${row.id}.json`);
      if (!obj) return error("archived steps not found", 404, env);
      return json({ runId: row.id, archived: true, steps: JSON.parse(await obj.text()) }, 200, env);
    }

    if (scope === "alerts" && !action && req.method === "GET") {
      const res = await env.DB.prepare("SELECT * FROM alerts WHERE org_id = ? AND id = ?").bind(orgId, sub).first<Alert>();
      if (!res) return error("not found", 404, env);
      return json({ alert: res }, 200, env);
    }

    if (scope === "alerts" && (action === "ack" || action === "resolve") && req.method === "POST") {
      if (action === "resolve") {
        await env.DB.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE org_id = ? AND id = ?")
          .bind(new Date().toISOString(), orgId, sub)
          .run();
      } else {
        await env.DB.prepare("UPDATE alerts SET status = 'acknowledged' WHERE org_id = ? AND id = ?")
          .bind(orgId, sub)
          .run();
      }
      return json({ ok: true }, 200, env);
    }

    if (scope === "alert-channels" && req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM alert_channels WHERE org_id = ? AND id = ?").bind(orgId, sub).run();
      return json({ ok: true }, 200, env);
    }
  }

  return error("not found", 404, env);
}

export async function handleSetup(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/v1/setup" || req.method !== "POST") return error("not found", 404, env);
  const token = req.headers.get("x-bootstrap-token");
  if (!token || token !== env.BOOTSTRAP_KEY) return error("forbidden", 403, env);
  const body = (await req.json()) as { orgName?: string; keyName?: string; plan?: Org["plan"] };
  const orgId = id("org");
  const plan = body.plan ?? "hobby";
  if (!(plan in { hobby: 1, indie: 1, team: 1, enterprise: 1 })) return error("invalid plan", 400, env);
  await env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, ?, ?)").bind(orgId, body.orgName ?? "My Org", plan).run();
  const raw = `ars_${crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
  const keyId = id("key");
  await env.DB.prepare("INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
    .bind(keyId, orgId, body.keyName ?? "default", await sha256Hex(raw), raw.slice(0, 12))
    .run();
  return json({ orgId, plan, apiKey: raw }, 201, env);
}

/**
 * Clerk webhooks (Svix-signed). Provisions orgs and user->org mappings
 * so web sessions can authenticate via Clerk JWT later.
 * Handled events: organization.created, organizationMembership.created/deleted.
 */
export async function handleClerkWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405, env);
  if (!env.CLERK_WEBHOOK_SECRET) return error("clerk not configured", 503, env);
  const payload = await req.text();
  const valid = await verifySvixSignature(
    payload,
    {
      "svix-id": req.headers.get("svix-id"),
      "svix-timestamp": req.headers.get("svix-timestamp"),
      "svix-signature": req.headers.get("svix-signature"),
    },
    env.CLERK_WEBHOOK_SECRET,
  );
  if (!valid) return error("invalid signature", 401, env);

  let body: { type?: string; data?: Record<string, unknown> };
  try {
    body = JSON.parse(payload) as { type?: string; data?: Record<string, unknown> };
  } catch {
    return error("invalid payload", 400, env);
  }
  const data = body.data ?? {};

  switch (body.type) {
    case "organization.created": {
      const orgId = String(data.id ?? "");
      if (!orgId) return error("missing org id", 400, env);
      const name = String(data.name ?? "My Org").slice(0, 100);
      await env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, ?, 'hobby') ON CONFLICT(id) DO NOTHING")
        .bind(orgId, name)
        .run();
      return json({ ok: true }, 200, env);
    }
    case "organizationMembership.created": {
      const orgId = String(((data.organization as Record<string, unknown> | undefined)?.id as string | undefined) ?? "");
      const pdu = data.public_user_data as Record<string, unknown> | undefined;
      const userId = String((pdu?.user_id as string | undefined) ?? "");
      if (!orgId || !userId) return error("missing membership ids", 400, env);
      await env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, 'My Org', 'hobby') ON CONFLICT(id) DO NOTHING")
        .bind(orgId)
        .run();
      await env.DB.prepare("INSERT INTO clerk_users (user_id, org_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
        .bind(userId, orgId)
        .run();
      return json({ ok: true }, 200, env);
    }
    case "organizationMembership.deleted": {
      const orgId = String(((data.organization as Record<string, unknown> | undefined)?.id as string | undefined) ?? "");
      const pdu = data.public_user_data as Record<string, unknown> | undefined;
      const userId = String((pdu?.user_id as string | undefined) ?? "");
      if (!orgId || !userId) return error("missing membership ids", 400, env);
      await env.DB.prepare("DELETE FROM clerk_users WHERE user_id = ? AND org_id = ?").bind(userId, orgId).run();
      return json({ ok: true }, 200, env);
    }
    default:
      return json({ ok: true, ignored: true }, 200, env);
  }
}
