#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveFederationHostIdentity } from "./federation_host_identity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = Number(process.env.MCP_HTTP_PORT || process.env.ANAMNESIS_MCP_HTTP_PORT || "8787");

function argValue(name, fallback = "") {
  const token = `--${name}`;
  const prefix = `${token}=`;
  const inline = process.argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(token);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  const token = `--${name}`;
  const prefix = `${token}=`;
  return process.argv.some((entry) => entry === token || entry.startsWith(prefix));
}

function boolArg(name, fallback = false) {
  const value = argValue(name, hasArg(name) ? "true" : fallback ? "true" : "false");
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeoutMs || 90_000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    command: [command, ...args].join(" "),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: parseJson(stdout) ? "" : compact(stdout, 4000),
    stderr: compact(stderr, 4000),
    json: parseJson(stdout),
    error: result.error?.message || null,
  };
}

function parseJson(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compact(value, limit = 1000) {
  const text = String(value || "").replace(/\s+$/g, "");
  return text.length > limit ? `${text.slice(0, limit)}...<truncated:${text.length - limit}>` : text;
}

function listenerReachable(host = "127.0.0.1", port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    socket.setTimeout(750, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

function removeOfficeCache() {
  const dirs = [
    path.join(REPO_ROOT, "data", "imprint", "office_snapshot_cache", "web"),
    path.join(REPO_ROOT, "data", "imprint", "office_snapshot_cache", "dashboard"),
  ];
  let removed = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      fs.rmSync(path.join(dir, entry), { force: true });
      removed += 1;
    }
  }
  return {
    command: "remove office snapshot cache json files",
    ok: true,
    removed_count: removed,
    cache_dirs: dirs,
  };
}

function printHelp() {
  console.log(`Usage:
  npm run federation:repair -- --action all

Actions:
  http              Start/repair local MCP HTTP lane when not reachable.
  sidecar-launchd   Install/reload federation launchd sidecar.
  sidecar-stale     Run federation sidecar once.
  office-cache      Clear Office snapshot cache files.
  build             Rebuild missing dist/server.js artifacts.
  providers         Reinstall provider configs, then run diagnostics.
  all               Run all bounded repairs in order.

Options:
  --json            Print JSON only.
  --client <id>     Provider client for providers repair. Repeat by comma with --clients.
  --peer <url>      Peer for sidecar-stale if MASTER_MOLD_FEDERATION_PEERS is not set.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const action = String(argValue("action", "all")).trim() || "all";
  const jsonOnly = boolArg("json", false);
  const actions = action === "all"
    ? ["build", "http", "sidecar-launchd", "sidecar-stale", "office-cache", "providers"]
    : [action];
  const identity = resolveFederationHostIdentity({
    hostId: argValue("host-id", ""),
    envHostId: process.env.MASTER_MOLD_HOST_ID || "",
    hostname: os.hostname(),
    identityKeyPath: argValue("identity-key-path", process.env.MASTER_MOLD_IDENTITY_KEY_PATH || ""),
  });
  const hostId = identity.hostId;
  const identityKeyPath = identity.identityKeyPath;
  const peers = [
    ...String(argValue("peer", "")).split(","),
    ...String(process.env.MASTER_MOLD_FEDERATION_PEERS || "").split(","),
  ].map((entry) => entry.trim()).filter(Boolean);
  const clientText = String(argValue("clients", argValue("client", ""))).trim();
  const clients = clientText ? clientText.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
  const steps = [];

  for (const item of actions) {
    if (item === "build") {
      if (fs.existsSync(path.join(REPO_ROOT, "dist", "server.js"))) {
        steps.push({ action: item, ok: true, skipped: true, detail: "dist/server.js already exists." });
      } else {
        steps.push({ action: item, ...run("npm", ["run", "build"], { timeoutMs: 180_000 }) });
      }
    } else if (item === "http") {
      if (await listenerReachable()) {
        steps.push({ action: item, ok: true, skipped: true, detail: `HTTP listener already reachable on 127.0.0.1:${DEFAULT_PORT}.` });
      } else {
        steps.push({ action: item, ...run(process.execPath, ["scripts/agent_office_gui.mjs", "start"], { timeoutMs: 120_000 }) });
      }
    } else if (item === "sidecar-launchd") {
      steps.push({ action: item, ...run("npm", ["run", "federation:launchd:install"], { timeoutMs: 90_000 }) });
    } else if (item === "sidecar-stale") {
      if (peers.length === 0) {
        steps.push({
          action: item,
          ok: false,
          skipped: true,
          detail: "No federation peers configured; set MASTER_MOLD_FEDERATION_PEERS or pass --peer.",
        });
      } else {
        const args = ["scripts/federation_sidecar.mjs", "--once", "--host-id", hostId, "--identity-key-path", identityKeyPath];
        for (const peer of peers) args.push("--peer", peer);
        steps.push({ action: item, ...run(process.execPath, args, { timeoutMs: 90_000 }) });
      }
    } else if (item === "office-cache") {
      steps.push({ action: item, ...removeOfficeCache() });
    } else if (item === "providers") {
      const installArgs = ["run", "providers:install"];
      if (clients.length === 0) {
        installArgs.push("--", "claude-cli", "codex", "cursor", "github-copilot-vscode");
      } else {
        installArgs.push("--", ...clients);
      }
      steps.push({ action: item, phase: "install", ...run("npm", installArgs, { timeoutMs: 120_000 }) });
      const diagnoseArgs = ["run", "providers:diagnose"];
      if (clients.length > 0) {
        diagnoseArgs.push("--", ...clients);
      }
      steps.push({ action: item, phase: "diagnose", ...run("npm", diagnoseArgs, { timeoutMs: 120_000 }) });
    } else {
      steps.push({ action: item, ok: false, error: "unsupported_action" });
    }
  }

  const failed = steps.filter((step) => step.ok === false && step.skipped !== true);
  const output = {
    ok: failed.length === 0,
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    host_id: hostId,
    requested_action: action,
    steps,
    next_action:
      failed.length > 0
        ? "Review the failed repair step and rerun the same targeted action after fixing the concrete blocker."
        : "Run `npm run --silent federation:doctor -- --json` and refresh Agent Office to verify the repaired state.",
  };

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`MASTER-MOLD repair: ${action}`);
    for (const step of steps) {
      console.log(`${step.ok ? "OK" : "FAIL"} ${step.action}${step.phase ? `:${step.phase}` : ""}${step.skipped ? " skipped" : ""}`);
      if (!step.ok && (step.stderr || step.detail || step.error)) {
        console.log(compact(step.stderr || step.detail || step.error, 800));
      }
    }
    console.log(`Next action: ${output.next_action}`);
    console.log("\nJSON:");
    console.log(JSON.stringify(output, null, 2));
  }
  process.exitCode = output.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
