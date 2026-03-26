import { z } from "zod";
import { type GoalRecord, type PlanRecord, type PlanStepRecord, Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { evaluatePlanStepReadiness } from "./plan.js";

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

function resolveDefaultPlannerHookName(goal: GoalRecord) {
  const preferredHookName = readString(goal.metadata.preferred_planner_hook_name);
  if (preferredHookName) {
    return preferredHookName;
  }
  const methodologySource = readString(goal.metadata.methodology_source);
  if (methodologySource === "karpathy/autoresearch") {
    return "optimization_loop";
  }
  const normalizedTags = new Set(goal.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  if (normalizedTags.has("autoresearch") || normalizedTags.has("optimization") || normalizedTags.has("experiment")) {
    return "optimization_loop";
  }
  return "delivery_path";
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
  const blockedHumanSteps = steps
    .filter((step) => {
      if (step.status === "blocked") {
        if (step.executor_kind === "human") {
          return true;
        }
        const gateType = readString(step.metadata.dispatch_gate_type);
        return gateType === "human" || step.metadata.human_approval_required === true;
      }
      return false;
    })
    .map((step) => ({
      step_id: step.step_id,
      title: step.title,
      status: step.status,
    }));
  const readyStepIds = readiness.filter((entry) => entry.ready).map((entry) => entry.step_id);
  const runningStepIds = steps.filter((step) => step.status === "running").map((step) => step.step_id);
  const failedStepIds = steps.filter((step) => step.status === "failed").map((step) => step.step_id);

  let nextAction = "Plan is idle.";
  if (plan.status === "completed") {
    nextAction = "Plan completed; inspect artifacts and mark the goal complete when appropriate.";
  } else if (failedStepIds.length > 0) {
    nextAction = "Inspect failed steps and use plan.resume after fixing the blocking issue.";
  } else if (blockedHumanSteps.length > 0) {
    nextAction = "Approve the blocked human gate with plan.approve, then call goal.execute or plan.resume again.";
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
    blocked_human_steps: blockedHumanSteps,
    ready_step_ids: readyStepIds,
    running_step_ids: runningStepIds,
    failed_step_ids: failedStepIds,
    next_action: nextAction,
  };
}

function listGoalAutorunCandidates(storage: Storage, input: z.infer<typeof goalAutorunSchema>) {
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
          };
        }

        const generated = await invokeTool("pack.plan.generate", {
          mutation: buildGoalExecuteDerivedMutation(input.mutation, "plan-generate"),
          pack_id: input.pack_id,
          hook_name: input.hook_name ?? resolveDefaultPlannerHookName(goal),
          target: {
            entity_type: "goal",
            entity_id: goal.goal_id,
          },
          goal_id: goal.goal_id,
          context_artifact_ids: input.context_artifact_ids,
          options: input.options,
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
        planResolution = {
          resolution: "generated",
          plan: storage.getPlanById(String(generated.plan.plan_id)) ?? null,
        };
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
          dispatch_mode: input.autorun ? "autorun" : "dispatch",
          dry_run: input.dry_run ?? false,
          execution_summary: executionSummary,
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
        dispatch_mode: input.autorun ? "autorun" : "dispatch",
        execution: executionResult,
        execution_summary: executionSummary,
        final_plan: finalPlan,
        final_steps: finalSteps,
        final_readiness: finalReadiness,
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
    execute: async () => {
      const candidates = listGoalAutorunCandidates(storage, input);
      const results: Array<Record<string, unknown>> = [];
      let executedCount = 0;
      let skippedCount = 0;

      for (const goal of candidates) {
        const planResolution = resolveGoalExecutionPlan(
          storage,
          {
            ...input,
            mutation: input.mutation,
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
            mutation: buildGoalExecuteDerivedMutation(input.mutation, `autorun:${goal.goal_id}`),
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
        const blockedHumanStep = summary.blocked_human_steps[0] ?? null;
        const hasRunningTriChat = steps.some((step) => step.status === "running" && step.executor_kind === "trichat");

        if (blockedHumanStep) {
          skippedCount += 1;
          results.push({
            goal_id: goal.goal_id,
            plan_id: plan.plan_id,
            action: "skipped",
            reason: "human_gate",
            blocked_step: blockedHumanStep,
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
          mutation: buildGoalExecuteDerivedMutation(input.mutation, `autorun:${goal.goal_id}`),
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
    },
  });
}
