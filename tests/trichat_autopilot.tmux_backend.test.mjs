import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("trichat.autopilot can execute council commands via tmux backend", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-tmux-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_tmux_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    const pong = { kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' };",
      "    process.stdout.write(`${JSON.stringify(pong)}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: `${agent} tmux execution strategy`,",
      "    commands: ['echo warmup', 'echo compile', 'echo verify'],",
      "    confidence: 0.88,",
      "    mentorship_note: `${agent} teaches batching and worker lanes`",
      "  };",
      "  const envelope = {",
      "    kind: 'trichat.adapter.response',",
      "    protocol_version: protocolVersion,",
      "    request_id: requestId,",
      "    agent_id: agent,",
      "    thread_id: threadId,",
      "    content: JSON.stringify(response)",
      "  };",
      "  process.stdout.write(`${JSON.stringify(envelope)}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_TMUX_DRY_RUN: "1",
    TRICHAT_CODEX_CMD: bridgeCmd("codex"),
    TRICHAT_CURSOR_CMD: bridgeCmd("cursor"),
    TRICHAT_IMPRINT_CMD: bridgeCmd("local-imprint"),
  });

  try {
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-tmux", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-tmux-${testId}`,
      thread_title: `TriChat Autopilot Tmux ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: true,
      command_allowlist: ["echo "],
      execute_backend: "tmux",
      tmux_session_name: `trichat-autopilot-${testId}`,
      tmux_worker_count: 4,
      tmux_max_queue_per_worker: 4,
      tmux_auto_scale_workers: true,
      tmux_sync_after_dispatch: true,
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.execution.mode, "tmux_dispatch");
    assert.equal(result.tick.execution.direct_success, true);
    assert.ok(result.tick.execution.tmux);
    assert.ok(result.tick.execution.tmux.dispatched_count >= 1);
    assert.ok(result.tick.execution.tmux.worker_count >= 1);
    assert.ok(result.tick.execution.tmux.worker_count <= 4);
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function openClient(dbPath, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(path.dirname(dbPath), "trichat.bus.sock"),
      ...extraEnv,
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-trichat-autopilot-tmux-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client };
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
