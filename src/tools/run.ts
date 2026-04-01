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

export const runBeginSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().optional(),
  status: z.string().default("in_progress"),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
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
  usage: budgetUsageSchema.optional(),
  ...sourceSchema.shape,
});

export const runTimelineSchema = z.object({
  run_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function runBegin(storage: Storage, input: z.infer<typeof runBeginSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "run.begin",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const runId = input.run_id ?? crypto.randomUUID();
      const event = storage.appendRunEvent({
        run_id: runId,
        event_type: "begin",
        step_index: 0,
        status: input.status,
        summary: input.summary,
        details: input.details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordBudgetLedgerUsage(storage, {
        ledger_kind: "projection",
        usage: input.usage,
        usage_sources: [input.details],
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
      const event = storage.appendRunEvent({
        run_id: input.run_id,
        event_type: "step",
        step_index: input.step_index,
        status: input.status,
        summary: input.summary,
        details: input.details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordBudgetLedgerUsage(storage, {
        usage: input.usage,
        usage_sources: [input.details],
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
      const event = storage.appendRunEvent({
        run_id: input.run_id,
        event_type: "end",
        step_index: stepIndex,
        status: input.status,
        summary: input.summary,
        details: input.details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordBudgetLedgerUsage(storage, {
        ledger_kind: "actual",
        usage: input.usage,
        usage_sources: [input.details],
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
      };
    },
  });
}

export function runTimeline(storage: Storage, input: z.infer<typeof runTimelineSchema>) {
  const limit = input.limit ?? 100;
  const events = storage.getRunTimeline(input.run_id, limit);
  return {
    run_id: input.run_id,
    count: events.length,
    events,
  };
}
