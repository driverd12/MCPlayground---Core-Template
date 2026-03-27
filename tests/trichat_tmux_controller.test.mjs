import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("trichat.tmux_controller supports durable start/dispatch/stop flow with idempotent replay", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-tmux-controller-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const baseEnv = {
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_TMUX_DRY_RUN: "1",
  };

  try {
    const first = await openClient(baseEnv);
    try {
      const toolNames = new Set((await listTools(first.client)).map((tool) => tool.name));
      assert.equal(toolNames.has("trichat.tmux_controller"), true);

      const statusBefore = await callTool(first.client, "trichat.tmux_controller", {
        action: "status",
      });
      assert.equal(statusBefore.state.enabled, false);
      assert.ok(statusBefore.dashboard);
      assert.equal(statusBefore.dashboard.failure_class, "none");
      assert.ok(Array.isArray(statusBefore.dashboard.worker_load));
      for (const worker of statusBefore.dashboard.worker_load) {
        assert.equal(typeof worker.lane_state, "string");
        assert.equal(typeof worker.lane_updated_at, "string");
      }

      const startResult = await callTool(first.client, "trichat.tmux_controller", {
        action: "start",
        mutation: nextMutation(testId, "trichat.tmux_controller-start", () => mutationCounter++),
        session_name: `trichat-test-${testId}`,
        workspace: tempDir,
        worker_count: 2,
        max_queue_per_worker: 4,
      });
      assert.equal(startResult.ok, true);
      assert.equal(startResult.status.enabled, true);
      assert.equal(startResult.status.worker_count, 2);

      const dispatchMutation = nextMutation(testId, "trichat.tmux_controller-dispatch", () => mutationCounter++);
      const dispatchArgs = {
        action: "dispatch",
        mutation: dispatchMutation,
        tasks: [
          {
            title: "Heavy architecture task",
            command: "echo heavy",
            priority: 100,
            complexity: 90,
          },
          {
            title: "Quick docs task",
            command: "echo docs",
            priority: 90,
            complexity: 40,
          },
          {
            title: "Implementation task",
            command: "echo implement",
            priority: 80,
            complexity: 80,
          },
          {
            title: "Small follow-up",
            command: "echo followup",
            priority: 70,
            complexity: 20,
          },
        ],
      };

      const dispatchResult = await callTool(first.client, "trichat.tmux_controller", dispatchArgs);
      assert.equal(dispatchResult.ok, true);
      assert.equal(dispatchResult.dispatched_count, 4);
      assert.equal(dispatchResult.assignment.assigned.length, 4);
      assert.equal(dispatchResult.assignment.unassigned.length, 0);
      assert.ok(dispatchResult.dashboard);
      assert.equal(typeof dispatchResult.dashboard.queue_depth, "number");
      assert.ok(Array.isArray(dispatchResult.dashboard.worker_load));
      assert.equal(dispatchResult.dashboard.worker_load.length, 2);
      for (const worker of dispatchResult.dashboard.worker_load) {
        assert.equal(typeof worker.lane_state, "string");
        assert.equal(typeof worker.lane_updated_at, "string");
      }

      const assignmentMap = new Map(
        dispatchResult.assignment.assigned.map((entry) => [entry.seq, entry.worker_id])
      );
      assert.equal(assignmentMap.get(1), "worker-1");
      assert.equal(assignmentMap.get(2), "worker-2");
      assert.equal(assignmentMap.get(3), "worker-2");
      assert.equal(assignmentMap.get(4), "worker-1");

      const replayDispatch = await callTool(first.client, "trichat.tmux_controller", dispatchArgs);
      assert.equal(replayDispatch.dispatched_count, dispatchResult.dispatched_count);

      const guardedDispatch = await callTool(first.client, "trichat.tmux_controller", {
        action: "dispatch",
        mutation: nextMutation(testId, "trichat.tmux_controller-dispatch-ownership-guard", () => mutationCounter++),
        tasks: [
          {
            title: "Ownership guarded write lane A",
            command: "git add README.md",
            priority: 85,
            complexity: 70,
            metadata: {
              ownership_scope: "src",
              ownership_mode: "mutating",
            },
          },
          {
            title: "Ownership guarded write lane B",
            command: "git commit -m 'ownership guard check'",
            priority: 84,
            complexity: 69,
            metadata: {
              ownership_scope: "src",
              ownership_mode: "mutating",
            },
          },
        ],
      });
      assert.ok(guardedDispatch.assignment.unassigned.length >= 1);
      assert.ok(
        guardedDispatch.assignment.unassigned.some((entry) =>
          String(entry.reason).includes("ownership scope busy")
        )
      );

      const protectedDispatch = await callTool(first.client, "trichat.tmux_controller", {
        action: "dispatch",
        mutation: nextMutation(testId, "trichat.tmux_controller-dispatch-db-guard", () => mutationCounter++),
        tasks: [
          {
            title: "Attempt db overwrite",
            command: "echo bad > data/hub.sqlite",
            priority: 95,
            complexity: 60,
          },
        ],
      });
      assert.equal(protectedDispatch.ok, false);
      assert.ok(
        protectedDispatch.failures.some((entry) =>
          String(entry.error).toLowerCase().includes("protected db artifact")
        )
      );

      const maintainResult = await callTool(first.client, "trichat.tmux_controller", {
        action: "maintain",
        mutation: nextMutation(testId, "trichat.tmux_controller-maintain", () => mutationCounter++),
        min_worker_count: 1,
        max_worker_count: 4,
        target_queue_per_worker: 1,
        auto_scale_workers: true,
        nudge_blocked_lanes: true,
      });
      assert.equal(maintainResult.action, "maintain");
      assert.ok(maintainResult.maintenance);
      assert.equal(maintainResult.maintenance.scaled_up, true);
      assert.ok(maintainResult.status.worker_count >= 3);
      assert.ok(Array.isArray(maintainResult.maintenance.nudges));

      const statusAfterDispatch = await callTool(first.client, "trichat.tmux_controller", {
        action: "status",
        include_completed: true,
      });
      assert.ok(statusAfterDispatch.state.counts.total >= 6);
      assert.ok(statusAfterDispatch.state.counts.dispatched >= 5);
      assert.ok(statusAfterDispatch.state.counts.queued >= 1);
      assert.ok(statusAfterDispatch.dashboard);
      assert.equal(typeof statusAfterDispatch.dashboard.queue_depth, "number");
      assert.ok(Array.isArray(statusAfterDispatch.dashboard.worker_load));
      for (const worker of statusAfterDispatch.dashboard.worker_load) {
        assert.equal(typeof worker.lane_state, "string");
      }
      const dbHeader = fs.readFileSync(dbPath, { encoding: "utf8", flag: "r" }).slice(0, 16);
      assert.equal(dbHeader, "SQLite format 3\u0000");

      const syncResult = await callTool(first.client, "trichat.tmux_controller", {
        action: "sync",
        mutation: nextMutation(testId, "trichat.tmux_controller-sync", () => mutationCounter++),
      });
      assert.equal(syncResult.ok, true);
      assert.ok(syncResult.dashboard);

      const stopResult = await callTool(first.client, "trichat.tmux_controller", {
        action: "stop",
        mutation: nextMutation(testId, "trichat.tmux_controller-stop", () => mutationCounter++),
      });
      assert.equal(stopResult.status.enabled, false);
      assert.equal(stopResult.status.counts.queued, 0);
      assert.equal(stopResult.status.counts.dispatched, 0);
      assert.equal(stopResult.status.counts.running, 0);
      assert.ok(stopResult.status.counts.cancelled >= 4);
    } finally {
      await first.client.close().catch(() => {});
    }

    const second = await openClient(baseEnv);
    try {
      const restored = await callTool(second.client, "trichat.tmux_controller", {
        action: "status",
        include_completed: true,
      });
      assert.equal(restored.state.enabled, false);
      assert.equal(restored.state.counts.queued, 0);
      assert.equal(restored.state.counts.dispatched, 0);
      assert.equal(restored.state.counts.running, 0);
      assert.ok(restored.state.counts.cancelled >= 4);
      assert.ok(restored.state.counts.total >= 4);
    } finally {
      await second.client.close().catch(() => {});
    }
  } finally {
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
    { name: "mcp-trichat-tmux-controller-test", version: "0.1.0" },
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

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function listTools(client) {
  const response = await client.listTools();
  return response.tools ?? [];
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
