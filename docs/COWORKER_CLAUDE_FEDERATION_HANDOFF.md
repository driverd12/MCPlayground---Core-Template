# Coworker Claude Federation Handoff

This document is written for Claude Code running on the coworker's Mac. Follow it exactly to set up a local MASTER-MOLD MCP server and join Dan's peer-to-peer federated sidecar mesh.

The target topology is not a centralized MCP server. Each Mac runs its own local MASTER-MOLD MCP server. Federation is an ad-hoc signed sidecar stream between approved hosts so Claude, Codex, and other agents can share bounded operational context.

## Inputs From Dan

Before starting, ask Dan for these values:

```bash
export MASTER_MOLD_REPO_URL="https://github.com/driverd12/MASTER-MOLD.git"
export MASTER_MOLD_HOST_ID="<stable-coworker-host-id>"
export DAN_MASTER_MOLD_PEER_URL="http://<dan-host>.local:8787"
export MASTER_MOLD_1PASSWORD_VAULT="<vault-name>"
```

Use a stable `MASTER_MOLD_HOST_ID`, for example `first-last-mbp` or `first-last-mac-mini`. Do not use the current IP address as identity. IP addresses are only network locators and can change.

## Safety Rules

- Do not print, paste, commit, or send secrets.
- Do not commit `.env`, bearer tokens, Google ADC files, 1Password values, private keys, SQLite data, local logs, or recovery bundles.
- Do not pass secrets as command-line arguments when a tool supports 1Password or stdin.
- Do not claim live federation until Dan's peer accepts a signed ingest and the doctor confirms fresh sidecar state.
- Share only bounded signed context: recent summaries, active or blocked goals, and non-terminal or recently updated tasks. Do not replicate raw transcripts, screenshots, browser pixels, or full local memory stores.
- Keep durable trust tied to `host_id`, hostname/device evidence, and Ed25519 identity. Treat IP and `.local` hostname as current locator only.

## Phase 1: Clone And Build

```bash
set -euo pipefail

cd "$HOME/Documents" || exit 2
mkdir -p "Playground/Agentic Playground"
cd "Playground/Agentic Playground"

if [ ! -d MASTER-MOLD/.git ]; then
  git clone "$MASTER_MOLD_REPO_URL" MASTER-MOLD
fi

cd MASTER-MOLD
git status -sb
git fetch --all --prune
git pull --ff-only

npm run bootstrap:env:install || true
npm ci
npm run build
npm run doctor
```

If Node or npm versions are rejected, use the exact recommendation printed by `npm run doctor`, then rerun `npm ci` and `npm run build`.

## Phase 2: Install Claude MCP Provider Lane

Claude is the primary agent on this Mac. Register MASTER-MOLD with Claude first.

```bash
set -euo pipefail

cd "$HOME/Documents/Playground/Agentic Playground/MASTER-MOLD"

npm run providers:install -- --transport stdio claude-cli
npm run providers:status
npm run providers:diagnose -- claude-cli
```

Then verify from Claude if the CLI supports these commands:

```bash
claude mcp list
claude mcp get master-mold
```

If Claude does not show MASTER-MOLD, restart Claude Code and rerun the provider install. Do not assume Dan's Claude settings apply to this Mac.

## Phase 3: Start The Local MCP HTTP Lane

For initial setup, run this in a terminal and leave it open:

```bash
set -euo pipefail

cd "$HOME/Documents/Playground/Agentic Playground/MASTER-MOLD"
MCP_HTTP_ALLOW_LAN=1 npm run start:http
```

Expected local lane:

- MCP HTTP: `http://127.0.0.1:8787`
- Office GUI: `http://127.0.0.1:8787/office/`

If port `8787` is busy, inspect the existing process before changing ports:

```bash
npm run trichat:office:web:status
```

## Phase 4: Run Federation Onboarding

Use the one-command onboarding path. It creates or reuses host identity, stores recovery material in 1Password when available, writes non-secret `.env` values, requests access from Dan's peer, runs the sidecar once, and runs the doctor.

```bash
set -euo pipefail

cd "$HOME/Documents/Playground/Agentic Playground/MASTER-MOLD"

npm run federation:onboard -- \
  --host-id "$MASTER_MOLD_HOST_ID" \
  --vault "$MASTER_MOLD_1PASSWORD_VAULT" \
  --peer "$DAN_MASTER_MOLD_PEER_URL" \
  --require-1password \
  --json
```

If 1Password is not installed or not unlocked, stop and ask Dan whether to proceed without `--require-1password`. The preferred path is to use the coworker's employee-scoped 1Password access, not Dan's secrets.

## Phase 5: Dan Approval

If onboarding reports that remote access is pending, send Dan only this non-secret handoff:

```text
host_id: <MASTER_MOLD_HOST_ID>
hostname: <output of hostname>
local_mcp_url: http://<this-mac-hostname>.local:8787
peer_requested: <DAN_MASTER_MOLD_PEER_URL>
provider_primary: claude-cli
doctor_status: <ok / findings summary, with no tokens or secrets>
```

Dan approves the host from Agent Office or the federation operator tools. After Dan approves, rerun:

```bash
set -euo pipefail

cd "$HOME/Documents/Playground/Agentic Playground/MASTER-MOLD"

npm run federation:onboard -- \
  --host-id "$MASTER_MOLD_HOST_ID" \
  --vault "$MASTER_MOLD_1PASSWORD_VAULT" \
  --peer "$DAN_MASTER_MOLD_PEER_URL" \
  --require-1password \
  --json
```

## Phase 6: Install The Sidecar Keepalive

After the one-shot sidecar succeeds, install the launchd sidecar so context continues to publish after terminal sessions close.

```bash
set -euo pipefail

cd "$HOME/Documents/Playground/Agentic Playground/MASTER-MOLD"

npm run federation:launchd:install
npm run --silent federation:doctor -- --json
```

If the launchd script reports a different command name, use the exact command it prints. Do not manually edit launchd files unless the script says to.

## Phase 7: Live Validation

Run a 3-iteration live soak against Dan's peer:

```bash
set -euo pipefail

cd "$HOME/Documents/Playground/Agentic Playground/MASTER-MOLD"

npm run federation:soak -- \
  --peer "$DAN_MASTER_MOLD_PEER_URL" \
  --iterations 3 \
  --json
```

Live success means:

- Dan's peer accepts signed ingest with HTTP `202`.
- `federation:doctor -- --json` reports recent sidecar state.
- Peer count is healthy, outbox is empty or draining, and stale-peer findings are absent or explained.
- Dan can see this host in Agent Office with durable identity separate from the current locator.
- Shared context queries return signed provenance from this host.

If the soak uses local offline simulation, label that result as simulated. Do not present it as live remote validation.

## Troubleshooting

### Node Or Build Failure

```bash
npm run bootstrap:env:install
npm ci
npm run build
```

Use the version guidance from `npm run doctor`.

### Claude Cannot See MASTER-MOLD

```bash
npm run providers:install -- --transport stdio claude-cli
npm run providers:diagnose -- claude-cli
claude mcp list
claude mcp get master-mold
```

Restart Claude Code after provider changes.

### Peer Unreachable Or Unauthorized

Check:

- Dan's MCP HTTP lane is running.
- Coworker and Dan are on the same LAN or VPN path.
- `DAN_MASTER_MOLD_PEER_URL` is correct.
- Dan approved the durable `host_id`, not just the current IP.
- The bearer secret is present through 1Password or approved local setup.

Then rerun:

```bash
npm run --silent federation:doctor -- --json
```

### Sidecar Stale

```bash
npm run federation:repair -- --action sidecar-stale --peer "$DAN_MASTER_MOLD_PEER_URL" --json
npm run --silent federation:doctor -- --json
```

Do not rewrite host identity just because the Mac changed networks.

### Storage Guard Attention

If health tools report quarantine or recovery evidence, do not delete it automatically. Verify open files first and ask Dan before removing archives.

## Final Report Back To Dan

Return this summary:

```text
Repo commit:
Host ID:
Hostname:
Local MCP URL:
Claude provider status:
Federation doctor:
Sidecar state:
Live soak:
Live vs simulated:
Peer URL:
Remaining gaps:
Secrets exposed: no
Files changed locally:
```

## Reference Docs

- `docs/FEDERATION_MESH.md`
- `docs/COWORKER_MASTER_MOLD_FEDERATION_QUICKSTART.md`
- `docs/SETUP.md`
- `docs/IDE_AGENT_SETUP.md`
- `AGENTS.md`
- `CLAUDE.md`
