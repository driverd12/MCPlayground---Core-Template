#!/usr/bin/env bash
set -euo pipefail

export TRICHAT_SMOKE_TRANSPORT="${TRICHAT_SMOKE_TRANSPORT:-stdio}"
export TRICHAT_SMOKE_URL="${TRICHAT_SMOKE_URL:-http://127.0.0.1:8787/}"
export TRICHAT_SMOKE_ORIGIN="${TRICHAT_SMOKE_ORIGIN:-http://127.0.0.1}"
export TRICHAT_SMOKE_STDIO_COMMAND="${TRICHAT_SMOKE_STDIO_COMMAND:-node}"
export TRICHAT_SMOKE_STDIO_ARGS="${TRICHAT_SMOKE_STDIO_ARGS:-dist/server.js}"
export TRICHAT_SMOKE_THREAD_ID="${TRICHAT_SMOKE_THREAD_ID:-trichat-smoke-$(date +%s)}"
export TRICHAT_SMOKE_KEEP_ACTIVE="${TRICHAT_SMOKE_KEEP_ACTIVE:-0}"

if [[ "${TRICHAT_SMOKE_TRANSPORT}" == "http" ]] && [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
  echo "error: MCP_HTTP_BEARER_TOKEN is required when TRICHAT_SMOKE_TRANSPORT=http" >&2
  exit 2
fi

node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transportMode = process.env.TRICHAT_SMOKE_TRANSPORT ?? "stdio";
const threadId = process.env.TRICHAT_SMOKE_THREAD_ID;
const keepActive = /^(1|true|yes|on)$/i.test(process.env.TRICHAT_SMOKE_KEEP_ACTIVE ?? "");
const transport =
  transportMode === "http"
    ? new StreamableHTTPClientTransport(new URL(process.env.TRICHAT_SMOKE_URL), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.MCP_HTTP_BEARER_TOKEN}`,
            Origin: process.env.TRICHAT_SMOKE_ORIGIN,
          },
        },
      })
    : new StdioClientTransport({
        command: process.env.TRICHAT_SMOKE_STDIO_COMMAND ?? "node",
        args: (process.env.TRICHAT_SMOKE_STDIO_ARGS ?? "dist/server.js").split(/\s+/).filter(Boolean),
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
      });

const client = new Client(
  { name: "anamnesis-trichat-smoke", version: "0.1.0" },
  { capabilities: {} }
);

let mutationCounter = 0;
const mutation = (toolName) => {
  const index = mutationCounter++;
  const safe = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const base = `trichat-smoke-${threadId}-${safe}-${index}`;
  return {
    idempotency_key: base,
    side_effect_fingerprint: `${base}-fingerprint`,
  };
};

const extractText = (response) =>
  (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

const callTool = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

try {
  await client.connect(transport);

  const opened = await callTool("trichat.thread_open", {
    mutation: mutation("trichat.thread_open"),
    thread_id: threadId,
    title: `TriChat Smoke ${threadId}`,
    metadata: {
      source: "scripts/trichat_smoke.sh",
      transport: transportMode,
    },
  });
  if (!opened?.thread?.thread_id) {
    throw new Error("trichat.thread_open did not return thread id");
  }

  const userMessage = await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.user"),
    thread_id: threadId,
    agent_id: "user",
    role: "user",
    content: `TriChat smoke user prompt for ${threadId}`,
    metadata: { source: "trichat_smoke" },
  });
  if (!userMessage?.message?.message_id) {
    throw new Error("trichat.message_post user did not return message_id");
  }

  const codexMessage = await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.codex"),
    thread_id: threadId,
    agent_id: "codex",
    role: "assistant",
    content: `TriChat smoke codex response for ${threadId}`,
    metadata: { source: "trichat_smoke" },
    reply_to_message_id: userMessage.message.message_id,
  });
  if (!codexMessage?.message?.message_id) {
    throw new Error("trichat.message_post codex did not return message_id");
  }

  const cursorMessage = await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.cursor"),
    thread_id: threadId,
    agent_id: "cursor",
    role: "assistant",
    content: `TriChat smoke cursor response for ${threadId}`,
    metadata: { source: "trichat_smoke" },
    reply_to_message_id: codexMessage.message.message_id,
  });
  if (!cursorMessage?.message?.message_id) {
    throw new Error("trichat.message_post cursor did not return message_id");
  }

  const imprintMessage = await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.imprint"),
    thread_id: threadId,
    agent_id: "local-imprint",
    role: "assistant",
    content: `TriChat smoke local-imprint response for ${threadId}`,
    metadata: { source: "trichat_smoke" },
    reply_to_message_id: cursorMessage.message.message_id,
  });
  if (!imprintMessage?.message?.message_id) {
    throw new Error("trichat.message_post local-imprint did not return message_id");
  }

  const routerMessage = await callTool("trichat.message_post", {
    mutation: mutation("trichat.message_post.router"),
    thread_id: threadId,
    agent_id: "router",
    role: "system",
    content: `TriChat smoke router ack for ${threadId}`,
    metadata: { source: "trichat_smoke" },
    reply_to_message_id: imprintMessage.message.message_id,
  });

  const timeline = await callTool("trichat.timeline", {
    thread_id: threadId,
    limit: 40,
  });
  if (!Array.isArray(timeline?.messages) || timeline.messages.length < 5) {
    throw new Error("trichat.timeline returned insufficient messages");
  }
  const agentsSeen = new Set(timeline.messages.map((entry) => entry.agent_id));
  for (const agentId of ["user", "codex", "cursor", "local-imprint", "router"]) {
    if (!agentsSeen.has(agentId)) {
      throw new Error(`trichat.timeline missing expected agent message: ${agentId}`);
    }
  }

  const consensus = await callTool("trichat.consensus", {
    thread_id: threadId,
    limit: 80,
    recent_turn_limit: 5,
  });
  if (typeof consensus?.mode !== "string") {
    throw new Error("trichat.consensus missing mode");
  }
  if (typeof consensus?.disagreement_turns !== "number") {
    throw new Error("trichat.consensus missing disagreement_turns");
  }

  const busStatus = await callTool("trichat.bus", {
    action: "status",
  });
  if (typeof busStatus?.running !== "boolean") {
    throw new Error("trichat.bus status missing running flag");
  }

  const busPublish = await callTool("trichat.bus", {
    action: "publish",
    mutation: mutation("trichat.bus.publish"),
    thread_id: threadId,
    event_type: "trichat-smoke.manual-event",
    source_agent: "router",
    source_client: "scripts/trichat_smoke.sh",
    role: "system",
    content: `TriChat smoke manual bus event for ${threadId}`,
    metadata: { source: "trichat_smoke" },
  });
  if (!busPublish?.event?.event_id) {
    throw new Error("trichat.bus publish did not return event_id");
  }

  const busTail = await callTool("trichat.bus", {
    action: "tail",
    thread_id: threadId,
    limit: 50,
  });
  if (!Array.isArray(busTail?.events) || busTail.events.length < 1) {
    throw new Error("trichat.bus tail returned no events");
  }
  const busEventTypes = new Set(busTail.events.map((entry) => entry.event_type));
  if (!busEventTypes.has("trichat.message_post")) {
    throw new Error("trichat.bus tail missing trichat.message_post events");
  }
  if (!busEventTypes.has("trichat-smoke.manual-event")) {
    throw new Error("trichat.bus tail missing trichat-smoke.manual-event");
  }

  const thread = await callTool("trichat.thread_get", {
    thread_id: threadId,
  });
  if (!thread?.found) {
    throw new Error("trichat.thread_get returned not found for smoke thread");
  }

  const summary = await callTool("trichat.summary", {
    busiest_limit: 5,
  });
  if (typeof summary?.message_count !== "number") {
    throw new Error("trichat.summary did not return message_count");
  }

  const autoRetentionStatus = await callTool("trichat.auto_retention", {
    action: "status",
  });
  if (typeof autoRetentionStatus?.running !== "boolean") {
    throw new Error("trichat.auto_retention status missing running flag");
  }

  const adapterTelemetry = await callTool("trichat.adapter_telemetry", {
    action: "status",
    include_events: true,
    event_limit: 5,
  });
  if (typeof adapterTelemetry?.summary?.total_channels !== "number") {
    throw new Error("trichat.adapter_telemetry status missing summary totals");
  }

  const retention = await callTool("trichat.retention", {
    mutation: mutation("trichat.retention"),
    older_than_days: 0,
    thread_id: threadId,
    limit: 100,
    dry_run: true,
  });
  if (typeof retention?.candidate_count !== "number") {
    throw new Error("trichat.retention dry-run did not return candidate_count");
  }

  if (!keepActive) {
    await callTool("trichat.thread_open", {
      mutation: mutation("trichat.thread_archive"),
      thread_id: threadId,
      status: "archived",
      metadata: {
        source: "scripts/trichat_smoke.sh",
        archived: true,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: transportMode,
        thread_id: threadId,
        timeline_count: timeline.count ?? timeline.messages.length,
        retention_candidates: retention.candidate_count,
        thread_status: keepActive ? thread.thread?.status ?? null : "archived",
        total_messages: summary.message_count,
        bus_running: busStatus.running,
        bus_events: busTail.events.length,
        auto_retention_running: autoRetentionStatus.running,
        adapter_channels: adapterTelemetry.summary.total_channels,
        adapter_open_channels: adapterTelemetry.summary.open_channels,
        router_message_id: routerMessage?.message?.message_id ?? null,
        consensus_mode: consensus.mode,
        consensus_latest: consensus.latest_turn?.status ?? null,
        smoke_keep_active: keepActive,
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
}
NODE
