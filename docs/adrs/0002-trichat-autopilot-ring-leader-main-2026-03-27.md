# 0002-trichat-autopilot-ring-leader-main-2026-03-27: TriChat Autopilot ring-leader-main 2026-03-27

- Status: accepted
- Date: 2026-03-27T02:10:52.936Z

## Content
Objective source: heartbeat
Objective: Inspect kernel state, choose one high-leverage bounded next action, and delegate specialist work with explicit success criteria and rollback awareness.
Thread: ring-leader-main
Turn: 86a4d88a-5898-43a1-82f9-396d81d7e21d
Away mode: normal
Selected agent: codex
Selected strategy: Kernel leverage is highest on the in-flight ring-leader autopilot/session-routing changes in `src/tools/trichat.ts` and related persistence/tests. Freeze scope with workspace+diff inspection, run a no-emit typecheck on the new `lead_agent_id`/`specialist_ag...
Execution mode: tmux_dispatch
Execution commands: git status --short --branch || git diff --stat || npm run build -- --noEmit
Verification: skipped (execution deferred to task queue)
Rollback: revert workspace changes and replay task queue from /Users/dan.driver/Documents/Playground/Agentic Playground/SUPERPOWERS
