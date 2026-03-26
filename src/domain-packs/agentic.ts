import crypto from "node:crypto";
import { type GoalRecord, type Storage } from "../storage.js";
import {
  recommendAdaptiveDispatchRouting,
  summarizeAdaptiveSessionHealth,
  type AdaptiveDispatchRoutingGuidance,
  type AdaptiveSessionHealthState,
} from "../tools/agent_session.js";
import { evaluatePlanStepReadiness } from "../tools/plan.js";
import { DomainPack } from "./types.js";

function requireGoal(storage: Storage, goalId: string): GoalRecord {
  const goal = storage.getGoalById(goalId);
  if (!goal) {
    throw new Error(`Goal not found: ${goalId}`);
  }
  return goal;
}

function resolveGoalFromTarget(
  storage: Storage,
  target: {
    entity_type: string;
    entity_id: string;
    goal_id?: string;
  }
): GoalRecord {
  const goalId = target.entity_type === "goal" ? target.entity_id : readString(target.goal_id);
  if (!goalId) {
    throw new Error(
      `Agentic workflow hooks require a goal context; provide goal_id when targeting ${target.entity_type}`
    );
  }
  return requireGoal(storage, goalId);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type PlannerLaneIntent = {
  lane_kind: "discovery" | "implementation" | "verification" | "baseline" | "variant";
  preferred_agent_ids: string[];
  preferred_client_kinds: string[];
  preferred_capabilities: string[];
  required_capabilities?: string[];
};

type PlannerWorkerRouting = {
  preferred_agent_ids: string[];
  allowed_agent_ids: string[];
  preferred_client_kinds: string[];
  allowed_client_kinds: string[];
  required_capabilities: string[];
  preferred_capabilities: string[];
};

type PlannerAdaptiveAssignment = {
  mode: AdaptiveDispatchRoutingGuidance["mode"];
  lane_kind: PlannerLaneIntent["lane_kind"];
  rationale: string;
  task_profile: AdaptiveDispatchRoutingGuidance["task_profile"];
  preferred_lane_hints: {
    preferred_agent_ids: string[];
    preferred_client_kinds: string[];
    preferred_capabilities: string[];
  };
  health_counts: AdaptiveDispatchRoutingGuidance["summary"];
  recommended_sessions: AdaptiveDispatchRoutingGuidance["recommended_sessions"];
};

type PlannerWorkerLaneResolution = {
  routing: PlannerWorkerRouting;
  adaptive_assignment: PlannerAdaptiveAssignment;
};

function listPreferredCouncilAgents(storage: Storage): string[] {
  const sessions = storage.listAgentSessions({ active_only: true, limit: 100 });
  const preferredAgentOrder = ["codex", "cursor", "local-imprint"];
  const adaptiveStateRank: Record<AdaptiveSessionHealthState, number> = {
    healthy: 0,
    unproven: 1,
    degraded: 2,
    suppressed: 3,
  };
  const ordered = dedupeStrings(
    sessions
      .filter((session) => session.agent_id.trim().length > 0)
      .sort((left, right) => {
        const adaptiveDiff =
          adaptiveStateRank[summarizeAdaptiveSessionHealth(left).adaptive_state] -
          adaptiveStateRank[summarizeAdaptiveSessionHealth(right).adaptive_state];
        if (adaptiveDiff !== 0) {
          return adaptiveDiff;
        }
        const preferredLeft = preferredAgentOrder.indexOf(left.agent_id);
        const preferredRight = preferredAgentOrder.indexOf(right.agent_id);
        if (preferredLeft !== preferredRight) {
          return (preferredLeft === -1 ? preferredAgentOrder.length : preferredLeft) -
            (preferredRight === -1 ? preferredAgentOrder.length : preferredRight);
        }
        return left.agent_id.localeCompare(right.agent_id);
      })
      .map((session) => session.agent_id)
  );

  return ordered.length > 0 ? ordered.slice(0, 3) : ["codex", "cursor"];
}

function resolveMinAgents(agentIds: string[]) {
  return Math.max(1, Math.min(2, agentIds.length));
}

function resolveMetricName(goal: GoalRecord, options?: Record<string, unknown>) {
  return (
    readString(options?.metric_name) ??
    readString(goal.metadata.preferred_metric_name) ??
    "score"
  );
}

function resolveMetricDirection(options?: Record<string, unknown>) {
  const explicit = readString(options?.metric_direction);
  if (explicit === "minimize" || explicit === "maximize") {
    return explicit;
  }
  const preferred = readString(options?.goal_metric_direction);
  if (preferred === "minimize" || preferred === "maximize") {
    return preferred;
  }
  return "maximize";
}

function resolveAcceptanceDelta(goal: GoalRecord, options?: Record<string, unknown>) {
  const explicit = readNumber(options?.acceptance_delta);
  if (explicit !== null && explicit >= 0) {
    return explicit;
  }
  const preferred = readNumber(goal.metadata.acceptance_delta);
  return preferred !== null && preferred >= 0 ? preferred : undefined;
}

function orderByPreference(values: string[], preferenceOrder: string[]) {
  const preferred = preferenceOrder.filter((value) => values.includes(value));
  const preferredSet = new Set(preferred);
  return [...preferred, ...values.filter((value) => !preferredSet.has(value))];
}

function buildPlannerWorkerLaneResolution(
  storage: Storage,
  taskLike: {
    objective: string;
    project_dir: string;
    payload?: Record<string, unknown>;
    tags?: string[];
    metadata?: Record<string, unknown>;
  },
  intent: PlannerLaneIntent
): PlannerWorkerLaneResolution {
  const adaptive = recommendAdaptiveDispatchRouting(storage, {
    objective: taskLike.objective,
    project_dir: taskLike.project_dir,
    payload: taskLike.payload ?? {},
    tags: taskLike.tags ?? [],
    metadata: taskLike.metadata ?? {},
  });
  const adaptiveRouting = adaptive.routing;
  const routing: PlannerWorkerRouting = {
    preferred_agent_ids: adaptiveRouting
      ? orderByPreference(adaptiveRouting.preferred_agent_ids, intent.preferred_agent_ids)
      : [],
    allowed_agent_ids: adaptiveRouting
      ? orderByPreference(adaptiveRouting.allowed_agent_ids, intent.preferred_agent_ids)
      : [],
    preferred_client_kinds:
      adaptiveRouting && adaptiveRouting.preferred_client_kinds.length > 0
        ? orderByPreference(adaptiveRouting.preferred_client_kinds, intent.preferred_client_kinds)
        : [...intent.preferred_client_kinds],
    allowed_client_kinds: adaptiveRouting
      ? orderByPreference(adaptiveRouting.allowed_client_kinds, intent.preferred_client_kinds)
      : [],
    required_capabilities: dedupeStrings(intent.required_capabilities ?? []),
    preferred_capabilities: dedupeStrings(intent.preferred_capabilities),
  };

  return {
    routing,
    adaptive_assignment: {
      mode: adaptive.mode,
      lane_kind: intent.lane_kind,
      rationale: adaptive.summary.rationale,
      task_profile: adaptive.task_profile,
      preferred_lane_hints: {
        preferred_agent_ids: [...intent.preferred_agent_ids],
        preferred_client_kinds: [...intent.preferred_client_kinds],
        preferred_capabilities: [...intent.preferred_capabilities],
      },
      health_counts: adaptive.summary,
      recommended_sessions: adaptive.recommended_sessions,
    },
  };
}

function buildDeliveryPlan(goal: GoalRecord, storage: Storage, repoRoot: string) {
  const councilAgents = listPreferredCouncilAgents(storage);
  const mapCodebaseTask = {
    objective: `Map the repository structure, relevant files, current workflows, and continuity constraints for goal ${goal.goal_id}: ${goal.objective}`,
    project_dir: repoRoot,
    payload: {
      focus: "codebase_map",
      goal_id: goal.goal_id,
      methodology_source: "gsd-build/get-shit-done",
    },
    tags: ["agentic", "gsd", "discovery"],
  };
  const mapCodebaseLane = buildPlannerWorkerLaneResolution(storage, mapCodebaseTask, {
    lane_kind: "discovery",
    preferred_agent_ids: ["codex", "cursor"],
    preferred_client_kinds: ["codex", "cursor"],
    preferred_capabilities: ["coding", "planning"],
  });
  const implementSliceTask = {
    objective: `Implement the approved bounded slice for goal ${goal.goal_id}: ${goal.objective}`,
    project_dir: repoRoot,
    payload: {
      focus: "implementation",
      goal_id: goal.goal_id,
    },
    tags: ["agentic", "gsd", "execute"],
  };
  const implementSliceLane = buildPlannerWorkerLaneResolution(storage, implementSliceTask, {
    lane_kind: "implementation",
    preferred_agent_ids: ["codex", "cursor"],
    preferred_client_kinds: ["codex", "cursor"],
    preferred_capabilities: ["coding", "worker"],
  });
  const verifySliceTask = {
    objective: `Verify the implementation for goal ${goal.goal_id} with explicit evidence for behavior, tests, and quality gates.`,
    project_dir: repoRoot,
    payload: {
      focus: "verification",
      goal_id: goal.goal_id,
    },
    tags: ["agentic", "gsd", "verify"],
  };
  const verifySliceLane = buildPlannerWorkerLaneResolution(storage, verifySliceTask, {
    lane_kind: "verification",
    preferred_agent_ids: ["cursor", "codex"],
    preferred_client_kinds: ["cursor", "codex"],
    preferred_capabilities: ["review", "verify"],
  });

  return {
    summary: `Built a spec-driven delivery path for goal ${goal.goal_id} using the active local agent lanes.`,
    confidence: 0.84,
    assumptions: dedupeStrings([
      "The next slice should be the smallest reversible change that advances the goal.",
      "Cursor and Codex are the primary execution lanes unless more active sessions are present.",
      goal.acceptance_criteria.length > 0
        ? "Existing goal acceptance criteria remain the top-level finish condition."
        : "Acceptance criteria will be refined during planning before broad execution begins.",
    ]),
    success_criteria:
      goal.acceptance_criteria.length > 0
        ? goal.acceptance_criteria
        : [
            "A selected execution plan exists for the goal.",
            "A bounded implementation slice is approved before broad mutation begins.",
            "Verification evidence is produced before the goal is considered complete.",
          ],
    rollback: [
      "Pause dispatch.autorun and reset only the affected failed step before retrying.",
      "Use artifact and event history to restore the last known-good plan state if execution quality regresses.",
    ],
    metadata: {
      workflow_family: "agentic_delivery",
      methodology_source: "gsd-build/get-shit-done",
      council_agents: councilAgents,
      repo_root: repoRoot,
    },
    steps: [
      {
        step_id: "load-goal-context",
        title: "Load the durable goal context",
        step_kind: "analysis" as const,
        executor_kind: "tool" as const,
        tool_name: "goal.get",
        input: {
          goal_id: goal.goal_id,
        },
        expected_artifact_types: ["goal_snapshot"],
        acceptance_checks: ["Goal context is readable through MCP."],
      },
      {
        step_id: "map-codebase",
        title: "Map the relevant codebase and continuity surface",
        step_kind: "analysis" as const,
        executor_kind: "worker" as const,
        depends_on: ["load-goal-context"],
        input: {
          objective: mapCodebaseTask.objective,
          project_dir: repoRoot,
          routing: mapCodebaseLane.routing,
          payload: mapCodebaseTask.payload,
          tags: mapCodebaseTask.tags,
        },
        metadata: {
          adaptive_assignment: mapCodebaseLane.adaptive_assignment,
        },
        expected_artifact_types: ["codebase_map", "notes"],
      },
      {
        step_id: "check-execution-readiness",
        title: "Check execution readiness before slice shaping",
        step_kind: "verification" as const,
        executor_kind: "tool" as const,
        tool_name: "pack.verify.run",
        depends_on: ["map-codebase"],
        input: {
          pack_id: "agentic",
          hook_name: "execution_readiness",
          target: {
            entity_type: "goal",
            entity_id: goal.goal_id,
          },
          goal_id: goal.goal_id,
          expectations: {
            require_active_sessions: false,
            require_ready_step: false,
          },
        },
        expected_artifact_types: ["verifier_result", "agentic.execution_readiness"],
      },
      {
        step_id: "shape-bounded-slice",
        title: "Shape the next bounded delivery slice with the council",
        step_kind: "decision" as const,
        executor_kind: "trichat" as const,
        depends_on: ["check-execution-readiness"],
        input: {
          prompt: `Use the mapped codebase context to shape the next smallest high-signal delivery slice for: ${goal.objective}. Name risks, define verification, and keep the change reversible.`,
          expected_agents: councilAgents,
          min_agents: resolveMinAgents(councilAgents),
          project_dir: repoRoot,
        },
        expected_artifact_types: ["decision", "execution_slice"],
      },
      {
        step_id: "approve-scope",
        title: "Approve the shaped delivery slice",
        step_kind: "handoff" as const,
        executor_kind: "human" as const,
        depends_on: ["shape-bounded-slice"],
        input: {
          approval_summary: `Approve the bounded delivery slice for goal ${goal.goal_id} before code mutation begins.`,
        },
      },
      {
        step_id: "implement-slice",
        title: "Implement the approved bounded slice",
        step_kind: "mutation" as const,
        executor_kind: "worker" as const,
        depends_on: ["approve-scope"],
        input: {
          objective: implementSliceTask.objective,
          project_dir: repoRoot,
          routing: implementSliceLane.routing,
          payload: implementSliceTask.payload,
          tags: implementSliceTask.tags,
        },
        metadata: {
          adaptive_assignment: implementSliceLane.adaptive_assignment,
        },
        expected_artifact_types: ["code", "diff"],
      },
      {
        step_id: "verify-slice",
        title: "Verify behavior, wiring, and quality gates",
        step_kind: "verification" as const,
        executor_kind: "worker" as const,
        depends_on: ["implement-slice"],
        input: {
          objective: verifySliceTask.objective,
          project_dir: repoRoot,
          routing: verifySliceLane.routing,
          payload: verifySliceTask.payload,
          tags: verifySliceTask.tags,
        },
        metadata: {
          adaptive_assignment: verifySliceLane.adaptive_assignment,
        },
        expected_artifact_types: ["verification_report"],
      },
    ],
  };
}

function buildOptimizationPlan(goal: GoalRecord, storage: Storage, repoRoot: string, options?: Record<string, unknown>) {
  const councilAgents = listPreferredCouncilAgents(storage);
  const experimentId = readString(options?.experiment_id) ?? `experiment-${crypto.randomUUID()}`;
  const metricName = resolveMetricName(goal, options);
  const metricDirection =
    resolveMetricDirection({
      ...(options ?? {}),
      goal_metric_direction: readString(goal.metadata.preferred_metric_direction) ?? undefined,
    });
  const acceptanceDelta = resolveAcceptanceDelta(goal, options);
  const baselineTask = {
    objective: `Establish the baseline measurement for goal ${goal.goal_id} using the ${metricDirection} ${metricName} metric.`,
    project_dir: repoRoot,
    payload: {
      focus: "baseline_measurement",
      experiment_id: experimentId,
      metric_name: metricName,
      metric_direction: metricDirection,
    },
    tags: ["agentic", "autoresearch", "baseline"],
  };
  const baselineLane = buildPlannerWorkerLaneResolution(storage, baselineTask, {
    lane_kind: "baseline",
    preferred_agent_ids: ["codex", "cursor"],
    preferred_client_kinds: ["codex", "cursor"],
    preferred_capabilities: ["benchmark", "analysis", "verify"],
  });
  const variantTask = {
    objective: `Implement the bounded candidate variant for goal ${goal.goal_id} before benchmarking.`,
    project_dir: repoRoot,
    payload: {
      focus: "candidate_variant",
      experiment_id: experimentId,
      metric_name: metricName,
    },
    tags: ["agentic", "autoresearch", "variant"],
  };
  const variantLane = buildPlannerWorkerLaneResolution(storage, variantTask, {
    lane_kind: "variant",
    preferred_agent_ids: ["codex", "cursor"],
    preferred_client_kinds: ["codex", "cursor"],
    preferred_capabilities: ["coding", "worker"],
  });

  return {
    summary: `Built an experiment-driven optimization loop for goal ${goal.goal_id} with a durable experiment ledger and review gate.`,
    confidence: 0.8,
    assumptions: [
      "Optimization should be driven by measurable deltas, not preference alone.",
      "Only one bounded candidate should be in flight per loop unless the user explicitly expands the search.",
      "The same measurement protocol should be used for both baseline and candidate runs.",
    ],
    success_criteria: [
      "A durable experiment record exists before running the variant.",
      "The candidate run is measured against a named metric with clear directionality.",
      "Accept or reject decisions are made from evidence, not transcript-only reasoning.",
    ],
    rollback: [
      "Reject the candidate if the metric does not improve or if the system becomes materially more complex at equal quality.",
      "Keep the baseline path recoverable until experiment.judge or explicit human approval promotes the candidate.",
    ],
    metadata: {
      workflow_family: "agentic_optimization",
      methodology_source: "karpathy/autoresearch",
      experiment_id: experimentId,
      metric_name: metricName,
      metric_direction: metricDirection,
      repo_root: repoRoot,
    },
    steps: [
      {
        step_id: "load-goal-context",
        title: "Load the optimization goal context",
        step_kind: "analysis" as const,
        executor_kind: "tool" as const,
        tool_name: "goal.get",
        input: {
          goal_id: goal.goal_id,
        },
        expected_artifact_types: ["goal_snapshot"],
      },
      {
        step_id: "create-experiment-ledger",
        title: "Create the durable experiment ledger",
        step_kind: "mutation" as const,
        executor_kind: "tool" as const,
        tool_name: "experiment.create",
        depends_on: ["load-goal-context"],
        input: {
          experiment_id: experimentId,
          goal_id: goal.goal_id,
          title: `${goal.title} optimization loop`,
          objective: goal.objective,
          hypothesis:
            readString(options?.hypothesis) ??
            `A bounded variant can improve ${metricName} for goal ${goal.goal_id} without destabilizing the local workflow.`,
          status: "active",
          metric_name: metricName,
          metric_direction: metricDirection,
          acceptance_delta: acceptanceDelta,
          tags: dedupeStrings([...goal.tags, "agentic", "autoresearch", metricName]),
          metadata: {
            methodology_source: "karpathy/autoresearch",
            goal_id: goal.goal_id,
          },
        },
        expected_artifact_types: ["experiment_record"],
      },
      {
        step_id: "establish-baseline",
        title: "Establish the baseline measurement",
        step_kind: "analysis" as const,
        executor_kind: "worker" as const,
        depends_on: ["create-experiment-ledger"],
        input: {
          objective: baselineTask.objective,
          project_dir: repoRoot,
          routing: baselineLane.routing,
          payload: baselineTask.payload,
          tags: baselineTask.tags,
        },
        metadata: {
          adaptive_assignment: baselineLane.adaptive_assignment,
        },
        expected_artifact_types: ["baseline_report"],
      },
      {
        step_id: "propose-variant",
        title: "Propose the next bounded variant",
        step_kind: "decision" as const,
        executor_kind: "trichat" as const,
        depends_on: ["establish-baseline"],
        input: {
          prompt: `Given the current baseline for ${goal.objective}, propose the next bounded experiment that is most likely to improve ${metricName}. Prefer reversible changes and explicit measurement criteria.`,
          expected_agents: councilAgents,
          min_agents: resolveMinAgents(councilAgents),
          project_dir: repoRoot,
        },
        expected_artifact_types: ["decision", "hypothesis"],
      },
      {
        step_id: "implement-variant",
        title: "Implement the selected bounded variant",
        step_kind: "mutation" as const,
        executor_kind: "worker" as const,
        depends_on: ["propose-variant"],
        input: {
          objective: variantTask.objective,
          project_dir: repoRoot,
          routing: variantLane.routing,
          payload: variantTask.payload,
          tags: variantTask.tags,
        },
        metadata: {
          adaptive_assignment: variantLane.adaptive_assignment,
        },
        expected_artifact_types: ["code", "diff"],
      },
      {
        step_id: "launch-candidate-run",
        title: "Launch the measured candidate run",
        step_kind: "verification" as const,
        executor_kind: "tool" as const,
        tool_name: "experiment.run",
        depends_on: ["implement-variant"],
        input: {
          experiment_id: experimentId,
          candidate_label: readString(options?.candidate_label) ?? "candidate-1",
          dispatch_mode: "task",
          objective: `Run the candidate benchmark loop for goal ${goal.goal_id} and capture ${metricName}.`,
          project_dir: repoRoot,
          task_tags: ["agentic", "autoresearch", metricName],
          payload: {
            focus: "candidate_benchmark",
            goal_id: goal.goal_id,
            metric_name: metricName,
            metric_direction: metricDirection,
          },
        },
        expected_artifact_types: ["experiment_run"],
      },
      {
        step_id: "review-and-judge",
        title: "Review evidence and judge the candidate",
        step_kind: "handoff" as const,
        executor_kind: "human" as const,
        depends_on: ["launch-candidate-run"],
        input: {
          approval_summary: `Review the candidate evidence for goal ${goal.goal_id} and accept it only if ${metricName} improves or the system is clearly simpler at equal quality.`,
        },
      },
    ],
  };
}

function verifyExecutionReadiness(storage: Storage, target: { entity_type: string; entity_id: string }, expectations?: Record<string, unknown>) {
  const requireActiveSessions = readBoolean(expectations?.require_active_sessions) === true;
  const minimumActiveSessions = Math.max(0, Math.trunc(readNumber(expectations?.minimum_active_sessions) ?? 0));
  const requireDispatchableWorkerSession = readBoolean(expectations?.require_dispatchable_worker_session) === true;
  const minimumDispatchableSessions = Math.max(0, Math.trunc(readNumber(expectations?.minimum_dispatchable_sessions) ?? 0));
  const requireReadyStep = readBoolean(expectations?.require_ready_step) === true;

  const plan =
    target.entity_type === "plan"
      ? storage.getPlanById(target.entity_id)
      : null;
  const goal =
    target.entity_type === "goal"
      ? requireGoal(storage, target.entity_id)
      : plan
        ? requireGoal(storage, plan.goal_id)
        : (() => {
            throw new Error(`Unsupported target for execution_readiness: ${target.entity_type}`);
          })();
  const activePlan =
    plan ??
    (goal.active_plan_id ? storage.getPlanById(goal.active_plan_id) : null) ??
    storage.listPlans({ goal_id: goal.goal_id, selected_only: true, limit: 1 })[0] ??
    null;
  const steps = activePlan ? storage.listPlanSteps(activePlan.plan_id) : [];
  const readiness = evaluatePlanStepReadiness(steps);
  const activeSessions = storage.listAgentSessions({ active_only: true, limit: 100 });
  const sessionHealth = activeSessions.map((session) => ({
    session_id: session.session_id,
    agent_id: session.agent_id,
    client_kind: session.client_kind,
    adaptive_state: summarizeAdaptiveSessionHealth(session).adaptive_state,
  }));
  const dispatchableSessions = sessionHealth.filter(
    (session) => session.adaptive_state === "healthy" || session.adaptive_state === "unproven"
  );
  const degradedSessions = sessionHealth.filter((session) => session.adaptive_state === "degraded");
  const suppressedSessions = sessionHealth.filter((session) => session.adaptive_state === "suppressed");
  const councilAgents = listPreferredCouncilAgents(storage);
  const readyStepIds = readiness.filter((entry) => entry.ready).map((entry) => entry.step_id);
  const verificationStepCount = steps.filter((step) => step.step_kind === "verification").length;

  const checks = [
    {
      name: "goal_acceptance_criteria",
      pass: goal.acceptance_criteria.length > 0,
      severity: "error" as const,
      details:
        goal.acceptance_criteria.length > 0
          ? `Goal has ${goal.acceptance_criteria.length} acceptance criteria.`
          : "Goal has no acceptance criteria yet.",
    },
    {
      name: "selected_plan_present",
      pass: Boolean(activePlan),
      severity: "error" as const,
      details: activePlan
        ? `Selected plan ${activePlan.plan_id} is attached to the goal.`
        : "No selected or active plan is attached to the goal.",
    },
    {
      name: "verification_lane_present",
      pass: verificationStepCount > 0,
      severity: "error" as const,
      details:
        verificationStepCount > 0
          ? `Plan includes ${verificationStepCount} verification step(s).`
          : "Plan does not include a verification step yet.",
    },
    {
      name: "active_agent_sessions",
      pass:
        !requireActiveSessions ||
        activeSessions.length >= Math.max(1, minimumActiveSessions || 1),
      severity: requireActiveSessions ? "error" as const : "warn" as const,
      details:
        activeSessions.length > 0
          ? `Active sessions: ${activeSessions.map((session) => session.agent_id).join(", ")}.`
          : "No active agent sessions are registered right now.",
    },
    {
      name: "dispatchable_worker_pool",
      pass:
        dispatchableSessions.length >=
        Math.max(1, requireDispatchableWorkerSession ? minimumDispatchableSessions || 1 : 1),
      severity: requireDispatchableWorkerSession ? "error" as const : "warn" as const,
      details:
        dispatchableSessions.length > 0
          ? `Dispatchable sessions: ${dispatchableSessions.map((session) => session.agent_id).join(", ")}.`
          : activeSessions.length > 0
            ? `Active sessions exist, but adaptive routing currently marks them all degraded or suppressed. Degraded: ${degradedSessions.map((session) => session.agent_id).join(", ") || "none"}. Suppressed: ${suppressedSessions.map((session) => session.agent_id).join(", ") || "none"}.`
            : "No active sessions are available for adaptive worker dispatch right now.",
    },
    {
      name: "ready_execution_lane",
      pass: !requireReadyStep || readyStepIds.length > 0,
      severity: requireReadyStep ? "error" as const : "info" as const,
      details:
        readyStepIds.length > 0
          ? `Ready steps: ${readyStepIds.join(", ")}.`
          : "No plan steps are immediately ready for dispatch.",
    },
  ];

  const pass = checks.every((check) => check.pass || check.severity !== "error");
  const passedChecks = checks.filter((check) => check.pass).length;
  const score = checks.length > 0 ? Number((passedChecks / checks.length).toFixed(3)) : 1;

  return {
    summary: pass
      ? `Goal ${goal.goal_id} is execution-ready for bounded agentic work.`
      : `Goal ${goal.goal_id} is missing one or more execution readiness requirements.`,
    pass,
    score,
    checks,
    produced_artifacts: [
      {
        artifact_type: "agentic.execution_readiness",
        trust_tier: "verified" as const,
        content_json: {
          goal_id: goal.goal_id,
          active_plan_id: activePlan?.plan_id ?? null,
          selected_plan_id: activePlan?.plan_id ?? null,
          active_session_ids: activeSessions.map((session) => session.session_id),
          active_agent_ids: activeSessions.map((session) => session.agent_id),
          adaptive_session_health: sessionHealth,
          dispatchable_session_ids: dispatchableSessions.map((session) => session.session_id),
          dispatchable_agent_ids: dispatchableSessions.map((session) => session.agent_id),
          degraded_agent_ids: degradedSessions.map((session) => session.agent_id),
          suppressed_agent_ids: suppressedSessions.map((session) => session.agent_id),
          preferred_council_agents: councilAgents,
          ready_step_ids: readyStepIds,
          blocked_step_ids: readiness.filter((entry) => !entry.ready).map((entry) => entry.step_id),
          verification_step_count: verificationStepCount,
        },
        metadata: {
          methodology_source: "gsd-build/get-shit-done",
          require_active_sessions: requireActiveSessions,
          minimum_active_sessions: minimumActiveSessions,
          require_dispatchable_worker_session: requireDispatchableWorkerSession,
          minimum_dispatchable_sessions: minimumDispatchableSessions,
          require_ready_step: requireReadyStep,
        },
      },
    ],
    metadata: {
      goal_id: goal.goal_id,
      active_plan_id: activePlan?.plan_id ?? null,
      ready_step_count: readyStepIds.length,
      active_session_count: activeSessions.length,
      dispatchable_session_count: dispatchableSessions.length,
      degraded_session_count: degradedSessions.length,
      suppressed_session_count: suppressedSessions.length,
    },
  };
}

export const agenticDomainPack: DomainPack = {
  id: "agentic",
  title: "Agentic Workflow Pack",
  description:
    "Planner and verifier hooks for local development, multi-agent delivery, and experiment-driven optimization.",
  register: (context) => {
    context.register_planner_hook({
      hook_name: "delivery_path",
      title: "Agentic Delivery Path Planner",
      description:
        "Generate a spec-driven delivery plan inspired by GSD for local multi-agent implementation work.",
      target_types: ["*"],
      plan: ({ storage, target }) => {
        const goal = resolveGoalFromTarget(storage, target);
        return buildDeliveryPlan(goal, storage, context.repo_root);
      },
    });

    context.register_planner_hook({
      hook_name: "optimization_loop",
      title: "Agentic Optimization Loop Planner",
      description:
        "Generate an experiment-driven optimization loop inspired by autoresearch with a durable experiment ledger.",
      target_types: ["*"],
      plan: ({ storage, target, options }) => {
        const goal = resolveGoalFromTarget(storage, target);
        return buildOptimizationPlan(goal, storage, context.repo_root, options);
      },
    });

    context.register_verifier_hook({
      hook_name: "execution_readiness",
      title: "Agentic Execution Readiness Verifier",
      description:
        "Evaluate whether a goal or selected plan has the acceptance criteria, plan structure, and session availability needed for bounded local execution.",
      target_types: ["goal", "plan"],
      verify: ({ storage, target, expectations }) =>
        verifyExecutionReadiness(storage, target, expectations),
    });
  },
};
