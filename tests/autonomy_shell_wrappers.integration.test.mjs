import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fetchHttpResponse, reservePort, stopChildProcess } from "./test_process_helpers.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

test("provider bridge wrapper gives bootstrap guidance before Node dependency import errors", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-wrapper-cold-"));
  try {
    const missingNodeModulesProbe = path.join(tempDir, "node_modules", "@modelcontextprotocol", "sdk");
    const error = await rejectsExecFile("./scripts/provider_bridge.sh", ["status"], {
      MCP_BOOTSTRAP_PREFLIGHT_NODE_MODULES_DIR: missingNodeModulesProbe,
      MCP_HTTP_BEARER_TOKEN: "",
      TRICHAT_MCP_TRANSPORT: "",
    });

    assert.match(error.stderr, /\[provider_bridge\] Stop: Node MCP client dependencies are not installed\./);
    assert.match(error.stderr, /npm run bootstrap:env/);
    assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy wrapper gives bootstrap guidance before missing dist stdio failures", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-wrapper-cold-"));
  try {
    const missingDistProbe = path.join(tempDir, "dist", "server.js");
    const error = await rejectsExecFile("./scripts/autonomy_ctl.sh", ["status"], {
      MCP_BOOTSTRAP_PREFLIGHT_DIST_SERVER: missingDistProbe,
      MCP_HTTP_BEARER_TOKEN: "",
      TRICHAT_MCP_URL: "http://127.0.0.1:9/",
      TRICHAT_MCP_TRANSPORT: "",
      TRICHAT_RING_LEADER_TRANSPORT: "",
    });

    assert.match(error.stderr, /\[autonomy_ctl\] Stop: compiled MCP server output is missing\./);
    assert.match(error.stderr, /STDIO transport needs dist\/server\.js/);
    assert.match(error.stderr, /npm run bootstrap:env/);
    assert.doesNotMatch(error.stderr, /Cannot find module|ENOENT.*dist\/server\.js/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy shell wrapper ensure converges the control plane through the real script entrypoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-shell-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_PROVIDER_BRIDGE_ROUTER_ENABLED: "0",
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_READY_TIMEOUT_SECONDS: "5",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      AUTONOMY_ENSURE_MAX_ATTEMPTS: "1",
      AUTONOMY_ENSURE_READY_TIMEOUT_SECONDS: "5",
      MCP_HTTP_BEARER_TOKEN: "",
    });

    const ensure = await runShellJson(["./scripts/autonomy_ctl.sh", "ensure"], baseEnv);
    assert.equal(ensure.ok, true);
    assert.equal(ensure.status.self_start_ready, true);
    assert.equal(ensure.status.worker_fabric.host_present, true);
    assert.equal(ensure.status.model_router.backend_present, true);
    assert.equal(ensure.status.ring_leader.running, true);

    const status = await runShellJson(["./scripts/autonomy_ctl.sh", "status"], baseEnv);
    assert.equal(status.self_start_ready, true);
    assert.equal((status.repairs_needed ?? []).every((entry) => String(entry).endsWith(".default_drift")), true);
    assert.equal(status.maintain?.runtime?.running, true);
    assert.equal(status.maintain?.runtime?.last_error ?? null, null);
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stdio helper processes do not claim the TriChat bus socket", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-helper-bus-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");

  try {
    const result = await execFileAsync(
      "node",
      [
        "./scripts/mcp_tool_call.mjs",
        "--tool",
        "health.storage",
        "--args",
        "{}",
        "--transport",
        "stdio",
        "--stdio-command",
        "node",
        "--stdio-args",
        "dist/server.js",
        "--cwd",
        REPO_ROOT,
      ],
      {
        cwd: REPO_ROOT,
        env: inheritedEnv({
          ANAMNESIS_HUB_DB_PATH: dbPath,
          TRICHAT_BUS_SOCKET_PATH: busPath,
          MCP_HTTP_BEARER_TOKEN: "",
        }),
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(fs.existsSync(busPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ring leader start proactively uses autonomy bootstrap on a cold control plane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ring-leader-bootstrap-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_PROVIDER_BRIDGE_ROUTER_ENABLED: "0",
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
    });

    const started = await runShellJson(["./scripts/ring_leader_ctl.sh", "start"], baseEnv);
    assert.equal(started.running, true);

    const status = await runShellJson(["./scripts/autonomy_ctl.sh", "status"], baseEnv);
    assert.equal(status.self_start_ready, true);
    assert.equal((status.repairs_needed ?? []).every((entry) => String(entry).endsWith(".default_drift")), true);
    assert.equal(status.ring_leader.running, true);
    assert.equal(status.worker_fabric.host_present, true);
    assert.equal(status.model_router.backend_present, true);
    assert.equal(status.maintain?.runtime?.running, true);
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy keepalive defaults to bounded maintenance instead of a bare readiness ping", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-keepalive-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_PROVIDER_BRIDGE_ROUTER_ENABLED: "0",
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
      AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS: "60",
      AUTONOMY_EVAL_INTERVAL_SECONDS: "300",
    });

    const maintained = await runShellJson(["./scripts/autonomy_keepalive.sh"], baseEnv);
    assert.equal(maintained.ok, true);
    assert.equal(maintained.status.state.enabled, true);
    assert.equal(maintained.status.bootstrap.self_start_ready, true);
    assert.equal(maintained.status.goal_autorun_daemon.running, true);
    assert.equal(typeof maintained.status.state.last_run_at, "string");
    assert.ok(maintained.eval.executed === true || maintained.actions.includes("eval.deferred_busy"));
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy keepalive runner exits tempfail when http is still down during restart recovery", async () => {
  try {
    await execFileAsync(process.execPath, ["./scripts/autonomy_keepalive_runner.mjs"], {
      cwd: REPO_ROOT,
      env: inheritedEnv({
        AUTONOMY_BOOTSTRAP_TRANSPORT: "http",
        AUTONOMY_KEEPALIVE_HTTP_READY_TIMEOUT_MS: "1000",
        TRICHAT_MCP_URL: "http://127.0.0.1:9/",
        TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
      }),
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.fail("autonomy_keepalive_runner.mjs should exit non-zero when http is not ready");
  } catch (error) {
    assert.equal(error.code ?? error.status, 75);
    const parsed = JSON.parse(String(error.stdout || "{}"));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.retryable, true);
    assert.equal(parsed.reason, "http_not_ready");
    assert.equal(parsed.exit_code, 75);
  }
});

test("agents_switch status returns bounded JSON over the live HTTP control plane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agents-switch-status-http-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "test-agents-switch-status-token";
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });
  const httpPort = await reservePort();
  const child = spawn("node", ["dist/server.js", "--http", "--http-port", String(httpPort)], {
    cwd: REPO_ROOT,
    env: inheritedEnv({
      MCP_HTTP: "1",
      MCP_HTTP_PORT: String(httpPort),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "1",
      // This test seeds maintain state manually after bootstrap. Keeping the
      // daemon off here removes an avoidable cold-start race from the harness.
      MCP_AUTONOMY_MAINTAIN_ON_START: "0",
      AGENTS_STATUS_TIMEOUT_SECONDS: "4",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForAutonomyStatus({
      url: `http://127.0.0.1:${httpPort}/`,
      origin: "http://127.0.0.1",
      bearerToken,
    });
    const result = await execFileAsync("./scripts/agents_switch.sh", ["status"], {
      cwd: REPO_ROOT,
      env: inheritedEnv({
        ANAMNESIS_HUB_DB_PATH: dbPath,
        TRICHAT_BUS_SOCKET_PATH: busPath,
        TRICHAT_OLLAMA_URL: ollama.url,
        TRICHAT_MCP_URL: `http://127.0.0.1:${httpPort}/`,
        TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
        MCP_HTTP_BEARER_TOKEN: bearerToken,
        AGENTS_STATUS_TIMEOUT_SECONDS: "4",
      }),
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const status = JSON.parse(result.stdout);
    assert.equal(status.ok, true);
    assert.equal(typeof status.switches?.autonomy_keepalive, "boolean");
    assert.equal(typeof status.launchd?.autonomy_keepalive_disabled, "boolean");
    assert.equal(typeof status.launchd?.autonomy_keepalive_operational, "boolean");
    assert.equal(typeof status.autonomy_runtime, "object");
    assert.equal(typeof status.auto_snapshot_runtime, "object");
  } finally {
    await stopChildProcess(child);
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agents_switch on repairs disabled launchd services across a simulated restart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agents-switch-repair-"));
  const fakeHome = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const launchDir = path.join(fakeHome, "Library", "LaunchAgents");
  const stateDir = path.join(tempDir, "launchctl-state");
  const launchctlLog = path.join(tempDir, "launchctl.log");
  const labels = [
    "com.mcplayground.mcp.server",
    "com.mcplayground.imprint.autosnapshot",
    "com.mcplayground.imprint.inboxworker",
    "com.mcplayground.autonomy.keepalive",
    "com.mcplayground.local-adapter.watchdog",
  ];

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  for (const label of labels) {
    fs.writeFileSync(path.join(launchDir, `${label}.plist`), `<plist><dict><key>Label</key><string>${label}</string></dict></plist>`);
    fs.writeFileSync(path.join(stateDir, `${label}.disabled`), "1");
    fs.writeFileSync(path.join(stateDir, `${label}.loaded`), "0");
  }

  fs.writeFileSync(
    path.join(fakeBin, "launchctl"),
    `#!/usr/bin/env bash
set -euo pipefail
state_dir="${stateDir}"
printf 'launchctl %s\\n' "$*" >> "${launchctlLog}"

label_from_arg() {
  local raw="$1"
  raw="\${raw##*/}"
  printf '%s' "\${raw%.plist}"
}

state_file() {
  printf '%s/%s.%s' "$state_dir" "$1" "$2"
}

read_state() {
  local file="$1"
  if [[ -f "$file" ]]; then
    cat "$file"
  else
    printf '0'
  fi
}

cmd="\${1:-}"
case "$cmd" in
  enable)
    label="$(label_from_arg "\${2:-}")"
    printf '0' > "$(state_file "$label" disabled)"
    ;;
  disable)
    label="$(label_from_arg "\${2:-}")"
    printf '1' > "$(state_file "$label" disabled)"
    ;;
  bootout)
    if [[ $# -ge 3 ]]; then
      label="$(label_from_arg "\${3:-}")"
    else
      label="$(label_from_arg "\${2:-}")"
    fi
    printf '0' > "$(state_file "$label" loaded)"
    ;;
  bootstrap)
    label="$(label_from_arg "\${3:-}")"
    if [[ "$(read_state "$(state_file "$label" disabled)")" == "1" ]]; then
      echo "service is disabled" >&2
      exit 5
    fi
    printf '0' > "$(state_file "$label" loaded)"
    ;;
  kickstart)
    target="\${3:-\${2:-}}"
    label="$(label_from_arg "$target")"
    if [[ "$(read_state "$(state_file "$label" disabled)")" == "1" ]]; then
      echo "service is disabled" >&2
      exit 6
    fi
    printf '1' > "$(state_file "$label" loaded)"
    ;;
  print)
    label="$(label_from_arg "\${2:-}")"
    if [[ "$(read_state "$(state_file "$label" loaded)")" == "1" ]]; then
      exit 0
    fi
    exit 113
    ;;
  print-disabled)
    printf '\\tdisabled services = {\\n'
    for file in "$state_dir"/*.disabled; do
      label="$(basename "$file" .disabled)"
      status='enabled'
      if [[ "$(read_state "$file")" == "1" ]]; then
        status='disabled'
      fi
      printf '\\t\\t"%s" => %s\\n' "$label" "$status"
    done
    printf '\\t}\\n'
    ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    "#!/usr/bin/env bash\nprintf '{\"ok\":true}\\n'\n",
    { mode: 0o755 }
  );

  const env = inheritedEnv({
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "test-agents-switch-repair-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
    AGENTS_STATUS_DEEP_RUNTIME: "0",
  });

  try {
    const firstOn = await runShellJson(["./scripts/agents_switch.sh", "on"], env);
    assert.equal(firstOn.ok, true);

    let status = await runShellJson(["./scripts/agents_switch.sh", "status"], env);
    assert.equal(status.switches.autonomy_keepalive, true);
    assert.equal(status.launchd.autonomy_keepalive_loaded, true);
    assert.equal(status.launchd.autonomy_keepalive_disabled, false);
    assert.equal(status.launchd.autonomy_keepalive_operational, true);
    assert.equal(status.switches.local_adapter_watchdog, true);
    assert.equal(status.launchd.local_adapter_watchdog_loaded, true);
    assert.equal(status.launchd.local_adapter_watchdog_disabled, false);
    assert.equal(status.launchd.local_adapter_watchdog_operational, true);
    assert.equal(status.switches.mcp_server, true);

    for (const label of labels) {
      fs.writeFileSync(path.join(stateDir, `${label}.disabled`), "1");
      fs.writeFileSync(path.join(stateDir, `${label}.loaded`), "0");
    }

    const secondOn = await runShellJson(["./scripts/agents_switch.sh", "on"], env);
    assert.equal(secondOn.ok, true);

    status = await runShellJson(["./scripts/agents_switch.sh", "status"], env);
    assert.equal(status.switches.autonomy_keepalive, true);
    assert.equal(status.launchd.autonomy_keepalive_disabled, false);
    assert.equal(status.launchd.autonomy_keepalive_operational, true);
    assert.equal(status.switches.local_adapter_watchdog, true);
    assert.equal(status.launchd.local_adapter_watchdog_disabled, false);
    assert.equal(status.launchd.local_adapter_watchdog_operational, true);
    assert.equal(status.launchd.mcp_operational, true);

    const launchLog = fs.readFileSync(launchctlLog, "utf8");
    const keepaliveEnableIndex = launchLog.indexOf(
      `launchctl enable gui/${process.getuid()}/com.mcplayground.autonomy.keepalive`
    );
    const keepaliveServiceBootoutIndex = launchLog.indexOf(
      `launchctl bootout gui/${process.getuid()}/com.mcplayground.autonomy.keepalive`
    );
    const keepaliveBootstrapIndex = launchLog.indexOf(
      `launchctl bootstrap gui/${process.getuid()} ${path.join(launchDir, "com.mcplayground.autonomy.keepalive.plist")}`
    );
    const watchdogEnableIndex = launchLog.indexOf(
      `launchctl enable gui/${process.getuid()}/com.mcplayground.local-adapter.watchdog`
    );
    const watchdogServiceBootoutIndex = launchLog.indexOf(
      `launchctl bootout gui/${process.getuid()}/com.mcplayground.local-adapter.watchdog`
    );
    const watchdogBootstrapIndex = launchLog.indexOf(
      `launchctl bootstrap gui/${process.getuid()} ${path.join(launchDir, "com.mcplayground.local-adapter.watchdog.plist")}`
    );
    assert.notEqual(keepaliveEnableIndex, -1);
    assert.notEqual(keepaliveServiceBootoutIndex, -1);
    assert.notEqual(keepaliveBootstrapIndex, -1);
    assert.notEqual(watchdogEnableIndex, -1);
    assert.notEqual(watchdogServiceBootoutIndex, -1);
    assert.notEqual(watchdogBootstrapIndex, -1);
    assert.ok(keepaliveEnableIndex < keepaliveBootstrapIndex);
    assert.ok(keepaliveServiceBootoutIndex < keepaliveBootstrapIndex);
    assert.ok(watchdogEnableIndex < watchdogBootstrapIndex);
    assert.ok(watchdogServiceBootoutIndex < watchdogBootstrapIndex);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy status preserves degraded /ready payloads instead of falling back to a slow stdio path", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-status-degraded-ready-"));
  const bearerToken = "test-autonomy-status-degraded-ready-token";
  const httpPort = await reservePort();
  const readyPayload = {
    ok: false,
    ready: true,
    state: "degraded",
    self_start_ready: true,
    attention: ["autonomy.eval.below_threshold"],
    autonomy_maintain: {
      enabled: true,
      runtime_running: true,
      stale: false,
      eval_due: false,
      last_run_at: new Date().toISOString(),
      eval_health: {
        below_threshold: true,
      },
    },
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === "/ready") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify(readyPayload));
      return;
    }
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"ok":false,"error":"bootstrap rpc unavailable in degraded-ready test"}');
  });
  await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));

  try {
    const readyResponse = await fetchHttpResponse(`http://127.0.0.1:${httpPort}/ready`, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "http://127.0.0.1",
    });
    assert.equal(readyResponse.statusCode, 503);

    const status = await runShellJson(["./scripts/autonomy_ctl.sh", "status"], inheritedEnv({
      TRICHAT_MCP_URL: `http://127.0.0.1:${httpPort}/`,
      TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
      AUTONOMY_STATUS_TIMEOUT_MS: "20000",
      AUTONOMY_STATUS_HTTP_TIMEOUT_MS: "20000",
    }));
    assert.equal(status.self_start_ready, true);
    assert.equal(status.source, "ready");
    assert.equal(status.maintain?.source, "ready");
    assert.equal(status.maintain?.eval_health?.below_threshold, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launchd installer generates node runner ProgramArguments for launch agents", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-launchd-install-"));
  const fakeHome = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const launchDir = path.join(fakeHome, "Library", "LaunchAgents");
  const launchctlLog = path.join(tempDir, "launchctl.log");
  const curlCountFile = path.join(tempDir, "curl.count");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "launchctl"),
    `#!/usr/bin/env bash
printf 'launchctl %s\\n' "$*" >> "${launchctlLog}"
exit 0
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "npm"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
count=0
if [[ -f "${curlCountFile}" ]]; then
  count="$(cat "${curlCountFile}")"
fi
count=$((count + 1))
printf '%s' "$count" > "${curlCountFile}"
printf 'curl attempt=%s %s\\n' "$count" "$*" >> "${launchctlLog}"
if [[ "$count" -lt 2 ]]; then
  exit 7
fi
printf '{"ok":true,"ready":true}\\n'
`,
    { mode: 0o755 }
  );

  const env = inheritedEnv({
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    TRICHAT_RING_LEADER_TRANSPORT: "stdio",
    MCP_HTTP_BEARER_TOKEN: "",
  });

  await execFileAsync("./scripts/launchd_install.sh", [], {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });

  const keepalivePlist = fs.readFileSync(
    path.join(launchDir, "com.mcplayground.autonomy.keepalive.plist"),
    "utf8"
  );
  const autosnapshotPlist = fs.readFileSync(
    path.join(launchDir, "com.mcplayground.imprint.autosnapshot.plist"),
    "utf8"
  );
  const watchdogPlist = fs.readFileSync(
    path.join(launchDir, "com.mcplayground.local-adapter.watchdog.plist"),
    "utf8"
  );
  const mcpPlist = fs.readFileSync(
    path.join(launchDir, "com.mcplayground.mcp.server.plist"),
    "utf8"
  );

  assert.match(keepalivePlist, /<string>.*node.*<\/string>/);
  assert.match(
    keepalivePlist,
    new RegExp(
      `<string>${escapeRegExp(path.join(REPO_ROOT, "scripts", "autonomy_keepalive_runner.mjs"))}<\\/string>`
    )
  );
  assert.doesNotMatch(keepalivePlist, /autonomy_keepalive\.sh/);
  assert.match(keepalivePlist, /<key>AUTONOMY_KEEPALIVE_HTTP_READY_TIMEOUT_MS<\/key>\s*<string>60000<\/string>/);
  assert.match(keepalivePlist, /<key>AUTONOMY_KEEPALIVE_TOOL_TIMEOUT_MS<\/key>\s*<string>180000<\/string>/);
  assert.match(
    keepalivePlist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/
  );
  assert.match(keepalivePlist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(watchdogPlist, /<string>.*node.*<\/string>/);
  assert.match(
    watchdogPlist,
    new RegExp(
      `<string>${escapeRegExp(path.join(REPO_ROOT, "scripts", "local_adapter_watchdog.mjs"))}<\\/string>`
    )
  );
  assert.match(watchdogPlist, /<string>--transport<\/string>\s*<string>http<\/string>/);
  assert.match(watchdogPlist, /<string>--max-soak-age-minutes<\/string>\s*<string>240<\/string>/);
  assert.match(watchdogPlist, /<string>--cycles<\/string>\s*<string>1<\/string>/);

  assert.match(autosnapshotPlist, /<string>.*node.*<\/string>/);
  assert.match(
    autosnapshotPlist,
    new RegExp(
      `<string>${escapeRegExp(path.join(REPO_ROOT, "scripts", "imprint_auto_snapshot_runner.mjs"))}<\\/string>`
    )
  );
  assert.doesNotMatch(autosnapshotPlist, /imprint_auto_snapshot_ctl\.sh/);
  assert.match(mcpPlist, /<key>MCP_AUTONOMY_BOOTSTRAP_ON_START<\/key>\s*<string>1<\/string>/);
  assert.match(mcpPlist, /<key>MCP_AUTONOMY_MAINTAIN_ON_START<\/key>\s*<string>1<\/string>/);
  assert.match(mcpPlist, /<key>MCP_AUTONOMY_MAINTAIN_RUN_IMMEDIATELY_ON_START<\/key>\s*<string>0<\/string>/);

  const launchLog = fs.readFileSync(launchctlLog, "utf8");
  const mcpKickstartIndex = launchLog.indexOf(`launchctl kickstart -k gui/${process.getuid()}/com.mcplayground.mcp.server`);
  const curlReadyIndex = launchLog.indexOf("curl attempt=2");
  const workerBootstrapIndex = launchLog.indexOf(
    `launchctl bootstrap gui/${process.getuid()} ${path.join(launchDir, "com.mcplayground.imprint.inboxworker.plist")}`
  );
  assert.notEqual(mcpKickstartIndex, -1);
  assert.notEqual(curlReadyIndex, -1);
  assert.notEqual(workerBootstrapIndex, -1);
  assert.ok(curlReadyIndex > mcpKickstartIndex);
  assert.ok(workerBootstrapIndex > curlReadyIndex);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("launchd installer clears stale service-target state before bootstrap", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-launchd-install-stale-"));
  const fakeHome = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const launchDir = path.join(fakeHome, "Library", "LaunchAgents");
  const launchctlLog = path.join(tempDir, "launchctl.log");
  const clearedDir = path.join(tempDir, "cleared");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(clearedDir, { recursive: true });

  fs.writeFileSync(
    path.join(fakeBin, "launchctl"),
    `#!/usr/bin/env bash
set -euo pipefail
cleared_dir="${clearedDir}"
printf 'launchctl %s\\n' "$*" >> "${launchctlLog}"

label_from_arg() {
  local raw="$1"
  raw="\${raw##*/}"
  printf '%s' "\${raw%.plist}"
}

cmd="\${1:-}"
case "$cmd" in
  bootout)
    if [[ $# -ge 3 ]]; then
      exit 0
    fi
    label="$(label_from_arg "\${2:-}")"
    touch "$cleared_dir/$label"
    ;;
  bootstrap)
    label="$(label_from_arg "\${3:-}")"
    if [[ ! -f "$cleared_dir/$label" ]]; then
      echo "service already bootstrapped" >&2
      exit 37
    fi
    ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "npm"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    "#!/usr/bin/env bash\nprintf '{\"ok\":true}\\n'\n",
    { mode: 0o755 }
  );

  const env = inheritedEnv({
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    TRICHAT_RING_LEADER_TRANSPORT: "stdio",
    MCP_HTTP_BEARER_TOKEN: "",
  });

  try {
    await execFileAsync("./scripts/launchd_install.sh", [], {
      cwd: REPO_ROOT,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });

    const launchLog = fs.readFileSync(launchctlLog, "utf8");
    const mcpServiceBootoutIndex = launchLog.indexOf(
      `launchctl bootout gui/${process.getuid()}/com.mcplayground.mcp.server`
    );
    const mcpBootstrapIndex = launchLog.indexOf(
      `launchctl bootstrap gui/${process.getuid()} ${path.join(launchDir, "com.mcplayground.mcp.server.plist")}`
    );
    assert.notEqual(mcpServiceBootoutIndex, -1);
    assert.notEqual(mcpBootstrapIndex, -1);
    assert.ok(mcpServiceBootoutIndex < mcpBootstrapIndex);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agents_switch status marks stale repo-bound plists as non-operational", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agents-switch-stale-status-"));
  const fakeHome = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const launchDir = path.join(fakeHome, "Library", "LaunchAgents");
  const staleRoot = path.join(tempDir, "old-workspace");
  const labels = [
    "com.mcplayground.mcp.server",
    "com.mcplayground.imprint.autosnapshot",
    "com.mcplayground.imprint.inboxworker",
    "com.mcplayground.autonomy.keepalive",
    "com.mcplayground.local-adapter.watchdog",
  ];

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(staleRoot, { recursive: true });

  for (const label of labels) {
    fs.writeFileSync(
      path.join(launchDir, `${label}.plist`),
      `<plist><dict><key>Label</key><string>${label}</string><key>WorkingDirectory</key><string>${staleRoot}</string></dict></plist>`
    );
  }

  fs.writeFileSync(
    path.join(fakeBin, "launchctl"),
    `#!/usr/bin/env bash
set -euo pipefail

label_from_arg() {
  local raw="$1"
  raw="\${raw##*/}"
  printf '%s' "\${raw%.plist}"
}

case "\${1:-}" in
  print)
    exit 0
    ;;
  print-disabled)
    printf '\\tdisabled services = {\\n'
    for label in ${labels.map((label) => JSON.stringify(label)).join(" ")}; do
      printf '\\t\\t"%s" => enabled\\n' "$label"
    done
    printf '\\t}\\n'
    ;;
esac

exit 0
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    "#!/usr/bin/env bash\nprintf '{\"ok\":true}\\n'\n",
    { mode: 0o755 }
  );

  const env = inheritedEnv({
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "test-agents-switch-stale-status-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
    AGENTS_STATUS_DEEP_RUNTIME: "0",
  });

  try {
    const status = await runShellJson(["./scripts/agents_switch.sh", "status"], env);
    assert.equal(status.launchd.mcp_loaded, true);
    assert.equal(status.launchd.mcp_plist_current, false);
    assert.equal(status.launchd.mcp_operational, false);
    assert.equal(status.launchd.autonomy_keepalive_loaded, true);
    assert.equal(status.launchd.autonomy_keepalive_plist_current, false);
    assert.equal(status.launchd.autonomy_keepalive_operational, false);
    assert.equal(status.switches.mcp_server, false);
    assert.equal(status.switches.autonomy_keepalive, false);
    assert.equal(status.switches.local_adapter_watchdog, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agents_switch on rewrites stale repo-bound plists before restart repair", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agents-switch-stale-repair-"));
  const fakeHome = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const launchDir = path.join(fakeHome, "Library", "LaunchAgents");
  const launchctlLog = path.join(tempDir, "launchctl.log");
  const staleRoot = path.join(tempDir, "old-workspace");
  const labels = [
    "com.mcplayground.mcp.server",
    "com.mcplayground.imprint.autosnapshot",
    "com.mcplayground.imprint.inboxworker",
    "com.mcplayground.autonomy.keepalive",
    "com.mcplayground.local-adapter.watchdog",
  ];

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(staleRoot, { recursive: true });

  for (const label of labels) {
    fs.writeFileSync(
      path.join(launchDir, `${label}.plist`),
      `<plist><dict><key>Label</key><string>${label}</string><key>WorkingDirectory</key><string>${staleRoot}</string></dict></plist>`
    );
  }

  fs.writeFileSync(
    path.join(fakeBin, "launchctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'launchctl %s\\n' "$*" >> "${launchctlLog}"

case "\${1:-}" in
  print)
    exit 0
    ;;
  print-disabled)
    printf '\\tdisabled services = {\\n'
    for label in ${labels.map((label) => JSON.stringify(label)).join(" ")}; do
      printf '\\t\\t"%s" => enabled\\n' "$label"
    done
    printf '\\t}\\n'
    ;;
esac

exit 0
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "npm"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    "#!/usr/bin/env bash\nprintf '{\"ok\":true}\\n'\n",
    { mode: 0o755 }
  );

  const env = inheritedEnv({
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "",
    TRICHAT_RING_LEADER_TRANSPORT: "stdio",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
    AGENTS_STATUS_DEEP_RUNTIME: "0",
  });

  try {
    const repaired = await runShellJson(["./scripts/agents_switch.sh", "on"], env);
    assert.equal(repaired.ok, true);
    assert.equal(repaired.launchd.mcp_plist_current, true);
    assert.equal(repaired.launchd.autonomy_keepalive_plist_current, true);
    assert.equal(repaired.launchd.local_adapter_watchdog_plist_current, true);
    assert.equal(repaired.switches.mcp_server, true);
    assert.equal(repaired.switches.autonomy_keepalive, true);
    assert.equal(repaired.switches.local_adapter_watchdog, true);

    const keepalivePlist = fs.readFileSync(
      path.join(launchDir, "com.mcplayground.autonomy.keepalive.plist"),
      "utf8"
    );
    assert.match(keepalivePlist, new RegExp(escapeRegExp(REPO_ROOT)));
    assert.doesNotMatch(keepalivePlist, new RegExp(escapeRegExp(staleRoot)));

    const launchLog = fs.readFileSync(launchctlLog, "utf8");
    assert.match(
      launchLog,
      new RegExp(
        `launchctl bootstrap gui/${process.getuid()} ${escapeRegExp(path.join(launchDir, "com.mcplayground.mcp.server.plist"))}`
      )
    );
    assert.match(
      launchLog,
      new RegExp(
        `launchctl bootstrap gui/${process.getuid()} ${escapeRegExp(path.join(launchDir, "com.mcplayground.autonomy.keepalive.plist"))}`
      )
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function startFakeOllamaServer({ models }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake Ollama server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitForAutonomyStatus({ url, origin, bearerToken }) {
  const deadline = Date.now() + 120000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchHttpResponse(new URL("/health", url).toString(), {
        Authorization: `Bearer ${bearerToken}`,
        Origin: origin,
      }, {
        timeoutMs: 5000,
      });
      if (health.statusCode >= 500) {
        throw new Error(`health=${health.statusCode}`);
      }
      const result = await execFileAsync(
        "node",
        [
          "./scripts/mcp_tool_call.mjs",
          "--tool",
          "autonomy.bootstrap",
          "--args",
          '{"action":"status"}',
          "--transport",
          "http",
          "--url",
          url,
          "--origin",
          origin,
          "--cwd",
          REPO_ROOT,
        ],
        {
          cwd: REPO_ROOT,
          env: inheritedEnv({
            MCP_HTTP_BEARER_TOKEN: bearerToken,
          }),
          maxBuffer: 8 * 1024 * 1024,
          timeout: 15_000,
        }
      );
      const parsed = JSON.parse(result.stdout);
      if (parsed?.self_start_ready) {
        return parsed;
      }
      lastError = new Error(`self_start_ready=false repairs=${JSON.stringify(parsed?.repairs_needed ?? [])}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error("Timed out waiting for autonomy bootstrap readiness");
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runShellJson(command, env) {
  const [file, ...args] = command;
  const result = await execFileAsync(file, args, {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 240_000,
  });
  return parseShellJson(result.stdout, result.stderr);
}

function parseShellJson(stdout, stderr = "") {
  const text = String(stdout || "").trim();
  const fallbackText = String(stderr || "").trim();
  if (!text && !fallbackText) {
    throw new Error("Expected JSON output but both stdout and stderr were empty.");
  }
  try {
    return JSON.parse(text || fallbackText);
  } catch (originalError) {
    const lines = (text || fallbackText)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    throw originalError;
  }
}

async function rejectsExecFile(file, args, env) {
  try {
    await execFileAsync(file, args, {
      cwd: REPO_ROOT,
      env: inheritedEnv(env),
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (error) {
    return error;
  }
  assert.fail(`${file} ${args.join(" ")} should have failed`);
}
