# Transport Connection Guide

## STDIO Transport

Start server:

```bash
npm run start:stdio
```

Start with CFD pack:

```bash
npm run start:cfd
```

Equivalent direct command:

```bash
node dist/server.js --domain-packs cfd
```

## HTTP Transport

Start core runtime over HTTP:

```bash
MCP_HTTP=1 MCP_HTTP_BEARER_TOKEN=change-me node dist/server.js --http --http-port 8787
```

Start HTTP with CFD pack:

```bash
MCP_HTTP=1 MCP_HTTP_BEARER_TOKEN=change-me MCP_DOMAIN_PACKS=cfd node dist/server.js --http --http-port 8787
```

## Health Checks

Use any MCP client and call:

- `health.tools`
- `health.storage`
- `migration.status`

If CFD pack is enabled:

- `cfd.schema.status`

TriChat runtime checks:

- `trichat.summary`
- `trichat.autopilot` with `{"action":"status"}`
- `trichat.tmux_controller` with `{"action":"status"}`

## CORS and Auth

- `MCP_HTTP_ALLOWED_ORIGINS` controls allowed origins.
- `MCP_HTTP_BEARER_TOKEN` secures the HTTP endpoint.

## Recommended Local Dev Defaults

- HTTP host: `127.0.0.1`
- HTTP port: `8787`
- SQLite path: `./data/hub.sqlite`

## Notes for Multi-Client Sessions

- Prefer HTTP mode for many clients.
- Keep one shared SQLite DB path.
- Route all writes through MCP tools only.

## TriChat Tmux Nested Controller

- `trichat.tmux_controller` supports `status|start|stop|dispatch|sync|maintain|tail`.
- Runtime state is persisted in `daemon_configs` (`trichat.tmux_controller`).
- Status and dispatch responses include `dashboard` telemetry (`worker_load`, `queue_age_seconds`, `queue_depth`, `failure_class`) for live TUI panels, including per-worker `lane_state` and `lane_signal`.
- `action=maintain` is designed for unattended runs: it syncs pane markers, can scale worker count up from queue pressure, and can nudge blocked prompt lanes.
- For environments without tmux installed, set `TRICHAT_TMUX_DRY_RUN=1` to exercise scheduling and replay behavior without spawning tmux sessions.
- `trichat.autopilot` can route execute-phase commands through tmux lanes using `execute_backend="tmux"` (or `execute_backend="auto"` for dynamic selection).
- TriChat TUI interactive `/execute` can reuse the same allocator path with `TRICHAT_EXECUTE_BACKEND=auto|tmux|direct` and tmux controls (`TRICHAT_TMUX_SESSION_NAME`, `TRICHAT_TMUX_WORKER_COUNT`, `TRICHAT_TMUX_MAX_QUEUE_PER_WORKER`, `TRICHAT_TMUX_SYNC_AFTER_DISPATCH`).
- TriChat TUI can auto-run post-decision execution in live fanout with `TRICHAT_AUTO_EXECUTE_AFTER_DECISION=1` (or `/autoexec on` in-session). Auto fanout execution uses tmux dispatch only and skips cleanly if no executable command plan is available.
- Bounded iterative auto-dispatch cycles are controlled by `TRICHAT_AUTO_EXECUTE_CYCLES` and `TRICHAT_AUTO_EXECUTE_BREAKER_FAILURES` (also configurable via `/autoexec cycles <n>` and `/autoexec breaker <n>`).
