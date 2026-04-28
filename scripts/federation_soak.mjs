#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveFederationHostIdentity } from "./federation_host_identity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValues(name) {
  const values = [];
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === longName && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
      values.push(process.argv[index + 1]);
      index += 1;
    } else if (token.startsWith(prefix)) {
      values.push(token.slice(prefix.length));
    }
  }
  return values;
}

function argValue(name, fallback = "") {
  const values = argValues(name);
  return values.length ? values[values.length - 1] : fallback;
}

function hasArg(name) {
  const token = `--${name}`;
  const prefix = `${token}=`;
  return process.argv.some((entry) => entry === token || entry.startsWith(prefix));
}

function boolArg(name, fallback = false) {
  const values = argValues(name);
  if (!values.length) {
    return hasArg(name) ? true : fallback;
  }
  const normalized = String(values[values.length - 1]).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePeers() {
  const raw = [
    ...argValues("peer"),
    ...argValues("host"),
    String(argValue("peers", process.env.MASTER_MOLD_FEDERATION_PEERS || "")),
  ].join(",");
  return [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))].slice(0, 3);
}

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeoutMs || 60_000,
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

export function normalizePeerUrl(value) {
  try {
    return new URL(String(value || "").trim()).toString().toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

export function sidecarStepAcceptedAllPeers(step, peers) {
  const sends = Array.isArray(step?.json?.sends) ? step.json.sends : [];
  if (!peers.length || sends.length < peers.length) {
    return false;
  }
  const sendsByPeer = new Map(
    sends.map((send) => [
      normalizePeerUrl(send.target_peer || send.peer),
      send,
    ])
  );
  return peers.every((peer) => {
    const send = sendsByPeer.get(normalizePeerUrl(peer));
    return (
      send?.ok === true &&
      send?.status === 202 &&
      send?.response?.accepted === true
    );
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function printHelp() {
  console.log(`Usage:
  npm run federation:soak -- --peer http://peer-a.local:8787 --peer http://peer-b.local:8787 --iterations 3

Runs a repeatable multi-host federation soak. It produces JSON plus a concise human summary. Destructive
or disruptive recovery steps are guidance by default; pass --apply to restart local launchd/MCP lanes.

Options:
  --peer/--host <url>        Peer endpoint. Repeatable; bounded to first 3.
  --iterations <n>           Sidecar one-shot iterations. Default: 2.
  --interval-ms <n>          Delay between one-shot publishes. Default: 1000.
  --apply                    Actually run MCP/launchd restart steps instead of guidance only.
  --offline-simulation       Run a sidecar publish to 127.0.0.1:9 with an isolated state file.
  --json                     Print machine-readable JSON only.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const peers = parsePeers();
  const iterations = Math.max(1, Math.min(20, Math.trunc(numberArg("iterations", 2))));
  const intervalMs = Math.max(0, Math.min(60_000, Math.trunc(numberArg("interval-ms", 1000))));
  const apply = boolArg("apply", false);
  const jsonOnly = boolArg("json", false);
  const offlineSimulation = boolArg("offline-simulation", true);
  const identity = resolveFederationHostIdentity({
    hostId: argValue("host-id", ""),
    envHostId: process.env.MASTER_MOLD_HOST_ID || "",
    hostname: os.hostname(),
    identityKeyPath: argValue("identity-key-path", process.env.MASTER_MOLD_IDENTITY_KEY_PATH || ""),
  });
  const hostId = identity.hostId;
  const identityKeyPath = identity.identityKeyPath;
  const steps = [];

  const add = (kind, detail) => {
    const entry = { kind, ...detail };
    steps.push(entry);
    return entry;
  };

  add("doctor_before", run("npm", ["run", "--silent", "federation:doctor", "--", "--json"], { timeoutMs: 60_000 }));

  for (let index = 0; index < iterations; index += 1) {
    const args = ["scripts/federation_sidecar.mjs", "--once", "--host-id", hostId, "--identity-key-path", identityKeyPath];
    for (const peer of peers) {
      args.push("--peer", peer);
    }
    if (peers.length > 0) {
      add("sidecar_once", { iteration: index + 1, ...run(process.execPath, args, { timeoutMs: 60_000 }) });
    } else {
      add("sidecar_once", {
        iteration: index + 1,
        ok: false,
        skipped: true,
        detail: "No peers configured; pass --peer or MASTER_MOLD_FEDERATION_PEERS.",
      });
    }
    if (index + 1 < iterations) {
      sleep(intervalMs);
    }
  }

  if (offlineSimulation) {
    const statePath = path.join(REPO_ROOT, "data", "federation", `${hostId}-soak-offline-simulation-state.json`);
    const offlineResult = run(
      process.execPath,
      [
        "scripts/federation_sidecar.mjs",
        "--once",
        "--host-id",
        hostId,
        "--identity-key-path",
        identityKeyPath,
        "--peer",
        "http://127.0.0.1:9",
        "--state-path",
        statePath,
      ],
      { timeoutMs: 30_000, env: { ...process.env, MASTER_MOLD_FEDERATION_PEERS: "" } }
    );
    add(
      "peer_offline_simulation",
      {
        ...offlineResult,
        ok: true,
        simulated_failure_expected: true,
        observed_publish_failure: offlineResult.ok === false,
        raw_sidecar_ok: offlineResult.ok,
        guidance: "The offline peer target is intentionally unreachable; this step passes when the failure is captured as state/output instead of being treated as live remote validation.",
      }
    );
  }

  if (apply) {
    add("mcp_restart", run(path.join(REPO_ROOT, "scripts", "agents_switch.sh"), ["off"], { timeoutMs: 60_000 }));
    add("mcp_restart", run(path.join(REPO_ROOT, "scripts", "agents_switch.sh"), ["on"], { timeoutMs: 120_000 }));
    add("launchd_repair", run("npm", ["run", "federation:launchd:install"], { timeoutMs: 60_000 }));
  } else {
    add("mcp_restart_guidance", {
      ok: true,
      skipped: true,
      guidance: "Run with --apply to execute `scripts/agents_switch.sh off`, `scripts/agents_switch.sh on`, and `npm run federation:launchd:install` locally.",
    });
    add("sleep_wake_network_guidance", {
      ok: true,
      skipped: true,
      guidance: "Sleep/wake and network-change validation is operator-mediated: move Wi-Fi/VPN or sleep the host, then rerun this soak and compare doctor stale-peer output.",
    });
  }

  add("doctor_after", run("npm", ["run", "--silent", "federation:doctor", "--", "--json"], { timeoutMs: 60_000 }));

  const failed = steps.filter((step) => step.ok === false && step.skipped !== true);
  const sidecarSteps = steps.filter((step) => step.kind === "sidecar_once");
  const liveRemoteValidationClaimed =
    peers.length > 0 &&
    sidecarSteps.length === iterations &&
    sidecarSteps.every((step) => sidecarStepAcceptedAllPeers(step, peers));
  const output = {
    ok: failed.length === 0,
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    host_id: hostId,
    peers,
    iterations,
    applied_restarts: apply,
    live_remote_validation_claimed: liveRemoteValidationClaimed,
    note: "This soak only claims local/script execution unless the peer endpoints returned successful signed ingest responses in the step JSON.",
    steps,
    summary: {
      failed_count: failed.length,
      sidecar_success_count: steps.filter((step) => step.kind === "sidecar_once" && step.ok === true).length,
      sidecar_failure_count: steps.filter((step) => step.kind === "sidecar_once" && step.ok === false && step.skipped !== true).length,
      offline_simulation_exercised: steps.some((step) => step.kind === "peer_offline_simulation"),
      next_action:
        failed.length > 0
          ? "Inspect failed step stderr/json, repair the concrete lane, then rerun the same soak command."
          : "If peers were real and ingest stayed fresh, install or repair launchd for continuous publishing.",
    },
  };

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`MASTER-MOLD federation soak for ${hostId}`);
    console.log(`Peers: ${peers.length ? peers.join(", ") : "none"}`);
    console.log(`Sidecar one-shot success: ${output.summary.sidecar_success_count}/${iterations}`);
    console.log(`Offline simulation: ${output.summary.offline_simulation_exercised ? "exercised with isolated state" : "skipped"}`);
    console.log(`Live remote validation claimed: ${output.live_remote_validation_claimed}`);
    console.log(`Next action: ${output.summary.next_action}`);
    console.log("\nJSON:");
    console.log(JSON.stringify(output, null, 2));
  }
  process.exitCode = output.ok ? 0 : 1;
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryHref === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
