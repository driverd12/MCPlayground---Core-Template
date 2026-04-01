#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function readEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectRemoteClient() {
  const baseUrl = readEnv("MCP_PROXY_HTTP_URL", readEnv("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"));
  const origin = readEnv("MCP_PROXY_HTTP_ORIGIN", readEnv("TRICHAT_MCP_ORIGIN", "http://127.0.0.1"));
  const bearerToken = readEnv("MCP_PROXY_HTTP_BEARER_TOKEN", readEnv("MCP_HTTP_BEARER_TOKEN", ""));
  const maxAttempts = Number.parseInt(readEnv("MCP_PROXY_CONNECT_ATTEMPTS", "8"), 10);
  const retryDelayMs = Number.parseInt(readEnv("MCP_PROXY_CONNECT_DELAY_MS", "500"), 10);
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    const client = new Client(
      { name: "mcplayground-provider-stdio-bridge", version: "1.0.0" },
      { capabilities: {} }
    );
    const headers = {
      Origin: origin,
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    };
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers },
    });
    try {
      await client.connect(transport);
      return { client, transport, baseUrl };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      try {
        await transport.close();
      } catch {}
      try {
        await client.close();
      } catch {}
      if (attempt < maxAttempts) {
        await sleep(Math.max(100, retryDelayMs));
      }
    }
  }

  throw lastError ?? new Error("Unable to connect provider stdio bridge to the MCP HTTP daemon.");
}

async function main() {
  const server = new Server(
    { name: "mcplayground-provider-stdio-bridge", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: false },
      },
      instructions: `Proxy MCP bridge forwarding tools to ${readEnv("MCP_PROXY_HTTP_URL", readEnv("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"))}.`,
    }
  );

  let remotePromise = null;
  const getRemote = async () => {
    if (!remotePromise) {
      remotePromise = connectRemoteClient().catch((error) => {
        remotePromise = null;
        throw error;
      });
    }
    return remotePromise;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const { client } = await getRemote();
    const result = await client.listTools(request.params ?? {});
    return {
      tools: result.tools,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { client } = await getRemote();
    return client.callTool(request.params);
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  void getRemote().catch(() => {});

  const shutdown = async () => {
    try {
      await server.close();
    } catch {}
    try {
      const remote = await remotePromise?.catch(() => null);
      if (remote) {
        try {
          await remote.transport.close();
        } catch {}
        try {
          await remote.client.close();
        } catch {}
      }
    } catch {}
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[provider-stdio-bridge] ${message}\n`);
  process.exit(1);
});
