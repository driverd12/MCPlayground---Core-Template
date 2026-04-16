import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { Storage } from "../storage.js";
import { captureLocalHostProfile, deriveLocalExecutionBudget } from "../local_host_profile.js";
import { getTriChatAgentCatalog } from "../trichat_roster.js";
import { benchmarkSuiteList, benchmarkSuiteUpsert } from "./benchmark.js";
import { clusterTopology, summarizeClusterTopologyState } from "./cluster_topology.js";
import { evalSuiteList, evalSuiteUpsert } from "./eval.js";
import { modelRouter } from "./model_router.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { getEffectiveOrgProgram, orgProgram } from "./org_program.js";
import { resolveProviderBridgeSnapshot } from "./provider_bridge.js";
import { trichatAutopilotControl } from "./trichat.js";
import { workerFabric } from "./worker_fabric.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const telemetryOverrideSchema = z.object({
  health_state: z.enum(["healthy", "degraded", "offline"]).optional(),
  queue_depth: z.number().int().min(0).max(100000).optional(),
  active_tasks: z.number().int().min(0).max(100000).optional(),
  latency_ms: z.number().min(0).max(10000000).optional(),
  cpu_utilization: z.number().min(0).max(1).optional(),
  ram_available_gb: z.number().min(0).max(1000000).optional(),
  ram_total_gb: z.number().min(0).max(1000000).optional(),
  swap_used_gb: z.number().min(0).max(1000000).optional(),
  disk_free_gb: z.number().min(0).max(1000000).optional(),
  thermal_pressure: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
});

const backendOverrideSchema = z.object({
  backend_id: z.string().min(1),
  provider: z.enum(["ollama", "mlx", "llama.cpp", "vllm", "openai", "google", "cursor", "anthropic", "github-copilot", "custom"]),
  model_id: z.string().min(1),
  endpoint: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  locality: z.enum(["local", "remote"]).optional(),
  tags: z.array(z.string().min(1)).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
});

export const autonomyBootstrapSchema = z
  .object({
    action: z.enum(["status", "ensure"]).default("status"),
    fast: z.boolean().optional(),
    mutation: mutationSchema.optional(),
    local_host_id: z.string().min(1).default("local"),
    probe_ollama_url: z.string().optional(),
    autostart_ring_leader: z.boolean().optional(),
    run_immediately: z.boolean().optional(),
    seed_org_programs: z.boolean().optional(),
    seed_benchmark_suite: z.boolean().optional(),
    seed_eval_suite: z.boolean().optional(),
    seed_cluster_topology: z.boolean().optional(),
    telemetry_override: telemetryOverrideSchema.optional(),
    host_capabilities_override: recordSchema.optional(),
    host_tags_override: z.array(z.string().min(1)).optional(),
    backend_overrides: z.array(backendOverrideSchema).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "ensure" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for ensure",
        path: ["mutation"],
      });
    }
  });

let autonomyBootstrapQueue: Promise<unknown> = Promise.resolve();

function serializeAutonomyBootstrap<T>(work: () => Promise<T>): Promise<T> {
  const task = autonomyBootstrapQueue.catch(() => undefined).then(work);
  autonomyBootstrapQueue = task.catch(() => undefined);
  return task;
}

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
type BackendCandidate = z.infer<typeof backendOverrideSchema>;

const DEFAULT_BENCHMARK_SUITE_ID = "autonomy.smoke.local";
const DEFAULT_EVAL_SUITE_ID = "autonomy.control-plane";
const HEARTBEAT_FRESHNESS_MS = 10 * 60 * 1000;
const DEFAULT_ISOLATED_STDIO_HEALTH_COMMAND =
  "([ -f dist/server.js ] || npm run build >/dev/null) && node ./scripts/mcp_tool_call.mjs --tool health.storage --args '{}' --transport stdio --stdio-command node --stdio-args 'dist/server.js' --cwd . >/dev/null";
const DEFAULT_ISOLATED_STDIO_ROSTER_COMMAND =
  "([ -f dist/server.js ] || npm run build >/dev/null) && node ./scripts/mcp_tool_call.mjs --tool trichat.roster --args '{}' --transport stdio --stdio-command node --stdio-args 'dist/server.js' --cwd . >/dev/null";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function boolFromEnv(name: string, fallback: boolean) {
  const normalized = String(process.env[name] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function intFromEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function isBlockingBootstrapRepair(repair: string) {
  return !repair.endsWith(".default_drift");
}

function optionalIntFromEnv(name: string) {
  const raw = Number.parseInt(String(process.env[name] ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, label: string) {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const hash = crypto
    .createHash("sha256")
    .update(`${base.idempotency_key}|${base.side_effect_fingerprint}|${safeLabel}`)
    .digest("hex");
  return {
    idempotency_key: `${safeLabel}-${hash.slice(0, 20)}`,
    side_effect_fingerprint: `${safeLabel}-${hash.slice(20, 52)}`,
  };
}

function sanitizeId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readJsonFileSafe(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadActiveLocalAdapterRegistration() {
  const registrationPath = readString(process.env.TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH);
  const activeProvider = readString(process.env.TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER)?.toLowerCase() ?? null;
  const activeOllamaModel = readString(process.env.TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL);
  if (!registrationPath || !activeProvider || !fs.existsSync(registrationPath)) {
    return null;
  }
  const payload = readJsonFileSafe(registrationPath);
  if (!isRecord(payload) || !isRecord(payload.decision) || payload.decision.status !== "registered") {
    return null;
  }
  return {
    registration_path: registrationPath,
    active_provider: activeProvider,
    active_ollama_model: activeOllamaModel,
    payload,
  };
}

function plannedAdapterBackendForProvider(
  activeAdapter: ReturnType<typeof loadActiveLocalAdapterRegistration>,
  provider: "mlx" | "ollama"
) {
  const decision =
    activeAdapter && isRecord(activeAdapter.payload) && isRecord(activeAdapter.payload.decision)
      ? activeAdapter.payload.decision
      : null;
  const integrationConsideration = decision?.integration_consideration;
  if (!activeAdapter || !isRecord(integrationConsideration)) {
    return null;
  }
  const branch =
    provider === "mlx"
      ? integrationConsideration.router
      : integrationConsideration.ollama;
  if (!isRecord(branch) || !isRecord(branch.planned_backend)) {
    return null;
  }
  return branch.planned_backend;
}

function commandSucceeds(command: string, args: string[] = []) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

function isFreshIsoTimestamp(value: unknown) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && Date.now() - timestamp <= HEARTBEAT_FRESHNESS_MS;
}

function localBackendLocality(endpoint?: string) {
  if (!endpoint) {
    return "local" as const;
  }
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.trim().toLowerCase();
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
      return "local" as const;
    }
  } catch {
    return "local" as const;
  }
  return "remote" as const;
}

function getTmuxTelemetry(storage: Storage) {
  const state = storage.getTriChatTmuxControllerState();
  const tasks = state?.tasks ?? [];
  return {
    queue_depth: tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length,
    active_tasks: tasks.filter((task) => task.status === "running").length,
    degraded: Boolean(state?.last_error),
  };
}

function resolveSafeTmuxWorkerCount() {
  const profile = captureLocalHostProfile({ workspace_root: process.cwd() });
  const requested = optionalIntFromEnv("TRICHAT_RING_LEADER_TMUX_WORKER_COUNT");
  const target = requested === null ? profile.safe_worker_count : Math.min(requested, profile.safe_worker_count);
  return Math.max(1, Math.min(12, target));
}

function resolveSafeTmuxMaxQueuePerWorker() {
  const profile = captureLocalHostProfile({ workspace_root: process.cwd() });
  const requested = optionalIntFromEnv("TRICHAT_RING_LEADER_TMUX_MAX_QUEUE_PER_WORKER");
  const target =
    requested === null ? profile.safe_max_queue_per_worker : Math.min(requested, profile.safe_max_queue_per_worker);
  return Math.max(1, Math.min(200, target));
}

function detectLocalHost(storage: Storage, input: z.infer<typeof autonomyBootstrapSchema>) {
  const tmux = getTmuxTelemetry(storage);
  const profile = captureLocalHostProfile({
    workspace_root: process.cwd(),
    degraded_signal: tmux.degraded,
  });
  const budget = deriveLocalExecutionBudget(profile, {
    pending_tasks: tmux.queue_depth,
    tmux_queue_depth: tmux.queue_depth,
    active_runtime_workers: tmux.active_tasks,
  });
  const override = input.telemetry_override ?? {};
  const tags = [
    "local",
    profile.platform,
    profile.arch,
    profile.platform === "darwin" ? "macos" : "unix",
    profile.arch === "arm64" ? "apple-silicon" : "x86",
  ];
  if (commandSucceeds("tmux", ["-V"])) tags.push("tmux");
  if (commandSucceeds("ollama", ["--version"])) tags.push("ollama");
  if (profile.full_gpu_access) {
    tags.push("gpu", "unified-memory");
  }
  return {
    host: {
      host_id: input.local_host_id,
      enabled: true,
      transport: "local" as const,
      workspace_root: process.cwd(),
      worker_count: resolveSafeTmuxWorkerCount(),
      shell: process.env.SHELL || "/bin/zsh",
      capabilities: {
        locality: "local",
        platform: profile.platform,
        arch: profile.arch,
        cpu_count: profile.cpu_count,
        performance_cpu_count: profile.performance_cpu_count,
        efficiency_cpu_count: profile.efficiency_cpu_count,
        unified_memory_gb: profile.memory_total_gb,
        safe_worker_count: profile.safe_worker_count,
        safe_max_queue_per_worker: profile.safe_max_queue_per_worker,
        max_local_model_concurrency: profile.max_local_model_concurrency,
        recommended_runtime_worker_max_active: budget.runtime_worker_max_active,
        recommended_runtime_worker_limit: budget.runtime_worker_limit,
        recommended_tmux_worker_count: budget.tmux_recommended_worker_count,
        recommended_tmux_target_queue_per_worker: budget.tmux_target_queue_per_worker,
        memory_free_percent: profile.memory_free_percent,
        tmux_available: commandSucceeds("tmux", ["-V"]),
        ollama_available: commandSucceeds("ollama", ["--version"]),
        full_gpu_access: profile.full_gpu_access,
        ...(isRecord(input.host_capabilities_override) ? input.host_capabilities_override : {}),
      },
      tags: [...new Set([...(input.host_tags_override ?? []), ...tags])],
      telemetry: {
        heartbeat_at: new Date().toISOString(),
        health_state: override.health_state ?? profile.health_state,
        queue_depth: override.queue_depth ?? tmux.queue_depth,
        active_tasks: override.active_tasks ?? tmux.active_tasks,
        latency_ms: override.latency_ms,
        cpu_utilization: override.cpu_utilization ?? profile.cpu_utilization,
        ram_available_gb: override.ram_available_gb ?? profile.memory_available_gb,
        ram_total_gb: override.ram_total_gb ?? profile.memory_total_gb,
        swap_used_gb: profile.swap_used_gb,
        disk_free_gb: override.disk_free_gb ?? profile.disk_free_gb ?? undefined,
        thermal_pressure: override.thermal_pressure ?? profile.thermal_pressure,
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
        local_execution_profile: {
          generated_at: profile.generated_at,
          safe_worker_count: profile.safe_worker_count,
          safe_max_queue_per_worker: profile.safe_max_queue_per_worker,
          max_local_model_concurrency: profile.max_local_model_concurrency,
          runtime_worker_max_active: budget.runtime_worker_max_active,
          runtime_worker_limit: budget.runtime_worker_limit,
          tmux_recommended_worker_count: budget.tmux_recommended_worker_count,
          tmux_target_queue_per_worker: budget.tmux_target_queue_per_worker,
          memory_free_percent: profile.memory_free_percent,
          swap_used_gb: profile.swap_used_gb,
        },
      },
    },
    detection_tags: [...new Set([...(input.host_tags_override ?? []), ...tags])],
    profile,
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 4000) {
  return fetchJsonWithRetry(url, init, timeoutMs, 0);
}

function isLoopbackUrl(url: string) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

async function fetchJsonWithRetry(url: string, init: RequestInit, timeoutMs: number, retries: number) {
  let lastValue = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        lastValue = null;
      } else {
        return await response.json();
      }
    } catch {
      lastValue = null;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return lastValue;
}

async function detectBackends(
  input: z.infer<typeof autonomyBootstrapSchema>,
  localProfile?: ReturnType<typeof captureLocalHostProfile>
): Promise<BackendCandidate[]> {
  if (Array.isArray(input.backend_overrides) && input.backend_overrides.length > 0) {
    return input.backend_overrides;
  }
  const discovered: BackendCandidate[] = [];
  const activeAdapter = loadActiveLocalAdapterRegistration();
  const plannedMlxAdapterBackend =
    activeAdapter?.active_provider === "mlx" ? plannedAdapterBackendForProvider(activeAdapter, "mlx") : null;
  const plannedOllamaAdapterBackend =
    activeAdapter?.active_provider === "ollama" ? plannedAdapterBackendForProvider(activeAdapter, "ollama") : null;
  const preferredOllamaModel = String(process.env.TRICHAT_OLLAMA_MODEL || "").trim();
  const ollamaUrl = String(input.probe_ollama_url || process.env.TRICHAT_OLLAMA_URL || "http://127.0.0.1:11434").trim();
  const ollamaIsLocal = localBackendLocality(ollamaUrl) === "local" || isLoopbackUrl(ollamaUrl);
  const ollamaTags = await fetchJsonWithRetry(
    `${ollamaUrl.replace(/\/+$/, "")}/api/tags`,
    {},
    ollamaIsLocal ? 8000 : 4000,
    ollamaIsLocal ? 1 : 0
  );
  const models = Array.isArray((ollamaTags as Record<string, unknown> | null)?.models)
    ? ((ollamaTags as Record<string, unknown>).models as Array<Record<string, unknown>>)
    : [];
  const orderedModelNames = models
    .map((entry) => String(entry?.name ?? entry?.model ?? "").trim())
    .filter(Boolean)
    .sort((left, right) => {
      if (left === preferredOllamaModel) return -1;
      if (right === preferredOllamaModel) return 1;
      return left.localeCompare(right);
    })
    .slice(0, 4);
  for (const modelName of orderedModelNames) {
    const locality = localBackendLocality(ollamaUrl);
    const isActiveAdapterModel =
      activeAdapter?.active_provider === "ollama" &&
      (modelName === readString(plannedOllamaAdapterBackend?.model_id) || modelName === activeAdapter.active_ollama_model);
    const plannedBackend = isActiveAdapterModel ? plannedOllamaAdapterBackend : null;
    discovered.push({
      backend_id: readString(plannedBackend?.backend_id) || `ollama-${sanitizeId(modelName)}`,
      provider: "ollama",
      model_id: modelName,
      endpoint: ollamaUrl,
      host_id: locality === "local" ? input.local_host_id : undefined,
      locality,
      tags: [
        ...new Set([
          locality,
          "ollama",
          ...(locality === "local" && localProfile?.full_gpu_access
            ? [
                "gpu",
                ...(localProfile.gpu_api ? [localProfile.gpu_api] : []),
                ...(localProfile.accelerator_kind === "apple-metal" ? ["apple-silicon", "unified-memory"] : []),
              ]
            : []),
          ...(preferredOllamaModel && modelName === preferredOllamaModel ? ["primary"] : []),
          ...normalizeStringArray(plannedBackend?.tags),
        ]),
      ],
      capabilities: {
        task_kinds: ["planning", "coding", "research", "verification", "chat", "tool_use"],
        recommended_parallel_requests:
          locality === "local" ? localProfile?.max_local_model_concurrency ?? 1 : 1,
        full_gpu_access: locality === "local" ? localProfile?.full_gpu_access ?? false : false,
        unified_memory_gb: locality === "local" ? localProfile?.memory_total_gb ?? null : null,
        accelerator_kind: locality === "local" ? localProfile?.accelerator_kind ?? null : null,
        gpu_model: locality === "local" ? localProfile?.gpu_model ?? null : null,
        gpu_api: locality === "local" ? localProfile?.gpu_api ?? null : null,
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
        local_execution_profile:
          locality === "local" && localProfile
            ? {
                safe_worker_count: localProfile.safe_worker_count,
                max_local_model_concurrency: localProfile.max_local_model_concurrency,
                memory_free_percent: localProfile.memory_free_percent,
                swap_used_gb: localProfile.swap_used_gb,
              }
            : undefined,
        ...(isRecord(plannedBackend?.metadata) ? plannedBackend.metadata : {}),
        ...(isActiveAdapterModel
          ? {
              local_adapter_registration_path: activeAdapter?.registration_path,
              local_adapter_active_provider: activeAdapter?.active_provider,
              local_adapter_integration_status:
                activeAdapter?.payload?.integration_result && isRecord(activeAdapter.payload.integration_result)
                  ? activeAdapter.payload.integration_result.status
                  : null,
            }
          : {}),
      },
    });
  }
  const mlxModel = String(process.env.TRICHAT_MLX_MODEL || "").trim();
  const mlxEndpoint = String(process.env.TRICHAT_MLX_ENDPOINT || "").trim().replace(/\/+$/, "");
  const mlxHealth = mlxEndpoint ? await fetchJsonWithTimeout(`${mlxEndpoint}/health`, {}, 3000) : null;
  if (mlxModel && localProfile?.mlx_available && mlxEndpoint && mlxHealth) {
    discovered.push({
      backend_id: readString(plannedMlxAdapterBackend?.backend_id) || `mlx-${sanitizeId(mlxModel)}`,
      provider: "mlx",
      model_id: mlxModel,
      endpoint: mlxEndpoint,
      host_id: input.local_host_id,
      locality: "local",
      tags: [
        "local",
        "mlx",
        "gpu",
        ...(localProfile.gpu_api ? [localProfile.gpu_api] : []),
        ...(localProfile.accelerator_kind === "apple-metal" ? ["apple-silicon", "unified-memory"] : []),
        ...normalizeStringArray(plannedMlxAdapterBackend?.tags),
      ],
      capabilities: {
        task_kinds: ["planning", "coding", "research", "verification", "chat", "tool_use"],
        recommended_parallel_requests: localProfile.max_local_model_concurrency,
        full_gpu_access: localProfile.full_gpu_access,
        unified_memory_gb: localProfile.memory_total_gb,
        accelerator_kind: localProfile.accelerator_kind,
        gpu_model: localProfile.gpu_model,
        gpu_api: localProfile.gpu_api,
        mlx_python: localProfile.mlx_python,
        mlx_available: localProfile.mlx_available,
        mlx_lm_available: localProfile.mlx_lm_available,
        fine_tuning_supported: localProfile.mlx_lm_available,
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
        local_execution_profile: {
          safe_worker_count: localProfile.safe_worker_count,
          max_local_model_concurrency: localProfile.max_local_model_concurrency,
          memory_free_percent: localProfile.memory_free_percent,
          swap_used_gb: localProfile.swap_used_gb,
          gpu_model: localProfile.gpu_model,
          gpu_api: localProfile.gpu_api,
          mlx_python: localProfile.mlx_python,
          mlx_endpoint: mlxEndpoint,
        },
        ...(isRecord(plannedMlxAdapterBackend?.metadata) ? plannedMlxAdapterBackend.metadata : {}),
        ...(activeAdapter?.active_provider === "mlx"
          ? {
              local_adapter_registration_path: activeAdapter.registration_path,
              local_adapter_active_provider: activeAdapter.active_provider,
              local_adapter_integration_status:
                activeAdapter.payload?.integration_result && isRecord(activeAdapter.payload.integration_result)
                  ? activeAdapter.payload.integration_result.status
                  : null,
            }
          : {}),
      },
    });
  }
  for (const [provider, endpointEnv, modelEnv] of [
    ["llama.cpp", "TRICHAT_LLAMA_CPP_ENDPOINT", "TRICHAT_LLAMA_CPP_MODEL"],
    ["vllm", "TRICHAT_VLLM_ENDPOINT", "TRICHAT_VLLM_MODEL"],
  ] as const) {
    const endpoint = String(process.env[endpointEnv] || "").trim();
    const modelId = String(process.env[modelEnv] || "").trim();
    if (!endpoint || !modelId) continue;
    const health = await fetchJsonWithTimeout(`${endpoint.replace(/\/+$/, "")}/health`, {}, 3000);
    if (!health) continue;
    const locality = localBackendLocality(endpoint);
    discovered.push({
      backend_id: `${sanitizeId(provider)}-${sanitizeId(modelId)}`,
      provider,
      model_id: modelId,
      endpoint,
      host_id: locality === "local" ? input.local_host_id : undefined,
      locality,
      tags: [locality, provider],
      capabilities: {
        task_kinds: ["planning", "coding", "research", "verification", "chat", "tool_use"],
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
      },
    });
  }
  if (boolFromEnv("TRICHAT_PROVIDER_BRIDGE_ROUTER_ENABLED", true)) {
    const bridgeSnapshot = resolveProviderBridgeSnapshot({
      workspace_root: process.cwd(),
      transport: "auto",
    });
    for (const backend of bridgeSnapshot.eligible_router_backends) {
      discovered.push({
        backend_id: backend.backend_id,
        provider: backend.provider,
        model_id: backend.model_id,
        endpoint: backend.endpoint ?? undefined,
        host_id: backend.host_id ?? undefined,
        locality: backend.locality,
        tags: backend.tags,
        capabilities: backend.capabilities,
        metadata: backend.metadata,
      });
    }
  }
  return discovered.filter(
    (entry, index, items) => items.findIndex((candidate) => candidate.backend_id === entry.backend_id) === index
  );
}

function buildDesiredAutopilotConfig() {
  const localProfile = captureLocalHostProfile({ workspace_root: process.cwd() });
  const leadAgentId = String(process.env.TRICHAT_RING_LEADER_AGENT_ID || "ring-leader").trim().toLowerCase();
  const configuredSpecialists = normalizeStringArray(String(process.env.TRICHAT_RING_LEADER_SPECIALIST_AGENT_IDS || "").split(","));
  const fallbackSpecialists = getTriChatAgentCatalog()
    .filter((agent) => agent.enabled !== false)
    .filter((agent) => agent.agent_id !== leadAgentId)
    .filter((agent) => agent.coordination_tier === "director" || agent.coordination_tier === "support")
    .map((agent) => agent.agent_id);
  const awayModeRaw = String(process.env.TRICHAT_RING_LEADER_AWAY_MODE || "normal").trim().toLowerCase();
  const threadStatusRaw = String(process.env.TRICHAT_RING_LEADER_THREAD_STATUS || "active").trim().toLowerCase();
  const executeBackendRaw = String(process.env.TRICHAT_RING_LEADER_EXECUTE_BACKEND || "auto").trim().toLowerCase();
  const adrPolicyRaw = String(process.env.TRICHAT_RING_LEADER_ADR_POLICY || "high_impact").trim().toLowerCase();
  return {
    away_mode: awayModeRaw === "safe" || awayModeRaw === "aggressive" ? awayModeRaw : "normal",
    interval_seconds: intFromEnv("TRICHAT_RING_LEADER_INTERVAL_SECONDS", 180),
    thread_id: String(process.env.TRICHAT_RING_LEADER_THREAD_ID || "ring-leader-main").trim(),
    thread_title: String(process.env.TRICHAT_RING_LEADER_THREAD_TITLE || "Ring Leader Main Loop").trim(),
    thread_status: threadStatusRaw === "archived" ? "archived" : "active",
    objective: String(
      process.env.TRICHAT_RING_LEADER_OBJECTIVE ||
        process.env.ANAMNESIS_IMPRINT_MISSION ||
        "Inspect kernel state, choose one high-leverage bounded next action, and delegate specialist work with explicit success criteria and rollback awareness."
    ).trim(),
    lead_agent_id: leadAgentId,
    specialist_agent_ids: configuredSpecialists.length > 0 ? configuredSpecialists : fallbackSpecialists,
    max_rounds: intFromEnv("TRICHAT_RING_LEADER_MAX_ROUNDS", 2),
    min_success_agents: intFromEnv("TRICHAT_RING_LEADER_MIN_SUCCESS_AGENTS", 2),
    bridge_timeout_seconds: intFromEnv("TRICHAT_RING_LEADER_BRIDGE_TIMEOUT_SECONDS", 90),
    bridge_dry_run: boolFromEnv("TRICHAT_RING_LEADER_BRIDGE_DRY_RUN", false),
    execute_enabled: boolFromEnv("TRICHAT_RING_LEADER_EXECUTE_ENABLED", true),
    execute_backend: executeBackendRaw === "direct" || executeBackendRaw === "tmux" ? executeBackendRaw : "auto",
    tmux_session_name: String(process.env.TRICHAT_RING_LEADER_TMUX_SESSION_NAME || "ring-leader-autopilot").trim(),
    tmux_worker_count: resolveSafeTmuxWorkerCount(),
    tmux_max_queue_per_worker: resolveSafeTmuxMaxQueuePerWorker(),
    tmux_auto_scale_workers: boolFromEnv("TRICHAT_RING_LEADER_TMUX_AUTO_SCALE_WORKERS", true),
    tmux_sync_after_dispatch: boolFromEnv("TRICHAT_RING_LEADER_TMUX_SYNC_AFTER_DISPATCH", true),
    confidence_threshold: Number.parseFloat(String(process.env.TRICHAT_RING_LEADER_CONFIDENCE_THRESHOLD || "0.45")),
    max_consecutive_errors: intFromEnv("TRICHAT_RING_LEADER_MAX_CONSECUTIVE_ERRORS", 3),
    adr_policy: adrPolicyRaw === "every_success" || adrPolicyRaw === "manual" ? adrPolicyRaw : "high_impact",
  } as const;
}

function selectPrimaryLocalBackend<T extends { provider?: string | null; locality?: string | null; host_id?: string | null }>(
  backends: T[],
  localHostId: string
) {
  const preferredProviderOrder = ["ollama", "mlx", "llama.cpp", "vllm"];
  const localCandidates = backends.filter(
    (entry) => String(entry.locality || "") === "local" || String(entry.host_id || "") === localHostId
  );
  if (localCandidates.length === 0) {
    return backends[0] ?? null;
  }
  for (const provider of preferredProviderOrder) {
    const match = localCandidates.find((entry) => String(entry.provider || "") === provider);
    if (match) {
      return match;
    }
  }
  return localCandidates[0] ?? null;
}

function selectPrimaryBootstrapBackend(
  backends: BackendCandidate[],
  existingRouter: ReturnType<Storage["getModelRouterState"]>,
  localHostId: string
) {
  const detectedPrimary = selectPrimaryLocalBackend(backends, localHostId);
  const detectedIsLocal = Boolean(
    detectedPrimary &&
      (String(detectedPrimary.locality || "") === "local" || String(detectedPrimary.host_id || "") === localHostId)
  );
  if (detectedIsLocal) {
    return detectedPrimary;
  }
  const persistedLocalDefault =
    existingRouter?.backends.find(
      (entry) =>
        entry.enabled !== false &&
        entry.backend_id === existingRouter.default_backend_id &&
        (String(entry.locality || "") === "local" || String(entry.host_id || "") === localHostId)
    ) ?? null;
  return persistedLocalDefault ?? detectedPrimary;
}

function buildDelegationContract(tier: string) {
  if (tier === "lead") {
    return "Decompose goals into bounded work, choose the correct lane, require evidence and rollback plans, and keep specialists focused on one owner per slice.";
  }
  if (tier === "director") {
    return "Accept bounded goals from the ring leader, split them into leaf-sized tasks, supervise assigned leaves, and escalate blockers with concrete evidence.";
  }
  if (tier === "leaf") {
    return "Own one bounded slice at a time, produce minimal diffs or findings, report evidence, and stop at the safety boundary instead of improvising scope.";
  }
  return "Provide high-signal support when explicitly asked, stay concise, and avoid spawning hidden workstreams.";
}

function buildEvaluationStandard(lane: string, tier: string) {
  if (lane === "implementer") return "Success requires an explicit owner, a minimal change set, clear verification, and rollback notes when risk is non-trivial.";
  if (lane === "analyst") return "Success requires decision-ready synthesis, clear assumptions, explicit evidence gaps, and bounded recommendations.";
  if (lane === "verifier" || tier === "support") return "Success requires concrete failure modes, honest confidence, explicit blockers, and no decorative certainty.";
  return "Success requires bounded scope, concrete next actions, evidence quality, and rollback awareness.";
}

function buildDefaultAutonomySmokeBenchmarkSuite(projectDir: string) {
  return {
    suite_id: DEFAULT_BENCHMARK_SUITE_ID,
    title: "Autonomy smoke benchmark",
    objective: "Verify the local-first agent stack can still build and answer core MCP health queries inside isolated execution.",
    project_dir: path.resolve(projectDir),
    isolation_mode: "git_worktree" as const,
    aggregate_metric_name: "suite_success_rate",
    aggregate_metric_direction: "maximize" as const,
    cases: [
      {
        case_id: "build",
        title: "TypeScript build stays green",
        command: "npm run build",
      },
      {
        case_id: "storage-health",
        title: "Isolated stdio storage health stays reachable",
        command: DEFAULT_ISOLATED_STDIO_HEALTH_COMMAND,
      },
      {
        case_id: "roster-health",
        title: "Isolated stdio tri-chat roster stays reachable",
        command: DEFAULT_ISOLATED_STDIO_ROSTER_COMMAND,
      },
    ],
    tags: ["autonomy", "smoke", "bootstrap"],
    metadata: {
      bootstrap_source: "autonomy.bootstrap",
      cleanup_workspaces: true,
    },
  };
}

function buildDefaultAutonomyControlPlaneEvalSuite(primaryBackend: {
  backend_id?: string | null | undefined;
  tags?: string[] | null | undefined;
}) {
  const backendId = String(primaryBackend.backend_id ?? "").trim();
  const preferredTags = normalizeStringArray(primaryBackend.tags).filter((tag) =>
    ["local", "ollama", "mlx", "llama.cpp", "vllm", "gpu", "primary"].includes(tag)
  );
  const requiredTags = preferredTags.includes("primary") ? ["primary"] : [];
  return {
    suite_id: DEFAULT_EVAL_SUITE_ID,
    title: "Autonomy control-plane eval",
    objective: "Keep the self-starting worker fabric, router, and benchmark substrate honest.",
    aggregate_metric_name: "suite_success_rate",
    aggregate_metric_direction: "maximize" as const,
    cases: [
      {
        case_id: "autonomy-benchmark-smoke",
        title: "Autonomy smoke benchmark stays green",
        kind: "benchmark_suite" as const,
        benchmark_suite_id: DEFAULT_BENCHMARK_SUITE_ID,
        required: true,
        weight: 1,
      },
      {
        case_id: "router-primary-planning",
        title: "Planning routes to the current primary local backend",
        kind: "router_case" as const,
        task_kind: "planning" as const,
        context_tokens: 4000,
        latency_budget_ms: 2000,
        expected_backend_id: backendId,
        expected_backend_tags: [],
        required_tags: requiredTags,
        preferred_tags: preferredTags,
        required: true,
        weight: 1,
      },
    ],
    tags: ["autonomy", "control-plane", "bootstrap"],
    metadata: {
      bootstrap_source: "autonomy.bootstrap",
      primary_backend_id: backendId,
      preferred_router_tags: preferredTags,
    },
  };
}

function defaultAutonomySmokeBenchmarkSuiteNeedsReconcile(existing: any, projectDir: string) {
  if (!existing) {
    return true;
  }
  const expected = buildDefaultAutonomySmokeBenchmarkSuite(projectDir);
  if (String(existing.title ?? "") !== expected.title) return true;
  if (String(existing.objective ?? "") !== expected.objective) return true;
  if (path.resolve(String(existing.project_dir ?? "")) !== expected.project_dir) return true;
  if (String(existing.isolation_mode ?? "git_worktree") !== expected.isolation_mode) return true;
  if (String(existing.aggregate_metric_name ?? "suite_success_rate") !== expected.aggregate_metric_name) return true;
  if (String(existing.aggregate_metric_direction ?? "maximize") !== expected.aggregate_metric_direction) return true;
  const existingTags = normalizeStringArray(existing.tags);
  const expectedTags = normalizeStringArray(expected.tags);
  if (existingTags.join("|") !== expectedTags.join("|")) return true;
  if (Boolean(existing.metadata?.cleanup_workspaces) !== Boolean(expected.metadata?.cleanup_workspaces)) return true;
  const existingCases = Array.isArray(existing.cases) ? existing.cases : [];
  if (existingCases.length !== expected.cases.length) return true;
  return expected.cases.some((expectedCase, index) => {
    const currentCase = existingCases[index] ?? {};
    return (
      String(currentCase.case_id ?? "") !== expectedCase.case_id ||
      String(currentCase.title ?? "") !== expectedCase.title ||
      String(currentCase.command ?? "") !== expectedCase.command
    );
  });
}

function defaultAutonomyControlPlaneEvalSuiteNeedsReconcile(
  existing: any,
  primaryBackend: { backend_id?: string | null | undefined; tags?: string[] | null | undefined }
) {
  if (!existing) {
    return true;
  }
  const expected = buildDefaultAutonomyControlPlaneEvalSuite(primaryBackend);
  if (String(existing.title ?? "") !== expected.title) return true;
  if (String(existing.objective ?? "") !== expected.objective) return true;
  if (String(existing.aggregate_metric_name ?? "suite_success_rate") !== expected.aggregate_metric_name) return true;
  if (String(existing.aggregate_metric_direction ?? "maximize") !== expected.aggregate_metric_direction) return true;
  const existingTags = normalizeStringArray(existing.tags);
  const expectedTags = normalizeStringArray(expected.tags);
  if (existingTags.join("|") !== expectedTags.join("|")) return true;
  if (String(existing.metadata?.primary_backend_id ?? "") !== String(expected.metadata.primary_backend_id ?? "")) return true;
  const existingCases = Array.isArray(existing.cases) ? existing.cases : [];
  if (existingCases.length !== expected.cases.length) return true;
  return expected.cases.some((expectedCase, index) => {
    const currentCase = existingCases[index] ?? {};
    return (
      String(currentCase.case_id ?? "") !== expectedCase.case_id ||
      String(currentCase.title ?? "") !== expectedCase.title ||
      String(currentCase.kind ?? "") !== expectedCase.kind ||
      String(currentCase.benchmark_suite_id ?? "") !== String((expectedCase as any).benchmark_suite_id ?? "") ||
      String(currentCase.expected_backend_id ?? "") !== String((expectedCase as any).expected_backend_id ?? "") ||
      normalizeStringArray(currentCase.expected_backend_tags).join("|") !==
        normalizeStringArray((expectedCase as any).expected_backend_tags).join("|") ||
      normalizeStringArray(currentCase.required_tags).join("|") !==
        normalizeStringArray((expectedCase as any).required_tags).join("|") ||
      normalizeStringArray(currentCase.preferred_tags).join("|") !==
        normalizeStringArray((expectedCase as any).preferred_tags).join("|")
    );
  });
}

function resolvePrimaryLocalBackend(
  localBackends: Array<{ backend_id?: string | null | undefined; tags?: string[] | null | undefined }>,
  defaultBackendId: string | null | undefined
) {
  const normalizedDefault = String(defaultBackendId ?? "").trim();
  if (normalizedDefault) {
    const defaultMatch = localBackends.find((entry) => String(entry.backend_id ?? "").trim() === normalizedDefault);
    if (defaultMatch) {
      return defaultMatch;
    }
  }
  const taggedPrimary = localBackends.find((entry) => normalizeStringArray(entry.tags).some((tag) => tag.toLowerCase() === "primary"));
  return taggedPrimary ?? localBackends[0] ?? null;
}

async function inspectBootstrapState(
  storage: Storage,
  invokeTool: InvokeTool,
  input: z.infer<typeof autonomyBootstrapSchema>,
  backendCandidates?: BackendCandidate[]
) {
  const persistedFabric = storage.getWorkerFabricState();
  const persistedClusterTopology = storage.getClusterTopologyState();
  const persistedHosts = Array.isArray(persistedFabric?.hosts) ? persistedFabric!.hosts : [];
  const persistedLocalHost = persistedHosts.find((entry) => entry.host_id === input.local_host_id) ?? null;
  const clusterTopologySummary = summarizeClusterTopologyState(
    persistedClusterTopology ?? {
      enabled: false,
      default_node_id: null,
      nodes: [],
      updated_at: new Date().toISOString(),
    }
  );

  const effectiveFabricStatus = (await Promise.resolve(
    workerFabric(storage, {
      action: "status",
      fallback_workspace_root: process.cwd(),
      fallback_worker_count: resolveSafeTmuxWorkerCount(),
      fallback_shell: process.env.SHELL || "/bin/zsh",
    })
  )) as any;
  const effectiveHosts = Array.isArray(effectiveFabricStatus.state?.hosts) ? effectiveFabricStatus.state.hosts : [];
  const effectiveLocalHost =
    effectiveHosts.find((entry: any) => String(entry.host_id || "") === input.local_host_id) ?? null;

  const persistedRouter = storage.getModelRouterState();
  const persistedBackends = Array.isArray(persistedRouter?.backends) ? persistedRouter!.backends : [];
  const localBackends = persistedBackends.filter(
    (entry) => String(entry.host_id || "") === input.local_host_id || String(entry.locality || "") === "local"
  );

  const requiredRoleIds = getTriChatAgentCatalog()
    .filter((agent) => agent.enabled !== false)
    .map((agent) => agent.agent_id);
  const missingRoleIds = requiredRoleIds.filter((roleId) => !getEffectiveOrgProgram(storage, roleId));

  const benchmarkState = benchmarkSuiteList(storage, {});
  const evalState = evalSuiteList(storage, {});
  const benchmarkSuiteIds = benchmarkState.suites.map((entry) => entry.suite_id);
  const evalSuiteIds = evalState.suites.map((entry) => entry.suite_id);
  const existingBenchmarkSuite = benchmarkState.suites.find((entry) => entry.suite_id === DEFAULT_BENCHMARK_SUITE_ID);
  const existingEvalSuite = evalState.suites.find((entry) => entry.suite_id === DEFAULT_EVAL_SUITE_ID);
  const localPrimaryBackend = resolvePrimaryLocalBackend(localBackends, persistedRouter?.default_backend_id);

  const autopilotStatus = (await Promise.resolve(
    trichatAutopilotControl(storage, invokeTool, { action: "status" } as any)
  )) as Record<string, unknown>;
  const desiredAutopilot = buildDesiredAutopilotConfig();
  const actualConfig = isRecord(autopilotStatus.config) ? autopilotStatus.config : {};
  const persistedAutopilot = storage.getTriChatAutopilotState();
  const enforceAutopilotConfig = boolFromEnv("TRICHAT_RING_LEADER_ENFORCE_STARTUP_CONFIG", false);
  const configDrift = [
    String(actualConfig.lead_agent_id || "") !== desiredAutopilot.lead_agent_id ? "lead_agent_id" : null,
    String(actualConfig.thread_id || "") !== desiredAutopilot.thread_id ? "thread_id" : null,
    JSON.stringify(normalizeStringArray(actualConfig.specialist_agent_ids)) !==
    JSON.stringify(desiredAutopilot.specialist_agent_ids)
      ? "specialist_agent_ids"
      : null,
  ].filter(Boolean);

  const repairsNeeded: string[] = [];
  if (!persistedFabric?.enabled || !persistedLocalHost) {
    repairsNeeded.push("worker.fabric.local_host_missing");
  } else if (!isFreshIsoTimestamp(effectiveLocalHost?.telemetry?.heartbeat_at ?? persistedLocalHost.telemetry?.heartbeat_at)) {
    repairsNeeded.push("worker.fabric.local_host_stale");
  }
  if (!persistedClusterTopology?.enabled || clusterTopologySummary.node_count === 0) {
    repairsNeeded.push("cluster.topology.missing");
  }
  if (!persistedRouter?.enabled || localBackends.length === 0) {
    repairsNeeded.push("model.router.local_backend_missing");
  } else if (!localBackends.some((entry) => isFreshIsoTimestamp(entry.heartbeat_at))) {
    repairsNeeded.push("model.router.local_backend_stale");
  }
  if (missingRoleIds.length > 0) {
    repairsNeeded.push("org.program.missing_roles");
  }
  if (!benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID)) {
    repairsNeeded.push("benchmark.suite.missing_default");
  } else if (defaultAutonomySmokeBenchmarkSuiteNeedsReconcile(existingBenchmarkSuite, process.cwd())) {
    repairsNeeded.push("benchmark.suite.default_drift");
  }
  if (!evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID)) {
    repairsNeeded.push("eval.suite.missing_default");
  } else if (localPrimaryBackend && defaultAutonomyControlPlaneEvalSuiteNeedsReconcile(existingEvalSuite, localPrimaryBackend)) {
    repairsNeeded.push("eval.suite.default_drift");
  }
  const shouldAutostart = input.autostart_ring_leader ?? boolFromEnv("TRICHAT_RING_LEADER_AUTOSTART", true);
  if (shouldAutostart && !autopilotStatus.running) {
    repairsNeeded.push("trichat.autopilot.not_running");
  }
  if (shouldAutostart && enforceAutopilotConfig && !persistedAutopilot && configDrift.length > 0) {
    repairsNeeded.push("trichat.autopilot.config_drift");
  }

  return {
    local_host_id: input.local_host_id,
    worker_fabric: {
      enabled: Boolean(persistedFabric?.enabled),
      host_present: Boolean(persistedLocalHost),
      host_fresh: Boolean(
        (effectiveLocalHost ?? persistedLocalHost) &&
        isFreshIsoTimestamp((effectiveLocalHost ?? persistedLocalHost)?.telemetry?.heartbeat_at)
      ),
      default_host_id: persistedFabric?.default_host_id ?? null,
      host_ids: persistedHosts.map((entry) => entry.host_id),
      telemetry: effectiveLocalHost?.telemetry ?? persistedLocalHost?.telemetry ?? null,
      persisted_local_telemetry: persistedLocalHost?.telemetry ?? null,
      effective_local_telemetry: effectiveLocalHost?.telemetry ?? null,
    },
    cluster_topology: {
      ready: Boolean(persistedClusterTopology?.enabled) && clusterTopologySummary.node_count > 0,
      default_node_id: clusterTopologySummary.default_node_id,
      node_count: clusterTopologySummary.node_count,
      active_node_count: clusterTopologySummary.active_node_count,
      planned_node_count: clusterTopologySummary.planned_node_count,
      syncable_worker_host_count: clusterTopologySummary.syncable_worker_host_count,
    },
    model_router: {
      enabled: Boolean(persistedRouter?.enabled),
      backend_present: localBackends.length > 0,
      backend_fresh: localBackends.some((entry) => isFreshIsoTimestamp(entry.heartbeat_at)),
      default_backend_id: persistedRouter?.default_backend_id ?? null,
      backend_ids: persistedBackends.map((entry) => entry.backend_id),
      local_backend_ids: localBackends.map((entry) => entry.backend_id),
    },
    org_programs: {
      ready: missingRoleIds.length === 0,
      required_role_ids: requiredRoleIds,
      missing_role_ids: missingRoleIds,
    },
    benchmark_suites: {
      ready: benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID),
      default_suite_drift:
        benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID) &&
        defaultAutonomySmokeBenchmarkSuiteNeedsReconcile(existingBenchmarkSuite, process.cwd()),
      suite_ids: benchmarkSuiteIds,
    },
    eval_suites: {
      ready: evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID),
      default_suite_drift:
        evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID) &&
        Boolean(localPrimaryBackend) &&
        defaultAutonomyControlPlaneEvalSuiteNeedsReconcile(existingEvalSuite, localPrimaryBackend!),
      suite_ids: evalSuiteIds,
    },
    ring_leader: {
      running: Boolean(autopilotStatus.running),
      lead_agent_id: String(actualConfig.lead_agent_id || "") || null,
      thread_id: String(actualConfig.thread_id || "") || null,
      config_drift: configDrift,
    },
    detections: {
      host_tags: detectLocalHost(storage, input).detection_tags,
      backends: (backendCandidates ?? []).map((entry) => ({
        backend_id: entry.backend_id,
        provider: entry.provider,
        model_id: entry.model_id,
        locality: entry.locality ?? null,
      })),
    },
    repairs_needed: repairsNeeded,
    self_start_ready: repairsNeeded.some(isBlockingBootstrapRepair) !== true,
  };
}

function inspectBootstrapStateFast(
  storage: Storage,
  input: z.infer<typeof autonomyBootstrapSchema>
) {
  const persistedFabric = storage.getWorkerFabricState();
  const persistedClusterTopology = storage.getClusterTopologyState();
  const persistedHosts = Array.isArray(persistedFabric?.hosts) ? persistedFabric.hosts : [];
  const persistedLocalHost = persistedHosts.find((entry) => entry.host_id === input.local_host_id) ?? null;
  const clusterTopologySummary = summarizeClusterTopologyState(
    persistedClusterTopology ?? {
      enabled: false,
      default_node_id: null,
      nodes: [],
      updated_at: new Date().toISOString(),
    }
  );
  const persistedRouter = storage.getModelRouterState();
  const persistedBackends = Array.isArray(persistedRouter?.backends) ? persistedRouter.backends : [];
  const localBackends = persistedBackends.filter(
    (entry) => String(entry.host_id || "") === input.local_host_id || String(entry.locality || "") === "local"
  );
  const requiredRoleIds = getTriChatAgentCatalog()
    .filter((agent) => agent.enabled !== false)
    .map((agent) => agent.agent_id);
  const missingRoleIds = requiredRoleIds.filter((roleId) => !getEffectiveOrgProgram(storage, roleId));
  const benchmarkState = benchmarkSuiteList(storage, {});
  const evalState = evalSuiteList(storage, {});
  const benchmarkSuiteIds = benchmarkState.suites.map((entry) => entry.suite_id);
  const evalSuiteIds = evalState.suites.map((entry) => entry.suite_id);
  const existingBenchmarkSuite = benchmarkState.suites.find((entry) => entry.suite_id === DEFAULT_BENCHMARK_SUITE_ID);
  const existingEvalSuite = evalState.suites.find((entry) => entry.suite_id === DEFAULT_EVAL_SUITE_ID);
  const localPrimaryBackend = resolvePrimaryLocalBackend(localBackends, persistedRouter?.default_backend_id);
  const persistedAutopilot = storage.getTriChatAutopilotState();
  const desiredAutopilot = buildDesiredAutopilotConfig();
  const repairsNeeded: string[] = [];

  if (!persistedFabric?.enabled || !persistedLocalHost) {
    repairsNeeded.push("worker.fabric.local_host_missing");
  } else if (!isFreshIsoTimestamp(persistedLocalHost.telemetry?.heartbeat_at)) {
    repairsNeeded.push("worker.fabric.local_host_stale");
  }
  if (!persistedClusterTopology?.enabled || clusterTopologySummary.node_count === 0) {
    repairsNeeded.push("cluster.topology.missing");
  }
  if (!persistedRouter?.enabled || localBackends.length === 0) {
    repairsNeeded.push("model.router.local_backend_missing");
  } else if (!localBackends.some((entry) => isFreshIsoTimestamp(entry.heartbeat_at))) {
    repairsNeeded.push("model.router.local_backend_stale");
  }
  if (missingRoleIds.length > 0) {
    repairsNeeded.push("org.program.missing_roles");
  }
  if (!benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID)) {
    repairsNeeded.push("benchmark.suite.missing_default");
  } else if (defaultAutonomySmokeBenchmarkSuiteNeedsReconcile(existingBenchmarkSuite, process.cwd())) {
    repairsNeeded.push("benchmark.suite.default_drift");
  }
  if (!evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID)) {
    repairsNeeded.push("eval.suite.missing_default");
  } else if (localPrimaryBackend && defaultAutonomyControlPlaneEvalSuiteNeedsReconcile(existingEvalSuite, localPrimaryBackend)) {
    repairsNeeded.push("eval.suite.default_drift");
  }
  if ((input.autostart_ring_leader ?? boolFromEnv("TRICHAT_RING_LEADER_AUTOSTART", true)) && persistedAutopilot?.enabled !== true) {
    repairsNeeded.push("trichat.autopilot.not_running");
  }

  return {
    local_host_id: input.local_host_id,
    worker_fabric: {
      enabled: Boolean(persistedFabric?.enabled),
      host_present: Boolean(persistedLocalHost),
      host_fresh: Boolean(persistedLocalHost && isFreshIsoTimestamp(persistedLocalHost.telemetry?.heartbeat_at)),
      default_host_id: persistedFabric?.default_host_id ?? null,
      host_ids: persistedHosts.map((entry) => entry.host_id),
      telemetry: persistedLocalHost?.telemetry ?? null,
      persisted_local_telemetry: persistedLocalHost?.telemetry ?? null,
      effective_local_telemetry: persistedLocalHost?.telemetry ?? null,
    },
    cluster_topology: {
      ready: Boolean(persistedClusterTopology?.enabled) && clusterTopologySummary.node_count > 0,
      default_node_id: clusterTopologySummary.default_node_id,
      node_count: clusterTopologySummary.node_count,
      active_node_count: clusterTopologySummary.active_node_count,
      planned_node_count: clusterTopologySummary.planned_node_count,
      syncable_worker_host_count: clusterTopologySummary.syncable_worker_host_count,
    },
    model_router: {
      enabled: Boolean(persistedRouter?.enabled),
      backend_present: localBackends.length > 0,
      backend_fresh: localBackends.some((entry) => isFreshIsoTimestamp(entry.heartbeat_at)),
      default_backend_id: persistedRouter?.default_backend_id ?? null,
      backend_ids: persistedBackends.map((entry) => entry.backend_id),
      local_backend_ids: localBackends.map((entry) => entry.backend_id),
    },
    org_programs: {
      ready: missingRoleIds.length === 0,
      required_role_ids: requiredRoleIds,
      missing_role_ids: missingRoleIds,
    },
    benchmark_suites: {
      ready: benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID),
      default_suite_drift:
        benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID) &&
        defaultAutonomySmokeBenchmarkSuiteNeedsReconcile(existingBenchmarkSuite, process.cwd()),
      suite_ids: benchmarkSuiteIds,
    },
    eval_suites: {
      ready: evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID),
      default_suite_drift:
        evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID) &&
        Boolean(localPrimaryBackend) &&
        defaultAutonomyControlPlaneEvalSuiteNeedsReconcile(existingEvalSuite, localPrimaryBackend),
      suite_ids: evalSuiteIds,
    },
    ring_leader: {
      running: persistedAutopilot?.enabled === true,
      lead_agent_id: desiredAutopilot.lead_agent_id,
      thread_id: desiredAutopilot.thread_id,
      config_drift: [],
    },
    detections: {
      host_tags: detectLocalHost(storage, input).detection_tags,
      backends: [],
    },
    repairs_needed: repairsNeeded,
    self_start_ready: repairsNeeded.some(isBlockingBootstrapRepair) !== true,
    fast: true,
  };
}

export async function autonomyBootstrap(storage: Storage, invokeTool: InvokeTool, input: z.infer<typeof autonomyBootstrapSchema>) {
  if (input.action === "status" && input.fast === true) {
    return inspectBootstrapStateFast(storage, input);
  }
  const statusLocalHost = detectLocalHost(storage, input);
  if (input.action === "status") {
    const detectedBackends = await detectBackends(input, statusLocalHost.profile);
    return inspectBootstrapState(storage, invokeTool, input, detectedBackends);
  }

  return serializeAutonomyBootstrap(() =>
    runIdempotentMutation({
      storage,
      tool_name: "autonomy.bootstrap",
      mutation: input.mutation!,
      payload: input,
      execute: async () => {
        const actions: string[] = [];
        const localHost = detectLocalHost(storage, input);
        const ensuredBackends = await detectBackends(input, localHost.profile);
        const desiredAutopilot = buildDesiredAutopilotConfig();
        const shouldAutostart = input.autostart_ring_leader ?? boolFromEnv("TRICHAT_RING_LEADER_AUTOSTART", true);

      if (input.seed_cluster_topology !== false) {
        await clusterTopology(storage, {
          action: "ensure_lab",
          mutation: deriveMutation(input.mutation!, "autonomy.cluster.topology.ensure_lab"),
          local_host_id: input.local_host_id,
          workspace_root: process.cwd(),
          source_client: "autonomy.bootstrap",
          source_agent: input.source_agent,
          source_model: input.source_model,
        });
        actions.push("cluster.topology.ensure_lab");
      }

      const persistedFabric = storage.getWorkerFabricState();
      if (!persistedFabric?.enabled || persistedFabric.default_host_id !== input.local_host_id) {
        await workerFabric(storage, {
          action: "configure",
          mutation: deriveMutation(input.mutation!, "autonomy.worker.fabric.configure"),
          enabled: true,
          strategy: "resource_aware",
          default_host_id: input.local_host_id,
          source_client: "autonomy.bootstrap",
          source_agent: input.source_agent,
          source_model: input.source_model,
        });
        actions.push("worker.fabric.configure");
      }
      await workerFabric(storage, {
        action: "upsert_host",
        mutation: deriveMutation(input.mutation!, "autonomy.worker.fabric.local_host"),
        host: localHost.host,
        source_client: "autonomy.bootstrap",
        source_agent: input.source_agent,
        source_model: input.source_model,
      });
      actions.push("worker.fabric.upsert_host");

      if (input.seed_cluster_topology !== false) {
        await clusterTopology(storage, {
          action: "sync_worker_fabric",
          mutation: deriveMutation(input.mutation!, "autonomy.cluster.topology.sync_worker_fabric"),
          local_host_id: input.local_host_id,
          fallback_shell: process.env.SHELL || "/bin/zsh",
          fallback_worker_count: resolveSafeTmuxWorkerCount(),
          source_client: "autonomy.bootstrap",
          source_agent: input.source_agent,
          source_model: input.source_model,
        });
        actions.push("cluster.topology.sync_worker_fabric");
      }

      if (ensuredBackends.length > 0) {
        const routerStatus = storage.getModelRouterState();
        const primaryBackend = selectPrimaryBootstrapBackend(ensuredBackends, routerStatus, input.local_host_id);
        if (!primaryBackend) {
          throw new Error("autonomy.bootstrap could not determine a primary backend");
        }
        for (const backend of ensuredBackends) {
          await modelRouter(storage, {
            action: "upsert_backend",
            mutation: deriveMutation(input.mutation!, `autonomy.model.router.${backend.backend_id}`),
            backend: {
              ...backend,
              heartbeat_at: new Date().toISOString(),
              metadata: {
                ...(backend.metadata ?? {}),
                bootstrap_source: "autonomy.bootstrap",
              },
            },
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push(`model.router.upsert_backend:${backend.backend_id}`);
        }
        const routerAfterUpserts = storage.getModelRouterState();
        if (!routerAfterUpserts?.enabled || routerAfterUpserts.default_backend_id !== primaryBackend.backend_id) {
          await modelRouter(storage, {
            action: "configure",
            mutation: deriveMutation(input.mutation!, "autonomy.model.router.configure"),
            enabled: true,
            strategy: "prefer_quality",
            default_backend_id: primaryBackend.backend_id,
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push("model.router.configure");
        }
      }

      const persistedRouterAfterEnsure = storage.getModelRouterState();
      const availableLocalBackends = (persistedRouterAfterEnsure?.backends ?? []).filter(
        (entry) =>
          entry.enabled !== false &&
          (String(entry.host_id || "") === input.local_host_id || String(entry.locality || "") === "local")
      );

      if (input.seed_org_programs !== false) {
        for (const agent of getTriChatAgentCatalog().filter((entry) => entry.enabled !== false)) {
          const existing = getEffectiveOrgProgram(storage, agent.agent_id);
          if (existing) continue;
          await orgProgram(storage, {
            action: "upsert_role",
            mutation: deriveMutation(input.mutation!, `autonomy.org.program.${agent.agent_id}`),
            role_id: agent.agent_id,
            title: agent.display_name,
            description: agent.description ?? `${agent.display_name} autonomous operating doctrine.`,
            lane: agent.role_lane ?? "general",
            version: {
              version_id: `${agent.agent_id}-bootstrap-v1`,
              summary: `${agent.display_name} bootstrap operating doctrine`,
              doctrine: agent.system_prompt,
              delegation_contract: buildDelegationContract(String(agent.coordination_tier || "")),
              evaluation_standard: buildEvaluationStandard(String(agent.role_lane || ""), String(agent.coordination_tier || "")),
              status: "active",
              metadata: {
                bootstrap_source: "autonomy.bootstrap",
              },
            },
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push(`org.program.upsert_role:${agent.agent_id}`);
        }
      }

      if (input.seed_benchmark_suite !== false) {
        const suites = benchmarkSuiteList(storage, {});
        const existingSuite = suites.suites.find((entry) => entry.suite_id === DEFAULT_BENCHMARK_SUITE_ID);
        if (defaultAutonomySmokeBenchmarkSuiteNeedsReconcile(existingSuite, process.cwd())) {
          const suite = buildDefaultAutonomySmokeBenchmarkSuite(process.cwd());
          await benchmarkSuiteUpsert(storage, {
            mutation: deriveMutation(input.mutation!, "autonomy.benchmark.suite"),
            suite_id: suite.suite_id,
            title: suite.title,
            objective: suite.objective,
            project_dir: suite.project_dir,
            isolation_mode: suite.isolation_mode,
            aggregate_metric_name: suite.aggregate_metric_name,
            aggregate_metric_direction: suite.aggregate_metric_direction,
            cases: suite.cases,
            tags: suite.tags,
            metadata: suite.metadata,
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push("benchmark.suite_upsert:autonomy.smoke.local");
        }
      }

      if (input.seed_eval_suite !== false && availableLocalBackends.length > 0) {
        const evalSuites = evalSuiteList(storage, {});
        const routerState = storage.getModelRouterState();
        const routerLocalBackends = (routerState?.backends ?? []).filter(
          (entry) => String(entry.locality || "") === "local" || String(entry.host_id || "") === input.local_host_id
        );
        const primaryBackend =
          resolvePrimaryLocalBackend(routerLocalBackends, routerState?.default_backend_id) ??
          selectPrimaryLocalBackend(availableLocalBackends, input.local_host_id);
        if (!primaryBackend) {
          throw new Error("autonomy.bootstrap could not determine an eval backend");
        }
        const existingEvalSuite = evalSuites.suites.find((entry) => entry.suite_id === DEFAULT_EVAL_SUITE_ID);
        if (defaultAutonomyControlPlaneEvalSuiteNeedsReconcile(existingEvalSuite, primaryBackend)) {
          const suite = buildDefaultAutonomyControlPlaneEvalSuite(primaryBackend);
          await evalSuiteUpsert(storage, {
            mutation: deriveMutation(input.mutation!, "autonomy.eval.suite"),
            suite_id: suite.suite_id,
            title: suite.title,
            objective: suite.objective,
            aggregate_metric_name: suite.aggregate_metric_name,
            aggregate_metric_direction: suite.aggregate_metric_direction,
            cases: suite.cases,
            tags: suite.tags,
            metadata: suite.metadata,
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push("eval.suite_upsert:autonomy.control-plane");
        }
      }

      const autopilotStatus = (await Promise.resolve(
        trichatAutopilotControl(storage, invokeTool, { action: "status" } as any)
      )) as Record<string, unknown>;
      const currentConfig = isRecord(autopilotStatus.config) ? autopilotStatus.config : {};
      const persistedAutopilot = storage.getTriChatAutopilotState();
      const enforceAutopilotConfig = boolFromEnv("TRICHAT_RING_LEADER_ENFORCE_STARTUP_CONFIG", false);
      const startConfig =
        persistedAutopilot && isRecord(currentConfig)
          ? currentConfig
          : desiredAutopilot;
      const autopilotNeedsSync =
        shouldAutostart &&
        availableLocalBackends.length > 0 &&
        (!autopilotStatus.running ||
          (!persistedAutopilot &&
            enforceAutopilotConfig &&
            (String(currentConfig.thread_id || "") !== desiredAutopilot.thread_id ||
              String(currentConfig.lead_agent_id || "") !== desiredAutopilot.lead_agent_id ||
              JSON.stringify(normalizeStringArray(currentConfig.specialist_agent_ids)) !==
                JSON.stringify(desiredAutopilot.specialist_agent_ids))));
      if (autopilotNeedsSync) {
        await trichatAutopilotControl(storage, invokeTool, {
          action: "start",
          mutation: deriveMutation(input.mutation!, "autonomy.trichat.autopilot.start"),
          run_immediately: input.run_immediately ?? false,
          ...startConfig,
        } as any);
        actions.push("trichat.autopilot.start");
      }

      const warmCacheState = storage.getWarmCacheState();
      if (warmCacheState.enabled) {
        await invokeTool("warm.cache", {
          action: "run_once",
          mutation: deriveMutation(input.mutation!, "autonomy.warm.cache"),
          thread_id: warmCacheState.thread_id,
        });
        actions.push("warm.cache");
      }

        const status =
          input.fast === true
            ? inspectBootstrapStateFast(storage, input)
            : await inspectBootstrapState(storage, invokeTool, input, ensuredBackends);
        return {
          ok: status.self_start_ready,
          actions,
          status,
        };
      },
    })
  );
}
