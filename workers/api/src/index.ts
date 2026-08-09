import { corsHeaders, json } from "./auth.js";
import type { Env } from "./auth.js";
import { handleApi, handleClerkWebhook, handleSetup } from "./routes.js";
import { handleStripeWebhook } from "./billing.js";
import { handleAdmin } from "./admin.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (url.pathname === "/health") return json({ ok: true }, 200, env);
    if (url.pathname.startsWith("/internal/admin")) return handleAdmin(req, env, url);
    if (url.pathname === "/v1/auth/clerk-webhook") return handleClerkWebhook(req, env);
    if (url.pathname === "/v1/billing/webhook") return handleStripeWebhook(req, env);
    return handleSetup(req, env).then(async (setupRes) => {
      if (setupRes.status !== 404) return setupRes;
      return handleApi(req, env, url, url.pathname);
    });
  },
} satisfies ExportedHandler<Env>;
