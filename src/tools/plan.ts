import { z } from "zod";
import { Storage, type PlanStepRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const planStatusSchema = z.enum([
  "draft",
  "candidate",
  "selected",
  "in_progress",
  "completed",
  "invalidated",
  "archived",
]);

const planPlannerKindSchema = z.enum(["core", "pack", "human", "trichat"]);

const planStepStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
  "invalidated",
]);

const planStepKindSchema = z.enum(["analysis", "mutation", "verification", "decision", "handoff"]);

const executorKindSchema = z.enum(["tool", "task", "worker", "human", "trichat"]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const planStepCreateSchema = z.object({
  step_id: z.string().min(1).max(200).optional(),
  seq: z.number().int().min(1),
  title: z.string().min(1),
  step_kind: planStepKindSchema,
  status: planStepStatusSchema.optional(),
  executor_kind: executorKindSchema.optional(),
  executor_ref: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  input: z.record(z.unknown()).optional(),
  expected_artifact_types: z.array(z.string().min(1)).optional(),
  acceptance_checks: z.array(z.string().min(1)).optional(),
  retry_policy: z.record(z.unknown()).optional(),
  timeout_seconds: z.number().int().min(1).max(86400).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const planCreateSchema = z
  .object({
    mutation: mutationSchema,
    plan_id: z.string().min(1).max(200).optional(),
    goal_id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    status: planStatusSchema.default("candidate"),
    planner_kind: planPlannerKindSchema.default("core"),
    planner_id: z.string().min(1).optional(),
    selected: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    success_criteria: z.array(z.string().min(1)).optional(),
    rollback: z.array(z.string().min(1)).optional(),
    budget: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    steps: z.array(planStepCreateSchema).min(1),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    const explicitStepIds = new Set<string>();
    for (const step of value.steps) {
      if (!step.step_id) {
        continue;
      }
      if (explicitStepIds.has(step.step_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step_id: ${step.step_id}`,
          path: ["steps"],
        });
      }
      explicitStepIds.add(step.step_id);
    }
    for (const step of value.steps) {
      for (const dependencyId of step.depends_on ?? []) {
        if (!explicitStepIds.has(dependencyId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `depends_on references step_id not explicitly defined in this request: ${dependencyId}`,
            path: ["steps"],
          });
        }
      }
    }
  });

export const planGetSchema = z.object({
  plan_id: z.string().min(1),
});

export const planListSchema = z
  .object({
    goal_id: z.string().min(1).optional(),
    status: planStatusSchema.optional(),
    selected_only: z.boolean().optional(),
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

export const planSelectSchema = z.object({
  mutation: mutationSchema,
  goal_id: z.string().min(1),
  plan_id: z.string().min(1),
  summary: z.string().min(1),
  deselect_others: z.boolean().default(true),
  ...sourceSchema.shape,
});

export const planUpdateSchema = z
  .object({
    mutation: mutationSchema,
    plan_id: z.string().min(1),
    title: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    status: planStatusSchema.optional(),
    selected: z.boolean().optional(),
    deselect_other_plans: z.boolean().optional(),
    planner_id: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    success_criteria: z.array(z.string().min(1)).optional(),
    rollback: z.array(z.string().min(1)).optional(),
    budget: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    const hasPatchField =
      value.title !== undefined ||
      value.summary !== undefined ||
      value.status !== undefined ||
      value.selected !== undefined ||
      value.deselect_other_plans !== undefined ||
      value.planner_id !== undefined ||
      value.confidence !== undefined ||
      value.assumptions !== undefined ||
      value.success_criteria !== undefined ||
      value.rollback !== undefined ||
      value.budget !== undefined ||
      value.metadata !== undefined;
    if (!hasPatchField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one plan field must be provided",
        path: ["plan_id"],
      });
    }
  });

export const planStepUpdateSchema = z.object({
  mutation: mutationSchema,
  plan_id: z.string().min(1),
  step_id: z.string().min(1),
  status: planStepStatusSchema.optional(),
  summary: z.string().optional(),
  executor_kind: executorKindSchema.optional(),
  executor_ref: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  produced_artifact_ids: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const planStepReadySchema = z.object({
  plan_id: z.string().min(1),
});

export const planDispatchSchema = z.object({
  mutation: mutationSchema,
  plan_id: z.string().min(1),
  step_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  allow_non_ready: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  ...sourceSchema.shape,
});

export const planApproveSchema = z.object({
  mutation: mutationSchema,
  plan_id: z.string().min(1),
  step_id: z.string().min(1),
  approved_by: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const planResumeSchema = z.object({
  mutation: mutationSchema,
  plan_id: z.string().min(1),
  step_id: z.string().min(1).optional(),
  reset_step: z.boolean().optional(),
  dispatch_after: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  summary: z.string().min(1).optional(),
  ...sourceSchema.shape,
});

type PlanStepReadinessRecord = {
  step_id: string;
  seq: number;
  title: string;
  status: PlanStepRecord["status"];
  depends_on: string[];
  ready: boolean;
  blocked_by: Array<{
    step_id: string;
    title: string;
    status: PlanStepRecord["status"];
  }>;
  gate_reason: string | null;
};

function getStepGateReason(step: PlanStepRecord): string | null {
  const metadata = step.metadata ?? {};
  if (typeof metadata.dispatch_gate_type === "string" && metadata.dispatch_gate_type.trim()) {
    return metadata.dispatch_gate_type.trim();
  }
  if (metadata.human_approval_required === true) {
    return "human_approval_required";
  }
  return null;
}

export function evaluatePlanStepReadiness(steps: PlanStepRecord[]): PlanStepReadinessRecord[] {
  const stepById = new Map(steps.map((step) => [step.step_id, step]));
  return steps.map((step) => {
    const blockedBy = step.depends_on
      .map((dependencyId) => stepById.get(dependencyId))
      .filter((dependency) => dependency && dependency.status !== "completed")
      .map((dependency) => ({
        step_id: dependency!.step_id,
        title: dependency!.title,
        status: dependency!.status,
      }));
    const gateReason = getStepGateReason(step);
    const readyCandidate = step.status === "pending" || step.status === "blocked" || step.status === "ready";
    return {
      step_id: step.step_id,
      seq: step.seq,
      title: step.title,
      status: step.status,
      depends_on: step.depends_on,
      ready: readyCandidate && blockedBy.length === 0 && !gateReason,
      blocked_by: blockedBy,
      gate_reason: gateReason,
    };
  });
}

export async function planCreate(storage: Storage, input: z.infer<typeof planCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.create",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.createPlan({
        plan_id: input.plan_id,
        goal_id: input.goal_id,
        title: input.title,
        summary: input.summary,
        status: input.status,
        planner_kind: input.planner_kind,
        planner_id: input.planner_id,
        selected: input.selected,
        confidence: input.confidence,
        assumptions: input.assumptions,
        success_criteria: input.success_criteria,
        rollback: input.rollback,
        budget: input.budget,
        metadata: input.metadata,
        steps: input.steps,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export function planGet(storage: Storage, input: z.infer<typeof planGetSchema>) {
  const plan = storage.getPlanById(input.plan_id);
  if (!plan) {
    return {
      found: false,
      plan_id: input.plan_id,
    };
  }
  const steps = storage.listPlanSteps(input.plan_id);
  const edges = steps.flatMap((step) =>
    step.depends_on.map((fromStepId) => ({
      from_step_id: fromStepId,
      to_step_id: step.step_id,
      relation: "depends_on",
    }))
  );
  return {
    found: true,
    plan,
    step_count: steps.length,
    edge_count: edges.length,
    steps,
    edges,
  };
}

export function planList(storage: Storage, input: z.infer<typeof planListSchema>) {
  const limit = input.limit ?? 100;
  let plans = input.goal_id
    ? storage.listPlans({
        goal_id: input.goal_id,
        status: input.status,
        selected_only: input.selected_only,
        limit,
      })
    : storage.listPlans({
        status: input.status,
        selected_only: input.selected_only,
        limit: input.target_entity_type ? Math.max(limit * 3, 100) : limit,
      });

  if (input.target_entity_type) {
    const matchingGoalIds = new Set(
      storage
        .listGoals({
          target_entity_type: input.target_entity_type,
          target_entity_id: input.target_entity_id,
          limit: Math.max(limit * 3, 100),
        })
        .map((goal) => goal.goal_id)
    );
    plans = plans.filter((plan) => matchingGoalIds.has(plan.goal_id));
  }

  if (plans.length > limit) {
    plans = plans.slice(0, limit);
  }

  return {
    goal_id_filter: input.goal_id ?? null,
    status_filter: input.status ?? null,
    selected_only_filter: input.selected_only ?? false,
    target_entity_type_filter: input.target_entity_type ?? null,
    target_entity_id_filter: input.target_entity_id ?? null,
    count: plans.length,
    plans,
  };
}

export async function planUpdate(storage: Storage, input: z.infer<typeof planUpdateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.update",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.updatePlan({
        plan_id: input.plan_id,
        title: input.title,
        summary: input.summary,
        status: input.status,
        selected: input.selected,
        deselect_other_plans: input.deselect_other_plans,
        planner_id: input.planner_id,
        confidence: input.confidence,
        assumptions: input.assumptions,
        success_criteria: input.success_criteria,
        rollback: input.rollback,
        budget: input.budget,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export async function planSelect(storage: Storage, input: z.infer<typeof planSelectSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.select",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const plan = storage.getPlanById(input.plan_id);
      if (!plan) {
        throw new Error(`Plan not found: ${input.plan_id}`);
      }
      if (plan.goal_id !== input.goal_id) {
        throw new Error(`Plan ${input.plan_id} does not belong to goal ${input.goal_id}`);
      }
      return storage.updatePlan({
        plan_id: input.plan_id,
        selected: true,
        deselect_other_plans: input.deselect_others,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        metadata: {
          last_selection_summary: input.summary,
        },
      });
    },
  });
}

export async function planStepUpdate(storage: Storage, input: z.infer<typeof planStepUpdateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.step_update",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.updatePlanStep({
        plan_id: input.plan_id,
        step_id: input.step_id,
        status: input.status,
        summary: input.summary,
        executor_kind: input.executor_kind,
        executor_ref: input.executor_ref,
        task_id: input.task_id,
        run_id: input.run_id,
        produced_artifact_ids: input.produced_artifact_ids,
        metadata: input.metadata,
      }),
  });
}

export async function planApprove(storage: Storage, input: z.infer<typeof planApproveSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.approve",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const plan = storage.getPlanById(input.plan_id);
      if (!plan) {
        throw new Error(`Plan not found: ${input.plan_id}`);
      }
      const step = storage.listPlanSteps(input.plan_id).find((candidate) => candidate.step_id === input.step_id);
      if (!step) {
        throw new Error(`Plan step not found: ${input.step_id}`);
      }
      const gateReason = getStepGateReason(step);
      const requiresHumanApproval =
        step.executor_kind === "human" || gateReason === "human" || gateReason === "human_approval_required";
      if (!requiresHumanApproval) {
        throw new Error(`Plan step ${input.step_id} is not waiting on human approval`);
      }

      const approvedAt = new Date().toISOString();
      const approvedBy =
        input.approved_by?.trim() || input.source_agent?.trim() || input.source_client?.trim() || "human";
      const approvalSummary = input.summary?.trim() || `Approved step ${step.title}`;
      const updated = storage.updatePlanStep({
        plan_id: input.plan_id,
        step_id: input.step_id,
        status: "completed",
        summary: approvalSummary,
        metadata: {
          human_approval_required: false,
          dispatch_gate_type: null,
          approval: {
            approved_at: approvedAt,
            approved_by: approvedBy,
            summary: approvalSummary,
          },
          ...(input.metadata ?? {}),
        },
      });
      const readiness = evaluatePlanStepReadiness(storage.listPlanSteps(input.plan_id));
      return {
        approved: true,
        plan: updated.plan,
        step: updated.step,
        readiness,
      };
    },
  });
}

export function planStepReady(storage: Storage, input: z.infer<typeof planStepReadySchema>) {
  const plan = storage.getPlanById(input.plan_id);
  if (!plan) {
    return {
      found: false,
      plan_id: input.plan_id,
    };
  }
  const steps = storage.listPlanSteps(input.plan_id);
  const readiness = evaluatePlanStepReadiness(steps);

  return {
    found: true,
    plan_id: input.plan_id,
    ready_count: readiness.filter((step) => step.ready).length,
    blocked_count: readiness.filter((step) => !step.ready && step.blocked_by.length > 0).length,
    readiness,
  };
}
