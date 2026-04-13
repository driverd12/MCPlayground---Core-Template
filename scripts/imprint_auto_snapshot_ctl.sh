#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
case "${ACTION}" in
  status|start|stop|run_once)
    ;;
  *)
    echo "usage: $0 [status|start|stop|run_once]" >&2
    exit 2
    ;;
esac

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

PROFILE_ID="${ANAMNESIS_IMPRINT_PROFILE_ID:-default}"
INTERVAL_SECONDS="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_INTERVAL_SECONDS:-900}"
INCLUDE_RECENT_MEMORIES="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RECENT_MEMORIES:-20}"
INCLUDE_RECENT_TRANSCRIPT_LINES="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RECENT_TRANSCRIPT_LINES:-40}"
WRITE_FILE="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_WRITE_FILE:-true}"
PROMOTE_SUMMARY="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_PROMOTE_SUMMARY:-true}"
RUN_IMMEDIATELY="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RUN_IMMEDIATELY:-true}"

if [[ "${ACTION}" == "status" ]]; then
  ARGS_JSON='{"action":"status"}'
else
  NOW_TS="$(date +%s)"
  RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
  IDEMPOTENCY_KEY="imprint-auto-snapshot-${ACTION}-${NOW_TS}-${RAND_SUFFIX}"
  FINGERPRINT="imprint-auto-snapshot-fingerprint-${ACTION}-${NOW_TS}-${RAND_SUFFIX}"

  ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${ACTION}" \
"${IDEMPOTENCY_KEY}" \
"${FINGERPRINT}" \
"${PROFILE_ID}" \
"${INTERVAL_SECONDS}" \
"${INCLUDE_RECENT_MEMORIES}" \
"${INCLUDE_RECENT_TRANSCRIPT_LINES}" \
"${WRITE_FILE}" \
"${PROMOTE_SUMMARY}" \
"${RUN_IMMEDIATELY}"
const [
  action,
  idempotencyKey,
  sideEffectFingerprint,
  profileId,
  intervalSeconds,
  includeRecentMemories,
  includeRecentTranscriptLines,
  writeFile,
  promoteSummary,
  runImmediately,
] = process.argv.slice(2);

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

const payload = {
  action,
  mutation: {
    idempotency_key: idempotencyKey,
    side_effect_fingerprint: sideEffectFingerprint,
  },
};

if (action !== 'stop') {
  payload.profile_id = profileId;
  payload.interval_seconds = Number.parseInt(intervalSeconds, 10);
  payload.include_recent_memories = Number.parseInt(includeRecentMemories, 10);
  payload.include_recent_transcript_lines = Number.parseInt(includeRecentTranscriptLines, 10);
  payload.write_file = parseBoolean(writeFile, true);
  payload.promote_summary = parseBoolean(promoteSummary, true);
}

if (action === 'start') {
  payload.run_immediately = parseBoolean(runImmediately, true);
}

process.stdout.write(JSON.stringify(payload));
NODE
)"
fi

TRANSPORT="$(resolve_transport)"
TIMEOUT_MS="${MCP_TOOL_CALL_TIMEOUT_MS:-180000}"
MAX_ATTEMPTS="${MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS:-10}"
if [[ "${ACTION}" == "status" ]]; then
  TIMEOUT_MS="${IMPRINT_STATUS_TIMEOUT_MS:-6000}"
  MAX_ATTEMPTS="${IMPRINT_STATUS_HTTP_MAX_ATTEMPTS:-1}"
fi

MCP_TOOL_CALL_TIMEOUT_MS="${TIMEOUT_MS}" MCP_TOOL_CALL_HTTP_MAX_ATTEMPTS="${MAX_ATTEMPTS}" node "${REPO_ROOT}/scripts/mcp_tool_call.mjs" \
  --tool imprint.auto_snapshot \
  --args "${ARGS_JSON}" \
  --transport "${TRANSPORT}" \
  --url "${HTTP_URL}" \
  --origin "${HTTP_ORIGIN}" \
  --stdio-command "${STDIO_COMMAND}" \
  --stdio-args "${STDIO_ARGS}" \
  --cwd "${REPO_ROOT}"
