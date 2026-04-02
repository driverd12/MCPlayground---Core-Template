import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHttpTransport } from "../dist/transports/http.js";

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
  "/office/api/snapshot times out stalled node snapshots, falls back to cache, and recovers on the next live request",
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
    assert.equal(cachedFallback.headers["x-office-snapshot-source"], "cache-fallback");
    assert.equal(snapshotCalls, 2);

    stallSnapshot = false;
    const recovered = await fetchHttpJsonResponse(port, "/office/api/snapshot?live=force");
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.headers["x-office-snapshot-source"], "direct-node");
    assert.equal(snapshotCalls, 3);
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
