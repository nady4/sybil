import { describe, expect, it } from "vitest";
import { evaluateCriteria, type AssertionContext } from "../src/index.js";

function ctx(overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    finalContent: "Your order ORD-12345 is confirmed.",
    stepContents: ["Opening page...", "Filled the form."],
    toolNamesCalled: ["fetch_url", "submit_order"],
    refused: false,
    judge: async () => 0.95,
    ...overrides,
  };
}

describe("evaluateCriteria", () => {
  it("passes exact-match on the final field", async () => {
    const { overallScore, results } = await evaluateCriteria(
      [{ name: "confirmed", assertion: { type: "exact", expected: "ORD-12345", field: "final" } }],
      ctx(),
    );
    expect(results[0]!.passed).toBe(true);
    expect(overallScore).toBe(1);
  });

  it("fails exact-match on the wrong field", async () => {
    const { overallScore } = await evaluateCriteria(
      [{ name: "confirmed", assertion: { type: "exact", expected: "ORD-12345", field: "any_step" } }],
      ctx(),
    );
    expect(overallScore).toBe(0);
  });

  it("matches regex and tool_called criteria", async () => {
    const { overallScore, results } = await evaluateCriteria(
      [
        { name: "order-no", assertion: { type: "regex", pattern: "ORD-\\d+", field: "final" } },
        { name: "submitted", assertion: { type: "tool_called", tool: "submit_order" } },
      ],
      ctx(),
    );
    expect(results.every((r) => r.passed)).toBe(true);
    expect(overallScore).toBe(1);
  });

  it("weights criteria", async () => {
    const { overallScore } = await evaluateCriteria(
      [
        { name: "must", weight: 3, assertion: { type: "exact", expected: "ORD-12345", field: "final" } },
        { name: "nice", weight: 1, assertion: { type: "exact", expected: "missing", field: "final" } },
      ],
      ctx(),
    );
    expect(overallScore).toBeCloseTo(0.75, 4);
  });

  it("caps the score at zero for refused runs", async () => {
    const { overallScore } = await evaluateCriteria(
      [{ name: "x", assertion: { type: "exact", expected: "ORD-12345", field: "final" } }],
      ctx({ refused: true }),
    );
    expect(overallScore).toBe(0);
  });

  it("marks judge criteria incomplete when the judge returns null", async () => {
    const { incomplete, results } = await evaluateCriteria(
      [{ name: "judged", assertion: { type: "llm_judge", rubric: "ok?", minScore: 0.8 } }],
      ctx({ judge: async () => null }),
    );
    expect(incomplete).toBe(true);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("judge skipped");
  });

  it("fails judge criteria below minScore", async () => {
    const { overallScore, results } = await evaluateCriteria(
      [{ name: "judged", assertion: { type: "llm_judge", rubric: "ok?", minScore: 0.9 } }],
      ctx({ judge: async () => 0.5 }),
    );
    expect(results[0]!.passed).toBe(false);
    expect(overallScore).toBeCloseTo(0.5, 4);
  });

  it("produces a 1.0 score with no criteria unless refused", async () => {
    expect((await evaluateCriteria([], ctx())).overallScore).toBe(1);
    expect((await evaluateCriteria([], ctx({ refused: true }))).overallScore).toBe(0);
  });
});
