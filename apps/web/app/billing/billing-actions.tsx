"use client";

import { useState } from "react";

const PLANS = [
  { id: "indie", price: 39, checks: 25 },
  { id: "team", price: 149, checks: 100 },
  { id: "enterprise", price: 499, checks: 1000 },
] as const;

export default function BillingActions({ currentPlan }: { currentPlan: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout(plan: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? `${res.status}`);
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function portal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? `${res.status}`);
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {PLANS.map((p) => (
          <div key={p.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600 }}>{p.id}</span>
              {currentPlan === p.id ? <span className="pill success">current</span> : null}
            </div>
            <div style={{ fontSize: 22, fontWeight: 650 }}>${p.price}<span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>/mo</span></div>
            <div className="muted">{p.checks} checks</div>
            <button className="secondary" disabled={busy || currentPlan === p.id} onClick={() => checkout(p.id)}>
              {currentPlan === p.id ? "Current plan" : "Upgrade"}
            </button>
          </div>
        ))}
      </div>
      <button className="secondary" disabled={busy} onClick={portal} style={{ marginTop: 16 }}>
        Manage subscription (Stripe portal)
      </button>
    </div>
  );
}
