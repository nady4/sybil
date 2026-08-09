import { roundUsd } from "./money.js";

/**
 * Maintained pricing table (USD per 1M tokens), a curated subset of
 * LiteLLM's model_prices.json. Prices are read once at module load; a
 * monthly sync job can regenerate this from LiteLLM.
 *
 * Model names are matched fuzzily (version suffixes stripped).
 */

export interface ModelPrice {
  provider: "openai" | "anthropic";
  inputPerM: number;
  outputPerM: number;
  /** Reasoning models bill reasoning tokens at the output rate. */
  reasoningAsOutput: boolean;
}

export const PRICING: Record<string, ModelPrice> = {
  "gpt-4o": { provider: "openai", inputPerM: 2.5, outputPerM: 10, reasoningAsOutput: false },
  "gpt-4o-mini": { provider: "openai", inputPerM: 0.15, outputPerM: 0.6, reasoningAsOutput: false },
  "gpt-4.1": { provider: "openai", inputPerM: 2, outputPerM: 8, reasoningAsOutput: false },
  "gpt-4.1-mini": { provider: "openai", inputPerM: 0.4, outputPerM: 1.6, reasoningAsOutput: false },
  "gpt-4.1-nano": { provider: "openai", inputPerM: 0.1, outputPerM: 0.4, reasoningAsOutput: false },
  "gpt-5": { provider: "openai", inputPerM: 1.25, outputPerM: 10, reasoningAsOutput: true },
  "gpt-5-mini": { provider: "openai", inputPerM: 0.25, outputPerM: 2, reasoningAsOutput: true },
  "o3": { provider: "openai", inputPerM: 2, outputPerM: 8, reasoningAsOutput: true },
  "o3-mini": { provider: "openai", inputPerM: 1.1, outputPerM: 4.4, reasoningAsOutput: true },
  "o4-mini": { provider: "openai", inputPerM: 1.1, outputPerM: 4.4, reasoningAsOutput: true },
  "claude-3-5-sonnet": { provider: "anthropic", inputPerM: 3, outputPerM: 15, reasoningAsOutput: false },
  "claude-3-5-haiku": { provider: "anthropic", inputPerM: 0.8, outputPerM: 4, reasoningAsOutput: false },
  "claude-3-7-sonnet": { provider: "anthropic", inputPerM: 3, outputPerM: 15, reasoningAsOutput: false },
  "claude-sonnet-4": { provider: "anthropic", inputPerM: 3, outputPerM: 15, reasoningAsOutput: false },
  "claude-sonnet-4-5": { provider: "anthropic", inputPerM: 3, outputPerM: 15, reasoningAsOutput: false },
  "claude-haiku-4-5": { provider: "anthropic", inputPerM: 1, outputPerM: 5, reasoningAsOutput: false },
  "claude-opus-4": { provider: "anthropic", inputPerM: 15, outputPerM: 75, reasoningAsOutput: false },
};

/** Alias map for common versioned model ids. */
const ALIASES: Record<string, string> = {
  "gpt-4o-2024-05-13": "gpt-4o",
  "gpt-4o-2024-08-06": "gpt-4o",
  "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
  "claude-3-5-sonnet-20240620": "claude-3-5-sonnet",
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet",
  "claude-3-7-sonnet-20250219": "claude-3-7-sonnet",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-opus-4-20250514": "claude-opus-4",
};

export function resolveModel(model: string): ModelPrice | undefined {
  const alias = ALIASES[model];
  const key = alias ?? model;
  const exact = PRICING[key];
  if (exact) return exact;
  const prefix = Object.keys(PRICING).find((k) => key.startsWith(k));
  return prefix ? PRICING[prefix] : undefined;
}

export interface CostInput {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Compute cost in USD for a token bundle. Returns undefined when the model is unknown. */
export function costFor(model: string, usage: CostInput): number | undefined {
  const price = resolveModel(model);
  if (!price) return undefined;
  const inputMicros = (usage.inputTokens ?? 0) * price.inputPerM;
  const outputMicros =
    (usage.outputTokens ?? 0) * price.outputPerM +
    (price.reasoningAsOutput ? (usage.reasoningTokens ?? 0) * price.outputPerM : 0);
  return roundUsd((inputMicros + outputMicros) / 1_000_000);
}
