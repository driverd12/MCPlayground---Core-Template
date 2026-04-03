# System Interconnects

This document is the current operator/demo reference for how the local MCP runtime, office surfaces, IDE bridges, terminal sessions, autonomy fabric, orchestration fabric, and host-control lanes connect.

Start here for the centralized docs map: [Documentation Index](./README.md)

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
    GH["GitHub CLI"]
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
  GH --> CLI
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

## 2. Layered Runtime Stack

```mermaid
flowchart TD
  Surface["Surface Layer<br/>README / docs / GUI / TUI / apps / shell wrappers"] --> Client["Client Layer<br/>Codex / Cursor / Gemini CLI / GitHub Copilot CLI / terminal sessions / gh"]
  Client --> Transport["Transport Layer<br/>HTTP / STDIO / launchd / app launchers"]
  Transport --> Kernel["Kernel Layer<br/>server.ts / tool registry / MCP handlers / office snapshot"]
  Kernel --> Control["Control-Plane Layer<br/>goal.* / plan.* / task.* / operator.brief / kernel.summary"]
  Kernel --> Policy["Governance Layer<br/>policy / preflight / postflight / ADR / decisions / incidents"]
  Kernel --> Autonomy["Autonomy Fabric Layer<br/>autonomy.maintain / autonomy.command / goal.autorun / eval / optimizer"]
  Kernel --> Orchestration["Orchestration Fabric Layer<br/>trichat.* / worker.fabric / runtime.worker / tmux controller / model.router / provider.bridge"]
  Kernel --> Host["Host-Control Layer<br/>desktop.* / patient.zero / privileged.exec"]
  Control --> State["State Layer<br/>SQLite / events / artifacts / ledgers / daemon configs / cache / secrets"]
  Policy --> State
  Autonomy --> State
  Orchestration --> State
  Host --> State
```

## 3. IDE and Terminal Session Flow

```mermaid
flowchart LR
  subgraph Sessions["Sessions and Clients"]
    Shell["Terminal shells"]
    Codex["Codex app / CLI session"]
    Cursor["Cursor IDE"]
    Gemini["Gemini CLI"]
    Copilot["GitHub Copilot CLI"]
    GH["GitHub CLI"]
  end

  subgraph Bridges["Bridge and Transport Surface"]
    STDIO["STDIO sessions"]
    HTTP["HTTP shared runtime"]
    Provider["provider.bridge diagnostics + install/export"]
  end

  subgraph Server["MCP Server"]
    Registry["toolRegistry / tool.search"]
    Office["office.snapshot / office gui snapshot"]
    Council["trichat.autopilot / trichat.turn / trichat.bus"]
    Brief["kernel.summary / operator.brief"]
  end

  Shell --> HTTP
  Shell --> STDIO
  Codex --> STDIO
  Cursor --> STDIO
  Gemini --> STDIO
  Copilot --> STDIO
  GH --> Shell
  Provider --> HTTP
  STDIO --> Registry
  HTTP --> Registry
  Registry --> Office
  Registry --> Council
  Registry --> Brief
```

## 4. Autonomy, Orchestration, and Execution Fabrics

```mermaid
flowchart TD
  subgraph Intake["Operator and IDE Intake"]
    GUI["Agent Office GUI"]
    TUI["Agent Office tmux"]
    Ingress["autonomy.ide_ingress / autonomy.command / shell wrappers"]
    IDEs["Codex / Cursor / Gemini CLI / GitHub Copilot CLI"]
  end

  subgraph Control["Control Plane"]
    Goal["goal.* / plan.* / task.*"]
    Brief["kernel.summary / operator.brief / office.snapshot"]
    Flags["permission.profile / feature.flag / warm.cache / budget.ledger"]
  end

  subgraph Autonomy["Autonomy Fabric"]
    Maintain["autonomy.maintain"]
    Autorun["goal.autorun / dispatch.autorun"]
    Eval["eval.* / optimizer / reaction.engine"]
  end

  subgraph Orchestration["Orchestration Fabric"]
    Council["trichat.autopilot / council turn"]
    Router["model.router / provider.bridge"]
    Workers["worker.fabric / runtime.worker / tmux controller"]
  end

  subgraph Execution["Execution Lanes"]
    LocalTools["Local MCP tools"]
    CLI["Terminal CLI toolkit<br/>codex / claude / cursor / gemini / gh"]
    Agents["Local office agents<br/>directors / leaves / local-imprint"]
    Desktop["desktop.* / patient.zero / privileged.exec"]
  end

  subgraph State["State and Evidence"]
    DB["SQLite / daemon_configs / tasks / plans"]
    Events["events / runs / artifacts / learning"]
    Cache["warm cache / office snapshot cache"]
  end

  GUI --> Brief
  TUI --> Brief
  Ingress --> Goal
  IDEs --> Goal
  Goal --> Maintain
  Goal --> Council
  Brief --> Cache
  Flags --> DB
  Maintain --> Autorun
  Maintain --> Eval
  Autorun --> Council
  Council --> Router
  Council --> Workers
  Router --> CLI
  Workers --> Agents
  Workers --> LocalTools
  Desktop --> Events
  CLI --> Events
  Agents --> Events
  LocalTools --> Events
  Events --> DB
```

## 5. Office + Bridge Connectivity

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
    ImprintLane["Local Imprint lane"]
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
  Sessions --> ImprintLane
  RuntimeWorkers --> CodexLane
  RuntimeWorkers --> CursorBridge
  RuntimeWorkers --> GeminiBridge
  RuntimeWorkers --> CopilotBridge
  RuntimeWorkers --> ImprintLane
  Router --> Provider
```

## 6. Local Host Control and Patient Zero

```mermaid
flowchart TD
  Operator["Operator"] --> Arm["patient.zero action=enable"]
  Arm --> PZ["Patient Zero armed posture"]

  PZ --> Desktop["desktop.control / desktop.observe / desktop.act / desktop.listen"]
  PZ --> Browser["Safari / browser actuation"]
  PZ --> Verify["privileged.exec action=verify"]
  PZ --> Toolkit["Terminal toolkit<br/>codex / claude / cursor / gemini / gh"]
  PZ --> AgentPool["Local and bridge agents<br/>codex / claude / cursor / gemini / github-copilot / local-imprint / directors / leaves"]
  PZ --> Maintain["autonomy.maintain self-drive"]
  PZ --> Autopilot["trichat.autopilot execute"]

  Verify --> Secret["~/.codex/secrets/mcagent_admin_password"]
  Verify --> Account["mcagent account"]
  Account --> Root["target user: root"]

  Root --> Exec["privileged.exec action=execute"]
  Exec --> Audit["event.* runtime audit trail"]
  Desktop --> Audit
  Browser --> Audit
  Toolkit --> Audit
  AgentPool --> Audit
  Maintain --> Audit
  Autopilot --> Audit

  Audit --> Office["Agent Office GUI / operator.brief / kernel.summary"]
```

## 7. Operational Notes

- `/ready` is the authoritative HTTP readiness gate for the office launcher and automation wrappers.
- `/health` is intentionally cheap and only proves that the listener is alive.
- `/office/api/snapshot` serves cached snapshots by default and uses explicit live refreshes sparingly to avoid saturating the daemon.
- `patient.zero` does not silently grant root. Root becomes available only when:
  - Patient Zero is armed.
  - the `mcagent` secret exists outside the repo and SQLite.
  - the `privileged.exec` verifier has proved the `mcagent -> root` path.
- When Patient Zero is armed, it also widens the active autonomy toolkit by enabling:
  - maintain self-drive
  - autopilot execute posture
  - the terminal CLI toolkit (`codex`, `cursor`, `gemini`, `gh`)
  - the local and bridge specialist pool, including `local-imprint`
- Every privileged verification and execution attempt is written into the runtime event trail.
