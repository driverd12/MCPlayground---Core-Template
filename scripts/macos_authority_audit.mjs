#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVILEGED_HELPER_PATH = path.join(REPO_ROOT, "scripts", "privileged_exec.py");
const DESKTOP_LISTEN_HELPER_PATH = path.join(REPO_ROOT, "scripts", "desktop_listen.swift");
const HTTP_BEARER_TOKEN_PATH = path.join(REPO_ROOT, "data", "imprint", "http_bearer_token");
const DEFAULT_SECRET_PATH = path.join(os.homedir(), ".codex", "secrets", "mcagent_admin_password");
const DEFAULT_ACCOUNT = "mcagent";

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
    ...options,
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function readFirstLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean) || null;
}

function readEnvFileValue(filePath, key) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) {
        continue;
      }
      const [rawKey, ...rest] = line.split("=");
      if (String(rawKey || "").trim() !== key) {
        continue;
      }
      return rest.join("=").trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean))];
}

function detectTerminalClient() {
  const termProgram = String(process.env.TERM_PROGRAM || "").trim();
  if (termProgram === "Apple_Terminal") {
    return "com.apple.Terminal";
  }
  if (termProgram === "iTerm.app") {
    return "com.googlecode.iterm2";
  }
  if (termProgram === "WarpTerminal") {
    return "dev.warp.Warp-Stable";
  }
  return null;
}

function detectExecutableClientCandidates() {
  return unique([
    process.execPath,
    readFirstLine(runCapture("which", ["node"]).stdout),
    readFirstLine(runCapture("which", ["python3"]).stdout),
  ]);
}

export function extractBundlePathFromCommand(command) {
  const match = String(command || "").match(/((?:\/[^"\s]+)+\.app)\/Contents\/MacOS\//);
  return match ? match[1] : null;
}

function resolveBundleId(bundlePath) {
  if (!bundlePath) {
    return null;
  }
  const result = runCapture("mdls", ["-raw", "-name", "kMDItemCFBundleIdentifier", bundlePath]);
  if (!result.ok) {
    return null;
  }
  const value = readFirstLine(result.stdout);
  if (!value || value === "(null)") {
    return null;
  }
  return value.replace(/^"|"$/g, "");
}

function collectAncestorBundleIds(startPid = process.ppid, maxDepth = 10) {
  const bundleIds = [];
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && Number.isFinite(pid) && pid > 1; depth += 1) {
    const ps = runCapture("ps", ["-o", "ppid=", "-o", "command=", "-p", String(pid)]);
    if (!ps.ok) {
      break;
    }
    const lines = ps.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (lines.length === 0) {
      break;
    }
    const line = lines[0];
    const parentMatch = line.match(/^(\d+)\s+(.*)$/);
    if (!parentMatch) {
      break;
    }
    const parentPid = Number.parseInt(parentMatch[1], 10);
    const command = parentMatch[2];
    const bundleId = resolveBundleId(extractBundlePathFromCommand(command));
    if (bundleId) {
      bundleIds.push(bundleId);
    }
    if (!Number.isFinite(parentPid) || parentPid <= 1 || parentPid === pid) {
      break;
    }
    pid = parentPid;
  }
  return unique(bundleIds);
}

export function classifyAppleEventsProbe(result) {
  if (!result) {
    return {
      status: "unknown",
      detail: "probe was not executed",
    };
  }
  if (result.ok) {
    return {
      status: "granted",
      detail: "System Events Apple Events probe succeeded.",
    };
  }
  const detail = [result.stderr, result.stdout, result.error].filter(Boolean).join(" ").toLowerCase();
  if (
    detail.includes("not authorized") ||
    detail.includes("assistive access") ||
    detail.includes("automation access") ||
    detail.includes("(-1719)") ||
    detail.includes("(-1743)")
  ) {
    return {
      status: "blocked",
      detail: readFirstLine(result.stderr || result.stdout || result.error) || "Apple Events / Accessibility permission is blocked.",
    };
  }
  return {
    status: "unknown",
    detail: readFirstLine(result.stderr || result.stdout || result.error) || "Apple Events probe failed for an unknown reason.",
  };
}

export function parseTccRows(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [service = "", client = "", authValue = "", authReason = ""] = line.split("\t");
      return {
        service: service.trim(),
        client: client.trim(),
        auth_value: Number.parseInt(authValue, 10),
        auth_reason: authReason.trim(),
      };
    })
    .filter((entry) => entry.service && entry.client);
}

export function summarizeTccService(rows, service, candidateClients) {
  const relevant = rows.filter((entry) => entry.service === service);
  const matched = relevant.filter((entry) => candidateClients.includes(entry.client));
  const allowed = matched.filter((entry) => Number.isFinite(entry.auth_value) && entry.auth_value >= 2);
  const denied = matched.filter((entry) => Number.isFinite(entry.auth_value) && entry.auth_value === 0);
  if (allowed.length > 0) {
    return {
      status: "granted",
      matched_clients: allowed.map((entry) => entry.client),
      detail: `Grant present for ${allowed.map((entry) => entry.client).join(", ")}.`,
    };
  }
  if (denied.length > 0) {
    return {
      status: "blocked",
      matched_clients: denied.map((entry) => entry.client),
      detail: `Explicit deny present for ${denied.map((entry) => entry.client).join(", ")}.`,
    };
  }
  if (matched.length > 0) {
    return {
      status: "unknown",
      matched_clients: matched.map((entry) => entry.client),
      detail: "Matching TCC rows exist but none are clearly granted.",
    };
  }
  return {
    status: "unknown",
    matched_clients: [],
    detail: "No matching TCC rows were found for the active shell/app clients.",
  };
}

function verifyListenHelperReady() {
  const swiftReady = runCapture("which", ["swift"]).ok;
  const helperPresent = fs.existsSync(DESKTOP_LISTEN_HELPER_PATH);
  if (swiftReady && helperPresent) {
    return {
      status: "ready",
      detail: "desktop.listen helper and swift runtime are available.",
    };
  }
  const issues = [];
  if (!swiftReady) {
    issues.push("swift runtime not found in PATH");
  }
  if (!helperPresent) {
    issues.push(`desktop listen helper missing at ${DESKTOP_LISTEN_HELPER_PATH}`);
  }
  return {
    status: "blocked",
    detail: issues.join("; "),
  };
}

function summarizeMicrophoneListenLane(params) {
  const listenHelper = verifyListenHelperReady();
  if (listenHelper.status !== "ready") {
    return {
      status: "blocked",
      detail: `${listenHelper.detail}; desktop.listen lane cannot run until this is fixed.`,
      matched_clients: [],
    };
  }
  if (params.tccQuery === null) {
    return {
      status: "unknown",
      detail: `TCC database not found at ${params.tccDbPath}; cannot verify Microphone consent.`,
      matched_clients: [],
    };
  }
  if (!params.tccQuery.ok) {
    return {
      status: "unknown",
      detail:
        readFirstLine(params.tccQuery.stderr || params.tccQuery.error) ||
        "TCC database is not readable; grant Full Disk Access to audit Microphone consent truthfully.",
      matched_clients: [],
    };
  }
  const baseline = summarizeTccService(params.tccRows, "kTCCServiceMicrophone", params.candidateClients);
  if (baseline.status === "granted") {
    return {
      ...baseline,
      detail: `${baseline.detail} Microphone consent is present for the active shell host.`,
    };
  }
  if (baseline.status === "blocked") {
    return {
      ...baseline,
      detail:
        `${baseline.detail} Grant Microphone access for the active shell/IDE host in System Settings ` +
        "→ Privacy & Security → Microphone.",
    };
  }
  return {
    ...baseline,
    detail:
      `${baseline.detail} Run desktop.listen once to trigger macOS consent, then grant Microphone access in ` +
      "System Settings if prompted.",
  };
}

export function desktopControlStatusTransportOrder(options = {}) {
  const env = options.env || process.env;
  const forced = String(env.MCP_MACOS_AUTHORITY_DESKTOP_STATUS_TRANSPORT || "").trim().toLowerCase();
  const bearerTokenPresent =
    typeof options.bearerTokenPresent === "boolean" ? options.bearerTokenPresent : fs.existsSync(HTTP_BEARER_TOKEN_PATH);
  if (forced === "stdio") {
    return ["stdio"];
  }
  if (forced === "http") {
    return bearerTokenPresent ? ["http", "stdio"] : ["stdio"];
  }
  return bearerTokenPresent ? ["http", "stdio"] : ["stdio"];
}

function readDesktopControlStatus() {
  const commonArgs = [
    path.join(REPO_ROOT, "scripts", "mcp_tool_call.mjs"),
    "--tool",
    "desktop.control",
    "--args",
    JSON.stringify({ action: "status", source_client: "macos_authority_audit.mjs" }),
    "--cwd",
    REPO_ROOT,
  ];
  const attempts = [];
  for (const transport of desktopControlStatusTransportOrder()) {
    if (transport === "http" && fs.existsSync(HTTP_BEARER_TOKEN_PATH)) {
      const token = String(fs.readFileSync(HTTP_BEARER_TOKEN_PATH, "utf8") || "").trim();
      if (!token) {
        continue;
      }
      attempts.push(
        runCapture(
          process.execPath,
          [
            ...commonArgs,
            "--transport",
            "http",
            "--url",
            process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/",
            "--origin",
            process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1",
          ],
          {
            env: {
              ...process.env,
              MCP_HTTP_BEARER_TOKEN: token,
              MCP_TOOL_CALL_TIMEOUT_MS: "5000",
            },
          }
        )
      );
      continue;
    }
    if (transport === "stdio") {
      attempts.push(
        runCapture(
          process.execPath,
          [
            ...commonArgs,
            "--transport",
            "stdio",
            "--stdio-command",
            process.env.TRICHAT_MCP_STDIO_COMMAND || "node",
            "--stdio-args",
            process.env.TRICHAT_MCP_STDIO_ARGS || "dist/server.js",
          ],
          {
            env: {
              ...process.env,
              MCP_TOOL_CALL_TIMEOUT_MS: "5000",
            },
          }
        )
      );
    }
  }
  for (const result of attempts) {
    if (!result.ok) {
      continue;
    }
    try {
      return JSON.parse(result.stdout || "{}");
    } catch {}
  }
  return null;
}

export function upgradeStatusWithDesktopProof(baseline, desktopStatus, lane) {
  if (!baseline || baseline.status === "granted" || baseline.status === "blocked" || !desktopStatus) {
    return baseline;
  }
  const state = desktopStatus.state && typeof desktopStatus.state === "object" ? desktopStatus.state : {};
  const summary = desktopStatus.summary && typeof desktopStatus.summary === "object" ? desktopStatus.summary : {};
  if (
    lane === "microphone" &&
    summary.listen_ready === true &&
    typeof state.last_listen_at === "string" &&
    !state.last_error
  ) {
    return {
      ...baseline,
      status: "granted",
      detail: `${baseline.detail} Live desktop.listen proof succeeded at ${state.last_listen_at}.`,
    };
  }
  if (
    lane === "screen" &&
    (summary.screen_recording_proven === true ||
      (summary.observe_ready === true && typeof state.last_screenshot_at === "string")) &&
    !state.last_error
  ) {
    return {
      ...baseline,
      status: "granted",
      detail: `${baseline.detail} Live desktop.observe screenshot proof succeeded at ${state.last_screenshot_at || "recent proof timestamp"}.`,
    };
  }
  return baseline;
}

function verifyRootHelper(secretPath, account) {
  if (!fs.existsSync(PRIVILEGED_HELPER_PATH)) {
    return {
      status: "blocked",
      detail: `missing helper at ${PRIVILEGED_HELPER_PATH}`,
    };
  }
  if (!fs.existsSync(secretPath)) {
    return {
      status: "blocked",
      detail: `missing secret at ${secretPath}`,
    };
  }
  const password = String(fs.readFileSync(secretPath, "utf8") || "").trim();
  if (!password) {
    return {
      status: "blocked",
      detail: `empty secret at ${secretPath}`,
    };
  }
  const payload = {
    account,
    target_user: "root",
    password,
    command: "/usr/bin/id",
    args: ["-un"],
    cwd: REPO_ROOT,
    timeout_seconds: 8,
    env: {},
  };
  const result = runCapture("python3", [PRIVILEGED_HELPER_PATH], {
    input: JSON.stringify(payload),
  });
  if (!result.ok) {
    return {
      status: "blocked",
      detail: readFirstLine(result.stderr || result.stdout || result.error) || "privileged helper verification failed",
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = null;
  }
  if (parsed?.ok === true && /\broot\b/.test(String(parsed.output || ""))) {
    return {
      status: "ready",
      detail: `verified ${account} -> root helper path`,
    };
  }
  return {
    status: "blocked",
    detail: readFirstLine(String(parsed?.output || result.stdout || "")) || "privileged helper verification returned a non-root result",
  };
}

export function summarizeAuthorityReadiness(checks) {
  const blockers = [];
  if (checks.console_session?.status !== "ready") {
    blockers.push("console_session");
  }
  if (checks.accessibility?.status !== "granted") {
    blockers.push("accessibility");
  }
  if (checks.screen_recording?.status !== "granted") {
    blockers.push("screen_recording");
  }
  if (checks.microphone_listen_lane?.status !== "granted") {
    blockers.push("microphone_listen_lane");
  }
  if (checks.root_helper?.status !== "ready") {
    blockers.push("root_helper");
  }
  if (checks.full_disk_access?.status === "blocked") {
    blockers.push("full_disk_access");
  }
  return {
    ready_for_patient_zero_full_authority: blockers.length === 0,
    blockers,
  };
}

export function auditMacosAuthority() {
  if (process.platform !== "darwin") {
    return {
      ok: true,
      skipped: true,
      reason: "not_macos",
      platform: process.platform,
    };
  }

  const currentUser = readFirstLine(runCapture("id", ["-un"]).stdout) || os.userInfo().username;
  const consoleUser = readFirstLine(runCapture("stat", ["-f", "%Su", "/dev/console"]).stdout);
  const consoleSessionReady = consoleUser && consoleUser !== "root";
  const account = DEFAULT_ACCOUNT;
  const accountExists = runCapture("id", [account]).ok;
  const secretPath = readEnvFileValue(path.join(REPO_ROOT, ".env"), "MCP_PRIVILEGED_SECRET_PATH") || DEFAULT_SECRET_PATH;
  const tccDbPath = path.join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db");
  const tccQuery = fs.existsSync(tccDbPath)
    ? runCapture("sqlite3", [
        "-readonly",
        "-separator",
        "\t",
        tccDbPath,
        "select service,client,auth_value,auth_reason from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServiceMicrophone');",
      ])
    : null;
  const tccRows = tccQuery?.ok ? parseTccRows(tccQuery.stdout) : [];
  const desktopControlStatus = readDesktopControlStatus();
  const candidateClients = unique([
    detectTerminalClient(),
    ...detectExecutableClientCandidates(),
    ...collectAncestorBundleIds(),
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
  ]);
  const accessibilityProbe = runCapture("osascript", [
    "-e",
    'tell application "System Events" to count (every process)',
  ]);
  const accessibilityStatus = classifyAppleEventsProbe(accessibilityProbe);
  const screenRecordingStatus = upgradeStatusWithDesktopProof(
    tccQuery === null
      ? {
          status: "unknown",
          detail: `TCC database not found at ${tccDbPath}`,
          matched_clients: [],
        }
      : !tccQuery.ok
        ? {
            status: "unknown",
            detail: readFirstLine(tccQuery.stderr || tccQuery.error) || "TCC database is not readable; grant Full Disk Access to audit Screen Recording truthfully.",
            matched_clients: [],
          }
        : summarizeTccService(tccRows, "kTCCServiceScreenCapture", candidateClients),
    desktopControlStatus,
    "screen"
  );
  const microphoneListenLaneStatus = upgradeStatusWithDesktopProof(summarizeMicrophoneListenLane({
    tccQuery,
    tccRows,
    tccDbPath,
    candidateClients,
  }), desktopControlStatus, "microphone");
  const fullDiskAccessStatus =
    tccQuery === null
      ? {
          status: "unknown",
          detail: `TCC database not found at ${tccDbPath}`,
        }
      : tccQuery.ok
        ? {
            status: "granted",
            detail: "TCC database is readable from the current shell host.",
          }
        : {
            status: "blocked",
            detail: readFirstLine(tccQuery.stderr || tccQuery.error) || "TCC database is not readable from the current shell host.",
          };
  const rootHelperStatus = !accountExists
    ? {
        status: "blocked",
        detail: `missing account ${account}`,
      }
    : verifyRootHelper(secretPath, account);
  const checks = {
    console_session: {
      status: consoleSessionReady ? "ready" : "blocked",
      detail: consoleSessionReady
        ? `console user ${consoleUser} is active`
        : "no active GUI console session detected",
      current_user: currentUser,
      console_user: consoleUser,
    },
    accessibility: accessibilityStatus,
    screen_recording: screenRecordingStatus,
    microphone_listen_lane: microphoneListenLaneStatus,
    full_disk_access: fullDiskAccessStatus,
    root_helper: rootHelperStatus,
  };
  const summary = summarizeAuthorityReadiness(checks);
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    current_user: currentUser,
    console_user: consoleUser,
    candidate_clients: candidateClients,
    account,
    account_exists: accountExists,
    secret_path: secretPath,
    checks,
    ...summary,
  };
}

function renderHuman(audit) {
  if (audit.skipped) {
    return `[macos-authority] skipped: ${audit.reason}`;
  }
  const lines = [];
  lines.push(`[macos-authority] host=${audit.hostname} user=${audit.current_user} console=${audit.console_user || "none"}`);
  lines.push(`[macos-authority] candidate_clients=${audit.candidate_clients.join(", ") || "none"}`);
  for (const [name, check] of Object.entries(audit.checks || {})) {
    lines.push(`[macos-authority] ${name}: ${check.status} — ${check.detail}`);
  }
  lines.push(
    `[macos-authority] full_authority_ready=${audit.ready_for_patient_zero_full_authority ? "yes" : "no"} blockers=${(audit.blockers || []).join(",") || "none"}`
  );
  return lines.join("\n");
}

function main() {
  const json = process.argv.includes("--json");
  const audit = auditMacosAuthority();
  if (json) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderHuman(audit)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
