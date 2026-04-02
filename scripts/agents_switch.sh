#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
MCP_PORT="${MCP_HTTP_PORT:-${ANAMNESIS_MCP_HTTP_PORT:-8787}}"
HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:${MCP_PORT}/}"
HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"

MCP_LABEL="com.mcplayground.mcp.server"
AUTO_LABEL="com.mcplayground.imprint.autosnapshot"
WORKER_LABEL="com.mcplayground.imprint.inboxworker"
KEEPALIVE_LABEL="com.mcplayground.autonomy.keepalive"
MLX_LABEL="com.mcplayground.mlx.server"
MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"
KEEPALIVE_PLIST="${LAUNCH_DIR}/${KEEPALIVE_LABEL}.plist"
MLX_PLIST="${LAUNCH_DIR}/${MLX_LABEL}.plist"
GUI_FALLBACK_SESSION="mcplayground-http"
TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

is_loaded() {
  local label="$1"
  launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1
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

bootout_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
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

wait_for_mcp_ready() {
  [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]] || return 1
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if curl -fsS --connect-timeout 1 --max-time 4 \
      -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
      -H "Origin: ${HTTP_ORIGIN}" \
      "${HTTP_URL%/}/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

case "${ACTION}" in
  on)
    if [[ ! -f "${MCP_PLIST}" || ! -f "${AUTO_PLIST}" || ! -f "${WORKER_PLIST}" || ! -f "${KEEPALIVE_PLIST}" || ( "${TRICHAT_MLX_SERVER_ENABLED:-0}" == "1" && ! -f "${MLX_PLIST}" ) ]]; then
      "${REPO_ROOT}/scripts/launchd_install.sh"
    else
      launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
      if [[ -f "${MLX_PLIST}" ]]; then
        launchctl enable "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
      fi
      bootout_if_exists "${MCP_PLIST}"
      bootout_if_exists "${AUTO_PLIST}"
      bootout_if_exists "${WORKER_PLIST}"
      bootout_if_exists "${KEEPALIVE_PLIST}"
      bootout_if_exists "${MLX_PLIST}"
      clear_repo_http_runtime
      bootstrap_if_exists "${MCP_PLIST}"
      launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      wait_for_mcp_ready
      bootstrap_if_exists "${AUTO_PLIST}"
      bootstrap_if_exists "${WORKER_PLIST}"
      bootstrap_if_exists "${KEEPALIVE_PLIST}"
      bootstrap_if_exists "${MLX_PLIST}"
      launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
      if [[ -f "${MLX_PLIST}" ]]; then
        launchctl kickstart -k "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
      fi
    fi
    ;;
  off)
    "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true
    bootout_if_exists "${KEEPALIVE_PLIST}"
    bootout_if_exists "${WORKER_PLIST}"
    bootout_if_exists "${AUTO_PLIST}"
    bootout_if_exists "${MCP_PLIST}"
    bootout_if_exists "${MLX_PLIST}"
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
MLX_AGENT_LOADED=false
if is_loaded "${MCP_LABEL}"; then MCP_RUNNING=true; fi
if is_loaded "${AUTO_LABEL}"; then AUTO_AGENT_LOADED=true; fi
if is_loaded "${WORKER_LABEL}"; then WORKER_AGENT_LOADED=true; fi
if is_loaded "${KEEPALIVE_LABEL}"; then KEEPALIVE_AGENT_LOADED=true; fi
if is_loaded "${MLX_LABEL}"; then MLX_AGENT_LOADED=true; fi

AUTO_SNAPSHOT_STATUS="{}"
AUTONOMY_STATUS="{}"
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

node --input-type=module - <<'NODE' \
"${ACTION}" \
"${DOMAIN}" \
"${MCP_LABEL}" \
"${AUTO_LABEL}" \
"${MCP_RUNNING}" \
"${AUTO_AGENT_LOADED}" \
"${WORKER_LABEL}" \
"${WORKER_AGENT_LOADED}" \
"${KEEPALIVE_LABEL}" \
"${KEEPALIVE_AGENT_LOADED}" \
"${MLX_LABEL}" \
"${MLX_AGENT_LOADED}" \
"${MCP_PLIST}" \
"${AUTO_PLIST}" \
"${WORKER_PLIST}" \
"${KEEPALIVE_PLIST}" \
"${MLX_PLIST}" \
"${AUTO_SNAPSHOT_STATUS}" \
"${AUTONOMY_STATUS}"
const [
  action,
  domain,
  mcpLabel,
  autoLabel,
  mcpRunning,
  autoAgentLoaded,
  workerLabel,
  workerAgentLoaded,
  keepaliveLabel,
  keepaliveAgentLoaded,
  mlxLabel,
  mlxAgentLoaded,
  mcpPlist,
  autoPlist,
  workerPlist,
  keepalivePlist,
  mlxPlist,
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
    mcp_server: mcpRunning === 'true',
    auto_snapshot: autoAgentLoaded === 'true',
    inbox_worker: workerAgentLoaded === 'true',
    autonomy_keepalive: keepaliveAgentLoaded === 'true',
    mlx_server: mlxAgentLoaded === 'true',
  },
  launchd: {
    mcp_label: mcpLabel,
    mcp_loaded: mcpRunning === 'true',
    mcp_plist: mcpPlist,
    auto_snapshot_label: autoLabel,
    auto_snapshot_agent_loaded: autoAgentLoaded === 'true',
    auto_snapshot_plist: autoPlist,
    inbox_worker_label: workerLabel,
    inbox_worker_loaded: workerAgentLoaded === 'true',
    inbox_worker_plist: workerPlist,
    autonomy_keepalive_label: keepaliveLabel,
    autonomy_keepalive_loaded: keepaliveAgentLoaded === 'true',
    autonomy_keepalive_plist: keepalivePlist,
    mlx_label: mlxLabel,
    mlx_loaded: mlxAgentLoaded === 'true',
    mlx_plist: mlxPlist,
  },
  auto_snapshot_runtime: autoSnapshotStatus,
  autonomy_runtime: autonomyStatus,
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE
