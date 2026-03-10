import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("trichat.bus streams message_post events over Unix socket while persisting to SQLite", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-bus-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busSocketPath = path.join(tempDir, "trichat.bus.sock");
  let mutationCounter = 0;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busSocketPath,
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-trichat-bus-test-client", version: "0.1.0" },
    { capabilities: {} }
  );

  let socket = null;
  try {
    await client.connect(transport);
    const threadId = `trichat-bus-${testId}`;
    await callTool(client, "trichat.thread_open", {
      mutation: nextMutation(testId, "trichat.thread_open", () => mutationCounter++),
      thread_id: threadId,
      title: `TriChat Bus ${testId}`,
      metadata: { source: "trichat-bus.unixsocket.test" },
    });

    const busStatus = await callTool(client, "trichat.bus", {
      action: "status",
    });
    assert.equal(busStatus.running, true);
    assert.equal(typeof busStatus.socket_path, "string");
    assert.ok(busStatus.socket_path.length > 0);
    await waitForCondition(() => fs.existsSync(busStatus.socket_path), 3000, 25);
    assert.ok(fs.existsSync(busStatus.socket_path));

    const socketMessages = [];
    socket = await connectUnixSocket(busStatus.socket_path, socketMessages);
    socket.write(
      `${JSON.stringify({
        op: "subscribe",
        thread_id: threadId,
        event_types: ["trichat.message_post"],
        since_seq: 0,
        replay_limit: 25,
      })}\n`
    );

    const subscribed = await waitForSocketMessage(
      socketMessages,
      (entry) => entry.kind === "subscribed",
      3000
    );
    assert.equal(subscribed.kind, "subscribed");

    const posted = await callTool(client, "trichat.message_post", {
      mutation: nextMutation(testId, "trichat.message_post", () => mutationCounter++),
      thread_id: threadId,
      agent_id: "user",
      role: "user",
      content: `trichat bus socket test ${testId}`,
    });
    assert.equal(posted.ok, true);
    assert.ok(posted.message.message_id);

    const streamedEvent = await waitForSocketMessage(
      socketMessages,
      (entry) =>
        entry.kind === "event" &&
        entry.event?.thread_id === threadId &&
        entry.event?.event_type === "trichat.message_post" &&
        entry.event?.source_agent === "user",
      5000
    );
    assert.equal(streamedEvent.event.thread_id, threadId);
    assert.equal(streamedEvent.event.event_type, "trichat.message_post");
    assert.equal(streamedEvent.event.source_agent, "user");

    const tail = await callTool(client, "trichat.bus", {
      action: "tail",
      thread_id: threadId,
      limit: 50,
    });
    assert.ok(Array.isArray(tail.events));
    assert.ok(
      tail.events.some(
        (event) =>
          event.thread_id === threadId &&
          event.event_type === "trichat.message_post" &&
          event.source_agent === "user"
      )
    );
  } finally {
    if (socket) {
      socket.destroy();
    }
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function connectUnixSocket(socketPath, sink) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) {
          break;
        }
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) {
          continue;
        }
        try {
          sink.push(JSON.parse(line));
        } catch {
          // Ignore malformed lines in tests.
        }
      }
    });
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => reject(error));
  });
}

async function waitForSocketMessage(messages, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const message of messages) {
      if (predicate(message)) {
        return message;
      }
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for expected Unix socket message");
}

async function waitForCondition(predicate, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for expected condition");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function callTool(client, name, args) {
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
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
