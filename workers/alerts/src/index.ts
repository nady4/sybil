import type { AlertChannel, AlertDispatchMessage } from "@agentsre/shared";

export interface Env {
  DB: D1Database;
  RESEND_API_KEY?: string;
}

/**
 * Alert dispatcher. Consumes the alerts queue and fans out to the org's
 * configured channels: Slack webhook, PagerDuty Events API v2, generic
 * webhook, Resend email. Throw -> queue retry; mark delivered on success.
 */

const PAGERDUTY_URL = "https://events.pagerduty.com/v2/enqueue";
const RESEND_URL = "https://api.resend.com/emails";

/** Dispatch one alert to one channel. Throws on non-2xx so the queue retries. */
export async function dispatchToChannel(channel: AlertChannel, payload: AlertDispatchMessage, env: Env): Promise<void> {
  const summary = `[${payload.severity.toUpperCase()}] ${payload.featureId}: ${payload.message}`;
  switch (channel.type) {
    case "slack_webhook": {
      const url = channel.config.url;
      if (!url) return;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: summary,
          attachments: [
            {
              color: payload.severity === "critical" ? "#e01e5a" : "#e0a51e",
              fields: [
                { title: "Alert", value: payload.alertId, short: true },
                { title: "Type", value: payload.type, short: true },
                { title: "Feature", value: payload.featureId, short: true },
                { title: "Model", value: payload.model ?? "-", short: true },
                ...(payload.runId ? [{ title: "Run", value: payload.runId, short: true }] : []),
              ],
              fallback: summary,
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`slack ${res.status}`);
      return;
    }
    case "pagerduty": {
      const serviceKey = channel.config.serviceKey;
      if (!serviceKey) return;
      const res = await fetch(PAGERDUTY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routing_key: serviceKey,
          event_action: "trigger",
          payload: {
            summary: summary.slice(0, 1024),
            source: "agentsre",
            severity: payload.severity === "critical" ? "critical" : "warning",
            custom_details: { alertId: payload.alertId, type: payload.type, featureId: payload.featureId, runId: payload.runId },
          },
          dedup_key: payload.alertId,
        }),
      });
      if (!res.ok) throw new Error(`pagerduty ${res.status}`);
      return;
    }
    case "webhook": {
      const url = channel.config.url;
      if (!url) return;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
      return;
    }
    case "email_resend": {
      if (!env.RESEND_API_KEY) return;
      const to = channel.config.to;
      const from = channel.config.from ?? "alerts@agentsre.dev";
      if (!to) return;
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from,
          to: to.split(",").map((s) => s.trim()),
          subject: summary.slice(0, 200),
          text: `Alert ${payload.alertId}\n\nFeature: ${payload.featureId}\nType: ${payload.type}\nSeverity: ${payload.severity}\nMessage: ${payload.message}\nOpened: ${payload.openedAt}`,
        }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}`);
      return;
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "agentsre-alerts" });
  },
  async queue(batch: MessageBatch<AlertDispatchMessage>, env: Env): Promise<void> {
    if (batch.queue === "agentsre-alerts-dlq") {
      for (const msg of batch.messages) {
        await env.DB.prepare(
          "INSERT INTO failed_deliveries (id, queue, body) VALUES (?, 'agentsre-alerts', ?)",
        )
          .bind(`fd_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`, JSON.stringify(msg.body).slice(0, 100_000))
          .run();
      }
      return;
    }
    for (const msg of batch.messages) {
      const payload = msg.body;
      let delivered = 0;
      const channels: AlertChannel[] = payload.channels ?? [];
      for (const channel of channels) {
        try {
          await dispatchToChannel(channel, payload, env);
          delivered++;
        } catch (e) {
          console.error(`dispatch failed for ${payload.alertId} via ${channel.name}: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (delivered > 0) {
        await env.DB.prepare("UPDATE alerts SET delivered_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), payload.alertId)
          .run();
      } else if (channels.length > 0) {
        throw new Error(`no channel delivered for ${payload.alertId}`);
      }
    }
  },
};
