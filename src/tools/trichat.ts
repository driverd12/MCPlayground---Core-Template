import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import {
  Storage,
  TriChatTmuxControllerStateRecord,
  TriChatTmuxControllerTaskRecord,
} from "../storage.js";
import { commandReferencesProtectedDbArtifact } from "../path_safety.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { appendMemory } from "./memory.js";
import { runBegin, runEnd, runStep } from "./run.js";
import { acquireLock, releaseLock } from "./locks.js";
import { evaluatePolicy } from "./policy.js";
import { preflightCheck, postflightVerify } from "./verification.js";
import { simulateWorkflow } from "./simulate.js";
import { incidentOpen } from "./incident.js";
import { createAdr } from "./adr.js";
import { appendTranscript, summarizeTranscript } from "./transcript.js";
import { taskClaim, taskComplete, taskCreate, taskFail } from "./task.js";
import { ensureWorkspaceFingerprint } from "./workspace_fingerprint.js";
import {
  getTriChatActiveAgentIds,
  getTriChatBridgeCandidates,
  getTriChatBridgeEnvVar,
  getTriChatRoleLaneMap,
  getTriChatRosterSummary,
  normalizeTriChatAgentId,
} from "../trichat_roster.js";

const threadStatusSchema = z.enum(["active", "archived"]);
const adapterChannelSchema = z.enum(["command", "model"]);
const turnStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
const turnPhaseSchema = z.enum(["plan", "propose", "critique", "merge", "execute", "verify", "summarize"]);
const turnPhaseStatusSchema = z.enum(["running", "completed", "failed", "skipped"]);
const DEFAULT_CONSENSUS_AGENT_IDS = Object.freeze(getTriChatActiveAgentIds()) as readonly string[];
const DEFAULT_TURN_AGENT_IDS = [...DEFAULT_CONSENSUS_AGENT_IDS];
const BRIDGE_PROTOCOL_VERSION = "trichat-bridge-v1";
const BRIDGE_RESPONSE_KIND = "trichat.adapter.response";
const BRIDGE_PONG_KIND = "trichat.adapter.pong";
const TURN_PHASE_ORDER: ReadonlyArray<string> = [
  "plan",
  "propose",
  "critique",
  "merge",
  "execute",
  "verify",
  "summarize",
];

export const trichatThreadOpenSchema = z.object({
  mutation: mutationSchema,
  thread_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  status: threadStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatThreadListSchema = z.object({
  status: threadStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const trichatThreadGetSchema = z.object({
  thread_id: z.string().min(1),
});

export const trichatMessagePostSchema = z.object({
  mutation: mutationSchema,
  thread_id: z.string().min(1),
  agent_id: z.string().min(1),
  role: z.string().min(1),
  content: z.string().min(1),
  reply_to_message_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTimelineSchema = z.object({
  thread_id: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
  since: z.string().optional(),
  agent_id: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
});

export const trichatRetentionSchema = z.object({
  mutation: mutationSchema,
  older_than_days: z.number().int().min(0).max(3650),
  thread_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  dry_run: z.boolean().optional(),
});

export const trichatSummarySchema = z.object({
  busiest_limit: z.number().int().min(1).max(200).optional(),
});

export const trichatRosterSchema = z.object({
  agent_ids: z.array(z.string().min(1)).min(1).max(12).optional(),
  active_only: z.boolean().optional(),
});

export const trichatConsensusSchema = z.object({
  thread_id: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
  agent_ids: z.array(z.string().min(1)).min(1).max(12).optional(),
  min_agents: z.number().int().min(2).max(12).optional(),
  recent_turn_limit: z.number().int().min(1).max(50).optional(),
});

export const trichatTurnStartSchema = z.object({
  mutation: mutationSchema,
  thread_id: z.string().min(1),
  user_message_id: z.string().min(1),
  user_prompt: z.string().min(1),
  expected_agents: z.array(z.string().min(1)).min(1).max(12).optional(),
  min_agents: z.number().int().min(1).max(12).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTurnAdvanceSchema = z.object({
  mutation: mutationSchema,
  turn_id: z.string().min(1),
  status: turnStatusSchema.optional(),
  phase: turnPhaseSchema.optional(),
  phase_status: turnPhaseStatusSchema.optional(),
  expected_agents: z.array(z.string().min(1)).min(1).max(12).optional(),
  min_agents: z.number().int().min(1).max(12).optional(),
  novelty_score: z.number().min(0).max(1).nullable().optional(),
  novelty_threshold: z.number().min(0).max(1).nullable().optional(),
  retry_required: z.boolean().optional(),
  retry_agents: z.array(z.string().min(1)).max(12).optional(),
  disagreement: z.boolean().optional(),
  decision_summary: z.string().nullable().optional(),
  selected_agent: z.string().nullable().optional(),
  selected_strategy: z.string().nullable().optional(),
  verify_status: z.string().nullable().optional(),
  verify_summary: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTurnArtifactSchema = z.object({
  mutation: mutationSchema,
  turn_id: z.string().min(1),
  phase: turnPhaseSchema,
  artifact_type: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  content: z.string().optional(),
  structured: z.record(z.unknown()).optional(),
  score: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trichatTurnGetSchema = z
  .object({
    turn_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    include_closed: z.boolean().optional(),
    include_artifacts: z.boolean().optional(),
    artifact_limit: z.number().int().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.turn_id && !value.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn_id or thread_id is required",
        path: ["turn_id"],
      });
    }
  });

export const trichatWorkboardSchema = z.object({
  thread_id: z.string().min(1).optional(),
  status: turnStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const trichatNoveltySchema = z
  .object({
    turn_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    novelty_threshold: z.number().min(0).max(1).optional(),
    max_similarity: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.turn_id && !value.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn_id or thread_id is required",
        path: ["turn_id"],
      });
    }
  });

export const trichatTurnOrchestrateSchema = z
  .object({
    mutation: mutationSchema,
    turn_id: z.string().min(1),
    action: z.enum(["decide", "verify_finalize"]).default("decide"),
    novelty_threshold: z.number().min(0).max(1).optional(),
    max_similarity: z.number().min(0).max(1).optional(),
    verify_status: z.enum(["passed", "failed", "skipped", "error"]).optional(),
    verify_summary: z.string().optional(),
    verify_details: z.record(z.unknown()).optional(),
    allow_phase_skip: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "verify_finalize" && !value.verify_status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verify_status is required for verify_finalize action",
        path: ["verify_status"],
      });
    }
  });

const trichatAdapterStateSchema = z.object({
  agent_id: z.string().min(1),
  channel: adapterChannelSchema,
  updated_at: z.string().optional(),
  open: z.boolean(),
  open_until: z.string().optional(),
  failure_count: z.number().int().min(0),
  trip_count: z.number().int().min(0),
  success_count: z.number().int().min(0),
  last_error: z.string().optional(),
  last_opened_at: z.string().optional(),
  turn_count: z.number().int().min(0),
  degraded_turn_count: z.number().int().min(0),
  last_result: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const trichatAdapterEventSchema = z.object({
  agent_id: z.string().min(1),
  channel: adapterChannelSchema,
  event_type: z.string().min(1),
  created_at: z.string().optional(),
  open_until: z.string().optional(),
  error_text: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export const trichatAdapterTelemetrySchema = z
  .object({
    action: z.enum(["status", "record"]).default("status"),
    mutation: mutationSchema.optional(),
    agent_id: z.string().min(1).optional(),
    channel: adapterChannelSchema.optional(),
    event_limit: z.number().int().min(0).max(2000).optional(),
    include_events: z.boolean().optional(),
    states: z.array(trichatAdapterStateSchema).max(2000).optional(),
    events: z.array(trichatAdapterEventSchema).max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "record" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for record action",
        path: ["mutation"],
      });
    }
    if (value.action === "record") {
      const stateCount = value.states?.length ?? 0;
      const eventCount = value.events?.length ?? 0;
      if (stateCount === 0 && eventCount === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "record action requires at least one state or event payload",
          path: ["states"],
        });
      }
    }
  });

export const trichatAdapterProtocolCheckSchema = z.object({
  agent_ids: z.array(z.string().min(1)).min(1).max(12).optional(),
  bridge_commands: z.record(z.string().min(1)).optional(),
  timeout_seconds: z.number().int().min(1).max(120).optional(),
  run_ask_check: z.boolean().optional(),
  ask_dry_run: z.boolean().optional(),
  workspace: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  ask_prompt: z.string().min(1).optional(),
});

export const trichatAutoRetentionSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(10).max(86400).optional(),
    older_than_days: z.number().int().min(0).max(3650).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
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

export const trichatTurnWatchdogSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    stale_after_seconds: z.number().int().min(15).max(86400).optional(),
    batch_limit: z.number().int().min(1).max(200).optional(),
    stale_before_iso: z.string().optional(),
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

export const trichatChaosSchema = z
  .object({
    action: z
      .enum(["status", "inject_adapter_failure", "inject_turn_failure", "verify_turn", "run_once"])
      .default("status"),
    mutation: mutationSchema.optional(),
    thread_id: z.string().min(1).optional(),
    turn_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    channel: adapterChannelSchema.optional(),
    reason: z.string().min(1).optional(),
    open_for_seconds: z.number().int().min(5).max(3600).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    title: z.string().min(1).optional(),
    user_prompt: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === "inject_adapter_failure" ||
        value.action === "inject_turn_failure" ||
        value.action === "run_once") &&
      !value.mutation
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for mutating chaos actions",
        path: ["mutation"],
      });
    }
    if (value.action === "inject_adapter_failure" && !value.agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent_id is required for inject_adapter_failure action",
        path: ["agent_id"],
      });
    }
    if ((value.action === "inject_turn_failure" || value.action === "verify_turn") && !value.turn_id && !value.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn_id or thread_id is required",
        path: ["turn_id"],
      });
    }
  });

export const trichatSloSchema = z
  .object({
    action: z.enum(["status", "snapshot", "history"]).default("status"),
    mutation: mutationSchema.optional(),
    window_minutes: z.number().int().min(1).max(10080).optional(),
    event_limit: z.number().int().min(10).max(50000).optional(),
    thread_id: z.string().min(1).optional(),
    history_limit: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "snapshot" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for snapshot action",
        path: ["mutation"],
      });
    }
  });

const trichatAwayModeSchema = z.enum(["safe", "normal", "aggressive"]);
const trichatAdrPolicySchema = z.enum(["every_success", "high_impact", "manual"]);
const trichatExecuteBackendSchema = z.enum(["direct", "tmux", "auto"]);

export const trichatAutopilotSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    away_mode: trichatAwayModeSchema.optional(),
    interval_seconds: z.number().int().min(10).max(86400).optional(),
    thread_id: z.string().min(1).optional(),
    thread_title: z.string().min(1).optional(),
    thread_status: threadStatusSchema.optional(),
    objective: z.string().min(1).optional(),
    max_rounds: z.number().int().min(1).max(6).optional(),
    min_success_agents: z.number().int().min(1).max(3).optional(),
    bridge_timeout_seconds: z.number().int().min(5).max(7200).optional(),
    bridge_dry_run: z.boolean().optional(),
    execute_enabled: z.boolean().optional(),
    command_allowlist: z.array(z.string().min(1)).max(50).optional(),
    execute_backend: trichatExecuteBackendSchema.optional(),
    tmux_session_name: z.string().min(1).optional(),
    tmux_worker_count: z.number().int().min(1).max(12).optional(),
    tmux_max_queue_per_worker: z.number().int().min(1).max(200).optional(),
    tmux_auto_scale_workers: z.boolean().optional(),
    tmux_sync_after_dispatch: z.boolean().optional(),
    confidence_threshold: z.number().min(0.05).max(1).optional(),
    max_consecutive_errors: z.number().int().min(1).max(20).optional(),
    lock_key: z.string().min(1).optional(),
    lock_lease_seconds: z.number().int().min(15).max(3600).optional(),
    adr_policy: trichatAdrPolicySchema.optional(),
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

const trichatTmuxTaskInputSchema = z.object({
  task_id: z.string().min(1).optional(),
  title: z.string().min(1),
  command: z.string().min(1),
  priority: z.number().int().min(1).max(100).optional(),
  complexity: z.number().int().min(1).max(100).optional(),
  thread_id: z.string().min(1).optional(),
  turn_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const trichatTmuxActionSchema = z.enum(["status", "start", "stop", "dispatch", "sync", "maintain", "tail"]);

export const trichatTmuxControllerSchema = z
  .object({
    action: trichatTmuxActionSchema.default("status"),
    mutation: mutationSchema.optional(),
    session_name: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    worker_count: z.number().int().min(1).max(12).optional(),
    min_worker_count: z.number().int().min(1).max(12).optional(),
    max_worker_count: z.number().int().min(1).max(12).optional(),
    target_queue_per_worker: z.number().int().min(1).max(200).optional(),
    auto_scale_workers: z.boolean().optional(),
    shell: z.string().min(1).optional(),
    max_queue_per_worker: z.number().int().min(1).max(200).optional(),
    nudge_blocked_lanes: z.boolean().optional(),
    lock_key: z.string().min(1).optional(),
    lock_lease_seconds: z.number().int().min(15).max(3600).optional(),
    tasks: z.array(trichatTmuxTaskInputSchema).min(1).max(200).optional(),
    include_completed: z.boolean().optional(),
    worker_id: z.string().min(1).optional(),
    capture_lines: z.number().int().min(20).max(3000).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === "start" ||
        value.action === "stop" ||
        value.action === "dispatch" ||
        value.action === "sync" ||
        value.action === "maintain") &&
      !value.mutation
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, dispatch, sync, and maintain actions",
        path: ["mutation"],
      });
    }
    if (value.action === "dispatch" && (!value.tasks || value.tasks.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dispatch action requires at least one task",
        path: ["tasks"],
      });
    }
  });

type TriChatAutoRetentionConfig = {
  interval_seconds: number;
  older_than_days: number;
  limit: number;
};

type TriChatTurnWatchdogConfig = {
  interval_seconds: number;
  stale_after_seconds: number;
  batch_limit: number;
};

type TriChatAutoRetentionTickResult = {
  completed_at: string;
  candidate_count: number;
  deleted_count: number;
  deleted_message_ids: string[];
  skipped?: boolean;
  reason?: string;
};

const DEFAULT_AUTO_RETENTION_CONFIG: TriChatAutoRetentionConfig = {
  interval_seconds: 600,
  older_than_days: 30,
  limit: 1000,
};

const DEFAULT_TURN_WATCHDOG_CONFIG: TriChatTurnWatchdogConfig = {
  interval_seconds: 30,
  stale_after_seconds: 180,
  batch_limit: 10,
};

const autoRetentionRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TriChatAutoRetentionConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  total_candidates: number;
  total_deleted: number;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_AUTO_RETENTION_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  total_candidates: 0,
  total_deleted: 0,
};

const turnWatchdogRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TriChatTurnWatchdogConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  stale_detected_count: number;
  escalated_count: number;
  last_escalated_turn_ids: string[];
  last_slo_snapshot_id: string | null;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_TURN_WATCHDOG_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  stale_detected_count: 0,
  escalated_count: 0,
  last_escalated_turn_ids: [],
  last_slo_snapshot_id: null,
};

type TriChatTurnWatchdogTickResult = {
  completed_at: string;
  stale_before_iso: string;
  stale_after_seconds: number;
  candidate_count: number;
  escalated_count: number;
  escalated_turn_ids: string[];
  invariant_failures: Array<{
    turn_id: string;
    failed_checks: string[];
  }>;
  slo_snapshot: {
    snapshot_id: string;
    created_at: string;
  } | null;
  skipped?: boolean;
  reason?: string;
};

type TriChatSloMetrics = {
  computed_at: string;
  thread_id: string | null;
  window_minutes: number;
  since_iso: string;
  event_limit: number;
  adapter: {
    sample_count: number;
    error_count: number;
    error_rate: number;
    latency_sample_count: number;
    p95_latency_ms: number | null;
  };
  turns: {
    total_count: number;
    failed_count: number;
    failure_rate: number;
  };
};

type TriChatAutopilotConfig = {
  away_mode: "safe" | "normal" | "aggressive";
  interval_seconds: number;
  thread_id: string;
  thread_title: string;
  thread_status: "active" | "archived";
  objective: string;
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
};

type TriChatAutopilotTickResult = {
  ok: boolean;
  completed_at: string;
  run_id: string;
  session_key: string;
  away_mode: "safe" | "normal" | "aggressive";
  thread_id: string;
  turn_id: string | null;
  user_message_id: string | null;
  source_task_id: string | null;
  council_confidence: number;
  success_agents: number;
  emergency_brake_triggered: boolean;
  incident_id: string | null;
  verify_status: "passed" | "failed" | "skipped" | "error";
  verify_summary: string;
  execution: {
    mode: "direct_command" | "tmux_dispatch" | "task_fallback" | "none";
    commands: string[];
    blocked_commands: string[];
    task_id: string | null;
    direct_success: boolean;
    tmux: {
      session_name: string | null;
      worker_count: number | null;
      dispatched_count: number;
      assigned_count: number;
      queued_count: number;
      sync: {
        running_marked: number;
        completed_marked: number;
        failed_marked: number;
      } | null;
      failures: Array<{
        task_id: string;
        worker_id: string;
        error: string;
      }>;
    } | null;
    command_results: Array<{
      command: string;
      ok: boolean;
      exit_code: number | null;
      signal: string | null;
      timed_out: boolean;
      stdout: string;
      stderr: string;
      duration_ms: number;
    }>;
  };
  mentorship: {
    session_id: string;
    transcript_entries: number;
    summarize_note_id: string | null;
    memory_id: number | null;
  };
  governance: {
    adr_id: string | null;
    adr_path: string | null;
    skipped_reason: string | null;
  };
  step_status: Array<{
    name: string;
    status: "completed" | "failed" | "skipped";
    summary: string;
  }>;
  reason: string | null;
};

const DEFAULT_AUTOPILOT_COMMAND_ALLOWLIST = [
  "npm ",
  "npx ",
  "pnpm ",
  "yarn ",
  "go ",
  "python ",
  "python3 ",
  "node ",
  "bash ",
  "sh ",
  "./scripts/",
  "git status",
  "git diff",
  "git show",
  "git log",
  "git add",
  "git commit",
  "make ",
  "cargo ",
  "deno ",
];

const DEFAULT_AUTOPILOT_CONFIG: TriChatAutopilotConfig = {
  away_mode: "normal",
  interval_seconds: 300,
  thread_id: "trichat-autopilot-internal",
  thread_title: "TriChat Autopilot",
  thread_status: "archived",
  objective:
    "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop.",
  max_rounds: 2,
  min_success_agents: 2,
  bridge_timeout_seconds: 180,
  bridge_dry_run: false,
  execute_enabled: true,
  command_allowlist: [...DEFAULT_AUTOPILOT_COMMAND_ALLOWLIST],
  execute_backend: "auto",
  tmux_session_name: "trichat-autopilot",
  tmux_worker_count: 3,
  tmux_max_queue_per_worker: 6,
  tmux_auto_scale_workers: true,
  tmux_sync_after_dispatch: true,
  confidence_threshold: 0.45,
  max_consecutive_errors: 3,
  lock_key: null,
  lock_lease_seconds: 600,
  adr_policy: "every_success",
};

const autopilotRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TriChatAutopilotConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  success_count: number;
  failure_count: number;
  incident_count: number;
  consecutive_error_count: number;
  last_run_id: string | null;
  last_session_key: string | null;
  last_tick: TriChatAutopilotTickResult | null;
  pause_reason: string | null;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_AUTOPILOT_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  success_count: 0,
  failure_count: 0,
  incident_count: 0,
  consecutive_error_count: 0,
  last_run_id: null,
  last_session_key: null,
  last_tick: null,
  pause_reason: null,
};

const AUTOPILOT_WORKER_ID = "trichat-autopilot";
const AUTOPILOT_TICK_LOCK_KEY = "trichat.autopilot.tick";
const AUTOPILOT_OWNER_NONCE = `${process.pid}-${crypto.randomUUID().slice(0, 12)}`;
const AUTOPILOT_AGENT_ROLE_LANES: Record<string, string> = getTriChatRoleLaneMap(DEFAULT_CONSENSUS_AGENT_IDS);
const AUTOPILOT_STEP_ORDER = [
  "goal_intake",
  "council",
  "safety_gate",
  "execute",
  "verify_finalize",
  "mentorship",
  "governance",
  "complete",
] as const;
const AUTOPILOT_COMMAND_TIMEOUT_SECONDS = 180;
const AUTOPILOT_OUTPUT_BYTE_CAP = 24_000;
let autopilotInvocationCounter = 0;
const AUTOPILOT_INLINE_MUTATION = {
  idempotency_key: "autopilot-inline",
  side_effect_fingerprint: "autopilot-inline",
} as const;
const AUTOPILOT_HARD_DENY_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\s)rm\s+-rf\s+\/(\s|$)/i,
  /(^|\s)rm\s+-rf\s+~/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\};\s*:/,
  /(^|\s)(shutdown|reboot|halt|poweroff)\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=.*\sof=\/dev\//i,
  /\bchmod\s+-r?\s*777\s+\/\b/i,
  /\bcurl\b[\s\S]*\|\s*(sh|bash|zsh)\b/i,
  /\bwget\b[\s\S]*\|\s*(sh|bash|zsh)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bchown\s+-r\s+root\b/i,
];
const AUTOPILOT_DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\s)rm\s+-rf\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=.*\sof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\bdeprovision\b|\bdelete\b|\bdestroy\b/i,
];
const AUTOPILOT_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+(add|commit|rebase|merge|cherry-pick)\b/i,
  /\bmv\b|\bcp\b|\bsed\s+-i\b|\btee\b/i,
  /\bnpm\s+(install|ci|version)\b/i,
  /\bpnpm\s+(install|add|up)\b/i,
  /\byarn\s+(add|remove|upgrade)\b/i,
  /\becho\s+.+>\s*/i,
];

type TriChatTmuxTaskInput = z.infer<typeof trichatTmuxTaskInputSchema>;

type TriChatTmuxWorkerSnapshot = {
  worker_id: string;
  active_queue: number;
  active_load: number;
  recent_task_ids: string[];
};

type TriChatTmuxLaneState =
  | "idle"
  | "working"
  | "blocked_trust"
  | "blocked_plan"
  | "blocked_prompt"
  | "error"
  | "offline"
  | "unknown";

type TriChatTmuxWorkerLaneSignal = {
  lane_state: TriChatTmuxLaneState;
  lane_signal: string | null;
  lane_updated_at: string;
};

type TriChatTmuxFailureClass =
  | "none"
  | "timeout"
  | "command_not_found"
  | "permission_denied"
  | "tmux_runtime"
  | "dispatch_error"
  | "unknown";

type TriChatTmuxDashboardPayload = {
  generated_at: string;
  queue_depth: number;
  queue_age_seconds: number | null;
  queue_oldest_task_id: string | null;
  worker_load: Array<{
    worker_id: string;
    active_queue: number;
    active_load: number;
    lane_state: TriChatTmuxLaneState;
    lane_signal: string | null;
    lane_updated_at: string;
  }>;
  failure_class: TriChatTmuxFailureClass;
  failure_count: number;
  last_failure_at: string | null;
  last_error: string | null;
};

type TriChatTmuxCommandResult = {
  ok: boolean;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: string | null;
  dry_run: boolean;
  timed_out: boolean;
};

type TriChatTmuxDispatchTaskRecord = TriChatTmuxControllerTaskRecord & {
  worker_id: string;
};

type TriChatTmuxAssignmentResult = {
  state: TriChatTmuxControllerStateRecord;
  assigned: Array<{
    task_id: string;
    worker_id: string;
    priority: number;
    complexity: number;
    seq: number;
  }>;
  unassigned: Array<{
    task_id: string;
    reason: string;
    priority: number;
    complexity: number;
    seq: number;
  }>;
};

type TriChatTmuxDispatchResult = {
  state: TriChatTmuxControllerStateRecord;
  dispatched: TriChatTmuxDispatchTaskRecord[];
  failures: Array<{
    task_id: string;
    worker_id: string;
    error: string;
  }>;
};

type TriChatTmuxSyncResult = {
  state: TriChatTmuxControllerStateRecord;
  summary: {
    running_marked: number;
    completed_marked: number;
    failed_marked: number;
  };
};

const TMUX_CONTROLLER_DEFAULTS = {
  session_name: "trichat-controller",
  workspace: process.cwd(),
  worker_count: 3,
  shell: process.env.SHELL?.trim() || "/bin/zsh",
  max_queue_per_worker: 8,
  next_task_seq: 1,
  lock_lease_seconds: 600,
};

const TMUX_CONTROLLER_TOOL_NAME = "trichat.tmux_controller";
const TMUX_CONTROLLER_EXEC_OWNER = `trichat-tmux-controller:${process.pid}:${crypto.randomUUID().slice(0, 10)}`;
const TMUX_TASK_START_MARKER = "__TRICHAT_TASK_START__";
const TMUX_TASK_END_MARKER = "__TRICHAT_TASK_END__";

export function trichatThreadOpen(storage: Storage, input: z.infer<typeof trichatThreadOpenSchema>) {
  return storage.upsertTriChatThread({
    thread_id: input.thread_id,
    title: input.title,
    status: input.status,
    metadata: input.metadata,
  });
}

export function trichatThreadList(storage: Storage, input: z.infer<typeof trichatThreadListSchema>) {
  const threads = storage.listTriChatThreads({
    status: input.status,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    count: threads.length,
    threads,
  };
}

export function trichatThreadGet(storage: Storage, input: z.infer<typeof trichatThreadGetSchema>) {
  const thread = storage.getTriChatThreadById(input.thread_id);
  if (!thread) {
    return {
      found: false,
      thread_id: input.thread_id,
    };
  }
  return {
    found: true,
    thread,
  };
}

export function trichatMessagePost(storage: Storage, input: z.infer<typeof trichatMessagePostSchema>) {
  const message = storage.appendTriChatMessage({
    thread_id: input.thread_id,
    agent_id: input.agent_id,
    role: input.role,
    content: input.content,
    reply_to_message_id: input.reply_to_message_id,
    metadata: input.metadata,
  });
  return {
    ok: true,
    message,
  };
}

export function trichatTimeline(storage: Storage, input: z.infer<typeof trichatTimelineSchema>) {
  const messages = storage.getTriChatTimeline({
    thread_id: input.thread_id,
    limit: input.limit ?? 200,
    since: input.since,
    agent_id: input.agent_id,
    role: input.role,
  });
  return {
    thread_id: input.thread_id,
    count: messages.length,
    messages,
  };
}

export function trichatRetention(
  storage: Storage,
  input: Pick<z.infer<typeof trichatRetentionSchema>, "older_than_days" | "thread_id" | "limit" | "dry_run">
) {
  const now = Date.now();
  const cutoff = new Date(now - input.older_than_days * 24 * 60 * 60 * 1000).toISOString();
  const result = storage.pruneTriChatMessages({
    older_than_iso: cutoff,
    thread_id: input.thread_id,
    limit: input.limit ?? 1000,
    dry_run: input.dry_run ?? false,
  });
  return {
    cutoff_iso: cutoff,
    older_than_days: input.older_than_days,
    thread_id: input.thread_id ?? null,
    dry_run: input.dry_run ?? false,
    ...result,
  };
}

export function trichatSummary(storage: Storage, input: z.infer<typeof trichatSummarySchema>) {
  const summary = storage.getTriChatSummary({
    busiest_limit: input.busiest_limit ?? 10,
  });
  return {
    generated_at: new Date().toISOString(),
    ...summary,
  };
}

export function trichatRoster(_storage: Storage, input: z.infer<typeof trichatRosterSchema>) {
  const summary = getTriChatRosterSummary(input.agent_ids);
  const agents = input.active_only ? summary.agents.filter((agent) => agent.active) : summary.agents;
  return {
    generated_at: new Date().toISOString(),
    config_path: summary.config_path,
    default_agent_ids: summary.default_agent_ids,
    active_agent_ids: summary.active_agent_ids,
    overridden_by_env: summary.overridden_by_env,
    agents,
  };
}

export function trichatConsensus(storage: Storage, input: z.infer<typeof trichatConsensusSchema>) {
  const timeline = storage.getTriChatTimeline({
    thread_id: input.thread_id,
    limit: input.limit ?? 240,
  });
  const agentIds = normalizeConsensusAgentIds(input.agent_ids);
  const agentSet = new Set(agentIds);
  const minAgents = Math.max(2, Math.min(input.min_agents ?? agentIds.length, agentIds.length));
  const recentTurnLimit = input.recent_turn_limit ?? 8;

  const turnsByUserMessageId = new Map<
    string,
    {
      user_message_id: string;
      user_created_at: string;
      user_excerpt: string;
      responses: Map<string, (typeof timeline)[number]>;
    }
  >();
  const orderedTurns: Array<{
    user_message_id: string;
    user_created_at: string;
    user_excerpt: string;
    responses: Map<string, (typeof timeline)[number]>;
  }> = [];

  for (const message of timeline) {
    if (message.role !== "user") {
      continue;
    }
    const turn = {
      user_message_id: message.message_id,
      user_created_at: message.created_at,
      user_excerpt: compactConsensusText(message.content, 160),
      responses: new Map<string, (typeof timeline)[number]>(),
    };
    turnsByUserMessageId.set(message.message_id, turn);
    orderedTurns.push(turn);
  }

  for (const message of timeline) {
    if (message.role !== "assistant") {
      continue;
    }
    const normalizedAgentId = normalizeConsensusAgentId(message.agent_id);
    if (!normalizedAgentId || !agentSet.has(normalizedAgentId)) {
      continue;
    }
    const replyToId = message.reply_to_message_id?.trim();
    if (!replyToId) {
      continue;
    }
    const turn = turnsByUserMessageId.get(replyToId);
    if (!turn) {
      continue;
    }
    turn.responses.set(normalizedAgentId, message);
  }

  const evaluatedTurns = orderedTurns
    .map((turn) => evaluateConsensusTurn(turn, agentIds, minAgents))
    .filter((turn) => turn.response_count > 0);

  const consensusTurns = evaluatedTurns.filter((turn) => turn.status === "consensus").length;
  const disagreementTurns = evaluatedTurns.filter((turn) => turn.status === "disagreement").length;
  const incompleteTurns = evaluatedTurns.filter((turn) => turn.status === "incomplete").length;
  const analyzedTurns = consensusTurns + disagreementTurns;
  const latestTurn = evaluatedTurns.length ? evaluatedTurns[evaluatedTurns.length - 1] : null;
  const latestDisagreement =
    [...evaluatedTurns].reverse().find((turn) => turn.status === "disagreement") ?? null;

  return {
    generated_at: new Date().toISOString(),
    mode: "basic",
    thread_id: input.thread_id,
    agent_ids: agentIds,
    min_agents: minAgents,
    turns_total: orderedTurns.length,
    turns_with_any_response: evaluatedTurns.length,
    analyzed_turns: analyzedTurns,
    consensus_turns: consensusTurns,
    disagreement_turns: disagreementTurns,
    incomplete_turns: incompleteTurns,
    disagreement_rate: analyzedTurns > 0 ? Number((disagreementTurns / analyzedTurns).toFixed(4)) : null,
    flagged: latestTurn?.status === "disagreement",
    latest_turn: latestTurn,
    latest_disagreement: latestDisagreement,
    recent_turns: evaluatedTurns.slice(-recentTurnLimit),
  };
}

export function trichatTurnStart(storage: Storage, input: z.infer<typeof trichatTurnStartSchema>) {
  const expectedAgents = normalizeConsensusAgentIds(input.expected_agents ?? DEFAULT_TURN_AGENT_IDS);
  const minAgents = Math.max(1, Math.min(input.min_agents ?? expectedAgents.length, expectedAgents.length));
  return storage.createOrGetTriChatTurn({
    thread_id: input.thread_id,
    user_message_id: input.user_message_id,
    user_prompt: input.user_prompt,
    status: "running",
    phase: "plan",
    phase_status: "running",
    expected_agents: expectedAgents,
    min_agents: minAgents,
    metadata: input.metadata,
  });
}

export function trichatTurnAdvance(storage: Storage, input: z.infer<typeof trichatTurnAdvanceSchema>) {
  const existing = storage.getTriChatTurnById(input.turn_id);
  if (!existing) {
    throw new Error(`Tri-chat turn not found: ${input.turn_id}`);
  }
  validateTurnAdvance(existing, input);
  const turn = storage.updateTriChatTurn({
    turn_id: input.turn_id,
    status: input.status,
    phase: input.phase,
    phase_status: input.phase_status,
    expected_agents: input.expected_agents,
    min_agents: input.min_agents,
    novelty_score: input.novelty_score,
    novelty_threshold: input.novelty_threshold,
    retry_required: input.retry_required,
    retry_agents: input.retry_agents,
    disagreement: input.disagreement,
    decision_summary: input.decision_summary,
    selected_agent: input.selected_agent,
    selected_strategy: input.selected_strategy,
    verify_status: input.verify_status,
    verify_summary: input.verify_summary,
    metadata: input.metadata,
  });
  return {
    ok: true,
    turn,
  };
}

export function trichatTurnArtifact(storage: Storage, input: z.infer<typeof trichatTurnArtifactSchema>) {
  const artifact = storage.appendTriChatTurnArtifact({
    turn_id: input.turn_id,
    phase: input.phase,
    artifact_type: input.artifact_type,
    agent_id: input.agent_id,
    content: input.content,
    structured: input.structured,
    score: input.score,
    metadata: input.metadata,
  });
  return {
    ok: true,
    artifact,
  };
}

export function trichatTurnGet(storage: Storage, input: z.infer<typeof trichatTurnGetSchema>) {
  const turn = resolveTurnForLookup(storage, input.turn_id, input.thread_id, input.include_closed ?? true);
  if (!turn) {
    return {
      found: false,
      turn_id: input.turn_id ?? null,
      thread_id: input.thread_id ?? null,
    };
  }
  const includeArtifacts = input.include_artifacts ?? true;
  const artifacts = includeArtifacts
    ? storage.listTriChatTurnArtifacts({
        turn_id: turn.turn_id,
        limit: input.artifact_limit ?? 120,
      })
    : [];
  return {
    found: true,
    turn,
    artifact_count: artifacts.length,
    artifacts,
  };
}

export function trichatWorkboard(storage: Storage, input: z.infer<typeof trichatWorkboardSchema>) {
  const turns = storage.listTriChatTurns({
    thread_id: input.thread_id,
    status: input.status,
    limit: input.limit ?? 30,
  });
  const counts = {
    total: turns.length,
    running: turns.filter((turn) => turn.status === "running").length,
    completed: turns.filter((turn) => turn.status === "completed").length,
    failed: turns.filter((turn) => turn.status === "failed").length,
    cancelled: turns.filter((turn) => turn.status === "cancelled").length,
  };
  const phaseCounts: Record<string, number> = {
    plan: 0,
    propose: 0,
    critique: 0,
    merge: 0,
    execute: 0,
    verify: 0,
    summarize: 0,
  };
  for (const turn of turns) {
    phaseCounts[turn.phase] = (phaseCounts[turn.phase] ?? 0) + 1;
  }
  const latest = turns.length > 0 ? turns[0] : null;
  const active = turns.find((turn) => turn.status === "running") ?? null;
  const latestDecision =
    turns.find((turn) => turn.decision_summary && turn.decision_summary.trim().length > 0) ?? null;

  return {
    generated_at: new Date().toISOString(),
    thread_id: input.thread_id ?? null,
    status_filter: input.status ?? null,
    counts,
    phase_counts: phaseCounts,
    latest_turn: latest,
    active_turn: active,
    latest_decision: latestDecision
      ? {
          turn_id: latestDecision.turn_id,
          decision_summary: latestDecision.decision_summary,
          selected_agent: latestDecision.selected_agent,
          selected_strategy: latestDecision.selected_strategy,
          updated_at: latestDecision.updated_at,
          novelty_score: latestDecision.novelty_score,
        }
      : null,
    turns,
  };
}

export function trichatNovelty(
  storage: Storage,
  input: z.infer<typeof trichatNoveltySchema>
): TriChatNoveltyResult {
  const turn = resolveTurnForLookup(storage, input.turn_id, input.thread_id, true);
  if (!turn) {
    return {
      found: false,
      turn_id: input.turn_id ?? null,
      thread_id: input.thread_id ?? null,
    };
  }

  const noveltyThreshold = clamp(input.novelty_threshold ?? turn.novelty_threshold ?? 0.35, 0, 1);
  const maxSimilarity = clamp(input.max_similarity ?? 0.82, 0, 1);
  const artifacts = storage.listTriChatTurnArtifacts({
    turn_id: turn.turn_id,
    phase: "propose",
    limit: input.limit ?? 200,
  });
  const proposals = collectLatestProposalsByAgent(
    turn,
    artifacts.filter((artifact) => {
      const type = String(artifact.artifact_type ?? "").trim().toLowerCase();
      return type === "proposal" || type === "proposal_retry" || type === "proposal_interop";
    }),
    storage
  );
  const pairs = buildNoveltyPairs(proposals);
  const averageSimilarity =
    pairs.length > 0
      ? Number((pairs.reduce((total, pair) => total + pair.similarity, 0) / pairs.length).toFixed(4))
      : 0;
  const noveltyScore = Number((1 - averageSimilarity).toFixed(4));
  const hottestPair = pairs.length > 0 ? pairs[0] : null;
  const baselineRetryRequired =
    proposals.length >= 2 && (noveltyScore < noveltyThreshold || (hottestPair?.similarity ?? 0) >= maxSimilarity);
  const baselineRetryAgents = baselineRetryRequired
    ? recommendNoveltyRetryAgents(proposals, pairs, maxSimilarity)
    : [];
  const disagreement = inferProposalDisagreement(proposals);
  const baselineNovelty: TriChatNoveltyFoundResult = {
    found: true,
    turn_id: turn.turn_id,
    thread_id: turn.thread_id,
    user_message_id: turn.user_message_id,
    proposal_count: proposals.length,
    proposals,
    pairs,
    average_similarity: averageSimilarity,
    novelty_score: noveltyScore,
    novelty_threshold: noveltyThreshold,
    max_similarity: maxSimilarity,
    retry_required: baselineRetryRequired,
    retry_agents: baselineRetryAgents,
    retry_suppressed: false,
    retry_suppression_reason: null,
    retry_suppression_reference_turn_id: null,
    disagreement,
    decision_hint: baselineRetryRequired
      ? "retry-delta-required"
      : disagreement
        ? "merge-with-critique"
        : "merge-ready",
  };
  const candidateDecision = rankDecisionCandidates(baselineNovelty, {
    artifact_count: 0,
    per_target: {},
    sample: [],
  });
  const dedupeGuard = evaluateRetryDedupeGuard(storage, turn, baselineNovelty, candidateDecision);
  const retrySuppressed = dedupeGuard.suppressed;
  const retryRequired = baselineRetryRequired && !retrySuppressed;
  const retryAgents = retryRequired ? baselineRetryAgents : [];
  const decisionHint = retrySuppressed
    ? "retry-dedupe-suppressed"
    : retryRequired
      ? "retry-delta-required"
      : disagreement
        ? "merge-with-critique"
        : "merge-ready";

  return {
    found: true,
    turn_id: turn.turn_id,
    thread_id: turn.thread_id,
    user_message_id: turn.user_message_id,
    proposal_count: proposals.length,
    proposals,
    pairs,
    average_similarity: averageSimilarity,
    novelty_score: noveltyScore,
    novelty_threshold: noveltyThreshold,
    max_similarity: maxSimilarity,
    retry_required: retryRequired,
    retry_agents: retryAgents,
    retry_suppressed: retrySuppressed,
    retry_suppression_reason: dedupeGuard.reason,
    retry_suppression_reference_turn_id: dedupeGuard.reference_turn_id,
    disagreement,
    decision_hint: decisionHint,
  };
}

export function trichatTurnOrchestrate(storage: Storage, input: z.infer<typeof trichatTurnOrchestrateSchema>) {
  if (input.action === "verify_finalize") {
    return orchestrateVerifyFinalize(storage, input);
  }
  return orchestrateDecision(storage, input);
}

export function trichatAdapterTelemetry(storage: Storage, input: z.infer<typeof trichatAdapterTelemetrySchema>) {
  if (input.action === "status") {
    return buildAdapterTelemetryStatus(storage, input);
  }

  if (!input.mutation) {
    throw new Error("mutation is required for record action");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.adapter_telemetry",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const states = input.states?.length
        ? storage.upsertTriChatAdapterStates({
            states: input.states,
          })
        : [];
      const events = input.events?.length
        ? storage.appendTriChatAdapterEvents({
            events: input.events,
          })
        : [];
      return {
        action: "record",
        recorded_state_count: states.length,
        recorded_event_count: events.length,
        status: buildAdapterTelemetryStatus(storage, {
          agent_id: input.agent_id,
          channel: input.channel,
          include_events: input.include_events,
          event_limit: input.event_limit,
        }),
      };
    },
  });
}

export function trichatAdapterProtocolCheck(
  _storage: Storage,
  input: z.infer<typeof trichatAdapterProtocolCheckSchema>
) {
  const checkedAt = new Date().toISOString();
  const workspace = resolveAdapterProtocolWorkspace(input.workspace);
  const timeoutSeconds = Math.max(1, input.timeout_seconds ?? 8);
  const runAskCheck = input.run_ask_check ?? true;
  const askDryRun = input.ask_dry_run ?? true;
  const threadId = String(input.thread_id ?? "trichat-adapter-protocol-check").trim();
  const askPrompt = String(
    input.ask_prompt ??
      "Protocol diagnostics request: acknowledge adapter readiness in one concise sentence."
  ).trim();
  const pythonBin = resolveAdapterProtocolPython();
  const agentIds = normalizeAdapterProtocolAgentIds(input.agent_ids);

  const results = agentIds.map((agentId) =>
    runAdapterProtocolCheckForAgent({
      agent_id: agentId,
      workspace,
      timeout_seconds: timeoutSeconds,
      command_overrides: input.bridge_commands ?? {},
      python_bin: pythonBin,
      thread_id: threadId,
      ask_prompt: askPrompt,
      run_ask_check: runAskCheck,
      ask_dry_run: askDryRun,
    })
  );

  const pingOkCount = results.filter((entry) => entry.ping.ok).length;
  const askOkCount = results.filter((entry) => !entry.ask || entry.ask.ok).length;
  const allOk = results.every((entry) => entry.ok);

  return {
    generated_at: checkedAt,
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    workspace,
    timeout_seconds: timeoutSeconds,
    run_ask_check: runAskCheck,
    ask_dry_run: askDryRun,
    thread_id: threadId,
    all_ok: allOk,
    counts: {
      total: results.length,
      ok: results.filter((entry) => entry.ok).length,
      ping_ok: pingOkCount,
      ask_ok: askOkCount,
    },
    results,
  };
}

export function initializeTriChatAutoRetentionDaemon(storage: Storage) {
  const persisted = storage.getTriChatAutoRetentionState();
  if (!persisted) {
    autoRetentionRuntime.config = { ...DEFAULT_AUTO_RETENTION_CONFIG };
    stopAutoRetentionDaemon();
    return {
      restored: false,
      running: false,
      config: { ...autoRetentionRuntime.config },
    };
  }

  autoRetentionRuntime.config = resolveAutoRetentionConfig(persisted, DEFAULT_AUTO_RETENTION_CONFIG);
  if (persisted.enabled) {
    startAutoRetentionDaemon(storage);
  } else {
    stopAutoRetentionDaemon();
  }

  return {
    restored: true,
    running: autoRetentionRuntime.running,
    config: { ...autoRetentionRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function trichatAutoRetentionControl(storage: Storage, input: z.infer<typeof trichatAutoRetentionSchema>) {
  if (input.action === "status") {
    return getAutoRetentionStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.auto_retention",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = autoRetentionRuntime.running;
        autoRetentionRuntime.config = resolveAutoRetentionConfig(input, autoRetentionRuntime.config);
        startAutoRetentionDaemon(storage);
        let initialTick: TriChatAutoRetentionTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runAutoRetentionTick(storage, autoRetentionRuntime.config);
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...autoRetentionRuntime.config },
          persisted: storage.setTriChatAutoRetentionState({
            enabled: true,
            interval_seconds: autoRetentionRuntime.config.interval_seconds,
            older_than_days: autoRetentionRuntime.config.older_than_days,
            limit: autoRetentionRuntime.config.limit,
          }),
          initial_tick: initialTick,
          status: getAutoRetentionStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = autoRetentionRuntime.running;
        stopAutoRetentionDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTriChatAutoRetentionState({
            enabled: false,
            interval_seconds: autoRetentionRuntime.config.interval_seconds,
            older_than_days: autoRetentionRuntime.config.older_than_days,
            limit: autoRetentionRuntime.config.limit,
          }),
          status: getAutoRetentionStatus(),
        };
      }

      const config = resolveAutoRetentionConfig(input, autoRetentionRuntime.config);
      const tick = runAutoRetentionTick(storage, config);
      return {
        running: autoRetentionRuntime.running,
        tick,
        status: getAutoRetentionStatus(),
      };
    },
  });
}

export function initializeTriChatTurnWatchdogDaemon(storage: Storage) {
  const persisted = storage.getTriChatTurnWatchdogState();
  if (!persisted) {
    turnWatchdogRuntime.config = { ...DEFAULT_TURN_WATCHDOG_CONFIG };
    stopTurnWatchdogDaemon();
    return {
      restored: false,
      running: false,
      config: { ...turnWatchdogRuntime.config },
    };
  }

  turnWatchdogRuntime.config = resolveTurnWatchdogConfig(persisted, DEFAULT_TURN_WATCHDOG_CONFIG);
  if (persisted.enabled) {
    startTurnWatchdogDaemon(storage);
  } else {
    stopTurnWatchdogDaemon();
  }

  return {
    restored: true,
    running: turnWatchdogRuntime.running,
    config: { ...turnWatchdogRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function trichatTurnWatchdogControl(storage: Storage, input: z.infer<typeof trichatTurnWatchdogSchema>) {
  if (input.action === "status") {
    return getTurnWatchdogStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.turn_watchdog",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = turnWatchdogRuntime.running;
        turnWatchdogRuntime.config = resolveTurnWatchdogConfig(input, turnWatchdogRuntime.config);
        startTurnWatchdogDaemon(storage);
        let initialTick: TriChatTurnWatchdogTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runTurnWatchdogTick(storage, turnWatchdogRuntime.config, {
            stale_before_iso: input.stale_before_iso,
          });
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...turnWatchdogRuntime.config },
          persisted: storage.setTriChatTurnWatchdogState({
            enabled: true,
            interval_seconds: turnWatchdogRuntime.config.interval_seconds,
            stale_after_seconds: turnWatchdogRuntime.config.stale_after_seconds,
            batch_limit: turnWatchdogRuntime.config.batch_limit,
          }),
          initial_tick: initialTick,
          status: getTurnWatchdogStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = turnWatchdogRuntime.running;
        stopTurnWatchdogDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTriChatTurnWatchdogState({
            enabled: false,
            interval_seconds: turnWatchdogRuntime.config.interval_seconds,
            stale_after_seconds: turnWatchdogRuntime.config.stale_after_seconds,
            batch_limit: turnWatchdogRuntime.config.batch_limit,
          }),
          status: getTurnWatchdogStatus(),
        };
      }

      const config = resolveTurnWatchdogConfig(input, turnWatchdogRuntime.config);
      const tick = runTurnWatchdogTick(storage, config, {
        stale_before_iso: input.stale_before_iso,
      });
      return {
        running: turnWatchdogRuntime.running,
        tick,
        status: getTurnWatchdogStatus(),
      };
    },
  });
}

export function trichatChaos(storage: Storage, input: z.infer<typeof trichatChaosSchema>) {
  if (input.action === "status") {
    return {
      generated_at: new Date().toISOString(),
      recent_events: storage.listTriChatChaosEvents({
        limit: input.limit ?? 25,
      }),
      watchdog: getTurnWatchdogStatus(),
      latest_slo_snapshot: storage.getLatestTriChatSloSnapshot(),
    };
  }

  if (input.action === "verify_turn") {
    const turn = resolveChaosTargetTurn(storage, input.turn_id, input.thread_id, true);
    if (!turn) {
      return {
        ok: false,
        found: false,
        turn_id: input.turn_id ?? null,
        thread_id: input.thread_id ?? null,
      };
    }
    const invariants = evaluateTurnAutoFinalizationInvariants(storage, turn);
    return {
      ok: invariants.ok,
      found: true,
      turn: pickTurnSummary(turn),
      invariants,
    };
  }

  if (!input.mutation) {
    throw new Error("mutation is required for mutating chaos actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.chaos",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "inject_adapter_failure") {
        const injected = injectAdapterFailure(storage, {
          agent_id: input.agent_id ?? "",
          channel: input.channel ?? "model",
          reason:
            input.reason?.trim() ||
            `chaos adapter failure injection for ${input.agent_id ?? "unknown-agent"}/${input.channel ?? "model"}`,
          open_for_seconds: clampInt(input.open_for_seconds ?? 45, 5, 3600),
        });
        return {
          action: input.action,
          ok: true,
          ...injected,
        };
      }

      if (input.action === "inject_turn_failure") {
        const turn = resolveChaosTargetTurn(storage, input.turn_id, input.thread_id, false);
        if (!turn) {
          throw new Error("No running turn found for chaos injection target");
        }
        const result = failTurnWithEvidence(storage, {
          turn,
          source: "trichat.chaos",
          actor: "chaos",
          artifact_type: "chaos_fault",
          reason:
            input.reason?.trim() ||
            `chaos injected failure for turn ${turn.turn_id} at phase ${turn.phase}/${turn.phase_status}`,
          metadata: {
            injected: true,
            action: input.action,
          },
          chaos_action: "inject_turn_failure",
        });
        return {
          action: input.action,
          ok: result.invariants.ok,
          ...result,
        };
      }

      const syntheticThreadId = `trichat-chaos-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const title = input.title?.trim() || "TriChat Chaos Probe";
      const userPrompt = input.user_prompt?.trim() || "chaos probe: validate turn auto-finalization invariants";
      storage.upsertTriChatThread({
        thread_id: syntheticThreadId,
        title,
        status: "archived",
        metadata: {
          source: "trichat.chaos",
          kind: "run_once",
        },
      });
      const userMessage = storage.appendTriChatMessage({
        thread_id: syntheticThreadId,
        agent_id: "user",
        role: "user",
        content: userPrompt,
        metadata: {
          source: "trichat.chaos",
          kind: "run_once_seed",
        },
      });
      const started = trichatTurnStart(storage, {
        mutation: input.mutation!,
        thread_id: syntheticThreadId,
        user_message_id: userMessage.message_id,
        user_prompt: userPrompt,
        expected_agents: [...DEFAULT_CONSENSUS_AGENT_IDS],
        min_agents: Math.min(2, Math.max(1, DEFAULT_CONSENSUS_AGENT_IDS.length)),
        metadata: {
          source: "trichat.chaos",
          kind: "run_once",
        },
      });
      const runningTurn = storage.updateTriChatTurn({
        turn_id: started.turn.turn_id,
        status: "running",
        phase: "execute",
        phase_status: "running",
        metadata: {
          source: "trichat.chaos",
          kind: "run_once_execute_seed",
          allow_phase_skip: true,
        },
      });
      const result = failTurnWithEvidence(storage, {
        turn: runningTurn,
        source: "trichat.chaos",
        actor: "chaos",
        artifact_type: "chaos_fault",
        reason: `chaos run_once forced failure for turn ${runningTurn.turn_id}`,
        metadata: {
          injected: true,
          action: "run_once",
        },
        chaos_action: "run_once",
      });
      return {
        action: input.action,
        ok: result.invariants.ok,
        thread_id: syntheticThreadId,
        message_id: userMessage.message_id,
        ...result,
      };
    },
  });
}

export function trichatSlo(storage: Storage, input: z.infer<typeof trichatSloSchema>) {
  if (input.action === "history") {
    const history = storage.listTriChatSloSnapshots({
      limit: input.history_limit ?? 50,
    });
    return {
      generated_at: new Date().toISOString(),
      action: "history",
      count: history.length,
      snapshots: history,
    };
  }

  if (input.action === "status") {
    const computed = computeTriChatSloMetrics(storage, {
      window_minutes: input.window_minutes ?? 60,
      event_limit: input.event_limit ?? 8000,
      thread_id: input.thread_id,
    });
    return {
      generated_at: new Date().toISOString(),
      action: "status",
      metrics: computed,
      latest_snapshot: storage.getLatestTriChatSloSnapshot(),
    };
  }

  if (!input.mutation) {
    throw new Error("mutation is required for snapshot action");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.slo",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const metrics = computeTriChatSloMetrics(storage, {
        window_minutes: input.window_minutes ?? 60,
        event_limit: input.event_limit ?? 8000,
        thread_id: input.thread_id,
      });
      const snapshot = storage.appendTriChatSloSnapshot({
        window_minutes: metrics.window_minutes,
        adapter_sample_count: metrics.adapter.sample_count,
        adapter_error_count: metrics.adapter.error_count,
        adapter_error_rate: metrics.adapter.error_rate,
        adapter_latency_p95_ms: metrics.adapter.p95_latency_ms,
        turn_total_count: metrics.turns.total_count,
        turn_failed_count: metrics.turns.failed_count,
        turn_failure_rate: metrics.turns.failure_rate,
        metadata: {
          source: "trichat.slo",
          thread_id: metrics.thread_id,
          since_iso: metrics.since_iso,
          event_limit: metrics.event_limit,
        },
      });
      return {
        action: "snapshot",
        ok: true,
        metrics,
        snapshot,
      };
    },
  });
}

export function trichatTmuxController(storage: Storage, input: z.infer<typeof trichatTmuxControllerSchema>) {
  if (input.action === "status") {
    return buildTmuxControllerStatus(storage, input);
  }

  if (input.action === "tail") {
    const state = resolveTmuxControllerState(storage, input);
    const summarized = summarizeTmuxState(state, input.include_completed ?? false);
    return {
      generated_at: new Date().toISOString(),
      action: "tail",
      state: summarized,
      dashboard: buildTmuxDashboard(state, summarized.workers),
      panes: captureTmuxWorkerPanes(state, {
        worker_id: input.worker_id,
        capture_lines: input.capture_lines ?? 200,
      }),
    };
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, dispatch, sync, and maintain actions");
  }
  const mutation = input.mutation;

  return runIdempotentMutation({
    storage,
    tool_name: TMUX_CONTROLLER_TOOL_NAME,
    mutation,
    payload: input,
    execute: async () => {
      if (input.action === "start") {
        const desired = resolveTmuxControllerState(storage, input);
        ensureTmuxSession(desired);
        const persisted = storage.setTriChatTmuxControllerState({
          ...desired,
          enabled: true,
          last_error: null,
        });
        const summarized = summarizeTmuxState(persisted, true);
        return {
          action: "start",
          ok: true,
          status: summarized,
          dashboard: buildTmuxDashboard(persisted, summarized.workers),
        };
      }

      if (input.action === "stop") {
        const desired = resolveTmuxControllerState(storage, input);
        const stopResult = stopTmuxSession(desired.session_name);
        const persisted = storage.setTriChatTmuxControllerState({
          ...desired,
          enabled: false,
          last_error: stopResult.ok ? null : stopResult.error,
        });
        const summarized = summarizeTmuxState(persisted, true);
        return {
          action: "stop",
          ok: stopResult.ok,
          stop_result: stopResult,
          status: summarized,
          dashboard: buildTmuxDashboard(persisted, summarized.workers),
        };
      }

      if (input.action === "sync") {
        const desired = resolveTmuxControllerState(storage, input);
        const synced = syncTmuxTaskStatusFromPanes(desired, {
          capture_lines: input.capture_lines ?? 400,
        });
        const persisted = storage.setTriChatTmuxControllerState({
          ...synced.state,
          tasks: pruneTmuxTaskHistory(synced.state.tasks),
        });
        const summarized = summarizeTmuxState(persisted, true);
        return {
          action: "sync",
          ok: true,
          status: summarized,
          dashboard: buildTmuxDashboard(persisted, summarized.workers),
          sync: synced.summary,
        };
      }

      if (input.action === "maintain") {
        const desired = resolveTmuxControllerState(storage, input);
        if (!desired.enabled) {
          const summarized = summarizeTmuxState(desired, true);
          return {
            action: "maintain",
            ok: false,
            status: summarized,
            dashboard: buildTmuxDashboard(desired, summarized.workers),
            maintenance: {
              skipped: true,
              reason: "tmux controller is disabled",
              sync: {
                running_marked: 0,
                completed_marked: 0,
                failed_marked: 0,
              },
              scaled_up: false,
              from_worker_count: desired.worker_count,
              to_worker_count: desired.worker_count,
              nudged_count: 0,
              nudges: [],
            },
          };
        }
        ensureTmuxSession(desired);
        const lockKey =
          input.lock_key?.trim() || `trichat.tmux_controller.exec.${desired.session_name.replace(/\s+/g, "-")}`;
        const lockOwnerId = `${TMUX_CONTROLLER_EXEC_OWNER}:${Date.now()}:${Math.floor(Math.random() * 10_000)}`;
        const lockMutation = buildTmuxDerivedMutation(mutation, "maintain.lock.acquire", lockKey);
        const releaseMutation = buildTmuxDerivedMutation(mutation, "maintain.lock.release", lockKey);
        const lockLeaseSeconds = clampInt(
          input.lock_lease_seconds ?? TMUX_CONTROLLER_DEFAULTS.lock_lease_seconds,
          15,
          3600
        );
        const lockResult = await acquireLock(storage, {
          mutation: lockMutation,
          lock_key: lockKey,
          owner_id: lockOwnerId,
          lease_seconds: lockLeaseSeconds,
          metadata: {
            source: TMUX_CONTROLLER_TOOL_NAME,
            action: "maintain",
            session_name: desired.session_name,
            worker_count: desired.worker_count,
          },
        });
        if (!lockResult.acquired) {
          throw new Error(`maintain lock not acquired (${lockResult.reason}) for key ${lockKey}`);
        }

        try {
          let nextState = { ...desired };
          const sync = syncTmuxTaskStatusFromPanes(nextState, {
            capture_lines: input.capture_lines ?? 400,
          });
          nextState = sync.state;
          const scaleDecision = maybeScaleUpTmuxWorkers(nextState, {
            auto_scale_workers: input.auto_scale_workers ?? true,
            min_worker_count: input.min_worker_count,
            max_worker_count: input.max_worker_count,
            target_queue_per_worker: input.target_queue_per_worker,
          });
          nextState = scaleDecision.state;
          const workerSnapshots = buildTmuxWorkerSnapshots(nextState);
          const laneSignals = buildTmuxWorkerLaneSignals(nextState, workerSnapshots);
          const nudgeResult = (input.nudge_blocked_lanes ?? true)
            ? nudgeBlockedTmuxWorkers(nextState, laneSignals)
            : { nudged_count: 0, nudges: [] };
          const firstNudgeError =
            nudgeResult.nudges.find((entry) => !entry.ok)?.error ??
            (scaleDecision.error ? compactConsensusText(scaleDecision.error, 240) : null);
          const persisted = storage.setTriChatTmuxControllerState({
            ...nextState,
            tasks: pruneTmuxTaskHistory(nextState.tasks),
            last_error: firstNudgeError ?? null,
          });
          const summarized = summarizeTmuxState(persisted, true);
          return {
            action: "maintain",
            ok: !firstNudgeError,
            status: summarized,
            dashboard: buildTmuxDashboard(persisted, summarized.workers),
            maintenance: {
              skipped: false,
              reason: null,
              sync: sync.summary,
              scaled_up: scaleDecision.scaled_up,
              from_worker_count: scaleDecision.from_worker_count,
              to_worker_count: scaleDecision.to_worker_count,
              target_worker_count: scaleDecision.target_worker_count,
              queue_depth: scaleDecision.queue_depth,
              target_queue_per_worker: scaleDecision.target_queue_per_worker,
              nudged_count: nudgeResult.nudged_count,
              nudges: nudgeResult.nudges,
            },
          };
        } finally {
          await releaseLock(storage, {
            mutation: releaseMutation,
            lock_key: lockKey,
            owner_id: lockOwnerId,
          });
        }
      }

      const desired = resolveTmuxControllerState(storage, input);
      if (!desired.enabled) {
        throw new Error("tmux controller is disabled; call action=start first");
      }
      ensureTmuxSession(desired);

      const lockKey =
        input.lock_key?.trim() || `trichat.tmux_controller.exec.${desired.session_name.replace(/\s+/g, "-")}`;
      const lockOwnerId = `${TMUX_CONTROLLER_EXEC_OWNER}:${Date.now()}:${Math.floor(Math.random() * 10_000)}`;
      const lockMutation = buildTmuxDerivedMutation(mutation, "dispatch.lock.acquire", lockKey);
      const releaseMutation = buildTmuxDerivedMutation(mutation, "dispatch.lock.release", lockKey);
      const lockLeaseSeconds = clampInt(input.lock_lease_seconds ?? TMUX_CONTROLLER_DEFAULTS.lock_lease_seconds, 15, 3600);

      const lockResult = await acquireLock(storage, {
        mutation: lockMutation,
        lock_key: lockKey,
        owner_id: lockOwnerId,
        lease_seconds: lockLeaseSeconds,
        metadata: {
          source: TMUX_CONTROLLER_TOOL_NAME,
          session_name: desired.session_name,
          worker_count: desired.worker_count,
        },
      });
      if (!lockResult.acquired) {
        throw new Error(`dispatch lock not acquired (${lockResult.reason}) for key ${lockKey}`);
      }

      try {
        const syncBefore = syncTmuxTaskStatusFromPanes(desired, {
          capture_lines: input.capture_lines ?? 400,
        });
        let nextState = { ...syncBefore.state };
        const materialized = materializeTmuxInputTasks(input.tasks ?? [], nextState.next_task_seq, {
          default_thread_id: null,
          default_turn_id: null,
        });
        nextState = {
          ...nextState,
          next_task_seq: materialized.next_task_seq,
          tasks: [...nextState.tasks, ...materialized.tasks],
        };

        const assignment = assignQueuedTmuxTasks(nextState);
        nextState = assignment.state;
        const dispatchResults = dispatchAssignedTmuxTasks(nextState);
        nextState = dispatchResults.state;

        const dispatchTime = new Date().toISOString();
        nextState = {
          ...nextState,
          last_dispatch_at: dispatchTime,
          last_error: dispatchResults.failures.length > 0 ? dispatchResults.failures[0]?.error ?? null : null,
          tasks: pruneTmuxTaskHistory(nextState.tasks),
        };
        const persisted = storage.setTriChatTmuxControllerState(nextState);

        for (const item of dispatchResults.dispatched) {
          if (item.turn_id) {
            try {
              storage.appendTriChatTurnArtifact({
                turn_id: item.turn_id,
                phase: "execute",
                artifact_type: "tmux_dispatch",
                agent_id: "trichat-tmux-controller",
                content: compactConsensusText(
                  `tmux dispatch task=${item.task_id} worker=${item.worker_id} priority=${item.priority} complexity=${item.complexity}`,
                  320
                ),
                structured: {
                  task_id: item.task_id,
                  worker_id: item.worker_id,
                  priority: item.priority,
                  complexity: item.complexity,
                  command: item.command,
                  session_name: persisted.session_name,
                },
                metadata: {
                  source: TMUX_CONTROLLER_TOOL_NAME,
                },
              });
            } catch (error) {
              console.error(
                `[trichat.tmux_controller] artifact append failed for turn ${item.turn_id}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }

          if (item.thread_id) {
            try {
              storage.appendTriChatBusEvent({
                thread_id: item.thread_id,
                event_type: "trichat.tmux_dispatch",
                source_agent: "trichat-tmux-controller",
                source_client: "mcp:trichat.tmux_controller",
                role: "system",
                content: compactConsensusText(
                  `task ${item.task_id} sent to ${item.worker_id} (priority=${item.priority}, complexity=${item.complexity})`,
                  400
                ),
                metadata: {
                  kind: "trichat.tmux_dispatch",
                  task_id: item.task_id,
                  worker_id: item.worker_id,
                  priority: item.priority,
                  complexity: item.complexity,
                  command: item.command,
                  session_name: persisted.session_name,
                },
              });
            } catch (error) {
              console.error(
                `[trichat.tmux_controller] bus event append failed for thread ${item.thread_id}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }

        const summarized = summarizeTmuxState(persisted, true);
        return {
          action: "dispatch",
          ok: dispatchResults.failures.length === 0,
          status: summarized,
          dashboard: buildTmuxDashboard(persisted, summarized.workers),
          sync_before: syncBefore.summary,
          enqueued_count: materialized.tasks.length,
          assigned_count: assignment.assigned.length,
          dispatched_count: dispatchResults.dispatched.length,
          queued_count: assignment.unassigned.length,
          assignment: {
            assigned: assignment.assigned,
            unassigned: assignment.unassigned,
          },
          failures: dispatchResults.failures,
        };
      } finally {
        await releaseLock(storage, {
          mutation: releaseMutation,
          lock_key: lockKey,
          owner_id: lockOwnerId,
        });
      }
    },
  });
}

type AutopilotStepName = (typeof AUTOPILOT_STEP_ORDER)[number];

type AutopilotGoalIntakeResult = {
  source_task: Awaited<ReturnType<typeof taskClaim>>["task"] | null;
  objective: string;
  objective_source: "task" | "heartbeat";
  thread_id: string;
  user_message_id: string;
  turn_id: string;
  project_dir: string;
};

type AutopilotProposal = {
  agent_id: string;
  lane: string;
  round: number;
  content: string;
  strategy: string;
  commands: string[];
  confidence: number;
  message_id: string;
  artifact_id: string;
};

type AutopilotCouncilResult = {
  proposals: AutopilotProposal[];
  selected_agent: string | null;
  selected_strategy: string;
  decision_summary: string;
  decision_score: number | null;
  council_confidence: number;
  success_agents: string[];
};

type AutopilotCommandPlan = {
  source: "structured" | "fallback" | "none";
  commands: string[];
  allowed_commands: string[];
  blocked_commands: string[];
  blocked_by: Record<string, string>;
  classification: "read" | "write" | "destructive";
  destructive: boolean;
};

type AutopilotSafetyGateResult = {
  pass: boolean;
  reason: string | null;
  policy: {
    allowed: boolean;
    reason: string;
    evaluation_id?: string;
  };
  simulate: {
    executed: boolean;
    pass: boolean;
    workflow: "provision_user" | "deprovision_user" | null;
    summary: string;
  };
  preflight: {
    executed: boolean;
    pass: boolean;
    failed_prerequisites: string[];
    failed_invariants: string[];
  };
};

type AutopilotExecutionResult = TriChatAutopilotTickResult["execution"] & {
  reason: string | null;
};

type AutopilotMentorshipResult = TriChatAutopilotTickResult["mentorship"] & {
  postflight: {
    executed: boolean;
    pass: boolean;
    summary: string;
  };
};

export function initializeTriChatAutopilotDaemon(storage: Storage) {
  const persisted = storage.getTriChatAutopilotState();
  if (!persisted) {
    autopilotRuntime.config = { ...DEFAULT_AUTOPILOT_CONFIG };
    autopilotRuntime.pause_reason = null;
    stopAutopilotDaemon();
    return {
      restored: false,
      running: false,
      config: { ...autopilotRuntime.config },
      pause_reason: null,
    };
  }

  autopilotRuntime.config = resolveAutopilotConfig(persisted, DEFAULT_AUTOPILOT_CONFIG);
  autopilotRuntime.pause_reason = persisted.pause_reason;
  if (persisted.enabled) {
    startAutopilotDaemon(storage);
  } else {
    stopAutopilotDaemon();
  }

  return {
    restored: true,
    running: autopilotRuntime.running,
    config: { ...autopilotRuntime.config },
    pause_reason: autopilotRuntime.pause_reason,
    updated_at: persisted.updated_at,
  };
}

export function trichatAutopilotControl(storage: Storage, input: z.infer<typeof trichatAutopilotSchema>) {
  if (input.action === "status") {
    return getAutopilotStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.autopilot",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      if (input.action === "start") {
        const wasRunning = autopilotRuntime.running;
        autopilotRuntime.config = resolveAutopilotConfig(input, autopilotRuntime.config);
        autopilotRuntime.pause_reason = null;
        startAutopilotDaemon(storage);
        const persisted = storage.setTriChatAutopilotState({
          enabled: true,
          away_mode: autopilotRuntime.config.away_mode,
          interval_seconds: autopilotRuntime.config.interval_seconds,
          thread_id: autopilotRuntime.config.thread_id,
          thread_title: autopilotRuntime.config.thread_title,
          thread_status: autopilotRuntime.config.thread_status,
          objective: autopilotRuntime.config.objective,
          max_rounds: autopilotRuntime.config.max_rounds,
          min_success_agents: autopilotRuntime.config.min_success_agents,
          bridge_timeout_seconds: autopilotRuntime.config.bridge_timeout_seconds,
          bridge_dry_run: autopilotRuntime.config.bridge_dry_run,
          execute_enabled: autopilotRuntime.config.execute_enabled,
          command_allowlist: [...autopilotRuntime.config.command_allowlist],
          execute_backend: autopilotRuntime.config.execute_backend,
          tmux_session_name: autopilotRuntime.config.tmux_session_name,
          tmux_worker_count: autopilotRuntime.config.tmux_worker_count,
          tmux_max_queue_per_worker: autopilotRuntime.config.tmux_max_queue_per_worker,
          tmux_auto_scale_workers: autopilotRuntime.config.tmux_auto_scale_workers,
          tmux_sync_after_dispatch: autopilotRuntime.config.tmux_sync_after_dispatch,
          confidence_threshold: autopilotRuntime.config.confidence_threshold,
          max_consecutive_errors: autopilotRuntime.config.max_consecutive_errors,
          lock_key: autopilotRuntime.config.lock_key,
          lock_lease_seconds: autopilotRuntime.config.lock_lease_seconds,
          adr_policy: autopilotRuntime.config.adr_policy,
          pause_reason: null,
        });

        let initialTick: TriChatAutopilotTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = await runAutopilotTick(storage, autopilotRuntime.config, {
            trigger: "start",
          });
        }
        return {
          running: autopilotRuntime.running,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...autopilotRuntime.config },
          persisted,
          initial_tick: initialTick,
          status: getAutopilotStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = autopilotRuntime.running;
        stopAutopilotDaemon();
        const persisted = storage.setTriChatAutopilotState({
          enabled: false,
          away_mode: autopilotRuntime.config.away_mode,
          interval_seconds: autopilotRuntime.config.interval_seconds,
          thread_id: autopilotRuntime.config.thread_id,
          thread_title: autopilotRuntime.config.thread_title,
          thread_status: autopilotRuntime.config.thread_status,
          objective: autopilotRuntime.config.objective,
          max_rounds: autopilotRuntime.config.max_rounds,
          min_success_agents: autopilotRuntime.config.min_success_agents,
          bridge_timeout_seconds: autopilotRuntime.config.bridge_timeout_seconds,
          bridge_dry_run: autopilotRuntime.config.bridge_dry_run,
          execute_enabled: autopilotRuntime.config.execute_enabled,
          command_allowlist: [...autopilotRuntime.config.command_allowlist],
          execute_backend: autopilotRuntime.config.execute_backend,
          tmux_session_name: autopilotRuntime.config.tmux_session_name,
          tmux_worker_count: autopilotRuntime.config.tmux_worker_count,
          tmux_max_queue_per_worker: autopilotRuntime.config.tmux_max_queue_per_worker,
          tmux_auto_scale_workers: autopilotRuntime.config.tmux_auto_scale_workers,
          tmux_sync_after_dispatch: autopilotRuntime.config.tmux_sync_after_dispatch,
          confidence_threshold: autopilotRuntime.config.confidence_threshold,
          max_consecutive_errors: autopilotRuntime.config.max_consecutive_errors,
          lock_key: autopilotRuntime.config.lock_key,
          lock_lease_seconds: autopilotRuntime.config.lock_lease_seconds,
          adr_policy: autopilotRuntime.config.adr_policy,
          pause_reason: autopilotRuntime.pause_reason,
        });
        return {
          running: false,
          stopped: wasRunning,
          persisted,
          status: getAutopilotStatus(),
        };
      }

      const config = resolveAutopilotConfig(input, autopilotRuntime.config);
      const tick = await runAutopilotTick(storage, config, {
        trigger: "run_once",
      });
      return {
        running: autopilotRuntime.running,
        tick,
        status: getAutopilotStatus(),
      };
    },
  });
}

async function runAutopilotTick(
  storage: Storage,
  rawConfig: TriChatAutopilotConfig,
  options: { trigger: "interval" | "start" | "run_once" }
): Promise<TriChatAutopilotTickResult> {
  const config = resolveAutopilotConfig(rawConfig, autopilotRuntime.config);
  const heartbeatSessionKey = buildAutopilotHeartbeatSessionKey(config);
  const invocationId = ++autopilotInvocationCounter;
  const tickOwnerId = `${AUTOPILOT_WORKER_ID}:${AUTOPILOT_OWNER_NONCE}:${invocationId}`;
  const tickLockAcquire = await acquireLock(storage, {
    mutation: buildAutopilotMutation(
      `${heartbeatSessionKey}:single-flight:${tickOwnerId}`,
      "single_flight.acquire",
      AUTOPILOT_TICK_LOCK_KEY
    ),
    lock_key: AUTOPILOT_TICK_LOCK_KEY,
    owner_id: tickOwnerId,
    lease_seconds: config.lock_lease_seconds,
    metadata: {
      source: "trichat.autopilot",
      trigger: options.trigger,
      session_key: heartbeatSessionKey,
    },
  });

  if (!tickLockAcquire.acquired) {
    return await runAutopilotOverlapSkip(storage, {
      config,
      session_key: heartbeatSessionKey,
      reason: tickLockAcquire.reason ?? "single-flight-held",
      owner_id: tickOwnerId,
      trigger: options.trigger,
    });
  }

  autopilotRuntime.in_tick = true;
  let releaseTickLock = true;
  let sessionKey = heartbeatSessionKey;
  let runId = buildAutopilotRunId(sessionKey);
  let intakeResult: AutopilotGoalIntakeResult | null = null;
  let incidentId: string | null = null;
  let councilConfidence = 0;
  let verifyStatus: TriChatAutopilotTickResult["verify_status"] = "skipped";
  let verifySummary = "verify skipped";
  let emergencyBrakeTriggered = false;
  let pauseReason: string | null = null;
  const stepStatus: TriChatAutopilotTickResult["step_status"] = [];
  const defaultExecution: TriChatAutopilotTickResult["execution"] = {
    mode: "none",
    commands: [],
    blocked_commands: [],
    task_id: null,
    direct_success: false,
    tmux: null,
    command_results: [],
  };
  let executionResult: AutopilotExecutionResult = {
    ...defaultExecution,
    reason: null,
  };
  let mentorshipResult: AutopilotMentorshipResult = {
    session_id: runId,
    transcript_entries: 0,
    summarize_note_id: null,
    memory_id: null,
    postflight: {
      executed: false,
      pass: true,
      summary: "postflight skipped",
    },
  };
  let governanceResult: TriChatAutopilotTickResult["governance"] = {
    adr_id: null,
    adr_path: null,
    skipped_reason: "not-run",
  };
  let sourceTaskId: string | null = null;
  let successAgents = 0;
  let turnId: string | null = null;
  let userMessageId: string | null = null;
  let failureReason: string | null = null;
  let finalStatus: "succeeded" | "failed" | "aborted" = "succeeded";

  try {
    const claimedTask = await taskClaim(storage, {
      mutation: buildAutopilotMutation(heartbeatSessionKey, "goal_intake.task_claim", AUTOPILOT_WORKER_ID),
      worker_id: AUTOPILOT_WORKER_ID,
      lease_seconds: config.lock_lease_seconds,
    });
    if (claimedTask.claimed && claimedTask.task) {
      sessionKey = buildAutopilotTaskSessionKey(claimedTask.task.task_id, claimedTask.task.attempt_count);
      sourceTaskId = claimedTask.task.task_id;
    }
    runId = buildAutopilotRunId(sessionKey);

    await runBegin(storage, {
      mutation: buildAutopilotMutation(sessionKey, "run.begin", runId),
      run_id: runId,
      status: "in_progress",
      summary: `trichat.autopilot tick trigger=${options.trigger}`,
      details: {
        trigger: options.trigger,
        away_mode: config.away_mode,
        session_key: sessionKey,
        heartbeat_session_key: heartbeatSessionKey,
      },
      source_client: "trichat.autopilot",
      source_agent: AUTOPILOT_WORKER_ID,
    });

    mentorshipResult.session_id = runId;

    const activeIntake = await runAutopilotGoalIntake(storage, {
      session_key: sessionKey,
      config,
      claimed_task: claimedTask,
    });
    intakeResult = activeIntake;
    sourceTaskId = activeIntake.source_task?.task_id ?? null;
    turnId = activeIntake.turn_id;
    userMessageId = activeIntake.user_message_id;
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "goal_intake",
      status: "completed",
      summary: `goal intake complete source=${activeIntake.objective_source}`,
      details: {
        objective: activeIntake.objective,
        objective_source: activeIntake.objective_source,
        source_task_id: sourceTaskId,
        thread_id: activeIntake.thread_id,
        turn_id: activeIntake.turn_id,
      },
      step_status: stepStatus,
    });

    const council = await runAutopilotCouncil(storage, {
      session_key: sessionKey,
      config,
      intake: activeIntake,
    });
    councilConfidence = council.council_confidence;
    successAgents = council.success_agents.length;
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "council",
      status: "completed",
      summary: `council complete confidence=${council.council_confidence.toFixed(3)}`,
      details: {
        selected_agent: council.selected_agent,
        selected_strategy: council.selected_strategy,
        decision_summary: council.decision_summary,
        success_agents: council.success_agents,
      },
      step_status: stepStatus,
    });

    if (councilConfidence < config.confidence_threshold) {
      emergencyBrakeTriggered = true;
      failureReason = `confidence below threshold (${councilConfidence.toFixed(3)} < ${config.confidence_threshold.toFixed(3)})`;
    }

    const commandPlan = buildAutopilotCommandPlan({
      selected_strategy: council.selected_strategy,
      selected_agent: council.selected_agent,
      proposals: council.proposals,
      allowlist: config.command_allowlist,
    });

    const safetyGate = await evaluateAutopilotSafetyGate(storage, {
      session_key: sessionKey,
      config,
      command_plan: commandPlan,
      intake: activeIntake,
      council,
      confidence: councilConfidence,
    });
    if (!failureReason && !safetyGate.pass) {
      failureReason = safetyGate.reason ?? "safety gate failed";
    }
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "safety_gate",
      status: safetyGate.pass ? "completed" : "failed",
      summary: safetyGate.pass ? "safety gate passed" : safetyGate.reason ?? "safety gate failed",
      details: {
        policy: safetyGate.policy,
        simulate: safetyGate.simulate,
        preflight: safetyGate.preflight,
        command_plan: {
          source: commandPlan.source,
          command_count: commandPlan.commands.length,
          blocked_count: commandPlan.blocked_commands.length,
          classification: commandPlan.classification,
        },
      },
      step_status: stepStatus,
    });

    executionResult = await runAutopilotExecution(storage, {
      session_key: sessionKey,
      config,
      intake: activeIntake,
      command_plan: commandPlan,
      execute_allowed: !failureReason && safetyGate.pass,
      selected_strategy: council.selected_strategy,
    });
    if (!failureReason && executionResult.reason) {
      failureReason = executionResult.reason;
    }
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "execute",
      status: failureReason ? "failed" : "completed",
      summary:
        executionResult.mode === "direct_command"
          ? `execute direct commands=${executionResult.commands.length}`
          : executionResult.mode === "tmux_dispatch"
            ? `execute tmux dispatch commands=${executionResult.commands.length} session=${
                executionResult.tmux?.session_name ?? "n/a"
              }`
          : executionResult.mode === "task_fallback"
            ? "execute fallback task.create"
            : "execute skipped",
      details: {
        mode: executionResult.mode,
        commands: executionResult.commands,
        blocked_commands: executionResult.blocked_commands,
        task_id: executionResult.task_id,
        direct_success: executionResult.direct_success,
        tmux: executionResult.tmux,
        reason: executionResult.reason,
      },
      step_status: stepStatus,
    });

    verifyStatus = resolveAutopilotVerifyStatus(failureReason, executionResult);
    verifySummary = failureReason
      ? failureReason
      : verifyStatus === "passed"
        ? "execution checks passed"
        : verifyStatus === "skipped"
          ? "execution deferred to task queue"
          : "execution checks failed";
    await runAutopilotIdempotent(storage, {
      tool_name: "trichat.turn_orchestrate",
      session_key: sessionKey,
      label: "verify_finalize.turn_orchestrate",
      fingerprint: `${activeIntake.turn_id}:${verifyStatus}:${verifySummary}`,
      payload: {
        turn_id: activeIntake.turn_id,
        verify_status: verifyStatus,
      },
      execute: () =>
        trichatTurnOrchestrate(storage, {
          mutation: AUTOPILOT_INLINE_MUTATION,
          turn_id: activeIntake.turn_id,
          action: "verify_finalize",
          verify_status: verifyStatus,
          verify_summary: verifySummary,
          verify_details: {
            mode: executionResult.mode,
            direct_success: executionResult.direct_success,
            command_count: executionResult.commands.length,
            blocked_count: executionResult.blocked_commands.length,
            task_id: executionResult.task_id,
            tmux: executionResult.tmux,
          },
          allow_phase_skip: true,
        }),
    });
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "verify_finalize",
      status: failureReason ? "failed" : "completed",
      summary: `verify_finalize status=${verifyStatus}`,
      details: {
        verify_status: verifyStatus,
        verify_summary: verifySummary,
      },
      step_status: stepStatus,
    });

    mentorshipResult = await runAutopilotMentorship(storage, {
      session_key: sessionKey,
      config,
      run_id: runId,
      intake: activeIntake,
      council,
      execution: executionResult,
      verify_status: verifyStatus,
      verify_summary: verifySummary,
    });
    if (!failureReason && !mentorshipResult.postflight.pass) {
      failureReason = mentorshipResult.postflight.summary;
    }
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "mentorship",
      status: failureReason ? "failed" : "completed",
      summary: failureReason ? failureReason : "mentorship complete",
      details: {
        transcript_entries: mentorshipResult.transcript_entries,
        summarize_note_id: mentorshipResult.summarize_note_id,
        memory_id: mentorshipResult.memory_id,
        postflight: mentorshipResult.postflight,
      },
      step_status: stepStatus,
    });

    governanceResult = await runAutopilotGovernance(storage, {
      session_key: sessionKey,
      config,
      intake: activeIntake,
      council,
      execution: executionResult,
      verify_status: verifyStatus,
      verify_summary: verifySummary,
      skip: Boolean(failureReason),
    });
    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "governance",
      status: failureReason ? "skipped" : "completed",
      summary: governanceResult.skipped_reason ?? "governance complete",
      details: {
        adr_id: governanceResult.adr_id,
        adr_path: governanceResult.adr_path,
        skipped_reason: governanceResult.skipped_reason,
      },
      step_status: stepStatus,
    });

    const failureLower = String(failureReason ?? "").toLowerCase();
    const shouldOpenImmediateIncident =
      Boolean(failureReason) &&
      (config.away_mode === "normal" || (config.away_mode === "aggressive" && failureLower.includes("policy denied")));
    if (shouldOpenImmediateIncident) {
      incidentId = await openAutopilotIncident(storage, {
        session_key: sessionKey,
        run_id: runId,
        away_mode: config.away_mode,
        reason: failureReason ?? "autopilot failure",
        destructive: executionResult.commands.some((command) =>
          AUTOPILOT_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
        ),
        policy_denied: verifySummary.toLowerCase().includes("policy"),
        thread_id: activeIntake.thread_id,
        task_id: sourceTaskId,
      });
    }

    if (failureReason || emergencyBrakeTriggered) {
      finalStatus = "failed";
      pauseReason = emergencyBrakeTriggered
        ? failureReason ?? "emergency brake triggered"
        : autopilotRuntime.consecutive_error_count + 1 >= config.max_consecutive_errors
          ? `consecutive error threshold reached (${config.max_consecutive_errors})`
          : null;
    }

    if (sourceTaskId) {
      if (failureReason || emergencyBrakeTriggered) {
        await taskFail(storage, {
          mutation: buildAutopilotMutation(sessionKey, "task.fail", sourceTaskId),
          task_id: sourceTaskId,
          worker_id: AUTOPILOT_WORKER_ID,
          error: compactConsensusText(failureReason ?? "autopilot execution failed", 300),
          result: {
            run_id: runId,
            verify_status: verifyStatus,
            incident_id: incidentId,
          },
          summary: "trichat.autopilot failed execution",
        });
      } else {
        await taskComplete(storage, {
          mutation: buildAutopilotMutation(sessionKey, "task.complete", sourceTaskId),
          task_id: sourceTaskId,
          worker_id: AUTOPILOT_WORKER_ID,
          summary: "trichat.autopilot completed execution",
          result: {
            run_id: runId,
            verify_status: verifyStatus,
            execution_mode: executionResult.mode,
            task_id: executionResult.task_id,
          },
        });
      }
    }

    await appendAutopilotRunStep(storage, {
      session_key: sessionKey,
      run_id: runId,
      step_name: "complete",
      status: finalStatus === "succeeded" ? "completed" : "failed",
      summary: finalStatus === "succeeded" ? "autopilot tick complete" : failureReason ?? "autopilot tick failed",
      details: {
        verify_status: verifyStatus,
        verify_summary: verifySummary,
        emergency_brake_triggered: emergencyBrakeTriggered,
        incident_id: incidentId,
      },
      step_status: stepStatus,
    });

    await runEnd(storage, {
      mutation: buildAutopilotMutation(sessionKey, "run.end", `${runId}:${finalStatus}`),
      run_id: runId,
      status: finalStatus === "succeeded" ? "succeeded" : "failed",
      summary: finalStatus === "succeeded" ? "trichat.autopilot tick succeeded" : failureReason ?? "autopilot failed",
      details: {
        session_key: sessionKey,
        thread_id: activeIntake.thread_id,
        turn_id: activeIntake.turn_id,
        source_task_id: sourceTaskId,
        verify_status: verifyStatus,
        verify_summary: verifySummary,
        incident_id: incidentId,
      },
      source_client: "trichat.autopilot",
      source_agent: AUTOPILOT_WORKER_ID,
    });

    if ((finalStatus !== "succeeded" && autopilotRuntime.consecutive_error_count + 1 >= config.max_consecutive_errors) || emergencyBrakeTriggered) {
      pauseReason =
        pauseReason ??
        (finalStatus !== "succeeded"
          ? `consecutive error threshold reached (${config.max_consecutive_errors})`
          : "confidence threshold emergency brake");
      if (!incidentId) {
        incidentId = await openAutopilotIncident(storage, {
          session_key: sessionKey,
          run_id: runId,
          away_mode: config.away_mode,
          reason: pauseReason,
          destructive: executionResult.commands.some((command) =>
            AUTOPILOT_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
          ),
          policy_denied: verifySummary.toLowerCase().includes("policy"),
          thread_id: activeIntake.thread_id,
          task_id: sourceTaskId,
        });
      }
      await pauseAutopilotDaemon(storage, config, pauseReason);
      emergencyBrakeTriggered = true;
    }

    const tickResult: TriChatAutopilotTickResult = {
      ok: finalStatus === "succeeded",
      completed_at: new Date().toISOString(),
      run_id: runId,
      session_key: sessionKey,
      away_mode: config.away_mode,
      thread_id: activeIntake.thread_id,
      turn_id: activeIntake.turn_id,
      user_message_id: activeIntake.user_message_id,
      source_task_id: sourceTaskId,
      council_confidence: councilConfidence,
      success_agents: successAgents,
      emergency_brake_triggered: emergencyBrakeTriggered,
      incident_id: incidentId,
      verify_status: verifyStatus,
      verify_summary: verifySummary,
      execution: {
        mode: executionResult.mode,
        commands: [...executionResult.commands],
        blocked_commands: [...executionResult.blocked_commands],
        task_id: executionResult.task_id,
        direct_success: executionResult.direct_success,
        tmux: executionResult.tmux,
        command_results: executionResult.command_results,
      },
      mentorship: {
        session_id: mentorshipResult.session_id,
        transcript_entries: mentorshipResult.transcript_entries,
        summarize_note_id: mentorshipResult.summarize_note_id,
        memory_id: mentorshipResult.memory_id,
      },
      governance: governanceResult,
      step_status: stepStatus,
      reason: finalStatus === "succeeded" ? null : failureReason ?? "autopilot failed",
    };
    finalizeAutopilotRuntimeFromTick(tickResult);
    return tickResult;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    finalStatus = "failed";
    const fallbackRunId = runId || buildAutopilotRunId(sessionKey);
    try {
      await runEnd(storage, {
        mutation: buildAutopilotMutation(sessionKey, "run.end.error", `${fallbackRunId}:${reason}`),
        run_id: fallbackRunId,
        status: "failed",
        summary: compactConsensusText(`autopilot tick failed: ${reason}`, 280),
        details: {
          session_key: sessionKey,
          reason,
          source_task_id: sourceTaskId,
        },
        source_client: "trichat.autopilot",
        source_agent: AUTOPILOT_WORKER_ID,
      });
    } catch {
      // ignore secondary failures during panic-path run finalization.
    }
    const tickResult: TriChatAutopilotTickResult = {
      ok: false,
      completed_at: new Date().toISOString(),
      run_id: fallbackRunId,
      session_key: sessionKey,
      away_mode: config.away_mode,
      thread_id: intakeResult?.thread_id ?? config.thread_id,
      turn_id: intakeResult?.turn_id ?? null,
      user_message_id: intakeResult?.user_message_id ?? null,
      source_task_id: sourceTaskId,
      council_confidence: councilConfidence,
      success_agents: successAgents,
      emergency_brake_triggered: false,
      incident_id: incidentId,
      verify_status: "error",
      verify_summary: reason,
      execution: {
        mode: executionResult.mode,
        commands: executionResult.commands,
        blocked_commands: executionResult.blocked_commands,
        task_id: executionResult.task_id,
        direct_success: executionResult.direct_success,
        tmux: executionResult.tmux,
        command_results: executionResult.command_results,
      },
      mentorship: {
        session_id: mentorshipResult.session_id,
        transcript_entries: mentorshipResult.transcript_entries,
        summarize_note_id: mentorshipResult.summarize_note_id,
        memory_id: mentorshipResult.memory_id,
      },
      governance: governanceResult,
      step_status: stepStatus,
      reason,
    };
    finalizeAutopilotRuntimeFromTick(tickResult);
    if (sourceTaskId) {
      try {
        await taskFail(storage, {
          mutation: buildAutopilotMutation(sessionKey, "task.fail.panic", sourceTaskId),
          task_id: sourceTaskId,
          worker_id: AUTOPILOT_WORKER_ID,
          error: compactConsensusText(reason, 300),
          result: {
            run_id: fallbackRunId,
            verify_status: "error",
          },
          summary: "trichat.autopilot panic failure",
        });
      } catch {
        // ignore secondary failures while failing claimed task on panic path.
      }
    }
    const openedIncidentId = await openAutopilotIncident(storage, {
      session_key: sessionKey,
      run_id: fallbackRunId,
      away_mode: config.away_mode,
      reason,
      destructive: false,
      policy_denied: false,
      thread_id: intakeResult?.thread_id ?? config.thread_id,
      task_id: sourceTaskId,
    });
    tickResult.incident_id = openedIncidentId;
    if (autopilotRuntime.consecutive_error_count >= config.max_consecutive_errors) {
      await pauseAutopilotDaemon(storage, config, `consecutive error threshold reached (${config.max_consecutive_errors})`);
      tickResult.emergency_brake_triggered = true;
    }
    return tickResult;
  } finally {
    if (releaseTickLock) {
      try {
        await releaseLock(storage, {
          mutation: buildAutopilotMutation(
            `${sessionKey}:single-flight:${tickOwnerId}`,
            "single_flight.release",
            AUTOPILOT_TICK_LOCK_KEY
          ),
          lock_key: AUTOPILOT_TICK_LOCK_KEY,
          owner_id: tickOwnerId,
        });
      } catch {
        // keep daemon alive if lock release races with lease expiry.
      }
    }
    autopilotRuntime.in_tick = false;
  }
}

async function runAutopilotGoalIntake(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    claimed_task: Awaited<ReturnType<typeof taskClaim>>;
  }
): Promise<AutopilotGoalIntakeResult> {
  const sourceTask = input.claimed_task.claimed && input.claimed_task.task ? input.claimed_task.task : null;
  const objectiveSource = sourceTask ? "task" : "heartbeat";
  const objective = compactConsensusText(
    sourceTask?.objective?.trim() || input.config.objective.trim(),
    600
  );
  const projectDir = sourceTask?.project_dir?.trim() || process.cwd();
  await runAutopilotIdempotent(storage, {
    tool_name: "memory.append",
    session_key: input.session_key,
    label: "goal_intake.workspace_fingerprint",
    fingerprint: projectDir,
    payload: {
      project_dir: projectDir,
    },
    execute: () =>
      ensureWorkspaceFingerprint(storage, projectDir, {
        source: "trichat.autopilot",
      }),
  });
  const thread = await runAutopilotIdempotent(storage, {
    tool_name: "trichat.thread_open",
    session_key: input.session_key,
    label: "goal_intake.thread_open",
    fingerprint: `${input.config.thread_id}:${input.config.thread_title}:${input.config.thread_status}`,
    payload: {
      thread_id: input.config.thread_id,
      thread_status: input.config.thread_status,
    },
    execute: () =>
      trichatThreadOpen(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        thread_id: input.config.thread_id,
        title: input.config.thread_title,
        status: input.config.thread_status,
        metadata: {
          source: "trichat.autopilot",
          internal: true,
        },
      }),
  });
  const userMessage = await runAutopilotIdempotent(storage, {
    tool_name: "trichat.message_post",
    session_key: input.session_key,
    label: "goal_intake.message_post",
    fingerprint: objective,
    payload: {
      thread_id: thread.thread.thread_id,
      objective_source: objectiveSource,
    },
    execute: () =>
      trichatMessagePost(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        thread_id: thread.thread.thread_id,
        agent_id: "user",
        role: "user",
        content: objective,
        metadata: {
          source: "trichat.autopilot",
          objective_source: objectiveSource,
          source_task_id: sourceTask?.task_id ?? null,
        },
      }),
  });
  const started = await runAutopilotIdempotent(storage, {
    tool_name: "trichat.turn_start",
    session_key: input.session_key,
    label: "goal_intake.turn_start",
    fingerprint: userMessage.message.message_id,
    payload: {
      thread_id: thread.thread.thread_id,
      user_message_id: userMessage.message.message_id,
    },
    execute: () =>
      trichatTurnStart(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        thread_id: thread.thread.thread_id,
        user_message_id: userMessage.message.message_id,
        user_prompt: objective,
        expected_agents: [...DEFAULT_CONSENSUS_AGENT_IDS],
        min_agents: input.config.min_success_agents,
        metadata: {
          source: "trichat.autopilot",
          project_dir: projectDir,
        },
      }),
  });
  await runAutopilotIdempotent(storage, {
    tool_name: "trichat.turn_advance",
    session_key: input.session_key,
    label: "goal_intake.turn_advance.propose",
    fingerprint: started.turn.turn_id,
    payload: {
      turn_id: started.turn.turn_id,
      phase: "propose",
    },
    execute: () =>
      trichatTurnAdvance(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        turn_id: started.turn.turn_id,
        phase: "propose",
        phase_status: "running",
        status: "running",
      }),
  });
  return {
    source_task: sourceTask,
    objective,
    objective_source: objectiveSource,
    thread_id: thread.thread.thread_id,
    user_message_id: userMessage.message.message_id,
    turn_id: started.turn.turn_id,
    project_dir: projectDir,
  };
}

async function runAutopilotCouncil(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    intake: AutopilotGoalIntakeResult;
  }
): Promise<AutopilotCouncilResult> {
  const proposalsByAgent = new Map<string, AutopilotProposal>();
  const successAgents = new Set<string>();
  let targetAgents: string[] = [...DEFAULT_CONSENSUS_AGENT_IDS];
  for (let round = 1; round <= input.config.max_rounds; round += 1) {
    const roundOutcome = await runAutopilotCouncilRoundParallel(storage, {
      session_key: input.session_key,
      config: input.config,
      intake: input.intake,
      round,
      target_agents: targetAgents,
    });
    for (const settled of roundOutcome.settled) {
      const { agent_id: agentId, lane, result: askResult } = settled;
      if (!askResult.ok || !askResult.content) {
        continue;
      }
      const askContent = askResult.content;
      successAgents.add(agentId);
      const message = await runAutopilotIdempotent(storage, {
        tool_name: "trichat.message_post",
        session_key: input.session_key,
        label: `council.message_post.round${round}.${agentId}`,
        fingerprint: `${input.intake.user_message_id}:${askContent}`,
        payload: {
          thread_id: input.intake.thread_id,
          agent_id: agentId,
          round,
        },
        execute: () =>
          trichatMessagePost(storage, {
            mutation: AUTOPILOT_INLINE_MUTATION,
            thread_id: input.intake.thread_id,
            agent_id: agentId,
            role: "assistant",
            content: askContent,
            reply_to_message_id: input.intake.user_message_id,
            metadata: {
              source: "trichat.autopilot",
              round,
              lane,
              confidence: askResult.confidence,
              quorum_reached: roundOutcome.quorum_reached,
            },
          }),
      });
      const artifact = await runAutopilotIdempotent(storage, {
        tool_name: "trichat.turn_artifact",
        session_key: input.session_key,
        label: `council.turn_artifact.round${round}.${agentId}`,
        fingerprint: `${input.intake.turn_id}:${askResult.strategy}:${askResult.confidence}`,
        payload: {
          turn_id: input.intake.turn_id,
          agent_id: agentId,
          round,
        },
        execute: () =>
          trichatTurnArtifact(storage, {
            mutation: AUTOPILOT_INLINE_MUTATION,
            turn_id: input.intake.turn_id,
            phase: "propose",
            artifact_type: round === 1 ? "proposal" : "proposal_retry",
            agent_id: agentId,
            content: askContent,
            structured: {
              source: "trichat.autopilot",
              lane,
              round,
              strategy: askResult.strategy,
              commands: askResult.commands,
              confidence: askResult.confidence,
              mentorship_note: askResult.mentorship_note,
              quorum_reached: roundOutcome.quorum_reached,
              aborted_agents: roundOutcome.aborted_agents,
            },
            score: askResult.confidence,
            metadata: {
              source: "trichat.autopilot",
              round,
            },
          }),
      });
      proposalsByAgent.set(agentId, {
        agent_id: agentId,
        lane,
        round,
        content: askContent,
        strategy: askResult.strategy,
        commands: askResult.commands,
        confidence: askResult.confidence,
        message_id: message.message.message_id,
        artifact_id: artifact.artifact.artifact_id,
      });
    }

    const novelty = trichatNovelty(storage, {
      turn_id: input.intake.turn_id,
      novelty_threshold: 0.35,
      max_similarity: 0.82,
      limit: 200,
    });
    if (!novelty.found || !novelty.retry_required || round >= input.config.max_rounds) {
      break;
    }
    targetAgents = novelty.retry_agents.length > 0 ? novelty.retry_agents : [...DEFAULT_CONSENSUS_AGENT_IDS];
  }

  const orchestrated = await runAutopilotIdempotent(storage, {
    tool_name: "trichat.turn_orchestrate",
    session_key: input.session_key,
    label: "council.turn_orchestrate.decide",
    fingerprint: input.intake.turn_id,
    payload: {
      turn_id: input.intake.turn_id,
      action: "decide",
    },
    execute: () =>
      trichatTurnOrchestrate(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        turn_id: input.intake.turn_id,
        action: "decide",
        novelty_threshold: 0.35,
        max_similarity: 0.82,
        allow_phase_skip: true,
      }),
  }) as Record<string, unknown>;
  const decision = (orchestrated.decision ?? {}) as Record<string, unknown>;
  const selectedAgentRaw = String(
    decision.selected_agent ?? (orchestrated.turn as Record<string, unknown> | undefined)?.selected_agent ?? ""
  ).trim();
  const selectedAgent = normalizeConsensusAgentId(selectedAgentRaw) || null;
  const selectedStrategy = compactConsensusText(
    String(
      decision.selected_strategy ?? (orchestrated.turn as Record<string, unknown> | undefined)?.selected_strategy ?? ""
    ),
    2000
  );
  const selectedProposal = selectedAgent ? proposalsByAgent.get(selectedAgent) ?? null : null;
  const decisionScore = asFiniteNumber(decision.score);
  const fallbackConfidence = selectedProposal?.confidence ?? inferProposalConfidence(selectedStrategy);
  const confidenceSeed = decisionScore ?? fallbackConfidence;
  const adjustedConfidence =
    successAgents.size >= input.config.min_success_agents ? confidenceSeed : Math.min(confidenceSeed, 0.39);

  return {
    proposals: [...proposalsByAgent.values()],
    selected_agent: selectedAgent,
    selected_strategy: selectedStrategy,
    decision_summary: compactConsensusText(String(decision.decision_summary ?? ""), 500),
    decision_score: decisionScore,
    council_confidence: clamp(adjustedConfidence, 0.05, 0.99),
    success_agents: [...successAgents].sort(),
  };
}

async function runAutopilotCouncilRoundParallel(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    intake: AutopilotGoalIntakeResult;
    round: number;
    target_agents: string[];
  }
): Promise<{
  settled: Array<{
    agent_id: string;
    lane: string;
    result: Awaited<ReturnType<typeof runAutopilotBridgeAsk>>;
  }>;
  quorum_reached: boolean;
  aborted_agents: string[];
}> {
  const minSuccessAgents = Math.max(1, input.config.min_success_agents);
  const abortController = new AbortController();
  const pending = new Map<
    string,
    Promise<{
      agent_id: string;
      lane: string;
      result: Awaited<ReturnType<typeof runAutopilotBridgeAsk>>;
    }>
  >();
  for (const rawAgentId of input.target_agents) {
    const agentId = normalizeConsensusAgentId(rawAgentId);
    if (!agentId) {
      continue;
    }
    const lane = AUTOPILOT_AGENT_ROLE_LANES[agentId] ?? "collaborator";
    const task = runAutopilotBridgeAsk(storage, {
      session_key: input.session_key,
      config: input.config,
      thread_id: input.intake.thread_id,
      objective: input.intake.objective,
      round: input.round,
      agent_id: agentId,
      lane,
      signal: abortController.signal,
    })
      .then((result) => ({
        agent_id: agentId,
        lane,
        result,
      }))
      .catch((error) => ({
        agent_id: agentId,
        lane,
        result: {
          ok: false,
          content: null,
          strategy: "",
          commands: [],
          confidence: 0.2,
          mentorship_note: null,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    pending.set(agentId, task);
  }

  const settled: Array<{
    agent_id: string;
    lane: string;
    result: Awaited<ReturnType<typeof runAutopilotBridgeAsk>>;
  }> = [];
  let successCount = 0;
  let quorumReached = false;

  while (pending.size > 0) {
    const completed = await Promise.race([...pending.values()]);
    pending.delete(completed.agent_id);
    settled.push(completed);
    if (completed.result.ok && completed.result.content) {
      successCount += 1;
    }
    if (!quorumReached && successCount >= minSuccessAgents) {
      quorumReached = true;
      abortController.abort();
      break;
    }
  }

  const abortedAgents: string[] = [];
  if (pending.size > 0) {
    const leftovers = await Promise.all([...pending.values()]);
    for (const completed of leftovers) {
      settled.push(completed);
      if (
        completed.result.error &&
        completed.result.error.toLowerCase().includes("aborted by quorum-finalize")
      ) {
        abortedAgents.push(completed.agent_id);
      }
    }
  }

  return {
    settled,
    quorum_reached: quorumReached,
    aborted_agents: [...new Set(abortedAgents)].sort(),
  };
}

async function evaluateAutopilotSafetyGate(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    command_plan: AutopilotCommandPlan;
    intake: AutopilotGoalIntakeResult;
    council: AutopilotCouncilResult;
    confidence: number;
  }
): Promise<AutopilotSafetyGateResult> {
  const confirmations = input.council.success_agents.map((agentId) => ({
    source: agentId,
    confirmed: true,
    evidence: "proposal-received",
  }));
  const policyResult = await runAutopilotIdempotent(storage, {
    tool_name: "policy.evaluate",
    session_key: input.session_key,
    label: "safety_gate.policy_evaluate",
    fingerprint: `${input.command_plan.classification}:${input.intake.project_dir}`,
    payload: {
      classification: input.command_plan.classification,
      objective: input.intake.objective,
    },
    execute: () =>
      evaluatePolicy(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        policy_name: "local-default",
        operation: "trichat.autopilot.execute",
        target: input.intake.project_dir,
        classification: input.command_plan.classification,
        execution_mode: input.config.away_mode === "safe" ? "staged" : "execute",
        requires_two_source_confirmation: input.command_plan.classification === "destructive",
        confirmations,
        attributes: {
          away_mode: input.config.away_mode,
          objective: input.intake.objective,
          command_count: input.command_plan.commands.length,
          blocked_count: input.command_plan.blocked_commands.length,
          confidence: input.confidence,
        },
        source_client: "trichat.autopilot",
        source_agent: AUTOPILOT_WORKER_ID,
      }),
  });
  if (!policyResult.allowed) {
    return {
      pass: false,
      reason: `policy denied: ${policyResult.reason}`,
      policy: {
        allowed: false,
        reason: policyResult.reason,
        evaluation_id: policyResult.evaluation_id,
      },
      simulate: {
        executed: false,
        pass: false,
        workflow: null,
        summary: "simulate skipped due to policy denial",
      },
      preflight: {
        executed: false,
        pass: false,
        failed_prerequisites: ["policy.allowed"],
        failed_invariants: [],
      },
    };
  }

  let simulate = {
    executed: false,
    pass: true,
    workflow: null as "provision_user" | "deprovision_user" | null,
    summary: "simulate skipped",
  };
  if (input.config.away_mode === "safe" && input.command_plan.classification !== "read") {
    const workflow =
      input.command_plan.classification === "destructive" ? "deprovision_user" : "provision_user";
    const simulation = simulateWorkflow({
      workflow,
      employment_type: "FTE",
      execution_mode: "staged",
      manager_dn_resolved: true,
      scim_ready: true,
    });
    simulate = {
      executed: true,
      pass: simulation.summary.pass,
      workflow,
      summary: simulation.summary.pass
        ? `${workflow} simulation passed`
        : `${workflow} simulation mismatches=${simulation.summary.mismatches}`,
    };
    if (!simulation.summary.pass) {
      return {
        pass: false,
        reason: simulate.summary,
        policy: {
          allowed: true,
          reason: policyResult.reason,
          evaluation_id: policyResult.evaluation_id,
        },
        simulate,
        preflight: {
          executed: false,
          pass: false,
          failed_prerequisites: ["simulate.workflow.pass"],
          failed_invariants: [],
        },
      };
    }
  }

  if (input.config.away_mode === "safe") {
    const preflight = preflightCheck({
      action: "trichat.autopilot.execute",
      target: input.intake.project_dir,
      classification: input.command_plan.classification,
      prerequisites: [
        {
          name: "policy.allowed",
          met: policyResult.allowed,
          details: policyResult.reason,
          severity: "error",
        },
        {
          name: "command_plan.available",
          met: input.command_plan.commands.length > 0 || !input.config.execute_enabled,
          details: `commands=${input.command_plan.commands.length} execute_enabled=${input.config.execute_enabled}`,
          severity: "error",
        },
        {
          name: "command_plan.unblocked",
          met: input.command_plan.blocked_commands.length === 0 || !input.config.execute_enabled,
          details: `blocked=${input.command_plan.blocked_commands.join(",") || "none"}`,
          severity: "error",
        },
      ],
      invariants: [
        {
          name: "confidence.meets_threshold",
          met: input.confidence >= input.config.confidence_threshold,
          details: `confidence=${input.confidence.toFixed(3)} threshold=${input.config.confidence_threshold.toFixed(3)}`,
          severity: "warn",
        },
        {
          name: "success_agents.meet_minimum",
          met: input.council.success_agents.length >= input.config.min_success_agents,
          details: `success_agents=${input.council.success_agents.length} min=${input.config.min_success_agents}`,
          severity: "warn",
        },
      ],
    });
    if (!preflight.pass) {
      return {
        pass: false,
        reason: "safe mode preflight checks failed",
        policy: {
          allowed: true,
          reason: policyResult.reason,
          evaluation_id: policyResult.evaluation_id,
        },
        simulate,
        preflight: {
          executed: true,
          pass: false,
          failed_prerequisites: preflight.failed_prerequisites.map((entry) => entry.name),
          failed_invariants: preflight.failed_invariants.map((entry) => entry.name),
        },
      };
    }
    return {
      pass: true,
      reason: null,
      policy: {
        allowed: true,
        reason: policyResult.reason,
        evaluation_id: policyResult.evaluation_id,
      },
      simulate,
      preflight: {
        executed: true,
        pass: true,
        failed_prerequisites: [],
        failed_invariants: [],
      },
    };
  }

  return {
    pass: true,
    reason: null,
    policy: {
      allowed: true,
      reason: policyResult.reason,
      evaluation_id: policyResult.evaluation_id,
    },
    simulate,
    preflight: {
      executed: false,
      pass: true,
      failed_prerequisites: [],
      failed_invariants: [],
    },
  };
}

async function runAutopilotExecution(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    intake: AutopilotGoalIntakeResult;
    command_plan: AutopilotCommandPlan;
    execute_allowed: boolean;
    selected_strategy: string;
  }
): Promise<AutopilotExecutionResult> {
  const baseResult: AutopilotExecutionResult = {
    mode: "none",
    commands: [...input.command_plan.commands],
    blocked_commands: [...input.command_plan.blocked_commands],
    task_id: null,
    direct_success: false,
    tmux: null,
    command_results: [],
    reason: null,
  };
  if (!input.execute_allowed) {
    return {
      ...baseResult,
      reason: "execute disallowed by gate",
    };
  }

  const canDirectExecute =
    input.config.execute_enabled &&
    input.command_plan.allowed_commands.length > 0 &&
    input.command_plan.blocked_commands.length === 0;
  if (!canDirectExecute) {
    const fallbackTaskId = `trichat-autopilot-${autopilotHash(`${input.session_key}:fallback-task`).slice(0, 20)}`;
    const created = await taskCreate(storage, {
      mutation: buildAutopilotMutation(input.session_key, "execute.task_create", fallbackTaskId),
      task_id: fallbackTaskId,
      objective: compactConsensusText(
        `Autopilot follow-up: ${input.intake.objective}. Strategy: ${input.selected_strategy}`,
        800
      ),
      project_dir: input.intake.project_dir,
      payload: {
        source: "trichat.autopilot",
        session_key: input.session_key,
        commands: input.command_plan.commands,
        blocked_commands: input.command_plan.blocked_commands,
        blocked_by: input.command_plan.blocked_by,
        classification: input.command_plan.classification,
        execute_backend: input.config.execute_backend,
      },
      priority: 80,
      tags: ["trichat", "autopilot", "fallback"],
      source: "trichat.autopilot",
      source_agent: AUTOPILOT_WORKER_ID,
    });
    return {
      ...baseResult,
      mode: "task_fallback",
      task_id: created.task.task_id,
      reason: null,
    };
  }

  const preferredBackend = resolveAutopilotExecutionBackendPreference(
    input.config,
    input.command_plan.allowed_commands,
    input.command_plan.classification
  );
  if (preferredBackend === "tmux") {
    const tmuxAttempt = await runAutopilotExecutionViaTmux(storage, input);
    if (!tmuxAttempt.reason) {
      return tmuxAttempt;
    }
    const strictTmux = input.config.execute_backend === "tmux";
    const hasDispatchedWork = (tmuxAttempt.tmux?.dispatched_count ?? 0) > 0;
    if (strictTmux || hasDispatchedWork) {
      return tmuxAttempt;
    }
    // In auto mode, fall back to direct execution only if tmux dispatched nothing.
  }

  const executionLockKey =
    input.config.lock_key?.trim() ||
    `trichat.autopilot.exec.${input.intake.source_task?.task_id ?? input.intake.thread_id}`;
  const executionOwnerId = `${AUTOPILOT_WORKER_ID}:${AUTOPILOT_OWNER_NONCE}:exec:${++autopilotInvocationCounter}`;
  const lock = await acquireLock(storage, {
    mutation: buildAutopilotMutation(
      `${input.session_key}:execute-lock:${executionOwnerId}`,
      "execute.lock.acquire",
      executionLockKey
    ),
    lock_key: executionLockKey,
    owner_id: executionOwnerId,
    lease_seconds: input.config.lock_lease_seconds,
    metadata: {
      source: "trichat.autopilot",
      session_key: input.session_key,
      project_dir: input.intake.project_dir,
    },
  });
  if (!lock.acquired) {
    return {
      ...baseResult,
      mode: "direct_command",
      reason: `execution lock unavailable (${lock.reason ?? "held"})`,
    };
  }

  try {
    const commandResults: AutopilotExecutionResult["command_results"] = [];
    for (let index = 0; index < input.command_plan.allowed_commands.length; index += 1) {
      const command = input.command_plan.allowed_commands[index] ?? "";
      const result = await runAutopilotIdempotent(storage, {
        tool_name: "trichat.autopilot.exec_command",
        session_key: input.session_key,
        label: `execute.command.${index + 1}`,
        fingerprint: `${command}:${input.intake.project_dir}`,
        payload: {
          command,
          cwd: input.intake.project_dir,
        },
        execute: () =>
          runAutopilotShellCommand({
            command,
            cwd: input.intake.project_dir,
            timeout_seconds: clampInt(
              input.config.bridge_timeout_seconds || AUTOPILOT_COMMAND_TIMEOUT_SECONDS,
              5,
              900
            ),
            output_cap_bytes: AUTOPILOT_OUTPUT_BYTE_CAP,
          }),
      });
      commandResults.push(result);
    }
    const directSuccess = commandResults.length > 0 && commandResults.every((entry) => entry.ok);
    return {
      mode: "direct_command",
      commands: [...input.command_plan.allowed_commands],
      blocked_commands: [],
      task_id: null,
      direct_success: directSuccess,
      tmux: null,
      command_results: commandResults,
      reason: directSuccess ? null : "one or more commands failed",
    };
  } finally {
    try {
      await releaseLock(storage, {
        mutation: buildAutopilotMutation(
          `${input.session_key}:execute-lock:${executionOwnerId}`,
          "execute.lock.release",
          executionLockKey
        ),
        lock_key: executionLockKey,
        owner_id: executionOwnerId,
      });
    } catch {
      // ignore release races so tick can finalize incidentally.
    }
  }
}

async function runAutopilotExecutionViaTmux(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    intake: AutopilotGoalIntakeResult;
    command_plan: AutopilotCommandPlan;
    selected_strategy: string;
  }
): Promise<AutopilotExecutionResult> {
  const taskQueue = buildAutopilotTmuxTaskQueue({
    commands: input.command_plan.allowed_commands,
    thread_id: input.intake.thread_id,
    turn_id: input.intake.turn_id,
    strategy: input.selected_strategy,
  });
  const configuredWorkers = clampInt(input.config.tmux_worker_count, 1, 12);
  const workerCount = input.config.tmux_auto_scale_workers
    ? recommendAutopilotTmuxWorkerCount(taskQueue, configuredWorkers)
    : configuredWorkers;
  const sessionName = input.config.tmux_session_name || DEFAULT_AUTOPILOT_CONFIG.tmux_session_name;

  const baseResult: AutopilotExecutionResult = {
    mode: "tmux_dispatch",
    commands: [...input.command_plan.allowed_commands],
    blocked_commands: [],
    task_id: null,
    direct_success: false,
    tmux: {
      session_name: sessionName,
      worker_count: workerCount,
      dispatched_count: 0,
      assigned_count: 0,
      queued_count: 0,
      sync: null,
      failures: [],
    },
    command_results: [],
    reason: null,
  };

  try {
    const started = await runAutopilotIdempotent(storage, {
      tool_name: "trichat.tmux_controller.start",
      session_key: input.session_key,
      label: "execute.tmux_controller.start",
      fingerprint: `${sessionName}:${input.intake.project_dir}:${workerCount}`,
      payload: {
        action: "start",
        session_name: sessionName,
        workspace: input.intake.project_dir,
        worker_count: workerCount,
      },
      execute: async () =>
        asRecord(
          await Promise.resolve(
            trichatTmuxController(storage, {
              mutation: buildAutopilotMutation(input.session_key, "execute.tmux.inner.start", sessionName),
              action: "start",
              session_name: sessionName,
              workspace: input.intake.project_dir,
              worker_count: workerCount,
              max_queue_per_worker: input.config.tmux_max_queue_per_worker,
            })
          )
        ),
    });
    const startedRecord = asRecord(started);
    if (startedRecord.ok === false) {
      return {
        ...baseResult,
        reason: compactConsensusText(
          `tmux controller start failed: ${String(startedRecord.error ?? "unknown error")}`,
          320
        ),
      };
    }

    const maintainedRaw = await runAutopilotIdempotent(storage, {
      tool_name: "trichat.tmux_controller.maintain",
      session_key: input.session_key,
      label: "execute.tmux_controller.maintain",
      fingerprint: `${sessionName}:${input.intake.turn_id}:maintain`,
      payload: {
        action: "maintain",
        session_name: sessionName,
        workspace: input.intake.project_dir,
      },
      execute: async () =>
        asRecord(
          await Promise.resolve(
            trichatTmuxController(storage, {
              mutation: buildAutopilotMutation(input.session_key, "execute.tmux.inner.maintain", sessionName),
              action: "maintain",
              session_name: sessionName,
              workspace: input.intake.project_dir,
              worker_count: workerCount,
              min_worker_count: 1,
              max_worker_count: configuredWorkers,
              max_queue_per_worker: input.config.tmux_max_queue_per_worker,
              auto_scale_workers: input.config.tmux_auto_scale_workers,
              target_queue_per_worker: Math.max(1, Math.min(input.config.tmux_max_queue_per_worker, 4)),
              nudge_blocked_lanes: true,
            })
          )
        ),
    });
    const maintained = asRecord(maintainedRaw);
    if (maintained.ok === false && maintained.status === undefined) {
      return {
        ...baseResult,
        reason: compactConsensusText(
          `tmux controller maintain failed: ${String(maintained.error ?? "unknown error")}`,
          320
        ),
      };
    }

    const dispatchedRaw = await runAutopilotIdempotent(storage, {
      tool_name: "trichat.tmux_controller.dispatch",
      session_key: input.session_key,
      label: "execute.tmux_controller.dispatch",
      fingerprint: autopilotHash(
        `${sessionName}|${input.intake.turn_id}|${taskQueue.map((entry) => `${entry.title}:${entry.command}`).join("|")}`
      ),
      payload: {
        action: "dispatch",
        session_name: sessionName,
        command_count: taskQueue.length,
      },
      execute: async () =>
        asRecord(
          await Promise.resolve(
            trichatTmuxController(storage, {
              mutation: buildAutopilotMutation(
                input.session_key,
                "execute.tmux.inner.dispatch",
                `${sessionName}:${taskQueue.length}`
              ),
              action: "dispatch",
              session_name: sessionName,
              workspace: input.intake.project_dir,
              worker_count: workerCount,
              max_queue_per_worker: input.config.tmux_max_queue_per_worker,
              tasks: taskQueue,
            })
          )
        ),
    });
    const dispatched = asRecord(dispatchedRaw);
    const failures = parseTmuxDispatchFailures(dispatched.failures);
    const dispatchOk = dispatched.ok !== false && failures.length === 0;
    const dispatchedCount = toNonNegativeInt(dispatched.dispatched_count, 0);
    const assignedCount = toNonNegativeInt(dispatched.assigned_count, dispatchedCount);
    const queuedCount = toNonNegativeInt(dispatched.queued_count, 0);
    let syncSummary: {
      running_marked: number;
      completed_marked: number;
      failed_marked: number;
    } | null = null;

    if (input.config.tmux_sync_after_dispatch) {
      const syncedRaw = await runAutopilotIdempotent(storage, {
        tool_name: "trichat.tmux_controller.sync",
        session_key: input.session_key,
        label: "execute.tmux_controller.sync",
        fingerprint: `${sessionName}:${input.intake.turn_id}:sync`,
        payload: {
          action: "sync",
          session_name: sessionName,
        },
        execute: async () =>
          asRecord(
            await Promise.resolve(
              trichatTmuxController(storage, {
                mutation: buildAutopilotMutation(input.session_key, "execute.tmux.inner.sync", sessionName),
                action: "sync",
                session_name: sessionName,
                workspace: input.intake.project_dir,
                worker_count: workerCount,
                max_queue_per_worker: input.config.tmux_max_queue_per_worker,
              })
            )
          ),
      });
      const synced = asRecord(syncedRaw);
      syncSummary = normalizeTmuxSyncSummary((synced as Record<string, unknown>).sync);
    }

    let reason: string | null = null;
    if (!dispatchOk) {
      reason = compactConsensusText(
        `tmux dispatch failed: ${failures[0]?.error ?? String(dispatched.error ?? "unknown error")}`,
        400
      );
    } else if (dispatchedCount <= 0) {
      reason = "tmux dispatch produced zero queued commands";
    }

    return {
      mode: "tmux_dispatch",
      commands: [...input.command_plan.allowed_commands],
      blocked_commands: [],
      task_id: null,
      direct_success: !reason,
      tmux: {
        session_name: sessionName,
        worker_count: workerCount,
        dispatched_count: dispatchedCount,
        assigned_count: assignedCount,
        queued_count: queuedCount,
        sync: syncSummary,
        failures,
      },
      command_results: [],
      reason,
    };
  } catch (error) {
    return {
      ...baseResult,
      reason: compactConsensusText(
        `tmux execution failed: ${error instanceof Error ? error.message : String(error)}`,
        400
      ),
    };
  }
}

async function runAutopilotMentorship(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    run_id: string;
    intake: AutopilotGoalIntakeResult;
    council: AutopilotCouncilResult;
    execution: AutopilotExecutionResult;
    verify_status: TriChatAutopilotTickResult["verify_status"];
    verify_summary: string;
  }
): Promise<AutopilotMentorshipResult> {
  const transcriptLines = [
    `objective (${input.intake.objective_source}): ${input.intake.objective}`,
    `decision: ${input.council.decision_summary || "n/a"}`,
    `selected_agent: ${input.council.selected_agent ?? "n/a"}`,
    `selected_strategy: ${input.council.selected_strategy || "n/a"}`,
    `execution: mode=${input.execution.mode} direct_success=${input.execution.direct_success} commands=${
      input.execution.commands.length
    } blocked=${input.execution.blocked_commands.length} fallback_task=${input.execution.task_id ?? "none"}`,
    `verify: status=${input.verify_status} summary=${input.verify_summary}`,
  ];
  let transcriptEntries = 0;
  for (let index = 0; index < transcriptLines.length; index += 1) {
    const line = transcriptLines[index] ?? "";
    await runAutopilotIdempotent(storage, {
      tool_name: "transcript.append",
      session_key: input.session_key,
      label: `mentorship.transcript_append.${index + 1}`,
      fingerprint: line,
      payload: {
        run_id: input.run_id,
        line,
      },
      execute: () =>
        appendTranscript(storage, {
          mutation: AUTOPILOT_INLINE_MUTATION,
          session_id: input.run_id,
          source_client: "trichat.autopilot",
          source_agent: AUTOPILOT_WORKER_ID,
          kind: "system",
          text: line,
        }),
    });
    transcriptEntries += 1;
  }

  const summarize = await runAutopilotIdempotent(storage, {
    tool_name: "transcript.summarize",
    session_key: input.session_key,
    label: "mentorship.transcript_summarize",
    fingerprint: input.run_id,
    payload: {
      session_id: input.run_id,
    },
    execute: () =>
      summarizeTranscript(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        session_id: input.run_id,
        provider: "auto",
        max_points: 8,
      }),
  });
  const memoryContent = [
    "Autopilot mentorship digest:",
    `Objective source: ${input.intake.objective_source}`,
    `Selected agent: ${input.council.selected_agent ?? "n/a"}`,
    `Decision summary: ${input.council.decision_summary || "n/a"}`,
    `Execution mode: ${input.execution.mode}`,
    `Execution outcome: ${input.execution.direct_success ? "success" : "deferred-or-failed"}`,
    `Verify status: ${input.verify_status}`,
    `Guardrail: maintain command allowlist + hard denylist; require policy gate before execute.`,
  ].join("\n");
  const memory = await runAutopilotIdempotent(storage, {
    tool_name: "memory.append",
    session_key: input.session_key,
    label: "mentorship.memory_append",
    fingerprint: `${input.council.selected_agent ?? "none"}:${input.verify_status}:${input.execution.mode}`,
    payload: {
      objective: input.intake.objective,
      verify_status: input.verify_status,
      execution_mode: input.execution.mode,
    },
    execute: () =>
      appendMemory(storage, {
        mutation: AUTOPILOT_INLINE_MUTATION,
        content: memoryContent,
        keywords: [
          "trichat",
          "autopilot",
          "mentorship",
          "council",
          "policy",
          "allowlist",
          "incident",
          input.verify_status,
        ],
      }),
  });

  let postflight = {
    executed: false,
    pass: true,
    summary: "postflight skipped",
  };
  if (input.config.away_mode === "safe") {
    const verify = postflightVerify({
      action: "trichat.autopilot.execute",
      target: input.intake.project_dir,
      assertions: [
        {
          name: "verify_not_error",
          operator: "ne",
          expected: "error",
          actual: input.verify_status,
        },
        {
          name: "mentorship_memory_exists",
          operator: "exists",
          actual: memory.id,
        },
        {
          name: "summarize_note_exists",
          operator: "exists",
          actual: summarize.note_id ?? null,
        },
      ],
    });
    postflight = {
      executed: true,
      pass: verify.pass,
      summary: verify.pass ? "safe mode postflight passed" : "safe mode postflight failed",
    };
  }

  return {
    session_id: input.run_id,
    transcript_entries: transcriptEntries,
    summarize_note_id: asNullableTrimmed((summarize as Record<string, unknown>).note_id),
    memory_id: memory.id,
    postflight,
  };
}

async function runAutopilotGovernance(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    intake: AutopilotGoalIntakeResult;
    council: AutopilotCouncilResult;
    execution: AutopilotExecutionResult;
    verify_status: TriChatAutopilotTickResult["verify_status"];
    verify_summary: string;
    skip: boolean;
  }
): Promise<TriChatAutopilotTickResult["governance"]> {
  if (input.skip) {
    return {
      adr_id: null,
      adr_path: null,
      skipped_reason: "skipped due to failed tick",
    };
  }
  if (input.config.adr_policy === "manual") {
    return {
      adr_id: null,
      adr_path: null,
      skipped_reason: "manual policy",
    };
  }
  if (
    input.config.adr_policy === "high_impact" &&
    input.execution.mode !== "direct_command" &&
    input.execution.mode !== "tmux_dispatch"
  ) {
    return {
      adr_id: null,
      adr_path: null,
      skipped_reason: "high-impact policy and no direct or tmux execution",
    };
  }

  const lockKey = `trichat.autopilot.adr.${input.intake.source_task?.task_id ?? input.intake.thread_id}`;
  const ownerId = `${AUTOPILOT_WORKER_ID}:${AUTOPILOT_OWNER_NONCE}:adr:${++autopilotInvocationCounter}`;
  const lock = await acquireLock(storage, {
    mutation: buildAutopilotMutation(
      `${input.session_key}:adr-lock:${ownerId}`,
      "governance.adr.lock.acquire",
      lockKey
    ),
    lock_key: lockKey,
    owner_id: ownerId,
    lease_seconds: input.config.lock_lease_seconds,
    metadata: {
      source: "trichat.autopilot",
      session_key: input.session_key,
      thread_id: input.intake.thread_id,
    },
  });
  if (!lock.acquired) {
    return {
      adr_id: null,
      adr_path: null,
      skipped_reason: `adr lock unavailable (${lock.reason ?? "held"})`,
    };
  }
  try {
    const content = [
      `Objective source: ${input.intake.objective_source}`,
      `Objective: ${input.intake.objective}`,
      `Thread: ${input.intake.thread_id}`,
      `Turn: ${input.intake.turn_id}`,
      `Away mode: ${input.config.away_mode}`,
      `Selected agent: ${input.council.selected_agent ?? "n/a"}`,
      `Selected strategy: ${input.council.selected_strategy || "n/a"}`,
      `Execution mode: ${input.execution.mode}`,
      `Execution commands: ${input.execution.commands.join(" || ") || "none"}`,
      `Verification: ${input.verify_status} (${input.verify_summary})`,
      `Rollback: revert workspace changes and replay task queue from ${input.intake.project_dir}`,
    ].join("\n");
    const adr = await runAutopilotIdempotent(storage, {
      tool_name: "adr.create",
      session_key: input.session_key,
      label: "governance.adr_create",
      fingerprint: `${input.intake.objective}:${input.council.selected_strategy}:${input.verify_status}`,
      payload: {
        thread_id: input.intake.thread_id,
      },
      execute: () =>
        createAdr(storage, {
          mutation: AUTOPILOT_INLINE_MUTATION,
          title: `TriChat Autopilot ${input.intake.thread_id} ${new Date().toISOString().slice(0, 10)}`,
          status: "accepted",
          content,
        }),
    });
    return {
      adr_id: adr.id,
      adr_path: adr.path,
      skipped_reason: null,
    };
  } finally {
    try {
      await releaseLock(storage, {
        mutation: buildAutopilotMutation(
          `${input.session_key}:adr-lock:${ownerId}`,
          "governance.adr.lock.release",
          lockKey
        ),
        lock_key: lockKey,
        owner_id: ownerId,
      });
    } catch {
      // do not fail governance result because of lock release race.
    }
  }
}

async function runAutopilotBridgeAsk(
  storage: Storage,
  input: {
    session_key: string;
    config: TriChatAutopilotConfig;
    thread_id: string;
    objective: string;
    round: number;
    agent_id: string;
    lane: string;
    signal?: AbortSignal;
  }
): Promise<{
  ok: boolean;
  content: string | null;
  strategy: string;
  commands: string[];
  confidence: number;
  mentorship_note: string | null;
  error: string | null;
}> {
  const workspace = process.cwd();
  const resolution = resolveAdapterProtocolCommand({
    agent_id: input.agent_id,
    workspace,
    timeout_seconds: input.config.bridge_timeout_seconds,
    command_overrides: {},
    python_bin: resolveAdapterProtocolPython(),
    thread_id: input.thread_id,
    ask_prompt: input.objective,
    run_ask_check: true,
    ask_dry_run: input.config.bridge_dry_run,
  });
  if (!resolution.command) {
    return {
      ok: false,
      content: null,
      strategy: "",
      commands: [],
      confidence: 0.2,
      mentorship_note: null,
      error: "bridge command not resolved",
    };
  }

  const requestId = buildAutopilotBridgeRequestId(input.session_key, input.round, input.agent_id);
  const prompt = buildAutopilotCouncilPrompt({
    objective: input.objective,
    lane: input.lane,
    round: input.round,
  });
  const execution = await runAutopilotIdempotent(storage, {
    tool_name: "trichat.autopilot.bridge_ask",
    session_key: input.session_key,
    label: `council.bridge_ask.round${input.round}.${input.agent_id}`,
    fingerprint: `${input.agent_id}:${prompt}`,
    payload: {
      agent_id: input.agent_id,
      round: input.round,
      thread_id: input.thread_id,
    },
    execute: () =>
      runAdapterProtocolCommandAsync({
        command: resolution.command!,
        timeout_seconds: input.config.bridge_timeout_seconds,
        workspace,
        env_overrides: input.config.bridge_dry_run ? { TRICHAT_BRIDGE_DRY_RUN: "1" } : undefined,
        signal: input.signal,
        payload: {
          op: "ask",
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          request_id: requestId,
          agent_id: input.agent_id,
          thread_id: input.thread_id,
          prompt,
          history: [],
          peer_context: "",
          bootstrap_text: "",
          workspace,
          timestamp: new Date().toISOString(),
          turn_phase: "propose",
          role_hint: input.lane,
          role_objective: `lane=${input.lane}`,
          response_mode: "json",
          collaboration_contract: "Trichat autopilot council round",
        },
      }),
  });

  const validationError = validateAdapterProtocolEnvelope({
    envelope: execution.envelope,
    expected_kind: BRIDGE_RESPONSE_KIND,
    expected_request_id: requestId,
    expected_agent_id: input.agent_id,
    require_content: true,
  });
  if (execution.error || validationError) {
    return {
      ok: false,
      content: null,
      strategy: "",
      commands: [],
      confidence: 0.2,
      mentorship_note: null,
      error: execution.error ?? validationError,
    };
  }
  const content = safeAdapterEnvelopeField(execution.envelope?.content) ?? "";
  const parsed = parseAutopilotProposal(content);
  return {
    ok: true,
    content,
    strategy: parsed.strategy,
    commands: parsed.commands,
    confidence: parsed.confidence,
    mentorship_note: parsed.mentorship_note,
    error: null,
  };
}

function buildAutopilotCommandPlan(input: {
  selected_strategy: string;
  selected_agent: string | null;
  proposals: AutopilotProposal[];
  allowlist: string[];
}): AutopilotCommandPlan {
  const selectedProposal =
    input.selected_agent ? input.proposals.find((proposal) => proposal.agent_id === input.selected_agent) ?? null : null;
  const structuredCommands = selectedProposal?.commands ?? [];
  const fallbackCommands = structuredCommands.length ? [] : extractCommandsFromFreeText(input.selected_strategy);
  const commands = dedupeNonEmptyCommands([...structuredCommands, ...fallbackCommands]);
  const normalizedAllowlist = dedupeNonEmptyCommands(
    input.allowlist.length > 0 ? input.allowlist : DEFAULT_AUTOPILOT_COMMAND_ALLOWLIST
  ).map((entry) => entry.toLowerCase());
  const allowed: string[] = [];
  const blocked: string[] = [];
  const blockedBy: Record<string, string> = {};
  for (const command of commands) {
    const protectedDbMatch = commandReferencesProtectedDbArtifact(command, {
      repo_root: process.cwd(),
    });
    if (protectedDbMatch.matched) {
      blocked.push(command);
      const alias = protectedDbMatch.matched_alias || protectedDbMatch.artifact_path || "protected-db-artifact";
      blockedBy[command] = `protected-db-artifact:${alias}`;
      continue;
    }
    const denied = AUTOPILOT_HARD_DENY_PATTERNS.find((pattern) => pattern.test(command));
    if (denied) {
      blocked.push(command);
      blockedBy[command] = `hard-deny:${denied.source}`;
      continue;
    }
    const normalized = command.toLowerCase();
    const allowMatched = normalizedAllowlist.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
    if (!allowMatched) {
      blocked.push(command);
      blockedBy[command] = "allowlist";
      continue;
    }
    allowed.push(command);
  }

  const destructive = commands.some((command) =>
    AUTOPILOT_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
  );
  const write =
    destructive ||
    commands.some((command) => AUTOPILOT_WRITE_PATTERNS.some((pattern) => pattern.test(command)));
  return {
    source: structuredCommands.length > 0 ? "structured" : fallbackCommands.length > 0 ? "fallback" : "none",
    commands,
    allowed_commands: allowed,
    blocked_commands: blocked,
    blocked_by: blockedBy,
    classification: destructive ? "destructive" : write ? "write" : "read",
    destructive,
  };
}

function resolveAutopilotVerifyStatus(
  failureReason: string | null,
  execution: AutopilotExecutionResult
): TriChatAutopilotTickResult["verify_status"] {
  if (failureReason) {
    return "failed";
  }
  if (execution.mode === "direct_command") {
    return execution.direct_success ? "passed" : "failed";
  }
  if (execution.mode === "tmux_dispatch") {
    return execution.reason ? "failed" : "skipped";
  }
  if (execution.mode === "task_fallback") {
    return "skipped";
  }
  return "skipped";
}

async function runAutopilotOverlapSkip(
  storage: Storage,
  input: {
    config: TriChatAutopilotConfig;
    session_key: string;
    reason: string;
    owner_id: string;
    trigger: "interval" | "start" | "run_once";
  }
): Promise<TriChatAutopilotTickResult> {
  const skipRunId = `trichat-autopilot-skip-${autopilotHash(`${input.session_key}:${input.owner_id}`).slice(0, 20)}`;
  await runBegin(storage, {
    mutation: buildAutopilotMutation(`${input.session_key}:${input.owner_id}`, "single_flight.run.begin", skipRunId),
    run_id: skipRunId,
    status: "in_progress",
    summary: "autopilot tick skipped due to single-flight lease",
    details: {
      trigger: input.trigger,
      session_key: input.session_key,
      reason: input.reason,
    },
    source_client: "trichat.autopilot",
    source_agent: AUTOPILOT_WORKER_ID,
  });
  await runStep(storage, {
    mutation: buildAutopilotMutation(`${input.session_key}:${input.owner_id}`, "single_flight.run.step", input.reason),
    run_id: skipRunId,
    step_index: 1,
    status: "skipped",
    summary: "single-flight overlap detected; tick skipped",
    details: {
      reason: input.reason,
      lock_key: AUTOPILOT_TICK_LOCK_KEY,
    },
    source_client: "trichat.autopilot",
    source_agent: AUTOPILOT_WORKER_ID,
  });
  await runEnd(storage, {
    mutation: buildAutopilotMutation(`${input.session_key}:${input.owner_id}`, "single_flight.run.end", "aborted"),
    run_id: skipRunId,
    status: "aborted",
    summary: "autopilot tick aborted due to overlapping single-flight lease",
    details: {
      reason: input.reason,
    },
    source_client: "trichat.autopilot",
    source_agent: AUTOPILOT_WORKER_ID,
  });
  const result: TriChatAutopilotTickResult = {
    ok: true,
    completed_at: new Date().toISOString(),
    run_id: skipRunId,
    session_key: input.session_key,
    away_mode: input.config.away_mode,
    thread_id: input.config.thread_id,
    turn_id: null,
    user_message_id: null,
    source_task_id: null,
    council_confidence: 0,
    success_agents: 0,
    emergency_brake_triggered: false,
    incident_id: null,
    verify_status: "skipped",
    verify_summary: "tick skipped due to overlap",
      execution: {
        mode: "none",
        commands: [],
        blocked_commands: [],
        task_id: null,
        direct_success: false,
        tmux: null,
        command_results: [],
      },
    mentorship: {
      session_id: skipRunId,
      transcript_entries: 0,
      summarize_note_id: null,
      memory_id: null,
    },
    governance: {
      adr_id: null,
      adr_path: null,
      skipped_reason: "single-flight overlap",
    },
    step_status: [
      {
        name: "single_flight",
        status: "skipped",
        summary: `tick skipped: ${input.reason}`,
      },
    ],
    reason: null,
  };
  finalizeAutopilotRuntimeFromTick(result);
  return result;
}

async function appendAutopilotRunStep(
  storage: Storage,
  input: {
    session_key: string;
    run_id: string;
    step_name: AutopilotStepName;
    status: "completed" | "failed" | "skipped";
    summary: string;
    details?: Record<string, unknown>;
    step_status: TriChatAutopilotTickResult["step_status"];
  }
) {
  const stepIndex = AUTOPILOT_STEP_ORDER.indexOf(input.step_name) + 1;
  input.step_status.push({
    name: input.step_name,
    status: input.status,
    summary: compactConsensusText(input.summary, 400),
  });
  await runStep(storage, {
    mutation: buildAutopilotMutation(input.session_key, `run.step.${input.step_name}`, input.summary),
    run_id: input.run_id,
    step_index: stepIndex <= 0 ? 1 : stepIndex,
    status: input.status,
    summary: compactConsensusText(input.summary, 400),
    details: input.details,
    source_client: "trichat.autopilot",
    source_agent: AUTOPILOT_WORKER_ID,
  });
}

function finalizeAutopilotRuntimeFromTick(tick: TriChatAutopilotTickResult) {
  autopilotRuntime.tick_count += 1;
  autopilotRuntime.last_tick_at = tick.completed_at;
  autopilotRuntime.last_run_id = tick.run_id;
  autopilotRuntime.last_session_key = tick.session_key;
  autopilotRuntime.last_tick = tick;
  if (tick.ok) {
    autopilotRuntime.success_count += 1;
    autopilotRuntime.consecutive_error_count = 0;
    autopilotRuntime.last_error = null;
  } else {
    autopilotRuntime.failure_count += 1;
    autopilotRuntime.consecutive_error_count += 1;
    autopilotRuntime.last_error = tick.reason;
  }
  if (tick.incident_id) {
    autopilotRuntime.incident_count += 1;
  }
}

function startAutopilotDaemon(storage: Storage) {
  stopAutopilotDaemon();
  autopilotRuntime.running = true;
  autopilotRuntime.in_tick = false;
  autopilotRuntime.started_at = new Date().toISOString();
  autopilotRuntime.last_error = null;
  autopilotRuntime.timer = setInterval(() => {
    runAutopilotTick(storage, autopilotRuntime.config, {
      trigger: "interval",
    }).catch((error) => {
      autopilotRuntime.last_error = error instanceof Error ? error.message : String(error);
      autopilotRuntime.failure_count += 1;
      autopilotRuntime.consecutive_error_count += 1;
    });
  }, autopilotRuntime.config.interval_seconds * 1000);
  autopilotRuntime.timer.unref?.();
}

function stopAutopilotDaemon() {
  if (autopilotRuntime.timer) {
    clearInterval(autopilotRuntime.timer);
  }
  autopilotRuntime.timer = null;
  autopilotRuntime.running = false;
  autopilotRuntime.in_tick = false;
}

async function pauseAutopilotDaemon(storage: Storage, config: TriChatAutopilotConfig, reason: string) {
  stopAutopilotDaemon();
  autopilotRuntime.pause_reason = reason;
  storage.setTriChatAutopilotState({
    enabled: false,
    away_mode: config.away_mode,
    interval_seconds: config.interval_seconds,
    thread_id: config.thread_id,
    thread_title: config.thread_title,
    thread_status: config.thread_status,
    objective: config.objective,
    max_rounds: config.max_rounds,
    min_success_agents: config.min_success_agents,
    bridge_timeout_seconds: config.bridge_timeout_seconds,
    bridge_dry_run: config.bridge_dry_run,
    execute_enabled: config.execute_enabled,
    command_allowlist: [...config.command_allowlist],
    execute_backend: config.execute_backend,
    tmux_session_name: config.tmux_session_name,
    tmux_worker_count: config.tmux_worker_count,
    tmux_max_queue_per_worker: config.tmux_max_queue_per_worker,
    tmux_auto_scale_workers: config.tmux_auto_scale_workers,
    tmux_sync_after_dispatch: config.tmux_sync_after_dispatch,
    confidence_threshold: config.confidence_threshold,
    max_consecutive_errors: config.max_consecutive_errors,
    lock_key: config.lock_key,
    lock_lease_seconds: config.lock_lease_seconds,
    adr_policy: config.adr_policy,
    pause_reason: reason,
  });
}

function getAutopilotStatus() {
  return {
    running: autopilotRuntime.running,
    in_tick: autopilotRuntime.in_tick,
    config: { ...autopilotRuntime.config },
    pause_reason: autopilotRuntime.pause_reason,
    started_at: autopilotRuntime.started_at,
    last_tick_at: autopilotRuntime.last_tick_at,
    last_error: autopilotRuntime.last_error,
    last_run_id: autopilotRuntime.last_run_id,
    last_session_key: autopilotRuntime.last_session_key,
    stats: {
      tick_count: autopilotRuntime.tick_count,
      success_count: autopilotRuntime.success_count,
      failure_count: autopilotRuntime.failure_count,
      incident_count: autopilotRuntime.incident_count,
      consecutive_error_count: autopilotRuntime.consecutive_error_count,
    },
    last_tick: autopilotRuntime.last_tick,
  };
}

function resolveAutopilotConfig(
  input:
    | TriChatAutopilotConfig
    | z.infer<typeof trichatAutopilotSchema>
    | Partial<z.infer<typeof trichatAutopilotSchema>>
    | ReturnType<Storage["getTriChatAutopilotState"]>,
  fallback: TriChatAutopilotConfig
): TriChatAutopilotConfig {
  const awayModeRaw = String((input as { away_mode?: string } | null)?.away_mode ?? fallback.away_mode)
    .trim()
    .toLowerCase();
  const awayMode = awayModeRaw === "safe" || awayModeRaw === "aggressive" ? awayModeRaw : "normal";
  const threadStatusRaw = String((input as { thread_status?: string } | null)?.thread_status ?? fallback.thread_status)
    .trim()
    .toLowerCase();
  const threadStatus = threadStatusRaw === "active" ? "active" : "archived";
  const adrPolicyRaw = String((input as { adr_policy?: string } | null)?.adr_policy ?? fallback.adr_policy)
    .trim()
    .toLowerCase();
  const adrPolicy =
    adrPolicyRaw === "manual" || adrPolicyRaw === "high_impact" ? adrPolicyRaw : "every_success";
  const allowlistRaw = Array.isArray((input as { command_allowlist?: string[] } | null)?.command_allowlist)
    ? (input as { command_allowlist?: string[] }).command_allowlist ?? []
    : fallback.command_allowlist;
  const allowlist = dedupeNonEmptyCommands(allowlistRaw);
  const executeBackendRaw = String(
    (input as { execute_backend?: string } | null)?.execute_backend ?? fallback.execute_backend
  )
    .trim()
    .toLowerCase();
  const executeBackend = executeBackendRaw === "direct" || executeBackendRaw === "tmux" ? executeBackendRaw : "auto";
  return {
    away_mode: awayMode,
    interval_seconds: clampInt(
      Number((input as { interval_seconds?: number } | null)?.interval_seconds ?? fallback.interval_seconds),
      10,
      86400
    ),
    thread_id:
      String((input as { thread_id?: string } | null)?.thread_id ?? fallback.thread_id).trim() ||
      DEFAULT_AUTOPILOT_CONFIG.thread_id,
    thread_title:
      String((input as { thread_title?: string } | null)?.thread_title ?? fallback.thread_title).trim() ||
      DEFAULT_AUTOPILOT_CONFIG.thread_title,
    thread_status: threadStatus,
    objective:
      String((input as { objective?: string } | null)?.objective ?? fallback.objective).trim() ||
      DEFAULT_AUTOPILOT_CONFIG.objective,
    max_rounds: clampInt(
      Number((input as { max_rounds?: number } | null)?.max_rounds ?? fallback.max_rounds),
      1,
      6
    ),
    min_success_agents: clampInt(
      Number(
        (input as { min_success_agents?: number } | null)?.min_success_agents ?? fallback.min_success_agents
      ),
      1,
      3
    ),
    bridge_timeout_seconds: clampInt(
      Number(
        (input as { bridge_timeout_seconds?: number } | null)?.bridge_timeout_seconds ?? fallback.bridge_timeout_seconds
      ),
      5,
      7200
    ),
    bridge_dry_run: Boolean((input as { bridge_dry_run?: boolean } | null)?.bridge_dry_run ?? fallback.bridge_dry_run),
    execute_enabled: Boolean((input as { execute_enabled?: boolean } | null)?.execute_enabled ?? fallback.execute_enabled),
    command_allowlist: allowlist.length > 0 ? allowlist : [...DEFAULT_AUTOPILOT_COMMAND_ALLOWLIST],
    execute_backend: executeBackend,
    tmux_session_name:
      String((input as { tmux_session_name?: string } | null)?.tmux_session_name ?? fallback.tmux_session_name).trim() ||
      DEFAULT_AUTOPILOT_CONFIG.tmux_session_name,
    tmux_worker_count: clampInt(
      Number((input as { tmux_worker_count?: number } | null)?.tmux_worker_count ?? fallback.tmux_worker_count),
      1,
      12
    ),
    tmux_max_queue_per_worker: clampInt(
      Number(
        (input as { tmux_max_queue_per_worker?: number } | null)?.tmux_max_queue_per_worker ??
          fallback.tmux_max_queue_per_worker
      ),
      1,
      200
    ),
    tmux_auto_scale_workers: Boolean(
      (input as { tmux_auto_scale_workers?: boolean } | null)?.tmux_auto_scale_workers ??
        fallback.tmux_auto_scale_workers
    ),
    tmux_sync_after_dispatch: Boolean(
      (input as { tmux_sync_after_dispatch?: boolean } | null)?.tmux_sync_after_dispatch ??
        fallback.tmux_sync_after_dispatch
    ),
    confidence_threshold: clamp(
      Number((input as { confidence_threshold?: number } | null)?.confidence_threshold ?? fallback.confidence_threshold),
      0.05,
      1
    ),
    max_consecutive_errors: clampInt(
      Number(
        (input as { max_consecutive_errors?: number } | null)?.max_consecutive_errors ??
          fallback.max_consecutive_errors
      ),
      1,
      20
    ),
    lock_key: asNullableTrimmed((input as { lock_key?: string | null } | null)?.lock_key) ?? fallback.lock_key,
    lock_lease_seconds: clampInt(
      Number(
        (input as { lock_lease_seconds?: number } | null)?.lock_lease_seconds ?? fallback.lock_lease_seconds
      ),
      15,
      3600
    ),
    adr_policy: adrPolicy,
  };
}

async function openAutopilotIncident(
  storage: Storage,
  input: {
    session_key: string;
    run_id: string;
    away_mode: "safe" | "normal" | "aggressive";
    reason: string;
    destructive: boolean;
    policy_denied: boolean;
    thread_id: string;
    task_id: string | null;
  }
): Promise<string> {
  const severity = resolveAutopilotIncidentSeverity({
    away_mode: input.away_mode,
    destructive: input.destructive,
    policy_denied: input.policy_denied,
  });
  const incident = await incidentOpen(storage, {
    mutation: buildAutopilotMutation(input.session_key, "incident.open", `${input.run_id}:${input.reason}`),
    severity,
    title: `trichat.autopilot ${severity} incident`,
    summary: compactConsensusText(input.reason, 500),
    tags: [
      "trichat",
      "autopilot",
      input.away_mode,
      input.policy_denied ? "policy" : "runtime",
      input.destructive ? "destructive" : "non-destructive",
    ],
    source_client: "trichat.autopilot",
    source_agent: AUTOPILOT_WORKER_ID,
  });
  return incident.incident_id;
}

function resolveAutopilotIncidentSeverity(input: {
  away_mode: "safe" | "normal" | "aggressive";
  destructive: boolean;
  policy_denied: boolean;
}): "P0" | "P1" | "P2" | "P3" {
  if (input.destructive || input.policy_denied) {
    return "P0";
  }
  if (input.away_mode === "normal") {
    return "P1";
  }
  if (input.away_mode === "safe" || input.away_mode === "aggressive") {
    return "P2";
  }
  return "P3";
}

function buildAutopilotHeartbeatSessionKey(config: TriChatAutopilotConfig): string {
  const intervalMs = Math.max(10, config.interval_seconds) * 1000;
  const bucket = Math.floor(Date.now() / intervalMs);
  return `heartbeat:${config.thread_id}:bucket:${bucket}`;
}

function buildAutopilotTaskSessionKey(taskId: string, attempt: number): string {
  const normalizedTaskId = taskId.trim() || "unknown-task";
  const normalizedAttempt = Math.max(1, Math.round(attempt));
  return `task:${normalizedTaskId}:attempt:${normalizedAttempt}`;
}

function buildAutopilotRunId(sessionKey: string): string {
  return `trichat-autopilot-${autopilotHash(sessionKey).slice(0, 24)}`;
}

function buildAutopilotMutation(sessionKey: string, label: string, fingerprintSeed: string) {
  const normalizedLabel = label.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
  const keyHash = autopilotHash(`${sessionKey}|${normalizedLabel}`).slice(0, 40);
  const fingerprintHash = autopilotHash(`${sessionKey}|${normalizedLabel}|${fingerprintSeed}`).slice(0, 64);
  return {
    idempotency_key: `trichat-autopilot-${keyHash}`,
    side_effect_fingerprint: `trichat-autopilot-${fingerprintHash}`,
  };
}

async function runAutopilotIdempotent<T>(
  storage: Storage,
  input: {
    tool_name: string;
    session_key: string;
    label: string;
    fingerprint: string;
    payload: unknown;
    execute: () => Promise<T> | T;
  }
): Promise<T & { replayed?: boolean }> {
  return runIdempotentMutation({
    storage,
    tool_name: input.tool_name,
    mutation: buildAutopilotMutation(input.session_key, input.label, input.fingerprint),
    payload: input.payload,
    execute: input.execute,
  });
}

function autopilotHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function asNullableTrimmed(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = asFiniteNumber(value);
  if (parsed === null) {
    return Math.max(0, Math.trunc(fallback));
  }
  return Math.max(0, Math.trunc(parsed));
}

function buildAutopilotBridgeRequestId(sessionKey: string, round: number, agentId: string): string {
  return `trichat-autopilot-ask-${autopilotHash(`${sessionKey}:${round}:${agentId}`).slice(0, 20)}`;
}

function buildAutopilotCouncilPrompt(input: { objective: string; lane: string; round: number }): string {
  return [
    `Council round: ${input.round}`,
    `Lane: ${input.lane}`,
    `Objective: ${input.objective}`,
    "Return strict JSON only with keys:",
    `{"strategy":"...","commands":["..."],"confidence":0.0-1.0,"mentorship_note":"teach local llama what to retain"}`,
    "Prefer concrete commands and safety-aware reasoning.",
    "If no command is safe, return empty commands and explain in strategy.",
  ].join("\n");
}

function parseAutopilotProposal(content: string): {
  strategy: string;
  commands: string[];
  confidence: number;
  mentorship_note: string | null;
} {
  const jsonSlice = extractJSONObject(content);
  if (!jsonSlice) {
    return {
      strategy: compactConsensusText(content, 800),
      commands: extractCommandsFromFreeText(content),
      confidence: inferProposalConfidence(content),
      mentorship_note: null,
    };
  }
  try {
    const parsed = JSON.parse(jsonSlice) as Record<string, unknown>;
    const strategy =
      compactConsensusText(
        String(parsed.strategy ?? parsed.proposal ?? parsed.plan ?? parsed.summary ?? content),
        1200
      ) || compactConsensusText(content, 1200);
    const commands = Array.isArray(parsed.commands)
      ? dedupeNonEmptyCommands(parsed.commands.map((entry) => String(entry ?? "")))
      : extractCommandsFromFreeText(strategy);
    const confidenceRaw = asFiniteNumber(parsed.confidence);
    const confidence = clamp(confidenceRaw ?? inferProposalConfidence(content), 0.05, 0.99);
    const mentorship = asNullableTrimmed(parsed.mentorship_note);
    return {
      strategy,
      commands,
      confidence,
      mentorship_note: mentorship,
    };
  } catch {
    return {
      strategy: compactConsensusText(content, 800),
      commands: extractCommandsFromFreeText(content),
      confidence: inferProposalConfidence(content),
      mentorship_note: null,
    };
  }
}

function extractCommandsFromFreeText(value: string): string[] {
  const commands: string[] = [];
  const fromCodeBlocks = [...String(value ?? "").matchAll(/```(?:bash|sh|zsh|shell)?\s*([\s\S]*?)```/gi)];
  for (const block of fromCodeBlocks) {
    const body = String(block[1] ?? "");
    for (const line of body.split(/\r?\n/)) {
      const normalized = normalizeCommandCandidate(line);
      if (normalized) {
        commands.push(normalized);
      }
    }
  }
  if (commands.length > 0) {
    return dedupeNonEmptyCommands(commands);
  }
  for (const line of String(value ?? "").split(/\r?\n/)) {
    const normalized = normalizeCommandCandidate(line);
    if (normalized) {
      commands.push(normalized);
    }
  }
  return dedupeNonEmptyCommands(commands);
}

function normalizeCommandCandidate(line: string): string | null {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    return null;
  }
  const withoutBullets = trimmed
    .replace(/^\d+\.\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\$\s*/, "")
    .replace(/^`|`$/g, "")
    .trim();
  if (!withoutBullets) {
    return null;
  }
  if (!/[a-zA-Z]/.test(withoutBullets)) {
    return null;
  }
  if (withoutBullets.length > 400) {
    return null;
  }
  const shellLike =
    /^[a-zA-Z0-9_.@/-]+(\s+.+)?$/.test(withoutBullets) ||
    withoutBullets.includes("|") ||
    withoutBullets.includes("&&");
  if (!shellLike) {
    return null;
  }
  return withoutBullets;
}

function dedupeNonEmptyCommands(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
}

function resolveAutopilotExecutionBackendPreference(
  config: TriChatAutopilotConfig,
  commands: string[],
  classification: AutopilotCommandPlan["classification"]
): "direct" | "tmux" {
  if (config.execute_backend === "direct") {
    return "direct";
  }
  if (config.execute_backend === "tmux") {
    return "tmux";
  }
  if (commands.length <= 1) {
    return "direct";
  }
  const complexityAvg =
    commands.length > 0
      ? commands.reduce((total, command) => total + estimateAutopilotCommandComplexity(command), 0) /
        commands.length
      : 0;
  if (classification !== "read") {
    return "tmux";
  }
  return commands.length >= 3 || complexityAvg >= 55 ? "tmux" : "direct";
}

function buildAutopilotTmuxTaskQueue(input: {
  commands: string[];
  thread_id: string;
  turn_id: string;
  strategy: string;
}): TriChatTmuxTaskInput[] {
  return input.commands.map((command, index) => {
    const complexity = estimateAutopilotCommandComplexity(command);
    const basePriority = Math.max(20, 95 - index * 6);
    const title = buildAutopilotCommandTitle(command, index + 1);
    return {
      title,
      command,
      priority: basePriority,
      complexity,
      thread_id: input.thread_id,
      turn_id: input.turn_id,
      metadata: {
        source: "trichat.autopilot",
        strategy: compactConsensusText(input.strategy, 320),
        command_index: index + 1,
      },
    };
  });
}

function buildAutopilotCommandTitle(command: string, index: number): string {
  const compact = compactConsensusText(command.replace(/\s+/g, " ").trim(), 72);
  const primary = compact.split(" ")[0] ?? "command";
  return `Step ${index}: ${primary}`;
}

function estimateAutopilotCommandComplexity(command: string): number {
  const normalized = String(command ?? "").trim().toLowerCase();
  let score = 20;
  score += Math.min(40, Math.floor(normalized.length / 12));
  if (normalized.includes("&&") || normalized.includes("||") || normalized.includes("|")) {
    score += 20;
  }
  if (normalized.includes("npm test") || normalized.includes("pytest") || normalized.includes("go test")) {
    score += 18;
  }
  if (
    normalized.includes("npm run build") ||
    normalized.includes("tsc") ||
    normalized.includes("cargo build") ||
    normalized.includes("docker")
  ) {
    score += 16;
  }
  if (normalized.includes("git") || normalized.includes("migrate") || normalized.includes("deploy")) {
    score += 12;
  }
  if (AUTOPILOT_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    score += 20;
  }
  return clampInt(score, 10, 100);
}

function recommendAutopilotTmuxWorkerCount(tasks: TriChatTmuxTaskInput[], maxWorkers: number): number {
  if (tasks.length === 0) {
    return 1;
  }
  const totalComplexity = tasks.reduce((total, task) => total + toNonNegativeInt(task.complexity, 50), 0);
  const byComplexity = Math.ceil(totalComplexity / 120);
  const byCount = Math.ceil(tasks.length / 2);
  const desired = Math.max(1, Math.max(byComplexity, byCount));
  return clampInt(desired, 1, Math.max(1, maxWorkers));
}

function parseTmuxDispatchFailures(value: unknown): Array<{
  task_id: string;
  worker_id: string;
  error: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed = value
    .map((entry) => asRecord(entry))
    .map((entry) => ({
      task_id: String(entry.task_id ?? "").trim(),
      worker_id: String(entry.worker_id ?? "").trim(),
      error: compactConsensusText(String(entry.error ?? "").trim() || "unknown dispatch error", 320),
    }))
    .filter((entry) => entry.task_id && entry.worker_id && entry.error);
  return parsed;
}

function normalizeTmuxSyncSummary(value: unknown): {
  running_marked: number;
  completed_marked: number;
  failed_marked: number;
} | null {
  const record = asRecord(value);
  const runningMarked = toNonNegativeInt(record.running_marked, 0);
  const completedMarked = toNonNegativeInt(record.completed_marked, 0);
  const failedMarked = toNonNegativeInt(record.failed_marked, 0);
  if (runningMarked === 0 && completedMarked === 0 && failedMarked === 0) {
    return null;
  }
  return {
    running_marked: runningMarked,
    completed_marked: completedMarked,
    failed_marked: failedMarked,
  };
}

function runAutopilotShellCommand(input: {
  command: string;
  cwd: string;
  timeout_seconds: number;
  output_cap_bytes: number;
}): {
  command: string;
  ok: boolean;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
} {
  const startedAt = Date.now();
  const protectedDbMatch = commandReferencesProtectedDbArtifact(input.command, {
    repo_root: process.cwd(),
    workspace: input.cwd,
  });
  if (protectedDbMatch.matched) {
    const alias = protectedDbMatch.matched_alias || protectedDbMatch.artifact_path || "protected-db-artifact";
    return {
      command: input.command,
      ok: false,
      exit_code: 126,
      signal: null,
      timed_out: false,
      stdout: "",
      stderr: compactConsensusText(
        `blocked command referencing protected db artifact (${alias})`,
        input.output_cap_bytes
      ),
      duration_ms: Date.now() - startedAt,
    };
  }
  const spawned = spawnSync("/bin/sh", ["-lc", input.command], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: Math.max(1000, input.timeout_seconds * 1000),
    maxBuffer: Math.max(input.output_cap_bytes * 2, 32_000),
    env: process.env,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut =
    spawned.error?.name === "TimeoutError" ||
    String((spawned.error as NodeJS.ErrnoException | undefined)?.code ?? "").toUpperCase() === "ETIMEDOUT";
  const exitCode = typeof spawned.status === "number" ? spawned.status : null;
  const signal = spawned.signal ? String(spawned.signal) : null;
  const stdout = truncateUtf8ByBytes(String(spawned.stdout ?? ""), input.output_cap_bytes);
  const stderr = truncateUtf8ByBytes(String(spawned.stderr ?? ""), input.output_cap_bytes);
  const ok = !timedOut && signal === null && exitCode === 0;
  return {
    command: input.command,
    ok,
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    stdout,
    stderr,
    duration_ms: durationMs,
  };
}

function truncateUtf8ByBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.byteLength <= maxBytes) {
    return buffer.toString("utf8");
  }
  const sliced = buffer.subarray(0, Math.max(0, maxBytes - 3));
  return `${sliced.toString("utf8")}...`;
}

function resolveAutoRetentionConfig(
  input:
    | z.infer<typeof trichatAutoRetentionSchema>
    | Partial<
        Pick<
          z.infer<typeof trichatAutoRetentionSchema>,
          "interval_seconds" | "older_than_days" | "limit"
        >
      >,
  fallback: TriChatAutoRetentionConfig
): TriChatAutoRetentionConfig {
  return {
    interval_seconds: input.interval_seconds ?? fallback.interval_seconds ?? DEFAULT_AUTO_RETENTION_CONFIG.interval_seconds,
    older_than_days: input.older_than_days ?? fallback.older_than_days ?? DEFAULT_AUTO_RETENTION_CONFIG.older_than_days,
    limit: input.limit ?? fallback.limit ?? DEFAULT_AUTO_RETENTION_CONFIG.limit,
  };
}

function buildAdapterTelemetryStatus(
  storage: Storage,
  input: Pick<z.infer<typeof trichatAdapterTelemetrySchema>, "agent_id" | "channel" | "event_limit" | "include_events">
) {
  const includeEvents = input.include_events ?? true;
  const eventLimit = input.event_limit ?? 50;
  const states = storage.listTriChatAdapterStates({
    agent_id: input.agent_id,
    channel: input.channel,
    limit: 1000,
  });
  const summary = storage.getTriChatAdapterTelemetrySummary({
    agent_id: input.agent_id,
    channel: input.channel,
  });
  const recentEvents = includeEvents
    ? storage.listTriChatAdapterEvents({
        agent_id: input.agent_id,
        channel: input.channel,
        limit: eventLimit,
      })
    : [];
  const lastOpenEvents = includeEvents
    ? storage.listTriChatAdapterEvents({
        agent_id: input.agent_id,
        channel: input.channel,
        event_types: ["trip_opened"],
        limit: Math.min(eventLimit, 25),
      })
    : [];
  return {
    generated_at: new Date().toISOString(),
    agent_id: input.agent_id ?? null,
    channel: input.channel ?? null,
    state_count: states.length,
    states,
    summary,
    recent_events: recentEvents,
    last_open_events: lastOpenEvents,
  };
}

function evaluateConsensusTurn(
  turn: {
    user_message_id: string;
    user_created_at: string;
    user_excerpt: string;
    responses: Map<string, TriChatTimelineMessage>;
  },
  agentIds: string[],
  minAgents: number
) {
  const answers = agentIds
    .map((agentId) => {
      const message = turn.responses.get(agentId);
      if (!message) {
        return null;
      }
      const canonical = canonicalizeConsensusAnswer(message.content);
      return {
        agent_id: agentId,
        message_id: message.message_id,
        created_at: message.created_at,
        answer_excerpt: compactConsensusText(message.content, 140),
        mode: canonical.mode,
        normalized: canonical.normalized,
        numeric_value: canonical.numeric_value,
        canonical: canonical.canonical,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const responseCount = answers.length;
  const groups = new Map<string, { canonical: string; normalized: string; agents: string[] }>();
  for (const answer of answers) {
    const existing = groups.get(answer.canonical);
    if (existing) {
      existing.agents.push(answer.agent_id);
      continue;
    }
    groups.set(answer.canonical, {
      canonical: answer.canonical,
      normalized: answer.normalized,
      agents: [answer.agent_id],
    });
  }
  const rankedGroups = Array.from(groups.values()).sort((left, right) => {
    if (right.agents.length !== left.agents.length) {
      return right.agents.length - left.agents.length;
    }
    return left.canonical.localeCompare(right.canonical);
  });
  const majorityGroup = rankedGroups[0] ?? null;
  const disagreementAgents = majorityGroup
    ? answers
        .filter((answer) => answer.canonical !== majorityGroup.canonical)
        .map((answer) => answer.agent_id)
    : [];

  let status: "incomplete" | "consensus" | "disagreement" = "incomplete";
  if (responseCount >= minAgents) {
    status = groups.size <= 1 ? "consensus" : "disagreement";
  }

  return {
    user_message_id: turn.user_message_id,
    user_created_at: turn.user_created_at,
    user_excerpt: turn.user_excerpt,
    status,
    response_count: responseCount,
    required_count: minAgents,
    agents_responded: answers.map((answer) => answer.agent_id),
    majority_answer: majorityGroup?.normalized ?? null,
    disagreement_agents: disagreementAgents,
    answers: answers.map((answer) => ({
      agent_id: answer.agent_id,
      message_id: answer.message_id,
      created_at: answer.created_at,
      answer_excerpt: answer.answer_excerpt,
      mode: answer.mode,
      normalized: answer.normalized,
      numeric_value: answer.numeric_value,
    })),
  };
}

function validateTurnAdvance(
  existing: ReturnType<Storage["getTriChatTurnById"]> extends infer T
    ? T extends null
      ? never
      : NonNullable<T>
    : never,
  input: z.infer<typeof trichatTurnAdvanceSchema>
) {
  const nextStatus = String(input.status ?? existing.status);
  const nextPhase = String(input.phase ?? existing.phase);
  const nextPhaseStatus = String(input.phase_status ?? existing.phase_status);
  const metadata = (input.metadata ?? {}) as Record<string, unknown>;
  const allowPhaseSkip = metadata.allow_phase_skip === true;

  if (isTerminalTurnStatus(existing.status)) {
    if (nextStatus !== existing.status || nextPhase !== existing.phase || nextPhaseStatus !== existing.phase_status) {
      throw new Error(`Cannot mutate terminal turn ${existing.turn_id} with status=${existing.status}`);
    }
    return;
  }

  const currentIndex = TURN_PHASE_ORDER.indexOf(existing.phase);
  const nextIndex = TURN_PHASE_ORDER.indexOf(nextPhase);
  if (nextIndex < 0) {
    throw new Error(`Unknown phase: ${nextPhase}`);
  }
  if (currentIndex < 0) {
    throw new Error(`Unknown current phase on turn ${existing.turn_id}: ${existing.phase}`);
  }
  if (nextIndex < currentIndex) {
    throw new Error(`Invalid phase regression: ${existing.phase} -> ${nextPhase}`);
  }
  if (!allowPhaseSkip && nextIndex > currentIndex + 1) {
    throw new Error(
      `Invalid phase jump without allow_phase_skip=true: ${existing.phase} -> ${nextPhase}`
    );
  }

  if (nextStatus === "completed" && nextPhase !== "summarize" && !allowPhaseSkip) {
    throw new Error(`Turn can only complete at summarize phase (got ${nextPhase}).`);
  }
  if (nextStatus === "cancelled" && nextPhaseStatus === "completed") {
    throw new Error("Cancelled turn cannot have phase_status=completed.");
  }
}

function isTerminalTurnStatus(value: string): boolean {
  return value === "completed" || value === "failed" || value === "cancelled";
}

type TriChatNoveltyProposal = {
  agent_id: string;
  content: string;
  normalized: string;
  token_count: number;
  source: "artifact" | "timeline";
  created_at: string;
};

type TriChatNoveltyPair = {
  left_agent: string;
  right_agent: string;
  similarity: number;
  overlap_tokens: number;
  total_tokens: number;
};

type TriChatNoveltyFoundResult = {
  found: true;
  turn_id: string;
  thread_id: string;
  user_message_id: string;
  proposal_count: number;
  proposals: TriChatNoveltyProposal[];
  pairs: TriChatNoveltyPair[];
  average_similarity: number;
  novelty_score: number;
  novelty_threshold: number;
  max_similarity: number;
  retry_required: boolean;
  retry_agents: string[];
  retry_suppressed: boolean;
  retry_suppression_reason: string | null;
  retry_suppression_reference_turn_id: string | null;
  disagreement: boolean;
  decision_hint: "retry-delta-required" | "retry-dedupe-suppressed" | "merge-with-critique" | "merge-ready";
};

type TriChatNoveltyMissingResult = {
  found: false;
  turn_id: string | null;
  thread_id: string | null;
};

type TriChatNoveltyResult = TriChatNoveltyFoundResult | TriChatNoveltyMissingResult;

type TriChatRetryDedupeGuard = {
  suppressed: boolean;
  reason: string | null;
  reference_turn_id: string | null;
};

function resolveTurnForLookup(
  storage: Storage,
  turnId: string | undefined,
  threadId: string | undefined,
  includeClosed: boolean
) {
  if (turnId?.trim()) {
    return storage.getTriChatTurnById(turnId);
  }
  if (threadId?.trim()) {
    return storage.getLatestTriChatTurn({
      thread_id: threadId,
      include_closed: includeClosed,
    });
  }
  return null;
}

function collectLatestProposalsByAgent(
  turn: ReturnType<Storage["getTriChatTurnById"]> extends infer T
    ? T extends null
      ? never
      : NonNullable<T>
    : never,
  artifacts: ReturnType<Storage["listTriChatTurnArtifacts"]>,
  storage: Storage
): TriChatNoveltyProposal[] {
  const byAgent = new Map<string, TriChatNoveltyProposal>();

  for (const artifact of artifacts) {
    const agentId = normalizeConsensusAgentId(artifact.agent_id ?? "");
    if (!agentId) {
      continue;
    }
    const candidateText = extractArtifactProposalText(artifact);
    if (!candidateText) {
      continue;
    }
    byAgent.set(agentId, {
      agent_id: agentId,
      content: compactConsensusText(candidateText, 1200),
      normalized: normalizeNoveltyText(candidateText),
      token_count: tokenizeNoveltyText(candidateText).size,
      source: "artifact",
      created_at: artifact.created_at,
    });
  }

  if (byAgent.size === 0) {
    const timeline = storage.getTriChatTimeline({
      thread_id: turn.thread_id,
      limit: 240,
    });
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const message = timeline[index];
      if (message.role !== "assistant") {
        continue;
      }
      if (String(message.reply_to_message_id ?? "").trim() !== turn.user_message_id) {
        continue;
      }
      const agentId = normalizeConsensusAgentId(message.agent_id);
      if (!agentId || byAgent.has(agentId)) {
        continue;
      }
      const text = compactConsensusText(message.content, 1200);
      byAgent.set(agentId, {
        agent_id: agentId,
        content: text,
        normalized: normalizeNoveltyText(text),
        token_count: tokenizeNoveltyText(text).size,
        source: "timeline",
        created_at: message.created_at,
      });
    }
  }

  return [...byAgent.values()].sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function extractArtifactProposalText(artifact: ReturnType<Storage["listTriChatTurnArtifacts"]>[number]): string {
  const structured = artifact.structured ?? {};
  const structuredCandidates = [
    structured.strategy,
    structured.proposal,
    structured.plan,
    structured.summary,
    structured.content,
  ];
  for (const candidate of structuredCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return String(artifact.content ?? "").trim();
}

function normalizeNoveltyText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeNoveltyText(value: string): Set<string> {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "then",
    "else",
    "when",
    "where",
    "your",
    "have",
    "will",
    "just",
    "very",
    "make",
    "using",
    "into",
    "same",
    "plan",
    "step",
    "steps",
    "agent",
  ]);
  const tokens = normalizeNoveltyText(value)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3 && !stopWords.has(entry));
  return new Set(tokens);
}

function buildNoveltyPairs(proposals: TriChatNoveltyProposal[]): TriChatNoveltyPair[] {
  const pairs: TriChatNoveltyPair[] = [];
  for (let i = 0; i < proposals.length; i += 1) {
    const left = proposals[i];
    if (!left) {
      continue;
    }
    const leftTokens = tokenizeNoveltyText(left.content);
    for (let j = i + 1; j < proposals.length; j += 1) {
      const right = proposals[j];
      if (!right) {
        continue;
      }
      const rightTokens = tokenizeNoveltyText(right.content);
      const overlap = countTokenOverlap(leftTokens, rightTokens);
      const union = leftTokens.size + rightTokens.size - overlap;
      const similarity = union > 0 ? Number((overlap / union).toFixed(4)) : 1;
      pairs.push({
        left_agent: left.agent_id,
        right_agent: right.agent_id,
        similarity,
        overlap_tokens: overlap,
        total_tokens: union,
      });
    }
  }
  pairs.sort((left, right) => {
    if (right.similarity !== left.similarity) {
      return right.similarity - left.similarity;
    }
    const leftKey = `${left.left_agent}/${left.right_agent}`;
    const rightKey = `${right.left_agent}/${right.right_agent}`;
    return leftKey.localeCompare(rightKey);
  });
  return pairs;
}

function countTokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) {
    if (large.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function recommendNoveltyRetryAgents(
  proposals: TriChatNoveltyProposal[],
  pairs: TriChatNoveltyPair[],
  maxSimilarity: number
): string[] {
  if (proposals.length <= 1) {
    return [];
  }

  const retries = new Set<string>();
  const normalizedBuckets = new Map<string, string[]>();
  for (const proposal of proposals) {
    const bucket = normalizedBuckets.get(proposal.normalized);
    if (bucket) {
      bucket.push(proposal.agent_id);
      continue;
    }
    normalizedBuckets.set(proposal.normalized, [proposal.agent_id]);
  }
  for (const agents of normalizedBuckets.values()) {
    if (agents.length <= 1) {
      continue;
    }
    const sorted = [...agents].sort();
    for (const agent of sorted.slice(1)) {
      retries.add(agent);
    }
  }

  const hotPairs = pairs.filter((pair) => pair.similarity >= maxSimilarity).slice(0, 4);
  for (const pair of hotPairs) {
    retries.add([pair.left_agent, pair.right_agent].sort()[1] ?? pair.right_agent);
  }

  if (retries.size === 0 && pairs.length > 0) {
    const hottest = pairs[0];
    if (hottest) {
      retries.add([hottest.left_agent, hottest.right_agent].sort()[1] ?? hottest.right_agent);
    }
  }

  return [...retries].sort();
}

function inferProposalDisagreement(proposals: TriChatNoveltyProposal[]): boolean {
  if (proposals.length <= 1) {
    return false;
  }
  const unique = new Set(proposals.map((proposal) => proposal.normalized).filter((entry) => entry.length > 0));
  return unique.size > 1;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function evaluateRetryDedupeGuard(
  storage: Storage,
  turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>,
  novelty: TriChatNoveltyFoundResult,
  decision: ReturnType<typeof rankDecisionCandidates>
): TriChatRetryDedupeGuard {
  if (!novelty.retry_required) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (!isInternalReliabilityThread(storage, turn.thread_id)) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const previous = findPreviousComparableTurn(storage, turn);
  if (!previous) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const currentPrompt = normalizePromptForDedupe(turn.user_prompt);
  const previousPrompt = normalizePromptForDedupe(previous.user_prompt);
  if (!currentPrompt || currentPrompt !== previousPrompt) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (!previous.selected_agent || !decision.selected_agent) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (normalizeConsensusAgentId(previous.selected_agent) !== normalizeConsensusAgentId(decision.selected_agent)) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }
  if (typeof previous.novelty_score !== "number" || !Number.isFinite(previous.novelty_score)) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const noveltyDelta = Math.abs(previous.novelty_score - novelty.novelty_score);
  const noveltyStable = noveltyDelta <= 0.03;
  if (!noveltyStable) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  const strategySimilarity = compareTextSimilarity(
    previous.selected_strategy ?? "",
    decision.selected_strategy ?? ""
  );
  if (strategySimilarity < 0.88) {
    return {
      suppressed: false,
      reason: null,
      reference_turn_id: null,
    };
  }

  return {
    suppressed: true,
    reason: `consecutive-heartbeat dedupe suppressed retries (novelty_delta=${noveltyDelta.toFixed(
      3
    )}, strategy_similarity=${strategySimilarity.toFixed(3)})`,
    reference_turn_id: previous.turn_id,
  };
}

function isInternalReliabilityThread(storage: Storage, threadId: string): boolean {
  const normalizedThreadId = String(threadId ?? "").trim().toLowerCase();
  if (!normalizedThreadId) {
    return false;
  }
  if (normalizedThreadId === "trichat-reliability-internal" || normalizedThreadId.startsWith("trichat-reliability-")) {
    return true;
  }
  const thread = storage.getTriChatThreadById(threadId);
  if (!thread) {
    return false;
  }
  const source = String(thread.metadata?.source ?? "").trim().toLowerCase();
  if (source.includes("trichat_reliability")) {
    return true;
  }
  return false;
}

function findPreviousComparableTurn(
  storage: Storage,
  turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>
) {
  const turns = storage.listTriChatTurns({
    thread_id: turn.thread_id,
    limit: 20,
  });
  const previous = turns.find((candidate) => candidate.turn_id !== turn.turn_id) ?? null;
  if (!previous) {
    return null;
  }
  if (!previous.selected_agent || !previous.selected_strategy) {
    return null;
  }
  if (typeof previous.novelty_score !== "number" || !Number.isFinite(previous.novelty_score)) {
    return null;
  }
  return previous;
}

function normalizePromptForDedupe(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compareTextSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeNoveltyText(left);
  const rightTokens = tokenizeNoveltyText(right);
  const overlap = countTokenOverlap(leftTokens, rightTokens);
  const union = leftTokens.size + rightTokens.size - overlap;
  if (union <= 0) {
    return 1;
  }
  return overlap / union;
}

function orchestrateDecision(storage: Storage, input: z.infer<typeof trichatTurnOrchestrateSchema>) {
  const turn = storage.getTriChatTurnById(input.turn_id);
  if (!turn) {
    throw new Error(`Tri-chat turn not found: ${input.turn_id}`);
  }
  if (isTerminalTurnStatus(turn.status)) {
    return {
      ok: true,
      action: "decide",
      replayed: true,
      reason: `turn is terminal (${turn.status})`,
      turn,
    };
  }

  const noveltyEvaluation = trichatNovelty(storage, {
    turn_id: turn.turn_id,
    novelty_threshold: input.novelty_threshold,
    max_similarity: input.max_similarity,
    limit: 300,
  });
  if (!noveltyEvaluation.found) {
    throw new Error(`Cannot orchestrate decision: novelty evaluation missing for turn ${turn.turn_id}`);
  }
  const novelty = noveltyEvaluation;
  const critiqueArtifacts = storage.listTriChatTurnArtifacts({
    turn_id: turn.turn_id,
    phase: "critique",
    artifact_type: "critique",
    limit: 300,
  });
  const critiqueSummary = summarizeCritiques(critiqueArtifacts);
  const decision = rankDecisionCandidates(novelty, critiqueSummary);
  const allowPhaseSkip = input.allow_phase_skip ?? true;
  const metadata = allowPhaseSkip ? { allow_phase_skip: true } : undefined;

  let updated = storage.getTriChatTurnById(turn.turn_id);
  if (!updated) {
    throw new Error(`Turn disappeared during orchestration: ${turn.turn_id}`);
  }
  if (updated.phase === "plan") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "propose",
      phase_status: "completed",
      status: "running",
      novelty_score: novelty.novelty_score,
      novelty_threshold: novelty.novelty_threshold,
      retry_required: novelty.retry_required,
      retry_agents: novelty.retry_agents,
      disagreement: novelty.disagreement,
      metadata,
    });
  } else if (updated.phase === "propose") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "propose",
      phase_status: "completed",
      status: "running",
      novelty_score: novelty.novelty_score,
      novelty_threshold: novelty.novelty_threshold,
      retry_required: novelty.retry_required,
      retry_agents: novelty.retry_agents,
      disagreement: novelty.disagreement,
      metadata,
    });
  }

  if (updated.phase === "critique") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "critique",
      phase_status: critiqueArtifacts.length > 0 ? "completed" : "skipped",
      status: "running",
      metadata,
    });
  }
  if (updated.phase !== "merge") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "merge",
      phase_status: "running",
      status: "running",
      metadata,
    });
  }

  storage.appendTriChatTurnArtifact({
    turn_id: turn.turn_id,
    phase: "merge",
    artifact_type: "decision",
    agent_id: "router",
    content: decision.decision_summary,
    structured: {
      selected_agent: decision.selected_agent,
      selected_strategy: decision.selected_strategy,
      novelty_score: novelty.novelty_score,
      retry_required: novelty.retry_required,
      retry_agents: novelty.retry_agents,
      retry_suppressed: novelty.retry_suppressed,
      retry_suppression_reason: novelty.retry_suppression_reason,
      retry_suppression_reference_turn_id: novelty.retry_suppression_reference_turn_id,
      disagreement: novelty.disagreement,
      score_breakdown: decision.score_breakdown,
      critique_penalties: critiqueSummary.per_target,
    },
    score: decision.score,
    metadata: {
      source: "trichat.turn_orchestrate",
    },
  });

  updated = applyOrchestratedTurnAdvance(storage, updated, {
    phase: "execute",
    phase_status: "running",
    status: "running",
    decision_summary: decision.decision_summary,
    selected_agent: decision.selected_agent,
    selected_strategy: decision.selected_strategy,
    novelty_score: novelty.novelty_score,
    novelty_threshold: novelty.novelty_threshold,
    retry_required: novelty.retry_required,
    retry_agents: novelty.retry_agents,
    disagreement: novelty.disagreement,
    metadata,
  });

  return {
    ok: true,
    action: "decide",
    turn: updated,
    novelty,
    critique: critiqueSummary,
    decision,
  };
}

function orchestrateVerifyFinalize(storage: Storage, input: z.infer<typeof trichatTurnOrchestrateSchema>) {
  const turn = storage.getTriChatTurnById(input.turn_id);
  if (!turn) {
    throw new Error(`Tri-chat turn not found: ${input.turn_id}`);
  }
  if (isTerminalTurnStatus(turn.status)) {
    return {
      ok: true,
      action: "verify_finalize",
      replayed: true,
      reason: `turn is terminal (${turn.status})`,
      turn,
    };
  }

  const verifyStatus = input.verify_status ?? "skipped";
  const verifyFailed = verifyStatus === "failed" || verifyStatus === "error";
  const verifySummary = input.verify_summary?.trim() || `verify ${verifyStatus}`;
  const verifyDetails = input.verify_details ?? {};
  const allowPhaseSkip = input.allow_phase_skip ?? true;
  const metadata = allowPhaseSkip ? { allow_phase_skip: true } : undefined;

  let updated = turn;
  if (updated.phase !== "verify") {
    updated = applyOrchestratedTurnAdvance(storage, updated, {
      phase: "verify",
      phase_status: "running",
      status: "running",
      metadata,
    });
  }

  storage.appendTriChatTurnArtifact({
    turn_id: turn.turn_id,
    phase: "verify",
    artifact_type: "verifier_result",
    agent_id: "router",
    content: verifySummary,
    structured: {
      verify_status: verifyStatus,
      ...verifyDetails,
    },
    score: verifyFailed ? 0.2 : 0.9,
    metadata: {
      source: "trichat.turn_orchestrate",
    },
  });

  updated = applyOrchestratedTurnAdvance(storage, updated, {
    phase: "verify",
    phase_status: verifyFailed ? "failed" : "completed",
    status: "running",
    verify_status: verifyStatus,
    verify_summary: verifySummary,
    metadata,
  });

  updated = applyOrchestratedTurnAdvance(storage, updated, {
    phase: "summarize",
    phase_status: "completed",
    status: verifyFailed ? "failed" : "completed",
    verify_status: verifyStatus,
    verify_summary: verifySummary,
    metadata,
  });

  return {
    ok: true,
    action: "verify_finalize",
    turn: updated,
    verify: {
      status: verifyStatus,
      summary: verifySummary,
      failed: verifyFailed,
    },
  };
}

function applyOrchestratedTurnAdvance(
  storage: Storage,
  existing: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>,
  changes: {
    status?: "running" | "completed" | "failed" | "cancelled";
    phase?: "plan" | "propose" | "critique" | "merge" | "execute" | "verify" | "summarize";
    phase_status?: "running" | "completed" | "failed" | "skipped";
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
  }
) {
  validateTurnAdvance(existing, {
    mutation: {
      idempotency_key: "internal",
      side_effect_fingerprint: "internal",
    },
    turn_id: existing.turn_id,
    status: changes.status,
    phase: changes.phase,
    phase_status: changes.phase_status,
    novelty_score: changes.novelty_score,
    novelty_threshold: changes.novelty_threshold,
    retry_required: changes.retry_required,
    retry_agents: changes.retry_agents,
    disagreement: changes.disagreement,
    decision_summary: changes.decision_summary ?? undefined,
    selected_agent: changes.selected_agent ?? undefined,
    selected_strategy: changes.selected_strategy ?? undefined,
    verify_status: changes.verify_status ?? undefined,
    verify_summary: changes.verify_summary ?? undefined,
    metadata: changes.metadata,
  });
  return storage.updateTriChatTurn({
    turn_id: existing.turn_id,
    status: changes.status,
    phase: changes.phase,
    phase_status: changes.phase_status,
    novelty_score: changes.novelty_score,
    novelty_threshold: changes.novelty_threshold,
    retry_required: changes.retry_required,
    retry_agents: changes.retry_agents,
    disagreement: changes.disagreement,
    decision_summary: changes.decision_summary,
    selected_agent: changes.selected_agent,
    selected_strategy: changes.selected_strategy,
    verify_status: changes.verify_status,
    verify_summary: changes.verify_summary,
    metadata: changes.metadata,
  });
}

function summarizeCritiques(artifacts: ReturnType<Storage["listTriChatTurnArtifacts"]>) {
  const perTarget: Record<string, number> = {};
  const sample: Array<{ critic: string; target: string; concern_count: number }> = [];
  for (const artifact of artifacts) {
    const structured = artifact.structured ?? {};
    const target = normalizeConsensusAgentId(
      String(structured.target_agent ?? artifact.metadata?.target_agent ?? "")
    );
    if (!target) {
      continue;
    }
    const concerns = Array.isArray(structured.concerns) ? structured.concerns : [];
    const concernCount = Math.max(1, concerns.length);
    perTarget[target] = (perTarget[target] ?? 0) + concernCount;
    sample.push({
      critic: normalizeConsensusAgentId(String(structured.critic_agent ?? artifact.agent_id ?? "")),
      target,
      concern_count: concernCount,
    });
  }
  return {
    artifact_count: artifacts.length,
    per_target: perTarget,
    sample: sample.slice(0, 12),
  };
}

function rankDecisionCandidates(
  novelty: TriChatNoveltyFoundResult,
  critiqueSummary: ReturnType<typeof summarizeCritiques>
) {
  const pairByAgent = new Map<string, { total_similarity: number; count: number }>();
  for (const pair of novelty.pairs) {
    const left = pairByAgent.get(pair.left_agent) ?? { total_similarity: 0, count: 0 };
    left.total_similarity += pair.similarity;
    left.count += 1;
    pairByAgent.set(pair.left_agent, left);

    const right = pairByAgent.get(pair.right_agent) ?? { total_similarity: 0, count: 0 };
    right.total_similarity += pair.similarity;
    right.count += 1;
    pairByAgent.set(pair.right_agent, right);
  }

  const confidenceByAgent = new Map<string, number>();
  for (const proposal of novelty.proposals) {
    confidenceByAgent.set(proposal.agent_id, inferProposalConfidence(proposal.content));
  }

  const ranked = novelty.proposals
    .map((proposal) => {
      const aggregate = pairByAgent.get(proposal.agent_id);
      const avgSimilarity = aggregate && aggregate.count > 0 ? aggregate.total_similarity / aggregate.count : 0;
      const uniqueness = 1 - avgSimilarity;
      const confidence = confidenceByAgent.get(proposal.agent_id) ?? 0.5;
      const critiquePenalty = Math.min(0.4, (critiqueSummary.per_target[proposal.agent_id] ?? 0) * 0.08);
      const score = Number((uniqueness * 0.55 + confidence * 0.35 - critiquePenalty).toFixed(4));
      return {
        agent_id: proposal.agent_id,
        strategy: compactConsensusText(proposal.content, 260),
        uniqueness: Number(uniqueness.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        critique_penalty: Number(critiquePenalty.toFixed(4)),
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.agent_id.localeCompare(right.agent_id);
    });

  const selected = ranked[0] ?? {
    agent_id: "router",
    strategy: "fallback decision due to missing proposals",
    uniqueness: 0,
    confidence: 0.4,
    critique_penalty: 0,
    score: 0.4,
  };
  const decisionSummary = `turn decision: selected ${selected.agent_id} strategy. score=${selected.score.toFixed(
    2
  )} novelty=${novelty.novelty_score.toFixed(2)} retry=${novelty.retry_required ? "on" : "off"}${
    novelty.retry_suppressed ? " retry_suppressed=on" : ""
  } disagreement=${
    novelty.disagreement ? "on" : "off"
  }`;

  return {
    selected_agent: selected.agent_id,
    selected_strategy: selected.strategy,
    score: selected.score,
    decision_summary: decisionSummary,
    score_breakdown: ranked,
  };
}

function inferProposalConfidence(content: string): number {
  const extracted = extractJSONObject(content);
  if (!extracted) {
    return 0.5;
  }
  try {
    const parsed = JSON.parse(extracted) as Record<string, unknown>;
    const raw = parsed.confidence;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return clamp(raw, 0.05, 0.99);
    }
    if (typeof raw === "string") {
      const parsedNumber = Number.parseFloat(raw);
      if (Number.isFinite(parsedNumber)) {
        return clamp(parsedNumber, 0.05, 0.99);
      }
    }
  } catch {
    return 0.5;
  }
  return 0.5;
}

function extractJSONObject(value: string): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }
  return trimmed.slice(first, last + 1).trim();
}

type AdapterProtocolCheckInput = {
  agent_id: string;
  workspace: string;
  timeout_seconds: number;
  command_overrides: Record<string, string>;
  python_bin: string;
  thread_id: string;
  ask_prompt: string;
  run_ask_check: boolean;
  ask_dry_run: boolean;
};

type AdapterProtocolCommandResolution = {
  command: string | null;
  source: "input" | "env" | "auto" | "missing";
  wrapper_candidates: string[];
};

type AdapterProtocolExecResult = {
  ok: boolean;
  duration_ms: number;
  error: string | null;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: string | null;
  envelope: Record<string, unknown> | null;
};

function resolveAdapterProtocolWorkspace(inputWorkspace: string | undefined): string {
  const base = String(inputWorkspace ?? "").trim();
  if (!base) {
    return process.cwd();
  }
  return path.resolve(base);
}

function resolveAdapterProtocolPython(): string {
  const raw = String(process.env.TRICHAT_BRIDGE_PYTHON ?? "python3").trim();
  return raw || "python3";
}

function normalizeAdapterProtocolAgentIds(agentIds: readonly string[] | undefined): string[] {
  const normalized = normalizeConsensusAgentIds(agentIds).filter((entry) => entry.length > 0);
  if (normalized.length > 0) {
    return normalized;
  }
  return [...getTriChatActiveAgentIds()];
}

function runAdapterProtocolCheckForAgent(input: AdapterProtocolCheckInput) {
  const resolution = resolveAdapterProtocolCommand(input);
  if (!resolution.command) {
    const missingStep = {
      ok: false,
      duration_ms: 0,
      request_id: null,
      envelope_kind: null,
      protocol_version: null,
      error: "bridge command not resolved",
      stdout_excerpt: null,
      stderr_excerpt: null,
      exit_code: null,
      signal: null,
    };
    return {
      agent_id: input.agent_id,
      command: null,
      command_source: resolution.source,
      wrapper_candidates: resolution.wrapper_candidates,
      ok: false,
      ping: missingStep,
      ask: input.run_ask_check ? missingStep : null,
    };
  }

  const pingRequestId = buildAdapterProtocolRequestId(input.agent_id, "ping");
  const pingPayload = {
    op: "ping",
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    request_id: pingRequestId,
    agent_id: input.agent_id,
    thread_id: input.thread_id,
    workspace: input.workspace,
    timestamp: new Date().toISOString(),
  };
  const pingExecution = runAdapterProtocolCommand({
    command: resolution.command,
    payload: pingPayload,
    timeout_seconds: Math.min(input.timeout_seconds, 8),
    workspace: input.workspace,
  });
  const pingValidationError = validateAdapterProtocolEnvelope({
    envelope: pingExecution.envelope,
    expected_kind: BRIDGE_PONG_KIND,
    expected_request_id: pingRequestId,
    expected_agent_id: input.agent_id,
    require_content: false,
  });
  const pingError = pingExecution.error ?? pingValidationError;
  const pingStep = {
    ok: pingError === null,
    duration_ms: pingExecution.duration_ms,
    request_id: pingRequestId,
    envelope_kind: safeAdapterEnvelopeField(pingExecution.envelope?.kind),
    protocol_version: safeAdapterEnvelopeField(pingExecution.envelope?.protocol_version),
    error: pingError,
    stdout_excerpt: excerptAdapterText(pingExecution.stdout),
    stderr_excerpt: excerptAdapterText(pingExecution.stderr),
    exit_code: pingExecution.exit_code,
    signal: pingExecution.signal,
  };

  let askStep:
    | {
        ok: boolean;
        duration_ms: number;
        request_id: string | null;
        envelope_kind: string | null;
        protocol_version: string | null;
        error: string | null;
        stdout_excerpt: string | null;
        stderr_excerpt: string | null;
        exit_code: number | null;
        signal: string | null;
      }
    | null = null;

  if (input.run_ask_check) {
    const askRequestId = buildAdapterProtocolRequestId(input.agent_id, "ask");
    const askPayload = {
      op: "ask",
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      request_id: askRequestId,
      agent_id: input.agent_id,
      thread_id: input.thread_id,
      prompt: input.ask_prompt,
      history: [],
      peer_context: "",
      bootstrap_text: "",
      workspace: input.workspace,
      timestamp: new Date().toISOString(),
      turn_phase: "diagnostics",
      role_hint: "protocol-check",
      role_objective: "verify adapter protocol compliance",
      response_mode: "plain",
      collaboration_contract: "protocol diagnostics only",
    };
    const askExecution = runAdapterProtocolCommand({
      command: resolution.command,
      payload: askPayload,
      timeout_seconds: input.timeout_seconds,
      workspace: input.workspace,
      env_overrides: input.ask_dry_run ? { TRICHAT_BRIDGE_DRY_RUN: "1" } : undefined,
    });
    const askValidationError = validateAdapterProtocolEnvelope({
      envelope: askExecution.envelope,
      expected_kind: BRIDGE_RESPONSE_KIND,
      expected_request_id: askRequestId,
      expected_agent_id: input.agent_id,
      require_content: true,
    });
    const askError = askExecution.error ?? askValidationError;
    askStep = {
      ok: askError === null,
      duration_ms: askExecution.duration_ms,
      request_id: askRequestId,
      envelope_kind: safeAdapterEnvelopeField(askExecution.envelope?.kind),
      protocol_version: safeAdapterEnvelopeField(askExecution.envelope?.protocol_version),
      error: askError,
      stdout_excerpt: excerptAdapterText(askExecution.stdout),
      stderr_excerpt: excerptAdapterText(askExecution.stderr),
      exit_code: askExecution.exit_code,
      signal: askExecution.signal,
    };
  }

  const ok = pingStep.ok && (!askStep || askStep.ok);
  return {
    agent_id: input.agent_id,
    command: resolution.command,
    command_source: resolution.source,
    wrapper_candidates: resolution.wrapper_candidates,
    ok,
    ping: pingStep,
    ask: askStep,
  };
}

function resolveAdapterProtocolCommand(input: AdapterProtocolCheckInput): AdapterProtocolCommandResolution {
  const normalizedAgentId = normalizeConsensusAgentId(input.agent_id);
  const commandOverrides = input.command_overrides ?? {};
  const directOverride = String(commandOverrides[normalizedAgentId] ?? "").trim();
  const underscoredOverride = String(commandOverrides[normalizedAgentId.replace(/-/g, "_")] ?? "").trim();
  if (directOverride) {
    return {
      command: directOverride,
      source: "input",
      wrapper_candidates: [],
    };
  }
  if (underscoredOverride) {
    return {
      command: underscoredOverride,
      source: "input",
      wrapper_candidates: [],
    };
  }

  const envKeyByAgent: Record<string, string> = {
    codex: "TRICHAT_CODEX_CMD",
    cursor: "TRICHAT_CURSOR_CMD",
    gemini: "TRICHAT_GEMINI_CMD",
    claude: "TRICHAT_CLAUDE_CMD",
    "local-imprint": "TRICHAT_IMPRINT_CMD",
  };
  const envKey = getTriChatBridgeEnvVar(normalizedAgentId) ?? envKeyByAgent[normalizedAgentId] ?? "";
  const envValue = envKey ? String(process.env[envKey] ?? "").trim() : "";
  if (envValue) {
    return {
      command: envValue,
      source: "env",
      wrapper_candidates: [],
    };
  }

  const bridgeCandidates = getTriChatBridgeCandidates(input.workspace, normalizedAgentId);
  const existingWrapper = bridgeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!existingWrapper) {
    return {
      command: null,
      source: "missing",
      wrapper_candidates: bridgeCandidates,
    };
  }

  return {
    command: `${JSON.stringify(input.python_bin)} ${JSON.stringify(existingWrapper)}`,
    source: "auto",
    wrapper_candidates: bridgeCandidates,
  };
}

function runAdapterProtocolCommand(input: {
  command: string;
  payload: Record<string, unknown>;
  timeout_seconds: number;
  workspace: string;
  env_overrides?: Record<string, string>;
}): AdapterProtocolExecResult {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Math.floor(input.timeout_seconds * 1000));
  const spawned = spawnSync("/bin/sh", ["-lc", input.command], {
    cwd: input.workspace,
    input: `${JSON.stringify(input.payload)}\n`,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256_000,
    env: {
      ...process.env,
      ...(input.env_overrides ?? {}),
    },
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(spawned.stdout ?? "");
  const stderr = String(spawned.stderr ?? "");
  const exitCode = typeof spawned.status === "number" ? spawned.status : null;
  const signal = spawned.signal ? String(spawned.signal) : null;

  if (spawned.error) {
    const timedOut =
      spawned.error.name === "TimeoutError" || String((spawned.error as NodeJS.ErrnoException).code ?? "") === "ETIMEDOUT";
    const message = timedOut
      ? `bridge command timed out after ${input.timeout_seconds}s`
      : `bridge command failed: ${spawned.error.message}`;
    return {
      ok: false,
      duration_ms: durationMs,
      error: message,
      stdout,
      stderr,
      exit_code: exitCode,
      signal,
      envelope: decodeAdapterProtocolEnvelope(stdout),
    };
  }

  if (exitCode !== 0) {
    const reason = excerptAdapterText(stderr) ?? excerptAdapterText(stdout) ?? "bridge command returned non-zero exit code";
    return {
      ok: false,
      duration_ms: durationMs,
      error: `bridge command failed (exit=${exitCode}${signal ? ` signal=${signal}` : ""}): ${reason}`,
      stdout,
      stderr,
      exit_code: exitCode,
      signal,
      envelope: decodeAdapterProtocolEnvelope(stdout),
    };
  }

  const envelope = decodeAdapterProtocolEnvelope(stdout);
  if (!envelope) {
    return {
      ok: false,
      duration_ms: durationMs,
      error: "bridge protocol violation: adapter stdout was not valid JSON envelope",
      stdout,
      stderr,
      exit_code: exitCode,
      signal,
      envelope: null,
    };
  }

  return {
    ok: true,
    duration_ms: durationMs,
    error: null,
    stdout,
    stderr,
    exit_code: exitCode,
    signal,
    envelope,
  };
}

async function runAdapterProtocolCommandAsync(input: {
  command: string;
  payload: Record<string, unknown>;
  timeout_seconds: number;
  workspace: string;
  env_overrides?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<AdapterProtocolExecResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Math.floor(input.timeout_seconds * 1000));
  return await new Promise<AdapterProtocolExecResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let abortedBySignal = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let stdoutBuffers: Buffer[] = [];
    let stderrBuffers: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = 256_000;

    const finish = (result: AdapterProtocolExecResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = spawn("/bin/sh", ["-lc", input.command], {
      cwd: input.workspace,
      env: {
        ...process.env,
        ...(input.env_overrides ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      abortedBySignal = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 200);
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const next = appendBufferChunk(stdoutBuffers, stdoutBytes, buffer, maxBytes);
      stdoutBuffers = next.chunks;
      stdoutBytes = next.bytes;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const next = appendBufferChunk(stderrBuffers, stderrBytes, buffer, maxBytes);
      stderrBuffers = next.chunks;
      stderrBytes = next.bytes;
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startedAt;
      const stdout = Buffer.concat(stdoutBuffers).toString("utf8");
      const stderr = Buffer.concat(stderrBuffers).toString("utf8");
      const message = timedOut
        ? `bridge command timed out after ${input.timeout_seconds}s`
        : abortedBySignal
          ? "bridge command aborted by quorum-finalize"
          : `bridge command failed: ${error.message}`;
      finish({
        ok: false,
        duration_ms: durationMs,
        error: message,
        stdout,
        stderr,
        exit_code: exitCode,
        signal: exitSignal,
        envelope: decodeAdapterProtocolEnvelope(stdout),
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      exitCode = typeof code === "number" ? code : null;
      exitSignal = signal ? String(signal) : null;
      const durationMs = Date.now() - startedAt;
      const stdout = Buffer.concat(stdoutBuffers).toString("utf8");
      const stderr = Buffer.concat(stderrBuffers).toString("utf8");

      if (timedOut) {
        finish({
          ok: false,
          duration_ms: durationMs,
          error: `bridge command timed out after ${input.timeout_seconds}s`,
          stdout,
          stderr,
          exit_code: exitCode,
          signal: exitSignal,
          envelope: decodeAdapterProtocolEnvelope(stdout),
        });
        return;
      }
      if (abortedBySignal) {
        finish({
          ok: false,
          duration_ms: durationMs,
          error: "bridge command aborted by quorum-finalize",
          stdout,
          stderr,
          exit_code: exitCode,
          signal: exitSignal,
          envelope: decodeAdapterProtocolEnvelope(stdout),
        });
        return;
      }
      if (exitCode !== 0) {
        const reason =
          excerptAdapterText(stderr) ??
          excerptAdapterText(stdout) ??
          "bridge command returned non-zero exit code";
        finish({
          ok: false,
          duration_ms: durationMs,
          error: `bridge command failed (exit=${exitCode}${exitSignal ? ` signal=${exitSignal}` : ""}): ${reason}`,
          stdout,
          stderr,
          exit_code: exitCode,
          signal: exitSignal,
          envelope: decodeAdapterProtocolEnvelope(stdout),
        });
        return;
      }

      const envelope = decodeAdapterProtocolEnvelope(stdout);
      if (!envelope) {
        finish({
          ok: false,
          duration_ms: durationMs,
          error: "bridge protocol violation: adapter stdout was not valid JSON envelope",
          stdout,
          stderr,
          exit_code: exitCode,
          signal: exitSignal,
          envelope: null,
        });
        return;
      }

      finish({
        ok: true,
        duration_ms: durationMs,
        error: null,
        stdout,
        stderr,
        exit_code: exitCode,
        signal: exitSignal,
        envelope,
      });
    });

    try {
      child.stdin.write(`${JSON.stringify(input.payload)}\n`);
      child.stdin.end();
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const stdout = Buffer.concat(stdoutBuffers).toString("utf8");
      const stderr = Buffer.concat(stderrBuffers).toString("utf8");
      finish({
        ok: false,
        duration_ms: durationMs,
        error: error instanceof Error ? error.message : String(error),
        stdout,
        stderr,
        exit_code: exitCode,
        signal: exitSignal,
        envelope: decodeAdapterProtocolEnvelope(stdout),
      });
    }
  });
}

function appendBufferChunk(
  chunks: Buffer[],
  currentBytes: number,
  incoming: Buffer,
  maxBytes: number
): { chunks: Buffer[]; bytes: number } {
  if (currentBytes >= maxBytes) {
    return { chunks, bytes: currentBytes };
  }
  const allowedBytes = Math.min(incoming.byteLength, maxBytes - currentBytes);
  if (allowedBytes <= 0) {
    return { chunks, bytes: currentBytes };
  }
  const nextChunk = allowedBytes === incoming.byteLength ? incoming : incoming.subarray(0, allowedBytes);
  return {
    chunks: [...chunks, nextChunk],
    bytes: currentBytes + nextChunk.byteLength,
  };
}

function validateAdapterProtocolEnvelope(input: {
  envelope: Record<string, unknown> | null;
  expected_kind: string;
  expected_request_id: string;
  expected_agent_id: string;
  require_content: boolean;
}): string | null {
  if (!input.envelope) {
    return "bridge protocol violation: missing adapter envelope";
  }
  const kind = safeAdapterEnvelopeField(input.envelope.kind);
  const protocolVersion = safeAdapterEnvelopeField(input.envelope.protocol_version);
  const requestId = safeAdapterEnvelopeField(input.envelope.request_id);
  const agentId = safeAdapterEnvelopeField(input.envelope.agent_id);

  if (kind !== input.expected_kind) {
    return `bridge protocol violation: expected kind=${input.expected_kind} got=${kind ?? "(missing)"}`;
  }
  if (protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return `bridge protocol violation: expected protocol_version=${BRIDGE_PROTOCOL_VERSION} got=${protocolVersion ?? "(missing)"}`;
  }
  if (requestId !== input.expected_request_id) {
    return `bridge protocol violation: expected request_id=${input.expected_request_id} got=${requestId ?? "(missing)"}`;
  }
  if (normalizeConsensusAgentId(agentId) !== normalizeConsensusAgentId(input.expected_agent_id)) {
    return `bridge protocol violation: expected agent_id=${input.expected_agent_id} got=${agentId ?? "(missing)"}`;
  }

  if (input.require_content) {
    const content = safeAdapterEnvelopeField(input.envelope.content);
    if (!content) {
      return "bridge protocol violation: ask response missing content";
    }
  }

  return null;
}

function decodeAdapterProtocolEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function safeAdapterEnvelopeField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function excerptAdapterText(value: string): string | null {
  const compact = compactConsensusText(String(value ?? ""), 280);
  return compact.length > 0 ? compact : null;
}

function buildAdapterProtocolRequestId(agentId: string, operation: string): string {
  const normalizedAgent = normalizeConsensusAgentId(agentId).replace(/[^a-z0-9-]+/g, "-");
  const normalizedOperation = normalizeConsensusAgentId(operation).replace(/[^a-z0-9-]+/g, "-");
  const safeAgent = normalizedAgent || "agent";
  const safeOperation = normalizedOperation || "op";
  return `trichat-protocol-${safeAgent}-${safeOperation}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

type TriChatTimelineMessage = ReturnType<Storage["getTriChatTimeline"]>[number];

function normalizeConsensusAgentIds(agentIds: readonly string[] | undefined): string[] {
  const values = getTriChatActiveAgentIds(agentIds).map((agentId) => normalizeConsensusAgentId(agentId));
  const deduped = new Set<string>();
  for (const value of values) {
    if (value) {
      deduped.add(value);
    }
  }
  if (deduped.size > 0) {
    return Array.from(deduped);
  }
  return [...getTriChatActiveAgentIds()];
}

function normalizeConsensusAgentId(agentId: string | null | undefined): string {
  return normalizeTriChatAgentId(agentId);
}

function compactConsensusText(value: string, limit: number): string {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= limit) {
    return compact;
  }
  if (limit <= 3) {
    return compact.slice(0, limit);
  }
  return `${compact.slice(0, limit - 3)}...`;
}

function canonicalizeConsensusAnswer(value: string): {
  mode: "numeric" | "text";
  normalized: string;
  numeric_value: number | null;
  canonical: string;
} {
  const normalized = normalizeConsensusText(value);
  const numericValue = extractConsensusNumericValue(normalized);
  if (numericValue !== null) {
    const canonicalNumber = Number(numericValue.toPrecision(12));
    return {
      mode: "numeric",
      normalized: canonicalNumber.toString(),
      numeric_value: canonicalNumber,
      canonical: `n:${canonicalNumber.toString()}`,
    };
  }
  return {
    mode: "text",
    normalized,
    numeric_value: null,
    canonical: `t:${normalized}`,
  };
}

function normalizeConsensusText(value: string): string {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^(answer|result|final answer)\s*[:=-]\s*/i, "")
    .trim();
}

function extractConsensusNumericValue(normalized: string): number | null {
  const numericLiteral = /[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

  if (/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const answerMatch = normalized.match(
    /(?:answer|result|final answer)\s*[:=-]\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i
  );
  if (answerMatch?.[1]) {
    const parsed = Number(answerMatch[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const eqMatches = Array.from(normalized.matchAll(/=\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi));
  if (eqMatches.length > 0) {
    const parsed = Number(eqMatches[eqMatches.length - 1]?.[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const numbers = Array.from(normalized.matchAll(numericLiteral));
  if (numbers.length === 0) {
    return null;
  }
  const parsed = Number(numbers[numbers.length - 1]?.[0]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function getAutoRetentionStatus() {
  return {
    running: autoRetentionRuntime.running,
    in_tick: autoRetentionRuntime.in_tick,
    config: { ...autoRetentionRuntime.config },
    started_at: autoRetentionRuntime.started_at,
    last_tick_at: autoRetentionRuntime.last_tick_at,
    last_error: autoRetentionRuntime.last_error,
    stats: {
      tick_count: autoRetentionRuntime.tick_count,
      total_candidates: autoRetentionRuntime.total_candidates,
      total_deleted: autoRetentionRuntime.total_deleted,
    },
  };
}

function startAutoRetentionDaemon(storage: Storage) {
  stopAutoRetentionDaemon();
  autoRetentionRuntime.running = true;
  autoRetentionRuntime.in_tick = false;
  autoRetentionRuntime.started_at = new Date().toISOString();
  autoRetentionRuntime.last_error = null;
  autoRetentionRuntime.timer = setInterval(() => {
    try {
      runAutoRetentionTick(storage, autoRetentionRuntime.config);
    } catch (error) {
      autoRetentionRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, autoRetentionRuntime.config.interval_seconds * 1000);
  autoRetentionRuntime.timer.unref?.();
}

function stopAutoRetentionDaemon() {
  if (autoRetentionRuntime.timer) {
    clearInterval(autoRetentionRuntime.timer);
  }
  autoRetentionRuntime.timer = null;
  autoRetentionRuntime.running = false;
  autoRetentionRuntime.in_tick = false;
}

function runAutoRetentionTick(
  storage: Storage,
  config: TriChatAutoRetentionConfig
): TriChatAutoRetentionTickResult {
  if (autoRetentionRuntime.in_tick) {
    return {
      completed_at: new Date().toISOString(),
      candidate_count: 0,
      deleted_count: 0,
      deleted_message_ids: [],
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  autoRetentionRuntime.in_tick = true;
  try {
    const result = trichatRetention(storage, {
      older_than_days: config.older_than_days,
      limit: config.limit,
      dry_run: false,
    });

    const completedAt = new Date().toISOString();
    autoRetentionRuntime.tick_count += 1;
    autoRetentionRuntime.total_candidates += result.candidate_count;
    autoRetentionRuntime.total_deleted += result.deleted_count;
    autoRetentionRuntime.last_tick_at = completedAt;
    autoRetentionRuntime.last_error = null;

    return {
      completed_at: completedAt,
      candidate_count: result.candidate_count,
      deleted_count: result.deleted_count,
      deleted_message_ids: result.deleted_message_ids,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    autoRetentionRuntime.tick_count += 1;
    autoRetentionRuntime.last_tick_at = completedAt;
    autoRetentionRuntime.last_error = message;
    return {
      completed_at: completedAt,
      candidate_count: 0,
      deleted_count: 0,
      deleted_message_ids: [],
      reason: message,
    };
  } finally {
    autoRetentionRuntime.in_tick = false;
  }
}

function resolveTurnWatchdogConfig(
  input:
    | z.infer<typeof trichatTurnWatchdogSchema>
    | Partial<Pick<z.infer<typeof trichatTurnWatchdogSchema>, "interval_seconds" | "stale_after_seconds" | "batch_limit">>,
  fallback: TriChatTurnWatchdogConfig
): TriChatTurnWatchdogConfig {
  return {
    interval_seconds:
      input.interval_seconds ??
      fallback.interval_seconds ??
      DEFAULT_TURN_WATCHDOG_CONFIG.interval_seconds,
    stale_after_seconds:
      input.stale_after_seconds ??
      fallback.stale_after_seconds ??
      DEFAULT_TURN_WATCHDOG_CONFIG.stale_after_seconds,
    batch_limit: input.batch_limit ?? fallback.batch_limit ?? DEFAULT_TURN_WATCHDOG_CONFIG.batch_limit,
  };
}

function getTurnWatchdogStatus() {
  return {
    running: turnWatchdogRuntime.running,
    in_tick: turnWatchdogRuntime.in_tick,
    config: { ...turnWatchdogRuntime.config },
    started_at: turnWatchdogRuntime.started_at,
    last_tick_at: turnWatchdogRuntime.last_tick_at,
    last_error: turnWatchdogRuntime.last_error,
    last_slo_snapshot_id: turnWatchdogRuntime.last_slo_snapshot_id,
    stats: {
      tick_count: turnWatchdogRuntime.tick_count,
      stale_detected_count: turnWatchdogRuntime.stale_detected_count,
      escalated_count: turnWatchdogRuntime.escalated_count,
      last_escalated_turn_ids: [...turnWatchdogRuntime.last_escalated_turn_ids],
    },
  };
}

function startTurnWatchdogDaemon(storage: Storage) {
  stopTurnWatchdogDaemon();
  turnWatchdogRuntime.running = true;
  turnWatchdogRuntime.in_tick = false;
  turnWatchdogRuntime.started_at = new Date().toISOString();
  turnWatchdogRuntime.last_error = null;
  turnWatchdogRuntime.timer = setInterval(() => {
    try {
      runTurnWatchdogTick(storage, turnWatchdogRuntime.config, {});
    } catch (error) {
      turnWatchdogRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, turnWatchdogRuntime.config.interval_seconds * 1000);
  turnWatchdogRuntime.timer.unref?.();
}

function stopTurnWatchdogDaemon() {
  if (turnWatchdogRuntime.timer) {
    clearInterval(turnWatchdogRuntime.timer);
  }
  turnWatchdogRuntime.timer = null;
  turnWatchdogRuntime.running = false;
  turnWatchdogRuntime.in_tick = false;
}

function runTurnWatchdogTick(
  storage: Storage,
  config: TriChatTurnWatchdogConfig,
  overrides: {
    stale_before_iso?: string;
  }
): TriChatTurnWatchdogTickResult {
  if (turnWatchdogRuntime.in_tick) {
    return {
      completed_at: new Date().toISOString(),
      stale_before_iso: new Date(Date.now() - config.stale_after_seconds * 1000).toISOString(),
      stale_after_seconds: config.stale_after_seconds,
      candidate_count: 0,
      escalated_count: 0,
      escalated_turn_ids: [],
      invariant_failures: [],
      slo_snapshot: null,
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  turnWatchdogRuntime.in_tick = true;
  try {
    const staleBeforeIso = normalizeIsoTimestamp(
      overrides.stale_before_iso,
      new Date(Date.now() - config.stale_after_seconds * 1000).toISOString()
    );
    const staleTurns = storage.listStaleRunningTriChatTurns({
      stale_before_iso: staleBeforeIso,
      limit: config.batch_limit,
    });

    const invariantFailures: TriChatTurnWatchdogTickResult["invariant_failures"] = [];
    const escalatedTurnIds: string[] = [];
    for (const turn of staleTurns) {
      const now = new Date();
      const lastUpdatedAt = normalizeIsoTimestamp(turn.updated_at, now.toISOString());
      const staleForMs = Math.max(0, now.getTime() - Date.parse(lastUpdatedAt));
      const staleForSeconds = Math.round(staleForMs / 1000);
      const reason = `watchdog timeout: turn ${turn.turn_id} stalled ${staleForSeconds}s at ${turn.phase}/${turn.phase_status}`;
      const escalated = failTurnWithEvidence(storage, {
        turn,
        source: "trichat.turn_watchdog",
        actor: "watchdog",
        artifact_type: "watchdog_timeout",
        reason,
        metadata: {
          stale_before_iso: staleBeforeIso,
          stale_after_seconds: config.stale_after_seconds,
          stale_for_seconds: staleForSeconds,
        },
        chaos_action: "watchdog_timeout",
      });
      escalatedTurnIds.push(escalated.turn.turn_id);
      if (!escalated.invariants.ok) {
        invariantFailures.push({
          turn_id: escalated.turn.turn_id,
          failed_checks: escalated.invariants.checks
            .filter((check) => !check.met)
            .map((check) => check.name),
        });
      }
    }

    const completedAt = new Date().toISOString();
    turnWatchdogRuntime.tick_count += 1;
    turnWatchdogRuntime.stale_detected_count += staleTurns.length;
    turnWatchdogRuntime.escalated_count += escalatedTurnIds.length;
    turnWatchdogRuntime.last_escalated_turn_ids = escalatedTurnIds.slice(0, 20);
    turnWatchdogRuntime.last_tick_at = completedAt;
    turnWatchdogRuntime.last_error = null;

    let snapshotRecord: ReturnType<Storage["appendTriChatSloSnapshot"]> | null = null;
    if (shouldPersistSloSnapshot(storage, completedAt)) {
      const metrics = computeTriChatSloMetrics(storage, {
        window_minutes: 60,
        event_limit: 8000,
      });
      snapshotRecord = storage.appendTriChatSloSnapshot({
        window_minutes: metrics.window_minutes,
        adapter_sample_count: metrics.adapter.sample_count,
        adapter_error_count: metrics.adapter.error_count,
        adapter_error_rate: metrics.adapter.error_rate,
        adapter_latency_p95_ms: metrics.adapter.p95_latency_ms,
        turn_total_count: metrics.turns.total_count,
        turn_failed_count: metrics.turns.failed_count,
        turn_failure_rate: metrics.turns.failure_rate,
        metadata: {
          source: "trichat.turn_watchdog",
          stale_before_iso: staleBeforeIso,
          stale_after_seconds: config.stale_after_seconds,
          candidate_count: staleTurns.length,
          escalated_count: escalatedTurnIds.length,
        },
      });
      turnWatchdogRuntime.last_slo_snapshot_id = snapshotRecord.snapshot_id;
    }

    return {
      completed_at: completedAt,
      stale_before_iso: staleBeforeIso,
      stale_after_seconds: config.stale_after_seconds,
      candidate_count: staleTurns.length,
      escalated_count: escalatedTurnIds.length,
      escalated_turn_ids: escalatedTurnIds,
      invariant_failures: invariantFailures,
      slo_snapshot: snapshotRecord
        ? {
            snapshot_id: snapshotRecord.snapshot_id,
            created_at: snapshotRecord.created_at,
          }
        : null,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    turnWatchdogRuntime.tick_count += 1;
    turnWatchdogRuntime.last_tick_at = completedAt;
    turnWatchdogRuntime.last_error = message;
    return {
      completed_at: completedAt,
      stale_before_iso: new Date(Date.now() - config.stale_after_seconds * 1000).toISOString(),
      stale_after_seconds: config.stale_after_seconds,
      candidate_count: 0,
      escalated_count: 0,
      escalated_turn_ids: [],
      invariant_failures: [],
      slo_snapshot: null,
      reason: message,
    };
  } finally {
    turnWatchdogRuntime.in_tick = false;
  }
}

function shouldPersistSloSnapshot(storage: Storage, nowIso: string): boolean {
  const latest = storage.getLatestTriChatSloSnapshot();
  if (!latest) {
    return true;
  }
  const latestEpoch = Date.parse(latest.created_at);
  const nowEpoch = Date.parse(nowIso);
  if (!Number.isFinite(latestEpoch) || !Number.isFinite(nowEpoch)) {
    return true;
  }
  return nowEpoch - latestEpoch >= 60_000;
}

function resolveChaosTargetTurn(
  storage: Storage,
  turnId: string | undefined,
  threadId: string | undefined,
  includeClosed: boolean
) {
  const normalizedTurnId = String(turnId ?? "").trim();
  if (normalizedTurnId) {
    return storage.getTriChatTurnById(normalizedTurnId);
  }
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedThreadId) {
    return null;
  }
  const running = storage.getLatestTriChatTurn({
    thread_id: normalizedThreadId,
    include_closed: false,
  });
  if (running) {
    return running;
  }
  if (!includeClosed) {
    return null;
  }
  return storage.getLatestTriChatTurn({
    thread_id: normalizedThreadId,
    include_closed: true,
  });
}

function pickTurnSummary(turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>) {
  return {
    turn_id: turn.turn_id,
    thread_id: turn.thread_id,
    status: turn.status,
    phase: turn.phase,
    phase_status: turn.phase_status,
    updated_at: turn.updated_at,
    finished_at: turn.finished_at,
    selected_agent: turn.selected_agent,
    verify_status: turn.verify_status,
    verify_summary: turn.verify_summary,
  };
}

function injectAdapterFailure(
  storage: Storage,
  input: {
    agent_id: string;
    channel: z.infer<typeof adapterChannelSchema>;
    reason: string;
    open_for_seconds: number;
  }
) {
  const agentId = normalizeConsensusAgentId(input.agent_id);
  if (!agentId) {
    throw new Error("agent_id is required");
  }
  const channel = input.channel;
  const now = new Date().toISOString();
  const openForSeconds = clampInt(input.open_for_seconds, 5, 3600);
  const openUntil = new Date(Date.now() + openForSeconds * 1000).toISOString();
  const existing = storage.listTriChatAdapterStates({
    agent_id: agentId,
    channel,
    limit: 1,
  })[0];
  const state = storage.upsertTriChatAdapterStates({
    states: [
      {
        agent_id: agentId,
        channel,
        updated_at: now,
        open: true,
        open_until: openUntil,
        failure_count: 0,
        trip_count: (existing?.trip_count ?? 0) + 1,
        success_count: existing?.success_count ?? 0,
        last_error: input.reason,
        last_opened_at: now,
        turn_count: existing?.turn_count ?? 0,
        degraded_turn_count: existing?.degraded_turn_count ?? 0,
        last_result: "trip-opened",
        metadata: {
          ...(existing?.metadata ?? {}),
          chaos_injected: true,
          chaos_injected_at: now,
          chaos_reason: input.reason,
          chaos_open_for_seconds: openForSeconds,
        },
      },
    ],
  })[0];
  const event = storage.appendTriChatAdapterEvents({
    events: [
      {
        agent_id: agentId,
        channel,
        event_type: "trip_opened",
        open_until: openUntil,
        error_text: input.reason,
        details: {
          source: "trichat.chaos",
          injected: true,
          open_for_seconds: openForSeconds,
        },
      },
    ],
  })[0];
  const chaosEvent = storage.appendTriChatChaosEvent({
    action: "inject_adapter_failure",
    outcome: "injected",
    agent_id: agentId,
    channel,
    details: {
      reason: input.reason,
      open_until: openUntil,
    },
  });
  return {
    state,
    event,
    chaos_event: chaosEvent,
  };
}

function failTurnWithEvidence(
  storage: Storage,
  input: {
    turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>;
    source: string;
    actor: string;
    artifact_type: string;
    reason: string;
    metadata?: Record<string, unknown>;
    chaos_action: string;
  }
) {
  const turn = input.turn;
  if (isTerminalTurnStatus(turn.status)) {
    const invariants = evaluateTurnAutoFinalizationInvariants(storage, turn);
    const chaosEvent = storage.appendTriChatChaosEvent({
      action: input.chaos_action,
      outcome: "skipped-terminal",
      thread_id: turn.thread_id,
      turn_id: turn.turn_id,
      agent_id: input.actor,
      details: {
        source: input.source,
        reason: input.reason,
        status: turn.status,
      },
    });
    return {
      turn,
      artifact: null,
      message: null,
      bus_event: null,
      invariants,
      chaos_event: chaosEvent,
    };
  }

  const compactReason = compactConsensusText(input.reason, 800);
  const artifact = storage.appendTriChatTurnArtifact({
    turn_id: turn.turn_id,
    phase: turn.phase,
    artifact_type: input.artifact_type,
    agent_id: input.actor,
    content: compactReason,
    structured: {
      source: input.source,
      reason: compactReason,
      from_phase: turn.phase,
      from_phase_status: turn.phase_status,
      from_status: turn.status,
    },
    metadata: {
      source: input.source,
      ...input.metadata,
    },
  });
  const updated = storage.updateTriChatTurn({
    turn_id: turn.turn_id,
    status: "failed",
    phase: "summarize",
    phase_status: "failed",
    verify_status: "error",
    verify_summary: compactReason,
    metadata: {
      source: input.source,
      auto_fail_finalize: true,
      allow_phase_skip: true,
      failure_reason: compactReason,
      ...input.metadata,
    },
  });
  const message = storage.appendTriChatMessage({
    thread_id: turn.thread_id,
    agent_id: input.actor,
    role: "system",
    content: `[${input.actor}] ${compactReason}`,
    reply_to_message_id: turn.user_message_id,
    metadata: {
      kind: "turn-failed",
      source: input.source,
      turn_id: turn.turn_id,
      from_phase: turn.phase,
      from_status: turn.status,
      ...input.metadata,
    },
  });
  const busEvent = storage.appendTriChatBusEvent({
    thread_id: turn.thread_id,
    event_type: input.source === "trichat.turn_watchdog" ? "trichat.turn_watchdog" : "trichat.chaos",
    source_agent: input.actor,
    source_client: `mcp:${input.source}`,
    role: "system",
    content: compactReason,
    metadata: {
      kind: input.source === "trichat.turn_watchdog" ? "trichat.turn_watchdog" : "trichat.chaos",
      source: input.source,
      turn_id: turn.turn_id,
      phase: turn.phase,
      phase_status: turn.phase_status,
      status: "failed",
      event_kind: input.source === "trichat.turn_watchdog" ? "watchdog" : "chaos",
      ...input.metadata,
    },
  });
  const invariants = evaluateTurnAutoFinalizationInvariants(storage, updated);
  const chaosEvent = storage.appendTriChatChaosEvent({
    action: input.chaos_action,
    outcome: invariants.ok ? "escalated" : "escalated-invariant-failed",
    thread_id: updated.thread_id,
    turn_id: updated.turn_id,
    agent_id: input.actor,
    details: {
      source: input.source,
      reason: compactReason,
      invariant_ok: invariants.ok,
      failed_checks: invariants.checks.filter((check) => !check.met).map((check) => check.name),
    },
  });
  return {
    turn: updated,
    artifact,
    message,
    bus_event: busEvent,
    invariants,
    chaos_event: chaosEvent,
  };
}

function evaluateTurnAutoFinalizationInvariants(
  storage: Storage,
  turn: NonNullable<ReturnType<Storage["getTriChatTurnById"]>>
) {
  const artifacts = storage.listTriChatTurnArtifacts({
    turn_id: turn.turn_id,
    limit: 300,
  });
  const artifactTypes = new Set(
    artifacts.map((artifact) => String(artifact.artifact_type ?? "").trim().toLowerCase()).filter(Boolean)
  );
  const timeline = storage.getTriChatTimeline({
    thread_id: turn.thread_id,
    limit: 300,
  });
  const timelineEvidence = timeline.filter((message) => {
    if (message.role !== "system") {
      return false;
    }
    const messageTurnId = String(message.metadata?.turn_id ?? "").trim();
    if (messageTurnId === turn.turn_id) {
      return true;
    }
    const content = String(message.content ?? "");
    return content.includes(turn.turn_id);
  });

  const failureEvidenceTypes = ["router_error", "watchdog_timeout", "chaos_fault", "verifier_result"];
  const hasFailureArtifact = failureEvidenceTypes.some((type) => artifactTypes.has(type));
  const isTerminal = turn.status === "failed" || turn.status === "completed" || turn.status === "cancelled";

  const checks = [
    {
      name: "terminal_status",
      met: isTerminal,
      details: `status=${turn.status}`,
    },
    {
      name: "summarize_phase",
      met: turn.phase === "summarize",
      details: `phase=${turn.phase}`,
    },
    {
      name: "terminal_phase_status",
      met: turn.phase_status === "failed" || turn.phase_status === "completed",
      details: `phase_status=${turn.phase_status}`,
    },
    {
      name: "finished_at_set",
      met: Boolean(turn.finished_at),
      details: `finished_at=${turn.finished_at ?? "(null)"}`,
    },
    {
      name: "failure_evidence_present",
      met: turn.status !== "failed" || hasFailureArtifact || timelineEvidence.length > 0,
      details: `artifacts=${[...artifactTypes].join(",") || "none"} timeline_evidence=${timelineEvidence.length}`,
    },
    {
      name: "verify_summary_on_failure",
      met: turn.status !== "failed" || Boolean(String(turn.verify_summary ?? "").trim()),
      details: `verify_summary=${String(turn.verify_summary ?? "").trim() ? "present" : "missing"}`,
    },
  ];

  return {
    ok: checks.every((check) => check.met),
    checks,
    evidence: {
      artifact_count: artifacts.length,
      artifact_types: [...artifactTypes],
      timeline_evidence_count: timelineEvidence.length,
    },
  };
}

function buildTmuxControllerStatus(storage: Storage, input: z.infer<typeof trichatTmuxControllerSchema>) {
  const state = resolveTmuxControllerState(storage, input);
  const runtime = getTmuxRuntimeInfo();
  const summarized = summarizeTmuxState(state, input.include_completed ?? false);
  return {
    generated_at: new Date().toISOString(),
    action: "status",
    runtime,
    session_active: tmuxSessionExists(state.session_name),
    state: summarized,
    dashboard: buildTmuxDashboard(state, summarized.workers),
  };
}

function resolveTmuxControllerState(
  storage: Storage,
  input: Pick<
    z.infer<typeof trichatTmuxControllerSchema>,
    "session_name" | "workspace" | "worker_count" | "shell" | "max_queue_per_worker"
  >
): TriChatTmuxControllerStateRecord {
  const persisted = storage.getTriChatTmuxControllerState();
  const base: TriChatTmuxControllerStateRecord = persisted ?? {
    enabled: false,
    session_name: TMUX_CONTROLLER_DEFAULTS.session_name,
    workspace: TMUX_CONTROLLER_DEFAULTS.workspace,
    worker_count: TMUX_CONTROLLER_DEFAULTS.worker_count,
    shell: TMUX_CONTROLLER_DEFAULTS.shell,
    max_queue_per_worker: TMUX_CONTROLLER_DEFAULTS.max_queue_per_worker,
    next_task_seq: TMUX_CONTROLLER_DEFAULTS.next_task_seq,
    tasks: [],
    last_dispatch_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  };

  const sessionName = String(input.session_name ?? base.session_name).trim() || TMUX_CONTROLLER_DEFAULTS.session_name;
  const workspace = path.resolve(String(input.workspace ?? base.workspace).trim() || TMUX_CONTROLLER_DEFAULTS.workspace);
  const workerCount = clampInt(input.worker_count ?? base.worker_count, 1, 12);
  const shell = String(input.shell ?? base.shell).trim() || TMUX_CONTROLLER_DEFAULTS.shell;
  const maxQueuePerWorker = clampInt(input.max_queue_per_worker ?? base.max_queue_per_worker, 1, 200);
  return {
    ...base,
    session_name: sessionName,
    workspace,
    worker_count: workerCount,
    shell,
    max_queue_per_worker: maxQueuePerWorker,
    tasks: [...(base.tasks ?? [])].sort((left, right) => left.seq - right.seq),
  };
}

function summarizeTmuxState(state: TriChatTmuxControllerStateRecord, includeCompleted: boolean) {
  const tasks = includeCompleted ? state.tasks : state.tasks.filter((task) => !isTerminalTmuxTaskStatus(task.status));
  const counts = {
    total: tasks.length,
    queued: tasks.filter((task) => task.status === "queued").length,
    dispatched: tasks.filter((task) => task.status === "dispatched").length,
    running: tasks.filter((task) => task.status === "running").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  };
  return {
    enabled: state.enabled,
    session_name: state.session_name,
    workspace: state.workspace,
    worker_count: state.worker_count,
    shell: state.shell,
    max_queue_per_worker: state.max_queue_per_worker,
    next_task_seq: state.next_task_seq,
    updated_at: state.updated_at,
    last_dispatch_at: state.last_dispatch_at,
    last_error: state.last_error,
    counts,
    workers: buildTmuxWorkerSnapshots(state),
    tasks,
  };
}

function buildTmuxDashboard(
  state: TriChatTmuxControllerStateRecord,
  workerSnapshots?: TriChatTmuxWorkerSnapshot[]
): TriChatTmuxDashboardPayload {
  const nowMs = Date.now();
  const queueCandidates = state.tasks.filter((task) => task.status === "queued" || task.status === "dispatched");
  let queueOldestTaskId: string | null = null;
  let queueAgeSeconds: number | null = null;
  let oldestMs: number | null = null;
  for (const task of queueCandidates) {
    const createdMs = parseIsoDateMs(task.created_at);
    if (createdMs === null) {
      continue;
    }
    if (oldestMs === null || createdMs < oldestMs) {
      oldestMs = createdMs;
      queueOldestTaskId = task.task_id;
    }
  }
  if (oldestMs !== null) {
    queueAgeSeconds = Math.max(0, Math.round((nowMs - oldestMs) / 1000));
  }

  const failedTasks = [...state.tasks]
    .filter((task) => task.status === "failed")
    .sort((left, right) => {
      const leftMs =
        parseIsoDateMs(left.completed_at) ?? parseIsoDateMs(left.dispatched_at) ?? parseIsoDateMs(left.created_at) ?? 0;
      const rightMs =
        parseIsoDateMs(right.completed_at) ?? parseIsoDateMs(right.dispatched_at) ?? parseIsoDateMs(right.created_at) ?? 0;
      if (leftMs !== rightMs) {
        return rightMs - leftMs;
      }
      return right.seq - left.seq;
    });
  const latestFailure = failedTasks[0] ?? null;
  const latestFailureErrorRaw =
    typeof latestFailure?.metadata?.tmux_dispatch_error === "string"
      ? String(latestFailure?.metadata?.tmux_dispatch_error ?? "").trim()
      : "";
  const lastError = String(state.last_error ?? "").trim() || latestFailureErrorRaw || null;
  const failureClass =
    lastError === null && failedTasks.length === 0 ? "none" : classifyTmuxFailureClass(lastError ?? "");
  const lastFailureAt =
    latestFailure?.completed_at ?? latestFailure?.dispatched_at ?? latestFailure?.created_at ?? null;
  const snapshots = workerSnapshots ?? buildTmuxWorkerSnapshots(state);
  const laneSignals = buildTmuxWorkerLaneSignals(state, snapshots);

  return {
    generated_at: new Date().toISOString(),
    queue_depth: queueCandidates.length,
    queue_age_seconds: queueAgeSeconds,
    queue_oldest_task_id: queueOldestTaskId,
    worker_load: snapshots.map((snapshot) => ({
      lane_state: laneSignals.get(snapshot.worker_id)?.lane_state ?? "unknown",
      lane_signal: laneSignals.get(snapshot.worker_id)?.lane_signal ?? null,
      lane_updated_at: laneSignals.get(snapshot.worker_id)?.lane_updated_at ?? new Date().toISOString(),
      worker_id: snapshot.worker_id,
      active_queue: snapshot.active_queue,
      active_load: snapshot.active_load,
    })),
    failure_class: failureClass,
    failure_count: failedTasks.length,
    last_failure_at: lastFailureAt,
    last_error: lastError,
  };
}

function maybeScaleUpTmuxWorkers(
  state: TriChatTmuxControllerStateRecord,
  input: {
    auto_scale_workers: boolean;
    min_worker_count?: number;
    max_worker_count?: number;
    target_queue_per_worker?: number;
  }
): {
  state: TriChatTmuxControllerStateRecord;
  scaled_up: boolean;
  from_worker_count: number;
  to_worker_count: number;
  target_worker_count: number;
  queue_depth: number;
  target_queue_per_worker: number;
  error: string | null;
} {
  const fromWorkerCount = clampInt(state.worker_count, 1, 12);
  const minWorkerCount = clampInt(input.min_worker_count ?? 1, 1, 12);
  const maxWorkerCount = clampInt(input.max_worker_count ?? 12, minWorkerCount, 12);
  const queueDepth = state.tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length;
  const targetQueuePerWorker = clampInt(
    input.target_queue_per_worker ?? Math.max(1, Math.min(state.max_queue_per_worker, 4)),
    1,
    200
  );
  const recommended = clampInt(Math.ceil(Math.max(1, queueDepth) / targetQueuePerWorker), minWorkerCount, maxWorkerCount);
  const targetWorkerCount = input.auto_scale_workers ? Math.max(fromWorkerCount, recommended) : fromWorkerCount;
  if (targetWorkerCount <= fromWorkerCount) {
    return {
      state,
      scaled_up: false,
      from_worker_count: fromWorkerCount,
      to_worker_count: fromWorkerCount,
      target_worker_count: targetWorkerCount,
      queue_depth: queueDepth,
      target_queue_per_worker: targetQueuePerWorker,
      error: null,
    };
  }

  const candidate: TriChatTmuxControllerStateRecord = {
    ...state,
    worker_count: targetWorkerCount,
  };
  try {
    ensureTmuxSession(candidate);
    return {
      state: candidate,
      scaled_up: true,
      from_worker_count: fromWorkerCount,
      to_worker_count: targetWorkerCount,
      target_worker_count: targetWorkerCount,
      queue_depth: queueDepth,
      target_queue_per_worker: targetQueuePerWorker,
      error: null,
    };
  } catch (error) {
    return {
      state,
      scaled_up: false,
      from_worker_count: fromWorkerCount,
      to_worker_count: fromWorkerCount,
      target_worker_count: targetWorkerCount,
      queue_depth: queueDepth,
      target_queue_per_worker: targetQueuePerWorker,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function nudgeBlockedTmuxWorkers(
  state: TriChatTmuxControllerStateRecord,
  laneSignals: Map<string, TriChatTmuxWorkerLaneSignal>
): {
  nudged_count: number;
  nudges: Array<{
    worker_id: string;
    lane_state: TriChatTmuxLaneState;
    sent: string;
    ok: boolean;
    error: string | null;
  }>;
} {
  const nudges: Array<{
    worker_id: string;
    lane_state: TriChatTmuxLaneState;
    sent: string;
    ok: boolean;
    error: string | null;
  }> = [];

  for (const [workerId, signal] of laneSignals.entries()) {
    const payload = resolveTmuxLaneNudgePayload(signal.lane_state);
    if (payload === null) {
      continue;
    }
    const sent = payload.length > 0 ? payload : "<enter>";
    const args =
      payload.length > 0
        ? ["send-keys", "-t", `${state.session_name}:${workerId}`, payload, "C-m"]
        : ["send-keys", "-t", `${state.session_name}:${workerId}`, "C-m"];
    const result = runTmuxCommand(args, {
      timeout_ms: 3000,
    });
    nudges.push({
      worker_id: workerId,
      lane_state: signal.lane_state,
      sent,
      ok: result.ok,
      error: result.ok ? null : compactConsensusText((result.error ?? result.stderr) || "tmux nudge failed", 240),
    });
  }

  return {
    nudged_count: nudges.filter((entry) => entry.ok).length,
    nudges,
  };
}

function resolveTmuxLaneNudgePayload(laneState: TriChatTmuxLaneState): string | null {
  if (laneState === "blocked_trust") {
    return "yes";
  }
  if (laneState === "blocked_plan" || laneState === "blocked_prompt") {
    return "";
  }
  return null;
}

function classifyTmuxFailureClass(errorText: string): TriChatTmuxFailureClass {
  const normalized = String(errorText ?? "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (/\btimed?\s*out\b|deadline exceeded|etimedout/.test(normalized)) {
    return "timeout";
  }
  if (/\bcommand not found\b|enoent/.test(normalized)) {
    return "command_not_found";
  }
  if (/\bpermission denied\b|eacces/.test(normalized)) {
    return "permission_denied";
  }
  if (/protected db artifact|blocked tmux task/.test(normalized)) {
    return "permission_denied";
  }
  if (/tmux runtime is unavailable|failed to create tmux session|failed to create tmux window|kill-session/.test(normalized)) {
    return "tmux_runtime";
  }
  if (/dispatch|send-keys|queue|worker/.test(normalized)) {
    return "dispatch_error";
  }
  return "unknown";
}

function parseIsoDateMs(value: string | null | undefined): number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function buildTmuxWorkerSnapshots(state: TriChatTmuxControllerStateRecord): TriChatTmuxWorkerSnapshot[] {
  const workerIds = resolveTmuxWorkerIds(state.worker_count);
  const snapshots = workerIds.map((workerId) => ({
    worker_id: workerId,
    active_queue: 0,
    active_load: 0,
    recent_task_ids: [] as string[],
  }));
  const indexByWorker = new Map<string, number>();
  snapshots.forEach((entry, index) => indexByWorker.set(entry.worker_id, index));
  const workerTasks = [...state.tasks]
    .filter((task) => task.worker_id && !isTerminalTmuxTaskStatus(task.status))
    .sort((left, right) => left.seq - right.seq);
  for (const task of workerTasks) {
    if (!task.worker_id) {
      continue;
    }
    const index = indexByWorker.get(task.worker_id);
    if (index === undefined) {
      continue;
    }
    const snapshot = snapshots[index];
    snapshot.active_queue += 1;
    snapshot.active_load += task.complexity;
    if (snapshot.recent_task_ids.length < 20) {
      snapshot.recent_task_ids.push(task.task_id);
    }
  }
  return snapshots;
}

function buildTmuxWorkerLaneSignals(
  state: TriChatTmuxControllerStateRecord,
  snapshots: TriChatTmuxWorkerSnapshot[]
): Map<string, TriChatTmuxWorkerLaneSignal> {
  const nowIso = new Date().toISOString();
  const signals = new Map<string, TriChatTmuxWorkerLaneSignal>();
  const workerIds = snapshots.map((snapshot) => snapshot.worker_id);
  if (!state.enabled) {
    for (const workerId of workerIds) {
      signals.set(workerId, {
        lane_state: "idle",
        lane_signal: "controller disabled",
        lane_updated_at: nowIso,
      });
    }
    return signals;
  }

  if (!tmuxSessionExists(state.session_name)) {
    for (const workerId of workerIds) {
      signals.set(workerId, {
        lane_state: "offline",
        lane_signal: `tmux session unavailable (${state.session_name})`,
        lane_updated_at: nowIso,
      });
    }
    return signals;
  }

  const captured = captureTmuxWorkerPanes(state, {
    capture_lines: 220,
  });
  for (const pane of captured) {
    signals.set(
      pane.worker_id,
      classifyTmuxWorkerLaneSignal({
        ok: pane.ok,
        output: pane.output,
        error: pane.error,
      })
    );
  }
  for (const workerId of workerIds) {
    if (!signals.has(workerId)) {
      signals.set(workerId, {
        lane_state: "unknown",
        lane_signal: "no pane capture",
        lane_updated_at: nowIso,
      });
    }
  }
  return signals;
}

function classifyTmuxWorkerLaneSignal(input: {
  ok: boolean;
  output: string;
  error: string | null;
}): TriChatTmuxWorkerLaneSignal {
  const laneUpdatedAt = new Date().toISOString();
  if (!input.ok) {
    return {
      lane_state: "offline",
      lane_signal: compactConsensusText(String(input.error ?? "").trim() || "pane capture failed", 180),
      lane_updated_at: laneUpdatedAt,
    };
  }

  const output = String(input.output ?? "");
  const normalized = output.toLowerCase();
  const trustPrompt = findTmuxLaneLine(
    output,
    /\b(yes,\s*i\s+trust\s+this\s+folder|trust\s+this\s+folder|trust\s+this\s+project)\b/i
  );
  if (trustPrompt) {
    return {
      lane_state: "blocked_trust",
      lane_signal: compactConsensusText(trustPrompt, 180),
      lane_updated_at: laneUpdatedAt,
    };
  }

  const planPrompt = findTmuxLaneLine(
    output,
    /\b(entered\s+plan\s+mode|approve\s+plan|plan\s+mode|review\s+plan|plan\s+requires\s+approval)\b/i
  );
  if (planPrompt) {
    return {
      lane_state: "blocked_plan",
      lane_signal: compactConsensusText(planPrompt, 180),
      lane_updated_at: laneUpdatedAt,
    };
  }

  const genericPrompt = findTmuxLaneLine(output, /\b(press\s+enter|continue\?|confirm|approve|allow)\b/i);
  if (genericPrompt) {
    return {
      lane_state: "blocked_prompt",
      lane_signal: compactConsensusText(genericPrompt, 180),
      lane_updated_at: laneUpdatedAt,
    };
  }

  const errorLine = findTmuxLaneLine(
    output,
    /\b(error:|traceback|exception|failed\b|command\s+not\s+found|permission\s+denied)\b/i
  );
  if (errorLine) {
    return {
      lane_state: "error",
      lane_signal: compactConsensusText(errorLine, 180),
      lane_updated_at: laneUpdatedAt,
    };
  }

  const workingLine = findTmuxLaneLine(
    output,
    /\b(analyzing|analysis|writing|running|installing|processing|thinking|proofing|honking|doing|executing)\b/i
  );
  if (workingLine) {
    return {
      lane_state: "working",
      lane_signal: compactConsensusText(workingLine, 180),
      lane_updated_at: laneUpdatedAt,
    };
  }

  if (/^\s*>\s*$/m.test(output) || /\bbypass permissions on\b/.test(normalized)) {
    return {
      lane_state: "idle",
      lane_signal: "ready",
      lane_updated_at: laneUpdatedAt,
    };
  }

  const fallback = lastNonEmptyTmuxLine(output);
  return {
    lane_state: fallback ? "unknown" : "idle",
    lane_signal: fallback ? compactConsensusText(fallback, 180) : "no recent output",
    lane_updated_at: laneUpdatedAt,
  };
}

function findTmuxLaneLine(output: string, pattern: RegExp): string | null {
  const lines = String(output ?? "").split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (pattern.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function lastNonEmptyTmuxLine(output: string): string | null {
  const lines = String(output ?? "").split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function captureTmuxWorkerPanes(
  state: TriChatTmuxControllerStateRecord,
  input: { worker_id?: string; capture_lines: number }
) {
  const requestedWorker = input.worker_id?.trim() || null;
  const workerIds = resolveTmuxWorkerIds(state.worker_count).filter((workerId) =>
    requestedWorker ? workerId === requestedWorker : true
  );
  return workerIds.map((workerId) => {
    const capture = captureTmuxPane(state.session_name, workerId, input.capture_lines);
    return {
      worker_id: workerId,
      ok: capture.ok,
      error: capture.ok ? null : capture.error,
      output: capture.stdout,
      stderr: capture.stderr,
      dry_run: capture.dry_run,
    };
  });
}

function syncTmuxTaskStatusFromPanes(
  state: TriChatTmuxControllerStateRecord,
  input: { capture_lines: number }
): TriChatTmuxSyncResult {
  const markersByWorker = captureTmuxWorkerPanes(state, {
    capture_lines: input.capture_lines,
  });
  const startedIds = new Set<string>();
  const endedById = new Map<string, number>();
  const startPattern = new RegExp(`${TMUX_TASK_START_MARKER}\\s+([A-Za-z0-9._:-]+)`);
  const endPattern = new RegExp(`${TMUX_TASK_END_MARKER}\\s+([A-Za-z0-9._:-]+)\\s+(-?\\d+)`);

  for (const pane of markersByWorker) {
    if (!pane.ok) {
      continue;
    }
    const lines = String(pane.output ?? "").split(/\r?\n/);
    for (const line of lines) {
      const startMatch = line.match(startPattern);
      if (startMatch?.[1]) {
        startedIds.add(startMatch[1]);
      }
      const endMatch = line.match(endPattern);
      if (endMatch?.[1]) {
        endedById.set(endMatch[1], Number.parseInt(endMatch[2] ?? "1", 10));
      }
    }
  }

  let runningMarked = 0;
  let completedMarked = 0;
  let failedMarked = 0;
  const now = new Date().toISOString();
  const tasks = state.tasks.map((task) => {
    const updated: TriChatTmuxControllerTaskRecord = {
      ...task,
      metadata: { ...(task.metadata ?? {}) },
    };
    if (endedById.has(task.task_id)) {
      const exitCode = endedById.get(task.task_id) ?? 1;
      if (!isTerminalTmuxTaskStatus(updated.status)) {
        if (updated.status === "running" || updated.status === "dispatched" || updated.status === "queued") {
          if (!updated.started_at) {
            updated.started_at = now;
          }
        }
        updated.status = exitCode === 0 ? "completed" : "failed";
        updated.completed_at = now;
        updated.exit_code = exitCode;
        if (exitCode === 0) {
          completedMarked += 1;
        } else {
          failedMarked += 1;
        }
      }
      return updated;
    }
    if (startedIds.has(task.task_id) && (updated.status === "queued" || updated.status === "dispatched")) {
      updated.status = "running";
      updated.started_at = updated.started_at ?? now;
      runningMarked += 1;
    }
    return updated;
  });

  return {
    state: {
      ...state,
      tasks,
    },
    summary: {
      running_marked: runningMarked,
      completed_marked: completedMarked,
      failed_marked: failedMarked,
    },
  };
}

function normalizeTmuxOwnershipScope(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9._/\-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    return null;
  }
  if (normalized === "." || normalized === "./") {
    return "repo-root";
  }
  return normalized;
}

function inferTmuxOwnershipScopeFromCommand(command: string): string | null {
  const normalized = String(command ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const directPath = normalized.match(/(?:^|\s)(src|tests?|docs?|scripts?|cmd|dist|bridges)(?:\/[a-z0-9._-]+)*/i);
  if (directPath?.[1]) {
    return normalizeTmuxOwnershipScope(directPath[0].trim()) ?? null;
  }
  if (/\b(test|pytest|jest|vitest|mocha|coverage)\b/.test(normalized)) {
    return "tests";
  }
  if (/\b(lint|format|prettier|eslint)\b/.test(normalized)) {
    return "quality";
  }
  if (/\b(build|bundle|compile|tsc|webpack|vite)\b/.test(normalized)) {
    return "build";
  }
  return "repo-root";
}

function resolveTmuxTaskOwnershipScope(task: { command: string; metadata?: Record<string, unknown> }): string | null {
  const metadata = task.metadata ?? {};
  const metadataScope = normalizeTmuxOwnershipScope(metadata.ownership_scope);
  if (metadataScope) {
    return metadataScope;
  }
  if (Array.isArray(metadata.ownership_paths)) {
    for (const entry of metadata.ownership_paths) {
      const parsed = normalizeTmuxOwnershipScope(entry);
      if (parsed) {
        return parsed;
      }
    }
  }
  return inferTmuxOwnershipScopeFromCommand(task.command);
}

function isLikelyMutatingTmuxCommand(command: string): boolean {
  const text = String(command ?? "").trim();
  if (!text) {
    return false;
  }
  if (AUTOPILOT_HARD_DENY_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (AUTOPILOT_WRITE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return /\b(touch|mkdir|rm|mv|cp|sed\s+-i|perl\s+-i|tee\b|cat\s+>)/i.test(text);
}

function resolveTmuxTaskOwnershipMode(task: { command: string; metadata?: Record<string, unknown> }): "mutating" | "read_only" {
  const metadata = task.metadata ?? {};
  const rawMode = String(metadata.ownership_mode ?? "").trim().toLowerCase();
  if (rawMode === "mutating" || rawMode === "write" || rawMode === "writer") {
    return "mutating";
  }
  if (rawMode === "read_only" || rawMode === "readonly" || rawMode === "read") {
    return "read_only";
  }
  return isLikelyMutatingTmuxCommand(task.command) ? "mutating" : "read_only";
}

function materializeTmuxInputTasks(
  tasks: TriChatTmuxTaskInput[],
  nextTaskSeq: number,
  defaults: {
    default_thread_id: string | null;
    default_turn_id: string | null;
  }
): {
  tasks: TriChatTmuxControllerTaskRecord[];
  next_task_seq: number;
} {
  let cursor = clampInt(nextTaskSeq, 1, 100_000_000);
  const now = new Date().toISOString();
  const materialized: TriChatTmuxControllerTaskRecord[] = [];
  for (const task of tasks) {
    const seq = cursor++;
    const title = String(task.title ?? "").trim() || `Task ${seq}`;
    const command = String(task.command ?? "").trim();
    if (!command) {
      continue;
    }
    const explicitTaskId = String(task.task_id ?? "").trim();
    const taskId = explicitTaskId
      ? normalizeTmuxTaskId(explicitTaskId)
      : `tmux-${seq}-${autopilotHash(`${title}|${command}|${seq}`).slice(0, 10)}`;
    const metadata = { ...(task.metadata ?? {}) };
    const ownershipScope = resolveTmuxTaskOwnershipScope({
      command,
      metadata,
    });
    if (ownershipScope) {
      metadata.ownership_scope = ownershipScope;
    }
    metadata.ownership_mode = resolveTmuxTaskOwnershipMode({
      command,
      metadata,
    });
    materialized.push({
      task_id: taskId,
      seq,
      title,
      command,
      priority: clampInt(task.priority ?? 50, 1, 100),
      complexity: clampInt(task.complexity ?? 50, 1, 100),
      worker_id: null,
      status: "queued",
      created_at: now,
      dispatched_at: null,
      started_at: null,
      completed_at: null,
      exit_code: null,
      thread_id: task.thread_id?.trim() || defaults.default_thread_id,
      turn_id: task.turn_id?.trim() || defaults.default_turn_id,
      metadata,
    });
  }
  return {
    tasks: materialized,
    next_task_seq: cursor,
  };
}

function assignQueuedTmuxTasks(state: TriChatTmuxControllerStateRecord): TriChatTmuxAssignmentResult {
  const tasks = state.tasks.map((task) => ({ ...task, metadata: { ...(task.metadata ?? {}) } }));
  const workerIds = resolveTmuxWorkerIds(state.worker_count);
  const workerStats = new Map<string, { active_queue: number; active_load: number }>();
  const busyOwnershipScopes = new Set<string>();
  for (const workerId of workerIds) {
    workerStats.set(workerId, { active_queue: 0, active_load: 0 });
  }

  for (const task of tasks) {
    if (!task.worker_id || isTerminalTmuxTaskStatus(task.status)) {
      continue;
    }
    const stats = workerStats.get(task.worker_id);
    if (!stats) {
      continue;
    }
    if (task.status === "queued" || task.status === "dispatched" || task.status === "running") {
      stats.active_queue += 1;
      stats.active_load += task.complexity;
    }
    if (
      (task.status === "dispatched" || task.status === "running") &&
      resolveTmuxTaskOwnershipMode(task) === "mutating"
    ) {
      const ownershipScope = resolveTmuxTaskOwnershipScope(task);
      if (ownershipScope) {
        busyOwnershipScopes.add(ownershipScope);
      }
    }
  }

  const queued = tasks
    .filter((task) => task.status === "queued" && !task.worker_id)
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      if (right.complexity !== left.complexity) {
        return right.complexity - left.complexity;
      }
      return left.seq - right.seq;
    });

  const assigned: TriChatTmuxAssignmentResult["assigned"] = [];
  const unassigned: TriChatTmuxAssignmentResult["unassigned"] = [];

  for (const task of queued) {
    const ownershipMode = resolveTmuxTaskOwnershipMode(task);
    const ownershipScope = resolveTmuxTaskOwnershipScope(task);
    task.metadata = {
      ...(task.metadata ?? {}),
      ownership_mode: ownershipMode,
      ownership_scope: ownershipScope ?? null,
    };
    if (ownershipMode === "mutating" && ownershipScope && busyOwnershipScopes.has(ownershipScope)) {
      unassigned.push({
        task_id: task.task_id,
        reason: `ownership scope busy (${ownershipScope})`,
        priority: task.priority,
        complexity: task.complexity,
        seq: task.seq,
      });
      continue;
    }

    const candidates = workerIds
      .map((workerId) => {
        const stats = workerStats.get(workerId);
        return {
          worker_id: workerId,
          active_queue: stats?.active_queue ?? 0,
          active_load: stats?.active_load ?? 0,
        };
      })
      .filter((entry) => entry.active_queue < state.max_queue_per_worker)
      .sort((left, right) => {
        if (left.active_load !== right.active_load) {
          return left.active_load - right.active_load;
        }
        if (left.active_queue !== right.active_queue) {
          return left.active_queue - right.active_queue;
        }
        return left.worker_id.localeCompare(right.worker_id);
      });

    if (candidates.length === 0) {
      unassigned.push({
        task_id: task.task_id,
        reason: "all workers at max_queue_per_worker",
        priority: task.priority,
        complexity: task.complexity,
        seq: task.seq,
      });
      continue;
    }

    const selected = candidates[0];
    const stats = workerStats.get(selected.worker_id)!;
    stats.active_queue += 1;
    stats.active_load += task.complexity;
    task.worker_id = selected.worker_id;
    if (ownershipMode === "mutating" && ownershipScope) {
      busyOwnershipScopes.add(ownershipScope);
    }
    assigned.push({
      task_id: task.task_id,
      worker_id: selected.worker_id,
      priority: task.priority,
      complexity: task.complexity,
      seq: task.seq,
    });
  }

  return {
    state: {
      ...state,
      tasks: tasks.sort((left, right) => left.seq - right.seq),
    },
    assigned,
    unassigned,
  };
}

function dispatchAssignedTmuxTasks(state: TriChatTmuxControllerStateRecord): TriChatTmuxDispatchResult {
  const tasks = state.tasks.map((task) => ({ ...task, metadata: { ...(task.metadata ?? {}) } }));
  const queue = tasks
    .filter((task): task is TriChatTmuxDispatchTaskRecord => task.status === "queued" && Boolean(task.worker_id))
    .sort((left, right) => left.seq - right.seq);
  const now = new Date().toISOString();
  const dispatched: TriChatTmuxDispatchTaskRecord[] = [];
  const failures: TriChatTmuxDispatchResult["failures"] = [];

  for (const task of queue) {
    const result = dispatchTmuxTask(state.session_name, state.workspace, task.worker_id, task);
    if (result.ok) {
      task.status = "dispatched";
      task.dispatched_at = now;
      task.metadata = {
        ...(task.metadata ?? {}),
        tmux_dispatched_at: now,
      };
      dispatched.push(task);
      continue;
    }
    task.status = "failed";
    task.completed_at = now;
    task.exit_code = result.code;
    task.metadata = {
      ...(task.metadata ?? {}),
      tmux_dispatch_error: result.error ?? "unknown tmux dispatch error",
      tmux_dispatch_stderr: compactConsensusText(result.stderr, 1200),
    };
    failures.push({
      task_id: task.task_id,
      worker_id: task.worker_id,
      error: result.error ?? "unknown tmux dispatch error",
    });
  }

  return {
    state: {
      ...state,
      tasks: tasks.sort((left, right) => left.seq - right.seq),
    },
    dispatched,
    failures,
  };
}

function pruneTmuxTaskHistory(tasks: TriChatTmuxControllerTaskRecord[]): TriChatTmuxControllerTaskRecord[] {
  const active = tasks.filter((task) => !isTerminalTmuxTaskStatus(task.status));
  const terminal = tasks
    .filter((task) => isTerminalTmuxTaskStatus(task.status))
    .sort((left, right) => right.seq - left.seq)
    .slice(0, 500);
  return [...active, ...terminal].sort((left, right) => left.seq - right.seq);
}

function isTerminalTmuxTaskStatus(status: TriChatTmuxControllerTaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function ensureTmuxSession(state: TriChatTmuxControllerStateRecord): void {
  const runtime = getTmuxRuntimeInfo();
  if (!runtime.available) {
    throw new Error(runtime.error ?? "tmux runtime is unavailable");
  }
  if (runtime.dry_run) {
    return;
  }

  fs.mkdirSync(state.workspace, { recursive: true });
  const workerIds = resolveTmuxWorkerIds(state.worker_count);
  const sessionExists = tmuxSessionExists(state.session_name);
  if (!sessionExists) {
    const firstWorker = workerIds[0];
    const create = runTmuxCommand(
      [
        "new-session",
        "-d",
        "-s",
        state.session_name,
        "-c",
        state.workspace,
        "-n",
        firstWorker,
        state.shell,
      ],
      { timeout_ms: 6000 }
    );
    if (!create.ok) {
      throw new Error(create.error ?? `failed to create tmux session ${state.session_name}`);
    }
  }

  const listWindows = runTmuxCommand(
    ["list-windows", "-t", state.session_name, "-F", "#{window_name}"],
    {
      timeout_ms: 5000,
    }
  );
  const existingNames = new Set(
    listWindows.ok
      ? String(listWindows.stdout)
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []
  );
  for (const workerId of workerIds) {
    if (existingNames.has(workerId)) {
      continue;
    }
    const createWindow = runTmuxCommand(
      ["new-window", "-t", state.session_name, "-n", workerId, "-c", state.workspace, state.shell],
      {
        timeout_ms: 5000,
      }
    );
    if (!createWindow.ok) {
      throw new Error(createWindow.error ?? `failed to create tmux window ${workerId}`);
    }
  }
}

function stopTmuxSession(sessionName: string): {
  ok: boolean;
  skipped: boolean;
  error: string | null;
  dry_run: boolean;
} {
  const runtime = getTmuxRuntimeInfo();
  if (!runtime.available) {
    return {
      ok: false,
      skipped: false,
      error: runtime.error ?? "tmux runtime is unavailable",
      dry_run: runtime.dry_run,
    };
  }
  if (runtime.dry_run) {
    return {
      ok: true,
      skipped: false,
      error: null,
      dry_run: true,
    };
  }
  if (!tmuxSessionExists(sessionName)) {
    return {
      ok: true,
      skipped: true,
      error: null,
      dry_run: false,
    };
  }
  const result = runTmuxCommand(["kill-session", "-t", sessionName], {
    timeout_ms: 5000,
  });
  return {
    ok: result.ok,
    skipped: false,
    error: result.ok ? null : result.error ?? (result.stderr || "failed to kill tmux session"),
    dry_run: result.dry_run,
  };
}

function dispatchTmuxTask(
  sessionName: string,
  workspace: string,
  workerId: string,
  task: TriChatTmuxDispatchTaskRecord
): TriChatTmuxCommandResult {
  const protectedDbMatch = commandReferencesProtectedDbArtifact(task.command, {
    repo_root: process.cwd(),
    workspace,
  });
  if (protectedDbMatch.matched) {
    const alias = protectedDbMatch.matched_alias || protectedDbMatch.artifact_path || "protected-db-artifact";
    return {
      ok: false,
      code: 126,
      signal: null,
      stdout: "",
      stderr: "",
      error: `blocked tmux task referencing protected db artifact (${alias})`,
      dry_run: false,
      timed_out: false,
    };
  }
  const wrapped = [
    `echo "${TMUX_TASK_START_MARKER} ${task.task_id}"`,
    task.command,
    "__trichat_ec=$?",
    `echo "${TMUX_TASK_END_MARKER} ${task.task_id} $__trichat_ec"`,
  ].join("; ");
  return runTmuxCommand(["send-keys", "-t", `${sessionName}:${workerId}`, wrapped, "C-m"], {
    timeout_ms: 5000,
  });
}

function captureTmuxPane(
  sessionName: string,
  workerId: string,
  captureLines: number
): TriChatTmuxCommandResult {
  const lines = clampInt(captureLines, 20, 3000);
  return runTmuxCommand(["capture-pane", "-p", "-t", `${sessionName}:${workerId}`, "-S", `-${lines}`], {
    timeout_ms: 5000,
  });
}

function tmuxSessionExists(sessionName: string): boolean {
  const runtime = getTmuxRuntimeInfo();
  if (!runtime.available) {
    return false;
  }
  if (runtime.dry_run) {
    return true;
  }
  const result = runTmuxCommand(["has-session", "-t", sessionName], {
    timeout_ms: 3000,
  });
  return result.ok;
}

function resolveTmuxWorkerIds(workerCount: number): string[] {
  const normalized = clampInt(workerCount, 1, 12);
  return Array.from({ length: normalized }, (_, index) => `worker-${index + 1}`);
}

function getTmuxRuntimeInfo(): {
  available: boolean;
  dry_run: boolean;
  binary: string;
  version: string | null;
  error: string | null;
} {
  const binary = resolveTmuxBinary();
  const dryRun = isTmuxDryRunEnabled();
  if (dryRun) {
    return {
      available: true,
      dry_run: true,
      binary,
      version: "dry-run",
      error: null,
    };
  }
  const versionResult = runTmuxCommand(["-V"], {
    timeout_ms: 3000,
  });
  return {
    available: versionResult.ok,
    dry_run: false,
    binary,
    version: versionResult.ok ? compactConsensusText(versionResult.stdout || "tmux", 120) : null,
    error: versionResult.ok ? null : versionResult.error ?? compactConsensusText(versionResult.stderr, 240),
  };
}

function runTmuxCommand(
  args: string[],
  options?: {
    timeout_ms?: number;
  }
): TriChatTmuxCommandResult {
  const dryRun = isTmuxDryRunEnabled();
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      error: null,
      dry_run: true,
      timed_out: false,
    };
  }

  const command = resolveTmuxBinary();
  const spawned = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options?.timeout_ms ?? 5000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  const stdout = String(spawned.stdout ?? "");
  const stderr = String(spawned.stderr ?? "");
  const timedOut =
    spawned.error?.name === "Error" &&
    /timed out|ETIMEDOUT/i.test(String(spawned.error.message ?? spawned.error));
  const code = typeof spawned.status === "number" ? spawned.status : null;
  const signal = typeof spawned.signal === "string" ? spawned.signal : null;
  const ok = !spawned.error && !timedOut && signal === null && code === 0;
  const error = ok
    ? null
    : spawned.error
      ? spawned.error.message
      : timedOut
        ? "tmux command timed out"
        : `tmux command failed with exit code ${code ?? "unknown"}`;
  return {
    ok,
    code,
    signal,
    stdout,
    stderr,
    error,
    dry_run: false,
    timed_out: timedOut,
  };
}

function resolveTmuxBinary(): string {
  const override = String(process.env.TRICHAT_TMUX_BIN ?? "").trim();
  return override || "tmux";
}

function isTmuxDryRunEnabled(): boolean {
  const raw = String(process.env.TRICHAT_TMUX_DRY_RUN ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function normalizeTmuxTaskId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized) {
    return normalized;
  }
  return `tmux-${autopilotHash(value).slice(0, 12)}`;
}

function buildTmuxDerivedMutation(
  base: { idempotency_key: string; side_effect_fingerprint: string },
  label: string,
  seed: string
) {
  const keyHash = autopilotHash(`${base.idempotency_key}|${label}|${seed}`).slice(0, 32);
  const fingerprintHash = autopilotHash(`${base.side_effect_fingerprint}|${label}|${seed}`).slice(0, 48);
  return {
    idempotency_key: `trichat-tmux-${keyHash}`,
    side_effect_fingerprint: `trichat-tmux-${fingerprintHash}`,
  };
}

function computeTriChatSloMetrics(
  storage: Storage,
  input: {
    window_minutes: number;
    event_limit: number;
    thread_id?: string;
  }
): TriChatSloMetrics {
  const windowMinutes = clampInt(input.window_minutes, 1, 10080);
  const eventLimit = clampInt(input.event_limit, 10, 50000);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const adapterEvents = storage.listTriChatAdapterEventsSince({
    since_iso: sinceIso,
    limit: eventLimit,
  });

  let sampleCount = 0;
  let errorCount = 0;
  const latencies: number[] = [];
  for (const event of adapterEvents) {
    const eventType = String(event.event_type ?? "").trim().toLowerCase();
    const latencyMs = extractLatencyMsFromDetails(event.details);
    const sampleEvent = isAdapterSampleEvent(eventType, latencyMs);
    if (!sampleEvent) {
      continue;
    }
    sampleCount += 1;
    if (latencyMs !== null) {
      latencies.push(latencyMs);
    }
    if (isAdapterErrorEvent(eventType, event.error_text)) {
      errorCount += 1;
    }
  }

  const turnOutcomes = storage.getTriChatTurnOutcomeCountsSince({
    since_iso: sinceIso,
    thread_id: input.thread_id,
  });
  const adapterErrorRate = sampleCount > 0 ? roundRate(errorCount / sampleCount) : 0;
  const turnFailureRate =
    turnOutcomes.total_count > 0 ? roundRate(turnOutcomes.failed_count / turnOutcomes.total_count) : 0;

  return {
    computed_at: new Date().toISOString(),
    thread_id: input.thread_id?.trim() || null,
    window_minutes: windowMinutes,
    since_iso: sinceIso,
    event_limit: eventLimit,
    adapter: {
      sample_count: sampleCount,
      error_count: errorCount,
      error_rate: adapterErrorRate,
      latency_sample_count: latencies.length,
      p95_latency_ms: percentile(latencies, 95),
    },
    turns: {
      total_count: turnOutcomes.total_count,
      failed_count: turnOutcomes.failed_count,
      failure_rate: turnFailureRate,
    },
  };
}

function extractLatencyMsFromDetails(details: Record<string, unknown>): number | null {
  const candidates = [
    details.latency_ms,
    details.duration_ms,
    details.elapsed_ms,
    details.latency,
    details.duration,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Number(parsed);
    }
  }
  return null;
}

function isAdapterSampleEvent(eventType: string, latencyMs: number | null): boolean {
  if (latencyMs !== null) {
    return true;
  }
  return (
    eventType === "response_ok" ||
    eventType === "response_error" ||
    eventType === "handshake_failed" ||
    eventType === "trip_opened"
  );
}

function isAdapterErrorEvent(eventType: string, errorText: string | null): boolean {
  if (eventType === "response_ok") {
    return false;
  }
  if (eventType === "response_error" || eventType === "handshake_failed" || eventType === "trip_opened") {
    return true;
  }
  if (eventType.includes("error") || eventType.includes("failed")) {
    return true;
  }
  return Boolean(String(errorText ?? "").trim());
}

function percentile(samples: number[], percentileRank: number): number | null {
  if (!samples.length) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = clamp(percentileRank / 100, 0, 1);
  const index = Math.max(0, Math.ceil(rank * sorted.length) - 1);
  const value = sorted[index] ?? sorted[sorted.length - 1];
  return Number(value.toFixed(2));
}

function roundRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeIsoTimestamp(value: string | undefined, fallback: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed.toISOString();
}
