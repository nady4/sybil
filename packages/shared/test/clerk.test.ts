import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyClerkJwt, verifySvixSignature } from "../src/index.js";

const SECRET = "whsec_0123456789abcdef0123456789abcdef";

function svixHeader(msgId: string, ts: string, payload: string): {
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
} {
  const sig = createHmac("sha256", SECRET).update(`${msgId}.${ts}.${payload}`).digest("hex");
  return { "svix-id": msgId, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

describe("verifySvixSignature", () => {
  const payload = JSON.stringify({ type: "organization.created", data: { id: "org_abc" } });

  it("accepts a valid signature", async () => {
    const headers = svixHeader("msg_1", "1754726400", payload);
    expect(await verifySvixSignature(payload, headers, SECRET, 1754726400)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const headers = svixHeader("msg_1", "1754726400", payload);
    expect(await verifySvixSignature(payload + "x", headers, SECRET, 1754726400)).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const headers = svixHeader("msg_1", "1754726400", payload);
    expect(await verifySvixSignature(payload, headers, "whsec_wrong", 1754726400)).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const headers = svixHeader("msg_1", "1754726000", payload);
    expect(await verifySvixSignature(payload, headers, SECRET, 1754726400)).toBe(false);
  });

  it("accepts a rotated key (any v1 entry)", async () => {
    const headers = svixHeader("msg_1", "1754726400", payload);
    const oldSig = createHmac("sha256", "whsec_old").update(`msg_1.1754726400.${payload}`).digest("hex");
    const headers2 = { ...headers, "svix-signature": `v1,${oldSig} v1,${headers["svix-signature"]!.split(",")[1]}` };
    expect(await verifySvixSignature(payload, headers2, SECRET, 1754726400)).toBe(true);
  });

  it("rejects missing headers", async () => {
    expect(await verifySvixSignature(payload, {}, SECRET)).toBe(false);
  });
});

describe("verifyClerkJwt", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ format: "jwk" }) as { n: string; e: string; kty: string };
  const jwks = { keys: [{ kid: "key1", kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256", use: "sig" }] };

  function makeToken(claims: Record<string, unknown>, kid = "key1"): string {
    const b64 = (o: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = b64({ alg: "RS256", kid, typ: "JWT" });
    const payload = b64(claims);
    const sig = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${sig}`;
  }

  it("accepts a valid token and returns claims", async () => {
    const token = makeToken({ sub: "user_1", org_id: "org_x", exp: Math.floor(Date.now() / 1000) + 3600 });
    const claims = await verifyClerkJwt(token, async () => jwks);
    expect(claims?.sub).toBe("user_1");
    expect(claims?.org_id).toBe("org_x");
  });

  it("rejects an expired token", async () => {
    const token = makeToken({ sub: "user_1", exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyClerkJwt(token, async () => jwks)).toBeNull();
  });

  it("rejects a token signed with an unknown kid", async () => {
    const token = makeToken({ sub: "user_1", exp: 9999999999 }, "other-kid");
    expect(await verifyClerkJwt(token, async () => jwks)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = makeToken({ sub: "user_1", exp: 9999999999 });
    const [h, , s] = token.split(".");
    const bad = `${h}.${Buffer.from(JSON.stringify({ sub: "attacker", exp: 9999999999 })).toString("base64url")}.${s}`;
    expect(await verifyClerkJwt(bad, async () => jwks)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyClerkJwt("not-a-jwt", async () => jwks)).toBeNull();
  });
});
