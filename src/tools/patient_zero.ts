import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

function ageSeconds(value: string | null | undefined) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - parsed) / 1000);
}

function hasIsoTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeAuthorityChecks(value: unknown) {
  const checks = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const normalized: Record<string, { status: string; detail: string | null }> = {};
  for (const [key, raw] of Object.entries(checks)) {
    const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    normalized[key] = {
      status: String(entry.status ?? "unknown").trim() || "unknown",
      detail: typeof entry.detail === "string" && entry.detail.trim() ? entry.detail.trim() : null,
    };
  }
  return normalized;
}

function buildMacosAuthorityAuditUnavailable(detail: string): MacosAuthorityAuditSnapshot {
  return {
    source: "macos_authority_audit",
    generated_at: new Date().toISOString(),
    applicable: process.platform === "darwin",
    platform: process.platform,
    status: process.platform === "darwin" ? "unavailable" : "skipped",
    ready_for_patient_zero_full_authority: process.platform !== "darwin",
    blockers: process.platform === "darwin" ? ["audit_unavailable"] : [],
    checks: {},
    detail,
  };
}

function normalizeMacosAuthorityAudit(raw: unknown): MacosAuthorityAuditSnapshot {
  const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const platform = typeof payload.platform === "string" && payload.platform.trim() ? payload.platform.trim() : process.platform;
  const skipped = payload.skipped === true || String(payload.reason ?? "").trim() === "not_macos" || platform !== "darwin";
  const checks = normalizeAuthorityChecks(payload.checks);
  if (skipped) {
    return {
      source: "macos_authority_audit",
      generated_at:
        typeof payload.generated_at === "string" && payload.generated_at.trim() ? payload.generated_at : new Date().toISOString(),
      applicable: false,
      platform,
      status: "skipped",
      ready_for_patient_zero_full_authority: true,
      blockers: [],
      checks,
      detail: String(payload.reason ?? "not_macos").trim() || "not_macos",
    };
  }
  const ready = payload.ready_for_patient_zero_full_authority === true;
  const blockers = ready ? [] : normalizeStringArray(payload.blockers);
  return {
    source: "macos_authority_audit",
    generated_at:
      typeof payload.generated_at === "string" && payload.generated_at.trim() ? payload.generated_at : new Date().toISOString(),
    applicable: true,
    platform,
    status: ready ? "ready" : "blocked",
    ready_for_patient_zero_full_authority: ready,
    blockers: blockers.length > 0 ? blockers : ready ? [] : ["authority_unverified"],
    checks,
    detail: ready
      ? "macOS authority prerequisites are fully satisfied."
      : blockers.length > 0
        ? `macOS authority audit blockers=${blockers.join(", ")}`
        : "macOS authority audit reported not-ready without explicit blockers.",
  };
}

function readMacosAuthorityAuditOverride() {
  const raw = process.env.MCP_PATIENT_ZERO_AUTHORITY_AUDIT_JSON;
  if (!raw) {
    return null;
  }
  try {
    return normalizeMacosAuthorityAudit(JSON.parse(raw));
  } catch (error) {
    return buildMacosAuthorityAuditUnavailable(
      `failed to parse MCP_PATIENT_ZERO_AUTHORITY_AUDIT_JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readMacosAuthorityAudit() {
  const override = readMacosAuthorityAuditOverride();
  if (override) {
    return override;
  }
  if (process.platform !== "darwin") {
    return normalizeMacosAuthorityAudit({ skipped: true, reason: "not_macos", platform: process.platform });
  }
  const now = Date.now();
  if (macosAuthorityAuditCache && macosAuthorityAuditCache.expires_at_ms > now) {
    return macosAuthorityAuditCache.value;
  }
  if (!fs.existsSync(MACOS_AUTHORITY_AUDIT_SCRIPT_PATH)) {
    const unavailable = buildMacosAuthorityAuditUnavailable(`authority audit script missing at ${MACOS_AUTHORITY_AUDIT_SCRIPT_PATH}`);
    macosAuthorityAuditCache = {
      expires_at_ms: now + MACOS_AUTHORITY_AUDIT_CACHE_TTL_MS,
      value: unavailable,
    };
    return unavailable;
  }
  const result = spawnSync(process.execPath, [MACOS_AUTHORITY_AUDIT_SCRIPT_PATH, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  let normalized: MacosAuthorityAuditSnapshot;
  if (result.status === 0 && String(result.stdout || "").trim()) {
    try {
      normalized = normalizeMacosAuthorityAudit(JSON.parse(String(result.stdout || "")));
    } catch (error) {
      normalized = buildMacosAuthorityAuditUnavailable(
        `failed to parse macos_authority_audit output: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    const stderr = String(result.stderr || "").trim();
    const spawnError = result.error ? String(result.error.message ?? result.error) : "";
    normalized = buildMacosAuthorityAuditUnavailable(stderr || spawnError || "macos_authority_audit execution failed");
  }
  macosAuthorityAuditCache = {
    expires_at_ms: now + MACOS_AUTHORITY_AUDIT_CACHE_TTL_MS,
    value: normalized,
  };
  return normalized;
}

function readMacosAuthorityAuditCachedOnly() {
  const override = readMacosAuthorityAuditOverride();
  if (override) {
    return override;
  }
  if (process.platform !== "darwin") {
    return normalizeMacosAuthorityAudit({ skipped: true, reason: "not_macos", platform: process.platform });
  }
  const now = Date.now();
  if (macosAuthorityAuditCache && macosAuthorityAuditCache.expires_at_ms > now) {
    return macosAuthorityAuditCache.value;
  }
  return buildMacosAuthorityAuditUnavailable("macOS authority audit not prefetched for this Office snapshot.");
}

const PATIENT_ZERO_TERMINAL_TOOLKIT = ["codex", "claude", "cursor", "gemini", "gh"] as const;
const PATIENT_ZERO_TERMINAL_ALLOWLIST = PATIENT_ZERO_TERMINAL_TOOLKIT.map((entry) => `${entry}`);
const PATIENT_ZERO_BRIDGE_AGENT_IDS = ["codex", "claude", "cursor", "gemini", "github-copilot"] as const;
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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MACOS_AUTHORITY_AUDIT_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "macos_authority_audit.mjs");
const MACOS_AUTHORITY_AUDIT_CACHE_TTL_MS = 120_000;

type MacosAuthorityAuditSnapshot = {
  source: "macos_authority_audit";
  generated_at: string;
  applicable: boolean;
  platform: string;
  status: "ready" | "blocked" | "skipped" | "unavailable";
  ready_for_patient_zero_full_authority: boolean;
  blockers: string[];
  checks: Record<
    string,
    {
      status: string;
      detail: string | null;
    }
  >;
  detail: string;
};

let macosAuthorityAuditCache:
  | {
      expires_at_ms: number;
      value: MacosAuthorityAuditSnapshot;
    }
  | null = null;

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
  const providerBridgeDiagnostics = Array.isArray(maintainState?.provider_bridge_diagnostics)
    ? maintainState.provider_bridge_diagnostics
    : [];
  const configuredIntervalSeconds = Number(maintainState?.interval_seconds ?? maintainRuntime.config.interval_seconds ?? 120);
  const intervalSeconds = Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0 ? configuredIntervalSeconds : 120;
  const providerBridgeGeneratedAt = String(maintainState?.last_provider_bridge_check_at ?? maintainState?.updated_at ?? "").trim() || null;
  const providerBridgeDiagnosticsStale =
    providerBridgeDiagnostics.length === 0 || ageSeconds(providerBridgeGeneratedAt) > Math.max(intervalSeconds * 3, 300);
  const providerBridgeDiagnosticsByAgent = new Map<
    string,
    Array<{
      status: string;
      connected: boolean;
    }>
  >();
  for (const entry of providerBridgeDiagnostics) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const officeAgentId = String(record.office_agent_id ?? "").trim();
    if (!officeAgentId) {
      continue;
    }
    const bucket = providerBridgeDiagnosticsByAgent.get(officeAgentId) ?? [];
    bucket.push({
      status: String(record.status ?? "").trim().toLowerCase(),
      connected: record.connected === true,
    });
    providerBridgeDiagnosticsByAgent.set(officeAgentId, bucket);
  }
  const bridgeToolkit = PATIENT_ZERO_BRIDGE_AGENT_IDS.map((agent_id) => {
    const armed = specialistAgentIds.includes(agent_id);
    const runtimeEntries = providerBridgeDiagnosticsByAgent.get(agent_id) ?? [];
    const runtimeReady =
      armed &&
      !providerBridgeDiagnosticsStale &&
      runtimeEntries.some((entry) => entry.connected || entry.status === "connected");
    const runtimeStatus = !armed
      ? "not-armed"
      : providerBridgeDiagnosticsStale
        ? providerBridgeDiagnostics.length > 0
          ? "stale"
          : "unknown"
        : runtimeEntries.some((entry) => entry.connected || entry.status === "connected")
          ? "connected"
          : runtimeEntries.some((entry) => entry.status === "configured")
            ? "configured"
            : runtimeEntries.some((entry) => entry.status === "disconnected")
              ? "disconnected"
              : runtimeEntries.some((entry) => entry.status === "unavailable")
                ? "unavailable"
                : "unknown";
    return {
      agent_id,
      armed,
      runtime_ready: runtimeReady,
      runtime_status: runtimeStatus,
    };
  });
  const localAgentToolkit = PATIENT_ZERO_LOCAL_AGENT_IDS.map((agent_id) => ({
    agent_id,
    armed: specialistAgentIds.includes(agent_id),
  }));
  const terminalToolkit = PATIENT_ZERO_TERMINAL_TOOLKIT.map((command) => ({
    command,
    armed: commandAllowlist.some((entry) => entry === `${command}` || entry === `${command} `),
  }));
  const bridgeRuntimeReadyCount = bridgeToolkit.filter((entry) => entry.runtime_ready).length;
  const bridgeToolkitConfigured = bridgeToolkit.every((entry) => entry.armed);
  const bridgeRuntimeKnown = !providerBridgeDiagnosticsStale && providerBridgeDiagnostics.length > 0;
  const bridgeToolkitReady = bridgeRuntimeReadyCount > 0;
  const localAgentToolkitReady = localAgentToolkit.every((entry) => entry.armed);
  const terminalToolkitReady = terminalToolkit.every((entry) => entry.armed);
  const maintainDaemonEnabled = Boolean(maintainState?.enabled);
  const autopilotDaemonEnabled = Boolean(autopilot.expected_running);
  const autonomyCoreReady =
    maintainDaemonEnabled &&
    maintainSelfDriveEnabled &&
    autopilotDaemonEnabled &&
    autopilotExecuteEnabled &&
    localAgentToolkitReady &&
    terminalToolkitReady;
  return {
    maintain: {
      daemon_enabled: maintainDaemonEnabled,
      running: Boolean(maintainRuntime.running),
      self_drive_enabled: maintainSelfDriveEnabled,
      last_self_drive_at: maintainState?.last_self_drive_at ?? null,
      last_self_drive_goal_id: maintainState?.last_self_drive_goal_id ?? null,
    },
    autopilot: {
      daemon_enabled: autopilotDaemonEnabled,
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
      bridge_toolkit_configured: bridgeToolkitConfigured,
      bridge_runtime_known: bridgeRuntimeKnown,
      bridge_runtime_ready_count: bridgeRuntimeReadyCount,
      bridge_diagnostics_stale: providerBridgeDiagnosticsStale,
      local_agent_spawn_ready: localAgentToolkitReady,
      terminal_toolkit_ready: terminalToolkitReady,
      imprint_ready: specialistAgentIds.includes("local-imprint"),
      github_cli_ready: commandAllowlist.some((entry) => entry === "gh" || entry === "gh "),
    },
    autonomous_control_enabled: autonomyCoreReady,
  };
}

function evaluateFullControlAuthority(params: {
  summary: ReturnType<typeof summarizePatientZeroState>;
  desktopState: ReturnType<Storage["getDesktopControlState"]>;
  desktopSummary: ReturnType<typeof summarizeDesktopControlState>;
  autonomyControlEnabled: boolean;
  macosAuthorityAudit: MacosAuthorityAuditSnapshot;
}) {
  const desktopLaneHealthy = !params.desktopState.last_error;
  const screenRecordingProven =
    params.desktopSummary.screen_recording_proven === true ||
    (desktopLaneHealthy && hasIsoTimestamp(params.desktopState.last_screenshot_at));
  const accessibilityActuationProven =
    params.desktopSummary.accessibility_actuation_proven === true ||
    (desktopLaneHealthy && hasIsoTimestamp(params.desktopState.last_action_at));
  const microphoneListenProven =
    params.desktopSummary.microphone_listen_proven === true ||
    (desktopLaneHealthy && hasIsoTimestamp(params.desktopState.last_listen_at));
  const liveControlProofsReady =
    params.summary.enabled &&
    params.summary.observe_ready &&
    params.summary.act_ready &&
    params.summary.listen_ready &&
    params.summary.browser_ready &&
    params.summary.root_shell_enabled &&
    screenRecordingProven &&
    accessibilityActuationProven &&
    microphoneListenProven;
  const auditUnavailable =
    params.macosAuthorityAudit.status === "unavailable" ||
    params.macosAuthorityAudit.blockers.includes("audit_unavailable");
  const macosAuthorityAuditReady =
    params.macosAuthorityAudit.ready_for_patient_zero_full_authority ||
    (auditUnavailable && liveControlProofsReady);
  const proofs = {
    screen_recording_proven: screenRecordingProven,
    accessibility_actuation_proven: accessibilityActuationProven,
    microphone_listen_proven: microphoneListenProven,
    macos_authority_audit_ready: macosAuthorityAuditReady,
    macos_authority_audit_status: params.macosAuthorityAudit.status,
    macos_authority_audit_satisfied_by_live_proofs:
      !params.macosAuthorityAudit.ready_for_patient_zero_full_authority && macosAuthorityAuditReady,
  };
  const blockers: string[] = [];
  if (!params.summary.enabled) {
    blockers.push("patient_zero_disarmed");
  }
  if (!params.summary.observe_ready) {
    blockers.push("desktop_observe_lane_not_ready");
  }
  if (!params.summary.act_ready) {
    blockers.push("desktop_act_lane_not_ready");
  }
  if (!params.summary.listen_ready) {
    blockers.push("desktop_listen_lane_not_ready");
  }
  if (!proofs.screen_recording_proven) {
    blockers.push("screen_recording_unproven");
  }
  if (!proofs.accessibility_actuation_proven) {
    blockers.push("accessibility_actuation_unproven");
  }
  if (!proofs.microphone_listen_proven) {
    blockers.push("microphone_listen_unproven");
  }
  if (!params.summary.browser_ready) {
    blockers.push("browser_lane_not_ready");
  }
  if (!params.summary.root_shell_enabled) {
    blockers.push("root_shell_not_ready");
  }
  if (!params.autonomyControlEnabled) {
    blockers.push("autonomy_control_not_ready");
  }
  if (params.macosAuthorityAudit.applicable && !macosAuthorityAuditReady) {
    for (const blocker of params.macosAuthorityAudit.blockers) {
      blockers.push(`macos_authority_${blocker}`);
    }
  }
  return {
    full_control_authority: blockers.length === 0,
    blockers,
    proofs,
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

function buildPatientZeroReportFromAudit(storage: Storage, macosAuthorityAudit: MacosAuthorityAuditSnapshot) {
  const state = storage.getPatientZeroState();
  const desktopState = storage.getDesktopControlState();
  const desktopSummary = summarizeDesktopControlState(desktopState);
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const summary = summarizePatientZeroState(state, desktopState, privilegedAccess.summary as Record<string, unknown>);
  const autonomyControl = buildAutonomyControlStatus(storage);
  const authority = evaluateFullControlAuthority({
    summary,
    desktopState,
    desktopSummary,
    autonomyControlEnabled: autonomyControl.autonomous_control_enabled,
    macosAuthorityAudit,
  });
  const fullControlAuthority = authority.full_control_authority;
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
    `Toolkit: bridge ${autonomyControl.toolkit.bridge_toolkit_ready ? "runtime-ready" : autonomyControl.toolkit.bridge_runtime_known ? "runtime-partial" : "runtime-unknown"} · local-agents ${autonomyControl.toolkit.local_agent_spawn_ready ? "ready" : "partial"} · terminal ${autonomyControl.toolkit.terminal_toolkit_ready ? "ready" : "partial"} · imprint ${autonomyControl.toolkit.imprint_ready ? "ready" : "off"}`,
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
      ? `Full-control posture is armed, but blockers=${authority.blockers.join(", ")}.`
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
    authority_blockers: authority.blockers,
    authority_proofs: authority.proofs,
    macos_authority_audit: macosAuthorityAudit,
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

export function buildPatientZeroReport(storage: Storage, macosAuthorityAudit = readMacosAuthorityAudit()) {
  return buildPatientZeroReportFromAudit(storage, macosAuthorityAudit);
}

export function buildPatientZeroOfficeReport(storage: Storage, macosAuthorityAudit = readMacosAuthorityAuditCachedOnly()) {
  return buildPatientZeroReportFromAudit(storage, macosAuthorityAudit);
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
  const desktopSummary = summarizeDesktopControlState(desktopState);
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const autonomyControl = buildAutonomyControlStatus(storage);
  const summary = summarizePatientZeroState(state, desktopState, privilegedAccess.summary as Record<string, unknown>);
  const macosAuthorityAudit = readMacosAuthorityAudit();
  const authority = evaluateFullControlAuthority({
    summary,
    desktopState,
    desktopSummary,
    autonomyControlEnabled: autonomyControl.autonomous_control_enabled,
    macosAuthorityAudit,
  });
  return {
    state,
    summary: {
      ...summary,
      autonomous_control_enabled: autonomyControl.autonomous_control_enabled,
      full_control_authority: authority.full_control_authority,
      authority_blockers: authority.blockers,
      authority_proofs: authority.proofs,
      macos_authority_audit_status: macosAuthorityAudit.status,
      macos_authority_ready: authority.proofs.macos_authority_audit_ready,
    },
    desktop_control: {
      state: desktopState,
      summary: desktopSummary,
    },
    autonomy_control: autonomyControl,
    privileged_access: privilegedAccess,
    report: buildPatientZeroReport(storage, macosAuthorityAudit),
    macos_authority_audit: macosAuthorityAudit,
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
