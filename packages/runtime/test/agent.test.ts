import { afterEach, describe, expect, it, vi } from "vitest";
import { costFor } from "@agentsre/shared";
import {
  detectRefusal,
  runAgent,
  type ChatMessage,
  type ChatResult,
  type Provider,
} from "../src/index.js";

const MODEL = "gpt-4o-mini";

function makeProvider(script: Array<Partial<ChatResult> & { delayMs?: number }>): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    calls,
    async complete(req) {
      calls.push(req.messages);
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      return {
        content: undefined,
        refusal: false,
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 100,
        ...step,
      };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runAgent", () => {
  it("runs the loop until the model stops calling tools, capturing cost per step", async () => {
    const provider = makeProvider([
      {
        toolCalls: [{ id: "tc1", name: "current_datetime", args: {} }],
        usage: { inputTokens: 200, outputTokens: 10 },
        latencyMs: 150,
      },
      { content: "It is now done.", usage: { inputTokens: 50, outputTokens: 30 }, latencyMs: 90 },
    ]);
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "What time is it?",
      tools: [
        { name: "current_datetime", description: "now", inputSchema: { type: "object", properties: {} } },
      ],
      toolContext: { allowedHosts: ["example.com"] },
      maxSteps: 5,
      maxOutputTokens: 200,
    });
    expect(res.stopReason).toBe("completed");
    expect(res.finalContent).toBe("It is now done.");
    expect(res.steps).toHaveLength(2);
    expect(res.steps[0]!.toolCalls).toHaveLength(1);
    expect(res.steps[0]!.toolCalls[0]!.name).toBe("current_datetime");
    expect(res.steps[1]!.toolCalls).toHaveLength(0);
    expect(provider.calls).toHaveLength(2);
    const expectedCost =
      costFor(MODEL, { inputTokens: 200, outputTokens: 10 })! +
      costFor(MODEL, { inputTokens: 50, outputTokens: 30 })!;
    expect(res.totalCostUsd).toBeCloseTo(expectedCost, 6);
    expect(res.totalUsage.inputTokens).toBe(250);
  });

  it("stops on provider refusal", async () => {
    const provider = makeProvider([{ content: "I can't help with that.", refusal: true }]);
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "Do the thing",
      tools: [],
      toolContext: { allowedHosts: [] },
      maxSteps: 5,
      maxOutputTokens: 200,
    });
    expect(res.stopReason).toBe("refused");
    expect(res.refused).toBe(true);
  });

  it("records an error when the provider throws", async () => {
    const provider: Provider = {
      async complete() {
        throw new Error("provider down");
      },
    };
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "hi",
      tools: [],
      toolContext: { allowedHosts: [] },
      maxSteps: 5,
      maxOutputTokens: 200,
    });
    expect(res.stopReason).toBe("error");
    expect(res.error).toContain("provider down");
  });

  it("stops at max steps when the model never finishes", async () => {
    const provider = makeProvider([
      { toolCalls: [{ id: "t1", name: "current_datetime", args: {} }] },
    ]);
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "loop",
      tools: [{ name: "current_datetime", description: "now", inputSchema: { type: "object", properties: {} } }],
      toolContext: { allowedHosts: [] },
      maxSteps: 3,
      maxOutputTokens: 100,
    });
    expect(res.stopReason).toBe("max_steps");
    expect(res.steps).toHaveLength(3);
  });

  it("respects the per-call timeout", async () => {
    const provider: Provider = {
      async complete() {
        await new Promise((r) => setTimeout(r, 5000));
        return { content: "late", refusal: false, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
      },
    };
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "hi",
      tools: [],
      toolContext: { allowedHosts: [] },
      maxSteps: 2,
      maxOutputTokens: 100,
      callTimeoutMs: 50,
    });
    expect(res.stopReason).toBe("error");
    expect(res.error).toContain("timed out");
  });

  it("aborts when the total cost cap is exceeded", async () => {
    const provider = makeProvider([
      { toolCalls: [{ id: "t1", name: "current_datetime", args: {} }], usage: { inputTokens: 100_000_000, outputTokens: 10_000_000 } },
    ]);
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "expensive",
      tools: [{ name: "current_datetime", description: "now", inputSchema: { type: "object", properties: {} } }],
      toolContext: { allowedHosts: [] },
      maxSteps: 5,
      maxOutputTokens: 100,
      maxTotalCostUsd: 0.05,
    });
    expect(res.stopReason).toBe("cost_cap");
  });

  it("executes fetch_url against the allowlist and blocks disallowed hosts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body><h1>Hello World</h1></body></html>", {
        headers: { "content-type": "text/html" },
      })),
    );
    const provider = makeProvider([
      { toolCalls: [{ id: "t1", name: "fetch_url", args: { url: "https://allowed.dev/page" } }] },
      { content: "Page says Hello World", usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 10 },
    ]);
    const res = await runAgent({
      provider,
      model: MODEL,
      prompt: "check the page",
      tools: [{ name: "fetch_url", description: "fetch", inputSchema: { type: "object", properties: {} } }],
      toolContext: { allowedHosts: ["allowed.dev"] },
      maxSteps: 3,
      maxOutputTokens: 100,
    });
    const fetchCall = res.steps[0]!.toolCalls[0]!;
    expect(fetchCall.error).toBeUndefined();
    expect(JSON.stringify(fetchCall.output)).toContain("Hello World");
  });
});

describe("detectRefusal", () => {
  it("detects common refusal phrasings", () => {
    expect(detectRefusal("I'm sorry, but I can't do that.").refused).toBe(true);
    expect(detectRefusal("I cannot assist with that request.").refused).toBe(true);
    expect(detectRefusal("I am not able to provide that.").refused).toBe(true);
    expect(detectRefusal("Here is the order confirmation.").refused).toBe(false);
    expect(detectRefusal(undefined).refused).toBe(false);
  });
});
