import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";

const REPO_ROOT = process.cwd();

test("office.snapshot returns a storage-backed GUI payload without depending on slow fanout tools", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-snapshot-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const client = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(client, "task.create", {
      mutation: nextMutation("office-snapshot", "task.create", () => mutationCounter++),
      objective: "Pending GUI snapshot task",
      priority: 50,
      tags: ["office"],
    });

    await callTool(client, "agent.session_open", {
      mutation: nextMutation("office-snapshot", "agent.session_open", () => mutationCounter++),
      agent_id: "ring-leader",
      client_kind: "trichat-autopilot",
      display_name: "ring-leader office runtime",
      status: "busy",
      metadata: {
        thread_id: "ring-leader-main",
        current_task_id: "task-current",
      },
    });

    await callTool(client, "autonomy.maintain", {
      action: "run_once",
      fast: true,
      publish_runtime_event: false,
      run_eval_if_due: false,
      run_optimizer_if_due: false,
      mutation: nextMutation("office-snapshot", "autonomy.maintain", () => mutationCounter++),
    });

    await callTool(client, "trichat.autopilot", {
      action: "start",
      mutation: nextMutation("office-snapshot", "trichat.autopilot", () => mutationCounter++),
      thread_id: "ring-leader-main",
      thread_title: "Ring Leader Main Loop",
      thread_status: "active",
      objective: "Validate office snapshot autopilot visibility",
      lead_agent_id: "ring-leader",
      specialist_agent_ids: ["implementation-director", "research-director", "verification-director"],
      execute_enabled: true,
      execute_backend: "tmux",
      bridge_dry_run: true,
      max_rounds: 1,
      min_success_agents: 1,
      confidence_threshold: 0.1,
      run_immediately: false,
    });

    const snapshot = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
    });
    const fabric = await callTool(client, "worker.fabric", {
      action: "status",
      fallback_workspace_root: REPO_ROOT,
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    });
    const runtimeWorkers = await callTool(client, "runtime.worker", {
      action: "status",
      limit: 20,
    });

    assert.equal(snapshot.source, "office.snapshot");
    assert.ok(Array.isArray(snapshot.roster.agents));
    assert.ok(snapshot.roster.agents.length >= 1);
    assert.ok(snapshot.roster.active_agent_ids.includes("ring-leader"));
    assert.equal(snapshot.task_summary.counts.pending, 1);
    assert.ok(snapshot.agent_sessions.count >= 1);
    assert.equal(snapshot.tmux.action, "status_cached");
    assert.equal(typeof snapshot.kernel.state, "string");
    assert.equal(snapshot.kernel.worker_fabric.host_count, fabric.state.hosts.length);
    assert.equal(snapshot.kernel.worker_fabric.enabled_host_count, fabric.hosts_summary.filter((entry) => entry.enabled).length);
    assert.equal(snapshot.runtime_workers.summary.session_count, runtimeWorkers.summary.session_count);
    assert.equal(snapshot.runtime_workers.summary.active_count, runtimeWorkers.summary.active_count);
    assert.equal(snapshot.operator_brief.source, "operator.brief");
    assert.equal(snapshot.operator_brief.compact, true);
    assert.equal(snapshot.operator_brief.kernel, null);
    assert.equal(typeof snapshot.operator_brief.brief_markdown, "string");
    assert.ok(snapshot.operator_brief.brief_markdown.includes("# Operator Brief"));
    assert.equal(typeof snapshot.workbench.focus_area, "string");
    assert.equal(typeof snapshot.workbench.status, "string");
    assert.equal(typeof snapshot.workbench.headline, "string");
    assert.equal(Array.isArray(snapshot.workbench.blockers), true);
    assert.equal(Array.isArray(snapshot.workbench.next_actions), true);
    assert.equal(Array.isArray(snapshot.workbench.suggested_objectives), true);
    assert.equal(typeof snapshot.workbench.queue.pending, "number");
    assert.equal(typeof snapshot.provider_bridge.snapshot.canonical_ingress_tool, "string");
    assert.ok(Array.isArray(snapshot.provider_bridge.diagnostics.diagnostics));
    assert.equal(typeof snapshot.provider_bridge.diagnostics.cached, "boolean");
    assert.equal(typeof snapshot.provider_bridge.diagnostics.stale, "boolean");
    assert.equal(snapshot.provider_bridge.onboarding.recommended_doctor_command, "npm run bootstrap:env:check");
    assert.equal(Array.isArray(snapshot.provider_bridge.onboarding.entries), true);
    assert.equal(snapshot.setup_diagnostics.source, "office.snapshot");
    assert.equal(typeof snapshot.setup_diagnostics.provider_bridge.stale, "boolean");
    assert.equal(Array.isArray(snapshot.setup_diagnostics.next_actions), true);
    assert.equal(typeof snapshot.kernel.setup_diagnostics.bootstrap.self_start_ready, "boolean");
    assert.equal(snapshot.setup_diagnostics.launchers.office_gui.supported, true);
    assert.equal(snapshot.setup_diagnostics.launchers.agentic_suite.supported, true);
    assert.equal(typeof snapshot.setup_diagnostics.launchers.agentic_suite.reassurance_surface, "string");
    assert.equal(typeof snapshot.setup_diagnostics.platform.distribution === "string" || snapshot.setup_diagnostics.platform.distribution === null, true);
    assert.equal(snapshot.autopilot.state.running, true);
    assert.equal(snapshot.autopilot.state.config.execute_enabled, true);
    for (const agentId of ["implementation-director", "research-director", "verification-director"]) {
      assert.ok(snapshot.autopilot.state.effective_agent_pool.specialist_agent_ids.includes(agentId));
    }
    assert.ok(snapshot.roster.active_agent_ids.includes("implementation-director"));
    await callTool(client, "trichat.autopilot", {
      action: "stop",
      mutation: nextMutation("office-snapshot", "trichat.autopilot.stop", () => mutationCounter++),
    });
    assert.equal(Array.isArray(snapshot.errors), true);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office.snapshot reuses the warm office cache for dashboard-style direct reads", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-snapshot-live-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const client = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(client, "warm.cache", {
      action: "run_once",
      thread_id: "ring-leader-main",
      mutation: nextMutation("office-snapshot-live", "warm.cache.run_once", () => mutationCounter++),
    });

    await callTool(client, "task.create", {
      mutation: nextMutation("office-snapshot-live", "task.create", () => mutationCounter++),
      objective: "Task created after the warm office snapshot",
      priority: 75,
      tags: ["office-live"],
    });

    const cached = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
    });
    const live = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
      metadata: { source: "dashboard.direct" },
    });
    const raw = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
      metadata: { source: "http.raw" },
    });

    assert.equal(cached.cache.hit, true);
    assert.equal(live.cache.hit, true);
    assert.equal(raw.cache.hit, true);
    assert.equal(live.task_summary.counts.pending, 0);
    assert.equal(raw.task_summary.counts.pending, 0);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office.snapshot keeps the Office GUI launcher ready when Patient Zero browser automation is degraded", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-snapshot-office-gui-launcher-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const client = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("office-snapshot-office-gui-launcher", "autonomy.bootstrap.ensure", () => mutationCounter++),
      autostart_ring_leader: false,
      run_immediately: false,
    });

    const storage = new Storage(dbPath);
    storage.setDesktopControlState({
      enabled: true,
      allow_observe: true,
      allow_act: true,
      allow_listen: true,
      capability_probe: {
        can_observe: true,
        can_act: false,
        can_listen: true,
      },
    });
    storage.setPatientZeroState({
      enabled: true,
      autonomy_enabled: true,
      allow_observe: true,
      allow_act: true,
      allow_listen: true,
      browser_app: "Safari",
      root_shell_reason: "office.snapshot test",
      audit_required: true,
    });

    const snapshot = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
      metadata: { source: "dashboard.direct" },
    });

    assert.equal(snapshot.setup_diagnostics.patient_zero.browser_ready, false);
    assert.equal(snapshot.setup_diagnostics.fallback.browser_degraded, true);
    assert.equal(snapshot.setup_diagnostics.launchers.office_gui.ready, true);
    assert.equal(snapshot.setup_diagnostics.launchers.office_gui.degraded, false);
    assert.equal(snapshot.setup_diagnostics.launchers.office_gui.reassurance_surface, "browser-status");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office.snapshot direct reads stay storage-backed when persisted provider bridge diagnostics are stale", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-snapshot-stale-provider-bridge-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const staleGeneratedAt = new Date(Date.now() - 400_000).toISOString();

  const client = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const storage = new Storage(dbPath);
    storage.setAutonomyMaintainState({
      enabled: true,
      local_host_id: "local",
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
      last_provider_bridge_check_at: staleGeneratedAt,
      provider_bridge_diagnostics: [
        {
          client_id: "gemini-cli",
          display_name: "Gemini CLI",
          office_agent_id: "gemini",
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: "persisted stale bridge sentinel",
          notes: [],
          command: "sentinel",
          config_path: "/tmp/persisted-stale-bridge.json",
        },
      ],
      last_actions: [],
      last_attention: [],
      last_error: null,
    });

    const snapshot = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
      metadata: { source: "dashboard.direct" },
    });

    assert.equal(snapshot.cache.hit, true);
    assert.equal(snapshot.provider_bridge.diagnostics.stale, true);
    assert.equal(snapshot.provider_bridge.diagnostics.generated_at, staleGeneratedAt);
    assert.equal(snapshot.provider_bridge.diagnostics.diagnostics.length, 1);
    assert.equal(snapshot.provider_bridge.diagnostics.diagnostics[0].detail, "persisted stale bridge sentinel");
    assert.equal(snapshot.provider_bridge.onboarding.stale_runtime_checks, true);
    assert.equal(snapshot.setup_diagnostics.provider_bridge.stale, true);
    assert.equal(typeof snapshot.setup_diagnostics.fallback.provider_bridge_degraded, "boolean");
    assert.ok(snapshot.setup_diagnostics.next_actions.some((entry) => entry.includes("npm run bootstrap:env")));
    assert.equal(typeof snapshot.setup_diagnostics.launchers.agentic_suite.ready, "boolean");
    assert.equal(snapshot.roster.active_agent_ids.includes("gemini"), false);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office.snapshot warm cache overlays the latest persisted provider bridge state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-snapshot-provider-bridge-overlay-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const client = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
    });

    const storage = new Storage(dbPath);
    const refreshedAt = new Date().toISOString();
    storage.setAutonomyMaintainState({
      enabled: true,
      local_host_id: "local",
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
      last_provider_bridge_check_at: refreshedAt,
      provider_bridge_diagnostics: [
        {
          client_id: "gemini-cli",
          display_name: "Gemini CLI",
          office_agent_id: "gemini",
          available: true,
          runtime_probed: true,
          connected: false,
          status: "configured",
          detail: "persisted provider bridge refresh",
          notes: [],
          command: "sentinel",
          config_path: "/tmp/provider-bridge-refresh.json",
        },
      ],
      last_actions: [],
      last_attention: [],
      last_error: null,
    });

    const snapshot = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
      metadata: { source: "dashboard.direct" },
    });

    assert.equal(snapshot.cache.hit, true);
    assert.equal(snapshot.provider_bridge.diagnostics.generated_at, refreshedAt);
    assert.equal(snapshot.provider_bridge.diagnostics.diagnostics.length, 1);
    assert.equal(snapshot.provider_bridge.diagnostics.diagnostics[0].status, "configured");
    assert.equal(snapshot.provider_bridge.diagnostics.diagnostics[0].detail, "persisted provider bridge refresh");
    assert.equal(snapshot.autonomy_maintain.state.last_provider_bridge_check_at, refreshedAt);
    assert.equal(snapshot.roster.active_agent_ids.includes("gemini"), false);
    const geminiBridge = snapshot.provider_bridge.snapshot.outbound_council_agents.find((entry) => entry.client_id === "gemini-cli");
    assert.equal(geminiBridge?.runtime_ready, false);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office.snapshot direct reads demote warmed provider agents when bridge diagnostics go stale", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-snapshot-provider-bridge-cached-stale-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const client = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const storage = new Storage(dbPath);
    storage.setAutonomyMaintainState({
      enabled: true,
      local_host_id: "local",
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
      last_provider_bridge_check_at: new Date().toISOString(),
      provider_bridge_diagnostics: [
        {
          client_id: "gemini-cli",
          display_name: "Gemini CLI",
          office_agent_id: "gemini",
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: "fresh connected bridge for warm cache",
          notes: [],
          command: "sentinel",
          config_path: "/tmp/provider-bridge-warm-cache.json",
        },
      ],
      last_actions: [],
      last_attention: [],
      last_error: null,
    });

    await callTool(client, "warm.cache", {
      action: "run_once",
      thread_id: "ring-leader-main",
      mutation: nextMutation("office-snapshot-provider-bridge-cached-stale", "warm.cache.run_once", () => mutationCounter++),
    });

    const staleGeneratedAt = new Date(Date.now() - 400_000).toISOString();
    storage.setAutonomyMaintainState({
      enabled: true,
      local_host_id: "local",
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
      last_provider_bridge_check_at: staleGeneratedAt,
      provider_bridge_diagnostics: [
        {
          client_id: "gemini-cli",
          display_name: "Gemini CLI",
          office_agent_id: "gemini",
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: "persisted stale connected bridge",
          notes: [],
          command: "sentinel",
          config_path: "/tmp/provider-bridge-cached-stale.json",
        },
      ],
      last_actions: [],
      last_attention: [],
      last_error: null,
    });

    const snapshot = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
      metadata: { source: "dashboard.direct" },
    });

    assert.equal(snapshot.cache.hit, true);
    assert.equal(snapshot.provider_bridge.diagnostics.stale, true);
    assert.equal(snapshot.roster.active_agent_ids.includes("gemini"), false);
    const geminiBridge = snapshot.provider_bridge.snapshot.outbound_council_agents.find((entry) => entry.client_id === "gemini-cli");
    assert.equal(geminiBridge?.runtime_ready, false);
    assert.ok(snapshot.setup_diagnostics.next_actions.some((entry) => entry.includes("npm run bootstrap:env")));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-office-snapshot-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return client;
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
