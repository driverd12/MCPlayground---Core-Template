# 0054-0054-operator-visible-bounded-learning-surface: 0054-operator-visible-bounded-learning-surface

- Status: accepted
- Date: 2026-03-27T07:13:53.480Z

## Content
# 0054 Operator-Visible Bounded Learning Surface

## Context
The local agent office already captured bounded per-agent learning, but those lessons were still too hidden. Operators could not easily inspect who had learned what, the ring leader could not surface when a plan aligned with or violated prior lessons, and the office dashboard could lose context after a daemon restart.

## Decision
We added MCP-visible learning tools (`agent.learning_list`, `agent.learning_summary`), integrated compact learning coverage into `kernel.summary`, and taught the ring leader to apply bounded prefer/avoid lesson signals as a small confidence adjustment instead of hidden prompt magic. We also surfaced learning counts and the latest ring-leader learning signal in the office dashboard, with a fallback to durable session metadata when runtime `last_tick` is empty after restart.

## Consequences
Operators can now inspect bounded learning through standard MCP surfaces, the ring leader can explain when prior lessons are helping or constraining a plan, and the dashboard remains truthful across restarts. Learning remains bounded and auditable, and we avoid recursive self-improvement loops by reusing only task-relevant lessons and exposing the signal rather than silently amplifying it.
