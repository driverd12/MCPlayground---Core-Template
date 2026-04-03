import crypto from "node:crypto";
import { z } from "zod";
import { type ReactionEngineNotificationRecord, type ReactionEngineStateRecord, Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { sendNotification } from "./notifier.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const reactionChannelSchema = z.enum(["desktop", "webhook"]);

export const reactionEngineSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    dedupe_window_seconds: z.number().int().min(30).max(604800).optional(),
    channels: z.array(reactionChannelSchema).max(4).optional(),
    webhook_url: z.string().url().optional(),
    publish_runtime_event: z.boolean().default(true),
    run_immediately: z.boolean().optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, and run_once actions",
        path: ["mutation"],
      });
    }
  });

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
type ReactionEngineInput = z.infer<typeof reactionEngineSchema>;
type ReactionEngineConfig = {
  interval_seconds: number;
  dedupe_window_seconds: number;
  channels: Array<"desktop" | "webhook">;
  webhook_url?: string;
  publish_runtime_event: boolean;
  source_client?: string;
  source_model?: string;
  source_agent?: string;
};

type ReactionAlert = {
  key: string;
  title: string;
  message: string;
  level: "info" | "warn" | "critical";
  reasons: string[];
  fingerprint_tokens: string[];
};

const TRANSIENT_REACTION_REASONS = [
  "background autonomy maintenance is stale",
  "background autonomy maintenance is not running",
  "no eval suites are configured yet.",
  "background autonomy maintenance has not completed its first eval run yet.",
  "work is queued or ready, but no active agent sessions are available to claim it.",
  "queued work may stall because no active session is currently marked healthy by adaptive routing.",
  "all enabled worker fabric hosts are degraded; dispatch will proceed conservatively.",
  "worker fabric has no healthy hosts available.",
];

const DEFAULT_REACTION_ENGINE_CONFIG: ReactionEngineConfig = {
  interval_seconds: 120,
  dedupe_window_seconds: 1800,
  channels: ["desktop"],
  publish_runtime_event: true,
  source_client: "reaction.engine",
  source_agent: "ring-leader",
};

const reactionEngineRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  config: ReactionEngineConfig;
} = {
  running: false,
  timer: null,
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  config: { ...DEFAULT_REACTION_ENGINE_CONFIG },
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Number(value) : null;
}

function dedupeChannels(value: unknown, fallback: ReactionEngineConfig["channels"]) {
  const candidates = Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()) : fallback;
  const seen = new Set<string>();
  const channels: Array<"desktop" | "webhook"> = [];
  for (const candidate of candidates) {
    if ((candidate === "desktop" || candidate === "webhook") && !seen.has(candidate)) {
      seen.add(candidate);
      channels.push(candidate);
    }
  }
  return channels.length > 0 ? channels : [...fallback];
}

function resolveReactionEngineConfig(
  input: Partial<ReactionEngineInput>,
  fallback: ReactionEngineConfig = DEFAULT_REACTION_ENGINE_CONFIG
): ReactionEngineConfig {
  return {
    interval_seconds: Math.max(5, Math.min(3600, Math.trunc(readNumber(input.interval_seconds) ?? fallback.interval_seconds))),
    dedupe_window_seconds: Math.max(
      30,
      Math.min(604800, Math.trunc(readNumber(input.dedupe_window_seconds) ?? fallback.dedupe_window_seconds))
    ),
    channels: dedupeChannels(input.channels, fallback.channels),
    webhook_url: readString(input.webhook_url) ?? fallback.webhook_url,
    publish_runtime_event: readBoolean(input.publish_runtime_event) ?? fallback.publish_runtime_event,
    source_client: readString(input.source_client) ?? fallback.source_client,
    source_model: readString(input.source_model) ?? fallback.source_model,
    source_agent: readString(input.source_agent) ?? fallback.source_agent,
  };
}

function configFromState(
  state: ReactionEngineStateRecord | null | undefined,
  fallback: ReactionEngineConfig = DEFAULT_REACTION_ENGINE_CONFIG
): ReactionEngineConfig {
  if (!state) {
    return { ...fallback };
  }
  return {
    interval_seconds: Math.max(5, Math.min(3600, Math.trunc(readNumber(state.interval_seconds) ?? fallback.interval_seconds))),
    dedupe_window_seconds: Math.max(
      30,
      Math.min(604800, Math.trunc(readNumber(state.dedupe_window_seconds) ?? fallback.dedupe_window_seconds))
    ),
    channels: dedupeChannels(state.channels, fallback.channels),
    webhook_url: fallback.webhook_url,
    publish_runtime_event: fallback.publish_runtime_event,
    source_client: fallback.source_client,
    source_model: fallback.source_model,
    source_agent: fallback.source_agent,
  };
}

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, phase: string) {
  const safePhase = phase.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const digest = crypto
    .createHash("sha256")
    .update(`${base.idempotency_key}|${base.side_effect_fingerprint}|${safePhase}`)
    .digest("hex");
  return {
    idempotency_key: `reaction-engine-${safePhase}-${digest.slice(0, 24)}`,
    side_effect_fingerprint: `reaction-engine-${safePhase}-${digest.slice(24, 56)}`,
  };
}

function isoAgeSeconds(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - parsed) / 1000);
}

function compactText(text: string, limit = 220) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  if (single.length <= limit) {
    return single;
  }
  return limit <= 3 ? single.slice(0, limit) : `${single.slice(0, limit - 3)}...`;
}

function isBenignAttention(text: string) {
  const normalized = compactText(text, 400);
  return (
    normalized === "Kernel is progressing normally." ||
    normalized === "No actionable work is currently queued." ||
    normalized === "No eval suites are configured yet." ||
    normalized.startsWith("Recovered failed task remains in history:") ||
    normalized === "Background autonomy maintenance has not completed its first eval run yet." ||
    normalized === "Background autonomy maintenance is ready for its next eval health refresh." ||
    normalized.startsWith("Background autonomy maintenance last reported attention:") ||
    normalized === "Background autonomy maintenance eval refresh is due; the last successful baseline remains usable." ||
    /^Background autonomy maintenance currently needs attention: .*?\b(overdue|definition_changed)\b/i.test(normalized) ||
    normalized === "Reaction engine notifications are not enabled yet." ||
    normalized === "Reaction engine is enabled in storage, but the live notifier loop is not running." ||
    normalized === "Reaction engine is stale and may no longer surface human-attention alerts."
  );
}

function shouldIgnoreAttentionEntry(entry: string, context: { failedTasks: number }) {
  if (context.failedTasks > 0 && entry.startsWith("Failed task detected:")) {
    return true;
  }
  return false;
}

function pushReason(
  reasons: string[],
  fingerprintTokens: string[],
  reason: string,
  fingerprintToken: string
) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
  if (!fingerprintTokens.includes(fingerprintToken)) {
    fingerprintTokens.push(fingerprintToken);
  }
}

function attentionFingerprintToken(text: string) {
  return `attention:${normalizeReactionReason(text)
    .replace(/\b\d+\b/g, "#")
    .replace(/[a-f0-9]{8,}/g, "<id>")}`;
}

export function buildReactionAlert(kernel: Record<string, unknown>): ReactionAlert | null {
  const overview = asRecord(kernel.overview);
  const taskCounts = asRecord(overview.task_counts);
  const goalCounts = asRecord(overview.goal_counts);
  const adaptiveCounts = asRecord(overview.adaptive_session_counts);
  const autonomyMaintain = asRecord(kernel.autonomy_maintain);
  const autonomyRuntime = asRecord(autonomyMaintain.runtime);
  const failedTasks = Math.max(
    0,
    Math.trunc(readNumber(overview.failed_task_count) ?? readNumber(taskCounts.failed) ?? 0)
  );
  const attention = Array.isArray(kernel.attention) ? kernel.attention.map((entry) => compactText(String(entry ?? ""), 180)) : [];
  const actionableAttention = attention.filter(
    (entry) => entry && !isBenignAttention(entry) && !shouldIgnoreAttentionEntry(entry, { failedTasks })
  );
  const recoveredFailedHistory = attention.some((entry) => entry.startsWith("Recovered failed task remains in history:"));

  const reasons: string[] = [];
  const fingerprintTokens: string[] = [];
  let level: ReactionAlert["level"] = "warn";
  const blockedGoals = Math.max(0, Math.trunc(readNumber(goalCounts.blocked) ?? 0));
  const failedGoals = Math.max(0, Math.trunc(readNumber(goalCounts.failed) ?? 0));
  const expiredRunning = Math.max(0, Math.trunc(readNumber(overview.expired_running_task_count) ?? 0));
  const degradedSessions = Math.max(0, Math.trunc(readNumber(adaptiveCounts.degraded) ?? 0));

  if (failedTasks > 0 && !recoveredFailedHistory) {
    level = "critical";
    pushReason(reasons, fingerprintTokens, `${failedTasks} failed task(s) need triage`, "failed_tasks");
  }
  if (failedGoals > 0) {
    level = "critical";
    pushReason(reasons, fingerprintTokens, `${failedGoals} goal(s) failed`, "failed_goals");
  }
  if (blockedGoals > 0) {
    pushReason(reasons, fingerprintTokens, `${blockedGoals} goal(s) are blocked`, "blocked_goals");
  }
  if (expiredRunning > 0) {
    pushReason(reasons, fingerprintTokens, `${expiredRunning} running lease(s) expired`, "expired_running_leases");
  }
  if (degradedSessions > 0) {
    pushReason(reasons, fingerprintTokens, `${degradedSessions} active session(s) are degraded`, "degraded_sessions");
  }
  if (autonomyMaintain.enabled === true && autonomyRuntime.running === false) {
    level = "critical";
    pushReason(reasons, fingerprintTokens, "background autonomy maintenance is not running", "autonomy_maintain_not_running");
  }
  if (autonomyMaintain.stale === true) {
    pushReason(reasons, fingerprintTokens, "background autonomy maintenance is stale", "autonomy_maintain_stale");
  }
  for (const item of actionableAttention.slice(0, 2)) {
    pushReason(reasons, fingerprintTokens, item, attentionFingerprintToken(item));
  }
  if (reasons.length === 0) {
    return null;
  }

  const digest = crypto
    .createHash("sha1")
    .update(`${level}|${[...fingerprintTokens].sort().join("|")}`)
    .digest("hex")
    .slice(0, 16);
  return {
    key: `kernel-attention:${digest}`,
    title: level === "critical" ? "Agent Office needs attention" : "Agent Office warning",
    message: compactText(reasons.slice(0, 3).join(" | "), 360),
    level,
    reasons,
    fingerprint_tokens: fingerprintTokens,
  };
}

function normalizeReactionReason(reason: string) {
  return compactText(reason, 400).toLowerCase();
}

function isTransientReactionReason(reason: string) {
  const normalized = normalizeReactionReason(reason);
  return TRANSIENT_REACTION_REASONS.some((entry) => normalized === entry);
}

export function alertConfirmationThreshold(alert: ReactionAlert) {
  if (alert.reasons.length === 0) {
    return 1;
  }
  return alert.reasons.every((reason) => isTransientReactionReason(reason)) ? 2 : 1;
}

function pruneRecentNotifications(
  notifications: ReactionEngineNotificationRecord[],
  dedupeWindowSeconds: number
) {
  return notifications.filter((entry) => isoAgeSeconds(entry.sent_at) <= dedupeWindowSeconds).slice(-40);
}

export function getReactionEngineRuntimeStatus() {
  return {
    running: reactionEngineRuntime.running,
    in_tick: reactionEngineRuntime.in_tick,
    started_at: reactionEngineRuntime.started_at,
    last_tick_at: reactionEngineRuntime.last_tick_at,
    last_error: reactionEngineRuntime.last_error,
    tick_count: reactionEngineRuntime.tick_count,
    config: { ...reactionEngineRuntime.config },
  };
}

async function runReactionEngineTick(
  storage: Storage,
  invokeTool: InvokeTool,
  config: ReactionEngineConfig
) {
  const kernel = asRecord(
    await invokeTool("kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    })
  );
  const priorState = storage.getReactionEngineState();
  const recentNotifications = pruneRecentNotifications(priorState?.recent_notifications ?? [], config.dedupe_window_seconds);
  const alert = buildReactionAlert(kernel);
  const alertKey = alert?.key ?? null;
  const alertSeenCount =
    alertKey && priorState?.last_alert_key === alertKey ? Math.max(1, (priorState?.last_alert_seen_count ?? 0) + 1) : alert ? 1 : 0;
  const confirmationThreshold = alert ? alertConfirmationThreshold(alert) : 1;
  const now = new Date().toISOString();
  let sent: Array<{ channel: string; ok: boolean; dry_run?: boolean; error?: string; status_code?: number | null }> = [];
  let skipped = false;
  let pendingConfirmation = false;
  let lastSentAt = priorState?.last_sent_at ?? null;
  let lastSentCount = priorState?.last_sent_count ?? 0;
  let updatedNotifications = recentNotifications;

  if (alert) {
    const alreadySent = recentNotifications.some((entry) => entry.key === alert.key);
    if (alreadySent) {
      skipped = true;
    } else if (alertSeenCount < confirmationThreshold) {
      skipped = true;
      pendingConfirmation = true;
    } else {
      const notification = await sendNotification({
        mutation: {
          idempotency_key: "reaction-engine-internal-not-used",
          side_effect_fingerprint: "reaction-engine-internal-not-used",
        },
        title: alert.title,
        message: `${alert.message} :: open Agent Office for drill-down.`,
        subtitle: alert.level.toUpperCase(),
        level: alert.level,
        channels: config.channels,
        webhook_url: config.webhook_url,
        dedupe_key: alert.key,
        source_client: config.source_client,
        source_model: config.source_model,
        source_agent: config.source_agent,
      });
      sent = notification.deliveries;
      if (notification.delivered) {
        lastSentAt = now;
        lastSentCount += 1;
        updatedNotifications = pruneRecentNotifications(
          [
            ...recentNotifications,
            {
              key: alert.key,
              title: alert.title,
              level: alert.level,
              sent_at: now,
            },
          ],
          config.dedupe_window_seconds
        );
      }
      if (config.publish_runtime_event) {
        storage.appendRuntimeEvent({
          event_type: notification.delivered ? "reaction.engine.alert" : "reaction.engine.delivery_failed",
          status: notification.delivered ? "sent" : "failed",
          summary: alert.title,
          content: alert.message,
          details: {
            key: alert.key,
            level: alert.level,
            reasons: alert.reasons,
            deliveries: notification.deliveries,
          },
          source_client: config.source_client ?? "reaction.engine",
          source_model: config.source_model,
          source_agent: config.source_agent ?? "ring-leader",
        });
      }
    }
  }

  const persisted = storage.setReactionEngineState({
    enabled: true,
    interval_seconds: config.interval_seconds,
    dedupe_window_seconds: config.dedupe_window_seconds,
    channels: config.channels,
    last_run_at: now,
    last_sent_at: lastSentAt,
    last_sent_count: lastSentCount,
    last_alert_key: alertKey,
    last_alert_seen_count: alertSeenCount,
    recent_notifications: updatedNotifications,
    last_error: null,
  });

  return {
    ok: true,
    ran_at: now,
    alert: alert
      ? {
          key: alert.key,
          title: alert.title,
          level: alert.level,
          message: alert.message,
          reasons: alert.reasons,
        }
      : null,
    skipped,
    pending_confirmation: pendingConfirmation,
    confirmation_threshold: confirmationThreshold,
    alert_seen_count: alertSeenCount,
    sent_count: sent.filter((entry) => entry.ok).length,
    deliveries: sent,
    state: persisted,
  };
}

function clearReactionEngineTimer() {
  if (reactionEngineRuntime.timer) {
    clearInterval(reactionEngineRuntime.timer);
    reactionEngineRuntime.timer = null;
  }
}

function stopReactionEngineDaemon() {
  clearReactionEngineTimer();
  reactionEngineRuntime.running = false;
  reactionEngineRuntime.in_tick = false;
}

async function startReactionEngineDaemon(
  storage: Storage,
  invokeTool: InvokeTool,
  config: ReactionEngineConfig,
  runImmediately = false
) {
  reactionEngineRuntime.config = { ...config };
  clearReactionEngineTimer();
  reactionEngineRuntime.running = true;
  reactionEngineRuntime.started_at = reactionEngineRuntime.started_at ?? new Date().toISOString();
  reactionEngineRuntime.timer = setInterval(() => {
    void runReactionEngineTickSafe(storage, invokeTool, reactionEngineRuntime.config);
  }, config.interval_seconds * 1000);
  if (runImmediately) {
    await runReactionEngineTickSafe(storage, invokeTool, reactionEngineRuntime.config);
  }
}

async function runReactionEngineTickSafe(
  storage: Storage,
  invokeTool: InvokeTool,
  config: ReactionEngineConfig
) {
  if (reactionEngineRuntime.in_tick) {
    return {
      ok: true,
      skipped: true,
      reason: "tick-already-running",
    };
  }
  reactionEngineRuntime.in_tick = true;
  reactionEngineRuntime.last_error = null;
  try {
    const result = await runReactionEngineTick(storage, invokeTool, config);
    reactionEngineRuntime.last_tick_at = result.ran_at;
    reactionEngineRuntime.tick_count += 1;
    return result;
  } catch (error) {
    const message = compactText(error instanceof Error ? error.message : String(error), 240);
    reactionEngineRuntime.last_error = message;
    storage.setReactionEngineState({
      enabled: true,
      interval_seconds: config.interval_seconds,
      dedupe_window_seconds: config.dedupe_window_seconds,
      channels: config.channels,
      last_run_at: new Date().toISOString(),
      last_error: message,
      last_sent_at: storage.getReactionEngineState()?.last_sent_at ?? null,
      last_sent_count: storage.getReactionEngineState()?.last_sent_count ?? 0,
      recent_notifications: storage.getReactionEngineState()?.recent_notifications ?? [],
    });
    return {
      ok: false,
      skipped: false,
      error: message,
    };
  } finally {
    reactionEngineRuntime.in_tick = false;
  }
}

export function initializeReactionEngineDaemon(storage: Storage, invokeTool: InvokeTool) {
  const persisted = storage.getReactionEngineState();
  if (!persisted) {
    reactionEngineRuntime.config = { ...DEFAULT_REACTION_ENGINE_CONFIG };
    stopReactionEngineDaemon();
    return {
      restored: false,
      running: false,
      config: { ...reactionEngineRuntime.config },
    };
  }
  reactionEngineRuntime.config = configFromState(persisted, DEFAULT_REACTION_ENGINE_CONFIG);
  if (persisted.enabled) {
    void startReactionEngineDaemon(storage, invokeTool, reactionEngineRuntime.config, false);
  } else {
    stopReactionEngineDaemon();
  }
  return {
    restored: true,
    running: reactionEngineRuntime.running,
    config: { ...reactionEngineRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export async function reactionEngineControl(
  storage: Storage,
  invokeTool: InvokeTool,
  input: ReactionEngineInput
) {
  if (input.action === "status") {
    const state = storage.getReactionEngineState();
    const runtime = getReactionEngineRuntimeStatus();
    return {
      state: state ?? {
        enabled: false,
        interval_seconds: DEFAULT_REACTION_ENGINE_CONFIG.interval_seconds,
        dedupe_window_seconds: DEFAULT_REACTION_ENGINE_CONFIG.dedupe_window_seconds,
        channels: DEFAULT_REACTION_ENGINE_CONFIG.channels,
        last_run_at: null,
        last_sent_at: null,
        last_sent_count: 0,
        last_alert_key: null,
        last_alert_seen_count: 0,
        recent_notifications: [],
        last_error: null,
        updated_at: "",
      },
      runtime,
      due: {
        stale: state ? isoAgeSeconds(state.last_run_at) > Math.max(state.interval_seconds * 2, 300) : false,
      },
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "reaction.engine",
    mutation: input.mutation!,
    payload: input,
    execute: async () => {
      const persisted = storage.getReactionEngineState();
      const config = resolveReactionEngineConfig(
        input,
        persisted ? configFromState(persisted, reactionEngineRuntime.config) : reactionEngineRuntime.config
      );
      if (input.action === "stop") {
        stopReactionEngineDaemon();
        const state = storage.setReactionEngineState({
          enabled: false,
          interval_seconds: config.interval_seconds,
          dedupe_window_seconds: config.dedupe_window_seconds,
          channels: config.channels,
          last_run_at: persisted?.last_run_at ?? null,
          last_sent_at: persisted?.last_sent_at ?? null,
          last_sent_count: persisted?.last_sent_count ?? 0,
          last_alert_key: persisted?.last_alert_key ?? null,
          last_alert_seen_count: persisted?.last_alert_seen_count ?? 0,
          recent_notifications: persisted?.recent_notifications ?? [],
          last_error: null,
        });
        return {
          ok: true,
          running: false,
          state,
          runtime: getReactionEngineRuntimeStatus(),
        };
      }

      if (input.action === "start") {
        const state = storage.setReactionEngineState({
          enabled: true,
          interval_seconds: config.interval_seconds,
          dedupe_window_seconds: config.dedupe_window_seconds,
          channels: config.channels,
          last_run_at: persisted?.last_run_at ?? null,
          last_sent_at: persisted?.last_sent_at ?? null,
          last_sent_count: persisted?.last_sent_count ?? 0,
          last_alert_key: persisted?.last_alert_key ?? null,
          last_alert_seen_count: persisted?.last_alert_seen_count ?? 0,
          recent_notifications: persisted?.recent_notifications ?? [],
          last_error: null,
        });
        await startReactionEngineDaemon(storage, invokeTool, config, input.run_immediately === true);
        return {
          ok: true,
          running: true,
          state,
          runtime: getReactionEngineRuntimeStatus(),
        };
      }

      const priorEnabled = persisted?.enabled ?? false;
      const state = storage.setReactionEngineState({
        enabled: priorEnabled,
        interval_seconds: config.interval_seconds,
        dedupe_window_seconds: config.dedupe_window_seconds,
        channels: config.channels,
        last_run_at: persisted?.last_run_at ?? null,
        last_sent_at: persisted?.last_sent_at ?? null,
        last_sent_count: persisted?.last_sent_count ?? 0,
        last_alert_key: persisted?.last_alert_key ?? null,
        last_alert_seen_count: persisted?.last_alert_seen_count ?? 0,
        recent_notifications: persisted?.recent_notifications ?? [],
        last_error: null,
      });
      const result = await runReactionEngineTickSafe(storage, invokeTool, config);
      return {
        ok: result.ok !== false,
        running: reactionEngineRuntime.running,
        state,
        runtime: getReactionEngineRuntimeStatus(),
        tick: result,
      };
    },
  });
}
