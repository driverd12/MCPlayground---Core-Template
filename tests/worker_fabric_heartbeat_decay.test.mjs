import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../dist/storage.js";

test("worker fabric health does not keep stale healthy hosts alive without heartbeat proof", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-fabric-heartbeat-"));
  const dbPath = path.join(tempDir, "storage.sqlite");
  const storage = new Storage(dbPath);
  storage.init();
  const nowMs = Date.now();
  const freshHeartbeat = new Date(nowMs - 2 * 60 * 1000).toISOString();
  const staleHeartbeat = new Date(nowMs - 11 * 60 * 1000).toISOString();

  try {
    const written = storage.setWorkerFabricState({
      enabled: true,
      strategy: "balanced",
      default_host_id: "fresh",
      hosts: [
        {
          host_id: "fresh",
          enabled: true,
          transport: "ssh",
          ssh_destination: "worker@fresh",
          workspace_root: "/srv/master-mold",
          worker_count: 1,
          shell: "/bin/zsh",
          capabilities: {},
          tags: ["remote"],
          telemetry: {
            heartbeat_at: freshHeartbeat,
            health_state: "healthy",
            queue_depth: 0,
            active_tasks: 0,
            latency_ms: 40,
            cpu_utilization: 0.2,
            ram_available_gb: 32,
            ram_total_gb: 64,
            swap_used_gb: 0,
            gpu_utilization: null,
            gpu_memory_available_gb: null,
            gpu_memory_total_gb: null,
            disk_free_gb: 200,
            thermal_pressure: "nominal",
          },
          metadata: {},
          updated_at: freshHeartbeat,
        },
        {
          host_id: "stale",
          enabled: true,
          transport: "ssh",
          ssh_destination: "worker@stale",
          workspace_root: "/srv/master-mold",
          worker_count: 1,
          shell: "/bin/zsh",
          capabilities: {},
          tags: ["remote"],
          telemetry: {
            heartbeat_at: staleHeartbeat,
            health_state: "healthy",
            queue_depth: 0,
            active_tasks: 0,
            latency_ms: 40,
            cpu_utilization: 0.2,
            ram_available_gb: 32,
            ram_total_gb: 64,
            swap_used_gb: 0,
            gpu_utilization: null,
            gpu_memory_available_gb: null,
            gpu_memory_total_gb: null,
            disk_free_gb: 200,
            thermal_pressure: "nominal",
          },
          metadata: {},
          updated_at: staleHeartbeat,
        },
        {
          host_id: "missing-heartbeat",
          enabled: true,
          transport: "ssh",
          ssh_destination: "worker@missing",
          workspace_root: "/srv/master-mold",
          worker_count: 1,
          shell: "/bin/zsh",
          capabilities: {},
          tags: ["remote"],
          telemetry: {
            heartbeat_at: null,
            health_state: "healthy",
            queue_depth: 0,
            active_tasks: 0,
            latency_ms: 40,
            cpu_utilization: 0.2,
            ram_available_gb: 32,
            ram_total_gb: 64,
            swap_used_gb: 0,
            gpu_utilization: null,
            gpu_memory_available_gb: null,
            gpu_memory_total_gb: null,
            disk_free_gb: 200,
            thermal_pressure: "nominal",
          },
          metadata: {},
          updated_at: freshHeartbeat,
        },
        {
          host_id: "degraded",
          enabled: true,
          transport: "ssh",
          ssh_destination: "worker@degraded",
          workspace_root: "/srv/master-mold",
          worker_count: 1,
          shell: "/bin/zsh",
          capabilities: {},
          tags: ["remote"],
          telemetry: {
            heartbeat_at: staleHeartbeat,
            health_state: "degraded",
            queue_depth: 0,
            active_tasks: 0,
            latency_ms: 40,
            cpu_utilization: 0.2,
            ram_available_gb: 32,
            ram_total_gb: 64,
            swap_used_gb: 0,
            gpu_utilization: null,
            gpu_memory_available_gb: null,
            gpu_memory_total_gb: null,
            disk_free_gb: 200,
            thermal_pressure: "nominal",
          },
          metadata: {},
          updated_at: staleHeartbeat,
        },
      ],
    });

    assert.equal(written.hosts.find((host) => host.host_id === "fresh")?.telemetry.health_state, "healthy");
    assert.equal(written.hosts.find((host) => host.host_id === "stale")?.telemetry.health_state, "offline");
    assert.equal(written.hosts.find((host) => host.host_id === "missing-heartbeat")?.telemetry.health_state, "offline");
    assert.equal(written.hosts.find((host) => host.host_id === "degraded")?.telemetry.health_state, "degraded");

    const hydrated = storage.getWorkerFabricState();
    assert.ok(hydrated);
    assert.equal(hydrated.hosts.find((host) => host.host_id === "fresh")?.telemetry.health_state, "healthy");
    assert.equal(hydrated.hosts.find((host) => host.host_id === "stale")?.telemetry.health_state, "offline");
    assert.equal(hydrated.hosts.find((host) => host.host_id === "missing-heartbeat")?.telemetry.health_state, "offline");
    assert.equal(hydrated.hosts.find((host) => host.host_id === "degraded")?.telemetry.health_state, "degraded");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
