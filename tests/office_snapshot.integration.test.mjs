import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    assert.equal(typeof snapshot.provider_bridge.snapshot.canonical_ingress_tool, "string");
    assert.ok(Array.isArray(snapshot.provider_bridge.diagnostics.diagnostics));
    assert.equal(snapshot.provider_bridge.diagnostics.cached, true);
    assert.equal(Array.isArray(snapshot.errors), true);
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
  return client;
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
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
