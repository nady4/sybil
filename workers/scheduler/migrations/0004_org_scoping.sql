-- 0004_org_scoping.sql — baselines become org-scoped (no checks-join hack),
-- plus a table for inspectable dead-letter deliveries.

DROP TABLE IF EXISTS baselines;

CREATE TABLE IF NOT EXISTS baselines (
  org_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  model TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('night', 'morning', 'afternoon', 'evening')),
  sample_count INTEGER NOT NULL DEFAULT 0,
  p50_latency_ms REAL,
  p95_latency_ms REAL,
  p99_latency_ms REAL,
  p50_cost_usd REAL,
  p95_cost_usd REAL,
  p50_eval_score REAL,
  p95_eval_score REAL,
  refusal_rate REAL,
  error_rate REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, feature_id, model, period)
);

-- DLQ consumers write here so retry-exhausted deliveries are inspectable.
CREATE TABLE IF NOT EXISTS failed_deliveries (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  body TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_failed_deliveries_queue ON failed_deliveries(queue, created_at);
