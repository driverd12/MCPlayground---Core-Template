#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID, sign as signData } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function officeSnapshotCacheToken(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return normalized || fallback;
}

function officeSnapshotCacheDir(cwd) {
  const override = String(process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR || "").trim();
  const baseDir = override ? path.resolve(override) : path.join(cwd, "data", "imprint", "office_snapshot_cache");
  return path.join(baseDir, "web");
}

function officeSnapshotCachePath(cwd, threadId, theme) {
  return path.join(
    officeSnapshotCacheDir(cwd),
    `thread-${officeSnapshotCacheToken(threadId, "ring-leader-main")}--theme-${officeSnapshotCacheToken(theme, "night")}.json`
  );
}

function officeSnapshotLatestCachePath(cwd, theme) {
  return path.join(
    officeSnapshotCacheDir(cwd),
    `latest--theme-${officeSnapshotCacheToken(theme, "night")}.json`
  );
}

function officeSnapshotStaleMaxAgeSeconds() {
  const override = Number(process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return 900;
}

function defaultTimeoutMsForTool(transport, tool) {
  if (tool === "office.snapshot") {
    return transport === "http" ? 10_000 : 12_000;
  }
  return transport === "http" ? 15_000 : 60_000;
}

function readCachedOfficeSnapshot(cwd, args) {
  const theme = String(args?.theme || process.env.TRICHAT_OFFICE_THEME || "night").trim() || "night";
  const threadId = String(args?.thread_id || "").trim();
  const candidates = threadId
    ? [officeSnapshotCachePath(cwd, threadId, theme), officeSnapshotLatestCachePath(cwd, theme)]
    : [officeSnapshotLatestCachePath(cwd, theme)];
  const nowSeconds = Date.now() / 1000;
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const fetchedAt = typeof parsed.fetched_at === "number" ? parsed.fetched_at : Number(parsed.fetched_at || 0);
      if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
        continue;
      }
      const ageSeconds = Math.max(0, nowSeconds - fetchedAt);
      if (ageSeconds > officeSnapshotStaleMaxAgeSeconds()) {
        continue;
      }
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function writeJsonAndExit(value) {
  fs.writeSync(process.stdout.fd, `${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
}

function writeErrorAndExit(message) {
  fs.writeSync(process.stderr.fd, `${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    tool: "",
    argsJson: "{}",
    transport: process.env.MCP_TOOL_CALL_TRANSPORT ?? "stdio",
    url: process.env.MCP_TOOL_CALL_URL ?? "http://127.0.0.1:8787/",
    origin: process.env.MCP_TOOL_CALL_ORIGIN ?? "http://127.0.0.1",
    stdioCommand: process.env.MCP_TOOL_CALL_STDIO_COMMAND ?? "node",
    stdioArgs: process.env.MCP_TOOL_CALL_STDIO_ARGS ?? "dist/server.js",
    cwd: process.cwd(),
    timeoutMs: Number.parseInt(String(process.env.MCP_TOOL_CALL_TIMEOUT_MS ?? "").trim(), 10),
    maxAttempts: Number.parseInt(String(process.env.MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS ?? "").trim(), 10),
    hostId: process.env.MASTER_MOLD_HOST_ID ?? "",
    agentId: process.env.MASTER_MOLD_AGENT_ID ?? process.env.MASTER_MOLD_AGENT_RUNTIME ?? "",
    identityKey: process.env.MASTER_MOLD_HOST_IDENTITY_KEY ?? "",
    identityKeyPath: process.env.MASTER_MOLD_IDENTITY_KEY_PATH ?? "",
    agentRuntime: process.env.MASTER_MOLD_AGENT_RUNTIME ?? "",
    modelLabel: process.env.MASTER_MOLD_MODEL_LABEL ?? "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--tool") {
      out.tool = argv[++i] ?? "";
    } else if (token === "--args") {
      out.argsJson = argv[++i] ?? "{}";
    } else if (token === "--transport") {
      out.transport = argv[++i] ?? out.transport;
    } else if (token === "--url") {
      out.url = argv[++i] ?? out.url;
    } else if (token === "--origin") {
      out.origin = argv[++i] ?? out.origin;
    } else if (token === "--stdio-command") {
      out.stdioCommand = argv[++i] ?? out.stdioCommand;
    } else if (token === "--stdio-args") {
      out.stdioArgs = argv[++i] ?? out.stdioArgs;
    } else if (token === "--cwd") {
      out.cwd = argv[++i] ?? out.cwd;
    } else if (token === "--timeout-ms") {
      out.timeoutMs = Number.parseInt(String(argv[++i] ?? "").trim(), 10);
    } else if (token === "--max-attempts") {
      out.maxAttempts = Number.parseInt(String(argv[++i] ?? "").trim(), 10);
    } else if (token === "--host-id") {
      out.hostId = argv[++i] ?? out.hostId;
    } else if (token === "--agent-id") {
      out.agentId = argv[++i] ?? out.agentId;
    } else if (token === "--identity-key") {
      out.identityKey = argv[++i] ?? out.identityKey;
    } else if (token === "--identity-key-path") {
      out.identityKeyPath = argv[++i] ?? out.identityKeyPath;
    } else if (token === "--agent-runtime") {
      out.agentRuntime = argv[++i] ?? out.agentRuntime;
    } else if (token === "--model-label") {
      out.modelLabel = argv[++i] ?? out.modelLabel;
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!out.tool) {
    throw new Error("--tool is required");
  }

  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    out.timeoutMs = defaultTimeoutMsForTool(out.transport, out.tool);
  }

  if (!Number.isFinite(out.maxAttempts) || out.maxAttempts <= 0) {
    out.maxAttempts = out.transport === "http" ? 10 : 1;
  }

  return out;
}

function printHelp() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/mcp_tool_call.mjs --tool <name> [--args '<json>'] [--transport stdio|http]",
      "",
      "Examples:",
      "  node scripts/mcp_tool_call.mjs --tool health.storage",
      "  node scripts/mcp_tool_call.mjs --tool imprint.bootstrap --args '{\"profile_id\":\"default\"}'",
      "  MASTER_MOLD_HOST_ID=my-mac MASTER_MOLD_IDENTITY_KEY_PATH=~/.master-mold/identity/my-mac-ed25519.pem node scripts/mcp_tool_call.mjs --transport http --tool kernel.summary",
    ].join("\n") + "\n"
  );
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function asJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePid(pid, options = {}) {
  const termWaitMs = Number.isFinite(options.termWaitMs) ? Math.max(0, options.termWaitMs) : 500;
  const killWaitMs = Number.isFinite(options.killWaitMs) ? Math.max(0, options.killWaitMs) : 500;
  if (!pidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const termDeadline = Date.now() + termWaitMs;
  while (Date.now() < termDeadline && pidAlive(pid)) {
    await sleep(50);
  }
  if (!pidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  const killDeadline = Date.now() + killWaitMs;
  while (Date.now() < killDeadline && pidAlive(pid)) {
    await sleep(50);
  }
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
    }),
  ]);
}

function isRetryableHttpError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|UND_ERR|timed out|429|502|503|504/i.test(
    message
  );
}

async function invokeToolOnce(options, args) {
  const transport =
    options.transport === "http"
      ? createHttpTransport(options)
      : createStdioTransport(options);

  const client = new Client({ name: "master-mold-mcp-tool-call", version: "0.1.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), options.timeoutMs, `connect ${options.transport}:${options.tool}`);
    const response = await withTimeout(
      client.callTool({ name: options.tool, arguments: args }, undefined, { timeout: options.timeoutMs }),
      options.timeoutMs,
      `call ${options.transport}:${options.tool}`
    );
    const text = extractText(response);
    if (response.isError) {
      throw new Error(`Tool ${options.tool} failed: ${text}`);
    }
    return asJson(text);
  } finally {
    const transportProcess = transport && typeof transport === "object" ? transport._process : null;
    const transportPid = Number.parseInt(String(transportProcess?.pid ?? ""), 10);
    if (options.transport === "stdio") {
      await terminatePid(transportPid, { termWaitMs: 500, killWaitMs: 1000 });
    }
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, options.transport === "stdio" ? 1500 : 750)),
    ]);
    if (typeof transport.close === "function") {
      await Promise.race([
        transport.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, options.transport === "stdio" ? 1500 : 750)),
      ]);
    }
    if (pidAlive(transportPid)) {
      await terminatePid(transportPid, { termWaitMs: 250, killWaitMs: 500 });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let args;
  try {
    args = JSON.parse(options.argsJson);
  } catch (error) {
    throw new Error(`Invalid --args JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const maxAttempts = options.transport === "http" ? options.maxAttempts : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const parsed = await invokeToolOnce(options, args);
      writeJsonAndExit(parsed);
    } catch (error) {
      lastError = error;
      if (options.transport === "stdio" && options.tool === "office.snapshot" && isRetryableHttpError(error)) {
        break;
      }
      if (options.transport !== "http" || attempt >= maxAttempts || !isRetryableHttpError(error)) {
        throw error;
      }
      await sleep(Math.min(2000, 200 * attempt));
    }
  }
  if (options.tool === "office.snapshot") {
    const cachedSnapshot = readCachedOfficeSnapshot(options.cwd, args);
    if (cachedSnapshot) {
      writeJsonAndExit(cachedSnapshot);
    }
  }
  throw lastError ?? new Error("Tool invocation failed");
}

function createStdioTransport(options) {
  const childEnv = { ...process.env };
  childEnv.MCP_HTTP = "0";
  childEnv.MCP_HTTP_HOST = "";
  childEnv.MCP_HTTP_PORT = "";
  childEnv.MCP_HTTP_ALLOWED_ORIGINS = "";
  childEnv.MCP_HTTP_BEARER_TOKEN = "";
  childEnv.ANAMNESIS_MCP_HTTP_PORT = "";
  childEnv.ANAMNESIS_MCP_HTTP_BEARER_TOKEN = "";
  childEnv.MCP_BACKGROUND_OWNER = "0";
  childEnv.TRICHAT_BUS_AUTOSTART = "0";
  childEnv.TRICHAT_RING_LEADER_AUTOSTART = "0";
  childEnv.MCP_AUTONOMY_BOOTSTRAP_ON_START = "0";
  childEnv.MCP_AUTONOMY_MAINTAIN_ON_START = "0";
  childEnv.ANAMNESIS_HUB_STARTUP_BACKUP = "0";
  return new StdioClientTransport({
    command: options.stdioCommand,
    args: String(options.stdioArgs)
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    cwd: options.cwd,
    env: childEnv,
    stderr: "pipe",
  });
}

function createHttpTransport(options) {
  const token = process.env.MCP_HTTP_BEARER_TOKEN;
  if (!token) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required for --transport http");
  }
  const signedFetch = createSignedFetch(options);
  return new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: options.origin,
      },
    },
    ...(signedFetch ? { fetch: signedFetch } : {}),
  });
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

function defaultIdentityKeyPath(hostId) {
  const safeHostId =
    String(hostId || "remote-host")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "remote-host";
  return path.join(os.homedir(), ".master-mold", "identity", `${safeHostId}-ed25519.pem`);
}

function readIdentityPrivateKey(options) {
  const inlineKey = String(options.identityKey || "").trim();
  if (inlineKey.startsWith("-----BEGIN")) {
    return inlineKey;
  }
  const explicitPath = expandHome(inlineKey || options.identityKeyPath);
  const candidatePath = explicitPath || (options.hostId ? defaultIdentityKeyPath(options.hostId) : "");
  if (!candidatePath) {
    return "";
  }
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`MASTER-MOLD host identity key not found: ${candidatePath}`);
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

function requestPathForSignature(input, fallbackUrl) {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : typeof input?.url === "string"
          ? input.url
          : String(fallbackUrl || "");
  const parsed = new URL(rawUrl, fallbackUrl);
  return `${parsed.pathname || "/"}${parsed.search || ""}` || "/";
}

function requestMethodForSignature(input, init) {
  return String(init?.method || (typeof input === "object" && input && "method" in input ? input.method : "GET") || "GET").toUpperCase();
}

function buildHostIdentityHeaders(options, request) {
  const hostId = String(options.hostId || "").trim();
  if (!hostId) {
    return {};
  }
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const agentId = String(options.agentId || options.agentRuntime || "").trim();
  const payload = buildHostIdentitySignaturePayload({
    method: request.method,
    path: request.path,
    host_id: hostId,
    agent_id: agentId,
    timestamp,
    nonce,
  });
  return {
    "x-master-mold-host-id": hostId,
    "x-master-mold-agent-id": agentId,
    "x-master-mold-timestamp": timestamp,
    "x-master-mold-nonce": nonce,
    "x-master-mold-signature": `ed25519:${signData(null, Buffer.from(payload), request.privateKey).toString("base64url")}`,
    ...(options.agentRuntime ? { "x-master-mold-agent-runtime": options.agentRuntime } : {}),
    ...(options.modelLabel ? { "x-master-mold-model-label": options.modelLabel } : {}),
  };
}

function createSignedFetch(options) {
  const hostId = String(options.hostId || "").trim();
  if (!hostId) {
    return null;
  }
  const privateKey = readIdentityPrivateKey(options);
  if (!privateKey) {
    throw new Error("MASTER_MOLD_HOST_ID is set but no host identity private key was provided");
  }
  const fallbackUrl = options.url;
  return async (input, init = {}) => {
    const headers = new Headers(typeof input === "object" && input && "headers" in input ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers || {}).entries()) {
      headers.set(name, value);
    }
    const method = requestMethodForSignature(input, init);
    const pathForSignature = requestPathForSignature(input, fallbackUrl);
    const signedHeaders = buildHostIdentityHeaders(options, {
      method,
      path: pathForSignature,
      privateKey,
    });
    for (const [name, value] of Object.entries(signedHeaders)) {
      headers.set(name, value);
    }
    return fetch(input, {
      ...init,
      headers,
    });
  };
}

main().catch((error) => {
  writeErrorAndExit(error instanceof Error ? error.message : String(error));
});
