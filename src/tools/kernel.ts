import { z } from "zod";
import { type AgentSessionRecord, type GoalRecord, type PlanRecord, type PlanStepRecord, Storage } from "../storage.js";
import { getAdaptiveWorkerProfile, summarizeAdaptiveSessionHealth, summarizeAdaptiveWorkerProfile } from "./agent_session.js";
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

function countByStatus<T extends { status: string }>(records: T[]) {
  return records.reduce<Record<string, number>>((acc, record) => {
    acc[record.status] = (acc[record.status] ?? 0) + 1;
    return acc;
  }, {});
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

  let nextAction = "Plan is idle.";
  if (plan.status === "completed") {
    nextAction = "Plan completed; review artifacts and close the goal if acceptance criteria are satisfied.";
  } else if (failedCount > 0) {
    nextAction = "Inspect failed steps and retry or resume only after the blocking issue is fixed.";
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

function deriveKernelState(params: {
  failed_goal_count: number;
  failed_task_count: number;
  failed_experiment_count: number;
  blocked_approval_count: number;
  blocked_human_count: number;
  ready_step_count: number;
  running_step_count: number;
  pending_task_count: number;
  active_session_count: number;
}) {
  if (params.failed_goal_count > 0 || params.failed_task_count > 0 || params.failed_experiment_count > 0) {
    return "degraded";
  }
  if (params.blocked_approval_count > 0) {
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
  const recentEvents = storage.listRuntimeEvents({
    limit: eventLimit,
    since: input.event_since,
  });
  const eventSummary = storage.summarizeRuntimeEvents({
    since: input.event_since,
  });

  const goalSummaries = openGoals.map((goal) => {
    const plan = resolveGoalPlan(storage, goal);
    const steps = plan ? storage.listPlanSteps(plan.plan_id) : [];
    const executionSummary = summarizeGoalExecution(plan, steps);
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
      adaptive_preferred_pool_count: 0,
      adaptive_fallback_degraded_count: 0,
      adaptive_none_count: 0,
    }
  );

  const state = deriveKernelState({
    failed_goal_count: goalCounts.failed ?? 0,
    failed_task_count: taskSummary.counts.failed ?? 0,
    failed_experiment_count: experimentCounts.failed ?? 0,
    blocked_approval_count: totals.blocked_approval_count,
    blocked_human_count: totals.blocked_human_count,
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
  if ((taskSummary.counts.failed ?? 0) > 0 && taskSummary.last_failed) {
    attention.push(`Failed task detected: ${taskSummary.last_failed.task_id}`);
  }
  if (totals.blocked_approval_count > 0) {
    attention.push(
      totals.blocked_human_count === totals.blocked_approval_count
        ? `Human approval is blocking ${totals.blocked_human_count} plan step(s).`
        : `Approval gates are blocking ${totals.blocked_approval_count} plan step(s).`
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
      ready_step_count: totals.ready_step_count,
      running_step_count: totals.running_step_count,
      blocked_approval_count: totals.blocked_approval_count,
      blocked_human_count: totals.blocked_human_count,
      failed_step_count: totals.failed_step_count,
    },
    open_goals: goalSummaries,
    active_sessions: activeSessions,
    adaptive_sessions: adaptiveSessions,
    tasks: taskSummary,
    experiments,
    recent_artifacts: recentArtifacts,
    recent_events: recentEvents,
    event_summary: eventSummary,
  };
}
