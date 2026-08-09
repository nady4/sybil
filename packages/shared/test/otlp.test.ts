import { describe, expect, it } from "vitest";
import { normalizeEnvelope, normalizeOtlp } from "../src/index.js";

describe("normalizeEnvelope", () => {
  it("collapses observations into one production Run with cost fields", () => {
    const payload = normalizeEnvelope({
      trace: { id: "trace_1", orgId: "org_a", featureId: "support", agentId: "agent-7", startedAt: "2026-08-09T12:00:00.000Z" },
      observations: [
        {
          model: "gpt-4o-mini",
          inputTokens: 500,
          outputTokens: 120,
          latencyMs: 800,
          status: "success",
          toolCalls: [{ name: "fetch_url", input: { url: "https://x.dev/a" }, output: "ok" }],
        },
        {
          model: "gpt-4o-mini",
          inputTokens: 300,
          outputTokens: 80,
          latencyMs: 400,
          status: "success",
        },
      ],
    });
    expect(payload.rejected).toBe(0);
    const run = payload.runs[0]!;
    expect(run.source).toBe("production");
    expect(run.featureId).toBe("support");
    expect(run.inputTokens).toBe(800);
    expect(run.outputTokens).toBe(200);
    expect(run.latencyMs).toBe(1200);
    expect(run.status).toBe("success");
    expect(run.steps).toHaveLength(2);
    expect(run.steps![0]!.toolCalls).toHaveLength(1);
    const cost =
      500 / 1e6 * 0.15 + 120 / 1e6 * 0.6 + 300 / 1e6 * 0.15 + 80 / 1e6 * 0.6;
    expect(run.costUsd).toBeCloseTo(cost, 6);
  });

  it("marks refused observations", () => {
    const payload = normalizeEnvelope({
      trace: { id: "t2", featureId: "f" },
      observations: [{ status: "refused", model: "gpt-4o-mini", guardrailTripped: true }],
    });
    expect(payload.runs[0]!.status).toBe("refused");
    expect(payload.runs[0]!.guardrailTripped).toBe(true);
  });

  it("rejects envelopes without a featureId", () => {
    const payload = normalizeEnvelope({ trace: { id: "x" } });
    expect(payload.rejected).toBe(1);
    expect(payload.runs).toHaveLength(0);
  });
});

describe("normalizeOtlp", () => {
  const nano = (s: number) => String(s * 1e6);

  it("extracts gen_ai spans into a Run", () => {
    const payload = normalizeOtlp(
      {
        resourceSpans: [
          {
            resource: { attributes: { "service.name": "agent" } },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "abc",
                    spanId: "s1",
                    name: "chat",
                    kind: 2,
                    startTimeUnixNano: nano(1000),
                    endTimeUnixNano: nano(1200),
                    attributes: {
                      "gen_ai.response.model": "gpt-4o-mini",
                      "gen_ai.usage.input_tokens": 600,
                      "gen_ai.usage.output_tokens": 90,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "org_b",
    );
    expect(payload.runs).toHaveLength(1);
    const run = payload.runs[0]!;
    expect(run.orgId).toBe("org_b");
    expect(run.model).toBe("gpt-4o-mini");
    expect(run.inputTokens).toBe(600);
    expect(run.outputTokens).toBe(90);
    expect(run.latencyMs).toBeCloseTo(200, 0);
    expect(run.steps).toHaveLength(1);
    const cost = 600 / 1e6 * 0.15 + 90 / 1e6 * 0.6;
    expect(run.costUsd).toBeCloseTo(cost, 6);
  });

  it("flags spans with error status", () => {
    const payload = normalizeOtlp(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "def",
                    startTimeUnixNano: nano(10),
                    endTimeUnixNano: nano(20),
                    status: { code: 2, message: "boom" },
                    attributes: { "gen_ai.operation.name": "chat" },
                  },
                ],
              },
            ],
          },
        ],
      },
      "org_b",
    );
    expect(payload.runs[0]!.status).toBe("error");
  });

  it("handles empty payloads", () => {
    const payload = normalizeOtlp({ resourceSpans: [] }, "org_b");
    expect(payload.runs).toHaveLength(0);
  });
});
