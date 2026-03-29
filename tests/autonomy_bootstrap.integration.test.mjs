import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("autonomy.bootstrap seeds a cold control plane and starts a self-starting ring leader without fake router scores", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-bootstrap-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const before = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
    });
    assert.equal(before.self_start_ready, false);
    assert.ok(before.repairs_needed.includes("worker.fabric.local_host_missing"));
    assert.ok(before.repairs_needed.includes("model.router.local_backend_missing"));

    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-bootstrap", "ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });

    assert.equal(ensured.ok, true);
    assert.equal(ensured.status.self_start_ready, true);
    assert.equal(ensured.status.worker_fabric.host_present, true);
    assert.equal(ensured.status.model_router.backend_present, true);
    assert.equal(ensured.status.org_programs.ready, true);
    assert.equal(ensured.status.benchmark_suites.ready, true);
    assert.equal(ensured.status.eval_suites.ready, true);
    assert.equal(ensured.status.ring_leader.running, true);

    const router = await callTool(session.client, "model.router", { action: "status" });
    const backend = router.state.backends.find((entry) => entry.backend_id === "ollama-llama3-2-3b");
    assert.ok(backend);
    assert.equal(backend.provider, "ollama");
    assert.equal(backend.success_rate, null);
    assert.equal(backend.win_rate, null);
    assert.equal(backend.latency_ms_p50, null);
    assert.equal(backend.throughput_tps, null);

    const workerFabric = await callTool(session.client, "worker.fabric", {
      action: "status",
      fallback_workspace_root: tempDir,
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    });
    const localHost = workerFabric.state.hosts.find((entry) => entry.host_id === "local");
    assert.ok(localHost);
    assert.equal(localHost.telemetry.health_state, "healthy");
    assert.equal(typeof localHost.telemetry.heartbeat_at, "string");

    const after = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
    });
    assert.equal(after.self_start_ready, true);
    assert.deepEqual(after.repairs_needed, []);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a cold control plane can take a single command from intake to durable autonomous execution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-intake-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const before = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
    });
    assert.equal(before.self_start_ready, false);

    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-intake", "autonomy.bootstrap.ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });

    assert.equal(ensured.ok, true);
    assert.equal(ensured.status.self_start_ready, true);
    assert.equal(ensured.status.worker_fabric.host_present, true);
    assert.equal(ensured.status.model_router.backend_present, true);
    assert.equal(ensured.status.org_programs.ready, true);
    assert.equal(ensured.status.benchmark_suites.ready, true);
    assert.equal(ensured.status.eval_suites.ready, true);
    assert.equal(ensured.status.ring_leader.running, true);

    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("autonomy-intake", "goal.create", () => mutationCounter++),
      title: "Single-command autonomy intake",
      objective: "Research, implement, and verify a single-command autonomy intake path that runs start to finish",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: [
        "The command is compiled into durable workstreams",
        "The compiled plan is selected and dispatched",
        "The first runnable slice is observable in the task queue",
      ],
      tags: ["autonomy", "intake", "single-command"],
      metadata: {
        intake_surface: "single-command",
        desired_behavior: "durable autonomous execution",
      },
    });

    const executed = await callTool(session.client, "goal.execute", {
      mutation: nextMutation("autonomy-intake", "goal.execute", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      autorun: true,
      max_passes: 4,
      dispatch_limit: 10,
    });

    assert.equal(executed.ok, true);
    assert.equal(executed.executed, true);
    assert.equal(executed.created_plan, true);
    assert.equal(executed.plan_resolution, "generated");
    assert.equal(executed.dispatch_mode, "autorun");
    assert.equal(executed.goal.active_plan_id, executed.plan.plan_id);
    assert.ok(executed.execution_summary.completed_count >= 1);
    assert.ok(executed.execution_summary.running_count >= 1);

    const plan = await callTool(session.client, "plan.get", {
      plan_id: executed.plan.plan_id,
    });
    assert.equal(plan.plan.selected, true);
    assert.equal(plan.plan.metadata.planner_hook.hook_id, "agentic.delivery_path");

    const runningStep = plan.steps.find((step) => step.status === "running");
    assert.ok(runningStep);
    assert.equal(typeof runningStep.task_id, "string");

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 20,
    });
    const runningTask = pendingTasks.tasks.find((task) => task.task_id === runningStep.task_id);
    assert.ok(runningTask);
    assert.equal(runningTask.task_id, runningStep.task_id);
    assert.ok(runningTask.objective.includes(goal.goal.objective));

    const goalState = await callTool(session.client, "goal.get", {
      goal_id: goal.goal.goal_id,
    });
    assert.equal(goalState.goal.active_plan_id, executed.plan.plan_id);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain keeps the control plane ready and refreshes bounded eval health in the background", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const maintained = await callTool(session.client, "autonomy.maintain", {
      action: "run",
      mutation: nextMutation("autonomy-maintain", "autonomy.maintain.run", () => mutationCounter++),
      local_host_id: "local",
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      interval_seconds: 120,
      learning_review_interval_seconds: 60,
      eval_interval_seconds: 300,
      minimum_eval_score: 0,
    });

    assert.equal(maintained.ok, true);
    assert.ok(Array.isArray(maintained.actions));
    assert.ok(maintained.actions.includes("autonomy.bootstrap.ensure"));
    assert.ok(maintained.actions.includes("agent.learning_summary"));
    assert.equal(maintained.status.bootstrap.self_start_ready, true);
    assert.equal(maintained.status.goal_autorun_daemon.running, true);
    assert.equal(maintained.status.state.enabled, true);
    assert.equal(typeof maintained.status.state.last_run_at, "string");
    assert.equal(typeof maintained.status.state.last_learning_review_at, "string");
    assert.equal(maintained.eval.executed, true);
    assert.equal(typeof maintained.eval.run_id, "string");
    assert.equal(typeof maintained.eval.aggregate_metric_value, "number");

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    });
    assert.equal(kernel.autonomy_maintain.enabled, true);
    assert.equal(kernel.autonomy_maintain.stale, false);
    assert.equal(kernel.autonomy_maintain.eval_due, false);
    assert.equal(typeof kernel.autonomy_maintain.last_run_at, "string");
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-autonomy-bootstrap-test", version: "0.1.0" },
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

async function callTool(client, name, args) {
  const result = await client.callTool({
    name,
    arguments: args,
  });
  const first = result.content?.[0];
  assert.equal(first?.type, "text");
  return JSON.parse(first.text);
}

function nextMutation(testId, label, nextCounter) {
  const counter = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${counter}`,
    side_effect_fingerprint: `${testId}:${label}:${counter}`,
  };
}
