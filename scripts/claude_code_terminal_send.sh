#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/claude_code_terminal_send.sh [options]

Options:
  --prompt <text>            Prompt to type into the visible Claude terminal.
  --prompt-file <path>       Read the prompt from a file.
  --workspace <path>         Workspace used if a visible Claude session must be opened.
  --name <text>              Claude session name to target. Default: MASTER-MOLD Visible Claude.
  --model <name>             Claude model used if a visible session must be opened.
  --permission-mode <mode>   Claude permission mode used if a visible session must be opened.
  --wait-seconds <seconds>   Wait before capturing output. Default: 8.
  --capture-file <path>      Write captured terminal history tail to a file.
  --capture-tail-lines <n>   Tail lines written to --capture-file. Default: 160.
  --capture                  Print terminal history after sending the prompt.
  --open-if-missing          Open a visible Claude session first if none is found. Default.
  --no-open-if-missing       Fail instead of opening a new visible Claude session.
  -h, --help                 Show help.
USAGE
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${REPO_ROOT}"
SESSION_NAME="${CLAUDE_VISIBLE_SESSION_NAME:-MASTER-MOLD Visible Claude}"
MODEL="${CLAUDE_VISIBLE_MODEL:-opus}"
PERMISSION_MODE="${CLAUDE_VISIBLE_PERMISSION_MODE:-bypassPermissions}"
WAIT_SECONDS="${CLAUDE_VISIBLE_CAPTURE_WAIT_SECONDS:-8}"
CAPTURE_TAIL_LINES="${CLAUDE_VISIBLE_CAPTURE_TAIL_LINES:-160}"
PROMPT_TEXT=""
PROMPT_FILE=""
PROMPT_TEMP_FILE=""
CAPTURE_FILE=""
CAPTURE=0
OPEN_IF_MISSING=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt)
      PROMPT_TEXT="${2:-}"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="${2:-}"
      shift 2
      ;;
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --name)
      SESSION_NAME="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --permission-mode)
      PERMISSION_MODE="${2:-}"
      shift 2
      ;;
    --wait-seconds)
      WAIT_SECONDS="${2:-}"
      shift 2
      ;;
    --capture-file)
      CAPTURE_FILE="${2:-}"
      shift 2
      ;;
    --capture-tail-lines)
      CAPTURE_TAIL_LINES="${2:-}"
      shift 2
      ;;
    --capture)
      CAPTURE=1
      shift
      ;;
    --open-if-missing)
      OPEN_IF_MISSING=1
      shift
      ;;
    --no-open-if-missing)
      OPEN_IF_MISSING=0
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

if [[ -z "${PROMPT_TEXT}" && -z "${PROMPT_FILE}" ]]; then
  echo "Provide --prompt or --prompt-file." >&2
  exit 2
fi

if [[ -n "${PROMPT_TEXT}" ]]; then
  PROMPT_TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/claude-visible-send.XXXXXX")"
  printf '%s\n' "${PROMPT_TEXT}" > "${PROMPT_TEMP_FILE}"
  PROMPT_FILE="${PROMPT_TEMP_FILE}"
fi

cleanup() {
  if [[ -n "${PROMPT_TEMP_FILE}" && -f "${PROMPT_TEMP_FILE}" ]]; then
    rm -f "${PROMPT_TEMP_FILE}"
  fi
}
trap cleanup EXIT

if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "Prompt file does not exist: ${PROMPT_FILE}" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]] || ! command -v osascript >/dev/null 2>&1; then
  echo "Visible Claude terminal control currently requires macOS Terminal plus osascript." >&2
  exit 1
fi

find_visible_claude_session() {
  osascript - "${SESSION_NAME}" <<'OSA'
on run argv
  set sessionName to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          set titleText to custom title of t as text
        on error
          set titleText to ""
        end try
        if titleText contains sessionName then
          return "1"
        end if
      end repeat
    end repeat
  end tell
  return "0"
end run
OSA
}

if [[ "$(find_visible_claude_session)" != "1" ]]; then
  if [[ "${OPEN_IF_MISSING}" != "1" ]]; then
    echo "Visible Claude session not found: ${SESSION_NAME}" >&2
    exit 1
  fi
  "${REPO_ROOT}/scripts/claude_code_terminal_open.sh" \
    --workspace "${WORKSPACE}" \
    --model "${MODEL}" \
    --name "${SESSION_NAME}" \
    --permission-mode "${PERMISSION_MODE}" >/dev/null
  sleep 3
fi

NEEDS_CAPTURE=0
if [[ "${CAPTURE}" == "1" || -n "${CAPTURE_FILE}" ]]; then
  NEEDS_CAPTURE=1
fi

CAPTURE_TEXT="$(
osascript - "${SESSION_NAME}" "${PROMPT_FILE}" "${WAIT_SECONDS}" "${NEEDS_CAPTURE}" <<'OSA'
on findMatchingTab(sessionName)
  tell application "Terminal"
    repeat with w in windows
      set tabIndex to 1
      repeat with t in tabs of w
        try
          set titleText to custom title of t as text
        on error
          set titleText to ""
        end try
        if titleText contains sessionName then
          return {id of w, tabIndex}
        end if
        set tabIndex to tabIndex + 1
      end repeat
    end repeat
  end tell
  return {missing value, -1}
end findMatchingTab

on run argv
  set sessionName to item 1 of argv
  set promptFilePath to item 2 of argv
  set waitSeconds to (item 3 of argv) as real
  set captureOutput to ((item 4 of argv) as integer) is 1
  set promptText to read POSIX file promptFilePath
  set matchInfo to my findMatchingTab(sessionName)
  set targetWindowId to item 1 of matchInfo
  set targetTabIndex to item 2 of matchInfo
  if targetWindowId is missing value then error "visible Claude tab not found"

  tell application "Terminal"
    activate
    set targetWindow to first window whose id is targetWindowId
    set targetTab to tab targetTabIndex of targetWindow
    set selected tab of targetWindow to targetTab
    set index of targetWindow to 1
  end tell

  delay 0.2
  tell application "System Events"
    keystroke "u" using control down
    delay 0.1
    keystroke promptText
    key code 36
  end tell

  if captureOutput then
    delay waitSeconds
    tell application "Terminal"
      return (history of targetTab) as text
    end tell
  end if

  return "sent"
end run
OSA
)"

if [[ -n "${CAPTURE_FILE}" ]]; then
  mkdir -p "$(dirname "${CAPTURE_FILE}")"
  printf '%s\n' "${CAPTURE_TEXT}" | tail -n "${CAPTURE_TAIL_LINES}" > "${CAPTURE_FILE}"
fi

if [[ "${CAPTURE}" == "1" ]]; then
  printf '%s\n' "${CAPTURE_TEXT}"
else
  printf 'sent\n'
fi
