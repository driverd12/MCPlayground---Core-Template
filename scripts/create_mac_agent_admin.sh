#!/usr/bin/env bash
set -euo pipefail

SHORT_NAME="${1:-mcagent}"
FULL_NAME="${2:-MC Agent}"
OWNER_USER="${3:-dan.driver}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root" >&2
  exit 2
fi

if ! id "${OWNER_USER}" >/dev/null 2>&1; then
  echo "error: owner user '${OWNER_USER}' does not exist" >&2
  exit 2
fi

OWNER_HOME="$(dscl . -read "/Users/${OWNER_USER}" NFSHomeDirectory | awk '{print $2}')"
if [[ -z "${OWNER_HOME}" || ! -d "${OWNER_HOME}" ]]; then
  echo "error: could not resolve home directory for '${OWNER_USER}'" >&2
  exit 2
fi

SECRETS_DIR="${OWNER_HOME}/.codex/secrets"
PASS_FILE="${SECRETS_DIR}/${SHORT_NAME}_admin_password"

mkdir -p "${SECRETS_DIR}"
chown "${OWNER_USER}:staff" "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

if id "${SHORT_NAME}" >/dev/null 2>&1; then
  echo "already-exists"
  exit 0
fi

PASSWORD="$(
  /usr/bin/openssl rand -base64 24 | /usr/bin/tr '+/' '-_' | /usr/bin/tr -d '\n=' | /usr/bin/cut -c1-32
)"

/usr/sbin/sysadminctl -addUser "${SHORT_NAME}" -fullName "${FULL_NAME}" -password "${PASSWORD}" -home "/Users/${SHORT_NAME}" -admin
/usr/sbin/createhomedir -c -u "${SHORT_NAME}" >/dev/null 2>&1 || true
/usr/bin/dscl . -create "/Users/${SHORT_NAME}" UserShell /bin/zsh || true
/bin/chmod 700 "/Users/${SHORT_NAME}" || true

printf '%s' "${PASSWORD}" > "${PASS_FILE}"
/usr/sbin/chown "${OWNER_USER}:staff" "${PASS_FILE}"
/bin/chmod 600 "${PASS_FILE}"

echo "created"
