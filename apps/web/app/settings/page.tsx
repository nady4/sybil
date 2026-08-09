import { api } from "@/lib/api";
import SettingsForms from "./settings-forms";
import ApiKeyForm from "./api-key-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let keys: Array<{ provider: string; label: string | null }> = [];
  let channels: Array<{ id: string; name: string; type: string; config: Record<string, string> }> = [];
  let apiKeys: Array<{ id: string; name: string; key_prefix: string; created_at: string }> = [];
  let error: string | null = null;
  try {
    const [keysRes, channelsRes, apiKeysRes] = await Promise.all([
      api<{ providerKeys: typeof keys }>("/v1/provider-keys"),
      api<{ channels: typeof channels }>("/v1/alert-channels"),
      api<{ apiKeys: typeof apiKeys }>("/v1/api-keys"),
    ]);
    keys = keysRes.providerKeys;
    channels = channelsRes.channels;
    apiKeys = apiKeysRes.apiKeys;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Settings</h1>
      {error ? <div className="error">api: {error}</div> : null}

      <h2>API keys</h2>
      {apiKeys.length > 0 ? (
        <table style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="mono">{k.key_prefix}…</td>
                <td className="muted">{k.created_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty" style={{ marginBottom: 12 }}>No API keys yet — create one for the SDK or CLI.</div>
      )}
      <ApiKeyForm />

      <h2>Provider keys & alert channels</h2>
      {!error ? <SettingsForms existingKeys={keys} existingChannels={channels} /> : null}
    </div>
  );
}
