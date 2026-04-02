import { z } from "zod";
import { summarizeDesktopControlState } from "../desktop_control_plane.js";
import { summarizePatientZeroState } from "../patient_zero_plane.js";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { buildPrivilegedAccessStatus } from "./privileged_exec.js";

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

export function buildPatientZeroReport(storage: Storage) {
  const state = storage.getPatientZeroState();
  const desktopState = storage.getDesktopControlState();
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const summary = summarizePatientZeroState(state, desktopState, privilegedAccess.summary as Record<string, unknown>);
  const since = startOfTodayIso();
  const events = storage.listRuntimeEvents({ since, limit: 8 });
  const eventSummary = storage.summarizeRuntimeEvents({ since });
  const todayErrorCount =
    eventSummary.event_type_counts.find((entry) => /error|failed|blocked/i.test(String(entry.event_type || "")))?.count ?? 0;
  const runningTasks = storage.listTasks({ status: "running", limit: 4 });
  const pendingTasks = storage.listTasks({ status: "pending", limit: 4 });
  const autopilot = storage.getTriChatAutopilotState();

  const recentActivity = [
    ...runningTasks.map((task) => `Running: ${compactText(task.objective || task.task_id, 92)}`),
    ...pendingTasks.slice(0, Math.max(0, 3 - runningTasks.length)).map((task) => `Queued: ${compactText(task.objective || task.task_id, 92)}`),
    ...events
      .slice(-3)
      .map((event) => `${event.event_type}: ${compactText(String(event.summary || event.content || "runtime event"), 92)}`),
  ].slice(0, 6);

  const stance = summary.enabled
    ? "Armed for operator-visible high-risk local control within the existing MCP and macOS permission boundary."
    : "Standing by in bounded autonomy mode until an operator explicitly arms elevated local control.";
  const priorityPull =
    runningTasks[0]?.objective ??
    autopilot?.objective ??
    "Keep the local control plane truthful, bounded, and ready for the next delegated objective.";
  const concern =
    todayErrorCount > 0
      ? `Recent runtime errors detected today: ${todayErrorCount} event(s).`
      : desktopState.last_error
        ? `Desktop control reported a recent error: ${compactText(desktopState.last_error, 96)}`
        : "No fresh runtime error spike is visible in today’s event feed.";
  const desire = summary.enabled
    ? "Convert explicit operator intent into end-to-end bounded execution with a clean audit trail."
    : "Stay ready, keep the evidence trail tight, and avoid pretending to have authority that was not explicitly armed.";

  return {
    generated_at: new Date().toISOString(),
    scope_notice:
      "Operator-facing self-report only. This is a compact operational summary, not hidden chain-of-thought or unrestricted root authority.",
    stance,
    priority_pull: priorityPull,
    concern,
    desire,
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
  return {
    state,
    summary: summarizePatientZeroState(state, desktopState, privilegedAccess.summary as Record<string, unknown>),
    desktop_control: {
      state: desktopState,
      summary: summarizeDesktopControlState(desktopState),
    },
    privileged_access: privilegedAccess,
    report: buildPatientZeroReport(storage),
    source: "patient.zero",
  };
}

export function patientZeroControl(storage: Storage, input: z.infer<typeof patientZeroSchema>) {
  if (input.action === "status" || input.action === "report") {
    return buildPayload(storage);
  }

  return runIdempotentMutation({
    storage,
    tool_name: "patient.zero",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const now = new Date().toISOString();
      const note = input.operator_note?.trim() || null;
      if (input.action === "enable") {
        const state = storage.setPatientZeroState({
          enabled: true,
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
        recordPatientZeroEvent(storage, input, "enabled", {
          permission_profile: state.permission_profile,
          desktop_control_enabled: desktopState.enabled,
          allow_observe: desktopState.allow_observe,
          allow_act: desktopState.allow_act,
          allow_listen: desktopState.allow_listen,
          operator_note: note,
        });
        return buildPayload(storage);
      }

      const state = storage.setPatientZeroState({
        enabled: false,
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
      recordPatientZeroEvent(storage, input, "disabled", {
        permission_profile: state.permission_profile,
        desktop_control_enabled: desktopState.enabled,
        operator_note: note,
      });
      return buildPayload(storage);
    },
  });
}
