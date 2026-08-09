import type { Env } from "./env.js";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * RetentionWorkflow — the R2 retention pipeline.
 *
 * Daily (cron "0 4 * * *"):
 *  1. Runs older than RETENTION_DAYS_RAW (30) with steps_json still in D1
 *     are copied verbatim to R2 (runs/{orgId}/{yyyy-mm}/{runId}.json) and
 *     truncated in D1, so raw tool payloads stop growing the database.
 *  2. R2 objects older than RETENTION_DAYS_PURGE (90) are deleted.
 *  3. Run rows older than RETENTION_DAYS_PURGE are purged (tool_calls cascade).
 *
 * Env-tunable via RETENTION_DAYS_RAW / RETENTION_DAYS_PURGE (defaults 30/90).
 */

interface Candidate {
  id: string;
  orgId: string;
  featureId: string;
  stepsJson: string;
  startedAt: string;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600_000).toISOString();
}

export class RetentionWorkflow extends WorkflowEntrypoint<Env, { tick?: string }> {
  async run(event: WorkflowEvent<{ tick?: string }>, step: WorkflowStep) {
    const rawDays = Number(this.env.RETENTION_DAYS_RAW ?? 30);
    const purgeDays = Number(this.env.RETENTION_DAYS_PURGE ?? 90);

    const archived = await step.do(
      "archive + truncate old steps",
      { timeout: "10 minutes" },
      async () => this.archiveAndTruncate(rawDays),
    );
    const deleted = await step.do(
      "purge expired R2 objects",
      { timeout: "10 minutes" },
      async () => this.purgeR2(purgeDays),
    );
    const purged = await step.do(
      "purge old run rows",
      { timeout: "10 minutes" },
      async () => this.purgeRuns(purgeDays),
    );
    return { archived, deleted, purged };
  }

  private async archiveAndTruncate(rawDays: number): Promise<number> {
    const cutoff = daysAgoIso(rawDays);
    const res = await this.env.DB.prepare(
      `SELECT id, org_id, feature_id, steps_json, started_at FROM runs
       WHERE steps_json IS NOT NULL AND started_at < ? LIMIT 500`,
    )
      .bind(cutoff)
      .all<{ id: string; org_id: string; feature_id: string; steps_json: string; started_at: string }>();

    let archived = 0;
    for (const row of res.results) {
      const key = this.keyFor(row.org_id, row.started_at, row.id);
      await this.env.RUNS_BUCKET.put(key, row.steps_json, {
        httpMetadata: { contentType: "application/json" },
      });
      await this.env.DB.prepare("UPDATE runs SET steps_json = NULL WHERE id = ?").bind(row.id).run();
      archived++;
    }
    return archived;
  }

  private async purgeR2(purgeDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - purgeDays * 24 * 3600_000).toISOString().slice(0, 7);
    let deleted = 0;
    let cursor: string | undefined;
    for (;;) {
      const list = await this.env.RUNS_BUCKET.list({ prefix: "runs/", cursor });
      for (const obj of list.objects) {
        const month = obj.key.split("/")[2] ?? "";
        if (month < cutoff) {
          await this.env.RUNS_BUCKET.delete(obj.key);
          deleted++;
        }
      }
      cursor = list.truncated ? list.cursor : undefined;
      if (!cursor) break;
    }
    return deleted;
  }

  private async purgeRuns(purgeDays: number): Promise<number> {
    const cutoff = daysAgoIso(purgeDays);
    const res = await this.env.DB.prepare(
      `DELETE FROM runs WHERE started_at < ? LIMIT 500`,
    ).bind(cutoff).run();
    return res.meta.changes ?? 0;
  }

  private keyFor(orgId: string, startedAt: string, runId: string): string {
    const month = startedAt.slice(0, 7);
    return `runs/${orgId}/${month}/${runId}.json`;
  }
}
