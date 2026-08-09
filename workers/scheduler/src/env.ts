import type { AlertChannel } from "@agentsre/shared";
import type { FeatureCoordinator, OrgRateLimiter } from "./coordinator.js";
import type { AlertDispatchMessage, RunEvent } from "./types.js";
import type { SchedulerWorkflow } from "./workflow.js";

export interface Env {
  DB: D1Database;
  SCHEDULER: Workflow<{ tick?: string; checkId?: string }>;
  SAMPLER: Workflow<{ tick?: string }>;
  USAGE_REPORTER: Workflow<{ tick?: string }>;
  RETENTION_WORKFLOW: Workflow<{ tick?: string }>;
  MONITOR_WORKFLOW: Workflow<{ tick?: string }>;
  FEATURE_COORDINATOR: DurableObjectNamespace<FeatureCoordinator>;
  ORG_RATE_LIMITER: DurableObjectNamespace<OrgRateLimiter>;
  ALERTS_QUEUE: Queue<AlertDispatchMessage>;
  JUDGE_CACHE: KVNamespace;
  RUNS_BUCKET: R2Bucket;
  /** Hex-encoded 32-byte AES-GCM key for customer provider keys. */
  KEYS_ENC_KEY: string;
  JUDGE_MODEL: string;
  ADMIN_TOKEN: string;
  /** Base URL overrides for self-hosted gateways / local tests. */
  OPENAI_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  /** Stripe metered usage (optional). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_API_URL?: string;
  /** Retention window in days (defaults 30/90). */
  RETENTION_DAYS_RAW?: string;
  RETENTION_DAYS_PURGE?: string;
  /** Platform self-monitoring: operator alert channel JSON {type, config}. */
  OPERATOR_CHANNEL?: string;
  OPERATOR_ORG?: string;
}

export type { FeatureCoordinator, OrgRateLimiter } from "./coordinator.js";
export type { SchedulerWorkflow } from "./workflow.js";
export type { SamplerWorkflow } from "./sampler.js";
export type { UsageReporterWorkflow } from "./usage.js";
export type { RetentionWorkflow } from "./retention.js";
export type { MonitorWorkflow } from "./monitor.js";
export type { AlertDispatchMessage, RunEvent } from "./types.js";
export type { AlertChannel };
