/**
 * Stripe webhook signature verification (HMAC-SHA256 over
 * `<timestamp>.<payload>` with the `Stripe-Signature` header format
 * `t=<ts>,v1=<hex>`). Web Crypto only.
 */

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const TOLERANCE_SEC = 300;

export async function verifyStripeSignature(
  payload: string,
  stripeSignature: string | null,
  secret: string,
  nowSec = Date.now() / 1000,
): Promise<boolean> {
  if (!stripeSignature || !secret) return false;
  const parts = Object.fromEntries(
    stripeSignature.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx), kv.slice(idx + 1)] as const;
    }),
  );
  const ts = parts["t"];
  const sig = parts["v1"];
  if (!ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > TOLERANCE_SEC) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${payload}`));
  return timingSafeEqualHex(hexOf(new Uint8Array(mac)), sig.toLowerCase());
}

export const STRIPE_PLAN_BY_PRICE = (
  priceId: string | undefined,
  envPrices: { indie?: string; team?: string; enterprise?: string },
): "hobby" | "indie" | "team" | "enterprise" => {
  if (!priceId) return "hobby";
  if (priceId === envPrices.team) return "team";
  if (priceId === envPrices.indie) return "indie";
  if (priceId === envPrices.enterprise) return "enterprise";
  return "hobby";
};
