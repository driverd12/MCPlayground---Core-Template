#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  acquireRunnerSingletonLock,
  callTool,
  loadRunnerEnv,
  repoRootFromMeta,
} from "./mcp_runner_support.mjs";
import {
  buildIntegrationConsideration,
  buildOllamaCompanionName,
} from "./local_adapter_promote.mjs";

const REPO_ROOT = repoRootFromMeta(import.meta.url);
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const DEFAULT_MLX_ENDPOINT = "http://127.0.0.1:8788";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const ENV_PATH = path.join(REPO_ROOT, ".env");

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    registrationPath: "",
    target: "auto",
    transport: "stdio",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[++index] ?? "";
    } else if (token === "--registration") {
      args.registrationPath = argv[++index] ?? "";
    } else if (token === "--target") {
      args.target = argv[++index] ?? "auto";
    } else if (token === "--transport") {
      args.transport = argv[++index] ?? "stdio";
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!["auto", "mlx", "ollama"].includes(args.target)) {
    throw new Error(`Unsupported target: ${args.target}`);
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_integrate.mjs [--manifest <path>] [--registration <path>] [--target auto|mlx|ollama]",
      "",
      "Notes:",
      "  This materializes a registered adapter as a real MLX backend or an exported Ollama companion, then verifies it live.",
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
    throw new Error("No local adapter manifest found. Run prepare, train, and promote first.");
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

function commandExists(command) {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(whichCommand, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
    }
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function probeMlxBackend({ endpoint, modelId, timeoutMs = 120_000 }) {
  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`${endpoint}/health`, { method: "GET" }, 4000);
      const models = await fetchJson(`${endpoint}/v1/models`, { method: "GET" }, 4000);
      const ids = Array.isArray(models?.data)
        ? models.data
            .map((entry) => readString(entry?.id))
            .filter((entry) => Boolean(entry))
        : [];
      const generate = await fetchJson(
        `${endpoint}/v1/chat/completions`,
        {
          method: "POST",
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "Respond with the single word: ready" }],
            temperature: 0,
            max_tokens: 8,
            stream: false,
          }),
        },
        20_000
      );
      return {
        ok: true,
        endpoint,
        model_id: modelId,
        model_known: ids.includes(modelId),
        known_models: ids,
        response_preview: readString(generate?.choices?.[0]?.message?.content) || null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(1000);
    }
  }
  return {
    ok: false,
    endpoint,
    model_id: modelId,
    error: lastError || "mlx_probe_failed",
  };
}

async function probeOllamaModel({ endpoint, modelId, timeoutMs = 120_000 }) {
  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`${endpoint}/api/version`, { method: "GET" }, 4000);
      const tags = await fetchJson(`${endpoint}/api/tags`, { method: "GET" }, 4000);
      const known = Array.isArray(tags?.models)
        ? tags.models.map((entry) => readString(entry?.name) || readString(entry?.model)).filter(Boolean)
        : [];
      const generate = await fetchJson(
        `${endpoint}/api/generate`,
        {
          method: "POST",
          body: JSON.stringify({
            model: modelId,
            prompt: "Respond with the single word: ready",
            options: {
              temperature: 0,
              num_predict: 8,
            },
            stream: false,
          }),
        },
        30_000
      );
      return {
        ok: true,
        endpoint,
        model_id: modelId,
        model_known: known.includes(modelId),
        known_models: known,
        response_preview: readString(generate?.response) || null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(1000);
    }
  }
  return {
    ok: false,
    endpoint,
    model_id: modelId,
    error: lastError || "ollama_probe_failed",
  };
}

function createMutation(candidateId, step, counter) {
  const id = `${candidateId}:${step}:${counter.value++}`;
  return {
    idempotency_key: `local-adapter-integrate:${id}`,
    side_effect_fingerprint: `local-adapter-integrate:${id}`,
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

export function resolveIntegrationTarget(manifest, registration, forcedTarget = "auto") {
  const consideration =
    registration?.decision?.integration_consideration || buildIntegrationConsideration(manifest, { status: "registered" });
  const recommended =
    readString(consideration?.recommended_target) ||
    (consideration?.router?.eligible === true
      ? "mlx"
      : consideration?.ollama?.eligible === true
        ? "ollama"
        : null);
  const requested = forcedTarget === "auto" ? recommended : forcedTarget;
  if (!requested) {
    return {
      ok: false,
      target: null,
      reason: "No supported integration target is currently eligible for this adapter.",
      consideration,
    };
  }
  if (requested === "mlx" && consideration?.router?.eligible !== true) {
    return {
      ok: false,
      target: "mlx",
      reason: (consideration?.router?.blockers || []).join(",") || "mlx_ineligible",
      consideration,
    };
  }
  if (requested === "ollama" && consideration?.ollama?.eligible !== true) {
    return {
      ok: false,
      target: "ollama",
      reason: (consideration?.ollama?.blockers || []).join(",") || "ollama_ineligible",
      consideration,
    };
  }
  return {
    ok: true,
    target: requested,
    reason: null,
    consideration,
  };
}

export function buildOllamaModelfile({ baseModelPath, adapterPath }) {
  return `FROM ${baseModelPath}\nADAPTER ${adapterPath}\n`;
}

async function runMlxIntegration({ manifest, registration, registrationPath, integrationDir, transport }) {
  const plannedBackend = registration.decision.integration_consideration.router.planned_backend;
  const endpoint = String(process.env.TRICHAT_MLX_ENDPOINT || DEFAULT_MLX_ENDPOINT).trim().replace(/\/+$/, "");
  const modelId = String(plannedBackend.model_id || manifest.training_target?.resolved_model_ref || "").trim();
  const adapterPath = String(manifest.training_result?.adapter_path || "").trim();
  const trainerPython = String(manifest.trainer?.python_path || process.env.TRICHAT_MLX_PYTHON || "").trim();
  if (!trainerPython) {
    throw new Error("No MLX python runtime is configured for adapter serving.");
  }
  const serverHelp = runCapture(trainerPython, ["-m", "mlx_lm.server", "--help"], {
    timeoutMs: 15_000,
  });
  if (!serverHelp.ok || !serverHelp.stdout.includes("--adapter-path")) {
    throw new Error("The configured MLX server runtime does not support --adapter-path.");
  }

  const previousEnv = readEnvSnapshot([
    "TRICHAT_MLX_SERVER_ENABLED",
    "TRICHAT_MLX_ENDPOINT",
    "TRICHAT_MLX_MODEL",
    "TRICHAT_MLX_PYTHON",
    "TRICHAT_MLX_ADAPTER_PATH",
    "TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH",
    "TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER",
    "TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL",
  ]);
  try {
    setEnvValues({
      TRICHAT_MLX_SERVER_ENABLED: "1",
      TRICHAT_MLX_ENDPOINT: endpoint,
      TRICHAT_MLX_MODEL: modelId,
      TRICHAT_MLX_PYTHON: trainerPython,
      TRICHAT_MLX_ADAPTER_PATH: adapterPath,
      TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH: registrationPath,
      TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER: "mlx",
      TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL: null,
    });

    const launchdInstall = runCapture("bash", [path.join(REPO_ROOT, "scripts", "launchd_install.sh")], {
      timeoutMs: 10 * 60 * 1000,
    });
    if (!launchdInstall.ok) {
      throw new Error(`launchd_install failed: ${launchdInstall.stderr || launchdInstall.stdout || launchdInstall.error}`);
    }

    const probe = await probeMlxBackend({
      endpoint,
      modelId,
      timeoutMs: 180_000,
    });
    if (!probe.ok || probe.model_known !== true) {
      throw new Error(`MLX adapter backend did not become healthy: ${probe.error || "model_not_known"}`);
    }

    loadRunnerEnv(REPO_ROOT);
    const mutationCounter = { value: 0 };
    const bootstrap = callTool(REPO_ROOT, {
      tool: "autonomy.bootstrap",
      args: {
        action: "ensure",
        mutation: createMutation(manifest.candidate_id, "bootstrap", mutationCounter),
        local_host_id: "local",
        run_immediately: false,
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
    const routerStatus = callTool(REPO_ROOT, {
      tool: "model.router",
      args: { action: "status" },
      transport,
    });

    const backend = Array.isArray(routerStatus?.state?.backends)
      ? routerStatus.state.backends.find((entry) => String(entry?.backend_id || "") === plannedBackend.backend_id)
      : null;
    if (!backend) {
      throw new Error(`Integrated MLX backend ${plannedBackend.backend_id} was not persisted into model.router.`);
    }

    const result = {
      ok: true,
      target: "mlx",
      integrated_at: new Date().toISOString(),
      backend_id: plannedBackend.backend_id,
      model_id: modelId,
      endpoint,
      adapter_path: adapterPath,
      env_updates: {
        TRICHAT_MLX_SERVER_ENABLED: "1",
        TRICHAT_MLX_ENDPOINT: endpoint,
        TRICHAT_MLX_MODEL: modelId,
        TRICHAT_MLX_ADAPTER_PATH: adapterPath,
        TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH: registrationPath,
        TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER: "mlx",
      },
      launchd_install: {
        ok: launchdInstall.ok,
        stdout_log_path: path.join(integrationDir, "launchd_install.stdout.log"),
        stderr_log_path: path.join(integrationDir, "launchd_install.stderr.log"),
      },
      probe,
      bootstrap,
      maintain,
      router_backend: {
        backend_id: backend.backend_id,
        tags: backend.tags,
        success_rate: backend.success_rate ?? null,
        latency_ms_p50: backend.latency_ms_p50 ?? null,
        throughput_tps: backend.throughput_tps ?? null,
        metadata: backend.metadata ?? {},
        capabilities: backend.capabilities ?? {},
      },
    };
    fs.writeFileSync(result.launchd_install.stdout_log_path, launchdInstall.stdout, "utf8");
    fs.writeFileSync(result.launchd_install.stderr_log_path, launchdInstall.stderr, "utf8");
    return result;
  } catch (error) {
    setEnvValues(previousEnv);
    runCapture("bash", [path.join(REPO_ROOT, "scripts", "launchd_install.sh")], { timeoutMs: 10 * 60 * 1000 });
    throw error;
  }
}

async function runOllamaIntegration({ manifest, registration, registrationPath, runDir, transport }) {
  const plannedBackend = registration.decision.integration_consideration.ollama.planned_backend;
  const endpoint = String(process.env.TRICHAT_OLLAMA_URL || DEFAULT_OLLAMA_ENDPOINT).trim().replace(/\/+$/, "");
  const modelId = String(plannedBackend.model_id || buildOllamaCompanionName(manifest)).trim();
  const adapterPath = String(manifest.training_result?.adapter_path || "").trim();
  const sourceModelPath = String(
    manifest.training_target?.resolved_model_path || plannedBackend?.metadata?.source_model_path || ""
  ).trim();
  if (!commandExists("ollama")) {
    throw new Error("The ollama CLI is not installed, so a companion export cannot be created.");
  }
  const previousEnv = readEnvSnapshot([
    "TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH",
    "TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER",
    "TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL",
  ]);
  const integrationDir = path.join(runDir, "integration", "ollama");
  ensureDirectory(integrationDir);
  const modelfilePath = path.join(integrationDir, "Modelfile");
  let createdModel = false;
  try {
    fs.writeFileSync(modelfilePath, buildOllamaModelfile({ baseModelPath: sourceModelPath, adapterPath }), "utf8");
    const create = runCapture("ollama", ["create", modelId], {
      cwd: integrationDir,
      timeoutMs: 30 * 60 * 1000,
    });
    fs.writeFileSync(path.join(integrationDir, "ollama-create.stdout.log"), create.stdout, "utf8");
    fs.writeFileSync(path.join(integrationDir, "ollama-create.stderr.log"), create.stderr, "utf8");
    if (!create.ok) {
      throw new Error(`ollama create failed: ${create.stderr || create.stdout || create.error}`);
    }
    createdModel = true;

    setEnvValues({
      TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH: registrationPath,
      TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER: "ollama",
      TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL: modelId,
    });

    const probe = await probeOllamaModel({
      endpoint,
      modelId,
      timeoutMs: 180_000,
    });
    if (!probe.ok || probe.model_known !== true) {
      throw new Error(`Ollama companion export did not become healthy: ${probe.error || "model_not_known"}`);
    }

    loadRunnerEnv(REPO_ROOT);
    const mutationCounter = { value: 0 };
    const bootstrap = callTool(REPO_ROOT, {
      tool: "autonomy.bootstrap",
      args: {
        action: "ensure",
        mutation: createMutation(manifest.candidate_id, "bootstrap", mutationCounter),
        local_host_id: "local",
        run_immediately: false,
        probe_ollama_url: endpoint,
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
        probe_ollama_url: endpoint,
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
    const routerStatus = callTool(REPO_ROOT, {
      tool: "model.router",
      args: { action: "status" },
      transport,
    });
    const backend = Array.isArray(routerStatus?.state?.backends)
      ? routerStatus.state.backends.find((entry) => String(entry?.backend_id || "") === plannedBackend.backend_id)
      : null;
    if (!backend) {
      throw new Error(`Integrated Ollama backend ${plannedBackend.backend_id} was not persisted into model.router.`);
    }

    return {
      ok: true,
      target: "ollama",
      integrated_at: new Date().toISOString(),
      backend_id: plannedBackend.backend_id,
      model_id: modelId,
      endpoint,
      adapter_path: adapterPath,
      source_model_path: sourceModelPath,
      modelfile_path: modelfilePath,
      probe,
      bootstrap,
      maintain,
      router_backend: {
        backend_id: backend.backend_id,
        tags: backend.tags,
        success_rate: backend.success_rate ?? null,
        latency_ms_p50: backend.latency_ms_p50 ?? null,
        throughput_tps: backend.throughput_tps ?? null,
        metadata: backend.metadata ?? {},
        capabilities: backend.capabilities ?? {},
      },
      env_updates: {
        TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH: registrationPath,
        TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER: "ollama",
        TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL: modelId,
      },
    };
  } catch (error) {
    if (createdModel) {
      runCapture("ollama", ["rm", modelId], { timeoutMs: 60_000 });
    }
    setEnvValues(previousEnv);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadRunnerEnv(REPO_ROOT);
  const { manifestPath, manifest, runDir } = resolveManifest(args.manifestPath);
  const { registrationPath, registration } = resolveRegistration(manifest, args.registrationPath);
  const lock = await acquireRunnerSingletonLock(
    REPO_ROOT,
    `local-adapter-integrate-${String(manifest.candidate_id || "candidate").replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`,
    5000
  );
  if (!lock.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, skipped: true, reason: "already_running", candidate_id: manifest.candidate_id }, null, 2)}\n`
    );
    return;
  }

  try {
    const decision = resolveIntegrationTarget(manifest, registration, args.target);
    if (!decision.ok) {
      const blocked = {
        ok: false,
        target: decision.target,
        reason: decision.reason,
        consideration: decision.consideration,
        manifest_path: manifestPath,
        registration_path: registrationPath,
      };
      process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
      process.exit(1);
    }

    const integrationDir = path.join(runDir, "integration");
    ensureDirectory(integrationDir);
    const transport = args.transport === "http" ? "http" : "stdio";
    const result =
      decision.target === "mlx"
        ? await runMlxIntegration({
            manifest,
            registration,
            registrationPath,
            integrationDir,
            transport,
          })
        : await runOllamaIntegration({
            manifest,
            registration,
            registrationPath,
            runDir,
            transport,
          });

    manifest.integration_result = result;
    manifest.status = decision.target === "mlx" ? "adapter_served_mlx" : "adapter_exported_ollama";
    manifest.safe_promotion_metadata = {
      ...(manifest.safe_promotion_metadata || {}),
      allowed_now: true,
      blockers: [],
    };
    manifest.next_action =
      "The accepted adapter is now a reachable local backend. Keep it non-primary until a separate cutover decision is made.";
    writeJson(manifestPath, manifest);

    registration.integration_result = result;
    registration.decision.integration_consideration.router.live_ready =
      decision.target === "mlx" ? true : registration.decision.integration_consideration.router.live_ready;
    registration.decision.integration_consideration.ollama.live_ready =
      decision.target === "ollama" ? true : registration.decision.integration_consideration.ollama.live_ready;
    if (decision.target === "mlx") {
      registration.decision.integration_consideration.router.blockers = [];
      registration.decision.integration_consideration.router.planned_backend.metadata.serving_status = "integrated";
    } else {
      registration.decision.integration_consideration.ollama.blockers = [];
      registration.decision.integration_consideration.ollama.planned_backend.metadata.export_status = "integrated";
    }
    writeJson(registrationPath, registration);

    updateRegistry(manifest, manifestPath, {
      status: manifest.status,
      integration_status: manifest.status,
      integration_target: result.target,
      integration_backend_id: result.backend_id,
      integration_model_id: result.model_id,
      integration_endpoint: result.endpoint,
      registration_path: registrationPath,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          manifest_path: manifestPath,
          registration_path: registrationPath,
          integration_result: result,
        },
        null,
        2
      )}\n`
    );
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
