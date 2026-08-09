<h1 align="center">Sybil</h1>

<p align="center">
👁️ AI agent monitoring: synthetic + production checks with scheduled canary runs, tool-call tracing, and regression alerting. Built on Cloudflare Workers, Workflows, Durable Objects, D1, R2, and KV, with Next.js, Clerk, and Stripe.
</p>

<br>

## 📸 Product surfaces

> Screenshots to be added — the hosted dashboard is not deployed yet. The surfaces below are what the web app renders today.

<table>
  <tr>
    <td align="center"><em>Overview</em></td>
    <td align="center"><em>Checks</em></td>
    <td align="center"><em>Runs</em></td>
  </tr>
  <tr>
    <td><img src="" alt="Overview — org summary cards" /></td>
    <td><img src="" alt="Checks — list, toggle, delete, create form with alert channels" /></td>
    <td><img src="" alt="Runs — unified synthetic + production table with filters" /></td>
  </tr>
  <tr>
    <td align="center"><em>Alert detail + correlation</em></td>
    <td align="center"><em>Feature correlation</em></td>
    <td align="center"><em>Settings</em></td>
  </tr>
  <tr>
    <td><img src="" alt="Alert detail with production correlation panel" /></td>
    <td><img src="" alt="Synthetic vs production 24h comparison" /></td>
    <td><img src="" alt="API keys, provider keys, alert channels" /></td>
  </tr>
  <tr>
    <td align="center"><em>Run drill-down</em></td>
    <td align="center"><em>Billing</em></td>
    <td align="center"><em>Agent docs site</em></td>
  </tr>
  <tr>
    <td><img src="" alt="Run steps with tool calls and eval components" /></td>
    <td><img src="" alt="Plans, checkout, customer portal" /></td>
    <td><img src="" alt="llms.txt + agent-optimized docs" /></td>
  </tr>
</table>

<br>

## 🌐 Live demo

- **URL:** not deployed yet — this repo runs fully locally (see [Getting started](#-getting-started)). Deployment to Cloudflare (5 Workers + D1/KV/R2/Queues) is the next step.
- All product flows are exercised by a local test suite that runs **inside the actual Workers runtime** (141 tests), plus mock OpenAI / Clerk / Stripe servers for the full end-to-end loops.

<br>

## ✨ Features

### 🤖 Synthetic checks (the agentic canary)

- **Checks-as-code** — define checks in `agentsre.config.json` / TypeScript and deploy via the CLI or API. A check is a prompt, an optional target URL + allowed domains, success criteria, a schedule, and a model.
- **Agent runtime, not browser runtime** — each check runs a real tool-calling agent loop (`fetch_url` with host allowlists and size caps, `current_datetime`) on **your** provider key, capturing per-step tokens, latency, cost, and refusals — the runtime-behavior signal Checkly-style browser checks never see.
- **Assertions engine** — exact-match, regex (over final / last-step / any-step content), `tool_called` (the runtime-behavior assertion), and LLM-judge rubrics with a cached, budget-capped judge. Refused runs cap at 0.
- **Auth'd targets** — static request headers per check, **encrypted at rest**, write-only, decrypted only inside the execution step. Prompts can never inject them.
- **Durable scheduling** — a Workflows instance on cron loads due checks and executes each durably (retries, step timeouts); `POST /internal/run-check` forces a specific check regardless of schedule (ops).
- **Auto cost capture** — tokens are converted to USD via a maintained LiteLLM-style pricing table (versioned aliases, reasoning-token billing), stored on every Run from day one.

### 📡 Production ingest (the drop-in story)

- **Unified envelope** (`POST /v1/traces`) — one trace = one Run; tokens/cost auto-computed server-side when omitted; `trace.redactionRules` enforced on stored content.
- **OTLP** (`POST /v1/otlp`) — GenAI semantic conventions (`gen_ai.response.model`, usage tokens, error type).
- **Langfuse drop-in** — the real `langfuse-js` SDK works with `baseUrl` pointed at the ingest worker: full `/api/public/ingestion` batch protocol including the SDK's split-event batching (trace-create and observations may arrive in separate requests — assembled per trace server-side in KV).
- **`AgentsReExporter` in `@agentsre/sdk`** — zero-dependency capture layer for your agent runtime: `capture()` wraps any LLM call, `observe()` records steps, batches flush per trace with a 5s / 50-obs fallback, retries transient failures, never throws into your agent loop.
- **Limits & delivery** — per-org token-bucket burst limiter (Durable Object), per-plan daily caps, queue → batched D1 writes, org-prefixed deterministic run ids (`prod_<orgHash>_<traceId>`) so queue retries stay idempotent and no cross-org PK collisions exist.

### 🚨 Alerting (baselines, not thresholds)

- **Percentile baselines** per (org, feature, model, season period) — UTC hour buckets (night / morning / afternoon / evening) so business-hours traffic doesn't trip night thresholds.
- **Decimated reference ring** — baselines are computed from a 1-in-3 decimated ring and persisted every 20 samples, so a short burst of spike runs can never hijack the very baseline it is confirmed against.
- **Regression policy** — latency vs max(p99, 1.5×p95, 2s floor), eval-score drops, cost spikes, refusal spikes, error-rate spikes — with **2-of-3 confirmation**, **15-minute suppression**, and **auto-resolve after 3 clean runs**.
- **Channels** — Slack webhook, PagerDuty Events v2, generic webhook, Resend email; dispatch is queue-based with retries and a dead-letter table you can inspect.
- **Sampled judge scoring** — production runs have no ground truth: a deterministic 5% sample (per-org rate) is LLM-judged against a generic quality rubric with your provider key, budget-capped and cached, so the production half participates in quality regression alerting.
- **Self-monitoring** — the platform watches itself: a monitor workflow checks DLQ depth, retention backlog, judge-budget exhaustion, org daily caps, and error spikes, and raises operator alerts (feature `platform`) with 30-minute suppression.

### 🔀 Correlation (the fused view)

- `GET /v1/features/:id/correlation` — synthetic stats (pass rate, avg eval, cost) and production shape (error/refusal rates, p50/p95 latency, judged avg eval) side by side, plus the **last-15-minutes table** — the "is the canary failing because production is failing?" answer in one screen.
- The alert detail page embeds the correlation panel; every run/alert links to its feature.

### 🛠️ SDK & CLI

- **`@agentsre/sdk`** — typed client for every endpoint, `deployCheck()` (idempotent upsert), and the `AgentsReExporter`.
- **`agentsre` CLI** (distributed as a self-contained esbuild bundle — `npx agentsre`): `init`, `login`, `deploy`, `status`, `runs`, `alerts`, `import-helicone` (one-shot JSONL/CSV Helicone migration with dedupe + concurrency), and `skill` (prints the Agent Skills file that self-configures Claude Code / Cursor).

### 💳 Billing

- Hobby (free) / Indie $39 / Team $149 / Enterprise $499+ with per-plan limits (checks, runs/day, judge budget).
- Stripe checkout + customer portal; signature-verified webhooks drive plan changes (`checkout.session.completed`, `subscription.updated/deleted`).
- **Metered usage** — a nightly workflow reports the prior day's run count to a Stripe Billing Meter (`agent_runs`).

### 🔐 Auth

- **API keys** for SDK/CLI/ingest — SHA-256 hashed at rest, prefix-displayed, revocable, creatable from the web Settings page (shown once).
- **Clerk web sessions** — Svix-signed webhooks provision orgs and user mappings; RS256 session JWTs are verified against a KV-cached JWKS and resolved to the org (auto-provisioning). Env-gated in the web app with an inline setup guide until keys are configured.
- **Bootstrap** — `POST /v1/setup` with the bootstrap token creates the first org + key.

### 🧑‍💼 Operations

- **Admin API** (`x-admin-token`): platform health census, per-org usage, DLQ inspection, forced check runs, forced monitor passes.
- **`GET /v1/features/costs`** — per-feature, per-source run counts and cost (the first read for the FinOps story).
- **Retention pipeline** — runs' raw steps are archived to R2 after 30 days and truncated from D1; R2 objects and run rows are purged after 90 days; the API serves archived steps via `/v1/runs/:id/raw`.
- **Dead-letter handling** — retry-exhausted queue messages land in `failed_deliveries` for inspection instead of vanishing.

### 🌐 Web dashboard & docs

- Overview cards, checks (toggle/delete + create form with alert-channel binding), runs with filters, alerts with ack/resolve, alert detail + correlation, feature pages, run drill-down (steps, tool calls, eval components), billing, settings (API keys, provider keys, alert channels).
- **Agent-facing docs site** (Workers static assets) — `/llms.txt` plus agent-optimized markdown pages for checks, ingest, alerting, API/SDK, billing, migration, and operations.

<br>

## 🛠️ Tech stack

| Area                    | Technology                                                                   |
| ----------------------- | ---------------------------------------------------------------------------- |
| Runtime                 | Cloudflare Workers (5 workers)                                                |
| Orchestration           | Cloudflare Workflows + Durable Objects (coordinator, rate limiter)           |
| Storage                 | D1 (SQLite) + KV + R2 + Queues                                                |
| Web app                 | Next.js 15 (App Router, server components)                                    |
| Language                | TypeScript (strict)                                                           |
| Validation              | `zod`                                                                         |
| Agent runtime           | Raw tool-calling loop (no SDK deps) — OpenAI / Anthropic / Bedrock (AWS SigV4)|
| Auth                    | API keys + Clerk (JWT + Svix webhooks)                                        |
| Billing                 | Stripe (checkout, portal, Billing Meter)                                      |
| Compatibility           | OTLP gen_ai conventions + Langfuse ingestion protocol (`langfuse-js` verified)|
| CLI distribution        | esbuild single-file bundle (`npx agentsre`)                                   |
| Tests                   | Vitest + `@cloudflare/vitest-pool-workers` (tests run inside workerd)         |
| Package manager         | pnpm (workspaces)                                                             |
| CI                      | GitHub Actions (typecheck + full test matrix)                                 |
| Dev doubles             | Mock OpenAI / Clerk / Stripe servers under `scripts/`                         |

<br>

## 🏗️ Architecture

```
sybil/
├── packages/
│   ├── shared/            # Unified Run model, pricing table, baseline math,
│   │                      # envelope/OTLP/Langfuse normalizers, redaction,
│   │                      # AES-GCM crypto, Svix/Stripe/Clerk verification
│   ├── runtime/           # Agent loop, providers (OpenAI/Anthropic/Bedrock SigV4),
│   │                      # tools (fetch_url, current_datetime), assertions, judge
│   └── sdk/               # Typed client, AgentsReExporter, Agent-Skills generator
├── workers/
│   ├── scheduler/         # Cron → Workflows: synthetic runner, judge sampler,
│   │                      # usage reporter, retention (R2), monitor (self-alerting),
│   │                      # FeatureCoordinator DO (baselines/alerts), OrgRateLimiter DO,
│   │                      # D1 migrations 0001–0006
│   ├── ingest/            # /v1/traces, /v1/otlp, /api/public/trace,
│   │                      # /api/public/ingestion (KV cross-request assembly),
│   │                      # auth, burst + daily caps, queue consumer
│   ├── api/               # REST surface, Clerk webhooks + JWT, Stripe billing,
│   │                      # correlation, costs, admin endpoints, R2 raw archive
│   ├── alerts/            # Queue consumer → Slack / PagerDuty / webhook / Resend
│   └── docs/              # Static agent docs + /llms.txt
├── apps/
│   └── web/               # Next.js dashboard (Overview, Checks, Runs, Alerts,
│                          # Features, Billing, Settings, sign-in)
├── cli/                   # `agentsre` — bundled single-file CLI
├── scripts/               # mock-openai / mock-clerk / mock-stripe dev servers
└── .github/workflows/     # CI
```

### 🔍 Notable implementation details

- **The unified `Run` is the #1 bridge** — synthetic and production writes share one row shape with `cost_usd` captured from day one. The FinOps product later reads the same schema; no re-architecture.
- **Baselines resist their own spikes** — regression detection compares against the persisted baseline (refreshed every 20 *decimated* samples from a 1-in-3 reference ring), never the live ring, so the 2-of-3 confirmation can't be defeated by the first slow run raising p99 above itself.
- **Idempotency by construction** — org-prefixed run ids + `INSERT OR IGNORE` make queue retries and re-ingested traces safe; the Langfuse split-event assembly emits once per complete trace and deletes its KV state.
- **Secrets never touch the DB in plaintext** — provider keys and check headers are AES-256-GCM encrypted with a per-deployment `KEYS_ENC_KEY`, decrypted only inside the relevant Workflow step.
- **Bedrock works without the AWS SDK** — SigV4 signing is implemented in Web Crypto and verified against AWS's official test-suite vectors; the Anthropic-format body/response handling is shared between the Anthropic API and Bedrock `InvokeModel`.
- **Tests run in the real runtime** — `@cloudflare/vitest-pool-workers` executes the coordinator DO, the synthetic runner (against a live mock OpenAI server booted by a Node-side global setup), the retention pipeline (R2 round-trip), the Langfuse SDK drop-in, and the ingest/API workers — 141 tests, all local, no network.
- **The platform observes itself** — the Workflow binding has no instance-list API, so monitor signals (DLQ depth, retention backlog, judge budgets, daily caps, error spikes) are all D1/KV-computable by design.
- **One queue, two roles** — queue consumers branch on `batch.queue` to also drain the DLQs into the `failed_deliveries` table.

<br>

## 🚀 Getting started

### 📋 Prerequisites

- [Node.js](https://nodejs.org) 22+
- [pnpm](https://pnpm.io) 11+
- A [Cloudflare account](https://dash.cloudflare.com) for `wrangler` (only needed for deploy; local dev runs without one)

### 📦 Installation

```sh
git clone <repo-url> && cd sybil
pnpm install
```

### 🔑 Local environment

Each worker reads its own `.dev.vars`. The dev values are already committed for local development:

- `workers/scheduler/.dev.vars` — `KEYS_ENC_KEY` (hex 32-byte AES key), `ADMIN_TOKEN`, `OPENAI_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_API_URL`
- `workers/api/.dev.vars` — the above plus `BOOTSTRAP_KEY`, Clerk (`CLERK_JWKS_URL`, `CLERK_WEBHOOK_SECRET`), Stripe webhook + prices, `ADMIN_TOKEN`
- `workers/ingest/.dev.vars`, `workers/alerts/.dev.vars` — empty (no secrets needed)

For a production deploy, set these as `wrangler secret put` values instead (never commit real secrets).

### 💻 Run the local stack

**1. Start the mock third-party servers** (one terminal each):

```sh
node scripts/mock-openai.mjs   # :8786 — OpenAI-compatible chat + /page + /echo
node scripts/mock-clerk.mjs    # :8785 — JWKS, JWT issuance, Svix signing
node scripts/mock-stripe.mjs   # :8784 — customers, checkout, portal, meter events
```

**2. Apply migrations and start the workers** — all four share one local state directory so D1/KV/DOs/R2 are visible to every worker:

```sh
cd workers/scheduler
npx wrangler d1 migrations apply agentsre --local --persist-to /tmp/agentsre-state

# one terminal per worker (each from its own directory)
cd workers/scheduler && npx wrangler dev --port 8787 --persist-to /tmp/agentsre-state
cd workers/api       && npx wrangler dev --port 8788 --persist-to /tmp/agentsre-state
cd workers/ingest    && npx wrangler dev --port 8789 --persist-to /tmp/agentsre-state
cd workers/alerts    && npx wrangler dev --port 8790 --persist-to /tmp/agentsre-state
```

> The scheduler is the migration owner; the others share its `migrations_dir`.

**3. Bootstrap an org and create your first check:**

```sh
curl -s -X POST http://localhost:8788/v1/setup \
  -H "content-type: application/json" -H "x-bootstrap-token: dev-bootstrap" \
  -d '{"orgName":"My Org","plan":"indie"}'        # -> { apiKey, orgId }

curl -s -X PUT http://localhost:8788/v1/provider-keys \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" \
  -d '{"provider":"openai","key":"mock"}'

curl -s -X POST http://localhost:8788/v1/checks \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" \
  -d '{"featureId":"checkout","name":"checkout-works","prompt":"Verify a guest can complete an order.",
       "target":"http://localhost:8786/page","allowedDomains":["localhost"],
       "successCriteria":[{"name":"confirmed","assertion":{"type":"exact","expected":"confirmed","field":"final"}}],
       "intervalMinutes":5,"model":"gpt-4o-mini"}'

# run it now (bypass the schedule):
curl -s -X POST http://localhost:8787/internal/run-check \
  -H "content-type: application/json" -H "x-admin-token: dev-admin-token" \
  -d '{"checkId":"<the check id>"}'
```

With the mock provider, the agent fetches the page, asserts pass, and a synthetic Run with computed cost appears in `GET /v1/runs`.

**4. Production telemetry, three ways:**

```sh
# Envelope
curl -s -X POST http://localhost:8789/v1/traces \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" \
  -d '{"trace":{"id":"t1","featureId":"support"},"observations":[
        {"model":"gpt-4o-mini","inputTokens":100,"outputTokens":50,"latencyMs":700,
         "input":"hi","output":"hello"}]}'

# or the exporter (SDK)
# or a Langfuse SDK pointed at baseUrl http://localhost:8789 (publicKey = your API key)
```

**5. Web dashboard:**

```sh
cd apps/web
AGENTSRE_API_URL=http://localhost:8788 AGENTSRE_API_KEY=$KEY pnpm dev   # http://localhost:3000
```

### 🧪 Tests

```sh
pnpm typecheck    # strict TS across all packages + workers
pnpm test         # 141 tests — unit + workerd-runtime pool tests + dev-stack E2E
```

Dev-stack-dependent E2E tests (Helicone import, Langfuse SDK) skip automatically when the local stack isn't running.

### 🏗️ Deploy

```sh
pnpm verify       # dry-run deploys for all 5 workers
# per worker: cd workers/<name> && npx wrangler deploy
```

Before the first deploy: `wrangler d1 create` / `wrangler kv namespace create` / `wrangler r2 bucket create agentsre-runs` / `wrangler queues create` (or rely on auto-provisioning by omitting ids), set secrets (`KEYS_ENC_KEY`, `ADMIN_TOKEN`, `BOOTSTRAP_KEY`, Clerk + Stripe keys), apply migrations with `--remote`, and configure the Clerk webhook to `https://<api-host>/v1/auth/clerk-webhook`.

<br>

## 📜 Scripts

| Command            | Description                                      |
| ------------------ | ------------------------------------------------ |
| `pnpm typecheck`   | Strict typecheck across all packages and workers |
| `pnpm test`        | Full test matrix (141 tests)                     |
| `pnpm dev:web`     | Next.js dashboard on :3000                       |
| `pnpm verify`      | `wrangler deploy --dry-run` for all 5 workers    |
| `pnpm deploy`      | Deploy all workers (when configured)             |
| `pnpm --filter agentsre build` | Bundle the CLI into `cli/dist/index.mjs`  |

<br>

## 📝 Notes

- **Local dev quirks** — cross-worker queue delivery is not simulated locally (the alerts worker won't receive messages from the scheduler's local queue); the ingest consumer is exercised by pool tests instead. All workers must share `--persist-to` or they see separate D1/KV/DO state.
- **Seasonality is UTC-based** — baseline periods use UTC hour buckets; per-org timezone support is a planned follow-up.
- **Regions are informational** in V1 (the runner executes from one region); multi-region routing is documented as a future enhancement.
- **Retention defaults** are 30 days raw → R2, 90 days purge; tune via `RETENTION_DAYS_RAW` / `RETENTION_DAYS_PURGE`.
- **Bedrock** credentials are a JSON provider key (`{"accessKeyId","secretAccessKey","region"}`); the SigV4 path is verified against AWS test vectors but not against a live account.
- **Clerk / Stripe / real model providers** are verified end-to-end against mocks; production verification needs real keys (deployment step).
- The synthetic runner executes agent checks on **customer** provider keys; the only vendor-paid LLM is the cached, budget-capped judge.

<br>

## 📬 Contact

### 💌 Email: **dev@nady4.com**

### 💼 LinkedIn: [nady4](https://www.linkedin.com/in/nady4)

### 👩🏻‍💻 GitHub: [@nady4](https://github.com/nady4)
