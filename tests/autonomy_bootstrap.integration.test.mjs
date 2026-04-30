import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";
import {
  computeEvalDependencyFingerprint,
  isTransientModelRouterResidencyAttention,
} from "../dist/tools/autonomy_maintain.js";

const REPO_ROOT = process.cwd();

test("autonomy.maintain treats model residency churn as telemetry, not self-drive repair debt", () => {
  assert.equal(
    isTransientModelRouterResidencyAttention("model.router.ollama-qwen3-5-35b-a3b-coding-nvfp4.prewarm_failed"),
    true
  );
  assert.equal(isTransientModelRouterResidencyAttention("model.router.local-qwen.unload_failed"), true);
  assert.equal(isTransientModelRouterResidencyAttention("model.router.local-qwen.probe_failed"), false);
  assert.equal(isTransientModelRouterResidencyAttention("reaction.engine.not_running"), false);
});

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
    assert.equal(ensured.status.cluster_topology.ready, true);
    assert.equal(ensured.status.cluster_topology.node_count, 5);
    assert.equal(ensured.status.model_router.backend_present, true);
    assert.equal(ensured.status.org_programs.ready, true);
    assert.equal(ensured.status.benchmark_suites.ready, true);
    assert.equal(ensured.status.eval_suites.ready, true);
    assert.equal(ensured.status.ring_leader.running, true);

    const benchmarkSuites = await callTool(session.client, "benchmark.suite_list", {});
    const smokeSuite = benchmarkSuites.suites.find((entry) => entry.suite_id === "autonomy.smoke.local");
    assert.ok(smokeSuite);
    assert.equal(
      smokeSuite.cases.find((entry) => entry.case_id === "storage-health").command,
      "NODE_BIN=\"${MASTER_MOLD_NODE_BIN:-node}\"; ([ -f dist/server.js ] || npm run build >/dev/null) && \"$NODE_BIN\" ./scripts/mcp_tool_call.mjs --tool health.storage --args '{}' --transport stdio --stdio-command \"$NODE_BIN\" --stdio-args 'dist/server.js' --cwd . >/dev/null"
    );
    assert.equal(
      smokeSuite.cases.find((entry) => entry.case_id === "roster-health").command,
      "NODE_BIN=\"${MASTER_MOLD_NODE_BIN:-node}\"; ([ -f dist/server.js ] || npm run build >/dev/null) && \"$NODE_BIN\" ./scripts/mcp_tool_call.mjs --tool trichat.roster --args '{}' --transport stdio --stdio-command \"$NODE_BIN\" --stdio-args 'dist/server.js' --cwd . >/dev/null"
    );
    assert.equal(smokeSuite.isolation_mode, "git_worktree");
    assert.equal(smokeSuite.metadata.cleanup_workspaces, true);

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
    assert.ok(["healthy", "degraded"].includes(localHost.telemetry.health_state));
    assert.equal(typeof localHost.telemetry.heartbeat_at, "string");
    assert.ok(localHost.worker_count >= 1);
    assert.ok(localHost.capabilities.safe_worker_count >= 1);
    assert.ok(localHost.capabilities.safe_max_queue_per_worker >= 1);
    assert.ok(localHost.capabilities.max_local_model_concurrency >= 1);
    assert.ok(localHost.capabilities.recommended_runtime_worker_max_active >= 1);
    assert.ok(localHost.capabilities.recommended_runtime_worker_limit >= 1);
    assert.ok(localHost.capabilities.recommended_tmux_worker_count >= 1);
    assert.ok(localHost.capabilities.recommended_tmux_target_queue_per_worker >= 1);

    const after = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
    });
    assert.equal(after.self_start_ready, true);
    assert.deepEqual(after.repairs_needed, []);
    const refreshedBackend = after.model_router.backend_ids.includes("ollama-llama3-2-3b");
    assert.equal(refreshedBackend, true);
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
    assert.equal(ensured.status.cluster_topology.ready, true);
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
    assert.ok((executed.execution_summary.running_count + executed.execution_summary.pending_count) >= 1);

    const plan = await callTool(session.client, "plan.get", {
      plan_id: executed.plan.plan_id,
    });
    assert.equal(plan.plan.selected, true);
    assert.equal(plan.plan.metadata.planner_hook.hook_id, "agentic.delivery_path");

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

test("autonomy.bootstrap seeds eligible provider-bridge backends into the model router without replacing the local default", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-bootstrap-provider-bridge-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    GOOGLE_API_KEY: "test-gemini-key",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-bootstrap-provider-bridge", "ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });

    assert.equal(ensured.ok, true);
    assert.equal(ensured.status.self_start_ready, true);
    assert.equal(ensured.status.cluster_topology.ready, true);

    const router = await callTool(session.client, "model.router", { action: "status" });
    assert.equal(router.state.default_backend_id, "ollama-llama3-2-3b");
    assert.ok(router.state.backends.some((entry) => entry.backend_id === "bridge-gemini-cli"));
    const geminiBackend = router.state.backends.find((entry) => entry.backend_id === "bridge-gemini-cli");
    assert.equal(geminiBackend.provider, "google");
    assert.equal(geminiBackend.metadata.bridge_agent_id, "gemini");
    assert.equal(geminiBackend.metadata.runtime_ready, true);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.bootstrap persists an integrated MLX adapter backend from the registration record", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-bootstrap-mlx-adapter-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const registrationPath = path.join(tempDir, "registered-adapter.json");
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });
  const mlxServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => mlxServer.listen(0, "127.0.0.1", resolve));
  const mlxAddress = mlxServer.address();
  assert.ok(mlxAddress && typeof mlxAddress !== "string");
  const mlxEndpoint = `http://127.0.0.1:${mlxAddress.port}`;
  fs.writeFileSync(
    registrationPath,
    `${JSON.stringify(
      {
        decision: {
          status: "registered",
          accepted: true,
          integration_consideration: {
            router: {
              planned_backend: {
                backend_id: "mlx-adapter-local-adapter-sample",
                provider: "mlx",
                model_id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
                tags: ["local", "mlx", "adapter", "candidate", "apple-silicon"],
                metadata: {
                  candidate_id: "local-adapter-sample",
                  adapter_path: "/tmp/adapter",
                  companion_for_runtime_model: "qwen3.5:35b-a3b-coding-nvfp4",
                  serving_status: "integrated",
                },
              },
            },
          },
        },
        integration_result: {
          status: "adapter_served_mlx",
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_MLX_SERVER_ENABLED: "1",
    TRICHAT_MLX_MODEL: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
    TRICHAT_MLX_ENDPOINT: mlxEndpoint,
    TRICHAT_MLX_PYTHON: "/tmp/python",
    TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH: registrationPath,
    TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER: "mlx",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-bootstrap-mlx-adapter", "ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });
    assert.equal(ensured.ok, true);

    const router = await callTool(session.client, "model.router", { action: "status" });
    const backend = router.state.backends.find((entry) => entry.backend_id === "mlx-adapter-local-adapter-sample");
    assert.ok(backend);
    assert.equal(backend.provider, "mlx");
    assert.ok(backend.tags.includes("adapter"));
    assert.equal(backend.metadata.candidate_id, "local-adapter-sample");
    assert.equal(backend.metadata.local_adapter_active_provider, "mlx");
    assert.equal(backend.metadata.local_adapter_integration_status, "adapter_served_mlx");
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    await new Promise((resolve, reject) => mlxServer.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.bootstrap keeps an existing local default when a later bootstrap pass only sees remote bridge backends", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-bootstrap-sticky-local-default-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    GOOGLE_API_KEY: "test-gemini-key",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const initialEnsure = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-bootstrap-sticky-local-default", "ensure-initial", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });
    assert.equal(initialEnsure.ok, true);

    const remoteOnlyEnsure = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-bootstrap-sticky-local-default", "ensure-remote-only", () => mutationCounter++),
      autostart_ring_leader: true,
      run_immediately: false,
      backend_overrides: [
        {
          backend_id: "bridge-codex",
          provider: "openai",
          model_id: "codex",
          locality: "remote",
          tags: ["remote", "frontier"],
        },
        {
          backend_id: "bridge-gemini-cli",
          provider: "google",
          model_id: "gemini-2.0-flash",
          locality: "remote",
          tags: ["remote", "frontier"],
        },
      ],
    });

    assert.equal(remoteOnlyEnsure.ok, true);

    const router = await callTool(session.client, "model.router", { action: "status" });
    assert.equal(router.state.default_backend_id, "ollama-llama3-2-3b");
    assert.ok(router.state.backends.some((entry) => entry.backend_id === "bridge-codex"));
    assert.ok(router.state.backends.some((entry) => entry.backend_id === "bridge-gemini-cli"));
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

    assert.equal(
      maintained.ok,
      maintained.status.bootstrap.self_start_ready === true &&
        maintained.status.eval_health?.healthy === true
    );
    assert.ok(Array.isArray(maintained.actions));
    assert.ok(maintained.actions.includes("autonomy.bootstrap.ensure"));
    assert.ok(maintained.actions.includes("agent.learning_summary"));
    assert.equal(maintained.status.bootstrap.self_start_ready, true);
    assert.equal(maintained.status.goal_autorun_daemon.running, true);
    assert.equal(maintained.status.task_auto_retry.running, true);
    assert.equal(maintained.status.state.enabled, true);
    assert.equal(maintained.status.runtime.running, true);
    assert.equal(typeof maintained.status.state.last_run_at, "string");
    assert.equal(typeof maintained.status.state.last_learning_review_at, "string");
    assert.ok(
      maintained.eval.executed === true ||
      maintained.actions.includes("eval.deferred_busy") ||
      maintained.status.eval_health?.due === true
    );
    if (maintained.eval.executed) {
      assert.equal(typeof maintained.eval.run_id, "string");
      assert.equal(typeof maintained.eval.aggregate_metric_value, "number");
    }

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    });
    assert.equal(kernel.autonomy_maintain.enabled, true);
    assert.equal(kernel.autonomy_maintain.stale, false);
    assert.ok(
      kernel.autonomy_maintain.eval_due === false ||
      maintained.actions.includes("eval.deferred_busy") ||
      maintained.status.eval_health?.due === true
    );
    assert.equal(typeof kernel.autonomy_maintain.last_run_at, "string");
    assert.equal(kernel.autonomy_maintain.runtime.running, true);
    assert.equal(kernel.overview.autonomy_maintain.runtime_running, true);

    await session.client.close().catch(() => {});
    const restoredSession = await openClient({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
    });
    try {
      const restored = await callTool(restoredSession.client, "autonomy.maintain", {
        action: "status",
        local_host_id: "local",
        probe_ollama_url: ollama.url,
      });
      assert.equal(restored.runtime.running, true);
      assert.equal(restored.state.enabled, true);

      const restoredKernel = await callTool(restoredSession.client, "kernel.summary", {
        session_limit: 6,
        event_limit: 6,
        task_running_limit: 8,
      });
      assert.equal(restoredKernel.autonomy_maintain.runtime.running, true);
      assert.equal(restoredKernel.autonomy_maintain.stale, false);
    } finally {
      await restoredSession.client.close().catch(() => {});
    }
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain starts task auto-retry and requeues failed tasks without operator intervention", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-task-retry-"));
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
  });

  try {
    const createdTask = await callTool(session.client, "task.create", {
      mutation: nextMutation("autonomy-maintain-task-retry", "task.create", () => mutationCounter++),
      objective: "Recover this failed task through background maintenance",
      project_dir: REPO_ROOT,
      priority: 7,
      max_attempts: 3,
    });

    const claimedTask = await callTool(session.client, "task.claim", {
      mutation: nextMutation("autonomy-maintain-task-retry", "task.claim", () => mutationCounter++),
      worker_id: "maintain-retry-worker",
      task_id: createdTask.task.task_id,
      lease_seconds: 120,
    });
    assert.equal(claimedTask.claimed, true);

    await callTool(session.client, "task.fail", {
      mutation: nextMutation("autonomy-maintain-task-retry", "task.fail", () => mutationCounter++),
      worker_id: "maintain-retry-worker",
      task_id: createdTask.task.task_id,
      error: "synthetic failure for retry coverage",
      summary: "Fail once so maintenance has something real to recover",
    });

    const maintained = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-task-retry", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
      task_auto_retry_base_delay_seconds: 0,
      task_auto_retry_max_delay_seconds: 0,
    });

    assert.ok(maintained.actions.includes("task.auto_retry.start"));
    assert.equal(maintained.status.task_auto_retry.running, true);
    assert.equal(maintained.status.task_auto_retry.failed_task_count, 0);

    const failedTasks = await callTool(session.client, "task.list", {
      status: "failed",
      limit: 10,
    });
    assert.equal(failedTasks.count, 0);

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 10,
    });
    assert.ok(pendingTasks.tasks.some((task) => task.task_id === createdTask.task.task_id));
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain status reports eval debt when the last score is below threshold even if the eval is fresh", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-eval-health-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_RING_LEADER_AUTOSTART: "0",
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(daemon_key) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(
      "autonomy.maintain",
      1,
      JSON.stringify({
        interval_seconds: 120,
        learning_review_interval_seconds: 300,
        run_eval_if_due: true,
        eval_interval_seconds: 21600,
        eval_suite_id: "autonomy.control-plane",
        minimum_eval_score: 75,
        last_run_at: now,
        last_eval_run_at: now,
        last_eval_run_id: "eval-run-test",
        last_eval_score: 50,
        last_actions: [],
        last_attention: [],
        last_error: null,
      }),
      now
    );
    db.close();

    const status = await callTool(session.client, "autonomy.maintain", {
      action: "status",
      local_host_id: "local",
    });
    assert.equal(status.eval_health.due, true);
    assert.equal(status.eval_health.below_threshold, true);
    assert.equal(status.eval_health.healthy, false);

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 4,
      event_limit: 4,
      task_running_limit: 4,
    });
    assert.equal(kernel.autonomy_maintain.eval_due, true);
    assert.equal(kernel.autonomy_maintain.eval_health.below_threshold, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain self-drive synthesizes one bounded repair goal through autonomy.command when the system is idle with actionable debt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-self-drive-"));
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
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-maintain-self-drive", "autonomy.bootstrap.ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });
    assert.equal(ensured.ok, true);
    assert.equal(ensured.status.self_start_ready, true);

    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(daemon_key) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(
      "autonomy.maintain",
      1,
      JSON.stringify({
        enabled: true,
        interval_seconds: 120,
        learning_review_interval_seconds: 300,
        enable_self_drive: true,
        self_drive_cooldown_seconds: 60,
        run_eval_if_due: false,
        eval_interval_seconds: 21600,
        eval_suite_id: "autonomy.control-plane",
        minimum_eval_score: 75,
        last_run_at: now,
        last_eval_run_at: now,
        last_eval_run_id: "eval-run-self-drive",
        last_eval_score: 50,
        last_actions: [],
        last_attention: [],
        last_error: null,
      }),
      now
    );
    db.close();

    const maintained = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-self-drive", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
      run_goal_hygiene: false,
    });

    const selfDriveAction = maintained.actions.find((action) => action.startsWith("autonomy.self_drive:"));
    assert.equal(typeof selfDriveAction, "string");
    assert.equal(typeof maintained.status.self_drive.last_goal_id, "string");
    assert.ok(maintained.status.self_drive.last_goal_id.length > 0);
    assert.equal(
      maintained.status.attention.includes("eval.autonomy.control-plane.below_threshold"),
      true
    );

    const goals = await callTool(session.client, "goal.list", {
      status: "active",
      limit: 10,
    });
    const selfDriveGoal = goals.goals.find((goal) => goal.goal_id === maintained.status.self_drive.last_goal_id);
    assert.ok(selfDriveGoal);
    assert.match(selfDriveGoal.title, /^\[self-drive\] /);
    assert.equal(selfDriveGoal.metadata?.self_drive, true);
    assert.equal(selfDriveGoal.metadata?.spawned_by, "autonomy.maintain");

    const goal = await callTool(session.client, "goal.get", {
      goal_id: maintained.status.self_drive.last_goal_id,
    });
    assert.equal(goal.found, true);
    assert.equal(goal.goal.metadata?.self_drive, true);
    assert.equal(goal.goal.metadata?.spawned_by, "autonomy.maintain");
    assert.equal(typeof goal.goal.objective, "string");
    assert.ok(goal.goal.objective.length > 20);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain self-drive synthesizes one bounded exploratory goal when Patient Zero is armed and the system is otherwise idle", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-exploration-"));
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
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-maintain-exploration", "autonomy.bootstrap.ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });
    assert.equal(ensured.ok, true);
    assert.equal(ensured.status.self_start_ready, true);

    const storage = new Storage(dbPath);
    const dependencyFingerprint = computeEvalDependencyFingerprint(storage, "autonomy.control-plane");
    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(daemon_key) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(
      "patient.zero",
      1,
      JSON.stringify({
        autonomy_enabled: true,
        allow_observe: true,
        allow_act: true,
        allow_listen: true,
        browser_app: "Safari",
        audit_required: true,
        armed_at: now,
        armed_by: "test",
      }),
      now
    );
    db.prepare(
      `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(daemon_key) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(
      "desktop.control",
      1,
      JSON.stringify({
        allow_observe: true,
        allow_act: true,
        allow_listen: true,
        screenshot_dir: tempDir,
        action_timeout_ms: 15000,
        listen_max_seconds: 15,
        heartbeat_interval_seconds: 60,
        capability_probe: {
          can_observe: true,
          can_act: true,
          can_listen: true,
        },
      }),
      now
    );
    db.prepare(
      `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(daemon_key) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(
      "autonomy.maintain",
      1,
      JSON.stringify({
        enabled: true,
        local_host_id: "local",
        interval_seconds: 120,
        learning_review_interval_seconds: 300,
        enable_self_drive: true,
        self_drive_cooldown_seconds: 60,
        run_eval_if_due: false,
        eval_interval_seconds: 21600,
        eval_suite_id: "autonomy.control-plane",
        minimum_eval_score: 75,
        last_run_at: now,
        last_eval_run_at: now,
        last_eval_run_id: "eval-run-exploration",
        last_eval_score: 100,
        last_eval_dependency_fingerprint: dependencyFingerprint,
        last_actions: [],
        last_attention: [],
        last_error: null,
      }),
      now
    );
    db.close();

    const maintained = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-exploration", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
      run_goal_hygiene: false,
      start_runtime_workers: false,
      start_goal_autorun_daemon: false,
    });

    assert.equal(maintained.actions.includes("autonomy.self_drive:exploration"), true);
    assert.equal(typeof maintained.status.self_drive.last_goal_id, "string");
    assert.ok(maintained.status.self_drive.last_goal_id.length > 0);

    const goal = await callTool(session.client, "goal.get", {
      goal_id: maintained.status.self_drive.last_goal_id,
    });
    assert.equal(goal.found, true);
    assert.match(goal.goal.title, /^\[self-drive\] Explore /);
    assert.equal(goal.goal.metadata?.self_drive, true);
    assert.equal(goal.goal.metadata?.self_drive_mode, "exploration");
    assert.equal(goal.goal.metadata?.patient_zero_required, true);
    assert.equal(goal.goal.metadata?.permission_profile, "network_enabled");
    assert.equal(typeof goal.goal.objective, "string");
    assert.ok(goal.goal.objective.includes("exploratory reconnaissance"));
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain status reports eval debt when the eval suite fingerprint drifts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-eval-drift-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_RING_LEADER_AUTOSTART: "0",
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    await callTool(session.client, "eval.suite_upsert", {
      mutation: nextMutation("autonomy-maintain-eval-drift", "eval.suite_upsert", () => mutationCounter++),
      suite_id: "autonomy.control-plane",
      title: "Autonomy Control Plane",
      objective: "Keep the autonomy control plane reproducible and healthy.",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          title: "Router baseline",
          kind: "router_case",
          task_kind: "planning",
          preferred_tags: ["local"],
          required: true,
          weight: 1,
        },
      ],
      tags: ["autonomy"],
    });

    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(daemon_key) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`
    ).run(
      "autonomy.maintain",
      1,
      JSON.stringify({
        local_host_id: "local",
        interval_seconds: 120,
        learning_review_interval_seconds: 300,
        run_eval_if_due: true,
        eval_interval_seconds: 21600,
        eval_suite_id: "autonomy.control-plane",
        minimum_eval_score: 75,
        last_run_at: now,
        last_eval_run_at: now,
        last_eval_run_id: "eval-run-drift",
        last_eval_score: 100,
        last_eval_dependency_fingerprint: "stale-fingerprint",
        last_actions: [],
        last_attention: [],
        last_error: null,
      }),
      now
    );
    db.close();

    const status = await callTool(session.client, "autonomy.maintain", {
      action: "status",
      local_host_id: "local",
    });
    assert.equal(status.eval_health.due, true);
    assert.equal(status.eval_health.due_by_dependency_drift, true);
    assert.equal(status.eval_health.operational, true);
    assert.equal(status.eval_health.healthy, false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.bootstrap keeps self-start readiness green when suite drift is advisory", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-bootstrap-advisory-drift-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
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
    const ensured = await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("autonomy-bootstrap-advisory-drift", "ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });
    assert.equal(ensured.ok, true);

    const storage = new Storage(dbPath);
    const router = storage.getModelRouterState();
    assert.ok(router);
    storage.setModelRouterState({
      enabled: true,
      strategy: router?.strategy ?? "balanced",
      default_backend_id: "mlx-qwen-advisory-drift",
      backends: [
        ...(router?.backends ?? []),
        {
          backend_id: "mlx-qwen-advisory-drift",
          enabled: true,
          provider: "mlx",
          model_id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
          locality: "local",
          tags: ["local", "mlx", "primary"],
          heartbeat_at: new Date().toISOString(),
        },
      ],
    });

    const status = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
    });
    assert.equal(status.eval_suites.default_suite_drift, true);
    assert.equal(status.repairs_needed.includes("eval.suite.default_drift"), true);
    assert.equal(status.self_start_ready, true);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("computeEvalDependencyFingerprint ignores heartbeat churn and changes only on semantic router drift", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-fingerprint-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  return (async () => {
    const bootstrapSession = await openClient({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_RING_LEADER_AUTOSTART: "0",
      MCP_NOTIFIER_DRY_RUN: "1",
    });
    await bootstrapSession.client.close().catch(() => {});

    const storage = new Storage(dbPath);

    try {
      storage.setBenchmarkSuitesState({
        enabled: true,
        suites: [
          {
            suite_id: "autonomy.smoke.local",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            title: "Autonomy smoke",
            objective: "Keep smoke green",
            project_dir: REPO_ROOT,
            isolation_mode: "git_worktree",
            aggregate_metric_name: "suite_success_rate",
            aggregate_metric_direction: "maximize",
            cases: [
              {
                case_id: "build",
                title: "Build",
                command: "npm run build",
                timeout_seconds: 600,
                required: true,
                metric_name: "duration_ms",
                metric_direction: "minimize",
                metric_mode: "duration_ms",
                metric_regex: null,
                tags: [],
                metadata: {},
              },
            ],
            tags: ["autonomy"],
            metadata: {},
          },
        ],
      });
      storage.setEvalSuitesState({
        enabled: true,
        suites: [
          {
            suite_id: "autonomy.control-plane",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            title: "Autonomy control-plane",
            objective: "Keep the router honest",
            aggregate_metric_name: "suite_success_rate",
            aggregate_metric_direction: "maximize",
            cases: [
              {
                case_id: "benchmark",
                title: "Benchmark",
                kind: "benchmark_suite",
                benchmark_suite_id: "autonomy.smoke.local",
                task_kind: null,
                context_tokens: 0,
                latency_budget_ms: 0,
                expected_backend_id: null,
                expected_backend_tags: [],
                required_tags: [],
                preferred_tags: [],
                required: true,
                weight: 1,
                metadata: {},
              },
              {
                case_id: "router-primary-planning",
                title: "Primary planning",
                kind: "router_case",
                benchmark_suite_id: null,
                task_kind: "planning",
                context_tokens: 4000,
                latency_budget_ms: 2000,
                expected_backend_id: "ollama-llama3-2-3b",
                expected_backend_tags: [],
                required_tags: [],
                preferred_tags: ["local", "ollama", "gpu", "primary"],
                required: true,
                weight: 1,
                metadata: {},
              },
            ],
            tags: ["autonomy"],
            metadata: {},
          },
        ],
      });
      storage.setWorkerFabricState({
        enabled: true,
        strategy: "resource_aware",
        default_host_id: "local",
        hosts: [
          {
            host_id: "local",
            enabled: true,
            transport: "local",
            workspace_root: REPO_ROOT,
            worker_count: 4,
            shell: "/bin/zsh",
            capabilities: {},
            tags: ["local"],
            telemetry: {
              heartbeat_at: "2026-03-31T00:00:00.000Z",
              health_state: "healthy",
              queue_depth: 1,
              active_tasks: 1,
              latency_ms: 5,
              cpu_utilization: 0.2,
              ram_available_gb: 20,
              ram_total_gb: 48,
              swap_used_gb: 0.1,
              gpu_utilization: null,
              gpu_memory_available_gb: null,
              gpu_memory_total_gb: null,
              disk_free_gb: 100,
              thermal_pressure: "nominal",
            },
            metadata: {},
            updated_at: "2026-03-31T00:00:00.000Z",
          },
        ],
      });
      storage.setModelRouterState({
        enabled: true,
        strategy: "prefer_quality",
        default_backend_id: "ollama-llama3-2-3b",
        backends: [
          {
            backend_id: "ollama-llama3-2-3b",
            enabled: true,
            provider: "ollama",
            model_id: "llama3.2:3b",
            endpoint: "http://127.0.0.1:11434",
            host_id: "local",
            locality: "local",
            context_window: 8192,
            throughput_tps: null,
            latency_ms_p50: 5,
            success_rate: 0.7,
            win_rate: null,
            cost_per_1k_input: null,
            max_output_tokens: null,
            tags: ["local", "ollama", "gpu", "primary"],
            capabilities: {
              task_kinds: ["planning"],
              probe_healthy: false,
              probe_model_known: true,
              probe_model_loaded: true,
            },
            metadata: {},
            heartbeat_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          },
        ],
      });

      const baseline = computeEvalDependencyFingerprint(storage, "autonomy.control-plane");

      storage.setWorkerFabricState({
        enabled: true,
        strategy: "resource_aware",
        default_host_id: "local",
        hosts: [
          {
            host_id: "local",
            enabled: true,
            transport: "local",
            workspace_root: REPO_ROOT,
            worker_count: 4,
            shell: "/bin/zsh",
            capabilities: {},
            tags: ["local"],
            telemetry: {
              heartbeat_at: "2026-03-31T00:05:00.000Z",
              health_state: "healthy",
              queue_depth: 5,
              active_tasks: 3,
              latency_ms: 7,
              cpu_utilization: 0.6,
              ram_available_gb: 18,
              ram_total_gb: 48,
              swap_used_gb: 0.2,
              gpu_utilization: null,
              gpu_memory_available_gb: null,
              gpu_memory_total_gb: null,
              disk_free_gb: 99,
              thermal_pressure: "nominal",
            },
            metadata: {},
            updated_at: "2026-03-31T00:05:00.000Z",
          },
        ],
      });
      storage.setModelRouterState({
        enabled: true,
        strategy: "prefer_quality",
        default_backend_id: "ollama-llama3-2-3b",
        backends: [
          {
            backend_id: "ollama-llama3-2-3b",
            enabled: true,
            provider: "ollama",
            model_id: "llama3.2:3b",
            endpoint: "http://127.0.0.1:11434",
            host_id: "local",
            locality: "local",
            context_window: 8192,
            throughput_tps: null,
            latency_ms_p50: 3,
            success_rate: 0.72,
            win_rate: null,
            cost_per_1k_input: null,
            max_output_tokens: null,
            tags: ["local", "ollama", "gpu", "primary"],
            capabilities: {
              task_kinds: ["planning"],
              probe_healthy: false,
              probe_model_known: true,
              probe_model_loaded: true,
            },
            metadata: {},
            heartbeat_at: "2026-03-31T00:05:00.000Z",
            updated_at: "2026-03-31T00:05:00.000Z",
          },
        ],
      });

      const heartbeatOnly = computeEvalDependencyFingerprint(storage, "autonomy.control-plane");
      assert.equal(heartbeatOnly, baseline);

      storage.setBenchmarkSuitesState({
        enabled: true,
        suites: [
          {
            ...storage.getBenchmarkSuitesState().suites[0],
            updated_at: "2026-03-31T00:09:00.000Z",
          },
        ],
      });
      const benchmarkTimestampOnly = computeEvalDependencyFingerprint(storage, "autonomy.control-plane");
      assert.equal(benchmarkTimestampOnly, baseline);

      storage.setModelRouterState({
        enabled: true,
        strategy: "prefer_quality",
        default_backend_id: "ollama-llama3-2-3b",
        backends: [
          {
            backend_id: "ollama-llama3-2-3b",
            enabled: true,
            provider: "ollama",
            model_id: "llama3.2:3b",
            endpoint: "http://127.0.0.1:11434",
            host_id: "local",
            locality: "local",
            context_window: 8192,
            throughput_tps: null,
            latency_ms_p50: 3,
            success_rate: 0.72,
            win_rate: null,
            cost_per_1k_input: null,
            max_output_tokens: null,
            tags: ["local", "ollama", "gpu", "primary"],
            capabilities: {
              task_kinds: ["planning", "verification"],
              probe_healthy: true,
              probe_model_known: true,
              probe_model_loaded: false,
            },
            metadata: {},
            heartbeat_at: "2026-03-31T00:10:00.000Z",
            updated_at: "2026-03-31T00:10:00.000Z",
          },
        ],
      });

      const semanticDrift = computeEvalDependencyFingerprint(storage, "autonomy.control-plane");
      assert.notEqual(semanticDrift, baseline);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })();
});

test("autonomy.bootstrap status uses the configured default local backend when checking eval-suite drift", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-bootstrap-default-backend-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_RING_LEADER_AUTOSTART: "0",
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("autonomy-bootstrap-default-router", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_quality",
      default_backend_id: "ollama-llama3-2-3b",
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("autonomy-bootstrap-default-router-mlx", "model.router.upsert.mlx", () => mutationCounter++),
      backend: {
        backend_id: "mlx-secondary",
        provider: "mlx",
        model_id: "mlx/secondary",
        locality: "local",
        host_id: "local",
        context_window: 32768,
        tags: ["local", "mlx", "gpu"],
      },
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("autonomy-bootstrap-default-router-ollama", "model.router.upsert.ollama", () => mutationCounter++),
      backend: {
        backend_id: "ollama-llama3-2-3b",
        provider: "ollama",
        model_id: "llama3.2:3b",
        locality: "local",
        host_id: "local",
        context_window: 8192,
        tags: ["local", "ollama", "gpu", "primary"],
      },
    });

    await callTool(session.client, "eval.suite_upsert", {
      mutation: nextMutation("autonomy-bootstrap-default-eval", "eval.suite_upsert", () => mutationCounter++),
      suite_id: "autonomy.control-plane",
      title: "Autonomy control-plane eval",
      objective: "Keep the self-starting worker fabric, router, and benchmark substrate honest.",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "autonomy-benchmark-smoke",
          title: "Autonomy smoke benchmark stays green",
          kind: "benchmark_suite",
          benchmark_suite_id: "autonomy.smoke.local",
          required: true,
          weight: 1,
        },
        {
          case_id: "router-primary-planning",
          title: "Planning routes to the current primary local backend",
          kind: "router_case",
          task_kind: "planning",
          context_tokens: 4000,
          latency_budget_ms: 2000,
          expected_backend_id: "ollama-llama3-2-3b",
          expected_backend_tags: [],
          required_tags: ["primary"],
          preferred_tags: ["local", "ollama", "gpu", "primary"],
          required: true,
          weight: 1,
        },
      ],
      tags: ["autonomy", "control-plane", "bootstrap"],
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
        primary_backend_id: "ollama-llama3-2-3b",
        preferred_router_tags: ["local", "ollama", "gpu", "primary"],
      },
    });

    const status = await callTool(session.client, "autonomy.bootstrap", {
      action: "status",
      local_host_id: "local",
      autostart_ring_leader: false,
    });
    assert.equal(status.eval_suites.default_suite_drift, false);
    assert.equal(status.repairs_needed.includes("eval.suite.default_drift"), false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain recovers expired running task leases before they stay stuck in the queue", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-task-recovery-"));
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
  });

  try {
    const createdTask = await callTool(session.client, "task.create", {
      mutation: nextMutation("autonomy-maintain-task-recovery", "task.create", () => mutationCounter++),
      objective: "Recover this expired running task through background maintenance",
      project_dir: REPO_ROOT,
      priority: 9,
      max_attempts: 3,
    });

    const claimedTask = await callTool(session.client, "task.claim", {
      mutation: nextMutation("autonomy-maintain-task-recovery", "task.claim", () => mutationCounter++),
      worker_id: "maintain-recovery-worker",
      task_id: createdTask.task.task_id,
      lease_seconds: 15,
    });
    assert.equal(claimedTask.claimed, true);

    const db = new Database(dbPath);
    try {
      const expiredAt = new Date(Date.now() - 1000).toISOString();
      db.prepare(`UPDATE task_leases SET lease_expires_at = ?, updated_at = ? WHERE task_id = ?`).run(
        expiredAt,
        expiredAt,
        createdTask.task.task_id
      );
    } finally {
      db.close();
    }

    const maintained = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-task-recovery", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
      run_task_recovery: true,
      start_task_auto_retry_daemon: false,
    });

    assert.ok(maintained.actions.includes("task.recover_expired"));
    assert.equal(maintained.status.task_auto_retry.expired_running_task_count, 0);

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 10,
    });
    assert.ok(pendingTasks.tasks.some((task) => task.task_id === createdTask.task.task_id));

    const timeline = await callTool(session.client, "task.timeline", {
      task_id: createdTask.task.task_id,
      limit: 20,
    });
    assert.ok(timeline.events.some((event) => event.event_type === "lease_expired_requeued"));
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain runs goal hygiene so stale ephemeral goals do not stay active behind autorun cooldown", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-maintain-goal-hygiene-"));
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
  });

  try {
    const createdGoal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("autonomy-maintain-goal-hygiene", "goal.create", () => mutationCounter++),
      title: "Demo",
      objective: "Allow autonomy.maintain to retire stale ephemeral idle goals.",
      status: "active",
      acceptance_criteria: ["Autonomy maintenance archives stale ephemeral idle goals."],
      tags: ["demo", "smoke"],
      metadata: {
        auto_archive_when_idle: true,
        auto_archive_after_seconds: 1,
      },
    });

    const blockedPlan = await callTool(session.client, "plan.create", {
      mutation: nextMutation("autonomy-maintain-goal-hygiene", "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Idle demo plan",
      summary: "Block on a human step so the goal stays idle.",
      selected: true,
      steps: [
        {
          step_id: "needs-human",
          seq: 1,
          title: "Await approval",
          step_kind: "handoff",
          executor_kind: "human",
          input: {
            approval_summary: "Human approval required before continuing.",
          },
        },
      ],
    });

    await callTool(session.client, "plan.dispatch", {
      mutation: nextMutation("autonomy-maintain-goal-hygiene", "plan.dispatch", () => mutationCounter++),
      plan_id: blockedPlan.plan.plan_id,
    });

    await delay(1100);

    await callTool(session.client, "goal.autorun", {
      mutation: nextMutation("autonomy-maintain-goal-hygiene", "goal.autorun", () => mutationCounter++),
      limit: 10,
      max_passes: 4,
    });

    const maintained = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-goal-hygiene", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
      run_goal_hygiene: true,
    });

    assert.ok(maintained.actions.includes("goal.hygiene"));

    const goal = await callTool(session.client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goal.goal.status, "archived");
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

async function callTool(client, name, args) {
  const result = await client.callTool(
    {
      name,
      arguments: args,
    },
    undefined,
    { timeout: 180000 }
  );
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
