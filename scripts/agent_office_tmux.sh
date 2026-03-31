#!/usr/bin/env bash
set -euo pipefail

need_cmd() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || {
    echo "error: missing required command: ${name}" >&2
    exit 2
  }
}

DETACH=0
if [[ "${1:-}" == "--detach" ]]; then
  DETACH=1
  shift
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

need_cmd tmux
need_cmd python3
need_cmd node
need_cmd npm

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

SESSION_NAME="${TRICHAT_OFFICE_TMUX_SESSION_NAME:-agent-office}"
THREAD_ID="${TRICHAT_OFFICE_THREAD_ID:-ring-leader-main}"
REFRESH_SECONDS="${TRICHAT_OFFICE_REFRESH_SECONDS:-4.0}"
THEME="${TRICHAT_OFFICE_THEME:-night}"
TOOL_TIMEOUT_SECONDS="${TRICHAT_OFFICE_TOOL_TIMEOUT_SECONDS:-8.0}"
TRANSPORT="${TRICHAT_MCP_TRANSPORT:-}"
if [[ -z "${TRANSPORT}" ]]; then
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    TRANSPORT="http"
  else
    TRANSPORT="stdio"
  fi
fi
URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"

ensure_autonomy_entry() {
  local should_ensure="${TRICHAT_AUTONOMY_ENSURE_ON_ENTRY:-1}"
  local mode="${TRICHAT_AUTONOMY_ENSURE_MODE:-required}"
  if [[ "${should_ensure}" == "0" ]]; then
    return 0
  fi
  if "${REPO_ROOT}/scripts/autonomy_ctl.sh" ensure >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${mode}" == "best_effort" ]]; then
    echo "[agent-office] warning: autonomy bootstrap ensure failed; continuing due to TRICHAT_AUTONOMY_ENSURE_MODE=best_effort" >&2
    return 0
  fi
  echo "[agent-office] autonomy bootstrap ensure failed before office launch" >&2
  exit 1
}

ensure_autonomy_entry

DASHBOARD_BASE=(
  "python3" "./scripts/agent_office_dashboard.py"
  "--repo-root" "${REPO_ROOT}"
  "--thread-id" "${THREAD_ID}"
  "--refresh-interval" "${REFRESH_SECONDS}"
  "--theme" "${THEME}"
  "--transport" "${TRANSPORT}"
  "--url" "${URL}"
  "--origin" "${ORIGIN}"
  "--stdio-command" "${STDIO_COMMAND}"
  "--stdio-args" "${STDIO_ARGS}"
  "--mcp-timeout-seconds" "${TOOL_TIMEOUT_SECONDS}"
)

join_dashboard_command() {
  local view="$1"
  local parts=("${DASHBOARD_BASE[@]}" "--view" "${view}")
  printf '%q ' "${parts[@]}"
}

window_exists() {
  local window_name="$1"
  tmux list-windows -t "${SESSION_NAME}" -F '#W' 2>/dev/null | grep -Fxq "${window_name}"
}

ensure_window() {
  local window_name="$1"
  local view_name="$2"
  local command
  command="$(join_dashboard_command "${view_name}")"
  if window_exists "${window_name}"; then
    local pane_dead pane_command
    pane_dead="$(tmux list-panes -t "${SESSION_NAME}:${window_name}" -F '#{pane_dead}' 2>/dev/null | head -n 1 || echo 1)"
    pane_command="$(tmux list-panes -t "${SESSION_NAME}:${window_name}" -F '#{pane_current_command}' 2>/dev/null | head -n 1 || true)"
    if [[ "${pane_dead}" == "1" || "${pane_command}" != "python3" ]]; then
      tmux respawn-window -k -t "${SESSION_NAME}:${window_name}" "${command}"
    fi
  else
    tmux new-window -t "${SESSION_NAME}" -n "${window_name}" "${command}"
  fi
  tmux set-window-option -t "${SESSION_NAME}:${window_name}" remain-on-exit on >/dev/null
  tmux set-window-option -t "${SESSION_NAME}:${window_name}" automatic-rename off >/dev/null
  tmux set-window-option -t "${SESSION_NAME}:${window_name}" allow-rename off >/dev/null
}

if ! tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  tmux new-session -d -s "${SESSION_NAME}" -n office "$(join_dashboard_command office)"
fi

ensure_window "office" "office"
ensure_window "briefing" "briefing"
ensure_window "lanes" "lanes"
ensure_window "workers" "workers"
if window_exists "intake"; then
  pane_dead="$(tmux list-panes -t "${SESSION_NAME}:intake" -F '#{pane_dead}' 2>/dev/null | head -n 1 || echo 1)"
  pane_command="$(tmux list-panes -t "${SESSION_NAME}:intake" -F '#{pane_current_command}' 2>/dev/null | head -n 1 || true)"
  if [[ "${pane_dead}" == "1" || ( "${pane_command}" != "bash" && "${pane_command}" != "zsh" ) ]]; then
    tmux respawn-window -k -t "${SESSION_NAME}:intake" "./scripts/autonomy_intake_shell.sh"
  fi
else
  tmux new-window -t "${SESSION_NAME}" -n "intake" "./scripts/autonomy_intake_shell.sh"
fi
tmux set-window-option -t "${SESSION_NAME}:intake" remain-on-exit on >/dev/null
tmux set-window-option -t "${SESSION_NAME}:intake" automatic-rename off >/dev/null
tmux set-window-option -t "${SESSION_NAME}:intake" allow-rename off >/dev/null

tmux set-option -t "${SESSION_NAME}" mouse on
tmux set-option -t "${SESSION_NAME}" renumber-windows on
tmux set-option -t "${SESSION_NAME}" destroy-unattached off
tmux set-option -t "${SESSION_NAME}" status-interval 5
tmux set-option -t "${SESSION_NAME}" status-style "bg=colour234,fg=colour252"
tmux set-option -t "${SESSION_NAME}" window-status-style "fg=colour244,bg=default"
tmux set-option -t "${SESSION_NAME}" window-status-current-style "fg=colour222,bg=colour236,bold"
tmux set-option -t "${SESSION_NAME}" pane-border-style "fg=colour239"
tmux set-option -t "${SESSION_NAME}" pane-active-border-style "fg=colour81"
tmux set-option -t "${SESSION_NAME}" status-left "#[fg=colour215,bold]o[ ]o #[fg=colour222,bold]Agent Office #[fg=colour110]${THEME}"
tmux set-option -t "${SESSION_NAME}" status-right "#[fg=colour114]tmux #[fg=colour81]#S #[fg=colour250]5:intake #[fg=colour250]%H:%M"
tmux select-window -t "${SESSION_NAME}:office"

if [[ "${DETACH}" == "1" ]]; then
  exit 0
fi

if [[ -n "${TMUX:-}" ]]; then
  exec tmux switch-client -t "${SESSION_NAME}"
fi
exec tmux attach-session -t "${SESSION_NAME}"
