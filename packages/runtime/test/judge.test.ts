import { describe, expect, it, vi } from "vitest";
import { judgeScore, type JudgeDeps } from "../src/index.js";

function deps(overrides: Partial<JudgeDeps> = {}): JudgeDeps & { cacheStore: Map<string, string> } {
  const cacheStore = new Map<string, string>();
  return {
    model: "gpt-4o-mini",
    maxTokens: 200,
    cache: {
      get: async (k) => cacheStore.get(k) ?? null,
      put: async (k, v) => void cacheStore.set(k, v),
    },
    budget: {
      remainingUsd: async () => 10,
      spendUsd: async () => {},
    },
    complete: async () => ({ content: "0.9", refusal: false, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 10 }),
    ...overrides,
    cacheStore,
  };
}

describe("judgeScore", () => {
  it("returns a clamped score from the model", async () => {
    const d = deps();
    const score = await judgeScore("rubric", "content", d);
    expect(score).toBeCloseTo(0.9, 4);
    expect(d.cacheStore.size).toBe(1);
  });

  it("serves subsequent calls from cache without calling the model", async () => {
    const d = deps();
    const complete = vi.fn(d.complete);
    d.complete = complete;
    await judgeScore("same-rubric", "same content", d);
    await judgeScore("same-rubric", "same content", d);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("returns null when the budget is exhausted", async () => {
    const d = deps({ budget: { remainingUsd: async () => 0, spendUsd: async () => {} } });
    const score = await judgeScore("rubric", "content", d);
    expect(score).toBeNull();
  });

  it("returns null on non-numeric output", async () => {
    const d = deps({ complete: async () => ({ content: "looks fine to me", refusal: false, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }) });
    expect(await judgeScore("r", "c", d)).toBeNull();
  });

  it("returns null on provider error", async () => {
    const d = deps({ complete: async () => { throw new Error("down"); } });
    expect(await judgeScore("r", "c", d)).toBeNull();
  });
});
