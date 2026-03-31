import { z } from "zod";
import {
  type AutonomyMaintainStateRecord,
  type AgentSessionRecord,
  type ClusterTopologyStateRecord,
  type EvalSuiteRecord,
  type EvalSuitesStateRecord,
  type GoalRecord,
  type ModelRouterBackendRecord,
  type ModelRouterStateRecord,
  type ObservabilityDocumentRecord,
  type OrgProgramRoleRecord,
  type OrgProgramsStateRecord,
  type PlanRecord,
  type PlanStepRecord,
  type ReactionEngineStateRecord,
  type TaskSummaryRecord,
  type WorkerFabricHostRecord,
  type WorkerFabricStateRecord,
  Storage,
} from "../storage.js";
import { getAdaptiveWorkerProfile, summarizeAdaptiveSessionHealth, summarizeAdaptiveWorkerProfile } from "./agent_session.js";
import { buildAgentLearningOverview } from "./agent_learning.js";
import { buildEvalHealth, computeEvalDependencyFingerprint, getAutonomyMaintainRuntimeStatus } from "./autonomy_maintain.js";
import { getAutoSnapshotRuntimeStatus } from "./imprint.js";
import { isBenignObservabilityDocument } from "./observability.js";
import { getReactionEngineRuntimeStatus } from "./reaction_engine.js";
import { summarizeLiveRuntimeWorkers } from "./runtime_worker.js";
import { getAutoSquishRuntimeStatus } from "./transcript.js";
import { getTriChatAutoRetentionRuntimeStatus, getTriChatTurnWatchdogRuntimeStatus } from "./trichat.js";
import { summarizeClusterTopologyState } from "./cluster_topology.js";
import { routeModelBackends } from "./model_router.js";
import { evaluatePlanStepReadiness, getPlanStepApprovalGateKind } from "./plan.js";
import { computeHostHealthScore, resolveEffectiveWorkerFabric, resolveHostCapacityProfile } from "./worker_fabric.js";

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
    cpu_utilization: number | null;
    ram_available_gb: number | null;
    ram_total_gb: number | null;
    swap_used_gb: number | null;
    thermal_pressure: WorkerFabricHostRecord["telemetry"]["thermal_pressure"];
    recommended_worker_count: number | null;
    safe_max_queue_per_worker: number | null;
    max_local_model_concurrency: number | null;
    recommended_runtime_worker_max_active: number | null;
    recommended_runtime_worker_limit: number | null;
    recommended_tmux_worker_count: number | null;
    recommended_tmux_target_queue_per_worker: number | null;
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
  routing_outlook: Array<{
    task_kind: "planning" | "coding" | "research" | "verification";
    preferred_tags: string[];
    selected_backend_id: string | null;
    selected_provider: ModelRouterBackendRecord["provider"] | null;
    selected_host_id: string | null;
    selected_locality: ModelRouterBackendRecord["locality"] | null;
    selected_score: number | null;
    planned_backend_count: number;
    top_planned_backend_id: string | null;
    top_planned_provider: string | null;
    top_planned_node_id: string | null;
    top_planned_node_title: string | null;
    top_planned_score: number | null;
  }>;
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
    probe_healthy: boolean | null;
    probe_model_known: boolean | null;
    probe_model_loaded: boolean | null;
    probe_generated_at: string | null;
    probe_service_latency_ms: number | null;
    probe_benchmark_latency_ms: number | null;
    probe_resident_model_count: number | null;
    probe_resident_vram_gb: number | null;
    probe_resident_expires_at: string | null;
    probe_error: string | null;
    tags: string[];
  }>;
};

function routingOutlookPreferredTags(taskKind: "planning" | "coding" | "research" | "verification") {
  switch (taskKind) {
    case "planning":
      return ["planning", "planner", "control-plane"];
    case "coding":
      return ["coding", "implementer", "gpu"];
    case "research":
      return ["research", "analysis", "gpu"];
    case "verification":
      return ["verification", "verify", "control-plane"];
    default:
      return [taskKind];
  }
}

type ClusterTopologySummary = ReturnType<typeof summarizeClusterTopologyState>;

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

type ObservabilitySummary = {
  document_count: number;
  latest_document_at: string | null;
  recent_error_count: number;
  recent_critical_count: number;
  index_name_counts: Array<{
    index_name: string;
    count: number;
  }>;
  source_kind_counts: Array<{
    source_kind: string;
    count: number;
  }>;
  service_counts: Array<{
    service: string | null;
    count: number;
  }>;
  host_counts: Array<{
    host_id: string | null;
    count: number;
  }>;
  recent_documents: ObservabilityDocumentRecord[];
};

type OrgProgramSummary = {
  enabled: boolean;
  role_count: number;
  active_role_count: number;
  version_count: number;
  active_version_count: number;
  candidate_version_count: number;
  optimized_role_count: number;
  last_optimizer_run_at: string | null;
  status_counts: Record<"candidate" | "active" | "archived", number>;
  roles: Array<{
    role_id: string;
    title: string;
    lane: string | null;
    version_count: number;
    active_version_id: string | null;
    candidate_version_count: number;
    last_optimizer_run_at: string | null;
    last_optimizer_improvement: number | null;
  }>;
};

type WorkflowExportSummary = {
  bundle_count: number;
  metrics_count: number;
  argo_contract_count: number;
  latest_bundle: {
    artifact_id: string;
    created_at: string;
    goal_id: string | null;
    plan_id: string | null;
    uri: string | null;
    export_id: string | null;
    step_count: number;
    task_count: number;
    run_count: number;
    bundle_sha256: string | null;
  } | null;
  latest_metrics: {
    artifact_id: string;
    created_at: string;
    uri: string | null;
    export_id: string | null;
    line_count: number;
  } | null;
  latest_argo_contract: {
    artifact_id: string;
    created_at: string;
    uri: string | null;
    export_id: string | null;
    contract_mode: string | null;
  } | null;
};

type RuntimeWorkerSummary = {
  session_count: number;
  active_count: number;
  counts: Record<"launching" | "running" | "idle" | "completed" | "failed" | "stopped", number>;
  runtime_counts: Record<string, number>;
  latest_session: {
    session_id: string;
    runtime_id: string;
    status: string;
    task_id: string | null;
    worktree_path: string;
    updated_at: string;
    last_error: string | null;
  } | null;
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
  eval_health: {
    suite_id: string;
    minimum_eval_score: number;
    below_threshold: boolean;
    never_run: boolean;
    healthy: boolean;
  };
  current_attention: string[];
  last_actions: string[];
  last_attention: string[];
  last_error: string | null;
  degraded_subsystem_count: number;
  running_subsystem_count: number;
  subsystems: Record<
    "transcript_auto_squish" | "imprint_auto_snapshot" | "trichat_auto_retention" | "trichat_turn_watchdog",
    {
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
    }
  >;
  runtime: {
    running: boolean;
    in_tick: boolean;
    started_at: string | null;
    last_tick_at: string | null;
    last_error: string | null;
    tick_count: number;
    config: Record<string, unknown>;
  };
};

type ReactionEngineSummary = {
  enabled: boolean;
  interval_seconds: number;
  dedupe_window_seconds: number;
  channels: string[];
  last_run_at: string | null;
  last_run_age_seconds: number | null;
  stale: boolean;
  last_sent_at: string | null;
  last_sent_count: number;
  recent_notifications: Array<{
    key: string;
    title: string;
    level: "info" | "warn" | "critical";
    sent_at: string;
  }>;
  last_error: string | null;
  runtime: {
    running: boolean;
    in_tick: boolean;
    started_at: string | null;
    last_tick_at: string | null;
    last_error: string | null;
    tick_count: number;
    config: Record<string, unknown>;
  };
};

type SwarmCoordinationSummary = {
  active_profile_count: number;
  checkpoint_artifact_count: number;
  topology_counts: Record<"hierarchical" | "mesh" | "ring" | "star" | "adaptive", number>;
  consensus_counts: Record<"majority" | "weighted" | "escalating", number>;
  active_profiles: Array<{
    goal_id: string;
    title: string;
    plan_id: string | null;
    topology: string | null;
    consensus_mode: string | null;
    queen_mode: string | null;
    execution_mode: string | null;
    checkpoint_cadence: string | null;
    checkpoint_count: number;
    last_checkpoint_at: string | null;
    memory_match_count: number;
  }>;
  recent_checkpoints: Array<{
    artifact_id: string;
    goal_id: string | null;
    plan_id: string | null;
    created_at: string;
    phase: string | null;
    topology: string | null;
  }>;
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

function summarizeSwarmCoordination(storage: Storage, openGoals: GoalRecord[]): SwarmCoordinationSummary {
  const checkpoints = storage.listArtifacts({
    artifact_type: "swarm.checkpoint",
    limit: 50,
  });
  const activeProfiles = openGoals
    .map((goal) => {
      const plan = resolveGoalPlan(storage, goal);
      const profile =
        (isRecord(plan?.metadata?.swarm_profile) ? plan?.metadata?.swarm_profile : null) ??
        (isRecord(goal.metadata?.swarm_profile) ? goal.metadata?.swarm_profile : null);
      if (!isRecord(profile)) {
        return null;
      }
      const memoryPreflight =
        (isRecord(plan?.metadata?.memory_preflight) ? plan?.metadata?.memory_preflight : null) ??
        (isRecord(goal.metadata?.memory_preflight) ? goal.metadata?.memory_preflight : null);
      const relatedCheckpoints = checkpoints.filter(
        (artifact) => artifact.goal_id === goal.goal_id || (plan && artifact.plan_id === plan.plan_id)
      );
      const lastCheckpointAt =
        relatedCheckpoints
          .map((artifact) => artifact.created_at)
          .sort((left, right) => right.localeCompare(left))[0] ?? null;
      return {
        goal_id: goal.goal_id,
        title: goal.title,
        plan_id: plan?.plan_id ?? null,
        topology: readString(profile.topology),
        consensus_mode: readString(profile.consensus_mode),
        queen_mode: readString(profile.queen_mode),
        execution_mode: readString(profile.execution_mode),
        checkpoint_cadence: readString(isRecord(profile.checkpoint_policy) ? profile.checkpoint_policy.cadence : null),
        checkpoint_count: relatedCheckpoints.length,
        last_checkpoint_at: lastCheckpointAt,
        memory_match_count:
          typeof memoryPreflight?.match_count === "number" && Number.isFinite(memoryPreflight.match_count)
            ? Math.max(0, Math.round(memoryPreflight.match_count))
            : 0,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const topologyCounts = activeProfiles.reduce<SwarmCoordinationSummary["topology_counts"]>(
    (acc, entry) => {
      if (entry.topology === "hierarchical" || entry.topology === "mesh" || entry.topology === "ring" || entry.topology === "star" || entry.topology === "adaptive") {
        acc[entry.topology] += 1;
      }
      return acc;
    },
    {
      hierarchical: 0,
      mesh: 0,
      ring: 0,
      star: 0,
      adaptive: 0,
    }
  );
  const consensusCounts = activeProfiles.reduce<SwarmCoordinationSummary["consensus_counts"]>(
    (acc, entry) => {
      if (entry.consensus_mode === "majority" || entry.consensus_mode === "weighted" || entry.consensus_mode === "escalating") {
        acc[entry.consensus_mode] += 1;
      }
      return acc;
    },
    {
      majority: 0,
      weighted: 0,
      escalating: 0,
    }
  );
  return {
    active_profile_count: activeProfiles.length,
    checkpoint_artifact_count: checkpoints.length,
    topology_counts: topologyCounts,
    consensus_counts: consensusCounts,
    active_profiles: activeProfiles,
    recent_checkpoints: checkpoints.slice(0, 8).map((artifact) => {
      const content = isRecord(artifact.content_json) ? artifact.content_json : {};
      const profile = isRecord(content.profile) ? content.profile : {};
      return {
        artifact_id: artifact.artifact_id,
        goal_id: artifact.goal_id,
        plan_id: artifact.plan_id,
        created_at: artifact.created_at,
        phase: readString(content.phase),
        topology: readString(profile.topology),
      };
    }),
  };
}

function summarizeWorkflowExports(storage: Storage): WorkflowExportSummary {
  const bundles = storage.listArtifacts({
    artifact_type: "workflow.bundle",
    limit: 25,
  });
  const metrics = storage.listArtifacts({
    artifact_type: "workflow.metrics_jsonl",
    limit: 25,
  });
  const argoContracts = storage.listArtifacts({
    artifact_type: "workflow.argo_contract",
    limit: 25,
  });
  const latestBundle = bundles[0] ?? null;
  const latestMetrics = metrics[0] ?? null;
  const latestArgoContract = argoContracts[0] ?? null;
  const latestBundleJson = isRecord(latestBundle?.content_json) ? latestBundle?.content_json : {};
  const latestMetricsJson = isRecord(latestMetrics?.content_json) ? latestMetrics?.content_json : {};
  const latestArgoJson = isRecord(latestArgoContract?.content_json) ? latestArgoContract?.content_json : {};

  return {
    bundle_count: bundles.length,
    metrics_count: metrics.length,
    argo_contract_count: argoContracts.length,
    latest_bundle: latestBundle
      ? {
          artifact_id: latestBundle.artifact_id,
          created_at: latestBundle.created_at,
          goal_id: latestBundle.goal_id,
          plan_id: latestBundle.plan_id,
          uri: latestBundle.uri,
          export_id: readString(latestBundle.metadata?.export_id),
          step_count: typeof latestBundleJson.step_count === "number" ? Math.max(0, Math.round(latestBundleJson.step_count)) : 0,
          task_count: typeof latestBundleJson.task_count === "number" ? Math.max(0, Math.round(latestBundleJson.task_count)) : 0,
          run_count: typeof latestBundleJson.run_count === "number" ? Math.max(0, Math.round(latestBundleJson.run_count)) : 0,
          bundle_sha256: readString(latestBundleJson.bundle_sha256) ?? latestBundle.hash,
        }
      : null,
    latest_metrics: latestMetrics
      ? {
          artifact_id: latestMetrics.artifact_id,
          created_at: latestMetrics.created_at,
          uri: latestMetrics.uri,
          export_id: readString(latestMetrics.metadata?.export_id),
          line_count: typeof latestMetricsJson.line_count === "number" ? Math.max(0, Math.round(latestMetricsJson.line_count)) : 0,
        }
      : null,
    latest_argo_contract: latestArgoContract
      ? {
          artifact_id: latestArgoContract.artifact_id,
          created_at: latestArgoContract.created_at,
          uri: latestArgoContract.uri,
          export_id: readString(latestArgoContract.metadata?.export_id),
          contract_mode: readString(latestArgoJson.contract_mode),
        }
      : null,
  };
}

function summarizeRuntimeWorkers(storage: Storage): RuntimeWorkerSummary {
  const live = summarizeLiveRuntimeWorkers(storage, 100);
  const latest = live.summary.latest_session;
  return {
    session_count: live.summary.session_count,
    active_count: live.summary.active_count,
    counts: live.summary.counts,
    runtime_counts: live.summary.runtime_counts,
    latest_session: latest
      ? {
          session_id: latest.session_id,
          runtime_id: latest.runtime_id,
          status: latest.status,
          task_id: latest.task_id,
          worktree_path: latest.worktree_path,
          updated_at: latest.updated_at,
          last_error: latest.last_error,
        }
      : null,
  };
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

function summarizeWorkerFabric(storage: Storage, state?: WorkerFabricStateRecord): HostFabricSummary {
  const persistedState = storage.getWorkerFabricState();
  const effectiveState =
    state ??
    resolveEffectiveWorkerFabric(storage, {
      fallback_workspace_root: process.cwd(),
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    });
  if (!persistedState && effectiveState.hosts.length === 0) {
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

  const hosts = [...effectiveState.hosts].sort((left, right) => left.host_id.localeCompare(right.host_id));
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
    enabled: effectiveState.enabled,
    strategy: effectiveState.strategy,
    default_host_id: effectiveState.default_host_id,
    host_count: hosts.length,
    enabled_host_count: enabledHosts.length,
    worker_count: hosts.reduce((sum, host) => sum + host.worker_count, 0),
    active_worker_count: enabledHosts.reduce((sum, host) => sum + host.worker_count, 0),
    health_counts: healthCounts,
    transport_counts: transportCounts,
    hosts: hosts.map((host) => ({
      ...resolveHostCapacityProfile(host),
      host_id: host.host_id,
      transport: host.transport,
      enabled: host.enabled,
      worker_count: host.worker_count,
      health_state: host.telemetry.health_state,
      health_score: computeHostHealthScore(host.telemetry),
      queue_depth: host.telemetry.queue_depth,
      active_tasks: host.telemetry.active_tasks,
      heartbeat_at: host.telemetry.heartbeat_at,
      cpu_utilization: host.telemetry.cpu_utilization,
      ram_available_gb: host.telemetry.ram_available_gb,
      ram_total_gb: host.telemetry.ram_total_gb,
      swap_used_gb: host.telemetry.swap_used_gb,
      thermal_pressure: host.telemetry.thermal_pressure,
      tags: host.tags,
    })),
  };
}

function summarizeModelRouter(storage: Storage, options?: { effective_worker_fabric?: WorkerFabricStateRecord }): ModelRouterSummary {
  const routingTaskKinds = ["planning", "coding", "research", "verification"] as const;
  const routingOutlook = routingTaskKinds.map((taskKind) => {
    const preferredTags = routingOutlookPreferredTags(taskKind);
    const route = routeModelBackends(storage, {
      task_kind: taskKind,
      preferred_tags: preferredTags,
      effective_worker_fabric: options?.effective_worker_fabric,
    });
    const topPlanned = route.planned_backends[0] ?? null;
    return {
      task_kind: taskKind,
      preferred_tags: preferredTags,
      selected_backend_id: route.selected_backend?.backend_id ?? null,
      selected_provider: route.selected_backend?.provider ?? null,
      selected_host_id: route.selected_backend?.host_id ?? null,
      selected_locality: route.selected_backend?.locality ?? null,
      selected_score: typeof route.ranked_backends[0]?.score === "number" ? route.ranked_backends[0].score : null,
      planned_backend_count: route.planned_backends.length,
      top_planned_backend_id: topPlanned?.backend_id ?? null,
      top_planned_provider: topPlanned?.provider ?? null,
      top_planned_node_id: topPlanned?.node_id ?? null,
      top_planned_node_title: topPlanned?.title ?? null,
      top_planned_score: typeof topPlanned?.score === "number" ? topPlanned.score : null,
    };
  });

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
      routing_outlook: routingOutlook,
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
    routing_outlook: routingOutlook,
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
      probe_healthy:
        typeof backend.capabilities?.probe_healthy === "boolean" ? Boolean(backend.capabilities.probe_healthy) : null,
      probe_model_known:
        typeof backend.capabilities?.probe_model_known === "boolean" ? Boolean(backend.capabilities.probe_model_known) : null,
      probe_model_loaded:
        typeof backend.capabilities?.probe_model_loaded === "boolean" ? Boolean(backend.capabilities.probe_model_loaded) : null,
      probe_generated_at:
        typeof backend.capabilities?.probe_generated_at === "string" ? String(backend.capabilities.probe_generated_at) : null,
      probe_service_latency_ms:
        typeof backend.capabilities?.probe_service_latency_ms === "number"
          ? Number(backend.capabilities.probe_service_latency_ms)
          : null,
      probe_benchmark_latency_ms:
        typeof backend.capabilities?.probe_benchmark_latency_ms === "number"
          ? Number(backend.capabilities.probe_benchmark_latency_ms)
          : null,
      probe_resident_model_count:
        typeof backend.capabilities?.probe_resident_model_count === "number"
          ? Number(backend.capabilities.probe_resident_model_count)
          : null,
      probe_resident_vram_gb:
        typeof backend.capabilities?.probe_resident_vram_gb === "number"
          ? Number(backend.capabilities.probe_resident_vram_gb)
          : null,
      probe_resident_expires_at:
        typeof backend.capabilities?.probe_resident_expires_at === "string"
          ? String(backend.capabilities.probe_resident_expires_at)
          : null,
      probe_error:
        typeof backend.capabilities?.probe_error === "string" && String(backend.capabilities.probe_error).trim().length > 0
          ? String(backend.capabilities.probe_error)
          : null,
      tags: backend.tags,
    })),
  };
}

function summarizeClusterTopology(storage: Storage): ClusterTopologySummary {
  const state: ClusterTopologyStateRecord | null = storage.getClusterTopologyState();
  return summarizeClusterTopologyState(
    state ?? {
      enabled: false,
      default_node_id: null,
      nodes: [],
      updated_at: new Date().toISOString(),
    }
  );
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

function summarizeObservability(storage: Storage): ObservabilitySummary {
  const summary = storage.summarizeObservabilityDocuments({});
  const recentWindow = new Date(Date.now() - 15 * 60_000).toISOString();
  const recentCritical = storage.listObservabilityDocuments({
    since: recentWindow,
    levels: ["critical"],
    limit: 10,
  });
  const recentErrors = storage.listObservabilityDocuments({
    since: recentWindow,
    levels: ["error"],
    limit: 20,
  });
  const actionableRecentCritical = recentCritical.filter((entry) => !isBenignObservabilityDocument(entry));
  const actionableRecentErrors = recentErrors.filter((entry) => !isBenignObservabilityDocument(entry));
  return {
    document_count: summary.count,
    latest_document_at: summary.latest_created_at,
    recent_error_count: actionableRecentErrors.length,
    recent_critical_count: actionableRecentCritical.length,
    index_name_counts: summary.index_name_counts.slice(0, 6),
    source_kind_counts: summary.source_kind_counts.slice(0, 6),
    service_counts: summary.service_counts.slice(0, 6),
    host_counts: summary.host_counts.slice(0, 6),
    recent_documents: storage.listObservabilityDocuments({
      since: recentWindow,
      limit: 6,
    }),
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
      candidate_version_count: 0,
      optimized_role_count: 0,
      last_optimizer_run_at: null,
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

  const optimizerRunAts = roles
    .map((role) => {
      const optimizer = role.metadata.optimizer && typeof role.metadata.optimizer === "object"
        ? (role.metadata.optimizer as Record<string, unknown>)
        : null;
      const lastRunAt = typeof optimizer?.last_run_at === "string" ? optimizer.last_run_at : null;
      return lastRunAt;
    })
    .filter((entry): entry is string => Boolean(entry))
    .sort((left, right) => right.localeCompare(left));

  return {
    enabled: state.enabled,
    role_count: roles.length,
    active_role_count: roles.filter((role) => role.active_version_id !== null).length,
    version_count: roles.reduce((sum, role) => sum + role.versions.length, 0),
    active_version_count: roles.reduce(
      (sum, role) => sum + role.versions.filter((version) => version.status === "active").length,
      0
    ),
    candidate_version_count: roles.reduce(
      (sum, role) => sum + role.versions.filter((version) => version.status === "candidate").length,
      0
    ),
    optimized_role_count: roles.filter((role) => {
      const optimizer = role.metadata.optimizer && typeof role.metadata.optimizer === "object"
        ? (role.metadata.optimizer as Record<string, unknown>)
        : null;
      return typeof optimizer?.last_run_at === "string" && optimizer.last_run_at.length > 0;
    }).length,
    last_optimizer_run_at: optimizerRunAts[0] ?? null,
    status_counts: statusCounts,
    roles: roles.map((role) => ({
      last_optimizer_run_at:
        role.metadata.optimizer && typeof role.metadata.optimizer === "object" && typeof (role.metadata.optimizer as Record<string, unknown>).last_run_at === "string"
          ? String((role.metadata.optimizer as Record<string, unknown>).last_run_at)
          : null,
      last_optimizer_improvement:
        role.metadata.optimizer && typeof role.metadata.optimizer === "object" && typeof (role.metadata.optimizer as Record<string, unknown>).last_improvement === "number"
          ? Number((role.metadata.optimizer as Record<string, unknown>).last_improvement)
          : null,
      role_id: role.role_id,
      title: role.title,
      lane: role.lane,
      version_count: role.versions.length,
      active_version_id: role.active_version_id,
      candidate_version_count: role.versions.filter((version) => version.status === "candidate").length,
    })),
  };
}

function summarizeMaintenanceSubsystem(params: {
  enabled: boolean;
  interval_seconds: number;
  runtime: Record<string, unknown>;
  backlog_count?: number;
  oldest_backlog_timestamp?: string | null;
}) {
  const running = params.runtime.running === true;
  const lastTickAt = typeof params.runtime.last_tick_at === "string" && params.runtime.last_tick_at.trim()
    ? params.runtime.last_tick_at
    : null;
  const lastSuccessAt =
    typeof params.runtime.last_success_at === "string" && params.runtime.last_success_at.trim()
      ? params.runtime.last_success_at
      : null;
  const lastError =
    typeof params.runtime.last_error === "string" && params.runtime.last_error.trim()
      ? params.runtime.last_error
      : null;
  const startedAt =
    typeof params.runtime.started_at === "string" && params.runtime.started_at.trim()
      ? params.runtime.started_at
      : null;
  const startedAgeSeconds = ageSeconds(startedAt) ?? Number.POSITIVE_INFINITY;
  const startupGraceActive =
    running === true && !lastTickAt && startedAgeSeconds <= Math.max(params.interval_seconds * 2, 120);
  const lastTickAgeSeconds = ageSeconds(lastTickAt) ?? Number.POSITIVE_INFINITY;
  const stale =
    params.enabled &&
    startupGraceActive !== true &&
    lastTickAgeSeconds > Math.max(params.interval_seconds * 2, 120);
  const oldestBacklogAgeSeconds =
    params.backlog_count && params.backlog_count > 0
      ? ageSeconds(params.oldest_backlog_timestamp ?? null)
      : null;
  return {
    enabled: params.enabled,
    running,
    stale,
    interval_seconds: params.interval_seconds,
    last_tick_at: lastTickAt,
    last_success_at: lastSuccessAt,
    last_error: lastError,
    backlog_count: Math.max(0, Math.round(params.backlog_count ?? 0)),
    oldest_backlog_age_seconds: oldestBacklogAgeSeconds,
    last_result: lastError ? "error" : running ? (stale ? "idle" : "healthy") : "stopped",
  } as const;
}

export function summarizeAutonomyMaintain(state: AutonomyMaintainStateRecord | null, storage: Storage): AutonomyMaintainSummary {
  const localRuntime = getAutonomyMaintainRuntimeStatus();
  const transcriptState = storage.getTranscriptAutoSquishState();
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
  const imprintState = storage.getImprintAutoSnapshotState();
  const retentionState = storage.getTriChatAutoRetentionState();
  const watchdogState = storage.getTriChatTurnWatchdogState();
  const staleTurns = storage.listStaleRunningTriChatTurns({
    stale_before_iso: new Date(Date.now() - (watchdogState?.stale_after_seconds ?? 180) * 1000).toISOString(),
    limit: watchdogState?.batch_limit ?? 200,
  });
  const subsystems = {
    transcript_auto_squish: summarizeMaintenanceSubsystem({
      enabled: transcriptState?.enabled ?? false,
      interval_seconds: transcriptState?.interval_seconds ?? 60,
      runtime: getAutoSquishRuntimeStatus(),
      backlog_count: transcriptBacklog.reduce((sum, run) => sum + Math.max(0, run.unsquished_count), 0),
      oldest_backlog_timestamp: transcriptOldest,
    }),
    imprint_auto_snapshot: summarizeMaintenanceSubsystem({
      enabled: imprintState?.enabled ?? false,
      interval_seconds: imprintState?.interval_seconds ?? 900,
      runtime: getAutoSnapshotRuntimeStatus(),
    }),
    trichat_auto_retention: summarizeMaintenanceSubsystem({
      enabled: retentionState?.enabled ?? false,
      interval_seconds: retentionState?.interval_seconds ?? 600,
      runtime: getTriChatAutoRetentionRuntimeStatus(),
    }),
    trichat_turn_watchdog: summarizeMaintenanceSubsystem({
      enabled: watchdogState?.enabled ?? false,
      interval_seconds: watchdogState?.interval_seconds ?? 30,
      runtime: getTriChatTurnWatchdogRuntimeStatus(),
      backlog_count: staleTurns.length,
      oldest_backlog_timestamp: staleTurns[0]?.updated_at ?? null,
    }),
  } as const;
  const degradedSubsystemCount = Object.values(subsystems).filter(
    (subsystem) => subsystem.enabled && (subsystem.running !== true || subsystem.stale || Boolean(subsystem.last_error))
  ).length;
  const runningSubsystemCount = Object.values(subsystems).filter(
    (subsystem) => subsystem.enabled && subsystem.running === true
  ).length;
  const inferredRuntimeRunning =
    localRuntime.running === true ||
    (state?.enabled === true &&
      !localRuntime.last_error &&
      (ageSeconds(state.last_run_at) ?? Number.POSITIVE_INFINITY) <= Math.max(state.interval_seconds * 3, 300));
  const runtime = {
    ...localRuntime,
    local_running: localRuntime.running,
    inferred_running: localRuntime.running !== true && inferredRuntimeRunning,
    running: inferredRuntimeRunning,
    last_tick_at: localRuntime.last_tick_at || state?.last_run_at || null,
  };
  if (!state) {
    return {
      enabled: runtime.running === true,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      eval_interval_seconds: 21600,
      last_run_at: runtime.last_tick_at,
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
      eval_health: {
        suite_id: "autonomy.control-plane",
        minimum_eval_score: 75,
        below_threshold: true,
        never_run: true,
        healthy: false,
      },
      current_attention: ["autonomy.maintain.never_started", "eval.autonomy.control-plane.never_run"],
      last_actions: [],
      last_attention: [],
      last_error: null,
      degraded_subsystem_count: degradedSubsystemCount,
      running_subsystem_count: runningSubsystemCount,
      subsystems,
      runtime,
    };
  }
  const lastRunAgeSeconds = ageSeconds(state.last_run_at);
  const evalHealth = buildEvalHealth(state, {
    run_eval_if_due: runtime.config.run_eval_if_due ?? state.run_eval_if_due ?? true,
    eval_interval_seconds: Number(runtime.config.eval_interval_seconds ?? state.eval_interval_seconds ?? 21600),
    eval_suite_id: String(runtime.config.eval_suite_id ?? state.eval_suite_id ?? "autonomy.control-plane"),
    minimum_eval_score: Number(runtime.config.minimum_eval_score ?? state.minimum_eval_score ?? 75),
    current_dependency_fingerprint: computeEvalDependencyFingerprint(
      storage,
      String(runtime.config.eval_suite_id ?? state.eval_suite_id ?? "autonomy.control-plane")
    ),
  });
  const startupGraceActive =
    runtime.running === true &&
    !runtime.last_tick_at &&
    ((ageSeconds(runtime.started_at) ?? Number.POSITIVE_INFINITY) <= Math.max(state.interval_seconds * 2, 120));
  const stale =
    startupGraceActive !== true &&
    (lastRunAgeSeconds === null ? true : lastRunAgeSeconds > Math.max(state.interval_seconds * 3, 300));
  const currentAttention: string[] = [];
  if (!runtime.running) {
    currentAttention.push("autonomy.maintain.not_running");
  } else if (stale) {
    currentAttention.push("autonomy.maintain.stale");
  }
  if (state.last_error) {
    currentAttention.push("autonomy.maintain.error");
  }
  if (evalHealth.below_threshold) {
    currentAttention.push(`eval.${evalHealth.suite_id}.below_threshold`);
  } else if (evalHealth.due_by_dependency_drift) {
    currentAttention.push(`eval.${evalHealth.suite_id}.definition_changed`);
  } else if (evalHealth.due_by_age) {
    currentAttention.push(`eval.${evalHealth.suite_id}.overdue`);
  }
  for (const [subsystemKey, subsystem] of Object.entries(subsystems)) {
    if (!subsystem.enabled) {
      continue;
    }
    if (subsystem.running !== true) {
      currentAttention.push(`${subsystemKey}.not_running`);
    }
    if (subsystem.stale) {
      currentAttention.push(`${subsystemKey}.stale`);
    }
    if (subsystem.last_error) {
      currentAttention.push(`${subsystemKey}.error`);
    }
  }
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
    eval_due: evalHealth.due,
    eval_health: {
      suite_id: evalHealth.suite_id,
      minimum_eval_score: evalHealth.minimum_eval_score,
      below_threshold: evalHealth.below_threshold,
      never_run: evalHealth.never_run,
      healthy: evalHealth.healthy,
    },
    current_attention: [...new Set(currentAttention)],
    last_actions: state.last_actions,
    last_attention: state.last_attention,
    last_error: state.last_error,
    degraded_subsystem_count: degradedSubsystemCount,
    running_subsystem_count: runningSubsystemCount,
    subsystems,
    runtime,
  };
}

function summarizeReactionEngine(state: ReactionEngineStateRecord | null): ReactionEngineSummary {
  const runtime = getReactionEngineRuntimeStatus();
  if (!state) {
    return {
      enabled: false,
      interval_seconds: 120,
      dedupe_window_seconds: 1800,
      channels: ["desktop"],
      last_run_at: null,
      last_run_age_seconds: null,
      stale: true,
      last_sent_at: null,
      last_sent_count: 0,
      recent_notifications: [],
      last_error: null,
      runtime,
    };
  }
  const lastRunAgeSeconds = ageSeconds(state.last_run_at);
  const startupGraceActive =
    runtime.running === true &&
    !runtime.last_tick_at &&
    ((ageSeconds(runtime.started_at) ?? Number.POSITIVE_INFINITY) <= Math.max(state.interval_seconds * 2, 120));
  return {
    enabled: state.enabled,
    interval_seconds: state.interval_seconds,
    dedupe_window_seconds: state.dedupe_window_seconds,
    channels: state.channels,
    last_run_at: state.last_run_at,
    last_run_age_seconds: lastRunAgeSeconds,
    stale:
      startupGraceActive !== true &&
      (lastRunAgeSeconds === null ? true : lastRunAgeSeconds > Math.max(state.interval_seconds * 3, 300)),
    last_sent_at: state.last_sent_at,
    last_sent_count: state.last_sent_count,
    recent_notifications: state.recent_notifications,
    last_error: state.last_error,
    runtime,
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
  autonomy_maintain_enabled: boolean;
  autonomy_maintain_running: boolean;
  autonomy_eval_due: boolean;
  autonomy_eval_healthy: boolean;
}) {
  if (params.failed_goal_count > 0 || params.failed_task_count > 0 || params.failed_experiment_count > 0) {
    return "degraded";
  }
  if (
    params.autonomy_maintain_enabled &&
    (!params.autonomy_maintain_running || params.autonomy_eval_due || !params.autonomy_eval_healthy) &&
    (params.ready_step_count > 0 || params.pending_task_count > 0 || params.active_session_count > 0)
  ) {
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
    const metadata = isRecord(session.metadata) ? session.metadata : null;
    const lastTickOk = metadata?.last_tick_ok === true;
    const lastTickAt = readString(metadata?.last_tick_at);
    const tickRecoveredAtMs = lastTickOk && lastTickAt ? Date.parse(lastTickAt) : Number.NaN;
    const recentLow = adaptive.performance.low;
    const recoveredByCompletion =
      !Number.isNaN(recoveredAtMs) &&
      recoveredAtMs > failedAtMs &&
      (
        recentLow.recovery_streak >= Math.max(4, Math.min(8, profile.total_failed * 2)) ||
        (recentLow.effective_recent_failed <= 2 &&
          recentLow.recent_completed >= Math.max(4, recentLow.effective_recent_failed * 2) &&
          recentLow.recovery_streak >= 1)
      );
    const recoveredByOperationalTick =
      !Number.isNaN(tickRecoveredAtMs) &&
      tickRecoveredAtMs > failedAtMs &&
      profile.current_task.task_id === null;
    return recoveredByCompletion || recoveredByOperationalTick;
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
  const effectiveWorkerFabric = resolveEffectiveWorkerFabric(storage, {
    fallback_workspace_root: process.cwd(),
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  });
  const workerFabricSummary = summarizeWorkerFabric(storage, effectiveWorkerFabric);
  const clusterTopologySummary = summarizeClusterTopology(storage);
  const modelRouterSummary = summarizeModelRouter(storage, {
    effective_worker_fabric: effectiveWorkerFabric,
  });
  const evalSummary = summarizeEvalSuites(storage);
  const observabilitySummary = summarizeObservability(storage);
  const orgProgramSummary = summarizeOrgPrograms(storage);
  const autonomyMaintainSummary = summarizeAutonomyMaintain(storage.getAutonomyMaintainState(), storage);
  const reactionEngineSummary = summarizeReactionEngine(storage.getReactionEngineState());
  const swarmSummary = summarizeSwarmCoordination(storage, openGoals);
  const workflowExportSummary = summarizeWorkflowExports(storage);
  const runtimeWorkerSummary = summarizeRuntimeWorkers(storage);
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
    autonomy_maintain_enabled: autonomyMaintainSummary.enabled,
    autonomy_maintain_running: autonomyMaintainSummary.runtime.running,
    autonomy_eval_due: autonomyMaintainSummary.eval_due,
    autonomy_eval_healthy: autonomyMaintainSummary.eval_health.healthy,
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
  if ((taskSummary.counts.failed ?? 0) > 0 && taskSummary.last_failed && !staleTaskFailures) {
    attention.push(`Failed task detected: ${taskSummary.last_failed.task_id}`);
  }
  if ((taskSummary.expired_running_count ?? 0) > 0) {
    attention.push(`Expired running task leases detected: ${taskSummary.expired_running_count}.`);
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
    adaptiveSessionCounts.unproven === 0 &&
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
  } else if (
    workerFabricSummary.health_counts.healthy === 0 &&
    workerFabricSummary.health_counts.degraded > 0 &&
    workerFabricSummary.host_count > 0
  ) {
    attention.push("All enabled worker fabric hosts are degraded; dispatch will proceed conservatively.");
  } else if (workerFabricSummary.health_counts.healthy === 0 && workerFabricSummary.host_count > 0) {
    attention.push("Worker fabric has no healthy hosts available.");
  }
  if (clusterTopologySummary.node_count === 0) {
    attention.push("No cluster topology is recorded yet.");
  } else if (clusterTopologySummary.active_node_count === 0) {
    attention.push("Cluster topology exists, but no nodes are marked active.");
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
  if (openGoals.length > 0 && swarmSummary.active_profile_count === 0) {
    attention.push("Open goals exist, but none have a persisted swarm topology profile yet.");
  }
  if (!autonomyMaintainSummary.enabled) {
    attention.push("Background autonomy maintenance has not persisted an enabled state yet.");
  } else if (!autonomyMaintainSummary.runtime.running) {
    attention.push("Background autonomy maintenance is enabled in storage, but the live daemon loop is not running.");
  } else if (autonomyMaintainSummary.stale) {
    attention.push("Background autonomy maintenance is stale and may no longer be refreshing readiness automatically.");
  } else if (autonomyMaintainSummary.eval_due || !autonomyMaintainSummary.eval_health.healthy) {
    attention.push("Background autonomy maintenance eval health is not production-ready.");
  }
  if (observabilitySummary.recent_critical_count > 0) {
    attention.push(
      `Observability captured ${observabilitySummary.recent_critical_count} critical document(s) in the last 15 minutes.`
    );
  }
  if (autonomyMaintainSummary.current_attention.length > 0) {
    attention.push(
      `Background autonomy maintenance currently needs attention: ${autonomyMaintainSummary.current_attention.slice(0, 3).join(", ")}.`
    );
  }
  const degradedMaintenanceSubsystems = Object.entries(autonomyMaintainSummary.subsystems)
    .filter(([, subsystem]) => subsystem.enabled && (subsystem.running !== true || subsystem.stale || Boolean(subsystem.last_error)))
    .map(([key]) => key);
  if (degradedMaintenanceSubsystems.length > 0) {
    attention.push(
      `Maintenance subsystems need attention: ${degradedMaintenanceSubsystems
        .slice(0, 4)
        .join(", ")}${degradedMaintenanceSubsystems.length > 4 ? ", ..." : ""}.`
    );
  }
  if (!reactionEngineSummary.enabled) {
    attention.push("Reaction engine notifications are not enabled yet.");
  } else if (!reactionEngineSummary.runtime.running) {
    attention.push("Reaction engine is enabled in storage, but the live notifier loop is not running.");
  } else if (reactionEngineSummary.stale) {
    attention.push("Reaction engine is stale and may no longer surface human-attention alerts.");
  }
  if (runtimeWorkerSummary.counts.failed > 0) {
    attention.push("One or more runtime workers failed recently.");
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
      failed_task_count: staleTaskFailures ? 0 : taskSummary.counts.failed ?? 0,
      expired_running_task_count: taskSummary.expired_running_count ?? 0,
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
      cluster_topology: {
        node_count: clusterTopologySummary.node_count,
        active_node_count: clusterTopologySummary.active_node_count,
        planned_node_count: clusterTopologySummary.planned_node_count,
        provisioning_node_count: clusterTopologySummary.provisioning_node_count,
        syncable_worker_host_count: clusterTopologySummary.syncable_worker_host_count,
        class_counts: clusterTopologySummary.class_counts,
      },
      model_router: {
        backend_count: modelRouterSummary.backend_count,
        enabled_backend_count: modelRouterSummary.enabled_backend_count,
        provider_counts: modelRouterSummary.provider_counts,
        routed_task_kind_count: modelRouterSummary.routing_outlook.length,
        planned_backend_count: modelRouterSummary.routing_outlook.reduce(
          (sum, entry) => sum + entry.planned_backend_count,
          0
        ),
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
        candidate_version_count: orgProgramSummary.candidate_version_count,
        optimized_role_count: orgProgramSummary.optimized_role_count,
      },
      swarm: {
        active_profile_count: swarmSummary.active_profile_count,
        checkpoint_artifact_count: swarmSummary.checkpoint_artifact_count,
        topology_counts: swarmSummary.topology_counts,
      },
      autonomy_maintain: {
        enabled: autonomyMaintainSummary.enabled,
        stale: autonomyMaintainSummary.stale,
        last_run_age_seconds: autonomyMaintainSummary.last_run_age_seconds,
        eval_due: autonomyMaintainSummary.eval_due,
        last_eval_score: autonomyMaintainSummary.last_eval_score,
        runtime_running: autonomyMaintainSummary.runtime.running,
        runtime_last_error: autonomyMaintainSummary.runtime.last_error,
        degraded_subsystem_count: autonomyMaintainSummary.degraded_subsystem_count,
        running_subsystem_count: autonomyMaintainSummary.running_subsystem_count,
      },
      reaction_engine: {
        enabled: reactionEngineSummary.enabled,
        stale: reactionEngineSummary.stale,
        last_run_age_seconds: reactionEngineSummary.last_run_age_seconds,
        runtime_running: reactionEngineSummary.runtime.running,
        last_sent_count: reactionEngineSummary.last_sent_count,
        runtime_last_error: reactionEngineSummary.runtime.last_error,
      },
      workflow_exports: {
        bundle_count: workflowExportSummary.bundle_count,
        metrics_count: workflowExportSummary.metrics_count,
        argo_contract_count: workflowExportSummary.argo_contract_count,
        latest_export_at:
          workflowExportSummary.latest_bundle?.created_at ??
          workflowExportSummary.latest_metrics?.created_at ??
          workflowExportSummary.latest_argo_contract?.created_at ??
          null,
      },
      runtime_workers: {
        session_count: runtimeWorkerSummary.session_count,
        active_count: runtimeWorkerSummary.active_count,
        failed_count: runtimeWorkerSummary.counts.failed,
        runtime_counts: runtimeWorkerSummary.runtime_counts,
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
    cluster_topology: clusterTopologySummary,
    model_router: modelRouterSummary,
    evals: evalSummary,
    observability: observabilitySummary,
    org_programs: orgProgramSummary,
    swarm: swarmSummary,
    autonomy_maintain: autonomyMaintainSummary,
    reaction_engine: reactionEngineSummary,
    workflow_exports: workflowExportSummary,
    runtime_workers: runtimeWorkerSummary,
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
