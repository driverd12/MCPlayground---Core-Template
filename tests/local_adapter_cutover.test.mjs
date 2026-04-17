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
    safe_promotion_metadata: {
      allowed_now: true,
      blockers: [],
    },
    promotion_result: {
      eval_suite_id: "local-adapter-eval-suite",
      benchmark_suite_id: "local-adapter-benchmark-suite",
      integration_consideration: {
        router: {
          live_ready: true,
          blockers: [],
          planned_backend: {
            backend_id: "mlx-adapter-local-adapter-sample",
            tags: ["local", "mlx", "adapter"],
          },
        },
        ollama: {
          live_ready: true,
          blockers: [],
          planned_backend: {
            backend_id: "ollama-adapter-local-adapter-sample",
            tags: ["local", "ollama", "adapter"],
          },
        },
      },
    },
    integration_result: {
      ok: true,
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
          live_ready: true,
          blockers: [],
          planned_backend: {
            backend_id: "mlx-adapter-local-adapter-sample",
            tags: ["local", "mlx", "adapter"],
          },
        },
        ollama: {
          live_ready: true,
          blockers: [],
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

test("resolveCutoverCandidate honors integration evidence when the reported status regresses", () => {
  const manifest = sampleManifest("adapter_registered");
  const candidate = resolveCutoverCandidate(manifest, sampleRegistration());
  assert.equal(candidate.ok, true);
  assert.equal(candidate.target, "mlx");
  assert.equal(candidate.backend_id, "mlx-adapter-local-adapter-sample");
});

test("resolveCutoverCandidate refuses cutover without explicit live-ready integration proof", () => {
  const manifest = sampleManifest("adapter_served_mlx");
  manifest.integration_result.ok = false;
  manifest.promotion_result.integration_consideration.router.live_ready = false;
  manifest.promotion_result.integration_consideration.router.blockers = ["mlx_integration_pending"];

  const candidate = resolveCutoverCandidate(manifest, sampleRegistration());
  assert.equal(candidate.ok, false);
  assert.match(candidate.reason, /live-ready integration record/i);
  assert.ok(candidate.blockers.includes("integration_result_not_ok"));
  assert.ok(candidate.blockers.includes("integration_live_ready_missing"));
  assert.ok(candidate.blockers.includes("integration_blocker:mlx_integration_pending"));
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
