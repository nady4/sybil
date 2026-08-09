import { z } from "zod";

/** Envelope accepted by the production ingest endpoint (Langfuse-shaped). */
export const ingestEnvelopeSchema = z.object({
  schemaVersion: z.literal("1.0").optional(),
  trace: z.object({
    id: z.string(),
    orgId: z.string().optional(),
    featureId: z.string(),
    agentId: z.string().optional(),
    tenantId: z.string().optional(),
    startedAt: z.string().optional(),
    /** Regex rules applied to stored observation content (server-side enforced). */
    redactionRules: z.array(z.string()).max(20).optional(),
  }),
  observations: z.array(
    z.object({
      id: z.string(),
      type: z
        .enum(["GENERATION", "SPAN", "EVENT"])
        .default("GENERATION")
        .optional(),
      name: z.string().optional(),
      model: z.string().optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
      latencyMs: z.number().nonnegative().optional(),
      status: z.enum(["success", "failed", "error", "refused"]).optional(),
      errorType: z.string().optional(),
      guardrailTripped: z.boolean().optional(),
      toolCalls: z
        .array(
          z.object({
            name: z.string(),
            input: z.unknown().optional(),
            output: z.unknown().optional(),
            latencyMs: z.number().nonnegative().optional(),
            error: z.string().optional(),
          }),
        )
        .optional(),
      /** Prompt text (judge input for sampled production scoring). */
      input: z.unknown().optional(),
      /** Response text (judge input for sampled production scoring). */
      output: z.unknown().optional(),
      metadata: z.record(z.unknown()).optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
    }),
  ),
});

export const createCheckSchema = z.object({
  featureId: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  description: z.string().max(500).optional(),
  prompt: z.string().min(1).max(8000),
  system: z.string().max(4000).optional(),
  target: z.string().url().max(2048).optional(),
  allowedDomains: z.array(z.string().min(3)).max(50).optional(),
  successCriteria: z
    .array(
      z.object({
        name: z.string().max(120).optional(),
        weight: z.number().min(0).max(1).optional(),
        assertion: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("exact"),
            expected: z.string().min(1).max(2000),
            field: z.enum(["final", "last_step", "any_step"]).optional(),
          }),
          z.object({
            type: z.literal("regex"),
            pattern: z.string().min(1).max(500),
            field: z.enum(["final", "last_step", "any_step"]).optional(),
          }),
          z.object({
            type: z.literal("llm_judge"),
            rubric: z.string().min(1).max(4000),
            minScore: z.number().min(0).max(1),
          }),
          z.object({ type: z.literal("tool_called"), tool: z.string().min(1) }),
        ]),
      }),
    )
    .min(1)
    .max(20),
  intervalMinutes: z.number().int().min(5).max(1440).default(15),
  regions: z.array(z.string()).max(10).optional(),
  provider: z.enum(["openai", "anthropic", "bedrock"]).default("openai"),
  model: z.string().min(1).default("gpt-4o-mini"),
  maxSteps: z.number().int().min(1).max(25).default(8),
  maxOutputTokens: z.number().int().min(64).max(8192).default(1024),
  redactionRules: z.array(z.string()).max(20).optional(),
  alertChannelIds: z.array(z.string()).max(10).optional(),
  /** Encrypted at rest; write-only. Prompts can never inject these. */
  headers: z.record(z.string().min(1).max(60), z.string().max(1000)).optional(),
});

export const apiKeySchema = z.object({
  name: z.string().min(1).max(80),
});

export const providerKeySchema = z.object({
  provider: z.enum(["openai", "anthropic", "bedrock"]),
  label: z.string().max(80).optional(),
  key: z.string().min(8).max(500),
});

export const alertChannelSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["slack_webhook", "pagerduty", "webhook", "email_resend"]),
  config: z.record(z.string(), z.string().max(2000)),
});

export const otlpResponseSchema = z.object({
  partialSuccess: z.object({ rejectedSpans: z.number().optional() }).optional(),
});
