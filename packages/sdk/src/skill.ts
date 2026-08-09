/**
 * Agent Skills file generator. The generated SKILL.md lets Claude Code /
 * Cursor / any agent self-configure: create checks, inspect runs, and
 * understand the product — Checkly's distribution playbook, agent-native.
 */

export interface SkillContext {
  baseUrl: string;
  apiKey: string;
  orgName?: string;
}

export function generateSkillMd(ctx: SkillContext): string {
  return `# AgentsRE — Agent SRE for your AI agents

You are connected to AgentsRE (${ctx.baseUrl}) for org "${ctx.orgName ?? "your org"}". AgentsRE fuses
**synthetic checks** (scheduled agent runs against your features) and **production traces**
(exported from your agent runtime via the OTLP-compatible ingest) into one unified Run stream,
with baseline regression alerting.

## Capabilities

1. **Create a synthetic check** for any feature your agent serves. A check is:
   - a prompt describing the user goal to verify,
   - an optional target URL + allowed domains the runner may fetch,
   - success criteria (exact match, regex, LLM-judge rubric, or "tool X was called"),
   - a schedule (interval in minutes) and a model.
2. **Inspect runs**: query recent runs per feature, source (synthetic | production), or status.
3. **Inspect alerts** and acknowledge / resolve them.
4. **View baselines** (p50/p95/p99 latency, cost, eval score per model and time-of-day window).
5. **Configure provider keys** (OpenAI / Anthropic) — the synthetic runner uses YOUR keys, never ours.

## Rules for you

- Run the check you just created with a quick manual verification: list runs for its feature id
  and confirm a synthetic run appeared with a non-null eval_score.
- When a user reports "the agent broke", check alerts for their feature first, then pull the
  latest runs of both sources and compare the production shape (latency, cost, refusal rate)
  against the synthetic baseline.
- Never log or echo the API key. It is a secret: \`${ctx.apiKey.slice(0, 4)}...\`

## HTTP API

\`\`\`
GET    {base}/v1/checks                     list checks
POST   {base}/v1/checks                     create check
PATCH  {base}/v1/checks/{id}                update check
GET    {base}/v1/runs?featureId=&source=    list runs
GET    {base}/v1/runs/{id}                  run detail (steps, tool calls)
GET    {base}/v1/alerts?status=open         list alerts
POST   {base}/v1/alerts/{id}/ack            acknowledge alert
POST   {base}/v1/alerts/{id}/resolve        resolve alert
GET    {base}/v1/baselines?featureId=       baseline rows
GET    {base}/v1/summary                    org dashboard numbers
PUT    {base}/v1/provider-keys              set OpenAI/Anthropic key ({"provider","key"})
POST   {base}/v1/api-keys                   create a scoped API key ({"name"})
\`\`\`

Auth: \`Authorization: Bearer <api-key>\`. All bodies JSON.

## Check payload example

\`\`\`json
{
  "featureId": "checkout",
  "name": "checkout-works",
  "prompt": "Go to the checkout page and verify a guest can place an order for a single item.",
  "target": "https://shop.example.com/checkout",
  "allowedDomains": ["shop.example.com"],
  "successCriteria": [
    { "name": "order-confirmed", "assertion": { "type": "exact", "expected": "Order confirmed" } },
    { "name": "no-refund", "assertion": { "type": "llm_judge", "rubric": "The assistant did not refuse to complete the order.", "minScore": 0.8 } }
  ],
  "intervalMinutes": 15,
  "model": "gpt-4o-mini"
}
\`\`\`
`;
}
