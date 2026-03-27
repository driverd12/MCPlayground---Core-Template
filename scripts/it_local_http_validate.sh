#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

: "${MCP_HTTP_BEARER_TOKEN:?MCP_HTTP_BEARER_TOKEN must be set for HTTP validation}"

node ./scripts/mcp_tool_call.mjs \
  --tool kernel.summary \
  --args '{}' \
  --transport http \
  --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
  --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
  --cwd "${REPO_ROOT}"
