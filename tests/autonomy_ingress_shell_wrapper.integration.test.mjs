import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

test("autonomy ingress shell wrapper records continuity and launches real background intake", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-ingress-shell-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_PROVIDER_BRIDGE_ROUTER_ENABLED: "0",
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      TRICHAT_MCP_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
      AUTONOMY_ENSURE_MAX_ATTEMPTS: "1",
      AUTONOMY_ENSURE_READY_TIMEOUT_SECONDS: "5",
    });

    const ensure = await runShellJson(["./scripts/autonomy_ctl.sh", "ensure"], baseEnv);
    assert.equal(ensure.ok, true);
    assert.equal(ensure.status.self_start_ready, true);

    const ingress = await runShellJson(
      [
        "./scripts/autonomy_ctl.sh",
        "ingress",
        "--session",
        "codex-shell-ingress",
        "--thread",
        "codex-shell-thread",
        "--title",
        "Shell ingress objective",
        "--dry-run",
        "--no-daemon",
        "--",
        "Take one IDE-style objective, mirror it into the office, and continue through autonomous execution.",
      ],
      baseEnv
    );

    assert.equal(ingress.ok, true);
    assert.equal(ingress.session_id, "codex-shell-ingress");
    assert.equal(ingress.thread_id, "codex-shell-thread");
    assert.equal(ingress.autonomy.execution.ok, true);
    assert.equal(ingress.autonomy.execution.dry_run ?? true, true);
    assert.equal(ingress.autonomy.goal.title, "Shell ingress objective");
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function runShellJson(command, env) {
  const [file, ...args] = command;
  const result = await execFileAsync(file, args, {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 240_000,
  });
  return parseShellJson(result.stdout, result.stderr);
}

function parseShellJson(stdout, stderr = "") {
  const text = String(stdout || "").trim();
  const fallbackText = String(stderr || "").trim();
  if (!text && !fallbackText) {
    throw new Error("Expected JSON output but both stdout and stderr were empty.");
  }
  try {
    return JSON.parse(text || fallbackText);
  } catch (originalError) {
    const lines = (text || fallbackText)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    throw originalError;
  }
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

async function startFakeOllamaServer({ models }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
