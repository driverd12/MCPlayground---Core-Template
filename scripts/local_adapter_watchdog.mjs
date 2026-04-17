#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { acquireRunnerSingletonLock, loadRunnerEnv, repoRootFromMeta } from "./mcp_runner_support.mjs";
import { deriveEffectiveTrainingStatus } from "./local_adapter_lane.mjs";

const REPO_ROOT = repoRootFromMeta(import.meta.url);
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const SOAK_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "local_adapter_soak.mjs");
const DEFAULT_MAX_SOAK_AGE_MINUTES = 240;
const DEFAULT_SOAK_CYCLES = 1;
const DEFAULT_INTERVAL_SECONDS = 0;
const DEFAULT_SOAK_TIMEOUT_MS = 15 * 60 * 1000;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function latestManifestPath() {
  const registry = readJson(REGISTRY_PATH);
  const latest = Array.isArray(registry?.runs) ? registry.runs[0] : null;
  if (latest?.manifest_path && fs.existsSync(latest.manifest_path)) {
    return latest.manifest_path;
  }
  return null;
}

function resolveManifest(manifestPath) {
  const chosen = manifestPath || latestManifestPath();
  if (!chosen || !fs.existsSync(chosen)) {
    throw new Error("No local adapter manifest found. Run prepare, train, promote, integrate, and cutover first.");
  }
  const manifest = readJson(chosen);
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Could not read manifest at ${chosen}`);
  }
  return { manifestPath: chosen, manifest };
}

function resolveRegistration(manifest, registrationPath) {
  const chosen = registrationPath || readString(manifest?.promotion_result?.registration_path);
  if (!chosen || !fs.existsSync(chosen)) {
    throw new Error("No registered adapter artifact found. Run `npm run local:training:promote` first.");
  }
  const registration = readJson(chosen);
  if (!registration || typeof registration !== "object") {
    throw new Error(`Could not read registration artifact at ${chosen}`);
  }
  return { registrationPath: chosen, registration };
}

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    registrationPath: "",
    transport: "auto",
    maxSoakAgeMinutes: DEFAULT_MAX_SOAK_AGE_MINUTES,
    cycles: DEFAULT_SOAK_CYCLES,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[++index] ?? "";
    } else if (token === "--registration") {
      args.registrationPath = argv[++index] ?? "";
    } else if (token === "--transport") {
      args.transport = argv[++index] ?? "auto";
    } else if (token === "--max-soak-age-minutes") {
      args.maxSoakAgeMinutes = Number.parseInt(argv[++index] ?? String(DEFAULT_MAX_SOAK_AGE_MINUTES), 10);
    } else if (token === "--cycles") {
      args.cycles = Number.parseInt(argv[++index] ?? String(DEFAULT_SOAK_CYCLES), 10);
    } else if (token === "--interval-seconds") {
      args.intervalSeconds = Number.parseInt(argv[++index] ?? String(DEFAULT_INTERVAL_SECONDS), 10);
    } else if (token === "--force") {
      args.force = true;
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  args.maxSoakAgeMinutes =
    Number.isFinite(args.maxSoakAgeMinutes) && args.maxSoakAgeMinutes >= 15
      ? Math.min(args.maxSoakAgeMinutes, 24 * 60)
      : DEFAULT_MAX_SOAK_AGE_MINUTES;
  args.cycles = Number.isFinite(args.cycles) && args.cycles > 0 ? Math.min(args.cycles, 20) : DEFAULT_SOAK_CYCLES;
  args.intervalSeconds =
    Number.isFinite(args.intervalSeconds) && args.intervalSeconds >= 0 ? Math.min(args.intervalSeconds, 300) : DEFAULT_INTERVAL_SECONDS;
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_watchdog.mjs [--manifest <path>] [--registration <path>] [--transport auto|stdio|http] [--max-soak-age-minutes <n>] [--cycles <n>] [--interval-seconds <n>] [--force]",
      "",
      "Notes:",
      "  Re-runs the bounded primary soak when the last green confidence pass is missing, failed, or stale.",
    ].join("\n") + "\n"
  );
}

export function buildPrimaryWatchdogConfig(manifest) {
  const contract =
    manifest?.primary_watchdog_contract && typeof manifest.primary_watchdog_contract === "object"
      ? manifest.primary_watchdog_contract
      : {};
  const maxSoakAgeMinutes =
    Number.isFinite(contract.max_soak_age_minutes) && Number(contract.max_soak_age_minutes) >= 15
      ? Math.min(Number(contract.max_soak_age_minutes), 24 * 60)
      : DEFAULT_MAX_SOAK_AGE_MINUTES;
  const soakCycles =
    Number.isFinite(contract.soak_cycles) && Number(contract.soak_cycles) >= 1
      ? Math.min(Number(contract.soak_cycles), 20)
      : DEFAULT_SOAK_CYCLES;
  const intervalSeconds =
    Number.isFinite(contract.interval_seconds) && Number(contract.interval_seconds) >= 0
      ? Math.min(Number(contract.interval_seconds), 300)
      : DEFAULT_INTERVAL_SECONDS;
  return {
    max_soak_age_minutes: maxSoakAgeMinutes,
    soak_cycles: soakCycles,
    interval_seconds: intervalSeconds,
  };
}

function parseIsoTime(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function resolveWatchdogDecision(manifest, options = {}) {
  const status = readString(deriveEffectiveTrainingStatus({ manifest }).effective_status);
  const applicable = status === "adapter_primary_mlx" || status === "adapter_primary_ollama";
  const config = {
    ...buildPrimaryWatchdogConfig(manifest),
    ...(Number.isFinite(options.maxSoakAgeMinutes) ? { max_soak_age_minutes: Number(options.maxSoakAgeMinutes) } : {}),
  };
  if (!applicable) {
    return {
      ok: false,
      applicable: false,
      should_run_soak: false,
      trigger: "not_primary_adapter",
      reason: "The accepted adapter is not the active router default yet. Run cutover first.",
      config,
      status,
    };
  }
  const completedAt = readString(manifest?.primary_soak_result?.completed_at);
  const completedAtMs = parseIsoTime(completedAt);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const ageMinutes =
    completedAtMs !== null ? Number(((nowMs - completedAtMs) / 60000).toFixed(2)) : null;
  const soakPassed = manifest?.primary_soak_result?.ok === true;
  if (options.force === true) {
    return {
      ok: true,
      applicable: true,
      should_run_soak: true,
      trigger: "forced_watchdog_run",
      reason: "Force flag requested an immediate bounded re-soak.",
      soak_age_minutes: ageMinutes,
      config,
      status,
    };
  }
  if (!manifest?.primary_soak_result || completedAtMs === null) {
    return {
      ok: true,
      applicable: true,
      should_run_soak: true,
      trigger: "primary_soak_missing",
      reason: "The primary adapter has no recorded bounded soak yet.",
      soak_age_minutes: ageMinutes,
      config,
      status,
    };
  }
  if (soakPassed !== true) {
    return {
      ok: true,
      applicable: true,
      should_run_soak: true,
      trigger: "primary_soak_failed",
      reason: "The latest bounded soak did not pass cleanly.",
      soak_age_minutes: ageMinutes,
      config,
      status,
    };
  }
  if (ageMinutes !== null && ageMinutes > config.max_soak_age_minutes) {
    return {
      ok: true,
      applicable: true,
      should_run_soak: true,
      trigger: "primary_soak_stale",
      reason: `The latest bounded soak is older than ${config.max_soak_age_minutes} minutes.`,
      soak_age_minutes: ageMinutes,
      config,
      status,
    };
  }
  return {
    ok: true,
    applicable: true,
    should_run_soak: false,
    trigger: "primary_soak_fresh",
    reason: "The latest bounded soak is still fresh.",
    soak_age_minutes: ageMinutes,
    config,
    status,
  };
}

function updateRegistry(manifest, manifestPath, updates) {
  const registry = readJson(REGISTRY_PATH) || { runs: [] };
  const runs = Array.isArray(registry.runs) ? registry.runs : [];
  let matched = false;
  const nextRuns = runs.map((entry) => {
    if (entry?.run_id === manifest.run_id) {
      matched = true;
      return { ...entry, ...updates };
    }
    return entry;
  });
  if (!matched) {
    nextRuns.unshift({
      lane: "local_adapter_lane",
      run_id: manifest.run_id,
      candidate_id: manifest.candidate_id,
      generated_at: manifest.generated_at,
      manifest_path: manifestPath,
      ...updates,
    });
  }
  writeJson(REGISTRY_PATH, {
    schema_version: registry.schema_version || "training.model_registry.v2",
    updated_at: new Date().toISOString(),
    runs: nextRuns.slice(0, 25),
  });
}

function persistWatchdogResult({ manifest, manifestPath, registration, registrationPath, result }) {
  manifest.primary_watchdog_result = result;
  manifest.primary_watchdog_history = Array.isArray(manifest.primary_watchdog_history)
    ? [result, ...manifest.primary_watchdog_history].slice(0, 10)
    : [result];
  writeJson(manifestPath, manifest);

  registration.primary_watchdog_result = result;
  registration.primary_watchdog_history = Array.isArray(registration.primary_watchdog_history)
    ? [result, ...registration.primary_watchdog_history].slice(0, 10)
    : [result];
  writeJson(registrationPath, registration);

  updateRegistry(manifest, manifestPath, {
    primary_watchdog_last_run_at: result.completed_at,
    primary_watchdog_last_ok: result.ok,
    primary_watchdog_last_trigger: result.trigger,
    primary_watchdog_last_action: result.action,
    primary_watchdog_last_reason: result.reason,
  });
}

function runWatchdogSoak({ manifestPath, registrationPath, transport, cycles, intervalSeconds }) {
  const result = spawnSync(
    process.execPath,
    [
      SOAK_SCRIPT_PATH,
      "--manifest",
      manifestPath,
      "--registration",
      registrationPath,
      "--transport",
      transport,
      "--cycles",
      String(cycles),
      "--interval-seconds",
      String(intervalSeconds),
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_SOAK_TIMEOUT_MS,
    }
  );
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  let payload = null;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      payload = null;
    }
  }
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout,
    stderr,
    payload,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadRunnerEnv(REPO_ROOT);
  const { manifestPath, manifest } = resolveManifest(args.manifestPath);
  const { registrationPath, registration } = resolveRegistration(manifest, args.registrationPath);
  const lock = await acquireRunnerSingletonLock(
    REPO_ROOT,
    `local-adapter-watchdog-${String(manifest.candidate_id || "candidate").replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`,
    5000
  );
  if (!lock.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, skipped: true, reason: "already_running", candidate_id: manifest.candidate_id }, null, 2)}\n`
    );
    return;
  }

  try {
    const decision = resolveWatchdogDecision(manifest, {
      force: args.force,
      maxSoakAgeMinutes: args.maxSoakAgeMinutes,
    });
    if (!decision.ok) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, skipped: true, reason: decision.reason, trigger: decision.trigger, status: decision.status }, null, 2)}\n`
      );
      process.exit(1);
    }

    if (!decision.should_run_soak) {
      const result = {
        ok: true,
        action: "skip",
        skipped: true,
        trigger: decision.trigger,
        reason: decision.reason,
        status: decision.status,
        soak_age_minutes: decision.soak_age_minutes,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        watchdog_contract: decision.config,
      };
      persistWatchdogResult({ manifest, manifestPath, registration, registrationPath, result });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const startedAt = new Date().toISOString();
    const soak = runWatchdogSoak({
      manifestPath,
      registrationPath,
      transport: args.transport,
      cycles: args.cycles || decision.config.soak_cycles,
      intervalSeconds: args.intervalSeconds ?? decision.config.interval_seconds,
    });
    const result = {
      ok: soak.ok,
      action: "run_soak",
      skipped: false,
      trigger: decision.trigger,
      reason: decision.reason,
      status: decision.status,
      soak_age_minutes: decision.soak_age_minutes,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      watchdog_contract: decision.config,
      soak_status: soak.status,
      soak_result: soak.payload?.primary_soak_result ?? soak.payload ?? null,
      stderr: soak.stderr || null,
    };
    persistWatchdogResult({ manifest, manifestPath, registration, registrationPath, result });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!soak.ok) {
      process.exit(1);
    }
  } finally {
    lock.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
