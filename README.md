# Anamnesis
![Tri-Chat Icon](./tri-chat-icon.png)

Anamnesis is a local-first MCP runtime with durable memory, durable task orchestration, and a multi-agent terminal experience (`TriChat`) that lets you talk to `codex`, `cursor`, and `local-imprint` in one place.

## Three Cats, One Apartment
Anamnesis is built as a shared apartment for agents:

- Every agent shares one local identity and one durable context source.
- Raw chat and events land in working memory (`transcript_lines`, `trichat_messages`).
- Important context is squished into long-term memory (`memories`).
- Coordination is deterministic through SQLite, leases, timelines, and idempotent mutation journaling.

Local-first is non-negotiable: everything lives on your machine, centered on `./data/hub.sqlite`.

## What You Get
- Local SQLite persistence (`./data/hub.sqlite` by default)
- Versioned migrations (`schema_migrations` + `PRAGMA user_version`)
- Idempotent side effects (`idempotency_key` + `side_effect_fingerprint`)
- Durable transcript and memory loop (`transcript.log` -> `transcript.squish` -> `memory.search`)
- Auto-squish daemon (`transcript.auto_squish`) + retention (`transcript.retention`)
- Durable tri-agent message bus (`trichat.thread_*`, `trichat.message_post`, `trichat.timeline`)
- Unix-socket live event bus for near-real-time adapter signaling (`trichat.bus`, default socket `./data/trichat.bus.sock`)
- Automatic `consensus.alert` bus events when a thread flips into disagreement
- Task queue with leases and full event history (`task.*`, `task.timeline`, `task.summary`)
- Retry daemon with deterministic backoff (`task.auto_retry`)
- Adapter circuit breakers with persisted telemetry (`trichat.adapter_telemetry`)
- Adapter protocol diagnostics for wrapper compliance (`trichat.adapter_protocol_check`)
- Controlled chaos injection + invariant validation for turn auto-finalization (`trichat.chaos`)
- Consensus mode for cross-agent agreement/disagreement detection (`trichat.consensus`)
- Turn orchestration state machine (`trichat.turn_start`, `trichat.turn_advance`, `trichat.turn_artifact`, `trichat.turn_get`, `trichat.turn_orchestrate`)
- Workboard + novelty scoring for forced-delta retries (`trichat.workboard`, `trichat.novelty`) with dedupe guard on internal reliability heartbeats
- Stale-turn watchdog daemon for auto-escalation/fail with timeline evidence (`trichat.turn_watchdog`)
- Autopilot daemon with away-mode safety gates, single-flight leases, emergency brake incidents, and mentorship memory compaction (`trichat.autopilot`)
- Reliability SLO metrics persisted in SQLite (`trichat.slo`: adapter p95 latency, adapter error rate, turn failure rate)
- Imprint continuity (`imprint.profile_set`, `imprint.snapshot`, `imprint.bootstrap`)
- Inbox worker for autonomous execution (`imprint.inbox.*`, `agent_loop.py`)
- ADR support (`adr.create`) writing to `./docs/adrs/` and SQLite

## Quick Start
```bash
npm ci
npm run build
npm run start:stdio
```

In another terminal, launch the Bubble Tea interface:

```bash
npm run trichat:tui
```

HTTP mode is also supported:

```bash
npm run start:http
npm run trichat:tui:http
```

## First Launch Flow (No Slash Commands Required)
When TriChat starts, you get a launcher menu with:

1. `Start Tri-Chat`
2. `Open Reliability`
3. `Open Settings`
4. `Open Help`
5. `Quit`

Then chat naturally. One prompt fans out to all three agents by default. Slash commands stay optional for control cases.

Useful launcher controls:

- `Up/Down`: pick menu item
- `Enter`: launch selection
- `Esc`: skip launcher and jump to chat
- `q`: quit

If you want to disable the launcher:

```bash
npm run trichat:tui -- --no-launcher
```

## One-Click macOS App
Install a clickable app in `~/Applications/TriChat.app` with your icon:

```bash
npm run trichat:app:install -- --icon /absolute/path/to/tri-chat-icon.png
```

Notes:

- Default terminal mode is `alacritty`.
- The installer builds an `.icns` from your PNG and injects it into the app bundle.
- You can copy/move `TriChat.app` into `/Applications` if you want a system-wide launcher.

## TriChat Experience
TriChat TUI gives you:

- Live timeline pane (durable thread history)
- Input bar for natural chat + optional slash commands
- Reliability sidebar (task counts, daemons, lease owners, adapter trips)
- Workboard section (active turn phase/status and execution readiness)
- Decision section (selected strategy + novelty/retry signals)
- Persisted turn phases (`plan -> propose -> critique -> merge -> execute -> verify -> summarize`)
- Consensus status line with auto-flag on disagreement (latest tri-agent turn)
- Settings panel for fanout target, gate mode, failover timeouts, and circuit breaker tuning
- Settings toggle for consensus threshold (`min_agents=2` or `3`)
- Settings toggle for interoperability rounds (`0-3`) to run peer bounce refinement before merge/execute
- Settings toggle for Council Transcript Strip mode (`always|auto|off`) so power users can collapse council chatter
- Autonomous council convergence loop in normal chat flow: agents auto-ask targeted merge questions and keep iterating until novelty improves or the latency budget/max-round limit is reached
- Dedicated Council Transcript Strip in chat timeline: agent-to-agent exchanges are rendered separately from user-facing replies
- Runtime-sync context injection so codex/cursor/local-imprint share the same adaptive timeout and coordination posture each turn
- Help panel with command reference
- `Ctrl+A` hotkey in chat to run adapter protocol diagnostics instantly
- Optional `/adaptercheck` command in TUI mode for one-shot bridge protocol diagnostics rendered in-chat
- Optional `/interop` command in TUI mode to tune cross-agent bounce rounds live
- Optional `/consensus` command in CLI mode for explicit turn-by-turn agreement inspection
- Role-differentiated proposal lanes (`planner` / `implementer` / `reliability-critic`) so fanout responses are intentionally non-identical

Theme direction:

- Cotton-candy cyber palette (pink / blue / mint accents)
- Framed rounded panels for readability
- Fast keyboard-only navigation for live workflows

## Bridge Adapters (Cursor + Codex)
TriChat auto-detects bridge wrappers from `./bridges`:

- `bridges/codex_bridge.py`
- `bridges/cursor_bridge.py`
- `bridges/local-imprint_bridge.py` (deterministic math assist + Ollama fallback)

Bridge protocol is strict (`trichat-bridge-v1`) with request correlation IDs and ping/pong handshake checks before command fanout, so malformed adapter output fails fast and routes to model fallback without stalling turns.

Validate adapters and local auth state:

```bash
npm run trichat:bridges:doctor
```

Smoke-test deterministic imprint arithmetic (order-of-operations):

```bash
npm run imprint:math:smoke
```

If needed, authenticate once:

```bash
codex login
cursor-agent login
```

## Reliability Model
The runtime is built to degrade gracefully instead of stalling:

- Per-agent command/model circuit breakers
- Adaptive retry on transient adapter/model faults with compact retry payloads
- Short suppression windows for persistent failures (for example missing bridge binary or unavailable Ollama endpoint)
- Suppression windows persist in adapter state telemetry so restarts do not reset known-fault backoff
- Adaptive model/bridge timeout tuning from recent `trichat.slo` p95 + error-rate signals
- Recovery windows and auto-close behavior
- Durable breaker state + trip history in SQLite
- Auto-finalization on fanout/execute pipeline errors so turns cannot remain stuck in running state
- Automatic retry for failed tasks with backoff
- Lease-based task claiming with heartbeat support
- Message retention daemons to keep growth bounded

## Core Operational Commands
Health and checks:

```bash
npm test
npm run mvp:smoke
npm run trichat:smoke
npm run trichat:dogfood:smoke
```

Dogfood loop (uses real bridge adapters + turn orchestration):

```bash
npm run trichat:dogfood
```

Soak gate (release criteria: long-run fanout stability with leak/timeout/breaker assertions):

```bash
npm run trichat:soak:gate -- --hours 1 --interval-seconds 60
```

Fast local validation (non-release short run):

```bash
npm run trichat:soak:gate -- --hours 1 --max-cycles 2 --allow-short true
```

Agent lifecycle:

```bash
npm run agents:on
npm run agents:off
npm run agents:status
```

Launchd services:

```bash
npm run launchd:install
npm run launchd:install:reliability
npm run launchd:uninstall
```

`launchd:install:reliability` enables an internal archived-thread heartbeat loop (`trichat-reliability-internal` by default) so reliability telemetry stays out of normal active chat threads.

Reliability loop controls:

```bash
npm run trichat:reliability:run_once
npm run trichat:reliability:status
npm run trichat:reliability:start
npm run trichat:reliability:stop
```

Imprint continuity:

```bash
npm run imprint:bootstrap
python3 ./agent_loop.py --help
```

Inbox queue:

```bash
npm run inbox:enqueue -- --objective "Run tests and summarize failures"
npm run inbox:worker
```

## High-Value MCP Tools
Memory and transcripts:

- `memory.append`
- `memory.search`
- `memory.get`
- `transcript.log`
- `transcript.run_timeline`
- `transcript.squish`
- `transcript.auto_squish`
- `transcript.retention`

Knowledge and governance:

- `knowledge.promote` (`source_type`: `memory` or `transcript_line`)
- `adr.create`
- `migration.status`

TriChat bus and telemetry:

- `trichat.thread_open`
- `trichat.thread_list`
- `trichat.thread_get`
- `trichat.message_post`
- `trichat.bus` (`status|start|stop|publish|tail`)
- `trichat.timeline`
- `trichat.summary`
- `trichat.consensus`
- `trichat.turn_start`
- `trichat.turn_advance`
- `trichat.turn_artifact`
- `trichat.turn_get`
- `trichat.turn_orchestrate`
- `trichat.workboard`
- `trichat.novelty`
- `trichat.verify`
- `trichat.retention`
- `trichat.auto_retention`
- `trichat.autopilot`
- `trichat.adapter_telemetry`
- `trichat.adapter_protocol_check`
- `trichat.chaos`
- `trichat.turn_watchdog`
- `trichat.slo`

Tasks and execution:

- `task.create`
- `task.list`
- `task.claim`
- `task.heartbeat`
- `task.complete`
- `task.fail`
- `task.retry`
- `task.timeline`
- `task.summary`
- `task.auto_retry`

## Configuration
Copy env template:

```bash
cp .env.example .env
```

Key env vars:

- `ANAMNESIS_HUB_DB_PATH` (preferred, default `./data/hub.sqlite`)
- `MCP_HUB_DB_PATH` (legacy fallback)
- `MCP_HTTP_BEARER_TOKEN`
- `MCP_HTTP_ALLOWED_ORIGINS`
- `TRICHAT_MCP_TRANSPORT` (`stdio` or `http`)
- `TRICHAT_OLLAMA_MODEL`
- `TRICHAT_TUI_LAUNCHER` (`true`/`false`)
- `TRICHAT_EXECUTE_GATE_MODE` (`open`/`allowlist`/`approval`)
- `TRICHAT_INTEROP_ROUNDS` (`0-3`, default `1`)
- `TRICHAT_COUNCIL_STRIP_MODE` (`always`/`auto`/`off`, default `auto`)
- `TRICHAT_COUNCIL_MAX_ROUNDS` (max autonomous council rounds per turn, default `5`)
- `TRICHAT_COUNCIL_LATENCY_BUDGET_SECONDS` (convergence latency budget, default `45`)
- `TRICHAT_COUNCIL_MIN_NOVELTY_DELTA` (minimum novelty gain before early stop, default `0.05`)
- `TRICHAT_BUS_SOCKET_PATH` (Unix socket for live bus, default `./data/trichat.bus.sock`)
- `TRICHAT_BUS_AUTOSTART` (`true`/`false`, default `true`)
- `TRICHAT_ADAPTER_HANDSHAKE_TTL_SECONDS` (cache duration for successful adapter ping checks, default `120`)
- `TRICHAT_ADAPTER_RETRY_ATTEMPTS` (retry count for transient adapter/model faults, default `1`)
- `TRICHAT_ADAPTER_CIRCUIT_THRESHOLD` (consecutive failures before opening a channel circuit, default `2`)
- `TRICHAT_ADAPTER_CIRCUIT_RECOVERY_SECONDS` (circuit recovery window, default `45`)
- `TRICHAT_ADAPTIVE_TIMEOUTS` (`true`/`false`, auto-tune model/bridge/failover timeouts from `trichat.slo`, default `true`)
- `TRICHAT_ADAPTIVE_TIMEOUT_MIN_SAMPLES` (minimum SLO latency samples before tuning, default `12`)
- `TRICHAT_ADAPTIVE_TIMEOUT_MAX_STEP_SECONDS` (max per-turn timeout adjustment step, default `8`)
- `ANAMNESIS_TRICHAT_RELIABILITY_LOOP_ENABLED` (`true`/`false`, optional launchd reliability loop)
- `ANAMNESIS_TRICHAT_RELIABILITY_INTERVAL_SECONDS` (loop interval for launchd, default `300`)
- `ANAMNESIS_TRICHAT_RELIABILITY_THREAD_ID` (internal archived thread id, default `trichat-reliability-internal`)
- `ANAMNESIS_TRICHAT_RELIABILITY_DRY_RUN` (`true`/`false`, default `true`)
- `ANAMNESIS_TRICHAT_RELIABILITY_EXECUTE` (`true`/`false`, default `false`)
- `ANAMNESIS_TRICHAT_AUTOPILOT_MODE` (optional client-side default payload hint: `safe`/`normal`/`aggressive`)
- `ANAMNESIS_TRICHAT_AUTOPILOT_INTERVAL_SECONDS` (optional client-side default payload hint, default `300`)
- `ANAMNESIS_TRICHAT_AUTOPILOT_THREAD_ID` (optional client-side default payload hint, default `trichat-autopilot-internal`)
- `ANAMNESIS_TRICHAT_AUTOPILOT_THREAD_STATUS` (optional client-side default payload hint: `active`/`archived`)

## Suggested Daily Loop
1. Start server + TriChat.
2. Chat naturally; let prompts fan out to all agents.
3. Route concrete actions into durable tasks.
4. Watch reliability sidebar for leases, retries, and adapter events.
5. Periodically squish and retain old working memory.
6. Keep the optional reliability loop running on an internal archived thread for continuous telemetry.
7. Snapshot imprint context before handoff.

## Repo Layout
- `src/` TypeScript MCP server
- `cmd/trichat-tui/` Bubble Tea terminal UI
- `bridges/` Codex/Cursor/local adapter wrappers
- `scripts/` smoke checks, installers, launch helpers
- `docs/` architecture notes and ADRs
- `data/` local SQLite DB and runtime state
- `tests/` integration and invariants

## Transport Docs
- STDIO: `npm run start:stdio`
- HTTP: `npm run start:http`

More connection examples: `./docs/CONNECT.md`
