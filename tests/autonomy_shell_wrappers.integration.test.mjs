import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

test("autonomy shell wrapper ensure converges the control plane through the real script entrypoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-shell-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
    });

    const ensure = await runShellJson(["./scripts/autonomy_ctl.sh", "ensure"], baseEnv);
    assert.equal(ensure.ok, true);
    assert.equal(ensure.status.self_start_ready, true);
    assert.equal(ensure.status.worker_fabric.host_present, true);
    assert.equal(ensure.status.model_router.backend_present, true);
    assert.equal(ensure.status.ring_leader.running, true);

    const status = await runShellJson(["./scripts/autonomy_ctl.sh", "status"], baseEnv);
    assert.equal(status.self_start_ready, true);
    assert.deepEqual(status.repairs_needed, []);
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ring leader start proactively uses autonomy bootstrap on a cold control plane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ring-leader-bootstrap-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
    });

    const started = await runShellJson(["./scripts/ring_leader_ctl.sh", "start"], baseEnv);
    assert.equal(started.running, true);

    const status = await runShellJson(["./scripts/autonomy_ctl.sh", "status"], baseEnv);
    assert.equal(status.self_start_ready, true);
    assert.deepEqual(status.repairs_needed, []);
    assert.equal(status.ring_leader.running, true);
    assert.equal(status.worker_fabric.host_present, true);
    assert.equal(status.model_router.backend_present, true);
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy keepalive defaults to bounded maintenance instead of a bare readiness ping", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-keepalive-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
      AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS: "60",
      AUTONOMY_EVAL_INTERVAL_SECONDS: "300",
    });

    const maintained = await runShellJson(["./scripts/autonomy_keepalive.sh"], baseEnv);
    assert.equal(maintained.ok, true);
    assert.equal(maintained.status.state.enabled, true);
    assert.equal(maintained.status.bootstrap.self_start_ready, true);
    assert.equal(maintained.status.goal_autorun_daemon.running, true);
    assert.equal(typeof maintained.status.state.last_run_at, "string");
    assert.equal(maintained.eval.executed, true);
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy ingress shell wrapper records continuity and launches real background intake", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-ingress-shell-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-ingress-shell-token";
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });
  const httpPort = await reservePort();
  const child = spawn("node", ["dist/server.js", "--http", "--http-port", String(httpPort)], {
    cwd: REPO_ROOT,
    env: inheritedEnv({
      MCP_HTTP: "1",
      MCP_HTTP_PORT: String(httpPort),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    const baseEnv = inheritedEnv({
      TRICHAT_RING_LEADER_TRANSPORT: "http",
      TRICHAT_MCP_TRANSPORT: "http",
      TRICHAT_MCP_URL: `http://127.0.0.1:${httpPort}/`,
      TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
    });

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
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake Ollama server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve port");
  }
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForAutonomyStatus({ url, origin, bearerToken }) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync(
        "node",
        [
          "./scripts/mcp_tool_call.mjs",
          "--tool",
          "autonomy.bootstrap",
          "--args",
          '{"action":"status"}',
          "--transport",
          "http",
          "--url",
          url,
          "--origin",
          origin,
          "--cwd",
          REPO_ROOT,
        ],
        {
          cwd: REPO_ROOT,
          env: inheritedEnv({
            MCP_HTTP_BEARER_TOKEN: bearerToken,
          }),
          maxBuffer: 8 * 1024 * 1024,
        }
      );
      const parsed = JSON.parse(result.stdout);
      if (parsed?.self_start_ready) {
        return parsed;
      }
      lastError = new Error(`self_start_ready=false repairs=${JSON.stringify(parsed?.repairs_needed ?? [])}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("Timed out waiting for autonomy bootstrap readiness");
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

async function runShellJson(command, env) {
  const [file, ...args] = command;
  const result = await execFileAsync(file, args, {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
