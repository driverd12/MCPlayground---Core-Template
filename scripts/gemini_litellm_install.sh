#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/gemini_litellm_install.sh --project-id <gcp-project-id> [options]

Options:
  --project-id <id>          Required. Operator-owned Google Cloud project.
  --regions <csv>           Vertex regions. Default: global,us-central1,europe-west4
  --model <id>              Vertex model. Default: gemini-2.5-flash
  --port <port>             Local LiteLLM port. Default: 4000
  --litellm-bin <path>      LiteLLM executable. Default: auto-detect.
  --adc-path <path>         ADC JSON path. Default: ~/.config/gcloud/application_default_credentials.json
  --output-dir <path>       Local proxy config dir. Default: ~/.gemini/proxy
  --launchagents-dir <path> LaunchAgent output dir. Default: ~/Library/LaunchAgents
  --label <label>           launchd label. Default: com.litellm.proxy
  --stdout-log <path>       stdout log. Default: /tmp/litellm-stdout.log
  --stderr-log <path>       stderr log. Default: /tmp/litellm-stderr.log
  --skip-quota-project      Do not run gcloud ADC quota-project repair.
  --no-load                 Write files, but do not load launchd.
  --dry-run                 Render files and print intended actions without launchctl/gcloud changes.
  -h, --help                Show this help.

This script writes local per-user files only. It never copies ADC JSON, OAuth
tokens, API keys, or project-specific config into the repo.
USAGE
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ID=""
REGIONS="global,us-central1,europe-west4"
MODEL_ID="gemini-2.5-flash"
PORT="4000"
LITELLM_BIN=""
ADC_PATH="${HOME}/.config/gcloud/application_default_credentials.json"
OUTPUT_DIR="${HOME}/.gemini/proxy"
LAUNCHAGENTS_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.litellm.proxy"
STDOUT_LOG="/tmp/litellm-stdout.log"
STDERR_LOG="/tmp/litellm-stderr.log"
SKIP_QUOTA_PROJECT=0
LOAD_LAUNCHD=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id) PROJECT_ID="${2:-}"; shift 2 ;;
    --regions) REGIONS="${2:-}"; shift 2 ;;
    --model) MODEL_ID="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --litellm-bin) LITELLM_BIN="${2:-}"; shift 2 ;;
    --adc-path) ADC_PATH="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --launchagents-dir) LAUNCHAGENTS_DIR="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --stdout-log) STDOUT_LOG="${2:-}"; shift 2 ;;
    --stderr-log) STDERR_LOG="${2:-}"; shift 2 ;;
    --skip-quota-project) SKIP_QUOTA_PROJECT=1; shift ;;
    --no-load) LOAD_LAUNCHD=0; shift ;;
    --dry-run) DRY_RUN=1; LOAD_LAUNCHD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

fail() {
  printf 'gemini_litellm_install: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local name="$1"
  local value="$2"
  [[ -n "${value}" ]] || fail "${name} is required"
}

resolve_litellm_bin() {
  if [[ -n "${LITELLM_BIN}" ]]; then
    printf '%s\n' "${LITELLM_BIN}"
    return 0
  fi
  if command -v litellm >/dev/null 2>&1; then
    command -v litellm
    return 0
  fi
  if [[ -x "${HOME}/Library/Python/3.9/bin/litellm" ]]; then
    printf '%s\n' "${HOME}/Library/Python/3.9/bin/litellm"
    return 0
  fi
  fail "LiteLLM executable not found. Install LiteLLM or pass --litellm-bin <path>."
}

validate_region_list() {
  local csv="$1"
  [[ -n "${csv}" ]] || fail "--regions cannot be empty"
  IFS=',' read -r -a parts <<< "${csv}"
  for raw in "${parts[@]}"; do
    local region
    region="$(trim "${raw}")"
    [[ -n "${region}" ]] || fail "--regions contains an empty entry"
    [[ "${region}" =~ ^[a-z0-9-]+$ ]] || fail "invalid Vertex region: ${region}"
  done
}

trim() {
  local value="$*"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

render_config() {
  local out="$1"
  : > "${out}"
  {
    printf 'model_list:\n'
    IFS=',' read -r -a parts <<< "${REGIONS}"
    for raw in "${parts[@]}"; do
      local region
      region="$(trim "${raw}")"
      cat <<YAML
  - model_name: gemini-router
    litellm_params:
      model: vertex_ai/${MODEL_ID}
      vertex_project: "${PROJECT_ID}"
      vertex_location: "${region}"
YAML
    done
    cat <<'YAML'

router_settings:
  routing_strategy: usage-based-routing
  num_retries: 3
  allowed_fails: 2
  cooldown_time: 60
  enable_health_check_routing: true
YAML
  } >> "${out}"
}

replace_all() {
  local file="$1"
  local needle="$2"
  local replacement="$3"
  python3 - "$file" "$needle" "$replacement" <<'PY'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
needle = sys.argv[2]
replacement = sys.argv[3]
path.write_text(path.read_text().replace(needle, replacement))
PY
}

render_plist() {
  local out="$1"
  local litellm_bin="$2"
  local config_path="$3"
  cp "${REPO_ROOT}/templates/gemini/com.litellm.proxy.plist.template" "${out}"
  replace_all "${out}" "__LAUNCHD_LABEL__" "${LABEL}"
  replace_all "${out}" "__LITELLM_BIN__" "${litellm_bin}"
  replace_all "${out}" "__CONFIG_PATH__" "${config_path}"
  replace_all "${out}" "__PORT__" "${PORT}"
  replace_all "${out}" "__ADC_PATH__" "${ADC_PATH}"
  replace_all "${out}" "__STDOUT_LOG__" "${STDOUT_LOG}"
  replace_all "${out}" "__STDERR_LOG__" "${STDERR_LOG}"
}

validate_plist() {
  local plist_path="$1"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "${plist_path}" >/dev/null
  fi
}

set_quota_project() {
  if [[ "${SKIP_QUOTA_PROJECT}" == "1" || "${DRY_RUN}" == "1" ]]; then
    printf 'quota_project=skipped\n'
    return 0
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    printf 'quota_project=skipped_missing_gcloud\n'
    return 0
  fi
  gcloud auth application-default set-quota-project "${PROJECT_ID}"
  printf 'quota_project=set\n'
}

load_launchd() {
  local plist_path="$1"
  if [[ "${LOAD_LAUNCHD}" != "1" ]]; then
    printf 'launchd_load=skipped\n'
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'launchd_load=skipped_non_macos\n'
    return 0
  fi
  local uid
  uid="$(id -u)"
  launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${uid}" "${plist_path}"
  launchctl enable "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${uid}/${LABEL}"
  printf 'launchd_load=loaded\n'
}

require_value "--project-id" "${PROJECT_ID}"
require_value "--model" "${MODEL_ID}"
require_value "--port" "${PORT}"
validate_region_list "${REGIONS}"
[[ "${PORT}" =~ ^[0-9]+$ ]] || fail "invalid port: ${PORT}"

LITELLM_BIN="$(resolve_litellm_bin)"
[[ -x "${LITELLM_BIN}" ]] || fail "LiteLLM executable is not executable: ${LITELLM_BIN}"
[[ -f "${ADC_PATH}" ]] || fail "ADC file not found: ${ADC_PATH}. Run gcloud auth application-default login first."

CONFIG_PATH="${OUTPUT_DIR}/config.yaml"
PLIST_PATH="${LAUNCHAGENTS_DIR}/${LABEL}.plist"

mkdir -p "${OUTPUT_DIR}" "${LAUNCHAGENTS_DIR}"
render_config "${CONFIG_PATH}"
render_plist "${PLIST_PATH}" "${LITELLM_BIN}" "${CONFIG_PATH}"
validate_plist "${PLIST_PATH}"
set_quota_project
load_launchd "${PLIST_PATH}"

printf 'dry_run=%s\n' "$([[ "${DRY_RUN}" == "1" ]] && printf true || printf false)"
printf 'config_path=%s\n' "${CONFIG_PATH}"
printf 'plist_path=%s\n' "${PLIST_PATH}"
printf 'litellm_bin=%s\n' "${LITELLM_BIN}"
printf 'adc_path=%s\n' "${ADC_PATH}"
printf 'regions=%s\n' "${REGIONS}"
printf 'port=%s\n' "${PORT}"
