import { describe, expect, it, vi } from "vitest";
import { createOpenAiProvider } from "../src/index.js";

describe("openai provider serialization", () => {
  it("prepends the system message when present", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok", tool_calls: null }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createOpenAiProvider("sk-test", fetchImpl as unknown as typeof fetch);
    await provider.complete({
      model: "gpt-4o-mini",
      system: "You are a strict evaluation judge.",
      messages: [{ role: "user", content: "Score this" }],
      maxTokens: 64,
    });
    const messages = captured!.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "You are a strict evaluation judge." });
    expect(messages[1]).toEqual({ role: "user", content: "Score this" });
  });

  it("does not duplicate an explicit system message", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: null } }], usage: {} }),
        { status: 200 },
      );
    });
    const provider = createOpenAiProvider("sk-test", fetchImpl as unknown as typeof fetch);
    await provider.complete({
      model: "gpt-4o-mini",
      system: "System A",
      messages: [
        { role: "system", content: "System A" },
        { role: "user", content: "hi" },
      ],
    });
    const messages = (captured!.messages as Array<{ role: string }>).filter((m) => m.role === "system");
    expect(messages).toHaveLength(1);
  });

  it("serializes assistant tool calls and tool results", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: null } }], usage: {} }), { status: 200 });
    });
    const provider = createOpenAiProvider("sk-test", fetchImpl as unknown as typeof fetch);
    await provider.complete({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "fetch_url", args: { url: "https://x.dev" } }],
        },
        { role: "tool", toolCallId: "call_1", content: "page loaded" },
      ],
    });
    const messages = captured!.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "fetch_url", arguments: '{"url":"https://x.dev"}' } },
    ]);
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "page loaded" });
  });
});
