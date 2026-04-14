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
source "${REPO_ROOT}/scripts/bootstrap_guard.sh"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN+x}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

mcplayground_require_node_mcp_client "${REPO_ROOT}" "autonomy_ctl"

HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"

resolve_transport() {
  local preferred="${TRICHAT_RING_LEADER_TRANSPORT:-}"
  if [[ "${ACTION}" != "status" && -n "${preferred}" ]]; then
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

fetch_ready_json() {
  if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    return 0
  fi
  local response body
  response="$(
    curl -sS \
      -m "${AUTONOMY_STATUS_READY_TIMEOUT_SECONDS:-10}" \
      -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
      -H "Origin: ${HTTP_ORIGIN}" \
      -w $'\n%{http_code}' \
      "${HTTP_URL%/}/ready" 2>/dev/null || true
  )"
  body="${response%$'\n'*}"
  printf '%s' "${body}"
}

bootstrap_status_stdio() {
  MCP_AUTONOMY_BOOTSTRAP_ON_START=0 \
    MCP_AUTONOMY_MAINTAIN_ON_START=0 \
    TRICHAT_BUS_AUTOSTART=0 \
    MCP_TOOL_CALL_TIMEOUT_MS="${AUTONOMY_STATUS_TIMEOUT_MS:-20000}" \
    node ./scripts/mcp_tool_call.mjs \
      --tool autonomy.bootstrap \
      --args '{"action":"status","fast":true}' \
      --transport stdio \
      --stdio-command "${STDIO_COMMAND}" \
      --stdio-args "${STDIO_ARGS}" \
      --cwd "${REPO_ROOT}"
}

bootstrap_status_http() {
  MCP_TOOL_CALL_TIMEOUT_MS="${AUTONOMY_STATUS_HTTP_TIMEOUT_MS:-20000}" \
    MCP_HTTP_BEARER_TOKEN="${MCP_HTTP_BEARER_TOKEN}" \
    node ./scripts/mcp_tool_call.mjs \
      --tool autonomy.bootstrap \
      --args '{"action":"status","fast":true}' \
      --transport http \
      --url "${HTTP_URL}" \
      --origin "${HTTP_ORIGIN}" \
      --cwd "${REPO_ROOT}"
}

bootstrap_status_from_ready_json() {
  local ready_json="${1:-}"
  python3 - "${ready_json}" <<'PY'
import json
import sys

ready = json.loads(sys.argv[1] or "{}")
payload = {
    "self_start_ready": bool(ready.get("ready")),
    "status": ready.get("state") or ("ready" if ready.get("ready") else "degraded"),
    "repairs_needed": ready.get("attention") or [],
    "source": "ready",
}
print(json.dumps(payload))
PY
}

status_reports_self_start_ready() {
  local status_json="${1:-}"
  python3 - "${status_json}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1] or "{}")
raise SystemExit(0 if data.get("self_start_ready") else 1)
PY
}

wait_for_bootstrap_self_start_ready() {
  local timeout_seconds="${AUTONOMY_ENSURE_READY_TIMEOUT_SECONDS:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  local status_json=""

  while (( SECONDS < deadline )); do
    if [[ -n "$(fetch_ready_json)" ]]; then
      status_json="$(bootstrap_status_http 2>/dev/null || true)"
    else
      status_json="$(bootstrap_status_stdio 2>/dev/null || true)"
    fi
    if [[ -n "${status_json}" ]] && status_reports_self_start_ready "${status_json}"; then
      return 0
    fi
    sleep 1
  done
  return 0
}

bootstrap_already_ready() {
  local ready_json="" status_json=""
  ready_json="$(fetch_ready_json)"
  if [[ -n "${ready_json}" ]]; then
    status_json="$(bootstrap_status_http 2>/dev/null || true)"
    if [[ -z "${status_json}" ]]; then
      status_json="$(bootstrap_status_from_ready_json "${ready_json}" 2>/dev/null || true)"
    fi
  else
    status_json="$(bootstrap_status_stdio 2>/dev/null || true)"
  fi
  [[ -n "${status_json}" ]] && status_reports_self_start_ready "${status_json}"
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
    timeout_ms="${AUTONOMY_STATUS_TIMEOUT_MS:-20000}"
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

call_tool_json_retry_on_timeout() {
  local tool_name="${1}"
  local args_json="${2}"
  local max_attempts="${3:-3}"
  local attempt=1
  local delay_seconds=1

  while true; do
    local stdout_file stderr_file status stderr_text
    stdout_file="$(mktemp)"
    stderr_file="$(mktemp)"
    if call_tool_json "${tool_name}" "${args_json}" >"${stdout_file}" 2>"${stderr_file}"; then
      cat "${stdout_file}"
      rm -f "${stdout_file}" "${stderr_file}"
      return 0
    fi
    status=$?
    stderr_text="$(cat "${stderr_file}")"
    rm -f "${stdout_file}" "${stderr_file}"
    if (( attempt >= max_attempts )) || ! grep -qiE 'request timed out|timed out' <<<"${stderr_text}"; then
      printf '%s\n' "${stderr_text}" >&2
      return "${status}"
    fi
    sleep "${delay_seconds}"
    delay_seconds=$((delay_seconds * 2))
    attempt=$((attempt + 1))
  done
}

maintain_status_json_stdio() {
  MCP_TOOL_CALL_TIMEOUT_MS="${AUTONOMY_STATUS_TIMEOUT_MS:-20000}" \
    node ./scripts/mcp_tool_call.mjs \
      --tool autonomy.maintain \
      --args '{"action":"status"}' \
      --transport stdio \
      --stdio-command "${STDIO_COMMAND}" \
      --stdio-args "${STDIO_ARGS}" \
      --cwd "${REPO_ROOT}"
}

maintain_status_fallback_stdio() {
  node --input-type=module - "${REPO_ROOT}" <<'NODE'
import path from "node:path";
import { Storage } from "./dist/storage.js";

const repoRoot = process.argv[2] || process.cwd();
const storagePathEnv = process.env.ANAMNESIS_HUB_DB_PATH ?? process.env.MCP_HUB_DB_PATH;
const storagePath = storagePathEnv ? path.resolve(storagePathEnv) : path.join(repoRoot, "data", "hub.sqlite");
const storage = new Storage(storagePath);
const state = storage.getAutonomyMaintainState();

const intervalSeconds = Number(state?.interval_seconds ?? 120);
const learningReviewIntervalSeconds = Number(state?.learning_review_interval_seconds ?? 300);
const lastRunAt = typeof state?.last_run_at === "string" ? state.last_run_at : null;
const lastEvalRunAt = typeof state?.last_eval_run_at === "string" ? state.last_eval_run_at : null;
const nowSeconds = Date.now() / 1000;
const isoAgeSeconds = (value) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowSeconds - parsed / 1000);
};
const lastRunAgeSeconds = isoAgeSeconds(lastRunAt);
const lastLearningReviewAgeSeconds = isoAgeSeconds(
  typeof state?.last_learning_review_at === "string" ? state.last_learning_review_at : null
);
const lastEvalAgeSeconds = isoAgeSeconds(lastEvalRunAt);
const minimumEvalScore = Number(state?.minimum_eval_score ?? 75);
const lastEvalScore = typeof state?.last_eval_score === "number" ? state.last_eval_score : null;
const evalNeverRun = !lastEvalRunAt;
const evalBelowThreshold = lastEvalScore === null || lastEvalScore < minimumEvalScore;
const evalDueByAge = lastEvalAgeSeconds > Number(state?.eval_interval_seconds ?? 21600);
const evalDue = Boolean(state?.run_eval_if_due !== false && (evalNeverRun || evalBelowThreshold || evalDueByAge));

const payload = {
  state: {
    enabled: state?.enabled !== false,
    last_run_at: lastRunAt,
    last_error: state?.last_error ?? null,
  },
  runtime: {
    local_running: false,
    inferred_running: state?.enabled === true,
    running: state?.enabled === true,
    started_at: lastRunAt ?? state?.updated_at ?? null,
    last_tick_at: lastRunAt,
    last_error: state?.last_error ?? null,
    tick_count: null,
  },
  due: {
    stale: lastRunAgeSeconds > Math.max(intervalSeconds * 3, 300),
    learning_review: lastLearningReviewAgeSeconds > learningReviewIntervalSeconds,
    eval: evalDue,
  },
  eval_health: {
    suite_id: state?.eval_suite_id ?? "autonomy.control-plane",
    minimum_eval_score: minimumEvalScore,
    last_eval_score: lastEvalScore,
    last_eval_run_at: lastEvalRunAt,
    last_eval_run_id: state?.last_eval_run_id ?? null,
    current_dependency_fingerprint: null,
    last_eval_dependency_fingerprint: state?.last_eval_dependency_fingerprint ?? null,
    due: evalDue,
    due_by_age: evalDueByAge,
    due_by_dependency_drift: false,
    below_threshold: evalBelowThreshold,
    never_run: evalNeverRun,
    operational: !evalNeverRun && !evalBelowThreshold,
    healthy: !evalNeverRun && !evalBelowThreshold,
    last_eval_age_seconds: Number.isFinite(lastEvalAgeSeconds) ? Number(lastEvalAgeSeconds.toFixed(4)) : null,
  },
  attention: Array.isArray(state?.last_attention) ? state.last_attention : [],
  fast: true,
  source: "autonomy_ctl.status_fallback",
};

process.stdout.write(JSON.stringify(payload));
NODE
}

enable_maintain_fallback_stdio() {
  node --input-type=module - "${REPO_ROOT}" \
    "${AUTONOMY_KEEPALIVE_INTERVAL_SECONDS:-120}" \
    "${AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS:-300}" \
    "${AUTONOMY_EVAL_INTERVAL_SECONDS:-21600}" <<'NODE'
import path from "node:path";
import { Storage } from "./dist/storage.js";

const [repoRoot, intervalSecondsRaw, learningReviewIntervalSecondsRaw, evalIntervalSecondsRaw] = process.argv.slice(2);
const storagePathEnv = process.env.ANAMNESIS_HUB_DB_PATH ?? process.env.MCP_HUB_DB_PATH;
const storagePath = storagePathEnv ? path.resolve(storagePathEnv) : path.join(repoRoot, "data", "hub.sqlite");
const storage = new Storage(storagePath);
const current = storage.getAutonomyMaintainState() ?? {};
const now = new Date().toISOString();
const parseIntValue = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

storage.setAutonomyMaintainState({
  enabled: true,
  local_host_id: String(current.local_host_id ?? process.env.LOCAL_HOST_ID ?? "local"),
  interval_seconds: parseIntValue(intervalSecondsRaw, Number(current.interval_seconds ?? 120), 5, 3600),
  learning_review_interval_seconds: parseIntValue(
    learningReviewIntervalSecondsRaw,
    Number(current.learning_review_interval_seconds ?? 300),
    60,
    604800
  ),
  enable_self_drive: current.enable_self_drive !== false,
  self_drive_cooldown_seconds: Number(current.self_drive_cooldown_seconds ?? 1800),
  run_eval_if_due: current.run_eval_if_due !== false,
  eval_interval_seconds: parseIntValue(evalIntervalSecondsRaw, Number(current.eval_interval_seconds ?? 21600), 300, 604800),
  eval_suite_id: String(current.eval_suite_id ?? "autonomy.control-plane"),
  minimum_eval_score: Number(current.minimum_eval_score ?? 75),
  last_run_at: current.last_run_at ?? now,
  last_bootstrap_ready_at: current.last_bootstrap_ready_at ?? null,
  last_goal_autorun_daemon_at: current.last_goal_autorun_daemon_at ?? null,
  last_tmux_maintained_at: current.last_tmux_maintained_at ?? null,
  last_learning_review_at: current.last_learning_review_at ?? null,
  last_learning_entry_count: Number(current.last_learning_entry_count ?? 0),
  last_learning_active_agent_count: Number(current.last_learning_active_agent_count ?? 0),
  last_eval_run_at: current.last_eval_run_at ?? null,
  last_eval_run_id: current.last_eval_run_id ?? null,
  last_eval_score: current.last_eval_score ?? null,
  last_eval_dependency_fingerprint: current.last_eval_dependency_fingerprint ?? null,
  last_observability_ship_at: current.last_observability_ship_at ?? null,
  last_provider_bridge_check_at: current.last_provider_bridge_check_at ?? null,
  provider_bridge_diagnostics: Array.isArray(current.provider_bridge_diagnostics) ? current.provider_bridge_diagnostics : [],
  last_self_drive_at: current.last_self_drive_at ?? null,
  last_self_drive_goal_id: current.last_self_drive_goal_id ?? null,
  last_self_drive_fingerprint: current.last_self_drive_fingerprint ?? null,
  last_actions: Array.isArray(current.last_actions) ? current.last_actions : [],
  last_attention: Array.isArray(current.last_attention) ? current.last_attention : [],
  last_error: current.last_error ?? null,
});
NODE
}

maintain_status_running() {
  local status_json="${1:-}"
  python3 - "${status_json}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1] or "{}")
runtime = data.get("runtime") or {}
raise SystemExit(0 if runtime.get("running") else 1)
PY
}

start_maintain_entry() {
  local quiet="${1:-1}"
  local ensure_bootstrap="${2:-1}"
  local autostart_ring_leader="${3:-${TRICHAT_RING_LEADER_AUTOSTART:-1}}"
  local args_json
  args_json="$(node --input-type=module - \
    "${AUTONOMY_KEEPALIVE_INTERVAL_SECONDS:-120}" \
    "${AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS:-300}" \
    "${AUTONOMY_EVAL_INTERVAL_SECONDS:-21600}" \
    "${AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY:-0}" \
    "${autostart_ring_leader}" \
    "${ensure_bootstrap}" \
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

const [intervalSeconds, learningIntervalSeconds, evalIntervalSeconds, runImmediately, autostartRingLeader, ensureBootstrap] = process.argv.slice(2);
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
    fast: true,
    bootstrap_run_immediately: parseBoolean(runImmediately, false),
    autostart_ring_leader: parseBoolean(autostartRingLeader, true),
    ensure_bootstrap: parseBoolean(ensureBootstrap, true),
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
  local maintain_timeout_ms="${AUTONOMY_MAINTAIN_START_TIMEOUT_MS:-10000}"
  local stdout_file stderr_file status stderr_text maintain_status_json
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  if MCP_TOOL_CALL_TIMEOUT_MS="${maintain_timeout_ms}" call_tool_json autonomy.maintain "${args_json}" >"${stdout_file}" 2>"${stderr_file}"; then
    if [[ "${quiet}" != "1" ]]; then
      cat "${stdout_file}"
    fi
    rm -f "${stdout_file}" "${stderr_file}"
    return 0
  fi
  status=$?
  stderr_text="$(cat "${stderr_file}")"
  rm -f "${stdout_file}" "${stderr_file}"
  if grep -qiE 'request timed out|timed out' <<<"${stderr_text}"; then
    maintain_status_json="$(maintain_status_json_stdio 2>/dev/null || true)"
    if [[ -n "${maintain_status_json}" ]] && maintain_status_running "${maintain_status_json}"; then
      return 0
    fi
    enable_maintain_fallback_stdio >/dev/null 2>&1 || true
    maintain_status_json="$(maintain_status_fallback_stdio 2>/dev/null || true)"
    if [[ -n "${maintain_status_json}" ]] && maintain_status_running "${maintain_status_json}"; then
      return 0
    fi
  fi
  printf '%s\n' "${stderr_text}" >&2
  return "${status}"
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
    fast: true,
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
    call_tool_json_retry_on_timeout autonomy.bootstrap "${args_json}" "${AUTONOMY_ENSURE_MAX_ATTEMPTS:-3}" >/dev/null
  else
    bootstrap_result="$(call_tool_json_retry_on_timeout autonomy.bootstrap "${args_json}" "${AUTONOMY_ENSURE_MAX_ATTEMPTS:-3}")"
  fi
  start_maintain_entry 1 0 0
  wait_for_bootstrap_self_start_ready
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
if [[ "${TRANSPORT}" == "stdio" ]]; then
  mcplayground_require_dist_server "${REPO_ROOT}" "autonomy_ctl"
fi

if [[ "${ACTION}" == "status" ]]; then
  READY_JSON="$(fetch_ready_json)"
  if [[ -n "${READY_JSON}" ]]; then
    if ! BOOTSTRAP_STATUS="$(bootstrap_status_http 2>/dev/null)"; then
      BOOTSTRAP_STATUS="$(bootstrap_status_from_ready_json "${READY_JSON}")"
    fi
  else
    BOOTSTRAP_STATUS="$(bootstrap_status_stdio)"
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
    if ! MAINTAIN_STATUS="$(MCP_TOOL_CALL_TIMEOUT_MS="${AUTONOMY_STATUS_TIMEOUT_MS:-20000}" node ./scripts/mcp_tool_call.mjs --tool autonomy.maintain --args '{"action":"status","fast":true}' --transport stdio --stdio-command "${STDIO_COMMAND}" --stdio-args "${STDIO_ARGS}" --cwd "${REPO_ROOT}" 2>/dev/null)"; then
      MAINTAIN_STATUS="$(maintain_status_fallback_stdio)"
    fi
    MAINTAIN_STATUS="$(python3 - "${MAINTAIN_STATUS}" <<'PY'
import json
import sys

maintain = json.loads(sys.argv[1] or "{}")
state = maintain.get("state") or {}
runtime = maintain.get("runtime") or {}
if state.get("enabled") and not runtime.get("running") and not runtime.get("last_error"):
    runtime = dict(runtime)
    runtime.setdefault("local_running", runtime.get("running"))
    runtime["inferred_running"] = True
    runtime["running"] = True
    maintain["runtime"] = runtime
print(json.dumps(maintain))
PY
)"
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

if ! bootstrap_already_ready; then
  ensure_autonomy_entry 1
fi

exec "${REPO_ROOT}/scripts/autonomy_ide_ingress.sh" --no-ensure "$@"
