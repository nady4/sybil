import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliAuth {
  baseUrl: string;
  apiKey: string;
}

const AUTH_PATH = join(homedir(), ".agentsre.json");

export function loadAuth(): CliAuth | undefined {
  try {
    if (!existsSync(AUTH_PATH)) return undefined;
    const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as CliAuth;
    if (!raw.apiKey) return undefined;
    return { baseUrl: raw.baseUrl ?? "https://api.agentsre.dev", apiKey: raw.apiKey };
  } catch {
    return undefined;
  }
}

export function saveAuth(auth: CliAuth): void {
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function defaultBaseUrl(): string {
  return process.env.AGENTSRE_API_URL ?? "https://api.agentsre.dev";
}
