#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

need_cmd() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || {
    echo "[production] missing required command: ${name}" >&2
    exit 2
  }
}

need_cmd node
need_cmd python3
need_cmd tmux
need_cmd curl

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/master-mold-production-readiness-XXXXXX")"
LOCK_ROOT="${REPO_ROOT}/data/imprint/locks"
LOCK_DIR="${LOCK_ROOT}/production-readiness.lock"
LOCK_WAIT_SECONDS="${PRODUCTION_READINESS_LOCK_WAIT_SECONDS:-3}"
LOCK_STALE_SECONDS="${PRODUCTION_READINESS_LOCK_STALE_SECONDS:-1800}"
LOCK_HELD=0
cleanup() {
  if [[ "${LOCK_HELD}" == "1" ]]; then
    rm -rf "${LOCK_DIR}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

lock_is_stale() {
  python3 - "${LOCK_DIR}" "${LOCK_STALE_SECONDS}" <<'PY'
import os
import sys
from pathlib import Path

lock_dir = Path(sys.argv[1])
stale_seconds = max(1, int(sys.argv[2]))
try:
    age = max(0.0, __import__("time").time() - lock_dir.stat().st_mtime)
except FileNotFoundError:
    raise SystemExit(1)
raise SystemExit(0 if age >= stale_seconds else 1)
PY
}

acquire_singleton_lock() {
  mkdir -p "${LOCK_ROOT}"
  local deadline=$((SECONDS + LOCK_WAIT_SECONDS))
  while (( SECONDS <= deadline )); do
    if mkdir "${LOCK_DIR}" >/dev/null 2>&1; then
      printf '%s\n' "$$" > "${LOCK_DIR}/pid"
      LOCK_HELD=1
      return 0
    fi
    local owner_pid=""
    if [[ -f "${LOCK_DIR}/pid" ]]; then
      owner_pid="$(tr -d '[:space:]' < "${LOCK_DIR}/pid" 2>/dev/null || true)"
    fi
    if [[ -n "${owner_pid}" ]] && ! kill -0 "${owner_pid}" >/dev/null 2>&1; then
      rm -rf "${LOCK_DIR}" >/dev/null 2>&1 || true
      continue
    fi
    if lock_is_stale; then
      rm -rf "${LOCK_DIR}" >/dev/null 2>&1 || true
      continue
    fi
    sleep 1
  done
  echo "[production] another production_readiness.sh run is already active" >&2
  exit 75
}

acquire_singleton_lock

REAPED_REPO_SERVER_COUNT="$(
  node --input-type=module - "${REPO_ROOT}" <<'NODE'
import { reapRepoServerProcesses } from "./scripts/mcp_runner_support.mjs";

const repoRoot = process.argv[2];
const reaped = await reapRepoServerProcesses(repoRoot, {
  excludePids: [process.pid],
  orphanOnly: true,
  signalWaitMs: 2000,
});
process.stdout.write(String(reaped.length));
NODE
)"
if [[ "${REAPED_REPO_SERVER_COUNT}" != "0" ]]; then
  echo "[production] reaped orphan repo server processes: ${REAPED_REPO_SERVER_COUNT}"
fi

TRICHAT_HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
TRICHAT_HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
MCP_TOOL_CALL_TIMEOUT_MS="${MCP_TOOL_CALL_TIMEOUT_MS:-15000}"
PRODUCTION_READINESS_HTTP_MAX_ATTEMPTS="${PRODUCTION_READINESS_HTTP_MAX_ATTEMPTS:-6}"
PRODUCTION_READINESS_OFFICE_SNAPSHOT_TIMEOUT_SECONDS="${PRODUCTION_READINESS_OFFICE_SNAPSHOT_TIMEOUT_SECONDS:-20}"
TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN+x}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

curl_json() {
  local path="$1"
  local allow_http_error="${2:-0}"
  local attempt stderr_file response body http_code rc
  stderr_file="${TMP_DIR}/curl-json-${path//[^A-Za-z0-9_.-]/_}.err"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if response="$(
      curl -sS \
        -w $'\n%{http_code}' \
        -H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}" \
        -H "Origin: ${TRICHAT_HTTP_ORIGIN}" \
        "${TRICHAT_HTTP_URL%/}${path}" \
        2>"${stderr_file}"
    )"; then
      http_code="${response##*$'\n'}"
      body="${response%$'\n'*}"
      if [[ "${allow_http_error}" == "1" || "${http_code}" -lt 400 ]]; then
        printf '%s\n' "${body}"
        return 0
      fi
      printf 'HTTP %s\n' "${http_code}" >&2
      printf '%s\n' "${body}" >&2
      return 22
    fi
    rc=$?
    if ! grep -qiE 'recv failure|connection reset|econnrefused|failed to connect|timed out|socket hang up|empty reply from server' "${stderr_file}"; then
      cat "${stderr_file}" >&2
      return "${rc}"
    fi
    sleep 0.5
  done
  cat "${stderr_file}" >&2
  return "${rc:-1}"
}

call_http() {
  local tool="$1"
  local args="${2:-\{\}}"
  local output_file="${TMP_DIR}/call-http-${tool//[^A-Za-z0-9_.-]/_}.json"
  call_http_to_file "${tool}" "${args}" "${output_file}"
  cat "${output_file}"
}

call_http_to_file() {
  local tool="$1"
  local args="${2:-\{\}}"
  local output_file="$3"
  local attempt stderr_file rc max_attempts
  max_attempts="${PRODUCTION_READINESS_HTTP_MAX_ATTEMPTS}"
  stderr_file="${TMP_DIR}/call-http-${tool//[^A-Za-z0-9_.-]/_}.err"
  for (( attempt = 1; attempt <= max_attempts; attempt += 1 )); do
    rm -f "${output_file}"
    if MCP_TOOL_CALL_TIMEOUT_MS="${MCP_TOOL_CALL_TIMEOUT_MS}" MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS="1" node ./scripts/mcp_tool_call.mjs \
      --tool "${tool}" \
      --args "${args}" \
      --transport http \
      --url "${TRICHAT_HTTP_URL}" \
      --origin "${TRICHAT_HTTP_ORIGIN}" \
      --cwd "${REPO_ROOT}" \
      >"${output_file}" 2>"${stderr_file}"; then
      return 0
    fi
    rc=$?
    if ! grep -qiE 'fetch failed|econnrefused|socket hang up|timed out|connection reset' "${stderr_file}"; then
      cat "${stderr_file}" >&2
      return "${rc}"
    fi
    sleep 0.5
  done
  cat "${stderr_file}" >&2
  return "${rc:-1}"
}

echo "[production] repo: ${REPO_ROOT}"
echo "[production] node: $(node -v)"
echo "[production] python: $(python3 --version 2>&1)"
echo "[production] mcp url: ${TRICHAT_HTTP_URL}"

CURRENT_NODE_VERSION="$(node -v 2>/dev/null || true)"
CURRENT_NODE_MAJOR="$(echo "${CURRENT_NODE_VERSION}" | sed 's/^v//' | cut -d. -f1)"
REQUIRED_NODE_MAJOR="22"
if [[ -n "${CURRENT_NODE_MAJOR}" && "${CURRENT_NODE_MAJOR}" != "${REQUIRED_NODE_MAJOR}" ]]; then
  echo "[production] WARNING: Node ${CURRENT_NODE_VERSION} detected but Node v${REQUIRED_NODE_MAJOR}.x is required" >&2
  echo "[production] WARNING: native better-sqlite3 module may have ABI mismatch" >&2
fi

LAUNCHD_MCP_PLIST="${HOME}/Library/LaunchAgents/com.master-mold.mcp.server.plist"
if [[ -f "${LAUNCHD_MCP_PLIST}" ]]; then
  PLIST_PATH="$(python3 -c "
import plistlib, sys, pathlib
try:
    p = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
    env = p.get('EnvironmentVariables', {})
    path_val = env.get('PATH', '')
    print(path_val)
except Exception:
    print('')
" "${LAUNCHD_MCP_PLIST}" 2>/dev/null || true)"
  if [[ -n "${PLIST_PATH}" ]]; then
    PLIST_NODE="$(PATH="${PLIST_PATH}" command -v node 2>/dev/null || true)"
    if [[ -n "${PLIST_NODE}" ]]; then
      PLIST_NODE_VERSION="$("${PLIST_NODE}" -v 2>/dev/null || true)"
      PLIST_NODE_MAJOR="$(echo "${PLIST_NODE_VERSION}" | sed 's/^v//' | cut -d. -f1)"
      if [[ "${PLIST_NODE_MAJOR}" != "${CURRENT_NODE_MAJOR}" ]]; then
        echo "[production] WARNING: launchd plist resolves Node ${PLIST_NODE_VERSION} (${PLIST_NODE}) but shell has ${CURRENT_NODE_VERSION}" >&2
        echo "[production] WARNING: PATH mismatch between launchd and current shell — run launchd:install to fix" >&2
      else
        echo "[production] launchd node: ${PLIST_NODE_VERSION} (matches shell)"
      fi
    else
      echo "[production] WARNING: launchd plist PATH does not resolve to a node binary" >&2
    fi
  fi
  PLIST_REPO="$(python3 -c "
import plistlib, sys, pathlib
try:
    p = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
    env = p.get('EnvironmentVariables', {})
    print(env.get('MASTER_MOLD_REPO_ROOT', ''))
except Exception:
    print('')
" "${LAUNCHD_MCP_PLIST}" 2>/dev/null || true)"
  if [[ -n "${PLIST_REPO}" && "${PLIST_REPO}" != "${REPO_ROOT}" ]]; then
    echo "[production] WARNING: launchd plist MASTER_MOLD_REPO_ROOT=${PLIST_REPO} differs from current repo ${REPO_ROOT}" >&2
  fi
fi

NATIVE_MODULE="${REPO_ROOT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [[ -f "${NATIVE_MODULE}" ]]; then
  NATIVE_ABI="$(node -e "try{require('${NATIVE_MODULE}');console.log('ok')}catch(e){console.log('abi_mismatch: '+e.message.substring(0,120))}" 2>/dev/null || echo "probe_failed")"
  if [[ "${NATIVE_ABI}" == "ok" ]]; then
    echo "[production] native module: better-sqlite3 ABI compatible"
  else
    echo "[production] WARNING: better-sqlite3 native module ABI mismatch: ${NATIVE_ABI}" >&2
    echo "[production] WARNING: run 'npm rebuild better-sqlite3' or 'npm ci' to fix" >&2
  fi
fi

echo "[production] health: $(curl_json '/health' | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','n/a'))")"

curl_json '/ready' 1 > "${TMP_DIR}/ready.json"
python3 - "${TMP_DIR}/ready.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(
    "[production] control plane: "
    f"ready={data.get('ready')} "
    f"state={data.get('state') or 'n/a'} "
    f"attention={','.join(data.get('attention', [])) or 'none'}"
)
if not data.get("ready"):
    raise SystemExit("control plane /ready is not healthy")
PY

call_http health.storage '{}' > "${TMP_DIR}/health-storage.json"
python3 - "${TMP_DIR}/health-storage.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
backups = data.get("backups") or {}
total_bytes = int(backups.get("total_bytes") or 0)
reclaimable_bytes = int(backups.get("reclaimable_bytes") or 0)
print(
    "[production] storage backups: "
    f"artifacts={backups.get('artifact_count')} "
    f"keep={backups.get('backup_keep')} "
    f"total_bytes={total_bytes} "
    f"reclaimable_bytes={reclaimable_bytes}"
)
if total_bytes > 128 * 1024 * 1024 * 1024:
    raise SystemExit("storage backups exceed the 128GB production ceiling")
if reclaimable_bytes > 5 * 1024 * 1024 * 1024:
    raise SystemExit("storage backups have more than 5GB of reclaimable churn")
PY

python3 - "${TMP_DIR}/ready.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
worker = data.get("worker_fabric") or {}
print(
    "[production] worker fabric: "
    f"healthy_hosts={worker.get('healthy_host_count')} "
    f"degraded_hosts={worker.get('degraded_host_count')} "
    f"offline_hosts={worker.get('offline_host_count')}"
)
if int(worker.get("healthy_host_count") or 0) < 1:
    raise SystemExit("worker fabric has no healthy hosts")
PY

python3 - "${TMP_DIR}/ready.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
autonomy = data.get("autonomy_maintain") or {}
eval_health = autonomy.get("eval_health") or {}
eval_operational = eval_health.get("operational")
if eval_operational is None:
    eval_operational = eval_health.get("healthy")
print(
    "[production] autonomy maintain: "
    f"enabled={autonomy.get('enabled')} "
    f"running={autonomy.get('runtime_running')} "
    f"last_run_at={autonomy.get('last_run_at') or 'n/a'} "
    f"stale={autonomy.get('stale')} "
    f"eval_due={autonomy.get('eval_due')} "
    f"eval_score={eval_health.get('last_eval_score') if eval_health.get('last_eval_score') is not None else 'n/a'} "
    f"minimum_eval_score={eval_health.get('minimum_eval_score') if eval_health.get('minimum_eval_score') is not None else 'n/a'}"
)
if not autonomy.get("enabled"):
    raise SystemExit("autonomy.maintain is not enabled")
if not autonomy.get("runtime_running"):
    raise SystemExit("autonomy.maintain runtime is not currently running")
if not autonomy.get("last_run_at"):
    raise SystemExit("autonomy.maintain has not recorded a keepalive run yet")
if autonomy.get("stale"):
    raise SystemExit("autonomy.maintain state is stale")
if not eval_operational:
    raise SystemExit("autonomy.maintain eval health is not ready")
PY

python3 - "${TMP_DIR}/ready.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
reaction = data.get("reaction_engine") or {}
print(
    "[production] reaction engine: "
    f"enabled={reaction.get('enabled')} "
    f"running={reaction.get('runtime_running')} "
    f"stale={reaction.get('stale')}"
)
if not reaction.get("enabled"):
    raise SystemExit("reaction.engine is not enabled")
if not reaction.get("runtime_running"):
    raise SystemExit("reaction.engine runtime is not currently running")
if reaction.get("stale"):
    raise SystemExit("reaction.engine state is stale")
PY

node --input-type=module - <<'NODE'
import { captureLocalHostProfile } from "./dist/local_host_profile.js";
const profile = captureLocalHostProfile({ workspace_root: process.cwd() });
console.log(
  "[production] local accelerator: " +
    `kind=${profile.accelerator_kind} ` +
    `model=${profile.gpu_model ?? "n/a"} ` +
    `api=${profile.gpu_api ?? "n/a"} ` +
    `cores=${profile.gpu_core_count ?? "n/a"} ` +
    `gpu_mem_total=${profile.gpu_memory_total_gb ?? "n/a"} ` +
    `gpu_mem_avail=${profile.gpu_memory_available_gb ?? "n/a"} ` +
    `mlx=${profile.mlx_available} ` +
    `mlx_lm=${profile.mlx_lm_available} ` +
    `mlx_python=${profile.mlx_python ?? "n/a"}`
);
if (profile.accelerator_kind !== "none" && !profile.full_gpu_access) {
  throw new Error("local accelerator detected but full_gpu_access is false");
}
NODE

if [[ "${TRICHAT_MLX_SERVER_ENABLED:-0}" == "1" && -n "${TRICHAT_MLX_ENDPOINT:-}" ]]; then
  node ./scripts/run_sh.mjs ./scripts/agents_switch.sh status > "${TMP_DIR}/agents-status.json"
  python3 - "${TMP_DIR}/agents-status.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
launchd = data.get("launchd") or {}
loaded = bool(launchd.get("mlx_loaded"))
disabled = bool(launchd.get("mlx_disabled"))
plist_current = bool(launchd.get("mlx_plist_current"))
operational = bool(launchd.get("mlx_operational"))
plist = launchd.get("mlx_plist") or "n/a"
print(
    "[production] mlx launchd: "
    f"loaded={loaded} "
    f"disabled={disabled} "
    f"plist_current={plist_current} "
    f"operational={operational} "
    f"plist={plist}"
)
if not plist_current:
    raise SystemExit("mlx launchd plist is missing or stale")
if disabled:
    raise SystemExit("mlx launchd agent is disabled")
if not loaded:
    raise SystemExit(f"mlx launchd agent is not loaded ({plist})")
PY
  MLX_HEALTH=""
  MLX_MODELS=""
  for _attempt in $(seq 1 15); do
    if MLX_HEALTH="$(curl -fsS "${TRICHAT_MLX_ENDPOINT%/}/health" 2>/dev/null)" && \
      MLX_MODELS="$(curl -fsS "${TRICHAT_MLX_ENDPOINT%/}/v1/models" 2>/dev/null)"; then
      break
    fi
    MLX_HEALTH=""
    MLX_MODELS=""
    sleep 1
  done
  if [[ -z "${MLX_HEALTH}" || -z "${MLX_MODELS}" ]]; then
    echo "mlx launchd agent is loaded but ${TRICHAT_MLX_ENDPOINT%/} did not become healthy in time" >&2
    exit 1
  fi
  python3 - "${TRICHAT_MLX_ENDPOINT%/}" "${MLX_HEALTH}" "${MLX_MODELS}" <<'PY'
import json
import sys

endpoint = sys.argv[1]
health = json.loads(sys.argv[2])
models = json.loads(sys.argv[3])
model_count = len((models.get("data") or [])) if isinstance(models, dict) else 0
print(
    "[production] mlx server: "
    f"healthy={health.get('status') == 'ok'} "
    f"models={model_count} "
    f"endpoint={endpoint}"
)
if health.get("status") != "ok":
    raise SystemExit("mlx server health probe failed")
PY
fi

OBS_IDEMPOTENCY_KEY="production-observability-ship-$(date +%s%N)"
call_http observability.ship "{\"mutation\":{\"idempotency_key\":\"${OBS_IDEMPOTENCY_KEY}\",\"side_effect_fingerprint\":\"${OBS_IDEMPOTENCY_KEY}\"},\"source\":\"local_host\"}" > "${TMP_DIR}/observability-ship.json"
python3 - "${TMP_DIR}/observability-ship.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
document_count = int(data.get("document_count") or 0)
source_kind = data.get("source_kind") or "n/a"
index_name = data.get("index_name") or "n/a"
print(
    "[production] observability ship: "
    f"index={index_name} "
    f"source={source_kind} "
    f"document_count={document_count}"
)
if document_count < 1:
    raise SystemExit("observability.ship did not ingest a local host telemetry document")
PY

call_http observability.dashboard '{"critical_window_minutes":15,"recent_limit":5}' > "${TMP_DIR}/observability-dashboard.json"
python3 - "${TMP_DIR}/observability-dashboard.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
overview = data.get("overview") or {}
doc_count = int(overview.get("count") or 0)
recent_error_count = int(data.get("recent_error_count") or 0)
recent_critical_count = int(data.get("recent_critical_count") or 0)
top_sources = data.get("top_sources") or []
top_services = data.get("top_services") or []
top_source = (top_sources[0] or {}).get("source_kind") if top_sources else "n/a"
top_service = (top_services[0] or {}).get("service") if top_services else "n/a"
print(
    "[production] observability dashboard: "
    f"documents={doc_count} "
    f"errors15m={recent_error_count} "
    f"critical15m={recent_critical_count} "
    f"top_source={top_source} "
    f"top_service={top_service}"
)
if doc_count < 1:
    raise SystemExit("observability.dashboard returned no indexed telemetry documents")
if recent_critical_count > 0:
    raise SystemExit("observability.dashboard reported recent critical telemetry")
PY

python3 - "${TMP_DIR}/ready.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
state = data.get("model_router") or {}
print(
    "[production] model router: "
    f"enabled={state.get('enabled')} "
    f"backends={state.get('backend_count')} "
    f"default={state.get('default_backend_id')}"
)
if not state.get("enabled") or int(state.get("backend_count") or 0) < 1:
    raise SystemExit("model.router is not enabled with at least one backend")
PY

call_http runtime.worker '{"action":"status","limit":20}' > "${TMP_DIR}/runtime-worker.json"
python3 - "${TMP_DIR}/runtime-worker.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
summary = data.get("summary") or {}
runtimes = data.get("runtimes") or []
available = sorted(entry.get("runtime_id") for entry in runtimes if isinstance(entry, dict) and entry.get("available") is True)
print(
    "[production] runtime workers: "
    f"sessions={summary.get('session_count')} "
    f"active={summary.get('active_count')} "
    f"available={','.join(available) or 'none'}"
)
if "shell" not in available:
    raise SystemExit("runtime.worker did not report the shell runtime as available")
PY

call_http org.program '{}' > "${TMP_DIR}/org-program.json"
python3 - "${TMP_DIR}/org-program.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
role_count = int(data.get("role_count") or 0)
active_version_count = int(data.get("active_version_count") or 0)
print(f"[production] org programs: roles={role_count} active_versions={active_version_count}")
if role_count < 4 or active_version_count < 4:
    raise SystemExit("org.program is missing expected active doctrine coverage")
PY

call_http eval.suite_list '{}' > "${TMP_DIR}/eval-suites.json"
python3 - "${TMP_DIR}/eval-suites.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
suites = data.get("suites") or []
suite_ids = {entry.get("suite_id") for entry in suites if isinstance(entry, dict)}
print(f"[production] eval suites: count={len(suites)}")
if "autonomy.control-plane" not in suite_ids:
    raise SystemExit("eval.suite_list is missing autonomy.control-plane")
PY

call_http trichat.autopilot '{"action":"status"}' > "${TMP_DIR}/autopilot.json"
python3 - "${TMP_DIR}/autopilot.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
pool = data.get("effective_agent_pool") or {}
lead = pool.get("lead_agent_id")
specialists = pool.get("specialist_agent_ids") or []
confidence_mode = (((data.get("session") or {}).get("session") or {}).get("metadata") or {}).get("last_confidence_method", {}).get("mode")
if not data.get("running"):
    raise SystemExit("ring leader autopilot is not running")
if lead != "ring-leader":
    raise SystemExit(f"expected ring-leader lead agent, found {lead!r}")
if len(specialists) < 3:
    raise SystemExit("expected at least three specialist agents in the effective pool")
print(f"[production] autopilot: running lead={lead} specialists={','.join(specialists)}")
if confidence_mode:
    print(f"[production] confidence method: {confidence_mode}")
PY

call_http provider.bridge '{"action":"status"}' > "${TMP_DIR}/provider-bridge.json"
python3 - "${TMP_DIR}/provider-bridge.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
clients = {entry.get("client_id"): entry for entry in data.get("clients", [])}
local_first = data.get("local_first_ide_agent_ids") or []
if data.get("canonical_ingress_tool") != "autonomy.ide_ingress":
    raise SystemExit("provider.bridge did not report autonomy.ide_ingress as canonical ingress")
required_clients = {"claude-cli", "codex", "cursor", "gemini-cli", "github-copilot-cli", "chatgpt-developer-mode"}
missing = sorted(required_clients - set(clients))
if missing:
    raise SystemExit(f"provider.bridge missing expected clients: {missing}")
if len(local_first) < 4:
    raise SystemExit("provider.bridge local-first IDE policy is incomplete")
print(
    "[production] provider bridge: "
    f"canonical_ingress={data.get('canonical_ingress_tool')} "
    f"local_first={','.join(local_first)}"
)
PY

call_http operator.brief '{"thread_id":"ring-leader-main","include_kernel":true,"include_runtime_brief":true,"include_compile_brief":true}' > "${TMP_DIR}/operator-brief.json"
python3 - "${TMP_DIR}/operator-brief.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
brief_markdown = str(data.get("brief_markdown") or "").strip()
current_objective = data.get("current_objective") or "n/a"
source = data.get("source") or "n/a"
latest = data.get("latest_router_suppression") or ((data.get("control_plane_summary") or {}).get("latest_router_suppression")) or {}
if source != "operator.brief":
    raise SystemExit(f"operator.brief returned unexpected source {source!r}")
if not brief_markdown:
    raise SystemExit("operator.brief returned an empty brief_markdown")
print(
    "[production] operator brief: "
    f"source={source} "
    f"current_objective={current_objective}"
)
if isinstance(latest, dict) and latest:
    print(
        "[production] router hold: "
        f"reason={latest.get('reason') or 'suppressed'} "
        f"backend={latest.get('selected_backend_id') or 'n/a'} "
        f"pressure={latest.get('pressure_level') or 'n/a'} "
        f"observed_at={latest.get('observed_at') or 'n/a'}"
    )
PY

kernel_ok=0
for attempt in 1 2 3 4 5; do
  call_http kernel.summary '{"session_limit":6,"event_limit":6,"task_running_limit":8}' > "${TMP_DIR}/kernel.json"
  if python3 - "${TMP_DIR}/kernel.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
overview = data.get("overview") or {}
adaptive = overview.get("adaptive_session_counts") or {}
adaptive_sessions = data.get("adaptive_sessions") or []
active_sessions_payload = data.get("active_sessions") or []
active_sessions = overview.get("active_session_count", 0)
healthy = adaptive.get("healthy", 0)
degraded = adaptive.get("degraded", 0)
active_sessions_by_id = {
    str(entry.get("session_id") or ""): entry
    for entry in active_sessions_payload
    if isinstance(entry, dict)
}
recoverable = 0
for entry in adaptive_sessions:
    if not isinstance(entry, dict):
        continue
    if str(entry.get("adaptive_state") or "") != "degraded":
        continue
    reasons = [str(reason).strip() for reason in (entry.get("adaptive_reasons") or []) if str(reason).strip()]
    if not reasons:
        continue
    if any("recent failed task signal(s) still need recovery" not in reason for reason in reasons):
        continue
    if any(not reason.split(" ", 1)[0].isdigit() or int(reason.split(" ", 1)[0]) > 2 for reason in reasons):
        continue
    session = active_sessions_by_id.get(str(entry.get("session_id") or ""))
    if not isinstance(session, dict):
        continue
    metadata = session.get("metadata") or {}
    if not isinstance(metadata, dict) or metadata.get("last_tick_ok") is not True:
        continue
    current_task_id = metadata.get("current_task_id")
    if isinstance(current_task_id, str) and current_task_id.strip():
        continue
    recoverable += 1
print(f"[production] kernel state: {data.get('state')} active_sessions={active_sessions} healthy={healthy} degraded={degraded}")
if healthy < 1 and recoverable > 0:
    print(f"[production] kernel state: accepting {recoverable} recoverable degraded active session(s)")
if active_sessions < 1 or (healthy < 1 and recoverable < 1):
    raise SystemExit(1)
PY
  then
    kernel_ok=1
    break
  fi
  sleep 0.5
done

if [[ "${kernel_ok}" -ne 1 ]]; then
  echo "[production] kernel summary never reported an active healthy or recoverable session after retry window" >&2
  exit 1
fi

call_http playbook.list '{"limit":20}' > "${TMP_DIR}/playbooks.json"
python3 - "${TMP_DIR}/playbooks.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
playbooks = {entry["playbook_id"]: entry for entry in data.get("playbooks", [])}
required = {
    "gsd.map_codebase": "gsd-build/get-shit-done",
    "gsd.phase_delivery": "gsd-build/get-shit-done",
    "gsd.debug_issue": "gsd-build/get-shit-done",
    "autoresearch.optimize_loop": "karpathy/autoresearch",
}
missing = []
wrong_source = []
for playbook_id, source_repo in required.items():
    entry = playbooks.get(playbook_id)
    if not entry:
        missing.append(playbook_id)
        continue
    if entry.get("source_repo") != source_repo:
        wrong_source.append(f"{playbook_id}:{entry.get('source_repo')}")
if missing or wrong_source:
    raise SystemExit(f"missing or mismatched playbooks missing={missing} wrong_source={wrong_source}")
print("[production] methodology playbooks: gsd + autoresearch present")
PY

python3 ./scripts/agent_office_dashboard.py \
  --transport http \
  --url "${TRICHAT_HTTP_URL}" \
  --origin "${TRICHAT_HTTP_ORIGIN}" \
  --resume-latest \
  --view help \
  --once \
  --width 120 \
  --height 30 > "${TMP_DIR}/office-help.txt"
grep -q "Truth mode:" "${TMP_DIR}/office-help.txt"
grep -q "SuperClaude-inspired confidence checks" "${TMP_DIR}/office-help.txt"
echo "[production] office dashboard: help view renders with truth mode + methodology surface"

python3 - <<'PY' "${TRICHAT_HTTP_URL}" "${TRICHAT_HTTP_ORIGIN}" "${TMP_DIR}/office-bootstrap.json" "${TMP_DIR}/office-snapshot.json" "${TMP_DIR}/office-session-name.txt" "${PRODUCTION_READINESS_OFFICE_SNAPSHOT_TIMEOUT_SECONDS}"
import json
import pathlib
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
origin = sys.argv[2]
bootstrap_path = pathlib.Path(sys.argv[3])
snapshot_path = pathlib.Path(sys.argv[4])
session_name_path = pathlib.Path(sys.argv[5])
snapshot_timeout = max(5, int(sys.argv[6]))

bootstrap_request = urllib.request.Request(f"{base}/office/api/bootstrap", headers={"Origin": origin})
with urllib.request.urlopen(bootstrap_request, timeout=min(snapshot_timeout, 20)) as response:
    bootstrap = json.loads(response.read().decode("utf-8"))
if not bootstrap.get("ok"):
    raise SystemExit("office bootstrap route did not report ok")
bootstrap_path.write_text(json.dumps(bootstrap))
session_name_path.write_text(str(bootstrap.get("tmux_session_name") or "agent-office"))

snapshot = None
snapshot_source = "n/a"
snapshot_stale = False
snapshot_error = None
for snapshot_url in (
    f"{base}/office/api/snapshot?live=1",
    f"{base}/office/api/snapshot",
):
    snapshot_request = urllib.request.Request(snapshot_url, headers={"Origin": origin})
    try:
        with urllib.request.urlopen(snapshot_request, timeout=snapshot_timeout) as response:
            snapshot_source = response.headers.get("x-office-snapshot-source") or "n/a"
            snapshot_stale = response.headers.get("x-office-snapshot-stale") == "true"
            snapshot = json.loads(response.read().decode("utf-8"))
        break
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        snapshot_error = error
        snapshot = None
        continue

if snapshot is None:
    raise SystemExit(f"office snapshot probe failed: {snapshot_error}")

acceptable_sources = {
    "direct",
    "direct-node",
    "cache",
    "cache-fallback",
    "cache-expired-fallback",
    "cache-expired-refreshing",
    "cache-throttled-live",
    "cache-refreshing-live",
    "cache-refreshing-stale",
}
if snapshot_source not in acceptable_sources:
    raise SystemExit(
        f"office snapshot source was {snapshot_source!r}, expected one of {sorted(acceptable_sources)!r}"
    )
snapshot_path.write_text(json.dumps(snapshot))
agents = snapshot.get("agents") or []
summary = snapshot.get("summary") or {}
if not agents:
    raise SystemExit("office snapshot returned no agents")
print(
    "[production] office gui: "
    f"agents={len(agents)} "
    f"source={snapshot_source} "
    f"stale={snapshot_stale} "
    f"kernel={((summary.get('kernel') or {}).get('state') or 'n/a')} "
    f"router={((summary.get('router') or {}).get('default_backend_id') or 'n/a')}"
)
PY

test -d "/Applications/Agent Office.app"
echo "[production] app launcher: /Applications/Agent Office.app present"

node ./scripts/agentic_suite_launch.mjs status > "${TMP_DIR}/office-suite-status.json"
python3 - "${TMP_DIR}/office-suite-status.json" "${TMP_DIR}/office-suite-mode.txt" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
office = data.get("office") or {}
mode = str((office.get("mode") if isinstance(office, dict) else None) or data.get("mode") or "unknown")
health = bool((office.get("health") if isinstance(office, dict) else None) if isinstance(office, dict) else data.get("health"))
office_ready = bool(
    (office.get("office_ready") if isinstance(office, dict) else None)
    if isinstance(office, dict)
    else data.get("office_ready")
)
launchable = bool(
    (office.get("launchable") if isinstance(office, dict) else None)
    if isinstance(office, dict)
    else data.get("launchable")
)
pathlib.Path(sys.argv[2]).write_text(mode)
print(
    "[production] office suite: "
    f"mode={mode} "
    f"health={health} "
    f"office_ready={office_ready} "
    f"launchable={launchable}"
)
if not data.get("ok"):
    raise SystemExit("agentic suite status did not report ok")
if not health:
    raise SystemExit("agentic suite listener is not healthy")
if not office_ready or not launchable:
    raise SystemExit("agentic suite office surface is not ready")
PY

"${REPO_ROOT}/scripts/agents_switch.sh" status > "${TMP_DIR}/agents-status.json"
python3 - "${TMP_DIR}/agents-status.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
launchd = data.get("launchd") or {}
loaded = bool(launchd.get("autonomy_keepalive_loaded"))
disabled = bool(launchd.get("autonomy_keepalive_disabled"))
operational = bool(launchd.get("autonomy_keepalive_operational"))
plist_current = bool(launchd.get("autonomy_keepalive_plist_current"))
print(
    "[production] autonomy keepalive: "
    f"loaded={loaded} "
    f"disabled={disabled} "
    f"plist_current={plist_current} "
    f"operational={operational}"
)
if not operational:
    if not plist_current:
        raise SystemExit("launchd autonomy keepalive plist is stale for the current repo path")
    if disabled:
        raise SystemExit("launchd autonomy keepalive agent is disabled")
    raise SystemExit("launchd autonomy keepalive agent is not loaded")
PY

OFFICE_SESSION_NAME="$(cat "${TMP_DIR}/office-session-name.txt")"
OFFICE_SUITE_MODE="$(cat "${TMP_DIR}/office-suite-mode.txt")"
if [[ "${OFFICE_SUITE_MODE}" == "launchd" ]]; then
  echo "[production] tmux session: skipped in launchd mode (${OFFICE_SESSION_NAME})"
else
  tmux has-session -t "${OFFICE_SESSION_NAME}"
  WINDOWS="$(tmux list-windows -t "${OFFICE_SESSION_NAME}" -F '#{window_name}')"
  echo "${WINDOWS}" | grep -qx 'office'
  echo "${WINDOWS}" | grep -qx 'briefing'
  echo "${WINDOWS}" | grep -qx 'lanes'
  echo "${WINDOWS}" | grep -qx 'workers'
  printf "[production] tmux windows (%s):\n%s\n" "${OFFICE_SESSION_NAME}" "${WINDOWS}"

  call_http trichat.tmux_controller '{"action":"status"}' > "${TMP_DIR}/tmux.json"
  python3 - "${TMP_DIR}/tmux.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
dashboard = data.get("dashboard") or {}
print(
    "[production] tmux controller: "
    f"queue_depth={dashboard.get('queue_depth')} "
    f"failure_count={dashboard.get('failure_count')} "
    f"queue_age_seconds={dashboard.get('queue_age_seconds')}"
)
PY
fi

echo "[production] readiness: PASS"
