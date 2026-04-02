import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logEvent } from "../utils.js";

export type HttpOptions = {
  port: number;
  host: string;
  allowedOrigins: string[];
  bearerToken: string | null;
  healthSnapshot?: () => unknown | Promise<unknown>;
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
const officeSnapshotInflight = new Map<string, Promise<OfficeSnapshotCommandResult>>();
const officeActionInflight = new Map<string, Promise<void>>();
const officeActionStatus = new Map<string, OfficeActionRuntimeState>();
let lastReadySnapshotCache: ReadySnapshotCacheEntry | null = null;

function readySnapshotTimeoutMs() {
  const override = Number(process.env.MCP_HTTP_READY_TIMEOUT_MS || "");
  if (Number.isFinite(override) && override >= 50) {
    return Math.min(30_000, Math.max(50, Math.round(override)));
  }
  return 5_000;
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

  try {
    const snapshot = await Promise.race([
      Promise.resolve(options.healthSnapshot()),
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
}

function officeSnapshotCacheDir() {
  const override = String(process.env.TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR || "").trim();
  return override ? path.resolve(override) : path.join(repoRoot, "data", "imprint", "office_snapshot_cache");
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

function officeSnapshotStaleMaxAgeSeconds() {
  const override = Number(process.env.TRICHAT_OFFICE_SNAPSHOT_STALE_MAX_AGE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return Math.max(30, officeSnapshotCacheMaxAgeSeconds() * 12);
}

function readOfficeSnapshotCache(
  theme: string,
  requestedThreadId: string | null,
  options?: { allowStale?: boolean }
) {
  const candidates = requestedThreadId
    ? [officeSnapshotCachePath(requestedThreadId, theme)]
    : [officeSnapshotLatestCachePath(theme)];
  const nowSeconds = Date.now() / 1000;
  const freshMaxAgeSeconds = officeSnapshotCacheMaxAgeSeconds();
  const maxAgeSeconds = options?.allowStale ? officeSnapshotStaleMaxAgeSeconds() : freshMaxAgeSeconds;
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

export async function startHttpTransport(createServer: () => Server, options: HttpOptions) {
  if (options.host !== "127.0.0.1" && options.host !== "localhost") {
    throw new Error("HTTP transport must bind to 127.0.0.1 or localhost");
  }
  if (!options.bearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required for HTTP transport");
  }

  lastReadySnapshotCache = null;

  const sessions = new Map<string, SessionBinding>();

  const httpServer = http.createServer((req, res) => {
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options?.timeoutMs ?? 30000);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
    const responseFormat = String(requestUrl.searchParams.get("format") || "").trim().toLowerCase();
    const forceLive = ["1", "true", "yes"].includes(String(requestUrl.searchParams.get("live") || "").trim().toLowerCase());
    if (responseFormat === "raw" && options.officeRawSnapshot) {
      try {
        const rawPayload = await options.officeRawSnapshot({
          threadId: effectiveThreadId,
          theme,
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-office-snapshot-source", "direct-node-raw");
        res.end(JSON.stringify(rawPayload));
        return true;
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: "snapshot_failed",
          stderr: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }
    if (!forceLive) {
      const cachedSnapshot =
        readOfficeSnapshotCache(theme, requestedThreadId || null) ??
        readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true });
      if (cachedSnapshot) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-office-snapshot-source", cachedSnapshot.stale ? "cache-stale" : "cache");
        res.setHeader("x-office-snapshot-age-seconds", cachedSnapshot.ageSeconds.toFixed(3));
        res.setHeader("x-office-snapshot-stale", cachedSnapshot.stale ? "true" : "false");
        res.end(cachedSnapshot.body);
        return true;
      }
    }
    if (options.officeSnapshot) {
      try {
        const directPayload = await options.officeSnapshot({
          threadId: effectiveThreadId,
          theme,
          forceLive,
        });
        const directBody = JSON.stringify(directPayload);
        const directParsed = parseOfficeSnapshotPayload(directBody);
        const directAgents = Array.isArray(directParsed?.agents) ? directParsed.agents.length : 0;
        const directErrors = Array.isArray(directParsed?.errors) ? directParsed.errors.length : 0;
        if (directErrors > 0) {
          const cachedSnapshot = readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true });
          const cachedPayload = cachedSnapshot ? parseOfficeSnapshotPayload(cachedSnapshot.body) : null;
          const cachedAgents = Array.isArray(cachedPayload?.agents) ? cachedPayload.agents.length : 0;
          if (cachedSnapshot && cachedAgents > directAgents) {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader("x-office-snapshot-source", "cache-fallback");
            res.setHeader("x-office-snapshot-age-seconds", cachedSnapshot.ageSeconds.toFixed(3));
            res.setHeader("x-office-snapshot-stale", cachedSnapshot.stale ? "true" : "false");
            res.end(cachedSnapshot.body);
            return true;
          }
        } else {
          writeOfficeSnapshotCache(directPayload);
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-office-snapshot-source", "direct-node");
        res.end(directBody);
        return true;
      } catch (error) {
        const cachedSnapshot = readOfficeSnapshotCache(theme, requestedThreadId || null, { allowStale: true });
        if (cachedSnapshot) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("x-office-snapshot-source", "cache-fallback");
          res.setHeader("x-office-snapshot-age-seconds", cachedSnapshot.ageSeconds.toFixed(3));
          res.setHeader("x-office-snapshot-stale", cachedSnapshot.stale ? "true" : "false");
          res.end(cachedSnapshot.body);
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

    const inflightKey = officeSnapshotInflightKey(theme, requestedThreadId || null);
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
      const started = runOfficeActionInBackground(action, autonomyCtlScript, ["maintain"], {
        cwd: repoRoot,
        env: officeEnv(origin),
        timeoutMs: 60000,
      });
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
    } else {
      sendJson(res, 400, { ok: false, error: "unsupported_action" });
      return true;
    }
    sendJson(res, result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      action,
      stdout: result.stdout.trim(),
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
