import crypto from "node:crypto";
import { z } from "zod";
import { probeLocalOllamaBackend, setLocalOllamaModelResidency } from "../local_backend_probe.js";
import { probeLiteLlmProxyHealth } from "../litellm_proxy_probe.js";
import { probeLocalMlxBackend } from "../local_mlx_backend_probe.js";
import { captureLocalHostProfile, deriveLocalExecutionBudget, isLocalHostSafeForAutonomyEval } from "../local_host_profile.js";
import { summarizeDesktopControlState } from "../desktop_control_plane.js";
import { summarizePatientZeroState } from "../patient_zero_plane.js";
import {
  type AutonomyMaintainStateRecord,
  type ProviderBridgeDiagnosticSnapshotRecord,
  type TaskSummaryRecord,
  Storage,
} from "../storage.js";
import { buildAgentLearningOverview } from "./agent_learning.js";
import { getAutoSnapshotRuntimeStatus } from "./imprint.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { loadOrgPrograms } from "./org_program.js";
import { resolveProviderBridgeDiagnostics } from "./provider_bridge.js";
import { getReactionEngineRuntimeStatus } from "./reaction_engine.js";
import { getAutoSquishRuntimeStatus } from "./transcript.js";
import { getTriChatAutoRetentionRuntimeStatus, getTriChatTurnWatchdogRuntimeStatus } from "./trichat.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

function dedupeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function hasRetainedSwapHeadroom(profile: {
  memory_available_gb: number;
  memory_free_percent: number;
}) {
  return profile.memory_available_gb >= 24 && profile.memory_free_percent >= 35;
}

export const autonomyMaintainSchema = z
  .object({
    action: z.enum(["status", "run", "run_once", "start", "stop"]).default("status"),
    fast: z.boolean().optional(),
    mutation: mutationSchema.optional(),
    local_host_id: z.string().min(1).default("local"),
    probe_ollama_url: z.string().optional(),
    ensure_bootstrap: z.boolean().default(true),
    autostart_ring_leader: z.boolean().optional(),
    bootstrap_run_immediately: z.boolean().optional(),
    start_goal_autorun_daemon: z.boolean().default(true),
    run_goal_hygiene: z.boolean().default(true),
    goal_hygiene_limit: z.number().int().min(1).max(200).optional(),
    run_task_recovery: z.boolean().default(true),
    task_recovery_limit: z.number().int().min(1).max(500).optional(),
    start_runtime_workers: z.boolean().default(true),
    runtime_worker_limit: z.number().int().min(1).max(8).optional(),
    runtime_worker_max_active: z.number().int().min(1).max(8).optional(),
    start_task_auto_retry_daemon: z.boolean().default(true),
    task_auto_retry_interval_seconds: z.number().int().min(5).max(3600).optional(),
    task_auto_retry_batch_limit: z.number().int().min(1).max(500).optional(),
    task_auto_retry_base_delay_seconds: z.number().int().min(0).max(86400).optional(),
    task_auto_retry_max_delay_seconds: z.number().int().min(0).max(604800).optional(),
    start_transcript_auto_squish_daemon: z.boolean().default(true),
    start_imprint_auto_snapshot_daemon: z.boolean().default(true),
    start_trichat_auto_retention_daemon: z.boolean().default(true),
    start_trichat_turn_watchdog_daemon: z.boolean().default(true),
    start_reaction_engine_daemon: z.boolean().default(true),
    reaction_engine_interval_seconds: z.number().int().min(5).max(3600).optional(),
    reaction_engine_dedupe_window_seconds: z.number().int().min(30).max(604800).optional(),
    reaction_engine_channels: z.array(z.enum(["desktop", "webhook"])).max(4).optional(),
    reaction_engine_webhook_url: z.string().url().optional(),
    autorun_interval_seconds: z.number().int().min(5).max(3600).optional(),
    maintain_tmux_controller: z.boolean().default(true),
    tmux_capture_lines: z.number().int().min(50).max(4000).optional(),
    enable_self_drive: z.boolean().default(true),
    self_drive_cooldown_seconds: z.number().int().min(60).max(86400).default(1800),
    run_eval_if_due: z.boolean().default(true),
    eval_interval_seconds: z.number().int().min(300).max(604800).default(21600),
    eval_suite_id: z.string().min(1).default("autonomy.control-plane"),
    eval_host_id: z.string().min(1).optional(),
    minimum_eval_score: z.number().min(0).max(100).default(75),
    run_optimizer_if_due: z.boolean().default(true),
    optimizer_interval_seconds: z.number().int().min(300).max(604800).default(14400),
    optimizer_min_improvement: z.number().min(0).max(100).default(2),
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
  run_goal_hygiene: boolean;
  goal_hygiene_limit?: number;
  run_task_recovery: boolean;
  task_recovery_limit?: number;
  start_runtime_workers: boolean;
  runtime_worker_limit?: number;
  runtime_worker_max_active?: number;
  start_task_auto_retry_daemon: boolean;
  task_auto_retry_interval_seconds?: number;
  task_auto_retry_batch_limit?: number;
  task_auto_retry_base_delay_seconds?: number;
  task_auto_retry_max_delay_seconds?: number;
  start_transcript_auto_squish_daemon: boolean;
  start_imprint_auto_snapshot_daemon: boolean;
  start_trichat_auto_retention_daemon: boolean;
  start_trichat_turn_watchdog_daemon: boolean;
  start_reaction_engine_daemon: boolean;
  reaction_engine_interval_seconds?: number;
  reaction_engine_dedupe_window_seconds?: number;
  reaction_engine_channels?: Array<"desktop" | "webhook">;
  reaction_engine_webhook_url?: string;
  autorun_interval_seconds?: number;
  maintain_tmux_controller: boolean;
  tmux_capture_lines?: number;
  enable_self_drive: boolean;
  self_drive_cooldown_seconds: number;
  run_eval_if_due: boolean;
  eval_interval_seconds: number;
  eval_suite_id: string;
  eval_host_id?: string;
  minimum_eval_score: number;
  run_optimizer_if_due: boolean;
  optimizer_interval_seconds: number;
  optimizer_min_improvement: number;
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

type AutonomyMaintainRuntimeStatusLike = {
  running?: boolean | null;
  last_tick_at?: string | null;
};

const DEFAULT_AUTONOMY_MAINTAIN_CONFIG: AutonomyMaintainRuntimeConfig = {
  local_host_id: "local",
  ensure_bootstrap: true,
  autostart_ring_leader: true,
  bootstrap_run_immediately: false,
  start_goal_autorun_daemon: true,
  run_goal_hygiene: true,
  run_task_recovery: true,
  start_runtime_workers: true,
  start_task_auto_retry_daemon: true,
  start_transcript_auto_squish_daemon: true,
  start_imprint_auto_snapshot_daemon: true,
  start_trichat_auto_retention_daemon: true,
  start_trichat_turn_watchdog_daemon: true,
  start_reaction_engine_daemon: true,
  maintain_tmux_controller: true,
  enable_self_drive: true,
  self_drive_cooldown_seconds: 1800,
  run_eval_if_due: true,
  eval_interval_seconds: 21600,
  eval_suite_id: "autonomy.control-plane",
  minimum_eval_score: 75,
  run_optimizer_if_due: true,
  optimizer_interval_seconds: 14400,
  optimizer_min_improvement: 2,
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function seedTranscriptAutoSquishState(storage: Storage, runtimeStatus: Record<string, unknown>) {
  const config = asRecord(runtimeStatus.config);
  return storage.setTranscriptAutoSquishState({
    enabled: true,
    interval_seconds: Math.trunc(readNumber(config.interval_seconds) ?? 60),
    batch_runs: Math.trunc(readNumber(config.batch_runs) ?? 10),
    per_run_limit: Math.trunc(readNumber(config.per_run_limit) ?? 200),
    max_points: Math.trunc(readNumber(config.max_points) ?? 8),
  });
}

function seedTriChatAutoRetentionState(storage: Storage, runtimeStatus: Record<string, unknown>) {
  const config = asRecord(runtimeStatus.config);
  return storage.setTriChatAutoRetentionState({
    enabled: true,
    interval_seconds: Math.trunc(readNumber(config.interval_seconds) ?? 600),
    older_than_days: Math.trunc(readNumber(config.older_than_days) ?? 30),
    limit: Math.trunc(readNumber(config.limit) ?? 1000),
  });
}

function seedTriChatTurnWatchdogState(storage: Storage, runtimeStatus: Record<string, unknown>) {
  const config = asRecord(runtimeStatus.config);
  return storage.setTriChatTurnWatchdogState({
    enabled: true,
    interval_seconds: Math.trunc(readNumber(config.interval_seconds) ?? 30),
    stale_after_seconds: Math.trunc(readNumber(config.stale_after_seconds) ?? 180),
    batch_limit: Math.trunc(readNumber(config.batch_limit) ?? 10),
  });
}

function hasRuntimeWorkerRequest(metadata: Record<string, unknown> | null | undefined) {
  const taskExecution = asRecord(asRecord(metadata).task_execution);
  const runtimeId = readString(taskExecution.runtime_id);
  const runtimeStrategy = readString(taskExecution.runtime_strategy);
  return (runtimeId === "codex" || runtimeId === "shell") && runtimeStrategy === "tmux_worktree";
}

function countRuntimeEligibleTasks(storage: Storage, status: "pending" | "failed", limit = 200) {
  return storage
    .listTasks({ status, limit: Math.max(1, Math.min(1000, limit)) })
    .filter((task) => hasRuntimeWorkerRequest(task.metadata)).length;
}

function smoothMetric(previous: number | null | undefined, next: number | null | undefined, alpha = 0.35) {
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return previous ?? null;
  }
  if (typeof previous !== "number" || !Number.isFinite(previous)) {
    return Number(next.toFixed(4));
  }
  return Number((previous * (1 - alpha) + next * alpha).toFixed(4));
}

function smoothRate(previous: number | null | undefined, success: boolean, alpha: number) {
  const prior = typeof previous === "number" && Number.isFinite(previous) ? Math.max(0, Math.min(1, previous)) : 0.8;
  const target = success ? 1 : 0;
  return Number((prior * (1 - alpha) + target * alpha).toFixed(4));
}

function normalizeStableBackendTags(value: unknown) {
  return normalizeStringArray(value).filter((tag) => {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.startsWith("probe-") || normalized.startsWith("benchmark-")) {
      return false;
    }
    if (
      normalized === "benchmarked" ||
      normalized === "model-known" ||
      normalized === "model-missing" ||
      normalized === "gpu-offloaded" ||
      normalized === "hybrid-cpu-gpu" ||
      normalized === "cpu-only"
    ) {
      return false;
    }
    return true;
  });
}

export function buildEvalHealth(
  state: AutonomyMaintainStateRecord | null | undefined,
  input: Pick<AutonomyMaintainInput, "run_eval_if_due" | "eval_interval_seconds" | "eval_suite_id" | "minimum_eval_score"> & {
    current_dependency_fingerprint?: string | null;
  }
) {
  const lastEvalAgeSeconds = isoAgeSeconds(state?.last_eval_run_at);
  const lastEvalScore = typeof state?.last_eval_score === "number" ? state.last_eval_score : null;
  const neverRun = !state?.last_eval_run_at;
  const belowThreshold = lastEvalScore === null || lastEvalScore < input.minimum_eval_score;
  const dueByAge = lastEvalAgeSeconds > input.eval_interval_seconds;
  const currentDependencyFingerprint = readString(input.current_dependency_fingerprint);
  const dueByDependencyDrift =
    Boolean(currentDependencyFingerprint) &&
    currentDependencyFingerprint !== readString(state?.last_eval_dependency_fingerprint);
  const due = input.run_eval_if_due !== false && (neverRun || belowThreshold || dueByAge || dueByDependencyDrift);
  const operational = !neverRun && !belowThreshold;
  // An overdue eval is maintenance debt, not a hard health failure, as long as the last
  // accepted score is still above threshold and the suite definition has not drifted.
  return {
    suite_id: input.eval_suite_id,
    minimum_eval_score: input.minimum_eval_score,
    last_eval_score: lastEvalScore,
    last_eval_run_at: state?.last_eval_run_at ?? null,
    last_eval_run_id: state?.last_eval_run_id ?? null,
    current_dependency_fingerprint: currentDependencyFingerprint,
    last_eval_dependency_fingerprint: state?.last_eval_dependency_fingerprint ?? null,
    due,
    due_by_age: dueByAge,
    due_by_dependency_drift: dueByDependencyDrift,
    below_threshold: belowThreshold,
    never_run: neverRun,
    operational,
    healthy: !neverRun && !belowThreshold && !dueByDependencyDrift,
    last_eval_age_seconds: Number.isFinite(lastEvalAgeSeconds) ? Number(lastEvalAgeSeconds.toFixed(4)) : null,
  };
}

export function computeEvalDependencyFingerprint(storage: Storage, suiteId: string) {
  const evalState = storage.getEvalSuitesState();
  const benchmarkState = storage.getBenchmarkSuitesState();
  const modelRouterState = storage.getModelRouterState();
  const workerFabricState = storage.getWorkerFabricState();
  const suite = (evalState?.suites ?? []).find((entry) => entry.suite_id === suiteId);
  if (!suite) {
    return `missing:${suiteId}`;
  }
  const benchmarkRefs = [...new Set(
    suite.cases
      .map((entry) => entry.benchmark_suite_id?.trim() || "")
      .filter(Boolean)
  )]
    .sort()
    .map((benchmarkSuiteId) => {
      const benchmarkSuite = benchmarkState?.suites.find((entry) => entry.suite_id === benchmarkSuiteId);
      if (!benchmarkSuite) {
        return {
          suite_id: benchmarkSuiteId,
          missing: true,
        };
      }
      return {
        suite_id: benchmarkSuite.suite_id,
        title: benchmarkSuite.title,
        objective: benchmarkSuite.objective,
        project_dir: benchmarkSuite.project_dir,
        isolation_mode: benchmarkSuite.isolation_mode,
        aggregate_metric_name: benchmarkSuite.aggregate_metric_name,
        aggregate_metric_direction: benchmarkSuite.aggregate_metric_direction,
        tags: normalizeStringArray(benchmarkSuite.tags),
        cases: benchmarkSuite.cases.map((caseEntry) => ({
          case_id: caseEntry.case_id,
          title: caseEntry.title,
          command: caseEntry.command,
          timeout_seconds: caseEntry.timeout_seconds,
          required: caseEntry.required !== false,
          metric_name: caseEntry.metric_name,
          metric_direction: caseEntry.metric_direction,
          metric_mode: caseEntry.metric_mode,
          metric_regex: caseEntry.metric_regex ?? null,
          tags: normalizeStringArray(caseEntry.tags),
        })),
      };
    });
  const modelRouterSignature = {
    enabled: Boolean(modelRouterState?.enabled),
    strategy: modelRouterState?.strategy ?? null,
    default_backend_id: modelRouterState?.default_backend_id ?? null,
    backends: (modelRouterState?.backends ?? []).map((backend) => {
      const capabilities = asRecord(backend.capabilities);
      return {
        backend_id: backend.backend_id,
        enabled: backend.enabled !== false,
        provider: backend.provider,
        model_id: backend.model_id,
        locality: backend.locality,
        host_id: backend.host_id ?? null,
        context_window: backend.context_window ?? null,
        tags: normalizeStableBackendTags(backend.tags),
        task_kinds: normalizeStringArray(capabilities.task_kinds),
        bridge_agent_ids: normalizeStringArray(capabilities.bridge_agent_ids),
      };
    }),
  };
  const workerFabricSignature = {
    enabled: Boolean(workerFabricState?.enabled),
    strategy: workerFabricState?.strategy ?? null,
    default_host_id: workerFabricState?.default_host_id ?? null,
    hosts: (workerFabricState?.hosts ?? []).map((host) => ({
      host_id: host.host_id,
      enabled: host.enabled !== false,
      transport: host.transport,
      worker_count: host.worker_count,
      tags: normalizeStringArray(host.tags),
    })),
  };
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        eval_suite: {
          suite_id: suite.suite_id,
          objective: suite.objective,
          aggregate_metric_name: suite.aggregate_metric_name ?? null,
          aggregate_metric_direction: suite.aggregate_metric_direction ?? null,
          cases: suite.cases.map((entry) => ({
            case_id: entry.case_id,
            kind: entry.kind,
            benchmark_suite_id: entry.benchmark_suite_id ?? null,
            task_kind: entry.task_kind ?? null,
            preferred_tags: normalizeStringArray(entry.preferred_tags),
            required_tags: normalizeStringArray(entry.required_tags),
            expected_backend_id: entry.expected_backend_id ?? null,
            expected_backend_tags: normalizeStringArray(entry.expected_backend_tags),
            latency_budget_ms: entry.latency_budget_ms ?? null,
            required: entry.required !== false,
            weight: entry.weight ?? null,
          })),
        },
        benchmark_refs: benchmarkRefs,
        model_router: modelRouterSignature,
        worker_fabric: workerFabricSignature,
      })
    )
    .digest("hex");
}

async function shipControlPlaneObservability(
  storage: Storage,
  invokeTool: InvokeTool,
  input: {
    mutation: { idempotency_key: string; side_effect_fingerprint: string };
    since: string;
    source_client: string;
    source_model?: string;
    source_agent: string;
  }
) {
  const shipped: string[] = [];
  const recentRunIds = [...new Set(
    storage
      .listRuntimeEvents({ entity_type: "run", since: input.since, limit: 50 })
      .map((event) => readString(event.entity_id))
      .filter((entry): entry is string => Boolean(entry))
  )];
  const recentTaskIds = [...new Set(
    storage
      .listRuntimeEvents({ entity_type: "task", since: input.since, limit: 100 })
      .map((event) => readString(event.entity_id))
      .filter((entry): entry is string => Boolean(entry))
  )];
  const recentIncidentIds = [...new Set(
    storage
      .listRuntimeEvents({ entity_type: "incident", since: input.since, limit: 50 })
      .map((event) => readString(event.entity_id))
      .filter((entry): entry is string => Boolean(entry))
  )];
  const trichatSummary = storage.getTriChatSummary({ busiest_limit: 6 });

  await invokeTool("observability.ship", {
    mutation: deriveMutation(input.mutation, "observability-ship-task-queue"),
    source: "task_queue",
    since: input.since,
    limit: 250,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });
  shipped.push("task_queue");

  for (const taskId of recentTaskIds) {
    await invokeTool("observability.ship", {
      mutation: deriveMutation(input.mutation, `observability-ship-task-timeline:${taskId}`),
      source: "task_timeline",
      task_id: taskId,
      since: input.since,
      limit: 250,
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    });
    shipped.push(`task_timeline:${taskId}`);
  }

  for (const runId of recentRunIds) {
    await invokeTool("observability.ship", {
      mutation: deriveMutation(input.mutation, `observability-ship-run-timeline:${runId}`),
      source: "run_timeline",
      run_id: runId,
      since: input.since,
      limit: 250,
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    });
    shipped.push(`run_timeline:${runId}`);
  }

  for (const incidentId of recentIncidentIds) {
    await invokeTool("observability.ship", {
      mutation: deriveMutation(input.mutation, `observability-ship-incident-timeline:${incidentId}`),
      source: "incident_timeline",
      incident_id: incidentId,
      since: input.since,
      limit: 250,
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    });
    shipped.push(`incident_timeline:${incidentId}`);
  }

  if (trichatSummary.thread_counts.total > 0 || trichatSummary.message_count > 0) {
    await invokeTool("observability.ship", {
      mutation: deriveMutation(input.mutation, "observability-ship-trichat-summary"),
      source: "trichat_summary",
      limit: 12,
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    });
    shipped.push("trichat_summary");
  }

  return shipped;
}

function readTmuxTaskTelemetry(storage: Storage) {
  const state = storage.getTriChatTmuxControllerState();
  const tasks = state?.tasks ?? [];
  return {
    queue_depth: tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length,
    active_tasks: tasks.filter((task) => task.status === "running").length,
  };
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

function startupGraceActive(
  runtime: { running?: boolean | null; started_at?: string | null; last_tick_at?: string | null },
  intervalSeconds: number
) {
  if (runtime.running !== true || runtime.last_tick_at) {
    return false;
  }
  const startedAgeSeconds = isoAgeSeconds(runtime.started_at);
  return startedAgeSeconds <= Math.max(intervalSeconds * 2, 120);
}

type BackgroundSubsystemStatus = {
  enabled: boolean;
  running: boolean;
  stale: boolean;
  interval_seconds: number;
  last_tick_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  backlog_count: number;
  oldest_backlog_age_seconds: number | null;
  last_result: "healthy" | "idle" | "stopped" | "error";
};

function finiteAgeOrNull(value: string | null | undefined) {
  const ageSeconds = isoAgeSeconds(value);
  return Number.isFinite(ageSeconds) ? ageSeconds : null;
}

function buildBackgroundSubsystemStatus(input: {
  enabled: boolean;
  interval_seconds: number;
  runtime: Record<string, unknown>;
  backlog_count?: number;
  oldest_backlog_timestamp?: string | null;
}): BackgroundSubsystemStatus {
  const running = readBoolean(input.runtime.running) === true;
  const lastTickAt = readString(input.runtime.last_tick_at);
  const lastSuccessAt = readString(input.runtime.last_success_at);
  const lastError = readString(input.runtime.last_error);
  const stale =
    input.enabled &&
    startupGraceActive(
      {
        running,
        started_at: readString(input.runtime.started_at),
        last_tick_at: lastTickAt,
      },
      input.interval_seconds
    ) !== true &&
    isoAgeSeconds(lastTickAt) > Math.max(input.interval_seconds * 2, 120);
  const backlogCount = Math.max(0, Math.round(input.backlog_count ?? 0));
  const lastResult = lastError
    ? "error"
    : running
      ? stale
        ? "idle"
        : "healthy"
      : "stopped";
  return {
    enabled: input.enabled,
    running,
    stale,
    interval_seconds: input.interval_seconds,
    last_tick_at: lastTickAt,
    last_success_at: lastSuccessAt,
    last_error: lastError,
    backlog_count: backlogCount,
    oldest_backlog_age_seconds:
      backlogCount > 0 ? finiteAgeOrNull(input.oldest_backlog_timestamp ?? null) : null,
    last_result: lastResult,
  };
}

function buildMaintenanceSubsystems(storage: Storage) {
  const transcriptState = storage.getTranscriptAutoSquishState();
  const transcriptRuntime = asRecord(getAutoSquishRuntimeStatus());
  const transcriptBacklog = storage.listTranscriptRunsWithPending(200);
  const transcriptOldest = transcriptBacklog.reduce<string | null>((oldest, run) => {
    if (!run.oldest_timestamp) {
      return oldest;
    }
    if (!oldest) {
      return run.oldest_timestamp;
    }
    return Date.parse(run.oldest_timestamp) < Date.parse(oldest) ? run.oldest_timestamp : oldest;
  }, null);
  const transcriptAutoSquish = buildBackgroundSubsystemStatus({
    enabled: transcriptState?.enabled ?? false,
    interval_seconds: transcriptState?.interval_seconds ?? 60,
    runtime: transcriptRuntime,
    backlog_count: transcriptBacklog.reduce((sum, run) => sum + Math.max(0, run.unsquished_count), 0),
    oldest_backlog_timestamp: transcriptOldest,
  });

  const imprintState = storage.getImprintAutoSnapshotState();
  const imprintRuntime = asRecord(getAutoSnapshotRuntimeStatus());
  const imprintAutoSnapshot = buildBackgroundSubsystemStatus({
    enabled: imprintState?.enabled ?? false,
    interval_seconds: imprintState?.interval_seconds ?? 900,
    runtime: imprintRuntime,
  });

  const retentionState = storage.getTriChatAutoRetentionState();
  const retentionRuntime = asRecord(getTriChatAutoRetentionRuntimeStatus());
  const triChatAutoRetention = buildBackgroundSubsystemStatus({
    enabled: retentionState?.enabled ?? false,
    interval_seconds: retentionState?.interval_seconds ?? 600,
    runtime: retentionRuntime,
  });

  const watchdogState = storage.getTriChatTurnWatchdogState();
  const watchdogRuntime = asRecord(getTriChatTurnWatchdogRuntimeStatus());
  const watchdogStaleTurns = storage.listStaleRunningTriChatTurns({
    stale_before_iso: new Date(Date.now() - (watchdogState?.stale_after_seconds ?? 180) * 1000).toISOString(),
    limit: watchdogState?.batch_limit ?? 200,
  });
  const triChatTurnWatchdog = buildBackgroundSubsystemStatus({
    enabled: watchdogState?.enabled ?? false,
    interval_seconds: watchdogState?.interval_seconds ?? 30,
    runtime: watchdogRuntime,
    backlog_count: watchdogStaleTurns.length,
    oldest_backlog_timestamp: watchdogStaleTurns[0]?.updated_at ?? null,
  });

  return {
    transcript_auto_squish: transcriptAutoSquish,
    imprint_auto_snapshot: imprintAutoSnapshot,
    trichat_auto_retention: triChatAutoRetention,
    trichat_turn_watchdog: triChatTurnWatchdog,
  };
}

function taskFailuresAreStale(taskSummary: TaskSummaryRecord) {
  if ((taskSummary.counts.failed ?? 0) === 0 || !taskSummary.last_failed || !taskSummary.last_completed) {
    return false;
  }
  return taskSummary.last_completed.updated_at > taskSummary.last_failed.updated_at;
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
    "Do not mutate repo code from maintain ticks; only adjust org-program doctrine through measured optimizer promotion.",
    "Promote org-program variants only when compile-preview score improves by the configured minimum threshold.",
  ];
}

type SelfDriveCandidate = {
  title: string;
  objective: string;
  tags: string[];
  reason: string;
  metadata: Record<string, unknown>;
  dry_run: boolean;
  trichat_bridge_dry_run: boolean;
  permission_profile: "bounded_execute" | "network_enabled";
  constraints?: string[];
};

export function isTransientModelRouterResidencyAttention(entry: string) {
  return /^model\.router\..+\.(prewarm|unload)_failed$/.test(entry.trim());
}

function buildSelfDriveCandidate(params: {
  attention: string[];
  providerBridgeEntries: Array<Record<string, unknown>>;
  patientZeroSummary: Record<string, unknown>;
}): SelfDriveCandidate | null {
  const rawAttention = [...new Set(params.attention.map((entry) => String(entry ?? "").trim()).filter(Boolean))].filter(
    (entry) => entry !== "agent.learning.no_active_entries"
  );
  const transientResidencyAttention = rawAttention.filter(isTransientModelRouterResidencyAttention);
  const repairableAttention = rawAttention.filter((entry) => !isTransientModelRouterResidencyAttention(entry));
  const patientZeroEnabled = readBoolean(params.patientZeroSummary.enabled) === true;
  const patientZeroAutonomyEnabled = readBoolean(params.patientZeroSummary.autonomy_enabled) === true;
  const patientZeroObserveReady = readBoolean(params.patientZeroSummary.observe_ready) === true;
  const patientZeroActReady = readBoolean(params.patientZeroSummary.act_ready) === true;
  const patientZeroBrowserReady = readBoolean(params.patientZeroSummary.browser_ready) === true;
  const patientZeroExplorationReady =
    patientZeroEnabled &&
    patientZeroAutonomyEnabled &&
    ((patientZeroObserveReady && patientZeroActReady) || patientZeroBrowserReady);
  const nonBlockingExplorationAttention = patientZeroExplorationReady
    ? repairableAttention.filter(
        (entry) =>
          entry.startsWith("provider.bridge.") ||
          entry.startsWith("litellm_proxy.degraded_endpoints:")
      )
    : [];
  const blockingRepairableAttention = patientZeroExplorationReady
    ? repairableAttention.filter((entry) => !nonBlockingExplorationAttention.includes(entry))
    : repairableAttention;
  const disconnectedProviders = params.providerBridgeEntries
    .filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "disconnected")
    .map((entry) => ({
      client_id: String(entry.client_id ?? "").trim(),
      display_name: String(entry.display_name ?? "").trim() || String(entry.client_id ?? "").trim(),
    }))
    .filter((entry) => entry.client_id.length > 0);
  const evalIssues = blockingRepairableAttention.filter((entry) => entry.startsWith("eval."));
  const subsystemIssues = blockingRepairableAttention.filter((entry) => /\.(not_running|stale|error)$/.test(entry));
  const providerIssues = blockingRepairableAttention.filter((entry) => entry.startsWith("provider.bridge."));
  const localIssues = blockingRepairableAttention.filter((entry) => entry.startsWith("local."));
  const topAttention = blockingRepairableAttention.slice(0, 3);
  if (evalIssues.length > 0) {
    return {
      title: "[self-drive] Restore eval health",
      objective:
        "Investigate the failing control-plane eval posture, restore the autonomy evaluation baseline above policy, and record the concrete cause if the issue cannot be repaired automatically.",
      tags: ["self-drive", "eval", "control-plane"],
      reason: "eval",
      metadata: { attention: evalIssues },
      dry_run: true,
      trichat_bridge_dry_run: true,
      permission_profile: "bounded_execute",
    };
  }
  if (subsystemIssues.length > 0) {
    return {
      title: "[self-drive] Stabilize control plane services",
      objective:
        "Inspect the control-plane subsystems that are stale, errored, or not running, apply only bounded local repairs, and verify the service state returns to healthy.",
      tags: ["self-drive", "reliability", "control-plane"],
      reason: "subsystems",
      metadata: { attention: subsystemIssues },
      dry_run: true,
      trichat_bridge_dry_run: true,
      permission_profile: "bounded_execute",
    };
  }
  if (providerIssues.length > 0) {
    return {
      title: "[self-drive] Audit provider bridge health",
      objective: `Audit disconnected provider bridges (${disconnectedProviders
        .map((entry) => entry.display_name)
        .join(", ") || "unknown"}), repair any local config issue that can be fixed without new credentials, and record exact blockers for anything that still needs human re-authentication.`,
      tags: ["self-drive", "provider-bridge", "auth"],
      reason: "provider-bridge",
      metadata: { attention: providerIssues, disconnected_providers: disconnectedProviders },
      dry_run: true,
      trichat_bridge_dry_run: true,
      permission_profile: "bounded_execute",
    };
  }
  if (localIssues.length > 0) {
    return {
      title: "[self-drive] Reduce local runtime pressure",
      objective:
        "Inspect the local execution budget and host pressure signals, apply only bounded local scheduling or routing fixes, and verify the host returns to a healthier operating posture.",
      tags: ["self-drive", "runtime", "local-host"],
      reason: "local-runtime",
      metadata: { attention: localIssues },
      dry_run: true,
      trichat_bridge_dry_run: true,
      permission_profile: "bounded_execute",
    };
  }
  if (blockingRepairableAttention.length <= 0 && patientZeroExplorationReady) {
    return {
      title: "[self-drive] Explore local agentic ecosystem",
      objective:
        "Conduct one bounded exploratory reconnaissance pass using the currently armed local-first autonomy stack. Focus on MCP tooling, local agent orchestration, desktop/browser execution, or local AI infrastructure. Gather operator-visible findings from at least two surfaces, compare what looks promising versus brittle, and leave one concrete next action that would improve the system without broad refactors or hidden reasoning dumps.",
      tags: ["self-drive", "exploration", "patient-zero", "recon"],
      reason: "exploration",
      metadata: {
        attention: [],
        exploration_theme: "local-agentic-ecosystem",
        non_blocking_attention: [...new Set([...transientResidencyAttention, ...nonBlockingExplorationAttention])],
        patient_zero_required: true,
      },
      dry_run: false,
      trichat_bridge_dry_run: false,
      permission_profile: "network_enabled",
      constraints: [
        "Keep the exploration bounded to one concrete theme and one operator-visible summary.",
        "Prefer local-first and browser-accessible sources; do not install new software or request new credentials.",
        "Do not make broad repo mutations or recursive self-improvement plans from exploratory runs.",
      ],
    };
  }
  if (blockingRepairableAttention.length <= 0) {
    return null;
  }
  return {
    title: "[self-drive] Resolve control-plane attention",
    objective: `Inspect the current control-plane attention set (${topAttention.join(
      ", "
    )}), fix any bounded local issue that is actionable without human input, and record blockers for anything external.`,
    tags: ["self-drive", "control-plane"],
    reason: "generic",
    metadata: { attention: topAttention },
    dry_run: true,
    trichat_bridge_dry_run: true,
    permission_profile: "bounded_execute",
  };
}

function buildDefaultState(
  input: Pick<
    AutonomyMaintainInput,
    | "local_host_id"
    | "interval_seconds"
    | "learning_review_interval_seconds"
    | "enable_self_drive"
    | "self_drive_cooldown_seconds"
    | "run_eval_if_due"
    | "eval_interval_seconds"
    | "eval_suite_id"
    | "minimum_eval_score"
  >
): AutonomyMaintainStateRecord {
  return {
    enabled: false,
    local_host_id: input.local_host_id,
    interval_seconds: input.interval_seconds,
    learning_review_interval_seconds: input.learning_review_interval_seconds,
    enable_self_drive: input.enable_self_drive,
    self_drive_cooldown_seconds: input.self_drive_cooldown_seconds,
    run_eval_if_due: input.run_eval_if_due,
    eval_interval_seconds: input.eval_interval_seconds,
    eval_suite_id: input.eval_suite_id,
    minimum_eval_score: input.minimum_eval_score,
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
    last_eval_dependency_fingerprint: null,
    last_observability_ship_at: null,
    last_provider_bridge_check_at: null,
    provider_bridge_diagnostics: [],
    last_self_drive_at: null,
    last_self_drive_goal_id: null,
    last_self_drive_fingerprint: null,
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
    run_goal_hygiene: readBoolean(input.run_goal_hygiene) ?? fallback.run_goal_hygiene,
    goal_hygiene_limit: readNumber(input.goal_hygiene_limit) ?? fallback.goal_hygiene_limit,
    run_task_recovery: readBoolean(input.run_task_recovery) ?? fallback.run_task_recovery,
    task_recovery_limit: readNumber(input.task_recovery_limit) ?? fallback.task_recovery_limit,
    start_runtime_workers: readBoolean(input.start_runtime_workers) ?? fallback.start_runtime_workers,
    runtime_worker_limit: readNumber(input.runtime_worker_limit) ?? fallback.runtime_worker_limit,
    runtime_worker_max_active: readNumber(input.runtime_worker_max_active) ?? fallback.runtime_worker_max_active,
    start_task_auto_retry_daemon:
      readBoolean(input.start_task_auto_retry_daemon) ?? fallback.start_task_auto_retry_daemon,
    task_auto_retry_interval_seconds:
      readNumber(input.task_auto_retry_interval_seconds) ?? fallback.task_auto_retry_interval_seconds,
    task_auto_retry_batch_limit:
      readNumber(input.task_auto_retry_batch_limit) ?? fallback.task_auto_retry_batch_limit,
    task_auto_retry_base_delay_seconds:
      readNumber(input.task_auto_retry_base_delay_seconds) ?? fallback.task_auto_retry_base_delay_seconds,
    task_auto_retry_max_delay_seconds:
      readNumber(input.task_auto_retry_max_delay_seconds) ?? fallback.task_auto_retry_max_delay_seconds,
    start_transcript_auto_squish_daemon:
      readBoolean(input.start_transcript_auto_squish_daemon) ?? fallback.start_transcript_auto_squish_daemon,
    start_imprint_auto_snapshot_daemon:
      readBoolean(input.start_imprint_auto_snapshot_daemon) ?? fallback.start_imprint_auto_snapshot_daemon,
    start_trichat_auto_retention_daemon:
      readBoolean(input.start_trichat_auto_retention_daemon) ?? fallback.start_trichat_auto_retention_daemon,
    start_trichat_turn_watchdog_daemon:
      readBoolean(input.start_trichat_turn_watchdog_daemon) ?? fallback.start_trichat_turn_watchdog_daemon,
    start_reaction_engine_daemon:
      readBoolean(input.start_reaction_engine_daemon) ?? fallback.start_reaction_engine_daemon,
    reaction_engine_interval_seconds:
      readNumber(input.reaction_engine_interval_seconds) ?? fallback.reaction_engine_interval_seconds,
    reaction_engine_dedupe_window_seconds:
      readNumber(input.reaction_engine_dedupe_window_seconds) ?? fallback.reaction_engine_dedupe_window_seconds,
    reaction_engine_channels: Array.isArray(input.reaction_engine_channels)
      ? input.reaction_engine_channels
      : fallback.reaction_engine_channels,
    reaction_engine_webhook_url:
      readString(input.reaction_engine_webhook_url) ?? fallback.reaction_engine_webhook_url,
    autorun_interval_seconds:
      readNumber(input.autorun_interval_seconds) ?? fallback.autorun_interval_seconds,
    maintain_tmux_controller:
      readBoolean(input.maintain_tmux_controller) ?? fallback.maintain_tmux_controller,
    tmux_capture_lines: readNumber(input.tmux_capture_lines) ?? fallback.tmux_capture_lines,
    enable_self_drive: readBoolean(input.enable_self_drive) ?? fallback.enable_self_drive,
    self_drive_cooldown_seconds:
      readNumber(input.self_drive_cooldown_seconds) ?? fallback.self_drive_cooldown_seconds,
    run_eval_if_due: readBoolean(input.run_eval_if_due) ?? fallback.run_eval_if_due,
    eval_interval_seconds: readNumber(input.eval_interval_seconds) ?? fallback.eval_interval_seconds,
    eval_suite_id: readString(input.eval_suite_id) ?? fallback.eval_suite_id,
    eval_host_id: readString(input.eval_host_id) ?? fallback.eval_host_id,
    minimum_eval_score: readNumber(input.minimum_eval_score) ?? fallback.minimum_eval_score,
    run_optimizer_if_due: readBoolean(input.run_optimizer_if_due) ?? fallback.run_optimizer_if_due,
    optimizer_interval_seconds:
      readNumber(input.optimizer_interval_seconds) ?? fallback.optimizer_interval_seconds,
    optimizer_min_improvement:
      readNumber(input.optimizer_min_improvement) ?? fallback.optimizer_min_improvement,
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

export function isAutonomyMaintainAwaitingFirstTick(
  state: Pick<AutonomyMaintainStateRecord, "enabled" | "last_run_at"> | null | undefined,
  runtime: AutonomyMaintainRuntimeStatusLike
) {
  return (
    state?.enabled === true &&
    runtime.running === true &&
    !readString(state?.last_run_at) &&
    !readString(runtime.last_tick_at)
  );
}

function resolveProviderBridgeHeartbeat(
  state: AutonomyMaintainStateRecord | null,
  options: {
    workspace_root: string;
    probe_timeout_ms?: number;
    prefer_persisted?: boolean;
  }
) {
  const persistedDiagnostics = Array.isArray(state?.provider_bridge_diagnostics)
    ? state.provider_bridge_diagnostics
    : [];
  if (options.prefer_persisted !== false && persistedDiagnostics.length > 0) {
    return {
      generated_at: state?.last_provider_bridge_check_at ?? state?.updated_at ?? new Date().toISOString(),
      cached: true,
      diagnostics: persistedDiagnostics,
    };
  }
  return resolveProviderBridgeDiagnostics({
    workspace_root: options.workspace_root,
    probe_timeout_ms: options.probe_timeout_ms,
  });
}

function buildEffectiveRuntimeStatus(
  runtime: ReturnType<typeof buildRuntimeStatus>,
  state: AutonomyMaintainStateRecord | null
) {
  if (!state) {
    return runtime;
  }
  const inferredRunning =
    runtime.running === true ||
    (state.enabled === true &&
      !readString(runtime.last_error) &&
      isoAgeSeconds(state.last_run_at) <= Math.max(state.interval_seconds * 3, 300));
  return {
    ...runtime,
    local_running: runtime.running,
    inferred_running: runtime.running !== true && inferredRunning,
    running: inferredRunning,
    last_tick_at: readString(runtime.last_tick_at) ?? state.last_run_at,
  };
}

function readMetadataOptimizerField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const optimizer = (value as Record<string, unknown>).optimizer;
  if (typeof optimizer !== "object" || optimizer === null || Array.isArray(optimizer)) {
    return null;
  }
  return (optimizer as Record<string, unknown>)[field];
}

function selectOptimizerFocusAreas(roleId: string, lane: string | null) {
  const normalized = `${roleId} ${lane ?? ""}`.toLowerCase();
  const selected = new Set<string>(["bounded_execution", "explicit_evidence", "verification_first", "fail_closed"]);
  if (/\bimplement|code|build\b/.test(normalized)) {
    selected.add("rollback_ready");
    selected.add("local_first");
  }
  if (/\bresearch|intel|discover\b/.test(normalized)) {
    selected.add("specialist_routing");
  }
  if (/\bverify|quality|test|review\b/.test(normalized)) {
    selected.add("rollback_ready");
  }
  if (/\bring|director|coord|orchestr/.test(normalized)) {
    selected.add("parallel_delegation");
    selected.add("specialist_routing");
    selected.add("local_first");
  }
  return [...selected].slice(0, 6);
}

function buildOptimizerObjectives(storage: Storage, roleTitle: string, lane: string | null) {
  const goals = [
    ...storage.listGoals({ status: "active", limit: 3 }),
    ...storage.listGoals({ status: "waiting", limit: 2 }),
    ...storage.listGoals({ status: "draft", limit: 2 }),
  ]
    .map((goal) => goal.objective.trim())
    .filter(Boolean);
  if (goals.length > 0) {
    return goals.slice(0, 3).map(
      (objective) =>
        `As ${roleTitle}, improve doctrine so this objective compiles into bounded, evidence-backed work: ${objective}`
    );
  }
  if ((lane ?? "").toLowerCase().includes("implementation")) {
    return [
      `As ${roleTitle}, implement narrow local-first changes with explicit evidence and rollback notes.`,
      `As ${roleTitle}, keep implementation plans bounded to one owner per slice and verification-first.`,
    ];
  }
  if ((lane ?? "").toLowerCase().includes("verification")) {
    return [
      `As ${roleTitle}, tighten verification gates so completion requires reproducible proof, not summaries.`,
      `As ${roleTitle}, reject ambiguous completion and escalate weak confidence instead of guessing.`,
    ];
  }
  if ((lane ?? "").toLowerCase().includes("research")) {
    return [
      `As ${roleTitle}, route domain questions to the narrowest specialist and return evidence-backed findings.`,
      `As ${roleTitle}, keep research local-first and fail closed when evidence is thin.`,
    ];
  }
  return [
    `As ${roleTitle}, improve bounded delegation, explicit evidence, and fail-closed behavior.`,
    `As ${roleTitle}, produce plans that stay local-first and verification-first under pressure.`,
  ];
}

function scoreOptimizerRoleRelevance(roleId: string, lane: string | null, activeObjectives: string[]) {
  if (activeObjectives.length === 0) {
    return 0;
  }
  const roleText = `${roleId} ${lane ?? ""}`.toLowerCase();
  let score = 0;
  for (const objective of activeObjectives) {
    const normalized = objective.toLowerCase();
    if (/\bimplement|build|code|patch|refactor|fix|ship|service\b/.test(normalized) && /\bimplement|code|build|smith\b/.test(roleText)) {
      score += 3;
    }
    if (/\bverify|test|review|validate|qa|evidence\b/.test(normalized) && /\bverify|quality|guard|test\b/.test(roleText)) {
      score += 3;
    }
    if (/\bresearch|investigat|discover|analy|summarize|docs?\b/.test(normalized) && /\bresearch|scout|intel\b/.test(roleText)) {
      score += 3;
    }
    if (/\bdelegate|coordinate|orchestr|plan|route\b/.test(normalized) && /\bring|director|lead\b/.test(roleText)) {
      score += 2;
    }
    if (/\blocal|on-device|mcp|autonom/.test(normalized) && /\bring|director|code|quality|research|imprint\b/.test(roleText)) {
      score += 1;
    }
  }
  return score;
}

function deriveOptimizerPlan(storage: Storage, intervalSeconds: number) {
  const state = loadOrgPrograms(storage);
  const activeObjectives = [
    ...storage.listGoals({ status: "active", limit: 4 }),
    ...storage.listGoals({ status: "waiting", limit: 2 }),
    ...storage.listGoals({ status: "draft", limit: 2 }),
  ]
    .map((goal) => goal.objective.trim())
    .filter(Boolean);
  const candidates = state.roles
    .filter((role) => role.active_version_id || role.versions.some((entry) => entry.status === "active"))
    .map((role) => {
      const lastRunAtRaw = readMetadataOptimizerField(role.metadata, "last_run_at");
      const lastRunAt = typeof lastRunAtRaw === "string" && lastRunAtRaw.trim().length > 0 ? lastRunAtRaw : null;
      return {
        role_id: role.role_id,
        title: role.title,
        lane: role.lane ?? null,
        last_run_at: lastRunAt,
        age_seconds: isoAgeSeconds(lastRunAt),
        relevance_score: scoreOptimizerRoleRelevance(role.role_id, role.lane ?? null, activeObjectives),
      };
    })
    .sort((left, right) => {
      if (left.relevance_score !== right.relevance_score) {
        return right.relevance_score - left.relevance_score;
      }
      const leftAge = left.age_seconds ?? Number.POSITIVE_INFINITY;
      const rightAge = right.age_seconds ?? Number.POSITIVE_INFINITY;
      if (leftAge !== rightAge) {
        return rightAge - leftAge;
      }
      return left.role_id.localeCompare(right.role_id);
    });
  const selected = candidates[0] ?? null;
  const due = selected ? (selected.age_seconds ?? Number.POSITIVE_INFINITY) > intervalSeconds : false;
  return {
    enabled: state.enabled,
    due,
    role_count: state.roles.length,
    selected_role_id: selected?.role_id ?? null,
    selected_role_title: selected?.title ?? null,
    selected_lane: selected?.lane ?? null,
    last_run_at: selected?.last_run_at ?? null,
    last_run_age_seconds: selected?.age_seconds ?? null,
    focus_areas: selected ? selectOptimizerFocusAreas(selected.role_id, selected.lane) : [],
    objectives: selected ? buildOptimizerObjectives(storage, selected.title, selected.lane) : [],
  };
}

function buildRecentRouterSuppressionSummary(storage: Storage, params?: { limit?: number; max_age_seconds?: number }) {
  const limit =
    typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(12, Math.trunc(params.limit))) : 5;
  const maxAgeSeconds =
    typeof params?.max_age_seconds === "number" && Number.isFinite(params.max_age_seconds)
      ? Math.max(300, Math.trunc(params.max_age_seconds))
      : 21600;
  const now = Date.now();
  const events = storage.listRuntimeEvents({
    event_type: "autonomy.command",
    limit: Math.max(40, limit * 10),
  });
  const entries: Array<{
    decision_id: string | null;
    observed_at: string | null;
    reason: "local_first_required" | "local_evidence_missing" | "laptop_pressure";
    selected_backend_id: string | null;
    pressure_level: string | null;
    pressure_reason: string | null;
    suppressed_agent_ids: string[];
  }> = [];
  for (let index = events.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const event = events[index];
    const details = asRecord(event.details);
    const reason =
      readBoolean(details.model_router_auto_bridge_suppressed_for_resource_gate) === true
        ? "laptop_pressure"
        : readBoolean(details.model_router_auto_bridge_suppressed_for_missing_local_attempt_evidence) === true
          ? "local_evidence_missing"
          : readBoolean(details.model_router_auto_bridge_suppressed_for_local_first) === true
            ? "local_first_required"
            : null;
    if (!reason) {
      continue;
    }
    const observedAt = readString(event.created_at);
    const observedStamp = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (Number.isFinite(observedStamp) && now - observedStamp > maxAgeSeconds * 1000) {
      continue;
    }
    const gate = asRecord(details.model_router_resource_gate);
    entries.push({
      decision_id: readString(details.model_router_suppression_decision_id),
      observed_at: observedAt,
      reason,
      selected_backend_id: readString(details.model_router_backend_id),
      pressure_level: readString(gate.severity),
      pressure_reason:
        readString(details.model_router_auto_bridge_resource_gate_reason) ?? readString(gate.reason) ?? null,
      suppressed_agent_ids: dedupeStrings(details.model_router_auto_bridge_suppressed_agent_ids),
    });
  }
  return {
    entries,
    latest_attention: entries[0] ? `model.router.auto_bridge_suppressed.${entries[0].reason}` : null,
    latest_reason: entries[0]?.reason ?? null,
  };
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
    | "start_goal_autorun_daemon"
    | "run_eval_if_due"
    | "eval_interval_seconds"
    | "eval_suite_id"
    | "minimum_eval_score"
    | "run_optimizer_if_due"
    | "optimizer_interval_seconds"
    | "optimizer_min_improvement"
    | "enable_self_drive"
    | "self_drive_cooldown_seconds"
    | "fast"
    | "interval_seconds"
    | "learning_review_interval_seconds"
  >,
  stateOverride?: AutonomyMaintainStateRecord | null
) {
  const rawState = stateOverride ?? storage.getAutonomyMaintainState() ?? buildDefaultState(input);
  const runtime = buildEffectiveRuntimeStatus(buildRuntimeStatus(), rawState);
  const state =
    rawState.enabled === false && runtime.running === true
      ? {
          ...rawState,
          enabled: true,
          last_run_at: rawState.last_run_at ?? readString(runtime.last_tick_at),
        }
      : rawState;
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
  const taskAutoRetry = asRecord(await invokeTool("task.auto_retry", { action: "status" }));
  const reactionEngine = asRecord(await invokeTool("reaction.engine", { action: "status" }));
  const runtimeWorkers = asRecord(await invokeTool("runtime.worker", { action: "status", limit: 20 }));
  const taskSummary = storage.getTaskSummary({ running_limit: 12 });
  const runtimeEligiblePendingTasks = countRuntimeEligibleTasks(storage, "pending");
  const runtimeEligibleFailedTasks = countRuntimeEligibleTasks(storage, "failed");
  const subsystems = buildMaintenanceSubsystems(storage);
  const tmux = asRecord(await invokeTool("trichat.tmux_controller", { action: "status" }));
  const localProfile = captureLocalHostProfile({ workspace_root: process.cwd() });
  const localExecutionBudget = deriveLocalExecutionBudget(localProfile, {
    pending_tasks: runtimeEligiblePendingTasks,
    tmux_queue_depth: readNumber(asRecord(tmux.dashboard).queue_depth) ?? 0,
    fabric_queue_depth: 0,
    active_runtime_workers: readNumber(asRecord(runtimeWorkers.summary).active_count) ?? 0,
  });
  const optimizer = deriveOptimizerPlan(storage, input.optimizer_interval_seconds);
  const learning = buildAgentLearningOverview(storage, {
    limit: 250,
    top_agents_limit: 8,
    recent_limit: 8,
  });
  const tmuxDashboard = asRecord(tmux.dashboard);
  const lastRunAgeSeconds = isoAgeSeconds(state.last_run_at);
  const learningReviewAgeSeconds = isoAgeSeconds(state.last_learning_review_at);
  const evalHealth = buildEvalHealth(state, {
    ...input,
    current_dependency_fingerprint: computeEvalDependencyFingerprint(storage, input.eval_suite_id),
  });
  const providerBridgeDiagnostics = resolveProviderBridgeHeartbeat(state, {
    workspace_root: process.cwd(),
    probe_timeout_ms: input.fast === true ? 1500 : 2500,
  });
  const providerBridgeEntries = Array.isArray(providerBridgeDiagnostics.diagnostics)
    ? providerBridgeDiagnostics.diagnostics
    : [];
  const recentRouterSuppression = buildRecentRouterSuppressionSummary(storage);
  const desktopControlState = storage.getDesktopControlState();
  const desktopControlSummary = summarizeDesktopControlState(desktopControlState);
  const due = {
    stale:
      startupGraceActive(runtime, state.interval_seconds) !== true &&
      lastRunAgeSeconds > Math.max(state.interval_seconds * 3, 300),
    learning_review: learningReviewAgeSeconds > state.learning_review_interval_seconds,
    eval: evalHealth.due,
  };
  const attention = [...new Set([...((bootstrap.repairs_needed as string[] | undefined) ?? [])])]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (input.start_goal_autorun_daemon !== false && readBoolean(goalAutorun.running) !== true) {
    attention.push("goal.autorun_daemon.not_running");
  }
  if ((taskSummary.expired_running_count ?? 0) > 0) {
    attention.push("task.running_lease_expired");
  }
  if (taskSummary.counts.failed > 0 && readBoolean(taskAutoRetry.running) !== true) {
    attention.push("task.auto_retry.not_running");
  }
  if ((readNumber(asRecord(runtimeWorkers.summary).active_count) ?? 0) <= 0 && runtimeEligiblePendingTasks > 0) {
    attention.push("runtime.worker.idle_with_pending");
  }
  if (readBoolean(asRecord(reactionEngine.state).enabled) !== true) {
    attention.push("reaction.engine.not_enabled");
  } else if (readBoolean(asRecord(reactionEngine.runtime).running) !== true) {
    attention.push("reaction.engine.not_running");
  } else if (readBoolean(asRecord(reactionEngine.due).stale) === true) {
    attention.push("reaction.engine.stale");
  }
  if (readBoolean(asRecord(tmux.state).enabled) === true && readNumber(tmuxDashboard.queue_depth) === null) {
    attention.push("trichat.tmux_controller.dashboard_missing");
  }
  if (learning.active_entry_count === 0) {
    attention.push("agent.learning.no_active_entries");
  }
  for (const entry of providerBridgeEntries) {
    const clientId = String(entry.client_id ?? "").trim();
    const status = String(entry.status ?? "").trim().toLowerCase();
    if (!clientId || status !== "disconnected") {
      continue;
    }
    attention.push(`provider.bridge.${clientId}.disconnected`);
  }
  if (recentRouterSuppression.latest_attention) {
    attention.push(recentRouterSuppression.latest_attention);
  }
  if (desktopControlSummary.enabled && desktopControlSummary.stale) {
    attention.push("desktop.control.stale");
  }
  if (desktopControlSummary.enabled && !desktopControlSummary.observe_ready && desktopControlState.allow_observe) {
    attention.push("desktop.control.observe_unavailable");
  }
  if (desktopControlSummary.enabled && !desktopControlSummary.act_ready && desktopControlState.allow_act) {
    attention.push("desktop.control.act_unavailable");
  }
  if (desktopControlSummary.enabled && !desktopControlSummary.listen_ready && desktopControlState.allow_listen) {
    attention.push("desktop.control.listen_unavailable");
  }
  if (evalHealth.below_threshold) {
    attention.push(`eval.${evalHealth.suite_id}.below_threshold`);
  } else if (input.run_eval_if_due !== false && evalHealth.due_by_dependency_drift) {
    attention.push(`eval.${evalHealth.suite_id}.definition_changed`);
  } else if (input.run_eval_if_due !== false && evalHealth.due_by_age) {
    attention.push(`eval.${evalHealth.suite_id}.overdue`);
  }
  for (const [subsystemKey, subsystem] of Object.entries(subsystems)) {
    if (!subsystem.enabled) {
      continue;
    }
    if (subsystem.running !== true) {
      attention.push(`${subsystemKey}.not_running`);
    }
    if (subsystem.stale) {
      attention.push(`${subsystemKey}.stale`);
    }
    if (subsystem.last_error) {
      attention.push(`${subsystemKey}.error`);
    }
  }
  const awaitingFirstTick = isAutonomyMaintainAwaitingFirstTick(state, runtime);
  const dedupedAttention = [...new Set(attention)];
  if (awaitingFirstTick && !dedupedAttention.includes("autonomy_maintain.awaiting_first_tick")) {
    dedupedAttention.unshift("autonomy_maintain.awaiting_first_tick");
  }
  return {
    state,
    runtime,
    bootstrap,
    goal_autorun_daemon: goalAutorun,
    task_auto_retry: {
      ...taskAutoRetry,
      expired_running_task_count: taskSummary.expired_running_count ?? 0,
      failed_task_count: taskSummary.counts.failed,
      last_failed_task_id: taskSummary.last_failed?.task_id ?? null,
    },
    reaction_engine: reactionEngine,
    runtime_workers: runtimeWorkers,
    subsystems,
    optimizer,
    local_capacity: {
      safe_worker_count: localProfile.safe_worker_count,
      safe_max_queue_per_worker: localProfile.safe_max_queue_per_worker,
      max_local_model_concurrency: localProfile.max_local_model_concurrency,
      runtime_eligible_pending_tasks: runtimeEligiblePendingTasks,
      runtime_eligible_failed_tasks: runtimeEligibleFailedTasks,
      runtime_worker_limit: localExecutionBudget.runtime_worker_limit,
      runtime_worker_max_active: localExecutionBudget.runtime_worker_max_active,
      tmux_recommended_worker_count: localExecutionBudget.tmux_recommended_worker_count,
      tmux_min_worker_count: localExecutionBudget.tmux_min_worker_count,
      tmux_target_queue_per_worker: localExecutionBudget.tmux_target_queue_per_worker,
    },
    tmux_controller: {
      enabled: readBoolean(asRecord(tmux.state).enabled) === true,
      queue_depth: readNumber(tmuxDashboard.queue_depth) ?? 0,
      queue_age_seconds: readNumber(tmuxDashboard.queue_age_seconds),
      worker_count: readNumber(asRecord(tmux.state).worker_count) ?? 0,
    },
    learning,
    provider_bridge: {
      generated_at: providerBridgeDiagnostics.generated_at,
      cached: providerBridgeDiagnostics.cached,
      last_check_at: state.last_provider_bridge_check_at,
      stale:
        isoAgeSeconds(state.last_provider_bridge_check_at) >
        Math.max((state.interval_seconds || input.interval_seconds || 120) * 3, 300),
      connected_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "connected").length,
      configured_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "configured").length,
      disconnected_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "disconnected").length,
      unavailable_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "unavailable").length,
      diagnostics: providerBridgeEntries,
    },
    desktop_control: {
      state: desktopControlState,
      summary: desktopControlSummary,
    },
    self_drive: {
      enabled: state.enabled && state.enable_self_drive,
      last_run_at: state.last_self_drive_at,
      last_goal_id: state.last_self_drive_goal_id,
      last_fingerprint: state.last_self_drive_fingerprint,
    },
    eval_health: evalHealth,
    due,
    guardrails: buildGuardrails(),
    awaiting_first_tick: awaitingFirstTick,
    attention: dedupedAttention,
  };
}

function buildFastStatus(
  storage: Storage,
  input: Pick<
    AutonomyMaintainInput,
    | "local_host_id"
    | "enable_self_drive"
    | "self_drive_cooldown_seconds"
    | "eval_suite_id"
    | "run_eval_if_due"
    | "eval_interval_seconds"
    | "minimum_eval_score"
    | "interval_seconds"
    | "learning_review_interval_seconds"
  >,
  stateOverride?: AutonomyMaintainStateRecord | null
) {
  const rawState = stateOverride ?? storage.getAutonomyMaintainState() ?? buildDefaultState(input);
  let runtime = buildEffectiveRuntimeStatus(buildRuntimeStatus(), rawState);
  const state =
    rawState.enabled === false && runtime.running === true
      ? {
          ...rawState,
          enabled: true,
          last_run_at: rawState.last_run_at ?? readString(runtime.last_tick_at) ?? null,
        }
      : rawState;
  if (runtime.running !== true && state.enabled === true && !readString(runtime.last_error) && !readString(state.last_error)) {
    runtime = {
      ...runtime,
      local_running: runtime.running,
      inferred_running: true,
      running: true,
      started_at: readString(runtime.started_at) ?? state.last_run_at ?? state.updated_at ?? null,
      last_tick_at: readString(runtime.last_tick_at) ?? state.last_run_at ?? null,
    };
  }
  const evalHealth = buildEvalHealth(state, {
    ...input,
    current_dependency_fingerprint: computeEvalDependencyFingerprint(storage, input.eval_suite_id),
  });
  const lastRunAgeSeconds = isoAgeSeconds(state.last_run_at);
  const learningReviewAgeSeconds = isoAgeSeconds(state.last_learning_review_at);
  const due = {
    stale:
      startupGraceActive(runtime, state.interval_seconds) !== true &&
      lastRunAgeSeconds > Math.max(state.interval_seconds * 3, 300),
    learning_review: learningReviewAgeSeconds > state.learning_review_interval_seconds,
    eval: evalHealth.due,
  };
  const awaitingFirstTick = isAutonomyMaintainAwaitingFirstTick(state, runtime);
  const attention = [...new Set((state.last_attention ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  if (awaitingFirstTick) {
    attention.unshift("autonomy_maintain.awaiting_first_tick");
  }
  return {
    state: {
      enabled: state.enabled !== false,
      last_run_at: state.last_run_at,
      last_error: state.last_error,
    },
    runtime,
    due,
    eval_health: evalHealth,
    awaiting_first_tick: awaitingFirstTick,
    attention,
    fast: true,
    source: "autonomy.maintain.fast_status",
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
  if (input.start_goal_autorun_daemon !== false && readBoolean(goalAutorunStatus.running) !== true) {
    attention.push("goal.autorun_daemon.not_running");
  }

  let goalHygieneResult: Record<string, unknown> | null = null;
  if (input.run_goal_hygiene !== false) {
    goalHygieneResult = asRecord(
      await invokeTool("goal.hygiene", {
        mutation: deriveMutation(input.mutation!, "goal-hygiene"),
        limit: input.goal_hygiene_limit,
        archive_idle_ephemeral_goals: true,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      })
    );
    actions.push("goal.hygiene");
  }

  let taskSummary = storage.getTaskSummary({ running_limit: 12 });
  let taskRecoveryResult: Record<string, unknown> | null = null;
  if (input.run_task_recovery !== false) {
    taskRecoveryResult = asRecord(
      await invokeTool("task.recover_expired", {
        mutation: deriveMutation(input.mutation!, "task-recover-expired"),
        limit: input.task_recovery_limit,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      })
    );
    if ((readNumber(taskRecoveryResult.recovered_count) ?? 0) > 0 || (readNumber(taskRecoveryResult.failed_count) ?? 0) > 0) {
      actions.push("task.recover_expired");
    }
    taskSummary = storage.getTaskSummary({ running_limit: 12 });
  }
  const localProfile = captureLocalHostProfile({ workspace_root: process.cwd() });
  const providerBridgeProbeTimeoutMs = input.fast === true ? 1500 : 4000;
  const providerBridgeDiagnostics = resolveProviderBridgeDiagnostics({
    workspace_root: process.cwd(),
    bypass_cache: true,
    probe_timeout_ms: providerBridgeProbeTimeoutMs,
  });
  const providerBridgeEntries = Array.isArray(providerBridgeDiagnostics.diagnostics)
    ? providerBridgeDiagnostics.diagnostics
    : [];
  const providerBridgeHeartbeatEntries = providerBridgeEntries
    .map((entry): ProviderBridgeDiagnosticSnapshotRecord => ({
      client_id: String(entry.client_id ?? "").trim(),
      display_name: String(entry.display_name ?? "").trim(),
      office_agent_id: readString(entry.office_agent_id),
      available: readBoolean(entry.available) === true,
      runtime_probed: readBoolean(entry.runtime_probed) === true,
      connected:
        typeof entry.connected === "boolean"
          ? Boolean(entry.connected)
          : entry.connected === null || entry.connected === undefined
            ? null
            : null,
      status: (() => {
        const normalized = String(entry.status ?? "").trim().toLowerCase();
        if (
          normalized === "connected" ||
          normalized === "disconnected" ||
          normalized === "configured" ||
          normalized === "unavailable"
        ) {
          return normalized;
        }
        return "configured";
      })(),
      detail: String(entry.detail ?? "").trim(),
      notes: Array.isArray(entry.notes) ? entry.notes.map((value) => String(value ?? "")) : [],
      command: readString(entry.command),
      config_path: readString(entry.config_path),
      metadata: Object.keys(asRecord(entry.metadata)).length > 0 ? asRecord(entry.metadata) : undefined,
    }))
    .filter((entry) => entry.client_id.length > 0 && entry.display_name.length > 0);
  const recentRouterSuppression = buildRecentRouterSuppressionSummary(storage);
  actions.push("provider.bridge.heartbeat");
  try {
    const liteLlmProxyHealth = probeLiteLlmProxyHealth({
      timeout_ms: input.fast === true ? 1500 : 2500,
      endpoint_audit_timeout_ms: input.fast === true ? 1500 : 2500,
    });
    actions.push("litellm.proxy.health");
    if (liteLlmProxyHealth.healthy !== true) {
      attention.push(`litellm_proxy.down:${liteLlmProxyHealth.error ?? "proxy unreachable"}`);
    } else if (typeof liteLlmProxyHealth.unhealthy_count === "number" && liteLlmProxyHealth.unhealthy_count > 0) {
      const degradedModels = Object.entries(liteLlmProxyHealth.unhealthy_model_region_counts ?? {})
        .filter(([, count]) => typeof count === "number" && count > 0)
        .map(([model, count]) => `${model}:${count}`)
        .join(",");
      attention.push(
        `litellm_proxy.degraded_endpoints:${liteLlmProxyHealth.unhealthy_count}${degradedModels ? `:${degradedModels}` : ""}`
      );
    }
  } catch (error) {
    attention.push(`litellm_proxy.probe_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  const desktopControlState = storage.getDesktopControlState();
  let desktopControlHeartbeat: Record<string, unknown> | null = null;
  if (desktopControlState.enabled) {
    try {
      desktopControlHeartbeat = asRecord(
        await invokeTool("desktop.control", {
          action: "heartbeat",
          mutation: deriveMutation(input.mutation!, "desktop-control-heartbeat"),
          source_client: sourceClient,
          source_model: input.source_model,
          source_agent: sourceAgent,
        })
      );
      actions.push("desktop.control.heartbeat");
    } catch (error) {
      attention.push(`desktop.control.failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const desktopControlSnapshot = asRecord(asRecord(desktopControlHeartbeat).summary);
  const patientZeroSummary = summarizePatientZeroState(
    storage.getPatientZeroState(),
    Object.keys(desktopControlSnapshot).length > 0 ? desktopControlSnapshot : desktopControlState
  );
  for (const entry of providerBridgeEntries) {
    const clientId = String(entry.client_id ?? "").trim();
    const status = String(entry.status ?? "").trim().toLowerCase();
    if (!clientId || status !== "disconnected") {
      continue;
    }
    attention.push(`provider.bridge.${clientId}.disconnected`);
  }
  if (recentRouterSuppression.latest_attention) {
    attention.push(recentRouterSuppression.latest_attention);
  }
  let runtimeWorkerStatus = asRecord(await invokeTool("runtime.worker", { action: "status", limit: 20 }));
  let runtimeWorkerSpawnResult: Record<string, unknown> | null = null;
  if (input.start_runtime_workers !== false) {
    const runtimeSummary = asRecord(runtimeWorkerStatus.summary);
    const activeRuntimeWorkers = readNumber(runtimeSummary.active_count) ?? 0;
    const failedTasks = taskFailuresAreStale(taskSummary) ? 0 : taskSummary.counts.failed;
    const pendingTasks = countRuntimeEligibleTasks(storage, "pending");
    const runtimeEligibleFailedTasks = countRuntimeEligibleTasks(storage, "failed");
    const runtimeBudget = deriveLocalExecutionBudget(localProfile, {
      pending_tasks: pendingTasks,
      active_runtime_workers: activeRuntimeWorkers,
    });
    const runtimeWorkerMaxActive = Math.max(
      1,
      Math.min(8, Math.round(input.runtime_worker_max_active ?? runtimeBudget.runtime_worker_max_active))
    );
    const runtimeWorkerLimit = Math.max(
      1,
      Math.min(8, Math.round(input.runtime_worker_limit ?? runtimeBudget.runtime_worker_limit))
    );
    if (
      pendingTasks > 0 &&
      activeRuntimeWorkers < runtimeWorkerMaxActive
    ) {
      runtimeWorkerSpawnResult = asRecord(
        await invokeTool("runtime.worker", {
          action: "spawn_pending",
          mutation: deriveMutation(input.mutation!, "runtime-worker-spawn-pending"),
          limit: runtimeWorkerLimit,
          max_active_sessions: runtimeWorkerMaxActive,
        })
      );
      if ((readNumber(runtimeWorkerSpawnResult.created_count) ?? 0) > 0) {
        actions.push("runtime.worker.spawn_pending");
      }
      runtimeWorkerStatus = asRecord(await invokeTool("runtime.worker", { action: "status", limit: 20 }));
    }
    if (
      failedTasks > 0 &&
      runtimeEligibleFailedTasks > 0 &&
      (readNumber(asRecord(runtimeWorkerStatus.summary).active_count) ?? 0) <= 0
    ) {
      attention.push("runtime.worker.no_active_sessions");
    }
  }
  let taskAutoRetryStatus = asRecord(await invokeTool("task.auto_retry", { action: "status" }));
  if (input.start_task_auto_retry_daemon !== false && readBoolean(taskAutoRetryStatus.running) !== true) {
    taskAutoRetryStatus = asRecord(
      await invokeTool("task.auto_retry", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "task-auto-retry"),
        interval_seconds: input.task_auto_retry_interval_seconds,
        batch_limit: input.task_auto_retry_batch_limit,
        base_delay_seconds: input.task_auto_retry_base_delay_seconds,
        max_delay_seconds: input.task_auto_retry_max_delay_seconds,
        run_immediately: taskSummary.counts.failed > 0,
      })
    );
    actions.push("task.auto_retry.start");
  } else if (
    taskSummary.counts.failed > 0 &&
    readBoolean(taskAutoRetryStatus.running) === true &&
    isoAgeSeconds(readString(taskAutoRetryStatus.last_tick_at)) >
      Math.max(readNumber(asRecord(taskAutoRetryStatus.config).interval_seconds) ?? 60, 30)
  ) {
    taskAutoRetryStatus = asRecord(
      await invokeTool("task.auto_retry", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "task-auto-retry-run-once"),
        interval_seconds: input.task_auto_retry_interval_seconds,
        batch_limit: input.task_auto_retry_batch_limit,
        base_delay_seconds: input.task_auto_retry_base_delay_seconds,
        max_delay_seconds: input.task_auto_retry_max_delay_seconds,
      })
    );
    actions.push("task.auto_retry.run_once");
  }
  if (taskSummary.counts.failed > 0 && readBoolean(taskAutoRetryStatus.running) !== true) {
    attention.push("task.auto_retry.not_running");
  }

  let transcriptAutoSquishState = storage.getTranscriptAutoSquishState();
  let transcriptAutoSquishStatus = asRecord(await invokeTool("transcript.auto_squish", { action: "status" }));
  let transcriptAutoSquishStarted = false;
  if (input.start_transcript_auto_squish_daemon !== false && !transcriptAutoSquishState) {
    transcriptAutoSquishState = seedTranscriptAutoSquishState(storage, transcriptAutoSquishStatus);
    actions.push("transcript.auto_squish.seed");
  }
  let transcriptAutoSquishSummary = buildBackgroundSubsystemStatus({
    enabled: transcriptAutoSquishState?.enabled ?? false,
    interval_seconds: transcriptAutoSquishState?.interval_seconds ?? 60,
    runtime: transcriptAutoSquishStatus,
    backlog_count: storage.listTranscriptRunsWithPending(200).reduce((sum, run) => sum + Math.max(0, run.unsquished_count), 0),
    oldest_backlog_timestamp: storage.listTranscriptRunsWithPending(200)[0]?.oldest_timestamp ?? null,
  });
  if (input.start_transcript_auto_squish_daemon !== false && transcriptAutoSquishSummary.enabled && transcriptAutoSquishSummary.running !== true) {
    transcriptAutoSquishStatus = asRecord(
      await invokeTool("transcript.auto_squish", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "transcript-auto-squish-start"),
        interval_seconds: transcriptAutoSquishState?.interval_seconds,
        batch_runs: transcriptAutoSquishState?.batch_runs,
        per_run_limit: transcriptAutoSquishState?.per_run_limit,
        max_points: transcriptAutoSquishState?.max_points,
      })
    );
    transcriptAutoSquishStarted = true;
    actions.push("transcript.auto_squish.start");
  } else if (transcriptAutoSquishSummary.enabled && transcriptAutoSquishSummary.running === true && transcriptAutoSquishSummary.stale) {
    transcriptAutoSquishStatus = asRecord(
      await invokeTool("transcript.auto_squish", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "transcript-auto-squish-run-once"),
        interval_seconds: transcriptAutoSquishState?.interval_seconds,
        batch_runs: transcriptAutoSquishState?.batch_runs,
        per_run_limit: transcriptAutoSquishState?.per_run_limit,
        max_points: transcriptAutoSquishState?.max_points,
      })
    );
    actions.push("transcript.auto_squish.run_once");
  }
  transcriptAutoSquishSummary = buildBackgroundSubsystemStatus({
    enabled: transcriptAutoSquishState?.enabled ?? false,
    interval_seconds: transcriptAutoSquishState?.interval_seconds ?? 60,
    runtime: transcriptAutoSquishStatus,
    backlog_count: storage.listTranscriptRunsWithPending(200).reduce((sum, run) => sum + Math.max(0, run.unsquished_count), 0),
    oldest_backlog_timestamp: storage.listTranscriptRunsWithPending(200)[0]?.oldest_timestamp ?? null,
  });
  if (transcriptAutoSquishSummary.enabled && transcriptAutoSquishSummary.running !== true) {
    attention.push("transcript.auto_squish.not_running");
  } else if (transcriptAutoSquishSummary.stale && !transcriptAutoSquishStarted) {
    attention.push("transcript.auto_squish.stale");
  }
  if (transcriptAutoSquishSummary.last_error) {
    attention.push("transcript.auto_squish.error");
  }

  const imprintAutoSnapshotState = storage.getImprintAutoSnapshotState();
  let imprintAutoSnapshotStatus = asRecord(await invokeTool("imprint.auto_snapshot", { action: "status" }));
  let imprintAutoSnapshotStarted = false;
  let imprintAutoSnapshotSummary = buildBackgroundSubsystemStatus({
    enabled: imprintAutoSnapshotState?.enabled ?? false,
    interval_seconds: imprintAutoSnapshotState?.interval_seconds ?? 900,
    runtime: imprintAutoSnapshotStatus,
  });
  if (input.start_imprint_auto_snapshot_daemon !== false && imprintAutoSnapshotSummary.enabled && imprintAutoSnapshotSummary.running !== true) {
    imprintAutoSnapshotStatus = asRecord(
      await invokeTool("imprint.auto_snapshot", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "imprint-auto-snapshot-start"),
        profile_id: imprintAutoSnapshotState?.profile_id ?? undefined,
        interval_seconds: imprintAutoSnapshotState?.interval_seconds,
        include_recent_memories: imprintAutoSnapshotState?.include_recent_memories,
        include_recent_transcript_lines: imprintAutoSnapshotState?.include_recent_transcript_lines,
        write_file: imprintAutoSnapshotState?.write_file,
        promote_summary: imprintAutoSnapshotState?.promote_summary,
      })
    );
    imprintAutoSnapshotStarted = true;
    actions.push("imprint.auto_snapshot.start");
  } else if (imprintAutoSnapshotSummary.enabled && imprintAutoSnapshotSummary.running === true && imprintAutoSnapshotSummary.stale) {
    imprintAutoSnapshotStatus = asRecord(
      await invokeTool("imprint.auto_snapshot", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "imprint-auto-snapshot-run-once"),
        profile_id: imprintAutoSnapshotState?.profile_id ?? undefined,
        interval_seconds: imprintAutoSnapshotState?.interval_seconds,
        include_recent_memories: imprintAutoSnapshotState?.include_recent_memories,
        include_recent_transcript_lines: imprintAutoSnapshotState?.include_recent_transcript_lines,
        write_file: imprintAutoSnapshotState?.write_file,
        promote_summary: imprintAutoSnapshotState?.promote_summary,
      })
    );
    actions.push("imprint.auto_snapshot.run_once");
  }
  imprintAutoSnapshotSummary = buildBackgroundSubsystemStatus({
    enabled: imprintAutoSnapshotState?.enabled ?? false,
    interval_seconds: imprintAutoSnapshotState?.interval_seconds ?? 900,
    runtime: imprintAutoSnapshotStatus,
  });
  if (imprintAutoSnapshotSummary.enabled && imprintAutoSnapshotSummary.running !== true) {
    attention.push("imprint.auto_snapshot.not_running");
  } else if (imprintAutoSnapshotSummary.stale && !imprintAutoSnapshotStarted) {
    attention.push("imprint.auto_snapshot.stale");
  }
  if (imprintAutoSnapshotSummary.last_error) {
    attention.push("imprint.auto_snapshot.error");
  }

  let trichatAutoRetentionState = storage.getTriChatAutoRetentionState();
  let trichatAutoRetentionStatus = asRecord(await invokeTool("trichat.auto_retention", { action: "status" }));
  let trichatAutoRetentionStarted = false;
  if (input.start_trichat_auto_retention_daemon !== false && !trichatAutoRetentionState) {
    trichatAutoRetentionState = seedTriChatAutoRetentionState(storage, trichatAutoRetentionStatus);
    actions.push("trichat.auto_retention.seed");
  }
  let trichatAutoRetentionSummary = buildBackgroundSubsystemStatus({
    enabled: trichatAutoRetentionState?.enabled ?? false,
    interval_seconds: trichatAutoRetentionState?.interval_seconds ?? 600,
    runtime: trichatAutoRetentionStatus,
  });
  if (
    input.start_trichat_auto_retention_daemon !== false &&
    trichatAutoRetentionSummary.enabled &&
    trichatAutoRetentionSummary.running !== true
  ) {
    trichatAutoRetentionStatus = asRecord(
      await invokeTool("trichat.auto_retention", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "trichat-auto-retention-start"),
        interval_seconds: trichatAutoRetentionState?.interval_seconds,
        older_than_days: trichatAutoRetentionState?.older_than_days,
        limit: trichatAutoRetentionState?.limit,
      })
    );
    trichatAutoRetentionStarted = true;
    actions.push("trichat.auto_retention.start");
  } else if (
    trichatAutoRetentionSummary.enabled &&
    trichatAutoRetentionSummary.running === true &&
    trichatAutoRetentionSummary.stale
  ) {
    trichatAutoRetentionStatus = asRecord(
      await invokeTool("trichat.auto_retention", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "trichat-auto-retention-run-once"),
        interval_seconds: trichatAutoRetentionState?.interval_seconds,
        older_than_days: trichatAutoRetentionState?.older_than_days,
        limit: trichatAutoRetentionState?.limit,
      })
    );
    actions.push("trichat.auto_retention.run_once");
  }
  trichatAutoRetentionSummary = buildBackgroundSubsystemStatus({
    enabled: trichatAutoRetentionState?.enabled ?? false,
    interval_seconds: trichatAutoRetentionState?.interval_seconds ?? 600,
    runtime: trichatAutoRetentionStatus,
  });
  if (trichatAutoRetentionSummary.enabled && trichatAutoRetentionSummary.running !== true) {
    attention.push("trichat.auto_retention.not_running");
  } else if (trichatAutoRetentionSummary.stale && !trichatAutoRetentionStarted) {
    attention.push("trichat.auto_retention.stale");
  }
  if (trichatAutoRetentionSummary.last_error) {
    attention.push("trichat.auto_retention.error");
  }

  let trichatTurnWatchdogState = storage.getTriChatTurnWatchdogState();
  let trichatTurnWatchdogStatus = asRecord(await invokeTool("trichat.turn_watchdog", { action: "status" }));
  let trichatTurnWatchdogStarted = false;
  if (input.start_trichat_turn_watchdog_daemon !== false && !trichatTurnWatchdogState) {
    trichatTurnWatchdogState = seedTriChatTurnWatchdogState(storage, trichatTurnWatchdogStatus);
    actions.push("trichat.turn_watchdog.seed");
  }
  let trichatTurnWatchdogSummary = buildBackgroundSubsystemStatus({
    enabled: trichatTurnWatchdogState?.enabled ?? false,
    interval_seconds: trichatTurnWatchdogState?.interval_seconds ?? 30,
    runtime: trichatTurnWatchdogStatus,
    backlog_count: storage.listStaleRunningTriChatTurns({
      stale_before_iso: new Date(Date.now() - (trichatTurnWatchdogState?.stale_after_seconds ?? 180) * 1000).toISOString(),
      limit: trichatTurnWatchdogState?.batch_limit ?? 200,
    }).length,
    oldest_backlog_timestamp:
      storage.listStaleRunningTriChatTurns({
        stale_before_iso: new Date(Date.now() - (trichatTurnWatchdogState?.stale_after_seconds ?? 180) * 1000).toISOString(),
        limit: trichatTurnWatchdogState?.batch_limit ?? 200,
      })[0]?.updated_at ?? null,
  });
  if (
    input.start_trichat_turn_watchdog_daemon !== false &&
    trichatTurnWatchdogSummary.enabled &&
    trichatTurnWatchdogSummary.running !== true
  ) {
    trichatTurnWatchdogStatus = asRecord(
      await invokeTool("trichat.turn_watchdog", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "trichat-turn-watchdog-start"),
        interval_seconds: trichatTurnWatchdogState?.interval_seconds,
        stale_after_seconds: trichatTurnWatchdogState?.stale_after_seconds,
        batch_limit: trichatTurnWatchdogState?.batch_limit,
      })
    );
    trichatTurnWatchdogStarted = true;
    actions.push("trichat.turn_watchdog.start");
  } else if (
    trichatTurnWatchdogSummary.enabled &&
    trichatTurnWatchdogSummary.running === true &&
    trichatTurnWatchdogSummary.stale
  ) {
    trichatTurnWatchdogStatus = asRecord(
      await invokeTool("trichat.turn_watchdog", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "trichat-turn-watchdog-run-once"),
        interval_seconds: trichatTurnWatchdogState?.interval_seconds,
        stale_after_seconds: trichatTurnWatchdogState?.stale_after_seconds,
        batch_limit: trichatTurnWatchdogState?.batch_limit,
      })
    );
    actions.push("trichat.turn_watchdog.run_once");
  }
  trichatTurnWatchdogSummary = buildBackgroundSubsystemStatus({
    enabled: trichatTurnWatchdogState?.enabled ?? false,
    interval_seconds: trichatTurnWatchdogState?.interval_seconds ?? 30,
    runtime: trichatTurnWatchdogStatus,
    backlog_count: storage.listStaleRunningTriChatTurns({
      stale_before_iso: new Date(Date.now() - (trichatTurnWatchdogState?.stale_after_seconds ?? 180) * 1000).toISOString(),
      limit: trichatTurnWatchdogState?.batch_limit ?? 200,
    }).length,
    oldest_backlog_timestamp:
      storage.listStaleRunningTriChatTurns({
        stale_before_iso: new Date(Date.now() - (trichatTurnWatchdogState?.stale_after_seconds ?? 180) * 1000).toISOString(),
        limit: trichatTurnWatchdogState?.batch_limit ?? 200,
      })[0]?.updated_at ?? null,
  });
  if (trichatTurnWatchdogSummary.enabled && trichatTurnWatchdogSummary.running !== true) {
    attention.push("trichat.turn_watchdog.not_running");
  } else if (trichatTurnWatchdogSummary.stale && !trichatTurnWatchdogStarted) {
    attention.push("trichat.turn_watchdog.stale");
  }
  if (trichatTurnWatchdogSummary.last_error) {
    attention.push("trichat.turn_watchdog.error");
  }

  let reactionEngineStatus = asRecord(await invokeTool("reaction.engine", { action: "status" }));
  if (input.start_reaction_engine_daemon !== false && readBoolean(asRecord(reactionEngineStatus.runtime).running) !== true) {
    reactionEngineStatus = asRecord(
      await invokeTool("reaction.engine", {
        action: "start",
        mutation: deriveMutation(input.mutation!, "reaction-engine"),
        interval_seconds: input.reaction_engine_interval_seconds,
        dedupe_window_seconds: input.reaction_engine_dedupe_window_seconds,
        channels: input.reaction_engine_channels,
        webhook_url: input.reaction_engine_webhook_url,
        run_immediately: true,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      })
    );
    actions.push("reaction.engine.start");
  } else if (
    readBoolean(asRecord(reactionEngineStatus.state).enabled) === true &&
    readBoolean(asRecord(reactionEngineStatus.runtime).running) === true &&
    isoAgeSeconds(readString(asRecord(reactionEngineStatus.runtime).last_tick_at)) >
      Math.max(readNumber(asRecord(reactionEngineStatus.state).interval_seconds) ?? 120, 60)
  ) {
    reactionEngineStatus = asRecord(
      await invokeTool("reaction.engine", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "reaction-engine-run-once"),
        interval_seconds: input.reaction_engine_interval_seconds,
        dedupe_window_seconds: input.reaction_engine_dedupe_window_seconds,
        channels: input.reaction_engine_channels,
        webhook_url: input.reaction_engine_webhook_url,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      })
    );
    actions.push("reaction.engine.run_once");
  }
  if (readBoolean(asRecord(reactionEngineStatus.state).enabled) !== true) {
    attention.push("reaction.engine.not_enabled");
  } else if (readBoolean(asRecord(reactionEngineStatus.runtime).running) !== true) {
    attention.push("reaction.engine.not_running");
  }

  let tmuxMaintainResult: Record<string, unknown> | null = null;
  const tmuxStatus = asRecord(await invokeTool("trichat.tmux_controller", { action: "status" }));
  const tmuxQueueDepth = readNumber(asRecord(tmuxStatus.dashboard).queue_depth) ?? 0;
  const tmuxTaskTelemetry = readTmuxTaskTelemetry(storage);
  const workerFabricStatus = asRecord(bootstrapStatus.worker_fabric);
  const workerTelemetry = asRecord(workerFabricStatus.effective_local_telemetry ?? workerFabricStatus.telemetry);
  const fabricQueueDepth = readNumber(workerTelemetry.queue_depth) ?? 0;
  const runtimeWorkerActiveCount = readNumber(asRecord(runtimeWorkerStatus.summary).active_count) ?? 0;
  const localExecutionBudget = deriveLocalExecutionBudget(localProfile, {
    pending_tasks: taskSummary.counts.pending,
    tmux_queue_depth: Math.max(tmuxQueueDepth, tmuxTaskTelemetry.queue_depth),
    fabric_queue_depth: fabricQueueDepth,
    active_runtime_workers: runtimeWorkerActiveCount,
  });
  if (input.maintain_tmux_controller !== false && readBoolean(asRecord(tmuxStatus.state).enabled) === true) {
    try {
      tmuxMaintainResult = asRecord(
        await invokeTool("trichat.tmux_controller", {
          action: "maintain",
          mutation: deriveMutation(input.mutation!, "tmux-maintain"),
          worker_count: localExecutionBudget.tmux_recommended_worker_count,
          auto_scale_workers: true,
          min_worker_count: localExecutionBudget.tmux_min_worker_count,
          max_worker_count: Math.max(1, Math.min(12, localProfile.safe_worker_count)),
          max_queue_per_worker: localProfile.safe_max_queue_per_worker,
          target_queue_per_worker: localExecutionBudget.tmux_target_queue_per_worker,
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

  const effectiveActiveTasks = Math.max(
    tmuxTaskTelemetry.active_tasks,
    readNumber(asRecord(tmuxStatus.dashboard).active_running) ?? 0
  );

  const persistedFabric = storage.getWorkerFabricState();
  const existingLocalHost =
    persistedFabric?.hosts.find((entry) => String(entry.host_id || "") === input.local_host_id) ?? null;
  if (existingLocalHost) {
    const mergedTags = [
      ...new Set([
        ...normalizeStringArray(existingLocalHost.tags),
        "local",
        localProfile.platform,
        localProfile.arch,
        localProfile.arch === "arm64" ? "apple-silicon" : "x86",
        ...(localProfile.full_gpu_access
          ? ["gpu", ...(localProfile.gpu_api ? [localProfile.gpu_api] : []), ...(localProfile.unified_memory ? ["unified-memory"] : [])]
          : []),
        ...(localProfile.mlx_available ? ["mlx"] : []),
      ]),
    ];
    await invokeTool("worker.fabric", {
      action: "upsert_host",
      mutation: deriveMutation(input.mutation!, "worker-fabric-local-refresh"),
      host: {
        host_id: existingLocalHost.host_id,
        enabled: existingLocalHost.enabled !== false,
        transport: existingLocalHost.transport,
        ssh_destination: existingLocalHost.ssh_destination ?? undefined,
        workspace_root: existingLocalHost.workspace_root,
        worker_count: localProfile.safe_worker_count,
        shell: existingLocalHost.shell || "/bin/zsh",
        capabilities: {
          ...(asRecord(existingLocalHost.capabilities)),
          performance_cpu_count: localProfile.performance_cpu_count,
          efficiency_cpu_count: localProfile.efficiency_cpu_count,
          unified_memory_gb: localProfile.memory_total_gb,
          accelerator_kind: localProfile.accelerator_kind,
          gpu_vendor: localProfile.gpu_vendor,
          gpu_model: localProfile.gpu_model,
          gpu_api: localProfile.gpu_api,
          gpu_family: localProfile.gpu_family,
          gpu_core_count: localProfile.gpu_core_count,
          gpu_memory_total_gb: localProfile.gpu_memory_total_gb,
          gpu_memory_available_gb: localProfile.gpu_memory_available_gb,
          mlx_python: localProfile.mlx_python,
          mlx_available: localProfile.mlx_available,
          mlx_lm_available: localProfile.mlx_lm_available,
          safe_worker_count: localProfile.safe_worker_count,
          safe_max_queue_per_worker: localProfile.safe_max_queue_per_worker,
          max_local_model_concurrency: localProfile.max_local_model_concurrency,
          recommended_runtime_worker_max_active: localExecutionBudget.runtime_worker_max_active,
          recommended_runtime_worker_limit: localExecutionBudget.runtime_worker_limit,
          recommended_tmux_worker_count: localExecutionBudget.tmux_recommended_worker_count,
          recommended_tmux_target_queue_per_worker: localExecutionBudget.tmux_target_queue_per_worker,
          memory_free_percent: localProfile.memory_free_percent,
          full_gpu_access: localProfile.full_gpu_access,
        },
        tags: mergedTags,
        telemetry: {
          heartbeat_at: localProfile.generated_at,
          health_state: localProfile.health_state,
          queue_depth: Math.max(fabricQueueDepth, tmuxQueueDepth, tmuxTaskTelemetry.queue_depth),
          active_tasks: effectiveActiveTasks,
          latency_ms: readNumber(workerTelemetry.latency_ms) ?? undefined,
          cpu_utilization: localProfile.cpu_utilization,
          ram_available_gb: localProfile.memory_available_gb,
          ram_total_gb: localProfile.memory_total_gb,
          swap_used_gb: localProfile.swap_used_gb,
          gpu_utilization: localProfile.gpu_utilization ?? undefined,
          gpu_memory_available_gb: localProfile.gpu_memory_available_gb ?? undefined,
          gpu_memory_total_gb: localProfile.gpu_memory_total_gb ?? undefined,
          disk_free_gb: localProfile.disk_free_gb ?? undefined,
          thermal_pressure: localProfile.thermal_pressure,
        },
        metadata: {
          ...(asRecord(existingLocalHost.metadata)),
          local_execution_profile: {
            generated_at: localProfile.generated_at,
            safe_worker_count: localProfile.safe_worker_count,
            safe_max_queue_per_worker: localProfile.safe_max_queue_per_worker,
            max_local_model_concurrency: localProfile.max_local_model_concurrency,
            runtime_worker_max_active: localExecutionBudget.runtime_worker_max_active,
            runtime_worker_limit: localExecutionBudget.runtime_worker_limit,
            tmux_recommended_worker_count: localExecutionBudget.tmux_recommended_worker_count,
            tmux_target_queue_per_worker: localExecutionBudget.tmux_target_queue_per_worker,
            memory_free_percent: localProfile.memory_free_percent,
            swap_used_gb: localProfile.swap_used_gb,
            accelerator_kind: localProfile.accelerator_kind,
            gpu_model: localProfile.gpu_model,
            gpu_api: localProfile.gpu_api,
            gpu_core_count: localProfile.gpu_core_count,
            mlx_python: localProfile.mlx_python,
            mlx_available: localProfile.mlx_available,
            mlx_lm_available: localProfile.mlx_lm_available,
          },
        },
      },
      source_client: sourceClient,
      source_model: input.source_model,
      source_agent: sourceAgent,
    });
    actions.push("worker.fabric.local_refresh");
  }

  const persistedRouter = storage.getModelRouterState();
  const localBackends = (persistedRouter?.backends ?? []).filter(
    (entry) =>
      entry.enabled !== false &&
      (String(entry.host_id || "") === input.local_host_id || String(entry.locality || "") === "local")
  );
  for (const backend of localBackends) {
    const backendCapabilities = asRecord(backend.capabilities);
    const priorProbeAgeSeconds = isoAgeSeconds(readString(backendCapabilities.probe_generated_at));
    const probeBenchmarkDue =
      backend.provider === "ollama" &&
      (backend.latency_ms_p50 === null ||
        backend.throughput_tps === null ||
        priorProbeAgeSeconds > Math.max(input.interval_seconds * 4, 900));
    let measuredLatencyMs = backend.latency_ms_p50 ?? null;
    let measuredThroughputTps = backend.throughput_tps ?? null;
    let measuredSuccessRate = backend.success_rate ?? null;
    let probeCapabilities: Record<string, unknown> = {};
    let probeMetadata: Record<string, unknown> = {};
    let backendTags = [...normalizeStringArray(backend.tags)];
    let recommendedParallelRequests = localProfile.max_local_model_concurrency;
    if (backend.provider === "ollama" && readString(backend.endpoint)) {
      let probe = await probeLocalOllamaBackend({
        endpoint: backend.endpoint!,
        model_id: backend.model_id,
        benchmark: probeBenchmarkDue,
      });
      const retainedSwapHeadroom = hasRetainedSwapHeadroom(localProfile);
      const activeSwapPressure = localProfile.swap_used_gb >= 4 && !retainedSwapHeadroom;
      const shouldUnload =
        probe.model_loaded === true &&
        (localProfile.thermal_pressure === "serious" ||
          localProfile.thermal_pressure === "critical" ||
          localProfile.memory_free_percent < 18 ||
          activeSwapPressure);
      const shouldPrewarm =
        probe.model_loaded !== true &&
        probe.service_ok &&
        probe.model_known &&
        localProfile.health_state === "healthy" &&
        localProfile.thermal_pressure !== "serious" &&
        localProfile.thermal_pressure !== "critical" &&
        localProfile.memory_free_percent >= 18 &&
        (localProfile.swap_used_gb < 2 || retainedSwapHeadroom) &&
        (tmuxQueueDepth > 0 || effectiveActiveTasks > 0 || fabricQueueDepth > 0);
      if (shouldUnload || shouldPrewarm) {
        const residencyAction = await setLocalOllamaModelResidency({
          endpoint: backend.endpoint!,
          model_id: backend.model_id,
          action: shouldUnload ? "unload" : "prewarm",
          keep_alive: shouldUnload ? 0 : "10m",
        });
        actions.push(`model.router.${shouldUnload ? "unload" : "prewarm"}:${backend.backend_id}`);
        probeMetadata = {
          ...probeMetadata,
          last_residency_action: residencyAction,
        };
        if (residencyAction.ok) {
          probe = await probeLocalOllamaBackend({
            endpoint: backend.endpoint!,
            model_id: backend.model_id,
            benchmark: probeBenchmarkDue,
          });
        } else if (residencyAction.error) {
          attention.push(`model.router.${backend.backend_id}.${shouldUnload ? "unload" : "prewarm"}_failed`);
        }
      }
      if (probe.model_loaded !== true) {
        recommendedParallelRequests = Math.max(1, recommendedParallelRequests - 1);
      }
      if (
        probe.resident_model_count >= 2 ||
        (probe.resident_vram_gb !== null && probe.resident_vram_gb >= Math.max(6, localProfile.memory_available_gb * 0.3)) ||
        localProfile.memory_free_percent < 25
      ) {
        recommendedParallelRequests = 1;
      }
      const serviceLatencyMs =
        probe.version_latency_ms !== null && probe.tags_latency_ms !== null && probe.ps_latency_ms !== null
          ? Number(((probe.version_latency_ms + probe.tags_latency_ms + probe.ps_latency_ms) / 3).toFixed(4))
          : probe.ps_latency_ms ?? probe.tags_latency_ms ?? probe.version_latency_ms;
      measuredLatencyMs = smoothMetric(
        backend.latency_ms_p50,
        probe.benchmark_latency_ms ?? probe.benchmark_total_duration_ms ?? serviceLatencyMs,
        probe.benchmark_ok ? 0.4 : 0.2
      );
      measuredThroughputTps = smoothMetric(backend.throughput_tps, probe.throughput_tps, 0.5);
      measuredSuccessRate = smoothRate(
        backend.success_rate,
        probe.service_ok && (!probe.benchmark_attempted || probe.benchmark_ok),
        probe.benchmark_attempted ? 0.18 : 0.08
      );
      probeCapabilities = {
        probe_healthy: probe.service_ok && probe.model_known && (!probe.benchmark_attempted || probe.benchmark_ok),
        probe_generated_at: probe.generated_at,
        probe_version: probe.version,
        probe_tags_ok: probe.tags_ok,
        probe_ps_ok: probe.ps_ok,
        probe_model_known: probe.model_known,
        probe_model_loaded: probe.model_loaded,
        probe_known_model_count: probe.known_models.length,
        probe_resident_model_count: probe.resident_model_count,
        probe_resident_vram_gb: probe.resident_vram_gb,
        probe_resident_context_length: probe.resident_context_length,
        probe_resident_expires_at: probe.resident_expires_at,
        probe_processor_summary: probe.processor_summary,
        probe_gpu_offload_ratio: probe.gpu_offload_ratio,
        probe_service_latency_ms: serviceLatencyMs,
        probe_benchmark_attempted: probe.benchmark_attempted,
        probe_benchmark_ok: probe.benchmark_ok,
        probe_benchmark_latency_ms: probe.benchmark_latency_ms,
        probe_throughput_tps: probe.throughput_tps,
        probe_error: probe.error,
        recommended_parallel_requests: recommendedParallelRequests,
      };
      probeMetadata = {
        ...probeMetadata,
        last_probe: probe,
      };
      backendTags = [
        ...new Set([
          ...backendTags,
          probe.service_ok ? "probe-healthy" : "probe-down",
          probe.model_known ? "model-known" : "model-missing",
          probe.benchmark_ok ? "benchmarked" : probe.benchmark_attempted ? "benchmark-failed" : "benchmark-pending",
          ...(probe.gpu_offload_ratio === null ? [] : probe.gpu_offload_ratio > 0.95 ? ["gpu-offloaded"] : probe.gpu_offload_ratio > 0 ? ["hybrid-cpu-gpu"] : ["cpu-only"]),
        ]),
      ];
      if (!probe.service_ok) {
        attention.push(`model.router.${backend.backend_id}.probe_failed`);
      } else if (!probe.model_known) {
        attention.push(`model.router.${backend.backend_id}.model_missing`);
      }
    } else if (backend.provider === "mlx") {
      const backendIsPrimary =
        backend.backend_id === persistedRouter?.default_backend_id ||
        backendTags.includes("primary") ||
        backendTags.includes("required");
      const backendIsOptional = !backendIsPrimary && process.env.TRICHAT_MLX_SERVER_ENABLED !== "1";
      recommendedParallelRequests = Math.max(1, localProfile.max_local_model_concurrency);
      let mlxProbe = null;
      if (readString(backend.endpoint)) {
        mlxProbe = await probeLocalMlxBackend({
          endpoint: backend.endpoint!,
          model_id: backend.model_id,
          benchmark: true,
        });
        if (mlxProbe.benchmark_ok) {
          measuredLatencyMs = mlxProbe.benchmark_latency_ms ?? measuredLatencyMs;
          measuredThroughputTps = mlxProbe.throughput_tps ?? measuredThroughputTps;
        }
      }
      const mlxProbeHealthy = mlxProbe
        ? Boolean(mlxProbe.service_ok && mlxProbe.model_known && mlxProbe.benchmark_ok)
        : localProfile.mlx_available && localProfile.mlx_lm_available;
      const mlxModelKnown = mlxProbe ? mlxProbe.model_known : localProfile.mlx_available;
      const mlxModelLoaded = mlxProbe ? mlxProbe.benchmark_ok : false;
      measuredSuccessRate = smoothRate(
        backend.success_rate,
        mlxProbe ? mlxProbeHealthy : localProfile.mlx_available && localProfile.mlx_lm_available,
        0.15
      );
      probeCapabilities = {
        probe_healthy: mlxProbeHealthy,
        probe_generated_at: localProfile.generated_at,
        probe_model_known: mlxModelKnown,
        probe_model_loaded: mlxModelLoaded,
        probe_benchmark_attempted: mlxProbe?.benchmark_attempted ?? false,
        probe_benchmark_ok: mlxProbe?.benchmark_ok ?? false,
        probe_benchmark_latency_ms: mlxProbe?.benchmark_latency_ms ?? null,
        probe_throughput_tps: mlxProbe?.throughput_tps ?? null,
        recommended_parallel_requests: recommendedParallelRequests,
        mlx_python: localProfile.mlx_python,
        mlx_available: localProfile.mlx_available,
        mlx_lm_available: localProfile.mlx_lm_available,
        fine_tuning_supported: localProfile.mlx_lm_available,
        accelerator_kind: localProfile.accelerator_kind,
        gpu_model: localProfile.gpu_model,
        gpu_api: localProfile.gpu_api,
        gpu_core_count: localProfile.gpu_core_count,
        probe_error:
          mlxProbe?.error ??
          (localProfile.mlx_available ? null : "mlx_python_or_package_missing"),
      };
      probeMetadata = {
        ...probeMetadata,
        last_probe: {
          provider: "mlx",
          generated_at: localProfile.generated_at,
          endpoint: backend.endpoint ?? null,
          mlx_python: localProfile.mlx_python,
          mlx_available: localProfile.mlx_available,
          mlx_lm_available: localProfile.mlx_lm_available,
          gpu_model: localProfile.gpu_model,
          gpu_api: localProfile.gpu_api,
          service_ok: mlxProbe?.service_ok ?? null,
          model_known: mlxProbe?.model_known ?? null,
          benchmark_ok: mlxProbe?.benchmark_ok ?? null,
          benchmark_latency_ms: mlxProbe?.benchmark_latency_ms ?? null,
          throughput_tps: mlxProbe?.throughput_tps ?? null,
        },
      };
      backendTags = [
        ...new Set([
          ...backendTags,
          ...(backendIsOptional ? ["optional"] : []),
          "gpu",
          ...(localProfile.gpu_api ? [localProfile.gpu_api] : []),
          ...(localProfile.accelerator_kind === "apple-metal" ? ["apple-silicon", "unified-memory"] : []),
          ...(localProfile.mlx_lm_available ? ["fine-tuning"] : []),
          ...(mlxProbe?.benchmark_ok ? ["benchmarked"] : []),
          mlxProbeHealthy ? "probe-healthy" : "probe-down",
        ]),
      ];
      if (mlxProbe && !mlxModelKnown) {
        if (backendIsOptional) {
          actions.push(`model.router.optional_model_missing:${backend.backend_id}`);
        } else {
          attention.push(`model.router.${backend.backend_id}.model_missing`);
        }
      } else if (!mlxProbeHealthy) {
        if (backendIsOptional) {
          actions.push(`model.router.optional_probe_degraded:${backend.backend_id}`);
        } else {
          attention.push(`model.router.${backend.backend_id}.probe_failed`);
        }
      }
    }
    await invokeTool("model.router", {
      action: "heartbeat",
      mutation: deriveMutation(input.mutation!, `model-router-local-refresh:${backend.backend_id}`),
      backend_id: backend.backend_id,
      backend: {
        backend_id: backend.backend_id,
        model_id: backend.model_id,
        endpoint: backend.endpoint ?? undefined,
        host_id: backend.host_id ?? input.local_host_id,
        locality: backend.locality,
        context_window: backend.context_window,
        throughput_tps: measuredThroughputTps ?? undefined,
        latency_ms_p50: measuredLatencyMs ?? undefined,
        success_rate: measuredSuccessRate ?? undefined,
        win_rate: backend.win_rate ?? undefined,
        cost_per_1k_input: backend.cost_per_1k_input ?? undefined,
        max_output_tokens: backend.max_output_tokens ?? undefined,
        metadata: probeMetadata,
      },
      tags: [...new Set([...backendTags, ...(localProfile.full_gpu_access ? ["gpu", "apple-silicon", "unified-memory"] : [])])],
      capabilities: {
        recommended_parallel_requests: recommendedParallelRequests,
        unified_memory_gb: localProfile.memory_total_gb,
        memory_free_percent: localProfile.memory_free_percent,
        swap_used_gb: localProfile.swap_used_gb,
        full_gpu_access: localProfile.full_gpu_access,
        accelerator_kind: localProfile.accelerator_kind,
        gpu_model: localProfile.gpu_model,
        gpu_api: localProfile.gpu_api,
        gpu_core_count: localProfile.gpu_core_count,
        gpu_memory_total_gb: localProfile.gpu_memory_total_gb,
        gpu_memory_available_gb: localProfile.gpu_memory_available_gb,
        mlx_python: localProfile.mlx_python,
        mlx_available: localProfile.mlx_available,
        mlx_lm_available: localProfile.mlx_lm_available,
        ...probeCapabilities,
      },
      source_client: sourceClient,
      source_model: input.source_model,
      source_agent: sourceAgent,
    });
    actions.push(`model.router.local_refresh:${backend.backend_id}`);
  }

  if (localProfile.health_state !== "healthy") {
    attention.push(`local.runtime.${localProfile.health_state}`);
  }
  if (localProfile.thermal_pressure === "serious" || localProfile.thermal_pressure === "critical") {
    attention.push(`local.thermal.${localProfile.thermal_pressure}`);
  }
  if (localProfile.memory_free_percent < 20) {
    attention.push("local.memory.low_free_percent");
  }

  const currentEvalDependencyFingerprint = computeEvalDependencyFingerprint(storage, input.eval_suite_id);
  const evalHealthBeforeRun = buildEvalHealth(previousState, {
    ...input,
    current_dependency_fingerprint: currentEvalDependencyFingerprint,
  });
  const evalNeedsRefresh = input.run_eval_if_due !== false && evalHealthBeforeRun.due;
  if (evalHealthBeforeRun.below_threshold) {
    attention.push(`eval.${input.eval_suite_id}.below_threshold`);
  }
  const safeForEval = runtimeWorkerActiveCount <= 0 && isLocalHostSafeForAutonomyEval(localProfile);
  const safeForOptimizer =
    runtimeWorkerActiveCount <= 0 &&
    localProfile.health_state === "healthy" &&
    localProfile.thermal_pressure !== "serious" &&
    localProfile.thermal_pressure !== "critical" &&
    localProfile.memory_free_percent >= 15;

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
  const coldStartEvalDefer =
    sourceClient === "server.startup" &&
    input.action !== "run_once" &&
    !readString(previousState?.last_run_at) &&
    !readString(previousState?.last_eval_run_at);
  const shouldRunEval =
    readBoolean(bootstrapStatus.self_start_ready) === true &&
    evalNeedsRefresh &&
    safeForEval &&
    !coldStartEvalDefer;
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
  } else if (evalNeedsRefresh && coldStartEvalDefer) {
    actions.push("eval.deferred_cold_start");
  } else if (evalNeedsRefresh && !safeForEval) {
    actions.push("eval.deferred_busy");
  }

  let optimizerResult: Record<string, unknown> | null = null;
  const optimizerPlan = deriveOptimizerPlan(storage, input.optimizer_interval_seconds);
  const startupPass = input.action === "start" && input.run_immediately === true;
  const shouldRunOptimizer =
    input.run_optimizer_if_due !== false &&
    readBoolean(bootstrapStatus.self_start_ready) === true &&
    optimizerPlan.enabled === true &&
    optimizerPlan.due === true &&
    optimizerPlan.selected_role_id &&
    optimizerPlan.focus_areas.length > 0 &&
    optimizerPlan.objectives.length > 0 &&
    safeForOptimizer &&
    startupPass !== true;
  if (shouldRunOptimizer) {
    try {
      optimizerResult = asRecord(
        await invokeTool("optimizer", {
          action: "step",
          mutation: deriveMutation(input.mutation!, `optimizer-step:${optimizerPlan.selected_role_id}`),
          role_id: optimizerPlan.selected_role_id,
          focus_areas: optimizerPlan.focus_areas,
          objectives: optimizerPlan.objectives,
          promote_if_better: true,
          min_improvement: input.optimizer_min_improvement,
          metadata: {
            source: "autonomy.maintain",
            role_lane: optimizerPlan.selected_lane,
          },
          source_client: sourceClient,
          source_model: input.source_model,
          source_agent: sourceAgent,
        })
      );
      actions.push(`optimizer.step:${optimizerPlan.selected_role_id}`);
    } catch (error) {
      attention.push(
        `optimizer.${optimizerPlan.selected_role_id}.failed:${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else if (input.run_optimizer_if_due !== false && startupPass) {
    actions.push("optimizer.deferred_startup");
  } else if (input.run_optimizer_if_due !== false && !safeForOptimizer) {
    actions.push("optimizer.deferred_busy");
  }

  const shouldShipObservability = input.action !== "run_once";
  const observabilitySince =
    previousState?.last_observability_ship_at?.trim() ||
    new Date(Date.now() - Math.max(input.interval_seconds * 3, 300) * 1000).toISOString();
  let lastObservabilityShipAt = previousState?.last_observability_ship_at ?? null;
  if (shouldShipObservability) {
    try {
      const shippedSources = await shipControlPlaneObservability(storage, invokeTool, {
        mutation: input.mutation!,
        since: observabilitySince,
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      });
      actions.push(...shippedSources.map((entry) => `observability.ship:${entry}`));
      lastObservabilityShipAt = now;
    } catch (error) {
      attention.push(`observability.ship.failed:${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    actions.push("observability.ship.deferred_run_once");
  }

  try {
    const backupPrune = storage.pruneStorageBackups();
    if ((backupPrune.deleted_count ?? 0) > 0) {
      actions.push(`storage.backups.prune:${backupPrune.deleted_count}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/backup lock already held/i.test(message)) {
      attention.push(`storage.backups.failed:${message}`);
    }
  }

  let selfDriveResult: Record<string, unknown> | null = null;
  let lastSelfDriveAt = previousState?.last_self_drive_at ?? null;
  let lastSelfDriveGoalId = previousState?.last_self_drive_goal_id ?? null;
  let lastSelfDriveFingerprint = previousState?.last_self_drive_fingerprint ?? null;
  const activeGoals = storage.listGoals({ status: "active", limit: 10 });
  const idleForSelfDrive =
    activeGoals.length <= 0 &&
    taskSummary.counts.pending <= 0 &&
    taskSummary.counts.running <= 0 &&
    runtimeWorkerActiveCount <= 0 &&
    readBoolean(bootstrapStatus.self_start_ready) === true;
  const selfDriveCandidate =
    input.enable_self_drive !== false && idleForSelfDrive
      ? buildSelfDriveCandidate({
          attention,
          providerBridgeEntries,
          patientZeroSummary,
        })
      : null;
  if (selfDriveCandidate) {
    const fingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          reason: selfDriveCandidate.reason,
          attention: selfDriveCandidate.metadata.attention ?? [],
        })
      )
      .digest("hex");
    const cooldownAgeSeconds = isoAgeSeconds(previousState?.last_self_drive_at ?? null);
    const cooldownSatisfied =
      cooldownAgeSeconds === Number.POSITIVE_INFINITY ||
      cooldownAgeSeconds >= Math.max(60, input.self_drive_cooldown_seconds ?? 1800);
    if (fingerprint !== previousState?.last_self_drive_fingerprint || cooldownSatisfied) {
      try {
        selfDriveResult = asRecord(
          await invokeTool("autonomy.command", {
            mutation: deriveMutation(input.mutation!, `self-drive:${selfDriveCandidate.reason}`),
            objective: selfDriveCandidate.objective,
            title: selfDriveCandidate.title,
            priority: 70,
            risk_tier: "low",
            autonomy_mode: "execute_bounded",
            ensure_bootstrap: false,
            start_goal_autorun_daemon: false,
            dispatch_limit: 6,
            max_passes: 2,
            dry_run: selfDriveCandidate.dry_run,
            trichat_bridge_dry_run: selfDriveCandidate.trichat_bridge_dry_run,
            permission_profile: selfDriveCandidate.permission_profile,
            constraints: [
              "Do not require new human credentials or approval.",
              "Apply only bounded local repairs; if an external login or account action is required, record the blocker and stop.",
              "Do not create recursive self-improvement or broad refactor goals from self-drive.",
              ...(selfDriveCandidate.constraints ?? []),
            ],
            tags: selfDriveCandidate.tags,
            metadata: {
              ...(selfDriveCandidate.metadata ?? {}),
              self_drive: true,
              self_drive_mode: selfDriveCandidate.reason,
              spawned_by: "autonomy.maintain",
            },
            source_client: sourceClient,
            source_model: input.source_model,
            source_agent: sourceAgent,
          })
        );
        lastSelfDriveAt = now;
        lastSelfDriveGoalId = readString(asRecord(selfDriveResult.goal).goal_id) ?? lastSelfDriveGoalId;
        lastSelfDriveFingerprint = fingerprint;
        actions.push(`autonomy.self_drive:${selfDriveCandidate.reason}`);
      } catch (error) {
        attention.push(`autonomy.self_drive.failed:${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      actions.push("autonomy.self_drive.cooldown");
    }
  }

  const warmCacheState = storage.getWarmCacheState();
  const warmCacheAgeSeconds = isoAgeSeconds(warmCacheState.last_run_at ?? null);
  if (warmCacheState.enabled && (warmCacheAgeSeconds === Number.POSITIVE_INFINITY || warmCacheAgeSeconds >= warmCacheState.interval_seconds)) {
    try {
      await invokeTool("warm.cache", {
        action: "run_once",
        mutation: deriveMutation(input.mutation!, "warm-cache"),
        thread_id: warmCacheState.thread_id,
      });
      actions.push("warm.cache");
    } catch (error) {
      attention.push(`warm.cache.failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const nextState = storage.setAutonomyMaintainState({
    enabled: true,
    local_host_id: input.local_host_id,
    interval_seconds: input.interval_seconds,
    learning_review_interval_seconds: input.learning_review_interval_seconds,
    enable_self_drive: input.enable_self_drive,
    self_drive_cooldown_seconds: input.self_drive_cooldown_seconds,
    run_eval_if_due: input.run_eval_if_due,
    eval_interval_seconds: input.eval_interval_seconds,
    eval_suite_id: input.eval_suite_id,
    minimum_eval_score: input.minimum_eval_score,
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
    last_eval_dependency_fingerprint: evalResult
      ? currentEvalDependencyFingerprint
      : previousState?.last_eval_dependency_fingerprint ?? null,
    last_observability_ship_at: lastObservabilityShipAt,
    last_provider_bridge_check_at: providerBridgeDiagnostics.generated_at,
    provider_bridge_diagnostics: providerBridgeHeartbeatEntries,
    last_self_drive_at: lastSelfDriveAt,
    last_self_drive_goal_id: lastSelfDriveGoalId,
    last_self_drive_fingerprint: lastSelfDriveFingerprint,
    last_actions: actions,
    last_attention: attention,
    last_error: lastError,
  });
  const desktopControlHeartbeatSummary = asRecord(asRecord(desktopControlHeartbeat).summary);

  const shouldPublishEvent =
    input.publish_runtime_event !== false &&
    (goalAutorunStarted ||
      (readNumber(taskRecoveryResult?.recovered_count) ?? 0) > 0 ||
      (readNumber(taskRecoveryResult?.failed_count) ?? 0) > 0 ||
      taskSummary.counts.failed > 0 ||
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
        self_drive_goal_id: nextState.last_self_drive_goal_id,
        learning_entry_count: nextState.last_learning_entry_count,
        learning_active_agent_count: nextState.last_learning_active_agent_count,
        goal_hygiene_archived_count: readNumber(goalHygieneResult?.archived_count) ?? 0,
        task_recovery_requeued_count: readNumber(taskRecoveryResult?.recovered_count) ?? 0,
        task_recovery_failed_count: readNumber(taskRecoveryResult?.failed_count) ?? 0,
        runtime_worker_active_count: readNumber(asRecord(runtimeWorkerStatus.summary).active_count) ?? 0,
        runtime_worker_eligible_pending_count: countRuntimeEligibleTasks(storage, "pending"),
        runtime_worker_created_count: readNumber(runtimeWorkerSpawnResult?.created_count) ?? 0,
        runtime_worker_failed_count: readNumber(asRecord(asRecord(runtimeWorkerStatus.summary).counts).failed) ?? 0,
        expired_running_task_count: taskSummary.expired_running_count ?? 0,
        failed_task_count: taskSummary.counts.failed,
        task_auto_retry_running: readBoolean(taskAutoRetryStatus.running) === true,
        reaction_engine_running: readBoolean(asRecord(reactionEngineStatus.runtime).running) === true,
        goal_autorun_running: readBoolean(goalAutorunStatus.running) === true,
        tmux_maintained: Boolean(tmuxMaintainResult),
        subsystems: {
          transcript_auto_squish: transcriptAutoSquishSummary,
          imprint_auto_snapshot: imprintAutoSnapshotSummary,
          trichat_auto_retention: trichatAutoRetentionSummary,
          trichat_turn_watchdog: trichatTurnWatchdogSummary,
        },
        optimizer_role_id: optimizerPlan.selected_role_id,
        optimizer_due: optimizerPlan.due,
        optimizer_improvement: readNumber(optimizerResult?.improvement),
        optimizer_promoted: readBoolean(optimizerResult?.promoted),
        provider_bridge: {
          generated_at: providerBridgeDiagnostics.generated_at,
          connected_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "connected").length,
          configured_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "configured").length,
          disconnected_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "disconnected").length,
          unavailable_count: providerBridgeEntries.filter((entry) => String(entry.status ?? "").trim().toLowerCase() === "unavailable").length,
        },
        desktop_control: {
          enabled: readBoolean(desktopControlHeartbeatSummary.enabled) === true || desktopControlState.enabled,
          stale: readBoolean(desktopControlHeartbeatSummary.stale),
          observe_ready: readBoolean(desktopControlHeartbeatSummary.observe_ready),
          act_ready: readBoolean(desktopControlHeartbeatSummary.act_ready),
          listen_ready: readBoolean(desktopControlHeartbeatSummary.listen_ready),
        },
      },
      source_client: sourceClient,
      source_model: input.source_model,
      source_agent: sourceAgent,
    });
  }

  const status = await buildStatus(storage, invokeTool, input, nextState);
  const evalReady = readBoolean(asRecord(status.eval_health).healthy) === true;
  return {
    ok:
      readBoolean(asRecord(status.bootstrap).self_start_ready) === true &&
      evalReady,
    actions,
    eval: {
      executed: Boolean(evalResult),
      suite_id: input.eval_suite_id,
      run_id: readString(evalResult?.run_id),
      ok: readBoolean(evalResult?.ok),
      aggregate_metric_value: readNumber(evalResult?.aggregate_metric_value),
    },
    optimizer: {
      executed: Boolean(optimizerResult),
      role_id: optimizerPlan.selected_role_id,
      due: optimizerPlan.due,
      promoted: readBoolean(optimizerResult?.promoted) === true,
      improvement: readNumber(optimizerResult?.improvement),
      last_run_at: optimizerPlan.last_run_at,
      objectives: optimizerPlan.objectives,
      focus_areas: optimizerPlan.focus_areas,
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
      enable_self_drive: persisted.enable_self_drive,
      self_drive_cooldown_seconds: persisted.self_drive_cooldown_seconds,
      run_eval_if_due: persisted.run_eval_if_due,
      eval_interval_seconds: persisted.eval_interval_seconds,
      eval_suite_id: persisted.eval_suite_id,
      minimum_eval_score: persisted.minimum_eval_score,
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
    if (input.fast === true) {
      return buildFastStatus(storage, input);
    }
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
          local_host_id: previousState.local_host_id,
          interval_seconds: previousState.interval_seconds,
          learning_review_interval_seconds: previousState.learning_review_interval_seconds,
          enable_self_drive: previousState.enable_self_drive,
          self_drive_cooldown_seconds: previousState.self_drive_cooldown_seconds,
          run_eval_if_due: previousState.run_eval_if_due,
          eval_interval_seconds: previousState.eval_interval_seconds,
          eval_suite_id: previousState.eval_suite_id,
          minimum_eval_score: previousState.minimum_eval_score,
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
          last_eval_dependency_fingerprint: previousState.last_eval_dependency_fingerprint,
          last_observability_ship_at: previousState.last_observability_ship_at,
          last_provider_bridge_check_at: previousState.last_provider_bridge_check_at,
          provider_bridge_diagnostics: previousState.provider_bridge_diagnostics,
          last_self_drive_at: previousState.last_self_drive_at,
          last_self_drive_goal_id: previousState.last_self_drive_goal_id,
          last_self_drive_fingerprint: previousState.last_self_drive_fingerprint,
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
            local_host_id: autonomyMaintainRuntime.config.local_host_id,
            interval_seconds: autonomyMaintainRuntime.config.interval_seconds,
            learning_review_interval_seconds: autonomyMaintainRuntime.config.learning_review_interval_seconds,
            enable_self_drive: autonomyMaintainRuntime.config.enable_self_drive,
            self_drive_cooldown_seconds: autonomyMaintainRuntime.config.self_drive_cooldown_seconds,
            run_eval_if_due: autonomyMaintainRuntime.config.run_eval_if_due,
            eval_interval_seconds: autonomyMaintainRuntime.config.eval_interval_seconds,
            eval_suite_id: autonomyMaintainRuntime.config.eval_suite_id,
            minimum_eval_score: autonomyMaintainRuntime.config.minimum_eval_score,
            last_run_at: current.last_run_at ?? null,
            last_bootstrap_ready_at: current.last_bootstrap_ready_at,
            last_goal_autorun_daemon_at: current.last_goal_autorun_daemon_at,
            last_tmux_maintained_at: current.last_tmux_maintained_at,
            last_learning_review_at: current.last_learning_review_at,
            last_learning_entry_count: current.last_learning_entry_count,
            last_learning_active_agent_count: current.last_learning_active_agent_count,
            last_eval_run_at: current.last_eval_run_at,
            last_eval_run_id: current.last_eval_run_id,
            last_eval_score: current.last_eval_score,
            last_eval_dependency_fingerprint: current.last_eval_dependency_fingerprint,
            last_observability_ship_at: current.last_observability_ship_at,
            last_provider_bridge_check_at: current.last_provider_bridge_check_at,
            provider_bridge_diagnostics: current.provider_bridge_diagnostics,
            last_self_drive_at: current.last_self_drive_at,
            last_self_drive_goal_id: current.last_self_drive_goal_id,
            last_self_drive_fingerprint: current.last_self_drive_fingerprint,
            last_actions: current.last_actions,
            last_attention: current.last_attention,
            last_error: current.last_error,
          });
        }
        const status =
          input.fast === true && input.run_immediately === false
            ? buildFastStatus(storage, input)
            : await buildStatus(storage, invokeTool, input);
        return {
          ok: true,
          started: !wasRunning,
          updated: wasRunning,
          initial_tick: initialTick,
          status,
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
