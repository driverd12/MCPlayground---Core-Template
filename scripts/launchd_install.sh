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

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"

MCP_PORT="${MCP_HTTP_PORT:-${ANAMNESIS_MCP_HTTP_PORT:-8787}}"
MCP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
ALLOWED_ORIGINS="${MCP_HTTP_ALLOWED_ORIGINS:-http://localhost,http://127.0.0.1}"
INBOX_POLL_INTERVAL="${ANAMNESIS_INBOX_POLL_INTERVAL:-5}"
INBOX_BATCH_SIZE="${ANAMNESIS_INBOX_BATCH_SIZE:-3}"
INBOX_LEASE_SECONDS="${ANAMNESIS_INBOX_LEASE_SECONDS:-300}"
INBOX_HEARTBEAT_INTERVAL="${ANAMNESIS_INBOX_HEARTBEAT_INTERVAL:-30}"
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

mkdir -p "${LAUNCH_DIR}" "${LOG_DIR}"

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
      <string>${REPO_ROOT}/dist/server.js</string>
      <string>--http</string>
      <string>--http-port</string>
      <string>${MCP_PORT}</string>
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
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd ${REPO_ROOT} &amp;&amp; ./scripts/imprint_auto_snapshot_ctl.sh start</string>
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
      <string>${PYTHON_BIN}</string>
      <string>${REPO_ROOT}/scripts/imprint_inbox_worker.py</string>
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

chmod 644 "${MCP_PLIST}" "${AUTO_PLIST}" "${WORKER_PLIST}"

npm run build >/dev/null

launchctl bootout "${DOMAIN}" "${MCP_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}" "${AUTO_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}" "${WORKER_PLIST}" >/dev/null 2>&1 || true

launchctl bootstrap "${DOMAIN}" "${MCP_PLIST}"
launchctl bootstrap "${DOMAIN}" "${AUTO_PLIST}"
launchctl bootstrap "${DOMAIN}" "${WORKER_PLIST}"

launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true

launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true

for _ in 1 2 3 4 5; do
  if "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" start >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if [[ "${TRICHAT_RING_LEADER_AUTOSTART:-1}" != "0" ]]; then
  for _ in 1 2 3 4 5; do
    if "${REPO_ROOT}/scripts/ring_leader_ctl.sh" start >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
fi

echo "Installed launchd agents:" >&2
echo "- ${MCP_PLIST}" >&2
echo "- ${AUTO_PLIST}" >&2
echo "- ${WORKER_PLIST}" >&2

echo "{" >&2
echo "  \"ok\": true," >&2
echo "  \"domain\": \"${DOMAIN}\"," >&2
echo "  \"mcp_label\": \"${MCP_LABEL}\"," >&2
echo "  \"auto_snapshot_label\": \"${AUTO_LABEL}\"," >&2
echo "  \"worker_label\": \"${WORKER_LABEL}\"," >&2
echo "  \"mcp_port\": ${MCP_PORT}," >&2
echo "  \"http_token_file\": \"${TOKEN_FILE}\"" >&2
echo "}" >&2
