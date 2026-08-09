import { describe, expect, it } from "vitest";
import { costFor, resolveModel } from "../src/index.js";

describe("pricing", () => {
  it("computes gpt-4o-mini cost", () => {
    const cost = costFor("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it("resolves versioned model aliases", () => {
    expect(resolveModel("gpt-4o-2024-08-06")?.inputPerM).toBe(2.5);
    expect(resolveModel("claude-3-5-sonnet-20241022")?.outputPerM).toBe(15);
  });

  it("matches by prefix", () => {
    expect(resolveModel("gpt-4o-mini-2024-07-18")?.inputPerM).toBe(0.15);
    expect(resolveModel("claude-opus-4-20250514")?.inputPerM).toBe(15);
  });

  it("returns undefined for unknown models", () => {
    expect(costFor("made-up-model", { inputTokens: 100 })).toBeUndefined();
  });

  it("bills reasoning tokens at output rate for reasoning models", () => {
    const withReasoning = costFor("o3-mini", { inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 });
    const withoutReasoning = costFor("o3-mini", { inputTokens: 0, outputTokens: 0 });
    expect(withReasoning).toBeCloseTo(4.4, 6);
    expect(withoutReasoning).toBe(0);
  });

  it("does not bill reasoning separately for non-reasoning models", () => {
    const cost = costFor("gpt-4o-mini", { inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 });
    expect(cost).toBe(0);
  });

  it("computes mixed usage", () => {
    const cost = costFor("claude-haiku-4-5", { inputTokens: 100_000, outputTokens: 20_000 });
    expect(cost).toBeCloseTo(0.2, 6);
  });
});
