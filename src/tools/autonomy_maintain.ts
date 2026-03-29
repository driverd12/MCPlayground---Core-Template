import crypto from "node:crypto";
import { z } from "zod";
import { type AutonomyMaintainStateRecord, Storage } from "../storage.js";
import { buildAgentLearningOverview } from "./agent_learning.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const autonomyMaintainSchema = z
  .object({
    action: z.enum(["status", "run", "run_once", "start", "stop"]).default("status"),
    mutation: mutationSchema.optional(),
    local_host_id: z.string().min(1).default("local"),
    probe_ollama_url: z.string().optional(),
    ensure_bootstrap: z.boolean().default(true),
    autostart_ring_leader: z.boolean().optional(),
    bootstrap_run_immediately: z.boolean().optional(),
    start_goal_autorun_daemon: z.boolean().default(true),
    autorun_interval_seconds: z.number().int().min(5).max(3600).optional(),
    maintain_tmux_controller: z.boolean().default(true),
    tmux_capture_lines: z.number().int().min(50).max(4000).optional(),
    run_eval_if_due: z.boolean().default(true),
    eval_interval_seconds: z.number().int().min(300).max(604800).default(21600),
    eval_suite_id: z.string().min(1).default("autonomy.control-plane"),
    eval_host_id: z.string().min(1).optional(),
    minimum_eval_score: z.number().min(0).max(100).default(75),
    refresh_learning_summary: z.boolean().default(true),
    learning_review_interval_seconds: z.number().int().min(60).max(604800).default(300),
    interval_seconds: z.number().int().min(5).max(3600).default(120),
    publish_runtime_event: z.boolean().default(true),
    run_immediately: z.boolean().optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for run, run_once, start, and stop",
        path: ["mutation"],
      });
    }
  });

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
type AutonomyMaintainInput = z.infer<typeof autonomyMaintainSchema>;

type AutonomyMaintainRuntimeConfig = {
  local_host_id: string;
  probe_ollama_url?: string;
  ensure_bootstrap: boolean;
  autostart_ring_leader?: boolean;
  bootstrap_run_immediately?: boolean;
  start_goal_autorun_daemon: boolean;
  autorun_interval_seconds?: number;
  maintain_tmux_controller: boolean;
  tmux_capture_lines?: number;
  run_eval_if_due: boolean;
  eval_interval_seconds: number;
  eval_suite_id: string;
  eval_host_id?: string;
  minimum_eval_score: number;
  refresh_learning_summary: boolean;
  learning_review_interval_seconds: number;
  interval_seconds: number;
  publish_runtime_event: boolean;
  source_client?: string;
  source_model?: string;
  source_agent?: string;
};

type AutonomyMaintainRuntime = {
  running: boolean;
  timer: NodeJS.Timeout | null;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  config: AutonomyMaintainRuntimeConfig;
};

const DEFAULT_AUTONOMY_MAINTAIN_CONFIG: AutonomyMaintainRuntimeConfig = {
  local_host_id: "local",
  ensure_bootstrap: true,
  autostart_ring_leader: true,
  bootstrap_run_immediately: false,
  start_goal_autorun_daemon: true,
  maintain_tmux_controller: true,
  run_eval_if_due: true,
  eval_interval_seconds: 21600,
  eval_suite_id: "autonomy.control-plane",
  minimum_eval_score: 75,
  refresh_learning_summary: true,
  learning_review_interval_seconds: 300,
  interval_seconds: 120,
  publish_runtime_event: true,
  source_client: "autonomy.maintain",
  source_agent: "ring-leader",
};

const autonomyMaintainRuntime: AutonomyMaintainRuntime = {
  running: false,
  timer: null,
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  config: { ...DEFAULT_AUTONOMY_MAINTAIN_CONFIG },
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

function isoAgeSeconds(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - timestamp) / 1000);
}

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, phase: string) {
  const safePhase = phase.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const digest = crypto
    .createHash("sha256")
    .update(`${base.idempotency_key}|${base.side_effect_fingerprint}|${safePhase}`)
    .digest("hex");
  return {
    idempotency_key: `autonomy-maintain-${safePhase}-${digest.slice(0, 24)}`,
    side_effect_fingerprint: `autonomy-maintain-${safePhase}-${digest.slice(24, 56)}`,
  };
}

function buildGuardrails() {
  return [
    "Do not open new self-improvement goals from maintain ticks.",
    "Do not auto-promote org-program versions from maintain ticks.",
    "Do not mutate repo code from maintain ticks; use readiness, eval, and visibility only.",
  ];
}

function buildDefaultState(input: Pick<AutonomyMaintainInput, "interval_seconds" | "learning_review_interval_seconds" | "eval_interval_seconds">): AutonomyMaintainStateRecord {
  return {
    enabled: false,
    interval_seconds: input.interval_seconds,
    learning_review_interval_seconds: input.learning_review_interval_seconds,
    eval_interval_seconds: input.eval_interval_seconds,
    last_run_at: null,
    last_bootstrap_ready_at: null,
    last_goal_autorun_daemon_at: null,
    last_tmux_maintained_at: null,
    last_learning_review_at: null,
    last_learning_entry_count: 0,
    last_learning_active_agent_count: 0,
    last_eval_run_at: null,
    last_eval_run_id: null,
    last_eval_score: null,
    last_actions: [],
    last_attention: [],
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

function resolveAutonomyMaintainConfig(
  input: Partial<AutonomyMaintainInput>,
  fallback: AutonomyMaintainRuntimeConfig = DEFAULT_AUTONOMY_MAINTAIN_CONFIG
): AutonomyMaintainRuntimeConfig {
  return {
    local_host_id: readString(input.local_host_id) ?? fallback.local_host_id,
    probe_ollama_url: readString(input.probe_ollama_url) ?? fallback.probe_ollama_url,
    ensure_bootstrap: readBoolean(input.ensure_bootstrap) ?? fallback.ensure_bootstrap,
    autostart_ring_leader: readBoolean(input.autostart_ring_leader) ?? fallback.autostart_ring_leader,
    bootstrap_run_immediately:
      readBoolean(input.bootstrap_run_immediately) ?? fallback.bootstrap_run_immediately,
    start_goal_autorun_daemon:
      readBoolean(input.start_goal_autorun_daemon) ?? fallback.start_goal_autorun_daemon,
    autorun_interval_seconds:
      readNumber(input.autorun_interval_seconds) ?? fallback.autorun_interval_seconds,
    maintain_tmux_controller:
      readBoolean(input.maintain_tmux_controller) ?? fallback.maintain_tmux_controller,
    tmux_capture_lines: readNumber(input.tmux_capture_lines) ?? fallback.tmux_capture_lines,
    run_eval_if_due: readBoolean(input.run_eval_if_due) ?? fallback.run_eval_if_due,
    eval_interval_seconds: readNumber(input.eval_interval_seconds) ?? fallback.eval_interval_seconds,
    eval_suite_id: readString(input.eval_suite_id) ?? fallback.eval_suite_id,
    eval_host_id: readString(input.eval_host_id) ?? fallback.eval_host_id,
    minimum_eval_score: readNumber(input.minimum_eval_score) ?? fallback.minimum_eval_score,
    refresh_learning_summary:
      readBoolean(input.refresh_learning_summary) ?? fallback.refresh_learning_summary,
    learning_review_interval_seconds:
      readNumber(input.learning_review_interval_seconds) ?? fallback.learning_review_interval_seconds,
    interval_seconds: readNumber(input.interval_seconds) ?? fallback.interval_seconds,
    publish_runtime_event: readBoolean(input.publish_runtime_event) ?? fallback.publish_runtime_event,
    source_client: readString(input.source_client) ?? fallback.source_client,
    source_model: readString(input.source_model) ?? fallback.source_model,
    source_agent: readString(input.source_agent) ?? fallback.source_agent,
  };
}

function buildRuntimeStatus() {
  return {
    running: autonomyMaintainRuntime.running,
    in_tick: autonomyMaintainRuntime.in_tick,
    started_at: autonomyMaintainRuntime.started_at,
    last_tick_at: autonomyMaintainRuntime.last_tick_at,
    last_error: autonomyMaintainRuntime.last_error,
    tick_count: autonomyMaintainRuntime.tick_count,
    config: { ...autonomyMaintainRuntime.config },
  };
}

export function getAutonomyMaintainRuntimeStatus() {
  return buildRuntimeStatus();
}

async function buildStatus(
  storage: Storage,
  invokeTool: InvokeTool,
  input: Pick<
    AutonomyMaintainInput,
    | "local_host_id"
    | "probe_ollama_url"
    | "autostart_ring_leader"
    | "source_client"
    | "source_model"
    | "source_agent"
    | "run_eval_if_due"
    | "eval_interval_seconds"
    | "interval_seconds"
    | "learning_review_interval_seconds"
  >,
  stateOverride?: AutonomyMaintainStateRecord | null
) {
  const state = stateOverride ?? storage.getAutonomyMaintainState() ?? buildDefaultState(input);
  const bootstrap = asRecord(
    await invokeTool("autonomy.bootstrap", {
      action: "status",
      local_host_id: input.local_host_id,
      probe_ollama_url: input.probe_ollama_url,
      autostart_ring_leader: input.autostart_ring_leader,
      source_client: input.source_client ?? "autonomy.maintain",
      source_model: input.source_model,
      source_agent: input.source_agent ?? "ring-leader",
    })
  );
  const goalAutorun = asRecord(await invokeTool("goal.autorun_daemon", { action: "status" }));
  const tmux = asRecord(await invokeTool("trichat.tmux_controller", { action: "status" }));
  const learning = buildAgentLearningOverview(storage, {
    limit: 250,
    top_agents_limit: 8,
    recent_limit: 8,
  });
  const tmuxDashboard = asRecord(tmux.dashboard);
  const lastRunAgeSeconds = isoAgeSeconds(state.last_run_at);
  const learningReviewAgeSeconds = isoAgeSeconds(state.last_learning_review_at);
  const evalAgeSeconds = isoAgeSeconds(state.last_eval_run_at);
  const due = {
    stale: lastRunAgeSeconds > Math.max(state.interval_seconds * 3, 300),
    learning_review: learningReviewAgeSeconds > state.learning_review_interval_seconds,
    eval: input.run_eval_if_due !== false && evalAgeSeconds > state.eval_interval_seconds,
  };
  const attention = [...new Set([...(state.last_attention ?? []), ...((bootstrap.repairs_needed as string[] | undefined) ?? [])])]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (readBoolean(goalAutorun.running) !== true) {
    attention.push("goal.autorun_daemon.not_running");
  }
  if (readBoolean(asRecord(tmux.state).enabled) === true && readNumber(tmuxDashboard.queue_depth) === null) {
    attention.push("trichat.tmux_controller.dashboard_missing");
  }
  if (learning.active_entry_count === 0) {
    attention.push("agent.learning.no_active_entries");
  }
  return {
    state,
    runtime: buildRuntimeStatus(),
    bootstrap,
    goal_autorun_daemon: goalAutorun,
    tmux_controller: {
      enabled: readBoolean(asRecord(tmux.state).enabled) === true,
      queue_depth: readNumber(tmuxDashboard.queue_depth) ?? 0,
      queue_age_seconds: readNumber(tmuxDashboard.queue_age_seconds),
      worker_count: readNumber(asRecord(tmux.state).worker_count) ?? 0,
    },
    learning,
    due,
    guardrails: buildGuardrails(),
    attention: [...new Set(attention)],
  };
}

async function executeAutonomyMaintainPass(
  storage: Storage,
  invokeTool: InvokeTool,
  input: AutonomyMaintainInput
) {
  const sourceClient = input.source_client ?? "autonomy.maintain";
  const sourceAgent = input.source_agent ?? "ring-leader";
  const previousState = storage.getAutonomyMaintainState();
  const now = new Date().toISOString();
  const actions: string[] = [];
  const attention: string[] = [];
  const lastError: string | null = null;

  const bootstrap = asRecord(
    await invokeTool("autonomy.bootstrap", {
      action: input.ensure_bootstrap ? "ensure" : "status",
      mutation: input.ensure_bootstrap ? deriveMutation(input.mutation!, "bootstrap") : undefined,
      local_host_id: input.local_host_id,
      probe_ollama_url: input.probe_ollama_url,
      autostart_ring_leader: input.autostart_ring_leader ?? true,
      run_immediately: input.bootstrap_run_immediately ?? false,
      seed_org_programs: input.ensure_bootstrap ? true : undefined,
      seed_benchmark_suite: input.ensure_bootstrap ? true : undefined,
      seed_eval_suite: input.ensure_bootstrap ? true : undefined,
      source_client: sourceClient,
      source_model: input.source_model,
      source_agent: sourceAgent,
    })
  );
  const bootstrapStatus = asRecord(bootstrap.status).self_start_ready === undefined ? bootstrap : asRecord(bootstrap.status);
  actions.push(input.ensure_bootstrap ? "autonomy.bootstrap.ensure" : "autonomy.bootstrap.status");
  const repairsNeeded = Array.isArray(bootstrapStatus.repairs_needed)
    ? bootstrapStatus.repairs_needed.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  attention.push(...repairsNeeded);

  let goalAutorunStatus = asRecord(await invokeTool("goal.autorun_daemon", { action: "status" }));
  let goalAutorunStarted = false;
  if (input.start_goal_autorun_daemon !== false && readBoolean(goalAutorunStatus.running) !== true) {
    goalAutorunStatus = asRecord(
      await invokeTool("goal.autorun_daemon", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "goal-autorun-daemon"),
        interval_seconds: input.autorun_interval_seconds,
        run_immediately: true,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      })
    );
    goalAutorunStarted = true;
    actions.push("goal.autorun_daemon.start");
  }
  if (readBoolean(goalAutorunStatus.running) !== true) {
    attention.push("goal.autorun_daemon.not_running");
  }

  let tmuxMaintainResult: Record<string, unknown> | null = null;
  const tmuxStatus = asRecord(await invokeTool("trichat.tmux_controller", { action: "status" }));
  const tmuxQueueDepth = readNumber(asRecord(tmuxStatus.dashboard).queue_depth) ?? 0;
  if (input.maintain_tmux_controller !== false && readBoolean(asRecord(tmuxStatus.state).enabled) === true) {
    try {
      tmuxMaintainResult = asRecord(
        await invokeTool("trichat.tmux_controller", {
          action: "maintain",
          mutation: deriveMutation(input.mutation!, "tmux-maintain"),
          auto_scale_workers: true,
          nudge_blocked_lanes: true,
          capture_lines: input.tmux_capture_lines,
          source_client: sourceClient,
          source_model: input.source_model,
          source_agent: sourceAgent,
        })
      );
      actions.push("trichat.tmux_controller.maintain");
      if (tmuxMaintainResult.ok === false) {
        const reason = readString(asRecord(tmuxMaintainResult.maintenance).reason) ?? readString(tmuxMaintainResult.error);
        if (reason) {
          attention.push(`trichat.tmux_controller.${reason}`);
        } else {
          attention.push("trichat.tmux_controller.maintain_failed");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/maintain lock not acquired/i.test(message)) {
        actions.push("trichat.tmux_controller.maintain_skipped_locked");
      } else {
        attention.push(`trichat.tmux_controller.${message}`);
      }
    }
  }

  const workerFabricStatus = asRecord(bootstrapStatus.worker_fabric);
  const workerTelemetry = asRecord(workerFabricStatus.telemetry);
  const fabricQueueDepth = readNumber(workerTelemetry.queue_depth) ?? 0;
  const fabricActiveTasks = readNumber(workerTelemetry.active_tasks) ?? 0;
  const idleForEval = fabricQueueDepth <= 0 && fabricActiveTasks <= 0 && tmuxQueueDepth <= 0;

  const learning = buildAgentLearningOverview(storage, {
    limit: 250,
    top_agents_limit: 8,
    recent_limit: 8,
  });
  actions.push("agent.learning_summary");
  if (learning.active_entry_count === 0) {
    attention.push("agent.learning.no_active_entries");
  }

  let evalResult: Record<string, unknown> | null = null;
  const previousEvalAgeSeconds = isoAgeSeconds(previousState?.last_eval_run_at);
  const shouldRunEval =
    input.run_eval_if_due !== false &&
    readBoolean(bootstrapStatus.self_start_ready) === true &&
    previousEvalAgeSeconds > input.eval_interval_seconds &&
    idleForEval;
  if (shouldRunEval) {
    evalResult = asRecord(
      await invokeTool("eval.run", {
        mutation: deriveMutation(input.mutation!, "eval-run"),
        suite_id: input.eval_suite_id,
        candidate_label: `autonomy-maintain:${new Date().toISOString().slice(0, 19)}`,
        host_id: input.eval_host_id ?? input.local_host_id,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      })
    );
    actions.push(`eval.run:${input.eval_suite_id}`);
    const evalScore = readNumber(evalResult.aggregate_metric_value);
    if (evalResult.ok !== true) {
      attention.push(`eval.${input.eval_suite_id}.failed`);
    } else if (evalScore !== null && evalScore < input.minimum_eval_score) {
      attention.push(`eval.${input.eval_suite_id}.below_threshold`);
    }
  } else if (input.run_eval_if_due !== false && !idleForEval) {
    actions.push("eval.deferred_busy");
  }

  const nextState = storage.setAutonomyMaintainState({
    enabled: true,
    interval_seconds: input.interval_seconds,
    learning_review_interval_seconds: input.learning_review_interval_seconds,
    eval_interval_seconds: input.eval_interval_seconds,
    last_run_at: now,
    last_bootstrap_ready_at: readBoolean(bootstrapStatus.self_start_ready) === true ? now : previousState?.last_bootstrap_ready_at ?? null,
    last_goal_autorun_daemon_at: readBoolean(goalAutorunStatus.running) === true ? now : previousState?.last_goal_autorun_daemon_at ?? null,
    last_tmux_maintained_at: tmuxMaintainResult ? now : previousState?.last_tmux_maintained_at ?? null,
    last_learning_review_at: now,
    last_learning_entry_count: learning.total_entries,
    last_learning_active_agent_count: learning.agents_with_active_entries,
    last_eval_run_at: evalResult ? now : previousState?.last_eval_run_at ?? null,
    last_eval_run_id: readString(evalResult?.run_id) ?? previousState?.last_eval_run_id ?? null,
    last_eval_score: readNumber(evalResult?.aggregate_metric_value) ?? previousState?.last_eval_score ?? null,
    last_actions: actions,
    last_attention: attention,
    last_error: lastError,
  });

  const shouldPublishEvent =
    input.publish_runtime_event !== false &&
    (goalAutorunStarted ||
      Boolean(tmuxMaintainResult) ||
      Boolean(evalResult) ||
      repairsNeeded.length > 0 ||
      attention.length > 0);
  if (shouldPublishEvent) {
    storage.appendRuntimeEvent({
      event_type: "autonomy.maintain",
      entity_type: "daemon",
      entity_id: "autonomy.maintain",
      status: attention.length > 0 ? "attention" : "healthy",
      summary:
        attention.length > 0
          ? `autonomy.maintain completed with attention: ${attention.slice(0, 3).join(", ")}`
          : "autonomy.maintain refreshed readiness, autorun, learning, and eval surfaces.",
      details: {
        actions,
        attention,
        eval_run_id: nextState.last_eval_run_id,
        eval_score: nextState.last_eval_score,
        learning_entry_count: nextState.last_learning_entry_count,
        learning_active_agent_count: nextState.last_learning_active_agent_count,
        goal_autorun_running: readBoolean(goalAutorunStatus.running) === true,
        tmux_maintained: Boolean(tmuxMaintainResult),
      },
      source_client: sourceClient,
      source_model: input.source_model,
      source_agent: sourceAgent,
    });
  }

  const status = await buildStatus(storage, invokeTool, input, nextState);
  return {
    ok: readBoolean(asRecord(status.bootstrap).self_start_ready) === true,
    actions,
    eval: {
      executed: Boolean(evalResult),
      suite_id: input.eval_suite_id,
      run_id: readString(evalResult?.run_id),
      ok: readBoolean(evalResult?.ok),
      aggregate_metric_value: readNumber(evalResult?.aggregate_metric_value),
    },
    learning: {
      total_entries: learning.total_entries,
      active_entry_count: learning.active_entry_count,
      agents_with_active_entries: learning.agents_with_active_entries,
    },
    status,
  };
}

function stopAutonomyMaintainDaemon() {
  if (autonomyMaintainRuntime.timer) {
    clearInterval(autonomyMaintainRuntime.timer);
    autonomyMaintainRuntime.timer = null;
  }
  autonomyMaintainRuntime.running = false;
  autonomyMaintainRuntime.started_at = null;
}

async function runAutonomyMaintainTick(storage: Storage, invokeTool: InvokeTool, config: AutonomyMaintainRuntimeConfig) {
  if (autonomyMaintainRuntime.in_tick) {
    return {
      skipped: true,
      reason: "already-running",
      runtime: buildRuntimeStatus(),
    };
  }

  autonomyMaintainRuntime.in_tick = true;
  try {
    const result = await executeAutonomyMaintainPass(storage, invokeTool, {
      action: "run",
      mutation: {
        idempotency_key: `autonomy-maintain-tick-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`,
        side_effect_fingerprint: `autonomy-maintain-tick-${process.pid}-${crypto.randomUUID().slice(0, 12)}`,
      },
      ...config,
    });
    autonomyMaintainRuntime.last_tick_at = new Date().toISOString();
    autonomyMaintainRuntime.last_error = null;
    autonomyMaintainRuntime.tick_count += 1;
    return {
      skipped: false,
      result,
      runtime: buildRuntimeStatus(),
    };
  } catch (error) {
    autonomyMaintainRuntime.last_tick_at = new Date().toISOString();
    autonomyMaintainRuntime.last_error = error instanceof Error ? error.message : String(error);
    autonomyMaintainRuntime.tick_count += 1;
    storage.appendRuntimeEvent({
      event_type: "autonomy.maintain_failed",
      entity_type: "daemon",
      entity_id: "autonomy.maintain",
      status: "failed",
      summary: "autonomy.maintain daemon tick failed.",
      details: {
        error: autonomyMaintainRuntime.last_error,
        config,
      },
      source_client: config.source_client ?? "autonomy.maintain",
      source_model: config.source_model,
      source_agent: config.source_agent ?? "ring-leader",
    });
    throw error;
  } finally {
    autonomyMaintainRuntime.in_tick = false;
  }
}

function startAutonomyMaintainDaemon(storage: Storage, invokeTool: InvokeTool) {
  if (autonomyMaintainRuntime.timer) {
    clearInterval(autonomyMaintainRuntime.timer);
    autonomyMaintainRuntime.timer = null;
  }
  autonomyMaintainRuntime.running = true;
  autonomyMaintainRuntime.started_at = new Date().toISOString();
  autonomyMaintainRuntime.timer = setInterval(() => {
    void runAutonomyMaintainTick(storage, invokeTool, autonomyMaintainRuntime.config);
  }, autonomyMaintainRuntime.config.interval_seconds * 1000);
  autonomyMaintainRuntime.timer.unref?.();
}

export function initializeAutonomyMaintainDaemon(storage: Storage, invokeTool: InvokeTool) {
  const persisted = storage.getAutonomyMaintainState();
  if (!persisted) {
    autonomyMaintainRuntime.config = { ...DEFAULT_AUTONOMY_MAINTAIN_CONFIG };
    stopAutonomyMaintainDaemon();
    return {
      restored: false,
      running: false,
      config: { ...autonomyMaintainRuntime.config },
    };
  }

  autonomyMaintainRuntime.config = resolveAutonomyMaintainConfig(
    {
      interval_seconds: persisted.interval_seconds,
      learning_review_interval_seconds: persisted.learning_review_interval_seconds,
      eval_interval_seconds: persisted.eval_interval_seconds,
    },
    DEFAULT_AUTONOMY_MAINTAIN_CONFIG
  );
  if (persisted.enabled) {
    startAutonomyMaintainDaemon(storage, invokeTool);
  } else {
    stopAutonomyMaintainDaemon();
  }
  return {
    restored: true,
    running: autonomyMaintainRuntime.running,
    config: { ...autonomyMaintainRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export async function autonomyMaintain(
  storage: Storage,
  invokeTool: InvokeTool,
  input: AutonomyMaintainInput
) {
  if (input.action === "status") {
    return buildStatus(storage, invokeTool, input);
  }

  return runIdempotentMutation({
    storage,
    tool_name: "autonomy.maintain",
    mutation: input.mutation!,
    payload: input,
    execute: async () => {
      if (input.action === "stop") {
        const previousState = storage.getAutonomyMaintainState() ?? buildDefaultState(input);
        const wasRunning = autonomyMaintainRuntime.running;
        stopAutonomyMaintainDaemon();
        const persisted = storage.setAutonomyMaintainState({
          enabled: false,
          interval_seconds: previousState.interval_seconds,
          learning_review_interval_seconds: previousState.learning_review_interval_seconds,
          eval_interval_seconds: previousState.eval_interval_seconds,
          last_run_at: previousState.last_run_at,
          last_bootstrap_ready_at: previousState.last_bootstrap_ready_at,
          last_goal_autorun_daemon_at: previousState.last_goal_autorun_daemon_at,
          last_tmux_maintained_at: previousState.last_tmux_maintained_at,
          last_learning_review_at: previousState.last_learning_review_at,
          last_learning_entry_count: previousState.last_learning_entry_count,
          last_learning_active_agent_count: previousState.last_learning_active_agent_count,
          last_eval_run_at: previousState.last_eval_run_at,
          last_eval_run_id: previousState.last_eval_run_id,
          last_eval_score: previousState.last_eval_score,
          last_actions: previousState.last_actions,
          last_attention: previousState.last_attention,
          last_error: previousState.last_error,
        });
        return {
          ok: true,
          stopped: wasRunning,
          running: false,
          status: await buildStatus(storage, invokeTool, input, persisted),
        };
      }

      autonomyMaintainRuntime.config = resolveAutonomyMaintainConfig(input, autonomyMaintainRuntime.config);
      if (input.action === "start") {
        const wasRunning = autonomyMaintainRuntime.running;
        startAutonomyMaintainDaemon(storage, invokeTool);
        let initialTick: Record<string, unknown> | null = null;
        if (input.run_immediately !== false) {
          initialTick = await executeAutonomyMaintainPass(storage, invokeTool, {
            ...input,
            action: "run",
          });
        } else {
          const current = storage.getAutonomyMaintainState() ?? buildDefaultState(input);
          storage.setAutonomyMaintainState({
            enabled: true,
            interval_seconds: autonomyMaintainRuntime.config.interval_seconds,
            learning_review_interval_seconds: autonomyMaintainRuntime.config.learning_review_interval_seconds,
            eval_interval_seconds: autonomyMaintainRuntime.config.eval_interval_seconds,
            last_run_at: current.last_run_at,
            last_bootstrap_ready_at: current.last_bootstrap_ready_at,
            last_goal_autorun_daemon_at: current.last_goal_autorun_daemon_at,
            last_tmux_maintained_at: current.last_tmux_maintained_at,
            last_learning_review_at: current.last_learning_review_at,
            last_learning_entry_count: current.last_learning_entry_count,
            last_learning_active_agent_count: current.last_learning_active_agent_count,
            last_eval_run_at: current.last_eval_run_at,
            last_eval_run_id: current.last_eval_run_id,
            last_eval_score: current.last_eval_score,
            last_actions: current.last_actions,
            last_attention: current.last_attention,
            last_error: current.last_error,
          });
        }
        return {
          ok: true,
          started: !wasRunning,
          updated: wasRunning,
          initial_tick: initialTick,
          status: await buildStatus(storage, invokeTool, input),
        };
      }

      const result = await executeAutonomyMaintainPass(storage, invokeTool, {
        ...input,
        action: "run",
      });
      startAutonomyMaintainDaemon(storage, invokeTool);
      return {
        ...result,
        status: await buildStatus(storage, invokeTool, input),
      };
    },
  });
}
