import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePromotionGate,
  parseOllamaList,
  selectRollbackTarget,
  resolvePreferredModelOrder,
  shouldPromoteModel,
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

test("shouldPromoteModel only promotes fully passing capability soaks", () => {
  assert.equal(
    shouldPromoteModel({
      total_cases: 5,
      failed_cases: 0,
    }),
    true
  );
  assert.equal(
    shouldPromoteModel({
      total_cases: 5,
      failed_cases: 1,
    }),
    false
  );
  assert.equal(
    shouldPromoteModel({
      total_cases: 0,
      failed_cases: 0,
    }),
    false
  );
});

test("selectRollbackTarget prefers a healthy non-candidate local Ollama backend", () => {
  const target = selectRollbackTarget({
    currentModel: "qwen3.5:35b-a3b-coding-nvfp4",
    candidateBackendId: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
    routerState: {
      backends: [
        {
          backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
          model_id: "qwen3.5:35b-a3b-coding-nvfp4",
          provider: "ollama",
          enabled: true,
          capabilities: {
            probe_healthy: false,
            probe_model_loaded: false,
          },
        },
        {
          backend_id: "ollama-llama3-2-3b",
          model_id: "llama3.2:3b",
          provider: "ollama",
          enabled: true,
          capabilities: {
            probe_healthy: true,
            probe_model_loaded: true,
          },
        },
      ],
    },
  });
  assert.deepEqual(target, {
    model: "llama3.2:3b",
    backend_id: "ollama-llama3-2-3b",
  });
});

test("evaluatePromotionGate blocks unhealthy candidates and default drift", () => {
  const gate = evaluatePromotionGate({
    model: "qwen3.5:35b-a3b-coding-nvfp4",
    currentModel: "qwen3.5:35b-a3b-coding-nvfp4",
    summary: {
      total_cases: 5,
      failed_cases: 2,
      pass_rate: 60,
    },
    benchmarkRun: {
      ok: true,
      aggregate_metric_value: 100,
      suite: { suite_id: "autonomy.smoke.local" },
    },
    evalRun: {
      ok: true,
      aggregate_metric_value: 100,
      suite: { suite_id: "autonomy.control-plane" },
    },
    routerStatus: {
      state: {
        default_backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
        backends: [
          {
            backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
            model_id: "qwen3.5:35b-a3b-coding-nvfp4",
            provider: "ollama",
            enabled: true,
            tags: ["local", "ollama", "gpu", "primary"],
            capabilities: {
              probe_healthy: false,
              probe_model_known: true,
              probe_model_loaded: false,
              probe_benchmark_ok: false,
            },
          },
          {
            backend_id: "ollama-llama3-2-3b",
            model_id: "llama3.2:3b",
            provider: "ollama",
            enabled: true,
            tags: ["local", "ollama", "gpu"],
            capabilities: {
              probe_healthy: true,
              probe_model_known: true,
              probe_model_loaded: true,
              probe_benchmark_ok: true,
            },
          },
        ],
      },
    },
    routeResult: {
      selected_backend: {
        backend_id: "ollama-llama3-2-3b",
      },
      ranked_backends: [
        { backend: { backend_id: "ollama-llama3-2-3b" } },
        { backend: { backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4" } },
      ],
    },
    bootstrapStatus: {
      repairs_needed: ["eval.suite.default_drift"],
    },
    officeSnapshot: {
      generated_at: "2026-04-15T13:38:16.534Z",
      setup_diagnostics: {
        provider_bridge: { stale: false },
        desktop_control: {},
        patient_zero: { enabled: true, browser_ready: true },
        fallback: {
          core_usable: true,
          provider_bridge_degraded: false,
          desktop_degraded: false,
        },
        launchers: {
          office_gui: { supported: true, ready: true, degraded: false },
          agentic_suite: { supported: true, ready: true, degraded: false },
        },
        next_actions: [],
      },
    },
  });

  assert.equal(gate.ready, false);
  assert.match(gate.blockers.join(","), /capability_soak\.failed/);
  assert.match(gate.blockers.join(","), /router\.candidate_probe_unhealthy/);
  assert.match(gate.blockers.join(","), /router\.route_not_candidate/);
  assert.match(gate.blockers.join(","), /eval\.default_drift/);
});

test("evaluatePromotionGate passes when soak, benchmark, route, eval, and rollback evidence are all green", () => {
  const gate = evaluatePromotionGate({
    model: "qwen3.5:35b-a3b-coding-nvfp4",
    currentModel: "llama3.2:3b",
    summary: {
      total_cases: 5,
      failed_cases: 0,
      pass_rate: 100,
    },
    benchmarkRun: {
      ok: true,
      aggregate_metric_value: 100,
      run_id: "benchmark-run-test",
      suite: { suite_id: "autonomy.smoke.local" },
    },
    evalRun: {
      ok: true,
      aggregate_metric_value: 100,
      run_id: "eval-run-test",
      suite: { suite_id: "autonomy.control-plane" },
    },
    routerStatus: {
      state: {
        default_backend_id: "ollama-llama3-2-3b",
        backends: [
          {
            backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
            model_id: "qwen3.5:35b-a3b-coding-nvfp4",
            provider: "ollama",
            enabled: true,
            tags: ["local", "ollama", "gpu", "apple-silicon"],
            throughput_tps: 250,
            latency_ms_p50: 700,
            capabilities: {
              probe_healthy: true,
              probe_model_known: true,
              probe_model_loaded: true,
              probe_benchmark_ok: true,
            },
          },
          {
            backend_id: "ollama-llama3-2-3b",
            model_id: "llama3.2:3b",
            provider: "ollama",
            enabled: true,
            tags: ["local", "ollama", "gpu"],
            capabilities: {
              probe_healthy: true,
              probe_model_known: true,
              probe_model_loaded: true,
              probe_benchmark_ok: true,
            },
          },
        ],
      },
    },
    routeResult: {
      selected_backend: {
        backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
      },
      ranked_backends: [
        { backend: { backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4" } },
        { backend: { backend_id: "ollama-llama3-2-3b" } },
      ],
    },
    bootstrapStatus: {
      repairs_needed: [],
    },
    officeSnapshot: {
      generated_at: "2026-04-15T13:38:16.534Z",
      setup_diagnostics: {
        provider_bridge: { stale: false },
        desktop_control: {},
        patient_zero: { enabled: true, browser_ready: true },
        fallback: {
          core_usable: true,
          provider_bridge_degraded: false,
          desktop_degraded: false,
        },
        launchers: {
          office_gui: { supported: true, ready: true, degraded: false },
          agentic_suite: { supported: true, ready: true, degraded: false },
        },
        next_actions: [],
      },
    },
  });

  assert.equal(gate.ready, true);
  assert.equal(gate.blockers.length, 0);
  assert.deepEqual(gate.evidence.rollback, {
    available: true,
    model: "llama3.2:3b",
    backend_id: "ollama-llama3-2-3b",
  });
});

test("evaluatePromotionGate blocks office truth regressions before cutover", () => {
  const gate = evaluatePromotionGate({
    model: "qwen3.5:35b-a3b-coding-nvfp4",
    currentModel: "llama3.2:3b",
    summary: {
      total_cases: 5,
      failed_cases: 0,
      pass_rate: 100,
    },
    benchmarkRun: {
      ok: true,
      aggregate_metric_value: 100,
      run_id: "benchmark-run-test",
      suite: { suite_id: "autonomy.smoke.local" },
    },
    evalRun: {
      ok: true,
      aggregate_metric_value: 100,
      run_id: "eval-run-test",
      suite: { suite_id: "autonomy.control-plane" },
    },
    routerStatus: {
      state: {
        default_backend_id: "ollama-llama3-2-3b",
        backends: [
          {
            backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
            model_id: "qwen3.5:35b-a3b-coding-nvfp4",
            provider: "ollama",
            enabled: true,
            tags: ["local", "ollama", "gpu", "apple-silicon"],
            capabilities: {
              probe_healthy: true,
              probe_model_known: true,
              probe_model_loaded: true,
              probe_benchmark_ok: true,
            },
          },
          {
            backend_id: "ollama-llama3-2-3b",
            model_id: "llama3.2:3b",
            provider: "ollama",
            enabled: true,
            tags: ["local", "ollama", "gpu"],
            capabilities: {
              probe_healthy: true,
              probe_model_known: true,
              probe_model_loaded: true,
              probe_benchmark_ok: true,
            },
          },
        ],
      },
    },
    routeResult: {
      selected_backend: {
        backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
      },
      ranked_backends: [
        { backend: { backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4" } },
        { backend: { backend_id: "ollama-llama3-2-3b" } },
      ],
    },
    bootstrapStatus: {
      repairs_needed: [],
    },
    officeSnapshot: {
      generated_at: "2026-04-15T13:38:16.534Z",
      setup_diagnostics: {
        provider_bridge: { stale: false },
        desktop_control: {},
        patient_zero: { enabled: true, browser_ready: true },
        fallback: {
          core_usable: false,
          provider_bridge_degraded: false,
          desktop_degraded: false,
        },
        launchers: {
          office_gui: { supported: true, ready: true, degraded: false },
          agentic_suite: { supported: true, ready: false, degraded: true },
        },
        next_actions: ["Run `npm run autonomy:ensure`."],
      },
    },
  });

  assert.equal(gate.ready, false);
  assert.match(gate.blockers.join(","), /office\.core_unusable/);
  assert.match(gate.blockers.join(","), /office\.agentic_suite_not_ready/);
  assert.match(gate.blockers.join(","), /office\.agentic_suite_degraded/);
  assert.equal(gate.evidence.office_truth.ok, false);
});
