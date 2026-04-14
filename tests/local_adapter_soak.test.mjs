import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSoakHeuristicConfig,
  evaluateSoakRollbackHeuristics,
  resolvePrimarySoakCandidate,
} from "../scripts/local_adapter_soak.mjs";

function sampleManifest(status = "adapter_primary_mlx") {
  return {
    candidate_id: "local-adapter-sample",
    status,
    promotion_result: {
      eval_suite_id: "local-adapter-eval-suite",
      benchmark_suite_id: "local-adapter-benchmark-suite",
      reward_score: 82,
      baseline_score: 76,
    },
    integration_result: {
      target: status.includes("ollama") ? "ollama" : "mlx",
      backend_id: status.includes("ollama") ? "ollama-adapter-local-adapter-sample" : "mlx-adapter-local-adapter-sample",
      model_id: status.includes("ollama")
        ? "local-adapter-sample-ollama"
        : "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      endpoint: status.includes("ollama") ? "http://127.0.0.1:11434" : "http://127.0.0.1:8788",
    },
    cutover_result: {
      previous_default_backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
    },
  };
}

function sampleRegistration() {
  return {
    decision: {
      status: "registered",
      accepted: true,
      integration_consideration: {
        router: {
          planned_backend: {
            backend_id: "mlx-adapter-local-adapter-sample",
            tags: ["local", "mlx", "adapter"],
          },
        },
        ollama: {
          planned_backend: {
            backend_id: "ollama-adapter-local-adapter-sample",
            tags: ["local", "ollama", "adapter"],
          },
        },
      },
    },
  };
}

test("resolvePrimarySoakCandidate requires the adapter to already be the primary backend", () => {
  const blocked = resolvePrimarySoakCandidate(sampleManifest("adapter_served_mlx"), sampleRegistration());
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /active router default/i);
});

test("resolvePrimarySoakCandidate returns the active primary backend and rollback path", () => {
  const candidate = resolvePrimarySoakCandidate(sampleManifest("adapter_primary_mlx"), sampleRegistration());
  assert.equal(candidate.ok, true);
  assert.equal(candidate.target, "mlx");
  assert.equal(candidate.backend_id, "mlx-adapter-local-adapter-sample");
  assert.equal(candidate.previous_default_backend_id, "ollama-qwen3-5-35b-a3b-coding-nvfp4");
  assert.equal(candidate.eval_suite_id, "local-adapter-eval-suite");
  assert.equal(candidate.benchmark_suite_id, "local-adapter-benchmark-suite");
  assert.equal(candidate.promotion_reward_score, 82);
  assert.equal(candidate.baseline_score, 76);
});

test("buildSoakHeuristicConfig returns bounded defaults", () => {
  const config = buildSoakHeuristicConfig({});
  assert.deepEqual(config, {
    max_reward_regression_vs_accepted: 5,
    min_reward_delta_vs_baseline: 0,
    max_consecutive_soft_regressions: 2,
  });
});

test("evaluateSoakRollbackHeuristics requests rollback on severe reward regression", () => {
  const heuristics = evaluateSoakRollbackHeuristics({
    cycleResults: [
      {
        cycle: 1,
        benchmark_metric_value: 74,
      },
    ],
    promotionRewardScore: 82,
    baselineScore: 76,
    config: buildSoakHeuristicConfig({}),
  });
  assert.equal(heuristics.rollback_required, true);
  assert.ok(heuristics.reasons.includes("reward_regressed_from_accepted_score"));
  assert.ok(heuristics.reasons.includes("reward_below_baseline_contract"));
});

test("evaluateSoakRollbackHeuristics tolerates one soft regression but trips on repeated regressions", () => {
  const config = buildSoakHeuristicConfig({});
  const first = evaluateSoakRollbackHeuristics({
    cycleResults: [{ cycle: 1, benchmark_metric_value: 81 }],
    promotionRewardScore: 82,
    baselineScore: 76,
    config,
  });
  assert.equal(first.rollback_required, false);
  assert.equal(first.metrics.consecutive_soft_regressions, 1);

  const second = evaluateSoakRollbackHeuristics({
    cycleResults: [
      { cycle: 1, benchmark_metric_value: 81 },
      { cycle: 2, benchmark_metric_value: 81 },
    ],
    promotionRewardScore: 82,
    baselineScore: 76,
    config,
  });
  assert.equal(second.rollback_required, true);
  assert.ok(second.reasons.includes("consecutive_soft_regressions_exceeded"));
});
