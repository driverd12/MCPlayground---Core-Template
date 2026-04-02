#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-mcagent}"
DEFAULT_ADMIN_USER="${SUDO_USER:-$(stat -f%Su /dev/console 2>/dev/null || true)}"
ADMIN_USER="${2:-${DEFAULT_ADMIN_USER}}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root (try: sudo $0 ${ACCOUNT} ${DEFAULT_ADMIN_USER:-dan.driver})" >&2
  exit 2
fi

if ! id "${ACCOUNT}" >/dev/null 2>&1; then
  echo "error: account '${ACCOUNT}' does not exist" >&2
  exit 2
fi

if [[ -z "${ADMIN_USER}" ]]; then
  echo "error: could not determine a Secure Token-enabled admin user; pass one explicitly as the second argument" >&2
  exit 2
fi

if ! id "${ADMIN_USER}" >/dev/null 2>&1; then
  echo "error: admin user '${ADMIN_USER}' does not exist" >&2
  exit 2
fi

SECURE_TOKEN_STATUS="$(sysadminctl -secureTokenStatus "${ADMIN_USER}" 2>&1 || true)"
if ! printf '%s' "${SECURE_TOKEN_STATUS}" | grep -q "ENABLED"; then
  echo "error: admin user '${ADMIN_USER}' does not have Secure Token enabled" >&2
  printf '%s\n' "${SECURE_TOKEN_STATUS}" >&2
  exit 2
fi

echo "Resetting '${ACCOUNT}' using Secure Token-enabled admin '${ADMIN_USER}'."
echo "You will be prompted by macOS for:"
echo "1. ${ADMIN_USER}'s password"
echo "2. the new password for ${ACCOUNT}"
echo "3. the new password confirmation"

TMP_LOG="$(mktemp -t mcagent-reset-XXXXXX.log)"
cleanup() {
  rm -f "${TMP_LOG}"
}
trap cleanup EXIT

/usr/sbin/sysadminctl \
  -adminUser "${ADMIN_USER}" \
  -adminPassword - \
  -resetPasswordFor "${ACCOUNT}" \
  -newPassword - \
  2>&1 | tee "${TMP_LOG}"

RESET_OUTPUT="$(cat "${TMP_LOG}")"
if printf '%s' "${RESET_OUTPUT}" | grep -Eqi "Operation is not permitted|Authentication server refused operation|Error Domain|failed"; then
  echo "error: macOS did not complete the password reset for '${ACCOUNT}'" >&2
  exit 1
fi

node --input-type=module - <<'NODE' "${ACCOUNT}" "${ADMIN_USER}"
const [account, adminUser] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      account,
      admin_user: adminUser,
      note: "Updated the live macOS account password. Re-run ./scripts/provision_mcagent_secret.sh with the same password to sync the local secret file.",
    },
    null,
    2
  )}\n`
);
NODE
