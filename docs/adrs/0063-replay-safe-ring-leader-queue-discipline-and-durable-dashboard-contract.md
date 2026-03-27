# 0063-replay-safe-ring-leader-queue-discipline-and-durable-dashboard-contract: Replay-safe ring leader queue discipline and durable dashboard contract

- Status: accepted
- Date: 2026-03-27T07:39:34.824Z

## Content
# Replay-safe ring leader queue discipline and durable dashboard contract

## Context
The ring leader could refresh stale source-task claims without idempotency mismatches, but it still risked re-claiming its own leftover specialist fallback tasks ahead of fresh operator/source intake. The office dashboard also lost too much context after daemon restarts because it relied too heavily on ephemeral runtime state.

## Decision
1. Refresh stale replayed agent.claim_next results before deriving the run session key.
2. Bias the autopilot worker queue toward fresh external/source intake and deprioritize autopilot specialist fallback backlog unless no better intake is available.
3. Persist the ring leader's durable work contract into agent-session metadata: source objective, selected strategy, delegate target, delegation brief, and execution backlog.
4. Extend the Agent Office dashboard to read agent.session_list plus running/pending task lists so the briefing view can reconstruct the current contract even after restart.

## Consequences
- Manual run_once and restart-adjacent nudges are safer and no longer drift back onto stale source-task claims.
- Fresh operator work is easier to service promptly instead of getting buried behind old fallback backlog.
- The dashboard remains operator-honest after restarts because it can rebuild the ring leader brief from durable MCP state rather than ephemeral memory.
- Future ring-leader and dashboard work should preserve this queue discipline and durable contract surface.
