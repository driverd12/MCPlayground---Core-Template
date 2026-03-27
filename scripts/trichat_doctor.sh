#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

need_cmd() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || {
    echo "missing required command: ${name}" >&2
    exit 2
  }
}

need_cmd node
need_cmd npm
need_cmd python3
need_cmd curl

echo "[doctor] repo: ${REPO_ROOT}"
echo "[doctor] node: $(node -v)"
echo "[doctor] npm: $(npm -v)"
echo "[doctor] python: $(python3 --version 2>&1)"

python3 -m py_compile scripts/trichat.py
echo "[doctor] python launcher: syntax ok"

if command -v ollama >/dev/null 2>&1; then
  echo "[doctor] ollama: $(ollama --version)"
  curl -fsS "${TRICHAT_OLLAMA_URL:-http://127.0.0.1:11434}/api/tags" >/dev/null
  echo "[doctor] ollama api: reachable"
else
  echo "[doctor] ollama: not installed" >&2
  exit 2
fi

echo "[doctor] effective roster:"
node ./scripts/trichat_roster.mjs

echo "[doctor] launchd status:"
./scripts/agents_switch.sh status

echo "[doctor] ring leader status:"
./scripts/ring_leader_ctl.sh status

echo "[doctor] active agent sessions:"
node ./scripts/mcp_tool_call.mjs \
  --tool agent.session_list \
  --args '{"active_only":true,"limit":20}' \
  --transport stdio \
  --stdio-command node \
  --stdio-args dist/server.js \
  --cwd "${REPO_ROOT}"

echo "[doctor] kernel summary:"
node ./scripts/mcp_tool_call.mjs \
  --tool kernel.summary \
  --args '{"session_limit":10,"event_limit":10}' \
  --transport stdio \
  --stdio-command node \
  --stdio-args dist/server.js \
  --cwd "${REPO_ROOT}"

echo "[doctor] mcp stdio roster tool:"
node ./scripts/mcp_tool_call.mjs \
  --tool trichat.roster \
  --args '{}' \
  --transport stdio \
  --stdio-command node \
  --stdio-args dist/server.js \
  --cwd "${REPO_ROOT}" >/dev/null
echo "[doctor] mcp stdio: ok"

echo "[doctor] adapter protocol check (dry-run):"
node ./scripts/mcp_tool_call.mjs \
  --tool trichat.adapter_protocol_check \
  --args '{"run_ask_check":true,"ask_dry_run":true}' \
  --transport stdio \
  --stdio-command node \
  --stdio-args dist/server.js \
  --cwd "${REPO_ROOT}"

echo "[doctor] adapter telemetry:"
node ./scripts/mcp_tool_call.mjs \
  --tool trichat.adapter_telemetry \
  --args '{"action":"status","include_events":false}' \
  --transport stdio \
  --stdio-command node \
  --stdio-args dist/server.js \
  --cwd "${REPO_ROOT}"
