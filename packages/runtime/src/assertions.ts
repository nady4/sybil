import type { SuccessCriterion } from "@agentsre/shared";

/**
 * Assertions engine. Three types ship in V1:
 *  - exact / regex over final, last-step, or any-step content
 *  - llm_judge (cached, budget-capped)
 *  - tool_called (the runtime-behavior assertion Checkly can't express)
 *
 * Overall eval score = weighted mean of criterion scores; guardrail trips
 * cap the score at the criterion minimum (a refused run must not pass).
 */

export interface AssertionContext {
  finalContent?: string;
  stepContents: string[];
  toolNamesCalled: string[];
  refused: boolean;
  /** Returns 0..1 or null when the judge was skipped (cache miss budget etc). */
  judge: (rubric: string, content: string) => Promise<number | null>;
}

export interface CriterionResult {
  name: string;
  passed: boolean;
  score: number;
  detail?: string;
}

export interface EvaluationResult {
  results: CriterionResult[];
  overallScore: number;
  /** Judge-dependent criteria that could not be scored. */
  incomplete: boolean;
}

function contentFor(field: "final" | "last_step" | "any_step", ctx: AssertionContext): string[] {
  switch (field) {
    case "final":
      return ctx.finalContent ? [ctx.finalContent] : [];
    case "last_step":
      return ctx.stepContents.length ? [ctx.stepContents[ctx.stepContents.length - 1]!] : [];
    case "any_step":
      return ctx.stepContents;
  }
}

export async function evaluateCriteria(
  criteria: SuccessCriterion[],
  ctx: AssertionContext,
): Promise<EvaluationResult> {
  const results: CriterionResult[] = [];
  let incomplete = false;

  for (const c of criteria) {
    const a = c.assertion;
    const name = c.name ?? `criterion_${results.length}`;
    let passed = false;
    let score = 0;
    let detail: string | undefined;

    switch (a.type) {
      case "exact": {
        const haystacks = contentFor(a.field ?? "any_step", ctx);
        passed = haystacks.some((h) => h.includes(a.expected));
        if (!passed) detail = `"${a.expected}" not found`;
        score = passed ? 1 : 0;
        break;
      }
      case "regex": {
        const haystacks = contentFor(a.field ?? "any_step", ctx);
        let re: RegExp;
        try {
          re = new RegExp(a.pattern);
        } catch {
          detail = `invalid regex: ${a.pattern}`;
          break;
        }
        passed = haystacks.some((h) => re.test(h));
        if (!passed) detail = `/${a.pattern}/ did not match`;
        score = passed ? 1 : 0;
        break;
      }
      case "tool_called": {
        passed = ctx.toolNamesCalled.includes(a.tool);
        if (!passed) detail = `tool ${a.tool} never called`;
        score = passed ? 1 : 0;
        break;
      }
      case "llm_judge": {
        const content = ctx.finalContent ?? ctx.stepContents.join("\n");
        const s = await ctx.judge(a.rubric, content);
        if (s === null) {
          incomplete = true;
          detail = "judge skipped (budget/cache)";
          break;
        }
        score = s;
        passed = s >= a.minScore;
        detail = `judge score ${s.toFixed(2)} vs min ${a.minScore}`;
        break;
      }
    }

    results.push({ name, passed, score: Number(score.toFixed(4)), detail });
  }

  let overallScore: number;
  if (results.length === 0) {
    overallScore = ctx.refused ? 0 : 1;
  } else {
    const totalWeight = criteria.reduce((n, c) => n + (c.weight ?? 1), 0);
    overallScore =
      results.reduce((n, r, i) => n + r.score * (criteria[i]!.weight ?? 1), 0) / Math.max(totalWeight, 1e-9);
  }
  if (ctx.refused) overallScore = Math.min(overallScore, 0);

  return { results: results.map((r) => ({ ...r, name: r.name })), overallScore: Number(overallScore.toFixed(4)), incomplete };
}
