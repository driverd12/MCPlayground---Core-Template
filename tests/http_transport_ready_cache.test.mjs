import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHttpTransport } from "../dist/transports/http.js";

test("/ready falls back to the last successful cached snapshot when the live health snapshot stalls", async () => {
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

test("/ready returns a degraded stale-cache payload when only an older cached snapshot is available", async () => {
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

test("/office/api/snapshot honors explicit live refreshes but throttles repeated live polling", async () => {
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

function fetchHttpJsonResponse(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
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
    request.end();
  });
}
