"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ApiKeyForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");

  async function create() {
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || "web" }),
      });
      const data = (await res.json()) as { apiKey?: { key: string; name: string }; error?: string };
      if (!res.ok || !data.apiKey) throw new Error(data.error ?? `${res.status}`);
      setCreated(data.apiKey.key);
      setName("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder="key name (e.g. ci)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="secondary" disabled={busy} onClick={create}>
          Create key
        </button>
      </div>
      {error ? <div className="error" style={{ marginTop: 8 }}>{error}</div> : null}
      {created ? (
        <div style={{ marginTop: 12 }}>
          <div className="label" style={{ marginBottom: 4 }}>Key created — copy it now, it is shown once:</div>
          <code className="mono" style={{ background: "var(--bg)", padding: "8px 10px", borderRadius: 8, display: "block", wordBreak: "break-all" }}>
            {created}
          </code>
        </div>
      ) : null}
    </div>
  );
}
