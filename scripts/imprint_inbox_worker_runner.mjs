#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { loadRunnerEnv, parseIntValue, repoRootFromMeta, waitForHttpReady } from "./mcp_runner_support.mjs";

const repoRoot = repoRootFromMeta(import.meta.url);
loadRunnerEnv(repoRoot);

const pythonBin = process.env.TRICHAT_INBOX_WORKER_PYTHON || process.env.PYTHON_BIN || "python3";
const workerScriptPath = path.join(repoRoot, "scripts", "imprint_inbox_worker.py");
const workerScript = fs.readFileSync(workerScriptPath, "utf8");

async function main() {
  if (String(process.env.ANAMNESIS_INBOX_MCP_TRANSPORT || "").trim().toLowerCase() === "http") {
    await waitForHttpReady(repoRoot, {
      timeoutMs: parseIntValue(process.env.ANAMNESIS_INBOX_HTTP_READY_TIMEOUT_MS, 30000, 1000, 180000),
      intervalMs: 500,
      url: process.env.ANAMNESIS_INBOX_MCP_URL || process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/",
    });
  }

  const child = spawn(pythonBin, ["-", ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || "1",
    },
    stdio: ["pipe", "inherit", "inherit"],
  });

  child.stdin.write(workerScript);
  child.stdin.end();

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    process.stderr.write(`[imprint.inboxworker] runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`[imprint.inboxworker] startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
