"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CheckActions({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/checks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this check?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/checks/${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button className="secondary" disabled={busy} onClick={toggle}>
        {enabled ? "Disable" : "Enable"}
      </button>
      <button className="secondary" disabled={busy} onClick={remove}>
        Delete
      </button>
    </div>
  );
}
