#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/autonomy_command.sh [options] -- <objective>
  ./scripts/autonomy_command.sh [options] <objective>

Options:
  --title <text>         Human-friendly goal title.
  --risk <tier>          low | medium | high | critical.
  --mode <mode>          observe | recommend | stage | execute_bounded | execute_destructive_with_approval.
  --tag <text>           Add a goal tag. Repeatable.
  --accept <text>        Add an acceptance criterion. Repeatable.
  --constraint <text>    Add a constraint. Repeatable.
  --assumption <text>    Add an assumption. Repeatable.
  --dry-run              Build the durable goal/plan but do not continue background execution.
  --no-daemon            Do not align/start the goal autorun daemon.
  --no-ensure            Do not run autonomy.bootstrap ensure before intake.
  -h, --help             Show help.
USAGE
}

TITLE=""
RISK_TIER="${TRICHAT_AUTONOMY_COMMAND_RISK_TIER:-medium}"
AUTONOMY_MODE="${TRICHAT_AUTONOMY_COMMAND_MODE:-execute_bounded}"
DRY_RUN=0
START_DAEMON=1
ENSURE_BOOTSTRAP=1
OBJECTIVE_PARTS=()
declare -a TAGS=()
declare -a ACCEPTANCE=()
declare -a CONSTRAINTS=()
declare -a ASSUMPTIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --risk)
      RISK_TIER="${2:-}"
      shift 2
      ;;
    --mode)
      AUTONOMY_MODE="${2:-}"
      shift 2
      ;;
    --tag)
      TAGS+=("${2:-}")
      shift 2
      ;;
    --accept)
      ACCEPTANCE+=("${2:-}")
      shift 2
      ;;
    --constraint)
      CONSTRAINTS+=("${2:-}")
      shift 2
      ;;
    --assumption)
      ASSUMPTIONS+=("${2:-}")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-daemon)
      START_DAEMON=0
      shift
      ;;
    --no-ensure)
      ENSURE_BOOTSTRAP=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      OBJECTIVE_PARTS+=("$@")
      break
      ;;
    *)
      OBJECTIVE_PARTS+=("$1")
      shift
      ;;
  esac
done

OBJECTIVE="${OBJECTIVE_PARTS[*]:-}"
if [[ -z "${OBJECTIVE// }" ]]; then
  usage >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN+x}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

resolve_transport() {
  local preferred="${TRICHAT_RING_LEADER_TRANSPORT:-${TRICHAT_MCP_TRANSPORT:-}}"
  if [[ -n "${preferred}" ]]; then
    printf '%s\n' "${preferred}"
    return 0
  fi
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    if node ./scripts/mcp_tool_call.mjs \
      --tool health.storage \
      --args '{}' \
      --transport http \
      --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
      --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
      --cwd "${REPO_ROOT}" >/dev/null 2>&1; then
      printf 'http\n'
      return 0
    fi
  fi
  printf 'stdio\n'
}

array_to_json() {
  printf '%s\n' "$@" | node --input-type=module -e '
const fs = await import("node:fs");
const values = fs.readFileSync(0, "utf8").split(/\n/).map((entry) => entry.trim()).filter(Boolean);
process.stdout.write(JSON.stringify(values));
'
}

TRANSPORT="$(resolve_transport)"
if [[ "${TRANSPORT}" == "stdio" && "${START_DAEMON}" == "1" ]]; then
  START_DAEMON=0
fi

if [[ "${ENSURE_BOOTSTRAP}" == "1" ]]; then
  "${REPO_ROOT}/scripts/autonomy_ctl.sh" ensure >/dev/null
  ENSURE_BOOTSTRAP=0
fi

NOW_TS="$(date +%s)"
RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
IDEMPOTENCY_KEY="autonomy-command-${NOW_TS}-${RAND_SUFFIX}"
FINGERPRINT="autonomy-command-fingerprint-${NOW_TS}-${RAND_SUFFIX}"

TAGS_JSON="$(array_to_json "${TAGS[@]-}")"
ACCEPTANCE_JSON="$(array_to_json "${ACCEPTANCE[@]-}")"
CONSTRAINTS_JSON="$(array_to_json "${CONSTRAINTS[@]-}")"
ASSUMPTIONS_JSON="$(array_to_json "${ASSUMPTIONS[@]-}")"

ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${IDEMPOTENCY_KEY}" \
"${FINGERPRINT}" \
"${OBJECTIVE}" \
"${TITLE}" \
"${RISK_TIER}" \
"${AUTONOMY_MODE}" \
"${DRY_RUN}" \
"${START_DAEMON}" \
"${ENSURE_BOOTSTRAP}" \
"${TAGS_JSON}" \
"${ACCEPTANCE_JSON}" \
"${CONSTRAINTS_JSON}" \
"${ASSUMPTIONS_JSON}"
function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const [
  idempotencyKey,
  sideEffectFingerprint,
  objective,
  title,
  riskTier,
  autonomyMode,
  dryRun,
  startDaemon,
  ensureBootstrap,
  tagsArg,
  acceptanceArg,
  constraintsArg,
  assumptionsArg,
] = process.argv.slice(2);

process.stdout.write(
  JSON.stringify({
    mutation: {
      idempotency_key: idempotencyKey,
      side_effect_fingerprint: sideEffectFingerprint,
    },
    objective,
    title: title || undefined,
    risk_tier: riskTier || undefined,
    autonomy_mode: autonomyMode || undefined,
    dry_run: parseBoolean(dryRun, false),
    start_goal_autorun_daemon: parseBoolean(startDaemon, true),
    ensure_bootstrap: parseBoolean(ensureBootstrap, true),
    tags: JSON.parse(tagsArg || "[]"),
    acceptance_criteria: JSON.parse(acceptanceArg || "[]"),
    constraints: JSON.parse(constraintsArg || "[]"),
    assumptions: JSON.parse(assumptionsArg || "[]"),
    source_client: "autonomy_command.sh",
  })
);
NODE
)"

node ./scripts/autonomy_command_client.mjs \
  "${TRANSPORT}" \
  "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
  "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
  "${TRICHAT_MCP_STDIO_COMMAND:-node}" \
  "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}" \
  "${REPO_ROOT}" \
  "${ARGS_JSON}"
