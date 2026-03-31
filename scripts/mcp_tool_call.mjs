#!/usr/bin/env node
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
    out.timeoutMs = out.transport === "http" ? 15000 : 60000;
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
      client.callTool({ name: options.tool, arguments: args }),
      options.timeoutMs,
      `call ${options.transport}:${options.tool}`
    );
    const text = extractText(response);
    if (response.isError) {
      throw new Error(`Tool ${options.tool} failed: ${text}`);
    }
    return asJson(text);
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
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
      process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    } catch (error) {
      lastError = error;
      if (options.transport !== "http" || attempt >= maxAttempts || !isRetryableHttpError(error)) {
        throw error;
      }
      await sleep(Math.min(2000, 200 * attempt));
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
