import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { captureLocalHostProfile } from "../local_host_profile.js";
import {
  type ObservabilityDocumentRecord,
  type ObservabilityLevel,
  type RuntimeEventRecord,
  Storage,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { resolveEffectiveWorkerFabric } from "./worker_fabric.js";

const levelSchema = z.enum(["trace", "debug", "info", "warn", "error", "critical"]);
const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
const triChatAdapterChannelSchema = z.enum(["command", "model"]);
const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const observabilityDocumentInputSchema = z.object({
  document_id: z.string().min(1).max(200).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  level: levelSchema.optional(),
  host_id: z.string().min(1).max(200).optional(),
  service: z.string().min(1).max(200).optional(),
  event_type: z.string().min(1).max(200).optional(),
  title: z.string().max(500).optional(),
  body_text: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(200)).max(100).optional(),
});
type IngestableDocument = z.infer<typeof observabilityDocumentInputSchema>;

export const observabilityIngestSchema = z.object({
  mutation: mutationSchema,
  index_name: z.string().min(1).max(200),
  source_kind: z.string().min(1).max(200),
  source_ref: z.string().min(1).max(500).optional(),
  documents: z.array(observabilityDocumentInputSchema).min(1).max(2000),
  mirror_runtime_events: z.boolean().optional(),
  ...sourceSchema.shape,
});

export const observabilitySearchSchema = z.object({
  query: z.string().optional(),
  index_names: z.array(z.string().min(1).max(200)).max(50).optional(),
  source_kind: z.string().min(1).max(200).optional(),
  source_ref: z.string().min(1).max(500).optional(),
  host_id: z.string().min(1).max(200).optional(),
  service: z.string().min(1).max(200).optional(),
  levels: z.array(levelSchema).max(20).optional(),
  event_types: z.array(z.string().min(1).max(200)).max(100).optional(),
  tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  include_runtime_events: z.boolean().optional(),
});

export const observabilityDashboardSchema = z.object({
  since: z.string().optional(),
  recent_limit: z.number().int().min(1).max(100).optional(),
  critical_window_minutes: z.number().int().min(1).max(1440).optional(),
});

export const observabilityShipSchema = z
  .object({
    mutation: mutationSchema,
    source: z.enum([
      "local_host",
      "worker_fabric",
      "cluster_topology",
      "model_router",
      "runtime_events",
      "run_timeline",
      "incident_timeline",
      "task_timeline",
      "file",
      "task_queue",
      "trichat_bus",
      "trichat_adapter",
      "trichat_summary",
    ]),
    index_name: z.string().min(1).max(200).optional(),
    file_path: z.string().min(1).optional(),
    service: z.string().min(1).max(200).optional(),
    host_id: z.string().min(1).max(200).optional(),
    run_id: z.string().min(1).max(200).optional(),
    incident_id: z.string().min(1).max(200).optional(),
    task_id: z.string().min(1).max(200).optional(),
    thread_id: z.string().min(1).max(200).optional(),
    agent_id: z.string().min(1).max(200).optional(),
    channel: triChatAdapterChannelSchema.optional(),
    task_statuses: z.array(taskStatusSchema).max(10).optional(),
    event_types: z.array(z.string().min(1).max(200)).max(100).optional(),
    level: levelSchema.optional(),
    since: z.string().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    tail_lines: z.number().int().min(1).max(2000).optional(),
    mirror_runtime_events: z.boolean().optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.source === "file" && !value.file_path?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "file_path is required when source=file",
        path: ["file_path"],
      });
    }
    if (value.source === "run_timeline" && !value.run_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "run_id is required when source=run_timeline",
        path: ["run_id"],
      });
    }
    if (value.source === "incident_timeline" && !value.incident_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "incident_id is required when source=incident_timeline",
        path: ["incident_id"],
      });
    }
    if (value.source === "task_timeline" && !value.task_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "task_id is required when source=task_timeline",
        path: ["task_id"],
      });
    }
  });

function levelSeverity(level: ObservabilityLevel | null | undefined) {
  switch (level) {
    case "critical":
      return 5;
    case "error":
      return 4;
    case "warn":
      return 3;
    case "info":
      return 2;
    case "debug":
      return 1;
    case "trace":
      return 0;
    default:
      return -1;
  }
}

function defaultLevelForHealthState(value: unknown): ObservabilityLevel {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "offline") {
    return "error";
  }
  if (normalized === "degraded") {
    return "warn";
  }
  return "info";
}

function inferRuntimeEventLevel(event: RuntimeEventRecord): ObservabilityLevel {
  const eventType = event.event_type.toLowerCase();
  const status = String(event.status ?? "").trim().toLowerCase();
  if (status === "failed" || status === "error" || /fail|error|critical|incident/.test(eventType)) {
    return "error";
  }
  if (status === "blocked" || /warn|degraded|stale/.test(eventType)) {
    return "warn";
  }
  if (status === "completed" || status === "ok") {
    return "info";
  }
  return "debug";
}

function minutesAgoIso(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function parseIsoMs(value: unknown) {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stableDocumentId(namespace: string, ...parts: Array<string | number | null | undefined>) {
  const digest = crypto
    .createHash("sha256")
    .update([namespace, ...parts.map((entry) => String(entry ?? ""))].join("|"))
    .digest("hex");
  return `${namespace}-${digest.slice(0, 32)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isBenignObservabilityDocument(document: ObservabilityDocumentRecord) {
  const title = String(document.title ?? "").toLowerCase();
  const body = String(document.body_text ?? "").toLowerCase();
  const attributes = asRecord(document.attributes);
  const details = asRecord(attributes.details);
  const improvement =
    typeof details.improvement === "number"
      ? details.improvement
      : typeof attributes.improvement === "number"
        ? attributes.improvement
        : null;
  const aggregateMetricValue =
    typeof details.aggregate_metric_value === "number"
      ? details.aggregate_metric_value
      : typeof attributes.aggregate_metric_value === "number"
        ? attributes.aggregate_metric_value
        : null;
  if (document.service === "run.timeline" && document.event_type === "run.end") {
    if ((title.includes("optimizer step did not improve") || body.includes("optimizer step did not improve")) && improvement !== null && improvement <= 0) {
      return true;
    }
    if ((title.includes("eval suite") || body.includes("eval suite")) && title.includes("failed") && aggregateMetricValue !== null) {
      return true;
    }
  }
  return false;
}

function documentLooksLikeRecoveredAutopilotCandidate(document: ObservabilityDocumentRecord) {
  const sourceKind = String(document.source_kind ?? "").trim();
  const sourceRef = String(document.source_ref ?? "").trim();
  const title = String(document.title ?? "").toLowerCase();
  const body = String(document.body_text ?? "").toLowerCase();
  if (sourceKind === "beat.run_timeline" && /^trichat-autopilot-/i.test(sourceRef)) {
    return true;
  }
  if (sourceKind === "beat.task_timeline" && /^trichat-autopilot-/i.test(sourceRef)) {
    return true;
  }
  if (sourceKind === "beat.incident_timeline" && (title.includes("trichat.autopilot") || body.includes("trichat.autopilot"))) {
    return true;
  }
  return false;
}

function hasRecoveredAutopilotAfter(storage: Storage, createdAt: string | null | undefined) {
  const createdMs = parseIsoMs(createdAt);
  if (!Number.isFinite(createdMs)) {
    return false;
  }
  const activeSessions = storage.listAgentSessions({ active_only: true, limit: 100 });
  return activeSessions.some((session) => {
    if (session.agent_id !== "ring-leader") {
      return false;
    }
    const metadata =
      typeof session.metadata === "object" && session.metadata !== null && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    if (metadata.last_tick_ok !== true) {
      return false;
    }
    const recoveredAtMs = parseIsoMs(metadata.last_tick_at);
    return Number.isFinite(recoveredAtMs) && recoveredAtMs > createdMs;
  });
}

export function isActionableRecentObservabilityDocument(
  storage: Storage,
  documents: ObservabilityDocumentRecord[],
  document: ObservabilityDocumentRecord,
  level: "error" | "critical"
) {
  if (document.level !== level) {
    return false;
  }
  if (isBenignObservabilityDocument(document)) {
    return false;
  }
  if (documentLooksLikeRecoveredAutopilotCandidate(document) && hasRecoveredAutopilotAfter(storage, document.created_at)) {
    return false;
  }
  const createdAt = parseIsoMs(document.created_at);
  if (!Number.isFinite(createdAt)) {
    return true;
  }
  return !documents.some((candidate) => {
    const candidateCreatedAt = parseIsoMs(candidate.created_at);
    if (!Number.isFinite(candidateCreatedAt) || candidateCreatedAt <= createdAt) {
      return false;
    }
    if (levelSeverity(candidate.level) < levelSeverity("info")) {
      return false;
    }
    if ((candidate.source_kind ?? null) !== (document.source_kind ?? null)) {
      return false;
    }
    if ((candidate.service ?? null) !== (document.service ?? null)) {
      return false;
    }
    if ((candidate.host_id ?? null) !== (document.host_id ?? null)) {
      return false;
    }
    if ((candidate.source_ref ?? null) !== (document.source_ref ?? null)) {
      return false;
    }
    return true;
  });
}

export function countActionableRecentObservabilityDocuments(
  storage: Storage,
  documents: ObservabilityDocumentRecord[],
  level: "error" | "critical"
) {
  return documents.filter((entry) => isActionableRecentObservabilityDocument(storage, documents, entry, level)).length;
}

function occurredAfterSince(createdAt: string | null | undefined, since: string | undefined) {
  const createdMs = Date.parse(String(createdAt ?? "").trim());
  if (!Number.isFinite(createdMs)) {
    return false;
  }
  const sinceText = String(since ?? "").trim();
  if (!sinceText) {
    return true;
  }
  const sinceMs = Date.parse(sinceText);
  if (!Number.isFinite(sinceMs)) {
    return true;
  }
  return createdMs > sinceMs;
}

function buildMirrorRuntimeEvents(
  storage: Storage,
  docs: ObservabilityDocumentRecord[],
  input: Pick<z.infer<typeof observabilityIngestSchema>, "source_client" | "source_model" | "source_agent">
) {
  const mirrored = docs.filter((doc) => levelSeverity(doc.level) >= levelSeverity("warn"));
  for (const doc of mirrored) {
    storage.appendRuntimeEvent({
      event_type: "observability.document",
      entity_type: "observability_document",
      entity_id: doc.document_id,
      status: doc.level ?? null,
      summary: doc.title ?? `${doc.index_name}:${doc.event_type ?? "document"}`,
      content: doc.body_text,
      details: {
        index_name: doc.index_name,
        source_kind: doc.source_kind,
        source_ref: doc.source_ref,
        host_id: doc.host_id,
        service: doc.service,
        event_type: doc.event_type,
        tags: doc.tags,
      },
      source_client: input.source_client,
      source_model: input.source_model,
      source_agent: input.source_agent,
    });
  }
  return mirrored.length;
}

function ingestDocuments(
  storage: Storage,
  input: {
    index_name: string;
    source_kind: string;
    source_ref?: string;
    documents: Array<z.infer<typeof observabilityDocumentInputSchema>>;
    mirror_runtime_events?: boolean;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const docs = input.documents.map((document) =>
    storage.upsertObservabilityDocument({
      document_id: document.document_id,
      created_at: document.created_at,
      updated_at: document.updated_at,
      index_name: input.index_name,
      source_kind: input.source_kind,
      source_ref: input.source_ref,
      level: document.level ?? null,
      host_id: document.host_id ?? null,
      service: document.service ?? null,
      event_type: document.event_type ?? null,
      title: document.title ?? null,
      body_text: document.body_text ?? "",
    attributes: document.attributes ?? {},
    tags: document.tags ?? [],
  })
  );
  const mirrored_event_count = input.mirror_runtime_events ? buildMirrorRuntimeEvents(storage, docs, input) : 0;
  storage.appendRuntimeEvent({
    event_type: "observability.ingest",
    entity_type: "observability_index",
    entity_id: input.index_name,
    status: "ok",
    summary: `Ingested ${docs.length} observability document(s) into ${input.index_name}.`,
    details: {
      source_kind: input.source_kind,
      source_ref: input.source_ref ?? null,
      document_count: docs.length,
      mirrored_event_count,
    },
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });
  return {
    index_name: input.index_name,
    source_kind: input.source_kind,
    source_ref: input.source_ref ?? null,
    document_count: docs.length,
    mirrored_event_count,
    latest_document_at: docs[0]?.created_at ?? null,
    documents: docs,
  };
}

function searchRuntimeEvents(storage: Storage, input: z.infer<typeof observabilitySearchSchema>) {
  if (!input.include_runtime_events) {
    return [];
  }
  const query = String(input.query ?? "").trim().toLowerCase();
  const events = storage.listRuntimeEvents({
    source_agent: input.source_kind === "runtime_event_agent" ? input.source_ref : undefined,
    event_types: input.event_types,
    since: input.since,
    limit: Math.max((input.limit ?? 50) * 4, 50),
  });
  return events
    .map((event) => {
      const haystack = [
        event.event_type,
        event.status ?? "",
        event.summary ?? "",
        event.content ?? "",
        compactJson(event.details),
        event.entity_type ?? "",
        event.entity_id ?? "",
      ].join(" ").toLowerCase();
      const score = query ? haystack.split(/\s+/).reduce((acc, _entry) => acc, 0) + (haystack.includes(query) ? 1 : 0) : 0;
      const termScore = query
        ? query
            .split(/\s+/)
            .filter(Boolean)
            .reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0)
        : 0;
      return {
        score: Math.max(score, termScore),
        event,
      };
    })
    .filter((entry) => !query || entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return right.event.created_at.localeCompare(left.event.created_at);
    })
    .slice(0, input.limit ?? 50)
    .map((entry) => ({
      score: entry.score,
      match_reason: query ? "runtime_event_term_match" : "latest_runtime_event",
      event_seq: entry.event.event_seq,
      event_id: entry.event.event_id,
      created_at: entry.event.created_at,
      event_type: entry.event.event_type,
      status: entry.event.status,
      summary: entry.event.summary,
      content: entry.event.content,
      entity_type: entry.event.entity_type,
      entity_id: entry.event.entity_id,
      source_client: entry.event.source_client,
      source_model: entry.event.source_model,
      source_agent: entry.event.source_agent,
    }));
}

function shipFromRuntimeEvents(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const events = storage.listRuntimeEvents({
    since: input.since,
    limit: input.limit ?? 250,
  });
  return events.map((event) => ({
    document_id: stableDocumentId("runtime-event", event.event_id),
    created_at: event.created_at,
    level: inferRuntimeEventLevel(event),
    host_id: input.host_id ?? undefined,
    service: input.service ?? "runtime.events",
    event_type: event.event_type,
    title: event.summary ?? `${event.event_type} ${event.status ?? ""}`.trim(),
    body_text: event.content ?? compactJson(event.details),
    attributes: {
      event_seq: event.event_seq,
      event_id: event.event_id,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      status: event.status,
      details: event.details,
      source_client: event.source_client,
      source_model: event.source_model,
      source_agent: event.source_agent,
    },
    tags: ["runtime-event"],
  }));
}

function shipFromFile(input: z.infer<typeof observabilityShipSchema>) {
  const filePath = path.resolve(input.file_path!);
  const content = fs.readFileSync(filePath, "utf8");
  const tailLines = Math.max(1, input.tail_lines ?? input.limit ?? 200);
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0).slice(-tailLines);
  return lines.map((line, index) => ({
    document_id: stableDocumentId("file-log", filePath, index + 1, line),
    level: input.level ?? "info",
    host_id: input.host_id ?? undefined,
    service: input.service ?? path.basename(filePath),
    event_type: "file.log",
    title: `${path.basename(filePath)}:${index + 1}`,
    body_text: line,
    attributes: {
      file_path: filePath,
      line_number: index + 1,
    },
    tags: ["filebeat"],
  }));
}

function shipFromTaskQueue(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const tasks = input.task_statuses?.length
    ? input.task_statuses.flatMap((status) => storage.listTasks({ status, limit: input.limit ?? 250 }))
    : storage.listTasks({ limit: input.limit ?? 250 });
  const seen = new Set<string>();
  return tasks
    .filter((task) => {
      if (seen.has(task.task_id)) {
        return false;
      }
      seen.add(task.task_id);
      return occurredAfterSince(task.updated_at || task.created_at, input.since);
    })
    .slice(0, input.limit ?? 250)
    .map((task): IngestableDocument => {
      const level: ObservabilityLevel =
        task.status === "failed"
          ? "error"
          : task.status === "cancelled"
            ? "warn"
            : task.status === "pending"
              ? "debug"
              : "info";
      return {
        document_id: stableDocumentId("task-queue", task.task_id, task.updated_at || task.created_at, task.status),
        created_at: task.updated_at || task.created_at,
        level,
        host_id: input.host_id ?? undefined,
        service: input.service ?? "task.queue",
        event_type: `task.${task.status}`,
        title: `${task.task_id} ${task.status}`,
        body_text: task.objective,
        attributes: {
          task_id: task.task_id,
          status: task.status,
          priority: task.priority,
          project_dir: task.project_dir,
          payload: task.payload,
          metadata: task.metadata,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          started_at: task.started_at,
          finished_at: task.finished_at,
          last_worker_id: task.last_worker_id,
          last_error: task.last_error,
          lease: task.lease,
        },
        tags: ["taskbeat", task.status, ...task.tags],
      };
    });
}

function shipFromTaskTimeline(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const taskId = input.task_id?.trim() || "";
  const events = storage.getTaskTimeline(taskId, input.limit ?? 250);
  return events.filter((event) => occurredAfterSince(event.created_at, input.since)).map((event): IngestableDocument => {
    const level: ObservabilityLevel =
      event.to_status === "failed" || /fail|error|expired/i.test(event.event_type)
        ? "error"
        : event.to_status === "cancelled" || /warn|retry/i.test(event.event_type)
          ? "warn"
          : event.to_status === "pending" || event.to_status === "running"
            ? "debug"
            : "info";
    return {
      document_id: stableDocumentId("task-timeline", event.id),
      created_at: event.created_at,
      level,
      host_id: input.host_id ?? undefined,
      service: input.service ?? "task.timeline",
      event_type: `task_event.${event.event_type}`,
      title: `${event.task_id} ${event.event_type}`,
      body_text: event.summary ?? compactJson(event.details),
      attributes: {
        id: event.id,
        task_id: event.task_id,
        from_status: event.from_status,
        to_status: event.to_status,
        worker_id: event.worker_id,
        details: event.details,
      },
      tags: [
        "taskbeat",
        "timeline",
        event.event_type,
        ...(event.to_status ? [event.to_status] : []),
      ],
    };
  });
}

function shipFromTriChatBus(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const events = storage.listTriChatBusEvents({
    thread_id: input.thread_id,
    source_agent: input.agent_id,
    event_types: input.event_types,
    since: input.since,
    limit: input.limit ?? 250,
  });
  return events.map((event): IngestableDocument => {
    const level: ObservabilityLevel = /fail|error|critical|incident/i.test(event.event_type)
      ? "error"
      : /warn|degraded|stale/i.test(event.event_type)
        ? "warn"
        : "info";
    return {
      document_id: stableDocumentId("trichat-bus", event.event_id),
      created_at: event.created_at,
      level,
      host_id: input.host_id ?? undefined,
      service: input.service ?? "trichat.bus",
      event_type: event.event_type,
      title: `${event.thread_id} ${event.event_type}`,
      body_text: event.content ?? compactJson(event.metadata),
      attributes: {
        event_seq: event.event_seq,
        event_id: event.event_id,
        thread_id: event.thread_id,
        source_agent: event.source_agent,
        source_client: event.source_client,
        role: event.role,
        metadata: event.metadata,
      },
      tags: ["trichatbeat", event.thread_id, ...(event.source_agent ? [event.source_agent] : [])],
    };
  });
}

function shipFromTriChatAdapter(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const states = storage.listTriChatAdapterStates({
    agent_id: input.agent_id,
    channel: input.channel,
    limit: input.limit ?? 250,
  });
  return states.map((state): IngestableDocument => {
    const level: ObservabilityLevel = state.open || state.failure_count > 0 ? "warn" : "info";
    return {
      document_id: stableDocumentId("trichat-adapter", state.agent_id, state.channel, state.updated_at),
      created_at: state.updated_at,
      level,
      host_id: input.host_id ?? undefined,
      service: input.service ?? "trichat.adapter",
      event_type: `adapter.${state.channel}.${state.open ? "open" : "closed"}`,
      title: `${state.agent_id} ${state.channel} ${state.open ? "open" : "closed"}`,
      body_text: state.last_error ?? state.last_result ?? `${state.success_count} successes / ${state.failure_count} failures`,
      attributes: {
        agent_id: state.agent_id,
        channel: state.channel,
        open: state.open,
        open_until: state.open_until,
        failure_count: state.failure_count,
        trip_count: state.trip_count,
        success_count: state.success_count,
        turn_count: state.turn_count,
        degraded_turn_count: state.degraded_turn_count,
        last_error: state.last_error,
        last_result: state.last_result,
        metadata: state.metadata,
      },
      tags: ["adapterbeat", state.channel, state.agent_id],
    };
  });
}

function deriveRunTimelineLevel(event: ReturnType<Storage["getRunTimeline"]>[number]): ObservabilityLevel {
  const summary = String(event.summary ?? "").trim().toLowerCase();
  const runId = String(event.run_id ?? "").trim().toLowerCase();
  const improvement = typeof event.details.improvement === "number" ? event.details.improvement : null;
  const aggregateMetricValue =
    typeof event.details.aggregate_metric_value === "number" ? event.details.aggregate_metric_value : null;
  if (event.status === "failed" || event.status === "error") {
    if (runId.startsWith("optimizer-run-") && improvement !== null && improvement <= 0 && /did not improve/.test(summary)) {
      return "info";
    }
    if (runId.startsWith("eval-run-") && aggregateMetricValue !== null && /eval suite .* failed/.test(summary)) {
      return "warn";
    }
    return "error";
  }
  if (event.status === "in_progress") {
    return "debug";
  }
  return "info";
}

function shipFromRunTimeline(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const runId = input.run_id?.trim() || "";
  const events = storage.getRunTimeline(runId, input.limit ?? 200);
  return events.filter((event) => occurredAfterSince(event.created_at, input.since)).map((event): IngestableDocument => {
    const level = deriveRunTimelineLevel(event);
    return {
      document_id: stableDocumentId("run-timeline", event.run_id, event.event_type, event.step_index, event.created_at),
      created_at: event.created_at,
      level,
      host_id: input.host_id ?? undefined,
      service: input.service ?? "run.timeline",
      event_type: `run.${event.event_type}`,
      title: `${event.run_id} ${event.event_type}`,
      body_text: event.summary,
      attributes: {
        run_id: event.run_id,
        step_index: event.step_index,
        status: event.status,
        details: event.details,
        source_client: event.source_client,
        source_model: event.source_model,
        source_agent: event.source_agent,
      },
      tags: ["runbeat", event.event_type, event.status],
    };
  });
}

function shipFromIncidentTimeline(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const incidentId = input.incident_id?.trim() || "";
  const timeline = storage.getIncidentTimeline(incidentId, input.limit ?? 200);
  const incident = timeline.incident;
  return timeline.events.filter((event) => occurredAfterSince(event.created_at, input.since)).map((event): IngestableDocument => {
    const severity = String(incident?.severity ?? "").trim().toUpperCase();
    const level: ObservabilityLevel =
      severity === "P0"
        ? "critical"
        : severity === "P1" || /fail|error|critical/i.test(event.event_type)
          ? "error"
        : severity === "P2" || /warn|degraded|attention/i.test(event.event_type)
            ? "warn"
            : "info";
    return {
      document_id: stableDocumentId("incident-timeline", event.id),
      created_at: event.created_at,
      level,
      host_id: input.host_id ?? undefined,
      service: input.service ?? "incident.timeline",
      event_type: event.event_type,
      title: incident ? `${incident.title} :: ${event.summary}` : event.summary,
      body_text: compactJson(event.details),
      attributes: {
        incident_id: event.incident_id,
        incident_title: incident?.title ?? null,
        incident_status: incident?.status ?? null,
        incident_severity: incident?.severity ?? null,
        details: event.details,
        source_client: event.source_client,
        source_model: event.source_model,
        source_agent: event.source_agent,
      },
      tags: ["incidentbeat", incident?.severity ?? "unknown", incident?.status ?? "unknown"],
    };
  });
}

function shipFromTriChatSummary(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  const summary = storage.getTriChatSummary({
    busiest_limit: Math.max(1, Math.min(input.limit ?? 10, 50)),
  });
  const turns = storage
    .listTriChatTurns({
      thread_id: input.thread_id,
      limit: Math.max(1, Math.min(input.limit ?? 10, 25)),
    })
    .filter((turn) => occurredAfterSince(turn.updated_at, input.since));
  const level: ObservabilityLevel =
    summary.thread_counts.active > 0
      ? "info"
      : summary.thread_counts.total > 0
        ? "debug"
        : "warn";
  return [
    {
      document_id: stableDocumentId("trichat-summary", input.thread_id ?? "all", summary.newest_message_at ?? summary.oldest_message_at ?? "empty"),
      created_at: new Date().toISOString(),
      level,
      host_id: input.host_id ?? undefined,
      service: input.service ?? "trichat.summary",
      event_type: "trichat.summary",
      title: `TriChat threads=${summary.thread_counts.total} messages=${summary.message_count}`,
      body_text: `active=${summary.thread_counts.active} archived=${summary.thread_counts.archived}`,
      attributes: summary,
      tags: ["trichatbeat", "summary"],
    },
    ...turns.map((turn): IngestableDocument => ({
      document_id: stableDocumentId("trichat-turn", turn.turn_id, turn.updated_at),
      created_at: turn.updated_at,
      level:
        turn.status === "failed" || turn.verify_status === "failed" || turn.disagreement === true
          ? "warn"
          : turn.status === "running"
            ? "debug"
            : "info",
      host_id: input.host_id ?? undefined,
      service: input.service ?? "trichat.summary",
      event_type: `trichat.turn.${turn.status}`,
      title: `${turn.thread_id} ${turn.phase} ${turn.status}`,
      body_text: turn.decision_summary ?? turn.verify_summary ?? turn.user_prompt,
      attributes: {
        turn_id: turn.turn_id,
        thread_id: turn.thread_id,
        phase: turn.phase,
        phase_status: turn.phase_status,
        status: turn.status,
        selected_agent: turn.selected_agent,
        selected_strategy: turn.selected_strategy,
        decision_summary: turn.decision_summary,
        verify_status: turn.verify_status,
        verify_summary: turn.verify_summary,
      },
      tags: ["trichatbeat", "turn", turn.status, turn.phase],
    })),
  ];
}

export async function observabilityIngest(storage: Storage, input: z.infer<typeof observabilityIngestSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "observability.ingest",
    mutation: input.mutation,
    payload: input,
    execute: () => ingestDocuments(storage, input),
  });
}

export function observabilitySearch(storage: Storage, input: z.infer<typeof observabilitySearchSchema>) {
  const limit = input.limit ?? 50;
  const documents = storage.searchObservabilityDocuments({
    query: input.query,
    index_names: input.index_names,
    source_kind: input.source_kind,
    source_ref: input.source_ref,
    host_id: input.host_id,
    service: input.service,
    levels: input.levels,
    event_types: input.event_types,
    tags: input.tags,
    since: input.since,
    limit,
  });
  const runtime_events = searchRuntimeEvents(storage, input);
  return {
    query: input.query ?? null,
    count: documents.length,
    runtime_event_count: runtime_events.length,
    documents,
    runtime_events,
    filters: {
      index_names: input.index_names ?? [],
      source_kind: input.source_kind ?? null,
      source_ref: input.source_ref ?? null,
      host_id: input.host_id ?? null,
      service: input.service ?? null,
      levels: input.levels ?? [],
      event_types: input.event_types ?? [],
      tags: input.tags ?? [],
      since: input.since ?? null,
      include_runtime_events: input.include_runtime_events === true,
    },
  };
}

export function observabilityDashboard(storage: Storage, input: z.infer<typeof observabilityDashboardSchema>) {
  const criticalWindowMinutes = input.critical_window_minutes ?? 15;
  const recentLimit = input.recent_limit ?? 12;
  const overview = storage.summarizeObservabilityDocuments({
    since: input.since,
  });
  const recent_critical = storage.listObservabilityDocuments({
    since: minutesAgoIso(criticalWindowMinutes),
    levels: ["critical", "error"],
    limit: recentLimit,
  });
  const recent_warnings = storage.listObservabilityDocuments({
    since: minutesAgoIso(criticalWindowMinutes),
    levels: ["warn"],
    limit: recentLimit,
  });
  const actionableRecentCritical = recent_critical.filter((entry) =>
    isActionableRecentObservabilityDocument(storage, recent_critical, entry, entry.level === "critical" ? "critical" : "error")
  );
  return {
    generated_at: new Date().toISOString(),
    critical_window_minutes: criticalWindowMinutes,
    overview,
    recent_error_count:
      actionableRecentCritical.filter((entry) => entry.level === "error").length,
    recent_critical_count:
      actionableRecentCritical.filter((entry) => entry.level === "critical").length,
    recent_warning_count: recent_warnings.length,
    recent_critical: actionableRecentCritical,
    recent_warnings,
    top_services: overview.service_counts.slice(0, 5),
    top_hosts: overview.host_counts.slice(0, 5),
    top_sources: overview.source_kind_counts.slice(0, 5),
    top_indexes: overview.index_name_counts.slice(0, 5),
    runtime_event_bus: storage.summarizeRuntimeEvents({
      since: input.since,
    }),
  };
}

export async function observabilityShip(storage: Storage, input: z.infer<typeof observabilityShipSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "observability.ship",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      let documents: IngestableDocument[] = [];
      let index_name = input.index_name?.trim() || "";
      let source_kind = "";
      let source_ref = "";

      if (input.source === "local_host") {
        const profile = captureLocalHostProfile({ workspace_root: process.cwd() });
        index_name = index_name || "metrics-local-host";
        source_kind = "beat.local_host";
        source_ref = "local";
        documents = [
          {
            document_id: stableDocumentId("local-host", input.host_id ?? "local", profile.generated_at),
            created_at: profile.generated_at,
            level: profile.health_state === "healthy" ? "info" : "warn",
            host_id: input.host_id ?? "local",
            service: input.service ?? "local.host",
            event_type: "local_host.profile",
            title: `local host ${profile.health_state}`,
            body_text:
              `cpu=${profile.cpu_utilization} mem_free=${profile.memory_free_percent}% ` +
              `swap=${profile.swap_used_gb}GB thermal=${profile.thermal_pressure} ` +
              `gpu=${profile.gpu_model ?? "n/a"} api=${profile.gpu_api ?? "n/a"} mlx=${profile.mlx_available}`,
            attributes: profile,
            tags: [
              "metricbeat",
              profile.platform,
              profile.arch,
              ...(profile.accelerator_kind !== "none" ? ["gpu"] : []),
              ...(profile.gpu_api ? [profile.gpu_api] : []),
              ...(profile.mlx_available ? ["mlx"] : []),
            ],
          },
        ];
      } else if (input.source === "worker_fabric") {
        const state = resolveEffectiveWorkerFabric(storage, {
          fallback_workspace_root: process.cwd(),
          fallback_worker_count: 1,
          fallback_shell: "/bin/zsh",
        });
        index_name = index_name || "metrics-worker-fabric";
        source_kind = "beat.worker_fabric";
        source_ref = "worker.fabric";
        documents = (state?.hosts ?? []).map((host) => ({
          document_id: stableDocumentId("worker-fabric-host", host.host_id, host.updated_at, host.telemetry.heartbeat_at),
          created_at: host.telemetry.heartbeat_at ?? new Date().toISOString(),
          level: defaultLevelForHealthState(host.telemetry.health_state),
          host_id: host.host_id,
          service: input.service ?? "worker.fabric",
          event_type: "worker_fabric.host",
          title: `${host.host_id} ${host.telemetry.health_state}`,
          body_text: `transport=${host.transport} workers=${host.worker_count} queue=${host.telemetry.queue_depth} active=${host.telemetry.active_tasks}`,
          attributes: host,
          tags: ["metricbeat", ...host.tags],
        }));
      } else if (input.source === "cluster_topology") {
        const state = storage.getClusterTopologyState();
        index_name = index_name || "metrics-cluster-topology";
        source_kind = "beat.cluster_topology";
        source_ref = "cluster.topology";
        documents = (state?.nodes ?? []).map((node) => ({
          document_id: stableDocumentId("cluster-node", node.node_id, node.updated_at),
          created_at: node.updated_at,
          level: node.status === "active" ? "info" : node.status === "planned" ? "debug" : "warn",
          host_id: node.host_id ?? undefined,
          service: input.service ?? "cluster.topology",
          event_type: "cluster_topology.node",
          title: `${node.node_id} ${node.status}`,
          body_text: `class=${node.node_class} workers=${node.worker_count ?? 0} transport=${node.transport}`,
          attributes: node,
          tags: ["metricbeat", node.node_class, ...node.tags],
        }));
      } else if (input.source === "model_router") {
        const state = storage.getModelRouterState();
        index_name = index_name || "metrics-model-router";
        source_kind = "beat.model_router";
        source_ref = "model.router";
        documents = (state?.backends ?? []).map((backend) => {
          const probeMetadata =
            typeof backend.metadata?.last_probe === "object" && backend.metadata?.last_probe !== null
              ? (backend.metadata.last_probe as Record<string, unknown>)
              : typeof backend.metadata?.probe === "object" && backend.metadata?.probe !== null
                ? (backend.metadata.probe as Record<string, unknown>)
                : {};
          const capabilityProbeHealthy =
            typeof backend.capabilities?.probe_healthy === "boolean" ? backend.capabilities.probe_healthy : null;
          const metadataProbeHealthy =
            typeof probeMetadata.service_ok === "boolean"
              ? probeMetadata.service_ok
              : typeof probeMetadata.healthy === "boolean"
                ? probeMetadata.healthy
                : null;
          const probeHealthy = capabilityProbeHealthy ?? metadataProbeHealthy;
          const optionalBackend =
            backend.backend_id !== state?.default_backend_id &&
            !(backend.tags ?? []).includes("primary") &&
            !(backend.tags ?? []).includes("required");
          return {
            document_id: stableDocumentId("model-router-backend", backend.backend_id, backend.updated_at, backend.heartbeat_at),
            created_at: backend.heartbeat_at ?? new Date().toISOString(),
            level:
              backend.enabled === false
                ? "warn"
                : probeHealthy === false
                  ? optionalBackend
                    ? "warn"
                    : "error"
                  : "info",
            host_id: backend.host_id ?? undefined,
            service: input.service ?? "model.router",
            event_type: "model_router.backend",
            title: `${backend.backend_id} ${backend.provider}`,
            body_text: `model=${backend.model_id} locality=${backend.locality} enabled=${backend.enabled !== false}`,
            attributes: backend,
            tags: ["metricbeat", backend.provider, backend.locality, ...(backend.tags ?? [])],
          };
        });
      } else if (input.source === "runtime_events") {
        index_name = index_name || "events-runtime";
        source_kind = "beat.runtime_events";
        source_ref = "runtime.events";
        documents = shipFromRuntimeEvents(storage, input);
      } else if (input.source === "run_timeline") {
        index_name = index_name || "events-run-timeline";
        source_kind = "beat.run_timeline";
        source_ref = input.run_id?.trim() || "run.timeline";
        documents = shipFromRunTimeline(storage, input);
      } else if (input.source === "incident_timeline") {
        index_name = index_name || "events-incident-timeline";
        source_kind = "beat.incident_timeline";
        source_ref = input.incident_id?.trim() || "incident.timeline";
        documents = shipFromIncidentTimeline(storage, input);
      } else if (input.source === "task_timeline") {
        index_name = index_name || "events-task-timeline";
        source_kind = "beat.task_timeline";
        source_ref = input.task_id?.trim() || "task.timeline";
        documents = shipFromTaskTimeline(storage, input);
      } else if (input.source === "task_queue") {
        index_name = index_name || "events-task-queue";
        source_kind = "beat.task_queue";
        source_ref = "task.queue";
        documents = shipFromTaskQueue(storage, input);
      } else if (input.source === "trichat_bus") {
        index_name = index_name || "events-trichat-bus";
        source_kind = "beat.trichat_bus";
        source_ref = input.thread_id?.trim() || "trichat.bus";
        documents = shipFromTriChatBus(storage, input);
      } else if (input.source === "trichat_adapter") {
        index_name = index_name || "events-trichat-adapter";
        source_kind = "beat.trichat_adapter";
        source_ref = input.agent_id?.trim() || "trichat.adapter";
        documents = shipFromTriChatAdapter(storage, input);
      } else if (input.source === "trichat_summary") {
        index_name = index_name || "metrics-trichat-summary";
        source_kind = "beat.trichat_summary";
        source_ref = input.thread_id?.trim() || "trichat.summary";
        documents = shipFromTriChatSummary(storage, input);
      } else if (input.source === "file") {
        index_name = index_name || "logs-file";
        source_kind = "beat.file";
        source_ref = path.resolve(input.file_path!);
        documents = shipFromFile(input);
      }

      const result = ingestDocuments(storage, {
        index_name,
        source_kind,
        source_ref,
        documents,
        mirror_runtime_events: input.mirror_runtime_events,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      storage.appendRuntimeEvent({
        event_type: "observability.ship",
        entity_type: "observability_source",
        entity_id: input.source,
        status: "ok",
        summary: `Shipped ${result.document_count} observability document(s) from ${input.source}.`,
        details: {
          source: input.source,
          index_name: result.index_name,
          source_kind: result.source_kind,
          source_ref: result.source_ref,
          mirrored_event_count: result.mirrored_event_count,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ...result,
        source: input.source,
      };
    },
  });
}
