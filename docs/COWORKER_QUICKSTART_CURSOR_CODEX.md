# Coworker Quickstart (Cursor + Codex)

This guide is a practical onboarding checklist for engineers using Cursor and Codex with MCPlayground.

## 1) Prerequisites

- Node.js 22.x
- npm
- Git
- Cursor
- Codex CLI/app

## 2) Clone and Build

```bash
git clone https://github.com/driverd12/MCPlayground---Core-Template.git
cd MCPlayground---Core-Template
npm ci
npm run build
```

Optional CFD branch setup:

```bash
git fetch origin
git checkout codex/cfd-analysis-fork
npm ci
npm run build
```

## 3) Resolve Local Paths

Use absolute paths for all MCP config values.

Example placeholders:

- `CORE_SERVER_JS=/absolute/path/to/MCPlayground---Core-Template/dist/server.js`
- `CORE_DB=/absolute/path/to/MCPlayground---Core-Template/data/hub.sqlite`
- `CFD_SERVER_JS=/absolute/path/to/MCPlayground---Core-Template/dist/server.js`
- `CFD_DB=/absolute/path/to/MCPlayground---Core-Template/data/hub-cfd.sqlite`
- `NODE_BIN=$(which node)`

## 4) Cursor Setup

In Cursor MCP settings, add two STDIO servers.

Server 1: `mcplayground-core-template`

- `command`: `<NODE_BIN>`
- `args`: `[<CORE_SERVER_JS>]`
- `env`:
  - `ANAMNESIS_HUB_DB_PATH=<CORE_DB>`

Server 2: `mcplayground-cfd`

- `command`: `<NODE_BIN>`
- `args`: `[<CFD_SERVER_JS>]`
- `env`:
  - `ANAMNESIS_HUB_DB_PATH=<CFD_DB>`
  - `MCP_DOMAIN_PACKS=cfd`

If your Cursor build uses file-based MCP config, edit:

- `~/.cursor/mcp.json`

## 5) Codex Setup

Add the same two servers via CLI:

```bash
codex mcp add mcplayground-core-template \
  --env ANAMNESIS_HUB_DB_PATH=<CORE_DB> \
  -- <NODE_BIN> <CORE_SERVER_JS>

codex mcp add mcplayground-cfd \
  --env ANAMNESIS_HUB_DB_PATH=<CFD_DB> \
  --env MCP_DOMAIN_PACKS=cfd \
  -- <NODE_BIN> <CFD_SERVER_JS>

codex mcp list
```

Codex persists these entries in:

- `~/.codex/config.toml`

## 6) First Validation (in Client)

Run these tools:

1. `health.tools`
2. `health.storage`
3. `migration.status`
4. `trichat.summary`
5. `trichat.autopilot` with `{"action":"status"}`
6. `trichat.tmux_controller` with `{"action":"status"}`
7. `cfd.schema.status` (CFD server only)

## 7) First Runtime Smoke Checks

From the repo root:

```bash
npm test
npm run trichat:smoke
npm run trichat:dogfood -- --cycles 1 --execute false
```

## 8) Common Issues

`Unknown tool cfd.*`

- `MCP_DOMAIN_PACKS=cfd` is missing on that server.
- Restart and reconnect the MCP client.

GUI app cannot find `node`

- Use an absolute Node path for MCP `command` (`which node`).

SQLite lock/busy errors

- Keep one stable DB path per running server.
- Do not write to SQLite directly outside MCP tools.

HTTP 401 (HTTP transport only)

- Validate `MCP_HTTP_BEARER_TOKEN` matches server/client config.

## 9) Team Safety Baseline

Use these defaults in day-to-day workflows:

1. Include idempotency metadata for mutating actions.
2. Use run ledger + lock tools for significant workflows.
3. Use `preflight.check` and `postflight.verify` around risky changes.
4. Record important decisions with `adr.create` and `decision.link`.
