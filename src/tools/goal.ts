import crypto from "node:crypto";
import { z } from "zod";
import { type GoalRecord, type PlanRecord, type PlanStepRecord, Storage } from "../storage.js";
import { mergeDeclaredPermissionProfile } from "../control_plane_runtime.js";
import { summarizeAdaptiveSessionHealth } from "./agent_session.js";
import { routeObjectiveBackends } from "./model_router.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { evaluatePlanStepReadiness, getPlanStepApprovalGateKind } from "./plan.js";
import { matchDomainSpecialists } from "./specialist_catalog.js";

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

const goalRiskTierSchema = z.enum(["low", "medium", "high", "critical"]);

const autonomyModeSchema = z.enum([
  "observe",
  "recommend",
  "stage",
  "execute_bounded",
  "execute_destructive_with_approval",
]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const goalCreateSchema = z
  .object({
    mutation: mutationSchema,
    goal_id: z.string().min(1).max(200).optional(),
    title: z.string().min(1),
    objective: z.string().min(1),
    status: goalStatusSchema.default("draft"),
    priority: z.number().int().min(0).max(100).optional(),
    risk_tier: goalRiskTierSchema.default("medium"),
    autonomy_mode: autonomyModeSchema.default("recommend"),
    target_entity_type: z.string().min(1).optional(),
    target_entity_id: z.string().min(1).optional(),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string().min(1)).optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    budget: z.record(z.unknown()).optional(),
    permission_profile: z.enum(["read_only", "bounded_execute", "network_enabled", "high_risk"]).optional(),
    owner: z.record(z.unknown()).optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if ((value.target_entity_type && !value.target_entity_id) || (!value.target_entity_type && value.target_entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_entity_type and target_entity_id must be provided together",
        path: ["target_entity_type"],
      });
    }
  });

export const goalGetSchema = z.object({
  goal_id: z.string().min(1),
});

export const goalExecuteSchema = z.object({
  mutation: mutationSchema,
  goal_id: z.string().min(1),
  plan_id: z.string().min(1).optional(),
  create_plan_if_missing: z.boolean().default(true),
  pack_id: z.string().min(1).default("agentic"),
  hook_name: z.string().min(1).optional(),
  context_artifact_ids: z.array(z.string().min(1)).optional(),
  options: z.record(z.unknown()).optional(),
  title: z.string().min(1).optional(),
  selected: z.boolean().optional(),
  dispatch_limit: z.number().int().min(1).max(100).optional(),
  allow_non_ready: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  autorun: z.boolean().default(true),
  max_passes: z.number().int().min(1).max(20).optional(),
  trichat_agent_ids: z.array(z.string().min(1)).max(50).optional(),
  trichat_max_rounds: z.number().int().min(1).max(10).optional(),
  trichat_min_success_agents: z.number().int().min(1).max(10).optional(),
  trichat_bridge_timeout_seconds: z.number().int().min(5).max(1800).optional(),
  trichat_bridge_dry_run: z.boolean().optional(),
  ...sourceSchema.shape,
});

export const goalAutorunSchema = z.object({
  mutation: mutationSchema,
  goal_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  create_plan_if_missing: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  dispatch_limit: z.number().int().min(1).max(100).optional(),
  max_passes: z.number().int().min(1).max(20).optional(),
  pack_id: z.string().min(1).optional(),
  hook_name: z.string().min(1).optional(),
  context_artifact_ids: z.array(z.string().min(1)).optional(),
  options: z.record(z.unknown()).optional(),
  title: z.string().min(1).optional(),
  selected: z.boolean().optional(),
  trichat_agent_ids: z.array(z.string().min(1)).max(50).optional(),
  trichat_max_rounds: z.number().int().min(1).max(10).optional(),
  trichat_min_success_agents: z.number().int().min(1).max(10).optional(),
  trichat_bridge_timeout_seconds: z.number().int().min(5).max(1800).optional(),
  trichat_bridge_dry_run: z.boolean().optional(),
  ...sourceSchema.shape,
});

export const goalHygieneSchema = z.object({
  mutation: mutationSchema,
  goal_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  archive_idle_ephemeral_goals: z.boolean().default(true),
  ...sourceSchema.shape,
});

export const goalAutorunDaemonSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    goal_id: z.string().min(1).optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    create_plan_if_missing: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    dispatch_limit: z.number().int().min(1).max(100).optional(),
    max_passes: z.number().int().min(1).max(20).optional(),
    pack_id: z.string().min(1).optional(),
    hook_name: z.string().min(1).optional(),
    context_artifact_ids: z.array(z.string().min(1)).optional(),
    options: z.record(z.unknown()).optional(),
    title: z.string().min(1).optional(),
    selected: z.boolean().optional(),
    trichat_agent_ids: z.array(z.string().min(1)).max(50).optional(),
    trichat_max_rounds: z.number().int().min(1).max(10).optional(),
    trichat_min_success_agents: z.number().int().min(1).max(10).optional(),
    trichat_bridge_timeout_seconds: z.number().int().min(5).max(1800).optional(),
    trichat_bridge_dry_run: z.boolean().optional(),
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

export const goalListSchema = z
  .object({
    status: goalStatusSchema.optional(),
    target_entity_type: z.string().min(1).optional(),
    target_entity_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.target_entity_type && value.target_entity_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_entity_type is required when target_entity_id is provided",
        path: ["target_entity_type"],
      });
    }
  });

type GoalExecutionPlanResolution = "explicit" | "active" | "selected" | "latest" | "generated" | "missing";
type AdaptiveRoutingMode = "preferred_pool" | "fallback_degraded" | "none";
type GoalAutorunLikeInput = Omit<z.infer<typeof goalAutorunSchema>, "mutation"> & {
  mutation?: { idempotency_key: string; side_effect_fingerprint: string };
};
export type PlannerSelection = {
  hook_name: string;
  methodology: "delivery" | "optimization";
  reason: string;
  evidence: Record<string, unknown>;
};
type PlannerSelectionStrength = "explicit" | "strong" | "weak";
export type MethodologyEntryDecision = {
  state: "dispatchable_now" | "blocked_by_no_viable_lane";
  selection_strength: PlannerSelectionStrength;
  active_session_count: number;
  viable_session_count: number;
  degraded_session_count: number;
  suppressed_session_count: number;
  switched_selection: boolean;
  hold_generation: boolean;
  original_selection: PlannerSelection;
  selection: PlannerSelection;
  reason: string;
};
type GoalMethodologyEntryHoldStatus = {
  state: "none" | "blocked_by_no_viable_lane" | "ready_for_recovery";
  current_pool_fingerprint: string | null;
  hold_count: number;
  hold_reason: string | null;
};
type GoalAutorunDaemonConfig = {
  interval_seconds: number;
  goal_id?: string;
  limit: number;
  create_plan_if_missing: boolean;
  dry_run: boolean;
  dispatch_limit: number;
  max_passes: number;
  pack_id: string;
  hook_name?: string;
  context_artifact_ids?: string[];
  options?: Record<string, unknown>;
  title?: string;
  selected?: boolean;
  trichat_agent_ids?: string[];
  trichat_max_rounds?: number;
  trichat_min_success_agents?: number;
  trichat_bridge_timeout_seconds?: number;
  trichat_bridge_dry_run?: boolean;
  source_client?: string;
  source_model?: string;
  source_agent?: string;
};

type GoalAutorunCooldownReason =
  | "idle_no_ready_work"
  | "running_worker"
  | "human_gate"
  | "policy_gate";

type PlanAdaptiveRoutingSummary = {
  worker_step_count: number;
  mode_counts: Record<AdaptiveRoutingMode, number>;
  attention: string[];
  steps: Array<{
    step_id: string;
    title: string;
    lane_kind: string | null;
    mode: AdaptiveRoutingMode;
    rationale: string | null;
  }>;
};

type PlanRiskAssessment = {
  autonomy_mode: string;
  worker_step_count: number;
  risk_score: number;
  can_auto_execute: boolean;
  pause_reason: string | null;
  warnings: string[];
  adaptive_routing_summary: PlanAdaptiveRoutingSummary;
};

type GoalExecutionPlanResolutionResult = {
  plan: PlanRecord | null;
  resolution: GoalExecutionPlanResolution;
  assessment: PlanRiskAssessment | null;
};

const DEFAULT_GOAL_AUTORUN_CONFIG: GoalAutorunDaemonConfig = {
  interval_seconds: 90,
  limit: 10,
  create_plan_if_missing: true,
  dry_run: false,
  dispatch_limit: 20,
  max_passes: 4,
  pack_id: "agentic",
};

const goalAutorunRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: GoalAutorunDaemonConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  total_executed_goals: number;
  total_skipped_goals: number;
  no_progress_count: number;
  last_idle_at: string | null;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_GOAL_AUTORUN_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  total_executed_goals: 0,
  total_skipped_goals: 0,
  no_progress_count: 0,
  last_idle_at: null,
};

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

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseTimestamp(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeGoalAutorunFingerprint(goal: GoalRecord) {
  const payload = {
    goal_id: goal.goal_id,
    title: goal.title,
    objective: goal.objective,
    status: goal.status,
    priority: goal.priority,
    risk_tier: goal.risk_tier,
    autonomy_mode: goal.autonomy_mode,
    target_entity_type: goal.target_entity_type,
    target_entity_id: goal.target_entity_id,
    active_plan_id: goal.active_plan_id,
    result_summary: goal.result_summary,
    tags: [...goal.tags].sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function hasGoalCooldownFingerprintChanged(goal: GoalRecord, expectedFingerprint: string | null) {
  if (!expectedFingerprint) {
    return false;
  }
  return computeGoalAutorunFingerprint(goal) !== expectedFingerprint;
}

function readGoalAutorunCooldown(goal: GoalRecord) {
  const record = isRecord(goal.metadata.autorun_cooldown) ? goal.metadata.autorun_cooldown : null;
  if (!record) {
    return null;
  }
  const untilAt = readString(record.until_at);
  const lastSeenAt = readString(record.last_seen_at);
  const reason = readString(record.reason) as GoalAutorunCooldownReason | null;
  const untilTimestamp = parseTimestamp(untilAt);
  if (!reason || untilTimestamp === null || Date.now() >= untilTimestamp) {
    return null;
  }
  if (hasGoalCooldownFingerprintChanged(goal, readString(record.goal_fingerprint))) {
    return null;
  }
  return {
    reason,
    until_at: untilAt,
    last_seen_at: lastSeenAt,
    count: readFiniteNumber(record.count) ?? 0,
  };
}

function computeGoalAutorunCooldownSeconds(reason: GoalAutorunCooldownReason, count: number) {
  const normalizedCount = Math.max(1, Math.floor(count));
  const baseSeconds =
    reason === "idle_no_ready_work" ? 300 : reason === "running_worker" ? 60 : 180;
  const exponent = Math.max(0, normalizedCount - 1);
  return Math.min(1800, baseSeconds * Math.pow(2, exponent));
}

function persistGoalAutorunCooldown(
  storage: Storage,
  goal: GoalRecord,
  reason: GoalAutorunCooldownReason,
  source?: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const now = new Date().toISOString();
  const existing = isRecord(goal.metadata.autorun_cooldown) ? goal.metadata.autorun_cooldown : null;
  const sameReason =
    readString(existing?.reason) === reason &&
    !hasGoalCooldownFingerprintChanged(goal, readString(existing?.goal_fingerprint));
  const count = sameReason ? (readFiniteNumber(existing?.count) ?? 0) + 1 : 1;
  const cooldownSeconds = computeGoalAutorunCooldownSeconds(reason, count);
  const untilAt = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
  const goalFingerprint = computeGoalAutorunFingerprint(goal);
  return storage.updateGoalMetadata({
    goal_id: goal.goal_id,
    metadata: {
      autorun_cooldown: {
        reason,
        count,
        cooldown_seconds: cooldownSeconds,
        first_seen_at: sameReason ? readString(existing?.first_seen_at) ?? now : now,
        last_seen_at: now,
        until_at: untilAt,
        goal_fingerprint: goalFingerprint,
      },
    },
    source_client: source?.source_client,
    source_model: source?.source_model,
    source_agent: source?.source_agent,
  }).goal;
}

function clearGoalAutorunCooldown(
  storage: Storage,
  goal: GoalRecord,
  source?: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  if (!isRecord(goal.metadata.autorun_cooldown)) {
    return goal;
  }
  return storage.updateGoalMetadata({
    goal_id: goal.goal_id,
    metadata: {
      autorun_cooldown: null,
    },
    source_client: source?.source_client,
    source_model: source?.source_model,
    source_agent: source?.source_agent,
  }).goal;
}

function mergeGoalExecuteTriChatAgentIds(storage: Storage, objective: string, providedAgentIds: string[] | undefined) {
  const objectiveText = readString(objective) ?? "";
  const matchedAgentIds =
    objectiveText.length > 0
      ? matchDomainSpecialists(storage, objectiveText, 6, 0.3).flatMap((entry) => entry.recommended_trichat_agent_ids)
      : [];
  if (objectiveText.length === 0) {
    return [...new Set([...(providedAgentIds ?? []), ...matchedAgentIds].map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  }
  return routeObjectiveBackends(storage, {
    objective: objectiveText,
    explicit_agent_ids: [...(providedAgentIds ?? []), ...matchedAgentIds].map((entry) => String(entry ?? "").trim()).filter(Boolean),
    quality_preference: "balanced",
    fallback_workspace_root: process.cwd(),
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  }).effective_agent_ids;
}

function buildGoalExecuteDerivedMutation(
  mutation: { idempotency_key: string; side_effect_fingerprint: string },
  phase: string
) {
  return {
    idempotency_key: `${mutation.idempotency_key}:goal.execute:${phase}`,
    side_effect_fingerprint: `${mutation.side_effect_fingerprint}:goal.execute:${phase}`,
  };
}

function buildGoalAutorunDerivedMutation(phase: string) {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return {
    idempotency_key: `goal.autorun.daemon:${phase}:${nonce}`,
    side_effect_fingerprint: `goal.autorun.daemon:${phase}:${nonce}`,
  };
}

function resolveGoalAutorunConfig(
  input:
    | GoalAutorunDaemonConfig
    | Omit<z.infer<typeof goalAutorunDaemonSchema>, "action" | "mutation" | "run_immediately">
    | undefined,
  base: GoalAutorunDaemonConfig = DEFAULT_GOAL_AUTORUN_CONFIG
): GoalAutorunDaemonConfig {
  return {
    interval_seconds:
      typeof input?.interval_seconds === "number" ? Math.max(5, Math.min(3600, Math.trunc(input.interval_seconds))) : base.interval_seconds,
    goal_id: readString(input?.goal_id) ?? base.goal_id,
    limit: typeof input?.limit === "number" ? Math.max(1, Math.min(100, Math.trunc(input.limit))) : base.limit,
    create_plan_if_missing:
      typeof input?.create_plan_if_missing === "boolean" ? input.create_plan_if_missing : base.create_plan_if_missing,
    dry_run: typeof input?.dry_run === "boolean" ? input.dry_run : base.dry_run,
    dispatch_limit:
      typeof input?.dispatch_limit === "number" ? Math.max(1, Math.min(100, Math.trunc(input.dispatch_limit))) : base.dispatch_limit,
    max_passes:
      typeof input?.max_passes === "number" ? Math.max(1, Math.min(20, Math.trunc(input.max_passes))) : base.max_passes,
    pack_id: readString(input?.pack_id) ?? base.pack_id,
    hook_name: readString(input?.hook_name) ?? base.hook_name,
    context_artifact_ids: input?.context_artifact_ids ?? base.context_artifact_ids,
    options: isRecord(input?.options) ? input.options : base.options,
    title: readString(input?.title) ?? base.title,
    selected: typeof input?.selected === "boolean" ? input.selected : base.selected,
    trichat_agent_ids: input?.trichat_agent_ids ?? base.trichat_agent_ids,
    trichat_max_rounds:
      typeof input?.trichat_max_rounds === "number"
        ? Math.max(1, Math.min(10, Math.trunc(input.trichat_max_rounds)))
        : base.trichat_max_rounds,
    trichat_min_success_agents:
      typeof input?.trichat_min_success_agents === "number"
        ? Math.max(1, Math.min(10, Math.trunc(input.trichat_min_success_agents)))
        : base.trichat_min_success_agents,
    trichat_bridge_timeout_seconds:
      typeof input?.trichat_bridge_timeout_seconds === "number"
        ? Math.max(5, Math.min(1800, Math.trunc(input.trichat_bridge_timeout_seconds)))
        : base.trichat_bridge_timeout_seconds,
    trichat_bridge_dry_run:
      typeof input?.trichat_bridge_dry_run === "boolean" ? input.trichat_bridge_dry_run : base.trichat_bridge_dry_run,
    source_client: readString(input?.source_client) ?? base.source_client,
    source_model: readString(input?.source_model) ?? base.source_model,
    source_agent: readString(input?.source_agent) ?? base.source_agent,
  };
}

function normalizedTagSet(goal: GoalRecord) {
  return new Set(goal.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
}

function countKeywordHits(text: string, keywords: string[]) {
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) {
      count += 1;
    }
  }
  return count;
}

function readGoalRetentionPolicy(goal: GoalRecord) {
  const metadata = isRecord(goal.metadata) ? goal.metadata : {};
  const explicitAutoArchive = readBoolean(metadata.auto_archive_when_idle);
  const explicitAfterSeconds = readFiniteNumber(metadata.auto_archive_after_seconds);
  const retentionClass = readString(metadata.retention_class);
  const intakeTool = readString(metadata.intake_tool);
  const titleText = `${goal.title} ${goal.objective}`.trim().toLowerCase();
  const tags = normalizedTagSet(goal);
  const inferredEphemeral =
    retentionClass === "ephemeral" ||
    tags.has("smoke") ||
    tags.has("demo") ||
    tags.has("presentation") ||
    countKeywordHits(titleText, ["demo", "smoke", "presentation-ready"]) > 0 ||
    intakeTool === "autonomy.bootstrap";
  const autoArchiveWhenIdle = explicitAutoArchive ?? inferredEphemeral;
  const autoArchiveAfterSeconds = Math.max(
    0,
    explicitAfterSeconds ??
      (tags.has("presentation") || titleText.includes("presentation-ready")
        ? 900
        : inferredEphemeral
          ? 1800
          : 0)
  );
  return {
    auto_archive_when_idle: autoArchiveWhenIdle,
    auto_archive_after_seconds: autoArchiveWhenIdle ? autoArchiveAfterSeconds : null,
    retention_class: inferredEphemeral ? "ephemeral" : retentionClass ?? "durable",
  };
}

function shouldCompactIdleGoal(params: {
  goal: GoalRecord;
  blockedApprovalStep: { gate_type: string | null } | null;
  runningWorkerStep: PlanStepRecord | undefined;
  hasRunningTriChat: boolean;
  cooldown: ReturnType<typeof readGoalAutorunCooldown> | null;
  explicitGoalId: boolean;
  ignoreCooldownRequirement?: boolean;
}) {
  if (params.explicitGoalId) {
    return false;
  }
  if (params.runningWorkerStep || params.hasRunningTriChat) {
    return false;
  }
  if (params.goal.target_entity_id || params.goal.risk_tier === "critical") {
    return false;
  }
  const policy = readGoalRetentionPolicy(params.goal);
  if (!policy.auto_archive_when_idle || policy.auto_archive_after_seconds === null) {
    return false;
  }
  const createdAt = parseTimestamp(params.goal.created_at);
  if (createdAt === null) {
    return false;
  }
  const ageSeconds = Math.max(0, (Date.now() - createdAt) / 1000);
  if (ageSeconds < policy.auto_archive_after_seconds) {
    return false;
  }
  const cooldownCount = params.cooldown?.count ?? 0;
  if (!params.ignoreCooldownRequirement && policy.auto_archive_after_seconds > 0 && cooldownCount < 1) {
    return false;
  }
  if (params.blockedApprovalStep) {
    return params.blockedApprovalStep.gate_type === "human" || params.blockedApprovalStep.gate_type === "policy";
  }
  return true;
}

async function compactIdleGoalForAutorun(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  params: {
    goal: GoalRecord;
    plan: PlanRecord;
    summary: ReturnType<typeof summarizeGoalExecution>;
    cooldown: ReturnType<typeof readGoalAutorunCooldown> | null;
    mutation: { idempotency_key: string; side_effect_fingerprint: string };
    source: {
      source_client?: string;
      source_model?: string;
      source_agent?: string;
    };
  }
) {
  if (params.plan.status !== "archived") {
    await invokeTool("plan.update", {
      mutation: buildGoalExecuteDerivedMutation(params.mutation, `autorun-archive-plan:${params.goal.goal_id}`),
      plan_id: params.plan.plan_id,
      status: "archived",
      metadata: {
        archived_by: "goal.autorun",
        archive_reason: "stale_idle_ephemeral_goal",
        goal_id: params.goal.goal_id,
      },
      source_client: params.source.source_client,
      source_model: params.source.source_model,
      source_agent: params.source.source_agent,
    });
  }

  const archivedGoal = storage.updateGoal({
    goal_id: params.goal.goal_id,
    status: "archived",
    result_summary: "Goal auto-archived after remaining idle beyond its retention window.",
    result: {
      archived_by: "goal.autorun",
      archive_reason: "stale_idle_ephemeral_goal",
      plan_id: params.plan.plan_id,
      cooldown_reason: params.cooldown?.reason ?? null,
      cooldown_count: params.cooldown?.count ?? 0,
      execution_summary: params.summary,
    },
    metadata: {
      autorun_cooldown: null,
      archived_by: "goal.autorun",
      archived_reason: "stale_idle_ephemeral_goal",
      archived_at: new Date().toISOString(),
    },
    event_type: "auto_archived",
    event_summary: "Goal auto-archived after remaining idle beyond its retention window.",
    event_details: {
      plan_id: params.plan.plan_id,
      cooldown_reason: params.cooldown?.reason ?? null,
      cooldown_count: params.cooldown?.count ?? 0,
    },
    source_client: params.source.source_client,
    source_model: params.source.source_model,
    source_agent: params.source.source_agent,
  }).goal;

  storage.appendRuntimeEvent({
    event_type: "goal.autorun_compacted",
    entity_type: "goal",
    entity_id: archivedGoal.goal_id,
    status: archivedGoal.status,
    summary: `goal.autorun archived stale idle goal ${archivedGoal.goal_id}.`,
    details: {
      goal_id: archivedGoal.goal_id,
      plan_id: params.plan.plan_id,
      reason: "stale_idle_ephemeral_goal",
      cooldown_reason: params.cooldown?.reason ?? null,
      cooldown_count: params.cooldown?.count ?? 0,
      execution_summary: params.summary,
    },
    source_client: params.source.source_client,
    source_model: params.source.source_model,
    source_agent: params.source.source_agent,
  });

  return archivedGoal;
}

export function buildExplicitPlannerSelection(hookName: string): PlannerSelection {
  return {
    hook_name: hookName,
    methodology: hookName === "optimization_loop" ? "optimization" : "delivery",
    reason: "input.hook_name",
    evidence: {
      hook_name: hookName,
    },
  };
}

function resolveDefaultPlannerSelection(goal: GoalRecord, options?: Record<string, unknown>): PlannerSelection {
  const preferredHookName = readString(goal.metadata.preferred_planner_hook_name);
  if (preferredHookName) {
    return {
      hook_name: preferredHookName,
      methodology: preferredHookName === "optimization_loop" ? "optimization" : "delivery",
      reason: "goal.metadata.preferred_planner_hook_name",
      evidence: {
        preferred_planner_hook_name: preferredHookName,
      },
    };
  }
  const methodologySource = readString(goal.metadata.methodology_source);
  if (methodologySource === "karpathy/autoresearch" || methodologySource === "autoresearch") {
    return {
      hook_name: "optimization_loop",
      methodology: "optimization",
      reason: "goal.metadata.methodology_source",
      evidence: {
        methodology_source: methodologySource,
      },
    };
  }
  if (methodologySource === "gsd-build/get-shit-done" || methodologySource === "gsd") {
    return {
      hook_name: "delivery_path",
      methodology: "delivery",
      reason: "goal.metadata.methodology_source",
      evidence: {
        methodology_source: methodologySource,
      },
    };
  }

  const tags = normalizedTagSet(goal);
  if (tags.has("autoresearch") || tags.has("optimization") || tags.has("experiment") || tags.has("benchmark")) {
    return {
      hook_name: "optimization_loop",
      methodology: "optimization",
      reason: "goal.tags",
      evidence: {
        tags: Array.from(tags),
      },
    };
  }
  if (tags.has("delivery") || tags.has("feature") || tags.has("debug") || tags.has("fix") || tags.has("refactor")) {
    return {
      hook_name: "delivery_path",
      methodology: "delivery",
      reason: "goal.tags",
      evidence: {
        tags: Array.from(tags),
      },
    };
  }

  if (goal.target_entity_type === "experiment") {
    return {
      hook_name: "optimization_loop",
      methodology: "optimization",
      reason: "goal.target_entity_type",
      evidence: {
        target_entity_type: goal.target_entity_type,
      },
    };
  }

  const explicitMetricName = readString(options?.metric_name) ?? readString(goal.metadata.preferred_metric_name);
  if (explicitMetricName) {
    return {
      hook_name: "optimization_loop",
      methodology: "optimization",
      reason: "metric_hint",
      evidence: {
        metric_name: explicitMetricName,
      },
    };
  }

  const corpus = [goal.title, goal.objective, ...goal.acceptance_criteria].join(" ").toLowerCase();
  const optimizationHits = countKeywordHits(corpus, [
    "optimiz",
    "benchmark",
    "latency",
    "throughput",
    "performance",
    "cost",
    "accuracy",
    "score",
    "eval",
    "quality",
    "metric",
    "measure",
    "prompt",
    "experiment",
  ]);
  const deliveryHits = countKeywordHits(corpus, [
    "ship",
    "deliver",
    "feature",
    "implement",
    "integration",
    "wire",
    "fix",
    "bug",
    "debug",
    "refactor",
    "review",
    "verify",
    "stabilize",
    "harden",
  ]);

  if (optimizationHits > deliveryHits) {
    return {
      hook_name: "optimization_loop",
      methodology: "optimization",
      reason: "objective_classifier",
      evidence: {
        optimization_hits: optimizationHits,
        delivery_hits: deliveryHits,
      },
    };
  }
  return {
    hook_name: "delivery_path",
    methodology: "delivery",
    reason: optimizationHits === deliveryHits ? "default_delivery_tie_break" : "objective_classifier",
    evidence: {
      optimization_hits: optimizationHits,
      delivery_hits: deliveryHits,
    },
  };
}

function resolvePlannerSelectionStrength(selection: PlannerSelection): PlannerSelectionStrength {
  if (
    selection.reason === "input.hook_name" ||
    selection.reason === "goal.metadata.preferred_planner_hook_name" ||
    selection.reason === "goal.metadata.methodology_source" ||
    selection.reason === "goal.tags" ||
    selection.reason === "goal.target_entity_type" ||
    selection.reason === "metric_hint"
  ) {
    return "explicit";
  }
  if (selection.reason !== "objective_classifier" && selection.reason !== "default_delivery_tie_break") {
    return "strong";
  }
  const optimizationHits = readFiniteNumber(selection.evidence.optimization_hits) ?? 0;
  const deliveryHits = readFiniteNumber(selection.evidence.delivery_hits) ?? 0;
  return Math.abs(optimizationHits - deliveryHits) >= 2 ? "strong" : "weak";
}

function summarizeMethodologyEntryPool(storage: Storage) {
  const activeSessions = storage.listAgentSessions({
    active_only: true,
    limit: 100,
  });
  let viableSessionCount = 0;
  let degradedSessionCount = 0;
  let suppressedSessionCount = 0;
  for (const session of activeSessions) {
    const adaptiveState = summarizeAdaptiveSessionHealth(session).adaptive_state;
    if (adaptiveState === "healthy" || adaptiveState === "unproven") {
      viableSessionCount += 1;
    } else if (adaptiveState === "degraded") {
      degradedSessionCount += 1;
    } else if (adaptiveState === "suppressed") {
      suppressedSessionCount += 1;
    }
  }
  return {
    active_session_count: activeSessions.length,
    viable_session_count: viableSessionCount,
    degraded_session_count: degradedSessionCount,
    suppressed_session_count: suppressedSessionCount,
  };
}

function hasPersistedMethodologyEntryHold(goal: GoalRecord) {
  return isRecord(goal.metadata.methodology_entry_hold);
}

export function resolveMethodologyEntryDecision(
  storage: Storage,
  goal: GoalRecord,
  selection: PlannerSelection,
  options?: {
    allow_hold_on_explicit_selection?: boolean;
  }
): MethodologyEntryDecision {
  const pool = summarizeMethodologyEntryPool(storage);
  const selectionStrength = resolvePlannerSelectionStrength(selection);
  let nextSelection = selection;
  let switchedSelection = false;
  let reason =
    pool.viable_session_count > 0
      ? "Viable worker lanes are available for plan generation."
      : "No healthy or unproven worker lanes are currently available for plan generation.";

  if (
    pool.viable_session_count === 0 &&
    selectionStrength === "weak" &&
    selection.methodology === "optimization"
  ) {
    nextSelection = {
      hook_name: "delivery_path",
      methodology: "delivery",
      reason: "worker_pool_safety_override",
      evidence: {
        original_selection: selection,
        active_session_count: pool.active_session_count,
        viable_session_count: pool.viable_session_count,
        degraded_session_count: pool.degraded_session_count,
        suppressed_session_count: pool.suppressed_session_count,
      },
    };
    switchedSelection = true;
    reason =
      "Weak optimization intent was downgraded to the safer delivery path because no viable worker lane is available right now.";
  }

  const holdGeneration =
    pool.viable_session_count === 0 &&
    goal.autonomy_mode === "execute_destructive_with_approval" &&
    (options?.allow_hold_on_explicit_selection === true || selectionStrength === "weak");

  if (holdGeneration) {
    reason =
      "Generation is being held because destructive autonomy requires a viable worker lane before the kernel creates a new plan.";
  }

  return {
    state: pool.viable_session_count > 0 ? "dispatchable_now" : "blocked_by_no_viable_lane",
    selection_strength: selectionStrength,
    active_session_count: pool.active_session_count,
    viable_session_count: pool.viable_session_count,
    degraded_session_count: pool.degraded_session_count,
    suppressed_session_count: pool.suppressed_session_count,
    switched_selection: switchedSelection,
    hold_generation: holdGeneration,
    original_selection: selection,
    selection: nextSelection,
    reason,
  };
}

export function persistMethodologyEntryHold(
  storage: Storage,
  goal: GoalRecord,
  decision: MethodologyEntryDecision,
  source?: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const now = new Date().toISOString();
  const existingHold = isRecord(goal.metadata.methodology_entry_hold) ? goal.metadata.methodology_entry_hold : null;
  const currentPoolFingerprint = buildWorkerPoolRecoveryFingerprint(storage);
  const sameFingerprint = readString(existingHold?.pool_fingerprint) === currentPoolFingerprint;
  const count = sameFingerprint ? (readFiniteNumber(existingHold?.count) ?? 0) + 1 : 1;

  return storage.updateGoalMetadata({
    goal_id: goal.goal_id,
    metadata: {
      methodology_entry_hold: {
        first_seen_at: sameFingerprint
          ? readString(existingHold?.first_seen_at) ?? now
          : now,
        last_seen_at: now,
        count,
        state: decision.state,
        reason: decision.reason,
        selection_strength: decision.selection_strength,
        original_selection: decision.original_selection,
        selection: decision.selection,
        switched_selection: decision.switched_selection,
        active_session_count: decision.active_session_count,
        viable_session_count: decision.viable_session_count,
        degraded_session_count: decision.degraded_session_count,
        suppressed_session_count: decision.suppressed_session_count,
        pool_fingerprint: currentPoolFingerprint,
      },
    },
    source_client: source?.source_client,
    source_model: source?.source_model,
    source_agent: source?.source_agent,
  }).goal;
}

export function clearMethodologyEntryHold(
  storage: Storage,
  goal: GoalRecord,
  source?: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  if (!hasPersistedMethodologyEntryHold(goal)) {
    return goal;
  }
  return storage.updateGoalMetadata({
    goal_id: goal.goal_id,
    metadata: {
      methodology_entry_hold: null,
    },
    source_client: source?.source_client,
    source_model: source?.source_model,
    source_agent: source?.source_agent,
  }).goal;
}

function summarizeGoalMethodologyEntryHoldStatus(storage: Storage, goal: GoalRecord): GoalMethodologyEntryHoldStatus {
  const existingHold = isRecord(goal.metadata.methodology_entry_hold) ? goal.metadata.methodology_entry_hold : null;
  if (!existingHold) {
    return {
      state: "none",
      current_pool_fingerprint: null,
      hold_count: 0,
      hold_reason: null,
    };
  }

  const currentPoolFingerprint = buildWorkerPoolRecoveryFingerprint(storage);
  const pool = summarizeMethodologyEntryPool(storage);
  return {
    state: pool.viable_session_count > 0 ? "ready_for_recovery" : "blocked_by_no_viable_lane",
    current_pool_fingerprint: currentPoolFingerprint,
    hold_count: readFiniteNumber(existingHold.count) ?? 0,
    hold_reason: readString(existingHold.reason),
  };
}

function hasViableWorkerPoolForRecovery(storage: Storage) {
  return storage
    .listAgentSessions({
      active_only: true,
      limit: 100,
    })
    .some((session) => {
      const adaptiveState = summarizeAdaptiveSessionHealth(session).adaptive_state;
      return adaptiveState === "healthy" || adaptiveState === "unproven";
    });
}

function buildWorkerPoolRecoveryFingerprint(storage: Storage) {
  const activeSessions = storage.listAgentSessions({
    active_only: true,
    limit: 100,
  });
  if (activeSessions.length === 0) {
    return null;
  }

  return activeSessions
    .map((session) => {
      const adaptiveState = summarizeAdaptiveSessionHealth(session).adaptive_state;
      return [
        session.session_id,
        session.agent_id,
        session.client_kind ?? "",
        session.status,
        adaptiveState,
      ].join(":");
    })
    .sort()
    .join("|");
}

function summarizeWorkerPoolRecoveryStatus(storage: Storage, plan: PlanRecord) {
  const workerPoolPause = isRecord(plan.metadata.worker_pool_pause) ? plan.metadata.worker_pool_pause : null;
  if (!workerPoolPause) {
    return {
      state: "none" as const,
      viable_pool_available: false,
      current_pool_fingerprint: null,
      last_attempted_pool_fingerprint: null,
    };
  }

  const viablePoolAvailable = hasViableWorkerPoolForRecovery(storage);
  const currentPoolFingerprint = buildWorkerPoolRecoveryFingerprint(storage);
  const existingAttempt = isRecord(plan.metadata.worker_pool_recovery_attempt)
    ? plan.metadata.worker_pool_recovery_attempt
    : null;
  const lastAttemptedPoolFingerprint = readString(existingAttempt?.pool_fingerprint);

  if (!viablePoolAvailable || !currentPoolFingerprint) {
    return {
      state: "no_viable_pool" as const,
      viable_pool_available: false,
      current_pool_fingerprint: currentPoolFingerprint,
      last_attempted_pool_fingerprint: lastAttemptedPoolFingerprint,
    };
  }

  if (lastAttemptedPoolFingerprint === currentPoolFingerprint) {
    return {
      state: "awaiting_pool_change" as const,
      viable_pool_available: true,
      current_pool_fingerprint: currentPoolFingerprint,
      last_attempted_pool_fingerprint: lastAttemptedPoolFingerprint,
    };
  }

  return {
    state: "ready_for_recovery" as const,
    viable_pool_available: true,
    current_pool_fingerprint: currentPoolFingerprint,
    last_attempted_pool_fingerprint: lastAttemptedPoolFingerprint,
  };
}

function resolveWorkerPoolRecoveryFingerprint(
  storage: Storage,
  input: {
    plan_id?: string;
    create_plan_if_missing?: boolean;
  },
  plan: PlanRecord,
  assessment: PlanRiskAssessment
) {
  if (input.plan_id || input.create_plan_if_missing === false || assessment.can_auto_execute) {
    return null;
  }
  const recoveryStatus = summarizeWorkerPoolRecoveryStatus(storage, plan);
  return recoveryStatus.state === "ready_for_recovery" ? recoveryStatus.current_pool_fingerprint : null;
}

async function generateGoalExecutionPlanCandidate(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  params: {
    input: z.infer<typeof goalExecuteSchema>;
    goal: GoalRecord;
    planner_selection: PlannerSelection;
    source: {
      source_client?: string;
      source_model?: string;
      source_agent?: string;
    };
    generation_reason: "missing_plan" | "worker_pool_recovery";
    previous_plan_id?: string;
    recovery_pool_fingerprint?: string | null;
  }
) {
  const generated = await invokeTool("pack.plan.generate", {
    mutation: buildGoalExecuteDerivedMutation(
      params.input.mutation,
      params.generation_reason === "missing_plan" ? "plan-generate" : "plan-recover"
    ),
    pack_id: params.input.pack_id,
    hook_name: params.planner_selection.hook_name,
    target: {
      entity_type: "goal",
      entity_id: params.goal.goal_id,
    },
    goal_id: params.goal.goal_id,
    context_artifact_ids: params.input.context_artifact_ids,
    options: {
      ...(params.input.options ?? {}),
      methodology_selection: params.planner_selection,
    },
    plan_id: params.input.plan_id,
    title: params.input.title,
    selected: false,
    source_client: params.input.source_client,
    source_model: params.input.source_model,
    source_agent: params.input.source_agent,
  });
  if (!isRecord(generated) || !isRecord(generated.plan) || !readString(generated.plan.plan_id)) {
    throw new Error(`pack.plan.generate did not return a plan for goal ${params.goal.goal_id}`);
  }

  const generatedPlanId = String(generated.plan.plan_id);
  const generatedPlan = storage.getPlanById(generatedPlanId);
  if (!generatedPlan) {
    return {
      generated_plan_result: generated,
      plan_resolution: {
        resolution: "generated" as GoalExecutionPlanResolution,
        plan: null,
        assessment: null,
      },
    };
  }

  const updatedPlan = storage.updatePlan({
    plan_id: generatedPlanId,
    metadata: {
      methodology_selection: params.planner_selection,
      goal_execute_generation_reason: params.generation_reason,
      replanned_from_plan_id: params.previous_plan_id ?? null,
      worker_pool_recovery_attempt:
        params.generation_reason === "worker_pool_recovery" && params.recovery_pool_fingerprint
          ? {
              attempted_at: new Date().toISOString(),
              pool_fingerprint: params.recovery_pool_fingerprint,
              source_plan_id: params.previous_plan_id ?? null,
            }
          : null,
      worker_pool_recovery_suppressed: null,
    },
    ...params.source,
  }).plan;

  return {
    generated_plan_result: generated,
    plan_resolution: {
      resolution: "generated" as GoalExecutionPlanResolution,
      plan: updatedPlan,
      assessment: assessPlanRisk(params.goal, updatedPlan, storage.listPlanSteps(generatedPlanId)),
    },
  };
}

function isTerminalPlanStatus(status: PlanRecord["status"]) {
  return status === "completed" || status === "invalidated" || status === "archived";
}

function resolveGoalExecutionPlan(
  storage: Storage,
  input: z.infer<typeof goalExecuteSchema>,
  goal: GoalRecord
): GoalExecutionPlanResolutionResult {
  if (input.plan_id) {
    const plan = storage.getPlanById(input.plan_id);
    if (!plan) {
      throw new Error(`Plan not found: ${input.plan_id}`);
    }
    if (plan.goal_id !== goal.goal_id) {
      throw new Error(`Plan ${input.plan_id} does not belong to goal ${goal.goal_id}`);
    }
    const steps = storage.listPlanSteps(plan.plan_id);
    return {
      plan,
      resolution: "explicit",
      assessment: assessPlanRisk(goal, plan, steps),
    };
  }

  const candidates = new Map<string, { plan: PlanRecord; resolution: GoalExecutionPlanResolution; assessment: PlanRiskAssessment }>();
  const registerCandidate = (plan: PlanRecord, resolution: GoalExecutionPlanResolution) => {
    if (plan.goal_id !== goal.goal_id || isTerminalPlanStatus(plan.status) || candidates.has(plan.plan_id)) {
      return;
    }
    candidates.set(plan.plan_id, {
      plan,
      resolution,
      assessment: assessPlanRisk(goal, plan, storage.listPlanSteps(plan.plan_id)),
    });
  };

  if (goal.active_plan_id) {
    const activePlan = storage.getPlanById(goal.active_plan_id);
    if (activePlan) {
      registerCandidate(activePlan, "active");
    }
  }

  for (const selectedPlan of storage.listPlans({
    goal_id: goal.goal_id,
    selected_only: true,
    limit: 20,
  })) {
    registerCandidate(selectedPlan, "selected");
  }

  for (const latestPlan of storage.listPlans({
    goal_id: goal.goal_id,
    limit: 20,
  })) {
    registerCandidate(latestPlan, "latest");
  }

  const rankedCandidates = [...candidates.values()].sort(compareGoalExecutionPlanCandidates);
  if (rankedCandidates.length > 0) {
    const activeCandidate = rankedCandidates.find((candidate) => candidate.resolution === "active");
    if (activeCandidate?.assessment.can_auto_execute) {
      return {
        plan: activeCandidate.plan,
        resolution: activeCandidate.resolution,
        assessment: activeCandidate.assessment,
      };
    }
    const selectedCandidate = rankedCandidates.find((candidate) => candidate.resolution === "selected");
    if (selectedCandidate?.assessment.can_auto_execute) {
      return {
        plan: selectedCandidate.plan,
        resolution: selectedCandidate.resolution,
        assessment: selectedCandidate.assessment,
      };
    }
    const bestCandidate = rankedCandidates[0];
    return {
      plan: bestCandidate.plan,
      resolution: bestCandidate.resolution,
      assessment: bestCandidate.assessment,
    };
  }

  return {
    plan: null,
    resolution: "missing",
    assessment: null,
  };
}

function summarizeGoalExecution(plan: PlanRecord, steps: PlanStepRecord[]) {
  const readiness = evaluatePlanStepReadiness(steps);
  const readinessByStepId = new Map(readiness.map((entry) => [entry.step_id, entry]));
  const statusCounts = steps.reduce<Record<string, number>>((acc, step) => {
    acc[step.status] = (acc[step.status] ?? 0) + 1;
    return acc;
  }, {});
  const blockedApprovalSteps = steps
    .filter((step) => {
      return step.status === "blocked" && getPlanStepApprovalGateKind(step) !== null;
    })
    .map((step) => ({
      step_id: step.step_id,
      title: step.title,
      status: step.status,
      gate_type: getPlanStepApprovalGateKind(step),
    }));
  const blockedHumanSteps = blockedApprovalSteps.filter((step) => step.gate_type === "human");
  const readyStepIds = readiness.filter((entry) => entry.ready).map((entry) => entry.step_id);
  const runningStepIds = steps.filter((step) => step.status === "running").map((step) => step.step_id);
  const failedStepIds = steps.filter((step) => step.status === "failed").map((step) => step.step_id);

  let nextAction = "Plan is idle.";
  if (plan.status === "completed") {
    nextAction = "Plan completed; inspect artifacts and mark the goal complete when appropriate.";
  } else if (failedStepIds.length > 0) {
    nextAction = "Inspect failed steps and use plan.resume after fixing the blocking issue.";
  } else if (blockedApprovalSteps.length > 0) {
    nextAction =
      blockedApprovalSteps.some((step) => step.gate_type === "policy")
        ? "Approve the blocked policy gate with plan.approve, then call goal.execute or plan.resume again."
        : "Approve the blocked human gate with plan.approve, then call goal.execute or plan.resume again.";
  } else if (runningStepIds.length > 0) {
    nextAction = "Wait for running tasks or turns to finish, then call goal.execute again to continue dispatch.";
  } else if (readyStepIds.length > 0) {
    nextAction = "Ready steps remain; call goal.execute again to continue dispatch.";
  }

  return {
    plan_id: plan.plan_id,
    plan_status: plan.status,
    step_count: steps.length,
    ready_count: readyStepIds.length,
    running_count: runningStepIds.length,
    completed_count: statusCounts.completed ?? 0,
    blocked_count: statusCounts.blocked ?? 0,
    failed_count: statusCounts.failed ?? 0,
    pending_count: statusCounts.pending ?? 0,
    blocked_approval_steps: blockedApprovalSteps,
    blocked_human_steps: blockedHumanSteps,
    ready_step_ids: readyStepIds,
    running_step_ids: runningStepIds,
    failed_step_ids: failedStepIds,
    next_action: nextAction,
  };
}

function summarizePlanAdaptiveRouting(steps: PlanStepRecord[]): PlanAdaptiveRoutingSummary {
  const modeCounts: Record<AdaptiveRoutingMode, number> = {
    preferred_pool: 0,
    fallback_degraded: 0,
    none: 0,
  };
  const summarizedSteps = steps
    .map((step) => {
      if (step.executor_kind !== "worker" && step.executor_kind !== "task") {
        return null;
      }
      const adaptiveAssignment = isRecord(step.metadata.adaptive_assignment) ? step.metadata.adaptive_assignment : null;
      const mode = readString(adaptiveAssignment?.mode);
      if (mode !== "preferred_pool" && mode !== "fallback_degraded" && mode !== "none") {
        return null;
      }
      modeCounts[mode] += 1;
      return {
        step_id: step.step_id,
        title: step.title,
        lane_kind: readString(adaptiveAssignment?.lane_kind),
        mode,
        rationale: readString(adaptiveAssignment?.rationale),
      };
    })
    .filter((entry): entry is PlanAdaptiveRoutingSummary["steps"][number] => entry !== null);

  const attention: string[] = [];
  if (modeCounts.fallback_degraded > 0) {
    attention.push(`Plan uses degraded fallback lanes for ${modeCounts.fallback_degraded} worker step(s).`);
  }
  if (modeCounts.none > 0) {
    attention.push(`Plan has ${modeCounts.none} worker step(s) with no dispatchable adaptive lane guidance.`);
  }

  return {
    worker_step_count: summarizedSteps.length,
    mode_counts: modeCounts,
    attention,
    steps: summarizedSteps,
  };
}

function assessPlanRisk(goal: GoalRecord, plan: PlanRecord, steps: PlanStepRecord[]): PlanRiskAssessment {
  const adaptiveRoutingSummary = summarizePlanAdaptiveRouting(steps);
  const confidence = typeof plan.confidence === "number" && Number.isFinite(plan.confidence) ? plan.confidence : 0.75;
  let riskScore =
    adaptiveRoutingSummary.mode_counts.none * 100 +
    adaptiveRoutingSummary.mode_counts.fallback_degraded * 35 +
    Math.max(0, (0.8 - confidence) * 20);
  if (adaptiveRoutingSummary.worker_step_count === 0) {
    riskScore -= 10;
  }
  riskScore = Number(Math.max(0, riskScore).toFixed(3));

  const warnings = [...adaptiveRoutingSummary.attention];
  let pauseReason: string | null = null;
  if (goal.autonomy_mode === "execute_destructive_with_approval") {
    if (adaptiveRoutingSummary.mode_counts.none > 0) {
      pauseReason =
        "Destructive autonomy requires a dispatchable live worker pool, but this plan still has worker steps with no adaptive lane guidance.";
    } else if (adaptiveRoutingSummary.mode_counts.fallback_degraded > 0) {
      pauseReason =
        "Destructive autonomy requires healthier worker lanes, but this plan currently relies on degraded fallback routing.";
    }
  } else if (goal.autonomy_mode === "execute_bounded" && adaptiveRoutingSummary.mode_counts.none > 0) {
    warnings.push(
      "Execute-bounded mode will queue work, but this plan currently depends on worker lanes that are not yet dispatchable."
    );
  }

  return {
    autonomy_mode: goal.autonomy_mode,
    worker_step_count: adaptiveRoutingSummary.worker_step_count,
    risk_score: riskScore,
    can_auto_execute: pauseReason === null,
    pause_reason: pauseReason,
    warnings,
    adaptive_routing_summary: adaptiveRoutingSummary,
  };
}

function compareGoalExecutionPlanCandidates(
  left: { plan: PlanRecord; resolution: GoalExecutionPlanResolution; assessment: PlanRiskAssessment },
  right: { plan: PlanRecord; resolution: GoalExecutionPlanResolution; assessment: PlanRiskAssessment }
) {
  if (left.assessment.can_auto_execute !== right.assessment.can_auto_execute) {
    return left.assessment.can_auto_execute ? -1 : 1;
  }
  if (left.assessment.risk_score !== right.assessment.risk_score) {
    return left.assessment.risk_score - right.assessment.risk_score;
  }
  const resolutionRank: Record<GoalExecutionPlanResolution, number> = {
    explicit: 0,
    active: 1,
    selected: 2,
    latest: 3,
    generated: 4,
    missing: 5,
  };
  if (resolutionRank[left.resolution] !== resolutionRank[right.resolution]) {
    return resolutionRank[left.resolution] - resolutionRank[right.resolution];
  }
  const leftConfidence = typeof left.plan.confidence === "number" && Number.isFinite(left.plan.confidence) ? left.plan.confidence : -1;
  const rightConfidence = typeof right.plan.confidence === "number" && Number.isFinite(right.plan.confidence) ? right.plan.confidence : -1;
  if (leftConfidence !== rightConfidence) {
    return rightConfidence - leftConfidence;
  }
  return right.plan.updated_at.localeCompare(left.plan.updated_at);
}

function sameAdaptiveModeCounts(
  left: Record<AdaptiveRoutingMode, number> | null | undefined,
  right: Record<AdaptiveRoutingMode, number> | null | undefined
) {
  return (
    (left?.preferred_pool ?? 0) === (right?.preferred_pool ?? 0) &&
    (left?.fallback_degraded ?? 0) === (right?.fallback_degraded ?? 0) &&
    (left?.none ?? 0) === (right?.none ?? 0)
  );
}

function sameStringArray(left: string[] | null | undefined, right: string[]) {
  if (!Array.isArray(left) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function hasMatchingPersistedPlanRiskAssessment(
  plan: PlanRecord,
  goal: GoalRecord,
  assessment: PlanRiskAssessment
) {
  const existingAssessment = isRecord(plan.metadata.last_plan_risk_assessment) ? plan.metadata.last_plan_risk_assessment : null;
  const existingPause = isRecord(plan.metadata.worker_pool_pause) ? plan.metadata.worker_pool_pause : null;
  const existingAssessmentSummary = isRecord(existingAssessment?.adaptive_routing_summary)
    ? existingAssessment.adaptive_routing_summary
    : null;
  const existingAssessmentModeCounts = isRecord(existingAssessmentSummary?.mode_counts)
    ? {
        preferred_pool: readFiniteNumber(existingAssessmentSummary.mode_counts.preferred_pool) ?? 0,
        fallback_degraded: readFiniteNumber(existingAssessmentSummary.mode_counts.fallback_degraded) ?? 0,
        none: readFiniteNumber(existingAssessmentSummary.mode_counts.none) ?? 0,
      }
    : null;
  const assessmentMatches =
    existingAssessment !== null &&
    readString(existingAssessment.autonomy_mode) === assessment.autonomy_mode &&
    readFiniteNumber(existingAssessment.risk_score) === assessment.risk_score &&
    readBoolean(existingAssessment.can_auto_execute) === assessment.can_auto_execute &&
    readString(existingAssessment.pause_reason) === assessment.pause_reason &&
    sameStringArray(Array.isArray(existingAssessment.warnings) ? existingAssessment.warnings : null, assessment.warnings) &&
    sameAdaptiveModeCounts(existingAssessmentModeCounts, assessment.adaptive_routing_summary.mode_counts);

  const pauseMatches = assessment.can_auto_execute
    ? plan.metadata.worker_pool_pause === null || plan.metadata.worker_pool_pause === undefined
    : existingPause !== null &&
      readString(existingPause.goal_id) === goal.goal_id &&
      readString(existingPause.autonomy_mode) === goal.autonomy_mode &&
      readString(existingPause.reason) === assessment.pause_reason &&
      readFiniteNumber(existingPause.risk_score) === assessment.risk_score &&
      readFiniteNumber(existingPause.worker_step_count) === assessment.worker_step_count &&
      sameAdaptiveModeCounts(
        isRecord(existingPause.mode_counts)
          ? {
              preferred_pool: readFiniteNumber(existingPause.mode_counts.preferred_pool) ?? 0,
              fallback_degraded: readFiniteNumber(existingPause.mode_counts.fallback_degraded) ?? 0,
              none: readFiniteNumber(existingPause.mode_counts.none) ?? 0,
            }
          : null,
        assessment.adaptive_routing_summary.mode_counts
      );

  return assessmentMatches && pauseMatches;
}

function persistPlanRiskAssessment(
  storage: Storage,
  goal: GoalRecord,
  plan: PlanRecord,
  assessment: PlanRiskAssessment,
  source?: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const now = new Date().toISOString();
  const workerPoolPause = assessment.can_auto_execute
    ? null
    : {
        paused_at: now,
        goal_id: goal.goal_id,
        autonomy_mode: goal.autonomy_mode,
        reason: assessment.pause_reason,
        risk_score: assessment.risk_score,
        worker_step_count: assessment.worker_step_count,
        mode_counts: assessment.adaptive_routing_summary.mode_counts,
      };

  if (hasMatchingPersistedPlanRiskAssessment(plan, goal, assessment)) {
    return plan;
  }

  return storage.updatePlan({
    plan_id: plan.plan_id,
    metadata: {
      last_plan_risk_assessment: {
        evaluated_at: now,
        autonomy_mode: assessment.autonomy_mode,
        risk_score: assessment.risk_score,
        can_auto_execute: assessment.can_auto_execute,
        pause_reason: assessment.pause_reason,
        warnings: assessment.warnings,
        adaptive_routing_summary: assessment.adaptive_routing_summary,
      },
      worker_pool_pause: workerPoolPause,
      ...(assessment.can_auto_execute
        ? {
            worker_pool_recovery_suppressed: null,
          }
        : {}),
    },
    source_client: source?.source_client,
    source_model: source?.source_model,
    source_agent: source?.source_agent,
  }).plan;
}

function persistWorkerPoolRecoveryAttempt(
  storage: Storage,
  plan: PlanRecord,
  recoveryPoolFingerprint: string,
  source?: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  },
  sourcePlanId?: string
) {
  const existingAttempt = isRecord(plan.metadata.worker_pool_recovery_attempt) ? plan.metadata.worker_pool_recovery_attempt : null;
  if (
    readString(existingAttempt?.pool_fingerprint) === recoveryPoolFingerprint &&
    (readString(existingAttempt?.source_plan_id) ?? null) === (sourcePlanId ?? null)
  ) {
    return plan;
  }

  return storage.updatePlan({
    plan_id: plan.plan_id,
    metadata: {
      worker_pool_recovery_attempt: {
        attempted_at: new Date().toISOString(),
        pool_fingerprint: recoveryPoolFingerprint,
        source_plan_id: sourcePlanId ?? null,
      },
      worker_pool_recovery_suppressed: null,
    },
    source_client: source?.source_client,
    source_model: source?.source_model,
    source_agent: source?.source_agent,
  }).plan;
}

function persistWorkerPoolRecoverySuppression(
  storage: Storage,
  goal: GoalRecord,
  plan: PlanRecord,
  source: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const recoveryStatus = summarizeWorkerPoolRecoveryStatus(storage, plan);
  if (recoveryStatus.state !== "awaiting_pool_change" || !recoveryStatus.current_pool_fingerprint) {
    return {
      plan,
      recovery_status: recoveryStatus,
      suppression_count: 0,
      event_emitted: false,
    };
  }

  const existingSuppression = isRecord(plan.metadata.worker_pool_recovery_suppressed)
    ? plan.metadata.worker_pool_recovery_suppressed
    : null;
  const workerPoolPause = isRecord(plan.metadata.worker_pool_pause) ? plan.metadata.worker_pool_pause : null;
  const sameFingerprint = readString(existingSuppression?.pool_fingerprint) === recoveryStatus.current_pool_fingerprint;
  const suppressionCount = sameFingerprint ? (readFiniteNumber(existingSuppression?.count) ?? 0) + 1 : 1;
  const updatedPlan = storage.updatePlan({
    plan_id: plan.plan_id,
    metadata: {
      worker_pool_recovery_suppressed: {
        first_seen_at: sameFingerprint
          ? readString(existingSuppression?.first_seen_at) ?? new Date().toISOString()
          : new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        count: suppressionCount,
        pool_fingerprint: recoveryStatus.current_pool_fingerprint,
        last_attempted_pool_fingerprint: recoveryStatus.last_attempted_pool_fingerprint,
        reason: "awaiting_pool_change",
      },
    },
    ...source,
  }).plan;

  let eventEmitted = false;
  if (!sameFingerprint) {
    eventEmitted = true;
    storage.appendRuntimeEvent({
      event_type: "goal.worker_pool_recovery_waiting",
      entity_type: "goal",
      entity_id: goal.goal_id,
      status: goal.status,
      summary: `Goal ${goal.goal_id} is paused until the live worker pool changes.`,
      details: {
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        pause_reason: readString(workerPoolPause?.reason) ?? null,
        current_pool_fingerprint: recoveryStatus.current_pool_fingerprint,
        last_attempted_pool_fingerprint: recoveryStatus.last_attempted_pool_fingerprint,
        suppression_count: suppressionCount,
      },
      ...source,
    });
  }

  return {
    plan: updatedPlan,
    recovery_status: recoveryStatus,
    suppression_count: suppressionCount,
    event_emitted: eventEmitted,
  };
}

function listGoalAutorunCandidates(
  storage: Storage,
  input: Pick<GoalAutorunLikeInput, "goal_id" | "limit">,
  options?: {
    ignore_cooldown?: boolean;
  }
) {
  if (input.goal_id) {
    const goal = storage.getGoalById(input.goal_id);
    return goal ? [goal] : [];
  }

  const statuses: Array<z.infer<typeof goalStatusSchema>> = ["active", "waiting", "blocked"];
  const seen = new Set<string>();
  const goals: GoalRecord[] = [];
  const perStatusLimit = Math.max(25, input.limit ?? 25);

  for (const status of statuses) {
    for (const goal of storage.listGoals({ status, limit: perStatusLimit })) {
      if (seen.has(goal.goal_id)) {
        continue;
      }
      if (!options?.ignore_cooldown && readGoalAutorunCooldown(goal)) {
        continue;
      }
      seen.add(goal.goal_id);
      goals.push(goal);
    }
  }

  goals.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return goals.slice(0, input.limit ?? 25);
}

export async function goalCreate(storage: Storage, input: z.infer<typeof goalCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "goal.create",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.createGoal({
        goal_id: input.goal_id,
        title: input.title,
        objective: input.objective,
        status: input.status,
        priority: input.priority,
        risk_tier: input.risk_tier,
        autonomy_mode: input.autonomy_mode,
        target_entity_type: input.target_entity_type,
        target_entity_id: input.target_entity_id,
        acceptance_criteria: input.acceptance_criteria,
        constraints: input.constraints,
        assumptions: input.assumptions,
        budget: input.budget,
        owner: input.owner,
        tags: input.tags,
        metadata: mergeDeclaredPermissionProfile(input.metadata ?? {}, input.permission_profile),
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export function goalGet(storage: Storage, input: z.infer<typeof goalGetSchema>) {
  const goal = storage.getGoalById(input.goal_id);
  if (!goal) {
    return {
      found: false,
      goal_id: input.goal_id,
    };
  }
  return {
    found: true,
    goal,
  };
}

export function goalList(storage: Storage, input: z.infer<typeof goalListSchema>) {
  const goals = storage.listGoals({
    status: input.status,
    target_entity_type: input.target_entity_type,
    target_entity_id: input.target_entity_id,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    target_entity_type_filter: input.target_entity_type ?? null,
    target_entity_id_filter: input.target_entity_id ?? null,
    count: goals.length,
    goals,
  };
}

export async function goalExecute(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof goalExecuteSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "goal.execute",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      let goal = storage.getGoalById(input.goal_id);
      if (!goal) {
        throw new Error(`Goal not found: ${input.goal_id}`);
      }
      const source = {
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      };

      let planResolution = resolveGoalExecutionPlan(storage, input, goal);
      let generatedPlanResult: Record<string, unknown> | null = null;
      let plannerSelection: PlannerSelection | null = null;
      let generatedPlanReason: "missing_plan" | "worker_pool_recovery" | null = null;
      let methodologyEntryDecision: MethodologyEntryDecision | null = null;

      if (!planResolution.plan) {
        if (!input.create_plan_if_missing) {
          return {
            ok: true,
            executed: false,
            goal,
            created_plan: false,
            plan_resolution: planResolution.resolution,
            message: `No executable plan exists for goal ${goal.goal_id}.`,
            execution_summary: null,
            planner_selection: null,
          };
        }

        plannerSelection = input.hook_name
          ? buildExplicitPlannerSelection(input.hook_name)
          : resolveDefaultPlannerSelection(goal, input.options);
        methodologyEntryDecision = resolveMethodologyEntryDecision(storage, goal, plannerSelection);
        plannerSelection = methodologyEntryDecision.selection;
        if (methodologyEntryDecision.hold_generation) {
          goal = persistMethodologyEntryHold(storage, goal, methodologyEntryDecision, source);
          storage.appendRuntimeEvent({
            event_type: "goal.executed",
            entity_type: "goal",
            entity_id: goal.goal_id,
            status: goal.status,
            summary: `Goal ${goal.goal_id} execution held before plan generation because no viable worker pool is available.`,
            details: {
              action: "held_pre_generation_worker_pool",
              methodology_entry_decision: methodologyEntryDecision,
              planner_selection: plannerSelection,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
          return {
            ok: true,
            executed: false,
            held_before_generation: true,
            goal,
            created_plan: false,
            plan_resolution: planResolution.resolution,
            message: methodologyEntryDecision.reason,
            execution_summary: null,
            planner_selection: plannerSelection,
            methodology_entry_decision: methodologyEntryDecision,
          };
        }
        goal = clearMethodologyEntryHold(storage, goal, source);
        generatedPlanReason = "missing_plan";
        const generatedCandidate = await generateGoalExecutionPlanCandidate(storage, invokeTool, {
          input,
          goal,
          planner_selection: plannerSelection,
          source,
          generation_reason: generatedPlanReason,
        });
        generatedPlanResult = generatedCandidate.generated_plan_result;
        planResolution = generatedCandidate.plan_resolution;
      }

      goal = clearMethodologyEntryHold(storage, goal, source);

      let plan = planResolution.plan;
      if (!plan) {
        throw new Error(`Failed to resolve an execution plan for goal ${goal.goal_id}`);
      }
      let planAssessment =
        planResolution.assessment ?? assessPlanRisk(goal, plan, storage.listPlanSteps(plan.plan_id));
      const recoveryPoolFingerprint = resolveWorkerPoolRecoveryFingerprint(storage, input, plan, planAssessment);
      if (recoveryPoolFingerprint) {
        const recoverySourcePlanId = plan.plan_id;
        plannerSelection = input.hook_name
          ? buildExplicitPlannerSelection(input.hook_name)
          : resolveDefaultPlannerSelection(goal, input.options);
        generatedPlanReason = "worker_pool_recovery";
        const generatedCandidate = await generateGoalExecutionPlanCandidate(storage, invokeTool, {
          input,
          goal,
          planner_selection: plannerSelection,
          source,
          generation_reason: generatedPlanReason,
          previous_plan_id: plan.plan_id,
          recovery_pool_fingerprint: recoveryPoolFingerprint,
        });
        generatedPlanResult = generatedCandidate.generated_plan_result;
        const rankedCandidates = [
          {
            plan,
            resolution: planResolution.resolution,
            assessment: planAssessment,
          },
          ...(generatedCandidate.plan_resolution.plan && generatedCandidate.plan_resolution.assessment
            ? [
                {
                  plan: generatedCandidate.plan_resolution.plan,
                  resolution: generatedCandidate.plan_resolution.resolution,
                  assessment: generatedCandidate.plan_resolution.assessment,
                },
              ]
            : []),
        ].sort(compareGoalExecutionPlanCandidates);
        const bestCandidate = rankedCandidates[0];
        if (bestCandidate) {
          planResolution = bestCandidate;
          plan = bestCandidate.plan;
          planAssessment = bestCandidate.assessment;
        }
        plan = persistWorkerPoolRecoveryAttempt(storage, plan, recoveryPoolFingerprint, source, recoverySourcePlanId);
      }
      plan = persistPlanRiskAssessment(storage, goal, plan, planAssessment, source);

      let selectedExistingPlan = false;
      const shouldPauseForWorkerPool = planAssessment.can_auto_execute === false;
      if (shouldPauseForWorkerPool) {
        const snapshotGoal = storage.getGoalById(goal.goal_id) ?? goal;
        const pausedSteps = storage.listPlanSteps(plan.plan_id);
        const pausedSummary = summarizeGoalExecution(plan, pausedSteps);
        const pausedAdaptiveRouting = summarizePlanAdaptiveRouting(pausedSteps);
        storage.appendRuntimeEvent({
          event_type: "goal.executed",
          entity_type: "goal",
          entity_id: goal.goal_id,
          status: snapshotGoal.status,
          summary: `Goal ${goal.goal_id} execution paused because the worker pool is too weak for ${goal.autonomy_mode}.`,
          details: {
            action: "paused_worker_pool",
            plan_id: plan.plan_id,
            plan_status: plan.status,
            created_plan: generatedPlanResult !== null,
            generated_plan_reason: generatedPlanReason,
            plan_resolution: planResolution.resolution,
            planner_selection: plannerSelection,
            plan_risk_assessment: planAssessment,
            methodology_entry_decision: methodologyEntryDecision,
          },
          ...source,
        });
        return {
          ok: true,
          executed: false,
          paused_for_worker_pool: true,
          pause_reason: planAssessment.pause_reason,
          goal: snapshotGoal,
          plan,
          created_plan: generatedPlanResult !== null,
          generated_plan: generatedPlanResult,
          generated_plan_reason: generatedPlanReason,
          plan_resolution: planResolution.resolution,
          selected_existing_plan: false,
          message: planAssessment.pause_reason,
          execution_summary: pausedSummary,
          adaptive_routing_summary: pausedAdaptiveRouting,
          plan_risk_assessment: planAssessment,
          planner_selection: plannerSelection,
          methodology_entry_decision: methodologyEntryDecision,
          final_plan: plan,
          final_steps: pausedSteps,
          final_readiness: evaluatePlanStepReadiness(pausedSteps),
        };
      }

      const requiresSelectionAlignment = goal.active_plan_id !== plan.plan_id || !plan.selected;
      if (requiresSelectionAlignment) {
        await invokeTool("plan.select", {
          mutation: buildGoalExecuteDerivedMutation(input.mutation, "plan-select"),
          goal_id: goal.goal_id,
          plan_id: plan.plan_id,
          summary:
            planResolution.resolution === "generated"
              ? `goal.execute selected generated plan ${plan.plan_id}`
              : `goal.execute aligned goal ${goal.goal_id} to plan ${plan.plan_id}`,
          deselect_others: true,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        plan = storage.getPlanById(plan.plan_id);
        if (!plan) {
          throw new Error(`Plan disappeared during goal.execute selection alignment: ${goal.goal_id}`);
        }
        planAssessment = assessPlanRisk(goal, plan, storage.listPlanSteps(plan.plan_id));
        plan = persistPlanRiskAssessment(storage, goal, plan, planAssessment, source);
        if (planResolution.resolution !== "generated") {
          selectedExistingPlan = true;
        }
      }

      const snapshotGoal = storage.getGoalById(goal.goal_id) ?? goal;
      const initialSteps = storage.listPlanSteps(plan.plan_id);
      const initialSummary = summarizeGoalExecution(plan, initialSteps);
      const initialAdaptiveRouting = summarizePlanAdaptiveRouting(initialSteps);
      const effectiveTriChatAgentIds = input.autorun
        ? mergeGoalExecuteTriChatAgentIds(storage, snapshotGoal.objective, input.trichat_agent_ids)
        : undefined;

      if (isTerminalPlanStatus(plan.status)) {
        storage.appendRuntimeEvent({
          event_type: "goal.executed",
          entity_type: "goal",
          entity_id: goal.goal_id,
          status: snapshotGoal.status,
          summary: `Goal ${goal.goal_id} execution skipped because plan ${plan.plan_id} is terminal.`,
          details: {
            action: "skipped_terminal_plan",
            plan_id: plan.plan_id,
            plan_status: plan.status,
            created_plan: generatedPlanResult !== null,
            generated_plan_reason: generatedPlanReason,
            plan_resolution: planResolution.resolution,
            planner_selection: plannerSelection,
            adaptive_routing_summary: initialAdaptiveRouting,
            plan_risk_assessment: planAssessment,
            methodology_entry_decision: methodologyEntryDecision,
          },
          ...source,
        });
        return {
          ok: true,
          executed: false,
          goal: snapshotGoal,
          plan,
          created_plan: generatedPlanResult !== null,
          generated_plan: generatedPlanResult,
          generated_plan_reason: generatedPlanReason,
          plan_resolution: planResolution.resolution,
          selected_existing_plan: selectedExistingPlan,
          message: `Plan ${plan.plan_id} is already ${plan.status}.`,
          execution_summary: initialSummary,
          adaptive_routing_summary: initialAdaptiveRouting,
          plan_risk_assessment: planAssessment,
          planner_selection: plannerSelection,
          methodology_entry_decision: methodologyEntryDecision,
          final_plan: plan,
          final_steps: initialSteps,
          final_readiness: evaluatePlanStepReadiness(initialSteps),
        };
      }

      const executionResult = (await invokeTool(input.autorun ? "dispatch.autorun" : "plan.dispatch", {
        mutation: buildGoalExecuteDerivedMutation(input.mutation, input.autorun ? "autorun" : "dispatch"),
        plan_id: plan.plan_id,
        limit: input.dispatch_limit,
        allow_non_ready: input.autorun ? undefined : input.allow_non_ready,
        dry_run: input.dry_run,
        max_passes: input.autorun ? input.max_passes : undefined,
        trichat_agent_ids: effectiveTriChatAgentIds,
        trichat_max_rounds: input.autorun ? input.trichat_max_rounds : undefined,
        trichat_min_success_agents: input.autorun ? input.trichat_min_success_agents : undefined,
        trichat_bridge_timeout_seconds: input.autorun ? input.trichat_bridge_timeout_seconds : undefined,
        trichat_bridge_dry_run: input.autorun ? input.trichat_bridge_dry_run : undefined,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      })) as Record<string, unknown>;

      const finalGoal = storage.getGoalById(goal.goal_id) ?? goal;
      let finalPlan = storage.getPlanById(plan.plan_id);
      if (!finalPlan) {
        throw new Error(`Plan disappeared during goal.execute: ${plan.plan_id}`);
      }
      const finalSteps = storage.listPlanSteps(plan.plan_id);
      const finalReadiness = evaluatePlanStepReadiness(finalSteps);
      const executionSummary = summarizeGoalExecution(finalPlan, finalSteps);
      const finalPlanAssessment = assessPlanRisk(finalGoal, finalPlan, finalSteps);
      finalPlan = persistPlanRiskAssessment(storage, finalGoal, finalPlan, finalPlanAssessment, source);
      const adaptiveRoutingSummary = finalPlanAssessment.adaptive_routing_summary;

      storage.appendRuntimeEvent({
        event_type: "goal.executed",
        entity_type: "goal",
        entity_id: goal.goal_id,
        status: finalGoal.status,
        summary: `Goal ${goal.goal_id} executed via ${input.autorun ? "dispatch.autorun" : "plan.dispatch"}.`,
        details: {
          plan_id: finalPlan.plan_id,
          plan_status: finalPlan.status,
          created_plan: generatedPlanResult !== null,
          generated_plan_reason: generatedPlanReason,
          plan_resolution: planResolution.resolution,
          selected_existing_plan: selectedExistingPlan,
          planner_selection: plannerSelection,
          dispatch_mode: input.autorun ? "autorun" : "dispatch",
          dry_run: input.dry_run ?? false,
          trichat_agent_ids: effectiveTriChatAgentIds,
          execution_summary: executionSummary,
          adaptive_routing_summary: adaptiveRoutingSummary,
          plan_risk_assessment: finalPlanAssessment,
          methodology_entry_decision: methodologyEntryDecision,
        },
        ...source,
      });

      return {
        ok: true,
        executed: true,
        goal: finalGoal,
        plan: finalPlan,
        created_plan: generatedPlanResult !== null,
        generated_plan: generatedPlanResult,
        generated_plan_reason: generatedPlanReason,
        plan_resolution: planResolution.resolution,
        selected_existing_plan: selectedExistingPlan,
        planner_selection: plannerSelection,
        dispatch_mode: input.autorun ? "autorun" : "dispatch",
        trichat_agent_ids: effectiveTriChatAgentIds,
        execution: executionResult,
        execution_summary: executionSummary,
        adaptive_routing_summary: adaptiveRoutingSummary,
        plan_risk_assessment: finalPlanAssessment,
        methodology_entry_decision: methodologyEntryDecision,
        final_plan: finalPlan,
        final_steps: finalSteps,
        final_readiness: finalReadiness,
      };
    },
  });
}

async function executeGoalAutorunPass(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: GoalAutorunLikeInput
) {
  const mutation = input.mutation ?? buildGoalAutorunDerivedMutation("pass");
  const candidates = listGoalAutorunCandidates(storage, {
    goal_id: input.goal_id,
    limit: input.limit,
  });
  const results: Array<Record<string, unknown>> = [];
  let executedCount = 0;
  let skippedCount = 0;
  let compactedCount = 0;

  for (const goal of candidates) {
    const source = {
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    };
    const planResolution = resolveGoalExecutionPlan(
      storage,
      {
        ...input,
        mutation,
        goal_id: goal.goal_id,
        create_plan_if_missing: input.create_plan_if_missing ?? !input.goal_id,
        pack_id: input.pack_id ?? "agentic",
        autorun: true,
      },
      goal
    );

    const plan = planResolution.plan;
    if (!plan) {
      const methodologyHold = summarizeGoalMethodologyEntryHoldStatus(storage, goal);
      if (methodologyHold.state === "blocked_by_no_viable_lane") {
        skippedCount += 1;
        results.push({
          goal_id: goal.goal_id,
          action: "skipped",
          reason: "held_pre_generation_worker_pool",
          methodology_entry_hold: {
            state: methodologyHold.state,
            hold_count: methodologyHold.hold_count,
            hold_reason: methodologyHold.hold_reason,
            current_pool_fingerprint: methodologyHold.current_pool_fingerprint,
          },
        });
        continue;
      }
      if (methodologyHold.state === "ready_for_recovery") {
        storage.appendRuntimeEvent({
          event_type: "goal.entry_recovery_ready",
          entity_type: "goal",
          entity_id: goal.goal_id,
          status: goal.status,
          summary: `Goal ${goal.goal_id} can retry plan generation because a viable worker lane is now available.`,
          details: {
            goal_id: goal.goal_id,
            current_pool_fingerprint: methodologyHold.current_pool_fingerprint,
            hold_count: methodologyHold.hold_count,
            hold_reason: methodologyHold.hold_reason,
          },
          ...source,
        });
        clearMethodologyEntryHold(storage, goal, source);
      }
      if (input.create_plan_if_missing === false) {
        skippedCount += 1;
        results.push({
          goal_id: goal.goal_id,
          action: "skipped",
          reason: "missing_plan",
          plan_resolution: planResolution.resolution,
        });
        continue;
      }
      const executed = (await invokeTool("goal.execute", {
        mutation: buildGoalExecuteDerivedMutation(mutation, `autorun:${goal.goal_id}`),
        goal_id: goal.goal_id,
        create_plan_if_missing: true,
        pack_id: input.pack_id,
        hook_name: input.hook_name,
        context_artifact_ids: input.context_artifact_ids,
        options: input.options,
        title: input.title,
        selected: input.selected,
        dispatch_limit: input.dispatch_limit,
        dry_run: input.dry_run,
        autorun: true,
        max_passes: input.max_passes,
        trichat_agent_ids: input.trichat_agent_ids,
        trichat_max_rounds: input.trichat_max_rounds,
        trichat_min_success_agents: input.trichat_min_success_agents,
        trichat_bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
        trichat_bridge_dry_run: input.trichat_bridge_dry_run,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      })) as Record<string, unknown>;
      clearGoalAutorunCooldown(storage, goal, source);
      executedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        action: "executed",
        reason: "generated_plan",
        execution: executed,
      });
      continue;
    }

    if (isTerminalPlanStatus(plan.status)) {
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        action: "skipped",
        reason: "terminal_plan",
        plan_status: plan.status,
      });
      continue;
    }

    let planRecord = plan;
    const steps = storage.listPlanSteps(plan.plan_id);
    const planAssessment = planResolution.assessment ?? assessPlanRisk(goal, planRecord, steps);
    planRecord = persistPlanRiskAssessment(storage, goal, planRecord, planAssessment, source);
    if (!planAssessment.can_auto_execute) {
      const recoveryStatus = summarizeWorkerPoolRecoveryStatus(storage, planRecord);
      const recoveryPoolFingerprint = resolveWorkerPoolRecoveryFingerprint(
        storage,
        {
          create_plan_if_missing: input.create_plan_if_missing,
        },
        planRecord,
        planAssessment
      );
      if (recoveryPoolFingerprint) {
        const executed = (await invokeTool("goal.execute", {
          mutation: buildGoalExecuteDerivedMutation(mutation, `autorun-recover:${goal.goal_id}`),
          goal_id: goal.goal_id,
          create_plan_if_missing: input.create_plan_if_missing ?? true,
          pack_id: input.pack_id,
          hook_name: input.hook_name,
          context_artifact_ids: input.context_artifact_ids,
          options: input.options,
          title: input.title,
          selected: input.selected,
          dispatch_limit: input.dispatch_limit,
          dry_run: input.dry_run,
          autorun: true,
          max_passes: input.max_passes,
          trichat_agent_ids: input.trichat_agent_ids,
          trichat_max_rounds: input.trichat_max_rounds,
          trichat_min_success_agents: input.trichat_min_success_agents,
          trichat_bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
          trichat_bridge_dry_run: input.trichat_bridge_dry_run,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        })) as Record<string, unknown>;
        clearGoalAutorunCooldown(storage, goal, source);
        executedCount += 1;
        results.push({
          goal_id: goal.goal_id,
          plan_id: planRecord.plan_id,
          action: "executed",
          reason: "worker_pool_recovery",
          execution: executed,
        });
        continue;
      }

      let suppressionCount = 0;
      if (recoveryStatus.state === "awaiting_pool_change") {
        const suppressed = persistWorkerPoolRecoverySuppression(storage, goal, planRecord, source);
        planRecord = suppressed.plan;
        suppressionCount = suppressed.suppression_count;
      }

      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: planRecord.plan_id,
        action: "skipped",
        reason: "worker_pool_paused",
        pause_reason: planAssessment.pause_reason,
        plan_risk_assessment: planAssessment,
        recovery_state: recoveryStatus.state,
        current_pool_fingerprint: recoveryStatus.current_pool_fingerprint,
        last_attempted_pool_fingerprint: recoveryStatus.last_attempted_pool_fingerprint,
        suppression_count: suppressionCount,
      });
      continue;
    }

    const summary = summarizeGoalExecution(planRecord, steps);
    const runningWorkerStep = steps.find(
      (step) => step.status === "running" && (step.executor_kind === "worker" || step.executor_kind === "task")
    );
    const blockedApprovalStep = summary.blocked_approval_steps[0] ?? null;
    const hasRunningTriChat = steps.some((step) => step.status === "running" && step.executor_kind === "trichat");
    const currentCooldown = readGoalAutorunCooldown(goal);

    if (
      shouldCompactIdleGoal({
        goal,
        blockedApprovalStep,
        runningWorkerStep,
        hasRunningTriChat,
        cooldown: currentCooldown,
        explicitGoalId: Boolean(input.goal_id),
      })
    ) {
      const archivedGoal = await compactIdleGoalForAutorun(storage, invokeTool, {
        goal,
        plan: planRecord,
        summary,
        cooldown: currentCooldown,
        mutation,
        source,
      });
      compactedCount += 1;
      results.push({
        goal_id: archivedGoal.goal_id,
        plan_id: planRecord.plan_id,
        action: "archived",
        reason: "stale_idle_ephemeral_goal",
      });
      continue;
    }

    if (blockedApprovalStep) {
      const cooledGoal = persistGoalAutorunCooldown(
        storage,
        goal,
        blockedApprovalStep.gate_type === "policy" ? "policy_gate" : "human_gate",
        source
      );
      const cooldown = readGoalAutorunCooldown(cooledGoal);
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: planRecord.plan_id,
        action: "skipped",
        reason: blockedApprovalStep.gate_type === "policy" ? "policy_gate" : "human_gate",
        blocked_step: blockedApprovalStep,
        execution_summary: summary,
        autorun_cooldown_until: cooldown?.until_at ?? null,
      });
      continue;
    }

    if (runningWorkerStep) {
      const cooledGoal = persistGoalAutorunCooldown(storage, goal, "running_worker", source);
      const cooldown = readGoalAutorunCooldown(cooledGoal);
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: planRecord.plan_id,
        action: "skipped",
        reason: "running_worker",
        running_step: {
          step_id: runningWorkerStep.step_id,
          title: runningWorkerStep.title,
          task_id: runningWorkerStep.task_id,
        },
        execution_summary: summary,
        autorun_cooldown_until: cooldown?.until_at ?? null,
      });
      continue;
    }

    if (summary.ready_count === 0 && !hasRunningTriChat) {
      const cooledGoal = persistGoalAutorunCooldown(storage, goal, "idle_no_ready_work", source);
      const cooldown = readGoalAutorunCooldown(cooledGoal);
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: planRecord.plan_id,
        action: "skipped",
        reason: "idle_no_ready_work",
        execution_summary: summary,
        autorun_cooldown_until: cooldown?.until_at ?? null,
      });
      continue;
    }

    const executed = (await invokeTool("goal.execute", {
      mutation: buildGoalExecuteDerivedMutation(mutation, `autorun:${goal.goal_id}`),
      goal_id: goal.goal_id,
      plan_id: planRecord.plan_id,
      create_plan_if_missing: input.create_plan_if_missing,
      pack_id: input.pack_id,
      hook_name: input.hook_name,
      context_artifact_ids: input.context_artifact_ids,
      options: input.options,
      title: input.title,
      selected: input.selected,
      dispatch_limit: input.dispatch_limit,
      dry_run: input.dry_run,
      autorun: true,
      max_passes: input.max_passes,
      trichat_agent_ids: input.trichat_agent_ids,
      trichat_max_rounds: input.trichat_max_rounds,
      trichat_min_success_agents: input.trichat_min_success_agents,
      trichat_bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
      trichat_bridge_dry_run: input.trichat_bridge_dry_run,
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    })) as Record<string, unknown>;
    clearGoalAutorunCooldown(storage, goal, source);
    executedCount += 1;
    results.push({
      goal_id: goal.goal_id,
      plan_id: planRecord.plan_id,
      action: "executed",
      reason: hasRunningTriChat ? "continue_trichat_backend" : "ready_work",
      execution: executed,
    });
  }

  const event = storage.appendRuntimeEvent({
    event_type: "goal.autorun",
    entity_type: "goal",
    entity_id: input.goal_id ?? null,
    summary: `goal.autorun scanned ${candidates.length} goal(s) and executed ${executedCount}.`,
    details: {
      goal_id: input.goal_id ?? null,
      scanned_count: candidates.length,
      executed_count: executedCount,
      compacted_count: compactedCount,
      skipped_count: skippedCount,
      dry_run: input.dry_run ?? false,
    },
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });

  return {
    ok: true,
    scanned_count: candidates.length,
    executed_count: executedCount,
    compacted_count: compactedCount,
    progress_count: executedCount + compactedCount,
    skipped_count: skippedCount,
    results,
    event,
  };
}

async function executeGoalHygienePass(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof goalHygieneSchema>
) {
  const candidates = listGoalAutorunCandidates(
    storage,
    {
      goal_id: input.goal_id,
      limit: input.limit,
    },
    { ignore_cooldown: true }
  );
  const results: Array<Record<string, unknown>> = [];
  let archivedCount = 0;
  let skippedCount = 0;

  for (const goal of candidates) {
    const source = {
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    };
    const planResolution = resolveGoalExecutionPlan(
      storage,
      {
        goal_id: goal.goal_id,
        create_plan_if_missing: false,
        pack_id: "agentic",
        autorun: true,
        mutation: input.mutation,
      },
      goal
    );
    const plan = planResolution.plan;
    if (!plan || isTerminalPlanStatus(plan.status)) {
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: plan?.plan_id ?? null,
        action: "skipped",
        reason: !plan ? "missing_plan" : "terminal_plan",
      });
      continue;
    }

    const steps = storage.listPlanSteps(plan.plan_id);
    const summary = summarizeGoalExecution(plan, steps);
    const runningWorkerStep = steps.find(
      (step) => step.status === "running" && (step.executor_kind === "worker" || step.executor_kind === "task")
    );
    const blockedApprovalStep = summary.blocked_approval_steps[0] ?? null;
    const hasRunningTriChat = steps.some((step) => step.status === "running" && step.executor_kind === "trichat");

    if (
      input.archive_idle_ephemeral_goals !== false &&
      shouldCompactIdleGoal({
        goal,
        blockedApprovalStep,
        runningWorkerStep,
        hasRunningTriChat,
        cooldown: null,
        explicitGoalId: Boolean(input.goal_id),
        ignoreCooldownRequirement: true,
      })
    ) {
      const archivedGoal = await compactIdleGoalForAutorun(storage, invokeTool, {
        goal,
        plan,
        summary,
        cooldown: null,
        mutation: input.mutation,
        source,
      });
      archivedCount += 1;
      results.push({
        goal_id: archivedGoal.goal_id,
        plan_id: plan.plan_id,
        action: "archived",
        reason: "stale_idle_ephemeral_goal",
      });
      continue;
    }

    skippedCount += 1;
    results.push({
      goal_id: goal.goal_id,
      plan_id: plan.plan_id,
      action: "skipped",
      reason: "not_compactable",
    });
  }

  const event = storage.appendRuntimeEvent({
    event_type: "goal.hygiene",
    entity_type: "goal",
    entity_id: input.goal_id ?? null,
    summary: `goal.hygiene scanned ${candidates.length} goal(s) and archived ${archivedCount}.`,
    details: {
      goal_id: input.goal_id ?? null,
      scanned_count: candidates.length,
      archived_count: archivedCount,
      skipped_count: skippedCount,
      archive_idle_ephemeral_goals: input.archive_idle_ephemeral_goals !== false,
    },
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });

  return {
    ok: true,
    scanned_count: candidates.length,
    archived_count: archivedCount,
    skipped_count: skippedCount,
    results,
    event,
  };
}

function getGoalAutorunStatus() {
  return {
    running: goalAutorunRuntime.running,
    in_tick: goalAutorunRuntime.in_tick,
    config: { ...goalAutorunRuntime.config },
    started_at: goalAutorunRuntime.started_at,
    last_tick_at: goalAutorunRuntime.last_tick_at,
    last_error: goalAutorunRuntime.last_error,
    tick_count: goalAutorunRuntime.tick_count,
    total_executed_goals: goalAutorunRuntime.total_executed_goals,
    total_skipped_goals: goalAutorunRuntime.total_skipped_goals,
    no_progress_count: goalAutorunRuntime.no_progress_count,
    last_idle_at: goalAutorunRuntime.last_idle_at,
  };
}

function stopGoalAutorunDaemon() {
  if (goalAutorunRuntime.timer) {
    clearInterval(goalAutorunRuntime.timer);
    goalAutorunRuntime.timer = null;
  }
  goalAutorunRuntime.running = false;
  goalAutorunRuntime.started_at = null;
}

function startGoalAutorunDaemon(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>
) {
  if (goalAutorunRuntime.timer) {
    clearInterval(goalAutorunRuntime.timer);
    goalAutorunRuntime.timer = null;
  }
  goalAutorunRuntime.running = true;
  goalAutorunRuntime.started_at = new Date().toISOString();
  goalAutorunRuntime.timer = setInterval(() => {
    void runGoalAutorunTick(storage, invokeTool, goalAutorunRuntime.config);
  }, goalAutorunRuntime.config.interval_seconds * 1000);
  goalAutorunRuntime.timer.unref?.();
}

async function runGoalAutorunTick(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  config: GoalAutorunDaemonConfig
) {
  if (goalAutorunRuntime.in_tick) {
    return {
      skipped: true,
      reason: "already-running",
      status: getGoalAutorunStatus(),
    };
  }

  goalAutorunRuntime.in_tick = true;
  try {
    const result = await executeGoalAutorunPass(storage, invokeTool, {
      goal_id: config.goal_id,
      limit: config.limit,
      create_plan_if_missing: config.create_plan_if_missing,
      dry_run: config.dry_run,
      dispatch_limit: config.dispatch_limit,
      max_passes: config.max_passes,
      pack_id: config.pack_id,
      hook_name: config.hook_name,
      context_artifact_ids: config.context_artifact_ids,
      options: config.options,
      title: config.title,
      selected: config.selected,
      trichat_agent_ids: config.trichat_agent_ids,
      trichat_max_rounds: config.trichat_max_rounds,
      trichat_min_success_agents: config.trichat_min_success_agents,
      trichat_bridge_timeout_seconds: config.trichat_bridge_timeout_seconds,
      trichat_bridge_dry_run: config.trichat_bridge_dry_run,
      source_client: config.source_client,
      source_model: config.source_model,
      source_agent: config.source_agent ?? "goal.autorun_daemon",
      mutation: buildGoalAutorunDerivedMutation("tick"),
    });
    goalAutorunRuntime.last_tick_at = new Date().toISOString();
    goalAutorunRuntime.last_error = null;
    goalAutorunRuntime.tick_count += 1;
    goalAutorunRuntime.total_executed_goals += result.executed_count;
    goalAutorunRuntime.total_skipped_goals += result.skipped_count;
    if (result.scanned_count === 0) {
      goalAutorunRuntime.no_progress_count = 0;
      goalAutorunRuntime.last_idle_at = goalAutorunRuntime.last_tick_at;
    } else {
      goalAutorunRuntime.no_progress_count =
        result.progress_count === 0 ? goalAutorunRuntime.no_progress_count + 1 : 0;
      if (result.progress_count > 0) {
        goalAutorunRuntime.last_idle_at = null;
      }
    }
    if (
      goalAutorunRuntime.no_progress_count >= 3 &&
      (goalAutorunRuntime.no_progress_count === 3 || goalAutorunRuntime.no_progress_count % 10 === 0)
    ) {
      storage.appendRuntimeEvent({
        event_type: "goal.autorun_stalled",
        entity_type: "goal",
        entity_id: config.goal_id ?? null,
        summary: `goal.autorun daemon has seen ${goalAutorunRuntime.no_progress_count} consecutive no-progress ticks.`,
        details: {
          no_progress_count: goalAutorunRuntime.no_progress_count,
          config,
        },
        source_agent: config.source_agent ?? "goal.autorun_daemon",
        source_client: config.source_client,
        source_model: config.source_model,
      });
    }
    return {
      skipped: false,
      tick: result,
      status: getGoalAutorunStatus(),
    };
  } catch (error) {
    goalAutorunRuntime.last_tick_at = new Date().toISOString();
    goalAutorunRuntime.last_error = error instanceof Error ? error.message : String(error);
    goalAutorunRuntime.tick_count += 1;
    storage.appendRuntimeEvent({
      event_type: "goal.autorun_failed",
      entity_type: "goal",
      entity_id: config.goal_id ?? null,
      status: "failed",
      summary: "goal.autorun daemon tick failed.",
      details: {
        error: goalAutorunRuntime.last_error,
        config,
      },
      source_agent: config.source_agent ?? "goal.autorun_daemon",
      source_client: config.source_client,
      source_model: config.source_model,
    });
    throw error;
  } finally {
    goalAutorunRuntime.in_tick = false;
  }
}

export function initializeGoalAutorunDaemon(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>
) {
  const persisted = storage.getGoalAutorunState();
  if (!persisted) {
    goalAutorunRuntime.config = { ...DEFAULT_GOAL_AUTORUN_CONFIG };
    stopGoalAutorunDaemon();
    return {
      restored: false,
      running: false,
      config: { ...goalAutorunRuntime.config },
    };
  }

  goalAutorunRuntime.config = resolveGoalAutorunConfig(
    {
      ...persisted,
      hook_name: persisted.hook_name ?? undefined,
    },
    DEFAULT_GOAL_AUTORUN_CONFIG
  );
  if (persisted.enabled) {
    startGoalAutorunDaemon(storage, invokeTool);
  } else {
    stopGoalAutorunDaemon();
  }

  return {
    restored: true,
    running: goalAutorunRuntime.running,
    config: { ...goalAutorunRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function goalAutorunDaemonControl(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof goalAutorunDaemonSchema>
) {
  if (input.action === "status") {
    return getGoalAutorunStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "goal.autorun_daemon",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      if (input.action === "start") {
        const wasRunning = goalAutorunRuntime.running;
        goalAutorunRuntime.config = resolveGoalAutorunConfig(input, goalAutorunRuntime.config);
        startGoalAutorunDaemon(storage, invokeTool);
        const persisted = storage.setGoalAutorunState({
          enabled: true,
          interval_seconds: goalAutorunRuntime.config.interval_seconds,
          limit: goalAutorunRuntime.config.limit,
          create_plan_if_missing: goalAutorunRuntime.config.create_plan_if_missing,
          dispatch_limit: goalAutorunRuntime.config.dispatch_limit,
          max_passes: goalAutorunRuntime.config.max_passes,
          pack_id: goalAutorunRuntime.config.pack_id,
          hook_name: goalAutorunRuntime.config.hook_name,
        });
        const initialTick = input.run_immediately ?? true
          ? await runGoalAutorunTick(storage, invokeTool, goalAutorunRuntime.config)
          : undefined;
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...goalAutorunRuntime.config },
          persisted,
          initial_tick: initialTick,
          status: getGoalAutorunStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = goalAutorunRuntime.running;
        stopGoalAutorunDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setGoalAutorunState({
            enabled: false,
            interval_seconds: goalAutorunRuntime.config.interval_seconds,
            limit: goalAutorunRuntime.config.limit,
            create_plan_if_missing: goalAutorunRuntime.config.create_plan_if_missing,
            dispatch_limit: goalAutorunRuntime.config.dispatch_limit,
            max_passes: goalAutorunRuntime.config.max_passes,
            pack_id: goalAutorunRuntime.config.pack_id,
            hook_name: goalAutorunRuntime.config.hook_name,
          }),
          status: getGoalAutorunStatus(),
        };
      }

      const config = resolveGoalAutorunConfig(input, goalAutorunRuntime.config);
      return {
        running: goalAutorunRuntime.running,
        tick: await runGoalAutorunTick(storage, invokeTool, config),
        status: getGoalAutorunStatus(),
      };
    },
  });
}

export async function goalAutorun(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof goalAutorunSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "goal.autorun",
    mutation: input.mutation,
    payload: input,
    execute: async () => executeGoalAutorunPass(storage, invokeTool, input),
  });
}

export async function goalHygiene(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof goalHygieneSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "goal.hygiene",
    mutation: input.mutation,
    payload: input,
    execute: async () => executeGoalHygienePass(storage, invokeTool, input),
  });
}
