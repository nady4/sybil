import {
  decryptSecret,
  id,
  redactValue,
  stableHash,
  type Check,
  type Run,
  type RunEvent,
  type Usage,
} from "@agentsre/shared";
import { evaluateCriteria, judgeScore, runAgent, createProvider, DEFAULT_TOOLS } from "@agentsre/runtime";
import { getOrg, getProviderKey, loadDueChecks, mapCheckRow, persistRun, type CheckRow } from "./db.js";
import type { Env } from "./env.js";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * SchedulerWorkflow — the synthetic runner.
 *
 * Cron fires every minute; the workflow loads due checks, executes the
 * agent on the CUSTOMER's provider key, evaluates assertions (judge is
 * cached + budget-capped), persists the unified Run row, and forwards the
 * event to the FeatureCoordinator DO for baselines/alerts.
 *
 * Workflows may hibernate between steps, so all state flows through step
 * returns — never module variables.
 */

export class SchedulerWorkflow extends WorkflowEntrypoint<Env, { tick?: string; checkId?: string }> {
  async run(event: WorkflowEvent<{ tick?: string; checkId?: string }>, step: WorkflowStep) {
    const due = await step.do("load due checks", async () => {
      // Targeted execution (ops: POST /internal/run-check) bypasses the
      // schedule and runs exactly one check regardless of last_run_at.
      if (event.payload.checkId) {
        const res = await this.env.DB.prepare("SELECT * FROM checks WHERE id = ? AND enabled = 1")
          .bind(event.payload.checkId)
          .first<CheckRow>();
        return res ? [mapCheckRow(res)] : [];
      }
      return await loadDueChecks(this.env, new Date());
    });

    for (const check of due) {
      await step.do(
        `run check ${check.id}`,
        {
          retries: { limit: 2, delay: "10 seconds", backoff: "constant" },
          timeout: "4 minutes",
        },
        async () => this.runOneCheck(check),
      );
    }
  }

  private async runOneCheck(check: Check): Promise<void> {
    const startedAt = new Date();
    const completedAt = new Date();
    const runId = id("run");

    let status: Run["status"] = "success";
    let errorType: string | undefined;
    let finalContent: string | undefined;
    let refused = false;
    let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd: number | undefined;
    let latencyMs = 0;
    let steps: Run["steps"] | undefined;
    let stopReason = "completed";

    try {
      const org = await getOrg(this.env, check.orgId);
      if (!org) throw new Error("org not found");
      const cipher = await getProviderKey(this.env, check.orgId, check.provider);
      if (!cipher) throw new Error(`no ${check.provider} provider key configured for org`);
      const apiKey = await decryptSecret(cipher, this.env.KEYS_ENC_KEY);
      const provider = createProvider(check.provider, apiKey, {
        baseUrl:
          check.provider === "openai" ? this.env.OPENAI_BASE_URL : check.provider === "anthropic" ? this.env.ANTHROPIC_BASE_URL : undefined,
      });

      // Decrypt the check's static request headers (auth'd targets). These
      // live only in this step's memory and never appear in stored steps.
      let targetHeaders: Record<string, string> | undefined;
      if (check.headersCipher) {
        const plain = await decryptSecret(check.headersCipher, this.env.KEYS_ENC_KEY);
        targetHeaders = JSON.parse(plain) as Record<string, string>;
      }

      const allowedHosts: string[] | "any" =
        check.allowedDomains && check.allowedDomains.length > 0
          ? check.allowedDomains
          : check.target
            ? [new URL(check.target).hostname]
            : "any";

      const agentResult = await runAgent({
        provider,
        model: check.model,
        prompt: check.prompt,
        system: check.system,
        tools: DEFAULT_TOOLS,
        toolContext: { allowedHosts, maxBytes: 256 * 1024, timeoutMs: 15_000, headers: targetHeaders },
        maxSteps: check.maxSteps,
        maxOutputTokens: check.maxOutputTokens,
        maxTotalCostUsd: org.limits.maxRunsPerDay > 0 ? 1 : undefined,
        callTimeoutMs: 90_000,
      });

      finalContent = agentResult.finalContent;
      refused = agentResult.refused;
      totalUsage = agentResult.totalUsage;
      costUsd = agentResult.totalCostUsd;
      latencyMs = agentResult.durationMs;
      steps = agentResult.steps;
      stopReason = agentResult.stopReason;

      if (agentResult.stopReason === "error") {
        status = "error";
        errorType = agentResult.error?.slice(0, 500);
      } else if (agentResult.stopReason === "refused") {
        status = "refused";
      } else if (agentResult.stopReason === "cost_cap") {
        status = "error";
        errorType = "cost_cap_exceeded";
      }

      const redact = (v: unknown) => redactValue(v, check.redactionRules);
      const safeSteps = agentResult.steps.map((s) => ({
        ...s,
        content: s.content ? redact(s.content) as string : undefined,
        toolCalls: s.toolCalls.map((tc) => ({ ...tc, input: redact(tc.input), output: redact(tc.output) })),
      }));
      steps = safeSteps;

      const stepContents = safeSteps.map((s) => s.content ?? "");
      const toolNames = new Set(safeSteps.flatMap((s) => s.toolCalls.map((t) => t.name)));

      const budgetKey = `judge:budget:${check.orgId}:${new Date().toISOString().slice(0, 10)}`;
      const spent = Number((await this.env.JUDGE_CACHE.get(budgetKey).catch(() => null)) ?? "0");
      const limit = org.limits.judgeDailyBudgetUsd;
      const budget = {
        remainingUsd: async () => Math.max(0, limit - spent),
        spendUsd: async (usd: number) => {
          const next = spent + usd;
          await this.env.JUDGE_CACHE.put(budgetKey, String(next));
        },
      };

      const evaluation = await evaluateCriteria(check.successCriteria, {
        finalContent,
        stepContents,
        toolNamesCalled: [...toolNames],
        refused,
        judge: (rubric, content) =>
          judgeScore(rubric, content, {
            model: this.env.JUDGE_MODEL,
            maxTokens: 200,
            cache: {
              get: (k) => this.env.JUDGE_CACHE.get(k),
              put: (k, v, ttl) => this.env.JUDGE_CACHE.put(k, v, { expirationTtl: ttl }),
            },
            budget,
            complete: provider.complete.bind(provider),
          }),
      });

      await persistRun(
        this.env,
        check,
        {
          id: runId,
          orgId: check.orgId,
          featureId: check.featureId,
          source: "synthetic",
          model: check.model,
          inputTokens: totalUsage.inputTokens || undefined,
          outputTokens: totalUsage.outputTokens || undefined,
          reasoningTokens: totalUsage.reasoningTokens || undefined,
          costUsd,
          latencyMs,
          status,
          errorType,
          guardrailTripped: refused,
          evalScore: evaluation.overallScore,
          evalScoreComponents: Object.fromEntries(
            evaluation.results.map((r) => [r.name, r.score]),
          ),
          steps,
          meta: { stopReason, checkId: check.id, incomplete: evaluation.incomplete },
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
        },
        completedAt.toISOString(),
      );

      await this.notifyCoordinator({
        runId,
        orgId: check.orgId,
        featureId: check.featureId,
        model: check.model,
        latencyMs,
        costUsd,
        evalScore: evaluation.overallScore,
        status: refused ? "refused" : status,
        completedAt: completedAt.toISOString(),
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      errorType = err.slice(0, 500);
      status = "error";
      await persistRun(
        this.env,
        check,
        {
          id: runId,
          orgId: check.orgId,
          featureId: check.featureId,
          source: "synthetic",
          model: check.model,
          status,
          errorType,
          guardrailTripped: false,
          steps,
          meta: { stopReason: "error", checkId: check.id, failedAt: completedAt.toISOString() },
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
        },
        completedAt.toISOString(),
      ).catch(() => {});
    }
  }

  private async notifyCoordinator(event: RunEvent): Promise<void> {
    const doId = await this.coordinatorId(event.orgId, event.featureId);
    const stub = this.env.FEATURE_COORDINATOR.get(doId);
    await stub.fetch("https://do/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).then((r) => r.text());
  }

  private async coordinatorId(orgId: string, featureId: string): Promise<DurableObjectId> {
    const hash = await stableHash(`${orgId}:${featureId}`);
    return this.env.FEATURE_COORDINATOR.idFromName(hash);
  }
}
