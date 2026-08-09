# Alerting

Baselines, regression detection, and delivery.

## Baselines

Rolling percentiles per (feature, model, season period). Season periods
are UTC hour buckets (night/morning/afternoon/evening) so business-hours
traffic doesn't trip night thresholds. Rows persist every 20 samples;
detection arms at 20 samples.

## Regression policy

Each run is compared against its baseline EXCLUDING itself:

- `latency`: run > max(p99, p95 * 1.5, 2000ms floor)
- `score_drop`: eval < 0.6 and eval < baseline p50 - 0.15
- `cost_spike`: cost > max(p95 * 2, $0.50)
- `refusal_spike` / `error_rate`: any refusal/error against a zero baseline

Confirmation: 2 of the last 3 runs must regress. Suppression: max one alert
per type per feature per 15 minutes. Auto-resolve: 3 consecutive clean runs
per type.

## Channels

Org-level channels (Slack webhook, PagerDuty Events v2, generic webhook,
Resend email) created via `POST /v1/alert-channels`. Alerts are dispatched
from a queue consumer with retries; `delivered_at` is stamped on success.

## Correlation

The fused view (`GET /v1/features/{featureId}/correlation`) shows synthetic
and production shape side by side, plus the last-15-minutes table — the
"is the canary failing because production is failing?" answer in one screen.
