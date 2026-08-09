#!/usr/bin/env node
/**
 * Mock Clerk for local E2E:
 *  - GET  /jwks.json            RSA keypair exported as a JWKS
 *  - POST /issue-jwt            {userId, orgId} -> signed RS256 session token
 *  - POST /sign-webhook         {payload, msgId, timestamp} -> Svix headers
 *
 * Usage: node scripts/mock-clerk.mjs  (defaults to port 8785)
 */
import { createServer } from "node:http";
import { generateKeyPairSync, createHmac, sign, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8785);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "whsec_devsecret0123456789";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = publicKey.export({ format: "jwk" });
const KID = "mock-clerk-key-1";

const jwks = { keys: [{ kid: KID, kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256", use: "sig" }] };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function issueJwt(userId, orgId) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64({
    sub: userId,
    org_id: orgId,
    org_role: "org:admin",
    iat: now,
    nbf: now,
    exp: now + 3600,
    iss: "https://mock.clerk.accounts.dev",
    azp: "mock-app",
  });
  const sig = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/jwks.json") return send(200, jwks);

  if (req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (url.pathname === "/issue-jwt") {
          return send(200, { token: issueJwt(body.userId ?? "user_demo", body.orgId ?? "org_demo") });
        }
        if (url.pathname === "/sign-webhook") {
          const msgId = body.msgId ?? `msg_${randomBytes(8).toString("hex")}`;
          const ts = body.timestamp ?? String(Math.floor(Date.now() / 1000));
          const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${msgId}.${ts}.${body.payload ?? ""}`).digest("hex");
          return send(200, {
            "svix-id": msgId,
            "svix-timestamp": ts,
            "svix-signature": `v1,${sig}`,
          });
        }
      } catch {
        return send(400, { error: "bad json" });
      }
      return send(404, {});
    });
    return;
  }
  return send(404, {});
});

server.listen(PORT, () => {
  console.log(`mock-clerk listening on :${PORT} (GET /jwks.json, POST /issue-jwt, POST /sign-webhook)`);
});
