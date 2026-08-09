"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AlertActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(action: "ack" | "resolve") {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts/${id}/${action}`, { method: "POST" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8 }}>
      {status === "open" ? (
        <button className="secondary" disabled={busy} onClick={() => act("ack")}>
          Acknowledge
        </button>
      ) : null}
      {status !== "resolved" ? (
        <button className="secondary" disabled={busy} onClick={() => act("resolve")}>
          Resolve
        </button>
      ) : null}
    </div>
  );
}
