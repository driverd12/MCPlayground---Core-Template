# Agent Office Mission

This repository is the foundation layer for Dan Driver's local-first agent office.

## Primary Goal

Build and harden a robust MCP server with real agentic tooling so a local ring leader can orchestrate as many subagents, directors, SMEs, and leaf agents as needed to complete bounded work safely and continuously.

## Non-Negotiables

- Keep the ring leader local-first, delegation-heavy, and evidence-driven.
- Prefer director-to-leaf delegation chains before skipping straight to leaf SMEs.
- Use GSD-style work packets: one owner, bounded objective, explicit success criteria, explicit evidence requirements, explicit rollback notes, and an explicit stop condition.
- Do not treat vague plans, prompt echoes, or empty tool invocations as success. Lower confidence when evidence is thin or the plan is underspecified.
- Use the ring leader confidence checklist before high-confidence moves: owner clarity, actionability, evidence bar, rollback readiness, and non-echo novelty.
- Make agents smarter through bounded learning from real outcomes: capture durable per-agent lessons, reuse only the highest-signal task-relevant lessons, and never let learning turn into recursive self-improvement work.
- Preserve continuity in MCP artifacts, memory, and local repo guidance whenever strategy or long-term goals meaningfully evolve.
- Keep the office TUI cute, informative, and operationally honest: sprite states should reflect real MCP/tmux/telemetry signals, not fake activity.
- Treat `autonomy.ide_ingress` as the one canonical operator and IDE intake lane. Do not invent a second ingress path for shell, office, or external clients.
- For IDE-originated work, let the local-first council try first: `implementation-director`, `research-director`, `verification-director`, `local-imprint`, unless an explicit agent override is provided.
- Make the control plane self-maintaining in the background: launchd keepalive should drive real `autonomy.maintain` upkeep so readiness, autorun, learning visibility, and eval freshness continue without slash-command babysitting.
- Separate inbound client federation from outbound council capability. Cursor, Codex, and Gemini can be real council participants here; GitHub Copilot is an inbound MCP client today, not a fake outbound council bridge.
- Keep ChatGPT/OpenAI custom MCP claims truthful: remote-only until a real remote MCP surface exists. Never present it as a pure local install.

## Current UX Direction

- The primary local operator UI is the tmux-backed Agent Office dashboard.
- Launch path should be one-click from `/Applications` via the installed Agent Office app.
- Office sprites should communicate real states like desk work, briefing, chatting, break/reset, blocked, offline, and sleeping.
- The office UX should keep borrowing the best open-source wins from projects like Ralph TUI, GSD, autoresearch, and SuperClaude, while explicitly excluding unsafe jailbreak behavior.
- Presentation path should always be runnable from real commands: `npm run production:doctor`, `npm run providers:status`, `npm run providers:export`, `npm run autonomy:ide -- \"<objective>\"`, and `/Applications/Agent Office.app`.

## Reliability Direction

- Favor substantive tool paths like `kernel.summary`, `trichat.workboard`, `trichat.tmux_controller`, `trichat.adapter_telemetry`, `task.summary`, and durable agent-session/task reporting.
- Treat `agent.learning_summary` and `kernel.summary.learning` as the canonical operator surfaces for bounded agent learning; learned behavior should be inspectable, attributable, and never hidden behind prompt magic.
- Keep `autonomy.maintain` bounded and anti-recursive: it may refresh readiness, autorun, tmux health, learning visibility, and eval state, but it must not open self-improvement goals, auto-promote org programs, or mutate repo code on its own.
- Keep the ring leader replay-safe across restarts and repeated manual nudges: stale claim replays must refresh cleanly, and fresh operator/source intake should outrank the ring leader's own leftover specialist fallback backlog.
- Persist the ring leader's current work contract into durable session metadata so the dashboard can recover the last source objective, selected strategy, delegate target, evidence bar, rollback notes, and execution backlog even after daemon restarts.
- Harden the ring leader against stale failures by tracking confidence, plan substance, recovery evidence, and bounded fallback chains.
- Default local specialists should be reliable additions to the team, not cosmetic personas.
