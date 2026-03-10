# MCPlayground Core Template

MCPlayground Core Template is a local-first MCP server runtime designed to be reused across domains.

The repository is intentionally split into two layers:

1. Core runtime: durable memory, transcripts, tasks, run ledgers, governance, ADRs, and safety checks.
2. Domain packs: optional modules that register domain-specific MCP tools without modifying core infrastructure.

This repository ships with one reference pack:

- `cfd` Computational Fluid Dynamics lifecycle tooling.

The runtime also includes first-class TriChat orchestration tools (`trichat.*`) for multi-agent turns, autonomous loops, and tmux-backed nested execution control.

## Why This Template Exists

Most MCP projects repeat the same infrastructure work:

- durability and state continuity
- safe/idempotent writes
- local governance and auditability
- task orchestration
- cross-client interoperability

This template centralizes those concerns so teams can build domain tools directly.

## Client-Ready Architecture Pitch

Use this framing with stakeholders:

- This is not a single-purpose assistant.
- This is a local MCP platform with reusable reliability primitives.
- Domain value is delivered through packs, not by rewriting runtime infrastructure.

```mermaid
flowchart LR
  A["IDE / Agent Client A"] --> D["Local MCP Runtime"]
  B["IDE / Agent Client B"] --> D
  C["Automation Worker"] --> D

  D --> E["Core: memory, transcript, tasks, runs, governance"]
  D --> F["Domain Pack API"]
  F --> G["CFD Pack (example)"]

  E --> H[("SQLite: ./data/hub.sqlite")]
  G --> I["Domain artifacts + reports"]
```

More detail: [Architecture Pitch](./docs/ARCHITECTURE_PITCH.md)

## Quick Start

```bash
npm ci
npm run build
npm run start:stdio
```

## Get or Update This Repo

Fresh clone:

```bash
git clone https://github.com/driverd12/MCPlayground---Core-Template.git
cd MCPlayground---Core-Template
npm ci
npm run build
```

If you already have a local checkout:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
npm ci
npm run build
```

Start HTTP transport:

```bash
npm run start:http
```

Start with CFD pack enabled:

```bash
npm run start:cfd
# or
npm run start:cfd:http
```

## Configuration

Copy the template:

```bash
cp .env.example .env
```

Key variables:

- `ANAMNESIS_HUB_DB_PATH` local SQLite path
- `ANAMNESIS_HUB_RUN_QUICK_CHECK_ON_START` run SQLite quick integrity check at startup (`1` by default)
- `ANAMNESIS_HUB_STARTUP_BACKUP` create rotating startup snapshots (`1` by default)
- `ANAMNESIS_HUB_BACKUP_DIR` snapshot directory (default: sibling `backups/` near DB path)
- `ANAMNESIS_HUB_BACKUP_KEEP` retained snapshot count (default: `24`)
- `ANAMNESIS_HUB_AUTO_RESTORE_FROM_BACKUP` auto-restore latest snapshot on startup corruption (`1` by default)
- `ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION` allow empty DB bootstrap if no backup exists (`0` by default)
- `MCP_HTTP_BEARER_TOKEN` auth token for HTTP transport
- `MCP_HTTP_ALLOWED_ORIGINS` comma-separated local origins
- `MCP_DOMAIN_PACKS` comma-separated pack ids (`cfd`, etc.)

The runtime now quarantines non-SQLite/corrupted artifacts into `corrupt/` before recovery attempts so startup failures do not silently overwrite evidence.

## Core Tool Surface

Core runtime tools include:

- Memory and continuity: `memory.*`, `transcript.*`, `who_knows`, `knowledge.query`, `retrieval.hybrid`
- Governance and safety: `policy.evaluate`, `preflight.check`, `postflight.verify`, `mutation.check`
- Durable execution: `run.*`, `task.*`, `lock.*`
- Decision and incident logging: `adr.create`, `decision.link`, `incident.*`
- Runtime ops: `health.*`, `migration.status`, `imprint.*`, `imprint.inbox.*`
- TriChat orchestration: `trichat.*` (`thread/message/turn`, `autopilot`, `tmux_controller`, `bus`, `adapter_telemetry`, `chaos`, `slo`)

## Domain Pack Framework

Domain packs are loaded at startup from `MCP_DOMAIN_PACKS` or `--domain-packs`.

- Framework: `src/domain-packs/types.ts`, `src/domain-packs/index.ts`
- Reference pack: `src/domain-packs/cfd.ts`

Pack authoring guide: [Domain Packs](./docs/DOMAIN_PACKS.md)

## IDE and Agent Setup

Connection examples and client setup:

- [IDE + Agent Setup Guide](./docs/IDE_AGENT_SETUP.md)
- [Transport Connection Guide](./docs/CONNECT.md)

Fast STDIO connection example:

```json
{
  "mcpServers": {
    "mcplayground-core-template": {
      "command": "node",
      "args": ["/absolute/path/to/MCPlayground---Core-Template/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/MCPlayground---Core-Template/data/hub.sqlite"
      }
    }
  }
}
```

Fast CFD-enabled connection example:

```json
{
  "mcpServers": {
    "mcplayground-cfd": {
      "command": "node",
      "args": ["/absolute/path/to/MCPlayground---Core-Template/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/MCPlayground---Core-Template/data/hub.sqlite",
        "MCP_DOMAIN_PACKS": "cfd"
      }
    }
  }
}
```

## CFD Fork Path

How to publish a CFD-focused fork from this template:

- [CFD Fork Guide](./docs/CFD_FORK_GUIDE.md)

## Validation

```bash
npm test
npm run mvp:smoke
```

TriChat reliability checks:

```bash
npm run trichat:smoke
npm run trichat:dogfood
npm run trichat:soak:gate -- --hours 1 --interval-seconds 60
```

TriChat tmux controller dry-run example:

```bash
TRICHAT_TMUX_DRY_RUN=1 node scripts/mcp_tool_call.mjs \
  --tool trichat.tmux_controller \
  --args '{"action":"start","mutation":{"idempotency_key":"demo-start","side_effect_fingerprint":"demo-start"}}'
```

`trichat.tmux_controller` status/dispatch responses include a lightweight live dashboard payload for TUIs:

- `dashboard.worker_load` (queue/load per worker)
- `dashboard.worker_load[].lane_state` + `lane_signal` (idle/working/blocked/error lane detection from pane captures)
- `dashboard.queue_age_seconds` + `dashboard.queue_depth`
- `dashboard.failure_class` + `dashboard.failure_count`
- `action="maintain"` performs unattended upkeep: pane sync, optional queue-driven worker scale-up, and blocked-lane nudge attempts for continuous long-running sessions

Execution safety hardening:

- protected DB artifacts (`hub.sqlite`, `-wal`, `-shm`, `-journal`) are now blocked from autopilot command plans and tmux dispatch tasks
- direct autopilot shell execution also enforces this guardrail as a final pre-spawn check
- local write-producing MCP tools (`adr.create`, `imprint.inbox.enqueue`, `imprint.snapshot`) now enforce protected-path checks before writing

TriChat TUI interactive `/execute` can route via tmux allocator (`TRICHAT_EXECUTE_BACKEND=auto|tmux|direct`) using:

- `TRICHAT_TMUX_SESSION_NAME`
- `TRICHAT_TMUX_WORKER_COUNT`
- `TRICHAT_TMUX_MAX_QUEUE_PER_WORKER`
- `TRICHAT_TMUX_SYNC_AFTER_DISPATCH`
- `TRICHAT_TMUX_LOCK_LEASE_SECONDS`

Optional fanout auto-dispatch (no manual `/execute`) can be enabled with `TRICHAT_AUTO_EXECUTE_AFTER_DECISION=1`.
This path is tmux-dispatch-first for snappiness and will skip with a clear status if no runnable command plan is present.
Use `TRICHAT_AUTO_EXECUTE_CYCLES` and `TRICHAT_AUTO_EXECUTE_BREAKER_FAILURES` to run bounded review/fix/feature/verify cycles with breaker halts.

Autopilot can use tmux nested execution directly (`execute_backend=tmux|auto`) with dynamic worker budgeting from command complexity/priority:

```bash
TRICHAT_TMUX_DRY_RUN=1 node scripts/mcp_tool_call.mjs \
  --tool trichat.autopilot \
  --args '{
    "action":"run_once",
    "mutation":{"idempotency_key":"demo-autopilot","side_effect_fingerprint":"demo-autopilot"},
    "execute_backend":"tmux",
    "tmux_session_name":"trichat-autopilot-demo",
    "tmux_worker_count":4,
    "tmux_auto_scale_workers":true
  }'
```

## Repository Layout

- `src/server.ts` core MCP runtime and tool registration
- `src/tools/` core reusable tools
- `src/domain-packs/` optional domain modules
- `scripts/` operational scripts and smoke checks
- `docs/` architecture, setup, and fork guides
- `tests/` integration and persistence tests
- `data/` local runtime state and SQLite database
