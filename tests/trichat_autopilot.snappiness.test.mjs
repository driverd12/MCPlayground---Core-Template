import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("trichat.autopilot council uses parallel asks with quorum-first finalize", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-snappy-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "const delayMs = Number.parseInt(process.argv[3] || '0', 10) || 0;",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  const send = () => {",
      "    if (payload.op === 'ping') {",
      "      const envelope = {",
      "        kind: 'trichat.adapter.pong',",
      "        protocol_version: protocolVersion,",
      "        request_id: requestId,",
      "        agent_id: agent,",
      "        thread_id: threadId,",
      "        content: 'pong'",
      "      };",
      "      process.stdout.write(`${JSON.stringify(envelope)}\\n`);",
      "      return;",
      "    }",
      "    const proposal = {",
      "      strategy: `${agent} strategy for ${payload.prompt || 'objective'}`,",
      "      commands: [],",
      "      confidence: 0.86,",
      "      mentorship_note: `${agent} distilled mentorship note`",
      "    };",
      "    const envelope = {",
      "      kind: 'trichat.adapter.response',",
      "      protocol_version: protocolVersion,",
      "      request_id: requestId,",
      "      agent_id: agent,",
      "      thread_id: threadId,",
      "      content: JSON.stringify(proposal)",
      "    };",
      "    process.stdout.write(`${JSON.stringify(envelope)}\\n`);",
      "  };",
      "  setTimeout(send, Math.max(0, delayMs));",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const codexCmd = `node ${JSON.stringify(bridgePath)} codex 40`;
  const cursorCmd = `node ${JSON.stringify(bridgePath)} cursor 40`;
  const imprintCmd = `node ${JSON.stringify(bridgePath)} local-imprint 4500`;

  const session = await openClient(dbPath, {
    TRICHAT_CODEX_CMD: codexCmd,
    TRICHAT_CURSOR_CMD: cursorCmd,
    TRICHAT_IMPRINT_CMD: imprintCmd,
  });

  try {
    const startedAt = Date.now();
    const runOnce = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-snappy-run_once", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-snappy-${testId}`,
      thread_title: `TriChat Autopilot Snappy ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      max_rounds: 1,
      lead_agent_id: "codex",
      specialist_agent_ids: ["cursor", "local-imprint"],
      min_success_agents: 2,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: false,
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });
    const durationMs = Date.now() - startedAt;

    assert.equal(runOnce.tick.ok, true);
    assert.ok(durationMs < 3500, `Expected quorum-first council completion under 3.5s; got ${durationMs}ms`);
    assert.ok(runOnce.tick.success_agents >= 2);

    const timeline = await callTool(session.client, "trichat.timeline", {
      thread_id: runOnce.tick.thread_id,
      limit: 100,
    });
    const assistantMessages = timeline.messages.filter((entry) => entry.role === "assistant");
    assert.ok(
      assistantMessages.length <= 2,
      `Expected quorum-first finalize to avoid waiting for slow straggler (assistant messages=${assistantMessages.length})`
    );
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
    stderr: "inherit",
  });
  const client = new Client(
    { name: "mcp-trichat-autopilot-snappy-test", version: "0.1.0" },
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
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
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
