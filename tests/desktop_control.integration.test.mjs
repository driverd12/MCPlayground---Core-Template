import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("desktop control tools persist host-control state and surface dry-run machine actions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-control-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath, {
    MCP_DESKTOP_CONTROL_DRY_RUN: "1",
    MCP_DESKTOP_CONTROL_TEST_FRONTMOST: "Cursor|Agent Office",
    MCP_DESKTOP_CONTROL_TEST_CLIPBOARD: "ship it",
  });
  try {
    const initial = await callTool(client, "desktop.control", {});
    assert.equal(initial.source, "desktop.control");
    assert.equal(initial.state.enabled, false);

    const configured = await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-control", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      allow_act: true,
      allow_listen: true,
      heartbeat_interval_seconds: 30,
    });
    assert.equal(configured.state.enabled, true);
    assert.equal(configured.state.allow_act, true);
    assert.equal(configured.state.allow_listen, true);

    const heartbeat = await callTool(client, "desktop.control", {
      action: "heartbeat",
      mutation: nextMutation("desktop-control", "desktop.control.heartbeat", () => mutationCounter++),
    });
    assert.equal(heartbeat.source, "desktop.control");
    assert.equal(heartbeat.state.enabled, true);
    assert.equal(typeof heartbeat.state.last_heartbeat_at, "string");
    assert.equal(typeof heartbeat.state.capability_probe.generated_at, "string");

    const frontmost = await callTool(client, "desktop.observe", {
      action: "frontmost_app",
    });
    assert.equal(frontmost.observation.app_name, "Cursor");
    assert.equal(frontmost.observation.window_title, "Agent Office");

    const clipboard = await callTool(client, "desktop.observe", {
      action: "clipboard",
    });
    assert.equal(clipboard.observation.text.trim(), "ship it");

    const screenshot = await callTool(client, "desktop.observe", {
      action: "screenshot",
      mutation: nextMutation("desktop-control", "desktop.observe.screenshot", () => mutationCounter++),
      filename: "test-capture",
    });
    assert.equal(screenshot.observation.dry_run, true);
    assert.match(screenshot.observation.output_path, /test-capture\.png$/);

    const act = await callTool(client, "desktop.act", {
      action: "open_url",
      mutation: nextMutation("desktop-control", "desktop.act", () => mutationCounter++),
      url: "https://example.com",
    });
    assert.equal(act.result.dry_run, true);

    const listen = await callTool(client, "desktop.listen", {
      action: "record",
      mutation: nextMutation("desktop-control", "desktop.listen", () => mutationCounter++),
      duration_seconds: 3,
      filename: "mic-check",
    });
    assert.equal(listen.recording.dry_run, true);
    assert.match(listen.recording.output_path, /mic-check\.m4a$/);

    const kernel = await callTool(client, "kernel.summary", {});
    assert.equal(kernel.desktop_control.summary.enabled, true);

    const brief = await callTool(client, "operator.brief", {
      thread_id: "ring-leader-main",
      include_kernel: true,
      include_runtime_brief: false,
      include_compile_brief: false,
      compact: true,
    });
    assert.equal(brief.control_plane_summary.desktop_control.enabled, true);

    const office = await callTool(client, "office.snapshot", {});
    assert.equal(office.desktop_control.summary.enabled, true);
    assert.equal(office.desktop_control.summary.listen_ready, true);
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(tempDir, dbPath, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      MCP_NOTIFIER_DRY_RUN: "1",
      TRICHAT_AGENT_IDS: "",
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      ...extraEnv,
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-desktop-control-integration-test", version: "0.1.0" },
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

async function closeClient(client) {
  await client.close().catch(() => {});
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
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

function nextMutation(testId, label, nextCounter) {
  const index = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${index}`,
    side_effect_fingerprint: `${testId}:${label}:${index}`,
  };
}
