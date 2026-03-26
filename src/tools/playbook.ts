import { z } from "zod";
import { Storage, type PlanExecutorKind, type PlanStepKind } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

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

export const playbookListSchema = z.object({
  source_repo: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const playbookGetSchema = z.object({
  playbook_id: z.string().min(1),
});

export const playbookInstantiateSchema = z
  .object({
    mutation: mutationSchema,
    playbook_id: z.string().min(1),
    goal_id: z.string().min(1).max(200).optional(),
    plan_id: z.string().min(1).max(200).optional(),
    title: z.string().min(1),
    objective: z.string().min(1),
    goal_status: goalStatusSchema.default("active"),
    priority: z.number().int().min(0).max(100).optional(),
    risk_tier: goalRiskTierSchema.default("medium"),
    autonomy_mode: autonomyModeSchema.default("recommend"),
    target_entity_type: z.string().min(1).optional(),
    target_entity_id: z.string().min(1).optional(),
    acceptance_criteria: z.array(z.string().min(1)).optional(),
    constraints: z.array(z.string().min(1)).optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    selected_plan: z.boolean().optional(),
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

export const playbookRunSchema = z
  .object({
    mutation: mutationSchema,
    playbook_id: z.string().min(1),
    goal_id: z.string().min(1).max(200).optional(),
    plan_id: z.string().min(1).max(200).optional(),
    title: z.string().min(1),
    objective: z.string().min(1),
    goal_status: goalStatusSchema.default("active"),
    priority: z.number().int().min(0).max(100).optional(),
    risk_tier: goalRiskTierSchema.default("medium"),
    autonomy_mode: autonomyModeSchema.default("execute_bounded"),
    target_entity_type: z.string().min(1).optional(),
    target_entity_id: z.string().min(1).optional(),
    acceptance_criteria: z.array(z.string().min(1)).optional(),
    constraints: z.array(z.string().min(1)).optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    selected_plan: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    dispatch_limit: z.number().int().min(1).max(100).optional(),
    max_passes: z.number().int().min(1).max(20).optional(),
    trichat_agent_ids: z.array(z.string().min(1)).max(50).optional(),
    trichat_max_rounds: z.number().int().min(1).max(10).optional(),
    trichat_min_success_agents: z.number().int().min(1).max(10).optional(),
    trichat_bridge_timeout_seconds: z.number().int().min(5).max(1800).optional(),
    trichat_bridge_dry_run: z.boolean().optional(),
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

type PlaybookTemplateStep = {
  step_id: string;
  seq: number;
  title: string;
  step_kind: PlanStepKind;
  executor_kind?: PlanExecutorKind;
  tool_name?: string;
  input?: Record<string, unknown>;
  expected_artifact_types?: string[];
  acceptance_checks?: string[];
  depends_on?: string[];
  metadata?: Record<string, unknown>;
};

type PlaybookDefinition = {
  playbook_id: string;
  source_repo: string;
  title: string;
  category: string;
  summary: string;
  description: string;
  best_for: string[];
  tags: string[];
  default_acceptance_criteria: string[];
  steps: PlaybookTemplateStep[];
};

const PLAYBOOKS: readonly PlaybookDefinition[] = [
  {
    playbook_id: "gsd.map_codebase",
    source_repo: "gsd-build/get-shit-done",
    title: "GSD Codebase Map",
    category: "discovery",
    summary: "Map repository structure, conventions, integrations, and risks before implementation.",
    description:
      "Kernel-native adaptation of GSD's map-codebase/discovery flow. Use this before adding features to an unfamiliar codebase so downstream plans inherit real architecture context.",
    best_for: ["existing codebases", "brownfield features", "handoffs", "onboarding"],
    tags: ["gsd", "discovery", "codebase", "planning"],
    default_acceptance_criteria: [
      "Architecture, stack, integrations, and testing conventions are documented in durable plan state.",
      "Risks and verification gaps are surfaced before implementation begins.",
    ],
    steps: [
      {
        step_id: "inventory-repository",
        seq: 1,
        title: "Inventory repository structure and conventions for {{title}}",
        step_kind: "analysis",
        executor_kind: "worker",
        input: {
          objective:
            "Map the repository structure, technology stack, testing approach, and coding conventions relevant to {{objective}}.",
          payload: {
            focus: "codebase_inventory",
          },
          tags: ["playbook", "gsd", "discovery"],
        },
        expected_artifact_types: ["notes", "summary"],
      },
      {
        step_id: "surface-risks",
        seq: 2,
        title: "Surface architectural risks and integration hotspots",
        step_kind: "analysis",
        executor_kind: "worker",
        depends_on: ["inventory-repository"],
        input: {
          objective:
            "Identify risks, integration hotspots, missing tests, and verification gaps that could affect {{objective}}.",
          payload: {
            focus: "risks_and_verification",
          },
          tags: ["playbook", "gsd", "risk"],
        },
        expected_artifact_types: ["risks", "verification_plan"],
      },
      {
        step_id: "council-synthesis",
        seq: 3,
        title: "Synthesize discovery findings across the council",
        step_kind: "decision",
        executor_kind: "trichat",
        depends_on: ["surface-risks"],
        input: {
          prompt:
            "Synthesize the codebase map and risk findings for {{objective}}. Recommend execution lanes, likely blockers, and the safest first implementation slice.",
          expected_agents: ["codex", "cursor", "local-imprint"],
          min_agents: 2,
        },
        expected_artifact_types: ["decision"],
      },
    ],
  },
  {
    playbook_id: "gsd.phase_delivery",
    source_repo: "gsd-build/get-shit-done",
    title: "GSD Phase Delivery",
    category: "delivery",
    summary: "Run a phase-like delivery flow: discuss, research, plan, approve, execute, verify.",
    description:
      "Kernel-native adaptation of GSD's discuss/plan/execute/verify workflow. It creates a reusable durable plan that can be dispatched through workers, the council, and human gates.",
    best_for: ["feature delivery", "phase execution", "structured implementation"],
    tags: ["gsd", "delivery", "phase", "execution"],
    default_acceptance_criteria: [
      "Gray areas are surfaced before implementation.",
      "Implementation work is executed only after an explicit plan and approval gate.",
      "Verification is treated as its own execution stage.",
    ],
    steps: [
      {
        step_id: "discuss-gray-areas",
        seq: 1,
        title: "Discuss gray areas and tradeoffs for {{title}}",
        step_kind: "decision",
        executor_kind: "trichat",
        input: {
          prompt:
            "Surface gray areas, assumptions, and design tradeoffs for {{objective}}. Highlight decisions that should be locked before implementation.",
          expected_agents: ["codex", "cursor", "local-imprint"],
          min_agents: 2,
        },
        expected_artifact_types: ["decision", "assumptions"],
      },
      {
        step_id: "research-implementation",
        seq: 2,
        title: "Research implementation approaches",
        step_kind: "analysis",
        executor_kind: "worker",
        depends_on: ["discuss-gray-areas"],
        input: {
          objective: "Research implementation approaches, constraints, and dependencies for {{objective}}.",
          payload: {
            focus: "implementation_research",
          },
          tags: ["playbook", "gsd", "research"],
        },
        expected_artifact_types: ["research", "options"],
      },
      {
        step_id: "shape-execution-plan",
        seq: 3,
        title: "Shape the execution plan",
        step_kind: "decision",
        executor_kind: "worker",
        depends_on: ["research-implementation"],
        input: {
          objective:
            "Create an execution-ready task breakdown with dependencies, verification gates, and success criteria for {{objective}}.",
          payload: {
            focus: "task_breakdown",
          },
          tags: ["playbook", "gsd", "planning"],
        },
        expected_artifact_types: ["plan", "task_breakdown"],
      },
      {
        step_id: "approve-scope",
        seq: 4,
        title: "Approve the shaped execution scope",
        step_kind: "handoff",
        executor_kind: "human",
        depends_on: ["shape-execution-plan"],
        input: {
          approval_summary: "Approve the researched and shaped scope for {{objective}} before implementation begins.",
        },
      },
      {
        step_id: "execute-phase",
        seq: 5,
        title: "Execute the approved phase",
        step_kind: "mutation",
        executor_kind: "worker",
        depends_on: ["approve-scope"],
        input: {
          objective: "Implement the approved phase for {{objective}}.",
          payload: {
            focus: "implementation",
          },
          tags: ["playbook", "gsd", "execute"],
        },
        expected_artifact_types: ["code", "diff"],
      },
      {
        step_id: "verify-phase",
        seq: 6,
        title: "Verify the phase end-to-end",
        step_kind: "verification",
        executor_kind: "worker",
        depends_on: ["execute-phase"],
        input: {
          objective: "Verify behavior, wiring, tests, and stated quality gates for {{objective}}.",
          payload: {
            focus: "verification",
          },
          tags: ["playbook", "gsd", "verify"],
        },
        expected_artifact_types: ["verification_report"],
      },
    ],
  },
  {
    playbook_id: "gsd.debug_issue",
    source_repo: "gsd-build/get-shit-done",
    title: "GSD Debug Issue",
    category: "debugging",
    summary: "Structured debugging flow with evidence gathering, diagnosis, fix, and verification.",
    description:
      "Kernel-native adaptation of GSD's debugger flow. It treats debugging as a durable plan instead of a one-shot chat, preserving evidence and verification stages.",
    best_for: ["bug fixing", "production incidents", "regressions"],
    tags: ["gsd", "debug", "verification"],
    default_acceptance_criteria: [
      "Symptoms and reproduction evidence are captured before mutation.",
      "Fixes are followed by explicit verification.",
    ],
    steps: [
      {
        step_id: "capture-symptoms",
        seq: 1,
        title: "Capture symptoms and reproduction for {{title}}",
        step_kind: "analysis",
        executor_kind: "worker",
        input: {
          objective: "Capture symptoms, expected behavior, actual behavior, and reproduction details for {{objective}}.",
          tags: ["playbook", "gsd", "debug"],
        },
        expected_artifact_types: ["debug_report"],
      },
      {
        step_id: "diagnose-root-cause",
        seq: 2,
        title: "Diagnose the root cause",
        step_kind: "decision",
        executor_kind: "trichat",
        depends_on: ["capture-symptoms"],
        input: {
          prompt:
            "Analyze the captured symptoms for {{objective}}. Identify likely root causes, confidence levels, and the safest fix path.",
          expected_agents: ["codex", "cursor", "local-imprint"],
          min_agents: 2,
        },
        expected_artifact_types: ["decision", "root_cause"],
      },
      {
        step_id: "implement-fix",
        seq: 3,
        title: "Implement the bounded fix",
        step_kind: "mutation",
        executor_kind: "worker",
        depends_on: ["diagnose-root-cause"],
        input: {
          objective: "Implement the bounded fix path selected for {{objective}}.",
          tags: ["playbook", "gsd", "fix"],
        },
        expected_artifact_types: ["code", "diff"],
      },
      {
        step_id: "verify-fix",
        seq: 4,
        title: "Verify the fix and guard against regressions",
        step_kind: "verification",
        executor_kind: "worker",
        depends_on: ["implement-fix"],
        input: {
          objective: "Verify the fix for {{objective}} and check for behavioral regressions.",
          tags: ["playbook", "gsd", "verify"],
        },
        expected_artifact_types: ["verification_report"],
      },
    ],
  },
  {
    playbook_id: "autoresearch.optimize_loop",
    source_repo: "karpathy/autoresearch",
    title: "Autoresearch Optimize Loop",
    category: "optimization",
    summary: "A bounded baseline -> propose -> mutate -> measure -> accept/reject experiment loop.",
    description:
      "Kernel-native adaptation of autoresearch's accept/discard loop. It is generalized away from model training so it can be used for code, prompts, configs, and verification-driven optimization on the local machine.",
    best_for: ["performance tuning", "prompt optimization", "harden-and-measure loops", "benchmark-driven changes"],
    tags: ["autoresearch", "optimization", "experiment", "benchmark"],
    default_acceptance_criteria: [
      "A baseline measurement exists before trying a variant.",
      "A variant is accepted only with evidence or simplification gains.",
    ],
    steps: [
      {
        step_id: "establish-baseline",
        seq: 1,
        title: "Establish the baseline for {{title}}",
        step_kind: "analysis",
        executor_kind: "worker",
        input: {
          objective:
            "Run the baseline benchmark, verification loop, or measurement protocol for {{objective}} and record the current score.",
          payload: {
            focus: "baseline",
          },
          tags: ["playbook", "autoresearch", "baseline"],
        },
        expected_artifact_types: ["baseline_report"],
      },
      {
        step_id: "generate-hypotheses",
        seq: 2,
        title: "Generate bounded experiment hypotheses",
        step_kind: "decision",
        executor_kind: "trichat",
        depends_on: ["establish-baseline"],
        input: {
          prompt:
            "Given the current baseline for {{objective}}, propose 2-3 bounded experiment ideas. Prefer high-signal, reversible changes with clear measurement criteria.",
          expected_agents: ["codex", "cursor", "local-imprint"],
          min_agents: 2,
        },
        expected_artifact_types: ["decision", "hypotheses"],
      },
      {
        step_id: "implement-variant",
        seq: 3,
        title: "Implement the best bounded variant",
        step_kind: "mutation",
        executor_kind: "worker",
        depends_on: ["generate-hypotheses"],
        input: {
          objective: "Implement the highest-confidence bounded variant for {{objective}}.",
          payload: {
            focus: "variant",
          },
          tags: ["playbook", "autoresearch", "variant"],
        },
        expected_artifact_types: ["code", "diff"],
      },
      {
        step_id: "measure-variant",
        seq: 4,
        title: "Measure the variant against the baseline",
        step_kind: "verification",
        executor_kind: "worker",
        depends_on: ["implement-variant"],
        input: {
          objective:
            "Run the same measurement protocol used for the baseline and compare the results for {{objective}}.",
          payload: {
            focus: "comparison",
          },
          tags: ["playbook", "autoresearch", "measure"],
        },
        expected_artifact_types: ["comparison_report"],
      },
      {
        step_id: "accept-or-reject",
        seq: 5,
        title: "Accept or reject the experimental variant",
        step_kind: "handoff",
        executor_kind: "human",
        depends_on: ["measure-variant"],
        input: {
          approval_summary:
            "Accept the variant for {{objective}} only if the evidence beats the baseline or clearly simplifies the system at equal quality.",
        },
      },
    ],
  },
] as const;

function replaceTokens(value: string, context: Record<string, string>) {
  return value.replace(/\{\{(\w+)\}\}/g, (_match, key) => context[key] ?? "");
}

function materializeValue<T>(value: T, context: Record<string, string>): T {
  if (typeof value === "string") {
    return replaceTokens(value, context) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeValue(entry, context)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      materializeValue(entry, context),
    ]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function getPlaybookDefinition(playbookId: string) {
  return PLAYBOOKS.find((playbook) => playbook.playbook_id === playbookId) ?? null;
}

function buildPlaybookDerivedMutation(
  mutation: { idempotency_key: string; side_effect_fingerprint: string },
  phase: string
) {
  return {
    idempotency_key: `${mutation.idempotency_key}:playbook:${phase}`,
    side_effect_fingerprint: `${mutation.side_effect_fingerprint}:playbook:${phase}`,
  };
}

function instantiatePlaybook(
  storage: Storage,
  input: z.infer<typeof playbookInstantiateSchema> | z.infer<typeof playbookRunSchema>,
  options?: {
    workflow_autorun_enabled?: boolean;
    workflow_autorun_max_passes?: number;
  }
) {
  const playbook = getPlaybookDefinition(input.playbook_id);
  if (!playbook) {
    throw new Error(`Unknown playbook: ${input.playbook_id}`);
  }

  const context = {
    title: input.title,
    objective: input.objective,
    repo_root: process.cwd(),
  };
  const goalTags = Array.from(new Set([...(input.tags ?? []), ...playbook.tags]));
  const acceptanceCriteria = Array.from(
    new Set([...(input.acceptance_criteria ?? []), ...playbook.default_acceptance_criteria])
  );

  const goalResult = storage.createGoal({
    goal_id: input.goal_id,
    title: input.title,
    objective: input.objective,
    status: input.goal_status,
    priority: input.priority,
    risk_tier: input.risk_tier,
    autonomy_mode: input.autonomy_mode,
    target_entity_type: input.target_entity_type,
    target_entity_id: input.target_entity_id,
    acceptance_criteria: acceptanceCriteria,
    constraints: input.constraints,
    assumptions: input.assumptions,
    tags: goalTags,
    metadata: {
      ...(input.metadata ?? {}),
      playbook: {
        playbook_id: playbook.playbook_id,
        source_repo: playbook.source_repo,
        category: playbook.category,
      },
    },
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });

  const createdPlan = storage.createPlan({
    plan_id: input.plan_id,
    goal_id: goalResult.goal.goal_id,
    title: `${playbook.title}: ${input.title}`,
    summary: `${playbook.summary} Objective: ${input.objective}`,
    status: "candidate",
    planner_kind: "core",
    selected: input.selected_plan ?? true,
    assumptions: input.assumptions,
    success_criteria: acceptanceCriteria,
    metadata: {
      playbook_id: playbook.playbook_id,
      source_repo: playbook.source_repo,
      category: playbook.category,
      instantiated_at: new Date().toISOString(),
      ...(options?.workflow_autorun_enabled === true
        ? {
            workflow_autorun_enabled: true,
            workflow_autorun_max_passes: options.workflow_autorun_max_passes ?? 4,
            workflow_autorun_source: "playbook.run",
          }
        : {}),
    },
    steps: playbook.steps.map((step) => ({
      step_id: step.step_id,
      seq: step.seq,
      title: materializeValue(step.title, context),
      step_kind: step.step_kind,
      executor_kind: step.executor_kind,
      tool_name: step.tool_name,
      input: materializeValue(step.input ?? {}, context),
      expected_artifact_types: step.expected_artifact_types,
      acceptance_checks: step.acceptance_checks,
      depends_on: step.depends_on,
      metadata: materializeValue(
        {
          ...(step.metadata ?? {}),
          playbook_id: playbook.playbook_id,
          source_repo: playbook.source_repo,
        },
        context
      ),
    })),
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });

  return {
    created: true,
    playbook,
    goal: goalResult.goal,
    plan: createdPlan.plan,
    steps: createdPlan.steps,
  };
}

export function playbookList(_storage: Storage, input: z.infer<typeof playbookListSchema>) {
  const sourceRepo = input.source_repo?.trim();
  const category = input.category?.trim();
  let playbooks = [...PLAYBOOKS];
  if (sourceRepo) {
    playbooks = playbooks.filter((playbook) => playbook.source_repo === sourceRepo);
  }
  if (category) {
    playbooks = playbooks.filter((playbook) => playbook.category === category);
  }
  const limit = input.limit ?? 50;
  if (playbooks.length > limit) {
    playbooks = playbooks.slice(0, limit);
  }
  return {
    source_repo_filter: sourceRepo ?? null,
    category_filter: category ?? null,
    count: playbooks.length,
    playbooks,
  };
}

export function playbookGet(_storage: Storage, input: z.infer<typeof playbookGetSchema>) {
  const playbook = getPlaybookDefinition(input.playbook_id);
  if (!playbook) {
    return {
      found: false,
      playbook_id: input.playbook_id,
    };
  }
  return {
    found: true,
    playbook,
  };
}

export async function playbookInstantiate(storage: Storage, input: z.infer<typeof playbookInstantiateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "playbook.instantiate",
    mutation: input.mutation,
    payload: input,
    execute: () => instantiatePlaybook(storage, input),
  });
}

export async function playbookRun(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof playbookRunSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "playbook.run",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const instantiated = instantiatePlaybook(storage, input, {
        workflow_autorun_enabled: true,
        workflow_autorun_max_passes: input.max_passes ?? 4,
      });
      const execution = (await invokeTool("goal.execute", {
        mutation: buildPlaybookDerivedMutation(input.mutation, "execute"),
        goal_id: instantiated.goal.goal_id,
        plan_id: instantiated.plan.plan_id,
        create_plan_if_missing: false,
        dry_run: input.dry_run,
        dispatch_limit: input.dispatch_limit,
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

      const planAfter = storage.getPlanById(instantiated.plan.plan_id) ?? instantiated.plan;
      const goalAfter = storage.getGoalById(instantiated.goal.goal_id) ?? instantiated.goal;
      return {
        ok: true,
        playbook: instantiated.playbook,
        goal: goalAfter,
        plan: planAfter,
        steps: storage.listPlanSteps(planAfter.plan_id),
        execution,
      };
    },
  });
}
