import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const eventPublishSchema = z
  .object({
    mutation: mutationSchema,
    event_id: z.string().min(1).max(200).optional(),
    created_at: z.string().optional(),
    event_type: z.string().min(1),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
    details: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if ((value.entity_type && !value.entity_id) || (!value.entity_type && value.entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entity_type and entity_id must be provided together",
        path: ["entity_type"],
      });
    }
  });

export const eventTailSchema = z
  .object({
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    source_agent: z.string().min(1).optional(),
    source_client: z.string().min(1).optional(),
    event_type: z.string().min(1).optional(),
    event_types: z.array(z.string().min(1)).max(500).optional(),
    since_seq: z.number().int().min(0).optional(),
    since: z.string().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.entity_type && !value.entity_id) || (!value.entity_type && value.entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entity_type and entity_id must be provided together",
        path: ["entity_type"],
      });
    }
  });

export const eventSummarySchema = z
  .object({
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    source_agent: z.string().min(1).optional(),
    source_client: z.string().min(1).optional(),
    event_type: z.string().min(1).optional(),
    event_types: z.array(z.string().min(1)).max(500).optional(),
    since: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.entity_type && !value.entity_id) || (!value.entity_type && value.entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entity_type and entity_id must be provided together",
        path: ["entity_type"],
      });
    }
  });

export async function eventPublish(storage: Storage, input: z.infer<typeof eventPublishSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "event.publish",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.appendRuntimeEvent({
        event_id: input.event_id,
        created_at: input.created_at,
        event_type: input.event_type,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        status: input.status,
        summary: input.summary,
        content: input.content,
        details: input.details,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export function eventTail(storage: Storage, input: z.infer<typeof eventTailSchema>) {
  const events = storage.listRuntimeEvents({
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    source_agent: input.source_agent,
    source_client: input.source_client,
    event_type: input.event_type,
    event_types: input.event_types,
    since_seq: input.since_seq,
    since: input.since,
    limit: input.limit ?? 200,
  });
  return {
    count: events.length,
    events,
    filters: {
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      source_agent: input.source_agent ?? null,
      source_client: input.source_client ?? null,
      event_type: input.event_type ?? null,
      event_types: input.event_types ?? [],
      since_seq: input.since_seq ?? null,
      since: input.since ?? null,
    },
  };
}

export function eventSummary(storage: Storage, input: z.infer<typeof eventSummarySchema>) {
  return {
    ...storage.summarizeRuntimeEvents({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      source_agent: input.source_agent,
      source_client: input.source_client,
      event_type: input.event_type,
      event_types: input.event_types,
      since: input.since,
    }),
    filters: {
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      source_agent: input.source_agent ?? null,
      source_client: input.source_client ?? null,
      event_type: input.event_type ?? null,
      event_types: input.event_types ?? [],
      since: input.since ?? null,
    },
  };
}
