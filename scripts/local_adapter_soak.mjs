#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  acquireRunnerSingletonLock,
  callTool,
  loadRunnerEnv,
  repoRootFromMeta,
  resolveTransport,
} from "./mcp_runner_support.mjs";
import { deriveEffectiveTrainingStatus } from "./local_adapter_lane.mjs";
import {
  resolveCutoverCandidate,
  rollbackRouterDefault,
  verifyCutoverOutcome,
} from "./local_adapter_cutover.mjs";

const REPO_ROOT = repoRootFromMeta(import.meta.url);
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const ENV_PATH = path.join(REPO_ROOT, ".env");

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    registrationPath: "",
    transport: "auto",
    cycles: 3,
    intervalSeconds: 15,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[++index] ?? "";
    } else if (token === "--registration") {
      args.registrationPath = argv[++index] ?? "";
    } else if (token === "--transport") {
      args.transport = argv[++index] ?? "auto";
    } else if (token === "--cycles") {
      args.cycles = Number.parseInt(argv[++index] ?? "3", 10);
    } else if (token === "--interval-seconds") {
      args.intervalSeconds = Number.parseInt(argv[++index] ?? "15", 10);
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  args.cycles = Number.isFinite(args.cycles) && args.cycles > 0 ? Math.min(args.cycles, 20) : 3;
  args.intervalSeconds =
    Number.isFinite(args.intervalSeconds) && args.intervalSeconds >= 0 ? Math.min(args.intervalSeconds, 300) : 15;
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_soak.mjs [--manifest <path>] [--registration <path>] [--transport auto|stdio|http] [--cycles <n>] [--interval-seconds <n>]",
      "",
      "Notes:",
      "  This repeatedly verifies the current primary adapter backend and rolls back to the previous default if route or eval checks regress.",
    ].join("\n") + "\n"
  );
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
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
  return {
    manifestPath: chosen,
    manifest,
  };
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
  return {
    registrationPath: chosen,
    registration,
  };
}

function readEnvSnapshot(keys) {
  const payload = {};
  const parsed = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const keySet = new Set(keys);
  for (const key of keySet) {
    payload[key] = null;
  }
  for (const line of parsed) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      continue;
    }
    const [rawKey, ...rawValue] = line.split("=");
    const key = String(rawKey || "").trim();
    if (keySet.has(key)) {
      payload[key] = rawValue.join("=");
    }
  }
  return payload;
}

function upsertEnv(updates) {
  const existingLines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const output = [];
  const seen = new Set();
  for (const line of existingLines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      output.push(line);
      continue;
    }
    const key = line.split("=", 1)[0].trim();
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      output.push(line);
      continue;
    }
    seen.add(key);
    const nextValue = updates[key];
    if (nextValue === null || nextValue === undefined || nextValue === "") {
      continue;
    }
    output.push(`${key}=${nextValue}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key) || value === null || value === undefined || value === "") {
      continue;
    }
    output.push(`${key}=${value}`);
  }
  fs.writeFileSync(
    ENV_PATH,
    `${output.filter((line, index, arr) => !(index === arr.length - 1 && line === "")).join("\n")}\n`,
    "utf8"
  );
}

function setEnvValues(updates) {
  upsertEnv(updates);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      delete process.env[key];
      continue;
    }
    process.env[key] = String(value);
  }
}

function createMutation(candidateId, step, counter) {
  const id = `${candidateId}:${step}:${counter.value++}`;
  return {
    idempotency_key: `local-adapter-soak:${id}`,
    side_effect_fingerprint: `local-adapter-soak:${id}`,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolvePrimarySoakCandidate(manifest, registration) {
  const candidate = resolveCutoverCandidate(manifest, registration);
  if (!candidate.ok) {
    return candidate;
  }
  const currentStatus = readString(deriveEffectiveTrainingStatus({ manifest }).effective_status);
  if (currentStatus !== "adapter_primary_mlx" && currentStatus !== "adapter_primary_ollama") {
    return {
      ok: false,
      reason: "The selected adapter is not the active router default yet. Run cutover first.",
    };
  }
  const previousDefaultBackendId =
    readString(manifest?.cutover_result?.previous_default_backend_id) ||
    readString(registration?.cutover_result?.previous_default_backend_id) ||
    null;
  const promotionRewardScore = readNumber(manifest?.promotion_result?.reward_score);
  const baselineScore = readNumber(manifest?.promotion_result?.baseline_score);
  return {
    ...candidate,
    previous_default_backend_id: previousDefaultBackendId,
    promotion_reward_score: promotionRewardScore,
    baseline_score: baselineScore,
  };
}

export function buildSoakHeuristicConfig(manifest) {
  const contract =
    manifest?.primary_soak_contract && typeof manifest.primary_soak_contract === "object"
      ? manifest.primary_soak_contract
      : {};
  const maxRewardRegression =
    Number.isFinite(contract.max_reward_regression_vs_accepted) && Number(contract.max_reward_regression_vs_accepted) >= 0
      ? Number(contract.max_reward_regression_vs_accepted)
      : 5;
  const minDeltaVsBaseline =
    Number.isFinite(contract.min_reward_delta_vs_baseline) ? Number(contract.min_reward_delta_vs_baseline) : 0;
  const maxConsecutiveSoftRegressions =
    Number.isFinite(contract.max_consecutive_soft_regressions) && Number(contract.max_consecutive_soft_regressions) >= 1
      ? Math.min(5, Math.max(1, Number(contract.max_consecutive_soft_regressions)))
      : 2;
  return {
    max_reward_regression_vs_accepted: maxRewardRegression,
    min_reward_delta_vs_baseline: minDeltaVsBaseline,
    max_consecutive_soft_regressions: maxConsecutiveSoftRegressions,
  };
}

function isSoftRegressionEntry(entry, { promotionRewardScore, baselineScore }) {
  const reward = readNumber(entry?.benchmark_metric_value);
  if (reward === null) {
    return false;
  }
  if (promotionRewardScore !== null && reward < promotionRewardScore) {
    return true;
  }
  if (baselineScore !== null && reward < baselineScore) {
    return true;
  }
  return false;
}

export function evaluateSoakRollbackHeuristics({ cycleResults, promotionRewardScore, baselineScore, config }) {
  const latest = Array.isArray(cycleResults) && cycleResults.length > 0 ? cycleResults[cycleResults.length - 1] : null;
  if (!latest) {
    return {
      rollback_required: false,
      reasons: [],
      metrics: {
        benchmark_metric_value: null,
        reward_regression_vs_accepted: null,
        reward_delta_vs_baseline: null,
        consecutive_soft_regressions: 0,
      },
    };
  }

  const reward = readNumber(latest.benchmark_metric_value);
  const regressionVsAccepted = reward !== null && promotionRewardScore !== null ? Number((promotionRewardScore - reward).toFixed(2)) : null;
  const deltaVsBaseline = reward !== null && baselineScore !== null ? Number((reward - baselineScore).toFixed(2)) : null;

  let consecutiveSoftRegressions = 0;
  for (let index = cycleResults.length - 1; index >= 0; index -= 1) {
    if (!isSoftRegressionEntry(cycleResults[index], { promotionRewardScore, baselineScore })) {
      break;
    }
    consecutiveSoftRegressions += 1;
  }

  const reasons = [];
  if (regressionVsAccepted !== null && regressionVsAccepted > config.max_reward_regression_vs_accepted) {
    reasons.push("reward_regressed_from_accepted_score");
  }
  if (deltaVsBaseline !== null && deltaVsBaseline < config.min_reward_delta_vs_baseline) {
    reasons.push("reward_below_baseline_contract");
  }
  if (consecutiveSoftRegressions >= config.max_consecutive_soft_regressions) {
    reasons.push("consecutive_soft_regressions_exceeded");
  }

  return {
    rollback_required: reasons.length > 0,
    reasons,
    metrics: {
      benchmark_metric_value: reward,
      reward_regression_vs_accepted: regressionVsAccepted,
      reward_delta_vs_baseline: deltaVsBaseline,
      consecutive_soft_regressions: consecutiveSoftRegressions,
    },
  };
}

function normalizeErrorMessage(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadRunnerEnv(REPO_ROOT);
  const { manifestPath, manifest } = resolveManifest(args.manifestPath);
  const { registrationPath, registration } = resolveRegistration(manifest, args.registrationPath);
  const startedAt = new Date().toISOString();
  const lock = await acquireRunnerSingletonLock(
    REPO_ROOT,
    `local-adapter-soak-${String(manifest.candidate_id || "candidate").replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`,
    5000
  );
  if (!lock.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, skipped: true, reason: "already_running", candidate_id: manifest.candidate_id }, null, 2)}\n`
    );
    return;
  }

  try {
    const candidate = resolvePrimarySoakCandidate(manifest, registration);
    if (!candidate.ok) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, reason: candidate.reason, manifest_path: manifestPath, registration_path: registrationPath }, null, 2)}\n`
      );
      process.exit(1);
    }
    const transport =
      args.transport === "http" ? "http" : args.transport === "stdio" ? "stdio" : resolveTransport(REPO_ROOT);
    const mutationCounter = { value: 0 };
    const heuristicConfig = buildSoakHeuristicConfig(manifest);
    const previousEnv = readEnvSnapshot(["TRICHAT_OLLAMA_MODEL", "TRICHAT_LOCAL_INFERENCE_PROVIDER"]);
    const previousTimeout = process.env.MCP_TOOL_CALL_TIMEOUT_MS;
    const desiredTimeoutMs = transport === "http" ? 90000 : 150000;
    const currentTimeoutMs = Number.parseInt(String(process.env.MCP_TOOL_CALL_TIMEOUT_MS || ""), 10);
    if (!Number.isFinite(currentTimeoutMs) || currentTimeoutMs < desiredTimeoutMs) {
      process.env.MCP_TOOL_CALL_TIMEOUT_MS = String(desiredTimeoutMs);
    }
    const cycles = [];
    let rollback = null;
    let soakPassed = true;

    try {
      for (let index = 0; index < args.cycles; index += 1) {
        try {
          const benchmarkResult = callTool(REPO_ROOT, {
            tool: "benchmark.run",
            args: {
              mutation: createMutation(manifest.candidate_id, `cycle-${index + 1}-benchmark`, mutationCounter),
              suite_id: candidate.benchmark_suite_id,
              candidate_label: candidate.backend_id,
            },
            transport,
          });
          const evalResult = callTool(REPO_ROOT, {
            tool: "eval.run",
            args: {
              mutation: createMutation(manifest.candidate_id, `cycle-${index + 1}-eval`, mutationCounter),
              suite_id: candidate.eval_suite_id,
              candidate_label: candidate.backend_id,
            },
            transport,
          });
          const routeResult = callTool(REPO_ROOT, {
            tool: "model.router",
            args: {
              action: "route",
              task_kind: "coding",
              context_tokens: 4000,
              latency_budget_ms: 4000,
              preferred_tags: Array.isArray(candidate.tags) ? candidate.tags : [],
            },
            transport,
          });
          const bootstrapStatus = callTool(REPO_ROOT, {
            tool: "autonomy.bootstrap",
            args: {
              action: "status",
              local_host_id: "local",
            },
            transport,
          });
          const verification = verifyCutoverOutcome({
            candidateBackendId: candidate.backend_id,
            routeResult,
            evalResult,
            bootstrapStatus,
          });
          const cycleEntry = {
            cycle: index + 1,
            evaluated_at: new Date().toISOString(),
            benchmark_run_id: benchmarkResult?.run_id ?? null,
            benchmark_metric_value: readNumber(benchmarkResult?.aggregate_metric_value),
            eval_run_id: evalResult?.run_id ?? null,
            aggregate_metric_value: evalResult?.aggregate_metric_value ?? null,
            verification: verification.verification,
          };
          cycles.push(cycleEntry);
          const heuristics = evaluateSoakRollbackHeuristics({
            cycleResults: cycles,
            promotionRewardScore: candidate.promotion_reward_score,
            baselineScore: candidate.baseline_score,
            config: heuristicConfig,
          });
          cycleEntry.heuristics = heuristics;
          if (benchmarkResult?.ok !== true || !verification.ok || heuristics.rollback_required) {
            soakPassed = false;
            rollback = rollbackRouterDefault({
              previousDefaultBackendId: candidate.previous_default_backend_id,
              mutationCounter,
              transport,
            });
            if (candidate.target === "ollama" && manifest.rollback_model) {
              setEnvValues({
                TRICHAT_OLLAMA_MODEL: manifest.rollback_model,
                TRICHAT_LOCAL_INFERENCE_PROVIDER: "auto",
              });
            } else {
              setEnvValues(previousEnv);
            }
            break;
          }
          if (index < args.cycles - 1 && args.intervalSeconds > 0) {
            await sleep(args.intervalSeconds * 1000);
          }
        } catch (error) {
          soakPassed = false;
          cycles.push({
            cycle: index + 1,
            evaluated_at: new Date().toISOString(),
            benchmark_run_id: null,
            benchmark_metric_value: null,
            eval_run_id: null,
            aggregate_metric_value: null,
            verification: {
              eval_ok: false,
              route_selected_backend_id: null,
              bootstrap_blocking_repairs: ["tool_call_failed"],
            },
            tool_error: normalizeErrorMessage(error),
          });
          rollback = rollbackRouterDefault({
            previousDefaultBackendId: candidate.previous_default_backend_id,
            mutationCounter,
            transport,
          });
          if (candidate.target === "ollama" && manifest.rollback_model) {
            setEnvValues({
              TRICHAT_OLLAMA_MODEL: manifest.rollback_model,
              TRICHAT_LOCAL_INFERENCE_PROVIDER: "auto",
            });
          } else {
            setEnvValues(previousEnv);
          }
          break;
        }
      }
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.MCP_TOOL_CALL_TIMEOUT_MS;
      } else {
        process.env.MCP_TOOL_CALL_TIMEOUT_MS = previousTimeout;
      }
    }

    const result = {
      ok: soakPassed,
      cycles: args.cycles,
      interval_seconds: args.intervalSeconds,
      completed_cycles: cycles.length,
      verified_cycles: cycles.filter((entry) => entry.verification.eval_ok === true).length,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      candidate_backend_id: candidate.backend_id,
      previous_default_backend_id: candidate.previous_default_backend_id,
      heuristic_contract: heuristicConfig,
      cycle_results: cycles,
      rollback,
    };

    manifest.primary_soak_result = result;
    manifest.primary_soak_history = Array.isArray(manifest.primary_soak_history)
      ? [result, ...manifest.primary_soak_history].slice(0, 10)
      : [result];
    manifest.next_action = soakPassed
      ? "The new primary backend survived the bounded comparative soak; continue longer-running confidence checks before removing the rollback path."
      : "The primary adapter regressed during soak and the previous default was restored. Inspect the soak result before retrying cutover.";
    if (!soakPassed && rollback?.restored) {
      manifest.status = candidate.target === "mlx" ? "adapter_served_mlx" : "adapter_exported_ollama";
    }
    writeJson(manifestPath, manifest);

    registration.primary_soak_result = result;
    registration.primary_soak_history = Array.isArray(registration.primary_soak_history)
      ? [result, ...registration.primary_soak_history].slice(0, 10)
      : [result];
    writeJson(registrationPath, registration);

    updateRegistry(manifest, manifestPath, {
      primary_soak_ok: soakPassed,
      primary_soak_completed_at: new Date().toISOString(),
      primary_soak_cycles: cycles.length,
      cutover_status: manifest.status,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: soakPassed,
          manifest_path: manifestPath,
          registration_path: registrationPath,
          primary_soak_result: result,
        },
        null,
        2
      )}\n`
    );
    if (!soakPassed) {
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
