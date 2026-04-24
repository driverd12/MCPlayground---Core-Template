import os from "node:os";
import { spawnSync } from "node:child_process";
import { probeLocalAccelerator } from "./local_accelerator_probe.js";

export type LocalThermalPressure = "nominal" | "fair" | "serious" | "critical";

export type LocalHostProfile = {
  generated_at: string;
  platform: NodeJS.Platform;
  arch: string;
  cpu_count: number;
  performance_cpu_count: number;
  efficiency_cpu_count: number;
  memory_total_gb: number;
  memory_available_gb: number;
  memory_free_percent: number;
  swap_used_gb: number;
  disk_free_gb: number | null;
  thermal_pressure: LocalThermalPressure;
  cpu_utilization: number;
  health_state: "healthy" | "degraded";
  safe_worker_count: number;
  safe_max_queue_per_worker: number;
  max_local_model_concurrency: number;
  full_gpu_access: boolean;
  accelerator_kind: "apple-metal" | "nvidia-cuda" | "none";
  gpu_vendor: string | null;
  gpu_model: string | null;
  gpu_api: "metal" | "cuda" | null;
  gpu_family: string | null;
  gpu_core_count: number | null;
  gpu_memory_total_gb: number | null;
  gpu_memory_available_gb: number | null;
  gpu_utilization: number | null;
  unified_memory: boolean;
  mlx_python: string | null;
  mlx_available: boolean;
  mlx_lm_available: boolean;
};

export type LocalExecutionBudget = {
  runtime_worker_limit: number;
  runtime_worker_max_active: number;
  tmux_recommended_worker_count: number;
  tmux_min_worker_count: number;
  tmux_target_queue_per_worker: number;
};

type LocalHostProfileCacheEntry = {
  captured_at_ms: number;
  profile: LocalHostProfile;
};

const localHostProfileCache = new Map<string, LocalHostProfileCacheEntry>();

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function localHostProfileCacheTtlMs() {
  const parsed = Number.parseInt(String(process.env.MASTER_MOLD_LOCAL_HOST_PROFILE_CACHE_MS || "5000"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 5000;
  }
  return parsed;
}

function localHostProfileCacheKey(input?: {
  workspace_root?: string;
  degraded_signal?: boolean;
}) {
  return JSON.stringify({
    workspace_root: input?.workspace_root ?? process.cwd(),
    degraded_signal: input?.degraded_signal === true,
  });
}

function readSysctlInt(name: string): number | null {
  const result = spawnSync("sysctl", ["-n", name], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const parsed = Number.parseInt(String(result.stdout || "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readDiskFreeGb(targetDir: string): number | null {
  const result = spawnSync("df", ["-Pk", targetDir], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const lines = String(result.stdout || "")
    .trim()
    .split(/\n+/);
  if (lines.length < 2) {
    return null;
  }
  const columns = lines[1].trim().split(/\s+/);
  const availableKb = Number.parseInt(columns[3] ?? "", 10);
  if (!Number.isFinite(availableKb) || availableKb < 0) {
    return null;
  }
  return Number((availableKb / 1024 / 1024).toFixed(4));
}

function detectThermalPressure(): LocalThermalPressure {
  const result = spawnSync("/bin/sh", ["-lc", "pmset -g therm 2>/dev/null"], { encoding: "utf8" });
  if (result.status !== 0) {
    return "nominal";
  }
  const text = String(result.stdout || "");
  if (/no thermal warning level has been recorded/i.test(text) || /no performance warning level has been recorded/i.test(text)) {
    return "nominal";
  }
  const match = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(text) || /Scheduler_Limit\s*=\s*(\d+)/i.exec(text);
  if (!match) {
    return "nominal";
  }
  const speedLimit = Number.parseInt(match[1], 10);
  if (!Number.isFinite(speedLimit)) {
    return "nominal";
  }
  if (speedLimit >= 100) return "nominal";
  if (speedLimit >= 80) return "fair";
  if (speedLimit >= 50) return "serious";
  return "critical";
}

function detectMemoryFreePercent(fallbackPercent: number) {
  const result = spawnSync("memory_pressure", ["-Q"], { encoding: "utf8" });
  if (result.status !== 0) {
    return Number(fallbackPercent.toFixed(2));
  }
  const text = String(result.stdout || "");
  const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(text);
  if (!match) {
    return Number(fallbackPercent.toFixed(2));
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : Number(fallbackPercent.toFixed(2));
}

function detectCpuUtilization(cpuCount: number) {
  const result = spawnSync("/bin/sh", ["-lc", "top -l 1 -n 0 2>/dev/null | head -n 5"], { encoding: "utf8" });
  if (result.status === 0) {
    const text = String(result.stdout || "");
    const idleMatch = /CPU usage:\s*[\d.]+%\s*user,\s*[\d.]+%\s*sys,\s*([\d.]+)%\s*idle/i.exec(text);
    if (idleMatch) {
      const idlePercent = Number.parseFloat(idleMatch[1]);
      if (Number.isFinite(idlePercent)) {
        return Number(clamp(1 - idlePercent / 100, 0, 1).toFixed(4));
      }
    }
  }
  return cpuCount > 0 ? Number(clamp((os.loadavg()[0] || 0) / cpuCount, 0, 1).toFixed(4)) : 0;
}

function detectSwapUsedGb() {
  const result = spawnSync("sysctl", ["vm.swapusage"], { encoding: "utf8" });
  if (result.status !== 0) {
    return 0;
  }
  const text = String(result.stdout || "");
  const match = /used\s*=\s*([\d.]+)\s*([KMGTP])?/i.exec(text);
  if (!match) {
    return 0;
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  const unit = String(match[2] || "M").toUpperCase();
  const multiplier =
    unit === "K" ? 1 / (1024 * 1024) : unit === "G" ? 1 : unit === "T" ? 1024 : unit === "P" ? 1024 * 1024 : 1 / 1024;
  return Number((value * multiplier).toFixed(4));
}

function hasRetainedSwapHeadroom(input: {
  memory_available_gb: number;
  memory_free_percent: number;
  cpu_utilization: number;
}) {
  return input.memory_available_gb >= 24 && input.memory_free_percent >= 35 && input.cpu_utilization < 0.9;
}

export function resolveLocalHostHealthState(input: {
  thermal_pressure: LocalThermalPressure;
  memory_available_gb: number;
  memory_free_percent: number;
  swap_used_gb: number;
  cpu_utilization: number;
  degraded_signal?: boolean;
}) {
  if (input.degraded_signal) {
    return "degraded" as const;
  }
  const retainedSwapPressure = input.swap_used_gb >= 4 && !hasRetainedSwapHeadroom(input);
  if (
    input.thermal_pressure === "critical" ||
    input.memory_available_gb < 4 ||
    input.memory_free_percent < 10 ||
    input.swap_used_gb >= 8
  ) {
    return "degraded" as const;
  }
  if (
    input.thermal_pressure === "serious" ||
    input.memory_available_gb < 8 ||
    input.memory_free_percent < 18 ||
    retainedSwapPressure
  ) {
    return "degraded" as const;
  }
  if (
    input.cpu_utilization > 0.985 &&
    (
      input.thermal_pressure !== "nominal" ||
      input.memory_available_gb < 12 ||
      input.memory_free_percent < 25 ||
      (input.swap_used_gb >= 2 && !hasRetainedSwapHeadroom(input))
    )
  ) {
    return "degraded" as const;
  }
  return "healthy" as const;
}

export function isLocalHostSafeForAutonomyEval(
  profile: Pick<
    LocalHostProfile,
    "health_state" | "thermal_pressure" | "memory_available_gb" | "memory_free_percent" | "swap_used_gb" | "cpu_utilization"
  >
) {
  if (profile.health_state !== "healthy") {
    return false;
  }
  if (profile.thermal_pressure === "serious" || profile.thermal_pressure === "critical") {
    return false;
  }
  if (profile.memory_available_gb < 12 || profile.memory_free_percent < 18) {
    return false;
  }
  if (profile.swap_used_gb >= 8) {
    return false;
  }
  if (profile.swap_used_gb >= 4 && !hasRetainedSwapHeadroom(profile)) {
    return false;
  }
  return true;
}

function recommendSafeWorkerCount(input: {
  performance_cpu_count: number;
  cpu_count: number;
  memory_available_gb: number;
  memory_free_percent: number;
  thermal_pressure: LocalThermalPressure;
  cpu_utilization: number;
  swap_used_gb: number;
}) {
  const cpuBase =
    input.performance_cpu_count > 0
      ? Math.max(2, input.performance_cpu_count - 3)
      : Math.max(2, Math.floor(input.cpu_count * 0.6));
  let safeCap = Math.min(16, cpuBase);

  if (
    input.memory_available_gb >= 24 &&
    input.memory_free_percent >= 45 &&
    input.swap_used_gb < 1 &&
    input.thermal_pressure === "nominal" &&
    input.cpu_utilization < 0.75
  ) {
    safeCap = Math.min(16, cpuBase + 2);
  }

  if (input.memory_available_gb < 8 || input.memory_free_percent < 12 || input.swap_used_gb >= 8) {
    safeCap = Math.min(safeCap, 2);
  } else if (input.memory_available_gb < 12 || input.memory_free_percent < 18 || input.swap_used_gb >= 4) {
    safeCap = Math.min(safeCap, 4);
  } else if (input.memory_available_gb < 16 || input.memory_free_percent < 25) {
    safeCap = Math.min(safeCap, 6);
  } else if (input.memory_available_gb < 20 || input.memory_free_percent < 35) {
    safeCap = Math.min(safeCap, 8);
  }

  if (input.cpu_utilization > 0.95) {
    safeCap = Math.min(
      safeCap,
      input.memory_available_gb >= 16 && input.memory_free_percent >= 25 && input.swap_used_gb < 2
        ? Math.max(4, cpuBase - 2)
        : Math.max(2, Math.floor(cpuBase / 2))
    );
  } else if (input.cpu_utilization > 0.85) {
    safeCap = Math.min(safeCap, Math.max(3, cpuBase - 2));
  }

  if (input.thermal_pressure === "fair") safeCap = Math.min(safeCap, Math.max(4, cpuBase - 2));
  if (input.thermal_pressure === "serious") safeCap = Math.min(safeCap, 3);
  if (input.thermal_pressure === "critical") safeCap = 1;

  return clamp(safeCap, 1, 12);
}

function recommendSafeQueuePerWorker(input: {
  thermal_pressure: LocalThermalPressure;
  memory_free_percent: number;
}) {
  if (input.thermal_pressure === "critical" || input.memory_free_percent < 12) {
    return 2;
  }
  if (input.thermal_pressure === "serious" || input.memory_free_percent < 20) {
    return 3;
  }
  if (input.thermal_pressure === "fair" || input.memory_free_percent < 30) {
    return 4;
  }
  return 6;
}

function recommendLocalModelConcurrency(input: {
  memory_available_gb: number;
  memory_free_percent: number;
  thermal_pressure: LocalThermalPressure;
  swap_used_gb: number;
}) {
  if (
    input.thermal_pressure === "critical" ||
    input.memory_free_percent < 12 ||
    input.memory_available_gb < 8 ||
    input.swap_used_gb >= 8
  ) {
    return 1;
  }
  if (
    input.thermal_pressure === "serious" ||
    input.memory_free_percent < 18 ||
    input.memory_available_gb < 14 ||
    input.swap_used_gb >= 4
  ) {
    return 1;
  }
  if (
    input.thermal_pressure === "nominal" &&
    input.memory_free_percent >= 60 &&
    input.memory_available_gb >= 28 &&
    input.swap_used_gb < 1
  ) {
    return 4;
  }
  if (
    input.thermal_pressure === "nominal" &&
    input.memory_free_percent >= 45 &&
    input.memory_available_gb >= 24 &&
    input.swap_used_gb < 1
  ) {
    return 3;
  }
  if (
    input.thermal_pressure === "nominal" &&
    input.memory_free_percent >= 30 &&
    input.memory_available_gb >= 18 &&
    input.swap_used_gb < 2
  ) {
    return 2;
  }
  return 1;
}

export function deriveLocalExecutionBudget(
  profile: LocalHostProfile,
  input?: {
    pending_tasks?: number;
    tmux_queue_depth?: number;
    fabric_queue_depth?: number;
    active_runtime_workers?: number;
  }
): LocalExecutionBudget {
  const pendingTasks = Math.max(0, Math.round(input?.pending_tasks ?? 0));
  const tmuxQueueDepth = Math.max(0, Math.round(input?.tmux_queue_depth ?? 0));
  const fabricQueueDepth = Math.max(0, Math.round(input?.fabric_queue_depth ?? 0));
  const activeRuntimeWorkers = Math.max(0, Math.round(input?.active_runtime_workers ?? 0));
  const queuePressure = Math.max(pendingTasks, tmuxQueueDepth, fabricQueueDepth);
  const healthyHeadroom =
    profile.health_state === "healthy" &&
    profile.thermal_pressure === "nominal" &&
    profile.memory_available_gb >= 18 &&
    profile.memory_free_percent >= 30 &&
    profile.swap_used_gb < 2;
  const aggressiveHeadroom =
    healthyHeadroom &&
    profile.memory_available_gb >= 28 &&
    profile.memory_free_percent >= 55 &&
    profile.swap_used_gb < 1 &&
    profile.cpu_utilization < 0.8;

  let runtimeWorkerMaxActive = 1;
  if (aggressiveHeadroom) {
    runtimeWorkerMaxActive = Math.min(6, Math.max(4, Math.ceil(profile.safe_worker_count / 2)));
  } else if (healthyHeadroom) {
    runtimeWorkerMaxActive = Math.min(4, Math.max(2, Math.ceil(profile.safe_worker_count / 3)));
  } else if (
    profile.health_state === "healthy" &&
    profile.thermal_pressure !== "critical" &&
    profile.memory_available_gb >= 12 &&
    profile.memory_free_percent >= 20 &&
    profile.swap_used_gb < 4
  ) {
    runtimeWorkerMaxActive = 2;
  }
  if (queuePressure <= 0) {
    runtimeWorkerMaxActive = Math.max(1, Math.min(runtimeWorkerMaxActive, activeRuntimeWorkers || 1));
  }
  const runtimeWorkerLimit = Math.max(1, Math.min(8, Math.min(runtimeWorkerMaxActive, pendingTasks || 1)));

  const tmuxTargetQueuePerWorker = aggressiveHeadroom ? 2 : healthyHeadroom ? 3 : Math.max(1, Math.min(4, profile.safe_max_queue_per_worker));
  const tmuxMinWorkerCount =
    queuePressure <= 0
      ? 1
      : aggressiveHeadroom
        ? Math.min(4, Math.max(2, Math.ceil(profile.safe_worker_count / 3)))
        : healthyHeadroom
          ? 2
          : 1;
  const tmuxMaxWorkers = Math.max(1, Math.min(12, profile.safe_worker_count));
  const tmuxRecommendedWorkerCount =
    queuePressure <= 0
      ? 1
      : Math.max(
          tmuxMinWorkerCount,
          Math.min(tmuxMaxWorkers, Math.ceil(Math.max(1, queuePressure) / tmuxTargetQueuePerWorker))
        );

  return {
    runtime_worker_limit: runtimeWorkerLimit,
    runtime_worker_max_active: Math.max(1, Math.min(8, runtimeWorkerMaxActive)),
    tmux_recommended_worker_count: Math.max(1, Math.min(12, tmuxRecommendedWorkerCount)),
    tmux_min_worker_count: Math.max(1, Math.min(12, tmuxMinWorkerCount)),
    tmux_target_queue_per_worker: Math.max(1, Math.min(12, tmuxTargetQueuePerWorker)),
  };
}

export function captureLocalHostProfile(input?: {
  workspace_root?: string;
  degraded_signal?: boolean;
}): LocalHostProfile {
  const cpuCount = os.cpus().length;
  const performanceCpuCount = readSysctlInt("hw.perflevel0.physicalcpu") ?? Math.max(1, Math.floor(cpuCount * 0.75));
  const efficiencyCpuCount = readSysctlInt("hw.perflevel1.physicalcpu") ?? Math.max(0, cpuCount - performanceCpuCount);
  const memoryTotalGb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(4));
  const freeMemGb = Number((os.freemem() / 1024 / 1024 / 1024).toFixed(4));
  const fallbackFreePercent = memoryTotalGb > 0 ? (freeMemGb / memoryTotalGb) * 100 : 0;
  const memoryFreePercent = detectMemoryFreePercent(fallbackFreePercent);
  const pressureAvailableGb =
    memoryTotalGb > 0 ? Number(((memoryTotalGb * Math.max(0, Math.min(100, memoryFreePercent))) / 100).toFixed(4)) : 0;
  const memoryAvailableGb = Number(Math.max(freeMemGb, pressureAvailableGb).toFixed(4));
  const swapUsedGb = detectSwapUsedGb();
  const thermalPressure = detectThermalPressure();
  const cpuUtilization = detectCpuUtilization(cpuCount);
  const diskFreeGb = readDiskFreeGb(input?.workspace_root ?? process.cwd());
  const accelerator = probeLocalAccelerator({
    memory_total_gb: memoryTotalGb,
    memory_available_gb: memoryAvailableGb,
    workspace_root: input?.workspace_root ?? null,
  });
  const healthState = resolveLocalHostHealthState({
    thermal_pressure: thermalPressure,
    memory_available_gb: memoryAvailableGb,
    memory_free_percent: memoryFreePercent,
    swap_used_gb: swapUsedGb,
    cpu_utilization: cpuUtilization,
    degraded_signal: input?.degraded_signal,
  });

  return {
    generated_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cpu_count: cpuCount,
    performance_cpu_count: performanceCpuCount,
    efficiency_cpu_count: efficiencyCpuCount,
    memory_total_gb: memoryTotalGb,
    memory_available_gb: memoryAvailableGb,
    memory_free_percent: memoryFreePercent,
    swap_used_gb: swapUsedGb,
    disk_free_gb: diskFreeGb,
    thermal_pressure: thermalPressure,
    cpu_utilization: cpuUtilization,
    health_state: healthState,
    safe_worker_count: recommendSafeWorkerCount({
      performance_cpu_count: performanceCpuCount,
      cpu_count: cpuCount,
      memory_available_gb: memoryAvailableGb,
      memory_free_percent: memoryFreePercent,
      thermal_pressure: thermalPressure,
      cpu_utilization: cpuUtilization,
      swap_used_gb: swapUsedGb,
    }),
    safe_max_queue_per_worker: recommendSafeQueuePerWorker({
      thermal_pressure: thermalPressure,
      memory_free_percent: memoryFreePercent,
    }),
    max_local_model_concurrency: recommendLocalModelConcurrency({
      memory_available_gb: memoryAvailableGb,
      memory_free_percent: memoryFreePercent,
      thermal_pressure: thermalPressure,
      swap_used_gb: swapUsedGb,
    }),
    full_gpu_access: accelerator.accelerator_kind !== "none",
    accelerator_kind: accelerator.accelerator_kind,
    gpu_vendor: accelerator.vendor,
    gpu_model: accelerator.model,
    gpu_api: accelerator.api,
    gpu_family: accelerator.family,
    gpu_core_count: accelerator.gpu_core_count,
    gpu_memory_total_gb: accelerator.gpu_memory_total_gb,
    gpu_memory_available_gb: accelerator.gpu_memory_available_gb,
    gpu_utilization: accelerator.gpu_utilization,
    unified_memory: accelerator.unified_memory,
    mlx_python: accelerator.mlx_python,
    mlx_available: accelerator.mlx_available,
    mlx_lm_available: accelerator.mlx_lm_available,
  };
}

export function resetLocalHostProfileCache() {
  localHostProfileCache.clear();
}

export function captureLocalHostProfileCached(
  input?: {
    workspace_root?: string;
    degraded_signal?: boolean;
  },
  deps?: {
    now?: () => number;
    capture?: (input?: { workspace_root?: string; degraded_signal?: boolean }) => LocalHostProfile;
  }
): LocalHostProfile {
  const ttlMs = localHostProfileCacheTtlMs();
  if (ttlMs <= 0) {
    return (deps?.capture ?? captureLocalHostProfile)(input);
  }
  const now = deps?.now ? deps.now() : Date.now();
  const cacheKey = localHostProfileCacheKey(input);
  const cached = localHostProfileCache.get(cacheKey);
  if (cached && now - cached.captured_at_ms <= ttlMs) {
    return cached.profile;
  }
  const profile = (deps?.capture ?? captureLocalHostProfile)(input);
  localHostProfileCache.set(cacheKey, {
    captured_at_ms: now,
    profile,
  });
  return profile;
}
