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

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

TRICHAT_HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
TRICHAT_HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
TRICHAT_STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
TRICHAT_STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"
MCP_TOOL_CALL_TIMEOUT_MS="${MCP_TOOL_CALL_TIMEOUT_MS:-15000}"

resolve_transport() {
  local preferred="${TRICHAT_RING_LEADER_TRANSPORT:-}"
  if [[ -n "${preferred}" ]]; then
    printf '%s\n' "${preferred}"
    return 0
  fi
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    if curl -fsS \
      -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
      -H "Origin: ${TRICHAT_HTTP_ORIGIN}" \
      "${TRICHAT_HTTP_URL%/}/health" >/dev/null 2>&1; then
      printf 'http\n'
      return 0
    fi
  fi
  printf 'stdio\n'
}

MCP_TRANSPORT="$(resolve_transport)"

call_mcp() {
  local tool="$1"
  local args="${2:-\{\}}"
  MCP_TOOL_CALL_TIMEOUT_MS="${MCP_TOOL_CALL_TIMEOUT_MS}" node ./scripts/mcp_tool_call.mjs \
    --tool "${tool}" \
    --args "${args}" \
    --transport "${MCP_TRANSPORT}" \
    --url "${TRICHAT_HTTP_URL}" \
    --origin "${TRICHAT_HTTP_ORIGIN}" \
    --stdio-command "${TRICHAT_STDIO_COMMAND}" \
    --stdio-args "${TRICHAT_STDIO_ARGS}" \
    --cwd "${REPO_ROOT}"
}

echo "[doctor] repo: ${REPO_ROOT}"
echo "[doctor] node: $(node -v)"
echo "[doctor] npm: $(npm -v)"
echo "[doctor] python: $(python3 --version 2>&1)"
echo "[doctor] mcp transport: ${MCP_TRANSPORT}"

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

echo "[doctor] autonomy bootstrap status:"
AUTONOMY_STATUS="$(call_mcp autonomy.bootstrap '{"action":"status"}')"
printf '%s\n' "${AUTONOMY_STATUS}"
python3 - "${AUTONOMY_STATUS}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
if not data.get("self_start_ready"):
    raise SystemExit(
        "autonomy bootstrap is not self-start ready: "
        + ",".join(data.get("repairs_needed", []))
    )
PY

echo "[doctor] autonomy maintain status:"
AUTONOMY_MAINTAIN_STATUS="$(call_mcp autonomy.maintain '{"action":"status"}')"
printf '%s\n' "${AUTONOMY_MAINTAIN_STATUS}"
python3 - "${AUTONOMY_MAINTAIN_STATUS}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
runtime = data.get("runtime") or {}
eval_health = data.get("eval_health") or {}
if not runtime.get("running"):
    raise SystemExit("autonomy maintain runtime is not running")
if runtime.get("last_error"):
    raise SystemExit(f"autonomy maintain runtime last_error: {runtime.get('last_error')}")
if not eval_health.get("healthy"):
    raise SystemExit(
        "autonomy maintain eval health is not healthy: "
        + json.dumps(
            {
                "due": (data.get("due") or {}).get("eval"),
                "last_eval_score": eval_health.get("last_eval_score"),
                "minimum_eval_score": eval_health.get("minimum_eval_score"),
            }
        )
    )
PY

echo "[doctor] ring leader status:"
./scripts/ring_leader_ctl.sh status

echo "[doctor] active agent sessions:"
call_mcp agent.session_list '{"active_only":true,"limit":20}'

echo "[doctor] kernel summary:"
call_mcp kernel.summary '{"session_limit":10,"event_limit":10}'

echo "[doctor] mcp stdio roster tool:"
call_mcp trichat.roster '{}' >/dev/null
echo "[doctor] mcp roster: ok"

echo "[doctor] adapter protocol check (dry-run):"
call_mcp trichat.adapter_protocol_check '{"run_ask_check":true,"ask_dry_run":true}'

echo "[doctor] adapter telemetry:"
call_mcp trichat.adapter_telemetry '{"action":"status","include_events":false}'
