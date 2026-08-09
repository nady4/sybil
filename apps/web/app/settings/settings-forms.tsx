"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SettingsForms({
  existingKeys,
  existingChannels,
}: {
  existingKeys: Array<{ provider: string; label: string | null }>;
  existingChannels: Array<{ id: string; name: string; type: string; config: Record<string, string> }>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<Record<string, { key: string; label: string }>>({ openai: { key: "", label: "" }, anthropic: { key: "", label: "" } });
  const [channel, setChannel] = useState({ name: "", type: "slack_webhook", url: "", serviceKey: "", to: "", from: "" });

  async function saveKey(provider: "openai" | "anthropic") {
    if (!keys[provider]?.key) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/provider-keys", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key: keys[provider]!.key, label: keys[provider]!.label || undefined }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addChannel() {
    if (!channel.name) return;
    setBusy(true);
    setError(null);
    const config: Record<string, string> = {};
    if (channel.type === "slack_webhook" && channel.url) config.url = channel.url;
    if (channel.type === "pagerduty" && channel.serviceKey) config.serviceKey = channel.serviceKey;
    if (channel.type === "webhook" && channel.url) config.url = channel.url;
    if (channel.type === "email_resend") {
      if (channel.to) config.to = channel.to;
      if (channel.from) config.from = channel.from;
    }
    try {
      const res = await fetch("/api/alert-channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: channel.name, type: channel.type, config }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `${res.status}`);
      setChannel({ name: "", type: "slack_webhook", url: "", serviceKey: "", to: "", from: "" });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 640 }}>
      {error ? <div className="error">{error}</div> : null}

      <div>
        <h2>Provider keys</h2>
        <p className="muted" style={{ marginTop: -8 }}>
          The synthetic runner and production judge run on your keys. Stored encrypted; shown never.
        </p>
        {(["openai", "anthropic"] as const).map((provider) => (
          <div key={provider} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--panel)" }}>
            <div className="muted" style={{ marginBottom: 8, textTransform: "uppercase", fontSize: 12 }}>
              {provider}
              {existingKeys.some((k) => k.provider === provider) ? <span className="pill success" style={{ marginLeft: 8 }}>configured</span> : null}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <input
                type="password"
                placeholder={provider === "openai" ? "sk-…" : "sk-ant-…"}
                value={keys[provider]!.key}
                onChange={(e) => setKeys({ ...keys, [provider]: { ...keys[provider]!, key: e.target.value } })}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="label (optional)"
                  value={keys[provider]!.label}
                  onChange={(e) => setKeys({ ...keys, [provider]: { ...keys[provider]!, label: e.target.value } })}
                />
                <button className="secondary" disabled={busy || !keys[provider]!.key} onClick={() => saveKey(provider)}>
                  Save
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div>
        <h2>Alert channels</h2>
        {existingChannels.length > 0 ? (
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {existingChannels.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">{c.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty" style={{ marginBottom: 12 }}>No alert channels yet — add a Slack webhook or PagerDuty key.</div>
        )}
        <div style={{ display: "grid", gap: 8, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input placeholder="Name" value={channel.name} onChange={(e) => setChannel({ ...channel, name: e.target.value })} />
            <select value={channel.type} onChange={(e) => setChannel({ ...channel, type: e.target.value })}>
              <option value="slack_webhook">Slack webhook</option>
              <option value="pagerduty">PagerDuty</option>
              <option value="webhook">Generic webhook</option>
              <option value="email_resend">Email (Resend)</option>
            </select>
          </div>
          {channel.type === "slack_webhook" || channel.type === "webhook" ? (
            <input placeholder="https://hooks.slack.com/services/…" value={channel.url} onChange={(e) => setChannel({ ...channel, url: e.target.value })} />
          ) : null}
          {channel.type === "pagerduty" ? (
            <input placeholder="PagerDuty routing key" value={channel.serviceKey} onChange={(e) => setChannel({ ...channel, serviceKey: e.target.value })} />
          ) : null}
          {channel.type === "email_resend" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <input placeholder="to (comma separated)" value={channel.to} onChange={(e) => setChannel({ ...channel, to: e.target.value })} />
              <input placeholder="from (default alerts@agentsre.dev)" value={channel.from} onChange={(e) => setChannel({ ...channel, from: e.target.value })} />
            </div>
          ) : null}
          <button disabled={busy} onClick={addChannel}>Add channel</button>
        </div>
      </div>
    </div>
  );
}
