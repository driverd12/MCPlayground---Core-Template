# MCPlayground Copilot Instructions

This repository uses the local MCP server as its control plane.

Required workflow:
- Read the current state through MCP first.
- Use `operator.brief` for the active bounded brief.
- Use `office.snapshot` or `kernel.summary` for live operational state.
- Send new operator objectives through `autonomy.ide_ingress`.

Execution expectations:
- Prefer bounded tasks with explicit success criteria.
- Include evidence requirements and rollback notes.
- Prefer local-first agents before remote escalation.
- Do not create a parallel orchestration path outside MCP.
- If credentials or human approval are required, stop and report the blocker.

Local-first agent order:
- `implementation-director`
- `research-director`
- `verification-director`
- `local-imprint`
