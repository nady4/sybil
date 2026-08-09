import { describe, expect, it } from "vitest";
import { langfuseIngestionToEnvelopes, normalizeEnvelope } from "../src/index.js";

const baseEvents = [
  {
    id: "ev1",
    type: "trace-create",
    timestamp: "2026-08-09T12:00:00.000Z",
    body: {
      id: "lf_batch_trace",
      timestamp: "2026-08-09T12:00:00.000Z",
      name: "support-agent",
      userId: "user_9",
      sessionId: "sess_2",
      metadata: { featureId: "support", agentId: "agent-7" },
    },
  },
  {
    id: "ev2",
    type: "observation-create",
    timestamp: "2026-08-09T12:00:00.100Z",
    body: {
      id: "obs_1",
      traceId: "lf_batch_trace",
      type: "GENERATION",
      name: "chat",
      startTime: "2026-08-09T12:00:00.100Z",
      endTime: "2026-08-09T12:00:00.900Z",
      model: "gpt-4o-mini",
      usage: { input: 500, output: 120, unit: "TOKENS" },
      cost: 0.000147,
      level: "DEFAULT",
      metadata: { toolCalls: [{ name: "search", input: { q: "x" }, output: "hit" }] },
    },
  },
  {
    id: "ev3",
    type: "observation-create",
    timestamp: "2026-08-09T12:00:00.900Z",
    body: {
      id: "obs_2",
      traceId: "lf_batch_trace",
      type: "SPAN",
      name: "search",
      startTime: "2026-08-09T12:00:00.900Z",
      endTime: "2026-08-09T12:00:01.400Z",
      level: "ERROR",
      statusMessage: "search api down",
    },
  },
];

describe("langfuseIngestionToEnvelopes", () => {
  it("groups trace-create + observations into one envelope", () => {
    const envelopes = langfuseIngestionToEnvelopes({ batch: baseEvents, metadata: { sdk_name: "langfuse-js" } });
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0]!;
    expect(env.trace.id).toBe("lf_batch_trace");
    expect(env.trace.featureId).toBe("support");
    expect(env.trace.agentId).toBe("agent-7");
    expect(env.trace.tenantId).toBe("sess_2");
    expect(env.observations).toHaveLength(2);
  });

  it("produces a valid Run with tokens, cost, and error status", () => {
    const envelopes = langfuseIngestionToEnvelopes({ batch: baseEvents });
    const { runs, rejected } = normalizeEnvelope(envelopes[0]!);
    expect(rejected).toBe(0);
    const run = runs[0]!;
    expect(run.featureId).toBe("support");
    expect(run.inputTokens).toBe(500);
    expect(run.outputTokens).toBe(120);
    expect(run.costUsd).toBeCloseTo(0.000147, 6);
    expect(run.status).toBe("error");
    expect(run.steps).toHaveLength(2);
    expect(run.steps![0]!.toolCalls).toHaveLength(1);
  });

  it("handles generation-create events and empty batches", () => {
    const envelopes = langfuseIngestionToEnvelopes({
      batch: [
        {
          id: "g1",
          type: "trace-create",
          body: { id: "t", name: "gen-agent", timestamp: "2026-08-09T12:00:00.000Z" },
        },
        {
          id: "g2",
          type: "generation-create",
          body: {
            id: "o1",
            traceId: "t",
            model: "gpt-4o-mini",
            promptTokens: 100,
            completionTokens: 40,
            startTime: "2026-08-09T12:00:00.000Z",
            endTime: "2026-08-09T12:00:00.500Z",
          },
        },
      ],
    });
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]!.observations as Array<{ inputTokens?: number }>)[0]!.inputTokens).toBe(100);
    expect(langfuseIngestionToEnvelopes({ batch: [] })).toHaveLength(0);
  });
});
