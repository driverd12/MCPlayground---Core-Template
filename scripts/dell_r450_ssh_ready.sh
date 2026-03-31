#!/usr/bin/env bash
set -euo pipefail

HOST="idrac-r450"
USER_NAME="root"
PORT="22"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dell_r450_ssh_ready.sh [--host idrac-or-server] [--user root] [--port 22]

This script does not modify ~/.ssh/config. It prints a ready-to-paste host block and reports
whether a local ed25519 key is already available.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --user)
      USER_NAME="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

printf '[dell] ssh client: %s\n' "$(ssh -V 2>&1 | head -n 1)"
if [[ -f "${HOME}/.ssh/id_ed25519.pub" ]]; then
  printf '[dell] ssh key ready: %s\n' "${HOME}/.ssh/id_ed25519.pub"
else
  printf '[dell] ssh key missing: %s\n' "${HOME}/.ssh/id_ed25519.pub"
  printf '[dell] generate with: ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "dan.driver@%s"\n' "${HOST}"
fi

cat <<EOF

[dell] suggested ~/.ssh/config block
Host ${HOST}
  HostName ${HOST}
  User ${USER_NAME}
  Port ${PORT}
  ServerAliveInterval 30
  ServerAliveCountMax 4
  ConnectTimeout 10
  StrictHostKeyChecking accept-new

[dell] first connection
  ssh ${USER_NAME}@${HOST} -p ${PORT}

[dell] if using iDRAC Serial Over LAN after SSH
  racadm console com2
EOF
