import { z } from "zod";
import {
  Storage,
  type WorkerFabricHostRecord,
  type WorkerFabricHostTelemetryRecord,
  type WorkerFabricStateRecord,
} from "../storage.js";
import { captureLocalHostProfile, deriveLocalExecutionBudget } from "../local_host_profile.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import type { ExecutionIsolationMode } from "../execution_isolation.js";

const hostTransportSchema = z.enum(["local", "ssh"]);
const thermalPressureSchema = z.enum(["nominal", "fair", "serious", "critical"]);

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const workerFabricTelemetrySchema = z.object({
  heartbeat_at: z.string().optional(),
  health_state: z.enum(["healthy", "degraded", "offline"]).optional(),
  queue_depth: z.number().int().min(0).max(100000).optional(),
  active_tasks: z.number().int().min(0).max(100000).optional(),
  latency_ms: z.number().min(0).max(10000000).optional(),
  cpu_utilization: z.number().min(0).max(1).optional(),
  ram_available_gb: z.number().min(0).max(1000000).optional(),
  ram_total_gb: z.number().min(0).max(1000000).optional(),
  swap_used_gb: z.number().min(0).max(1000000).optional(),
  gpu_utilization: z.number().min(0).max(1).optional(),
  gpu_memory_available_gb: z.number().min(0).max(1000000).optional(),
  gpu_memory_total_gb: z.number().min(0).max(1000000).optional(),
  disk_free_gb: z.number().min(0).max(1000000).optional(),
  thermal_pressure: thermalPressureSchema.optional(),
});

const workerFabricHostSchema = z.object({
  host_id: z.string().min(1),
  enabled: z.boolean().optional(),
  transport: hostTransportSchema.default("local"),
  ssh_destination: z.string().min(1).optional(),
  workspace_root: z.string().min(1),
  worker_count: z.number().int().min(1).max(64).default(1),
  shell: z.string().min(1).optional(),
  capabilities: recordSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
  telemetry: workerFabricTelemetrySchema.optional(),
  metadata: recordSchema.optional(),
});

export const workerFabricSchema = z
  .object({
    action: z.enum(["status", "configure", "upsert_host", "heartbeat", "remove_host"]).default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    strategy: z.enum(["balanced", "prefer_local", "prefer_capacity", "resource_aware"]).optional(),
    default_host_id: z.string().min(1).optional(),
    host_id: z.string().min(1).optional(),
    host: workerFabricHostSchema.optional(),
    telemetry: workerFabricTelemetrySchema.optional(),
    capabilities: recordSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    include_disabled: z.boolean().optional(),
    fallback_workspace_root: z.string().min(1).optional(),
    fallback_worker_count: z.number().int().min(1).max(64).optional(),
    fallback_shell: z.string().min(1).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for configure, upsert_host, and remove_host",
        path: ["mutation"],
      });
    }
    if (value.action === "upsert_host" && !value.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host is required for upsert_host",
        path: ["host"],
      });
    }
    if (value.action === "remove_host" && !value.host_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host_id is required for remove_host",
        path: ["host_id"],
      });
    }
    if (value.action === "heartbeat" && !value.host_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host_id is required for heartbeat",
        path: ["host_id"],
      });
    }
  });

export type WorkerFabricSlot = {
  worker_id: string;
  host_id: string;
  transport: "local" | "ssh";
  ssh_destination: string | null;
  workspace_root: string;
  shell: string;
  tags: string[];
  capabilities: Record<string, unknown>;
  telemetry: WorkerFabricHostTelemetryRecord;
  metadata: Record<string, unknown>;
};

export type TaskExecutionRouting = {
  preferred_host_ids: string[];
  allowed_host_ids: string[];
  preferred_host_tags: string[];
  required_host_tags: string[];
  preferred_backend_ids: string[];
  required_backend_ids: string[];
  preferred_model_tags: string[];
  required_model_tags: string[];
  isolation_mode: ExecutionIsolationMode;
  task_kind: "planning" | "coding" | "research" | "verification" | "chat" | "tool_use" | null;
  quality_preference: "speed" | "balanced" | "quality" | "cost" | null;
  selected_backend_id: string | null;
  selected_backend_provider: string | null;
  selected_backend_locality: "local" | "remote" | null;
  selected_host_id: string | null;
  selected_worker_host_id: string | null;
  routed_bridge_agent_ids: string[];
  planned_backend_candidates: Array<{
    backend_id: string;
    provider: string | null;
    host_id: string | null;
    node_id: string | null;
    title: string | null;
    score: number | null;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function mergeUniqueStrings(...values: Array<string[] | undefined>) {
  return [...new Set(values.flatMap((entry) => entry ?? []).map((entry) => entry.trim()).filter(Boolean))];
}

function normalizeTelemetry(input: Partial<WorkerFabricHostTelemetryRecord> | Record<string, unknown> | null | undefined) {
  const heartbeatAt =
    typeof input?.heartbeat_at === "string" && input.heartbeat_at.trim().length > 0
      ? input.heartbeat_at.trim()
      : null;
  const healthRaw = String(input?.health_state ?? "").trim().toLowerCase();
  const healthState =
    healthRaw === "degraded" || healthRaw === "offline" ? healthRaw : "healthy";
  const thermalRaw = String(input?.thermal_pressure ?? "").trim().toLowerCase();
  const thermalPressure =
    thermalRaw === "nominal" || thermalRaw === "fair" || thermalRaw === "serious" || thermalRaw === "critical"
      ? thermalRaw
      : null;
  const readRate = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const readCount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const readFloat = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Number(value.toFixed(4))) : null;
  return {
    heartbeat_at: heartbeatAt,
    health_state: healthState,
    queue_depth: readCount(input?.queue_depth),
    active_tasks: readCount(input?.active_tasks),
    latency_ms: readFloat(input?.latency_ms),
    cpu_utilization: readRate(input?.cpu_utilization),
    ram_available_gb: readFloat(input?.ram_available_gb),
    ram_total_gb: readFloat(input?.ram_total_gb),
    swap_used_gb: readFloat(input?.swap_used_gb),
    gpu_utilization: readRate(input?.gpu_utilization),
    gpu_memory_available_gb: readFloat(input?.gpu_memory_available_gb),
    gpu_memory_total_gb: readFloat(input?.gpu_memory_total_gb),
    disk_free_gb: readFloat(input?.disk_free_gb),
    thermal_pressure: thermalPressure,
  } satisfies WorkerFabricHostTelemetryRecord;
}

export function computeHostHealthScore(telemetry: WorkerFabricHostTelemetryRecord) {
  const healthBase = telemetry.health_state === "offline" ? 0 : telemetry.health_state === "degraded" ? 0.55 : 1;
  const cpuScore = telemetry.cpu_utilization === null ? 0.6 : 1 - telemetry.cpu_utilization;
  const gpuScore = telemetry.gpu_utilization === null ? 0.6 : 1 - telemetry.gpu_utilization;
  const queuePenalty = Math.min(0.4, telemetry.queue_depth * 0.03);
  const memoryRatio =
    telemetry.ram_available_gb === null || telemetry.ram_total_gb === null || telemetry.ram_total_gb <= 0
      ? null
      : Math.max(0, Math.min(1, telemetry.ram_available_gb / telemetry.ram_total_gb));
  const gpuMemoryRatio =
    telemetry.gpu_memory_available_gb === null ||
    telemetry.gpu_memory_total_gb === null ||
    telemetry.gpu_memory_total_gb <= 0
      ? null
      : Math.max(0, Math.min(1, telemetry.gpu_memory_available_gb / telemetry.gpu_memory_total_gb));
  const thermalPenalty =
    telemetry.thermal_pressure === "critical"
      ? 0.45
      : telemetry.thermal_pressure === "serious"
        ? 0.25
        : telemetry.thermal_pressure === "fair"
          ? 0.1
          : 0;
  const swapPenalty =
    telemetry.swap_used_gb === null ? 0 : telemetry.swap_used_gb >= 8 ? 0.28 : telemetry.swap_used_gb >= 4 ? 0.12 : 0;
  const cpuPenalty =
    telemetry.cpu_utilization === null
      ? 0
      : telemetry.cpu_utilization >= 0.95
        ? 0.2
        : telemetry.cpu_utilization >= 0.85
          ? 0.08
          : 0;
  const memoryPenalty =
    memoryRatio === null ? 0 : memoryRatio < 0.1 ? 0.35 : memoryRatio < 0.2 ? 0.2 : memoryRatio < 0.3 ? 0.08 : 0;
  const gpuMemoryPenalty =
    gpuMemoryRatio === null
      ? 0
      : gpuMemoryRatio < 0.1
        ? 0.3
        : gpuMemoryRatio < 0.2
          ? 0.16
          : gpuMemoryRatio < 0.3
            ? 0.06
            : 0;
  const memoryScore =
    memoryRatio === null ? 0.65 : Math.max(0.05, memoryRatio);
  const gpuMemoryScore =
    gpuMemoryRatio === null ? 0.65 : Math.max(0.05, gpuMemoryRatio);
  const score = healthBase * 0.35 + cpuScore * 0.15 + gpuScore * 0.1 + memoryScore * 0.15 + gpuMemoryScore * 0.15 + (1 - queuePenalty) * 0.1;
  return Math.max(0, Number((score - thermalPenalty - swapPenalty - cpuPenalty - memoryPenalty - gpuMemoryPenalty).toFixed(4)));
}

function normalizeHost(input: WorkerFabricHostRecord): WorkerFabricHostRecord {
  return {
    host_id: input.host_id.trim(),
    enabled: input.enabled !== false,
    transport: input.transport === "ssh" ? "ssh" : "local",
    ssh_destination: input.ssh_destination?.trim() || null,
    workspace_root: input.workspace_root.trim(),
    worker_count: Math.max(1, Math.min(64, Math.trunc(input.worker_count || 1))),
    shell: input.shell?.trim() || "/bin/zsh",
    capabilities: isRecord(input.capabilities) ? input.capabilities : {},
    tags: [...new Set((input.tags ?? []).map((entry) => entry.trim()).filter(Boolean))],
    telemetry: normalizeTelemetry(isRecord(input.telemetry) ? input.telemetry : input.telemetry ?? null),
    metadata: isRecord(input.metadata) ? input.metadata : {},
    updated_at: input.updated_at,
  };
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Number(value) : null;
}

export function resolveHostCapacityProfile(host: Pick<WorkerFabricHostRecord, "capabilities" | "metadata">) {
  const metadataProfile = isRecord(host.metadata?.local_execution_profile) ? host.metadata.local_execution_profile : {};
  return {
    recommended_worker_count:
      readOptionalNumber((metadataProfile as Record<string, unknown>).safe_worker_count) ??
      readOptionalNumber(host.capabilities?.safe_worker_count),
    safe_max_queue_per_worker:
      readOptionalNumber((metadataProfile as Record<string, unknown>).safe_max_queue_per_worker) ??
      readOptionalNumber(host.capabilities?.safe_max_queue_per_worker),
    max_local_model_concurrency:
      readOptionalNumber((metadataProfile as Record<string, unknown>).max_local_model_concurrency) ??
      readOptionalNumber(host.capabilities?.max_local_model_concurrency),
    recommended_runtime_worker_max_active:
      readOptionalNumber((metadataProfile as Record<string, unknown>).runtime_worker_max_active) ??
      readOptionalNumber(host.capabilities?.recommended_runtime_worker_max_active),
    recommended_runtime_worker_limit:
      readOptionalNumber((metadataProfile as Record<string, unknown>).runtime_worker_limit) ??
      readOptionalNumber(host.capabilities?.recommended_runtime_worker_limit),
    recommended_tmux_worker_count:
      readOptionalNumber((metadataProfile as Record<string, unknown>).tmux_recommended_worker_count) ??
      readOptionalNumber(host.capabilities?.recommended_tmux_worker_count),
    recommended_tmux_target_queue_per_worker:
      readOptionalNumber((metadataProfile as Record<string, unknown>).tmux_target_queue_per_worker) ??
      readOptionalNumber(host.capabilities?.recommended_tmux_target_queue_per_worker),
  };
}

export function buildImplicitLocalWorkerFabric(input: {
  workspace_root: string;
  worker_count: number;
  shell: string;
}): WorkerFabricStateRecord {
  const now = new Date().toISOString();
  return {
    enabled: true,
    strategy: "prefer_local",
    default_host_id: "local",
    updated_at: now,
    hosts: [
      {
        host_id: "local",
        enabled: true,
        transport: "local",
        ssh_destination: null,
        workspace_root: input.workspace_root,
        worker_count: Math.max(1, Math.min(64, Math.trunc(input.worker_count || 1))),
        shell: input.shell || "/bin/zsh",
        capabilities: {
          locality: "local",
        },
        tags: ["local", "default"],
        telemetry: normalizeTelemetry({
          heartbeat_at: now,
          health_state: "healthy",
        }),
        metadata: {},
        updated_at: now,
      },
    ],
  };
}

function resolveConfiguredLocalHostId(storage: Storage, hosts: WorkerFabricHostRecord[]) {
  const configured = storage.getAutonomyMaintainState()?.local_host_id?.trim();
  if (configured && hosts.some((host) => host.transport === "local" && host.host_id === configured)) {
    return configured;
  }
  const localHosts = hosts.filter((host) => host.transport === "local");
  if (localHosts.length === 1) {
    return localHosts[0]!.host_id;
  }
  if (localHosts.some((host) => host.host_id === "local")) {
    return "local";
  }
  return localHosts[0]?.host_id ?? null;
}

function overlayEffectiveLocalHost(host: WorkerFabricHostRecord, localHostId: string | null): WorkerFabricHostRecord {
  if (host.transport !== "local" || !localHostId || host.host_id !== localHostId) {
    return host;
  }

  const liveProfile = captureLocalHostProfile({
    workspace_root: host.workspace_root,
  });
  const liveBudget = deriveLocalExecutionBudget(liveProfile, {
    pending_tasks: host.telemetry.queue_depth,
    fabric_queue_depth: host.telemetry.queue_depth,
    active_runtime_workers: host.telemetry.active_tasks,
  });
  const existingProfile = isRecord(host.metadata?.local_execution_profile) ? host.metadata.local_execution_profile : {};
  return normalizeHost({
    ...host,
    capabilities: {
      ...host.capabilities,
      locality: "local",
      platform: liveProfile.platform,
      arch: liveProfile.arch,
      performance_cpu_count: liveProfile.performance_cpu_count,
      efficiency_cpu_count: liveProfile.efficiency_cpu_count,
      unified_memory_gb: liveProfile.memory_total_gb,
      accelerator_kind: liveProfile.accelerator_kind,
      gpu_vendor: liveProfile.gpu_vendor,
      gpu_model: liveProfile.gpu_model,
      gpu_api: liveProfile.gpu_api,
      gpu_family: liveProfile.gpu_family,
      gpu_core_count: liveProfile.gpu_core_count,
      gpu_memory_total_gb: liveProfile.gpu_memory_total_gb,
      gpu_memory_available_gb: liveProfile.gpu_memory_available_gb,
      mlx_python: liveProfile.mlx_python,
      mlx_available: liveProfile.mlx_available,
      mlx_lm_available: liveProfile.mlx_lm_available,
      safe_worker_count: liveProfile.safe_worker_count,
      safe_max_queue_per_worker: liveProfile.safe_max_queue_per_worker,
      max_local_model_concurrency: liveProfile.max_local_model_concurrency,
      recommended_runtime_worker_max_active: liveBudget.runtime_worker_max_active,
      recommended_runtime_worker_limit: liveBudget.runtime_worker_limit,
      recommended_tmux_worker_count: liveBudget.tmux_recommended_worker_count,
      recommended_tmux_target_queue_per_worker: liveBudget.tmux_target_queue_per_worker,
      memory_free_percent: liveProfile.memory_free_percent,
      full_gpu_access: liveProfile.full_gpu_access,
    },
    tags: mergeUniqueStrings(
      host.tags,
      [
        "local",
        liveProfile.platform,
        liveProfile.arch,
        liveProfile.arch === "arm64" ? "apple-silicon" : "x86",
        ...(liveProfile.full_gpu_access
          ? ["gpu", ...(liveProfile.gpu_api ? [liveProfile.gpu_api] : []), ...(liveProfile.unified_memory ? ["unified-memory"] : [])]
          : []),
        ...(liveProfile.mlx_available ? ["mlx"] : []),
      ]
    ),
    telemetry: normalizeTelemetry({
      ...host.telemetry,
      heartbeat_at: liveProfile.generated_at,
      health_state: liveProfile.health_state,
      cpu_utilization: liveProfile.cpu_utilization,
      ram_available_gb: liveProfile.memory_available_gb,
      ram_total_gb: liveProfile.memory_total_gb,
      swap_used_gb: liveProfile.swap_used_gb,
      gpu_utilization: liveProfile.gpu_utilization,
      gpu_memory_available_gb: liveProfile.gpu_memory_available_gb,
      gpu_memory_total_gb: liveProfile.gpu_memory_total_gb,
      disk_free_gb: liveProfile.disk_free_gb,
      thermal_pressure: liveProfile.thermal_pressure,
    }),
    metadata: {
      ...host.metadata,
      local_execution_profile: {
        ...existingProfile,
        generated_at: liveProfile.generated_at,
        safe_worker_count: liveProfile.safe_worker_count,
        safe_max_queue_per_worker: liveProfile.safe_max_queue_per_worker,
        max_local_model_concurrency: liveProfile.max_local_model_concurrency,
        runtime_worker_max_active: liveBudget.runtime_worker_max_active,
        runtime_worker_limit: liveBudget.runtime_worker_limit,
        tmux_recommended_worker_count: liveBudget.tmux_recommended_worker_count,
        tmux_target_queue_per_worker: liveBudget.tmux_target_queue_per_worker,
        memory_free_percent: liveProfile.memory_free_percent,
        swap_used_gb: liveProfile.swap_used_gb,
        health_state: liveProfile.health_state,
        accelerator_kind: liveProfile.accelerator_kind,
        gpu_model: liveProfile.gpu_model,
        gpu_api: liveProfile.gpu_api,
        gpu_core_count: liveProfile.gpu_core_count,
        mlx_python: liveProfile.mlx_python,
        mlx_available: liveProfile.mlx_available,
        mlx_lm_available: liveProfile.mlx_lm_available,
      },
    },
  });
}

export function resolveEffectiveWorkerFabric(storage: Storage, input: {
  fallback_workspace_root: string;
  fallback_worker_count: number;
  fallback_shell: string;
}) {
  const persisted = storage.getWorkerFabricState();
  if (!persisted || !persisted.enabled || persisted.hosts.filter((host) => host.enabled).length === 0) {
    return buildImplicitLocalWorkerFabric({
      workspace_root: input.fallback_workspace_root,
      worker_count: input.fallback_worker_count,
      shell: input.fallback_shell,
    });
  }

  const enabledHosts = persisted.hosts.map(normalizeHost).filter((host) => host.enabled);
  const configuredLocalHostId = resolveConfiguredLocalHostId(storage, enabledHosts);
  const effectiveHosts = enabledHosts.map((host) => overlayEffectiveLocalHost(host, configuredLocalHostId));
  const defaultHostId =
    persisted.default_host_id && effectiveHosts.some((host) => host.host_id === persisted.default_host_id)
      ? persisted.default_host_id
      : effectiveHosts[0]?.host_id ?? null;

  return {
    ...persisted,
    default_host_id: defaultHostId,
    hosts: effectiveHosts,
  } satisfies WorkerFabricStateRecord;
}

export function buildWorkerFabricSlots(
  storage: Storage,
  input: {
    fallback_workspace_root: string;
    fallback_worker_count: number;
    fallback_shell: string;
  }
): WorkerFabricSlot[] {
  const state = resolveEffectiveWorkerFabric(storage, input);
  const explicitFabric = Boolean(storage.getWorkerFabricState()?.enabled);
  const singleImplicitLocal =
    !explicitFabric &&
    state.hosts.length === 1 &&
    state.hosts[0]?.host_id === "local" &&
    state.hosts[0]?.transport === "local";

  return state.hosts.flatMap((host) =>
    Array.from({ length: host.worker_count }, (_, index) => {
      const laneId = `worker-${index + 1}`;
      return {
        worker_id: singleImplicitLocal ? laneId : `${host.host_id}--${laneId}`,
        host_id: host.host_id,
        transport: host.transport,
        ssh_destination: host.ssh_destination,
        workspace_root: host.workspace_root,
        shell: host.shell,
        tags: host.tags,
        capabilities: host.capabilities,
        telemetry: host.telemetry,
        metadata: host.metadata,
      } satisfies WorkerFabricSlot;
    })
  );
}

export function resolveTaskExecutionRouting(metadata: Record<string, unknown> | null | undefined): TaskExecutionRouting {
  const execution = isRecord(metadata?.task_execution)
    ? metadata?.task_execution
    : isRecord(metadata?.execution)
      ? metadata?.execution
      : {};
  const isolationRaw = String((execution as Record<string, unknown>).isolation_mode ?? "git_worktree")
    .trim()
    .toLowerCase();
  const isolationMode: ExecutionIsolationMode =
    isolationRaw === "copy" || isolationRaw === "none" ? isolationRaw : "git_worktree";
  const taskKindRaw = String((execution as Record<string, unknown>).task_kind ?? "").trim().toLowerCase();
  const taskKind: TaskExecutionRouting["task_kind"] =
    taskKindRaw === "planning" ||
    taskKindRaw === "coding" ||
    taskKindRaw === "research" ||
    taskKindRaw === "verification" ||
    taskKindRaw === "chat" ||
    taskKindRaw === "tool_use"
      ? taskKindRaw
      : null;
  const qualityPreferenceRaw = String((execution as Record<string, unknown>).quality_preference ?? "").trim().toLowerCase();
  const qualityPreference: TaskExecutionRouting["quality_preference"] =
    qualityPreferenceRaw === "speed" ||
    qualityPreferenceRaw === "balanced" ||
    qualityPreferenceRaw === "quality" ||
    qualityPreferenceRaw === "cost"
      ? qualityPreferenceRaw
      : null;
  const selectedHostId = readString((execution as Record<string, unknown>).selected_host_id);
  const preferredHostIds = normalizeStringArray((execution as Record<string, unknown>).preferred_host_ids);
  return {
    preferred_host_ids: selectedHostId ? [...new Set([selectedHostId, ...preferredHostIds])] : preferredHostIds,
    allowed_host_ids: normalizeStringArray((execution as Record<string, unknown>).allowed_host_ids),
    preferred_host_tags: normalizeStringArray((execution as Record<string, unknown>).preferred_host_tags),
    required_host_tags: normalizeStringArray((execution as Record<string, unknown>).required_host_tags),
    preferred_backend_ids: normalizeStringArray((execution as Record<string, unknown>).preferred_backend_ids),
    required_backend_ids: normalizeStringArray((execution as Record<string, unknown>).required_backend_ids),
    preferred_model_tags: normalizeStringArray((execution as Record<string, unknown>).preferred_model_tags),
    required_model_tags: normalizeStringArray((execution as Record<string, unknown>).required_model_tags),
    isolation_mode: isolationMode,
    task_kind: taskKind,
    quality_preference: qualityPreference,
    selected_backend_id: readString((execution as Record<string, unknown>).selected_backend_id),
    selected_backend_provider: readString((execution as Record<string, unknown>).selected_backend_provider),
    selected_backend_locality:
      readString((execution as Record<string, unknown>).selected_backend_locality) === "local"
        ? "local"
        : readString((execution as Record<string, unknown>).selected_backend_locality) === "remote"
          ? "remote"
          : null,
    selected_host_id: selectedHostId,
    selected_worker_host_id: readString((execution as Record<string, unknown>).selected_worker_host_id),
    routed_bridge_agent_ids: normalizeStringArray((execution as Record<string, unknown>).routed_bridge_agent_ids),
    planned_backend_candidates: Array.isArray((execution as Record<string, unknown>).planned_backend_candidates)
      ? ((execution as Record<string, unknown>).planned_backend_candidates as unknown[])
          .map((entry: unknown) => {
            if (!isRecord(entry)) {
              return null;
            }
            const backendId = readString(entry.backend_id);
            if (!backendId) {
              return null;
            }
            return {
              backend_id: backendId,
              provider: readString(entry.provider),
              host_id: readString(entry.host_id),
              node_id: readString(entry.node_id),
              title: readString(entry.title),
              score: typeof entry.score === "number" && Number.isFinite(entry.score) ? Number(entry.score.toFixed(4)) : null,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      : [],
  };
}

export function rankWorkerFabricSlots(
  slots: WorkerFabricSlot[],
  routing: TaskExecutionRouting,
  strategy: WorkerFabricStateRecord["strategy"],
  defaultHostId: string | null
) {
  return slots
    .filter((slot) => {
      if (routing.allowed_host_ids.length > 0 && !routing.allowed_host_ids.includes(slot.host_id)) {
        return false;
      }
      if (routing.required_host_tags.length > 0) {
        const hostTags = new Set(slot.tags.map((entry) => entry.toLowerCase()));
        if (!routing.required_host_tags.every((tag) => hostTags.has(tag.toLowerCase()))) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) => {
      const leftPreferredHost = routing.preferred_host_ids.includes(left.host_id) ? 1 : 0;
      const rightPreferredHost = routing.preferred_host_ids.includes(right.host_id) ? 1 : 0;
      if (leftPreferredHost !== rightPreferredHost) {
        return rightPreferredHost - leftPreferredHost;
      }
      const leftPreferredTags = routing.preferred_host_tags.filter((tag) =>
        left.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())
      ).length;
      const rightPreferredTags = routing.preferred_host_tags.filter((tag) =>
        right.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())
      ).length;
      if (leftPreferredTags !== rightPreferredTags) {
        return rightPreferredTags - leftPreferredTags;
      }
      if (strategy === "resource_aware") {
        const leftScore = computeHostHealthScore(left.telemetry);
        const rightScore = computeHostHealthScore(right.telemetry);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
      }
      if (strategy === "prefer_local") {
        const leftLocal = left.transport === "local" ? 1 : 0;
        const rightLocal = right.transport === "local" ? 1 : 0;
        if (leftLocal !== rightLocal) {
          return rightLocal - leftLocal;
        }
      }
      if (defaultHostId) {
        const leftDefault = left.host_id === defaultHostId ? 1 : 0;
        const rightDefault = right.host_id === defaultHostId ? 1 : 0;
        if (leftDefault !== rightDefault) {
          return rightDefault - leftDefault;
        }
      }
      if (strategy === "prefer_capacity") {
        const leftCapacity = Number(left.capabilities.gpu_memory_gb ?? left.capabilities.ram_gb ?? 0);
        const rightCapacity = Number(right.capabilities.gpu_memory_gb ?? right.capabilities.ram_gb ?? 0);
        if (leftCapacity !== rightCapacity) {
          return rightCapacity - leftCapacity;
        }
      }
      const leftQueue = left.telemetry.queue_depth;
      const rightQueue = right.telemetry.queue_depth;
      if (leftQueue !== rightQueue) {
        return leftQueue - rightQueue;
      }
      return left.worker_id.localeCompare(right.worker_id);
    });
}

export function workerFabric(storage: Storage, input: z.infer<typeof workerFabricSchema>) {
  if (input.action === "status") {
    const state = resolveEffectiveWorkerFabric(storage, {
      fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
      fallback_worker_count: input.fallback_worker_count ?? 1,
      fallback_shell: input.fallback_shell ?? "/bin/zsh",
    });
    return {
      state,
      slots: buildWorkerFabricSlots(storage, {
        fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
        fallback_worker_count: input.fallback_worker_count ?? 1,
        fallback_shell: input.fallback_shell ?? "/bin/zsh",
      }),
      hosts_summary: state.hosts.map((host) => ({
        ...resolveHostCapacityProfile(host),
        host_id: host.host_id,
        enabled: host.enabled,
        transport: host.transport,
        tags: host.tags,
        telemetry: host.telemetry,
        health_score: computeHostHealthScore(host.telemetry),
      })),
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "worker.fabric",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const existing = storage.getWorkerFabricState() ?? {
        enabled: false,
        strategy: "balanced" as const,
        default_host_id: null,
        hosts: [],
        updated_at: new Date().toISOString(),
      };

      if (input.action === "configure") {
        return {
          state: storage.setWorkerFabricState({
            enabled: input.enabled ?? existing.enabled,
            strategy: input.strategy ?? existing.strategy,
            default_host_id: input.default_host_id ?? existing.default_host_id,
            hosts: existing.hosts,
          }),
        };
      }

      if (input.action === "upsert_host") {
        const host = input.host!;
        const nextHosts = existing.hosts.filter((entry) => entry.host_id !== host.host_id).concat([
          {
            host_id: host.host_id,
            enabled: host.enabled !== false,
            transport: host.transport,
            ssh_destination: host.ssh_destination?.trim() || null,
            workspace_root: host.workspace_root,
            worker_count: host.worker_count,
            shell: host.shell?.trim() || "/bin/zsh",
            capabilities: host.capabilities ?? {},
            tags: host.tags ?? [],
            telemetry: normalizeTelemetry(host.telemetry),
            metadata: host.metadata ?? {},
            updated_at: new Date().toISOString(),
          },
        ]);
        return {
          state: storage.setWorkerFabricState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_host_id: existing.default_host_id ?? host.host_id,
            hosts: nextHosts,
          }),
        };
      }

      if (input.action === "heartbeat") {
        const hostId = input.host_id!.trim();
        const existingHost = existing.hosts.find((entry) => entry.host_id === hostId);
        if (!existingHost) {
          throw new Error(`Unknown worker fabric host: ${hostId}`);
        }
        const nextHosts = existing.hosts.map((entry) =>
          entry.host_id !== hostId
            ? entry
            : {
                ...entry,
                enabled: input.enabled ?? entry.enabled,
                capabilities: input.capabilities && isRecord(input.capabilities)
                  ? { ...entry.capabilities, ...input.capabilities }
                  : entry.capabilities,
                tags: input.tags ? [...new Set([...entry.tags, ...input.tags.map((tag) => tag.trim()).filter(Boolean)])] : entry.tags,
                telemetry: normalizeTelemetry({
                  ...entry.telemetry,
                  ...(input.telemetry ?? {}),
                  heartbeat_at: input.telemetry?.heartbeat_at?.trim() || new Date().toISOString(),
                }),
                updated_at: new Date().toISOString(),
              }
        );
        return {
          state: storage.setWorkerFabricState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_host_id: existing.default_host_id,
            hosts: nextHosts,
          }),
        };
      }

      const nextHosts = existing.hosts.filter((entry) => entry.host_id !== input.host_id);
      return {
        state: storage.setWorkerFabricState({
          enabled: existing.enabled,
          strategy: existing.strategy,
          default_host_id:
            existing.default_host_id === input.host_id ? nextHosts[0]?.host_id ?? null : existing.default_host_id,
          hosts: nextHosts,
        }),
      };
    },
  });
}
