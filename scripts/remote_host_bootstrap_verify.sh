#!/usr/bin/env bash
set -euo pipefail

REMOTE_SSH="${1:-${MASTER_MOLD_REMOTE_SSH:-dan.driver@Dans-MBP.local}}"
REMOTE_REPO_ROOT="${2:-${MASTER_MOLD_REMOTE_REPO_ROOT:-/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD}}"
GIT_URL="${MASTER_MOLD_BOOTSTRAP_GIT_URL:-git@github.com:driverd12/MASTER-MOLD.git}"
BRANCH="${MASTER_MOLD_BOOTSTRAP_BRANCH:-main}"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

REMOTE_SCRIPT=$(cat <<'EOS'
set -euo pipefail
repo_root="$1"
git_url="$2"
branch="$3"
parent="$(dirname "$repo_root")"
mkdir -p "$parent"
if [[ ! -d "$repo_root/.git" ]]; then
  git clone "$git_url" "$repo_root"
fi
cd "$repo_root"
git fetch --all --prune
git checkout "$branch"
git pull --ff-only origin "$branch"
if [[ -f package-lock.json ]]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi
npm run build
context_json="$(node scripts/remote_context_probe.mjs --action=status 2>/dev/null || true)"
device_fingerprint="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4; exit}' || true)"
public_key_fingerprint="$(for f in ~/.ssh/*.pub; do [[ -f "$f" ]] && ssh-keygen -lf "$f" 2>/dev/null && break; done || true)"
printf '{"ok":true,"hostname":%s,"repo_root":%s,"git_head":%s,"device_fingerprint":%s,"public_key_fingerprint":%s,"context_probe":%s}\n' \
  "$(hostname | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(pwd | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(git rev-parse HEAD | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(printf '%s' "$device_fingerprint" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(printf '%s' "$public_key_fingerprint" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "${context_json:-null}"
EOS
)

ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE_SSH" "bash -s -- $(printf '%q' "$REMOTE_REPO_ROOT") $(printf '%q' "$GIT_URL") $(printf '%q' "$BRANCH")" <<<"$REMOTE_SCRIPT"
