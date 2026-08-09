import { api, fmtUsd } from "@/lib/api";

export const dynamic = "force-dynamic";

interface Run {
  id: string;
  feature_id: string;
  source: "synthetic" | "production";
  model?: string;
  status: string;
  eval_score?: number;
  cost_usd?: number;
  latency_ms?: number;
  started_at: string;
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ featureId?: string; source?: string; status?: string }>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams({ limit: "50" });
  if (params.featureId) q.set("featureId", params.featureId);
  if (params.source) q.set("source", params.source);
  if (params.status) q.set("status", params.status);

  let runs: Run[] = [];
  let error: string | null = null;
  try {
    const data = await api<{ runs: Run[] }>(`/v1/runs?${q.toString()}`);
    runs = data.runs;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Runs</h1>
      <form method="get" style={{ gridTemplateColumns: "auto auto auto auto auto", alignItems: "end", marginBottom: 16 }}>
        <label>
          Feature
          <input name="featureId" defaultValue={params.featureId ?? ""} placeholder="checkout" />
        </label>
        <label>
          Source
          <select name="source" defaultValue={params.source ?? ""}>
            <option value="">all</option>
            <option value="synthetic">synthetic</option>
            <option value="production">production</option>
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={params.status ?? ""}>
            <option value="">all</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
            <option value="error">error</option>
            <option value="refused">refused</option>
          </select>
        </label>
        <button type="submit" className="secondary">Filter</button>
      </form>
      {error ? <div className="error">api: {error}</div> : null}
      {runs.length === 0 && !error ? (
        <div className="empty">
          No runs yet. Production runs appear when your agent exports traces (POST /v1/traces or
          /v1/otlp); synthetic runs appear when a check fires.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Source</th>
              <th>Feature</th>
              <th>Model</th>
              <th>Status</th>
              <th>Eval</th>
              <th>Latency</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="muted">
                  <a href={`/runs/${r.id}`} className="mono" style={{ color: "var(--accent)", textDecoration: "none" }}>
                    {r.started_at.slice(0, 16)}
                  </a>
                </td>
                <td>
                  <span className={`pill ${r.source}`}>{r.source}</span>
                </td>
                <td className="mono">
                  <a href={`/features/${encodeURIComponent(r.feature_id)}`} style={{ color: "var(--text)", textDecoration: "none" }}>
                    {r.feature_id}
                  </a>
                </td>
                <td className="mono muted">{r.model ?? "-"}</td>
                <td>
                  <span className={`pill ${r.status}`}>{r.status}</span>
                </td>
                <td>{r.eval_score !== undefined && r.eval_score !== null ? r.eval_score.toFixed(2) : "-"}</td>
                <td>{r.latency_ms !== undefined && r.latency_ms !== null ? `${r.latency_ms}ms` : "-"}</td>
                <td>{fmtUsd(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
