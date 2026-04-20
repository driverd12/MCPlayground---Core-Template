import fs from "node:fs";
import { z } from "zod";
import {
  type AgentSessionRecord,
  type ArtifactRecord,
  type GoalRecord,
  type PlanRecord,
  type PlanStepRecord,
  type RuntimeWorkerSessionRecord,
  type TaskRecord,
  Storage,
} from "../storage.js";
import { resolvePermissionProfileChain } from "../control_plane_runtime.js";
import { kernelSummary } from "./kernel.js";

export const operatorBriefSchema = z.object({
  thread_id: z.string().min(1).optional(),
  include_kernel: z.boolean().default(true),
  include_runtime_brief: z.boolean().default(true),
  include_compile_brief: z.boolean().default(true),
  compact: z.boolean().default(false),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
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

function normalizeAgentId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function pickRingLeaderSession(sessions: AgentSessionRecord[], threadId: string | null) {
  const ranked = sessions
    .filter((session) => session.status !== "closed" && session.status !== "failed")
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  return (
    ranked.find(
      (session) =>
        normalizeAgentId(session.agent_id) === "ring-leader" &&
        (!threadId || readString(session.metadata.thread_id) === threadId)
    ) ??
    ranked.find((session) => normalizeAgentId(session.agent_id) === "ring-leader") ??
    null
  );
}

function metadataMatchesThread(metadata: unknown, threadId: string | null) {
  if (!threadId || !isRecord(metadata)) {
    return false;
  }
  const candidateThreadIds = [
    readString(metadata.thread_id),
    readString(metadata.ingress_thread_id),
    readString(metadata.default_thread_id),
    readString(metadata.source_thread_id),
  ].filter(Boolean);
  return candidateThreadIds.includes(threadId);
}

function taskMatchesThread(task: TaskRecord | null, threadId: string | null) {
  if (!task) {
    return false;
  }
  return (
    metadataMatchesThread(task.metadata, threadId) ||
    metadataMatchesThread(task.payload, threadId) ||
    readString(task.metadata.thread_id) === threadId ||
    readString(task.payload.thread_id) === threadId
  );
}

function pickActiveGoal(storage: Storage, threadId: string | null) {
  const activeGoals = storage.listGoals({ status: "active", limit: 25 });
  if (threadId) {
    const threadScoped = activeGoals.filter((goal) => metadataMatchesThread(goal.metadata, threadId));
    if (threadScoped.length > 0) {
      return threadScoped[0] ?? null;
    }
  }
  return activeGoals[0] ?? null;
}

function pickActivePlan(storage: Storage, goal: GoalRecord | null, threadId: string | null) {
  if (!goal) {
    return null;
  }
  const candidatePlans = storage.listPlans({ goal_id: goal.goal_id, selected_only: true, limit: 10 });
  if (threadId) {
    const threadScopedSelected = candidatePlans.find((plan) => metadataMatchesThread(plan.metadata, threadId));
    if (threadScopedSelected) {
      return threadScopedSelected;
    }
    const activePlan = goal.active_plan_id ? storage.getPlanById(goal.active_plan_id) : null;
    if (activePlan && metadataMatchesThread(activePlan.metadata, threadId)) {
      return activePlan;
    }
  }
  return (
    (goal.active_plan_id ? storage.getPlanById(goal.active_plan_id) : null) ??
    candidatePlans[0] ??
    null
  );
}

function pickCurrentStep(storage: Storage, plan: PlanRecord | null) {
  if (!plan) {
    return null;
  }
  const steps = storage.listPlanSteps(plan.plan_id);
  return (
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "ready") ??
    steps.find((step) => step.status === "pending") ??
    steps[0] ??
    null
  );
}

function pickCurrentTask(storage: Storage, step: PlanStepRecord | null) {
  if (step?.task_id) {
    return storage.getTaskById(step.task_id);
  }
  return storage.listTasks({ status: "running", limit: 10 })[0] ?? storage.listTasks({ status: "pending", limit: 10 })[0] ?? null;
}

function pickThreadScopedTask(
  storage: Storage,
  threadId: string | null,
  ringLeaderSession: AgentSessionRecord | null,
  currentStep: PlanStepRecord | null
) {
  if (currentStep?.task_id) {
    const currentTask = storage.getTaskById(currentStep.task_id);
    if (currentTask) {
      return currentTask;
    }
  }
  const sessionMetadata = isRecord(ringLeaderSession?.metadata) ? ringLeaderSession!.metadata : {};
  const hintedTaskIds = [
    readString(sessionMetadata.current_task_id),
    readString(sessionMetadata.last_claimed_task_id),
    readString(sessionMetadata.last_reported_task_id),
    ...readStringArray(sessionMetadata.last_execution_task_ids),
  ].filter(Boolean) as string[];
  for (const taskId of hintedTaskIds) {
    const task = storage.getTaskById(taskId);
    if (task && (!threadId || taskMatchesThread(task, threadId))) {
      return task;
    }
  }
  const runningTasks = storage.listTasks({ status: "running", limit: 25 });
  const pendingTasks = storage.listTasks({ status: "pending", limit: 25 });
  if (threadId) {
    return [...runningTasks, ...pendingTasks].find((task) => taskMatchesThread(task, threadId)) ?? null;
  }
  return runningTasks[0] ?? pendingTasks[0] ?? null;
}

function resolvePlanContext(
  storage: Storage,
  threadId: string | null,
  ringLeaderSession: AgentSessionRecord | null
) {
  let task: TaskRecord | null = null;
  let step: PlanStepRecord | null = null;
  let plan: PlanRecord | null = null;
  let goal: GoalRecord | null = null;

  task = pickThreadScopedTask(storage, threadId, ringLeaderSession, null);
  if (task) {
    const mapped = storage.findPlanStepByTaskId(task.task_id);
    if (mapped) {
      plan = mapped.plan;
      step = mapped.step;
      goal = storage.getGoalById(mapped.plan.goal_id);
    }
  }

  if (!goal) {
    goal = pickActiveGoal(storage, threadId);
  }
  if (!plan) {
    plan = pickActivePlan(storage, goal, threadId);
  }
  if (!step) {
    step = pickCurrentStep(storage, plan);
  }
  if (!task) {
    task = pickCurrentTask(storage, step);
  }

  return { goal, plan, step, task };
}

function pickRuntimeSession(storage: Storage, task: TaskRecord | null) {
  const sessions = task?.task_id
    ? storage.listRuntimeWorkerSessions({ task_id: task.task_id, limit: 10 })
    : storage.listRuntimeWorkerSessions({ limit: 10 });
  return (
    sessions.find((session) => session.status === "running") ??
    sessions.find((session) => session.status === "idle") ??
    sessions.find((session) => session.status === "launching") ??
    sessions[0] ??
    null
  );
}

function pickCompileBriefArtifact(storage: Storage, plan: PlanRecord | null, goal: GoalRecord | null): ArtifactRecord | null {
  if (plan) {
    return storage.listArtifacts({ plan_id: plan.plan_id, artifact_type: "compile.brief", limit: 1 })[0] ?? null;
  }
  if (goal) {
    return storage.listArtifacts({ goal_id: goal.goal_id, artifact_type: "compile.brief", limit: 1 })[0] ?? null;
  }
  return null;
}

function extractDelegationBrief(task: TaskRecord | null, ringLeaderSession: AgentSessionRecord | null) {
  const taskPayload = isRecord(task?.payload) ? task!.payload : {};
  const taskMetadata = isRecord(task?.metadata) ? task!.metadata : {};
  const sessionMetadata = isRecord(ringLeaderSession?.metadata) ? ringLeaderSession!.metadata : {};
  const nested =
    (isRecord(taskPayload.delegation_brief) ? taskPayload.delegation_brief : null) ??
    (isRecord(taskMetadata.delegation_brief) ? taskMetadata.delegation_brief : null) ??
    (isRecord(sessionMetadata.last_selected_delegation_brief) ? sessionMetadata.last_selected_delegation_brief : null);
  return {
    delegate_agent_id: readString(nested?.delegate_agent_id) ?? null,
    task_objective: readString(nested?.task_objective) ?? null,
    success_criteria: readStringArray(nested?.success_criteria),
    evidence_requirements: readStringArray(nested?.evidence_requirements),
    rollback_notes: readStringArray(nested?.rollback_notes),
  };
}

function readRuntimeBrief(runtimeSession: RuntimeWorkerSessionRecord | null, enabled: boolean) {
  if (!enabled || !runtimeSession?.brief_path) {
    return null;
  }
  try {
    return fs.readFileSync(runtimeSession.brief_path, "utf8");
  } catch {
    return null;
  }
}

function renderBulletSection(title: string, items: string[]) {
  if (items.length === 0) {
    return `${title}\n- none`;
  }
  return [title, ...items.map((item) => `- ${item}`)].join("\n");
}

function summarizeGoal(goal: GoalRecord | null) {
  if (!goal) {
    return null;
  }
  return {
    goal_id: goal.goal_id,
    title: goal.title,
    status: goal.status,
    autonomy_mode: goal.autonomy_mode,
    active_plan_id: goal.active_plan_id,
  };
}

function summarizePlan(plan: PlanRecord | null) {
  if (!plan) {
    return null;
  }
  return {
    plan_id: plan.plan_id,
    goal_id: plan.goal_id,
    title: plan.title,
    status: plan.status,
    selected: plan.selected,
  };
}

function summarizeStep(step: PlanStepRecord | null) {
  if (!step) {
    return null;
  }
  return {
    step_id: step.step_id,
    plan_id: step.plan_id,
    title: step.title,
    status: step.status,
    task_id: step.task_id,
    executor_kind: step.executor_kind,
    executor_ref: step.executor_ref,
  };
}

function summarizeTask(task: TaskRecord | null) {
  if (!task) {
    return null;
  }
  return {
    task_id: task.task_id,
    status: task.status,
    objective: task.objective,
    project_dir: task.project_dir,
    source_agent: task.source_agent,
  };
}

function summarizeSession(session: AgentSessionRecord | RuntimeWorkerSessionRecord | null) {
  if (!session) {
    return null;
  }
  return {
    session_id: session.session_id,
    status: session.status,
    updated_at: session.updated_at,
    agent_id: "agent_id" in session ? session.agent_id : null,
    runtime_id: "runtime_id" in session ? session.runtime_id : null,
    task_id: "task_id" in session ? session.task_id : null,
    goal_id: "goal_id" in session ? session.goal_id : null,
    plan_id: "plan_id" in session ? session.plan_id : null,
    step_id: "step_id" in session ? session.step_id : null,
  };
}

function summarizeKernel(kernel: ReturnType<typeof kernelSummary> | null) {
  if (!kernel) {
    return null;
  }
  const overview = (isRecord(kernel.overview) ? kernel.overview : {}) as Record<string, unknown>;
  return {
    state: kernel.state,
    attention: Array.isArray(kernel.attention) ? kernel.attention : [],
    active_session_count: overview.active_session_count ?? null,
    task_counts: isRecord(overview.task_counts) ? overview.task_counts : {},
    ready_step_count: overview.ready_step_count ?? null,
  };
}

function summarizeControlPlane(
  storage: Storage,
  kernel: ReturnType<typeof kernelSummary> | null,
  params: {
    goal: GoalRecord | null;
    plan: PlanRecord | null;
    step: PlanStepRecord | null;
    task: TaskRecord | null;
    session: AgentSessionRecord | null;
  }
) {
  const permission = resolvePermissionProfileChain(storage, {
    goal_id: params.goal?.goal_id,
    plan_id: params.plan?.plan_id,
    step_id: params.step?.step_id,
    task_id: params.task?.task_id,
    session_id: params.session?.session_id,
  });
  const budgetLedgerRecord: Record<string, unknown> = isRecord(kernel?.budget_ledger) ? kernel!.budget_ledger : {};
  const warmCacheRecord: Record<string, unknown> = isRecord(kernel?.warm_cache) ? kernel!.warm_cache : {};
  const featureFlagsRecord: Record<string, unknown> = isRecord(kernel?.feature_flags) ? kernel!.feature_flags : {};
  const desktopControlRecord: Record<string, unknown> = isRecord(kernel?.desktop_control) ? kernel!.desktop_control : {};
  const patientZeroRecord: Record<string, unknown> = isRecord(kernel?.patient_zero) ? kernel!.patient_zero : {};
  const privilegedAccessRecord: Record<string, unknown> = isRecord(kernel?.privileged_access) ? kernel!.privileged_access : {};
  const desktopControlSummaryRecord: Record<string, unknown> = isRecord(desktopControlRecord.summary)
    ? desktopControlRecord.summary
    : {};
  const patientZeroSummaryRecord: Record<string, unknown> = isRecord(patientZeroRecord.summary) ? patientZeroRecord.summary : {};
  const privilegedAccessSummaryRecord: Record<string, unknown> = isRecord(privilegedAccessRecord.summary)
    ? privilegedAccessRecord.summary
    : {};
  const budgetLedger = {
    total_entries: Number(budgetLedgerRecord.total_entries ?? 0),
    projected_cost_usd: Number(budgetLedgerRecord.projected_cost_usd ?? 0),
    actual_cost_usd: Number(budgetLedgerRecord.actual_cost_usd ?? 0),
    tokens_total: Number(budgetLedgerRecord.tokens_total ?? 0),
  };
  const warmCacheState = isRecord(warmCacheRecord.state) ? warmCacheRecord.state : null;
  const warmCache = {
    enabled: typeof warmCacheState?.enabled === "boolean"
      ? warmCacheState.enabled
      : typeof warmCacheRecord.enabled === "boolean"
        ? warmCacheRecord.enabled
        : null,
    stale: typeof warmCacheRecord.stale === "boolean" ? warmCacheRecord.stale : null,
  };
  const featureFlags = {
    disabled_count: Number(featureFlagsRecord.disabled_count ?? 0),
    total_count: Number(featureFlagsRecord.total_count ?? 0),
  };
  const desktopControl = {
    enabled: typeof desktopControlSummaryRecord.enabled === "boolean" ? desktopControlSummaryRecord.enabled : false,
    stale: typeof desktopControlSummaryRecord.stale === "boolean" ? desktopControlSummaryRecord.stale : false,
    observe_ready:
      typeof desktopControlSummaryRecord.observe_ready === "boolean" ? desktopControlSummaryRecord.observe_ready : false,
    act_ready: typeof desktopControlSummaryRecord.act_ready === "boolean" ? desktopControlSummaryRecord.act_ready : false,
    listen_ready:
      typeof desktopControlSummaryRecord.listen_ready === "boolean" ? desktopControlSummaryRecord.listen_ready : false,
    last_frontmost_app: readString(desktopControlSummaryRecord.last_frontmost_app),
  };
  const patientZero = {
    enabled: typeof patientZeroSummaryRecord.enabled === "boolean" ? patientZeroSummaryRecord.enabled : false,
    posture: readString(patientZeroSummaryRecord.posture) ?? "standby",
    permission_profile: readString(patientZeroSummaryRecord.permission_profile) ?? "high_risk",
    autonomy_enabled:
      typeof patientZeroSummaryRecord.autonomy_enabled === "boolean" ? patientZeroSummaryRecord.autonomy_enabled : false,
    browser_ready: typeof patientZeroSummaryRecord.browser_ready === "boolean" ? patientZeroSummaryRecord.browser_ready : false,
    root_shell_enabled:
      typeof patientZeroSummaryRecord.root_shell_enabled === "boolean" ? patientZeroSummaryRecord.root_shell_enabled : false,
  };
  const privilegedAccess = {
    root_execution_ready:
      typeof privilegedAccessSummaryRecord.root_execution_ready === "boolean"
        ? privilegedAccessSummaryRecord.root_execution_ready
        : false,
    account: readString(privilegedAccessSummaryRecord.account) ?? "mcagent",
    patient_zero_armed:
      typeof privilegedAccessSummaryRecord.patient_zero_armed === "boolean"
        ? privilegedAccessSummaryRecord.patient_zero_armed
        : false,
    secret_present:
      typeof privilegedAccessSummaryRecord.secret_present === "boolean"
        ? privilegedAccessSummaryRecord.secret_present
        : false,
    helper_ready:
      typeof privilegedAccessSummaryRecord.helper_ready === "boolean"
        ? privilegedAccessSummaryRecord.helper_ready
        : false,
    credential_verified:
      typeof privilegedAccessSummaryRecord.credential_verified === "boolean"
        ? privilegedAccessSummaryRecord.credential_verified
        : false,
    last_verification_error: readString(privilegedAccessSummaryRecord.last_verification_error),
  };
  return {
    permission_profile: permission.resolved_profile_id,
    permission_chain: permission.chain,
    budget_ledger: budgetLedger,
    warm_cache: warmCache,
    feature_flags: featureFlags,
    desktop_control: desktopControl,
    patient_zero: patientZero,
    privileged_access: privilegedAccess,
  };
}

function buildRecentRouterSuppressionDecisions(storage: Storage, params?: { limit?: number; max_age_seconds?: number }) {
  const limit =
    typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(8, Math.trunc(params.limit))) : 5;
  const maxAgeSeconds =
    typeof params?.max_age_seconds === "number" && Number.isFinite(params.max_age_seconds)
      ? Math.max(300, Math.trunc(params.max_age_seconds))
      : 21600;
  const now = Date.now();
  const events = storage.listRuntimeEvents({
    event_type: "autonomy.command",
    limit: Math.max(40, limit * 10),
  });
  const entries: Array<{
    decision_id: string | null;
    observed_at: string | null;
    reason: "local_first_required" | "local_evidence_missing" | "laptop_pressure";
    selected_backend_id: string | null;
    pressure_level: string | null;
    suppressed_agent_ids: string[];
  }> = [];
  for (let index = events.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const event = events[index];
    const details = isRecord(event.details) ? event.details : {};
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
    const observedAt = readString(event.created_at);
    const observedStamp = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (Number.isFinite(observedStamp) && now - observedStamp > maxAgeSeconds * 1000) {
      continue;
    }
    entries.push({
      decision_id: readString(details.model_router_suppression_decision_id),
      observed_at: observedAt,
      reason,
      selected_backend_id: readString(details.model_router_backend_id),
      pressure_level: readString(isRecord(details.model_router_resource_gate) ? details.model_router_resource_gate.severity : null),
      suppressed_agent_ids: readStringArray(details.model_router_auto_bridge_suppressed_agent_ids),
    });
  }
  return entries;
}

export function operatorBrief(storage: Storage, input: z.infer<typeof operatorBriefSchema>) {
  const threadId = input.thread_id?.trim() || null;
  const sessions = storage.listAgentSessions({ limit: 50 });
  const ringLeaderSession = pickRingLeaderSession(sessions, threadId);
  const { goal, plan, step, task } = resolvePlanContext(storage, threadId, ringLeaderSession);
  const runtimeSession = pickRuntimeSession(storage, task);
  const compileBriefArtifact = input.include_compile_brief ? pickCompileBriefArtifact(storage, plan, goal) : null;
  const delegationBrief = extractDelegationBrief(task, ringLeaderSession);
  const runtimeBrief = readRuntimeBrief(runtimeSession, input.include_runtime_brief);
  const kernel = input.include_kernel
    ? kernelSummary(storage, {
        session_limit: 12,
        event_limit: 12,
        task_running_limit: 12,
      })
    : null;
  const ringLeaderStatus = String(ringLeaderSession?.status ?? "")
    .trim()
    .toLowerCase();
  const ringLeaderAppearsActive = ["active", "busy", "running", "supervising", "working"].includes(ringLeaderStatus);
  const currentObjective =
    task?.objective ??
    goal?.objective ??
    delegationBrief.task_objective ??
    (ringLeaderAppearsActive ? readString(ringLeaderSession?.metadata.last_source_task_objective) : null) ??
    null;
  const executionBacklog = readStringArray(ringLeaderSession?.metadata.last_execution_task_ids);
  const runningTasks = storage.listTasks({ status: "running", limit: 25 });
  const pendingTasks = storage.listTasks({ status: "pending", limit: 25 });
  const routerSuppressionDecisions = buildRecentRouterSuppressionDecisions(storage);
  const controlPlaneSummary = summarizeControlPlane(storage, kernel, {
    goal,
    plan,
    step,
    task,
    session: ringLeaderSession,
  });

  const briefMarkdown = [
    "# Operator Brief",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Status",
    `- ready: ${kernel ? ((Array.isArray(kernel.attention) ? kernel.attention.length : 0) === 0 ? "yes" : "no") : "unknown"}`,
    `- attention: ${Array.isArray(kernel?.attention) && kernel.attention.length > 0 ? kernel.attention.join(" | ") : "none"}`,
    `- ring_leader: ${ringLeaderSession ? `${ringLeaderSession.status} (${ringLeaderSession.session_id})` : "not found"}`,
    "",
    "Current objective",
    currentObjective ?? "none",
    "",
    "Active execution",
    `- goal: ${goal ? `${goal.title} (${goal.goal_id})` : "none"}`,
    `- plan: ${plan ? `${plan.title} (${plan.plan_id})` : "none"}`,
    `- step: ${step ? `${step.title} (${step.step_id})` : "none"}`,
    `- task: ${task ? `${task.objective} (${task.task_id})` : "none"}`,
    `- runtime_worker: ${runtimeSession ? `${runtimeSession.status} (${runtimeSession.session_id})` : "none"}`,
    `- task_counts: running=${runningTasks.length} pending=${pendingTasks.length}`,
    "",
    "Delegation",
    `- spawn_path: ${ringLeaderSession ? "ring-leader" : "n/a"}${delegationBrief.delegate_agent_id ? ` -> ${delegationBrief.delegate_agent_id}` : ""}`,
    `- delegate: ${delegationBrief.delegate_agent_id ?? "none"}`,
    `- bounded_objective: ${delegationBrief.task_objective ?? "none"}`,
    "",
    "Control plane",
    `- permission_profile: ${controlPlaneSummary.permission_profile}`,
    `- budget: projected=${Number(controlPlaneSummary.budget_ledger.projected_cost_usd ?? 0).toFixed(4)} actual=${Number(controlPlaneSummary.budget_ledger.actual_cost_usd ?? 0).toFixed(4)} tokens=${controlPlaneSummary.budget_ledger.tokens_total}`,
    `- warm_cache: ${controlPlaneSummary.warm_cache.enabled ? (controlPlaneSummary.warm_cache.stale ? "stale" : "warm") : "disabled"}`,
    `- disabled_feature_flags: ${controlPlaneSummary.feature_flags.disabled_count}/${controlPlaneSummary.feature_flags.total_count}`,
    `- desktop_control: ${controlPlaneSummary.desktop_control.enabled ? `enabled (eyes=${controlPlaneSummary.desktop_control.observe_ready ? "yes" : "no"}, hands=${controlPlaneSummary.desktop_control.act_ready ? "yes" : "no"}, ears=${controlPlaneSummary.desktop_control.listen_ready ? "yes" : "no"})` : "disabled"}`,
    `- patient_zero: ${controlPlaneSummary.patient_zero.enabled ? `${controlPlaneSummary.patient_zero.posture} (profile=${controlPlaneSummary.patient_zero.permission_profile}, autonomy=${controlPlaneSummary.patient_zero.autonomy_enabled ? "yes" : "no"}, browser=${controlPlaneSummary.patient_zero.browser_ready ? "yes" : "no"}, root=${controlPlaneSummary.patient_zero.root_shell_enabled ? "yes" : "no"})` : "standby"}`,
    `- privileged_access: ${
      controlPlaneSummary.privileged_access.root_execution_ready
        ? `ready via ${controlPlaneSummary.privileged_access.account}`
        : `not-ready (patient_zero=${controlPlaneSummary.privileged_access.patient_zero_armed ? "armed" : "standby"}, secret=${controlPlaneSummary.privileged_access.secret_present ? "yes" : "no"}, helper=${controlPlaneSummary.privileged_access.helper_ready ? "yes" : "no"}, verified=${controlPlaneSummary.privileged_access.credential_verified ? "yes" : "no"}, error=${controlPlaneSummary.privileged_access.last_verification_error ?? "none"})`
    }`,
    "",
    renderBulletSection(
      "Recent router suppression decisions",
      routerSuppressionDecisions.map((entry) => {
        const observedAt = entry.observed_at ?? "unknown";
        const backendId = entry.selected_backend_id ?? "n/a";
        const pressureLevel = entry.pressure_level ?? "n/a";
        const suppressedAgents = entry.suppressed_agent_ids.length > 0 ? entry.suppressed_agent_ids.join(", ") : "none";
        return `${observedAt} | ${entry.reason} | backend=${backendId} | pressure=${pressureLevel} | agents=${suppressedAgents}`;
      })
    ),
    "",
    renderBulletSection("Success criteria", delegationBrief.success_criteria),
    "",
    renderBulletSection("Evidence requirements", delegationBrief.evidence_requirements),
    "",
    renderBulletSection("Rollback notes", delegationBrief.rollback_notes),
    "",
    "Compile brief artifact",
    compileBriefArtifact
      ? `- ${compileBriefArtifact.artifact_id} (${compileBriefArtifact.artifact_type})`
      : "- none",
    ...(compileBriefArtifact?.content_text ? ["", compileBriefArtifact.content_text] : []),
    ...(runtimeBrief
      ? [
          "",
          "Runtime handoff brief",
          runtimeBrief,
        ]
      : []),
    ...(executionBacklog.length > 0
      ? [
          "",
          renderBulletSection("Execution backlog", executionBacklog),
        ]
      : []),
  ].join("\n");

  return {
    generated_at: new Date().toISOString(),
    thread_id: threadId,
    compact: input.compact,
    current_objective: currentObjective,
    goal: input.compact ? null : goal,
    goal_summary: summarizeGoal(goal),
    plan: input.compact ? null : plan,
    plan_summary: summarizePlan(plan),
    step: input.compact ? null : step,
    step_summary: summarizeStep(step),
    task: input.compact ? null : task,
    task_summary: summarizeTask(task),
    ring_leader_session: input.compact ? null : ringLeaderSession,
    ring_leader_session_summary: summarizeSession(ringLeaderSession),
    runtime_worker_session: input.compact ? null : runtimeSession,
    runtime_worker_session_summary: summarizeSession(runtimeSession),
    delegation_brief: delegationBrief,
    compile_brief_artifact: compileBriefArtifact,
    runtime_brief_markdown: runtimeBrief,
    execution_backlog: executionBacklog,
    kernel: input.compact ? null : kernel,
    kernel_summary: summarizeKernel(kernel),
    control_plane_summary: controlPlaneSummary,
    router_suppression_decisions: routerSuppressionDecisions,
    brief_markdown: briefMarkdown,
    source: "operator.brief",
  };
}
