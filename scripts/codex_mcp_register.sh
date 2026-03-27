#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_NAME="${1:-mcplayground}"
LAUNCHER="${REPO_ROOT}/scripts/codex_mcp_stdio.sh"

if [[ ! -x "${LAUNCHER}" ]]; then
  chmod +x "${LAUNCHER}"
fi

if codex mcp get "${SERVER_NAME}" >/dev/null 2>&1; then
  codex mcp remove "${SERVER_NAME}" >/dev/null
fi

codex mcp add "${SERVER_NAME}" -- "${LAUNCHER}"

echo "Registered Codex MCP server '${SERVER_NAME}' -> ${LAUNCHER}"
