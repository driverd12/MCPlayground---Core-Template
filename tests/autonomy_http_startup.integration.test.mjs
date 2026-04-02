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

test("http daemon serves the clickable office GUI and snapshot routes on the live control plane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-office-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const officeCacheDir = path.join(tempDir, "office-cache");
  const bearerToken = "test-autonomy-http-office-token";
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
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
      TRICHAT_OFFICE_THEME: "night",
      TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR: officeCacheDir,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    const indexHtml = await fetchHttpText(`http://127.0.0.1:${httpPort}/office/`);
    assert.match(indexHtml, /Agent Office/);

    const bootstrap = await fetchHttpJson(`http://127.0.0.1:${httpPort}/office/api/bootstrap`);
    assert.equal(bootstrap.ok, true);
    assert.equal(bootstrap.default_thread_id, "ring-leader-main");

    fs.mkdirSync(officeCacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(officeCacheDir, "latest--theme-night.json"),
      JSON.stringify({
        thread_id: "ring-leader-main",
        theme: "night",
        fetched_at: Date.now() / 1000,
        agents: [{ agent: { agent_id: "ring-leader" }, state: "supervising" }],
        summary: { kernel: { state: "idle" } },
        rooms: { "command-deck": ["ring-leader"] },
        errors: [],
      })
    );

    const snapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot`);
    assert.equal(snapshotResponse.headers["x-office-snapshot-source"], "cache");
    const snapshot = JSON.parse(snapshotResponse.body);
    assert.equal(typeof snapshot.thread_id, "string");
    assert.ok(Array.isArray(snapshot.agents));
    assert.ok(snapshot.summary);
    assert.ok(snapshot.rooms);

    const liveSnapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot?live=force`);
    assert.ok(
      ["direct-node", "cache", "cache-throttled-live"].includes(String(liveSnapshotResponse.headers["x-office-snapshot-source"] || ""))
    );
    const liveSnapshot = JSON.parse(liveSnapshotResponse.body);
    assert.equal(typeof liveSnapshot.thread_id, "string");
    assert.ok(Array.isArray(liveSnapshot.agents));
    assert.ok(liveSnapshot.summary);

    const throttledLiveSnapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot?live=1`);
    assert.ok(
      ["cache-throttled-live", "cache"].includes(String(throttledLiveSnapshotResponse.headers["x-office-snapshot-source"] || ""))
    );
    const throttledLiveSnapshot = JSON.parse(throttledLiveSnapshotResponse.body);
    assert.equal(throttledLiveSnapshot.thread_id, liveSnapshot.thread_id);

    const rawSnapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot?format=raw`);
    assert.equal(rawSnapshotResponse.headers["x-office-snapshot-source"], "direct-node-raw");
    const rawSnapshot = JSON.parse(rawSnapshotResponse.body);
    assert.equal(typeof rawSnapshot.thread_id, "string");
    assert.ok(rawSnapshot.roster);

    const cachedRawSnapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot?format=raw`);
    assert.equal(cachedRawSnapshotResponse.headers["x-office-snapshot-source"], "cache-raw");
    const cachedRawSnapshot = JSON.parse(cachedRawSnapshotResponse.body);
    assert.equal(cachedRawSnapshot.thread_id, rawSnapshot.thread_id);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office action maintain returns immediately with 202 instead of blocking on shell upkeep", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-office-action-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-office-action-token";
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
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
      MCP_AUTONOMY_MAINTAIN_ON_START: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });

    const startedAt = Date.now();
    const response = await postHttpJson(`http://127.0.0.1:${httpPort}/office/api/action`, {
      action: "maintain",
    }, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: `http://127.0.0.1:${httpPort}`,
      "Content-Type": "application/json",
    });
    const durationMs = Date.now() - startedAt;

    assert.equal(response.statusCode, 202);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "maintain");
    assert.equal(typeof payload.started_at, "string");
    assert.ok(durationMs < 10_000, `expected maintain action to return without long blocking, got ${durationMs}ms`);

    const forbidden = await postHttpJson(`http://127.0.0.1:${httpPort}/office/api/action`, {
      action: "maintain",
    }, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://malicious.example:9999",
      "Content-Type": "application/json",
    });
    assert.equal(forbidden.statusCode, 403);
    const forbiddenPayload = JSON.parse(forbidden.body);
    assert.equal(forbiddenPayload.ok, false);
    assert.equal(forbiddenPayload.error, "forbidden_origin");
    assert.match(String(forbiddenPayload.detail || ""), /origin/i);

    const health = JSON.parse(await fetchHttpText(`http://127.0.0.1:${httpPort}/health`));
    assert.equal(health.ok, true);
    assert.equal(health.status, "ok");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/ready reflects recent critical observability documents instead of reporting stale green state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-ready-observability-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-ready-observability-token";
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
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
      MCP_AUTONOMY_MAINTAIN_ON_START: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const criticalMutationKey = `http-ready-observability-critical-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    await waitForAutonomyMaintainStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });

    const readyBeforeResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    const readyBefore = JSON.parse(readyBeforeResponse.body);
    assert.equal(Array.isArray(readyBefore.attention), true);
    assert.equal(typeof readyBefore.ready, "boolean");

    const mutation = {
      idempotency_key: criticalMutationKey,
      side_effect_fingerprint: criticalMutationKey,
    };
    await execFileAsync(
      "node",
      [
        "./scripts/mcp_tool_call.mjs",
        "--tool",
        "observability.ingest",
        "--args",
        JSON.stringify({
          mutation,
          index_name: "incidents-control-plane",
          source_kind: "test.control_plane",
          documents: [
            {
              document_id: "critical-control-plane-doc",
              level: "critical",
              service: "control.plane",
              event_type: "incident",
              title: "Critical readiness regression",
              body_text: "Synthetic critical document to validate /ready observability truth.",
              tags: ["test", "critical"],
            },
          ],
        }),
        "--transport",
        "http",
        "--url",
        `http://127.0.0.1:${httpPort}/`,
        "--origin",
        "http://127.0.0.1",
        "--cwd",
        REPO_ROOT,
      ],
      {
        env: inheritedEnv({
          MCP_HTTP_BEARER_TOKEN: bearerToken,
        }),
      }
    );

    const readyAfterResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    assert.equal(readyAfterResponse.statusCode, 503);
    const readyAfter = JSON.parse(readyAfterResponse.body);
    assert.equal(readyAfter.ready, false);
    assert.equal(readyAfter.state, "degraded");
    assert.equal(readyAfter.observability.recent_critical_count >= 1, true);
    assert.equal(readyAfter.attention.includes("observability.critical_recent"), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/ready ignores recovered observability errors when a newer healthy document exists for the same service lane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-ready-observability-recovered-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-ready-observability-recovered-token";
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
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
      MCP_AUTONOMY_MAINTAIN_ON_START: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });

    const mutationKey = `http-ready-observability-recovered-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const errorCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const recoveryCreatedAt = new Date(Date.now() - 30_000).toISOString();
    await execFileAsync(
      "node",
      [
        "./scripts/mcp_tool_call.mjs",
        "--tool",
        "observability.ingest",
        "--args",
        JSON.stringify({
          mutation: {
            idempotency_key: mutationKey,
            side_effect_fingerprint: mutationKey,
          },
          index_name: "incidents-control-plane",
          source_kind: "test.control_plane",
          source_ref: "lane.control",
          documents: [
            {
              document_id: "recovered-control-plane-error",
              created_at: errorCreatedAt,
              level: "error",
              service: "control.plane",
              event_type: "incident",
              title: "Transient control plane issue",
              body_text: "Synthetic error document.",
              tags: ["test", "error"],
            },
            {
              document_id: "recovered-control-plane-ok",
              created_at: recoveryCreatedAt,
              level: "info",
              service: "control.plane",
              event_type: "recovered",
              title: "Control plane recovered",
              body_text: "Synthetic recovery document.",
              tags: ["test", "recovered"],
            },
          ],
        }),
        "--transport",
        "http",
        "--url",
        `http://127.0.0.1:${httpPort}/`,
        "--origin",
        "http://127.0.0.1",
        "--cwd",
        REPO_ROOT,
      ],
      {
        env: inheritedEnv({
          MCP_HTTP_BEARER_TOKEN: bearerToken,
        }),
      }
    );

    const readyResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    const ready = JSON.parse(readyResponse.body);
    assert.equal(ready.observability.recent_error_count, 0);
    assert.equal(ready.attention.includes("observability.error_recent"), false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("http daemon exposes fast unauthenticated root and health routes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-fast-path-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-fast-token";
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
      TRICHAT_RING_LEADER_AUTOSTART: "0",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
      MCP_AUTONOMY_MAINTAIN_ON_START: "0",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const root = JSON.parse(await waitForHttpText(`http://127.0.0.1:${httpPort}/`));
    assert.equal(root.ok, true);
    assert.equal(root.office_path, "/office/");

    const healthResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/health`);
    assert.equal(String(healthResponse.headers.connection || "").toLowerCase(), "close");
    const health = JSON.parse(healthResponse.body);
    assert.equal(health.ok, true);
    assert.equal(health.status, "ok");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", () => resolve()));
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function waitForAutonomyStatus({ url, origin, bearerToken }) {
  const deadline = Date.now() + 90000;
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

async function waitForHttpText(url) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fetchHttpText(url);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`Timed out waiting for HTTP response from ${url}`);
}

async function waitForAutonomyMaintainStatus({ url, origin, bearerToken }) {
  const deadline = Date.now() + 90000;
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

function fetchHttpText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`${response.statusCode} ${body}`));
          return;
        }
        resolve(body);
      });
    }).on("error", reject);
  });
}

function fetchHttpResponse(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 500,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    }).on("error", reject);
  });
}

function postHttpJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 500,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

async function fetchHttpJson(url, headers = {}) {
  return JSON.parse(await fetchHttpText(url, headers));
}
