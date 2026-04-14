import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOllamaModelfile,
  resolveIntegrationTarget,
} from "../scripts/local_adapter_integrate.mjs";
import { buildIntegrationConsideration } from "../scripts/local_adapter_promote.mjs";

function qwenManifest() {
  return {
    candidate_id: "local-adapter-qwen",
    host: {
      platform: "darwin",
      arch: "arm64",
    },
    trainer: {
      trainer_ready: true,
      python_path: "/tmp/python",
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

test("resolveIntegrationTarget prefers MLX for the current Apple Silicon Qwen adapter lane", () => {
  const manifest = qwenManifest();
  const registration = {
    decision: {
      status: "registered",
      accepted: true,
      integration_consideration: buildIntegrationConsideration(manifest, { status: "registered" }),
    },
  };

  const decision = resolveIntegrationTarget(manifest, registration, "auto");
  assert.equal(decision.ok, true);
  assert.equal(decision.target, "mlx");
});

test("resolveIntegrationTarget allows an Ollama export path when the adapter family is supported", () => {
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
  const registration = {
    decision: {
      status: "registered",
      accepted: true,
      integration_consideration: buildIntegrationConsideration(manifest, { status: "registered" }),
    },
  };

  const decision = resolveIntegrationTarget(manifest, registration, "ollama");
  assert.equal(decision.ok, true);
  assert.equal(decision.target, "ollama");
});

test("resolveIntegrationTarget infers a target when legacy registration metadata omits recommended_target", () => {
  const manifest = qwenManifest();
  const registration = {
    decision: {
      status: "registered",
      accepted: true,
      integration_consideration: {
        router: {
          eligible: true,
          live_ready: false,
          blockers: ["mlx_adapter_serving_path_not_implemented"],
          planned_backend: {
            backend_id: "mlx-adapter-local-adapter-qwen",
            model_id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
          },
        },
        ollama: {
          eligible: true,
          live_ready: false,
          blockers: ["ollama_adapter_export_not_implemented"],
          target_runtime_model: "qwen3.5:35b-a3b-coding-nvfp4",
        },
      },
    },
  };

  const decision = resolveIntegrationTarget(manifest, registration, "auto");
  assert.equal(decision.ok, true);
  assert.equal(decision.target, "mlx");
});

test("buildOllamaModelfile emits a valid base-plus-adapter import file", () => {
  const modelfile = buildOllamaModelfile({
    baseModelPath: "/tmp/base-model",
    adapterPath: "/tmp/adapter",
  });

  assert.equal(modelfile, "FROM /tmp/base-model\nADAPTER /tmp/adapter\n");
});
