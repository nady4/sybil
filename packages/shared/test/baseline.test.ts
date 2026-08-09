import { describe, expect, it } from "vitest";
import {
  CONFIRM_RUNS,
  computeBaseline,
  detectRegressions,
  isConfirmed,
  PercentileBuffer,
  seasonPeriod,
  seasonPeriodOf,
  type Sample,
} from "../src/index.js";

describe("PercentileBuffer", () => {
  it("computes quantiles from a sorted ring (R-7 interpolation)", () => {
    const buf = new PercentileBuffer();
    for (let i = 1; i <= 100; i++) buf.push(i);
    expect(buf.quantile(0.5)).toBeCloseTo(50.5, 6);
    expect(buf.quantile(0.95)).toBeCloseTo(95.5, 6);
    expect(buf.quantile(0.99)).toBeCloseTo(99.5, 6);
    expect(buf.min()).toBe(1);
    expect(buf.max()).toBe(100);
  });

  it("respects capacity", () => {
    const buf = new PercentileBuffer([], 10);
    for (let i = 1; i <= 50; i++) buf.push(i);
    expect(buf.size).toBe(10);
    expect(buf.min()).toBe(41);
    expect(buf.max()).toBe(50);
  });

  it("handles a single element", () => {
    const buf = PercentileBuffer.from([7]);
    expect(buf.quantile(0.5)).toBe(7);
  });
});

describe("seasonality periods", () => {
  it("maps UTC hours to periods", () => {
    expect(seasonPeriod(0)).toBe("night");
    expect(seasonPeriod(5)).toBe("night");
    expect(seasonPeriod(6)).toBe("morning");
    expect(seasonPeriod(11)).toBe("morning");
    expect(seasonPeriod(12)).toBe("afternoon");
    expect(seasonPeriod(17)).toBe("afternoon");
    expect(seasonPeriod(18)).toBe("evening");
    expect(seasonPeriod(23)).toBe("evening");
  });

  it("derives the period from an ISO timestamp", () => {
    expect(seasonPeriodOf("2026-08-09T03:00:00.000Z")).toBe("night");
    expect(seasonPeriodOf("2026-08-09T15:00:00.000Z")).toBe("afternoon");
  });
});

describe("computeBaseline", () => {
  it("computes percentiles and rates", () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 100; i++) {
      samples.push({
        latencyMs: i * 10 + 100,
        costUsd: 0.01 + i * 0.001,
        evalScore: 0.9,
        status: i % 10 === 0 ? "refused" : "success",
        completedAt: "2026-08-09T12:00:00.000Z",
      });
    }
    const b = computeBaseline(samples);
    expect(b.sampleCount).toBe(100);
    expect(b.p50LatencyMs).toBeCloseTo(595, 6);
    expect(b.p95LatencyMs).toBeCloseTo(1045, 6);
    expect(b.p99LatencyMs).toBeCloseTo(1085, 6);
    expect(b.refusalRate).toBeCloseTo(0.1);
    expect(b.errorRate).toBe(0);
  });

  it("returns undefined percentiles for empty input", () => {
    const b = computeBaseline([]);
    expect(b.sampleCount).toBe(0);
    expect(b.p50LatencyMs).toBeUndefined();
  });
});

describe("detectRegressions", () => {
  const base = {
    sampleCount: 100,
    p50LatencyMs: 500,
    p95LatencyMs: 800,
    p99LatencyMs: 1000,
    p50CostUsd: 0.02,
    p95CostUsd: 0.05,
    p50EvalScore: 0.9,
    p95EvalScore: 0.95,
    refusalRate: 0,
    errorRate: 0,
  };

  it("flags latency above max(p99, p95*1.5, floor)", () => {
    const verdicts = detectRegressions(base, { latencyMs: 5000, status: "success", completedAt: "" });
    expect(verdicts.map((v) => v.type)).toContain("latency");
  });

  it("does not flag latency below threshold", () => {
    const verdicts = detectRegressions(base, { latencyMs: 900, status: "success", completedAt: "" });
    expect(verdicts).toHaveLength(0);
  });

  it("flags eval score drops below minScore and baseline delta", () => {
    const verdicts = detectRegressions(base, { evalScore: 0.4, status: "success", completedAt: "" });
    expect(verdicts.map((v) => v.type)).toContain("score_drop");
  });

  it("does not flag eval score within noise", () => {
    const verdicts = detectRegressions(base, { evalScore: 0.85, status: "success", completedAt: "" });
    expect(verdicts).toHaveLength(0);
  });

  it("flags cost spikes over 2x p95 and abs floor", () => {
    const verdicts = detectRegressions(base, { costUsd: 1.0, status: "success", completedAt: "" });
    expect(verdicts.map((v) => v.type)).toContain("cost_spike");
  });

  it("flags a refusal when baseline refusal rate is zero", () => {
    const verdicts = detectRegressions(base, { status: "refused", completedAt: "" });
    expect(verdicts.map((v) => v.type)).toContain("refusal_spike");
  });

  it("flags an error when baseline error rate is zero", () => {
    const verdicts = detectRegressions(base, { status: "error", completedAt: "" });
    expect(verdicts.map((v) => v.type)).toContain("error_rate");
  });
});

describe("isConfirmed (2-of-3)", () => {
  it("requires 2 hits in the last 3 runs", () => {
    expect(isConfirmed([true, true])).toBe(true);
    expect(isConfirmed([false, true, true])).toBe(true);
    expect(isConfirmed([true, false, true])).toBe(true);
    expect(isConfirmed([true, false, false])).toBe(false);
    expect(isConfirmed([true, true, false, false, true])).toBe(false);
    expect(isConfirmed([])).toBe(false);
  });

  it("matches the policy constant", () => {
    expect(CONFIRM_RUNS).toBe(2);
  });
});
