import crypto from "node:crypto";
import { z } from "zod";
import { type GoalRecord, type PlanRecord, Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const goalRiskTierSchema = z.enum(["low", "medium", "high", "critical"]);
const autonomyModeSchema = z.enum([
  "observe",
  "recommend",
  "stage",
  "execute_bounded",
  "execute_destructive_with_approval",
]);

const workstreamSchema = z.object({
  stream_id: z.string().min(1).optional(),
  title: z.string().min(1),
  owner_role_id: z.string().min(1).optional(),
  executor_ref: z.string().min(1).optional(),
  step_kind: z.enum(["analysis", "mutation", "verification", "decision", "handoff"]).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  evidence_requirements: z.array(z.string().min(1)).optional(),
  rollback_notes: z.array(z.string().min(1)).optional(),
  task_metadata: recordSchema.optional(),
});

export const autonomyCommandBaseSchema = z.object({
  mutation: mutationSchema,
  objective: z.string().min(1),
  title: z.string().min(1).optional(),
  goal_id: z.string().min(1).max(200).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  risk_tier: goalRiskTierSchema.default("medium"),
  autonomy_mode: autonomyModeSchema.default("execute_bounded"),
  acceptance_criteria: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  assumptions: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: recordSchema.optional(),
  owner: recordSchema.optional(),
  budget: recordSchema.optional(),
  target_entity_type: z.string().min(1).optional(),
  target_entity_id: z.string().min(1).optional(),
  compile_objective: z.boolean().default(true),
  workstreams: z.array(workstreamSchema).optional(),
  selected_plan: z.boolean().default(true),
  ensure_bootstrap: z.boolean().default(true),
  autostart_ring_leader: z.boolean().optional(),
  bootstrap_run_immediately: z.boolean().optional(),
  start_goal_autorun_daemon: z.boolean().default(true),
  autorun_interval_seconds: z.number().int().min(5).max(3600).optional(),
  goal_scan_limit: z.number().int().min(1).max(100).optional(),
  hook_name: z.string().min(1).optional(),
  context_artifact_ids: z.array(z.string().min(1)).optional(),
  options: recordSchema.optional(),
  dispatch_limit: z.number().int().min(1).max(100).optional(),
  dry_run: z.boolean().optional(),
  max_passes: z.number().int().min(1).max(20).optional(),
  trichat_agent_ids: z.array(z.string().min(1)).max(50).optional(),
  trichat_max_rounds: z.number().int().min(1).max(10).optional(),
  trichat_min_success_agents: z.number().int().min(1).max(10).optional(),
  trichat_bridge_timeout_seconds: z.number().int().min(5).max(1800).optional(),
  trichat_bridge_dry_run: z.boolean().optional(),
  ...sourceSchema.shape,
});

export const autonomyCommandSchema = autonomyCommandBaseSchema
  .superRefine((value, ctx) => {
    if ((value.target_entity_type && !value.target_entity_id) || (!value.target_entity_type && value.target_entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_entity_type and target_entity_id must be provided together",
        path: ["target_entity_type"],
      });
    }
  });

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

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

function dedupeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, phase: string) {
  const safePhase = phase.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const digest = crypto
    .createHash("sha256")
    .update(`${base.idempotency_key}|${base.side_effect_fingerprint}|${safePhase}`)
    .digest("hex");
  return {
    idempotency_key: `autonomy-command-${safePhase}-${digest.slice(0, 24)}`,
    side_effect_fingerprint: `autonomy-command-${safePhase}-${digest.slice(24, 56)}`,
  };
}

function deriveTitle(objective: string) {
  const trimmed = objective.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 84) {
    return trimmed;
  }
  const shortened = trimmed.slice(0, 81).replace(/\s+\S*$/, "");
  return `${shortened || trimmed.slice(0, 81)}...`;
}

function defaultAcceptanceCriteria(objective: string) {
  return [
    `The objective "${objective.trim()}" is decomposed into bounded owner-assigned workstreams.`,
    "Execution produces concrete evidence, artifacts, or command output proving real progress.",
    "Verification either confirms completion or fails closed with explicit remaining gaps and rollback guidance.",
  ];
}

function defaultRollbackNotes() {
  return [
    "Keep each delegated change bounded and reversible.",
    "Fail closed when evidence is weak, missing, or contradicted by runtime state.",
  ];
}

function summarizeDaemonAction(status: Record<string, unknown> | null) {
  const running = readBoolean(status?.running);
  const config = isRecord(status?.config) ? status.config : {};
  const daemonGoalId = readString(config.goal_id);
  if (running !== true) {
    return "started_scan_all_goals";
  }
  if (daemonGoalId) {
    return "realigned_scan_all_goals";
  }
  return "already_scanning_all_goals";
}

function resolvePlanFromExecution(storage: Storage, goal: GoalRecord, execution: Record<string, unknown>, fallbackPlanId: string | null) {
  const explicitPlanId =
    fallbackPlanId ??
    (isRecord(execution.plan) ? readString(execution.plan.plan_id) : null) ??
    readString(execution.plan_id) ??
    goal.active_plan_id;
  return explicitPlanId ? storage.getPlanById(explicitPlanId) : null;
}

export async function autonomyCommand(
  storage: Storage,
  invokeTool: InvokeTool,
  input: z.infer<typeof autonomyCommandSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "autonomy.command",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const source = {
        source_client: input.source_client ?? "autonomy.command",
        source_model: input.source_model,
        source_agent: input.source_agent ?? "ring-leader",
      };
      const title = input.title?.trim() || deriveTitle(input.objective);
      const acceptanceCriteria = input.acceptance_criteria?.length
        ? dedupeStrings(input.acceptance_criteria)
        : defaultAcceptanceCriteria(input.objective);

      const bootstrapResult = (await invokeTool("autonomy.bootstrap", {
        action: input.ensure_bootstrap ? "ensure" : "status",
        mutation: input.ensure_bootstrap ? deriveMutation(input.mutation, "bootstrap") : undefined,
        autostart_ring_leader: input.autostart_ring_leader ?? true,
        run_immediately: input.bootstrap_run_immediately ?? false,
        seed_org_programs: input.ensure_bootstrap ? true : undefined,
        seed_benchmark_suite: input.ensure_bootstrap ? true : undefined,
        seed_eval_suite: input.ensure_bootstrap ? true : undefined,
        ...source,
      })) as Record<string, unknown>;

      const bootstrapStatus = isRecord(bootstrapResult.status) ? bootstrapResult.status : bootstrapResult;
      if (readBoolean(bootstrapStatus.self_start_ready) !== true) {
        const repairsNeeded = dedupeStrings(bootstrapStatus.repairs_needed);
        throw new Error(
          `autonomy.command requires a self-start-ready control plane before intake can proceed${
            repairsNeeded.length > 0 ? ` (repairs_needed=${repairsNeeded.join(",")})` : ""
          }.`
        );
      }

      const createdGoal = (await invokeTool("goal.create", {
        mutation: deriveMutation(input.mutation, "goal-create"),
        goal_id: input.goal_id,
        title,
        objective: input.objective,
        status: "active",
        priority: input.priority,
        risk_tier: input.risk_tier,
        autonomy_mode: input.autonomy_mode,
        target_entity_type: input.target_entity_type,
        target_entity_id: input.target_entity_id,
        acceptance_criteria: acceptanceCriteria,
        constraints: dedupeStrings(input.constraints),
        assumptions: dedupeStrings(input.assumptions),
        budget: input.budget,
        owner: input.owner,
        tags: [...new Set(["autonomy", "command", ...(input.tags ?? [])])],
        metadata: {
          intake_tool: "autonomy.command",
          intake_objective: input.objective,
          ...(input.metadata ?? {}),
        },
        ...source,
      })) as { goal: GoalRecord };

      const goalId = createdGoal.goal.goal_id;
      let compileResult: Record<string, unknown> | null = null;
      let compiledPlanId: string | null = null;

      if (input.compile_objective) {
        compileResult = (await invokeTool("task.compile", {
          mutation: deriveMutation(input.mutation, "task-compile"),
          goal_id: goalId,
          objective: input.objective,
          title,
          create_plan: true,
          selected: input.selected_plan,
          workstreams: input.workstreams,
          success_criteria: acceptanceCriteria,
          rollback: defaultRollbackNotes(),
          metadata: {
            intake_tool: "autonomy.command",
            ...(input.metadata ?? {}),
          },
          ...source,
        })) as Record<string, unknown>;
        compiledPlanId = isRecord(compileResult.plan) ? readString(compileResult.plan.plan_id) : null;
      }

      const execution = (await invokeTool("goal.execute", {
        mutation: deriveMutation(input.mutation, "goal-execute"),
        goal_id: goalId,
        plan_id: compiledPlanId ?? undefined,
        create_plan_if_missing: !input.compile_objective,
        pack_id: "agentic",
        hook_name: input.hook_name,
        context_artifact_ids: input.context_artifact_ids,
        options: input.options,
        title,
        selected: input.selected_plan,
        dispatch_limit: input.dispatch_limit,
        dry_run: input.dry_run,
        autorun: true,
        max_passes: input.max_passes,
        trichat_agent_ids: input.trichat_agent_ids,
        trichat_max_rounds: input.trichat_max_rounds,
        trichat_min_success_agents: input.trichat_min_success_agents,
        trichat_bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
        trichat_bridge_dry_run: input.trichat_bridge_dry_run,
        ...source,
      })) as Record<string, unknown>;

      const goalAfter = storage.getGoalById(goalId) ?? createdGoal.goal;
      const planAfter = resolvePlanFromExecution(storage, goalAfter, execution, compiledPlanId);

      const daemonStatus = (await invokeTool("goal.autorun_daemon", { action: "status" })) as Record<string, unknown>;
      let daemonResult: Record<string, unknown> = daemonStatus;
      let daemonAction = "status";

      if (input.start_goal_autorun_daemon && input.dry_run !== true) {
        const daemonConfig = isRecord(daemonStatus.config) ? daemonStatus.config : {};
        const daemonRunning = readBoolean(daemonStatus.running) === true;
        const daemonGoalId = readString(daemonConfig.goal_id);
        if (!daemonRunning || daemonGoalId) {
          daemonResult = (await invokeTool("goal.autorun_daemon", {
            action: "start",
            mutation: deriveMutation(input.mutation, "goal-autorun-daemon"),
            interval_seconds: input.autorun_interval_seconds,
            limit: input.goal_scan_limit,
            create_plan_if_missing: true,
            dispatch_limit: input.dispatch_limit,
            max_passes: input.max_passes,
            pack_id: "agentic",
            hook_name: input.hook_name,
            context_artifact_ids: input.context_artifact_ids,
            options: input.options,
            title,
            selected: input.selected_plan,
            trichat_agent_ids: input.trichat_agent_ids,
            trichat_max_rounds: input.trichat_max_rounds,
            trichat_min_success_agents: input.trichat_min_success_agents,
            trichat_bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
            trichat_bridge_dry_run: input.trichat_bridge_dry_run,
            run_immediately: false,
            ...source,
          })) as Record<string, unknown>;
          daemonAction = summarizeDaemonAction(daemonStatus);
        }
      }

      const ringLeaderStatus = (await invokeTool("trichat.autopilot", { action: "status" })) as Record<string, unknown>;
      const event = storage.appendRuntimeEvent({
        event_type: "autonomy.command",
        entity_type: "goal",
        entity_id: goalId,
        status: goalAfter.status,
        summary: `autonomy.command opened goal ${goalId} and dispatched it for autonomous execution.`,
        details: {
          goal_id: goalId,
          title,
          objective: input.objective,
          compiled_plan_id: compiledPlanId,
          compile_objective: input.compile_objective,
          execution_ok: readBoolean(execution.ok),
          goal_autorun_daemon_action: daemonAction,
          dry_run: input.dry_run ?? false,
        },
        ...source,
      });

      return {
        ok: true,
        objective: input.objective,
        title,
        goal: goalAfter,
        plan: planAfter,
        bootstrap: bootstrapResult,
        compile: compileResult,
        execution,
        goal_autorun_daemon: {
          action: daemonAction,
          status: daemonResult,
        },
        ring_leader: ringLeaderStatus,
        event,
        next_action:
          input.dry_run === true
            ? "Inspect the generated goal and plan, then rerun autonomy.command without dry_run to continue."
            : "Monitor the goal through the office dashboard, ring-leader status, or goal.get while autonomous execution continues.",
      };
    },
  });
}
