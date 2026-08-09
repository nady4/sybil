-- 0005_platform_alerts.sql — allow 'platform' alert type (self-monitoring).

DROP TABLE IF EXISTS alerts;

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  model TEXT,
  type TEXT NOT NULL CHECK (type IN ('latency', 'score_drop', 'refusal_spike', 'cost_spike', 'error_rate', 'platform')),
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
