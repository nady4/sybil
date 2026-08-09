"use client";

import { useState } from "react";

export default function CheckForm({ channels }: { channels: Array<{ id: string; name: string; type: string }> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    featureId: "",
    name: "",
    prompt: "",
    target: "",
    intervalMinutes: "15",
    model: "gpt-4o-mini",
    alertChannelIds: [] as string[],
  });

  function toggleChannel(id: string) {
    setForm({
      ...form,
      alertChannelIds: form.alertChannelIds.includes(id)
        ? form.alertChannelIds.filter((c) => c !== id)
        : [...form.alertChannelIds, id],
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          intervalMinutes: Number(form.intervalMinutes),
          alertChannelIds: form.alertChannelIds,
          successCriteria: [
            { name: "goal-achieved", assertion: { type: "llm_judge", rubric: "The assistant achieved the user's stated goal.", minScore: 0.7 } },
          ],
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `${res.status}`);
      setForm({ featureId: "", name: "", prompt: "", target: "", intervalMinutes: "15", model: "gpt-4o-mini", alertChannelIds: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        Feature id
        <input
          value={form.featureId}
          onChange={(e) => setForm({ ...form, featureId: e.target.value })}
          placeholder="checkout"
          required
        />
      </label>
      <label>
        Name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="checkout-works" required />
      </label>
      <label>
        Prompt
        <textarea
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          placeholder="Verify a guest can complete a single-item order at checkout."
          required
        />
      </label>
      <label>
        Target URL
        <input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="https://shop.example.com/checkout" />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label>
          Interval (min)
          <input
            type="number"
            min={5}
            max={1440}
            value={form.intervalMinutes}
            onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
          />
        </label>
        <label>
          Model
          <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
            <option>gpt-4o-mini</option>
            <option>gpt-4o</option>
            <option>gpt-4.1-mini</option>
            <option>claude-sonnet-4-5</option>
            <option>claude-haiku-4-5</option>
          </select>
        </label>
      </div>
      {channels.length > 0 ? (
        <label>
          Alert channels
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {channels.map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={form.alertChannelIds.includes(c.id)}
                  onChange={() => toggleChannel(c.id)}
                />
                {c.name} <span className="muted mono" style={{ fontSize: 11 }}>({c.type})</span>
              </label>
            ))}
          </div>
        </label>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          No alert channels yet — add one in Settings to get notified.
        </div>
      )}
      {error ? <div className="error">{error}</div> : null}
      <div style={{ display: "flex", gap: 10 }}>
        <button disabled={busy}>{busy ? "creating…" : "Create check"}</button>
      </div>
    </form>
  );
}
