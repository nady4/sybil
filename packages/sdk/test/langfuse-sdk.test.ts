import { describe, expect, it } from "vitest";
import { Langfuse } from "langfuse";

/**
 * Real Langfuse SDK verification against the AgentsRE ingest worker.
 *
 * The langfuse-js SDK posts to POST /api/public/ingestion with Basic auth
 * (publicKey:secretKey). Our compat endpoint maps the batch into runs.
 * Requires the local dev stack (api :8788, ingest :8789); skips otherwise.
 */

const API_URL = process.env.AGENTSRE_API_URL ?? "http://localhost:8788";
const INGEST_URL = process.env.AGENTSRE_INGEST_URL ?? "http://localhost:8789";
const BOOTSTRAP = "dev-bootstrap";

async function devStackUp(): Promise<boolean> {
  try {
    const [a, i] = await Promise.all([
      fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${INGEST_URL}/health`, { signal: AbortSignal.timeout(2000) }),
    ]);
    return a.ok && i.ok;
  } catch {
    return false;
  }
}

describe("Langfuse SDK drop-in", () => {
  it("lands traces via the real langfuse-js SDK", async () => {
    if (!(await devStackUp())) {
      console.warn("dev stack not running — skipping Langfuse SDK E2E");
      return;
    }

    const setup = (await fetch(`${API_URL}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bootstrap-token": BOOTSTRAP },
      body: JSON.stringify({ orgName: "LangfuseE2E", plan: "indie" }),
    }).then((r) => r.json())) as { apiKey: string; orgId: string };

    const langfuse = new Langfuse({
      baseUrl: INGEST_URL,
      publicKey: setup.apiKey, // our Basic-auth username is the AgentsRE key
      secretKey: "sk_anything",
      flushAt: 1,
      flushInterval: 1,
    });

    const trace = langfuse.trace({
      name: "lf-sdk-e2e",
      userId: "user_e2e",
      sessionId: "sess_e2e",
      metadata: { featureId: "support", agentId: "lf-agent" },
    });
    trace.generation({
      name: "chat",
      model: "gpt-4o-mini",
      usage: { input: 400, output: 80 },
      input: "What is the refund policy?",
      output: "Refunds are available within 30 days.",
      startTime: new Date(),
      endTime: new Date(Date.now() + 800),
    });
    await langfuse.flushAsync();
    await langfuse.shutdownAsync();

    // The queue consumer writes asynchronously — poll until the run lands.
    interface RunRow {
      id?: string;
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      cost_usd?: number;
      status: string;
      source: string;
      feature_id: string;
    }
    let found: RunRow | undefined;
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      const res = (await fetch(`${API_URL}/v1/runs?featureId=support&limit=20`, {
        headers: { authorization: `Bearer ${setup.apiKey}` },
      }).then((r) => r.json())) as { runs: RunRow[] };
      found = res.runs.find((r) => r.model === "gpt-4o-mini" && r.source === "production");
      if (!found) await new Promise((r) => setTimeout(r, 1500));
    }

    expect(found).toBeDefined();
    expect(found!.feature_id).toBe("support");
    expect(found!.input_tokens).toBe(400);
    expect(found!.output_tokens).toBe(80);
    expect(found!.cost_usd).toBeCloseTo(0.000108, 6);
    expect(found!.status).toBe("success");
  }, 120_000);
});
