import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

test("http daemon self-converges the autonomy bootstrap on startup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-token";
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
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const status = await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    assert.equal(status.self_start_ready, true);
    assert.deepEqual(status.repairs_needed, []);
    assert.equal(status.ring_leader.running, true);
    assert.equal(status.worker_fabric.host_present, true);
    assert.equal(status.model_router.backend_present, true);

    const maintain = await waitForAutonomyMaintainStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    assert.equal(maintain.runtime.running, true);
    assert.equal(maintain.runtime.last_error ?? null, null);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("[autonomy.bootstrap] startup ensure failed"), false);
});

test("http daemon starts autonomy maintain even when bootstrap-on-start is disabled", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-maintain-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-maintain-token";
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });
  const httpPort = await reservePort();
  const child = spawn("node", ["dist/server.js", "--http", "--http-port", String(httpPort)], {
    cwd: REPO_ROOT,
    env: inheritedEnv({
      MCP_HTTP: "1",
      MCP_HTTP_PORT: String(httpPort),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
      MCP_AUTONOMY_MAINTAIN_ON_START: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const maintain = await waitForAutonomyMaintainStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    assert.equal(maintain.runtime.running, true);
    assert.equal(maintain.state.enabled, true);
    assert.equal(typeof maintain.state.last_run_at, "string");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

async function waitForAutonomyMaintainStatus({ url, origin, bearerToken }) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync(
        "node",
        [
          "./scripts/mcp_tool_call.mjs",
          "--tool",
          "autonomy.maintain",
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
      if (parsed?.runtime?.running) {
        return parsed;
      }
      lastError = new Error(`autonomy.maintain runtime not running: ${JSON.stringify(parsed?.runtime ?? {})}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("Timed out waiting for autonomy maintain runtime");
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
