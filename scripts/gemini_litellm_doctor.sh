#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/gemini_litellm_doctor.sh [options]

Options:
  --url <url>               LiteLLM health URL. Default: http://127.0.0.1:4000/health
  --label <label>           launchd label. Default: com.litellm.proxy
  --config <path>           LiteLLM config path. Default: ~/.gemini/proxy/config.yaml
  --adc-path <path>         ADC JSON path. Default: ~/.config/gcloud/application_default_credentials.json
  --plist <path>            LaunchAgent plist. Default: ~/Library/LaunchAgents/com.litellm.proxy.plist
  -h, --help                Show this help.

The doctor prints operational state only. It never prints OAuth tokens,
credential JSON content, API keys, or private project secrets.
USAGE
}

URL="http://127.0.0.1:4000/health"
LABEL="com.litellm.proxy"
CONFIG_PATH="${HOME}/.gemini/proxy/config.yaml"
ADC_PATH="${HOME}/.config/gcloud/application_default_credentials.json"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.litellm.proxy.plist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --adc-path) ADC_PATH="${2:-}"; shift 2 ;;
    --plist) PLIST_PATH="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 
}

field_bool() {
  local name="$1"
  local value="$2"
  printf '"%s":%s' "${name}" "${value}"
}

launchd_state() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'not_macos'
    return 0
  fi
  if launchctl print "gui/$(id -u)/${LABEL}" >/tmp/gemini-litellm-launchd.txt 2>/dev/null; then
    awk -F'= ' '/state = / {gsub(/[[:space:]]/, "", $2); print $2; exit}' /tmp/gemini-litellm-launchd.txt
  else
    printf 'missing'
  fi
}

quota_project() {
  python3 - "${ADC_PATH}" <<'PY'
import json
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("")
    raise SystemExit
try:
    data = json.loads(path.read_text())
except Exception:
    print("")
    raise SystemExit
print(data.get("quota_project_id", ""))
PY
}

config_regions() {
  python3 - "${CONFIG_PATH}" <<'PY'
import pathlib
import re
import sys
path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("")
    raise SystemExit
regions = []
for line in path.read_text().splitlines():
    m = re.match(r'\s*vertex_location:\s*"?([^"\s]+)"?\s*$', line)
    if m:
        regions.append(m.group(1))
print(",".join(regions))
PY
}

health_body="$(mktemp "${TMPDIR:-/tmp}/gemini-litellm-health.XXXXXX")"
health_code="$(curl -sS -o "${health_body}" -w '%{http_code}' "${URL}" 2>/tmp/gemini-litellm-curl.err || true)"
launchd="$(launchd_state)"
quota="$(quota_project)"
regions="$(config_regions)"

ok=true
[[ "${health_code}" == "200" ]] || ok=false
[[ -f "${CONFIG_PATH}" ]] || ok=false
[[ -f "${ADC_PATH}" ]] || ok=false
[[ -f "${PLIST_PATH}" ]] || ok=false
[[ "${launchd}" == "running" || "${launchd}" == "not_macos" ]] || ok=false

printf '{'
field_bool ok "${ok}"
printf ',"health_http":%s' "$(printf '%s' "${health_code:-0}" | json_escape)"
printf ',"health_url":%s' "$(printf '%s' "${URL}" | json_escape)"
printf ',"launchd_state":%s' "$(printf '%s' "${launchd}" | json_escape)"
printf ',"config_present":%s' "$([[ -f "${CONFIG_PATH}" ]] && printf true || printf false)"
printf ',"plist_present":%s' "$([[ -f "${PLIST_PATH}" ]] && printf true || printf false)"
printf ',"adc_present":%s' "$([[ -f "${ADC_PATH}" ]] && printf true || printf false)"
printf ',"adc_quota_project_set":%s' "$([[ -n "${quota}" ]] && printf true || printf false)"
printf ',"configured_regions":%s' "$(printf '%s' "${regions}" | json_escape)"
if [[ -s "${health_body}" ]]; then
  healthy_count="$(python3 - "${health_body}" <<'PY'
import json
import pathlib
import sys
try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception:
    print("")
    raise SystemExit
print(data.get("healthy_count", ""))
PY
)"
  unhealthy_count="$(python3 - "${health_body}" <<'PY'
import json
import pathlib
import sys
try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception:
    print("")
    raise SystemExit
print(data.get("unhealthy_count", ""))
PY
)"
  printf ',"healthy_count":%s' "$(printf '%s' "${healthy_count}" | json_escape)"
  printf ',"unhealthy_count":%s' "$(printf '%s' "${unhealthy_count}" | json_escape)"
fi
printf '}\n'
rm -f "${health_body}"

if [[ "${ok}" != "true" ]]; then
  exit 1
fi
