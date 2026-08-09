# Operations

The product monitors itself. Platform signals are checked every 5 minutes
by the monitor workflow and raised as operator alerts (feature id
`platform`), suppressed per signal for 30 minutes:

- **DLQ depth** — retry-exhausted deliveries since the last check
- **Retention backlog** — `steps_json` older than the 30-day window still in D1
- **Judge budget** — orgs at their daily LLM-judge cap (sampled scoring skipping)
- **Daily caps** — orgs at their plan's run limit (ingest returning 429)
- **Error spike** — more than 50 error/failed runs in 5 minutes

Configure operator delivery with two env vars on the scheduler:

```
OPERATOR_ORG=org_operator           # alert rows land in this org
OPERATOR_CHANNEL={"type":"slack_webhook","config":{"url":"https://hooks.slack.com/..."}}
```

The operator channel reuses the alerts worker's retryable dispatch.

## Admin API

All admin endpoints require `x-admin-token: <ADMIN_TOKEN>`:

```
GET  /internal/admin/health               platform census + backlog
GET  /internal/admin/orgs                 org plan / usage / revenue signals
GET  /internal/admin/failed-deliveries    DLQ inspection
POST <scheduler>/internal/run-check       {checkId} -> run one check now
POST <scheduler>/internal/tick-monitor    force a monitor pass
```

## Cost by feature

`GET /v1/features/costs?days=30` (org API key) returns per-feature,
per-source run counts and cost — the first read for the FinOps story.
