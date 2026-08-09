import { api } from "@/lib/api";
import CheckForm from "./check-form";
import CheckActions from "./check-actions";

export const dynamic = "force-dynamic";

interface Check {
  id: string;
  featureId: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  model: string;
  enabled: boolean;
  lastRunAt?: string;
  alertChannelIds?: string[];
}

export default async function ChecksPage() {
  let checks: Check[] = [];
  let channels: Array<{ id: string; name: string; type: string }> = [];
  let error: string | null = null;
  try {
    const [data, ch] = await Promise.all([
      api<{ checks: Check[] }>("/v1/checks"),
      api<{ channels: typeof channels }>("/v1/alert-channels").catch(() => ({ channels: [] })),
    ]);
    checks = data.checks;
    channels = ch.channels;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const channelName = (id: string): string => channels.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <h1>Checks</h1>
      {error ? <div className="error">api: {error}</div> : null}
      {checks.length === 0 && !error ? (
        <div className="empty">No checks yet — synthetic runs start as soon as you create one.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Feature</th>
              <th>Model</th>
              <th>Interval</th>
              <th>Last run</th>
              <th>State</th>
              <th>Channels</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">{c.featureId}</td>
                <td className="mono">{c.model}</td>
                <td>{c.intervalMinutes}m</td>
                <td className="muted">{c.lastRunAt ? c.lastRunAt.slice(0, 16) : "never"}</td>
                <td>
                  <span className={`pill ${c.enabled ? "success" : ""}`}>{c.enabled ? "enabled" : "disabled"}</span>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {(c.alertChannelIds ?? []).map(channelName).join(", ") || "-"}
                </td>
                <td>
                  <CheckActions id={c.id} enabled={c.enabled} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Create a check</h2>
      <CheckForm channels={channels} />
    </div>
  );
}
