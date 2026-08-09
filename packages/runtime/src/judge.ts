import { costFor, stableHash } from "@agentsre/shared";
import type { Provider } from "./providers.js";

/**
 * LLM-as-judge with KV caching and a hard per-org daily budget. The judge
 * is the only vendor-paid LLM in the product (capped by design — the
 * synthetic agent itself runs on customer keys).
 */

export interface JudgeDeps {
  model: string;
  maxTokens: number;
  cache: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, ttlSeconds: number): Promise<void>;
  };
  budget: {
    remainingUsd(): Promise<number>;
    spendUsd(usd: number): Promise<void>;
  };
  complete: Provider["complete"];
}

export const JUDGE_SYSTEM =
  "You are a strict evaluation judge. Score the assistant's final answer against the rubric. " +
  "Reply with a single number 0.0 to 1.0, nothing else.";

/**
 * Score content against a rubric. Returns null when the judge is
 * unavailable (budget exhausted, cache/backend error) — callers treat
 * null as "incomplete", never as failure.
 */
export async function judgeScore(rubric: string, content: string, deps: JudgeDeps): Promise<number | null> {
  const truncated = content.slice(0, 4000);
  const key = await stableHash(`${deps.model}|${rubric}|${truncated}`);

  const cached = await deps.cache.get(key).catch(() => null);
  if (cached !== null && cached !== undefined) {
    const n = Number(cached);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
  }

  const estimatedTokens = Math.ceil((rubric.length + truncated.length) / 4) + deps.maxTokens;
  const estCost = costFor(deps.model, { inputTokens: estimatedTokens }) ?? 0.001;
  const remaining = await deps.budget.remainingUsd().catch(() => 0);
  if (remaining < estCost) return null;

  try {
    const result = await deps.complete({
      model: deps.model,
      system: JUDGE_SYSTEM,
      messages: [
        { role: "user", content: `RUBRIC:\n${rubric}\n\nANSWER:\n${truncated}\n\nScore (0.0-1.0):` },
      ],
      maxTokens: deps.maxTokens,
    });
    if (result.refusal) return null;
    const m = result.content?.match(/(0(?:\.\d+)?|1(?:\.0+)?)/);
    const score = m ? Number(m[1]) : null;
    if (score === null || Number.isNaN(score)) return null;
    const clamped = Math.min(1, Math.max(0, score));
    await deps.cache.put(key, String(clamped), 7 * 24 * 3600).catch(() => {});
    await deps.budget.spendUsd(estCost).catch(() => {});
    return clamped;
  } catch {
    return null;
  }
}
