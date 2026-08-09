-- 0002_telemetry.sql — the unified Run model (synthetic + production),
-- tool calls, eval scores, baselines, alerts. Cost fields exist from day
-- one on purpose: the FinOps product (#1) reads the same rows.

-- One execution of a check OR one production request from an agent.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  tenant_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('synthetic', 'production')),
  agent_id TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'error', 'refused')),
  error_type TEXT,
  guardrail_tripped INTEGER NOT NULL DEFAULT 0,
  eval_score REAL,
  eval_score_components TEXT,
  steps_json TEXT,
  meta_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_org_time ON runs(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_feature_time ON runs(feature_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- Normalized tool calls (redacted payloads only).
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  tool_output TEXT,
  latency_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);

-- Rolling per-(feature, model, season period) baselines.
CREATE TABLE IF NOT EXISTS baselines (
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
  PRIMARY KEY (feature_id, model, period)
);

-- Alerts: fired by the FeatureCoordinator, dispatched by the alerts worker.
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  model TEXT,
  type TEXT NOT NULL CHECK (type IN ('latency', 'score_drop', 'refusal_spike', 'cost_spike', 'error_rate')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  run_id TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_org_status ON alerts(org_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_feature_time ON alerts(feature_id, opened_at DESC);

-- Finance Pack (#1) staging: provider invoice snapshots reconciled against runs.
CREATE TABLE IF NOT EXISTS invoice_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_usd REAL NOT NULL,
  raw_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'discrepancy')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_snapshots_org ON invoice_snapshots(org_id, period_start);
