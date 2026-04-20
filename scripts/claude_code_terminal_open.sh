#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/claude_code_terminal_open.sh [options]

Options:
  --workspace <path>       Workspace to open before launching Claude Code.
  --prompt <text>          Run one visible Claude one-shot prompt with `-p`.
  --prompt-file <path>     Read the one-shot prompt from a file.
  --model <name>           Claude model alias or full name. Default: opus.
  --name <text>            Claude session name shown in the terminal.
  --permission-mode <mode> Claude permission mode. Default: bypassPermissions.
  --continue               Resume the latest Claude conversation in the workspace.
  --print-command          Print the shell command that will be launched and exit.
  -h, --help               Show help.
USAGE
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${REPO_ROOT}"
PROMPT_TEXT=""
PROMPT_FILE=""
PROMPT_TEMP_FILE=""
REMOVE_PROMPT_FILE_AFTER_RUN=0
MODEL="${CLAUDE_VISIBLE_MODEL:-opus}"
SESSION_NAME="${CLAUDE_VISIBLE_SESSION_NAME:-MASTER-MOLD Visible Claude}"
PERMISSION_MODE="${CLAUDE_VISIBLE_PERMISSION_MODE:-bypassPermissions}"
CONTINUE_SESSION=0
PRINT_COMMAND=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT_TEXT="${2:-}"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --name)
      SESSION_NAME="${2:-}"
      shift 2
      ;;
    --permission-mode)
      PERMISSION_MODE="${2:-}"
      shift 2
      ;;
    --continue)
      CONTINUE_SESSION=1
      shift
      ;;
    --print-command)
      PRINT_COMMAND=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "${PROMPT_TEXT}" && -n "${PROMPT_FILE}" ]]; then
  echo "Use either --prompt or --prompt-file, not both." >&2
  exit 2
fi

if [[ -n "${PROMPT_TEXT}" ]]; then
  PROMPT_TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/claude-visible-prompt.XXXXXX")"
  printf '%s\n' "${PROMPT_TEXT}" > "${PROMPT_TEMP_FILE}"
  PROMPT_FILE="${PROMPT_TEMP_FILE}"
  REMOVE_PROMPT_FILE_AFTER_RUN=1
fi

cleanup() {
  if [[ -n "${PROMPT_TEMP_FILE}" && -f "${PROMPT_TEMP_FILE}" ]]; then
    rm -f "${PROMPT_TEMP_FILE}"
  fi
}
trap cleanup EXIT

if [[ -n "${PROMPT_FILE}" && ! -f "${PROMPT_FILE}" ]]; then
  echo "Prompt file does not exist: ${PROMPT_FILE}" >&2
  exit 1
fi

CLAUDE_BIN="${TRICHAT_CLAUDE_EXECUTABLE:-claude}"
if ! command -v "${CLAUDE_BIN}" >/dev/null 2>&1; then
  echo "Claude CLI is not installed or not on PATH: ${CLAUDE_BIN}" >&2
  exit 1
fi

declare -a CLAUDE_ARGS=()
if [[ -n "${TRICHAT_CLAUDE_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  CLAUDE_ARGS=(${TRICHAT_CLAUDE_ARGS})
fi

normalize_args() {
  local one_shot="$1"
  local arg skip_next=0
  declare -a filtered=()
  if ((${#CLAUDE_ARGS[@]})); then
    for arg in "${CLAUDE_ARGS[@]}"; do
      if [[ "${skip_next}" == "1" ]]; then
        skip_next=0
        continue
      fi
      case "${arg}" in
        -p|--print)
          if [[ "${one_shot}" == "1" ]]; then
            filtered+=("${arg}")
          fi
          ;;
        --model|--permission-mode|-n|--name)
          skip_next=1
          ;;
        *)
          filtered+=("${arg}")
          ;;
      esac
    done
  fi
  if [[ "${one_shot}" == "1" ]]; then
    local has_print=0
    if ((${#filtered[@]})); then
      for arg in "${filtered[@]}"; do
        if [[ "${arg}" == "-p" || "${arg}" == "--print" ]]; then
          has_print=1
        fi
      done
    fi
    if [[ "${has_print}" == "0" ]]; then
      if ((${#filtered[@]})); then
        filtered=("-p" "${filtered[@]}")
      else
        filtered=("-p")
      fi
    fi
  fi
  CLAUDE_ARGS=()
  if ((${#filtered[@]})); then
    CLAUDE_ARGS=("${filtered[@]}")
  fi
}

build_shell_command() {
  local one_shot="$1"
  normalize_args "${one_shot}"
  declare -a cmd=("${CLAUDE_BIN}")
  if ((${#CLAUDE_ARGS[@]})); then
    cmd+=("${CLAUDE_ARGS[@]}")
  fi
  cmd+=(--model "${MODEL}" --permission-mode "${PERMISSION_MODE}" -n "${SESSION_NAME}")
  if [[ "${CONTINUE_SESSION}" == "1" ]]; then
    cmd+=(--continue)
  fi

  local rendered=""
  local part
  local prompt_file_quoted=""
  for part in "${cmd[@]}"; do
    printf -v part '%q' "${part}"
    rendered+="${rendered:+ }${part}"
  done
  if [[ "${one_shot}" == "1" ]]; then
    printf -v prompt_file_quoted '%q' "${PROMPT_FILE}"
    rendered+=" \"\$(cat ${prompt_file_quoted})\""
    if [[ "${REMOVE_PROMPT_FILE_AFTER_RUN}" == "1" ]]; then
      rendered+="; rm -f ${prompt_file_quoted}"
    fi
  fi

  printf 'cd %q && eval "$(%q %q)" && cd %q && CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=%q %s' \
    "${REPO_ROOT}" \
    "${REPO_ROOT}/scripts/export_dotenv_env.sh" \
    "${REPO_ROOT}" \
    "${WORKSPACE}" \
    "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-1}" \
    "${rendered}"
}

ONE_SHOT=0
if [[ -n "${PROMPT_FILE}" ]]; then
  ONE_SHOT=1
fi

COMMAND="$(build_shell_command "${ONE_SHOT}")"
if [[ "${PRINT_COMMAND}" == "1" ]]; then
  printf '%s\n' "${COMMAND}"
  exit 0
fi

if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
  ESCAPED_COMMAND="${COMMAND//\\/\\\\}"
  ESCAPED_COMMAND="${ESCAPED_COMMAND//\"/\\\"}"
  osascript <<OSA
tell application "Terminal"
  activate
  do script "${ESCAPED_COMMAND}"
end tell
OSA
  if [[ "${REMOVE_PROMPT_FILE_AFTER_RUN}" == "1" ]]; then
    trap - EXIT
  fi
  exit 0
fi

cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"
cd "${WORKSPACE}"
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-1}"
if [[ "${ONE_SHOT}" == "1" ]]; then
  PROMPT_CONTENT="$(cat "${PROMPT_FILE}")"
  if [[ "${REMOVE_PROMPT_FILE_AFTER_RUN}" == "1" ]]; then
    rm -f "${PROMPT_FILE}"
    PROMPT_TEMP_FILE=""
  fi
  if ((${#CLAUDE_ARGS[@]})); then
    exec "${CLAUDE_BIN}" "${CLAUDE_ARGS[@]}" --model "${MODEL}" --permission-mode "${PERMISSION_MODE}" -n "${SESSION_NAME}" "${PROMPT_CONTENT}"
  fi
  exec "${CLAUDE_BIN}" --model "${MODEL}" --permission-mode "${PERMISSION_MODE}" -n "${SESSION_NAME}" "${PROMPT_CONTENT}"
fi
if ((${#CLAUDE_ARGS[@]})); then
  exec "${CLAUDE_BIN}" "${CLAUDE_ARGS[@]}" --model "${MODEL}" --permission-mode "${PERMISSION_MODE}" -n "${SESSION_NAME}"
fi
exec "${CLAUDE_BIN}" --model "${MODEL}" --permission-mode "${PERMISSION_MODE}" -n "${SESSION_NAME}"
