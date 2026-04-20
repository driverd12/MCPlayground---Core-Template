import { z } from "zod";
import {
  Storage,
  type ModelRouterBackendRecord,
  type ModelRouterStateRecord,
  type ModelRouterTaskKind,
  type WorkerFabricStateRecord,
} from "../storage.js";
import { planClusterTopologyBackends } from "./cluster_topology.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { computeHostHealthScore, resolveEffectiveWorkerFabric, resolveLocalBridgeResourceGate } from "./worker_fabric.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const backendSchema = z.object({
  backend_id: z.string().min(1),
  enabled: z.boolean().optional(),
  provider: z
    .enum(["ollama", "mlx", "llama.cpp", "vllm", "openai", "google", "cursor", "anthropic", "github-copilot", "custom"])
    .default("custom"),
  model_id: z.string().min(1),
  endpoint: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  locality: z.enum(["local", "remote"]).optional(),
  context_window: z.number().int().min(256).max(10000000).optional(),
  throughput_tps: z.number().min(0).max(1000000).optional(),
  latency_ms_p50: z.number().min(0).max(10000000).optional(),
  success_rate: z.number().min(0).max(1).optional(),
  win_rate: z.number().min(0).max(1).optional(),
  cost_per_1k_input: z.number().min(0).max(1000000).optional(),
  max_output_tokens: z.number().int().min(0).max(10000000).optional(),
  tags: z.array(z.string().min(1)).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
  heartbeat_at: z.string().optional(),
});

const routeTaskKindSchema = z.enum(["planning", "coding", "research", "verification", "chat", "tool_use"]);

export const modelRouterSchema = z
  .object({
    action: z.enum(["status", "local_status", "configure", "upsert_backend", "heartbeat", "remove_backend", "route", "select_local_backend"]).default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    strategy: z.enum(["balanced", "prefer_speed", "prefer_quality", "prefer_cost", "prefer_context_fit"]).optional(),
    default_backend_id: z.string().min(1).optional(),
    backend_id: z.string().min(1).optional(),
    backend: backendSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    capabilities: recordSchema.optional(),
    quality_preference: z.enum(["speed", "balanced", "quality", "cost"]).optional(),
    task_kind: routeTaskKindSchema.optional(),
    context_tokens: z.number().int().min(0).max(10000000).optional(),
    latency_budget_ms: z.number().min(0).max(10000000).optional(),
    required_tags: z.array(z.string().min(1)).optional(),
    preferred_tags: z.array(z.string().min(1)).optional(),
    required_backend_ids: z.array(z.string().min(1)).optional(),
    fallback_workspace_root: z.string().min(1).optional(),
    fallback_worker_count: z.number().int().min(1).max(64).optional(),
    fallback_shell: z.string().min(1).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && value.action !== "route" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for model router writes",
        path: ["mutation"],
      });
    }
    if (value.action === "upsert_backend" && !value.backend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "backend is required for upsert_backend",
        path: ["backend"],
      });
    }
    if ((value.action === "remove_backend" || value.action === "heartbeat" || value.action === "select_local_backend") && !value.backend_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "backend_id is required",
        path: ["backend_id"],
      });
    }
  });

type RouteQualityPreference = "speed" | "balanced" | "quality" | "cost";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function isoAgeSeconds(value: unknown) {
  const text = readString(value);
  if (!text) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - timestamp) / 1000);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function inferBackendLocality(input: {
  locality?: "local" | "remote" | null;
  host_id?: string | null;
  endpoint?: string | null;
}) {
  if (input.locality === "local" || input.locality === "remote") {
    return input.locality;
  }
  const hostId = readString(input.host_id);
  if (hostId === "local") {
    return "local" as const;
  }
  const endpoint = readString(input.endpoint);
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      const hostname = url.hostname.trim().toLowerCase();
      if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
        return "local" as const;
      }
    } catch {
      // ignore invalid endpoints and fall through to host-based inference.
    }
  }
  return hostId ? "remote" as const : "local" as const;
}

function loadModelRouterState(storage: Storage): ModelRouterStateRecord {
  return (
    storage.getModelRouterState() ?? {
      enabled: false,
      strategy: "balanced",
      default_backend_id: null,
      backends: [],
      updated_at: new Date().toISOString(),
    }
  );
}

function normalizeBackend(input: ModelRouterBackendRecord): ModelRouterBackendRecord {
  return {
    backend_id: input.backend_id.trim(),
    enabled: input.enabled !== false,
    provider: input.provider,
    model_id: input.model_id.trim(),
    endpoint: input.endpoint?.trim() || null,
    host_id: input.host_id?.trim() || null,
    locality: inferBackendLocality({
      locality: input.locality,
      host_id: input.host_id,
      endpoint: input.endpoint,
    }),
    context_window: Math.max(256, Math.min(10_000_000, Math.trunc(input.context_window || 8192))),
    throughput_tps:
      typeof input.throughput_tps === "number" && Number.isFinite(input.throughput_tps) ? Number(input.throughput_tps.toFixed(4)) : null,
    latency_ms_p50:
      typeof input.latency_ms_p50 === "number" && Number.isFinite(input.latency_ms_p50) ? Number(input.latency_ms_p50.toFixed(4)) : null,
    success_rate:
      typeof input.success_rate === "number" && Number.isFinite(input.success_rate) ? Math.max(0, Math.min(1, input.success_rate)) : null,
    win_rate:
      typeof input.win_rate === "number" && Number.isFinite(input.win_rate) ? Math.max(0, Math.min(1, input.win_rate)) : null,
    cost_per_1k_input:
      typeof input.cost_per_1k_input === "number" && Number.isFinite(input.cost_per_1k_input) ? Number(input.cost_per_1k_input.toFixed(4)) : null,
    max_output_tokens:
      typeof input.max_output_tokens === "number" && Number.isFinite(input.max_output_tokens) ? Math.max(0, Math.round(input.max_output_tokens)) : null,
    tags: [...new Set((input.tags ?? []).map((entry) => entry.trim()).filter(Boolean))],
    capabilities: isRecord(input.capabilities) ? input.capabilities : {},
    metadata: isRecord(input.metadata) ? input.metadata : {},
    heartbeat_at: input.heartbeat_at?.trim() || null,
    updated_at: input.updated_at,
  };
}

function resolveTaskAffinity(backend: ModelRouterBackendRecord, taskKind: ModelRouterTaskKind | null) {
  if (!taskKind) {
    return 0.7;
  }
  const tags = new Set(backend.tags.map((entry) => entry.toLowerCase()));
  const taskKinds = normalizeStringArray((backend.capabilities as Record<string, unknown>).task_kinds).map((entry) =>
    entry.toLowerCase()
  );
  if (taskKinds.includes(taskKind)) {
    return 1;
  }
  if (taskKind === "coding" && (tags.has("code") || tags.has("coding") || tags.has("reasoning"))) {
    return 0.95;
  }
  if (taskKind === "research" && (tags.has("research") || tags.has("analysis") || tags.has("long-context"))) {
    return 0.95;
  }
  if (taskKind === "verification" && (tags.has("verify") || tags.has("critic") || tags.has("review"))) {
    return 0.95;
  }
  if (taskKind === "planning" && (tags.has("planner") || tags.has("reasoning"))) {
    return 0.95;
  }
  return tags.has(taskKind) ? 0.9 : 0.55;
}

function resolveAcceleratorFit(
  backend: ModelRouterBackendRecord,
  taskKind: ModelRouterTaskKind | null,
  preferredTags: string[]
) {
  const tags = new Set(backend.tags.map((entry) => entry.toLowerCase()));
  const capabilities = isRecord(backend.capabilities) ? backend.capabilities : {};
  const acceleratorKind = readString(capabilities.accelerator_kind)?.toLowerCase();
  const gpuApi = readString(capabilities.gpu_api)?.toLowerCase();
  const hasGpu =
    tags.has("gpu") ||
    backend.provider === "mlx" ||
    backend.provider === "vllm" ||
    backend.provider === "llama.cpp" ||
    acceleratorKind === "apple-metal" ||
    acceleratorKind === "nvidia-cuda";
  if (!hasGpu) {
    return 0.55;
  }
  let score = 0.78;
  if (taskKind === "coding" || taskKind === "research" || taskKind === "planning") {
    score += 0.1;
  }
  if (preferredTags.some((tag) => ["gpu", "metal", "cuda", "apple-silicon", "local"].includes(tag.toLowerCase()))) {
    score += 0.08;
  }
  if (backend.provider === "mlx" && (gpuApi === "metal" || tags.has("metal"))) {
    score += 0.08;
  }
  if ((backend.provider === "vllm" || backend.provider === "llama.cpp") && (gpuApi === "cuda" || tags.has("cuda"))) {
    score += 0.08;
  }
  return Math.max(0.1, Math.min(1, Number(score.toFixed(4))));
}

function resolveRouteStrategy(inputPreference: RouteQualityPreference | undefined, stateStrategy: ModelRouterStateRecord["strategy"]) {
  if (inputPreference === "speed") {
    return "prefer_speed" as const;
  }
  if (inputPreference === "quality") {
    return "prefer_quality" as const;
  }
  if (inputPreference === "cost") {
    return "prefer_cost" as const;
  }
  return stateStrategy;
}

function resolveOperationalReadinessScore(input: {
  locality: "local" | "remote";
  probe_healthy: boolean | null;
  probe_model_known: boolean | null;
  probe_model_loaded: boolean | null;
}) {
  if (input.locality === "local") {
    if (input.probe_healthy === true) {
      return 1;
    }
    if (input.probe_healthy === false) {
      if (input.probe_model_known === true && input.probe_model_loaded === true) {
        return 0.82;
      }
      if (input.probe_model_known === true) {
        return 0.35;
      }
      return 0.02;
    }
    if (input.probe_model_known === true && input.probe_model_loaded === true) {
      return 0.88;
    }
    if (input.probe_model_known === true) {
      return 0.68;
    }
    return 0.55;
  }
  if (input.probe_healthy === true) {
    return 0.92;
  }
  if (input.probe_healthy === false) {
    return 0.4;
  }
  return 0.6;
}

function resolveDefaultAlignmentScore(
  backend: ModelRouterBackendRecord,
  defaultBackendId: string | null,
  preferredTags: string[]
) {
  const lowerTags = new Set(backend.tags.map((entry) => entry.toLowerCase()));
  const prefersPrimary = preferredTags.some((tag) => ["primary", "local", backend.provider].includes(tag.toLowerCase()));
  if (backend.backend_id === defaultBackendId) {
    return 1;
  }
  if (lowerTags.has("primary")) {
    return prefersPrimary ? 0.85 : 0.7;
  }
  return 0.35;
}

export function routeModelBackends(
  storage: Storage,
  input: {
    task_kind?: ModelRouterTaskKind;
    context_tokens?: number;
    latency_budget_ms?: number;
    required_tags?: string[];
    preferred_tags?: string[];
    required_backend_ids?: string[];
    quality_preference?: RouteQualityPreference;
    fallback_workspace_root?: string;
    fallback_worker_count?: number;
    fallback_shell?: string;
    effective_worker_fabric?: WorkerFabricStateRecord;
  }
) {
  const state = loadModelRouterState(storage);
  const planned_backends = planClusterTopologyBackends(storage, {
    task_kind: input.task_kind,
    preferred_tags: input.preferred_tags,
    required_tags: input.required_tags,
    required_backend_ids: input.required_backend_ids,
  });
  if (!state.enabled || state.backends.length === 0) {
    return {
      state,
      selected_backend: null,
      ranked_backends: [],
      planned_backends,
      strategy: resolveRouteStrategy(input.quality_preference, state.strategy),
      task_kind: input.task_kind ?? null,
      context_tokens: input.context_tokens ?? null,
      latency_budget_ms: input.latency_budget_ms ?? null,
    };
  }
  const requiredTags = normalizeStringArray(input.required_tags);
  const preferredTags = normalizeStringArray(input.preferred_tags);
  const requiredBackendIds = normalizeStringArray(input.required_backend_ids);
  const effectiveStrategy = resolveRouteStrategy(input.quality_preference, state.strategy);
  const fabric =
    input.effective_worker_fabric ??
    resolveEffectiveWorkerFabric(storage, {
      fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
      fallback_worker_count: input.fallback_worker_count ?? 1,
      fallback_shell: input.fallback_shell ?? "/bin/zsh",
    });
  const hostHealthById = new Map(
    fabric.hosts.map((host) => [host.host_id, computeHostHealthScore(host.telemetry)])
  );

  const ranked = state.backends
    .filter((backend) => backend.enabled)
    .filter((backend) => requiredBackendIds.length === 0 || requiredBackendIds.includes(backend.backend_id))
    .filter((backend) => requiredTags.every((tag) => backend.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())))
    .map((backend) => {
      const probeHealthy = readBoolean((backend.capabilities as Record<string, unknown>).probe_healthy);
      const probeModelKnown = readBoolean((backend.capabilities as Record<string, unknown>).probe_model_known);
      const probeModelLoaded = readBoolean((backend.capabilities as Record<string, unknown>).probe_model_loaded);
      const probeAgeSeconds = isoAgeSeconds((backend.capabilities as Record<string, unknown>).probe_generated_at);
      const contextFit =
        typeof input.context_tokens === "number" && input.context_tokens > 0
          ? Math.max(0.1, Math.min(1, backend.context_window / input.context_tokens))
          : 0.8;
      const latencyScore =
        typeof input.latency_budget_ms === "number" && input.latency_budget_ms > 0
          ? backend.latency_ms_p50 === null
            ? 0.5
            : Math.max(0.1, Math.min(1, input.latency_budget_ms / Math.max(input.latency_budget_ms, backend.latency_ms_p50)))
          : backend.latency_ms_p50 === null
            ? 0.5
            : Math.max(0.1, Math.min(1, 2000 / Math.max(2000, backend.latency_ms_p50)));
      const qualityScore = ((backend.win_rate ?? 0.65) * 0.6) + ((backend.success_rate ?? 0.75) * 0.4);
      const throughputScore = backend.throughput_tps === null ? 0.5 : Math.max(0.1, Math.min(1, backend.throughput_tps / 200));
      const costScore =
        backend.cost_per_1k_input === null ? 0.6 : Math.max(0.05, Math.min(1, 1 / Math.max(1, backend.cost_per_1k_input)));
      const taskAffinity = resolveTaskAffinity(backend, input.task_kind ?? null);
      const preferredTagScore =
        preferredTags.length === 0
          ? 0.6
          : preferredTags.filter((tag) => backend.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())).length /
            preferredTags.length;
      const acceleratorFit = resolveAcceleratorFit(backend, input.task_kind ?? null, preferredTags);
      const probeFreshnessScore =
        !Number.isFinite(probeAgeSeconds) || probeAgeSeconds === Number.POSITIVE_INFINITY
          ? 0.45
          : probeAgeSeconds <= 300
            ? 1
            : probeAgeSeconds <= 900
              ? 0.8
              : probeAgeSeconds <= 1800
                ? 0.6
                : 0.35;
      const probeHealthScore = probeHealthy === null ? 0.55 : probeHealthy ? 1 : 0.15;
      const modelKnownScore = probeModelKnown === null ? 0.7 : probeModelKnown ? 1 : 0.05;
      const modelLoadedScore = probeModelLoaded === null ? 0.6 : probeModelLoaded ? 1 : 0.4;
      const operationalReadiness = resolveOperationalReadinessScore({
        locality: backend.locality,
        probe_healthy: probeHealthy,
        probe_model_known: probeModelKnown,
        probe_model_loaded: probeModelLoaded,
      });
      const defaultAlignment = resolveDefaultAlignmentScore(backend, state.default_backend_id, preferredTags);
      const hostHealth =
        backend.host_id && hostHealthById.has(backend.host_id) ? hostHealthById.get(backend.host_id)! : backend.locality === "local" ? 0.9 : 0.7;
      const strategyScore =
        effectiveStrategy === "prefer_speed"
          ? latencyScore * 0.35 +
            throughputScore * 0.18 +
            qualityScore * 0.12 +
            contextFit * 0.08 +
            hostHealth * 0.1 +
            probeHealthScore * 0.1 +
            probeFreshnessScore * 0.04 +
            modelKnownScore * 0.02 +
            modelLoadedScore * 0.01 +
            operationalReadiness * 0.08 +
            defaultAlignment * 0.02
          : effectiveStrategy === "prefer_quality"
            ? qualityScore * 0.29 +
              taskAffinity * 0.16 +
              contextFit * 0.12 +
              hostHealth * 0.08 +
              latencyScore * 0.07 +
              probeHealthScore * 0.08 +
              probeFreshnessScore * 0.03 +
              modelKnownScore * 0.02 +
              modelLoadedScore * 0.02 +
              preferredTagScore * 0.06 +
              operationalReadiness * 0.05 +
              defaultAlignment * 0.02
            : effectiveStrategy === "prefer_cost"
              ? costScore * 0.35 +
                hostHealth * 0.18 +
                latencyScore * 0.12 +
                qualityScore * 0.08 +
                contextFit * 0.08 +
                probeHealthScore * 0.1 +
                probeFreshnessScore * 0.05 +
                modelKnownScore * 0.03 +
                modelLoadedScore * 0.01 +
                operationalReadiness * 0.06 +
                defaultAlignment * 0.02
              : effectiveStrategy === "prefer_context_fit"
                ? contextFit * 0.35 +
                  qualityScore * 0.12 +
                  latencyScore * 0.12 +
                  taskAffinity * 0.12 +
                  hostHealth * 0.1 +
                  probeHealthScore * 0.1 +
                  probeFreshnessScore * 0.05 +
                  modelKnownScore * 0.03 +
                  modelLoadedScore * 0.01 +
                  operationalReadiness * 0.06 +
                  defaultAlignment * 0.02
                : qualityScore * 0.25 +
                  latencyScore * 0.2 +
                  contextFit * 0.15 +
                  throughputScore * 0.1 +
                  costScore * 0.1 +
                  taskAffinity * 0.1 +
                  preferredTagScore * 0.04 +
                  acceleratorFit * 0.04 +
                  hostHealth * 0.05 +
                  probeHealthScore * 0.06 +
                  probeFreshnessScore * 0.03 +
                  modelKnownScore * 0.005 +
                  modelLoadedScore * 0.005 +
                  operationalReadiness * 0.08 +
                  defaultAlignment * 0.02;
      return {
        backend,
        score: Number(strategyScore.toFixed(4)),
        reasoning: {
          strategy: effectiveStrategy,
          context_fit: Number(contextFit.toFixed(4)),
          latency_score: Number(latencyScore.toFixed(4)),
          quality_score: Number(qualityScore.toFixed(4)),
          throughput_score: Number(throughputScore.toFixed(4)),
          cost_score: Number(costScore.toFixed(4)),
          task_affinity: Number(taskAffinity.toFixed(4)),
          preferred_tag_score: Number(preferredTagScore.toFixed(4)),
          accelerator_fit: Number(acceleratorFit.toFixed(4)),
          host_health: Number(hostHealth.toFixed(4)),
          probe_health: Number(probeHealthScore.toFixed(4)),
          probe_freshness: Number(probeFreshnessScore.toFixed(4)),
          model_known: Number(modelKnownScore.toFixed(4)),
          model_loaded: Number(modelLoadedScore.toFixed(4)),
          operational_readiness: Number(operationalReadiness.toFixed(4)),
          default_alignment: Number(defaultAlignment.toFixed(4)),
        },
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      const leftDefault = left.backend.backend_id === state.default_backend_id ? 1 : 0;
      const rightDefault = right.backend.backend_id === state.default_backend_id ? 1 : 0;
      if (leftDefault !== rightDefault) {
        return rightDefault - leftDefault;
      }
      return left.backend.backend_id.localeCompare(right.backend.backend_id);
    });

  return {
    state,
    selected_backend: ranked[0]?.backend ?? null,
    ranked_backends: ranked,
    planned_backends,
    strategy: effectiveStrategy,
    task_kind: input.task_kind ?? null,
    context_tokens: input.context_tokens ?? null,
    latency_budget_ms: input.latency_budget_ms ?? null,
  };
}

export function inferObjectiveTaskKind(objective: string): ModelRouterTaskKind {
  const normalized = objective.trim().toLowerCase();
  if (!normalized) {
    return "planning";
  }
  if (
    /\b(test|verify|review|validate|regression|audit|prove|smoke|check|qa|quality|release)\b/.test(normalized)
  ) {
    return "verification";
  }
  if (
    /\b(research|investigate|compare|summari[sz]e|analy[sz]e|analysis|explore|gather|evaluate|benchmark|doc|docs)\b/.test(
      normalized
    )
  ) {
    return "research";
  }
  if (
    /\b(build|implement|refactor|patch|fix|code|script|wire|integrat|ship|deploy|compile|container|docker|kubernetes|proxmox)\b/.test(
      normalized
    )
  ) {
    return "coding";
  }
  if (/\b(chat|reply|respond|message)\b/.test(normalized)) {
    return "chat";
  }
  if (/\b(tool|command|workflow|automate|orchestrate|route|dispatch)\b/.test(normalized)) {
    return "tool_use";
  }
  return "planning";
}

function inferObjectivePreferredTags(objective: string, taskKind: ModelRouterTaskKind) {
  const normalized = objective.trim().toLowerCase();
  const tags = new Set<string>([taskKind]);
  if (/\b(frontier|deep|complex|high[- ]risk|cross[- ]system|architecture|presentation)\b/.test(normalized)) {
    tags.add("frontier");
  }
  if (/\b(local|offline|on-device|ollama|mlx|llama)\b/.test(normalized)) {
    tags.add("local");
  }
  if (/\b(gpu|metal|cuda|apple silicon|apple-silicon|nvidia|vram)\b/.test(normalized)) {
    tags.add("gpu");
  }
  if (/\b(metal|apple silicon|apple-silicon|mlx)\b/.test(normalized)) {
    tags.add("metal");
    tags.add("apple-silicon");
  }
  if (/\b(cuda|nvidia|rtx|vllm)\b/.test(normalized)) {
    tags.add("cuda");
  }
  if (/\b(train|training|fine[- ]?tune|finetune|quanti[sz]e|evolve)\b/.test(normalized)) {
    tags.add("gpu");
    tags.add("training");
  }
  if (/\b(hosted|cloud|remote|provider|api|internet|gemini|codex|cursor|copilot|chatgpt|openai)\b/.test(normalized)) {
    tags.add("hosted");
  }
  if (taskKind === "research") {
    tags.add("analysis");
  }
  if (taskKind === "coding") {
    tags.add("implementer");
  }
  if (taskKind === "verification") {
    tags.add("verify");
  }
  if (taskKind === "planning") {
    tags.add("planner");
  }
  return [...tags];
}

function resolveBridgeAgentIdsForBackend(backend: ModelRouterBackendRecord) {
  const metadata = isRecord(backend.metadata) ? backend.metadata : {};
  const capabilities = isRecord(backend.capabilities) ? backend.capabilities : {};
  return [
    ...new Set(
      [
        readString(metadata.bridge_agent_id),
        ...normalizeStringArray(metadata.bridge_agent_ids),
        readString(capabilities.bridge_agent_id),
        ...normalizeStringArray(capabilities.bridge_agent_ids),
      ].filter((entry): entry is string => Boolean(entry))
    ),
  ];
}

function objectiveExplicitlyRequestsHostedBridge(preferredTags: string[]) {
  const normalizedTags = preferredTags.map((entry) => entry.toLowerCase());
  return normalizedTags.includes("hosted");
}

function shouldSuppressAutoBridgeEscalation(
  selectedBackend: ModelRouterBackendRecord | null,
  preferredTags: string[]
) {
  if (!selectedBackend) {
    return false;
  }
  if (objectiveExplicitlyRequestsHostedBridge(preferredTags)) {
    return false;
  }
  const provider = String(selectedBackend.provider || "").trim().toLowerCase();
  return selectedBackend.locality === "local" && ["ollama", "mlx", "llama.cpp", "vllm"].includes(provider);
}

function isLocalExecutionProvider(provider: ModelRouterBackendRecord["provider"]) {
  return ["ollama", "mlx", "llama.cpp", "vllm"].includes(String(provider || "").trim().toLowerCase());
}

function isSelectableLocalBackend(backend: ModelRouterBackendRecord) {
  return backend.enabled !== false && (backend.locality === "local" || isLocalExecutionProvider(backend.provider));
}

function summarizeLocalBackend(backend: ModelRouterBackendRecord, defaultBackendId: string | null) {
  const heartbeatAgeSeconds = isoAgeSeconds(backend.heartbeat_at);
  return {
    backend_id: backend.backend_id,
    provider: backend.provider,
    model_id: backend.model_id,
    enabled: backend.enabled !== false,
    locality: backend.locality,
    host_id: backend.host_id,
    endpoint: backend.endpoint,
    selected_as_default: defaultBackendId === backend.backend_id,
    heartbeat_at: backend.heartbeat_at,
    heartbeat_age_seconds: Number.isFinite(heartbeatAgeSeconds) ? Number(heartbeatAgeSeconds.toFixed(3)) : null,
    throughput_tps: backend.throughput_tps,
    latency_ms_p50: backend.latency_ms_p50,
    success_rate: backend.success_rate,
    win_rate: backend.win_rate,
    context_window: backend.context_window,
    tags: backend.tags,
  };
}

function buildLocalBackendStatus(state: ModelRouterStateRecord) {
  const localBackends = state.backends.filter(isSelectableLocalBackend);
  const selectedLocalBackend = localBackends.find((backend) => backend.backend_id === state.default_backend_id) ?? null;
  return {
    state,
    default_backend_id: state.default_backend_id,
    local_backend_count: localBackends.length,
    local_backends: localBackends.map((backend) => summarizeLocalBackend(backend, state.default_backend_id)),
    selected_local_backend: selectedLocalBackend ? summarizeLocalBackend(selectedLocalBackend, state.default_backend_id) : null,
    cursor_local_first_mode: {
      canonical_ingress: "autonomy.ide_ingress",
      inspect_action: "model.router local_status",
      select_action: "model.router select_local_backend",
      guidance:
        "Use MASTER-MOLD as the control plane and keep Cursor as an MCP client. Select local Ollama/MLX backends here instead of relying on ad hoc editor chat state.",
    },
  };
}

function shouldSuppressAutoBridgeEscalationForMissingLocalAttemptEvidence(
  routedBridgeAgentIds: string[],
  localAttemptRecorded: boolean,
  localAttemptBypassed: boolean
) {
  return routedBridgeAgentIds.length > 0 && !localAttemptRecorded && !localAttemptBypassed;
}

export function routeObjectiveBackends(
  storage: Storage,
  input: {
    objective: string;
    explicit_agent_ids?: string[];
    required_tags?: string[];
    preferred_tags?: string[];
    required_backend_ids?: string[];
    quality_preference?: RouteQualityPreference;
    fallback_workspace_root?: string;
    fallback_worker_count?: number;
    fallback_shell?: string;
    bridge_margin?: number;
    local_attempt_recorded?: boolean;
    local_attempt_bypassed?: boolean;
  }
) {
  const taskKind = inferObjectiveTaskKind(input.objective);
  const preferredTags = [
    ...new Set([
      ...inferObjectivePreferredTags(input.objective, taskKind),
      ...normalizeStringArray(input.preferred_tags),
    ]),
  ];
  const resourceGate = resolveLocalBridgeResourceGate({
    storage,
    fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
    fallback_worker_count: input.fallback_worker_count ?? 1,
    fallback_shell: input.fallback_shell ?? "/bin/zsh",
  });
  const route = routeModelBackends(storage, {
    task_kind: taskKind,
    preferred_tags: preferredTags,
    required_tags: input.required_tags,
    required_backend_ids: input.required_backend_ids,
    quality_preference: input.quality_preference ?? "balanced",
    fallback_workspace_root: input.fallback_workspace_root,
    fallback_worker_count: input.fallback_worker_count,
    fallback_shell: input.fallback_shell,
  });
  const topScore = typeof route.ranked_backends[0]?.score === "number" ? route.ranked_backends[0].score : null;
  const bridgeMargin =
    typeof input.bridge_margin === "number" && Number.isFinite(input.bridge_margin) ? Math.max(0, input.bridge_margin) : 0.08;
  const explicitAgentIds = normalizeStringArray(input.explicit_agent_ids);
  const localAttemptRecorded = input.local_attempt_recorded === true;
  const localAttemptBypassed = input.local_attempt_bypassed === true;
  const suppressAutoBridgeEscalation = shouldSuppressAutoBridgeEscalation(route.selected_backend, preferredTags);
  const rawRoutedBridgeAgentIds = route.ranked_backends
    .filter((entry) => topScore === null || entry.score >= topScore - bridgeMargin)
    .flatMap((entry) => resolveBridgeAgentIdsForBackend(entry.backend));
  const suppressAutoBridgeEscalationForMissingLocalAttemptEvidence =
    shouldSuppressAutoBridgeEscalationForMissingLocalAttemptEvidence(
      rawRoutedBridgeAgentIds,
      localAttemptRecorded,
      localAttemptBypassed
    );
  const suppressAutoBridgeEscalationForResourceGate =
    rawRoutedBridgeAgentIds.length > 0 && resourceGate.recommendations.suppress_outbound_bridges === true;
  const routedBridgeAgentIds =
    suppressAutoBridgeEscalation ||
    suppressAutoBridgeEscalationForMissingLocalAttemptEvidence ||
    suppressAutoBridgeEscalationForResourceGate
      ? []
      : rawRoutedBridgeAgentIds;
  const suppressedBridgeAgentIds =
    suppressAutoBridgeEscalation ||
    suppressAutoBridgeEscalationForMissingLocalAttemptEvidence ||
    suppressAutoBridgeEscalationForResourceGate
      ? [...new Set(rawRoutedBridgeAgentIds)]
      : [];
  const effectiveAgentIds = [
    ...new Set([...explicitAgentIds, ...routedBridgeAgentIds].map((entry) => String(entry ?? "").trim()).filter(Boolean)),
  ];
  return {
    task_kind: taskKind,
    preferred_tags: preferredTags,
    route,
    resource_gate: resourceGate,
    routed_bridge_agent_ids: [...new Set(routedBridgeAgentIds)],
    effective_agent_ids: effectiveAgentIds,
    local_attempt_recorded: localAttemptRecorded,
    local_attempt_bypassed: localAttemptBypassed,
    auto_bridge_suppressed_for_local_first: suppressAutoBridgeEscalation,
    auto_bridge_suppressed_for_resource_gate: suppressAutoBridgeEscalationForResourceGate,
    auto_bridge_resource_gate_reason:
      suppressAutoBridgeEscalationForResourceGate
        ? resourceGate.detail ?? resourceGate.reason ?? "local_resource_gate_active"
        : null,
    auto_bridge_resource_gate_suppressed_agent_ids:
      suppressAutoBridgeEscalationForResourceGate ? [...new Set(rawRoutedBridgeAgentIds)] : [],
    auto_bridge_suppressed_for_missing_local_attempt_evidence:
      suppressAutoBridgeEscalationForMissingLocalAttemptEvidence,
    auto_bridge_suppressed_agent_ids: suppressedBridgeAgentIds,
    auto_bridge_escalation_reason: suppressAutoBridgeEscalationForResourceGate
      ? "resource_gate_pressure"
      : suppressAutoBridgeEscalationForMissingLocalAttemptEvidence
        ? "local_attempt_required_before_auto_bridge"
        : localAttemptBypassed
          ? "local_attempt_bypassed"
          : localAttemptRecorded
            ? "local_attempt_recorded"
            : null,
  };
}

export async function modelRouter(storage: Storage, input: z.infer<typeof modelRouterSchema>) {
  if (input.action === "status") {
    return {
      state: loadModelRouterState(storage),
      backend_count: loadModelRouterState(storage).backends.length,
    };
  }

  if (input.action === "local_status") {
    return buildLocalBackendStatus(loadModelRouterState(storage));
  }

  if (input.action === "route") {
    return routeModelBackends(storage, {
      task_kind: input.task_kind,
      context_tokens: input.context_tokens,
      latency_budget_ms: input.latency_budget_ms,
      required_tags: input.required_tags,
      preferred_tags: input.preferred_tags,
      required_backend_ids: input.required_backend_ids,
      quality_preference: input.quality_preference,
      fallback_workspace_root: input.fallback_workspace_root,
      fallback_worker_count: input.fallback_worker_count,
      fallback_shell: input.fallback_shell,
    });
  }

  return runIdempotentMutation({
    storage,
    tool_name: "model.router",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const existing = loadModelRouterState(storage);
      if (input.action === "configure") {
        return {
          state: storage.setModelRouterState({
            enabled: input.enabled ?? existing.enabled,
            strategy: input.strategy ?? existing.strategy,
            default_backend_id: input.default_backend_id ?? existing.default_backend_id,
            backends: existing.backends,
          }),
        };
      }

      if (input.action === "select_local_backend") {
        const backendId = input.backend_id!.trim();
        const selectedBackend = existing.backends.find((backend) => backend.backend_id === backendId) ?? null;
        if (!selectedBackend || !isSelectableLocalBackend(selectedBackend)) {
          throw new Error(`backend_id must reference an enabled local backend: ${backendId}`);
        }
        const nextState = storage.setModelRouterState({
          enabled: existing.enabled,
          strategy: existing.strategy,
          default_backend_id: selectedBackend.backend_id,
          backends: existing.backends,
        });
        return {
          ok: true,
          ...buildLocalBackendStatus(nextState),
        };
      }

      if (input.action === "upsert_backend") {
        const backend = normalizeBackend({
          backend_id: input.backend!.backend_id,
          enabled: input.backend!.enabled !== false,
          provider: input.backend!.provider,
          model_id: input.backend!.model_id,
          endpoint: input.backend!.endpoint?.trim() || null,
          host_id: input.backend!.host_id?.trim() || null,
          locality: inferBackendLocality({
            locality: input.backend!.locality ?? null,
            host_id: input.backend!.host_id?.trim() || null,
            endpoint: input.backend!.endpoint?.trim() || null,
          }),
          context_window: input.backend!.context_window ?? 8192,
          throughput_tps: input.backend!.throughput_tps ?? null,
          latency_ms_p50: input.backend!.latency_ms_p50 ?? null,
          success_rate: input.backend!.success_rate ?? null,
          win_rate: input.backend!.win_rate ?? null,
          cost_per_1k_input: input.backend!.cost_per_1k_input ?? null,
          max_output_tokens: input.backend!.max_output_tokens ?? null,
          tags: input.backend!.tags ?? [],
          capabilities: input.backend!.capabilities ?? {},
          metadata: input.backend!.metadata ?? {},
          heartbeat_at: input.backend!.heartbeat_at?.trim() || null,
          updated_at: new Date().toISOString(),
        });
        const nextBackends = existing.backends.filter((entry) => entry.backend_id !== backend.backend_id).concat([backend]);
        return {
          state: storage.setModelRouterState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_backend_id: existing.default_backend_id ?? backend.backend_id,
            backends: nextBackends,
          }),
        };
      }

      if (input.action === "heartbeat") {
        const backendId = input.backend_id!.trim();
        const nextBackends = existing.backends.map((backend) =>
          backend.backend_id !== backendId
            ? backend
            : normalizeBackend({
                ...backend,
                model_id: input.backend?.model_id?.trim() || backend.model_id,
                endpoint: input.backend?.endpoint?.trim() || backend.endpoint,
                host_id: input.backend?.host_id?.trim() || backend.host_id,
                locality: inferBackendLocality({
                  locality: input.backend?.locality ?? backend.locality,
                  host_id: input.backend?.host_id?.trim() || backend.host_id,
                  endpoint: input.backend?.endpoint?.trim() || backend.endpoint,
                }),
                context_window: input.backend?.context_window ?? backend.context_window,
                throughput_tps: input.backend?.throughput_tps ?? backend.throughput_tps,
                latency_ms_p50: input.backend?.latency_ms_p50 ?? backend.latency_ms_p50,
                success_rate: input.backend?.success_rate ?? backend.success_rate,
                win_rate: input.backend?.win_rate ?? backend.win_rate,
                cost_per_1k_input: input.backend?.cost_per_1k_input ?? backend.cost_per_1k_input,
                max_output_tokens: input.backend?.max_output_tokens ?? backend.max_output_tokens,
                tags: input.tags ? [...new Set([...backend.tags, ...input.tags.map((tag) => tag.trim()).filter(Boolean)])] : backend.tags,
                capabilities: input.capabilities && isRecord(input.capabilities)
                  ? { ...backend.capabilities, ...input.capabilities }
                  : backend.capabilities,
                metadata:
                  input.backend?.metadata && isRecord(input.backend.metadata)
                    ? { ...backend.metadata, ...input.backend.metadata }
                    : backend.metadata,
                heartbeat_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
        );
        return {
          state: storage.setModelRouterState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_backend_id: existing.default_backend_id,
            backends: nextBackends,
          }),
        };
      }

      const nextBackends = existing.backends.filter((backend) => backend.backend_id !== input.backend_id);
      return {
        state: storage.setModelRouterState({
          enabled: existing.enabled,
          strategy: existing.strategy,
          default_backend_id:
            existing.default_backend_id === input.backend_id ? nextBackends[0]?.backend_id ?? null : existing.default_backend_id,
          backends: nextBackends,
        }),
      };
    },
  });
}
