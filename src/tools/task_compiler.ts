import crypto from "node:crypto";
import { z } from "zod";
import { Storage, type GoalRecord, type GoalRiskTier, type OrgProgramVersionRecord } from "../storage.js";
import { mergeDeclaredPermissionProfile } from "../control_plane_runtime.js";
import { retrievalHybrid } from "./knowledge.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { deriveOrgProgramSignals, getEffectiveOrgProgram } from "./org_program.js";
import { matchDomainSpecialists } from "./specialist_catalog.js";
import { resolveSwarmProfile, summarizeMemoryPreflight, type SwarmMemoryPreflightSummary } from "./swarm_profile.js";

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

type OrgProgramOverrideMap = Record<string, OrgProgramVersionRecord>;

type CompileBriefDocument = {
  content_text: string;
  content_json: Record<string, unknown>;
  metadata: Record<string, unknown>;
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

function readMetadataStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function readMemoryPreflightSummary(value: unknown): SwarmMemoryPreflightSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const strategy = typeof record.strategy === "string" ? record.strategy.trim() : "";
  const matchCount = typeof record.match_count === "number" && Number.isFinite(record.match_count) ? record.match_count : null;
  const topMatches = Array.isArray(record.top_matches) ? record.top_matches : null;
  if (!query || !strategy || matchCount === null || !topMatches) {
    return null;
  }
  return {
    query,
    strategy,
    match_count: matchCount,
    top_matches: topMatches
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const match = entry as Record<string, unknown>;
        return [
          {
            type: typeof match.type === "string" ? match.type : "unknown",
            id: typeof match.id === "string" ? match.id : "unknown",
            score: typeof match.score === "number" && Number.isFinite(match.score) ? match.score : null,
            text_preview: typeof match.text_preview === "string" ? match.text_preview : "",
            citation: match.citation && typeof match.citation === "object" && !Array.isArray(match.citation) ? (match.citation as Record<string, unknown>) : {},
          },
        ];
      })
      .slice(0, 3),
  };
}

function uniqueStrings(values: Iterable<string>) {
  return [...new Set([...values].map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function resolveOrgProgramContext(storage: Storage, roleId: string, overrides?: OrgProgramOverrideMap) {
  const override = overrides?.[roleId];
  if (override) {
    return {
      version: override,
      signals: deriveOrgProgramSignals(override),
    };
  }
  const effective = getEffectiveOrgProgram(storage, roleId);
  return {
    version: effective?.version ?? null,
    signals: deriveOrgProgramSignals(effective?.version ?? null),
  };
}

function deriveProgramAcceptanceChecks(signals: ReturnType<typeof deriveOrgProgramSignals>) {
  const checks: string[] = [];
  if (signals.bounded_execution) {
    checks.push("Work stays bounded to one owner and a narrow execution slice.");
  }
  if (signals.explicit_evidence) {
    checks.push("Evidence is concrete, reproducible, and directly tied to the claimed result.");
  }
  if (signals.verification_first) {
    checks.push("Acceptance checks are explicit before merge or handoff.");
  }
  if (signals.fail_closed) {
    checks.push("Escalate or stop when confidence is weak or scope spills outside the lane.");
  }
  if (signals.specialist_routing) {
    checks.push("Use the narrowest viable specialist or leaf agent for domain-specific work.");
  }
  return checks;
}

function deriveProgramRollbackNotes(signals: ReturnType<typeof deriveOrgProgramSignals>) {
  const notes: string[] = [];
  if (signals.rollback_ready) {
    notes.push("Rollback remains documented and reversible before merge.");
  }
  if (signals.fail_closed) {
    notes.push("Escalate back to the supervising agent instead of forcing low-confidence execution.");
  }
  return notes;
}

function applySignalsToTaskMetadata(
  taskMetadata: Record<string, unknown>,
  signals: ReturnType<typeof deriveOrgProgramSignals>
) {
  const nextTaskMetadata = { ...taskMetadata };
  const preferredHostTags = uniqueStrings(
    Array.isArray(nextTaskMetadata.preferred_host_tags) ? (nextTaskMetadata.preferred_host_tags as string[]) : []
  );
  if (signals.local_first && !preferredHostTags.includes("local")) {
    preferredHostTags.unshift("local");
  }
  if (preferredHostTags.length > 0) {
    nextTaskMetadata.preferred_host_tags = preferredHostTags;
  }
  if (signals.parallel_delegation) {
    nextTaskMetadata.parallelizable = true;
  }
  if (signals.specialist_routing) {
    nextTaskMetadata.specialist_routing_required = true;
  }
  if (signals.fail_closed) {
    nextTaskMetadata.fail_closed = true;
  }
  return nextTaskMetadata;
}

function renderBulletedSection(title: string, items: string[]) {
  const normalized = uniqueStrings(items);
  if (normalized.length === 0) {
    return `${title}\n- none`;
  }
  return [title, ...normalized.map((item) => `- ${item}`)].join("\n");
}

function describeMemoryPreflight(memoryPreflight: ReturnType<typeof summarizeMemoryPreflight>) {
  const lines = [
    "Memory preflight",
    `- query: ${memoryPreflight.query}`,
    `- strategy: ${memoryPreflight.strategy}`,
    `- match_count: ${memoryPreflight.match_count}`,
  ];
  if (memoryPreflight.top_matches.length > 0) {
    lines.push("- top_matches:");
    for (const match of memoryPreflight.top_matches) {
      lines.push(`  - ${match.type}:${match.id}${match.score === null ? "" : ` score=${match.score}`}`);
      if (match.text_preview) {
        lines.push(`    ${match.text_preview}`);
      }
    }
  }
  return lines.join("\n");
}

function buildCompileBriefDocument(input: {
  goal: GoalRecord;
  objective: string;
  plan_title: string;
  preview: ReturnType<typeof compileObjectivePreview>;
  success_criteria: string[];
  rollback: string[];
  plan_id?: string | null;
  step_id?: string | null;
}) : CompileBriefDocument {
  const workstreamSummaries = input.preview.streams.map((stream) => ({
    stream_id: stream.stream_id,
    title: stream.title,
    owner_role_id: stream.owner_role_id,
    executor_ref: stream.executor_ref,
    step_kind: stream.step_kind,
    depends_on: stream.depends_on,
    evidence_requirements: stream.evidence_requirements,
    rollback_notes: stream.rollback_notes,
    task_metadata: stream.task_metadata,
  }));
  const stepSummaries = input.preview.steps.map((step) => ({
    step_id: step.step_id,
    seq: step.seq,
    title: step.title,
    step_kind: step.step_kind,
    executor_kind: step.executor_kind,
    executor_ref: step.executor_ref,
    depends_on: step.depends_on,
    expected_artifact_types: step.expected_artifact_types,
    acceptance_checks: step.acceptance_checks,
  }));
  const lines = [
    "# Compile Brief",
    `Generated: ${new Date().toISOString()}`,
    `Goal: ${input.goal.title}`,
    `Goal ID: ${input.goal.goal_id}`,
    `Plan title: ${input.plan_title}`,
    `Plan ID: ${input.plan_id ?? "preview"}`,
    `Analysis step ID: ${input.step_id ?? "preview"}`,
    "",
    "Objective",
    input.objective,
    "",
    "Summary",
    input.preview.summary,
    "",
    "Swarm profile",
    `- topology: ${input.preview.swarm_profile.topology}`,
    `- consensus_mode: ${input.preview.swarm_profile.consensus_mode}`,
    `- execution_mode: ${input.preview.swarm_profile.execution_mode}`,
    `- queen_mode: ${input.preview.swarm_profile.queen_mode}`,
    `- checkpoint_cadence: ${input.preview.swarm_profile.checkpoint_policy.cadence}`,
    "",
    describeMemoryPreflight(input.preview.memory_preflight),
    "",
    "Workstreams",
    ...workstreamSummaries.flatMap((stream, index) => [
      `${index + 1}. ${stream.title} [${stream.stream_id}]`,
      `   owner: ${stream.owner_role_id}`,
      `   executor: ${stream.executor_ref}`,
      `   step_kind: ${stream.step_kind}`,
      `   depends_on: ${stream.depends_on.length > 0 ? stream.depends_on.join(", ") : "none"}`,
      `   evidence: ${stream.evidence_requirements.length > 0 ? stream.evidence_requirements.join(" | ") : "none"}`,
      `   rollback: ${stream.rollback_notes.length > 0 ? stream.rollback_notes.join(" | ") : "none"}`,
    ]),
    "",
    renderBulletedSection("Success criteria", input.success_criteria),
    "",
    renderBulletedSection("Rollback notes", input.rollback),
    "",
    "Plan steps",
    ...stepSummaries.flatMap((step) => [
      `- [${step.seq}] ${step.title} (${step.step_kind}) owner=${step.executor_ref ?? "n/a"}`,
      `  depends_on: ${step.depends_on.length > 0 ? step.depends_on.join(", ") : "none"}`,
      `  artifacts: ${step.expected_artifact_types.length > 0 ? step.expected_artifact_types.join(", ") : "none"}`,
    ]),
  ];

  return {
    content_text: lines.join("\n"),
    content_json: {
      goal_id: input.goal.goal_id,
      goal_title: input.goal.title,
      plan_title: input.plan_title,
      plan_id: input.plan_id ?? null,
      step_id: input.step_id ?? null,
      objective: input.objective,
      summary: input.preview.summary,
      swarm_profile: input.preview.swarm_profile,
      memory_preflight: input.preview.memory_preflight,
      streams: workstreamSummaries,
      steps: stepSummaries,
      success_criteria: input.success_criteria,
      rollback: input.rollback,
    },
    metadata: {
      topology: input.preview.swarm_profile.topology,
      consensus_mode: input.preview.swarm_profile.consensus_mode,
      execution_mode: input.preview.swarm_profile.execution_mode,
      checkpoint_cadence: input.preview.swarm_profile.checkpoint_policy.cadence,
      stream_count: workstreamSummaries.length,
      step_count: stepSummaries.length,
      memory_match_count: input.preview.memory_preflight.match_count,
    },
  };
}

export function compileObjectivePreview(
  storage: Storage,
  input: {
    objective: string;
    goal_id?: string | null;
    workstreams?: z.infer<typeof compiledWorkstreamSchema>[];
    success_criteria?: string[];
    rollback?: string[];
    metadata?: Record<string, unknown>;
    risk_tier?: GoalRiskTier | null;
    budget?: Record<string, unknown> | null;
    org_program_overrides?: OrgProgramOverrideMap;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const now = new Date().toISOString();
  const streams = materializeStreams(storage, {
    mutation: { idempotency_key: "preview", side_effect_fingerprint: "preview" },
    goal_id: input.goal_id?.trim() || "preview-goal",
    objective: input.objective,
    create_plan: false,
    workstreams: input.workstreams,
    success_criteria: input.success_criteria,
    rollback: input.rollback,
    metadata: input.metadata,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });
  const swarmProfile = resolveSwarmProfile({
    objective: input.objective,
    workstreams: streams,
    matched_domains: readMetadataStringArray(input.metadata?.matched_specialist_domains),
    routed_bridge_agent_ids: readMetadataStringArray(input.metadata?.routed_bridge_agent_ids),
    trichat_agent_ids: readMetadataStringArray(input.metadata?.trichat_agent_ids),
    risk_tier: input.risk_tier ?? "medium",
    budget: input.budget ?? {},
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });
  const memoryPreflight =
    readMemoryPreflightSummary(input.metadata?.memory_preflight) ??
    summarizeMemoryPreflight(
      retrievalHybrid(storage, {
        query: swarmProfile.memory_preflight.query,
        include_notes: true,
        include_transcripts: true,
        limit: swarmProfile.memory_preflight.limit,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
      swarmProfile.memory_preflight.query
    );
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
        swarm_profile: swarmProfile,
        checkpoint_policy: swarmProfile.checkpoint_policy,
        memory_preflight: memoryPreflight,
      },
      depends_on: [],
    },
    ...streams.map((stream, index) => {
      const orgProgram = resolveOrgProgramContext(storage, stream.owner_role_id, input.org_program_overrides);
      const resolvedDependsOn = stream.depends_on
        .map((dependencyId) => streamStepIds.get(dependencyId))
        .filter((dependencyId): dependencyId is string => Boolean(dependencyId));
      const evidenceRequirements = uniqueStrings(stream.evidence_requirements);
      const rollbackNotes = uniqueStrings([...stream.rollback_notes, ...deriveProgramRollbackNotes(orgProgram.signals)]);
      const acceptanceChecks = uniqueStrings([...evidenceRequirements, ...deriveProgramAcceptanceChecks(orgProgram.signals)]);
      const taskExecution = applySignalsToTaskMetadata(stream.task_metadata, orgProgram.signals);
      if (
        (stream.step_kind === "mutation" || stream.step_kind === "verification") &&
        (typeof taskExecution.runtime_id !== "string" || !taskExecution.runtime_id.trim())
      ) {
        taskExecution.runtime_id = "codex";
        taskExecution.runtime_strategy = "tmux_worktree";
      }
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
          evidence_requirements: evidenceRequirements,
          rollback_notes: rollbackNotes,
        },
        expected_artifact_types: ["evidence.bundle"],
        acceptance_checks: acceptanceChecks,
        retry_policy: {},
        timeout_seconds: 3600,
        metadata: {
          compiler: "task.compile",
          owner_role_id: stream.owner_role_id,
          org_program_version_id: orgProgram.version?.version_id ?? null,
          org_program_summary: orgProgram.version?.summary ?? null,
          org_program_doctrine: orgProgram.version?.doctrine ?? null,
          org_program_delegation_contract: orgProgram.version?.delegation_contract ?? null,
          org_program_evaluation_standard: orgProgram.version?.evaluation_standard ?? null,
          org_program_signals: orgProgram.signals,
          swarm_profile: swarmProfile,
          checkpoint_required: true,
          checkpoint_cadence: swarmProfile.checkpoint_policy.cadence,
          memory_preflight: memoryPreflight,
          task_execution: taskExecution,
        },
        depends_on: [analysisStepId, ...resolvedDependsOn],
      };
    }),
  ];

  compiledSteps.push({
    step_id: `compile-verification-${crypto.randomUUID()}`,
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
      org_program_doctrine: null,
      org_program_delegation_contract: null,
      org_program_evaluation_standard: null,
      org_program_signals: deriveOrgProgramSignals(null),
      swarm_profile: swarmProfile,
      checkpoint_required: true,
      checkpoint_cadence: swarmProfile.checkpoint_policy.cadence,
      memory_preflight: memoryPreflight,
      task_execution: {},
    },
    depends_on: compiledSteps.filter((step) => step.step_id !== analysisStepId).map((step) => step.step_id),
  });

  return {
    summary: `Compiled objective into ${streams.length} bounded workstreams with explicit verification and owner contracts.`,
    streams,
    steps: compiledSteps,
    swarm_profile: swarmProfile,
    memory_preflight: memoryPreflight,
  };
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
      const preview = compileObjectivePreview(storage, {
        goal_id: input.goal_id,
        objective: input.objective,
        workstreams: input.workstreams,
        success_criteria: input.success_criteria,
        rollback: input.rollback,
        metadata: input.metadata,
        risk_tier: goal.risk_tier,
        budget: goal.budget,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const planTitle = input.title?.trim() || goal.title;
      const summary = preview.summary;
      const successCriteria = input.success_criteria ?? ["Objective is completed with evidence."];
      const rollbackNotes = input.rollback ?? ["Keep each workstream bounded and reversible."];
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
            success_criteria: successCriteria,
            rollback: rollbackNotes,
            budget: goal.budget,
            metadata: mergeDeclaredPermissionProfile({
              compiler: "task.compile",
              objective: input.objective,
              swarm_profile: preview.swarm_profile,
              checkpoint_policy: preview.swarm_profile.checkpoint_policy,
              memory_preflight: preview.memory_preflight,
              ...(input.metadata ?? {}),
            }, typeof goal.metadata.permission_profile === "string" ? goal.metadata.permission_profile : null),
            steps: preview.steps,
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          })
        : null;

      const analysisStepId =
        created?.steps.find((step) => step.step_kind === "analysis" && step.seq === 1)?.step_id ??
        preview.steps.find((step) => step.step_kind === "analysis" && step.seq === 1)?.step_id ??
        null;
      const compileBrief = buildCompileBriefDocument({
        goal,
        objective: input.objective,
        plan_title: planTitle,
        preview,
        success_criteria: successCriteria,
        rollback: rollbackNotes,
        plan_id: created?.plan.plan_id ?? null,
        step_id: analysisStepId,
      });

      let checkpoint_artifact = null;
      if (created?.plan) {
        checkpoint_artifact = storage.recordArtifact({
          artifact_type: "swarm.checkpoint",
          goal_id: input.goal_id,
          plan_id: created.plan.plan_id,
          producer_kind: "planner",
          producer_id: "task.compile",
          trust_tier: "derived",
          status: "active",
          content_json: {
            phase: "plan-compiled",
            objective: input.objective,
            stream_count: preview.streams.length,
            step_count: created.steps.length,
            profile: preview.swarm_profile,
            memory_preflight: preview.memory_preflight,
          },
          metadata: {
            phase: "plan-compiled",
            topology: preview.swarm_profile.topology,
            consensus_mode: preview.swarm_profile.consensus_mode,
            checkpoint_cadence: preview.swarm_profile.checkpoint_policy.cadence,
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
      }

      let compile_brief_artifact = null;
      if (created?.plan && analysisStepId) {
        compile_brief_artifact = storage.recordArtifact({
          artifact_type: "compile.brief",
          goal_id: input.goal_id,
          plan_id: created.plan.plan_id,
          step_id: analysisStepId,
          producer_kind: "planner",
          producer_id: "task.compile",
          trust_tier: "derived",
          status: "active",
          content_text: compileBrief.content_text,
          content_json: compileBrief.content_json,
          metadata: compileBrief.metadata,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
      }

      return {
        goal_id: input.goal_id,
        objective: input.objective,
        summary,
        streams: preview.streams,
        plan: created?.plan ?? null,
        steps: created?.steps ?? preview.steps,
        created_plan: created?.created ?? false,
        swarm_profile: preview.swarm_profile,
        memory_preflight: preview.memory_preflight,
        compile_brief: compileBrief,
        compile_brief_artifact: compile_brief_artifact?.artifact ?? null,
        checkpoint_artifact: checkpoint_artifact?.artifact ?? null,
      };
    },
  });
}
