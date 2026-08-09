import { PLAN_LIMITS, sha256Hex, verifyClerkJwt, type ClerkJwtClaims, type Org } from "@agentsre/shared";

export interface Env {
  DB: D1Database;
  KEYS_ENC_KEY: string;
  /** Bootstrap token: create the first org + API key (POST /v1/setup). */
  BOOTSTRAP_KEY: string;
  /** Clerk webhook signing secret (Svix). */
  CLERK_WEBHOOK_SECRET?: string;
  /** Clerk JWKS endpoint, e.g. https://<instance>.clerk.accounts.dev/.well-known/jwks.json */
  CLERK_JWKS_URL?: string;
  JWKS_CACHE?: KVNamespace;
  /** Stripe billing (all optional — billing is disabled without the secret). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_URL?: string;
  STRIPE_PRICE_INDIE?: string;
  STRIPE_PRICE_TEAM?: string;
  STRIPE_PRICE_ENTERPRISE?: string;
  /** Raw run archive (R2), read by GET /v1/runs/{id}/raw. */
  RUNS_BUCKET?: R2Bucket;
  /** Restrict CORS to one origin (defaults to *). */
  CORS_ORIGIN?: string;
  /** Operator admin token (x-admin-token header on /internal/admin/*). */
  ADMIN_TOKEN?: string;
}

export interface AuthContext {
  orgId: string;
  org: Org;
  keyId: string;
}

export async function authenticate(req: Request, env: Env): Promise<AuthContext | undefined> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return undefined;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, k.org_id, k.revoked_at, o.name, o.plan, o.created_at,
            o.stripe_customer_id, o.stripe_subscription_id
     FROM api_keys k JOIN orgs o ON o.id = k.org_id
     WHERE k.key_hash = ?`,
  ).bind(hash).first<{
    key_id: string;
    org_id: string;
    revoked_at: string | null;
    name: string;
    plan: Org["plan"];
    created_at: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  }>();
  if (!row || row.revoked_at) return undefined;
  return {
    orgId: row.org_id,
    keyId: row.key_id,
    org: {
      id: row.org_id,
      name: row.name,
      plan: row.plan,
      limits: PLAN_LIMITS[row.plan],
      createdAt: row.created_at,
      stripeCustomerId: row.stripe_customer_id ?? undefined,
      stripeSubscriptionId: row.stripe_subscription_id ?? undefined,
    },
  };
}

/** Fetch + cache the Clerk JWKS (1h TTL). */
export async function fetchJwks(env: Env): Promise<{ keys: Array<{ kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }> }> {
  if (!env.CLERK_JWKS_URL) return { keys: [] };
  const cached = await env.JWKS_CACHE?.get("jwks");
  if (cached) return JSON.parse(cached) as { keys: Array<{ kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }> };
  const res = await fetch(env.CLERK_JWKS_URL);
  if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
  const jwks = (await res.json()) as { keys: Array<{ kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }> };
  await env.JWKS_CACHE?.put("jwks", JSON.stringify(jwks), { expirationTtl: 3600 }).catch(() => {});
  return jwks;
}

/**
 * Web-session auth: verify a Clerk session JWT and resolve it to an org
 * via the clerk_users mapping (provisioned by webhooks). Auto-provisions
 * the mapping when the token carries an org_id claim.
 */
export async function authenticateWeb(req: Request, env: Env): Promise<AuthContext | undefined> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !env.CLERK_JWKS_URL) return undefined;
  const claims = await verifyClerkJwt(token, () => fetchJwks(env));
  if (!claims?.sub) return undefined;

  let orgId = claims.org_id;
  if (!orgId) {
    const row = await env.DB.prepare("SELECT org_id FROM clerk_users WHERE user_id = ?").bind(claims.sub).first<{ org_id: string }>();
    orgId = row?.org_id;
  }
  if (!orgId) return undefined;

  // Auto-provision the mapping + org row for tokens from org-scoped sessions.
  await env.DB.prepare("INSERT INTO clerk_users (user_id, org_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
    .bind(claims.sub, orgId)
    .run();
  await env.DB.prepare("INSERT INTO orgs (id, name, plan) VALUES (?, ?, 'hobby') ON CONFLICT(id) DO NOTHING").bind(orgId, "My Org").run();

  const orgRow = await env.DB.prepare(
    "SELECT id, name, plan, created_at, stripe_customer_id, stripe_subscription_id FROM orgs WHERE id = ?",
  ).bind(orgId).first<{
    id: string;
    name: string;
    plan: Org["plan"];
    created_at: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  }>();
  if (!orgRow) return undefined;
  return {
    orgId,
    keyId: `clerk:${claims.sub}`,
    org: {
      id: orgRow.id,
      name: orgRow.name,
      plan: orgRow.plan,
      limits: PLAN_LIMITS[orgRow.plan],
      createdAt: orgRow.created_at,
      stripeCustomerId: orgRow.stripe_customer_id ?? undefined,
      stripeSubscriptionId: orgRow.stripe_subscription_id ?? undefined,
    },
  };
}

export type { ClerkJwtClaims };

export function corsHeaders(env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": env.CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
  };
}

export function json(body: unknown, status = 200, env?: Env, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...corsHeaders(env ?? ({} as Env)), ...headers } });
}

export function error(message: string, status = 400, env?: Env, headers: Record<string, string> = {}): Response {
  return json({ error: message }, status, env, headers);
}
