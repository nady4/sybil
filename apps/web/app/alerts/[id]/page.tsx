import { api, fmtPct } from "@/lib/api";

export const dynamic = "force-dynamic";

interface Alert {
  id: string;
  org_id: string;
  feature_id: string;
  model?: string;
  type: string;
  severity: string;
  message: string;
  status: string;
  run_id?: string;
  opened_at: string;
  resolved_at?: string;
  delivered_at?: string;
}

interface Correlation {
  synthetic: { runs24h: number; passRate?: number; avgEval?: number };
  production: { runs24h: number; passRate?: number; errorRate?: number; refusalRate?: number; p50LatencyMs?: number; avgEval?: number };
  correlation: { last15m: { syntheticRuns: number; syntheticFailures: number; productionRuns: number; productionErrors: number } };
  recentAlerts: Array<{ id: string; type: string; severity: string; message: string }>;
}

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let alert: Alert | undefined;
  let corr: Correlation | undefined;
  let error: string | null = null;
  try {
    const [a, c] = await Promise.all([
      api<{ alert: Alert }>(`/v1/alerts/${id}`),
      api<{ featureId: string } & Correlation>(`/v1/features/${encodeURIComponent(id)}/correlation`).catch(() => null),
    ]);
    alert = a.alert;
    if (c) {
      const cc = await api<Correlation>(`/v1/features/${encodeURIComponent(alert.feature_id)}/correlation`);
      corr = cc;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !alert) {
    return (
      <div>
        <h1>Alert {id}</h1>
        <div className="error">api: {error ?? "not found"}</div>
      </div>
    );
  }

  const { last15m } = corr?.correlation ?? { last15m: { syntheticRuns: 0, syntheticFailures: 0, productionRuns: 0, productionErrors: 0 } };

  return (
    <div>
      <h1>
        Alert <span className="mono">{alert.id}</span>
      </h1>
      <div className="cards" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="label">Status</div>
          <div className="value"><span className={`pill ${alert.status}`}>{alert.status}</span></div>
        </div>
        <div className="card">
          <div className="label">Type</div>
          <div className="value" style={{ fontSize: 18 }}>{alert.type}</div>
        </div>
        <div className="card">
          <div className="label">Severity</div>
          <div className="value" style={{ fontSize: 18 }}>
            <span className={`pill ${alert.severity === "critical" ? "failed" : "acknowledged"}`}>{alert.severity}</span>
          </div>
        </div>
        <div className="card">
          <div className="label">Feature</div>
          <div className="value" style={{ fontSize: 18 }}>
            <a href={`/features/${encodeURIComponent(alert.feature_id)}`} style={{ color: "var(--accent)" }}>{alert.feature_id}</a>
          </div>
        </div>
      </div>

      <h2>Message</h2>
      <div className="mono" style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginBottom: 20 }}>
        {alert.message}
      </div>

      <h2>Production correlation — last 15 minutes</h2>
      {corr ? (
        <div className="cards" style={{ marginBottom: 12 }}>
          <div className="card">
            <div className="label">Synthetic runs</div>
            <div className="value">{last15m.syntheticRuns}</div>
          </div>
          <div className="card">
            <div className="label">Synthetic failures</div>
            <div className="value" style={{ color: last15m.syntheticFailures ? "var(--red)" : "var(--green)" }}>{last15m.syntheticFailures}</div>
          </div>
          <div className="card">
            <div className="label">Production runs</div>
            <div className="value">{last15m.productionRuns}</div>
          </div>
          <div className="card">
            <div className="label">Production errors</div>
            <div className="value" style={{ color: last15m.productionErrors ? "var(--red)" : "var(--green)" }}>{last15m.productionErrors}</div>
          </div>
        </div>
      ) : (
        <div className="empty">No production telemetry for this feature yet — export traces to /v1/traces or /v1/otlp to arm correlation.</div>
      )}

      {corr ? (
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th>Synthetic (24h)</th>
              <th>Production (24h)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Runs</td>
              <td>{corr.synthetic.runs24h}</td>
              <td>{corr.production.runs24h}</td>
            </tr>
            <tr>
              <td>Pass rate</td>
              <td>{fmtPct(corr.synthetic.passRate)}</td>
              <td>{fmtPct(corr.production.passRate ?? undefined)}</td>
            </tr>
            <tr>
              <td>Error / refusal</td>
              <td>-</td>
              <td>{fmtPct(corr.production.errorRate)} / {fmtPct(corr.production.refusalRate)}</td>
            </tr>
            <tr>
              <td>Avg eval (judged)</td>
              <td>{corr.synthetic.avgEval !== undefined ? corr.synthetic.avgEval.toFixed(2) : "-"}</td>
              <td>{corr.production.avgEval !== undefined ? corr.production.avgEval.toFixed(2) : "-"}</td>
            </tr>
          </tbody>
        </table>
      ) : null}

      <h2>Timeline</h2>
      <table>
        <tbody>
          {[
            ["Opened", alert.opened_at],
            ["Run", alert.run_id ?? "-"],
            ["Model", alert.model ?? "-"],
            ["Delivered", alert.delivered_at ?? "not yet"],
            ["Resolved", alert.resolved_at ?? "-"],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 180 }}>{k}</td>
              <td className="mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
