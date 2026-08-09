import { api } from "@/lib/api";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { name } = (await req.json()) as { name?: string };
  try {
    const data = await api("/v1/api-keys", { method: "POST", body: JSON.stringify({ name: name ?? "web" }) });
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
