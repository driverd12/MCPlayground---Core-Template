# MCPlayground Gemini Instructions

SUPERPOWERS is a **local-first MCP server runtime** designed for high-confidence autonomous execution. Gemini is an **inbound MCP client** utilizing this control plane.

## Core Mandates

- **MCP First**: Always prefer existing MCP tools over ad hoc shell workflows.
- **One Ingress Lane**: Route all new operator/IDE objectives through `autonomy.ide_ingress`. Do not invent second ingress paths.
- **Evidence-Driven**: Do not treat vague plans or prompt echoes as success. Require explicit evidence for all completed work.
- **Anti-Recursive**: `autonomy.maintain` is for bounded upkeep only. It must **not** perform recursive self-improvement or auto-promote org programs.

## Build & Test

```bash
npm run build                  # TypeScript compile (tsc)
npm run start:http             # Start server on HTTP port 8787
npm run test                   # Full suite: build + Python bridges + Node integration tests
npm run providers:status       # Check provider bridge connectivity
npm run autonomy:status        # Check autonomy fabric status
npm run production:doctor      # Full production readiness check
```

## MCP Workflow

1.  **Orient**: Start with `operator.brief` for the current bounded objective.
2.  **Inspect**: Use `office.snapshot` or `kernel.summary` for live system state.
3.  **Council**: Prefer the local-first council before escalating to hosted providers:
    - `implementation-director`
    - `research-director`
    - `verification-director`
    - `local-imprint`
4.  **Execute**: Use GSD-style work packets via `task.compile` or `autonomy.command`.

## Execution Rules (Non-Negotiables)

- **Work Packets**: Must have one owner, bounded objective, explicit success criteria, explicit evidence requirements, explicit rollback notes, and an explicit stop condition.
- **Confidence**: Lower confidence when evidence is thin or the plan is underspecified.
- **Continuity**: Preserve continuity in MCP artifacts, memory, and local repo guidance as goals evolve.
- **Safety**: If credentials, external auth, or human approval is required, record the blocker and stop.

## Agent Prompting Baseline

1.  **Context**: Read context first via `knowledge.query` or `retrieval.hybrid`.
2.  **Idempotency**: Always include idempotency metadata for mutating actions.
3.  **Ledger**: Open a run ledger (`run.begin`) for significant workflows.
4.  **Locking**: Use `lock.acquire` for shared mutable entities.
5.  **Persistence**: Record summaries and decisions with `memory.append`, `decision.link`, and `adr.create`.
6.  **Verification**: Use `preflight.check` and `postflight.verify` around risky changes.

## Architecture Map

```
src/server.ts           → MCP kernel entry point, tool registry
src/tools/              → All MCP tool implementations
src/domain-packs/       → Optional domain-specific tool packs (e.g., agentic)
src/transports/         → HTTP / stdio transport layer
src/control_plane*.ts   → Goal/plan/task execution control plane
src/trichat_roster.ts   → Agent roster and office orchestration
bridges/                → IDE and CLI bridge adapters (Python + Node)
data/hub.sqlite         → Primary durable state store (SQLite)
```

## Key Conventions

- **Transport**: Default HTTP on `8787` with bearer token auth.
- **State**: All durable state lives in SQLite (`data/hub.sqlite`). Do not bypass MCP tools to write directly to it.
- **Learning**: `agent.learning_summary` and `kernel.summary.learning` are the canonical surfaces for bounded per-agent lessons.
- **Truth Boundary**: Cursor, Codex, Claude CLI, Gemini CLI, and GitHub Copilot CLI are valid MCP clients. ChatGPT/OpenAI custom MCP is remote-only.
- **Operator Surface**: Prefer the visible office launchers (`npm run trichat:office:web`, `npm run agentic:suite`) when humans need reassurance about live agent activity.

## Setup Validation Checklist

Run these tools to verify environment readiness:
1. `health.tools`
2. `health.storage`
3. `migration.status`
4. `pack.hooks.list`
5. `trichat.summary`

## Breadcrumbs

- See `AGENTS.md` for the full mission and agent roster strategy.
- See `README.md` for high-level project overview.
- See `docs/COWORKER_QUICKSTART_CURSOR_CODEX.md` for environment setup.
