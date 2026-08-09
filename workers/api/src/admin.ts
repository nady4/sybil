import { error, json, type Env } from "./auth.js";

/**
 * Operator admin surface (x-admin-token = env.ADMIN_TOKEN, not an org key).
 * The "on-call is you" endpoints: platform health, org census, DLQ view.
 */

export async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  const token = req.headers.get("x-admin-token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return error("forbidden", 403, env);

  const day = new Date().toISOString().slice(0, 10);
  const dayStart = new Date().toISOString().slice(0, 10);

  switch (url.pathname) {
    case "/internal/admin/health": {
      if (req.method !== "GET") break;
      const [orgs, runsToday, openAlerts, dlq, backlog] = (await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM orgs"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?").bind(dayStart),
        env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM failed_deliveries"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE steps_json IS NOT NULL AND started_at < ?").bind(
          new Date(Date.now() - 35 * 24 * 3600_000).toISOString(),
        ),
      ])) as [D1Result, D1Result, D1Result, D1Result, D1Result];
      const n = (r: D1Result): number => (r.results[0] as { n?: number } | undefined)?.n ?? 0;
      return json(
        {
          ok: true,
          orgs: n(orgs),
          runsToday: n(runsToday),
          openAlerts: n(openAlerts),
          failedDeliveries: n(dlq),
          retentionBacklog: n(backlog),
        },
        200,
        env,
      );
    }

    case "/internal/admin/orgs": {
      if (req.method !== "GET") break;
      const res = await env.DB.prepare(
        `SELECT o.id, o.name, o.plan, o.stripe_subscription_id,
                (SELECT COUNT(*) FROM runs r WHERE r.org_id = o.id AND r.started_at >= ?) AS runs_today,
                (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r WHERE r.org_id = o.id AND r.started_at >= ?) AS cost_today,
                (SELECT COUNT(*) FROM checks c WHERE c.org_id = o.id) AS checks
         FROM orgs o ORDER BY o.created_at DESC`,
      )
        .bind(dayStart, dayStart)
        .all();
      return json({ orgs: res.results }, 200, env);
    }

    case "/internal/admin/failed-deliveries": {
      if (req.method !== "GET") break;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
      const res = await env.DB.prepare(
        "SELECT id, queue, substr(body, 1, 500) AS body, error, created_at FROM failed_deliveries ORDER BY created_at DESC LIMIT ?",
      )
        .bind(limit)
        .all();
      return json({ deliveries: res.results }, 200, env);
    }
  }
  return error("not found", 404, env);
}

export async function handleFeatureCosts(req: Request, env: Env, url: URL, orgId: string): Promise<Response> {
  if (req.method !== "GET") return error("method not allowed", 405, env);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "30"), 1), 90);
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT feature_id, source,
            COUNT(*) AS runs,
            COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM runs WHERE org_id = ? AND started_at >= ?
     GROUP BY feature_id, source ORDER BY cost_usd DESC`,
  )
    .bind(orgId, since)
    .all();
  return json({ days, features: res.results }, 200, env);
}
