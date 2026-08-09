# Synthetic checks

A check is a scheduled agent run against a feature, verified by assertions.
Checks-as-code: define in `agentsre.config.json` and `agentsre deploy`.

## Anatomy

```json
{
  "featureId": "checkout",
  "name": "checkout-works",
  "prompt": "Verify a guest can complete a single-item order at checkout.",
  "target": "https://shop.example.com/checkout",
  "allowedDomains": ["shop.example.com"],
  "successCriteria": [
    { "name": "confirmed", "assertion": { "type": "exact", "expected": "Order confirmed", "field": "final" } },
    { "name": "page-fetched", "assertion": { "type": "tool_called", "tool": "fetch_url" } }
  ],
  "intervalMinutes": 15,
  "provider": "openai",
  "model": "gpt-4o-mini",
  "maxSteps": 8
}
```

## Runner

The agent runs on YOUR provider key (never ours). It loops: model call ->
tool call -> model call, capturing per-step tokens, latency, and cost.
Built-in tools: `fetch_url` (https only, allowlist enforced, 256KB cap) and
`current_datetime`. A check that trips a guardrail (refusal) scores 0.

## Assertions

- `exact` / `regex`: matched against `final`, `last_step`, or `any_step` content
- `tool_called`: the runtime-behavior assertion — was a specific tool invoked?
- `llm_judge`: rubric scored by a cached, budget-capped judge model

Overall eval score = weighted mean of criteria (refused runs cap at 0).
Each run stores `eval_score` + per-criterion components.

## Scheduling

`intervalMinutes` (5-1440). A workflow runs on cron, loads due checks, and
executes them durably (retries, 4-minute step timeout). Due = last run +
interval. Enable/disable via `PATCH /v1/checks/{id}` `{"enabled": false}`.
