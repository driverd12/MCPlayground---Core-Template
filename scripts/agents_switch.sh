#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"
if [[ "${OSTYPE:-}" == darwin* ]]; then
  SUPPORT_ROOT="${HOME}/Library/Application Support/master-mold"
else
  SUPPORT_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/master-mold"
fi
SUPPORT_RUNNER="${SUPPORT_ROOT}/bin/run_from_repo.sh"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
MCP_PORT="${MCP_HTTP_PORT:-${ANAMNESIS_MCP_HTTP_PORT:-8787}}"
HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:${MCP_PORT}/}"
HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"

MCP_LABEL="com.master-mold.mcp.server"
AUTO_LABEL="com.master-mold.imprint.autosnapshot"
WORKER_LABEL="com.master-mold.imprint.inboxworker"
KEEPALIVE_LABEL="com.master-mold.autonomy.keepalive"
WATCHDOG_LABEL="com.master-mold.local-adapter.watchdog"
OFFICE_GUI_LABEL="com.master-mold.agent-office.gui.watch"
AUTO_OPEN_LABEL="com.master-mold.agent-office.gui.open"
MLX_LABEL="com.master-mold.mlx.server"
MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"
KEEPALIVE_PLIST="${LAUNCH_DIR}/${KEEPALIVE_LABEL}.plist"
WATCHDOG_PLIST="${LAUNCH_DIR}/${WATCHDOG_LABEL}.plist"
OFFICE_GUI_PLIST="${LAUNCH_DIR}/${OFFICE_GUI_LABEL}.plist"
AUTO_OPEN_PLIST="${LAUNCH_DIR}/${AUTO_OPEN_LABEL}.plist"
MLX_PLIST="${LAUNCH_DIR}/${MLX_LABEL}.plist"
GUI_FALLBACK_SESSION="master-mold-http"
TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN+x}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

launch_agent_plist_current() {
  local plist="$1"
  [[ -f "${plist}" ]] || return 1
  grep -Fq "${REPO_ROOT}" "${plist}" 2>/dev/null || grep -Fq "${SUPPORT_RUNNER}" "${plist}" 2>/dev/null
}

launch_agent_plist_ready() {
  local plist="$1"
  [[ -f "${plist}" ]] || return 1
  launch_agent_plist_current "${plist}"
}

DISABLED_SERVICES_RAW=""

is_loaded() {
  local label="$1"
  launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1
}

capture_disabled_services() {
  if [[ -z "${DISABLED_SERVICES_RAW}" ]]; then
    DISABLED_SERVICES_RAW="$(launchctl print-disabled "${DOMAIN}" 2>/dev/null || true)"
  fi
  printf '%s' "${DISABLED_SERVICES_RAW}"
}

is_disabled() {
  local label="$1"
  local disabled_services_raw
  disabled_services_raw="$(capture_disabled_services)"
  [[ -n "${disabled_services_raw}" ]] || return 1
  LAUNCHCTL_DISABLED_SERVICES="${disabled_services_raw}" python3 - "${label}" <<'PY'
import os
import re
import sys

label = sys.argv[1]
raw = os.environ.get("LAUNCHCTL_DISABLED_SERVICES", "")
pattern = re.compile(r'"([^"]+)"\s*=>\s*(disabled|enabled)')

for line in raw.splitlines():
    match = pattern.search(line)
    if not match:
        continue
    if match.group(1) == label:
        raise SystemExit(0 if match.group(2) == "disabled" else 1)

raise SystemExit(1)
PY
}

capture_status_json() {
  local command=("$@")
  python3 - "${AGENTS_STATUS_TIMEOUT_SECONDS:-8}" "${command[@]}" <<'PY'
import json
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
command = sys.argv[2:]
try:
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
except subprocess.TimeoutExpired:
    print("{}")
    raise SystemExit(0)

if completed.returncode != 0:
    print("{}")
    raise SystemExit(0)

stdout = (completed.stdout or "").strip()
try:
    json.loads(stdout)
except Exception:
    print("{}")
else:
    print(stdout)
PY
}

capture_status_json_parallel() {
  local output_file="$1"
  shift
  (
    capture_status_json "$@" >"${output_file}"
  ) &
  printf '%s\n' "$!"
}

capture_http_json() {
  local url="$1"
  local timeout_ms="${2:-2000}"
  node --input-type=module - "${url}" "${timeout_ms}" <<'NODE'
import http from "node:http";
import https from "node:https";

const rawUrl = String(process.argv[2] || "").trim();
const timeoutMs = Math.max(100, Number.parseInt(String(process.argv[3] || "2000"), 10) || 2000);

if (!rawUrl) {
  process.stdout.write("{}");
  process.exit(0);
}

let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  process.stdout.write("{}");
  process.exit(0);
}

const client = parsed.protocol === "https:" ? https : http;
const req = client.request(
  parsed,
  {
    method: "GET",
    headers: {
      accept: "application/json",
      connection: "close",
    },
  },
  (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error("response too large"));
      }
    });
    res.on("end", () => {
      if ((res.statusCode || 500) >= 400) {
        process.stdout.write("{}");
        return;
      }
      try {
        const parsedBody = JSON.parse(body);
        if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
          process.stdout.write("{}");
          return;
        }
        process.stdout.write(JSON.stringify(parsedBody));
      } catch {
        process.stdout.write("{}");
      }
    });
  }
);

req.on("error", () => {
  process.stdout.write("{}");
});

req.setTimeout(timeoutMs, () => {
  req.destroy(new Error("timed out"));
});

req.end();
NODE
}

bootout_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
}

bootout_service_target() {
  local label="$1"
  launchctl bootout "${DOMAIN}/${label}" >/dev/null 2>&1 || true
}

reset_launch_agent() {
  local plist="$1"
  local label="$2"
  bootout_if_exists "${plist}"
  # Clear stale launchctl entries keyed by label so restart recovery does not depend on the old plist path.
  bootout_service_target "${label}"
}

bootstrap_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootstrap "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
}

terminate_repo_listener() {
  local pid="$1"
  [[ -n "${pid}" ]] || return 0
  local command_line
  command_line="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
  if [[ -z "${command_line}" ]]; then
    return 0
  fi
  if [[ "${command_line}" != *"${REPO_ROOT}"* && "${command_line}" != *"dist/server.js"* ]]; then
    return 0
  fi
  kill "${pid}" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  kill -9 "${pid}" >/dev/null 2>&1 || true
}

clear_repo_http_runtime() {
  tmux kill-session -t "${GUI_FALLBACK_SESSION}" >/dev/null 2>&1 || true
  if command -v lsof >/dev/null 2>&1; then
    local port_pids=""
    port_pids="$(lsof -tiTCP:${MCP_PORT} -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${port_pids}" ]]; then
      while IFS= read -r pid; do
        terminate_repo_listener "${pid}"
      done <<< "${port_pids}"
    fi
  fi
}

wait_for_mcp_http() {
  [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]] || return 1
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if curl -fsS --connect-timeout 1 --max-time 4 \
      -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
      -H "Origin: ${HTTP_ORIGIN}" \
      "${HTTP_URL%/}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

case "${ACTION}" in
  on)
    # Repo moves leave launchd plists behind under ~/Library/LaunchAgents with dead absolute paths.
    # Treat those stale definitions the same as missing files so `agents:on` rewrites them safely.
    if ! launch_agent_plist_ready "${MCP_PLIST}" || \
      ! launch_agent_plist_ready "${AUTO_PLIST}" || \
      ! launch_agent_plist_ready "${WORKER_PLIST}" || \
      ! launch_agent_plist_ready "${KEEPALIVE_PLIST}" || \
      ! launch_agent_plist_ready "${WATCHDOG_PLIST}" || \
      ! launch_agent_plist_ready "${OFFICE_GUI_PLIST}" || \
      ! launch_agent_plist_ready "${AUTO_OPEN_PLIST}" || \
      { [[ "${TRICHAT_MLX_SERVER_ENABLED:-0}" == "1" ]] && ! launch_agent_plist_ready "${MLX_PLIST}"; }; then
      "${REPO_ROOT}/scripts/launchd_install.sh"
    else
      launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${OFFICE_GUI_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${AUTO_OPEN_LABEL}" >/dev/null 2>&1 || true
      if [[ -f "${MLX_PLIST}" ]]; then
        launchctl enable "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
      fi
      reset_launch_agent "${MCP_PLIST}" "${MCP_LABEL}"
      reset_launch_agent "${AUTO_PLIST}" "${AUTO_LABEL}"
      reset_launch_agent "${WORKER_PLIST}" "${WORKER_LABEL}"
      reset_launch_agent "${KEEPALIVE_PLIST}" "${KEEPALIVE_LABEL}"
      reset_launch_agent "${WATCHDOG_PLIST}" "${WATCHDOG_LABEL}"
      reset_launch_agent "${OFFICE_GUI_PLIST}" "${OFFICE_GUI_LABEL}"
      reset_launch_agent "${AUTO_OPEN_PLIST}" "${AUTO_OPEN_LABEL}"
      reset_launch_agent "${MLX_PLIST}" "${MLX_LABEL}"
      clear_repo_http_runtime
      bootstrap_if_exists "${MCP_PLIST}"
      launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      wait_for_mcp_http
      bootstrap_if_exists "${AUTO_PLIST}"
      bootstrap_if_exists "${WORKER_PLIST}"
      bootstrap_if_exists "${KEEPALIVE_PLIST}"
      bootstrap_if_exists "${WATCHDOG_PLIST}"
      bootstrap_if_exists "${OFFICE_GUI_PLIST}"
      bootstrap_if_exists "${AUTO_OPEN_PLIST}"
      bootstrap_if_exists "${MLX_PLIST}"
      launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${OFFICE_GUI_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${AUTO_OPEN_LABEL}" >/dev/null 2>&1 || true
      if [[ -f "${MLX_PLIST}" ]]; then
        launchctl kickstart -k "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
      fi
    fi
    ;;
  off)
    "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true
    reset_launch_agent "${KEEPALIVE_PLIST}" "${KEEPALIVE_LABEL}"
    reset_launch_agent "${WORKER_PLIST}" "${WORKER_LABEL}"
    reset_launch_agent "${AUTO_PLIST}" "${AUTO_LABEL}"
    reset_launch_agent "${MCP_PLIST}" "${MCP_LABEL}"
    reset_launch_agent "${WATCHDOG_PLIST}" "${WATCHDOG_LABEL}"
    reset_launch_agent "${OFFICE_GUI_PLIST}" "${OFFICE_GUI_LABEL}"
    reset_launch_agent "${AUTO_OPEN_PLIST}" "${AUTO_OPEN_LABEL}"
    reset_launch_agent "${MLX_PLIST}" "${MLX_LABEL}"
    launchctl disable "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${OFFICE_GUI_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${AUTO_OPEN_LABEL}" >/dev/null 2>&1 || true
    launchctl disable "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
    ;;
  status)
    ;;
  install)
    "${REPO_ROOT}/scripts/launchd_install.sh"
    ;;
  uninstall)
    "${REPO_ROOT}/scripts/launchd_uninstall.sh"
    ;;
  *)
    echo "usage: $0 [on|off|status|install|uninstall]" >&2
    exit 2
    ;;
esac

MCP_RUNNING=false
AUTO_AGENT_LOADED=false
WORKER_AGENT_LOADED=false
KEEPALIVE_AGENT_LOADED=false
WATCHDOG_AGENT_LOADED=false
OFFICE_GUI_AGENT_LOADED=false
MLX_AGENT_LOADED=false
MCP_DISABLED=false
AUTO_AGENT_DISABLED=false
WORKER_AGENT_DISABLED=false
KEEPALIVE_AGENT_DISABLED=false
WATCHDOG_AGENT_DISABLED=false
OFFICE_GUI_AGENT_DISABLED=false
MLX_AGENT_DISABLED=false
if is_loaded "${MCP_LABEL}"; then MCP_RUNNING=true; fi
if is_loaded "${AUTO_LABEL}"; then AUTO_AGENT_LOADED=true; fi
if is_loaded "${WORKER_LABEL}"; then WORKER_AGENT_LOADED=true; fi
if is_loaded "${KEEPALIVE_LABEL}"; then KEEPALIVE_AGENT_LOADED=true; fi
if is_loaded "${WATCHDOG_LABEL}"; then WATCHDOG_AGENT_LOADED=true; fi
if is_loaded "${OFFICE_GUI_LABEL}"; then OFFICE_GUI_AGENT_LOADED=true; fi
if is_loaded "${MLX_LABEL}"; then MLX_AGENT_LOADED=true; fi
if is_disabled "${MCP_LABEL}"; then MCP_DISABLED=true; fi
if is_disabled "${AUTO_LABEL}"; then AUTO_AGENT_DISABLED=true; fi
if is_disabled "${WORKER_LABEL}"; then WORKER_AGENT_DISABLED=true; fi
if is_disabled "${KEEPALIVE_LABEL}"; then KEEPALIVE_AGENT_DISABLED=true; fi
if is_disabled "${WATCHDOG_LABEL}"; then WATCHDOG_AGENT_DISABLED=true; fi
if is_disabled "${OFFICE_GUI_LABEL}"; then OFFICE_GUI_AGENT_DISABLED=true; fi
if is_disabled "${MLX_LABEL}"; then MLX_AGENT_DISABLED=true; fi
MCP_PLIST_CURRENT=false
AUTO_PLIST_CURRENT=false
WORKER_PLIST_CURRENT=false
KEEPALIVE_PLIST_CURRENT=false
WATCHDOG_PLIST_CURRENT=false
OFFICE_GUI_PLIST_CURRENT=false
MLX_PLIST_CURRENT=false
if launch_agent_plist_current "${MCP_PLIST}"; then MCP_PLIST_CURRENT=true; fi
if launch_agent_plist_current "${AUTO_PLIST}"; then AUTO_PLIST_CURRENT=true; fi
if launch_agent_plist_current "${WORKER_PLIST}"; then WORKER_PLIST_CURRENT=true; fi
if launch_agent_plist_current "${KEEPALIVE_PLIST}"; then KEEPALIVE_PLIST_CURRENT=true; fi
if launch_agent_plist_current "${WATCHDOG_PLIST}"; then WATCHDOG_PLIST_CURRENT=true; fi
if launch_agent_plist_current "${OFFICE_GUI_PLIST}"; then OFFICE_GUI_PLIST_CURRENT=true; fi
if launch_agent_plist_current "${MLX_PLIST}"; then MLX_PLIST_CURRENT=true; fi

AUTO_SNAPSHOT_STATUS="{}"
AUTONOMY_STATUS="{}"
AUTONOMY_STATUS="$(capture_http_json "${HTTP_URL%/}/health" "${AGENTS_STATUS_HTTP_TIMEOUT_MS:-2000}")"
if [[ "${AUTONOMY_STATUS}" != \{* ]]; then
  AUTONOMY_STATUS="{}"
fi

if [[ "${AGENTS_STATUS_DEEP_RUNTIME:-0}" == "1" && "${AUTONOMY_STATUS}" == "{}" ]]; then
  AUTO_SNAPSHOT_STATUS_FILE="$(mktemp)"
  AUTONOMY_STATUS_FILE="$(mktemp)"
  AUTO_SNAPSHOT_PID="$(capture_status_json_parallel "${AUTO_SNAPSHOT_STATUS_FILE}" "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" status)"
  AUTONOMY_STATUS_PID="$(capture_status_json_parallel "${AUTONOMY_STATUS_FILE}" "${REPO_ROOT}/scripts/autonomy_ctl.sh" status)"
  wait "${AUTO_SNAPSHOT_PID}" >/dev/null 2>&1 || true
  wait "${AUTONOMY_STATUS_PID}" >/dev/null 2>&1 || true
  if [[ -s "${AUTO_SNAPSHOT_STATUS_FILE}" ]]; then
    AUTO_SNAPSHOT_STATUS="$(cat "${AUTO_SNAPSHOT_STATUS_FILE}")"
  fi
  if [[ -s "${AUTONOMY_STATUS_FILE}" ]]; then
    AUTONOMY_STATUS="$(cat "${AUTONOMY_STATUS_FILE}")"
  fi
  rm -f "${AUTO_SNAPSHOT_STATUS_FILE}" "${AUTONOMY_STATUS_FILE}"
fi

node --input-type=module - <<'NODE' \
"${ACTION}" \
"${DOMAIN}" \
"${MCP_LABEL}" \
"${MCP_RUNNING}" \
"${MCP_DISABLED}" \
"${AUTO_LABEL}" \
"${AUTO_AGENT_LOADED}" \
"${AUTO_AGENT_DISABLED}" \
"${WORKER_LABEL}" \
"${WORKER_AGENT_LOADED}" \
"${WORKER_AGENT_DISABLED}" \
"${KEEPALIVE_LABEL}" \
"${KEEPALIVE_AGENT_LOADED}" \
"${KEEPALIVE_AGENT_DISABLED}" \
"${WATCHDOG_LABEL}" \
"${WATCHDOG_AGENT_LOADED}" \
"${WATCHDOG_AGENT_DISABLED}" \
"${OFFICE_GUI_LABEL}" \
"${OFFICE_GUI_AGENT_LOADED}" \
"${OFFICE_GUI_AGENT_DISABLED}" \
"${MLX_LABEL}" \
"${MLX_AGENT_LOADED}" \
"${MLX_AGENT_DISABLED}" \
"${MCP_PLIST}" \
"${AUTO_PLIST}" \
"${WORKER_PLIST}" \
"${KEEPALIVE_PLIST}" \
"${WATCHDOG_PLIST}" \
"${OFFICE_GUI_PLIST}" \
"${MLX_PLIST}" \
"${MCP_PLIST_CURRENT}" \
"${AUTO_PLIST_CURRENT}" \
"${WORKER_PLIST_CURRENT}" \
"${KEEPALIVE_PLIST_CURRENT}" \
"${WATCHDOG_PLIST_CURRENT}" \
"${OFFICE_GUI_PLIST_CURRENT}" \
"${MLX_PLIST_CURRENT}" \
"${AUTO_SNAPSHOT_STATUS}" \
"${AUTONOMY_STATUS}"
const [
  action,
  domain,
  mcpLabel,
  mcpRunning,
  mcpDisabled,
  autoLabel,
  autoAgentLoaded,
  autoAgentDisabled,
  workerLabel,
  workerAgentLoaded,
  workerAgentDisabled,
  keepaliveLabel,
  keepaliveAgentLoaded,
  keepaliveAgentDisabled,
  watchdogLabel,
  watchdogAgentLoaded,
  watchdogAgentDisabled,
  officeGuiLabel,
  officeGuiAgentLoaded,
  officeGuiAgentDisabled,
  mlxLabel,
  mlxAgentLoaded,
  mlxAgentDisabled,
  mcpPlist,
  autoPlist,
  workerPlist,
  keepalivePlist,
  watchdogPlist,
  officeGuiPlist,
  mlxPlist,
  mcpPlistCurrent,
  autoPlistCurrent,
  workerPlistCurrent,
  keepalivePlistCurrent,
  watchdogPlistCurrent,
  officeGuiPlistCurrent,
  mlxPlistCurrent,
  autoSnapshotStatusRaw,
  autonomyStatusRaw,
] = process.argv.slice(2);

let autoSnapshotStatus = {};
try {
  autoSnapshotStatus = JSON.parse(autoSnapshotStatusRaw);
} catch {
  autoSnapshotStatus = {};
}

let autonomyStatus = {};
try {
  autonomyStatus = JSON.parse(autonomyStatusRaw);
} catch {
  autonomyStatus = {};
}

const payload = {
  ok: true,
  action,
  domain,
  switches: {
    mcp_server: mcpRunning === 'true' && mcpDisabled !== 'true' && mcpPlistCurrent === 'true',
    auto_snapshot: autoAgentLoaded === 'true' && autoAgentDisabled !== 'true' && autoPlistCurrent === 'true',
    inbox_worker: workerAgentLoaded === 'true' && workerAgentDisabled !== 'true' && workerPlistCurrent === 'true',
    autonomy_keepalive:
      keepaliveAgentLoaded === 'true' && keepaliveAgentDisabled !== 'true' && keepalivePlistCurrent === 'true',
    local_adapter_watchdog:
      watchdogAgentLoaded === 'true' && watchdogAgentDisabled !== 'true' && watchdogPlistCurrent === 'true',
    agent_office_gui:
      officeGuiAgentLoaded === 'true' && officeGuiAgentDisabled !== 'true' && officeGuiPlistCurrent === 'true',
    mlx_server: mlxAgentLoaded === 'true' && mlxAgentDisabled !== 'true' && mlxPlistCurrent === 'true',
  },
  launchd: {
    mcp_label: mcpLabel,
    mcp_loaded: mcpRunning === 'true',
    mcp_disabled: mcpDisabled === 'true',
    mcp_plist_current: mcpPlistCurrent === 'true',
    mcp_operational: mcpRunning === 'true' && mcpDisabled !== 'true' && mcpPlistCurrent === 'true',
    mcp_plist: mcpPlist,
    auto_snapshot_label: autoLabel,
    auto_snapshot_agent_loaded: autoAgentLoaded === 'true',
    auto_snapshot_disabled: autoAgentDisabled === 'true',
    auto_snapshot_plist_current: autoPlistCurrent === 'true',
    auto_snapshot_operational:
      autoAgentLoaded === 'true' && autoAgentDisabled !== 'true' && autoPlistCurrent === 'true',
    auto_snapshot_plist: autoPlist,
    inbox_worker_label: workerLabel,
    inbox_worker_loaded: workerAgentLoaded === 'true',
    inbox_worker_disabled: workerAgentDisabled === 'true',
    inbox_worker_plist_current: workerPlistCurrent === 'true',
    inbox_worker_operational:
      workerAgentLoaded === 'true' && workerAgentDisabled !== 'true' && workerPlistCurrent === 'true',
    inbox_worker_plist: workerPlist,
    autonomy_keepalive_label: keepaliveLabel,
    autonomy_keepalive_loaded: keepaliveAgentLoaded === 'true',
    autonomy_keepalive_disabled: keepaliveAgentDisabled === 'true',
    autonomy_keepalive_plist_current: keepalivePlistCurrent === 'true',
    autonomy_keepalive_operational:
      keepaliveAgentLoaded === 'true' &&
      keepaliveAgentDisabled !== 'true' &&
      keepalivePlistCurrent === 'true',
    autonomy_keepalive_plist: keepalivePlist,
    local_adapter_watchdog_label: watchdogLabel,
    local_adapter_watchdog_loaded: watchdogAgentLoaded === 'true',
    local_adapter_watchdog_disabled: watchdogAgentDisabled === 'true',
    local_adapter_watchdog_plist_current: watchdogPlistCurrent === 'true',
    local_adapter_watchdog_operational:
      watchdogAgentLoaded === 'true' &&
      watchdogAgentDisabled !== 'true' &&
      watchdogPlistCurrent === 'true',
    local_adapter_watchdog_plist: watchdogPlist,
    agent_office_gui_label: officeGuiLabel,
    agent_office_gui_loaded: officeGuiAgentLoaded === 'true',
    agent_office_gui_disabled: officeGuiAgentDisabled === 'true',
    agent_office_gui_plist_current: officeGuiPlistCurrent === 'true',
    agent_office_gui_operational:
      officeGuiAgentLoaded === 'true' &&
      officeGuiAgentDisabled !== 'true' &&
      officeGuiPlistCurrent === 'true',
    agent_office_gui_plist: officeGuiPlist,
    mlx_label: mlxLabel,
    mlx_loaded: mlxAgentLoaded === 'true',
    mlx_disabled: mlxAgentDisabled === 'true',
    mlx_plist_current: mlxPlistCurrent === 'true',
    mlx_operational: mlxAgentLoaded === 'true' && mlxAgentDisabled !== 'true' && mlxPlistCurrent === 'true',
    mlx_plist: mlxPlist,
  },
  auto_snapshot_runtime: autoSnapshotStatus,
  autonomy_runtime: autonomyStatus,
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE
