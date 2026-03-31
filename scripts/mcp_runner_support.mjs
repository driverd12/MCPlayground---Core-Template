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
  if (!process.env.MCP_HTTP_BEARER_TOKEN && fs.existsSync(tokenFile)) {
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
      await sleep(250);
    }
  }
  return { ok: false, lockDir, release: () => {} };
}
