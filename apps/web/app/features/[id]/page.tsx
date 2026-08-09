import { api, fmtPct, fmtUsd } from "@/lib/api";

export const dynamic = "force-dynamic";

interface Correlation {
  featureId: string;
  checks: Array<{ id: string; name: string; intervalMinutes: number; enabled: boolean }>;
  baselines: Array<{ model: string; period: string; sample_count: number; p95_latency_ms?: number; p95_eval_score?: number }>;
  recentAlerts: Array<{ id: string; type: string; severity: string; status: string; message: string }>;
  synthetic: { runs24h: number; passRate?: number; avgEval?: number; cost24hUsd: number };
  production: {
    runs24h: number;
    passRate?: number;
    avgEval?: number;
    cost24hUsd: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    errorRate?: number;
    refusalRate?: number;
  };
  correlation: { last15m: { syntheticRuns: number; syntheticFailures: number; productionRuns: number; productionErrors: number } };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 18 }}>{value}</div>
    </div>
  );
}

export default async function FeaturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let c: Correlation | undefined;
  let error: string | null = null;
  try {
    c = await api<Correlation>(`/v1/features/${encodeURIComponent(id)}/correlation`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !c) {
    return (
      <div>
        <h1>Feature <span className="mono">{id}</span></h1>
        <div className="error">api: {error ?? "not found"}</div>
      </div>
    );
  }

  const { last15m } = c.correlation;
  const last15mCorrelated = last15m.syntheticRuns > 0 && last15m.productionRuns > 0;

  return (
    <div>
      <h1>Feature <span className="mono">{c.featureId}</span></h1>

      <h2>Synthetic vs production — last 24h</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div className="label" style={{ color: "var(--accent)", marginBottom: 8 }}>synthetic</div>
          <div className="cards">
            <Metric label="Runs" value={String(c.synthetic.runs24h)} />
            <Metric label="Pass rate" value={fmtPct(c.synthetic.passRate)} />
            <Metric label="Avg eval" value={c.synthetic.avgEval !== undefined ? c.synthetic.avgEval.toFixed(2) : "-"} />
            <Metric label="Cost 24h" value={fmtUsd(c.synthetic.cost24hUsd)} />
          </div>
        </div>
        <div>
          <div className="label" style={{ color: "#a78bfa", marginBottom: 8 }}>production</div>
          <div className="cards">
            <Metric label="Runs" value={String(c.production.runs24h)} />
            <Metric label="Pass rate" value={fmtPct(c.production.passRate)} />
            <Metric label="Error rate" value={fmtPct(c.production.errorRate)} />
            <Metric label="Refusal rate" value={fmtPct(c.production.refusalRate)} />
            <Metric label="Latency p50/p95" value={`${c.production.p50LatencyMs ?? "-"}ms / ${c.production.p95LatencyMs ?? "-"}ms`} />
            <Metric label="Cost 24h" value={fmtUsd(c.production.cost24hUsd)} />
          </div>
        </div>
      </div>

      <h2>Last 15 minutes</h2>
      {last15mCorrelated ? (
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Runs</th>
              <th>Failures</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="pill synthetic">synthetic</span></td>
              <td>{last15m.syntheticRuns}</td>
              <td style={{ color: last15m.syntheticFailures ? "var(--red)" : "var(--green)" }}>{last15m.syntheticFailures}</td>
            </tr>
            <tr>
              <td><span className="pill production">production</span></td>
              <td>{last15m.productionRuns}</td>
              <td style={{ color: last15m.productionErrors ? "var(--red)" : "var(--green)" }}>{last15m.productionErrors}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="empty">
          Both sources need runs in the last 15 minutes for correlation. Right now: synthetic {last15m.syntheticRuns}, production {last15m.productionRuns}.
        </div>
      )}

      {c.checks.length > 0 ? (
        <>
          <h2>Checks</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Interval</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {c.checks.map((ch) => (
                <tr key={ch.id}>
                  <td>{ch.name}</td>
                  <td>{ch.intervalMinutes}m</td>
                  <td><span className={`pill ${ch.enabled ? "success" : ""}`}>{ch.enabled ? "enabled" : "disabled"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {c.baselines.length > 0 ? (
        <>
          <h2>Baselines</h2>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Period</th>
                <th>Samples</th>
                <th>p95 latency</th>
                <th>p95 eval</th>
              </tr>
            </thead>
            <tbody>
              {c.baselines.map((b, i) => (
                <tr key={i}>
                  <td className="mono">{b.model}</td>
                  <td>{b.period}</td>
                  <td>{b.sample_count}</td>
                  <td>{b.p95_latency_ms !== undefined && b.p95_latency_ms !== null ? `${b.p95_latency_ms}ms` : "-"}</td>
                  <td>{b.p95_eval_score !== undefined && b.p95_eval_score !== null ? b.p95_eval_score.toFixed(2) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {c.recentAlerts.length > 0 ? (
        <>
          <h2>Open alerts</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Severity</th>
                <th>Message</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.recentAlerts.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.type}</td>
                  <td><span className={`pill ${a.severity === "critical" ? "failed" : "acknowledged"}`}>{a.severity}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.message}</td>
                  <td><span className={`pill ${a.status}`}>{a.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <div className="empty" style={{ marginTop: 20 }}>No open alerts for this feature.</div>
      )}
    </div>
  );
}
