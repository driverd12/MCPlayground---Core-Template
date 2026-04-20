#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/autonomy_ide_ingress.sh [options] -- <objective>
  ./scripts/autonomy_ide_ingress.sh [options] <objective>

Options:
  --title <text>         Human-friendly goal title.
  --session <id>         Continuity/transcript session id.
  --thread <id>          TriChat thread id to mirror into.
  --thread-title <text>  TriChat thread title to mirror into.
  --agent <id>           Explicit TriChat/bridge agent target. Repeatable.
  --risk <tier>          low | medium | high | critical.
  --mode <mode>          observe | recommend | stage | execute_bounded | execute_destructive_with_approval.
                         Omit to use the control-plane default (Patient Zero elevates this automatically).
  --tag <text>           Add a goal tag. Repeatable.
  --accept <text>        Add an acceptance criterion. Repeatable.
  --constraint <text>    Add a constraint. Repeatable.
  --assumption <text>    Add an assumption. Repeatable.
  --dry-run              Build the durable goal/plan but do not continue background execution.
  --no-daemon            Do not align/start the goal autorun daemon.
  --no-ensure            Do not run autonomy.bootstrap ensure before intake.
  --no-memory            Do not persist a distilled memory note.
  --no-transcript        Do not append transcript continuity.
  --no-thread            Do not mirror the objective into a TriChat thread.
  -h, --help             Show help.

Environment:
  TRICHAT_VISIBLE_CLAUDE_MIRROR_ON_INGRESS=1
                        On macOS, after durable intake succeeds, mirror explicit
                        Claude-targeted ingress into the visible Claude terminal.
                        This is operator-visible only; MCP artifacts remain
                        canonical.
  TRICHAT_VISIBLE_CLAUDE_MIRROR_DEDUPE_WINDOW_SECONDS
                        Skip repeated mirrors for the same objective within this
                        window. Default: 900.
  TRICHAT_VISIBLE_CLAUDE_MIRROR_MIN_INTERVAL_SECONDS
                        Global burst throttle between visible Claude mirrors.
                        Default: 20.
USAGE
}

TITLE=""
SESSION_ID=""
THREAD_ID="${TRICHAT_AUTONOMY_INGRESS_THREAD_ID:-}"
THREAD_TITLE="${TRICHAT_AUTONOMY_INGRESS_THREAD_TITLE:-}"
RISK_TIER="${TRICHAT_AUTONOMY_COMMAND_RISK_TIER:-medium}"
AUTONOMY_MODE="${TRICHAT_AUTONOMY_COMMAND_MODE:-}"
DRY_RUN=0
START_DAEMON=1
ENSURE_BOOTSTRAP=1
APPEND_MEMORY=1
APPEND_TRANSCRIPT=1
MIRROR_TO_THREAD=1
OBJECTIVE_PARTS=()
declare -a TAGS=()
declare -a TARGET_AGENTS=()
declare -a ACCEPTANCE=()
declare -a CONSTRAINTS=()
declare -a ASSUMPTIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --session)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --thread)
      THREAD_ID="${2:-}"
      shift 2
      ;;
    --thread-title)
      THREAD_TITLE="${2:-}"
      shift 2
      ;;
    --agent)
      TARGET_AGENTS+=("${2:-}")
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
    --no-memory)
      APPEND_MEMORY=0
      shift
      ;;
    --no-transcript)
      APPEND_TRANSCRIPT=0
      shift
      ;;
    --no-thread)
      MIRROR_TO_THREAD=0
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
IDEMPOTENCY_KEY="autonomy-ide-ingress-${NOW_TS}-${RAND_SUFFIX}"
FINGERPRINT="autonomy-ide-ingress-fingerprint-${NOW_TS}-${RAND_SUFFIX}"

TAGS_JSON="$(array_to_json "${TAGS[@]-}")"
TARGET_AGENTS_JSON="$(array_to_json "${TARGET_AGENTS[@]-}")"
ACCEPTANCE_JSON="$(array_to_json "${ACCEPTANCE[@]-}")"
CONSTRAINTS_JSON="$(array_to_json "${CONSTRAINTS[@]-}")"
ASSUMPTIONS_JSON="$(array_to_json "${ASSUMPTIONS[@]-}")"

ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${IDEMPOTENCY_KEY}" \
"${FINGERPRINT}" \
"${OBJECTIVE}" \
"${TITLE}" \
"${SESSION_ID}" \
"${THREAD_ID}" \
"${THREAD_TITLE}" \
"${RISK_TIER}" \
"${AUTONOMY_MODE}" \
"${DRY_RUN}" \
"${START_DAEMON}" \
"${ENSURE_BOOTSTRAP}" \
"${APPEND_MEMORY}" \
"${APPEND_TRANSCRIPT}" \
"${MIRROR_TO_THREAD}" \
"${TAGS_JSON}" \
"${TARGET_AGENTS_JSON}" \
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
  sessionId,
  threadId,
  threadTitle,
  riskTier,
  autonomyMode,
  dryRun,
  startDaemon,
  ensureBootstrap,
  appendMemory,
  appendTranscript,
  mirrorToThread,
  tagsArg,
  targetAgentsArg,
  acceptanceArg,
  constraintsArg,
  assumptionsArg,
] = process.argv.slice(2);
const targetAgentIds = JSON.parse(targetAgentsArg || "[]");

process.stdout.write(
  JSON.stringify({
    mutation: {
      idempotency_key: idempotencyKey,
      side_effect_fingerprint: sideEffectFingerprint,
    },
    objective,
    title: title || undefined,
    session_id: sessionId || undefined,
    thread_id: threadId || undefined,
    thread_title: threadTitle || undefined,
    risk_tier: riskTier || undefined,
    autonomy_mode: autonomyMode || undefined,
    dry_run: parseBoolean(dryRun, false),
    start_goal_autorun_daemon: parseBoolean(startDaemon, true),
    ensure_bootstrap: parseBoolean(ensureBootstrap, true),
    append_memory: parseBoolean(appendMemory, true),
    append_transcript: parseBoolean(appendTranscript, true),
    mirror_to_thread: parseBoolean(mirrorToThread, true),
    tags: JSON.parse(tagsArg || "[]"),
    trichat_agent_ids: Array.isArray(targetAgentIds) && targetAgentIds.length > 0 ? targetAgentIds : undefined,
    acceptance_criteria: JSON.parse(acceptanceArg || "[]"),
    constraints: JSON.parse(constraintsArg || "[]"),
    assumptions: JSON.parse(assumptionsArg || "[]"),
    source_client: "autonomy_ide_ingress.sh",
  })
);
NODE
)"

has_explicit_claude_target() {
  local agent_id=""
  for agent_id in "${TARGET_AGENTS[@]-}"; do
    case "${agent_id,,}" in
      *claude*)
        return 0
        ;;
    esac
  done
  return 1
}

visible_claude_mirror_enabled() {
  case "${TRICHAT_VISIBLE_CLAUDE_MIRROR_ON_INGRESS:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      ;;
    *)
      return 1
      ;;
  esac
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  [[ -x "${REPO_ROOT}/scripts/claude_code_terminal_send.sh" ]] || return 1
  [[ "${DRY_RUN}" != "1" ]] || return 1
  has_explicit_claude_target
}

visible_claude_mirror_state_dir() {
  printf '%s\n' "${REPO_ROOT}/data/runtime/visible_claude_mirror"
}

visible_claude_mirror_hash() {
  node --input-type=module - "${OBJECTIVE}" "${TITLE}" "${RISK_TIER}" "${THREAD_ID}" "${SESSION_ID}" "${TARGET_AGENTS_JSON}" <<'NODE'
import crypto from "node:crypto";

const [objective, title, riskTier, threadId, sessionId, targetAgentsJson] = process.argv.slice(2);
const hash = crypto
  .createHash("sha256")
  .update(
    JSON.stringify({
      objective,
      title,
      riskTier,
      threadId,
      sessionId,
      targetAgents: JSON.parse(targetAgentsJson || "[]"),
    }),
  )
  .digest("hex");
process.stdout.write(hash);
NODE
}

visible_claude_mirror_file_age_seconds() {
  local path="$1"
  local now_ts=""
  local modified_ts=""
  [[ -f "${path}" ]] || return 1
  now_ts="$(date +%s)"
  modified_ts="$(stat -f %m "${path}" 2>/dev/null || true)"
  [[ -n "${modified_ts}" ]] || return 1
  printf '%s\n' "$(( now_ts - modified_ts ))"
}

should_skip_visible_claude_mirror() {
  local mirror_id="$1"
  local state_dir=""
  local dedupe_file=""
  local burst_file=""
  local dedupe_window="${TRICHAT_VISIBLE_CLAUDE_MIRROR_DEDUPE_WINDOW_SECONDS:-900}"
  local min_interval="${TRICHAT_VISIBLE_CLAUDE_MIRROR_MIN_INTERVAL_SECONDS:-20}"
  local dedupe_age=""
  local last_sent_at=""
  local now_ts="$(date +%s)"
  state_dir="$(visible_claude_mirror_state_dir)"
  dedupe_file="${state_dir}/${mirror_id}.stamp"
  burst_file="${state_dir}/last_sent_at"
  mkdir -p "${state_dir}"
  dedupe_age="$(visible_claude_mirror_file_age_seconds "${dedupe_file}" || true)"
  if [[ -n "${dedupe_age}" && "${dedupe_age}" -lt "${dedupe_window}" ]]; then
    return 0
  fi
  if [[ -f "${burst_file}" ]]; then
    last_sent_at="$(tr -cd '0-9' < "${burst_file}" || true)"
    if [[ -n "${last_sent_at}" && $(( now_ts - last_sent_at )) -lt "${min_interval}" ]]; then
      return 0
    fi
  fi
  return 1
}

mark_visible_claude_mirror_sent() {
  local mirror_id="$1"
  local state_dir=""
  state_dir="$(visible_claude_mirror_state_dir)"
  mkdir -p "${state_dir}"
  : > "${state_dir}/${mirror_id}.stamp"
  printf '%s\n' "$(date +%s)" > "${state_dir}/last_sent_at"
}

extract_visible_claude_feedback() {
  local capture_file="$1"
  local mirror_id="$2"
  node --input-type=module - "${capture_file}" "${mirror_id}" <<'NODE'
import fs from "node:fs";

const [captureFile, mirrorId] = process.argv.slice(2);
const raw = fs.readFileSync(captureFile, "utf8");
const marker = `Mirror ID: ${mirrorId}.`;
const markerIndex = raw.lastIndexOf(marker);
if (markerIndex < 0) process.exit(0);
const tail = raw.slice(markerIndex);
const assistantIndex = tail.indexOf("⏺");
if (assistantIndex < 0) process.exit(0);
let response = tail.slice(assistantIndex).trim();
const nextPromptIndex = response.indexOf("\n❯");
if (nextPromptIndex >= 0) {
  response = response.slice(0, nextPromptIndex).trim();
}
response = response.replace(/^⏺\s*/u, "").trim();
response = response.replace(/\n{3,}/g, "\n\n");
if (!response) process.exit(0);
process.stdout.write(response);
NODE
}

persist_visible_claude_feedback() {
  local raw_response_file="$1"
  local mirror_id="$2"
  local feedback_file="$3"
  local args_json=""
  [[ -s "${feedback_file}" ]] || return 0
  args_json="$(node --input-type=module - "${raw_response_file}" "${feedback_file}" "${mirror_id}" "${OBJECTIVE}" "${TITLE}" "${RISK_TIER}" <<'NODE'
import fs from "node:fs";

const [rawResponseFile, feedbackFile, mirrorId, objective, title, riskTier] = process.argv.slice(2);
const response = JSON.parse(fs.readFileSync(rawResponseFile, "utf8"));
const feedback = fs.readFileSync(feedbackFile, "utf8").trim();
if (!feedback) process.exit(0);
const effectiveAgentIds = Array.isArray(response.effective_trichat_agent_ids)
  ? response.effective_trichat_agent_ids
  : [];
process.stdout.write(
  JSON.stringify({
    mutation: {
      idempotency_key: `visible-claude-feedback-${mirrorId}`,
      side_effect_fingerprint: `visible-claude-feedback-${mirrorId}`,
      confirm: true,
    },
    content: [
      "Visible Claude sidecar critique captured after durable autonomy.ide_ingress succeeded.",
      title ? `Title: ${title}.` : null,
      `Risk: ${riskTier || "medium"}.`,
      response.session_id ? `Session: ${response.session_id}.` : null,
      response.thread_id ? `Thread: ${response.thread_id}.` : null,
      effectiveAgentIds.length > 0 ? `Agents: ${effectiveAgentIds.join(", ")}.` : null,
      `Mirror ID: ${mirrorId}.`,
      `Objective: ${objective}.`,
      `Claude feedback: ${feedback}`,
    ]
      .filter(Boolean)
      .join(" "),
    keywords: [
      "claude",
      "codex",
      "visible-sidecar",
      "autonomy-ide-ingress",
      "mirror-feedback",
      `mirror-${mirrorId.slice(0, 12)}`,
    ],
  }),
);
NODE
)" || return 0
  [[ -n "${args_json// }" ]] || return 0
  node ./scripts/mcp_tool_call.mjs \
    --tool memory.append \
    --args "${args_json}" \
    --transport "${TRANSPORT}" \
    --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
    --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
    --stdio-command "${TRICHAT_MCP_STDIO_COMMAND:-node}" \
    --stdio-args "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}" \
    --cwd "${REPO_ROOT}" >/dev/null 2>&1 || true
}

maybe_mirror_visible_claude() {
  local raw_response_file="$1"
  local prompt=""
  local mirror_id=""
  local capture_file=""
  local feedback_file=""
  visible_claude_mirror_enabled || return 0
  mirror_id="$(visible_claude_mirror_hash)"
  should_skip_visible_claude_mirror "${mirror_id}" && return 0
  capture_file="$(mktemp "${TMPDIR:-/tmp}/visible-claude-capture.XXXXXX.txt")"
  feedback_file="$(mktemp "${TMPDIR:-/tmp}/visible-claude-feedback.XXXXXX.txt")"
  prompt="$(TRICHAT_VISIBLE_CLAUDE_ACTIVE_MIRROR_ID="${mirror_id}" node --input-type=module - "${raw_response_file}" "${OBJECTIVE}" "${TITLE}" "${RISK_TIER}" <<'NODE'
import fs from "node:fs";

const [rawResponseFile, objective, title, riskTier] = process.argv.slice(2);
const raw = fs.readFileSync(rawResponseFile, "utf8").trim();
if (!raw) process.exit(0);
const parsed = JSON.parse(raw);
if (parsed?.ok !== true) process.exit(0);
const effectiveAgentIds = Array.isArray(parsed.effective_trichat_agent_ids) ? parsed.effective_trichat_agent_ids : [];
if (!effectiveAgentIds.some((value) => String(value || "").toLowerCase().includes("claude"))) {
  process.exit(0);
}
const segments = [
  "Codex routed and persisted a MASTER-MOLD objective through autonomy.ide_ingress.",
  "Treat MCP artifacts, TriChat records, and SQLite-backed state as the source of truth.",
  "Use this visible terminal as an operator-facing sidecar only.",
];
if (title && title.trim()) {
  segments.push(`Title: ${title.trim()}.`);
}
segments.push(`Risk: ${(riskTier || "medium").trim()}.`);
segments.push(`Objective: ${String(objective || "").trim()}.`);
segments.push(`Mirror ID: ${process.env.TRICHAT_VISIBLE_CLAUDE_ACTIVE_MIRROR_ID || ""}.`);
segments.push("Reply with exactly three bullets: critique, missing evidence, next bounded action.");
process.stdout.write(segments.join(" "));
NODE
)" || { rm -f "${capture_file}" "${feedback_file}"; return 0; }
  if [[ -z "${prompt// }" ]]; then
    rm -f "${capture_file}" "${feedback_file}"
    return 0
  fi
  if ! "${REPO_ROOT}/scripts/claude_code_terminal_send.sh" \
      --prompt "${prompt}" \
      --wait-seconds "${TRICHAT_VISIBLE_CLAUDE_CAPTURE_WAIT_SECONDS:-8}" \
      --capture-file "${capture_file}" \
      --capture-tail-lines "${TRICHAT_VISIBLE_CLAUDE_CAPTURE_TAIL_LINES:-160}" >/dev/null 2>&1; then
    rm -f "${capture_file}" "${feedback_file}"
    return 0
  fi
  mark_visible_claude_mirror_sent "${mirror_id}"
  if extract_visible_claude_feedback "${capture_file}" "${mirror_id}" > "${feedback_file}" 2>/dev/null; then
    persist_visible_claude_feedback "${raw_response_file}" "${mirror_id}" "${feedback_file}"
  fi
  rm -f "${capture_file}" "${feedback_file}"
}

RAW_RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/autonomy-ide-ingress-response.XXXXXX.json")"
cleanup() {
  rm -f "${RAW_RESPONSE_FILE}"
}
trap cleanup EXIT

node ./scripts/mcp_tool_call.mjs \
  --tool autonomy.ide_ingress \
  --args "${ARGS_JSON}" \
  --transport "${TRANSPORT}" \
  --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
  --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
  --stdio-command "${TRICHAT_MCP_STDIO_COMMAND:-node}" \
  --stdio-args "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}" \
  --cwd "${REPO_ROOT}" > "${RAW_RESPONSE_FILE}"

node --input-type=module -e '
import fs from "node:fs";

function summarizeRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  const summary = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      summary[key] = record[key];
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function summarizeAutonomy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  return {
    ok: record.ok === true,
    goal: summarizeRecord(record.goal, ["goal_id", "title", "status"]),
    plan: summarizeRecord(record.plan, ["plan_id", "title", "status"]),
    execution: summarizeRecord(record.execution, ["ok", "dry_run", "continued", "status"]),
    goal_autorun_daemon: summarizeRecord(record.goal_autorun_daemon, ["action", "status"]),
    next_action: record.next_action ?? null,
  };
}

const raw = fs.readFileSync(0, "utf8").trim();
const parsed = JSON.parse(raw);
const payload = {
  ok: parsed.ok === true,
  title: parsed.title ?? null,
  source: parsed.source ?? null,
  session_id: parsed.session_id ?? null,
  thread_id: parsed.thread_id ?? null,
  thread_title: parsed.thread_title ?? null,
  effective_trichat_agent_ids: Array.isArray(parsed.effective_trichat_agent_ids)
    ? parsed.effective_trichat_agent_ids
    : [],
  transcript: summarizeRecord(parsed.transcript, ["ok", "session_id", "entry_id"]),
  thread: summarizeRecord(parsed.thread, ["ok", "thread_id", "title", "status"]),
  message: summarizeRecord(parsed.message, ["ok", "thread_id", "message_id", "role", "agent_id"]),
  turn: summarizeRecord(parsed.turn, ["ok", "thread_id", "turn_id", "status", "user_message_id"]),
  memory: summarizeRecord(parsed.memory, ["ok", "note_id", "trust_tier"]),
  event: summarizeRecord(parsed.event, ["ok", "event_id", "event_type", "status", "entity_id"]),
  autonomy: summarizeAutonomy(parsed.autonomy),
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
' < "${RAW_RESPONSE_FILE}"

maybe_mirror_visible_claude "${RAW_RESPONSE_FILE}"
