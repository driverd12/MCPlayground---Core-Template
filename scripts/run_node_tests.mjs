#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const groups = [
  [
    "./tests/auto_squish.persistence.test.mjs",
    "./tests/core_template.integration.test.mjs",
    "./tests/golden_case_capture.integration.test.mjs",
    "./tests/memory_reflection_capture.integration.test.mjs",
    "./tests/control_plane.integration.test.mjs",
    "./tests/desktop_control.integration.test.mjs",
    "./tests/storage_guard.persistence.test.mjs",
    "./tests/agentic_pack.integration.test.mjs",
    "./tests/trichat_auto_retention.persistence.test.mjs",
    "./tests/trichat_autopilot.persistence.test.mjs",
    "./tests/trichat_autopilot.snappiness.test.mjs",
    "./tests/trichat_autopilot.tmux_backend.test.mjs",
    "./tests/trichat_bus.unixsocket.test.mjs",
    "./tests/trichat_tmux_controller.test.mjs",
    "./tests/worker_fabric_and_benchmark.test.mjs",
    "./tests/cluster_topology.integration.test.mjs",
    "./tests/local_backend_probe.test.mjs",
    "./tests/local_mlx_backend_probe.test.mjs",
    "./tests/reaction_engine.test.mjs",
  ],
  ["./tests/next_wave_runtime.integration.test.mjs"],
  ["./tests/observability.integration.test.mjs"],
  ["./tests/autonomy_bootstrap.integration.test.mjs"],
  [
    "./tests/autonomy_command.integration.test.mjs",
    "./tests/autonomy_maintain.integration.test.mjs",
    "./tests/specialist_catalog.integration.test.mjs",
    "./tests/autonomy_ide_ingress.integration.test.mjs",
    "./tests/autonomy_shell_wrappers.integration.test.mjs",
    "./tests/autonomy_ingress_shell_wrapper.integration.test.mjs",
    "./tests/autonomy_http_startup.integration.test.mjs",
    "./tests/http_transport_ready_cache.test.mjs",
    "./tests/mcp_http_runner.integration.test.mjs",
    "./tests/provider_bridge.integration.test.mjs",
    "./tests/litellm_proxy_infrastructure.test.mjs",
    "./tests/agent_office_gui_server.integration.test.mjs",
    "./tests/office_snapshot.integration.test.mjs",
    "./tests/benchmark_autoagent.test.mjs",
    "./tests/bootstrap_smoke.test.mjs",
    "./tests/preinstall_check.test.mjs",
    "./tests/mcp_runner_support.test.mjs",
    "./tests/ollama_mlx_postpull.test.mjs",
    "./tests/macos_authority_audit.test.mjs",
    "./tests/local_adapter_lane.test.mjs",
    "./tests/local_adapter_train.test.mjs",
    "./tests/local_adapter_eval.test.mjs",
    "./tests/local_adapter_promote.test.mjs",
    "./tests/local_adapter_integrate.test.mjs",
    "./tests/local_adapter_cutover.test.mjs",
    "./tests/local_adapter_soak.test.mjs",
    "./tests/local_adapter_watchdog.test.mjs",
  ],
];

for (let index = 0; index < groups.length; index += 1) {
  const files = groups[index];
  console.error(`[node-tests] group ${index + 1}/${groups.length}: ${files.length} file(s)`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (result.signal) {
    console.error(`[node-tests] group ${index + 1} terminated by ${result.signal}`);
    process.exit(1);
  }
}
