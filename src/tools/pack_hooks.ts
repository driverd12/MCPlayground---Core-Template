import { z } from "zod";
import { Storage } from "../storage.js";
import {
  type DomainPackPlannerHook,
  type DomainPackVerifierHook,
  type PackHookTarget,
  type PackPlannerHookResult,
  type PackVerifierHookResult,
} from "../domain-packs/types.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const entityRefSchema = z.object({
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
});

const recordSchema = z.record(z.unknown());
const packHookKindSchema = z.enum(["planner", "verifier"]);
const planStatusSchema = z.enum(["draft", "candidate", "selected", "in_progress", "completed", "invalidated", "archived"]);

export type RegisteredPlannerHook = DomainPackPlannerHook & {
  pack_id: string;
  hook_kind: "planner";
  hook_id: string;
};

export type RegisteredVerifierHook = DomainPackVerifierHook & {
  pack_id: string;
  hook_kind: "verifier";
  hook_id: string;
};

export type PackHookRegistry = {
  planners: RegisteredPlannerHook[];
  verifiers: RegisteredVerifierHook[];
};

export const packHooksListSchema = z.object({
  pack_id: z.string().min(1).optional(),
  hook_kind: packHookKindSchema.optional(),
  target_type: z.string().min(1).optional(),
});

export const packPlanGenerateSchema = z.object({
  mutation: mutationSchema,
  pack_id: z.string().min(1).optional(),
  hook_name: z.string().min(1).optional(),
  target: entityRefSchema,
  goal_id: z.string().min(1).optional(),
  context_artifact_ids: z.array(z.string().min(1)).optional(),
  options: recordSchema.optional(),
  plan_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1).optional(),
  selected: z.boolean().optional(),
  status: planStatusSchema.optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const goalPlanGenerateSchema = z.object({
  mutation: mutationSchema,
  goal_id: z.string().min(1),
  pack_id: z.string().min(1).optional(),
  hook_name: z.string().min(1).optional(),
  context_artifact_ids: z.array(z.string().min(1)).optional(),
  options: recordSchema.optional(),
  plan_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1).optional(),
  selected: z.boolean().optional(),
  status: planStatusSchema.optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const packVerifyRunSchema = z.object({
  mutation: mutationSchema,
  pack_id: z.string().min(1).optional(),
  hook_name: z.string().min(1).optional(),
  target: entityRefSchema,
  goal_id: z.string().min(1).optional(),
  plan_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  artifact_ids: z.array(z.string().min(1)).optional(),
  expectations: recordSchema.optional(),
  ...sourceSchema.shape,
});

function matchesTargetType(targetType: string, hookTargetTypes: string[]) {
  return hookTargetTypes.includes(targetType) || hookTargetTypes.includes("*");
}

function hookDescriptor(hook: RegisteredPlannerHook | RegisteredVerifierHook) {
  return {
    hook_id: hook.hook_id,
    pack_id: hook.pack_id,
    hook_kind: hook.hook_kind,
    hook_name: hook.hook_name,
    title: hook.title,
    description: hook.description ?? null,
    target_types: [...hook.target_types],
  };
}

function listResolvedHooks(
  hooks: Array<RegisteredPlannerHook | RegisteredVerifierHook>,
  filters: { pack_id?: string; hook_kind?: "planner" | "verifier"; target_type?: string }
) {
  return hooks.filter((hook) => {
    if (filters.pack_id && hook.pack_id !== filters.pack_id) {
      return false;
    }
    if (filters.hook_kind && hook.hook_kind !== filters.hook_kind) {
      return false;
    }
    if (filters.target_type && !matchesTargetType(filters.target_type, hook.target_types)) {
      return false;
    }
    return true;
  });
}

function resolvePlannerHook(registry: PackHookRegistry, input: { pack_id?: string; hook_name?: string; target_type: string }) {
  return resolveHook(registry.planners, {
    pack_id: input.pack_id,
    hook_name: input.hook_name,
    target_type: input.target_type,
    hook_kind: "planner",
  });
}

function resolveVerifierHook(registry: PackHookRegistry, input: { pack_id?: string; hook_name?: string; target_type: string }) {
  return resolveHook(registry.verifiers, {
    pack_id: input.pack_id,
    hook_name: input.hook_name,
    target_type: input.target_type,
    hook_kind: "verifier",
  });
}

function resolveHook<T extends RegisteredPlannerHook | RegisteredVerifierHook>(
  hooks: T[],
  input: { pack_id?: string; hook_name?: string; target_type: string; hook_kind: "planner" | "verifier" }
): T {
  const filtered = hooks.filter((hook) => {
    if (input.pack_id && hook.pack_id !== input.pack_id) {
      return false;
    }
    if (input.hook_name && hook.hook_name !== input.hook_name) {
      return false;
    }
    return matchesTargetType(input.target_type, hook.target_types);
  });

  if (filtered.length === 0) {
    throw new Error(
      `No ${input.hook_kind} hook matches target ${input.target_type}${input.pack_id ? ` in pack ${input.pack_id}` : ""}${input.hook_name ? ` with name ${input.hook_name}` : ""}`
    );
  }

  const exactTargetMatches = filtered.filter((hook) => hook.target_types.includes(input.target_type));
  if (exactTargetMatches.length === 1) {
    return exactTargetMatches[0];
  }
  if (filtered.length === 1) {
    return filtered[0];
  }

  const candidates = filtered.map((hook) => hook.hook_id).sort();
  throw new Error(
    `Ambiguous ${input.hook_kind} hook resolution for target ${input.target_type}; candidates: ${candidates.join(", ")}`
  );
}

function ensureGoalId(storage: Storage, goalId: string | undefined, target: PackHookTarget) {
  const resolvedGoalId = goalId?.trim() || (target.entity_type === "goal" ? target.entity_id : "");
  if (!resolvedGoalId) {
    throw new Error("goal_id is required unless the planner target entity_type is goal");
  }
  const goal = storage.getGoalById(resolvedGoalId);
  if (!goal) {
    throw new Error(`Goal not found: ${resolvedGoalId}`);
  }
  return goal;
}

function slugifyToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizePlannerSteps(result: PackPlannerHookResult) {
  return result.steps.map((step, index) => ({
    step_id: step.step_id?.trim() || `${slugifyToken(step.title) || "step"}-${index + 1}`,
    seq: index + 1,
    title: step.title,
    step_kind: step.step_kind,
    executor_kind: step.executor_kind,
    executor_ref: step.executor_ref,
    tool_name: step.tool_name,
    input: step.input ?? {},
    depends_on: step.depends_on ?? [],
    expected_artifact_types: step.expected_artifact_types ?? [],
    acceptance_checks: step.acceptance_checks ?? [],
    timeout_seconds: step.timeout_seconds,
    metadata: step.metadata ?? {},
  }));
}

function recordVerifierArtifact(
  storage: Storage,
  params: {
    pack_id: string;
    hook_name: string;
    target: PackHookTarget;
    goal_id?: string;
    plan_id?: string;
    step_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    artifact: {
      artifact_type: string;
      content_text?: string;
      content_json?: Record<string, unknown>;
      uri?: string;
      trust_tier?: "raw" | "derived" | "verified" | "policy-backed" | "deprecated";
      metadata?: Record<string, unknown>;
    };
  }
) {
  const recorded = storage.recordArtifact({
    artifact_type: params.artifact.artifact_type,
    goal_id: params.goal_id,
    plan_id: params.plan_id,
    step_id: params.step_id,
    pack_id: params.pack_id,
    producer_kind: "verifier",
    producer_id: `${params.pack_id}.${params.hook_name}`,
    content_text: params.artifact.content_text,
    content_json: params.artifact.content_json,
    uri: params.artifact.uri,
    trust_tier: params.artifact.trust_tier,
    metadata: {
      hook_name: params.hook_name,
      target_type: params.target.entity_type,
      target_id: params.target.entity_id,
      ...(params.artifact.metadata ?? {}),
    },
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent,
  });

  const targetLink = storage.linkArtifact({
    src_artifact_id: recorded.artifact.artifact_id,
    dst_entity_type: params.target.entity_type,
    dst_entity_id: params.target.entity_id,
    relation: "attached_to",
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent,
  });

  storage.appendRuntimeEvent({
    event_type: "artifact.recorded",
    entity_type: "artifact",
    entity_id: recorded.artifact.artifact_id,
    status: recorded.artifact.status,
    summary: `artifact ${recorded.artifact.artifact_type} recorded`,
    details: {
      artifact_type: recorded.artifact.artifact_type,
      goal_id: recorded.artifact.goal_id,
      plan_id: recorded.artifact.plan_id,
      step_id: recorded.artifact.step_id,
      pack_id: recorded.artifact.pack_id,
      links_created: 1,
      target_type: params.target.entity_type,
      target_id: params.target.entity_id,
    },
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent,
  });

  return {
    artifact: recorded.artifact,
    link: targetLink.link,
  };
}

export function listPackHooks(registry: PackHookRegistry, input: z.infer<typeof packHooksListSchema>) {
  const hooks = listResolvedHooks([...registry.planners, ...registry.verifiers], {
    pack_id: input.pack_id,
    hook_kind: input.hook_kind,
    target_type: input.target_type,
  })
    .map((hook) => hookDescriptor(hook))
    .sort((left, right) => left.hook_id.localeCompare(right.hook_id));

  return {
    count: hooks.length,
    pack_id_filter: input.pack_id ?? null,
    hook_kind_filter: input.hook_kind ?? null,
    target_type_filter: input.target_type ?? null,
    hooks,
  };
}

async function executePackPlanGenerate(
  storage: Storage,
  registry: PackHookRegistry,
  input: {
    mutation: { idempotency_key: string; side_effect_fingerprint: string };
    pack_id?: string;
    hook_name?: string;
    target: PackHookTarget;
    goal_id?: string;
    options?: Record<string, unknown>;
    context_artifact_ids?: string[];
    plan_id?: string;
    title?: string;
    selected?: boolean;
    status?: z.infer<typeof planStatusSchema>;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  },
  toolName: string
) {
  return runIdempotentMutation({
    storage,
    tool_name: toolName,
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const target: PackHookTarget = {
        entity_type: input.target.entity_type,
        entity_id: input.target.entity_id,
        goal_id: input.goal_id,
        artifact_ids: input.context_artifact_ids ?? [],
      };
      const goal = ensureGoalId(storage, input.goal_id, target);
      const hook = resolvePlannerHook(registry, {
        pack_id: input.pack_id,
        hook_name: input.hook_name,
        target_type: target.entity_type,
      });

      const started = storage.createPackHookRun({
        pack_id: hook.pack_id,
        hook_kind: "planner",
        hook_name: hook.hook_name,
        target_type: target.entity_type,
        target_id: target.entity_id,
        goal_id: goal.goal_id,
        status: "running",
        input: {
          target,
          options: input.options ?? {},
          context_artifact_ids: input.context_artifact_ids ?? [],
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      try {
        const plannerOutput = await hook.plan({
          storage,
          target,
          options: input.options ?? {},
        });

        const createdPlan = storage.createPlan({
          plan_id: input.plan_id,
          goal_id: goal.goal_id,
          title: input.title?.trim() || `${hook.title}: ${target.entity_type} ${target.entity_id}`,
          summary: plannerOutput.summary,
          status: input.status,
          planner_kind: "pack",
          planner_id: hook.hook_id,
          selected: input.selected ?? true,
          confidence: plannerOutput.confidence,
          assumptions: plannerOutput.assumptions,
          success_criteria: plannerOutput.success_criteria,
          rollback: plannerOutput.rollback,
          metadata: {
            planner_hook: {
              hook_id: hook.hook_id,
              pack_id: hook.pack_id,
              hook_name: hook.hook_name,
              target_type: target.entity_type,
              target_id: target.entity_id,
            },
            ...(plannerOutput.metadata ?? {}),
            ...(input.metadata ?? {}),
          },
          steps: normalizePlannerSteps(plannerOutput),
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });

        const completed = storage.updatePackHookRun({
          hook_run_id: started.hook_run.hook_run_id,
          status: "completed",
          summary: plannerOutput.summary,
          score: plannerOutput.confidence ?? null,
          output: {
            hook_id: hook.hook_id,
            created: createdPlan.created,
            plan_id: createdPlan.plan.plan_id,
            step_ids: createdPlan.steps.map((step) => step.step_id),
            confidence: plannerOutput.confidence ?? null,
            metadata: plannerOutput.metadata ?? {},
          },
        });

        return {
          ok: true,
          hook: hookDescriptor(hook),
          hook_run: completed.hook_run,
          created: createdPlan.created,
          plan: createdPlan.plan,
          steps: createdPlan.steps,
          planner_output: plannerOutput,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storage.updatePackHookRun({
          hook_run_id: started.hook_run.hook_run_id,
          status: "failed",
          summary: `Planner hook ${hook.hook_id} failed.`,
          error_text: message,
        });
        throw error;
      }
    },
  });
}

export async function packPlanGenerate(storage: Storage, registry: PackHookRegistry, input: z.infer<typeof packPlanGenerateSchema>) {
  return executePackPlanGenerate(storage, registry, input, "pack.plan.generate");
}

export async function goalPlanGenerate(storage: Storage, registry: PackHookRegistry, input: z.infer<typeof goalPlanGenerateSchema>) {
  const goal = storage.getGoalById(input.goal_id);
  if (!goal) {
    throw new Error(`Goal not found: ${input.goal_id}`);
  }
  if (!goal.target_entity_type || !goal.target_entity_id) {
    throw new Error(`Goal ${input.goal_id} does not have a target entity for pack planning`);
  }
  return executePackPlanGenerate(
    storage,
    registry,
    {
      ...input,
      target: {
        entity_type: goal.target_entity_type,
        entity_id: goal.target_entity_id,
      },
      goal_id: goal.goal_id,
    },
    "goal.plan_generate"
  );
}

export async function packVerifyRun(storage: Storage, registry: PackHookRegistry, input: z.infer<typeof packVerifyRunSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "pack.verify.run",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const target: PackHookTarget = {
        entity_type: input.target.entity_type,
        entity_id: input.target.entity_id,
        goal_id: input.goal_id,
        artifact_ids: input.artifact_ids ?? [],
      };
      const hook = resolveVerifierHook(registry, {
        pack_id: input.pack_id,
        hook_name: input.hook_name,
        target_type: target.entity_type,
      });

      const started = storage.createPackHookRun({
        pack_id: hook.pack_id,
        hook_kind: "verifier",
        hook_name: hook.hook_name,
        target_type: target.entity_type,
        target_id: target.entity_id,
        goal_id: input.goal_id,
        plan_id: input.plan_id,
        step_id: input.step_id,
        status: "running",
        input: {
          target,
          artifact_ids: input.artifact_ids ?? [],
          expectations: input.expectations ?? {},
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      try {
        const verification = await hook.verify({
          storage,
          target,
          artifact_ids: input.artifact_ids ?? [],
          expectations: input.expectations ?? {},
        });

        const recordedArtifacts = [
          recordVerifierArtifact(storage, {
            pack_id: hook.pack_id,
            hook_name: hook.hook_name,
            target,
            goal_id: input.goal_id,
            plan_id: input.plan_id,
            step_id: input.step_id,
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
            artifact: {
              artifact_type: "verifier_result",
              trust_tier: verification.pass ? "verified" : "derived",
              content_json: {
                pass: verification.pass,
                score: verification.score ?? null,
                checks: verification.checks ?? [],
                metadata: verification.metadata ?? {},
              },
              metadata: {
                summary: verification.summary,
              },
            },
          }),
          ...((verification.produced_artifacts ?? []).map((artifact) =>
            recordVerifierArtifact(storage, {
              pack_id: hook.pack_id,
              hook_name: hook.hook_name,
              target,
              goal_id: input.goal_id,
              plan_id: input.plan_id,
              step_id: input.step_id,
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
              artifact,
            })
          )),
        ];

        const artifactIds = recordedArtifacts.map((entry) => entry.artifact.artifact_id);
        const completed = storage.updatePackHookRun({
          hook_run_id: started.hook_run.hook_run_id,
          status: "completed",
          summary: verification.summary,
          score: verification.score ?? (verification.pass ? 1 : 0),
          output: {
            pass: verification.pass,
            score: verification.score ?? null,
            checks: verification.checks ?? [],
            artifact_ids: artifactIds,
            metadata: verification.metadata ?? {},
          },
        });

        return {
          ok: true,
          hook: hookDescriptor(hook),
          hook_run: completed.hook_run,
          verification,
          artifacts: recordedArtifacts.map((entry) => entry.artifact),
          artifact_ids: artifactIds,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storage.updatePackHookRun({
          hook_run_id: started.hook_run.hook_run_id,
          status: "failed",
          summary: `Verifier hook ${hook.hook_id} failed.`,
          error_text: message,
        });
        throw error;
      }
    },
  });
}
