import type { ToolDef } from "./providers.js";

/**
 * Built-in tool stack for the synthetic runner. V1 ships a minimal,
 * security-conscious set: fetch_url (allowlisted, size-capped, text
 * extracted) and current_datetime. The loop is tool-extensible.
 */

export interface ToolContext {
  /** Hosts the agent may fetch; "any" disables the allowlist (not recommended). */
  allowedHosts: string[] | "any";
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Static request headers from the check config (auth'd targets). */
  headers?: Record<string, string>;
}

export interface ToolExecution {
  ok: boolean;
  output: unknown;
  error?: string;
}

const TEXT_TAGS_TO_KEEP = new Set(["p", "h1", "h2", "h3", "h4", "li", "td", "th", "pre", "code", "blockquote", "title", "a", "strong", "em", "b", "i"]);

function stripHtml(html: string): string {
  const lower = html.toLowerCase();
  const keep = new Set(TEXT_TAGS_TO_KEEP);
  const out: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const before = html.slice(last, m.index).replace(/\s+/g, " ").trim();
    if (before) out.push(before);
    const name = m[1]!.toLowerCase();
    if (keep.has(name) && !m[0]!.startsWith("</")) out.push("\n");
    if (name === "script" || name === "style" || name === "noscript" || name === "svg") {
      const close = html.indexOf(`</${name}`, m.index);
      if (close !== -1) {
        html = html.slice(0, m.index) + " " + html.slice(close + name.length + 3);
      }
    }
    last = tagRe.lastIndex;
  }
  const tail = html.slice(last).replace(/\s+/g, " ").trim();
  if (tail) out.push(tail);
  return out
    .join(" ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 60_000);
}

function hostOf(url: URL): string {
  return url.hostname;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecution> {
  try {
    switch (name) {
      case "current_datetime": {
        return {
          ok: true,
          output: { iso: new Date().toISOString(), utc: new Date().toUTCString() },
        };
      }
      case "fetch_url": {
        const urlStr = String(args.url ?? "");
        let url: URL;
        try {
          url = new URL(urlStr);
        } catch {
          return { ok: false, output: null, error: `invalid url: ${urlStr.slice(0, 200)}` };
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return { ok: false, output: null, error: "only http(s) allowed" };
        }
        if (ctx.allowedHosts !== "any") {
          const host = hostOf(url);
          const allowed =
            ctx.allowedHosts.includes(host) ||
            ctx.allowedHosts.some((h) => h.startsWith(".") && host.endsWith(h)) ||
            ctx.allowedHosts.some((h) => host === h);
          if (!allowed) {
            return { ok: false, output: null, error: `host ${host} not in allowed list` };
          }
        }
        const maxBytes = ctx.maxBytes ?? 256 * 1024;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15_000);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            redirect: "follow",
            headers: ctx.headers,
          });
          if (!res.ok) {
            return { ok: false, output: null, error: `http ${res.status}` };
          }
          const contentType = res.headers.get("content-type") ?? "";
          const buf = await res.arrayBuffer();
          if (buf.byteLength > maxBytes) {
            return { ok: false, output: null, error: `response exceeded ${maxBytes} bytes` };
          }
          const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
          const text = new TextDecoder().decode(buf).slice(0, 200_000);
          return {
            ok: true,
            output: {
              url: res.url,
              status: res.status,
              contentType,
              text: isHtml ? stripHtml(text) : text.slice(0, 8000),
            },
          };
        } finally {
          clearTimeout(timeout);
        }
      }
      default:
        return { ok: false, output: null, error: `unknown tool: ${name}` };
    }
  } catch (e) {
    return {
      ok: false,
      output: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const DEFAULT_TOOLS: ToolDef[] = [
  {
    name: "fetch_url",
    description:
      "Fetch a web page and return its text content. Use this to inspect the page the user asked you to verify. Only https:// URLs are allowed.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL to fetch" } },
      required: ["url"],
    },
  },
  {
    name: "current_datetime",
    description: "Returns the current date and time in UTC. Use for time-sensitive checks.",
    inputSchema: { type: "object", properties: {} },
  },
];
