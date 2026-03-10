import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();
const AUTOPILOT_TICK_LOCK_KEY = "trichat.autopilot.tick";

test("trichat.autopilot restores state and preserves replay/safety invariants", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const replayThreadId = `trichat-autopilot-replay-${testId}`;
  let mutationCounter = 0;

  try {
    const sessionOne = await openClient(dbPath);
    try {
      const started = await callTool(sessionOne.client, "trichat.autopilot", {
        action: "start",
        mutation: nextMutation(testId, "trichat.autopilot-start", () => mutationCounter++),
        interval_seconds: 19,
        thread_id: `trichat-autopilot-persist-${testId}`,
        thread_title: `TriChat Autopilot Persist ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        run_immediately: false,
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });
      assert.equal(started.running, true);
      assert.equal(started.persisted.enabled, true);
      assert.equal(started.persisted.interval_seconds, 19);

      const storageHealth = await callTool(sessionOne.client, "health.storage", {});
      assert.equal(typeof storageHealth.table_counts.daemon_configs, "number");
    } finally {
      await sessionOne.client.close().catch(() => {});
    }

    const sessionTwo = await openClient(dbPath);
    try {
      const restoredStatus = await callTool(sessionTwo.client, "trichat.autopilot", {
        action: "status",
      });
      assert.equal(restoredStatus.running, true);
      assert.equal(restoredStatus.config.interval_seconds, 19);
      assert.equal(restoredStatus.config.away_mode, "normal");

      const stopped = await callTool(sessionTwo.client, "trichat.autopilot", {
        action: "stop",
        mutation: nextMutation(testId, "trichat.autopilot-stop", () => mutationCounter++),
      });
      assert.equal(stopped.running, false);
      assert.equal(stopped.persisted.enabled, false);
    } finally {
      await sessionTwo.client.close().catch(() => {});
    }

    const sessionThree = await openClient(dbPath);
    try {
      const heldOwner = `external-overlap-${testId}`;
      const held = await callTool(sessionThree.client, "lock.acquire", {
        mutation: nextMutation(testId, "lock.acquire-overlap", () => mutationCounter++),
        lock_key: AUTOPILOT_TICK_LOCK_KEY,
        owner_id: heldOwner,
        lease_seconds: 120,
      });
      assert.equal(held.acquired, true);

      const overlapTick = await callTool(sessionThree.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-overlap", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: replayThreadId,
        thread_title: `TriChat Autopilot Replay ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });
      assert.equal(overlapTick.tick.ok, true);
      assert.ok(
        overlapTick.tick.step_status.some((entry) => entry.name === "single_flight" && entry.status === "skipped")
      );

      const overlapTimeline = await callTool(sessionThree.client, "run.timeline", {
        run_id: overlapTick.tick.run_id,
        limit: 30,
      });
      assert.ok(
        overlapTimeline.events.some(
          (event) => event.event_type === "step" && event.status === "skipped"
        ),
        "Expected overlap skip run.step evidence"
      );

      await callTool(sessionThree.client, "lock.release", {
        mutation: nextMutation(testId, "lock.release-overlap", () => mutationCounter++),
        lock_key: AUTOPILOT_TICK_LOCK_KEY,
        owner_id: heldOwner,
      });

      const firstFailure = await callTool(sessionThree.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-fail-1", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: replayThreadId,
        thread_title: `TriChat Autopilot Replay ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.99,
        adr_policy: "manual",
      });
      assert.equal(firstFailure.tick.ok, false);
      assert.equal(firstFailure.tick.emergency_brake_triggered, true);
      assert.ok(firstFailure.tick.reason);

      const timelineAfterFirstFailure = await callTool(sessionThree.client, "run.timeline", {
        run_id: firstFailure.tick.run_id,
        limit: 100,
      });
      const replayThreadTimelineA = await callTool(sessionThree.client, "trichat.timeline", {
        thread_id: replayThreadId,
        limit: 500,
      });

      const secondFailureReplay = await callTool(sessionThree.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-fail-2", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: replayThreadId,
        thread_title: `TriChat Autopilot Replay ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.99,
        adr_policy: "manual",
      });

      assert.equal(secondFailureReplay.tick.run_id, firstFailure.tick.run_id);
      const timelineAfterSecondFailure = await callTool(sessionThree.client, "run.timeline", {
        run_id: secondFailureReplay.tick.run_id,
        limit: 100,
      });
      assert.equal(
        timelineAfterSecondFailure.count,
        timelineAfterFirstFailure.count,
        "Expected same-session replay to avoid duplicate run events"
      );

      const replayThreadTimelineB = await callTool(sessionThree.client, "trichat.timeline", {
        thread_id: replayThreadId,
        limit: 500,
      });
      assert.equal(
        replayThreadTimelineB.count,
        replayThreadTimelineA.count,
        "Expected same-session replay to avoid duplicate thread side effects"
      );

      const tickLockProbeOwner = `tick-lock-probe-${testId}`;
      const tickLockProbe = await callTool(sessionThree.client, "lock.acquire", {
        mutation: nextMutation(testId, "lock.acquire-probe", () => mutationCounter++),
        lock_key: AUTOPILOT_TICK_LOCK_KEY,
        owner_id: tickLockProbeOwner,
        lease_seconds: 120,
      });
      assert.equal(
        tickLockProbe.acquired,
        true,
        "Expected tick lock to be released after failure path"
      );
      await callTool(sessionThree.client, "lock.release", {
        mutation: nextMutation(testId, "lock.release-probe", () => mutationCounter++),
        lock_key: AUTOPILOT_TICK_LOCK_KEY,
        owner_id: tickLockProbeOwner,
      });

      const statusAfterBrake = await callTool(sessionThree.client, "trichat.autopilot", {
        action: "status",
      });
      assert.equal(statusAfterBrake.running, false);
      assert.equal(typeof statusAfterBrake.pause_reason, "string");
    } finally {
      await sessionThree.client.close().catch(() => {});
    }

    const sessionFour = await openClient(dbPath);
    try {
      const restoredAfterBrake = await callTool(sessionFour.client, "trichat.autopilot", {
        action: "status",
      });
      assert.equal(restoredAfterBrake.running, false);
      assert.equal(typeof restoredAfterBrake.pause_reason, "string");
    } finally {
      await sessionFour.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(dbPath) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(path.dirname(dbPath), "trichat.bus.sock"),
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-trichat-autopilot-persistence-test", version: "0.1.0" },
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
