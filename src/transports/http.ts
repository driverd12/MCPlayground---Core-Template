import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildOfficeGuiSnapshot } from "../office_gui_snapshot.js";
import { getAutonomyMaintainRuntimeStatus } from "../tools/autonomy_maintain.js";
import { logEvent } from "../utils.js";

export type HttpOptions = {
  port: number;
  host: string;
  allowedOrigins: string[];
  bearerToken: string | null;
  healthSnapshot?: () => unknown | Promise<unknown>;
  autonomyMaintainSnapshot?: () => { enabled: boolean; runtime_running: boolean } | Promise<{ enabled: boolean; runtime_running: boolean }>;
  officeSnapshot?: (input: { threadId: string; theme: string; forceLive?: boolean }) => unknown | Promise<unknown>;
  officeRawSnapshot?: (input: { threadId: string; theme: string }) => unknown | Promise<unknown>;
};

type SessionBinding = {
  server: Server;
  transport: StreamableHTTPServerTransport;
};

type OfficeSnapshotCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

type OfficeSnapshotPayload = {
  agents?: unknown[];
  errors?: unknown[];
};

type ReadySnapshotPayload = Record<string, unknown>;

type ReadySnapshotCacheEntry = {
  payload: ReadySnapshotPayload;
  capturedAt: number;
};

type OfficeActionRuntimeState = {
  action: string;
  startedAt: string;
  completedAt: string | null;
  running: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const officeStaticRoot = path.join(repoRoot, "web", "office");
const officeDashboardScript = path.join(repoRoot, "scripts", "agent_office_dashboard.py");
const autonomyIngressScript = path.join(repoRoot, "scripts", "autonomy_ide_ingress.sh");
const autonomyCtlScript = path.join(repoRoot, "scripts", "autonomy_ctl.sh");
const officeTmuxScript = path.join(repoRoot, "scripts", "agent_office_tmux.sh");
const officeTmuxOpenScript = path.join(repoRoot, "scripts", "agent_office_tmux_open.sh");
const mcpToolCallScript = path.join(repoRoot, "scripts", "mcp_tool_call.mjs");
const stdioServerEntry = path.join(repoRoot, "dist", "server.js");
const officeSnapshotInflight = new Map<string, Promise<OfficeSnapshotCommandResult>>();
const officeNodeSnapshotInflight = new Map<string, Promise<{ body: string; parsed: OfficeSnapshotPayload | null }>>();
const officeRawSnapshotInflight = new Map<string, Promise<string>>();
const officeActionInflight = new Map<string, Promise<void>>();
const officeActionStatus = new Map<string, OfficeActionRuntimeState>();
const officeRawSnapshotCache = new Map<string, { body: string; capturedAt: number }>();
let lastReadySnapshotCache: ReadySnapshotCacheEntry | null = null;
let readySnapshotInflight: Promise<{ payload: ReadySnapshotPayload; source: "live" | "cache-fallback" | "cache-stale" | "error" | "default" }> | null =
  null;
let officeSnapshotCachePurgeInflight: Promise<void> | null = null;

function resetOfficeSnapshotRuntimeState() {
  officeSnapshotInflight.clear();
  officeNodeSnapshotInflight.clear();
  officeRawSnapshotInflight.clear();
  officeRawSnapshotCache.clear();
}

function readySnapshotTimeoutMs() {
  const override = Number(process.env.MCP_HTTP_READY_TIMEOUT_MS || "");
  if (Number.isFinite(override) && override >= 50) {
    return Math.min(30_000, Math.max(50, Math.round(override)));
  }
  return 5_000;
}

function officeSnapshotNodeTimeoutMs() {
  const override = Number(process.env.TRICHAT_OFFICE_SNAPSHOT_NODE_TIMEOUT_MS || "");
  if (Number.isFinite(override) && override >= 50) {
    return Math.min(60_000, Math.max(50, Math.round(override)));
  }
  return 5_000;
}

function officeRawSnapshotNodeTimeoutMs() {
  const override = Number(process.env.TRICHAT_OFFICE_RAW_SNAPSHOT_NODE_TIMEOUT_MS || "");
  if (Number.isFinite(override) && override >= 50) {
    return Math.min(60_000, Math.max(50, Math.round(override)));
  }
  return 4_000;
}

function readySnapshotCacheMaxAgeMs() {
  const override = Number(process.env.MCP_HTTP_READY_CACHE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(1_000, Math.round(override * 1000));
  }
  return 60_000;
}

function readySnapshotStaleCacheMaxAgeMs() {
  const override = Number(process.env.MCP_HTTP_READY_STALE_CACHE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(1_000, Math.round(override * 1000));
  }
  return 300_000;
}

function normalizeReadySnapshotPayload(snapshot: unknown): ReadySnapshotPayload {
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    return { ok: true, ...(snapshot as Record<string, unknown>) };
  }
  return { ok: true, ready: true, attention: [], snapshot };
}

function mergeReadyAttention(payload: ReadySnapshotPayload, entries: string[]) {
  const existing = Array.isArray(payload.attention) ? payload.attention.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
  return [...new Set([...existing, ...entries.map((entry) => entry.trim()).filter(Boolean)])];
}

async function resolveReadySnapshot(options: HttpOptions) {
  if (typeof options.healthSnapshot !== "function") {
    const payload = normalizeReadySnapshotPayload({ ready: true, attention: [] });
    lastReadySnapshotCache = {
      payload,
      capturedAt: Date.now(),
    };
    return { payload, source: "default" as const };
  }
  if (readySnapshotInflight) {
    return readySnapshotInflight;
  }

  let pending: Promise<{ payload: ReadySnapshotPayload; source: "live" | "cache-fallback" | "cache-stale" | "error" }>;
  pending = (async () => {
    try {
      const snapshot = await Promise.race([
        Promise.resolve(options.healthSnapshot!()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("health snapshot timed out")), readySnapshotTimeoutMs())
        ),
      ]);
      const payload = normalizeReadySnapshotPayload(snapshot);
      lastReadySnapshotCache = {
        payload,
        capturedAt: Date.now(),
      };
      return { payload, source: "live" as const };
    } catch (error) {
      if (lastReadySnapshotCache) {
        const ageMs = Date.now() - lastReadySnapshotCache.capturedAt;
        if (ageMs <= readySnapshotCacheMaxAgeMs()) {
          const payload: ReadySnapshotPayload = {
            ...lastReadySnapshotCache.payload,
            ready_source: "cache-fallback",
            ready_cache_age_seconds: Number((ageMs / 1000).toFixed(3)),
            attention: mergeReadyAttention(lastReadySnapshotCache.payload, ["ready.cache_fallback"]),
          };
          return { payload, source: "cache-fallback" as const };
        }
        if (ageMs <= readySnapshotStaleCacheMaxAgeMs()) {
          const payload: ReadySnapshotPayload = {
            ...lastReadySnapshotCache.payload,
            ready: false,
            state: "degraded",
            ready_source: "cache-stale",
            ready_cache_age_seconds: Number((ageMs / 1000).toFixed(3)),
            attention: mergeReadyAttention(lastReadySnapshotCache.payload, ["ready.cache_stale"]),
          };
          return { payload, source: "cache-stale" as const };
        }
      }
      const payload: ReadySnapshotPayload = {
        ok: true,
        ready: false,
        state: "degraded",
        ready_source: "unavailable",
        attention: ["ready.snapshot_unavailable"],
        error: error instanceof Error ? error.message : String(error),
      };
      return { payload, source: "error" as const };
    }
  })().finally(() => {
    if (readySnapshotInflight === pending) {
      readySnapshotInflight = null;
    }
  });
  readySnapshotInflight = pending;
  return pending;
}

async function withTimeout<T>(value: Promise<T> | T, timeoutMs: number, label: string) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function officeSnapshotCacheDir() {
  const override = String(process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR || "").trim();
  const baseDir = override ? path.resolve(override) : path.join(repoRoot, "data", "imprint", "office_snapshot_cache");
  return path.join(baseDir, "web");
}

function officeSnapshotCacheToken(value: string, fallback: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return normalized || fallback;
}

function officeSnapshotCachePath(threadId: string, theme: string) {
  return path.join(
    officeSnapshotCacheDir(),
    `thread-${officeSnapshotCacheToken(threadId, "ring-leader-main")}--theme-${officeSnapshotCacheToken(theme, "night")}.json`
  );
}

function officeSnapshotLatestCachePath(theme: string) {
  return path.join(
    officeSnapshotCacheDir(),
    `latest--theme-${officeSnapshotCacheToken(theme, "night")}.json`
  );
}

function officeSnapshotInflightKey(theme: string, requestedThreadId: string | null) {
  return `${officeSnapshotCacheToken(theme, "night")}::${officeSnapshotCacheToken(requestedThreadId || "", "latest")}`;
}

function officeSnapshotCacheMaxAgeSeconds() {
  const override = Number(process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  const refreshSeconds = Number(process.env.TRICHAT_OFFICE_REFRESH_SECONDS || "2");
  const base = Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? refreshSeconds : 2;
  return Math.max(3, Math.min(30, base * 2.5));
}

function officeSnapshotLiveThrottleSeconds() {
  const override = Number(process.env.TRICHAT_OFFICE_SNAPSHOT_LIVE_THROTTLE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.min(30, override));
  }
  const refreshSeconds = Number(process.env.TRICHAT_OFFICE_REFRESH_SECONDS || "2");
  const base = Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? refreshSeconds : 2;
  return Math.max(1, Math.min(10, base * 1.5));
}

function officeSnapshotStaleMaxAgeSeconds() {
  const override = Number(process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return Math.max(900, officeSnapshotCacheMaxAgeSeconds() * 60);
}

function officeRawSnapshotCacheMaxAgeMs() {
  const override = Number(process.env.TRICHAT_OFFICE_RAW_SNAPSHOT_CACHE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(250, Math.round(override * 1000));
  }
  const refreshSeconds = Number(process.env.TRICHAT_OFFICE_REFRESH_SECONDS || "2");
  const baseSeconds = Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? refreshSeconds : 2;
  return Math.max(1_000, Math.min(10_000, Math.round(baseSeconds * 1_500)));
}

function readOfficeRawSnapshotCache(inflightKey: string) {
  const entry = officeRawSnapshotCache.get(inflightKey);
  if (!entry) {
    return null;
  }
  const ageMs = Date.now() - entry.capturedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > officeRawSnapshotCacheMaxAgeMs()) {
    officeRawSnapshotCache.delete(inflightKey);
    return null;
  }
  return {
    body: entry.body,
    ageSeconds: ageMs / 1000,
  };
}

function readOfficeSnapshotCache(
  theme: string,
  requestedThreadId: string | null,
  options?: { allowStale?: boolean; allowExpired?: boolean }
) {
  const candidates = requestedThreadId
    ? [officeSnapshotCachePath(requestedThreadId, theme)]
    : [officeSnapshotLatestCachePath(theme)];
  const nowSeconds = Date.now() / 1000;
  const freshMaxAgeSeconds = officeSnapshotCacheMaxAgeSeconds();
  const staleMaxAgeSeconds = officeSnapshotStaleMaxAgeSeconds();
  const maxAgeSeconds = options?.allowExpired
    ? Number.POSITIVE_INFINITY
    : options?.allowStale
      ? staleMaxAgeSeconds
      : freshMaxAgeSeconds;
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const payload = parsed as Record<string, unknown>;
      const payloadThreadId = String(payload.thread_id || "").trim();
      const payloadTheme = officeSnapshotCacheToken(String(payload.theme || ""), "night");
      const fetchedAt = typeof payload.fetched_at === "number" ? payload.fetched_at : Number(payload.fetched_at || 0);
      if (!payloadThreadId) {
        continue;
      }
      if (requestedThreadId && payloadThreadId !== requestedThreadId) {
        continue;
      }
      if (payloadTheme !== officeSnapshotCacheToken(theme, "night")) {
        continue;
      }
      if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
        continue;
      }
      const ageSeconds = Math.max(0, nowSeconds - fetchedAt);
      if (ageSeconds > maxAgeSeconds) {
        continue;
      }
      return {
        body: JSON.stringify(payload),
        ageSeconds,
        threadId: payloadThreadId,
        stale: ageSeconds > freshMaxAgeSeconds,
        expired: ageSeconds > staleMaxAgeSeconds,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function parseOfficeSnapshotPayload(raw: string): OfficeSnapshotPayload | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as OfficeSnapshotPayload;
  } catch {
    return null;
  }
}

function parseJsonCandidate(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function parseJsonText(raw: string) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }

  const direct = parseJsonCandidate(text);
  if (direct.ok) {
    if (typeof direct.value === "string") {
      const nested = parseJsonCandidate(direct.value.trim());
      if (nested.ok) {
        return nested.value;
      }
    }
    return direct.value;
  }

  const lines = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n");
    const parsed = parseJsonCandidate(candidate);
    if (parsed.ok) {
      if (typeof parsed.value === "string") {
        const nested = parseJsonCandidate(parsed.value.trim());
        if (nested.ok) {
          return nested.value;
        }
      }
      return parsed.value;
    }
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = parseJsonCandidate(text.slice(objectStart, objectEnd + 1));
    if (parsed.ok) {
      return parsed.value;
    }
  }

  const listStart = text.indexOf("[");
  const listEnd = text.lastIndexOf("]");
  if (listStart >= 0 && listEnd > listStart) {
    const parsed = parseJsonCandidate(text.slice(listStart, listEnd + 1));
    if (parsed.ok) {
      return parsed.value;
    }
  }

  return null;
}

function buildOfficeMutation(action: string) {
  const token = `office-api-${action}-${Date.now()}-${randomUUID()}`;
  return {
    idempotency_key: token,
    side_effect_fingerprint: token,
  };
}

function writeOfficeSnapshotCache(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const record = payload as Record<string, unknown>;
  const threadId = String(record.thread_id ?? "").trim();
  const theme = officeSnapshotCacheToken(String(record.theme ?? "night"), "night");
  if (!threadId) {
    return;
  }
  const cacheDir = officeSnapshotCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const body = JSON.stringify(record);
  fs.writeFileSync(officeSnapshotCachePath(threadId, theme), body, "utf8");
  fs.writeFileSync(officeSnapshotLatestCachePath(theme), body, "utf8");
}

function invalidateOfficeSnapshotCaches() {
  lastReadySnapshotCache = null;
  readySnapshotInflight = null;
  resetOfficeSnapshotRuntimeState();
  scheduleOfficeSnapshotCachePurge();
}

function scheduleOfficeSnapshotCachePurge() {
  if (officeSnapshotCachePurgeInflight) {
    return;
  }
  officeSnapshotCachePurgeInflight = Promise.resolve()
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(async () => {
      const cacheDir = officeSnapshotCacheDir();
      try {
        const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
        await Promise.all(
          entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => fs.promises.rm(path.join(cacheDir, entry.name), { force: true }))
        );
      } catch {
        // Snapshot cache invalidation is best-effort only.
      }
    })
    .finally(() => {
      officeSnapshotCachePurgeInflight = null;
    });
}

function sendCachedOfficeSnapshot(
  res: http.ServerResponse,
  source: string,
  snapshot: { body: string; ageSeconds: number; stale: boolean },
  refreshState?: "pending"
) {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-office-snapshot-source", source);
  res.setHeader("x-office-snapshot-age-seconds", snapshot.ageSeconds.toFixed(3));
  res.setHeader("x-office-snapshot-stale", snapshot.stale ? "true" : "false");
  if (refreshState) {
    res.setHeader("x-office-refresh-state", refreshState);
  }
  res.end(snapshot.body);
}

function startOfficeNodeSnapshotRefresh(
  inflightKey: string,
  options: HttpOptions,
  input: { threadId: string; theme: string; forceLive: boolean }
) {
  let pendingDirectSnapshot = officeNodeSnapshotInflight.get(inflightKey);
  if (!pendingDirectSnapshot) {
    pendingDirectSnapshot = withTimeout(
      readOfficeSnapshotForRefresh(options, input),
      officeSnapshotNodeTimeoutMs(),
      "office snapshot"
    )
      .then((directPayload) => {
        const body = JSON.stringify(directPayload);
        const parsed = parseOfficeSnapshotPayload(body);
        if (parsed && (!Array.isArray(parsed.errors) || parsed.errors.length === 0)) {
          writeOfficeSnapshotCache(parsed);
        }
        return { body, parsed };
      })
      .finally(() => {
        officeNodeSnapshotInflight.delete(inflightKey);
      });
    officeNodeSnapshotInflight.set(inflightKey, pendingDirectSnapshot);
  }
  return pendingDirectSnapshot;
}

function officeSnapshotRefreshMode() {
  const override = String(process.env.MCP_HTTP_OFFICE_SNAPSHOT_REFRESH_MODE || "").trim().toLowerCase();
  if (override === "stdio" || override === "external" || override === "child") {
    return "stdio" as const;
  }
  return "inline" as const;
}

function officeSnapshotChildEnv() {
  return {
    ...process.env,
    MCP_HTTP: "0",
    MCP_BACKGROUND_OWNER: "0",
    MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
    MCP_AUTONOMY_MAINTAIN_ON_START: "0",
  };
}

async function readOfficeSnapshotForRefresh(
  options: HttpOptions,
  input: { threadId: string; theme: string; forceLive: boolean }
) {
  const readRawFallbackSnapshot = async () => {
    if (!options.officeRawSnapshot) {
      return null;
    }
    const rawFallback = await Promise.resolve(
      options.officeRawSnapshot({
        threadId: input.threadId,
        theme: input.theme,
      })
    );
    if (rawFallback && typeof rawFallback === "object" && !Array.isArray(rawFallback)) {
      return buildOfficeGuiSnapshot(rawFallback as Record<string, unknown>, { theme: input.theme });
    }
    return null;
  };

  if (officeSnapshotRefreshMode() === "stdio") {
    const rawPreferred = await readRawFallbackSnapshot();
    if (rawPreferred) {
      return rawPreferred;
    }
  }

  if (officeSnapshotRefreshMode() === "stdio" && fs.existsSync(stdioServerEntry)) {
    const rawArgs = {
      thread_id: input.threadId,
      turn_limit: 12,
      task_limit: 24,
      session_limit: 50,
      event_limit: 24,
      learning_limit: 120,
      runtime_worker_limit: 20,
      include_kernel: true,
      include_learning: true,
      include_bus: true,
      include_adapter: true,
      include_runtime_workers: true,
      metadata: input.forceLive ? { source: "http.live" } : undefined,
    };
    let result: OfficeSnapshotCommandResult;
    try {
      result = await runLocalCommand(
        process.execPath,
        [
          mcpToolCallScript,
          "--tool",
          "office.snapshot",
          "--args",
          JSON.stringify(rawArgs),
          "--transport",
          "stdio",
          "--stdio-command",
          process.execPath,
          "--stdio-args",
          "dist/server.js",
          "--cwd",
          repoRoot,
        ],
        {
          cwd: repoRoot,
          env: officeSnapshotChildEnv(),
          timeoutMs: officeSnapshotNodeTimeoutMs(),
        }
      );
    } catch (error) {
      const rawFallback = await readRawFallbackSnapshot();
      if (rawFallback) {
        return rawFallback;
      }
      throw error;
    }
    if (result.code !== 0) {
      const rawFallback = await readRawFallbackSnapshot();
      if (rawFallback) {
        return rawFallback;
      }
      throw new Error(result.stderr.trim() || `office snapshot child exited with code ${result.code}`);
    }
    const rawPayload = parseJsonText(result.stdout);
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      const rawFallback = await readRawFallbackSnapshot();
      if (rawFallback) {
        return rawFallback;
      }
    }
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      const preview = String(result.stdout || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      throw new Error(
        preview
          ? `office snapshot child returned a non-object payload: ${preview}`
          : "office snapshot child returned a non-object payload"
      );
    }
    return buildOfficeGuiSnapshot(rawPayload as Record<string, unknown>, { theme: input.theme });
  }
  return options.officeSnapshot!({
    threadId: input.threadId,
    theme: input.theme,
    forceLive: input.forceLive,
  });
}

export async function startHttpTransport(createServer: () => Server, options: HttpOptions) {
  if (options.host !== "127.0.0.1" && options.host !== "localhost") {
    throw new Error("HTTP transport must bind to 127.0.0.1 or localhost");
  }
  if (!options.bearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required for HTTP transport");
  }

  lastReadySnapshotCache = null;
  readySnapshotInflight = null;
  resetOfficeSnapshotRuntimeState();

  const sessions = new Map<string, SessionBinding>();

  const httpServer = http.createServer((req, res) => {
    // This local control-plane daemon is polled frequently by short-lived clients.
    // Forcing per-request socket closure avoids keep-alive stalls under mixed curl/browser/tool traffic.
    res.shouldKeepAlive = false;
    res.setHeader("connection", "close");
    const requestUrl = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
    const pathname = requestUrl.pathname;
    Promise.resolve(handleFastPathRequest(req, res, requestUrl, options))
      .then((handled) => {
        if (handled) {
          return true;
        }
        return maybeHandleOfficeRequest(req, res, requestUrl, options);
      })
      .then((handled) => {
        if (handled) {
          return;
        }

        if (!validateOrigin(req.headers.origin, options.allowedOrigins)) {
          sendApiError(res, pathname, 403, {
            error: "forbidden_origin",
            detail: "Origin is not allowed for this endpoint.",
          });
          return;
        }

        if (!validateBearer(req.headers.authorization, options.bearerToken)) {
          sendApiError(res, pathname, 403, {
            error: "forbidden_bearer",
            detail: "Bearer token is missing or invalid.",
          });
          return;
        }

        void routeRequest(createServer, sessions, req, res).catch((error) => {
          logEvent("http.error", {
            error: String(error),
            method: req.method ?? "unknown",
            url: req.url ?? "",
          });
          if (!res.headersSent) {
            sendApiError(res, pathname, 500, {
              error: "internal_server_error",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        });
      })
      .catch((error) => {
        logEvent("http.error", {
          error: String(error),
          method: req.method ?? "unknown",
          url: req.url ?? "",
        });
        if (!res.headersSent) {
          sendApiError(res, pathname, 500, {
            error: "internal_server_error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
  });
  httpServer.keepAliveTimeout = 0;

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, options.host, () => resolve());
  });

  logEvent("http.listen", { host: options.host, port: options.port });
  return httpServer;
}

async function handleFastPathRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
  options: HttpOptions
) {
  const pathname = requestUrl.pathname;
  const method = String(req.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    return false;
  }
  if (pathname === "/") {
    sendJson(res, 200, {
      ok: true,
      server: "mcplayground-core-template",
      transport: "http",
      office_path: "/office/",
      mcp_path: "/",
    });
    return true;
  }
  if (pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      status: "ok",
      server: "mcplayground-core-template",
      ts: new Date().toISOString(),
    });
    return true;
  }
  if (pathname === "/ready") {
    if (!validateOptionalOrigin(req.headers.origin, options.allowedOrigins)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return true;
    }
    if (!validateBearer(req.headers.authorization, options.bearerToken)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return true;
    }
    const { payload, source } = await resolveReadySnapshot(options);
    const ready = payload.ready === false ? false : true;
    res.setHeader("x-ready-source", source);
    sendJson(res, ready ? 200 : 503, payload);
    return true;
  }
  return false;
}

function validateOrigin(origin: string | undefined, allowed: string[]) {
  if (!origin) {
    return false;
  }
  let requested: URL;
  try {
    requested = new URL(origin);
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    if (entry === origin) {
      return true;
    }
    try {
      const candidate = new URL(entry);
      if (candidate.protocol !== requested.protocol || candidate.hostname !== requested.hostname) {
        return false;
      }
      if (!candidate.port) {
        return true;
      }
      return candidate.port === requested.port;
    } catch {
      return entry === origin;
    }
  });
}

function validateOptionalOrigin(origin: string | undefined, allowed: string[]) {
  if (!origin) {
    return true;
  }
  return validateOrigin(origin, allowed);
}

function validateBearer(authorization: string | undefined, expected: string | null) {
  if (!expected) {
    return false;
  }
  if (!authorization) {
    return false;
  }
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token === expected;
}

function normalizedOfficeOrigin(origin: string) {
  const configured = String(process.env.TRICHAT_MCP_ORIGIN || "").trim();
  if (configured) {
    return configured;
  }
  try {
    const parsed = new URL(origin);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "http://127.0.0.1";
  }
}

function officeEnv(origin: string) {
  return {
    ...process.env,
    TRICHAT_MCP_TRANSPORT: "http",
    TRICHAT_MCP_URL: `${origin}/`,
    TRICHAT_MCP_ORIGIN: normalizedOfficeOrigin(origin),
  };
}

function officeSnapshotEnv(origin: string) {
  return {
    ...process.env,
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
    MCP_BACKGROUND_OWNER: "0",
    MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
    MCP_AUTONOMY_MAINTAIN_ON_START: "0",
    TRICHAT_BUS_AUTOSTART: "0",
    TRICHAT_RING_LEADER_AUTOSTART: "0",
    TRICHAT_MCP_TRANSPORT: "http",
    TRICHAT_MCP_URL: `${origin}/`,
    TRICHAT_MCP_ORIGIN: normalizedOfficeOrigin(origin),
    AGENT_OFFICE_DISABLE_HTTP_SNAPSHOT: "1",
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendApiError(
  res: http.ServerResponse,
  pathname: string,
  statusCode: number,
  body: { ok?: boolean; error: string; detail?: string }
) {
  if (pathname.startsWith("/office/api/")) {
    sendJson(res, statusCode, {
      ok: false,
      error: body.error,
      detail: body.detail ?? body.error,
    });
    return;
  }
  res.statusCode = statusCode;
  res.end(body.detail ?? body.error);
}

function contentTypeFor(filePath: string) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function readJsonBody(req: http.IncomingMessage) {
  const body = await parseJsonBody(req);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function runLocalCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd ?? repoRoot,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1000);
    }, options?.timeoutMs ?? 30000);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        reject(new Error(`command timed out: ${command} ${args.join(" ")}`));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

function runOfficeActionInBackground(
  action: string,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) {
  const existing = officeActionInflight.get(action);
  if (existing) {
    const state = officeActionStatus.get(action) ?? {
      action,
      startedAt: new Date().toISOString(),
      completedAt: null,
      running: true,
      code: null,
      stdout: "",
      stderr: "",
    };
    officeActionStatus.set(action, state);
    return {
      accepted: true,
      alreadyRunning: true,
      state,
    };
  }

  const startedAt = new Date().toISOString();
  const state: OfficeActionRuntimeState = {
    action,
    startedAt,
    completedAt: null,
    running: true,
    code: null,
    stdout: "",
    stderr: "",
  };
  officeActionStatus.set(action, state);

  const task = Promise.resolve()
    .then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        })
    )
    .then(() => runLocalCommand(command, args, options))
    .then((result) => {
      const completedAt = new Date().toISOString();
      const nextState: OfficeActionRuntimeState = {
        action,
        startedAt,
        completedAt,
        running: false,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
      officeActionStatus.set(action, nextState);
      logEvent("office.action.complete", {
        action,
        code: result.code,
        started_at: startedAt,
        completed_at: completedAt,
        stderr: nextState.stderr || undefined,
      });
    })
    .catch((error) => {
      const completedAt = new Date().toISOString();
      const nextState: OfficeActionRuntimeState = {
        action,
        startedAt,
        completedAt,
        running: false,
        code: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
      officeActionStatus.set(action, nextState);
      logEvent("office.action.failed", {
        action,
        started_at: startedAt,
        completed_at: completedAt,
        error: nextState.stderr,
      });
    })
    .finally(() => {
      officeActionInflight.delete(action);
    });

  officeActionInflight.set(action, task);
  logEvent("office.action.start", {
    action,
    started_at: startedAt,
  });
  return {
    accepted: true,
    alreadyRunning: false,
    state,
  };
}

async function serveOfficeStatic(res: http.ServerResponse, requestPath: string) {
  const relativePath = requestPath === "/office/" ? "index.html" : requestPath.replace(/^\/office\//, "");
  const resolvedPath = path.resolve(officeStaticRoot, relativePath);
  if (!resolvedPath.startsWith(officeStaticRoot)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }
  res.statusCode = 200;
  res.setHeader("content-type", contentTypeFor(resolvedPath));
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.end(fs.readFileSync(resolvedPath));
  return true;
}

async function maybeHandleOfficeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
  options: HttpOptions
) {
  const pathname = requestUrl.pathname;
  const method = String(req.method ?? "GET").toUpperCase();
  if (pathname === "/" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      status: "ok",
      server: "mcplayground-http",
      office_path: "/office/",
      health_path: "/health",
    });
    return true;
  }
  if (pathname === "/health" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      status: "ok",
      server: "mcplayground-http",
    });
    return true;
  }
  if (pathname === "/office") {
    res.statusCode = 302;
    res.setHeader("location", "/office/");
    res.end();
    return true;
  }
  if (!pathname.startsWith("/office/")) {
    return false;
  }
  if (!validateOptionalOrigin(req.headers.origin, options.allowedOrigins)) {
    sendApiError(res, pathname, 403, {
      error: "forbidden_origin",
      detail: "Origin is not allowed for office routes.",
    });
    return true;
  }

  const origin = `${requestUrl.protocol}//${requestUrl.host}`;
  if (pathname === "/office/api/bootstrap" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      office_path: "/office/",
      default_thread_id: "ring-leader-main",
      default_theme: process.env.TRICHAT_OFFICE_THEME || "night",
      refresh_interval_seconds: Number(process.env.TRICHAT_OFFICE_REFRESH_SECONDS || "2"),
      tmux_session_name: process.env.TRICHAT_OFFICE_TMUX_SESSION_NAME || "agent-office",
    });
    return true;
  }

  if (pathname === "/office/api/snapshot" && method === "GET") {
    const theme = String(requestUrl.searchParams.get("theme") || process.env.TRICHAT_OFFICE_THEME || "night").trim() || "night";
    const requestedThreadId = String(requestUrl.searchParams.get("thread_id") || "").trim();
    const effectiveThreadId = requestedThreadId || "ring-leader-main";
    const inflightKey = officeSnapshotInflightKey(theme, requestedThreadId || null);
    const responseFormat = String(requestUrl.searchParams.get("format") || "").trim().toLowerCase();
    const liveMode = String(requestUrl.searchParams.get("live") || "").trim().toLowerCase();
    const forceLive = ["1", "true", "yes", "force"].includes(liveMode);
    const explicitForceLive = liveMode === "force" || ["1", "true", "yes"].includes(
      String(req.headers["x-office-force-live"] || "").trim().toLowerCase()
    );
    if (responseFormat === "raw" && options.officeRawSnapshot) {
      if (!forceLive) {
        const cachedRawSnapshot = readOfficeRawSnapshotCache(inflightKey);
        if (cachedRawSnapshot) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("x-office-snapshot-source", "cache-raw");
          res.setHeader("x-office-snapshot-age-seconds", cachedRawSnapshot.ageSeconds.toFixed(3));
          res.end(cachedRawSnapshot.body);
          return true;
        }
      }
      try {
        let pendingRawSnapshot = officeRawSnapshotInflight.get(inflightKey);
        if (!pendingRawSnapshot) {
          pendingRawSnapshot = withTimeout(
            Promise.resolve(
              options.officeRawSnapshot({
                threadId: effectiveThreadId,
                theme,
              })
            ),
            officeRawSnapshotNodeTimeoutMs(),
            "office raw snapshot"
          )
            .then((rawPayload) => {
              const body = JSON.stringify(rawPayload);
              officeRawSnapshotCache.set(inflightKey, {
                body,
                capturedAt: Date.now(),
              });
              return body;
            })
            .finally(() => {
              officeRawSnapshotInflight.delete(inflightKey);
            });
          officeRawSnapshotInflight.set(inflightKey, pendingRawSnapshot);
        }
        const rawBody = await pendingRawSnapshot;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-office-snapshot-source", "direct-node-raw");
        res.end(rawBody);
        return true;
      } catch (error) {
        const cachedRawSnapshot = readOfficeRawSnapshotCache(inflightKey);
        if (cachedRawSnapshot) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("x-office-snapshot-source", "cache-fallback-raw");
          res.setHeader("x-office-snapshot-age-seconds", cachedRawSnapshot.ageSeconds.toFixed(3));
          res.end(cachedRawSnapshot.body);
          return true;
        }
        sendJson(res, 500, {
          ok: false,
          error: "snapshot_failed",
          stderr: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }
    if (!forceLive) {
      const cachedSnapshot = readOfficeSnapshotCache(theme, requestedThreadId || null);
      if (cachedSnapshot) {
        sendCachedOfficeSnapshot(res, "cache", cachedSnapshot);
        return true;
      }
    }
    if (options.officeSnapshot) {
      const cachedSnapshot = readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true });
      const expiredCachedSnapshot = cachedSnapshot
        ? null
        : readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true, allowExpired: true });
      const freshestCachedSnapshot = cachedSnapshot ?? expiredCachedSnapshot;
      const freshCachedSnapshot = freshestCachedSnapshot && !freshestCachedSnapshot.stale ? freshestCachedSnapshot : null;
      if (forceLive && !explicitForceLive && freshCachedSnapshot && freshCachedSnapshot.ageSeconds <= officeSnapshotLiveThrottleSeconds()) {
        sendCachedOfficeSnapshot(res, "cache-throttled-live", freshCachedSnapshot);
        return true;
      }
      if (cachedSnapshot && (cachedSnapshot.stale || explicitForceLive)) {
        startOfficeNodeSnapshotRefresh(inflightKey, options, {
          threadId: effectiveThreadId,
          theme,
          forceLive,
        }).catch(() => {
          // Keep serving the last truthful cached snapshot; background refresh failures surface on the next direct attempt.
        });
        sendCachedOfficeSnapshot(
          res,
          explicitForceLive ? "cache-refreshing-live" : "cache-refreshing-stale",
          cachedSnapshot,
          "pending"
        );
        return true;
      }
      if (expiredCachedSnapshot) {
        startOfficeNodeSnapshotRefresh(inflightKey, options, {
          threadId: effectiveThreadId,
          theme,
          forceLive,
        }).catch(() => {
          // Keep serving the last truthful expired snapshot until a fresher refresh succeeds.
        });
        sendCachedOfficeSnapshot(res, "cache-expired-refreshing", expiredCachedSnapshot, "pending");
        return true;
      }
      try {
        const pendingDirectSnapshot = startOfficeNodeSnapshotRefresh(inflightKey, options, {
          threadId: effectiveThreadId,
          theme,
          forceLive,
        });
        const { body: directBody, parsed: directParsed } = await pendingDirectSnapshot;
        const directAgents = Array.isArray(directParsed?.agents) ? directParsed.agents.length : 0;
        const directErrors = Array.isArray(directParsed?.errors) ? directParsed.errors.length : 0;
        if (directErrors > 0) {
          const fallbackSnapshot =
            readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true }) ??
            readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true, allowExpired: true });
          const cachedPayload = fallbackSnapshot ? parseOfficeSnapshotPayload(fallbackSnapshot.body) : null;
          const cachedAgents = Array.isArray(cachedPayload?.agents) ? cachedPayload.agents.length : 0;
          if (fallbackSnapshot && cachedAgents > directAgents) {
            sendCachedOfficeSnapshot(
              res,
              fallbackSnapshot.expired ? "cache-expired-fallback" : "cache-fallback",
              fallbackSnapshot
            );
            return true;
          }
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-office-snapshot-source", "direct-node");
        res.end(directBody);
        return true;
      } catch (error) {
        const fallbackSnapshot =
          readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true }) ??
          readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true, allowExpired: true });
        if (fallbackSnapshot) {
          sendCachedOfficeSnapshot(
            res,
            fallbackSnapshot.expired ? "cache-expired-fallback" : "cache-fallback",
            fallbackSnapshot
          );
          return true;
        }
        sendJson(res, 500, {
          ok: false,
          error: "snapshot_failed",
          stderr: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }

    let pending = officeSnapshotInflight.get(inflightKey);
    if (!pending) {
      const args = [
        officeDashboardScript,
        "--repo-root",
        repoRoot,
        "--transport",
        "http",
        "--url",
        `${origin}/`,
        "--origin",
        normalizedOfficeOrigin(origin),
        "--theme",
        theme,
        "--mcp-retries",
        "0",
        "--mcp-timeout-seconds",
        "3.0",
        "--json-snapshot",
        "--thread-id",
        effectiveThreadId,
      ];
      pending = runLocalCommand("python3", args, {
        cwd: repoRoot,
        env: officeSnapshotEnv(origin),
        timeoutMs: 30000,
      }).finally(() => {
        officeSnapshotInflight.delete(inflightKey);
      });
      officeSnapshotInflight.set(inflightKey, pending);
    }
    const result = await pending;
    if (result.code !== 0) {
      sendJson(res, 500, {
        ok: false,
        error: "snapshot_failed",
        stderr: result.stderr.trim(),
      });
      return true;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("x-office-snapshot-source", "direct-python");
    res.end(result.stdout);
    return true;
  }

  if (pathname === "/office/api/action" && method === "POST") {
    const body = await readJsonBody(req);
    const action = String(body.action || "").trim();
    if (!action) {
      sendJson(res, 400, { ok: false, error: "missing_action" });
      return true;
    }
    let result: { stdout: string; stderr: string; code: number };
    if (action === "ensure") {
      const started = runOfficeActionInBackground(action, autonomyCtlScript, ["ensure"], {
        cwd: repoRoot,
        env: officeEnv(origin),
        timeoutMs: 60000,
      });
      invalidateOfficeSnapshotCaches();
      sendJson(res, 202, {
        ok: true,
        action,
        accepted: started.accepted,
        already_running: started.alreadyRunning,
        status: started.alreadyRunning ? "already_running" : "started",
        started_at: started.state.startedAt,
      });
      return true;
    } else if (action === "maintain") {
      const autonomyRuntime = getAutonomyMaintainRuntimeStatus();
      const maintainSnapshot = options.autonomyMaintainSnapshot
        ? await Promise.resolve(options.autonomyMaintainSnapshot())
        : null;
      const maintainAlreadyRunning =
        autonomyRuntime.running === true ||
        maintainSnapshot?.runtime_running === true ||
        maintainSnapshot?.enabled === true;
      if (maintainAlreadyRunning) {
        invalidateOfficeSnapshotCaches();
        sendJson(res, 202, {
          ok: true,
          action,
          accepted: true,
          already_running: true,
          status: "already_running",
          started_at: autonomyRuntime.started_at ?? new Date().toISOString(),
        });
        return true;
      }
      const started = runOfficeActionInBackground(action, autonomyCtlScript, ["maintain"], {
        cwd: repoRoot,
        env: officeEnv(origin),
        timeoutMs: 60000,
      });
      invalidateOfficeSnapshotCaches();
      sendJson(res, 202, {
        ok: true,
        action,
        accepted: started.accepted,
        already_running: started.alreadyRunning,
        status: started.alreadyRunning ? "already_running" : "started",
        started_at: started.state.startedAt,
      });
      return true;
    } else if (action === "tmux_detach") {
      result = await runLocalCommand(officeTmuxScript, ["--detach"], {
        cwd: repoRoot,
        env: officeEnv(origin),
        timeoutMs: 60000,
      });
    } else if (action === "tmux_open") {
      result = await runLocalCommand(officeTmuxOpenScript, [], {
        cwd: repoRoot,
        env: officeEnv(origin),
        timeoutMs: 60000,
      });
    } else if (action === "patient_zero_enable" || action === "patient_zero_disable") {
      const patientZeroAction = action === "patient_zero_enable" ? "enable" : "disable";
      const toolArgs = {
        action: patientZeroAction,
        mutation: buildOfficeMutation(`patient-zero-${patientZeroAction}`),
        operator_note: String(body.operator_note || "").trim() || undefined,
        source_client: "office.api",
        source_agent: "operator",
      };
      result = await runLocalCommand(
        process.execPath,
        [
          mcpToolCallScript,
          "--tool",
          "patient.zero",
          "--args",
          JSON.stringify(toolArgs),
          "--transport",
          "http",
          "--url",
          `${origin}/`,
          "--origin",
          normalizedOfficeOrigin(origin),
          "--cwd",
          repoRoot,
        ],
        {
          cwd: repoRoot,
          env: officeEnv(origin),
          timeoutMs: 30000,
        }
      );
    } else if (action === "retry_failed_tasks") {
      const taskIds = Array.isArray(body.task_ids)
        ? body.task_ids.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
        : [];
      if (taskIds.length === 0) {
        sendJson(res, 400, { ok: false, error: "missing_task_ids" });
        return true;
      }
      const results = [];
      for (const taskId of taskIds) {
        const toolArgs = {
          task_id: taskId,
          reason: String(body.reason || "Retried from office workbench").trim() || "Retried from office workbench",
          force: body.force === true,
          mutation: buildOfficeMutation(`task-retry-${taskId}`),
          source_client: "office.api",
          source_agent: "operator",
        };
        result = await runLocalCommand(
          process.execPath,
          [
            mcpToolCallScript,
            "--tool",
            "task.retry",
            "--args",
            JSON.stringify(toolArgs),
            "--transport",
            "http",
            "--url",
            `${origin}/`,
            "--origin",
            normalizedOfficeOrigin(origin),
            "--cwd",
            repoRoot,
          ],
          {
            cwd: repoRoot,
            env: officeEnv(origin),
            timeoutMs: 30000,
          }
        );
        const parsed = parseJsonText(result.stdout.trim());
        if (result.code !== 0) {
          sendJson(res, 500, {
            ok: false,
            action,
            task_id: taskId,
            result: parsed ?? null,
            stdout: parsed ? "" : result.stdout.trim(),
            stderr: result.stderr.trim(),
          });
          return true;
        }
        results.push({
          task_id: taskId,
          result: parsed ?? null,
        });
      }
      invalidateOfficeSnapshotCaches();
      sendJson(res, 200, {
        ok: true,
        action,
        retried_count: results.length,
        results,
      });
      return true;
    } else if (action === "recover_expired_tasks") {
      const toolArgs = {
        limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : 20,
        mutation: buildOfficeMutation("task-recover-expired"),
        source_client: "office.api",
        source_agent: "operator",
      };
      result = await runLocalCommand(
        process.execPath,
        [
          mcpToolCallScript,
          "--tool",
          "task.recover_expired",
          "--args",
          JSON.stringify(toolArgs),
          "--transport",
          "http",
          "--url",
          `${origin}/`,
          "--origin",
          normalizedOfficeOrigin(origin),
          "--cwd",
          repoRoot,
        ],
        {
          cwd: repoRoot,
          env: officeEnv(origin),
          timeoutMs: 30000,
        }
      );
    } else {
      sendJson(res, 400, { ok: false, error: "unsupported_action" });
      return true;
    }
    const parsed = parseJsonText(result.stdout.trim());
    if (result.code === 0) {
      invalidateOfficeSnapshotCaches();
    }
    sendJson(res, result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      action,
      result: parsed ?? null,
      stdout: parsed ? "" : result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
    return true;
  }

  if (pathname === "/office/api/intake" && method === "POST") {
    const body = await readJsonBody(req);
    const objective = String(body.objective || "").trim();
    if (!objective) {
      sendJson(res, 400, { ok: false, error: "missing_objective" });
      return true;
    }
    const args = [autonomyIngressScript];
    const pushOptional = (flag: string, value: unknown) => {
      const text = String(value ?? "").trim();
      if (text) {
        args.push(flag, text);
      }
    };
    pushOptional("--title", body.title);
    pushOptional("--thread", body.thread_id);
    pushOptional("--thread-title", body.thread_title);
    pushOptional("--risk", body.risk);
    pushOptional("--mode", body.mode);
    if (Array.isArray(body.tags)) {
      for (const tag of body.tags) pushOptional("--tag", tag);
    }
    if (Array.isArray(body.acceptance_criteria)) {
      for (const item of body.acceptance_criteria) pushOptional("--accept", item);
    }
    if (Array.isArray(body.constraints)) {
      for (const item of body.constraints) pushOptional("--constraint", item);
    }
    if (Array.isArray(body.assumptions)) {
      for (const item of body.assumptions) pushOptional("--assumption", item);
    }
    if (body.dry_run === true) {
      args.push("--dry-run");
    }
    args.push("--", objective);
    const result = await runLocalCommand(autonomyIngressScript, args.slice(1), {
      cwd: repoRoot,
      env: officeEnv(origin),
      timeoutMs: 120000,
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = { raw: result.stdout.trim() };
    }
    sendJson(res, result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      result: parsed,
      stderr: result.stderr.trim(),
    });
    return true;
  }

  if (pathname.startsWith("/office/api/")) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  if (method === "HEAD") {
    const relativePath = pathname === "/office/" ? "index.html" : pathname.replace(/^\/office\//, "");
    const resolvedPath = path.resolve(officeStaticRoot, relativePath);
    if (!resolvedPath.startsWith(officeStaticRoot) || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      res.statusCode = 404;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader("content-type", contentTypeFor(resolvedPath));
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.setHeader("pragma", "no-cache");
    res.setHeader("expires", "0");
    res.end();
    return true;
  }

  if (method !== "GET") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }
  return serveOfficeStatic(res, pathname);
}

async function routeRequest(
  createServer: () => Server,
  sessions: Map<string, SessionBinding>,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const method = String(req.method ?? "GET").toUpperCase();
  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

  if (method === "POST") {
    const body = await parseJsonBody(req);
    let transport: StreamableHTTPServerTransport | undefined;
    let server: Server | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.statusCode = 404;
        res.end("Unknown MCP session");
        return;
      }
      transport = session.transport;
      server = session.server;
    } else if (isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, {
            server: server!,
            transport: transport!,
          });
        },
      });
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
      };
      server = createServer();
      await server.connect(transport);
    } else {
      res.statusCode = 400;
      res.end("Missing MCP session id or initialize payload");
      return;
    }

    await transport.handleRequest(req, res, body);
    return;
  }

  if (method === "GET" || method === "DELETE") {
    if (!sessionId) {
      res.statusCode = 400;
      res.end("Missing MCP session id");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end("Unknown MCP session");
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 405;
  res.end("Method Not Allowed");
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
