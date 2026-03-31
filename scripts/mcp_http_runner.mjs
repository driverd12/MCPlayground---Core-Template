#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import {
  acquireRunnerSingletonLock,
  loadRunnerEnv,
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
  process.env.TRICHAT_BUS_SOCKET_PATH = busSocketPath;

  const lock = await acquireRunnerSingletonLock(repoRoot, "mcp-http-runner", 20000);
  if (!lock.ok) {
    process.stderr.write("[mcp.http.runner] startup singleton lock timed out\n");
    process.exit(75);
    return;
  }

  const release = () => lock.release();
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(143);
  });

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
    release();
    process.exit(75);
    return;
  }

  const child = spawn(process.execPath, [path.join(repoRoot, "dist", "server.js"), "--http", "--http-port", port], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    release();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    release();
    process.stderr.write(`[mcp.http.runner] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`[mcp.http.runner] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
