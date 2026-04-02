# System Interconnects

This document is the current operator/demo reference for how the local MCP runtime, office surfaces, IDE bridges, autonomy fabric, and host-control lanes connect.

## 1. Control Plane Topology

```mermaid
flowchart LR
  subgraph Operator["Operator + Demo Surfaces"]
    GUI["Agent Office GUI<br/>/office/"]
    TUI["Agent Office TUI / tmux"]
    Suite["Agentic Suite.app"]
    App["Agent Office.app"]
    CLI["Shell wrappers<br/>autonomy_ctl.sh / provider_bridge.sh / operator_brief.sh"]
  end

  subgraph ClientBridges["IDE + Provider Bridges"]
    Codex["Codex desktop / CLI"]
    Cursor["Cursor"]
    Gemini["Gemini CLI"]
    Copilot["GitHub Copilot CLI"]
    Helper["scripts/mcp_tool_call.mjs"]
  end

  subgraph MCP["Local MCP Surface"]
    HTTP["HTTP transport<br/>/health /ready /office/api/* / MCP POST"]
    STDIO["STDIO transport"]
  end

  subgraph Runtime["MCPlayground Core Runtime"]
    Registry["toolRegistry<br/>tool.search"]
    Kernel["goal.* / plan.* / task.* / agent.session.* / kernel.summary / operator.brief"]
    Office["trichat.* / office.snapshot / office gui snapshot"]
    Control["permission.profile / feature.flag / budget.ledger / warm.cache"]
    Local["desktop.* / patient.zero / privileged.exec"]
  end

  subgraph Storage["Durable State"]
    DB["SQLite<br/>tasks / goals / plans / events / budgets / daemon configs"]
    Cache["Warm cache + office snapshot cache"]
    Secrets["Local-only secrets<br/>~/.codex/secrets/*"]
  end

  GUI --> HTTP
  TUI --> HTTP
  Suite --> HTTP
  App --> HTTP
  CLI --> HTTP

  Codex --> STDIO
  Cursor --> STDIO
  Gemini --> STDIO
  Copilot --> STDIO
  Helper --> STDIO
  Helper --> HTTP

  HTTP --> Registry
  HTTP --> Kernel
  HTTP --> Office
  STDIO --> Registry
  STDIO --> Kernel
  STDIO --> Office

  Registry --> Control
  Kernel --> DB
  Office --> DB
  Control --> DB
  Local --> DB
  HTTP --> Cache
  Office --> Cache
  Local --> Secrets
```

## 2. Autonomy and Agentic Fabric

```mermaid
flowchart TD
  Intake["Operator intake<br/>GUI / autonomy.ide_ingress / autonomy.command"] --> Goal["goal.create / goal.execute"]
  Goal --> Plan["plan.* / task.compile / playbook.*"]
  Plan --> Dispatch["plan.dispatch / dispatch.autorun / goal.autorun"]

  Dispatch --> Council["trichat.autopilot / council turn / confidence gate"]
  Council --> Directors["implementation-director / research-director / verification-director"]
  Directors --> Leafs["code-smith / research-scout / quality-guard / local-imprint"]

  Dispatch --> Workers["runtime.worker / worker.fabric / tmux controller"]
  Workers --> LocalExec["direct shell / local commands / local MCP tools"]
  Workers --> Bridges["provider.bridge / routed external-capable bridges"]

  Council --> Evidence["run.* / event.* / artifact.* / experiment.*"]
  Workers --> Evidence
  LocalExec --> Evidence
  Bridges --> Evidence

  Evidence --> Learn["agent.learning.* / knowledge.* / memory.* / transcript.*"]
  Learn --> Council
  Learn --> Goal
```

## 3. Office + Bridge Connectivity

```mermaid
flowchart LR
  subgraph Office["Agent Office"]
    Snapshot["office.snapshot / office gui snapshot"]
    Workboard["trichat.workboard / trichat.summary"]
    Brief["operator.brief / kernel.summary"]
    Actions["/office/api/action<br/>ensure / maintain / tmux / patient zero"]
  end

  subgraph Bridges["Live Client Bridges"]
    CursorBridge["Cursor bridge"]
    GeminiBridge["Gemini bridge"]
    CopilotBridge["GitHub Copilot bridge"]
    CodexLane["Codex lane"]
  end

  subgraph Fabric["Autonomy Fabric"]
    Router["model.router"]
    Provider["provider.bridge"]
    Sessions["agent.session.*"]
    RuntimeWorkers["runtime.worker / tmux workers"]
  end

  Snapshot --> Workboard
  Snapshot --> Brief
  Snapshot --> Provider
  Snapshot --> Sessions
  Actions --> Fabric

  Provider --> CursorBridge
  Provider --> GeminiBridge
  Provider --> CopilotBridge
  Sessions --> CodexLane
  RuntimeWorkers --> CodexLane
  RuntimeWorkers --> CursorBridge
  RuntimeWorkers --> GeminiBridge
  RuntimeWorkers --> CopilotBridge
  Router --> Provider
```

## 4. Local Host Control and Patient Zero

```mermaid
flowchart TD
  Operator["Operator"] --> Arm["patient.zero action=enable"]
  Arm --> PZ["Patient Zero armed posture"]

  PZ --> Desktop["desktop.control / desktop.observe / desktop.act / desktop.listen"]
  PZ --> Verify["privileged.exec action=verify"]
  Verify --> Secret["~/.codex/secrets/mcagent_admin_password"]
  Verify --> Account["mcagent account"]
  Account --> Root["target user: root"]

  Root --> Exec["privileged.exec action=execute"]
  Exec --> Audit["event.* runtime audit trail"]
  Desktop --> Audit
  PZ --> Audit

  Audit --> Office["Agent Office GUI / operator.brief / kernel.summary"]
```

## 5. Operational Notes

- `/ready` is the authoritative HTTP readiness gate for the office launcher and automation wrappers.
- `/health` is intentionally cheap and only proves that the listener is alive.
- `/office/api/snapshot` serves cached snapshots by default and uses explicit live refreshes sparingly to avoid saturating the daemon.
- `patient.zero` does not silently grant root. Root becomes available only when:
  - Patient Zero is armed.
  - the `mcagent` secret exists outside the repo and SQLite.
  - the `privileged.exec` verifier has proved the `mcagent -> root` path.
- Every privileged verification and execution attempt is written into the runtime event trail.
