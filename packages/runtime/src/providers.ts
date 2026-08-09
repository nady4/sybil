import type { Usage } from "@agentsre/shared";

/**
 * Provider abstraction. Raw HTTP against the chat completions APIs —
 * no SDK dependencies (a liability solo, and SDKs bloat Workers bundles).
 * Bedrock is a stub behind the same seam.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that made tool calls. */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** Present on tool result messages; matches the assistant tool call id. */
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
}

export interface ChatResult {
  content?: string;
  refusal: boolean;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage: Usage;
  latencyMs: number;
}

export interface Provider {
  complete(req: ChatRequest): Promise<ChatResult>;
}

const REFUSAL_PATTERNS: Array<{ re: RegExp; text: string }> = [
  { re: /\bi('| )?m (sorry|afraid|not able|unable|can'?t) /i, text: "apology" },
  { re: /\bi (can'?t|cannot|won'?t|will not) (assist|help|do|provide|comply|answer)/i, text: "refusal" },
  { re: /\bcannot (assist|help|complete|fulfill)/i, text: "refusal" },
  { re: /\bnot (able|allowed|permitted) to (assist|help|do|provide|share)/i, text: "refusal" },
];

export function detectRefusal(text: string | undefined): { refused: boolean; reason?: string } {
  if (!text) return { refused: false };
  for (const { re, text: label } of REFUSAL_PATTERNS) {
    if (re.test(text)) return { refused: true, reason: `heuristic:${label}` };
  }
  return { refused: false };
}

export interface ProviderOptions {
  /** Base URL override (self-hosted gateways, proxies, tests). */
  baseUrl?: string;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function resolveEndpoint(baseUrl: string | undefined, defaultUrl: string, path: string): string {
  if (!baseUrl) return defaultUrl;
  if (baseUrl.endsWith(path)) return baseUrl;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function createOpenAiProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  opts: ProviderOptions = {},
): Provider {
  const baseUrl = resolveEndpoint(opts.baseUrl, OPENAI_URL, "/v1/chat/completions");
  return {
    async complete(req) {
      const started = Date.now();
      const serialized: Record<string, unknown>[] = [];
      if (req.system && !req.messages.some((m) => m.role === "system")) {
        serialized.push({ role: "system", content: req.system });
      }
      for (const m of req.messages) {
        if (m.role === "assistant" && m.toolCalls?.length) {
          serialized.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          });
        } else if (m.role === "tool") {
          serialized.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
        } else {
          serialized.push({ role: m.role, content: m.content });
        }
      }
      const body: Record<string, unknown> = {
        model: req.model,
        messages: serialized,
        max_tokens: req.maxTokens ?? 1024,
      };
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }
      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`openai ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; refusal?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      const message = data.choices?.[0]?.message;
      const usage = data.usage;
      const toolCalls = (message?.tool_calls ?? []).map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = { _raw: tc.function.arguments };
        }
        return { id: tc.id, name: tc.function.name, args };
      });
      const refusal = Boolean(message?.refusal) || detectRefusal(message?.content ?? undefined).refused;
      return {
        content: message?.content ?? undefined,
        refusal,
        toolCalls,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
        },
        latencyMs: Date.now() - started,
      };
    },
  };
}

/** Shared Anthropic-format body builder (Anthropic API + Bedrock Claude). */
export function buildAnthropicBody(req: ChatRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          })),
        ],
      });
    } else if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? 1024,
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
  return body;
}

interface AnthropicData {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/** Shared Anthropic-format response parser (Anthropic API + Bedrock Claude). */
export function parseAnthropicResponse(data: unknown): Omit<ChatResult, "latencyMs"> {
  const d = data as AnthropicData;
  const text = d.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") || undefined;
  const toolCalls = (d.content ?? [])
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "tc_0",
      name: b.name ?? "",
      args: (b.input as Record<string, unknown>) ?? {},
    }));
  return {
    content: text,
    refusal: detectRefusal(text).refused || d.stop_reason === "refusal",
    toolCalls,
    usage: {
      inputTokens: d.usage?.input_tokens ?? 0,
      outputTokens: d.usage?.output_tokens ?? 0,
    },
  };
}

export function createAnthropicProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  opts: ProviderOptions = {},
): Provider {
  const baseUrl = resolveEndpoint(opts.baseUrl, ANTHROPIC_URL, "/v1/messages");
  return {
    async complete(req) {
      const started = Date.now();
      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(buildAnthropicBody(req)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`anthropic ${res.status}: ${detail.slice(0, 300)}`);
      }
      return { ...parseAnthropicResponse(await res.json()), latencyMs: Date.now() - started };
    },
  };
}

// ---------------------------------------------------------------------------
// AWS SigV4 (Bedrock)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = new TextEncoder().encode(data) as Uint8Array<ArrayBuffer>;
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/**
 * AWS Signature Version 4. Header values must already be canonicalized
 * (trimmed, internal whitespace collapsed). Query string must be encoded
 * and sorted. Exported for the official AWS test-suite vectors.
 */
export async function signAwsSigV4(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
}): Promise<string> {
  const { method, url, headers, payloadHash, service, region, accessKeyId, secretAccessKey, amzDate } = opts;
  const dateStamp = amzDate.slice(0, 8);

  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names.map((k) => `${k}:${headers[k]!.trim()}\n`).join("");
  const signedHeaderNames = names.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    url.search.slice(1),
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${region}/${service}/aws4_request`,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/**
 * Bedrock Claude via InvokeModel. The provider key is a JSON blob:
 * {"accessKeyId":"...","secretAccessKey":"...","region":"us-east-1"}
 * Requests use the Anthropic message format (identical to the Anthropic
 * API), signed with SigV4.
 */
export function createBedrockProvider(
  credentialsJson: string,
  fetchImpl: typeof fetch = fetch,
): Provider {
  let creds: AwsCredentials;
  try {
    creds = JSON.parse(credentialsJson) as AwsCredentials;
  } catch {
    throw new Error("bedrock provider key must be JSON: {\"accessKeyId\", \"secretAccessKey\", \"region\"}");
  }
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error("bedrock provider key missing accessKeyId/secretAccessKey");
  }
  const region = creds.region ?? "us-east-1";
  const service = "bedrock";

  return {
    async complete(req) {
      const started = Date.now();
      const body = buildAnthropicBody(req);
      body.anthropic_version = "2023-06-01";
      const payload = JSON.stringify(body);
      const url = new URL(
        `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(req.model)}/invoke`,
      );
      const amzDate = new Date().toISOString().replace(/\.\d{3}/g, "").replace(/[-:]/g, "");
      const payloadHash = await sha256Hex(payload);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        host: url.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      };
      const authorization = await signAwsSigV4({
        method: "POST",
        url,
        headers,
        payloadHash,
        service,
        region,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        amzDate,
      });

      const res = await fetchImpl(url, {
        method: "POST",
        headers: { ...headers, authorization },
        body: payload,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`bedrock ${res.status}: ${detail.slice(0, 300)}`);
      }
      return { ...parseAnthropicResponse(await res.json()), latencyMs: Date.now() - started };
    },
  };
}

export function createProvider(
  provider: "openai" | "anthropic" | "bedrock",
  apiKey: string,
  opts: ProviderOptions = {},
): Provider {
  switch (provider) {
    case "openai":
      return createOpenAiProvider(apiKey, fetch, opts);
    case "anthropic":
      return createAnthropicProvider(apiKey, fetch, opts);
    case "bedrock":
      return createBedrockProvider(apiKey);
  }
}
