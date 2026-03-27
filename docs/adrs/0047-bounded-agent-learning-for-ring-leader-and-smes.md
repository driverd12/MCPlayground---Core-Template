# 0047-bounded-agent-learning-for-ring-leader-and-smes: Bounded Agent Learning for Ring Leader and SMEs

- Status: accepted
- Date: 2026-03-27T06:45:42.220Z

## Content
# Context
The local ring-leader stack needs spawned agents that improve materially over time without drifting into recursive self-improvement loops.

# Decision
Introduce a durable per-agent learning ledger keyed by `agent_id`. Record lessons only from real autopilot outcomes, reuse only a compact task-relevant subset at prompt time, exclude same-run lessons from replay, and filter recursive self-improvement language before storage or prompt injection.

# Consequences
- Ring-leader, directors, SMEs, and leaf agents can accumulate execution guidance over time.
- Prompt-time memory remains bounded and grounded in external-task execution.
- Replay/idempotency remains stable because same-run lessons do not feed back into the same run.
- Unsafe self-optimization loops are suppressed instead of amplified.
