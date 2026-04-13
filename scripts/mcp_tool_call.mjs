#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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

  const client = new Client({ name: "mcplayground-mcp-tool-call", version: "0.1.0" }, { capabilities: {} });
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
  return new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: options.origin,
      },
    },
  });
}

main().catch((error) => {
  writeErrorAndExit(error instanceof Error ? error.message : String(error));
});
