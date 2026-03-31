import assert from "node:assert/strict";
import test from "node:test";
import { alertConfirmationThreshold, buildReactionAlert } from "../dist/tools/reaction_engine.js";

test("reaction alert treats maintenance staleness plus idle-worker routing as a debounced warning", () => {
  const alert = buildReactionAlert({
    overview: {
      task_counts: { failed: 0 },
      goal_counts: { blocked: 0, failed: 0 },
      adaptive_session_counts: { degraded: 0 },
      expired_running_task_count: 0,
    },
    autonomy_maintain: {
      enabled: true,
      stale: true,
      runtime: { running: true },
    },
    attention: ["Work is queued or ready, but no active agent sessions are available to claim it."],
  });

  assert.ok(alert);
  assert.equal(alert.level, "warn");
  assert.ok(alert.reasons.includes("background autonomy maintenance is stale"));
  assert.equal(alertConfirmationThreshold(alert), 2);
});

test("reaction alert still escalates real failed work immediately", () => {
  const alert = buildReactionAlert({
    overview: {
      failed_task_count: 1,
      task_counts: { failed: 1 },
      goal_counts: { blocked: 0, failed: 0 },
      adaptive_session_counts: { degraded: 0 },
      expired_running_task_count: 0,
    },
    autonomy_maintain: {
      enabled: true,
      stale: true,
      runtime: { running: true },
    },
    attention: ["Work is queued or ready, but no active agent sessions are available to claim it."],
  });

  assert.ok(alert);
  assert.equal(alert.level, "critical");
  assert.ok(alert.reasons.includes("1 failed task(s) need triage"));
  assert.equal(alertConfirmationThreshold(alert), 1);
});

test("reaction alert does not page on recovered failed-task history when the effective failed count is zero", () => {
  const alert = buildReactionAlert({
    overview: {
      failed_task_count: 0,
      task_counts: { failed: 1 },
      goal_counts: { blocked: 0, failed: 0 },
      adaptive_session_counts: { degraded: 0 },
      expired_running_task_count: 0,
    },
    autonomy_maintain: {
      enabled: true,
      stale: false,
      runtime: { running: true },
    },
    attention: [],
  });

  assert.equal(alert, null);
});
