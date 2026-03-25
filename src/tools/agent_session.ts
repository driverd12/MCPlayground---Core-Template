import { z } from "zod";
import { Storage, type PlanRecord, type PlanStepRecord, type TaskRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { judgeExperimentRunWithStorage } from "./experiment.js";

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

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

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

      const claimed = storage.claimTask({
        worker_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
        task_id: input.task_id,
      });

      const nextStatus = claimed.claimed ? "busy" : claimed.reason === "none-available" ? "idle" : session.status;
      const renewedSession = storage.heartbeatAgentSession({
        session_id: session.session_id,
        lease_seconds: input.lease_seconds ?? 300,
        status: nextStatus,
        metadata: {
          current_task_id: claimed.claimed ? claimed.task?.task_id ?? null : null,
          last_claim_attempt_at: new Date().toISOString(),
          last_claim_reason: claimed.reason,
          last_claimed_task_id: claimed.task?.task_id ?? null,
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
              },
              source_client: session.source_client ?? input.source_client,
              source_model: session.source_model ?? input.source_model,
              source_agent: session.agent_id,
            })
          : null;

      return {
        ...claimed,
        session: renewedSession.session ?? session,
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

export async function agentReportResult(storage: Storage, input: z.infer<typeof agentReportResultSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.report_result",
    mutation: input.mutation,
    payload: input,
    execute: () => {
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

      const producedArtifactIds = dedupeStrings(input.produced_artifact_ids);
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
      const experimentUpdate =
        experimentRun && (input.observed_metric !== undefined || input.experiment_verdict || input.outcome === "failed")
          ? judgeExperimentRunWithStorage(storage, {
              experiment_id: experimentRun.experiment_id,
              experiment_run_id: experimentRun.experiment_run_id,
              status: input.outcome === "failed" ? "crash" : "completed",
              verdict: input.experiment_verdict,
              task_id: task.task_id,
              run_id: input.run_id,
              observed_metric: input.observed_metric,
              observed_metrics: input.observed_metrics,
              summary: input.summary,
              error_text: input.outcome === "failed" ? input.error : undefined,
              artifact_ids: producedArtifactIds,
              metadata: input.metadata,
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
          experiment_run_id: experimentRun?.experiment_run_id ?? null,
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
        artifact_links_created: artifactLinks.length,
        artifact_links: artifactLinks,
        experiment: experimentUpdate,
        events: {
          task: agentTaskEvent,
          step: planStepEvent,
        },
      };
    },
  });
}
