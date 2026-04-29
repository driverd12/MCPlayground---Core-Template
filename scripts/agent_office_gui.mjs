#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { openSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoRootFromMeta, loadRunnerEnv } from "./mcp_runner_support.mjs";

const ACTION = String(process.argv[2] || "open").trim() || "open";
const REPO_ROOT = repoRootFromMeta(import.meta.url);
loadRunnerEnv(REPO_ROOT);

export function resolveOfficeGuiProbeBase(configuredUrl) {
  return new URL("/", new URL(configuredUrl)).toString();
}

const configuredUrl = String(process.env.TRICHAT_MCP_URL || process.env.ANAMNESIS_INBOX_MCP_URL || "").trim();
const TRICHAT_HTTP_URL = configuredUrl || `http://127.0.0.1:${process.env.MCP_HTTP_PORT || process.env.ANAMNESIS_MCP_HTTP_PORT || "8787"}/`;
const HTTP_ENDPOINT = new URL(TRICHAT_HTTP_URL);
const PROBE_BASE_URL = resolveOfficeGuiProbeBase(TRICHAT_HTTP_URL);
const MCP_PORT = Number.parseInt(
  String(HTTP_ENDPOINT.port || process.env.MCP_HTTP_PORT || process.env.ANAMNESIS_MCP_HTTP_PORT || "8787"),
  10
);
const MCP_HOST = HTTP_ENDPOINT.hostname || "127.0.0.1";
const TRICHAT_HTTP_ORIGIN = String(process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1");
const GUI_URL = new URL("office/", PROBE_BASE_URL).toString();
const LOG_DIR = path.join(REPO_ROOT, "data", "imprint", "logs");
const PID_DIR = path.join(REPO_ROOT, "data", "imprint", "run");
const PID_FILE = path.join(PID_DIR, "agent-office-http-runner.pid");
const RUNNER_SCRIPT = path.join(REPO_ROOT, "scripts", "mcp_http_runner.mjs");
const OPEN_BROWSER_SCRIPT = path.join(REPO_ROOT, "scripts", "open_browser.mjs");
const AGENTS_SWITCH_SCRIPT = path.join(REPO_ROOT, "scripts", "agents_switch.sh");
const MCP_LABEL = "com.master-mold.mcp.server";
const LAUNCHD_DOMAIN =
  process.platform === "darwin" && typeof process.getuid === "function" ? `gui/${process.getuid()}` : null;
const MCP_LAUNCH_AGENT_PLIST =
  process.platform === "darwin" && process.env.HOME
    ? path.join(process.env.HOME, "Library", "LaunchAgents", `${MCP_LABEL}.plist`)
    : null;
const WATCH_INTERVAL_MS = (() => {
  const configuredIntervalMs = Number.parseInt(process.env.AGENT_OFFICE_GUI_WATCH_INTERVAL_MS || "10000", 10);
  return Number.isFinite(configuredIntervalMs) && configuredIntervalMs > 0 ? configuredIntervalMs : 10000;
})();

export function describeHttpTokenFile(repoRoot = REPO_ROOT, env = process.env) {
  const tokenFile = path.join(repoRoot, "data", "imprint", "http_bearer_token");
  const envToken = String(env.MCP_HTTP_BEARER_TOKEN || "").trim();
  let fileToken = "";
  try {
    fileToken = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    fileToken = "";
  }
  const filePresent = fileToken.length > 0;
  return {
    path: tokenFile,
    present: filePresent,
    configured: envToken.length > 0,
    matches_env: filePresent && envToken.length > 0 ? fileToken === envToken : null,
  };
}

function isLocalHostTarget() {
  return ["127.0.0.1", "localhost", "::1"].includes(String(MCP_HOST).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
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

function readRunnerPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearRunnerPidIfStale() {
  const pid = readRunnerPid();
  if (pid && !pidAlive(pid)) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    return null;
  }
  return pid;
}

async function fetchOk(url, { headers = {}, timeoutMs = 5000 } = {}) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function originHeaders() {
  const origin = String(TRICHAT_HTTP_ORIGIN || "").trim();
  return origin ? { Origin: origin } : {};
}

async function healthOk() {
  const url = new URL("health", PROBE_BASE_URL);
  if (await fetchOk(url, { timeoutMs: 5000 })) {
    return true;
  }
  const headers = originHeaders();
  if (Object.keys(headers).length === 0) {
    return false;
  }
  return await fetchOk(url, {
    headers,
    timeoutMs: 5000,
  });
}

async function readyOk() {
  const token = String(process.env.MCP_HTTP_BEARER_TOKEN || "").trim();
  const url = new URL("ready", PROBE_BASE_URL);
  const primaryHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  if (await fetchOk(url, { headers: primaryHeaders, timeoutMs: 12000 })) {
    return true;
  }
  const fallbackHeaders = token
    ? { Authorization: `Bearer ${token}`, ...originHeaders() }
    : originHeaders();
  if (Object.keys(fallbackHeaders).length === Object.keys(primaryHeaders).length) {
    return false;
  }
  return await fetchOk(url, {
    headers: fallbackHeaders,
    timeoutMs: 12000,
  });
}

async function officePageOk() {
  if (
    await fetchOk(new URL("office/", PROBE_BASE_URL), {
      timeoutMs: 5000,
    })
  ) {
    return true;
  }
  const bootstrapUrl = new URL("office/api/bootstrap", PROBE_BASE_URL);
  if (await fetchOk(bootstrapUrl, { timeoutMs: 5000 })) {
    return true;
  }
  const headers = originHeaders();
  const bootstrapOk =
    Object.keys(headers).length > 0
      ? await fetchOk(bootstrapUrl, {
          headers,
          timeoutMs: 5000,
        })
      : false;
  if (bootstrapOk) {
    return true;
  }
  return false;
}

async function listenerOk() {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: MCP_HOST, port: MCP_PORT });
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

function launchdLoaded() {
  if (!LAUNCHD_DOMAIN) {
    return false;
  }
  const result = spawnSync("launchctl", ["print", `${LAUNCHD_DOMAIN}/${MCP_LABEL}`], {
    stdio: "ignore",
    timeout: 5000,
  });
  return result.status === 0;
}

function kickstartMcpViaDarwinLaunchd() {
  if (!isLocalHostTarget() || !LAUNCHD_DOMAIN || !MCP_LAUNCH_AGENT_PLIST || !fs.existsSync(MCP_LAUNCH_AGENT_PLIST)) {
    return false;
  }
  const launchctlOptions = {
    stdio: "ignore",
    timeout: 15000,
  };
  spawnSync("launchctl", ["bootstrap", LAUNCHD_DOMAIN, MCP_LAUNCH_AGENT_PLIST], launchctlOptions);
  spawnSync("launchctl", ["enable", `${LAUNCHD_DOMAIN}/${MCP_LABEL}`], launchctlOptions);
  const kickstart = spawnSync("launchctl", ["kickstart", `${LAUNCHD_DOMAIN}/${MCP_LABEL}`], launchctlOptions);
  return kickstart.status === 0 || launchdLoaded();
}

function startViaDarwinLaunchd() {
  if (ACTION === "watch") {
    return kickstartMcpViaDarwinLaunchd();
  }
  if (!isLocalHostTarget() || process.platform !== "darwin" || !fs.existsSync(AGENTS_SWITCH_SCRIPT)) {
    return false;
  }
  const result = spawnSync(AGENTS_SWITCH_SCRIPT, ["on"], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "ignore",
    timeout: 60000,
  });
  return result.status === 0;
}

function spawnDetachedRunner() {
  if (!isLocalHostTarget()) {
    return null;
  }
  const activePid = clearRunnerPidIfStale();
  if (activePid && pidAlive(activePid)) {
    return activePid;
  }
  if (!fs.existsSync(path.join(REPO_ROOT, "dist", "server.js"))) {
    throw new Error("dist/server.js is missing. Run 'npm run build' first.");
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PID_DIR, { recursive: true });
  const stdoutFd = openSync(path.join(LOG_DIR, "mcp-http.out.log"), "a");
  const stderrFd = openSync(path.join(LOG_DIR, "mcp-http.err.log"), "a");
  const child = spawn(process.execPath, [RUNNER_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCP_HTTP: "1",
      MCP_HTTP_PORT: String(MCP_PORT),
      TRICHAT_MCP_URL: TRICHAT_HTTP_URL,
      TRICHAT_MCP_ORIGIN: TRICHAT_HTTP_ORIGIN,
    },
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  if (child.pid) {
    fs.writeFileSync(PID_FILE, `${child.pid}\n`, "utf8");
  }
  return child.pid || null;
}

async function waitForLaunchable(timeoutMs = 30000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (await launchableOk()) {
      return true;
    }
    await sleep(1000);
  }
  return await launchableOk();
}

async function ensureHttp() {
  if (await launchableOk()) {
    return true;
  }
  if (await waitForLaunchable(3000)) {
    return true;
  }
  if (startViaDarwinLaunchd() && (await waitForLaunchable(20000))) {
    return true;
  }
  if (isLocalHostTarget()) {
    spawnDetachedRunner();
  }
  return await waitForLaunchable(30000);
}

async function collectOfficeStatus() {
  const tokenConfigured = Boolean(String(process.env.MCP_HTTP_BEARER_TOKEN || "").trim());
  const [listener, officeReady, health, readyProbe] = await Promise.all([
    listenerOk(),
    officePageOk(),
    healthOk(),
    tokenConfigured ? readyOk() : Promise.resolve(false),
  ]);
  const ready = tokenConfigured ? readyProbe : health;
  const effectiveHealth = health || readyProbe || officeReady;
  return {
    health: effectiveHealth,
    listener,
    ready,
    officeReady,
    launchable: ready || officeReady || (!tokenConfigured ? effectiveHealth : effectiveHealth && listener),
  };
}

async function launchableOk() {
  const status = await collectOfficeStatus();
  return status.launchable;
}

async function detectMode({ health, listener, ready, officeReady }) {
  const runnerPid = clearRunnerPidIfStale();
  if (officeReady) {
    if (runnerPid && pidAlive(runnerPid)) {
      return "runner";
    }
    if (launchdLoaded()) {
      return "launchd";
    }
    return "service";
  }
  if (ready) {
    if (officeReady) {
      return "service";
    }
    if (runnerPid && pidAlive(runnerPid)) {
      return "runner";
    }
    if (launchdLoaded()) {
      return "launchd";
    }
    return "service";
  }
  if (health) {
    return "warming";
  }
  if (listener) {
    return runnerPid && pidAlive(runnerPid) ? "runner" : "busy";
  }
  return "down";
}

async function printStatus() {
  const { health, listener, ready, officeReady, launchable } = await collectOfficeStatus();
  const mode = await detectMode({ health, listener, ready, officeReady });
  const tokenFile = describeHttpTokenFile(REPO_ROOT, process.env);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: launchable || listener,
        mode,
        health,
        listener,
        ready,
        office_ready: officeReady,
        launchable,
        url: GUI_URL,
        platform: process.platform,
        runner_pid: clearRunnerPidIfStale(),
        http_token_file: tokenFile,
      },
      null,
      2
    )}\n`
  );
}

async function openBrowser() {
  try {
    const completed = spawnSync(process.execPath, [OPEN_BROWSER_SCRIPT, GUI_URL], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      timeout: 15000,
    });
    return completed.status === 0;
  } catch {
    return false;
  }
}

async function runWatchMode() {
  process.stdout.write(
    `Agent Office GUI watcher started for ${TRICHAT_HTTP_URL}. health and office surface will be kept warm every ${WATCH_INTERVAL_MS}ms.\n`
  );
  while (true) {
    await ensureHttp();
    await officePageOk();
    await sleep(WATCH_INTERVAL_MS);
  }
}

async function main() {
  if (!["open", "start", "status", "watch"].includes(ACTION)) {
    process.stderr.write("usage: agent_office_gui.mjs [open|start|status|watch]\n");
    process.exit(2);
    return;
  }

  if (ACTION === "status") {
    await printStatus();
    return;
  }

  if (ACTION === "watch") {
    await runWatchMode();
    return;
  }

  if (!(await ensureHttp())) {
    const remoteNote = isLocalHostTarget()
      ? ""
      : ` TRICHAT_MCP_URL points to ${HTTP_ENDPOINT.origin}, so this launcher will not attempt to start a remote daemon.`;
    process.stderr.write(
      `Agent Office failed to reach ready state.${remoteNote} Run '${path.join(REPO_ROOT, "scripts", "agent_office_gui.sh")} status'.\n`
    );
    process.exit(1);
    return;
  }

  if (ACTION === "start") {
    process.stdout.write(`Agent Office ready at ${GUI_URL}\n`);
    return;
  }
  process.stdout.write(`Opening Agent Office at ${GUI_URL}\n`);
  await openBrowser();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
