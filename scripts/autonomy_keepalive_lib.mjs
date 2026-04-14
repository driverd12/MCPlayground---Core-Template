#!/usr/bin/env node
import {
  acquireRunnerSingletonLock,
  callTool,
  parseBoolean,
  parseIntValue,
  waitForHttpReady,
} from "./mcp_runner_support.mjs";

const SOURCE_CLIENT = "autonomy.keepalive.launchd";
const LOCK_NAME = "autonomy-keepalive-runner";

export function buildKeepaliveArgs({ env, now, pid }) {
  return {
    action: "run",
    mutation: {
      idempotency_key: `autonomy-maintain-run-${now}-${pid}`,
      side_effect_fingerprint: `autonomy-maintain-run-${now}-${pid}`,
    },
    interval_seconds: parseIntValue(env.AUTONOMY_KEEPALIVE_INTERVAL_SECONDS, 120, 5, 3600),
    learning_review_interval_seconds: parseIntValue(
      env.AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS,
      300,
      60,
      604800
    ),
    eval_interval_seconds: parseIntValue(env.AUTONOMY_EVAL_INTERVAL_SECONDS, 21600, 300, 604800),
    bootstrap_run_immediately: parseBoolean(env.AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY, false),
    autostart_ring_leader: parseBoolean(env.TRICHAT_RING_LEADER_AUTOSTART, true),
    ensure_bootstrap: true,
    start_goal_autorun_daemon: true,
    maintain_tmux_controller: true,
    run_eval_if_due: true,
    eval_suite_id: "autonomy.control-plane",
    minimum_eval_score: 75,
    refresh_learning_summary: true,
    publish_runtime_event: true,
    source_client: SOURCE_CLIENT,
  };
}

function isRetryableTransportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|UND_ERR|EPIPE/i.test(message);
}

function isMutationInProgressError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /mutation key is already in progress/i.test(message);
}

function shouldNormalizeAttentionResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.ok !== false) {
    return false;
  }
  const status = result.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return false;
  }
  const bootstrap = status.bootstrap;
  const state = status.state;
  const runtime = status.runtime;
  const goalAutorun = status.goal_autorun_daemon;
  return (
    bootstrap &&
    typeof bootstrap === "object" &&
    bootstrap.self_start_ready === true &&
    state &&
    typeof state === "object" &&
    state.enabled === true &&
    runtime &&
    typeof runtime === "object" &&
    runtime.running === true &&
    goalAutorun &&
    typeof goalAutorun === "object" &&
    goalAutorun.running === true
  );
}

function normalizeKeepaliveResult(result) {
  if (!shouldNormalizeAttentionResult(result)) {
    return result;
  }
  return {
    ...result,
    ok: true,
    health_ok: false,
    attention_only: true,
  };
}

export async function runAutonomyKeepaliveOnce({
  repoRoot,
  transport,
  env,
  now,
  pid,
  callToolFn = callTool,
  waitForHttpReadyFn = waitForHttpReady,
  acquireLockFn = acquireRunnerSingletonLock,
}) {
  const lockTimeoutMs = parseIntValue(env.AUTONOMY_KEEPALIVE_SINGLETON_TIMEOUT_MS, 15000, 1000, 120000);
  const lock = await acquireLockFn(repoRoot, LOCK_NAME, lockTimeoutMs);
  if (!lock?.ok) {
    return {
      ok: true,
      skipped: true,
      reason: "singleton_locked",
      source_client: SOURCE_CLIENT,
      transport,
      singleton_lock: {
        name: LOCK_NAME,
        acquired: false,
        timeout_ms: lockTimeoutMs,
      },
    };
  }

  const release = typeof lock.release === "function" ? lock.release : () => {};
  try {
    if (transport === "http") {
      const ready = await waitForHttpReadyFn(repoRoot, {
        timeoutMs: parseIntValue(env.AUTONOMY_KEEPALIVE_HTTP_READY_TIMEOUT_MS, 20000, 1000, 120000),
        intervalMs: 500,
      });
      if (!ready) {
        return {
          ok: true,
          skipped: true,
          reason: "http_not_ready",
          source_client: SOURCE_CLIENT,
          transport,
          singleton_lock: {
            name: LOCK_NAME,
            acquired: true,
          },
        };
      }
    }

    const args = buildKeepaliveArgs({ env, now, pid });
    let result;
    try {
      result = await Promise.resolve(
        callToolFn(repoRoot, {
          tool: "autonomy.maintain",
          args,
          transport,
        })
      );
    } catch (error) {
      if (isMutationInProgressError(error)) {
        result = {
          ok: true,
          skipped: true,
          reason: "mutation_in_progress",
          source_client: SOURCE_CLIENT,
          transport,
        };
      } else if (transport !== "http" || !isRetryableTransportError(error)) {
        throw error;
      } else {
        try {
          result = await Promise.resolve(
            callToolFn(repoRoot, {
              tool: "autonomy.maintain",
              args,
              transport: "stdio",
            })
          );
          if (result && typeof result === "object" && !Array.isArray(result)) {
            result = {
              ...result,
              transport: "stdio",
              transport_fallback_from: "http",
            };
          }
        } catch (fallbackError) {
          if (!isMutationInProgressError(fallbackError)) {
            throw fallbackError;
          }
          result = {
            ok: true,
            skipped: true,
            reason: "mutation_in_progress",
            source_client: SOURCE_CLIENT,
            transport: "stdio",
            transport_fallback_from: "http",
          };
        }
      }
    }

    return normalizeKeepaliveResult(result);
  } finally {
    release();
  }
}
