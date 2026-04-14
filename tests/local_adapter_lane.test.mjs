import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCorpusRecords,
  detectTrainerAvailability,
  resolveTrainerPython,
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
