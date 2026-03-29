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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let args;
  try {
    args = JSON.parse(options.argsJson);
  } catch (error) {
    throw new Error(`Invalid --args JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const transport =
    options.transport === "http"
      ? createHttpTransport(options)
      : createStdioTransport(options);

  const client = new Client({ name: "mcplayground-mcp-tool-call", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const response = await client.callTool({ name: options.tool, arguments: args });
    const text = extractText(response);
    if (response.isError) {
      throw new Error(`Tool ${options.tool} failed: ${text}`);
    }
    const parsed = asJson(text);
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
  }
}

function createStdioTransport(options) {
  return new StdioClientTransport({
    command: options.stdioCommand,
    args: String(options.stdioArgs)
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    cwd: options.cwd,
    env: process.env,
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
