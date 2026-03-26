import { z } from "zod";
import { Storage, type AgentSessionRecord, type PlanRecord, type PlanStepRecord, type TaskRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { deriveExperimentObservation, judgeExperimentRunWithStorage } from "./experiment.js";
import { type TaskExecutionProfile, resolveTaskExecutionProfile } from "./task.js";

const agentSessionStatusSchema = z.enum(["active", "idle", "busy", "expired", "closed", "failed"]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const recordSchema = z.record(z.unknown());

export const agentSessionOpenSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1).max(200).optional(),
  agent_id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  client_kind: z.string().min(1).optional(),
  transport_kind: z.string().min(1).optional(),
  workspace_root: z.string().min(1).optional(),
  owner_id: z.string().min(1).optional(),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  status: agentSessionStatusSchema.optional(),
  capabilities: recordSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const agentSessionGetSchema = z.object({
  session_id: z.string().min(1),
});

export const agentSessionListSchema = z.object({
  status: agentSessionStatusSchema.optional(),
  agent_id: z.string().min(1).optional(),
  client_kind: z.string().min(1).optional(),
  active_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const agentSessionHeartbeatSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  status: agentSessionStatusSchema.optional(),
  owner_id: z.string().min(1).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
});

export const agentSessionCloseSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  metadata: recordSchema.optional(),
});

export const agentClaimNextSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const agentWorklistSchema = z.object({
  session_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  scan_limit: z.number().int().min(1).max(500).optional(),
  include_ineligible: z.boolean().optional(),
});

export const agentCurrentTaskSchema = z.object({
  session_id: z.string().min(1),
});

export const agentHeartbeatTaskSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const agentReportResultSchema = z
  .object({
    mutation: mutationSchema,
    session_id: z.string().min(1),
    task_id: z.string().min(1),
    outcome: z.enum(["completed", "failed"]),
    result: recordSchema.optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    run_id: z.string().min(1).optional(),
    produced_artifact_ids: z.array(z.string().min(1)).optional(),
    observed_metric: z.number().finite().optional(),
    observed_metrics: recordSchema.optional(),
    experiment_verdict: z.enum(["accepted", "rejected", "inconclusive", "crash"]).optional(),
    next_session_status: agentSessionStatusSchema.optional(),
    metadata: recordSchema.optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.outcome === "failed" && !value.error?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error is required when outcome is failed",
        path: ["error"],
      });
    }
  });

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

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function buildAgentDerivedMutation(
  mutation: { idempotency_key: string; side_effect_fingerprint: string },
  phase: string
) {
  return {
    idempotency_key: `${mutation.idempotency_key}:agent:${phase}`,
    side_effect_fingerprint: `${mutation.side_effect_fingerprint}:agent:${phase}`,
  };
}

type TaskRoutingRule = {
  preferred_agent_ids: string[];
  allowed_agent_ids: string[];
  preferred_client_kinds: string[];
  allowed_client_kinds: string[];
  required_capabilities: string[];
  preferred_capabilities: string[];
};

type TaskRoutingEvaluation = {
  eligible: boolean;
  score: number;
  blockers: string[];
  matched_preferences: string[];
  routing: TaskRoutingRule;
  task_profile: TaskExecutionProfile;
  session_capability_tier: "low" | "medium" | "high";
  adaptive_score_adjustment: number;
  session_performance: AdaptiveSessionPerformanceSummary;
};

type AgentTaskCandidate = {
  task: TaskRecord;
  routing: TaskRoutingEvaluation;
};

type ExpectedArtifactCheck = {
  expected_artifact_types: string[];
  produced_artifact_ids: string[];
  produced_artifact_types: string[];
  missing_artifact_types: string[];
  satisfied: boolean;
};

type AdaptiveComplexityStats = {
  claims: number;
  completions: number;
  failures: number;
  stagnations: number;
  evidence_blocks: number;
  average_completion_seconds: number | null;
  last_completion_seconds: number | null;
};

type AdaptiveCurrentTaskState = {
  task_id: string | null;
  claimed_at: string | null;
  heartbeat_count: number;
  complexity: TaskExecutionProfile["complexity"] | null;
  stagnation_signaled: boolean;
  stagnation_signaled_at: string | null;
};

type AdaptiveWorkerProfile = {
  total_claims: number;
  total_completed: number;
  total_failed: number;
  total_stagnation_signals: number;
  total_evidence_blocks: number;
  consecutive_failures: number;
  consecutive_stagnation_signals: number;
  average_completion_seconds: number | null;
  last_completion_seconds: number | null;
  last_claimed_at: string | null;
  last_completed_at: string | null;
  last_failed_at: string | null;
  last_stagnation_at: string | null;
  complexity: Record<TaskExecutionProfile["complexity"], AdaptiveComplexityStats>;
  current_task: AdaptiveCurrentTaskState;
  recent_outcomes: Array<Record<string, unknown>>;
};

type AdaptiveSessionPerformanceSummary = {
  total_claims: number;
  total_completed: number;
  total_failed: number;
  total_stagnation_signals: number;
  total_evidence_blocks: number;
  consecutive_failures: number;
  consecutive_stagnation_signals: number;
  completion_rate: number | null;
  failure_rate: number | null;
  stagnation_rate: number | null;
  average_completion_seconds: number | null;
  complexity: TaskExecutionProfile["complexity"];
  complexity_stats: AdaptiveComplexityStats;
};

type AdaptiveRoutingSignal = {
  adjustment: number;
  blockers: string[];
  matched_preferences: string[];
  summary: AdaptiveSessionPerformanceSummary;
};

const ADAPTIVE_WORKER_PROFILE_KEY = "adaptive_worker_profile";

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function emptyAdaptiveComplexityStats(): AdaptiveComplexityStats {
  return {
    claims: 0,
    completions: 0,
    failures: 0,
    stagnations: 0,
    evidence_blocks: 0,
    average_completion_seconds: null,
    last_completion_seconds: null,
  };
}

function emptyAdaptiveCurrentTaskState(): AdaptiveCurrentTaskState {
  return {
    task_id: null,
    claimed_at: null,
    heartbeat_count: 0,
    complexity: null,
    stagnation_signaled: false,
    stagnation_signaled_at: null,
  };
}

function emptyAdaptiveWorkerProfile(): AdaptiveWorkerProfile {
  return {
    total_claims: 0,
    total_completed: 0,
    total_failed: 0,
    total_stagnation_signals: 0,
    total_evidence_blocks: 0,
    consecutive_failures: 0,
    consecutive_stagnation_signals: 0,
    average_completion_seconds: null,
    last_completion_seconds: null,
    last_claimed_at: null,
    last_completed_at: null,
    last_failed_at: null,
    last_stagnation_at: null,
    complexity: {
      low: emptyAdaptiveComplexityStats(),
      medium: emptyAdaptiveComplexityStats(),
      high: emptyAdaptiveComplexityStats(),
    },
    current_task: emptyAdaptiveCurrentTaskState(),
    recent_outcomes: [],
  };
}

function normalizeAdaptiveComplexityStats(value: unknown): AdaptiveComplexityStats {
  const profile = isRecord(value) ? value : {};
  return {
    claims: readNonNegativeInt(profile.claims) ?? 0,
    completions: readNonNegativeInt(profile.completions) ?? 0,
    failures: readNonNegativeInt(profile.failures) ?? 0,
    stagnations: readNonNegativeInt(profile.stagnations) ?? 0,
    evidence_blocks: readNonNegativeInt(profile.evidence_blocks) ?? 0,
    average_completion_seconds: readNonNegativeNumber(profile.average_completion_seconds),
    last_completion_seconds: readNonNegativeNumber(profile.last_completion_seconds),
  };
}

function normalizeAdaptiveWorkerProfile(value: unknown): AdaptiveWorkerProfile {
  const profile = isRecord(value) ? value : {};
  const complexity = isRecord(profile.complexity) ? profile.complexity : {};
  const currentTask = isRecord(profile.current_task) ? profile.current_task : {};
  return {
    total_claims: readNonNegativeInt(profile.total_claims) ?? 0,
    total_completed: readNonNegativeInt(profile.total_completed) ?? 0,
    total_failed: readNonNegativeInt(profile.total_failed) ?? 0,
    total_stagnation_signals: readNonNegativeInt(profile.total_stagnation_signals) ?? 0,
    total_evidence_blocks: readNonNegativeInt(profile.total_evidence_blocks) ?? 0,
    consecutive_failures: readNonNegativeInt(profile.consecutive_failures) ?? 0,
    consecutive_stagnation_signals: readNonNegativeInt(profile.consecutive_stagnation_signals) ?? 0,
    average_completion_seconds: readNonNegativeNumber(profile.average_completion_seconds),
    last_completion_seconds: readNonNegativeNumber(profile.last_completion_seconds),
    last_claimed_at: readString(profile.last_claimed_at),
    last_completed_at: readString(profile.last_completed_at),
    last_failed_at: readString(profile.last_failed_at),
    last_stagnation_at: readString(profile.last_stagnation_at),
    complexity: {
      low: normalizeAdaptiveComplexityStats(complexity.low),
      medium: normalizeAdaptiveComplexityStats(complexity.medium),
      high: normalizeAdaptiveComplexityStats(complexity.high),
    },
    current_task: {
      task_id: readString(currentTask.task_id),
      claimed_at: readString(currentTask.claimed_at),
      heartbeat_count: readNonNegativeInt(currentTask.heartbeat_count) ?? 0,
      complexity:
        readString(currentTask.complexity) === "low" ||
        readString(currentTask.complexity) === "medium" ||
        readString(currentTask.complexity) === "high"
          ? (readString(currentTask.complexity) as TaskExecutionProfile["complexity"])
          : null,
      stagnation_signaled: readBoolean(currentTask.stagnation_signaled) ?? false,
      stagnation_signaled_at: readString(currentTask.stagnation_signaled_at),
    },
    recent_outcomes: Array.isArray(profile.recent_outcomes)
      ? profile.recent_outcomes.filter((entry): entry is Record<string, unknown> => isRecord(entry)).slice(-10)
      : [],
  };
}

function getAdaptiveWorkerProfile(session: AgentSessionRecord): AdaptiveWorkerProfile {
  return normalizeAdaptiveWorkerProfile(session.metadata[ADAPTIVE_WORKER_PROFILE_KEY]);
}

function getAdaptiveComplexityStats(
  profile: AdaptiveWorkerProfile,
  complexity: TaskExecutionProfile["complexity"]
): AdaptiveComplexityStats {
  return {
    ...profile.complexity[complexity],
  };
}

function setAdaptiveComplexityStats(
  profile: AdaptiveWorkerProfile,
  complexity: TaskExecutionProfile["complexity"],
  stats: AdaptiveComplexityStats
) {
  profile.complexity = {
    ...profile.complexity,
    [complexity]: stats,
  };
}

function updateRollingAverage(currentAverage: number | null, sampleCountBefore: number, sample: number): number {
  if (!Number.isFinite(sample) || sample < 0) {
    return currentAverage ?? 0;
  }
  if (currentAverage === null || sampleCountBefore <= 0) {
    return Math.round(sample * 1000) / 1000;
  }
  return Math.round((((currentAverage * sampleCountBefore) + sample) / (sampleCountBefore + 1)) * 1000) / 1000;
}

function getStagnationHeartbeatThreshold(complexity: TaskExecutionProfile["complexity"]): number {
  if (complexity === "low") {
    return 2;
  }
  if (complexity === "medium") {
    return 3;
  }
  return 4;
}

function updateAdaptiveWorkerProfileOnClaim(
  session: AgentSessionRecord,
  taskId: string,
  taskProfile: TaskExecutionProfile,
  claimedAt: string
): AdaptiveWorkerProfile {
  const profile = getAdaptiveWorkerProfile(session);
  const stats = getAdaptiveComplexityStats(profile, taskProfile.complexity);
  stats.claims += 1;
  setAdaptiveComplexityStats(profile, taskProfile.complexity, stats);
  profile.total_claims += 1;
  profile.last_claimed_at = claimedAt;
  profile.current_task = {
    task_id: taskId,
    claimed_at: claimedAt,
    heartbeat_count: 0,
    complexity: taskProfile.complexity,
    stagnation_signaled: false,
    stagnation_signaled_at: null,
  };
  return profile;
}

function updateAdaptiveWorkerProfileOnHeartbeat(
  session: AgentSessionRecord,
  taskId: string,
  taskProfile: TaskExecutionProfile,
  heartbeatAt: string
): { profile: AdaptiveWorkerProfile; stagnation_signaled: boolean } {
  const profile = getAdaptiveWorkerProfile(session);
  const currentTask =
    profile.current_task.task_id === taskId
      ? { ...profile.current_task }
      : {
          task_id: taskId,
          claimed_at: heartbeatAt,
          heartbeat_count: 0,
          complexity: taskProfile.complexity,
          stagnation_signaled: false,
          stagnation_signaled_at: null,
        };
  currentTask.task_id = taskId;
  currentTask.complexity = taskProfile.complexity;
  currentTask.heartbeat_count += 1;

  let stagnationSignaled = false;
  if (!currentTask.stagnation_signaled && currentTask.heartbeat_count >= getStagnationHeartbeatThreshold(taskProfile.complexity)) {
    currentTask.stagnation_signaled = true;
    currentTask.stagnation_signaled_at = heartbeatAt;
    stagnationSignaled = true;

    const stats = getAdaptiveComplexityStats(profile, taskProfile.complexity);
    stats.stagnations += 1;
    setAdaptiveComplexityStats(profile, taskProfile.complexity, stats);
    profile.total_stagnation_signals += 1;
    profile.consecutive_stagnation_signals += 1;
    profile.last_stagnation_at = heartbeatAt;
  }

  profile.current_task = currentTask;
  return {
    profile,
    stagnation_signaled: stagnationSignaled,
  };
}

function updateAdaptiveWorkerProfileOnReport(
  session: AgentSessionRecord,
  task: TaskRecord,
  taskProfile: TaskExecutionProfile,
  outcome: "completed" | "failed",
  reportedAt: string,
  options: {
    missing_expected_artifacts: boolean;
  }
): { profile: AdaptiveWorkerProfile; completion_seconds: number | null } {
  const profile = getAdaptiveWorkerProfile(session);
  const stats = getAdaptiveComplexityStats(profile, taskProfile.complexity);
  const currentTask = profile.current_task.task_id === task.task_id ? profile.current_task : emptyAdaptiveCurrentTaskState();
  const completionSeconds =
    currentTask.claimed_at && Number.isFinite(Date.parse(currentTask.claimed_at))
      ? Math.max(0, Math.round((Date.parse(reportedAt) - Date.parse(currentTask.claimed_at)) / 1000))
      : null;

  if (outcome === "completed") {
    stats.completions += 1;
    profile.total_completed += 1;
    profile.consecutive_failures = 0;
    profile.consecutive_stagnation_signals = 0;
    profile.last_completed_at = reportedAt;
    if (completionSeconds !== null) {
      stats.average_completion_seconds = updateRollingAverage(
        stats.average_completion_seconds,
        Math.max(stats.completions - 1, 0),
        completionSeconds
      );
      stats.last_completion_seconds = completionSeconds;
      profile.average_completion_seconds = updateRollingAverage(
        profile.average_completion_seconds,
        Math.max(profile.total_completed - 1, 0),
        completionSeconds
      );
      profile.last_completion_seconds = completionSeconds;
    }
    if (options.missing_expected_artifacts) {
      stats.evidence_blocks += 1;
      profile.total_evidence_blocks += 1;
    }
  } else {
    stats.failures += 1;
    profile.total_failed += 1;
    profile.consecutive_failures += 1;
    profile.last_failed_at = reportedAt;
  }

  setAdaptiveComplexityStats(profile, taskProfile.complexity, stats);
  profile.current_task = emptyAdaptiveCurrentTaskState();
  profile.recent_outcomes = [
    ...profile.recent_outcomes.slice(-9),
    {
      task_id: task.task_id,
      objective: task.objective,
      outcome,
      reported_at: reportedAt,
      complexity: taskProfile.complexity,
      missing_expected_artifacts: options.missing_expected_artifacts,
      completion_seconds: completionSeconds,
      stagnation_signaled: currentTask.stagnation_signaled,
    },
  ];

  return {
    profile,
    completion_seconds: completionSeconds,
  };
}

function summarizeAdaptiveWorkerProfile(
  profile: AdaptiveWorkerProfile,
  complexity: TaskExecutionProfile["complexity"]
): AdaptiveSessionPerformanceSummary {
  const totalClaims = Math.max(profile.total_claims, 0);
  return {
    total_claims: profile.total_claims,
    total_completed: profile.total_completed,
    total_failed: profile.total_failed,
    total_stagnation_signals: profile.total_stagnation_signals,
    total_evidence_blocks: profile.total_evidence_blocks,
    consecutive_failures: profile.consecutive_failures,
    consecutive_stagnation_signals: profile.consecutive_stagnation_signals,
    completion_rate: totalClaims > 0 ? profile.total_completed / totalClaims : null,
    failure_rate: totalClaims > 0 ? profile.total_failed / totalClaims : null,
    stagnation_rate: totalClaims > 0 ? profile.total_stagnation_signals / totalClaims : null,
    average_completion_seconds: profile.average_completion_seconds,
    complexity,
    complexity_stats: getAdaptiveComplexityStats(profile, complexity),
  };
}

function evaluateAdaptiveRoutingSignal(
  session: AgentSessionRecord,
  taskProfile: TaskExecutionProfile,
  explicitlyTargetedSession: boolean
): AdaptiveRoutingSignal {
  const profile = getAdaptiveWorkerProfile(session);
  const summary = summarizeAdaptiveWorkerProfile(profile, taskProfile.complexity);
  const blockers: string[] = [];
  const matchedPreferences: string[] = [];
  let adjustment = 0;

  if (summary.total_claims > 0) {
    adjustment += Math.round((summary.completion_rate ?? 0) * 8);
    adjustment -= Math.round((summary.failure_rate ?? 0) * 10);
    adjustment -= Math.round((summary.stagnation_rate ?? 0) * 10);
    adjustment -= Math.round((summary.total_evidence_blocks / summary.total_claims) * 6);
  }

  const complexityClaims = summary.complexity_stats.claims;
  if (complexityClaims >= 2) {
    adjustment += Math.round((summary.complexity_stats.completions / complexityClaims) * 8);
    adjustment -= Math.round((summary.complexity_stats.failures / complexityClaims) * 10);
    adjustment -= Math.round((summary.complexity_stats.stagnations / complexityClaims) * 10);
    matchedPreferences.push(`adaptive_history:${taskProfile.complexity}:${complexityClaims}`);
  }

  if (summary.consecutive_failures > 0) {
    adjustment -= Math.min(summary.consecutive_failures * 4, 12);
  }
  if (summary.consecutive_stagnation_signals > 0) {
    adjustment -= Math.min(summary.consecutive_stagnation_signals * 3, 9);
  }

  if (!explicitlyTargetedSession && complexityClaims >= 2) {
    if (
      taskProfile.complexity === "high" &&
      (summary.consecutive_failures >= 2 || summary.consecutive_stagnation_signals >= 1)
    ) {
      blockers.push("performance_high_risk");
    } else if (
      taskProfile.complexity === "medium" &&
      (summary.consecutive_failures >= 2 || summary.consecutive_stagnation_signals >= 1)
    ) {
      blockers.push("performance_medium_risk");
    }
  }

  if (adjustment > 0) {
    matchedPreferences.push(`adaptive_bonus:${adjustment}`);
  } else if (adjustment < 0) {
    matchedPreferences.push(`adaptive_penalty:${adjustment}`);
  }

  return {
    adjustment,
    blockers,
    matched_preferences: matchedPreferences,
    summary,
  };
}

function resolveTaskPlanContext(
  storage: Storage,
  task: TaskRecord
): { plan: PlanRecord; step: PlanStepRecord } | null {
  const directMatch = storage.findPlanStepByTaskId(task.task_id);
  if (directMatch) {
    return directMatch;
  }

  const dispatchMetadata = isRecord(task.metadata.plan_dispatch) ? task.metadata.plan_dispatch : null;
  const planId =
    readString(dispatchMetadata?.plan_id) ??
    (isRecord(task.payload) ? readString(task.payload.plan_id) : null);
  const stepId =
    readString(dispatchMetadata?.step_id) ??
    (isRecord(task.payload) ? readString(task.payload.step_id) : null);
  if (!planId || !stepId) {
    return null;
  }
  const plan = storage.getPlanById(planId);
  const step = plan ? storage.listPlanSteps(planId).find((candidate) => candidate.step_id === stepId) ?? null : null;
  if (!plan || !step) {
    return null;
  }
  return { plan, step };
}

function evaluateExpectedArtifacts(
  storage: Storage,
  step: PlanStepRecord,
  producedArtifactIds: string[]
): ExpectedArtifactCheck {
  const expectedArtifactTypes = dedupeStrings(step.expected_artifact_types);
  const producedArtifactTypes = dedupeStrings(
    producedArtifactIds
      .map((artifactId) => storage.getArtifactById(artifactId)?.artifact_type ?? null)
      .filter((artifactType): artifactType is string => typeof artifactType === "string" && artifactType.trim().length > 0)
  );
  const missingArtifactTypes = expectedArtifactTypes.filter((artifactType) => !producedArtifactTypes.includes(artifactType));
  return {
    expected_artifact_types: expectedArtifactTypes,
    produced_artifact_ids: producedArtifactIds,
    produced_artifact_types: producedArtifactTypes,
    missing_artifact_types: missingArtifactTypes,
    satisfied: missingArtifactTypes.length === 0,
  };
}

function goalSupportsAutorun(goalAutonomyMode: string | null | undefined) {
  return (
    goalAutonomyMode === "stage" ||
    goalAutonomyMode === "execute_bounded" ||
    goalAutonomyMode === "execute_destructive_with_approval"
  );
}

function shouldTriggerGoalAutorun(
  storage: Storage,
  task: TaskRecord,
  planContext: { plan: PlanRecord; step: PlanStepRecord } | null
) {
  if (!planContext) {
    return {
      enabled: false,
      reason: "no-plan-context",
      goal_id: null,
      max_passes: null,
    };
  }

  const dispatchMetadata = isRecord(task.metadata.plan_dispatch) ? task.metadata.plan_dispatch : null;
  const explicitFlag = readBoolean(dispatchMetadata?.autorun_goal_on_completion);
  if (explicitFlag === false) {
    return {
      enabled: false,
      reason: "dispatch-disabled",
      goal_id: planContext.plan.goal_id,
      max_passes: null,
    };
  }

  const workflowFlag = readBoolean(planContext.plan.metadata.workflow_autorun_enabled);
  const goal = storage.getGoalById(planContext.plan.goal_id);
  const enabled = explicitFlag === true || workflowFlag === true || goalSupportsAutorun(goal?.autonomy_mode);
  return {
    enabled,
    reason: enabled ? (workflowFlag === true ? "plan-workflow-autorun" : goal ? `goal:${goal.autonomy_mode}` : "dispatch-enabled") : "goal-autonomy-disabled",
    goal_id: planContext.plan.goal_id,
    max_passes: readPositiveInt(planContext.plan.metadata.workflow_autorun_max_passes),
  };
}

function attachArtifactsToTaskContext(
  storage: Storage,
  task: TaskRecord,
  producedArtifactIds: string[],
  source: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  },
  planContext?: { plan: PlanRecord; step: PlanStepRecord } | null
) {
  const links = [];
  for (const artifactId of producedArtifactIds) {
    if (!storage.getArtifactById(artifactId)) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    links.push(
      storage.linkArtifact({
        src_artifact_id: artifactId,
        dst_entity_type: "task",
        dst_entity_id: task.task_id,
        relation: "attached_to",
        source_client: source.source_client,
        source_model: source.source_model,
        source_agent: source.source_agent,
      }).link
    );
    if (planContext) {
      links.push(
        storage.linkArtifact({
          src_artifact_id: artifactId,
          dst_entity_type: "goal",
          dst_entity_id: planContext.plan.goal_id,
          relation: "attached_to",
          source_client: source.source_client,
          source_model: source.source_model,
          source_agent: source.source_agent,
        }).link
      );
      links.push(
        storage.linkArtifact({
          src_artifact_id: artifactId,
          dst_entity_type: "plan",
          dst_entity_id: planContext.plan.plan_id,
          relation: "attached_to",
          source_client: source.source_client,
          source_model: source.source_model,
          source_agent: source.source_agent,
        }).link
      );
      links.push(
        storage.linkArtifact({
          src_artifact_id: artifactId,
          dst_entity_type: "step",
          dst_entity_id: planContext.step.step_id,
          relation: "attached_to",
          source_client: source.source_client,
          source_model: source.source_model,
          source_agent: source.source_agent,
        }).link
      );
    }
  }
  return links;
}

function recordAgentReportArtifact(
  storage: Storage,
  params: {
    session: AgentSessionRecord;
    task: TaskRecord;
    outcome: "completed" | "failed";
    result?: Record<string, unknown>;
    summary?: string;
    error?: string;
    run_id?: string;
    observed_metric?: number;
    observed_metrics?: Record<string, unknown>;
    experiment_verdict?: "accepted" | "rejected" | "inconclusive" | "crash";
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    planContext?: { plan: PlanRecord; step: PlanStepRecord } | null;
  }
) {
  const recorded = storage.recordArtifact({
    artifact_type: "agent.task_report",
    goal_id: params.planContext?.plan.goal_id,
    plan_id: params.planContext?.plan.plan_id,
    step_id: params.planContext?.step.step_id,
    task_id: params.task.task_id,
    run_id: params.run_id,
    producer_kind: "worker",
    producer_id: params.session.session_id,
    trust_tier: "derived",
    content_json: {
      outcome: params.outcome,
      summary: params.summary?.trim() || null,
      error: params.error?.trim() || null,
      result: params.result ?? {},
      observed_metric: params.observed_metric ?? null,
      observed_metrics: params.observed_metrics ?? {},
      experiment_verdict: params.experiment_verdict ?? null,
      session: {
        session_id: params.session.session_id,
        agent_id: params.session.agent_id,
        client_kind: params.session.client_kind,
      },
      task: {
        task_id: params.task.task_id,
        objective: params.task.objective,
        status: params.task.status,
        project_dir: params.task.project_dir,
      },
    },
    metadata: {
      auto_recorded: true,
      artifact_role: "task_report",
      session_id: params.session.session_id,
      agent_id: params.session.agent_id,
      client_kind: params.session.client_kind,
      task_status: params.task.status,
      ...(params.metadata ?? {}),
    },
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent ?? params.session.agent_id,
  });
  return recorded.artifact;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return dedupeStrings(value.filter((item): item is string => typeof item === "string"));
}

function normalizeTaskRouting(value: unknown): TaskRoutingRule {
  if (!isRecord(value)) {
    return {
      preferred_agent_ids: [],
      allowed_agent_ids: [],
      preferred_client_kinds: [],
      allowed_client_kinds: [],
      required_capabilities: [],
      preferred_capabilities: [],
    };
  }
  return {
    preferred_agent_ids: normalizeStringArray(value.preferred_agent_ids),
    allowed_agent_ids: normalizeStringArray(value.allowed_agent_ids),
    preferred_client_kinds: normalizeStringArray(value.preferred_client_kinds),
    allowed_client_kinds: normalizeStringArray(value.allowed_client_kinds),
    required_capabilities: normalizeStringArray(value.required_capabilities),
    preferred_capabilities: normalizeStringArray(value.preferred_capabilities),
  };
}

function resolveTaskRouting(task: TaskRecord): TaskRoutingRule {
  const merged: TaskRoutingRule = {
    preferred_agent_ids: [],
    allowed_agent_ids: [],
    preferred_client_kinds: [],
    allowed_client_kinds: [],
    required_capabilities: [],
    preferred_capabilities: [],
  };

  const candidates = [
    task.metadata.task_routing,
    task.metadata.routing,
    isRecord(task.payload) ? task.payload.task_routing : undefined,
    isRecord(task.payload) ? task.payload.routing : undefined,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTaskRouting(candidate);
    merged.preferred_agent_ids = dedupeStrings([...merged.preferred_agent_ids, ...normalized.preferred_agent_ids]);
    merged.allowed_agent_ids = dedupeStrings([...merged.allowed_agent_ids, ...normalized.allowed_agent_ids]);
    merged.preferred_client_kinds = dedupeStrings([
      ...merged.preferred_client_kinds,
      ...normalized.preferred_client_kinds,
    ]);
    merged.allowed_client_kinds = dedupeStrings([...merged.allowed_client_kinds, ...normalized.allowed_client_kinds]);
    merged.required_capabilities = dedupeStrings([
      ...merged.required_capabilities,
      ...normalized.required_capabilities,
    ]);
    merged.preferred_capabilities = dedupeStrings([
      ...merged.preferred_capabilities,
      ...normalized.preferred_capabilities,
    ]);
  }

  return merged;
}

function capabilityListIncludes(value: unknown, capability: string): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => readString(entry)?.toLowerCase() === capability);
}

function hasSessionCapability(session: AgentSessionRecord, capability: string): boolean {
  const normalized = capability.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (session.tags.some((tag) => tag.trim().toLowerCase() === normalized)) {
    return true;
  }

  const direct = session.capabilities[normalized] ?? session.capabilities[capability];
  if (direct === true) {
    return true;
  }
  if (typeof direct === "string") {
    const value = direct.trim().toLowerCase();
    return value.length > 0 && !["false", "0", "none", "no"].includes(value);
  }
  if (typeof direct === "number") {
    return Number.isFinite(direct) && direct > 0;
  }
  if (Array.isArray(direct)) {
    return direct.length > 0;
  }
  if (isRecord(direct)) {
    return Object.keys(direct).length > 0;
  }

  return (
    capabilityListIncludes(session.capabilities.capabilities, normalized) ||
    capabilityListIncludes(session.capabilities.supported_capabilities, normalized) ||
    capabilityListIncludes(session.capabilities.skills, normalized) ||
    capabilityListIncludes(session.capabilities.roles, normalized)
  );
}

function resolveSessionCapabilityTier(session: AgentSessionRecord): "low" | "medium" | "high" {
  const explicitTier = readString(session.capabilities.capability_tier)?.toLowerCase();
  if (explicitTier === "low" || explicitTier === "medium" || explicitTier === "high") {
    return explicitTier;
  }

  const agentId = session.agent_id.trim().toLowerCase();
  const clientKind = readString(session.client_kind)?.toLowerCase() ?? null;
  if (["codex", "cursor"].includes(agentId) || ["codex", "cursor"].includes(clientKind ?? "")) {
    return "high";
  }
  if (agentId.includes("imprint") || (clientKind && clientKind.includes("imprint"))) {
    return "low";
  }
  if (hasSessionCapability(session, "coding") || hasSessionCapability(session, "planning")) {
    return "high";
  }
  if (hasSessionCapability(session, "review") || hasSessionCapability(session, "verify") || hasSessionCapability(session, "analysis")) {
    return "medium";
  }
  return "low";
}

function evaluateTaskRouting(session: AgentSessionRecord, task: TaskRecord): TaskRoutingEvaluation {
  const routing = resolveTaskRouting(task);
  const blockers: string[] = [];
  const matchedPreferences: string[] = [];
  let score = 0;
  const taskProfile = resolveTaskExecutionProfile(task);
  const sessionCapabilityTier = resolveSessionCapabilityTier(session);

  const agentId = session.agent_id.trim().toLowerCase();
  const clientKind = readString(session.client_kind)?.toLowerCase() ?? null;
  const explicitlyTargetedSession =
    routing.allowed_agent_ids.some((value) => value.toLowerCase() === agentId) ||
    (!!clientKind && routing.allowed_client_kinds.some((value) => value.toLowerCase() === clientKind));

  if (routing.allowed_agent_ids.length > 0) {
    const allowed = new Set(routing.allowed_agent_ids.map((value) => value.toLowerCase()));
    if (!allowed.has(agentId)) {
      blockers.push("agent_id_not_allowed");
    } else {
      matchedPreferences.push(`allowed_agent:${session.agent_id}`);
      score += 30;
    }
  }

  if (routing.allowed_client_kinds.length > 0) {
    const allowed = new Set(routing.allowed_client_kinds.map((value) => value.toLowerCase()));
    if (!clientKind || !allowed.has(clientKind)) {
      blockers.push("client_kind_not_allowed");
    } else {
      matchedPreferences.push(`allowed_client:${session.client_kind}`);
      score += 20;
    }
  }

  const missingCapabilities = routing.required_capabilities.filter((capability) => !hasSessionCapability(session, capability));
  if (missingCapabilities.length > 0) {
    blockers.push(`missing_capabilities:${missingCapabilities.join(",")}`);
  } else if (routing.required_capabilities.length > 0) {
    matchedPreferences.push(`required_capabilities:${routing.required_capabilities.join(",")}`);
    score += routing.required_capabilities.length * 12;
  }

  if (routing.preferred_agent_ids.some((value) => value.toLowerCase() === agentId)) {
    matchedPreferences.push(`preferred_agent:${session.agent_id}`);
    score += 18;
  }

  if (clientKind && routing.preferred_client_kinds.some((value) => value.toLowerCase() === clientKind)) {
    matchedPreferences.push(`preferred_client:${session.client_kind}`);
    score += 12;
  }

  const preferredCapabilityHits = routing.preferred_capabilities.filter((capability) => hasSessionCapability(session, capability));
  if (preferredCapabilityHits.length > 0) {
    matchedPreferences.push(`preferred_capabilities:${preferredCapabilityHits.join(",")}`);
    score += preferredCapabilityHits.length * 6;
  }

  if (!explicitlyTargetedSession && taskProfile.requires_agent_session) {
    if (taskProfile.complexity === "high" && sessionCapabilityTier !== "high") {
      blockers.push("insufficient_capability_tier:high");
    } else if (taskProfile.complexity === "medium" && sessionCapabilityTier === "low") {
      blockers.push("insufficient_capability_tier:medium");
    }
  }

  if (taskProfile.complexity === "high" && sessionCapabilityTier === "high") {
    matchedPreferences.push("capability_tier_match:high");
    score += 10;
  } else if (taskProfile.complexity === "medium" && sessionCapabilityTier !== "low") {
    matchedPreferences.push("capability_tier_match:medium");
    score += 5;
  }

  if (session.workspace_root && task.project_dir && session.workspace_root === task.project_dir) {
    matchedPreferences.push("workspace_root_match");
    score += 2;
  }

  const adaptiveSignal = evaluateAdaptiveRoutingSignal(session, taskProfile, explicitlyTargetedSession);
  blockers.push(...adaptiveSignal.blockers);
  matchedPreferences.push(...adaptiveSignal.matched_preferences);
  score += adaptiveSignal.adjustment;

  return {
    eligible: blockers.length === 0,
    score,
    blockers,
    matched_preferences: matchedPreferences,
    routing,
    task_profile: taskProfile,
    session_capability_tier: sessionCapabilityTier,
    adaptive_score_adjustment: adaptiveSignal.adjustment,
    session_performance: adaptiveSignal.summary,
  };
}

function compareTaskCandidates(left: AgentTaskCandidate, right: AgentTaskCandidate): number {
  const scoreDiff = right.routing.score - left.routing.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const priorityDiff = right.task.priority - left.task.priority;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  return left.task.created_at.localeCompare(right.task.created_at);
}

function isTaskClaimableNow(task: TaskRecord, nowIso: string) {
  if (task.status !== "pending") {
    return {
      claimable: false,
      reason: `not-pending:${task.status}`,
    };
  }
  if (task.available_at > nowIso) {
    return {
      claimable: false,
      reason: "not-ready",
    };
  }
  if (task.lease && task.lease.lease_expires_at > nowIso) {
    return {
      claimable: false,
      reason: "leased",
    };
  }
  return {
    claimable: true,
    reason: "claimable",
  };
}

function selectTaskCandidate(
  storage: Storage,
  session: AgentSessionRecord,
  options?: {
    task_id?: string;
    scan_limit?: number;
  }
): { candidate?: AgentTaskCandidate; reason: string; scanned: number } {
  const nowIso = new Date().toISOString();
  if (options?.task_id?.trim()) {
    const task = storage.getTaskById(options.task_id);
    if (!task) {
      return {
        reason: "not-found",
        scanned: 0,
      };
    }
    const claimability = isTaskClaimableNow(task, nowIso);
    if (!claimability.claimable) {
      return {
        reason: claimability.reason,
        scanned: 1,
      };
    }
    const routing = evaluateTaskRouting(session, task);
    if (!routing.eligible) {
      return {
        reason: `routing-ineligible:${routing.blockers.join("|")}`,
        scanned: 1,
      };
    }
    return {
      candidate: {
        task,
        routing,
      },
      reason: "selected",
      scanned: 1,
    };
  }

  const pendingTasks = storage.listTasks({
    status: "pending",
    limit: options?.scan_limit ?? 200,
  });
  const candidates = pendingTasks
    .map((task) => {
      const claimability = isTaskClaimableNow(task, nowIso);
      if (!claimability.claimable) {
        return null;
      }
      const routing = evaluateTaskRouting(session, task);
      if (!routing.eligible) {
        return null;
      }
      return {
        task,
        routing,
      } satisfies AgentTaskCandidate;
    })
    .filter((candidate): candidate is AgentTaskCandidate => candidate !== null)
    .sort(compareTaskCandidates);

  if (candidates.length === 0) {
    return {
      reason: pendingTasks.length > 0 ? "none-eligible" : "none-available",
      scanned: pendingTasks.length,
    };
  }

  return {
    candidate: candidates[0],
    reason: "selected",
    scanned: pendingTasks.length,
  };
}

export async function openAgentSession(storage: Storage, input: z.infer<typeof agentSessionOpenSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_open",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const opened = storage.upsertAgentSession({
        session_id: input.session_id,
        agent_id: input.agent_id,
        display_name: input.display_name,
        client_kind: input.client_kind,
        transport_kind: input.transport_kind,
        workspace_root: input.workspace_root,
        owner_id: input.owner_id,
        lease_seconds: input.lease_seconds,
        status: input.status,
        capabilities: input.capabilities,
        tags: input.tags,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const event = storage.appendRuntimeEvent({
        event_type: opened.created ? "agent.session_opened" : "agent.session_refreshed",
        entity_type: "agent_session",
        entity_id: opened.session.session_id,
        status: opened.session.status,
        summary: opened.created
          ? `Agent session ${opened.session.session_id} opened.`
          : `Agent session ${opened.session.session_id} refreshed.`,
        details: {
          agent_id: opened.session.agent_id,
          client_kind: opened.session.client_kind,
          transport_kind: opened.session.transport_kind,
          workspace_root: opened.session.workspace_root,
          capability_keys: Object.keys(opened.session.capabilities),
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ...opened,
        event,
      };
    },
  });
}

export function getAgentSession(storage: Storage, input: z.infer<typeof agentSessionGetSchema>) {
  const session = storage.getAgentSessionById(input.session_id);
  if (!session) {
    return {
      found: false,
      session_id: input.session_id,
    };
  }
  return {
    found: true,
    session,
  };
}

export function listAgentSessions(storage: Storage, input: z.infer<typeof agentSessionListSchema>) {
  const sessions = storage.listAgentSessions({
    status: input.status,
    agent_id: input.agent_id,
    client_kind: input.client_kind,
    active_only: input.active_only,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    agent_id_filter: input.agent_id ?? null,
    client_kind_filter: input.client_kind ?? null,
    active_only_filter: input.active_only ?? null,
    count: sessions.length,
    sessions,
  };
}

export async function heartbeatAgentSession(storage: Storage, input: z.infer<typeof agentSessionHeartbeatSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_heartbeat",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.heartbeatAgentSession({
        session_id: input.session_id,
        lease_seconds: input.lease_seconds,
        status: input.status,
        owner_id: input.owner_id,
        capabilities: input.capabilities,
        metadata: input.metadata,
      }),
  });
}

export async function closeAgentSession(storage: Storage, input: z.infer<typeof agentSessionCloseSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_close",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const closed = storage.closeAgentSession({
        session_id: input.session_id,
        metadata: input.metadata,
      });
      const event =
        closed.closed && closed.session
          ? storage.appendRuntimeEvent({
              event_type: "agent.session_closed",
              entity_type: "agent_session",
              entity_id: closed.session.session_id,
              status: closed.session.status,
              summary: `Agent session ${closed.session.session_id} closed.`,
              details: {
                agent_id: closed.session.agent_id,
                client_kind: closed.session.client_kind,
                ended_at: closed.session.ended_at,
              },
            })
          : null;
      return {
        ...closed,
        event,
      };
    },
  });
}

export function agentWorklist(storage: Storage, input: z.infer<typeof agentWorklistSchema>) {
  const session = storage.getAgentSessionById(input.session_id);
  if (!session) {
    return {
      found: false,
      reason: "session-not-found",
      session_id: input.session_id,
    };
  }

  const limit = input.limit ?? 20;
  const scanLimit = Math.max(limit, input.scan_limit ?? Math.min(Math.max(limit * 5, 50), 200));
  const nowIso = new Date().toISOString();
  const pendingTasks = storage.listTasks({
    status: "pending",
    limit: scanLimit,
  });

  const eligible: AgentTaskCandidate[] = [];
  const ineligible: Array<{
    task: TaskRecord;
    routing: TaskRoutingEvaluation;
    reason: string;
  }> = [];

  for (const task of pendingTasks) {
    const claimability = isTaskClaimableNow(task, nowIso);
    const routing = evaluateTaskRouting(session, task);
    if (claimability.claimable && routing.eligible) {
      eligible.push({
        task,
        routing,
      });
      continue;
    }
    if (input.include_ineligible) {
      ineligible.push({
        task,
        routing,
        reason: claimability.claimable ? routing.blockers.join("|") || "routing-ineligible" : claimability.reason,
      });
    }
  }

  eligible.sort(compareTaskCandidates);
  ineligible.sort((left, right) =>
    compareTaskCandidates(
      { task: left.task, routing: left.routing },
      { task: right.task, routing: right.routing }
    )
  );

  return {
    found: true,
    session,
    scanned_count: pendingTasks.length,
    eligible_count: eligible.length,
    returned_count: Math.min(limit, eligible.length),
    tasks: eligible.slice(0, limit).map((entry) => ({
      task_id: entry.task.task_id,
      objective: entry.task.objective,
      priority: entry.task.priority,
      project_dir: entry.task.project_dir,
      available_at: entry.task.available_at,
      tags: entry.task.tags,
      routing_score: entry.routing.score,
      adaptive_score_adjustment: entry.routing.adaptive_score_adjustment,
      matched_preferences: entry.routing.matched_preferences,
      routing: entry.routing.routing,
      task_profile: entry.routing.task_profile,
      session_capability_tier: entry.routing.session_capability_tier,
      session_performance: entry.routing.session_performance,
      task: entry.task,
    })),
    ineligible_count: ineligible.length,
    ineligible_tasks: input.include_ineligible
      ? ineligible.slice(0, limit).map((entry) => ({
          task_id: entry.task.task_id,
          objective: entry.task.objective,
          priority: entry.task.priority,
          reason: entry.reason,
          blockers: entry.routing.blockers,
          adaptive_score_adjustment: entry.routing.adaptive_score_adjustment,
          routing: entry.routing.routing,
          task_profile: entry.routing.task_profile,
          session_capability_tier: entry.routing.session_capability_tier,
          session_performance: entry.routing.session_performance,
          task: entry.task,
        }))
      : [],
  };
}

export async function agentClaimNext(storage: Storage, input: z.infer<typeof agentClaimNextSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.claim_next",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const session = storage.getAgentSessionById(input.session_id);
      if (!session) {
        return {
          claimed: false,
          reason: "session-not-found",
          session_id: input.session_id,
        };
      }
      if (session.status === "closed" || session.status === "failed") {
        return {
          claimed: false,
          reason: `session-not-claimable:${session.status}`,
          session,
        };
      }

      const existingTask = storage.getRunningTaskByWorkerId(session.session_id);
      if (existingTask) {
        const renewedSession = storage.heartbeatAgentSession({
          session_id: session.session_id,
          lease_seconds: input.lease_seconds ?? 300,
          status: "busy",
          metadata: {
            current_task_id: existingTask.task_id,
            last_claim_attempt_at: new Date().toISOString(),
            last_claim_reason: "session-already-holds-task",
            ...(input.metadata ?? {}),
          },
        });
        return {
          claimed: false,
          reason: "session-already-holds-task",
          session: renewedSession.session ?? session,
          task: existingTask,
          lease_expires_at: existingTask.lease?.lease_expires_at ?? null,
        };
      }

      const selection = selectTaskCandidate(storage, session, {
        task_id: input.task_id,
        scan_limit: 200,
      });
      if (!selection.candidate) {
        const nextStatus = selection.reason === "none-available" || selection.reason === "none-eligible" ? "idle" : session.status;
        const renewedSession = storage.heartbeatAgentSession({
          session_id: session.session_id,
          lease_seconds: input.lease_seconds ?? 300,
          status: nextStatus,
          metadata: {
            current_task_id: null,
            last_claim_attempt_at: new Date().toISOString(),
            last_claim_reason: selection.reason,
            last_claimed_task_id: null,
            scanned_task_count: selection.scanned,
            ...(input.metadata ?? {}),
          },
        });
        return {
          claimed: false,
          reason: selection.reason,
          session: renewedSession.session ?? session,
          scanned_task_count: selection.scanned,
        };
      }

      const claimed = storage.claimTask({
        worker_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
        task_id: selection.candidate.task.task_id,
      });
      const claimedAt = new Date().toISOString();
      const adaptiveWorkerProfile =
        claimed.claimed && claimed.task
          ? updateAdaptiveWorkerProfileOnClaim(
              session,
              claimed.task.task_id,
              selection.candidate.routing.task_profile,
              claimedAt
            )
          : getAdaptiveWorkerProfile(session);

      const nextStatus =
        claimed.claimed ? "busy" : claimed.reason === "none-available" || claimed.reason === "none-eligible" ? "idle" : session.status;
      const renewedSession = storage.heartbeatAgentSession({
        session_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
        status: nextStatus,
        metadata: {
          ...(input.metadata ?? {}),
          current_task_id: claimed.claimed ? claimed.task?.task_id ?? null : null,
          last_claim_attempt_at: new Date().toISOString(),
          last_claim_reason: claimed.reason,
          last_claimed_task_id: claimed.task?.task_id ?? null,
          scanned_task_count: selection.scanned,
          last_claim_routing_score: selection.candidate.routing.score,
          last_claim_routing_matches: selection.candidate.routing.matched_preferences,
          last_claim_adaptive_adjustment: selection.candidate.routing.adaptive_score_adjustment,
          current_task_claimed_at: claimed.claimed ? claimedAt : null,
          current_task_profile: claimed.claimed ? selection.candidate.routing.task_profile : null,
          session_performance_snapshot: selection.candidate.routing.session_performance,
          [ADAPTIVE_WORKER_PROFILE_KEY]: adaptiveWorkerProfile,
        },
      });

      const event =
        claimed.claimed && claimed.task
          ? storage.appendRuntimeEvent({
              event_type: "agent.task_claimed",
              entity_type: "task",
              entity_id: claimed.task.task_id,
              status: claimed.task.status,
              summary: `Task ${claimed.task.task_id} claimed through agent session ${session.session_id}.`,
              details: {
                session_id: session.session_id,
                agent_id: session.agent_id,
                client_kind: session.client_kind,
                task_id: claimed.task.task_id,
                lease_expires_at: claimed.lease_expires_at ?? null,
                routing_score: selection.candidate.routing.score,
                adaptive_score_adjustment: selection.candidate.routing.adaptive_score_adjustment,
                matched_preferences: selection.candidate.routing.matched_preferences,
                session_performance: selection.candidate.routing.session_performance,
              },
              source_client: session.source_client ?? input.source_client,
              source_model: session.source_model ?? input.source_model,
              source_agent: session.agent_id,
            })
          : null;

      return {
        ...claimed,
        session: renewedSession.session ?? session,
        routing: selection.candidate.routing,
        scanned_task_count: selection.scanned,
        event,
      };
    },
  });
}

export function agentCurrentTask(storage: Storage, input: z.infer<typeof agentCurrentTaskSchema>) {
  const session = storage.getAgentSessionById(input.session_id);
  if (!session) {
    return {
      found: false,
      reason: "session-not-found",
      session_id: input.session_id,
    };
  }
  const task = storage.getRunningTaskByWorkerId(session.session_id);
  if (!task) {
    return {
      found: false,
      reason: "no-active-task",
      session,
    };
  }
  return {
    found: true,
    session,
    task,
  };
}

export async function agentHeartbeatTask(storage: Storage, input: z.infer<typeof agentHeartbeatTaskSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.heartbeat_task",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const session = storage.getAgentSessionById(input.session_id);
      if (!session) {
        return {
          ok: false,
          reason: "session-not-found",
          session_id: input.session_id,
        };
      }
      const activeTask = storage.getRunningTaskByWorkerId(session.session_id);
      const taskId = input.task_id?.trim() || activeTask?.task_id || "";
      if (!taskId) {
        return {
          ok: false,
          reason: "no-active-task",
          session,
        };
      }
      const heartbeat = storage.heartbeatTaskLease({
        task_id: taskId,
        worker_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
      });
      const heartbeatAt = new Date().toISOString();
      const heartbeatTaskRecord = heartbeat.ok ? storage.getTaskById(taskId) ?? activeTask : activeTask ?? storage.getTaskById(taskId);
      const heartbeatTaskProfile = heartbeatTaskRecord ? resolveTaskExecutionProfile(heartbeatTaskRecord) : null;
      const adaptiveHeartbeat =
        heartbeat.ok && heartbeatTaskRecord && heartbeatTaskProfile
          ? updateAdaptiveWorkerProfileOnHeartbeat(session, taskId, heartbeatTaskProfile, heartbeatAt)
          : {
              profile: getAdaptiveWorkerProfile(session),
              stagnation_signaled: false,
            };
      const renewedSession =
        heartbeat.ok
          ? storage.heartbeatAgentSession({
              session_id: session.session_id,
              lease_seconds: input.lease_seconds ?? 300,
              status: "busy",
              metadata: {
                ...(input.metadata ?? {}),
                current_task_id: taskId,
                last_task_heartbeat_at: heartbeatAt,
                current_task_profile: heartbeatTaskProfile,
                [ADAPTIVE_WORKER_PROFILE_KEY]: adaptiveHeartbeat.profile,
              },
            })
          : { session };
      const event =
        heartbeat.ok && taskId
          ? storage.appendRuntimeEvent({
              event_type: "agent.task_heartbeat",
              entity_type: "task",
              entity_id: taskId,
              status: "running",
              summary: `Task ${taskId} heartbeat recorded through agent session ${session.session_id}.`,
              details: {
                session_id: session.session_id,
                agent_id: session.agent_id,
                task_id: taskId,
                lease_expires_at: heartbeat.lease_expires_at ?? null,
                heartbeat_at: heartbeat.heartbeat_at ?? null,
                stagnation_signaled: adaptiveHeartbeat.stagnation_signaled,
              },
              source_client: session.source_client ?? input.source_client,
              source_model: session.source_model ?? input.source_model,
              source_agent: session.agent_id,
            })
          : null;
      const stagnationEvent =
        heartbeat.ok && taskId && adaptiveHeartbeat.stagnation_signaled
          ? storage.appendRuntimeEvent({
              event_type: "agent.task_stagnation_detected",
              entity_type: "task",
              entity_id: taskId,
              status: "running",
              summary: `Task ${taskId} shows stagnation risk for agent session ${session.session_id}.`,
              details: {
                session_id: session.session_id,
                agent_id: session.agent_id,
                task_id: taskId,
                task_profile: heartbeatTaskProfile,
                heartbeat_count: adaptiveHeartbeat.profile.current_task.heartbeat_count,
              },
              source_client: session.source_client ?? input.source_client,
              source_model: session.source_model ?? input.source_model,
              source_agent: session.agent_id,
            })
          : null;
      return {
        ...heartbeat,
        session: renewedSession.session ?? session,
        task: heartbeatTaskRecord,
        adaptive_worker_profile: adaptiveHeartbeat.profile,
        stagnation_signaled: adaptiveHeartbeat.stagnation_signaled,
        events: {
          heartbeat: event,
          stagnation: stagnationEvent,
        },
      };
    },
  });
}

export async function agentReportResult(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof agentReportResultSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.report_result",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const session = storage.getAgentSessionById(input.session_id);
      if (!session) {
        return {
          reported: false,
          reason: "session-not-found",
          session_id: input.session_id,
          task_id: input.task_id,
        };
      }

      const taskBefore = storage.getTaskById(input.task_id);
      if (!taskBefore) {
        return {
          reported: false,
          reason: "task-not-found",
          session,
          task_id: input.task_id,
        };
      }
      if (taskBefore.lease?.owner_id !== session.session_id) {
        return {
          reported: false,
          reason: "owner-mismatch",
          session,
          task: taskBefore,
        };
      }

      const reportedArtifactIds = dedupeStrings(input.produced_artifact_ids);
      const outcomeResult =
        input.outcome === "completed"
          ? storage.completeTask({
              task_id: input.task_id,
              worker_id: session.session_id,
              result: input.result,
              summary: input.summary,
            })
          : storage.failTask({
              task_id: input.task_id,
              worker_id: session.session_id,
              error: input.error ?? "Task failed.",
              result: input.result,
              summary: input.summary,
            });

      const reported =
        input.outcome === "completed"
          ? (outcomeResult as ReturnType<typeof storage.completeTask>).completed
          : (outcomeResult as ReturnType<typeof storage.failTask>).failed;
      if (!reported) {
        return {
          reported: false,
          reason: outcomeResult.reason,
          session,
          task: outcomeResult.task ?? taskBefore,
        };
      }

      const task = outcomeResult.task ?? storage.getTaskById(input.task_id);
      if (!task) {
        throw new Error(`Task missing after agent report: ${input.task_id}`);
      }
      const taskProfile = resolveTaskExecutionProfile(task);

      const planContext = resolveTaskPlanContext(storage, task);
      const autoReportArtifact = recordAgentReportArtifact(storage, {
        session,
        task,
        outcome: input.outcome,
        result: input.result,
        summary: input.summary,
        error: input.error,
        run_id: input.run_id,
        observed_metric: input.observed_metric,
        observed_metrics: input.observed_metrics,
        experiment_verdict: input.experiment_verdict,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        planContext,
      });
      const producedArtifactIds = dedupeStrings([...reportedArtifactIds, autoReportArtifact.artifact_id]);
      const artifactLinks = attachArtifactsToTaskContext(
        storage,
        task,
        producedArtifactIds,
        {
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        },
        planContext
      );
      const expectedArtifactCheck = planContext
        ? evaluateExpectedArtifacts(storage, planContext.step, producedArtifactIds)
        : null;
      const missingExpectedArtifacts =
        input.outcome === "completed" &&
        expectedArtifactCheck !== null &&
        expectedArtifactCheck.expected_artifact_types.length > 0 &&
        !expectedArtifactCheck.satisfied;
      const adaptiveReport = updateAdaptiveWorkerProfileOnReport(
        session,
        task,
        taskProfile,
        input.outcome,
        new Date().toISOString(),
        {
          missing_expected_artifacts: missingExpectedArtifacts,
        }
      );

      const planStepUpdate = planContext
        ? storage.updatePlanStep({
            plan_id: planContext.plan.plan_id,
            step_id: planContext.step.step_id,
            status:
              input.outcome === "completed" ? (missingExpectedArtifacts ? "blocked" : "completed") : "failed",
            task_id: task.task_id,
            run_id: input.run_id,
            produced_artifact_ids: producedArtifactIds,
            metadata: {
              human_approval_required: false,
              dispatch_gate_type: missingExpectedArtifacts ? "artifact_evidence" : null,
              evidence_gate_required: missingExpectedArtifacts,
              artifact_expectations: expectedArtifactCheck ?? {
                expected_artifact_types: [],
                produced_artifact_ids: producedArtifactIds,
                produced_artifact_types: [],
                missing_artifact_types: [],
                satisfied: true,
              },
              last_agent_report: {
                session_id: session.session_id,
                agent_id: session.agent_id,
                reported_at: new Date().toISOString(),
                outcome: input.outcome,
                summary: input.summary?.trim() ?? null,
                error: input.error?.trim() ?? null,
                run_id: input.run_id ?? null,
                produced_artifact_ids: producedArtifactIds,
                result_keys: Object.keys(input.result ?? {}),
                metadata: input.metadata ?? {},
              },
            },
          })
        : null;
      const planStepEvent =
        planContext && planStepUpdate
          ? storage.appendRuntimeEvent({
              event_type: missingExpectedArtifacts
                ? "plan.step_evidence_blocked"
                : input.outcome === "completed"
                  ? "plan.step_completed"
                  : "plan.step_failed",
              entity_type: "step",
              entity_id: planContext.step.step_id,
              status: planStepUpdate.step.status,
              summary:
                missingExpectedArtifacts
                  ? `Plan step ${planContext.step.step_id} is blocked pending expected evidence artifacts.`
                  : input.summary?.trim() ||
                    `Plan step ${planContext.step.step_id} ${input.outcome === "completed" ? "completed" : "failed"} via agent report.`,
              details: {
                plan_id: planContext.plan.plan_id,
                goal_id: planContext.plan.goal_id,
                step_id: planContext.step.step_id,
                task_id: task.task_id,
                run_id: input.run_id ?? null,
                session_id: session.session_id,
                agent_id: session.agent_id,
                produced_artifact_ids: producedArtifactIds,
                expected_artifacts: expectedArtifactCheck,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: session.agent_id,
            })
          : null;

      const experimentRun = storage.findExperimentRunByTaskId(task.task_id);
      const experiment = experimentRun ? storage.getExperimentById(experimentRun.experiment_id) : null;
      const derivedExperimentObservation =
        experiment
          ? deriveExperimentObservation(experiment, {
              observed_metric: input.observed_metric,
              observed_metrics: input.observed_metrics,
              result: input.result,
              metadata: input.metadata,
              summary: input.summary,
            })
          : {
              observed_metric: input.observed_metric,
              observed_metrics: input.observed_metrics,
              source: null,
            };
      const experimentUpdate =
        experimentRun &&
        ((derivedExperimentObservation.observed_metric ?? null) !== null || input.experiment_verdict || input.outcome === "failed")
          ? judgeExperimentRunWithStorage(storage, {
              experiment_id: experimentRun.experiment_id,
              experiment_run_id: experimentRun.experiment_run_id,
              status: input.outcome === "failed" ? "crash" : "completed",
              verdict: input.experiment_verdict,
              task_id: task.task_id,
              run_id: input.run_id,
              observed_metric: derivedExperimentObservation.observed_metric,
              observed_metrics: derivedExperimentObservation.observed_metrics,
              summary: input.summary,
              error_text: input.outcome === "failed" ? input.error : undefined,
              artifact_ids: producedArtifactIds,
              metadata: {
                ...(input.metadata ?? {}),
                ...(derivedExperimentObservation.source
                  ? { observed_metric_source: derivedExperimentObservation.source }
                  : {}),
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            })
          : experimentRun
            ? {
                ok: true,
                followup_required: true,
                experiment_id: experimentRun.experiment_id,
                experiment_run_id: experimentRun.experiment_run_id,
                reason: "call experiment.judge with observed metrics to finalize benchmark selection",
              }
            : null;

      const renewedSession = storage.heartbeatAgentSession({
        session_id: session.session_id,
        lease_seconds: 300,
        status: input.next_session_status ?? "idle",
        metadata: {
          ...(input.metadata ?? {}),
          current_task_id: null,
          last_reported_task_id: task.task_id,
          last_reported_at: new Date().toISOString(),
          last_report_outcome: input.outcome,
          last_run_id: input.run_id ?? null,
          last_produced_artifact_ids: producedArtifactIds,
          last_report_completion_seconds: adaptiveReport.completion_seconds,
          current_task_profile: null,
          [ADAPTIVE_WORKER_PROFILE_KEY]: adaptiveReport.profile,
        },
      });
      const goalAutorunTrigger = shouldTriggerGoalAutorun(storage, task, planContext);
      const goalAutorun =
        input.outcome === "completed" &&
        !missingExpectedArtifacts &&
        goalAutorunTrigger.enabled &&
        goalAutorunTrigger.goal_id
          ? ((await invokeTool("goal.autorun", {
              mutation: buildAgentDerivedMutation(input.mutation, `goal-autorun:${task.task_id}`),
              goal_id: goalAutorunTrigger.goal_id,
              create_plan_if_missing: false,
              max_passes: goalAutorunTrigger.max_passes ?? 4,
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: session.agent_id,
            })) as Record<string, unknown>)
          : {
              triggered: false,
              reason:
                input.outcome !== "completed"
                  ? "task_failed"
                  : missingExpectedArtifacts
                    ? "missing_expected_artifacts"
                    : goalAutorunTrigger.reason,
            };
      const agentTaskEvent = storage.appendRuntimeEvent({
        event_type: "agent.task_reported",
        entity_type: "task",
        entity_id: task.task_id,
        status: task.status,
        summary:
          input.summary?.trim() ||
          `Task ${task.task_id} ${input.outcome === "completed" ? "completed" : "failed"} through agent session ${session.session_id}.`,
        details: {
          session_id: session.session_id,
          agent_id: session.agent_id,
          task_id: task.task_id,
          outcome: input.outcome,
          run_id: input.run_id ?? null,
          produced_artifact_ids: producedArtifactIds,
          artifact_links_created: artifactLinks.length,
          auto_report_artifact_id: autoReportArtifact.artifact_id,
          experiment_run_id: experimentRun?.experiment_run_id ?? null,
          goal_autorun_triggered: goalAutorunTrigger.enabled && input.outcome === "completed",
          expected_artifacts: expectedArtifactCheck,
          adaptive_worker_profile: summarizeAdaptiveWorkerProfile(adaptiveReport.profile, taskProfile.complexity),
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: session.agent_id,
      });

      return {
        reported: true,
        reason: input.outcome,
        task,
        session: renewedSession.session ?? session,
        plan_step_update: planStepUpdate,
        produced_artifact_ids: producedArtifactIds,
        auto_report_artifact_id: autoReportArtifact.artifact_id,
        artifact_links_created: artifactLinks.length,
        artifact_links: artifactLinks,
        experiment: experimentUpdate,
        evidence_gate: expectedArtifactCheck,
        adaptive_worker_profile: adaptiveReport.profile,
        goal_autorun: goalAutorun,
        events: {
          task: agentTaskEvent,
          step: planStepEvent,
        },
      };
    },
  });
}
