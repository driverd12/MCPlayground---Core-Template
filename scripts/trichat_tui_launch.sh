#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSPORT=""
PASSTHROUGH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --transport)
      [[ $# -ge 2 ]] || {
        echo "error: --transport requires stdio or http" >&2
        exit 2
      }
      TRANSPORT="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage:
  ./scripts/trichat_tui_launch.sh [--transport stdio|http] [-- ...extra trichat args]

Notes:
  This launcher routes to the dynamic Python TriChat council so custom roster
  definitions in config/trichat_agents.json and .env work without manual export.
USAGE
      exit 0
      ;;
    --)
      shift
      PASSTHROUGH_ARGS+=("$@")
      break
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN+x}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

ensure_autonomy_entry() {
  local should_ensure="${TRICHAT_AUTONOMY_ENSURE_ON_ENTRY:-1}"
  local mode="${TRICHAT_AUTONOMY_ENSURE_MODE:-required}"
  if [[ "${should_ensure}" == "0" ]]; then
    return 0
  fi
  if "${REPO_ROOT}/scripts/autonomy_ctl.sh" ensure >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${mode}" == "best_effort" ]]; then
    echo "[trichat:tui] warning: autonomy bootstrap ensure failed; continuing due to TRICHAT_AUTONOMY_ENSURE_MODE=best_effort" >&2
    return 0
  fi
  echo "[trichat:tui] autonomy bootstrap ensure failed before TUI launch" >&2
  exit 1
}

if [[ -z "${TRANSPORT}" ]]; then
  TRANSPORT="${TRICHAT_MCP_TRANSPORT:-stdio}"
fi

ensure_autonomy_entry

ARGS=(
  "python3"
  "./scripts/trichat.py"
  "--resume-latest"
  "--panel-on-start"
)

if [[ "${TRANSPORT}" == "http" ]]; then
  ARGS+=(
    "--transport" "http"
    "--url" "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
    "--origin" "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
  )
else
  ARGS+=(
    "--transport" "stdio"
    "--stdio-command" "${TRICHAT_MCP_STDIO_COMMAND:-node}"
    "--stdio-args" "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"
  )
fi

exec "${ARGS[@]}" "${PASSTHROUGH_ARGS[@]}"
