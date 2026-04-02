import type { DesktopControlStateRecord } from "./desktop_control_plane.js";

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

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function formatRootReason(fallback: string, privilegedSummary: Record<string, unknown>) {
  if (readBoolean(privilegedSummary["root_execution_ready"])) {
    const account = readString(privilegedSummary["account"]) ?? "mcagent";
    return `Privileged root lane ready via ${account}.`;
  }
  const blockers = Array.isArray(privilegedSummary["blockers"]) ? (privilegedSummary["blockers"] as unknown[]) : [];
  if (!blockers.length) {
    return fallback;
  }
  return blockers
    .map((entry) =>
      String(entry)
        .replace(/_/g, " ")
        .trim()
    )
    .join(", ");
}

export type PatientZeroStateRecord = {
  enabled: boolean;
  permission_profile: "high_risk";
  autonomy_enabled: boolean;
  allow_observe: boolean;
  allow_act: boolean;
  allow_listen: boolean;
  browser_app: string;
  web_research_mode: "explicit_task_only";
  root_shell_enabled: boolean;
  root_shell_reason: string;
  report_mode: "operator_visible_summary";
  audit_required: boolean;
  armed_at: string | null;
  armed_by: string | null;
  disarmed_at: string | null;
  disarmed_by: string | null;
  last_operator_note: string | null;
  updated_at: string | null;
  source: "default" | "persisted";
};

export function getDefaultPatientZeroState(): PatientZeroStateRecord {
  return {
    enabled: false,
    permission_profile: "high_risk",
    autonomy_enabled: false,
    allow_observe: true,
    allow_act: true,
    allow_listen: true,
    browser_app: "Safari",
    web_research_mode: "explicit_task_only",
    root_shell_enabled: false,
    root_shell_reason: "Root escalation is never auto-granted; keep OS elevation explicit and operator-mediated.",
    report_mode: "operator_visible_summary",
    audit_required: true,
    armed_at: null,
    armed_by: null,
    disarmed_at: null,
    disarmed_by: null,
    last_operator_note: null,
    updated_at: null,
    source: "default",
  };
}

export function normalizePatientZeroState(value: unknown, updatedAt: string | null): PatientZeroStateRecord {
  const base = getDefaultPatientZeroState();
  const input = isRecord(value) ? value : {};
  return {
    enabled: readBoolean(input.enabled, base.enabled),
    permission_profile: "high_risk",
    autonomy_enabled: readBoolean(input.autonomy_enabled, base.autonomy_enabled),
    allow_observe: readBoolean(input.allow_observe, base.allow_observe),
    allow_act: readBoolean(input.allow_act, base.allow_act),
    allow_listen: readBoolean(input.allow_listen, base.allow_listen),
    browser_app: readString(input.browser_app) ?? base.browser_app,
    web_research_mode: "explicit_task_only",
    root_shell_enabled: false,
    root_shell_reason: readString(input.root_shell_reason) ?? base.root_shell_reason,
    report_mode: "operator_visible_summary",
    audit_required: readBoolean(input.audit_required, base.audit_required),
    armed_at: readString(input.armed_at),
    armed_by: readString(input.armed_by),
    disarmed_at: readString(input.disarmed_at),
    disarmed_by: readString(input.disarmed_by),
    last_operator_note: readString(input.last_operator_note),
    updated_at: updatedAt,
    source: updatedAt ? "persisted" : "default",
  };
}

export function summarizePatientZeroState(
  state: PatientZeroStateRecord,
  desktopControl?: DesktopControlStateRecord | Record<string, unknown> | null,
  privilegedAccess?: Record<string, unknown> | null
) {
  const desktopSummary: Record<string, unknown> = isRecord(desktopControl)
    ? (desktopControl as Record<string, unknown>)
    : {};
  const privilegedSummary = isRecord(privilegedAccess) ? privilegedAccess : {};
  const capabilityProbe = isRecord(desktopSummary["capability_probe"]) ? desktopSummary["capability_probe"] : {};
  const observeSignal = readBoolean(desktopSummary["observe_ready"], readBoolean(capabilityProbe["can_observe"]));
  const actSignal = readBoolean(desktopSummary["act_ready"], readBoolean(capabilityProbe["can_act"]));
  const listenSignal = readBoolean(desktopSummary["listen_ready"], readBoolean(capabilityProbe["can_listen"]));
  const observeReady =
    state.enabled &&
    state.allow_observe &&
    readBoolean(desktopSummary["allow_observe"], true) &&
    observeSignal;
  const actReady =
    state.enabled &&
    state.allow_act &&
    readBoolean(desktopSummary["allow_act"], true) &&
    actSignal;
  const listenReady =
    state.enabled &&
    state.allow_listen &&
    listenSignal;
  return {
    enabled: state.enabled,
    posture: state.enabled ? "armed" : "standby",
    severity: state.enabled ? "critical" : "controlled",
    permission_profile: state.permission_profile,
    autonomy_enabled: state.autonomy_enabled,
    observe_ready: observeReady,
    act_ready: actReady,
    listen_ready: listenReady,
    browser_app: state.browser_app,
    browser_ready: actReady,
    web_research_mode: state.web_research_mode,
    root_shell_enabled: readBoolean(privilegedSummary["root_execution_ready"], state.root_shell_enabled),
    root_shell_reason: formatRootReason(state.root_shell_reason, privilegedSummary),
    audit_required: state.audit_required,
    report_mode: state.report_mode,
    armed_at: state.armed_at,
    armed_by: state.armed_by,
    disarmed_at: state.disarmed_at,
    disarmed_by: state.disarmed_by,
    last_operator_note: state.last_operator_note,
  };
}
