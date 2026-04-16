import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertPreparedDataset,
  auditPreparedDataset,
  auditTrainingRun,
  buildDatasetIntegrity,
  buildTrainingRegistryAudit,
  buildTrainingReadiness,
  buildPrimaryWatchdogState,
  buildCorpusRecords,
  curateCorpusRecords,
  detectTrainerAvailability,
  detectAdapterArtifacts,
  detectCutoverCommand,
  detectIntegrationCommand,
  detectPromotionCommand,
  detectSoakCommand,
  detectVerifyCommand,
  detectWatchdogCommand,
  detectTrainingCommand,
  resolveTrainerPython,
  splitCuratedCorpus,
} from "../scripts/local_adapter_lane.mjs";

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

test("buildCorpusRecords curates plain-text corpus rows from snapshots and reports", () => {
  const records = buildCorpusRecords(
    {
      recent_memories: [
        { id: 1, content_preview: "memory one" },
        { id: 2, content_preview: "memory one" },
      ],
      recent_transcript_lines: [
        { id: 10, content_preview: "transcript one" },
      ],
    },
    [
      {
        model: "qwen3.5:35b-a3b-coding-nvfp4",
        report_path: "/tmp/report.json",
        summary: {
          pass_rate: 100,
          average_latency_ms: 123,
          average_throughput_tps: 7.5,
        },
      },
    ]
  );
  assert.equal(records.some((entry) => entry.source_type === "recent_memory"), true);
  assert.equal(records.some((entry) => entry.source_type === "recent_transcript_line"), true);
  assert.equal(records.some((entry) => entry.source_type === "capability_report"), true);
});

test("detectTrainerAvailability only reports ready when python, mlx, and mlx_lm probes pass", () => {
  const ready = detectTrainerAvailability({
    python_path: "/tmp/python-ready",
    python: { ok: true, stderr: "" },
    mlx: { ok: true, stderr: "" },
    mlxLm: { ok: true, stderr: "" },
  });
  const blocked = detectTrainerAvailability({
    python_path: "/tmp/python-blocked",
    python: { ok: true, stderr: "" },
    mlx: { ok: false, stderr: "No module named mlx" },
    mlxLm: { ok: false, stderr: "No module named mlx_lm" },
  });
  assert.equal(ready.trainer_ready, true);
  assert.equal(ready.backend, "mlx_lm");
  assert.equal(ready.python_path, "/tmp/python-ready");
  assert.equal(blocked.trainer_ready, false);
});

test("resolveTrainerPython prefers explicit or repo-local MLX python candidates", () => {
  const chosen = resolveTrainerPython({ python_path: "/definitely/missing/python" });
  assert.equal(typeof chosen, "string");
  assert.ok(chosen.length > 0);
});

test("curateCorpusRecords filters duplicates and too-short corpus entries", () => {
  const curated = curateCorpusRecords([
    {
      source_type: "recent_memory",
      source_id: 1,
      text: "This is a long enough memory entry for the local adapter lane packet.",
    },
    {
      source_type: "recent_transcript_line",
      source_id: 2,
      text: "This   is a long enough memory entry for the local adapter lane packet.",
    },
    {
      source_type: "recent_memory",
      source_id: 3,
      text: "tiny",
    },
    {
      source_type: "capability_report",
      source_id: 4,
      text: "Capability report says the current local model is passing all smoke cases with strong latency.",
    },
  ]);

  assert.equal(curated.records.length, 2);
  assert.equal(curated.stats.rejected_duplicate, 1);
  assert.equal(curated.stats.rejected_too_short, 1);
  assert.equal(curated.records[0].record_id.startsWith("corpus-"), true);
});

test("splitCuratedCorpus creates a deterministic eval holdout", () => {
  const records = Array.from({ length: 10 }, (_, index) => ({
    record_id: `corpus-${String(index).padStart(2, "0")}`,
    text: `Record ${index} with enough content to stay in the training packet.`,
  }));
  const split = splitCuratedCorpus(records);

  assert.equal(split.eval_records.length, 2);
  assert.equal(split.train_records.length, 8);
  assert.deepEqual(
    split.eval_records.map((entry) => entry.record_id),
    ["corpus-00", "corpus-01"]
  );
});

test("buildDatasetIntegrity records a clean disjoint split", () => {
  const corpusRecords = [
    {
      record_id: "corpus-00",
      source_type: "recent_memory",
      source_id: 1,
      fingerprint: "fingerprint-00",
      text: "First corpus record with enough content to stay in the prepared packet.",
    },
    {
      record_id: "corpus-01",
      source_type: "recent_transcript_line",
      source_id: 2,
      fingerprint: "fingerprint-01",
      text: "Second corpus record with enough content to stay in the prepared packet.",
    },
    {
      record_id: "corpus-02",
      source_type: "capability_report",
      source_id: 3,
      fingerprint: "fingerprint-02",
      text: "Third corpus record with enough content to stay in the prepared packet.",
    },
  ];
  const integrity = buildDatasetIntegrity({
    corpusRecords,
    trainRecords: corpusRecords.slice(1),
    evalRecords: corpusRecords.slice(0, 1),
  });

  assert.equal(integrity.contract_version.includes("dataset_integrity"), true);
  assert.equal(integrity.split_coverage_ok, true);
  assert.equal(integrity.train_eval_overlap_count, 0);
  assert.equal(integrity.corpus_missing_from_splits_count, 0);
  assert.equal(integrity.train_missing_from_corpus_count, 0);
  assert.equal(integrity.eval_missing_from_corpus_count, 0);
});

test("buildTrainingReadiness stays blocked until trainer, gate, data, and command are all present", () => {
  const blocked = buildTrainingReadiness({
    trainer: { trainer_ready: false },
    promotion_gate: { ready: false },
    train_records: [],
    eval_records: [],
    snapshot_path: null,
    capability_reports: [],
    training_command: { available: false },
  });
  const ready = buildTrainingReadiness({
    trainer: { trainer_ready: true },
    promotion_gate: { ready: false },
    train_records: [{ record_id: "corpus-1" }],
    eval_records: [{ record_id: "corpus-2" }],
    snapshot_path: "/tmp/snapshot.json",
    capability_reports: ["/tmp/report.json"],
    training_command: { available: true },
  });

  assert.equal(blocked.ready_for_training_execution, false);
  assert.match(blocked.blockers.join(","), /trainer\.backend_unavailable/);
  assert.match(blocked.blockers.join(","), /training\.command_unwired/);
  assert.equal(ready.ready_for_training_execution, true);
  assert.equal(ready.ready_for_safe_promotion, false);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(ready.promotion_blockers, ["promotion_gate.blocked"]);
});

test("auditPreparedDataset detects packet hash drift and train/eval overlap", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-adapter-dataset-audit-"));
  try {
    const manifestPath = path.join(tempDir, "manifest.json");
    const corpusPath = path.join(tempDir, "corpus.jsonl");
    const trainPath = path.join(tempDir, "train.jsonl");
    const evalPath = path.join(tempDir, "eval.jsonl");
    const corpusRows = [
      {
        record_id: "corpus-00",
        source_type: "recent_memory",
        source_id: 1,
        fingerprint: "fingerprint-00",
        text: "First corpus row with enough content to stay in the packet.",
      },
      {
        record_id: "corpus-01",
        source_type: "recent_transcript_line",
        source_id: 2,
        fingerprint: "fingerprint-01",
        text: "Second corpus row with enough content to stay in the packet.",
      },
    ];
    const trainRows = [corpusRows[1]];
    const evalRows = [corpusRows[0]];
    writeJsonl(corpusPath, corpusRows);
    writeJsonl(trainPath, trainRows);
    writeJsonl(evalPath, evalRows);
    writeJson(manifestPath, {
      schema_version: "local_training_packet.v2",
      run_id: "run-audit",
      candidate_id: "candidate-audit",
      corpus: {
        path: corpusPath,
        train_path: trainPath,
        eval_path: evalPath,
        integrity: buildDatasetIntegrity({
          corpusRecords: corpusRows,
          trainRecords: trainRows,
          evalRecords: evalRows,
        }),
      },
    });

    writeJsonl(trainPath, [corpusRows[0]]);
    writeJsonl(evalPath, [corpusRows[0]]);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const audit = auditPreparedDataset(manifest);
    assert.equal(audit.ok, false);
    assert.ok(audit.findings.some((entry) => entry.code === "dataset.train_hash_drift"));
    assert.ok(audit.findings.some((entry) => entry.code === "dataset.train_eval_overlap"));
    assert.ok(audit.findings.some((entry) => entry.code === "dataset.split_coverage_drift"));

    assert.throws(() => assertPreparedDataset(manifest), /failed integrity checks/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detectAdapterArtifacts only reports full artifact presence when config, weights, and metrics exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-adapter-lane-"));
  try {
    fs.writeFileSync(path.join(tempDir, "adapter_config.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "adapter_model.safetensors"), "", "utf8");
    const partial = detectAdapterArtifacts(tempDir);
    assert.equal(partial.all_present, false);
    assert.equal(partial.missing.includes("training_metrics"), true);

    fs.writeFileSync(path.join(tempDir, "metrics.json"), "{}\n", "utf8");
    const full = detectAdapterArtifacts(tempDir);
    assert.equal(full.all_present, true);
    assert.equal(full.present.length, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("training lane commands are all discoverable from the current repo wiring", () => {
  assert.equal(detectTrainingCommand().available, true);
  assert.equal(detectPromotionCommand().available, true);
  assert.equal(detectIntegrationCommand().available, true);
  assert.equal(detectCutoverCommand().available, true);
  assert.equal(detectSoakCommand().available, true);
  assert.equal(detectWatchdogCommand().available, true);
  assert.equal(detectVerifyCommand().available, true);
});

test("buildPrimaryWatchdogState flags stale primary soak confidence", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-14T15:00:01.000Z");
  try {
    const fresh = buildPrimaryWatchdogState(
      {
        status: "adapter_primary_mlx",
        primary_soak_ok: true,
        primary_soak_completed_at: "2026-04-14T12:00:00.000Z",
      },
      {
        primary_watchdog_contract: {
          max_soak_age_minutes: 240,
        },
      }
    );
    assert.equal(fresh.should_run_watchdog, false);

    const stale = buildPrimaryWatchdogState(
      {
        status: "adapter_primary_mlx",
        primary_soak_ok: true,
        primary_soak_completed_at: "2026-04-14T10:00:00.000Z",
      },
      {
        primary_watchdog_contract: {
          max_soak_age_minutes: 240,
        },
      }
    );
    assert.equal(stale.should_run_watchdog, true);
    assert.equal(stale.stale, true);
  } finally {
    Date.now = originalNow;
  }
});

test("auditTrainingRun verifies a fully integrated primary candidate and flags stale confidence separately", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-adapter-audit-pass-"));
  try {
    const manifestPath = path.join(tempDir, "manifest.json");
    const registrationPath = path.join(tempDir, "registration.json");
    const corpusPath = path.join(tempDir, "corpus.jsonl");
    const trainPath = path.join(tempDir, "train.jsonl");
    const evalPath = path.join(tempDir, "eval.jsonl");
    const adapterDir = path.join(tempDir, "adapter");
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "adapter_config.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(adapterDir, "adapter_model.safetensors"), "", "utf8");
    writeJson(path.join(adapterDir, "training_metrics.json"), {
      ok: true,
      generate_smoke: { ok: true },
      parsed_metrics: { test_loss: 1.2 },
    });
    const corpusRows = [
      {
        record_id: "corpus-01",
        source_type: "recent_memory",
        source_id: 1,
        fingerprint: "fingerprint-01",
        text: "corpus row one",
      },
      {
        record_id: "corpus-02",
        source_type: "recent_transcript_line",
        source_id: 2,
        fingerprint: "fingerprint-02",
        text: "corpus row two",
      },
      {
        record_id: "corpus-03",
        source_type: "capability_report",
        source_id: 3,
        fingerprint: "fingerprint-03",
        text: "corpus row three",
      },
    ];
    const trainRows = [corpusRows[1], corpusRows[2]];
    const evalRows = [corpusRows[0]];
    writeJsonl(corpusPath, corpusRows);
    writeJsonl(trainPath, trainRows);
    writeJsonl(evalPath, evalRows);

    const manifest = {
      schema_version: "local_training_packet.v2",
      run_id: "run-1",
      candidate_id: "candidate-1",
      status: "adapter_primary_mlx",
      acceptance_contract: {
        benchmark: { suite_id: "bench", required_aggregate_metric: 100 },
        eval: { suite_id: "eval", required_aggregate_metric: 100 },
      },
      evaluation_targets: {
        ollama: { provider: "ollama" },
        mlx: { provider: "mlx" },
      },
      corpus: {
        path: corpusPath,
        train_path: trainPath,
        eval_path: evalPath,
        record_count: 3,
        train_record_count: 2,
        eval_record_count: 1,
        integrity: buildDatasetIntegrity({
          corpusRecords: corpusRows,
          trainRecords: trainRows,
          evalRecords: evalRows,
        }),
      },
      training_intent: {
        executed: true,
        weights_modified: true,
      },
      training_result: {
        training_metrics_path: path.join(adapterDir, "training_metrics.json"),
        generate_smoke: { ok: true },
      },
      promotion_result: {
        status: "registered",
        benchmark_suite_id: "bench",
        eval_suite_id: "eval",
        reward_score: 80,
        registration_path: registrationPath,
      },
      integration_result: {
        backend_id: "mlx-adapter-candidate-1",
        model_id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      },
      cutover_result: {
        ok: true,
        promoted: true,
        previous_default_backend_id: "ollama-prev",
      },
      rollback_model: "qwen3.5:35b-a3b-coding-nvfp4",
      safe_promotion_metadata: {
        allowed_now: true,
        blockers: [],
      },
      primary_soak_result: {
        ok: true,
        completed_at: "2026-04-14T12:00:00.000Z",
      },
      primary_watchdog_contract: {
        max_soak_age_minutes: 240,
      },
    };
    const registration = {
      decision: {
        status: "registered",
        accepted: true,
      },
      cutover_result: {
        previous_default_backend_id: "ollama-prev",
      },
    };
    writeJson(manifestPath, manifest);
    writeJson(registrationPath, registration);

    const fresh = auditTrainingRun({
      registryRun: {
        run_id: "run-1",
        candidate_id: "candidate-1",
        status: "adapter_primary_mlx",
        manifest_path: manifestPath,
      },
      manifest,
      registration,
      nowMs: Date.parse("2026-04-14T13:00:00.000Z"),
    });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.clean, true);
    assert.equal(fresh.proof.stage, "primary_confidence_fresh");

    const stale = auditTrainingRun({
      registryRun: {
        run_id: "run-1",
        candidate_id: "candidate-1",
        status: "adapter_primary_mlx",
        manifest_path: manifestPath,
      },
      manifest,
      registration,
      nowMs: Date.parse("2026-04-14T18:30:00.000Z"),
    });
    assert.equal(stale.ok, true);
    assert.equal(stale.clean, false);
    assert.equal(stale.proof.stage, "primary_confidence_stale");
    assert.ok(stale.findings.some((entry) => entry.code === "confidence.watchdog_stale"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildTrainingRegistryAudit fails closed on mismatched registry and premature promotion claims", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-adapter-audit-fail-"));
  try {
    const manifestPath = path.join(tempDir, "manifest.json");
    const corpusPath = path.join(tempDir, "corpus.jsonl");
    const trainPath = path.join(tempDir, "train.jsonl");
    const evalPath = path.join(tempDir, "eval.jsonl");
    const corpusRows = [
      {
        record_id: "corpus-01",
        source_type: "recent_memory",
        source_id: 1,
        fingerprint: "fingerprint-01",
        text: "corpus row one",
      },
    ];
    writeJsonl(corpusPath, corpusRows);
    writeJsonl(trainPath, corpusRows);
    writeJsonl(evalPath, corpusRows);
    writeJson(manifestPath, {
      schema_version: "legacy.v1",
      run_id: "manifest-run",
      candidate_id: "manifest-candidate",
      status: "training_ready",
      acceptance_contract: {
        benchmark: { suite_id: "bench" },
        eval: { suite_id: "eval" },
      },
      evaluation_targets: {
        ollama: { provider: "ollama" },
        mlx: { provider: "mlx" },
      },
      corpus: {
        path: corpusPath,
        train_path: trainPath,
        eval_path: evalPath,
        record_count: 1,
        train_record_count: 1,
        eval_record_count: 1,
        integrity: buildDatasetIntegrity({
          corpusRecords: corpusRows,
          trainRecords: corpusRows,
          evalRecords: corpusRows,
        }),
      },
      training_intent: {
        executed: false,
        weights_modified: false,
      },
      safe_promotion_metadata: {
        allowed_now: true,
        blockers: [],
      },
    });

    const audit = buildTrainingRegistryAudit({
      runs: [
        {
          run_id: "registry-run",
          candidate_id: "",
          status: "training_ready",
          manifest_path: manifestPath,
        },
      ],
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.runs.length, 1);
    assert.ok(audit.runs[0].findings.some((entry) => entry.code === "registry.candidate_missing"));
    assert.ok(audit.runs[0].findings.some((entry) => entry.code === "manifest.run_id_mismatch"));
    assert.ok(audit.runs[0].findings.some((entry) => entry.code === "promotion.allowed_too_early"));
    assert.ok(audit.runs[0].findings.some((entry) => entry.code === "manifest.schema_version_legacy"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
