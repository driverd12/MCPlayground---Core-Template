import { z } from "zod";
import { Storage, type AgentSessionRecord, type PlanRecord, type PlanStepRecord, type TaskRecord } from "../storage.js";
import {
  mergeDeclaredPermissionProfile,
  recordBudgetLedgerUsage,
  resolveSessionPermissionProfileId,
  taskPermissionProfileIsEligible,
} from "../control_plane_runtime.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { deriveExperimentObservation, judgeExperimentRunWithStorage } from "./experiment.js";
import { type TaskExecutionProfile, resolveTaskExecutionProfile } from "./task.js";
import { budgetUsageSchema } from "./control_plane_admin.js";

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
  permission_profile: z.enum(["read_only", "bounded_execute", "network_enabled", "high_risk"]).optional(),
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
  permission_profile: z.enum(["read_only", "bounded_execute", "network_enabled", "high_risk"]).optional(),
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
    usage: budgetUsageSchema.optional(),
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

function buildAgentReportCompletionResult(
  input: z.infer<typeof agentReportResultSchema>,
  reportedArtifactIds: string[]
): Record<string, unknown> | undefined {
  const result = input.result ?? {};
  if (input.outcome !== "completed" || reportedArtifactIds.length === 0) {
    return input.result;
  }
  const existingEvidence =
    result.completion_evidence && typeof result.completion_evidence === "object" && !Array.isArray(result.completion_evidence)
      ? (result.completion_evidence as Record<string, unknown>)
      : {};
  const existingEvidenceRefs = Array.isArray(existingEvidence.evidence_refs)
    ? existingEvidence.evidence_refs.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const existingProducedArtifactIds = Array.isArray(existingEvidence.produced_artifact_ids)
    ? existingEvidence.produced_artifact_ids.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  return {
    ...result,
    completion_evidence: {
      ...existingEvidence,
      evidence_refs: dedupeStrings([...existingEvidenceRefs, ...reportedArtifactIds.map((artifactId) => `artifact:${artifactId}`)]),
      produced_artifact_ids: dedupeStrings([...existingProducedArtifactIds, ...reportedArtifactIds]),
      ...(input.summary?.trim() ? { verification_summary: input.summary.trim() } : {}),
      ...(input.run_id?.trim() ? { run_id: input.run_id.trim() } : {}),
    },
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function readTimestampMs(value: unknown): number | null {
  const text = readString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
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
  session_permission_profile_id: string;
  task_permission_profile_id: string;
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

export type AdaptiveWorkerProfile = {
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

export type AdaptiveSessionPerformanceSummary = {
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
  recent_claims: number;
  recent_completed: number;
  recent_failed: number;
  recent_stagnation_signals: number;
  recent_evidence_blocks: number;
  recent_completion_rate: number | null;
  recent_failure_rate: number | null;
  recent_stagnation_rate: number | null;
  effective_recent_failed: number;
  effective_recent_stagnation_signals: number;
  effective_recent_evidence_blocks: number;
  recovery_streak: number;
  recovery_credit: number;
  complexity: TaskExecutionProfile["complexity"];
  complexity_stats: AdaptiveComplexityStats;
  recent_complexity_stats: AdaptiveComplexityStats;
};

export type AdaptiveSessionHealthState = "unproven" | "healthy" | "degraded" | "suppressed";

export type AdaptiveSessionHealthSummary = {
  adaptive_state: AdaptiveSessionHealthState;
  adaptive_reasons: string[];
  performance: {
    low: AdaptiveSessionPerformanceSummary;
    medium: AdaptiveSessionPerformanceSummary;
    high: AdaptiveSessionPerformanceSummary;
  };
};

type AdaptiveRoutingSignal = {
  adjustment: number;
  blockers: string[];
  matched_preferences: string[];
  summary: AdaptiveSessionPerformanceSummary;
};

type AdaptiveDispatchCandidate = {
  session: AgentSessionRecord;
  capability_tier: "low" | "medium" | "high";
  health: AdaptiveSessionHealthSummary;
  score: number;
  eligible: boolean;
  blockers: string[];
  reasons: string[];
};

export type AdaptiveDispatchRoutingGuidance = {
  task_profile: TaskExecutionProfile;
  routing: TaskRoutingRule | null;
  mode: "preferred_pool" | "fallback_degraded" | "none";
  recommended_sessions: Array<{
    session_id: string;
    agent_id: string;
    client_kind: string | null;
    adaptive_state: AdaptiveSessionHealthState;
    score: number;
    capability_tier: "low" | "medium" | "high";
  }>;
  summary: {
    healthy_count: number;
    unproven_count: number;
    degraded_count: number;
    suppressed_count: number;
    eligible_count: number;
    mode: "preferred_pool" | "fallback_degraded" | "none";
    rationale: string;
  };
};

export const ADAPTIVE_WORKER_PROFILE_KEY = "adaptive_worker_profile";
const ADAPTIVE_RECENT_OUTCOME_WINDOW = 6;
const ADAPTIVE_RECOVERY_FAILURE_CREDIT_EVERY = 2;
const ADAPTIVE_RECOVERY_STAGNATION_CREDIT_EVERY = 3;
const ADAPTIVE_RECOVERY_EVIDENCE_CREDIT_EVERY = 2;

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

type NormalizedAdaptiveRecentOutcome = {
  task_id: string | null;
  outcome: "completed" | "failed";
  reported_at: string | null;
  complexity: TaskExecutionProfile["complexity"] | null;
  missing_expected_artifacts: boolean;
  stagnation_signaled: boolean;
  completion_seconds: number | null;
};

type AdaptiveRecentOutcomeSummary = {
  recent_claims: number;
  recent_completed: number;
  recent_failed: number;
  recent_stagnation_signals: number;
  recent_evidence_blocks: number;
  recent_completion_rate: number | null;
  recent_failure_rate: number | null;
  recent_stagnation_rate: number | null;
  effective_recent_failed: number;
  effective_recent_stagnation_signals: number;
  effective_recent_evidence_blocks: number;
  recovery_streak: number;
  recovery_credit: number;
  recent_complexity_stats: AdaptiveComplexityStats;
};

function normalizeAdaptiveRecentOutcome(value: Record<string, unknown>): NormalizedAdaptiveRecentOutcome | null {
  const outcome = readString(value.outcome);
  if (outcome !== "completed" && outcome !== "failed") {
    return null;
  }
  const complexityValue = readString(value.complexity);
  const complexity =
    complexityValue === "low" || complexityValue === "medium" || complexityValue === "high"
      ? (complexityValue as TaskExecutionProfile["complexity"])
      : null;
  return {
    task_id: readString(value.task_id),
    outcome,
    reported_at: readString(value.reported_at),
    complexity,
    missing_expected_artifacts: readBoolean(value.missing_expected_artifacts) ?? false,
    stagnation_signaled: readBoolean(value.stagnation_signaled) ?? false,
    completion_seconds: readNonNegativeNumber(value.completion_seconds),
  };
}

function summarizeAdaptiveRecentOutcomes(
  profile: AdaptiveWorkerProfile,
  complexity: TaskExecutionProfile["complexity"]
): AdaptiveRecentOutcomeSummary {
  const recent = profile.recent_outcomes
    .map((entry) => normalizeAdaptiveRecentOutcome(entry))
    .filter((entry): entry is NormalizedAdaptiveRecentOutcome => entry !== null)
    .slice(-ADAPTIVE_RECENT_OUTCOME_WINDOW);
  const recentComplexity = recent.filter((entry) => entry.complexity === complexity);
  let recoveryStreak = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index]?.outcome !== "completed") {
      break;
    }
    recoveryStreak += 1;
  }
  const recoveryCredit = Math.floor(recoveryStreak / ADAPTIVE_RECOVERY_FAILURE_CREDIT_EVERY);
  const recentCompleted = recent.filter((entry) => entry.outcome === "completed").length;
  const recentFailed = recent.filter((entry) => entry.outcome === "failed").length;
  const recentStagnations = recent.filter((entry) => entry.stagnation_signaled).length;
  const recentEvidenceBlocks = recent.filter((entry) => entry.missing_expected_artifacts).length;
  const recentClaims = recent.length;
  return {
    recent_claims: recentClaims,
    recent_completed: recentCompleted,
    recent_failed: recentFailed,
    recent_stagnation_signals: recentStagnations,
    recent_evidence_blocks: recentEvidenceBlocks,
    recent_completion_rate: recentClaims > 0 ? recentCompleted / recentClaims : null,
    recent_failure_rate: recentClaims > 0 ? Math.max(0, recentFailed - recoveryCredit) / recentClaims : null,
    recent_stagnation_rate:
      recentClaims > 0
        ? Math.max(0, recentStagnations - Math.floor(recoveryStreak / ADAPTIVE_RECOVERY_STAGNATION_CREDIT_EVERY)) /
          recentClaims
        : null,
    effective_recent_failed: Math.max(0, recentFailed - recoveryCredit),
    effective_recent_stagnation_signals: Math.max(
      0,
      recentStagnations - Math.floor(recoveryStreak / ADAPTIVE_RECOVERY_STAGNATION_CREDIT_EVERY)
    ),
    effective_recent_evidence_blocks: Math.max(
      0,
      recentEvidenceBlocks - Math.floor(recoveryStreak / ADAPTIVE_RECOVERY_EVIDENCE_CREDIT_EVERY)
    ),
    recovery_streak: recoveryStreak,
    recovery_credit: recoveryCredit,
    recent_complexity_stats: {
      claims: recentComplexity.length,
      completions: recentComplexity.filter((entry) => entry.outcome === "completed").length,
      failures: recentComplexity.filter((entry) => entry.outcome === "failed").length,
      stagnations: recentComplexity.filter((entry) => entry.stagnation_signaled).length,
      evidence_blocks: recentComplexity.filter((entry) => entry.missing_expected_artifacts).length,
      average_completion_seconds:
        recentComplexity.filter((entry) => entry.outcome === "completed" && entry.completion_seconds !== null).length > 0
          ? Math.round(
              (recentComplexity
                .filter((entry): entry is NormalizedAdaptiveRecentOutcome & { completion_seconds: number } =>
                  entry.outcome === "completed" && entry.completion_seconds !== null
                )
                .reduce((total, entry) => total + entry.completion_seconds, 0) /
                recentComplexity.filter(
                  (entry) => entry.outcome === "completed" && entry.completion_seconds !== null
                ).length) *
                1000
            ) / 1000
          : null,
      last_completion_seconds:
        recentComplexity
          .slice()
          .reverse()
          .find((entry) => entry.outcome === "completed" && entry.completion_seconds !== null)?.completion_seconds ?? null,
    },
  };
}

export function getAdaptiveWorkerProfile(session: AgentSessionRecord): AdaptiveWorkerProfile {
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
    reasoning_policy_review_required?: boolean;
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
    if (options.missing_expected_artifacts || options.reasoning_policy_review_required === true) {
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
      reasoning_policy_review_required: options.reasoning_policy_review_required === true,
      evidence_blocked: options.missing_expected_artifacts || options.reasoning_policy_review_required === true,
      completion_seconds: completionSeconds,
      stagnation_signaled: currentTask.stagnation_signaled,
    },
  ];

  return {
    profile,
    completion_seconds: completionSeconds,
  };
}

function syncAdaptiveWorkerProfileFromSessionHeartbeat(
  session: AgentSessionRecord | null,
  metadata: Record<string, unknown>
) {
  if (!session || !Object.prototype.hasOwnProperty.call(metadata, "current_task_id")) {
    return metadata;
  }
  if (readString(metadata.current_task_id)) {
    return metadata;
  }
  const profile = getAdaptiveWorkerProfile(session);
  if (profile.current_task.task_id === null) {
    return metadata;
  }
  return {
    ...metadata,
    current_task_id: null,
    current_task_profile: null,
    [ADAPTIVE_WORKER_PROFILE_KEY]: {
      ...profile,
      current_task: emptyAdaptiveCurrentTaskState(),
    },
  };
}

export function summarizeAdaptiveWorkerProfile(
  profile: AdaptiveWorkerProfile,
  complexity: TaskExecutionProfile["complexity"]
): AdaptiveSessionPerformanceSummary {
  const totalClaims = Math.max(profile.total_claims, 0);
  const recent = summarizeAdaptiveRecentOutcomes(profile, complexity);
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
    recent_claims: recent.recent_claims,
    recent_completed: recent.recent_completed,
    recent_failed: recent.recent_failed,
    recent_stagnation_signals: recent.recent_stagnation_signals,
    recent_evidence_blocks: recent.recent_evidence_blocks,
    recent_completion_rate: recent.recent_completion_rate,
    recent_failure_rate: recent.recent_failure_rate,
    recent_stagnation_rate: recent.recent_stagnation_rate,
    effective_recent_failed: recent.effective_recent_failed,
    effective_recent_stagnation_signals: recent.effective_recent_stagnation_signals,
    effective_recent_evidence_blocks: recent.effective_recent_evidence_blocks,
    recovery_streak: recent.recovery_streak,
    recovery_credit: recent.recovery_credit,
    complexity,
    complexity_stats: getAdaptiveComplexityStats(profile, complexity),
    recent_complexity_stats: recent.recent_complexity_stats,
  };
}

export function summarizeAdaptiveSessionHealth(session: AgentSessionRecord): AdaptiveSessionHealthSummary {
  const profile = getAdaptiveWorkerProfile(session);
  const performance = {
    low: summarizeAdaptiveWorkerProfile(profile, "low"),
    medium: summarizeAdaptiveWorkerProfile(profile, "medium"),
    high: summarizeAdaptiveWorkerProfile(profile, "high"),
  };
  const recentSessionSignals = summarizeAdaptiveRecentOutcomes(profile, "low");
  const reasons: string[] = [];
  let adaptiveState: AdaptiveSessionHealthState = "unproven";
  const hasRecentFailureDebt = recentSessionSignals.effective_recent_failed > 0;
  const hasRecentStagnationDebt = recentSessionSignals.effective_recent_stagnation_signals > 0;
  const recentEvidenceDebt = recentSessionSignals.effective_recent_evidence_blocks;
  const metadata = isRecord(session.metadata) ? session.metadata : {};
  const lastTickOk = readBoolean(metadata.last_tick_ok) ?? false;
  const lastTickAtMs = readTimestampMs(metadata.last_tick_at);
  const lastFailedAtMs = readTimestampMs(profile.last_failed_at);
  const lastCompletedAtMs = readTimestampMs(profile.last_completed_at);
  const mildFailureDebtRecovered =
    hasRecentFailureDebt &&
    recentSessionSignals.effective_recent_failed <= 2 &&
    !hasRecentStagnationDebt &&
    recentEvidenceDebt === 0 &&
    profile.total_claims >= 10 &&
    profile.total_completed >= Math.max(8, profile.total_failed * 3) &&
    recentSessionSignals.recent_completed >= Math.max(4, recentSessionSignals.effective_recent_failed * 2) &&
    profile.current_task.task_id === null &&
    lastFailedAtMs !== null &&
    (
      (lastTickOk && lastTickAtMs !== null && lastTickAtMs > lastFailedAtMs) ||
      (lastCompletedAtMs !== null &&
        lastCompletedAtMs > lastFailedAtMs &&
        recentSessionSignals.recovery_streak >= 1)
    );
  const residualDebtRecovered =
    (hasRecentFailureDebt || recentEvidenceDebt > 0) &&
    recentSessionSignals.effective_recent_failed <= 3 &&
    recentEvidenceDebt <= 2 &&
    !hasRecentStagnationDebt &&
    profile.current_task.task_id === null &&
    profile.total_claims >= 12 &&
    profile.total_completed >= Math.max(10, profile.total_failed * 3) &&
    recentSessionSignals.recovery_streak >= Math.max(4, recentSessionSignals.effective_recent_failed + recentEvidenceDebt) &&
    recentSessionSignals.recent_completed >=
      Math.max(5, recentSessionSignals.effective_recent_failed + recentEvidenceDebt) &&
    (
      (lastTickOk && lastTickAtMs !== null && (lastFailedAtMs === null || lastTickAtMs > lastFailedAtMs)) ||
      (lastCompletedAtMs !== null && (lastFailedAtMs === null || lastCompletedAtMs > lastFailedAtMs))
    );
  const evidenceDebtRecovered =
    !hasRecentFailureDebt &&
    !hasRecentStagnationDebt &&
    recentEvidenceDebt > 0 &&
    recentSessionSignals.recovery_streak >=
      Math.max(4, recentEvidenceDebt * ADAPTIVE_RECOVERY_EVIDENCE_CREDIT_EVERY);

  if (profile.total_claims === 0) {
    adaptiveState = "unproven";
    reasons.push("No adaptive routing history has been recorded yet.");
  } else if (profile.consecutive_failures >= 2 || profile.consecutive_stagnation_signals >= 1) {
    adaptiveState = "suppressed";
    if (profile.consecutive_failures >= 2) {
      reasons.push(`Suppressed after ${profile.consecutive_failures} consecutive failures.`);
    }
    if (profile.consecutive_stagnation_signals >= 1) {
      reasons.push(`Suppressed after ${profile.consecutive_stagnation_signals} recent stagnation signal(s).`);
    }
  } else if (
    (hasRecentFailureDebt && !mildFailureDebtRecovered && !residualDebtRecovered) ||
    hasRecentStagnationDebt ||
    (recentEvidenceDebt > 0 && !evidenceDebtRecovered && !residualDebtRecovered)
  ) {
    adaptiveState = "degraded";
    if (hasRecentFailureDebt) {
      reasons.push(`${recentSessionSignals.effective_recent_failed} recent failed task signal(s) still need recovery.`);
    }
    if (hasRecentStagnationDebt) {
      reasons.push(
        `${recentSessionSignals.effective_recent_stagnation_signals} recent stagnation signal(s) still need recovery.`
      );
    }
    if (recentEvidenceDebt > 0 && !evidenceDebtRecovered) {
      reasons.push(
        `${recentEvidenceDebt} recent evidence-blocked completion(s) still need recovery.`
      );
    }
  } else {
    adaptiveState = "healthy";
    const recoveryStreak = recentSessionSignals.recovery_streak;
    if (mildFailureDebtRecovered) {
      reasons.push(
        "Recent routing history is operationally recovered: mild recent failed-task debt remains in history, but strong bounded recovery has already resumed."
      );
    } else if (residualDebtRecovered) {
      reasons.push(
        "Recent routing history is operationally recovered: residual failure or evidence debt remains in history, but repeated successful bounded recovery has already re-established a healthy lane."
      );
    } else if (evidenceDebtRecovered) {
      reasons.push(
        `Recent routing history is stable and a recovery streak of ${recoveryStreak} completion(s) is outweighing ${recentEvidenceDebt} remaining evidence-quality signal(s).`
      );
    } else if (profile.total_failed > 0 || profile.total_stagnation_signals > 0 || profile.total_evidence_blocks > 0) {
      reasons.push(
        recoveryStreak > 0
          ? `Recent routing history is stable and a recovery streak of ${recoveryStreak} completion(s) is offsetting older failures.`
          : "Recent routing history is stable despite older recovered failures."
      );
    } else {
      reasons.push("Recent routing history is stable.");
    }
  }

  return {
    adaptive_state: adaptiveState,
    adaptive_reasons: reasons,
    performance,
  };
}

function canCapabilityTierHandleTask(
  capabilityTier: "low" | "medium" | "high",
  taskProfile: TaskExecutionProfile
) {
  if (taskProfile.complexity === "high") {
    return capabilityTier === "high";
  }
  if (taskProfile.complexity === "medium") {
    return capabilityTier !== "low";
  }
  return true;
}

function evaluateAdaptiveDispatchCandidate(
  session: AgentSessionRecord,
  taskProfile: TaskExecutionProfile,
  projectDir: string | null
): AdaptiveDispatchCandidate {
  const capabilityTier = resolveSessionCapabilityTier(session);
  const health = summarizeAdaptiveSessionHealth(session);
  const blockers: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  if (!canCapabilityTierHandleTask(capabilityTier, taskProfile)) {
    blockers.push(`insufficient_capability_tier:${taskProfile.complexity}`);
  } else {
    score += taskProfile.complexity === "high" ? 15 : taskProfile.complexity === "medium" ? 8 : 4;
    reasons.push(`capability_tier:${capabilityTier}`);
  }

  if (projectDir && session.workspace_root && session.workspace_root === projectDir) {
    score += 3;
    reasons.push("workspace_root_match");
  }

  if (session.status === "busy") {
    score -= 6;
    reasons.push("session_busy");
  } else if (session.status === "idle" || session.status === "active") {
    score += 3;
    reasons.push(`session_status:${session.status}`);
  }

  if (health.adaptive_state === "healthy") {
    score += 35;
    reasons.push("adaptive_state:healthy");
  } else if (health.adaptive_state === "unproven") {
    score += 12;
    reasons.push("adaptive_state:unproven");
  } else if (health.adaptive_state === "degraded") {
    score -= 6;
    reasons.push("adaptive_state:degraded");
  } else {
    score -= 25;
    reasons.push("adaptive_state:suppressed");
  }

  return {
    session,
    capability_tier: capabilityTier,
    health,
    score,
    eligible: blockers.length === 0,
    blockers,
    reasons,
  };
}

function compareAdaptiveDispatchCandidates(left: AdaptiveDispatchCandidate, right: AdaptiveDispatchCandidate) {
  const scoreDiff = right.score - left.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  return left.session.updated_at.localeCompare(right.session.updated_at);
}

export function recommendAdaptiveDispatchRouting(
  storage: Storage,
  task: Pick<TaskRecord, "objective" | "project_dir" | "payload" | "tags" | "metadata">
): AdaptiveDispatchRoutingGuidance {
  const taskProfile = resolveTaskExecutionProfile(task);
  const sessions = storage.listAgentSessions({
    active_only: true,
    limit: 100,
  });
  const candidates = sessions
    .map((session) => evaluateAdaptiveDispatchCandidate(session, taskProfile, task.project_dir ?? null))
    .filter((candidate) => candidate.eligible)
    .sort(compareAdaptiveDispatchCandidates);

  const healthy = candidates.filter((candidate) => candidate.health.adaptive_state === "healthy");
  const unproven = candidates.filter((candidate) => candidate.health.adaptive_state === "unproven");
  const degraded = candidates.filter((candidate) => candidate.health.adaptive_state === "degraded");
  const suppressed = candidates.filter((candidate) => candidate.health.adaptive_state === "suppressed");

  let pool: AdaptiveDispatchCandidate[] = [];
  let mode: AdaptiveDispatchRoutingGuidance["mode"] = "none";
  let rationale = "No eligible active sessions are available for adaptive assignment guidance.";

  if (healthy.length > 0 || unproven.length > 0) {
    pool = [...healthy, ...unproven].sort(compareAdaptiveDispatchCandidates);
    mode = "preferred_pool";
    rationale =
      healthy.length > 0
        ? "Healthy or unproven sessions are available, so degraded and suppressed sessions are excluded."
        : "Only unproven sessions are available, so they are preferred over degraded history.";
  } else if (degraded.length > 0) {
    pool = [...degraded].sort(compareAdaptiveDispatchCandidates);
    mode = "fallback_degraded";
    rationale = "Only degraded sessions are available, so dispatch falls back to them explicitly.";
  }

  const preferred = pool.slice(0, 2);
  const allowed = pool.slice(0, 4);
  const routing =
    pool.length > 0
      ? {
          preferred_agent_ids: preferred.map((candidate) => candidate.session.agent_id),
          allowed_agent_ids: allowed.map((candidate) => candidate.session.agent_id),
          preferred_client_kinds: preferred
            .map((candidate) => readString(candidate.session.client_kind))
            .filter((value): value is string => Boolean(value)),
          allowed_client_kinds: allowed
            .map((candidate) => readString(candidate.session.client_kind))
            .filter((value): value is string => Boolean(value)),
          required_capabilities: [],
          preferred_capabilities: [],
        }
      : null;

  return {
    task_profile: taskProfile,
    routing,
    mode,
    recommended_sessions: pool.map((candidate) => ({
      session_id: candidate.session.session_id,
      agent_id: candidate.session.agent_id,
      client_kind: candidate.session.client_kind,
      adaptive_state: candidate.health.adaptive_state,
      score: candidate.score,
      capability_tier: candidate.capability_tier,
    })),
    summary: {
      healthy_count: healthy.length,
      unproven_count: unproven.length,
      degraded_count: degraded.length,
      suppressed_count: suppressed.length,
      eligible_count: candidates.length,
      mode,
      rationale,
    },
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

  const adaptiveClaimCount = summary.recent_claims > 0 ? summary.recent_claims : summary.total_claims;
  if (adaptiveClaimCount > 0) {
    adjustment += Math.round((summary.recent_completion_rate ?? summary.completion_rate ?? 0) * 8);
    adjustment -= Math.round((summary.recent_failure_rate ?? summary.failure_rate ?? 0) * 10);
    adjustment -= Math.round((summary.recent_stagnation_rate ?? summary.stagnation_rate ?? 0) * 10);
    adjustment -= Math.round(
      ((summary.recent_claims > 0 ? summary.effective_recent_evidence_blocks : summary.total_evidence_blocks) / adaptiveClaimCount) * 6
    );
  }

  const complexitySignals = summary.recent_complexity_stats.claims > 0 ? summary.recent_complexity_stats : summary.complexity_stats;
  const complexityClaims = complexitySignals.claims;
  if (complexityClaims >= 2) {
    adjustment += Math.round((complexitySignals.completions / complexityClaims) * 8);
    adjustment -= Math.round((complexitySignals.failures / complexityClaims) * 10);
    adjustment -= Math.round((complexitySignals.stagnations / complexityClaims) * 10);
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

type ReasoningPolicyRecoveryQueueResult = {
  queued: boolean;
  created: boolean;
  task_id: string | null;
  task: unknown;
  event: unknown;
  skipped_reason: string | null;
  error?: string;
};

function buildReasoningPolicyRecoveryTaskId(sourceTaskId: string): string {
  const safeTaskId = sourceTaskId.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 160);
  return `reasoning-review-${safeTaskId}`;
}

function boundedReasoningCandidateCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.min(4, Math.round(value)));
}

function buildReasoningPolicyRecoveryEvidenceRequirements(missingFields: string[], candidateCount: number): string[] {
  const missing = new Set(missingFields);
  const requirements: string[] = [];
  if (missing.has("candidate_evidence")) {
    requirements.push(
      `Provide at least ${candidateCount} bounded candidate paths or failure hypotheses, each with concrete evidence and contradiction risk.`
    );
  }
  if (missing.has("selection_rationale")) {
    requirements.push(
      "Provide selected_candidate_id plus selection_rationale grounded in the candidate evidence and explain why rejected candidates lost."
    );
  }
  if (missing.has("plan_pass")) {
    requirements.push(
      "Provide plan_summary or planned_steps before changing state so the verification path is decomposed and auditable."
    );
  }
  if ([...missing].some((field) => field.startsWith("plan_quality_") || field === "plan_step_budget")) {
    requirements.push(
      "Provide a compact plan_quality_gate proving constraints were covered, rollback was noted, and evidence requirements were mapped before execution."
    );
  }
  if (missing.has("verification_pass")) {
    requirements.push(
      "Provide verification_summary plus checks, test_results, or evidence_refs that prove the selected path was validated."
    );
  }
  if (requirements.length === 0) {
    requirements.push("Re-run the reasoning-policy audit and provide any missing grounded evidence before unblocking the step.");
  }
  return requirements;
}

function readTaskPermissionProfile(value: unknown): "read_only" | "bounded_execute" | "network_enabled" | "high_risk" | undefined {
  const text = readString(value);
  return text === "read_only" || text === "bounded_execute" || text === "network_enabled" || text === "high_risk"
    ? text
    : undefined;
}

async function queueReasoningPolicyRecoveryTask(params: {
  storage: Storage;
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  input: z.infer<typeof agentReportResultSchema>;
  session: AgentSessionRecord;
  task: TaskRecord;
  planContext: { plan: PlanRecord; step: PlanStepRecord } | null;
  reasoningPolicyAudit: Record<string, unknown> | null;
  producedArtifactIds: string[];
  autoReportArtifactId: string;
}): Promise<ReasoningPolicyRecoveryQueueResult> {
  const skipped = (skippedReason: string, error?: string): ReasoningPolicyRecoveryQueueResult => ({
    queued: false,
    created: false,
    task_id: null,
    task: null,
    event: null,
    skipped_reason: skippedReason,
    ...(error ? { error } : {}),
  });

  if (!params.planContext) {
    return skipped("no-plan-context");
  }
  if (!params.reasoningPolicyAudit) {
    return skipped("no-reasoning-policy-audit");
  }

  const existingRecovery = isRecord(params.task.metadata.reasoning_policy_recovery)
    ? params.task.metadata.reasoning_policy_recovery
    : null;
  const existingRecoveryDepth = readPositiveInt(existingRecovery?.depth) ?? 0;
  if (existingRecovery?.kind === "reasoning_policy_review_recovery" || existingRecoveryDepth >= 1) {
    return skipped("recovery-depth-exhausted");
  }

  const sourceExecution = isRecord(params.task.metadata.task_execution) ? params.task.metadata.task_execution : {};
  const requiredCandidateCount =
    boundedReasoningCandidateCount(params.reasoningPolicyAudit.required_candidate_count) ??
    boundedReasoningCandidateCount(sourceExecution.reasoning_candidate_count) ??
    2;
  const candidateCount = Math.max(2, Math.min(4, requiredCandidateCount));
  const missingFields = normalizeStringArray(params.reasoningPolicyAudit.missing_fields);
  const requiredFields = normalizeStringArray(params.reasoningPolicyAudit.required_fields);
  const satisfiedFields = normalizeStringArray(params.reasoningPolicyAudit.satisfied_fields);
  const warnings = normalizeStringArray(params.reasoningPolicyAudit.warnings);
  const evidenceRequirements = buildReasoningPolicyRecoveryEvidenceRequirements(missingFields, candidateCount);
  const recoveryActivationReasons = dedupeStrings([
    "reasoning_policy_review",
    "blocked_step_recovery",
    ...missingFields.map((field) => `missing_${field}`),
  ]);
  const queuedAt = new Date().toISOString();
  const recoveryTaskId = buildReasoningPolicyRecoveryTaskId(params.task.task_id);
  const recoveryExecution = {
    task_kind: "verification",
    quality_preference: "quality",
    focus: "reasoning_policy_review",
    reasoning_candidate_count: candidateCount,
    reasoning_selection_strategy: "evidence_rerank",
    reasoning_compute_policy: {
      mode: "adaptive_best_of_n",
      candidate_count: candidateCount,
      max_candidate_count: 4,
      selection_strategy: "evidence_rerank",
      activation_reasons: recoveryActivationReasons,
      evidence_required: true,
      transcript_policy: "compact_evidence_only",
    },
    require_plan_pass: true,
    require_verification_pass: true,
  };
  const recoveryBrief = {
    kind: "reasoning_policy_review_recovery",
    depth: existingRecoveryDepth + 1,
    queued_at: queuedAt,
    source_task_id: params.task.task_id,
    source_task_status: params.task.status,
    plan_id: params.planContext.plan.plan_id,
    step_id: params.planContext.step.step_id,
    goal_id: params.planContext.plan.goal_id,
    missing_fields: missingFields,
    required_fields: requiredFields,
    satisfied_fields: satisfiedFields,
    required_candidate_count: candidateCount,
    observed_candidate_count: params.reasoningPolicyAudit.observed_candidate_count ?? null,
    selection: isRecord(params.reasoningPolicyAudit.selection) ? params.reasoningPolicyAudit.selection : null,
    warnings,
    produced_artifact_ids: params.producedArtifactIds,
    auto_report_artifact_id: params.autoReportArtifactId,
    source_task_execution: sourceExecution,
  };
  const metadata: Record<string, unknown> = {
    reasoning_policy_recovery: recoveryBrief,
    source_task_execution: sourceExecution,
    task_execution: recoveryExecution,
    plan_dispatch: {
      plan_id: params.planContext.plan.plan_id,
      step_id: params.planContext.step.step_id,
      goal_id: params.planContext.plan.goal_id,
      executor_kind: "worker",
      recovery_of_task_id: params.task.task_id,
      recovery_kind: "reasoning_policy_review",
    },
  };
  if (params.task.metadata.working_memory !== undefined) {
    metadata.working_memory = params.task.metadata.working_memory;
  }
  if (params.task.metadata.memory_preflight !== undefined) {
    metadata.memory_preflight = params.task.metadata.memory_preflight;
  }

  let taskCreateResult: unknown;
  try {
    taskCreateResult = await params.invokeTool("task.create", {
      mutation: buildAgentDerivedMutation(params.input.mutation, `reasoning-review-recovery:${params.task.task_id}`),
      task_id: recoveryTaskId,
      objective: `Recover reasoning-policy evidence for blocked step ${params.planContext.step.step_id}: ${params.planContext.step.title}`,
      project_dir: params.task.project_dir,
      payload: {
        source_task_id: params.task.task_id,
        source_task_objective: params.task.objective,
        plan_id: params.planContext.plan.plan_id,
        step_id: params.planContext.step.step_id,
        goal_id: params.planContext.plan.goal_id,
        reasoning_policy_audit: params.reasoningPolicyAudit,
        delegation_brief: {
          kind: "reasoning_policy_review_recovery",
          objective:
            "Recover the missing reasoning-policy evidence for the blocked plan step and report a grounded result.",
          source_task_id: params.task.task_id,
          blocked_step: {
            plan_id: params.planContext.plan.plan_id,
            step_id: params.planContext.step.step_id,
            title: params.planContext.step.title,
          },
          missing_fields: missingFields,
          required_fields: requiredFields,
          satisfied_fields: satisfiedFields,
          evidence_requirements: evidenceRequirements,
          completion_contract: {
            candidate_evidence: `At least ${candidateCount} evidence-backed candidates when candidate evidence is required.`,
            selection_rationale:
              "selected_candidate_id and selection_rationale must be grounded in the candidate evidence.",
            plan_pass: "Include plan_summary or planned_steps.",
            plan_quality_gate:
              "Include plan_quality_gate with constraints_covered, rollback_noted, and evidence_requirements_mapped.",
            verification_pass: "Include verification_summary plus checks, test_results, or evidence_refs.",
          },
          rollback: "If evidence remains weak or contradictory, fail closed and report the blocker instead of unblocking the step.",
        },
        produced_artifact_ids: params.producedArtifactIds,
        auto_report_artifact_id: params.autoReportArtifactId,
      },
      routing: {
        preferred_agent_ids: [params.session.agent_id],
        preferred_client_kinds: params.session.client_kind ? [params.session.client_kind] : [],
        preferred_capabilities: ["verification", "planning", "worker"],
      },
      task_execution: recoveryExecution,
      permission_profile: readTaskPermissionProfile(params.task.metadata.permission_profile),
      priority: Math.max(params.task.priority, 7),
      max_attempts: 2,
      source: "agent.report_result.reasoning_policy_review",
      source_client: params.input.source_client,
      source_model: params.input.source_model,
      source_agent: params.session.agent_id,
      tags: dedupeStrings([...params.task.tags, "reasoning-policy-review", "recovery", "verification"]),
      metadata,
    });
  } catch (error) {
    return skipped("task-create-failed", error instanceof Error ? error.message : String(error));
  }

  const taskCreateRecord = isRecord(taskCreateResult) ? taskCreateResult : {};
  const recoveryTask = isRecord(taskCreateRecord.task) ? taskCreateRecord.task : null;
  const taskId = readString(recoveryTask?.task_id) ?? recoveryTaskId;
  const created = taskCreateRecord.created === true;
  const event = params.storage.appendRuntimeEvent({
    event_type: "plan.step_reasoning_recovery_queued",
    entity_type: "step",
    entity_id: params.planContext.step.step_id,
    status: "pending",
    summary: `Queued reasoning-policy recovery task ${taskId} for blocked step ${params.planContext.step.step_id}.`,
    details: {
      plan_id: params.planContext.plan.plan_id,
      goal_id: params.planContext.plan.goal_id,
      step_id: params.planContext.step.step_id,
      source_task_id: params.task.task_id,
      recovery_task_id: taskId,
      recovery_task_created: created,
      missing_fields: missingFields,
      required_fields: requiredFields,
      evidence_requirements: evidenceRequirements,
    },
    source_client: params.input.source_client,
    source_model: params.input.source_model,
    source_agent: params.session.agent_id,
  });
  return {
    queued: true,
    created,
    task_id: taskId,
    task: recoveryTask,
    event,
    skipped_reason: null,
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

function readTaskMode(task: TaskRecord): string | null {
  const metadataMode = isRecord(task.metadata) ? readString(task.metadata.task_mode) : null;
  if (metadataMode) {
    return metadataMode;
  }
  if (isRecord(task.payload)) {
    return readString(task.payload.task_mode);
  }
  return null;
}

function isAutopilotSpecialistFallbackTask(task: TaskRecord): boolean {
  const mode = readTaskMode(task)?.toLowerCase() ?? "";
  return mode === "autopilot_specialist_fallback";
}

function evaluateAutopilotQueueDiscipline(
  session: AgentSessionRecord,
  task: TaskRecord,
  explicitlyTargetedSession: boolean
): {
  adjustment: number;
  matched_preferences: string[];
} {
  const clientKind = readString(session.client_kind)?.toLowerCase() ?? "";
  if (clientKind !== "trichat-autopilot") {
    return {
      adjustment: 0,
      matched_preferences: [],
    };
  }

  const taskSource = readString(task.source)?.toLowerCase() ?? "";
  if (isAutopilotSpecialistFallbackTask(task)) {
    return {
      adjustment: -70,
      matched_preferences: ["autopilot_queue:deprioritize_specialist_fallback"],
    };
  }

  if (explicitlyTargetedSession) {
    return {
      adjustment: 0,
      matched_preferences: [],
    };
  }

  if (taskSource && taskSource !== "trichat.autopilot") {
    return {
      adjustment: 12,
      matched_preferences: [`autopilot_queue:prefer_external:${taskSource}`],
    };
  }

  return {
    adjustment: 0,
    matched_preferences: [],
  };
}

function evaluateTaskRouting(storage: Storage, session: AgentSessionRecord, task: TaskRecord): TaskRoutingEvaluation {
  const routing = resolveTaskRouting(task);
  const blockers: string[] = [];
  const matchedPreferences: string[] = [];
  let score = 0;
  const taskProfile = resolveTaskExecutionProfile(task);
  const sessionCapabilityTier = resolveSessionCapabilityTier(session);
  const permissionEligibility = taskPermissionProfileIsEligible(storage, session, task);

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

  if (!permissionEligibility.allowed) {
    blockers.push(
      `permission_profile_insufficient:${permissionEligibility.session_profile_id}->${permissionEligibility.task_profile_id}`
    );
  } else {
    matchedPreferences.push(`permission_profile:${permissionEligibility.task_profile_id}`);
    score += 8;
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

  const autopilotQueueDiscipline = evaluateAutopilotQueueDiscipline(session, task, explicitlyTargetedSession);
  matchedPreferences.push(...autopilotQueueDiscipline.matched_preferences);
  score += autopilotQueueDiscipline.adjustment;

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
    session_permission_profile_id: permissionEligibility.session_profile_id,
    task_permission_profile_id: permissionEligibility.task_profile_id,
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
    const routing = evaluateTaskRouting(storage, session, task);
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
      const routing = evaluateTaskRouting(storage, session, task);
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
      const capabilities = {
        ...(input.capabilities ?? {}),
        ...(input.permission_profile
          ? {
              permission_profile: input.permission_profile,
            }
          : {}),
      };
      const metadata = mergeDeclaredPermissionProfile(input.metadata ?? {}, input.permission_profile);
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
        capabilities,
        tags: input.tags,
        metadata,
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
    execute: () => {
      const session = storage.getAgentSessionById(input.session_id);
      const metadata = syncAdaptiveWorkerProfileFromSessionHeartbeat(
        session,
        mergeDeclaredPermissionProfile(input.metadata ?? {}, input.permission_profile)
      );
      return storage.heartbeatAgentSession({
        session_id: input.session_id,
        lease_seconds: input.lease_seconds,
        status: input.status,
        owner_id: input.owner_id,
        capabilities: {
          ...(input.capabilities ?? {}),
          ...(input.permission_profile
            ? {
                permission_profile: input.permission_profile,
              }
            : {}),
        },
        metadata,
      });
    },
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
    const routing = evaluateTaskRouting(storage, session, task);
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
      session_permission_profile_id: entry.routing.session_permission_profile_id,
      task_permission_profile_id: entry.routing.task_permission_profile_id,
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
          session_permission_profile_id: entry.routing.session_permission_profile_id,
          task_permission_profile_id: entry.routing.task_permission_profile_id,
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
      const completionResult = buildAgentReportCompletionResult(input, reportedArtifactIds);
      const outcomeResult =
        input.outcome === "completed"
          ? storage.completeTask({
              task_id: input.task_id,
              worker_id: session.session_id,
              result: completionResult,
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
      const autoReflection =
        input.outcome === "failed"
          ? (outcomeResult as ReturnType<typeof storage.failTask>).auto_reflection ?? null
          : null;
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
      recordBudgetLedgerUsage(storage, {
        ledger_kind: input.outcome === "completed" ? "actual" : "adjustment",
        usage: input.usage,
        usage_sources: [input.result, input.metadata],
        entity_type: "task",
        entity_id: task.task_id,
        task_id: task.task_id,
        run_id: input.run_id,
        session_id: session.session_id,
        notes: input.summary ?? input.error ?? `Agent reported ${input.outcome}`,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: session.agent_id,
      });
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
      const reasoningPolicyAudit = isRecord(task.result?.reasoning_policy_audit)
        ? task.result.reasoning_policy_audit
        : null;
      const reasoningPolicyRecoveryMetadata = isRecord(task.metadata.reasoning_policy_recovery)
        ? task.metadata.reasoning_policy_recovery
        : null;
      const reasoningPolicyRecoverySourceTaskId =
        readString(reasoningPolicyRecoveryMetadata?.source_task_id) ??
        (isRecord(task.metadata.plan_dispatch) ? readString(task.metadata.plan_dispatch.recovery_of_task_id) : null);
      const reasoningPolicyRecoveryTask =
        reasoningPolicyRecoveryMetadata?.kind === "reasoning_policy_review_recovery";
      const reasoningPolicyNeedsReview =
        input.outcome === "completed" && reasoningPolicyAudit?.status === "needs_review";
      const reasoningPolicyRecovered =
        input.outcome === "completed" &&
        reasoningPolicyRecoveryTask &&
        reasoningPolicyAudit?.status === "satisfied";
      const completionBlocked = missingExpectedArtifacts || reasoningPolicyNeedsReview;
      const dispatchGateType = missingExpectedArtifacts
        ? "artifact_evidence"
        : reasoningPolicyNeedsReview
          ? "reasoning_policy_review"
          : null;
      const reportedAt = new Date().toISOString();
      const reasoningPolicyRecovery = reasoningPolicyNeedsReview
        ? await queueReasoningPolicyRecoveryTask({
            storage,
            invokeTool,
            input,
            session,
            task,
            planContext,
            reasoningPolicyAudit,
            producedArtifactIds,
            autoReportArtifactId: autoReportArtifact.artifact_id,
          })
        : {
            queued: false,
            created: false,
            task_id: null,
            task: null,
            event: null,
            skipped_reason: null,
          };
      const reasoningPolicyRecoveryTaskId =
        reasoningPolicyRecovery.task_id ?? (reasoningPolicyRecoveryTask ? task.task_id : null);
      const adaptiveReport = updateAdaptiveWorkerProfileOnReport(
        session,
        task,
        taskProfile,
        input.outcome,
        reportedAt,
        {
          missing_expected_artifacts: missingExpectedArtifacts,
          reasoning_policy_review_required: reasoningPolicyNeedsReview,
        }
      );

      const planStepUpdate = planContext
        ? storage.updatePlanStep({
            plan_id: planContext.plan.plan_id,
            step_id: planContext.step.step_id,
            status:
              input.outcome === "completed" ? (completionBlocked ? "blocked" : "completed") : "failed",
            task_id: task.task_id,
            run_id: input.run_id,
            produced_artifact_ids: producedArtifactIds,
            metadata: {
              human_approval_required: false,
              dispatch_gate_type: dispatchGateType,
              evidence_gate_required: missingExpectedArtifacts,
              reasoning_policy_review_required: reasoningPolicyNeedsReview,
              reasoning_policy_audit: reasoningPolicyAudit,
              reasoning_policy_recovery_queued: reasoningPolicyRecovery.queued,
              reasoning_policy_recovery_task_created: reasoningPolicyRecovery.created,
              reasoning_policy_recovery_task_id: reasoningPolicyRecoveryTaskId,
              reasoning_policy_recovery_skipped_reason: reasoningPolicyRecovery.skipped_reason,
              reasoning_policy_recovered: reasoningPolicyRecovered,
              reasoning_policy_recovered_at: reasoningPolicyRecovered ? reportedAt : null,
              reasoning_policy_recovery_source_task_id: reasoningPolicyRecoverySourceTaskId,
              reasoning_policy_recovery_resolution: reasoningPolicyRecoveryTask
                ? {
                    recovered: reasoningPolicyRecovered,
                    recovery_task_id: task.task_id,
                    source_task_id: reasoningPolicyRecoverySourceTaskId,
                    audit_status: reasoningPolicyAudit?.status ?? null,
                    resolved_at: reasoningPolicyRecovered ? reportedAt : null,
                  }
                : null,
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
                reported_at: reportedAt,
                outcome: input.outcome,
                summary: input.summary?.trim() ?? null,
                error: input.error?.trim() ?? null,
                run_id: input.run_id ?? null,
                produced_artifact_ids: producedArtifactIds,
                result_keys: Object.keys(input.result ?? {}),
                auto_reflection_memory_id: autoReflection?.memory_id ?? null,
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
                : reasoningPolicyNeedsReview
                  ? "plan.step_reasoning_review_blocked"
                : input.outcome === "completed"
                  ? "plan.step_completed"
                  : "plan.step_failed",
              entity_type: "step",
              entity_id: planContext.step.step_id,
              status: planStepUpdate.step.status,
              summary:
                missingExpectedArtifacts
                  ? `Plan step ${planContext.step.step_id} is blocked pending expected evidence artifacts.`
                  : reasoningPolicyNeedsReview
                    ? `Plan step ${planContext.step.step_id} is blocked pending reasoning-policy review.`
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
                reasoning_policy_audit: reasoningPolicyAudit,
                reasoning_policy_review_required: reasoningPolicyNeedsReview,
                reasoning_policy_recovery_task_id: reasoningPolicyRecoveryTaskId,
                reasoning_policy_recovery_queued: reasoningPolicyRecovery.queued,
                reasoning_policy_recovered: reasoningPolicyRecovered,
                reasoning_policy_recovery_source_task_id: reasoningPolicyRecoverySourceTaskId,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: session.agent_id,
            })
          : null;
      const reasoningPolicyRecoveredEvent =
        reasoningPolicyRecovered && planContext && planStepUpdate
          ? storage.appendRuntimeEvent({
              event_type: "plan.step_reasoning_recovered",
              entity_type: "step",
              entity_id: planContext.step.step_id,
              status: planStepUpdate.step.status,
              summary: `Plan step ${planContext.step.step_id} recovered from reasoning-policy review via task ${task.task_id}.`,
              details: {
                plan_id: planContext.plan.plan_id,
                goal_id: planContext.plan.goal_id,
                step_id: planContext.step.step_id,
                source_task_id: reasoningPolicyRecoverySourceTaskId,
                recovery_task_id: task.task_id,
                run_id: input.run_id ?? null,
                produced_artifact_ids: producedArtifactIds,
                reasoning_policy_audit: reasoningPolicyAudit,
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
          last_reported_at: reportedAt,
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
        !completionBlocked &&
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
                    : reasoningPolicyNeedsReview
                      ? "reasoning_policy_review"
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
          goal_autorun_triggered: goalAutorunTrigger.enabled && input.outcome === "completed" && !completionBlocked,
          expected_artifacts: expectedArtifactCheck,
          reasoning_policy_audit: reasoningPolicyAudit,
          reasoning_policy_review_required: reasoningPolicyNeedsReview,
          reasoning_policy_recovery_task_id: reasoningPolicyRecoveryTaskId,
          reasoning_policy_recovery_queued: reasoningPolicyRecovery.queued,
          reasoning_policy_recovered: reasoningPolicyRecovered,
          reasoning_policy_recovery_source_task_id: reasoningPolicyRecoverySourceTaskId,
          auto_reflection_memory_id: autoReflection?.memory_id ?? null,
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
        reasoning_policy_review: reasoningPolicyNeedsReview
          ? {
              required: true,
              audit: reasoningPolicyAudit,
            }
          : {
              required: false,
              audit: reasoningPolicyAudit,
            },
        adaptive_worker_profile: adaptiveReport.profile,
        reasoning_policy_recovery: reasoningPolicyRecovery,
        reasoning_policy_recovery_resolution: reasoningPolicyRecoveryTask
          ? {
              recovered: reasoningPolicyRecovered,
              recovery_task_id: task.task_id,
              source_task_id: reasoningPolicyRecoverySourceTaskId,
              audit: reasoningPolicyAudit,
            }
          : {
              recovered: false,
              recovery_task_id: null,
              source_task_id: null,
              audit: null,
            },
        auto_reflection: autoReflection,
        goal_autorun: goalAutorun,
        events: {
          task: agentTaskEvent,
          step: planStepEvent,
          reasoning_policy_recovery: reasoningPolicyRecovery.event,
          reasoning_policy_recovered: reasoningPolicyRecoveredEvent,
        },
      };
    },
  });
}
