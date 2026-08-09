import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertChannel, AlertDispatchMessage } from "@agentsre/shared";
import { dispatchToChannel } from "../src/index.js";

const payload: AlertDispatchMessage = {
  alertId: "alrt_1",
  orgId: "org_1",
  featureId: "checkout",
  type: "latency",
  severity: "critical",
  message: "latency 20000ms exceeds baseline p99 800ms",
  runId: "run_1",
  openedAt: "2026-08-09T14:00:00.000Z",
  status: "open",
  channels: [],
};

const env = { DB: {} as never, RESEND_API_KEY: "re_test" };

function channel(type: AlertChannel["type"], config: Record<string, string>): AlertChannel {
  return { id: "chan_1", orgId: "org_1", name: "c", type, config, enabled: true, createdAt: "2026-08-09T00:00:00.000Z" };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchToChannel", () => {
  it("posts a Slack message with severity-colored attachment", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(channel("slack_webhook", { url: "https://hooks.slack.com/services/x" }), payload, env as never);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/x");
    const body = JSON.parse(String(init.body)) as { text: string; attachments: Array<{ color: string; fields: unknown[] }> };
    expect(body.text).toContain("[CRITICAL] checkout");
    expect(body.attachments[0]!.color).toBe("#e01e5a");
  });

  it("triggers a PagerDuty event with the alert id as dedup key", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(channel("pagerduty", { serviceKey: "routing_key_1" }), payload, env as never);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(String(init.body)) as { routing_key: string; event_action: string; dedup_key: string; payload: { severity: string } };
    expect(body.routing_key).toBe("routing_key_1");
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe("alrt_1");
    expect(body.payload.severity).toBe("critical");
  });

  it("maps warning severity for PagerDuty", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(
      channel("pagerduty", { serviceKey: "k" }),
      { ...payload, severity: "warning" },
      env as never,
    );
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { payload: { severity: string } };
    expect(body.payload.severity).toBe("warning");
  });

  it("forwards the full payload to a generic webhook", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(channel("webhook", { url: "https://example.com/hook" }), payload, env as never);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    const body = JSON.parse(String(init.body)) as AlertDispatchMessage;
    expect(body.alertId).toBe("alrt_1");
    expect(body.message).toContain("exceeds baseline");
  });

  it("sends email via Resend when configured", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(
      channel("email_resend", { to: "eng@corp.com", from: "alerts@agentsre.dev" }),
      payload,
      env as never,
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body)) as { from: string; to: string[]; subject: string };
    expect(body.to).toEqual(["eng@corp.com"]);
    expect(body.subject).toContain("checkout");
  });

  it("skips email when Resend is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(channel("email_resend", { to: "x@y.z" }), payload, { DB: {}, RESEND_API_KEY: undefined } as never);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-2xx so the queue retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(
      dispatchToChannel(channel("slack_webhook", { url: "https://hooks.slack.com/x" }), payload, env as never),
    ).rejects.toThrow(/slack 500/);
  });

  it("no-ops without a configured URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToChannel(channel("slack_webhook", {}), payload, env as never);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
