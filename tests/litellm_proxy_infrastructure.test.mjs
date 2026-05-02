import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Storage } from "../dist/storage.js";
import { healthLiteLlmProxy } from "../dist/tools/health.js";
import { kernelSummary } from "../dist/tools/kernel.js";
import { modelRouter, routeModelBackends } from "../dist/tools/model_router.js";
import { buildLiteLlmRouterBackends } from "../scripts/litellm_router_bootstrap.mjs";

function tempStorage(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const storage = new Storage(path.join(tempDir, "hub.sqlite"));
  storage.init();
  return { tempDir, storage };
}

function mutation(scope, key) {
  return {
    idempotency_key: `${scope}-${key}`,
    side_effect_fingerprint: `${scope}-${key}`,
    actor: "test",
    reason: "verify LiteLLM proxy model infrastructure",
  };
}

test("litellm router bootstrap defines Gemini proxy and local Gemma backends without user secrets", () => {
  const backends = buildLiteLlmRouterBackends({
    proxy_endpoint: "http://127.0.0.1:4000",
    routing_strategy: "usage-based-routing",
  });
  const byId = new Map(backends.map((backend) => [backend.backend_id, backend]));

  assert.equal(backends.length, 4);
  assert.equal(byId.get("gemini-2.5-pro")?.provider, "google");
  assert.equal(byId.get("gemini-2.5-pro")?.locality, "remote");
  assert.equal(byId.get("gemini-2.5-pro")?.endpoint, "http://127.0.0.1:4000");
  assert.equal(byId.get("gemini-2.5-pro")?.context_window, 1_048_576);
  assert.equal(byId.get("gemini-2.5-pro")?.metadata.region_count, 15);
  assert.deepEqual(byId.get("gemini-2.5-pro")?.tags, ["frontier", "agentic", "reasoning"]);

  assert.equal(byId.get("gemini-2.5-flash")?.provider, "google");
  assert.equal(byId.get("gemini-2.5-flash")?.locality, "remote");
  assert.equal(byId.get("gemini-2.5-flash")?.metadata.region_count, 22);
  assert.deepEqual(byId.get("gemini-2.5-flash")?.tags, ["fast", "thinking", "cost-efficient"]);

  assert.equal(byId.get("gemma-local-12b")?.provider, "ollama");
  assert.equal(byId.get("gemma-local-12b")?.locality, "local");
  assert.equal(byId.get("gemma-local-12b")?.endpoint, "http://127.0.0.1:11434");
  assert.equal(byId.get("gemma-local-12b")?.model_id, "gemma3:12b");
  assert.deepEqual(byId.get("gemma-local-12b")?.tags, ["local", "fast", "zero-latency"]);

  assert.equal(byId.get("gemma-local-4b")?.provider, "ollama");
  assert.equal(byId.get("gemma-local-4b")?.locality, "local");
  assert.equal(byId.get("gemma-local-4b")?.model_id, "gemma3:4b");
  assert.deepEqual(byId.get("gemma-local-4b")?.tags, ["local", "ultra-fast", "cheap"]);

  assert.equal(JSON.stringify(backends).includes("gen-lang-client"), false);
  assert.equal(JSON.stringify(backends).includes("application_default_credentials"), false);
});

test("model.router can register and route to a Google backend through the LiteLLM proxy endpoint", async () => {
  const { tempDir, storage } = tempStorage("litellm-router-");
  try {
    await modelRouter(storage, {
      action: "configure",
      mutation: mutation("litellm-router", "configure"),
      enabled: true,
      strategy: "prefer_context_fit",
    });
    await modelRouter(storage, {
      action: "upsert_backend",
      mutation: mutation("litellm-router", "upsert-google"),
      backend: buildLiteLlmRouterBackends()[0],
    });

    const route = routeModelBackends(storage, {
      task_kind: "research",
      required_tags: ["frontier"],
      context_tokens: 500_000,
    });

    assert.equal(route.selected_backend?.backend_id, "gemini-2.5-pro");
    assert.equal(route.selected_backend?.provider, "google");
    assert.equal(route.selected_backend?.endpoint, "http://127.0.0.1:4000");
    assert.equal(route.selected_backend?.locality, "remote");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("kernel.summary exposes LiteLLM proxy and Gemma local infrastructure from persisted signals", () => {
  const { tempDir, storage } = tempStorage("kernel-litellm-");
  try {
    const backends = buildLiteLlmRouterBackends();
    storage.setModelRouterState({
      enabled: true,
      strategy: "balanced",
      default_backend_id: "gemma-local-12b",
      backends: backends.map((backend) => ({
        ...backend,
        enabled: true,
        capabilities:
          backend.provider === "ollama"
            ? {
                ...backend.capabilities,
                probe_healthy: true,
                probe_model_known: true,
                probe_generated_at: "2026-04-30T17:00:00.000Z",
              }
            : backend.capabilities,
        throughput_tps: null,
        latency_ms_p50: null,
        success_rate: null,
        win_rate: null,
        cost_per_1k_input: null,
        max_output_tokens: null,
        heartbeat_at: null,
        updated_at: new Date().toISOString(),
      })),
    });
    storage.setAutonomyMaintainState({
      enabled: true,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      eval_interval_seconds: 21600,
      minimum_eval_score: 75,
      last_provider_bridge_check_at: "2026-04-30T17:00:00.000Z",
      provider_bridge_diagnostics: [
        {
          client_id: "gemini-cli",
          display_name: "Gemini CLI",
          office_agent_id: "gemini",
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: "LiteLLM proxy healthy.",
          notes: [],
          command: "stateful config + Vertex ADC + LiteLLM proxy health",
          config_path: "/Users/example/.gemini/settings.json",
          metadata: {
            auth_mode: "vertex-ai-adc",
            litellm_proxy: {
              endpoint: "http://127.0.0.1:4000",
              healthy: true,
              degraded: false,
              healthy_count: 53,
              unhealthy_count: 0,
              total_endpoint_count: 53,
              routing_strategy: "usage-based-routing",
              model_region_counts: {
                "gemini-2.5-pro": 15,
                "gemini-2.5-flash": 22,
                "gemini-router": 14,
              },
            },
          },
        },
      ],
    });

    const previousLiveProbe = process.env.TRICHAT_LITELLM_SUMMARY_LIVE_PROBE;
    process.env.TRICHAT_LITELLM_SUMMARY_LIVE_PROBE = "0";
    let summary;
    try {
      summary = kernelSummary(storage, {});
    } finally {
      if (previousLiveProbe === undefined) {
        delete process.env.TRICHAT_LITELLM_SUMMARY_LIVE_PROBE;
      } else {
        process.env.TRICHAT_LITELLM_SUMMARY_LIVE_PROBE = previousLiveProbe;
      }
    }

    assert.equal(summary.model_infrastructure.litellm_proxy.status, "up");
    assert.equal(summary.model_infrastructure.litellm_proxy.routing_strategy, "usage-based-routing");
    assert.equal(summary.model_infrastructure.litellm_proxy.healthy_count, 53);
    assert.equal(summary.model_infrastructure.gemini_models["gemini-2.5-pro"].region_count, 15);
    assert.equal(summary.model_infrastructure.gemini_models["gemini-2.5-flash"].region_count, 22);
    assert.equal(summary.model_infrastructure.gemma_local.available, true);
    assert.ok(summary.model_infrastructure.gemma_local.models.includes("gemma3:12b"));
    assert.equal(summary.overview.model_infrastructure.litellm_proxy.status, "up");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("health.litellm_proxy fails when the proxy is unreachable or has zero healthy endpoints", () => {
  const down = healthLiteLlmProxy({
    probe: () => ({
      endpoint: "http://127.0.0.1:4000",
      healthy: false,
      degraded: false,
      checked_at: "2026-04-30T17:00:00.000Z",
      error: "connection refused",
      healthy_count: null,
      unhealthy_count: null,
      total_endpoint_count: 0,
      routing_strategy: "usage-based-routing",
      model_region_counts: {},
    }),
  });
  assert.equal(down.ok, false);
  assert.equal(down.status, "down");

  const empty = healthLiteLlmProxy({
    probe: () => ({
      endpoint: "http://127.0.0.1:4000",
      healthy: true,
      degraded: true,
      checked_at: "2026-04-30T17:00:00.000Z",
      error: null,
      healthy_count: 0,
      unhealthy_count: 53,
      total_endpoint_count: 53,
      routing_strategy: "usage-based-routing",
      model_region_counts: {},
    }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, "down");
  assert.equal(empty.healthy_count, 0);
  assert.equal(empty.unhealthy_count, 53);
});
