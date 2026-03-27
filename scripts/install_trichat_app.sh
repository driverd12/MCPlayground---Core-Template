#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Agent Office"
INSTALL_DIR="/Applications"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSPORT="stdio"
TERMINAL_MODE="terminal"
ICON_PATH=""

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/install_trichat_app.sh [options]

Options:
  --icon <path>          Optional icon image file to apply to the app (.png recommended)
  --transport <mode>     stdio (default) or http
  --terminal <mode>      terminal (default) or alacritty
  --name <app-name>      App name (default: Agent Office)
  --install-dir <path>   Install directory (default: /Applications)
  --repo-root <path>     Repository root (default: current repo)
  -h, --help             Show this help

Examples:
  ./scripts/install_trichat_app.sh
  ./scripts/install_trichat_app.sh --icon /absolute/path/to/office-mascot.png
  ./scripts/install_trichat_app.sh --transport http --terminal alacritty
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 2
}

require_command() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || fail "missing required command: ${cmd}"
}

build_icns() {
  local source_image="$1"
  local output_icns="$2"
  local iconset_dir="$3"

  mkdir -p "${iconset_dir}"
  sips -z 16 16 "${source_image}" --out "${iconset_dir}/icon_16x16.png" >/dev/null
  sips -z 32 32 "${source_image}" --out "${iconset_dir}/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "${source_image}" --out "${iconset_dir}/icon_32x32.png" >/dev/null
  sips -z 64 64 "${source_image}" --out "${iconset_dir}/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "${source_image}" --out "${iconset_dir}/icon_128x128.png" >/dev/null
  sips -z 256 256 "${source_image}" --out "${iconset_dir}/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "${source_image}" --out "${iconset_dir}/icon_256x256.png" >/dev/null
  sips -z 512 512 "${source_image}" --out "${iconset_dir}/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "${source_image}" --out "${iconset_dir}/icon_512x512.png" >/dev/null
  sips -z 1024 1024 "${source_image}" --out "${iconset_dir}/icon_512x512@2x.png" >/dev/null

  iconutil -c icns "${iconset_dir}" -o "${output_icns}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --icon)
      [[ $# -ge 2 ]] || fail "--icon requires a path"
      ICON_PATH="$2"
      shift 2
      ;;
    --transport)
      [[ $# -ge 2 ]] || fail "--transport requires stdio|http"
      TRANSPORT="$2"
      shift 2
      ;;
    --terminal)
      [[ $# -ge 2 ]] || fail "--terminal requires terminal|alacritty"
      TERMINAL_MODE="$2"
      shift 2
      ;;
    --name)
      [[ $# -ge 2 ]] || fail "--name requires a value"
      APP_NAME="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || fail "--install-dir requires a path"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --repo-root)
      [[ $# -ge 2 ]] || fail "--repo-root requires a path"
      REPO_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "${TRANSPORT}" in
  stdio|http) ;;
  *) fail "--transport must be stdio or http (got: ${TRANSPORT})" ;;
esac

case "${TERMINAL_MODE}" in
  terminal|alacritty) ;;
  *) fail "--terminal must be terminal or alacritty (got: ${TERMINAL_MODE})" ;;
esac

REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"
INSTALL_DIR="$(mkdir -p "${INSTALL_DIR}" && cd "${INSTALL_DIR}" && pwd)"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"

require_command osacompile
require_command python3
require_command sips
require_command iconutil

if [[ "${TERMINAL_MODE}" == "alacritty" ]]; then
  require_command open
fi

if [[ -n "${ICON_PATH}" ]]; then
  ICON_PATH="$(cd "$(dirname "${ICON_PATH}")" && pwd)/$(basename "${ICON_PATH}")"
  [[ -f "${ICON_PATH}" ]] || fail "icon file does not exist: ${ICON_PATH}"
fi

LAUNCH_SCRIPT="npm run trichat:office:tmux"
if [[ "${TRANSPORT}" == "http" ]]; then
  LAUNCH_SCRIPT="TRICHAT_MCP_TRANSPORT=http npm run trichat:office:tmux"
fi

TMP_APPLESCRIPT="$(mktemp -t trichat-installer-XXXXXX.applescript)"
TMP_ICONSET_DIR=""
TMP_ICON_FILE=""
TMP_ICON_SOURCE=""
cleanup() {
  rm -f "${TMP_APPLESCRIPT}"
  if [[ -n "${TMP_ICON_FILE}" ]]; then
    rm -f "${TMP_ICON_FILE}"
  fi
  if [[ -n "${TMP_ICON_SOURCE}" ]]; then
    rm -f "${TMP_ICON_SOURCE}"
  fi
  if [[ -n "${TMP_ICONSET_DIR}" ]]; then
    rm -rf "${TMP_ICONSET_DIR}"
  fi
}
trap cleanup EXIT

if [[ -z "${ICON_PATH}" ]]; then
  TMP_ICON_SOURCE="$(mktemp -t agent-office-icon-XXXXXX).png"
  python3 "${REPO_ROOT}/scripts/generate_agent_office_icon.py" --out "${TMP_ICON_SOURCE}"
  ICON_PATH="${TMP_ICON_SOURCE}"
fi

if [[ "${TERMINAL_MODE}" == "terminal" ]]; then
  cat > "${TMP_APPLESCRIPT}" <<EOF
set repoPath to "${REPO_ROOT}"
set launchCmd to "cd " & quoted form of repoPath & " && ${LAUNCH_SCRIPT}"
tell application "Terminal"
  activate
  do script launchCmd
end tell
EOF
else
  cat > "${TMP_APPLESCRIPT}" <<EOF
set repoPath to "${REPO_ROOT}"
set launchCmd to "cd " & quoted form of repoPath & " && ${LAUNCH_SCRIPT}"
set shellCmd to "if command -v alacritty >/dev/null 2>&1; then " & ¬
  "nohup alacritty --working-directory " & quoted form of repoPath & " -e zsh -ilc " & quoted form of launchCmd & " >/dev/null 2>&1 & " & ¬
  "else open -na Alacritty --args -e zsh -ilc " & quoted form of launchCmd & "; fi"
do shell script shellCmd
EOF
fi

if [[ -e "${APP_PATH}" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BACKUP_PATH="${APP_PATH}.backup-${TS}"
  mv "${APP_PATH}" "${BACKUP_PATH}"
  echo "existing app moved to ${BACKUP_PATH}" >&2
fi

osacompile -o "${APP_PATH}" "${TMP_APPLESCRIPT}" >/dev/null

TMP_ICONSET_DIR="$(mktemp -d -t trichat-iconset-XXXXXX)"
TMP_ICONSET_DIR="${TMP_ICONSET_DIR}/AgentOffice.iconset"
TMP_ICON_FILE="$(mktemp -t trichat-icon-XXXXXX).icns"
build_icns "${ICON_PATH}" "${TMP_ICON_FILE}" "${TMP_ICONSET_DIR}"
cp -f "${TMP_ICON_FILE}" "${APP_PATH}/Contents/Resources/applet.icns"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "${APP_PATH}" >/dev/null 2>&1 || true
fi
touch "${APP_PATH}"

echo "installed ${APP_PATH}" >&2
echo "launch target: ${LAUNCH_SCRIPT}" >&2
echo "icon applied from: ${ICON_PATH}" >&2
