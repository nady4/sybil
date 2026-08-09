#!/usr/bin/env node
/**
 * Mock OpenAI-compatible chat completions server for local E2E of the
 * synthetic runner (no real provider key needed).
 *
 * Behavior:
 *  - POST /v1/chat/completions: if the last message is a tool result,
 *    answer as if the goal was achieved; otherwise call fetch_url.
 *  - GET /page: HTML page containing "Order confirmed".
 *
 * Usage: node scripts/mock-openai.mjs  (defaults to port 8786)
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8786);

const PAGE = `<html><head><title>Shop</title></head><body>
  <h1>Checkout</h1>
  <p>Your order ORD-12345 is confirmed. Thank you for shopping with us.</p>
</body></html>`;

function completions(messages) {
  const last = messages.at(-1);
  const hasToolResult = messages.some((m) => m.role === "tool");
  const isJudge = messages.some((m) => m.role === "system" && String(m.content).includes("evaluation judge"));
  const echoed = messages.some((m) => m.role === "tool" && String(m.content).includes("hdr-secret-123"));

  let content = null;
  let toolCalls = null;
  if (isJudge) {
    content = "0.9";
  } else if (echoed) {
    content = "The endpoint echoed the header: hdr-secret-123.";
  } else if (hasToolResult) {
    content =
      "The checkout page loads successfully and states: 'Your order ORD-12345 is confirmed.' " +
      "The order confirmation is visible, so a guest can complete a single-item order.";
  } else if (last) {
    toolCalls = [
      {
        id: "call_mock1",
        type: "function",
        function: { name: "fetch_url", arguments: JSON.stringify({ url: "http://localhost:8786/echo" }) },
      },
    ];
  }

  return {
    id: "chatcmpl_mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content, tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 420, completion_tokens: 96, total_tokens: 516 },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.method === "GET" && url.pathname === "/echo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ received: req.headers["x-test-header"] ?? "missing" }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let messages = [];
      try {
        messages = JSON.parse(body).messages ?? [];
      } catch {
        /* fall through with empty messages */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completions(messages)));
    });
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

server.listen(PORT, () => {
  console.log(`mock-openai listening on :${PORT} (POST /v1/chat/completions, GET /page)`);
});
