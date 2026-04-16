#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.mcplayground.mcp.server"
AUTO_LABEL="com.mcplayground.imprint.autosnapshot"
WORKER_LABEL="com.mcplayground.imprint.inboxworker"
KEEPALIVE_LABEL="com.mcplayground.autonomy.keepalive"
WATCHDOG_LABEL="com.mcplayground.local-adapter.watchdog"
OFFICE_GUI_LABEL="com.mcplayground.agent-office.gui.watch"
MLX_LABEL="com.mcplayground.mlx.server"

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"
KEEPALIVE_PLIST="${LAUNCH_DIR}/${KEEPALIVE_LABEL}.plist"
WATCHDOG_PLIST="${LAUNCH_DIR}/${WATCHDOG_LABEL}.plist"
OFFICE_GUI_PLIST="${LAUNCH_DIR}/${OFFICE_GUI_LABEL}.plist"
MLX_PLIST="${LAUNCH_DIR}/${MLX_LABEL}.plist"

bootout_service_target() {
  local label="$1"
  launchctl bootout "${DOMAIN}/${label}" >/dev/null 2>&1 || true
}

remove_launch_agent() {
  local plist="$1"
  local label="$2"
  if [[ -f "${plist}" ]]; then
    launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
  bootout_service_target "${label}"
  launchctl disable "${DOMAIN}/${label}" >/dev/null 2>&1 || true
  rm -f "${plist}" >/dev/null 2>&1 || true
}

"${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true

remove_launch_agent "${MCP_PLIST}" "${MCP_LABEL}"
remove_launch_agent "${AUTO_PLIST}" "${AUTO_LABEL}"
remove_launch_agent "${WORKER_PLIST}" "${WORKER_LABEL}"
remove_launch_agent "${KEEPALIVE_PLIST}" "${KEEPALIVE_LABEL}"
remove_launch_agent "${WATCHDOG_PLIST}" "${WATCHDOG_LABEL}"
remove_launch_agent "${OFFICE_GUI_PLIST}" "${OFFICE_GUI_LABEL}"
remove_launch_agent "${MLX_PLIST}" "${MLX_LABEL}"

echo "{\"ok\":true,\"removed\":[\"${MCP_LABEL}\",\"${AUTO_LABEL}\",\"${WORKER_LABEL}\",\"${KEEPALIVE_LABEL}\",\"${WATCHDOG_LABEL}\",\"${OFFICE_GUI_LABEL}\",\"${MLX_LABEL}\"]}" >&2
