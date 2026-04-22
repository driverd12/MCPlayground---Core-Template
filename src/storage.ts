import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getDefaultFeatureFlagState,
  getDefaultPermissionProfilesState,
  getDefaultWarmCacheState,
  normalizeFeatureFlagState,
  normalizePermissionProfilesState,
  normalizeWarmCacheState,
  type FeatureFlagStateRecord,
  type PermissionProfilesStateRecord,
  type WarmCacheStateRecord,
} from "./control_plane.js";
import {
  getDefaultDesktopControlState,
  normalizeDesktopControlState,
  type DesktopControlStateRecord,
} from "./desktop_control_plane.js";
import {
  getDefaultPatientZeroState,
  normalizePatientZeroState,
  type PatientZeroStateRecord,
} from "./patient_zero_plane.js";
import {
  getDefaultPrivilegedAccessState,
  normalizePrivilegedAccessState,
  type PrivilegedAccessStateRecord,
} from "./privileged_access_plane.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "utf8");

type StorageGuardOptions = {
  backup_dir: string;
  backup_keep: number;
  backup_max_total_bytes: number;
  backup_min_interval_seconds: number;
  startup_backup_enabled: boolean;
  startup_backup_max_bytes: number;
  startup_quick_check_enabled: boolean;
  startup_quick_check_max_bytes: number;
  auto_restore_from_backup: boolean;
  allow_fresh_on_corruption: boolean;
  quarantine_dir: string;
};

type StorageGuardOutcome = {
  quarantined_paths: string[];
  restored_from_backup: string | null;
};

type StorageBackupArtifactKind = "snapshot" | "temp" | "journal" | "wal" | "shm" | "other";

type StorageBackupArtifactRecord = {
  path: string;
  basename: string;
  kind: StorageBackupArtifactKind;
  size_bytes: number;
  mtime_ms: number;
  mtime_iso: string | null;
};

export type TrustTier = "raw" | "verified" | "policy-backed" | "deprecated";

export type NoteRecord = {
  id: string;
  created_at: string;
  source: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  trust_tier: TrustTier;
  expires_at: string | null;
  promoted_from_note_id: string | null;
  tags: string[];
  related_paths: string[];
  text: string;
  score?: number;
};

export type TranscriptRecord = {
  id: string;
  created_at: string;
  session_id: string;
  source_client: string;
  source_model: string | null;
  source_agent: string | null;
  kind: string;
  text: string;
  score?: number;
};

export type TranscriptLineRecord = {
  id: number;
  run_id: string | null;
  role: string | null;
  content: string;
  timestamp: string;
  is_squished: boolean;
  score?: number;
};

export type MemoryRecord = {
  id: number;
  content: string;
  keywords: string[];
  created_at: string;
  last_accessed_at: string;
  decay_score: number;
  score?: number;
};

export type GoalStatus =
  | "draft"
  | "active"
  | "blocked"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";

export type GoalRiskTier = "low" | "medium" | "high" | "critical";

export type GoalAutonomyMode =
  | "observe"
  | "recommend"
  | "stage"
  | "execute_bounded"
  | "execute_destructive_with_approval";

export type GoalRecord = {
  goal_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  objective: string;
  status: GoalStatus;
  priority: number;
  risk_tier: GoalRiskTier;
  autonomy_mode: GoalAutonomyMode;
  target_entity_type: string | null;
  target_entity_id: string | null;
  acceptance_criteria: string[];
  constraints: string[];
  assumptions: string[];
  budget: Record<string, unknown>;
  owner: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  active_plan_id: string | null;
  result_summary: string | null;
  result: Record<string, unknown> | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type GoalEventRecord = {
  id: string;
  goal_id: string;
  created_at: string;
  event_type: string;
  from_status: GoalStatus | null;
  to_status: GoalStatus | null;
  summary: string;
  details: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type PlanStatus = "draft" | "candidate" | "selected" | "in_progress" | "completed" | "invalidated" | "archived";

export type PlanPlannerKind = "core" | "pack" | "human" | "trichat";

export type PlanStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "skipped"
  | "invalidated";

export type PlanStepKind = "analysis" | "mutation" | "verification" | "decision" | "handoff";

export type PlanExecutorKind = "tool" | "task" | "worker" | "human" | "trichat";

export type PlanRecord = {
  plan_id: string;
  goal_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  summary: string;
  status: PlanStatus;
  planner_kind: PlanPlannerKind;
  planner_id: string | null;
  selected: boolean;
  confidence: number | null;
  assumptions: string[];
  success_criteria: string[];
  rollback: string[];
  budget: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type PlanStepRecord = {
  step_id: string;
  plan_id: string;
  created_at: string;
  updated_at: string;
  seq: number;
  title: string;
  step_kind: PlanStepKind;
  status: PlanStepStatus;
  executor_kind: PlanExecutorKind | null;
  executor_ref: string | null;
  tool_name: string | null;
  input: Record<string, unknown>;
  expected_artifact_types: string[];
  acceptance_checks: string[];
  retry_policy: Record<string, unknown>;
  timeout_seconds: number | null;
  task_id: string | null;
  run_id: string | null;
  metadata: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  depends_on: string[];
};

export type AgentSessionStatus = "active" | "idle" | "busy" | "expired" | "closed" | "failed";

export type AgentSessionRecord = {
  session_id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  ended_at: string | null;
  status: AgentSessionStatus;
  display_name: string | null;
  client_kind: string | null;
  transport_kind: string | null;
  workspace_root: string | null;
  owner_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  capabilities: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type AgentLearningEntryStatus = "active" | "suppressed";
export type AgentLearningEntryKind =
  | "execution_pattern"
  | "delegation_pattern"
  | "verification_pattern"
  | "failure_pattern"
  | "guardrail";
export type AgentLearningEntryPolarity = "prefer" | "avoid";

export type AgentLearningEntryRecord = {
  entry_id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
  status: AgentLearningEntryStatus;
  lesson_kind: AgentLearningEntryKind;
  polarity: AgentLearningEntryPolarity;
  scope: string | null;
  summary: string;
  lesson: string;
  evidence: string | null;
  source_run_id: string | null;
  source_task_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  confidence: number | null;
  weight: number;
  fingerprint: string;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ArtifactStatus = "active" | "superseded" | "invalid" | "archived";

export type ArtifactTrustTier = "raw" | "derived" | "verified" | "policy-backed" | "deprecated";

export type ArtifactRecord = {
  artifact_id: string;
  created_at: string;
  updated_at: string;
  artifact_type: string;
  status: ArtifactStatus;
  goal_id: string | null;
  plan_id: string | null;
  step_id: string | null;
  task_id: string | null;
  run_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  pack_id: string | null;
  producer_kind: string;
  producer_id: string | null;
  uri: string | null;
  content_text: string | null;
  content_json: Record<string, unknown> | null;
  hash: string | null;
  trust_tier: ArtifactTrustTier;
  freshness_expires_at: string | null;
  supersedes_artifact_id: string | null;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ArtifactLinkRecord = {
  id: string;
  created_at: string;
  src_artifact_id: string;
  dst_artifact_id: string | null;
  dst_entity_type: string | null;
  dst_entity_id: string | null;
  relation: string;
  rationale: string | null;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ExperimentStatus = "draft" | "active" | "paused" | "completed" | "archived";

export type ExperimentMetricDirection = "minimize" | "maximize";

export type ExperimentRunStatus = "proposed" | "running" | "completed" | "crash" | "discarded";

export type ExperimentVerdict = "accepted" | "rejected" | "inconclusive" | "crash";

export type ExperimentRecord = {
  experiment_id: string;
  created_at: string;
  updated_at: string;
  goal_id: string | null;
  plan_id: string | null;
  step_id: string | null;
  title: string;
  objective: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  metric_name: string;
  metric_direction: ExperimentMetricDirection;
  baseline_metric: number | null;
  current_best_metric: number | null;
  acceptance_delta: number;
  budget_seconds: number | null;
  run_command: string | null;
  parse_strategy: Record<string, unknown>;
  rollback_strategy: Record<string, unknown>;
  candidate_scope: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  selected_run_id: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ExperimentRunRecord = {
  experiment_run_id: string;
  experiment_id: string;
  created_at: string;
  updated_at: string;
  candidate_label: string;
  status: ExperimentRunStatus;
  verdict: ExperimentVerdict | null;
  task_id: string | null;
  run_id: string | null;
  artifact_ids: string[];
  observed_metric: number | null;
  observed_metrics: Record<string, unknown>;
  delta: number | null;
  summary: string | null;
  log_excerpt: string | null;
  error_text: string | null;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type PackHookKind = "planner" | "verifier";

export type PackHookRunStatus = "running" | "completed" | "failed";

export type PackHookRunRecord = {
  hook_run_id: string;
  created_at: string;
  updated_at: string;
  pack_id: string;
  hook_kind: PackHookKind;
  hook_name: string;
  target_type: string;
  target_id: string;
  goal_id: string | null;
  plan_id: string | null;
  step_id: string | null;
  status: PackHookRunStatus;
  summary: string | null;
  score: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error_text: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type TaskRecord = {
  task_id: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  priority: number;
  objective: string;
  project_dir: string;
  payload: Record<string, unknown>;
  source: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  max_attempts: number;
  attempt_count: number;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_worker_id: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  lease: TaskLeaseRecord | null;
};

export type TaskCompletionReasoningAudit = {
  required: boolean;
  status: "not_required" | "satisfied" | "needs_review";
  required_candidate_count: number | null;
  observed_candidate_count: number | null;
  selection: {
    strategy: string | null;
    selection_rationale_present: boolean;
    selected_candidate_id: string | null;
    candidate_count: number | null;
    selected_candidate_in_candidates: boolean | null;
    selected_candidate_has_evidence: boolean;
    evidence_scored_candidate_count: number;
  };
  required_fields: string[];
  satisfied_fields: string[];
  missing_fields: string[];
  warnings: string[];
};

export type TaskFailureReflectionCapture = {
  memory_id: number;
  created_at: string;
  event_id: string;
  keywords: string[];
};

export type BudgetLedgerEntryRecord = {
  entry_id: string;
  created_at: string;
  ledger_kind: "projection" | "actual" | "adjustment";
  entity_type: string | null;
  entity_id: string | null;
  run_id: string | null;
  task_id: string | null;
  goal_id: string | null;
  plan_id: string | null;
  session_id: string | null;
  provider: string | null;
  model_id: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  projected_cost_usd: number | null;
  actual_cost_usd: number | null;
  currency: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type BudgetLedgerSummaryRecord = {
  total_entries: number;
  projection_count: number;
  actual_count: number;
  adjustment_count: number;
  projected_cost_usd: number;
  actual_cost_usd: number;
  tokens_input: number;
  tokens_output: number;
  tokens_total: number;
  provider_counts: Array<{ provider: string | null; count: number; projected_cost_usd: number; actual_cost_usd: number }>;
  model_counts: Array<{ model_id: string | null; count: number; projected_cost_usd: number; actual_cost_usd: number }>;
  entity_type_counts: Array<{ entity_type: string | null; count: number }>;
  latest_entry_at: string | null;
  recent_entries: BudgetLedgerEntryRecord[];
};

export type TaskLeaseRecord = {
  task_id: string;
  owner_id: string;
  lease_expires_at: string;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
};

export type TaskEventRecord = {
  id: string;
  task_id: string;
  created_at: string;
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  worker_id: string | null;
  summary: string | null;
  details: Record<string, unknown>;
};

export type RuntimeWorkerRuntimeId = "codex" | "shell";
export type RuntimeWorkerSessionStatus =
  | "launching"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

export type RuntimeWorkerSessionRecord = {
  session_id: string;
  created_at: string;
  updated_at: string;
  runtime_id: RuntimeWorkerRuntimeId;
  status: RuntimeWorkerSessionStatus;
  task_id: string | null;
  goal_id: string | null;
  plan_id: string | null;
  step_id: string | null;
  worker_id: string;
  title: string;
  objective: string;
  repo_root: string;
  project_dir: string;
  worktree_path: string;
  branch_name: string | null;
  tmux_session_name: string;
  transcript_path: string | null;
  brief_path: string | null;
  last_command_at: string | null;
  last_activity_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type TriChatThreadStatus = "active" | "archived";

export type TriChatThreadRecord = {
  thread_id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  status: TriChatThreadStatus;
  metadata: Record<string, unknown>;
};

export type TriChatMessageRecord = {
  message_id: string;
  thread_id: string;
  created_at: string;
  agent_id: string;
  role: string;
  content: string;
  reply_to_message_id: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatTurnStatus = "running" | "completed" | "failed" | "cancelled";
export type TriChatTurnPhase = "plan" | "propose" | "critique" | "merge" | "execute" | "verify" | "summarize";
export type TriChatTurnPhaseStatus = "running" | "completed" | "failed" | "skipped";

export type TriChatTurnRecord = {
  turn_id: string;
  thread_id: string;
  user_message_id: string;
  user_prompt: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  finished_at: string | null;
  status: TriChatTurnStatus;
  phase: TriChatTurnPhase;
  phase_status: TriChatTurnPhaseStatus;
  expected_agents: string[];
  min_agents: number;
  novelty_score: number | null;
  novelty_threshold: number | null;
  retry_required: boolean;
  retry_agents: string[];
  disagreement: boolean;
  decision_summary: string | null;
  selected_agent: string | null;
  selected_strategy: string | null;
  verify_status: string | null;
  verify_summary: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatTurnArtifactRecord = {
  artifact_id: string;
  turn_id: string;
  thread_id: string;
  created_at: string;
  phase: TriChatTurnPhase;
  artifact_type: string;
  agent_id: string | null;
  content: string | null;
  structured: Record<string, unknown>;
  score: number | null;
  metadata: Record<string, unknown>;
};

export type TriChatBusEventRecord = {
  event_seq: number;
  event_id: string;
  thread_id: string;
  created_at: string;
  source_agent: string | null;
  source_client: string | null;
  event_type: string;
  role: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatAdapterChannel = "command" | "model";

export type TriChatAdapterStateRecord = {
  agent_id: string;
  channel: TriChatAdapterChannel;
  updated_at: string;
  open: boolean;
  open_until: string | null;
  failure_count: number;
  trip_count: number;
  success_count: number;
  last_error: string | null;
  last_opened_at: string | null;
  turn_count: number;
  degraded_turn_count: number;
  last_result: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatAdapterEventRecord = {
  event_id: string;
  created_at: string;
  agent_id: string;
  channel: TriChatAdapterChannel;
  event_type: string;
  open_until: string | null;
  error_text: string | null;
  details: Record<string, unknown>;
};

export type TriChatAdapterTelemetrySummaryRecord = {
  total_channels: number;
  open_channels: number;
  total_trips: number;
  total_successes: number;
  total_turns: number;
  total_degraded_turns: number;
  newest_state_at: string | null;
  newest_event_at: string | null;
  newest_trip_opened_at: string | null;
  per_agent: Array<{
    agent_id: string;
    channel_count: number;
    open_channels: number;
    total_trips: number;
    total_turns: number;
    degraded_turns: number;
    updated_at: string | null;
  }>;
};

export type TaskSummaryRecord = {
  counts: Record<TaskStatus, number>;
  expired_running_count: number;
  reasoning_policy: {
    pending_count: number;
    running_count: number;
    total_active_count: number;
    evidence_rerank_count: number;
    plan_pass_count: number;
    verification_pass_count: number;
    branch_search_count: number;
    budget_forcing_count: number;
    total_candidate_count: number;
    max_candidate_count: number;
    high_compute_task_ids: string[];
    completion_review: {
      audited_completed_count: number;
      needs_review_count: number;
      satisfied_count: number;
      missing_field_counts: Record<string, number>;
      needs_review_task_ids: string[];
      last_needs_review_task_id: string | null;
      last_needs_review_at: string | null;
    };
  };
  running: Array<{
    task_id: string;
    objective: string;
    owner_id: string | null;
    lease_expires_at: string | null;
    updated_at: string;
    attempt_count: number;
    max_attempts: number;
  }>;
  last_failed: {
    task_id: string;
    last_error: string | null;
    attempt_count: number;
    max_attempts: number;
    updated_at: string;
  } | null;
  last_completed: {
    task_id: string;
    updated_at: string;
  } | null;
};

export type TriChatSummaryRecord = {
  thread_counts: {
    active: number;
    archived: number;
    total: number;
  };
  message_count: number;
  oldest_message_at: string | null;
  newest_message_at: string | null;
  busiest_threads: Array<{
    thread_id: string;
    status: TriChatThreadStatus;
    updated_at: string;
    message_count: number;
  }>;
};

export type MutationMeta = {
  idempotency_key: string;
  side_effect_fingerprint: string;
};

export type MutationStartResult = {
  replayed: boolean;
  result?: unknown;
};

export type RunEventRecord = {
  id: string;
  created_at: string;
  run_id: string;
  event_type: "begin" | "step" | "end";
  step_index: number;
  status: string;
  summary: string;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  details: Record<string, unknown>;
};

export type LockAcquireResult = {
  acquired: boolean;
  lock_key: string;
  owner_id?: string;
  lease_expires_at?: string;
  reason?: string;
};

export type IncidentRecord = {
  incident_id: string;
  created_at: string;
  updated_at: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  tags: string[];
};

export type IncidentEventRecord = {
  id: string;
  created_at: string;
  incident_id: string;
  event_type: string;
  summary: string;
  details: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type RuntimeEventRecord = {
  event_seq: number;
  event_id: string;
  created_at: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string | null;
  summary: string | null;
  content: string | null;
  details: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ObservabilityLevel = "trace" | "debug" | "info" | "warn" | "error" | "critical";

export type ObservabilityDocumentRecord = {
  document_id: string;
  created_at: string;
  updated_at: string;
  index_name: string;
  source_kind: string;
  source_ref: string | null;
  level: ObservabilityLevel | null;
  host_id: string | null;
  service: string | null;
  event_type: string | null;
  title: string | null;
  body_text: string;
  attributes: Record<string, unknown>;
  tags: string[];
};

export type ObservabilitySearchHit = {
  score: number;
  match_reason: string;
  document: ObservabilityDocumentRecord;
};

export type TranscriptAutoSquishStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  batch_runs: number;
  per_run_limit: number;
  max_points: number;
  updated_at: string;
};

export type ImprintAutoSnapshotStateRecord = {
  enabled: boolean;
  profile_id: string | null;
  interval_seconds: number;
  include_recent_memories: number;
  include_recent_transcript_lines: number;
  write_file: boolean;
  promote_summary: boolean;
  updated_at: string;
};

export type TaskAutoRetryStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  batch_limit: number;
  base_delay_seconds: number;
  max_delay_seconds: number;
  updated_at: string;
};

export type WorkerFabricTransport = "local" | "ssh";

export type WorkerFabricHostHealthState = "healthy" | "degraded" | "offline";
export type WorkerFabricThermalPressure = "nominal" | "fair" | "serious" | "critical";

export type WorkerFabricHostTelemetryRecord = {
  heartbeat_at: string | null;
  health_state: WorkerFabricHostHealthState;
  queue_depth: number;
  active_tasks: number;
  latency_ms: number | null;
  cpu_utilization: number | null;
  ram_available_gb: number | null;
  ram_total_gb: number | null;
  swap_used_gb: number | null;
  gpu_utilization: number | null;
  gpu_memory_available_gb: number | null;
  gpu_memory_total_gb: number | null;
  disk_free_gb: number | null;
  thermal_pressure: WorkerFabricThermalPressure | null;
};

export type WorkerFabricHostRecord = {
  host_id: string;
  enabled: boolean;
  transport: WorkerFabricTransport;
  ssh_destination: string | null;
  workspace_root: string;
  worker_count: number;
  shell: string;
  capabilities: Record<string, unknown>;
  tags: string[];
  telemetry: WorkerFabricHostTelemetryRecord;
  metadata: Record<string, unknown>;
  updated_at: string;
};

export type WorkerFabricStateRecord = {
  enabled: boolean;
  strategy: "balanced" | "prefer_local" | "prefer_capacity" | "resource_aware";
  default_host_id: string | null;
  hosts: WorkerFabricHostRecord[];
  updated_at: string;
};

const WORKER_FABRIC_HEARTBEAT_FRESHNESS_MS = 10 * 60 * 1000;

function normalizeWorkerFabricHostHealthState(
  heartbeatAt: string | null,
  healthState: WorkerFabricHostHealthState,
  nowMs = Date.now()
): WorkerFabricHostHealthState {
  if (healthState !== "healthy") {
    return healthState;
  }
  const parsedHeartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  if (!Number.isFinite(parsedHeartbeatMs)) {
    return "offline";
  }
  return nowMs - parsedHeartbeatMs > WORKER_FABRIC_HEARTBEAT_FRESHNESS_MS ? "offline" : "healthy";
}

export type ClusterTopologyNodeStatus = "planned" | "provisioning" | "active" | "maintenance" | "retired";
export type ClusterTopologyNodeClass = "control-plane" | "cpu-memory" | "gpu-workstation" | "virtualization";

export type ClusterTopologyDesiredBackendRecord = {
  backend_id: string;
  provider: ModelRouterProvider;
  model_id: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

export type ClusterTopologyNodeRecord = {
  node_id: string;
  title: string;
  status: ClusterTopologyNodeStatus;
  node_class: ClusterTopologyNodeClass;
  host_id: string | null;
  transport: WorkerFabricTransport;
  ssh_destination: string | null;
  workspace_root: string | null;
  worker_count: number | null;
  tags: string[];
  preferred_domains: string[];
  desired_backends: ClusterTopologyDesiredBackendRecord[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ClusterTopologyStateRecord = {
  enabled: boolean;
  default_node_id: string | null;
  nodes: ClusterTopologyNodeRecord[];
  updated_at: string;
};

export type BenchmarkMetricMode = "duration_ms" | "stdout_regex" | "stderr_regex" | "reward_file";

export type BenchmarkSuiteCaseRecord = {
  case_id: string;
  title: string;
  command: string;
  timeout_seconds: number;
  required: boolean;
  metric_name: string;
  metric_direction: ExperimentMetricDirection;
  metric_mode: BenchmarkMetricMode;
  metric_regex: string | null;
  reward_file_path: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
};

export type BenchmarkSuiteRecord = {
  suite_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  objective: string;
  project_dir: string;
  isolation_mode: "git_worktree" | "copy" | "none";
  aggregate_metric_name: string;
  aggregate_metric_direction: ExperimentMetricDirection;
  cases: BenchmarkSuiteCaseRecord[];
  tags: string[];
  metadata: Record<string, unknown>;
};

export type BenchmarkSuitesStateRecord = {
  enabled: boolean;
  suites: BenchmarkSuiteRecord[];
  updated_at: string;
};

export type ModelRouterProvider =
  | "ollama"
  | "mlx"
  | "llama.cpp"
  | "vllm"
  | "openai"
  | "google"
  | "cursor"
  | "anthropic"
  | "github-copilot"
  | "custom";

function normalizeModelRouterProvider(value: unknown): ModelRouterProvider {
  const providerRaw = String(value ?? "custom").trim().toLowerCase();
  if (
    providerRaw === "ollama" ||
    providerRaw === "mlx" ||
    providerRaw === "llama.cpp" ||
    providerRaw === "vllm" ||
    providerRaw === "openai" ||
    providerRaw === "google" ||
    providerRaw === "cursor" ||
    providerRaw === "anthropic" ||
    providerRaw === "github-copilot"
  ) {
    return providerRaw;
  }
  return "custom";
}
export type ModelRouterStrategy =
  | "balanced"
  | "prefer_speed"
  | "prefer_quality"
  | "prefer_cost"
  | "prefer_context_fit";
export type ModelRouterTaskKind = "planning" | "coding" | "research" | "verification" | "chat" | "tool_use";
export type ModelRouterBackendRecord = {
  backend_id: string;
  enabled: boolean;
  provider: ModelRouterProvider;
  model_id: string;
  endpoint: string | null;
  host_id: string | null;
  locality: "local" | "remote";
  context_window: number;
  throughput_tps: number | null;
  latency_ms_p50: number | null;
  success_rate: number | null;
  win_rate: number | null;
  cost_per_1k_input: number | null;
  max_output_tokens: number | null;
  tags: string[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  heartbeat_at: string | null;
  updated_at: string;
};

export type ModelRouterStateRecord = {
  enabled: boolean;
  strategy: ModelRouterStrategy;
  default_backend_id: string | null;
  backends: ModelRouterBackendRecord[];
  updated_at: string;
};

export type EvalSuiteCaseKind = "benchmark_suite" | "router_case";

export type EvalSuiteCaseRecord = {
  case_id: string;
  title: string;
  kind: EvalSuiteCaseKind;
  benchmark_suite_id: string | null;
  task_kind: ModelRouterTaskKind | null;
  context_tokens: number | null;
  latency_budget_ms: number | null;
  expected_backend_id: string | null;
  expected_backend_tags: string[];
  required_tags: string[];
  preferred_tags: string[];
  required: boolean;
  weight: number;
  metadata: Record<string, unknown>;
};

export type EvalSuiteRecord = {
  suite_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  objective: string;
  aggregate_metric_name: string;
  aggregate_metric_direction: ExperimentMetricDirection;
  cases: EvalSuiteCaseRecord[];
  tags: string[];
  metadata: Record<string, unknown>;
};

export type EvalSuitesStateRecord = {
  enabled: boolean;
  suites: EvalSuiteRecord[];
  updated_at: string;
};

export type OrgProgramVersionStatus = "candidate" | "active" | "archived";

export type OrgProgramVersionRecord = {
  version_id: string;
  created_at: string;
  summary: string;
  doctrine: string;
  delegation_contract: string;
  evaluation_standard: string;
  status: OrgProgramVersionStatus;
  metadata: Record<string, unknown>;
};

export type OrgProgramRoleRecord = {
  role_id: string;
  title: string;
  description: string | null;
  lane: string | null;
  active_version_id: string | null;
  versions: OrgProgramVersionRecord[];
  metadata: Record<string, unknown>;
  updated_at: string;
};

export type OrgProgramsStateRecord = {
  enabled: boolean;
  roles: OrgProgramRoleRecord[];
  updated_at: string;
};

export type DomainSpecialistStatus = "candidate" | "active" | "archived";

export type DomainSpecialistMatchRulesRecord = {
  keywords: string[];
  tags: string[];
  paths: string[];
};

export type DomainSpecialistRoutingHintsRecord = {
  preferred_host_tags: string[];
  required_host_tags: string[];
  preferred_agent_ids: string[];
  support_agent_ids: string[];
  preferred_model_tags: string[];
  quality_preference: string | null;
  local_learning_entry_target: number;
};

export type DomainSpecialistRecord = {
  domain_key: string;
  agent_id: string;
  role_id: string;
  title: string;
  description: string | null;
  lane: string | null;
  coordination_tier: string | null;
  parent_agent_id: string | null;
  managed_agent_ids: string[];
  match_rules: DomainSpecialistMatchRulesRecord;
  routing_hints: DomainSpecialistRoutingHintsRecord;
  system_prompt: string;
  status: DomainSpecialistStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type DomainSpecialistRegistryStateRecord = {
  enabled: boolean;
  specialists: DomainSpecialistRecord[];
  updated_at: string;
};

export type GoalAutorunStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  limit: number;
  create_plan_if_missing: boolean;
  dispatch_limit: number;
  max_passes: number;
  pack_id: string;
  hook_name: string | null;
  updated_at: string;
};

export type AutonomyMaintainStateRecord = {
  enabled: boolean;
  local_host_id: string;
  interval_seconds: number;
  learning_review_interval_seconds: number;
  enable_self_drive: boolean;
  self_drive_cooldown_seconds: number;
  run_eval_if_due: boolean;
  eval_interval_seconds: number;
  eval_suite_id: string;
  minimum_eval_score: number;
  last_run_at: string | null;
  last_bootstrap_ready_at: string | null;
  last_goal_autorun_daemon_at: string | null;
  last_tmux_maintained_at: string | null;
  last_learning_review_at: string | null;
  last_learning_entry_count: number;
  last_learning_active_agent_count: number;
  last_eval_run_at: string | null;
  last_eval_run_id: string | null;
  last_eval_score: number | null;
  last_eval_dependency_fingerprint: string | null;
  last_observability_ship_at: string | null;
  last_provider_bridge_check_at: string | null;
  provider_bridge_diagnostics: ProviderBridgeDiagnosticSnapshotRecord[];
  last_self_drive_at: string | null;
  last_self_drive_goal_id: string | null;
  last_self_drive_fingerprint: string | null;
  last_actions: string[];
  last_attention: string[];
  last_error: string | null;
  updated_at: string;
};

export type ProviderBridgeDiagnosticSnapshotRecord = {
  client_id: string;
  display_name: string;
  office_agent_id: string | null;
  available: boolean;
  runtime_probed: boolean;
  connected: boolean | null;
  status: "connected" | "disconnected" | "configured" | "unavailable";
  detail: string;
  notes: string[];
  command: string | null;
  config_path: string | null;
};

export type ReactionEngineNotificationRecord = {
  key: string;
  title: string;
  level: "info" | "warn" | "critical";
  sent_at: string;
};

export type ReactionEngineStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  dedupe_window_seconds: number;
  channels: string[];
  last_run_at: string | null;
  last_sent_at: string | null;
  last_sent_count: number;
  last_alert_key: string | null;
  last_alert_seen_count: number;
  recent_notifications: ReactionEngineNotificationRecord[];
  last_error: string | null;
  updated_at: string;
};

export type TriChatAutoRetentionStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  older_than_days: number;
  limit: number;
  updated_at: string;
};

export type TriChatTurnWatchdogStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  stale_after_seconds: number;
  batch_limit: number;
  updated_at: string;
};

export type TriChatAutopilotStateRecord = {
  enabled: boolean;
  away_mode: "safe" | "normal" | "aggressive";
  interval_seconds: number;
  thread_id: string;
  thread_title: string;
  thread_status: "active" | "archived";
  objective: string;
  lead_agent_id: string | null;
  specialist_agent_ids: string[];
  max_rounds: number;
  min_success_agents: number;
  bridge_timeout_seconds: number;
  bridge_dry_run: boolean;
  execute_enabled: boolean;
  command_allowlist: string[];
  execute_backend: "direct" | "tmux" | "auto";
  tmux_session_name: string;
  tmux_worker_count: number;
  tmux_max_queue_per_worker: number;
  tmux_auto_scale_workers: boolean;
  tmux_sync_after_dispatch: boolean;
  confidence_threshold: number;
  max_consecutive_errors: number;
  lock_key: string | null;
  lock_lease_seconds: number;
  adr_policy: "every_success" | "high_impact" | "manual";
  pause_reason: string | null;
  updated_at: string;
};

export type TriChatTmuxControllerTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TriChatTmuxControllerTaskRecord = {
  task_id: string;
  seq: number;
  title: string;
  command: string;
  priority: number;
  complexity: number;
  worker_id: string | null;
  status: TriChatTmuxControllerTaskStatus;
  created_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  thread_id: string | null;
  turn_id: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatTmuxControllerStateRecord = {
  enabled: boolean;
  session_name: string;
  workspace: string;
  worker_count: number;
  shell: string;
  max_queue_per_worker: number;
  next_task_seq: number;
  tasks: TriChatTmuxControllerTaskRecord[];
  last_dispatch_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export type TriChatChaosEventRecord = {
  event_id: string;
  created_at: string;
  action: string;
  thread_id: string | null;
  turn_id: string | null;
  agent_id: string | null;
  channel: TriChatAdapterChannel | null;
  outcome: string;
  details: Record<string, unknown>;
};

export type TriChatSloSnapshotRecord = {
  snapshot_id: string;
  created_at: string;
  window_minutes: number;
  adapter_sample_count: number;
  adapter_error_count: number;
  adapter_error_rate: number;
  adapter_latency_p95_ms: number | null;
  turn_total_count: number;
  turn_failed_count: number;
  turn_failure_rate: number;
  metadata: Record<string, unknown>;
};

export type ImprintProfileRecord = {
  profile_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  mission: string;
  principles: string[];
  hard_constraints: string[];
  preferred_models: string[];
  project_roots: string[];
  notes: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ImprintSnapshotRecord = {
  id: string;
  created_at: string;
  profile_id: string | null;
  summary: string | null;
  tags: string[];
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  state: Record<string, unknown>;
  snapshot_path: string | null;
  memory_id: number | null;
};

export type MigrationStatusRecord = {
  schema_version: number;
  applied_versions: Array<{
    version: number;
    name: string | null;
    applied_at: string | null;
    source: "recorded" | "inferred-user-version";
  }>;
  recorded_count: number;
  inferred_count: number;
};

export class Storage {
  private db: Database.Database;
  private readonly guardOptions: StorageGuardOptions;
  private readonly guardOutcome: StorageGuardOutcome;

  constructor(private dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.guardOptions = resolveStorageGuardOptions(dbPath);
    this.guardOutcome = guardDatabasePathBeforeOpen(dbPath, this.guardOptions);
    this.db = openDatabaseWithGuard(dbPath, this.guardOptions);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  getStorageBackupStatus(params?: { recent_limit?: number }) {
    const recentLimit = Math.max(1, Math.min(100, params?.recent_limit ?? 12));
    const artifacts = listDatabaseBackupArtifacts(this.dbPath, this.guardOptions);
    const snapshots = artifacts.filter((entry) => entry.kind === "snapshot");
    const tempArtifacts = artifacts.filter((entry) => entry.kind === "temp");
    const journals = artifacts.filter((entry) => entry.kind === "journal");
    const auxiliary = artifacts.filter((entry) => entry.kind === "wal" || entry.kind === "shm" || entry.kind === "other");
    const keep = this.guardOptions.backup_keep;
    const maxTotalBytes = this.guardOptions.backup_max_total_bytes;
    let reclaimableBytes = tempArtifacts.reduce((sum, entry) => sum + entry.size_bytes, 0) +
      journals.reduce((sum, entry) => sum + entry.size_bytes, 0) +
      auxiliary.reduce((sum, entry) => sum + entry.size_bytes, 0);
    const reclaimablePaths = [
      ...tempArtifacts.map((entry) => entry.path),
      ...journals.map((entry) => entry.path),
      ...auxiliary.map((entry) => entry.path),
    ];
    const sortedSnapshots = [...snapshots].sort((left, right) => right.mtime_ms - left.mtime_ms);
    for (const snapshot of sortedSnapshots.slice(keep)) {
      reclaimableBytes += snapshot.size_bytes;
      reclaimablePaths.push(snapshot.path);
    }
    if (maxTotalBytes > 0) {
      let retainedBytes = sortedSnapshots
        .slice(0, Math.min(keep, sortedSnapshots.length))
        .reduce((sum, entry) => sum + entry.size_bytes, 0);
      for (const snapshot of sortedSnapshots.slice(keep)) {
        retainedBytes += snapshot.size_bytes;
        if (retainedBytes > maxTotalBytes && !reclaimablePaths.includes(snapshot.path)) {
          reclaimableBytes += snapshot.size_bytes;
          reclaimablePaths.push(snapshot.path);
        }
      }
    }
    return {
      backup_dir: this.guardOptions.backup_dir,
      backup_keep: keep,
      backup_max_total_bytes: maxTotalBytes,
      artifact_count: artifacts.length,
      snapshot_count: snapshots.length,
      temp_count: tempArtifacts.length,
      journal_count: journals.length,
      auxiliary_count: auxiliary.length,
      total_bytes: artifacts.reduce((sum, entry) => sum + entry.size_bytes, 0),
      snapshot_bytes: snapshots.reduce((sum, entry) => sum + entry.size_bytes, 0),
      temp_bytes: tempArtifacts.reduce((sum, entry) => sum + entry.size_bytes, 0),
      reclaimable_bytes: reclaimableBytes,
      reclaimable_count: reclaimablePaths.length,
      recent_artifacts: artifacts
        .slice(0, recentLimit)
        .map((entry) => ({
          path: entry.path,
          basename: entry.basename,
          kind: entry.kind,
          size_bytes: entry.size_bytes,
          mtime_iso: entry.mtime_iso,
        })),
    };
  }

  pruneStorageBackups(params?: {
    keep?: number;
    max_total_bytes?: number;
    dry_run?: boolean;
    temp_max_age_seconds?: number;
  }) {
    return withDatabaseBackupLock(this.dbPath, this.guardOptions, () =>
      pruneDatabaseBackupArtifacts(this.dbPath, this.guardOptions, {
        keep: params?.keep,
        max_total_bytes: params?.max_total_bytes,
        dry_run: params?.dry_run,
        temp_max_age_seconds: params?.temp_max_age_seconds,
      })
    );
  }

  init(): void {
    if (this.guardOutcome.restored_from_backup) {
      writeStorageGuardLog(
        `[storage] restored database from backup: ${this.guardOutcome.restored_from_backup} -> ${this.dbPath}`
      );
    }
    this.ensureStartupIntegrity();
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.ensureMigrationTable();
    this.applyPendingMigrations([
      {
        version: 1,
        name: "bootstrap-core-schema",
        run: () => this.applyCoreSchemaMigration(),
      },
      {
        version: 2,
        name: "add-daemon-config-storage",
        run: () => this.applyDaemonConfigMigration(),
      },
      {
        version: 3,
        name: "add-imprint-schema",
        run: () => this.applyImprintSchemaMigration(),
      },
      {
        version: 4,
        name: "add-task-orchestrator-schema",
        run: () => this.applyTaskSchemaMigration(),
      },
      {
        version: 5,
        name: "add-trichat-thread-message-schema",
        run: () => this.applyTriChatSchemaMigration(),
      },
      {
        version: 6,
        name: "add-trichat-adapter-telemetry-schema",
        run: () => this.applyTriChatAdapterTelemetryMigration(),
      },
      {
        version: 7,
        name: "add-trichat-bus-schema",
        run: () => this.applyTriChatBusMigration(),
      },
      {
        version: 8,
        name: "add-trichat-turn-schema",
        run: () => this.applyTriChatTurnSchemaMigration(),
      },
      {
        version: 9,
        name: "add-trichat-reliability-schema",
        run: () => this.applyTriChatReliabilitySchemaMigration(),
      },
      {
        version: 10,
        name: "add-agentic-runtime-foundation-schema",
        run: () => this.applyAgenticSchemaMigration(),
      },
      {
        version: 11,
        name: "add-agent-session-kernel-schema",
        run: () => this.applyAgentSessionsSchemaMigration(),
      },
      {
        version: 12,
        name: "add-experiment-kernel-schema",
        run: () => this.applyExperimentSchemaMigration(),
      },
      {
        version: 13,
        name: "add-runtime-event-bus-schema",
        run: () => this.applyRuntimeEventBusMigration(),
      },
      {
        version: 14,
        name: "add-agent-learning-ledger-schema",
        run: () => this.applyAgentLearningSchemaMigration(),
      },
      {
        version: 15,
        name: "add-runtime-worker-session-schema",
        run: () => this.applyRuntimeWorkerSessionSchemaMigration(),
      },
      {
        version: 16,
        name: "add-observability-documents-schema",
        run: () => this.applyObservabilitySchemaMigration(),
      },
    ]);
    this.ensureRuntimeSchemaCompleteness();
    this.createStartupBackupSnapshot();
  }

  private ensureStartupIntegrity(): void {
    if (!this.guardOptions.startup_quick_check_enabled) {
      return;
    }
    const dbSizeBytes = databaseArtifactBytes(this.dbPath);
    const integrityProbe = runStartupIntegrityProbe(this.db, this.dbPath, this.guardOptions);
    if (integrityProbe.mode === "large_db_probe") {
      writeStorageGuardLog(
        `[storage] startup quick_check downgraded to large-db probe: database size ${dbSizeBytes} exceeds max ${this.guardOptions.startup_quick_check_max_bytes}; ${integrityProbe.reason}`
      );
      if (!integrityProbe.ok) {
        this.recoverFromCorruption(
          `large-db startup probe failed: ${integrityProbe.reason}`,
          "large-db-startup-probe"
        );
      }
      return;
    }
    if (integrityProbe.ok) {
      return;
    }
    this.recoverFromCorruption(`quick_check failed: ${integrityProbe.reason}`, "quick-check");
  }

  private recoverFromCorruption(reason: string, stage: string): void {
    writeStorageGuardLog(`[storage] corruption detected (${stage}): ${reason}`);
    safeCloseDatabase(this.db);
    const quarantined = quarantineDatabaseArtifacts(this.dbPath, this.guardOptions, stage);
    if (quarantined.length > 0) {
      writeStorageGuardLog(`[storage] quarantined artifacts: ${quarantined.join(", ")}`);
    }

    if (this.guardOptions.auto_restore_from_backup) {
      const restoredFrom = restoreLatestDatabaseBackup(this.dbPath, this.guardOptions);
      if (restoredFrom) {
        writeStorageGuardLog(`[storage] attempting restore from backup: ${restoredFrom}`);
        this.db = openDatabaseWithGuard(this.dbPath, this.guardOptions);
        const postRestoreCheck = runStartupIntegrityProbe(this.db, this.dbPath, this.guardOptions);
        if (postRestoreCheck.ok) {
          writeStorageGuardLog(
            `[storage] restore succeeded with clean ${postRestoreCheck.mode === "large_db_probe" ? "large-db probe" : "integrity check"}.`
          );
          return;
        }
        writeStorageGuardLog(
          `[storage] restored backup still failed ${postRestoreCheck.mode === "large_db_probe" ? "large-db probe" : "quick_check"}: ${postRestoreCheck.reason}`
        );
        safeCloseDatabase(this.db);
      }
    }

    if (!this.guardOptions.allow_fresh_on_corruption) {
      throw new Error(
        [
          `Storage corruption could not be recovered automatically for ${this.dbPath}.`,
          `No healthy backup could be restored from ${this.guardOptions.backup_dir}.`,
          `Set ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION=1 only if you intentionally want a fresh empty DB.`,
        ].join(" ")
      );
    }

    removeDatabaseArtifacts(this.dbPath);
    this.db = openDatabaseWithGuard(this.dbPath, this.guardOptions);
    writeStorageGuardLog(`[storage] initialized fresh empty database after unrecoverable corruption: ${this.dbPath}`);
  }

  private createStartupBackupSnapshot(): void {
    if (!this.guardOptions.startup_backup_enabled) {
      return;
    }
    if (this.dbPath === ":memory:") {
      return;
    }
    const dbSizeBytes = databaseArtifactBytes(this.dbPath);
    fs.mkdirSync(this.guardOptions.backup_dir, { recursive: true });
    const base = path.basename(this.dbPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tmpPath = path.join(this.guardOptions.backup_dir, `${base}.${stamp}.tmp.sqlite`);
    const finalPath = path.join(this.guardOptions.backup_dir, `${base}.${stamp}.sqlite`);
    const escapedTmpPath = tmpPath.replace(/'/g, "''");
    try {
      withDatabaseBackupLock(this.dbPath, this.guardOptions, () => {
        pruneDatabaseBackups(this.dbPath, this.guardOptions);
        const latestSnapshot = listDatabaseBackupArtifacts(this.dbPath, this.guardOptions).find(
          (entry) => entry.kind === "snapshot"
        );
        const minIntervalMs = this.guardOptions.backup_min_interval_seconds * 1000;
        const dbArtifactLatestMtimeMs = databaseArtifactLatestMtimeMs(this.dbPath);
        const databaseChangedSinceLatestSnapshot =
          latestSnapshot && dbArtifactLatestMtimeMs > 0 ? dbArtifactLatestMtimeMs > latestSnapshot.mtime_ms : false;
        if (
          latestSnapshot &&
          minIntervalMs > 0 &&
          Date.now() - latestSnapshot.mtime_ms < minIntervalMs &&
          !databaseChangedSinceLatestSnapshot
        ) {
          writeStorageGuardLog(
            `[storage] startup backup skipped: latest snapshot ${latestSnapshot.basename} is newer than cooldown ${this.guardOptions.backup_min_interval_seconds}s`
          );
          return;
        }
        if (this.guardOptions.startup_backup_max_bytes > 0 && dbSizeBytes > this.guardOptions.startup_backup_max_bytes) {
          try {
            this.db.pragma("wal_checkpoint(PASSIVE)");
          } catch {}
          copyDatabaseArtifactsToSnapshot(this.dbPath, finalPath);
          writeStorageGuardLog(
            `[storage] startup backup used large-db bundle strategy: database size ${dbSizeBytes} exceeds max ${this.guardOptions.startup_backup_max_bytes}`
          );
        } else {
          this.db.pragma("wal_checkpoint(FULL)");
          this.db.exec(`VACUUM INTO '${escapedTmpPath}'`);
          moveFileWithFallback(tmpPath, finalPath);
        }
        pruneDatabaseBackups(this.dbPath, this.guardOptions);
      });
    } catch (error) {
      removeFileIfExists(tmpPath);
      const message = error instanceof Error ? error.message : String(error);
      writeStorageGuardLog(`[storage] startup backup skipped: ${message}`);
    }
  }

  getSchemaVersion(): number {
    return readUserVersion(this.db);
  }

  getMigrationStatus(): MigrationStatusRecord {
    const schemaVersion = this.getSchemaVersion();
    const rows = this.db
      .prepare(
        `SELECT version, name, applied_at
         FROM schema_migrations
         ORDER BY version ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const recorded = rows
      .map((row) => ({
        version: Number(row.version ?? 0),
        name: asNullableString(row.name),
        applied_at: asNullableString(row.applied_at),
        source: "recorded" as const,
      }))
      .filter((entry) => Number.isInteger(entry.version) && entry.version > 0);

    const recordedVersionSet = new Set<number>(recorded.map((entry) => entry.version));
    const inferred: MigrationStatusRecord["applied_versions"] = [];
    for (let version = 1; version <= schemaVersion; version += 1) {
      if (!recordedVersionSet.has(version)) {
        inferred.push({
          version,
          name: null,
          applied_at: null,
          source: "inferred-user-version",
        });
      }
    }

    const appliedVersions = [...recorded, ...inferred].sort((a, b) => a.version - b.version);
    return {
      schema_version: schemaVersion,
      applied_versions: appliedVersions,
      recorded_count: recorded.length,
      inferred_count: inferred.length,
    };
  }

  insertNote(params: {
    text: string;
    source?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    trust_tier?: TrustTier;
    expires_at?: string;
    promoted_from_note_id?: string;
    tags?: string[];
    related_paths?: string[];
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const tags = params.tags ?? [];
    const relatedPaths = params.related_paths ?? [];
    const trustTier = params.trust_tier ?? "raw";
    const stmt = this.db.prepare(
      `INSERT INTO notes (
        id, created_at, source, source_client, source_model, source_agent,
        trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      createdAt,
      params.source ?? null,
      params.source_client ?? null,
      params.source_model ?? null,
      params.source_agent ?? null,
      trustTier,
      params.expires_at ?? null,
      params.promoted_from_note_id ?? null,
      JSON.stringify(tags),
      JSON.stringify(relatedPaths),
      params.text
    );
    return { id, created_at: createdAt };
  }

  getNoteById(noteId: string): NoteRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at, source, source_client, source_model, source_agent,
                trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapNoteRow(row);
  }

  searchNotes(params: {
    query?: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    trust_tiers?: TrustTier[];
    include_expired?: boolean;
    limit: number;
  }): NoteRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `SELECT id, created_at, source, source_client, source_model, source_agent,
                    trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
             FROM notes
             WHERE text LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, source, source_client, source_model, source_agent,
                    trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
             FROM notes
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit * 20) as Array<Record<string, unknown>>);

    const nowIso = new Date().toISOString();
    const tagFilter = params.tags?.map((tag) => tag.toLowerCase()) ?? [];
    const trustFilter = new Set((params.trust_tiers ?? []).map((tier) => String(tier)));
    const includeExpired = params.include_expired ?? true;

    const results: NoteRecord[] = [];
    for (const row of rows) {
      const note = mapNoteRow(row);
      if (tagFilter.length > 0) {
        const lowerTags = note.tags.map((tag) => tag.toLowerCase());
        const hasAll = tagFilter.every((tag) => lowerTags.includes(tag));
        if (!hasAll) {
          continue;
        }
      }
      if (params.source_client && note.source_client !== params.source_client) {
        continue;
      }
      if (params.source_model && note.source_model !== params.source_model) {
        continue;
      }
      if (params.source_agent && note.source_agent !== params.source_agent) {
        continue;
      }
      if (trustFilter.size > 0 && !trustFilter.has(note.trust_tier)) {
        continue;
      }
      if (!includeExpired && note.expires_at && note.expires_at <= nowIso) {
        continue;
      }
      note.score = computeTermScore(note.text, query);
      results.push(note);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  insertMemory(params: {
    content: string;
    keywords?: string[];
    decay_score?: number;
  }): { id: number; created_at: string; last_accessed_at: string } {
    const now = new Date().toISOString();
    const keywords = normalizeKeywords(params.keywords);
    const stmt = this.db.prepare(
      `INSERT INTO memories (content, keywords, created_at, last_accessed_at, decay_score)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      params.content,
      keywords.join(", "),
      now,
      now,
      params.decay_score ?? 1.0
    );
    return {
      id: Number(result.lastInsertRowid),
      created_at: now,
      last_accessed_at: now,
    };
  }

  getMemoryById(memoryId: number): MemoryRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         WHERE id = ?`
      )
      .get(memoryId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapMemoryRow(row);
  }

  touchMemory(memoryId: number): { touched: boolean; last_accessed_at: string } {
    const timestamp = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`)
      .run(timestamp, memoryId);
    return {
      touched: Number(result.changes ?? 0) > 0,
      last_accessed_at: timestamp,
    };
  }

  searchMemories(params: {
    query: string;
    limit: number;
  }): MemoryRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         WHERE content LIKE ? OR keywords LIKE ?
         ORDER BY last_accessed_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as Array<Record<string, unknown>>;

    const accessedAt = new Date().toISOString();
    const result = rows.map((row) => {
      const memory = mapMemoryRow(row);
      memory.score = computeTermScore(`${memory.content} ${memory.keywords.join(" ")}`, query);
      memory.last_accessed_at = accessedAt;
      return memory;
    });

    if (result.length > 0) {
      const updateStmt = this.db.prepare(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`);
      const tx = this.db.transaction((ids: number[]) => {
        for (const id of ids) {
          updateStmt.run(accessedAt, id);
        }
      });
      tx(result.map((entry) => entry.id));
    }

    return result;
  }

  listRecentMemories(limit: number): MemoryRecord[] {
    if (limit <= 0) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapMemoryRow(row));
  }

  decayNotes(params: {
    older_than_iso: string;
    from_tiers: TrustTier[];
    to_tier: TrustTier;
    limit: number;
  }): { updated_ids: string[] } {
    if (params.from_tiers.length === 0) {
      return { updated_ids: [] };
    }
    const limit = Math.max(1, Math.min(500, params.limit));
    const placeholders = params.from_tiers.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id
         FROM notes
         WHERE created_at <= ?
           AND trust_tier IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(params.older_than_iso, ...params.from_tiers, limit) as Array<Record<string, unknown>>;
    const ids = rows.map((row) => String(row.id));
    if (ids.length === 0) {
      return { updated_ids: [] };
    }
    const updateStmt = this.db.prepare(`UPDATE notes SET trust_tier = ? WHERE id = ?`);
    const tx = this.db.transaction((noteIds: string[]) => {
      for (const noteId of noteIds) {
        updateStmt.run(params.to_tier, noteId);
      }
    });
    tx(ids);
    return { updated_ids: ids };
  }

  insertTranscript(params: {
    session_id: string;
    source_client: string;
    source_model?: string;
    source_agent?: string;
    kind: string;
    text: string;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO transcripts (id, created_at, session_id, source_client, source_model, source_agent, kind, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      createdAt,
      params.session_id,
      params.source_client,
      params.source_model ?? null,
      params.source_agent ?? null,
      params.kind,
      params.text
    );
    return { id, created_at: createdAt };
  }

  insertTranscriptLine(params: {
    run_id?: string;
    role: string;
    content: string;
    is_squished?: boolean;
  }): { id: number; timestamp: string } {
    const timestamp = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO transcript_lines (run_id, role, content, timestamp, is_squished)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      params.run_id ?? null,
      params.role,
      params.content,
      timestamp,
      params.is_squished ? 1 : 0
    );
    return {
      id: Number(result.lastInsertRowid),
      timestamp,
    };
  }

  getTranscriptLinesByRun(runId: string, limit = 1000): TranscriptLineRecord[] {
    const boundedLimit = Math.max(1, Math.min(5000, limit));
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE run_id = ?
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptLineRow(row));
  }

  getTranscriptLineById(lineId: number): TranscriptLineRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE id = ?`
      )
      .get(lineId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTranscriptLineRow(row);
  }

  getUnsquishedTranscriptLines(runId: string, limit = 500): TranscriptLineRecord[] {
    const boundedLimit = Math.max(1, Math.min(5000, limit));
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE run_id = ?
           AND is_squished = 0
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptLineRow(row));
  }

  searchTranscriptLines(params: {
    query: string;
    run_id?: string;
    include_squished?: boolean;
    limit: number;
  }): TranscriptLineRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE content LIKE ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>;

    const includeSquished = params.include_squished ?? true;
    const result: TranscriptLineRecord[] = [];
    for (const row of rows) {
      const line = mapTranscriptLineRow(row);
      if (params.run_id && line.run_id !== params.run_id) {
        continue;
      }
      if (!includeSquished && line.is_squished) {
        continue;
      }
      line.score = computeTermScore(line.content, query);
      result.push(line);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  listRecentTranscriptLines(params: {
    limit: number;
    include_squished?: boolean;
  }): TranscriptLineRecord[] {
    if (params.limit <= 0) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(2000, params.limit));
    const includeSquished = params.include_squished ?? true;
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(boundedLimit * 4) as Array<Record<string, unknown>>;

    const result: TranscriptLineRecord[] = [];
    for (const row of rows) {
      const line = mapTranscriptLineRow(row);
      if (!includeSquished && line.is_squished) {
        continue;
      }
      result.push(line);
      if (result.length >= boundedLimit) {
        break;
      }
    }
    return result;
  }

  markTranscriptLinesSquished(lineIds: number[]): { updated_count: number } {
    if (lineIds.length === 0) {
      return { updated_count: 0 };
    }
    const stmt = this.db.prepare(`UPDATE transcript_lines SET is_squished = 1 WHERE id = ?`);
    const tx = this.db.transaction((ids: number[]) => {
      let updated = 0;
      for (const id of ids) {
        const result = stmt.run(id);
        updated += Number(result.changes ?? 0);
      }
      return updated;
    });
    return { updated_count: tx(lineIds) };
  }

  listTranscriptRunsWithPending(limit = 50): Array<{
    run_id: string;
    unsquished_count: number;
    oldest_timestamp: string;
    last_timestamp: string;
  }> {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT run_id,
                COUNT(*) AS unsquished_count,
                MIN(timestamp) AS oldest_timestamp,
                MAX(timestamp) AS last_timestamp
         FROM transcript_lines
         WHERE run_id IS NOT NULL
           AND is_squished = 0
         GROUP BY run_id
         ORDER BY last_timestamp DESC
         LIMIT ?`
      )
      .all(boundedLimit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      run_id: String(row.run_id ?? ""),
      unsquished_count: Number(row.unsquished_count ?? 0),
      oldest_timestamp: String(row.oldest_timestamp ?? ""),
      last_timestamp: String(row.last_timestamp ?? ""),
    }));
  }

  pruneTranscriptLines(params: {
    older_than_iso: string;
    include_unsquished: boolean;
    run_id?: string;
    limit: number;
    dry_run?: boolean;
  }): { candidate_count: number; deleted_count: number; deleted_ids: number[] } {
    const limit = Math.max(1, Math.min(5000, params.limit));
    const whereClauses = ["timestamp <= ?"];
    const values: Array<string | number> = [params.older_than_iso];

    if (!params.include_unsquished) {
      whereClauses.push("is_squished = 1");
    }
    if (params.run_id) {
      whereClauses.push("run_id = ?");
      values.push(params.run_id);
    }

    const idRows = this.db
      .prepare(
        `SELECT id
         FROM transcript_lines
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;

    const ids = idRows.map((row) => Number(row.id ?? 0)).filter((id) => Number.isInteger(id) && id > 0);
    if (params.dry_run || ids.length === 0) {
      return {
        candidate_count: ids.length,
        deleted_count: 0,
        deleted_ids: [],
      };
    }

    const deleteStmt = this.db.prepare(`DELETE FROM transcript_lines WHERE id = ?`);
    const tx = this.db.transaction((lineIds: number[]) => {
      let deleted = 0;
      for (const lineId of lineIds) {
        const result = deleteStmt.run(lineId);
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    });

    const deletedCount = tx(ids);
    return {
      candidate_count: ids.length,
      deleted_count: deletedCount,
      deleted_ids: ids,
    };
  }

  getTranscriptAutoSquishState(): TranscriptAutoSquishStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("transcript.auto_squish") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 60, 5, 3600),
      batch_runs: parseBoundedInt(config.batch_runs, 10, 1, 200),
      per_run_limit: parseBoundedInt(config.per_run_limit, 200, 1, 5000),
      max_points: parseBoundedInt(config.max_points, 8, 3, 20),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTranscriptAutoSquishState(params: {
    enabled: boolean;
    interval_seconds: number;
    batch_runs: number;
    per_run_limit: number;
    max_points: number;
  }): TranscriptAutoSquishStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 60, 5, 3600),
      batch_runs: parseBoundedInt(params.batch_runs, 10, 1, 200),
      per_run_limit: parseBoundedInt(params.per_run_limit, 200, 1, 5000),
      max_points: parseBoundedInt(params.max_points, 8, 3, 20),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      batch_runs: normalized.batch_runs,
      per_run_limit: normalized.per_run_limit,
      max_points: normalized.max_points,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("transcript.auto_squish", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTaskAutoRetryState(): TaskAutoRetryStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("task.auto_retry") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const baseDelaySeconds = parseBoundedInt(config.base_delay_seconds, 30, 0, 86400);
    const maxDelaySeconds = parseBoundedInt(config.max_delay_seconds, 3600, 0, 604800);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 60, 5, 3600),
      batch_limit: parseBoundedInt(config.batch_limit, 20, 1, 500),
      base_delay_seconds: baseDelaySeconds,
      max_delay_seconds: Math.max(baseDelaySeconds, maxDelaySeconds),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTaskAutoRetryState(params: {
    enabled: boolean;
    interval_seconds: number;
    batch_limit: number;
    base_delay_seconds: number;
    max_delay_seconds: number;
  }): TaskAutoRetryStateRecord {
    const now = new Date().toISOString();
    const baseDelaySeconds = parseBoundedInt(params.base_delay_seconds, 30, 0, 86400);
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 60, 5, 3600),
      batch_limit: parseBoundedInt(params.batch_limit, 20, 1, 500),
      base_delay_seconds: baseDelaySeconds,
      max_delay_seconds: Math.max(baseDelaySeconds, parseBoundedInt(params.max_delay_seconds, 3600, 0, 604800)),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      batch_limit: normalized.batch_limit,
      base_delay_seconds: normalized.base_delay_seconds,
      max_delay_seconds: normalized.max_delay_seconds,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("task.auto_retry", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getGoalAutorunState(): GoalAutorunStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("goal.autorun") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 90, 5, 3600),
      limit: parseBoundedInt(config.limit, 10, 1, 100),
      create_plan_if_missing: config.create_plan_if_missing !== false,
      dispatch_limit: parseBoundedInt(config.dispatch_limit, 20, 1, 100),
      max_passes: parseBoundedInt(config.max_passes, 4, 1, 20),
      pack_id: asNullableString(config.pack_id)?.trim() || "agentic",
      hook_name: asNullableString(config.hook_name)?.trim() || null,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setGoalAutorunState(params: {
    enabled: boolean;
    interval_seconds: number;
    limit: number;
    create_plan_if_missing: boolean;
    dispatch_limit: number;
    max_passes: number;
    pack_id: string;
    hook_name?: string | null;
  }): GoalAutorunStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 90, 5, 3600),
      limit: parseBoundedInt(params.limit, 10, 1, 100),
      create_plan_if_missing: params.create_plan_if_missing !== false,
      dispatch_limit: parseBoundedInt(params.dispatch_limit, 20, 1, 100),
      max_passes: parseBoundedInt(params.max_passes, 4, 1, 20),
      pack_id: params.pack_id.trim() || "agentic",
      hook_name: params.hook_name?.trim() || null,
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      limit: normalized.limit,
      create_plan_if_missing: normalized.create_plan_if_missing,
      dispatch_limit: normalized.dispatch_limit,
      max_passes: normalized.max_passes,
      pack_id: normalized.pack_id,
      hook_name: normalized.hook_name,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("goal.autorun", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getAutonomyMaintainState(): AutonomyMaintainStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("autonomy.maintain") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      local_host_id: asNullableString(config.local_host_id)?.trim() || "local",
      interval_seconds: parseBoundedInt(config.interval_seconds, 120, 5, 3600),
      learning_review_interval_seconds: parseBoundedInt(config.learning_review_interval_seconds, 300, 60, 604800),
      enable_self_drive: typeof config.enable_self_drive === "boolean" ? config.enable_self_drive : true,
      self_drive_cooldown_seconds: parseBoundedInt(config.self_drive_cooldown_seconds, 1800, 60, 86400),
      run_eval_if_due: typeof config.run_eval_if_due === "boolean" ? config.run_eval_if_due : true,
      eval_interval_seconds: parseBoundedInt(config.eval_interval_seconds, 21600, 300, 604800),
      eval_suite_id: asNullableString(config.eval_suite_id)?.trim() || "autonomy.control-plane",
      minimum_eval_score: parseBoundedInt(config.minimum_eval_score, 75, 0, 100),
      last_run_at: asNullableString(config.last_run_at)?.trim() || null,
      last_bootstrap_ready_at: asNullableString(config.last_bootstrap_ready_at)?.trim() || null,
      last_goal_autorun_daemon_at: asNullableString(config.last_goal_autorun_daemon_at)?.trim() || null,
      last_tmux_maintained_at: asNullableString(config.last_tmux_maintained_at)?.trim() || null,
      last_learning_review_at: asNullableString(config.last_learning_review_at)?.trim() || null,
      last_learning_entry_count: parseBoundedInt(config.last_learning_entry_count, 0, 0, 1_000_000),
      last_learning_active_agent_count: parseBoundedInt(config.last_learning_active_agent_count, 0, 0, 1_000_000),
      last_eval_run_at: asNullableString(config.last_eval_run_at)?.trim() || null,
      last_eval_run_id: asNullableString(config.last_eval_run_id)?.trim() || null,
      last_eval_score:
        typeof config.last_eval_score === "number" && Number.isFinite(config.last_eval_score)
          ? Number(config.last_eval_score.toFixed(4))
          : null,
      last_eval_dependency_fingerprint: asNullableString(config.last_eval_dependency_fingerprint)?.trim() || null,
      last_observability_ship_at: asNullableString(config.last_observability_ship_at)?.trim() || null,
      last_provider_bridge_check_at: asNullableString(config.last_provider_bridge_check_at)?.trim() || null,
      provider_bridge_diagnostics: Array.isArray(config.provider_bridge_diagnostics)
        ? config.provider_bridge_diagnostics
            .map((entry) => normalizeProviderBridgeDiagnosticSnapshot(entry))
            .filter((entry): entry is ProviderBridgeDiagnosticSnapshotRecord => entry !== null)
        : [],
      last_self_drive_at: asNullableString(config.last_self_drive_at)?.trim() || null,
      last_self_drive_goal_id: asNullableString(config.last_self_drive_goal_id)?.trim() || null,
      last_self_drive_fingerprint: asNullableString(config.last_self_drive_fingerprint)?.trim() || null,
      last_actions: dedupeNonEmpty(Array.isArray(config.last_actions) ? config.last_actions.map((entry) => String(entry ?? "")) : []),
      last_attention: dedupeNonEmpty(Array.isArray(config.last_attention) ? config.last_attention.map((entry) => String(entry ?? "")) : []),
      last_error: asNullableString(config.last_error)?.trim() || null,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setAutonomyMaintainState(params: {
    enabled: boolean;
    local_host_id?: string;
    interval_seconds: number;
    learning_review_interval_seconds: number;
    enable_self_drive?: boolean;
    self_drive_cooldown_seconds?: number;
    run_eval_if_due?: boolean;
    eval_interval_seconds: number;
    eval_suite_id?: string;
    minimum_eval_score?: number;
    last_run_at?: string | null;
    last_bootstrap_ready_at?: string | null;
    last_goal_autorun_daemon_at?: string | null;
    last_tmux_maintained_at?: string | null;
    last_learning_review_at?: string | null;
    last_learning_entry_count?: number;
    last_learning_active_agent_count?: number;
    last_eval_run_at?: string | null;
    last_eval_run_id?: string | null;
    last_eval_score?: number | null;
    last_eval_dependency_fingerprint?: string | null;
    last_observability_ship_at?: string | null;
    last_provider_bridge_check_at?: string | null;
    provider_bridge_diagnostics?: ProviderBridgeDiagnosticSnapshotRecord[];
    last_self_drive_at?: string | null;
    last_self_drive_goal_id?: string | null;
    last_self_drive_fingerprint?: string | null;
    last_actions?: string[];
    last_attention?: string[];
    last_error?: string | null;
  }): AutonomyMaintainStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      local_host_id: params.local_host_id?.trim() || "local",
      interval_seconds: parseBoundedInt(params.interval_seconds, 120, 5, 3600),
      learning_review_interval_seconds: parseBoundedInt(params.learning_review_interval_seconds, 300, 60, 604800),
      enable_self_drive: typeof params.enable_self_drive === "boolean" ? params.enable_self_drive : true,
      self_drive_cooldown_seconds: parseBoundedInt(params.self_drive_cooldown_seconds, 1800, 60, 86400),
      run_eval_if_due: typeof params.run_eval_if_due === "boolean" ? params.run_eval_if_due : true,
      eval_interval_seconds: parseBoundedInt(params.eval_interval_seconds, 21600, 300, 604800),
      eval_suite_id: params.eval_suite_id?.trim() || "autonomy.control-plane",
      minimum_eval_score: parseBoundedInt(params.minimum_eval_score, 75, 0, 100),
      last_run_at: params.last_run_at?.trim() || null,
      last_bootstrap_ready_at: params.last_bootstrap_ready_at?.trim() || null,
      last_goal_autorun_daemon_at: params.last_goal_autorun_daemon_at?.trim() || null,
      last_tmux_maintained_at: params.last_tmux_maintained_at?.trim() || null,
      last_learning_review_at: params.last_learning_review_at?.trim() || null,
      last_learning_entry_count: parseBoundedInt(params.last_learning_entry_count, 0, 0, 1_000_000),
      last_learning_active_agent_count: parseBoundedInt(params.last_learning_active_agent_count, 0, 0, 1_000_000),
      last_eval_run_at: params.last_eval_run_at?.trim() || null,
      last_eval_run_id: params.last_eval_run_id?.trim() || null,
      last_eval_score:
        typeof params.last_eval_score === "number" && Number.isFinite(params.last_eval_score)
          ? Number(params.last_eval_score.toFixed(4))
          : null,
      last_eval_dependency_fingerprint: params.last_eval_dependency_fingerprint?.trim() || null,
      last_observability_ship_at: params.last_observability_ship_at?.trim() || null,
      last_provider_bridge_check_at: params.last_provider_bridge_check_at?.trim() || null,
      provider_bridge_diagnostics: (params.provider_bridge_diagnostics ?? [])
        .map((entry) => normalizeProviderBridgeDiagnosticSnapshot(entry))
        .filter((entry): entry is ProviderBridgeDiagnosticSnapshotRecord => entry !== null),
      last_self_drive_at: params.last_self_drive_at?.trim() || null,
      last_self_drive_goal_id: params.last_self_drive_goal_id?.trim() || null,
      last_self_drive_fingerprint: params.last_self_drive_fingerprint?.trim() || null,
      last_actions: [...new Set((params.last_actions ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean))],
      last_attention: [...new Set((params.last_attention ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean))],
      last_error: params.last_error?.trim() || null,
    };
    const configJson = stableStringify({
      local_host_id: normalized.local_host_id,
      interval_seconds: normalized.interval_seconds,
      learning_review_interval_seconds: normalized.learning_review_interval_seconds,
      enable_self_drive: normalized.enable_self_drive,
      self_drive_cooldown_seconds: normalized.self_drive_cooldown_seconds,
      run_eval_if_due: normalized.run_eval_if_due,
      eval_interval_seconds: normalized.eval_interval_seconds,
      eval_suite_id: normalized.eval_suite_id,
      minimum_eval_score: normalized.minimum_eval_score,
      last_run_at: normalized.last_run_at,
      last_bootstrap_ready_at: normalized.last_bootstrap_ready_at,
      last_goal_autorun_daemon_at: normalized.last_goal_autorun_daemon_at,
      last_tmux_maintained_at: normalized.last_tmux_maintained_at,
      last_learning_review_at: normalized.last_learning_review_at,
      last_learning_entry_count: normalized.last_learning_entry_count,
      last_learning_active_agent_count: normalized.last_learning_active_agent_count,
      last_eval_run_at: normalized.last_eval_run_at,
      last_eval_run_id: normalized.last_eval_run_id,
      last_eval_score: normalized.last_eval_score,
      last_eval_dependency_fingerprint: normalized.last_eval_dependency_fingerprint,
      last_observability_ship_at: normalized.last_observability_ship_at,
      last_provider_bridge_check_at: normalized.last_provider_bridge_check_at,
      provider_bridge_diagnostics: normalized.provider_bridge_diagnostics,
      last_self_drive_at: normalized.last_self_drive_at,
      last_self_drive_goal_id: normalized.last_self_drive_goal_id,
      last_self_drive_fingerprint: normalized.last_self_drive_fingerprint,
      last_actions: normalized.last_actions,
      last_attention: normalized.last_attention,
      last_error: normalized.last_error,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("autonomy.maintain", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getReactionEngineState(): ReactionEngineStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("reaction.engine") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const recentNotifications: ReactionEngineNotificationRecord[] = Array.isArray(config.recent_notifications)
      ? config.recent_notifications
          .map((entry) => parseLooseObject(entry))
          .map((entry): ReactionEngineNotificationRecord => {
            const level: ReactionEngineNotificationRecord["level"] =
              entry.level === "critical" || entry.level === "warn" || entry.level === "info"
                ? entry.level
                : "info";
            return {
              key: String(entry.key ?? "").trim(),
              title: String(entry.title ?? "").trim(),
              level,
              sent_at: asNullableString(entry.sent_at)?.trim() || "",
            };
          })
          .filter((entry) => entry.key && entry.sent_at)
      : [];

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 120, 5, 3600),
      dedupe_window_seconds: parseBoundedInt(config.dedupe_window_seconds, 1800, 30, 604800),
      channels: dedupeNonEmpty(Array.isArray(config.channels) ? config.channels.map((entry) => String(entry ?? "")) : ["desktop"]),
      last_run_at: asNullableString(config.last_run_at)?.trim() || null,
      last_sent_at: asNullableString(config.last_sent_at)?.trim() || null,
      last_sent_count: parseBoundedInt(config.last_sent_count, 0, 0, 1_000_000),
      last_alert_key: asNullableString(config.last_alert_key)?.trim() || null,
      last_alert_seen_count: parseBoundedInt(config.last_alert_seen_count, 0, 0, 1_000_000),
      recent_notifications: recentNotifications.slice(-40),
      last_error: asNullableString(config.last_error)?.trim() || null,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setReactionEngineState(params: {
    enabled: boolean;
    interval_seconds: number;
    dedupe_window_seconds: number;
    channels: string[];
    last_run_at?: string | null;
    last_sent_at?: string | null;
    last_sent_count?: number;
    last_alert_key?: string | null;
    last_alert_seen_count?: number;
    recent_notifications?: ReactionEngineNotificationRecord[];
    last_error?: string | null;
  }): ReactionEngineStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 120, 5, 3600),
      dedupe_window_seconds: parseBoundedInt(params.dedupe_window_seconds, 1800, 30, 604800),
      channels: dedupeNonEmpty((params.channels ?? ["desktop"]).map((entry) => String(entry ?? "").trim())),
      last_run_at: params.last_run_at?.trim() || null,
      last_sent_at: params.last_sent_at?.trim() || null,
      last_sent_count: parseBoundedInt(params.last_sent_count, 0, 0, 1_000_000),
      last_alert_key: params.last_alert_key?.trim() || null,
      last_alert_seen_count: parseBoundedInt(params.last_alert_seen_count, 0, 0, 1_000_000),
      recent_notifications: (params.recent_notifications ?? [])
        .map((entry) => ({
          key: String(entry.key ?? "").trim(),
          title: String(entry.title ?? "").trim(),
          level:
            entry.level === "critical" || entry.level === "warn" || entry.level === "info"
              ? entry.level
              : "info",
          sent_at: String(entry.sent_at ?? "").trim(),
        }))
        .filter((entry) => entry.key && entry.sent_at)
        .slice(-40),
      last_error: params.last_error?.trim() || null,
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      dedupe_window_seconds: normalized.dedupe_window_seconds,
      channels: normalized.channels,
      last_run_at: normalized.last_run_at,
      last_sent_at: normalized.last_sent_at,
      last_sent_count: normalized.last_sent_count,
      last_alert_key: normalized.last_alert_key,
      last_alert_seen_count: normalized.last_alert_seen_count,
      recent_notifications: normalized.recent_notifications,
      last_error: normalized.last_error,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("reaction.engine", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatAutoRetentionState(): TriChatAutoRetentionStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.auto_retention") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 600, 10, 86400),
      older_than_days: parseBoundedInt(config.older_than_days, 30, 0, 3650),
      limit: parseBoundedInt(config.limit, 1000, 1, 5000),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatAutoRetentionState(params: {
    enabled: boolean;
    interval_seconds: number;
    older_than_days: number;
    limit: number;
  }): TriChatAutoRetentionStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 600, 10, 86400),
      older_than_days: parseBoundedInt(params.older_than_days, 30, 0, 3650),
      limit: parseBoundedInt(params.limit, 1000, 1, 5000),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      older_than_days: normalized.older_than_days,
      limit: normalized.limit,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.auto_retention", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatTurnWatchdogState(): TriChatTurnWatchdogStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.turn_watchdog") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 30, 5, 3600),
      stale_after_seconds: parseBoundedInt(config.stale_after_seconds, 180, 15, 86400),
      batch_limit: parseBoundedInt(config.batch_limit, 10, 1, 200),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatTurnWatchdogState(params: {
    enabled: boolean;
    interval_seconds: number;
    stale_after_seconds: number;
    batch_limit: number;
  }): TriChatTurnWatchdogStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 30, 5, 3600),
      stale_after_seconds: parseBoundedInt(params.stale_after_seconds, 180, 15, 86400),
      batch_limit: parseBoundedInt(params.batch_limit, 10, 1, 200),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      stale_after_seconds: normalized.stale_after_seconds,
      batch_limit: normalized.batch_limit,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.turn_watchdog", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatAutopilotState(): TriChatAutopilotStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.autopilot") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const awayModeRaw = String(config.away_mode ?? "normal").trim().toLowerCase();
    const awayMode: TriChatAutopilotStateRecord["away_mode"] =
      awayModeRaw === "safe" || awayModeRaw === "aggressive" ? awayModeRaw : "normal";
    const threadStatusRaw = String(config.thread_status ?? "archived").trim().toLowerCase();
    const threadStatus: TriChatAutopilotStateRecord["thread_status"] =
      threadStatusRaw === "active" ? "active" : "archived";
    const adrPolicyRaw = String(config.adr_policy ?? "every_success").trim().toLowerCase();
    const adrPolicy: TriChatAutopilotStateRecord["adr_policy"] =
      adrPolicyRaw === "manual" || adrPolicyRaw === "high_impact" ? adrPolicyRaw : "every_success";
    const executeBackendRaw = String(config.execute_backend ?? "auto").trim().toLowerCase();
    const executeBackend: TriChatAutopilotStateRecord["execute_backend"] =
      executeBackendRaw === "direct" || executeBackendRaw === "tmux" ? executeBackendRaw : "auto";
    const commandAllowlist = dedupeNonEmpty(
      Array.isArray(config.command_allowlist)
        ? (config.command_allowlist as unknown[]).map((entry) => String(entry ?? ""))
        : []
    );
    const lockKeyRaw = String(config.lock_key ?? "").trim();

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      away_mode: awayMode,
      interval_seconds: parseBoundedInt(config.interval_seconds, 300, 10, 86400),
      thread_id: String(config.thread_id ?? "trichat-autopilot-internal").trim() || "trichat-autopilot-internal",
      thread_title: String(config.thread_title ?? "TriChat Autopilot").trim() || "TriChat Autopilot",
      thread_status: threadStatus,
      objective:
        String(
          config.objective ??
            "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop."
        ).trim() ||
        "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop.",
      lead_agent_id: asNullableString(config.lead_agent_id),
      specialist_agent_ids: dedupeNonEmpty(
        Array.isArray(config.specialist_agent_ids)
          ? (config.specialist_agent_ids as unknown[]).map((entry) => String(entry ?? ""))
          : []
      ),
      max_rounds: parseBoundedInt(config.max_rounds, 2, 1, 6),
      min_success_agents: parseBoundedInt(config.min_success_agents, 2, 1, 3),
      bridge_timeout_seconds: parseBoundedInt(config.bridge_timeout_seconds, 180, 5, 7200),
      bridge_dry_run: parseBoolean(config.bridge_dry_run, false),
      execute_enabled: parseBoolean(config.execute_enabled, true),
      command_allowlist: commandAllowlist,
      execute_backend: executeBackend,
      tmux_session_name:
        String(config.tmux_session_name ?? "trichat-autopilot").trim() || "trichat-autopilot",
      tmux_worker_count: parseBoundedInt(config.tmux_worker_count, 3, 1, 12),
      tmux_max_queue_per_worker: parseBoundedInt(config.tmux_max_queue_per_worker, 6, 1, 200),
      tmux_auto_scale_workers: parseBoolean(config.tmux_auto_scale_workers, true),
      tmux_sync_after_dispatch: parseBoolean(config.tmux_sync_after_dispatch, true),
      confidence_threshold: parseBoundedFloat(config.confidence_threshold, 0.45, 0.05, 1),
      max_consecutive_errors: parseBoundedInt(config.max_consecutive_errors, 3, 1, 20),
      lock_key: lockKeyRaw || null,
      lock_lease_seconds: parseBoundedInt(config.lock_lease_seconds, 600, 15, 3600),
      adr_policy: adrPolicy,
      pause_reason: asNullableString(config.pause_reason),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatAutopilotState(params: {
    enabled: boolean;
    away_mode: "safe" | "normal" | "aggressive";
    interval_seconds: number;
    thread_id: string;
    thread_title: string;
    thread_status: "active" | "archived";
    objective: string;
    lead_agent_id?: string | null;
    specialist_agent_ids?: string[];
    max_rounds: number;
    min_success_agents: number;
    bridge_timeout_seconds: number;
    bridge_dry_run: boolean;
    execute_enabled: boolean;
    command_allowlist: string[];
    execute_backend: "direct" | "tmux" | "auto";
    tmux_session_name: string;
    tmux_worker_count: number;
    tmux_max_queue_per_worker: number;
    tmux_auto_scale_workers: boolean;
    tmux_sync_after_dispatch: boolean;
    confidence_threshold: number;
    max_consecutive_errors: number;
    lock_key?: string | null;
    lock_lease_seconds: number;
    adr_policy: "every_success" | "high_impact" | "manual";
    pause_reason?: string | null;
  }): TriChatAutopilotStateRecord {
    const now = new Date().toISOString();
    const awayMode: TriChatAutopilotStateRecord["away_mode"] =
      params.away_mode === "safe" || params.away_mode === "aggressive" ? params.away_mode : "normal";
    const threadStatus: TriChatAutopilotStateRecord["thread_status"] =
      params.thread_status === "active" ? "active" : "archived";
    const adrPolicy: TriChatAutopilotStateRecord["adr_policy"] =
      params.adr_policy === "manual" || params.adr_policy === "high_impact"
        ? params.adr_policy
        : "every_success";
    const executeBackend: TriChatAutopilotStateRecord["execute_backend"] =
      params.execute_backend === "direct" || params.execute_backend === "tmux"
        ? params.execute_backend
        : "auto";
    const lockKey = String(params.lock_key ?? "").trim();
    const normalized = {
      enabled: Boolean(params.enabled),
      away_mode: awayMode,
      interval_seconds: parseBoundedInt(params.interval_seconds, 300, 10, 86400),
      thread_id: String(params.thread_id ?? "").trim() || "trichat-autopilot-internal",
      thread_title: String(params.thread_title ?? "").trim() || "TriChat Autopilot",
      thread_status: threadStatus,
      objective:
        String(params.objective ?? "").trim() ||
        "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop.",
      lead_agent_id: asNullableString(params.lead_agent_id),
      specialist_agent_ids: dedupeNonEmpty(params.specialist_agent_ids ?? []),
      max_rounds: parseBoundedInt(params.max_rounds, 2, 1, 6),
      min_success_agents: parseBoundedInt(params.min_success_agents, 2, 1, 3),
      bridge_timeout_seconds: parseBoundedInt(params.bridge_timeout_seconds, 180, 5, 7200),
      bridge_dry_run: Boolean(params.bridge_dry_run),
      execute_enabled: Boolean(params.execute_enabled),
      command_allowlist: dedupeNonEmpty(params.command_allowlist ?? []),
      execute_backend: executeBackend,
      tmux_session_name: String(params.tmux_session_name ?? "").trim() || "trichat-autopilot",
      tmux_worker_count: parseBoundedInt(params.tmux_worker_count, 3, 1, 12),
      tmux_max_queue_per_worker: parseBoundedInt(params.tmux_max_queue_per_worker, 6, 1, 200),
      tmux_auto_scale_workers: Boolean(params.tmux_auto_scale_workers),
      tmux_sync_after_dispatch: Boolean(params.tmux_sync_after_dispatch),
      confidence_threshold: parseBoundedFloat(params.confidence_threshold, 0.45, 0.05, 1),
      max_consecutive_errors: parseBoundedInt(params.max_consecutive_errors, 3, 1, 20),
      lock_key: lockKey || null,
      lock_lease_seconds: parseBoundedInt(params.lock_lease_seconds, 600, 15, 3600),
      adr_policy: adrPolicy,
      pause_reason: asNullableString(params.pause_reason),
    };
    const configJson = stableStringify({
      away_mode: normalized.away_mode,
      interval_seconds: normalized.interval_seconds,
      thread_id: normalized.thread_id,
      thread_title: normalized.thread_title,
      thread_status: normalized.thread_status,
      objective: normalized.objective,
      lead_agent_id: normalized.lead_agent_id,
      specialist_agent_ids: normalized.specialist_agent_ids,
      max_rounds: normalized.max_rounds,
      min_success_agents: normalized.min_success_agents,
      bridge_timeout_seconds: normalized.bridge_timeout_seconds,
      bridge_dry_run: normalized.bridge_dry_run,
      execute_enabled: normalized.execute_enabled,
      command_allowlist: normalized.command_allowlist,
      execute_backend: normalized.execute_backend,
      tmux_session_name: normalized.tmux_session_name,
      tmux_worker_count: normalized.tmux_worker_count,
      tmux_max_queue_per_worker: normalized.tmux_max_queue_per_worker,
      tmux_auto_scale_workers: normalized.tmux_auto_scale_workers,
      tmux_sync_after_dispatch: normalized.tmux_sync_after_dispatch,
      confidence_threshold: normalized.confidence_threshold,
      max_consecutive_errors: normalized.max_consecutive_errors,
      lock_key: normalized.lock_key,
      lock_lease_seconds: normalized.lock_lease_seconds,
      adr_policy: normalized.adr_policy,
      pause_reason: normalized.pause_reason,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.autopilot", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatTmuxControllerState(): TriChatTmuxControllerStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.tmux_controller") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const tasksRaw = Array.isArray(config.tasks) ? (config.tasks as unknown[]) : [];
    const tasks = tasksRaw
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const taskId = String(item.task_id ?? "").trim();
        const command = String(item.command ?? "").trim();
        if (!taskId || !command) {
          return null;
        }
        const statusRaw = String(item.status ?? "queued").trim().toLowerCase();
        const status: TriChatTmuxControllerTaskStatus =
          statusRaw === "dispatched" ||
          statusRaw === "running" ||
          statusRaw === "completed" ||
          statusRaw === "failed" ||
          statusRaw === "cancelled"
            ? statusRaw
            : "queued";
        const createdAtFallback = new Date().toISOString();
        return {
          task_id: taskId,
          seq: parseBoundedInt(item.seq, index + 1, 1, 10_000_000),
          title: String(item.title ?? taskId).trim() || taskId,
          command,
          priority: parseBoundedInt(item.priority, 50, 1, 100),
          complexity: parseBoundedInt(item.complexity, 50, 1, 100),
          worker_id: asNullableString(item.worker_id),
          status,
          created_at: normalizeIsoTimestamp(asNullableString(item.created_at) ?? undefined, createdAtFallback),
          dispatched_at: normalizeOptionalIsoTimestamp(asNullableString(item.dispatched_at)),
          started_at: normalizeOptionalIsoTimestamp(asNullableString(item.started_at)),
          completed_at: normalizeOptionalIsoTimestamp(asNullableString(item.completed_at)),
          exit_code:
            typeof item.exit_code === "number" && Number.isFinite(item.exit_code)
              ? Math.trunc(item.exit_code)
              : item.exit_code === null
                ? null
                : Number.isFinite(Number(item.exit_code))
                  ? Math.trunc(Number(item.exit_code))
                  : null,
          thread_id: asNullableString(item.thread_id),
          turn_id: asNullableString(item.turn_id),
          metadata: parseLooseObject(item.metadata),
        } satisfies TriChatTmuxControllerTaskRecord;
      })
      .filter((entry): entry is TriChatTmuxControllerTaskRecord => Boolean(entry))
      .sort((left, right) => left.seq - right.seq);

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      session_name: String(config.session_name ?? "trichat-controller").trim() || "trichat-controller",
      workspace: String(config.workspace ?? ".").trim() || ".",
      worker_count: parseBoundedInt(config.worker_count, 3, 1, 12),
      shell: String(config.shell ?? "/bin/zsh").trim() || "/bin/zsh",
      max_queue_per_worker: parseBoundedInt(config.max_queue_per_worker, 8, 1, 200),
      next_task_seq: parseBoundedInt(config.next_task_seq, tasks.length + 1, 1, 100_000_000),
      tasks,
      last_dispatch_at: normalizeOptionalIsoTimestamp(asNullableString(config.last_dispatch_at)),
      last_error: asNullableString(config.last_error),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatTmuxControllerState(params: {
    enabled: boolean;
    session_name: string;
    workspace: string;
    worker_count: number;
    shell: string;
    max_queue_per_worker: number;
    next_task_seq: number;
    tasks: TriChatTmuxControllerTaskRecord[];
    last_dispatch_at?: string | null;
    last_error?: string | null;
  }): TriChatTmuxControllerStateRecord {
    const now = new Date().toISOString();
    const normalizedTasks = (params.tasks ?? [])
      .map((task, index) => {
        const taskId = String(task.task_id ?? "").trim();
        const command = String(task.command ?? "").trim();
        if (!taskId || !command) {
          return null;
        }
        const statusRaw = String(task.status ?? "queued").trim().toLowerCase();
        const status: TriChatTmuxControllerTaskStatus =
          statusRaw === "dispatched" ||
          statusRaw === "running" ||
          statusRaw === "completed" ||
          statusRaw === "failed" ||
          statusRaw === "cancelled"
            ? statusRaw
            : "queued";
        return {
          task_id: taskId,
          seq: parseBoundedInt(task.seq, index + 1, 1, 10_000_000),
          title: String(task.title ?? taskId).trim() || taskId,
          command,
          priority: parseBoundedInt(task.priority, 50, 1, 100),
          complexity: parseBoundedInt(task.complexity, 50, 1, 100),
          worker_id: asNullableString(task.worker_id),
          status,
          created_at: normalizeIsoTimestamp(asNullableString(task.created_at) ?? undefined, now),
          dispatched_at: normalizeOptionalIsoTimestamp(asNullableString(task.dispatched_at)),
          started_at: normalizeOptionalIsoTimestamp(asNullableString(task.started_at)),
          completed_at: normalizeOptionalIsoTimestamp(asNullableString(task.completed_at)),
          exit_code:
            typeof task.exit_code === "number" && Number.isFinite(task.exit_code)
              ? Math.trunc(task.exit_code)
              : task.exit_code === null
                ? null
                : Number.isFinite(Number(task.exit_code))
                  ? Math.trunc(Number(task.exit_code))
                  : null,
          thread_id: asNullableString(task.thread_id),
          turn_id: asNullableString(task.turn_id),
          metadata: parseLooseObject(task.metadata),
        } satisfies TriChatTmuxControllerTaskRecord;
      })
      .filter((entry): entry is TriChatTmuxControllerTaskRecord => Boolean(entry))
      .sort((left, right) => left.seq - right.seq);

    const normalized: TriChatTmuxControllerStateRecord = {
      enabled: Boolean(params.enabled),
      session_name: String(params.session_name ?? "").trim() || "trichat-controller",
      workspace: String(params.workspace ?? "").trim() || ".",
      worker_count: parseBoundedInt(params.worker_count, 3, 1, 12),
      shell: String(params.shell ?? "").trim() || "/bin/zsh",
      max_queue_per_worker: parseBoundedInt(params.max_queue_per_worker, 8, 1, 200),
      next_task_seq: parseBoundedInt(params.next_task_seq, normalizedTasks.length + 1, 1, 100_000_000),
      tasks: normalizedTasks,
      last_dispatch_at: normalizeOptionalIsoTimestamp(asNullableString(params.last_dispatch_at)),
      last_error: asNullableString(params.last_error),
      updated_at: now,
    };

    const configJson = stableStringify({
      session_name: normalized.session_name,
      workspace: normalized.workspace,
      worker_count: normalized.worker_count,
      shell: normalized.shell,
      max_queue_per_worker: normalized.max_queue_per_worker,
      next_task_seq: normalized.next_task_seq,
      tasks: normalized.tasks,
      last_dispatch_at: normalized.last_dispatch_at,
      last_error: normalized.last_error,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.tmux_controller", normalized.enabled ? 1 : 0, configJson, now);

    return normalized;
  }

  getImprintAutoSnapshotState(): ImprintAutoSnapshotStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("imprint.auto_snapshot") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      profile_id: asNullableString(config.profile_id),
      interval_seconds: parseBoundedInt(config.interval_seconds, 900, 30, 86400),
      include_recent_memories: parseBoundedInt(config.include_recent_memories, 20, 0, 200),
      include_recent_transcript_lines: parseBoundedInt(config.include_recent_transcript_lines, 40, 0, 1000),
      write_file: parseBoolean(config.write_file, true),
      promote_summary: parseBoolean(config.promote_summary, false),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  getWorkerFabricState(): WorkerFabricStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("worker.fabric") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const hostsRaw = Array.isArray(config.hosts) ? (config.hosts as unknown[]) : [];
    const hosts = hostsRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const hostId = String(item.host_id ?? "").trim();
        const workspaceRoot = String(item.workspace_root ?? "").trim();
        if (!hostId || !workspaceRoot) {
          return null;
        }
        const transportRaw = String(item.transport ?? "local").trim().toLowerCase();
        const transport: WorkerFabricTransport = transportRaw === "ssh" ? "ssh" : "local";
        const telemetry = parseLooseObject(item.telemetry);
        const thermalRaw = String(telemetry.thermal_pressure ?? "").trim().toLowerCase();
        const thermalPressure: WorkerFabricThermalPressure | null =
          thermalRaw === "nominal" || thermalRaw === "fair" || thermalRaw === "serious" || thermalRaw === "critical"
            ? thermalRaw
            : null;
        const heartbeatAt = normalizeOptionalIsoTimestamp(asNullableString(telemetry.heartbeat_at));
        const healthRaw = String(telemetry.health_state ?? "").trim().toLowerCase();
        const healthState = normalizeWorkerFabricHostHealthState(
          heartbeatAt,
          healthRaw === "offline" || healthRaw === "degraded" ? healthRaw : "healthy"
        );
        return {
          host_id: hostId,
          enabled: parseBoolean(item.enabled, true),
          transport,
          ssh_destination: asNullableString(item.ssh_destination),
          workspace_root: workspaceRoot,
          worker_count: parseBoundedInt(item.worker_count, 1, 1, 64),
          shell: String(item.shell ?? "/bin/zsh").trim() || "/bin/zsh",
          capabilities: parseLooseObject(item.capabilities),
          tags: dedupeNonEmpty(Array.isArray(item.tags) ? item.tags : []),
          telemetry: {
            heartbeat_at: heartbeatAt,
            health_state: healthState,
            queue_depth: parseBoundedInt(telemetry.queue_depth, 0, 0, 100_000),
            active_tasks: parseBoundedInt(telemetry.active_tasks, 0, 0, 100_000),
            latency_ms: telemetry.latency_ms == null ? null : parseBoundedFloat(telemetry.latency_ms, 0, 0, 10_000_000),
            cpu_utilization: telemetry.cpu_utilization == null ? null : parseBoundedFloat(telemetry.cpu_utilization, 0, 0, 1),
            ram_available_gb:
              telemetry.ram_available_gb == null ? null : parseBoundedFloat(telemetry.ram_available_gb, 0, 0, 1_000_000),
            ram_total_gb:
              telemetry.ram_total_gb == null ? null : parseBoundedFloat(telemetry.ram_total_gb, 0, 0, 1_000_000),
            swap_used_gb:
              telemetry.swap_used_gb == null ? null : parseBoundedFloat(telemetry.swap_used_gb, 0, 0, 1_000_000),
            gpu_utilization: telemetry.gpu_utilization == null ? null : parseBoundedFloat(telemetry.gpu_utilization, 0, 0, 1),
            gpu_memory_available_gb:
              telemetry.gpu_memory_available_gb == null ? null : parseBoundedFloat(telemetry.gpu_memory_available_gb, 0, 0, 1_000_000),
            gpu_memory_total_gb:
              telemetry.gpu_memory_total_gb == null ? null : parseBoundedFloat(telemetry.gpu_memory_total_gb, 0, 0, 1_000_000),
            disk_free_gb:
              telemetry.disk_free_gb == null ? null : parseBoundedFloat(telemetry.disk_free_gb, 0, 0, 1_000_000),
            thermal_pressure: thermalPressure,
          },
          metadata: parseLooseObject(item.metadata),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
        } satisfies WorkerFabricHostRecord;
      })
      .filter((entry): entry is WorkerFabricHostRecord => Boolean(entry))
      .sort((left, right) => left.host_id.localeCompare(right.host_id));

    const strategyRaw = String(config.strategy ?? "balanced").trim().toLowerCase();
    const strategy =
      strategyRaw === "prefer_local" || strategyRaw === "prefer_capacity" || strategyRaw === "resource_aware"
        ? strategyRaw
        : "balanced";

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      strategy,
      default_host_id: asNullableString(config.default_host_id),
      hosts,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setWorkerFabricState(params: {
    enabled: boolean;
    strategy?: WorkerFabricStateRecord["strategy"];
    default_host_id?: string | null;
    hosts: WorkerFabricHostRecord[];
  }): WorkerFabricStateRecord {
    const now = new Date().toISOString();
    const strategy =
      params.strategy === "prefer_local" || params.strategy === "prefer_capacity" || params.strategy === "resource_aware"
        ? params.strategy
        : "balanced";
    const normalizedHosts = (params.hosts ?? [])
      .map((host) => {
        const hostId = String(host.host_id ?? "").trim();
        const workspaceRoot = String(host.workspace_root ?? "").trim();
        if (!hostId || !workspaceRoot) {
          return null;
        }
        const transport: WorkerFabricTransport = host.transport === "ssh" ? "ssh" : "local";
        const telemetry = parseLooseObject(host.telemetry);
        const thermalRaw = String(telemetry.thermal_pressure ?? "").trim().toLowerCase();
        const thermalPressure: WorkerFabricThermalPressure | null =
          thermalRaw === "nominal" || thermalRaw === "fair" || thermalRaw === "serious" || thermalRaw === "critical"
            ? thermalRaw
            : null;
        const heartbeatAt = normalizeOptionalIsoTimestamp(asNullableString(telemetry.heartbeat_at));
        const healthRaw = String(telemetry.health_state ?? "").trim().toLowerCase();
        const healthState = normalizeWorkerFabricHostHealthState(
          heartbeatAt,
          healthRaw === "offline" || healthRaw === "degraded" ? healthRaw : "healthy"
        );
        return {
          host_id: hostId,
          enabled: Boolean(host.enabled),
          transport,
          ssh_destination: asNullableString(host.ssh_destination),
          workspace_root: workspaceRoot,
          worker_count: parseBoundedInt(host.worker_count, 1, 1, 64),
          shell: String(host.shell ?? "/bin/zsh").trim() || "/bin/zsh",
          capabilities: parseLooseObject(host.capabilities),
          tags: dedupeNonEmpty(host.tags ?? []),
          telemetry: {
            heartbeat_at: heartbeatAt,
            health_state: healthState,
            queue_depth: parseBoundedInt(telemetry.queue_depth, 0, 0, 100_000),
            active_tasks: parseBoundedInt(telemetry.active_tasks, 0, 0, 100_000),
            latency_ms: telemetry.latency_ms == null ? null : parseBoundedFloat(telemetry.latency_ms, 0, 0, 10_000_000),
            cpu_utilization: telemetry.cpu_utilization == null ? null : parseBoundedFloat(telemetry.cpu_utilization, 0, 0, 1),
            ram_available_gb:
              telemetry.ram_available_gb == null ? null : parseBoundedFloat(telemetry.ram_available_gb, 0, 0, 1_000_000),
            ram_total_gb:
              telemetry.ram_total_gb == null ? null : parseBoundedFloat(telemetry.ram_total_gb, 0, 0, 1_000_000),
            swap_used_gb:
              telemetry.swap_used_gb == null ? null : parseBoundedFloat(telemetry.swap_used_gb, 0, 0, 1_000_000),
            gpu_utilization: telemetry.gpu_utilization == null ? null : parseBoundedFloat(telemetry.gpu_utilization, 0, 0, 1),
            gpu_memory_available_gb:
              telemetry.gpu_memory_available_gb == null ? null : parseBoundedFloat(telemetry.gpu_memory_available_gb, 0, 0, 1_000_000),
            gpu_memory_total_gb:
              telemetry.gpu_memory_total_gb == null ? null : parseBoundedFloat(telemetry.gpu_memory_total_gb, 0, 0, 1_000_000),
            disk_free_gb:
              telemetry.disk_free_gb == null ? null : parseBoundedFloat(telemetry.disk_free_gb, 0, 0, 1_000_000),
            thermal_pressure: thermalPressure,
          },
          metadata: parseLooseObject(host.metadata),
          updated_at: now,
        } satisfies WorkerFabricHostRecord;
      })
      .filter((entry): entry is WorkerFabricHostRecord => Boolean(entry))
      .sort((left, right) => left.host_id.localeCompare(right.host_id));

    const defaultHostIdRaw = params.default_host_id?.trim() || null;
    const defaultHostId =
      defaultHostIdRaw && normalizedHosts.some((host) => host.host_id === defaultHostIdRaw) ? defaultHostIdRaw : null;

    const normalized: WorkerFabricStateRecord = {
      enabled: Boolean(params.enabled),
      strategy,
      default_host_id: defaultHostId,
      hosts: normalizedHosts,
      updated_at: now,
    };

    const configJson = stableStringify({
      strategy: normalized.strategy,
      default_host_id: normalized.default_host_id,
      hosts: normalized.hosts,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("worker.fabric", normalized.enabled ? 1 : 0, configJson, now);

    return normalized;
  }

  getClusterTopologyState(): ClusterTopologyStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("cluster.topology") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const nodes = (Array.isArray(config.nodes) ? config.nodes : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const nodeId = String(item.node_id ?? "").trim().toLowerCase();
        const title = String(item.title ?? "").trim();
        if (!nodeId || !title) {
          return null;
        }
        const statusRaw = String(item.status ?? "planned").trim().toLowerCase();
        const status: ClusterTopologyNodeStatus =
          statusRaw === "provisioning" || statusRaw === "active" || statusRaw === "maintenance" || statusRaw === "retired"
            ? statusRaw
            : "planned";
        const nodeClassRaw = String(item.node_class ?? "cpu-memory").trim().toLowerCase();
        const nodeClass: ClusterTopologyNodeClass =
          nodeClassRaw === "control-plane" ||
          nodeClassRaw === "gpu-workstation" ||
          nodeClassRaw === "virtualization"
            ? nodeClassRaw
            : "cpu-memory";
        const desiredBackends = (Array.isArray(item.desired_backends) ? item.desired_backends : [])
          .map((backendEntry) => {
            if (!backendEntry || typeof backendEntry !== "object") {
              return null;
            }
            const backend = backendEntry as Record<string, unknown>;
            const backendId = String(backend.backend_id ?? "").trim();
            const modelId = String(backend.model_id ?? "").trim();
            if (!backendId || !modelId) {
              return null;
            }
            return {
              backend_id: backendId,
              provider: normalizeModelRouterProvider(backend.provider),
              model_id: modelId,
              tags: dedupeNonEmpty(Array.isArray(backend.tags) ? backend.tags : []),
              metadata: parseLooseObject(backend.metadata),
            } satisfies ClusterTopologyDesiredBackendRecord;
          })
          .filter((backend): backend is ClusterTopologyDesiredBackendRecord => Boolean(backend))
          .sort((left, right) => left.backend_id.localeCompare(right.backend_id));
        return {
          node_id: nodeId,
          title,
          status,
          node_class: nodeClass,
          host_id: asNullableString(item.host_id),
          transport: String(item.transport ?? "local").trim().toLowerCase() === "ssh" ? "ssh" : "local",
          ssh_destination: asNullableString(item.ssh_destination),
          workspace_root: asNullableString(item.workspace_root),
          worker_count:
            item.worker_count == null ? null : parseBoundedInt(item.worker_count, 1, 1, 64),
          tags: dedupeNonEmpty(Array.isArray(item.tags) ? item.tags : []),
          preferred_domains: dedupeNonEmpty(Array.isArray(item.preferred_domains) ? item.preferred_domains : []),
          desired_backends: desiredBackends,
          capabilities: parseLooseObject(item.capabilities),
          metadata: parseLooseObject(item.metadata),
          created_at: normalizeIsoTimestamp(asNullableString(item.created_at) ?? undefined, String(row.updated_at ?? "")),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
        } satisfies ClusterTopologyNodeRecord;
      })
      .filter((entry): entry is ClusterTopologyNodeRecord => Boolean(entry))
      .sort((left, right) => left.node_id.localeCompare(right.node_id));

    const defaultNodeIdRaw = asNullableString(config.default_node_id);
    const defaultNodeId =
      defaultNodeIdRaw && nodes.some((node) => node.node_id === defaultNodeIdRaw) ? defaultNodeIdRaw : null;

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      default_node_id: defaultNodeId,
      nodes,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setClusterTopologyState(params: {
    enabled: boolean;
    default_node_id?: string | null;
    nodes: ClusterTopologyNodeRecord[];
  }): ClusterTopologyStateRecord {
    const now = new Date().toISOString();
    const nodes = (params.nodes ?? [])
      .map((node) => {
        const nodeId = String(node.node_id ?? "").trim().toLowerCase();
        const title = String(node.title ?? "").trim();
        if (!nodeId || !title) {
          return null;
        }
        const desiredBackends = (node.desired_backends ?? [])
          .map((backend) => {
            const backendId = String(backend.backend_id ?? "").trim();
            const modelId = String(backend.model_id ?? "").trim();
            if (!backendId || !modelId) {
              return null;
            }
            return {
              backend_id: backendId,
              provider: normalizeModelRouterProvider(backend.provider),
              model_id: modelId,
              tags: dedupeNonEmpty(backend.tags ?? []),
              metadata: parseLooseObject(backend.metadata),
            } satisfies ClusterTopologyDesiredBackendRecord;
          })
          .filter((backend): backend is ClusterTopologyDesiredBackendRecord => Boolean(backend))
          .sort((left, right) => left.backend_id.localeCompare(right.backend_id));
        return {
          node_id: nodeId,
          title,
          status:
            node.status === "provisioning" ||
            node.status === "active" ||
            node.status === "maintenance" ||
            node.status === "retired"
              ? node.status
              : "planned",
          node_class:
            node.node_class === "control-plane" ||
            node.node_class === "gpu-workstation" ||
            node.node_class === "virtualization"
              ? node.node_class
              : "cpu-memory",
          host_id: asNullableString(node.host_id),
          transport: node.transport === "ssh" ? "ssh" : "local",
          ssh_destination: asNullableString(node.ssh_destination),
          workspace_root: asNullableString(node.workspace_root),
          worker_count: node.worker_count == null ? null : parseBoundedInt(node.worker_count, 1, 1, 64),
          tags: dedupeNonEmpty(node.tags ?? []),
          preferred_domains: dedupeNonEmpty(node.preferred_domains ?? []),
          desired_backends: desiredBackends,
          capabilities: parseLooseObject(node.capabilities),
          metadata: parseLooseObject(node.metadata),
          created_at: normalizeIsoTimestamp(asNullableString(node.created_at) ?? undefined, now),
          updated_at: now,
        } satisfies ClusterTopologyNodeRecord;
      })
      .filter((entry): entry is ClusterTopologyNodeRecord => Boolean(entry))
      .sort((left, right) => left.node_id.localeCompare(right.node_id));

    const defaultNodeIdRaw = params.default_node_id?.trim().toLowerCase() || null;
    const defaultNodeId =
      defaultNodeIdRaw && nodes.some((node) => node.node_id === defaultNodeIdRaw) ? defaultNodeIdRaw : null;

    const normalized: ClusterTopologyStateRecord = {
      enabled: Boolean(params.enabled),
      default_node_id: defaultNodeId,
      nodes,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "cluster.topology",
        normalized.enabled ? 1 : 0,
        stableStringify({
          default_node_id: normalized.default_node_id,
          nodes: normalized.nodes,
        }),
        now
      );

    return normalized;
  }

  getBenchmarkSuitesState(): BenchmarkSuitesStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("benchmark.suites") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const suitesRaw = Array.isArray(config.suites) ? (config.suites as unknown[]) : [];
    const suites = suitesRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const suiteId = String(item.suite_id ?? "").trim();
        const title = String(item.title ?? "").trim();
        const objective = String(item.objective ?? "").trim();
        const projectDir = String(item.project_dir ?? "").trim();
        if (!suiteId || !title || !objective || !projectDir) {
          return null;
        }
        const isolationRaw = String(item.isolation_mode ?? "git_worktree").trim().toLowerCase();
        const isolationMode =
          isolationRaw === "copy" || isolationRaw === "none" ? isolationRaw : "git_worktree";
        const metricDirection =
          String(item.aggregate_metric_direction ?? "maximize").trim().toLowerCase() === "minimize"
            ? "minimize"
            : "maximize";
        const casesRaw = Array.isArray(item.cases) ? (item.cases as unknown[]) : [];
        const cases = casesRaw
          .map((caseEntry, index) => {
            if (!caseEntry || typeof caseEntry !== "object") {
              return null;
            }
            const caseItem = caseEntry as Record<string, unknown>;
            const caseId = String(caseItem.case_id ?? "").trim() || `case-${index + 1}`;
            const caseTitle = String(caseItem.title ?? caseId).trim() || caseId;
            const command = String(caseItem.command ?? "").trim();
            if (!command) {
              return null;
            }
            const caseMetricDirection =
              String(caseItem.metric_direction ?? metricDirection).trim().toLowerCase() === "minimize"
                ? "minimize"
                : "maximize";
            const metricModeRaw = String(caseItem.metric_mode ?? "duration_ms").trim().toLowerCase();
            const metricMode: BenchmarkMetricMode =
              metricModeRaw === "stdout_regex" || metricModeRaw === "stderr_regex" || metricModeRaw === "reward_file" ? metricModeRaw : "duration_ms";
            return {
              case_id: caseId,
              title: caseTitle,
              command,
              timeout_seconds: parseBoundedInt(caseItem.timeout_seconds, 600, 5, 7200),
              required: parseBoolean(caseItem.required, true),
              metric_name: String(caseItem.metric_name ?? item.aggregate_metric_name ?? "duration_ms").trim() || "duration_ms",
              metric_direction: caseMetricDirection,
              metric_mode: metricMode,
              metric_regex: asNullableString(caseItem.metric_regex),
              reward_file_path: asNullableString(caseItem.reward_file_path),
              tags: dedupeNonEmpty(Array.isArray(caseItem.tags) ? caseItem.tags : []),
              metadata: parseLooseObject(caseItem.metadata),
            } satisfies BenchmarkSuiteCaseRecord;
          })
          .filter((caseEntry): caseEntry is BenchmarkSuiteCaseRecord => Boolean(caseEntry));
        return {
          suite_id: suiteId,
          created_at: normalizeIsoTimestamp(asNullableString(item.created_at) ?? undefined, String(row.updated_at ?? "")),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
          title,
          objective,
          project_dir: projectDir,
          isolation_mode: isolationMode,
          aggregate_metric_name: String(item.aggregate_metric_name ?? "suite_success_rate").trim() || "suite_success_rate",
          aggregate_metric_direction: metricDirection,
          cases,
          tags: dedupeNonEmpty(Array.isArray(item.tags) ? item.tags : []),
          metadata: parseLooseObject(item.metadata),
        } satisfies BenchmarkSuiteRecord;
      })
      .filter((entry): entry is BenchmarkSuiteRecord => Boolean(entry))
      .sort((left, right) => left.title.localeCompare(right.title));

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      suites,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setBenchmarkSuitesState(params: { enabled: boolean; suites: BenchmarkSuiteRecord[] }): BenchmarkSuitesStateRecord {
    const now = new Date().toISOString();
    const normalizedSuites = (params.suites ?? [])
      .map((suite) => {
        const suiteId = String(suite.suite_id ?? "").trim();
        const title = String(suite.title ?? "").trim();
        const objective = String(suite.objective ?? "").trim();
        const projectDir = String(suite.project_dir ?? "").trim();
        if (!suiteId || !title || !objective || !projectDir) {
          return null;
        }
        const isolationMode =
          suite.isolation_mode === "copy" || suite.isolation_mode === "none" ? suite.isolation_mode : "git_worktree";
        const aggregateMetricDirection = suite.aggregate_metric_direction === "minimize" ? "minimize" : "maximize";
        const cases = (suite.cases ?? [])
          .map((caseEntry, index) => {
            const caseId = String(caseEntry.case_id ?? "").trim() || `case-${index + 1}`;
            const command = String(caseEntry.command ?? "").trim();
            if (!command) {
              return null;
            }
            const metricMode =
              caseEntry.metric_mode === "stdout_regex" || caseEntry.metric_mode === "stderr_regex" || caseEntry.metric_mode === "reward_file"
                ? caseEntry.metric_mode
                : "duration_ms";
            return {
              case_id: caseId,
              title: String(caseEntry.title ?? caseId).trim() || caseId,
              command,
              timeout_seconds: parseBoundedInt(caseEntry.timeout_seconds, 600, 5, 7200),
              required: Boolean(caseEntry.required),
              metric_name: String(caseEntry.metric_name ?? "duration_ms").trim() || "duration_ms",
              metric_direction: caseEntry.metric_direction === "minimize" ? "minimize" : "maximize",
              metric_mode: metricMode,
              metric_regex: asNullableString(caseEntry.metric_regex),
              reward_file_path: asNullableString(caseEntry.reward_file_path),
              tags: dedupeNonEmpty(caseEntry.tags ?? []),
              metadata: parseLooseObject(caseEntry.metadata),
            } satisfies BenchmarkSuiteCaseRecord;
          })
          .filter((caseEntry): caseEntry is BenchmarkSuiteCaseRecord => Boolean(caseEntry));
        return {
          suite_id: suiteId,
          created_at: normalizeIsoTimestamp(suite.created_at, now),
          updated_at: now,
          title,
          objective,
          project_dir: projectDir,
          isolation_mode: isolationMode,
          aggregate_metric_name: String(suite.aggregate_metric_name ?? "suite_success_rate").trim() || "suite_success_rate",
          aggregate_metric_direction: aggregateMetricDirection,
          cases,
          tags: dedupeNonEmpty(suite.tags ?? []),
          metadata: parseLooseObject(suite.metadata),
        } satisfies BenchmarkSuiteRecord;
      })
      .filter((entry): entry is BenchmarkSuiteRecord => Boolean(entry))
      .sort((left, right) => left.title.localeCompare(right.title));

    const normalized: BenchmarkSuitesStateRecord = {
      enabled: Boolean(params.enabled),
      suites: normalizedSuites,
      updated_at: now,
    };

    const configJson = stableStringify({
      suites: normalized.suites,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("benchmark.suites", normalized.enabled ? 1 : 0, configJson, now);

    return normalized;
  }

  getModelRouterState(): ModelRouterStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("model.router") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const strategyRaw = String(config.strategy ?? "balanced").trim().toLowerCase();
    const strategy: ModelRouterStrategy =
      strategyRaw === "prefer_speed" ||
      strategyRaw === "prefer_quality" ||
      strategyRaw === "prefer_cost" ||
      strategyRaw === "prefer_context_fit"
        ? strategyRaw
        : "balanced";
    const backends = (Array.isArray(config.backends) ? config.backends : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const backendId = String(item.backend_id ?? "").trim();
        const modelId = String(item.model_id ?? "").trim();
        if (!backendId || !modelId) {
          return null;
        }
        return {
          backend_id: backendId,
          enabled: parseBoolean(item.enabled, true),
          provider: normalizeModelRouterProvider(item.provider),
          model_id: modelId,
          endpoint: asNullableString(item.endpoint),
          host_id: asNullableString(item.host_id),
          locality: String(item.locality ?? "local").trim().toLowerCase() === "remote" ? "remote" : "local",
          context_window: parseBoundedInt(item.context_window, 8192, 256, 10_000_000),
          throughput_tps: item.throughput_tps == null ? null : parseBoundedFloat(item.throughput_tps, 0, 0, 1_000_000),
          latency_ms_p50: item.latency_ms_p50 == null ? null : parseBoundedFloat(item.latency_ms_p50, 0, 0, 10_000_000),
          success_rate: item.success_rate == null ? null : clampMetricRate(item.success_rate),
          win_rate: item.win_rate == null ? null : clampMetricRate(item.win_rate),
          cost_per_1k_input:
            item.cost_per_1k_input == null ? null : parseBoundedFloat(item.cost_per_1k_input, 0, 0, 1_000_000),
          max_output_tokens:
            item.max_output_tokens == null ? null : parseBoundedInt(item.max_output_tokens, 0, 0, 10_000_000),
          tags: dedupeNonEmpty(Array.isArray(item.tags) ? item.tags : []),
          capabilities: parseLooseObject(item.capabilities),
          metadata: parseLooseObject(item.metadata),
          heartbeat_at: asNullableString(item.heartbeat_at),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
        } satisfies ModelRouterBackendRecord;
      })
      .filter((entry): entry is ModelRouterBackendRecord => Boolean(entry))
      .sort((left, right) => left.backend_id.localeCompare(right.backend_id));

    const defaultBackendId = asNullableString(config.default_backend_id);

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      strategy,
      default_backend_id: defaultBackendId,
      backends,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setModelRouterState(params: {
    enabled: boolean;
    strategy?: ModelRouterStrategy;
    default_backend_id?: string | null;
    backends: ModelRouterBackendRecord[];
  }): ModelRouterStateRecord {
    const now = new Date().toISOString();
    const strategy: ModelRouterStrategy =
      params.strategy === "prefer_speed" ||
      params.strategy === "prefer_quality" ||
      params.strategy === "prefer_cost" ||
      params.strategy === "prefer_context_fit"
        ? params.strategy
        : "balanced";
    const backends = (params.backends ?? [])
      .map((backend) => {
        const backendId = String(backend.backend_id ?? "").trim();
        const modelId = String(backend.model_id ?? "").trim();
        if (!backendId || !modelId) {
          return null;
        }
        return {
          backend_id: backendId,
          enabled: Boolean(backend.enabled),
          provider: normalizeModelRouterProvider(backend.provider),
          model_id: modelId,
          endpoint: asNullableString(backend.endpoint),
          host_id: asNullableString(backend.host_id),
          locality: backend.locality === "remote" ? "remote" : "local",
          context_window: parseBoundedInt(backend.context_window, 8192, 256, 10_000_000),
          throughput_tps:
            backend.throughput_tps === undefined || backend.throughput_tps === null ? null : parseBoundedFloat(backend.throughput_tps, 0, 0, 1_000_000),
          latency_ms_p50:
            backend.latency_ms_p50 === undefined || backend.latency_ms_p50 === null ? null : parseBoundedFloat(backend.latency_ms_p50, 0, 0, 10_000_000),
          success_rate: backend.success_rate === undefined || backend.success_rate === null ? null : clampMetricRate(backend.success_rate),
          win_rate: backend.win_rate === undefined || backend.win_rate === null ? null : clampMetricRate(backend.win_rate),
          cost_per_1k_input:
            backend.cost_per_1k_input === undefined || backend.cost_per_1k_input === null
              ? null
              : parseBoundedFloat(backend.cost_per_1k_input, 0, 0, 1_000_000),
          max_output_tokens:
            backend.max_output_tokens === undefined || backend.max_output_tokens === null
              ? null
              : parseBoundedInt(backend.max_output_tokens, 0, 0, 10_000_000),
          tags: dedupeNonEmpty(backend.tags ?? []),
          capabilities: parseLooseObject(backend.capabilities),
          metadata: parseLooseObject(backend.metadata),
          heartbeat_at: asNullableString(backend.heartbeat_at),
          updated_at: now,
        } satisfies ModelRouterBackendRecord;
      })
      .filter((entry): entry is ModelRouterBackendRecord => Boolean(entry))
      .sort((left, right) => left.backend_id.localeCompare(right.backend_id));
    const defaultBackendId = params.default_backend_id?.trim() || null;

    const normalized: ModelRouterStateRecord = {
      enabled: Boolean(params.enabled),
      strategy,
      default_backend_id: defaultBackendId,
      backends,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "model.router",
        normalized.enabled ? 1 : 0,
        stableStringify({
          strategy: normalized.strategy,
          default_backend_id: normalized.default_backend_id,
          backends: normalized.backends,
        }),
        now
      );

    return normalized;
  }

  getEvalSuitesState(): EvalSuitesStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("eval.suites") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const suites = (Array.isArray(config.suites) ? config.suites : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const suiteId = String(item.suite_id ?? "").trim();
        const title = String(item.title ?? "").trim();
        const objective = String(item.objective ?? "").trim();
        if (!suiteId || !title || !objective) {
          return null;
        }
        const cases = (Array.isArray(item.cases) ? item.cases : [])
          .map((caseEntry, index) => {
            if (!caseEntry || typeof caseEntry !== "object") {
              return null;
            }
            const caseItem = caseEntry as Record<string, unknown>;
            const kindRaw = String(caseItem.kind ?? "benchmark_suite").trim().toLowerCase();
            const kind: EvalSuiteCaseKind = kindRaw === "router_case" ? "router_case" : "benchmark_suite";
            const taskKindRaw = String(caseItem.task_kind ?? "").trim().toLowerCase();
            const taskKind: ModelRouterTaskKind | null =
              taskKindRaw === "planning" ||
              taskKindRaw === "coding" ||
              taskKindRaw === "research" ||
              taskKindRaw === "verification" ||
              taskKindRaw === "chat" ||
              taskKindRaw === "tool_use"
                ? taskKindRaw
                : null;
            return {
              case_id: String(caseItem.case_id ?? `case-${index + 1}`).trim() || `case-${index + 1}`,
              title: String(caseItem.title ?? `Case ${index + 1}`).trim() || `Case ${index + 1}`,
              kind,
              benchmark_suite_id: asNullableString(caseItem.benchmark_suite_id),
              task_kind: taskKind,
              context_tokens:
                caseItem.context_tokens === undefined ? null : parseBoundedInt(caseItem.context_tokens, 0, 0, 10_000_000),
              latency_budget_ms:
                caseItem.latency_budget_ms === undefined ? null : parseBoundedFloat(caseItem.latency_budget_ms, 0, 0, 10_000_000),
              expected_backend_id: asNullableString(caseItem.expected_backend_id),
              expected_backend_tags: dedupeNonEmpty(Array.isArray(caseItem.expected_backend_tags) ? caseItem.expected_backend_tags : []),
              required_tags: dedupeNonEmpty(Array.isArray(caseItem.required_tags) ? caseItem.required_tags : []),
              preferred_tags: dedupeNonEmpty(Array.isArray(caseItem.preferred_tags) ? caseItem.preferred_tags : []),
              required: parseBoolean(caseItem.required, true),
              weight: parseBoundedFloat(caseItem.weight, 1, 0, 1000),
              metadata: parseLooseObject(caseItem.metadata),
            } satisfies EvalSuiteCaseRecord;
          })
          .filter((caseEntry): caseEntry is EvalSuiteCaseRecord => Boolean(caseEntry));
        return {
          suite_id: suiteId,
          created_at: normalizeIsoTimestamp(asNullableString(item.created_at) ?? undefined, String(row.updated_at ?? "")),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
          title,
          objective,
          aggregate_metric_name: String(item.aggregate_metric_name ?? "suite_success_rate").trim() || "suite_success_rate",
          aggregate_metric_direction:
            String(item.aggregate_metric_direction ?? "maximize").trim().toLowerCase() === "minimize" ? "minimize" : "maximize",
          cases,
          tags: dedupeNonEmpty(Array.isArray(item.tags) ? item.tags : []),
          metadata: parseLooseObject(item.metadata),
        } satisfies EvalSuiteRecord;
      })
      .filter((entry): entry is EvalSuiteRecord => Boolean(entry))
      .sort((left, right) => left.title.localeCompare(right.title));

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      suites,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setEvalSuitesState(params: { enabled: boolean; suites: EvalSuiteRecord[] }): EvalSuitesStateRecord {
    const now = new Date().toISOString();
    const suites = (params.suites ?? [])
      .map((suite) => {
        const suiteId = String(suite.suite_id ?? "").trim();
        const title = String(suite.title ?? "").trim();
        const objective = String(suite.objective ?? "").trim();
        if (!suiteId || !title || !objective) {
          return null;
        }
        const cases = (suite.cases ?? [])
          .map((caseEntry, index) => ({
            case_id: String(caseEntry.case_id ?? `case-${index + 1}`).trim() || `case-${index + 1}`,
            title: String(caseEntry.title ?? `Case ${index + 1}`).trim() || `Case ${index + 1}`,
            kind: caseEntry.kind === "router_case" ? "router_case" : "benchmark_suite",
            benchmark_suite_id: asNullableString(caseEntry.benchmark_suite_id),
            task_kind: caseEntry.task_kind ?? null,
            context_tokens:
              caseEntry.context_tokens === undefined || caseEntry.context_tokens === null
                ? null
                : parseBoundedInt(caseEntry.context_tokens, 0, 0, 10_000_000),
            latency_budget_ms:
              caseEntry.latency_budget_ms === undefined || caseEntry.latency_budget_ms === null
                ? null
                : parseBoundedFloat(caseEntry.latency_budget_ms, 0, 0, 10_000_000),
            expected_backend_id: asNullableString(caseEntry.expected_backend_id),
            expected_backend_tags: dedupeNonEmpty(caseEntry.expected_backend_tags ?? []),
            required_tags: dedupeNonEmpty(caseEntry.required_tags ?? []),
            preferred_tags: dedupeNonEmpty(caseEntry.preferred_tags ?? []),
            required: Boolean(caseEntry.required),
            weight: parseBoundedFloat(caseEntry.weight, 1, 0, 1000),
            metadata: parseLooseObject(caseEntry.metadata),
          } satisfies EvalSuiteCaseRecord))
          .filter((caseEntry): caseEntry is EvalSuiteCaseRecord => Boolean(caseEntry));
        return {
          suite_id: suiteId,
          created_at: normalizeIsoTimestamp(asNullableString(suite.created_at) ?? undefined, now),
          updated_at: now,
          title,
          objective,
          aggregate_metric_name: String(suite.aggregate_metric_name ?? "suite_success_rate").trim() || "suite_success_rate",
          aggregate_metric_direction: suite.aggregate_metric_direction === "minimize" ? "minimize" : "maximize",
          cases,
          tags: dedupeNonEmpty(suite.tags ?? []),
          metadata: parseLooseObject(suite.metadata),
        } satisfies EvalSuiteRecord;
      })
      .filter((entry): entry is EvalSuiteRecord => Boolean(entry))
      .sort((left, right) => left.title.localeCompare(right.title));

    const normalized: EvalSuitesStateRecord = {
      enabled: Boolean(params.enabled),
      suites,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("eval.suites", normalized.enabled ? 1 : 0, stableStringify({ suites: normalized.suites }), now);

    return normalized;
  }

  getOrgProgramsState(): OrgProgramsStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("org.programs") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const roles = (Array.isArray(config.roles) ? config.roles : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const roleId = String(item.role_id ?? "").trim();
        const title = String(item.title ?? "").trim();
        if (!roleId || !title) {
          return null;
        }
        const versions = (Array.isArray(item.versions) ? item.versions : [])
          .map((versionEntry) => {
            if (!versionEntry || typeof versionEntry !== "object") {
              return null;
            }
            const versionItem = versionEntry as Record<string, unknown>;
            const versionId = String(versionItem.version_id ?? "").trim();
            const summary = String(versionItem.summary ?? "").trim();
            const doctrine = String(versionItem.doctrine ?? "").trim();
            const delegationContract = String(versionItem.delegation_contract ?? "").trim();
            const evaluationStandard = String(versionItem.evaluation_standard ?? "").trim();
            if (!versionId || !summary || !doctrine || !delegationContract || !evaluationStandard) {
              return null;
            }
            const statusRaw = String(versionItem.status ?? "candidate").trim().toLowerCase();
            const status: OrgProgramVersionStatus =
              statusRaw === "active" || statusRaw === "archived" ? statusRaw : "candidate";
            return {
              version_id: versionId,
              created_at: normalizeIsoTimestamp(asNullableString(versionItem.created_at) ?? undefined, String(row.updated_at ?? "")),
              summary,
              doctrine,
              delegation_contract: delegationContract,
              evaluation_standard: evaluationStandard,
              status,
              metadata: parseLooseObject(versionItem.metadata),
            } satisfies OrgProgramVersionRecord;
          })
          .filter((version): version is OrgProgramVersionRecord => Boolean(version))
          .sort((left, right) => left.created_at.localeCompare(right.created_at));
        const activeVersionIdRaw = asNullableString(item.active_version_id);
        const activeVersionId =
          activeVersionIdRaw && versions.some((version) => version.version_id === activeVersionIdRaw) ? activeVersionIdRaw : null;
        return {
          role_id: roleId,
          title,
          description: asNullableString(item.description),
          lane: asNullableString(item.lane),
          active_version_id: activeVersionId,
          versions,
          metadata: parseLooseObject(item.metadata),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
        } satisfies OrgProgramRoleRecord;
      })
      .filter((entry): entry is OrgProgramRoleRecord => Boolean(entry))
      .sort((left, right) => left.role_id.localeCompare(right.role_id));

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      roles,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setOrgProgramsState(params: { enabled: boolean; roles: OrgProgramRoleRecord[] }): OrgProgramsStateRecord {
    const now = new Date().toISOString();
    const roles = (params.roles ?? [])
      .map((role) => {
        const roleId = String(role.role_id ?? "").trim();
        const title = String(role.title ?? "").trim();
        if (!roleId || !title) {
          return null;
        }
        const versions = (role.versions ?? [])
          .map((version) => {
            const versionId = String(version.version_id ?? "").trim();
            const summary = String(version.summary ?? "").trim();
            const doctrine = String(version.doctrine ?? "").trim();
            const delegationContract = String(version.delegation_contract ?? "").trim();
            const evaluationStandard = String(version.evaluation_standard ?? "").trim();
            if (!versionId || !summary || !doctrine || !delegationContract || !evaluationStandard) {
              return null;
            }
            return {
              version_id: versionId,
              created_at: normalizeIsoTimestamp(asNullableString(version.created_at) ?? undefined, now),
              summary,
              doctrine,
              delegation_contract: delegationContract,
              evaluation_standard: evaluationStandard,
              status: version.status === "active" || version.status === "archived" ? version.status : "candidate",
              metadata: parseLooseObject(version.metadata),
            } satisfies OrgProgramVersionRecord;
          })
          .filter((version): version is OrgProgramVersionRecord => Boolean(version))
          .sort((left, right) => left.created_at.localeCompare(right.created_at));
        const activeVersionIdRaw = role.active_version_id?.trim() || null;
        const activeVersionId =
          activeVersionIdRaw && versions.some((version) => version.version_id === activeVersionIdRaw) ? activeVersionIdRaw : null;
        return {
          role_id: roleId,
          title,
          description: asNullableString(role.description),
          lane: asNullableString(role.lane),
          active_version_id: activeVersionId,
          versions,
          metadata: parseLooseObject(role.metadata),
          updated_at: now,
        } satisfies OrgProgramRoleRecord;
      })
      .filter((entry): entry is OrgProgramRoleRecord => Boolean(entry))
      .sort((left, right) => left.role_id.localeCompare(right.role_id));

    const normalized: OrgProgramsStateRecord = {
      enabled: Boolean(params.enabled),
      roles,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("org.programs", normalized.enabled ? 1 : 0, stableStringify({ roles: normalized.roles }), now);

    return normalized;
  }

  getDomainSpecialistRegistryState(): DomainSpecialistRegistryStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("domain.specialists") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const specialists = (Array.isArray(config.specialists) ? config.specialists : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const domainKey = String(item.domain_key ?? "").trim().toLowerCase();
        const agentId = String(item.agent_id ?? "").trim().toLowerCase();
        const roleId = String(item.role_id ?? "").trim().toLowerCase();
        const title = String(item.title ?? "").trim();
        const systemPrompt = String(item.system_prompt ?? "").trim();
        if (!domainKey || !agentId || !roleId || !title || !systemPrompt) {
          return null;
        }
        const statusRaw = String(item.status ?? "active").trim().toLowerCase();
        const status: DomainSpecialistStatus =
          statusRaw === "candidate" || statusRaw === "archived" ? statusRaw : "active";
        const matchRules = parseLooseObject(item.match_rules);
        const routingHints = parseLooseObject(item.routing_hints);
        return {
          domain_key: domainKey,
          agent_id: agentId,
          role_id: roleId,
          title,
          description: asNullableString(item.description),
          lane: asNullableString(item.lane),
          coordination_tier: asNullableString(item.coordination_tier),
          parent_agent_id: asNullableString(item.parent_agent_id),
          managed_agent_ids: dedupeNonEmpty(
            Array.isArray(item.managed_agent_ids) ? item.managed_agent_ids.map((value) => String(value ?? "")) : []
          ),
          match_rules: {
            keywords: dedupeNonEmpty(
              Array.isArray(matchRules.keywords) ? matchRules.keywords.map((value) => String(value ?? "")) : []
            ),
            tags: dedupeNonEmpty(Array.isArray(matchRules.tags) ? matchRules.tags.map((value) => String(value ?? "")) : []),
            paths: dedupeNonEmpty(Array.isArray(matchRules.paths) ? matchRules.paths.map((value) => String(value ?? "")) : []),
          },
          routing_hints: {
            preferred_host_tags: dedupeNonEmpty(
              Array.isArray(routingHints.preferred_host_tags)
                ? routingHints.preferred_host_tags.map((value) => String(value ?? ""))
                : []
            ),
            required_host_tags: dedupeNonEmpty(
              Array.isArray(routingHints.required_host_tags)
                ? routingHints.required_host_tags.map((value) => String(value ?? ""))
                : []
            ),
            preferred_agent_ids: dedupeNonEmpty(
              Array.isArray(routingHints.preferred_agent_ids)
                ? routingHints.preferred_agent_ids.map((value) => String(value ?? ""))
                : []
            ),
            support_agent_ids: dedupeNonEmpty(
              Array.isArray(routingHints.support_agent_ids)
                ? routingHints.support_agent_ids.map((value) => String(value ?? ""))
                : []
            ),
            preferred_model_tags: dedupeNonEmpty(
              Array.isArray(routingHints.preferred_model_tags)
                ? routingHints.preferred_model_tags.map((value) => String(value ?? ""))
                : []
            ),
            quality_preference: asNullableString(routingHints.quality_preference),
            local_learning_entry_target: parseBoundedInt(routingHints.local_learning_entry_target, 3, 0, 1000),
          },
          system_prompt: systemPrompt,
          status,
          metadata: parseLooseObject(item.metadata),
          created_at: normalizeIsoTimestamp(asNullableString(item.created_at) ?? undefined, String(row.updated_at ?? "")),
          updated_at: normalizeIsoTimestamp(asNullableString(item.updated_at) ?? undefined, String(row.updated_at ?? "")),
        } satisfies DomainSpecialistRecord;
      })
      .filter((entry): entry is DomainSpecialistRecord => Boolean(entry))
      .sort((left, right) => left.domain_key.localeCompare(right.domain_key));

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      specialists,
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setDomainSpecialistRegistryState(params: {
    enabled: boolean;
    specialists: DomainSpecialistRecord[];
  }): DomainSpecialistRegistryStateRecord {
    const now = new Date().toISOString();
    const specialists = (params.specialists ?? [])
      .map((specialist) => {
        const domainKey = String(specialist.domain_key ?? "").trim().toLowerCase();
        const agentId = String(specialist.agent_id ?? "").trim().toLowerCase();
        const roleId = String(specialist.role_id ?? "").trim().toLowerCase();
        const title = String(specialist.title ?? "").trim();
        const systemPrompt = String(specialist.system_prompt ?? "").trim();
        if (!domainKey || !agentId || !roleId || !title || !systemPrompt) {
          return null;
        }
        return {
          domain_key: domainKey,
          agent_id: agentId,
          role_id: roleId,
          title,
          description: asNullableString(specialist.description),
          lane: asNullableString(specialist.lane),
          coordination_tier: asNullableString(specialist.coordination_tier),
          parent_agent_id: asNullableString(specialist.parent_agent_id),
          managed_agent_ids: dedupeNonEmpty(specialist.managed_agent_ids ?? []),
          match_rules: {
            keywords: dedupeNonEmpty(specialist.match_rules?.keywords ?? []),
            tags: dedupeNonEmpty(specialist.match_rules?.tags ?? []),
            paths: dedupeNonEmpty(specialist.match_rules?.paths ?? []),
          },
          routing_hints: {
            preferred_host_tags: dedupeNonEmpty(specialist.routing_hints?.preferred_host_tags ?? []),
            required_host_tags: dedupeNonEmpty(specialist.routing_hints?.required_host_tags ?? []),
            preferred_agent_ids: dedupeNonEmpty(specialist.routing_hints?.preferred_agent_ids ?? []),
            support_agent_ids: dedupeNonEmpty(specialist.routing_hints?.support_agent_ids ?? []),
            preferred_model_tags: dedupeNonEmpty(specialist.routing_hints?.preferred_model_tags ?? []),
            quality_preference: asNullableString(specialist.routing_hints?.quality_preference),
            local_learning_entry_target: parseBoundedInt(
              specialist.routing_hints?.local_learning_entry_target,
              3,
              0,
              1000
            ),
          },
          system_prompt: systemPrompt,
          status:
            specialist.status === "candidate" || specialist.status === "archived" ? specialist.status : "active",
          metadata: parseLooseObject(specialist.metadata),
          created_at: normalizeIsoTimestamp(asNullableString(specialist.created_at) ?? undefined, now),
          updated_at: now,
        } satisfies DomainSpecialistRecord;
      })
      .filter((entry): entry is DomainSpecialistRecord => Boolean(entry))
      .sort((left, right) => left.domain_key.localeCompare(right.domain_key));

    const normalized: DomainSpecialistRegistryStateRecord = {
      enabled: Boolean(params.enabled),
      specialists,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("domain.specialists", normalized.enabled ? 1 : 0, stableStringify({ specialists: normalized.specialists }), now);

    return normalized;
  }

  setImprintAutoSnapshotState(params: {
    enabled: boolean;
    profile_id?: string;
    interval_seconds: number;
    include_recent_memories: number;
    include_recent_transcript_lines: number;
    write_file: boolean;
    promote_summary: boolean;
  }): ImprintAutoSnapshotStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      profile_id: params.profile_id ? params.profile_id.trim() || null : null,
      interval_seconds: parseBoundedInt(params.interval_seconds, 900, 30, 86400),
      include_recent_memories: parseBoundedInt(params.include_recent_memories, 20, 0, 200),
      include_recent_transcript_lines: parseBoundedInt(params.include_recent_transcript_lines, 40, 0, 1000),
      write_file: Boolean(params.write_file),
      promote_summary: Boolean(params.promote_summary),
    };
    const configJson = stableStringify({
      profile_id: normalized.profile_id,
      interval_seconds: normalized.interval_seconds,
      include_recent_memories: normalized.include_recent_memories,
      include_recent_transcript_lines: normalized.include_recent_transcript_lines,
      write_file: normalized.write_file,
      promote_summary: normalized.promote_summary,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("imprint.auto_snapshot", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  upsertImprintProfile(params: {
    profile_id: string;
    title: string;
    mission: string;
    principles: string[];
    hard_constraints?: string[];
    preferred_models?: string[];
    project_roots?: string[];
    notes?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { profile_id: string; created: boolean; created_at: string; updated_at: string } {
    const profileId = params.profile_id.trim();
    if (!profileId) {
      throw new Error("profile_id is required");
    }
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT profile_id, created_at FROM imprint_profiles WHERE profile_id = ?`)
      .get(profileId) as Record<string, unknown> | undefined;

    const title = params.title.trim();
    const mission = params.mission.trim();
    if (!title || !mission) {
      throw new Error("title and mission are required");
    }

    const principles = dedupeNonEmpty(params.principles);
    const hardConstraints = dedupeNonEmpty(params.hard_constraints ?? []);
    const preferredModels = dedupeNonEmpty(params.preferred_models ?? []);
    const projectRoots = dedupeNonEmpty(params.project_roots ?? []);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO imprint_profiles (
             profile_id, created_at, updated_at, title, mission,
             principles_json, hard_constraints_json, preferred_models_json, project_roots_json,
             notes, source_client, source_model, source_agent
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          now,
          now,
          title,
          mission,
          stableStringify(principles),
          stableStringify(hardConstraints),
          stableStringify(preferredModels),
          stableStringify(projectRoots),
          params.notes?.trim() || null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      return {
        profile_id: profileId,
        created: true,
        created_at: now,
        updated_at: now,
      };
    }

    const createdAt = String(existing.created_at ?? now);
    this.db
      .prepare(
        `UPDATE imprint_profiles
         SET updated_at = ?, title = ?, mission = ?,
             principles_json = ?, hard_constraints_json = ?, preferred_models_json = ?, project_roots_json = ?,
             notes = ?, source_client = ?, source_model = ?, source_agent = ?
         WHERE profile_id = ?`
      )
      .run(
        now,
        title,
        mission,
        stableStringify(principles),
        stableStringify(hardConstraints),
        stableStringify(preferredModels),
        stableStringify(projectRoots),
        params.notes?.trim() || null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        profileId
      );
    return {
      profile_id: profileId,
      created: false,
      created_at: createdAt,
      updated_at: now,
    };
  }

  getImprintProfile(profileId = "default"): ImprintProfileRecord | null {
    const normalized = profileId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT profile_id, created_at, updated_at, title, mission,
                principles_json, hard_constraints_json, preferred_models_json, project_roots_json,
                notes, source_client, source_model, source_agent
         FROM imprint_profiles
         WHERE profile_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapImprintProfileRow(row);
  }

  insertImprintSnapshot(params: {
    id: string;
    profile_id?: string;
    summary?: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    state: Record<string, unknown>;
    snapshot_path?: string;
    memory_id?: number;
  }): { id: string; created_at: string } {
    const id = params.id.trim();
    if (!id) {
      throw new Error("snapshot id is required");
    }
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO imprint_snapshots (
           id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
           state_json, snapshot_path, memory_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.profile_id?.trim() || null,
        params.summary?.trim() || null,
        stableStringify(dedupeNonEmpty(params.tags ?? [])),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        stableStringify(params.state),
        params.snapshot_path ?? null,
        params.memory_id ?? null
      );
    return { id, created_at: createdAt };
  }

  getImprintSnapshotById(snapshotId: string): ImprintSnapshotRecord | null {
    const normalized = snapshotId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
                state_json, snapshot_path, memory_id
         FROM imprint_snapshots
         WHERE id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapImprintSnapshotRow(row);
  }

  listImprintSnapshots(params: {
    limit: number;
    profile_id?: string;
  }): ImprintSnapshotRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, params.limit));
    const profileId = params.profile_id?.trim();
    const rows = profileId
      ? (this.db
          .prepare(
            `SELECT id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
                    state_json, snapshot_path, memory_id
             FROM imprint_snapshots
             WHERE profile_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(profileId, boundedLimit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
                    state_json, snapshot_path, memory_id
             FROM imprint_snapshots
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(boundedLimit) as Array<Record<string, unknown>>);
    return rows.map((row) => mapImprintSnapshotRow(row));
  }

  getLatestImprintSnapshot(profileId?: string): ImprintSnapshotRecord | null {
    const snapshots = this.listImprintSnapshots({
      limit: 1,
      profile_id: profileId,
    });
    return snapshots[0] ?? null;
  }

  countImprintSnapshots(profileId?: string): number {
    const normalized = profileId?.trim();
    const row = normalized
      ? (this.db
          .prepare(`SELECT COUNT(*) AS count FROM imprint_snapshots WHERE profile_id = ?`)
          .get(normalized) as Record<string, unknown>)
      : (this.db
          .prepare(`SELECT COUNT(*) AS count FROM imprint_snapshots`)
          .get() as Record<string, unknown>);
    return Number(row.count ?? 0);
  }

  createGoal(params: {
    goal_id?: string;
    title: string;
    objective: string;
    status?: GoalStatus;
    priority?: number;
    risk_tier?: GoalRiskTier;
    autonomy_mode?: GoalAutonomyMode;
    target_entity_type?: string;
    target_entity_id?: string;
    acceptance_criteria: string[];
    constraints?: string[];
    assumptions?: string[];
    budget?: Record<string, unknown>;
    owner?: Record<string, unknown>;
    tags?: string[];
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; goal: GoalRecord } {
    const now = new Date().toISOString();
    const goalId = params.goal_id?.trim() || crypto.randomUUID();
    const existing = this.getGoalById(goalId);
    if (existing) {
      return {
        created: false,
        goal: existing,
      };
    }

    const title = params.title.trim();
    const objective = params.objective.trim();
    if (!title || !objective) {
      throw new Error("goal title and objective are required");
    }

    const targetEntityType = params.target_entity_type?.trim() || null;
    const targetEntityId = params.target_entity_id?.trim() || null;
    if ((targetEntityType && !targetEntityId) || (!targetEntityType && targetEntityId)) {
      throw new Error("goal target_entity_type and target_entity_id must be provided together");
    }

    const acceptanceCriteria = dedupeNonEmpty(params.acceptance_criteria ?? []);
    if (acceptanceCriteria.length === 0) {
      throw new Error("goal acceptance_criteria is required");
    }

    const status = normalizeGoalStatus(params.status);
    const priority = parseBoundedInt(params.priority, 0, 0, 100);
    const riskTier = normalizeGoalRiskTier(params.risk_tier);
    const autonomyMode = normalizeGoalAutonomyMode(params.autonomy_mode);
    const constraints = dedupeNonEmpty(params.constraints ?? []);
    const assumptions = dedupeNonEmpty(params.assumptions ?? []);
    const tags = dedupeNonEmpty(params.tags ?? []);
    const budget = parseLooseObject(params.budget ?? {});
    const owner = parseLooseObject(params.owner ?? {});
    const metadata = parseLooseObject(params.metadata ?? {});

    const create = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO goals (
             goal_id, created_at, updated_at, title, objective, status, priority, risk_tier, autonomy_mode,
             target_entity_type, target_entity_id, acceptance_criteria_json, constraints_json, assumptions_json,
             budget_json, owner_json, tags_json, metadata_json, active_plan_id, result_summary, result_json,
             source_client, source_model, source_agent
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
           ON CONFLICT(goal_id) DO NOTHING`
        )
        .run(
          goalId,
          now,
          now,
          title,
          objective,
          status,
          priority,
          riskTier,
          autonomyMode,
          targetEntityType,
          targetEntityId,
          stableStringify(acceptanceCriteria),
          stableStringify(constraints),
          stableStringify(assumptions),
          stableStringify(budget),
          stableStringify(owner),
          stableStringify(tags),
          stableStringify(metadata),
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      const insertedCount = Number(inserted.changes ?? 0);
      if (insertedCount > 0) {
        this.appendGoalEvent({
          goal_id: goalId,
          event_type: "created",
          to_status: status,
          summary: "Goal created.",
          details: {
            priority,
            risk_tier: riskTier,
            autonomy_mode: autonomyMode,
          },
          source_client: params.source_client,
          source_model: params.source_model,
          source_agent: params.source_agent,
        });
      }
      return insertedCount > 0;
    });
    const created = create();

    const goal = this.getGoalById(goalId);
    if (!goal) {
      throw new Error(`Failed to read goal after create: ${goalId}`);
    }
    return {
      created,
      goal,
    };
  }

  appendGoalEvent(params: {
    goal_id: string;
    event_type: string;
    from_status?: GoalStatus | null;
    to_status?: GoalStatus | null;
    summary: string;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { id: string; created_at: string } {
    const goalId = params.goal_id.trim();
    if (!goalId) {
      throw new Error("goal_id is required");
    }
    const summary = params.summary.trim();
    if (!summary) {
      throw new Error("goal event summary is required");
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO goal_events (
           id, goal_id, created_at, event_type, from_status, to_status, summary, details_json,
           source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        goalId,
        createdAt,
        params.event_type.trim() || "event",
        params.from_status ?? null,
        params.to_status ?? null,
        summary,
        stableStringify(params.details ?? {}),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );
    this.appendRuntimeEvent({
      event_type: `goal.${params.event_type.trim() || "event"}`,
      entity_type: "goal",
      entity_id: goalId,
      status: params.to_status ?? params.from_status ?? null,
      summary,
      details: {
        from_status: params.from_status ?? null,
        to_status: params.to_status ?? null,
        ...(params.details ?? {}),
      },
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
      created_at: createdAt,
    });
    return {
      id,
      created_at: createdAt,
    };
  }

  getGoalById(goalId: string): GoalRecord | null {
    const normalized = goalId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT goal_id, created_at, updated_at, title, objective, status, priority, risk_tier, autonomy_mode,
                target_entity_type, target_entity_id, acceptance_criteria_json, constraints_json, assumptions_json,
                budget_json, owner_json, tags_json, metadata_json, active_plan_id, result_summary, result_json,
                source_client, source_model, source_agent
         FROM goals
         WHERE goal_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapGoalRow(row);
  }

  updateGoalMetadata(params: {
    goal_id: string;
    metadata: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { goal: GoalRecord } {
    const goalId = params.goal_id.trim();
    if (!goalId) {
      throw new Error("goal_id is required");
    }
    const existing = this.getGoalById(goalId);
    if (!existing) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    const now = new Date().toISOString();
    const metadata = {
      ...existing.metadata,
      ...parseLooseObject(params.metadata),
    };

    this.db
      .prepare(
        `UPDATE goals
         SET updated_at = ?, metadata_json = ?, source_client = ?, source_model = ?, source_agent = ?
         WHERE goal_id = ?`
      )
      .run(
        now,
        stableStringify(metadata),
        params.source_client ?? existing.source_client,
        params.source_model ?? existing.source_model,
        params.source_agent ?? existing.source_agent,
        goalId
      );

    const goal = this.getGoalById(goalId);
    if (!goal) {
      throw new Error(`Failed to read goal after metadata update: ${goalId}`);
    }
    return { goal };
  }

  updateGoal(params: {
    goal_id: string;
    status?: GoalStatus;
    active_plan_id?: string | null;
    result_summary?: string | null;
    result?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    event_type?: string;
    event_summary?: string;
    event_details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { goal: GoalRecord } {
    const goalId = params.goal_id.trim();
    if (!goalId) {
      throw new Error("goal_id is required");
    }
    const existing = this.getGoalById(goalId);
    if (!existing) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    const now = new Date().toISOString();
    const status = params.status === undefined ? existing.status : normalizeGoalStatus(params.status);
    const activePlanId =
      params.active_plan_id === undefined ? existing.active_plan_id : params.active_plan_id?.trim() || null;
    const resultSummary =
      params.result_summary === undefined
        ? existing.result_summary
        : params.result_summary === null
          ? null
          : params.result_summary.trim() || null;
    const result =
      params.result === undefined ? existing.result : params.result === null ? null : parseLooseObject(params.result);
    const metadata =
      params.metadata === undefined ? existing.metadata : { ...existing.metadata, ...parseLooseObject(params.metadata) };
    const statusChanged = status !== existing.status;

    this.db
      .prepare(
        `UPDATE goals
         SET updated_at = ?,
             status = ?,
             active_plan_id = ?,
             result_summary = ?,
             result_json = ?,
             metadata_json = ?,
             source_client = ?,
             source_model = ?,
             source_agent = ?
         WHERE goal_id = ?`
      )
      .run(
        now,
        status,
        activePlanId,
        resultSummary,
        result === null ? null : stableStringify(result),
        stableStringify(metadata),
        params.source_client ?? existing.source_client,
        params.source_model ?? existing.source_model,
        params.source_agent ?? existing.source_agent,
        goalId
      );

    if (statusChanged || params.event_summary?.trim()) {
      this.appendGoalEvent({
        goal_id: goalId,
        event_type: params.event_type?.trim() || (statusChanged ? "status_updated" : "updated"),
        from_status: statusChanged ? existing.status : null,
        to_status: statusChanged ? status : null,
        summary:
          params.event_summary?.trim() ||
          (statusChanged ? `Goal status updated to ${status}.` : "Goal updated."),
        details: params.event_details ?? {},
        source_client: params.source_client,
        source_model: params.source_model,
        source_agent: params.source_agent,
      });
    }

    const goal = this.getGoalById(goalId);
    if (!goal) {
      throw new Error(`Failed to read goal after update: ${goalId}`);
    }
    return { goal };
  }

  listGoals(params: {
    status?: GoalStatus;
    limit: number;
    target_entity_type?: string;
    target_entity_id?: string;
  }): GoalRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    const targetEntityType = params.target_entity_type?.trim();
    const targetEntityId = params.target_entity_id?.trim();

    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeGoalStatus(params.status));
    }
    if (targetEntityType) {
      whereClauses.push("target_entity_type = ?");
      values.push(targetEntityType);
    }
    if (targetEntityId) {
      whereClauses.push("target_entity_id = ?");
      values.push(targetEntityId);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT goal_id, created_at, updated_at, title, objective, status, priority, risk_tier, autonomy_mode,
                target_entity_type, target_entity_id, acceptance_criteria_json, constraints_json, assumptions_json,
                budget_json, owner_json, tags_json, metadata_json, active_plan_id, result_summary, result_json,
                source_client, source_model, source_agent
         FROM goals
         ${whereSql}
         ORDER BY
           CASE status
             WHEN 'active' THEN 0
             WHEN 'blocked' THEN 1
             WHEN 'waiting' THEN 2
             WHEN 'draft' THEN 3
             WHEN 'failed' THEN 4
             WHEN 'completed' THEN 5
             WHEN 'cancelled' THEN 6
             ELSE 7
           END,
           priority DESC,
           updated_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapGoalRow(row));
  }

  createPlan(params: {
    plan_id?: string;
    goal_id: string;
    title: string;
    summary: string;
    status?: PlanStatus;
    planner_kind?: PlanPlannerKind;
    planner_id?: string;
    selected?: boolean;
    confidence?: number;
    assumptions?: string[];
    success_criteria?: string[];
    rollback?: string[];
    budget?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    steps: Array<{
      step_id?: string;
      seq: number;
      title: string;
      step_kind?: PlanStepKind;
      status?: PlanStepStatus;
      executor_kind?: PlanExecutorKind;
      executor_ref?: string;
      tool_name?: string;
      input?: Record<string, unknown>;
      expected_artifact_types?: string[];
      acceptance_checks?: string[];
      retry_policy?: Record<string, unknown>;
      timeout_seconds?: number;
      metadata?: Record<string, unknown>;
      depends_on?: string[];
    }>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; plan: PlanRecord; steps: PlanStepRecord[] } {
    const now = new Date().toISOString();
    const planId = params.plan_id?.trim() || crypto.randomUUID();
    const existing = this.getPlanById(planId);
    if (existing) {
      return {
        created: false,
        plan: existing,
        steps: this.listPlanSteps(planId),
      };
    }

    const goalId = params.goal_id.trim();
    if (!goalId) {
      throw new Error("plan goal_id is required");
    }
    const goal = this.getGoalById(goalId);
    if (!goal) {
      throw new Error(`Plan goal not found: ${goalId}`);
    }

    const title = params.title.trim();
    const summary = params.summary.trim();
    if (!title || !summary) {
      throw new Error("plan title and summary are required");
    }

    const selected = parseBoolean(params.selected, false);
    const status =
      params.status === undefined && selected
        ? "selected"
        : normalizePlanStatus(params.status);
    const plannerKind = normalizePlanPlannerKind(params.planner_kind);
    const plannerId = params.planner_id?.trim() || null;
    const confidence =
      params.confidence === null || params.confidence === undefined
        ? null
        : parseBoundedFloat(params.confidence, 0, 0, 1);
    const assumptions = dedupeNonEmpty(params.assumptions ?? []);
    const successCriteria = dedupeNonEmpty(params.success_criteria ?? []);
    const rollback = dedupeNonEmpty(params.rollback ?? []);
    const budget = parseLooseObject(params.budget ?? {});
    const metadata = parseLooseObject(params.metadata ?? {});

    const rawSteps = params.steps ?? [];
    if (rawSteps.length === 0) {
      throw new Error("plan steps are required");
    }

    const stepIds = new Set<string>();
    const stepSeqs = new Set<number>();
    const preparedSteps = rawSteps.map((step, index) => {
      const stepId = step.step_id?.trim() || crypto.randomUUID();
      if (stepIds.has(stepId)) {
        throw new Error(`Duplicate plan step_id: ${stepId}`);
      }
      stepIds.add(stepId);

      const seq = parseBoundedInt(step.seq, index + 1, 1, 1_000_000);
      if (stepSeqs.has(seq)) {
        throw new Error(`Duplicate plan step seq: ${seq}`);
      }
      stepSeqs.add(seq);

      const stepTitle = step.title.trim();
      if (!stepTitle) {
        throw new Error("plan step title is required");
      }

      return {
        step_id: stepId,
        seq,
        title: stepTitle,
        step_kind: normalizePlanStepKind(step.step_kind),
        status: normalizePlanStepStatus(step.status),
        executor_kind: normalizeOptionalPlanExecutorKind(step.executor_kind),
        executor_ref: step.executor_ref?.trim() || null,
        tool_name: step.tool_name?.trim() || null,
        input: parseLooseObject(step.input ?? {}),
        expected_artifact_types: dedupeNonEmpty(step.expected_artifact_types ?? []),
        acceptance_checks: dedupeNonEmpty(step.acceptance_checks ?? []),
        retry_policy: parseLooseObject(step.retry_policy ?? {}),
        timeout_seconds:
          step.timeout_seconds === null || step.timeout_seconds === undefined
            ? null
            : parseBoundedInt(step.timeout_seconds, 60, 1, 86_400),
        metadata: parseLooseObject(step.metadata ?? {}),
        depends_on: dedupeNonEmpty(step.depends_on ?? []),
      };
    });

    for (const step of preparedSteps) {
      for (const dependencyId of step.depends_on) {
        if (dependencyId === step.step_id) {
          throw new Error(`Plan step cannot depend on itself: ${step.step_id}`);
        }
        if (!stepIds.has(dependencyId)) {
          throw new Error(`Plan step dependency not found in plan: ${dependencyId}`);
        }
      }
    }

    const create = this.db.transaction(() => {
      if (selected) {
        this.db
          .prepare(`UPDATE plans SET selected = 0, updated_at = ? WHERE goal_id = ?`)
          .run(now, goalId);
      }

      const inserted = this.db
        .prepare(
          `INSERT INTO plans (
             plan_id, goal_id, created_at, updated_at, title, summary, status, planner_kind, planner_id,
             selected, confidence, assumptions_json, success_criteria_json, rollback_json, budget_json,
             metadata_json, source_client, source_model, source_agent
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(plan_id) DO NOTHING`
        )
        .run(
          planId,
          goalId,
          now,
          now,
          title,
          summary,
          status,
          plannerKind,
          plannerId,
          selected ? 1 : 0,
          confidence,
          stableStringify(assumptions),
          stableStringify(successCriteria),
          stableStringify(rollback),
          stableStringify(budget),
          stableStringify(metadata),
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      const insertedCount = Number(inserted.changes ?? 0);
      if (insertedCount === 0) {
        return false;
      }

      const insertStep = this.db.prepare(
        `INSERT INTO plan_steps (
           step_id, plan_id, created_at, updated_at, seq, title, step_kind, status, executor_kind, executor_ref,
           tool_name, input_json, expected_artifact_types_json, acceptance_checks_json, retry_policy_json,
           timeout_seconds, task_id, run_id, metadata_json, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`
      );
      const insertEdge = this.db.prepare(
        `INSERT INTO plan_step_edges (
           id, plan_id, from_step_id, to_step_id, relation, condition_json
         ) VALUES (?, ?, ?, ?, 'depends_on', '{}')`
      );

      for (const step of preparedSteps) {
        insertStep.run(
          step.step_id,
          planId,
          now,
          now,
          step.seq,
          step.title,
          step.step_kind,
          step.status,
          step.executor_kind,
          step.executor_ref,
          step.tool_name,
          stableStringify(step.input),
          stableStringify(step.expected_artifact_types),
          stableStringify(step.acceptance_checks),
          stableStringify(step.retry_policy),
          step.timeout_seconds,
          stableStringify(step.metadata)
        );
        for (const dependencyId of step.depends_on) {
          insertEdge.run(crypto.randomUUID(), planId, dependencyId, step.step_id);
        }
      }

      if (selected) {
        this.db
          .prepare(`UPDATE goals SET updated_at = ?, active_plan_id = ? WHERE goal_id = ?`)
          .run(now, planId, goalId);
        this.appendGoalEvent({
          goal_id: goalId,
          event_type: "active_plan_updated",
          from_status: goal.status,
          to_status: goal.status,
          summary: "Goal active plan updated.",
          details: {
            active_plan_id: planId,
            selected: true,
          },
          source_client: params.source_client,
          source_model: params.source_model,
          source_agent: params.source_agent,
        });
      }

      return true;
    });
    const created = create();
    const plan = this.getPlanById(planId);
    if (!plan) {
      throw new Error(`Failed to read plan after create: ${planId}`);
    }
    return {
      created,
      plan,
      steps: this.listPlanSteps(planId),
    };
  }

  getPlanById(planId: string): PlanRecord | null {
    const normalized = planId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT plan_id, goal_id, created_at, updated_at, title, summary, status, planner_kind, planner_id,
                selected, confidence, assumptions_json, success_criteria_json, rollback_json, budget_json,
                metadata_json, source_client, source_model, source_agent
         FROM plans
         WHERE plan_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapPlanRow(row);
  }

  listPlans(params: {
    goal_id?: string;
    status?: PlanStatus;
    selected_only?: boolean;
    limit: number;
  }): PlanRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    const goalId = params.goal_id?.trim();

    if (goalId) {
      whereClauses.push("goal_id = ?");
      values.push(goalId);
    }
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizePlanStatus(params.status));
    }
    if (params.selected_only) {
      whereClauses.push("selected = 1");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT plan_id, goal_id, created_at, updated_at, title, summary, status, planner_kind, planner_id,
                selected, confidence, assumptions_json, success_criteria_json, rollback_json, budget_json,
                metadata_json, source_client, source_model, source_agent
         FROM plans
         ${whereSql}
         ORDER BY
           selected DESC,
           CASE status
             WHEN 'selected' THEN 0
             WHEN 'in_progress' THEN 1
             WHEN 'candidate' THEN 2
             WHEN 'draft' THEN 3
             WHEN 'completed' THEN 4
             WHEN 'invalidated' THEN 5
             ELSE 6
           END,
           updated_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapPlanRow(row));
  }

  listPlanSteps(planId: string): PlanStepRecord[] {
    const normalized = planId.trim();
    if (!normalized) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT step_id, plan_id, created_at, updated_at, seq, title, step_kind, status, executor_kind, executor_ref,
                tool_name, input_json, expected_artifact_types_json, acceptance_checks_json, retry_policy_json,
                timeout_seconds, task_id, run_id, metadata_json, started_at, finished_at
         FROM plan_steps
         WHERE plan_id = ?
         ORDER BY seq ASC`
      )
      .all(normalized) as Array<Record<string, unknown>>;
    const edgeRows = this.db
      .prepare(
        `SELECT from_step_id, to_step_id
         FROM plan_step_edges
         WHERE plan_id = ?
         ORDER BY from_step_id ASC`
      )
      .all(normalized) as Array<Record<string, unknown>>;
    const dependsOnByStepId = new Map<string, string[]>();
    for (const row of edgeRows) {
      const toStepId = String(row.to_step_id ?? "");
      const fromStepId = String(row.from_step_id ?? "");
      if (!toStepId || !fromStepId) {
        continue;
      }
      const current = dependsOnByStepId.get(toStepId) ?? [];
      current.push(fromStepId);
      dependsOnByStepId.set(toStepId, current);
    }
    return rows.map((row) =>
      mapPlanStepRow(row, dependsOnByStepId.get(String(row.step_id ?? "")) ?? [])
    );
  }

  updatePlan(params: {
    plan_id: string;
    title?: string;
    summary?: string;
    status?: PlanStatus;
    selected?: boolean;
    deselect_other_plans?: boolean;
    planner_id?: string;
    confidence?: number | null;
    assumptions?: string[];
    success_criteria?: string[];
    rollback?: string[];
    budget?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { plan: PlanRecord; steps: PlanStepRecord[] } {
    const planId = params.plan_id.trim();
    if (!planId) {
      throw new Error("plan_id is required");
    }
    const existing = this.getPlanById(planId);
    if (!existing) {
      throw new Error(`Plan not found: ${planId}`);
    }
    const now = new Date().toISOString();
    const selected =
      typeof params.selected === "boolean" ? params.selected : existing.selected;
    const title = params.title?.trim() || existing.title;
    const summary = params.summary?.trim() || existing.summary;
    const status = normalizeUpdatedPlanStatus(existing, params.status, params.selected);
    const plannerId = params.planner_id === undefined ? existing.planner_id : params.planner_id?.trim() || null;
    const confidence =
      params.confidence === undefined
        ? existing.confidence
        : params.confidence === null
          ? null
          : parseBoundedFloat(params.confidence, 0, 0, 1);
    const assumptions = params.assumptions ? dedupeNonEmpty(params.assumptions) : existing.assumptions;
    const successCriteria = params.success_criteria
      ? dedupeNonEmpty(params.success_criteria)
      : existing.success_criteria;
    const rollback = params.rollback ? dedupeNonEmpty(params.rollback) : existing.rollback;
    const budget = params.budget ? parseLooseObject(params.budget) : existing.budget;
    const metadata = params.metadata ? { ...existing.metadata, ...parseLooseObject(params.metadata) } : existing.metadata;
    const deselectOtherPlans = params.deselect_other_plans !== false;

    const update = this.db.transaction(() => {
      if (selected && deselectOtherPlans) {
        this.db
          .prepare(`UPDATE plans SET selected = 0, updated_at = ? WHERE goal_id = ? AND plan_id <> ?`)
          .run(now, existing.goal_id, planId);
      }

      this.db
        .prepare(
          `UPDATE plans
           SET updated_at = ?,
               title = ?,
               summary = ?,
               status = ?,
               planner_id = ?,
               selected = ?,
               confidence = ?,
               assumptions_json = ?,
               success_criteria_json = ?,
               rollback_json = ?,
               budget_json = ?,
               metadata_json = ?
           WHERE plan_id = ?`
        )
        .run(
          now,
          title,
          summary,
          status,
          plannerId,
          selected ? 1 : 0,
          confidence,
          stableStringify(assumptions),
          stableStringify(successCriteria),
          stableStringify(rollback),
          stableStringify(budget),
          stableStringify(metadata),
          planId
        );

      const previousActivePlanId = existing.goal_id ? this.getGoalById(existing.goal_id)?.active_plan_id ?? null : null;
      let nextActivePlanId = previousActivePlanId;
      if (selected) {
        nextActivePlanId = planId;
      } else if (previousActivePlanId === planId) {
        const replacement = this.db
          .prepare(
            `SELECT plan_id
             FROM plans
             WHERE goal_id = ? AND plan_id <> ? AND selected = 1
             ORDER BY updated_at DESC
             LIMIT 1`
          )
          .get(existing.goal_id, planId) as Record<string, unknown> | undefined;
        nextActivePlanId = replacement ? String(replacement.plan_id ?? "") || null : null;
      }

      if (nextActivePlanId !== previousActivePlanId) {
        this.db
          .prepare(`UPDATE goals SET updated_at = ?, active_plan_id = ? WHERE goal_id = ?`)
          .run(now, nextActivePlanId, existing.goal_id);
        this.appendGoalEvent({
          goal_id: existing.goal_id,
          event_type: "active_plan_updated",
          from_status: null,
          to_status: null,
          summary: "Goal active plan updated.",
          details: {
            previous_active_plan_id: previousActivePlanId,
            active_plan_id: nextActivePlanId,
          },
          source_client: params.source_client,
          source_model: params.source_model,
          source_agent: params.source_agent,
        });
      }
    });
    update();

    const plan = this.getPlanById(planId);
    if (!plan) {
      throw new Error(`Failed to read plan after update: ${planId}`);
    }
    return {
      plan,
      steps: this.listPlanSteps(planId),
    };
  }

  updatePlanStep(params: {
    plan_id: string;
    step_id: string;
    status?: PlanStepStatus;
    summary?: string;
    executor_kind?: PlanExecutorKind;
    executor_ref?: string;
    task_id?: string;
    run_id?: string;
    produced_artifact_ids?: string[];
    metadata?: Record<string, unknown>;
  }): { plan: PlanRecord; step: PlanStepRecord } {
    const planId = params.plan_id.trim();
    const stepId = params.step_id.trim();
    if (!planId || !stepId) {
      throw new Error("plan_id and step_id are required");
    }

    const plan = this.getPlanById(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }
    const existingStep = this.listPlanSteps(planId).find((step) => step.step_id === stepId);
    if (!existingStep) {
      throw new Error(`Plan step not found: ${stepId}`);
    }

    const nextStatus = params.status ? normalizePlanStepStatus(params.status) : existingStep.status;
    const nextExecutorKind =
      params.executor_kind === undefined
        ? existingStep.executor_kind
        : normalizeOptionalPlanExecutorKind(params.executor_kind);
    const nextExecutorRef =
      params.executor_ref === undefined ? existingStep.executor_ref : params.executor_ref?.trim() || null;
    const nextTaskId = params.task_id === undefined ? existingStep.task_id : params.task_id?.trim() || null;
    const nextRunId = params.run_id === undefined ? existingStep.run_id : params.run_id?.trim() || null;
    const nextMetadata = {
      ...existingStep.metadata,
      ...parseLooseObject(params.metadata ?? {}),
    } as Record<string, unknown>;
    if (params.summary?.trim()) {
      nextMetadata.last_summary = params.summary.trim();
    }
    if (params.produced_artifact_ids?.length) {
      nextMetadata.produced_artifact_ids = dedupeNonEmpty(params.produced_artifact_ids);
    }

    const now = new Date().toISOString();
    let startedAt = existingStep.started_at;
    let finishedAt = existingStep.finished_at;
    if (nextStatus === "running") {
      startedAt = startedAt ?? now;
      finishedAt = null;
    } else if (
      nextStatus === "completed" ||
      nextStatus === "failed" ||
      nextStatus === "skipped" ||
      nextStatus === "invalidated"
    ) {
      startedAt = startedAt ?? now;
      finishedAt = now;
    } else if (nextStatus === "pending" || nextStatus === "ready" || nextStatus === "blocked") {
      finishedAt = null;
    }

    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE plan_steps
           SET updated_at = ?,
               status = ?,
               executor_kind = ?,
               executor_ref = ?,
               task_id = ?,
               run_id = ?,
               metadata_json = ?,
               started_at = ?,
               finished_at = ?
           WHERE plan_id = ? AND step_id = ?`
        )
        .run(
          now,
          nextStatus,
          nextExecutorKind,
          nextExecutorRef,
          nextTaskId,
          nextRunId,
          stableStringify(nextMetadata),
          startedAt,
          finishedAt,
          planId,
          stepId
        );

      const updatedSteps = this.listPlanSteps(planId).map((step) =>
        step.step_id === stepId
          ? {
              ...step,
              updated_at: now,
              status: nextStatus,
              executor_kind: nextExecutorKind,
              executor_ref: nextExecutorRef,
              task_id: nextTaskId,
              run_id: nextRunId,
              metadata: nextMetadata,
              started_at: startedAt,
              finished_at: finishedAt,
            }
          : step
      );
      const nextPlanStatus = derivePlanProgressStatus(plan.status, updatedSteps);
      if (nextPlanStatus !== plan.status) {
        this.db
          .prepare(`UPDATE plans SET updated_at = ?, status = ? WHERE plan_id = ?`)
          .run(now, nextPlanStatus, planId);
      } else {
        this.db.prepare(`UPDATE plans SET updated_at = ? WHERE plan_id = ?`).run(now, planId);
      }
    });
    update();

    const updatedPlan = this.getPlanById(planId);
    const updatedStep = this.listPlanSteps(planId).find((step) => step.step_id === stepId);
    if (!updatedPlan || !updatedStep) {
      throw new Error(`Failed to read updated plan step: ${stepId}`);
    }
    return {
      plan: updatedPlan,
      step: updatedStep,
    };
  }

  upsertAgentSession(params: {
    session_id?: string;
    agent_id: string;
    status?: AgentSessionStatus;
    display_name?: string;
    client_kind?: string;
    transport_kind?: string;
    workspace_root?: string;
    owner_id?: string;
    lease_seconds?: number;
    capabilities?: Record<string, unknown>;
    tags?: string[];
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; session: AgentSessionRecord } {
    const now = new Date().toISOString();
    const sessionId = params.session_id?.trim() || crypto.randomUUID();
    const existing = this.getAgentSessionById(sessionId);
    const agentId = params.agent_id.trim();
    if (!agentId) {
      throw new Error("agent_id is required");
    }
    const leaseSeconds =
      params.lease_seconds === undefined ? 300 : parseBoundedInt(params.lease_seconds, 300, 15, 86400);
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const status = normalizeAgentSessionStatus(params.status ?? existing?.status);
    const displayName = params.display_name === undefined ? existing?.display_name ?? null : params.display_name?.trim() || null;
    const clientKind = params.client_kind === undefined ? existing?.client_kind ?? null : params.client_kind?.trim() || null;
    const transportKind =
      params.transport_kind === undefined ? existing?.transport_kind ?? null : params.transport_kind?.trim() || null;
    const workspaceRoot =
      params.workspace_root === undefined ? existing?.workspace_root ?? null : params.workspace_root?.trim() || null;
    const ownerId = params.owner_id === undefined ? existing?.owner_id ?? null : params.owner_id?.trim() || null;
    const capabilities =
      params.capabilities === undefined ? existing?.capabilities ?? {} : parseLooseObject(params.capabilities);
    const tags = params.tags === undefined ? existing?.tags ?? [] : dedupeNonEmpty(params.tags);
    const metadata =
      params.metadata === undefined
        ? existing?.metadata ?? {}
        : {
            ...(existing?.metadata ?? {}),
            ...parseLooseObject(params.metadata),
          };
    const startedAt = existing?.started_at ?? now;
    const endedAt = status === "closed" ? existing?.ended_at ?? now : null;

    this.db
      .prepare(
        `INSERT INTO agent_sessions (
           session_id, agent_id, created_at, updated_at, started_at, ended_at, status, display_name,
           client_kind, transport_kind, workspace_root, owner_id, lease_expires_at, heartbeat_at,
           capabilities_json, tags_json, metadata_json, source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           updated_at = excluded.updated_at,
           ended_at = excluded.ended_at,
           status = excluded.status,
           display_name = excluded.display_name,
           client_kind = excluded.client_kind,
           transport_kind = excluded.transport_kind,
           workspace_root = excluded.workspace_root,
           owner_id = excluded.owner_id,
           lease_expires_at = excluded.lease_expires_at,
           heartbeat_at = excluded.heartbeat_at,
           capabilities_json = excluded.capabilities_json,
           tags_json = excluded.tags_json,
           metadata_json = excluded.metadata_json,
           source_client = excluded.source_client,
           source_model = excluded.source_model,
           source_agent = excluded.source_agent`
      )
      .run(
        sessionId,
        agentId,
        existing?.created_at ?? now,
        now,
        startedAt,
        endedAt,
        status,
        displayName,
        clientKind,
        transportKind,
        workspaceRoot,
        ownerId,
        leaseExpiresAt,
        now,
        stableStringify(capabilities),
        stableStringify(tags),
        stableStringify(metadata),
        params.source_client ?? existing?.source_client ?? null,
        params.source_model ?? existing?.source_model ?? null,
        params.source_agent ?? existing?.source_agent ?? null
      );

    const session = this.getAgentSessionById(sessionId);
    if (!session) {
      throw new Error(`Failed to read agent session after upsert: ${sessionId}`);
    }
    return {
      created: existing === null,
      session,
    };
  }

  getAgentSessionById(sessionId: string): AgentSessionRecord | null {
    const normalized = sessionId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT session_id, agent_id, created_at, updated_at, started_at, ended_at, status, display_name,
                client_kind, transport_kind, workspace_root, owner_id, lease_expires_at, heartbeat_at,
                capabilities_json, tags_json, metadata_json, source_client, source_model, source_agent
         FROM agent_sessions
         WHERE session_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapAgentSessionRow(row);
  }

  listAgentSessions(params: {
    status?: AgentSessionStatus;
    agent_id?: string;
    client_kind?: string;
    active_only?: boolean;
    limit: number;
  }): AgentSessionRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const now = new Date().toISOString();
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeAgentSessionStatus(params.status));
    }
    const agentId = params.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    const clientKind = params.client_kind?.trim();
    if (clientKind) {
      whereClauses.push("client_kind = ?");
      values.push(clientKind);
    }
    if (params.active_only) {
      whereClauses.push("status <> 'closed'");
      whereClauses.push("(lease_expires_at IS NULL OR lease_expires_at > ?)");
      values.push(now);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT session_id, agent_id, created_at, updated_at, started_at, ended_at, status, display_name,
                client_kind, transport_kind, workspace_root, owner_id, lease_expires_at, heartbeat_at,
                capabilities_json, tags_json, metadata_json, source_client, source_model, source_agent
         FROM agent_sessions
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapAgentSessionRow(row));
  }

  heartbeatAgentSession(params: {
    session_id: string;
    lease_seconds?: number;
    status?: AgentSessionStatus;
    owner_id?: string;
    capabilities?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): { renewed: boolean; reason: string; session?: AgentSessionRecord } {
    const sessionId = params.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }
    const existing = this.getAgentSessionById(sessionId);
    if (!existing) {
      return {
        renewed: false,
        reason: "not-found",
      };
    }
    const now = new Date().toISOString();
    const leaseSeconds =
      params.lease_seconds === undefined ? 300 : parseBoundedInt(params.lease_seconds, 300, 15, 86400);
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const status = params.status === undefined ? existing.status : normalizeAgentSessionStatus(params.status);
    const ownerId = params.owner_id === undefined ? existing.owner_id : params.owner_id?.trim() || null;
    const capabilities =
      params.capabilities === undefined ? existing.capabilities : parseLooseObject(params.capabilities);
    const metadata =
      params.metadata === undefined
        ? existing.metadata
        : {
            ...existing.metadata,
            ...parseLooseObject(params.metadata),
          };

    this.db
      .prepare(
        `UPDATE agent_sessions
         SET updated_at = ?,
             ended_at = ?,
             status = ?,
             owner_id = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             capabilities_json = ?,
             metadata_json = ?
         WHERE session_id = ?`
      )
      .run(
        now,
        status === "closed" ? existing.ended_at ?? now : null,
        status,
        ownerId,
        leaseExpiresAt,
        now,
        stableStringify(capabilities),
        stableStringify(metadata),
        sessionId
      );

    const session = this.getAgentSessionById(sessionId);
    return {
      renewed: Boolean(session),
      reason: session ? "heartbeat-recorded" : "not-found",
      session: session ?? undefined,
    };
  }

  closeAgentSession(params: {
    session_id: string;
    metadata?: Record<string, unknown>;
  }): { closed: boolean; reason: string; session?: AgentSessionRecord } {
    const sessionId = params.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }
    const existing = this.getAgentSessionById(sessionId);
    if (!existing) {
      return {
        closed: false,
        reason: "not-found",
      };
    }
    const now = new Date().toISOString();
    const metadata = params.metadata
      ? {
          ...existing.metadata,
          ...parseLooseObject(params.metadata),
        }
      : existing.metadata;

    this.db
      .prepare(
        `UPDATE agent_sessions
         SET updated_at = ?, ended_at = ?, status = 'closed', lease_expires_at = ?, heartbeat_at = ?, metadata_json = ?
         WHERE session_id = ?`
      )
      .run(now, existing.ended_at ?? now, now, now, stableStringify(metadata), sessionId);

    const session = this.getAgentSessionById(sessionId);
    return {
      closed: Boolean(session),
      reason: session ? "closed" : "not-found",
      session: session ?? undefined,
    };
  }

  recordAgentLearningEntry(params: {
    entry_id?: string;
    agent_id: string;
    status?: AgentLearningEntryStatus;
    lesson_kind: AgentLearningEntryKind;
    polarity: AgentLearningEntryPolarity;
    scope?: string;
    summary: string;
    lesson: string;
    evidence?: string;
    source_run_id?: string;
    source_task_id?: string;
    thread_id?: string;
    turn_id?: string;
    confidence?: number;
    weight?: number;
    fingerprint: string;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; entry: AgentLearningEntryRecord } {
    const agentId = params.agent_id.trim();
    if (!agentId) {
      throw new Error("agent_id is required");
    }
    const summary = params.summary.trim();
    if (!summary) {
      throw new Error("summary is required");
    }
    const lesson = params.lesson.trim();
    if (!lesson) {
      throw new Error("lesson is required");
    }
    const fingerprint = params.fingerprint.trim();
    if (!fingerprint) {
      throw new Error("fingerprint is required");
    }
    const now = new Date().toISOString();
    const status = normalizeAgentLearningEntryStatus(params.status ?? "active");
    const lessonKind = normalizeAgentLearningEntryKind(params.lesson_kind);
    const polarity = normalizeAgentLearningEntryPolarity(params.polarity);
    const scope = params.scope?.trim() || null;
    const evidence = params.evidence?.trim() || null;
    const parsedConfidence = params.confidence === undefined || params.confidence === null ? null : Number(params.confidence);
    const confidence =
      parsedConfidence === null || !Number.isFinite(parsedConfidence)
        ? null
        : Math.max(0, Math.min(1, parsedConfidence));
    const parsedWeight = params.weight === undefined || params.weight === null ? null : Number(params.weight);
    const weight =
      parsedWeight === null || !Number.isFinite(parsedWeight)
        ? 0.5
        : Math.max(0.05, Math.min(1, parsedWeight));
    const metadata = parseLooseObject(params.metadata ?? {});
    const existing = this.db
      .prepare(
        `SELECT entry_id
         FROM agent_learning_entries
         WHERE agent_id = ? AND fingerprint = ?`
      )
      .get(agentId, fingerprint) as Record<string, unknown> | undefined;
    const entryId = (params.entry_id?.trim() || asNullableString(existing?.entry_id) || crypto.randomUUID()) as string;

    this.db
      .prepare(
        `INSERT INTO agent_learning_entries (
           entry_id, agent_id, created_at, updated_at, status, lesson_kind, polarity, scope,
           summary, lesson, evidence, source_run_id, source_task_id, thread_id, turn_id,
           confidence, weight, fingerprint, metadata_json, source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           status = excluded.status,
           lesson_kind = excluded.lesson_kind,
           polarity = excluded.polarity,
           scope = excluded.scope,
           summary = excluded.summary,
           lesson = excluded.lesson,
           evidence = excluded.evidence,
           source_run_id = excluded.source_run_id,
           source_task_id = excluded.source_task_id,
           thread_id = excluded.thread_id,
           turn_id = excluded.turn_id,
           confidence = excluded.confidence,
           weight = excluded.weight,
           fingerprint = excluded.fingerprint,
           metadata_json = excluded.metadata_json,
           source_client = excluded.source_client,
           source_model = excluded.source_model,
           source_agent = excluded.source_agent`
      )
      .run(
        entryId,
        agentId,
        existing ? now : now,
        now,
        status,
        lessonKind,
        polarity,
        scope,
        summary,
        lesson,
        evidence,
        params.source_run_id?.trim() || null,
        params.source_task_id?.trim() || null,
        params.thread_id?.trim() || null,
        params.turn_id?.trim() || null,
        confidence,
        weight,
        fingerprint,
        stableStringify(metadata),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const entry = this.getAgentLearningEntryById(entryId);
    if (!entry) {
      throw new Error(`Failed to read agent learning entry after upsert: ${entryId}`);
    }
    return {
      created: !existing,
      entry,
    };
  }

  getAgentLearningEntryById(entryId: string): AgentLearningEntryRecord | null {
    const normalized = entryId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT entry_id, agent_id, created_at, updated_at, status, lesson_kind, polarity, scope,
                summary, lesson, evidence, source_run_id, source_task_id, thread_id, turn_id,
                confidence, weight, fingerprint, metadata_json, source_client, source_model, source_agent
         FROM agent_learning_entries
         WHERE entry_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapAgentLearningEntryRow(row);
  }

  listAgentLearningEntries(params: {
    agent_id?: string;
    status?: AgentLearningEntryStatus;
    lesson_kind?: AgentLearningEntryKind;
    polarity?: AgentLearningEntryPolarity;
    limit: number;
  }): AgentLearningEntryRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    const agentId = params.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeAgentLearningEntryStatus(params.status));
    }
    if (params.lesson_kind) {
      whereClauses.push("lesson_kind = ?");
      values.push(normalizeAgentLearningEntryKind(params.lesson_kind));
    }
    if (params.polarity) {
      whereClauses.push("polarity = ?");
      values.push(normalizeAgentLearningEntryPolarity(params.polarity));
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT entry_id, agent_id, created_at, updated_at, status, lesson_kind, polarity, scope,
                summary, lesson, evidence, source_run_id, source_task_id, thread_id, turn_id,
                confidence, weight, fingerprint, metadata_json, source_client, source_model, source_agent
         FROM agent_learning_entries
         ${whereSql}
         ORDER BY weight DESC, updated_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapAgentLearningEntryRow(row));
  }

  recordArtifact(params: {
    artifact_id?: string;
    artifact_type: string;
    status?: ArtifactStatus;
    goal_id?: string;
    plan_id?: string;
    step_id?: string;
    task_id?: string;
    run_id?: string;
    thread_id?: string;
    turn_id?: string;
    pack_id?: string;
    producer_kind: string;
    producer_id?: string;
    uri?: string;
    content_text?: string;
    content_json?: Record<string, unknown>;
    hash?: string;
    trust_tier?: ArtifactTrustTier;
    freshness_expires_at?: string;
    supersedes_artifact_id?: string;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; artifact: ArtifactRecord } {
    const now = new Date().toISOString();
    const artifactId = params.artifact_id?.trim() || crypto.randomUUID();
    const existing = this.getArtifactById(artifactId);
    if (existing) {
      return {
        created: false,
        artifact: existing,
      };
    }
    const artifactType = params.artifact_type.trim();
    if (!artifactType) {
      throw new Error("artifact_type is required");
    }
    const producerKind = params.producer_kind.trim();
    if (!producerKind) {
      throw new Error("producer_kind is required");
    }
    if (!params.uri && !params.content_text && !params.content_json) {
      throw new Error("artifact requires uri, content_text, or content_json");
    }

    this.db
      .prepare(
        `INSERT INTO artifacts (
           artifact_id, created_at, updated_at, artifact_type, status, goal_id, plan_id, step_id, task_id, run_id,
           thread_id, turn_id, pack_id, producer_kind, producer_id, uri, content_text, content_json, hash, trust_tier,
           freshness_expires_at, supersedes_artifact_id, metadata_json, source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        now,
        now,
        artifactType,
        normalizeArtifactStatus(params.status),
        params.goal_id?.trim() || null,
        params.plan_id?.trim() || null,
        params.step_id?.trim() || null,
        params.task_id?.trim() || null,
        params.run_id?.trim() || null,
        params.thread_id?.trim() || null,
        params.turn_id?.trim() || null,
        params.pack_id?.trim() || null,
        producerKind,
        params.producer_id?.trim() || null,
        params.uri?.trim() || null,
        params.content_text ?? null,
        params.content_json ? stableStringify(parseLooseObject(params.content_json)) : null,
        params.hash?.trim() || null,
        normalizeArtifactTrustTier(params.trust_tier),
        normalizeOptionalIsoTimestamp(params.freshness_expires_at),
        params.supersedes_artifact_id?.trim() || null,
        stableStringify(parseLooseObject(params.metadata ?? {})),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const artifact = this.getArtifactById(artifactId);
    if (!artifact) {
      throw new Error(`Failed to read artifact after record: ${artifactId}`);
    }
    return {
      created: true,
      artifact,
    };
  }

  getArtifactById(artifactId: string): ArtifactRecord | null {
    const normalized = artifactId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT artifact_id, created_at, updated_at, artifact_type, status, goal_id, plan_id, step_id, task_id, run_id,
                thread_id, turn_id, pack_id, producer_kind, producer_id, uri, content_text, content_json, hash, trust_tier,
                freshness_expires_at, supersedes_artifact_id, metadata_json, source_client, source_model, source_agent
         FROM artifacts
         WHERE artifact_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapArtifactRow(row);
  }

  listArtifacts(params: {
    artifact_type?: string;
    trust_tier?: ArtifactTrustTier;
    goal_id?: string;
    plan_id?: string;
    step_id?: string;
    task_id?: string;
    run_id?: string;
    thread_id?: string;
    turn_id?: string;
    pack_id?: string;
    linked_entity_type?: string;
    linked_entity_id?: string;
    limit: number;
  }): ArtifactRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    const artifactType = params.artifact_type?.trim();
    if (artifactType) {
      whereClauses.push("a.artifact_type = ?");
      values.push(artifactType);
    }
    if (params.trust_tier) {
      whereClauses.push("a.trust_tier = ?");
      values.push(normalizeArtifactTrustTier(params.trust_tier));
    }
    for (const [field, value] of [
      ["goal_id", params.goal_id],
      ["plan_id", params.plan_id],
      ["step_id", params.step_id],
      ["task_id", params.task_id],
      ["run_id", params.run_id],
      ["thread_id", params.thread_id],
      ["turn_id", params.turn_id],
      ["pack_id", params.pack_id],
    ] as Array<[string, string | undefined]>) {
      const normalized = value?.trim();
      if (normalized) {
        whereClauses.push(`a.${field} = ?`);
        values.push(normalized);
      }
    }
    const linkedEntityType = params.linked_entity_type?.trim();
    const linkedEntityId = params.linked_entity_id?.trim();
    if (linkedEntityType && linkedEntityId) {
      whereClauses.push(
        `EXISTS (
           SELECT 1
           FROM artifact_links links
           WHERE links.src_artifact_id = a.artifact_id
             AND links.dst_entity_type = ?
             AND links.dst_entity_id = ?
         )`
      );
      values.push(linkedEntityType, linkedEntityId);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT a.artifact_id, a.created_at, a.updated_at, a.artifact_type, a.status, a.goal_id, a.plan_id, a.step_id, a.task_id, a.run_id,
                a.thread_id, a.turn_id, a.pack_id, a.producer_kind, a.producer_id, a.uri, a.content_text, a.content_json, a.hash, a.trust_tier,
                a.freshness_expires_at, a.supersedes_artifact_id, a.metadata_json, a.source_client, a.source_model, a.source_agent
         FROM artifacts a
         ${whereSql}
         ORDER BY a.created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapArtifactRow(row));
  }

  linkArtifact(params: {
    src_artifact_id: string;
    dst_artifact_id?: string;
    dst_entity_type?: string;
    dst_entity_id?: string;
    relation: string;
    rationale?: string;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; link: ArtifactLinkRecord } {
    const now = new Date().toISOString();
    const srcArtifactId = params.src_artifact_id.trim();
    if (!srcArtifactId) {
      throw new Error("src_artifact_id is required");
    }
    const relation = params.relation.trim();
    if (!relation) {
      throw new Error("relation is required");
    }
    const dstArtifactId = params.dst_artifact_id?.trim() || null;
    const dstEntityType = params.dst_entity_type?.trim() || null;
    const dstEntityId = params.dst_entity_id?.trim() || null;
    if (!dstArtifactId && !(dstEntityType && dstEntityId)) {
      throw new Error("dst_artifact_id or dst_entity_type/dst_entity_id is required");
    }

    const existing = this.db
      .prepare(
        `SELECT id, created_at, src_artifact_id, dst_artifact_id, dst_entity_type, dst_entity_id, relation, rationale,
                metadata_json, source_client, source_model, source_agent
         FROM artifact_links
         WHERE src_artifact_id = ?
           AND COALESCE(dst_artifact_id, '') = COALESCE(?, '')
           AND COALESCE(dst_entity_type, '') = COALESCE(?, '')
           AND COALESCE(dst_entity_id, '') = COALESCE(?, '')
           AND relation = ?
         LIMIT 1`
      )
      .get(srcArtifactId, dstArtifactId, dstEntityType, dstEntityId, relation) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        created: false,
        link: mapArtifactLinkRow(existing),
      };
    }

    const linkId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO artifact_links (
           id, created_at, src_artifact_id, dst_artifact_id, dst_entity_type, dst_entity_id, relation, rationale,
           metadata_json, source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        linkId,
        now,
        srcArtifactId,
        dstArtifactId,
        dstEntityType,
        dstEntityId,
        relation,
        params.rationale?.trim() || null,
        stableStringify(parseLooseObject(params.metadata ?? {})),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const link = this.getArtifactLinkById(linkId);
    if (!link) {
      throw new Error(`Failed to read artifact link after create: ${linkId}`);
    }
    return {
      created: true,
      link,
    };
  }

  getArtifactLinkById(linkId: string): ArtifactLinkRecord | null {
    const normalized = linkId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT id, created_at, src_artifact_id, dst_artifact_id, dst_entity_type, dst_entity_id, relation, rationale,
                metadata_json, source_client, source_model, source_agent
         FROM artifact_links
         WHERE id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapArtifactLinkRow(row);
  }

  listArtifactLinks(params: {
    artifact_id?: string;
    entity_type?: string;
    entity_id?: string;
    limit: number;
  }): ArtifactLinkRecord[] {
    const limit = Math.max(1, Math.min(1000, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    const artifactId = params.artifact_id?.trim();
    if (artifactId) {
      whereClauses.push("(src_artifact_id = ? OR dst_artifact_id = ?)");
      values.push(artifactId, artifactId);
    }
    const entityType = params.entity_type?.trim();
    const entityId = params.entity_id?.trim();
    if (entityType && entityId) {
      whereClauses.push("dst_entity_type = ? AND dst_entity_id = ?");
      values.push(entityType, entityId);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, created_at, src_artifact_id, dst_artifact_id, dst_entity_type, dst_entity_id, relation, rationale,
                metadata_json, source_client, source_model, source_agent
         FROM artifact_links
         ${whereSql}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapArtifactLinkRow(row));
  }

  createExperiment(params: {
    experiment_id?: string;
    goal_id?: string;
    plan_id?: string;
    step_id?: string;
    title: string;
    objective: string;
    hypothesis?: string;
    status?: ExperimentStatus;
    metric_name: string;
    metric_direction?: ExperimentMetricDirection;
    baseline_metric?: number;
    current_best_metric?: number;
    acceptance_delta?: number;
    budget_seconds?: number;
    run_command?: string;
    parse_strategy?: Record<string, unknown>;
    rollback_strategy?: Record<string, unknown>;
    candidate_scope?: Record<string, unknown>;
    tags?: string[];
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; experiment: ExperimentRecord } {
    const now = new Date().toISOString();
    const experimentId = params.experiment_id?.trim() || crypto.randomUUID();
    const existing = this.getExperimentById(experimentId);
    if (existing) {
      return {
        created: false,
        experiment: existing,
      };
    }
    const title = params.title.trim();
    const objective = params.objective.trim();
    const metricName = params.metric_name.trim();
    if (!title || !objective || !metricName) {
      throw new Error("experiment title, objective, and metric_name are required");
    }
    const baselineMetric =
      params.baseline_metric === undefined || params.baseline_metric === null ? null : Number(params.baseline_metric);
    const currentBestMetric =
      params.current_best_metric === undefined
        ? baselineMetric
        : params.current_best_metric === null
          ? null
          : Number(params.current_best_metric);

    this.db
      .prepare(
        `INSERT INTO experiments (
           experiment_id, created_at, updated_at, goal_id, plan_id, step_id, title, objective, hypothesis, status,
           metric_name, metric_direction, baseline_metric, current_best_metric, acceptance_delta, budget_seconds, run_command,
           parse_strategy_json, rollback_strategy_json, candidate_scope_json, tags_json, metadata_json, selected_run_id,
           source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        experimentId,
        now,
        now,
        params.goal_id?.trim() || null,
        params.plan_id?.trim() || null,
        params.step_id?.trim() || null,
        title,
        objective,
        params.hypothesis?.trim() || null,
        normalizeExperimentStatus(params.status),
        metricName,
        normalizeExperimentMetricDirection(params.metric_direction),
        baselineMetric,
        currentBestMetric,
        parseBoundedFloat(params.acceptance_delta, 0, 0, Number.MAX_SAFE_INTEGER),
        params.budget_seconds === undefined ? null : parseBoundedInt(params.budget_seconds, 0, 1, 86400),
        params.run_command?.trim() || null,
        stableStringify(parseLooseObject(params.parse_strategy ?? {})),
        stableStringify(parseLooseObject(params.rollback_strategy ?? {})),
        stableStringify(parseLooseObject(params.candidate_scope ?? {})),
        stableStringify(dedupeNonEmpty(params.tags ?? [])),
        stableStringify(parseLooseObject(params.metadata ?? {})),
        null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const experiment = this.getExperimentById(experimentId);
    if (!experiment) {
      throw new Error(`Failed to read experiment after create: ${experimentId}`);
    }
    return {
      created: true,
      experiment,
    };
  }

  getExperimentById(experimentId: string): ExperimentRecord | null {
    const normalized = experimentId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT experiment_id, created_at, updated_at, goal_id, plan_id, step_id, title, objective, hypothesis, status,
                metric_name, metric_direction, baseline_metric, current_best_metric, acceptance_delta, budget_seconds, run_command,
                parse_strategy_json, rollback_strategy_json, candidate_scope_json, tags_json, metadata_json, selected_run_id,
                source_client, source_model, source_agent
         FROM experiments
         WHERE experiment_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapExperimentRow(row);
  }

  listExperiments(params: {
    status?: ExperimentStatus;
    goal_id?: string;
    plan_id?: string;
    step_id?: string;
    limit: number;
  }): ExperimentRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeExperimentStatus(params.status));
    }
    for (const [field, value] of [
      ["goal_id", params.goal_id],
      ["plan_id", params.plan_id],
      ["step_id", params.step_id],
    ] as Array<[string, string | undefined]>) {
      const normalized = value?.trim();
      if (normalized) {
        whereClauses.push(`${field} = ?`);
        values.push(normalized);
      }
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT experiment_id, created_at, updated_at, goal_id, plan_id, step_id, title, objective, hypothesis, status,
                metric_name, metric_direction, baseline_metric, current_best_metric, acceptance_delta, budget_seconds, run_command,
                parse_strategy_json, rollback_strategy_json, candidate_scope_json, tags_json, metadata_json, selected_run_id,
                source_client, source_model, source_agent
         FROM experiments
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapExperimentRow(row));
  }

  updateExperiment(params: {
    experiment_id: string;
    status?: ExperimentStatus;
    current_best_metric?: number | null;
    selected_run_id?: string | null;
    metadata?: Record<string, unknown>;
  }): { experiment: ExperimentRecord } {
    const experimentId = params.experiment_id.trim();
    if (!experimentId) {
      throw new Error("experiment_id is required");
    }
    const existing = this.getExperimentById(experimentId);
    if (!existing) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }
    const now = new Date().toISOString();
    const status = params.status ? normalizeExperimentStatus(params.status) : existing.status;
    const currentBestMetric =
      params.current_best_metric === undefined ? existing.current_best_metric : params.current_best_metric;
    const selectedRunId =
      params.selected_run_id === undefined ? existing.selected_run_id : params.selected_run_id?.trim() || null;
    const metadata =
      params.metadata === undefined
        ? existing.metadata
        : {
            ...existing.metadata,
            ...parseLooseObject(params.metadata),
          };

    this.db
      .prepare(
        `UPDATE experiments
         SET updated_at = ?, status = ?, current_best_metric = ?, selected_run_id = ?, metadata_json = ?
         WHERE experiment_id = ?`
      )
      .run(now, status, currentBestMetric, selectedRunId, stableStringify(metadata), experimentId);

    const experiment = this.getExperimentById(experimentId);
    if (!experiment) {
      throw new Error(`Failed to read experiment after update: ${experimentId}`);
    }
    return {
      experiment,
    };
  }

  createExperimentRun(params: {
    experiment_run_id?: string;
    experiment_id: string;
    candidate_label: string;
    status?: ExperimentRunStatus;
    verdict?: ExperimentVerdict | null;
    task_id?: string;
    run_id?: string;
    artifact_ids?: string[];
    observed_metric?: number;
    observed_metrics?: Record<string, unknown>;
    delta?: number | null;
    summary?: string;
    log_excerpt?: string;
    error_text?: string;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; experiment_run: ExperimentRunRecord } {
    const now = new Date().toISOString();
    const experimentRunId = params.experiment_run_id?.trim() || crypto.randomUUID();
    const existing = this.getExperimentRunById(experimentRunId);
    if (existing) {
      return {
        created: false,
        experiment_run: existing,
      };
    }
    const experimentId = params.experiment_id.trim();
    if (!experimentId) {
      throw new Error("experiment_id is required");
    }
    const candidateLabel = params.candidate_label.trim();
    if (!candidateLabel) {
      throw new Error("candidate_label is required");
    }
    if (!this.getExperimentById(experimentId)) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    this.db
      .prepare(
        `INSERT INTO experiment_runs (
           experiment_run_id, experiment_id, created_at, updated_at, candidate_label, status, verdict, task_id, run_id,
           artifact_ids_json, observed_metric, observed_metrics_json, delta, summary, log_excerpt, error_text, metadata_json,
           source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        experimentRunId,
        experimentId,
        now,
        now,
        candidateLabel,
        normalizeExperimentRunStatus(params.status),
        normalizeOptionalExperimentVerdict(params.verdict),
        params.task_id?.trim() || null,
        params.run_id?.trim() || null,
        stableStringify(dedupeNonEmpty(params.artifact_ids ?? [])),
        params.observed_metric === undefined ? null : Number(params.observed_metric),
        stableStringify(parseLooseObject(params.observed_metrics ?? {})),
        params.delta === undefined ? null : params.delta,
        params.summary?.trim() || null,
        params.log_excerpt ?? null,
        params.error_text ?? null,
        stableStringify(parseLooseObject(params.metadata ?? {})),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const experimentRun = this.getExperimentRunById(experimentRunId);
    if (!experimentRun) {
      throw new Error(`Failed to read experiment run after create: ${experimentRunId}`);
    }
    return {
      created: true,
      experiment_run: experimentRun,
    };
  }

  getExperimentRunById(experimentRunId: string): ExperimentRunRecord | null {
    const normalized = experimentRunId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT experiment_run_id, experiment_id, created_at, updated_at, candidate_label, status, verdict, task_id, run_id,
                artifact_ids_json, observed_metric, observed_metrics_json, delta, summary, log_excerpt, error_text, metadata_json,
                source_client, source_model, source_agent
         FROM experiment_runs
         WHERE experiment_run_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapExperimentRunRow(row);
  }

  listExperimentRuns(params: {
    experiment_id: string;
    status?: ExperimentRunStatus;
    limit: number;
  }): ExperimentRunRecord[] {
    const experimentId = params.experiment_id.trim();
    if (!experimentId) {
      throw new Error("experiment_id is required");
    }
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses = ["experiment_id = ?"];
    const values: unknown[] = [experimentId];
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeExperimentRunStatus(params.status));
    }
    const rows = this.db
      .prepare(
        `SELECT experiment_run_id, experiment_id, created_at, updated_at, candidate_label, status, verdict, task_id, run_id,
                artifact_ids_json, observed_metric, observed_metrics_json, delta, summary, log_excerpt, error_text, metadata_json,
                source_client, source_model, source_agent
         FROM experiment_runs
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapExperimentRunRow(row));
  }

  updateExperimentRun(params: {
    experiment_run_id: string;
    status?: ExperimentRunStatus;
    verdict?: ExperimentVerdict | null;
    task_id?: string | null;
    run_id?: string | null;
    artifact_ids?: string[];
    observed_metric?: number | null;
    observed_metrics?: Record<string, unknown>;
    delta?: number | null;
    summary?: string | null;
    log_excerpt?: string | null;
    error_text?: string | null;
    metadata?: Record<string, unknown>;
  }): { experiment_run: ExperimentRunRecord } {
    const experimentRunId = params.experiment_run_id.trim();
    if (!experimentRunId) {
      throw new Error("experiment_run_id is required");
    }
    const existing = this.getExperimentRunById(experimentRunId);
    if (!existing) {
      throw new Error(`Experiment run not found: ${experimentRunId}`);
    }
    const now = new Date().toISOString();
    const status = params.status ? normalizeExperimentRunStatus(params.status) : existing.status;
    const verdict =
      params.verdict === undefined ? existing.verdict : normalizeOptionalExperimentVerdict(params.verdict);
    const taskId = params.task_id === undefined ? existing.task_id : params.task_id?.trim() || null;
    const runId = params.run_id === undefined ? existing.run_id : params.run_id?.trim() || null;
    const artifactIds = params.artifact_ids === undefined ? existing.artifact_ids : dedupeNonEmpty(params.artifact_ids);
    const observedMetric = params.observed_metric === undefined ? existing.observed_metric : params.observed_metric;
    const observedMetrics =
      params.observed_metrics === undefined
        ? existing.observed_metrics
        : {
            ...existing.observed_metrics,
            ...parseLooseObject(params.observed_metrics),
          };
    const delta = params.delta === undefined ? existing.delta : params.delta;
    const summary = params.summary === undefined ? existing.summary : params.summary;
    const logExcerpt = params.log_excerpt === undefined ? existing.log_excerpt : params.log_excerpt;
    const errorText = params.error_text === undefined ? existing.error_text : params.error_text;
    const metadata =
      params.metadata === undefined
        ? existing.metadata
        : {
            ...existing.metadata,
            ...parseLooseObject(params.metadata),
          };

    this.db
      .prepare(
        `UPDATE experiment_runs
         SET updated_at = ?, status = ?, verdict = ?, task_id = ?, run_id = ?, artifact_ids_json = ?, observed_metric = ?,
             observed_metrics_json = ?, delta = ?, summary = ?, log_excerpt = ?, error_text = ?, metadata_json = ?
         WHERE experiment_run_id = ?`
      )
      .run(
        now,
        status,
        verdict,
        taskId,
        runId,
        stableStringify(artifactIds),
        observedMetric,
        stableStringify(observedMetrics),
        delta,
        summary,
        logExcerpt,
        errorText,
        stableStringify(metadata),
        experimentRunId
      );

    const experimentRun = this.getExperimentRunById(experimentRunId);
    if (!experimentRun) {
      throw new Error(`Failed to read experiment run after update: ${experimentRunId}`);
    }
    return {
      experiment_run: experimentRun,
    };
  }

  createPackHookRun(params: {
    hook_run_id?: string;
    pack_id: string;
    hook_kind: PackHookKind;
    hook_name: string;
    target_type: string;
    target_id: string;
    goal_id?: string;
    plan_id?: string;
    step_id?: string;
    status?: PackHookRunStatus;
    summary?: string;
    score?: number | null;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    error_text?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; hook_run: PackHookRunRecord } {
    const now = new Date().toISOString();
    const hookRunId = params.hook_run_id?.trim() || crypto.randomUUID();
    const existing = this.getPackHookRunById(hookRunId);
    if (existing) {
      return {
        created: false,
        hook_run: existing,
      };
    }

    const packId = params.pack_id.trim();
    const hookName = params.hook_name.trim();
    const targetType = params.target_type.trim();
    const targetId = params.target_id.trim();
    if (!packId || !hookName || !targetType || !targetId) {
      throw new Error("pack_id, hook_name, target_type, and target_id are required");
    }

    this.db
      .prepare(
        `INSERT INTO pack_hook_runs (
           hook_run_id, created_at, updated_at, pack_id, hook_kind, hook_name, target_type, target_id,
           goal_id, plan_id, step_id, status, summary, score, input_json, output_json, error_text,
           source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        hookRunId,
        now,
        now,
        packId,
        normalizePackHookKind(params.hook_kind),
        hookName,
        targetType,
        targetId,
        params.goal_id?.trim() || null,
        params.plan_id?.trim() || null,
        params.step_id?.trim() || null,
        normalizePackHookRunStatus(params.status),
        params.summary?.trim() || null,
        params.score === undefined ? null : params.score,
        stableStringify(parseLooseObject(params.input ?? {})),
        params.output === undefined ? null : stableStringify(parseLooseObject(params.output)),
        params.error_text?.trim() || null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const hookRun = this.getPackHookRunById(hookRunId);
    if (!hookRun) {
      throw new Error(`Failed to read pack hook run after create: ${hookRunId}`);
    }

    this.appendRuntimeEvent({
      event_type: "pack.hook_started",
      entity_type: "pack_hook_run",
      entity_id: hookRun.hook_run_id,
      status: hookRun.status,
      summary: hookRun.summary ?? `Pack ${hookRun.hook_kind} hook ${hookRun.pack_id}.${hookRun.hook_name} started.`,
      details: {
        pack_id: hookRun.pack_id,
        hook_kind: hookRun.hook_kind,
        hook_name: hookRun.hook_name,
        target_type: hookRun.target_type,
        target_id: hookRun.target_id,
        goal_id: hookRun.goal_id,
        plan_id: hookRun.plan_id,
        step_id: hookRun.step_id,
      },
      source_client: hookRun.source_client ?? undefined,
      source_model: hookRun.source_model ?? undefined,
      source_agent: hookRun.source_agent ?? undefined,
      created_at: hookRun.created_at,
    });

    return {
      created: true,
      hook_run: hookRun,
    };
  }

  getPackHookRunById(hookRunId: string): PackHookRunRecord | null {
    const normalized = hookRunId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT hook_run_id, created_at, updated_at, pack_id, hook_kind, hook_name, target_type, target_id,
                goal_id, plan_id, step_id, status, summary, score, input_json, output_json, error_text,
                source_client, source_model, source_agent
         FROM pack_hook_runs
         WHERE hook_run_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapPackHookRunRow(row);
  }

  listPackHookRuns(params: {
    pack_id?: string;
    hook_kind?: PackHookKind;
    target_type?: string;
    target_id?: string;
    status?: PackHookRunStatus;
    limit: number;
  }): PackHookRunRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    const packId = params.pack_id?.trim();
    const targetType = params.target_type?.trim();
    const targetId = params.target_id?.trim();
    if (packId) {
      whereClauses.push("pack_id = ?");
      values.push(packId);
    }
    if (params.hook_kind) {
      whereClauses.push("hook_kind = ?");
      values.push(normalizePackHookKind(params.hook_kind));
    }
    if (targetType) {
      whereClauses.push("target_type = ?");
      values.push(targetType);
    }
    if (targetId) {
      whereClauses.push("target_id = ?");
      values.push(targetId);
    }
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizePackHookRunStatus(params.status));
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT hook_run_id, created_at, updated_at, pack_id, hook_kind, hook_name, target_type, target_id,
                goal_id, plan_id, step_id, status, summary, score, input_json, output_json, error_text,
                source_client, source_model, source_agent
         FROM pack_hook_runs
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapPackHookRunRow(row));
  }

  updatePackHookRun(params: {
    hook_run_id: string;
    status?: PackHookRunStatus;
    summary?: string | null;
    score?: number | null;
    output?: Record<string, unknown> | null;
    error_text?: string | null;
  }): { hook_run: PackHookRunRecord } {
    const hookRunId = params.hook_run_id.trim();
    if (!hookRunId) {
      throw new Error("hook_run_id is required");
    }
    const existing = this.getPackHookRunById(hookRunId);
    if (!existing) {
      throw new Error(`Pack hook run not found: ${hookRunId}`);
    }

    const now = new Date().toISOString();
    const status = params.status ? normalizePackHookRunStatus(params.status) : existing.status;
    const summary = params.summary === undefined ? existing.summary : params.summary?.trim() || null;
    const score = params.score === undefined ? existing.score : params.score;
    const output = params.output === undefined ? existing.output : params.output;
    const errorText = params.error_text === undefined ? existing.error_text : params.error_text?.trim() || null;

    this.db
      .prepare(
        `UPDATE pack_hook_runs
         SET updated_at = ?, status = ?, summary = ?, score = ?, output_json = ?, error_text = ?
         WHERE hook_run_id = ?`
      )
      .run(
        now,
        status,
        summary,
        score,
        output === null ? null : stableStringify(parseLooseObject(output ?? {})),
        errorText,
        hookRunId
      );

    const hookRun = this.getPackHookRunById(hookRunId);
    if (!hookRun) {
      throw new Error(`Failed to read pack hook run after update: ${hookRunId}`);
    }

    this.appendRuntimeEvent({
      event_type:
        hookRun.status === "failed"
          ? "pack.hook_failed"
          : hookRun.status === "completed"
            ? "pack.hook_completed"
            : "pack.hook_updated",
      entity_type: "pack_hook_run",
      entity_id: hookRun.hook_run_id,
      status: hookRun.status,
      summary:
        hookRun.summary ??
        `Pack ${hookRun.hook_kind} hook ${hookRun.pack_id}.${hookRun.hook_name} ${hookRun.status}.`,
      details: {
        pack_id: hookRun.pack_id,
        hook_kind: hookRun.hook_kind,
        hook_name: hookRun.hook_name,
        target_type: hookRun.target_type,
        target_id: hookRun.target_id,
        goal_id: hookRun.goal_id,
        plan_id: hookRun.plan_id,
        step_id: hookRun.step_id,
        score: hookRun.score,
        error_text: hookRun.error_text,
      },
      source_client: hookRun.source_client ?? undefined,
      source_model: hookRun.source_model ?? undefined,
      source_agent: hookRun.source_agent ?? undefined,
      created_at: hookRun.updated_at,
    });

    return {
      hook_run: hookRun,
    };
  }

  createTask(params: {
    task_id?: string;
    objective: string;
    project_dir: string;
    payload?: Record<string, unknown>;
    priority?: number;
    max_attempts?: number;
    available_at?: string;
    source?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): { created: boolean; task: TaskRecord } {
    const now = new Date().toISOString();
    const taskId = params.task_id?.trim() || crypto.randomUUID();
    const existing = this.getTaskById(taskId);
    if (existing) {
      return {
        created: false,
        task: existing,
      };
    }

    const objective = params.objective.trim();
    if (!objective) {
      throw new Error("task objective is required");
    }
    const projectDir = params.project_dir.trim();
    if (!projectDir) {
      throw new Error("task project_dir is required");
    }

    const priority = parseBoundedInt(params.priority, 0, 0, 100);
    const maxAttempts = parseBoundedInt(params.max_attempts, 3, 1, 20);
    const availableAt = normalizeIsoTimestamp(params.available_at, now);
    const tags = dedupeNonEmpty(params.tags ?? []);
    const payload = params.payload ?? {};
    const metadata = params.metadata ?? {};

    const create = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO tasks (
             task_id, created_at, updated_at, status, priority, objective, project_dir,
             payload_json, source, source_client, source_model, source_agent,
             tags_json, metadata_json, max_attempts, attempt_count, available_at,
             started_at, finished_at, last_worker_id, last_error, result_json
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL)
           ON CONFLICT(task_id) DO NOTHING`
        )
        .run(
          taskId,
          now,
          now,
          priority,
          objective,
          projectDir,
          stableStringify(payload),
          params.source ?? null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null,
          stableStringify(tags),
          stableStringify(metadata),
          maxAttempts,
          availableAt
        );
      const insertedCount = Number(inserted.changes ?? 0);
      if (insertedCount > 0) {
        this.appendTaskEvent({
          task_id: taskId,
          event_type: "created",
          to_status: "pending",
          summary: "Task created.",
          details: {
            priority,
            max_attempts: maxAttempts,
          },
        });
      }
      return insertedCount > 0;
    });
    const created = create();

    const task = this.getTaskById(taskId);
    if (!task) {
      throw new Error(`Failed to read task after create: ${taskId}`);
    }
    return {
      created,
      task,
    };
  }

  listTasks(params: {
    status?: TaskStatus;
    limit: number;
  }): TaskRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const rows = params.status
      ? (this.db
          .prepare(
            `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                    t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                    t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                    t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                    l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                    l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             WHERE t.status = ?
             ORDER BY t.priority DESC, t.created_at ASC
             LIMIT ?`
          )
          .all(params.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                    t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                    t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                    t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                    l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                    l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             ORDER BY
               CASE t.status
                 WHEN 'running' THEN 0
                 WHEN 'pending' THEN 1
                 WHEN 'failed' THEN 2
                 WHEN 'completed' THEN 3
                 ELSE 4
               END,
               t.priority DESC,
               t.updated_at DESC
             LIMIT ?`
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map((row) => mapTaskRow(row));
  }

  getTaskById(taskId: string): TaskRecord | null {
    const normalized = taskId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
         FROM tasks t
         LEFT JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.task_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTaskRow(row);
  }

  getRunningTaskByWorkerId(workerId: string): TaskRecord | null {
    const normalized = workerId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
         FROM tasks t
         INNER JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.status = 'running'
           AND l.owner_id = ?
         ORDER BY t.updated_at DESC
         LIMIT 1`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTaskRow(row);
  }

  findPlanStepByTaskId(taskId: string): { plan: PlanRecord; step: PlanStepRecord } | null {
    const normalized = taskId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT step_id, plan_id
         FROM plan_steps
         WHERE task_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    const planId = String(row.plan_id ?? "");
    const stepId = String(row.step_id ?? "");
    const plan = this.getPlanById(planId);
    const step = this.listPlanSteps(planId).find((candidate) => candidate.step_id === stepId) ?? null;
    if (!plan || !step) {
      return null;
    }
    return {
      plan,
      step,
    };
  }

  findExperimentRunByTaskId(taskId: string): ExperimentRunRecord | null {
    const normalized = taskId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT experiment_run_id, experiment_id, created_at, updated_at, candidate_label, status, verdict, task_id, run_id,
                artifact_ids_json, observed_metric, observed_metrics_json, delta, summary, log_excerpt, error_text, metadata_json,
                source_client, source_model, source_agent
         FROM experiment_runs
         WHERE task_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapExperimentRunRow(row);
  }

  claimTask(params: {
    worker_id: string;
    lease_seconds: number;
    task_id?: string;
  }): { claimed: boolean; reason: string; task?: TaskRecord; lease_expires_at?: string } {
    const workerId = params.worker_id.trim();
    if (!workerId) {
      throw new Error("worker_id is required");
    }
    const leaseSeconds = parseBoundedInt(params.lease_seconds, 300, 15, 86400);
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const claim = this.db.transaction(() => {
      let candidateId: string | null = null;
      if (params.task_id && params.task_id.trim()) {
        const specific = this.db
          .prepare(
            `SELECT t.task_id, t.status, t.available_at, l.owner_id AS lease_owner_id, l.lease_expires_at
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             WHERE t.task_id = ?`
          )
          .get(params.task_id.trim()) as Record<string, unknown> | undefined;
        if (!specific) {
          return {
            claimed: false,
            reason: "not-found",
          };
        }
        const status = normalizeTaskStatus(specific.status);
        const availableAt = String(specific.available_at ?? "");
        const leaseOwner = asNullableString(specific.lease_owner_id);
        const leaseExpiry = asNullableString(specific.lease_expires_at);
        if (status !== "pending") {
          return {
            claimed: false,
            reason: `not-pending:${status}`,
          };
        }
        if (availableAt > now) {
          return {
            claimed: false,
            reason: "not-ready",
          };
        }
        if (leaseOwner && leaseExpiry && leaseExpiry > now) {
          return {
            claimed: false,
            reason: "leased",
          };
        }
        candidateId = String(specific.task_id ?? "");
      } else {
        const candidate = this.db
          .prepare(
            `SELECT t.task_id
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             WHERE t.status = 'pending'
               AND t.available_at <= ?
               AND (l.task_id IS NULL OR l.lease_expires_at <= ?)
             ORDER BY t.priority DESC, t.created_at ASC
             LIMIT 1`
          )
          .get(now, now) as Record<string, unknown> | undefined;
        if (!candidate) {
          return {
            claimed: false,
            reason: "none-available",
          };
        }
        candidateId = String(candidate.task_id ?? "");
      }

      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'running',
               updated_at = ?,
               attempt_count = attempt_count + 1,
               started_at = ?,
               finished_at = NULL,
               last_worker_id = ?
           WHERE task_id = ?
             AND status = 'pending'
             AND available_at <= ?`
        )
        .run(now, now, workerId, candidateId, now);
      if (Number(updated.changes ?? 0) <= 0) {
        return {
          claimed: false,
          reason: "race-lost",
        };
      }

      this.db
        .prepare(
          `INSERT INTO task_leases (task_id, owner_id, lease_expires_at, heartbeat_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             lease_expires_at = excluded.lease_expires_at,
             heartbeat_at = excluded.heartbeat_at,
             updated_at = excluded.updated_at`
        )
        .run(candidateId, workerId, leaseExpiresAt, now, now, now);

      this.appendTaskEvent({
        task_id: candidateId,
        event_type: "claimed",
        from_status: "pending",
        to_status: "running",
        worker_id: workerId,
        summary: "Task claimed for execution.",
        details: {
          lease_seconds: leaseSeconds,
          lease_expires_at: leaseExpiresAt,
        },
      });

      const task = this.getTaskById(candidateId);
      if (!task) {
        throw new Error(`Claimed task vanished: ${candidateId}`);
      }
      return {
        claimed: true,
        reason: "claimed",
        task,
        lease_expires_at: leaseExpiresAt,
      };
    });

    return claim();
  }

  heartbeatTaskLease(params: {
    task_id: string;
    worker_id: string;
    lease_seconds: number;
  }): {
    ok: boolean;
    reason: string;
    task_id: string;
    owner_id?: string;
    lease_expires_at?: string;
    heartbeat_at?: string;
  } {
    const taskId = params.task_id.trim();
    const workerId = params.worker_id.trim();
    if (!taskId || !workerId) {
      throw new Error("task_id and worker_id are required");
    }
    const leaseSeconds = parseBoundedInt(params.lease_seconds, 300, 15, 86400);
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const lease = this.db
      .prepare(
        `SELECT owner_id, lease_expires_at
         FROM task_leases
         WHERE task_id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!lease) {
      return {
        ok: false,
        reason: "lease-not-found",
        task_id: taskId,
      };
    }
    const ownerId = String(lease.owner_id ?? "");
    if (ownerId !== workerId) {
      return {
        ok: false,
        reason: "owner-mismatch",
        task_id: taskId,
        owner_id: ownerId,
        lease_expires_at: String(lease.lease_expires_at ?? ""),
      };
    }

    const heartbeat = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE task_leases
           SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE task_id = ?`
        )
        .run(leaseExpiresAt, now, now, taskId);
      this.db
        .prepare(`UPDATE tasks SET updated_at = ? WHERE task_id = ?`)
        .run(now, taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "heartbeat",
        from_status: "running",
        to_status: "running",
        worker_id: workerId,
        summary: "Task lease heartbeat.",
        details: {
          lease_seconds: leaseSeconds,
          lease_expires_at: leaseExpiresAt,
        },
      });
    });
    heartbeat();

    return {
      ok: true,
      reason: "heartbeat-recorded",
      task_id: taskId,
      owner_id: workerId,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
    };
  }

  completeTask(params: {
    task_id: string;
    worker_id: string;
    result?: Record<string, unknown>;
    summary?: string;
  }): { completed: boolean; reason: string; task?: TaskRecord } {
    const taskId = params.task_id.trim();
    const workerId = params.worker_id.trim();
    if (!taskId || !workerId) {
      throw new Error("task_id and worker_id are required");
    }
    const now = new Date().toISOString();

    const complete = this.db.transaction(() => {
      const lease = this.db
        .prepare(`SELECT owner_id FROM task_leases WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown> | undefined;
      if (!lease) {
        return {
          completed: false,
          reason: "lease-not-found",
        };
      }
      const ownerId = String(lease.owner_id ?? "");
      if (ownerId !== workerId) {
        return {
          completed: false,
          reason: "owner-mismatch",
        };
      }
      const existingTask = this.getTaskById(taskId);
      const result = withTaskCompletionReasoningAudit(existingTask, params.result ?? {});
      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'completed',
               updated_at = ?,
               finished_at = ?,
               last_worker_id = ?,
               last_error = NULL,
               result_json = ?
           WHERE task_id = ?
             AND status = 'running'`
        )
        .run(now, now, workerId, stableStringify(result), taskId);
      if (Number(updated.changes ?? 0) <= 0) {
        return {
          completed: false,
          reason: "not-running",
        };
      }
      this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "completed",
        from_status: "running",
        to_status: "completed",
        worker_id: workerId,
        summary: params.summary?.trim() || "Task completed successfully.",
        details: {
          result_keys: Object.keys(result),
          reasoning_policy_audit: result.reasoning_policy_audit ?? null,
        },
      });
      const reasoningAudit = readPlainObject(result.reasoning_policy_audit);
      if (reasoningAudit?.status === "needs_review") {
        const missingFields = Array.isArray(reasoningAudit.missing_fields)
          ? reasoningAudit.missing_fields.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          : [];
        this.appendTaskEvent({
          task_id: taskId,
          event_type: "reasoning_review_needed",
          from_status: "completed",
          to_status: "completed",
          worker_id: workerId,
          summary:
            missingFields.length > 0
              ? `Task completed but reasoning-policy evidence needs review: missing ${missingFields.join(", ")}.`
              : "Task completed but reasoning-policy evidence needs review.",
          details: {
            audit_status: reasoningAudit.status,
            missing_fields: missingFields,
            required_fields: Array.isArray(reasoningAudit.required_fields) ? reasoningAudit.required_fields : [],
            satisfied_fields: Array.isArray(reasoningAudit.satisfied_fields) ? reasoningAudit.satisfied_fields : [],
            required_candidate_count: reasoningAudit.required_candidate_count ?? null,
            observed_candidate_count: reasoningAudit.observed_candidate_count ?? null,
            selection: readPlainObject(reasoningAudit.selection) ?? null,
            warnings: Array.isArray(reasoningAudit.warnings) ? reasoningAudit.warnings : [],
          },
        });
      }
      const task = this.getTaskById(taskId);
      return {
        completed: true,
        reason: "completed",
        task: task ?? undefined,
      };
    });
    return complete();
  }

  failTask(params: {
    task_id: string;
    worker_id: string;
    error: string;
    result?: Record<string, unknown>;
    summary?: string;
  }): { failed: boolean; reason: string; task?: TaskRecord; auto_reflection?: TaskFailureReflectionCapture | null } {
    const taskId = params.task_id.trim();
    const workerId = params.worker_id.trim();
    const errorText = params.error.trim();
    if (!taskId || !workerId || !errorText) {
      throw new Error("task_id, worker_id, and error are required");
    }
    const now = new Date().toISOString();

    const fail = this.db.transaction(() => {
      const lease = this.db
        .prepare(`SELECT owner_id FROM task_leases WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown> | undefined;
      if (!lease) {
        return {
          failed: false,
          reason: "lease-not-found",
        };
      }
      const ownerId = String(lease.owner_id ?? "");
      if (ownerId !== workerId) {
        return {
          failed: false,
          reason: "owner-mismatch",
        };
      }
      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'failed',
               updated_at = ?,
               finished_at = ?,
               last_worker_id = ?,
               last_error = ?,
               result_json = ?
           WHERE task_id = ?
             AND status = 'running'`
        )
        .run(now, now, workerId, errorText, stableStringify(params.result ?? {}), taskId);
      if (Number(updated.changes ?? 0) <= 0) {
        return {
          failed: false,
          reason: "not-running",
        };
      }
      this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "failed",
        from_status: "running",
        to_status: "failed",
        worker_id: workerId,
        summary: params.summary?.trim() || "Task failed during execution.",
        details: {
          error: errorText,
          result_keys: Object.keys(params.result ?? {}),
        },
      });
      const task = this.getTaskById(taskId);
      const autoReflection = task
        ? captureTaskFailureReflection(this, task, {
            worker_id: workerId,
            error: errorText,
            summary: params.summary,
            result: params.result,
          })
        : null;
      return {
        failed: true,
        reason: "failed",
        task: task ?? undefined,
        auto_reflection: autoReflection,
      };
    });
    return fail();
  }

  retryTask(params: {
    task_id: string;
    delay_seconds: number;
    reason?: string;
    force?: boolean;
  }): { retried: boolean; reason: string; task?: TaskRecord; available_at?: string } {
    const taskId = params.task_id.trim();
    if (!taskId) {
      throw new Error("task_id is required");
    }
    const delaySeconds = parseBoundedInt(params.delay_seconds, 0, 0, 86400);
    const now = new Date().toISOString();
    const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const existingTaskForRetry = this.getTaskById(taskId);
    const retryMemoryPreflight = existingTaskForRetry
      ? buildTaskRetryReflectionPreflight(this, existingTaskForRetry, now)
      : null;
    const retryMetadata =
      existingTaskForRetry && retryMemoryPreflight
        ? mergeTaskRetryReflectionPreflight(existingTaskForRetry.metadata, retryMemoryPreflight, now)
        : existingTaskForRetry?.metadata ?? {};

    const retry = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT status, attempt_count, max_attempts FROM tasks WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown> | undefined;
      if (!existing) {
        return {
          retried: false,
          reason: "not-found",
        };
      }
      const status = normalizeTaskStatus(existing.status);
      const attemptCount = Number(existing.attempt_count ?? 0);
      const maxAttempts = Number(existing.max_attempts ?? 3);
      if (status !== "failed" && status !== "cancelled") {
        return {
          retried: false,
          reason: `not-retryable:${status}`,
        };
      }
      if (!params.force && attemptCount >= maxAttempts) {
        return {
          retried: false,
          reason: "max-attempts-exceeded",
        };
      }

      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'pending',
               updated_at = ?,
               available_at = ?,
               started_at = NULL,
               finished_at = NULL,
               last_error = NULL,
               result_json = NULL,
               metadata_json = ?
           WHERE task_id = ?`
        )
        .run(now, availableAt, stableStringify(retryMetadata), taskId);
      this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "retried",
        from_status: status,
        to_status: "pending",
        summary: params.reason?.trim() || "Task scheduled for retry.",
        details: {
          delay_seconds: delaySeconds,
          available_at: availableAt,
          force: Boolean(params.force),
          retry_reflection_memory_ids: retryMemoryPreflight
            ? asStringArrayForStorage(retryMemoryPreflight.retry_reflection_memory_ids)
            : [],
          retry_reflection_match_count: retryMemoryPreflight
            ? asFiniteNumberForStorage(retryMemoryPreflight.reflection_match_count)
            : 0,
        },
      });
      const task = this.getTaskById(taskId);
      return {
        retried: true,
        reason: "retried",
        task: task ?? undefined,
        available_at: availableAt,
      };
    });
    return retry();
  }

  recoverExpiredRunningTasks(params?: {
    limit?: number;
  }): {
    scanned_count: number;
    recovered_count: number;
    failed_count: number;
    results: Array<{
      task_id: string;
      previous_owner_id: string | null;
      lease_expires_at: string | null;
      action: "requeued" | "failed";
      available_at: string | null;
      reason: string;
    }>;
  } {
    const boundedLimit = Math.max(1, Math.min(500, params?.limit ?? 25));
    const now = new Date().toISOString();

    const recover = this.db.transaction(() => {
      const expiredRows = this.db
        .prepare(
          `SELECT t.task_id, t.attempt_count, t.max_attempts, t.available_at, l.owner_id, l.lease_expires_at
           FROM tasks t
           INNER JOIN task_leases l ON l.task_id = t.task_id
           WHERE t.status = 'running'
             AND l.lease_expires_at IS NOT NULL
             AND l.lease_expires_at <= ?
           ORDER BY l.lease_expires_at ASC, t.updated_at ASC
           LIMIT ?`
        )
        .all(now, boundedLimit) as Array<Record<string, unknown>>;

      const results: Array<{
        task_id: string;
        previous_owner_id: string | null;
        lease_expires_at: string | null;
        action: "requeued" | "failed";
        available_at: string | null;
        reason: string;
      }> = [];
      let recoveredCount = 0;
      let failedCount = 0;

      for (const row of expiredRows) {
        const taskId = String(row.task_id ?? "");
        const previousOwnerId = asNullableString(row.owner_id);
        const leaseExpiresAt = asNullableString(row.lease_expires_at);
        const currentAvailableAt = asNullableString(row.available_at);
        const attemptCount = Number(row.attempt_count ?? 0);
        const maxAttempts = Number(row.max_attempts ?? 3);
        const exhaustAttempts = attemptCount >= maxAttempts;
        const nextStatus: TaskStatus = exhaustAttempts ? "failed" : "pending";
        const availableAt = exhaustAttempts ? currentAvailableAt ?? now : now;
        const reason = exhaustAttempts ? "lease_expired_max_attempts_exceeded" : "lease_expired_requeued";

        this.db
          .prepare(
            `UPDATE tasks
             SET status = ?,
                 updated_at = ?,
                 available_at = ?,
                 started_at = NULL,
                 finished_at = ?,
                 last_error = ?,
                 result_json = NULL
             WHERE task_id = ?
               AND status = 'running'`
          )
          .run(
            nextStatus,
            now,
            availableAt,
            exhaustAttempts ? now : null,
            exhaustAttempts ? "Task lease expired while the worker stopped heartbeating." : null,
            taskId
          );

        this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
        this.appendTaskEvent({
          task_id: taskId,
          event_type: exhaustAttempts ? "lease_expired_failed" : "lease_expired_requeued",
          from_status: "running",
          to_status: nextStatus,
          worker_id: previousOwnerId ?? undefined,
          summary: exhaustAttempts
            ? "Expired running task failed after exhausting retry budget."
            : "Expired running task was requeued for recovery.",
          details: {
            previous_owner_id: previousOwnerId,
            lease_expires_at: leaseExpiresAt,
            attempt_count: attemptCount,
            max_attempts: maxAttempts,
            available_at: availableAt,
          },
        });

        if (exhaustAttempts) {
          failedCount += 1;
        } else {
          recoveredCount += 1;
        }
        results.push({
          task_id: taskId,
          previous_owner_id: previousOwnerId,
          lease_expires_at: leaseExpiresAt,
          action: exhaustAttempts ? "failed" : "requeued",
          available_at: availableAt,
          reason,
        });
      }

      return {
        scanned_count: expiredRows.length,
        recovered_count: recoveredCount,
        failed_count: failedCount,
        results,
      };
    });

    return recover();
  }

  listFailedTasksForAutoRetry(limit: number): Array<{
    task_id: string;
    attempt_count: number;
    max_attempts: number;
    finished_at: string | null;
    last_error: string | null;
  }> {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT t.task_id, t.attempt_count, t.max_attempts, t.finished_at, t.last_error
         FROM tasks t
         LEFT JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.status = 'failed'
           AND t.attempt_count < t.max_attempts
           AND (l.task_id IS NULL OR l.lease_expires_at <= ?)
         ORDER BY
           COALESCE(t.finished_at, t.updated_at) ASC,
           t.updated_at ASC,
           t.task_id ASC
         LIMIT ?`
      )
      .all(new Date().toISOString(), boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      task_id: String(row.task_id ?? ""),
      attempt_count: Number(row.attempt_count ?? 0),
      max_attempts: Number(row.max_attempts ?? 0),
      finished_at: asNullableString(row.finished_at),
      last_error: asNullableString(row.last_error),
    }));
  }

  getTaskTimeline(taskId: string, limit: number): TaskEventRecord[] {
    const normalized = taskId.trim();
    if (!normalized) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT id, task_id, created_at, event_type, from_status, to_status, worker_id, summary, details_json
         FROM task_events
         WHERE task_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(normalized, boundedLimit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTaskEventRow(row));
  }

  listTaskEvents(params?: {
    since?: string;
    limit?: number;
  }): TaskEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }
    const boundedLimit = Math.max(1, Math.min(5000, parseBoundedInt(params?.limit, 250, 1, 5000)));
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, task_id, created_at, event_type, from_status, to_status, worker_id, summary, details_json
         FROM task_events
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...values, boundedLimit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTaskEventRow(row));
  }

  getTaskSummary(params?: {
    running_limit?: number;
  }): TaskSummaryRecord {
    const runningLimit = parseBoundedInt(params?.running_limit, 10, 1, 200);
    const now = new Date().toISOString();
    const countRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM tasks
         GROUP BY status`
      )
      .all() as Array<Record<string, unknown>>;

    const counts: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      failed: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const row of countRows) {
      const status = normalizeTaskStatus(row.status);
      counts[status] = Number(row.count ?? 0);
    }

    const runningRows = this.db
      .prepare(
        `SELECT t.task_id, t.objective, t.updated_at, t.attempt_count, t.max_attempts,
                l.owner_id, l.lease_expires_at
         FROM tasks t
         LEFT JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.status = 'running'
         ORDER BY t.priority DESC, t.updated_at DESC
         LIMIT ?`
      )
      .all(runningLimit) as Array<Record<string, unknown>>;

    const failedRow = this.db
      .prepare(
        `SELECT task_id, last_error, attempt_count, max_attempts, updated_at
         FROM tasks
         WHERE status = 'failed'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    const completedRow = this.db
      .prepare(
        `SELECT task_id, updated_at
         FROM tasks
         WHERE status = 'completed'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    const reasoningRows = this.db
      .prepare(
        `SELECT task_id, status, metadata_json
         FROM tasks
         WHERE status IN ('pending', 'running')
         ORDER BY priority DESC, updated_at DESC
         LIMIT 500`
      )
      .all() as Array<Record<string, unknown>>;
    const completionReasoningRows = this.db
      .prepare(
        `SELECT task_id, updated_at, result_json
         FROM tasks
         WHERE status = 'completed'
         ORDER BY updated_at DESC
         LIMIT 500`
      )
      .all() as Array<Record<string, unknown>>;
    const reasoningPolicy = summarizeTaskReasoningPolicy(
      reasoningRows,
      summarizeTaskCompletionReasoningReview(completionReasoningRows)
    );

    return {
      counts,
      expired_running_count: runningRows.filter((row) => {
        const leaseExpiresAt = asNullableString(row.lease_expires_at);
        return leaseExpiresAt !== null && leaseExpiresAt <= now;
      }).length,
      reasoning_policy: reasoningPolicy,
      running: runningRows.map((row) => ({
        task_id: String(row.task_id ?? ""),
        objective: String(row.objective ?? ""),
        owner_id: asNullableString(row.owner_id),
        lease_expires_at: asNullableString(row.lease_expires_at),
        updated_at: String(row.updated_at ?? ""),
        attempt_count: Number(row.attempt_count ?? 0),
        max_attempts: Number(row.max_attempts ?? 0),
      })),
      last_failed: failedRow
        ? {
            task_id: String(failedRow.task_id ?? ""),
            last_error: asNullableString(failedRow.last_error),
            attempt_count: Number(failedRow.attempt_count ?? 0),
            max_attempts: Number(failedRow.max_attempts ?? 0),
            updated_at: String(failedRow.updated_at ?? ""),
          }
        : null,
      last_completed: completedRow
        ? {
            task_id: String(completedRow.task_id ?? ""),
            updated_at: String(completedRow.updated_at ?? ""),
          }
        : null,
    };
  }

  getTriChatSummary(params?: {
    busiest_limit?: number;
  }): TriChatSummaryRecord {
    const busiestLimit = parseBoundedInt(params?.busiest_limit, 10, 1, 200);

    const threadCountRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM trichat_threads
         GROUP BY status`
      )
      .all() as Array<Record<string, unknown>>;

    const threadCounts = {
      active: 0,
      archived: 0,
      total: 0,
    };
    for (const row of threadCountRows) {
      const status = normalizeTriChatThreadStatus(row.status);
      const count = Number(row.count ?? 0);
      if (status === "archived") {
        threadCounts.archived = count;
      } else {
        threadCounts.active = count;
      }
    }
    threadCounts.total = threadCounts.active + threadCounts.archived;

    const messageAgg = this.db
      .prepare(
        `SELECT COUNT(*) AS message_count,
                MIN(created_at) AS oldest_message_at,
                MAX(created_at) AS newest_message_at
         FROM trichat_messages`
      )
      .get() as Record<string, unknown>;

    const busiestRows = this.db
      .prepare(
        `SELECT t.thread_id, t.status, t.updated_at, COUNT(m.message_id) AS message_count
         FROM trichat_threads t
         LEFT JOIN trichat_messages m ON m.thread_id = t.thread_id
         GROUP BY t.thread_id, t.status, t.updated_at
         ORDER BY message_count DESC, t.updated_at DESC
         LIMIT ?`
      )
      .all(busiestLimit) as Array<Record<string, unknown>>;

    return {
      thread_counts: threadCounts,
      message_count: Number(messageAgg.message_count ?? 0),
      oldest_message_at: asNullableString(messageAgg.oldest_message_at),
      newest_message_at: asNullableString(messageAgg.newest_message_at),
      busiest_threads: busiestRows.map((row) => ({
        thread_id: String(row.thread_id ?? ""),
        status: normalizeTriChatThreadStatus(row.status),
        updated_at: String(row.updated_at ?? ""),
        message_count: Number(row.message_count ?? 0),
      })),
    };
  }

  upsertTriChatThread(params: {
    thread_id?: string;
    title?: string;
    status?: TriChatThreadStatus;
    metadata?: Record<string, unknown>;
  }): { created: boolean; thread: TriChatThreadRecord } {
    const now = new Date().toISOString();
    const threadId = params.thread_id?.trim() || crypto.randomUUID();
    const existing = this.getTriChatThreadById(threadId);
    const status = normalizeTriChatThreadStatus(params.status);
    const metadata = params.metadata ?? {};
    const title = params.title?.trim() || null;
    this.db
      .prepare(
        `INSERT INTO trichat_threads (thread_id, created_at, updated_at, title, status, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           title = COALESCE(excluded.title, trichat_threads.title),
           status = excluded.status,
           metadata_json = excluded.metadata_json`
      )
      .run(threadId, now, now, title, status, stableStringify(metadata));
    const thread = this.getTriChatThreadById(threadId);
    if (!thread) {
      throw new Error(`Failed to read trichat thread after upsert: ${threadId}`);
    }
    return {
      created: !existing,
      thread,
    };
  }

  getTriChatThreadById(threadId: string): TriChatThreadRecord | null {
    const normalized = threadId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT thread_id, created_at, updated_at, title, status, metadata_json
         FROM trichat_threads
         WHERE thread_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatThreadRow(row);
  }

  listTriChatThreads(params: {
    status?: TriChatThreadStatus;
    limit: number;
  }): TriChatThreadRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const rows = params.status
      ? (this.db
          .prepare(
            `SELECT thread_id, created_at, updated_at, title, status, metadata_json
             FROM trichat_threads
             WHERE status = ?
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(params.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT thread_id, created_at, updated_at, title, status, metadata_json
             FROM trichat_threads
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map((row) => mapTriChatThreadRow(row));
  }

  appendTriChatMessage(params: {
    thread_id: string;
    agent_id: string;
    role: string;
    content: string;
    reply_to_message_id?: string;
    metadata?: Record<string, unknown>;
  }): TriChatMessageRecord {
    const now = new Date().toISOString();
    const threadId = params.thread_id.trim();
    const agentId = params.agent_id.trim();
    const role = params.role.trim();
    const content = params.content.trim();
    const replyToMessageId = params.reply_to_message_id?.trim() || null;
    if (!threadId || !agentId || !role || !content) {
      throw new Error("thread_id, agent_id, role, and content are required");
    }
    const messageId = crypto.randomUUID();
    const metadata = params.metadata ?? {};

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO trichat_threads (thread_id, created_at, updated_at, title, status, metadata_json)
           VALUES (?, ?, ?, NULL, 'active', '{}')
           ON CONFLICT(thread_id) DO UPDATE SET
             updated_at = excluded.updated_at`
        )
        .run(threadId, now, now);
      this.db
        .prepare(
          `INSERT INTO trichat_messages (
             message_id, thread_id, created_at, agent_id, role, content, reply_to_message_id, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(messageId, threadId, now, agentId, role, content, replyToMessageId, stableStringify(metadata));
      this.db.prepare(`UPDATE trichat_threads SET updated_at = ? WHERE thread_id = ?`).run(now, threadId);
    });
    write();

    return {
      message_id: messageId,
      thread_id: threadId,
      created_at: now,
      agent_id: agentId,
      role,
      content,
      reply_to_message_id: replyToMessageId,
      metadata,
    };
  }

  getTriChatTimeline(params: {
    thread_id: string;
    limit: number;
    since?: string;
    agent_id?: string;
    role?: string;
  }): TriChatMessageRecord[] {
    const threadId = params.thread_id.trim();
    if (!threadId) {
      return [];
    }
    const limit = Math.max(1, Math.min(2000, params.limit));
    const whereClauses = ["thread_id = ?"];
    const values: Array<string | number> = [threadId];

    if (params.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }
    if (params.agent_id?.trim()) {
      whereClauses.push("agent_id = ?");
      values.push(params.agent_id.trim());
    }
    if (params.role?.trim()) {
      whereClauses.push("role = ?");
      values.push(params.role.trim());
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id, created_at, agent_id, role, content, reply_to_message_id, metadata_json
         FROM trichat_messages
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTriChatMessageRow(row));
  }

  createOrGetTriChatTurn(params: {
    turn_id?: string;
    thread_id: string;
    user_message_id: string;
    user_prompt: string;
    status?: TriChatTurnStatus;
    phase?: TriChatTurnPhase;
    phase_status?: TriChatTurnPhaseStatus;
    expected_agents?: string[];
    min_agents?: number;
    novelty_score?: number | null;
    novelty_threshold?: number | null;
    retry_required?: boolean;
    retry_agents?: string[];
    disagreement?: boolean;
    decision_summary?: string | null;
    selected_agent?: string | null;
    selected_strategy?: string | null;
    verify_status?: string | null;
    verify_summary?: string | null;
    metadata?: Record<string, unknown>;
  }): { created: boolean; turn: TriChatTurnRecord } {
    const now = new Date().toISOString();
    const threadId = params.thread_id.trim();
    const userMessageId = params.user_message_id.trim();
    const userPrompt = params.user_prompt.trim();
    if (!threadId || !userMessageId || !userPrompt) {
      throw new Error("thread_id, user_message_id, and user_prompt are required");
    }

    const existing = this.getTriChatTurnByUserMessage(threadId, userMessageId);
    if (existing) {
      return {
        created: false,
        turn: existing,
      };
    }

    const turnId = params.turn_id?.trim() || crypto.randomUUID();
    const status = normalizeTriChatTurnStatus(params.status);
    const phase = normalizeTriChatTurnPhase(params.phase);
    const phaseStatus = normalizeTriChatTurnPhaseStatus(params.phase_status);
    const expectedAgents = dedupeNonEmpty(params.expected_agents ?? []);
    const inferredMinAgents = expectedAgents.length >= 1 ? expectedAgents.length : 3;
    const minAgents = parseBoundedInt(params.min_agents, inferredMinAgents, 1, 12);
    const retryAgents = dedupeNonEmpty(params.retry_agents ?? []);
    const metadata = params.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO trichat_turns (
           turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
           started_at, finished_at, status, phase, phase_status, expected_agents_json,
           min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
           disagreement, decision_summary, selected_agent, selected_strategy,
           verify_status, verify_summary, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turnId,
        threadId,
        userMessageId,
        userPrompt,
        now,
        now,
        now,
        null,
        status,
        phase,
        phaseStatus,
        stableStringify(expectedAgents),
        minAgents,
        params.novelty_score ?? null,
        params.novelty_threshold ?? null,
        params.retry_required ? 1 : 0,
        stableStringify(retryAgents),
        params.disagreement ? 1 : 0,
        asNullableString(params.decision_summary),
        asNullableString(params.selected_agent),
        asNullableString(params.selected_strategy),
        asNullableString(params.verify_status),
        asNullableString(params.verify_summary),
        stableStringify(metadata)
      );

    const turn = this.getTriChatTurnById(turnId);
    if (!turn) {
      throw new Error(`Failed to read tri-chat turn after create: ${turnId}`);
    }
    return {
      created: true,
      turn,
    };
  }

  updateTriChatTurn(params: {
    turn_id: string;
    status?: TriChatTurnStatus;
    phase?: TriChatTurnPhase;
    phase_status?: TriChatTurnPhaseStatus;
    finished_at?: string | null;
    expected_agents?: string[];
    min_agents?: number;
    novelty_score?: number | null;
    novelty_threshold?: number | null;
    retry_required?: boolean;
    retry_agents?: string[];
    disagreement?: boolean;
    decision_summary?: string | null;
    selected_agent?: string | null;
    selected_strategy?: string | null;
    verify_status?: string | null;
    verify_summary?: string | null;
    metadata?: Record<string, unknown>;
  }): TriChatTurnRecord {
    const turnId = params.turn_id.trim();
    if (!turnId) {
      throw new Error("turn_id is required");
    }
    const existing = this.getTriChatTurnById(turnId);
    if (!existing) {
      throw new Error(`Tri-chat turn not found: ${turnId}`);
    }
    const now = new Date().toISOString();

    const status = normalizeTriChatTurnStatus(params.status ?? existing.status);
    const phase = normalizeTriChatTurnPhase(params.phase ?? existing.phase);
    const phaseStatus = normalizeTriChatTurnPhaseStatus(params.phase_status ?? existing.phase_status);
    const expectedAgents = dedupeNonEmpty(params.expected_agents ?? existing.expected_agents);
    const inferredMinAgents = expectedAgents.length >= 1 ? expectedAgents.length : existing.min_agents;
    const minAgents = parseBoundedInt(params.min_agents, inferredMinAgents, 1, 12);
    const retryAgents = dedupeNonEmpty(params.retry_agents ?? existing.retry_agents);
    const shouldFinish = status !== "running" || (phase === "summarize" && phaseStatus === "completed");
    const finishedAt = params.finished_at === null
      ? null
      : normalizeOptionalIsoTimestamp(params.finished_at ?? undefined) ??
          (shouldFinish ? existing.finished_at ?? now : existing.finished_at);
    const metadata = params.metadata ? { ...existing.metadata, ...params.metadata } : existing.metadata;

    this.db
      .prepare(
        `UPDATE trichat_turns
         SET updated_at = ?,
             finished_at = ?,
             status = ?,
             phase = ?,
             phase_status = ?,
             expected_agents_json = ?,
             min_agents = ?,
             novelty_score = ?,
             novelty_threshold = ?,
             retry_required = ?,
             retry_agents_json = ?,
             disagreement = ?,
             decision_summary = ?,
             selected_agent = ?,
             selected_strategy = ?,
             verify_status = ?,
             verify_summary = ?,
             metadata_json = ?
         WHERE turn_id = ?`
      )
      .run(
        now,
        finishedAt,
        status,
        phase,
        phaseStatus,
        stableStringify(expectedAgents),
        minAgents,
        params.novelty_score ?? existing.novelty_score ?? null,
        params.novelty_threshold ?? existing.novelty_threshold ?? null,
        (params.retry_required ?? existing.retry_required) ? 1 : 0,
        stableStringify(retryAgents),
        (params.disagreement ?? existing.disagreement) ? 1 : 0,
        asNullableString(params.decision_summary ?? existing.decision_summary),
        asNullableString(params.selected_agent ?? existing.selected_agent),
        asNullableString(params.selected_strategy ?? existing.selected_strategy),
        asNullableString(params.verify_status ?? existing.verify_status),
        asNullableString(params.verify_summary ?? existing.verify_summary),
        stableStringify(metadata),
        turnId
      );

    const updated = this.getTriChatTurnById(turnId);
    if (!updated) {
      throw new Error(`Failed to read tri-chat turn after update: ${turnId}`);
    }
    return updated;
  }

  getTriChatTurnById(turnId: string): TriChatTurnRecord | null {
    const normalized = turnId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         WHERE turn_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatTurnRow(row);
  }

  getTriChatTurnByUserMessage(threadId: string, userMessageId: string): TriChatTurnRecord | null {
    const normalizedThreadId = threadId.trim();
    const normalizedMessageId = userMessageId.trim();
    if (!normalizedThreadId || !normalizedMessageId) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         WHERE thread_id = ? AND user_message_id = ?`
      )
      .get(normalizedThreadId, normalizedMessageId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatTurnRow(row);
  }

  getLatestTriChatTurn(params: { thread_id: string; include_closed?: boolean }): TriChatTurnRecord | null {
    const threadId = params.thread_id.trim();
    if (!threadId) {
      return null;
    }
    const includeClosed = params.include_closed ?? true;
    const row = includeClosed
      ? (this.db
          .prepare(
            `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                    started_at, finished_at, status, phase, phase_status, expected_agents_json,
                    min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                    disagreement, decision_summary, selected_agent, selected_strategy,
                    verify_status, verify_summary, metadata_json
             FROM trichat_turns
             WHERE thread_id = ?
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1`
          )
          .get(threadId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                    started_at, finished_at, status, phase, phase_status, expected_agents_json,
                    min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                    disagreement, decision_summary, selected_agent, selected_strategy,
                    verify_status, verify_summary, metadata_json
             FROM trichat_turns
             WHERE thread_id = ? AND status = 'running'
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1`
          )
          .get(threadId) as Record<string, unknown> | undefined);
    if (!row) {
      return null;
    }
    return mapTriChatTurnRow(row);
  }

  listTriChatTurns(params: {
    thread_id?: string;
    status?: TriChatTurnStatus;
    phase?: TriChatTurnPhase;
    limit: number;
  }): TriChatTurnRecord[] {
    const limit = parseBoundedInt(params.limit, 25, 1, 500);
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeTriChatTurnStatus(params.status));
    }
    if (params.phase) {
      whereClauses.push("phase = ?");
      values.push(normalizeTriChatTurnPhase(params.phase));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         ${whereSql}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatTurnRow(row));
  }

  listStaleRunningTriChatTurns(params: {
    stale_before_iso: string;
    thread_id?: string;
    limit: number;
  }): TriChatTurnRecord[] {
    const staleBeforeIso = normalizeIsoTimestamp(params.stale_before_iso, new Date().toISOString());
    const limit = parseBoundedInt(params.limit, 10, 1, 500);
    const whereClauses = ["status = 'running'", "updated_at <= ?"];
    const values: Array<string | number> = [staleBeforeIso];
    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }

    const rows = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY updated_at ASC, created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatTurnRow(row));
  }

  appendTriChatTurnArtifact(params: {
    turn_id: string;
    phase: TriChatTurnPhase;
    artifact_type: string;
    agent_id?: string;
    content?: string;
    structured?: Record<string, unknown>;
    score?: number | null;
    metadata?: Record<string, unknown>;
  }): TriChatTurnArtifactRecord {
    const now = new Date().toISOString();
    const turnId = params.turn_id.trim();
    const artifactType = params.artifact_type.trim();
    if (!turnId || !artifactType) {
      throw new Error("turn_id and artifact_type are required");
    }
    const turn = this.getTriChatTurnById(turnId);
    if (!turn) {
      throw new Error(`Tri-chat turn not found: ${turnId}`);
    }
    const artifactId = crypto.randomUUID();
    const phase = normalizeTriChatTurnPhase(params.phase);
    const score = typeof params.score === "number" && Number.isFinite(params.score) ? params.score : null;
    const structured = params.structured ?? {};
    const metadata = params.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO trichat_turn_artifacts (
           artifact_id, turn_id, thread_id, created_at, phase, artifact_type,
           agent_id, content, structured_json, score, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        turn.turn_id,
        turn.thread_id,
        now,
        phase,
        artifactType,
        asNullableString(params.agent_id),
        asNullableString(params.content),
        stableStringify(structured),
        score,
        stableStringify(metadata)
      );

    const row = this.db
      .prepare(
        `SELECT artifact_id, turn_id, thread_id, created_at, phase, artifact_type, agent_id, content,
                structured_json, score, metadata_json
         FROM trichat_turn_artifacts
         WHERE artifact_id = ?`
      )
      .get(artifactId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read tri-chat turn artifact after insert: ${artifactId}`);
    }
    return mapTriChatTurnArtifactRow(row);
  }

  listTriChatTurnArtifacts(params: {
    turn_id?: string;
    thread_id?: string;
    phase?: TriChatTurnPhase;
    artifact_type?: string;
    agent_id?: string;
    limit: number;
  }): TriChatTurnArtifactRecord[] {
    const limit = parseBoundedInt(params.limit, 100, 1, 2000);
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const turnId = params.turn_id?.trim();
    if (turnId) {
      whereClauses.push("turn_id = ?");
      values.push(turnId);
    }
    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    if (params.phase) {
      whereClauses.push("phase = ?");
      values.push(normalizeTriChatTurnPhase(params.phase));
    }
    const artifactType = params.artifact_type?.trim();
    if (artifactType) {
      whereClauses.push("artifact_type = ?");
      values.push(artifactType);
    }
    const agentId = params.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (whereClauses.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT artifact_id, turn_id, thread_id, created_at, phase, artifact_type, agent_id, content,
                structured_json, score, metadata_json
         FROM trichat_turn_artifacts
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTriChatTurnArtifactRow(row));
  }

  appendTriChatBusEvent(params: {
    thread_id: string;
    event_type: string;
    created_at?: string;
    source_agent?: string;
    source_client?: string;
    role?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    event_id?: string;
  }): TriChatBusEventRecord {
    const now = new Date().toISOString();
    const threadId = params.thread_id.trim();
    const eventType = params.event_type.trim();
    if (!threadId || !eventType) {
      throw new Error("thread_id and event_type are required");
    }

    const createdAt = normalizeIsoTimestamp(params.created_at, now);
    const eventId = params.event_id?.trim() || crypto.randomUUID();
    const sourceAgent = asNullableString(params.source_agent);
    const sourceClient = asNullableString(params.source_client);
    const role = asNullableString(params.role);
    const content = asNullableString(params.content);
    const metadata = params.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO trichat_bus_events (
           event_id, thread_id, created_at, source_agent, source_client, event_type, role, content, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        threadId,
        createdAt,
        sourceAgent,
        sourceClient,
        eventType,
        role,
        content,
        stableStringify(metadata)
      );

    const row = this.db
      .prepare(
        `SELECT event_seq, event_id, thread_id, created_at, source_agent, source_client, event_type, role, content, metadata_json
         FROM trichat_bus_events
         WHERE event_id = ?`
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read tri-chat bus event after insert: ${eventId}`);
    }
    return mapTriChatBusEventRow(row);
  }

  listTriChatBusEvents(params?: {
    thread_id?: string;
    source_agent?: string;
    event_types?: string[];
    since_seq?: number;
    since?: string;
    limit?: number;
  }): TriChatBusEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const threadId = params?.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    const sourceAgent = params?.source_agent?.trim();
    if (sourceAgent) {
      whereClauses.push("source_agent = ?");
      values.push(sourceAgent);
    }

    const eventTypes = (params?.event_types ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }

    const sinceSeq = parseBoundedInt(params?.since_seq, 0, 0, Number.MAX_SAFE_INTEGER);
    if (sinceSeq > 0) {
      whereClauses.push("event_seq > ?");
      values.push(sinceSeq);
    }

    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }

    const limit = parseBoundedInt(params?.limit, 200, 1, 5000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_seq, event_id, thread_id, created_at, source_agent, source_client, event_type, role, content, metadata_json
         FROM trichat_bus_events
         ${whereSql}
         ORDER BY event_seq DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTriChatBusEventRow(row));
  }

  pruneTriChatMessages(params: {
    older_than_iso: string;
    thread_id?: string;
    limit: number;
    dry_run?: boolean;
  }): { candidate_count: number; deleted_count: number; deleted_message_ids: string[] } {
    const limit = Math.max(1, Math.min(5000, params.limit));
    const whereClauses = ["created_at <= ?"];
    const values: Array<string | number> = [params.older_than_iso];
    if (params.thread_id?.trim()) {
      whereClauses.push("thread_id = ?");
      values.push(params.thread_id.trim());
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id
         FROM trichat_messages
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    const messageIds = rows
      .map((row) => String(row.message_id ?? ""))
      .filter((id) => id.length > 0);
    const threadIds = Array.from(
      new Set(rows.map((row) => String(row.thread_id ?? "")).filter((id) => id.length > 0))
    );

    if (params.dry_run || messageIds.length === 0) {
      return {
        candidate_count: messageIds.length,
        deleted_count: 0,
        deleted_message_ids: [],
      };
    }

    const deleteStmt = this.db.prepare(`DELETE FROM trichat_messages WHERE message_id = ?`);
    const latestMessageStmt = this.db.prepare(
      `SELECT MAX(created_at) AS latest_created_at
       FROM trichat_messages
       WHERE thread_id = ?`
    );
    const threadCreatedStmt = this.db.prepare(
      `SELECT created_at
       FROM trichat_threads
       WHERE thread_id = ?`
    );
    const touchThreadStmt = this.db.prepare(`UPDATE trichat_threads SET updated_at = ? WHERE thread_id = ?`);

    const apply = this.db.transaction((ids: string[], affectedThreadIds: string[]) => {
      let deleted = 0;
      for (const messageId of ids) {
        const result = deleteStmt.run(messageId);
        deleted += Number(result.changes ?? 0);
      }
      for (const threadId of affectedThreadIds) {
        const latestRow = latestMessageStmt.get(threadId) as Record<string, unknown> | undefined;
        const latestCreatedAt = asNullableString(latestRow?.latest_created_at);
        if (latestCreatedAt) {
          touchThreadStmt.run(latestCreatedAt, threadId);
          continue;
        }
        const createdRow = threadCreatedStmt.get(threadId) as Record<string, unknown> | undefined;
        const fallback = asNullableString(createdRow?.created_at) ?? new Date().toISOString();
        touchThreadStmt.run(fallback, threadId);
      }
      return deleted;
    });

    const deletedCount = apply(messageIds, threadIds);
    return {
      candidate_count: messageIds.length,
      deleted_count: deletedCount,
      deleted_message_ids: messageIds,
    };
  }

  upsertTriChatAdapterStates(params: {
    states: Array<{
      agent_id: string;
      channel: TriChatAdapterChannel;
      updated_at?: string;
      open: boolean;
      open_until?: string | null;
      failure_count: number;
      trip_count: number;
      success_count: number;
      last_error?: string | null;
      last_opened_at?: string | null;
      turn_count: number;
      degraded_turn_count: number;
      last_result?: string | null;
      metadata?: Record<string, unknown>;
    }>;
  }): TriChatAdapterStateRecord[] {
    if (!params.states.length) {
      return [];
    }

    const now = new Date().toISOString();
    const upsertStmt = this.db.prepare(
      `INSERT INTO trichat_adapter_states (
         agent_id, channel, updated_at, open, open_until, failure_count, trip_count, success_count,
         last_error, last_opened_at, turn_count, degraded_turn_count, last_result, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         updated_at = excluded.updated_at,
         open = excluded.open,
         open_until = excluded.open_until,
         failure_count = excluded.failure_count,
         trip_count = excluded.trip_count,
         success_count = excluded.success_count,
         last_error = excluded.last_error,
         last_opened_at = excluded.last_opened_at,
         turn_count = excluded.turn_count,
         degraded_turn_count = excluded.degraded_turn_count,
         last_result = excluded.last_result,
         metadata_json = excluded.metadata_json`
    );

    const apply = this.db.transaction((states: typeof params.states) => {
      const records: TriChatAdapterStateRecord[] = [];
      for (const state of states) {
        const agentId = state.agent_id.trim();
        if (!agentId) {
          continue;
        }
        const channel = normalizeTriChatAdapterChannel(state.channel);
        const updatedAt = normalizeIsoTimestamp(state.updated_at, now);
        const openUntil = normalizeOptionalIsoTimestamp(state.open_until);
        const failureCount = parseBoundedInt(state.failure_count, 0, 0, 1_000_000);
        const tripCount = parseBoundedInt(state.trip_count, 0, 0, 1_000_000);
        const successCount = parseBoundedInt(state.success_count, 0, 0, 1_000_000);
        const turnCount = parseBoundedInt(state.turn_count, 0, 0, 1_000_000);
        const degradedTurnCount = parseBoundedInt(state.degraded_turn_count, 0, 0, 1_000_000);
        const lastError = asNullableString(state.last_error);
        const lastOpenedAt = normalizeOptionalIsoTimestamp(state.last_opened_at);
        const lastResult = asNullableString(state.last_result);
        const metadata = state.metadata ?? {};

        upsertStmt.run(
          agentId,
          channel,
          updatedAt,
          state.open ? 1 : 0,
          openUntil,
          failureCount,
          tripCount,
          successCount,
          lastError,
          lastOpenedAt,
          turnCount,
          degradedTurnCount,
          lastResult,
          stableStringify(metadata)
        );

        records.push({
          agent_id: agentId,
          channel,
          updated_at: updatedAt,
          open: Boolean(state.open),
          open_until: openUntil,
          failure_count: failureCount,
          trip_count: tripCount,
          success_count: successCount,
          last_error: lastError,
          last_opened_at: lastOpenedAt,
          turn_count: turnCount,
          degraded_turn_count: degradedTurnCount,
          last_result: lastResult,
          metadata,
        });
      }
      return records;
    });

    return apply(params.states);
  }

  listTriChatAdapterStates(params?: {
    agent_id?: string;
    channel?: TriChatAdapterChannel;
    limit?: number;
  }): TriChatAdapterStateRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const agentId = params?.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params?.channel) {
      whereClauses.push("channel = ?");
      values.push(normalizeTriChatAdapterChannel(params.channel));
    }
    const limit = parseBoundedInt(params?.limit, 500, 1, 5000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT agent_id, channel, updated_at, open, open_until, failure_count, trip_count, success_count,
                last_error, last_opened_at, turn_count, degraded_turn_count, last_result, metadata_json
         FROM trichat_adapter_states
         ${whereSql}
         ORDER BY agent_id ASC, channel ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatAdapterStateRow(row));
  }

  appendTriChatAdapterEvents(params: {
    events: Array<{
      agent_id: string;
      channel: TriChatAdapterChannel;
      event_type: string;
      created_at?: string;
      open_until?: string | null;
      error_text?: string | null;
      details?: Record<string, unknown>;
    }>;
  }): TriChatAdapterEventRecord[] {
    if (!params.events.length) {
      return [];
    }
    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(
      `INSERT INTO trichat_adapter_events (
         event_id, created_at, agent_id, channel, event_type, open_until, error_text, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const apply = this.db.transaction((events: typeof params.events) => {
      const records: TriChatAdapterEventRecord[] = [];
      for (const event of events) {
        const agentId = event.agent_id.trim();
        const eventType = event.event_type.trim();
        if (!agentId || !eventType) {
          continue;
        }
        const channel = normalizeTriChatAdapterChannel(event.channel);
        const createdAt = normalizeIsoTimestamp(event.created_at, now);
        const eventId = crypto.randomUUID();
        const openUntil = normalizeOptionalIsoTimestamp(event.open_until);
        const errorText = asNullableString(event.error_text);
        const details = event.details ?? {};
        insertStmt.run(
          eventId,
          createdAt,
          agentId,
          channel,
          eventType,
          openUntil,
          errorText,
          stableStringify(details)
        );
        records.push({
          event_id: eventId,
          created_at: createdAt,
          agent_id: agentId,
          channel,
          event_type: eventType,
          open_until: openUntil,
          error_text: errorText,
          details,
        });
      }
      return records;
    });

    return apply(params.events);
  }

  listTriChatAdapterEvents(params?: {
    agent_id?: string;
    channel?: TriChatAdapterChannel;
    event_types?: string[];
    limit?: number;
  }): TriChatAdapterEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const agentId = params?.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params?.channel) {
      whereClauses.push("channel = ?");
      values.push(normalizeTriChatAdapterChannel(params.channel));
    }
    const eventTypes = (params?.event_types ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }

    const limit = parseBoundedInt(params?.limit, 100, 0, 5000);
    if (limit === 0) {
      return [];
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_id, created_at, agent_id, channel, event_type, open_until, error_text, details_json
         FROM trichat_adapter_events
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatAdapterEventRow(row));
  }

  getTriChatAdapterTelemetrySummary(params?: {
    agent_id?: string;
    channel?: TriChatAdapterChannel;
  }): TriChatAdapterTelemetrySummaryRecord {
    const eventWhereClauses: string[] = [];
    const eventValues: Array<string | number> = [];

    const agentId = params?.agent_id?.trim();
    if (agentId) {
      eventWhereClauses.push("agent_id = ?");
      eventValues.push(agentId);
    }
    if (params?.channel) {
      const channel = normalizeTriChatAdapterChannel(params.channel);
      eventWhereClauses.push("channel = ?");
      eventValues.push(channel);
    }

    const eventWhereSql = eventWhereClauses.length > 0 ? `WHERE ${eventWhereClauses.join(" AND ")}` : "";
    const states = this.listTriChatAdapterStates({
      agent_id: agentId,
      channel: params?.channel,
      limit: 5000,
    });

    const eventAgg = this.db
      .prepare(
        `SELECT MAX(created_at) AS newest_event_at,
                MAX(CASE WHEN event_type = 'trip_opened' THEN created_at END) AS newest_trip_opened_at
         FROM trichat_adapter_events
         ${eventWhereSql}`
      )
      .get(...eventValues) as Record<string, unknown>;

    let newestStateAt: string | null = null;
    let openChannels = 0;
    let totalTrips = 0;
    let totalSuccesses = 0;
    let totalTurns = 0;
    let totalDegradedTurns = 0;
    const perAgent = new Map<
      string,
      {
        agent_id: string;
        channel_count: number;
        open_channels: number;
        total_trips: number;
        total_turns: number;
        degraded_turns: number;
        updated_at: string | null;
      }
    >();
    for (const state of states) {
      if (state.open) {
        openChannels += 1;
      }
      totalTrips += state.trip_count;
      totalSuccesses += state.success_count;
      totalTurns += state.turn_count;
      totalDegradedTurns += state.degraded_turn_count;
      if (state.updated_at && (!newestStateAt || state.updated_at > newestStateAt)) {
        newestStateAt = state.updated_at;
      }
      const current = perAgent.get(state.agent_id) ?? {
        agent_id: state.agent_id,
        channel_count: 0,
        open_channels: 0,
        total_trips: 0,
        total_turns: 0,
        degraded_turns: 0,
        updated_at: null,
      };
      current.channel_count += 1;
      if (state.open) {
        current.open_channels += 1;
      }
      current.total_trips += state.trip_count;
      current.total_turns += state.turn_count;
      current.degraded_turns += state.degraded_turn_count;
      if (state.updated_at && (!current.updated_at || state.updated_at > current.updated_at)) {
        current.updated_at = state.updated_at;
      }
      perAgent.set(state.agent_id, current);
    }
    const perAgentRows = [...perAgent.values()].sort((left, right) =>
      left.agent_id.localeCompare(right.agent_id)
    );

    return {
      total_channels: states.length,
      open_channels: openChannels,
      total_trips: totalTrips,
      total_successes: totalSuccesses,
      total_turns: totalTurns,
      total_degraded_turns: totalDegradedTurns,
      newest_state_at: newestStateAt,
      newest_event_at: asNullableString(eventAgg.newest_event_at),
      newest_trip_opened_at: asNullableString(eventAgg.newest_trip_opened_at),
      per_agent: perAgentRows,
    };
  }

  listTriChatAdapterEventsSince(params: {
    since_iso: string;
    limit: number;
    agent_id?: string;
    channel?: TriChatAdapterChannel;
  }): TriChatAdapterEventRecord[] {
    const sinceIso = normalizeIsoTimestamp(params.since_iso, new Date().toISOString());
    const limit = parseBoundedInt(params.limit, 5000, 1, 50000);
    const whereClauses = ["created_at >= ?"];
    const values: Array<string | number> = [sinceIso];
    const agentId = params.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params.channel) {
      whereClauses.push("channel = ?");
      values.push(normalizeTriChatAdapterChannel(params.channel));
    }

    const rows = this.db
      .prepare(
        `SELECT event_id, created_at, agent_id, channel, event_type, open_until, error_text, details_json
         FROM trichat_adapter_events
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatAdapterEventRow(row));
  }

  getTriChatTurnOutcomeCountsSince(params: {
    since_iso: string;
    thread_id?: string;
  }): { total_count: number; failed_count: number } {
    const sinceIso = normalizeIsoTimestamp(params.since_iso, new Date().toISOString());
    const whereClauses = ["created_at >= ?"];
    const values: Array<string | number> = [sinceIso];
    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM trichat_turns
         ${whereSql}`
      )
      .get(...values) as Record<string, unknown>;
    return {
      total_count: Number(row.total_count ?? 0),
      failed_count: Number(row.failed_count ?? 0),
    };
  }

  appendTriChatChaosEvent(params: {
    action: string;
    outcome: string;
    thread_id?: string;
    turn_id?: string;
    agent_id?: string;
    channel?: TriChatAdapterChannel;
    created_at?: string;
    details?: Record<string, unknown>;
  }): TriChatChaosEventRecord {
    const action = params.action.trim();
    const outcome = params.outcome.trim();
    if (!action || !outcome) {
      throw new Error("action and outcome are required");
    }
    const eventId = crypto.randomUUID();
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const details = params.details ?? {};
    const channel = params.channel ? normalizeTriChatAdapterChannel(params.channel) : null;

    this.db
      .prepare(
        `INSERT INTO trichat_chaos_events (
           event_id, created_at, action, thread_id, turn_id, agent_id, channel, outcome, details_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        createdAt,
        action,
        asNullableString(params.thread_id),
        asNullableString(params.turn_id),
        asNullableString(params.agent_id),
        channel,
        outcome,
        stableStringify(details)
      );

    const row = this.db
      .prepare(
        `SELECT event_id, created_at, action, thread_id, turn_id, agent_id, channel, outcome, details_json
         FROM trichat_chaos_events
         WHERE event_id = ?`
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read trichat chaos event after insert: ${eventId}`);
    }
    return mapTriChatChaosEventRow(row);
  }

  listTriChatChaosEvents(params?: {
    action?: string;
    outcome?: string;
    thread_id?: string;
    limit?: number;
  }): TriChatChaosEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const action = params?.action?.trim();
    if (action) {
      whereClauses.push("action = ?");
      values.push(action);
    }
    const outcome = params?.outcome?.trim();
    if (outcome) {
      whereClauses.push("outcome = ?");
      values.push(outcome);
    }
    const threadId = params?.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    const limit = parseBoundedInt(params?.limit, 50, 1, 2000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_id, created_at, action, thread_id, turn_id, agent_id, channel, outcome, details_json
         FROM trichat_chaos_events
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatChaosEventRow(row));
  }

  appendTriChatSloSnapshot(params: {
    created_at?: string;
    window_minutes: number;
    adapter_sample_count: number;
    adapter_error_count: number;
    adapter_error_rate: number;
    adapter_latency_p95_ms?: number | null;
    turn_total_count: number;
    turn_failed_count: number;
    turn_failure_rate: number;
    metadata?: Record<string, unknown>;
  }): TriChatSloSnapshotRecord {
    const snapshotId = crypto.randomUUID();
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const metadata = params.metadata ?? {};
    const rowValues = {
      window_minutes: parseBoundedInt(params.window_minutes, 60, 1, 10080),
      adapter_sample_count: parseBoundedInt(params.adapter_sample_count, 0, 0, 1_000_000),
      adapter_error_count: parseBoundedInt(params.adapter_error_count, 0, 0, 1_000_000),
      adapter_error_rate: clampMetricRate(params.adapter_error_rate),
      adapter_latency_p95_ms:
        typeof params.adapter_latency_p95_ms === "number" && Number.isFinite(params.adapter_latency_p95_ms)
          ? Number(params.adapter_latency_p95_ms)
          : null,
      turn_total_count: parseBoundedInt(params.turn_total_count, 0, 0, 1_000_000),
      turn_failed_count: parseBoundedInt(params.turn_failed_count, 0, 0, 1_000_000),
      turn_failure_rate: clampMetricRate(params.turn_failure_rate),
    };
    this.db
      .prepare(
        `INSERT INTO trichat_slo_snapshots (
           snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
           adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
           turn_failure_rate, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshotId,
        createdAt,
        rowValues.window_minutes,
        rowValues.adapter_sample_count,
        rowValues.adapter_error_count,
        rowValues.adapter_error_rate,
        rowValues.adapter_latency_p95_ms,
        rowValues.turn_total_count,
        rowValues.turn_failed_count,
        rowValues.turn_failure_rate,
        stableStringify(metadata)
      );

    const row = this.db
      .prepare(
        `SELECT snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
                adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
                turn_failure_rate, metadata_json
         FROM trichat_slo_snapshots
         WHERE snapshot_id = ?`
      )
      .get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read trichat SLO snapshot after insert: ${snapshotId}`);
    }
    return mapTriChatSloSnapshotRow(row);
  }

  getLatestTriChatSloSnapshot(): TriChatSloSnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
                adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
                turn_failure_rate, metadata_json
         FROM trichat_slo_snapshots
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatSloSnapshotRow(row);
  }

  listTriChatSloSnapshots(params?: { limit?: number }): TriChatSloSnapshotRecord[] {
    const limit = parseBoundedInt(params?.limit, 25, 1, 1000);
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
                adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
                turn_failure_rate, metadata_json
         FROM trichat_slo_snapshots
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatSloSnapshotRow(row));
  }

  getTranscriptById(transcriptId: string): TranscriptRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
         FROM transcripts
         WHERE id = ?`
      )
      .get(transcriptId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTranscriptRow(row);
  }

  getTranscriptsBySession(sessionId: string): TranscriptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
         FROM transcripts
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptRow(row));
  }

  searchTranscripts(params: {
    query?: string;
    session_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    limit: number;
  }): TranscriptRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
             FROM transcripts
             WHERE text LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
             FROM transcripts
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit * 20) as Array<Record<string, unknown>>);

    const results: TranscriptRecord[] = [];
    for (const row of rows) {
      const transcript = mapTranscriptRow(row);
      if (params.session_id && params.session_id !== transcript.session_id) {
        continue;
      }
      if (params.source_client && params.source_client !== transcript.source_client) {
        continue;
      }
      if (params.source_model && params.source_model !== transcript.source_model) {
        continue;
      }
      if (params.source_agent && params.source_agent !== transcript.source_agent) {
        continue;
      }
      transcript.score = computeTermScore(transcript.text, query);
      results.push(transcript);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  beginMutation(toolName: string, mutation: MutationMeta, payload: unknown): MutationStartResult {
    const now = new Date().toISOString();
    const payloadHash = hashPayload(payload);
    const existing = this.db
      .prepare(
        `SELECT tool_name, side_effect_fingerprint, status, result_json, error_text
         FROM mutation_journal
         WHERE idempotency_key = ?`
      )
      .get(mutation.idempotency_key) as Record<string, unknown> | undefined;

    if (existing) {
      const existingTool = String(existing.tool_name ?? "");
      const existingFingerprint = String(existing.side_effect_fingerprint ?? "");
      const status = String(existing.status ?? "unknown");
      const resultJson = asNullableString(existing.result_json);
      const errorText = asNullableString(existing.error_text);

      if (existingTool !== toolName) {
        throw new Error(
          `Idempotency key already used by a different tool (expected ${existingTool}, got ${toolName}).`
        );
      }
      if (existingFingerprint !== mutation.side_effect_fingerprint) {
        throw new Error("Idempotency key reuse with mismatched side_effect_fingerprint.");
      }
      if (status === "done") {
        return {
          replayed: true,
          result: parseJsonUnknown(resultJson),
        };
      }
      if (status === "failed") {
        throw new Error(`Previous mutation failed for key ${mutation.idempotency_key}: ${errorText ?? "unknown"}`);
      }
      throw new Error(`Mutation key is already in progress: ${mutation.idempotency_key}`);
    }

    this.db
      .prepare(
        `INSERT INTO mutation_journal (
          idempotency_key, tool_name, side_effect_fingerprint, payload_hash,
          status, result_json, error_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(
        mutation.idempotency_key,
        toolName,
        mutation.side_effect_fingerprint,
        payloadHash,
        now,
        now
      );

    return { replayed: false };
  }

  completeMutation(idempotencyKey: string, result: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mutation_journal
         SET status = 'done', result_json = ?, error_text = NULL, updated_at = ?
         WHERE idempotency_key = ?`
      )
      .run(stableStringify(result), now, idempotencyKey);
  }

  failMutation(idempotencyKey: string, errorText: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mutation_journal
         SET status = 'failed', error_text = ?, updated_at = ?
         WHERE idempotency_key = ?`
      )
      .run(errorText, now, idempotencyKey);
  }

  getMutationStatus(idempotencyKey: string): {
    idempotency_key: string;
    tool_name: string;
    side_effect_fingerprint: string;
    status: string;
    created_at: string;
    updated_at: string;
    error_text: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, tool_name, side_effect_fingerprint, status, created_at, updated_at, error_text
         FROM mutation_journal
         WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      idempotency_key: String(row.idempotency_key),
      tool_name: String(row.tool_name),
      side_effect_fingerprint: String(row.side_effect_fingerprint),
      status: String(row.status),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      error_text: asNullableString(row.error_text),
    };
  }

  insertPolicyEvaluation(params: {
    policy_name: string;
    input: unknown;
    allowed: boolean;
    reason: string;
    violations: Array<Record<string, unknown>>;
    recommendations: string[];
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO policy_evaluations (
          id, created_at, policy_name, input_json, allowed, reason, violations_json, recommendations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.policy_name,
        stableStringify(params.input),
        params.allowed ? 1 : 0,
        params.reason,
        stableStringify(params.violations),
        stableStringify(params.recommendations)
      );
    return { id, created_at: createdAt };
  }

  appendRunEvent(params: {
    run_id: string;
    event_type: "begin" | "step" | "end";
    step_index: number;
    status: string;
    summary: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const details = params.details ?? {};
    this.db
      .prepare(
        `INSERT INTO run_events (
          id, created_at, run_id, event_type, step_index, status, summary,
          source_client, source_model, source_agent, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.run_id,
        params.event_type,
        params.step_index,
        params.status,
        params.summary,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        stableStringify(details)
      );
    this.appendRuntimeEvent({
      event_type: `run.${params.event_type}`,
      entity_type: "run",
      entity_id: params.run_id,
      status: params.status,
      summary: params.summary,
      details: {
        step_index: params.step_index,
        ...details,
      },
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
      created_at: createdAt,
    });
    return { id, created_at: createdAt };
  }

  getRunTimeline(runId: string, limit: number): RunEventRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, limit));
    const rows = this.db
      .prepare(
        `SELECT id, created_at, run_id, event_type, step_index, status, summary,
                source_client, source_model, source_agent, details_json
         FROM run_events
         WHERE run_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      run_id: String(row.run_id),
      event_type: String(row.event_type) as RunEventRecord["event_type"],
      step_index: Number(row.step_index ?? 0),
      status: String(row.status),
      summary: String(row.summary),
      source_client: asNullableString(row.source_client),
      source_model: asNullableString(row.source_model),
      source_agent: asNullableString(row.source_agent),
      details: parseJsonObject(row.details_json),
    }));
  }

  createRuntimeWorkerSession(params: {
    session_id?: string;
    runtime_id: RuntimeWorkerRuntimeId;
    status?: RuntimeWorkerSessionStatus;
    task_id?: string | null;
    goal_id?: string | null;
    plan_id?: string | null;
    step_id?: string | null;
    worker_id: string;
    title: string;
    objective: string;
    repo_root: string;
    project_dir: string;
    worktree_path: string;
    branch_name?: string | null;
    tmux_session_name: string;
    transcript_path?: string | null;
    brief_path?: string | null;
    last_command_at?: string | null;
    last_activity_at?: string | null;
    last_error?: string | null;
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { created: boolean; session: RuntimeWorkerSessionRecord } {
    const now = new Date().toISOString();
    const sessionId = params.session_id?.trim() || crypto.randomUUID();
    const existing = this.getRuntimeWorkerSessionById(sessionId);
    if (existing) {
      return {
        created: false,
        session: existing,
      };
    }
    const runtimeId = normalizeRuntimeWorkerRuntimeId(params.runtime_id);
    const status = normalizeRuntimeWorkerSessionStatus(params.status);
    const title = params.title.trim();
    const objective = params.objective.trim();
    const workerId = params.worker_id.trim();
    const repoRoot = params.repo_root.trim();
    const projectDir = params.project_dir.trim();
    const worktreePath = params.worktree_path.trim();
    const tmuxSessionName = params.tmux_session_name.trim();
    if (!title || !objective || !workerId || !repoRoot || !projectDir || !worktreePath || !tmuxSessionName) {
      throw new Error(
        "title, objective, worker_id, repo_root, project_dir, worktree_path, and tmux_session_name are required"
      );
    }

    this.db
      .prepare(
        `INSERT INTO runtime_worker_sessions (
          session_id, created_at, updated_at, runtime_id, status, task_id, goal_id, plan_id, step_id,
          worker_id, title, objective, repo_root, project_dir, worktree_path, branch_name, tmux_session_name,
          transcript_path, brief_path, last_command_at, last_activity_at, last_error, metadata_json,
          source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        now,
        now,
        runtimeId,
        status,
        params.task_id?.trim() || null,
        params.goal_id?.trim() || null,
        params.plan_id?.trim() || null,
        params.step_id?.trim() || null,
        workerId,
        title,
        objective,
        repoRoot,
        projectDir,
        worktreePath,
        params.branch_name?.trim() || null,
        tmuxSessionName,
        params.transcript_path?.trim() || null,
        params.brief_path?.trim() || null,
        params.last_command_at?.trim() || null,
        params.last_activity_at?.trim() || null,
        params.last_error?.trim() || null,
        stableStringify(parseLooseObject(params.metadata ?? {})),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const session = this.getRuntimeWorkerSessionById(sessionId);
    if (!session) {
      throw new Error(`Failed to read runtime worker session after create: ${sessionId}`);
    }
    this.appendRuntimeEvent({
      event_type: "runtime_worker.created",
      entity_type: "runtime_worker_session",
      entity_id: session.session_id,
      status: session.status,
      summary: `Runtime worker ${session.runtime_id} session created.`,
      details: {
        task_id: session.task_id,
        worker_id: session.worker_id,
        tmux_session_name: session.tmux_session_name,
        worktree_path: session.worktree_path,
      },
      source_client: session.source_client ?? undefined,
      source_model: session.source_model ?? undefined,
      source_agent: session.source_agent ?? undefined,
      created_at: session.created_at,
    });
    return {
      created: true,
      session,
    };
  }

  getRuntimeWorkerSessionById(sessionId: string): RuntimeWorkerSessionRecord | null {
    const normalized = sessionId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT session_id, created_at, updated_at, runtime_id, status, task_id, goal_id, plan_id, step_id, worker_id,
                title, objective, repo_root, project_dir, worktree_path, branch_name, tmux_session_name, transcript_path,
                brief_path, last_command_at, last_activity_at, last_error, metadata_json, source_client, source_model,
                source_agent
         FROM runtime_worker_sessions
         WHERE session_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapRuntimeWorkerSessionRow(row);
  }

  getLatestRuntimeWorkerSessionForTask(taskId: string): RuntimeWorkerSessionRecord | null {
    const normalized = taskId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT session_id, created_at, updated_at, runtime_id, status, task_id, goal_id, plan_id, step_id, worker_id,
                title, objective, repo_root, project_dir, worktree_path, branch_name, tmux_session_name, transcript_path,
                brief_path, last_command_at, last_activity_at, last_error, metadata_json, source_client, source_model,
                source_agent
         FROM runtime_worker_sessions
         WHERE task_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapRuntimeWorkerSessionRow(row);
  }

  listRuntimeWorkerSessions(params?: {
    status?: RuntimeWorkerSessionStatus;
    task_id?: string;
    runtime_id?: RuntimeWorkerRuntimeId;
    limit?: number;
  }): RuntimeWorkerSessionRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    if (params?.status) {
      whereClauses.push("status = ?");
      values.push(normalizeRuntimeWorkerSessionStatus(params.status));
    }
    const taskId = params?.task_id?.trim();
    if (taskId) {
      whereClauses.push("task_id = ?");
      values.push(taskId);
    }
    if (params?.runtime_id) {
      whereClauses.push("runtime_id = ?");
      values.push(normalizeRuntimeWorkerRuntimeId(params.runtime_id));
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, params?.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT session_id, created_at, updated_at, runtime_id, status, task_id, goal_id, plan_id, step_id, worker_id,
                title, objective, repo_root, project_dir, worktree_path, branch_name, tmux_session_name, transcript_path,
                brief_path, last_command_at, last_activity_at, last_error, metadata_json, source_client, source_model,
                source_agent
         FROM runtime_worker_sessions
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapRuntimeWorkerSessionRow(row));
  }

  updateRuntimeWorkerSession(params: {
    session_id: string;
    status?: RuntimeWorkerSessionStatus;
    task_id?: string | null;
    goal_id?: string | null;
    plan_id?: string | null;
    step_id?: string | null;
    transcript_path?: string | null;
    brief_path?: string | null;
    last_command_at?: string | null;
    last_activity_at?: string | null;
    last_error?: string | null;
    metadata?: Record<string, unknown>;
  }): { session: RuntimeWorkerSessionRecord } {
    const sessionId = params.session_id.trim();
    if (!sessionId) {
      throw new Error("session_id is required");
    }
    const existing = this.getRuntimeWorkerSessionById(sessionId);
    if (!existing) {
      throw new Error(`Runtime worker session not found: ${sessionId}`);
    }
    const nextStatus = params.status ? normalizeRuntimeWorkerSessionStatus(params.status) : existing.status;
    const nextTaskId = params.task_id === undefined ? existing.task_id : params.task_id?.trim() || null;
    const nextGoalId = params.goal_id === undefined ? existing.goal_id : params.goal_id?.trim() || null;
    const nextPlanId = params.plan_id === undefined ? existing.plan_id : params.plan_id?.trim() || null;
    const nextStepId = params.step_id === undefined ? existing.step_id : params.step_id?.trim() || null;
    const nextTranscriptPath =
      params.transcript_path === undefined ? existing.transcript_path : params.transcript_path?.trim() || null;
    const nextBriefPath = params.brief_path === undefined ? existing.brief_path : params.brief_path?.trim() || null;
    const nextLastCommandAt =
      params.last_command_at === undefined ? existing.last_command_at : params.last_command_at?.trim() || null;
    const nextLastActivityAt =
      params.last_activity_at === undefined ? existing.last_activity_at : params.last_activity_at?.trim() || null;
    const nextLastError = params.last_error === undefined ? existing.last_error : params.last_error?.trim() || null;
    const nextMetadata =
      params.metadata === undefined
        ? existing.metadata
        : {
            ...existing.metadata,
            ...parseLooseObject(params.metadata),
          };
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE runtime_worker_sessions
         SET updated_at = ?, status = ?, task_id = ?, goal_id = ?, plan_id = ?, step_id = ?, transcript_path = ?,
             brief_path = ?, last_command_at = ?, last_activity_at = ?, last_error = ?, metadata_json = ?
         WHERE session_id = ?`
      )
      .run(
        now,
        nextStatus,
        nextTaskId,
        nextGoalId,
        nextPlanId,
        nextStepId,
        nextTranscriptPath,
        nextBriefPath,
        nextLastCommandAt,
        nextLastActivityAt,
        nextLastError,
        stableStringify(nextMetadata),
        sessionId
      );

    const session = this.getRuntimeWorkerSessionById(sessionId);
    if (!session) {
      throw new Error(`Failed to read runtime worker session after update: ${sessionId}`);
    }
    if (existing.status !== session.status || existing.last_error !== session.last_error) {
      this.appendRuntimeEvent({
        event_type: "runtime_worker.status",
        entity_type: "runtime_worker_session",
        entity_id: session.session_id,
        status: session.status,
        summary: `Runtime worker ${session.runtime_id} session is ${session.status}.`,
        details: {
          previous_status: existing.status,
          task_id: session.task_id,
          worker_id: session.worker_id,
          tmux_session_name: session.tmux_session_name,
          last_error: session.last_error,
        },
        source_client: session.source_client ?? undefined,
        source_model: session.source_model ?? undefined,
        source_agent: session.source_agent ?? undefined,
        created_at: session.updated_at,
      });
    }
    return {
      session,
    };
  }

  acquireLock(params: {
    lock_key: string;
    owner_id: string;
    lease_seconds: number;
    metadata?: Record<string, unknown>;
  }): LockAcquireResult {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.lease_seconds * 1000).toISOString();
    const metadata = stableStringify(params.metadata ?? {});

    const existing = this.db
      .prepare(`SELECT owner_id, lease_expires_at FROM locks WHERE lock_key = ?`)
      .get(params.lock_key) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO locks (lock_key, owner_id, lease_expires_at, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(params.lock_key, params.owner_id, expiresAt, metadata, now, now);
      return {
        acquired: true,
        lock_key: params.lock_key,
        owner_id: params.owner_id,
        lease_expires_at: expiresAt,
      };
    }

    const currentOwner = String(existing.owner_id ?? "");
    const currentExpiry = String(existing.lease_expires_at ?? "");
    const isExpired = currentExpiry <= now;

    if (currentOwner === params.owner_id || isExpired) {
      this.db
        .prepare(
          `UPDATE locks
           SET owner_id = ?, lease_expires_at = ?, metadata_json = ?, updated_at = ?
           WHERE lock_key = ?`
        )
        .run(params.owner_id, expiresAt, metadata, now, params.lock_key);
      return {
        acquired: true,
        lock_key: params.lock_key,
        owner_id: params.owner_id,
        lease_expires_at: expiresAt,
        reason: currentOwner === params.owner_id ? "renewed" : "stolen-expired",
      };
    }

    return {
      acquired: false,
      lock_key: params.lock_key,
      owner_id: currentOwner,
      lease_expires_at: currentExpiry,
      reason: "held-by-active-owner",
    };
  }

  releaseLock(params: {
    lock_key: string;
    owner_id: string;
    force?: boolean;
  }): { released: boolean; reason: string } {
    const existing = this.db
      .prepare(`SELECT owner_id FROM locks WHERE lock_key = ?`)
      .get(params.lock_key) as Record<string, unknown> | undefined;
    if (!existing) {
      return { released: false, reason: "not-found" };
    }
    const ownerId = String(existing.owner_id ?? "");
    if (!params.force && ownerId !== params.owner_id) {
      return { released: false, reason: "owner-mismatch" };
    }
    this.db.prepare(`DELETE FROM locks WHERE lock_key = ?`).run(params.lock_key);
    return { released: true, reason: params.force ? "force-released" : "released" };
  }

  upsertDecision(params: {
    decision_id: string;
    title: string;
    rationale: string;
    consequences?: string;
    rollback?: string;
    links?: string[];
    tags?: string[];
    run_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { decision_id: string; created: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT decision_id FROM decisions WHERE decision_id = ?`)
      .get(params.decision_id) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO decisions (
            decision_id, created_at, updated_at, title, rationale, consequences, rollback,
            links_json, tags_json, run_id, source_client, source_model, source_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.decision_id,
          now,
          now,
          params.title,
          params.rationale,
          params.consequences ?? null,
          params.rollback ?? null,
          stableStringify(params.links ?? []),
          stableStringify(params.tags ?? []),
          params.run_id ?? null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      return { decision_id: params.decision_id, created: true };
    }

    this.db
      .prepare(
        `UPDATE decisions
         SET updated_at = ?, title = ?, rationale = ?, consequences = ?, rollback = ?,
             links_json = ?, tags_json = ?, run_id = ?, source_client = ?, source_model = ?, source_agent = ?
         WHERE decision_id = ?`
      )
      .run(
        now,
        params.title,
        params.rationale,
        params.consequences ?? null,
        params.rollback ?? null,
        stableStringify(params.links ?? []),
        stableStringify(params.tags ?? []),
        params.run_id ?? null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        params.decision_id
      );
    return { decision_id: params.decision_id, created: false };
  }

  insertDecisionLink(params: {
    decision_id: string;
    entity_type: string;
    entity_id: string;
    relation: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO decision_links (
          id, created_at, decision_id, entity_type, entity_id, relation, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.decision_id,
        params.entity_type,
        params.entity_id,
        params.relation,
        stableStringify(params.details ?? {})
      );
    return { id, created_at: createdAt };
  }

  openIncident(params: {
    severity: string;
    title: string;
    summary: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { incident_id: string; event_id: string; created_at: string } {
    const incidentId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO incidents (
          incident_id, created_at, updated_at, severity, status, title, summary,
          tags_json, source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        incidentId,
        now,
        now,
        params.severity,
        params.title,
        params.summary,
        stableStringify(params.tags ?? []),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const event = this.appendIncidentEvent({
      incident_id: incidentId,
      event_type: "opened",
      summary: params.summary,
      details: { severity: params.severity, title: params.title },
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
    });

    return { incident_id: incidentId, event_id: event.id, created_at: now };
  }

  appendIncidentEvent(params: {
    incident_id: string;
    event_type: string;
    summary: string;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO incident_events (
          id, created_at, incident_id, event_type, summary, details_json,
          source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.incident_id,
        params.event_type,
        params.summary,
        stableStringify(params.details ?? {}),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    this.db
      .prepare(`UPDATE incidents SET updated_at = ? WHERE incident_id = ?`)
      .run(createdAt, params.incident_id);

    this.appendRuntimeEvent({
      event_type: `incident.${params.event_type.trim() || "event"}`,
      entity_type: "incident",
      entity_id: params.incident_id,
      summary: params.summary,
      details: params.details ?? {},
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
      created_at: createdAt,
    });

    return { id, created_at: createdAt };
  }

  appendRuntimeEvent(params: {
    event_id?: string;
    created_at?: string;
    event_type: string;
    entity_type?: string | null;
    entity_id?: string | null;
    status?: string | null;
    summary?: string | null;
    content?: string | null;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): RuntimeEventRecord {
    const eventType = params.event_type.trim();
    if (!eventType) {
      throw new Error("event_type is required");
    }
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const eventId = params.event_id?.trim() || crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO runtime_events (
           event_id, created_at, event_type, entity_type, entity_id, status, summary, content, details_json,
           source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        createdAt,
        eventType,
        params.entity_type?.trim() || null,
        params.entity_id?.trim() || null,
        params.status?.trim() || null,
        params.summary?.trim() || null,
        params.content ?? null,
        stableStringify(params.details ?? {}),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const row = this.db
      .prepare(
        `SELECT event_seq, event_id, created_at, event_type, entity_type, entity_id, status, summary, content, details_json,
                source_client, source_model, source_agent
         FROM runtime_events
         WHERE event_id = ?`
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read runtime event after insert: ${eventId}`);
    }
    return mapRuntimeEventRow(row);
  }

  listRuntimeEvents(params?: {
    entity_type?: string;
    entity_id?: string;
    source_agent?: string;
    source_client?: string;
    event_type?: string;
    event_types?: string[];
    since_seq?: number;
    since?: string;
    limit?: number;
  }): RuntimeEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const entityType = params?.entity_type?.trim();
    if (entityType) {
      whereClauses.push("entity_type = ?");
      values.push(entityType);
    }
    const entityId = params?.entity_id?.trim();
    if (entityId) {
      whereClauses.push("entity_id = ?");
      values.push(entityId);
    }
    const sourceAgent = params?.source_agent?.trim();
    if (sourceAgent) {
      whereClauses.push("source_agent = ?");
      values.push(sourceAgent);
    }
    const sourceClient = params?.source_client?.trim();
    if (sourceClient) {
      whereClauses.push("source_client = ?");
      values.push(sourceClient);
    }
    const eventTypes = [
      ...(params?.event_type?.trim() ? [params.event_type.trim()] : []),
      ...((params?.event_types ?? []).map((entry) => entry.trim()).filter(Boolean)),
    ];
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }
    const sinceSeq = parseBoundedInt(params?.since_seq, 0, 0, Number.MAX_SAFE_INTEGER);
    if (sinceSeq > 0) {
      whereClauses.push("event_seq > ?");
      values.push(sinceSeq);
    }
    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }

    const limit = parseBoundedInt(params?.limit, 200, 1, 5000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_seq, event_id, created_at, event_type, entity_type, entity_id, status, summary, content, details_json,
                source_client, source_model, source_agent
         FROM runtime_events
         ${whereSql}
         ORDER BY event_seq DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapRuntimeEventRow(row));
  }

  summarizeRuntimeEvents(params?: {
    entity_type?: string;
    entity_id?: string;
    source_agent?: string;
    source_client?: string;
    event_type?: string;
    event_types?: string[];
    since?: string;
  }) {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const entityType = params?.entity_type?.trim();
    if (entityType) {
      whereClauses.push("entity_type = ?");
      values.push(entityType);
    }
    const entityId = params?.entity_id?.trim();
    if (entityId) {
      whereClauses.push("entity_id = ?");
      values.push(entityId);
    }
    const sourceAgent = params?.source_agent?.trim();
    if (sourceAgent) {
      whereClauses.push("source_agent = ?");
      values.push(sourceAgent);
    }
    const sourceClient = params?.source_client?.trim();
    if (sourceClient) {
      whereClauses.push("source_client = ?");
      values.push(sourceClient);
    }
    const eventTypes = [
      ...(params?.event_type?.trim() ? [params.event_type.trim()] : []),
      ...((params?.event_types ?? []).map((entry) => entry.trim()).filter(Boolean)),
    ];
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }
    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(event_seq) AS max_seq, MAX(created_at) AS latest_created_at
         FROM runtime_events
         ${whereSql}`
      )
      .get(...values) as Record<string, unknown> | undefined;
    const eventTypeRows = this.db
      .prepare(
        `SELECT event_type, COUNT(*) AS count
         FROM runtime_events
         ${whereSql}
         GROUP BY event_type
         ORDER BY count DESC, event_type ASC`
      )
      .all(...values) as Array<Record<string, unknown>>;
    const entityTypeRows = this.db
      .prepare(
        `SELECT entity_type, COUNT(*) AS count
         FROM runtime_events
         ${whereSql}
         GROUP BY entity_type
         ORDER BY count DESC, entity_type ASC`
      )
      .all(...values) as Array<Record<string, unknown>>;

    return {
      count: Number(countRow?.count ?? 0),
      max_event_seq: Number(countRow?.max_seq ?? 0),
      latest_created_at: asNullableString(countRow?.latest_created_at),
      event_type_counts: eventTypeRows.map((row) => ({
        event_type: String(row.event_type ?? ""),
        count: Number(row.count ?? 0),
      })),
      entity_type_counts: entityTypeRows.map((row) => ({
        entity_type: asNullableString(row.entity_type),
        count: Number(row.count ?? 0),
      })),
    };
  }

  upsertObservabilityDocument(params: {
    document_id?: string;
    created_at?: string;
    updated_at?: string;
    index_name: string;
    source_kind: string;
    source_ref?: string | null;
    level?: ObservabilityLevel | null;
    host_id?: string | null;
    service?: string | null;
    event_type?: string | null;
    title?: string | null;
    body_text?: string | null;
    attributes?: Record<string, unknown>;
    tags?: string[];
  }): ObservabilityDocumentRecord {
    const indexName = params.index_name.trim();
    if (!indexName) {
      throw new Error("index_name is required");
    }
    const sourceKind = params.source_kind.trim();
    if (!sourceKind) {
      throw new Error("source_kind is required");
    }
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const updatedAt = normalizeIsoTimestamp(params.updated_at, createdAt);
    const documentId = params.document_id?.trim() || crypto.randomUUID();
    const levelRaw = asNullableString(params.level);
    const level =
      levelRaw === "trace" ||
      levelRaw === "debug" ||
      levelRaw === "info" ||
      levelRaw === "warn" ||
      levelRaw === "error" ||
      levelRaw === "critical"
        ? levelRaw
        : null;
    this.db
      .prepare(
        `INSERT INTO observability_documents (
           document_id, created_at, updated_at, index_name, source_kind, source_ref, level, host_id, service,
           event_type, title, body_text, attributes_json, tags_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           index_name = excluded.index_name,
           source_kind = excluded.source_kind,
           source_ref = excluded.source_ref,
           level = excluded.level,
           host_id = excluded.host_id,
           service = excluded.service,
           event_type = excluded.event_type,
           title = excluded.title,
           body_text = excluded.body_text,
           attributes_json = excluded.attributes_json,
           tags_json = excluded.tags_json`
      )
      .run(
        documentId,
        createdAt,
        updatedAt,
        indexName,
        sourceKind,
        params.source_ref?.trim() || null,
        level,
        params.host_id?.trim() || null,
        params.service?.trim() || null,
        params.event_type?.trim() || null,
        params.title?.trim() || null,
        params.body_text?.trim() || "",
        stableStringify(params.attributes ?? {}),
        stableStringify([...(params.tags ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean)])
      );

    const row = this.db
      .prepare(
        `SELECT document_id, created_at, updated_at, index_name, source_kind, source_ref, level, host_id, service,
                event_type, title, body_text, attributes_json, tags_json
         FROM observability_documents
         WHERE document_id = ?`
      )
      .get(documentId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read observability document after upsert: ${documentId}`);
    }
    return mapObservabilityDocumentRow(row);
  }

  listObservabilityDocuments(params?: {
    index_names?: string[];
    source_kind?: string;
    source_ref?: string;
    host_id?: string;
    service?: string;
    levels?: string[];
    event_types?: string[];
    tags?: string[];
    since?: string;
    limit?: number;
  }): ObservabilityDocumentRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const indexNames = (params?.index_names ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (indexNames.length > 0) {
      const placeholders = indexNames.map(() => "?").join(", ");
      whereClauses.push(`index_name IN (${placeholders})`);
      values.push(...indexNames);
    }
    const sourceKind = params?.source_kind?.trim();
    if (sourceKind) {
      whereClauses.push("source_kind = ?");
      values.push(sourceKind);
    }
    const sourceRef = params?.source_ref?.trim();
    if (sourceRef) {
      whereClauses.push("source_ref = ?");
      values.push(sourceRef);
    }
    const hostId = params?.host_id?.trim();
    if (hostId) {
      whereClauses.push("host_id = ?");
      values.push(hostId);
    }
    const service = params?.service?.trim();
    if (service) {
      whereClauses.push("service = ?");
      values.push(service);
    }
    const levels = (params?.levels ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (levels.length > 0) {
      const placeholders = levels.map(() => "?").join(", ");
      whereClauses.push(`level IN (${placeholders})`);
      values.push(...levels);
    }
    const eventTypes = (params?.event_types ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }
    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }
    const tags = [...new Set((params?.tags ?? []).map((entry) => entry.trim()).filter(Boolean))];
    if (tags.length > 0) {
      for (const tag of tags) {
        whereClauses.push("tags_json LIKE ?");
        values.push(`%\"${tag.replace(/[%_]/g, "\\$&")}\"%`);
      }
    }

    const limit = parseBoundedInt(params?.limit, 100, 1, 5000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT document_id, created_at, updated_at, index_name, source_kind, source_ref, level, host_id, service,
                event_type, title, body_text, attributes_json, tags_json
         FROM observability_documents
         ${whereSql}
         ORDER BY created_at DESC, document_id ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapObservabilityDocumentRow(row));
  }

  searchObservabilityDocuments(params?: {
    query?: string;
    index_names?: string[];
    source_kind?: string;
    source_ref?: string;
    host_id?: string;
    service?: string;
    levels?: string[];
    event_types?: string[];
    tags?: string[];
    since?: string;
    limit?: number;
  }): ObservabilitySearchHit[] {
    const query = params?.query?.trim();
    const limit = parseBoundedInt(params?.limit, 50, 1, 500);
    const candidates = this.listObservabilityDocuments({
      index_names: params?.index_names,
      source_kind: params?.source_kind,
      source_ref: params?.source_ref,
      host_id: params?.host_id,
      service: params?.service,
      levels: params?.levels,
      event_types: params?.event_types,
      tags: params?.tags,
      since: params?.since,
      limit: query ? Math.max(limit * 5, 100) : limit,
    });
    if (!query) {
      return candidates.slice(0, limit).map((document) => ({
        score: 0,
        match_reason: "latest",
        document,
      }));
    }
    const hits = candidates
      .map((document) => {
        const haystack = [
          document.index_name,
          document.source_kind,
          document.source_ref ?? "",
          document.host_id ?? "",
          document.service ?? "",
          document.event_type ?? "",
          document.title ?? "",
          document.body_text,
          ...document.tags,
          stableStringify(document.attributes),
        ].join(" ");
        const score = computeTermScore(haystack, query);
        return {
          score,
          match_reason: score > 0 ? "term_match" : "no_match",
          document,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return right.document.created_at.localeCompare(left.document.created_at);
      });
    return hits.slice(0, limit);
  }

  summarizeObservabilityDocuments(params?: {
    index_names?: string[];
    source_kind?: string;
    host_id?: string;
    service?: string;
    levels?: string[];
    event_types?: string[];
    since?: string;
  }) {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const indexNames = (params?.index_names ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (indexNames.length > 0) {
      const placeholders = indexNames.map(() => "?").join(", ");
      whereClauses.push(`index_name IN (${placeholders})`);
      values.push(...indexNames);
    }
    const sourceKind = params?.source_kind?.trim();
    if (sourceKind) {
      whereClauses.push("source_kind = ?");
      values.push(sourceKind);
    }
    const hostId = params?.host_id?.trim();
    if (hostId) {
      whereClauses.push("host_id = ?");
      values.push(hostId);
    }
    const service = params?.service?.trim();
    if (service) {
      whereClauses.push("service = ?");
      values.push(service);
    }
    const levels = (params?.levels ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (levels.length > 0) {
      const placeholders = levels.map(() => "?").join(", ");
      whereClauses.push(`level IN (${placeholders})`);
      values.push(...levels);
    }
    const eventTypes = (params?.event_types ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }
    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at
         FROM observability_documents
         ${whereSql}`
      )
      .get(...values) as Record<string, unknown> | undefined;
    const buildCounts = (column: string, alias: string) =>
      this.db
        .prepare(
          `SELECT ${column} AS ${alias}, COUNT(*) AS count
           FROM observability_documents
           ${whereSql}
           GROUP BY ${column}
           ORDER BY count DESC, ${column} ASC`
        )
        .all(...values) as Array<Record<string, unknown>>;
    const indexRows = buildCounts("index_name", "index_name");
    const sourceRows = buildCounts("source_kind", "source_kind");
    const levelRows = buildCounts("level", "level");
    const serviceRows = buildCounts("service", "service");
    const hostRows = buildCounts("host_id", "host_id");
    const eventTypeRows = buildCounts("event_type", "event_type");
    return {
      count: Number(countRow?.count ?? 0),
      latest_created_at: asNullableString(countRow?.latest_created_at),
      index_name_counts: indexRows.map((row) => ({
        index_name: String(row.index_name ?? ""),
        count: Number(row.count ?? 0),
      })),
      source_kind_counts: sourceRows.map((row) => ({
        source_kind: String(row.source_kind ?? ""),
        count: Number(row.count ?? 0),
      })),
      level_counts: levelRows.map((row) => ({
        level: asNullableString(row.level),
        count: Number(row.count ?? 0),
      })),
      service_counts: serviceRows.map((row) => ({
        service: asNullableString(row.service),
        count: Number(row.count ?? 0),
      })),
      host_counts: hostRows.map((row) => ({
        host_id: asNullableString(row.host_id),
        count: Number(row.count ?? 0),
      })),
      event_type_counts: eventTypeRows.map((row) => ({
        event_type: asNullableString(row.event_type),
        count: Number(row.count ?? 0),
      })),
    };
  }

  getIncidentTimeline(incidentId: string, limit: number): {
    incident: IncidentRecord | null;
    events: IncidentEventRecord[];
  } {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const incidentRow = this.db
      .prepare(
        `SELECT incident_id, created_at, updated_at, severity, status, title, summary,
                tags_json, source_client, source_model, source_agent
         FROM incidents
         WHERE incident_id = ?`
      )
      .get(incidentId) as Record<string, unknown> | undefined;

    if (!incidentRow) {
      return { incident: null, events: [] };
    }

    const eventRows = this.db
      .prepare(
        `SELECT id, created_at, incident_id, event_type, summary, details_json,
                source_client, source_model, source_agent
         FROM incident_events
         WHERE incident_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(incidentId, boundedLimit) as Array<Record<string, unknown>>;

    const incident: IncidentRecord = {
      incident_id: String(incidentRow.incident_id),
      created_at: String(incidentRow.created_at),
      updated_at: String(incidentRow.updated_at),
      severity: String(incidentRow.severity),
      status: String(incidentRow.status),
      title: String(incidentRow.title),
      summary: String(incidentRow.summary),
      source_client: asNullableString(incidentRow.source_client),
      source_model: asNullableString(incidentRow.source_model),
      source_agent: asNullableString(incidentRow.source_agent),
      tags: safeParseJsonArray(incidentRow.tags_json),
    };

    const events = eventRows
      .map((row) => ({
        id: String(row.id),
        created_at: String(row.created_at),
        incident_id: String(row.incident_id),
        event_type: String(row.event_type),
        summary: String(row.summary),
        details: parseJsonObject(row.details_json),
        source_client: asNullableString(row.source_client),
        source_model: asNullableString(row.source_model),
        source_agent: asNullableString(row.source_agent),
      }))
      .reverse();

    return { incident, events };
  }

  getPermissionProfilesState(): PermissionProfilesStateRecord {
    const row = this.db
      .prepare(
        `SELECT config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("session.permission_profiles") as Record<string, unknown> | undefined;

    if (!row) {
      return getDefaultPermissionProfilesState();
    }
    return normalizePermissionProfilesState(parseJsonObject(row.config_json), String(row.updated_at ?? "") || null);
  }

  setPermissionProfilesState(params: {
    default_profile?: string;
    profiles?: unknown[];
  }): PermissionProfilesStateRecord {
    const now = new Date().toISOString();
    const existing = this.getPermissionProfilesState();
    const normalized = normalizePermissionProfilesState(
      {
        default_profile: params.default_profile ?? existing.default_profile,
        profiles: params.profiles ?? existing.profiles,
      },
      now
    );
    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "session.permission_profiles",
        stableStringify({
          default_profile: normalized.default_profile,
          profiles: normalized.profiles,
        }),
        now
      );
    return {
      ...normalized,
      updated_at: now,
      source: "persisted",
    };
  }

  getFeatureFlagState(): FeatureFlagStateRecord {
    const row = this.db
      .prepare(
        `SELECT config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("feature.flags") as Record<string, unknown> | undefined;

    if (!row) {
      return getDefaultFeatureFlagState();
    }
    return normalizeFeatureFlagState(parseJsonObject(row.config_json), String(row.updated_at ?? "") || null);
  }

  setFeatureFlagState(params: {
    flags?: unknown[];
  }): FeatureFlagStateRecord {
    const now = new Date().toISOString();
    const existing = this.getFeatureFlagState();
    const normalized = normalizeFeatureFlagState(
      {
        flags: params.flags ?? existing.flags,
      },
      now
    );
    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "feature.flags",
        stableStringify({
          flags: normalized.flags,
        }),
        now
      );
    return {
      ...normalized,
      updated_at: now,
      source: "persisted",
    };
  }

  getWarmCacheState(): WarmCacheStateRecord {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("warm.cache") as Record<string, unknown> | undefined;

    if (!row) {
      return getDefaultWarmCacheState();
    }
    return normalizeWarmCacheState(
      {
        ...parseJsonObject(row.config_json),
        enabled: Number(row.enabled ?? 0) === 1,
      },
      String(row.updated_at ?? "") || null
    );
  }

  setWarmCacheState(params: {
    enabled?: boolean;
    startup_prefetch?: boolean;
    interval_seconds?: number;
    ttl_seconds?: number;
    thread_id?: string;
    last_run_at?: string | null;
    last_error?: string | null;
    last_duration_ms?: number | null;
    run_count?: number;
    warmed_targets?: string[];
  }): WarmCacheStateRecord {
    const now = new Date().toISOString();
    const existing = this.getWarmCacheState();
    const normalized = normalizeWarmCacheState(
      {
        enabled: params.enabled ?? existing.enabled,
        startup_prefetch: params.startup_prefetch ?? existing.startup_prefetch,
        interval_seconds: params.interval_seconds ?? existing.interval_seconds,
        ttl_seconds: params.ttl_seconds ?? existing.ttl_seconds,
        thread_id: params.thread_id ?? existing.thread_id,
        last_run_at: params.last_run_at === undefined ? existing.last_run_at : params.last_run_at,
        last_error: params.last_error === undefined ? existing.last_error : params.last_error,
        last_duration_ms: params.last_duration_ms === undefined ? existing.last_duration_ms : params.last_duration_ms,
        run_count: params.run_count ?? existing.run_count,
        warmed_targets: params.warmed_targets ?? existing.warmed_targets,
      },
      now
    );
    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "warm.cache",
        normalized.enabled ? 1 : 0,
        stableStringify({
          startup_prefetch: normalized.startup_prefetch,
          interval_seconds: normalized.interval_seconds,
          ttl_seconds: normalized.ttl_seconds,
          thread_id: normalized.thread_id,
          last_run_at: normalized.last_run_at,
          last_error: normalized.last_error,
          last_duration_ms: normalized.last_duration_ms,
          run_count: normalized.run_count,
          warmed_targets: normalized.warmed_targets,
        }),
        now
      );
    return {
      ...normalized,
      updated_at: now,
      source: "persisted",
    };
  }

  getDesktopControlState(): DesktopControlStateRecord {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("desktop.control") as Record<string, unknown> | undefined;

    if (!row) {
      return getDefaultDesktopControlState();
    }
    return normalizeDesktopControlState(
      {
        ...parseJsonObject(row.config_json),
        enabled: Number(row.enabled ?? 0) === 1,
      },
      String(row.updated_at ?? "") || null
    );
  }

  setDesktopControlState(params: {
    enabled?: boolean;
    allow_observe?: boolean;
    allow_act?: boolean;
    allow_listen?: boolean;
    screenshot_dir?: string;
    action_timeout_ms?: number;
    listen_max_seconds?: number;
    heartbeat_interval_seconds?: number;
    last_heartbeat_at?: string | null;
    last_observation_at?: string | null;
    last_screenshot_at?: string | null;
    last_action_at?: string | null;
    last_listen_at?: string | null;
    last_frontmost_app?: string | null;
    last_frontmost_window?: string | null;
    last_error?: string | null;
    capability_probe?: Record<string, unknown>;
  }): DesktopControlStateRecord {
    const now = new Date().toISOString();
    const existing = this.getDesktopControlState();
    const normalized = normalizeDesktopControlState(
      {
        enabled: params.enabled ?? existing.enabled,
        allow_observe: params.allow_observe ?? existing.allow_observe,
        allow_act: params.allow_act ?? existing.allow_act,
        allow_listen: params.allow_listen ?? existing.allow_listen,
        screenshot_dir: params.screenshot_dir ?? existing.screenshot_dir,
        action_timeout_ms: params.action_timeout_ms ?? existing.action_timeout_ms,
        listen_max_seconds: params.listen_max_seconds ?? existing.listen_max_seconds,
        heartbeat_interval_seconds: params.heartbeat_interval_seconds ?? existing.heartbeat_interval_seconds,
        last_heartbeat_at: params.last_heartbeat_at === undefined ? existing.last_heartbeat_at : params.last_heartbeat_at,
        last_observation_at:
          params.last_observation_at === undefined ? existing.last_observation_at : params.last_observation_at,
        last_screenshot_at:
          params.last_screenshot_at === undefined ? existing.last_screenshot_at : params.last_screenshot_at,
        last_action_at: params.last_action_at === undefined ? existing.last_action_at : params.last_action_at,
        last_listen_at: params.last_listen_at === undefined ? existing.last_listen_at : params.last_listen_at,
        last_frontmost_app:
          params.last_frontmost_app === undefined ? existing.last_frontmost_app : params.last_frontmost_app,
        last_frontmost_window:
          params.last_frontmost_window === undefined ? existing.last_frontmost_window : params.last_frontmost_window,
        last_error: params.last_error === undefined ? existing.last_error : params.last_error,
        capability_probe: params.capability_probe ?? existing.capability_probe,
      },
      now
    );
    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "desktop.control",
        normalized.enabled ? 1 : 0,
        stableStringify({
          allow_observe: normalized.allow_observe,
          allow_act: normalized.allow_act,
          allow_listen: normalized.allow_listen,
          screenshot_dir: normalized.screenshot_dir,
          action_timeout_ms: normalized.action_timeout_ms,
          listen_max_seconds: normalized.listen_max_seconds,
          heartbeat_interval_seconds: normalized.heartbeat_interval_seconds,
          last_heartbeat_at: normalized.last_heartbeat_at,
          last_observation_at: normalized.last_observation_at,
          last_screenshot_at: normalized.last_screenshot_at,
          last_action_at: normalized.last_action_at,
          last_listen_at: normalized.last_listen_at,
          last_frontmost_app: normalized.last_frontmost_app,
          last_frontmost_window: normalized.last_frontmost_window,
          last_error: normalized.last_error,
          capability_probe: normalized.capability_probe,
        }),
        now
      );
    return {
      ...normalized,
      updated_at: now,
      source: "persisted",
    };
  }

  getPatientZeroState(): PatientZeroStateRecord {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("patient.zero") as Record<string, unknown> | undefined;

    if (!row) {
      return getDefaultPatientZeroState();
    }
    return normalizePatientZeroState(
      {
        ...parseJsonObject(row.config_json),
        enabled: Number(row.enabled ?? 0) === 1,
      },
      String(row.updated_at ?? "") || null
    );
  }

  setPatientZeroState(params: {
    enabled?: boolean;
    autonomy_enabled?: boolean;
    allow_observe?: boolean;
    allow_act?: boolean;
    allow_listen?: boolean;
    browser_app?: string;
    root_shell_reason?: string;
    audit_required?: boolean;
    armed_at?: string | null;
    armed_by?: string | null;
    disarmed_at?: string | null;
    disarmed_by?: string | null;
    last_operator_note?: string | null;
  }): PatientZeroStateRecord {
    const now = new Date().toISOString();
    const existing = this.getPatientZeroState();
    const normalized = normalizePatientZeroState(
      {
        enabled: params.enabled ?? existing.enabled,
        autonomy_enabled: params.autonomy_enabled ?? existing.autonomy_enabled,
        allow_observe: params.allow_observe ?? existing.allow_observe,
        allow_act: params.allow_act ?? existing.allow_act,
        allow_listen: params.allow_listen ?? existing.allow_listen,
        browser_app: params.browser_app ?? existing.browser_app,
        root_shell_reason: params.root_shell_reason ?? existing.root_shell_reason,
        audit_required: params.audit_required ?? existing.audit_required,
        armed_at: params.armed_at === undefined ? existing.armed_at : params.armed_at,
        armed_by: params.armed_by === undefined ? existing.armed_by : params.armed_by,
        disarmed_at: params.disarmed_at === undefined ? existing.disarmed_at : params.disarmed_at,
        disarmed_by: params.disarmed_by === undefined ? existing.disarmed_by : params.disarmed_by,
        last_operator_note:
          params.last_operator_note === undefined ? existing.last_operator_note : params.last_operator_note,
      },
      now
    );
    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "patient.zero",
        normalized.enabled ? 1 : 0,
        stableStringify({
          autonomy_enabled: normalized.autonomy_enabled,
          allow_observe: normalized.allow_observe,
          allow_act: normalized.allow_act,
          allow_listen: normalized.allow_listen,
          browser_app: normalized.browser_app,
          root_shell_reason: normalized.root_shell_reason,
          audit_required: normalized.audit_required,
          armed_at: normalized.armed_at,
          armed_by: normalized.armed_by,
          disarmed_at: normalized.disarmed_at,
          disarmed_by: normalized.disarmed_by,
          last_operator_note: normalized.last_operator_note,
        }),
        now
      );
    return {
      ...normalized,
      updated_at: now,
      source: "persisted",
    };
  }

  getPrivilegedAccessState(): PrivilegedAccessStateRecord {
    const row = this.db
      .prepare(
        `SELECT config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("privileged.access") as Record<string, unknown> | undefined;
    if (!row) {
      return getDefaultPrivilegedAccessState();
    }
    return normalizePrivilegedAccessState(parseJsonObject(row.config_json), String(row.updated_at ?? "") || null);
  }

  setPrivilegedAccessState(params: {
    account?: string;
    secret_path?: string;
    audit_required?: boolean;
    last_verified_at?: string | null;
    last_verification_ok?: boolean | null;
    last_verification_error?: string | null;
    last_secret_fingerprint?: string | null;
    last_executed_at?: string | null;
    last_actor?: string | null;
    last_command?: string | null;
    last_exit_code?: number | null;
    last_error?: string | null;
  }): PrivilegedAccessStateRecord {
    const now = new Date().toISOString();
    const existing = this.getPrivilegedAccessState();
    const normalized = normalizePrivilegedAccessState(
      {
        account: params.account ?? existing.account,
        secret_path: params.secret_path ?? existing.secret_path,
        audit_required: params.audit_required ?? existing.audit_required,
        last_verified_at: params.last_verified_at === undefined ? existing.last_verified_at : params.last_verified_at,
        last_verification_ok:
          params.last_verification_ok === undefined ? existing.last_verification_ok : params.last_verification_ok,
        last_verification_error:
          params.last_verification_error === undefined
            ? existing.last_verification_error
            : params.last_verification_error,
        last_secret_fingerprint:
          params.last_secret_fingerprint === undefined ? existing.last_secret_fingerprint : params.last_secret_fingerprint,
        last_executed_at: params.last_executed_at === undefined ? existing.last_executed_at : params.last_executed_at,
        last_actor: params.last_actor === undefined ? existing.last_actor : params.last_actor,
        last_command: params.last_command === undefined ? existing.last_command : params.last_command,
        last_exit_code: params.last_exit_code === undefined ? existing.last_exit_code : params.last_exit_code,
        last_error: params.last_error === undefined ? existing.last_error : params.last_error,
      },
      now
    );
    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(
        "privileged.access",
        1,
        stableStringify({
          account: normalized.account,
          secret_path: normalized.secret_path,
          audit_required: normalized.audit_required,
          last_verified_at: normalized.last_verified_at,
          last_verification_ok: normalized.last_verification_ok,
          last_verification_error: normalized.last_verification_error,
          last_secret_fingerprint: normalized.last_secret_fingerprint,
          last_executed_at: normalized.last_executed_at,
          last_actor: normalized.last_actor,
          last_command: normalized.last_command,
          last_exit_code: normalized.last_exit_code,
          last_error: normalized.last_error,
        }),
        now
      );
    return {
      ...normalized,
      updated_at: now,
      source: "persisted",
    };
  }

  appendBudgetLedgerEntry(params: {
    entry_id?: string;
    created_at?: string;
    ledger_kind: "projection" | "actual" | "adjustment";
    entity_type?: string | null;
    entity_id?: string | null;
    run_id?: string | null;
    task_id?: string | null;
    goal_id?: string | null;
    plan_id?: string | null;
    session_id?: string | null;
    provider?: string | null;
    model_id?: string | null;
    tokens_input?: number | null;
    tokens_output?: number | null;
    tokens_total?: number | null;
    projected_cost_usd?: number | null;
    actual_cost_usd?: number | null;
    currency?: string | null;
    notes?: string | null;
    metadata?: Record<string, unknown>;
    source_client?: string | null;
    source_model?: string | null;
    source_agent?: string | null;
  }): BudgetLedgerEntryRecord {
    const entryId = params.entry_id?.trim() || crypto.randomUUID();
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const normalizeCount = (value: number | null | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
    const normalizeCost = (value: number | null | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(6)) : null;
    const tokensInput = normalizeCount(params.tokens_input);
    const tokensOutput = normalizeCount(params.tokens_output);
    const tokensTotal = normalizeCount(params.tokens_total) ?? (tokensInput !== null || tokensOutput !== null ? (tokensInput ?? 0) + (tokensOutput ?? 0) : null);
    this.db
      .prepare(
        `INSERT INTO budget_ledger_entries (
           entry_id, created_at, ledger_kind, entity_type, entity_id, run_id, task_id, goal_id, plan_id, session_id,
           provider, model_id, tokens_input, tokens_output, tokens_total, projected_cost_usd, actual_cost_usd,
           currency, notes, metadata_json, source_client, source_model, source_agent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entryId,
        createdAt,
        params.ledger_kind,
        params.entity_type?.trim() || null,
        params.entity_id?.trim() || null,
        params.run_id?.trim() || null,
        params.task_id?.trim() || null,
        params.goal_id?.trim() || null,
        params.plan_id?.trim() || null,
        params.session_id?.trim() || null,
        params.provider?.trim() || null,
        params.model_id?.trim() || null,
        tokensInput,
        tokensOutput,
        tokensTotal,
        normalizeCost(params.projected_cost_usd),
        normalizeCost(params.actual_cost_usd),
        params.currency?.trim().toUpperCase() || "USD",
        params.notes?.trim() || null,
        stableStringify(params.metadata ?? {}),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );
    const row = this.db
      .prepare(
        `SELECT entry_id, created_at, ledger_kind, entity_type, entity_id, run_id, task_id, goal_id, plan_id, session_id,
                provider, model_id, tokens_input, tokens_output, tokens_total, projected_cost_usd, actual_cost_usd,
                currency, notes, metadata_json, source_client, source_model, source_agent
         FROM budget_ledger_entries
         WHERE entry_id = ?`
      )
      .get(entryId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read budget ledger entry after insert: ${entryId}`);
    }
    return mapBudgetLedgerRow(row);
  }

  listBudgetLedgerEntries(params: {
    ledger_kind?: "projection" | "actual" | "adjustment";
    run_id?: string;
    task_id?: string;
    provider?: string;
    model_id?: string;
    entity_type?: string;
    entity_id?: string;
    since?: string;
    limit: number;
  }): BudgetLedgerEntryRecord[] {
    const { whereSql, values } = buildBudgetLedgerWhereClause(params);
    const limit = Math.max(1, Math.min(500, params.limit));
    const rows = this.db
      .prepare(
        `SELECT entry_id, created_at, ledger_kind, entity_type, entity_id, run_id, task_id, goal_id, plan_id, session_id,
                provider, model_id, tokens_input, tokens_output, tokens_total, projected_cost_usd, actual_cost_usd,
                currency, notes, metadata_json, source_client, source_model, source_agent
         FROM budget_ledger_entries
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapBudgetLedgerRow(row));
  }

  summarizeBudgetLedger(params: {
    ledger_kind?: "projection" | "actual" | "adjustment";
    run_id?: string;
    task_id?: string;
    provider?: string;
    model_id?: string;
    entity_type?: string;
    entity_id?: string;
    since?: string;
    recent_limit?: number;
  }): BudgetLedgerSummaryRecord {
    const { whereSql, values } = buildBudgetLedgerWhereClause(params);
    const totalsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total_entries,
                SUM(CASE WHEN ledger_kind = 'projection' THEN 1 ELSE 0 END) AS projection_count,
                SUM(CASE WHEN ledger_kind = 'actual' THEN 1 ELSE 0 END) AS actual_count,
                SUM(CASE WHEN ledger_kind = 'adjustment' THEN 1 ELSE 0 END) AS adjustment_count,
                SUM(COALESCE(projected_cost_usd, 0)) AS projected_cost_usd,
                SUM(COALESCE(actual_cost_usd, 0)) AS actual_cost_usd,
                SUM(COALESCE(tokens_input, 0)) AS tokens_input,
                SUM(COALESCE(tokens_output, 0)) AS tokens_output,
                SUM(COALESCE(tokens_total, 0)) AS tokens_total,
                MAX(created_at) AS latest_entry_at
         FROM budget_ledger_entries
         ${whereSql}`
      )
      .get(...values) as Record<string, unknown>;

    const providerRows = this.db
      .prepare(
        `SELECT provider,
                COUNT(*) AS count,
                SUM(COALESCE(projected_cost_usd, 0)) AS projected_cost_usd,
                SUM(COALESCE(actual_cost_usd, 0)) AS actual_cost_usd
         FROM budget_ledger_entries
         ${whereSql}
         GROUP BY provider
         ORDER BY count DESC, provider ASC
         LIMIT 20`
      )
      .all(...values) as Array<Record<string, unknown>>;

    const modelRows = this.db
      .prepare(
        `SELECT model_id,
                COUNT(*) AS count,
                SUM(COALESCE(projected_cost_usd, 0)) AS projected_cost_usd,
                SUM(COALESCE(actual_cost_usd, 0)) AS actual_cost_usd
         FROM budget_ledger_entries
         ${whereSql}
         GROUP BY model_id
         ORDER BY count DESC, model_id ASC
         LIMIT 20`
      )
      .all(...values) as Array<Record<string, unknown>>;

    const entityRows = this.db
      .prepare(
        `SELECT entity_type, COUNT(*) AS count
         FROM budget_ledger_entries
         ${whereSql}
         GROUP BY entity_type
         ORDER BY count DESC, entity_type ASC
         LIMIT 20`
      )
      .all(...values) as Array<Record<string, unknown>>;

    const recentEntries = this.listBudgetLedgerEntries({
      ...params,
      limit: params.recent_limit ?? 10,
    });

    return {
      total_entries: Number(totalsRow.total_entries ?? 0),
      projection_count: Number(totalsRow.projection_count ?? 0),
      actual_count: Number(totalsRow.actual_count ?? 0),
      adjustment_count: Number(totalsRow.adjustment_count ?? 0),
      projected_cost_usd: Number(Number(totalsRow.projected_cost_usd ?? 0).toFixed(6)),
      actual_cost_usd: Number(Number(totalsRow.actual_cost_usd ?? 0).toFixed(6)),
      tokens_input: Number(totalsRow.tokens_input ?? 0),
      tokens_output: Number(totalsRow.tokens_output ?? 0),
      tokens_total: Number(totalsRow.tokens_total ?? 0),
      provider_counts: providerRows.map((row) => ({
        provider: asNullableString(row.provider),
        count: Number(row.count ?? 0),
        projected_cost_usd: Number(Number(row.projected_cost_usd ?? 0).toFixed(6)),
        actual_cost_usd: Number(Number(row.actual_cost_usd ?? 0).toFixed(6)),
      })),
      model_counts: modelRows.map((row) => ({
        model_id: asNullableString(row.model_id),
        count: Number(row.count ?? 0),
        projected_cost_usd: Number(Number(row.projected_cost_usd ?? 0).toFixed(6)),
        actual_cost_usd: Number(Number(row.actual_cost_usd ?? 0).toFixed(6)),
      })),
      entity_type_counts: entityRows.map((row) => ({
        entity_type: asNullableString(row.entity_type),
        count: Number(row.count ?? 0),
      })),
      latest_entry_at: asNullableString(totalsRow.latest_entry_at),
      recent_entries: recentEntries,
    };
  }

  insertAdr(params: {
    id: string;
    title: string;
    status: string;
    content: string;
  }): { id: string } {
    this.db
      .prepare(`INSERT INTO adrs (id, title, status, content) VALUES (?, ?, ?, ?)`)
      .run(params.id, params.title, params.status, params.content);
    return { id: params.id };
  }

  getTableCounts(): Record<string, number> {
    const tables = [
      "notes",
      "transcripts",
      "transcript_lines",
      "memories",
      "adrs",
      "mutation_journal",
      "policy_evaluations",
      "run_events",
      "locks",
      "decisions",
      "decision_links",
      "incidents",
      "incident_events",
      "runtime_events",
      "observability_documents",
      "budget_ledger_entries",
      "schema_migrations",
      "daemon_configs",
      "imprint_profiles",
      "imprint_snapshots",
      "tasks",
      "task_events",
      "task_leases",
      "task_artifacts",
      "artifacts",
      "artifact_links",
      "pack_hook_runs",
      "experiments",
      "experiment_runs",
      "agent_sessions",
      "agent_learning_entries",
      "trichat_threads",
      "trichat_messages",
      "trichat_turns",
      "trichat_turn_artifacts",
      "trichat_bus_events",
      "trichat_adapter_states",
      "trichat_adapter_events",
      "trichat_chaos_events",
      "trichat_slo_snapshots",
    ] as const;
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
      counts[table] = Number(row.count ?? 0);
    }
    return counts;
  }

  private ensureMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }

  private applyPendingMigrations(
    migrations: Array<{ version: number; name: string; run: () => void }>
  ): void {
    const appliedVersions = this.getAppliedMigrationVersions();
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      this.applyMigration(migration.version, migration.name, migration.run);
      appliedVersions.add(migration.version);
    }
  }

  private getAppliedMigrationVersions(): Set<number> {
    const rows = this.db
      .prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`)
      .all() as Array<Record<string, unknown>>;
    const versions = new Set<number>();
    for (const row of rows) {
      const version = Number(row.version ?? 0);
      if (Number.isInteger(version) && version > 0) {
        versions.add(version);
      }
    }

    const userVersion = readUserVersion(this.db);
    for (let version = 1; version <= userVersion; version += 1) {
      versions.add(version);
    }
    return versions;
  }

  private applyMigration(version: number, name: string, run: () => void): void {
    const apply = this.db.transaction(() => {
      run();
      const appliedAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`
        )
        .run(version, name, appliedAt);
      this.db.exec(`PRAGMA user_version = ${version}`);
    });
    apply();
  }

  private ensureRuntimeSchemaCompleteness(): void {
    // Defensive schema replay keeps table/index guarantees intact even if
    // migration metadata was partially imported from legacy environments.
    this.applyCoreSchemaMigration();
    this.applyDaemonConfigMigration();
    this.applyImprintSchemaMigration();
    this.applyTaskSchemaMigration();
    this.applyTriChatSchemaMigration();
    this.applyTriChatAdapterTelemetryMigration();
    this.applyTriChatBusMigration();
    this.applyTriChatTurnSchemaMigration();
    this.applyTriChatReliabilitySchemaMigration();
    this.applyAgenticSchemaMigration();
    this.applyAgentSessionsSchemaMigration();
    this.applyAgentLearningSchemaMigration();
    this.applyExperimentSchemaMigration();
    this.applyRuntimeEventBusMigration();
    this.applyRuntimeWorkerSessionSchemaMigration();
    this.applyObservabilitySchemaMigration();
    this.applyBudgetLedgerSchemaMigration();
  }

  private applyCoreSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        source TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        trust_tier TEXT NOT NULL DEFAULT 'raw',
        expires_at TEXT,
        promoted_from_note_id TEXT,
        tags_json TEXT NOT NULL,
        related_paths_json TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_client TEXT NOT NULL,
        source_model TEXT,
        source_agent TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_squished BOOLEAN DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT,
        keywords TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decay_score REAL DEFAULT 1.0
      );
      CREATE TABLE IF NOT EXISTS adrs (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS mutation_journal (
        idempotency_key TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        side_effect_fingerprint TEXT NOT NULL,
        payload_hash TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_evaluations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        policy_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        reason TEXT,
        violations_json TEXT NOT NULL,
        recommendations_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS locks (
        lock_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        consequences TEXT,
        rollback TEXT,
        links_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        run_id TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS decision_links (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS incident_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureColumn("notes", "source_client", "TEXT");
    this.ensureColumn("notes", "source_model", "TEXT");
    this.ensureColumn("notes", "source_agent", "TEXT");
    this.ensureColumn("notes", "trust_tier", "TEXT NOT NULL DEFAULT 'raw'");
    this.ensureColumn("notes", "expires_at", "TEXT");
    this.ensureColumn("notes", "promoted_from_note_id", "TEXT");
    this.ensureColumn("transcripts", "source_model", "TEXT");
    this.ensureColumn("transcripts", "source_agent", "TEXT");

    this.ensureIndex("idx_notes_created", "notes", "created_at DESC");
    this.ensureIndex("idx_notes_trust", "notes", "trust_tier");
    this.ensureIndex("idx_transcripts_session", "transcripts", "session_id, created_at ASC");
    this.ensureIndex("idx_transcript_lines_run", "transcript_lines", "run_id, timestamp ASC");
    this.ensureIndex("idx_transcript_lines_squished", "transcript_lines", "is_squished, timestamp ASC");
    this.ensureIndex("idx_memories_created", "memories", "created_at DESC");
    this.ensureIndex("idx_memories_last_accessed", "memories", "last_accessed_at DESC");
    this.ensureIndex("idx_memories_keywords", "memories", "keywords");
    this.ensureIndex("idx_adrs_status", "adrs", "status");
    this.ensureIndex("idx_run_events_run", "run_events", "run_id, created_at ASC");
    this.ensureIndex("idx_incident_events_incident", "incident_events", "incident_id, created_at ASC");
  }

  private applyDaemonConfigMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_configs (
        daemon_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private applyBudgetLedgerSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget_ledger_entries (
        entry_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        ledger_kind TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        run_id TEXT,
        task_id TEXT,
        goal_id TEXT,
        plan_id TEXT,
        session_id TEXT,
        provider TEXT,
        model_id TEXT,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_total INTEGER,
        projected_cost_usd REAL,
        actual_cost_usd REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        notes TEXT,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_budget_ledger_created", "budget_ledger_entries", "created_at DESC");
    this.ensureIndex("idx_budget_ledger_task", "budget_ledger_entries", "task_id, created_at DESC");
    this.ensureIndex("idx_budget_ledger_run", "budget_ledger_entries", "run_id, created_at DESC");
    this.ensureIndex("idx_budget_ledger_provider", "budget_ledger_entries", "provider, created_at DESC");
    this.ensureIndex("idx_budget_ledger_model", "budget_ledger_entries", "model_id, created_at DESC");
    this.ensureIndex("idx_budget_ledger_entity", "budget_ledger_entries", "entity_type, entity_id, created_at DESC");
  }

  private applyImprintSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imprint_profiles (
        profile_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        mission TEXT NOT NULL,
        principles_json TEXT NOT NULL,
        hard_constraints_json TEXT NOT NULL,
        preferred_models_json TEXT NOT NULL,
        project_roots_json TEXT NOT NULL,
        notes TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS imprint_snapshots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        profile_id TEXT,
        summary TEXT,
        tags_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        state_json TEXT NOT NULL,
        snapshot_path TEXT,
        memory_id INTEGER
      );
    `);

    this.ensureIndex("idx_imprint_profiles_updated", "imprint_profiles", "updated_at DESC");
    this.ensureIndex("idx_imprint_snapshots_created", "imprint_snapshots", "created_at DESC");
    this.ensureIndex("idx_imprint_snapshots_profile", "imprint_snapshots", "profile_id, created_at DESC");
  }

  private applyTaskSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        objective TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_worker_id TEXT,
        last_error TEXT,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        worker_id TEXT,
        summary TEXT,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        content_json TEXT
      );
    `);

    this.ensureIndex("idx_tasks_status_available", "tasks", "status, available_at, priority DESC, created_at ASC");
    this.ensureIndex("idx_tasks_status_priority_created", "tasks", "status, priority DESC, created_at ASC");
    this.ensureIndex("idx_tasks_status_priority_updated", "tasks", "status, priority DESC, updated_at DESC");
    this.ensureIndex("idx_tasks_status_updated", "tasks", "status, updated_at DESC");
    this.ensureIndex("idx_tasks_updated", "tasks", "updated_at DESC");
    this.ensureIndex("idx_task_events_task", "task_events", "task_id, created_at ASC");
    this.ensureIndex("idx_task_leases_expiry", "task_leases", "lease_expires_at ASC");
    this.ensureIndex("idx_task_artifacts_task", "task_artifacts", "task_id, created_at ASC");
  }

  private applyAgenticSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        risk_tier TEXT NOT NULL DEFAULT 'medium',
        autonomy_mode TEXT NOT NULL DEFAULT 'recommend',
        target_entity_type TEXT,
        target_entity_id TEXT,
        acceptance_criteria_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        owner_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        active_plan_id TEXT,
        result_summary TEXT,
        result_json TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS goal_events (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        planner_kind TEXT NOT NULL,
        planner_id TEXT,
        selected INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        assumptions_json TEXT NOT NULL,
        success_criteria_json TEXT NOT NULL,
        rollback_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_steps (
        step_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        step_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        executor_kind TEXT,
        executor_ref TEXT,
        tool_name TEXT,
        input_json TEXT NOT NULL,
        expected_artifact_types_json TEXT NOT NULL,
        acceptance_checks_json TEXT NOT NULL,
        retry_policy_json TEXT NOT NULL,
        timeout_seconds INTEGER,
        task_id TEXT,
        run_id TEXT,
        metadata_json TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_step_edges (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        from_step_id TEXT NOT NULL,
        to_step_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        condition_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        status TEXT NOT NULL,
        goal_id TEXT,
        plan_id TEXT,
        step_id TEXT,
        task_id TEXT,
        run_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        pack_id TEXT,
        producer_kind TEXT NOT NULL,
        producer_id TEXT,
        uri TEXT,
        content_text TEXT,
        content_json TEXT,
        hash TEXT,
        trust_tier TEXT NOT NULL DEFAULT 'raw',
        freshness_expires_at TEXT,
        supersedes_artifact_id TEXT,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact_links (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        src_artifact_id TEXT NOT NULL,
        dst_artifact_id TEXT,
        dst_entity_type TEXT,
        dst_entity_id TEXT,
        relation TEXT NOT NULL,
        rationale TEXT,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS pack_hook_runs (
        hook_run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        hook_kind TEXT NOT NULL,
        hook_name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        goal_id TEXT,
        plan_id TEXT,
        step_id TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        score REAL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_text TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_goals_status_priority", "goals", "status, priority DESC, updated_at DESC");
    this.ensureIndex("idx_goals_target", "goals", "target_entity_type, target_entity_id, updated_at DESC");
    this.ensureIndex("idx_goal_events_goal", "goal_events", "goal_id, created_at ASC");
    this.ensureIndex("idx_plans_goal", "plans", "goal_id, updated_at DESC");
    this.ensureIndex("idx_plans_goal_selected", "plans", "goal_id, selected DESC, updated_at DESC");
    this.ensureIndex("idx_plan_steps_plan_seq", "plan_steps", "plan_id, seq ASC");
    this.ensureIndex("idx_plan_steps_status", "plan_steps", "plan_id, status, seq ASC");
    this.ensureIndex("idx_plan_step_edges_plan", "plan_step_edges", "plan_id, from_step_id, to_step_id");
    this.ensureIndex("idx_artifacts_goal", "artifacts", "goal_id, created_at DESC");
    this.ensureIndex("idx_artifacts_plan", "artifacts", "plan_id, created_at DESC");
    this.ensureIndex("idx_artifacts_step", "artifacts", "step_id, created_at DESC");
    this.ensureIndex("idx_artifacts_run", "artifacts", "run_id, created_at DESC");
    this.ensureIndex("idx_artifacts_type_trust", "artifacts", "artifact_type, trust_tier, created_at DESC");
    this.ensureIndex("idx_artifact_links_src", "artifact_links", "src_artifact_id, created_at ASC");
    this.ensureIndex("idx_artifact_links_dst_artifact", "artifact_links", "dst_artifact_id, created_at ASC");
    this.ensureIndex("idx_artifact_links_dst_entity", "artifact_links", "dst_entity_type, dst_entity_id, created_at ASC");
    this.ensureIndex("idx_pack_hook_runs_target", "pack_hook_runs", "target_type, target_id, created_at DESC");
    this.ensureIndex("idx_pack_hook_runs_pack_kind", "pack_hook_runs", "pack_id, hook_kind, created_at DESC");
  }

  private applyAgentSessionsSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        display_name TEXT,
        client_kind TEXT,
        transport_kind TEXT,
        workspace_root TEXT,
        owner_id TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        capabilities_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_agent_sessions_agent", "agent_sessions", "agent_id, updated_at DESC");
    this.ensureIndex("idx_agent_sessions_status", "agent_sessions", "status, updated_at DESC");
    this.ensureIndex("idx_agent_sessions_lease", "agent_sessions", "lease_expires_at ASC");
  }

  private applyAgentLearningSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_learning_entries (
        entry_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        lesson_kind TEXT NOT NULL,
        polarity TEXT NOT NULL,
        scope TEXT,
        summary TEXT NOT NULL,
        lesson TEXT NOT NULL,
        evidence TEXT,
        source_run_id TEXT,
        source_task_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        confidence REAL,
        weight REAL NOT NULL DEFAULT 0.5,
        fingerprint TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_agent_learning_agent", "agent_learning_entries", "agent_id, updated_at DESC");
    this.ensureIndex("idx_agent_learning_weight_updated", "agent_learning_entries", "weight DESC, updated_at DESC");
    this.ensureIndex(
      "idx_agent_learning_agent_polarity",
      "agent_learning_entries",
      "agent_id, polarity, updated_at DESC"
    );
    this.ensureIndex(
      "idx_agent_learning_agent_status",
      "agent_learning_entries",
      "agent_id, status, updated_at DESC"
    );
    this.ensureIndex(
      "idx_agent_learning_agent_fingerprint",
      "agent_learning_entries",
      "agent_id, fingerprint"
    );
  }

  private applyExperimentSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        experiment_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        goal_id TEXT,
        plan_id TEXT,
        step_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        hypothesis TEXT,
        status TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        metric_direction TEXT NOT NULL,
        baseline_metric REAL,
        current_best_metric REAL,
        acceptance_delta REAL NOT NULL DEFAULT 0,
        budget_seconds INTEGER,
        run_command TEXT,
        parse_strategy_json TEXT NOT NULL,
        rollback_strategy_json TEXT NOT NULL,
        candidate_scope_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        selected_run_id TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS experiment_runs (
        experiment_run_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        candidate_label TEXT NOT NULL,
        status TEXT NOT NULL,
        verdict TEXT,
        task_id TEXT,
        run_id TEXT,
        artifact_ids_json TEXT NOT NULL,
        observed_metric REAL,
        observed_metrics_json TEXT NOT NULL,
        delta REAL,
        summary TEXT,
        log_excerpt TEXT,
        error_text TEXT,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_experiments_status_updated", "experiments", "status, updated_at DESC");
    this.ensureIndex("idx_experiments_goal", "experiments", "goal_id, updated_at DESC");
    this.ensureIndex("idx_experiments_plan", "experiments", "plan_id, updated_at DESC");
    this.ensureIndex("idx_experiment_runs_experiment", "experiment_runs", "experiment_id, created_at DESC");
    this.ensureIndex("idx_experiment_runs_status", "experiment_runs", "status, created_at DESC");
  }

  private applyRuntimeEventBusMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        status TEXT,
        summary TEXT,
        content TEXT,
        details_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_runtime_events_seq", "runtime_events", "event_seq DESC");
    this.ensureIndex("idx_runtime_events_created", "runtime_events", "created_at DESC");
    this.ensureIndex("idx_runtime_events_type_seq", "runtime_events", "event_type, event_seq DESC");
    this.ensureIndex("idx_runtime_events_entity_seq", "runtime_events", "entity_type, entity_id, event_seq DESC");
    this.ensureIndex("idx_runtime_events_agent_seq", "runtime_events", "source_agent, event_seq DESC");
    this.ensureIndex("idx_runtime_events_created_type", "runtime_events", "created_at DESC, event_type");
    this.ensureIndex("idx_runtime_events_created_entity", "runtime_events", "created_at DESC, entity_type");
  }

  private applyRuntimeWorkerSessionSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_worker_sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        goal_id TEXT,
        plan_id TEXT,
        step_id TEXT,
        worker_id TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT,
        tmux_session_name TEXT NOT NULL,
        transcript_path TEXT,
        brief_path TEXT,
        last_command_at TEXT,
        last_activity_at TEXT,
        last_error TEXT,
        metadata_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureIndex("idx_runtime_worker_sessions_status", "runtime_worker_sessions", "status, updated_at DESC");
    this.ensureIndex("idx_runtime_worker_sessions_task", "runtime_worker_sessions", "task_id, updated_at DESC");
    this.ensureIndex("idx_runtime_worker_sessions_runtime", "runtime_worker_sessions", "runtime_id, updated_at DESC");
  }

  private applyObservabilitySchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observability_documents (
        document_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        index_name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        level TEXT,
        host_id TEXT,
        service TEXT,
        event_type TEXT,
        title TEXT,
        body_text TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        tags_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_observability_created", "observability_documents", "created_at DESC");
    this.ensureIndex("idx_observability_index_created", "observability_documents", "index_name, created_at DESC");
    this.ensureIndex("idx_observability_source_created", "observability_documents", "source_kind, created_at DESC");
    this.ensureIndex("idx_observability_host_created", "observability_documents", "host_id, created_at DESC");
    this.ensureIndex("idx_observability_service_created", "observability_documents", "service, created_at DESC");
    this.ensureIndex("idx_observability_level_created", "observability_documents", "level, created_at DESC");
    this.ensureIndex("idx_observability_event_created", "observability_documents", "event_type, created_at DESC");
  }

  private applyTriChatSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_threads (
        thread_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trichat_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to_message_id TEXT,
        metadata_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_trichat_threads_status_updated", "trichat_threads", "status, updated_at DESC");
    this.ensureIndex("idx_trichat_messages_thread_created", "trichat_messages", "thread_id, created_at ASC");
    this.ensureIndex("idx_trichat_messages_agent_created", "trichat_messages", "agent_id, created_at DESC");
  }

  private applyTriChatAdapterTelemetryMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_adapter_states (
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        open INTEGER NOT NULL DEFAULT 0,
        open_until TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        trip_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_opened_at TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        degraded_turn_count INTEGER NOT NULL DEFAULT 0,
        last_result TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (agent_id, channel)
      );
      CREATE TABLE IF NOT EXISTS trichat_adapter_events (
        event_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        open_until TEXT,
        error_text TEXT,
        details_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_trichat_adapter_states_updated", "trichat_adapter_states", "updated_at DESC");
    this.ensureIndex("idx_trichat_adapter_states_open", "trichat_adapter_states", "open, updated_at DESC");
    this.ensureIndex("idx_trichat_adapter_events_created", "trichat_adapter_events", "created_at DESC");
    this.ensureIndex("idx_trichat_adapter_events_agent_created", "trichat_adapter_events", "agent_id, created_at DESC");
    this.ensureIndex("idx_trichat_adapter_events_type_created", "trichat_adapter_events", "event_type, created_at DESC");
  }

  private applyTriChatBusMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_bus_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_agent TEXT,
        source_client TEXT,
        event_type TEXT NOT NULL,
        role TEXT,
        content TEXT,
        metadata_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_trichat_bus_events_thread_seq", "trichat_bus_events", "thread_id, event_seq DESC");
    this.ensureIndex("idx_trichat_bus_events_created", "trichat_bus_events", "created_at DESC");
    this.ensureIndex("idx_trichat_bus_events_type_seq", "trichat_bus_events", "event_type, event_seq DESC");
    this.ensureIndex("idx_trichat_bus_events_agent_seq", "trichat_bus_events", "source_agent, event_seq DESC");
  }

  private applyTriChatTurnSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        phase TEXT NOT NULL DEFAULT 'plan',
        phase_status TEXT NOT NULL DEFAULT 'running',
        expected_agents_json TEXT NOT NULL,
        min_agents INTEGER NOT NULL DEFAULT 3,
        novelty_score REAL,
        novelty_threshold REAL,
        retry_required INTEGER NOT NULL DEFAULT 0,
        retry_agents_json TEXT NOT NULL DEFAULT '[]',
        disagreement INTEGER NOT NULL DEFAULT 0,
        decision_summary TEXT,
        selected_agent TEXT,
        selected_strategy TEXT,
        verify_status TEXT,
        verify_summary TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(thread_id, user_message_id)
      );
      CREATE TABLE IF NOT EXISTS trichat_turn_artifacts (
        artifact_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        phase TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        agent_id TEXT,
        content TEXT,
        structured_json TEXT NOT NULL,
        score REAL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    this.ensureIndex("idx_trichat_turns_thread_updated", "trichat_turns", "thread_id, updated_at DESC");
    this.ensureIndex("idx_trichat_turns_status_updated", "trichat_turns", "status, updated_at DESC");
    this.ensureIndex("idx_trichat_turns_phase_updated", "trichat_turns", "phase, updated_at DESC");
    this.ensureIndex(
      "idx_trichat_turn_artifacts_turn_created",
      "trichat_turn_artifacts",
      "turn_id, created_at ASC"
    );
    this.ensureIndex(
      "idx_trichat_turn_artifacts_thread_phase",
      "trichat_turn_artifacts",
      "thread_id, phase, created_at DESC"
    );
    this.ensureIndex(
      "idx_trichat_turn_artifacts_type_phase",
      "trichat_turn_artifacts",
      "artifact_type, phase, created_at DESC"
    );
  }

  private applyTriChatReliabilitySchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_chaos_events (
        event_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        agent_id TEXT,
        channel TEXT,
        outcome TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trichat_slo_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        window_minutes INTEGER NOT NULL,
        adapter_sample_count INTEGER NOT NULL,
        adapter_error_count INTEGER NOT NULL,
        adapter_error_rate REAL NOT NULL,
        adapter_latency_p95_ms REAL,
        turn_total_count INTEGER NOT NULL,
        turn_failed_count INTEGER NOT NULL,
        turn_failure_rate REAL NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    this.ensureIndex("idx_trichat_chaos_events_created", "trichat_chaos_events", "created_at DESC");
    this.ensureIndex(
      "idx_trichat_chaos_events_action_created",
      "trichat_chaos_events",
      "action, created_at DESC"
    );
    this.ensureIndex(
      "idx_trichat_chaos_events_thread_created",
      "trichat_chaos_events",
      "thread_id, created_at DESC"
    );
    this.ensureIndex("idx_trichat_slo_snapshots_created", "trichat_slo_snapshots", "created_at DESC");
    this.ensureIndex(
      "idx_trichat_slo_snapshots_window_created",
      "trichat_slo_snapshots",
      "window_minutes, created_at DESC"
    );
  }

  private appendTaskEvent(params: {
    task_id: string;
    event_type: string;
    from_status?: TaskStatus;
    to_status?: TaskStatus;
    worker_id?: string;
    summary?: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_events (
           id, task_id, created_at, event_type, from_status, to_status, worker_id, summary, details_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.task_id,
        createdAt,
        params.event_type,
        params.from_status ?? null,
        params.to_status ?? null,
        params.worker_id ?? null,
        params.summary ?? null,
        stableStringify(params.details ?? {})
      );
    this.appendRuntimeEvent({
      event_type: `task.${params.event_type}`,
      entity_type: "task",
      entity_id: params.task_id,
      status: params.to_status ?? params.from_status ?? null,
      summary: params.summary ?? null,
      details: {
        from_status: params.from_status ?? null,
        to_status: params.to_status ?? null,
        worker_id: params.worker_id ?? null,
        ...(params.details ?? {}),
      },
      source_agent: params.worker_id ?? undefined,
      created_at: createdAt,
    });
    return { id, created_at: createdAt };
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    const exists = rows.some((row) => String(row.name) === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private ensureIndex(indexName: string, table: string, columns: string): void {
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${columns})`);
  }
}

function mapNoteRow(row: Record<string, unknown>): NoteRecord {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    source: asNullableString(row.source),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    trust_tier: normalizeTrustTier(row.trust_tier),
    expires_at: asNullableString(row.expires_at),
    promoted_from_note_id: asNullableString(row.promoted_from_note_id),
    tags: safeParseJsonArray(row.tags_json),
    related_paths: safeParseJsonArray(row.related_paths_json),
    text: String(row.text ?? ""),
  };
}

function mapTranscriptRow(row: Record<string, unknown>): TranscriptRecord {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    session_id: String(row.session_id),
    source_client: String(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    kind: String(row.kind),
    text: String(row.text ?? ""),
  };
}

function mapTranscriptLineRow(row: Record<string, unknown>): TranscriptLineRecord {
  return {
    id: Number(row.id ?? 0),
    run_id: asNullableString(row.run_id),
    role: asNullableString(row.role),
    content: String(row.content ?? ""),
    timestamp: String(row.timestamp ?? ""),
    is_squished: Number(row.is_squished ?? 0) === 1,
  };
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: Number(row.id ?? 0),
    content: String(row.content ?? ""),
    keywords: parseKeywords(row.keywords),
    created_at: String(row.created_at ?? ""),
    last_accessed_at: String(row.last_accessed_at ?? ""),
    decay_score: Number(row.decay_score ?? 1),
  };
}

function mapImprintProfileRow(row: Record<string, unknown>): ImprintProfileRecord {
  return {
    profile_id: String(row.profile_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    title: String(row.title ?? ""),
    mission: String(row.mission ?? ""),
    principles: safeParseJsonArray(row.principles_json),
    hard_constraints: safeParseJsonArray(row.hard_constraints_json),
    preferred_models: safeParseJsonArray(row.preferred_models_json),
    project_roots: safeParseJsonArray(row.project_roots_json),
    notes: asNullableString(row.notes),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapImprintSnapshotRow(row: Record<string, unknown>): ImprintSnapshotRecord {
  return {
    id: String(row.id ?? ""),
    created_at: String(row.created_at ?? ""),
    profile_id: asNullableString(row.profile_id),
    summary: asNullableString(row.summary),
    tags: safeParseJsonArray(row.tags_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    state: parseJsonObject(row.state_json),
    snapshot_path: asNullableString(row.snapshot_path),
    memory_id: row.memory_id === null || row.memory_id === undefined ? null : Number(row.memory_id),
  };
}

function mapGoalRow(row: Record<string, unknown>): GoalRecord {
  return {
    goal_id: String(row.goal_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    title: String(row.title ?? ""),
    objective: String(row.objective ?? ""),
    status: normalizeGoalStatus(row.status),
    priority: Number(row.priority ?? 0),
    risk_tier: normalizeGoalRiskTier(row.risk_tier),
    autonomy_mode: normalizeGoalAutonomyMode(row.autonomy_mode),
    target_entity_type: asNullableString(row.target_entity_type),
    target_entity_id: asNullableString(row.target_entity_id),
    acceptance_criteria: safeParseJsonArray(row.acceptance_criteria_json),
    constraints: safeParseJsonArray(row.constraints_json),
    assumptions: safeParseJsonArray(row.assumptions_json),
    budget: parseJsonObject(row.budget_json),
    owner: parseJsonObject(row.owner_json),
    tags: safeParseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json),
    active_plan_id: asNullableString(row.active_plan_id),
    result_summary: asNullableString(row.result_summary),
    result: parseNullableJsonObject(row.result_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapGoalEventRow(row: Record<string, unknown>): GoalEventRecord {
  return {
    id: String(row.id ?? ""),
    goal_id: String(row.goal_id ?? ""),
    created_at: String(row.created_at ?? ""),
    event_type: String(row.event_type ?? ""),
    from_status:
      row.from_status === null || row.from_status === undefined
        ? null
        : normalizeGoalStatus(row.from_status),
    to_status:
      row.to_status === null || row.to_status === undefined
        ? null
        : normalizeGoalStatus(row.to_status),
    summary: String(row.summary ?? ""),
    details: parseJsonObject(row.details_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapPlanRow(row: Record<string, unknown>): PlanRecord {
  return {
    plan_id: String(row.plan_id ?? ""),
    goal_id: String(row.goal_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    status: normalizePlanStatus(row.status),
    planner_kind: normalizePlanPlannerKind(row.planner_kind),
    planner_id: asNullableString(row.planner_id),
    selected: Number(row.selected ?? 0) === 1,
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    assumptions: safeParseJsonArray(row.assumptions_json),
    success_criteria: safeParseJsonArray(row.success_criteria_json),
    rollback: safeParseJsonArray(row.rollback_json),
    budget: parseJsonObject(row.budget_json),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapPlanStepRow(row: Record<string, unknown>, dependsOn: string[]): PlanStepRecord {
  return {
    step_id: String(row.step_id ?? ""),
    plan_id: String(row.plan_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    seq: Number(row.seq ?? 0),
    title: String(row.title ?? ""),
    step_kind: normalizePlanStepKind(row.step_kind),
    status: normalizePlanStepStatus(row.status),
    executor_kind: normalizeOptionalPlanExecutorKind(row.executor_kind),
    executor_ref: asNullableString(row.executor_ref),
    tool_name: asNullableString(row.tool_name),
    input: parseJsonObject(row.input_json),
    expected_artifact_types: safeParseJsonArray(row.expected_artifact_types_json),
    acceptance_checks: safeParseJsonArray(row.acceptance_checks_json),
    retry_policy: parseJsonObject(row.retry_policy_json),
    timeout_seconds:
      row.timeout_seconds === null || row.timeout_seconds === undefined
        ? null
        : Number(row.timeout_seconds),
    task_id: asNullableString(row.task_id),
    run_id: asNullableString(row.run_id),
    metadata: parseJsonObject(row.metadata_json),
    started_at: asNullableString(row.started_at),
    finished_at: asNullableString(row.finished_at),
    depends_on: [...dependsOn],
  };
}

function mapAgentSessionRow(row: Record<string, unknown>): AgentSessionRecord {
  return {
    session_id: String(row.session_id ?? ""),
    agent_id: String(row.agent_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    started_at: String(row.started_at ?? ""),
    ended_at: asNullableString(row.ended_at),
    status: normalizeAgentSessionStatus(row.status),
    display_name: asNullableString(row.display_name),
    client_kind: asNullableString(row.client_kind),
    transport_kind: asNullableString(row.transport_kind),
    workspace_root: asNullableString(row.workspace_root),
    owner_id: asNullableString(row.owner_id),
    lease_expires_at: asNullableString(row.lease_expires_at),
    heartbeat_at: asNullableString(row.heartbeat_at),
    capabilities: parseJsonObject(row.capabilities_json),
    tags: safeParseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapAgentLearningEntryRow(row: Record<string, unknown>): AgentLearningEntryRecord {
  return {
    entry_id: String(row.entry_id ?? ""),
    agent_id: String(row.agent_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    status: normalizeAgentLearningEntryStatus(row.status),
    lesson_kind: normalizeAgentLearningEntryKind(row.lesson_kind),
    polarity: normalizeAgentLearningEntryPolarity(row.polarity),
    scope: asNullableString(row.scope),
    summary: String(row.summary ?? ""),
    lesson: String(row.lesson ?? ""),
    evidence: asNullableString(row.evidence),
    source_run_id: asNullableString(row.source_run_id),
    source_task_id: asNullableString(row.source_task_id),
    thread_id: asNullableString(row.thread_id),
    turn_id: asNullableString(row.turn_id),
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number.isFinite(Number(row.confidence))
          ? Number(row.confidence)
          : null,
    weight: Number.isFinite(Number(row.weight)) ? Number(row.weight) : 0.5,
    fingerprint: String(row.fingerprint ?? ""),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapArtifactRow(row: Record<string, unknown>): ArtifactRecord {
  return {
    artifact_id: String(row.artifact_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    artifact_type: String(row.artifact_type ?? ""),
    status: normalizeArtifactStatus(row.status),
    goal_id: asNullableString(row.goal_id),
    plan_id: asNullableString(row.plan_id),
    step_id: asNullableString(row.step_id),
    task_id: asNullableString(row.task_id),
    run_id: asNullableString(row.run_id),
    thread_id: asNullableString(row.thread_id),
    turn_id: asNullableString(row.turn_id),
    pack_id: asNullableString(row.pack_id),
    producer_kind: String(row.producer_kind ?? ""),
    producer_id: asNullableString(row.producer_id),
    uri: asNullableString(row.uri),
    content_text: asNullableString(row.content_text),
    content_json: parseNullableJsonObject(row.content_json),
    hash: asNullableString(row.hash),
    trust_tier: normalizeArtifactTrustTier(row.trust_tier),
    freshness_expires_at: asNullableString(row.freshness_expires_at),
    supersedes_artifact_id: asNullableString(row.supersedes_artifact_id),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapArtifactLinkRow(row: Record<string, unknown>): ArtifactLinkRecord {
  return {
    id: String(row.id ?? ""),
    created_at: String(row.created_at ?? ""),
    src_artifact_id: String(row.src_artifact_id ?? ""),
    dst_artifact_id: asNullableString(row.dst_artifact_id),
    dst_entity_type: asNullableString(row.dst_entity_type),
    dst_entity_id: asNullableString(row.dst_entity_id),
    relation: String(row.relation ?? ""),
    rationale: asNullableString(row.rationale),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapExperimentRow(row: Record<string, unknown>): ExperimentRecord {
  return {
    experiment_id: String(row.experiment_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    goal_id: asNullableString(row.goal_id),
    plan_id: asNullableString(row.plan_id),
    step_id: asNullableString(row.step_id),
    title: String(row.title ?? ""),
    objective: String(row.objective ?? ""),
    hypothesis: asNullableString(row.hypothesis),
    status: normalizeExperimentStatus(row.status),
    metric_name: String(row.metric_name ?? ""),
    metric_direction: normalizeExperimentMetricDirection(row.metric_direction),
    baseline_metric: asNullableNumber(row.baseline_metric),
    current_best_metric: asNullableNumber(row.current_best_metric),
    acceptance_delta: Number(row.acceptance_delta ?? 0),
    budget_seconds: row.budget_seconds === null || row.budget_seconds === undefined ? null : Number(row.budget_seconds),
    run_command: asNullableString(row.run_command),
    parse_strategy: parseJsonObject(row.parse_strategy_json),
    rollback_strategy: parseJsonObject(row.rollback_strategy_json),
    candidate_scope: parseJsonObject(row.candidate_scope_json),
    tags: safeParseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json),
    selected_run_id: asNullableString(row.selected_run_id),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapExperimentRunRow(row: Record<string, unknown>): ExperimentRunRecord {
  return {
    experiment_run_id: String(row.experiment_run_id ?? ""),
    experiment_id: String(row.experiment_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    candidate_label: String(row.candidate_label ?? ""),
    status: normalizeExperimentRunStatus(row.status),
    verdict: normalizeOptionalExperimentVerdict(row.verdict),
    task_id: asNullableString(row.task_id),
    run_id: asNullableString(row.run_id),
    artifact_ids: safeParseJsonArray(row.artifact_ids_json),
    observed_metric: asNullableNumber(row.observed_metric),
    observed_metrics: parseJsonObject(row.observed_metrics_json),
    delta: asNullableNumber(row.delta),
    summary: asNullableString(row.summary),
    log_excerpt: asNullableString(row.log_excerpt),
    error_text: asNullableString(row.error_text),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapPackHookRunRow(row: Record<string, unknown>): PackHookRunRecord {
  return {
    hook_run_id: String(row.hook_run_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    pack_id: String(row.pack_id ?? ""),
    hook_kind: normalizePackHookKind(row.hook_kind),
    hook_name: String(row.hook_name ?? ""),
    target_type: String(row.target_type ?? ""),
    target_id: String(row.target_id ?? ""),
    goal_id: asNullableString(row.goal_id),
    plan_id: asNullableString(row.plan_id),
    step_id: asNullableString(row.step_id),
    status: normalizePackHookRunStatus(row.status),
    summary: asNullableString(row.summary),
    score: asNullableNumber(row.score),
    input: parseJsonObject(row.input_json),
    output: row.output_json == null ? null : parseJsonObject(row.output_json),
    error_text: asNullableString(row.error_text),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapRuntimeEventRow(row: Record<string, unknown>): RuntimeEventRecord {
  return {
    event_seq: Number(row.event_seq ?? 0),
    event_id: String(row.event_id ?? ""),
    created_at: String(row.created_at ?? ""),
    event_type: String(row.event_type ?? ""),
    entity_type: asNullableString(row.entity_type),
    entity_id: asNullableString(row.entity_id),
    status: asNullableString(row.status),
    summary: asNullableString(row.summary),
    content: asNullableString(row.content),
    details: parseJsonObject(row.details_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapObservabilityDocumentRow(row: Record<string, unknown>): ObservabilityDocumentRecord {
  const levelRaw = asNullableString(row.level);
  const level =
    levelRaw === "trace" ||
    levelRaw === "debug" ||
    levelRaw === "info" ||
    levelRaw === "warn" ||
    levelRaw === "error" ||
    levelRaw === "critical"
      ? levelRaw
      : null;
  return {
    document_id: String(row.document_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    index_name: String(row.index_name ?? ""),
    source_kind: String(row.source_kind ?? ""),
    source_ref: asNullableString(row.source_ref),
    level,
    host_id: asNullableString(row.host_id),
    service: asNullableString(row.service),
    event_type: asNullableString(row.event_type),
    title: asNullableString(row.title),
    body_text: String(row.body_text ?? ""),
    attributes: parseJsonObject(row.attributes_json),
    tags: safeParseJsonArray(row.tags_json),
  };
}

function buildBudgetLedgerWhereClause(params: {
  ledger_kind?: "projection" | "actual" | "adjustment";
  run_id?: string;
  task_id?: string;
  provider?: string;
  model_id?: string;
  entity_type?: string;
  entity_id?: string;
  since?: string;
}) {
  const whereClauses: string[] = [];
  const values: unknown[] = [];
  if (params.ledger_kind) {
    whereClauses.push("ledger_kind = ?");
    values.push(params.ledger_kind);
  }
  const runId = params.run_id?.trim();
  if (runId) {
    whereClauses.push("run_id = ?");
    values.push(runId);
  }
  const taskId = params.task_id?.trim();
  if (taskId) {
    whereClauses.push("task_id = ?");
    values.push(taskId);
  }
  const provider = params.provider?.trim();
  if (provider) {
    whereClauses.push("provider = ?");
    values.push(provider);
  }
  const modelId = params.model_id?.trim();
  if (modelId) {
    whereClauses.push("model_id = ?");
    values.push(modelId);
  }
  const entityType = params.entity_type?.trim();
  if (entityType) {
    whereClauses.push("entity_type = ?");
    values.push(entityType);
  }
  const entityId = params.entity_id?.trim();
  if (entityId) {
    whereClauses.push("entity_id = ?");
    values.push(entityId);
  }
  const since = params.since?.trim();
  if (since) {
    whereClauses.push("created_at >= ?");
    values.push(since);
  }
  return {
    whereSql: whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "",
    values,
  };
}

function mapBudgetLedgerRow(row: Record<string, unknown>): BudgetLedgerEntryRecord {
  const ledgerKind = String(row.ledger_kind ?? "");
  return {
    entry_id: String(row.entry_id ?? ""),
    created_at: String(row.created_at ?? ""),
    ledger_kind:
      ledgerKind === "projection" || ledgerKind === "actual" || ledgerKind === "adjustment" ? ledgerKind : "actual",
    entity_type: asNullableString(row.entity_type),
    entity_id: asNullableString(row.entity_id),
    run_id: asNullableString(row.run_id),
    task_id: asNullableString(row.task_id),
    goal_id: asNullableString(row.goal_id),
    plan_id: asNullableString(row.plan_id),
    session_id: asNullableString(row.session_id),
    provider: asNullableString(row.provider),
    model_id: asNullableString(row.model_id),
    tokens_input: asNullableNumber(row.tokens_input),
    tokens_output: asNullableNumber(row.tokens_output),
    tokens_total: asNullableNumber(row.tokens_total),
    projected_cost_usd: asNullableNumber(row.projected_cost_usd),
    actual_cost_usd: asNullableNumber(row.actual_cost_usd),
    currency: String(row.currency ?? "USD"),
    notes: asNullableString(row.notes),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapTaskRow(row: Record<string, unknown>): TaskRecord {
  const leaseOwnerId = asNullableString(row.lease_owner_id);
  const leaseExpiresAt = asNullableString(row.lease_expires_at);
  const leaseHeartbeat = asNullableString(row.lease_heartbeat_at);
  const leaseCreatedAt = asNullableString(row.lease_created_at);
  const leaseUpdatedAt = asNullableString(row.lease_updated_at);
  return {
    task_id: String(row.task_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    status: normalizeTaskStatus(row.status),
    priority: Number(row.priority ?? 0),
    objective: String(row.objective ?? ""),
    project_dir: String(row.project_dir ?? ""),
    payload: parseJsonObject(row.payload_json),
    source: asNullableString(row.source),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    tags: safeParseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json),
    max_attempts: Number(row.max_attempts ?? 3),
    attempt_count: Number(row.attempt_count ?? 0),
    available_at: String(row.available_at ?? ""),
    started_at: asNullableString(row.started_at),
    finished_at: asNullableString(row.finished_at),
    last_worker_id: asNullableString(row.last_worker_id),
    last_error: asNullableString(row.last_error),
    result: parseNullableJsonObject(row.result_json),
    lease:
      leaseOwnerId && leaseExpiresAt && leaseHeartbeat && leaseCreatedAt && leaseUpdatedAt
        ? {
            task_id: String(row.task_id ?? ""),
            owner_id: leaseOwnerId,
            lease_expires_at: leaseExpiresAt,
            heartbeat_at: leaseHeartbeat,
            created_at: leaseCreatedAt,
            updated_at: leaseUpdatedAt,
          }
      : null,
  };
}

function withTaskCompletionReasoningAudit(task: TaskRecord | null | undefined, result: Record<string, unknown>): Record<string, unknown> {
  const audit = buildTaskCompletionReasoningAudit(task, result);
  if (!audit) {
    return result;
  }
  return {
    ...result,
    reasoning_policy_audit: audit,
  };
}

function buildTaskRetryReflectionPreflight(
  storage: Storage,
  task: TaskRecord,
  injectedAt: string
): (Record<string, unknown> & {
  reflection_match_count: number;
  retry_reflection_memory_ids: string[];
}) | null {
  const execution = readPlainObject(task.metadata.task_execution);
  if (!isTaskExecutionHighCompute(execution)) {
    return null;
  }
  const memories = storage
    .searchMemories({
      query: task.task_id,
      limit: 5,
    })
    .filter((entry) => entry.keywords.includes("reflection") || /Reflection Case:/i.test(entry.content))
    .slice(0, 3);
  if (memories.length === 0) {
    return null;
  }
  const topReflections = memories.map((entry) => ({
    id: String(entry.id),
    score: typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : null,
    text_preview: compactStorageSingleLine(entry.content, 320),
    citation: {
      source: "memory",
      id: String(entry.id),
    },
    keywords: entry.keywords.slice(0, 12),
  }));
  return {
    query: task.task_id,
    strategy: "retry_reflection",
    match_count: memories.length,
    top_matches: [],
    reflection_match_count: memories.length,
    top_reflections: topReflections,
    retry_reflection_memory_ids: topReflections.map((entry) => entry.id),
    retry_reflection_injected_at: injectedAt,
  };
}

function captureTaskFailureReflection(
  storage: Storage,
  task: TaskRecord,
  input: {
    worker_id: string;
    error: string;
    summary?: string;
    result?: Record<string, unknown>;
  }
): TaskFailureReflectionCapture | null {
  const execution = readPlainObject(task.metadata.task_execution);
  if (!execution || !isTaskExecutionHighCompute(execution)) {
    return null;
  }

  const taskKind = String(execution.task_kind ?? "").trim() || "task";
  const computePolicy = readTaskReasoningComputePolicy(execution);
  const candidateCount = resolveTaskReasoningCandidateRequirement(execution);
  const selectionStrategy = resolveTaskReasoningSelectionStrategy(execution);
  const policyMode = String(computePolicy?.mode ?? "").trim();
  const activationReasons = asStringArrayForStorage(computePolicy?.activation_reasons).slice(0, 6);
  const transcriptPolicy = String(computePolicy?.transcript_policy ?? "").trim();
  const resultKeys = Object.keys(input.result ?? {}).slice(0, 12);
  const groundedFeedback = [
    `Task ${task.task_id} failed under ${taskKind} reasoning policy.`,
    `Failure error: ${compactStorageSingleLine(input.error, 220)}`,
    input.summary ? `Worker summary: ${compactStorageSingleLine(input.summary, 220)}` : null,
    resultKeys.length > 0 ? `Failure result keys: ${resultKeys.join(", ")}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  const policySignals = [
    policyMode ? `mode=${policyMode}` : null,
    candidateCount && candidateCount > 1 ? `candidate_count=${candidateCount}` : null,
    selectionStrategy ? `selection=${selectionStrategy}` : null,
    computePolicy?.evidence_required === true ? "evidence_required" : null,
    transcriptPolicy ? `transcript_policy=${transcriptPolicy}` : null,
    ...activationReasons.map((reason) => `activation=${reason}`),
    execution.require_plan_pass === true ? "plan_pass_required" : null,
    execution.require_verification_pass === true ? "verification_pass_required" : null,
  ].filter((entry): entry is string => Boolean(entry));
  const content = [
    `Reflection Case: Failed high-compute task ${task.task_id}`,
    `Objective: ${compactStorageSingleLine(task.objective, 360)}`,
    `Attempted action: ${compactStorageSingleLine(input.summary || "Task execution reported failure.", 300)}`,
    "Grounded feedback:",
    ...groundedFeedback.map((entry) => `- ${entry}`),
    "Reasoning policy signals:",
    ...(policySignals.length > 0 ? policySignals.map((entry) => `- ${entry}`) : ["- none"]),
    "Reflection:",
    "Retry should change the candidate, evidence, or verification path instead of repeating the failed execution. Re-enter with explicit evidence for the required reasoning-policy fields before completion.",
    "Next actions:",
    "- Inspect the failure evidence and identify the contradiction or missing check.",
    "- Generate a revised bounded candidate path and verify it with concrete evidence.",
    "- If evidence remains weak, fail closed with the blocker instead of marking success.",
    "Evidence references:",
    `- [run] storage.failTask (task:${task.task_id})`,
  ].join("\n");

  const keywords = normalizeKeywords([
    "reflection",
    "episodic",
    "grounded",
    "task-failure",
    "high-compute",
    "reasoning-policy",
    task.task_id,
    taskKind,
    ...policySignals,
    ...task.tags,
  ]);
  const memory = storage.insertMemory({
    content,
    keywords,
  });
  const event = storage.appendRuntimeEvent({
    event_type: "memory.reflection_captured",
    entity_type: "memory",
    entity_id: String(memory.id),
    status: "active",
    summary: `auto reflection captured for failed task ${task.task_id}`,
    details: {
      task_id: task.task_id,
      worker_id: input.worker_id,
      grounded_feedback_count: groundedFeedback.length,
      source: "storage.failTask",
      policy_signals: policySignals,
    },
  });
  return {
    memory_id: memory.id,
    created_at: memory.created_at,
    event_id: event.event_id,
    keywords: normalizeKeywords(["reflection", "task-failure", "high-compute", ...policySignals]),
  };
}

function mergeTaskRetryReflectionPreflight(
  metadata: Record<string, unknown>,
  retryPreflight: Record<string, unknown>,
  injectedAt: string
): Record<string, unknown> {
  const existingPreflight = readPlainObject(metadata.memory_preflight) ?? {};
  const existingTopReflections = Array.isArray(existingPreflight.top_reflections)
    ? existingPreflight.top_reflections.filter((entry) => readPlainObject(entry))
    : [];
  const retryTopReflections = Array.isArray(retryPreflight.top_reflections)
    ? retryPreflight.top_reflections.filter((entry) => readPlainObject(entry))
    : [];
  const seen = new Set<string>();
  const topReflections = [...retryTopReflections, ...existingTopReflections]
    .filter((entry) => {
      const record = readPlainObject(entry);
      const id = String(record?.id ?? "").trim();
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    })
    .slice(0, 3);
  return {
    ...metadata,
    memory_preflight: {
      ...existingPreflight,
      ...retryPreflight,
      reflection_match_count: Math.max(
        asFiniteNumberForStorage(existingPreflight.reflection_match_count),
        asFiniteNumberForStorage(retryPreflight.reflection_match_count),
        topReflections.length
      ),
      top_reflections: topReflections,
      retry_reflection_injected_at: injectedAt,
    },
  };
}

function boundedReasoningPolicyCandidateCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.min(4, Math.round(value)));
}

function readTaskReasoningComputePolicy(execution: Record<string, unknown>): Record<string, unknown> | null {
  return readPlainObject(execution.reasoning_compute_policy);
}

function resolveTaskReasoningCandidateRequirement(execution: Record<string, unknown>): number | null {
  const legacyCount = boundedReasoningPolicyCandidateCount(execution.reasoning_candidate_count);
  if (legacyCount !== null) {
    return legacyCount;
  }
  const computePolicy = readTaskReasoningComputePolicy(execution);
  if (!computePolicy) {
    return null;
  }
  const policyCount =
    boundedReasoningPolicyCandidateCount(computePolicy.candidate_count) ??
    boundedReasoningPolicyCandidateCount(computePolicy.max_candidate_count);
  const policyMode = String(computePolicy.mode ?? "").trim();
  if (policyMode === "adaptive_best_of_n") {
    return Math.max(2, policyCount ?? 2);
  }
  return policyCount;
}

function resolveTaskReasoningSelectionStrategy(execution: Record<string, unknown>): string | null {
  const legacyStrategy = String(execution.reasoning_selection_strategy ?? "").trim();
  if (legacyStrategy) {
    return legacyStrategy;
  }
  const computePolicy = readTaskReasoningComputePolicy(execution);
  const policyStrategy = String(computePolicy?.selection_strategy ?? "").trim();
  return policyStrategy || null;
}

function taskReasoningComputePolicyRequiresEvidence(execution: Record<string, unknown>): boolean {
  const computePolicy = readTaskReasoningComputePolicy(execution);
  if (!computePolicy) {
    return false;
  }
  return computePolicy.evidence_required === true || String(computePolicy.mode ?? "").trim() === "adaptive_best_of_n";
}

function taskReasoningComputePolicyRequiresBranchSearch(execution: Record<string, unknown>): boolean {
  const computePolicy = readTaskReasoningComputePolicy(execution);
  const branchSearch = readPlainObject(computePolicy?.shallow_branch_search);
  return branchSearch?.enabled === true;
}

function taskReasoningComputePolicyRequiresBudgetForcing(execution: Record<string, unknown>): boolean {
  const computePolicy = readTaskReasoningComputePolicy(execution);
  const budgetForcing = readPlainObject(computePolicy?.budget_forcing);
  return budgetForcing?.enabled === true;
}

function readTaskPlanQualityGate(execution: Record<string, unknown>): Record<string, unknown> | null {
  const gate = readPlainObject(execution.plan_quality_gate);
  return gate?.required === true ? gate : null;
}

function readTaskPlanQualityRequiredFields(execution: Record<string, unknown>): string[] {
  const gate = readTaskPlanQualityGate(execution);
  if (!gate) {
    return [];
  }
  return [...new Set(asStringArrayForStorage(gate.required_fields))].slice(0, 8);
}

function readTaskPlanQualityMaxSteps(execution: Record<string, unknown>): number | null {
  const gate = readTaskPlanQualityGate(execution);
  const raw = gate?.max_planned_steps;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(1, Math.min(20, Math.round(raw)));
}

function isTaskExecutionHighCompute(execution: Record<string, unknown> | null): boolean {
  if (!execution) {
    return false;
  }
  const candidateCount = resolveTaskReasoningCandidateRequirement(execution) ?? 0;
  const selectionStrategy = resolveTaskReasoningSelectionStrategy(execution);
  const taskKind = String(execution.task_kind ?? "").trim();
  const qualityPreference = String(execution.quality_preference ?? "").trim();
  return (
    candidateCount > 1 ||
    selectionStrategy === "evidence_rerank" ||
    execution.require_plan_pass === true ||
    execution.require_verification_pass === true ||
    taskReasoningComputePolicyRequiresEvidence(execution) ||
    taskReasoningComputePolicyRequiresBranchSearch(execution) ||
    taskReasoningComputePolicyRequiresBudgetForcing(execution) ||
    (qualityPreference === "quality" && (taskKind === "research" || taskKind === "verification"))
  );
}

function buildTaskCompletionReasoningAudit(
  task: TaskRecord | null | undefined,
  result: Record<string, unknown>
): TaskCompletionReasoningAudit | null {
  const execution = readPlainObject(task?.metadata.task_execution);
  if (!execution) {
    return null;
  }
  const candidateRequirement = resolveTaskReasoningCandidateRequirement(execution);
  const evidenceRerank = resolveTaskReasoningSelectionStrategy(execution) === "evidence_rerank";
  const planRequired = execution.require_plan_pass === true;
  const verificationRequired = execution.require_verification_pass === true;
  const policyEvidenceRequired = taskReasoningComputePolicyRequiresEvidence(execution);
  const branchSearchRequired = taskReasoningComputePolicyRequiresBranchSearch(execution);
  const budgetForcingRequired = taskReasoningComputePolicyRequiresBudgetForcing(execution);
  const planQualityRequiredFields = readTaskPlanQualityRequiredFields(execution);
  const planQualityMaxSteps = readTaskPlanQualityMaxSteps(execution);
  const planQualityGateRequired = planRequired && planQualityRequiredFields.length > 0;
  const verifierRequiredSelectedFields = readVerifierRerankRequiredSelectedFields(execution);
  const taskKind = String(execution.task_kind ?? "").trim();
  const qualityPreference = String(execution.quality_preference ?? "").trim();
  const qualityBiased =
    qualityPreference === "quality" && (taskKind === "research" || taskKind === "verification");
  const required =
    planRequired ||
    verificationRequired ||
    branchSearchRequired ||
    budgetForcingRequired ||
    planQualityGateRequired ||
    evidenceRerank ||
    policyEvidenceRequired ||
    (candidateRequirement !== null && candidateRequirement > 1) ||
    qualityBiased;
  if (!required) {
    return null;
  }

  const requiredFields: string[] = [];
  const satisfiedFields: string[] = [];
  const missingFields: string[] = [];
  const warnings: string[] = [];
  const observedCandidateCount = readCompletionCandidateCount(result);
  const selectionAudit = buildCompletionSelectionAudit(
    result,
    observedCandidateCount,
    evidenceRerank ? "evidence_rerank" : null
  );

  const requireField = (field: string, satisfied: boolean) => {
    requiredFields.push(field);
    if (satisfied) {
      satisfiedFields.push(field);
    } else {
      missingFields.push(field);
    }
  };

  if (candidateRequirement !== null && candidateRequirement > 1) {
    requireField(
      "candidate_evidence",
      observedCandidateCount !== null && observedCandidateCount >= candidateRequirement
    );
  }
  if (evidenceRerank) {
    requireField("selection_rationale", completionSelectionAuditIsSatisfied(selectionAudit));
    for (const field of verifierRequiredSelectedFields) {
      if (field === "selected_candidate_id" || field === "selection_rationale") {
        continue;
      }
      requireField(field, completionSelectedCandidateHasRequiredField(result, selectionAudit.selected_candidate_id, field));
    }
  }
  if (planRequired) {
    requireField("plan_pass", hasCompletionEvidence(result, [
      "plan_pass",
      "plan_passed",
      "plan_summary",
      "planning_summary",
      "planned_steps",
      "reasoning_plan",
      "plan",
    ]));
  }
  if (planQualityGateRequired) {
    for (const field of planQualityRequiredFields) {
      requireField(`plan_quality_${field}`, completionPlanQualityGateHasField(result, field));
    }
    const plannedStepCount = readCompletionPlannedStepCount(result);
    if (planQualityMaxSteps !== null && plannedStepCount !== null && plannedStepCount > planQualityMaxSteps) {
      requireField("plan_step_budget", false);
      warnings.push(`Plan pass listed ${plannedStepCount} planned step(s), above the compact limit ${planQualityMaxSteps}.`);
    }
  }
  if (verificationRequired) {
    requireField("verification_pass", hasCompletionEvidence(result, [
      "verification_pass",
      "verification_passed",
      "verification_summary",
      "verification_evidence",
      "test_results",
      "checks",
      "evidence",
      "evidence_refs",
      "validated_by",
    ]));
  }
  if (branchSearchRequired) {
    requireField("branch_search", hasCompletionEvidence(result, [
      "branch_search",
      "branch_search_summary",
      "branch_evaluation",
      "branch_evaluations",
      "pruned_branches",
      "environment_feedback",
    ]));
  }
  if (budgetForcingRequired) {
    requireField("budget_forcing_review", hasCompletionEvidence(result, [
      "budget_forcing_review",
      "forced_second_look",
      "second_look_summary",
      "revision_summary",
      "final_answer_delta",
      "changed_decision",
    ]));
  }
  if ((policyEvidenceRequired || qualityBiased) && requiredFields.length === 0) {
    requireField("evidence_summary", hasCompletionEvidence(result, [
      "evidence",
      "evidence_refs",
      "evidence_summary",
      "verification_summary",
      "checks",
      "test_results",
    ]));
  }

  if (missingFields.length > 0) {
    warnings.push("Completion accepted, but reasoning-policy evidence is incomplete; review before treating as verified.");
  }
  if (
    candidateRequirement !== null &&
    candidateRequirement > 1 &&
    observedCandidateCount !== null &&
    observedCandidateCount < candidateRequirement
  ) {
    warnings.push(`Observed ${observedCandidateCount} candidate(s), below required ${candidateRequirement}.`);
  }
  if (evidenceRerank && selectionAudit.selection_rationale_present && !completionSelectionAuditIsSatisfied(selectionAudit)) {
    warnings.push(
      "Selection rationale is present, but the chosen candidate is not grounded in the candidate evidence."
    );
  }
  if (verifierRequiredSelectedFields.some((field) => missingFields.includes(field))) {
    warnings.push("Selected candidate is missing required verifier rerank fields.");
  }
  if (missingFields.some((field) => field.startsWith("plan_quality_"))) {
    warnings.push("Plan quality gate is incomplete; constraints, rollback, or evidence mapping may have been skipped.");
  }

  return {
    required: true,
    status: missingFields.length === 0 ? "satisfied" : "needs_review",
    required_candidate_count: candidateRequirement && candidateRequirement > 1 ? candidateRequirement : null,
    observed_candidate_count: observedCandidateCount,
    selection: selectionAudit,
    required_fields: requiredFields,
    satisfied_fields: satisfiedFields,
    missing_fields: missingFields,
    warnings,
  };
}

type CompletionCandidateEvidence = {
  id: string;
  selected: boolean;
  has_evidence: boolean;
};

function readVerifierRerankRequiredSelectedFields(execution: Record<string, unknown>): string[] {
  const computePolicy = readTaskReasoningComputePolicy(execution);
  const verifierRerank = readPlainObject(computePolicy?.verifier_rerank);
  return [...new Set(asStringArrayForStorage(verifierRerank?.required_selected_fields))];
}

function buildCompletionSelectionAudit(
  result: Record<string, unknown>,
  observedCandidateCount: number | null,
  strategy: string | null
): TaskCompletionReasoningAudit["selection"] {
  const candidates = readCompletionCandidateEvidence(result);
  const explicitSelectedId = readCompletionSelectedCandidateId(result);
  const inferredSelected = candidates.find((entry) => entry.selected) ?? null;
  const selectedCandidateId = explicitSelectedId ?? inferredSelected?.id ?? null;
  const selectedKey = normalizeCompletionCandidateId(selectedCandidateId);
  const selectedCandidate = selectedKey
    ? candidates.find((entry) => normalizeCompletionCandidateId(entry.id) === selectedKey) ?? null
    : inferredSelected;
  const selectedCandidateInCandidates =
    candidates.length === 0 ? null : selectedCandidate ? true : selectedCandidateId ? false : null;
  const selectedCandidateObject = readCompletionSelectedCandidateObject(result);
  const selectedCandidateHasEvidence =
    selectedCandidate?.has_evidence === true ||
    (selectedCandidateObject ? completionCandidateHasEvidence(selectedCandidateObject) : false);
  return {
    strategy,
    selection_rationale_present: hasCompletionEvidence(result, [
      "selection_rationale",
      "rerank_rationale",
      "selected_candidate_rationale",
      "selected_candidate_reason",
    ]),
    selected_candidate_id: selectedCandidateId,
    candidate_count: observedCandidateCount,
    selected_candidate_in_candidates: selectedCandidateInCandidates,
    selected_candidate_has_evidence: selectedCandidateHasEvidence,
    evidence_scored_candidate_count: candidates.filter((entry) => entry.has_evidence).length,
  };
}

function completionSelectionAuditIsSatisfied(selection: TaskCompletionReasoningAudit["selection"]): boolean {
  if (!selection.selection_rationale_present) {
    return false;
  }
  if (!selection.selected_candidate_id) {
    return false;
  }
  if (selection.selected_candidate_in_candidates === false) {
    return false;
  }
  if ((selection.candidate_count ?? 0) > 0 && !selection.selected_candidate_has_evidence) {
    return false;
  }
  return true;
}

function readCompletionCandidateEvidence(result: Record<string, unknown>): CompletionCandidateEvidence[] {
  const candidates: CompletionCandidateEvidence[] = [];
  for (const source of completionEvidenceSources(result)) {
    for (const key of ["candidates", "candidate_paths", "options", "alternatives"]) {
      const value = source[key];
      if (!Array.isArray(value)) {
        continue;
      }
      value.forEach((entry, index) => {
        const record = readPlainObject(entry);
        if (!record) {
          candidates.push({
            id: `candidate-${index + 1}`,
            selected: false,
            has_evidence: typeof entry === "string" && entry.trim().length > 0,
          });
          return;
        }
        candidates.push({
          id: readCompletionCandidateId(record) ?? `candidate-${index + 1}`,
          selected: completionCandidateIsSelected(record),
          has_evidence: completionCandidateHasEvidence(record),
        });
      });
    }
  }
  return candidates;
}

function readCompletionSelectedCandidateId(result: Record<string, unknown>): string | null {
  for (const source of completionEvidenceSources(result)) {
    for (const key of ["selected_candidate_id", "selected_candidate", "chosen_candidate", "winner"]) {
      const value = source[key];
      const normalized = stringifyCompletionCandidateRef(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function readCompletionSelectedCandidateObject(result: Record<string, unknown>): Record<string, unknown> | null {
  for (const source of completionEvidenceSources(result)) {
    for (const key of ["selected_candidate", "chosen_candidate", "winner"]) {
      const value = readPlainObject(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function readCompletionSelectedCandidateRecords(
  result: Record<string, unknown>,
  selectedCandidateId: string | null
): Record<string, unknown>[] {
  const selectedKey = normalizeCompletionCandidateId(selectedCandidateId);
  const records: Record<string, unknown>[] = [];
  for (const source of completionEvidenceSources(result)) {
    for (const key of ["selected_candidate", "chosen_candidate", "winner"]) {
      const value = readPlainObject(source[key]);
      if (value) {
        records.push(value);
      }
    }
    for (const key of ["candidates", "candidate_paths", "options", "alternatives"]) {
      const value = source[key];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const entry of value) {
        const record = readPlainObject(entry);
        if (!record) {
          continue;
        }
        const candidateKey = normalizeCompletionCandidateId(readCompletionCandidateId(record));
        if ((selectedKey && candidateKey === selectedKey) || (!selectedKey && completionCandidateIsSelected(record))) {
          records.push(record);
        }
      }
    }
  }
  return records;
}

function completionVerifierRequiredFieldKeys(field: string): string[] {
  const normalized = field.trim();
  if (normalized === "verifier_score") {
    return ["verifier_score", "score"];
  }
  return normalized ? [normalized] : [];
}

function completionSelectedCandidateHasRequiredField(
  result: Record<string, unknown>,
  selectedCandidateId: string | null,
  field: string
): boolean {
  if (field === "selected_candidate_id") {
    return Boolean(selectedCandidateId);
  }
  if (field === "selection_rationale") {
    return hasCompletionEvidence(result, [
      "selection_rationale",
      "rerank_rationale",
      "selected_candidate_rationale",
      "selected_candidate_reason",
    ]);
  }
  const keys = completionVerifierRequiredFieldKeys(field);
  if (keys.length === 0) {
    return false;
  }
  return readCompletionSelectedCandidateRecords(result, selectedCandidateId).some((record) =>
    keys.some((key) => isCompletionEvidenceValue(record[key]))
  );
}

function completionPlanQualityFieldKeys(field: string): string[] {
  const normalized = field.trim();
  if (normalized === "constraints_covered") {
    return ["constraints_covered", "constraints_checked", "constraints_accounted_for"];
  }
  if (normalized === "rollback_noted") {
    return ["rollback_noted", "rollback_notes", "rollback_ready"];
  }
  if (normalized === "evidence_requirements_mapped") {
    return ["evidence_requirements_mapped", "evidence_map", "expected_evidence_mapped"];
  }
  return normalized ? [normalized] : [];
}

function completionPlanQualityGateHasField(result: Record<string, unknown>, field: string): boolean {
  const keys = completionPlanQualityFieldKeys(field);
  if (keys.length === 0) {
    return false;
  }
  for (const source of completionEvidenceSources(result)) {
    const nestedGates = [
      readPlainObject(source.plan_quality_gate),
      readPlainObject(source.plan_quality),
      readPlainObject(readPlainObject(source.plan_pass)?.quality_gate),
    ].filter((entry): entry is Record<string, unknown> => entry !== null);
    for (const gate of nestedGates) {
      if (keys.some((key) => isCompletionEvidenceValue(gate[key]))) {
        return true;
      }
    }
    if (keys.some((key) => isCompletionEvidenceValue(source[key]))) {
      return true;
    }
  }
  return false;
}

function readCompletionCandidateId(candidate: Record<string, unknown>): string | null {
  for (const key of ["id", "candidate_id", "label", "name", "key", "path_id", "title"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function stringifyCompletionCandidateRef(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const record = readPlainObject(value);
  return record ? readCompletionCandidateId(record) : null;
}

function normalizeCompletionCandidateId(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function completionCandidateIsSelected(candidate: Record<string, unknown>): boolean {
  if (candidate.selected === true || candidate.chosen === true || candidate.winner === true) {
    return true;
  }
  for (const key of ["verdict", "status", "outcome", "decision"]) {
    const value = String(candidate[key] ?? "").trim().toLowerCase();
    if (["selected", "chosen", "winner", "accepted", "promoted"].includes(value)) {
      return true;
    }
  }
  return false;
}

function completionCandidateHasEvidence(candidate: Record<string, unknown>): boolean {
  for (const key of [
    "evidence",
    "rationale",
    "reason",
    "verification_summary",
    "verification_evidence",
    "test_results",
    "checks",
    "score",
    "verifier_score",
    "contradiction_risk",
  ]) {
    if (isCompletionEvidenceValue(candidate[key])) {
      return true;
    }
  }
  return false;
}

function readCompletionCandidateCount(result: Record<string, unknown>): number | null {
  let count: number | null = null;
  for (const source of completionEvidenceSources(result)) {
    for (const key of ["candidate_count", "reasoning_candidate_count", "reasoning_candidates"]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        count = Math.max(count ?? 0, Math.max(0, Math.round(value)));
      }
    }
    for (const key of ["candidates", "candidate_paths", "options", "alternatives"]) {
      const value = source[key];
      if (Array.isArray(value)) {
        count = Math.max(count ?? 0, value.length);
      }
    }
  }
  return count;
}

function readCompletionPlannedStepCount(result: Record<string, unknown>): number | null {
  let count: number | null = null;
  for (const source of completionEvidenceSources(result)) {
    for (const key of ["planned_step_count", "plan_step_count"]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        count = Math.max(count ?? 0, Math.max(0, Math.round(value)));
      }
    }
    for (const key of ["planned_steps", "plan_steps"]) {
      const value = source[key];
      if (Array.isArray(value)) {
        count = Math.max(count ?? 0, value.length);
      }
    }
  }
  return count;
}

function hasCompletionEvidence(result: Record<string, unknown>, keys: string[]): boolean {
  for (const source of completionEvidenceSources(result)) {
    for (const key of keys) {
      if (isCompletionEvidenceValue(source[key])) {
        return true;
      }
    }
  }
  return false;
}

function completionEvidenceSources(result: Record<string, unknown>): Record<string, unknown>[] {
  return [
    result,
    readPlainObject(result.reasoning_policy),
    readPlainObject(result.reasoning_policy_evidence),
    readPlainObject(result.completion_evidence),
  ].filter((entry): entry is Record<string, unknown> => entry !== null);
}

function isCompletionEvidenceValue(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
}

function readPlainObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function compactStorageSingleLine(value: unknown, limit = 240): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function asFiniteNumberForStorage(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asStringArrayForStorage(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
}

function summarizeTaskReasoningPolicy(
  rows: Array<Record<string, unknown>>,
  completionReview: TaskSummaryRecord["reasoning_policy"]["completion_review"]
): TaskSummaryRecord["reasoning_policy"] {
  const summary: TaskSummaryRecord["reasoning_policy"] = {
    pending_count: 0,
    running_count: 0,
    total_active_count: 0,
    evidence_rerank_count: 0,
    plan_pass_count: 0,
    verification_pass_count: 0,
    branch_search_count: 0,
    budget_forcing_count: 0,
    total_candidate_count: 0,
    max_candidate_count: 0,
    high_compute_task_ids: [],
    completion_review: completionReview,
  };
  for (const row of rows) {
    const metadata = parseJsonObject(row.metadata_json);
    const execution =
      metadata.task_execution && typeof metadata.task_execution === "object" && !Array.isArray(metadata.task_execution)
        ? (metadata.task_execution as Record<string, unknown>)
        : {};
    const candidateCount = resolveTaskReasoningCandidateRequirement(execution) ?? 0;
    const evidenceRerank = resolveTaskReasoningSelectionStrategy(execution) === "evidence_rerank";
    const planPass = execution.require_plan_pass === true;
    const verificationPass = execution.require_verification_pass === true;
    const branchSearch = taskReasoningComputePolicyRequiresBranchSearch(execution);
    const budgetForcing = taskReasoningComputePolicyRequiresBudgetForcing(execution);
    const taskKind = String(execution.task_kind ?? "").trim();
    const qualityPreference = String(execution.quality_preference ?? "").trim();
    const qualityBiased =
      qualityPreference === "quality" && (taskKind === "research" || taskKind === "verification");
    const highCompute =
      candidateCount > 1 ||
      evidenceRerank ||
      planPass ||
      verificationPass ||
      taskReasoningComputePolicyRequiresEvidence(execution) ||
      branchSearch ||
      budgetForcing ||
      qualityBiased;
    if (!highCompute) {
      continue;
    }
    const status = normalizeTaskStatus(row.status);
    if (status === "pending") {
      summary.pending_count += 1;
    } else if (status === "running") {
      summary.running_count += 1;
    }
    summary.total_active_count += 1;
    if (evidenceRerank) {
      summary.evidence_rerank_count += 1;
    }
    if (planPass) {
      summary.plan_pass_count += 1;
    }
    if (verificationPass) {
      summary.verification_pass_count += 1;
    }
    if (branchSearch) {
      summary.branch_search_count += 1;
    }
    if (budgetForcing) {
      summary.budget_forcing_count += 1;
    }
    summary.total_candidate_count += candidateCount;
    summary.max_candidate_count = Math.max(summary.max_candidate_count, candidateCount);
    if (summary.high_compute_task_ids.length < 10) {
      summary.high_compute_task_ids.push(String(row.task_id ?? ""));
    }
  }
  return summary;
}

function summarizeTaskCompletionReasoningReview(
  rows: Array<Record<string, unknown>>
): TaskSummaryRecord["reasoning_policy"]["completion_review"] {
  const summary: TaskSummaryRecord["reasoning_policy"]["completion_review"] = {
    audited_completed_count: 0,
    needs_review_count: 0,
    satisfied_count: 0,
    missing_field_counts: {},
    needs_review_task_ids: [],
    last_needs_review_task_id: null,
    last_needs_review_at: null,
  };

  for (const row of rows) {
    const result = parseNullableJsonObject(row.result_json);
    const audit = readPlainObject(result?.reasoning_policy_audit);
    if (audit?.required !== true) {
      continue;
    }
    summary.audited_completed_count += 1;
    const status = String(audit.status ?? "").trim();
    if (status === "satisfied") {
      summary.satisfied_count += 1;
      continue;
    }
    if (status !== "needs_review") {
      continue;
    }
    summary.needs_review_count += 1;
    const taskId = String(row.task_id ?? "").trim();
    if (!summary.last_needs_review_task_id) {
      summary.last_needs_review_task_id = taskId || null;
      summary.last_needs_review_at = asNullableString(row.updated_at);
    }
    if (taskId && summary.needs_review_task_ids.length < 10) {
      summary.needs_review_task_ids.push(taskId);
    }
    const missingFields = Array.isArray(audit.missing_fields) ? audit.missing_fields : [];
    for (const field of missingFields) {
      const key = String(field ?? "").trim();
      if (!key) {
        continue;
      }
      summary.missing_field_counts[key] = (summary.missing_field_counts[key] ?? 0) + 1;
    }
  }

  return summary;
}

function mapTaskEventRow(row: Record<string, unknown>): TaskEventRecord {
  return {
    id: String(row.id ?? ""),
    task_id: String(row.task_id ?? ""),
    created_at: String(row.created_at ?? ""),
    event_type: String(row.event_type ?? ""),
    from_status:
      row.from_status === null || row.from_status === undefined
        ? null
        : normalizeTaskStatus(row.from_status),
    to_status:
      row.to_status === null || row.to_status === undefined
        ? null
        : normalizeTaskStatus(row.to_status),
    worker_id: asNullableString(row.worker_id),
    summary: asNullableString(row.summary),
    details: parseJsonObject(row.details_json),
  };
}

function mapRuntimeWorkerSessionRow(row: Record<string, unknown>): RuntimeWorkerSessionRecord {
  return {
    session_id: String(row.session_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    runtime_id: normalizeRuntimeWorkerRuntimeId(row.runtime_id),
    status: normalizeRuntimeWorkerSessionStatus(row.status),
    task_id: asNullableString(row.task_id),
    goal_id: asNullableString(row.goal_id),
    plan_id: asNullableString(row.plan_id),
    step_id: asNullableString(row.step_id),
    worker_id: String(row.worker_id ?? ""),
    title: String(row.title ?? ""),
    objective: String(row.objective ?? ""),
    repo_root: String(row.repo_root ?? ""),
    project_dir: String(row.project_dir ?? ""),
    worktree_path: String(row.worktree_path ?? ""),
    branch_name: asNullableString(row.branch_name),
    tmux_session_name: String(row.tmux_session_name ?? ""),
    transcript_path: asNullableString(row.transcript_path),
    brief_path: asNullableString(row.brief_path),
    last_command_at: asNullableString(row.last_command_at),
    last_activity_at: asNullableString(row.last_activity_at),
    last_error: asNullableString(row.last_error),
    metadata: parseJsonObject(row.metadata_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapTriChatThreadRow(row: Record<string, unknown>): TriChatThreadRecord {
  return {
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    title: asNullableString(row.title),
    status: normalizeTriChatThreadStatus(row.status),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatMessageRow(row: Record<string, unknown>): TriChatMessageRecord {
  return {
    message_id: String(row.message_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    agent_id: String(row.agent_id ?? ""),
    role: String(row.role ?? ""),
    content: String(row.content ?? ""),
    reply_to_message_id: asNullableString(row.reply_to_message_id),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatTurnRow(row: Record<string, unknown>): TriChatTurnRecord {
  return {
    turn_id: String(row.turn_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    user_message_id: String(row.user_message_id ?? ""),
    user_prompt: String(row.user_prompt ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    started_at: String(row.started_at ?? ""),
    finished_at: asNullableString(row.finished_at),
    status: normalizeTriChatTurnStatus(row.status),
    phase: normalizeTriChatTurnPhase(row.phase),
    phase_status: normalizeTriChatTurnPhaseStatus(row.phase_status),
    expected_agents: safeParseJsonArray(row.expected_agents_json),
    min_agents: parseBoundedInt(row.min_agents, 3, 1, 12),
    novelty_score:
      typeof row.novelty_score === "number" && Number.isFinite(row.novelty_score)
        ? Number(row.novelty_score)
        : row.novelty_score === null || row.novelty_score === undefined
          ? null
          : Number.isFinite(Number(row.novelty_score))
            ? Number(row.novelty_score)
            : null,
    novelty_threshold:
      typeof row.novelty_threshold === "number" && Number.isFinite(row.novelty_threshold)
        ? Number(row.novelty_threshold)
        : row.novelty_threshold === null || row.novelty_threshold === undefined
          ? null
          : Number.isFinite(Number(row.novelty_threshold))
            ? Number(row.novelty_threshold)
            : null,
    retry_required: Number(row.retry_required ?? 0) === 1,
    retry_agents: safeParseJsonArray(row.retry_agents_json),
    disagreement: Number(row.disagreement ?? 0) === 1,
    decision_summary: asNullableString(row.decision_summary),
    selected_agent: asNullableString(row.selected_agent),
    selected_strategy: asNullableString(row.selected_strategy),
    verify_status: asNullableString(row.verify_status),
    verify_summary: asNullableString(row.verify_summary),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatTurnArtifactRow(row: Record<string, unknown>): TriChatTurnArtifactRecord {
  return {
    artifact_id: String(row.artifact_id ?? ""),
    turn_id: String(row.turn_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    phase: normalizeTriChatTurnPhase(row.phase),
    artifact_type: String(row.artifact_type ?? ""),
    agent_id: asNullableString(row.agent_id),
    content: asNullableString(row.content),
    structured: parseJsonObject(row.structured_json),
    score:
      typeof row.score === "number" && Number.isFinite(row.score)
        ? Number(row.score)
        : row.score === null || row.score === undefined
          ? null
          : Number.isFinite(Number(row.score))
            ? Number(row.score)
            : null,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatBusEventRow(row: Record<string, unknown>): TriChatBusEventRecord {
  return {
    event_seq: Number(row.event_seq ?? 0),
    event_id: String(row.event_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    source_agent: asNullableString(row.source_agent),
    source_client: asNullableString(row.source_client),
    event_type: String(row.event_type ?? ""),
    role: asNullableString(row.role),
    content: asNullableString(row.content),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatAdapterStateRow(row: Record<string, unknown>): TriChatAdapterStateRecord {
  const openUntil = asNullableString(row.open_until);
  const rawOpen = Number(row.open ?? 0) === 1;
  return {
    agent_id: String(row.agent_id ?? ""),
    channel: normalizeTriChatAdapterChannel(row.channel),
    updated_at: String(row.updated_at ?? ""),
    open: isTriChatCircuitOpen(rawOpen, openUntil),
    open_until: openUntil,
    failure_count: Number(row.failure_count ?? 0),
    trip_count: Number(row.trip_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    last_error: asNullableString(row.last_error),
    last_opened_at: asNullableString(row.last_opened_at),
    turn_count: Number(row.turn_count ?? 0),
    degraded_turn_count: Number(row.degraded_turn_count ?? 0),
    last_result: asNullableString(row.last_result),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function isTriChatCircuitOpen(open: boolean, openUntil: string | null): boolean {
  if (!open) {
    return false;
  }
  if (!openUntil) {
    return true;
  }
  const untilEpoch = Date.parse(openUntil);
  if (!Number.isFinite(untilEpoch)) {
    return true;
  }
  return untilEpoch > Date.now();
}

function mapTriChatAdapterEventRow(row: Record<string, unknown>): TriChatAdapterEventRecord {
  return {
    event_id: String(row.event_id ?? ""),
    created_at: String(row.created_at ?? ""),
    agent_id: String(row.agent_id ?? ""),
    channel: normalizeTriChatAdapterChannel(row.channel),
    event_type: String(row.event_type ?? ""),
    open_until: asNullableString(row.open_until),
    error_text: asNullableString(row.error_text),
    details: parseJsonObject(row.details_json),
  };
}

function mapTriChatChaosEventRow(row: Record<string, unknown>): TriChatChaosEventRecord {
  return {
    event_id: String(row.event_id ?? ""),
    created_at: String(row.created_at ?? ""),
    action: String(row.action ?? ""),
    thread_id: asNullableString(row.thread_id),
    turn_id: asNullableString(row.turn_id),
    agent_id: asNullableString(row.agent_id),
    channel:
      row.channel === null || row.channel === undefined
        ? null
        : normalizeTriChatAdapterChannel(row.channel),
    outcome: String(row.outcome ?? ""),
    details: parseJsonObject(row.details_json),
  };
}

function mapTriChatSloSnapshotRow(row: Record<string, unknown>): TriChatSloSnapshotRecord {
  return {
    snapshot_id: String(row.snapshot_id ?? ""),
    created_at: String(row.created_at ?? ""),
    window_minutes: parseBoundedInt(row.window_minutes, 60, 1, 10080),
    adapter_sample_count: parseBoundedInt(row.adapter_sample_count, 0, 0, 1_000_000),
    adapter_error_count: parseBoundedInt(row.adapter_error_count, 0, 0, 1_000_000),
    adapter_error_rate: clampMetricRate(row.adapter_error_rate),
    adapter_latency_p95_ms:
      typeof row.adapter_latency_p95_ms === "number" && Number.isFinite(row.adapter_latency_p95_ms)
        ? Number(row.adapter_latency_p95_ms)
        : row.adapter_latency_p95_ms === null || row.adapter_latency_p95_ms === undefined
          ? null
          : Number.isFinite(Number(row.adapter_latency_p95_ms))
            ? Number(row.adapter_latency_p95_ms)
            : null,
    turn_total_count: parseBoundedInt(row.turn_total_count, 0, 0, 1_000_000),
    turn_failed_count: parseBoundedInt(row.turn_failed_count, 0, 0, 1_000_000),
    turn_failure_rate: clampMetricRate(row.turn_failure_rate),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function normalizeTrustTier(value: unknown): TrustTier {
  const normalized = String(value ?? "raw");
  if (normalized === "verified" || normalized === "policy-backed" || normalized === "deprecated") {
    return normalized;
  }
  return "raw";
}

function normalizeGoalStatus(value: unknown): GoalStatus {
  const normalized = String(value ?? "draft");
  if (
    normalized === "active" ||
    normalized === "blocked" ||
    normalized === "waiting" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "cancelled" ||
    normalized === "archived"
  ) {
    return normalized;
  }
  return "draft";
}

function normalizeGoalRiskTier(value: unknown): GoalRiskTier {
  const normalized = String(value ?? "medium");
  if (normalized === "low" || normalized === "high" || normalized === "critical") {
    return normalized;
  }
  return "medium";
}

function normalizeGoalAutonomyMode(value: unknown): GoalAutonomyMode {
  const normalized = String(value ?? "recommend");
  if (
    normalized === "observe" ||
    normalized === "stage" ||
    normalized === "execute_bounded" ||
    normalized === "execute_destructive_with_approval"
  ) {
    return normalized;
  }
  return "recommend";
}

function normalizePlanStatus(value: unknown): PlanStatus {
  const normalized = String(value ?? "draft");
  if (
    normalized === "candidate" ||
    normalized === "selected" ||
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "invalidated" ||
    normalized === "archived"
  ) {
    return normalized;
  }
  return "draft";
}

function normalizePlanPlannerKind(value: unknown): PlanPlannerKind {
  const normalized = String(value ?? "core");
  if (normalized === "pack" || normalized === "human" || normalized === "trichat") {
    return normalized;
  }
  return "core";
}

function normalizePlanStepStatus(value: unknown): PlanStepStatus {
  const normalized = String(value ?? "pending");
  if (
    normalized === "ready" ||
    normalized === "running" ||
    normalized === "blocked" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "skipped" ||
    normalized === "invalidated"
  ) {
    return normalized;
  }
  return "pending";
}

function normalizePlanStepKind(value: unknown): PlanStepKind {
  const normalized = String(value ?? "analysis");
  if (
    normalized === "mutation" ||
    normalized === "verification" ||
    normalized === "decision" ||
    normalized === "handoff"
  ) {
    return normalized;
  }
  return "analysis";
}

function normalizeOptionalPlanExecutorKind(value: unknown): PlanExecutorKind | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value);
  if (
    normalized === "tool" ||
    normalized === "task" ||
    normalized === "worker" ||
    normalized === "human" ||
    normalized === "trichat"
  ) {
    return normalized;
  }
  return null;
}

function normalizeUpdatedPlanStatus(
  existing: PlanRecord,
  nextStatus: PlanStatus | undefined,
  nextSelected: boolean | undefined
): PlanStatus {
  if (nextStatus !== undefined) {
    return normalizePlanStatus(nextStatus);
  }
  if (nextSelected === true && existing.status !== "selected" && existing.status !== "in_progress") {
    return "selected";
  }
  if (nextSelected === false && existing.status === "selected") {
    return "candidate";
  }
  return existing.status;
}

function derivePlanProgressStatus(existing: PlanStatus, steps: PlanStepRecord[]): PlanStatus {
  if (existing === "invalidated" || existing === "archived") {
    return existing;
  }
  if (steps.length === 0) {
    return existing;
  }
  const statuses = steps.map((step) => step.status);
  if (statuses.every((status) => status === "completed" || status === "skipped")) {
    return "completed";
  }
  if (
    statuses.some(
      (status) =>
        status === "running" ||
        status === "completed" ||
        status === "failed" ||
        status === "skipped" ||
        status === "invalidated"
    )
  ) {
    return "in_progress";
  }
  return existing;
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  const normalized = String(value ?? "pending");
  if (normalized === "running" || normalized === "completed" || normalized === "failed" || normalized === "cancelled") {
    return normalized;
  }
  return "pending";
}

function normalizeRuntimeWorkerRuntimeId(value: unknown): RuntimeWorkerRuntimeId {
  const normalized = String(value ?? "codex").trim().toLowerCase();
  if (normalized === "shell") {
    return "shell";
  }
  return "codex";
}

function normalizeRuntimeWorkerSessionStatus(value: unknown): RuntimeWorkerSessionStatus {
  const normalized = String(value ?? "launching").trim().toLowerCase();
  if (
    normalized === "running" ||
    normalized === "idle" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "stopped"
  ) {
    return normalized;
  }
  return "launching";
}

function normalizeAgentSessionStatus(value: unknown): AgentSessionStatus {
  const normalized = String(value ?? "active");
  if (
    normalized === "active" ||
    normalized === "idle" ||
    normalized === "busy" ||
    normalized === "expired" ||
    normalized === "closed" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return "active";
}

function normalizeAgentLearningEntryStatus(value: unknown): AgentLearningEntryStatus {
  const normalized = String(value ?? "active");
  if (normalized === "suppressed") {
    return "suppressed";
  }
  return "active";
}

function normalizeAgentLearningEntryKind(value: unknown): AgentLearningEntryKind {
  const normalized = String(value ?? "execution_pattern");
  if (
    normalized === "delegation_pattern" ||
    normalized === "verification_pattern" ||
    normalized === "failure_pattern" ||
    normalized === "guardrail"
  ) {
    return normalized;
  }
  return "execution_pattern";
}

function normalizeAgentLearningEntryPolarity(value: unknown): AgentLearningEntryPolarity {
  const normalized = String(value ?? "prefer");
  if (normalized === "avoid") {
    return "avoid";
  }
  return "prefer";
}

function normalizeArtifactStatus(value: unknown): ArtifactStatus {
  const normalized = String(value ?? "active");
  if (normalized === "superseded" || normalized === "invalid" || normalized === "archived") {
    return normalized;
  }
  return "active";
}

function normalizeArtifactTrustTier(value: unknown): ArtifactTrustTier {
  const normalized = String(value ?? "raw");
  if (
    normalized === "derived" ||
    normalized === "verified" ||
    normalized === "policy-backed" ||
    normalized === "deprecated"
  ) {
    return normalized;
  }
  return "raw";
}

function normalizeExperimentStatus(value: unknown): ExperimentStatus {
  const normalized = String(value ?? "active");
  if (normalized === "draft" || normalized === "paused" || normalized === "completed" || normalized === "archived") {
    return normalized;
  }
  return "active";
}

function normalizeExperimentMetricDirection(value: unknown): ExperimentMetricDirection {
  return String(value ?? "minimize") === "maximize" ? "maximize" : "minimize";
}

function normalizeExperimentRunStatus(value: unknown): ExperimentRunStatus {
  const normalized = String(value ?? "proposed");
  if (normalized === "running" || normalized === "completed" || normalized === "crash" || normalized === "discarded") {
    return normalized;
  }
  return "proposed";
}

function normalizeOptionalExperimentVerdict(value: unknown): ExperimentVerdict | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value);
  if (normalized === "accepted" || normalized === "rejected" || normalized === "inconclusive" || normalized === "crash") {
    return normalized;
  }
  return null;
}

function normalizePackHookKind(value: unknown): PackHookKind {
  return String(value ?? "planner") === "verifier" ? "verifier" : "planner";
}

function normalizePackHookRunStatus(value: unknown): PackHookRunStatus {
  const normalized = String(value ?? "running");
  if (normalized === "completed" || normalized === "failed") {
    return normalized;
  }
  return "running";
}

function normalizeTriChatThreadStatus(value: unknown): TriChatThreadStatus {
  return String(value ?? "active") === "archived" ? "archived" : "active";
}

function normalizeTriChatTurnStatus(value: unknown): TriChatTurnStatus {
  const normalized = String(value ?? "running");
  if (normalized === "completed" || normalized === "failed" || normalized === "cancelled") {
    return normalized;
  }
  return "running";
}

function normalizeTriChatTurnPhase(value: unknown): TriChatTurnPhase {
  const normalized = String(value ?? "plan");
  if (
    normalized === "propose" ||
    normalized === "critique" ||
    normalized === "merge" ||
    normalized === "execute" ||
    normalized === "verify" ||
    normalized === "summarize"
  ) {
    return normalized;
  }
  return "plan";
}

function normalizeTriChatTurnPhaseStatus(value: unknown): TriChatTurnPhaseStatus {
  const normalized = String(value ?? "running");
  if (normalized === "completed" || normalized === "failed" || normalized === "skipped") {
    return normalized;
  }
  return "running";
}

function normalizeTriChatAdapterChannel(value: unknown): TriChatAdapterChannel {
  return String(value ?? "model") === "command" ? "command" : "model";
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeKeywords(keywords: string[] | undefined): string[] {
  if (!keywords) {
    return [];
  }
  const unique = new Set<string>();
  for (const keyword of keywords) {
    const normalized = keyword.trim().toLowerCase();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function dedupeNonEmpty(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function normalizeProviderBridgeDiagnosticSnapshot(value: unknown): ProviderBridgeDiagnosticSnapshotRecord | null {
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const clientId = asNullableString(record.client_id)?.trim() || null;
  const displayName = asNullableString(record.display_name)?.trim() || null;
  const status = asNullableString(record.status)?.trim() || null;
  if (!clientId || !displayName) {
    return null;
  }
  if (status !== "connected" && status !== "disconnected" && status !== "configured" && status !== "unavailable") {
    return null;
  }
  return {
    client_id: clientId,
    display_name: displayName,
    office_agent_id: asNullableString(record.office_agent_id)?.trim() || null,
    available: record.available === true,
    runtime_probed: record.runtime_probed === true,
    connected: typeof record.connected === "boolean" ? record.connected : null,
    status,
    detail: asNullableString(record.detail)?.trim() || "",
    notes: dedupeNonEmpty(Array.isArray(record.notes) ? record.notes.map((entry: unknown) => String(entry ?? "")) : []),
    command: asNullableString(record.command)?.trim() || null,
    config_path: asNullableString(record.config_path)?.trim() || null,
  };
}

function parseKeywords(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeParseJsonArray(value: unknown): string[] {
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    }
  } catch {
    return [];
  }
  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    return {};
  }
  return {};
}

function parseLooseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return parseJsonObject(value);
}

function parseNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseJsonUnknown(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resolveStorageGuardOptions(dbPath: string): StorageGuardOptions {
  const dbDir = path.dirname(dbPath);
  const backupDirRaw = String(process.env.ANAMNESIS_HUB_BACKUP_DIR ?? "").trim();
  const backupDir = backupDirRaw ? path.resolve(backupDirRaw) : path.join(dbDir, "backups");
  return {
    backup_dir: backupDir,
    backup_keep: parseBoundedInt(process.env.ANAMNESIS_HUB_BACKUP_KEEP, 6, 1, 500),
    backup_max_total_bytes: parseBoundedInt(
      process.env.ANAMNESIS_HUB_BACKUP_MAX_TOTAL_BYTES,
      96 * 1024 * 1024 * 1024,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    backup_min_interval_seconds: parseBoundedInt(
      process.env.ANAMNESIS_HUB_BACKUP_MIN_INTERVAL_SECONDS,
      21600,
      0,
      604800
    ),
    startup_backup_enabled: parseBoolean(process.env.ANAMNESIS_HUB_STARTUP_BACKUP, true),
    startup_backup_max_bytes: parseBoundedInt(
      process.env.ANAMNESIS_HUB_STARTUP_BACKUP_MAX_BYTES,
      512 * 1024 * 1024,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    startup_quick_check_enabled: parseBoolean(process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_ON_START, true),
    startup_quick_check_max_bytes: parseBoundedInt(
      process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES,
      512 * 1024 * 1024,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    auto_restore_from_backup: parseBoolean(process.env.ANAMNESIS_HUB_AUTO_RESTORE_FROM_BACKUP, true),
    allow_fresh_on_corruption: parseBoolean(process.env.ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION, false),
    quarantine_dir: path.join(dbDir, "corrupt"),
  };
}

function guardDatabasePathBeforeOpen(dbPath: string, options: StorageGuardOptions): StorageGuardOutcome {
  const outcome: StorageGuardOutcome = {
    quarantined_paths: [],
    restored_from_backup: null,
  };
  if (dbPath === ":memory:") {
    return outcome;
  }
  if (!fs.existsSync(dbPath)) {
    return outcome;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch (error) {
    throw new Error(`Unable to stat database path ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.size === 0) {
    return outcome;
  }
  if (hasSqliteHeader(dbPath)) {
    return outcome;
  }

  const quarantined = quarantineDatabaseArtifacts(dbPath, options, "invalid-header");
  outcome.quarantined_paths.push(...quarantined);
  writeStorageGuardLog(
    `[storage] non-SQLite header detected at ${dbPath}; quarantined ${quarantined.length} artifact(s).`
  );

  if (options.auto_restore_from_backup) {
    const restoredFrom = restoreLatestDatabaseBackup(dbPath, options);
    if (restoredFrom) {
      outcome.restored_from_backup = restoredFrom;
      return outcome;
    }
  }

  if (!options.allow_fresh_on_corruption) {
    throw new Error(
      [
        `Database file ${dbPath} is not a valid SQLite file and no backup was restored from ${options.backup_dir}.`,
        `Set ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION=1 to allow an empty database bootstrap (data loss).`,
      ].join(" ")
    );
  }
  return outcome;
}

function openDatabaseWithGuard(dbPath: string, options: StorageGuardOptions): Database.Database {
  try {
    return new Database(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCorruption = /SQLITE_CORRUPT|malformed|file is not a database|disk image is malformed/i.test(message);
    if (!isCorruption) {
      throw error;
    }

    writeStorageGuardLog(`[storage] open failed due to corruption at ${dbPath}: ${message}`);
    const quarantined = quarantineDatabaseArtifacts(dbPath, options, "open-failed");
    if (quarantined.length > 0) {
      writeStorageGuardLog(`[storage] quarantined after open failure: ${quarantined.join(", ")}`);
    }

    if (options.auto_restore_from_backup) {
      const restoredFrom = restoreLatestDatabaseBackup(dbPath, options);
      if (restoredFrom) {
        writeStorageGuardLog(`[storage] restored from backup after open failure: ${restoredFrom}`);
        return new Database(dbPath);
      }
    }

    if (!options.allow_fresh_on_corruption) {
      throw new Error(
        [
          `Unable to open SQLite database at ${dbPath}; corruption detected and no backup could be restored.`,
          `Set ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION=1 only if you intentionally want a fresh database.`,
        ].join(" ")
      );
    }

    removeDatabaseArtifacts(dbPath);
    writeStorageGuardLog(`[storage] opening fresh empty database at ${dbPath} after unrecoverable corruption.`);
    return new Database(dbPath);
  }
}

function runQuickCheck(db: Database.Database): { ok: boolean; reason: string } {
  try {
    const value = String(db.pragma("quick_check", { simple: true }) ?? "").trim();
    if (!value || value.toLowerCase() === "ok") {
      return { ok: true, reason: "ok" };
    }
    return { ok: false, reason: value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function runLargeDatabaseStartupProbe(db: Database.Database): { ok: boolean; reason: string } {
  try {
    const schemaVersion = Number(db.pragma("schema_version", { simple: true }) ?? 0);
    const rows = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name ASC
         LIMIT 256`
      )
      .all() as Array<Record<string, unknown>>;
    const tableNames = rows
      .map((row) => String(row?.name ?? "").trim())
      .filter(Boolean);
    const firstObject = tableNames[0] || "none";
    const criticalTables = [
      "system_state",
      "agent_sessions",
      "tasks",
      "runtime_worker_sessions",
      "observability_documents",
      "trichat_threads",
      "trichat_messages",
    ].filter((tableName) => tableNames.includes(tableName));
    const probedTables: string[] = [];
    for (const tableName of criticalTables) {
      const result = String(db.pragma(`integrity_check(${tableName})`, { simple: true }) ?? "").trim();
      if (result && result.toLowerCase() !== "ok") {
        return {
          ok: false,
          reason: `${tableName}:${result}`,
        };
      }
      probedTables.push(tableName);
    }
    return {
      ok: true,
      reason: `large-db probe ok (schema_version=${schemaVersion}, first_object=${firstObject}, probed_tables=${probedTables.join("|") || "none"})`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function runStartupIntegrityProbe(
  db: Database.Database,
  dbPath: string,
  options: StorageGuardOptions
): { ok: boolean; reason: string; mode: "quick_check" | "large_db_probe" } {
  const dbSizeBytes = databaseArtifactBytes(dbPath);
  if (options.startup_quick_check_max_bytes > 0 && dbSizeBytes > options.startup_quick_check_max_bytes) {
    const probe = runLargeDatabaseStartupProbe(db);
    return {
      ...probe,
      mode: "large_db_probe",
    };
  }
  return {
    ...runQuickCheck(db),
    mode: "quick_check",
  };
}

function probeDatabaseSnapshotIntegrity(
  snapshotPath: string,
  options: StorageGuardOptions
): { ok: boolean; reason: string; mode: "quick_check" | "large_db_probe" } {
  let db: Database.Database | null = null;
  try {
    db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    return runStartupIntegrityProbe(db, snapshotPath, options);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      mode: "large_db_probe",
    };
  } finally {
    if (db) {
      safeCloseDatabase(db);
    }
  }
}

function hasSqliteHeader(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const fd = fs.openSync(dbPath, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < SQLITE_HEADER.length) {
      return false;
    }
    return header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

function quarantineDatabaseArtifacts(dbPath: string, options: StorageGuardOptions, reason: string): string[] {
  if (dbPath === ":memory:") {
    return [];
  }
  fs.mkdirSync(options.quarantine_dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffixes = ["", "-wal", "-shm"];
  const moved: string[] = [];
  for (const suffix of suffixes) {
    const artifactPath = `${dbPath}${suffix}`;
    if (!fs.existsSync(artifactPath)) {
      continue;
    }
    const artifactName = path.basename(artifactPath);
    const targetPath = path.join(options.quarantine_dir, `${artifactName}.${stamp}.${reason}`);
    moveFileWithFallback(artifactPath, targetPath);
    moved.push(targetPath);
  }
  return moved;
}

function restoreLatestDatabaseBackup(dbPath: string, options: StorageGuardOptions): string | null {
  if (dbPath === ":memory:") {
    return null;
  }
  if (!fs.existsSync(options.backup_dir)) {
    return null;
  }
  const base = path.basename(dbPath);
  const candidates = fs
    .readdirSync(options.backup_dir)
    .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".sqlite"))
    .map((entry) => path.join(options.backup_dir, entry))
    .filter((entry) => fs.existsSync(entry))
    .sort((left, right) => {
      const leftMs = safeMtimeMs(left);
      const rightMs = safeMtimeMs(right);
      return rightMs - leftMs;
    });

  for (const selected of candidates) {
    const probe = probeDatabaseSnapshotIntegrity(selected, options);
    if (!probe.ok) {
      writeStorageGuardLog(`[storage] skipped corrupt backup candidate ${selected}: ${probe.reason}`);
      continue;
    }
    removeDatabaseArtifacts(dbPath);
    fs.copyFileSync(selected, dbPath);
    copyDatabaseSnapshotAuxiliaryArtifacts(selected, dbPath);
    const restoredProbe = probeDatabaseSnapshotIntegrity(dbPath, options);
    if (!restoredProbe.ok) {
      writeStorageGuardLog(
        `[storage] backup candidate ${selected} failed after restore copy: ${restoredProbe.reason}`
      );
      removeDatabaseArtifacts(dbPath);
      continue;
    }
    return selected;
  }
  return null;
}

function removeDatabaseArtifacts(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    removeFileIfExists(`${dbPath}${suffix}`);
  }
}

function databaseArtifactBytes(dbPath: string): number {
  if (dbPath === ":memory:") {
    return 0;
  }
  const suffixes = ["", "-wal", "-shm"];
  let total = 0;
  for (const suffix of suffixes) {
    const filePath = `${dbPath}${suffix}`;
    try {
      total += fs.statSync(filePath).size;
    } catch {
      continue;
    }
  }
  return total;
}

function databaseArtifactLatestMtimeMs(dbPath: string): number {
  if (dbPath === ":memory:") {
    return 0;
  }
  const suffixes = ["", "-wal", "-shm"];
  let latest = 0;
  for (const suffix of suffixes) {
    const filePath = `${dbPath}${suffix}`;
    try {
      latest = Math.max(latest, fs.statSync(filePath).mtimeMs);
    } catch {
      continue;
    }
  }
  return latest;
}

function classifyBackupArtifactKind(entry: string): StorageBackupArtifactKind {
  if (entry.endsWith(".tmp.sqlite")) {
    return "temp";
  }
  if (entry.endsWith(".tmp.sqlite-journal") || entry.endsWith(".sqlite-journal")) {
    return "journal";
  }
  if (entry.endsWith(".tmp.sqlite-wal") || entry.endsWith(".sqlite-wal")) {
    return "wal";
  }
  if (entry.endsWith(".tmp.sqlite-shm") || entry.endsWith(".sqlite-shm")) {
    return "shm";
  }
  if (entry.endsWith(".sqlite")) {
    return "snapshot";
  }
  return "other";
}

function backupArtifactGroupKey(basename: string): string {
  if (basename.endsWith(".tmp.sqlite-journal")) {
    return basename.slice(0, -"-journal".length);
  }
  if (basename.endsWith(".tmp.sqlite-wal")) {
    return basename.slice(0, -"-wal".length);
  }
  if (basename.endsWith(".tmp.sqlite-shm")) {
    return basename.slice(0, -"-shm".length);
  }
  if (basename.endsWith(".sqlite-journal")) {
    return basename.slice(0, -"-journal".length);
  }
  if (basename.endsWith(".sqlite-wal")) {
    return basename.slice(0, -"-wal".length);
  }
  if (basename.endsWith(".sqlite-shm")) {
    return basename.slice(0, -"-shm".length);
  }
  return basename;
}

function copyDatabaseSnapshotAuxiliaryArtifacts(snapshotPath: string, dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const sourcePath = `${snapshotPath}${suffix}`;
    const targetPath = `${dbPath}${suffix}`;
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }
    removeFileIfExists(targetPath);
  }
}

function copyDatabaseArtifactsToSnapshot(dbPath: string, snapshotPath: string): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.copyFileSync(dbPath, snapshotPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sourcePath = `${dbPath}${suffix}`;
    const targetPath = `${snapshotPath}${suffix}`;
    removeFileIfExists(targetPath);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function listDatabaseBackupArtifacts(dbPath: string, options: StorageGuardOptions): StorageBackupArtifactRecord[] {
  if (dbPath === ":memory:" || !fs.existsSync(options.backup_dir)) {
    return [];
  }
  const base = path.basename(dbPath);
  return fs
    .readdirSync(options.backup_dir)
    .filter((entry) => entry.startsWith(`${base}.`))
    .map((entry) => path.join(options.backup_dir, entry))
    .filter((entry) => fs.existsSync(entry))
    .map((entryPath) => {
      const stats = fs.statSync(entryPath);
      return {
        path: entryPath,
        basename: path.basename(entryPath),
        kind: classifyBackupArtifactKind(path.basename(entryPath)),
        size_bytes: stats.size,
        mtime_ms: stats.mtimeMs,
        mtime_iso: Number.isFinite(stats.mtimeMs) ? new Date(stats.mtimeMs).toISOString() : null,
      } satisfies StorageBackupArtifactRecord;
    })
    .sort((left, right) => right.mtime_ms - left.mtime_ms);
}

function withDatabaseBackupLock<T>(dbPath: string, options: StorageGuardOptions, callback: () => T): T {
  const lockPath = path.join(options.backup_dir, `${path.basename(dbPath)}.lock`);
  fs.mkdirSync(options.backup_dir, { recursive: true });
  try {
    const stats = fs.statSync(lockPath);
    if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
      removeFileIfExists(lockPath);
    }
  } catch {
    // ignore missing or unreadable lock files
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
    if (code === "EEXIST") {
      throw new Error(`backup lock already held: ${lockPath}`);
    }
    throw error;
  }

  try {
    fs.writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
    return callback();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    removeFileIfExists(lockPath);
  }
}

function pruneDatabaseBackupArtifacts(
  dbPath: string,
  options: StorageGuardOptions,
  params?: {
    keep?: number;
    max_total_bytes?: number;
    dry_run?: boolean;
    temp_max_age_seconds?: number;
  }
) {
  const dryRun = params?.dry_run ?? false;
  const keep = Math.max(1, Math.min(500, params?.keep ?? options.backup_keep));
  const maxTotalBytes = Math.max(0, params?.max_total_bytes ?? options.backup_max_total_bytes);
  const tempMaxAgeMs = Math.max(0, (params?.temp_max_age_seconds ?? 900) * 1000);
  const nowMs = Date.now();
  const artifacts = listDatabaseBackupArtifacts(dbPath, options);
  const deleted: Array<{ path: string; kind: StorageBackupArtifactKind; size_bytes: number }> = [];
  const deleteArtifact = (artifact: StorageBackupArtifactRecord) => {
    if (deleted.some((entry) => entry.path === artifact.path)) {
      return;
    }
    deleted.push({ path: artifact.path, kind: artifact.kind, size_bytes: artifact.size_bytes });
    if (!dryRun) {
      removeFileIfExists(artifact.path);
    }
  };

  const bundleMap = new Map<string, StorageBackupArtifactRecord[]>();
  for (const artifact of artifacts) {
    const groupKey = backupArtifactGroupKey(artifact.basename);
    const bucket = bundleMap.get(groupKey);
    if (bucket) {
      bucket.push(artifact);
    } else {
      bundleMap.set(groupKey, [artifact]);
    }
  }
  const sortedSnapshots = artifacts.filter((entry) => entry.kind === "snapshot");
  const snapshotBundles = sortedSnapshots.map((snapshot) => {
    const bundleArtifacts = [...(bundleMap.get(snapshot.basename) ?? [snapshot])].sort((left, right) =>
      left.basename.localeCompare(right.basename)
    );
    return {
      snapshot,
      artifacts: bundleArtifacts,
      size_bytes: bundleArtifacts.reduce((sum, entry) => sum + entry.size_bytes, 0),
    };
  });
  const deleteBundle = (bundle: { artifacts: StorageBackupArtifactRecord[] }) => {
    for (const artifact of bundle.artifacts) {
      deleteArtifact(artifact);
    }
  };

  for (const artifact of artifacts) {
    if (artifact.kind === "temp" || artifact.kind === "journal" || artifact.kind === "wal" || artifact.kind === "shm") {
      const bundleArtifacts = bundleMap.get(backupArtifactGroupKey(artifact.basename)) ?? [];
      const hasSnapshotSibling = bundleArtifacts.some((entry) => entry.kind === "snapshot");
      if (!hasSnapshotSibling && nowMs - artifact.mtime_ms >= tempMaxAgeMs) {
        deleteArtifact(artifact);
      }
    }
  }

  for (const bundle of snapshotBundles.slice(keep)) {
    deleteBundle(bundle);
  }

  if (maxTotalBytes > 0) {
    const retainedBundles = snapshotBundles.filter(
      (bundle) => !deleted.some((entry) => entry.path === bundle.snapshot.path)
    );
    let retainedBytes = retainedBundles.reduce((sum, bundle) => sum + bundle.size_bytes, 0);
    let activeBundleCount = retainedBundles.length;
    for (let index = retainedBundles.length - 1; index >= 0 && retainedBytes > maxTotalBytes; index -= 1) {
      if (activeBundleCount <= 1) {
        break;
      }
      const bundle = retainedBundles[index];
      if (deleted.some((entry) => entry.path === bundle.snapshot.path)) {
        continue;
      }
      deleteBundle(bundle);
      retainedBytes -= bundle.size_bytes;
      activeBundleCount -= 1;
    }
  }

  return {
    backup_dir: options.backup_dir,
    dry_run: dryRun,
    keep,
    max_total_bytes: maxTotalBytes,
    temp_max_age_seconds: Math.floor(tempMaxAgeMs / 1000),
    deleted_count: deleted.length,
    reclaimed_bytes: deleted.reduce((sum, entry) => sum + entry.size_bytes, 0),
    deleted,
  };
}

function pruneDatabaseBackups(dbPath: string, options: StorageGuardOptions): void {
  pruneDatabaseBackupArtifacts(dbPath, options);
}

function safeCloseDatabase(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // ignore close failures during recovery flow
  }
}

function moveFileWithFallback(fromPath: string, toPath: string): void {
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  try {
    fs.renameSync(fromPath, toPath);
    return;
  } catch {
    fs.copyFileSync(fromPath, toPath);
    fs.unlinkSync(fromPath);
  }
}

function removeFileIfExists(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  fs.unlinkSync(filePath);
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function writeStorageGuardLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
      return false;
    }
  }
  return fallback;
}

function hashPayload(value: unknown): string {
  const normalized = stableStringify(value);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      sorted[key] = sortObject(entry);
    }
    return sorted;
  }
  return value;
}

function readUserVersion(db: Database.Database): number {
  const value = db.pragma("user_version", { simple: true }) as unknown;
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const bounded = Math.max(min, Math.min(max, Math.round(parsed)));
  return bounded;
}

function parseBoundedFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const bounded = Math.max(min, Math.min(max, parsed));
  return Number(bounded.toFixed(4));
}

function clampMetricRate(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  if (parsed <= 0) {
    return 0;
  }
  if (parsed >= 1) {
    return 1;
  }
  return Number(parsed.toFixed(6));
}

function computeTermScore(text: string, query?: string): number {
  if (!query) {
    return 0;
  }
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerText.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function normalizeIsoTimestamp(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed.toISOString();
}

function normalizeOptionalIsoTimestamp(value: string | null | undefined): string | null {
  const normalized = asNullableString(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}
