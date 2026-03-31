import { z } from "zod";
import {
  type AgentSessionRecord,
  type RuntimeWorkerSessionRecord,
  type TaskRecord,
  type TriChatAdapterTelemetrySummaryRecord,
  Storage,
} from "../storage.js";
import { getTriChatAgentCatalog, getTriChatConfiguredDefaultAgentIds } from "../trichat_roster.js";
import type { AgentLearningOverview } from "./agent_learning.js";
import { listAgentSessions } from "./agent_session.js";
import { summarizeAgentLearning } from "./agent_learning.js";
import { getAutonomyMaintainRuntimeStatus } from "./autonomy_maintain.js";
import { kernelSummary, summarizeAutonomyMaintain } from "./kernel.js";
import { operatorBrief } from "./operator_brief.js";
import { getReactionEngineRuntimeStatus } from "./reaction_engine.js";
import { summarizeLiveRuntimeWorkers } from "./runtime_worker.js";
import { taskList, taskSummary } from "./task.js";
import { trichatAdapterTelemetry, trichatSummary, trichatWorkboard } from "./trichat.js";

const recordSchema = z.record(z.unknown());
type TaskListPayload = ReturnType<typeof taskList>;
type TaskSummaryPayload = ReturnType<typeof taskSummary>;
type AgentSessionListPayload = ReturnType<typeof listAgentSessions>;
type LearningPayload = AgentLearningOverview | {};
type AdapterPayload = ReturnType<typeof trichatAdapterTelemetry>;
type WorkboardPayload = ReturnType<typeof trichatWorkboard>;
type TriChatSummaryPayload = ReturnType<typeof trichatSummary>;
type OperatorBriefPayload = ReturnType<typeof operatorBrief>;
type RuntimeWorkersPayload = {
  count: number;
  sessions: RuntimeWorkerSessionRecord[];
  summary: {
    session_count: number;
    active_count: number;
    counts: Record<string, number>;
    latest_session: RuntimeWorkerSessionRecord | null;
  };
};

export const officeSnapshotSchema = z.object({
  thread_id: z.string().min(1).optional(),
  turn_limit: z.number().int().min(1).max(30).default(12),
  task_limit: z.number().int().min(1).max(64).default(24),
  session_limit: z.number().int().min(1).max(100).default(50),
  event_limit: z.number().int().min(1).max(80).default(24),
  learning_limit: z.number().int().min(1).max(500).default(120),
  runtime_worker_limit: z.number().int().min(1).max(100).default(20),
  include_kernel: z.boolean().default(true),
  include_learning: z.boolean().default(true),
  include_bus: z.boolean().default(true),
  include_adapter: z.boolean().default(true),
  include_runtime_workers: z.boolean().default(true),
  metadata: recordSchema.optional(),
});

function normalizeAgentId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function dedupeAgentIds(values: unknown[]) {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const agentId = normalizeAgentId(value);
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ordered.push(agentId);
  }
  return ordered;
}

function ageSeconds(value: string | null | undefined) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - parsed) / 1000);
}

function summarizeTmuxDashboard(state: ReturnType<Storage["getTriChatTmuxControllerState"]>) {
  const tasks = state?.tasks ?? [];
  const queueDepth = tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length;
  const runningDepth = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed");
  const queuedOrRunning = tasks.filter(
    (task) => task.status === "queued" || task.status === "dispatched" || task.status === "running"
  );
  const oldestTask = queuedOrRunning
    .slice()
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))[0];
  return {
    queue_depth: queueDepth,
    running_depth: runningDepth,
    queue_oldest_task_id: oldestTask?.task_id ?? null,
    queue_age_seconds: oldestTask ? ageSeconds(oldestTask.created_at) : 0,
    failure_count: failed.length,
    failure_class: failed.length > 0 ? "task-failed" : "none",
    worker_load: [],
    host_load: [],
  };
}

function summarizeRuntimeWorkers(storage: Storage, limit: number): RuntimeWorkersPayload {
  return summarizeLiveRuntimeWorkers(storage, limit);
}

function summarizeAutonomyMaintainState(storage: Storage) {
  const state = storage.getAutonomyMaintainState();
  const summary = summarizeAutonomyMaintain(state, storage);
  return {
    action: "status_cached",
    state: state ?? {
      enabled: false,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
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
    },
    runtime: summary.runtime,
    due: {
      stale: summary.stale,
      eval: summary.eval_due,
    },
    subsystems: summary.subsystems,
  };
}

function summarizeReactionEngineState(storage: Storage) {
  const state = storage.getReactionEngineState();
  const runtime = getReactionEngineRuntimeStatus();
  const stale =
    state?.enabled === true && ageSeconds(runtime.last_tick_at || state.last_run_at) > Math.max((state.interval_seconds ?? 60) * 3, 300);
  return {
    ...(state ?? {
      enabled: false,
      interval_seconds: 60,
      dedupe_window_seconds: 300,
      channels: [],
      last_run_at: null,
      last_sent_at: null,
      last_sent_count: 0,
      last_alert_key: null,
      last_alert_seen_count: 0,
      recent_notifications: [],
      last_error: null,
      updated_at: new Date().toISOString(),
    }),
    runtime,
    stale,
  };
}

function buildRosterPayload(
  workboard: WorkboardPayload,
  agentSessions: AgentSessionListPayload,
  learning: LearningPayload
) {
  const latestTurn = (workboard.active_turn as Record<string, unknown> | null) ?? (workboard.latest_turn as Record<string, unknown> | null) ?? {};
  const latestMetadata = (latestTurn.metadata as Record<string, unknown> | undefined) ?? {};
  const defaultAgentIds = getTriChatConfiguredDefaultAgentIds();
  const activeAgentIds = dedupeAgentIds([
    latestMetadata.lead_agent_id,
    latestTurn.selected_agent,
    ...((Array.isArray(latestTurn.expected_agents) ? latestTurn.expected_agents : []) as unknown[]),
    ...((Array.isArray(latestMetadata.specialist_agent_ids) ? latestMetadata.specialist_agent_ids : []) as unknown[]),
    ...agentSessions.sessions.map((session) => session.agent_id),
    ...(((learning as Record<string, unknown>).top_agents as Array<Record<string, unknown>> | undefined) ?? []).map(
      (entry) => entry.agent_id
    ),
    ...defaultAgentIds,
  ]);
  return {
    default_agent_ids: defaultAgentIds,
    active_agent_ids: activeAgentIds,
    agents: getTriChatAgentCatalog().map((agent) => ({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      provider: agent.provider ?? null,
      role_lane: agent.role_lane ?? "support",
      coordination_tier: agent.coordination_tier ?? "support",
      parent_agent_id: agent.parent_agent_id ?? "",
      managed_agent_ids: agent.managed_agent_ids ?? [],
      accent_color: agent.accent_color ?? "",
      enabled: agent.enabled !== false,
    })),
    source: "office.snapshot",
  };
}

function buildKernelPayload(storage: Storage, summary: TaskSummaryPayload, sessions: AgentSessionListPayload) {
  return kernelSummary(storage, {
    session_limit: Math.max(8, sessions.count || 8),
    event_limit: 12,
    task_running_limit: Math.max(8, summary.running.length || 8),
  });
}

export function officeSnapshot(storage: Storage, input: z.infer<typeof officeSnapshotSchema>) {
  const threadId = input.thread_id?.trim() || "ring-leader-main";
  const errors: string[] = [];
  const safe = <T>(label: string, fallback: T, read: () => T) => {
    try {
      return read();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };

  const workboard = safe<WorkboardPayload>("workboard", trichatWorkboard(storage, { thread_id: threadId, limit: 1 }), () =>
    trichatWorkboard(storage, { thread_id: threadId, limit: input.turn_limit })
  );
  const taskSummaryPayload = safe<TaskSummaryPayload>("task_summary", taskSummary(storage, { running_limit: 8 }), () =>
    taskSummary(storage, { running_limit: Math.max(4, Math.min(24, input.task_limit)) })
  );
  const taskRunning = safe<TaskListPayload>("task_running", { status_filter: "running", count: 0, tasks: [] as TaskRecord[] }, () =>
    taskList(storage, { status: "running", limit: input.task_limit })
  );
  const taskPending = safe<TaskListPayload>("task_pending", { status_filter: "pending", count: 0, tasks: [] as TaskRecord[] }, () =>
    taskList(storage, { status: "pending", limit: input.task_limit })
  );
  const agentSessions = safe<AgentSessionListPayload>("agent_sessions", {
    status_filter: null,
    agent_id_filter: null,
    client_kind_filter: null,
    active_only_filter: null,
    count: 0,
    sessions: [] as AgentSessionRecord[],
  }, () =>
    listAgentSessions(storage, { limit: input.session_limit })
  );
  const learning = input.include_learning
    ? safe<LearningPayload>("learning", {
        generated_at: new Date().toISOString(),
        filter: { agent_id: null },
        total_entries: 0,
        active_entry_count: 0,
        suppressed_entry_count: 0,
        prefer_count: 0,
        avoid_count: 0,
        agent_count: 0,
        agents_with_active_entries: 0,
        kind_counts: {
          execution_pattern: 0,
          delegation_pattern: 0,
          verification_pattern: 0,
          failure_pattern: 0,
          guardrail: 0,
        },
        top_agents: [],
        recent_entries: [],
      }, () =>
        summarizeAgentLearning(storage, {
          limit: input.learning_limit,
          top_agents_limit: 8,
          recent_limit: 8,
        })
      )
    : {};
  const roster = safe("roster", {
    default_agent_ids: getTriChatConfiguredDefaultAgentIds(),
    active_agent_ids: [] as string[],
    agents: getTriChatAgentCatalog().map((agent) => ({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      provider: agent.provider ?? null,
      role_lane: agent.role_lane ?? "support",
      coordination_tier: agent.coordination_tier ?? "support",
      parent_agent_id: agent.parent_agent_id ?? "",
      managed_agent_ids: agent.managed_agent_ids ?? [],
      accent_color: agent.accent_color ?? "",
      enabled: agent.enabled !== false,
    })),
    source: "office.snapshot",
  }, () =>
    buildRosterPayload(workboard, agentSessions, learning)
  );
  const tmuxState = safe("tmux", null, () => storage.getTriChatTmuxControllerState());
  const tmux = {
    generated_at: new Date().toISOString(),
    action: "status_cached",
    session_active: Boolean(tmuxState?.enabled),
    state: tmuxState ?? { enabled: false, tasks: [] },
    dashboard: summarizeTmuxDashboard(tmuxState),
  };
  const adapter = input.include_adapter
    ? safe<AdapterPayload>("adapter", {
        generated_at: new Date().toISOString(),
        agent_id: null,
        channel: null,
        state_count: 0,
        states: [],
        summary: {
          total_channels: 0,
          open_channels: 0,
          total_trips: 0,
          total_successes: 0,
          total_turns: 0,
          total_degraded_turns: 0,
          newest_state_at: null,
          newest_event_at: null,
          newest_trip_opened_at: null,
          per_agent: [],
        } satisfies TriChatAdapterTelemetrySummaryRecord,
        recent_events: [],
        last_open_events: [],
      }, () =>
        trichatAdapterTelemetry(storage, { action: "status", include_events: true, event_limit: Math.min(12, input.event_limit) })
      )
    : {};
  const busTail = input.include_bus
    ? safe("bus_tail", { count: 0, thread_id: threadId, events: [] as unknown[] }, () => {
        const events = storage.listTriChatBusEvents({ thread_id: threadId, limit: input.event_limit });
        return {
          count: events.length,
          thread_id: threadId,
          events,
        };
      })
    : {};
  const trichatSummaryPayload = safe<TriChatSummaryPayload>("trichat_summary", {
    generated_at: new Date().toISOString(),
    thread_counts: {
      active: 0,
      archived: 0,
      total: 0,
    },
    message_count: 0,
    oldest_message_at: null,
    newest_message_at: null,
    busiest_threads: [],
  }, () =>
    trichatSummary(storage, { busiest_limit: 6 })
  );
  const runtimeWorkers = input.include_runtime_workers
    ? safe<RuntimeWorkersPayload>("runtime_workers", {
        count: 0,
        sessions: [] as RuntimeWorkerSessionRecord[],
        summary: {
          session_count: 0,
          active_count: 0,
          counts: {},
          latest_session: null,
        },
      } as RuntimeWorkersPayload, () =>
        summarizeRuntimeWorkers(storage, input.runtime_worker_limit)
      )
    : {};
  const operatorBriefPayload = safe<OperatorBriefPayload>(
    "operator_brief",
    {
      generated_at: new Date().toISOString(),
      thread_id: threadId,
      current_objective: null,
      goal: null,
      plan: null,
      step: null,
      task: null,
      ring_leader_session: null,
      runtime_worker_session: null,
      delegation_brief: {
        delegate_agent_id: null,
        task_objective: null,
        success_criteria: [],
        evidence_requirements: [],
        rollback_notes: [],
      },
      compile_brief_artifact: null,
      runtime_brief_markdown: null,
      execution_backlog: [],
      kernel: null,
      brief_markdown: "# Operator Brief\n\nNo active operator brief available.",
      source: "operator.brief",
    } as unknown as OperatorBriefPayload,
    () =>
      operatorBrief(storage, {
        thread_id: threadId,
        include_kernel: false,
        include_runtime_brief: false,
        include_compile_brief: true,
        compact: true,
      })
  );
  const autonomyMaintain = safe("autonomy_maintain", summarizeAutonomyMaintainState(storage), () =>
    summarizeAutonomyMaintainState(storage)
  );
  const kernel = input.include_kernel
    ? safe("kernel", buildKernelPayload(storage, taskSummaryPayload, agentSessions), () =>
        buildKernelPayload(storage, taskSummaryPayload, agentSessions)
      )
    : {};
  const autopilot = safe("autopilot", {}, () => {
    const state = storage.getTriChatAutopilotState();
    return state ? { state } : {};
  });

  return {
    generated_at: new Date().toISOString(),
    thread_id: threadId,
    errors,
    roster,
    workboard,
    tmux,
    task_summary: taskSummaryPayload,
    task_running: taskRunning,
    task_pending: taskPending,
    agent_sessions: agentSessions,
    adapter,
    bus_tail: busTail,
    trichat_summary: trichatSummaryPayload,
    kernel,
    learning,
    autopilot,
    autonomy_maintain: autonomyMaintain,
    runtime_workers: runtimeWorkers,
    operator_brief: operatorBriefPayload,
    source: "office.snapshot",
  };
}
