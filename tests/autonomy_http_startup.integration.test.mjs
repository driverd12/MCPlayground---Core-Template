import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Storage } from "../dist/storage.js";
import { computeEvalDependencyFingerprint } from "../dist/tools/autonomy_maintain.js";
import {
  fetchHttpResponse,
  fetchHttpText,
  postHttpJson,
  reservePort,
  stopChildProcess,
} from "./test_process_helpers.mjs";

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
    stdio: ["ignore", "ignore", "pipe"],
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
    assert.equal((status.repairs_needed ?? []).every((entry) => String(entry).endsWith(".default_drift")), true);
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
    assert.equal(maintain.state.last_run_at, null);
    assert.equal(maintain.awaiting_first_tick, true);

    const readyResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    assert.equal(readyResponse.statusCode, 503);
    const readyPayload = JSON.parse(readyResponse.body);
    assert.equal(readyPayload.ready, false);
    assert.equal(readyPayload.autonomy_maintain.awaiting_first_tick, true);
    assert.ok(readyPayload.attention.includes("autonomy_maintain.awaiting_first_tick"));
  } finally {
    await stopChildProcess(child);
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
  const seededLastRunAt = "2026-01-01T00:00:00.000Z";
  const storage = new Storage(dbPath);
  storage.init();
  storage.setAutonomyMaintainState({
    enabled: false,
    interval_seconds: 120,
    learning_review_interval_seconds: 300,
    eval_interval_seconds: 21600,
    last_run_at: seededLastRunAt,
  });
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
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    const maintain = await waitForAutonomyMaintainStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    assert.equal(maintain.runtime.running, true);
    assert.equal(maintain.state.enabled, true);
    assert.equal(maintain.state.last_run_at, seededLastRunAt);
  } finally {
    await stopChildProcess(child);
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
    stdio: ["ignore", "ignore", "pipe"],
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
    assert.ok(
      ["cache", "direct-node"].includes(String(snapshotResponse.headers["x-office-snapshot-source"] || ""))
    );
    const snapshot = JSON.parse(snapshotResponse.body);
    assert.equal(typeof snapshot.thread_id, "string");
    assert.ok(Array.isArray(snapshot.agents));
    assert.ok(snapshot.summary);
    assert.ok(snapshot.rooms);

    const liveSnapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot?live=force`);
    assert.ok(
      [
        "direct-node",
        "direct-python",
        "cache",
        "cache-throttled-live",
        "cache-fallback",
        "cache-refreshing-live",
        "cache-refreshing-stale",
      ].includes(
        String(liveSnapshotResponse.headers["x-office-snapshot-source"] || "")
      )
    );
    const liveSnapshot = JSON.parse(liveSnapshotResponse.body);
    assert.equal(typeof liveSnapshot.thread_id, "string");
    assert.ok(Array.isArray(liveSnapshot.agents));
    assert.ok(liveSnapshot.summary);

    const throttledLiveSnapshotResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/office/api/snapshot?live=1`);
    assert.ok(
      [
        "cache-throttled-live",
        "cache",
        "cache-fallback",
        "cache-refreshing-live",
        "cache-refreshing-stale",
        "direct-node",
        "direct-python",
      ].includes(String(throttledLiveSnapshotResponse.headers["x-office-snapshot-source"] || ""))
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
    await stopChildProcess(child);
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office action maintain returns immediately with 202 instead of blocking on shell upkeep", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-office-action-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const officeCacheDir = path.join(tempDir, "office-cache");
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
      TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR: officeCacheDir,
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    const startupHealth = JSON.parse(await waitForHttpText(`http://127.0.0.1:${httpPort}/health`));
    assert.equal(startupHealth.ok, true);

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
    await stopChildProcess(child);
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office intake dry run returns immediately with 202 instead of blocking on autonomy ingress", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-office-intake-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-office-intake-token";
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
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    const startupHealth = JSON.parse(await waitForHttpText(`http://127.0.0.1:${httpPort}/health`));
    assert.equal(startupHealth.ok, true);

    const startedAt = Date.now();
    const response = await postHttpJson(`http://127.0.0.1:${httpPort}/office/api/intake`, {
      title: "Office intake dry run",
      objective: "Validate office intake can acknowledge dry-run dispatch without blocking.",
      risk: "medium",
      dry_run: true,
    }, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: `http://127.0.0.1:${httpPort}`,
      "Content-Type": "application/json",
    });
    const durationMs = Date.now() - startedAt;

    assert.equal(response.statusCode, 202);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "intake");
    assert.equal(payload.dry_run, true);
    assert.equal(typeof payload.started_at, "string");
    assert.match(String(payload.objective_preview || ""), /Validate office intake/);
    assert.ok(durationMs < 10_000, `expected intake dry run to return without long blocking, got ${durationMs}ms`);

    const health = JSON.parse(await fetchHttpText(`http://127.0.0.1:${httpPort}/health`));
    assert.equal(health.ok, true);
    assert.equal(health.status, "ok");
  } finally {
    await stopChildProcess(child);
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
    stdio: ["ignore", "ignore", "pipe"],
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
        timeout: 15_000,
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
    await stopChildProcess(child);
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
    stdio: ["ignore", "ignore", "pipe"],
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
        timeout: 15_000,
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
    await stopChildProcess(child);
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/ready stays green when the last accepted eval passes but the next eval is merely overdue", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-ready-overdue-eval-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-ready-overdue-eval-token";
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
      TRICHAT_RING_LEADER_AUTOSTART: "0",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
      MCP_AUTONOMY_MAINTAIN_ON_START: "0",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHttpText(`http://127.0.0.1:${httpPort}/`);
    await callHttpToolJson({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
      tool: "reaction.engine",
      args: {
        action: "start",
        mutation: {
          idempotency_key: "ready-definition-drift-reaction-start",
          side_effect_fingerprint: "ready-definition-drift-reaction-start",
        },
        run_immediately: false,
      },
    });
    const maintainStart = await callHttpToolJson({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
      tool: "autonomy.maintain",
      args: {
        action: "start",
        mutation: {
          idempotency_key: "ready-definition-drift-maintain-start",
          side_effect_fingerprint: "ready-definition-drift-maintain-start",
        },
        local_host_id: "local",
        ensure_bootstrap: false,
        autostart_ring_leader: false,
        run_immediately: false,
      },
    });
    assert.equal(maintainStart.status.awaiting_first_tick, true);
    assert.equal(maintainStart.status.attention.includes("autonomy_maintain.awaiting_first_tick"), true);
    const readinessWhileAwaiting = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    const awaitingReady = JSON.parse(readinessWhileAwaiting.body);
    assert.equal(awaitingReady.ready, false);
    assert.equal(awaitingReady.autonomy_maintain.awaiting_first_tick, true);
    assert.equal(awaitingReady.attention.includes("autonomy_maintain.awaiting_first_tick"), true);
    const storage = new Storage(dbPath);
    const suiteId = "autonomy.control-plane";
    const dependencyFingerprint = computeEvalDependencyFingerprint(storage, suiteId);
    storage.upsertObservabilityDocument({
      document_id: "ready-definition-drift-health",
      index_name: "control-plane",
      source_kind: "test",
      source_ref: "autonomy_http_startup.integration",
      level: "info",
      host_id: "local",
      service: "control-plane",
      event_type: "healthy",
      title: "healthy control plane",
      body_text: "Seed healthy observability document for advisory eval drift test.",
      tags: ["healthy"],
    });
    storage.setAutonomyMaintainState({
      enabled: true,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: suiteId,
      minimum_eval_score: 75,
      last_run_at: new Date().toISOString(),
      last_eval_run_at: new Date(Date.now() - 10 * 60 * 60_000).toISOString(),
      last_eval_run_id: "ready-overdue-eval",
      last_eval_score: 100,
      last_eval_dependency_fingerprint: dependencyFingerprint,
      last_actions: ["eval.completed"],
      last_attention: [],
      last_error: null,
    });
    const readyResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    const ready = JSON.parse(readyResponse.body);
    assert.equal(ready.autonomy_maintain.eval_due, true);
    assert.equal(ready.autonomy_maintain.eval_health.operational, true);
    assert.equal(ready.autonomy_maintain.eval_health.healthy, true);
    assert.equal(ready.autonomy_maintain.awaiting_first_tick, false);
    assert.equal(ready.attention.includes("autonomy_eval.unhealthy"), false);
  } finally {
    await stopChildProcess(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/ready stays green when eval drift is advisory but the last accepted score is still operational", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-http-ready-definition-drift-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-autonomy-http-ready-definition-drift-token";
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
      TRICHAT_RING_LEADER_AUTOSTART: "0",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
      MCP_AUTONOMY_MAINTAIN_ON_START: "0",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHttpText(`http://127.0.0.1:${httpPort}/`);
    await callHttpToolJson({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
      tool: "reaction.engine",
      args: {
        action: "start",
        mutation: {
          idempotency_key: "ready-definition-drift-reaction-start",
          side_effect_fingerprint: "ready-definition-drift-reaction-start",
        },
        run_immediately: false,
      },
    });
    await callHttpToolJson({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
      tool: "autonomy.maintain",
      args: {
        action: "start",
        mutation: {
          idempotency_key: "ready-definition-drift-maintain-start",
          side_effect_fingerprint: "ready-definition-drift-maintain-start",
        },
        local_host_id: "local",
        ensure_bootstrap: false,
        autostart_ring_leader: false,
        run_immediately: false,
      },
    });
    const storage = new Storage(dbPath);
    const suiteId = "autonomy.control-plane";
    const dependencyFingerprint = computeEvalDependencyFingerprint(storage, suiteId);
    storage.upsertObservabilityDocument({
      document_id: "ready-definition-drift-health",
      index_name: "control-plane",
      source_kind: "test",
      source_ref: "autonomy_http_startup.integration",
      level: "info",
      host_id: "local",
      service: "control-plane",
      event_type: "healthy",
      title: "healthy control plane",
      body_text: "Seed healthy observability document for advisory eval drift test.",
      tags: ["healthy"],
    });
    storage.setAutonomyMaintainState({
      enabled: true,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: suiteId,
      minimum_eval_score: 75,
      last_run_at: new Date().toISOString(),
      last_eval_run_at: new Date().toISOString(),
      last_eval_run_id: "ready-definition-baseline",
      last_eval_score: 100,
      last_eval_dependency_fingerprint: dependencyFingerprint,
      last_actions: ["eval.completed"],
      last_attention: [],
      last_error: null,
    });
    await waitForReadyState(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    storage.setAutonomyMaintainState({
      enabled: true,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      enable_self_drive: true,
      self_drive_cooldown_seconds: 1800,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: suiteId,
      minimum_eval_score: 75,
      last_run_at: new Date().toISOString(),
      last_eval_run_at: new Date().toISOString(),
      last_eval_run_id: "ready-definition-drift",
      last_eval_score: 100,
      last_eval_dependency_fingerprint: "stale-fingerprint",
      last_actions: ["eval.completed"],
      last_attention: [],
      last_error: null,
    });
    const readyResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    const ready = JSON.parse(readyResponse.body);
    assert.equal(readyResponse.statusCode, 200);
    assert.equal(ready.ready, true);
    assert.equal(ready.autonomy_maintain.eval_health.operational, true);
    assert.equal(ready.autonomy_maintain.eval_health.due_by_dependency_drift, true);
    assert.equal(ready.attention.includes("autonomy_eval.unhealthy"), false);
    assert.equal(ready.attention.includes("autonomy_eval.definition_changed"), false);
  } finally {
    await stopChildProcess(child);
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
    stdio: ["ignore", "ignore", "pipe"],
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
    await stopChildProcess(child);
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("office api toggles MASTER-MOLD mode through the local stdio lane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-office-patient-zero-action-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-office-patient-zero-action-token";
  const httpPort = await reservePort();
  const origin = `http://127.0.0.1:${httpPort}`;
  const child = spawn("node", ["dist/server.js", "--http", "--http-port", String(httpPort)], {
    cwd: REPO_ROOT,
    env: inheritedEnv({
      MCP_HTTP: "1",
      MCP_HTTP_PORT: String(httpPort),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_RING_LEADER_AUTOSTART: "0",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
      MCP_AUTONOMY_MAINTAIN_ON_START: "0",
      MCP_PATIENT_ZERO_AUTHORITY_AUDIT_JSON: JSON.stringify({
        platform: "darwin",
        ready_for_patient_zero_full_authority: false,
        blockers: ["test_authority_not_ready"],
      }),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    const health = JSON.parse(await waitForHttpText(`${origin}/health`));
    assert.equal(health.ok, true);

    const enableResponse = await postHttpJson(
      `${origin}/office/api/action`,
      {
        action: "patient_zero_enable",
        operator_note: "integration test enable",
      },
      {
        Authorization: `Bearer ${bearerToken}`,
        Origin: origin,
        "Content-Type": "application/json",
      }
    );
    assert.equal(enableResponse.statusCode, 200);
    const enablePayload = JSON.parse(enableResponse.body);
    assert.equal(enablePayload.ok, true);
    assert.equal(enablePayload.action, "patient_zero_enable");
    assert.equal(enablePayload.result.state.enabled, true);
    assert.equal(enablePayload.result.summary.enabled, true);

    const disableResponse = await postHttpJson(
      `${origin}/office/api/action`,
      {
        action: "patient_zero_disable",
        operator_note: "integration test disable",
      },
      {
        Authorization: `Bearer ${bearerToken}`,
        Origin: origin,
        "Content-Type": "application/json",
      }
    );
    assert.equal(disableResponse.statusCode, 200);
    const disablePayload = JSON.parse(disableResponse.body);
    assert.equal(disablePayload.ok, true);
    assert.equal(disablePayload.action, "patient_zero_disable");
    assert.equal(disablePayload.result.state.enabled, false);
    assert.equal(disablePayload.result.summary.enabled, false);
  } finally {
    await stopChildProcess(child);
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
          timeout: 15_000,
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
      return await fetchHttpText(url, {}, { timeoutMs: 2_500 });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`Timed out waiting for HTTP response from ${url}`);
}

async function waitForReadyState(url, headers = {}) {
  const deadline = Date.now() + 60000;
  let lastResponse = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastResponse = await fetchHttpResponse(url, headers, { timeoutMs: 2_500 });
      const parsed = JSON.parse(lastResponse.body);
      if (lastResponse.statusCode === 200 && parsed?.ready === true) {
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ready state: ${lastResponse?.body ?? "no response"}`);
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
          timeout: 15_000,
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

async function callHttpToolJson({ url, origin, bearerToken, tool, args }) {
  const result = await execFileAsync(
    "node",
    [
      "./scripts/mcp_tool_call.mjs",
      "--tool",
      tool,
      "--args",
      JSON.stringify(args),
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
      timeout: 15_000,
    }
  );
  return JSON.parse(result.stdout);
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

async function fetchHttpJson(url, headers = {}) {
  return JSON.parse(await fetchHttpText(url, headers));
}
