#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

print_help() {
  cat <<'HELP'
Agent Office Intake

Type a plain-language objective and press Enter. The office will:
1. ensure autonomy bootstrap readiness
2. open a durable goal
3. compile bounded work
4. dispatch execution through the autonomous stack

Slash commands:
  /help       Show this help
  /status     Show autonomy/ring-leader status
  /ensure     Re-run autonomy bootstrap ensure
  /dry <obj>  Submit an objective in dry-run mode
  /quit       Exit the intake desk
HELP
}

trim_line() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

run_objective() {
  local objective="$1"
  shift || true
  if [[ -z "${objective}" ]]; then
    return 0
  fi
  echo
  echo "[intake] submitting objective:"
  echo "  ${objective}"
  echo
  ./scripts/autonomy_ide_ingress.sh "$@" -- "${objective}"
}

if [[ -t 1 && -n "${TERM:-}" ]]; then
  clear || true
fi
echo "=============================================================="
echo " Agent Office Intake Desk"
echo "=============================================================="
print_help
echo
./scripts/autonomy_ctl.sh ensure >/dev/null
echo "[intake] autonomy control plane is ready."

while true; do
  echo
  read -r -p "office/intake> " raw_line || exit 0
  line="$(trim_line "${raw_line}")"
  if [[ -z "${line}" ]]; then
    continue
  fi
  case "${line}" in
    /quit|quit|exit|:q)
      exit 0
      ;;
    /help|help)
      print_help
      ;;
    /status)
      ./scripts/autonomy_ctl.sh status
      ;;
    /ensure)
      ./scripts/autonomy_ctl.sh ensure
      ;;
    /dry\ *)
      run_objective "$(trim_line "${line#/dry }")" --dry-run
      ;;
    *)
      run_objective "${line}"
      ;;
  esac
done
