# Ring Leader MCP Ops

Use the MCP surface first. Shell helpers are convenience wrappers around the same tools.

## Core Loops

- Observe kernel health with `kernel.summary`.
- Inspect live orchestration with `trichat.autopilot` action `status`.
- Inspect the active council and specialist catalog with `trichat.roster`.
- Inspect adapter readiness with `trichat.adapter_protocol_check`.
- Inspect adapter circuit state with `trichat.adapter_telemetry`.
- Inspect live session presence with `agent.session_list`.
- Inspect queue pressure with `task.summary` and `task.list`.
- Inspect turn state with `trichat.workboard`, `trichat.turn_get`, and `trichat.timeline`.

## Ring Leader Controls

- Start the daemon with `trichat.autopilot` action `start`.
- Stop the daemon with `trichat.autopilot` action `stop`.
- Run one bounded tick with `trichat.autopilot` action `run_once`.
- Read the effective lead/specialist pool from `trichat.autopilot` status fields:
  `effective_agent_pool.lead_agent_id`, `effective_agent_pool.specialist_agent_ids`, and `effective_agent_pool.council_agent_ids`.
- Read the live session mirror from `trichat.autopilot` status field `session`.

## Session Model

- The ring leader now mirrors itself into the durable agent-session layer while the daemon is running.
- The local hierarchy is now `ring-leader -> directors -> leaf SMEs`, with `implementation-director`, `research-director`, and `verification-director` supervising the narrower llama leaf agents by default.
- Pending work is claimed through `agent.claim_next` and completed or failed through `agent.report_result`, so the same ring-leader session now accrues adaptive routing history instead of staying permanently “unproven.”
- The mirrored session advertises `planning: true` and `capability_tier: high`, which lets it accept the high-complexity orchestration tasks it creates for itself.
- Read-only council plans now take a softened quorum penalty instead of a hard confidence cap, so a strong single local responder can still advance safe bounded work while riskier actions continue to need broader council support.
- Local specialist lanes now share the proven Ollama bridge by default, with per-agent command overrides and model overrides available through `TRICHAT_RING_LEADER_CMD`, `TRICHAT_CODE_SMITH_CMD`, `TRICHAT_RESEARCH_SCOUT_CMD`, `TRICHAT_QUALITY_GUARD_CMD`, and the matching `*_MODEL` variables.
- Kernel views should show an active session instead of reporting “no active agent sessions” during normal ring-leader operation.
- The session closes when the daemon is stopped or paused by the emergency brake.

## Runtime Scope

- DB-backed tools such as `kernel.summary`, `agent.session_list`, `task.summary`, `task.list`, `run.timeline`, and `incident.timeline` are safe to read through either stdio or the long-running daemon because they converge on the same storage.
- `trichat.autopilot` runtime flags like `running`, `in_tick`, and the live timer state are process-local.
- For the actual launchd-managed ring leader, prefer `npm run ring-leader:status` or an HTTP `trichat.autopilot` call against the live MCP daemon.
- Use the Codex stdio MCP server for orchestration data and durable state inspection; use the live daemon endpoint when you need the real in-memory autopilot runtime.

## Recommended MCP Checks

- `kernel.summary`
  Use first when deciding whether the system is healthy, degraded, blocked, or idle.
- `trichat.autopilot`
  Use for daemon lifecycle, pause reason, effective routing, and last tick evidence.
- `agent.session_list`
  Use to confirm the ring leader is registered and leased.
- `trichat.adapter_protocol_check`
  Use to verify that the specialist wrappers resolve and respond before blaming the council scorer.
- `trichat.adapter_telemetry`
  Use to see whether a lane is healthy, degraded, or still missing a resolved command.
- `task.summary`
  Use to see whether work is piling up faster than the ring leader is processing it.
- `trichat.workboard`
  Use to review turn-by-turn execution and current phase.
- `run.timeline`
  Use when a tick failed and you need the exact step path.
- `incident.timeline`
  Use after a pause or emergency brake to inspect the failure record.

## Local Wrappers

- `npm run ring-leader:start`
- `npm run ring-leader:status`
- `npm run ring-leader:run`
- `npm run ring-leader:stop`
- `npm run trichat:doctor`

These wrappers ultimately route back into the MCP server, so prefer them only for convenience when you are already on the local shell.
