import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { summarizeDesktopControlState } from "../desktop_control_plane.js";
import { summarizePatientZeroState } from "../patient_zero_plane.js";
import { buildOfficeGuiSnapshot } from "../office_gui_snapshot.js";
import {
  type AgentSessionRecord,
  type KernelSignalOverviewRecord,
  type RuntimeEventRecord,
  type RuntimeWorkerSessionRecord,
  type TaskRecord,
  type TriChatAdapterTelemetrySummaryRecord,
  Storage,
} from "../storage.js";
import { getTriChatAgentCatalog, getTriChatConfiguredDefaultAgentIds } from "../trichat_roster.js";
import type { AgentLearningOverview } from "./agent_learning.js";
import { listAgentSessions } from "./agent_session.js";
import { summarizeAgentLearning } from "./agent_learning.js";
import { getAutonomyMaintainRuntimeStatus } from "./autonomy_maintain.js";
import { kernelSummary, summarizeAutonomyMaintain } from "./kernel.js";
import { operatorBrief } from "./operator_brief.js";
import {
  applyProviderBridgeDiagnosticsToSnapshot,
  buildProviderBridgeOnboardingSummary,
  resolveProviderBridgeDiagnostics,
  resolveProviderBridgeSnapshot,
} from "./provider_bridge.js";
import { getReactionEngineRuntimeStatus } from "./reaction_engine.js";
import { summarizeLiveRuntimeWorkers } from "./runtime_worker.js";
import { taskList, taskSummary } from "./task.js";
import { getAutopilotStatus, trichatAdapterTelemetry, trichatSummary, trichatWorkboard } from "./trichat.js";
import { readWarmCacheEntry } from "../warm_cache_runtime.js";
import { buildPatientZeroOfficeReport } from "./patient_zero.js";
import { buildPrivilegedAccessStatus } from "./privileged_exec.js";

const recordSchema = z.record(z.unknown());
type TaskListPayload = ReturnType<typeof taskList>;
type TaskSummaryPayload = ReturnType<typeof taskSummary>;
type AgentSessionListPayload = ReturnType<typeof listAgentSessions>;
type LearningPayload = AgentLearningOverview | {};
type AdapterPayload = ReturnType<typeof trichatAdapterTelemetry>;
type WorkboardPayload = ReturnType<typeof trichatWorkboard>;
type TriChatSummaryPayload = ReturnType<typeof trichatSummary>;
type OperatorBriefPayload = ReturnType<typeof operatorBrief>;
type ProviderBridgePayload = {
  snapshot: ReturnType<typeof resolveProviderBridgeSnapshot>;
  diagnostics: ReturnType<typeof resolveProviderBridgeDiagnostics>;
};
type PatientZeroReportPayload = ReturnType<typeof buildPatientZeroOfficeReport>;
type RuntimeWorkersPayload = {
  count: number;
  sessions: RuntimeWorkerSessionRecord[];
  summary: {
    session_count: number;
    active_count: number;
    counts: Record<string, number>;
    latest_session: RuntimeWorkerSessionRecord | null;
  };
};

export const officeSnapshotSchema = z.object({
  thread_id: z.string().min(1).optional(),
  turn_limit: z.number().int().min(1).max(30).default(12),
  task_limit: z.number().int().min(1).max(64).default(24),
  session_limit: z.number().int().min(1).max(100).default(50),
  event_limit: z.number().int().min(1).max(80).default(24),
  learning_limit: z.number().int().min(1).max(500).default(120),
  runtime_worker_limit: z.number().int().min(1).max(100).default(20),
  include_kernel: z.boolean().default(true),
  include_learning: z.boolean().default(true),
  include_bus: z.boolean().default(true),
  include_adapter: z.boolean().default(true),
  include_runtime_workers: z.boolean().default(true),
  metadata: recordSchema.optional(),
});

const OFFICE_SNAPSHOT_DEFAULT_THREAD_ID = "ring-leader-main";

export function officeSnapshotWarmCacheKey(threadId: string) {
  return `office.snapshot:${threadId}`;
}

function isDefaultOfficeSnapshotRequest(input: z.infer<typeof officeSnapshotSchema>) {
  const metadataSource =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? String((input.metadata as Record<string, unknown>).source ?? "").trim().toLowerCase()
      : "";
  const warmCacheEligibleMetadata =
    input.metadata === undefined || metadataSource === "dashboard.direct" || metadataSource === "http.raw";
  return (
    (input.thread_id?.trim() || OFFICE_SNAPSHOT_DEFAULT_THREAD_ID) !== "" &&
    input.turn_limit === 12 &&
    input.task_limit === 24 &&
    input.session_limit === 50 &&
    input.event_limit === 24 &&
    input.learning_limit === 120 &&
    input.runtime_worker_limit === 20 &&
    input.include_kernel === true &&
    input.include_learning === true &&
    input.include_bus === true &&
    input.include_adapter === true &&
    input.include_runtime_workers === true &&
    warmCacheEligibleMetadata
  );
}

function normalizeAgentId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function dedupeAgentIds(values: unknown[]) {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const agentId = normalizeAgentId(value);
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ordered.push(agentId);
  }
  return ordered;
}

function dedupeText(values: unknown[]) {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    ordered.push(text);
  }
  return ordered;
}

function resolvePatientZeroAuthoritySnapshot(patientZero: {
  summary: ReturnType<typeof summarizePatientZeroState>;
  report: PatientZeroReportPayload;
}) {
  const summary = asRecord(patientZero.summary);
  const report = asRecord(patientZero.report);
  const macosAuthorityAudit = asRecord(report.macos_authority_audit);
  const reportAuthorityProofs = asRecord(report.authority_proofs);
  const authorityBlockers = dedupeText([
    ...asList(summary.authority_blockers),
    ...asList(report.authority_blockers),
  ]);
  const macosAuthorityStatusRaw = String(
    summary.macos_authority_audit_status ?? macosAuthorityAudit.status ?? ""
  )
    .trim()
    .toLowerCase();
  const macosAuthorityStatus = macosAuthorityStatusRaw || null;
  const macosAuthorityReady =
    typeof summary.macos_authority_ready === "boolean"
      ? summary.macos_authority_ready
      : typeof reportAuthorityProofs.macos_authority_audit_ready === "boolean"
        ? reportAuthorityProofs.macos_authority_audit_ready
      : typeof macosAuthorityAudit.ready_for_patient_zero_full_authority === "boolean"
        ? macosAuthorityAudit.ready_for_patient_zero_full_authority
        : null;
  const reportedFullControlAuthority =
    typeof summary.full_control_authority === "boolean"
      ? summary.full_control_authority
      : typeof report.full_control_authority === "boolean"
        ? report.full_control_authority
        : null;
  const authorityBlockedByStatus =
    (macosAuthorityStatus === "blocked" || macosAuthorityStatus === "unavailable") && macosAuthorityReady !== true;
  const authorityBlocked =
    authorityBlockers.length > 0 ||
    macosAuthorityReady === false ||
    authorityBlockedByStatus ||
    reportedFullControlAuthority === false;
  const fullControlAuthority = reportedFullControlAuthority === true && !authorityBlocked;
  return {
    full_control_authority: fullControlAuthority,
    authority_blockers: authorityBlockers,
    macos_authority_audit_status: macosAuthorityStatus,
    macos_authority_ready: macosAuthorityReady,
    authority_blocked: authorityBlocked,
  };
}

function countProviderBridgeDiagnostics(
  diagnostics: ProviderBridgePayload["diagnostics"]["diagnostics"],
  status: "connected" | "configured" | "disconnected" | "unavailable"
) {
  return diagnostics.filter((entry) => entry.status === status).length;
}

function isProviderBridgeDegraded(diagnostics: ProviderBridgePayload["diagnostics"]) {
  const connectedCount = countProviderBridgeDiagnostics(diagnostics.diagnostics, "connected");
  const configuredCount = countProviderBridgeDiagnostics(diagnostics.diagnostics, "configured");
  const disconnectedCount = countProviderBridgeDiagnostics(diagnostics.diagnostics, "disconnected");
  return (
    diagnostics.stale === true ||
    disconnectedCount > 0 ||
    (diagnostics.diagnostics.length > 0 && connectedCount === 0 && configuredCount === 0)
  );
}

function resolveProviderReadyAgentIds(diagnostics: ProviderBridgePayload["diagnostics"]) {
  if (diagnostics.stale === true) {
    return [];
  }
  return dedupeAgentIds(
    diagnostics.diagnostics
      .filter((entry) => entry.status === "connected")
      .map((entry) => String(entry.office_agent_id || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function collectProviderBridgeAgentIds(
  snapshot: ProviderBridgePayload["snapshot"],
  diagnostics: ProviderBridgePayload["diagnostics"]
) {
  return dedupeAgentIds([
    ...snapshot.clients.map((entry) => entry.office_agent_id),
    ...diagnostics.diagnostics.map((entry) => entry.office_agent_id),
  ]);
}

function reconcileRosterProviderBridgeReadiness(
  roster: Record<string, unknown>,
  providerBridge: ProviderBridgePayload
) {
  const providerAgentIds = new Set(collectProviderBridgeAgentIds(providerBridge.snapshot, providerBridge.diagnostics));
  const activeAgentIds = dedupeAgentIds(asList(roster.active_agent_ids)).filter((agentId) => !providerAgentIds.has(agentId));
  return {
    ...roster,
    active_agent_ids: dedupeAgentIds([...activeAgentIds, ...resolveProviderReadyAgentIds(providerBridge.diagnostics)]),
  };
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

function providerBridgeDiagnosticsStale(autonomyMaintainState: Record<string, unknown>) {
  const lastCheckAt = String(autonomyMaintainState.last_provider_bridge_check_at ?? "").trim();
  const configuredIntervalSeconds = Number(autonomyMaintainState.interval_seconds ?? 120);
  const intervalSeconds = Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0 ? configuredIntervalSeconds : 120;
  return ageSeconds(lastCheckAt) > Math.max(intervalSeconds * 3, 300);
}

function summarizeTmuxDashboard(state: ReturnType<Storage["getTriChatTmuxControllerState"]>) {
  const tasks = state?.tasks ?? [];
  const queueDepth = tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length;
  const runningDepth = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed");
  const queuedOrRunning = tasks.filter(
    (task) => task.status === "queued" || task.status === "dispatched" || task.status === "running"
  );
  const oldestTask = queuedOrRunning
    .slice()
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))[0];
  return {
    queue_depth: queueDepth,
    running_depth: runningDepth,
    queue_oldest_task_id: oldestTask?.task_id ?? null,
    queue_age_seconds: oldestTask ? ageSeconds(oldestTask.created_at) : 0,
    failure_count: failed.length,
    failure_class: failed.length > 0 ? "task-failed" : "none",
    worker_load: [],
    host_load: [],
  };
}

function summarizeRuntimeWorkers(storage: Storage, limit: number): RuntimeWorkersPayload {
  return summarizeLiveRuntimeWorkers(storage, limit);
}

function compactWorkbenchText(value: unknown, limit = 180) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeWorkbenchMode(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function isInformationalKernelAttention(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "no actionable work is currently queued." ||
    normalized === "no actionable work is currently queued" ||
    normalized === "kernel is progressing normally." ||
    normalized === "kernel is progressing normally"
  );
}

function buildWorkbenchTaskCards(tasks: unknown) {
  const taskList = Array.isArray(tasks) ? (tasks as TaskRecord[]) : [];
  return taskList.slice(0, 5).map((task) => ({
    task_id: task.task_id,
    status: task.status,
    priority: task.priority,
    objective: compactWorkbenchText(task.objective, 120),
    updated_at: task.updated_at,
    source_agent: task.source_agent,
    last_error: compactWorkbenchText(task.last_error, 120) || null,
  }));
}

function buildWorkbenchSummary(params: {
  taskSummaryPayload: TaskSummaryPayload;
  taskRunning: TaskListPayload;
  taskPending: TaskListPayload;
  taskFailed: TaskListPayload;
  operatorBriefPayload: OperatorBriefPayload;
  kernel: Record<string, unknown>;
  setupDiagnostics: Record<string, unknown>;
  providerBridge: ProviderBridgePayload;
  desktopControl: {
    state: ReturnType<Storage["getDesktopControlState"]>;
    summary: ReturnType<typeof summarizeDesktopControlState>;
  };
  patientZero: {
    state: ReturnType<Storage["getPatientZeroState"]>;
    summary: ReturnType<typeof summarizePatientZeroState>;
    report: PatientZeroReportPayload;
  };
  privilegedAccess: ReturnType<typeof buildPrivilegedAccessStatus>;
}) {
  const counts = asRecord(params.taskSummaryPayload.counts);
  const operatorBriefRecord = asRecord(params.operatorBriefPayload);
  const kernelRecord = asRecord(params.kernel);
  const controlPlane = asRecord(operatorBriefRecord.control_plane_summary);
  const providerDiagnostics = params.providerBridge.diagnostics;
  const setupFallback = asRecord(params.setupDiagnostics.fallback);
  const kernelStorage = asRecord(kernelRecord.storage);
  const goalSummary = asRecord(operatorBriefRecord.goal_summary);
  const planSummary = asRecord(operatorBriefRecord.plan_summary);
  const stepSummary = asRecord(operatorBriefRecord.step_summary);
  const taskSummary = asRecord(operatorBriefRecord.task_summary);
  const runningCount = Number(counts.running ?? 0);
  const pendingCount = Number(counts.pending ?? 0);
  const failedCount = Number(counts.failed ?? 0);
  const completedCount = Number(counts.completed ?? 0);
  const currentObjective = compactWorkbenchText(operatorBriefRecord.current_objective, 220);
  const stepStatus = String(stepSummary.status ?? "").trim().toLowerCase();
  const taskId = String(taskSummary.task_id ?? "").trim();
  const taskStatus = String(taskSummary.status ?? "").trim().toLowerCase();
  const activeStepIsActionable = ["ready", "running", "blocked"].includes(stepStatus);
  const activeTaskIsActionable =
    Boolean(taskId) && !["completed", "cancelled", "failed", "archived"].includes(taskStatus);
  const hasActionableActiveExecution =
    activeTaskIsActionable || activeStepIsActionable || runningCount > 0 || pendingCount > 0;
  const actionableCurrentObjective = hasActionableActiveExecution ? currentObjective : "";
  const attention = dedupeText(asList(kernelRecord.attention)).filter((entry) => !isInformationalKernelAttention(entry));
  const patientZeroAuthority = resolvePatientZeroAuthoritySnapshot(params.patientZero);
  const blockers: Array<{
    kind: string;
    title: string;
    detail: string;
    remediation: null | {
      label: string;
      action: string;
      payload?: Record<string, unknown>;
    };
  }> = [];

  const failedTasks = buildWorkbenchTaskCards(params.taskFailed.tasks);
  if (failedCount > 0) {
    blockers.push({
      kind: "failed_tasks",
      title: `${failedCount} failed task${failedCount === 1 ? "" : "s"}`,
      detail: "Recover or requeue failed tasks before expanding the queue.",
      remediation: {
        label: "Retry Failed Tasks",
        action: "retry_failed_tasks",
        payload: {
          task_ids: failedTasks.map((task) => task.task_id).filter(Boolean),
        },
      },
    });
  }
  if (Boolean(kernelStorage.attention_required)) {
    const storageStatus = String(kernelStorage.status ?? "evidence_present").trim().toLowerCase();
    const evidenceBytes =
      (finiteNumberOrNull(kernelStorage.quarantine_total_bytes) ?? 0) +
      (finiteNumberOrNull(kernelStorage.recovery_total_bytes) ?? 0);
    const evidenceText = evidenceBytes > 0 ? ` ${formatBytesForOffice(evidenceBytes)} of` : "";
    const detail =
      storageStatus === "recovered"
        ? `The database layer was quarantined or restored on this boot. Review${evidenceText} recovery evidence before treating thread state as clean.`
        : `Quarantine or recovery evidence is still present on disk. Review or archive${evidenceText} evidence so database health stays explicit across threads.`;
    blockers.push({
      kind: "storage_health",
      title: storageStatus === "recovered" ? "Storage guard recovered database state" : "Storage guard evidence needs review",
      detail,
      remediation: {
        label: "Check Storage Health",
        action: "storage_health",
      },
    });
  }
  attention.slice(0, 3).forEach((entry) => {
    blockers.push({
      kind: "kernel_attention",
      title: "Kernel attention",
      detail: compactWorkbenchText(entry, 180),
      remediation: {
        label: "Run Maintain",
        action: "maintain",
      },
    });
  });
  if (providerDiagnostics.stale === true) {
    blockers.push({
      kind: "provider_bridge",
      title: "Provider bridge diagnostics are stale",
      detail: "Bridge health is out of date, so remote agent readiness is uncertain.",
      remediation: {
        label: "Refresh Maintain Loop",
        action: "maintain",
      },
    });
  } else if (countProviderBridgeDiagnostics(providerDiagnostics.diagnostics, "disconnected") > 0) {
    blockers.push({
      kind: "provider_bridge",
      title: "Provider bridge clients are disconnected",
      detail: "Some bridge-backed agents will stay blocked until their client connection is restored.",
      remediation: {
        label: "Run Maintain",
        action: "maintain",
      },
    });
  }
  if (params.desktopControl.summary.stale) {
    blockers.push({
      kind: "desktop_control",
      title: "Desktop control is stale",
      detail: "Observation or actuation lanes are not reporting fresh capability state.",
      remediation: {
        label: "Refresh Maintain Loop",
        action: "maintain",
      },
    });
  }
  if (setupFallback.desktop_degraded === true) {
    blockers.push({
      kind: "desktop_control",
      title: "Desktop lane degraded",
      detail: "Keep desktop-dependent work explicit until the local lane recovers.",
      remediation: {
        label: "Run Maintain",
        action: "maintain",
      },
    });
  }
  const patientZeroAuthorityNeedsWorkbenchBlocker =
    patientZeroAuthority.authority_blocked &&
    (params.patientZero.summary.enabled || setupFallback.patient_zero_authority_degraded === true);
  if (patientZeroAuthorityNeedsWorkbenchBlocker) {
    const authorityDetail =
      patientZeroAuthority.authority_blockers.length > 0
        ? `Full-control claims are blocked by: ${patientZeroAuthority.authority_blockers.slice(0, 4).join(", ")}.`
        : patientZeroAuthority.macos_authority_audit_status
          ? `Full-control claims are blocked while macOS authority audit status is ${patientZeroAuthority.macos_authority_audit_status}.`
          : "Full-control claims are blocked until macOS and local authority proofs are complete.";
    blockers.push({
      kind: "patient_zero_authority",
      title: "Patient Zero authority is blocked",
      detail: authorityDetail,
      remediation: {
        label: "Run macOS Authority Doctor",
        action: "doctor_macos_authority",
        payload: {
          command: "npm run doctor:macos:authority",
        },
      },
    });
  }
  const livePrivilegedAccessSummary = asRecord(params.privilegedAccess.summary);
  const briefPrivilegedAccessSummary = asRecord(controlPlane.privileged_access);
  const rootExecutionReady =
    livePrivilegedAccessSummary.root_execution_ready === true ||
    briefPrivilegedAccessSummary.root_execution_ready === true ||
    patientZeroAuthority.full_control_authority === true;
  if (params.patientZero.summary.enabled && !rootExecutionReady) {
    blockers.push({
      kind: "privileged_access",
      title: "Patient Zero is armed without a ready root lane",
      detail: "High-risk local control is not fully available yet.",
      remediation: {
        label: "Disarm Patient Zero",
        action: "patient_zero_disable",
        payload: {
          operator_note: "Disarmed from workbench because the privileged root lane was not ready.",
        },
      },
    });
  }

  let focusArea = "intake";
  let status = "ready";
  let headline = "Define the next bounded objective and dispatch it through the MCP core.";

  if (blockers.length > 0) {
    focusArea = "stabilize";
    status = "attention";
    headline = "Stabilize the runtime before taking on more work.";
  } else if (actionableCurrentObjective && (runningCount > 0 || stepStatus === "running")) {
    focusArea = "execute";
    status = "active";
    headline = "Push the current execution forward and keep the active lane moving.";
  } else if (pendingCount > 0) {
    focusArea = "queue";
    status = "ready";
    headline = "Turn pending queue into owned execution instead of adding fresh surface area.";
  }

  const nextActions: Array<{ label: string; detail: string }> = [];
  if (blockers.length > 0) {
    nextActions.push({
      label: "Clear blockers",
      detail: blockers.map((entry) => entry.title).slice(0, 2).join(" · "),
    });
  }
  if (actionableCurrentObjective) {
    nextActions.push({
      label: "Advance current objective",
      detail: actionableCurrentObjective,
    });
  }
  if (pendingCount > 0) {
    nextActions.push({
      label: "Drain pending queue",
      detail: `${pendingCount} pending task${pendingCount === 1 ? "" : "s"} waiting for ownership or execution.`,
    });
  }
  if (nextActions.length === 0) {
    nextActions.push({
      label: "Open a bounded objective",
      detail: "Use the intake desk to create one concrete, reviewable slice of work.",
    });
  }

  const suggestedObjectives: Array<{
    title: string;
    objective: string;
    risk: "low" | "medium" | "high" | "critical";
    mode: string;
    why: string;
  }> = [];
  if (failedCount > 0) {
    suggestedObjectives.push({
      title: "Recover failed tasks",
      objective:
        "Inspect the failed task queue, identify the immediate cause of failure, and either requeue or close each failed task with a concrete recovery note and next action.",
      risk: "medium",
      mode: "recommend",
      why: "The core already has failed work. Clearing it improves reliability faster than opening new work.",
    });
  }
  if (hasActionableActiveExecution && String(stepSummary.title ?? "").trim()) {
    const stepTitle = compactWorkbenchText(stepSummary.title, 90);
    const goalTitle = compactWorkbenchText(goalSummary.title || actionableCurrentObjective || "the active goal", 90);
    suggestedObjectives.push({
      title: `Advance ${stepTitle}`,
      objective: `Advance the current plan step "${stepTitle}" for ${goalTitle}. Produce the minimum concrete outcome needed to move the plan into the next executable state, including evidence and rollback notes if applicable.`,
      risk: "medium",
      mode: normalizeWorkbenchMode(goalSummary.autonomy_mode) || "execute_bounded",
      why: "There is already an active plan context, so the highest leverage move is to progress it instead of starting a parallel thread.",
    });
  }
  if (pendingCount > 0) {
    const firstPending = params.taskPending.tasks[0];
    const pendingObjective = compactWorkbenchText(firstPending?.objective, 110) || "the pending queue";
    suggestedObjectives.push({
      title: "Turn queue into owned execution",
      objective: `Take the front of the pending queue and convert it into an owned execution slice with a clear agent, acceptance bar, and evidence contract. Start with: ${pendingObjective}.`,
      risk: "medium",
      mode: "recommend",
      why: "The system already has queued work that can be clarified and dispatched.",
    });
  }
  if (suggestedObjectives.length === 0) {
    suggestedObjectives.push({
      title: "Open today’s first bounded objective",
      objective:
        "Define one concrete objective for today with a clear outcome, hard constraints, and a small enough scope that it can be dispatched and verified through the MCP core in one pass.",
      risk: "low",
      mode: "recommend",
      why: "No active execution context is visible, so the best next move is to open one bounded slice of work.",
    });
  }

  return {
    focus_area: focusArea,
    status,
    headline,
    active_execution: {
      current_objective: actionableCurrentObjective || null,
      actionable: hasActionableActiveExecution,
      goal: {
        goal_id: String(goalSummary.goal_id ?? "").trim() || null,
        title: compactWorkbenchText(goalSummary.title, 120) || null,
        status: String(goalSummary.status ?? "").trim() || null,
        autonomy_mode: String(goalSummary.autonomy_mode ?? "").trim() || null,
      },
      plan: {
        plan_id: String(planSummary.plan_id ?? "").trim() || null,
        title: compactWorkbenchText(planSummary.title, 120) || null,
        status: String(planSummary.status ?? "").trim() || null,
      },
      step: {
        step_id: String(stepSummary.step_id ?? "").trim() || null,
        title: compactWorkbenchText(stepSummary.title, 120) || null,
        status: String(stepSummary.status ?? "").trim() || null,
      },
      task: {
        task_id: String(taskSummary.task_id ?? "").trim() || null,
        objective: compactWorkbenchText(taskSummary.objective, 140) || null,
        status: String(taskSummary.status ?? "").trim() || null,
      },
    },
    queue: {
      running: runningCount,
      pending: pendingCount,
      failed: failedCount,
      completed: completedCount,
      running_tasks: buildWorkbenchTaskCards(params.taskRunning.tasks),
      pending_tasks: buildWorkbenchTaskCards(params.taskPending.tasks),
      failed_tasks: failedTasks,
    },
    blockers,
    next_actions: nextActions,
    suggested_objectives: suggestedObjectives.slice(0, 3),
    quick_actions: {
      retry_failed_tasks: failedTasks.length > 0,
      recover_expired_tasks: runningCount > 0,
    },
  };
}

function summarizeAutonomyMaintainState(storage: Storage) {
  const state = storage.getAutonomyMaintainState();
  const summary = summarizeAutonomyMaintain(state, storage);
  return {
    action: "status_cached",
    state: state ?? {
      enabled: false,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
      last_run_at: null,
      last_bootstrap_ready_at: null,
      last_goal_autorun_daemon_at: null,
      last_tmux_maintained_at: null,
      last_learning_review_at: null,
      last_learning_entry_count: 0,
      last_learning_active_agent_count: 0,
      last_eval_run_at: null,
      last_eval_run_id: null,
      last_eval_score: null,
      last_provider_bridge_check_at: null,
      provider_bridge_diagnostics: [],
      last_actions: [],
      last_attention: [],
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    runtime: summary.runtime,
    due: {
      stale: summary.stale,
      eval: summary.eval_due,
    },
    subsystems: summary.subsystems,
  };
}

function buildPersistedProviderBridgeDiagnostics(autonomyMaintainState: Record<string, unknown>) {
  const persistedProviderBridgeGeneratedAt =
    String(autonomyMaintainState.last_provider_bridge_check_at ?? autonomyMaintainState.updated_at ?? "").trim() ||
    new Date().toISOString();
  const persistedProviderBridgeDiagnostics = Array.isArray(autonomyMaintainState.provider_bridge_diagnostics)
    ? autonomyMaintainState.provider_bridge_diagnostics
    : [];
  const persistedProviderBridgeStale = providerBridgeDiagnosticsStale(autonomyMaintainState);
  return {
    generated_at: persistedProviderBridgeGeneratedAt,
    cached: persistedProviderBridgeDiagnostics.length > 0,
    stale: persistedProviderBridgeStale,
    diagnostics: persistedProviderBridgeDiagnostics,
  };
}

function shouldRefreshProviderBridgeDiagnosticsForOffice(
  input: z.infer<typeof officeSnapshotSchema>,
  diagnostics: ReturnType<typeof buildPersistedProviderBridgeDiagnostics>
) {
  const metadata = asRecord(input.metadata);
  const source = String(metadata.source ?? "").trim().toLowerCase();
  return diagnostics.stale === true || source === "http.live";
}

function buildOfficeProviderBridgeDiagnostics(
  autonomyMaintainState: Record<string, unknown>,
  input: z.infer<typeof officeSnapshotSchema>
) {
  const persisted = buildPersistedProviderBridgeDiagnostics(autonomyMaintainState);
  if (!shouldRefreshProviderBridgeDiagnosticsForOffice(input, persisted)) {
    return persisted;
  }
  try {
    const live = resolveProviderBridgeDiagnostics({
      workspace_root: process.cwd(),
      bypass_cache: true,
      probe_timeout_ms: 3000,
    });
    return live.diagnostics.length > 0 ? live : persisted;
  } catch {
    return persisted;
  }
}

function buildOfficeSetupDiagnostics(params: {
  kernel: Record<string, unknown>;
  providerBridge: {
    diagnostics: ProviderBridgePayload["diagnostics"];
    onboarding: ReturnType<typeof buildProviderBridgeOnboardingSummary>;
  };
  desktopControl: {
    state: ReturnType<Storage["getDesktopControlState"]>;
    summary: ReturnType<typeof summarizeDesktopControlState>;
  };
  patientZero: {
    state: ReturnType<Storage["getPatientZeroState"]>;
    summary: ReturnType<typeof summarizePatientZeroState>;
    report: PatientZeroReportPayload;
  };
}) {
  const kernelSetup = asRecord(params.kernel.setup_diagnostics);
  const kernelPlatform = asRecord(kernelSetup.platform);
  const kernelFallback = asRecord(kernelSetup.fallback);
  const kernelLaunchers = asRecord(kernelSetup.launchers);
  const kernelOfficeGuiLauncher = asRecord(kernelLaunchers.office_gui);
  const kernelAgenticSuiteLauncher = asRecord(kernelLaunchers.agentic_suite);
  const providerBridgeDegraded = isProviderBridgeDegraded(params.providerBridge.diagnostics);
  const browserDegraded = params.patientZero.summary.enabled && params.patientZero.summary.browser_ready !== true;
  const patientZeroAuthority = resolvePatientZeroAuthoritySnapshot(params.patientZero);
  const patientZeroAuthorityDegraded = params.patientZero.summary.enabled && patientZeroAuthority.authority_blocked;
  const desktopDegraded =
    params.desktopControl.summary.enabled &&
    (params.desktopControl.summary.stale ||
      (params.desktopControl.summary.observe_enabled && !params.desktopControl.summary.observe_ready) ||
      (params.desktopControl.summary.act_enabled && !params.desktopControl.summary.act_ready) ||
      (params.desktopControl.summary.listen_enabled && !params.desktopControl.summary.listen_ready));
  const nextActions = dedupeText([
    ...(Array.isArray(kernelSetup.next_actions)
      ? kernelSetup.next_actions.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : []),
    ...(providerBridgeDegraded || browserDegraded || desktopDegraded
      ? [
          "Run `npm run bootstrap:env` to verify the pinned runtime, prepare the local environment, and emit the platform bootstrap report before debugging individual lanes.",
        ]
      : []),
    ...(providerBridgeDegraded
      ? [
          "Run `npm run providers:status` and then `npm run providers:diagnose -- <client-id>` for any disconnected or unavailable bridge clients.",
        ]
      : []),
    ...(browserDegraded
      ? [
          "Browser work will degrade visibly until the desktop/browser lane is available on this host; keep browser-required tasks operator-visible.",
        ]
      : []),
    ...(desktopDegraded
      ? [
          "Desktop control is degraded on this host; observation or actuation should stay bounded and explicit until the lane recovers.",
        ]
      : []),
    ...(patientZeroAuthorityDegraded
      ? [
          "Patient Zero authority is blocked; run `npm run doctor:macos:authority` and complete the listed macOS consent remediation before claiming full local control.",
        ]
      : []),
    ...(kernelAgenticSuiteLauncher.degraded === true
      ? [
          "Run `npm run agentic:suite:status` to inspect the visible-suite fallback path before a demo or operator handoff.",
        ]
      : []),
  ]);
  return {
    source: "office.snapshot",
    platform: {
      platform: String(kernelPlatform.platform ?? process.platform),
      arch: String(kernelPlatform.arch ?? process.arch),
      distribution: String(kernelPlatform.distribution ?? "").trim() || null,
      browser_app: String(kernelPlatform.browser_app ?? params.patientZero.summary.browser_app ?? "").trim() || null,
    },
    provider_bridge: {
      generated_at: params.providerBridge.diagnostics.generated_at,
      cached: params.providerBridge.diagnostics.cached,
      stale: params.providerBridge.diagnostics.stale ?? false,
      connected_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "connected").length,
      configured_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "configured").length,
      disconnected_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "disconnected").length,
      unavailable_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "unavailable").length,
      onboarding: params.providerBridge.onboarding,
    },
    desktop_control: params.desktopControl.summary,
    patient_zero: {
      ...params.patientZero.summary,
      full_control_authority: patientZeroAuthority.full_control_authority,
      authority_blockers: patientZeroAuthority.authority_blockers,
      macos_authority_ready: patientZeroAuthority.macos_authority_ready,
      macos_authority_audit_status: patientZeroAuthority.macos_authority_audit_status,
    },
    fallback: {
      core_usable:
        typeof kernelFallback.core_usable === "boolean"
          ? kernelFallback.core_usable
          : params.providerBridge.diagnostics.stale !== true,
      browser_degraded:
        kernelFallback.browser_degraded === true || browserDegraded,
      provider_bridge_degraded:
        kernelFallback.provider_bridge_degraded === true || providerBridgeDegraded,
      desktop_degraded:
        kernelFallback.desktop_degraded === true || desktopDegraded,
      patient_zero_authority_degraded:
        kernelFallback.patient_zero_authority_degraded === true || patientZeroAuthorityDegraded,
    },
    launchers: {
      office_gui: {
        supported: kernelOfficeGuiLauncher.supported === true,
        ready: kernelOfficeGuiLauncher.ready === true,
        degraded: kernelOfficeGuiLauncher.degraded === true,
        entrypoint: String(kernelOfficeGuiLauncher.entrypoint ?? "").trim() || null,
        service_mode: String(kernelOfficeGuiLauncher.service_mode ?? "").trim() || null,
        reassurance_surface: String(kernelOfficeGuiLauncher.reassurance_surface ?? "status"),
        distribution_supported: kernelOfficeGuiLauncher.distribution_supported !== false,
      },
      agentic_suite: {
        supported: kernelAgenticSuiteLauncher.supported === true,
        ready: kernelAgenticSuiteLauncher.ready === true,
        degraded: kernelAgenticSuiteLauncher.degraded === true,
        entrypoint: String(kernelAgenticSuiteLauncher.entrypoint ?? "").trim() || null,
        service_mode: String(kernelAgenticSuiteLauncher.service_mode ?? "").trim() || null,
        reassurance_surface: String(kernelAgenticSuiteLauncher.reassurance_surface ?? "status"),
        app_launch_enabled: kernelAgenticSuiteLauncher.app_launch_enabled === true,
        distribution_supported: kernelAgenticSuiteLauncher.distribution_supported !== false,
      },
    },
    next_actions: nextActions,
  };
}

function summarizeReactionEngineState(storage: Storage) {
  const state = storage.getReactionEngineState();
  const runtime = getReactionEngineRuntimeStatus();
  const stale =
    state?.enabled === true && ageSeconds(runtime.last_tick_at || state.last_run_at) > Math.max((state.interval_seconds ?? 60) * 3, 300);
  return {
    ...(state ?? {
      enabled: false,
      interval_seconds: 60,
      dedupe_window_seconds: 300,
      channels: [],
      last_run_at: null,
      last_sent_at: null,
      last_sent_count: 0,
      last_alert_key: null,
      last_alert_seen_count: 0,
      recent_notifications: [],
      last_error: null,
      updated_at: new Date().toISOString(),
    }),
    runtime,
    stale,
  };
}

function buildRosterPayload(
  workboard: WorkboardPayload,
  agentSessions: AgentSessionListPayload,
  learning: LearningPayload,
  autopilot: Record<string, unknown>
) {
  const latestTurn = (workboard.active_turn as Record<string, unknown> | null) ?? (workboard.latest_turn as Record<string, unknown> | null) ?? {};
  const latestMetadata = (latestTurn.metadata as Record<string, unknown> | undefined) ?? {};
  const autopilotState = asRecord(autopilot.state);
  const autopilotConfig = asRecord(autopilotState.config);
  const autopilotPool = asRecord(autopilotState.effective_agent_pool);
  const autopilotSession = asRecord(asRecord(autopilotState.session).session);
  const autopilotSessionMetadata = asRecord(autopilotSession.metadata);
  const defaultAgentIds = getTriChatConfiguredDefaultAgentIds();
  const activeAgentIds = dedupeAgentIds([
    autopilotPool.lead_agent_id,
    ...((Array.isArray(autopilotPool.specialist_agent_ids) ? autopilotPool.specialist_agent_ids : []) as unknown[]),
    ...((Array.isArray(autopilotPool.council_agent_ids) ? autopilotPool.council_agent_ids : []) as unknown[]),
    autopilotConfig.lead_agent_id,
    ...((Array.isArray(autopilotConfig.specialist_agent_ids) ? autopilotConfig.specialist_agent_ids : []) as unknown[]),
    autopilotSession.agent_id,
    ...((Array.isArray(autopilotSessionMetadata.specialist_agent_ids) ? autopilotSessionMetadata.specialist_agent_ids : []) as unknown[]),
    ...((Array.isArray(autopilotSessionMetadata.council_agent_ids) ? autopilotSessionMetadata.council_agent_ids : []) as unknown[]),
    latestMetadata.lead_agent_id,
    latestTurn.selected_agent,
    ...((Array.isArray(latestTurn.expected_agents) ? latestTurn.expected_agents : []) as unknown[]),
    ...((Array.isArray(latestMetadata.specialist_agent_ids) ? latestMetadata.specialist_agent_ids : []) as unknown[]),
    ...agentSessions.sessions.map((session) => session.agent_id),
    ...(((learning as Record<string, unknown>).top_agents as Array<Record<string, unknown>> | undefined) ?? []).map(
      (entry) => entry.agent_id
    ),
    ...defaultAgentIds,
  ]);
  return {
    default_agent_ids: defaultAgentIds,
    active_agent_ids: activeAgentIds,
    agents: getTriChatAgentCatalog().map((agent) => ({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
	      provider: agent.provider ?? null,
	      auth_mode: agent.auth_mode ?? null,
	      role_lane: agent.role_lane ?? "support",
	      coordination_tier: agent.coordination_tier ?? "support",
	      parent_agent_id: agent.parent_agent_id ?? "",
	      managed_agent_ids: agent.managed_agent_ids ?? [],
	      accent_color: agent.accent_color ?? "",
	      proxy_endpoint: agent.proxy_endpoint ?? "",
	      available_models: agent.available_models ?? [],
	      default_model: agent.default_model ?? "",
	      failover_regions: agent.failover_regions ?? [],
	      vertex_project_env_var: agent.vertex_project_env_var ?? "",
	      ollama_models: agent.ollama_models ?? [],
	      enabled: agent.enabled !== false,
	    })),
    source: "office.snapshot",
  };
}

function emptyKernelSignalOverview(): KernelSignalOverviewRecord {
  return {
    recent_runtime_events: [],
    runtime_event_summary: {
      count: 0,
      max_event_seq: 0,
      latest_created_at: null,
      event_type_counts: [],
      entity_type_counts: [],
    },
    recent_router_suppression_events: [],
    recent_federation_ingest_warning_events: [],
    incoming_federation_peers: [],
    observability_overview: {
      count: 0,
      latest_created_at: null,
      index_name_counts: [],
      source_kind_counts: [],
      level_counts: [],
      service_counts: [],
      host_counts: [],
      event_type_counts: [],
    },
    recent_observability_documents: [],
    recent_observability_alerts: [],
  };
}

function readOfficeSignalOverview(
  storage: Storage,
  params?: {
    include_kernel?: boolean;
    kernel_event_limit?: number;
    router_suppression_limit?: number;
    federation_warning_limit?: number;
  }
) {
  const kernelEventLimit =
    typeof params?.kernel_event_limit === "number" && Number.isFinite(params.kernel_event_limit)
      ? Math.max(0, Math.min(80, Math.trunc(params.kernel_event_limit)))
      : 12;
  const routerSuppressionLimit =
    typeof params?.router_suppression_limit === "number" && Number.isFinite(params.router_suppression_limit)
      ? Math.max(0, Math.min(200, Math.trunc(params.router_suppression_limit)))
      : 40;
  const federationWarningLimit =
    typeof params?.federation_warning_limit === "number" && Number.isFinite(params.federation_warning_limit)
      ? Math.max(0, Math.min(200, Math.trunc(params.federation_warning_limit)))
      : 50;
  const includeKernel = params?.include_kernel === true;
  const recentObservabilityWindow = new Date(Date.now() - 15 * 60_000).toISOString();
  return storage.getKernelSignalOverview({
    event_limit: includeKernel ? kernelEventLimit : 0,
    event_top_count_limit: includeKernel ? 12 : 0,
    router_suppression_limit: routerSuppressionLimit,
    federation_warning_limit: federationWarningLimit,
    observability_since: includeKernel ? recentObservabilityWindow : undefined,
    observability_recent_limit: includeKernel ? 6 : 0,
    observability_alert_limit: includeKernel ? 24 : 0,
    observability_top_count_limit: includeKernel ? 6 : 0,
  });
}

function buildKernelPayload(
  storage: Storage,
  summary: TaskSummaryPayload,
  sessions: AgentSessionListPayload,
  signalOverview?: KernelSignalOverviewRecord
) {
  return kernelSummary(
    storage,
    {
      session_limit: Math.max(8, sessions.count || 8),
      event_limit: 12,
      task_running_limit: Math.max(8, summary.running.length || 8),
    },
    signalOverview ? { signal_overview: signalOverview } : undefined
  );
}

function safeHostId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function knownWorkerFabricHostIds(kernel: Record<string, unknown>) {
  return new Set(
    asList(asRecord(asRecord(kernel).worker_fabric).hosts)
      .map((entry) => safeHostId(asRecord(entry).host_id))
      .filter(Boolean)
  );
}

function defaultSidecarStatePath(hostId: string) {
  const statePath = String(process.env.MASTER_MOLD_FEDERATION_STATE_PATH ?? "").trim();
  if (statePath) {
    return path.resolve(statePath);
  }
  return path.join(process.cwd(), "data", "federation", `${safeHostId(hostId) || "host"}-sidecar-state.json`);
}

function localFederationHostId(kernel: Record<string, unknown>) {
  const workerFabric = asRecord(asRecord(kernel).worker_fabric);
  const fromKernel = String(workerFabric.default_host_id ?? "").trim();
  const fromEnv = String(process.env.MASTER_MOLD_HOST_ID ?? "").trim();
  return safeHostId(fromEnv || fromKernel || os.hostname() || "local-host") || "local-host";
}

function readSidecarStateRecord(filePath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function finiteNumberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBytesForOffice(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function sidecarAgeSeconds(isoValue: unknown) {
  const text = String(isoValue ?? "").trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
}

function normalizeSidecarPeerUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function summarizeFederationSidecar(kernel: Record<string, unknown>) {
  const hostId = localFederationHostId(kernel);
  const statePath = defaultSidecarStatePath(hostId);
  const state = readSidecarStateRecord(statePath);
  const configuredPeers = new Set(asList(state.configured_peers).map(normalizeSidecarPeerUrl).filter(Boolean));
  const allPeerResults = Object.values(asRecord(state.peer_results))
    .map((entry) => asRecord(entry))
    .filter((entry) => Object.keys(entry).length > 0);
  const peerResults =
    configuredPeers.size > 0
      ? allPeerResults.filter((peer) => configuredPeers.has(normalizeSidecarPeerUrl(peer.peer)))
      : allPeerResults;
  const outbox = asList(state.outbox)
    .map((entry) => asRecord(entry))
    .filter((entry) => {
      if (String(entry.closed_at ?? "").trim()) {
        return false;
      }
      if (configuredPeers.size <= 0) {
        return true;
      }
      return asList(entry.pending_peers).some((peer) => configuredPeers.has(normalizeSidecarPeerUrl(peer)));
    });
  const pendingOutboxByPeer = new Map<string, number>();
  for (const entry of outbox) {
    for (const pendingPeer of asList(entry.pending_peers)) {
      const peerKey = normalizeSidecarPeerUrl(pendingPeer);
      if (!peerKey) {
        continue;
      }
      if (configuredPeers.size > 0 && !configuredPeers.has(peerKey)) {
        continue;
      }
      pendingOutboxByPeer.set(peerKey, (pendingOutboxByPeer.get(peerKey) ?? 0) + 1);
    }
  }
  const retryLedger = asList(state.retry_ledger).map((entry) => asRecord(entry));
  const lastCycleAt = String(state.last_cycle_at ?? "").trim() || null;
  const peers = peerResults.map((peer) => ({
    peer: String(peer.peer ?? "").trim(),
    last_attempt_at: String(peer.last_attempt_at ?? "").trim() || null,
    last_attempt_age_seconds: sidecarAgeSeconds(peer.last_attempt_at),
    last_publish_at: String(peer.last_ok_at ?? "").trim() || null,
    last_publish_age_seconds: sidecarAgeSeconds(peer.last_ok_at),
    last_ok: peer.last_ok === true,
    last_http_status: finiteNumberOrNull(peer.last_http_status),
    consecutive_failures: finiteNumberOrNull(peer.consecutive_failures) ?? 0,
    outbox_pending: pendingOutboxByPeer.get(normalizeSidecarPeerUrl(peer.peer)) ?? 0,
    resend_window_count: asList(peer.resend_window_sequences).length,
    retry_count: finiteNumberOrNull(peer.retry_count) ?? 0,
    next_retry_at: String(peer.next_retry_at ?? "").trim() || null,
    last_error: String(peer.last_error ?? "").trim() || null,
    ack_persisted_sequence: finiteNumberOrNull(peer.ack_persisted_sequence),
    ack_processed_sequence: finiteNumberOrNull(peer.ack_processed_sequence),
  }));
  const failingPeers = peers.filter((peer) => peer.last_ok !== true);
  const staleSeconds = 15 * 60;
  const lastCycleAge = sidecarAgeSeconds(lastCycleAt);
  const recencyState =
    lastCycleAt && lastCycleAge !== null && lastCycleAge <= staleSeconds
      ? "recent"
      : lastCycleAt
        ? "stale"
        : "not_seen";
  const runningState = failingPeers.length > 0 ? "failing" : recencyState;
  let nextRepairAction = "npm run federation:onboard -- --peer <peer-url>";
  if (lastCycleAt && failingPeers.length > 0) {
    nextRepairAction = "npm run federation:repair -- --action sidecar-stale";
  } else if (lastCycleAt && runningState === "stale") {
    nextRepairAction = "npm run federation:repair -- --action sidecar-stale";
  } else if (peers.length > 0 && failingPeers.length === 0) {
    nextRepairAction = "npm run federation:doctor";
  }
  return {
    host_id: hostId,
    present: fs.existsSync(statePath),
    state_path: statePath,
    running_state: runningState,
    last_cycle_at: lastCycleAt,
    last_cycle_age_seconds: lastCycleAge,
    last_cycle_ok: state.last_cycle_ok === true,
    sequence: finiteNumberOrNull(state.sequence),
    peer_count: peers.length,
    configured_peer_count: configuredPeers.size || peers.length,
    historical_peer_count: allPeerResults.length,
    ok_peer_count: peers.filter((peer) => peer.last_ok === true).length,
    failing_peer_count: failingPeers.length,
    outbox_depth: outbox.length,
    retry_ledger_count: retryLedger.length,
    last_error: failingPeers.map((peer) => peer.last_error).find(Boolean) ?? null,
    next_repair_action: nextRepairAction,
    peers,
  };
}

function buildFederationPayload(signalOverview: KernelSignalOverviewRecord, kernel: Record<string, unknown>) {
  const knownHostIds = knownWorkerFabricHostIds(kernel);
  const incomingPeers = (signalOverview.incoming_federation_peers ?? [])
    .filter((peer) => {
      const hostId = safeHostId(peer.host_id);
      return Boolean(hostId) && !knownHostIds.has(hostId) && String(peer.reason ?? "").trim() === "host_not_staged";
    })
    .sort((left, right) => Number(right.event_seq ?? 0) - Number(left.event_seq ?? 0))
    .map((peer) => ({
      host_id: safeHostId(peer.host_id),
      seen_at: peer.seen_at,
      age_seconds: peer.age_seconds,
      detail: peer.detail ?? "Verified peer is not staged in worker.fabric yet.",
      current_remote_address: peer.current_remote_address,
      captured_hostname: peer.captured_hostname,
      captured_agent_runtime: peer.captured_agent_runtime,
      captured_model_label: peer.captured_model_label,
    }));
  return {
    generated_at: new Date().toISOString(),
    incoming_peer_count: incomingPeers.length,
    incoming_peers: incomingPeers,
    sidecar: summarizeFederationSidecar(kernel),
  };
}

function buildRecentRouterSuppressionDecisions(events: RuntimeEventRecord[], params?: { limit?: number; max_age_seconds?: number }) {
  const limit =
    typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(12, Math.trunc(params.limit))) : 5;
  const maxAgeSeconds =
    typeof params?.max_age_seconds === "number" && Number.isFinite(params.max_age_seconds)
      ? Math.max(300, Math.trunc(params.max_age_seconds))
      : 21600;
  const now = Date.now();
  const entries: Array<Record<string, unknown>> = [];
  for (let index = events.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const event = events[index];
    const details = asRecord(event.details);
    const reason =
      details.model_router_auto_bridge_suppressed_for_resource_gate === true
        ? "laptop_pressure"
        : details.model_router_auto_bridge_suppressed_for_missing_local_attempt_evidence === true
          ? "local_evidence_missing"
          : details.model_router_auto_bridge_suppressed_for_local_first === true
            ? "local_first_required"
            : null;
    if (!reason) {
      continue;
    }
    const observedAt = String(event.created_at ?? "").trim() || null;
    const observedStamp = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (Number.isFinite(observedStamp) && now - observedStamp > maxAgeSeconds * 1000) {
      continue;
    }
    const gate = asRecord(details.model_router_resource_gate);
    entries.push({
      decision_id: String(details.model_router_suppression_decision_id ?? "").trim() || null,
      event_id: String(event.event_id ?? "").trim() || null,
      observed_at: observedAt,
      reason,
      selected_backend_id: String(details.model_router_backend_id ?? "").trim() || null,
      pressure_level: String(gate.severity ?? "").trim() || null,
      pressure_reason:
        String(details.model_router_auto_bridge_resource_gate_reason ?? gate.reason ?? "").trim() || null,
      suppressed_agent_ids: Array.isArray(details.model_router_auto_bridge_suppressed_agent_ids)
        ? [...new Set(details.model_router_auto_bridge_suppressed_agent_ids.map((entry) => String(entry ?? "").trim()).filter(Boolean))]
        : [],
      objective: String(details.objective ?? "").trim() || null,
    });
  }
  return entries;
}

export function computeOfficeSnapshot(storage: Storage, input: z.infer<typeof officeSnapshotSchema>) {
  const threadId = input.thread_id?.trim() || "ring-leader-main";
  const errors: string[] = [];
  const safe = <T>(label: string, fallback: () => T, read: () => T) => {
    try {
      return read();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback();
    }
  };

  const workboard = safe<WorkboardPayload>("workboard", () => trichatWorkboard(storage, { thread_id: threadId, limit: 1 }), () =>
    trichatWorkboard(storage, { thread_id: threadId, limit: input.turn_limit })
  );
  const taskSummaryPayload = safe<TaskSummaryPayload>("task_summary", () => taskSummary(storage, { running_limit: 8 }), () =>
    taskSummary(storage, { running_limit: Math.max(4, Math.min(24, input.task_limit)) })
  );
  const taskRunning = safe<TaskListPayload>("task_running", () => ({ status_filter: "running", count: 0, tasks: [] as TaskRecord[] }), () =>
    taskList(storage, { status: "running", limit: input.task_limit })
  );
  const taskPending = safe<TaskListPayload>("task_pending", () => ({ status_filter: "pending", count: 0, tasks: [] as TaskRecord[] }), () =>
    taskList(storage, { status: "pending", limit: input.task_limit })
  );
  const taskFailed = safe<TaskListPayload>("task_failed", () => ({ status_filter: "failed", count: 0, tasks: [] as TaskRecord[] }), () =>
    taskList(storage, { status: "failed", limit: input.task_limit })
  );
  const agentSessions = safe<AgentSessionListPayload>("agent_sessions", () => ({
    status_filter: null,
    agent_id_filter: null,
    client_kind_filter: null,
    active_only_filter: null,
    count: 0,
    sessions: [] as AgentSessionRecord[],
  }), () =>
    listAgentSessions(storage, { limit: input.session_limit })
  );
  const learning = input.include_learning
    ? safe<LearningPayload>("learning", () => ({
        generated_at: new Date().toISOString(),
        filter: { agent_id: null },
        total_entries: 0,
        active_entry_count: 0,
        suppressed_entry_count: 0,
        prefer_count: 0,
        avoid_count: 0,
        agent_count: 0,
        agents_with_active_entries: 0,
        kind_counts: {
          execution_pattern: 0,
          delegation_pattern: 0,
          verification_pattern: 0,
          failure_pattern: 0,
          guardrail: 0,
        },
        top_agents: [],
        recent_entries: [],
      }), () =>
        summarizeAgentLearning(storage, {
          limit: input.learning_limit,
          top_agents_limit: 8,
          recent_limit: 8,
        })
      )
    : {};
  const autopilot = safe<Record<string, unknown>>("autopilot", () => ({}), () => ({
    state: getAutopilotStatus(storage),
  }));
  const roster = safe("roster", () => ({
    default_agent_ids: getTriChatConfiguredDefaultAgentIds(),
    active_agent_ids: [] as string[],
    agents: getTriChatAgentCatalog().map((agent) => ({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
	      provider: agent.provider ?? null,
	      auth_mode: agent.auth_mode ?? null,
	      role_lane: agent.role_lane ?? "support",
	      coordination_tier: agent.coordination_tier ?? "support",
	      parent_agent_id: agent.parent_agent_id ?? "",
	      managed_agent_ids: agent.managed_agent_ids ?? [],
	      accent_color: agent.accent_color ?? "",
	      proxy_endpoint: agent.proxy_endpoint ?? "",
	      available_models: agent.available_models ?? [],
	      default_model: agent.default_model ?? "",
	      failover_regions: agent.failover_regions ?? [],
	      vertex_project_env_var: agent.vertex_project_env_var ?? "",
	      ollama_models: agent.ollama_models ?? [],
	      enabled: agent.enabled !== false,
	    })),
    source: "office.snapshot",
  }), () =>
    buildRosterPayload(workboard, agentSessions, learning, autopilot)
  );
  const tmuxState = safe("tmux", () => null, () => storage.getTriChatTmuxControllerState());
  const tmux = {
    generated_at: new Date().toISOString(),
    action: "status_cached",
    session_active: Boolean(tmuxState?.enabled),
    state: tmuxState ?? { enabled: false, tasks: [] },
    dashboard: summarizeTmuxDashboard(tmuxState),
  };
  const adapter = input.include_adapter
    ? safe<AdapterPayload>("adapter", () => ({
        generated_at: new Date().toISOString(),
        agent_id: null,
        channel: null,
        state_count: 0,
        states: [],
        summary: {
          total_channels: 0,
          open_channels: 0,
          total_trips: 0,
          total_successes: 0,
          total_turns: 0,
          total_degraded_turns: 0,
          newest_state_at: null,
          newest_event_at: null,
          newest_trip_opened_at: null,
          per_agent: [],
        } satisfies TriChatAdapterTelemetrySummaryRecord,
        recent_events: [],
        last_open_events: [],
      }), () =>
        trichatAdapterTelemetry(storage, { action: "status", include_events: true, event_limit: Math.min(12, input.event_limit) })
      )
    : {};
  const busTail = input.include_bus
    ? safe("bus_tail", () => ({ count: 0, thread_id: threadId, events: [] as unknown[] }), () => {
        const events = storage.listTriChatBusEvents({ thread_id: threadId, limit: input.event_limit });
        return {
          count: events.length,
          thread_id: threadId,
          events,
        };
      })
    : {};
  const trichatSummaryPayload = safe<TriChatSummaryPayload>("trichat_summary", () => ({
    generated_at: new Date().toISOString(),
    thread_counts: {
      active: 0,
      archived: 0,
      total: 0,
    },
    message_count: 0,
    oldest_message_at: null,
    newest_message_at: null,
    busiest_threads: [],
  }), () =>
    trichatSummary(storage, { busiest_limit: 6 })
  );
  const runtimeWorkers = input.include_runtime_workers
    ? safe<RuntimeWorkersPayload>("runtime_workers", () => ({
        count: 0,
        sessions: [] as RuntimeWorkerSessionRecord[],
        summary: {
          session_count: 0,
          active_count: 0,
          counts: {},
          latest_session: null,
        },
      } as RuntimeWorkersPayload), () =>
        summarizeRuntimeWorkers(storage, input.runtime_worker_limit)
      )
    : {};
  const signalOverview = safe<KernelSignalOverviewRecord>(
    "signal_overview",
    () => emptyKernelSignalOverview(),
    () =>
      readOfficeSignalOverview(storage, {
        include_kernel: input.include_kernel,
        kernel_event_limit: 12,
        router_suppression_limit: 40,
        federation_warning_limit: 50,
      })
  );
  const operatorBriefPayload = safe<OperatorBriefPayload>(
    "operator_brief",
    () => ({
      generated_at: new Date().toISOString(),
      thread_id: threadId,
      current_objective: null,
      goal: null,
      plan: null,
      step: null,
      task: null,
      ring_leader_session: null,
      runtime_worker_session: null,
      delegation_brief: {
        delegate_agent_id: null,
        task_objective: null,
        success_criteria: [],
        evidence_requirements: [],
        rollback_notes: [],
      },
      compile_brief_artifact: null,
      runtime_brief_markdown: null,
      execution_backlog: [],
      kernel: null,
      brief_markdown: "# Operator Brief\n\nNo active operator brief available.",
      source: "operator.brief",
    } as unknown as OperatorBriefPayload),
    () =>
      operatorBrief(storage, {
        thread_id: threadId,
        include_kernel: false,
        include_runtime_brief: false,
        include_compile_brief: true,
        compact: true,
      }, { signal_overview: signalOverview })
  );
  const autonomyMaintain = safe("autonomy_maintain", () => summarizeAutonomyMaintainState(storage), () =>
    summarizeAutonomyMaintainState(storage)
  );
  const autonomyMaintainState = asRecord(autonomyMaintain.state);
  const selectedProviderBridgeDiagnostics = safe(
    "provider_bridge_diagnostics",
    () => buildPersistedProviderBridgeDiagnostics(autonomyMaintainState),
    () => buildOfficeProviderBridgeDiagnostics(autonomyMaintainState, input)
  );
  const providerBridge = safe<ProviderBridgePayload>(
    "provider_bridge",
    () => ({
      snapshot: applyProviderBridgeDiagnosticsToSnapshot(
        resolveProviderBridgeSnapshot({ workspace_root: process.cwd() }),
        selectedProviderBridgeDiagnostics
      ),
      diagnostics: selectedProviderBridgeDiagnostics,
    }),
    () => ({
      snapshot: applyProviderBridgeDiagnosticsToSnapshot(
        resolveProviderBridgeSnapshot({ workspace_root: process.cwd() }),
        selectedProviderBridgeDiagnostics
      ),
      diagnostics: selectedProviderBridgeDiagnostics,
    })
  );
  const routerSuppressionDecisions = buildRecentRouterSuppressionDecisions(signalOverview.recent_router_suppression_events);
  const providerBridgeOnboarding = buildProviderBridgeOnboardingSummary({
    clients: providerBridge.snapshot.clients,
    diagnostics: providerBridge.diagnostics.diagnostics,
    server_name: providerBridge.snapshot.server_name,
    generated_at: providerBridge.diagnostics.generated_at,
    diagnostics_stale: providerBridge.diagnostics.stale ?? false,
  });
  const kernel = input.include_kernel
    ? safe("kernel", () => buildKernelPayload(storage, taskSummaryPayload, agentSessions, signalOverview), () =>
        buildKernelPayload(storage, taskSummaryPayload, agentSessions, signalOverview)
      )
    : {};
  const federation = safe("federation", () => buildFederationPayload(signalOverview, asRecord(kernel)), () =>
    buildFederationPayload(signalOverview, asRecord(kernel))
  );
  const providerReadyAgentIds =
    selectedProviderBridgeDiagnostics.stale === true
      ? []
      : providerBridge.diagnostics.diagnostics
          .filter((entry) => entry.status === "connected")
          .map((entry) => String(entry.office_agent_id || "").trim().toLowerCase())
          .filter(Boolean);
  if (providerReadyAgentIds.length) {
    const rosterPayload = roster as Record<string, unknown>;
    const activeAgentIds = Array.isArray(rosterPayload.active_agent_ids) ? (rosterPayload.active_agent_ids as unknown[]) : [];
    rosterPayload.active_agent_ids = dedupeAgentIds([...activeAgentIds, ...providerReadyAgentIds]);
  }

  const desktopControlState = storage.getDesktopControlState();
  const desktopControl = {
    state: desktopControlState,
    summary: summarizeDesktopControlState(desktopControlState),
  };
  const patientZeroState = storage.getPatientZeroState();
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const patientZero = {
    state: patientZeroState,
    summary: summarizePatientZeroState(patientZeroState, desktopControlState, privilegedAccess.summary as Record<string, unknown>),
    report: buildPatientZeroOfficeReport(storage),
  };
  const setupDiagnostics = buildOfficeSetupDiagnostics({
    kernel: asRecord(kernel),
    providerBridge: {
      ...providerBridge,
      onboarding: providerBridgeOnboarding,
    },
    desktopControl,
    patientZero,
  });
  const workbench = buildWorkbenchSummary({
    taskSummaryPayload,
    taskRunning,
    taskPending,
    taskFailed,
    operatorBriefPayload,
    kernel: asRecord(kernel),
    setupDiagnostics: asRecord(setupDiagnostics),
    providerBridge,
    desktopControl,
    patientZero,
    privilegedAccess,
  });
  return {
    generated_at: new Date().toISOString(),
    thread_id: threadId,
    errors,
    roster,
    workboard,
    tmux,
    task_summary: taskSummaryPayload,
    task_running: taskRunning,
    task_pending: taskPending,
    agent_sessions: agentSessions,
    adapter,
    bus_tail: busTail,
    trichat_summary: trichatSummaryPayload,
    kernel,
    learning,
    autopilot,
    autonomy_maintain: autonomyMaintain,
    runtime_workers: runtimeWorkers,
    operator_brief: operatorBriefPayload,
    provider_bridge: {
      ...providerBridge,
      onboarding: providerBridgeOnboarding,
      latest_router_suppression: routerSuppressionDecisions[0] ?? null,
    },
    desktop_control: desktopControl,
    patient_zero: patientZero,
    privileged_access: privilegedAccess,
    setup_diagnostics: setupDiagnostics,
    federation,
    workbench,
    router_suppression_decisions: routerSuppressionDecisions,
    source: "office.snapshot",
  };
}

export function officeSnapshot(storage: Storage, input: z.infer<typeof officeSnapshotSchema>) {
  const threadId = input.thread_id?.trim() || OFFICE_SNAPSHOT_DEFAULT_THREAD_ID;
  const warmCacheState = storage.getWarmCacheState();
  if (isDefaultOfficeSnapshotRequest(input)) {
    const cached = readWarmCacheEntry(officeSnapshotWarmCacheKey(threadId), warmCacheState.ttl_seconds * 1000);
    if (cached && cached.payload && typeof cached.payload === "object" && !Array.isArray(cached.payload)) {
      const liveAutonomyMaintain = summarizeAutonomyMaintainState(storage);
      const liveAutonomyMaintainState = asRecord(liveAutonomyMaintain.state);
      const liveDesktopControlState = storage.getDesktopControlState();
      const liveDesktopControl = {
        state: liveDesktopControlState,
        summary: summarizeDesktopControlState(liveDesktopControlState),
      };
      const livePatientZeroState = storage.getPatientZeroState();
      const livePrivilegedAccess = buildPrivilegedAccessStatus(storage);
      const livePatientZero = {
        state: livePatientZeroState,
        summary: summarizePatientZeroState(
          livePatientZeroState,
          liveDesktopControlState,
          livePrivilegedAccess.summary as Record<string, unknown>
        ),
        report: buildPatientZeroOfficeReport(storage),
      };
      const cachedPayload = cached.payload as Record<string, unknown>;
      const cachedKernel = asRecord(cachedPayload.kernel);
      const cachedProviderBridge = asRecord(cachedPayload.provider_bridge);
      const cachedProviderBridgeSnapshot = asRecord(cachedProviderBridge.snapshot);
      const liveProviderBridgeDiagnostics = buildPersistedProviderBridgeDiagnostics(liveAutonomyMaintainState);
      const liveSignalOverview = readOfficeSignalOverview(storage, {
        include_kernel: false,
        router_suppression_limit: 40,
        federation_warning_limit: 50,
      });
      const liveRouterSuppressionDecisions = buildRecentRouterSuppressionDecisions(
        liveSignalOverview.recent_router_suppression_events
      );
      const liveProviderBridgeSnapshot = applyProviderBridgeDiagnosticsToSnapshot(
        {
          ...cachedProviderBridgeSnapshot,
          clients: Array.isArray(cachedProviderBridgeSnapshot.clients) ? cachedProviderBridgeSnapshot.clients : [],
          server_name: String(cachedProviderBridgeSnapshot.server_name ?? "master-mold"),
        } as ProviderBridgePayload["snapshot"],
        liveProviderBridgeDiagnostics
      );
      const cachedProviderBridgePayload = {
        snapshot: liveProviderBridgeSnapshot,
        diagnostics: liveProviderBridgeDiagnostics,
        onboarding: buildProviderBridgeOnboardingSummary({
          clients: liveProviderBridgeSnapshot.clients,
          diagnostics: liveProviderBridgeDiagnostics.diagnostics,
          server_name: String(liveProviderBridgeSnapshot.server_name ?? "master-mold"),
          generated_at: liveProviderBridgeDiagnostics.generated_at,
          diagnostics_stale: liveProviderBridgeDiagnostics.stale === true,
        }),
        latest_router_suppression: liveRouterSuppressionDecisions[0] ?? null,
      };
      const liveFederation = buildFederationPayload(liveSignalOverview, cachedKernel);
      const liveRoster = reconcileRosterProviderBridgeReadiness(asRecord(cachedPayload.roster), cachedProviderBridgePayload);
      const liveSetupDiagnostics = buildOfficeSetupDiagnostics({
        kernel: cachedKernel,
        providerBridge: cachedProviderBridgePayload,
        desktopControl: liveDesktopControl,
        patientZero: livePatientZero,
      });
      const liveWorkbench = buildWorkbenchSummary({
        taskSummaryPayload: asRecord(cachedPayload.task_summary) as TaskSummaryPayload,
        taskRunning: asRecord(cachedPayload.task_running) as TaskListPayload,
        taskPending: asRecord(cachedPayload.task_pending) as TaskListPayload,
        taskFailed: asRecord(cachedPayload.task_failed) as TaskListPayload,
        operatorBriefPayload: asRecord(cachedPayload.operator_brief) as OperatorBriefPayload,
        kernel: cachedKernel,
        setupDiagnostics: asRecord(liveSetupDiagnostics),
        providerBridge: cachedProviderBridgePayload,
        desktopControl: liveDesktopControl,
        patientZero: livePatientZero,
        privilegedAccess: livePrivilegedAccess,
      });
      return {
        ...cachedPayload,
        roster: liveRoster,
        kernel: {
          ...cachedKernel,
          desktop_control: liveDesktopControl,
          patient_zero: livePatientZero,
          privileged_access: livePrivilegedAccess,
        },
        autonomy_maintain: liveAutonomyMaintain,
        provider_bridge: cachedProviderBridgePayload,
        desktop_control: liveDesktopControl,
        patient_zero: livePatientZero,
        privileged_access: livePrivilegedAccess,
        setup_diagnostics: liveSetupDiagnostics,
        federation: liveFederation,
        workbench: liveWorkbench,
        router_suppression_decisions: liveRouterSuppressionDecisions,
        cache: {
          hit: true,
          key: cached.key,
          warmed_at: cached.warmed_at,
          duration_ms: cached.duration_ms,
        },
      };
    }
  }

  return {
    ...computeOfficeSnapshot(storage, input),
    cache: {
      hit: false,
      key: null,
      warmed_at: null,
      duration_ms: null,
    },
  };
}

export function officeRealtimeSnapshot(storage: Storage, input: { thread_id?: string; theme: string }) {
  const threadId = input.thread_id?.trim() || OFFICE_SNAPSHOT_DEFAULT_THREAD_ID;
  const warmCacheState = storage.getWarmCacheState();
  const cached = readWarmCacheEntry(officeSnapshotWarmCacheKey(threadId), warmCacheState.ttl_seconds * 1000);
  if (cached && cached.payload && typeof cached.payload === "object" && !Array.isArray(cached.payload)) {
    const cachedPayload = cached.payload as Record<string, unknown>;
    const liveAutonomyMaintain = summarizeAutonomyMaintainState(storage);
    const liveAutonomyMaintainState = asRecord(liveAutonomyMaintain.state);
    const cachedProviderBridge = asRecord(cachedPayload.provider_bridge);
    const cachedProviderBridgeSnapshot = asRecord(cachedProviderBridge.snapshot);
    const liveProviderBridgeDiagnostics = buildPersistedProviderBridgeDiagnostics(liveAutonomyMaintainState);
    const liveSignalOverview = readOfficeSignalOverview(storage, {
      include_kernel: false,
      router_suppression_limit: 40,
      federation_warning_limit: 50,
    });
    const liveRouterSuppressionDecisions = buildRecentRouterSuppressionDecisions(
      liveSignalOverview.recent_router_suppression_events,
      { limit: 1 }
    );
    const liveProviderBridgeSnapshot = applyProviderBridgeDiagnosticsToSnapshot(
      {
        ...cachedProviderBridgeSnapshot,
        clients: Array.isArray(cachedProviderBridgeSnapshot.clients) ? cachedProviderBridgeSnapshot.clients : [],
        server_name: String(cachedProviderBridgeSnapshot.server_name ?? "master-mold"),
      } as ProviderBridgePayload["snapshot"],
      liveProviderBridgeDiagnostics
    );
    const liveProviderBridgePayload = {
      ...cachedProviderBridge,
      snapshot: liveProviderBridgeSnapshot,
      diagnostics: liveProviderBridgeDiagnostics,
      onboarding:
        cachedProviderBridge.onboarding && typeof cachedProviderBridge.onboarding === "object"
          ? cachedProviderBridge.onboarding
          : {},
      latest_router_suppression: liveRouterSuppressionDecisions[0] ?? cachedProviderBridge.latest_router_suppression ?? null,
    };
    const liveFederation = buildFederationPayload(liveSignalOverview, asRecord(cachedPayload.kernel));
    const liveRoster = reconcileRosterProviderBridgeReadiness(asRecord(cachedPayload.roster), liveProviderBridgePayload);
    return buildOfficeGuiSnapshot(
      {
        ...cachedPayload,
        roster: liveRoster,
        autonomy_maintain: {
          ...asRecord(cachedPayload.autonomy_maintain),
          ...(liveAutonomyMaintain as Record<string, unknown>),
        },
        provider_bridge: liveProviderBridgePayload,
        federation: liveFederation,
        source: "office.realtime",
      },
      { theme: input.theme }
    );
  }

  return buildOfficeGuiSnapshot(
    officeSnapshot(storage, {
      thread_id: threadId,
      turn_limit: 12,
      task_limit: 24,
      session_limit: 50,
      event_limit: 24,
      learning_limit: 120,
      runtime_worker_limit: 20,
      include_kernel: true,
      include_learning: true,
      include_bus: true,
      include_adapter: true,
      include_runtime_workers: true,
      metadata: { source: "http.realtime" },
    }) as Record<string, unknown>,
    { theme: input.theme }
  );
}
