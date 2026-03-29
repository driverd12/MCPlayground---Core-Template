#!/usr/bin/env node
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [transportKind, url, origin, stdioCommand, stdioArgs, cwd, argsJson] = process.argv.slice(2);

if (!transportKind || !url || !origin || !stdioCommand || !stdioArgs || !cwd || !argsJson) {
  process.stderr.write(
    "usage: autonomy_command_client.mjs <transport> <url> <origin> <stdio-command> <stdio-args> <cwd> <args-json>\n"
  );
  process.exit(2);
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

const transport =
  transportKind === "http"
    ? new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.MCP_HTTP_BEARER_TOKEN || ""}`,
            Origin: origin,
          },
        },
      })
    : new StdioClientTransport({
        command: stdioCommand,
        args: String(stdioArgs)
          .split(/\s+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
        cwd,
        env: process.env,
        stderr: "pipe",
      });

const client = new Client({ name: "autonomy-command-shell", version: "0.1.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "autonomy.command",
    arguments: JSON.parse(argsJson),
  });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool autonomy.command failed: ${text}`);
  }
  process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  await Promise.race([
    client.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
