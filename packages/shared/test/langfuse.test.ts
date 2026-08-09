import { describe, expect, it } from "vitest";
import { langfuseTraceToEnvelope, normalizeEnvelope } from "../src/index.js";

describe("langfuseTraceToEnvelope", () => {
  it("maps a Langfuse trace payload to our envelope", () => {
    const envelope = langfuseTraceToEnvelope({
      id: "lf_trace_1",
      timestamp: "2026-08-09T10:00:00.000Z",
      name: "customer-support",
      userId: "user_9",
      sessionId: "sess_2",
      metadata: { featureId: "support", agentId: "agent-7" },
      observations: [
        {
          id: "obs_1",
          type: "GENERATION",
          name: "chat",
          startTime: "2026-08-09T10:00:00.000Z",
          endTime: "2026-08-09T10:00:00.900Z",
          model: "gpt-4o-mini",
          usage: { input: 500, output: 120, unit: "TOKENS" },
          cost: 0.000147,
          level: "DEFAULT",
        },
        {
          id: "obs_2",
          type: "SPAN",
          startTime: "2026-08-09T10:00:00.900Z",
          endTime: "2026-08-09T10:00:01.500Z",
          name: "search",
          level: "ERROR",
          statusMessage: "search api down",
          metadata: { toolCalls: [{ name: "search", input: { q: "x" }, output: "err" }] },
        },
      ],
    });
    expect(envelope.trace.featureId).toBe("support");
    expect(envelope.trace.agentId).toBe("agent-7");
    expect(envelope.trace.tenantId).toBe("sess_2");
    expect(envelope.observations).toHaveLength(2);
    const [o1, o2] = envelope.observations as Array<{
      model?: string;
      inputTokens?: number;
      latencyMs?: number;
      status?: string;
      toolCalls?: unknown[];
    }>;
    expect(o1!.model).toBe("gpt-4o-mini");
    expect(o1!.inputTokens).toBe(500);
    expect(o1!.latencyMs).toBe(900);
    expect(o1!.status).toBe("success");
    expect(o2!.status).toBe("error");
    expect(o2!.toolCalls).toHaveLength(1);
  });

  it("falls back to trace name for featureId", () => {
    const envelope = langfuseTraceToEnvelope({ id: "t", name: "my-agent" });
    expect(envelope.trace.featureId).toBe("my-agent");
  });

  it("produces a valid Run through normalizeEnvelope with computed cost", () => {
    const envelope = langfuseTraceToEnvelope({
      id: "lf_2",
      timestamp: "2026-08-09T11:00:00.000Z",
      metadata: { featureId: "f" },
      observations: [{ model: "gpt-4o-mini", promptTokens: 400, completionTokens: 80 }],
    });
    const { runs, rejected } = normalizeEnvelope(envelope);
    expect(rejected).toBe(0);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.featureId).toBe("f");
    expect(run.inputTokens).toBe(400);
    expect(run.outputTokens).toBe(80);
    expect(run.costUsd).toBeCloseTo(400 / 1e6 * 0.15 + 80 / 1e6 * 0.6, 6);
  });
});
