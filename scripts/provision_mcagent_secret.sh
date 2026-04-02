#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-mcagent}"
SECRET_DIR="${HOME}/.codex/secrets"
SECRET_PATH="${MCP_MCAGENT_SECRET_PATH:-${SECRET_DIR}/${ACCOUNT}_admin_password}"

mkdir -p "${SECRET_DIR}"
chmod 700 "${SECRET_DIR}"

if [[ -t 0 ]]; then
  read -rsp "Enter password for ${ACCOUNT}: " PASSWORD
  echo
  read -rsp "Re-enter password for ${ACCOUNT}: " VERIFY_PASSWORD
  echo
  if [[ "${PASSWORD}" != "${VERIFY_PASSWORD}" ]]; then
    echo "error: password confirmation mismatch" >&2
    exit 2
  fi
else
  IFS= read -r PASSWORD
fi

if [[ -z "${PASSWORD}" ]]; then
  echo "error: empty password" >&2
  exit 2
fi

printf '%s' "${PASSWORD}" > "${SECRET_PATH}"
chmod 600 "${SECRET_PATH}"

node --input-type=module - <<'NODE' "${ACCOUNT}" "${SECRET_PATH}"
const [account, secretPath] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      account,
      secret_path: secretPath,
      backend: "local_file",
      note: "Stored outside the repo and outside SQLite state.",
    },
    null,
    2
  )}\n`
);
NODE
