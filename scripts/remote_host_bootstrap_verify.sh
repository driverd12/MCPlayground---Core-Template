#!/usr/bin/env bash
set -euo pipefail

REMOTE_SSH="${1:-${MASTER_MOLD_REMOTE_SSH:-dan.driver@Dans-MBP.local}}"
REMOTE_REPO_ROOT="${2:-${MASTER_MOLD_REMOTE_REPO_ROOT:-/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD}}"
GIT_URL="${MASTER_MOLD_BOOTSTRAP_GIT_URL:-git@github.com:driverd12/MASTER-MOLD.git}"
BRANCH="${MASTER_MOLD_BOOTSTRAP_BRANCH:-main}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: scripts/remote_host_bootstrap_verify.sh [ssh-target] [remote-repo-root]

Bootstraps and verifies one remote MASTER-MOLD host. Repeat this command for
each approved host in the N-host fabric. Defaults can be overridden with:
  MASTER_MOLD_REMOTE_SSH
  MASTER_MOLD_REMOTE_REPO_ROOT
  MASTER_MOLD_BOOTSTRAP_GIT_URL
  MASTER_MOLD_BOOTSTRAP_BRANCH
EOF
  exit 0
fi

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

REMOTE_SCRIPT=$(cat <<'EOS'
set -euo pipefail
repo_root="$1"
git_url="$2"
branch="$3"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
for candidate in "$HOME"/.nvm/versions/node/*/bin /opt/homebrew/bin /usr/local/bin "$HOME"/.local/node-*/bin; do
  if [[ -d "$candidate" ]]; then
    PATH="$candidate:$PATH"
  fi
done
export PATH
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
  npm ci
else
  npm install
fi
npm run build
native_sqlite_json="$(
  node -e 'import("better-sqlite3").then(({default: Database}) => { const db = new Database(":memory:"); db.prepare("select 1 as ok").get(); db.close(); console.log(JSON.stringify({ok:true, module:"better-sqlite3"})); }).catch((error) => { console.log(JSON.stringify({ok:false, module:"better-sqlite3", error: String(error && error.message || error)})); process.exit(1); })'
)"
context_json="$(node scripts/remote_context_probe.mjs --action=status 2>/dev/null || true)"
mac_address="$(networksetup -listallhardwareports 2>/dev/null | awk '/Device:/{dev=$2} /Ethernet Address:/{print $3; exit}' || ifconfig en0 2>/dev/null | awk '/ether/{print $2; exit}' || true)"
device_fingerprint="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4; exit}' || true)"
public_key_fingerprint="$(for f in ~/.ssh/*.pub; do [[ -f "$f" ]] && ssh-keygen -lf "$f" 2>/dev/null && break; done || true)"
printf '{"ok":true,"hostname":%s,"repo_root":%s,"git_head":%s,"mac_address":%s,"device_fingerprint":%s,"public_key_fingerprint":%s,"native_sqlite":%s,"context_probe":%s}\n' \
  "$(hostname | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(pwd | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(git rev-parse HEAD | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(printf '%s' "$mac_address" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(printf '%s' "$device_fingerprint" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "$(printf '%s' "$public_key_fingerprint" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
  "${native_sqlite_json:-null}" \
  "${context_json:-null}"
EOS
)

ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE_SSH" "bash -s -- $(printf '%q' "$REMOTE_REPO_ROOT") $(printf '%q' "$GIT_URL") $(printf '%q' "$BRANCH")" <<<"$REMOTE_SCRIPT"
