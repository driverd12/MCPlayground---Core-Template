# 0072-tmux-queue-truthfulness-adaptive-health-rehab-and-readme-wireframes: Tmux Queue Truthfulness, Adaptive Health Rehab, and README Wireframes

- Status: accepted
- Date: 2026-03-27T08:05:12.362Z

## Content
# Context
The overnight hardening pass still had three operator-facing rough edges: stale tmux work made the office queue look busier than reality, adaptive health could overstate recent failure pressure, and live autopilot ticks could collide on idempotency keys inside the same heartbeat bucket. We also needed README mermaid wireframes for the full MCP capability map and the agent spawning topology before publishing upstream.

# Decision
1. Reconcile orphaned tmux tasks into explicit cancelled history when the tmux session is gone, and compact superseded read-only autopilot duplicates so the office queue reflects current work instead of historical residue.
2. Count recent adaptive failure pressure once per session instead of once per complexity lane when determining session health.
3. Treat stale failed task history as recovered when a healthy active session has already produced a sufficient completion streak after the failure timestamp.
4. Include the fingerprint seed in ring-leader autopilot idempotency keys so exact replays still dedupe but different work in the same heartbeat bucket no longer collides.
5. Document the MCP server surface and ring-leader spawning topology in README mermaid diagrams.

# Consequences
- The office dashboard and tmux controller status are materially closer to live truth.
- The ring leader’s adaptive health aligns with recent success instead of old recovered failures.
- The launchd daemon no longer trips the observed heartbeat-bucket idempotency mismatch for fresh work.
- The repo now contains an explicit architecture map that makes rapid replication on a stronger server easier.

# Verification
- `npm test` passed 58/58.
- The live launchd daemon was refreshed successfully.
- `npm run ring-leader:status` returned healthy live status after the idempotency fix.
- The office dashboard one-shot briefing reflected the tightened queue and current delegation brief.
