# Documentation Index

This is the centralized human-facing docs hub for MCPlayground Core Template.

## Start Here

- [Quick Setup](./SETUP.md)
- [System Interconnects](./SYSTEM_INTERCONNECTS.md)
- [IDE + Agent Setup Guide](./IDE_AGENT_SETUP.md)
- [Transport Connection Guide](./CONNECT.md)
  Quick setup now starts with `npm run bootstrap:env:install`, which can install the pinned Node/npm/Python prerequisites for supported hosts before install/build.

## Architecture and Diagrams

- [System Interconnects](./SYSTEM_INTERCONNECTS.md)
- [Architecture Pitch](./ARCHITECTURE_PITCH.md)
- [Provider Bridge Matrix](./PROVIDER_BRIDGE_MATRIX.md)
- [Ring Leader MCP Ops](./RING_LEADER_MCP_OPS.md)

## Operations and Runbooks

- [Presentation Runbook](./PRESENTATION_RUNBOOK.md)
- [Security](./SECURITY.md)
- [Coworker Quickstart (Cursor + Codex)](./COWORKER_QUICKSTART_CURSOR_CODEX.md)
- [IDE + Agent Setup Guide](./IDE_AGENT_SETUP.md)
- [Transport Connection Guide](./CONNECT.md)
- [TriChat Compatibility Reference](./TRICHAT_COMPATIBILITY_REFERENCE.md)

## Methodology and Execution Design

- [Automated GSD + autoresearch Pipeline](./AUTOMATED_GSD_AUTORESEARCH_PIPELINE.md)
- [Bleeding-Edge Execution Roadmap](./BLEEDING_EDGE_EXECUTION_ROADMAP.md)
- [Agentic Runtime Phased Design](./AGENTIC_RUNTIME_PHASED_DESIGN.md)
- [Agentic Runtime Implementation Plan](./AGENTIC_RUNTIME_IMPLEMENTATION_PLAN.md)
- [Upstream Implementation Matrix](./UPSTREAM_IMPLEMENTATION_MATRIX.md)

## Extension and Fork Guides

- [Domain Packs](./DOMAIN_PACKS.md)
- [Agentic Fork Guide](./AGENTIC_FORK_GUIDE.md)

## Miscellaneous Infra Notes

- [Dell R450 Serial SSH Readiness](./DELL_R450_SERIAL_SSH_READINESS.md)

## Repo Navigation

The repo is intentionally split this way:

- `README.md`: front-page product and architecture overview
- `docs/`: human-facing reference docs and diagrams
- `src/`: runtime, tools, and domain-pack code
- `bridges/`: bridge adapters for local IDE and CLI lanes
- `scripts/`: launcher, validation, and operational helpers
  This includes `agent_office_gui.mjs`, `agentic_suite_launch.mjs`, `bootstrap_doctor.mjs`, `bootstrap_install.mjs`, `open_browser.mjs`, and `platform_manifest.json` for the cross-platform office and suite bootstrap path.
- `web/office/` and `ui/`: GUI and terminal operator surfaces

Tool-specific companion files that remain at repo root on purpose:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
