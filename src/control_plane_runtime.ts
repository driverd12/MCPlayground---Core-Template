import {
  evaluateFeatureFlag,
  extractBudgetUsage,
  normalizePermissionProfileId,
  permissionProfileAllowsRequirement,
  resolveInheritedPermissionProfileId,
  type BudgetUsageRecord,
  type FeatureFlagId,
  type PermissionProfileId,
} from "./control_plane.js";
import { Storage, type AgentSessionRecord, type GoalRecord, type PlanRecord, type PlanStepRecord, type TaskRecord } from "./storage.js";

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

function readBudgetNumber(value: unknown): number | null {
  const parsed = readFiniteNumber(value);
  return parsed === null ? null : Number(parsed.toFixed(6));
}

function readBudgetInteger(value: unknown): number | null {
  const parsed = readFiniteNumber(value);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

export function mergeDeclaredPermissionProfile(
  metadata: Record<string, unknown> | undefined,
  permissionProfile: string | null | undefined
) {
  const normalized = normalizePermissionProfileId(permissionProfile);
  if (!normalized) {
    return metadata ?? {};
  }
  return {
    ...(metadata ?? {}),
    permission_profile: normalized,
  };
}

function readDeclaredPermissionProfile(...sources: unknown[]): PermissionProfileId | null {
  for (const source of sources) {
    const normalized = normalizePermissionProfileId(source);
    if (normalized) {
      return normalized;
    }
    if (!isRecord(source)) {
      continue;
    }
    const nested = normalizePermissionProfileId(source.permission_profile);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function resolveGoalPermissionProfileId(storage: Storage, goal: GoalRecord | null) {
  const state = storage.getPermissionProfilesState();
  return resolveInheritedPermissionProfileId(state, goal?.metadata?.permission_profile);
}

export function resolvePlanPermissionProfileId(storage: Storage, plan: PlanRecord | null, goal?: GoalRecord | null) {
  const state = storage.getPermissionProfilesState();
  return resolveInheritedPermissionProfileId(
    state,
    plan?.metadata?.permission_profile,
    goal?.metadata?.permission_profile
  );
}

export function resolvePlanStepPermissionProfileId(
  storage: Storage,
  step: PlanStepRecord | null,
  plan?: PlanRecord | null,
  goal?: GoalRecord | null
) {
  const state = storage.getPermissionProfilesState();
  return resolveInheritedPermissionProfileId(
    state,
    step?.metadata?.permission_profile,
    isRecord(step?.input) ? step!.input.permission_profile : null,
    plan?.metadata?.permission_profile,
    goal?.metadata?.permission_profile
  );
}

function resolveTaskPlanContext(storage: Storage, task: TaskRecord) {
  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const dispatch = isRecord(metadata.plan_dispatch) ? metadata.plan_dispatch : {};
  const planId = readString(dispatch.plan_id);
  const stepId = readString(dispatch.step_id);
  const goalId = readString(dispatch.goal_id);
  const plan = planId ? storage.getPlanById(planId) : null;
  const goal = goalId ? storage.getGoalById(goalId) : plan?.goal_id ? storage.getGoalById(plan.goal_id) : null;
  const step = plan && stepId ? storage.listPlanSteps(plan.plan_id).find((entry) => entry.step_id === stepId) ?? null : null;
  return { plan, step, goal };
}

export function resolveTaskPermissionProfileId(storage: Storage, task: TaskRecord | null) {
  const state = storage.getPermissionProfilesState();
  if (!task) {
    return state.default_profile;
  }
  const context = resolveTaskPlanContext(storage, task);
  return resolveInheritedPermissionProfileId(
    state,
    task.metadata?.permission_profile,
    task.payload?.permission_profile,
    context.step?.metadata?.permission_profile,
    isRecord(context.step?.input) ? context.step!.input.permission_profile : null,
    context.plan?.metadata?.permission_profile,
    context.goal?.metadata?.permission_profile
  );
}

export function resolveSessionPermissionProfileId(storage: Storage, session: AgentSessionRecord | null) {
  const state = storage.getPermissionProfilesState();
  return resolveInheritedPermissionProfileId(
    state,
    session?.capabilities?.permission_profile,
    session?.metadata?.permission_profile
  );
}

export function resolvePermissionProfileChain(
  storage: Storage,
  params: {
    goal_id?: string | null;
    plan_id?: string | null;
    step_id?: string | null;
    task_id?: string | null;
    session_id?: string | null;
  }
) {
  const state = storage.getPermissionProfilesState();
  const goal = params.goal_id ? storage.getGoalById(params.goal_id) : null;
  const plan = params.plan_id ? storage.getPlanById(params.plan_id) : null;
  const step =
    plan && params.step_id ? storage.listPlanSteps(plan.plan_id).find((entry) => entry.step_id === params.step_id) ?? null : null;
  const task = params.task_id ? storage.getTaskById(params.task_id) : null;
  const session = params.session_id ? storage.getAgentSessionById(params.session_id) : null;
  const taskContext = task ? resolveTaskPlanContext(storage, task) : { plan: null, step: null, goal: null };
  const resolved = resolveInheritedPermissionProfileId(
    state,
    session?.metadata?.permission_profile,
    session?.capabilities?.permission_profile,
    task?.metadata?.permission_profile,
    task?.payload?.permission_profile,
    step?.metadata?.permission_profile,
    isRecord(step?.input) ? step!.input.permission_profile : null,
    taskContext.step?.metadata?.permission_profile,
    taskContext.plan?.metadata?.permission_profile,
    plan?.metadata?.permission_profile,
    taskContext.goal?.metadata?.permission_profile,
    goal?.metadata?.permission_profile
  );
  return {
    resolved_profile_id: resolved,
    state,
    chain: {
      session_id: params.session_id ?? null,
      session_declared: readDeclaredPermissionProfile(session?.metadata, session?.capabilities),
      task_id: params.task_id ?? null,
      task_declared: readDeclaredPermissionProfile(task?.metadata, task?.payload),
      step_id: params.step_id ?? taskContext.step?.step_id ?? null,
      step_declared: readDeclaredPermissionProfile(step?.metadata, step?.input, taskContext.step?.metadata, taskContext.step?.input),
      plan_id: params.plan_id ?? taskContext.plan?.plan_id ?? null,
      plan_declared: readDeclaredPermissionProfile(plan?.metadata, taskContext.plan?.metadata),
      goal_id: params.goal_id ?? taskContext.goal?.goal_id ?? null,
      goal_declared: readDeclaredPermissionProfile(goal?.metadata, taskContext.goal?.metadata),
      default_profile: state.default_profile,
    },
  };
}

export function taskPermissionProfileIsEligible(
  storage: Storage,
  session: AgentSessionRecord,
  task: TaskRecord
) {
  const state = storage.getPermissionProfilesState();
  const sessionProfileId = resolveSessionPermissionProfileId(storage, session);
  const taskProfileId = resolveTaskPermissionProfileId(storage, task);
  const enforcementEnabled = isFeatureFlagEnabled(storage, "control_plane.permission_profiles", {
    entity_id: task.task_id,
    agent_id: session.agent_id,
    tags: task.tags,
  });
  return {
    session_profile_id: sessionProfileId,
    task_profile_id: taskProfileId,
    allowed:
      !enforcementEnabled ||
      permissionProfileAllowsRequirement({
        current_profile_id: sessionProfileId,
        required_profile_id: taskProfileId,
        state,
      }),
  };
}

export function isFeatureFlagEnabled(
  storage: Storage,
  flagId: FeatureFlagId,
  context?: {
    entity_id?: string | null;
    agent_id?: string | null;
    thread_id?: string | null;
    tags?: string[];
  }
) {
  return evaluateFeatureFlag(storage.getFeatureFlagState(), flagId, context).enabled;
}

export function evaluateFeatureFlagForStorage(
  storage: Storage,
  flagId: FeatureFlagId,
  context?: {
    entity_id?: string | null;
    agent_id?: string | null;
    thread_id?: string | null;
    tags?: string[];
  }
) {
  return evaluateFeatureFlag(storage.getFeatureFlagState(), flagId, context);
}

export function buildBudgetUsageFromBudget(params: {
  budget?: unknown;
  metadata?: unknown;
  provider?: string | null;
  model_id?: string | null;
  notes?: string | null;
}): BudgetUsageRecord | null {
  const budget = isRecord(params.budget) ? params.budget : {};
  const metadata = isRecord(params.metadata) ? params.metadata : {};
  const projectedCost =
    readBudgetNumber(budget.projected_cost_usd) ??
    readBudgetNumber(budget.estimated_cost_usd) ??
    readBudgetNumber(budget.max_cost_usd);
  const projectedInputTokens = readBudgetInteger(budget.projected_input_tokens) ?? readBudgetInteger(budget.input_tokens);
  const projectedOutputTokens = readBudgetInteger(budget.projected_output_tokens) ?? readBudgetInteger(budget.output_tokens);
  const projectedTotalTokens =
    readBudgetInteger(budget.projected_total_tokens) ??
    readBudgetInteger(budget.token_budget) ??
    readBudgetInteger(budget.max_tokens);
  const explicit = extractBudgetUsage(budget, metadata);
  if (explicit) {
    const mergedTokensInput = explicit.tokens_input ?? projectedInputTokens;
    const mergedTokensOutput = explicit.tokens_output ?? projectedOutputTokens;
    return {
      ...explicit,
      provider: explicit.provider ?? params.provider ?? null,
      model_id: explicit.model_id ?? params.model_id ?? null,
      tokens_input: mergedTokensInput,
      tokens_output: mergedTokensOutput,
      tokens_total:
        explicit.tokens_total ??
        projectedTotalTokens ??
        (mergedTokensInput !== null || mergedTokensOutput !== null ? (mergedTokensInput ?? 0) + (mergedTokensOutput ?? 0) : null),
      projected_cost_usd: explicit.projected_cost_usd ?? projectedCost,
      notes: explicit.notes ?? params.notes ?? readString(budget.notes),
    };
  }
  if (
    projectedCost === null &&
    projectedInputTokens === null &&
    projectedOutputTokens === null &&
    projectedTotalTokens === null &&
    !params.provider &&
    !params.model_id
  ) {
    return null;
  }
  return {
    provider: params.provider ?? null,
    model_id: params.model_id ?? null,
    tokens_input: projectedInputTokens,
    tokens_output: projectedOutputTokens,
    tokens_total:
      projectedTotalTokens ?? (projectedInputTokens !== null || projectedOutputTokens !== null ? (projectedInputTokens ?? 0) + (projectedOutputTokens ?? 0) : null),
    projected_cost_usd: projectedCost,
    actual_cost_usd: null,
    currency: readString(budget.currency)?.toUpperCase() ?? "USD",
    notes: params.notes ?? readString(budget.notes),
    metadata: metadata,
  };
}

export function recordBudgetLedgerUsage(
  storage: Storage,
  params: {
    ledger_kind?: "projection" | "actual" | "adjustment";
    usage?: unknown;
    usage_sources?: unknown[];
    entity_type?: string | null;
    entity_id?: string | null;
    run_id?: string | null;
    task_id?: string | null;
    goal_id?: string | null;
    plan_id?: string | null;
    session_id?: string | null;
    provider?: string | null;
    model_id?: string | null;
    notes?: string | null;
    metadata?: Record<string, unknown>;
    source_client?: string | null;
    source_model?: string | null;
    source_agent?: string | null;
  }
) {
  if (!isFeatureFlagEnabled(storage, "control_plane.budget_ledger", { entity_id: params.entity_id ?? params.task_id ?? params.run_id ?? null })) {
    return null;
  }
  const usage = extractBudgetUsage(params.usage, ...(params.usage_sources ?? []));
  if (!usage) {
    return null;
  }
  const inferredKind =
    params.ledger_kind ??
    (usage.actual_cost_usd !== null ? "actual" : usage.projected_cost_usd !== null ? "projection" : "adjustment");
  return storage.appendBudgetLedgerEntry({
    ledger_kind: inferredKind,
    entity_type: params.entity_type ?? null,
    entity_id: params.entity_id ?? null,
    run_id: params.run_id ?? null,
    task_id: params.task_id ?? null,
    goal_id: params.goal_id ?? null,
    plan_id: params.plan_id ?? null,
    session_id: params.session_id ?? null,
    provider: usage.provider ?? params.provider ?? null,
    model_id: usage.model_id ?? params.model_id ?? null,
    tokens_input: usage.tokens_input,
    tokens_output: usage.tokens_output,
    tokens_total: usage.tokens_total,
    projected_cost_usd: usage.projected_cost_usd,
    actual_cost_usd: usage.actual_cost_usd,
    currency: usage.currency,
    notes: usage.notes ?? params.notes ?? null,
    metadata: {
      ...(params.metadata ?? {}),
      ...(usage.metadata ?? {}),
    },
    source_client: params.source_client ?? null,
    source_model: params.source_model ?? null,
    source_agent: params.source_agent ?? null,
  });
}
