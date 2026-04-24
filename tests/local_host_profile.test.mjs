import assert from "node:assert/strict";
import test from "node:test";
import {
  captureLocalHostProfile,
  captureLocalHostProfileCached,
  deriveLocalExecutionBudget,
  isLocalHostSafeForAutonomyEval,
  resetLocalHostProfileCache,
  resolveLocalHostHealthState,
} from "../dist/local_host_profile.js";

test("captureLocalHostProfile returns bounded real local recommendations", () => {
  const profile = captureLocalHostProfile();
  assert.ok(profile.cpu_count >= 1);
  assert.ok(profile.performance_cpu_count >= 1);
  assert.ok(profile.efficiency_cpu_count >= 0);
  assert.ok(profile.memory_total_gb >= 1);
  assert.ok(profile.memory_available_gb >= 0);
  assert.ok(profile.memory_free_percent >= 0 && profile.memory_free_percent <= 100);
  assert.ok(profile.swap_used_gb >= 0);
  assert.ok(["nominal", "fair", "serious", "critical"].includes(profile.thermal_pressure));
  assert.ok(["healthy", "degraded"].includes(profile.health_state));
  assert.ok(profile.safe_worker_count >= 1 && profile.safe_worker_count <= 12);
  assert.ok(profile.safe_max_queue_per_worker >= 1 && profile.safe_max_queue_per_worker <= 6);
  assert.ok(profile.max_local_model_concurrency >= 1 && profile.max_local_model_concurrency <= 4);
  assert.ok(["apple-metal", "nvidia-cuda", "none"].includes(profile.accelerator_kind));
  assert.ok(["metal", "cuda", null].includes(profile.gpu_api));
  assert.equal(typeof profile.mlx_available, "boolean");
  assert.equal(typeof profile.mlx_lm_available, "boolean");

  const budget = deriveLocalExecutionBudget(profile, {
    pending_tasks: 6,
    tmux_queue_depth: 4,
    fabric_queue_depth: 2,
    active_runtime_workers: 1,
  });
  assert.ok(budget.runtime_worker_limit >= 1 && budget.runtime_worker_limit <= 8);
  assert.ok(budget.runtime_worker_max_active >= 1 && budget.runtime_worker_max_active <= 8);
  assert.ok(budget.tmux_recommended_worker_count >= 1 && budget.tmux_recommended_worker_count <= 12);
  assert.ok(budget.tmux_min_worker_count >= 1 && budget.tmux_min_worker_count <= 12);
  assert.ok(budget.tmux_target_queue_per_worker >= 1 && budget.tmux_target_queue_per_worker <= 12);
});

test("captureLocalHostProfileCached reuses a recent profile per workspace and refreshes after ttl", () => {
  resetLocalHostProfileCache();
  let captureCalls = 0;
  const capture = () => {
    captureCalls += 1;
    return {
      generated_at: new Date(1710000000000 + captureCalls * 1000).toISOString(),
      platform: "darwin",
      arch: "arm64",
      cpu_count: 16,
      performance_cpu_count: 12,
      efficiency_cpu_count: 4,
      memory_total_gb: 48,
      memory_available_gb: 32,
      memory_free_percent: 66,
      swap_used_gb: 0.4,
      disk_free_gb: 200,
      thermal_pressure: "nominal",
      cpu_utilization: 0.33,
      health_state: "healthy",
      safe_worker_count: 8,
      safe_max_queue_per_worker: 6,
      max_local_model_concurrency: 3,
      full_gpu_access: true,
      accelerator_kind: "apple-metal",
      gpu_vendor: "Apple",
      gpu_model: "Apple M4 Max",
      gpu_api: "metal",
      gpu_family: "spdisplays_metal4",
      gpu_core_count: 40,
      gpu_memory_total_gb: 48,
      gpu_memory_available_gb: 32,
      gpu_utilization: null,
      unified_memory: true,
      mlx_python: "/opt/homebrew/bin/python3",
      mlx_available: true,
      mlx_lm_available: true,
    };
  };

  const first = captureLocalHostProfileCached(
    { workspace_root: "/tmp/work-a" },
    { now: () => 1_000, capture }
  );
  const second = captureLocalHostProfileCached(
    { workspace_root: "/tmp/work-a" },
    { now: () => 5_000, capture }
  );
  const third = captureLocalHostProfileCached(
    { workspace_root: "/tmp/work-a" },
    { now: () => 7_000, capture }
  );
  const otherWorkspace = captureLocalHostProfileCached(
    { workspace_root: "/tmp/work-b" },
    { now: () => 7_500, capture }
  );

  assert.equal(captureCalls, 3);
  assert.equal(first.generated_at, second.generated_at);
  assert.notEqual(second.generated_at, third.generated_at);
  assert.notEqual(third.generated_at, otherWorkspace.generated_at);
});

test("deriveLocalExecutionBudget pushes harder only when healthy headroom exists", () => {
  const constrained = deriveLocalExecutionBudget(
    {
      generated_at: new Date().toISOString(),
      platform: "darwin",
      arch: "arm64",
      cpu_count: 16,
      performance_cpu_count: 12,
      efficiency_cpu_count: 4,
      memory_total_gb: 48,
      memory_available_gb: 10,
      memory_free_percent: 18,
      swap_used_gb: 3,
      disk_free_gb: 200,
      thermal_pressure: "fair",
      cpu_utilization: 0.88,
      health_state: "healthy",
      safe_worker_count: 4,
      safe_max_queue_per_worker: 3,
      max_local_model_concurrency: 1,
      full_gpu_access: true,
      accelerator_kind: "apple-metal",
      gpu_vendor: "Apple",
      gpu_model: "Apple M4 Max",
      gpu_api: "metal",
      gpu_family: "spdisplays_metal4",
      gpu_core_count: 40,
      gpu_memory_total_gb: 48,
      gpu_memory_available_gb: 10,
      gpu_utilization: null,
      unified_memory: true,
      mlx_python: "/opt/homebrew/bin/python3",
      mlx_available: false,
      mlx_lm_available: false,
    },
    { pending_tasks: 8, tmux_queue_depth: 4 }
  );
  const aggressive = deriveLocalExecutionBudget(
    {
      generated_at: new Date().toISOString(),
      platform: "darwin",
      arch: "arm64",
      cpu_count: 16,
      performance_cpu_count: 12,
      efficiency_cpu_count: 4,
      memory_total_gb: 48,
      memory_available_gb: 34,
      memory_free_percent: 72,
      swap_used_gb: 0.2,
      disk_free_gb: 200,
      thermal_pressure: "nominal",
      cpu_utilization: 0.42,
      health_state: "healthy",
      safe_worker_count: 9,
      safe_max_queue_per_worker: 6,
      max_local_model_concurrency: 4,
      full_gpu_access: true,
      accelerator_kind: "apple-metal",
      gpu_vendor: "Apple",
      gpu_model: "Apple M4 Max",
      gpu_api: "metal",
      gpu_family: "spdisplays_metal4",
      gpu_core_count: 40,
      gpu_memory_total_gb: 48,
      gpu_memory_available_gb: 34,
      gpu_utilization: null,
      unified_memory: true,
      mlx_python: "/opt/homebrew/bin/python3",
      mlx_available: true,
      mlx_lm_available: true,
    },
    { pending_tasks: 8, tmux_queue_depth: 4 }
  );

  assert.ok(aggressive.runtime_worker_max_active > constrained.runtime_worker_max_active);
  assert.ok(aggressive.tmux_recommended_worker_count >= constrained.tmux_recommended_worker_count);
  assert.ok(aggressive.tmux_target_queue_per_worker <= constrained.tmux_target_queue_per_worker);
});

test("retained swap alone does not degrade a high-headroom local host or block autonomy eval", () => {
  const healthState = resolveLocalHostHealthState({
    thermal_pressure: "nominal",
    memory_available_gb: 38,
    memory_free_percent: 79,
    swap_used_gb: 4.4,
    cpu_utilization: 0.36,
  });
  assert.equal(healthState, "healthy");
  assert.equal(
    isLocalHostSafeForAutonomyEval({
      generated_at: new Date().toISOString(),
      platform: "darwin",
      arch: "arm64",
      cpu_count: 16,
      performance_cpu_count: 12,
      efficiency_cpu_count: 4,
      memory_total_gb: 48,
      memory_available_gb: 38,
      memory_free_percent: 79,
      swap_used_gb: 4.4,
      disk_free_gb: 200,
      thermal_pressure: "nominal",
      cpu_utilization: 0.36,
      health_state: healthState,
      safe_worker_count: 8,
      safe_max_queue_per_worker: 6,
      max_local_model_concurrency: 2,
      full_gpu_access: true,
      accelerator_kind: "apple-metal",
      gpu_vendor: "Apple",
      gpu_model: "Apple M4 Max",
      gpu_api: "metal",
      gpu_family: "spdisplays_metal4",
      gpu_core_count: 40,
      gpu_memory_total_gb: 48,
      gpu_memory_available_gb: 38,
      gpu_utilization: null,
      unified_memory: true,
      mlx_python: "/opt/homebrew/bin/python3",
      mlx_available: true,
      mlx_lm_available: true,
    }),
    true
  );
});

test("retained swap still degrades low-headroom hosts and keeps autonomy eval deferred", () => {
  const healthState = resolveLocalHostHealthState({
    thermal_pressure: "nominal",
    memory_available_gb: 14,
    memory_free_percent: 22,
    swap_used_gb: 4.4,
    cpu_utilization: 0.41,
  });
  assert.equal(healthState, "degraded");
  assert.equal(
    isLocalHostSafeForAutonomyEval({
      generated_at: new Date().toISOString(),
      platform: "darwin",
      arch: "arm64",
      cpu_count: 16,
      performance_cpu_count: 12,
      efficiency_cpu_count: 4,
      memory_total_gb: 48,
      memory_available_gb: 14,
      memory_free_percent: 22,
      swap_used_gb: 4.4,
      disk_free_gb: 200,
      thermal_pressure: "nominal",
      cpu_utilization: 0.41,
      health_state: healthState,
      safe_worker_count: 4,
      safe_max_queue_per_worker: 3,
      max_local_model_concurrency: 1,
      full_gpu_access: true,
      accelerator_kind: "apple-metal",
      gpu_vendor: "Apple",
      gpu_model: "Apple M4 Max",
      gpu_api: "metal",
      gpu_family: "spdisplays_metal4",
      gpu_core_count: 40,
      gpu_memory_total_gb: 48,
      gpu_memory_available_gb: 14,
      gpu_utilization: null,
      unified_memory: true,
      mlx_python: "/opt/homebrew/bin/python3",
      mlx_available: false,
      mlx_lm_available: false,
    }),
    false
  );
});
