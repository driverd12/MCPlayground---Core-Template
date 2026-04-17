#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${REPO_ROOT}/data/imprint/logs"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.mcplayground.mcp.server"
AUTO_LABEL="com.mcplayground.imprint.autosnapshot"
WORKER_LABEL="com.mcplayground.imprint.inboxworker"
KEEPALIVE_LABEL="com.mcplayground.autonomy.keepalive"
WATCHDOG_LABEL="com.mcplayground.local-adapter.watchdog"
OFFICE_GUI_LABEL="com.mcplayground.agent-office.gui.watch"
MLX_LABEL="com.mcplayground.mlx.server"

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"
KEEPALIVE_PLIST="${LAUNCH_DIR}/${KEEPALIVE_LABEL}.plist"
WATCHDOG_PLIST="${LAUNCH_DIR}/${WATCHDOG_LABEL}.plist"
OFFICE_GUI_PLIST="${LAUNCH_DIR}/${OFFICE_GUI_LABEL}.plist"
MLX_PLIST="${LAUNCH_DIR}/${MLX_LABEL}.plist"
LEGACY_BUS_SOCKET_PATH="${REPO_ROOT}/data/trichat.bus.sock"
BUS_SOCKET_DIGEST="$(printf '%s' "${REPO_ROOT}" | shasum -a 256 | cut -c1-12)"
if [[ "${OSTYPE:-}" == darwin* ]]; then
  BUS_SOCKET_DEFAULT="${HOME}/Library/Caches/mcplayground/trichat-${BUS_SOCKET_DIGEST}.sock"
else
  BUS_SOCKET_DEFAULT="${HOME}/.cache/mcplayground/trichat-${BUS_SOCKET_DIGEST}.sock"
fi
if [[ ${#LEGACY_BUS_SOCKET_PATH} -lt 100 ]]; then
  BUS_SOCKET_DEFAULT="${LEGACY_BUS_SOCKET_PATH}"
fi
BUS_SOCKET_PATH="${TRICHAT_BUS_SOCKET_PATH:-${BUS_SOCKET_DEFAULT}}"

MCP_PORT="${MCP_HTTP_PORT:-${ANAMNESIS_MCP_HTTP_PORT:-8787}}"
MCP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
ALLOWED_ORIGINS="${MCP_HTTP_ALLOWED_ORIGINS:-http://localhost,http://127.0.0.1}"
INBOX_POLL_INTERVAL="${ANAMNESIS_INBOX_POLL_INTERVAL:-5}"
INBOX_BATCH_SIZE="${ANAMNESIS_INBOX_BATCH_SIZE:-3}"
INBOX_LEASE_SECONDS="${ANAMNESIS_INBOX_LEASE_SECONDS:-300}"
INBOX_HEARTBEAT_INTERVAL="${ANAMNESIS_INBOX_HEARTBEAT_INTERVAL:-30}"
AUTONOMY_KEEPALIVE_INTERVAL="${AUTONOMY_KEEPALIVE_INTERVAL_SECONDS:-120}"
LOCAL_ADAPTER_WATCHDOG_INTERVAL="${LOCAL_ADAPTER_WATCHDOG_INTERVAL_SECONDS:-1800}"
LOCAL_ADAPTER_WATCHDOG_MAX_AGE="${LOCAL_ADAPTER_WATCHDOG_MAX_SOAK_AGE_MINUTES:-240}"
LOCAL_ADAPTER_WATCHDOG_SOAK_CYCLES="${LOCAL_ADAPTER_WATCHDOG_SOAK_CYCLES:-1}"
LOCAL_ADAPTER_WATCHDOG_SOAK_INTERVAL="${LOCAL_ADAPTER_WATCHDOG_SOAK_INTERVAL_SECONDS:-0}"
AGENT_OFFICE_GUI_WATCH_INTERVAL_MS="${AGENT_OFFICE_GUI_WATCH_INTERVAL_MS:-10000}"
MLX_SERVER_ENABLED="${TRICHAT_MLX_SERVER_ENABLED:-0}"
MLX_ENDPOINT="${TRICHAT_MLX_ENDPOINT:-http://127.0.0.1:8788}"
MLX_PORT="${MLX_ENDPOINT##*:}"
MLX_HOST="${MLX_ENDPOINT%:${MLX_PORT}}"
MLX_HOST="${MLX_HOST#http://}"
MLX_HOST="${MLX_HOST#https://}"
MLX_PYTHON="${TRICHAT_MLX_PYTHON:-}"
MLX_MODEL="${TRICHAT_MLX_MODEL:-}"
MLX_ADAPTER_PATH="${TRICHAT_MLX_ADAPTER_PATH:-}"
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found in PATH" >&2
  exit 2
fi
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "error: python3 not found in PATH" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl not found in PATH" >&2
  exit 2
fi

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
HTTP_BEARER_TOKEN="${MCP_HTTP_BEARER_TOKEN:-${ANAMNESIS_MCP_HTTP_BEARER_TOKEN:-}}"
if [[ -z "${HTTP_BEARER_TOKEN}" && -f "${TOKEN_FILE}" ]]; then
  HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi
if [[ -z "${HTTP_BEARER_TOKEN}" ]]; then
  HTTP_BEARER_TOKEN="$(${PYTHON_BIN} - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
)"
fi
mkdir -p "$(dirname "${TOKEN_FILE}")"
printf '%s' "${HTTP_BEARER_TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}" >/dev/null 2>&1 || true

mkdir -p "${LAUNCH_DIR}" "${LOG_DIR}" "$(dirname "${BUS_SOCKET_PATH}")"

bootout_service_target() {
  local label="$1"
  launchctl bootout "${DOMAIN}/${label}" >/dev/null 2>&1 || true
}

reset_launch_agent() {
  local plist="$1"
  local label="$2"
  launchctl enable "${DOMAIN}/${label}" >/dev/null 2>&1 || true
  if [[ -f "${plist}" ]]; then
    launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
  # Clear stale launchctl entries keyed only by service label so bootstrap can rebind cleanly after restarts.
  bootout_service_target "${label}"
}

wait_for_mcp_http() {
  local url="http://${MCP_HOST}:${MCP_PORT}/health"
  local deadline=$((SECONDS + 30))
  local health_json=""

  while (( SECONDS < deadline )); do
    health_json="$(curl -fsS --connect-timeout 1 --max-time 2 \
      -H "Authorization: Bearer ${HTTP_BEARER_TOKEN}" \
      -H "Origin: http://127.0.0.1" \
      "${url}" 2>/dev/null || true)"
    if [[ -n "${health_json}" ]] && HEALTH_JSON="${health_json}" "${PYTHON_BIN}" - <<'PY'
import json, os, sys
payload = json.loads(os.environ["HEALTH_JSON"])
sys.exit(0 if payload.get("ok") or payload.get("status") == "ok" else 1)
PY
    then
      return 0
    fi
    sleep 1
  done

  echo "error: MCP HTTP daemon did not become healthy after launchd restart" >&2
  if [[ -f "${LOG_DIR}/mcp-http.err.log" ]]; then
    echo "--- mcp-http.err.log (tail) ---" >&2
    tail -n 50 "${LOG_DIR}/mcp-http.err.log" >&2 || true
  fi
  if [[ -f "${LOG_DIR}/mcp-http.out.log" ]]; then
    echo "--- mcp-http.out.log (tail) ---" >&2
    tail -n 50 "${LOG_DIR}/mcp-http.out.log" >&2 || true
  fi
  return 1
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

if command -v lsof >/dev/null 2>&1; then
  PORT_PIDS="$(lsof -tiTCP:${MCP_PORT} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${PORT_PIDS}" ]]; then
    while IFS= read -r pid; do
      terminate_repo_listener "${pid}"
    done <<< "${PORT_PIDS}"
  fi
fi

cat >"${MCP_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MCP_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/mcp_http_runner.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>MCP_HTTP</key>
      <string>1</string>
      <key>MCP_HTTP_HOST</key>
      <string>${MCP_HOST}</string>
      <key>MCP_HTTP_PORT</key>
      <string>${MCP_PORT}</string>
      <key>MCP_HTTP_ALLOWED_ORIGINS</key>
      <string>${ALLOWED_ORIGINS}</string>
      <key>MCP_HTTP_BEARER_TOKEN</key>
      <string>${HTTP_BEARER_TOKEN}</string>
      <key>TRICHAT_BUS_SOCKET_PATH</key>
      <string>${BUS_SOCKET_PATH}</string>
      <key>MCP_AUTONOMY_BOOTSTRAP_ON_START</key>
      <string>1</string>
      <key>MCP_AUTONOMY_MAINTAIN_ON_START</key>
      <string>1</string>
      <key>MCP_AUTONOMY_MAINTAIN_RUN_IMMEDIATELY_ON_START</key>
      <string>0</string>
      <key>PATH</key>
      <string>${PATH}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/mcp-http.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/mcp-http.err.log</string>
  </dict>
</plist>
PLIST

cat >"${AUTO_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AUTO_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/imprint_auto_snapshot_runner.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/imprint-auto.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/imprint-auto.err.log</string>
  </dict>
</plist>
PLIST

cat >"${WORKER_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WORKER_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/imprint_inbox_worker_runner.mjs</string>
      <string>--repo-root</string>
      <string>${REPO_ROOT}</string>
      <string>--poll-interval</string>
      <string>${INBOX_POLL_INTERVAL}</string>
      <string>--batch-size</string>
      <string>${INBOX_BATCH_SIZE}</string>
      <string>--lease-seconds</string>
      <string>${INBOX_LEASE_SECONDS}</string>
      <string>--heartbeat-interval</string>
      <string>${INBOX_HEARTBEAT_INTERVAL}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
      <key>PYTHONUNBUFFERED</key>
      <string>1</string>
      <key>ANAMNESIS_IMPRINT_PROFILE_ID</key>
      <string>${ANAMNESIS_IMPRINT_PROFILE_ID:-default}</string>
      <key>ANAMNESIS_INBOX_MCP_TRANSPORT</key>
      <string>http</string>
      <key>ANAMNESIS_INBOX_MCP_URL</key>
      <string>http://127.0.0.1:${MCP_HTTP_PORT:-8787}/</string>
      <key>ANAMNESIS_INBOX_MCP_ORIGIN</key>
      <string>http://127.0.0.1</string>
      <key>MCP_HTTP_BEARER_TOKEN</key>
      <string>${HTTP_BEARER_TOKEN}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/inbox-worker.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/inbox-worker.err.log</string>
  </dict>
</plist>
PLIST

cat >"${KEEPALIVE_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${KEEPALIVE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/autonomy_keepalive_runner.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
    <key>PATH</key>
      <string>${PATH}</string>
      <key>MCP_HTTP_BEARER_TOKEN</key>
      <string>${HTTP_BEARER_TOKEN}</string>
      <key>AUTONOMY_BOOTSTRAP_TRANSPORT</key>
      <string>http</string>
      <key>AUTONOMY_KEEPALIVE_HTTP_READY_TIMEOUT_MS</key>
      <string>60000</string>
      <key>AUTONOMY_KEEPALIVE_TOOL_TIMEOUT_MS</key>
      <string>180000</string>
      <key>TRICHAT_MCP_URL</key>
      <string>http://127.0.0.1:${MCP_HTTP_PORT:-8787}/</string>
      <key>TRICHAT_MCP_ORIGIN</key>
      <string>http://127.0.0.1</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>${AUTONOMY_KEEPALIVE_INTERVAL}</integer>

    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/autonomy-keepalive.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/autonomy-keepalive.err.log</string>
  </dict>
</plist>
PLIST

cat >"${WATCHDOG_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WATCHDOG_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/local_adapter_watchdog.mjs</string>
      <string>--transport</string>
      <string>http</string>
      <string>--max-soak-age-minutes</string>
      <string>${LOCAL_ADAPTER_WATCHDOG_MAX_AGE}</string>
      <string>--cycles</string>
      <string>${LOCAL_ADAPTER_WATCHDOG_SOAK_CYCLES}</string>
      <string>--interval-seconds</string>
      <string>${LOCAL_ADAPTER_WATCHDOG_SOAK_INTERVAL}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
      <key>MCP_HTTP_BEARER_TOKEN</key>
      <string>${HTTP_BEARER_TOKEN}</string>
      <key>TRICHAT_MCP_URL</key>
      <string>http://127.0.0.1:${MCP_HTTP_PORT:-8787}/</string>
      <key>TRICHAT_MCP_ORIGIN</key>
      <string>http://127.0.0.1</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>${LOCAL_ADAPTER_WATCHDOG_INTERVAL}</integer>

    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/local-adapter-watchdog.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/local-adapter-watchdog.err.log</string>
  </dict>
</plist>
PLIST

cat >"${OFFICE_GUI_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${OFFICE_GUI_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/agent_office_gui.mjs</string>
      <string>watch</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
      <key>MCP_HTTP_BEARER_TOKEN</key>
      <string>${HTTP_BEARER_TOKEN}</string>
      <key>MCP_HTTP_HOST</key>
      <string>${MCP_HOST}</string>
      <key>MCP_HTTP_PORT</key>
      <string>${MCP_PORT}</string>
      <key>TRICHAT_MCP_URL</key>
      <string>http://${MCP_HOST}:${MCP_PORT}/</string>
      <key>TRICHAT_MCP_ORIGIN</key>
      <string>http://127.0.0.1</string>
      <key>AGENT_OFFICE_GUI_WATCH_INTERVAL_MS</key>
      <string>${AGENT_OFFICE_GUI_WATCH_INTERVAL_MS}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/agent-office-gui.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/agent-office-gui.err.log</string>
  </dict>
</plist>
PLIST

if [[ "${MLX_SERVER_ENABLED}" == "1" && -n "${MLX_PYTHON}" && -n "${MLX_MODEL}" ]]; then
MLX_ADAPTER_ARGUMENTS=""
if [[ -n "${MLX_ADAPTER_PATH}" ]]; then
  MLX_ADAPTER_ARGUMENTS="
      <string>--adapter-path</string>
      <string>${MLX_ADAPTER_PATH}</string>"
fi
cat >"${MLX_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MLX_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${MLX_PYTHON}</string>
      <string>-m</string>
      <string>mlx_lm.server</string>
      <string>--model</string>
      <string>${MLX_MODEL}</string>
${MLX_ADAPTER_ARGUMENTS}
      <string>--host</string>
      <string>${MLX_HOST}</string>
      <string>--port</string>
      <string>${MLX_PORT}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
      <key>PYTHONUNBUFFERED</key>
      <string>1</string>
      <key>HF_HUB_DISABLE_TELEMETRY</key>
      <string>1</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/mlx-server.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/mlx-server.err.log</string>
  </dict>
</plist>
PLIST
else
  reset_launch_agent "${MLX_PLIST}" "${MLX_LABEL}"
  launchctl disable "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
  rm -f "${MLX_PLIST}" >/dev/null 2>&1 || true
fi

chmod 644 "${MCP_PLIST}" "${AUTO_PLIST}" "${WORKER_PLIST}" "${KEEPALIVE_PLIST}" "${WATCHDOG_PLIST}"
chmod 644 "${OFFICE_GUI_PLIST}"
if [[ -f "${MLX_PLIST}" ]]; then
  chmod 644 "${MLX_PLIST}"
fi

npm run build >/dev/null

reset_launch_agent "${MCP_PLIST}" "${MCP_LABEL}"
reset_launch_agent "${AUTO_PLIST}" "${AUTO_LABEL}"
reset_launch_agent "${WORKER_PLIST}" "${WORKER_LABEL}"
reset_launch_agent "${KEEPALIVE_PLIST}" "${KEEPALIVE_LABEL}"
reset_launch_agent "${WATCHDOG_PLIST}" "${WATCHDOG_LABEL}"
reset_launch_agent "${OFFICE_GUI_PLIST}" "${OFFICE_GUI_LABEL}"
if [[ -f "${MLX_PLIST}" ]]; then
  reset_launch_agent "${MLX_PLIST}" "${MLX_LABEL}"
fi

launchctl bootstrap "${DOMAIN}" "${MCP_PLIST}"
launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
wait_for_mcp_http

launchctl bootstrap "${DOMAIN}" "${AUTO_PLIST}"
launchctl bootstrap "${DOMAIN}" "${WORKER_PLIST}"
launchctl bootstrap "${DOMAIN}" "${KEEPALIVE_PLIST}"
launchctl bootstrap "${DOMAIN}" "${WATCHDOG_PLIST}"
launchctl bootstrap "${DOMAIN}" "${OFFICE_GUI_PLIST}"
if [[ -f "${MLX_PLIST}" ]]; then
  launchctl bootstrap "${DOMAIN}" "${MLX_PLIST}"
fi

launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${OFFICE_GUI_LABEL}" >/dev/null 2>&1 || true
if [[ -f "${MLX_PLIST}" ]]; then
  launchctl enable "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
fi

launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${OFFICE_GUI_LABEL}" >/dev/null 2>&1 || true
if [[ -f "${MLX_PLIST}" ]]; then
  launchctl kickstart -k "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
fi

echo "Installed launchd agents:" >&2
echo "- ${MCP_PLIST}" >&2
echo "- ${AUTO_PLIST}" >&2
echo "- ${WORKER_PLIST}" >&2
echo "- ${KEEPALIVE_PLIST}" >&2
echo "- ${WATCHDOG_PLIST}" >&2
echo "- ${OFFICE_GUI_PLIST}" >&2
if [[ -f "${MLX_PLIST}" ]]; then
echo "- ${MLX_PLIST}" >&2
fi

echo "{" >&2
echo "  \"ok\": true," >&2
echo "  \"domain\": \"${DOMAIN}\"," >&2
echo "  \"mcp_label\": \"${MCP_LABEL}\"," >&2
echo "  \"auto_snapshot_label\": \"${AUTO_LABEL}\"," >&2
echo "  \"worker_label\": \"${WORKER_LABEL}\"," >&2
echo "  \"keepalive_label\": \"${KEEPALIVE_LABEL}\"," >&2
echo "  \"watchdog_label\": \"${WATCHDOG_LABEL}\"," >&2
echo "  \"office_gui_label\": \"${OFFICE_GUI_LABEL}\"," >&2
echo "  \"mlx_label\": \"${MLX_LABEL}\"," >&2
echo "  \"mcp_port\": ${MCP_PORT}," >&2
echo "  \"http_token_file\": \"${TOKEN_FILE}\"" >&2
echo "}" >&2
