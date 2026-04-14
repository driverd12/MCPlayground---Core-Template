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

const REPO_ROOT = repoRootFromMeta(import.meta.url);
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const ENV_PATH = path.join(REPO_ROOT, ".env");

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    registrationPath: "",
    transport: "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[++index] ?? "";
    } else if (token === "--registration") {
      args.registrationPath = argv[++index] ?? "";
    } else if (token === "--transport") {
      args.transport = argv[++index] ?? "stdio";
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_cutover.mjs [--manifest <path>] [--registration <path>] [--transport auto|stdio|http]",
      "",
      "Notes:",
      "  This promotes an already integrated adapter backend to router-default, verifies route selection and eval health, and rolls back on failure.",
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
    throw new Error("No local adapter manifest found. Run prepare, train, promote, and integrate first.");
  }
  const manifest = readJson(chosen);
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Could not read manifest at ${chosen}`);
  }
  return {
    manifestPath: chosen,
    manifest,
    runDir: path.dirname(chosen),
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
  if (registration?.decision?.status !== "registered" || registration?.decision?.accepted !== true) {
    throw new Error("The selected registration artifact is not an accepted adapter candidate.");
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
    idempotency_key: `local-adapter-cutover:${id}`,
    side_effect_fingerprint: `local-adapter-cutover:${id}`,
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

export function resolveCutoverCandidate(manifest, registration) {
  const manifestStatus = readString(manifest?.status) || null;
  const promotionEvalSuiteId = readString(manifest?.promotion_result?.eval_suite_id);
  const promotionBenchmarkSuiteId = readString(manifest?.promotion_result?.benchmark_suite_id);
  const integrationResult =
    manifest?.integration_result && typeof manifest.integration_result === "object"
      ? manifest.integration_result
      : registration?.integration_result && typeof registration.integration_result === "object"
        ? registration.integration_result
        : null;
  const target =
    readString(integrationResult?.target) ||
    (manifestStatus === "adapter_served_mlx" || manifestStatus === "adapter_primary_mlx"
      ? "mlx"
      : manifestStatus === "adapter_exported_ollama" || manifestStatus === "adapter_primary_ollama"
        ? "ollama"
        : null);
  if (!integrationResult || !target) {
    return {
      ok: false,
      reason: "No integrated adapter backend is available for cutover.",
    };
  }
  const plannedBackend =
    target === "mlx"
      ? registration?.decision?.integration_consideration?.router?.planned_backend
      : registration?.decision?.integration_consideration?.ollama?.planned_backend;
  const backendId = readString(integrationResult?.backend_id) || readString(plannedBackend?.backend_id);
  const modelId = readString(integrationResult?.model_id) || readString(plannedBackend?.model_id);
  if (!backendId) {
    return {
      ok: false,
      reason: "The integrated adapter does not have a persisted backend id.",
    };
  }
  if (!promotionEvalSuiteId) {
    return {
      ok: false,
      reason: "The integrated adapter is missing its promotion eval suite id.",
    };
  }
  return {
    ok: true,
    target,
    backend_id: backendId,
    model_id: modelId,
    endpoint: readString(integrationResult?.endpoint),
    eval_suite_id: promotionEvalSuiteId,
    benchmark_suite_id: promotionBenchmarkSuiteId,
    tags: Array.isArray(plannedBackend?.tags) ? plannedBackend.tags : [],
  };
}

export function verifyCutoverOutcome({ candidateBackendId, routeResult, evalResult, bootstrapStatus }) {
  const selectedBackendId = readString(routeResult?.selected_backend?.backend_id);
  const repairsNeeded = Array.isArray(bootstrapStatus?.repairs_needed)
    ? bootstrapStatus.repairs_needed.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const blockingRepairs = repairsNeeded.filter((entry) => !entry.endsWith(".default_drift"));
  const verification = {
    eval_ok: evalResult?.ok === true,
    route_selected_backend_id: selectedBackendId,
    bootstrap_blocking_repairs: blockingRepairs,
  };
  return {
    ok: evalResult?.ok === true && selectedBackendId === candidateBackendId && blockingRepairs.length === 0,
    verification,
  };
}

function rollbackRouterDefault({ previousDefaultBackendId, mutationCounter, transport }) {
  if (!previousDefaultBackendId) {
    return {
      restored: false,
      reason: "No previous default backend was recorded.",
    };
  }
  const router = callTool(REPO_ROOT, {
    tool: "model.router",
    args: {
      action: "configure",
      mutation: createMutation("rollback", "router-configure", mutationCounter),
      enabled: true,
      strategy: "prefer_quality",
      default_backend_id: previousDefaultBackendId,
    },
    transport,
  });
  const maintain = callTool(REPO_ROOT, {
    tool: "autonomy.maintain",
    args: {
      action: "run_once",
      mutation: createMutation("rollback", "maintain", mutationCounter),
      local_host_id: "local",
      ensure_bootstrap: false,
      start_goal_autorun_daemon: false,
      run_goal_hygiene: false,
      run_task_recovery: false,
      start_runtime_workers: false,
      start_task_auto_retry_daemon: false,
      start_transcript_auto_squish_daemon: false,
      start_imprint_auto_snapshot_daemon: false,
      start_trichat_auto_retention_daemon: false,
      start_trichat_turn_watchdog_daemon: false,
      start_reaction_engine_daemon: false,
      refresh_learning_summary: false,
      maintain_tmux_controller: false,
      enable_self_drive: false,
      run_eval_if_due: false,
      run_optimizer_if_due: false,
      publish_runtime_event: false,
    },
    transport,
  });
  return {
    restored: true,
    router,
    maintain,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadRunnerEnv(REPO_ROOT);
  const { manifestPath, manifest } = resolveManifest(args.manifestPath);
  const { registrationPath, registration } = resolveRegistration(manifest, args.registrationPath);
  const lock = await acquireRunnerSingletonLock(
    REPO_ROOT,
    `local-adapter-cutover-${String(manifest.candidate_id || "candidate").replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`,
    5000
  );
  if (!lock.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, skipped: true, reason: "already_running", candidate_id: manifest.candidate_id }, null, 2)}\n`
    );
    return;
  }

  try {
    const candidate = resolveCutoverCandidate(manifest, registration);
    if (!candidate.ok) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, reason: candidate.reason, manifest_path: manifestPath, registration_path: registrationPath }, null, 2)}\n`
      );
      process.exit(1);
    }

    const transport =
      args.transport === "http" ? "http" : args.transport === "stdio" ? "stdio" : resolveTransport(REPO_ROOT);
    const mutationCounter = { value: 0 };
    const routerBefore = callTool(REPO_ROOT, {
      tool: "model.router",
      args: { action: "status" },
      transport,
    });
    const previousDefaultBackendId = readString(routerBefore?.state?.default_backend_id);
    if (previousDefaultBackendId === candidate.backend_id) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            skipped: true,
            reason: "already_default",
            manifest_path: manifestPath,
            registration_path: registrationPath,
            candidate_backend_id: candidate.backend_id,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const previousEnv = readEnvSnapshot(["TRICHAT_OLLAMA_MODEL", "TRICHAT_LOCAL_INFERENCE_PROVIDER"]);
    if (candidate.target === "ollama" && candidate.model_id) {
      setEnvValues({
        TRICHAT_OLLAMA_MODEL: candidate.model_id,
        TRICHAT_LOCAL_INFERENCE_PROVIDER: "auto",
      });
    }

    try {
      const preflightEval = callTool(REPO_ROOT, {
        tool: "eval.run",
        args: {
          mutation: createMutation(manifest.candidate_id, "preflight-eval", mutationCounter),
          suite_id: candidate.eval_suite_id,
          candidate_label: candidate.backend_id,
        },
        transport,
      });
      if (preflightEval?.ok !== true) {
        throw new Error("The accepted adapter did not clear its pre-cutover eval gate.");
      }

      const routerConfigure = callTool(REPO_ROOT, {
        tool: "model.router",
        args: {
          action: "configure",
          mutation: createMutation(manifest.candidate_id, "router-configure", mutationCounter),
          enabled: true,
          strategy: "prefer_quality",
          default_backend_id: candidate.backend_id,
        },
        transport,
      });
      const maintain = callTool(REPO_ROOT, {
        tool: "autonomy.maintain",
        args: {
          action: "run_once",
          mutation: createMutation(manifest.candidate_id, "maintain", mutationCounter),
          local_host_id: "local",
          ensure_bootstrap: false,
          start_goal_autorun_daemon: false,
          run_goal_hygiene: false,
          run_task_recovery: false,
          start_runtime_workers: false,
          start_task_auto_retry_daemon: false,
          start_transcript_auto_squish_daemon: false,
          start_imprint_auto_snapshot_daemon: false,
          start_trichat_auto_retention_daemon: false,
          start_trichat_turn_watchdog_daemon: false,
          start_reaction_engine_daemon: false,
          refresh_learning_summary: false,
          maintain_tmux_controller: false,
          enable_self_drive: false,
          run_eval_if_due: false,
          run_optimizer_if_due: false,
          publish_runtime_event: false,
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
      const postEval = callTool(REPO_ROOT, {
        tool: "eval.run",
        args: {
          mutation: createMutation(manifest.candidate_id, "post-cutover-eval", mutationCounter),
          suite_id: candidate.eval_suite_id,
          candidate_label: candidate.backend_id,
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
        evalResult: postEval,
        bootstrapStatus,
      });
      if (!verification.ok) {
        throw new Error("Cutover verification failed after the router default changed.");
      }

      const result = {
        ok: true,
        promoted: true,
        target: candidate.target,
        cutover_at: new Date().toISOString(),
        previous_default_backend_id: previousDefaultBackendId,
        active_default_backend_id: candidate.backend_id,
        model_id: candidate.model_id,
        endpoint: candidate.endpoint,
        preflight_eval: {
          run_id: preflightEval?.run_id ?? null,
          aggregate_metric_value: preflightEval?.aggregate_metric_value ?? null,
        },
        router_configure: {
          default_backend_id: routerConfigure?.state?.default_backend_id ?? candidate.backend_id,
        },
        maintain: {
          ok: maintain?.ok ?? true,
        },
        post_cutover_eval: {
          run_id: postEval?.run_id ?? null,
          aggregate_metric_value: postEval?.aggregate_metric_value ?? null,
        },
        verification: verification.verification,
      };

      manifest.cutover_result = result;
      manifest.status = candidate.target === "mlx" ? "adapter_primary_mlx" : "adapter_primary_ollama";
      manifest.next_action =
        "The adapter is now the router default. Keep benchmarking it against the prior default and roll back if the live route regresses.";
      writeJson(manifestPath, manifest);

      registration.cutover_result = result;
      writeJson(registrationPath, registration);

      updateRegistry(manifest, manifestPath, {
        status: manifest.status,
        cutover_status: manifest.status,
        cutover_at: result.cutover_at,
        cutover_backend_id: candidate.backend_id,
        previous_default_backend_id: previousDefaultBackendId,
      });

      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            manifest_path: manifestPath,
            registration_path: registrationPath,
            cutover_result: result,
          },
          null,
          2
        )}\n`
      );
    } catch (error) {
      if (candidate.target === "ollama") {
        setEnvValues(previousEnv);
      }
      const rollback = rollbackRouterDefault({
        previousDefaultBackendId,
        mutationCounter,
        transport,
      });
      manifest.cutover_result = {
        ok: false,
        promoted: false,
        cutover_at: new Date().toISOString(),
        attempted_backend_id: candidate.backend_id,
        previous_default_backend_id: previousDefaultBackendId,
        rollback,
        error: error instanceof Error ? error.message : String(error),
      };
      manifest.next_action =
        "The cutover failed verification and the previous default was restored. Inspect the cutover result before retrying.";
      writeJson(manifestPath, manifest);
      registration.cutover_result = manifest.cutover_result;
      writeJson(registrationPath, registration);
      updateRegistry(manifest, manifestPath, {
        cutover_status: "rollback_restored",
        previous_default_backend_id: previousDefaultBackendId,
      });
      throw error;
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
