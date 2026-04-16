import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("mcp_http_runner forwards termination to its child process", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-http-runner-"));
  const scriptDir = path.join(tempDir, "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });

  const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tempDir, "node_modules"), "dir");
  fs.copyFileSync(path.join(repoRoot, "scripts", "mcp_http_runner.mjs"), path.join(scriptDir, "mcp_http_runner.mjs"));
  fs.copyFileSync(path.join(repoRoot, "scripts", "mcp_runner_support.mjs"), path.join(scriptDir, "mcp_runner_support.mjs"));

  const childScriptPath = path.join(tempDir, "fake_child.mjs");
  const childPidPath = path.join(tempDir, "child.pid");
  const childSignalPath = path.join(tempDir, "child.signal");
  const busSocketPath = path.join(tempDir, "runner.sock");
  fs.writeFileSync(
    childScriptPath,
    `import fs from "node:fs";
import process from "node:process";
const [pidPath, signalPath] = process.argv.slice(2);
fs.writeFileSync(pidPath, String(process.pid));
const stop = (signal) => {
  fs.writeFileSync(signalPath, signal);
  process.exit(0);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
setInterval(() => {}, 1000);
`,
    "utf8"
  );

  const port = await reservePort();
  const runner = spawn(process.execPath, [path.join(scriptDir, "mcp_http_runner.mjs")], {
    cwd: tempDir,
    env: {
      ...process.env,
      MCP_HTTP_PORT: String(port),
      TRICHAT_BUS_SOCKET_PATH: busSocketPath,
      MCP_HTTP_RUNNER_ENTRY: childScriptPath,
      MCP_HTTP_RUNNER_ARGS: JSON.stringify([childPidPath, childSignalPath]),
    },
    stdio: "pipe",
  });

  try {
    await waitFor(() => fs.existsSync(childPidPath), 5_000, "child pid file");
    const childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8").trim(), 10);
    assert.equal(Number.isInteger(childPid), true);

    runner.kill("SIGTERM");
    const exitCode = await waitForExit(runner, 8_000);
    assert.equal(exitCode, 143);

    await waitFor(() => fs.existsSync(childSignalPath), 5_000, "child signal file");
    assert.equal(fs.readFileSync(childSignalPath, "utf8").trim(), "SIGTERM");
    assert.equal(processAlive(childPid), false);
  } finally {
    try {
      runner.kill("SIGKILL");
    } catch {}
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mcp_http_runner reclaims a stale live-pid lock before relaunching after restart", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-http-runner-stale-lock-"));
  const scriptDir = path.join(tempDir, "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });

  const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tempDir, "node_modules"), "dir");
  fs.copyFileSync(path.join(repoRoot, "scripts", "mcp_http_runner.mjs"), path.join(scriptDir, "mcp_http_runner.mjs"));
  fs.copyFileSync(path.join(repoRoot, "scripts", "mcp_runner_support.mjs"), path.join(scriptDir, "mcp_runner_support.mjs"));

  const childScriptPath = path.join(tempDir, "fake_child.mjs");
  const childPidPath = path.join(tempDir, "child.pid");
  const childSignalPath = path.join(tempDir, "child.signal");
  const blockerScriptPath = path.join(tempDir, "blocking_process.mjs");
  const blockerPidPath = path.join(tempDir, "blocking.pid");
  const busSocketPath = path.join(tempDir, "runner.sock");
  const lockDir = path.join(tempDir, "data", "imprint", "locks", "mcp-http-runner.lock");
  const lockPidPath = path.join(lockDir, "pid");

  fs.writeFileSync(
    childScriptPath,
    `import fs from "node:fs";
import process from "node:process";
const [pidPath, signalPath] = process.argv.slice(2);
fs.writeFileSync(pidPath, String(process.pid));
const stop = (signal) => {
  fs.writeFileSync(signalPath, signal);
  process.exit(0);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  fs.writeFileSync(
    blockerScriptPath,
    `import fs from "node:fs";
import process from "node:process";
const [pidPath] = process.argv.slice(2);
fs.writeFileSync(pidPath, String(process.pid));
setInterval(() => {}, 1000);
`,
    "utf8"
  );

  const blocker = spawn(process.execPath, [blockerScriptPath, blockerPidPath], {
    cwd: tempDir,
    stdio: "ignore",
  });
  let runner = null;

  try {
    await waitFor(() => fs.existsSync(blockerPidPath), 5_000, "blocking pid file");
    const blockerPid = fs.readFileSync(blockerPidPath, "utf8").trim();
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPidPath, `${blockerPid}\n`, "utf8");
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPidPath, older, older);
    fs.utimesSync(lockDir, older, older);

    const port = await reservePort();
    runner = spawn(process.execPath, [path.join(scriptDir, "mcp_http_runner.mjs")], {
      cwd: tempDir,
      env: {
        ...process.env,
        MCP_HTTP_PORT: String(port),
        TRICHAT_BUS_SOCKET_PATH: busSocketPath,
        MCP_HTTP_RUNNER_ENTRY: childScriptPath,
        MCP_HTTP_RUNNER_ARGS: JSON.stringify([childPidPath, childSignalPath]),
      },
      stdio: "pipe",
    });

    await waitFor(() => fs.existsSync(childPidPath), 5_000, "child pid file after stale lock reclaim");
    assert.equal(fs.readFileSync(lockPidPath, "utf8").trim(), String(runner.pid));

    runner.kill("SIGTERM");
    const exitCode = await waitForExit(runner, 8_000);
    assert.equal(exitCode, 143);

    await waitFor(() => fs.existsSync(childSignalPath), 5_000, "child signal file");
    assert.equal(fs.readFileSync(childSignalPath, "utf8").trim(), "SIGTERM");
  } finally {
    try {
      runner?.kill("SIGKILL");
    } catch {}
    try {
      blocker.kill("SIGKILL");
    } catch {}
    await rm(tempDir, { recursive: true, force: true });
  }
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const socketServer = net.createServer();
    socketServer.on("error", reject);
    socketServer.listen(0, "127.0.0.1", () => {
      const address = socketServer.address();
      if (!address || typeof address === "string") {
        socketServer.close(() => reject(new Error("Failed to reserve port")));
        return;
      }
      const { port } = address;
      socketServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for runner exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`Runner exited via unexpected signal ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
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
