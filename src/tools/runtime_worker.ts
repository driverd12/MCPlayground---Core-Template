import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type RuntimeWorkerRuntimeId,
  type RuntimeWorkerSessionRecord,
  type RuntimeWorkerSessionStatus,
  Storage,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const controlPlaneRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const controlPlaneHelperPath = path.join(controlPlaneRepoRoot, "scripts", "mcp_tool_call.mjs");
const controlPlaneServerPath = path.join(controlPlaneRepoRoot, "dist", "server.js");

const runtimeIdSchema = z.enum(["codex", "shell"]);
const runtimeStrategySchema = z.enum(["tmux_worktree"]);
const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const runtimeWorkerSchema = z
  .object({
    action: z.enum(["status", "spawn_task", "spawn_pending", "stop"]).default("status"),
    mutation: mutationSchema.optional(),
    session_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    runtime_id: runtimeIdSchema.optional(),
    runtime_strategy: runtimeStrategySchema.optional(),
    lease_seconds: z.number().int().min(60).max(86400).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    max_active_sessions: z.number().int().min(1).max(8).optional(),
    cleanup_worktree: z.boolean().optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if ((value.action === "spawn_task" || value.action === "spawn_pending" || value.action === "stop") && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for spawn_task, spawn_pending, and stop",
        path: ["mutation"],
      });
    }
    if (value.action === "spawn_task" && !value.task_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "task_id is required for spawn_task",
        path: ["task_id"],
      });
    }
    if (value.action === "stop" && !value.session_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session_id is required for stop",
        path: ["session_id"],
      });
    }
  });

type RuntimeRequest = {
  runtime_id: RuntimeWorkerRuntimeId;
  runtime_strategy: "tmux_worktree";
  runtime_command: string | null;
};

type LiveRuntimeWorkerSession = RuntimeWorkerSessionRecord & {
  tmux_present: boolean;
  pane_command: string | null;
  worktree_present: boolean;
  transcript_present: boolean;
  task_status: string | null;
  pane_excerpt: string[];
};

type RuntimeCompletionEnvelope = {
  task_id: string;
  worker_id: string;
  status: "completed" | "failed";
  summary: string;
  error?: string;
  result?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function readNullableRecord(value: unknown) {
  return isRecord(value) ? value : null;
}

function boundedReasoningCandidateCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.min(4, Math.round(value)));
}

function resolveReasoningComputePolicy(taskExecution: Record<string, unknown>) {
  return readNullableRecord(taskExecution.reasoning_compute_policy);
}

function resolveReasoningCandidateCount(taskExecution: Record<string, unknown>): number | null {
  const legacyCount = boundedReasoningCandidateCount(taskExecution.reasoning_candidate_count);
  if (legacyCount !== null) {
    return legacyCount;
  }
  const computePolicy = resolveReasoningComputePolicy(taskExecution);
  const policyCount =
    boundedReasoningCandidateCount(computePolicy?.candidate_count) ??
    boundedReasoningCandidateCount(computePolicy?.max_candidate_count);
  if (readString(computePolicy?.mode) === "adaptive_best_of_n") {
    return Math.max(2, policyCount ?? 2);
  }
  return policyCount;
}

function resolveReasoningSelectionStrategy(taskExecution: Record<string, unknown>): string | null {
  return readString(taskExecution.reasoning_selection_strategy) ?? readString(resolveReasoningComputePolicy(taskExecution)?.selection_strategy);
}

function resolveShallowBranchSearch(taskExecution: Record<string, unknown>) {
  const computePolicy = resolveReasoningComputePolicy(taskExecution);
  const branchSearch = readNullableRecord(computePolicy?.shallow_branch_search);
  return branchSearch?.enabled === true ? branchSearch : null;
}

function resolveBudgetForcing(taskExecution: Record<string, unknown>) {
  const computePolicy = resolveReasoningComputePolicy(taskExecution);
  const budgetForcing = readNullableRecord(computePolicy?.budget_forcing);
  return budgetForcing?.enabled === true ? budgetForcing : null;
}

function extractDelegationBrief(task: { payload: Record<string, unknown>; metadata: Record<string, unknown> }) {
  const nested =
    readNullableRecord(task.payload.delegation_brief) ??
    readNullableRecord(task.metadata.delegation_brief) ??
    readNullableRecord(task.metadata.last_selected_delegation_brief);
  if (!nested) {
    return {
      delegate_agent_id: null,
      task_objective: null,
      success_criteria: [] as string[],
      evidence_requirements: [] as string[],
      rollback_notes: [] as string[],
    };
  }
  return {
    delegate_agent_id: readString(nested.delegate_agent_id),
    task_objective: readString(nested.task_objective),
    success_criteria: readStringArray(nested.success_criteria),
    evidence_requirements: readStringArray(nested.evidence_requirements),
    rollback_notes: readStringArray(nested.rollback_notes),
  };
}

function renderBulletSection(title: string, items: string[]) {
  if (items.length === 0) {
    return `${title}\n- none`;
  }
  return [title, ...items.map((item) => `- ${item}`)].join("\n");
}

function uniqueStrings(items: Array<string | null | undefined>) {
  return [...new Set(items.map((item) => readString(item)).filter((item): item is string => Boolean(item)))];
}

function describeReasoningPolicy(taskMetadata: Record<string, unknown>, taskExecution: Record<string, unknown>) {
  const taskKind = readString(taskExecution.task_kind);
  const qualityPreference = readString(taskExecution.quality_preference);
  const focus = readString(taskExecution.focus);
  const reasoningCandidateCount = resolveReasoningCandidateCount(taskExecution);
  const reasoningSelectionStrategy = resolveReasoningSelectionStrategy(taskExecution);
  const requirePlanPass = taskExecution.require_plan_pass === true;
  const requireVerificationPass = taskExecution.require_verification_pass === true;
  const orgSignals = readNullableRecord(taskMetadata.org_program_signals);
  const computePolicy = resolveReasoningComputePolicy(taskExecution);
  const policyMode = readString(computePolicy?.mode);
  const activationReasons = readStringArray(computePolicy?.activation_reasons);
  const transcriptPolicy = readString(computePolicy?.transcript_policy);
  const verifierRerank = readNullableRecord(computePolicy?.verifier_rerank);
  const verifierScoreFields = readStringArray(verifierRerank?.score_fields);
  const verifierRequiredFields = readStringArray(verifierRerank?.required_selected_fields);
  const computeBudget = readNullableRecord(computePolicy?.compute_budget);
  const computeTelemetryFields = readStringArray(computeBudget?.telemetry_fields);
  const evidenceCharLimit =
    typeof computeBudget?.evidence_char_limit === "number" && Number.isFinite(computeBudget.evidence_char_limit)
      ? Math.max(256, Math.round(computeBudget.evidence_char_limit))
      : null;
  const shallowBranchSearch = resolveShallowBranchSearch(taskExecution);
  const branchPruneSignals = readStringArray(shallowBranchSearch?.prune_with);
  const branchCount =
    typeof shallowBranchSearch?.branch_count === "number" && Number.isFinite(shallowBranchSearch.branch_count)
      ? Math.max(1, Math.round(shallowBranchSearch.branch_count))
      : reasoningCandidateCount;
  const branchDepth =
    typeof shallowBranchSearch?.max_depth === "number" && Number.isFinite(shallowBranchSearch.max_depth)
      ? Math.max(1, Math.round(shallowBranchSearch.max_depth))
      : null;
  const budgetForcing = resolveBudgetForcing(taskExecution);
  const budgetRevisionPasses =
    typeof budgetForcing?.max_revision_passes === "number" && Number.isFinite(budgetForcing.max_revision_passes)
      ? Math.max(1, Math.round(budgetForcing.max_revision_passes))
      : 1;
  const budgetRequiredFields = readStringArray(budgetForcing?.required_evidence_fields);
  const lines = uniqueStrings([
    policyMode === "adaptive_best_of_n"
      ? `Adaptive compute policy: best-of-N with ${reasoningCandidateCount ?? computePolicy?.candidate_count ?? "bounded"} candidate(s).`
      : null,
    activationReasons.length > 0 ? `Activation reasons: ${activationReasons.join(", ")}.` : null,
    computeBudget
      ? `Compute budget: candidates<=${String(computeBudget.max_candidate_count ?? computeBudget.candidate_budget ?? reasoningCandidateCount ?? "bounded")}, branches<=${String(computeBudget.max_branch_count ?? 0)}, revisions<=${String(computeBudget.max_revision_passes ?? 0)}${evidenceCharLimit ? `, evidence<=${evidenceCharLimit} chars` : ""}.`
      : null,
    computeTelemetryFields.length > 0
      ? `Log compute telemetry when available: ${computeTelemetryFields.join(", ")}.`
      : null,
    reasoningCandidateCount && reasoningCandidateCount > 1
      ? `Generate ${reasoningCandidateCount} bounded candidate approaches or failure hypotheses before committing to one path.`
      : taskKind === "research" || taskKind === "verification" || qualityPreference === "quality"
        ? "Generate 2-3 bounded candidate approaches or failure hypotheses before committing to one path."
        : null,
    reasoningSelectionStrategy === "evidence_rerank"
      ? "Rerank candidate paths by concrete evidence and contradiction risk, not style."
      : null,
    verifierScoreFields.length > 0
      ? `Score candidates on ${verifierScoreFields.join(", ")} before selecting the winner.`
      : null,
    shallowBranchSearch
      ? `Bounded branch search: expand up to ${branchCount ?? "the top"} branch(es)${branchDepth ? ` to depth ${branchDepth}` : ""}, then prune before execution.`
      : null,
    branchPruneSignals.length > 0
      ? `Prune branches with ${branchPruneSignals.join(", ")}; fall back to a single path when confidence is high.`
      : null,
    budgetForcing
      ? `Budget forcing: after the initial selection, spend ${budgetRevisionPasses} bounded revision pass(es) trying to disprove or improve it before finalizing.`
      : null,
    budgetRequiredFields.length > 0
      ? `Budget-forcing evidence must include ${budgetRequiredFields.join(", ")}.`
      : null,
    requirePlanPass || taskKind === "research" || focus === "implementation_research" || focus === "task_breakdown"
      ? "Write a short plan first so unknowns, evidence needs, and rollback are explicit before mutation."
      : null,
    requireVerificationPass || taskKind === "verification" || focus === "verification"
      ? "Try to falsify the current answer with concrete checks before declaring success."
      : null,
    orgSignals?.explicit_evidence === true
      ? "Choose the path with the strongest evidence trail, not the most fluent explanation."
      : null,
    orgSignals?.fail_closed === true
      ? "If evidence is weak or contradictory, stop and report the blocker instead of guessing."
      : null,
    transcriptPolicy === "compact_evidence_only"
      ? "Keep reasoning evidence compact; do not dump raw transcripts or hidden chains of thought."
      : null,
    verifierRequiredFields.length > 0
      ? `The selected candidate evidence must include ${verifierRequiredFields.join(", ")}.`
      : null,
  ]);
  return renderBulletSection("Reasoning policy", lines);
}

function describeMemoryGuidance(taskMetadata: Record<string, unknown>) {
  const memoryPreflight = readNullableRecord(taskMetadata.memory_preflight);
  const topReflections = Array.isArray(memoryPreflight?.top_reflections) ? memoryPreflight.top_reflections : [];
  if (topReflections.length === 0) {
    return renderBulletSection("Grounded reflections", []);
  }
  const lines = topReflections
    .flatMap((entry) => {
      const reflection = readNullableRecord(entry);
      if (!reflection) {
        return [];
      }
      const preview = readString(reflection.text_preview);
      const keywords = readStringArray(reflection.keywords);
      const suffix = keywords.length > 0 ? ` [keywords: ${keywords.join(", ")}]` : "";
      return preview ? [`${preview}${suffix}`] : [];
    })
    .slice(0, 3);
  return renderBulletSection("Grounded reflections", lines);
}

function compactBriefText(value: unknown, limit = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function describeWorkingMemory(taskMetadata: Record<string, unknown>) {
  const workingMemory = readNullableRecord(taskMetadata.working_memory);
  if (!workingMemory) {
    return renderBulletSection("Working memory", []);
  }
  const lines = uniqueStrings([
    readString(workingMemory.compression_policy)
      ? `Use compact state first: ${readString(workingMemory.compression_policy)}`
      : "Use compact state first; retrieve more context only when necessary.",
    readString(workingMemory.current_stream_id)
      ? `Current lane: ${readString(workingMemory.current_stream_id)}${readString(workingMemory.current_owner_role_id) ? ` owned by ${readString(workingMemory.current_owner_role_id)}` : ""}.`
      : null,
  ]);
  const expectedEvidence = readStringArray(workingMemory.expected_evidence).slice(0, 5);
  if (expectedEvidence.length > 0) {
    lines.push(`Expected evidence: ${expectedEvidence.map((entry) => compactBriefText(entry, 140)).join(" | ")}`);
  }
  const memoryBudget = readNullableRecord(workingMemory.memory_budget);
  if (memoryBudget) {
    lines.push(
      `Memory budget: evidence<=${String(memoryBudget.expected_evidence_limit ?? "n/a")} questions<=${String(memoryBudget.unresolved_question_limit ?? "n/a")} failures<=${String(memoryBudget.known_failure_limit ?? "n/a")} citations<=${String(memoryBudget.citation_limit ?? "n/a")}; transcript replay ${memoryBudget.transcript_replay_allowed === true ? "allowed" : "blocked"}.`
    );
  }
  const refreshTriggers = readStringArray(workingMemory.refresh_triggers).slice(0, 4);
  if (refreshTriggers.length > 0) {
    lines.push(`Refresh triggers: ${refreshTriggers.map((entry) => compactBriefText(entry, 140)).join(" | ")}`);
  }
  const unresolvedQuestions = readStringArray(workingMemory.unresolved_questions).slice(0, 5);
  if (unresolvedQuestions.length > 0) {
    lines.push(`Unresolved questions: ${unresolvedQuestions.map((entry) => compactBriefText(entry, 140)).join(" | ")}`);
  }
  const rollbackNotes = readStringArray(workingMemory.rollback_notes).slice(0, 4);
  if (rollbackNotes.length > 0) {
    lines.push(`Rollback posture: ${rollbackNotes.map((entry) => compactBriefText(entry, 140)).join(" | ")}`);
  }
  const knownFailures = Array.isArray(workingMemory.known_failures) ? workingMemory.known_failures : [];
  for (const entry of knownFailures.slice(0, 3)) {
    const failure = readNullableRecord(entry);
    if (!failure) {
      continue;
    }
    const preview = readString(failure.text_preview);
    const id = readString(failure.id) ?? "unknown";
    if (preview) {
      lines.push(`Known failure memory:${id}: ${compactBriefText(preview, 220)}`);
    }
  }
  return renderBulletSection("Working memory", lines);
}

function describeCompletionEvidenceHandoff(worktreePath: string, taskExecution: Record<string, unknown>) {
  const reasoningCandidateCount = resolveReasoningCandidateCount(taskExecution);
  const needsCandidateEvidence = reasoningCandidateCount !== null && reasoningCandidateCount > 1;
  const needsRerank = resolveReasoningSelectionStrategy(taskExecution) === "evidence_rerank";
  const needsPlan = taskExecution.require_plan_pass === true;
  const needsVerification = taskExecution.require_verification_pass === true;
  const planQualityGate = readNullableRecord(taskExecution.plan_quality_gate);
  const planQualityRequired = needsPlan && planQualityGate?.required === true;
  const planQualityRequiredFields = readStringArray(planQualityGate?.required_fields);
  const maxPlannedSteps =
    typeof planQualityGate?.max_planned_steps === "number" && Number.isFinite(planQualityGate.max_planned_steps)
      ? Math.max(1, Math.round(planQualityGate.max_planned_steps))
      : null;
  const taskKind = readString(taskExecution.task_kind);
  const qualityPreference = readString(taskExecution.quality_preference);
  const computePolicy = resolveReasoningComputePolicy(taskExecution);
  const policyEvidenceRequired = computePolicy?.evidence_required === true || readString(computePolicy?.mode) === "adaptive_best_of_n";
  const computeBudget = readNullableRecord(computePolicy?.compute_budget);
  const computeTelemetryFields = readStringArray(computeBudget?.telemetry_fields);
  const verifierRerank = readNullableRecord(computePolicy?.verifier_rerank);
  const verifierRequiredFields = readStringArray(verifierRerank?.required_selected_fields);
  const needsBranchSearch = resolveShallowBranchSearch(taskExecution) !== null;
  const needsBudgetForcing = resolveBudgetForcing(taskExecution) !== null;
  const qualityBiased = qualityPreference === "quality" && (taskKind === "research" || taskKind === "verification");
  if (
    !needsCandidateEvidence &&
    !needsRerank &&
    !needsPlan &&
    !needsVerification &&
    !needsBranchSearch &&
    !needsBudgetForcing &&
    !qualityBiased &&
    !policyEvidenceRequired
  ) {
    return renderBulletSection("Completion evidence handoff", []);
  }

  const evidencePath = path.join(worktreePath, ".mcp-runtime", "reasoning-evidence.json");
  const lines = [
    `Before exiting successfully, write ${evidencePath} so task.complete can carry audit evidence.`,
    "Use compact JSON; avoid transcripts or hidden reasoning dumps.",
  ];
  if (needsCandidateEvidence) {
    lines.push(`Include candidates or candidate_count showing at least ${reasoningCandidateCount} bounded candidates.`);
  }
  if (computeBudget?.telemetry_required === true || computeTelemetryFields.length > 0) {
    lines.push(
      `Include compute_usage when available with ${computeTelemetryFields.join(", ") || "latency_ms, token_usage, estimated_cost_usd"}; this is telemetry for compute ROI, not hidden reasoning.`
    );
  }
  if (needsRerank) {
    lines.push(
      "Include selected_candidate_id plus selection_rationale explaining why the chosen path beat alternatives by evidence and contradiction risk."
    );
  }
  if (verifierRequiredFields.length > 0) {
    lines.push(`Include verifier rerank fields for the selected path: ${verifierRequiredFields.join(", ")}.`);
  }
  if (needsBranchSearch) {
    lines.push("Include branch_search_summary or branch_evaluations showing which branches were expanded, pruned, and why.");
  }
  if (needsBudgetForcing) {
    lines.push("Include budget_forcing_review or forced_second_look showing the revision pass and whether the answer changed.");
  }
  if (needsPlan) {
    lines.push("Include plan_summary or planned_steps proving a plan pass happened before mutation.");
  }
  if (planQualityRequired) {
    lines.push(
      `Include plan_quality_gate with ${planQualityRequiredFields.join(", ") || "constraints_covered, rollback_noted, evidence_requirements_mapped"}${maxPlannedSteps ? ` and keep planned_steps<=${maxPlannedSteps}` : ""}.`
    );
  }
  if (needsVerification || qualityBiased) {
    lines.push("Include verification_summary, checks, test_results, or evidence_refs from concrete validation.");
  }
  return renderBulletSection("Completion evidence handoff", lines);
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function slugify(value: string) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function tmux(args: string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasTmuxSession(sessionName: string) {
  return tmux(["has-session", "-t", sessionName]).status === 0;
}

function readTmuxPaneCommand(sessionName: string) {
  const result = tmux(["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_current_command}"]);
  if (result.status !== 0) {
    return null;
  }
  return readString(result.stdout);
}

function captureTmuxPane(sessionName: string, lines = 40) {
  const result = tmux(["capture-pane", "-p", "-t", `${sessionName}:0.0`, "-S", `-${Math.max(10, lines)}`]);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-Math.max(1, lines));
}

function resolveExecutable(command: string, fallbackPaths: string[] = []) {
  const which = spawnSync("which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (which.status === 0) {
    return readString(which.stdout);
  }
  for (const candidate of fallbackPaths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRepoRoot(projectDir: string) {
  const resolved = path.resolve(projectDir);
  const gitRoot = spawnSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const repoRoot = gitRoot.status === 0 ? readString(gitRoot.stdout) ?? resolved : resolved;
  const isGitRepo = gitRoot.status === 0;
  const dirty =
    isGitRepo &&
    spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).stdout.trim().length > 0;
  return {
    repo_root: repoRoot,
    is_git_repo: isGitRepo,
    dirty,
  };
}

function ensureWorktreeLayout(input: {
  repo_root: string;
  session_id: string;
  runtime_id: RuntimeWorkerRuntimeId;
  project_dir: string;
}) {
  const repoRoot = path.resolve(input.repo_root);
  const repoName = path.basename(repoRoot) || "workspace";
  const root = path.join(path.dirname(repoRoot), ".mcp-runtime-worktrees", repoName);
  const sessionSlug = slugify(`${input.runtime_id}-${input.session_id}`) || input.session_id;
  const worktreePath = path.join(root, sessionSlug);
  const branchName = `master-mold/${input.runtime_id}/${sessionSlug}`;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  fs.rmSync(worktreePath, { recursive: true, force: true });

  const repoInfo = resolveRepoRoot(input.project_dir);
  if (repoInfo.is_git_repo && !repoInfo.dirty) {
    const added = spawnSync("git", ["-C", repoInfo.repo_root, "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (added.status === 0) {
      linkReusableDirs(repoInfo.repo_root, worktreePath);
      return {
        worktree_path: worktreePath,
        branch_name: branchName,
        isolation_mode: "git_worktree" as const,
      };
    }
  }

  fs.cpSync(repoInfo.repo_root, worktreePath, { recursive: true });
  if (repoInfo.is_git_repo) {
    spawnSync("git", ["-C", worktreePath, "checkout", "-b", branchName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return {
    worktree_path: worktreePath,
    branch_name: repoInfo.is_git_repo ? branchName : null,
    isolation_mode: "copy" as const,
  };
}

function linkReusableDirs(repoRoot: string, worktreePath: string) {
  for (const candidate of ["node_modules", ".venv"]) {
    const source = path.join(repoRoot, candidate);
    const destination = path.join(worktreePath, candidate);
    if (fs.existsSync(source) && !fs.existsSync(destination)) {
      fs.symlinkSync(source, destination);
    }
  }
}

function runtimeRequestFromTask(task: { metadata: Record<string, unknown> }): RuntimeRequest | null {
  const execution = isRecord(task.metadata.task_execution) ? task.metadata.task_execution : {};
  const runtimeId = readString(execution.runtime_id);
  const runtimeStrategy = readString(execution.runtime_strategy);
  if (!runtimeId || !runtimeStrategy) {
    return null;
  }
  if (runtimeId !== "codex" && runtimeId !== "shell") {
    return null;
  }
  if (runtimeStrategy !== "tmux_worktree") {
    return null;
  }
  return {
    runtime_id: runtimeId,
    runtime_strategy: "tmux_worktree",
    runtime_command: readString(execution.runtime_command),
  };
}

function isShellLike(command: string | null) {
  if (!command) {
    return false;
  }
  return ["zsh", "bash", "sh", "fish", "tmux"].includes(command);
}

function completionPathForRecord(record: RuntimeWorkerSessionRecord) {
  return (
    readString(isRecord(record.metadata) ? record.metadata.completion_path : null) ??
    path.join(record.worktree_path, ".mcp-runtime", "completion.json")
  );
}

function readRuntimeCompletion(record: RuntimeWorkerSessionRecord): RuntimeCompletionEnvelope | null {
  const completionPath = completionPathForRecord(record);
  if (!fs.existsSync(completionPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(completionPath, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    const taskId = readString(parsed.task_id);
    const workerId = readString(parsed.worker_id);
    const status = readString(parsed.status);
    const summary = readString(parsed.summary);
    if (!taskId || !workerId || !summary || (status !== "completed" && status !== "failed")) {
      return null;
    }
    return {
      task_id: taskId,
      worker_id: workerId,
      status,
      summary,
      error: readString(parsed.error) ?? undefined,
      result: isRecord(parsed.result) ? parsed.result : undefined,
    };
  } catch {
    return null;
  }
}

function reconcileRuntimeCompletion(storage: Storage, record: RuntimeWorkerSessionRecord) {
  const completion = readRuntimeCompletion(record);
  if (!completion || completion.task_id !== record.task_id || completion.worker_id !== record.worker_id) {
    return null;
  }
  const task = record.task_id ? storage.getTaskById(record.task_id) : null;
  if (!task) {
    return null;
  }
  if (task.status === "running" && task.lease?.owner_id === record.worker_id) {
    if (completion.status === "completed") {
      storage.completeTask({
        task_id: record.task_id!,
        worker_id: record.worker_id,
        result: completion.result,
        summary: completion.summary,
      });
    } else {
      storage.failTask({
        task_id: record.task_id!,
        worker_id: record.worker_id,
        error: completion.error ?? "Runtime worker command failed.",
        result: completion.result,
        summary: completion.summary,
      });
    }
  }
  const refreshedTask = record.task_id ? storage.getTaskById(record.task_id) : null;
  if (!refreshedTask || (refreshedTask.status !== "completed" && refreshedTask.status !== "failed")) {
    return null;
  }
  return storage.updateRuntimeWorkerSession({
    session_id: record.session_id,
    status: refreshedTask.status === "completed" ? "completed" : "failed",
    last_activity_at: new Date().toISOString(),
    last_error: refreshedTask.status === "failed" ? completion.error ?? refreshedTask.last_error ?? record.last_error : null,
  }).session;
}

function inspectLiveSession(storage: Storage, record: RuntimeWorkerSessionRecord) {
  const reconciled = reconcileRuntimeCompletion(storage, record) ?? record;
  const task = reconciled.task_id ? storage.getTaskById(reconciled.task_id) : null;
  const tmuxPresent = hasTmuxSession(reconciled.tmux_session_name);
  const paneCommand = tmuxPresent ? readTmuxPaneCommand(reconciled.tmux_session_name) : null;
  const paneExcerpt = tmuxPresent ? captureTmuxPane(reconciled.tmux_session_name, 30) : [];
  const worktreePresent = fs.existsSync(reconciled.worktree_path);
  const transcriptPresent = Boolean(reconciled.transcript_path && fs.existsSync(reconciled.transcript_path));

  let derivedStatus: RuntimeWorkerSessionStatus = reconciled.status;
  if (task?.status === "completed") {
    derivedStatus = "completed";
  } else if (task?.status === "failed") {
    derivedStatus = "failed";
  } else if (tmuxPresent) {
    derivedStatus = isShellLike(paneCommand) ? "idle" : "running";
  } else if (reconciled.status === "stopped") {
    derivedStatus = "stopped";
  } else if (reconciled.status === "launching" || reconciled.status === "running" || reconciled.status === "idle") {
    derivedStatus = "failed";
  }

  if (derivedStatus !== reconciled.status) {
    storage.updateRuntimeWorkerSession({
      session_id: reconciled.session_id,
      status: derivedStatus,
      last_activity_at: new Date().toISOString(),
      last_error:
        derivedStatus === "failed" && task?.status !== "failed"
          ? "tmux session exited before task completion"
          : reconciled.last_error,
    });
  }

  const latest = storage.getRuntimeWorkerSessionById(reconciled.session_id) ?? reconciled;
  return {
    ...latest,
    tmux_present: tmuxPresent,
    pane_command: paneCommand,
    worktree_present: worktreePresent,
    transcript_present: transcriptPresent,
    task_status: task?.status ?? null,
    pane_excerpt: paneExcerpt,
  } satisfies LiveRuntimeWorkerSession;
}

function buildSessionBrief(input: {
  session_id: string;
  task_id: string;
  runtime_id: RuntimeWorkerRuntimeId;
  objective: string;
  worktree_path: string;
  task_payload: Record<string, unknown>;
  task_metadata: Record<string, unknown>;
  plan_id?: string | null;
  step_id?: string | null;
  step_title?: string | null;
  step_owner?: string | null;
  step_acceptance_checks?: string[];
  step_evidence_requirements?: string[];
  step_rollback_notes?: string[];
}) {
  const delegationBrief = extractDelegationBrief({
    payload: input.task_payload,
    metadata: input.task_metadata,
  });
  const effectiveObjective = delegationBrief.task_objective ?? input.objective;
  const taskExecution = readNullableRecord(input.task_metadata.task_execution) ?? {};
  const routingLines = [
    readString(taskExecution.task_kind) ? `- task_kind: ${String(taskExecution.task_kind)}` : null,
    readString(taskExecution.selected_backend_id)
      ? `- selected_backend_id: ${String(taskExecution.selected_backend_id)}`
      : null,
    readString(taskExecution.selected_host_id) ? `- selected_host_id: ${String(taskExecution.selected_host_id)}` : null,
    readString(taskExecution.selected_worker_host_id)
      ? `- selected_worker_host_id: ${String(taskExecution.selected_worker_host_id)}`
      : null,
    readString(taskExecution.isolation_mode) ? `- isolation_mode: ${String(taskExecution.isolation_mode)}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return [
    `Session: ${input.session_id}`,
    `Task: ${input.task_id}`,
    `Runtime: ${input.runtime_id}`,
    `Plan: ${input.plan_id ?? "n/a"}`,
    `Step: ${input.step_id ?? "n/a"}${input.step_title ? ` (${input.step_title})` : ""}`,
    `Owner: ${input.step_owner ?? "n/a"}`,
    `Delegate: ${delegationBrief.delegate_agent_id ?? "n/a"}`,
    "",
    "Rules:",
    "- Work only inside this isolated worktree.",
    "- Make the smallest complete change necessary.",
    "- Run concrete verification when feasible.",
    "- If blocked, fail clearly instead of guessing.",
    "",
    "Objective:",
    effectiveObjective,
    "",
    renderBulletSection("Success criteria", [
      ...delegationBrief.success_criteria,
      ...(input.step_acceptance_checks ?? []),
    ]),
    "",
    renderBulletSection("Evidence requirements", [
      ...delegationBrief.evidence_requirements,
      ...(input.step_evidence_requirements ?? []),
    ]),
    "",
    renderBulletSection("Rollback notes", [
      ...delegationBrief.rollback_notes,
      ...(input.step_rollback_notes ?? []),
    ]),
    "",
    describeReasoningPolicy(input.task_metadata, taskExecution),
    "",
    describeMemoryGuidance(input.task_metadata),
    "",
    describeWorkingMemory(input.task_metadata),
    "",
    describeCompletionEvidenceHandoff(input.worktree_path, taskExecution),
    "",
    "Execution routing:",
    ...(routingLines.length > 0 ? routingLines : ["- none"]),
    "",
    `Worktree: ${input.worktree_path}`,
  ].join("\n");
}

function buildRuntimeExecutionCommand(input: {
  runtime_id: RuntimeWorkerRuntimeId;
  objective: string;
  brief_path: string;
  worktree_path: string;
  runtime_command: string | null;
}) {
  if (input.runtime_id === "shell") {
    if (input.runtime_command) {
      return input.runtime_command;
    }
    return `printf '%s\\n' ${shellQuote(input.objective)}`;
  }

  const executable =
    readString(process.env.TRICHAT_CODEX_EXECUTABLE) ??
    resolveExecutable("codex", ["/Applications/Codex.app/Contents/Resources/codex"]);
  if (!executable) {
    throw new Error("codex executable is not available for runtime worker launch");
  }
  return `${shellQuote(executable)} exec --skip-git-repo-check --cd ${shellQuote(input.worktree_path)} "$(cat ${shellQuote(
    input.brief_path
  )})"`;
}

function writeRuntimeWrapper(input: {
  worktree_path: string;
  task_id: string;
  session_id: string;
  transcript_path: string;
  completion_path: string;
  runtime_command: string;
}) {
  const runtimeDir = path.join(input.worktree_path, ".mcp-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const wrapperPath = path.join(runtimeDir, "run-task.sh");
  const evidencePath = path.join(runtimeDir, "reasoning-evidence.json");
  const evidenceMergePath = path.join(runtimeDir, "merge-completion-evidence.mjs");
  const completeArgsBasePath = path.join(runtimeDir, "task-complete-base.json");
  const completeEnvelopeBasePath = path.join(runtimeDir, "completion-base.json");
  const httpUrl = readString(process.env.TRICHAT_MCP_URL);
  const httpOrigin = readString(process.env.TRICHAT_MCP_ORIGIN) ?? "http://127.0.0.1";
  if (!fs.existsSync(controlPlaneHelperPath)) {
    throw new Error(`control-plane helper is not available at ${controlPlaneHelperPath}`);
  }
  const stdioAvailable = fs.existsSync(controlPlaneServerPath);
  const completeArgs = JSON.stringify({
    mutation: {
      idempotency_key: `runtime-worker-complete-${input.session_id}`,
      side_effect_fingerprint: `runtime-worker-complete:${input.task_id}:${input.session_id}`,
    },
    task_id: input.task_id,
    worker_id: input.session_id,
    summary: "Runtime worker completed the linked task.",
    result: {
      runtime_worker_session_id: input.session_id,
      transcript_path: input.transcript_path,
      status: "completed",
    },
  });
  const failArgs = JSON.stringify({
    mutation: {
      idempotency_key: `runtime-worker-fail-${input.session_id}`,
      side_effect_fingerprint: `runtime-worker-fail:${input.task_id}:${input.session_id}`,
    },
    task_id: input.task_id,
    worker_id: input.session_id,
    error: "Runtime worker command failed.",
    summary: "Runtime worker failed the linked task.",
    result: {
      runtime_worker_session_id: input.session_id,
      transcript_path: input.transcript_path,
      status: "failed",
    },
  });
  const completeEnvelope = JSON.stringify({
    task_id: input.task_id,
    worker_id: input.session_id,
    status: "completed",
    summary: "Runtime worker completed the linked task.",
    result: {
      runtime_worker_session_id: input.session_id,
      transcript_path: input.transcript_path,
      status: "completed",
    },
  });
  fs.writeFileSync(completeArgsBasePath, completeArgs, "utf8");
  fs.writeFileSync(completeEnvelopeBasePath, completeEnvelope, "utf8");
  fs.writeFileSync(
    evidenceMergePath,
    `import fs from "node:fs";

const [basePath, evidencePath] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const result = base.result && typeof base.result === "object" && !Array.isArray(base.result) ? base.result : {};
if (evidencePath && fs.existsSync(evidencePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      base.result = {
        ...result,
        reasoning_policy_evidence: parsed,
        reasoning_policy_evidence_path: evidencePath,
      };
    }
  } catch (error) {
    base.result = {
      ...result,
      reasoning_policy_evidence_error: error instanceof Error ? error.message : String(error),
      reasoning_policy_evidence_path: evidencePath,
    };
  }
}
process.stdout.write(JSON.stringify(base));
`,
    "utf8"
  );
  const failEnvelope = JSON.stringify({
    task_id: input.task_id,
    worker_id: input.session_id,
    status: "failed",
    summary: "Runtime worker failed the linked task.",
    error: "Runtime worker command failed.",
    result: {
      runtime_worker_session_id: input.session_id,
      transcript_path: input.transcript_path,
      status: "failed",
    },
  });
  const content = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(input.worktree_path)}
export PATH="${input.worktree_path}/node_modules/.bin:${input.worktree_path}/.venv/bin:$PATH"
call_control_plane() {
  local tool_name="$1"
  local args_json="$2"
  ${
    httpUrl
      ? `if node ${shellQuote(controlPlaneHelperPath)} --tool "$tool_name" --args "$args_json" --transport http --url ${shellQuote(
          httpUrl
        )} --origin ${shellQuote(httpOrigin)} --cwd ${shellQuote(controlPlaneRepoRoot)} >> ${shellQuote(input.transcript_path)} 2>&1; then
    return 0
  fi`
      : ""
  }
  ${
    stdioAvailable
      ? `TRICHAT_BUS_AUTOSTART=0 MCP_AUTONOMY_BOOTSTRAP_ON_START=0 MCP_AUTONOMY_MAINTAIN_ON_START=0 TRICHAT_RING_LEADER_AUTOSTART=0 node ${shellQuote(
          controlPlaneHelperPath
        )} --tool "$tool_name" --args "$args_json" --transport stdio --stdio-command node --stdio-args ${shellQuote(
          controlPlaneServerPath
        )} --cwd ${shellQuote(controlPlaneRepoRoot)} >> ${shellQuote(input.transcript_path)} 2>&1`
      : "return 1"
  }
}
set +e
${input.runtime_command}
status=$?
set -e
if [ "$status" -eq 0 ]; then
  complete_envelope_json="$(node ${shellQuote(evidenceMergePath)} ${shellQuote(completeEnvelopeBasePath)} ${shellQuote(evidencePath)})"
  complete_args_json="$(node ${shellQuote(evidenceMergePath)} ${shellQuote(completeArgsBasePath)} ${shellQuote(evidencePath)})"
  printf '%s\n' "$complete_envelope_json" > ${shellQuote(input.completion_path)}
  call_control_plane task.complete "$complete_args_json" || true
else
  printf '%s\n' ${shellQuote(failEnvelope)} > ${shellQuote(input.completion_path)}
  call_control_plane task.fail ${shellQuote(
    failArgs
  )} || true
fi
exit "$status"
`;
  fs.writeFileSync(wrapperPath, content, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function startTmuxRuntimeSession(input: {
  session_name: string;
  worktree_path: string;
  transcript_path: string;
  wrapper_path: string;
}) {
  if (hasTmuxSession(input.session_name)) {
    tmux(["kill-session", "-t", input.session_name]);
  }
  const create = tmux(["new-session", "-d", "-s", input.session_name, "-c", input.worktree_path, "/bin/zsh"]);
  if (create.status !== 0) {
    throw new Error(readString(create.stderr) ?? `failed to start tmux session ${input.session_name}`);
  }
  const pipe = tmux(["pipe-pane", "-o", "-t", `${input.session_name}:0.0`, `cat >> ${shellQuote(input.transcript_path)}`]);
  if (pipe.status !== 0) {
    throw new Error(readString(pipe.stderr) ?? `failed to attach transcript pipe to ${input.session_name}`);
  }
  const send = tmux(["send-keys", "-t", `${input.session_name}:0.0`, `/bin/bash ${shellQuote(input.wrapper_path)}`, "C-m"]);
  if (send.status !== 0) {
    throw new Error(readString(send.stderr) ?? `failed to send runtime command to ${input.session_name}`);
  }
}

function spawnForTask(storage: Storage, input: {
  task_id: string;
  runtime_id?: RuntimeWorkerRuntimeId;
  runtime_strategy?: "tmux_worktree";
  lease_seconds?: number;
  source_client?: string;
  source_model?: string;
  source_agent?: string;
}) {
  const task = storage.getTaskById(input.task_id);
  if (!task) {
    throw new Error(`Task not found: ${input.task_id}`);
  }
  const runtimeRequest = runtimeRequestFromTask(task) ?? {
    runtime_id: input.runtime_id ?? "codex",
    runtime_strategy: input.runtime_strategy ?? "tmux_worktree",
    runtime_command: null,
  };
  const existing = storage.getLatestRuntimeWorkerSessionForTask(task.task_id);
  if (existing && (existing.status === "launching" || existing.status === "running" || existing.status === "idle")) {
    return {
      created: false,
      reason: "existing-session",
      session: inspectLiveSession(storage, existing),
      task,
    };
  }

  const sessionId = crypto.randomUUID();
  const repoInfo = resolveRepoRoot(task.project_dir);
  const layout = ensureWorktreeLayout({
    repo_root: repoInfo.repo_root,
    session_id: sessionId,
    runtime_id: runtimeRequest.runtime_id,
    project_dir: task.project_dir,
  });
  const runtimeDir = path.join(layout.worktree_path, ".mcp-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const briefPath = path.join(runtimeDir, "session_brief.md");
  const transcriptPath = path.join(runtimeDir, "transcript.log");
  const completionPath = path.join(runtimeDir, "completion.json");
  const planStep = storage.findPlanStepByTaskId(task.task_id);
  fs.writeFileSync(
    briefPath,
    buildSessionBrief({
      session_id: sessionId,
      task_id: task.task_id,
      runtime_id: runtimeRequest.runtime_id,
      objective: task.objective,
      worktree_path: layout.worktree_path,
      task_payload: task.payload,
      task_metadata: task.metadata,
      plan_id: planStep?.plan.plan_id ?? null,
      step_id: planStep?.step.step_id ?? null,
      step_title: planStep?.step.title ?? null,
      step_owner: planStep?.step.executor_ref ?? null,
      step_acceptance_checks: planStep?.step.acceptance_checks ?? [],
      step_evidence_requirements: readStringArray(planStep?.step.input.evidence_requirements),
      step_rollback_notes: readStringArray(planStep?.step.input.rollback_notes),
    }),
    "utf8"
  );
  fs.writeFileSync(transcriptPath, `[runtime-worker] session=${sessionId} task=${task.task_id} created_at=${new Date().toISOString()}\n`, "utf8");

  const workerId = sessionId;
  const claimResult =
    task.status === "running" && task.lease?.owner_id === workerId
      ? { claimed: true, reason: "already-claimed", task, lease_expires_at: task.lease?.lease_expires_at }
      : storage.claimTask({
          task_id: task.task_id,
          worker_id: workerId,
          lease_seconds: input.lease_seconds ?? 7200,
        });
  if (!claimResult.claimed) {
    throw new Error(`Task ${task.task_id} could not be claimed for runtime worker launch: ${claimResult.reason}`);
  }
  const created = storage.createRuntimeWorkerSession({
    session_id: sessionId,
    runtime_id: runtimeRequest.runtime_id,
    status: "launching",
    task_id: task.task_id,
    goal_id: planStep?.plan.goal_id ?? null,
    plan_id: planStep?.plan.plan_id ?? null,
    step_id: planStep?.step.step_id ?? null,
    worker_id: workerId,
    title: task.objective.slice(0, 120),
    objective: task.objective,
    repo_root: repoInfo.repo_root,
    project_dir: task.project_dir,
    worktree_path: layout.worktree_path,
    branch_name: layout.branch_name,
    tmux_session_name: `mcpr-${slugify(sessionId).slice(0, 24)}`,
    transcript_path: transcriptPath,
    brief_path: briefPath,
    metadata: {
      runtime_strategy: runtimeRequest.runtime_strategy,
      runtime_command: runtimeRequest.runtime_command,
      isolation_mode: layout.isolation_mode,
      lease_expires_at: claimResult.lease_expires_at ?? null,
      completion_path: completionPath,
      reasoning_policy_evidence_path: path.join(runtimeDir, "reasoning-evidence.json"),
    },
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });

  try {
    const runtimeCommand = buildRuntimeExecutionCommand({
      runtime_id: runtimeRequest.runtime_id,
      objective: task.objective,
      brief_path: briefPath,
      worktree_path: layout.worktree_path,
      runtime_command: runtimeRequest.runtime_command,
    });
    const wrapperPath = writeRuntimeWrapper({
      worktree_path: layout.worktree_path,
      task_id: task.task_id,
      session_id: created.session.session_id,
      transcript_path: transcriptPath,
      completion_path: completionPath,
      runtime_command: runtimeCommand,
    });
    startTmuxRuntimeSession({
      session_name: created.session.tmux_session_name,
      worktree_path: layout.worktree_path,
      transcript_path: transcriptPath,
      wrapper_path: wrapperPath,
    });
    const updated = storage.updateRuntimeWorkerSession({
      session_id: created.session.session_id,
      status: "running",
      last_command_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      metadata: {
        wrapper_path: wrapperPath,
      },
    });
    return {
      created: true,
      reason: "spawned",
      session: inspectLiveSession(storage, updated.session),
      task: storage.getTaskById(task.task_id) ?? task,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    storage.updateRuntimeWorkerSession({
      session_id: created.session.session_id,
      status: "failed",
      last_error: message,
      last_activity_at: new Date().toISOString(),
    });
    storage.failTask({
      task_id: task.task_id,
      worker_id: workerId,
      error: message,
      summary: "Runtime worker launch failed before execution could begin.",
    });
    throw error;
  }
}

function summarizeSessions(sessions: LiveRuntimeWorkerSession[]) {
  const counts: Record<RuntimeWorkerSessionStatus, number> = {
    launching: 0,
    running: 0,
    idle: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
  };
  const runtimeCounts: Record<string, number> = {};
  for (const session of sessions) {
    counts[session.status] += 1;
    runtimeCounts[session.runtime_id] = (runtimeCounts[session.runtime_id] ?? 0) + 1;
  }
  return {
    session_count: sessions.length,
    counts,
    runtime_counts: runtimeCounts,
    active_count: counts.launching + counts.running + counts.idle,
  };
}

export function listLiveRuntimeWorkerSessions(storage: Storage, limit = 20) {
  return storage
    .listRuntimeWorkerSessions({ limit: Math.max(1, Math.min(100, limit)) })
    .map((session) => inspectLiveSession(storage, session));
}

export function summarizeLiveRuntimeWorkers(storage: Storage, limit = 20) {
  const sessions = listLiveRuntimeWorkerSessions(storage, limit);
  return {
    count: sessions.length,
    sessions,
    summary: {
      ...summarizeSessions(sessions),
      latest_session: sessions[0] ?? null,
    },
  };
}

function availableRuntimes() {
  const codexExecutable =
    readString(process.env.TRICHAT_CODEX_EXECUTABLE) ??
    resolveExecutable("codex", ["/Applications/Codex.app/Contents/Resources/codex"]);
  return [
    {
      runtime_id: "codex",
      available: Boolean(codexExecutable),
      executable: codexExecutable,
    },
    {
      runtime_id: "shell",
      available: true,
      executable: "/bin/sh",
    },
  ];
}

async function spawnTaskMutation(storage: Storage, input: z.infer<typeof runtimeWorkerSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "runtime.worker.spawn_task",
    mutation: input.mutation!,
    payload: input,
    execute: () =>
      spawnForTask(storage, {
        task_id: input.task_id!,
        runtime_id: input.runtime_id,
        runtime_strategy: input.runtime_strategy,
        lease_seconds: input.lease_seconds,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

async function spawnPendingMutation(storage: Storage, input: z.infer<typeof runtimeWorkerSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "runtime.worker.spawn_pending",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const pending = storage.listTasks({ status: "pending", limit: Math.max(4, (input.limit ?? 8) * 4) });
      const existing = storage
        .listRuntimeWorkerSessions({ limit: 100 })
        .filter((session) => session.status === "launching" || session.status === "running" || session.status === "idle");
      const maxActive = Math.max(1, Math.min(8, input.max_active_sessions ?? 2));
      const availableSlots = Math.max(0, maxActive - existing.length);
      const createdSessions: Array<Record<string, unknown>> = [];
      const skipped: Array<{ task_id: string; reason: string }> = [];
      if (availableSlots <= 0) {
        return {
          created_count: 0,
          sessions: [],
          skipped: [{ task_id: "", reason: "no-active-runtime-capacity" }],
          active_count: existing.length,
        };
      }
      for (const task of pending) {
        if (createdSessions.length >= Math.min(input.limit ?? 2, availableSlots)) {
          break;
        }
        const runtimeRequest = runtimeRequestFromTask(task);
        if (!runtimeRequest) {
          skipped.push({ task_id: task.task_id, reason: "no-runtime-request" });
          continue;
        }
        const latest = storage.getLatestRuntimeWorkerSessionForTask(task.task_id);
        if (latest && (latest.status === "launching" || latest.status === "running" || latest.status === "idle")) {
          skipped.push({ task_id: task.task_id, reason: "existing-session" });
          continue;
        }
        const spawned = spawnForTask(storage, {
          task_id: task.task_id,
          runtime_id: runtimeRequest.runtime_id,
          runtime_strategy: runtimeRequest.runtime_strategy,
          lease_seconds: input.lease_seconds,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        createdSessions.push(spawned.session);
      }
      return {
        created_count: createdSessions.length,
        sessions: createdSessions,
        skipped,
        active_count: existing.length + createdSessions.length,
      };
    },
  });
}

async function stopMutation(storage: Storage, input: z.infer<typeof runtimeWorkerSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "runtime.worker.stop",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const session = storage.getRuntimeWorkerSessionById(input.session_id!);
      if (!session) {
        throw new Error(`Runtime worker session not found: ${input.session_id}`);
      }
      if (hasTmuxSession(session.tmux_session_name)) {
        tmux(["kill-session", "-t", session.tmux_session_name]);
      }
      const task = session.task_id ? storage.getTaskById(session.task_id) : null;
      if (task?.status === "running" && task.lease?.owner_id === session.worker_id) {
        storage.failTask({
          task_id: task.task_id,
          worker_id: session.worker_id,
          error: "Runtime worker stopped by operator.",
          summary: "Runtime worker was stopped before task completion.",
        });
      }
      if (input.cleanup_worktree === true && fs.existsSync(session.worktree_path)) {
        fs.rmSync(session.worktree_path, { recursive: true, force: true });
      }
      const updated = storage.updateRuntimeWorkerSession({
        session_id: session.session_id,
        status: "stopped",
        last_activity_at: new Date().toISOString(),
        last_error: task?.status === "running" ? "stopped by operator" : session.last_error,
      });
      return {
        ok: true,
        session: inspectLiveSession(storage, updated.session),
      };
    },
  });
}

export async function runtimeWorker(storage: Storage, input: z.infer<typeof runtimeWorkerSchema>) {
  if (input.action === "spawn_task") {
    return spawnTaskMutation(storage, input);
  }
  if (input.action === "spawn_pending") {
    return spawnPendingMutation(storage, input);
  }
  if (input.action === "stop") {
    return stopMutation(storage, input);
  }

  const sessions = listLiveRuntimeWorkerSessions(storage, input.limit ?? 20);
  const specific = input.session_id ? sessions.find((session) => session.session_id === input.session_id) ?? null : null;
  return {
    summary: summarizeSessions(sessions),
    sessions,
    session: specific,
    runtimes: availableRuntimes(),
  };
}
