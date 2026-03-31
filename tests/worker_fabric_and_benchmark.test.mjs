import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("worker.fabric can register a remote host and expose host-aware worker slots", async () => {
  const testId = `${Date.now()}-worker-fabric`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-worker-fabric-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const before = await callTool(session.client, "worker.fabric", {
      action: "status",
      fallback_workspace_root: tempDir,
      fallback_worker_count: 2,
    });
    assert.equal(before.state.default_host_id, "local");
    assert.equal(before.slots.length, 2);
    assert.equal(before.slots[0].worker_id, "worker-1");

    await callTool(session.client, "worker.fabric", {
      action: "configure",
      mutation: nextMutation(testId, "worker.fabric.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_capacity",
    });
    const configured = await callTool(session.client, "worker.fabric", {
      action: "upsert_host",
      mutation: nextMutation(testId, "worker.fabric.upsert", () => mutationCounter++),
      host: {
        host_id: "pve1",
        transport: "ssh",
        ssh_destination: "root@10.0.0.50",
        workspace_root: "/srv/agentic/MCPlayground---Core-Template",
        worker_count: 2,
        shell: "/bin/bash",
        capabilities: {
          gpu_memory_gb: 80,
          ram_gb: 128,
        },
        tags: ["remote", "gpu"],
      },
    });

    assert.equal(configured.state.enabled, true);
    assert.equal(configured.state.hosts.some((host) => host.host_id === "pve1"), true);

    const after = await callTool(session.client, "worker.fabric", {
      action: "status",
      fallback_workspace_root: tempDir,
      fallback_worker_count: 1,
    });
    assert.equal(after.state.default_host_id, "pve1");
    assert.equal(after.slots.some((slot) => slot.worker_id === "pve1--worker-1"), true);
    assert.equal(after.slots.some((slot) => slot.host_id === "pve1"), true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.tmux_controller dispatches onto a configured remote host with isolation metadata", async () => {
  const testId = `${Date.now()}-tmux-remote`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tmux-remote-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_TMUX_DRY_RUN: "1",
  });

  try {
    await callTool(session.client, "worker.fabric", {
      action: "configure",
      mutation: nextMutation(testId, "worker.fabric.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_capacity",
    });
    await callTool(session.client, "worker.fabric", {
      action: "upsert_host",
      mutation: nextMutation(testId, "worker.fabric.upsert", () => mutationCounter++),
      host: {
        host_id: "pve1",
        transport: "ssh",
        ssh_destination: "root@10.0.0.50",
        workspace_root: "/srv/agentic/MCPlayground---Core-Template",
        worker_count: 1,
        tags: ["remote", "gpu"],
        capabilities: {
          gpu_memory_gb: 80,
        },
      },
    });

    await callTool(session.client, "trichat.tmux_controller", {
      action: "start",
      mutation: nextMutation(testId, "tmux.start", () => mutationCounter++),
      session_name: `tmux-remote-${testId}`,
      workspace: tempDir,
      worker_count: 1,
      max_queue_per_worker: 2,
    });

    const dispatch = await callTool(session.client, "trichat.tmux_controller", {
      action: "dispatch",
      mutation: nextMutation(testId, "tmux.dispatch", () => mutationCounter++),
      session_name: `tmux-remote-${testId}`,
      workspace: tempDir,
      tasks: [
        {
          title: "Remote verify",
          command: "echo verify-remote",
          project_dir: tempDir,
          host_id: "pve1",
          isolation_mode: "copy",
          priority: 90,
          complexity: 40,
        },
      ],
    });

    assert.equal(dispatch.ok, true);
    assert.equal(dispatch.dispatched_count, 1);
    assert.equal(dispatch.assignment.assigned[0].worker_id, "pve1--worker-1");

    const status = await callTool(session.client, "trichat.tmux_controller", {
      action: "status",
      session_name: `tmux-remote-${testId}`,
      include_completed: true,
    });
    const remoteTask = status.state.tasks.find((task) => task.worker_id === "pve1--worker-1");
    assert.ok(remoteTask);
    assert.equal(remoteTask.metadata.task_execution.host_id, "pve1");
    assert.equal(remoteTask.metadata.task_execution.isolation_mode, "copy");
    assert.ok(String(remoteTask.metadata.isolated_workspace).includes(".mcp-isolation"));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("benchmark.run executes a real isolated suite and records durable run evidence", async () => {
  const testId = `${Date.now()}-benchmark`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-suite-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'codex@example.com'", tempDir);
  run("git config user.name 'Codex'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "# benchmark\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Smoke bench",
      objective: "Verify isolated benchmark execution on the local repo",
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
        {
          case_id: "stdout-metric",
          title: "Regex metric",
          command: "node -e \"console.log(42)\"",
          metric_name: "stdout_value",
          metric_direction: "maximize",
          metric_mode: "stdout_regex",
          metric_regex: "(42)",
        },
      ],
      tags: ["benchmark", "smoke"],
    });

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "baseline",
    });

    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results.length, 2);
    assert.ok(String(runResult.case_results[0].workspace).includes(".mcp-isolation"));
    assert.equal(fs.existsSync(runResult.case_results[0].workspace), true);

    const timeline = await callTool(session.client, "run.timeline", {
      run_id: runResult.run_id,
      limit: 10,
    });
    assert.ok(timeline.events.length >= 4);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("benchmark.run isolated workspaces inherit repo toolchains needed for real evals", async () => {
  const testId = `${Date.now()}-benchmark-toolchain`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-toolchain-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Repo toolchain bench",
      objective: "Verify isolated repo workspaces can use the checked-out Node toolchain",
      project_dir: REPO_ROOT,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "tsc-version",
          title: "TypeScript binary is on PATH inside isolation",
          command: "tsc --version",
        },
        {
          case_id: "sdk-resolve",
          title: "Repo dependencies resolve inside isolation",
          command: "node -e \"console.log(require.resolve('@modelcontextprotocol/sdk/client/index.js'))\"",
        },
      ],
      tags: ["benchmark", "toolchain", "isolation"],
    });

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "repo-toolchain",
    });

    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results.every((entry) => entry.ok === true), true);
    assert.ok(runResult.case_results.every((entry) => String(entry.workspace).includes(".mcp-isolation")));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("benchmark.run git_worktree isolation overlays dirty working tree changes", async () => {
  const testId = `${Date.now()}-benchmark-dirty-overlay`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-dirty-overlay-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'codex@example.com'", tempDir);
  run("git config user.name 'Codex'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "baseline\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "dirty-working-tree\n", "utf8");

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Dirty overlay bench",
      objective: "Verify git_worktree isolation sees current dirty workspace content",
      project_dir: tempDir,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "readme-overlay",
          title: "Dirty README content is visible in isolated workspace",
          command: "grep -q 'dirty-working-tree' README.md",
        },
      ],
      tags: ["benchmark", "overlay", "isolation"],
    });

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "dirty-overlay",
    });

    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results[0].ok, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("benchmark.run can clean isolated workspaces when suite metadata requests it", async () => {
  const testId = `${Date.now()}-benchmark-cleanup`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-cleanup-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'codex@example.com'", tempDir);
  run("git config user.name 'Codex'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "# cleanup\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Cleanup bench",
      objective: "Verify benchmark suites can remove isolated workspaces after the run",
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
      tags: ["benchmark", "cleanup", "isolation"],
      metadata: {
        cleanup_workspaces: true,
      },
    });

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "cleanup",
    });

    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(fs.existsSync(runResult.case_results[0].workspace), false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("benchmark.run isolated MCP smoke commands can self-heal missing dist outputs", async () => {
  const testId = `${Date.now()}-benchmark-mcp-stdio`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-mcp-stdio-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    MCP_BACKGROUND_OWNER: "1",
    TRICHAT_BUS_AUTOSTART: "1",
    TRICHAT_RING_LEADER_AUTOSTART: "0",
    MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
    MCP_AUTONOMY_MAINTAIN_ON_START: "0",
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Repo stdio MCP bench",
      objective: "Verify isolated repo workspaces can build or reuse dist before stdio MCP checks",
      project_dir: REPO_ROOT,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "storage-health",
          title: "Storage health is reachable inside isolation",
          command:
            "([ -f dist/server.js ] || npm run build >/dev/null) && node ./scripts/mcp_tool_call.mjs --tool health.storage --args '{}' --transport stdio --stdio-command node --stdio-args 'dist/server.js' --cwd . >/dev/null",
        },
        {
          case_id: "roster-health",
          title: "TriChat roster is reachable inside isolation",
          command:
            "([ -f dist/server.js ] || npm run build >/dev/null) && node ./scripts/mcp_tool_call.mjs --tool trichat.roster --args '{}' --transport stdio --stdio-command node --stdio-args 'dist/server.js' --cwd . >/dev/null",
        },
      ],
      tags: ["benchmark", "mcp", "stdio", "isolation"],
    });

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "repo-mcp-stdio",
    });

    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results.every((entry) => entry.ok === true), true);
    assert.ok(runResult.case_results.every((entry) => String(entry.workspace).includes(".mcp-isolation")));
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
    { name: "mcp-worker-fabric-benchmark-test", version: "0.1.0" },
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

function run(command, cwd) {
  const result = spawnSync("/bin/sh", ["-lc", command], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr}`);
  }
}
