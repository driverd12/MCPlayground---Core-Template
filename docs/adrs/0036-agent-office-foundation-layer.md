# 0036-agent-office-foundation-layer: Agent Office Foundation Layer

- Status: accepted
- Date: 2026-03-27T06:11:48.384Z

## Content
# Agent Office Foundation Layer

## Context
Dan Driver is building a local-first MCP server and agent office on a MacBook Pro M4 Max as the base layer for a larger autonomous system.

## Decision
Use Ring Leader as the local orchestrator with a director-first hierarchy (`implementation-director`, `research-director`, `verification-director`) and narrow leaf SMEs (`code-smith`, `research-scout`, `quality-guard`). Require GSD-style bounded work packets with one owner, explicit success criteria, evidence requirements, rollback notes, and stop conditions. Treat confidence as a combination of consensus plus plan substance so vague prompt echoes cannot pass as strong plans. Make the primary operator UI a tmux-backed Agent Office TUI with real MCP/tmux telemetry, sprite state mapping, and a one-click macOS Applications launcher.

## Consequences
The system favors reliable delegation and evidence over theatrical autonomy. Future work should keep the office TUI operationally honest, preserve continuity in MCP memory/artifacts, and avoid promoting empty or weak tool paths as meaningful progress.
