import crypto from "node:crypto";
import { z } from "zod";
import { Storage } from "../storage.js";
import { recordBudgetLedgerUsage } from "../control_plane_runtime.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { budgetUsageSchema } from "./control_plane_admin.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const routerSuppressionSchema = z.record(z.unknown()).nullable().optional();

export const runBeginSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().optional(),
  status: z.string().default("in_progress"),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  latest_router_suppression: routerSuppressionSchema,
  usage: budgetUsageSchema.optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const runStepSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().min(1),
  step_index: z.number().int().min(1),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  latest_router_suppression: routerSuppressionSchema,
  usage: budgetUsageSchema.optional(),
  ...sourceSchema.shape,
});

export const runEndSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().min(1),
  step_index: z.number().int().min(1).optional(),
  status: z.enum(["succeeded", "failed", "aborted"]),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  latest_router_suppression: routerSuppressionSchema,
  usage: budgetUsageSchema.optional(),
  ...sourceSchema.shape,
});

export const runTimelineSchema = z.object({
  run_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLatestRouterSuppression(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function extractLatestRouterSuppressionFromDetails(details: unknown): Record<string, unknown> | null {
  const record = isRecord(details) ? details : {};
  return readLatestRouterSuppression(record.latest_router_suppression);
}

function buildRecentRouterSuppressionSnapshot(storage: Storage): Record<string, unknown> | null {
  const events = storage.listRuntimeEvents({
    event_type: "autonomy.command",
    limit: 80,
  });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const details = isRecord(events[index]?.details) ? events[index]!.details : {};
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
    return {
      decision_id: typeof details.model_router_suppression_decision_id === "string" ? details.model_router_suppression_decision_id : null,
      observed_at: typeof events[index]?.created_at === "string" ? events[index]!.created_at : null,
      reason,
      selected_backend_id: typeof details.model_router_backend_id === "string" ? details.model_router_backend_id : null,
      pressure_level:
        isRecord(details.model_router_resource_gate) && typeof details.model_router_resource_gate.severity === "string"
          ? details.model_router_resource_gate.severity
          : null,
      suppressed_agent_ids: Array.isArray(details.model_router_auto_bridge_suppressed_agent_ids)
        ? [
            ...new Set(
              details.model_router_auto_bridge_suppressed_agent_ids.map((entry) => String(entry ?? "").trim()).filter(Boolean)
            ),
          ]
        : [],
    };
  }
  return null;
}

function resolveRunRouterSuppression(
  storage: Storage,
  params: {
    run_id?: string;
    details?: Record<string, unknown>;
    latest_router_suppression?: Record<string, unknown> | null;
    prefer_existing_run_snapshot?: boolean;
  }
) {
  if (params.prefer_existing_run_snapshot && params.run_id) {
    const timeline = storage.getRunTimeline(params.run_id, 1000);
    for (const event of timeline) {
      const snapshot = extractLatestRouterSuppressionFromDetails(event.details);
      if (snapshot) {
        return snapshot;
      }
    }
  }
  if (params.latest_router_suppression) {
    return params.latest_router_suppression;
  }
  const fromDetails = extractLatestRouterSuppressionFromDetails(params.details);
  if (fromDetails) {
    return fromDetails;
  }
  if (params.run_id) {
    const timeline = storage.getRunTimeline(params.run_id, 1000);
    for (const event of timeline) {
      const snapshot = extractLatestRouterSuppressionFromDetails(event.details);
      if (snapshot) {
        return snapshot;
      }
    }
  }
  return buildRecentRouterSuppressionSnapshot(storage);
}

function attachLatestRouterSuppression(
  details: Record<string, unknown> | undefined,
  latestRouterSuppression: Record<string, unknown> | null
) {
  if (!latestRouterSuppression) {
    return details;
  }
  return {
    ...(details ?? {}),
    latest_router_suppression: latestRouterSuppression,
  };
}

export async function runBegin(storage: Storage, input: z.infer<typeof runBeginSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "run.begin",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const runId = input.run_id ?? crypto.randomUUID();
      const latestRouterSuppression = resolveRunRouterSuppression(storage, {
        details: input.details,
        latest_router_suppression: input.latest_router_suppression ?? null,
      });
      const details = attachLatestRouterSuppression(input.details, latestRouterSuppression);
      const event = storage.appendRunEvent({
        run_id: runId,
        event_type: "begin",
        step_index: 0,
        status: input.status,
        summary: input.summary,
        details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordBudgetLedgerUsage(storage, {
        ledger_kind: "projection",
        usage: input.usage,
        usage_sources: [details],
        entity_type: "run",
        entity_id: runId,
        run_id: runId,
        notes: input.summary,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        run_id: runId,
        event_id: event.id,
        created_at: event.created_at,
        latest_router_suppression: latestRouterSuppression,
      };
    },
  });
}

export async function runStep(storage: Storage, input: z.infer<typeof runStepSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "run.step",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const latestRouterSuppression = resolveRunRouterSuppression(storage, {
        run_id: input.run_id,
        details: input.details,
        latest_router_suppression: input.latest_router_suppression ?? null,
        prefer_existing_run_snapshot: true,
      });
      const details = attachLatestRouterSuppression(input.details, latestRouterSuppression);
      const event = storage.appendRunEvent({
        run_id: input.run_id,
        event_type: "step",
        step_index: input.step_index,
        status: input.status,
        summary: input.summary,
        details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordBudgetLedgerUsage(storage, {
        usage: input.usage,
        usage_sources: [details],
        entity_type: "run",
        entity_id: input.run_id,
        run_id: input.run_id,
        notes: input.summary,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        run_id: input.run_id,
        event_id: event.id,
        created_at: event.created_at,
        latest_router_suppression: latestRouterSuppression,
      };
    },
  });
}

export async function runEnd(storage: Storage, input: z.infer<typeof runEndSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "run.end",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const stepIndex = input.step_index ?? 999999;
      const latestRouterSuppression = resolveRunRouterSuppression(storage, {
        run_id: input.run_id,
        details: input.details,
        latest_router_suppression: input.latest_router_suppression ?? null,
        prefer_existing_run_snapshot: true,
      });
      const details = attachLatestRouterSuppression(input.details, latestRouterSuppression);
      const event = storage.appendRunEvent({
        run_id: input.run_id,
        event_type: "end",
        step_index: stepIndex,
        status: input.status,
        summary: input.summary,
        details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordBudgetLedgerUsage(storage, {
        ledger_kind: "actual",
        usage: input.usage,
        usage_sources: [details],
        entity_type: "run",
        entity_id: input.run_id,
        run_id: input.run_id,
        notes: input.summary,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        run_id: input.run_id,
        event_id: event.id,
        created_at: event.created_at,
        latest_router_suppression: latestRouterSuppression,
      };
    },
  });
}

export function runTimeline(storage: Storage, input: z.infer<typeof runTimelineSchema>) {
  const limit = input.limit ?? 100;
  const events = storage.getRunTimeline(input.run_id, limit);
  const latestRouterSuppression =
    events.map((event) => extractLatestRouterSuppressionFromDetails(event.details)).find((entry) => Boolean(entry)) ?? null;
  return {
    run_id: input.run_id,
    count: events.length,
    latest_router_suppression: latestRouterSuppression,
    events,
  };
}
