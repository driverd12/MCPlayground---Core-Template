import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIntegrationConsideration,
  buildOllamaCompanionName,
  decidePromotion,
  detectAdapterArchitecture,
  resolvePromotionReplayGuard,
} from "../scripts/local_adapter_promote.mjs";

function sampleManifest() {
  return {
    candidate_id: "local-adapter-sample",
    host: {
      platform: "darwin",
      arch: "arm64",
    },
    trainer: {
      trainer_ready: true,
    },
    base_model: "qwen3.5:35b-a3b-coding-nvfp4",
    training_result: {
      adapter_path: "/tmp/adapter",
    },
    training_target: {
      requested_model_ref: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      resolved_model_ref: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      resolved_model_path: "/tmp/qwen-base",
    },
  };
}

test("buildIntegrationConsideration stays truthful about router and Ollama blockers", () => {
  const accepted = buildIntegrationConsideration(sampleManifest(), { status: "registered" });
  const rejected = buildIntegrationConsideration(sampleManifest(), { status: "rejected" });

  assert.equal(accepted.recommended_target, "mlx");
  assert.equal(accepted.router.eligible, true);
  assert.equal(accepted.router.live_ready, false);
  assert.ok(accepted.router.blockers.includes("mlx_integration_pending"));
  assert.equal(accepted.ollama.eligible, false);
  assert.ok(accepted.ollama.blockers.includes("ollama_adapter_architecture_unsupported:qwen"));
  assert.equal(accepted.ollama.planned_backend.model_id, buildOllamaCompanionName(sampleManifest()));

  assert.equal(rejected.router.eligible, false);
  assert.ok(rejected.router.blockers.includes("candidate_not_registered"));
});

test("detectAdapterArchitecture and integration consideration allow Ollama export for supported families", () => {
  const manifest = {
    candidate_id: "local-adapter-llama",
    host: {
      platform: "linux",
      arch: "x64",
    },
    trainer: {
      trainer_ready: true,
    },
    base_model: "llama3.2:3b",
    training_result: {
      adapter_path: "/tmp/adapter",
    },
    training_target: {
      requested_model_ref: "meta-llama/Llama-3.2-3B-Instruct",
      resolved_model_ref: "meta-llama/Llama-3.2-3B-Instruct",
      resolved_model_path: "/tmp/llama-base",
    },
  };

  assert.equal(detectAdapterArchitecture(manifest), "llama");
  const consideration = buildIntegrationConsideration(manifest, { status: "registered" });
  assert.equal(consideration.recommended_target, "ollama");
  assert.equal(consideration.router.eligible, false);
  assert.equal(consideration.ollama.eligible, true);
  assert.ok(consideration.ollama.blockers.includes("ollama_export_pending"));
});

test("decidePromotion registers only when both the report and eval gate are green", () => {
  const registered = decidePromotion({
    manifest: sampleManifest(),
    report: {
      summary: {
        accepted: true,
        reward_score: 86,
        baseline_score: 82,
        delta_score: 4,
        blockers: [],
      },
    },
    evalRun: {
      ok: true,
      aggregate_metric_value: 100,
    },
  });
  const rejected = decidePromotion({
    manifest: sampleManifest(),
    report: {
      summary: {
        accepted: false,
        reward_score: 60,
        baseline_score: 80,
        delta_score: -20,
        blockers: ["adapter_reward_below_gate"],
      },
    },
    evalRun: {
      ok: false,
      aggregate_metric_value: 0,
    },
  });

  assert.equal(registered.status, "registered");
  assert.equal(registered.accepted, true);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.blockers.includes("adapter_reward_below_gate"));
  assert.ok(rejected.blockers.includes("eval_gate_failed"));
});

test("resolvePromotionReplayGuard blocks re-running promote after integration or cutover evidence exists", () => {
  const guard = resolvePromotionReplayGuard({
    ...sampleManifest(),
    status: "adapter_registered",
    integration_result: {
      ok: true,
      target: "mlx",
      backend_id: "mlx-adapter-local-adapter-sample",
    },
    cutover_result: {
      ok: true,
      promoted: true,
      target: "mlx",
      active_default_backend_id: "mlx-adapter-local-adapter-sample",
    },
    primary_soak_result: {
      ok: true,
    },
  });

  assert.equal(guard.ok, false);
  assert.equal(guard.reported_status, "adapter_registered");
  assert.equal(guard.effective_stage, "adapter_primary_mlx");
  assert.ok(guard.blockers.includes("promotion_stage_regression_blocked"));
  assert.ok(guard.next_action.includes("do not rerun promote"));
});
