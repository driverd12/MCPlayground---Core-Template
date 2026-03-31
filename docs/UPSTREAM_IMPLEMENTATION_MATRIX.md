# Upstream Implementation Matrix

This repository borrows ideas from several open projects, but it does not pretend to clone them 1:1. This file records what is implemented for real in this MCP server, what is adapted to fit the local-first kernel, and what remains intentionally out of scope.

## Status Legend

- `implemented`: live code path exists and is validated in this repo
- `adapted`: the upstream idea is reproduced in kernel-native form instead of copied directly
- `out of scope`: intentionally not reproduced here

## RALPH TUI

Source:
- [RALPH TUI README](https://github.com/subsy/ralph-tui)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Autonomous operator loop (`select -> build -> execute -> completion -> next`) | `adapted` | Ring leader uses `agent.claim_next -> council -> execution router -> agent.report_result` in [src/tools/trichat.ts](../src/tools/trichat.ts) |
| Persistent session-oriented TUI | `implemented` | Agent Office dashboard and tmux war room in [scripts/agent_office_dashboard.py](../scripts/agent_office_dashboard.py) and [scripts/agent_office_tmux.sh](../scripts/agent_office_tmux.sh) |
| Real-time visibility into nested work | `implemented` | Dashboard reads `trichat.*`, `task.*`, `agent.session.*`, and `kernel.summary`; worker ownership is stamped explicitly in tmux task metadata |
| Resume / survive crashes | `implemented` | Durable state lives in SQLite, launchd keeps the HTTP daemon alive, and `resume-latest` office launch picks back up from stored thread/session state |

Intentionally out of scope:

- PRD / Beads tracker compatibility
- Ralph remote multi-machine tabs
- Ralph plugin ecosystem and external config format

## Get Shit Done

Source:
- [Get Shit Done README](https://github.com/gsd-build/get-shit-done)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Bounded single-owner work packets | `implemented` | Delegation briefs require owner, task objective, evidence, rollback, and stop conditions in [bridges/local_imprint_bridge.py](../bridges/local_imprint_bridge.py) and [src/tools/trichat.ts](../src/tools/trichat.ts) |
| Delivery phases for discovery / planning / execution / verify | `implemented` | `playbook.*` exposes `gsd.map_codebase`, `gsd.phase_delivery`, and `gsd.debug_issue` from [src/tools/playbook.ts](../src/tools/playbook.ts) |
| Confidence-before-action discipline | `adapted` | Ring leader uses `gsd-confidence` checks for owner clarity, actionability, evidence, rollback, and anti-echo novelty in [src/tools/trichat.ts](../src/tools/trichat.ts) |
| Program the org, not the loop | `implemented` | Director-first delegation and explicit leaf routing in [config/trichat_agents.json](../config/trichat_agents.json) |

## autoresearch

Source:
- [autoresearch README](https://github.com/karpathy/autoresearch)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Baseline -> propose -> variant -> measure -> accept/reject loop | `implemented` | `playbook.run` exposes `autoresearch.optimize_loop` in [src/tools/playbook.ts](../src/tools/playbook.ts) |
| Experiment evidence as the decision boundary | `implemented` | `experiment.*`, `artifact.*`, and verification-driven routing in [src/tools](../src/tools) |
| Small-budget overnight continuation | `adapted` | Local daemon uses bounded intervals, adaptive worker history, and tmux-backed execution instead of training-loop mutation |
| Edit only the narrow surface that matters | `adapted` | Specialists and leaf agents receive sharply bounded objectives instead of free-form recursive self-improvement work |

Intentionally out of scope:

- Single-GPU training loop itself
- Self-modifying training code path from the upstream repo

## SuperClaude Framework

Source:
- [SuperClaude Framework README](https://github.com/SuperClaude-Org/SuperClaude_Framework)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Explicit methodology / confidence checks | `implemented` | `gsd-confidence` is surfaced in briefing and session metadata |
| Specialized roles with clearer responsibilities | `implemented` | Ring leader, directors, SMEs, leaf agents, and support lanes are defined in the roster and bridge prompts |
| Operator-visible methodology | `implemented` | Agent Office briefing and help views show the confidence method and methodology lineage |

Intentionally out of scope:

- Slash-command surface and Claude-specific command vocabulary
- Framework-specific plugin/install layout

## DAN Prompt Gist

Source:
- [ChatGPT-Dan-Jailbreak.md gist](https://gist.github.com/coolaj86/6f4f7b30129b0251f61fa7baaa881516)

Only stylistic inspiration is allowed here:

- playful mode naming
- operator-facing energy

Unsafe guardrail bypass, jailbreak behavior, or instruction-override patterns are explicitly out of scope.

## builderz-labs / mission-control

Source:
- [mission-control README](https://github.com/builderz-labs/mission-control)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Single mission-control surface for operators | `adapted` | Built-in `/office/` GUI plus tmux office substrate share one live MCP backend |
| Room-based orchestration view | `implemented` | Command deck, lounge, build bay, and ops rack are rendered from real MCP presence signals |
| Modern control-room feel over a local agent stack | `implemented` | Clickable Agent Office GUI served directly by the HTTP transport |

Intentionally out of scope:

- mission-control's hosted SaaS surface
- its cloud-specific deployment assumptions

## ComposioHQ / agent-orchestrator

Source:
- [agent-orchestrator README](https://github.com/ComposioHQ/agent-orchestrator)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Event-driven reaction loop | `implemented` | `reaction.engine` plus notifier channels |
| Provider-aware orchestration | `implemented` | `provider.bridge` and canonical `autonomy.ide_ingress` |
| Human-attention escalation | `implemented` | deduped desktop/webhook notifications and office-visible reaction state |

## ruvnet / ruflo

Source:
- [ruflo README](https://github.com/ruvnet/ruflo)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Swarm topology selection by objective | `implemented` | `swarm.profile` |
| Memory-aware preflight before coordination | `implemented` | retrieval hybrid query and checkpoint metadata on `autonomy.command` |
| Checkpointed swarm reasoning | `adapted` | durable swarm checkpoint artifacts and operator-visible swarm summary |

## hpn-bristol / agentic-ai-future-factory

Source:
- [agentic-ai-future-factory README](https://github.com/hpn-bristol/agentic-ai-future-factory)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Reproducible workflow export | `implemented` | `workflow.export` bundle + metrics ledger |
| Data-driven orchestration metrics | `implemented` | append-only `run-metrics.jsonl` from durable run/task history |
| Argo-oriented DAG contract | `adapted` | truthful YAML contract export without claiming live cluster execution |

Intentionally out of scope:

- live Kubernetes execution
- Argo step runner

## EvoAgentX

Source:
- [EvoAgentX README](https://github.com/EvoAgentX/EvoAgentX)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Agent-program mutation and evaluation | `implemented` | `optimizer.*` |
| Promotion only on measured improvement | `implemented` | candidate vs baseline scoring and gated promotion |
| Runtime behavior changed by promoted programs | `implemented` | `task.compile` and `trichat` consume effective org-program signals live |

Intentionally out of scope:

- arbitrary workflow-graph mutation
- free-form recursive self-improvement

## jayminwest / overstory

Source:
- [overstory README](https://github.com/jayminwest/overstory)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Worktree-native coding workers | `implemented` | `runtime.worker` launches tmux-backed isolated worktree runtimes |
| Persistent runtime session tracking | `implemented` | durable `runtime_worker_sessions` schema |
| Runtime follow-through instead of fire-and-forget | `implemented` | completion-envelope reconciliation and maintain auto-spawn |

Intentionally out of scope:

- Overstory-specific cost console and replay UX
- provider-specific runtime adapters beyond current `codex` and `shell` runtime modes
