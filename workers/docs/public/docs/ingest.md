# Production ingest

Export your agent runtime's traces to AgentsRE. Three compatible paths,
all authenticated with `Authorization: Bearer <api-key>`.

## 1. Envelope (`POST /v1/traces`)

```json
{
  "trace": { "id": "t1", "featureId": "support", "agentId": "agent-7", "startedAt": "2026-08-09T12:00:00Z" },
  "observations": [
    {
      "model": "gpt-4o-mini",
      "inputTokens": 500,
      "outputTokens": 120,
      "latencyMs": 800,
      "status": "success",
      "costUsd": 0.000147,
      "input": "user prompt text",
      "output": "assistant response text",
      "toolCalls": [{ "name": "search", "input": {"q": "x"}, "output": "..." }]
    }
  ]
}
```

One trace = one Run. Tokens/cost are auto-computed from the pricing table
when omitted. `input`/`output` feed the sampled judge scorer.
`trace.redactionRules` (regex list) is enforced server-side on stored
content — send it to scrub PII.

## Drop-in exporter (`@agentsre/sdk`)

```ts
import { AgentsReExporter } from "@agentsre/sdk";

const exporter = new AgentsReExporter({
  apiKey: process.env.AGENTSRE_API_KEY!,
  featureId: "support",
  agentId: "agent-7",
});

// Wrap any LLM call — usage/latency captured automatically
const reply = await exporter.capture(async (observe) => {
  const res = await myLlmCall(...);
  observe({ model: res.model, inputTokens: res.usage.in, outputTokens: res.usage.out,
            input: prompt, output: res.text, status: "success" });
  return res;
});

// Or explicit steps + flush at the end of the agent run
exporter.observe({ name: "search", latencyMs: 400, toolCalls: [{ name: "search", input, output }] });
await exporter.flush();
```

Batches observations into one envelope per trace (5s/50-obs fallback),
retries transient failures, and never throws into your agent loop.

## 2. OTLP (`POST /v1/otlp`)

OTLP HTTP JSON (resourceSpans). GenAI semantic conventions are read:
`gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.reasoning_tokens`, `gen_ai.error.type`.

## 3. Langfuse-compat (`POST /api/public/trace` and `/api/public/ingestion`)

Point a Langfuse SDK at us with `baseUrl: "https://api.agentsre.dev"` —
no code changes. Basic auth (`publicKey:secretKey`) is accepted; the
public key must be your AgentsRE API key.

```ts
import { Langfuse } from "langfuse";
const langfuse = new Langfuse({
  baseUrl: "https://api.agentsre.dev",
  publicKey: process.env.AGENTSRE_API_KEY!,
  secretKey: "any",
});
const trace = langfuse.trace({ name: "support-agent", metadata: { featureId: "support" } });
trace.generation({ name: "chat", model: "gpt-4o-mini", usage: { input: 400, output: 80 } });
await langfuse.flushAsync();
```

The batch ingestion protocol is fully supported, including the SDK's
split-event batching (trace-create and observations may arrive in
separate requests — they are assembled per trace server-side).

## Limits and delivery

- Burst: token-bucket rate limiter per org (1000 burst, 100/sec refill)
- Daily cap: per-org plan limit (`maxRunsPerDay`), returns 429
- Delivery: queue -> batched D1 write -> FeatureCoordinator (baselines/alerting)
- Every production run is scored with proxies (error/refusal rate, latency,
  cost) and a deterministic 5% sample is LLM-judged for quality

## Sampled judging

`eval_score` for production runs arrives from a sampler workflow (every
15 min): sampled runs are scored against a generic quality rubric with your
provider key, cached, budget-capped. Judged production runs participate in
`score_drop` regression alerting.
