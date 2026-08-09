import {
  STRIPE_PLAN_BY_PRICE,
  verifyStripeSignature,
  type Org,
} from "@agentsre/shared";
import { error, json, type Env, type AuthContext } from "./auth.js";

/**
 * Stripe billing: checkout sessions, customer portal, webhook handling.
 * All Stripe API calls go through env.STRIPE_API_URL (default
 * https://api.stripe.com) with the secret key; local tests point at a
 * mock server. Env-gated — unset STRIPE_SECRET_KEY and billing is
 * disabled with a clear error.
 */

const DEFAULT_API = "https://api.stripe.com";

async function stripeFetch(env: Env, path: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const base = env.STRIPE_API_URL ?? DEFAULT_API;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY ?? ""}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

export async function handleBillingApi(req: Request, env: Env, auth: AuthContext, path: string): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return error("billing not configured", 503, env);
  const { orgId, org } = auth;

  switch (path) {
    case "/v1/billing/checkout": {
      if (req.method !== "POST") break;
      const { plan, priceId } = (await req.json()) as { plan?: Org["plan"]; priceId?: string };
      const price = priceId ?? (plan === "team" ? env.STRIPE_PRICE_TEAM : plan === "enterprise" ? env.STRIPE_PRICE_ENTERPRISE : env.STRIPE_PRICE_INDIE);
      if (!price) return error(`no price for plan ${plan ?? "unknown"}`);
      const origin = req.headers.get("origin") ?? "http://localhost:3000";
      let customerId = org.stripeCustomerId;
      if (!customerId) {
      const customer = await stripeFetch(env, "/v1/customers", {
        name: org.name,
        metadata: JSON.stringify({ orgId }),
      });
        if (!customer.ok) return error("stripe customer creation failed", 502, env);
        customerId = String(customer.data.id ?? "");
        await env.DB.prepare("UPDATE orgs SET stripe_customer_id = ? WHERE id = ?").bind(customerId, orgId).run();
      }
      const session = await stripeFetch(env, "/v1/checkout/sessions", {
        mode: "subscription",
        customer: customerId!,
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        "success_url": `${origin}/?billing=success`,
        "cancel_url": `${origin}/?billing=cancelled`,
        "metadata[orgId]": orgId,
        "metadata[plan]": plan ?? "",
      });
      if (!session.ok) return error("stripe checkout failed", 502, env);
      return json({ url: session.data.url ?? null }, 200, env);
    }

    case "/v1/billing/portal": {
      if (req.method !== "POST") break;
      if (!org.stripeCustomerId) return error("no stripe customer yet", 400, env);
      const session = await stripeFetch(env, "/v1/billing_portal/sessions", {
        customer: org.stripeCustomerId,
        "return_url": req.headers.get("origin") ?? "http://localhost:3000",
      });
      if (!session.ok) return error("stripe portal failed", 502, env);
      return json({ url: session.data.url ?? null }, 200, env);
    }

    case "/v1/billing": {
      if (req.method !== "GET") break;
      return json({
        plan: org.plan,
        stripeCustomerId: org.stripeCustomerId,
        stripeSubscriptionId: org.stripeSubscriptionId,
        limits: org.limits,
      }, 200, env);
    }
  }
  return error("not found", 404, env);
}

/**
 * Stripe webhooks (signature-verified). No API key required.
 * Handled: checkout.session.completed, customer.subscription.updated/deleted.
 */
export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405, env);
  if (!env.STRIPE_WEBHOOK_SECRET) return error("stripe not configured", 503, env);
  const payload = await req.text();
  const valid = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return error("invalid signature", 401, env);

  let body: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    body = JSON.parse(payload) as { type?: string; data?: { object?: Record<string, unknown> } };
  } catch {
    return error("invalid payload", 400, env);
  }
  const obj = body.data?.object ?? {};
  const metadata = (obj.metadata as Record<string, unknown> | undefined) ?? {};

  switch (body.type) {
    case "checkout.session.completed": {
      const orgId = String(metadata.orgId ?? "");
      const plan = (metadata.plan as Org["plan"] | undefined) ?? "team";
      const customer = String(obj.customer ?? "");
      const sub = String(obj.subscription ?? "");
      if (!orgId || !customer) return error("missing org/customer", 400, env);
      await env.DB.prepare(
        "UPDATE orgs SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?",
      ).bind(plan, customer, sub || null, orgId).run();
      return json({ ok: true }, 200, env);
    }
    case "customer.subscription.updated": {
      const subId = String(obj.id ?? "");
      const customer = String(obj.customer ?? "");
      const priceId = ((obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data?.[0]?.price?.id) ?? "";
      const org = await env.DB.prepare("SELECT id FROM orgs WHERE stripe_subscription_id = ? OR stripe_customer_id = ?")
        .bind(subId, customer)
        .first<{ id: string }>();
      if (!org) return json({ ok: true, ignored: true }, 200, env);
      const plan = STRIPE_PLAN_BY_PRICE(priceId, {
        indie: env.STRIPE_PRICE_INDIE,
        team: env.STRIPE_PRICE_TEAM,
        enterprise: env.STRIPE_PRICE_ENTERPRISE,
      });
      await env.DB.prepare("UPDATE orgs SET plan = ?, stripe_subscription_id = ? WHERE id = ?")
        .bind(plan, subId, org.id)
        .run();
      return json({ ok: true }, 200, env);
    }
    case "customer.subscription.deleted": {
      const subId = String(obj.id ?? "");
      await env.DB.prepare("UPDATE orgs SET plan = 'hobby', stripe_subscription_id = NULL WHERE stripe_subscription_id = ?")
        .bind(subId)
        .run();
      return json({ ok: true }, 200, env);
    }
    default:
      return json({ ok: true, ignored: true }, 200, env);
  }
}
