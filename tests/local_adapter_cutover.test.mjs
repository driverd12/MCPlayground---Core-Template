import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveCutoverCandidate,
  verifyCutoverOutcome,
} from "../scripts/local_adapter_cutover.mjs";

function sampleManifest(status = "adapter_served_mlx") {
  return {
    candidate_id: "local-adapter-sample",
    status,
    promotion_result: {
      eval_suite_id: "local-adapter-eval-suite",
      benchmark_suite_id: "local-adapter-benchmark-suite",
    },
    integration_result: {
      target: status.includes("ollama") ? "ollama" : "mlx",
      backend_id: status.includes("ollama") ? "ollama-adapter-local-adapter-sample" : "mlx-adapter-local-adapter-sample",
      model_id: status.includes("ollama")
        ? "local-adapter-sample-ollama"
        : "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      endpoint: status.includes("ollama") ? "http://127.0.0.1:11434" : "http://127.0.0.1:8788",
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

test("resolveCutoverCandidate requires an already integrated adapter backend", () => {
  const blocked = resolveCutoverCandidate(
    {
      candidate_id: "sample",
      status: "adapter_registered",
      promotion_result: {
        eval_suite_id: "local-adapter-eval-suite",
      },
    },
    sampleRegistration()
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /No integrated adapter backend/i);
});

test("resolveCutoverCandidate returns the MLX backend after integration", () => {
  const candidate = resolveCutoverCandidate(sampleManifest("adapter_served_mlx"), sampleRegistration());
  assert.equal(candidate.ok, true);
  assert.equal(candidate.target, "mlx");
  assert.equal(candidate.backend_id, "mlx-adapter-local-adapter-sample");
  assert.equal(candidate.eval_suite_id, "local-adapter-eval-suite");
});

test("verifyCutoverOutcome only passes when eval, route selection, and bootstrap repairs are clean", () => {
  const passing = verifyCutoverOutcome({
    candidateBackendId: "mlx-adapter-local-adapter-sample",
    routeResult: {
      selected_backend: {
        backend_id: "mlx-adapter-local-adapter-sample",
      },
    },
    evalResult: {
      ok: true,
    },
    bootstrapStatus: {
      repairs_needed: ["eval.suite.default_drift"],
    },
  });
  assert.equal(passing.ok, true);

  const failing = verifyCutoverOutcome({
    candidateBackendId: "mlx-adapter-local-adapter-sample",
    routeResult: {
      selected_backend: {
        backend_id: "ollama-llama3-2-3b",
      },
    },
    evalResult: {
      ok: false,
    },
    bootstrapStatus: {
      repairs_needed: ["worker.fabric.sync_required"],
    },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.verification.route_selected_backend_id, "ollama-llama3-2-3b");
  assert.deepEqual(failing.verification.bootstrap_blocking_repairs, ["worker.fabric.sync_required"]);
});
