#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN+x}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"
JSON_OUTPUT=0
THREAD_ID=""
COMPACT_OUTPUT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --compact)
      COMPACT_OUTPUT=1
      shift
      ;;
    --thread)
      THREAD_ID="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
usage: ./scripts/operator_brief.sh [--json] [--compact] [--thread <thread-id>]

Return the current operator brief from the live MCP runtime when available.
Defaults to HTTP against the launchd daemon and falls back to stdio if needed.
EOF
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

resolve_transport() {
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    if curl -fsS \
      -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
      -H "Origin: ${HTTP_ORIGIN}" \
      "${HTTP_URL%/}/health" >/dev/null 2>&1; then
      printf 'http\n'
      return 0
    fi
  fi
  printf 'stdio\n'
}

build_args() {
  node --input-type=module - "${THREAD_ID}" "${COMPACT_OUTPUT}" <<'NODE'
const threadId = (process.argv[2] || "").trim();
const compact = String(process.argv[3] || "").trim() === "1";
const payload = {
  include_kernel: true,
  include_runtime_brief: true,
  include_compile_brief: true,
  compact,
};
if (threadId) {
  payload.thread_id = threadId;
}
process.stdout.write(JSON.stringify(payload));
NODE
}

TRANSPORT="$(resolve_transport)"
ARGS_JSON="$(build_args)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/master-mold-operator-brief-XXXXXX")"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

MCP_TOOL_CALL_TIMEOUT_MS="${MCP_TOOL_CALL_TIMEOUT_MS:-20000}" node ./scripts/mcp_tool_call.mjs \
  --tool operator.brief \
  --args "${ARGS_JSON}" \
  --transport "${TRANSPORT}" \
  --url "${HTTP_URL}" \
  --origin "${HTTP_ORIGIN}" \
  --stdio-command "${STDIO_COMMAND}" \
  --stdio-args "${STDIO_ARGS}" \
  --cwd "${REPO_ROOT}" > "${TMP_DIR}/operator-brief.json"

if [[ "${JSON_OUTPUT}" == "1" ]]; then
  cat "${TMP_DIR}/operator-brief.json"
  exit 0
fi

python3 - "${TMP_DIR}/operator-brief.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
latest = data.get("latest_router_suppression") or {}
if isinstance(latest, dict) and latest:
    reason = str(latest.get("reason") or "suppressed").replace("_", " ")
    backend = str(latest.get("selected_backend_id") or "n/a")
    observed = str(latest.get("observed_at") or "n/a")
    print(f"Router hold: reason={reason} backend={backend} observed_at={observed}")
    print("")
print(data.get("brief_markdown") or "# Operator Brief\n\nNo operator brief available.")
PY
