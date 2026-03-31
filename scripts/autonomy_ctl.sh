#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "${ACTION}" in
  status|ensure|maintain|intake|ingress|ide)
    ;;
  *)
    echo "usage: $0 [status|ensure|maintain|intake|ingress|ide]" >&2
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
  if [[ "${ACTION}" == "status" ]]; then
    printf 'stdio\n'
    return 0
  fi
  local preferred="${TRICHAT_RING_LEADER_TRANSPORT:-}"
  if [[ -n "${preferred}" ]]; then
    printf '%s\n' "${preferred}"
    return 0
  fi
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
  local timeout_ms="${MCP_TOOL_CALL_TIMEOUT_MS:-180000}"
  local max_attempts="${MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS:-10}"
  if [[ "${ACTION}" == "status" ]]; then
    timeout_ms="${AUTONOMY_STATUS_TIMEOUT_MS:-8000}"
    max_attempts="${AUTONOMY_STATUS_HTTP_MAX_ATTEMPTS:-1}"
  fi
  MCP_TOOL_CALL_TIMEOUT_MS="${timeout_ms}" MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS="${max_attempts}" node ./scripts/mcp_tool_call.mjs \
    --tool "${tool_name}" \
    --args "${args_json}" \
    --transport "${TRANSPORT}" \
    --url "${HTTP_URL}" \
    --origin "${HTTP_ORIGIN}" \
    --stdio-command "${STDIO_COMMAND}" \
    --stdio-args "${STDIO_ARGS}" \
    --cwd "${REPO_ROOT}"
}

start_maintain_entry() {
  local quiet="${1:-1}"
  local args_json
  args_json="$(node --input-type=module - \
    "${AUTONOMY_KEEPALIVE_INTERVAL_SECONDS:-120}" \
    "${AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS:-300}" \
    "${AUTONOMY_EVAL_INTERVAL_SECONDS:-21600}" \
    "${AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY:-0}" \
    "${TRICHAT_RING_LEADER_AUTOSTART:-1}" \
    <<'NODE'
function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntValue(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const [intervalSeconds, learningIntervalSeconds, evalIntervalSeconds, runImmediately, autostartRingLeader] = process.argv.slice(2);
const stamp = Date.now();

process.stdout.write(
  JSON.stringify({
    action: "start",
    mutation: {
      idempotency_key: `autonomy-maintain-start-${stamp}-${process.pid}`,
      side_effect_fingerprint: `autonomy-maintain-start-${stamp}-${process.pid}`,
    },
    interval_seconds: parseIntValue(intervalSeconds, 120, 5, 3600),
    learning_review_interval_seconds: parseIntValue(learningIntervalSeconds, 300, 60, 604800),
    eval_interval_seconds: parseIntValue(evalIntervalSeconds, 21600, 300, 604800),
    bootstrap_run_immediately: parseBoolean(runImmediately, false),
    autostart_ring_leader: parseBoolean(autostartRingLeader, true),
    ensure_bootstrap: true,
    start_goal_autorun_daemon: true,
    maintain_tmux_controller: true,
    run_eval_if_due: true,
    eval_suite_id: "autonomy.control-plane",
    minimum_eval_score: 75,
    refresh_learning_summary: true,
    publish_runtime_event: true,
    source_client: "autonomy_ctl.sh",
  })
);
NODE
)"
  if [[ "${quiet}" == "1" ]]; then
    call_tool_json autonomy.maintain "${args_json}" >/dev/null
  else
    call_tool_json autonomy.maintain "${args_json}"
  fi
}

ensure_autonomy_entry() {
  local quiet="${1:-1}"
  local args_json
  local bootstrap_result=""
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
    bootstrap_result="$(call_tool_json autonomy.bootstrap "${args_json}")"
  fi
  start_maintain_entry 1
  if [[ "${quiet}" != "1" ]]; then
    printf '%s\n' "${bootstrap_result}"
  fi
}

run_maintain_entry() {
  local quiet="${1:-1}"
  local args_json
  args_json="$(node --input-type=module - \
    "${AUTONOMY_KEEPALIVE_INTERVAL_SECONDS:-120}" \
    "${AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS:-300}" \
    "${AUTONOMY_EVAL_INTERVAL_SECONDS:-21600}" \
    "${AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY:-0}" \
    "${TRICHAT_RING_LEADER_AUTOSTART:-1}" \
    <<'NODE'
function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntValue(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const [intervalSeconds, learningIntervalSeconds, evalIntervalSeconds, runImmediately, autostartRingLeader] = process.argv.slice(2);
const stamp = Date.now();

process.stdout.write(
  JSON.stringify({
    action: "run",
    mutation: {
      idempotency_key: `autonomy-maintain-run-${stamp}-${process.pid}`,
      side_effect_fingerprint: `autonomy-maintain-run-${stamp}-${process.pid}`,
    },
    interval_seconds: parseIntValue(intervalSeconds, 120, 5, 3600),
    learning_review_interval_seconds: parseIntValue(learningIntervalSeconds, 300, 60, 604800),
    eval_interval_seconds: parseIntValue(evalIntervalSeconds, 21600, 300, 604800),
    bootstrap_run_immediately: parseBoolean(runImmediately, false),
    autostart_ring_leader: parseBoolean(autostartRingLeader, true),
    ensure_bootstrap: true,
    start_goal_autorun_daemon: true,
    maintain_tmux_controller: true,
    run_eval_if_due: true,
    eval_suite_id: "autonomy.control-plane",
    minimum_eval_score: 75,
    refresh_learning_summary: true,
    publish_runtime_event: true,
    source_client: "autonomy_ctl.sh",
  })
);
NODE
)"
  if [[ "${quiet}" == "1" ]]; then
    call_tool_json autonomy.maintain "${args_json}" >/dev/null
  else
    call_tool_json autonomy.maintain "${args_json}"
  fi
}

TRANSPORT="$(resolve_transport)"

if [[ "${ACTION}" == "status" ]]; then
  BOOTSTRAP_STATUS="$(MCP_TOOL_CALL_TIMEOUT_MS="${AUTONOMY_STATUS_TIMEOUT_MS:-8000}" node ./scripts/mcp_tool_call.mjs --tool autonomy.bootstrap --args '{"action":"status","fast":true}' --transport stdio --stdio-command "${STDIO_COMMAND}" --stdio-args "${STDIO_ARGS}" --cwd "${REPO_ROOT}")"
  READY_JSON=""
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    READY_JSON="$(
      curl -fsS \
        -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
        -H "Origin: ${HTTP_ORIGIN}" \
        "${HTTP_URL%/}/ready" 2>/dev/null || true
    )"
  fi
  if [[ -n "${READY_JSON}" ]]; then
    MAINTAIN_STATUS="$(python3 - "${READY_JSON}" <<'PY'
import json
import sys

ready = json.loads(sys.argv[1])
maintain = ready.get("autonomy_maintain") or {}
payload = {
    "state": {
        "enabled": bool(maintain.get("enabled")),
        "last_run_at": maintain.get("last_run_at"),
        "last_error": None,
    },
    "runtime": {
        "running": bool(maintain.get("runtime_running")),
        "last_error": None,
    },
    "due": {
        "stale": bool(maintain.get("stale")),
        "eval": bool(maintain.get("eval_due")),
    },
    "eval_health": maintain.get("eval_health") or {},
    "attention": ready.get("attention") or [],
    "fast": True,
    "source": "ready",
}
print(json.dumps(payload))
PY
)"
  else
    MAINTAIN_STATUS="$(MCP_TOOL_CALL_TIMEOUT_MS="${AUTONOMY_STATUS_TIMEOUT_MS:-8000}" node ./scripts/mcp_tool_call.mjs --tool autonomy.maintain --args '{"action":"status"}' --transport stdio --stdio-command "${STDIO_COMMAND}" --stdio-args "${STDIO_ARGS}" --cwd "${REPO_ROOT}")"
  fi
  python3 - "${BOOTSTRAP_STATUS}" "${MAINTAIN_STATUS}" <<'PY'
import json
import sys

bootstrap = json.loads(sys.argv[1])
maintain = json.loads(sys.argv[2])
bootstrap["maintain"] = maintain
print(json.dumps(bootstrap))
PY
  exit 0
fi

if [[ "${ACTION}" == "ensure" ]]; then
  ensure_autonomy_entry 0
  exit 0
fi

if [[ "${ACTION}" == "maintain" ]]; then
  run_maintain_entry 0
  exit 0
fi

ensure_autonomy_entry 1

exec "${REPO_ROOT}/scripts/autonomy_ide_ingress.sh" --no-ensure "$@"
