# Coworker MASTER-MOLD Quickstart

GitHub repo: [driverd12/MASTER-MOLD](https://github.com/driverd12/MASTER-MOLD)

Claude-first setup: [Coworker Claude Federation Handoff](./COWORKER_CLAUDE_FEDERATION_HANDOFF.md).

## 1. Install and Build

```bash
git clone https://github.com/driverd12/MASTER-MOLD.git
cd MASTER-MOLD
npm ci
npm run build
npm run doctor
```

If `doctor` is not ready, see [Setup](https://github.com/driverd12/MASTER-MOLD/blob/main/docs/SETUP.md).

## 2. Add MASTER-MOLD to Your AI Client

Pick the client you use:

```bash
npm run providers:install -- --transport stdio claude-cli
npm run providers:install -- --transport stdio codex
npm run providers:install -- --transport stdio github-copilot-vscode
```

Then restart Claude, Codex, or VS Code.

More detail: [Provider Bridge Matrix](https://github.com/driverd12/MASTER-MOLD/blob/main/docs/PROVIDER_BRIDGE_MATRIX.md).

## 3. Start the Local MCP Server

```bash
MCP_HTTP_ALLOW_LAN=1 npm run start:http
```

Keep this running while testing.

## 4. Join the Federated Sidecar Mesh

Prereq: Dan grants access to the `MASTER-MOLD Federation` 1Password vault and gives you the peer URL.

```bash
brew install --cask 1password-cli

export MASTER_MOLD_FEDERATION_SHARED_BEARER_TOKEN="$(
  op read 'op://MASTER-MOLD Federation/MASTER-MOLD MCP - dans-macbook-pro - dan.driver/MCP_HTTP_BEARER_TOKEN'
)"

npm run federation:secrets:bootstrap -- \
  --vault "MASTER-MOLD Federation" \
  --host-id "<your-stable-host-id>" \
  --peers "<dan-peer-url>" \
  --write-env \
  --require-1password

unset MASTER_MOLD_FEDERATION_SHARED_BEARER_TOKEN
```

Request approval from Dan's peer:

```bash
node scripts/request_remote_access.mjs \
  --server "<dan-peer-url>" \
  --host-id "<your-stable-host-id>" \
  --workspace-root "$PWD" \
  --identity-key-path ~/.master-mold/identity/<your-stable-host-id>-ed25519.pem
```

After Dan approves you in Agent Office:

```bash
npm run federation:sidecar -- --once
npm run federation:doctor -- --json
npm run federation:launchd:install
```

Federation details: [Federation Mesh](https://github.com/driverd12/MASTER-MOLD/blob/main/docs/FEDERATION_MESH.md).

## Rules of the Road

- Host identity is `host_id` plus hostname/device evidence plus signed Ed25519 identity.
- IP address is only a current locator.
- The sidecar shares bounded signed context summaries, not raw transcripts or screenshots.
