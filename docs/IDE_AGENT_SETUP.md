# IDE and Agent Setup

This guide shows how to connect MCP-compatible IDEs/agents to the local runtime.

## Prerequisites

- Node.js 20+ installed.
- Repository built (`npm ci && npm run build`).
- Optional `.env` configured from `.env.example`.

## Connection Modes

### STDIO (single-client, simplest)

Use when one IDE/agent process launches the server.

Command:

```bash
node /absolute/path/to/repo/dist/server.js
```

Pure core without workflow hooks:

```bash
MCP_DOMAIN_PACKS=none node /absolute/path/to/repo/dist/server.js
```

### HTTP (multi-client, shared local server)

Use when multiple clients should share one runtime and one SQLite state.

Start server:

```bash
MCP_HTTP=1 MCP_HTTP_BEARER_TOKEN=<token> node /absolute/path/to/repo/dist/server.js --http --http-port 8787
```

Client endpoint:

- URL: `http://127.0.0.1:8787/`
- Authorization: `Bearer <token>`

## Generic MCP JSON Template (STDIO)

Many clients accept a config object like this:

```json
{
  "mcpServers": {
    "mcplayground-core-template": {
      "command": "node",
      "args": ["/absolute/path/to/repo/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/repo/data/hub.sqlite"
      }
    }
  }
}
```

Disable workflow hooks explicitly:

```json
{
  "mcpServers": {
    "mcplayground-core-only": {
      "command": "node",
      "args": ["/absolute/path/to/repo/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/repo/data/hub.sqlite",
        "MCP_DOMAIN_PACKS": "none"
      }
    }
  }
}
```

## Generic MCP JSON Template (HTTP)

```json
{
  "mcpServers": {
    "mcplayground-http": {
      "url": "http://127.0.0.1:8787/",
      "headers": {
        "Authorization": "Bearer <token>",
        "Origin": "http://127.0.0.1"
      }
    }
  }
}
```

## Cursor/IDE Client Notes

For IDE clients that expose MCP settings UI:

1. Add a new MCP server.
2. Choose STDIO or HTTP.
3. Paste the command/URL templates above.
4. Verify by listing tools and confirming `health.tools` appears.
5. Verify `pack.hooks.list` returns the default `agentic.*` planner and verifier hooks.

## Claude Desktop-Style Config Notes

If your client uses a `mcpServers` config file, adapt the STDIO template exactly and point to `dist/server.js`.

## Agent Prompting Baseline

Use this starter instruction set for local agents:

1. Read context first via `knowledge.query` / `retrieval.hybrid`.
2. For mutating operations, always include idempotency metadata.
3. Open a run ledger for significant workflows.
4. Use `lock.acquire` for shared mutable entities.
5. Persist summaries and decisions (`memory.append`, `decision.link`, `adr.create`).
6. Run `preflight.check` and `postflight.verify` around risky changes.

## Setup Validation Checklist

Run these checks from your client:

1. `health.tools`
2. `health.storage`
3. `memory.append`
4. `memory.search`
5. `pack.hooks.list`

## Provider Bridge Shortcut

To export or install client-facing MCP config bundles from the server itself, use:

```bash
npm run providers:status
npm run providers:export
```

Truth boundary:

- Cursor, Codex, Claude CLI, Gemini CLI, and GitHub Copilot CLI can be configured as MCP clients here.
- Claude CLI installs through the native `claude mcp` flow and now uses the resilient stdio proxy entry on this host, with truthful configured-vs-authenticated/runtime-ready reporting.
- ChatGPT/OpenAI custom MCP is documented as a remote-only path, not a fake local install.

## Common Troubleshooting

- `Unknown tool`:
  - Confirm `MCP_DOMAIN_PACKS` is not set to `none` unless you want the pure core runtime, then reconnect client.
- HTTP 401:
  - Validate bearer token matches server env.
- DB lock/busy errors:
  - Use one shared DB path and avoid direct SQLite writes from clients.
- Tool registration drift:
  - Restart server after updating `.env` or pack list.
