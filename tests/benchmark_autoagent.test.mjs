import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

// ---------- reward_file metric mode tests ----------

test("benchmark.run reward_file metric mode reads score from a file written by the command", async () => {
  const testId = `${Date.now()}-reward-file`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-reward-file-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'test@example.com'", tempDir);
  run("git config user.name 'Test'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "# reward_file test\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Reward file bench",
      objective: "Verify reward_file metric mode reads a numeric score from disk",
      project_dir: tempDir,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "reward_score",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "reward-write",
          title: "Write 0.85 to reward.txt and read it back",
          command: "echo '0.85' > reward.txt",
          metric_name: "reward_score",
          metric_direction: "maximize",
          metric_mode: "reward_file",
          reward_file_path: "reward.txt",
        },
      ],
      tags: ["benchmark", "reward_file", "autoagent"],
    });

    assert.ok(suite.suite);
    assert.equal(suite.suite.cases[0].metric_mode, "reward_file");
    assert.equal(suite.suite.cases[0].reward_file_path, "reward.txt");

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "reward-file-test",
    });

    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results.length, 1);
    assert.equal(runResult.case_results[0].ok, true);
    assert.equal(runResult.case_results[0].metric_value, 0.85);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("benchmark.run reward_file mode reports null metric when file does not exist", async () => {
  const testId = `${Date.now()}-reward-missing`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-benchmark-reward-missing-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'test@example.com'", tempDir);
  run("git config user.name 'Test'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "# reward missing\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const suite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation(testId, "benchmark.suite_upsert", () => mutationCounter++),
      title: "Missing reward file",
      objective: "Verify reward_file mode handles missing file gracefully",
      project_dir: tempDir,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "reward_score",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "no-reward",
          title: "Command succeeds but reward file is absent",
          command: "echo 'no reward file written'",
          metric_name: "reward_score",
          metric_direction: "maximize",
          metric_mode: "reward_file",
          reward_file_path: "nonexistent_reward.txt",
        },
      ],
      tags: ["benchmark", "reward_file", "edge-case"],
    });

    const runResult = await callTool(session.client, "benchmark.run", {
      mutation: nextMutation(testId, "benchmark.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "missing-reward",
    });

    // ok is false because metric_value is null when the reward file is missing
    assert.equal(runResult.case_results[0].metric_value, null);
    assert.equal(runResult.case_results[0].ok, false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Harbor adapter tests ----------

test("harbor adapter discovers tasks from a Harbor-format directory", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-harbor-adapter-"));

  // Create Harbor-format task structure
  const task1Dir = path.join(tempDir, "tasks", "sort-numbers");
  const task2Dir = path.join(tempDir, "tasks", "fizzbuzz");
  fs.mkdirSync(path.join(task1Dir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(task2Dir, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(task1Dir, "task.toml"),
    `name = "Sort Numbers"\ndescription = "Implement a number sorting algorithm"\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(task1Dir, "instruction.md"), "Sort a list of integers in ascending order.\n", "utf8");
  fs.writeFileSync(path.join(task1Dir, "tests", "test.sh"), '#!/bin/bash\necho "0.95" > /logs/reward.txt\n', "utf8");

  fs.writeFileSync(
    path.join(task2Dir, "task.toml"),
    `name = "FizzBuzz"\ndescription = "Classic FizzBuzz implementation"\nreward_file = "logs/reward.txt"\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(task2Dir, "instruction.md"), "Implement FizzBuzz.\n", "utf8");
  fs.writeFileSync(path.join(task2Dir, "tests", "test.sh"), '#!/bin/bash\necho "1.0" > logs/reward.txt\n', "utf8");

  try {
    // Dynamic import since harbor_adapter is TypeScript compiled to dist/
    const { discoverHarborTasks, harborTasksToSuitePayload, readHarborTask } = await import(
      path.join(REPO_ROOT, "dist", "tools", "harbor_adapter.js")
    );

    // Test individual task reading
    const task = readHarborTask(task1Dir);
    assert.equal(task.task_id, "sort-numbers");
    assert.equal(task.name, "Sort Numbers");
    assert.ok(task.instruction.includes("Sort a list"));
    assert.ok(task.test_command.includes("test.sh"));

    // Test directory discovery
    const tasks = discoverHarborTasks(path.join(tempDir, "tasks"));
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].task_id, "fizzbuzz");
    assert.equal(tasks[1].task_id, "sort-numbers");

    // Test suite payload generation
    const payload = harborTasksToSuitePayload(tasks, {
      suite_title: "Harbor Smoke Suite",
      project_dir: tempDir,
    });
    assert.equal(payload.title, "Harbor Smoke Suite");
    assert.equal(payload.cases.length, 2);
    assert.equal(payload.cases[0].metric_mode, "reward_file");
    assert.ok(payload.tags.includes("harbor"));
    assert.equal(payload.aggregate_metric_name, "reward_score");

    // Test custom reward_file path from task.toml
    assert.equal(tasks[0].reward_file_path, "logs/reward.txt");
    assert.equal(tasks[1].reward_file_path, "/logs/reward.txt");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("harbor adapter handles empty or missing tasks directory", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-harbor-empty-"));

  try {
    const { discoverHarborTasks, harborTasksToSuitePayload } = await import(
      path.join(REPO_ROOT, "dist", "tools", "harbor_adapter.js")
    );

    // Non-existent directory
    const noTasks = discoverHarborTasks(path.join(tempDir, "nonexistent"));
    assert.equal(noTasks.length, 0);

    // Empty directory
    fs.mkdirSync(path.join(tempDir, "tasks"));
    const emptyTasks = discoverHarborTasks(path.join(tempDir, "tasks"));
    assert.equal(emptyTasks.length, 0);

    // Throws on empty task list
    assert.throws(() => harborTasksToSuitePayload([]), /No Harbor tasks/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- helpers ----------

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "mcp-benchmark-autoagent-test", version: "0.1.0" },
    { capabilities: {} },
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
    { name, arguments: args },
    undefined,
    { timeout: 180000 },
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

function run(command, cwd) {
  const result = spawnSync("/bin/sh", ["-lc", command], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr}`);
  }
}
