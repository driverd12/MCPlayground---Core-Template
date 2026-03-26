import { z } from "zod";
import { Storage, type AgentSessionRecord, type PlanRecord, type PlanStepRecord, type TaskRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { deriveExperimentObservation, judgeExperimentRunWithStorage } from "./experiment.js";

const agentSessionStatusSchema = z.enum(["active", "idle", "busy", "expired", "closed", "failed"]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const recordSchema = z.record(z.unknown());

export const agentSessionOpenSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1).max(200).optional(),
  agent_id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  client_kind: z.string().min(1).optional(),
  transport_kind: z.string().min(1).optional(),
  workspace_root: z.string().min(1).optional(),
  owner_id: z.string().min(1).optional(),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  status: agentSessionStatusSchema.optional(),
  capabilities: recordSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const agentSessionGetSchema = z.object({
  session_id: z.string().min(1),
});

export const agentSessionListSchema = z.object({
  status: agentSessionStatusSchema.optional(),
  agent_id: z.string().min(1).optional(),
  client_kind: z.string().min(1).optional(),
  active_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const agentSessionHeartbeatSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  status: agentSessionStatusSchema.optional(),
  owner_id: z.string().min(1).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
});

export const agentSessionCloseSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  metadata: recordSchema.optional(),
});

export const agentClaimNextSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const agentWorklistSchema = z.object({
  session_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  scan_limit: z.number().int().min(1).max(500).optional(),
  include_ineligible: z.boolean().optional(),
});

export const agentCurrentTaskSchema = z.object({
  session_id: z.string().min(1),
});

export const agentHeartbeatTaskSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const agentReportResultSchema = z
  .object({
    mutation: mutationSchema,
    session_id: z.string().min(1),
    task_id: z.string().min(1),
    outcome: z.enum(["completed", "failed"]),
    result: recordSchema.optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    run_id: z.string().min(1).optional(),
    produced_artifact_ids: z.array(z.string().min(1)).optional(),
    observed_metric: z.number().finite().optional(),
    observed_metrics: recordSchema.optional(),
    experiment_verdict: z.enum(["accepted", "rejected", "inconclusive", "crash"]).optional(),
    next_session_status: agentSessionStatusSchema.optional(),
    metadata: recordSchema.optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.outcome === "failed" && !value.error?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error is required when outcome is failed",
        path: ["error"],
      });
    }
  });

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

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function buildAgentDerivedMutation(
  mutation: { idempotency_key: string; side_effect_fingerprint: string },
  phase: string
) {
  return {
    idempotency_key: `${mutation.idempotency_key}:agent:${phase}`,
    side_effect_fingerprint: `${mutation.side_effect_fingerprint}:agent:${phase}`,
  };
}

type TaskRoutingRule = {
  preferred_agent_ids: string[];
  allowed_agent_ids: string[];
  preferred_client_kinds: string[];
  allowed_client_kinds: string[];
  required_capabilities: string[];
  preferred_capabilities: string[];
};

type TaskRoutingEvaluation = {
  eligible: boolean;
  score: number;
  blockers: string[];
  matched_preferences: string[];
  routing: TaskRoutingRule;
};

type AgentTaskCandidate = {
  task: TaskRecord;
  routing: TaskRoutingEvaluation;
};

function resolveTaskPlanContext(
  storage: Storage,
  task: TaskRecord
): { plan: PlanRecord; step: PlanStepRecord } | null {
  const directMatch = storage.findPlanStepByTaskId(task.task_id);
  if (directMatch) {
    return directMatch;
  }

  const dispatchMetadata = isRecord(task.metadata.plan_dispatch) ? task.metadata.plan_dispatch : null;
  const planId =
    readString(dispatchMetadata?.plan_id) ??
    (isRecord(task.payload) ? readString(task.payload.plan_id) : null);
  const stepId =
    readString(dispatchMetadata?.step_id) ??
    (isRecord(task.payload) ? readString(task.payload.step_id) : null);
  if (!planId || !stepId) {
    return null;
  }
  const plan = storage.getPlanById(planId);
  const step = plan ? storage.listPlanSteps(planId).find((candidate) => candidate.step_id === stepId) ?? null : null;
  if (!plan || !step) {
    return null;
  }
  return { plan, step };
}

function goalSupportsAutorun(goalAutonomyMode: string | null | undefined) {
  return (
    goalAutonomyMode === "stage" ||
    goalAutonomyMode === "execute_bounded" ||
    goalAutonomyMode === "execute_destructive_with_approval"
  );
}

function shouldTriggerGoalAutorun(
  storage: Storage,
  task: TaskRecord,
  planContext: { plan: PlanRecord; step: PlanStepRecord } | null
) {
  if (!planContext) {
    return {
      enabled: false,
      reason: "no-plan-context",
      goal_id: null,
      max_passes: null,
    };
  }

  const dispatchMetadata = isRecord(task.metadata.plan_dispatch) ? task.metadata.plan_dispatch : null;
  const explicitFlag = readBoolean(dispatchMetadata?.autorun_goal_on_completion);
  if (explicitFlag === false) {
    return {
      enabled: false,
      reason: "dispatch-disabled",
      goal_id: planContext.plan.goal_id,
      max_passes: null,
    };
  }

  const workflowFlag = readBoolean(planContext.plan.metadata.workflow_autorun_enabled);
  const goal = storage.getGoalById(planContext.plan.goal_id);
  const enabled = explicitFlag === true || workflowFlag === true || goalSupportsAutorun(goal?.autonomy_mode);
  return {
    enabled,
    reason: enabled ? (workflowFlag === true ? "plan-workflow-autorun" : goal ? `goal:${goal.autonomy_mode}` : "dispatch-enabled") : "goal-autonomy-disabled",
    goal_id: planContext.plan.goal_id,
    max_passes: readPositiveInt(planContext.plan.metadata.workflow_autorun_max_passes),
  };
}

function attachArtifactsToTaskContext(
  storage: Storage,
  task: TaskRecord,
  producedArtifactIds: string[],
  source: {
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  },
  planContext?: { plan: PlanRecord; step: PlanStepRecord } | null
) {
  const links = [];
  for (const artifactId of producedArtifactIds) {
    if (!storage.getArtifactById(artifactId)) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    links.push(
      storage.linkArtifact({
        src_artifact_id: artifactId,
        dst_entity_type: "task",
        dst_entity_id: task.task_id,
        relation: "attached_to",
        source_client: source.source_client,
        source_model: source.source_model,
        source_agent: source.source_agent,
      }).link
    );
    if (planContext) {
      links.push(
        storage.linkArtifact({
          src_artifact_id: artifactId,
          dst_entity_type: "goal",
          dst_entity_id: planContext.plan.goal_id,
          relation: "attached_to",
          source_client: source.source_client,
          source_model: source.source_model,
          source_agent: source.source_agent,
        }).link
      );
      links.push(
        storage.linkArtifact({
          src_artifact_id: artifactId,
          dst_entity_type: "plan",
          dst_entity_id: planContext.plan.plan_id,
          relation: "attached_to",
          source_client: source.source_client,
          source_model: source.source_model,
          source_agent: source.source_agent,
        }).link
      );
      links.push(
        storage.linkArtifact({
          src_artifact_id: artifactId,
          dst_entity_type: "step",
          dst_entity_id: planContext.step.step_id,
          relation: "attached_to",
          source_client: source.source_client,
          source_model: source.source_model,
          source_agent: source.source_agent,
        }).link
      );
    }
  }
  return links;
}

function recordAgentReportArtifact(
  storage: Storage,
  params: {
    session: AgentSessionRecord;
    task: TaskRecord;
    outcome: "completed" | "failed";
    result?: Record<string, unknown>;
    summary?: string;
    error?: string;
    run_id?: string;
    observed_metric?: number;
    observed_metrics?: Record<string, unknown>;
    experiment_verdict?: "accepted" | "rejected" | "inconclusive" | "crash";
    metadata?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    planContext?: { plan: PlanRecord; step: PlanStepRecord } | null;
  }
) {
  const recorded = storage.recordArtifact({
    artifact_type: "agent.task_report",
    goal_id: params.planContext?.plan.goal_id,
    plan_id: params.planContext?.plan.plan_id,
    step_id: params.planContext?.step.step_id,
    task_id: params.task.task_id,
    run_id: params.run_id,
    producer_kind: "worker",
    producer_id: params.session.session_id,
    trust_tier: "derived",
    content_json: {
      outcome: params.outcome,
      summary: params.summary?.trim() || null,
      error: params.error?.trim() || null,
      result: params.result ?? {},
      observed_metric: params.observed_metric ?? null,
      observed_metrics: params.observed_metrics ?? {},
      experiment_verdict: params.experiment_verdict ?? null,
      session: {
        session_id: params.session.session_id,
        agent_id: params.session.agent_id,
        client_kind: params.session.client_kind,
      },
      task: {
        task_id: params.task.task_id,
        objective: params.task.objective,
        status: params.task.status,
        project_dir: params.task.project_dir,
      },
    },
    metadata: {
      auto_recorded: true,
      artifact_role: "task_report",
      session_id: params.session.session_id,
      agent_id: params.session.agent_id,
      client_kind: params.session.client_kind,
      task_status: params.task.status,
      ...(params.metadata ?? {}),
    },
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent ?? params.session.agent_id,
  });
  return recorded.artifact;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return dedupeStrings(value.filter((item): item is string => typeof item === "string"));
}

function normalizeTaskRouting(value: unknown): TaskRoutingRule {
  if (!isRecord(value)) {
    return {
      preferred_agent_ids: [],
      allowed_agent_ids: [],
      preferred_client_kinds: [],
      allowed_client_kinds: [],
      required_capabilities: [],
      preferred_capabilities: [],
    };
  }
  return {
    preferred_agent_ids: normalizeStringArray(value.preferred_agent_ids),
    allowed_agent_ids: normalizeStringArray(value.allowed_agent_ids),
    preferred_client_kinds: normalizeStringArray(value.preferred_client_kinds),
    allowed_client_kinds: normalizeStringArray(value.allowed_client_kinds),
    required_capabilities: normalizeStringArray(value.required_capabilities),
    preferred_capabilities: normalizeStringArray(value.preferred_capabilities),
  };
}

function resolveTaskRouting(task: TaskRecord): TaskRoutingRule {
  const merged: TaskRoutingRule = {
    preferred_agent_ids: [],
    allowed_agent_ids: [],
    preferred_client_kinds: [],
    allowed_client_kinds: [],
    required_capabilities: [],
    preferred_capabilities: [],
  };

  const candidates = [
    task.metadata.task_routing,
    task.metadata.routing,
    isRecord(task.payload) ? task.payload.task_routing : undefined,
    isRecord(task.payload) ? task.payload.routing : undefined,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTaskRouting(candidate);
    merged.preferred_agent_ids = dedupeStrings([...merged.preferred_agent_ids, ...normalized.preferred_agent_ids]);
    merged.allowed_agent_ids = dedupeStrings([...merged.allowed_agent_ids, ...normalized.allowed_agent_ids]);
    merged.preferred_client_kinds = dedupeStrings([
      ...merged.preferred_client_kinds,
      ...normalized.preferred_client_kinds,
    ]);
    merged.allowed_client_kinds = dedupeStrings([...merged.allowed_client_kinds, ...normalized.allowed_client_kinds]);
    merged.required_capabilities = dedupeStrings([
      ...merged.required_capabilities,
      ...normalized.required_capabilities,
    ]);
    merged.preferred_capabilities = dedupeStrings([
      ...merged.preferred_capabilities,
      ...normalized.preferred_capabilities,
    ]);
  }

  return merged;
}

function capabilityListIncludes(value: unknown, capability: string): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => readString(entry)?.toLowerCase() === capability);
}

function hasSessionCapability(session: AgentSessionRecord, capability: string): boolean {
  const normalized = capability.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (session.tags.some((tag) => tag.trim().toLowerCase() === normalized)) {
    return true;
  }

  const direct = session.capabilities[normalized] ?? session.capabilities[capability];
  if (direct === true) {
    return true;
  }
  if (typeof direct === "string") {
    const value = direct.trim().toLowerCase();
    return value.length > 0 && !["false", "0", "none", "no"].includes(value);
  }
  if (typeof direct === "number") {
    return Number.isFinite(direct) && direct > 0;
  }
  if (Array.isArray(direct)) {
    return direct.length > 0;
  }
  if (isRecord(direct)) {
    return Object.keys(direct).length > 0;
  }

  return (
    capabilityListIncludes(session.capabilities.capabilities, normalized) ||
    capabilityListIncludes(session.capabilities.supported_capabilities, normalized) ||
    capabilityListIncludes(session.capabilities.skills, normalized) ||
    capabilityListIncludes(session.capabilities.roles, normalized)
  );
}

function evaluateTaskRouting(session: AgentSessionRecord, task: TaskRecord): TaskRoutingEvaluation {
  const routing = resolveTaskRouting(task);
  const blockers: string[] = [];
  const matchedPreferences: string[] = [];
  let score = 0;

  const agentId = session.agent_id.trim().toLowerCase();
  const clientKind = readString(session.client_kind)?.toLowerCase() ?? null;

  if (routing.allowed_agent_ids.length > 0) {
    const allowed = new Set(routing.allowed_agent_ids.map((value) => value.toLowerCase()));
    if (!allowed.has(agentId)) {
      blockers.push("agent_id_not_allowed");
    } else {
      matchedPreferences.push(`allowed_agent:${session.agent_id}`);
      score += 30;
    }
  }

  if (routing.allowed_client_kinds.length > 0) {
    const allowed = new Set(routing.allowed_client_kinds.map((value) => value.toLowerCase()));
    if (!clientKind || !allowed.has(clientKind)) {
      blockers.push("client_kind_not_allowed");
    } else {
      matchedPreferences.push(`allowed_client:${session.client_kind}`);
      score += 20;
    }
  }

  const missingCapabilities = routing.required_capabilities.filter((capability) => !hasSessionCapability(session, capability));
  if (missingCapabilities.length > 0) {
    blockers.push(`missing_capabilities:${missingCapabilities.join(",")}`);
  } else if (routing.required_capabilities.length > 0) {
    matchedPreferences.push(`required_capabilities:${routing.required_capabilities.join(",")}`);
    score += routing.required_capabilities.length * 12;
  }

  if (routing.preferred_agent_ids.some((value) => value.toLowerCase() === agentId)) {
    matchedPreferences.push(`preferred_agent:${session.agent_id}`);
    score += 18;
  }

  if (clientKind && routing.preferred_client_kinds.some((value) => value.toLowerCase() === clientKind)) {
    matchedPreferences.push(`preferred_client:${session.client_kind}`);
    score += 12;
  }

  const preferredCapabilityHits = routing.preferred_capabilities.filter((capability) => hasSessionCapability(session, capability));
  if (preferredCapabilityHits.length > 0) {
    matchedPreferences.push(`preferred_capabilities:${preferredCapabilityHits.join(",")}`);
    score += preferredCapabilityHits.length * 6;
  }

  if (session.workspace_root && task.project_dir && session.workspace_root === task.project_dir) {
    matchedPreferences.push("workspace_root_match");
    score += 2;
  }

  return {
    eligible: blockers.length === 0,
    score,
    blockers,
    matched_preferences: matchedPreferences,
    routing,
  };
}

function compareTaskCandidates(left: AgentTaskCandidate, right: AgentTaskCandidate): number {
  const scoreDiff = right.routing.score - left.routing.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const priorityDiff = right.task.priority - left.task.priority;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  return left.task.created_at.localeCompare(right.task.created_at);
}

function isTaskClaimableNow(task: TaskRecord, nowIso: string) {
  if (task.status !== "pending") {
    return {
      claimable: false,
      reason: `not-pending:${task.status}`,
    };
  }
  if (task.available_at > nowIso) {
    return {
      claimable: false,
      reason: "not-ready",
    };
  }
  if (task.lease && task.lease.lease_expires_at > nowIso) {
    return {
      claimable: false,
      reason: "leased",
    };
  }
  return {
    claimable: true,
    reason: "claimable",
  };
}

function selectTaskCandidate(
  storage: Storage,
  session: AgentSessionRecord,
  options?: {
    task_id?: string;
    scan_limit?: number;
  }
): { candidate?: AgentTaskCandidate; reason: string; scanned: number } {
  const nowIso = new Date().toISOString();
  if (options?.task_id?.trim()) {
    const task = storage.getTaskById(options.task_id);
    if (!task) {
      return {
        reason: "not-found",
        scanned: 0,
      };
    }
    const claimability = isTaskClaimableNow(task, nowIso);
    if (!claimability.claimable) {
      return {
        reason: claimability.reason,
        scanned: 1,
      };
    }
    const routing = evaluateTaskRouting(session, task);
    if (!routing.eligible) {
      return {
        reason: `routing-ineligible:${routing.blockers.join("|")}`,
        scanned: 1,
      };
    }
    return {
      candidate: {
        task,
        routing,
      },
      reason: "selected",
      scanned: 1,
    };
  }

  const pendingTasks = storage.listTasks({
    status: "pending",
    limit: options?.scan_limit ?? 200,
  });
  const candidates = pendingTasks
    .map((task) => {
      const claimability = isTaskClaimableNow(task, nowIso);
      if (!claimability.claimable) {
        return null;
      }
      const routing = evaluateTaskRouting(session, task);
      if (!routing.eligible) {
        return null;
      }
      return {
        task,
        routing,
      } satisfies AgentTaskCandidate;
    })
    .filter((candidate): candidate is AgentTaskCandidate => candidate !== null)
    .sort(compareTaskCandidates);

  if (candidates.length === 0) {
    return {
      reason: pendingTasks.length > 0 ? "none-eligible" : "none-available",
      scanned: pendingTasks.length,
    };
  }

  return {
    candidate: candidates[0],
    reason: "selected",
    scanned: pendingTasks.length,
  };
}

export async function openAgentSession(storage: Storage, input: z.infer<typeof agentSessionOpenSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_open",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const opened = storage.upsertAgentSession({
        session_id: input.session_id,
        agent_id: input.agent_id,
        display_name: input.display_name,
        client_kind: input.client_kind,
        transport_kind: input.transport_kind,
        workspace_root: input.workspace_root,
        owner_id: input.owner_id,
        lease_seconds: input.lease_seconds,
        status: input.status,
        capabilities: input.capabilities,
        tags: input.tags,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const event = storage.appendRuntimeEvent({
        event_type: opened.created ? "agent.session_opened" : "agent.session_refreshed",
        entity_type: "agent_session",
        entity_id: opened.session.session_id,
        status: opened.session.status,
        summary: opened.created
          ? `Agent session ${opened.session.session_id} opened.`
          : `Agent session ${opened.session.session_id} refreshed.`,
        details: {
          agent_id: opened.session.agent_id,
          client_kind: opened.session.client_kind,
          transport_kind: opened.session.transport_kind,
          workspace_root: opened.session.workspace_root,
          capability_keys: Object.keys(opened.session.capabilities),
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ...opened,
        event,
      };
    },
  });
}

export function getAgentSession(storage: Storage, input: z.infer<typeof agentSessionGetSchema>) {
  const session = storage.getAgentSessionById(input.session_id);
  if (!session) {
    return {
      found: false,
      session_id: input.session_id,
    };
  }
  return {
    found: true,
    session,
  };
}

export function listAgentSessions(storage: Storage, input: z.infer<typeof agentSessionListSchema>) {
  const sessions = storage.listAgentSessions({
    status: input.status,
    agent_id: input.agent_id,
    client_kind: input.client_kind,
    active_only: input.active_only,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    agent_id_filter: input.agent_id ?? null,
    client_kind_filter: input.client_kind ?? null,
    active_only_filter: input.active_only ?? null,
    count: sessions.length,
    sessions,
  };
}

export async function heartbeatAgentSession(storage: Storage, input: z.infer<typeof agentSessionHeartbeatSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_heartbeat",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.heartbeatAgentSession({
        session_id: input.session_id,
        lease_seconds: input.lease_seconds,
        status: input.status,
        owner_id: input.owner_id,
        capabilities: input.capabilities,
        metadata: input.metadata,
      }),
  });
}

export async function closeAgentSession(storage: Storage, input: z.infer<typeof agentSessionCloseSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_close",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const closed = storage.closeAgentSession({
        session_id: input.session_id,
        metadata: input.metadata,
      });
      const event =
        closed.closed && closed.session
          ? storage.appendRuntimeEvent({
              event_type: "agent.session_closed",
              entity_type: "agent_session",
              entity_id: closed.session.session_id,
              status: closed.session.status,
              summary: `Agent session ${closed.session.session_id} closed.`,
              details: {
                agent_id: closed.session.agent_id,
                client_kind: closed.session.client_kind,
                ended_at: closed.session.ended_at,
              },
            })
          : null;
      return {
        ...closed,
        event,
      };
    },
  });
}

export function agentWorklist(storage: Storage, input: z.infer<typeof agentWorklistSchema>) {
  const session = storage.getAgentSessionById(input.session_id);
  if (!session) {
    return {
      found: false,
      reason: "session-not-found",
      session_id: input.session_id,
    };
  }

  const limit = input.limit ?? 20;
  const scanLimit = Math.max(limit, input.scan_limit ?? Math.min(Math.max(limit * 5, 50), 200));
  const nowIso = new Date().toISOString();
  const pendingTasks = storage.listTasks({
    status: "pending",
    limit: scanLimit,
  });

  const eligible: AgentTaskCandidate[] = [];
  const ineligible: Array<{
    task: TaskRecord;
    routing: TaskRoutingEvaluation;
    reason: string;
  }> = [];

  for (const task of pendingTasks) {
    const claimability = isTaskClaimableNow(task, nowIso);
    const routing = evaluateTaskRouting(session, task);
    if (claimability.claimable && routing.eligible) {
      eligible.push({
        task,
        routing,
      });
      continue;
    }
    if (input.include_ineligible) {
      ineligible.push({
        task,
        routing,
        reason: claimability.claimable ? routing.blockers.join("|") || "routing-ineligible" : claimability.reason,
      });
    }
  }

  eligible.sort(compareTaskCandidates);
  ineligible.sort((left, right) =>
    compareTaskCandidates(
      { task: left.task, routing: left.routing },
      { task: right.task, routing: right.routing }
    )
  );

  return {
    found: true,
    session,
    scanned_count: pendingTasks.length,
    eligible_count: eligible.length,
    returned_count: Math.min(limit, eligible.length),
    tasks: eligible.slice(0, limit).map((entry) => ({
      task_id: entry.task.task_id,
      objective: entry.task.objective,
      priority: entry.task.priority,
      project_dir: entry.task.project_dir,
      available_at: entry.task.available_at,
      tags: entry.task.tags,
      routing_score: entry.routing.score,
      matched_preferences: entry.routing.matched_preferences,
      routing: entry.routing.routing,
      task: entry.task,
    })),
    ineligible_count: ineligible.length,
    ineligible_tasks: input.include_ineligible
      ? ineligible.slice(0, limit).map((entry) => ({
          task_id: entry.task.task_id,
          objective: entry.task.objective,
          priority: entry.task.priority,
          reason: entry.reason,
          blockers: entry.routing.blockers,
          routing: entry.routing.routing,
          task: entry.task,
        }))
      : [],
  };
}

export async function agentClaimNext(storage: Storage, input: z.infer<typeof agentClaimNextSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.claim_next",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const session = storage.getAgentSessionById(input.session_id);
      if (!session) {
        return {
          claimed: false,
          reason: "session-not-found",
          session_id: input.session_id,
        };
      }
      if (session.status === "closed" || session.status === "failed") {
        return {
          claimed: false,
          reason: `session-not-claimable:${session.status}`,
          session,
        };
      }

      const existingTask = storage.getRunningTaskByWorkerId(session.session_id);
      if (existingTask) {
        const renewedSession = storage.heartbeatAgentSession({
          session_id: session.session_id,
          lease_seconds: input.lease_seconds ?? 300,
          status: "busy",
          metadata: {
            current_task_id: existingTask.task_id,
            last_claim_attempt_at: new Date().toISOString(),
            last_claim_reason: "session-already-holds-task",
            ...(input.metadata ?? {}),
          },
        });
        return {
          claimed: false,
          reason: "session-already-holds-task",
          session: renewedSession.session ?? session,
          task: existingTask,
          lease_expires_at: existingTask.lease?.lease_expires_at ?? null,
        };
      }

      const selection = selectTaskCandidate(storage, session, {
        task_id: input.task_id,
        scan_limit: 200,
      });
      if (!selection.candidate) {
        const nextStatus = selection.reason === "none-available" || selection.reason === "none-eligible" ? "idle" : session.status;
        const renewedSession = storage.heartbeatAgentSession({
          session_id: session.session_id,
          lease_seconds: input.lease_seconds ?? 300,
          status: nextStatus,
          metadata: {
            current_task_id: null,
            last_claim_attempt_at: new Date().toISOString(),
            last_claim_reason: selection.reason,
            last_claimed_task_id: null,
            scanned_task_count: selection.scanned,
            ...(input.metadata ?? {}),
          },
        });
        return {
          claimed: false,
          reason: selection.reason,
          session: renewedSession.session ?? session,
          scanned_task_count: selection.scanned,
        };
      }

      const claimed = storage.claimTask({
        worker_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
        task_id: selection.candidate.task.task_id,
      });

      const nextStatus =
        claimed.claimed ? "busy" : claimed.reason === "none-available" || claimed.reason === "none-eligible" ? "idle" : session.status;
      const renewedSession = storage.heartbeatAgentSession({
        session_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
        status: nextStatus,
        metadata: {
          current_task_id: claimed.claimed ? claimed.task?.task_id ?? null : null,
          last_claim_attempt_at: new Date().toISOString(),
          last_claim_reason: claimed.reason,
          last_claimed_task_id: claimed.task?.task_id ?? null,
          scanned_task_count: selection.scanned,
          last_claim_routing_score: selection.candidate.routing.score,
          last_claim_routing_matches: selection.candidate.routing.matched_preferences,
          ...(input.metadata ?? {}),
        },
      });

      const event =
        claimed.claimed && claimed.task
          ? storage.appendRuntimeEvent({
              event_type: "agent.task_claimed",
              entity_type: "task",
              entity_id: claimed.task.task_id,
              status: claimed.task.status,
              summary: `Task ${claimed.task.task_id} claimed through agent session ${session.session_id}.`,
              details: {
                session_id: session.session_id,
                agent_id: session.agent_id,
                client_kind: session.client_kind,
                task_id: claimed.task.task_id,
                lease_expires_at: claimed.lease_expires_at ?? null,
                routing_score: selection.candidate.routing.score,
                matched_preferences: selection.candidate.routing.matched_preferences,
              },
              source_client: session.source_client ?? input.source_client,
              source_model: session.source_model ?? input.source_model,
              source_agent: session.agent_id,
            })
          : null;

      return {
        ...claimed,
        session: renewedSession.session ?? session,
        routing: selection.candidate.routing,
        scanned_task_count: selection.scanned,
        event,
      };
    },
  });
}

export function agentCurrentTask(storage: Storage, input: z.infer<typeof agentCurrentTaskSchema>) {
  const session = storage.getAgentSessionById(input.session_id);
  if (!session) {
    return {
      found: false,
      reason: "session-not-found",
      session_id: input.session_id,
    };
  }
  const task = storage.getRunningTaskByWorkerId(session.session_id);
  if (!task) {
    return {
      found: false,
      reason: "no-active-task",
      session,
    };
  }
  return {
    found: true,
    session,
    task,
  };
}

export async function agentHeartbeatTask(storage: Storage, input: z.infer<typeof agentHeartbeatTaskSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.heartbeat_task",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const session = storage.getAgentSessionById(input.session_id);
      if (!session) {
        return {
          ok: false,
          reason: "session-not-found",
          session_id: input.session_id,
        };
      }
      const activeTask = storage.getRunningTaskByWorkerId(session.session_id);
      const taskId = input.task_id?.trim() || activeTask?.task_id || "";
      if (!taskId) {
        return {
          ok: false,
          reason: "no-active-task",
          session,
        };
      }
      const heartbeat = storage.heartbeatTaskLease({
        task_id: taskId,
        worker_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
      });
      const renewedSession =
        heartbeat.ok
          ? storage.heartbeatAgentSession({
              session_id: session.session_id,
              lease_seconds: input.lease_seconds ?? 300,
              status: "busy",
              metadata: {
                current_task_id: taskId,
                last_task_heartbeat_at: new Date().toISOString(),
                ...(input.metadata ?? {}),
              },
            })
          : { session };
      const event =
        heartbeat.ok && taskId
          ? storage.appendRuntimeEvent({
              event_type: "agent.task_heartbeat",
              entity_type: "task",
              entity_id: taskId,
              status: "running",
              summary: `Task ${taskId} heartbeat recorded through agent session ${session.session_id}.`,
              details: {
                session_id: session.session_id,
                agent_id: session.agent_id,
                task_id: taskId,
                lease_expires_at: heartbeat.lease_expires_at ?? null,
                heartbeat_at: heartbeat.heartbeat_at ?? null,
              },
              source_client: session.source_client ?? input.source_client,
              source_model: session.source_model ?? input.source_model,
              source_agent: session.agent_id,
            })
          : null;
      return {
        ...heartbeat,
        session: renewedSession.session ?? session,
        task: heartbeat.ok ? storage.getTaskById(taskId) : activeTask ?? storage.getTaskById(taskId),
        event,
      };
    },
  });
}

export async function agentReportResult(
  storage: Storage,
  invokeTool: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  input: z.infer<typeof agentReportResultSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.report_result",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const session = storage.getAgentSessionById(input.session_id);
      if (!session) {
        return {
          reported: false,
          reason: "session-not-found",
          session_id: input.session_id,
          task_id: input.task_id,
        };
      }

      const taskBefore = storage.getTaskById(input.task_id);
      if (!taskBefore) {
        return {
          reported: false,
          reason: "task-not-found",
          session,
          task_id: input.task_id,
        };
      }
      if (taskBefore.lease?.owner_id !== session.session_id) {
        return {
          reported: false,
          reason: "owner-mismatch",
          session,
          task: taskBefore,
        };
      }

      const reportedArtifactIds = dedupeStrings(input.produced_artifact_ids);
      const outcomeResult =
        input.outcome === "completed"
          ? storage.completeTask({
              task_id: input.task_id,
              worker_id: session.session_id,
              result: input.result,
              summary: input.summary,
            })
          : storage.failTask({
              task_id: input.task_id,
              worker_id: session.session_id,
              error: input.error ?? "Task failed.",
              result: input.result,
              summary: input.summary,
            });

      const reported =
        input.outcome === "completed"
          ? (outcomeResult as ReturnType<typeof storage.completeTask>).completed
          : (outcomeResult as ReturnType<typeof storage.failTask>).failed;
      if (!reported) {
        return {
          reported: false,
          reason: outcomeResult.reason,
          session,
          task: outcomeResult.task ?? taskBefore,
        };
      }

      const task = outcomeResult.task ?? storage.getTaskById(input.task_id);
      if (!task) {
        throw new Error(`Task missing after agent report: ${input.task_id}`);
      }

      const planContext = resolveTaskPlanContext(storage, task);
      const autoReportArtifact = recordAgentReportArtifact(storage, {
        session,
        task,
        outcome: input.outcome,
        result: input.result,
        summary: input.summary,
        error: input.error,
        run_id: input.run_id,
        observed_metric: input.observed_metric,
        observed_metrics: input.observed_metrics,
        experiment_verdict: input.experiment_verdict,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        planContext,
      });
      const producedArtifactIds = dedupeStrings([...reportedArtifactIds, autoReportArtifact.artifact_id]);
      const artifactLinks = attachArtifactsToTaskContext(
        storage,
        task,
        producedArtifactIds,
        {
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        },
        planContext
      );

      const planStepUpdate = planContext
        ? storage.updatePlanStep({
            plan_id: planContext.plan.plan_id,
            step_id: planContext.step.step_id,
            status: input.outcome === "completed" ? "completed" : "failed",
            task_id: task.task_id,
            run_id: input.run_id,
            produced_artifact_ids: producedArtifactIds,
              metadata: {
                human_approval_required: false,
                dispatch_gate_type: null,
                last_agent_report: {
                  session_id: session.session_id,
                agent_id: session.agent_id,
                reported_at: new Date().toISOString(),
                outcome: input.outcome,
                summary: input.summary?.trim() ?? null,
                error: input.error?.trim() ?? null,
                run_id: input.run_id ?? null,
                produced_artifact_ids: producedArtifactIds,
                result_keys: Object.keys(input.result ?? {}),
                metadata: input.metadata ?? {},
              },
            },
          })
        : null;
      const planStepEvent =
        planContext && planStepUpdate
          ? storage.appendRuntimeEvent({
              event_type: input.outcome === "completed" ? "plan.step_completed" : "plan.step_failed",
              entity_type: "step",
              entity_id: planContext.step.step_id,
              status: planStepUpdate.step.status,
              summary:
                input.summary?.trim() ||
                `Plan step ${planContext.step.step_id} ${input.outcome === "completed" ? "completed" : "failed"} via agent report.`,
              details: {
                plan_id: planContext.plan.plan_id,
                goal_id: planContext.plan.goal_id,
                step_id: planContext.step.step_id,
                task_id: task.task_id,
                run_id: input.run_id ?? null,
                session_id: session.session_id,
                agent_id: session.agent_id,
                produced_artifact_ids: producedArtifactIds,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: session.agent_id,
            })
          : null;

      const experimentRun = storage.findExperimentRunByTaskId(task.task_id);
      const experiment = experimentRun ? storage.getExperimentById(experimentRun.experiment_id) : null;
      const derivedExperimentObservation =
        experiment
          ? deriveExperimentObservation(experiment, {
              observed_metric: input.observed_metric,
              observed_metrics: input.observed_metrics,
              result: input.result,
              metadata: input.metadata,
              summary: input.summary,
            })
          : {
              observed_metric: input.observed_metric,
              observed_metrics: input.observed_metrics,
              source: null,
            };
      const experimentUpdate =
        experimentRun &&
        ((derivedExperimentObservation.observed_metric ?? null) !== null || input.experiment_verdict || input.outcome === "failed")
          ? judgeExperimentRunWithStorage(storage, {
              experiment_id: experimentRun.experiment_id,
              experiment_run_id: experimentRun.experiment_run_id,
              status: input.outcome === "failed" ? "crash" : "completed",
              verdict: input.experiment_verdict,
              task_id: task.task_id,
              run_id: input.run_id,
              observed_metric: derivedExperimentObservation.observed_metric,
              observed_metrics: derivedExperimentObservation.observed_metrics,
              summary: input.summary,
              error_text: input.outcome === "failed" ? input.error : undefined,
              artifact_ids: producedArtifactIds,
              metadata: {
                ...(input.metadata ?? {}),
                ...(derivedExperimentObservation.source
                  ? { observed_metric_source: derivedExperimentObservation.source }
                  : {}),
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            })
          : experimentRun
            ? {
                ok: true,
                followup_required: true,
                experiment_id: experimentRun.experiment_id,
                experiment_run_id: experimentRun.experiment_run_id,
                reason: "call experiment.judge with observed metrics to finalize benchmark selection",
              }
            : null;

      const renewedSession = storage.heartbeatAgentSession({
        session_id: session.session_id,
        lease_seconds: 300,
        status: input.next_session_status ?? "idle",
        metadata: {
          current_task_id: null,
          last_reported_task_id: task.task_id,
          last_reported_at: new Date().toISOString(),
          last_report_outcome: input.outcome,
          last_run_id: input.run_id ?? null,
          last_produced_artifact_ids: producedArtifactIds,
          ...(input.metadata ?? {}),
        },
      });
      const goalAutorunTrigger = shouldTriggerGoalAutorun(storage, task, planContext);
      const goalAutorun =
        input.outcome === "completed" && goalAutorunTrigger.enabled && goalAutorunTrigger.goal_id
          ? ((await invokeTool("goal.autorun", {
              mutation: buildAgentDerivedMutation(input.mutation, `goal-autorun:${task.task_id}`),
              goal_id: goalAutorunTrigger.goal_id,
              create_plan_if_missing: false,
              max_passes: goalAutorunTrigger.max_passes ?? 4,
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: session.agent_id,
            })) as Record<string, unknown>)
          : {
              triggered: false,
              reason: input.outcome !== "completed" ? "task_failed" : goalAutorunTrigger.reason,
            };
      const agentTaskEvent = storage.appendRuntimeEvent({
        event_type: "agent.task_reported",
        entity_type: "task",
        entity_id: task.task_id,
        status: task.status,
        summary:
          input.summary?.trim() ||
          `Task ${task.task_id} ${input.outcome === "completed" ? "completed" : "failed"} through agent session ${session.session_id}.`,
        details: {
          session_id: session.session_id,
          agent_id: session.agent_id,
          task_id: task.task_id,
                outcome: input.outcome,
                run_id: input.run_id ?? null,
                produced_artifact_ids: producedArtifactIds,
                artifact_links_created: artifactLinks.length,
                auto_report_artifact_id: autoReportArtifact.artifact_id,
                experiment_run_id: experimentRun?.experiment_run_id ?? null,
                goal_autorun_triggered: goalAutorunTrigger.enabled && input.outcome === "completed",
              },
              source_client: input.source_client,
              source_model: input.source_model,
        source_agent: session.agent_id,
      });

      return {
        reported: true,
        reason: input.outcome,
        task,
        session: renewedSession.session ?? session,
        plan_step_update: planStepUpdate,
        produced_artifact_ids: producedArtifactIds,
        auto_report_artifact_id: autoReportArtifact.artifact_id,
        artifact_links_created: artifactLinks.length,
        artifact_links: artifactLinks,
        experiment: experimentUpdate,
        goal_autorun: goalAutorun,
        events: {
          task: agentTaskEvent,
          step: planStepEvent,
        },
      };
    },
  });
}
