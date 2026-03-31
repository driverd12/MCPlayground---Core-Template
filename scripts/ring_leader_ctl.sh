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
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

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
      --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
      --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
      --cwd "${REPO_ROOT}" >/dev/null 2>&1; then
      printf 'http\n'
      return 0
    fi
  fi
  printf 'stdio\n'
}

TRANSPORT="$(resolve_transport)"

ensure_autonomy_entry() {
  local should_ensure="${TRICHAT_AUTONOMY_ENSURE_ON_ENTRY:-1}"
  local mode="${TRICHAT_AUTONOMY_ENSURE_MODE:-required}"
  local attempts="${TRICHAT_AUTONOMY_ENSURE_ATTEMPTS:-3}"
  local backoff_seconds="${TRICHAT_AUTONOMY_ENSURE_BACKOFF_SECONDS:-2}"
  if [[ "${ACTION}" != "start" || "${should_ensure}" == "0" ]]; then
    return 0
  fi
  local attempt=1
  while [[ "${attempt}" -le "${attempts}" ]]; do
    if "${REPO_ROOT}/scripts/autonomy_ctl.sh" ensure >/dev/null 2>&1; then
      return 0
    fi
    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${backoff_seconds}"
    fi
    attempt="$((attempt + 1))"
  done
  if [[ "${mode}" == "best_effort" ]]; then
    echo "[ring-leader] warning: autonomy bootstrap ensure failed; continuing due to TRICHAT_AUTONOMY_ENSURE_MODE=best_effort" >&2
    return 0
  fi
  echo "[ring-leader] autonomy bootstrap ensure failed before start" >&2
  exit 1
}

ensure_autonomy_entry

SPECIALIST_IDS="${TRICHAT_RING_LEADER_SPECIALIST_AGENT_IDS:-}"
if [[ -z "${SPECIALIST_IDS}" ]]; then
  SPECIALIST_IDS="$(node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const repoRoot = process.cwd();
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || path.join(repoRoot, ".env") });
const rosterPath = path.join(repoRoot, "config", "trichat_agents.json");
const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
const catalog = Array.isArray(raw.agents)
  ? raw.agents
      .filter((entry) => entry && typeof entry === "object" && entry.enabled !== false)
      .map((entry) => ({
        agent_id: String(entry.agent_id || "").trim().toLowerCase(),
        coordination_tier: String(entry.coordination_tier || "").trim().toLowerCase(),
      }))
      .filter((entry) => entry.agent_id)
  : [];
const lead = String(process.env.TRICHAT_RING_LEADER_AGENT_ID || "ring-leader").trim().toLowerCase();
const directors = catalog
  .filter((entry) => entry.agent_id !== lead && entry.coordination_tier === "director")
  .map((entry) => entry.agent_id);
const supports = catalog
  .filter((entry) => entry.agent_id !== lead && entry.coordination_tier === "support")
  .map((entry) => entry.agent_id);
const fallback = catalog
  .filter((entry) => entry.agent_id !== lead)
  .map((entry) => entry.agent_id);
const preferred = [...new Set([...directors, ...supports])];
process.stdout.write((preferred.length > 0 ? preferred : fallback).join(","));
NODE
)"
fi

resolve_dynamic_tmux_cap() {
  local field="${1:-safe_worker_count}"
  node --input-type=module - "${field}" "${REPO_ROOT}" <<'NODE'
const field = String(process.argv[2] || "safe_worker_count");
const repoRoot = String(process.argv[3] || process.cwd());
try {
  const modulePath = new URL(`file://${repoRoot}/dist/local_host_profile.js`);
  const { captureLocalHostProfile } = await import(modulePath.href);
  const profile = captureLocalHostProfile({ workspace_root: repoRoot });
  const value = Number(profile?.[field]);
  if (!Number.isFinite(value) || value <= 0) {
    process.exit(1);
  }
  process.stdout.write(String(Math.trunc(value)));
} catch {
  process.exit(1);
}
NODE
}

DEFAULT_TMUX_WORKER_COUNT="${TRICHAT_RING_LEADER_TMUX_WORKER_COUNT:-}"
if [[ -z "${DEFAULT_TMUX_WORKER_COUNT}" ]]; then
  DEFAULT_TMUX_WORKER_COUNT="$(resolve_dynamic_tmux_cap safe_worker_count 2>/dev/null || printf '4')"
fi

DEFAULT_TMUX_MAX_QUEUE_PER_WORKER="${TRICHAT_RING_LEADER_TMUX_MAX_QUEUE_PER_WORKER:-}"
if [[ -z "${DEFAULT_TMUX_MAX_QUEUE_PER_WORKER}" ]]; then
  DEFAULT_TMUX_MAX_QUEUE_PER_WORKER="$(resolve_dynamic_tmux_cap safe_max_queue_per_worker 2>/dev/null || printf '8')"
fi

if [[ "${ACTION}" == "status" ]]; then
  node ./scripts/mcp_tool_call.mjs \
    --tool trichat.autopilot \
    --args '{"action":"status"}' \
    --transport "${TRANSPORT}" \
    --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
    --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
    --stdio-command "${TRICHAT_MCP_STDIO_COMMAND:-node}" \
    --stdio-args "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}" \
    --cwd "${REPO_ROOT}"
  exit 0
fi

NOW_TS="$(date +%s)"
RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
IDEMPOTENCY_KEY="ring-leader-${ACTION}-${NOW_TS}-${RAND_SUFFIX}"
FINGERPRINT="ring-leader-${ACTION}-fingerprint-${NOW_TS}-${RAND_SUFFIX}"

ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${ACTION}" \
"${IDEMPOTENCY_KEY}" \
"${FINGERPRINT}" \
"${TRICHAT_RING_LEADER_AWAY_MODE:-normal}" \
"${TRICHAT_RING_LEADER_INTERVAL_SECONDS:-180}" \
"${TRICHAT_RING_LEADER_THREAD_ID:-ring-leader-main}" \
"${TRICHAT_RING_LEADER_THREAD_TITLE:-Ring Leader Main Loop}" \
"${TRICHAT_RING_LEADER_THREAD_STATUS:-active}" \
"${TRICHAT_RING_LEADER_OBJECTIVE:-${ANAMNESIS_IMPRINT_MISSION:-Build a hardened local-first agent system that decomposes goals, delegates to narrow specialists, and completes projects autonomously while preserving continuity and evidence.}}" \
"${TRICHAT_RING_LEADER_AGENT_ID:-ring-leader}" \
"${SPECIALIST_IDS}" \
"${TRICHAT_RING_LEADER_MAX_ROUNDS:-2}" \
"${TRICHAT_RING_LEADER_MIN_SUCCESS_AGENTS:-2}" \
  "${TRICHAT_RING_LEADER_BRIDGE_TIMEOUT_SECONDS:-90}" \
  "${TRICHAT_RING_LEADER_BRIDGE_DRY_RUN:-0}" \
  "${TRICHAT_RING_LEADER_EXECUTE_ENABLED:-1}" \
  "${TRICHAT_RING_LEADER_EXECUTE_BACKEND:-auto}" \
  "${TRICHAT_RING_LEADER_TMUX_SESSION_NAME:-ring-leader-autopilot}" \
  "${DEFAULT_TMUX_WORKER_COUNT}" \
  "${DEFAULT_TMUX_MAX_QUEUE_PER_WORKER}" \
  "${TRICHAT_RING_LEADER_TMUX_AUTO_SCALE_WORKERS:-1}" \
  "${TRICHAT_RING_LEADER_TMUX_SYNC_AFTER_DISPATCH:-1}" \
"${TRICHAT_RING_LEADER_CONFIDENCE_THRESHOLD:-0.45}" \
"${TRICHAT_RING_LEADER_MAX_CONSECUTIVE_ERRORS:-3}" \
"${TRICHAT_RING_LEADER_ADR_POLICY:-high_impact}" \
"${TRICHAT_RING_LEADER_RUN_IMMEDIATELY:-1}" \
"${TRICHAT_RING_LEADER_LOCK_KEY:-}" \
"${TRICHAT_RING_LEADER_LOCK_LEASE_SECONDS:-600}"
function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const [
  action,
  idempotencyKey,
  sideEffectFingerprint,
  awayMode,
  intervalSeconds,
  threadId,
  threadTitle,
  threadStatus,
  objective,
  leadAgentId,
  specialistIds,
  maxRounds,
  minSuccessAgents,
  bridgeTimeoutSeconds,
  bridgeDryRun,
  executeEnabled,
  executeBackend,
  tmuxSessionName,
  tmuxWorkerCount,
  tmuxMaxQueuePerWorker,
  tmuxAutoScaleWorkers,
  tmuxSyncAfterDispatch,
  confidenceThreshold,
  maxConsecutiveErrors,
  adrPolicy,
  runImmediately,
  lockKey,
  lockLeaseSeconds,
] = process.argv.slice(2);

const payload = {
  action,
  mutation: {
    idempotency_key: idempotencyKey,
    side_effect_fingerprint: sideEffectFingerprint,
  },
  away_mode: awayMode,
  interval_seconds: Number.parseInt(intervalSeconds, 10),
  thread_id: threadId,
  thread_title: threadTitle,
  thread_status: threadStatus,
  objective,
  lead_agent_id: leadAgentId,
  specialist_agent_ids: String(specialistIds || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  max_rounds: Number.parseInt(maxRounds, 10),
  min_success_agents: Number.parseInt(minSuccessAgents, 10),
  bridge_timeout_seconds: Number.parseInt(bridgeTimeoutSeconds, 10),
  bridge_dry_run: parseBoolean(bridgeDryRun, false),
  execute_enabled: parseBoolean(executeEnabled, true),
  execute_backend: executeBackend,
  tmux_session_name: tmuxSessionName,
  tmux_worker_count: Number.parseInt(tmuxWorkerCount, 10),
  tmux_max_queue_per_worker: Number.parseInt(tmuxMaxQueuePerWorker, 10),
  tmux_auto_scale_workers: parseBoolean(tmuxAutoScaleWorkers, true),
  tmux_sync_after_dispatch: parseBoolean(tmuxSyncAfterDispatch, true),
  confidence_threshold: Number.parseFloat(confidenceThreshold),
  max_consecutive_errors: Number.parseInt(maxConsecutiveErrors, 10),
  adr_policy: adrPolicy,
  lock_lease_seconds: Number.parseInt(lockLeaseSeconds, 10),
};

if (String(lockKey || "").trim()) {
  payload.lock_key = String(lockKey).trim();
}
if (action === "start") {
  payload.run_immediately = parseBoolean(runImmediately, true);
}

process.stdout.write(JSON.stringify(payload));
NODE
)"

node ./scripts/mcp_tool_call.mjs \
  --tool trichat.autopilot \
  --args "${ARGS_JSON}" \
  --transport "${TRANSPORT}" \
  --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
  --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
  --stdio-command "${TRICHAT_MCP_STDIO_COMMAND:-node}" \
  --stdio-args "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}" \
  --cwd "${REPO_ROOT}"
