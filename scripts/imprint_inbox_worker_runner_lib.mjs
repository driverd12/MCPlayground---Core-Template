#!/usr/bin/env node
import {
  acquireRunnerSingletonLock,
  parseBoolean,
  parseIntValue,
  waitForHttpReady,
} from "./mcp_runner_support.mjs";

const SOURCE_CLIENT = "imprint.inboxworker.launchd";
const LOCK_NAME = "imprint-inbox-worker-runner";

export async function prepareInboxWorkerStartup({
  repoRoot,
  env,
  acquireLockFn = acquireRunnerSingletonLock,
  waitForHttpReadyFn = waitForHttpReady,
}) {
  const lockTimeoutMs = parseIntValue(env.ANAMNESIS_INBOX_SINGLETON_TIMEOUT_MS, 15000, 1000, 120000);
  const lock = await acquireLockFn(repoRoot, LOCK_NAME, lockTimeoutMs);
  if (!lock?.ok) {
    return {
      ok: true,
      skipped: true,
      reason: "singleton_locked",
      source_client: SOURCE_CLIENT,
      transport: "unknown",
      singleton_lock: {
        name: LOCK_NAME,
        acquired: false,
        timeout_ms: lockTimeoutMs,
      },
      release: () => {},
    };
  }

  const transport = String(env.ANAMNESIS_INBOX_MCP_TRANSPORT || "stdio").trim().toLowerCase();
  const release = typeof lock.release === "function" ? lock.release : () => {};
  if (transport !== "http") {
    return {
      ok: true,
      source_client: SOURCE_CLIENT,
      transport,
      singleton_lock: {
        name: LOCK_NAME,
        acquired: true,
        timeout_ms: lockTimeoutMs,
      },
      release,
    };
  }

  const ready = await waitForHttpReadyFn(repoRoot, {
    timeoutMs: parseIntValue(env.ANAMNESIS_INBOX_HTTP_READY_TIMEOUT_MS, 30000, 1000, 180000),
    intervalMs: 500,
    url: env.ANAMNESIS_INBOX_MCP_URL || env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/",
  });
  if (ready) {
    return {
      ok: true,
      source_client: SOURCE_CLIENT,
      transport: "http",
      singleton_lock: {
        name: LOCK_NAME,
        acquired: true,
        timeout_ms: lockTimeoutMs,
      },
      release,
    };
  }

  const restartDelayMs = parseIntValue(env.ANAMNESIS_INBOX_RESTART_DELAY_MS, 5000, 0, 60000);
  if (parseBoolean(env.ANAMNESIS_INBOX_HTTP_ROLLBACK_TO_STDIO, false)) {
    return {
      ok: true,
      source_client: SOURCE_CLIENT,
      reason: "http_not_ready_rolled_back_stdio",
      transport: "stdio",
      transport_fallback_from: "http",
      singleton_lock: {
        name: LOCK_NAME,
        acquired: true,
        timeout_ms: lockTimeoutMs,
      },
      release,
    };
  }

  return {
    ok: false,
    source_client: SOURCE_CLIENT,
    reason: "http_not_ready",
    transport: "http",
    restart_delay_ms: restartDelayMs,
    singleton_lock: {
      name: LOCK_NAME,
      acquired: true,
      timeout_ms: lockTimeoutMs,
    },
    release,
  };
}
