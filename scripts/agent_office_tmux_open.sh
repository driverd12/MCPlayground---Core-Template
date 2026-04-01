#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
export TRICHAT_AUTONOMY_ENSURE_ON_ENTRY=0

if [[ "${1:-}" == "--print-command" ]]; then
  printf 'cd %q && TRICHAT_AUTONOMY_ENSURE_ON_ENTRY=0 ./scripts/agent_office_tmux.sh\n' "${REPO_ROOT}"
  exit 0
fi

"${REPO_ROOT}/scripts/agent_office_tmux.sh" --detach

if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
  COMMAND="cd \"${REPO_ROOT}\" && TRICHAT_AUTONOMY_ENSURE_ON_ENTRY=0 ./scripts/agent_office_tmux.sh"
  ESCAPED="${COMMAND//\\/\\\\}"
  ESCAPED="${ESCAPED//\"/\\\"}"
  osascript <<OSA
tell application "Terminal"
  activate
  do script "${ESCAPED}"
end tell
OSA
  exit 0
fi

exec env TRICHAT_AUTONOMY_ENSURE_ON_ENTRY=0 "${REPO_ROOT}/scripts/agent_office_tmux.sh"
