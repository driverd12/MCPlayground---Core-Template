#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-open}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TRICHAT_HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
TRICHAT_HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
MCP_PORT="${MCP_HTTP_PORT:-8787}"
GUI_URL="${TRICHAT_HTTP_URL%/}/office/"
FALLBACK_SESSION="mcplayground-http"
TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

health_ok() {
  curl -fsS --max-time 3 "${TRICHAT_HTTP_URL%/}/health" >/dev/null 2>&1
}

listener_ok() {
  lsof -nP -iTCP:"${MCP_PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

ready_ok() {
  [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]] || return 1
  curl -fsS --max-time 8 \
    -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
    -H "Origin: ${TRICHAT_HTTP_ORIGIN}" \
    "${TRICHAT_HTTP_URL%/}/ready" >/dev/null 2>&1
}

start_via_launchd() {
  "${REPO_ROOT}/scripts/agents_switch.sh" on >/dev/null 2>&1 || true
}

start_via_tmux_fallback() {
  tmux kill-session -t "${FALLBACK_SESSION}" >/dev/null 2>&1 || true
  tmux new-session -d -s "${FALLBACK_SESSION}" \
    "cd \"${REPO_ROOT}\" && /opt/homebrew/bin/node dist/server.js --http --http-port ${MCP_PORT} >> data/imprint/logs/mcp-http.out.log 2>> data/imprint/logs/mcp-http.err.log"
}

stop_tmux_fallback() {
  tmux kill-session -t "${FALLBACK_SESSION}" >/dev/null 2>&1 || true
}

ensure_http() {
  local attempt
  if ready_ok; then
    return 0
  fi

  start_via_launchd
  for attempt in 1 2 3 4 5 6; do
    if ready_ok; then
      stop_tmux_fallback
      return 0
    fi
    sleep 2
  done

  start_via_tmux_fallback
  for attempt in 1 2 3 4 5 6; do
    if ready_ok; then
      return 0
    fi
    sleep 2
  done
  return 1
}

print_status() {
  local health="false"
  local listener="false"
  local ready="false"
  local mode="down"
  if health_ok; then
    health="true"
  fi
  if listener_ok; then
    listener="true"
  fi
  if ready_ok; then
    ready="true"
    health="true"
  fi
  if [[ "${ready}" == "true" ]]; then
    if tmux has-session -t "${FALLBACK_SESSION}" >/dev/null 2>&1; then
      mode="tmux"
    else
      mode="launchd"
    fi
  elif [[ "${health}" == "true" ]]; then
    mode="warming"
  elif [[ "${listener}" == "true" ]]; then
    mode="busy"
  fi
  node --input-type=module - <<'NODE' "${GUI_URL}" "${mode}" "${health}" "${listener}" "${ready}"
const [url, mode, health, listener, ready] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: ready === "true" || listener === "true",
      mode,
      health: health === "true",
      listener: listener === "true",
      ready: ready === "true",
      url,
    },
    null,
    2
  )}\n`
);
NODE
}

case "${ACTION}" in
  start)
    if ensure_http; then
      echo "Agent Office ready at ${GUI_URL}"
    else
      echo "Agent Office failed to reach ready state. Run '${REPO_ROOT}/scripts/agent_office_gui.sh status'." >&2
      exit 1
    fi
    ;;
  open)
    if ensure_http; then
      echo "Opening Agent Office at ${GUI_URL}"
      open "${GUI_URL}"
    else
      echo "Agent Office failed to reach ready state. Start it with '${REPO_ROOT}/scripts/agent_office_gui.sh start' and inspect status." >&2
      exit 1
    fi
    ;;
  status)
    print_status
    ;;
  *)
    echo "usage: $0 [open|start|status]" >&2
    exit 2
    ;;
esac
