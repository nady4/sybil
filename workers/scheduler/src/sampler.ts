import {
  decryptSecret,
  stableHash,
  type Run,
} from "@agentsre/shared";
import { createProvider, judgeScore } from "@agentsre/runtime";
import type { Env } from "./env.js";
import { getOrg, getProviderKey } from "./db.js";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * SamplerWorkflow — sampled LLM-judge scoring for production runs.
 *
 * Production runs arrive with no ground truth; the sampler gives a
 * quality proxy: a deterministic per-run sample (default 5%, per-org
 * override via KV) is judged against a generic rubric with the org's own
 * provider key, cached, budget-capped, and written back to runs.eval_score.
 * This is what lets the production half participate in quality-regression
 * alerting (score_drop) without vendor judge spend at scale.
 */

export const PRODUCTION_JUDGE_RUBRIC =
  "Score the agent's response to the user's request. A good response is correct, complete, " +
  "directly addresses the user's goal, and is not a refusal or an error. " +
  "Score 0 for refusals, errors, or empty responses. Reply with a single number 0.0 to 1.0.";

interface Candidate {
  id: string;
  orgId: string;
  model?: string;
  stepsJson?: string;
}

export class SamplerWorkflow extends WorkflowEntrypoint<Env, { tick?: string }> {
  async run(event: WorkflowEvent<{ tick?: string }>, step: WorkflowStep) {
    const candidates = await step.do("load unscored production runs", async () => this.loadCandidates());
    let judged = 0;
    for (const c of candidates) {
      const result = await step.do(
        `judge production run ${c.id}`,
        { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" },
        async () => this.judgeOne(c),
      );
      if (result) judged++;
    }
    return { candidates: candidates.length, judged };
  }

  private async loadCandidates(): Promise<Candidate[]> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await this.env.DB.prepare(
      `SELECT id, org_id, model, steps_json FROM runs
       WHERE source = 'production' AND eval_score IS NULL AND started_at >= ?
       ORDER BY started_at DESC LIMIT 500`,
    )
      .bind(dayAgo)
      .all<{ id: string; org_id: string; model: string | null; steps_json: string | null }>();
    return res.results.map((r) => ({ id: r.id, orgId: r.org_id, model: r.model ?? undefined, stepsJson: r.steps_json ?? undefined }));
  }

  private async judgeOne(c: Candidate): Promise<boolean> {
    const judgedMarker = `judged:${c.id}`;
    if (await this.env.JUDGE_CACHE.get(judgedMarker).catch(() => null)) return false;

    // Deterministic per-run sampling so retries agree.
    const hash = await stableHash(`judge:${c.id}`);
    const bucket = parseInt(hash.slice(0, 2), 16);
    const rate = Number((await this.env.JUDGE_CACHE.get(`sample_rate:${c.orgId}`).catch(() => null)) ?? "0.05");
    if (bucket / 255 >= rate) {
      await this.env.JUDGE_CACHE.put(judgedMarker, "skip", { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
      console.log(`sampler: skipped ${c.id} (bucket ${bucket}/255 >= rate ${rate})`);
      return false;
    }

    const org = await getOrg(this.env, c.orgId);
    if (!org) {
      console.log(`sampler: no org for ${c.orgId}`);
      return false;
    }
    const openaiCipher = await getProviderKey(this.env, c.orgId, "openai");
    const anthropicCipher = await getProviderKey(this.env, c.orgId, "anthropic");
    const cipher = openaiCipher ?? anthropicCipher;
    if (!cipher) {
      console.log(`sampler: no provider key for ${c.orgId}`);
      return false;
    }
    const apiKey = await decryptSecret(cipher, this.env.KEYS_ENC_KEY);
    const provider = createProvider(openaiCipher ? "openai" : "anthropic", apiKey, {
      baseUrl: openaiCipher ? this.env.OPENAI_BASE_URL : this.env.ANTHROPIC_BASE_URL,
    });

    const steps = c.stepsJson ? (JSON.parse(c.stepsJson) as Run["steps"]) : undefined;
    const content = (steps?.map((s) => s.content ?? "").filter(Boolean).join("\n") ?? "").slice(0, 6000);
    if (!content.trim()) {
      console.log(`sampler: empty content for ${c.id}`);
      return false;
    }

    const budgetKey = `judge:budget:${c.orgId}:${new Date().toISOString().slice(0, 10)}`;
    const spent = Number((await this.env.JUDGE_CACHE.get(budgetKey).catch(() => null)) ?? "0");
    const limit = org.limits.judgeDailyBudgetUsd;
    const budget = {
      remainingUsd: async () => Math.max(0, limit - spent),
      spendUsd: async (usd: number) => {
        await this.env.JUDGE_CACHE.put(budgetKey, String(spent + usd));
      },
    };

    let score: number | null;
    try {
      score = await judgeScore(PRODUCTION_JUDGE_RUBRIC, content, {
        model: this.env.JUDGE_MODEL,
        maxTokens: 64,
        cache: {
          get: (k) => this.env.JUDGE_CACHE.get(k),
          put: (k, v, ttl) => this.env.JUDGE_CACHE.put(k, v, { expirationTtl: ttl }),
        },
        budget,
        complete: async (req) => {
          try {
            return await provider.complete(req);
          } catch (e) {
            console.log(`sampler: complete threw for ${c.id}: ${e instanceof Error ? e.message : e}`);
            throw e;
          }
        },
      });
    } catch (e) {
      console.log(`sampler: judge threw for ${c.id}: ${e instanceof Error ? e.message : e}`);
      score = null;
    }

    console.log(`sampler: judged ${c.id} -> ${score}`);
    if (score === null) return false;
    await this.env.DB.prepare(
      "UPDATE runs SET eval_score = ?, eval_score_components = ? WHERE id = ?",
    ).bind(score, JSON.stringify({ quality: score }), c.id).run();
    await this.env.JUDGE_CACHE.put(judgedMarker, "done", { expirationTtl: 90 * 24 * 3600 }).catch(() => {});
    return true;
  }
}
