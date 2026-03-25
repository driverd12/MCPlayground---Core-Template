import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

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

export async function openAgentSession(storage: Storage, input: z.infer<typeof agentSessionOpenSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "agent.session_open",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.upsertAgentSession({
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
      }),
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
    execute: () =>
      storage.closeAgentSession({
        session_id: input.session_id,
        metadata: input.metadata,
      }),
  });
}
