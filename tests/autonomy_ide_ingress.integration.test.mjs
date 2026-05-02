import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("autonomy.ide_ingress records continuity, mirrors to the office thread, and launches durable background execution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-ide-ingress-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  const objective =
    "IDE ingress integration objective to persist continuity, mirror into the office, and continue in the background.";
  const sessionId = "codex-ide-ingress-test";
  const threadId = "codex-ide-ingress-thread";

  try {
    const ingress = await callTool(session.client, "autonomy.ide_ingress", {
      mutation: nextMutation("autonomy-ide-ingress", "autonomy.ide_ingress", () => mutationCounter++),
      objective,
      title: "IDE ingress integration",
      session_id: sessionId,
      thread_id: threadId,
      tags: ["ide", "ingress", "integration"],
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
      source_client: "codex.desktop",
      source_agent: "codex",
    });

    assert.equal(ingress.ok, true);
    assert.equal(ingress.session_id, sessionId);
    assert.equal(ingress.thread_id, threadId);
    assert.deepEqual(ingress.effective_trichat_agent_ids, [
      "implementation-director",
      "research-director",
      "verification-director",
      "local-imprint",
    ]);
    assert.equal(ingress.autonomy.goal.title, "IDE ingress integration");
    assert.equal(ingress.autonomy.execution.ok, true);

    const transcript = await callTool(session.client, "transcript.run_timeline", {
      run_id: sessionId,
      limit: 20,
    });
    assert.ok(
      transcript.lines.some((line) => line.role === "ide.objective" && line.content === objective),
      "expected IDE objective transcript line"
    );

    const timeline = await callTool(session.client, "trichat.timeline", {
      thread_id: threadId,
      limit: 20,
    });
    assert.ok(
      timeline.messages.some((message) => message.role === "user" && message.content === objective),
      "expected mirrored office thread message"
    );

    const events = await callTool(session.client, "event.tail", {
      event_type: "autonomy.ide_ingress",
      limit: 20,
    });
    assert.ok(
      events.events.some((event) => event.entity_id === ingress.autonomy.goal.goal_id && event.content === objective),
      "expected ingress runtime event tied to the created goal"
    );

    const memories = await callTool(session.client, "memory.search", {
      query: "IDE ingress integration objective",
      limit: 10,
    });
    assert.ok(
      memories.some((memory) => String(memory.content ?? "").includes("IDE ingress objective: IDE ingress integration")),
      "expected distilled memory entry"
    );

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "status",
    });
    assert.equal(typeof maintain.state.last_self_drive_at, "string");
    assert.equal(maintain.state.last_self_drive_goal_id, ingress.autonomy.goal.goal_id);
    assert.ok(maintain.state.last_actions.includes("autonomy.ide_ingress"));
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "mcp-autonomy-ide-ingress-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return { client };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const first = response.content?.[0];
  assert.equal(first?.type, "text");
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${first.text}`);
  }
  return JSON.parse(first.text);
}

function nextMutation(testId, label, nextCounter) {
  const counter = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${counter}`,
    side_effect_fingerprint: `${testId}:${label}:${counter}`,
  };
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

async function startFakeOllamaServer({ models }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake Ollama server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
