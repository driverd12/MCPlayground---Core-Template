#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.mcplayground.mcp.server"
AUTO_LABEL="com.mcplayground.imprint.autosnapshot"
WORKER_LABEL="com.mcplayground.imprint.inboxworker"
KEEPALIVE_LABEL="com.mcplayground.autonomy.keepalive"
MLX_LABEL="com.mcplayground.mlx.server"

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"
KEEPALIVE_PLIST="${LAUNCH_DIR}/${KEEPALIVE_LABEL}.plist"
MLX_PLIST="${LAUNCH_DIR}/${MLX_LABEL}.plist"

"${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true

if [[ -f "${MCP_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${MCP_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
  rm -f "${MCP_PLIST}"
fi

if [[ -f "${AUTO_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${AUTO_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
  rm -f "${AUTO_PLIST}"
fi

if [[ -f "${WORKER_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${WORKER_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
  rm -f "${WORKER_PLIST}"
fi

if [[ -f "${KEEPALIVE_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${KEEPALIVE_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${KEEPALIVE_LABEL}" >/dev/null 2>&1 || true
  rm -f "${KEEPALIVE_PLIST}"
fi

if [[ -f "${MLX_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${MLX_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${MLX_LABEL}" >/dev/null 2>&1 || true
  rm -f "${MLX_PLIST}"
fi

echo "{\"ok\":true,\"removed\":[\"${MCP_LABEL}\",\"${AUTO_LABEL}\",\"${WORKER_LABEL}\",\"${KEEPALIVE_LABEL}\",\"${MLX_LABEL}\"]}" >&2
