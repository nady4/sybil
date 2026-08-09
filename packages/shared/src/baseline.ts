import type { AlertType, Baseline, RunStatus, SeasonPeriod } from "./types.js";

/**
 * Baseline math. Latency and cost are right-skewed, so we use percentile
 * ring buffers rather than mean/stddev. Baselines are windowed by a
 * seasonality period (UTC hour bucket) so business-hours vs night traffic
 * do not trip each other's thresholds.
 */

export const MIN_SAMPLES = 20;
export const CONFIRM_RUNS = 2; // 2 of the last 3 runs must be in regression
export const WATCH_WINDOW = 3;

export function seasonPeriod(hourUtc: number): SeasonPeriod {
  if (hourUtc >= 0 && hourUtc < 6) return "night";
  if (hourUtc < 12) return "morning";
  if (hourUtc < 18) return "afternoon";
  return "evening";
}

export function seasonPeriodOf(isoDate: string | Date): SeasonPeriod {
  const d = typeof isoDate === "string" ? new Date(isoDate) : isoDate;
  return seasonPeriod(d.getUTCHours());
}

/** Fixed-capacity insertion-sorted ring buffer for streaming percentiles. */
export class PercentileBuffer {
  constructor(
    private readonly values: number[] = [],
    public readonly capacity = 2000,
  ) {}

  push(value: number): void {
    if (this.values.length >= this.capacity) {
      const idx = this.values.indexOf(Math.min(...this.values));
      this.values.splice(idx, 1);
    }
    this.values.push(value);
    this.values.sort((a, b) => a - b);
  }

  get size(): number {
    return this.values.length;
  }

  quantile(q: number): number | undefined {
    if (this.values.length === 0) return undefined;
    const pos = (this.values.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return this.values[lo];
    return (this.values[lo]! + this.values[hi]!) / 2;
  }

  min(): number | undefined {
    return this.values.length ? this.values[0] : undefined;
  }

  max(): number | undefined {
    return this.values.length ? this.values[this.values.length - 1] : undefined;
  }

  toJSON(): number[] {
    return this.values;
  }

  static from(values: number[]): PercentileBuffer {
    return new PercentileBuffer([...values].sort((a, b) => a - b));
  }
}

export interface Sample {
  latencyMs?: number;
  costUsd?: number;
  evalScore?: number;
  status: RunStatus;
  completedAt: string;
}

export interface BaselineCompute {
  sampleCount: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;
  p50CostUsd?: number;
  p95CostUsd?: number;
  p50EvalScore?: number;
  p95EvalScore?: number;
  refusalRate?: number;
  errorRate?: number;
}

export function computeBaseline(samples: Sample[]): BaselineCompute {
  const n = samples.length;
  const latency = new PercentileBuffer();
  const cost = new PercentileBuffer();
  const evalScores = new PercentileBuffer();
  let refusals = 0;
  let errors = 0;
  for (const s of samples) {
    if (s.latencyMs !== undefined) latency.push(s.latencyMs);
    if (s.costUsd !== undefined) cost.push(s.costUsd);
    if (s.evalScore !== undefined) evalScores.push(s.evalScore);
    if (s.status === "refused") refusals++;
    if (s.status === "error" || s.status === "failed") errors++;
  }
  return {
    sampleCount: n,
    p50LatencyMs: latency.quantile(0.5),
    p95LatencyMs: latency.quantile(0.95),
    p99LatencyMs: latency.quantile(0.99),
    p50CostUsd: cost.quantile(0.5),
    p95CostUsd: cost.quantile(0.95),
    p50EvalScore: evalScores.quantile(0.5),
    p95EvalScore: evalScores.quantile(0.95),
    refusalRate: n ? refusals / n : undefined,
    errorRate: n ? errors / n : undefined,
  };
}

export function toBaselineRow(
  featureId: string,
  model: string,
  period: SeasonPeriod,
  computed: BaselineCompute,
  now: string,
): Baseline {
  return { featureId, model, period, ...computed, updatedAt: now };
}

export interface AlertPolicy {
  minSamples: number;
  latency: { floorMs: number; p95Multiplier: number };
  scoreDrop: { minScore: number; delta: number };
  costSpike: { p95Multiplier: number; absUsdFloor: number };
  refusalSpike: { delta: number };
  errorRateSpike: { delta: number };
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  minSamples: MIN_SAMPLES,
  latency: { floorMs: 2000, p95Multiplier: 1.5 },
  scoreDrop: { minScore: 0.6, delta: 0.15 },
  costSpike: { p95Multiplier: 2, absUsdFloor: 0.5 },
  refusalSpike: { delta: 0.1 },
  errorRateSpike: { delta: 0.1 },
};

export interface RegressionVerdict {
  type: AlertType;
  severity: "warning" | "critical";
  message: string;
  metrics: Record<string, number | string | undefined>;
}

/**
 * Compare one sample against its baseline. Only meaningful when the
 * baseline has >= minSamples; callers must gate on that.
 */
export function detectRegressions(
  baseline: BaselineCompute,
  sample: Sample,
  policy: AlertPolicy = DEFAULT_ALERT_POLICY,
): RegressionVerdict[] {
  const verdicts: RegressionVerdict[] = [];

  if (sample.latencyMs !== undefined && baseline.p99LatencyMs !== undefined) {
    const p95 = baseline.p95LatencyMs;
    const threshold =
      p95 !== undefined ? Math.max(baseline.p99LatencyMs, p95 * policy.latency.p95Multiplier, policy.latency.floorMs) : Math.max(baseline.p99LatencyMs, policy.latency.floorMs);
    if (sample.latencyMs > threshold) {
      verdicts.push({
        type: "latency",
        severity: sample.latencyMs > baseline.p99LatencyMs * 1.5 ? "critical" : "warning",
        message: `latency ${sample.latencyMs}ms exceeds baseline p99 ${baseline.p99LatencyMs}ms`,
        metrics: { latencyMs: sample.latencyMs, baselineP99Ms: baseline.p99LatencyMs },
      });
    }
  }

  if (
    sample.evalScore !== undefined &&
    baseline.p50EvalScore !== undefined &&
    sample.evalScore < policy.scoreDrop.minScore &&
    sample.evalScore < baseline.p50EvalScore - policy.scoreDrop.delta
  ) {
    verdicts.push({
      type: "score_drop",
      severity: "critical",
      message: `eval score ${sample.evalScore.toFixed(2)} dropped below baseline p50 ${baseline.p50EvalScore.toFixed(2)}`,
      metrics: { evalScore: sample.evalScore, baselineP50Eval: baseline.p50EvalScore },
    });
  }

  if (
    sample.costUsd !== undefined &&
    baseline.p95CostUsd !== undefined &&
    sample.costUsd > Math.max(baseline.p95CostUsd * policy.costSpike.p95Multiplier, policy.costSpike.absUsdFloor)
  ) {
    verdicts.push({
      type: "cost_spike",
      severity: "warning",
      message: `cost $${sample.costUsd.toFixed(4)} exceeds ${policy.costSpike.p95Multiplier}x baseline p95 $${baseline.p95CostUsd.toFixed(4)}`,
      metrics: { costUsd: sample.costUsd, baselineP95Cost: baseline.p95CostUsd },
    });
  }

  if (baseline.refusalRate !== undefined && sample.status === "refused") {
    if (sample.status === "refused" && baseline.refusalRate === 0) {
      verdicts.push({
        type: "refusal_spike",
        severity: "warning",
        message: "refusal occurred with zero refusal baseline",
        metrics: { refusalRate: 1, baselineRefusalRate: 0 },
      });
    } else if (baseline.refusalRate > 0 && 1 - baseline.refusalRate <= baseline.refusalRate + policy.refusalSpike.delta) {
      // Reserved: spike detection across a window is the DO's job; single-run gate here.
    }
  }

  if (baseline.errorRate !== undefined && (sample.status === "error" || sample.status === "failed")) {
    if (baseline.errorRate === 0) {
      verdicts.push({
        type: "error_rate",
        severity: "critical",
        message: "run failed with zero error baseline",
        metrics: { errorRate: 1, baselineErrorRate: 0 },
      });
    }
  }

  return verdicts;
}

/** 2-of-3 confirmation: the last statuses ring decides whether to alert. */
export function isConfirmed(prevResults: boolean[]): boolean {
  const recent = prevResults.slice(-WATCH_WINDOW);
  const hits = recent.filter(Boolean).length;
  return hits >= CONFIRM_RUNS;
}
