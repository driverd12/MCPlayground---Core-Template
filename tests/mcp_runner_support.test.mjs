import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  acquireRunnerSingletonLock,
  reapRepoServerProcesses,
  resolveRunnerBusSocketPath,
  waitForServerResourcesToClear,
} from "../scripts/mcp_runner_support.mjs";
import { runAutonomyKeepaliveOnce } from "../scripts/autonomy_keepalive_lib.mjs";

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("resolveRunnerBusSocketPath shortens overly long repo-local socket paths", () => {
  const longRoot = path.join(
    os.tmpdir(),
    "mcplayground-super-long-root",
    "nested",
    "even-more",
    "depth",
    "and-more",
    "workspace"
  );
  const previous = process.env.TRICHAT_BUS_SOCKET_PATH;
  delete process.env.TRICHAT_BUS_SOCKET_PATH;
  try {
    const resolved = resolveRunnerBusSocketPath(longRoot);
    assert.equal(resolved.endsWith(".sock"), true);
    assert.equal(Buffer.byteLength(resolved) < 100, true);
    assert.equal(resolved.includes("trichat-"), true);
  } finally {
    if (previous === undefined) {
      delete process.env.TRICHAT_BUS_SOCKET_PATH;
    } else {
      process.env.TRICHAT_BUS_SOCKET_PATH = previous;
    }
  }
});

test("acquireRunnerSingletonLock reclaims a stale lock owned by a dead pid", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runner-lock-"));
  const lockDir = path.join(tempRoot, "data", "imprint", "locks", "mcp-http-runner.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "pid"), "999999\n", "utf8");
  const lock = await acquireRunnerSingletonLock(tempRoot, "mcp-http-runner", 2000);
  assert.equal(lock.ok, true);
  assert.equal(fs.existsSync(path.join(lockDir, "pid")), true);
  lock.release();
  assert.equal(fs.existsSync(lockDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("acquireRunnerSingletonLock rejects a live competing owner and allows reuse after release", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runner-live-lock-"));
  const first = await acquireRunnerSingletonLock(tempRoot, "shared-runner", 1000);
  assert.equal(first.ok, true);

  const second = await acquireRunnerSingletonLock(tempRoot, "shared-runner", 1000);
  assert.equal(second.ok, false);

  first.release();

  const third = await acquireRunnerSingletonLock(tempRoot, "shared-runner", 1000);
  assert.equal(third.ok, true);
  third.release();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("runAutonomyKeepaliveOnce skips duplicate cycles when singleton lock is already held", async () => {
  let callCount = 0;
  const result = await runAutonomyKeepaliveOnce({
    repoRoot: process.cwd(),
    transport: "http",
    env: {
      AUTONOMY_KEEPALIVE_SINGLETON_TIMEOUT_MS: "1200",
    },
    now: 1710000000000,
    pid: 1234,
    acquireLockFn: async () => ({ ok: false, release: () => {} }),
    waitForHttpReadyFn: async () => true,
    callToolFn: () => {
      callCount += 1;
      return { ok: true };
    },
  });
  assert.equal(callCount, 0);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "singleton_locked");
  assert.equal(result.singleton_lock?.acquired, false);
});

test("runAutonomyKeepaliveOnce releases singleton lock after retryable HTTP fallback", async () => {
  const callTransports = [];
  let released = 0;
  const result = await runAutonomyKeepaliveOnce({
    repoRoot: process.cwd(),
    transport: "http",
    env: {},
    now: 1710000000100,
    pid: 4321,
    acquireLockFn: async () => ({
      ok: true,
      release: () => {
        released += 1;
      },
    }),
    waitForHttpReadyFn: async () => true,
    callToolFn: (_repoRoot, input) => {
      callTransports.push(input.transport);
      if (input.transport === "http") {
        throw new Error("socket hang up");
      }
      return { ok: true, handled_by: input.transport };
    },
  });
  assert.deepEqual(callTransports, ["http", "stdio"]);
  assert.equal(released, 1);
  assert.equal(result.transport, "stdio");
  assert.equal(result.transport_fallback_from, "http");
});

test("runAutonomyKeepaliveOnce normalizes attention-only maintain results to successful keepalive output", async () => {
  const result = await runAutonomyKeepaliveOnce({
    repoRoot: process.cwd(),
    transport: "stdio",
    env: {},
    now: 1710000000200,
    pid: 2222,
    acquireLockFn: async () => ({
      ok: true,
      release: () => {},
    }),
    callToolFn: () => ({
      ok: false,
      actions: ["eval.autonomy.control-plane.below_threshold"],
      status: {
        bootstrap: { self_start_ready: true },
        state: { enabled: true },
        runtime: { running: true },
        goal_autorun_daemon: { running: true },
      },
      eval: {
        executed: true,
        ok: false,
        aggregate_metric_value: 50,
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.health_ok, false);
  assert.equal(result.attention_only, true);
  assert.equal(result.eval?.aggregate_metric_value, 50);
});

test("waitForServerResourcesToClear waits for a busy TCP port to become free", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve(undefined)));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  setTimeout(() => {
    server.close();
  }, 300);
  const result = await waitForServerResourcesToClear({
    host: "127.0.0.1",
    port,
    busSocketPath: path.join(os.tmpdir(), `missing-${Date.now()}.sock`),
    timeoutMs: 3000,
    intervalMs: 100,
  });
  assert.equal(result.ok, true);
});

test("reapRepoServerProcesses terminates repo-owned dist/server.js processes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runner-reap-"));
  const distDir = path.join(tempRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const childScript = path.join(distDir, "server.js");
  const pidFile = path.join(tempRoot, "pid");
  fs.writeFileSync(
    childScript,
    `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `,
    "utf8"
  );

  const child = spawn(process.execPath, [childScript], {
    cwd: tempRoot,
    stdio: "ignore",
  });

  try {
    await waitFor(() => fs.existsSync(pidFile), 5_000, "reap child pid file");
    const childPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    assert.equal(Number.isInteger(childPid), true);

    const reaped = await reapRepoServerProcesses(tempRoot, {
      excludePids: [process.pid],
      signalWaitMs: 2_000,
    });
    assert.equal(reaped.some((entry) => entry.pid === childPid), true);
    await waitFor(() => !processAlive(childPid), 5_000, "reaped child exit");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reapRepoServerProcesses ignores wrapper processes that only reference dist/server.js in arguments", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runner-wrapper-ignore-"));
  const scriptsDir = path.join(tempRoot, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const wrapperScript = path.join(scriptsDir, "mcp_tool_call.mjs");
  const pidFile = path.join(tempRoot, "wrapper.pid");
  fs.writeFileSync(
    wrapperScript,
    `
      import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `,
    "utf8"
  );

  const child = spawn(process.execPath, [wrapperScript, "--stdio-args", "dist/server.js"], {
    cwd: tempRoot,
    stdio: "ignore",
  });

  try {
    await waitFor(() => fs.existsSync(pidFile), 5_000, "wrapper pid file");
    const wrapperPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    assert.equal(Number.isInteger(wrapperPid), true);

    const reaped = await reapRepoServerProcesses(tempRoot, {
      excludePids: [process.pid],
      signalWaitMs: 500,
    });
    assert.equal(reaped.some((entry) => entry.pid === wrapperPid), false);
    assert.equal(processAlive(wrapperPid), true);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mcp_tool_call office.snapshot falls back to cache after a bounded stdio timeout", async () => {
  const repoRoot = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tool-call-office-snapshot-"));
  const cacheDir = path.join(tempRoot, "cache");
  const webCacheDir = path.join(cacheDir, "web");
  const hangScript = path.join(tempRoot, "hang-server.mjs");
  const pidFile = path.join(tempRoot, "hang.pid");
  fs.mkdirSync(webCacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(webCacheDir, "thread-ring-leader-main--theme-night.json"),
    JSON.stringify({
      thread_id: "ring-leader-main",
      theme: "night",
      fetched_at: Date.now() / 1000,
      agents: [{ agent: { agent_id: "gemini" }, state: "sleeping" }],
      summary: {},
      rooms: {},
      errors: [],
      cache: { hit: true, key: "office.snapshot:ring-leader-main" },
    }),
    "utf8"
  );
  fs.writeFileSync(
    hangScript,
    `
      import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `,
    "utf8"
  );

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "mcp_tool_call.mjs"),
      "--tool",
      "office.snapshot",
      "--args",
      JSON.stringify({ thread_id: "ring-leader-main", theme: "night" }),
      "--transport",
      "stdio",
      "--stdio-command",
      process.execPath,
      "--stdio-args",
      hangScript,
      "--cwd",
      repoRoot,
      "--timeout-ms",
      "250",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR: cacheDir,
      },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.thread_id, "ring-leader-main");
  assert.equal(parsed.agents[0].state, "sleeping");
  assert.equal(parsed.cache.hit, true);

  await waitFor(() => fs.existsSync(pidFile), 5_000, "hang child pid file");
  const hangPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  await waitFor(() => !processAlive(hangPid), 5_000, "timed out stdio child exit");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
