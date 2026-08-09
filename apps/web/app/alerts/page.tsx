import { api } from "@/lib/api";
import AlertActions from "./alert-actions";

export const dynamic = "force-dynamic";

interface Alert {
  id: string;
  feature_id: string;
  model?: string;
  type: string;
  severity: string;
  message: string;
  status: string;
  opened_at: string;
}

export default async function AlertsPage() {
  let alerts: Alert[] = [];
  let error: string | null = null;
  try {
    const data = await api<{ alerts: Alert[] }>("/v1/alerts");
    alerts = data.alerts;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Alerts</h1>
      {error ? <div className="error">api: {error}</div> : null}
      {alerts.length === 0 && !error ? (
        <div className="empty">
          No alerts. Baselines need at least 20 runs per feature before regression detection arms.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Opened</th>
              <th>Feature</th>
              <th>Type</th>
              <th>Severity</th>
              <th>Message</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td className="muted">
                  <a href={`/alerts/${a.id}`} style={{ color: "var(--text)", textDecoration: "none" }}>{a.opened_at.slice(0, 16)}</a>
                </td>
                <td className="mono">
                  <a href={`/features/${encodeURIComponent(a.feature_id)}`} style={{ color: "var(--text)", textDecoration: "none" }}>
                    {a.feature_id}
                  </a>
                </td>
                <td className="mono">{a.type}</td>
                <td>
                  <span className={`pill ${a.severity === "critical" ? "failed" : "acknowledged"}`}>{a.severity}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{a.message}</td>
                <td>
                  <span className={`pill ${a.status}`}>{a.status}</span>
                </td>
                <td>
                  <AlertActions id={a.id} status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
