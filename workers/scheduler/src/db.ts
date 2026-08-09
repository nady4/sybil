import type { AlertChannel, Check, Org, Run } from "@agentsre/shared";
import { PLAN_LIMITS } from "@agentsre/shared";
import type { Env } from "./env.js";

export interface CheckRow {
  id: string;
  org_id: string;
  feature_id: string;
  name: string;
  description: string | null;
  prompt: string;
  system: string | null;
  target: string | null;
  allowed_domains: string | null;
  success_criteria: string;
  interval_minutes: number;
  regions: string | null;
  provider: "openai" | "anthropic" | "bedrock";
  model: string;
  max_steps: number;
  max_output_tokens: number;
  redaction_rules: string | null;
  alert_channel_ids: string | null;
  target_headers: string | null;
  enabled: number;
  last_run_at: string | null;
}

function jsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function mapCheckRow(row: CheckRow): Check {
  return {
    id: row.id,
    orgId: row.org_id,
    featureId: row.feature_id,
    name: row.name,
    description: row.description ?? undefined,
    prompt: row.prompt,
    system: row.system ?? undefined,
    target: row.target ?? undefined,
    allowedDomains: jsonArray<string>(row.allowed_domains),
    successCriteria: jsonArray(row.success_criteria),
    intervalMinutes: row.interval_minutes,
    regions: jsonArray<string>(row.regions),
    provider: row.provider,
    model: row.model,
    maxSteps: row.max_steps,
    maxOutputTokens: row.max_output_tokens,
    redactionRules: jsonArray<string>(row.redaction_rules),
    alertChannelIds: jsonArray<string>(row.alert_channel_ids),
    headersCipher: row.target_headers ?? undefined,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: "",
    updatedAt: "",
  };
}

export async function loadDueChecks(env: Env, now: Date, cap = 25): Promise<Check[]> {
  const res = await env.DB.prepare("SELECT * FROM checks WHERE enabled = 1").all<CheckRow>();
  const nowMs = now.getTime();
  const due: Check[] = [];
  for (const row of res.results) {
    const check = mapCheckRow(row);
    const dueMs = check.lastRunAt ? new Date(check.lastRunAt).getTime() + check.intervalMinutes * 60_000 : 0;
    if (nowMs >= dueMs) due.push(check);
    if (due.length >= cap) break;
  }
  return due;
}

export async function getOrg(env: Env, orgId: string): Promise<Org | undefined> {
  const res = await env.DB.prepare("SELECT id, name, plan, created_at FROM orgs WHERE id = ?").bind(orgId).first<{
    id: string;
    name: string;
    plan: Org["plan"];
    created_at: string;
  }>();
  if (!res) return undefined;
  return { id: res.id, name: res.name, plan: res.plan, limits: PLAN_LIMITS[res.plan], createdAt: res.created_at };
}

export async function getProviderKey(env: Env, orgId: string, provider: string): Promise<string | undefined> {
  const row = await env.DB.prepare(
    "SELECT key_ciphertext FROM provider_keys WHERE org_id = ? AND provider = ?",
  ).bind(orgId, provider).first<{ key_ciphertext: string }>();
  return row?.key_ciphertext;
}

export async function loadAlertChannels(env: Env, orgId: string, channelIds: string[]): Promise<AlertChannel[]> {
  if (channelIds.length === 0) return [];
  const placeholders = channelIds.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT id, org_id, name, type, config, enabled, created_at FROM alert_channels
     WHERE org_id = ? AND id IN (${placeholders}) AND enabled = 1`,
  )
    .bind(orgId, ...channelIds)
    .all<{ id: string; org_id: string; name: string; type: AlertChannel["type"]; config: string; enabled: number; created_at: string }>();
  return res.results.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    type: r.type,
    config: JSON.parse(r.config) as Record<string, string>,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  }));
}

export async function persistRun(
  env: Env,
  check: Check,
  run: Run,
  completedAt: string,
): Promise<void> {
  const tx: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR REPLACE INTO runs
       (id, org_id, feature_id, tenant_id, source, agent_id, model, input_tokens, output_tokens,
        reasoning_tokens, cost_usd, latency_ms, status, error_type, guardrail_tripped, eval_score,
        eval_score_components, steps_json, meta_json, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      run.id,
      run.orgId,
      run.featureId,
      run.tenantId ?? null,
      run.source,
      run.agentId ?? null,
      run.model ?? null,
      run.inputTokens ?? null,
      run.outputTokens ?? null,
      run.reasoningTokens ?? null,
      run.costUsd ?? null,
      run.latencyMs ?? null,
      run.status,
      run.errorType ?? null,
      run.guardrailTripped ? 1 : 0,
      run.evalScore ?? null,
      run.evalScoreComponents ? JSON.stringify(run.evalScoreComponents) : null,
      run.steps ? JSON.stringify(run.steps) : null,
      run.meta ? JSON.stringify(run.meta) : null,
      run.startedAt,
      run.completedAt,
    ),
    env.DB.prepare("UPDATE checks SET last_run_at = ? WHERE id = ?").bind(completedAt, check.id),
  ];
  if (run.steps) {
    for (const step of run.steps) {
      for (const tc of step.toolCalls) {
        tx.push(
          env.DB.prepare(
            `INSERT INTO tool_calls (id, run_id, step_index, tool_name, tool_input, tool_output, latency_ms, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `${run.id}_tc_${step.index}`,
            run.id,
            step.index,
            tc.name,
            tc.input !== undefined ? JSON.stringify(tc.input) : null,
            tc.output !== undefined ? JSON.stringify(tc.output) : null,
            tc.latencyMs ?? null,
            tc.error ?? null,
          ),
        );
      }
    }
  }
  await env.DB.batch(tx);
}
