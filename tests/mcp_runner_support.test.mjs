import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  acquireRunnerSingletonLock,
  resolveRunnerBusSocketPath,
  waitForServerResourcesToClear,
} from "../scripts/mcp_runner_support.mjs";

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
