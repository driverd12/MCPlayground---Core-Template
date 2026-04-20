# MASTER MOLD Copilot Instructions

MASTER MOLD is a **local-first MCP server runtime** — the foundation layer for Dan Driver's local agent office. It is split into two layers:

1. **Core runtime** — durable memory, transcripts, tasks, run ledgers, governance, ADRs, safety checks
2. **Domain packs** — optional modules registering domain-specific MCP tools (`src/domain-packs/`)

The `agentic` domain pack ships by default and provides GSD-style planner/verifier hooks.

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

`autonomy.ide_ingress`, MCP artifacts, and SQLite-backed state are the durable source of truth. Visible terminals or IDE chat panes are collaboration surfaces only.

**Health checks (call these before assuming something is broken):**
- `health.tools`, `health.storage`, `migration.status`
- `trichat.autopilot` `{"action":"status"}`, `trichat.tmux_controller` `{"action":"status"}`

---

## Local-First Agent Council

Try in this order before escalating to remote/hosted providers:

1. `implementation-director`
2. `research-director`
3. `verification-director`
4. `local-imprint`

Prefer **director-to-leaf delegation chains** before jumping straight to leaf SMEs.

Local Ollama/MLX is the first-pass lane. Escalate to hosted bridges only when an objective explicitly requests them, a bridge agent is explicitly targeted, or the local lane cannot meet the evidence bar.

---

## Non-Negotiables

- **Work packets** must have: one owner, bounded objective, explicit success criteria, explicit evidence requirements, explicit rollback notes, and an explicit stop condition (GSD-style).
- **Confidence checklist** before high-confidence moves: owner clarity, actionability, evidence bar, rollback readiness, non-echo novelty.
- Do not treat vague plans, prompt echoes, or empty tool invocations as success. Lower confidence when evidence is thin.
- `autonomy.maintain` is bounded upkeep **only** — it may refresh readiness, autorun, tmux health, learning visibility, and eval state. It must **not** open self-improvement goals, auto-promote org programs, or mutate repo code autonomously.
- If external auth or human approval is required, record the blocker and stop.
- Bounded agent learning only: capture durable per-agent lessons, reuse highest-signal task-relevant lessons, never let learning turn into recursive self-improvement.
- Preserve continuity in MCP artifacts, memory, and local repo guidance whenever strategy or long-term goals meaningfully evolve.

---

## Client Role Boundaries

- **GitHub Copilot** is an **inbound MCP client** — not an outbound council bridge. Do not model it as a fake council participant.
- **Cursor, Codex, Gemini** can be real council participants and outbound contributors.
- On macOS, explicit Claude-targeted ingress may mirror the already-persisted objective into the visible Claude terminal when `TRICHAT_VISIBLE_CLAUDE_MIRROR_ON_INGRESS=1`; that mirror is operator-visible only, not canonical state.
- **ChatGPT/OpenAI custom MCP** is remote-only until a real remote MCP surface exists. Never present it as a pure local install.
- Keep inbound client federation separate from outbound council capability.

---

## Reliability Rules

- Favor substantive tool paths: `kernel.summary`, `trichat.workboard`, `trichat.tmux_controller`, `trichat.adapter_telemetry`, `task.summary`, durable agent-session/task reporting.
- `agent.learning_summary` and `kernel.summary.learning` are the canonical surfaces for bounded agent learning — inspectable, attributable, never hidden behind prompt magic.
- Ring leader must be replay-safe across restarts: stale claim replays must refresh cleanly; fresh operator/source intake outranks leftover specialist fallback backlog.
- Persist the ring leader's work contract into durable session metadata so the dashboard can recover after daemon restarts.
- Use `provider.bridge` to inspect provider connectivity before assuming a provider is unavailable.

---

## Architecture Map

```
src/server.ts           → MCP kernel entry point, tool registry
src/tools/              → All MCP tool implementations
src/domain-packs/       → Optional domain-specific tool packs (agentic ships by default)
src/transports/         → HTTP / stdio transport layer
src/control_plane*.ts   → Goal/plan/task execution control plane
src/trichat_roster.ts   → Agent roster and office orchestration
bridges/                → IDE and CLI bridge adapters (Python + Node)
scripts/                → Launcher, validation, and operational helpers
web/office/ + ui/       → GUI and terminal operator surfaces (Agent Office)
data/hub.sqlite         → Primary durable state store — route all writes through MCP tools only
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

## UX Direction

- Primary local operator surfaces: **tmux-backed Agent Office dashboard** (`/Applications/Agent Office.app`) and the broader reassurance launcher (`/Applications/Agentic Suite.app` or `npm run agentic:suite`)
- Office sprites must reflect real MCP/tmux/telemetry signals — not fake activity
- Canonical presentation commands: `npm run production:doctor`, `npm run providers:status`, `npm run autonomy:ide -- "<objective>"`
