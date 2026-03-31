import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const notifierChannelSchema = z.enum(["desktop", "webhook"]);
const notifierLevelSchema = z.enum(["info", "warn", "critical"]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const notifierSendSchema = z.object({
  mutation: mutationSchema,
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  subtitle: z.string().max(200).optional(),
  level: notifierLevelSchema.default("info"),
  channels: z.array(notifierChannelSchema).max(4).optional(),
  webhook_url: z.string().url().optional(),
  dedupe_key: z.string().max(200).optional(),
  ...sourceSchema.shape,
});

type NotifierSendInput = z.infer<typeof notifierSendSchema>;

type NotificationDeliveryResult = {
  channel: "desktop" | "webhook";
  ok: boolean;
  dry_run: boolean;
  error?: string;
  status_code?: number | null;
};

function dedupeStrings(items: Iterable<string>) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of items) {
    const item = String(raw ?? "").trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    ordered.push(item);
  }
  return ordered;
}

function compactText(text: string, limit = 240) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  if (single.length <= limit) {
    return single;
  }
  if (limit <= 3) {
    return single.slice(0, limit);
  }
  return `${single.slice(0, limit - 3)}...`;
}

function dryRunEnabled() {
  return process.env.MCP_NOTIFIER_DRY_RUN === "1";
}

function deliverDesktopNotification(input: NotifierSendInput): NotificationDeliveryResult {
  if (dryRunEnabled()) {
    return { channel: "desktop", ok: true, dry_run: true };
  }

  const title = compactText(input.title, 120);
  const message = compactText(input.message, 320);
  const subtitle = compactText(input.subtitle || input.level.toUpperCase(), 120);

  if (process.platform === "darwin") {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(
      subtitle
    )}`;
    const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    if (result.status === 0) {
      return { channel: "desktop", ok: true, dry_run: false };
    }
    return {
      channel: "desktop",
      ok: false,
      dry_run: false,
      error: compactText(result.stderr || result.stdout || `osascript exit=${result.status}`, 200),
    };
  }

  const notifySend = spawnSync("notify-send", [title, message], { encoding: "utf8" });
  if (notifySend.status === 0) {
    return { channel: "desktop", ok: true, dry_run: false };
  }
  return {
    channel: "desktop",
    ok: false,
    dry_run: false,
    error: compactText(notifySend.stderr || notifySend.stdout || "desktop notifications unavailable", 200),
  };
}

async function deliverWebhookNotification(input: NotifierSendInput): Promise<NotificationDeliveryResult> {
  const webhookUrl = String(input.webhook_url || process.env.MCP_ALERT_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    return {
      channel: "webhook",
      ok: false,
      dry_run: dryRunEnabled(),
      error: "webhook_url is required for webhook notifications",
    };
  }
  if (dryRunEnabled()) {
    return { channel: "webhook", ok: true, dry_run: true };
  }
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        message: input.message,
        subtitle: input.subtitle ?? null,
        level: input.level,
        dedupe_key: input.dedupe_key ?? null,
        source_client: input.source_client ?? null,
        source_model: input.source_model ?? null,
        source_agent: input.source_agent ?? null,
        created_at: new Date().toISOString(),
      }),
    });
    if (response.ok) {
      return { channel: "webhook", ok: true, dry_run: false, status_code: response.status };
    }
    return {
      channel: "webhook",
      ok: false,
      dry_run: false,
      status_code: response.status,
      error: compactText(await response.text(), 200) || `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      channel: "webhook",
      ok: false,
      dry_run: false,
      error: compactText(error instanceof Error ? error.message : String(error), 200),
    };
  }
}

export async function sendNotification(input: NotifierSendInput) {
  const channels = dedupeStrings(input.channels ?? ["desktop"]).filter((entry): entry is "desktop" | "webhook" =>
    entry === "desktop" || entry === "webhook"
  );
  const deliveries: NotificationDeliveryResult[] = [];
  for (const channel of channels) {
    if (channel === "desktop") {
      deliveries.push(deliverDesktopNotification(input));
      continue;
    }
    deliveries.push(await deliverWebhookNotification(input));
  }
  return {
    title: input.title,
    message: compactText(input.message, 400),
    subtitle: input.subtitle ?? null,
    level: input.level,
    dedupe_key: input.dedupe_key ?? null,
    deliveries,
    delivered: deliveries.some((entry) => entry.ok),
    sent_at: new Date().toISOString(),
  };
}

export async function notifierSend(storage: Storage, input: NotifierSendInput) {
  return runIdempotentMutation({
    storage,
    tool_name: "notifier.send",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const result = await sendNotification(input);
      storage.appendRuntimeEvent({
        event_type: result.delivered ? "notification.sent" : "notification.failed",
        status: result.delivered ? "sent" : "failed",
        summary: compactText(`${input.title}: ${input.message}`, 200),
        content: result.message,
        details: {
          title: input.title,
          subtitle: input.subtitle ?? null,
          level: input.level,
          dedupe_key: input.dedupe_key ?? null,
          deliveries: result.deliveries,
        },
        source_client: input.source_client ?? "notifier.send",
        source_model: input.source_model,
        source_agent: input.source_agent ?? "ring-leader",
      });
      return {
        ok: result.delivered,
        ...result,
      };
    },
  });
}
