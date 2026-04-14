#!/usr/bin/env node

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

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeJsonl(filePath, rows) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function loadRegistry() {
  const registry = readJson(REGISTRY_PATH);
  return registry && typeof registry === "object"
    ? registry
    : {
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
  const records = buildCorpusRecords(snapshot?.payload || {}, reports.map((entry) => entry.payload));
  const gate = latestPromotionGate(reports, model);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(TRAINING_ROOT, runId);
  const corpusPath = path.join(runDir, "corpus.jsonl");
  const manifestPath = path.join(runDir, "manifest.json");
  const currentPromotedModel = currentModel();
  const manifest = {
    generated_at: new Date().toISOString(),
    run_id: runId,
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
    },
    corpus: {
      path: corpusPath,
      record_count: records.length,
      format: "jsonl/plain_text_corpus",
    },
    status: trainer.trainer_ready ? "prepared" : "prepared_without_trainer",
    next_action: trainer.trainer_ready
      ? "Review the curated corpus and wire an explicit train command before running any local adapter job."
      : "Run `npm run local:training:bootstrap` before attempting any local adapter run.",
  };
  writeJsonl(corpusPath, records);
  writeJson(manifestPath, manifest);
  saveRegistry({
    generated_at: manifest.generated_at,
    run_id: runId,
    base_model: model,
    manifest_path: manifestPath,
    corpus_path: corpusPath,
    record_count: records.length,
    trainer_ready: trainer.trainer_ready,
    promotion_gate_ready: gate.ready,
  });
  return {
    ok: true,
    prepared: true,
    manifest_path: manifestPath,
    corpus_path: corpusPath,
    record_count: records.length,
    trainer,
    promotion_gate: gate,
  };
}

function statusLane() {
  const trainer = detectTrainerAvailability();
  const registry = loadRegistry();
  const latestRun = Array.isArray(registry.runs) && registry.runs.length > 0 ? registry.runs[0] : null;
  return {
    ok: true,
    current_model: currentModel(),
    trainer,
    latest_run: latestRun,
    training_root: TRAINING_ROOT,
    registry_path: REGISTRY_PATH,
    recommended_bootstrap_command: trainer.trainer_ready ? null : "npm run local:training:bootstrap",
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
