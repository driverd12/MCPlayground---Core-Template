import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { Storage, TriChatBusEventRecord, TriChatMessageRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const TRICHAT_BUS_ACTIONS = ["status", "start", "stop", "publish", "tail"] as const;

type TriChatBusAction = (typeof TRICHAT_BUS_ACTIONS)[number];

type TriChatBusSubscription = {
  subscription_id: string;
  thread_id: string | null;
  source_agent: string | null;
  event_types: Set<string>;
  since_seq: number;
  created_at: string;
};

type TriChatBusClient = {
  client_id: number;
  socket: net.Socket;
  connected_at: string;
  buffer: string;
  subscriptions: Map<string, TriChatBusSubscription>;
  messages_in: number;
  messages_out: number;
  last_error: string | null;
};

type TriChatBusPublishInput = {
  thread_id: string;
  event_type: string;
  source_agent?: string;
  source_client?: string;
  role?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  event_id?: string;
  persist_message?: boolean;
  reply_to_message_id?: string;
};

type TriChatBusPublishResult = {
  event: TriChatBusEventRecord;
  delivered_clients: number;
  persisted_message: TriChatMessageRecord | null;
  socket_running: boolean;
  socket_path: string;
};

export const trichatBusSchema = z
  .object({
    action: z.enum(TRICHAT_BUS_ACTIONS).default("status"),
    mutation: mutationSchema.optional(),
    thread_id: z.string().min(1).optional(),
    source_agent: z.string().min(1).optional(),
    source_client: z.string().min(1).optional(),
    event_type: z.string().min(1).optional(),
    event_types: z.array(z.string().min(1)).max(200).optional(),
    role: z.string().min(1).optional(),
    content: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    event_id: z.string().min(1).optional(),
    created_at: z.string().optional(),
    since_seq: z.number().int().min(0).optional(),
    since: z.string().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    include_content: z.boolean().optional(),
    persist_message: z.boolean().optional(),
    reply_to_message_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const action = value.action;
    if ((action === "start" || action === "stop" || action === "publish") && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutation"],
        message: "mutation is required for start, stop, and publish actions",
      });
    }
    if (action === "publish") {
      if (!value.thread_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thread_id"],
          message: "thread_id is required for publish action",
        });
      }
      if (!value.event_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["event_type"],
          message: "event_type is required for publish action",
        });
      }
      if (value.persist_message) {
        if (!value.source_agent) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source_agent"],
            message: "source_agent is required when persist_message=true",
          });
        }
        if (!value.role) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["role"],
            message: "role is required when persist_message=true",
          });
        }
        if (!value.content || !value.content.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content"],
            message: "content is required when persist_message=true",
          });
        }
      }
    }
  });

export type TriChatBusRuntimeOptions = {
  socket_path: string;
  auto_start?: boolean;
};

export class TriChatBusRuntime {
  private readonly socketPath: string;
  private server: net.Server | null = null;
  private readonly clients = new Map<number, TriChatBusClient>();
  private nextClientId = 1;
  private running = false;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private totalPublished = 0;
  private totalDelivered = 0;

  constructor(private readonly storage: Storage, options: TriChatBusRuntimeOptions) {
    this.socketPath = path.resolve(options.socket_path);
  }

  initialize(options?: { auto_start?: boolean }) {
    const autoStart = options?.auto_start ?? true;
    if (autoStart) {
      try {
        this.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        console.error(`[trichat.bus] startup failed: ${message}`);
      }
    }
    return this.status();
  }

  start() {
    if (this.running && this.server) {
      return {
        ...this.status(),
        started: false,
      };
    }

    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    this.safeUnlinkSocketPath();

    const server = net.createServer((socket) => this.handleConnection(socket));
    server.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      console.error(`[trichat.bus] server error: ${message}`);
    });
    server.listen(this.socketPath);
    server.unref?.();

    this.server = server;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    return {
      ...this.status(),
      started: true,
    };
  }

  stop() {
    const wasRunning = this.running;
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // Best-effort close; continue cleanup.
      }
    }
    this.server = null;
    this.running = false;
    this.startedAt = null;

    for (const client of this.clients.values()) {
      try {
        client.socket.destroy();
      } catch {
        // Best-effort close.
      }
    }
    this.clients.clear();
    this.safeUnlinkSocketPath();
    return {
      ...this.status(),
      stopped: wasRunning,
    };
  }

  status() {
    let subscriptionCount = 0;
    let messagesIn = 0;
    let messagesOut = 0;
    for (const client of this.clients.values()) {
      subscriptionCount += client.subscriptions.size;
      messagesIn += client.messages_in;
      messagesOut += client.messages_out;
    }
    return {
      running: this.running,
      socket_path: this.socketPath,
      started_at: this.startedAt,
      last_error: this.lastError,
      client_count: this.clients.size,
      subscription_count: subscriptionCount,
      metrics: {
        total_published: this.totalPublished,
        total_delivered: this.totalDelivered,
        messages_in: messagesIn,
        messages_out: messagesOut,
      },
    };
  }

  publish(input: TriChatBusPublishInput): TriChatBusPublishResult {
    const metadata = input.metadata ?? {};
    const event = this.storage.appendTriChatBusEvent({
      thread_id: input.thread_id,
      event_type: input.event_type,
      source_agent: input.source_agent,
      source_client: input.source_client,
      role: input.role,
      content: input.content,
      metadata,
      created_at: input.created_at,
      event_id: input.event_id,
    });

    let persistedMessage: TriChatMessageRecord | null = null;
    if (input.persist_message) {
      const role = String(input.role ?? "").trim();
      const agentId = String(input.source_agent ?? "").trim();
      const content = String(input.content ?? "").trim();
      if (!role || !agentId || !content) {
        throw new Error("persist_message requires source_agent, role, and content");
      }
      persistedMessage = this.storage.appendTriChatMessage({
        thread_id: input.thread_id,
        agent_id: agentId,
        role,
        content,
        reply_to_message_id: input.reply_to_message_id,
        metadata: {
          ...metadata,
          bus_event_id: event.event_id,
          bus_event_seq: event.event_seq,
        },
      });
    }

    this.totalPublished += 1;
    const delivered = this.broadcastEvent(event);
    this.totalDelivered += delivered;
    return {
      event,
      delivered_clients: delivered,
      persisted_message: persistedMessage,
      socket_running: this.running,
      socket_path: this.socketPath,
    };
  }

  tail(params: {
    thread_id?: string;
    source_agent?: string;
    event_types?: string[];
    since_seq?: number;
    since?: string;
    limit?: number;
  }) {
    return this.storage.listTriChatBusEvents(params);
  }

  publishFromTriChatMessage(message: TriChatMessageRecord, sourceClient = "mcp:trichat.message_post") {
    return this.publish({
      thread_id: message.thread_id,
      event_type: "trichat.message_post",
      source_agent: message.agent_id,
      source_client: sourceClient,
      role: message.role,
      content: message.content,
      metadata: {
        message_id: message.message_id,
        reply_to_message_id: message.reply_to_message_id,
        message_metadata: message.metadata,
      },
    });
  }

  private safeUnlinkSocketPath() {
    if (!fs.existsSync(this.socketPath)) {
      return;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `unable to unlink socket path: ${message}`;
    }
  }

  private handleConnection(socket: net.Socket) {
    const clientId = this.nextClientId++;
    const client: TriChatBusClient = {
      client_id: clientId,
      socket,
      connected_at: new Date().toISOString(),
      buffer: "",
      subscriptions: new Map<string, TriChatBusSubscription>(),
      messages_in: 0,
      messages_out: 0,
      last_error: null,
    };
    this.clients.set(clientId, client);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.handleClientChunk(client, chunk);
    });
    socket.on("error", (error) => {
      client.last_error = error instanceof Error ? error.message : String(error);
    });
    socket.on("close", () => {
      this.clients.delete(clientId);
    });
  }

  private handleClientChunk(client: TriChatBusClient, chunk: string) {
    client.buffer += chunk;
    while (true) {
      const newlineIndex = client.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = client.buffer.slice(0, newlineIndex).trim();
      client.buffer = client.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      client.messages_in += 1;
      this.handleClientCommand(client, line);
    }
  }

  private handleClientCommand(client: TriChatBusClient, line: string) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeClient(client, {
        kind: "error",
        error: `invalid_json: ${message}`,
      });
      return;
    }

    const op = String(parsed.op ?? "").trim().toLowerCase();
    if (!op) {
      this.writeClient(client, {
        kind: "error",
        error: "missing op",
      });
      return;
    }

    try {
      if (op === "ping") {
        this.writeClient(client, {
          kind: "pong",
          server_time: new Date().toISOString(),
        });
        return;
      }

      if (op === "status") {
        this.writeClient(client, {
          kind: "status",
          status: this.status(),
        });
        return;
      }

      if (op === "tail") {
        const eventTypes = asStringArray(parsed.event_types);
        const events = this.tail({
          thread_id: asOptionalString(parsed.thread_id) ?? undefined,
          source_agent: asOptionalString(parsed.source_agent) ?? undefined,
          event_types: eventTypes.length > 0 ? eventTypes : undefined,
          since_seq: asOptionalInt(parsed.since_seq),
          since: asOptionalString(parsed.since) ?? undefined,
          limit: asOptionalInt(parsed.limit),
        });
        this.writeClient(client, {
          kind: "tail",
          count: events.length,
          events,
        });
        return;
      }

      if (op === "subscribe") {
        const subscriptionId = `sub-${crypto.randomUUID()}`;
        const eventTypes = asStringArray(parsed.event_types);
        const subscription: TriChatBusSubscription = {
          subscription_id: subscriptionId,
          thread_id: asOptionalString(parsed.thread_id),
          source_agent: asOptionalString(parsed.source_agent),
          event_types: new Set<string>(eventTypes),
          since_seq: asOptionalInt(parsed.since_seq) ?? 0,
          created_at: new Date().toISOString(),
        };
        client.subscriptions.set(subscriptionId, subscription);
        this.writeClient(client, {
          kind: "subscribed",
          subscription_id: subscriptionId,
          thread_id: subscription.thread_id,
          source_agent: subscription.source_agent,
          event_types: Array.from(subscription.event_types),
          since_seq: subscription.since_seq,
        });

        const replayLimit = boundedInt(asOptionalInt(parsed.replay_limit), 200, 1, 5000);
        const replayEvents = this.tail({
          thread_id: subscription.thread_id ?? undefined,
          source_agent: subscription.source_agent ?? undefined,
          event_types: eventTypes.length > 0 ? eventTypes : undefined,
          since_seq: subscription.since_seq,
          limit: replayLimit,
        });
        for (const event of replayEvents) {
          this.writeClient(client, {
            kind: "event",
            subscription_ids: [subscriptionId],
            event,
          });
          subscription.since_seq = Math.max(subscription.since_seq, event.event_seq);
        }
        return;
      }

      if (op === "unsubscribe") {
        const subscriptionId = asOptionalString(parsed.subscription_id);
        if (!subscriptionId) {
          throw new Error("subscription_id is required for unsubscribe");
        }
        const removed = client.subscriptions.delete(subscriptionId);
        this.writeClient(client, {
          kind: "unsubscribed",
          subscription_id: subscriptionId,
          removed,
        });
        return;
      }

      if (op === "publish") {
        const threadId = asOptionalString(parsed.thread_id);
        const eventType = asOptionalString(parsed.event_type);
        if (!threadId || !eventType) {
          throw new Error("publish requires thread_id and event_type");
        }
        const metadata = asRecord(parsed.metadata);
        const publishResult = this.publish({
          thread_id: threadId,
          event_type: eventType,
          source_agent: asOptionalString(parsed.source_agent) ?? undefined,
          source_client: asOptionalString(parsed.source_client) ?? "socket:publish",
          role: asOptionalString(parsed.role) ?? undefined,
          content: asOptionalString(parsed.content) ?? undefined,
          metadata,
          created_at: asOptionalString(parsed.created_at) ?? undefined,
          event_id: asOptionalString(parsed.event_id) ?? undefined,
          persist_message: Boolean(parsed.persist_message),
          reply_to_message_id: asOptionalString(parsed.reply_to_message_id) ?? undefined,
        });
        this.writeClient(client, {
          kind: "published",
          ...publishResult,
        });
        return;
      }

      this.writeClient(client, {
        kind: "error",
        error: `unsupported op: ${op}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      client.last_error = message;
      this.writeClient(client, {
        kind: "error",
        error: message,
      });
    }
  }

  private broadcastEvent(event: TriChatBusEventRecord): number {
    let deliveredClients = 0;
    for (const client of this.clients.values()) {
      const matchedSubscriptions: string[] = [];
      for (const subscription of client.subscriptions.values()) {
        if (!subscriptionMatchesEvent(subscription, event)) {
          continue;
        }
        matchedSubscriptions.push(subscription.subscription_id);
        subscription.since_seq = Math.max(subscription.since_seq, event.event_seq);
      }
      if (matchedSubscriptions.length === 0) {
        continue;
      }
      this.writeClient(client, {
        kind: "event",
        subscription_ids: matchedSubscriptions,
        event,
      });
      deliveredClients += 1;
    }
    return deliveredClients;
  }

  private writeClient(client: TriChatBusClient, payload: Record<string, unknown>) {
    if (client.socket.destroyed) {
      return;
    }
    try {
      client.socket.write(`${JSON.stringify(payload)}\n`);
      client.messages_out += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      client.last_error = message;
      try {
        client.socket.destroy();
      } catch {
        // ignore close failures
      }
    }
  }
}

export function trichatBusControl(
  storage: Storage,
  runtime: TriChatBusRuntime,
  input: z.infer<typeof trichatBusSchema>
) {
  const action: TriChatBusAction = input.action;
  if (action === "status") {
    return runtime.status();
  }
  if (action === "tail") {
    const events = runtime.tail({
      thread_id: input.thread_id,
      source_agent: input.source_agent,
      event_types: input.event_types,
      since_seq: input.since_seq,
      since: input.since,
      limit: input.limit ?? 200,
    });
    const includeContent = input.include_content ?? true;
    return {
      count: events.length,
      thread_id: input.thread_id ?? null,
      since_seq: input.since_seq ?? null,
      events: includeContent
        ? events
        : events.map((event) => ({
            ...event,
            content: null,
          })),
      status: runtime.status(),
    };
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and publish actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "trichat.bus",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (action === "start") {
        return runtime.start();
      }
      if (action === "stop") {
        return runtime.stop();
      }
      if (action === "publish") {
        const result = runtime.publish({
          thread_id: input.thread_id ?? "",
          event_type: input.event_type ?? "",
          source_agent: input.source_agent,
          source_client: input.source_client,
          role: input.role,
          content: input.content,
          metadata: input.metadata,
          created_at: input.created_at,
          event_id: input.event_id,
          persist_message: input.persist_message ?? false,
          reply_to_message_id: input.reply_to_message_id,
        });
        return {
          action: "publish",
          ...result,
          status: runtime.status(),
        };
      }
      throw new Error(`unsupported action: ${action}`);
    },
  });
}

function subscriptionMatchesEvent(subscription: TriChatBusSubscription, event: TriChatBusEventRecord): boolean {
  if (subscription.thread_id && subscription.thread_id !== event.thread_id) {
    return false;
  }
  if (subscription.source_agent) {
    if (!event.source_agent || subscription.source_agent !== event.source_agent) {
      return false;
    }
  }
  if (subscription.event_types.size > 0 && !subscription.event_types.has(event.event_type)) {
    return false;
  }
  return event.event_seq > subscription.since_seq;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ?? fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
