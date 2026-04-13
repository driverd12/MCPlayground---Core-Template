import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOllamaList,
  resolvePreferredModelOrder,
  summarizeCaseRuns,
  validateModelHostCompatibility,
} from "../scripts/ollama_mlx_postpull.mjs";

test("parseOllamaList extracts model ids from ollama list output", () => {
  const models = parseOllamaList(`
NAME                           ID              SIZE      MODIFIED
qwen3.5:35b-a3b-coding-nvfp4   abc123          21 GB     2 minutes ago
llama3.2:3b                    def456          2 GB      2 weeks ago
`);
  assert.deepEqual(models, ["qwen3.5:35b-a3b-coding-nvfp4", "llama3.2:3b"]);
});

test("resolvePreferredModelOrder keeps the active model first and dedupes fallbacks", () => {
  const models = resolvePreferredModelOrder("qwen3.5:35b-a3b-coding-nvfp4", [
    "llama3.2:3b",
    "qwen3.5:35b-a3b-coding-nvfp4",
    "llama3.2:3b",
  ]);
  assert.deepEqual(models, ["qwen3.5:35b-a3b-coding-nvfp4", "llama3.2:3b"]);
});

test("summarizeCaseRuns computes pass rate and latency aggregates", () => {
  const summary = summarizeCaseRuns([
    { ok: true, latency_ms: 100, throughput_tps: 12 },
    { ok: false, latency_ms: 220, throughput_tps: 8 },
    { ok: true, latency_ms: 180, throughput_tps: 10 },
  ]);
  assert.equal(summary.total_cases, 3);
  assert.equal(summary.passed_cases, 2);
  assert.equal(summary.failed_cases, 1);
  assert.equal(summary.pass_rate, 66.67);
  assert.equal(summary.average_latency_ms, 166.67);
  assert.equal(summary.best_latency_ms, 100);
  assert.equal(summary.worst_latency_ms, 220);
  assert.equal(summary.average_throughput_tps, 10);
});

test("validateModelHostCompatibility rejects the MLX preview path on non-Apple-Silicon hosts", () => {
  const rejected = validateModelHostCompatibility({
    model: "qwen3.5:35b-a3b-coding-nvfp4",
    platform: "linux",
    arch: "x64",
  });
  const accepted = validateModelHostCompatibility({
    model: "qwen3.5:35b-a3b-coding-nvfp4",
    platform: "darwin",
    arch: "arm64",
  });
  const generic = validateModelHostCompatibility({
    model: "llama3.2:3b",
    platform: "linux",
    arch: "x64",
  });

  assert.equal(rejected.ok, false);
  assert.match(String(rejected.reason), /apple silicon/i);
  assert.equal(accepted.ok, true);
  assert.equal(generic.ok, true);
  assert.equal(generic.requires_apple_silicon, false);
});
