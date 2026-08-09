import { apiAuthHeaders } from "@/lib/auth";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = process.env.AGENTSRE_API_URL ?? "http://localhost:8788";
  const auth = await apiAuthHeaders();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...auth,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `$${v.toFixed(v < 0.01 ? 4 : 2)}`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `${(v * 100).toFixed(1)}%`;
}
