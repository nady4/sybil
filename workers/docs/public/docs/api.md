# SDK and API

REST API base: `https://api.agentsre.dev` (dev: localhost:8788).
Auth: `Authorization: Bearer <api-key>`. Create keys via
`POST /v1/api-keys` or `agentsre login`.

## Endpoints

```
GET    /v1/checks?featureId=            list checks
POST   /v1/checks                       create check
GET    /v1/checks/{id}                  check detail
PATCH  /v1/checks/{id}                  update (partial)
DELETE /v1/checks/{id}                  delete

GET    /v1/runs?featureId=&source=&status=&limit=   list runs
GET    /v1/runs/{id}                    run detail (steps, tool calls, eval)

GET    /v1/alerts?status=               list alerts
GET    /v1/alerts/{id}                  alert detail
POST   /v1/alerts/{id}/ack              acknowledge
POST   /v1/alerts/{id}/resolve          resolve

GET    /v1/features/{featureId}/correlation   fused synthetic+production view
GET    /v1/baselines?featureId=         baseline rows
GET    /v1/summary                      org dashboard numbers

PUT    /v1/provider-keys                set OpenAI/Anthropic key
GET    /v1/provider-keys                configured providers (never the keys)
GET/POST /v1/alert-channels             alert delivery channels
GET/POST /v1/api-keys                   API key management

GET    /v1/billing                      plan + limits
POST   /v1/billing/checkout             Stripe checkout session
POST   /v1/billing/portal               Stripe customer portal
```

## SDK

`@agentsre/sdk`: `new Client({ baseUrl, apiKey })` with typed methods for
every endpoint, plus `deployCheck()` (idempotent upsert by
featureId+name) — checks-as-code.

## CLI

```
agentsre init     scaffold agentsre.config.json
agentsre login    store API key
agentsre deploy   upsert checks from config
agentsre status   org summary + checks
agentsre runs     recent runs
agentsre alerts   open alerts
agentsre import-helicone <file> [--feature <id>]
agentsre skill    print the Agent Skills file (Claude Code / Cursor)
```

## Agent Skills

`agentsre skill` emits a SKILL.md that self-configures Claude Code /
Cursor: create checks, correlate failures, acknowledge alerts, and never
leak the API key. The docs site (`/llms.txt`) serves the same intent for
web-browsing agents.
