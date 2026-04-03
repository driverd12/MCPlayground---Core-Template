import { z } from "zod";
import { summarizeDesktopControlState } from "../desktop_control_plane.js";
import { summarizePatientZeroState } from "../patient_zero_plane.js";
import { Storage } from "../storage.js";
import { getTriChatActiveAgentIds } from "../trichat_roster.js";
import { autonomyMaintain, getAutonomyMaintainRuntimeStatus } from "./autonomy_maintain.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { buildPrivilegedAccessStatus, verifyPrivilegedAccess } from "./privileged_exec.js";
import { getAutopilotStatus, trichatAutopilotControl } from "./trichat.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const patientZeroSchema = z
  .object({
    action: z.enum(["status", "enable", "disable", "report"]).default("status"),
    mutation: mutationSchema.optional(),
    operator_note: z.string().min(1).max(1000).optional(),
    source_client: sourceSchema.shape.source_client,
    source_model: sourceSchema.shape.source_model,
    source_agent: sourceSchema.shape.source_agent,
  })
  .superRefine((value, ctx) => {
    if ((value.action === "enable" || value.action === "disable") && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=enable and action=disable",
        path: ["mutation"],
      });
    }
  });

function compactText(value: string, limit = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function startOfTodayIso() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

function actorLabel(input: z.infer<typeof patientZeroSchema>) {
  return String(input.source_agent || input.source_client || "operator").trim() || "operator";
}

const PATIENT_ZERO_TERMINAL_TOOLKIT = ["codex", "cursor", "gemini", "gh"] as const;
const PATIENT_ZERO_TERMINAL_ALLOWLIST = PATIENT_ZERO_TERMINAL_TOOLKIT.map((entry) => `${entry}`);
const PATIENT_ZERO_BRIDGE_AGENT_IDS = ["codex", "cursor", "gemini", "github-copilot", "local-imprint"] as const;
const PATIENT_ZERO_LOCAL_AGENT_IDS = [
  "implementation-director",
  "research-director",
  "verification-director",
  "code-smith",
  "research-scout",
  "quality-guard",
  "local-imprint",
] as const;
const PATIENT_ZERO_SPECIALIST_AGENT_IDS = [
  ...new Set([...PATIENT_ZERO_BRIDGE_AGENT_IDS, ...PATIENT_ZERO_LOCAL_AGENT_IDS, ...getTriChatActiveAgentIds()].filter(Boolean)),
];

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, phase: string) {
  const safePhase = phase.replace(/[^a-z0-9._:-]+/gi, "-");
  return {
    idempotency_key: `${base.idempotency_key}:${safePhase}`,
    side_effect_fingerprint: `${base.side_effect_fingerprint}:${safePhase}`,
  };
}

function buildAutonomyControlStatus(storage: Storage) {
  const maintainState = storage.getAutonomyMaintainState();
  const maintainRuntime = getAutonomyMaintainRuntimeStatus();
  const autopilot = getAutopilotStatus(storage);
  const maintainSelfDriveEnabled = Boolean(
    maintainState?.enable_self_drive ?? maintainRuntime.config.enable_self_drive
  );
  const autopilotExecuteEnabled = Boolean(autopilot.config.execute_enabled);
  const specialistAgentIds = Array.isArray(autopilot.config.specialist_agent_ids)
    ? autopilot.config.specialist_agent_ids.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const commandAllowlist = Array.isArray(autopilot.config.command_allowlist)
    ? autopilot.config.command_allowlist.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const bridgeToolkit = PATIENT_ZERO_BRIDGE_AGENT_IDS.map((agent_id) => ({
    agent_id,
    armed: specialistAgentIds.includes(agent_id),
  }));
  const localAgentToolkit = PATIENT_ZERO_LOCAL_AGENT_IDS.map((agent_id) => ({
    agent_id,
    armed: specialistAgentIds.includes(agent_id),
  }));
  const terminalToolkit = PATIENT_ZERO_TERMINAL_TOOLKIT.map((command) => ({
    command,
    armed: commandAllowlist.some((entry) => entry === `${command}` || entry === `${command} `),
  }));
  const bridgeToolkitReady = bridgeToolkit.every((entry) => entry.armed);
  const localAgentToolkitReady = localAgentToolkit.every((entry) => entry.armed);
  const terminalToolkitReady = terminalToolkit.every((entry) => entry.armed);
  return {
    maintain: {
      daemon_enabled: Boolean(maintainState?.enabled),
      running: Boolean(maintainRuntime.running),
      self_drive_enabled: maintainSelfDriveEnabled,
      last_self_drive_at: maintainState?.last_self_drive_at ?? null,
      last_self_drive_goal_id: maintainState?.last_self_drive_goal_id ?? null,
    },
    autopilot: {
      daemon_enabled: Boolean(autopilot.expected_running),
      running: Boolean(autopilot.running),
      execute_enabled: autopilotExecuteEnabled,
      away_mode: String(autopilot.config.away_mode ?? "normal"),
      thread_id: String(autopilot.config.thread_id ?? ""),
      lead_agent_id: String(autopilot.config.lead_agent_id ?? "ring-leader"),
      specialist_agent_ids: specialistAgentIds,
      command_allowlist: commandAllowlist,
    },
    toolkit: {
      bridge_agents: bridgeToolkit,
      local_agents: localAgentToolkit,
      terminal_commands: terminalToolkit,
      bridge_toolkit_ready: bridgeToolkitReady,
      local_agent_spawn_ready: localAgentToolkitReady,
      terminal_toolkit_ready: terminalToolkitReady,
      imprint_ready: specialistAgentIds.includes("local-imprint"),
      github_cli_ready: commandAllowlist.some((entry) => entry === "gh" || entry === "gh "),
    },
    autonomous_control_enabled:
      maintainSelfDriveEnabled &&
      autopilotExecuteEnabled &&
      bridgeToolkitReady &&
      localAgentToolkitReady &&
      terminalToolkitReady,
  };
}

function setPersistedMaintainSelfDrive(storage: Storage, enabled: boolean) {
  const current = storage.getAutonomyMaintainState();
  if (!current) {
    return null;
  }
  return storage.setAutonomyMaintainState({
    enabled: current.enabled,
    local_host_id: current.local_host_id,
    interval_seconds: current.interval_seconds,
    learning_review_interval_seconds: current.learning_review_interval_seconds,
    enable_self_drive: enabled,
    self_drive_cooldown_seconds: current.self_drive_cooldown_seconds,
    run_eval_if_due: current.run_eval_if_due,
    eval_interval_seconds: current.eval_interval_seconds,
    eval_suite_id: current.eval_suite_id,
    minimum_eval_score: current.minimum_eval_score,
    last_run_at: current.last_run_at,
    last_bootstrap_ready_at: current.last_bootstrap_ready_at,
    last_goal_autorun_daemon_at: current.last_goal_autorun_daemon_at,
    last_tmux_maintained_at: current.last_tmux_maintained_at,
    last_learning_review_at: current.last_learning_review_at,
    last_learning_entry_count: current.last_learning_entry_count,
    last_learning_active_agent_count: current.last_learning_active_agent_count,
    last_eval_run_at: current.last_eval_run_at,
    last_eval_run_id: current.last_eval_run_id,
    last_eval_score: current.last_eval_score,
    last_eval_dependency_fingerprint: current.last_eval_dependency_fingerprint,
    last_observability_ship_at: current.last_observability_ship_at,
    last_provider_bridge_check_at: current.last_provider_bridge_check_at,
    provider_bridge_diagnostics: current.provider_bridge_diagnostics,
    last_self_drive_at: current.last_self_drive_at,
    last_self_drive_goal_id: current.last_self_drive_goal_id,
    last_self_drive_fingerprint: current.last_self_drive_fingerprint,
    last_actions: current.last_actions,
    last_attention: current.last_attention,
    last_error: current.last_error,
  });
}

function setPersistedAutopilotExecute(storage: Storage, enabled: boolean) {
  const current = storage.getTriChatAutopilotState();
  if (!current) {
    return null;
  }
  return storage.setTriChatAutopilotState({
    enabled: current.enabled,
    away_mode: current.away_mode,
    interval_seconds: current.interval_seconds,
    thread_id: current.thread_id,
    thread_title: current.thread_title,
    thread_status: current.thread_status,
    objective: current.objective,
    lead_agent_id: current.lead_agent_id,
    specialist_agent_ids: current.specialist_agent_ids,
    max_rounds: current.max_rounds,
    min_success_agents: current.min_success_agents,
    bridge_timeout_seconds: current.bridge_timeout_seconds,
    bridge_dry_run: current.bridge_dry_run,
    execute_enabled: enabled,
    command_allowlist: current.command_allowlist,
    execute_backend: current.execute_backend,
    tmux_session_name: current.tmux_session_name,
    tmux_worker_count: current.tmux_worker_count,
    tmux_max_queue_per_worker: current.tmux_max_queue_per_worker,
    tmux_auto_scale_workers: current.tmux_auto_scale_workers,
    tmux_sync_after_dispatch: current.tmux_sync_after_dispatch,
    confidence_threshold: current.confidence_threshold,
    max_consecutive_errors: current.max_consecutive_errors,
    lock_key: current.lock_key,
    lock_lease_seconds: current.lock_lease_seconds,
    adr_policy: current.adr_policy,
    pause_reason: current.pause_reason,
  });
}

async function syncAutonomyControl(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof patientZeroSchema>,
  enabled: boolean
) {
  const warnings: string[] = [];
  const maintainState = storage.getAutonomyMaintainState();
  const maintainRuntime = getAutonomyMaintainRuntimeStatus();
  const autopilotStatus = getAutopilotStatus(storage);
  const autopilotState = storage.getTriChatAutopilotState();
  const source_client = input.source_client ?? "patient.zero";
  const source_agent = input.source_agent ?? "operator";
  const source_model = input.source_model;

  try {
    if (enabled) {
      await autonomyMaintain(storage, invokeTool, {
          action: "start",
          mutation: deriveMutation(input.mutation!, "autonomy.maintain.start"),
          enable_self_drive: true,
          run_immediately: false,
          source_client,
          source_agent,
          source_model,
        } as any);
    } else if (maintainRuntime.running || maintainState?.enabled) {
      await autonomyMaintain(storage, invokeTool, {
          action: "start",
          mutation: deriveMutation(input.mutation!, "autonomy.maintain.advisory"),
          enable_self_drive: false,
          run_immediately: false,
          source_client,
          source_agent,
          source_model,
        } as any);
    } else {
      setPersistedMaintainSelfDrive(storage, false);
    }
  } catch (error) {
    warnings.push(`autonomy.maintain: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (enabled) {
      const currentAutopilotStatus = getAutopilotStatus(storage);
      const specialistAgentIds = [
        ...new Set([
          ...((Array.isArray(currentAutopilotStatus.config.specialist_agent_ids)
            ? currentAutopilotStatus.config.specialist_agent_ids
            : []) as string[]),
          ...PATIENT_ZERO_SPECIALIST_AGENT_IDS,
        ]),
      ];
      const commandAllowlist = [
        ...new Set([
          ...((Array.isArray(currentAutopilotStatus.config.command_allowlist)
            ? currentAutopilotStatus.config.command_allowlist
            : []) as string[]),
          ...PATIENT_ZERO_TERMINAL_ALLOWLIST,
        ]),
      ];
      await trichatAutopilotControl(storage, invokeTool, {
          action: "start",
          mutation: deriveMutation(input.mutation!, "trichat.autopilot.start"),
          execute_enabled: true,
          lead_agent_id: String(currentAutopilotStatus.config.lead_agent_id ?? "ring-leader"),
          specialist_agent_ids: specialistAgentIds,
          command_allowlist: commandAllowlist,
          run_immediately: false,
        });
      const postSyncState = storage.getTriChatAutopilotState();
      if (
        postSyncState &&
        (!buildAutonomyControlStatus(storage).toolkit.terminal_toolkit_ready ||
          !buildAutonomyControlStatus(storage).toolkit.local_agent_spawn_ready)
      ) {
        storage.setTriChatAutopilotState({
          enabled: postSyncState.enabled,
          away_mode: postSyncState.away_mode,
          interval_seconds: postSyncState.interval_seconds,
          thread_id: postSyncState.thread_id,
          thread_title: postSyncState.thread_title,
          thread_status: postSyncState.thread_status,
          objective: postSyncState.objective,
          lead_agent_id: postSyncState.lead_agent_id,
          specialist_agent_ids: specialistAgentIds,
          max_rounds: postSyncState.max_rounds,
          min_success_agents: postSyncState.min_success_agents,
          bridge_timeout_seconds: postSyncState.bridge_timeout_seconds,
          bridge_dry_run: postSyncState.bridge_dry_run,
          execute_enabled: true,
          command_allowlist: commandAllowlist,
          execute_backend: postSyncState.execute_backend,
          tmux_session_name: postSyncState.tmux_session_name,
          tmux_worker_count: postSyncState.tmux_worker_count,
          tmux_max_queue_per_worker: postSyncState.tmux_max_queue_per_worker,
          tmux_auto_scale_workers: postSyncState.tmux_auto_scale_workers,
          tmux_sync_after_dispatch: postSyncState.tmux_sync_after_dispatch,
          confidence_threshold: postSyncState.confidence_threshold,
          max_consecutive_errors: postSyncState.max_consecutive_errors,
          lock_key: postSyncState.lock_key,
          lock_lease_seconds: postSyncState.lock_lease_seconds,
          adr_policy: postSyncState.adr_policy,
          pause_reason: null,
        });
      }
    } else if (autopilotStatus.running || autopilotState?.enabled) {
      await trichatAutopilotControl(storage, invokeTool, {
          action: "start",
          mutation: deriveMutation(input.mutation!, "trichat.autopilot.advisory"),
          execute_enabled: false,
          run_immediately: false,
        });
    } else {
      setPersistedAutopilotExecute(storage, false);
    }
  } catch (error) {
    warnings.push(`trichat.autopilot: ${error instanceof Error ? error.message : String(error)}`);
  }

  return warnings;
}

export function buildPatientZeroReport(storage: Storage) {
  const state = storage.getPatientZeroState();
  const desktopState = storage.getDesktopControlState();
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const summary = summarizePatientZeroState(state, desktopState, privilegedAccess.summary as Record<string, unknown>);
  const autonomyControl = buildAutonomyControlStatus(storage);
  const fullControlAuthority =
    summary.enabled &&
    summary.observe_ready &&
    summary.act_ready &&
    summary.listen_ready &&
    summary.browser_ready &&
    summary.root_shell_enabled &&
    autonomyControl.autonomous_control_enabled;
  const since = startOfTodayIso();
  const events = storage.listRuntimeEvents({ since, limit: 8 });
  const eventSummary = storage.summarizeRuntimeEvents({ since });
  const todayErrorCount =
    eventSummary.event_type_counts.find((entry) => /error|failed|blocked/i.test(String(entry.event_type || "")))?.count ?? 0;
  const runningTasks = storage.listTasks({ status: "running", limit: 4 });
  const pendingTasks = storage.listTasks({ status: "pending", limit: 4 });
  const autopilot = storage.getTriChatAutopilotState();
  const lastSelfDriveAt = autonomyControl.maintain.last_self_drive_at;
  const lastSelfDriveGoalId = autonomyControl.maintain.last_self_drive_goal_id;

  const recentActivity = [
    `Autonomy: ${autonomyControl.autonomous_control_enabled ? "armed" : "advisory only"} · self-drive ${autonomyControl.maintain.self_drive_enabled ? "on" : "off"} · autopilot exec ${autonomyControl.autopilot.execute_enabled ? "on" : "off"}`,
    `Toolkit: bridge ${autonomyControl.toolkit.bridge_toolkit_ready ? "ready" : "partial"} · local-agents ${autonomyControl.toolkit.local_agent_spawn_ready ? "ready" : "partial"} · terminal ${autonomyControl.toolkit.terminal_toolkit_ready ? "ready" : "partial"} · imprint ${autonomyControl.toolkit.imprint_ready ? "ready" : "off"}`,
    ...(lastSelfDriveAt || lastSelfDriveGoalId
      ? [
          `Ingress: last autonomous mission ${compactText(
            [lastSelfDriveGoalId, lastSelfDriveAt].filter(Boolean).join(" · "),
            92
          )}`,
        ]
      : []),
    ...runningTasks.map((task) => `Running: ${compactText(task.objective || task.task_id, 92)}`),
    ...pendingTasks.slice(0, Math.max(0, 3 - runningTasks.length)).map((task) => `Queued: ${compactText(task.objective || task.task_id, 92)}`),
    ...events
      .slice(-3)
      .map((event) => `${event.event_type}: ${compactText(String(event.summary || event.content || "runtime event"), 92)}`),
  ].slice(0, 6);

  const stance = summary.enabled
    ? fullControlAuthority
      ? "Armed for operator-authorized full local control across desktop, browser, root, and autonomous execution lanes."
      : "Armed for operator-authorized high-risk local control, but one or more requested execution lanes are not fully ready yet."
    : "Standing by in bounded autonomy mode until an operator explicitly arms elevated local control.";
  const priorityPull =
    runningTasks[0]?.objective ??
    autopilot?.objective ??
    (lastSelfDriveGoalId ? `Continue autonomous ingress goal ${lastSelfDriveGoalId}.` : null) ??
    "Keep the local control plane truthful, bounded, and ready for the next delegated objective.";
  const concern =
    !fullControlAuthority && summary.enabled
      ? `Full-control posture is armed, but autonomy=${autonomyControl.autonomous_control_enabled ? "ready" : "not-ready"}, toolkit=${autonomyControl.toolkit.bridge_toolkit_ready && autonomyControl.toolkit.local_agent_spawn_ready && autonomyControl.toolkit.terminal_toolkit_ready ? "ready" : "not-ready"}, and root=${summary.root_shell_enabled ? "ready" : "not-ready"}.`
      : todayErrorCount > 0
      ? `Recent runtime errors detected today: ${todayErrorCount} event(s).`
      : desktopState.last_error
        ? `Desktop control reported a recent error: ${compactText(desktopState.last_error, 96)}`
        : "No fresh runtime error spike is visible in today’s event feed.";
  const desire = summary.enabled
    ? fullControlAuthority
      ? "Carry delegated work from start to finish with visible audit trails, bounded execution records, and clean operator hand-back."
      : "Finish bringing every requested execution lane online without overstating current authority."
    : "Stay ready, keep the evidence trail tight, and avoid pretending to have authority that was not explicitly armed.";

  return {
    generated_at: new Date().toISOString(),
    scope_notice:
      "Operator-facing self-report only. This is a compact operational summary, not hidden chain-of-thought or unrestricted root authority.",
    stance,
    priority_pull: priorityPull,
    concern,
    desire,
    autonomous_control_enabled: autonomyControl.autonomous_control_enabled,
    full_control_authority: fullControlAuthority,
    toolkit: autonomyControl.toolkit,
    activity_count: events.length,
    activity_summary: recentActivity,
    latest_runtime_events: events.slice(-5).map((event) => ({
      event_type: event.event_type,
      status: event.status,
      summary: compactText(String(event.summary || event.content || event.event_type), 120),
      created_at: event.created_at,
    })),
  };
}

function recordPatientZeroEvent(
  storage: Storage,
  input: z.infer<typeof patientZeroSchema>,
  action: "enabled" | "disabled",
  details: Record<string, unknown>
) {
  storage.appendRuntimeEvent({
    event_type: `patient.zero.${action}`,
    entity_type: "daemon",
    entity_id: "patient.zero",
    status: action === "enabled" ? "warning" : "ok",
    summary: `Patient Zero ${action} by ${actorLabel(input)}`,
    details,
    source_client: input.source_client ?? "patient.zero",
    source_model: input.source_model,
    source_agent: input.source_agent ?? "operator",
  });
}

function buildPayload(storage: Storage) {
  const state = storage.getPatientZeroState();
  const desktopState = storage.getDesktopControlState();
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const autonomyControl = buildAutonomyControlStatus(storage);
  const summary = summarizePatientZeroState(state, desktopState, privilegedAccess.summary as Record<string, unknown>);
  return {
    state,
    summary: {
      ...summary,
      autonomous_control_enabled: autonomyControl.autonomous_control_enabled,
      full_control_authority:
        summary.enabled &&
        summary.observe_ready &&
        summary.act_ready &&
        summary.listen_ready &&
        summary.browser_ready &&
        summary.root_shell_enabled &&
        autonomyControl.autonomous_control_enabled,
    },
    desktop_control: {
      state: desktopState,
      summary: summarizeDesktopControlState(desktopState),
    },
    autonomy_control: autonomyControl,
    privileged_access: privilegedAccess,
    report: buildPatientZeroReport(storage),
    source: "patient.zero",
  };
}

export async function patientZeroControl(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof patientZeroSchema>
) {
  if (input.action === "status" || input.action === "report") {
    return buildPayload(storage);
  }

  return runIdempotentMutation({
    storage,
    tool_name: "patient.zero",
    mutation: input.mutation!,
    payload: input,
    execute: async () => {
      const now = new Date().toISOString();
      const note = input.operator_note?.trim() || null;
      if (input.action === "enable") {
        const state = storage.setPatientZeroState({
          enabled: true,
          autonomy_enabled: true,
          armed_at: now,
          armed_by: actorLabel(input),
          disarmed_at: null,
          disarmed_by: null,
          last_operator_note: note,
        });
        const desktopState = storage.setDesktopControlState({
          enabled: true,
          allow_observe: true,
          allow_act: true,
          allow_listen: true,
          last_error: null,
        });
        const syncWarnings = await syncAutonomyControl(storage, invokeTool, input, true);
        recordPatientZeroEvent(storage, input, "enabled", {
          permission_profile: state.permission_profile,
          desktop_control_enabled: desktopState.enabled,
          allow_observe: desktopState.allow_observe,
          allow_act: desktopState.allow_act,
          allow_listen: desktopState.allow_listen,
          autonomy_enabled: state.autonomy_enabled,
          autonomy_sync_warnings: syncWarnings,
          operator_note: note,
        });
        verifyPrivilegedAccess(storage, input);
        return buildPayload(storage);
      }

      const state = storage.setPatientZeroState({
        enabled: false,
        autonomy_enabled: false,
        disarmed_at: now,
        disarmed_by: actorLabel(input),
        last_operator_note: note,
      });
      const desktopState = storage.setDesktopControlState({
        enabled: false,
        allow_observe: false,
        allow_act: false,
        allow_listen: false,
      });
      const syncWarnings = await syncAutonomyControl(storage, invokeTool, input, false);
      recordPatientZeroEvent(storage, input, "disabled", {
        permission_profile: state.permission_profile,
        desktop_control_enabled: desktopState.enabled,
        autonomy_enabled: state.autonomy_enabled,
        autonomy_sync_warnings: syncWarnings,
        operator_note: note,
      });
      return buildPayload(storage);
    },
  });
}
