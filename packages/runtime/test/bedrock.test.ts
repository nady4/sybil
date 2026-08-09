import { describe, expect, it, vi } from "vitest";
import { createBedrockProvider, sha256Hex, signAwsSigV4, type ChatRequest } from "../src/index.js";

/**
 * AWS Signature Version 4 — official test suite vector
 * (AWS docs, "Signature Version 4 signing process", canonical request example).
 */
describe("signAwsSigV4", () => {
  it("matches the AWS IAM test-suite vector", async () => {
    const url = new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08");
    const headers = {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      host: "iam.amazonaws.com",
      "x-amz-date": "20150830T123600Z",
    };
    const auth = await signAwsSigV4({
      method: "GET",
      url,
      headers,
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256("")
      service: "iam",
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
    });
    // AWS docs expected signature for this canonical request:
    expect(auth).toContain("Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
    expect(auth).toContain("Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request");
  });

  it("recomputes the canonical-request hash shown in the AWS docs", async () => {
    // The docs' example string-to-sign contains the hashed canonical request:
    // f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59
    const url = new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08");
    const canonical = [
      "GET",
      "/",
      "Action=ListUsers&Version=2010-05-08",
      "content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:iam.amazonaws.com\nx-amz-date:20150830T123600Z\n",
      "content-type;host;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n");
    expect(await sha256Hex(canonical)).toBe("f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59");
  });
});

describe("createBedrockProvider", () => {
  it("signs InvokeModel requests with SigV4 and parses Anthropic responses", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      };
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Bedrock says hi" }],
          usage: { input_tokens: 10, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = createBedrockProvider(
      JSON.stringify({ accessKeyId: "AKIDTEST", secretAccessKey: "secret", region: "us-west-2" }),
      fetchImpl as unknown as typeof fetch,
    );
    const req: ChatRequest = {
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      system: "be brief",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 100,
    };
    const result = await provider.complete(req);

    expect(captured!.url).toContain("bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke");
    expect(captured!.headers["authorization"]).toContain("Credential=AKIDTEST/");
    expect(captured!.headers["authorization"]).toContain("/us-west-2/bedrock/aws4_request");
    expect(captured!.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(captured!.body) as { anthropic_version: string; max_tokens: number; messages: unknown[] };
    expect(body.anthropic_version).toBe("2023-06-01");
    expect(body.max_tokens).toBe(100);
    expect(result.content).toBe("Bedrock says hi");
    expect(result.usage.inputTokens).toBe(10);
  });

  it("rejects malformed credentials", () => {
    expect(() => createBedrockProvider("not-json")).toThrow(/JSON/);
    expect(() => createBedrockProvider('{"accessKeyId":"a"}')).toThrow(/secretAccessKey/);
  });
});
