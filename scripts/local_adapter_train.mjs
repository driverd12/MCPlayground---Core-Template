#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertPreparedDataset, detectAdapterArtifacts, detectTrainerAvailability } from "./local_adapter_lane.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const TRAINING_ROOT = path.join(REPO_ROOT, "data", "training", "local_adapter_lane");

const DEFAULT_COMPANION_MODEL_REF = "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit";
const DEFAULT_ITERS = 12;
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_NUM_LAYERS = 8;
const DEFAULT_LEARNING_RATE = 1e-5;
const DEFAULT_MAX_SEQ_LENGTH = 1024;
const DEFAULT_STEPS_PER_EVAL = 4;
const DEFAULT_STEPS_PER_REPORT = 1;
const DEFAULT_SAVE_EVERY = 4;
const DEFAULT_GRAD_ACCUMULATION_STEPS = 4;
const DEFAULT_SEED = 7;

function parseIntArg(value, fallback, min = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function parseFloatArg(value, fallback, min = 0) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed <= min) {
    return fallback;
  }
  return parsed;
}

function parseBooleanArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    modelRef: "",
    iters: DEFAULT_ITERS,
    batchSize: DEFAULT_BATCH_SIZE,
    numLayers: DEFAULT_NUM_LAYERS,
    learningRate: DEFAULT_LEARNING_RATE,
    maxSeqLength: DEFAULT_MAX_SEQ_LENGTH,
    stepsPerEval: DEFAULT_STEPS_PER_EVAL,
    stepsPerReport: DEFAULT_STEPS_PER_REPORT,
    saveEvery: DEFAULT_SAVE_EVERY,
    gradAccumulationSteps: DEFAULT_GRAD_ACCUMULATION_STEPS,
    seed: DEFAULT_SEED,
    dryRun: false,
    skipGenerate: false,
    gradCheckpoint: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--manifest":
        args.manifestPath = argv[++index] ?? "";
        break;
      case "--model-ref":
        args.modelRef = argv[++index] ?? "";
        break;
      case "--iters":
        args.iters = parseIntArg(argv[++index], DEFAULT_ITERS);
        break;
      case "--batch-size":
        args.batchSize = parseIntArg(argv[++index], DEFAULT_BATCH_SIZE);
        break;
      case "--num-layers":
        args.numLayers = parseIntArg(argv[++index], DEFAULT_NUM_LAYERS, -1);
        break;
      case "--learning-rate":
        args.learningRate = parseFloatArg(argv[++index], DEFAULT_LEARNING_RATE);
        break;
      case "--max-seq-length":
        args.maxSeqLength = parseIntArg(argv[++index], DEFAULT_MAX_SEQ_LENGTH);
        break;
      case "--steps-per-eval":
        args.stepsPerEval = parseIntArg(argv[++index], DEFAULT_STEPS_PER_EVAL);
        break;
      case "--steps-per-report":
        args.stepsPerReport = parseIntArg(argv[++index], DEFAULT_STEPS_PER_REPORT);
        break;
      case "--save-every":
        args.saveEvery = parseIntArg(argv[++index], DEFAULT_SAVE_EVERY);
        break;
      case "--grad-accumulation-steps":
        args.gradAccumulationSteps = parseIntArg(argv[++index], DEFAULT_GRAD_ACCUMULATION_STEPS);
        break;
      case "--seed":
        args.seed = parseIntArg(argv[++index], DEFAULT_SEED, 0);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-generate":
        args.skipGenerate = true;
        break;
      case "--grad-checkpoint":
        args.gradCheckpoint = true;
        break;
      case "--no-grad-checkpoint":
        args.gradCheckpoint = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_train.mjs [--manifest <path>] [--model-ref <mlx model path or repo>]",
      "",
      "Examples:",
      "  npm run local:training:train",
      "  npm run local:training:train -- --iters 16 --num-layers 8",
      "  npm run local:training:train -- --model-ref mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
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

function readEnvValue(key) {
  try {
    const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) {
        continue;
      }
      const [rawKey, ...rest] = line.split("=");
      if (String(rawKey || "").trim() === key) {
        return rest.join("=").trim() || null;
      }
    }
  } catch {}
  return null;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 4 * 60 * 60 * 1000,
    ...options,
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function latestManifestPath() {
  const registry = readJson(REGISTRY_PATH);
  const latest = Array.isArray(registry?.runs) ? registry.runs[0] : null;
  if (latest?.manifest_path && fs.existsSync(latest.manifest_path)) {
    return latest.manifest_path;
  }
  const candidates = fs
    .readdirSync(TRAINING_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(TRAINING_ROOT, entry.name, "manifest.json"))
    .filter((entry) => fs.existsSync(entry))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

function normalizeModelCacheRoot(modelRef) {
  const [owner, name] = String(modelRef || "").split("/");
  if (!owner || !name) {
    return null;
  }
  return path.join(os.homedir(), ".cache", "huggingface", "hub", `models--${owner}--${name}`);
}

function resolveCachedSnapshot(modelRef) {
  const cacheRoot = normalizeModelCacheRoot(modelRef);
  if (!cacheRoot || !fs.existsSync(cacheRoot)) {
    return null;
  }
  const refsMain = path.join(cacheRoot, "refs", "main");
  if (fs.existsSync(refsMain)) {
    const ref = String(fs.readFileSync(refsMain, "utf8") || "").trim();
    const snapshotPath = path.join(cacheRoot, "snapshots", ref);
    if (ref && fs.existsSync(snapshotPath)) {
      return snapshotPath;
    }
  }
  const snapshotRoot = path.join(cacheRoot, "snapshots");
  if (!fs.existsSync(snapshotRoot)) {
    return null;
  }
  const snapshots = fs
    .readdirSync(snapshotRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(snapshotRoot, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return snapshots[0] ?? null;
}

export function resolveTrainingModelRef(input = {}) {
  const requested =
    String(
      input.modelRef ||
        readEnvValue("TRICHAT_LOCAL_TRAINING_MODEL_REF") ||
        process.env.TRICHAT_LOCAL_TRAINING_MODEL_REF ||
        DEFAULT_COMPANION_MODEL_REF
    ).trim() || DEFAULT_COMPANION_MODEL_REF;
  if (requested.startsWith("/") && fs.existsSync(requested)) {
    return {
      requested_model_ref: requested,
      resolved_model_ref: requested,
      resolved_model_path: requested,
      resolution_source: "explicit_path",
      companion_for_runtime_model: input.runtimeModel ?? null,
    };
  }
  const cachedSnapshot = resolveCachedSnapshot(requested);
  return {
    requested_model_ref: requested,
    resolved_model_ref: requested,
    resolved_model_path: cachedSnapshot,
    resolution_source: cachedSnapshot ? "huggingface_cache" : "huggingface_repo",
    companion_for_runtime_model: input.runtimeModel ?? null,
  };
}

function materializeDatasetDir(runDir, manifest) {
  const datasetDir = path.join(runDir, "mlx_dataset");
  const trainSource = String(manifest?.corpus?.train_path || "").trim();
  const evalSource = String(manifest?.corpus?.eval_path || "").trim();
  if (!trainSource || !fs.existsSync(trainSource)) {
    throw new Error(`Training set missing at ${trainSource || "<empty>"}`);
  }
  if (!evalSource || !fs.existsSync(evalSource)) {
    throw new Error(`Eval set missing at ${evalSource || "<empty>"}`);
  }
  ensureDirectory(datasetDir);
  const trainTarget = path.join(datasetDir, "train.jsonl");
  const validTarget = path.join(datasetDir, "valid.jsonl");
  const testTarget = path.join(datasetDir, "test.jsonl");
  fs.copyFileSync(trainSource, trainTarget);
  fs.copyFileSync(evalSource, validTarget);
  fs.copyFileSync(evalSource, testTarget);
  return {
    dataset_dir: datasetDir,
    train_path: trainTarget,
    valid_path: validTarget,
    test_path: testTarget,
  };
}

export function parseTrainingLog(text) {
  const lines = String(text || "").split(/\r?\n/);
  const trainLosses = [];
  const valLosses = [];
  let testLoss = null;
  let testPpl = null;
  for (const line of lines) {
    const trainMatch = line.match(/Train loss\s+([0-9.]+)/i);
    if (trainMatch) {
      trainLosses.push(Number.parseFloat(trainMatch[1]));
    }
    const valMatch = line.match(/Val loss\s+([0-9.]+)/i);
    if (valMatch) {
      valLosses.push(Number.parseFloat(valMatch[1]));
    }
    const testMatch = line.match(/Test loss\s+([0-9.]+),\s*Test ppl\s+([0-9.]+)/i);
    if (testMatch) {
      testLoss = Number.parseFloat(testMatch[1]);
      testPpl = Number.parseFloat(testMatch[2]);
    }
  }
  return {
    train_loss_points: trainLosses.filter(Number.isFinite),
    val_loss_points: valLosses.filter(Number.isFinite),
    final_train_loss: trainLosses.filter(Number.isFinite).at(-1) ?? null,
    final_val_loss: valLosses.filter(Number.isFinite).at(-1) ?? null,
    test_loss: Number.isFinite(testLoss) ? testLoss : null,
    test_ppl: Number.isFinite(testPpl) ? testPpl : null,
  };
}

function runGenerateSmoke({ pythonPath, modelPath, adapterPath }) {
  const generator = path.join(path.dirname(pythonPath), "mlx_lm.generate");
  const prompt = "List exactly two high-priority hardening tasks for a local-first MCP control plane.";
  const result = runCapture(generator, [
    "--model",
    modelPath,
    "--adapter-path",
    adapterPath,
    "--prompt",
    prompt,
    "--max-tokens",
    "96",
    "--temp",
    "0",
    "--verbose",
    "False",
  ], { timeoutMs: 120000 });
  return {
    ok: result.ok && String(result.stdout || "").trim().length > 0,
    prompt,
    output: String(result.stdout || "").trim() || null,
    error: result.ok ? null : String(result.stderr || result.error || "").trim() || "generation_failed",
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
    runs: nextRuns,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifestPath || latestManifestPath();
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error("No prepared local adapter packet exists. Run `npm run local:training:prepare` first.");
  }

  const manifest = readJson(manifestPath);
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Could not read manifest at ${manifestPath}`);
  }
  assertPreparedDataset(manifest);
  const runDir = path.dirname(manifestPath);
  const trainer = detectTrainerAvailability();
  if (trainer.trainer_ready !== true || !trainer.python_path) {
    throw new Error("Local MLX trainer backend is not ready. Run `npm run local:training:bootstrap` first.");
  }

  const trainingModel = resolveTrainingModelRef({
    modelRef: args.modelRef,
    runtimeModel: manifest.base_model,
  });
  const modelPath = trainingModel.resolved_model_path || trainingModel.resolved_model_ref;
  if (!modelPath) {
    throw new Error("Could not resolve a training model reference.");
  }

  const dataset = materializeDatasetDir(runDir, manifest);
  const adapterPath = path.join(runDir, "adapter");
  const stdoutLogPath = path.join(runDir, "training.stdout.log");
  const stderrLogPath = path.join(runDir, "training.stderr.log");
  const metricsPath = path.join(adapterPath, "training_metrics.json");

  const cliArgs = [
    path.join(path.dirname(trainer.python_path), "mlx_lm.lora"),
    "--model",
    modelPath,
    "--train",
    "--test",
    "--data",
    dataset.dataset_dir,
    "--adapter-path",
    adapterPath,
    "--iters",
    String(args.iters),
    "--batch-size",
    String(args.batchSize),
    "--learning-rate",
    String(args.learningRate),
    "--steps-per-report",
    String(args.stepsPerReport),
    "--steps-per-eval",
    String(args.stepsPerEval),
    "--save-every",
    String(args.saveEvery),
    "--max-seq-length",
    String(args.maxSeqLength),
    "--num-layers",
    String(args.numLayers),
    "--grad-accumulation-steps",
    String(args.gradAccumulationSteps),
    "--seed",
    String(args.seed),
  ];
  if (args.gradCheckpoint) {
    cliArgs.push("--grad-checkpoint");
  }

  const now = new Date().toISOString();
  const baseMetrics = {
    generated_at: now,
    manifest_path: manifestPath,
    run_id: manifest.run_id,
    candidate_id: manifest.candidate_id,
    runtime_model: manifest.base_model,
    training_model: trainingModel,
    dataset,
    command: {
      executable: trainer.python_path,
      argv: cliArgs,
      dry_run: args.dryRun,
    },
  };

  if (args.dryRun) {
    const dryRunPayload = {
      ok: true,
      dry_run: true,
      ...baseMetrics,
    };
    process.stdout.write(`${JSON.stringify(dryRunPayload, null, 2)}\n`);
    return;
  }

  ensureDirectory(adapterPath);
  const startedAt = Date.now();
  const result = runCapture(trainer.python_path, cliArgs, {
    timeoutMs: 4 * 60 * 60 * 1000,
    env: {
      ...process.env,
      TOKENIZERS_PARALLELISM: "true",
    },
  });
  fs.writeFileSync(stdoutLogPath, result.stdout, "utf8");
  fs.writeFileSync(stderrLogPath, result.stderr, "utf8");
  const parsedMetrics = parseTrainingLog(`${result.stdout}\n${result.stderr}`);
  const initialArtifacts = detectAdapterArtifacts(adapterPath);
  const generateSmoke = args.skipGenerate
    ? { ok: false, skipped: true, reason: "skip_generate" }
    : runGenerateSmoke({
        pythonPath: trainer.python_path,
        modelPath,
        adapterPath,
      });
  const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  let metricsPayload = {
    ok: false,
    ...baseMetrics,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_seconds: durationSeconds,
    exit_code: result.status,
    stdout_log_path: stdoutLogPath,
    stderr_log_path: stderrLogPath,
    parsed_metrics: parsedMetrics,
    artifacts: initialArtifacts,
    generate_smoke: generateSmoke,
    error: result.ok ? null : String(result.stderr || result.error || "").trim() || "training_failed",
  };
  writeJson(metricsPath, metricsPayload);
  const artifacts = detectAdapterArtifacts(adapterPath);
  const trainingSucceeded = result.ok && artifacts.all_present && generateSmoke.ok;
  metricsPayload = {
    ...metricsPayload,
    ok: trainingSucceeded,
    artifacts,
  };
  writeJson(metricsPath, metricsPayload);

  manifest.training_target = trainingModel;
  manifest.training_intent = {
    ...(manifest.training_intent || {}),
    executed: true,
    executed_at: metricsPayload.finished_at,
    weights_modified: artifacts.all_present,
    command_wired: true,
    train_command: "npm run local:training:train",
    command_source: "scripts/local_adapter_train.mjs",
  };
  manifest.artifacts = artifacts;
  manifest.training_result = {
    status: trainingSucceeded ? "adapter_trained_unpromoted" : "training_failed",
    adapter_path: adapterPath,
    training_metrics_path: metricsPath,
    stdout_log_path: stdoutLogPath,
    stderr_log_path: stderrLogPath,
    generate_smoke: generateSmoke,
  };
  manifest.safe_promotion_metadata = {
    ...(manifest.safe_promotion_metadata || {}),
    allowed_now: false,
    blockers: [
      ...(artifacts.all_present ? [] : ["adapter_artifacts_missing"]),
      ...(generateSmoke.ok ? [] : ["adapter_generate_smoke_failed"]),
      "adapter_eval_pending",
      "mlx_adapter_runtime_not_integrated",
      "ollama_adapter_export_not_implemented",
    ],
  };
  manifest.status = trainingSucceeded ? "adapter_trained_unpromoted" : "training_failed";
  manifest.next_action = trainingSucceeded
    ? "Run a bounded eval-and-route integration pass before promoting this adapter into any live local runtime."
    : "Inspect the training logs, adjust the bounded MLX runner, and rerun `npm run local:training:train`.";
  writeJson(manifestPath, manifest);

  updateRegistry(manifest, manifestPath, {
    status: manifest.status,
    training_model_ref: trainingModel.resolved_model_ref,
    training_model_path: trainingModel.resolved_model_path,
    adapter_path: adapterPath,
    training_metrics_path: metricsPath,
    training_executed: true,
    training_exit_code: result.status,
    artifacts_present: artifacts.present.map((entry) => entry.artifact),
    weights_modified: artifacts.all_present,
    training_generate_smoke_ok: generateSmoke.ok === true,
  });

  process.stdout.write(`${JSON.stringify(metricsPayload, null, 2)}\n`);
  if (!trainingSucceeded) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  }
}
