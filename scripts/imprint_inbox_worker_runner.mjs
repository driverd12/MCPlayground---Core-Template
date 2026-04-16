#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { loadRunnerEnv, repoRootFromMeta } from "./mcp_runner_support.mjs";
import { prepareInboxWorkerStartup } from "./imprint_inbox_worker_runner_lib.mjs";

const repoRoot = repoRootFromMeta(import.meta.url);
loadRunnerEnv(repoRoot);

const pythonBin = process.env.TRICHAT_INBOX_WORKER_PYTHON || process.env.PYTHON_BIN || "python3";
const workerScriptPath = path.join(repoRoot, "scripts", "imprint_inbox_worker.py");
const workerScript = fs.readFileSync(workerScriptPath, "utf8");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function spawnWorkerProcess() {
  return new Promise((resolve, reject) => {
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
      resolve({
        code: code ?? 0,
        signal: signal ?? null,
      });
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

async function main() {
  const startup = await prepareInboxWorkerStartup({
    repoRoot,
    env: process.env,
  });

  const release = typeof startup.release === "function" ? startup.release : () => {};
  try {
    if (startup.ok !== true) {
      process.stderr.write(
        `[imprint.inboxworker] startup blocked: ${startup.reason || "unknown"}; restart_delay_ms=${startup.restart_delay_ms ?? 0}\n`
      );
      if (startup.restart_delay_ms) {
        await sleep(startup.restart_delay_ms);
      }
      return 75;
    }

    if (startup.skipped === true && startup.reason === "singleton_locked") {
      process.stderr.write("[imprint.inboxworker] startup skipped: singleton lock already held by another worker runner\n");
      return 0;
    }

    if (startup.transport === "stdio" && startup.transport_fallback_from === "http") {
      process.stderr.write("[imprint.inboxworker] startup rollback: http_not_ready -> stdio transport\n");
      process.env.ANAMNESIS_INBOX_MCP_TRANSPORT = "stdio";
    }

    const result = await spawnWorkerProcess();
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return null;
    }
    return result.code;
  } finally {
    release();
  }
}

main().catch((error) => {
  process.stderr.write(`[imprint.inboxworker] startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
}).then((code) => {
  if (typeof code === "number") {
    process.exit(code);
  }
});
