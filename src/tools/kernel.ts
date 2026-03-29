import { z } from "zod";
import {
  type AutonomyMaintainStateRecord,
  type AgentSessionRecord,
  type EvalSuiteRecord,
  type EvalSuitesStateRecord,
  type GoalRecord,
  type ModelRouterBackendRecord,
  type ModelRouterStateRecord,
  type OrgProgramRoleRecord,
  type OrgProgramsStateRecord,
  type PlanRecord,
  type PlanStepRecord,
  type TaskSummaryRecord,
  type WorkerFabricHostRecord,
  type WorkerFabricStateRecord,
  Storage,
} from "../storage.js";
import { getAdaptiveWorkerProfile, summarizeAdaptiveSessionHealth, summarizeAdaptiveWorkerProfile } from "./agent_session.js";
import { buildAgentLearningOverview } from "./agent_learning.js";
import { evaluatePlanStepReadiness, getPlanStepApprovalGateKind } from "./plan.js";

const goalStatusSchema = z.enum([
  "draft",
  "active",
  "blocked",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);

export const kernelSummarySchema = z.object({
  goal_limit: z.number().int().min(1).max(100).optional(),
  session_limit: z.number().int().min(1).max(100).optional(),
  experiment_limit: z.number().int().min(1).max(100).optional(),
  artifact_limit: z.number().int().min(1).max(100).optional(),
  event_limit: z.number().int().min(1).max(200).optional(),
  task_running_limit: z.number().int().min(1).max(100).optional(),
  event_since: z.string().optional(),
});

type GoalExecutionSnapshot = {
  plan_id: string | null;
  plan_status: string | null;
  ready_count: number;
  running_count: number;
  completed_count: number;
  blocked_count: number;
  failed_count: number;
  pending_count: number;
  blocked_approval_count: number;
  blocked_human_count: number;
  worker_pool_paused: boolean;
  worker_pool_pause_reason: string | null;
  worker_pool_recovery_state: "none" | "no_viable_pool" | "awaiting_pool_change" | "ready_for_recovery";
  worker_pool_recovery_suppressed_count: number;
  current_worker_pool_fingerprint: string | null;
  last_attempted_worker_pool_fingerprint: string | null;
  methodology_entry_held: boolean;
  methodology_entry_hold_state: "none" | "blocked_by_no_viable_lane" | "ready_for_recovery";
  methodology_entry_hold_reason: string | null;
  methodology_entry_hold_count: number;
  next_action: string;
};

type AdaptiveRoutingMode = "preferred_pool" | "fallback_degraded" | "none";

type GoalAdaptiveRoutingSnapshot = {
  worker_step_count: number;
  mode_counts: Record<AdaptiveRoutingMode, number>;
  attention: string[];
};

type AdaptiveSessionState = "unproven" | "healthy" | "degraded" | "suppressed";

type AdaptiveSessionSnapshot = {
  session_id: string;
  agent_id: string;
  client_kind: string | null;
  status: string;
  adaptive_state: AdaptiveSessionState;
  adaptive_reasons: string[];
  total_claims: number;
  total_completed: number;
  total_failed: number;
  total_stagnation_signals: number;
  total_evidence_blocks: number;
  consecutive_failures: number;
  consecutive_stagnation_signals: number;
  average_completion_seconds: number | null;
  current_task: Record<string, unknown>;
  complexity: {
    low: ReturnType<typeof summarizeAdaptiveWorkerProfile>;
    medium: ReturnType<typeof summarizeAdaptiveWorkerProfile>;
    high: ReturnType<typeof summarizeAdaptiveWorkerProfile>;
  };
};

type HostFabricSummary = {
  enabled: boolean;
  strategy: WorkerFabricStateRecord["strategy"] | null;
  default_host_id: string | null;
  host_count: number;
  enabled_host_count: number;
  worker_count: number;
  active_worker_count: number;
  health_counts: Record<"healthy" | "degraded" | "offline", number>;
  transport_counts: Record<"local" | "ssh", number>;
  hosts: Array<{
    host_id: string;
    transport: WorkerFabricHostRecord["transport"];
    enabled: boolean;
    worker_count: number;
    health_state: WorkerFabricHostRecord["telemetry"]["health_state"];
    health_score: number;
    queue_depth: number;
    active_tasks: number;
    heartbeat_at: string | null;
    tags: string[];
  }>;
};

type ModelRouterSummary = {
  enabled: boolean;
  strategy: ModelRouterStateRecord["strategy"] | null;
  default_backend_id: string | null;
  backend_count: number;
  enabled_backend_count: number;
  provider_counts: Record<string, number>;
  locality_counts: Record<"local" | "remote", number>;
  backends: Array<{
    backend_id: string;
    provider: ModelRouterBackendRecord["provider"];
    model_id: string;
    host_id: string | null;
    locality: ModelRouterBackendRecord["locality"];
    enabled: boolean;
    context_window: number;
    latency_ms_p50: number | null;
    throughput_tps: number | null;
    success_rate: number | null;
    win_rate: number | null;
    heartbeat_at: string | null;
    tags: string[];
  }>;
};

type EvalSummary = {
  enabled: boolean;
  suite_count: number;
  total_case_count: number;
  benchmark_case_count: number;
  router_case_count: number;
  suites: Array<{
    suite_id: string;
    title: string;
    case_count: number;
    benchmark_case_count: number;
    router_case_count: number;
    tags: string[];
  }>;
};

type OrgProgramSummary = {
  enabled: boolean;
  role_count: number;
  active_role_count: number;
  version_count: number;
  active_version_count: number;
  status_counts: Record<"candidate" | "active" | "archived", number>;
  roles: Array<{
    role_id: string;
    title: string;
    lane: string | null;
    version_count: number;
    active_version_id: string | null;
  }>;
};

type AutonomyMaintainSummary = {
  enabled: boolean;
  interval_seconds: number;
  learning_review_interval_seconds: number;
  eval_interval_seconds: number;
  last_run_at: string | null;
  last_run_age_seconds: number | null;
  stale: boolean;
  last_bootstrap_ready_at: string | null;
  last_goal_autorun_daemon_at: string | null;
  last_tmux_maintained_at: string | null;
  last_learning_review_at: string | null;
  last_learning_entry_count: number;
  last_learning_active_agent_count: number;
  last_eval_run_at: string | null;
  last_eval_score: number | null;
  eval_due: boolean;
  last_actions: string[];
  last_attention: string[];
  last_error: string | null;
};

function countByStatus<T extends { status: string }>(records: T[]) {
  return records.reduce<Record<string, number>>((acc, record) => {
    acc[record.status] = (acc[record.status] ?? 0) + 1;
    return acc;
  }, {});
}

function ageSeconds(value: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, Number((((Date.now() - timestamp) / 1000)).toFixed(4)));
}

function isTerminalPlanStatus(status: PlanRecord["status"]) {
  return status === "completed" || status === "invalidated" || status === "archived";
}

function resolveGoalPlan(storage: Storage, goal: GoalRecord): PlanRecord | null {
  if (goal.active_plan_id) {
    const activePlan = storage.getPlanById(goal.active_plan_id);
    if (activePlan && activePlan.goal_id === goal.goal_id && !isTerminalPlanStatus(activePlan.status)) {
      return activePlan;
    }
  }
  return (
    storage
      .listPlans({
        goal_id: goal.goal_id,
        selected_only: true,
        limit: 10,
      })
      .find((plan) => !isTerminalPlanStatus(plan.status)) ??
    storage
      .listPlans({
        goal_id: goal.goal_id,
        limit: 10,
      })
      .find((plan) => !isTerminalPlanStatus(plan.status)) ??
    null
  );
}

function summarizeGoalExecution(plan: PlanRecord | null, steps: PlanStepRecord[]): GoalExecutionSnapshot {
  if (!plan) {
    return {
      plan_id: null,
      plan_status: null,
      ready_count: 0,
      running_count: 0,
      completed_count: 0,
      blocked_count: 0,
      failed_count: 0,
      pending_count: 0,
      blocked_approval_count: 0,
      blocked_human_count: 0,
      worker_pool_paused: false,
      worker_pool_pause_reason: null,
      worker_pool_recovery_state: "none",
      worker_pool_recovery_suppressed_count: 0,
      current_worker_pool_fingerprint: null,
      last_attempted_worker_pool_fingerprint: null,
      methodology_entry_held: false,
      methodology_entry_hold_state: "none",
      methodology_entry_hold_reason: null,
      methodology_entry_hold_count: 0,
      next_action: "No active plan exists for this goal.",
    };
  }

  const readiness = evaluatePlanStepReadiness(steps);
  const readyCount = readiness.filter((entry) => entry.ready).length;
  const counts = steps.reduce<Record<string, number>>((acc, step) => {
    acc[step.status] = (acc[step.status] ?? 0) + 1;
    return acc;
  }, {});
  const blockedApprovalSteps = steps.filter((step) => step.status === "blocked" && getPlanStepApprovalGateKind(step) !== null);
  const blockedApprovalCount = blockedApprovalSteps.length;
  const blockedHumanCount = blockedApprovalSteps.filter((step) => getPlanStepApprovalGateKind(step) === "human").length;
  const runningCount = counts.running ?? 0;
  const failedCount = counts.failed ?? 0;
  const workerPoolPause = isRecord(plan.metadata.worker_pool_pause) ? plan.metadata.worker_pool_pause : null;

  let nextAction = "Plan is idle.";
  if (plan.status === "completed") {
    nextAction = "Plan completed; review artifacts and close the goal if acceptance criteria are satisfied.";
  } else if (failedCount > 0) {
    nextAction = "Inspect failed steps and retry or resume only after the blocking issue is fixed.";
  } else if (workerPoolPause) {
    nextAction = "Execution is paused until healthier worker lanes are available or a safer plan is selected.";
  } else if (blockedApprovalCount > 0) {
    nextAction =
      blockedHumanCount === blockedApprovalCount
        ? "A human approval gate is blocking execution."
        : "An approval gate is blocking execution.";
  } else if (runningCount > 0) {
    nextAction = "Execution is in flight; wait for running work to finish or report results.";
  } else if (readyCount > 0) {
    nextAction = "Ready steps are available for dispatch.";
  }

  return {
    plan_id: plan.plan_id,
    plan_status: plan.status,
    ready_count: readyCount,
    running_count: runningCount,
    completed_count: counts.completed ?? 0,
    blocked_count: counts.blocked ?? 0,
    failed_count: failedCount,
    pending_count: counts.pending ?? 0,
    blocked_approval_count: blockedApprovalCount,
    blocked_human_count: blockedHumanCount,
    worker_pool_paused: workerPoolPause !== null,
    worker_pool_pause_reason: readString(workerPoolPause?.reason),
    worker_pool_recovery_state: workerPoolPause ? "no_viable_pool" : "none",
    worker_pool_recovery_suppressed_count: 0,
    current_worker_pool_fingerprint: null,
    last_attempted_worker_pool_fingerprint: null,
    methodology_entry_held: false,
    methodology_entry_hold_state: "none",
    methodology_entry_hold_reason: null,
    methodology_entry_hold_count: 0,
    next_action: nextAction,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildWorkerPoolRecoveryFingerprint(sessions: AgentSessionRecord[]) {
  if (sessions.length === 0) {
    return null;
  }
  return sessions
    .map((session) => {
      const adaptiveState = summarizeAdaptiveSessionHealth(session).adaptive_state;
      return [session.session_id, session.agent_id, session.client_kind ?? "", session.status, adaptiveState].join(":");
    })
    .sort()
    .join("|");
}

function summarizeWorkerPoolRecoveryState(plan: PlanRecord, activeSessions: AgentSessionRecord[]) {
  const workerPoolPause = isRecord(plan.metadata.worker_pool_pause) ? plan.metadata.worker_pool_pause : null;
  if (!workerPoolPause) {
    return {
      state: "none" as const,
      pause_reason: null,
      suppression_count: 0,
      current_pool_fingerprint: null,
      last_attempted_pool_fingerprint: null,
    };
  }

  const currentPoolFingerprint = buildWorkerPoolRecoveryFingerprint(activeSessions);
  const viablePoolAvailable = activeSessions.some((session) => {
    const state = summarizeAdaptiveSessionHealth(session).adaptive_state;
    return state === "healthy" || state === "unproven";
  });
  const existingAttempt = isRecord(plan.metadata.worker_pool_recovery_attempt) ? plan.metadata.worker_pool_recovery_attempt : null;
  const existingSuppression = isRecord(plan.metadata.worker_pool_recovery_suppressed)
    ? plan.metadata.worker_pool_recovery_suppressed
    : null;
  const lastAttemptedPoolFingerprint = readString(existingAttempt?.pool_fingerprint);
  const suppressionCount = readFiniteNumber(existingSuppression?.count) ?? 0;

  if (!viablePoolAvailable || !currentPoolFingerprint) {
    return {
      state: "no_viable_pool" as const,
      pause_reason: readString(workerPoolPause.reason),
      suppression_count: suppressionCount,
      current_pool_fingerprint: currentPoolFingerprint,
      last_attempted_pool_fingerprint: lastAttemptedPoolFingerprint,
    };
  }

  if (lastAttemptedPoolFingerprint === currentPoolFingerprint) {
    return {
      state: "awaiting_pool_change" as const,
      pause_reason: readString(workerPoolPause.reason),
      suppression_count: suppressionCount,
      current_pool_fingerprint: currentPoolFingerprint,
      last_attempted_pool_fingerprint: lastAttemptedPoolFingerprint,
    };
  }

  return {
    state: "ready_for_recovery" as const,
    pause_reason: readString(workerPoolPause.reason),
    suppression_count: suppressionCount,
    current_pool_fingerprint: currentPoolFingerprint,
    last_attempted_pool_fingerprint: lastAttemptedPoolFingerprint,
  };
}

function summarizeMethodologyEntryHoldState(goal: GoalRecord, activeSessions: AgentSessionRecord[]) {
  const hold = isRecord(goal.metadata.methodology_entry_hold) ? goal.metadata.methodology_entry_hold : null;
  if (!hold) {
    return {
      held: false,
      state: "none" as const,
      reason: null,
      count: 0,
      current_pool_fingerprint: null,
    };
  }

  const currentPoolFingerprint = buildWorkerPoolRecoveryFingerprint(activeSessions);
  const viablePoolAvailable = activeSessions.some((session) => {
    const state = summarizeAdaptiveSessionHealth(session).adaptive_state;
    return state === "healthy" || state === "unproven";
  });

  return {
    held: true,
    state: viablePoolAvailable ? ("ready_for_recovery" as const) : ("blocked_by_no_viable_lane" as const),
    reason: readString(hold.reason),
    count: readFiniteNumber(hold.count) ?? 0,
    current_pool_fingerprint: currentPoolFingerprint,
  };
}

function summarizePlanAdaptiveRouting(steps: PlanStepRecord[]): GoalAdaptiveRoutingSnapshot {
  const modeCounts: Record<AdaptiveRoutingMode, number> = {
    preferred_pool: 0,
    fallback_degraded: 0,
    none: 0,
  };

  for (const step of steps) {
    if (step.executor_kind !== "worker" && step.executor_kind !== "task") {
      continue;
    }
    const adaptiveAssignment = isRecord(step.metadata.adaptive_assignment) ? step.metadata.adaptive_assignment : null;
    const mode = readString(adaptiveAssignment?.mode);
    if (mode !== "preferred_pool" && mode !== "fallback_degraded" && mode !== "none") {
      continue;
    }
    modeCounts[mode] += 1;
  }

  const attention: string[] = [];
  if (modeCounts.fallback_degraded > 0) {
    attention.push(`Plan uses degraded fallback lanes for ${modeCounts.fallback_degraded} worker step(s).`);
  }
  if (modeCounts.none > 0) {
    attention.push(`Plan has ${modeCounts.none} worker step(s) with no dispatchable adaptive lane guidance.`);
  }

  return {
    worker_step_count: modeCounts.preferred_pool + modeCounts.fallback_degraded + modeCounts.none,
    mode_counts: modeCounts,
    attention,
  };
}

function listOpenGoals(storage: Storage, limit: number) {
  const statuses: Array<z.infer<typeof goalStatusSchema>> = ["active", "waiting", "blocked", "draft", "failed"];
  const seen = new Set<string>();
  const goals: GoalRecord[] = [];

  for (const status of statuses) {
    for (const goal of storage.listGoals({ status, limit })) {
      if (seen.has(goal.goal_id)) {
        continue;
      }
      seen.add(goal.goal_id);
      goals.push(goal);
    }
  }

  goals.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return goals.slice(0, limit);
}

function summarizeAdaptiveSession(session: AgentSessionRecord): AdaptiveSessionSnapshot {
  const adaptive = summarizeAdaptiveSessionHealth(session);
  const performance = adaptive.performance.high;
  const profile = getAdaptiveWorkerProfile(session);

  return {
    session_id: session.session_id,
    agent_id: session.agent_id,
    client_kind: session.client_kind,
    status: session.status,
    adaptive_state: adaptive.adaptive_state,
    adaptive_reasons: adaptive.adaptive_reasons,
    total_claims: performance.total_claims,
    total_completed: performance.total_completed,
    total_failed: performance.total_failed,
    total_stagnation_signals: performance.total_stagnation_signals,
    total_evidence_blocks: performance.total_evidence_blocks,
    consecutive_failures: performance.consecutive_failures,
    consecutive_stagnation_signals: performance.consecutive_stagnation_signals,
    average_completion_seconds: performance.average_completion_seconds,
    current_task: {
      task_id: profile.current_task.task_id,
      claimed_at: profile.current_task.claimed_at,
      heartbeat_count: profile.current_task.heartbeat_count,
      complexity: profile.current_task.complexity,
      stagnation_signaled: profile.current_task.stagnation_signaled,
      stagnation_signaled_at: profile.current_task.stagnation_signaled_at,
    },
    complexity: adaptive.performance,
  };
}

function summarizeWorkerFabric(storage: Storage): HostFabricSummary {
  const state = storage.getWorkerFabricState();
  if (!state) {
    return {
      enabled: false,
      strategy: null,
      default_host_id: null,
      host_count: 0,
      enabled_host_count: 0,
      worker_count: 0,
      active_worker_count: 0,
      health_counts: {
        healthy: 0,
        degraded: 0,
        offline: 0,
      },
      transport_counts: {
        local: 0,
        ssh: 0,
      },
      hosts: [],
    };
  }

  const hosts = [...state.hosts].sort((left, right) => left.host_id.localeCompare(right.host_id));
  const enabledHosts = hosts.filter((host) => host.enabled);
  const healthCounts = hosts.reduce<Record<"healthy" | "degraded" | "offline", number>>(
    (acc, host) => {
      acc[host.telemetry.health_state] += 1;
      return acc;
    },
    {
      healthy: 0,
      degraded: 0,
      offline: 0,
    }
  );
  const transportCounts = hosts.reduce<Record<"local" | "ssh", number>>(
    (acc, host) => {
      acc[host.transport] += 1;
      return acc;
    },
    {
      local: 0,
      ssh: 0,
    }
  );

  return {
    enabled: state.enabled,
    strategy: state.strategy,
    default_host_id: state.default_host_id,
    host_count: hosts.length,
    enabled_host_count: enabledHosts.length,
    worker_count: hosts.reduce((sum, host) => sum + host.worker_count, 0),
    active_worker_count: enabledHosts.reduce((sum, host) => sum + host.worker_count, 0),
    health_counts: healthCounts,
    transport_counts: transportCounts,
    hosts: hosts.map((host) => ({
      host_id: host.host_id,
      transport: host.transport,
      enabled: host.enabled,
      worker_count: host.worker_count,
      health_state: host.telemetry.health_state,
      health_score: host.telemetry.health_state === "offline" ? 0 : host.telemetry.health_state === "degraded" ? 0.55 : 1,
      queue_depth: host.telemetry.queue_depth,
      active_tasks: host.telemetry.active_tasks,
      heartbeat_at: host.telemetry.heartbeat_at,
      tags: host.tags,
    })),
  };
}

function summarizeModelRouter(storage: Storage): ModelRouterSummary {
  const state = storage.getModelRouterState();
  if (!state) {
    return {
      enabled: false,
      strategy: null,
      default_backend_id: null,
      backend_count: 0,
      enabled_backend_count: 0,
      provider_counts: {},
      locality_counts: {
        local: 0,
        remote: 0,
      },
      backends: [],
    };
  }

  const backends = [...state.backends].sort((left, right) => left.backend_id.localeCompare(right.backend_id));
  const providerCounts = backends.reduce<Record<string, number>>((acc, backend) => {
    acc[backend.provider] = (acc[backend.provider] ?? 0) + 1;
    return acc;
  }, {});
  const localityCounts = backends.reduce<Record<"local" | "remote", number>>(
    (acc, backend) => {
      acc[backend.locality] += 1;
      return acc;
    },
    {
      local: 0,
      remote: 0,
    }
  );

  return {
    enabled: state.enabled,
    strategy: state.strategy,
    default_backend_id: state.default_backend_id,
    backend_count: backends.length,
    enabled_backend_count: backends.filter((backend) => backend.enabled).length,
    provider_counts: providerCounts,
    locality_counts: localityCounts,
    backends: backends.map((backend) => ({
      backend_id: backend.backend_id,
      provider: backend.provider,
      model_id: backend.model_id,
      host_id: backend.host_id,
      locality: backend.locality,
      enabled: backend.enabled,
      context_window: backend.context_window,
      latency_ms_p50: backend.latency_ms_p50,
      throughput_tps: backend.throughput_tps,
      success_rate: backend.success_rate,
      win_rate: backend.win_rate,
      heartbeat_at: backend.heartbeat_at,
      tags: backend.tags,
    })),
  };
}

function summarizeEvalSuites(storage: Storage): EvalSummary {
  const state: EvalSuitesStateRecord | null = storage.getEvalSuitesState();
  if (!state) {
    return {
      enabled: false,
      suite_count: 0,
      total_case_count: 0,
      benchmark_case_count: 0,
      router_case_count: 0,
      suites: [],
    };
  }

  const suites = [...state.suites].sort((left, right) => left.title.localeCompare(right.title));
  const caseCounts = suites.reduce(
    (acc, suite) => {
      acc.total_case_count += suite.cases.length;
      acc.benchmark_case_count += suite.cases.filter((entry) => entry.kind === "benchmark_suite").length;
      acc.router_case_count += suite.cases.filter((entry) => entry.kind === "router_case").length;
      return acc;
    },
    {
      total_case_count: 0,
      benchmark_case_count: 0,
      router_case_count: 0,
    }
  );

  return {
    enabled: state.enabled,
    suite_count: suites.length,
    total_case_count: caseCounts.total_case_count,
    benchmark_case_count: caseCounts.benchmark_case_count,
    router_case_count: caseCounts.router_case_count,
    suites: suites.map((suite) => ({
      suite_id: suite.suite_id,
      title: suite.title,
      case_count: suite.cases.length,
      benchmark_case_count: suite.cases.filter((entry) => entry.kind === "benchmark_suite").length,
      router_case_count: suite.cases.filter((entry) => entry.kind === "router_case").length,
      tags: suite.tags,
    })),
  };
}

function summarizeOrgPrograms(storage: Storage): OrgProgramSummary {
  const state: OrgProgramsStateRecord | null = storage.getOrgProgramsState();
  if (!state) {
    return {
      enabled: false,
      role_count: 0,
      active_role_count: 0,
      version_count: 0,
      active_version_count: 0,
      status_counts: {
        candidate: 0,
        active: 0,
        archived: 0,
      },
      roles: [],
    };
  }

  const roles = [...state.roles].sort((left, right) => left.role_id.localeCompare(right.role_id));
  const statusCounts = roles.reduce<Record<"candidate" | "active" | "archived", number>>(
    (acc, role) => {
      for (const version of role.versions) {
        acc[version.status] += 1;
      }
      return acc;
    },
    {
      candidate: 0,
      active: 0,
      archived: 0,
    }
  );

  return {
    enabled: state.enabled,
    role_count: roles.length,
    active_role_count: roles.filter((role) => role.active_version_id !== null).length,
    version_count: roles.reduce((sum, role) => sum + role.versions.length, 0),
    active_version_count: roles.reduce(
      (sum, role) => sum + role.versions.filter((version) => version.status === "active").length,
      0
    ),
    status_counts: statusCounts,
    roles: roles.map((role) => ({
      role_id: role.role_id,
      title: role.title,
      lane: role.lane,
      version_count: role.versions.length,
      active_version_id: role.active_version_id,
    })),
  };
}

function summarizeAutonomyMaintain(state: AutonomyMaintainStateRecord | null): AutonomyMaintainSummary {
  if (!state) {
    return {
      enabled: false,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      eval_interval_seconds: 21600,
      last_run_at: null,
      last_run_age_seconds: null,
      stale: true,
      last_bootstrap_ready_at: null,
      last_goal_autorun_daemon_at: null,
      last_tmux_maintained_at: null,
      last_learning_review_at: null,
      last_learning_entry_count: 0,
      last_learning_active_agent_count: 0,
      last_eval_run_at: null,
      last_eval_score: null,
      eval_due: true,
      last_actions: [],
      last_attention: [],
      last_error: null,
    };
  }
  const lastRunAgeSeconds = ageSeconds(state.last_run_at);
  const lastEvalAgeSeconds = ageSeconds(state.last_eval_run_at);
  const stale = lastRunAgeSeconds === null ? true : lastRunAgeSeconds > Math.max(state.interval_seconds * 3, 300);
  return {
    enabled: state.enabled,
    interval_seconds: state.interval_seconds,
    learning_review_interval_seconds: state.learning_review_interval_seconds,
    eval_interval_seconds: state.eval_interval_seconds,
    last_run_at: state.last_run_at,
    last_run_age_seconds: lastRunAgeSeconds,
    stale,
    last_bootstrap_ready_at: state.last_bootstrap_ready_at,
    last_goal_autorun_daemon_at: state.last_goal_autorun_daemon_at,
    last_tmux_maintained_at: state.last_tmux_maintained_at,
    last_learning_review_at: state.last_learning_review_at,
    last_learning_entry_count: state.last_learning_entry_count,
    last_learning_active_agent_count: state.last_learning_active_agent_count,
    last_eval_run_at: state.last_eval_run_at,
    last_eval_score: state.last_eval_score,
    eval_due: lastEvalAgeSeconds === null ? true : lastEvalAgeSeconds > state.eval_interval_seconds,
    last_actions: state.last_actions,
    last_attention: state.last_attention,
    last_error: state.last_error,
  };
}

function deriveKernelState(params: {
  failed_goal_count: number;
  failed_task_count: number;
  failed_experiment_count: number;
  blocked_approval_count: number;
  blocked_human_count: number;
  methodology_entry_hold_count: number;
  ready_step_count: number;
  running_step_count: number;
  pending_task_count: number;
  active_session_count: number;
}) {
  if (params.failed_goal_count > 0 || params.failed_task_count > 0 || params.failed_experiment_count > 0) {
    return "degraded";
  }
  if (params.blocked_approval_count > 0 || params.methodology_entry_hold_count > 0) {
    return "blocked";
  }
  if (params.active_session_count === 0 && (params.ready_step_count > 0 || params.pending_task_count > 0)) {
    return "degraded";
  }
  if (params.running_step_count > 0 || params.ready_step_count > 0 || params.pending_task_count > 0) {
    return "active";
  }
  return "idle";
}

function taskFailuresAreStale(taskSummary: TaskSummaryRecord): boolean {
  if ((taskSummary.counts.failed ?? 0) === 0 || !taskSummary.last_failed || !taskSummary.last_completed) {
    return false;
  }
  return taskSummary.last_completed.updated_at > taskSummary.last_failed.updated_at;
}

function taskFailuresRecoveredByActiveSessions(
  taskSummary: TaskSummaryRecord,
  activeSessions: AgentSessionRecord[]
): boolean {
  if ((taskSummary.counts.failed ?? 0) === 0 || !taskSummary.last_failed) {
    return false;
  }
  const failedAtMs = Date.parse(taskSummary.last_failed.updated_at);
  if (Number.isNaN(failedAtMs)) {
    return false;
  }
  return activeSessions.some((session) => {
    const adaptive = summarizeAdaptiveSessionHealth(session);
    if (adaptive.adaptive_state !== "healthy") {
      return false;
    }
    const profile = getAdaptiveWorkerProfile(session);
    const recoveredAtMs = profile.last_completed_at ? Date.parse(profile.last_completed_at) : Number.NaN;
    if (Number.isNaN(recoveredAtMs) || recoveredAtMs <= failedAtMs) {
      return false;
    }
    return adaptive.performance.low.recovery_streak >= Math.max(4, Math.min(8, profile.total_failed * 2));
  });
}

export function kernelSummary(storage: Storage, input: z.infer<typeof kernelSummarySchema>) {
  const goalLimit = input.goal_limit ?? 10;
  const sessionLimit = input.session_limit ?? 20;
  const experimentLimit = input.experiment_limit ?? 10;
  const artifactLimit = input.artifact_limit ?? 10;
  const eventLimit = input.event_limit ?? 20;

  const openGoals = listOpenGoals(storage, goalLimit);
  const goalCounts = countByStatus(
    ["draft", "active", "waiting", "blocked", "completed", "failed", "cancelled", "archived"].flatMap((status) =>
      storage.listGoals({ status: status as z.infer<typeof goalStatusSchema>, limit: 500 })
    )
  );
  const taskSummary = storage.getTaskSummary({
    running_limit: input.task_running_limit ?? 10,
  });
  const activeSessions = storage.listAgentSessions({
    active_only: true,
    limit: sessionLimit,
  });
  const adaptiveSessions = activeSessions.map((session) => summarizeAdaptiveSession(session));
  const experiments = storage.listExperiments({
    limit: experimentLimit,
  });
  const experimentCounts = countByStatus(storage.listExperiments({ limit: 500 }));
  const recentArtifacts = storage.listArtifacts({
    limit: artifactLimit,
  });
  const workerFabricSummary = summarizeWorkerFabric(storage);
  const modelRouterSummary = summarizeModelRouter(storage);
  const evalSummary = summarizeEvalSuites(storage);
  const orgProgramSummary = summarizeOrgPrograms(storage);
  const autonomyMaintainSummary = summarizeAutonomyMaintain(storage.getAutonomyMaintainState());
  const goalSummaries = openGoals.map((goal) => {
    const plan = resolveGoalPlan(storage, goal);
    const steps = plan ? storage.listPlanSteps(plan.plan_id) : [];
    const recovery = plan ? summarizeWorkerPoolRecoveryState(plan, activeSessions) : null;
    const methodologyEntryHold = !plan ? summarizeMethodologyEntryHoldState(goal, activeSessions) : null;
    const executionSummary = summarizeGoalExecution(plan, steps);
    executionSummary.worker_pool_pause_reason = recovery?.pause_reason ?? null;
    executionSummary.worker_pool_recovery_state = recovery?.state ?? "none";
    executionSummary.worker_pool_recovery_suppressed_count = recovery?.suppression_count ?? 0;
    executionSummary.current_worker_pool_fingerprint = recovery?.current_pool_fingerprint ?? null;
    executionSummary.last_attempted_worker_pool_fingerprint = recovery?.last_attempted_pool_fingerprint ?? null;
    if (executionSummary.worker_pool_paused) {
      executionSummary.next_action =
        recovery?.state === "ready_for_recovery"
          ? "Healthier worker lanes are available; goal.execute or goal.autorun can retry recovery now."
          : recovery?.state === "awaiting_pool_change"
            ? "Execution is paused until the live worker pool changes meaningfully."
            : "Execution is paused until healthier worker lanes are available or a safer plan is selected.";
    } else if (methodologyEntryHold?.held) {
      executionSummary.methodology_entry_held = true;
      executionSummary.methodology_entry_hold_state = methodologyEntryHold.state;
      executionSummary.methodology_entry_hold_reason = methodologyEntryHold.reason;
      executionSummary.methodology_entry_hold_count = methodologyEntryHold.count;
      executionSummary.current_worker_pool_fingerprint = methodologyEntryHold.current_pool_fingerprint;
      executionSummary.next_action =
        methodologyEntryHold.state === "ready_for_recovery"
          ? "A viable worker lane is now available; goal.execute or goal.autorun can retry plan generation."
          : "Plan generation is being held until a viable worker lane appears.";
    }
    const adaptiveRoutingSummary = summarizePlanAdaptiveRouting(steps);
    return {
      goal_id: goal.goal_id,
      title: goal.title,
      status: goal.status,
      autonomy_mode: goal.autonomy_mode,
      risk_tier: goal.risk_tier,
      updated_at: goal.updated_at,
      tags: goal.tags,
      execution_summary: executionSummary,
      adaptive_routing_summary: adaptiveRoutingSummary,
    };
  });

  const totals = goalSummaries.reduce(
    (acc, summary) => {
      acc.ready_step_count += summary.execution_summary.ready_count;
      acc.running_step_count += summary.execution_summary.running_count;
      acc.blocked_approval_count += summary.execution_summary.blocked_approval_count;
      acc.blocked_human_count += summary.execution_summary.blocked_human_count;
      acc.failed_step_count += summary.execution_summary.failed_count;
      acc.worker_pool_paused_count += summary.execution_summary.worker_pool_paused ? 1 : 0;
      acc.worker_pool_recovery_ready_count += summary.execution_summary.worker_pool_recovery_state === "ready_for_recovery" ? 1 : 0;
      acc.worker_pool_recovery_waiting_count +=
        summary.execution_summary.worker_pool_recovery_state === "awaiting_pool_change" ? 1 : 0;
      acc.worker_pool_no_viable_pool_count +=
        summary.execution_summary.worker_pool_recovery_state === "no_viable_pool" ? 1 : 0;
      acc.methodology_entry_hold_count += summary.execution_summary.methodology_entry_held ? 1 : 0;
      acc.methodology_entry_recovery_ready_count +=
        summary.execution_summary.methodology_entry_hold_state === "ready_for_recovery" ? 1 : 0;
      acc.adaptive_preferred_pool_count += summary.adaptive_routing_summary.mode_counts.preferred_pool;
      acc.adaptive_fallback_degraded_count += summary.adaptive_routing_summary.mode_counts.fallback_degraded;
      acc.adaptive_none_count += summary.adaptive_routing_summary.mode_counts.none;
      return acc;
    },
    {
      ready_step_count: 0,
      running_step_count: 0,
      blocked_approval_count: 0,
      blocked_human_count: 0,
      failed_step_count: 0,
      worker_pool_paused_count: 0,
      worker_pool_recovery_ready_count: 0,
      worker_pool_recovery_waiting_count: 0,
      worker_pool_no_viable_pool_count: 0,
      methodology_entry_hold_count: 0,
      methodology_entry_recovery_ready_count: 0,
      adaptive_preferred_pool_count: 0,
      adaptive_fallback_degraded_count: 0,
      adaptive_none_count: 0,
    }
  );
  const taskFailuresRecovered = taskFailuresRecoveredByActiveSessions(taskSummary, activeSessions);
  const staleTaskFailures = taskFailuresAreStale(taskSummary) || taskFailuresRecovered;

  const state = deriveKernelState({
    failed_goal_count: goalCounts.failed ?? 0,
    failed_task_count: staleTaskFailures ? 0 : taskSummary.counts.failed ?? 0,
    failed_experiment_count: experimentCounts.failed ?? 0,
    blocked_approval_count: totals.blocked_approval_count,
    blocked_human_count: totals.blocked_human_count,
    methodology_entry_hold_count: totals.methodology_entry_hold_count,
    ready_step_count: totals.ready_step_count,
    running_step_count: totals.running_step_count,
    pending_task_count: taskSummary.counts.pending ?? 0,
    active_session_count: activeSessions.length,
  });

  const attention: string[] = [];
  const adaptiveSessionCounts = adaptiveSessions.reduce<Record<AdaptiveSessionState, number>>(
    (acc, session) => {
      acc[session.adaptive_state] += 1;
      return acc;
    },
    {
      unproven: 0,
      healthy: 0,
      degraded: 0,
      suppressed: 0,
    }
  );
  const learningOverview = buildAgentLearningOverview(storage, {
    limit: 250,
    top_agents_limit: 6,
    recent_limit: 6,
  });
  const activeLearningEntries = storage.listAgentLearningEntries({
    status: "active",
    limit: 250,
  });
  const recentEvents = storage.listRuntimeEvents({
    limit: eventLimit,
    since: input.event_since,
  });
  const eventSummary = storage.summarizeRuntimeEvents({
    since: input.event_since,
  });
  const activeLearningAgents = new Set(activeLearningEntries.map((entry) => entry.agent_id));
  const activeSessionAgentIds = [...new Set(activeSessions.map((session) => session.agent_id))];
  const uncoveredActiveSessionAgents = activeSessionAgentIds
    .filter((agentId) => !activeLearningAgents.has(agentId))
    .sort((left, right) => left.localeCompare(right));
  const activeSessionLearningCoverageCount = activeSessionAgentIds.length - uncoveredActiveSessionAgents.length;
  if ((taskSummary.counts.failed ?? 0) > 0 && taskSummary.last_failed) {
    attention.push(
      taskFailuresRecovered
        ? `Recovered failed task remains in history: ${taskSummary.last_failed.task_id}`
        : staleTaskFailures
          ? `Stale failed task remains in history: ${taskSummary.last_failed.task_id}`
        : `Failed task detected: ${taskSummary.last_failed.task_id}`
    );
  }
  if (totals.blocked_approval_count > 0) {
    attention.push(
      totals.blocked_human_count === totals.blocked_approval_count
        ? `Human approval is blocking ${totals.blocked_human_count} plan step(s).`
        : `Approval gates are blocking ${totals.blocked_approval_count} plan step(s).`
    );
  }
  if (totals.worker_pool_paused_count > 0) {
    attention.push(`Worker-pool risk is pausing ${totals.worker_pool_paused_count} open plan(s).`);
  }
  if (totals.worker_pool_recovery_ready_count > 0) {
    attention.push(
      `${totals.worker_pool_recovery_ready_count} paused plan(s) can recover immediately because a healthier worker pool is available.`
    );
  }
  if (totals.worker_pool_recovery_waiting_count > 0) {
    attention.push(
      `${totals.worker_pool_recovery_waiting_count} paused plan(s) are suppressed until the live worker pool changes.`
    );
  }
  if (totals.worker_pool_no_viable_pool_count > 0) {
    attention.push(
      `${totals.worker_pool_no_viable_pool_count} paused plan(s) still have no viable healthy or unproven worker pool.`
    );
  }
  if (totals.methodology_entry_hold_count > 0) {
    attention.push(
      `${totals.methodology_entry_hold_count} goal(s) are being held before plan generation because no viable worker lane exists.`
    );
  }
  if (totals.methodology_entry_recovery_ready_count > 0) {
    attention.push(
      `${totals.methodology_entry_recovery_ready_count} pre-generation hold(s) can recover immediately because a viable worker lane is now available.`
    );
  }
  if (activeSessions.length === 0 && ((taskSummary.counts.pending ?? 0) > 0 || totals.ready_step_count > 0)) {
    attention.push("Work is queued or ready, but no active agent sessions are available to claim it.");
  }
  if (adaptiveSessionCounts.suppressed > 0) {
    attention.push(`Adaptive routing is suppressing ${adaptiveSessionCounts.suppressed} active session(s).`);
  }
  if (adaptiveSessionCounts.degraded > 0) {
    attention.push(`Adaptive routing marks ${adaptiveSessionCounts.degraded} active session(s) as degraded.`);
  }
  if (activeSessions.length > 0 && learningOverview.active_entry_count === 0) {
    attention.push("Active agent sessions have not yet accumulated any bounded learning entries.");
  } else if (uncoveredActiveSessionAgents.length > 0) {
    attention.push(
      `Active learning coverage is still missing for ${uncoveredActiveSessionAgents.length} live agent session(s): ${uncoveredActiveSessionAgents
        .slice(0, 4)
        .join(", ")}${uncoveredActiveSessionAgents.length > 4 ? ", ..." : ""}.`
    );
  }
  if (
    adaptiveSessionCounts.healthy === 0 &&
    activeSessions.length > 0 &&
    ((taskSummary.counts.pending ?? 0) > 0 || totals.ready_step_count > 0)
  ) {
    attention.push("Queued work may stall because no active session is currently marked healthy by adaptive routing.");
  }
  if (totals.adaptive_fallback_degraded_count > 0) {
    attention.push(
      `Open plans still rely on degraded fallback routing for ${totals.adaptive_fallback_degraded_count} worker step(s).`
    );
  }
  if (totals.adaptive_none_count > 0) {
    attention.push(
      `Open plans contain ${totals.adaptive_none_count} worker step(s) with no dispatchable adaptive lane guidance.`
    );
  }
  if (workerFabricSummary.host_count === 0) {
    attention.push("No worker fabric hosts are configured yet.");
  } else if (workerFabricSummary.enabled_host_count === 0) {
    attention.push("Worker fabric hosts exist, but none are enabled.");
  } else if (workerFabricSummary.health_counts.healthy === 0 && workerFabricSummary.host_count > 0) {
    attention.push("Worker fabric has no healthy hosts available.");
  }
  if (modelRouterSummary.backend_count === 0) {
    attention.push("No model router backends are configured yet.");
  } else if (modelRouterSummary.enabled_backend_count === 0) {
    attention.push("Model router backends exist, but none are enabled.");
  }
  if (evalSummary.suite_count === 0) {
    attention.push("No eval suites are configured yet.");
  }
  if (orgProgramSummary.role_count === 0) {
    attention.push("No org-program roles are configured yet.");
  } else if (orgProgramSummary.active_version_count === 0) {
    attention.push("Org-program roles exist, but none have an active version yet.");
  }
  if (!autonomyMaintainSummary.enabled) {
    attention.push("Background autonomy maintenance has not persisted an enabled state yet.");
  } else if (autonomyMaintainSummary.stale) {
    attention.push("Background autonomy maintenance is stale and may no longer be refreshing readiness automatically.");
  } else if (autonomyMaintainSummary.eval_due) {
    attention.push("Background autonomy maintenance is ready for its next eval health refresh.");
  }
  if (autonomyMaintainSummary.last_attention.length > 0) {
    attention.push(
      `Background autonomy maintenance last reported attention: ${autonomyMaintainSummary.last_attention.slice(0, 3).join(", ")}.`
    );
  }
  if (attention.length === 0 && state === "active") {
    attention.push("Kernel is progressing normally.");
  }
  if (attention.length === 0 && state === "idle") {
    attention.push("No actionable work is currently queued.");
  }

  return {
    snapshot_at: new Date().toISOString(),
    state,
    attention,
    overview: {
      goal_counts: goalCounts,
      task_counts: taskSummary.counts,
      experiment_counts: experimentCounts,
      active_session_count: activeSessions.length,
      adaptive_session_counts: adaptiveSessionCounts,
      adaptive_plan_routing_counts: {
        preferred_pool: totals.adaptive_preferred_pool_count,
        fallback_degraded: totals.adaptive_fallback_degraded_count,
        none: totals.adaptive_none_count,
      },
      worker_fabric: {
        host_count: workerFabricSummary.host_count,
        enabled_host_count: workerFabricSummary.enabled_host_count,
        healthy_host_count: workerFabricSummary.health_counts.healthy,
        degraded_host_count: workerFabricSummary.health_counts.degraded,
        offline_host_count: workerFabricSummary.health_counts.offline,
        worker_count: workerFabricSummary.worker_count,
        active_worker_count: workerFabricSummary.active_worker_count,
      },
      model_router: {
        backend_count: modelRouterSummary.backend_count,
        enabled_backend_count: modelRouterSummary.enabled_backend_count,
        provider_counts: modelRouterSummary.provider_counts,
      },
      eval_suites: {
        suite_count: evalSummary.suite_count,
        total_case_count: evalSummary.total_case_count,
        benchmark_case_count: evalSummary.benchmark_case_count,
        router_case_count: evalSummary.router_case_count,
      },
      org_programs: {
        role_count: orgProgramSummary.role_count,
        active_role_count: orgProgramSummary.active_role_count,
        version_count: orgProgramSummary.version_count,
        active_version_count: orgProgramSummary.active_version_count,
      },
      autonomy_maintain: {
        enabled: autonomyMaintainSummary.enabled,
        stale: autonomyMaintainSummary.stale,
        last_run_age_seconds: autonomyMaintainSummary.last_run_age_seconds,
        eval_due: autonomyMaintainSummary.eval_due,
        last_eval_score: autonomyMaintainSummary.last_eval_score,
      },
      ready_step_count: totals.ready_step_count,
      running_step_count: totals.running_step_count,
      blocked_approval_count: totals.blocked_approval_count,
      blocked_human_count: totals.blocked_human_count,
      worker_pool_paused_count: totals.worker_pool_paused_count,
      worker_pool_recovery_ready_count: totals.worker_pool_recovery_ready_count,
      worker_pool_recovery_waiting_count: totals.worker_pool_recovery_waiting_count,
      worker_pool_no_viable_pool_count: totals.worker_pool_no_viable_pool_count,
      methodology_entry_hold_count: totals.methodology_entry_hold_count,
      methodology_entry_recovery_ready_count: totals.methodology_entry_recovery_ready_count,
      failed_step_count: totals.failed_step_count,
      learning_entry_count: learningOverview.total_entries,
      active_learning_entry_count: learningOverview.active_entry_count,
      learning_agent_count: learningOverview.agent_count,
      active_session_learning_coverage_count: activeSessionLearningCoverageCount,
    },
    open_goals: goalSummaries,
    active_sessions: activeSessions,
    adaptive_sessions: adaptiveSessions,
    worker_fabric: workerFabricSummary,
    model_router: modelRouterSummary,
    evals: evalSummary,
    org_programs: orgProgramSummary,
    autonomy_maintain: autonomyMaintainSummary,
    learning: {
      ...learningOverview,
      active_session_coverage: {
        active_session_agent_count: activeSessionAgentIds.length,
        covered_agent_count: activeSessionLearningCoverageCount,
        uncovered_agent_count: uncoveredActiveSessionAgents.length,
        uncovered_agent_ids: uncoveredActiveSessionAgents,
      },
    },
    tasks: taskSummary,
    experiments,
    recent_artifacts: recentArtifacts,
    recent_events: recentEvents,
    event_summary: eventSummary,
  };
}
