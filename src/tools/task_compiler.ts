import crypto from "node:crypto";
import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { getEffectiveOrgProgram } from "./org_program.js";
import { matchDomainSpecialists } from "./specialist_catalog.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const compiledWorkstreamSchema = z.object({
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

export const taskCompileSchema = z.object({
  mutation: mutationSchema,
  goal_id: z.string().min(1),
  objective: z.string().min(1),
  title: z.string().min(1).optional(),
  create_plan: z.boolean().default(true),
  selected: z.boolean().optional(),
  workstreams: z.array(compiledWorkstreamSchema).optional(),
  success_criteria: z.array(z.string().min(1)).optional(),
  rollback: z.array(z.string().min(1)).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

type CompiledStream = {
  stream_id: string;
  title: string;
  owner_role_id: string;
  executor_ref: string;
  step_kind: "analysis" | "mutation" | "verification" | "decision" | "handoff";
  depends_on: string[];
  evidence_requirements: string[];
  rollback_notes: string[];
  task_metadata: Record<string, unknown>;
};

function deriveDefaultStreams(objective: string): CompiledStream[] {
  const normalized = objective.toLowerCase();
  const streams: CompiledStream[] = [];
  const implementationNeeded = /\b(build|code|implement|fix|integrat|refactor|script|tool)\b/.test(normalized);
  const researchNeeded = /\b(research|compare|analy|investigat|evaluate|option|benchmark)\b/.test(normalized);
  const verificationNeeded = true;

  if (researchNeeded) {
    streams.push({
      stream_id: "research",
      title: "Bound the unknowns and frame viable options",
      owner_role_id: "research-director",
      executor_ref: "research-director",
      step_kind: "analysis",
      depends_on: [],
      evidence_requirements: ["Decision-ready comparison with assumptions and gaps."],
      rollback_notes: ["Do not treat weak evidence as settled truth."],
      task_metadata: {
        preferred_host_tags: ["local"],
      },
    });
  }

  if (implementationNeeded || !researchNeeded) {
    streams.push({
      stream_id: "implementation",
      title: "Execute the primary implementation slice",
      owner_role_id: "implementation-director",
      executor_ref: "implementation-director",
      step_kind: "mutation",
      depends_on: researchNeeded ? ["research"] : [],
      evidence_requirements: ["Concrete diff, command log, or artifact proving the change."],
      rollback_notes: ["Keep the change bounded and reversible."],
      task_metadata: {
        preferred_host_tags: ["local"],
      },
    });
  }

  if (verificationNeeded) {
    streams.push({
      stream_id: "verification",
      title: "Verify behavior, evidence, and release confidence",
      owner_role_id: "verification-director",
      executor_ref: "verification-director",
      step_kind: "verification",
      depends_on: streams.filter((stream) => stream.stream_id !== "verification").map((stream) => stream.stream_id),
      evidence_requirements: ["Validation output proving the objective is satisfied."],
      rollback_notes: ["Fail closed when evidence is weak or regressions are plausible."],
      task_metadata: {
        preferred_host_tags: ["local"],
      },
    });
  }

  return streams;
}

function deriveSpecialistStreams(storage: Storage, objective: string): CompiledStream[] {
  return matchDomainSpecialists(storage, objective, 6, 0.3)
    .map((match) => compiledWorkstreamSchema.safeParse(match.recommended_workstream))
    .filter((result): result is { success: true; data: z.infer<typeof compiledWorkstreamSchema> } => result.success)
    .map((result, index) => ({
      stream_id: result.data.stream_id?.trim() || `specialist-${index + 1}`,
      title: result.data.title.trim(),
      owner_role_id: result.data.owner_role_id?.trim() || "implementation-director",
      executor_ref: result.data.executor_ref?.trim() || result.data.owner_role_id?.trim() || "implementation-director",
      step_kind: result.data.step_kind ?? "mutation",
      depends_on: [...new Set((result.data.depends_on ?? []).map((entry) => entry.trim()).filter(Boolean))],
      evidence_requirements: [
        ...new Set((result.data.evidence_requirements ?? []).map((entry) => entry.trim()).filter(Boolean)),
      ],
      rollback_notes: [...new Set((result.data.rollback_notes ?? []).map((entry) => entry.trim()).filter(Boolean))],
      task_metadata: result.data.task_metadata ?? {},
    }));
}

function mergeStreams(primary: CompiledStream[], secondary: CompiledStream[]) {
  const merged = new Map<string, CompiledStream>();
  for (const stream of [...primary, ...secondary]) {
    const key = stream.stream_id.trim() || stream.title.trim().toLowerCase();
    merged.set(key, stream);
  }
  return [...merged.values()];
}

function materializeStreams(storage: Storage, input: z.infer<typeof taskCompileSchema>): CompiledStream[] {
  const provided = (input.workstreams ?? []).map((stream, index) => ({
    stream_id: stream.stream_id?.trim() || `stream-${index + 1}`,
    title: stream.title.trim(),
    owner_role_id: stream.owner_role_id?.trim() || "implementation-director",
    executor_ref: stream.executor_ref?.trim() || stream.owner_role_id?.trim() || "implementation-director",
    step_kind: stream.step_kind ?? "mutation",
    depends_on: [...new Set((stream.depends_on ?? []).map((entry) => entry.trim()).filter(Boolean))],
    evidence_requirements: [...new Set((stream.evidence_requirements ?? []).map((entry) => entry.trim()).filter(Boolean))],
    rollback_notes: [...new Set((stream.rollback_notes ?? []).map((entry) => entry.trim()).filter(Boolean))],
    task_metadata: stream.task_metadata ?? {},
  }));
  const specialistStreams = deriveSpecialistStreams(storage, input.objective);
  return provided.length > 0
    ? mergeStreams(provided, specialistStreams)
    : mergeStreams(deriveDefaultStreams(input.objective), specialistStreams);
}

export async function taskCompile(storage: Storage, input: z.infer<typeof taskCompileSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.compile",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const goal = storage.getGoalById(input.goal_id);
      if (!goal) {
        throw new Error(`Goal not found: ${input.goal_id}`);
      }

      const now = new Date().toISOString();
      const streams = materializeStreams(storage, input);
      const analysisStepId = `compile-analysis-${crypto.randomUUID()}`;
      const streamStepIds = new Map(streams.map((stream) => [stream.stream_id, `${stream.stream_id}-${crypto.randomUUID()}`]));
      const compiledSteps = [
        {
          step_id: analysisStepId,
          seq: 1,
          title: "Frame the objective and open execution lanes",
          step_kind: "analysis" as const,
          status: "pending" as const,
          executor_kind: "trichat" as const,
          executor_ref: "ring-leader",
          input: {
            objective: input.objective,
          },
          expected_artifact_types: ["compile.brief"],
          acceptance_checks: ["Objective is sliced into bounded owner-assigned workstreams."],
          retry_policy: {},
          timeout_seconds: 900,
          metadata: {
            compiler: "task.compile",
            compiled_at: now,
          },
          depends_on: [],
        },
        ...streams.map((stream, index) => {
          const orgProgram = getEffectiveOrgProgram(storage, stream.owner_role_id);
          const resolvedDependsOn = stream.depends_on
            .map((dependencyId) => streamStepIds.get(dependencyId))
            .filter((dependencyId): dependencyId is string => Boolean(dependencyId));
          return {
            step_id: streamStepIds.get(stream.stream_id)!,
            seq: index + 2,
            title: stream.title,
            step_kind: stream.step_kind,
            status: "pending" as const,
            executor_kind: "worker" as const,
            executor_ref: stream.executor_ref,
            input: {
              objective: input.objective,
              stream_id: stream.stream_id,
              evidence_requirements: stream.evidence_requirements,
              rollback_notes: stream.rollback_notes,
            },
            expected_artifact_types: ["evidence.bundle"],
            acceptance_checks: stream.evidence_requirements,
            retry_policy: {},
            timeout_seconds: 3600,
            metadata: {
              compiler: "task.compile",
              owner_role_id: stream.owner_role_id,
              org_program_version_id: orgProgram?.version.version_id ?? null,
              org_program_summary: orgProgram?.version.summary ?? null,
              task_execution: stream.task_metadata,
            },
            depends_on: [analysisStepId, ...resolvedDependsOn],
          };
        }),
      ];

      const verificationStepId = `compile-verification-${crypto.randomUUID()}`;
      compiledSteps.push({
        step_id: verificationStepId,
        seq: compiledSteps.length + 1,
        title: "Merge evidence and decide whether the objective is truly complete",
        step_kind: "decision",
        status: "pending",
        executor_kind: "worker",
        executor_ref: "verification-director",
        input: {
          objective: input.objective,
          stream_id: "verification-finalize",
          evidence_requirements: input.success_criteria ?? ["Evidence bundle satisfies the objective."],
          rollback_notes: input.rollback ?? ["Keep each workstream bounded and reversible."],
        },
        expected_artifact_types: ["verification.report"],
        acceptance_checks: input.success_criteria ?? ["Evidence bundle satisfies the objective."],
        retry_policy: {},
        timeout_seconds: 1800,
        metadata: {
          compiler: "task.compile",
          owner_role_id: "verification-director",
          org_program_version_id: null,
          org_program_summary: null,
          task_execution: {},
        },
        depends_on: compiledSteps.filter((step) => step.step_id !== analysisStepId).map((step) => step.step_id),
      });

      const planTitle = input.title?.trim() || goal.title;
      const summary = `Compiled objective into ${streams.length} bounded workstreams with explicit verification and owner contracts.`;
      const created = input.create_plan
        ? storage.createPlan({
            goal_id: input.goal_id,
            title: planTitle,
            summary,
            status: input.selected ? "selected" : "candidate",
            planner_kind: "core",
            planner_id: "task.compile",
            selected: input.selected,
            confidence: 0.8,
            success_criteria: input.success_criteria ?? ["Objective is completed with evidence."],
            rollback: input.rollback ?? ["Keep each workstream bounded and reversible."],
            metadata: {
              compiler: "task.compile",
              objective: input.objective,
              ...(input.metadata ?? {}),
            },
            steps: compiledSteps,
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          })
        : null;

      return {
        goal_id: input.goal_id,
        objective: input.objective,
        summary,
        streams,
        plan: created?.plan ?? null,
        steps: created?.steps ?? compiledSteps,
        created_plan: created?.created ?? false,
      };
    },
  });
}
