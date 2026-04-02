import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("observability ingest, search, dashboard, and kernel summary are wired end to end", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-observability-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const ingested = await callTool(session.client, "observability.ingest", {
      mutation: nextMutation("observability", "ingest", () => mutationCounter++),
      index_name: "logs-autonomy",
      source_kind: "integration.test",
      source_ref: "observability-roundtrip",
      mirror_runtime_events: true,
      documents: [
        {
          level: "critical",
          service: "autonomy.maintain",
          host_id: "local",
          event_type: "maintain.stale",
          title: "autonomy maintain stale",
          body_text: "background autonomy maintenance went stale during integration smoke",
          tags: ["autonomy", "critical"],
          attributes: {
            test: true,
          },
        },
        {
          level: "info",
          service: "worker.fabric",
          host_id: "local",
          event_type: "fabric.refresh",
          title: "worker fabric refreshed",
          body_text: "worker fabric refresh completed successfully",
          tags: ["fabric"],
        },
      ],
    });
    assert.equal(ingested.document_count, 2);
    assert.equal(ingested.mirrored_event_count, 1);

    const search = await callTool(session.client, "observability.search", {
      query: "stale autonomy",
      levels: ["critical", "error", "warn"],
      include_runtime_events: true,
      limit: 10,
    });
    assert.equal(search.count >= 1, true);
    assert.equal(search.documents[0].document.service, "autonomy.maintain");
    assert.equal(search.runtime_event_count >= 1, true);

    const dashboard = await callTool(session.client, "observability.dashboard", {
      recent_limit: 5,
      critical_window_minutes: 30,
    });
    assert.equal(dashboard.overview.count >= 2, true);
    assert.equal(dashboard.recent_critical_count >= 1, true);
    assert.equal(dashboard.top_services.some((entry) => entry.service === "autonomy.maintain"), true);

    const kernel = await callTool(session.client, "kernel.summary", {});
    assert.equal(kernel.observability.document_count >= 2, true);
    assert.equal(kernel.observability.recent_critical_count >= 1, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("observability ship supports runtime events, local host telemetry, and file logs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-observability-ship-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const logPath = path.join(tempDir, "agent.log");
  fs.writeFileSync(logPath, ["boot ok", "queue drained", "panic avoided"].join("\n"), "utf8");
  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "event.publish", {
      mutation: nextMutation("observability-ship", "event.publish", () => mutationCounter++),
      event_type: "runtime.ship.smoke",
      summary: "runtime ship smoke event",
      status: "ok",
      details: { source: "test" },
    });

    await callTool(session.client, "task.create", {
      mutation: nextMutation("observability-ship", "task.create", () => mutationCounter++),
      objective: "Verify ELK-style task shipping path",
      priority: 75,
      tags: ["observability", "taskbeat"],
      metadata: { scope: "integration" },
    });

    await callTool(session.client, "trichat.thread_open", {
      mutation: nextMutation("observability-ship", "thread.open", () => mutationCounter++),
      thread_id: "observability-ship-thread",
      title: "Observability Ship Thread",
      status: "active",
    });

    await callTool(session.client, "trichat.message_post", {
      mutation: nextMutation("observability-ship", "message.post", () => mutationCounter++),
      thread_id: "observability-ship-thread",
      agent_id: "ring-leader",
      role: "system",
      content: "Observability ship thread message",
    });

    const runBegin = await callTool(session.client, "run.begin", {
      mutation: nextMutation("observability-ship", "run.begin", () => mutationCounter++),
      summary: "Observability shipping run",
    });
    await callTool(session.client, "run.step", {
      mutation: nextMutation("observability-ship", "run.step", () => mutationCounter++),
      run_id: runBegin.run_id,
      step_index: 1,
      status: "completed",
      summary: "run step complete",
    });
    await callTool(session.client, "run.end", {
      mutation: nextMutation("observability-ship", "run.end", () => mutationCounter++),
      run_id: runBegin.run_id,
      status: "succeeded",
      summary: "run finished",
    });

    const incident = await callTool(session.client, "incident.open", {
      mutation: nextMutation("observability-ship", "incident.open", () => mutationCounter++),
      severity: "P2",
      title: "Observability shipping incident",
      summary: "control plane warning for incident shipping",
      tags: ["observability"],
    });

    const runtimeShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "runtime", () => mutationCounter++),
      source: "runtime_events",
      limit: 20,
    });
    assert.equal(runtimeShip.document_count >= 1, true);

    const hostShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "local-host", () => mutationCounter++),
      source: "local_host",
    });
    assert.equal(hostShip.document_count, 1);

    const fileShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "file", () => mutationCounter++),
      source: "file",
      file_path: logPath,
      tail_lines: 5,
      level: "info",
      service: "agent.log",
    });
    assert.equal(fileShip.document_count, 3);

    const taskShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "task-queue", () => mutationCounter++),
      source: "task_queue",
      limit: 20,
    });
    assert.equal(taskShip.document_count >= 1, true);

    const queuedTaskId = taskShip.documents?.[0]?.attributes?.task_id ?? null;
    assert.equal(typeof queuedTaskId, "string");

    const taskTimelineShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "task-timeline", () => mutationCounter++),
      source: "task_timeline",
      task_id: queuedTaskId,
      limit: 20,
    });
    assert.equal(taskTimelineShip.document_count >= 1, true);

    const trichatShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "trichat-bus", () => mutationCounter++),
      source: "trichat_bus",
      thread_id: "observability-ship-thread",
      limit: 20,
    });
    assert.equal(trichatShip.document_count >= 1, true);

    const runTimelineShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "run-timeline", () => mutationCounter++),
      source: "run_timeline",
      run_id: runBegin.run_id,
      limit: 20,
    });
    assert.equal(runTimelineShip.document_count >= 3, true);

    const incidentTimelineShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "incident-timeline", () => mutationCounter++),
      source: "incident_timeline",
      incident_id: incident.incident_id,
      limit: 20,
    });
    assert.equal(incidentTimelineShip.document_count >= 1, true);

    const trichatSummaryShip = await callTool(session.client, "observability.ship", {
      mutation: nextMutation("observability-ship", "trichat-summary", () => mutationCounter++),
      source: "trichat_summary",
      limit: 6,
    });
    assert.equal(trichatSummaryShip.document_count >= 1, true);

    const search = await callTool(session.client, "observability.search", {
      query: "panic avoided",
      limit: 10,
    });
    assert.equal(search.count >= 1, true);
    assert.equal(search.documents.some((entry) => entry.document.service === "agent.log"), true);

    const taskSearch = await callTool(session.client, "observability.search", {
      query: "Verify ELK-style task shipping path",
      service: "task.queue",
      limit: 10,
    });
    assert.equal(taskSearch.count >= 1, true);

    const taskTimelineSearch = await callTool(session.client, "observability.search", {
      query: "Verify ELK-style task shipping path",
      service: "task.timeline",
      limit: 10,
    });
    assert.equal(taskTimelineSearch.count >= 1, true);

    const trichatSearch = await callTool(session.client, "observability.search", {
      query: "Observability ship thread message",
      service: "trichat.bus",
      limit: 10,
    });
    assert.equal(trichatSearch.count >= 1, true);

    const runSearch = await callTool(session.client, "observability.search", {
      query: "run step complete",
      service: "run.timeline",
      limit: 10,
    });
    assert.equal(runSearch.count >= 1, true);

    const incidentSearch = await callTool(session.client, "observability.search", {
      query: "Observability shipping incident",
      service: "incident.timeline",
      limit: 10,
    });
    assert.equal(incidentSearch.count >= 1, true);

    const trichatSummarySearch = await callTool(session.client, "observability.search", {
      query: "TriChat threads=",
      service: "trichat.summary",
      limit: 10,
    });
    assert.equal(trichatSummarySearch.count >= 1, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("worker fabric status exposes the persisted local capacity guidance after autonomy maintain refresh", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-observability-capacity-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_AUTOPILOT_THREAD_ID: "capacity-check",
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("observability-capacity", "ensure", () => mutationCounter++),
      autostart_ring_leader: false,
      run_immediately: false,
    });

    const staleHeartbeat = "2000-01-01T00:00:00.000Z";
    await callTool(session.client, "worker.fabric", {
      action: "heartbeat",
      mutation: nextMutation("observability-capacity", "worker-fabric-stale", () => mutationCounter++),
      host_id: "local",
      telemetry: {
        heartbeat_at: staleHeartbeat,
        health_state: "degraded",
        cpu_utilization: 0.99,
        ram_available_gb: 1,
        ram_total_gb: 48,
        swap_used_gb: 12,
        thermal_pressure: "serious",
      },
    });

    const bootstrapStatus = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      local_host_id: "local",
      autostart_ring_leader: false,
    });
    assert.equal(bootstrapStatus.worker_fabric.persisted_local_telemetry.heartbeat_at, staleHeartbeat);
    assert.notEqual(bootstrapStatus.worker_fabric.effective_local_telemetry.heartbeat_at, staleHeartbeat);

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("observability-capacity", "maintain", () => mutationCounter++),
      local_host_id: "local",
      publish_runtime_event: false,
      run_eval_if_due: false,
      refresh_learning_summary: false,
      run_goal_hygiene: false,
      run_task_recovery: false,
    });
    const fabric = await callTool(session.client, "worker.fabric", {
      action: "status",
      fallback_workspace_root: REPO_ROOT,
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    });
    const localHost = fabric.hosts_summary.find((entry) => entry.host_id === "local");
    const localHostState = fabric.state.hosts.find((entry) => entry.host_id === "local");
    const localExecutionProfile = localHostState?.metadata?.local_execution_profile ?? {};
    assert.ok(localHost);
    assert.ok(localHostState);
    assert.notEqual(localHost.telemetry.heartbeat_at, staleHeartbeat);
    assert.equal(localHost.recommended_worker_count, localExecutionProfile.safe_worker_count);
    assert.equal(localHost.max_local_model_concurrency, localExecutionProfile.max_local_model_concurrency);
    assert.equal(localHost.recommended_runtime_worker_limit, localExecutionProfile.runtime_worker_limit);
    assert.equal(localHost.recommended_runtime_worker_max_active, localExecutionProfile.runtime_worker_max_active);
    assert.equal(localHost.recommended_tmux_worker_count, localExecutionProfile.tmux_recommended_worker_count);
    assert.equal(localHost.recommended_tmux_target_queue_per_worker, localExecutionProfile.tmux_target_queue_per_worker);
    assert.ok(maintain.status.local_capacity.safe_worker_count >= 1);
    assert.ok(maintain.status.local_capacity.max_local_model_concurrency >= 1);
  } finally {
    await session.client.close().catch(() => {});
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
  const client = new Client(
    { name: "mcp-observability-test", version: "0.1.0" },
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
