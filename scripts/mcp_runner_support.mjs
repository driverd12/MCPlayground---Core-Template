#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export function repoRootFromMeta(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

export function loadRunnerEnv(repoRoot) {
  dotenv.config({ path: path.join(repoRoot, ".env") });
  const tokenFile = path.join(repoRoot, "data", "imprint", "http_bearer_token");
  if (!("MCP_HTTP_BEARER_TOKEN" in process.env) && fs.existsSync(tokenFile)) {
    process.env.MCP_HTTP_BEARER_TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
  }
  if (!process.env.TRICHAT_BUS_SOCKET_PATH) {
    process.env.TRICHAT_BUS_SOCKET_PATH = resolveRunnerBusSocketPath(repoRoot);
  }
}

export function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parseIntValue(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function callTool(repoRoot, { tool, args, transport }) {
  const url = process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/";
  const origin = process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1";
  const stdioCommand = process.env.TRICHAT_MCP_STDIO_COMMAND || process.execPath;
  const stdioArgs = process.env.TRICHAT_MCP_STDIO_ARGS || "dist/server.js";
  const timeoutMs = parseIntValue(process.env.MCP_TOOL_CALL_TIMEOUT_MS, transport === "http" ? 15000 : 60000, 1000, 300000);
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "mcp_tool_call.mjs"),
      "--tool",
      tool,
      "--args",
      JSON.stringify(args ?? {}),
      "--transport",
      transport,
      "--url",
      url,
      "--origin",
      origin,
      "--stdio-command",
      stdioCommand,
      "--stdio-args",
      stdioArgs,
      "--cwd",
      repoRoot,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MCP_TOOL_CALL_TIMEOUT_MS: String(timeoutMs),
      },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs + 2000,
    }
  );
  return JSON.parse(stdout);
}

export async function waitForHttpReady(
  repoRoot,
  { timeoutMs = 15000, intervalMs = 500, url = process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/" } = {}
) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const healthUrl = new URL("health", url).toString();
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: {
          Origin: process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1",
        },
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, intervalMs)));
  }
  return false;
}

export function resolveTransport(repoRoot) {
  const preferred = process.env.AUTONOMY_BOOTSTRAP_TRANSPORT || process.env.TRICHAT_RING_LEADER_TRANSPORT || "";
  if (preferred) {
    return preferred;
  }
  if (process.env.MCP_HTTP_BEARER_TOKEN) {
    try {
      callTool(repoRoot, {
        tool: "health.storage",
        args: {},
        transport: "http",
      });
      return "http";
    } catch {
      return "stdio";
    }
  }
  return "stdio";
}

export function resolveRunnerBusSocketPath(repoRoot) {
  if (process.env.TRICHAT_BUS_SOCKET_PATH?.trim()) {
    return path.resolve(process.env.TRICHAT_BUS_SOCKET_PATH);
  }
  const legacyPath = path.join(repoRoot, "data", "trichat.bus.sock");
  if (Buffer.byteLength(legacyPath) < 100) {
    return legacyPath;
  }
  const digest = crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const cacheBase =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "mcplayground")
      : path.join(os.homedir(), ".cache", "mcplayground");
  const candidates = [
    path.join(cacheBase, `trichat-${digest}.sock`),
    path.join("/tmp", `mcplayground-trichat-${digest}.sock`),
  ];
  return candidates.find((entry) => Buffer.byteLength(entry) < 100) ?? candidates[candidates.length - 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessStartTimeMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/\s+/g, " ");
    if (!output) {
      return null;
    }
    const startedAtMs = Date.parse(output);
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

function buildLockOwnerIdentity(pid = process.pid) {
  const startedAtMs = readProcessStartTimeMs(pid);
  return {
    pid,
    startedAtMs,
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
  };
}

function readLockOwnerMetadata(lockDir) {
  const metadataPath = path.join(lockDir, "owner.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const pid = Number.parseInt(String(parsed?.pid ?? ""), 10);
    const startedAtMs = Number.parseInt(String(parsed?.startedAtMs ?? ""), 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

function writeLockOwnerMetadata(lockDir, identity) {
  const metadataPath = path.join(lockDir, "owner.json");
  try {
    fs.writeFileSync(metadataPath, `${JSON.stringify(identity)}\n`, "utf8");
  } catch {}
}

function lockOwnerMatchesLiveProcess(owner, liveIdentity) {
  if (!owner || !liveIdentity) {
    return null;
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid !== liveIdentity.pid) {
    return false;
  }
  if (Number.isFinite(owner.startedAtMs) && Number.isFinite(liveIdentity.startedAtMs)) {
    return Math.abs(owner.startedAtMs - liveIdentity.startedAtMs) <= 1000;
  }
  if (typeof owner.startedAt === "string" && typeof liveIdentity.startedAt === "string") {
    return owner.startedAt === liveIdentity.startedAt;
  }
  return null;
}

function readLockTimestampMs(pidFile, lockDir) {
  for (const candidate of [pidFile, lockDir]) {
    try {
      return fs.statSync(candidate).mtimeMs;
    } catch {}
  }
  return null;
}

function liveProcessStartedAfterLockWrite(pidFile, lockDir, liveIdentity) {
  if (!liveIdentity || !Number.isFinite(liveIdentity.startedAtMs)) {
    return false;
  }
  const lockTimestampMs = readLockTimestampMs(pidFile, lockDir);
  return Number.isFinite(lockTimestampMs) && liveIdentity.startedAtMs > lockTimestampMs + 1000;
}

function commandExists(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [String(name)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readProcessCwd(pid) {
  if (!commandExists("lsof")) {
    return null;
  }
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pathLine = output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("n"));
    return pathLine ? pathLine.slice(1) : null;
  } catch {
    return null;
  }
}

function repoServerCommandMatch(command, repoRoot, cwd) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return false;
  }
  if (/scripts\/mcp_tool_call\.mjs(?:\s|$)/.test(normalized)) {
    return false;
  }
  const absoluteServerPath = path.join(repoRoot, "dist", "server.js");
  const absolutePattern = escapeRegExp(absoluteServerPath);
  const serverCommandPattern = new RegExp(
    `^(?:.+?\\bnode(?:\\.exe)?|node(?:\\.exe)?)(?:\\s+--[^\\s]+(?:=[^\\s]+)?)*\\s+(?:${absolutePattern}|(?:\\.\\/)?dist/server\\.js)(?:\\s|$)`
  );
  if (!serverCommandPattern.test(normalized)) {
    return false;
  }
  return normalized.includes(absoluteServerPath) || cwd === repoRoot;
}

export function listRepoServerProcesses(repoRoot) {
  let output = "";
  const absoluteServerPath = path.join(repoRoot, "dist", "server.js");
  try {
    output = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const matches = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3] || "";
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    const referencesAbsolute = command.includes(absoluteServerPath);
    const referencesRelative = /(^|\s)(?:\.\/)?dist\/server\.js(?:\s|$)/.test(command);
    if (!referencesAbsolute && !referencesRelative) {
      continue;
    }
    const cwd = referencesAbsolute ? null : readProcessCwd(pid);
    if (!repoServerCommandMatch(command, repoRoot, cwd)) {
      continue;
    }
    matches.push({ pid, ppid, command, cwd });
  }
  return matches;
}

export async function reapRepoServerProcesses(repoRoot, options = {}) {
  const exclude = new Set(
    Array.isArray(options.excludePids)
      ? options.excludePids.filter((entry) => Number.isInteger(entry) && entry > 0)
      : []
  );
  const signalWaitMs = parseIntValue(options.signalWaitMs, 1500, 100, 30_000);
  const orphanOnly = parseBoolean(options.orphanOnly, false);
  const found = listRepoServerProcesses(repoRoot).filter((entry) => {
    if (exclude.has(entry.pid)) {
      return false;
    }
    if (!orphanOnly) {
      return true;
    }
    return !Number.isInteger(entry.ppid) || entry.ppid <= 1 || !processAlive(entry.ppid);
  });
  const reaped = [];
  for (const entry of found) {
    if (!processAlive(entry.pid)) {
      continue;
    }
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {}
    const deadline = Date.now() + signalWaitMs;
    while (Date.now() < deadline && processAlive(entry.pid)) {
      await sleep(100);
    }
    if (processAlive(entry.pid)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {}
    }
    reaped.push(entry);
  }
  return reaped;
}

async function probeTcpPortState(host, port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(state);
    };
    socket.setTimeout(250, () => finish("free"));
    socket.on("connect", () => finish("active"));
    socket.on("error", (error) => {
      const code = error?.code ?? "";
      if (code === "ECONNREFUSED" || code === "ENOENT" || code === "EHOSTUNREACH") {
        finish("free");
        return;
      }
      finish("unknown");
    });
  });
}

async function probeUnixSocketState(socketPath) {
  if (!socketPath || !fs.existsSync(socketPath)) {
    return "absent";
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(state);
    };
    socket.setTimeout(250, () => finish("stale"));
    socket.on("connect", () => finish("active"));
    socket.on("error", (error) => {
      const code = error?.code ?? "";
      if (code === "ENOENT") {
        finish("absent");
        return;
      }
      if (code === "ECONNREFUSED" || code === "EINVAL") {
        finish("stale");
        return;
      }
      finish("unknown");
    });
  });
}

export async function waitForServerResourcesToClear({
  host = "127.0.0.1",
  port,
  busSocketPath,
  timeoutMs = 20000,
  intervalMs = 250,
}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    const [portState, busState] = await Promise.all([
      probeTcpPortState(host, port),
      probeUnixSocketState(busSocketPath),
    ]);
    if (busState === "stale") {
      try {
        fs.unlinkSync(busSocketPath);
      } catch {}
    }
    const busClear = busState === "absent" || busState === "stale";
    const portClear = portState === "free";
    if (portClear && busClear) {
      return { ok: true, portState, busState };
    }
    await sleep(Math.max(100, intervalMs));
  }
  const [portState, busState] = await Promise.all([
    probeTcpPortState(host, port),
    probeUnixSocketState(busSocketPath),
  ]);
  return { ok: false, portState, busState };
}

export async function acquireRunnerSingletonLock(repoRoot, name, timeoutMs = 20000) {
  const lockRoot = path.join(repoRoot, "data", "imprint", "locks");
  const lockDir = path.join(lockRoot, `${name}.lock`);
  const pidFile = path.join(lockDir, "pid");
  fs.mkdirSync(lockRoot, { recursive: true });
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
      // Persist process-incarnation metadata so stale locks can be reclaimed safely after PID reuse.
      writeLockOwnerMetadata(lockDir, buildLockOwnerIdentity(process.pid));
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
      };
      return { ok: true, lockDir, release };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let ownerPid = Number.NaN;
      try {
        ownerPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      } catch {}
      if (!processAlive(ownerPid)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        continue;
      }
      const ownerMetadata = readLockOwnerMetadata(lockDir);
      const liveIdentity = buildLockOwnerIdentity(ownerPid);
      const ownerMatchesLiveProcess = lockOwnerMatchesLiveProcess(ownerMetadata, liveIdentity);
      const staleLiveOwner =
        ownerMatchesLiveProcess === false ||
        (ownerMatchesLiveProcess !== true && liveProcessStartedAfterLockWrite(pidFile, lockDir, liveIdentity));
      if (staleLiveOwner) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        continue;
      }
      await sleep(250);
    }
  }
  return { ok: false, lockDir, release: () => {} };
}
