# Coworker Quickstart (Cursor + Codex)

This guide is a practical onboarding checklist for engineers using Cursor and Codex with MASTER MOLD.

## 1) Prerequisites

- Node.js 22.x
- npm
- Git
- Cursor
- Codex CLI/app

## 2) Clone and Bootstrap

```bash
git clone https://github.com/driverd12/MASTER-MOLD.git
cd master-mold
npm run bootstrap:env
```

If you already cloned the repo:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
npm run bootstrap:env
```

## 3) Resolve Local Paths

Use absolute paths for all MCP config values.

Example placeholders:

- `CORE_SERVER_JS=/absolute/path/to/master-mold/dist/server.js`
- `CORE_DB=/absolute/path/to/master-mold/data/hub.sqlite`
- `NODE_BIN` should be the absolute path to Node when your MCP client needs one. On macOS/Linux use `which node`; on Windows use `where node`, or use `node` when the client inherits your PATH reliably.

## 4) Cursor Setup

In Cursor MCP settings, add one shared STDIO server.

Server 1: `master-mold`

- `command`: `<NODE_BIN>`
- `args`: `[<CORE_SERVER_JS>]`
- `env`:
  - `ANAMNESIS_HUB_DB_PATH=<CORE_DB>`

If your Cursor build uses file-based MCP config, edit:

- `~/.cursor/mcp.json`

For the recommended local-first Cursor workflow, keep Cursor as an MCP client and control local Ollama/MLX selection through MASTER-MOLD itself. See [CURSOR_LOCAL_FIRST_MODE.md](/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD/docs/CURSOR_LOCAL_FIRST_MODE.md).

## 5) Codex Setup

Add the same shared server via CLI:

```bash
codex mcp add master-mold \
  --env ANAMNESIS_HUB_DB_PATH=<CORE_DB> \
  -- <NODE_BIN> <CORE_SERVER_JS>

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
7. `pack.hooks.list`

Also confirm the desktop bridge is discoverable on macOS:

1. `desktop.control` with `{"action":"heartbeat"}`
2. `desktop.observe` with `{"action":"frontmost_app"}`

If a Codex/Cursor shell channel is stale or pointed at a missing path, use the desktop-control fallback instead of getting stuck. See [Desktop Control Agent Protocol](./DESKTOP_CONTROL_AGENT_PROTOCOL.md).

## 7) First Runtime Smoke Checks

From the repo root:

```bash
npm test
npm run trichat:doctor
npm run trichat:smoke
npm run trichat:dogfood -- --cycles 1 --execute false
```

## 8) Common Issues

`pack.hooks.list` returns zero hooks unexpectedly

- `MCP_DOMAIN_PACKS=none` may be set on that server.
- Restart and reconnect the MCP client.

GUI app cannot find `node`

- Use an absolute Node path for MCP `command`: `which node` on macOS/Linux, `where node` on Windows.

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

## 10) Provider Bridge

When you want to prep multiple IDE or agent clients quickly from the runtime itself:

```bash
npm run providers:status
npm run providers:export
```

The canonical objective lane for IDE/operator commands is still `autonomy.ide_ingress`.
