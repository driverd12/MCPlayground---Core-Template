import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTrainingReadiness,
  buildCorpusRecords,
  curateCorpusRecords,
  detectTrainerAvailability,
  detectAdapterArtifacts,
  detectIntegrationCommand,
  detectPromotionCommand,
  detectTrainingCommand,
  resolveTrainerPython,
  splitCuratedCorpus,
} from "../scripts/local_adapter_lane.mjs";

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
});
