/**
 * Core domain types for AgentsRE.
 *
 * The unified `Run` is the shared primitive between the synthetic and
 * production halves of the product. Cost fields exist from day one on
 * purpose: the FinOps product (#1) reads the same schema.
 */

export type RunSource = "synthetic" | "production";
export type RunStatus = "success" | "failed" | "error" | "refused";
export type ModelProvider = "openai" | "anthropic" | "bedrock";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface ToolCallEvent {
  name: string;
  input: unknown;
  output: unknown;
  latencyMs?: number;
  error?: string;
}

export interface AgentStep {
  index: number;
  model: string;
  latencyMs: number;
  usage: Usage;
  costUsd?: number;
  toolCalls: ToolCallEvent[];
  refused: boolean;
  content?: string;
}

/** One execution of a check, or one production request from an agent. */
export interface Run {
  id: string;
  orgId: string;
  featureId: string;
  tenantId?: string;
  source: RunSource;
  agentId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  status: RunStatus;
  errorType?: string;
  guardrailTripped: boolean;
  evalScore?: number;
  evalScoreComponents?: Record<string, number>;
  /** Per-step breakdown. For synthetic runs this is the agent loop; for production it is the exported observations. */
  steps?: AgentStep[];
  /** Free-form: proxies for production runs, check metadata for synthetic runs, etc. */
  meta?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export type SeasonPeriod = "night" | "morning" | "afternoon" | "evening";

export interface Baseline {
  featureId: string;
  model: string;
  period: SeasonPeriod;
  sampleCount: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;
  p50CostUsd?: number;
  p95CostUsd?: number;
  p50EvalScore?: number;
  p95EvalScore?: number;
  refusalRate?: number;
  errorRate?: number;
  updatedAt: string;
}

export type AlertType =
  | "latency"
  | "score_drop"
  | "refusal_spike"
  | "cost_spike"
  | "error_rate"
  | "platform";

export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: string;
  orgId: string;
  featureId: string;
  model?: string;
  type: AlertType;
  severity: "warning" | "critical";
  message: string;
  status: AlertStatus;
  runId?: string;
  openedAt: string;
  resolvedAt?: string;
}

export type Assertion =
  | { type: "exact"; expected: string; field?: "final" | "last_step" | "any_step" }
  | { type: "regex"; pattern: string; field?: "final" | "last_step" | "any_step" }
  | { type: "llm_judge"; rubric: string; minScore: number }
  | { type: "tool_called"; tool: string };

export interface SuccessCriterion {
  name?: string;
  assertion: Assertion;
  /** 0-1, defaults to 1. Overall eval score is the weighted mean of passing criteria. */
  weight?: number;
}

export interface Check {
  id: string;
  orgId: string;
  featureId: string;
  name: string;
  description?: string;
  prompt: string;
  system?: string;
  /** Base URL the agent is allowed to explore. */
  target?: string;
  allowedDomains?: string[];
  successCriteria: SuccessCriterion[];
  intervalMinutes: number;
  /** Informational in V1: runner executes at the edge PoP, region routing is best-effort. */
  regions?: string[];
  provider: ModelProvider;
  model: string;
  maxSteps: number;
  maxOutputTokens: number;
  redactionRules?: string[];
  alertChannelIds: string[];
  /**
   * Request headers sent by fetch_url to the target (write-only: encrypted
   * at rest, never returned by the API). Prompts cannot inject headers.
   */
  headers?: Record<string, string>;
  /** Internal: AES ciphertext of headers as stored in D1. */
  headersCipher?: string;
  enabled: boolean;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type AlertChannelType = "slack_webhook" | "pagerduty" | "webhook" | "email_resend";

export interface AlertChannel {
  id: string;
  orgId: string;
  name: string;
  type: AlertChannelType;
  /** url / serviceKey / from+to+apiKey depending on type. */
  config: Record<string, string>;
  enabled: boolean;
  createdAt: string;
}

export interface ProviderKeyRow {
  orgId: string;
  provider: ModelProvider;
  label: string;
  /** AES-256-GCM ciphertext (base64 iv + ct). */
  keyCiphertext: string;
  createdAt: string;
}

export interface Org {
  id: string;
  name: string;
  plan: "hobby" | "indie" | "team" | "enterprise";
  limits: {
    maxChecks: number;
    maxRunsPerDay: number;
    judgeDailyBudgetUsd: number;
  };
  createdAt: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

export const PLAN_LIMITS: Record<Org["plan"], Org["limits"]> = {
  hobby: { maxChecks: 3, maxRunsPerDay: 300, judgeDailyBudgetUsd: 0.5 },
  indie: { maxChecks: 25, maxRunsPerDay: 2500, judgeDailyBudgetUsd: 1 },
  team: { maxChecks: 100, maxRunsPerDay: 10000, judgeDailyBudgetUsd: 3 },
  enterprise: { maxChecks: 1000, maxRunsPerDay: 100000, judgeDailyBudgetUsd: 10 },
};

/** Production-run proxies: the no-ground-truth signal set for the production half. */
export interface RunProxies {
  errorRate?: number;
  refusalRate?: number;
  retryRate?: number;
  stepsToComplete?: number;
  toolFailureRate?: number;
  [k: string]: unknown;
}

export interface RunSummary {
  run: Run;
  proxies?: RunProxies;
}

/** Internal message written to the alerts queue by the coordinator. */
export interface AlertDispatchMessage {
  alertId: string;
  orgId: string;
  featureId: string;
  model?: string;
  type: AlertType;
  severity: "warning" | "critical";
  message: string;
  runId?: string;
  openedAt: string;
  status: AlertStatus;
  channels: AlertChannel[];
}

/** Summary of one completed run, forwarded to the FeatureCoordinator DO. */
export interface RunEvent {
  runId: string;
  orgId: string;
  featureId: string;
  model: string;
  latencyMs?: number;
  costUsd?: number;
  evalScore?: number;
  status: RunStatus;
  completedAt: string;
}
