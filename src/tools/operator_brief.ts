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
  const currentObjective =
    readString(ringLeaderSession?.metadata.last_source_task_objective) ??
    delegationBrief.task_objective ??
    task?.objective ??
    goal?.objective ??
    null;
  const executionBacklog = readStringArray(ringLeaderSession?.metadata.last_execution_task_ids);
  const runningTasks = storage.listTasks({ status: "running", limit: 25 });
  const pendingTasks = storage.listTasks({ status: "pending", limit: 25 });

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
    brief_markdown: briefMarkdown,
    source: "operator.brief",
  };
}
