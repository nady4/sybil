import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "../src/index.js";

describe("redactText", () => {
  it("redacts emails, phones, and API keys", () => {
    const text = "contact alice@example.com or +1-555-123-4567, key sk-abc1234567890123456789";
    const out = redactText(text);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[API_KEY]");
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("sk-abc123");
  });

  it("redacts bearer tokens and AWS keys", () => {
    const out = redactText("Authorization: Bearer abcDEF1234567890abcdef1234567890, AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[TOKEN]");
    expect(out).toContain("[AWS_KEY]");
  });

  it("applies customer regex rules", () => {
    const out = redactText("order number ORD-12345 here", ["ORD-\\d+"]);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ORD-12345");
  });

  it("ignores invalid customer rules", () => {
    expect(() => redactText("hello", ["(["])).not.toThrow();
  });
});

describe("redactValue", () => {
  it("redacts strings, arrays, and objects recursively", () => {
    const out = redactValue({
      prompt: "email me at bob@corp.com",
      results: ["call 555-010-9999"],
      headers: { authorization: "Bearer xyz" },
      ok: true,
    }) as { prompt: string; results: string[]; headers: Record<string, string>; ok: boolean };
    expect(out.prompt).toContain("[EMAIL]");
    expect(out.results[0]).toContain("[PHONE]");
    expect(out.headers.authorization).toBe("[REDACTED]");
    expect(out.ok).toBe(true);
  });

  it("redacts keys named key/token/secret regardless of value", () => {
    const out = redactValue({ apiKey: "123", token: "456", fine: "hello" }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.fine).toBe("hello");
  });
});
