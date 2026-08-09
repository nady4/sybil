-- 0003_billing.sql — Stripe billing columns + metered usage tracking.

ALTER TABLE orgs ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE orgs ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE orgs ADD COLUMN stripe_price_id TEXT;

-- Usage metering for Stripe Billing Meter (billed per period).
CREATE TABLE IF NOT EXISTS usage_periods (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  reported INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, period_start)
);
