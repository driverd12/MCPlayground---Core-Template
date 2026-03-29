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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mcplayground-production-readiness-XXXXXX")"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

TRICHAT_HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
TRICHAT_HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"

call_http() {
  local tool="$1"
  local args="${2:-\{\}}"
  node ./scripts/mcp_tool_call.mjs \
    --tool "${tool}" \
    --args "${args}" \
    --transport http \
    --url "${TRICHAT_HTTP_URL}" \
    --origin "${TRICHAT_HTTP_ORIGIN}" \
    --cwd "${REPO_ROOT}"
}

echo "[production] repo: ${REPO_ROOT}"
echo "[production] node: $(node -v)"
echo "[production] python: $(python3 --version 2>&1)"
echo "[production] mcp url: ${TRICHAT_HTTP_URL}"

call_http autonomy.bootstrap '{"action":"status"}' > "${TMP_DIR}/autonomy.json"
python3 - "${TMP_DIR}/autonomy.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(
    "[production] autonomy bootstrap: "
    f"ready={data.get('self_start_ready')} "
    f"attention={','.join(data.get('repairs_needed', [])) or 'none'}"
)
if not data.get("self_start_ready"):
    raise SystemExit("autonomy bootstrap is not self-start ready")
PY

call_http autonomy.maintain '{"action":"status"}' > "${TMP_DIR}/autonomy-maintain.json"
python3 - "${TMP_DIR}/autonomy-maintain.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
state = data.get("state") or {}
due = data.get("due") or {}
goal_autorun = data.get("goal_autorun_daemon") or {}
print(
    "[production] autonomy maintain: "
    f"enabled={state.get('enabled')} "
    f"last_run_at={state.get('last_run_at') or 'n/a'} "
    f"stale={due.get('stale')} "
    f"eval_due={due.get('eval')} "
    f"goal_autorun_running={goal_autorun.get('running')}"
)
if not state.get("enabled"):
    raise SystemExit("autonomy.maintain has not persisted an enabled background state yet")
if not state.get("last_run_at"):
    raise SystemExit("autonomy.maintain has not recorded a keepalive run yet")
if due.get("stale"):
    raise SystemExit("autonomy.maintain state is stale")
if not goal_autorun.get("running"):
    raise SystemExit("goal.autorun_daemon is not running under autonomy maintenance")
PY

call_http model.router '{}' > "${TMP_DIR}/model-router.json"
python3 - "${TMP_DIR}/model-router.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
state = data.get("state") or {}
backends = state.get("backends") or []
print(
    "[production] model router: "
    f"enabled={state.get('enabled')} "
    f"backends={len(backends)} "
    f"default={state.get('default_backend_id')}"
)
if not state.get("enabled") or not backends:
    raise SystemExit("model.router is not enabled with at least one backend")
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
required_clients = {"codex", "cursor", "gemini-cli", "github-copilot-cli", "chatgpt-developer-mode"}
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
active_sessions = overview.get("active_session_count", 0)
healthy = adaptive.get("healthy", 0)
degraded = adaptive.get("degraded", 0)
print(f"[production] kernel state: {data.get('state')} active_sessions={active_sessions} healthy={healthy} degraded={degraded}")
if active_sessions < 1 or healthy < 1:
    raise SystemExit(1)
PY
  then
    kernel_ok=1
    break
  fi
  sleep 0.5
done

if [[ "${kernel_ok}" -ne 1 ]]; then
  echo "[production] kernel summary never reported an active healthy session after retry window" >&2
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

test -d "/Applications/Agent Office.app"
echo "[production] app launcher: /Applications/Agent Office.app present"

AGENTS_STATUS_JSON="$("${REPO_ROOT}/scripts/agents_switch.sh" status)"
python3 - "${AGENTS_STATUS_JSON}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
loaded = bool(((data.get("launchd") or {}).get("autonomy_keepalive_loaded")))
print(f"[production] autonomy keepalive loaded: {loaded}")
if not loaded:
    raise SystemExit("launchd autonomy keepalive agent is not loaded")
PY

tmux has-session -t agent-office
WINDOWS="$(tmux list-windows -t agent-office -F '#{window_name}')"
echo "${WINDOWS}" | grep -qx 'office'
echo "${WINDOWS}" | grep -qx 'briefing'
echo "${WINDOWS}" | grep -qx 'lanes'
echo "${WINDOWS}" | grep -qx 'workers'
printf "[production] tmux windows:\n%s\n" "${WINDOWS}"

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

echo "[production] readiness: PASS"
