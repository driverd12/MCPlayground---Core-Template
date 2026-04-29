import { isAbsolute, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Storage,
  type WorkerFabricHostRecord,
  type WorkerFabricHostTelemetryRecord,
  type WorkerFabricStateRecord,
} from "../storage.js";
import { captureLocalHostProfileCached, deriveLocalExecutionBudget } from "../local_host_profile.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import type { ExecutionIsolationMode } from "../execution_isolation.js";

const hostTransportSchema = z.enum(["local", "ssh"]);
const thermalPressureSchema = z.enum(["nominal", "fair", "serious", "critical"]);
const LEGACY_LOCAL_WORKSPACE_ROOT_NAMES = ["MCPlayground---Core-Template", "SUPERPOWERS"] as const;

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

const remoteHostPairingSchema = z.object({
  host_id: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  hostname: z.string().min(1).optional(),
  ip_address: z.string().min(1).optional(),
  ssh_user: z.string().min(1).optional(),
  ssh_destination: z.string().min(1).optional(),
  workspace_root: z.string().min(1),
  worker_count: z.number().int().min(1).max(64).optional(),
  shell: z.string().min(1).optional(),
  agent_runtime: z.string().min(1).optional(),
  model_label: z.string().min(1).optional(),
  mac_address: z.string().min(1).optional(),
  device_fingerprint: z.string().min(1).optional(),
  public_key_fingerprint: z.string().min(1).optional(),
  identity_public_key: z.string().min(1).max(4096).optional(),
  permission_profile: z.enum(["read_only", "task_worker", "artifact_writer", "operator"]).optional(),
  allowed_addresses: z.array(z.string().min(1)).optional(),
  capabilities: recordSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
  approve: z.boolean().optional(),
  operator_note: z.string().optional(),
});

export const workerFabricSchema = z
  .object({
    action: z
      .enum([
        "status",
        "configure",
        "upsert_host",
        "heartbeat",
        "remove_host",
        "stage_remote_host",
        "approve_remote_host",
        "reject_remote_host",
      ])
      .default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    strategy: z.enum(["balanced", "prefer_local", "prefer_capacity", "resource_aware"]).optional(),
    default_host_id: z.string().min(1).optional(),
    host_id: z.string().min(1).optional(),
    host: workerFabricHostSchema.optional(),
    telemetry: workerFabricTelemetrySchema.optional(),
    remote_host: remoteHostPairingSchema.optional(),
    capabilities: recordSchema.optional(),
    metadata: recordSchema.optional(),
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
    if (value.action === "stage_remote_host" && !value.remote_host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote_host is required for stage_remote_host",
        path: ["remote_host"],
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
    if ((value.action === "approve_remote_host" || value.action === "reject_remote_host") && !value.host_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host_id is required for remote host approval actions",
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

export type LocalBridgeResourceGate = {
  active: boolean;
  severity: "none" | "moderate" | "high";
  reason: string | null;
  detail: string | null;
  host_id: string | null;
  health_score: number | null;
  metrics: {
    cpu_utilization: number | null;
    ram_available_gb: number | null;
    ram_total_gb: number | null;
    ram_free_ratio: number | null;
    gpu_utilization: number | null;
    gpu_memory_available_gb: number | null;
    gpu_memory_total_gb: number | null;
    gpu_memory_free_ratio: number | null;
    thermal_pressure: WorkerFabricHostTelemetryRecord["thermal_pressure"] | null;
    queue_depth: number;
    active_tasks: number;
  };
  thresholds: {
    cpu_utilization_max: number;
    ram_free_ratio_min: number;
    gpu_memory_free_ratio_min: number;
    local_model_concurrency_max: number | null;
    queue_depth_max: number | null;
  };
  recommendations: {
    suppress_outbound_bridges: boolean;
    pause_visible_sidecars: boolean;
  };
  all_triggers?: Array<{ severity: string; reason: string }>;
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

function resolveLiveRepoWorkspaceRoot(workspaceRoot: string | null | undefined): string | null {
  const candidate = readString(workspaceRoot);
  if (!candidate) {
    return null;
  }
  const normalized = normalize(candidate);
  if (!isAbsolute(normalized)) {
    return normalized;
  }
  const liveRepoRoot = normalize(process.cwd());
  if (normalized === liveRepoRoot || normalized.startsWith(`${liveRepoRoot}${sep}`)) {
    return normalized;
  }
  for (const legacyRepoName of LEGACY_LOCAL_WORKSPACE_ROOT_NAMES) {
    const marker = `${sep}${legacyRepoName}${sep}`;
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
      const suffix = normalized.slice(markerIndex + marker.length);
      return join(liveRepoRoot, suffix);
    }
    if (normalized.endsWith(`${sep}${legacyRepoName}`)) {
      return liveRepoRoot;
    }
  }
  return normalized;
}

export function resolveTransportWorkspaceRoot(
  transport: "local" | "ssh",
  workspaceRoot: string | null | undefined
): string | null {
  const candidate = readString(workspaceRoot);
  if (!candidate) {
    return null;
  }
  if (transport !== "local") {
    return candidate;
  }
  return resolveLiveRepoWorkspaceRoot(candidate) ?? normalize(process.cwd());
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

function slugHostId(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/\.local$/i, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "remote-host"
  ).slice(0, 80);
}

function buildRemoteSshDestination(input: z.infer<typeof remoteHostPairingSchema>) {
  const explicit = readString(input.ssh_destination);
  if (explicit) {
    return explicit;
  }
  const target = readString(input.hostname) ?? readString(input.ip_address);
  if (!target) {
    return null;
  }
  const user = readString(input.ssh_user);
  return user ? `${user}@${target}` : target;
}

function normalizeRemoteAllowedAddresses(input: z.infer<typeof remoteHostPairingSchema>) {
  return mergeUniqueStrings(input.allowed_addresses, [readString(input.ip_address) ?? ""].filter(Boolean));
}

function normalizeRemotePermissionProfile(
  value: unknown
): "read_only" | "task_worker" | "artifact_writer" | "operator" | null {
  const profile = readString(value);
  return profile === "read_only" || profile === "task_worker" || profile === "artifact_writer" || profile === "operator"
    ? profile
    : null;
}

function mergeRemoteAccessMetadata(params: {
  existingMetadata: Record<string, unknown>;
  remoteHost: z.infer<typeof remoteHostPairingSchema>;
  status: "pending" | "approved" | "rejected";
  existingRemoteAccess?: Record<string, unknown> | null;
  sourceAgent?: string;
}) {
  const now = new Date().toISOString();
  const existingRemoteAccess = isRecord(params.existingRemoteAccess)
    ? params.existingRemoteAccess
    : isRecord(params.existingMetadata.remote_access)
      ? params.existingMetadata.remote_access
      : {};
  const allowedAddresses = normalizeRemoteAllowedAddresses(params.remoteHost);
  return {
    ...params.existingMetadata,
    remote_access: {
      ...existingRemoteAccess,
      status: params.status,
      display_name: readString(params.remoteHost.display_name) ?? readString(existingRemoteAccess.display_name),
      hostname: readString(params.remoteHost.hostname) ?? readString(existingRemoteAccess.hostname),
      ip_address: readString(params.remoteHost.ip_address) ?? readString(existingRemoteAccess.ip_address),
      allowed_addresses: allowedAddresses.length
        ? allowedAddresses
        : normalizeStringArray(existingRemoteAccess.allowed_addresses),
      ssh_user: readString(params.remoteHost.ssh_user) ?? readString(existingRemoteAccess.ssh_user),
      agent_runtime: readString(params.remoteHost.agent_runtime) ?? readString(existingRemoteAccess.agent_runtime),
      model_label: readString(params.remoteHost.model_label) ?? readString(existingRemoteAccess.model_label),
      mac_address: readString(params.remoteHost.mac_address) ?? readString(existingRemoteAccess.mac_address),
      device_fingerprint:
        readString(params.remoteHost.device_fingerprint) ?? readString(existingRemoteAccess.device_fingerprint),
      public_key_fingerprint:
        readString(params.remoteHost.public_key_fingerprint) ?? readString(existingRemoteAccess.public_key_fingerprint),
      identity_public_key:
        readString(params.remoteHost.identity_public_key) ?? readString(existingRemoteAccess.identity_public_key),
      permission_profile:
        normalizeRemotePermissionProfile(params.remoteHost.permission_profile) ??
        normalizeRemotePermissionProfile(existingRemoteAccess.permission_profile) ??
        "task_worker",
      pairing_code: readString(existingRemoteAccess.pairing_code) ?? randomUUID().slice(0, 8).toUpperCase(),
      operator_note: readString(params.remoteHost.operator_note) ?? readString(existingRemoteAccess.operator_note),
      staged_at: readString(existingRemoteAccess.staged_at) ?? now,
      approved_at: params.status === "approved" ? now : readString(existingRemoteAccess.approved_at),
      approved_by:
        params.status === "approved"
          ? params.sourceAgent ?? readString(existingRemoteAccess.approved_by) ?? "operator"
          : readString(existingRemoteAccess.approved_by),
      rejected_at: params.status === "rejected" ? now : readString(existingRemoteAccess.rejected_at),
      rejected_by:
        params.status === "rejected"
          ? params.sourceAgent ?? readString(existingRemoteAccess.rejected_by) ?? "operator"
          : readString(existingRemoteAccess.rejected_by),
    },
  };
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
  const workspaceRoot =
    resolveTransportWorkspaceRoot(input.transport, input.workspace_root) ??
    (input.transport === "local" ? normalize(process.cwd()) : input.workspace_root.trim());
  return {
    host_id: input.host_id.trim(),
    enabled: input.enabled !== false,
    transport: input.transport === "ssh" ? "ssh" : "local",
    ssh_destination: input.ssh_destination?.trim() || null,
    workspace_root: workspaceRoot,
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
  const workspaceRoot = resolveTransportWorkspaceRoot("local", input.workspace_root) ?? normalize(process.cwd());
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
        workspace_root: workspaceRoot,
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

  const liveProfile = captureLocalHostProfileCached({
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

function buildEffectiveWorkerFabricWithoutStorage(input: {
  fallback_workspace_root: string;
  fallback_worker_count: number;
  fallback_shell: string;
}) {
  const implicit = buildImplicitLocalWorkerFabric({
    workspace_root: input.fallback_workspace_root,
    worker_count: input.fallback_worker_count,
    shell: input.fallback_shell,
  });
  const effectiveHosts = implicit.hosts.map((host) => overlayEffectiveLocalHost(normalizeHost(host), host.host_id));
  return {
    ...implicit,
    hosts: effectiveHosts,
    default_host_id: effectiveHosts[0]?.host_id ?? implicit.default_host_id,
  } satisfies WorkerFabricStateRecord;
}

export function resolveLocalBridgeResourceGate(input: {
  storage?: Storage | null;
  fallback_workspace_root: string;
  fallback_worker_count: number;
  fallback_shell: string;
}): LocalBridgeResourceGate {
  const state = input.storage
    ? resolveEffectiveWorkerFabric(input.storage, {
        fallback_workspace_root: input.fallback_workspace_root,
        fallback_worker_count: input.fallback_worker_count,
        fallback_shell: input.fallback_shell,
      })
    : buildEffectiveWorkerFabricWithoutStorage({
        fallback_workspace_root: input.fallback_workspace_root,
        fallback_worker_count: input.fallback_worker_count,
        fallback_shell: input.fallback_shell,
      });
  return resolveLocalBridgeResourceGateFromState(state);
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

function buildWorkerFabricStatusPayload(
  storage: Storage,
  input: {
    fallback_workspace_root: string;
    fallback_worker_count: number;
    fallback_shell: string;
  }
) {
  const state = resolveEffectiveWorkerFabric(storage, input);
  const explicitFabric = Boolean(storage.getWorkerFabricState()?.enabled);
  const singleImplicitLocal =
    !explicitFabric && state.hosts.length === 1 && state.hosts[0]?.host_id === "local" && state.hosts[0]?.transport === "local";
  return {
    state,
    slots: state.hosts.flatMap((host) =>
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
    ),
    resource_gate: resolveLocalBridgeResourceGateFromState(state),
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

function resolveLocalBridgeResourceGateFromState(state: WorkerFabricStateRecord): LocalBridgeResourceGate {
  const localHosts = state.hosts.filter((host) => host.enabled !== false && host.transport === "local");
  const localHost = localHosts.find((host) => host.host_id === state.default_host_id) ?? localHosts[0] ?? null;
  if (!localHost) {
    return {
      active: false,
      severity: "none",
      reason: null,
      detail: null,
      host_id: null,
      health_score: null,
      metrics: {
        cpu_utilization: null,
        ram_available_gb: null,
        ram_total_gb: null,
        ram_free_ratio: null,
        gpu_utilization: null,
        gpu_memory_available_gb: null,
        gpu_memory_total_gb: null,
        gpu_memory_free_ratio: null,
        thermal_pressure: null,
        queue_depth: 0,
        active_tasks: 0,
      },
      thresholds: {
        cpu_utilization_max: 0.92,
        ram_free_ratio_min: 0.12,
        gpu_memory_free_ratio_min: 0.12,
        local_model_concurrency_max: null,
        queue_depth_max: null,
      },
      recommendations: {
        suppress_outbound_bridges: false,
        pause_visible_sidecars: false,
      },
    };
  }

  const telemetry = localHost.telemetry;
  const capacity = resolveHostCapacityProfile(localHost);
  const healthScore = computeHostHealthScore(telemetry);
  const ramFreeRatio =
    telemetry.ram_available_gb === null || telemetry.ram_total_gb === null || telemetry.ram_total_gb <= 0
      ? null
      : Math.max(0, Math.min(1, telemetry.ram_available_gb / telemetry.ram_total_gb));
  const gpuMemoryFreeRatio =
    telemetry.gpu_memory_available_gb === null || telemetry.gpu_memory_total_gb === null || telemetry.gpu_memory_total_gb <= 0
      ? null
      : Math.max(0, Math.min(1, telemetry.gpu_memory_available_gb / telemetry.gpu_memory_total_gb));
  const localModelConcurrencyMax =
    capacity.max_local_model_concurrency !== null && Number.isFinite(capacity.max_local_model_concurrency)
      ? Math.max(1, Math.round(capacity.max_local_model_concurrency))
      : capacity.recommended_runtime_worker_max_active !== null && Number.isFinite(capacity.recommended_runtime_worker_max_active)
        ? Math.max(1, Math.round(capacity.recommended_runtime_worker_max_active))
        : null;
  const queueDepthMax =
    capacity.safe_max_queue_per_worker !== null && Number.isFinite(capacity.safe_max_queue_per_worker)
      ? Math.max(1, Math.round(capacity.safe_max_queue_per_worker * localHost.worker_count))
      : capacity.recommended_runtime_worker_limit !== null && Number.isFinite(capacity.recommended_runtime_worker_limit)
        ? Math.max(1, Math.round(capacity.recommended_runtime_worker_limit))
        : null;

  const triggers: Array<{ severity: "moderate" | "high"; reason: string; detail: string }> = [];
  if (telemetry.thermal_pressure === "critical") {
    triggers.push({
      severity: "high",
      reason: "thermal_pressure_critical",
      detail: "Local host thermal pressure is critical; pause sidecars and suppress outbound bridge routing.",
    });
  } else if (telemetry.thermal_pressure === "serious") {
    triggers.push({
      severity: "high",
      reason: "thermal_pressure_serious",
      detail: "Local host thermal pressure is serious; reduce bridge and sidecar load immediately.",
    });
  }
  if (telemetry.cpu_utilization !== null && telemetry.cpu_utilization >= 0.92) {
    triggers.push({
      severity: "high",
      reason: "cpu_saturated",
      detail: "CPU utilization is saturated on the local host; suppress outbound bridges until load drops.",
    });
  }
  if (ramFreeRatio !== null && ramFreeRatio < 0.12) {
    triggers.push({
      severity: "high",
      reason: "ram_pressure",
      detail: "Available RAM is below the safe threshold for concurrent local models plus bridge sidecars.",
    });
  }
  if (gpuMemoryFreeRatio !== null && gpuMemoryFreeRatio < 0.12) {
    triggers.push({
      severity: "high",
      reason: "gpu_memory_pressure",
      detail: "Available GPU memory is below the safe threshold for concurrent local inference and bridge work.",
    });
  }
  if (localModelConcurrencyMax !== null && telemetry.active_tasks >= localModelConcurrencyMax) {
    triggers.push({
      severity: "moderate",
      reason: "local_model_concurrency_saturated",
      detail: "Active local tasks already meet or exceed the safe local-model concurrency budget.",
    });
  }
  if (queueDepthMax !== null && telemetry.queue_depth >= queueDepthMax) {
    triggers.push({
      severity: "moderate",
      reason: "worker_queue_saturated",
      detail: "Worker queue depth already meets or exceeds the safe local queue budget.",
    });
  }
  if (healthScore < 0.45) {
    triggers.push({
      severity: "high",
      reason: "host_health_degraded",
      detail: "The computed local host health score is below the minimum safe threshold for bridge escalation.",
    });
  }

  const primaryTrigger = triggers[0] ?? null;
  const hasHighSeverity = triggers.some((entry) => entry.severity === "high");
  const severity = primaryTrigger
    ? hasHighSeverity
      ? "high"
      : "moderate"
    : "none";
  const active = primaryTrigger !== null;

  return {
    active,
    severity,
    reason: primaryTrigger?.reason ?? null,
    detail: primaryTrigger?.detail ?? null,
    host_id: localHost.host_id,
    health_score: healthScore,
    metrics: {
      cpu_utilization: telemetry.cpu_utilization,
      ram_available_gb: telemetry.ram_available_gb,
      ram_total_gb: telemetry.ram_total_gb,
      ram_free_ratio: ramFreeRatio,
      gpu_utilization: telemetry.gpu_utilization,
      gpu_memory_available_gb: telemetry.gpu_memory_available_gb,
      gpu_memory_total_gb: telemetry.gpu_memory_total_gb,
      gpu_memory_free_ratio: gpuMemoryFreeRatio,
      thermal_pressure: telemetry.thermal_pressure,
      queue_depth: telemetry.queue_depth,
      active_tasks: telemetry.active_tasks,
    },
    thresholds: {
      cpu_utilization_max: 0.92,
      ram_free_ratio_min: 0.12,
      gpu_memory_free_ratio_min: 0.12,
      local_model_concurrency_max: localModelConcurrencyMax,
      queue_depth_max: queueDepthMax,
    },
    recommendations: {
      suppress_outbound_bridges: hasHighSeverity,
      pause_visible_sidecars: active,
    },
    all_triggers: triggers.map((entry) => ({ severity: entry.severity, reason: entry.reason })),
  };
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
    const fallbackWorkspaceRoot = input.fallback_workspace_root ?? process.cwd();
    const fallbackWorkerCount = input.fallback_worker_count ?? 1;
    const fallbackShell = input.fallback_shell ?? "/bin/zsh";
    return buildWorkerFabricStatusPayload(storage, {
      fallback_workspace_root: fallbackWorkspaceRoot,
      fallback_worker_count: fallbackWorkerCount,
      fallback_shell: fallbackShell,
    });
  }

  return runIdempotentMutation({
    storage,
    tool_name: "worker.fabric",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const persisted = storage.getWorkerFabricState();
      const existing = persisted
        ? {
            ...persisted,
            hosts: persisted.hosts.map(normalizeHost),
          }
        : {
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
        const workspaceRoot =
          resolveTransportWorkspaceRoot(host.transport, host.workspace_root) ??
          (host.transport === "local" ? normalize(process.cwd()) : host.workspace_root.trim());
        const nextHosts = existing.hosts.filter((entry) => entry.host_id !== host.host_id).concat([
          {
            host_id: host.host_id,
            enabled: host.enabled !== false,
            transport: host.transport,
            ssh_destination: host.ssh_destination?.trim() || null,
            workspace_root: workspaceRoot,
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

      if (input.action === "stage_remote_host") {
        const remoteHost = input.remote_host!;
        const identitySource =
          readString(remoteHost.host_id) ??
          readString(remoteHost.hostname) ??
          readString(remoteHost.ip_address) ??
          readString(remoteHost.display_name) ??
          "remote-host";
        const hostId = slugHostId(identitySource);
        const existingHost = existing.hosts.find((entry) => entry.host_id === hostId) ?? null;
        const sshDestination = buildRemoteSshDestination(remoteHost);
        if (!sshDestination) {
          throw new Error("remote_host requires hostname, ip_address, or ssh_destination");
        }
        const status = remoteHost.approve === true ? "approved" : "pending";
        const statusTag = status === "approved" ? "approved-host" : "pending-host";
        const staleStatusTags = new Set(status === "approved" ? ["pending-host", "rejected-host"] : ["approved-host", "rejected-host"]);
        const nextMetadata = mergeRemoteAccessMetadata({
          existingMetadata: existingHost?.metadata ?? {},
          remoteHost,
          status,
          sourceAgent: input.source_agent,
        });
        const nextHost: WorkerFabricHostRecord = {
          host_id: hostId,
          enabled: status === "approved",
          transport: "ssh",
          ssh_destination: sshDestination,
          workspace_root: remoteHost.workspace_root,
          worker_count: remoteHost.worker_count ?? existingHost?.worker_count ?? 1,
          shell: remoteHost.shell?.trim() || existingHost?.shell || "/bin/zsh",
          capabilities: {
            ...(existingHost?.capabilities ?? {}),
            ...(remoteHost.capabilities ?? {}),
            remote_control: true,
            approved_remote_host: status === "approved",
          },
          tags: mergeUniqueStrings(
            existingHost?.tags.filter((tag) => !staleStatusTags.has(tag)),
            remoteHost.tags,
            ["remote", statusTag]
          ),
          telemetry: normalizeTelemetry({
            ...(existingHost?.telemetry ?? {}),
            heartbeat_at: existingHost?.telemetry.heartbeat_at ?? new Date().toISOString(),
            health_state: status === "approved" ? existingHost?.telemetry.health_state ?? "degraded" : "degraded",
          }),
          metadata: nextMetadata,
          updated_at: new Date().toISOString(),
        };
        const nextHosts = existing.hosts.filter((entry) => entry.host_id !== hostId).concat([nextHost]);
        return {
          state: storage.setWorkerFabricState({
            enabled: true,
            strategy: existing.strategy,
            default_host_id: existing.default_host_id ?? hostId,
            hosts: nextHosts,
          }),
          host: nextHost,
          pairing: nextMetadata.remote_access,
        };
      }

      if (input.action === "approve_remote_host" || input.action === "reject_remote_host") {
        const hostId = input.host_id!.trim();
        const existingHost = existing.hosts.find((entry) => entry.host_id === hostId);
        if (!existingHost) {
          throw new Error(`Unknown worker fabric host: ${hostId}`);
        }
        const existingRemoteAccess = isRecord(existingHost.metadata.remote_access)
          ? existingHost.metadata.remote_access
          : {};
        const remoteHost = {
          workspace_root: existingHost.workspace_root,
          display_name: readString(existingRemoteAccess.display_name) ?? existingHost.host_id,
          hostname: readString(existingRemoteAccess.hostname) ?? undefined,
          ip_address: readString(existingRemoteAccess.ip_address) ?? undefined,
          ssh_user: readString(existingRemoteAccess.ssh_user) ?? undefined,
          agent_runtime: readString(existingRemoteAccess.agent_runtime) ?? undefined,
          model_label: readString(existingRemoteAccess.model_label) ?? undefined,
          mac_address: readString(existingRemoteAccess.mac_address) ?? undefined,
          identity_public_key: readString(existingRemoteAccess.identity_public_key) ?? undefined,
          allowed_addresses: normalizeStringArray(existingRemoteAccess.allowed_addresses),
          permission_profile: normalizeRemotePermissionProfile(existingRemoteAccess.permission_profile) ?? undefined,
          operator_note: input.remote_host?.operator_note,
        };
        const status = input.action === "approve_remote_host" ? "approved" : "rejected";
        const nextMetadata = mergeRemoteAccessMetadata({
          existingMetadata: existingHost.metadata,
          remoteHost,
          status,
          existingRemoteAccess,
          sourceAgent: input.source_agent,
        });
        const nextHosts = existing.hosts.map((entry) =>
          entry.host_id === hostId
            ? {
                ...entry,
                enabled: status === "approved",
                tags:
                  status === "approved"
                    ? mergeUniqueStrings(entry.tags.filter((tag) => tag !== "pending-host" && tag !== "rejected-host"), [
                        "approved-host",
                        "remote",
                      ])
                    : mergeUniqueStrings(entry.tags.filter((tag) => tag !== "pending-host" && tag !== "approved-host"), [
                        "rejected-host",
                        "remote",
                      ]),
                capabilities: {
                  ...entry.capabilities,
                  approved_remote_host: status === "approved",
                },
                telemetry: normalizeTelemetry({
                  ...entry.telemetry,
                  heartbeat_at: new Date().toISOString(),
                  health_state: status === "approved" ? "degraded" : "offline",
                }),
                metadata: nextMetadata,
                updated_at: new Date().toISOString(),
              }
            : entry
        );
        return {
          state: storage.setWorkerFabricState({
            enabled: true,
            strategy: existing.strategy,
            default_host_id: existing.default_host_id ?? hostId,
            hosts: nextHosts,
          }),
          host: nextHosts.find((entry) => entry.host_id === hostId) ?? null,
          pairing: nextMetadata.remote_access,
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
                metadata: input.metadata && isRecord(input.metadata) ? { ...entry.metadata, ...input.metadata } : entry.metadata,
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
