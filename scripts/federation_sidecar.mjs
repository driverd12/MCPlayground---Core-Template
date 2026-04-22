#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomUUID, sign as signData } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_VERSION = "master-mold-federation-v1";

function argValues(name) {
  const values = [];
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === longName && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
      values.push(process.argv[index + 1]);
      index += 1;
    } else if (token.startsWith(prefix)) {
      values.push(token.slice(prefix.length));
    }
  }
  return values;
}

function hasArg(name) {
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  return process.argv.some((token) => token === longName || token.startsWith(prefix));
}

function argValue(name, fallback = "") {
  const values = argValues(name);
  return values.length > 0 ? values[values.length - 1] : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(String(argValue(name, "")).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolArg(name, fallback = false) {
  const values = argValues(name);
  if (values.length <= 0) {
    return hasArg(name) ? true : fallback;
  }
  const value = String(values[values.length - 1]).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function expandHome(filePath) {
  const text = String(filePath || "").trim();
  if (!text) {
    return "";
  }
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function safeId(value, fallback = "host") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

function defaultIdentityKeyPath(hostId) {
  return path.join(os.homedir(), ".master-mold", "identity", `${safeId(hostId, "remote-host")}-ed25519.pem`);
}

function readIdentityPrivateKey(options) {
  const inlineKey = String(options.identityKey || "").trim();
  if (inlineKey.startsWith("-----BEGIN")) {
    return inlineKey;
  }
  const explicitPath = expandHome(inlineKey || options.identityKeyPath);
  const candidatePath = explicitPath || defaultIdentityKeyPath(options.hostId);
  if (!candidatePath || !fs.existsSync(candidatePath)) {
    throw new Error(`MASTER-MOLD host identity key not found: ${candidatePath || "<empty>"}`);
  }
  return fs.readFileSync(candidatePath, "utf8");
}

function buildHostIdentitySignaturePayload(input) {
  return [
    "master-mold-host-identity-v1",
    String(input.method || "*").toUpperCase(),
    input.path || "*",
    input.host_id,
    input.agent_id ?? "",
    input.timestamp,
    input.nonce,
  ].join("\n");
}

function signaturePath(url) {
  return `${url.pathname || "/"}${url.search || ""}` || "/";
}

function buildSignedHeaders(options, url) {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const agentId = String(options.agentId || options.agentRuntime || "federation-sidecar").trim();
  const payload = buildHostIdentitySignaturePayload({
    method: "POST",
    path: signaturePath(url),
    host_id: options.hostId,
    agent_id: agentId,
    timestamp,
    nonce,
  });
  return {
    "x-master-mold-host-id": options.hostId,
    "x-master-mold-agent-id": agentId,
    "x-master-mold-timestamp": timestamp,
    "x-master-mold-nonce": nonce,
    "x-master-mold-signature": `ed25519:${signData(null, Buffer.from(payload), options.privateKey).toString("base64url")}`,
    ...(options.agentRuntime ? { "x-master-mold-agent-runtime": options.agentRuntime } : {}),
    ...(options.modelLabel ? { "x-master-mold-model-label": options.modelLabel } : {}),
  };
}

function parsePeers() {
  const rawValues = [
    ...argValues("peer"),
    ...argValues("server"),
    ...argValues("hub"),
    ...(process.env.MASTER_MOLD_FEDERATION_PEERS || "").split(","),
    ...(process.env.MASTER_MOLD_MAIN_URL || "").split(","),
  ];
  const peers = [];
  for (const raw of rawValues) {
    const text = String(raw || "").trim();
    if (!text) {
      continue;
    }
    for (const entry of text.split(",")) {
      const candidate = entry.trim();
      if (!candidate) {
        continue;
      }
      const url = new URL(candidate);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      peers.push(url.toString().replace(/\/$/, ""));
    }
  }
  return [...new Set(peers)];
}

function sanitizeValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}...<truncated:${value.length - 2_000}>` : value;
  }
  if (depth >= 5) {
    return "[max_depth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value !== "object" || !value) {
    return String(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([key, entry]) => [key, sanitizeValue(entry, depth + 1)])
  );
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readLocalBearerTokenFile() {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, "data", "imprint", "http_bearer_token"), "utf8").trim();
  } catch {
    return "";
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function nextSequence(options) {
  const state = readJsonFile(options.statePath, {});
  const previous = Number(state.sequence || 0);
  const sequence = Number.isFinite(previous) ? Math.max(0, Math.floor(previous)) + 1 : 1;
  writeJsonFile(options.statePath, {
    schema_version: SCHEMA_VERSION,
    host_id: options.hostId,
    stream_id: options.streamId,
    sequence,
    updated_at: new Date().toISOString(),
  });
  return sequence;
}

function runJsonCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeoutMs || 5_000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      unavailable_reason: options.unavailableReason || "command_failed",
      exit_status: result.status,
      error: String(result.error?.message || result.stderr || result.stdout || "command failed").slice(0, 2_000),
    };
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    return {
      ok: false,
      unavailable_reason: options.unavailableReason || "command_unparseable",
      error: error instanceof Error ? error.message : String(error),
      stdout: String(result.stdout || "").slice(0, 2_000),
    };
  }
}

function runMcpTool(tool, args, options) {
  const childEnv = {
    ...process.env,
    MCP_TOOL_CALL_TIMEOUT_MS: String(options.toolTimeoutMs),
    MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS: "1",
    MASTER_MOLD_HOST_ID: options.hostId,
    MASTER_MOLD_AGENT_ID: options.agentId || options.agentRuntime || "federation-sidecar",
    MASTER_MOLD_AGENT_RUNTIME: options.agentRuntime,
    MASTER_MOLD_MODEL_LABEL: options.modelLabel,
    MASTER_MOLD_IDENTITY_KEY_PATH: options.identityKeyPath,
    MCP_HTTP_BEARER_TOKEN: options.bearerToken,
  };
  const commandArgs = [
    path.join(REPO_ROOT, "scripts", "mcp_tool_call.mjs"),
    "--tool",
    tool,
    "--args",
    JSON.stringify(args || {}),
    "--transport",
    options.localTransport,
    "--cwd",
    REPO_ROOT,
    "--timeout-ms",
    String(options.toolTimeoutMs),
    "--max-attempts",
    "1",
  ];
  if (options.localTransport === "http") {
    commandArgs.push("--url", options.localUrl, "--origin", options.localOrigin);
  } else {
    commandArgs.push("--stdio-command", "node", "--stdio-args", "dist/server.js");
  }
  const result = runJsonCommand(process.execPath, commandArgs, {
    cwd: REPO_ROOT,
    env: childEnv,
    timeoutMs: options.toolTimeoutMs + 3_000,
    unavailableReason: `${tool.replaceAll(".", "_")}_unavailable`,
  });
  return {
    ok: result?.ok !== false,
    tool,
    result: sanitizeValue(result),
  };
}

function compactKernelSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return summary;
  }
  const kernel = summary.kernel && typeof summary.kernel === "object" ? summary.kernel : summary;
  return sanitizeValue({
    ok: summary.ok ?? true,
    generated_at: summary.generated_at ?? kernel.generated_at ?? null,
    identity: kernel.identity ?? summary.identity ?? null,
    storage: kernel.storage ?? summary.storage ?? null,
    tasks: kernel.tasks ?? summary.tasks ?? null,
    goals: kernel.goals ?? summary.goals ?? null,
    plans: kernel.plans ?? summary.plans ?? null,
    worker_fabric: kernel.worker_fabric ?? summary.worker_fabric ?? null,
    model_router: kernel.model_router ?? summary.model_router ?? null,
    attention: Array.isArray(kernel.attention ?? summary.attention) ? (kernel.attention ?? summary.attention).slice(0, 10) : [],
  });
}

function compactEventSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return summary;
  }
  return sanitizeValue({
    count: summary.count ?? null,
    max_event_seq: summary.max_event_seq ?? null,
    latest_created_at: summary.latest_created_at ?? null,
    event_type_counts: Array.isArray(summary.event_type_counts) ? summary.event_type_counts.slice(0, 25) : [],
    entity_type_counts: Array.isArray(summary.entity_type_counts) ? summary.entity_type_counts.slice(0, 25) : [],
    filters: summary.filters ?? null,
  });
}

function collectLocalMcp(options) {
  const summary = runMcpTool("event.summary", {}, options);
  if (!summary.ok || !summary.result || typeof summary.result !== "object" || Array.isArray(summary.result)) {
    return {
      status: "unavailable",
      source: "mcp_tool_call",
      unavailable_reason: "event_summary_unavailable",
      detail: summary.result,
    };
  }
  return {
    status: "available",
    source: "mcp_tool_call",
    transport: options.localTransport,
    event_summary: compactEventSummary(summary.result),
  };
}

function collectRecentEvents(options) {
  if (options.eventLimit <= 0) {
    return [];
  }
  const response = runMcpTool("event.tail", { limit: Math.min(100, options.eventLimit * 3) }, options);
  const events = Array.isArray(response?.result?.events)
    ? response.result.events.filter((event) => !String(event?.event_type || "").startsWith("federation."))
    : [];
  return events.slice(0, options.eventLimit).map((event) =>
    sanitizeValue({
      event_seq: event.event_seq ?? null,
      event_id: event.event_id ?? null,
      created_at: event.created_at ?? null,
      event_type: event.event_type ?? null,
      entity_type: event.entity_type ?? null,
      entity_id: event.entity_id ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      source_client: event.source_client ?? null,
      source_model: event.source_model ?? null,
      source_agent: event.source_agent ?? null,
    })
  );
}

function collectDesktopContext(options) {
  if (!options.includeDesktopContext) {
    return {
      status: "unavailable",
      source: "none",
      unavailable_reason: "desktop_context_disabled",
    };
  }
  const result = runJsonCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, "scripts", "remote_context_probe.mjs"),
      "--action=status",
      "--max-freshness-seconds",
      String(options.desktopMaxFreshnessSeconds),
    ],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(options.toolTimeoutMs, 8_000),
      unavailableReason: "remote_context_probe_unavailable",
    }
  );
  return sanitizeValue(result);
}

function hostSummary(options) {
  const userInfo = (() => {
    try {
      return os.userInfo();
    } catch {
      return { username: "unknown" };
    }
  })();
  return {
    host_id: options.hostId,
    hostname: os.hostname(),
    username: userInfo.username,
    platform: process.platform,
    arch: process.arch,
    repo_root: REPO_ROOT,
    cwd: process.cwd(),
    agent_runtime: options.agentRuntime,
    agent_id: options.agentId || options.agentRuntime || "federation-sidecar",
    model_label: options.modelLabel,
    generated_by: "master-mold.federation_sidecar",
  };
}

function buildPayload(options) {
  const generatedAt = new Date().toISOString();
  const sequence = nextSequence(options);
  return {
    schema_version: SCHEMA_VERSION,
    stream_id: options.streamId,
    sequence,
    generated_at: generatedAt,
    host: hostSummary(options),
    capabilities: {
      federation_sidecar: true,
      signed_event_stream: true,
      local_mcp: true,
      desktop_context: options.includeDesktopContext,
      peer_mesh: true,
    },
    local_mcp: collectLocalMcp(options),
    desktop_context: collectDesktopContext(options),
    recent_events: collectRecentEvents(options),
  };
}

async function postPeer(peer, payload, options) {
  const url = new URL("/federation/ingest", peer);
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.bearerToken}`,
    ...buildSignedHeaders(options, url),
  };
  if (options.origin) {
    headers.origin = options.origin;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 2_000) };
  }
  return {
    peer,
    ok: response.ok,
    status: response.status,
    response: parsed,
  };
}

function parseOptions() {
  const hostId = String(argValue("host-id", process.env.MASTER_MOLD_HOST_ID || safeId(os.hostname(), "local-host"))).trim();
  if (!hostId) {
    throw new Error("--host-id or MASTER_MOLD_HOST_ID is required");
  }
  const identityKeyPath = expandHome(argValue("identity-key-path", process.env.MASTER_MOLD_IDENTITY_KEY_PATH || defaultIdentityKeyPath(hostId)));
  const options = {
    hostId,
    identityKey: process.env.MASTER_MOLD_HOST_IDENTITY_KEY || "",
    identityKeyPath,
    privateKey: "",
    agentId: String(argValue("agent-id", process.env.MASTER_MOLD_AGENT_ID || "")).trim(),
    agentRuntime: String(argValue("agent-runtime", process.env.MASTER_MOLD_AGENT_RUNTIME || "federation-sidecar")).trim(),
    modelLabel: String(argValue("model-label", process.env.MASTER_MOLD_MODEL_LABEL || "federation-sidecar")).trim(),
    bearerToken: String(argValue("bearer-token", process.env.MCP_HTTP_BEARER_TOKEN || readLocalBearerTokenFile())).trim(),
    origin: String(argValue("origin", process.env.MASTER_MOLD_FEDERATION_ORIGIN || "")).trim(),
    peers: parsePeers(),
    once: boolArg("once", false),
    intervalSeconds: Math.max(5, numberArg("interval-seconds", Number(process.env.MASTER_MOLD_FEDERATION_INTERVAL_SECONDS || 30))),
    eventLimit: Math.min(100, Math.max(0, numberArg("event-limit", Number(process.env.MASTER_MOLD_FEDERATION_EVENT_LIMIT || 25)))),
    toolTimeoutMs: Math.max(1_000, numberArg("tool-timeout-ms", Number(process.env.MASTER_MOLD_FEDERATION_TOOL_TIMEOUT_MS || 12_000))),
    includeDesktopContext: boolArg("desktop-context", process.env.MASTER_MOLD_FEDERATION_DESKTOP_CONTEXT !== "0"),
    desktopMaxFreshnessSeconds: Math.max(
      1,
      numberArg("desktop-max-freshness-seconds", Number(process.env.MASTER_MOLD_FEDERATION_DESKTOP_MAX_FRESHNESS_SECONDS || 120))
    ),
    localTransport: String(argValue("local-transport", process.env.MASTER_MOLD_FEDERATION_LOCAL_TRANSPORT || "http")).trim(),
    localUrl: String(argValue("local-url", process.env.MCP_TOOL_CALL_URL || "http://127.0.0.1:8787/")).trim(),
    localOrigin: String(argValue("local-origin", process.env.MCP_TOOL_CALL_ORIGIN || "http://127.0.0.1")).trim(),
    streamId: "",
    statePath: "",
  };
  if (!["http", "stdio"].includes(options.localTransport)) {
    throw new Error("--local-transport must be http or stdio");
  }
  if (!options.bearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN or --bearer-token is required");
  }
  if (options.peers.length <= 0) {
    throw new Error("At least one --peer or MASTER_MOLD_FEDERATION_PEERS URL is required");
  }
  options.privateKey = readIdentityPrivateKey(options);
  options.streamId =
    String(argValue("stream-id", process.env.MASTER_MOLD_FEDERATION_STREAM_ID || "")).trim() ||
    `${options.hostId}:master-mold`;
  options.statePath = path.resolve(
    expandHome(
      argValue(
        "state-path",
        process.env.MASTER_MOLD_FEDERATION_STATE_PATH ||
          path.join(REPO_ROOT, "data", "federation", `${safeId(options.hostId, "host")}-sidecar-state.json`)
      )
    )
  );
  return options;
}

function printHelp() {
  console.log(`Usage:
  MASTER_MOLD_FEDERATION_PEERS=http://peer-a:8787,http://peer-b:8787 \\
  MASTER_MOLD_HOST_ID=my-mac \\
  MASTER_MOLD_IDENTITY_KEY_PATH=~/.master-mold/identity/my-mac-ed25519.pem \\
  MCP_HTTP_BEARER_TOKEN=... \\
  node scripts/federation_sidecar.mjs [--once]

Options:
  --peer <url>                         Add an approved MASTER-MOLD peer to publish to. Repeatable.
  --once                               Send one signed context/event payload, then exit.
  --interval-seconds <n>               Loop cadence when --once is not set. Default: 30.
  --local-transport http|stdio         How to read local MCP context. Default: http.
  --desktop-context true|false         Include local Chronicle/desktop-context metadata. Default: true.
  --event-limit <n>                    Recent local runtime events to include. Default: 25.

This is a peer mesh sidecar. Each host captures locally, publishes a bounded signed payload to configured peers, and each peer ingests into its own MASTER-MOLD event log.`);
}

async function runCycle(options) {
  const payload = buildPayload(options);
  const sends = [];
  for (const peer of options.peers) {
    try {
      sends.push(await postPeer(peer, payload, options));
    } catch (error) {
      sends.push({
        peer,
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: sends.every((entry) => entry.ok),
    schema_version: SCHEMA_VERSION,
    stream_id: payload.stream_id,
    sequence: payload.sequence,
    generated_at: payload.generated_at,
    peer_count: sends.length,
    sends,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseOptions();
  do {
    const result = await runCycle(options);
    console.log(JSON.stringify(result, null, options.once ? 2 : 0));
    if (options.once) {
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }
    await sleep(options.intervalSeconds * 1000);
  } while (true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
