import { describe, expect, it } from "vitest";
import { Client } from "@agentsre/sdk";
import { importHelicone } from "../src/import-helicone.js";

/**
 * End-to-end importer test against a running local dev stack
 * (api on 8788, ingest on 8789, shared state). Requires the dev servers
 * to be up; skipped cleanly when they are not.
 */

const API_URL = process.env.AGENTSRE_API_URL ?? "http://localhost:8788";
const API_KEY = process.env.AGENTSRE_API_KEY ?? "";

async function devStackUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("importHelicone", () => {
  it("parses, dedupes, skips malformed rows, and lands runs in the store", async () => {
    if (!(await devStackUp())) {
      console.warn("dev stack not running — skipping Helicone import E2E");
      return;
    }
    if (!API_KEY) {
      console.warn("AGENTSRE_API_KEY not set — skipping Helicone import E2E");
      return;
    }

    const client = new Client({ baseUrl: API_URL, ingestUrl: "http://localhost:8789", apiKey: API_KEY });
    const { imported, failed } = await importHelicone(client, "/tmp/opencode/heli-export.jsonl", "support");

    // 5 lines: 3 unique requests + 1 duplicate (deduped) + 1 malformed (skipped).
    expect(imported).toBe(3);
    expect(failed).toBe(0);

    // The queue consumer writes asynchronously — poll until the runs land.
    interface RunRow {
      id?: string;
      model?: string;
      cost_usd?: number;
      status: string;
      error_type?: string;
    }
    let heli: RunRow[] = [];
    for (let attempt = 0; attempt < 20 && heli.length < 3; attempt++) {
      const { runs } = await client.runsList({ featureId: "support", source: "production", limit: 20 });
      heli = (runs as RunRow[]).filter((r) => r.id?.includes("_heli_"));
      if (heli.length < 3) await new Promise((r) => setTimeout(r, 1500));
    }
    expect(heli.length).toBeGreaterThanOrEqual(3);
    const first = heli.find((r) => r.model === "gpt-4o-mini" && r.status === "success");
    expect(first?.cost_usd).toBeCloseTo(0.000042, 6);
    const errored = heli.find((r) => r.status === "error");
    expect(errored?.error_type).toContain("upstream");
  }, 120_000);
});
