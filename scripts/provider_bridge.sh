#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/provider_bridge.sh status [--transport auto|http|stdio] [client...]
  ./scripts/provider_bridge.sh diagnose [--transport auto|http|stdio] [client...]
  ./scripts/provider_bridge.sh export [--transport auto|http|stdio] [--out <dir>] [--include-bearer-token] [client...]
  ./scripts/provider_bridge.sh install [--transport auto|http|stdio] [client...]

Clients:
  claude-cli
  codex
  cursor
  github-copilot-cli
  github-copilot-vscode
  gemini-cli
  chatgpt-developer-mode
USAGE
}

ACTION="${1:-status}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "${ACTION}" in
  status|diagnose|export|install)
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

TRANSPORT="auto"
OUT_DIR=""
INCLUDE_BEARER_TOKEN=0
declare -a CLIENTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --transport)
      TRANSPORT="${2:-auto}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --include-bearer-token)
      INCLUDE_BEARER_TOKEN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      CLIENTS+=("$1")
      shift
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

resolve_call_transport() {
  if [[ -n "${TRICHAT_MCP_TRANSPORT:-}" ]]; then
    printf '%s\n' "${TRICHAT_MCP_TRANSPORT}"
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

CLIENTS_JSON="$(printf '%s\n' "${CLIENTS[@]-}" | node --input-type=module -e '
const fs = await import("node:fs");
const values = fs.readFileSync(0, "utf8").split(/\n/).map((entry) => entry.trim()).filter(Boolean);
process.stdout.write(JSON.stringify(values));
')"

CALL_TRANSPORT="$(resolve_call_transport)"
TIMESTAMP="$(date +%s)"
RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"

ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${ACTION}" \
"${TRANSPORT}" \
"${OUT_DIR}" \
"${INCLUDE_BEARER_TOKEN}" \
"${CLIENTS_JSON}" \
"${TIMESTAMP}" \
"${RAND_SUFFIX}"
const [action, transport, outDir, includeBearerToken, clientsArg, timestamp, randSuffix] = process.argv.slice(2);
const includeSecrets = ["1", "true", "yes", "on"].includes(String(includeBearerToken).trim().toLowerCase());
const writes = action === "export" || action === "install";
process.stdout.write(
  JSON.stringify({
    action: action === "export" ? "export_bundle" : action,
    mutation: writes
      ? {
          idempotency_key: `provider-bridge-${action}-${timestamp}-${randSuffix}`,
          side_effect_fingerprint: `provider-bridge-${action}-${timestamp}-${randSuffix}`,
        }
      : undefined,
    transport,
    output_dir: outDir || undefined,
    include_bearer_token: includeSecrets,
    clients: JSON.parse(clientsArg || "[]"),
    source_client: "provider_bridge.sh",
  })
);
NODE
)"

node ./scripts/mcp_tool_call.mjs \
  --tool provider.bridge \
  --args "${ARGS_JSON}" \
  --transport "${CALL_TRANSPORT}" \
  --url "${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}" \
  --origin "${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}" \
  --stdio-command "${TRICHAT_MCP_STDIO_COMMAND:-node}" \
  --stdio-args "${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}" \
  --cwd "${REPO_ROOT}"
