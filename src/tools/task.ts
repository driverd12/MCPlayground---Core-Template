import { z } from "zod";
import { Storage, type TaskRecord } from "../storage.js";
import { buildBudgetUsageFromBudget, mergeDeclaredPermissionProfile, recordBudgetLedgerUsage } from "../control_plane_runtime.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { ensureWorkspaceFingerprint } from "./workspace_fingerprint.js";
import { budgetUsageSchema } from "./control_plane_admin.js";

const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
const isolationModeSchema = z.enum(["git_worktree", "copy", "none"]);
const routeTaskKindSchema = z.enum(["planning", "coding", "research", "verification", "chat", "tool_use"]);
const qualityPreferenceSchema = z.enum(["speed", "balanced", "quality", "cost"]);
const sourceSchema = z.object({
  source: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const taskRoutingSchema = z.object({
  preferred_agent_ids: z.array(z.string().min(1)).optional(),
  allowed_agent_ids: z.array(z.string().min(1)).optional(),
  preferred_client_kinds: z.array(z.string().min(1)).optional(),
  allowed_client_kinds: z.array(z.string().min(1)).optional(),
  required_capabilities: z.array(z.string().min(1)).optional(),
  preferred_capabilities: z.array(z.string().min(1)).optional(),
});

const taskExecutionCandidateSchema = z.object({
  backend_id: z.string().min(1),
  provider: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  node_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  score: z.number().optional(),
});

const reasoningComputePolicySchema = z.object({
  mode: z.enum(["single_path", "adaptive_best_of_n"]).optional(),
  candidate_count: z.number().int().min(1).max(4).optional(),
  max_candidate_count: z.number().int().min(1).max(4).optional(),
  selection_strategy: z.enum(["single_path", "evidence_rerank"]).optional(),
  activation_reasons: z.array(z.string().min(1)).optional(),
  evidence_required: z.boolean().optional(),
  transcript_policy: z.string().min(1).optional(),
  verifier_rerank: z.record(z.unknown()).optional(),
  shallow_branch_search: z
    .object({
      enabled: z.boolean().optional(),
      max_depth: z.number().int().min(1).max(3).optional(),
      branch_count: z.number().int().min(1).max(4).optional(),
      expand_policy: z.string().min(1).optional(),
      prune_with: z.array(z.string().min(1)).optional(),
      fallback: z.string().min(1).optional(),
    })
    .optional(),
});

export const taskExecutionSchema = z.object({
  preferred_host_ids: z.array(z.string().min(1)).optional(),
  allowed_host_ids: z.array(z.string().min(1)).optional(),
  preferred_host_tags: z.array(z.string().min(1)).optional(),
  required_host_tags: z.array(z.string().min(1)).optional(),
  preferred_backend_ids: z.array(z.string().min(1)).optional(),
  required_backend_ids: z.array(z.string().min(1)).optional(),
  preferred_model_tags: z.array(z.string().min(1)).optional(),
  required_model_tags: z.array(z.string().min(1)).optional(),
  isolation_mode: isolationModeSchema.optional(),
  task_kind: routeTaskKindSchema.optional(),
  quality_preference: qualityPreferenceSchema.optional(),
  selected_backend_id: z.string().min(1).optional(),
  selected_backend_provider: z.string().min(1).optional(),
  selected_backend_locality: z.enum(["local", "remote"]).optional(),
  selected_host_id: z.string().min(1).optional(),
  selected_worker_host_id: z.string().min(1).optional(),
  routed_bridge_agent_ids: z.array(z.string().min(1)).optional(),
  planned_backend_candidates: z.array(taskExecutionCandidateSchema).optional(),
  focus: z.string().min(1).optional(),
  reasoning_candidate_count: z.number().int().min(1).max(4).optional(),
  reasoning_selection_strategy: z.enum(["single_path", "evidence_rerank"]).optional(),
  reasoning_compute_policy: reasoningComputePolicySchema.optional(),
  require_plan_pass: z.boolean().optional(),
  require_verification_pass: z.boolean().optional(),
  runtime_id: z.enum(["codex", "shell"]).optional(),
  runtime_strategy: z.enum(["tmux_worktree"]).optional(),
  runtime_command: z.string().min(1).optional(),
});

export const taskCreateSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1).max(200).optional(),
  objective: z.string().min(1),
  project_dir: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
  budget: z.record(z.unknown()).optional(),
  permission_profile: z.enum(["read_only", "bounded_execute", "network_enabled", "high_risk"]).optional(),
  routing: taskRoutingSchema.optional(),
  task_execution: taskExecutionSchema.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  available_at: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const taskListSchema = z.object({
  status: taskStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const taskTimelineSchema = z.object({
  task_id: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});

export const taskSummarySchema = z.object({
  running_limit: z.number().int().min(1).max(200).optional(),
});

export const taskClaimSchema = z.object({
  mutation: mutationSchema,
  worker_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  task_id: z.string().min(1).optional(),
});

export const taskHeartbeatSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
});

export const taskCompleteSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
  usage: budgetUsageSchema.optional(),
});

export const taskFailSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  error: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
  usage: budgetUsageSchema.optional(),
});

export const taskRetrySchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  delay_seconds: z.number().int().min(0).max(86400).optional(),
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

export const taskRecoverExpiredSchema = z.object({
  mutation: mutationSchema,
  limit: z.number().int().min(1).max(500).optional(),
  ...sourceSchema.shape,
});

export const taskAutoRetrySchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    batch_limit: z.number().int().min(1).max(500).optional(),
    base_delay_seconds: z.number().int().min(0).max(86400).optional(),
    max_delay_seconds: z.number().int().min(0).max(604800).optional(),
    run_immediately: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, and run_once actions",
        path: ["mutation"],
      });
    }
  });

type TaskAutoRetryConfig = {
  interval_seconds: number;
  batch_limit: number;
  base_delay_seconds: number;
  max_delay_seconds: number;
};

type TaskAutoRetryRunResult = {
  task_id: string;
  attempt_count: number;
  max_attempts: number;
  delay_seconds: number;
  retried: boolean;
  reason?: string;
  error?: string;
};

type TaskAutoRetryTickResult = {
  completed_at: string;
  failed_seen: number;
  retried_count: number;
  skipped_count: number;
  run_results: TaskAutoRetryRunResult[];
  skipped?: boolean;
  reason?: string;
};

const DEFAULT_TASK_AUTO_RETRY_CONFIG: TaskAutoRetryConfig = {
  interval_seconds: 60,
  batch_limit: 20,
  base_delay_seconds: 30,
  max_delay_seconds: 3600,
};

export type TaskExecutionProfile = {
  complexity: "low" | "medium" | "high";
  requires_agent_session: boolean;
  signals: string[];
};

const taskAutoRetryRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TaskAutoRetryConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  total_failed_seen: number;
  total_retried: number;
  total_skipped: number;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_TASK_AUTO_RETRY_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  total_failed_seen: 0,
  total_retried: 0,
  total_skipped: 0,
};

export function initializeTaskAutoRetryDaemon(storage: Storage) {
  const persisted = storage.getTaskAutoRetryState();
  if (!persisted) {
    taskAutoRetryRuntime.config = { ...DEFAULT_TASK_AUTO_RETRY_CONFIG };
    stopTaskAutoRetryDaemon();
    return {
      restored: false,
      running: false,
      config: { ...taskAutoRetryRuntime.config },
    };
  }

  taskAutoRetryRuntime.config = resolveTaskAutoRetryConfig(persisted, DEFAULT_TASK_AUTO_RETRY_CONFIG);
  if (persisted.enabled) {
    startTaskAutoRetryDaemon(storage);
  } else {
    stopTaskAutoRetryDaemon();
  }

  return {
    restored: true,
    running: taskAutoRetryRuntime.running,
    config: { ...taskAutoRetryRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export async function taskCreate(storage: Storage, input: z.infer<typeof taskCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.create",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const normalizedTaskExecution = normalizeTaskExecutionMetadata({
        ...(isRecord(input.metadata?.task_execution) ? input.metadata.task_execution : {}),
        ...(input.task_execution ?? {}),
      });
      const initialMetadata: Record<string, unknown> = {
        ...(input.metadata ?? {}),
        ...(input.budget
          ? {
              budget: input.budget,
            }
          : {}),
      };
      const metadata: Record<string, unknown> = mergeDeclaredPermissionProfile(initialMetadata, input.permission_profile);
      Object.assign(metadata, {
        ...(normalizedTaskExecution
          ? {
              task_execution: normalizedTaskExecution,
            }
          : {}),
        ...(input.routing
          ? {
              task_routing: {
                preferred_agent_ids: dedupeStrings(input.routing.preferred_agent_ids),
                allowed_agent_ids: dedupeStrings(input.routing.allowed_agent_ids),
                preferred_client_kinds: dedupeStrings(input.routing.preferred_client_kinds),
                allowed_client_kinds: dedupeStrings(input.routing.allowed_client_kinds),
                required_capabilities: dedupeStrings(input.routing.required_capabilities),
                preferred_capabilities: dedupeStrings(input.routing.preferred_capabilities),
              },
            }
          : {}),
      });
      metadata.task_profile = resolveTaskExecutionProfile({
        objective: input.objective,
        project_dir: input.project_dir ?? ".",
        payload: input.payload ?? {},
        tags: input.tags ?? [],
        metadata,
      });
      const task = storage.createTask({
        task_id: input.task_id,
        objective: input.objective,
        project_dir: input.project_dir ?? ".",
        payload: input.payload,
        priority: input.priority,
        max_attempts: input.max_attempts,
        available_at: input.available_at,
        source: input.source,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        tags: input.tags,
        metadata,
      });
      const modelRouter = isRecord(metadata.model_router) ? metadata.model_router : {};
      const route = isRecord(modelRouter.route) ? modelRouter.route : {};
      const selectedBackend = isRecord(route.selected_backend) ? route.selected_backend : {};
      const projectionUsage = buildBudgetUsageFromBudget({
        budget: input.budget ?? (isRecord(metadata.budget) ? metadata.budget : null),
        metadata,
        provider: readString(selectedBackend.provider) ?? normalizedTaskExecution?.selected_backend_provider ?? null,
        model_id: readString(selectedBackend.model_id) ?? normalizedTaskExecution?.selected_backend_id ?? null,
        notes: "Task budget projection",
      });
      if (projectionUsage) {
        recordBudgetLedgerUsage(storage, {
          ledger_kind: "projection",
          usage: projectionUsage,
          entity_type: "task",
          entity_id: task.task.task_id,
          task_id: task.task.task_id,
          provider: projectionUsage.provider,
          model_id: projectionUsage.model_id,
          metadata: {
            task_objective: task.task.objective,
            permission_profile: metadata.permission_profile ?? null,
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
      }
      ensureWorkspaceFingerprint(storage, input.project_dir ?? ".", {
        source: "task.create",
      });
      return task;
    },
  });
}

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return dedupeStrings(value.filter((item): item is string => typeof item === "string"));
}

function normalizeTaskProfile(value: unknown): TaskExecutionProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  const complexity = readString(value.complexity);
  if (complexity !== "low" && complexity !== "medium" && complexity !== "high") {
    return null;
  }
  return {
    complexity,
    requires_agent_session: value.requires_agent_session !== false,
    signals: normalizeStringArray(value.signals),
  };
}

function normalizeTaskExecutionMetadata(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const isolationRaw = readString(value.isolation_mode);
  const isolation_mode =
    isolationRaw === "copy" || isolationRaw === "none" || isolationRaw === "git_worktree"
      ? isolationRaw
      : "git_worktree";
  const selected_backend_locality = readString(value.selected_backend_locality);
  const task_kind = readString(value.task_kind);
  const quality_preference = readString(value.quality_preference);
  const reasoning_selection_strategy = readString(value.reasoning_selection_strategy);
  const reasoning_candidate_count =
    typeof value.reasoning_candidate_count === "number" && Number.isFinite(value.reasoning_candidate_count)
      ? Math.max(1, Math.min(4, Math.round(value.reasoning_candidate_count)))
      : null;
  const runtime_id = readString(value.runtime_id);
  const runtime_strategy = readString(value.runtime_strategy);
  const planned_backend_candidates = Array.isArray(value.planned_backend_candidates)
    ? value.planned_backend_candidates
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const backend_id = readString(entry.backend_id);
          if (!backend_id) {
            return null;
          }
          return {
            backend_id,
            provider: readString(entry.provider) ?? null,
            host_id: readString(entry.host_id) ?? null,
            node_id: readString(entry.node_id) ?? null,
            title: readString(entry.title) ?? null,
            score: typeof entry.score === "number" && Number.isFinite(entry.score) ? Number(entry.score.toFixed(4)) : null,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];
  const reasoningComputePolicy = isRecord(value.reasoning_compute_policy) ? value.reasoning_compute_policy : null;
  const policyMode = readString(reasoningComputePolicy?.mode);
  const policyCandidateCount =
    typeof reasoningComputePolicy?.candidate_count === "number" && Number.isFinite(reasoningComputePolicy.candidate_count)
      ? Math.max(1, Math.min(4, Math.round(reasoningComputePolicy.candidate_count)))
      : reasoning_candidate_count;
  const policyMaxCandidateCount =
    typeof reasoningComputePolicy?.max_candidate_count === "number" && Number.isFinite(reasoningComputePolicy.max_candidate_count)
      ? Math.max(1, Math.min(4, Math.round(reasoningComputePolicy.max_candidate_count)))
      : null;
  const policySelectionStrategy = readString(reasoningComputePolicy?.selection_strategy);
  const policyShallowBranchSearch = isRecord(reasoningComputePolicy?.shallow_branch_search)
    ? reasoningComputePolicy.shallow_branch_search
    : null;
  const normalizedReasoningComputePolicy = reasoningComputePolicy
    ? {
        mode: policyMode === "adaptive_best_of_n" || policyMode === "single_path" ? policyMode : null,
        candidate_count: policyCandidateCount,
        max_candidate_count: policyMaxCandidateCount,
        selection_strategy:
          policySelectionStrategy === "single_path" || policySelectionStrategy === "evidence_rerank"
            ? policySelectionStrategy
            : null,
        activation_reasons: normalizeStringArray(reasoningComputePolicy.activation_reasons),
        evidence_required: reasoningComputePolicy.evidence_required === true,
        transcript_policy: readString(reasoningComputePolicy.transcript_policy),
        verifier_rerank: isRecord(reasoningComputePolicy.verifier_rerank)
          ? {
              score_fields: normalizeStringArray(reasoningComputePolicy.verifier_rerank.score_fields),
              required_selected_fields: normalizeStringArray(reasoningComputePolicy.verifier_rerank.required_selected_fields),
              minimum_selected_score:
                typeof reasoningComputePolicy.verifier_rerank.minimum_selected_score === "number" &&
                Number.isFinite(reasoningComputePolicy.verifier_rerank.minimum_selected_score)
                  ? Math.max(0, Math.min(1, Number(reasoningComputePolicy.verifier_rerank.minimum_selected_score.toFixed(4))))
                  : null,
              contradiction_risk_fail_closed: reasoningComputePolicy.verifier_rerank.contradiction_risk_fail_closed === true,
            }
          : null,
        shallow_branch_search: policyShallowBranchSearch
          ? {
              enabled: policyShallowBranchSearch.enabled === true,
              max_depth:
                typeof policyShallowBranchSearch.max_depth === "number" && Number.isFinite(policyShallowBranchSearch.max_depth)
                  ? Math.max(1, Math.min(3, Math.round(policyShallowBranchSearch.max_depth)))
                  : null,
              branch_count:
                typeof policyShallowBranchSearch.branch_count === "number" && Number.isFinite(policyShallowBranchSearch.branch_count)
                  ? Math.max(1, Math.min(4, Math.round(policyShallowBranchSearch.branch_count)))
                  : null,
              expand_policy: readString(policyShallowBranchSearch.expand_policy),
              prune_with: normalizeStringArray(policyShallowBranchSearch.prune_with),
              fallback: readString(policyShallowBranchSearch.fallback),
            }
          : null,
      }
    : null;

  return {
    preferred_host_ids: normalizeStringArray(value.preferred_host_ids),
    allowed_host_ids: normalizeStringArray(value.allowed_host_ids),
    preferred_host_tags: normalizeStringArray(value.preferred_host_tags),
    required_host_tags: normalizeStringArray(value.required_host_tags),
    preferred_backend_ids: normalizeStringArray(value.preferred_backend_ids),
    required_backend_ids: normalizeStringArray(value.required_backend_ids),
    preferred_model_tags: normalizeStringArray(value.preferred_model_tags),
    required_model_tags: normalizeStringArray(value.required_model_tags),
    isolation_mode,
    task_kind:
      task_kind === "planning" ||
      task_kind === "coding" ||
      task_kind === "research" ||
      task_kind === "verification" ||
      task_kind === "chat" ||
      task_kind === "tool_use"
        ? task_kind
        : null,
    quality_preference:
      quality_preference === "speed" ||
      quality_preference === "balanced" ||
      quality_preference === "quality" ||
      quality_preference === "cost"
        ? quality_preference
        : null,
    selected_backend_id: readString(value.selected_backend_id),
    selected_backend_provider: readString(value.selected_backend_provider),
    selected_backend_locality:
      selected_backend_locality === "local" || selected_backend_locality === "remote" ? selected_backend_locality : null,
    selected_host_id: readString(value.selected_host_id),
    selected_worker_host_id: readString(value.selected_worker_host_id),
    routed_bridge_agent_ids: normalizeStringArray(value.routed_bridge_agent_ids),
    planned_backend_candidates,
    focus: readString(value.focus),
    reasoning_candidate_count,
    reasoning_selection_strategy:
      reasoning_selection_strategy === "single_path" || reasoning_selection_strategy === "evidence_rerank"
        ? reasoning_selection_strategy
        : null,
    reasoning_compute_policy: normalizedReasoningComputePolicy,
    require_plan_pass: value.require_plan_pass === true,
    require_verification_pass: value.require_verification_pass === true,
    runtime_id: runtime_id === "codex" || runtime_id === "shell" ? runtime_id : null,
    runtime_strategy: runtime_strategy === "tmux_worktree" ? runtime_strategy : null,
    runtime_command: readString(value.runtime_command),
  };
}

function resolveTaskRouting(task: TaskRecord) {
  const merged = {
    preferred_agent_ids: [] as string[],
    allowed_agent_ids: [] as string[],
    preferred_client_kinds: [] as string[],
    allowed_client_kinds: [] as string[],
    required_capabilities: [] as string[],
    preferred_capabilities: [] as string[],
  };

  const candidates = [
    task.metadata.task_routing,
    task.metadata.routing,
    isRecord(task.payload) ? task.payload.task_routing : undefined,
    isRecord(task.payload) ? task.payload.routing : undefined,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    merged.preferred_agent_ids = dedupeStrings([
      ...merged.preferred_agent_ids,
      ...normalizeStringArray(candidate.preferred_agent_ids),
    ]);
    merged.allowed_agent_ids = dedupeStrings([...merged.allowed_agent_ids, ...normalizeStringArray(candidate.allowed_agent_ids)]);
    merged.preferred_client_kinds = dedupeStrings([
      ...merged.preferred_client_kinds,
      ...normalizeStringArray(candidate.preferred_client_kinds),
    ]);
    merged.allowed_client_kinds = dedupeStrings([
      ...merged.allowed_client_kinds,
      ...normalizeStringArray(candidate.allowed_client_kinds),
    ]);
    merged.required_capabilities = dedupeStrings([
      ...merged.required_capabilities,
      ...normalizeStringArray(candidate.required_capabilities),
    ]);
    merged.preferred_capabilities = dedupeStrings([
      ...merged.preferred_capabilities,
      ...normalizeStringArray(candidate.preferred_capabilities),
    ]);
  }
  return merged;
}

export function resolveTaskExecutionProfile(task: Pick<TaskRecord, "objective" | "project_dir" | "payload" | "tags" | "metadata">): TaskExecutionProfile {
  const existingProfile = normalizeTaskProfile(isRecord(task.metadata) ? task.metadata.task_profile : null);
  if (existingProfile) {
    return existingProfile;
  }

  const routing = isRecord(task.metadata) || isRecord(task.payload)
    ? resolveTaskRouting(task as TaskRecord)
    : {
        preferred_agent_ids: [],
        allowed_agent_ids: [],
        preferred_client_kinds: [],
        allowed_client_kinds: [],
        required_capabilities: [],
        preferred_capabilities: [],
      };
  const signals: string[] = [];
  let score = 0;
  const objective = task.objective.trim().toLowerCase();
  const metadataExecution = isRecord(task.metadata) && isRecord(task.metadata.task_execution) ? task.metadata.task_execution : null;
  const focus =
    (isRecord(task.payload) ? readString(task.payload.focus)?.toLowerCase() ?? null : null) ??
    (metadataExecution ? readString(metadataExecution.focus)?.toLowerCase() ?? null : null);
  const taskKind = metadataExecution ? readString(metadataExecution.task_kind)?.toLowerCase() ?? null : null;
  const qualityPreference = metadataExecution ? readString(metadataExecution.quality_preference)?.toLowerCase() ?? null : null;
  const reasoningSelectionStrategy = metadataExecution
    ? readString(metadataExecution.reasoning_selection_strategy)?.toLowerCase() ?? null
    : null;
  const reasoningCandidateCount =
    metadataExecution && typeof metadataExecution.reasoning_candidate_count === "number" && Number.isFinite(metadataExecution.reasoning_candidate_count)
      ? Math.max(1, Math.min(4, Math.round(metadataExecution.reasoning_candidate_count)))
      : 0;
  const tags = new Set(task.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));

  if (task.project_dir && task.project_dir !== ".") {
    score += 1;
    signals.push("project_dir");
  }
  if (focus && ["implementation", "candidate_variant", "baseline_measurement", "codebase_map", "verification", "implementation_research", "task_breakdown", "fix"].includes(focus)) {
    score += 2;
    signals.push(`focus:${focus}`);
  }
  if (taskKind === "research" || taskKind === "verification") {
    score += 1;
    signals.push(`task_kind:${taskKind}`);
  }
  if (qualityPreference === "quality") {
    score += 1;
    signals.push("quality_preference:quality");
  }
  if (reasoningCandidateCount >= 3) {
    score += 2;
    signals.push(`reasoning_candidates:${reasoningCandidateCount}`);
  } else if (reasoningCandidateCount >= 2) {
    score += 1;
    signals.push(`reasoning_candidates:${reasoningCandidateCount}`);
  }
  if (reasoningSelectionStrategy === "evidence_rerank") {
    score += 1;
    signals.push("reasoning_selection:evidence_rerank");
  }
  if (metadataExecution?.require_plan_pass === true) {
    score += 1;
    signals.push("requires_plan_pass");
  }
  if (metadataExecution?.require_verification_pass === true) {
    score += 1;
    signals.push("requires_verification_pass");
  }
  if (
    /implement|refactor|debug|fix|benchmark|latency|throughput|performance|verify|verification|codebase|architecture|integration|optimiz/.test(
      objective
    )
  ) {
    score += 2;
    signals.push("objective_keywords");
  }
  if (objective.length >= 120) {
    score += 1;
    signals.push("long_objective");
  }
  if (routing.required_capabilities.length > 0 || routing.preferred_capabilities.length > 0) {
    score += 2;
    signals.push("routing_capabilities");
  }
  if (["agentic", "autoresearch", "gsd", "benchmark", "verification", "implementation"].some((tag) => tags.has(tag))) {
    score += 1;
    signals.push("workflow_tags");
  }

  const complexity: TaskExecutionProfile["complexity"] = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return {
    complexity,
    requires_agent_session: complexity !== "low",
    signals,
  };
}

function isTaskClaimableNow(task: TaskRecord, nowIso: string) {
  if (task.status !== "pending") {
    return {
      claimable: false,
      reason: `not-pending:${task.status}`,
    };
  }
  if (task.available_at > nowIso) {
    return {
      claimable: false,
      reason: "not-ready",
    };
  }
  if (task.lease && task.lease.lease_expires_at > nowIso) {
    return {
      claimable: false,
      reason: "leased",
    };
  }
  return {
    claimable: true,
    reason: "claimable",
  };
}

function isTaskEligibleForGenericWorker(task: TaskRecord, workerId: string) {
  const routing = resolveTaskRouting(task);
  const normalizedWorkerId = workerId.trim().toLowerCase();
  const profile = resolveTaskExecutionProfile(task);
  const explicitlyAllowedWorker =
    routing.allowed_agent_ids.length > 0 &&
    routing.allowed_agent_ids.some((value) => value.toLowerCase() === normalizedWorkerId);

  if (routing.allowed_agent_ids.length > 0) {
    const allowed = new Set(routing.allowed_agent_ids.map((value) => value.toLowerCase()));
    if (!allowed.has(normalizedWorkerId)) {
      return {
        eligible: false,
        reason: "routing-ineligible:agent_id_not_allowed",
      };
    }
  }

  if (profile.requires_agent_session && !explicitlyAllowedWorker) {
    return {
      eligible: false,
      reason: `routing-ineligible:complexity_${profile.complexity}`,
    };
  }

  if (routing.allowed_client_kinds.length > 0) {
    return {
      eligible: false,
      reason: "routing-ineligible:client_kind_not_allowed",
    };
  }

  if (routing.required_capabilities.length > 0) {
    return {
      eligible: false,
      reason: "routing-ineligible:missing_capabilities",
    };
  }

  return {
    eligible: true,
    reason: "eligible",
  };
}

function selectTaskForWorkerClaim(storage: Storage, workerId: string, requestedTaskId?: string) {
  const nowIso = new Date().toISOString();
  if (requestedTaskId && requestedTaskId.trim()) {
    const task = storage.getTaskById(requestedTaskId);
    if (!task) {
      return {
        task: null,
        reason: "not-found",
        scanned: 0,
      };
    }
    const claimability = isTaskClaimableNow(task, nowIso);
    if (!claimability.claimable) {
      return {
        task: null,
        reason: claimability.reason,
        scanned: 1,
      };
    }
    const routing = isTaskEligibleForGenericWorker(task, workerId);
    if (!routing.eligible) {
      return {
        task: null,
        reason: routing.reason,
        scanned: 1,
      };
    }
    return {
      task,
      reason: "selected",
      scanned: 1,
    };
  }

  const pendingTasks = storage.listTasks({
    status: "pending",
    limit: 200,
  });
  for (const task of pendingTasks) {
    const claimability = isTaskClaimableNow(task, nowIso);
    if (!claimability.claimable) {
      continue;
    }
    const routing = isTaskEligibleForGenericWorker(task, workerId);
    if (!routing.eligible) {
      continue;
    }
    return {
      task,
      reason: "selected",
      scanned: pendingTasks.length,
    };
  }

  return {
    task: null,
    reason: pendingTasks.length > 0 ? "none-eligible" : "none-available",
    scanned: pendingTasks.length,
  };
}

export function taskList(storage: Storage, input: z.infer<typeof taskListSchema>) {
  const tasks = storage.listTasks({
    status: input.status,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    count: tasks.length,
    tasks,
  };
}

export function taskTimeline(storage: Storage, input: z.infer<typeof taskTimelineSchema>) {
  const limit = input.limit ?? 100;
  const events = storage.getTaskTimeline(input.task_id, limit);
  return {
    task_id: input.task_id,
    count: events.length,
    events,
  };
}

export function taskSummary(storage: Storage, input: z.infer<typeof taskSummarySchema>) {
  const summary = storage.getTaskSummary({
    running_limit: input.running_limit ?? 10,
  });
  return {
    ...summary,
    running_count: summary.running.length,
  };
}

export async function taskClaim(storage: Storage, input: z.infer<typeof taskClaimSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.claim",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const selection = selectTaskForWorkerClaim(storage, input.worker_id, input.task_id);
      if (!selection.task) {
        return {
          claimed: false,
          reason: selection.reason,
          scanned_task_count: selection.scanned,
        };
      }
      return {
        ...storage.claimTask({
          worker_id: input.worker_id,
          lease_seconds: input.lease_seconds ?? 300,
          task_id: selection.task.task_id,
        }),
        scanned_task_count: selection.scanned,
      };
    },
  });
}

export async function taskHeartbeat(storage: Storage, input: z.infer<typeof taskHeartbeatSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.heartbeat",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.heartbeatTaskLease({
        task_id: input.task_id,
        worker_id: input.worker_id,
        lease_seconds: input.lease_seconds ?? 300,
      }),
  });
}

export async function taskComplete(storage: Storage, input: z.infer<typeof taskCompleteSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.complete",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const completed = storage.completeTask({
        task_id: input.task_id,
        worker_id: input.worker_id,
        result: input.result,
        summary: input.summary,
      });
      recordBudgetLedgerUsage(storage, {
        ledger_kind: "actual",
        usage: input.usage,
        usage_sources: [input.result],
        entity_type: "task",
        entity_id: input.task_id,
        task_id: input.task_id,
        notes: input.summary ?? "Task completed",
      });
      return completed;
    },
  });
}

export async function taskFail(storage: Storage, input: z.infer<typeof taskFailSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.fail",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const failed = storage.failTask({
        task_id: input.task_id,
        worker_id: input.worker_id,
        error: input.error,
        result: input.result,
        summary: input.summary,
      });
      recordBudgetLedgerUsage(storage, {
        ledger_kind: "actual",
        usage: input.usage,
        usage_sources: [input.result],
        entity_type: "task",
        entity_id: input.task_id,
        task_id: input.task_id,
        notes: input.summary ?? input.error,
      });
      return failed;
    },
  });
}

export async function taskRetry(storage: Storage, input: z.infer<typeof taskRetrySchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.retry",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.retryTask({
        task_id: input.task_id,
        delay_seconds: input.delay_seconds ?? 0,
        reason: input.reason,
        force: input.force,
      }),
  });
}

export async function taskRecoverExpired(storage: Storage, input: z.infer<typeof taskRecoverExpiredSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.recover_expired",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const result = storage.recoverExpiredRunningTasks({
        limit: input.limit,
      });
      return {
        ok: true,
        ...result,
      };
    },
  });
}

export function taskAutoRetryControl(storage: Storage, input: z.infer<typeof taskAutoRetrySchema>) {
  if (input.action === "status") {
    return getTaskAutoRetryStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "task.auto_retry",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = taskAutoRetryRuntime.running;
        taskAutoRetryRuntime.config = resolveTaskAutoRetryConfig(input, taskAutoRetryRuntime.config);
        startTaskAutoRetryDaemon(storage);
        let initialTick: TaskAutoRetryTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runTaskAutoRetryTick(storage, taskAutoRetryRuntime.config);
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...taskAutoRetryRuntime.config },
          persisted: storage.setTaskAutoRetryState({
            enabled: true,
            interval_seconds: taskAutoRetryRuntime.config.interval_seconds,
            batch_limit: taskAutoRetryRuntime.config.batch_limit,
            base_delay_seconds: taskAutoRetryRuntime.config.base_delay_seconds,
            max_delay_seconds: taskAutoRetryRuntime.config.max_delay_seconds,
          }),
          initial_tick: initialTick,
          status: getTaskAutoRetryStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = taskAutoRetryRuntime.running;
        stopTaskAutoRetryDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTaskAutoRetryState({
            enabled: false,
            interval_seconds: taskAutoRetryRuntime.config.interval_seconds,
            batch_limit: taskAutoRetryRuntime.config.batch_limit,
            base_delay_seconds: taskAutoRetryRuntime.config.base_delay_seconds,
            max_delay_seconds: taskAutoRetryRuntime.config.max_delay_seconds,
          }),
          status: getTaskAutoRetryStatus(),
        };
      }

      const config = resolveTaskAutoRetryConfig(input, taskAutoRetryRuntime.config);
      const tick = runTaskAutoRetryTick(storage, config);
      return {
        running: taskAutoRetryRuntime.running,
        tick,
        status: getTaskAutoRetryStatus(),
      };
    },
  });
}

function getTaskAutoRetryStatus() {
  return {
    running: taskAutoRetryRuntime.running,
    in_tick: taskAutoRetryRuntime.in_tick,
    config: { ...taskAutoRetryRuntime.config },
    started_at: taskAutoRetryRuntime.started_at,
    last_tick_at: taskAutoRetryRuntime.last_tick_at,
    last_error: taskAutoRetryRuntime.last_error,
    stats: {
      tick_count: taskAutoRetryRuntime.tick_count,
      total_failed_seen: taskAutoRetryRuntime.total_failed_seen,
      total_retried: taskAutoRetryRuntime.total_retried,
      total_skipped: taskAutoRetryRuntime.total_skipped,
    },
  };
}

function resolveTaskAutoRetryConfig(
  input:
    | z.infer<typeof taskAutoRetrySchema>
    | Partial<
        Pick<
          z.infer<typeof taskAutoRetrySchema>,
          "interval_seconds" | "batch_limit" | "base_delay_seconds" | "max_delay_seconds"
        >
      >,
  fallback: TaskAutoRetryConfig
): TaskAutoRetryConfig {
  const baseDelay = input.base_delay_seconds ?? fallback.base_delay_seconds ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.base_delay_seconds;
  const maxDelayRaw = input.max_delay_seconds ?? fallback.max_delay_seconds ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.max_delay_seconds;
  return {
    interval_seconds: input.interval_seconds ?? fallback.interval_seconds ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.interval_seconds,
    batch_limit: input.batch_limit ?? fallback.batch_limit ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.batch_limit,
    base_delay_seconds: baseDelay,
    max_delay_seconds: Math.max(baseDelay, maxDelayRaw),
  };
}

function startTaskAutoRetryDaemon(storage: Storage) {
  stopTaskAutoRetryDaemon();
  taskAutoRetryRuntime.running = true;
  taskAutoRetryRuntime.in_tick = false;
  taskAutoRetryRuntime.started_at = new Date().toISOString();
  taskAutoRetryRuntime.last_error = null;
  taskAutoRetryRuntime.timer = setInterval(() => {
    try {
      runTaskAutoRetryTick(storage, taskAutoRetryRuntime.config);
    } catch (error) {
      taskAutoRetryRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, taskAutoRetryRuntime.config.interval_seconds * 1000);
  taskAutoRetryRuntime.timer.unref?.();
}

function stopTaskAutoRetryDaemon() {
  if (taskAutoRetryRuntime.timer) {
    clearInterval(taskAutoRetryRuntime.timer);
  }
  taskAutoRetryRuntime.timer = null;
  taskAutoRetryRuntime.running = false;
  taskAutoRetryRuntime.in_tick = false;
}

function runTaskAutoRetryTick(storage: Storage, config: TaskAutoRetryConfig): TaskAutoRetryTickResult {
  if (taskAutoRetryRuntime.in_tick) {
    const completedAt = new Date().toISOString();
    return {
      completed_at: completedAt,
      failed_seen: 0,
      retried_count: 0,
      skipped_count: 0,
      run_results: [],
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  taskAutoRetryRuntime.in_tick = true;
  try {
    const failedTasks = storage.listFailedTasksForAutoRetry(config.batch_limit);
    const runResults: TaskAutoRetryRunResult[] = [];
    const runErrors: string[] = [];
    let retriedCount = 0;
    let skippedCount = 0;

    for (const task of failedTasks) {
      const delaySeconds = computeRetryBackoffSeconds(
        task.attempt_count,
        config.base_delay_seconds,
        config.max_delay_seconds
      );
      try {
        const retryResult = storage.retryTask({
          task_id: task.task_id,
          delay_seconds: delaySeconds,
          reason: `auto-retry attempt=${task.attempt_count} backoff=${delaySeconds}s`,
        });
        if (retryResult.retried) {
          retriedCount += 1;
        } else {
          skippedCount += 1;
        }
        runResults.push({
          task_id: task.task_id,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          delay_seconds: delaySeconds,
          retried: retryResult.retried,
          reason: retryResult.reason,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runErrors.push(`${task.task_id}: ${message}`);
        skippedCount += 1;
        runResults.push({
          task_id: task.task_id,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          delay_seconds: delaySeconds,
          retried: false,
          error: message,
        });
      }
    }

    const completedAt = new Date().toISOString();
    taskAutoRetryRuntime.tick_count += 1;
    taskAutoRetryRuntime.total_failed_seen += failedTasks.length;
    taskAutoRetryRuntime.total_retried += retriedCount;
    taskAutoRetryRuntime.total_skipped += skippedCount;
    taskAutoRetryRuntime.last_tick_at = completedAt;
    taskAutoRetryRuntime.last_error = runErrors.length
      ? `${runErrors.length} task(s) failed retry: ${runErrors[0]}`
      : null;

    return {
      completed_at: completedAt,
      failed_seen: failedTasks.length,
      retried_count: retriedCount,
      skipped_count: skippedCount,
      run_results: runResults,
      reason: runErrors.length ? taskAutoRetryRuntime.last_error ?? undefined : undefined,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    taskAutoRetryRuntime.tick_count += 1;
    taskAutoRetryRuntime.last_tick_at = completedAt;
    taskAutoRetryRuntime.last_error = message;
    return {
      completed_at: completedAt,
      failed_seen: 0,
      retried_count: 0,
      skipped_count: 0,
      run_results: [],
      reason: message,
    };
  } finally {
    taskAutoRetryRuntime.in_tick = false;
  }
}

function computeRetryBackoffSeconds(attemptCount: number, baseDelaySeconds: number, maxDelaySeconds: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attemptCount));
  const exponent = Math.max(0, normalizedAttempt - 1);
  const scaled = baseDelaySeconds * Math.pow(2, exponent);
  const bounded = Math.min(maxDelaySeconds, scaled);
  return Math.max(0, Math.round(bounded));
}
