import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsReExporter } from "../src/index.js";

function mockFetch(): { fn: ReturnType<typeof vi.fn>; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 200 });
  });
  return { fn, bodies };
}

function makeExporter(overrides: { fetchImpl?: typeof fetch; onError?: (e: Error) => void } = {}) {
  const { fn, bodies } = mockFetch();
  const exporter = new AgentsReExporter({
    ingestUrl: "http://ingest.test",
    apiKey: "ars_test",
    featureId: "support",
    agentId: "agent-7",
    redactionRules: ["ORD-\\d+"],
    fetchImpl: (overrides.fetchImpl ?? fn) as unknown as typeof fetch,
    ...(overrides.onError ? { onError: overrides.onError } : {}),
  });
  return { exporter, fn, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsReExporter", () => {
  it("batches observations into one envelope per trace", async () => {
    const { exporter, bodies } = makeExporter();
    exporter.observe({ model: "gpt-4o-mini", inputTokens: 100, outputTokens: 50, latencyMs: 700, input: "hi", output: "hello" });
    exporter.observe({ name: "search", toolCalls: [{ name: "search", input: { q: "x" }, output: "hit" }] });
    await exporter.flush();

    expect(bodies).toHaveLength(1);
    const env = bodies[0]!;
    expect((env.trace as Record<string, unknown>).featureId).toBe("support");
    expect((env.trace as Record<string, unknown>).agentId).toBe("agent-7");
    expect((env.trace as Record<string, unknown>).redactionRules).toEqual(["ORD-\\d+"]);
    expect((env.observations as unknown[]).length).toBe(2);
  });

  it("capture() wraps a call and measures latency when omitted", async () => {
    const { exporter, bodies } = makeExporter();
    const out = await exporter.capture(async (observe) => {
      await new Promise((r) => setTimeout(r, 5));
      observe({ model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5, input: "p", output: "r" });
      return "done";
    });
    expect(out).toBe("done");
    await exporter.flush();
    const obs = (bodies[0]!.observations as Array<{ latencyMs?: number }>)[0]!;
    expect(obs.latencyMs).toBeGreaterThanOrEqual(5);
  });

  it("flushes automatically at the buffer cap", async () => {
    const { exporter, fn } = makeExporter();
    for (let i = 0; i < 49; i++) exporter.observe({ model: "m", inputTokens: 1, outputTokens: 1 });
    expect(fn).not.toHaveBeenCalled();
    exporter.observe({ model: "m", inputTokens: 1, outputTokens: 1 }); // 50th -> flush
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and drops on persistent failure without throwing", async () => {
    let calls = 0;
    const failingFetch = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("network");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const errors: Error[] = [];
    const { exporter } = makeExporter({
      fetchImpl: failingFetch as unknown as typeof fetch,
      onError: (e) => errors.push(e),
    });
    exporter.observe({ model: "m", inputTokens: 1, outputTokens: 1 });
    const ok = await exporter.flush();
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(errors).toHaveLength(2); // two transient errors reported
  });

  it("does not retry 401", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    const { exporter } = makeExporter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    exporter.observe({ model: "m", inputTokens: 1, outputTokens: 1 });
    const ok = await exporter.flush();
    expect(ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores observations after close()", async () => {
    const { exporter, fn } = makeExporter();
    exporter.close();
    exporter.observe({ model: "m", inputTokens: 1, outputTokens: 1 });
    await exporter.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
