import crypto from "node:crypto";
import { z } from "zod";
import {
  Storage,
  type OrgProgramRoleRecord,
  type OrgProgramVersionRecord,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import {
  deriveOrgProgramSignals,
  loadOrgPrograms,
  upsertVersion,
} from "./org_program.js";
import { compileObjectivePreview } from "./task_compiler.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const optimizerFocusSchema = z.enum([
  "bounded_execution",
  "explicit_evidence",
  "rollback_ready",
  "local_first",
  "parallel_delegation",
  "specialist_routing",
  "fail_closed",
  "verification_first",
]);

const optimizerActionSchema = z.enum(["status", "propose_variant", "step"]);

export const optimizerSchema = z
  .object({
    action: optimizerActionSchema.default("status"),
    mutation: mutationSchema.optional(),
    role_id: z.string().min(1).optional(),
    version_id: z.string().min(1).optional(),
    focus_areas: z.array(optimizerFocusSchema).max(8).optional(),
    objectives: z.array(z.string().min(1)).min(1).max(8).optional(),
    promote_if_better: z.boolean().optional(),
    min_improvement: z.number().min(0).max(100).optional(),
    experiment_id: z.string().min(1).optional(),
    metadata: recordSchema.optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for optimizer writes",
        path: ["mutation"],
      });
    }
    if ((value.action === "propose_variant" || value.action === "step") && !value.role_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "role_id is required",
        path: ["role_id"],
      });
    }
    if (value.action === "step" && (!value.objectives || value.objectives.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "objectives are required for optimizer.step",
        path: ["objectives"],
      });
    }
  });

type OptimizerFocus = z.infer<typeof optimizerFocusSchema>;

const FOCUS_MUTATIONS: Record<
  OptimizerFocus,
  { doctrine: string[]; delegation_contract: string[]; evaluation_standard: string[] }
> = {
  bounded_execution: {
    doctrine: ["Decompose work into the smallest safe bounded packet and refuse broad overlapping ownership."],
    delegation_contract: ["Assign exactly one owner per slice and keep delegations non-overlapping."],
    evaluation_standard: ["Fail if the plan creates broad ambiguous work packets or shared ownership."],
  },
  explicit_evidence: {
    doctrine: ["Require concrete, reproducible evidence for every claimed result."],
    delegation_contract: ["Ask delegates to return artifacts, command output, or observable proof instead of summaries alone."],
    evaluation_standard: ["Score work down when evidence is vague, missing, or not reproducible."],
  },
  rollback_ready: {
    doctrine: ["Prefer reversible changes and keep rollback paths explicit before merge."],
    delegation_contract: ["Include rollback notes whenever a task can mutate code, config, or system state."],
    evaluation_standard: ["Reject plans that cannot be reversed cheaply when verification fails."],
  },
  local_first: {
    doctrine: ["Prefer local execution and local specialists before remote/provider escalation."],
    delegation_contract: ["Use remote execution only when local capacity, models, or tools are insufficient."],
    evaluation_standard: ["Prefer solutions that preserve local continuity and reduce unnecessary cloud dependence."],
  },
  parallel_delegation: {
    doctrine: ["Batch independent bounded slices in parallel when that reduces latency without increasing coordination risk."],
    delegation_contract: ["Emit delegation batches only when each item has one owner and no overlapping write scope."],
    evaluation_standard: ["Down-rank plans that serialize obviously independent work or parallelize overlapping work unsafely."],
  },
  specialist_routing: {
    doctrine: ["Route domain-specific work to the narrowest viable specialist or leaf SME."],
    delegation_contract: ["Escalate out-of-domain work back up the hierarchy instead of improvising beyond the lane."],
    evaluation_standard: ["Reject plans that ignore existing SMEs when the domain match is clear."],
  },
  fail_closed: {
    doctrine: ["Stop or escalate when confidence is weak instead of forcing unsafe progress."],
    delegation_contract: ["Return uncertainty explicitly and escalate to the supervising agent when the lane is exceeded."],
    evaluation_standard: ["Prefer honest blocked states over fabricated certainty or speculative completion."],
  },
  verification_first: {
    doctrine: ["Define acceptance and verification criteria before merge, handoff, or promotion."],
    delegation_contract: ["State what will prove completion before executing expensive work."],
    evaluation_standard: ["Reject outputs that lack explicit verification gates or measurable completion checks."],
  },
};

function dedupeFocuses(values: OptimizerFocus[] | undefined) {
  const raw = values ?? ["bounded_execution", "explicit_evidence", "verification_first", "fail_closed"];
  return [...new Set(raw)];
}

function appendUniqueLines(base: string, additions: string[]) {
  const lines = base
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const addition of additions) {
    if (!lines.some((line) => line.toLowerCase() === addition.toLowerCase())) {
      lines.push(addition);
    }
  }
  return lines.join("\n");
}

function ensureRole(state: ReturnType<typeof loadOrgPrograms>, roleId: string) {
  const role = state.roles.find((entry) => entry.role_id === roleId);
  if (!role) {
    throw new Error(`Unknown org role: ${roleId}`);
  }
  return role;
}

function getActiveVersion(role: OrgProgramRoleRecord) {
  return (
    role.versions.find((entry) => entry.version_id === role.active_version_id) ??
    role.versions.find((entry) => entry.status === "active") ??
    role.versions[role.versions.length - 1] ??
    null
  );
}

function mutateRoleVersion(
  role: OrgProgramRoleRecord,
  baseVersion: OrgProgramVersionRecord,
  focusAreas: OptimizerFocus[]
): OrgProgramVersionRecord {
  let doctrine = baseVersion.doctrine;
  let delegationContract = baseVersion.delegation_contract;
  let evaluationStandard = baseVersion.evaluation_standard;
  for (const focus of focusAreas) {
    const patch = FOCUS_MUTATIONS[focus];
    doctrine = appendUniqueLines(doctrine, patch.doctrine);
    delegationContract = appendUniqueLines(delegationContract, patch.delegation_contract);
    evaluationStandard = appendUniqueLines(evaluationStandard, patch.evaluation_standard);
  }
  const createdAt = new Date().toISOString();
  return {
    version_id: `org-opt-${crypto.randomUUID()}`,
    created_at: createdAt,
    summary: `${role.title} optimized for ${focusAreas.join(", ")}`,
    doctrine,
    delegation_contract: delegationContract,
    evaluation_standard: evaluationStandard,
    status: "candidate",
    metadata: {
      optimizer: {
        parent_version_id: baseVersion.version_id,
        focus_areas: focusAreas,
        strategy: "bounded-doctrine-mutation",
        generated_at: createdAt,
      },
    },
  };
}

type PlanScorecard = {
  total_score: number;
  breakdown: Record<string, number>;
  reasons: string[];
};

function readBoolean(value: unknown) {
  return value === true;
}

function readTaskExecution(step: Record<string, unknown>) {
  const metadata = step.metadata && typeof step.metadata === "object" ? (step.metadata as Record<string, unknown>) : {};
  const taskExecution =
    metadata.task_execution && typeof metadata.task_execution === "object"
      ? (metadata.task_execution as Record<string, unknown>)
      : {};
  const signals =
    metadata.org_program_signals && typeof metadata.org_program_signals === "object"
      ? (metadata.org_program_signals as Record<string, unknown>)
      : {};
  return { metadata, taskExecution, signals };
}

function scoreCompiledPreview(params: {
  preview: ReturnType<typeof compileObjectivePreview>;
  role_id: string;
  version_id: string;
  focus_areas: OptimizerFocus[];
}): PlanScorecard {
  const roleSteps = params.preview.steps.filter((step) => {
    const metadata = step.metadata && typeof step.metadata === "object" ? (step.metadata as Record<string, unknown>) : {};
    return String(metadata.owner_role_id ?? "") === params.role_id;
  });
  const nonAnalysisSteps = params.preview.steps.filter((step) => step.step_kind !== "analysis");
  const verificationStep = params.preview.steps.find((step) => step.step_kind === "decision");
  const safeRatio = (value: number, total: number) => (total <= 0 ? 1 : value / total);
  const ownershipRatio = safeRatio(
    roleSteps.filter((step) => String(step.executor_ref ?? "").trim().length > 0).length,
    roleSteps.length
  );
  const evidenceRatio = safeRatio(
    roleSteps.filter((step) => Array.isArray(step.acceptance_checks) && step.acceptance_checks.length > 0).length,
    roleSteps.length
  );
  const rollbackRatio = safeRatio(
    roleSteps.filter((step) => Array.isArray((step.input as Record<string, unknown>).rollback_notes) && ((step.input as Record<string, unknown>).rollback_notes as unknown[]).length > 0).length,
    roleSteps.length
  );
  const orgBindingRatio = safeRatio(
    roleSteps.filter((step) => {
      const metadata = step.metadata && typeof step.metadata === "object" ? (step.metadata as Record<string, unknown>) : {};
      return String(metadata.org_program_version_id ?? "") === params.version_id;
    }).length,
    roleSteps.length
  );
  const signalHits = params.focus_areas.filter((focus) => {
    if (roleSteps.length === 0) {
      return true;
    }
    return roleSteps.every((step) => {
      const { taskExecution, signals } = readTaskExecution(step as unknown as Record<string, unknown>);
      const acceptanceChecks = Array.isArray(step.acceptance_checks) ? step.acceptance_checks.map((entry) => String(entry)) : [];
      const rollbackNotes = Array.isArray((step.input as Record<string, unknown>).rollback_notes)
        ? ((step.input as Record<string, unknown>).rollback_notes as unknown[]).map((entry) => String(entry))
        : [];
      switch (focus) {
        case "bounded_execution":
          return acceptanceChecks.some((entry) => /bounded|single owner|narrow/i.test(entry)) || readBoolean(signals.bounded_execution);
        case "explicit_evidence":
          return acceptanceChecks.some((entry) => /evidence|reproducible|proof/i.test(entry)) || readBoolean(signals.explicit_evidence);
        case "rollback_ready":
          return rollbackNotes.some((entry) => /rollback|reversible/i.test(entry)) || readBoolean(signals.rollback_ready);
        case "local_first":
          return Array.isArray(taskExecution.preferred_host_tags) && taskExecution.preferred_host_tags.map(String).includes("local");
        case "parallel_delegation":
          return readBoolean(taskExecution.parallelizable) || readBoolean(signals.parallel_delegation);
        case "specialist_routing":
          return readBoolean(taskExecution.specialist_routing_required) || readBoolean(signals.specialist_routing);
        case "fail_closed":
          return readBoolean(taskExecution.fail_closed) || acceptanceChecks.some((entry) => /escalate|stop when confidence is weak/i.test(entry));
        case "verification_first":
          return acceptanceChecks.some((entry) => /acceptance checks are explicit|verification/i.test(entry)) || readBoolean(signals.verification_first);
        default:
          return false;
      }
    });
  }).length;
  const signalCoverageRatio = safeRatio(signalHits, params.focus_areas.length || 1);
  const verificationRatio =
    verificationStep && verificationStep.depends_on.length >= Math.max(0, nonAnalysisSteps.length - 1) ? 1 : 0;
  const breakdown = {
    ownership: Number((ownershipRatio * 15).toFixed(4)),
    evidence: Number((evidenceRatio * 20).toFixed(4)),
    rollback: Number((rollbackRatio * 15).toFixed(4)),
    org_binding: Number((orgBindingRatio * 20).toFixed(4)),
    signal_coverage: Number((signalCoverageRatio * 20).toFixed(4)),
    verification_gate: Number((verificationRatio * 10).toFixed(4)),
  };
  const totalScore = Number(
    (
      breakdown.ownership +
      breakdown.evidence +
      breakdown.rollback +
      breakdown.org_binding +
      breakdown.signal_coverage +
      breakdown.verification_gate
    ).toFixed(4)
  );
  const reasons = [
    `ownership=${breakdown.ownership.toFixed(1)}`,
    `evidence=${breakdown.evidence.toFixed(1)}`,
    `rollback=${breakdown.rollback.toFixed(1)}`,
    `org_binding=${breakdown.org_binding.toFixed(1)}`,
    `signal_coverage=${breakdown.signal_coverage.toFixed(1)}`,
    `verification_gate=${breakdown.verification_gate.toFixed(1)}`,
  ];
  return {
    total_score: totalScore,
    breakdown,
    reasons,
  };
}

function updateRoleState(
  storage: Storage,
  state: ReturnType<typeof loadOrgPrograms>,
  role: OrgProgramRoleRecord
) {
  const roles = state.roles.filter((entry) => entry.role_id !== role.role_id).concat([role]);
  return storage.setOrgProgramsState({
    enabled: state.enabled,
    roles,
  });
}

function summarizeRoleStatus(role: OrgProgramRoleRecord) {
  const optimizerState =
    role.metadata.optimizer && typeof role.metadata.optimizer === "object"
      ? (role.metadata.optimizer as Record<string, unknown>)
      : {};
  return {
    role_id: role.role_id,
    title: role.title,
    active_version_id: role.active_version_id,
    version_count: role.versions.length,
    candidate_version_count: role.versions.filter((entry) => entry.status === "candidate").length,
    last_optimizer_run_at: String(optimizerState.last_run_at ?? "") || null,
    last_optimizer_improvement: typeof optimizerState.last_improvement === "number" ? optimizerState.last_improvement : null,
    last_optimizer_promoted: optimizerState.last_promoted === true,
  };
}

export async function optimizer(storage: Storage, input: z.infer<typeof optimizerSchema>) {
  if (input.action === "status") {
    const state = loadOrgPrograms(storage);
    const roles = input.role_id?.trim() ? state.roles.filter((role) => role.role_id === input.role_id) : state.roles;
    return {
      enabled: state.enabled,
      role_count: state.roles.length,
      roles: roles.map(summarizeRoleStatus),
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "optimizer",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const state = loadOrgPrograms(storage);
      const role = ensureRole(state, input.role_id!.trim());
      const baselineVersion =
        (input.version_id?.trim()
          ? role.versions.find((entry) => entry.version_id === input.version_id!.trim()) ?? null
          : null) ?? getActiveVersion(role);
      if (!baselineVersion) {
        throw new Error(`Role ${role.role_id} has no baseline version to optimize`);
      }
      const focusAreas = dedupeFocuses(input.focus_areas);

      if (input.action === "propose_variant") {
        const candidate = mutateRoleVersion(role, baselineVersion, focusAreas);
        const nextRole = upsertVersion(
          {
            ...role,
            metadata: {
              ...role.metadata,
              optimizer: {
                ...(role.metadata.optimizer && typeof role.metadata.optimizer === "object"
                  ? (role.metadata.optimizer as Record<string, unknown>)
                  : {}),
                last_candidate_version_id: candidate.version_id,
                last_focus_areas: focusAreas,
                last_run_at: candidate.created_at,
              },
            },
            updated_at: candidate.created_at,
          },
          candidate
        );
        const persisted = updateRoleState(storage, state, nextRole);
        return {
          state: persisted,
          role: nextRole,
          candidate_version: candidate,
          focus_areas: focusAreas,
        };
      }

      const candidateVersion =
        (input.version_id?.trim()
          ? role.versions.find((entry) => entry.version_id === input.version_id!.trim()) ?? null
          : null) ?? mutateRoleVersion(role, baselineVersion, focusAreas);
      const candidateAlreadyExists = role.versions.some((entry) => entry.version_id === candidateVersion.version_id);
      const roleWithCandidate = candidateAlreadyExists
        ? role
        : upsertVersion(
            {
              ...role,
              updated_at: new Date().toISOString(),
            },
            candidateVersion
          );
      const objectives = (input.objectives ?? []).map((entry) => entry.trim()).filter(Boolean);
      const baselineEvaluations = objectives.map((objective) =>
        scoreCompiledPreview({
          preview: compileObjectivePreview(storage, {
            objective,
            metadata: input.metadata,
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          }),
          role_id: role.role_id,
          version_id: baselineVersion.version_id,
          focus_areas: focusAreas,
        })
      );
      const candidateEvaluations = objectives.map((objective) =>
        scoreCompiledPreview({
          preview: compileObjectivePreview(storage, {
            objective,
            metadata: input.metadata,
            org_program_overrides: {
              [role.role_id]: candidateVersion,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          }),
          role_id: role.role_id,
          version_id: candidateVersion.version_id,
          focus_areas: focusAreas,
        })
      );
      const averageScore = (entries: PlanScorecard[]) =>
        entries.length === 0 ? 0 : Number((entries.reduce((sum, entry) => sum + entry.total_score, 0) / entries.length).toFixed(4));
      const baselineScore = averageScore(baselineEvaluations);
      const candidateScore = averageScore(candidateEvaluations);
      const improvement = Number((candidateScore - baselineScore).toFixed(4));
      const promote = (input.promote_if_better ?? false) && improvement >= (input.min_improvement ?? 2);
      const now = new Date().toISOString();

      const experiment =
        (input.experiment_id?.trim() ? storage.getExperimentById(input.experiment_id.trim()) : null) ??
        storage.createExperiment({
          experiment_id: input.experiment_id?.trim(),
          title: `${role.title} optimizer`,
          objective: `Improve ${role.role_id} role-program quality by measured compile-plan structure and doctrine propagation.`,
          metric_name: "plan_quality_score",
          metric_direction: "maximize",
          status: "active",
          tags: ["optimizer", "org-program", role.role_id],
          metadata: {
            role_id: role.role_id,
            source: "optimizer.step",
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        }).experiment;

      const runId = `optimizer-run-${crypto.randomUUID()}`;
      const experimentRun = storage.createExperimentRun({
        experiment_id: experiment.experiment_id,
        candidate_label: candidateVersion.version_id,
        run_id: runId,
        status: "running",
        metadata: {
          role_id: role.role_id,
          baseline_version_id: baselineVersion.version_id,
          candidate_version_id: candidateVersion.version_id,
          focus_areas: focusAreas,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }).experiment_run;

      const artifact = storage.recordArtifact({
        artifact_type: "optimizer.scorecard",
        status: "active",
        run_id: runId,
        producer_kind: "tool",
        producer_id: "optimizer.step",
        trust_tier: "derived",
        content_json: {
          role_id: role.role_id,
          baseline_version_id: baselineVersion.version_id,
          candidate_version_id: candidateVersion.version_id,
          focus_areas: focusAreas,
          objectives,
          baseline_score: baselineScore,
          candidate_score: candidateScore,
          improvement,
          baseline_evaluations: baselineEvaluations,
          candidate_evaluations: candidateEvaluations,
        },
        metadata: {
          promoted: promote,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }).artifact;

      storage.appendRunEvent({
        run_id: runId,
        event_type: "end",
        step_index: objectives.length,
        status: improvement > 0 ? "completed" : "failed",
        summary:
          improvement > 0
            ? `Optimizer step improved ${role.role_id} by ${improvement.toFixed(2)} points.`
            : `Optimizer step did not improve ${role.role_id}.`,
        details: {
          role_id: role.role_id,
          baseline_score: baselineScore,
          candidate_score: candidateScore,
          improvement,
          promoted: promote,
          artifact_id: artifact.artifact_id,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      const updatedRun = storage.updateExperimentRun({
        experiment_run_id: experimentRun.experiment_run_id,
        status: improvement > 0 ? "completed" : "discarded",
        verdict: improvement > 0 ? "accepted" : "rejected",
        summary:
          improvement > 0
            ? `Candidate ${candidateVersion.version_id} improved plan quality to ${candidateScore.toFixed(2)}.`
            : `Candidate ${candidateVersion.version_id} did not beat baseline ${baselineScore.toFixed(2)}.`,
        observed_metric: candidateScore,
        observed_metrics: {
          baseline_score: baselineScore,
          candidate_score: candidateScore,
          improvement,
        },
        metadata: {
          role_id: role.role_id,
          artifact_id: artifact.artifact_id,
          promoted: promote,
        },
      }).experiment_run;

      storage.updateExperiment({
        experiment_id: experiment.experiment_id,
        status: "active",
        current_best_metric: improvement > 0 ? candidateScore : baselineScore,
        selected_run_id: improvement > 0 ? updatedRun.experiment_run_id : undefined,
        metadata: {
          ...experiment.metadata,
          role_id: role.role_id,
          last_artifact_id: artifact.artifact_id,
          last_candidate_version_id: candidateVersion.version_id,
          last_improvement: improvement,
          last_promoted: promote,
        },
      });

      const nextRoleMetadata = {
        ...roleWithCandidate.metadata,
        optimizer: {
          ...(roleWithCandidate.metadata.optimizer && typeof roleWithCandidate.metadata.optimizer === "object"
            ? (roleWithCandidate.metadata.optimizer as Record<string, unknown>)
            : {}),
          last_run_at: now,
          last_candidate_version_id: candidateVersion.version_id,
          last_focus_areas: focusAreas,
          last_baseline_version_id: baselineVersion.version_id,
          last_baseline_score: baselineScore,
          last_candidate_score: candidateScore,
          last_improvement: improvement,
          last_promoted: promote,
          last_experiment_id: experiment.experiment_id,
          last_experiment_run_id: updatedRun.experiment_run_id,
          last_artifact_id: artifact.artifact_id,
        },
      };
      const nextRole: OrgProgramRoleRecord = promote
        ? {
            ...roleWithCandidate,
            active_version_id: candidateVersion.version_id,
            metadata: nextRoleMetadata,
            versions: roleWithCandidate.versions.map((entry) =>
              entry.version_id === candidateVersion.version_id
                ? { ...entry, status: "active" as const }
                : entry.status === "active"
                  ? { ...entry, status: "candidate" as const }
                  : entry
            ),
            updated_at: now,
          }
        : {
            ...roleWithCandidate,
            metadata: nextRoleMetadata,
            updated_at: now,
          };
      const persisted = updateRoleState(storage, state, nextRole);

      return {
        state: persisted,
        role: summarizeRoleStatus(nextRole),
        candidate_version: candidateVersion,
        baseline_version_id: baselineVersion.version_id,
        focus_areas: focusAreas,
        baseline_score: baselineScore,
        candidate_score: candidateScore,
        improvement,
        promoted: promote,
        experiment_id: experiment.experiment_id,
        experiment_run: updatedRun,
        artifact,
      };
    },
  });
}
