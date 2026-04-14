#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-maintain}"
case "${ACTION}" in
  status|ensure|maintain|repair)
    ;;
  *)
    echo "usage: $0 [status|ensure|maintain]" >&2
    exit 2
    ;;
esac

if [[ "${ACTION}" == "repair" ]]; then
  ACTION="maintain"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

if [[ "${ACTION}" == "maintain" ]]; then
  exec node "${REPO_ROOT}/scripts/autonomy_keepalive_runner.mjs"
fi

TRANSPORT="${AUTONOMY_BOOTSTRAP_TRANSPORT:-${TRICHAT_RING_LEADER_TRANSPORT:-}}"
if [[ -z "${TRANSPORT}" ]]; then
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    TRANSPORT="http"
  else
    TRANSPORT="stdio"
  fi
fi

export TRICHAT_RING_LEADER_TRANSPORT="${TRANSPORT}"

exec "${REPO_ROOT}/scripts/autonomy_ctl.sh" "${ACTION}"
