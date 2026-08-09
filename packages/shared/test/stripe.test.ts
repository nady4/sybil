import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STRIPE_PLAN_BY_PRICE, verifyStripeSignature } from "../src/index.js";

const SECRET = "whsec_stripe_test_secret_0123456789";

function sigHeader(ts: string, payload: string): string {
  const sig = createHmac("sha256", SECRET).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

describe("verifyStripeSignature", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const ts = "1754726400";

  it("accepts a valid signature", async () => {
    expect(await verifyStripeSignature(payload, sigHeader(ts, payload), SECRET, 1754726400)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    expect(await verifyStripeSignature(payload + "x", sigHeader(ts, payload), SECRET, 1754726400)).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    expect(await verifyStripeSignature(payload, sigHeader(ts, payload), "wrong", 1754726400)).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    expect(await verifyStripeSignature(payload, sigHeader("1754726000", payload), SECRET, 1754726400)).toBe(false);
  });

  it("rejects missing header", async () => {
    expect(await verifyStripeSignature(payload, null, SECRET)).toBe(false);
  });
});

describe("STRIPE_PLAN_BY_PRICE", () => {
  const prices = { indie: "price_indie", team: "price_team", enterprise: "price_ent" };
  it("maps known price ids to plans", () => {
    expect(STRIPE_PLAN_BY_PRICE("price_team", prices)).toBe("team");
    expect(STRIPE_PLAN_BY_PRICE("price_indie", prices)).toBe("indie");
    expect(STRIPE_PLAN_BY_PRICE("price_ent", prices)).toBe("enterprise");
  });
  it("defaults unknown/missing to hobby", () => {
    expect(STRIPE_PLAN_BY_PRICE(undefined, prices)).toBe("hobby");
    expect(STRIPE_PLAN_BY_PRICE("price_mystery", prices)).toBe("hobby");
  });
});
