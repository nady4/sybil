import { readFileSync } from "node:fs";
import { Client } from "@agentsre/sdk";

/**
 * One-shot Helicone migration importer.
 *
 * Helicone (maintenance mode) lets projects export their requests as
 * JSONL or CSV (Requests tab -> export). This command replays the export
 * into the AgentsRE production ingest as production Runs, so historical
 * shape/baseline data survives the migration.
 *
 * Usage: agentsre import-helicone <export.jsonl|export.csv> [--feature <featureId>]
 */

interface HeliconeRow {
  request_id?: string;
  response_id?: string;
  model?: string;
  prompt?: string;
  completion?: string;
  latency?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  created_at?: string;
  status?: number | string;
  costUSD?: number;
  cost_usd?: number;
  error?: string;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function parseRows(file: string): HeliconeRow[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".csv")) {
    return parseCsv(text).map((r) => ({
      request_id: r.request_id || r.requestId,
      response_id: r.response_id || r.responseId,
      model: r.model,
      latency: r.latency ? Number(r.latency) : undefined,
      prompt_tokens: r.prompt_tokens ? Number(r.prompt_tokens) : undefined,
      completion_tokens: r.completion_tokens ? Number(r.completion_tokens) : undefined,
      created_at: r.created_at || r.createdAt,
      status: r.status ? Number(r.status) : undefined,
      costUSD: r.costUSD ? Number(r.costUSD) : undefined,
      error: r.error,
    }));
  }
  const rows: HeliconeRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as HeliconeRow);
    } catch {
      console.error(`skipping unparseable line: ${t.slice(0, 120)}`);
    }
  }
  return rows;
}

export async function importHelicone(
  client: Client,
  file: string,
  featureId: string,
): Promise<{ imported: number; failed: number }> {
  const rows = parseRows(file);
  console.log(`parsed ${rows.length} rows from ${file}`);

  const seen = new Set<string>();
  const jobs: Array<{
    id: string;
    featureId: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    costUsd?: number;
    status: string;
    errorType?: string;
    meta?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
  }> = [];
  for (const r of rows) {
    const key = r.request_id ?? r.response_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const startedAt =
      r.created_at && !Number.isNaN(new Date(r.created_at).getTime())
        ? new Date(r.created_at).toISOString()
        : undefined;
    jobs.push({
      id: `heli_${key.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60)}`,
      featureId,
      model: r.model,
      inputTokens: r.prompt_tokens,
      outputTokens: r.completion_tokens,
      latencyMs: r.latency,
      costUsd: r.costUSD,
      status: r.status === 200 || r.status === undefined ? "success" : "error",
      errorType: r.error,
      meta: { migratedFrom: "helicone", responseId: r.response_id },
      startedAt,
      completedAt: startedAt,
    });
  }
  console.log(`${jobs.length} unique requests to import`);

  let imported = 0;
  let failed = 0;
  const CONCURRENCY = 8;
  const queue = [...jobs];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        const res = await client.ingestRun(job);
        imported += res.accepted;
        failed += res.rejected;
      } catch (e) {
        failed++;
        if (failed % 25 === 1) {
          console.error(`\nimport error: ${e instanceof Error ? e.message : e}`);
        }
      }
      if ((imported + failed) % 25 === 0) {
        process.stdout.write(`\r  ${imported + failed}/${jobs.length} (${imported} accepted)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\ndone: ${imported} imported, ${failed} failed`);
  return { imported, failed };
}
