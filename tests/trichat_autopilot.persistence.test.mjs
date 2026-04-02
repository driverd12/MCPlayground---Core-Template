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
        lead_agent_id: "codex",
        specialist_agent_ids: ["cursor", "local-imprint"],
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
      assert.equal(started.persisted.lead_agent_id, "codex");
      assert.deepEqual(started.persisted.specialist_agent_ids, ["cursor", "local-imprint"]);
      assert.equal(started.status.session.found, true);
      assert.equal(started.status.session.session.agent_id, "codex");
      assert.equal(started.status.effective_agent_pool.lead_agent_id, "codex");
      assert.deepEqual(started.status.effective_agent_pool.specialist_agent_ids, ["cursor", "local-imprint"]);

      const storageHealth = await callTool(sessionOne.client, "health.storage", {});
      assert.equal(typeof storageHealth.table_counts.daemon_configs, "number");

      const activeSessions = await callTool(sessionOne.client, "agent.session_list", {
        active_only: true,
        limit: 20,
      });
      assert.ok(activeSessions.sessions.some((entry) => entry.session_id === started.status.session.session_id));
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
      assert.equal(restoredStatus.config.lead_agent_id, "codex");
      assert.deepEqual(restoredStatus.config.specialist_agent_ids, ["cursor", "local-imprint"]);
      assert.equal(restoredStatus.session.found, true);
      assert.equal(restoredStatus.session.session.agent_id, "codex");
      assert.equal(restoredStatus.effective_agent_pool.lead_agent_id, "codex");
      assert.deepEqual(restoredStatus.effective_agent_pool.specialist_agent_ids, ["cursor", "local-imprint"]);

      const stopped = await callTool(sessionTwo.client, "trichat.autopilot", {
        action: "stop",
        mutation: nextMutation(testId, "trichat.autopilot-stop", () => mutationCounter++),
      });
      assert.equal(stopped.running, false);
      assert.equal(stopped.persisted.enabled, false);

      const activeSessionsAfterStop = await callTool(sessionTwo.client, "agent.session_list", {
        active_only: true,
        limit: 20,
      });
      assert.equal(
        activeSessionsAfterStop.sessions.some((entry) => entry.session_id === restoredStatus.session.session_id),
        false
      );
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
        thread_id: `${replayThreadId}-a`,
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
      assert.equal(firstFailure.tick.emergency_brake_triggered, false);
      assert.ok(firstFailure.tick.reason);
      assert.equal(firstFailure.status.pause_reason, null);

      const timelineAfterFirstFailure = await callTool(sessionThree.client, "run.timeline", {
        run_id: firstFailure.tick.run_id,
        limit: 100,
      });
      const replayThreadTimelineA = await callTool(sessionThree.client, "trichat.timeline", {
        thread_id: `${replayThreadId}-a`,
        limit: 500,
      });

      const secondFailureReplay = await callTool(sessionThree.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-fail-2", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: `${replayThreadId}-a`,
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
        thread_id: `${replayThreadId}-a`,
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

      const secondDistinctFailure = await callTool(sessionThree.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-fail-3", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: `${replayThreadId}-b`,
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
      assert.equal(secondDistinctFailure.tick.ok, false);
      assert.equal(secondDistinctFailure.tick.emergency_brake_triggered, true);

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

test("trichat.autopilot routes source task claims and reports through the durable agent session", async () => {
  const testId = `${Date.now()}-agent-session`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-agent-session-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  try {
    const session = await openClient(dbPath);
    try {
      const threadId = `trichat-autopilot-agent-session-${testId}`;
      const started = await callTool(session.client, "trichat.autopilot", {
        action: "start",
        mutation: nextMutation(testId, "trichat.autopilot-start-agent-session", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: threadId,
        thread_title: `TriChat Autopilot Agent Session ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        lead_agent_id: "codex",
        specialist_agent_ids: ["cursor"],
        run_immediately: false,
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });

      const sessionId = started.status.session.session_id;
      assert.equal(started.status.session.session.capabilities.capability_tier, "high");
      assert.equal(started.status.session.session.capabilities.planning, true);

      const sourceTaskId = `autopilot-agent-session-source-${testId}`;
      await callTool(session.client, "task.create", {
        mutation: nextMutation(testId, "task.create-agent-session-source", () => mutationCounter++),
        task_id: sourceTaskId,
        objective:
          "Inspect kernel state, choose one bounded next action, and delegate a specialist follow-up with explicit rollback notes and verification.",
        project_dir: REPO_ROOT,
        priority: 95,
        tags: ["trichat", "autopilot", "agent-session-test"],
        source: "test",
      });

      const worklist = await callTool(session.client, "agent.worklist", {
        session_id: sessionId,
        limit: 10,
        scan_limit: 20,
        include_ineligible: true,
      });
      assert.ok(worklist.tasks.some((entry) => entry.task_id === sourceTaskId));
      assert.equal(worklist.ineligible_tasks.some((entry) => entry.task_id === sourceTaskId), false);

      const runOnce = await callTool(session.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-agent-session", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: threadId,
        thread_title: `TriChat Autopilot Agent Session ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        lead_agent_id: "codex",
        specialist_agent_ids: ["cursor"],
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });
      assert.equal(runOnce.tick.ok, true);
      assert.equal(runOnce.tick.source_task_id, sourceTaskId);

      const sessionAfter = await callTool(session.client, "agent.session_get", {
        session_id: sessionId,
      });
      assert.equal(sessionAfter.found, true);
      assert.equal(sessionAfter.session.metadata.last_claimed_task_id, sourceTaskId);
      assert.equal(sessionAfter.session.metadata.last_reported_task_id, sourceTaskId);
      assert.equal(sessionAfter.session.metadata.last_report_outcome, "completed");
      assert.equal(sessionAfter.session.metadata.adaptive_worker_profile.total_claims, 1);
      assert.equal(sessionAfter.session.metadata.adaptive_worker_profile.total_completed, 1);
      assert.equal(sessionAfter.session.metadata.adaptive_worker_profile.total_failed, 0);

      const completedTasks = await callTool(session.client, "task.list", {
        status: "completed",
        limit: 20,
      });
      const completedSourceTask = completedTasks.tasks.find((task) => task.task_id === sourceTaskId);
      assert.ok(completedSourceTask);
      assert.equal(completedSourceTask.last_worker_id, sessionId);

      await callTool(session.client, "trichat.autopilot", {
        action: "stop",
        mutation: nextMutation(testId, "trichat.autopilot-stop-agent-session", () => mutationCounter++),
      });
    } finally {
      await session.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot closes one-shot archived run_once sessions after completion", async () => {
  const testId = `${Date.now()}-run-once-close`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-runonce-close-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const threadId = `trichat-autopilot-runonce-close-${testId}`;
  const sessionId = `trichat-autopilot:${threadId}`;
  let mutationCounter = 0;

  try {
    const session = await openClient(dbPath);
    try {
      const runOnce = await callTool(session.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-close", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: threadId,
        thread_title: `TriChat Autopilot One Shot ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });

      assert.equal(runOnce.tick.ok, true);

      const fetchedSession = await callTool(session.client, "agent.session_get", {
        session_id: sessionId,
      });
      assert.equal(fetchedSession.found, true);
      assert.equal(fetchedSession.session.status, "closed");
      assert.equal(typeof fetchedSession.session.ended_at, "string");
      assert.equal(fetchedSession.session.metadata.close_reason, "run_once complete");

      const activeSessions = await callTool(session.client, "agent.session_list", {
        active_only: true,
        limit: 20,
      });
      assert.equal(activeSessions.sessions.some((entry) => entry.session_id === sessionId), false);
    } finally {
      await session.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot treats no-work start heartbeats as idle observations instead of failures", async () => {
  const testId = `${Date.now()}-idle-observe`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-idle-observe-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  try {
    const session = await openClient(dbPath);
    try {
      const started = await callTool(session.client, "trichat.autopilot", {
        action: "start",
        mutation: nextMutation(testId, "trichat.autopilot-start-idle-observe", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: `trichat-autopilot-idle-observe-${testId}`,
        thread_title: `TriChat Autopilot Idle Observe ${testId}`,
        thread_status: "active",
        away_mode: "normal",
        lead_agent_id: "ring-leader",
        specialist_agent_ids: ["implementation-director", "local-imprint"],
        run_immediately: true,
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.99,
        adr_policy: "manual",
      });

      assert.ok(started.initial_tick);
      assert.equal(started.initial_tick.ok, true);
      assert.equal(started.initial_tick.reason, null);
      assert.equal(started.initial_tick.verify_status, "skipped");
      assert.match(started.initial_tick.verify_summary, /idle observation/i);
      assert.ok(
        started.initial_tick.step_status.some(
          (entry) => entry.name === "execute" && entry.summary.includes("idle observe")
        )
      );

      const status = await callTool(session.client, "trichat.autopilot", {
        action: "status",
      });
      assert.equal(status.last_tick.ok, true);
      assert.equal(status.session.session.metadata.last_idle_observe_tick, true);

      await callTool(session.client, "trichat.autopilot", {
        action: "stop",
        mutation: nextMutation(testId, "trichat.autopilot-stop-idle-observe", () => mutationCounter++),
      });
    } finally {
      await session.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot refreshes stale replayed source-task claims across server restarts", async () => {
  const testId = `${Date.now()}-stale-claim-refresh`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-stale-claim-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const threadId = `trichat-autopilot-stale-claim-${testId}`;
  let mutationCounter = 0;

  try {
    const sessionOne = await openClient(dbPath);
    try {
      const firstTaskId = `autopilot-stale-claim-source-a-${testId}`;
      await callTool(sessionOne.client, "task.create", {
        mutation: nextMutation(testId, "task.create-stale-claim-source-a", () => mutationCounter++),
        task_id: firstTaskId,
        objective:
          "Review the current operator state, choose one bounded next action, and preserve explicit verification notes.",
        project_dir: REPO_ROOT,
        priority: 95,
        tags: ["trichat", "autopilot", "stale-claim-test"],
        source: "test",
      });

      const firstRun = await callTool(sessionOne.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-stale-claim-a", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: threadId,
        thread_title: `TriChat Autopilot Stale Claim ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        lead_agent_id: "codex",
        specialist_agent_ids: ["cursor"],
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });
      assert.equal(firstRun.tick.ok, true);
      assert.equal(firstRun.tick.source_task_id, firstTaskId);
    } finally {
      await sessionOne.client.close().catch(() => {});
    }

    const sessionTwo = await openClient(dbPath);
    try {
      const secondTaskId = `autopilot-stale-claim-source-b-${testId}`;
      await callTool(sessionTwo.client, "task.create", {
        mutation: nextMutation(testId, "task.create-stale-claim-source-b", () => mutationCounter++),
        task_id: secondTaskId,
        objective:
          "Refresh the office dashboard brief, capture evidence requirements, and keep rollback notes bounded.",
        project_dir: REPO_ROOT,
        priority: 96,
        tags: ["trichat", "autopilot", "stale-claim-test"],
        source: "test",
      });

      const secondRun = await callTool(sessionTwo.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-stale-claim-b", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: threadId,
        thread_title: `TriChat Autopilot Stale Claim ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        lead_agent_id: "codex",
        specialist_agent_ids: ["cursor"],
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 1,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });
      assert.equal(secondRun.tick.ok, true);
      assert.equal(
        secondRun.tick.source_task_id,
        secondTaskId,
        "Expected the second run to refresh stale claim replay and intake the new source task"
      );

      const persistedSessions = await callTool(sessionTwo.client, "agent.session_list", {
        limit: 50,
      });
      const autopilotSession = persistedSessions.sessions.find(
        (entry) => entry.client_kind === "trichat-autopilot" && entry.metadata?.thread_id === threadId
      );
      assert.ok(autopilotSession, "Expected the autopilot agent session to persist across restart");
      assert.equal(autopilotSession.metadata.last_claimed_task_id, secondTaskId);
      assert.equal(autopilotSession.metadata.last_reported_task_id, secondTaskId);

      const completedTasks = await callTool(sessionTwo.client, "task.list", {
        status: "completed",
        limit: 20,
      });
      const completedSecondTask = completedTasks.tasks.find((task) => task.task_id === secondTaskId);
      assert.ok(completedSecondTask);
      assert.equal(completedSecondTask.last_worker_id, autopilotSession.session_id);
    } finally {
      await sessionTwo.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot keeps a strong single-agent read-only council above the confidence floor", async () => {
  const testId = `${Date.now()}-single-agent-council`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-single-agent-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  try {
    const session = await openClient(dbPath, {
      TRICHAT_AGENT_IDS: "local-imprint",
    });
    try {
      const result = await callTool(session.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, "trichat.autopilot-run_once-single-agent", () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: `trichat-autopilot-single-agent-${testId}`,
        thread_title: `TriChat Autopilot Single Agent ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        lead_agent_id: "local-imprint",
        specialist_agent_ids: [],
        bridge_dry_run: true,
        execute_enabled: false,
        max_rounds: 1,
        min_success_agents: 2,
        confidence_threshold: 0.45,
        adr_policy: "manual",
      });

      assert.equal(result.tick.ok, true);
      assert.ok(result.tick.success_agents >= 1);
      assert.equal(result.tick.execution.mode, "task_fallback");
      assert.ok(result.tick.council_confidence >= 0.45);
      assert.equal(result.tick.reason, null);
    } finally {
      await session.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.adapter_protocol_check resolves local directors and leaf specialists through the shared local bridge", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-adapter-check-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const session = await openClient(dbPath, {
    TRICHAT_AGENT_IDS:
      "ring-leader,implementation-director,research-director,verification-director,code-smith,research-scout,quality-guard,local-imprint",
  });
  try {
    const result = await callTool(session.client, "trichat.adapter_protocol_check", {
      agent_ids: [
        "implementation-director",
        "research-director",
        "verification-director",
        "code-smith",
        "research-scout",
        "quality-guard",
      ],
      run_ask_check: true,
      ask_dry_run: true,
    });
    assert.equal(result.all_ok, true);
    assert.equal(result.results.length, 6);
    for (const entry of result.results) {
      assert.equal(entry.command_source, "auto");
      assert.equal(entry.ok, true);
      assert.equal(entry.ping.ok, true);
      assert.equal(entry.ask.ok, true);
      assert.ok(
        entry.wrapper_candidates.some(
          (candidate) =>
            String(candidate).endsWith("local-imprint_bridge.py") ||
            String(candidate).endsWith("local_imprint_bridge.py")
        )
      );
    }
  } finally {
    await session.client.close().catch(() => {});
  }
});

async function openClient(dbPath, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(path.dirname(dbPath), "trichat.bus.sock"),
      ...extraEnv,
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-trichat-autopilot-persistence-test", version: "0.1.0" },
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

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
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
