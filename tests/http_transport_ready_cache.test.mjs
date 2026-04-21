import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  approvedHostNetworkMatch,
  buildHostIdentitySignaturePayload,
  parseJsonText,
  remoteToolAllowedForPermission,
  startHttpTransport,
  verifyHostIdentitySignature,
} from "../dist/transports/http.js";

function officeHttpCachePath(cacheDir, cacheFile) {
  return path.join(cacheDir, "web", cacheFile);
}

function officeDashboardCachePath(cacheDir, cacheFile) {
  return path.join(cacheDir, "dashboard", cacheFile);
}

test("parseJsonText unwraps quoted JSON payloads from child tools", () => {
  const wrapped = JSON.stringify(JSON.stringify({ ok: true, nested: { value: 7 } }));
  assert.deepEqual(parseJsonText(wrapped), { ok: true, nested: { value: 7 } });
});

test("parseJsonText recovers a trailing JSON object from noisy child stdout", () => {
  const noisy = ['warning: stale child preamble', '', '{"ok":true,"agents":[{"agent_id":"ring-leader"}]}'].join("\n");
  assert.deepEqual(parseJsonText(noisy), {
    ok: true,
    agents: [{ agent_id: "ring-leader" }],
  });
});

test("approved host network matching treats IP as a locator and hostname/MAC as identity evidence", async () => {
  const host = {
    host_id: "dans-mbp",
    enabled: true,
    metadata: {
      remote_access: {
        status: "approved",
        hostname: "Dans-MBP.local",
        ip_address: "10.1.2.76",
        allowed_addresses: ["10.1.2.76"],
        mac_address: "aa:bb:cc:dd:ee:ff",
      },
    },
  };

  const hostnameMatch = await approvedHostNetworkMatch("10.1.3.224", host, {
    resolveHostnameAddresses: async (hostname) => {
      assert.equal(hostname, "Dans-MBP.local");
      return ["10.1.3.224"];
    },
    lookupLanMacAddress: () => null,
  });
  assert.equal(hostnameMatch.reason, "approved_host_hostname");

  const macMatch = await approvedHostNetworkMatch("10.1.4.88", host, {
    resolveHostnameAddresses: async () => [],
    lookupLanMacAddress: () => "aa:bb:cc:dd:ee:ff",
  });
  assert.equal(macMatch.reason, "approved_host_mac");
});

test("signed host identity verifies Ed25519 proof and permission scopes deny high-risk tools", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const timestamp = "2026-04-21T18:00:00.000Z";
  const nonce = "nonce-1";
  const agentId = "claude-opus";
  const payload = buildHostIdentitySignaturePayload({
    method: "*",
    path: "*",
    host_id: "dans-mbp",
    agent_id: agentId,
    timestamp,
    nonce,
  });
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
  const host = {
    host_id: "dans-mbp",
    metadata: {
      remote_access: {
        status: "approved",
        identity_public_key: publicKeyPem,
      },
    },
  };

  const verified = verifyHostIdentitySignature({
    method: "POST",
    path: "/",
    host,
    nowMs: Date.parse(timestamp),
    headers: {
      "x-master-mold-host-id": "dans-mbp",
      "x-master-mold-agent-id": agentId,
      "x-master-mold-timestamp": timestamp,
      "x-master-mold-nonce": nonce,
      "x-master-mold-signature": `ed25519:${signature}`,
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.status, "verified");
  assert.equal(verified.agent_id, agentId);
  assert.match(verified.fingerprint, /^sha256:/);

  const missing = verifyHostIdentitySignature({
    method: "POST",
    path: "/",
    host,
    nowMs: Date.parse(timestamp),
    headers: {
      "x-master-mold-host-id": "dans-mbp",
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "missing");

  assert.equal(remoteToolAllowedForPermission("agent.report_result", "task_worker"), true);
  assert.equal(
    remoteToolAllowedForPermission("worker.fabric", "task_worker", { action: "heartbeat", host_id: "dans-mbp" }, { host_id: "dans-mbp" }),
    true
  );
  assert.equal(
    remoteToolAllowedForPermission("worker.fabric", "task_worker", { action: "approve_remote_host", host_id: "dans-mbp" }, { host_id: "dans-mbp" }),
    false
  );
  assert.equal(remoteToolAllowedForPermission("artifact.record", "artifact_writer"), true);
  assert.equal(remoteToolAllowedForPermission("task.complete", "read_only"), false);
  assert.equal(remoteToolAllowedForPermission("desktop.context", "task_worker", { host_id: "dans-mbp" }, { host_id: "dans-mbp" }), true);
  assert.equal(remoteToolAllowedForPermission("desktop.context", "task_worker", { host_id: "main-mac" }, { host_id: "dans-mbp" }), false);
  assert.equal(remoteToolAllowedForPermission("desktop.control", "task_worker"), false);
});

test("HTTP transport refuses LAN binds unless explicitly enabled", { concurrency: false }, async () => {
  const previousLan = process.env.MCP_HTTP_ALLOW_LAN;
  delete process.env.MCP_HTTP_ALLOW_LAN;
  const port = await reservePort();

  try {
    await assert.rejects(
      () =>
        startHttpTransport(
          () =>
            new Server(
              {
                name: "http-lan-bind-test",
                version: "1.0.0",
              },
              {
                capabilities: {
                  tools: {},
                },
              }
            ),
          {
            host: "0.0.0.0",
            port,
            allowedOrigins: ["http://127.0.0.1"],
            bearerToken: "lan-bind-token",
          }
        ),
      /MCP_HTTP_ALLOW_LAN=1/
    );
  } finally {
    if (previousLan === undefined) {
      delete process.env.MCP_HTTP_ALLOW_LAN;
    } else {
      process.env.MCP_HTTP_ALLOW_LAN = previousLan;
    }
  }
});

test("/office/api/hosts bridges GUI host pairing actions into worker.fabric mutations", { concurrency: false }, async () => {
  const calls = [];
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-hosts-api-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-hosts-token",
      officeHostFabric: async (input) => {
        calls.push(input);
        return {
          ok: true,
          action: input.action,
          host_id: input.host_id ?? input.remote_host?.host_id ?? null,
        };
      },
    }
  );

  try {
    const status = await fetchHttpJsonResponse(port, "/office/api/hosts");
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.ok, true);
    assert.equal(calls[0].action, "status");
    assert.equal(calls[0].source_client, "office.api");

    const staged = await fetchHttpJsonResponse(port, "/office/api/hosts", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1",
        "Content-Type": "application/json",
      },
      body: {
        action: "stage_remote_host",
        remote_host: {
          host_id: "dans-mbp",
          display_name: "Dan's MacBook Pro",
          hostname: "Dans-MBP.local",
          ip_address: "10.1.2.76",
          workspace_root: "/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD",
        },
      },
    });
    assert.equal(staged.statusCode, 200);
    assert.equal(staged.body.ok, true);
    assert.equal(staged.body.action, "stage_remote_host");
    assert.equal(calls[1].action, "stage_remote_host");
    assert.equal(calls[1].remote_host.host_id, "dans-mbp");
    assert.equal(typeof calls[1].mutation.idempotency_key, "string");

    const approved = await fetchHttpJsonResponse(port, "/office/api/hosts", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1",
        "Content-Type": "application/json",
      },
      body: {
        action: "approve_remote_host",
        host_id: "dans-mbp",
      },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body.ok, true);
    assert.equal(calls[2].action, "approve_remote_host");
    assert.equal(calls[2].host_id, "dans-mbp");
    assert.equal(calls[2].source_agent, "operator");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("/remote-access/request stages a pending sanitized host request without bearer auth", { concurrency: false }, async () => {
  const calls = [];
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-remote-access-request-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "remote-access-request-token",
      officeHostFabric: async (input) => {
        calls.push(input);
        return {
          host: {
            host_id: input.remote_host.host_id,
            metadata: {
              remote_access: {
                pairing_code: "REQ12345",
              },
            },
          },
        };
      },
    }
  );

  try {
    const response = await fetchHttpJsonResponse(port, "/remote-access/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        action: "approve_remote_host",
        host_id: "many-host",
        hostname: "ManyHost.local",
        ip_address: "203.0.113.25",
        workspace_root: "/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD",
        approve: true,
        request_desktop_context: true,
        identity_public_key: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAremotehosttestidentitypublickey=\n-----END PUBLIC KEY-----",
        capabilities: { operator: true },
      },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.status, "pending");
    assert.equal(response.body.host_id, "many-host");
    assert.equal(response.body.pairing_code, "REQ12345");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "stage_remote_host");
    assert.equal(calls[0].remote_host.approve, false);
    assert.deepEqual(calls[0].remote_host.allowed_addresses, ["127.0.0.1"]);
    assert.equal(calls[0].remote_host.ip_address, "127.0.0.1");
    assert.match(calls[0].remote_host.identity_public_key, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.deepEqual(calls[0].remote_host.capabilities, { desktop_context: true, desktop_observe: true });
    assert.equal(calls[0].remote_host.capabilities.operator, undefined);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("/office/api/hosts verifies an SSH host with a bounded liveness probe", { concurrency: false }, async () => {
  const previousPath = process.env.PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-host-verify-"));
  const sshPath = path.join(tempDir, "ssh");
  await writeFile(sshPath, "#!/bin/sh\nprintf mcp-host-ok\n");
  await chmod(sshPath, 0o755);
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;

  const calls = [];
  const fabricState = {
    hosts: [
      {
        host_id: "dans-mbp",
        enabled: true,
        transport: "ssh",
        ssh_destination: "dan.driver@Dans-MBP.local",
        workspace_root: "/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD",
        worker_count: 1,
        capabilities: {},
        tags: ["remote", "approved-host"],
        telemetry: {
          health_state: "degraded",
          heartbeat_at: new Date(0).toISOString(),
        },
        metadata: {
          remote_access: {
            status: "approved",
            ip_address: "10.1.2.76",
            allowed_addresses: ["10.1.2.76"],
          },
        },
      },
    ],
  };
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-hosts-verify-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-hosts-verify-token",
      officeHostFabric: async (input) => {
        calls.push(input);
        if (input.action === "heartbeat") {
          fabricState.hosts[0].telemetry = {
            ...fabricState.hosts[0].telemetry,
            ...input.telemetry,
          };
          fabricState.hosts[0].capabilities = {
            ...fabricState.hosts[0].capabilities,
            ...input.capabilities,
          };
        }
        return {
          state: fabricState,
        };
      },
    }
  );

  try {
    const response = await fetchHttpJsonResponse(port, "/office/api/hosts", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1",
        "Content-Type": "application/json",
      },
      body: {
        action: "verify_remote_host",
        host_id: "dans-mbp",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.verification.connected, true);
    assert.equal(calls[0].action, "status");
    assert.equal(calls[1].action, "heartbeat");
    assert.equal(calls[1].host_id, "dans-mbp");
    assert.equal(calls[1].telemetry.health_state, "healthy");
    assert.equal(calls[1].capabilities.remote_verify_ok, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("/ready falls back to the last successful cached snapshot when the live health snapshot stalls", { concurrency: false }, async () => {
  const previousTimeout = process.env.MCP_HTTP_READY_TIMEOUT_MS;
  const previousCacheMaxAge = process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS;
  process.env.MCP_HTTP_READY_TIMEOUT_MS = "75";
  process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS = "30";

  let callCount = 0;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-ready-cache-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "ready-cache-token",
      healthSnapshot: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ready: true,
            state: "ready",
            attention: [],
          };
        }
        await new Promise(() => {});
      },
    }
  );

  try {
    const first = await fetchReady(port);
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["x-ready-source"], "live");
    assert.equal(first.body.ready, true);

    const second = await fetchReady(port);
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers["x-ready-source"], "cache-fallback");
    assert.equal(second.body.ready, true);
    assert.equal(Array.isArray(second.body.attention), true);
    assert.equal(second.body.attention.includes("ready.cache_fallback"), true);
    assert.equal(typeof second.body.ready_cache_age_seconds, "number");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousTimeout === undefined) {
      delete process.env.MCP_HTTP_READY_TIMEOUT_MS;
    } else {
      process.env.MCP_HTTP_READY_TIMEOUT_MS = previousTimeout;
    }
    if (previousCacheMaxAge === undefined) {
      delete process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS;
    } else {
      process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS = previousCacheMaxAge;
    }
  }
});

test("/ready returns a degraded stale-cache payload when only an older cached snapshot is available", { concurrency: false }, async () => {
  const previousTimeout = process.env.MCP_HTTP_READY_TIMEOUT_MS;
  const previousCacheMaxAge = process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS;
  const previousStaleCacheMaxAge = process.env.MCP_HTTP_READY_STALE_CACHE_MAX_AGE_SECONDS;
  process.env.MCP_HTTP_READY_TIMEOUT_MS = "75";
  process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS = "1";
  process.env.MCP_HTTP_READY_STALE_CACHE_MAX_AGE_SECONDS = "5";

  let callCount = 0;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-ready-stale-cache-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "ready-stale-cache-token",
      healthSnapshot: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ready: true,
            state: "ready",
            attention: [],
          };
        }
        await new Promise(() => {});
      },
    }
  );

  try {
    const first = await fetchReady(port, "ready-stale-cache-token");
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["x-ready-source"], "live");
    assert.equal(first.body.ready, true);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const second = await fetchReady(port, "ready-stale-cache-token");
    assert.equal(second.statusCode, 503);
    assert.equal(second.headers["x-ready-source"], "cache-stale");
    assert.equal(second.body.ready, false);
    assert.equal(Array.isArray(second.body.attention), true);
    assert.equal(second.body.attention.includes("ready.cache_stale"), true);
    assert.equal(typeof second.body.ready_cache_age_seconds, "number");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousTimeout === undefined) {
      delete process.env.MCP_HTTP_READY_TIMEOUT_MS;
    } else {
      process.env.MCP_HTTP_READY_TIMEOUT_MS = previousTimeout;
    }
    if (previousCacheMaxAge === undefined) {
      delete process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS;
    } else {
      process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS = previousCacheMaxAge;
    }
    if (previousStaleCacheMaxAge === undefined) {
      delete process.env.MCP_HTTP_READY_STALE_CACHE_MAX_AGE_SECONDS;
    } else {
      process.env.MCP_HTTP_READY_STALE_CACHE_MAX_AGE_SECONDS = previousStaleCacheMaxAge;
    }
  }
});

test("/office/api/snapshot honors explicit live refreshes but throttles repeated live polling", { concurrency: false }, async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const previousRefreshSeconds = process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-cache-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;
  process.env.TRICHAT_OFFICE_REFRESH_SECONDS = "2";

  let snapshotCalls = 0;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-live-force-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-live-force-token",
      officeSnapshot: async ({ threadId, theme, forceLive }) => {
        snapshotCalls += 1;
        return {
          thread_id: threadId,
          theme,
          fetched_at: Date.now() / 1000,
          agents: [{ agent: { agent_id: "ring-leader" }, state: forceLive ? "live" : "cached" }],
          summary: {},
          rooms: {},
          errors: [],
        };
      },
    }
  );

  try {
    const explicitLive = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(explicitLive.statusCode, 200);
    assert.equal(explicitLive.headers["x-office-snapshot-source"], "direct-node");
    assert.equal(snapshotCalls, 1);

    const throttledLive = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=1");
    assert.equal(throttledLive.statusCode, 200);
    assert.equal(throttledLive.headers["x-office-snapshot-source"], "cache-throttled-live");
    assert.equal(snapshotCalls, 1);

    const cached = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.headers["x-office-snapshot-source"], "cache");
    assert.equal(snapshotCalls, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    if (previousRefreshSeconds === undefined) {
      delete process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_REFRESH_SECONDS = previousRefreshSeconds;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
});

test("/office/api/snapshot does not serve a stale GUI cache when a direct node refresh can succeed", { concurrency: false }, async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const previousRefreshSeconds = process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
  const previousCacheMaxAge = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS;
  const previousStaleMaxAge = process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-stale-gui-cache-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;
  process.env.TRICHAT_OFFICE_REFRESH_SECONDS = "2";
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS = "2";
  process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS = "120";

  let snapshotCalls = 0;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-stale-gui-cache-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-stale-gui-cache-token",
      officeSnapshot: async ({ threadId, theme }) => {
        snapshotCalls += 1;
        return {
          thread_id: threadId,
          theme,
          fetched_at: Date.now() / 1000,
          agents: [{ agent: { agent_id: `fresh-${snapshotCalls}` }, state: "ready" }],
          summary: {},
          rooms: {},
          errors: [],
        };
      },
    }
  );

  try {
    const seeded = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(seeded.statusCode, 200);
    assert.equal(seeded.headers["x-office-snapshot-source"], "direct-node");
    assert.equal(snapshotCalls, 1);

    for (const cacheFile of ["latest--theme-night.json", "thread-ring-leader-main--theme-night.json"]) {
      const cachePath = officeHttpCachePath(tempCacheDir, cacheFile);
      const parsed = JSON.parse(await readFile(cachePath, "utf8"));
      parsed.fetched_at = Date.now() / 1000 - 30;
      await writeFile(cachePath, JSON.stringify(parsed));
    }

    const refreshed = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.headers["x-office-snapshot-source"], "cache-refreshing-stale");
    assert.equal(refreshed.headers["x-office-refresh-state"], "pending");
    assert.equal(refreshed.body.agents[0].agent.agent_id, "fresh-1");

    await waitFor(() => snapshotCalls === 2);

    const updated = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.headers["x-office-snapshot-source"], "cache");
    assert.equal(snapshotCalls, 2);
    assert.equal(updated.body.agents[0].agent.agent_id, "fresh-2");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    if (previousRefreshSeconds === undefined) {
      delete process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_REFRESH_SECONDS = previousRefreshSeconds;
    }
    if (previousCacheMaxAge === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS = previousCacheMaxAge;
    }
    if (previousStaleMaxAge === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS = previousStaleMaxAge;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
});

test("/office/api/snapshot serves an expired cache immediately when refresh cannot complete in time", { concurrency: false }, async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const previousRefreshSeconds = process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
  const previousCacheMaxAge = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS;
  const previousStaleMaxAge = process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-expired-cache-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;
  process.env.TRICHAT_OFFICE_REFRESH_SECONDS = "2";
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS = "2";
  process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS = "10";

  const webCacheDir = path.join(tempCacheDir, "web");
  await mkdir(webCacheDir, { recursive: true });
  const expiredPayload = {
    thread_id: "ring-leader-main",
    theme: "night",
    fetched_at: Date.now() / 1000 - 3600,
    agents: [{ agent: { agent_id: "expired-ring-leader" }, state: "sleeping" }],
    summary: {},
    rooms: {},
    errors: [],
  };
  for (const cacheFile of ["latest--theme-night.json", "thread-ring-leader-main--theme-night.json"]) {
    await writeFile(officeHttpCachePath(tempCacheDir, cacheFile), JSON.stringify(expiredPayload), "utf8");
  }

  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-expired-cache-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-expired-cache-token",
      officeSnapshot: async () => {
        await new Promise(() => {});
      },
    }
  );

  try {
    const response = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-office-snapshot-source"], "cache-expired-refreshing");
    assert.equal(response.headers["x-office-refresh-state"], "pending");
    assert.equal(response.headers["x-office-snapshot-stale"], "true");
    assert.equal(response.body.agents[0].agent.agent_id, "expired-ring-leader");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    if (previousRefreshSeconds === undefined) {
      delete process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_REFRESH_SECONDS = previousRefreshSeconds;
    }
    if (previousCacheMaxAge === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS = previousCacheMaxAge;
    }
    if (previousStaleMaxAge === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS = previousStaleMaxAge;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
});

test("/office/api/snapshot ignores dashboard cache files and uses the web cache lane only", { concurrency: false }, async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-cache-lanes-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;

  let snapshotCalls = 0;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-cache-lane-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-cache-lane-token",
      officeSnapshot: async ({ threadId, theme }) => {
        snapshotCalls += 1;
        return {
          thread_id: threadId,
          theme,
          fetched_at: Date.now() / 1000,
          agents: [{ agent: { agent_id: "gemini" }, state: "sleeping", evidence_source: "provider_bridge" }],
          summary: {},
          rooms: {},
          errors: [],
        };
      },
    }
  );

  try {
    const dashboardCacheFile = officeDashboardCachePath(tempCacheDir, "thread-ring-leader-main--theme-night.json");
    await mkdir(path.dirname(dashboardCacheFile), { recursive: true });
    await writeFile(
      dashboardCacheFile,
      JSON.stringify({
        thread_id: "ring-leader-main",
        theme: "night",
        fetched_at: Date.now() / 1000,
        agents: [{ agent: { agent_id: "gemini" }, state: "supervising", evidence_source: "tmux:delegate" }],
        summary: {},
        rooms: {},
        errors: [],
      })
    );

    const first = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["x-office-snapshot-source"], "direct-node");
    assert.equal(snapshotCalls, 1);
    assert.equal(first.body.agents[0].state, "sleeping");
    assert.equal(first.body.agents[0].evidence_source, "provider_bridge");

    const second = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers["x-office-snapshot-source"], "cache");
    assert.equal(snapshotCalls, 1);
    assert.equal(second.body.agents[0].state, "sleeping");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
});

test("/office/api/realtime overlays live provider diagnostics onto cached office truth and memoizes the live payload", { concurrency: false }, async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const previousLiveInterval = process.env.TRICHAT_OFFICE_LIVE_STATUS_INTERVAL_MS;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-realtime-cache-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;
  process.env.TRICHAT_OFFICE_LIVE_STATUS_INTERVAL_MS = "5000";

  const fetchedAt = Date.now() / 1000 - 30;
  const cachedSnapshot = {
    thread_id: "ring-leader-main",
    theme: "night",
    fetched_at: fetchedAt,
    fetched_at_iso: new Date(fetchedAt * 1000).toISOString(),
    agents: [
      {
        agent: { agent_id: "gemini", display_name: "Gemini", tier: "support", role: "support" },
        state: "sleeping",
        activity: "waiting for provider heartbeat",
        location: "sofa",
        actions: ["coffee", "sleep"],
        evidence_source: "roster",
        evidence_detail: "active-agent-pool",
      },
    ],
    rooms: { lounge: ["gemini"] },
    summary: {
      provider_bridge: {
        generated_at: "",
        cached: false,
        connected_count: 0,
        configured_count: 0,
        disconnected_count: 0,
        unavailable_count: 0,
      },
    },
    provider_bridge: {
      generated_at: "",
      cached: false,
      diagnostics: [],
    },
    errors: [],
  };

  for (const cacheFile of ["latest--theme-night.json", "thread-ring-leader-main--theme-night.json"]) {
    await mkdir(path.dirname(officeHttpCachePath(tempCacheDir, cacheFile)), { recursive: true });
    await writeFile(officeHttpCachePath(tempCacheDir, cacheFile), JSON.stringify(cachedSnapshot), "utf8");
  }

  let signalCalls = 0;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-realtime-overlay-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-realtime-overlay-token",
      autonomyMaintainSnapshot: async () => ({
        enabled: true,
        runtime_running: false,
      }),
      officeRealtimeSignals: async () => {
        signalCalls += 1;
        return {
          generated_at: "2026-04-20T23:15:00.000Z",
          diagnostics: [
            {
              client_id: "gemini-cli",
              display_name: "Gemini CLI",
              status: "disconnected",
              detail: "auth expired",
            },
          ],
        };
      },
    }
  );

  try {
    const live = await fetchHttpJsonResponse(port, "/office/api/realtime");
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers["x-office-realtime-source"], "live");
    assert.equal(signalCalls, 1);
    assert.equal(live.body.ok, true);
    assert.equal(live.body.source, "live");
    assert.equal(live.body.base_snapshot.fetched_at, fetchedAt);
    assert.equal(live.body.base_snapshot.fetched_at_iso, cachedSnapshot.fetched_at_iso);
    assert.equal(live.body.agents[0].state, "blocked");
    assert.equal(live.body.agents[0].evidence_source, "provider_bridge");
    assert.equal(live.body.summary.provider_bridge.disconnected_count, 1);
    assert.equal(live.body.summary.maintain.enabled, true);
    assert.equal(live.body.summary.maintain.running, false);
    assert.equal(live.body.provider_bridge.generated_at, "2026-04-20T23:15:00.000Z");
    assert.equal(live.body.provider_bridge.cached, true);
    assert.equal(live.body.provider_bridge.diagnostics[0].client_id, "gemini-cli");

    const cached = await fetchHttpJsonResponse(port, "/office/api/realtime");
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.headers["x-office-realtime-source"], "live-cache");
    assert.equal(signalCalls, 1);
    assert.equal(cached.body.source, "live-cache");
    assert.equal(cached.body.agents[0].state, "blocked");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    if (previousLiveInterval === undefined) {
      delete process.env.TRICHAT_OFFICE_LIVE_STATUS_INTERVAL_MS;
    } else {
      process.env.TRICHAT_OFFICE_LIVE_STATUS_INTERVAL_MS = previousLiveInterval;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
});

test("/office/api/realtime does not drift Claude to offline when bridge diagnostics are stale", { concurrency: false }, async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-realtime-claude-stale-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;

  const cachedSnapshot = {
    thread_id: "ring-leader-main",
    theme: "night",
    fetched_at: Date.now() / 1000 - 15,
    fetched_at_iso: new Date(Date.now() - 15_000).toISOString(),
    agents: [
      {
        agent: { agent_id: "claude", display_name: "Claude", tier: "support", role: "critic" },
        state: "offline",
        activity: "not in the current working set",
        location: "ops",
        actions: ["ops", "offline"],
        evidence_source: "roster",
        evidence_detail: "inactive",
      },
    ],
    rooms: { ops: ["claude"] },
    summary: {},
    provider_bridge: {
      generated_at: "",
      cached: true,
      diagnostics: [],
    },
    errors: [],
  };

  for (const cacheFile of ["latest--theme-night.json", "thread-ring-leader-main--theme-night.json"]) {
    await mkdir(path.dirname(officeHttpCachePath(tempCacheDir, cacheFile)), { recursive: true });
    await writeFile(officeHttpCachePath(tempCacheDir, cacheFile), JSON.stringify(cachedSnapshot), "utf8");
  }

  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-realtime-claude-stale-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-realtime-claude-stale-token",
      officeRealtimeSignals: async () => ({
        generated_at: new Date(Date.now() - 600_000).toISOString(),
        stale: true,
        diagnostics: [
          {
            client_id: "claude-cli",
            display_name: "Claude CLI",
            status: "disconnected",
            detail: "stale disconnected bridge state",
          },
        ],
      }),
    }
  );

  try {
    const response = await fetchHttpJsonResponse(port, "/office/api/realtime");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-office-realtime-source"], "live");
    assert.equal(response.body.agents[0].agent.agent_id, "claude");
    assert.equal(response.body.agents[0].state, "sleeping");
    assert.equal(response.body.agents[0].evidence_source, "provider_bridge");
    assert.match(String(response.body.agents[0].activity || ""), /stale/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
});

test("/ready coalesces concurrent live health snapshot polls into a single in-flight read", { concurrency: false }, async () => {
  const previousTimeout = process.env.MCP_HTTP_READY_TIMEOUT_MS;
  process.env.MCP_HTTP_READY_TIMEOUT_MS = "500";

  let callCount = 0;
  let releaseSnapshot;
  const gate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });

  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-ready-coalesce-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "ready-coalesce-token",
      healthSnapshot: async () => {
        callCount += 1;
        await gate;
        return {
          ready: true,
          state: "ready",
          attention: [],
        };
      },
    }
  );

  try {
    const pending = [
      fetchReady(port, "ready-coalesce-token"),
      fetchReady(port, "ready-coalesce-token"),
      fetchReady(port, "ready-coalesce-token"),
    ];
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(callCount, 1);
    releaseSnapshot();
    const results = await Promise.all(pending);
    for (const result of results) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers["x-ready-source"], "live");
      assert.equal(result.body.ready, true);
    }
    assert.equal(callCount, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousTimeout === undefined) {
      delete process.env.MCP_HTTP_READY_TIMEOUT_MS;
    } else {
      process.env.MCP_HTTP_READY_TIMEOUT_MS = previousTimeout;
    }
  }
});

test(
  "/office/api/snapshot serves cached data immediately during explicit live refreshes and recovers after the background refresh completes",
  { concurrency: false },
  async () => {
  const previousCacheDir = process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
  const previousRefreshSeconds = process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
  const previousNodeTimeout = process.env.TRICHAT_OFFICE_SNAPSHOT_NODE_TIMEOUT_MS;
  const tempCacheDir = await mkdtemp(path.join(os.tmpdir(), "mcp-office-node-timeout-"));
  process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = tempCacheDir;
  process.env.TRICHAT_OFFICE_REFRESH_SECONDS = "2";
  process.env.TRICHAT_OFFICE_SNAPSHOT_NODE_TIMEOUT_MS = "75";

  let snapshotCalls = 0;
  let stallSnapshot = false;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-timeout-fallback-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-timeout-fallback-token",
      officeSnapshot: async ({ threadId, theme, forceLive }) => {
        snapshotCalls += 1;
        if (stallSnapshot) {
          await new Promise(() => {});
        }
        return {
          thread_id: threadId,
          theme,
          fetched_at: Date.now() / 1000,
          agents: [{ agent: { agent_id: forceLive ? "force-live" : "cached" } }],
          summary: {},
          rooms: {},
          errors: [],
        };
      },
    }
  );

  try {
    const seeded = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(seeded.statusCode, 200);
    assert.equal(seeded.headers["x-office-snapshot-source"], "direct-node");
    assert.equal(snapshotCalls, 1);

    stallSnapshot = true;
    const cachedFallback = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(cachedFallback.statusCode, 200);
    assert.equal(cachedFallback.headers["x-office-snapshot-source"], "cache-refreshing-live");
    assert.equal(cachedFallback.headers["x-office-refresh-state"], "pending");
    assert.equal(snapshotCalls, 2);

    stallSnapshot = false;
    const recovered = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.headers["x-office-snapshot-source"], "cache-refreshing-live");
    assert.equal(recovered.headers["x-office-refresh-state"], "pending");
    assert.equal(snapshotCalls, 2);

    await new Promise((resolve) => setTimeout(resolve, 125));
    const retried = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.headers["x-office-snapshot-source"], "cache-refreshing-live");
    assert.equal(retried.headers["x-office-refresh-state"], "pending");
    assert.equal(snapshotCalls, 3);

    await waitFor(() => snapshotCalls === 3);

    const refreshed = await fetchHttpJsonResponse(port, "/office/api/snapshot");
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.headers["x-office-snapshot-source"], "cache");
    assert.equal(snapshotCalls, 3);
    assert.equal(refreshed.body.agents[0].agent.agent_id, "force-live");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousCacheDir === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR = previousCacheDir;
    }
    if (previousRefreshSeconds === undefined) {
      delete process.env.TRICHAT_OFFICE_REFRESH_SECONDS;
    } else {
      process.env.TRICHAT_OFFICE_REFRESH_SECONDS = previousRefreshSeconds;
    }
    if (previousNodeTimeout === undefined) {
      delete process.env.TRICHAT_OFFICE_SNAPSHOT_NODE_TIMEOUT_MS;
    } else {
      process.env.TRICHAT_OFFICE_SNAPSHOT_NODE_TIMEOUT_MS = previousNodeTimeout;
    }
    await rm(tempCacheDir, { recursive: true, force: true });
  }
  }
);

test("/office/api/snapshot raw mode times out stalled raw snapshots and falls back to cached raw payloads", { concurrency: false }, async () => {
  const previousRawTimeout = process.env.TRICHAT_OFFICE_RAW_SNAPSHOT_NODE_TIMEOUT_MS;
  process.env.TRICHAT_OFFICE_RAW_SNAPSHOT_NODE_TIMEOUT_MS = "75";

  let rawCalls = 0;
  let stallRaw = false;
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-office-raw-timeout-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-raw-timeout-token",
      officeRawSnapshot: async ({ threadId, theme }) => {
        rawCalls += 1;
        if (stallRaw) {
          await new Promise(() => {});
        }
        return {
          thread_id: threadId,
          theme,
          fetched_at: Date.now() / 1000,
          agents: [{ agent: { agent_id: "raw" } }],
          summary: {},
          rooms: {},
          errors: [],
        };
      },
    }
  );

  try {
    const seeded = await fetchHttpJsonResponse(port, "/office/api/snapshot?format=raw");
    assert.equal(seeded.statusCode, 200);
    assert.equal(seeded.headers["x-office-snapshot-source"], "direct-node-raw");
    assert.equal(rawCalls, 1);

    stallRaw = true;
    const fallback = await fetchHttpJsonResponse(port, "/office/api/snapshot?format=raw&live=force");
    assert.equal(fallback.statusCode, 200);
    assert.equal(fallback.headers["x-office-snapshot-source"], "cache-fallback-raw");
    assert.equal(rawCalls, 2);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousRawTimeout === undefined) {
      delete process.env.TRICHAT_OFFICE_RAW_SNAPSHOT_NODE_TIMEOUT_MS;
    } else {
      process.env.TRICHAT_OFFICE_RAW_SNAPSHOT_NODE_TIMEOUT_MS = previousRawTimeout;
    }
  }
});

test("/office/api/action retries failed tasks through task.retry", { concurrency: false }, async () => {
  const previousBearer = process.env.MCP_HTTP_BEARER_TOKEN;
  process.env.MCP_HTTP_BEARER_TOKEN = "office-action-retry-token";
  const retryCalls = [];
  const port = await reservePort();
  const server = await startHttpTransport(
    () => buildToolServer({
      "task.retry": async (args) => {
        retryCalls.push(args);
        return {
          ok: true,
          task_id: args.task_id,
          retried: true,
        };
      },
      "task.recover_expired": async () => ({ ok: true, recovered: 0 }),
    }),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-action-retry-token",
    }
  );

  try {
    const response = await fetchHttpJsonResponse(port, "/office/api/action", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1",
        Authorization: "Bearer office-action-retry-token",
        "Content-Type": "application/json",
      },
      body: {
        action: "retry_failed_tasks",
        task_ids: ["task-a", "task-b"],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.action, "retry_failed_tasks");
    assert.equal(response.body.retried_count, 2);
    assert.equal(retryCalls.length, 2);
    assert.equal(retryCalls[0].task_id, "task-a");
    assert.equal(retryCalls[1].task_id, "task-b");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousBearer === undefined) {
      delete process.env.MCP_HTTP_BEARER_TOKEN;
    } else {
      process.env.MCP_HTTP_BEARER_TOKEN = previousBearer;
    }
  }
});

test("/office/api/action recovers expired tasks through task.recover_expired", { concurrency: false }, async () => {
  const previousBearer = process.env.MCP_HTTP_BEARER_TOKEN;
  process.env.MCP_HTTP_BEARER_TOKEN = "office-action-recover-token";
  const recoverCalls = [];
  const port = await reservePort();
  const server = await startHttpTransport(
    () => buildToolServer({
      "task.retry": async () => ({ ok: true }),
      "task.recover_expired": async (args) => {
        recoverCalls.push(args);
        return {
          ok: true,
          recovered_count: 3,
        };
      },
    }),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: "office-action-recover-token",
    }
  );

  try {
    const response = await fetchHttpJsonResponse(port, "/office/api/action", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1",
        Authorization: "Bearer office-action-recover-token",
        "Content-Type": "application/json",
      },
      body: {
        action: "recover_expired_tasks",
        limit: 7,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.action, "recover_expired_tasks");
    assert.equal(response.body.result.ok, true);
    assert.equal(response.body.result.recovered_count, 3);
    assert.equal(recoverCalls.length, 1);
    assert.equal(recoverCalls[0].limit, 7);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (previousBearer === undefined) {
      delete process.env.MCP_HTTP_BEARER_TOKEN;
    } else {
      process.env.MCP_HTTP_BEARER_TOKEN = previousBearer;
    }
  }
});

function buildToolServer(toolHandlers) {
  const server = new Server(
    {
      name: "http-office-action-tool-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const tools = Object.keys(toolHandlers).map((name) => ({
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const handler = toolHandlers[name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }],
      };
    }
    const result = await handler(request.params.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });

  return server;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function fetchReady(port, bearerToken = "ready-cache-token") {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/ready",
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Origin: "http://127.0.0.1",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(2_000, () => {
      request.destroy(new Error("timed out waiting for /ready"));
    });
    request.on("error", reject);
    request.end();
  });
}

function fetchHttpJsonResponse(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body == null ? null : JSON.stringify(options.body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(2_000, () => {
      request.destroy(new Error(`timed out waiting for ${requestPath}`));
    });
    request.on("error", reject);
    request.end(body ?? undefined);
  });
}

async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}
