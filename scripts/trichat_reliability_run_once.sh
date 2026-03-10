#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/data/imprint/reliability"
mkdir -p "${RUNTIME_DIR}"

THREAD_ID="${ANAMNESIS_TRICHAT_RELIABILITY_THREAD_ID:-trichat-reliability-internal}"
PROMPT="${ANAMNESIS_TRICHAT_RELIABILITY_PROMPT:-Internal reliability heartbeat: evaluate adapter availability, orchestration health, and one concrete stabilization recommendation.}"
AGENTS="${ANAMNESIS_TRICHAT_RELIABILITY_AGENTS:-codex,cursor,local-imprint}"
DRY_RUN="${ANAMNESIS_TRICHAT_RELIABILITY_DRY_RUN:-true}"
EXECUTE="${ANAMNESIS_TRICHAT_RELIABILITY_EXECUTE:-false}"
REQUIRE_SUCCESS_AGENTS="${ANAMNESIS_TRICHAT_RELIABILITY_REQUIRE_SUCCESS_AGENTS:-0}"
BRIDGE_TIMEOUT="${ANAMNESIS_TRICHAT_RELIABILITY_BRIDGE_TIMEOUT:-180}"
RETENTION_DAYS="${ANAMNESIS_TRICHAT_RELIABILITY_RETENTION_DAYS:-3}"
RETENTION_LIMIT="${ANAMNESIS_TRICHAT_RELIABILITY_RETENTION_LIMIT:-2000}"
VERIFY_COMMAND="${ANAMNESIS_TRICHAT_RELIABILITY_VERIFY_COMMAND:-}"

export TRICHAT_BRIDGE_DRY_RUN="${DRY_RUN}"
export TRICHAT_DOGFOOD_THREAD_ID="${THREAD_ID}"
export TRICHAT_DOGFOOD_PROMPT="${PROMPT}"
export TRICHAT_DOGFOOD_AGENTS="${AGENTS}"
export TRICHAT_DOGFOOD_EXECUTE="${EXECUTE}"
export TRICHAT_DOGFOOD_REQUIRE_SUCCESS_AGENTS="${REQUIRE_SUCCESS_AGENTS}"
export TRICHAT_DOGFOOD_BRIDGE_TIMEOUT="${BRIDGE_TIMEOUT}"
export TRICHAT_DOGFOOD_KEEP_ACTIVE="false"
export TRICHAT_DOGFOOD_THREAD_STATUS="archived"
export TRICHAT_DOGFOOD_RETENTION_DAYS="${RETENTION_DAYS}"
export TRICHAT_DOGFOOD_RETENTION_APPLY="true"
export TRICHAT_DOGFOOD_RETENTION_LIMIT="${RETENTION_LIMIT}"
if [[ -n "${VERIFY_COMMAND}" ]]; then
  export TRICHAT_DOGFOOD_VERIFY_COMMAND="${VERIFY_COMMAND}"
fi

REPORT_PATH="${RUNTIME_DIR}/last_report.json"
HISTORY_PATH="${RUNTIME_DIR}/history.ndjson"

TMP_OUTPUT="$(mktemp)"
cleanup() {
  rm -f "${TMP_OUTPUT}"
}
trap cleanup EXIT

if node "${REPO_ROOT}/scripts/trichat_dogfood.mjs" --cycles 1 >"${TMP_OUTPUT}" 2>&1; then
  cp "${TMP_OUTPUT}" "${REPORT_PATH}"
  node --input-type=module - "${TMP_OUTPUT}" "${HISTORY_PATH}" <<'NODE'
import fs from "node:fs";

const [reportPath, historyPath] = process.argv.slice(2);
const raw = fs.readFileSync(reportPath, "utf8");
const report = JSON.parse(raw);
const cycle = Array.isArray(report.cycles) && report.cycles.length > 0 ? report.cycles[report.cycles.length - 1] : {};
const entry = {
  timestamp: new Date().toISOString(),
  ok: report.ok === true,
  thread_id: report.thread_id ?? null,
  cycle: cycle.cycle ?? null,
  turn_id: cycle.turn_id ?? null,
  success_agents: cycle.success_agents ?? null,
  total_agents: cycle.total_agents ?? null,
  novelty_score: cycle.novelty_score ?? null,
  novelty_retry_required: cycle.novelty_retry_required ?? null,
  novelty_retry_suppressed: cycle.novelty_retry_suppressed ?? null,
  novelty_retry_suppression_reason: cycle.novelty_retry_suppression_reason ?? null,
  novelty_retry_suppression_reference_turn_id: cycle.novelty_retry_suppression_reference_turn_id ?? null,
  selected_agent: cycle.selected_agent ?? null,
  verify_status: cycle.verify_status ?? null,
  task_id: cycle.task_id ?? null,
  consensus_latest_status: cycle.consensus_latest_status ?? null,
  workboard_active_phase: cycle.workboard_active_phase ?? null,
};
fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
NODE
  exit 0
fi

cp "${TMP_OUTPUT}" "${REPORT_PATH}" || true
cat "${TMP_OUTPUT}" >&2
exit 1
