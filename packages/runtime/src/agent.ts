import { costFor, type AgentStep, type Usage } from "@agentsre/shared";
import type { ChatMessage, Provider, ToolDef } from "./providers.js";
import { executeTool, type ToolContext } from "./tools.js";

/**
 * The agent loop. Runs a prompt with a tool stack to completion, capturing
 * per-step tokens / latency / tool calls / refusals — the runtime-behavior
 * signal Checkly's browser automation never sees.
 */

export interface AgentRunOptions {
  provider: Provider;
  model: string;
  prompt: string;
  system?: string;
  tools: ToolDef[];
  toolContext: ToolContext;
  maxSteps: number;
  maxOutputTokens: number;
  maxTotalCostUsd?: number;
  /** Per-model-call timeout in ms (default 90s). */
  callTimeoutMs?: number;
}

export type StopReason = "completed" | "max_steps" | "refused" | "error" | "cost_cap";

export interface AgentRunResult {
  steps: AgentStep[];
  finalContent?: string;
  refused: boolean;
  refusalReason?: string;
  totalUsage: Usage;
  totalCostUsd?: number;
  durationMs: number;
  stopReason: StopReason;
  error?: string;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const messages: ChatMessage[] = [];
  const steps: AgentStep[] = [];
  let totalCost = 0;
  let anyCostUnknown = false;
  const totals: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let lastRefusalReason: string | undefined;

  messages.push({ role: "user", content: opts.prompt });

  for (let i = 0; i < opts.maxSteps; i++) {
    const stepStart = Date.now();
    let result;
    try {
      const callTimeoutMs = opts.callTimeoutMs ?? 90_000;
      const call = opts.provider.complete({
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        maxTokens: opts.maxOutputTokens,
      });
      result = await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error("model call timed out")), callTimeoutMs);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch (e) {
      return {
        steps,
        refused: false,
        totalUsage: totals,
        totalCostUsd: anyCostUnknown ? undefined : totalCost,
        durationMs: Date.now() - startedAt,
        stopReason: "error",
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const cost = costFor(opts.model, result.usage);
    if (cost === undefined) anyCostUnknown = true;
    else totalCost += cost;
    totals.inputTokens += result.usage.inputTokens;
    totals.outputTokens += result.usage.outputTokens;
    totals.reasoningTokens = (totals.reasoningTokens ?? 0) + (result.usage.reasoningTokens ?? 0);

    const toolCalls: AgentStep["toolCalls"] = [];
    if (result.toolCalls.length) {
      for (const tc of result.toolCalls) {
        const exec = await executeTool(tc.name, tc.args, opts.toolContext);
        const toolStart = Date.now();
        toolCalls.push({
          name: tc.name,
          input: tc.args,
          output: exec.output,
          error: exec.error,
          latencyMs: Date.now() - toolStart,
        });
        messages.push({ role: "tool", toolCallId: tc.id, content: summarizeToolResult(exec.output, exec.error) });
      }
      messages.push({
        role: "assistant",
        content: result.content ?? "",
        toolCalls: result.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      });
    }

    steps.push({
      index: i,
      model: opts.model,
      latencyMs: Date.now() - stepStart,
      usage: result.usage,
      costUsd: cost,
      toolCalls,
      refused: result.refusal,
      content: result.content,
    });

    if (result.refusal) {
      lastRefusalReason = result.content;
      return {
        steps,
        finalContent: result.content,
        refused: true,
        refusalReason: lastRefusalReason,
        totalUsage: totals,
        totalCostUsd: anyCostUnknown ? undefined : totalCost,
        durationMs: Date.now() - startedAt,
        stopReason: "refused",
      };
    }

    if (opts.maxTotalCostUsd !== undefined && totalCost > opts.maxTotalCostUsd) {
      return {
        steps,
        finalContent: result.content,
        refused: false,
        totalUsage: totals,
        totalCostUsd: totalCost,
        durationMs: Date.now() - startedAt,
        stopReason: "cost_cap",
      };
    }

    if (result.toolCalls.length === 0) {
      return {
        steps,
        finalContent: result.content,
        refused: false,
        totalUsage: totals,
        totalCostUsd: anyCostUnknown ? undefined : totalCost,
        durationMs: Date.now() - startedAt,
        stopReason: "completed",
      };
    }
  }

  return {
    steps,
    refused: false,
    totalUsage: totals,
    totalCostUsd: anyCostUnknown ? undefined : totalCost,
    durationMs: Date.now() - startedAt,
    stopReason: "max_steps",
  };
}

function summarizeToolResult(output: unknown, error?: string): string {
  if (error) return `error: ${error}`;
  if (typeof output === "string") return output.slice(0, 8000);
  try {
    return JSON.stringify(output).slice(0, 8000);
  } catch {
    return String(output).slice(0, 8000);
  }
}
