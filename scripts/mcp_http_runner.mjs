#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import {
  acquireRunnerSingletonLock,
  loadRunnerEnv,
  reapRepoServerProcesses,
  repoRootFromMeta,
  resolveRunnerBusSocketPath,
  waitForServerResourcesToClear,
} from "./mcp_runner_support.mjs";

const repoRoot = repoRootFromMeta(import.meta.url);
loadRunnerEnv(repoRoot);

async function main() {
  const port = process.env.MCP_HTTP_PORT || process.env.ANAMNESIS_MCP_HTTP_PORT || "8787";
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  const busSocketPath = resolveRunnerBusSocketPath(repoRoot);
  const targetEntry = process.env.MCP_HTTP_RUNNER_ENTRY || path.join(repoRoot, "dist", "server.js");
  const targetArgs = process.env.MCP_HTTP_RUNNER_ARGS
    ? JSON.parse(process.env.MCP_HTTP_RUNNER_ARGS)
    : ["--http", "--http-port", port];
  process.env.TRICHAT_BUS_SOCKET_PATH = busSocketPath;
  process.env.MCP_HTTP_OFFICE_SNAPSHOT_REFRESH_MODE ||= "stdio";
  let child = null;
  let releaseLock = () => {};
  let shuttingDown = false;

  const lock = await acquireRunnerSingletonLock(repoRoot, "mcp-http-runner", 20000);
  if (!lock.ok) {
    process.stderr.write("[mcp.http.runner] startup singleton lock timed out\n");
    process.exit(75);
    return;
  }

  let released = false;
  releaseLock = () => {
    if (released) return;
    released = true;
    lock.release();
  };

  const waitForChildExit = (timeoutMs = 5000) =>
    new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {}
        finish();
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
    });

  const shutdown = async (exitCode, signal = "SIGTERM") => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {}
        await waitForChildExit();
      }
    } finally {
      releaseLock();
    }
    process.exit(exitCode);
  };

  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    void shutdown(130, "SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown(143, "SIGTERM");
  });

  const reaped = await reapRepoServerProcesses(repoRoot, {
    excludePids: [process.pid],
    signalWaitMs: 2000,
  });
  if (reaped.length > 0) {
    process.stderr.write(`[mcp.http.runner] reaped ${reaped.length} orphan repo server process(es) before startup\n`);
  }

  const cleared = await waitForServerResourcesToClear({
    host,
    port: Number.parseInt(String(port), 10),
    busSocketPath,
    timeoutMs: 20000,
    intervalMs: 250,
  });
  if (!cleared.ok) {
    process.stderr.write(
      `[mcp.http.runner] resources did not clear before startup (port=${cleared.portState} bus=${cleared.busState})\n`
    );
    releaseLock();
    process.exit(75);
    return;
  }

  child = spawn(process.execPath, [targetEntry, ...targetArgs], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    releaseLock();
    if (shuttingDown) {
      return;
    }
    if (signal) {
      process.exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    releaseLock();
    process.stderr.write(`[mcp.http.runner] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`[mcp.http.runner] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
