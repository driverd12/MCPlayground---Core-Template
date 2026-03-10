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
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
LABEL="com.anamnesis.trichat.reliabilityloop"
PLIST="${LAUNCH_DIR}/${LABEL}.plist"
LAST_REPORT_PATH="${REPO_ROOT}/data/imprint/reliability/last_report.json"

is_loaded() {
  launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1
}

bootout_if_exists() {
  if [[ -f "${PLIST}" ]]; then
    launchctl bootout "${DOMAIN}" "${PLIST}" >/dev/null 2>&1 || true
  fi
}

bootstrap_if_exists() {
  if [[ -f "${PLIST}" ]]; then
    launchctl bootstrap "${DOMAIN}" "${PLIST}" >/dev/null 2>&1 || true
  fi
}

case "${ACTION}" in
  run_once)
    "${REPO_ROOT}/scripts/trichat_reliability_run_once.sh"
    exit $?
    ;;
  start)
    if [[ ! -f "${PLIST}" ]]; then
      echo "error: ${PLIST} not found. Install with ANAMNESIS_TRICHAT_RELIABILITY_LOOP_ENABLED=true ./scripts/launchd_install.sh" >&2
      exit 2
    fi
    launchctl enable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    bootout_if_exists
    bootstrap_if_exists
    launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    ;;
  stop)
    bootout_if_exists
    launchctl disable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    ;;
  status)
    ;;
esac

LOADED=false
if is_loaded; then
  LOADED=true
fi

node --input-type=module - <<'NODE' \
"${ACTION}" \
"${DOMAIN}" \
"${LABEL}" \
"${PLIST}" \
"${LOADED}" \
"${LAST_REPORT_PATH}"
import fs from "node:fs";

const [action, domain, label, plist, loaded, lastReportPath] = process.argv.slice(2);
let lastReport = null;
if (fs.existsSync(lastReportPath)) {
  try {
    lastReport = JSON.parse(fs.readFileSync(lastReportPath, "utf8"));
  } catch {
    lastReport = { parse_error: true };
  }
}

const payload = {
  ok: true,
  action,
  domain,
  label,
  plist,
  installed: fs.existsSync(plist),
  loaded: loaded === "true",
  last_report_path: lastReportPath,
  last_report: lastReport,
};
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE
