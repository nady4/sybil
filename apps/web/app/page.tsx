import { api, fmtPct, fmtUsd } from "@/lib/api";

export const dynamic = "force-dynamic";

interface Summary {
  openAlerts: number;
  runsToday: number;
  successRate: number | null;
  byStatus: Record<string, number>;
  costTodayUsd: number;
  plan: string;
}

export default async function Home() {
  let summary: Summary | null = null;
  let error: string | null = null;
  try {
    summary = await api<Summary>("/v1/summary");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Overview</h1>
      {error ? (
        <div className="error">api: {error} — set AGENTSRE_API_URL / AGENTSRE_API_KEY</div>
      ) : summary ? (
        <>
          <div className="cards">
            <div className="card">
              <div className="label">Open alerts</div>
              <div className="value">{summary.openAlerts}</div>
            </div>
            <div className="card">
              <div className="label">Runs today</div>
              <div className="value">{summary.runsToday}</div>
            </div>
            <div className="card">
              <div className="label">Success rate</div>
              <div className="value">{fmtPct(summary.successRate)}</div>
            </div>
            <div className="card">
              <div className="label">Cost today</div>
              <div className="value">{fmtUsd(summary.costTodayUsd)}</div>
            </div>
          </div>
          <h2>Plan: {summary.plan}</h2>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.byStatus).map(([status, n]) => (
                <tr key={status}>
                  <td>
                    <span className={`pill ${status}`}>{status}</span>
                  </td>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
