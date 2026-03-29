#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "${ACTION}" in
  status|ensure|intake|ingress|ide)
    ;;
  *)
    echo "usage: $0 [status|ensure|intake|ingress|ide]" >&2
    echo "  intake|ingress|ide delegate to ./scripts/autonomy_ide_ingress.sh" >&2
    echo "  run ./scripts/autonomy_ide_ingress.sh --help for ingress options" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"

resolve_transport() {
  local preferred="${TRICHAT_RING_LEADER_TRANSPORT:-}"
  if [[ -n "${preferred}" ]]; then
    printf '%s\n' "${preferred}"
    return 0
  fi
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    if node ./scripts/mcp_tool_call.mjs \
      --tool health.storage \
      --args '{}' \
      --transport http \
      --url "${HTTP_URL}" \
      --origin "${HTTP_ORIGIN}" \
      --cwd "${REPO_ROOT}" >/dev/null 2>&1; then
      printf 'http\n'
      return 0
    fi
  fi
  printf 'stdio\n'
}

parse_csv_arg() {
  local raw="${1:-}"
  node --input-type=module - "${raw}" <<'NODE'
const raw = process.argv[2] || "";
const values = raw
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
process.stdout.write(JSON.stringify(values));
NODE
}

derive_title() {
  local objective="${1:-}"
  node --input-type=module - "${objective}" <<'NODE'
const objective = String(process.argv[2] || "").trim();
const compact = objective.replace(/\s+/g, " ");
const title = compact.length > 72 ? `${compact.slice(0, 69).trim()}...` : compact;
process.stdout.write(title || "Autonomy intake");
NODE
}

call_tool_json() {
  local tool_name="${1}"
  local args_json="${2}"
  node ./scripts/mcp_tool_call.mjs \
    --tool "${tool_name}" \
    --args "${args_json}" \
    --transport "${TRANSPORT}" \
    --url "${HTTP_URL}" \
    --origin "${HTTP_ORIGIN}" \
    --stdio-command "${STDIO_COMMAND}" \
    --stdio-args "${STDIO_ARGS}" \
    --cwd "${REPO_ROOT}"
}

ensure_autonomy_entry() {
  local quiet="${1:-1}"
  local args_json
  args_json="$(node --input-type=module - \
    "${AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY:-0}" \
    "${TRICHAT_RING_LEADER_AUTOSTART:-1}" \
    <<'NODE'
function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const [runImmediately, autostartRingLeader] = process.argv.slice(2);
const stamp = Date.now();

process.stdout.write(
  JSON.stringify({
    action: "ensure",
    mutation: {
      idempotency_key: `autonomy-bootstrap-ensure-${stamp}-${process.pid}`,
      side_effect_fingerprint: `autonomy-bootstrap-ensure-${stamp}-${process.pid}`,
    },
    run_immediately: parseBoolean(runImmediately, false),
    autostart_ring_leader: parseBoolean(autostartRingLeader, true),
    seed_org_programs: true,
    seed_benchmark_suite: true,
    seed_eval_suite: true,
    source_client: "autonomy_ctl.sh",
  })
);
NODE
)"
  if [[ "${quiet}" == "1" ]]; then
    call_tool_json autonomy.bootstrap "${args_json}" >/dev/null
  else
    call_tool_json autonomy.bootstrap "${args_json}"
  fi
}

TRANSPORT="$(resolve_transport)"

if [[ "${ACTION}" == "status" ]]; then
  call_tool_json autonomy.bootstrap '{"action":"status"}'
  exit 0
fi

if [[ "${ACTION}" == "ensure" ]]; then
  ensure_autonomy_entry 0
  exit 0
fi

ensure_autonomy_entry 1

exec "${REPO_ROOT}/scripts/autonomy_ide_ingress.sh" --no-ensure "$@"
