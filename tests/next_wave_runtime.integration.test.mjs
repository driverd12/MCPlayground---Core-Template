import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";

const REPO_ROOT = process.cwd();

test("model.router persists backend state and routes by measured quality", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-router-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "cluster.topology", {
      action: "ensure_lab",
      mutation: nextMutation("model-router-topology", "cluster.topology.ensure_lab", () => mutationCounter++),
      local_host_id: "local",
      workspace_root: REPO_ROOT,
    });

    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("model-router-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_quality",
    });

    await callTool(session.client, "worker.fabric", {
      action: "configure",
      mutation: nextMutation("worker-fabric-configure", "worker.fabric.configure", () => mutationCounter++),
      enabled: true,
      strategy: "resource_aware",
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-upsert-local", "model.router.upsert.local", () => mutationCounter++),
      backend: {
        backend_id: "quality-backend",
        provider: "mlx",
        model_id: "mlx/quality-backend",
        locality: "local",
        context_window: 32768,
        throughput_tps: 120,
        latency_ms_p50: 18,
        success_rate: 0.99,
        win_rate: 0.995,
        cost_per_1k_input: 0.18,
        max_output_tokens: 8192,
        tags: ["local", "quality", "planning"],
        capabilities: {
          task_kinds: ["planning", "coding"],
        },
      },
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-upsert-remote", "model.router.upsert.remote", () => mutationCounter++),
      backend: {
        backend_id: "fast-backend",
        provider: "ollama",
        model_id: "ollama/fast-backend",
        locality: "remote",
        context_window: 8192,
        throughput_tps: 220,
        latency_ms_p50: 6,
        success_rate: 0.72,
        win_rate: 0.7,
        cost_per_1k_input: 0.08,
        max_output_tokens: 4096,
        tags: ["remote", "speed"],
        capabilities: {
          task_kinds: ["chat"],
        },
      },
    });

    const status = await callTool(session.client, "model.router", { action: "status" });
    assert.equal(status.state.enabled, true);
    assert.equal(status.state.backends.length, 2);
    assert.equal(status.state.default_backend_id, "quality-backend");

    const route = await callTool(session.client, "model.router", {
      action: "route",
      task_kind: "coding",
      context_tokens: 4000,
      latency_budget_ms: 200,
      preferred_tags: ["quality"],
    });
    assert.equal(route.selected_backend.backend_id, "quality-backend");
    assert.equal(route.ranked_backends[0].backend.backend_id, "quality-backend");
    assert.ok(route.ranked_backends[0].reasoning.quality_score > route.ranked_backends[1].reasoning.quality_score);
    assert.ok(route.planned_backends.some((entry) => entry.node_id === "gpu-5090" && entry.provider === "vllm"));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("model.router keeps localhost-backed backends local when host_id is local", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-router-locality-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("model-router-locality-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "balanced",
    });

    const upserted = await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-locality-upsert", "model.router.upsert.locality", () => mutationCounter++),
      backend: {
        backend_id: "local-ollama",
        provider: "ollama",
        model_id: "llama3.2:3b",
        endpoint: "http://127.0.0.1:11434",
        host_id: "local",
        context_window: 8192,
        tags: ["local", "ollama"],
      },
    });

    const backend = upserted.state.backends.find((entry) => entry.backend_id === "local-ollama");
    assert.ok(backend);
    assert.equal(backend.locality, "local");
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("model.router prefers the primary loaded local backend over an unavailable local backend for planning", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-router-primary-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("model-router-primary-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_quality",
      default_backend_id: "ollama-primary",
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-primary-upsert-mlx", "model.router.upsert.mlx", () => mutationCounter++),
      backend: {
        backend_id: "mlx-secondary",
        provider: "mlx",
        model_id: "mlx/secondary",
        locality: "local",
        host_id: "local",
        context_window: 32768,
        throughput_tps: 140,
        latency_ms_p50: 20,
        success_rate: 0.999,
        tags: ["local", "mlx", "gpu"],
        capabilities: {
          task_kinds: ["planning", "coding"],
          probe_healthy: false,
          probe_model_known: false,
          probe_model_loaded: false,
        },
      },
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-primary-upsert-ollama", "model.router.upsert.ollama", () => mutationCounter++),
      backend: {
        backend_id: "ollama-primary",
        provider: "ollama",
        model_id: "llama3.2:3b",
        locality: "local",
        host_id: "local",
        context_window: 8192,
        throughput_tps: 20,
        latency_ms_p50: 12,
        success_rate: 0.7,
        tags: ["local", "ollama", "gpu", "primary"],
        capabilities: {
          task_kinds: ["planning", "coding"],
          probe_healthy: false,
          probe_model_known: true,
          probe_model_loaded: true,
        },
      },
    });

    const route = await callTool(session.client, "model.router", {
      action: "route",
      task_kind: "planning",
      context_tokens: 4000,
      latency_budget_ms: 2000,
      preferred_tags: ["local", "ollama", "gpu", "primary"],
    });
    assert.equal(route.selected_backend.backend_id, "ollama-primary");
    assert.equal(route.ranked_backends[0].backend.backend_id, "ollama-primary");
    assert.ok(route.ranked_backends[0].reasoning.operational_readiness > route.ranked_backends[1].reasoning.operational_readiness);
    assert.ok(route.ranked_backends[0].reasoning.default_alignment > route.ranked_backends[1].reasoning.default_alignment);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain refreshes local ollama backends with measured probe data", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-router-probe-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
        model: "llama3.2:3b",
      },
    ],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
  });

  try {
    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("model-router-probe-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "balanced",
    });

    await callTool(session.client, "worker.fabric", {
      action: "configure",
      mutation: nextMutation("worker-fabric-probe-configure", "worker.fabric.configure", () => mutationCounter++),
      enabled: true,
      strategy: "resource_aware",
    });

    await callTool(session.client, "worker.fabric", {
      action: "upsert_host",
      mutation: nextMutation("worker-fabric-probe-host", "worker.fabric.upsert", () => mutationCounter++),
      host: {
        host_id: "local",
        transport: "local",
        workspace_root: REPO_ROOT,
        worker_count: 1,
        tags: ["local"],
      },
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-probe-upsert", "model.router.upsert", () => mutationCounter++),
      backend: {
        backend_id: "local-ollama",
        provider: "ollama",
        model_id: "llama3.2:3b",
        endpoint: ollama.url,
        host_id: "local",
        locality: "local",
        context_window: 8192,
        tags: ["local", "ollama"],
      },
    });

    await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-probe", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
    });

    const status = await callTool(session.client, "model.router", { action: "status" });
    const backend = status.state.backends.find((entry) => entry.backend_id === "local-ollama");
    assert.ok(backend);
    assert.ok(typeof backend.latency_ms_p50 === "number");
    assert.ok(typeof backend.throughput_tps === "number");
    assert.ok(typeof backend.success_rate === "number");
    assert.equal(backend.capabilities.probe_healthy, true);
    assert.equal(backend.capabilities.probe_model_known, true);
    assert.equal(backend.capabilities.probe_model_loaded, true);
    assert.equal(backend.capabilities.probe_resident_model_count, 1);
    assert.ok(Number(backend.capabilities.probe_resident_vram_gb) > 1.9);
    assert.equal(typeof backend.capabilities.probe_generated_at, "string");
    assert.equal(backend.metadata.last_probe.requested_model, "llama3.2:3b");
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain prewarms a cold local ollama backend when queued work exists", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-router-prewarm-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const ollama = await startStatefulFakeOllamaServer();
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
  });

  try {
    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("model-router-prewarm-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "balanced",
    });

    await callTool(session.client, "worker.fabric", {
      action: "configure",
      mutation: nextMutation("worker-fabric-prewarm-configure", "worker.fabric.configure", () => mutationCounter++),
      enabled: true,
      strategy: "resource_aware",
    });

    await callTool(session.client, "worker.fabric", {
      action: "upsert_host",
      mutation: nextMutation("worker-fabric-prewarm-host", "worker.fabric.upsert", () => mutationCounter++),
      host: {
        host_id: "local",
        transport: "local",
        workspace_root: REPO_ROOT,
        worker_count: 1,
        tags: ["local"],
        telemetry: {
          queue_depth: 2,
          active_tasks: 0,
          health_state: "healthy",
        },
      },
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-prewarm-upsert", "model.router.upsert", () => mutationCounter++),
      backend: {
        backend_id: "local-ollama-cold",
        provider: "ollama",
        model_id: "llama3.2:3b",
        endpoint: ollama.url,
        host_id: "local",
        locality: "local",
        context_window: 8192,
        latency_ms_p50: 180,
        throughput_tps: 20,
        tags: ["local", "ollama"],
        capabilities: {
          probe_generated_at: new Date().toISOString(),
        },
      },
    });

    const result = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("autonomy-maintain-prewarm", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      local_host_id: "local",
      probe_ollama_url: ollama.url,
    });

    assert.ok(result.actions.includes("model.router.prewarm:local-ollama-cold"));
    const status = await callTool(session.client, "model.router", { action: "status" });
    const backend = status.state.backends.find((entry) => entry.backend_id === "local-ollama-cold");
    assert.ok(backend);
    assert.equal(backend.capabilities.probe_model_loaded, true);
    assert.equal(backend.metadata.last_residency_action.action, "prewarm");

    const kernel = await callTool(session.client, "kernel.summary", {});
    const localHost = kernel.worker_fabric.hosts.find((entry) => entry.host_id === "local");
    assert.ok(localHost);
    assert.equal(localHost.recommended_runtime_worker_max_active >= 1, true);
    assert.equal(localHost.recommended_tmux_worker_count >= 1, true);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runtime.worker spawns a shell-backed isolated worktree session and completes a task in a foreign repo", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-runtime-worker-"));
  const repoDir = path.join(tempDir, "foreign-repo");
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  fs.mkdirSync(repoDir, { recursive: true });
  run("git init", repoDir);
  run("git config user.email 'codex@example.com'", repoDir);
  run("git config user.name 'Codex'", repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# runtime worker\n", "utf8");
  run("git add README.md", repoDir);
  run("git commit -m 'baseline'", repoDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const task = await callTool(session.client, "task.create", {
      mutation: nextMutation("runtime-worker", "task.create", () => mutationCounter++),
      objective: "Write a runtime proof file inside the isolated worktree.",
      project_dir: repoDir,
      payload: {
        delegation_brief: {
          delegate_agent_id: "code-smith",
          task_objective: "Write the proof file and keep the scope bounded to the isolated worktree.",
          success_criteria: ["runtime-proof.txt exists in the isolated worktree"],
          evidence_requirements: ["Show the runtime-proof.txt file contents"],
          rollback_notes: ["Fail clearly if the worktree launch breaks instead of writing outside the sandbox"],
        },
      },
      task_execution: {
        runtime_id: "shell",
        runtime_strategy: "tmux_worktree",
        runtime_command: "printf 'runtime-worker-ok\\n' > runtime-proof.txt",
      },
      metadata: {
        task_mode: "runtime-worker-test",
      },
      source_client: "next-wave-test",
    });

    const spawned = await callTool(session.client, "runtime.worker", {
      action: "spawn_task",
      mutation: nextMutation("runtime-worker", "runtime.worker.spawn_task", () => mutationCounter++),
      task_id: task.task.task_id,
      runtime_id: "shell",
      runtime_strategy: "tmux_worktree",
      source_client: "next-wave-test",
    });
    assert.equal(spawned.created, true);
    assert.equal(spawned.session.runtime_id, "shell");
    assert.equal(typeof spawned.session.worktree_path, "string");
    assert.ok(spawned.session.worktree_path.includes(".mcp-runtime-worktrees"));
    assert.notEqual(path.resolve(spawned.session.worktree_path), path.resolve(repoDir));

    const completedTask = await waitFor(async () => {
      await callTool(session.client, "runtime.worker", { action: "status", limit: 20 });
      const completed = await callTool(session.client, "task.list", { status: "completed", limit: 25 });
      return completed.tasks.find((entry) => entry.task_id === task.task.task_id) ?? null;
    });
    assert.ok(completedTask);

    const runtimeStatus = await callTool(session.client, "runtime.worker", {
      action: "status",
      limit: 20,
    });
    const runtimeSession = runtimeStatus.sessions.find((entry) => entry.task_id === task.task.task_id);
    assert.ok(runtimeSession);
    assert.equal(runtimeSession.status, "completed");
    assert.equal(fs.existsSync(runtimeSession.transcript_path), true);
    assert.equal(fs.existsSync(runtimeSession.brief_path), true);
    assert.equal(fs.existsSync(path.join(runtimeSession.worktree_path, "runtime-proof.txt")), true);
    assert.equal(
      fs.readFileSync(path.join(runtimeSession.worktree_path, "runtime-proof.txt"), "utf8").trim(),
      "runtime-worker-ok"
    );
    const sessionBrief = fs.readFileSync(runtimeSession.brief_path, "utf8");
    assert.match(sessionBrief, /Delegate: code-smith/);
    assert.match(sessionBrief, /Success criteria/);
    assert.match(sessionBrief, /Evidence requirements/);
    assert.match(sessionBrief, /Rollback notes/);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain auto-spawns pending runtime worker tasks and exposes status", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-runtime-maintain-"));
  const repoDir = path.join(tempDir, "runtime-maintain-repo");
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  fs.mkdirSync(repoDir, { recursive: true });
  run("git init", repoDir);
  run("git config user.email 'codex@example.com'", repoDir);
  run("git config user.name 'Codex'", repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# runtime maintain\n", "utf8");
  run("git add README.md", repoDir);
  run("git commit -m 'baseline'", repoDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const task = await callTool(session.client, "task.create", {
      mutation: nextMutation("runtime-maintain", "task.create", () => mutationCounter++),
      objective: "Create a runtime maintain proof file from the background loop.",
      project_dir: repoDir,
      task_execution: {
        runtime_id: "shell",
        runtime_strategy: "tmux_worktree",
        runtime_command: "printf 'runtime-maintain-ok\\n' > runtime-maintain-proof.txt",
      },
      metadata: {
        task_mode: "runtime-maintain-test",
      },
      source_client: "next-wave-test",
    });

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("runtime-maintain", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      run_goal_hygiene: false,
      run_eval_if_due: false,
      maintain_tmux_controller: false,
      start_task_auto_retry_daemon: false,
      start_reaction_engine_daemon: false,
      local_host_id: "local",
      source_client: "next-wave-test",
    });

    assert.ok(maintain.actions.includes("runtime.worker.spawn_pending"));
    assert.ok(maintain.status.runtime_workers);

    const completedTask = await waitFor(async () => {
      await callTool(session.client, "runtime.worker", { action: "status", limit: 20 });
      const completed = await callTool(session.client, "task.list", { status: "completed", limit: 25 });
      return completed.tasks.find((entry) => entry.task_id === task.task.task_id) ?? null;
    });
    assert.ok(completedTask);

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    });
    assert.ok(kernel.runtime_workers);
    assert.ok(kernel.overview.runtime_workers);
    assert.equal(kernel.runtime_workers.session_count >= 1, true);

    const runtimeStatus = await callTool(session.client, "runtime.worker", {
      action: "status",
      limit: 20,
    });
    const runtimeSession = runtimeStatus.sessions.find((entry) => entry.task_id === task.task.task_id);
    assert.ok(runtimeSession);
    assert.equal(runtimeSession.status, "completed");
    assert.equal(fs.existsSync(path.join(runtimeSession.worktree_path, "runtime-maintain-proof.txt")), true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain does not flag runtime worker attention for non-runtime pending tasks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-runtime-attention-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "task.create", {
      mutation: nextMutation("runtime-attention", "task.create", () => mutationCounter++),
      objective: "Pending task without runtime execution metadata should not trigger runtime worker attention.",
      project_dir: REPO_ROOT,
      metadata: {
        task_mode: "non-runtime-pending",
      },
      source_client: "next-wave-test",
    });

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("runtime-attention", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      run_goal_hygiene: false,
      run_eval_if_due: false,
      maintain_tmux_controller: false,
      start_task_auto_retry_daemon: false,
      start_reaction_engine_daemon: false,
      local_host_id: "local",
      source_client: "next-wave-test",
    });

    assert.equal(maintain.status.local_capacity.runtime_eligible_pending_tasks, 0);
    assert.equal(maintain.status.attention.includes("runtime.worker.idle_with_pending"), false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("eval suite upsert/list/run composes benchmark and router cases against real state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-eval-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'codex@example.com'", tempDir);
  run("git config user.name 'Codex'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "# eval benchmark\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const benchmarkSuite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation("benchmark-suite", "benchmark.suite_upsert", () => mutationCounter++),
      title: "Eval benchmark",
      objective: "Provide an isolated benchmark for the eval suite",
      project_dir: tempDir,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "readme-check",
          title: "README exists",
          command: "test -f README.md",
        },
      ],
    });

    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("router-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_quality",
    });
    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("router-backend", "model.router.upsert", () => mutationCounter++),
      backend: {
        backend_id: "eval-backend",
        provider: "mlx",
        model_id: "mlx/eval-backend",
        locality: "local",
        context_window: 65536,
        throughput_tps: 140,
        latency_ms_p50: 12,
        success_rate: 0.98,
        win_rate: 0.99,
        cost_per_1k_input: 0.12,
        max_output_tokens: 8192,
        tags: ["local", "quality", "planning"],
        capabilities: {
          task_kinds: ["planning", "coding"],
        },
      },
    });

    const suite = await callTool(session.client, "eval.suite_upsert", {
      mutation: nextMutation("eval-suite-upsert", "eval.suite_upsert", () => mutationCounter++),
      title: "Router and benchmark eval",
      objective: "Verify routing and benchmark synthesis",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "benchmark-smoke",
          title: "Isolated benchmark smoke",
          kind: "benchmark_suite",
          benchmark_suite_id: benchmarkSuite.suite.suite_id,
          required: true,
          weight: 1,
        },
        {
          case_id: "router-coding",
          title: "Router chooses the quality backend",
          kind: "router_case",
          task_kind: "coding",
          context_tokens: 4000,
          latency_budget_ms: 100,
          expected_backend_id: "eval-backend",
          expected_backend_tags: ["quality"],
          required_tags: ["quality"],
          preferred_tags: ["quality"],
          required: true,
          weight: 1,
        },
      ],
      tags: ["eval", "router"],
    });

    const suiteList = await callTool(session.client, "eval.suite_list", {});
    assert.ok(suiteList.suites.some((entry) => entry.suite_id === suite.suite.suite_id));

    const runResult = await callTool(session.client, "eval.run", {
      mutation: nextMutation("eval-run", "eval.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "baseline",
    });
    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results.length, 2);
    assert.ok(runResult.case_results.some((entry) => entry.kind === "benchmark_suite" && entry.ok === true));
    assert.ok(runResult.case_results.some((entry) => entry.kind === "router_case" && entry.selected_backend.backend_id === "eval-backend"));
    assert.equal(runResult.artifact.artifact_type, "eval.result");
    assert.ok(Number.isFinite(runResult.aggregate_metric_value));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("org.program and task.compile promote role doctrine into a durable plan", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-org-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const roleUpsert = await callTool(session.client, "org.program", {
      action: "upsert_role",
      mutation: nextMutation("org-upsert", "org.program.upsert", () => mutationCounter++),
      role_id: "implementation-director",
      title: "Implementation Director",
      lane: "implementer",
      version: {
        version_id: "impl-v1",
        summary: "Direct code-focused work with explicit evidence",
        doctrine: "Prefer bounded implementation slices with rollback notes.",
        delegation_contract: "Assign leaf execution only when the objective is narrow enough.",
        evaluation_standard: "A plan is acceptable only when its evidence contract is explicit.",
        status: "candidate",
      },
    });
    assert.equal(roleUpsert.role.role_id, "implementation-director");
    assert.equal(roleUpsert.role.active_version_id, null);
    assert.equal(roleUpsert.role.versions.length, 1);

    const promoted = await callTool(session.client, "org.program", {
      action: "promote_version",
      mutation: nextMutation("org-promote", "org.program.promote", () => mutationCounter++),
      role_id: "implementation-director",
      version_id: "impl-v1",
    });
    assert.equal(promoted.role.active_version_id, "impl-v1");
    assert.equal(promoted.role.versions[0].status, "active");

    const orgStatus = await callTool(session.client, "org.program", { action: "status" });
    assert.equal(orgStatus.role_count >= 1, true);
    assert.equal(orgStatus.active_version_count >= 1, true);

    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("goal-create", "goal.create", () => mutationCounter++),
      title: "Compile task plan",
      objective: "Turn the objective into a durable execution DAG",
      status: "active",
      priority: 8,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["A selected plan exists", "Every step has an owner and evidence contract"],
      constraints: ["Stay bounded and reversible"],
      tags: ["compiler", "org-program"],
    });

    const compiled = await callTool(session.client, "task.compile", {
      mutation: nextMutation("task-compile", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement an org-program-aware task compiler and verify it end to end",
      title: "Task compiler rollout",
      create_plan: true,
      selected: true,
      success_criteria: ["Plan exists", "Steps are ownered", "Evidence is explicit"],
    });

    assert.equal(compiled.created_plan, true);
    assert.equal(compiled.plan.goal_id, goal.goal.goal_id);
    assert.equal(compiled.plan.selected, true);
    assert.ok(compiled.steps.length >= 3);
    assert.ok(compiled.steps.some((step) => step.metadata.owner_role_id === "implementation-director"));
    assert.ok(
      compiled.steps.some(
        (step) =>
          step.metadata.org_program_version_id === "impl-v1" &&
          step.metadata.owner_role_id === "implementation-director"
      )
    );

    const plan = await callTool(session.client, "plan.get", { plan_id: compiled.plan.plan_id });
    assert.equal(plan.found, true);
    assert.equal(plan.plan.goal_id, goal.goal.goal_id);
    assert.ok(plan.step_count >= 3);
    assert.ok(plan.steps.some((step) => step.title === "Frame the objective and open execution lanes"));
    assert.equal(typeof plan.plan.metadata.swarm_profile.topology, "string");
    assert.equal(plan.plan.metadata.checkpoint_policy.artifact_type, "swarm.checkpoint");

    const artifacts = await callTool(session.client, "artifact.list", {
      plan_id: compiled.plan.plan_id,
      artifact_type: "swarm.checkpoint",
      limit: 10,
    });
    assert.equal(artifacts.artifacts.length >= 1, true);
    assert.equal(artifacts.artifacts[0].artifact_type, "swarm.checkpoint");
    assert.equal(compiled.compile_brief_artifact.artifact_type, "compile.brief");
    assert.match(compiled.compile_brief.content_text, /# Compile Brief/);

    const compileBriefArtifacts = await callTool(session.client, "artifact.list", {
      plan_id: compiled.plan.plan_id,
      artifact_type: "compile.brief",
      limit: 10,
    });
    assert.equal(compileBriefArtifacts.artifacts.length >= 1, true);
    assert.equal(compileBriefArtifacts.artifacts[0].artifact_type, "compile.brief");
    assert.match(compileBriefArtifacts.artifacts[0].content_text, /Objective/);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("operator.brief returns the live compile and delegation brief for the active objective", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-operator-brief-"));
  const repoDir = path.join(tempDir, "operator-brief-repo");
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  fs.mkdirSync(repoDir, { recursive: true });
  run("git init", repoDir);
  run("git config user.email 'codex@example.com'", repoDir);
  run("git config user.name 'Codex'", repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# operator brief\n", "utf8");
  run("git add README.md", repoDir);
  run("git commit -m 'baseline'", repoDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("operator-brief", "goal.create", () => mutationCounter++),
      title: "Operator brief rollout",
      objective: "Expose the current operator brief through MCP",
      status: "active",
      priority: 9,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["A current operator brief is available through MCP"],
      metadata: {
        ingress_thread_id: "ring-leader-main",
      },
    });

    const compiled = await callTool(session.client, "task.compile", {
      mutation: nextMutation("operator-brief", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement the operator brief path and prove the delegation contract is visible",
      create_plan: true,
      selected: true,
      success_criteria: ["The operator brief names the active objective and compile brief artifact"],
      metadata: {
        ingress_thread_id: "ring-leader-main",
      },
    });

    await callTool(session.client, "goal.create", {
      mutation: nextMutation("operator-brief", "goal.create", () => mutationCounter++),
      title: "Distractor rollout",
      objective: "This active goal belongs to another thread and should not hijack the brief.",
      status: "active",
      priority: 10,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["The distractor goal stays outside the ring leader brief."],
      metadata: {
        ingress_thread_id: "other-thread",
      },
    });

    await callTool(session.client, "agent.session_open", {
      mutation: nextMutation("operator-brief", "agent.session_open", () => mutationCounter++),
      session_id: "ring-leader-session",
      agent_id: "ring-leader",
      status: "active",
      capabilities: {
        planning: true,
      },
      metadata: {
        thread_id: "ring-leader-main",
        last_source_task_objective: "Keep the operator brief stable and current.",
        last_selected_delegation_brief: {
          delegate_agent_id: "code-smith",
          task_objective: "Wire the operator brief end to end.",
          success_criteria: ["The operator brief shows the active delegate."],
          evidence_requirements: ["Return the compile brief and active objective."],
          rollback_notes: ["Escalate instead of fabricating missing state."],
        },
        last_execution_task_ids: ["task-brief-1"],
      },
      source_client: "next-wave-test",
    });

    const brief = await callTool(session.client, "operator.brief", {
      thread_id: "ring-leader-main",
    });

    assert.equal(brief.goal.goal_id, goal.goal.goal_id);
    assert.equal(brief.plan.plan_id, compiled.plan.plan_id);
    assert.equal(brief.compile_brief_artifact.artifact_type, "compile.brief");
    assert.equal(brief.delegation_brief.delegate_agent_id, "code-smith");
    assert.match(brief.brief_markdown, /Current objective/);
    assert.match(brief.brief_markdown, /Compile brief artifact/);
    assert.match(brief.brief_markdown, /ring-leader -> code-smith/);

    const compactBrief = await callTool(session.client, "operator.brief", {
      thread_id: "ring-leader-main",
      compact: true,
    });

    assert.equal(compactBrief.compact, true);
    assert.equal(compactBrief.goal, null);
    assert.equal(compactBrief.plan, null);
    assert.equal(compactBrief.ring_leader_session, null);
    assert.equal(compactBrief.goal_summary.goal_id, goal.goal.goal_id);
    assert.equal(compactBrief.plan_summary.plan_id, compiled.plan.plan_id);
    assert.equal(compactBrief.ring_leader_session_summary.session_id, "ring-leader-session");
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("notifier.send delivers a real dry-run desktop notification through the MCP tool surface", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-notifier-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    const result = await callTool(session.client, "notifier.send", {
      mutation: nextMutation("notifier-send", "notifier.send", () => mutationCounter++),
      title: "Dry run notification",
      message: "Validate the notification path without requiring a GUI delivery during tests.",
      channels: ["desktop"],
      source_client: "next-wave-test",
    });
    assert.equal(result.ok, true);
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].channel, "desktop");
    assert.equal(result.deliveries[0].dry_run, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reaction.engine dedupes repeated kernel-attention alerts instead of spamming the operator", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-reaction-engine-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    MCP_NOTIFIER_DRY_RUN: "1",
  });

  try {
    const first = await callTool(session.client, "reaction.engine", {
      action: "run_once",
      mutation: nextMutation("reaction-engine", "reaction.engine.first", () => mutationCounter++),
      channels: ["desktop"],
      source_client: "next-wave-test",
    });
    assert.equal(first.ok, true);
    assert.ok(first.tick.alert);
    assert.equal(first.tick.sent_count, 1);

    const second = await callTool(session.client, "reaction.engine", {
      action: "run_once",
      mutation: nextMutation("reaction-engine", "reaction.engine.second", () => mutationCounter++),
      channels: ["desktop"],
      source_client: "next-wave-test",
    });
    assert.equal(second.ok, true);
    assert.equal(second.tick.sent_count, 0);
    assert.equal(second.tick.skipped, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain starts reaction.engine and kernel.summary exposes the live notifier loop", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-reaction-maintain-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    MCP_NOTIFIER_DRY_RUN: "1",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
  });

  try {
    await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("reaction-maintain", "autonomy.bootstrap.ensure", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      autostart_ring_leader: true,
      run_immediately: false,
    });

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("reaction-maintain", "autonomy.maintain.run_once", () => mutationCounter++),
      probe_ollama_url: ollama.url,
      run_eval_if_due: false,
      maintain_tmux_controller: false,
      start_reaction_engine_daemon: true,
      reaction_engine_channels: ["desktop"],
      source_client: "next-wave-test",
    });
    assert.equal(maintain.status.eval_health.healthy, false);
    assert.equal(maintain.status.reaction_engine.state.enabled, true);
    assert.equal(maintain.status.reaction_engine.runtime.running, true);

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    });
    assert.equal(kernel.reaction_engine.enabled, true);
    assert.equal(kernel.reaction_engine.runtime.running, true);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain supervises transcript, imprint, and trichat background daemons through one status model", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-maintain-subsystems-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const storage = new Storage(dbPath);
    storage.setTranscriptAutoSquishState({
      enabled: true,
      interval_seconds: 30,
      batch_runs: 2,
      per_run_limit: 50,
      max_points: 6,
    });
    storage.setImprintAutoSnapshotState({
      enabled: true,
      profile_id: null,
      interval_seconds: 120,
      include_recent_memories: 10,
      include_recent_transcript_lines: 20,
      write_file: false,
      promote_summary: false,
    });
    storage.setTriChatAutoRetentionState({
      enabled: true,
      interval_seconds: 300,
      older_than_days: 7,
      limit: 200,
    });
    storage.setTriChatTurnWatchdogState({
      enabled: true,
      interval_seconds: 30,
      stale_after_seconds: 180,
      batch_limit: 10,
    });

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("maintain-subsystems", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      run_goal_hygiene: false,
      run_task_recovery: false,
      start_runtime_workers: false,
      start_task_auto_retry_daemon: false,
      start_reaction_engine_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      run_optimizer_if_due: false,
      publish_runtime_event: false,
      source_client: "next-wave-test",
    });

    assert.equal(maintain.status.subsystems.transcript_auto_squish.running, true);
    assert.equal(maintain.status.subsystems.imprint_auto_snapshot.running, true);
    assert.equal(maintain.status.subsystems.trichat_auto_retention.running, true);
    assert.equal(maintain.status.subsystems.trichat_turn_watchdog.running, true);
    assert.equal(maintain.status.subsystems.transcript_auto_squish.stale, false);
    assert.equal(maintain.status.subsystems.trichat_turn_watchdog.stale, false);

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    });
    assert.equal(kernel.autonomy_maintain.subsystems.transcript_auto_squish.running, true);
    assert.equal(kernel.autonomy_maintain.subsystems.imprint_auto_snapshot.running, true);
    assert.equal(kernel.autonomy_maintain.subsystems.trichat_auto_retention.running, true);
    assert.equal(kernel.autonomy_maintain.subsystems.trichat_turn_watchdog.running, true);
    assert.equal(kernel.autonomy_maintain.degraded_subsystem_count, 0);
    assert.equal(kernel.overview.autonomy_maintain.degraded_subsystem_count, 0);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain seeds missing transcript and trichat subsystem state on a cold store", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-maintain-subsystem-seed-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("maintain-subsystem-seed", "autonomy.maintain.run_once", () => mutationCounter++),
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      run_goal_hygiene: false,
      run_task_recovery: false,
      start_runtime_workers: false,
      start_task_auto_retry_daemon: false,
      start_reaction_engine_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      run_optimizer_if_due: false,
      publish_runtime_event: false,
      source_client: "next-wave-test",
    });

    assert.equal(maintain.status.subsystems.transcript_auto_squish.enabled, true);
    assert.equal(maintain.status.subsystems.transcript_auto_squish.running, true);
    assert.equal(maintain.status.subsystems.trichat_auto_retention.enabled, true);
    assert.equal(maintain.status.subsystems.trichat_auto_retention.running, true);
    assert.equal(maintain.status.subsystems.trichat_turn_watchdog.enabled, true);
    assert.equal(maintain.status.subsystems.trichat_turn_watchdog.running, true);
    assert.ok(maintain.status.state.last_actions.includes("transcript.auto_squish.seed"));
    assert.ok(maintain.status.state.last_actions.includes("trichat.auto_retention.seed"));
    assert.ok(maintain.status.state.last_actions.includes("trichat.turn_watchdog.seed"));

    const storage = new Storage(dbPath);
    const transcriptState = storage.getTranscriptAutoSquishState();
    const retentionState = storage.getTriChatAutoRetentionState();
    const watchdogState = storage.getTriChatTurnWatchdogState();
    assert.equal(transcriptState?.enabled, true);
    assert.equal(retentionState?.enabled, true);
    assert.equal(watchdogState?.enabled, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("kernel.summary exposes active swarm coordination profiles and checkpoint counts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-swarm-summary-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("swarm-summary", "goal.create", () => mutationCounter++),
      title: "Swarm summary goal",
      objective: "Compile a hierarchical execution plan with checkpoints.",
      status: "active",
      priority: 7,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["A swarm profile is visible in kernel.summary."],
      constraints: ["Stay bounded and reversible."],
      tags: ["swarm", "kernel"],
    });

    await callTool(session.client, "task.compile", {
      mutation: nextMutation("swarm-summary", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement a bounded multi-step execution plan with verification and rollback.",
      title: "Swarm summary compile",
      create_plan: true,
      selected: true,
      success_criteria: ["Plan exists", "Swarm profile exists"],
    });

    const kernel = await callTool(session.client, "kernel.summary", {
      session_limit: 6,
      event_limit: 6,
      task_running_limit: 8,
    });
    assert.equal(kernel.swarm.active_profile_count >= 1, true);
    assert.equal(kernel.swarm.checkpoint_artifact_count >= 1, true);
    assert.equal(typeof kernel.swarm.active_profiles[0].topology, "string");
    assert.equal(kernel.overview.swarm.active_profile_count >= 1, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow.export writes a reproducible bundle, metrics ledger, and argo contract from a live plan", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-workflow-export-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const exportDir = path.join(tempDir, "workflow-export");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("workflow-export-goal", "goal.create", () => mutationCounter++),
      title: "Workflow export goal",
      objective: "Create a durable workflow export for a compiled plan",
      status: "active",
      priority: 7,
      risk_tier: "medium",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A bundle is exported", "Run metrics are captured", "An Argo contract is emitted"],
      constraints: ["Stay reproducible", "Do not rely on unstored state"],
      tags: ["workflow-export"],
    });

    const compiled = await callTool(session.client, "task.compile", {
      mutation: nextMutation("workflow-export-compile", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement a reproducible workflow export and verify it end to end",
      title: "Workflow export compile",
      create_plan: true,
      selected: true,
      success_criteria: ["Workflow bundle exists", "Metrics ledger exists", "Argo contract exists"],
    });

    const implementationStep = compiled.steps.find((step) => step.step_kind === "mutation");
    assert.ok(implementationStep);

    const task = await callTool(session.client, "task.create", {
      mutation: nextMutation("workflow-export-task", "task.create", () => mutationCounter++),
      objective: "Produce real task lifecycle evidence for the workflow export",
      project_dir: REPO_ROOT,
      priority: 5,
      task_execution: {
        isolation_mode: "git_worktree",
        task_kind: "coding",
        quality_preference: "balanced",
        selected_host_id: "local",
      },
      tags: ["workflow-export", "evidence"],
    });

    await callTool(session.client, "task.claim", {
      mutation: nextMutation("workflow-export-task-claim", "task.claim", () => mutationCounter++),
      task_id: task.task.task_id,
      worker_id: "local-test-worker",
      lease_seconds: 120,
    });

    await callTool(session.client, "task.complete", {
      mutation: nextMutation("workflow-export-task-complete", "task.complete", () => mutationCounter++),
      task_id: task.task.task_id,
      worker_id: "local-test-worker",
      summary: "Task lifecycle completed for export",
      result: {
        ok: true,
      },
    });

    const runBegin = await callTool(session.client, "run.begin", {
      mutation: nextMutation("workflow-export-run-begin", "run.begin", () => mutationCounter++),
      summary: "Workflow export run",
      details: {
        goal_id: goal.goal.goal_id,
      },
    });

    await callTool(session.client, "run.step", {
      mutation: nextMutation("workflow-export-run-step", "run.step", () => mutationCounter++),
      run_id: runBegin.run_id,
      step_index: 1,
      status: "completed",
      summary: "Implementation step produced evidence",
      details: {
        step_id: implementationStep.step_id,
      },
    });

    await callTool(session.client, "run.end", {
      mutation: nextMutation("workflow-export-run-end", "run.end", () => mutationCounter++),
      run_id: runBegin.run_id,
      status: "succeeded",
      summary: "Workflow export run completed",
    });

    await callTool(session.client, "plan.step_update", {
      mutation: nextMutation("workflow-export-step-update", "plan.step_update", () => mutationCounter++),
      plan_id: compiled.plan.plan_id,
      step_id: implementationStep.step_id,
      task_id: task.task.task_id,
      run_id: runBegin.run_id,
      status: "completed",
      summary: "Attached real task and run evidence",
      metadata: {
        export_ready: true,
      },
    });

    await callTool(session.client, "artifact.record", {
      mutation: nextMutation("workflow-export-artifact", "artifact.record", () => mutationCounter++),
      artifact_type: "evidence.bundle",
      goal_id: goal.goal.goal_id,
      plan_id: compiled.plan.plan_id,
      step_id: implementationStep.step_id,
      producer_kind: "tool",
      producer_id: "workflow-export-test",
      trust_tier: "derived",
      content_json: {
        objective: "workflow export evidence",
        task_id: task.task.task_id,
        run_id: runBegin.run_id,
      },
    });

    const exported = await callTool(session.client, "workflow.export", {
      mutation: nextMutation("workflow-export-run", "workflow.export", () => mutationCounter++),
      plan_id: compiled.plan.plan_id,
      output_dir: exportDir,
      export_argo_contract: true,
      export_metrics_jsonl: true,
    });

    assert.equal(exported.ok, true);
    assert.equal(exported.plan_id, compiled.plan.plan_id);
    assert.equal(fs.existsSync(exported.bundle.path), true);
    assert.equal(fs.existsSync(exported.manifest_path), true);
    assert.equal(fs.existsSync(exported.run_metrics_jsonl.path), true);
    assert.equal(fs.existsSync(exported.argo_contract.path), true);

    const bundle = JSON.parse(fs.readFileSync(exported.bundle.path, "utf8"));
    assert.equal(bundle.target.goal_id, goal.goal.goal_id);
    assert.equal(bundle.target.plan_id, compiled.plan.plan_id);
    assert.equal(Array.isArray(bundle.plan.steps), true);
    assert.ok(bundle.plan.steps.length >= 3);
    assert.equal(bundle.runtime.tasks[0].task_id, task.task.task_id);
    assert.equal(bundle.runtime.run_timelines[0].run_id, runBegin.run_id);

    const metricsText = fs.readFileSync(exported.run_metrics_jsonl.path, "utf8");
    assert.match(metricsText, /"kind":"run\.event"/);
    assert.match(metricsText, /"kind":"task\.event"/);
    assert.match(metricsText, /"plan_id":"[^"]+"/);

    const argoText = fs.readFileSync(exported.argo_contract.path, "utf8");
    assert.match(argoText, /kind: WorkflowTemplate/);
    assert.match(argoText, /suspend: \{\}/);
    assert.match(argoText, /mcplayground\.io\/export-contract/);

    const kernel = await callTool(session.client, "kernel.summary", {});
    assert.equal(kernel.workflow_exports.bundle_count >= 1, true);
    assert.equal(kernel.workflow_exports.metrics_count >= 1, true);
    assert.equal(kernel.workflow_exports.argo_contract_count >= 1, true);
    assert.equal(kernel.workflow_exports.latest_bundle.plan_id, compiled.plan.plan_id);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("optimizer promotes stronger org-program candidates and task.compile applies the promoted signals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-optimizer-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "org.program", {
      action: "upsert_role",
      mutation: nextMutation("optimizer-role", "org.program.upsert", () => mutationCounter++),
      role_id: "implementation-director",
      title: "Implementation Director",
      description: "Coordinates implementation work.",
      lane: "implementation",
      version: {
        version_id: "impl-v0",
        summary: "Minimal implementation doctrine",
        doctrine: "Own implementation work for the lane.",
        delegation_contract: "Delegate implementation work when needed.",
        evaluation_standard: "Complete the implementation task.",
        status: "active",
      },
    });

    const stepped = await callTool(session.client, "optimizer", {
      action: "step",
      mutation: nextMutation("optimizer-step", "optimizer.step", () => mutationCounter++),
      role_id: "implementation-director",
      focus_areas: ["bounded_execution", "explicit_evidence", "rollback_ready", "local_first", "verification_first", "fail_closed"],
      objectives: [
        "Implement a bounded local service improvement and verify it with concrete evidence.",
        "Refactor a narrow implementation slice and keep rollback explicit.",
      ],
      promote_if_better: true,
      min_improvement: 1,
    });

    assert.equal(stepped.promoted, true);
    assert.ok(stepped.improvement > 0);
    assert.equal(stepped.experiment_run.status, "completed");

    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("optimizer-goal", "goal.create", () => mutationCounter++),
      title: "Compile with promoted doctrine",
      objective: "Implement a bounded local service improvement and verify it with concrete evidence.",
      acceptance_criteria: ["Work is bounded and evidence-backed."],
      constraints: ["Keep work reversible."],
      assumptions: [],
      risk_tier: "medium",
      autonomy_mode: "execute_bounded",
      priority: 50,
      owner: {
        owner_type: "operator",
        owner_id: "test",
      },
      tags: ["optimizer"],
    });

    const compiled = await callTool(session.client, "task.compile", {
      mutation: nextMutation("optimizer-compile", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement a bounded local service improvement and verify it with concrete evidence.",
      create_plan: false,
    });

    const implementationStep = compiled.steps.find((step) => step.metadata.owner_role_id === "implementation-director");
    assert.ok(implementationStep);
    assert.equal(implementationStep.metadata.org_program_version_id, stepped.candidate_version.version_id);
    assert.equal(implementationStep.metadata.org_program_signals.explicit_evidence, true);
    assert.equal(implementationStep.metadata.org_program_signals.local_first, true);
    assert.equal(implementationStep.metadata.task_execution.preferred_host_tags.includes("local"), true);
    assert.equal(
      implementationStep.acceptance_checks.some((entry) => /evidence is concrete|bounded to one owner|acceptance checks are explicit/i.test(entry)),
      true
    );
    assert.equal(
      implementationStep.input.rollback_notes.some((entry) => /rollback|reversible/i.test(entry)),
      true
    );

    const kernel = await callTool(session.client, "kernel.summary", {});
    assert.equal(kernel.org_programs.optimized_role_count, 1);
    assert.ok(kernel.org_programs.candidate_version_count >= 1);
    assert.equal(kernel.org_programs.roles.some((role) => role.role_id === "implementation-director" && role.last_optimizer_run_at), true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.maintain spends idle headroom on org-program optimization when doctrine is stale", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-optimizer-maintain-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "org.program", {
      action: "upsert_role",
      mutation: nextMutation("optimizer-maintain-role", "org.program.upsert", () => mutationCounter++),
      role_id: "implementation-director",
      title: "Implementation Director",
      description: "Coordinates implementation work.",
      lane: "implementation",
      version: {
        version_id: "impl-maintain-v0",
        summary: "Minimal implementation doctrine",
        doctrine: "Own implementation work for the lane.",
        delegation_contract: "Delegate implementation work when needed.",
        evaluation_standard: "Complete the implementation task.",
        status: "active",
      },
    });

    await callTool(session.client, "goal.create", {
      mutation: nextMutation("optimizer-maintain-goal", "goal.create", () => mutationCounter++),
      title: "Improve implementation doctrine",
      objective: "Implement a bounded local service improvement and verify it with concrete evidence.",
      acceptance_criteria: ["Work is bounded and evidence-backed."],
      constraints: ["Keep work reversible."],
      assumptions: [],
      risk_tier: "medium",
      autonomy_mode: "execute_bounded",
      priority: 50,
      owner: {
        owner_type: "operator",
        owner_id: "test",
      },
      tags: ["optimizer", "maintain"],
    });

    await callTool(session.client, "autonomy.bootstrap", {
      action: "ensure",
      mutation: nextMutation("optimizer-maintain-bootstrap", "autonomy.bootstrap.ensure", () => mutationCounter++),
      autostart_ring_leader: false,
      run_immediately: false,
      local_host_id: "local",
    });

    const maintain = await callTool(session.client, "autonomy.maintain", {
      action: "run_once",
      mutation: nextMutation("optimizer-maintain", "autonomy.maintain.run_once", () => mutationCounter++),
      start_goal_autorun_daemon: false,
      run_goal_hygiene: false,
      run_task_recovery: false,
      start_runtime_workers: false,
      start_task_auto_retry_daemon: false,
      start_reaction_engine_daemon: false,
      maintain_tmux_controller: false,
      run_eval_if_due: false,
      run_optimizer_if_due: true,
      optimizer_interval_seconds: 300,
      optimizer_min_improvement: 1,
      local_host_id: "local",
      source_client: "next-wave-test",
    });

    assert.ok(maintain.actions.some((entry) => entry === `optimizer.step:${maintain.optimizer.role_id}`));
    assert.equal(maintain.optimizer.executed, true);
    assert.equal(["implementation-director", "code-smith"].includes(maintain.optimizer.role_id), true);
    assert.equal(Array.isArray(maintain.optimizer.focus_areas), true);
    assert.equal(maintain.optimizer.focus_areas.length > 0, true);
    assert.equal(Array.isArray(maintain.optimizer.objectives), true);
    assert.equal(maintain.optimizer.objectives.length > 0, true);

    const status = await callTool(session.client, "autonomy.maintain", {
      action: "status",
      optimizer_interval_seconds: 300,
      local_host_id: "local",
    });
    assert.equal(typeof status.optimizer.selected_role_id, "string");
    assert.equal(Array.isArray(status.optimizer.focus_areas), true);
    assert.equal(status.local_capacity.runtime_worker_max_active >= 1, true);

    const kernel = await callTool(session.client, "kernel.summary", {});
    assert.equal(kernel.org_programs.roles.some((role) => typeof role.last_optimizer_run_at === "string" && role.last_optimizer_run_at.length > 0), true);
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
    { name: "mcp-next-wave-runtime-test", version: "0.1.0" },
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

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function run(command, cwd) {
  const result = spawnSync("/bin/sh", ["-lc", command], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr}`);
  }
}

async function startFakeOllamaServer({ models }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.6.0" }));
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/api/ps") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "llama3.2:3b",
              model: "llama3.2:3b",
              size_vram: 2_147_483_648,
              context_length: 8192,
              expires_at: "2026-03-30T02:30:00Z",
            },
          ],
        })
      );
      return;
    }
    if (req.url === "/api/generate") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        assert.equal(payload.model, "llama3.2:3b");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            response: "ok",
            done: true,
            total_duration: 300_000_000,
            eval_count: 8,
            eval_duration: 200_000_000,
          })
        );
      });
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

async function startStatefulFakeOllamaServer() {
  let loaded = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.6.0" }));
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }] }));
      return;
    }
    if (req.url === "/api/ps") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: loaded
            ? [
                {
                  name: "llama3.2:3b",
                  model: "llama3.2:3b",
                  size_vram: 2_147_483_648,
                  context_length: 8192,
                  expires_at: "2026-03-30T02:30:00Z",
                },
              ]
            : [],
        })
      );
      return;
    }
    if (req.url === "/api/generate") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        if (payload.keep_alive === 0) {
          loaded = false;
        } else if (payload.keep_alive) {
          loaded = true;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            response: "ok",
            done: true,
            total_duration: 320_000_000,
            eval_count: 8,
            eval_duration: 200_000_000,
          })
        );
      });
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
