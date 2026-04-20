# Agent Office Mission

This repository is the foundation layer for Dan Driver's local-first agent office.

## Primary Goal

Build and harden a robust MCP server with real agentic tooling so a local ring leader can orchestrate as many subagents, directors, SMEs, and leaf agents as needed to complete bounded work safely and continuously.

---

## Build, Test & Health

```bash
npm ci && npm run build        # Install deps + TypeScript compile
npm run test                   # Full suite: build + Python bridges + Node integration tests
npm run test:python            # Python bridge tests only
node --test ./tests/<file>.mjs # Run a single Node integration test
npm run production:doctor      # Full production readiness check
npm run providers:status       # Check provider bridge connectivity
npm run providers:diagnose     # Diagnose provider bridge issues
npm run autonomy:status        # Check autonomy fabric status
npm run it:http:validate       # Validate HTTP transport end-to-end
npm run trichat:doctor         # TriChat runtime health check
```

## Starting the Server

```bash
npm run start:http             # HTTP mode, port 8787 (multi-client, preferred)
npm run start:core:http        # HTTP mode, no domain packs
npm run start:stdio            # STDIO mode (single client)
npm run launchd:install        # Install as macOS launchd keepalive daemon
```

---

## MCP Workflow (Core Rules)

This repository uses the local MCP server as its **primary control plane**. Always prefer MCP tools over ad hoc shell workflows when the tool already exists.

**Startup sequence:**
1. `operator.brief` — get the current bounded objective
2. `office.snapshot` or `kernel.summary` — inspect live system state
3. Route new work through `autonomy.ide_ingress` — this is the **one canonical IDE intake lane**

Do not invent a second ingress path for shell, office, or external clients.

**Durable collaboration boundary:**
- `autonomy.ide_ingress` is the durable source of truth for operator and IDE intake.
- On macOS, when `TRICHAT_VISIBLE_CLAUDE_MIRROR_ON_INGRESS=1`, explicit Claude-targeted ingress may mirror the already-persisted objective into the visible Claude terminal for operator-visible collaboration.
- That visible Claude terminal is a sidecar only. Durable state, continuity, and work evidence must still land in MCP artifacts, TriChat records, and SQLite-backed state.

**Health checks (call these before assuming something is broken):**
- `health.tools`, `health.storage`, `migration.status`
- `trichat.autopilot` `{"action":"status"}`, `trichat.tmux_controller` `{"action":"status"}`
- `pack.hooks.list`, `trichat.summary`

---

## Non-Negotiables

- Keep the ring leader local-first, delegation-heavy, and evidence-driven.
- Prefer director-to-leaf delegation chains before skipping straight to leaf SMEs.
- Use GSD-style work packets: one owner, bounded objective, explicit success criteria, explicit evidence requirements, explicit rollback notes, and an explicit stop condition.
- Do not treat vague plans, prompt echoes, or empty tool invocations as success. Lower confidence when evidence is thin or the plan is underspecified.
- Use the ring leader confidence checklist before high-confidence moves: owner clarity, actionability, evidence bar, rollback readiness, and non-echo novelty.
- Make agents smarter through bounded learning from real outcomes: capture durable per-agent lessons, reuse only the highest-signal task-relevant lessons, and never let learning turn into recursive self-improvement work.
- Preserve continuity in MCP artifacts, memory, and local repo guidance whenever strategy or long-term goals meaningfully evolve.
- Keep the office TUI cute, informative, and operationally honest: sprite states should reflect real MCP/tmux/telemetry signals, not fake activity.
- Treat `autonomy.ide_ingress` as the one canonical operator and IDE intake lane. Do not invent a second ingress path for shell, office, or external clients.
- Keep agent collaboration MCP-first: visible terminals, chat panes, and IDE bridges are collaboration surfaces, not alternate durable stores.
- For IDE-originated work, let the local-first council try first: `implementation-director`, `research-director`, `verification-director`, `local-imprint`, unless an explicit agent override is provided.
- Make the control plane self-maintaining in the background: launchd keepalive should drive real `autonomy.maintain` upkeep so readiness, autorun, learning visibility, and eval freshness continue without slash-command babysitting.
- Separate inbound client federation from outbound council capability. Cursor, Codex, and Gemini can be real council participants here; GitHub Copilot is an inbound MCP client today, not a fake outbound council bridge.
- Keep ChatGPT/OpenAI custom MCP claims truthful: remote-only until a real remote MCP surface exists. Never present it as a pure local install.
- **Truthfulness**: Office GUI sprite states must reflect real MCP/telemetry signals. Do not fabricate activity or mask blocked/offline states for active roster agents.
- If external auth or human approval is required, record the blocker and stop.

---

## Local-First Agent Council

Try in this order before escalating to remote/hosted providers:

1. `implementation-director`
2. `research-director`
3. `verification-director`
4. `local-imprint`

Local Ollama/MLX is the cheap first-pass lane. Escalate to hosted bridges only when an objective explicitly asks for them, an explicit bridge agent override is present, or the local lane cannot meet the evidence bar.

**Client role boundaries:**
- **Claude** is both an inbound MCP client and an outbound council **critic** (safety review, tradeoff analysis, counterarguments). Routed via `claude_bridge.py`.
- **Cursor, Codex, Gemini** can be real council participants and outbound contributors.
- **GitHub Copilot** is an **inbound MCP client only** — not an outbound council bridge.
- **ChatGPT/OpenAI custom MCP** is remote-only until a real remote MCP surface exists.

---

## Agent Prompting Baseline

All agents operating against this MCP server should follow this execution baseline:

1. **Context**: Read context first via `knowledge.query` or `retrieval.hybrid`
2. **Idempotency**: Always include idempotency metadata for mutating actions
3. **Ledger**: Open a run ledger (`run.begin`) for significant workflows
4. **Locking**: Use `lock.acquire` for shared mutable entities
5. **Persistence**: Record summaries and decisions with `memory.append`, `decision.link`, and `adr.create`
6. **Verification**: Use `preflight.check` and `postflight.verify` around risky changes

---

## Reliability Direction

- Favor substantive tool paths like `kernel.summary`, `trichat.workboard`, `trichat.tmux_controller`, `trichat.adapter_telemetry`, `task.summary`, and durable agent-session/task reporting.
- Treat `agent.learning_summary` and `kernel.summary.learning` as the canonical operator surfaces for bounded agent learning; learned behavior should be inspectable, attributable, and never hidden behind prompt magic.
- Keep `autonomy.maintain` bounded and anti-recursive: it may refresh readiness, autorun, tmux health, learning visibility, and eval state, but it must not open self-improvement goals, auto-promote org programs, or mutate repo code on its own.
- Keep the ring leader replay-safe across restarts and repeated manual nudges: stale claim replays must refresh cleanly, and fresh operator/source intake should outrank the ring leader's own leftover specialist fallback backlog.
- Persist the ring leader's current work contract into durable session metadata so the dashboard can recover the last source objective, selected strategy, delegate target, evidence bar, rollback notes, and execution backlog even after daemon restarts.
- Harden the ring leader against stale failures by tracking confidence, plan substance, recovery evidence, and bounded fallback chains.
- Default local specialists should be reliable additions to the team, not cosmetic personas.

## Cursor Cloud specific instructions

### Services

This is a Node.js + TypeScript MCP server with Python bridges. No Docker, no external databases — it uses embedded SQLite via `better-sqlite3`.

| Service | How to run | Notes |
|---|---|---|
| MCP Server (STDIO) | `npm run start:stdio` | Single-client mode for IDE integration |
| MCP Server (HTTP) | `npm run start:http` | Multi-client mode on port 8787, requires `MCP_HTTP_BEARER_TOKEN` |
| Python tests | `npm run test:python` | Runs bridge + test discovery under `bridges/` and `tests/` |

### Build and test

Standard commands per `package.json`:
- **Build**: `npm run build` (compiles TypeScript from `src/` to `dist/`)
- **Test**: `npm test` (builds first, then runs Python tests + Node.js test runner)
- **Smoke**: `npm run mvp:smoke` (quick STDIO-based smoke check)

### Environment

- Node.js 22 (`.nvmrc`), npm as package manager (`package-lock.json`)
- `.env` must exist (copy from `.env.example`); minimal values: `ANAMNESIS_HUB_DB_PATH=./data/hub.sqlite`, `MCP_HTTP_BEARER_TOKEN=change-me`, `MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1`
- The `data/` directory is auto-created by the server for SQLite state

### Known test failures in cloud VM

8 of 180 tests fail due to environment constraints (not code bugs):
- `desktop control` tests require macOS
- `runtime.worker` worktree isolation tests need specific git state
- `autonomy.maintain` and `office.snapshot` tests have timing/environment dependencies
- `benchmark.run` toolchain-inheritance tests assume macOS shell utilities

### MCP tool calls via HTTP

Use the included helper script for ad-hoc tool calls against a running HTTP server:
```
MCP_HTTP_BEARER_TOKEN=change-me node ./scripts/mcp_tool_call.mjs \
  --tool <tool_name> --args '<json>' \
  --transport http --url http://127.0.0.1:8787/ --origin http://127.0.0.1
```

### MCP client setup on macOS

The repo has a built-in `provider.bridge` tool that generates and installs configs for all supported MCP clients. This is the canonical way to set up the server for IDE/CLI use.

**One-command install for all local clients:**
```bash
npm run providers:install -- cursor claude-cli codex gemini-cli github-copilot-cli
```

**Or export config bundles for manual review first:**
```bash
npm run providers:export
```

Per-client details (see also `docs/IDE_AGENT_SETUP.md` and `docs/COWORKER_QUICKSTART_CURSOR_CODEX.md`):

| Client | Config path | Transport | Install method |
|---|---|---|---|
| Cursor | `~/.cursor/mcp.json` + `<repo>/.cursor/mcp.json` | HTTP (preferred) or STDIO | `npm run providers:install -- cursor` |
| Claude CLI | `~/.claude.json` (via `claude mcp add`) | STDIO proxy → HTTP fallback | `npm run providers:install -- claude-cli` |
| Codex | `~/.codex/config.toml` (via `codex mcp add`) | STDIO | `npm run providers:install -- codex` or `npm run codex:mcp:register` |
| Gemini CLI | `~/.gemini/settings.json` | STDIO proxy → HTTP fallback | `npm run providers:install -- gemini-cli` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | HTTP | `npm run providers:install -- github-copilot-cli` |
| VS Code Copilot | `<repo>/.vscode/mcp.json` | HTTP or STDIO | Export-only: `npm run providers:export` |
| ChatGPT | Remote MCP only | HTTP (remote) | Not a local install — see `chatgpt-developer-mode.md` in export bundle |

**For multi-client (HTTP) mode**, start the persistent HTTP daemon first:
```bash
npm run start:http
```
Cursor, Copilot CLI, and VS Code Copilot prefer this shared HTTP transport. Claude CLI and Gemini CLI use an auto-proxy that tries HTTP first and falls back to STDIO.

**For single-client (STDIO) mode**, the IDE launches the server process directly — no daemon needed.

**Workspace-local configs** (`.cursor/mcp.json`, `.vscode/mcp.json`) are gitignored. They are generated locally by the provider bridge install flow.

### Gotchas

- The `memory.append` tool requires a `mutation` object with `idempotency_key`, `side_effect_fingerprint`, and `confirm` fields — not just `content`.
- No ESLint or Prettier is configured; there is no separate lint command.
- Python 3 is needed for `npm run test:python` (bridge tests). No `requirements.txt` — the Python code uses only stdlib.
- ChatGPT/OpenAI custom MCP is truthfully remote-only — do not present it as a local install.
- When running `npm run providers:install`, the HTTP server must be running for HTTP-transport clients. STDIO clients work without the daemon.
- Use `provider.bridge` to inspect provider connectivity before assuming a provider is unavailable.

---

## Current UX Direction

- The primary local operator UI is the tmux-backed Agent Office dashboard.
- Launch path should be one-click from `/Applications` via the installed Agent Office app or the broader `Agentic Suite` reassurance launcher.
- Office sprites should communicate real states like desk work, briefing, chatting, break/reset, blocked, offline, and sleeping.
- The office UX should keep borrowing the best open-source wins from projects like Ralph TUI, GSD, autoresearch, and SuperClaude, while explicitly excluding unsafe jailbreak behavior.
- Presentation path should always be runnable from real commands: `npm run production:doctor`, `npm run providers:status`, `npm run providers:export`, `npm run autonomy:ide -- "<objective>"`, `npm run agentic:suite`, and `/Applications/Agent Office.app`.

---

## Architecture Map

```
src/server.ts              → MCP kernel entry point, tool registry
src/tools/                 → All MCP tool implementations
src/domain-packs/          → Optional domain-specific tool packs (agentic ships by default)
src/transports/            → HTTP / stdio transport layer
src/control_plane*.ts      → Goal/plan/task execution control plane
src/office_gui_snapshot.ts → Agent Office GUI state builder
src/storage.ts             → Durable SQLite state (hub.sqlite)
src/trichat_roster.ts      → Agent roster and office orchestration
bridges/                   → IDE and CLI bridge adapters (Python + Node)
scripts/                   → Launcher, validation, and operational helpers
web/office/ + ui/          → GUI and terminal operator surfaces (Agent Office)
config/trichat_agents.json → Agent roster definitions (14 agents)
data/hub.sqlite            → Primary durable state store — route all writes through MCP tools only
```

---

## Transport & Connection

| Mode | Command | Use When |
|------|---------|----------|
| HTTP | `npm run start:http` | Multiple clients sharing one runtime |
| HTTP (core only) | `npm run start:core:http` | No domain packs needed |
| STDIO | `npm run start:stdio` | Single IDE/agent client |
| launchd | `npm run launchd:install` | Persistent daemon on macOS |

- **HTTP endpoint**: `http://127.0.0.1:8787/`
- **Auth**: `Authorization: Bearer <token>` + `Origin: http://127.0.0.1`
- **SQLite path**: `./data/hub.sqlite` (env: `ANAMNESIS_HUB_DB_PATH`)
- **Disable domain packs**: set `MCP_DOMAIN_PACKS=none`

For multi-client sessions: use HTTP mode, share one SQLite DB path, route all writes through MCP tools only.

---

## Recent Hardening Highlights

- `provider.bridge` HTTP reads are cache-backed and reject `force_live` over HTTP instead of stalling the server thread.
- `office.snapshot` stays storage-backed for bridge diagnostics and degraded reads, so dashboard-style consumers avoid direct hot-path probing.
- Office GUI truthfulness is hardened: blocked, offline, and sleeping remain distinct from ready, and degraded direct fallback no longer renders an empty office.
- Cross-platform office and suite launchers are now surfaced through doctor, `kernel.summary`, and `office.snapshot` so readiness is visible before demos or operator handoff.

---

## Breadcrumbs

- See `GEMINI.md` for Gemini-specific agent instructions.
- See `CLAUDE.md` for Claude-specific agent instructions (includes critique workflow).
- See `.github/copilot-instructions.md` for GitHub Copilot agent instructions.
- See `docs/COWORKER_QUICKSTART_CURSOR_CODEX.md` for Cursor/Codex environment setup.
- See `docs/IDE_AGENT_SETUP.md` for comprehensive IDE and agent setup.
- See `config/trichat_agents.json` for the full 14-agent roster definition.
