/**
 * Clerk integration: Svix webhook signature verification and session
 * token (RS256 JWT) verification against a JWKS endpoint. Web Crypto
 * only — no dependencies.
 */

export interface ClerkJwtClaims {
  sub?: string;
  org_id?: string;
  org_role?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
}

export interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecode(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time hex comparison (lengths equal by construction). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SvixHeaders {
  "svix-id"?: string | null;
  "svix-timestamp"?: string | null;
  "svix-signature"?: string | null;
}

const SVIX_TOLERANCE_SEC = 300;

/**
 * Verify a Svix webhook signature (the format Clerk uses). The signature
 * header is `v1,<hex-hmac-sha256(secret, msgId.timestamp.payload)>` with
 * optional multiple space-separated entries for key rotation.
 */
export async function verifySvixSignature(
  payload: string,
  headers: SvixHeaders,
  secret: string,
  nowSec = Date.now() / 1000,
): Promise<boolean> {
  const msgId = headers["svix-id"];
  const ts = headers["svix-timestamp"];
  const sigHeader = headers["svix-signature"];
  if (!msgId || !ts || !sigHeader || !secret) return false;

  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > SVIX_TOLERANCE_SEC) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${msgId}.${ts}.${payload}`));
  const expected = hexOf(new Uint8Array(mac));

  const candidates = sigHeader
    .split(" ")
    .filter((p) => p.startsWith("v1,"))
    .map((p) => p.split(",")[1] ?? "");
  return candidates.some((sig) => timingSafeEqualHex(expected, sig.toLowerCase()));
}

/**
 * Verify a Clerk session JWT (RS256) against a JWKS set. Returns the
 * decoded claims when valid, null otherwise.
 */
export async function verifyClerkJwt(
  token: string,
  getJwks: () => Promise<{ keys: Jwk[] }>,
): Promise<ClerkJwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlDecode(headerB64)) as { alg?: string; kid?: string };
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let jwks: { keys: Jwk[] };
  try {
    jwks = await getJwks();
  } catch {
    return null;
  }
  const key = jwks.keys.find((k) => k.kid === header.kid);
  if (!key || key.kty !== "RSA" || !key.n || !key.e) return null;

  let publicKey: CryptoKey | null = null;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: "RS256", use: "sig" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    publicKey,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) return null;

  let claims: ClerkJwtClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64)) as ClerkJwtClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp < nowSec()) return null;
  return claims;
}

function nowSec(): number {
  return Date.now() / 1000;
}
