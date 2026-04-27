#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 120_000;

function argValues(name) {
  const out = [];
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === longName && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
      out.push(process.argv[index + 1]);
      index += 1;
    } else if (token.startsWith(prefix)) {
      out.push(token.slice(prefix.length));
    }
  }
  return out;
}

function argValue(name, fallback = "") {
  const values = argValues(name);
  return values.length > 0 ? values[values.length - 1] : fallback;
}

function hasArg(name) {
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  return process.argv.some((entry) => entry === longName || entry.startsWith(prefix));
}

function boolArg(name, fallback = false) {
  const values = argValues(name);
  if (values.length === 0) {
    return hasArg(name) ? true : fallback;
  }
  const value = String(values[values.length - 1]).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function safeId(value, fallback = "host") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

function parsePeers() {
  const raw = [
    ...argValues("peer"),
    ...argValues("server"),
    String(argValue("peers", process.env.MASTER_MOLD_FEDERATION_PEERS || "")),
  ].join(",");
  return [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function runStep(label, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const parsed = parseJson(stdout);
  return {
    label,
    command: [command, ...args].join(" "),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stdout: parsed ? "" : compact(stdout, 4000),
    stderr: compact(stderr, 4000),
    json: parsed,
  };
}

function parseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function compact(value, limit = 1000) {
  const text = String(value || "").replace(/\s+$/g, "");
  return text.length > limit ? `${text.slice(0, limit)}...<truncated:${text.length - limit}>` : text;
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    command: [command, ...args].join(" "),
    ok: result.status === 0,
    status: result.status,
    version: compact(result.stdout || result.stderr || result.error?.message || "", 500),
  };
}

function printHelp() {
  console.log(`Usage:
  npm run federation:onboard -- --peer http://peer-a.local:8787 [--host-id my-host]

One-command coworker onboarding. The command checks prerequisites, creates or reuses local host identity,
stores recovery material in 1Password when available, writes non-secret .env settings, requests peer access,
runs the sidecar once, runs the doctor, and prints the exact next step.

Options:
  --peer/--server <url>       Peer MASTER-MOLD HTTP endpoint to request and publish to. Repeatable.
  --peers <csv>               Comma-separated peer endpoints.
  --host-id <id>              Durable local host id. Defaults to hostname-safe id.
  --vault <name>              1Password vault. Default: Employee.
  --require-1password         Fail instead of local-only fallback when 1Password is unavailable.
  --skip-request              Do not call request_remote_access.mjs.
  --skip-sidecar              Do not run federation_sidecar.mjs --once.
  --json                      Print machine-readable JSON only.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const hostId = safeId(argValue("host-id", process.env.MASTER_MOLD_HOST_ID || os.hostname()), "local-host");
  const peers = parsePeers();
  const identityKeyPath = path.join(os.homedir(), ".master-mold", "identity", `${hostId}-ed25519.pem`);
  const jsonOnly = boolArg("json", false);
  const requireOnePassword = boolArg("require-1password", false);
  const skipRequest = boolArg("skip-request", false);
  const skipSidecar = boolArg("skip-sidecar", false);
  const vault = String(argValue("vault", process.env.MASTER_MOLD_1PASSWORD_VAULT || "Employee")).trim() || "Employee";
  const startedAt = new Date().toISOString();

  const result = {
    ok: false,
    started_at: startedAt,
    completed_at: null,
    repo_root: REPO_ROOT,
    host_id: hostId,
    hostname: os.hostname(),
    peers,
    prerequisites: {
      node: commandVersion(process.execPath, ["--version"]),
      npm: commandVersion("npm", ["--version"]),
      git: commandVersion("git", ["--version"]),
      op: commandVersion(String(argValue("op-path", process.env.OP_PATH || "op")), ["--version"]),
    },
    steps: [],
    next_step: "",
    secret_values_revealed: false,
  };

  const addStep = (step) => {
    result.steps.push(step);
    return step;
  };

  if (!fs.existsSync(path.join(REPO_ROOT, "node_modules", "@modelcontextprotocol"))) {
    addStep(runStep("npm_ci", "npm", ["ci"], { timeoutMs: 180_000 }));
  }
  if (!fs.existsSync(path.join(REPO_ROOT, "dist", "server.js"))) {
    addStep(runStep("build_missing_dist", "npm", ["run", "build"], { timeoutMs: 180_000 }));
  }

  const bootstrapArgs = [
    "scripts/federation_secret_bootstrap.mjs",
    "--host-id",
    hostId,
    "--vault",
    vault,
    "--write-env",
  ];
  for (const peer of peers) {
    bootstrapArgs.push("--peer", peer);
  }
  if (requireOnePassword) {
    bootstrapArgs.push("--require-1password");
  }
  const opPath = String(argValue("op-path", "")).trim();
  if (opPath) {
    bootstrapArgs.push("--op-path", opPath);
  }
  addStep(runStep("bootstrap_identity_and_env", process.execPath, bootstrapArgs));

  if (!skipRequest) {
    for (const peer of peers) {
      addStep(
        runStep(
          `request_remote_access:${peer}`,
          process.execPath,
          [
            "scripts/request_remote_access.mjs",
            "--server",
            peer,
            "--host-id",
            hostId,
            "--workspace-root",
            REPO_ROOT,
            "--identity-key-path",
            identityKeyPath,
            "--agent-runtime",
            String(argValue("agent-runtime", process.env.MASTER_MOLD_AGENT_RUNTIME || "federation-sidecar")).trim(),
            "--model-label",
            String(argValue("model-label", process.env.MASTER_MOLD_MODEL_LABEL || "federation-sidecar")).trim(),
          ],
          { timeoutMs: 45_000 }
        )
      );
    }
  }

  if (!skipSidecar && peers.length > 0) {
    const sidecarArgs = ["scripts/federation_sidecar.mjs", "--once", "--host-id", hostId, "--identity-key-path", identityKeyPath];
    for (const peer of peers) {
      sidecarArgs.push("--peer", peer);
    }
    addStep(runStep("sidecar_once", process.execPath, sidecarArgs, { timeoutMs: 60_000 }));
  }

  addStep(runStep("federation_doctor", "npm", ["run", "--silent", "federation:doctor", "--", "--json"], { timeoutMs: 60_000 }));

  const failed = result.steps.filter((step) => !step.ok);
  const requestFailed = failed.some((step) => step.label.startsWith("request_remote_access"));
  const sidecarFailed = failed.some((step) => step.label === "sidecar_once");
  const bootstrapStep = result.steps.find((step) => step.label === "bootstrap_identity_and_env");
  const onePasswordStatus = bootstrapStep?.json?.one_password?.status || "unknown";
  result.ok = failed.length === 0;
  result.completed_at = new Date().toISOString();
  if (failed.length === 0) {
    result.next_step = "Open Agent Office on the receiving peer, approve this host if it is pending, then run `npm run federation:launchd:install` on this host for continuous publishing.";
  } else if (requestFailed) {
    result.next_step = "Start or expose the peer MASTER-MOLD HTTP endpoint, then rerun this same `npm run federation:onboard -- --peer <url>` command; local identity and .env are already reusable.";
  } else if (sidecarFailed) {
    result.next_step = "Approve this host in Agent Office on the peer, then rerun `npm run federation:sidecar -- --once` or rerun onboarding.";
  } else if (onePasswordStatus === "unavailable") {
    result.next_step = "Unlock 1Password CLI with `op signin`, then rerun onboarding or continue with the local-only identity files listed in the JSON.";
  } else {
    result.next_step = "Review the failed step, fix the concrete prerequisite, and rerun the same onboarding command; completed steps are idempotent.";
  }

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = failed.length === 0 ? 0 : 1;
    return;
  }

  console.log(`MASTER-MOLD federation onboarding for ${hostId}`);
  console.log(`Peers: ${peers.length ? peers.join(", ") : "none configured"}`);
  for (const step of result.steps) {
    console.log(`${step.ok ? "OK" : "FAIL"} ${step.label}${step.status === null ? "" : ` exit=${step.status}`}`);
    if (!step.ok && (step.stderr || step.stdout)) {
      console.log(compact(step.stderr || step.stdout, 800));
    }
  }
  console.log(`Next step: ${result.next_step}`);
  console.log("\nJSON:");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
