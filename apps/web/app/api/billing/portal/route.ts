import { api } from "@/lib/api";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const data = await api("/v1/billing/portal", { method: "POST", body: "{}" });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
