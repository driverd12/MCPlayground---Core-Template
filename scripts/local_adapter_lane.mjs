#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const SNAPSHOT_DIR = path.join(REPO_ROOT, "data", "imprint", "snapshots");
const REPORT_DIR = path.join(REPO_ROOT, "data", "imprint", "reports");
const TRAINING_ROOT = path.join(REPO_ROOT, "data", "training", "local_adapter_lane");
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const VENV_MLX_PYTHON = path.join(REPO_ROOT, ".venv-mlx", "bin", "python");
const DEFAULT_MODEL = "llama3.2:3b";
const DEFAULT_BENCHMARK_SUITE_ID = "autonomy.smoke.local";
const DEFAULT_EVAL_SUITE_ID = "autonomy.control-plane";
const REGISTRY_SCHEMA_VERSION = "training.model_registry.v2";
const MANIFEST_SCHEMA_VERSION = "local_training_packet.v2";
const DEFAULT_EVAL_FRACTION = 0.2;
const MIN_CORPUS_CHAR_COUNT = 20;
const MIN_CORPUS_WORD_COUNT = 4;
const EXPECTED_ADAPTER_ARTIFACTS = [
  {
    artifact: "adapter_config",
    candidates: ["adapter_config.json"],
  },
  {
    artifact: "adapter_weights",
    candidates: ["adapters.safetensors", "adapter_model.safetensors"],
  },
  {
    artifact: "training_metrics",
    candidates: ["training_metrics.json", "metrics.json"],
  },
];

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
  } catch {
    return null;
  }
  return null;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  return {
    ok: (result.status ?? 1) === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function pythonVersionOk(command) {
  const result = spawnSync(
    command,
    ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }
  );
  return (result.status ?? 1) === 0;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function listNewestFiles(dirPath, suffix, limit) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((entry) => entry.endsWith(suffix))
      .map((entry) => path.join(dirPath, entry))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readPackageJson() {
  return readJson(path.join(REPO_ROOT, "package.json")) || {};
}

function normalizeCorpusText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function wordCount(text) {
  return normalizeCorpusText(text)
    .split(/\s+/)
    .filter(Boolean).length;
}

function fingerprintText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function sanitizeSlug(value, fallback = "candidate") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function buildCandidateId(model, runId) {
  return `local-adapter-${sanitizeSlug(model, "base-model")}-${sanitizeSlug(runId, "run")}`;
}

function sourceTypeCounts(records) {
  const counts = {};
  for (const record of records) {
    const sourceType = String(record?.source_type || "unknown").trim() || "unknown";
    counts[sourceType] = (counts[sourceType] ?? 0) + 1;
  }
  return counts;
}

export function resolveTrainerPython(input = {}) {
  const candidates = [
    input.python_path,
    readEnvValue("TRICHAT_MLX_PYTHON"),
    fs.existsSync(VENV_MLX_PYTHON) ? VENV_MLX_PYTHON : null,
    "/opt/homebrew/bin/python3",
    "python3.12",
    "python3.11",
    "python3",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (pythonVersionOk(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function detectTrainerAvailability(probes = {}) {
  const pythonPath = probes.python_path ?? resolveTrainerPython({ python_path: probes.python_path });
  const python = probes.python ?? (pythonPath ? runCapture(pythonPath, ["--version"]) : { ok: false, stderr: "No suitable Python runtime found." });
  const mlx = probes.mlx ?? (pythonPath ? runCapture(pythonPath, ["-c", "import mlx"]) : { ok: false, stderr: "No suitable Python runtime found." });
  const mlxLm = probes.mlxLm ?? (pythonPath ? runCapture(pythonPath, ["-c", "import mlx_lm"]) : { ok: false, stderr: "No suitable Python runtime found." });
  return {
    python_path: pythonPath,
    python_ok: python.ok,
    mlx_ok: mlx.ok,
    mlx_lm_ok: mlxLm.ok,
    trainer_ready: Boolean(python.ok && mlx.ok && mlxLm.ok),
    backend: python.ok && mlx.ok && mlxLm.ok ? "mlx_lm" : null,
    detail:
      python.ok && mlx.ok && mlxLm.ok
        ? "Local MLX trainer modules are importable."
        : [python.stderr, mlx.stderr, mlxLm.stderr].filter(Boolean)[0] || "Local MLX trainer modules are not fully installed.",
  };
}

export function buildCorpusRecords(snapshotPayload, reportPayloads = []) {
  const records = [];
  const recentMemories = Array.isArray(snapshotPayload?.recent_memories) ? snapshotPayload.recent_memories : [];
  const recentTranscriptLines = Array.isArray(snapshotPayload?.recent_transcript_lines)
    ? snapshotPayload.recent_transcript_lines
    : [];
  for (const memory of recentMemories) {
    const text = String(memory?.content_preview || "").trim();
    if (!text) {
      continue;
    }
    records.push({
      kind: "plain_text_corpus",
      source_type: "recent_memory",
      source_id: memory?.id ?? null,
      text,
    });
  }
  for (const line of recentTranscriptLines) {
    const text = String(line?.content_preview || "").trim();
    if (!text) {
      continue;
    }
    records.push({
      kind: "plain_text_corpus",
      source_type: "recent_transcript_line",
      source_id: line?.id ?? null,
      text,
    });
  }
  for (const report of reportPayloads) {
    const summary = report?.summary;
    if (summary && typeof summary === "object") {
      records.push({
        kind: "plain_text_corpus",
        source_type: "capability_report",
        source_id: String(report?.report_path || report?.generated_at || "report"),
        text: `Local model capability report for ${report?.model || "unknown"}: pass rate ${summary.pass_rate ?? "n/a"}%, avg latency ${summary.average_latency_ms ?? "n/a"} ms, avg throughput ${summary.average_throughput_tps ?? "n/a"} tokens/s.`,
      });
    }
  }
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.source_type}:${record.source_id}:${record.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function curateCorpusRecords(rawRecords = [], options = {}) {
  const minCharCount = Math.max(1, Math.trunc(options.min_char_count ?? MIN_CORPUS_CHAR_COUNT));
  const minWordCount = Math.max(1, Math.trunc(options.min_word_count ?? MIN_CORPUS_WORD_COUNT));
  const accepted = [];
  const stats = {
    input_records: 0,
    accepted_records: 0,
    rejected_empty: 0,
    rejected_too_short: 0,
    rejected_duplicate: 0,
    min_char_count: minCharCount,
    min_word_count: minWordCount,
    source_type_breakdown: {},
  };
  const seen = new Set();
  for (const record of Array.isArray(rawRecords) ? rawRecords : []) {
    stats.input_records += 1;
    const sourceType = String(record?.source_type || "unknown").trim() || "unknown";
    stats.source_type_breakdown[sourceType] = (stats.source_type_breakdown[sourceType] ?? 0) + 1;
    const text = normalizeCorpusText(record?.text);
    if (!text) {
      stats.rejected_empty += 1;
      continue;
    }
    const charCount = text.length;
    const words = wordCount(text);
    if (charCount < minCharCount && words < minWordCount) {
      stats.rejected_too_short += 1;
      continue;
    }
    const fingerprint = fingerprintText(text.toLowerCase());
    if (seen.has(fingerprint)) {
      stats.rejected_duplicate += 1;
      continue;
    }
    seen.add(fingerprint);
    accepted.push({
      record_id: `corpus-${fingerprint.slice(0, 16)}`,
      kind: String(record?.kind || "plain_text_corpus").trim() || "plain_text_corpus",
      source_type: sourceType,
      source_id: record?.source_id ?? null,
      text,
      char_count: charCount,
      word_count: words,
      fingerprint,
    });
  }
  stats.accepted_records = accepted.length;
  return {
    records: accepted,
    stats,
  };
}

export function splitCuratedCorpus(records = [], options = {}) {
  const evalFraction = Number.isFinite(options.eval_fraction)
    ? Math.min(0.5, Math.max(0, Number(options.eval_fraction)))
    : DEFAULT_EVAL_FRACTION;
  const sorted = [...(Array.isArray(records) ? records : [])].sort((left, right) =>
    String(left?.record_id || "").localeCompare(String(right?.record_id || ""))
  );
  if (sorted.length <= 1) {
    return {
      train_records: sorted,
      eval_records: [],
      strategy: "deterministic_eval_split",
      eval_fraction: evalFraction,
    };
  }
  const evalCount = Math.min(sorted.length - 1, Math.max(1, Math.round(sorted.length * evalFraction)));
  return {
    train_records: sorted.slice(evalCount),
    eval_records: sorted.slice(0, evalCount),
    strategy: "deterministic_eval_split",
    eval_fraction: evalFraction,
  };
}

export function detectTrainingCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:train"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:train",
      source: "package.json",
    };
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "local_adapter_train.mjs");
  if (fs.existsSync(scriptPath)) {
    return {
      available: true,
      command: "node ./scripts/local_adapter_train.mjs",
      source: "scripts/local_adapter_train.mjs",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

export function detectPromotionCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:promote"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:promote",
      source: "package.json",
    };
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "local_adapter_promote.mjs");
  if (fs.existsSync(scriptPath)) {
    return {
      available: true,
      command: "node ./scripts/local_adapter_promote.mjs",
      source: "scripts/local_adapter_promote.mjs",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

export function detectIntegrationCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:integrate"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:integrate",
      source: "package.json",
    };
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "local_adapter_integrate.mjs");
  if (fs.existsSync(scriptPath)) {
    return {
      available: true,
      command: "node ./scripts/local_adapter_integrate.mjs",
      source: "scripts/local_adapter_integrate.mjs",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

export function detectAdapterArtifacts(runDir) {
  const present = [];
  const missing = [];
  for (const definition of EXPECTED_ADAPTER_ARTIFACTS) {
    const match = definition.candidates.find((candidate) => fs.existsSync(path.join(runDir, candidate)));
    if (match) {
      present.push({
        artifact: definition.artifact,
        path: path.join(runDir, match),
      });
    } else {
      missing.push(definition.artifact);
    }
  }
  return {
    expected: EXPECTED_ADAPTER_ARTIFACTS.map((entry) => ({
      artifact: entry.artifact,
      candidates: [...entry.candidates],
    })),
    present,
    missing,
    all_present: missing.length === 0,
  };
}

export function buildTrainingReadiness({
  trainer,
  promotion_gate,
  train_records,
  eval_records,
  snapshot_path,
  capability_reports,
  training_command,
}) {
  const blockers = [];
  const promotionBlockers = [];
  if (!snapshot_path) {
    blockers.push("sources.snapshot_missing");
  }
  if (!Array.isArray(capability_reports) || capability_reports.length === 0) {
    blockers.push("sources.capability_report_missing");
  }
  if (!Array.isArray(train_records) || train_records.length === 0) {
    blockers.push("dataset.train_missing");
  }
  if (!Array.isArray(eval_records) || eval_records.length === 0) {
    blockers.push("dataset.eval_missing");
  }
  if (trainer?.trainer_ready !== true) {
    blockers.push("trainer.backend_unavailable");
  }
  if (training_command?.available !== true) {
    blockers.push("training.command_unwired");
  }
  if (promotion_gate?.ready !== true) {
    promotionBlockers.push("promotion_gate.blocked");
  }

  let nextBestTarget = "Wire an explicit MLX LoRA runner that consumes this packet and emits adapter artifacts plus metrics.";
  if (trainer?.trainer_ready !== true) {
    nextBestTarget = "Run `npm run local:training:bootstrap` on Apple Silicon before attempting a local adapter train run.";
  } else if (!snapshot_path || !Array.isArray(capability_reports) || capability_reports.length === 0) {
    nextBestTarget = "Capture fresh imprint snapshots and capability reports before treating this packet as a training candidate.";
  } else if (!Array.isArray(train_records) || train_records.length === 0 || !Array.isArray(eval_records) || eval_records.length === 0) {
    nextBestTarget = "Collect more local evidence so the lane can keep distinct train and eval splits.";
  } else if (training_command?.available !== true) {
    nextBestTarget = "Wire a bounded `npm run local:training:train` command that consumes the prepared packet and emits adapter artifacts.";
  } else if (promotion_gate?.ready !== true) {
    nextBestTarget = "Run the bounded local adapter trainer now; promotion stays blocked until the post-train eval gate is green.";
  }

  return {
    ready_for_packet_review: Array.isArray(train_records) ? train_records.length + (Array.isArray(eval_records) ? eval_records.length : 0) > 0 : false,
    ready_for_training_execution: blockers.length === 0,
    ready_for_safe_promotion: blockers.length === 0 && promotionBlockers.length === 0,
    command_wired: training_command?.available === true,
    blockers,
    promotion_blockers: promotionBlockers,
    next_best_target: nextBestTarget,
  };
}

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeJsonl(filePath, rows) {
  ensureDirectory(path.dirname(filePath));
  const lines = Array.isArray(rows) ? rows.map((row) => JSON.stringify(row)).join("\n") : "";
  fs.writeFileSync(filePath, lines.length > 0 ? `${lines}\n` : "", "utf8");
}

function loadRegistry() {
  const registry = readJson(REGISTRY_PATH);
  return registry && typeof registry === "object"
    ? registry
    : {
        schema_version: REGISTRY_SCHEMA_VERSION,
        updated_at: null,
        runs: [],
      };
}

function saveRegistry(runRecord) {
  const registry = loadRegistry();
  const runs = Array.isArray(registry.runs) ? registry.runs : [];
  runs.unshift(runRecord);
  const trimmedRuns = runs.slice(0, 25);
  writeJson(REGISTRY_PATH, {
    schema_version: REGISTRY_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    runs: trimmedRuns,
  });
}

function currentModel() {
  return (
    String(readEnvValue("TRICHAT_OLLAMA_MODEL") || process.env.TRICHAT_OLLAMA_MODEL || DEFAULT_MODEL).trim() ||
    DEFAULT_MODEL
  );
}

function latestCapabilityReports(limit = 3) {
  return listNewestFiles(REPORT_DIR, ".json", limit)
    .map((filePath) => ({ filePath, payload: readJson(filePath) }))
    .filter((entry) => entry.payload);
}

function latestSnapshot() {
  const [filePath] = listNewestFiles(SNAPSHOT_DIR, ".json", 1);
  if (!filePath) {
    return null;
  }
  const payload = readJson(filePath);
  return payload ? { filePath, payload } : null;
}

function latestPromotionGate(reportEntries, model) {
  const matching = reportEntries.find((entry) => String(entry.payload?.model || "").trim() === model) || reportEntries[0] || null;
  if (!matching) {
    return {
      ready: false,
      detail: "No local capability report found yet.",
      report_path: null,
      pass_rate: null,
    };
  }
  const summary = matching.payload?.summary || {};
  const passRate = Number.isFinite(summary.pass_rate) ? Number(summary.pass_rate) : null;
  return {
    ready: passRate === 100,
    detail:
      passRate === 100
        ? "Latest capability report is promotion-clean."
        : `Latest capability report is below gate (${passRate ?? "n/a"}%).`,
    report_path: matching.filePath,
    pass_rate: passRate,
  };
}

function prepareLane() {
  const model = currentModel();
  const trainer = detectTrainerAvailability();
  const snapshot = latestSnapshot();
  const reports = latestCapabilityReports(5);
  const rawRecords = buildCorpusRecords(snapshot?.payload || {}, reports.map((entry) => entry.payload));
  const curated = curateCorpusRecords(rawRecords);
  const split = splitCuratedCorpus(curated.records);
  const gate = latestPromotionGate(reports, model);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(TRAINING_ROOT, runId);
  const corpusPath = path.join(runDir, "corpus.jsonl");
  const trainPath = path.join(runDir, "train.jsonl");
  const evalPath = path.join(runDir, "eval.jsonl");
  const manifestPath = path.join(runDir, "manifest.json");
  const currentPromotedModel = currentModel();
  const trainingCommand = detectTrainingCommand();
  const candidateId = buildCandidateId(model, runId);
  const artifacts = detectAdapterArtifacts(runDir);
  const readiness = buildTrainingReadiness({
    trainer,
    promotion_gate: gate,
    train_records: split.train_records,
    eval_records: split.eval_records,
    snapshot_path: snapshot?.filePath || null,
    capability_reports: reports.map((entry) => entry.filePath),
    training_command: trainingCommand,
  });
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    run_id: runId,
    lane: "local_adapter_lane",
    candidate_id: candidateId,
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
    },
    base_model: model,
    current_promoted_model: currentPromotedModel,
    rollback_model: currentPromotedModel,
    trainer,
    promotion_gate: gate,
    sources: {
      snapshot_path: snapshot?.filePath || null,
      capability_reports: reports.map((entry) => entry.filePath),
      source_type_breakdown: sourceTypeCounts(rawRecords),
    },
    corpus: {
      path: corpusPath,
      train_path: trainPath,
      eval_path: evalPath,
      input_record_count: rawRecords.length,
      record_count: curated.records.length,
      train_record_count: split.train_records.length,
      eval_record_count: split.eval_records.length,
      format: "jsonl/plain_text_corpus",
      split_strategy: split.strategy,
      curation: curated.stats,
    },
    training_intent: {
      type: "lora_adapter_preparation",
      weights_modified: false,
      executed: false,
      command_wired: trainingCommand.available,
      train_command: trainingCommand.command,
      command_source: trainingCommand.source,
    },
    artifacts,
    evaluation_targets: {
      ollama: {
        provider: "ollama",
        model: currentPromotedModel,
        capability_report_path: gate.report_path,
        capability_pass_rate: gate.pass_rate,
        required_for_safe_promotion: true,
      },
      mlx: {
        provider: "mlx",
        trainer_ready: trainer.trainer_ready,
        backend: trainer.backend,
        python_path: trainer.python_path,
        required_for_local_adapter_execution: true,
      },
    },
    acceptance_contract: {
      benchmark: {
        suite_id: DEFAULT_BENCHMARK_SUITE_ID,
        required_aggregate_metric: 100,
      },
      eval: {
        suite_id: DEFAULT_EVAL_SUITE_ID,
        required_aggregate_metric: 100,
      },
      rollback: {
        required: true,
        rollback_model: currentPromotedModel,
        policy: "Restore the last promoted Ollama model if adapter eval or route verification fails.",
      },
      promotion_eval: {
        min_reward_score: 75,
        min_delta_vs_baseline: -5,
        max_test_loss: 8,
        require_generate_smoke: true,
        require_artifacts: true,
      },
    },
    safe_promotion_metadata: {
      allowed_now: false,
      blockers: [
        "adapter_artifacts_missing",
        ...(gate.ready ? [] : ["promotion_gate_not_clean"]),
      ],
      target_candidate_id: candidateId,
      target_base_model: model,
      rollback_model: currentPromotedModel,
    },
    readiness,
    status: readiness.ready_for_training_execution ? "training_ready" : "prepared_blocked",
    next_action: readiness.next_best_target,
  };
  writeJsonl(corpusPath, curated.records);
  writeJsonl(trainPath, split.train_records);
  writeJsonl(evalPath, split.eval_records);
  writeJson(manifestPath, manifest);
  saveRegistry({
    lane: "local_adapter_lane",
    generated_at: manifest.generated_at,
    run_id: runId,
    candidate_id: candidateId,
    base_model: model,
    status: manifest.status,
    manifest_path: manifestPath,
    corpus_path: corpusPath,
    train_path: trainPath,
    eval_path: evalPath,
    record_count: curated.records.length,
    train_record_count: split.train_records.length,
    eval_record_count: split.eval_records.length,
    trainer_ready: trainer.trainer_ready,
    promotion_gate_ready: gate.ready,
    promotion_gate_pass_rate: gate.pass_rate,
    readiness_blockers: readiness.blockers,
    rollback_model: currentPromotedModel,
    evaluation_targets: Object.keys(manifest.evaluation_targets),
  });
  return {
    ok: true,
    prepared: true,
    manifest_path: manifestPath,
    corpus_path: corpusPath,
    train_path: trainPath,
    eval_path: evalPath,
    record_count: curated.records.length,
    candidate_id: candidateId,
    trainer,
    promotion_gate: gate,
    readiness,
  };
}

function statusLane() {
  const trainer = detectTrainerAvailability();
  const registry = loadRegistry();
  const latestRun = Array.isArray(registry.runs) && registry.runs.length > 0 ? registry.runs[0] : null;
  const trainingCommand = detectTrainingCommand();
  const promotionCommand = detectPromotionCommand();
  const integrationCommand = detectIntegrationCommand();
  return {
    ok: true,
    current_model: currentModel(),
    trainer,
    training_command: trainingCommand,
    promotion_command: promotionCommand,
    integration_command: integrationCommand,
    latest_run: latestRun,
    training_root: TRAINING_ROOT,
    registry_path: REGISTRY_PATH,
    recommended_bootstrap_command: trainer.trainer_ready ? null : "npm run local:training:bootstrap",
    recommended_next_target:
      latestRun?.status === "training_ready"
        ? "Run the bounded local adapter trainer against the prepared packet."
        : latestRun?.status === "prepared_blocked" && latestRun?.readiness_blockers?.length === 0
          ? "Run the bounded local adapter trainer against the prepared packet."
          : latestRun?.status === "adapter_trained_unpromoted" && promotionCommand.available
          ? "Run the bounded local adapter promotion gate before treating this candidate as router-eligible."
            : latestRun?.status === "adapter_registered" && integrationCommand.available
              ? "Run the bounded integration command so the accepted adapter becomes a real MLX backend or Ollama companion."
              : latestRun?.status === "adapter_registered"
                ? "Wire a bounded integration command so the accepted adapter becomes a real MLX backend or Ollama companion."
                : latestRun?.status === "adapter_served_mlx" || latestRun?.status === "adapter_exported_ollama"
                  ? "The accepted adapter is live as a reachable local backend; only change router defaults if a separate cutover is desired."
              : latestRun?.status === "adapter_rejected"
                ? "Tune the corpus or training parameters, then rerun prepare, train, and promote."
                : latestRun?.readiness_blockers?.includes?.("training.command_unwired")
                  ? "Wire a local adapter train command that consumes the prepared packet."
                  : null,
  };
}

function bootstrapLane() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return {
      ok: false,
      bootstrap_invoked: false,
      supported: false,
      detail: "Local MLX trainer bootstrap is only supported on Apple Silicon macOS hosts.",
    };
  }
  const runnerPath = path.join(REPO_ROOT, "scripts", "run_sh.mjs");
  const setupScriptPath = path.join(REPO_ROOT, "scripts", "mlx_local_backend_setup.sh");
  const result = spawnSync(process.execPath, [runnerPath, setupScriptPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60 * 1000,
  });
  const status = statusLane();
  return {
    ...status,
    ok: (result.status ?? 1) === 0,
    bootstrap_invoked: true,
    supported: true,
    stdout: String(result.stdout || "").trim() || null,
    stderr: String(result.stderr || "").trim() || null,
  };
}

function main() {
  const action = String(process.argv[2] || "status").trim();
  const result =
    action === "prepare"
      ? prepareLane()
      : action === "bootstrap"
        ? bootstrapLane()
        : statusLane();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
