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
const DATASET_INTEGRITY_CONTRACT_VERSION = "local_training_packet.dataset_integrity.v1";
const DEFAULT_EVAL_FRACTION = 0.2;
const MIN_CORPUS_CHAR_COUNT = 20;
const MIN_CORPUS_WORD_COUNT = 4;
const TRAINING_STATUS_RANK = {
  prepared_blocked: 1,
  training_ready: 1,
  training_failed: 2,
  adapter_trained_unpromoted: 2,
  adapter_rejected: 3,
  adapter_registered: 3,
  adapter_served_mlx: 4,
  adapter_exported_ollama: 4,
  adapter_primary_mlx: 5,
  adapter_primary_ollama: 5,
  rollback_restored: 5,
};
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

function readString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function stableHash(parts = []) {
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

function canonicalDatasetRow(record) {
  const text = typeof record?.text === "string" ? record.text : "";
  const normalizedText = normalizeCorpusText(text);
  const sourceType = String(record?.source_type || "unknown").trim() || "unknown";
  const recordId = readString(record?.record_id);
  const fingerprint = readString(record?.fingerprint) || (normalizedText ? fingerprintText(normalizedText.toLowerCase()) : null);
  return {
    record_id: recordId,
    fingerprint,
    source_type: sourceType,
    source_id: record?.source_id ?? null,
    text,
  };
}

function duplicateCount(values = []) {
  const seen = new Set();
  let duplicates = 0;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (seen.has(value)) {
      duplicates += 1;
      continue;
    }
    seen.add(value);
  }
  return duplicates;
}

function setDifference(left = new Set(), right = new Set()) {
  const values = [];
  for (const entry of left) {
    if (!right.has(entry)) {
      values.push(entry);
    }
  }
  return values;
}

function setIntersection(left = new Set(), right = new Set()) {
  const values = [];
  for (const entry of left) {
    if (right.has(entry)) {
      values.push(entry);
    }
  }
  return values;
}

function summarizeDatasetRows(records = []) {
  const canonicalRows = [...(Array.isArray(records) ? records : [])].map(canonicalDatasetRow);
  const recordIds = canonicalRows.map((entry) => entry.record_id).filter(Boolean);
  const fingerprints = canonicalRows.map((entry) => entry.fingerprint).filter(Boolean);
  return {
    canonical_rows: canonicalRows,
    record_ids: recordIds,
    record_id_set: new Set(recordIds),
    duplicate_record_id_count: duplicateCount(recordIds),
    duplicate_fingerprint_count: duplicateCount(fingerprints),
    invalid_row_count: canonicalRows.filter((entry) => !entry.record_id || !entry.fingerprint || !normalizeCorpusText(entry.text)).length,
    row_sha256: stableHash(canonicalRows.map((entry) => JSON.stringify(entry))),
    membership_sha256: stableHash([...new Set(recordIds)].sort()),
  };
}

function readJsonlRecords(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      file_path: filePath || null,
      missing: true,
      rows: [],
      error: "missing",
    };
  }
  try {
    const rows = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => JSON.parse(entry));
    return {
      ok: true,
      file_path: filePath,
      missing: false,
      rows,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      file_path: filePath,
      missing: false,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildDatasetIntegrity({ corpusRecords = [], trainRecords = [], evalRecords = [] } = {}) {
  const corpus = summarizeDatasetRows(corpusRecords);
  const train = summarizeDatasetRows(trainRecords);
  const evalSet = summarizeDatasetRows(evalRecords);
  const trainEvalOverlap = setIntersection(train.record_id_set, evalSet.record_id_set);
  const trainMissingFromCorpus = setDifference(train.record_id_set, corpus.record_id_set);
  const evalMissingFromCorpus = setDifference(evalSet.record_id_set, corpus.record_id_set);
  const corpusMissingFromSplits = setDifference(
    corpus.record_id_set,
    new Set([...train.record_id_set, ...evalSet.record_id_set])
  );
  return {
    contract_version: DATASET_INTEGRITY_CONTRACT_VERSION,
    corpus_sha256: corpus.row_sha256,
    train_sha256: train.row_sha256,
    eval_sha256: evalSet.row_sha256,
    corpus_membership_sha256: corpus.membership_sha256,
    train_membership_sha256: train.membership_sha256,
    eval_membership_sha256: evalSet.membership_sha256,
    corpus_duplicate_record_id_count: corpus.duplicate_record_id_count,
    train_duplicate_record_id_count: train.duplicate_record_id_count,
    eval_duplicate_record_id_count: evalSet.duplicate_record_id_count,
    corpus_duplicate_fingerprint_count: corpus.duplicate_fingerprint_count,
    train_duplicate_fingerprint_count: train.duplicate_fingerprint_count,
    eval_duplicate_fingerprint_count: evalSet.duplicate_fingerprint_count,
    corpus_invalid_row_count: corpus.invalid_row_count,
    train_invalid_row_count: train.invalid_row_count,
    eval_invalid_row_count: evalSet.invalid_row_count,
    train_missing_from_corpus_count: trainMissingFromCorpus.length,
    eval_missing_from_corpus_count: evalMissingFromCorpus.length,
    corpus_missing_from_splits_count: corpusMissingFromSplits.length,
    train_eval_overlap_count: trainEvalOverlap.length,
    split_coverage_ok:
      trainMissingFromCorpus.length === 0 &&
      evalMissingFromCorpus.length === 0 &&
      corpusMissingFromSplits.length === 0 &&
      trainEvalOverlap.length === 0,
  };
}

export function auditPreparedDataset(manifest, registryRun = null) {
  const findings = [];
  const addFinding = (severity, code, message) => {
    findings.push({ severity, code, message });
  };

  const corpusPath = readString(manifest?.corpus?.path) || readString(registryRun?.corpus_path);
  const trainPath = readString(manifest?.corpus?.train_path) || readString(registryRun?.train_path);
  const evalPath = readString(manifest?.corpus?.eval_path) || readString(registryRun?.eval_path);
  const expected = manifest?.corpus?.integrity && typeof manifest.corpus.integrity === "object" ? manifest.corpus.integrity : null;

  const corpusPayload = readJsonlRecords(corpusPath);
  const trainPayload = readJsonlRecords(trainPath);
  const evalPayload = readJsonlRecords(evalPath);

  if (!expected) {
    addFinding(
      "error",
      "dataset.integrity_missing",
      "The manifest is missing corpus.integrity, so the prepared packet cannot prove split membership or hash stability."
    );
  }
  if (!corpusPayload.ok && !corpusPayload.missing) {
    addFinding("error", "dataset.corpus_unreadable", "The corpus.jsonl file could not be parsed as JSONL.");
  }
  if (!trainPayload.ok && !trainPayload.missing) {
    addFinding("error", "dataset.train_unreadable", "The train.jsonl file could not be parsed as JSONL.");
  }
  if (!evalPayload.ok && !evalPayload.missing) {
    addFinding("error", "dataset.eval_unreadable", "The eval.jsonl file could not be parsed as JSONL.");
  }

  let actual = null;
  if (corpusPayload.ok && trainPayload.ok && evalPayload.ok) {
    actual = buildDatasetIntegrity({
      corpusRecords: corpusPayload.rows,
      trainRecords: trainPayload.rows,
      evalRecords: evalPayload.rows,
    });
    if (actual.train_eval_overlap_count > 0) {
      addFinding("error", "dataset.train_eval_overlap", "The train and eval splits are no longer disjoint.");
    }
    if (!actual.split_coverage_ok) {
      addFinding("error", "dataset.split_coverage_drift", "The train/eval membership no longer reconstructs the prepared corpus exactly.");
    }
    if (
      actual.corpus_duplicate_record_id_count > 0 ||
      actual.train_duplicate_record_id_count > 0 ||
      actual.eval_duplicate_record_id_count > 0
    ) {
      addFinding("error", "dataset.duplicate_record_ids", "The prepared packet contains duplicate record_id values.");
    }
    if (
      actual.corpus_duplicate_fingerprint_count > 0 ||
      actual.train_duplicate_fingerprint_count > 0 ||
      actual.eval_duplicate_fingerprint_count > 0
    ) {
      addFinding("error", "dataset.duplicate_fingerprints", "The prepared packet contains duplicate text fingerprints.");
    }
    if (actual.corpus_invalid_row_count > 0 || actual.train_invalid_row_count > 0 || actual.eval_invalid_row_count > 0) {
      addFinding("error", "dataset.invalid_rows", "The prepared packet contains rows missing record_id, text, or fingerprint evidence.");
    }
    if (expected) {
      const compareFields = [
        ["corpus_sha256", "dataset.corpus_hash_drift", "The curated corpus hash drifted after packet preparation."],
        ["train_sha256", "dataset.train_hash_drift", "The train split hash drifted after packet preparation."],
        ["eval_sha256", "dataset.eval_hash_drift", "The eval split hash drifted after packet preparation."],
        [
          "corpus_membership_sha256",
          "dataset.corpus_membership_drift",
          "The corpus record membership no longer matches the prepared packet.",
        ],
        [
          "train_membership_sha256",
          "dataset.train_membership_drift",
          "The train split membership no longer matches the prepared packet.",
        ],
        [
          "eval_membership_sha256",
          "dataset.eval_membership_drift",
          "The eval split membership no longer matches the prepared packet.",
        ],
      ];
      for (const [field, code, message] of compareFields) {
        if (readString(expected[field]) && expected[field] !== actual[field]) {
          addFinding("error", code, message);
        }
      }
    }
  }

  const errorCount = findings.filter((entry) => entry.severity === "error").length;
  return {
    ok: errorCount === 0,
    error_count: errorCount,
    findings,
    expected,
    actual,
    paths: {
      corpus_path: corpusPath,
      train_path: trainPath,
      eval_path: evalPath,
    },
  };
}

export function assertPreparedDataset(manifest, registryRun = null) {
  const audit = auditPreparedDataset(manifest, registryRun);
  if (!audit.ok) {
    const codes = audit.findings
      .filter((entry) => entry.severity === "error")
      .map((entry) => entry.code)
      .join(", ");
    throw new Error(
      `The prepared training packet failed integrity checks (${codes || "dataset_integrity_failed"}). Rerun \`npm run local:training:prepare\` before continuing.`
    );
  }
  return audit;
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

export function detectCutoverCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:cutover"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:cutover",
      source: "package.json",
    };
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "local_adapter_cutover.mjs");
  if (fs.existsSync(scriptPath)) {
    return {
      available: true,
      command: "node ./scripts/local_adapter_cutover.mjs",
      source: "scripts/local_adapter_cutover.mjs",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

export function detectSoakCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:soak"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:soak",
      source: "package.json",
    };
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "local_adapter_soak.mjs");
  if (fs.existsSync(scriptPath)) {
    return {
      available: true,
      command: "node ./scripts/local_adapter_soak.mjs",
      source: "scripts/local_adapter_soak.mjs",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

export function detectWatchdogCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:watchdog"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:watchdog",
      source: "package.json",
    };
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "local_adapter_watchdog.mjs");
  if (fs.existsSync(scriptPath)) {
    return {
      available: true,
      command: "node ./scripts/local_adapter_watchdog.mjs",
      source: "scripts/local_adapter_watchdog.mjs",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

export function detectVerifyCommand() {
  const packageJson = readPackageJson();
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts || {} : {};
  const scripted = String(scripts["local:training:verify"] || "").trim();
  if (scripted) {
    return {
      available: true,
      command: "npm run local:training:verify",
      source: "package.json",
    };
  }
  return {
    available: false,
    command: null,
    source: null,
  };
}

function parseIsoTimestamp(value) {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildPrimaryWatchdogState(latestRun, manifest, options = {}) {
  const statusEvidence = deriveEffectiveTrainingStatus({
    registryRun: latestRun || {},
    manifest: manifest || {},
  });
  const status = String(statusEvidence.effective_status || "").trim();
  const applicable = status === "adapter_primary_mlx" || status === "adapter_primary_ollama";
  const contract =
    manifest?.primary_watchdog_contract && typeof manifest.primary_watchdog_contract === "object"
      ? manifest.primary_watchdog_contract
      : {};
  const maxSoakAgeMinutes =
    Number.isFinite(contract.max_soak_age_minutes) && Number(contract.max_soak_age_minutes) >= 15
      ? Math.min(Number(contract.max_soak_age_minutes), 24 * 60)
      : 240;
  const completedAt =
    String(latestRun?.primary_soak_completed_at || manifest?.primary_soak_result?.completed_at || "").trim() || null;
  const completedAtMs = parseIsoTimestamp(completedAt);
  const soakOk =
    latestRun?.primary_soak_ok === true || (latestRun?.primary_soak_ok !== false && manifest?.primary_soak_result?.ok === true);
  const ageMinutes =
    completedAtMs !== null
      ? Number((((Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()) - completedAtMs) / 60000).toFixed(2))
      : null;
  const stale = applicable && completedAtMs !== null ? ageMinutes > maxSoakAgeMinutes : applicable && completedAtMs === null;
  const shouldRunWatchdog = applicable && (!soakOk || stale);
  return {
    applicable,
    reported_status: statusEvidence.reported_status,
    effective_status: statusEvidence.effective_status,
    status_regressed: statusEvidence.status_regressed,
    max_soak_age_minutes: maxSoakAgeMinutes,
    primary_soak_completed_at: completedAt,
    primary_soak_ok: soakOk,
    primary_soak_age_minutes: ageMinutes,
    stale,
    should_run_watchdog: shouldRunWatchdog,
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

function readJsonlLineCount(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function statusRank(status) {
  const normalized = String(status || "").trim();
  return TRAINING_STATUS_RANK[normalized] ?? 0;
}

function statusAtLeast(status, expected) {
  return statusRank(status) >= statusRank(expected);
}

function integrationStatusForTarget(target) {
  return target === "ollama" ? "adapter_exported_ollama" : "adapter_served_mlx";
}

function primaryStatusForTarget(target) {
  return target === "ollama" ? "adapter_primary_ollama" : "adapter_primary_mlx";
}

export function deriveEffectiveTrainingStatus({ registryRun, manifest }) {
  const reportedStatus = readString(manifest?.status) || readString(registryRun?.status) || "unknown";
  const candidates = [];
  const pushCandidate = (source, status) => {
    const normalized = readString(status);
    if (normalized) {
      candidates.push({ source, status: normalized });
    }
  };

  pushCandidate("reported_status", reportedStatus);
  pushCandidate("registry.integration_status", registryRun?.integration_status);
  pushCandidate("registry.cutover_status", registryRun?.cutover_status);

  const integrationTarget = readString(manifest?.integration_result?.target);
  if (manifest?.integration_result?.ok === true && readString(manifest?.integration_result?.backend_id) && integrationTarget) {
    pushCandidate("manifest.integration_result", integrationStatusForTarget(integrationTarget));
  }

  const cutoverTarget = readString(manifest?.cutover_result?.target);
  if (manifest?.cutover_result?.ok === true && manifest?.cutover_result?.promoted === true && cutoverTarget) {
    pushCandidate("manifest.cutover_result", primaryStatusForTarget(cutoverTarget));
  }

  let effectiveStatus = reportedStatus;
  for (const candidate of candidates) {
    if (statusRank(candidate.status) > statusRank(effectiveStatus)) {
      effectiveStatus = candidate.status;
    }
  }

  return {
    reported_status: reportedStatus,
    effective_status: effectiveStatus,
    status_regressed: statusRank(effectiveStatus) > statusRank(reportedStatus),
    evidence_statuses: [...new Set(candidates.map((entry) => entry.status))],
    evidence_sources: candidates.filter((entry) => entry.status === effectiveStatus).map((entry) => entry.source),
  };
}

function summarizeTrainingProof({ statusEvidence, manifest, registration, primaryWatchdog }) {
  const normalizedStatus = String(statusEvidence?.effective_status || "unknown").trim();
  const primarySoakOk = manifest?.primary_soak_result?.ok === true || manifest?.primary_watchdog_result?.ok === true;
  const primaryWatchdogFresh =
    normalizedStatus === "adapter_primary_mlx" || normalizedStatus === "adapter_primary_ollama"
      ? primaryWatchdog?.should_run_watchdog === false
      : null;
  let stage = "unknown";
  if (normalizedStatus === "adapter_primary_mlx" || normalizedStatus === "adapter_primary_ollama") {
    if (primarySoakOk && primaryWatchdogFresh === true) {
      stage = "primary_confidence_fresh";
    } else if (primarySoakOk) {
      stage = "primary_confidence_stale";
    } else {
      stage = "primary_pending_confidence";
    }
  } else if (normalizedStatus === "adapter_served_mlx" || normalizedStatus === "adapter_exported_ollama") {
    stage = "integration_live";
  } else if (normalizedStatus === "adapter_registered") {
    stage = "promotion_registered";
  } else if (normalizedStatus === "adapter_rejected") {
    stage = "promotion_rejected";
  } else if (normalizedStatus === "adapter_trained_unpromoted" || normalizedStatus === "training_failed") {
    stage = "training_executed";
  } else if (normalizedStatus === "training_ready" || normalizedStatus === "prepared_blocked") {
    stage = "packet_prepared";
  }

  return {
    stage,
    reported_status: statusEvidence?.reported_status || "unknown",
    effective_status: normalizedStatus,
    status_regressed: statusEvidence?.status_regressed === true,
    effective_status_sources: Array.isArray(statusEvidence?.evidence_sources) ? statusEvidence.evidence_sources : [],
    packet_prepared: Boolean(manifest?.corpus?.path && manifest?.sources),
    training_executed: manifest?.training_intent?.executed === true,
    promotion_registered: manifest?.promotion_result?.status === "registered" && registration?.decision?.accepted === true,
    integration_live: Boolean(manifest?.integration_result?.backend_id),
    router_primary: normalizedStatus === "adapter_primary_mlx" || normalizedStatus === "adapter_primary_ollama",
    rollback_ready: Boolean(
      manifest?.rollback_model ||
        manifest?.cutover_result?.previous_default_backend_id ||
        registration?.cutover_result?.previous_default_backend_id
    ),
    primary_soak_ok: primarySoakOk,
    primary_watchdog_fresh: primaryWatchdogFresh,
    safe_promotion_allowed_now: manifest?.safe_promotion_metadata?.allowed_now === true,
  };
}

export function auditTrainingRun({ registryRun, manifest, registration, nowMs = Date.now() }) {
  const findings = [];
  const addFinding = (severity, code, message) => {
    findings.push({ severity, code, message });
  };

  const manifestPath =
    readString(manifest?.manifest_path) ||
    readString(registryRun?.manifest_path) ||
    null;
  const statusEvidence = deriveEffectiveTrainingStatus({
    registryRun: registryRun || {},
    manifest: manifest || {},
  });
  const status = statusEvidence.effective_status;
  const primaryWatchdog = buildPrimaryWatchdogState(
    registryRun || {},
    manifest || {},
    { nowMs }
  );
  const proof = summarizeTrainingProof({
    statusEvidence,
    manifest,
    registration,
    primaryWatchdog,
  });

  if (!registryRun || typeof registryRun !== "object") {
    addFinding("error", "registry.entry_missing", "The registry entry is missing or unreadable.");
  }
  if (!manifest || typeof manifest !== "object") {
    addFinding("error", "manifest.unreadable", `The manifest could not be read${manifestPath ? ` at ${manifestPath}` : ""}.`);
  }
  if (!readString(registryRun?.candidate_id)) {
    addFinding("warn", "registry.candidate_missing", "The registry entry does not persist a candidate_id.");
  }
  if (manifest && registryRun?.run_id && manifest.run_id && registryRun.run_id !== manifest.run_id) {
    addFinding("error", "manifest.run_id_mismatch", "The registry run_id does not match the manifest run_id.");
  }
  if (
    manifest &&
    readString(registryRun?.candidate_id) &&
    readString(manifest?.candidate_id) &&
    registryRun.candidate_id !== manifest.candidate_id
  ) {
    addFinding("error", "manifest.candidate_id_mismatch", "The registry candidate_id does not match the manifest candidate_id.");
  }
  if (statusEvidence.status_regressed) {
    addFinding(
      "error",
      "status.stage_regressed",
      `The reported lane status regressed to ${statusEvidence.reported_status} even though later-stage evidence still shows ${statusEvidence.effective_status}. Do not rerun promote; re-verify the later-stage state instead.`
    );
  }

  if (manifest && manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    addFinding(
      "warn",
      "manifest.schema_version_legacy",
      `The manifest schema version is ${manifest.schema_version || "missing"} instead of ${MANIFEST_SCHEMA_VERSION}.`
    );
  }
  if (manifest && (!manifest.acceptance_contract || !manifest.evaluation_targets)) {
    addFinding(
      "error",
      "manifest.contract_missing",
      "The manifest is missing acceptance_contract or evaluation_targets, so promotion evidence is underspecified."
    );
  }

  const corpusPath = readString(manifest?.corpus?.path) || readString(registryRun?.corpus_path);
  const trainPath = readString(manifest?.corpus?.train_path) || readString(registryRun?.train_path);
  const evalPath = readString(manifest?.corpus?.eval_path) || readString(registryRun?.eval_path);
  const corpusCount = readJsonlLineCount(corpusPath);
  const trainCount = readJsonlLineCount(trainPath);
  const evalCount = readJsonlLineCount(evalPath);
  if (corpusPath && corpusCount === null) {
    addFinding("error", "dataset.corpus_missing", "The curated corpus path is missing from disk.");
  }
  if (trainPath && trainCount === null) {
    addFinding("error", "dataset.train_missing", "The train split path is missing from disk.");
  }
  if (evalPath && evalCount === null) {
    addFinding("error", "dataset.eval_missing", "The eval split path is missing from disk.");
  }
  if (Number.isFinite(manifest?.corpus?.record_count) && corpusCount !== null && corpusCount !== manifest.corpus.record_count) {
    addFinding("error", "dataset.corpus_count_mismatch", "The corpus.jsonl row count does not match manifest.corpus.record_count.");
  }
  if (
    Number.isFinite(manifest?.corpus?.train_record_count) &&
    trainCount !== null &&
    trainCount !== manifest.corpus.train_record_count
  ) {
    addFinding("error", "dataset.train_count_mismatch", "The train.jsonl row count does not match manifest.corpus.train_record_count.");
  }
  if (
    Number.isFinite(manifest?.corpus?.eval_record_count) &&
    evalCount !== null &&
    evalCount !== manifest.corpus.eval_record_count
  ) {
    addFinding("error", "dataset.eval_count_mismatch", "The eval.jsonl row count does not match manifest.corpus.eval_record_count.");
  }
  const datasetAudit = auditPreparedDataset(manifest, registryRun);
  for (const finding of datasetAudit.findings) {
    addFinding(finding.severity, finding.code, finding.message);
  }

  const trainingExecuted = manifest?.training_intent?.executed === true;
  const safePromotionAllowed = manifest?.safe_promotion_metadata?.allowed_now === true;
  const artifactRoot =
    readString(manifest?.training_result?.adapter_path) ||
    readString(registryRun?.adapter_path) ||
    (readString(manifest?.training_result?.training_metrics_path)
      ? path.dirname(readString(manifest.training_result.training_metrics_path))
      : null) ||
    (readString(manifestPath) ? path.dirname(manifestPath) : null);
  const artifacts = artifactRoot
    ? detectAdapterArtifacts(artifactRoot)
    : { all_present: false, missing: EXPECTED_ADAPTER_ARTIFACTS.map((entry) => entry.artifact), present: [] };

  if (statusAtLeast(status, "adapter_trained_unpromoted")) {
    if (!trainingExecuted) {
      addFinding("error", "training.intent_missing", "The run reached a post-train state without training_intent.executed=true.");
    }
    if (!artifacts.all_present) {
      addFinding("error", "training.artifacts_missing", "The run reached a post-train state without all expected adapter artifacts.");
    }
    if (!readString(manifest?.training_result?.training_metrics_path)) {
      addFinding("error", "training.metrics_missing", "The training result is missing a training_metrics_path.");
    }
    if (manifest?.training_result?.generate_smoke?.ok !== true) {
      addFinding("warn", "training.generate_smoke_missing", "The training result does not show a successful adapter generation smoke check.");
    }
  } else {
    if (trainingExecuted) {
      addFinding("error", "training.executed_too_early", "training_intent.executed is true before the lane reached a trained state.");
    }
    if (safePromotionAllowed) {
      addFinding("error", "promotion.allowed_too_early", "safe_promotion_metadata.allowed_now is true before a live integration state exists.");
    }
  }

  if (statusAtLeast(status, "adapter_registered") || status === "adapter_rejected") {
    const expectedPromotionStatus = status === "adapter_rejected" ? "rejected" : "registered";
    if (!manifest?.promotion_result || manifest.promotion_result.status !== expectedPromotionStatus) {
      addFinding(
        "error",
        "promotion.result_missing",
        `The manifest is missing a ${expectedPromotionStatus} promotion_result despite the current status.`
      );
    }
    if (!readString(manifest?.promotion_result?.benchmark_suite_id) || !readString(manifest?.promotion_result?.eval_suite_id)) {
      addFinding("error", "promotion.suites_missing", "The promotion result is missing benchmark or eval suite identifiers.");
    }
    if (!Number.isFinite(manifest?.promotion_result?.reward_score)) {
      addFinding("error", "promotion.reward_missing", "The promotion result is missing a numeric reward_score.");
    }
    if (status !== "adapter_rejected" && registration?.decision?.accepted !== true) {
      addFinding("error", "promotion.registration_missing", "The run claims a registered state without an accepted registration artifact.");
    }
  }

  const integrated = statusAtLeast(status, "adapter_served_mlx") || statusAtLeast(status, "adapter_exported_ollama");
  if (integrated) {
    if (!manifest?.integration_result?.backend_id || !manifest?.integration_result?.model_id) {
      addFinding("error", "integration.result_missing", "The run is integrated but the integration_result is incomplete.");
    }
    if (!safePromotionAllowed) {
      addFinding("error", "promotion.allowed_missing", "safe_promotion_metadata.allowed_now should be true once the adapter is live and reachable.");
    }
    if (Array.isArray(manifest?.safe_promotion_metadata?.blockers) && manifest.safe_promotion_metadata.blockers.length > 0) {
      addFinding("warn", "promotion.blockers_still_present", "The adapter is integrated but safe_promotion_metadata still lists blockers.");
    }
  }

  const primary = status === "adapter_primary_mlx" || status === "adapter_primary_ollama";
  if (primary) {
    if (manifest?.cutover_result?.ok !== true || manifest?.cutover_result?.promoted !== true) {
      addFinding("error", "cutover.result_missing", "The run is primary but cutover_result does not show a successful promotion.");
    }
    if (!readString(manifest?.cutover_result?.previous_default_backend_id)) {
      addFinding("error", "rollback.previous_default_missing", "The current primary is missing the previous_default_backend_id needed for rollback.");
    }
    if (!manifest?.primary_soak_result) {
      addFinding("warn", "confidence.soak_missing", "The adapter is primary but does not yet have a recorded bounded soak result.");
    } else if (primaryWatchdog.should_run_watchdog) {
      addFinding(
        "warn",
        "confidence.watchdog_stale",
        `The latest green confidence proof is stale (${primaryWatchdog.primary_soak_age_minutes ?? "n/a"} minutes old).`
      );
    }
  }

  const errorCount = findings.filter((entry) => entry.severity === "error").length;
  const warningCount = findings.filter((entry) => entry.severity === "warn").length;
  return {
    ok: errorCount === 0,
    clean: errorCount === 0 && warningCount === 0,
    status,
    reported_status: statusEvidence.reported_status,
    status_regressed: statusEvidence.status_regressed,
    manifest_path: manifestPath,
    candidate_id: readString(manifest?.candidate_id) || readString(registryRun?.candidate_id) || null,
    error_count: errorCount,
    warning_count: warningCount,
    proof,
    dataset_audit: datasetAudit,
    primary_watchdog: primaryWatchdog,
    findings,
  };
}

export function buildTrainingRegistryAudit(registry, options = {}) {
  const runs = Array.isArray(registry?.runs) ? registry.runs : [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(options.limit)) : runs.length;
  const runAudits = runs.slice(0, limit).map((registryRun) => {
    const manifestPath = readString(registryRun?.manifest_path);
    const manifest = manifestPath && fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
    const registrationPath =
      readString(manifest?.promotion_result?.registration_path) ||
      readString(registryRun?.registration_path);
    const registration = registrationPath && fs.existsSync(registrationPath) ? readJson(registrationPath) : null;
    return {
      run_id: readString(registryRun?.run_id) || null,
      ...auditTrainingRun({
        registryRun,
        manifest,
        registration,
        nowMs: options.nowMs,
      }),
    };
  });
  const errorCount = runAudits.reduce((sum, entry) => sum + entry.error_count, 0);
  const warningCount = runAudits.reduce((sum, entry) => sum + entry.warning_count, 0);
  return {
    ok: errorCount === 0,
    clean: errorCount === 0 && warningCount === 0,
    run_count: runAudits.length,
    error_count: errorCount,
    warning_count: warningCount,
    runs_with_errors: runAudits.filter((entry) => entry.error_count > 0).length,
    runs_with_warnings: runAudits.filter((entry) => entry.warning_count > 0).length,
    runs: runAudits,
  };
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
  const integrity = buildDatasetIntegrity({
    corpusRecords: curated.records,
    trainRecords: split.train_records,
    evalRecords: split.eval_records,
  });
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
      integrity,
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
    primary_watchdog_contract: {
      max_soak_age_minutes: 240,
      soak_cycles: 1,
      interval_seconds: 0,
    },
    safe_promotion_metadata: {
      allowed_now: false,
      blockers: [
        "adapter_artifacts_missing",
        ...(gate.ready ? [] : ["promotion_gate_not_clean"]),
      ],
      target_candidate_id: candidateId,
      target_base_model: model,
      target_corpus_sha256: integrity.corpus_sha256,
      target_train_sha256: integrity.train_sha256,
      target_eval_sha256: integrity.eval_sha256,
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
    dataset_integrity_ok: integrity.split_coverage_ok,
    corpus_sha256: integrity.corpus_sha256,
    train_sha256: integrity.train_sha256,
    eval_sha256: integrity.eval_sha256,
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
  const registryAudit = buildTrainingRegistryAudit(registry, { limit: 10 });
  const latestRunAudit = Array.isArray(registryAudit.runs) ? registryAudit.runs[0] || null : null;
  const trainingCommand = detectTrainingCommand();
  const promotionCommand = detectPromotionCommand();
  const integrationCommand = detectIntegrationCommand();
  const cutoverCommand = detectCutoverCommand();
  const soakCommand = detectSoakCommand();
  const verifyCommand = detectVerifyCommand();
  const latestPrimaryWatchdog = buildPrimaryWatchdogState(
    latestRun,
    latestRun?.manifest_path && fs.existsSync(latestRun.manifest_path) ? readJson(latestRun.manifest_path) : null
  );
  const effectiveLatestStatus = latestRunAudit?.proof?.effective_status || latestRun?.status || null;
  const latestStatusRegressed = latestRunAudit?.proof?.status_regressed === true;
  return {
    ok: true,
    current_model: currentModel(),
    trainer,
    training_command: trainingCommand,
    promotion_command: promotionCommand,
    integration_command: integrationCommand,
    cutover_command: cutoverCommand,
    soak_command: soakCommand,
    watchdog_command: detectWatchdogCommand(),
    verify_command: verifyCommand,
    latest_run: latestRun,
    latest_run_effective_status: effectiveLatestStatus,
    latest_run_proof: latestRunAudit?.proof || null,
    latest_run_audit:
      latestRunAudit
        ? {
            status: latestRunAudit.status,
            reported_status: latestRunAudit.reported_status,
            status_regressed: latestRunAudit.status_regressed,
            ok: latestRunAudit.ok,
            clean: latestRunAudit.clean,
            error_count: latestRunAudit.error_count,
            warning_count: latestRunAudit.warning_count,
            findings: latestRunAudit.findings,
          }
        : null,
    registry_audit:
      registryAudit
        ? {
            ok: registryAudit.ok,
            clean: registryAudit.clean,
            run_count: registryAudit.run_count,
            error_count: registryAudit.error_count,
            warning_count: registryAudit.warning_count,
            runs_with_errors: registryAudit.runs_with_errors,
            runs_with_warnings: registryAudit.runs_with_warnings,
          }
        : null,
    primary_watchdog: latestPrimaryWatchdog,
    training_root: TRAINING_ROOT,
    registry_path: REGISTRY_PATH,
    recommended_bootstrap_command: trainer.trainer_ready ? null : "npm run local:training:bootstrap",
    recommended_next_target:
      latestStatusRegressed
        ? "The recorded lane status regressed behind later-stage evidence. Run `npm run local:training:verify` before any new promote, cutover, or watchdog action."
        : effectiveLatestStatus === "training_ready"
        ? "Run the bounded local adapter trainer against the prepared packet."
        : effectiveLatestStatus === "prepared_blocked" && latestRun?.readiness_blockers?.length === 0
          ? "Run the bounded local adapter trainer against the prepared packet."
          : effectiveLatestStatus === "adapter_trained_unpromoted" && promotionCommand.available
          ? "Run the bounded local adapter promotion gate before treating this candidate as router-eligible."
            : effectiveLatestStatus === "adapter_registered" && integrationCommand.available
              ? "Run the bounded integration command so the accepted adapter becomes a real MLX backend or Ollama companion."
              : effectiveLatestStatus === "adapter_registered"
                ? "Wire a bounded integration command so the accepted adapter becomes a real MLX backend or Ollama companion."
                : effectiveLatestStatus === "adapter_served_mlx" || effectiveLatestStatus === "adapter_exported_ollama"
                  ? cutoverCommand.available
                    ? "The accepted adapter is live as a reachable local backend; run the bounded cutover command if you want it to become router-default."
                    : "The accepted adapter is live as a reachable local backend; wire an explicit cutover command before making it router-default."
                : effectiveLatestStatus === "adapter_primary_mlx" || effectiveLatestStatus === "adapter_primary_ollama"
                  ? latestPrimaryWatchdog.primary_soak_ok === true
                    ? latestPrimaryWatchdog.should_run_watchdog && detectWatchdogCommand().available
                      ? "The accepted adapter is still primary but its confidence proof is stale; run the bounded watchdog to refresh or trip rollback."
                      : "The accepted adapter survived the bounded soak; keep the rollback path in place while you gather longer-running production evidence."
                    : soakCommand.available
                      ? "The accepted adapter is the active router default; run the bounded soak command to keep comparing it against the rollback path."
                      : "The accepted adapter is the active router default; wire a bounded soak command so regressions trigger rollback instead of drifting silently."
              : effectiveLatestStatus === "adapter_rejected"
                ? "Tune the corpus or training parameters, then rerun prepare, train, and promote."
                : latestRun?.readiness_blockers?.includes?.("training.command_unwired")
                  ? "Wire a local adapter train command that consumes the prepared packet."
                  : null,
  };
}

function auditLane() {
  const trainer = detectTrainerAvailability();
  const registry = loadRegistry();
  const audit = buildTrainingRegistryAudit(registry, { limit: 25 });
  return {
    ok: audit.ok,
    clean: audit.clean,
    current_model: currentModel(),
    trainer,
    registry_path: REGISTRY_PATH,
    run_count: audit.run_count,
    error_count: audit.error_count,
    warning_count: audit.warning_count,
    runs_with_errors: audit.runs_with_errors,
    runs_with_warnings: audit.runs_with_warnings,
    runs: audit.runs,
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
    action === "audit" || action === "verify"
      ? auditLane()
      : action === "prepare"
        ? prepareLane()
        : action === "bootstrap"
          ? bootstrapLane()
          : statusLane();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
