#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "error: launchd sidecar install is macOS-only; run npm run federation:sidecar directly on this host." >&2
  exit 2
fi

eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

LABEL="${MASTER_MOLD_FEDERATION_LAUNCHD_LABEL:-com.master-mold.federation.sidecar}"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
SUPPORT_ROOT="${HOME}/Library/Application Support/master-mold"
LOG_DIR="${SUPPORT_ROOT}/launchd-logs"
PLIST="${LAUNCH_DIR}/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
NODE_BIN="$(command -v node || true)"
PYTHON_BIN="$(command -v python3 || true)"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found in PATH" >&2
  exit 2
fi
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "error: python3 not found in PATH" >&2
  exit 2
fi

HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
SAFE_HOST_ID="$(printf '%s' "${HOSTNAME_SHORT}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^[-.]+//; s/[-.]+$//')"
HOST_ID="${MASTER_MOLD_HOST_ID:-${SAFE_HOST_ID:-local-host}}"
IDENTITY_KEY_PATH="${MASTER_MOLD_IDENTITY_KEY_PATH:-${HOME}/.master-mold/identity/${HOST_ID}-ed25519.pem}"
PEERS="${MASTER_MOLD_FEDERATION_PEERS:-}"
INTERVAL_SECONDS="${MASTER_MOLD_FEDERATION_INTERVAL_SECONDS:-30}"
LOCAL_TRANSPORT="${MASTER_MOLD_FEDERATION_LOCAL_TRANSPORT:-http}"
TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
HTTP_BEARER_TOKEN="${MCP_HTTP_BEARER_TOKEN:-${ANAMNESIS_MCP_HTTP_BEARER_TOKEN:-}}"

if [[ -z "${HTTP_BEARER_TOKEN}" && -f "${TOKEN_FILE}" ]]; then
  HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi
if [[ -z "${HTTP_BEARER_TOKEN}" ]]; then
  echo "error: MCP_HTTP_BEARER_TOKEN is required, or ${TOKEN_FILE} must exist." >&2
  exit 2
fi
if [[ -z "${PEERS}" ]]; then
  echo "error: MASTER_MOLD_FEDERATION_PEERS is required, e.g. http://Dans-MBP.local:8787" >&2
  exit 2
fi
if [[ ! -f "${IDENTITY_KEY_PATH}" ]]; then
  echo "error: host identity key not found: ${IDENTITY_KEY_PATH}" >&2
  echo "Run scripts/request_remote_access.mjs on this host first, then approve it from the peer Agent Office." >&2
  exit 2
fi

mkdir -p "${LAUNCH_DIR}" "${LOG_DIR}"

export LABEL PLIST NODE_BIN REPO_ROOT HOST_ID IDENTITY_KEY_PATH PEERS INTERVAL_SECONDS LOCAL_TRANSPORT HTTP_BEARER_TOKEN LOG_DIR
export MASTER_MOLD_AGENT_RUNTIME="${MASTER_MOLD_AGENT_RUNTIME:-federation-sidecar}"
export MASTER_MOLD_MODEL_LABEL="${MASTER_MOLD_MODEL_LABEL:-federation-sidecar}"
export MASTER_MOLD_FEDERATION_ORIGIN="${MASTER_MOLD_FEDERATION_ORIGIN:-}"
export MCP_TOOL_CALL_URL="${MCP_TOOL_CALL_URL:-http://127.0.0.1:8787/}"
export MCP_TOOL_CALL_ORIGIN="${MCP_TOOL_CALL_ORIGIN:-http://127.0.0.1}"

"${PYTHON_BIN}" - <<'PY'
import os
import plistlib

env = {
    "MASTER_MOLD_FEDERATION_PEERS": os.environ["PEERS"],
    "MASTER_MOLD_HOST_ID": os.environ["HOST_ID"],
    "MASTER_MOLD_IDENTITY_KEY_PATH": os.environ["IDENTITY_KEY_PATH"],
    "MASTER_MOLD_AGENT_RUNTIME": os.environ["MASTER_MOLD_AGENT_RUNTIME"],
    "MASTER_MOLD_MODEL_LABEL": os.environ["MASTER_MOLD_MODEL_LABEL"],
    "MASTER_MOLD_FEDERATION_LOCAL_TRANSPORT": os.environ["LOCAL_TRANSPORT"],
    "MCP_HTTP_BEARER_TOKEN": os.environ["HTTP_BEARER_TOKEN"],
    "MCP_TOOL_CALL_URL": os.environ["MCP_TOOL_CALL_URL"],
    "MCP_TOOL_CALL_ORIGIN": os.environ["MCP_TOOL_CALL_ORIGIN"],
}
origin = os.environ.get("MASTER_MOLD_FEDERATION_ORIGIN", "").strip()
if origin:
    env["MASTER_MOLD_FEDERATION_ORIGIN"] = origin

plist = {
    "Label": os.environ["LABEL"],
    "WorkingDirectory": os.environ["REPO_ROOT"],
    "ProgramArguments": [
        os.environ["NODE_BIN"],
        os.path.join(os.environ["REPO_ROOT"], "scripts", "federation_sidecar.mjs"),
        "--interval-seconds",
        os.environ["INTERVAL_SECONDS"],
    ],
    "EnvironmentVariables": env,
    "RunAtLoad": True,
    "KeepAlive": True,
    "StandardOutPath": os.path.join(os.environ["LOG_DIR"], "federation-sidecar.out.log"),
    "StandardErrorPath": os.path.join(os.environ["LOG_DIR"], "federation-sidecar.err.log"),
}

with open(os.environ["PLIST"], "wb") as handle:
    plistlib.dump(plist, handle)
PY

launchctl bootout "${DOMAIN}" "${PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"
launchctl enable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

echo "installed federation sidecar launchd agent: ${LABEL}"
echo "peers: ${PEERS}"
echo "logs: ${LOG_DIR}/federation-sidecar.{out,err}.log"
