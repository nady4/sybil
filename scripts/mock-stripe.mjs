#!/usr/bin/env node
/**
 * Mock Stripe for local E2E:
 *  - POST /v1/customers                 -> { id: "cus_mock_<n>" }
 *  - POST /v1/checkout/sessions         -> { id, url }
 *  - POST /v1/billing_portal/sessions   -> { url }
 *  - POST /v1/billing/meter_events      -> { id } (logs the body)
 *  - POST /webhook-sign                 { payload, timestamp } -> Stripe-Signature header value
 *  - GET  /log                          -> meter events received
 *
 * Usage: node scripts/mock-stripe.mjs  (defaults to port 8784)
 */
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8784);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "whsec_stripe_mock_0123456789";

const meterEvents = [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/log") return send(200, meterEvents);

  if (req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (url.pathname === "/webhook-sign") {
        try {
          const { payload, timestamp } = JSON.parse(raw || "{}");
          const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
          const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${payload}`).digest("hex");
          return send(200, { header: `t=${ts},v1=${sig}` });
        } catch {
          return send(400, { error: "bad json" });
        }
      }
      if (url.pathname === "/v1/billing/meter_events") {
        try {
          const body = JSON.parse(raw || "{}");
          meterEvents.push(body);
          return send(200, { id: `mev_${randomBytes(4).toString("hex")}` });
        } catch {
          return send(400, { error: "bad json" });
        }
      }
      if (url.pathname === "/v1/customers") {
        return send(200, { id: `cus_mock_${randomBytes(4).toString("hex")}` });
      }
      if (url.pathname === "/v1/checkout/sessions") {
        return send(200, { id: `cs_mock_${randomBytes(4).toString("hex")}`, url: "http://localhost:8784/checkout-mock" });
      }
      if (url.pathname === "/v1/billing_portal/sessions") {
        return send(200, { url: "http://localhost:8784/portal-mock" });
      }
      return send(404, {});
    });
    return;
  }
  return send(404, {});
});

server.listen(PORT, () => {
  console.log(`mock-stripe listening on :${PORT}`);
});
