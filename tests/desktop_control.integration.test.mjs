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
    assert.equal(typeof screenshot.state.last_screenshot_at, "string");

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

test("desktop.context surfaces fresh Chronicle screen frames with noisy OCR triage and event logging", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-context-chronicle-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const tmpDir = path.join(tempDir, "tmp");
  const chronicleRoot = path.join(tmpDir, "chronicle", "screen_recording");
  const recorderRoot = path.join(tmpDir, "codex_chronicle");
  fs.mkdirSync(chronicleRoot, { recursive: true });
  fs.mkdirSync(recorderRoot, { recursive: true });
  fs.writeFileSync(path.join(recorderRoot, "chronicle-started.pid"), String(process.pid));
  const segmentId = "2026-04-21T14-00-00Z-display-main";
  const latestFrame = path.join(chronicleRoot, `${segmentId}-latest.jpg`);
  fs.writeFileSync(latestFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const staleFrame = path.join(chronicleRoot, "2026-04-21T13-00-00Z-display-main-latest.jpg");
  fs.writeFileSync(staleFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(staleFrame, staleTime, staleTime);
  fs.writeFileSync(
    path.join(chronicleRoot, `${segmentId}.capture.json`),
    JSON.stringify({ segment_id: segmentId, display_id: "main" })
  );
  fs.writeFileSync(
    path.join(chronicleRoot, `${segmentId}.ocr.jsonl`),
    `${JSON.stringify({ timestamp: new Date().toISOString(), text: "Agent Office Hosts panel is visible" })}\n`
  );

  let mutationCounter = 0;
  const { client } = await openClient(tempDir, dbPath, {
    TMPDIR: tmpDir,
  });
  try {
    await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-context-chronicle", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      screenshot_dir: tempDir,
    });

    const context = await callTool(client, "desktop.context", {
      action: "latest",
      query: "Hosts panel",
      source_client: "test",
      source_agent: "codex-test",
    });
    assert.equal(context.status, "available");
    assert.equal(context.source, "chronicle");
    assert.equal(context.latest_frame_path, latestFrame);
    assert.equal(context.recorder_pid_path, path.join(recorderRoot, "chronicle-started.pid"));
    assert.equal(context.displays.length, 1);
    assert.equal(context.displays[0].display_id, "main");
    assert.equal(context.displays[0].stale, false);
    assert.equal(context.ocr_hits.length, 1);
    assert.match(context.ocr_note, /noisy triage/i);
    assert.equal(typeof context.event_id, "string");

    const events = await callTool(client, "event.tail", {
      event_type: "desktop.context",
      limit: 5,
    });
    assert.ok(events.events.some((event) => event.event_id === context.event_id));
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop.context accepts legacy Chronicle recorder pid locations", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-context-chronicle-legacy-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const tmpDir = path.join(tempDir, "tmp");
  const chronicleRoot = path.join(tmpDir, "chronicle", "screen_recording");
  const recorderRoot = path.join(tmpDir, "codex_tape_recorder");
  fs.mkdirSync(chronicleRoot, { recursive: true });
  fs.mkdirSync(recorderRoot, { recursive: true });
  fs.writeFileSync(path.join(recorderRoot, "chronicle-started.pid"), String(process.pid));
  const segmentId = "2026-04-21T14-05-00Z-display-main";
  const latestFrame = path.join(chronicleRoot, `${segmentId}-latest.jpg`);
  fs.writeFileSync(latestFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  let mutationCounter = 0;
  const { client } = await openClient(tempDir, dbPath, {
    TMPDIR: tmpDir,
  });
  try {
    await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-context-chronicle-legacy", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      screenshot_dir: tempDir,
    });

    const context = await callTool(client, "desktop.context", {
      action: "status",
      prefer_source: "chronicle",
      source_client: "test",
      source_agent: "codex-test",
    });
    assert.equal(context.status, "available");
    assert.equal(context.source, "chronicle");
    assert.equal(context.latest_frame_path, latestFrame);
    assert.equal(context.recorder_pid_path, path.join(recorderRoot, "chronicle-started.pid"));
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop.context falls back to logged desktop.observe screenshot when Chronicle is unavailable", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-context-fallback-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const tmpDir = path.join(tempDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath, {
    TMPDIR: tmpDir,
    MCP_DESKTOP_CONTROL_DRY_RUN: "1",
    MCP_DESKTOP_CONTROL_TEST_FRONTMOST: "Cursor|Agent Office",
  });
  try {
    await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-context-fallback", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      screenshot_dir: tempDir,
    });

    const context = await callTool(client, "desktop.context", {
      action: "latest",
      mutation: nextMutation("desktop-context-fallback", "desktop.context", () => mutationCounter++),
      filename: "fallback-context",
      source_client: "test",
      source_agent: "codex-test",
    });
    assert.equal(context.status, "degraded");
    assert.equal(context.source, "desktop_observe");
    assert.match(context.screenshot_path, /fallback-context\.png$/);
    assert.equal(context.screenshot.dry_run, true);
    assert.equal(context.screenshot.captured, false);
    assert.equal(context.unavailable_reason, "chronicle_recorder_not_running");
    assert.equal(typeof context.event_id, "string");
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop.context captures approved remote host Chronicle context with host attribution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-context-remote-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const sshPath = path.join(binDir, "ssh");
  fs.writeFileSync(
    sshPath,
    `#!/bin/sh
cat <<'JSON'
{"ok":true,"status":"available","source":"chronicle","generated_at":"2026-04-21T15:00:00.000Z","current_utc":"2026-04-21T15:00:00.000Z","freshness_seconds":1.25,"latest_frame_path":"/tmp/chronicle/screen_recording/remote-display-main-latest.jpg","displays":[{"display_id":"main","latest_frame_path":"/tmp/chronicle/screen_recording/remote-display-main-latest.jpg","freshness_seconds":1.25,"stale":false}],"ocr_hits":[{"display_id":"main","text_excerpt":"Remote Agent Office Hosts panel"}],"ocr_note":"OCR hits are noisy triage hints only; use app/file/connectors for authoritative extraction.","host":{"hostname":"Dans-MBP.local","repo_root":"/remote/master-mold"}}
JSON
`
  );
  fs.chmodSync(sshPath, 0o755);
  let mutationCounter = 0;
  const { client } = await openClient(tempDir, dbPath, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  try {
    await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-context-remote", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      screenshot_dir: tempDir,
    });
    await callTool(client, "worker.fabric", {
      action: "stage_remote_host",
      mutation: nextMutation("desktop-context-remote", "worker.fabric.stage", () => mutationCounter++),
      remote_host: {
        host_id: "dans-mbp",
        display_name: "Dan's MacBook Pro",
        hostname: "Dans-MBP.local",
        ip_address: "10.1.2.76",
        ssh_user: "dan.driver",
        workspace_root: "/remote/master-mold",
        agent_runtime: "claude",
        model_label: "Claude Opus",
        allowed_addresses: ["10.1.2.76"],
        capabilities: { desktop_context: true },
        approve: true,
      },
    });

    const context = await callTool(client, "desktop.context", {
      action: "latest",
      host_id: "dans-mbp",
      query: "Hosts panel",
      requesting_host_id: "local",
      requesting_remote_address: "127.0.0.1",
    });
    assert.equal(context.status, "available");
    assert.equal(context.source, "chronicle");
    assert.equal(context.captured_from_host_id, "dans-mbp");
    assert.equal(context.captured_hostname, "Dans-MBP.local");
    assert.equal(context.captured_agent_runtime, "claude");
    assert.equal(context.captured_model_label, "Claude Opus");
    assert.equal(context.requesting_host_id, "local");
    assert.equal(context.latest_frame_path, "/tmp/chronicle/screen_recording/remote-display-main-latest.jpg");
    assert.equal(context.ocr_hits.length, 1);

    const kernel = await callTool(client, "kernel.summary", {});
    const remoteHost = kernel.worker_fabric.hosts.find((host) => host.host_id === "dans-mbp");
    assert.equal(remoteHost.desktop_context.status, "available");
    assert.equal(remoteHost.desktop_context.source, "chronicle");
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop.context reports failed remote probes with a concrete unavailable reason", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-context-remote-failed-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const sshPath = path.join(binDir, "ssh");
  fs.writeFileSync(
    sshPath,
    `#!/bin/sh
printf '%s\\n' 'ssh: connect to host many-host.local port 22: Operation timed out' >&2
exit 255
`
  );
  fs.chmodSync(sshPath, 0o755);
  let mutationCounter = 0;
  const { client } = await openClient(tempDir, dbPath, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  try {
    await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-context-remote-failed", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      screenshot_dir: tempDir,
    });
    await callTool(client, "worker.fabric", {
      action: "stage_remote_host",
      mutation: nextMutation("desktop-context-remote-failed", "worker.fabric.stage", () => mutationCounter++),
      remote_host: {
        host_id: "many-host",
        hostname: "ManyHost.local",
        ssh_destination: "dan.driver@ManyHost.local",
        workspace_root: "/remote/master-mold",
        agent_runtime: "claude",
        model_label: "Claude Opus",
        capabilities: { desktop_context: true },
        approve: true,
      },
    });

    const context = await callTool(client, "desktop.context", {
      action: "latest",
      host_id: "many-host",
      fallback_screenshot: false,
    });
    assert.equal(context.ok, false);
    assert.equal(context.status, "unavailable");
    assert.equal(context.unavailable_reason, "remote_context_probe_failed");
    assert.equal(context.captured_from_host_id, "many-host");
    assert.equal(context.captured_hostname, "ManyHost.local");
    assert.equal(context.captured_agent_runtime, "claude");

    const kernel = await callTool(client, "kernel.summary", {});
    const remoteHost = kernel.worker_fabric.hosts.find((host) => host.host_id === "many-host");
    assert.equal(remoteHost.desktop_context.unavailable_reason, "remote_context_probe_failed");
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop.context ingests approved remote screenshot fallback without local proof pollution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-desktop-context-remote-shot-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const sshPath = path.join(binDir, "ssh");
  fs.writeFileSync(
    sshPath,
    `#!/bin/sh
case "$*" in
  *"--action=screenshot"*)
    printf '%s\\n' '{"ok":true,"status":"available","source":"desktop_observe","generated_at":"2026-04-21T15:10:00.000Z","current_utc":"2026-04-21T15:10:00.000Z","screenshot_path":"/tmp/remote-context.png","screenshot_base64":"UE5H","screenshot":{"dry_run":false,"captured":true,"path":"/tmp/remote-context.png","size_bytes":3},"host":{"hostname":"ManyHost.local"}}'
    ;;
  *)
    printf '%s\\n' '{"ok":false,"status":"unavailable","source":"none","generated_at":"2026-04-21T15:09:59.000Z","current_utc":"2026-04-21T15:09:59.000Z","displays":[],"unavailable_reason":"chronicle_recorder_not_running","host":{"hostname":"ManyHost.local"}}'
    ;;
esac
`
  );
  fs.chmodSync(sshPath, 0o755);
  let mutationCounter = 0;
  const { client } = await openClient(tempDir, dbPath, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  try {
    await callTool(client, "desktop.control", {
      action: "set",
      mutation: nextMutation("desktop-context-remote-shot", "desktop.control.set", () => mutationCounter++),
      enabled: true,
      allow_observe: true,
      screenshot_dir: tempDir,
    });
    await callTool(client, "worker.fabric", {
      action: "stage_remote_host",
      mutation: nextMutation("desktop-context-remote-shot", "worker.fabric.stage", () => mutationCounter++),
      remote_host: {
        host_id: "many-host",
        hostname: "ManyHost.local",
        ssh_destination: "dan.driver@ManyHost.local",
        workspace_root: "/remote/master-mold",
        capabilities: { desktop_context: true },
        approve: true,
      },
    });
    const before = await callTool(client, "desktop.control", {});
    assert.equal(before.state.last_screenshot_at, null);

    const context = await callTool(client, "desktop.context", {
      action: "latest",
      host_id: "many-host",
      mutation: nextMutation("desktop-context-remote-shot", "desktop.context", () => mutationCounter++),
      filename: "many-host-context",
    });
    assert.equal(context.status, "available");
    assert.equal(context.source, "desktop_observe");
    assert.equal(context.captured_from_host_id, "many-host");
    assert.equal(context.screenshot.captured, true);
    assert.match(context.screenshot_path, /many-host-context\.png$/);
    assert.equal(fs.readFileSync(context.screenshot_path, "utf8"), "PNG");

    const after = await callTool(client, "desktop.control", {});
    assert.equal(after.state.last_screenshot_at, null);
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
