#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"

case "${OSTYPE:-}" in
  darwin*)
    SUPPORT_ROOT="${HOME}/Library/Application Support/master-mold"
    ;;
  linux*)
    SUPPORT_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/master-mold"
    ;;
  *)
    SUPPORT_ROOT="${HOME}/.master-mold"
    ;;
esac

BIN_DIR="${SUPPORT_ROOT}/bin"
STATE_FILE="${SUPPORT_ROOT}/repo-root"

mkdir -p "${BIN_DIR}"
printf '%s\n' "${REPO_ROOT}" > "${STATE_FILE}"
chmod 600 "${STATE_FILE}" >/dev/null 2>&1 || true

cat > "${BIN_DIR}/run_from_repo.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

SUPPORT_ROOT="${SUPPORT_ROOT}"
STATE_FILE="${STATE_FILE}"
FALLBACK_REPO_ROOT="${REPO_ROOT}"

node_major() {
  local candidate="\$1"
  "\${candidate}" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true
}

is_supported_node_bin() {
  local candidate="\${1:-}"
  local major=""
  [[ -n "\${candidate}" && -x "\${candidate}" ]] || return 1
  major="\$(node_major "\${candidate}")"
  [[ "\${major}" =~ ^[0-9]+$ ]] || return 1
  (( major >= 20 && major < 23 ))
}

resolve_node_bin() {
  local candidate=""
  if is_supported_node_bin "\${MASTER_MOLD_NODE_BIN:-}"; then
    printf '%s\n' "\${MASTER_MOLD_NODE_BIN}"
    return 0
  fi
  for candidate in \
    "/opt/homebrew/opt/node@22/bin/node" \
    "/usr/local/opt/node@22/bin/node" \
    "/opt/homebrew/opt/node@20/bin/node" \
    "/usr/local/opt/node@20/bin/node" \
    "\$(command -v node 2>/dev/null || true)"; do
    if is_supported_node_bin "\${candidate}"; then
      printf '%s\n' "\${candidate}"
      return 0
    fi
  done
  echo "error: MASTER-MOLD requires Node >=20 <23; set MASTER_MOLD_NODE_BIN to a supported Node binary" >&2
  exit 2
}

is_valid_repo_root() {
  local candidate="\${1:-}"
  [[ -n "\${candidate}" ]] || return 1
  [[ -d "\${candidate}" ]] || return 1
  [[ -f "\${candidate}/scripts/mcp_http_runner.mjs" ]] || return 1
  [[ -f "\${candidate}/scripts/launchd_install.sh" ]] || return 1
}

persist_repo_root() {
  local candidate="\$1"
  mkdir -p "\${SUPPORT_ROOT}"
  printf '%s\n' "\${candidate}" > "\${STATE_FILE}"
  chmod 600 "\${STATE_FILE}" >/dev/null 2>&1 || true
}

search_repo_root() {
  local scan_root=""
  local package_json=""
  local candidate=""
  for scan_root in \
    "\${HOME}/Documents/Playground/Agentic Playground" \
    "\${HOME}/Documents/Playground" \
    "\${HOME}/Documents" \
    "\${HOME}/Projects"; do
    [[ -d "\${scan_root}" ]] || continue
    while IFS= read -r package_json; do
      candidate="\${package_json%/package.json}"
      if is_valid_repo_root "\${candidate}"; then
        printf '%s\n' "\${candidate}"
        return 0
      fi
    done < <(find "\${scan_root}" -maxdepth 5 -type f -name package.json 2>/dev/null)
  done
  return 1
}

resolve_repo_root() {
  local candidate=""
  candidate="\${MASTER_MOLD_REPO_ROOT:-}"
  if is_valid_repo_root "\${candidate}"; then
    printf '%s\n' "\${candidate}"
    return 0
  fi
  if [[ -f "\${STATE_FILE}" ]]; then
    candidate="\$(tr -d '\r\n' < "\${STATE_FILE}")"
    if is_valid_repo_root "\${candidate}"; then
      printf '%s\n' "\${candidate}"
      return 0
    fi
  fi
  if is_valid_repo_root "\${FALLBACK_REPO_ROOT}"; then
    printf '%s\n' "\${FALLBACK_REPO_ROOT}"
    return 0
  fi
  if candidate="\$(search_repo_root)"; then
    printf '%s\n' "\${candidate}"
    return 0
  fi
  echo "error: unable to resolve MASTER MOLD repo root" >&2
  exit 2
}

REPO_ROOT="\$(resolve_repo_root)"
persist_repo_root "\${REPO_ROOT}"
cd "\${REPO_ROOT}"

expand_arg() {
  local arg="\$1"
  case "\${arg}" in
    __MASTER_MOLD_REPO_ROOT__)
      printf '%s\n' "\${REPO_ROOT}"
      ;;
    __MASTER_MOLD_SUPPORT_ROOT__)
      printf '%s\n' "\${SUPPORT_ROOT}"
      ;;
    *)
      printf '%s\n' "\${arg}"
      ;;
  esac
}

resolve_existing_path() {
  local candidate="\$1"
  local suffix=""
  local rebased=""
  if [[ -e "\${candidate}" ]]; then
    printf '%s\n' "\${candidate}"
    return 0
  fi
  if [[ "\${candidate}" != /* ]]; then
    rebased="\${REPO_ROOT}/\${candidate#./}"
    if [[ -e "\${rebased}" ]]; then
      printf '%s\n' "\${rebased}"
      return 0
    fi
  fi
  if [[ "\${candidate}" == */.venv-mlx/* ]]; then
    suffix="\${candidate#*/.venv-mlx/}"
    rebased="\${REPO_ROOT}/.venv-mlx/\${suffix}"
    if [[ -e "\${rebased}" ]]; then
      printf '%s\n' "\${rebased}"
      return 0
    fi
  fi
  if [[ "\${candidate}" == */data/* ]]; then
    suffix="\${candidate#*/data/}"
    rebased="\${REPO_ROOT}/data/\${suffix}"
    if [[ -e "\${rebased}" ]]; then
      printf '%s\n' "\${rebased}"
      return 0
    fi
  fi
  printf '%s\n' "\${candidate}"
}

MODE="\${1:-}"
if [[ -z "\${MODE}" ]]; then
  echo "usage: run_from_repo.sh <node-script|shell-script|python-module> ..." >&2
  exit 2
fi
shift

case "\${MODE}" in
  node-script)
    SCRIPT_REL="\${1:-}"
    [[ -n "\${SCRIPT_REL}" ]] || { echo "error: node-script requires a repo-relative script path" >&2; exit 2; }
    shift
    NODE_BIN="\$(resolve_node_bin)"
    EXPANDED_ARGS=()
    for arg in "\$@"; do
      EXPANDED_ARGS+=("\$(resolve_existing_path "\$(expand_arg "\${arg}")")")
    done
    if (( \${#EXPANDED_ARGS[@]} )); then
      exec "\${NODE_BIN}" "\${REPO_ROOT}/\${SCRIPT_REL}" "\${EXPANDED_ARGS[@]}"
    fi
    exec "\${NODE_BIN}" "\${REPO_ROOT}/\${SCRIPT_REL}"
    ;;
  shell-script)
    SCRIPT_REL="\${1:-}"
    [[ -n "\${SCRIPT_REL}" ]] || { echo "error: shell-script requires a repo-relative script path" >&2; exit 2; }
    shift
    EXPANDED_ARGS=()
    for arg in "\$@"; do
      EXPANDED_ARGS+=("\$(resolve_existing_path "\$(expand_arg "\${arg}")")")
    done
    if (( \${#EXPANDED_ARGS[@]} )); then
      exec "\${REPO_ROOT}/\${SCRIPT_REL}" "\${EXPANDED_ARGS[@]}"
    fi
    exec "\${REPO_ROOT}/\${SCRIPT_REL}"
    ;;
  python-module)
    PYTHON_PATH="\${1:-}"
    MODULE_NAME="\${2:-}"
    [[ -n "\${PYTHON_PATH}" && -n "\${MODULE_NAME}" ]] || { echo "error: python-module requires a python path and module name" >&2; exit 2; }
    shift 2
    RESOLVED_PYTHON="\$(resolve_existing_path "\${PYTHON_PATH}")"
    [[ -e "\${RESOLVED_PYTHON}" ]] || { echo "error: python launcher not found: \${PYTHON_PATH}" >&2; exit 2; }
    EXPANDED_ARGS=()
    for arg in "\$@"; do
      EXPANDED_ARGS+=("\$(resolve_existing_path "\$(expand_arg "\${arg}")")")
    done
    if (( \${#EXPANDED_ARGS[@]} )); then
      exec "\${RESOLVED_PYTHON}" -m "\${MODULE_NAME}" "\${EXPANDED_ARGS[@]}"
    fi
    exec "\${RESOLVED_PYTHON}" -m "\${MODULE_NAME}"
    ;;
  *)
    echo "usage: run_from_repo.sh <node-script|shell-script|python-module> ..." >&2
    exit 2
    ;;
esac
EOF

cat > "${BIN_DIR}/open_agent_office.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ACTION="\${1:-open}"
if [[ \$# -gt 0 ]]; then
  shift
fi

exec "${BIN_DIR}/run_from_repo.sh" node-script scripts/agent_office_gui.mjs "\${ACTION}" "\$@"
EOF

cat > "${BIN_DIR}/open_agentic_suite.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ACTION="\${1:-open}"
if [[ \$# -gt 0 ]]; then
  shift
fi

exec "${BIN_DIR}/run_from_repo.sh" node-script scripts/agentic_suite_launch.mjs "\${ACTION}" "\$@"
EOF

cat > "${BIN_DIR}/auto_open_default.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

case "\${MASTER_MOLD_AUTO_OPEN_TARGET:-office}" in
  off|none|disabled)
    exit 0
    ;;
  suite)
    exec "${BIN_DIR}/open_agentic_suite.sh" open
    ;;
  *)
    exec "${BIN_DIR}/open_agent_office.sh" open
    ;;
esac
EOF

chmod 755 \
  "${BIN_DIR}/run_from_repo.sh" \
  "${BIN_DIR}/open_agent_office.sh" \
  "${BIN_DIR}/open_agentic_suite.sh" \
  "${BIN_DIR}/auto_open_default.sh"

printf '{"ok":true,"support_root":"%s","repo_root":"%s"}\n' "${SUPPORT_ROOT}" "${REPO_ROOT}"
