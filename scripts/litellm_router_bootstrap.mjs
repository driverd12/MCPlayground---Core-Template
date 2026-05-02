#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROXY_ENDPOINT = "http://127.0.0.1:4000";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_ROUTING_STRATEGY = "usage-based-routing";

export const GEMINI_25_PRO_REGIONS = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west4",
  "northamerica-northeast1",
  "europe-west1",
  "europe-west4",
  "europe-west8",
  "europe-west9",
  "europe-southwest1",
  "europe-north1",
  "asia-northeast1",
];

export const GEMINI_25_FLASH_REGIONS = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west4",
  "northamerica-northeast1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west8",
  "europe-west9",
  "europe-southwest1",
  "europe-north1",
  "asia-northeast1",
  "asia-northeast3",
  "asia-south1",
  "asia-southeast1",
  "australia-southeast1",
  "southamerica-east1",
];

function normalizeEndpoint(value, fallback) {
  const raw = String(value || fallback).trim();
  return raw.replace(/\/+$/, "");
}

function backend({
  backend_id,
  provider,
  model_id,
  endpoint,
  locality,
  context_window = 8192,
  tags,
  metadata,
  capabilities = {},
}) {
  return {
    backend_id,
    enabled: true,
    provider,
    model_id,
    endpoint,
    host_id: null,
    locality,
    context_window,
    tags,
    capabilities,
    metadata,
  };
}

export function buildLiteLlmRouterBackends(options = {}) {
  const proxyEndpoint = normalizeEndpoint(options.proxy_endpoint, DEFAULT_PROXY_ENDPOINT);
  const ollamaEndpoint = normalizeEndpoint(options.ollama_endpoint, DEFAULT_OLLAMA_ENDPOINT);
  const routingStrategy = String(options.routing_strategy || DEFAULT_ROUTING_STRATEGY).trim() || DEFAULT_ROUTING_STRATEGY;

  return [
    backend({
      backend_id: "gemini-2.5-pro",
      provider: "google",
      model_id: "gemini-2.5-pro",
      endpoint: proxyEndpoint,
      locality: "remote",
      context_window: 1_048_576,
      tags: ["frontier", "agentic", "reasoning"],
      capabilities: {
        task_kinds: ["planning", "research", "verification", "chat"],
        proxy_health_tool: "health.litellm_proxy",
      },
      metadata: {
        source: "litellm_proxy_bootstrap",
        proxy_endpoint: proxyEndpoint,
        routing_strategy: routingStrategy,
        regions: GEMINI_25_PRO_REGIONS,
        region_count: GEMINI_25_PRO_REGIONS.length,
      },
    }),
    backend({
      backend_id: "gemini-2.5-flash",
      provider: "google",
      model_id: "gemini-2.5-flash",
      endpoint: proxyEndpoint,
      locality: "remote",
      context_window: 1_048_576,
      tags: ["fast", "thinking", "cost-efficient"],
      capabilities: {
        task_kinds: ["planning", "research", "coding", "tool_use", "chat"],
        proxy_health_tool: "health.litellm_proxy",
      },
      metadata: {
        source: "litellm_proxy_bootstrap",
        proxy_endpoint: proxyEndpoint,
        routing_strategy: routingStrategy,
        regions: GEMINI_25_FLASH_REGIONS,
        region_count: GEMINI_25_FLASH_REGIONS.length,
      },
    }),
    backend({
      backend_id: "gemma-local-12b",
      provider: "ollama",
      model_id: "gemma3:12b",
      endpoint: ollamaEndpoint,
      locality: "local",
      tags: ["local", "fast", "zero-latency"],
      capabilities: {
        task_kinds: ["coding", "research", "tool_use", "chat"],
        probe_model_known: null,
      },
      metadata: {
        source: "litellm_proxy_bootstrap",
        ollama_endpoint: ollamaEndpoint,
        roster_agent_id: "gemma-local",
      },
    }),
    backend({
      backend_id: "gemma-local-4b",
      provider: "ollama",
      model_id: "gemma3:4b",
      endpoint: ollamaEndpoint,
      locality: "local",
      tags: ["local", "ultra-fast", "cheap"],
      capabilities: {
        task_kinds: ["coding", "tool_use", "chat"],
        probe_model_known: null,
      },
      metadata: {
        source: "litellm_proxy_bootstrap",
        ollama_endpoint: ollamaEndpoint,
        roster_agent_id: "gemma-local",
      },
    }),
  ];
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    db_path: process.env.ANAMNESIS_HUB_DB_PATH || path.resolve("data", "hub.sqlite"),
    proxy_endpoint: process.env.TRICHAT_GEMINI_PROXY_ENDPOINT || process.env.GOOGLE_VERTEX_BASE_URL || DEFAULT_PROXY_ENDPOINT,
    ollama_endpoint: process.env.TRICHAT_OLLAMA_URL || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_ENDPOINT,
    routing_strategy: process.env.TRICHAT_LITELLM_ROUTING_STRATEGY || DEFAULT_ROUTING_STRATEGY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      parsed.apply = true;
    } else if (arg === "--db-path") {
      parsed.db_path = argv[index + 1] || parsed.db_path;
      index += 1;
    } else if (arg === "--proxy-endpoint") {
      parsed.proxy_endpoint = argv[index + 1] || parsed.proxy_endpoint;
      index += 1;
    } else if (arg === "--ollama-endpoint") {
      parsed.ollama_endpoint = argv[index + 1] || parsed.ollama_endpoint;
      index += 1;
    }
  }
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const backends = buildLiteLlmRouterBackends(options);
  if (!options.apply) {
    console.log(JSON.stringify({ ok: true, apply: false, backends }, null, 2));
    return;
  }

  const [{ Storage }, { modelRouter }] = await Promise.all([
    import("../dist/storage.js"),
    import("../dist/tools/model_router.js"),
  ]);
  const storage = new Storage(options.db_path);
  storage.init();
  await modelRouter(storage, {
    action: "configure",
    mutation: {
      idempotency_key: "litellm-router-bootstrap-configure",
      side_effect_fingerprint: "litellm-router-bootstrap-configure",
      actor: "litellm_router_bootstrap",
      reason: "Register LiteLLM Gemini and Ollama Gemma backends.",
    },
    enabled: true,
  });
  for (const entry of backends) {
    await modelRouter(storage, {
      action: "upsert_backend",
      mutation: {
        idempotency_key: `litellm-router-bootstrap-${entry.backend_id}`,
        side_effect_fingerprint: `litellm-router-bootstrap-${entry.backend_id}`,
        actor: "litellm_router_bootstrap",
        reason: "Register LiteLLM Gemini and Ollama Gemma backends.",
      },
      backend: entry,
    });
  }
  console.log(JSON.stringify({ ok: true, apply: true, backend_count: backends.length, backend_ids: backends.map((entry) => entry.backend_id) }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
