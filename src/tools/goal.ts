import { z } from "zod";
import { type GoalRecord, type PlanRecord, type PlanStepRecord, Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
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
type PlannerSelection = {
  hook_name: string;
  methodology: "delivery" | "optimization";
  reason: string;
  evidence: Record<string, unknown>;
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

function buildExplicitPlannerSelection(hookName: string): PlannerSelection {
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

function isTerminalPlanStatus(status: PlanRecord["status"]) {
  return status === "completed" || status === "invalidated" || status === "archived";
}

function resolveGoalExecutionPlan(
  storage: Storage,
  input: z.infer<typeof goalExecuteSchema>,
  goal: GoalRecord
): { plan: PlanRecord | null; resolution: GoalExecutionPlanResolution } {
  if (input.plan_id) {
    const plan = storage.getPlanById(input.plan_id);
    if (!plan) {
      throw new Error(`Plan not found: ${input.plan_id}`);
    }
    if (plan.goal_id !== goal.goal_id) {
      throw new Error(`Plan ${input.plan_id} does not belong to goal ${goal.goal_id}`);
    }
    return {
      plan,
      resolution: "explicit",
    };
  }

  if (goal.active_plan_id) {
    const activePlan = storage.getPlanById(goal.active_plan_id);
    if (activePlan && activePlan.goal_id === goal.goal_id && !isTerminalPlanStatus(activePlan.status)) {
      return {
        plan: activePlan,
        resolution: "active",
      };
    }
  }

  const selectedPlan = storage
    .listPlans({
      goal_id: goal.goal_id,
      selected_only: true,
      limit: 20,
    })
    .find((plan) => !isTerminalPlanStatus(plan.status));
  if (selectedPlan) {
    return {
      plan: selectedPlan,
      resolution: "selected",
    };
  }

  const latestPlan = storage
    .listPlans({
      goal_id: goal.goal_id,
      limit: 20,
    })
    .find((plan) => !isTerminalPlanStatus(plan.status));
  if (latestPlan) {
    return {
      plan: latestPlan,
      resolution: "latest",
    };
  }

  return {
    plan: null,
    resolution: "missing",
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

function listGoalAutorunCandidates(storage: Storage, input: Pick<GoalAutorunLikeInput, "goal_id" | "limit">) {
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
        metadata: input.metadata,
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
      const goal = storage.getGoalById(input.goal_id);
      if (!goal) {
        throw new Error(`Goal not found: ${input.goal_id}`);
      }

      let planResolution = resolveGoalExecutionPlan(storage, input, goal);
      let generatedPlanResult: Record<string, unknown> | null = null;
      let plannerSelection: PlannerSelection | null = null;

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
        const generated = await invokeTool("pack.plan.generate", {
          mutation: buildGoalExecuteDerivedMutation(input.mutation, "plan-generate"),
          pack_id: input.pack_id,
          hook_name: plannerSelection.hook_name,
          target: {
            entity_type: "goal",
            entity_id: goal.goal_id,
          },
          goal_id: goal.goal_id,
          context_artifact_ids: input.context_artifact_ids,
          options: {
            ...(input.options ?? {}),
            methodology_selection: plannerSelection,
          },
          plan_id: input.plan_id,
          title: input.title,
          selected: input.selected ?? true,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        if (!isRecord(generated) || !isRecord(generated.plan) || !readString(generated.plan.plan_id)) {
          throw new Error(`pack.plan.generate did not return a plan for goal ${goal.goal_id}`);
        }
        generatedPlanResult = generated;
        const generatedPlanId = String(generated.plan.plan_id);
        const generatedPlan = storage.getPlanById(generatedPlanId);
        if (generatedPlan && plannerSelection) {
          planResolution = {
            resolution: "generated",
            plan: storage.updatePlan({
              plan_id: generatedPlanId,
              metadata: {
                methodology_selection: plannerSelection,
              },
            }).plan,
          };
        } else {
          planResolution = {
            resolution: "generated",
            plan: generatedPlan ?? null,
          };
        }
      }

      let plan = planResolution.plan;
      if (!plan) {
        throw new Error(`Failed to resolve an execution plan for goal ${goal.goal_id}`);
      }

      let selectedExistingPlan = false;
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
        if (planResolution.resolution !== "generated") {
          selectedExistingPlan = true;
        }
      }

      const snapshotGoal = storage.getGoalById(goal.goal_id) ?? goal;
      const initialSteps = storage.listPlanSteps(plan.plan_id);
      const initialSummary = summarizeGoalExecution(plan, initialSteps);
      const initialAdaptiveRouting = summarizePlanAdaptiveRouting(initialSteps);

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
            plan_resolution: planResolution.resolution,
            planner_selection: plannerSelection,
            adaptive_routing_summary: initialAdaptiveRouting,
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        return {
          ok: true,
          executed: false,
          goal: snapshotGoal,
          plan,
          created_plan: generatedPlanResult !== null,
          generated_plan: generatedPlanResult,
          plan_resolution: planResolution.resolution,
          selected_existing_plan: selectedExistingPlan,
          message: `Plan ${plan.plan_id} is already ${plan.status}.`,
          execution_summary: initialSummary,
          adaptive_routing_summary: initialAdaptiveRouting,
          planner_selection: plannerSelection,
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
        trichat_agent_ids: input.autorun ? input.trichat_agent_ids : undefined,
        trichat_max_rounds: input.autorun ? input.trichat_max_rounds : undefined,
        trichat_min_success_agents: input.autorun ? input.trichat_min_success_agents : undefined,
        trichat_bridge_timeout_seconds: input.autorun ? input.trichat_bridge_timeout_seconds : undefined,
        trichat_bridge_dry_run: input.autorun ? input.trichat_bridge_dry_run : undefined,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      })) as Record<string, unknown>;

      const finalGoal = storage.getGoalById(goal.goal_id) ?? goal;
      const finalPlan = storage.getPlanById(plan.plan_id);
      if (!finalPlan) {
        throw new Error(`Plan disappeared during goal.execute: ${plan.plan_id}`);
      }
      const finalSteps = storage.listPlanSteps(plan.plan_id);
      const finalReadiness = evaluatePlanStepReadiness(finalSteps);
      const executionSummary = summarizeGoalExecution(finalPlan, finalSteps);
      const adaptiveRoutingSummary = summarizePlanAdaptiveRouting(finalSteps);

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
          plan_resolution: planResolution.resolution,
          selected_existing_plan: selectedExistingPlan,
          planner_selection: plannerSelection,
          dispatch_mode: input.autorun ? "autorun" : "dispatch",
          dry_run: input.dry_run ?? false,
          execution_summary: executionSummary,
          adaptive_routing_summary: adaptiveRoutingSummary,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      return {
        ok: true,
        executed: true,
        goal: finalGoal,
        plan: finalPlan,
        created_plan: generatedPlanResult !== null,
        generated_plan: generatedPlanResult,
        plan_resolution: planResolution.resolution,
        selected_existing_plan: selectedExistingPlan,
        planner_selection: plannerSelection,
        dispatch_mode: input.autorun ? "autorun" : "dispatch",
        execution: executionResult,
        execution_summary: executionSummary,
        adaptive_routing_summary: adaptiveRoutingSummary,
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

  for (const goal of candidates) {
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

    const steps = storage.listPlanSteps(plan.plan_id);
    const summary = summarizeGoalExecution(plan, steps);
    const runningWorkerStep = steps.find(
      (step) => step.status === "running" && (step.executor_kind === "worker" || step.executor_kind === "task")
    );
    const blockedApprovalStep = summary.blocked_approval_steps[0] ?? null;
    const hasRunningTriChat = steps.some((step) => step.status === "running" && step.executor_kind === "trichat");

    if (blockedApprovalStep) {
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        action: "skipped",
        reason: blockedApprovalStep.gate_type === "policy" ? "policy_gate" : "human_gate",
        blocked_step: blockedApprovalStep,
        execution_summary: summary,
      });
      continue;
    }

    if (runningWorkerStep) {
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        action: "skipped",
        reason: "running_worker",
        running_step: {
          step_id: runningWorkerStep.step_id,
          title: runningWorkerStep.title,
          task_id: runningWorkerStep.task_id,
        },
        execution_summary: summary,
      });
      continue;
    }

    if (summary.ready_count === 0 && !hasRunningTriChat) {
      skippedCount += 1;
      results.push({
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        action: "skipped",
        reason: "idle_no_ready_work",
        execution_summary: summary,
      });
      continue;
    }

    const executed = (await invokeTool("goal.execute", {
      mutation: buildGoalExecuteDerivedMutation(mutation, `autorun:${goal.goal_id}`),
      goal_id: goal.goal_id,
      plan_id: plan.plan_id,
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
    executedCount += 1;
    results.push({
      goal_id: goal.goal_id,
      plan_id: plan.plan_id,
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
    goalAutorunRuntime.no_progress_count = result.executed_count === 0 ? goalAutorunRuntime.no_progress_count + 1 : 0;
    if (goalAutorunRuntime.no_progress_count >= 3) {
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
