# MCPlayground Core Template

<img src="./docs/assets/patient-zero-banner-v2.svg" alt="Patient Zero pixel-art banner showing Agent Office, MCP Server, and the local agent crew" width="100%" />

MCPlayground Core Template is a local-first MCP server runtime designed to be reused across domains.

The repository is intentionally split into two layers:

1. Core runtime: durable memory, transcripts, tasks, run ledgers, governance, ADRs, and safety checks.
2. Domain packs: optional modules that register domain-specific MCP tools without modifying core infrastructure.

This repository ships with one workflow pack by default:

- `agentic` GSD/autoresearch-inspired planner and verifier hooks for local development workflows.

The runtime also includes first-class office/orchestration tools (`trichat.*` under the hood) for multi-agent turns, autonomous loops, and tmux-backed nested execution control, plus the newer local control-plane surfaces:

- `tool.search` for live capability discovery from the registered MCP tool registry
- `permission.profile` for durable session permission inheritance across goals, plans, tasks, and sessions
- `budget.ledger` for append-only token/cost tracking and operator budget summaries
- `warm.cache` for startup prefetch and cached operator surfaces
- `feature.flag` for durable rollout state
- `desktop.*`, `patient.zero`, and `privileged.exec` for explicit local desktop and privileged execution lanes

## Patient Zero End-State

`Patient Zero` is the intended end-state of this repo: a local-first operator partner that can take full bounded control of the host when explicitly armed.

When enabled, Patient Zero is the mode that ties the stack together:

- office and council orchestration
- autonomous continuation through `autonomy.maintain`
- CLI and IDE bridge usage across Codex, Claude CLI, Cursor, Gemini CLI, GitHub Copilot CLI, and `gh`
- local desktop/browser/root-capable host-control lanes
- full auditability through runtime events, runs, ledgers, and operator surfaces

## Documentation Hub

Start here if you want the current docs map:

- [Documentation Index](./docs/README.md)
- [Quick Setup](./docs/SETUP.md)
- [System Interconnects](./docs/SYSTEM_INTERCONNECTS.md)
- [IDE + Agent Setup Guide](./docs/IDE_AGENT_SETUP.md)
- [Transport Connection Guide](./docs/CONNECT.md)
- [Provider Bridge Matrix](./docs/PROVIDER_BRIDGE_MATRIX.md)
- [TriChat Compatibility Reference](./docs/TRICHAT_COMPATIBILITY_REFERENCE.md)

Root-level companion files intentionally left outside `docs/`:

- `AGENTS.md` for coding-agent operating instructions
- `GEMINI.md` for Gemini-specific local notes

## Layered Runtime Map

```mermaid
flowchart TD
  Operator["Operator Surfaces<br/>README / docs / Agent Office GUI / tmux / shell wrappers"] --> Clients["IDE + Terminal Clients<br/>Codex / Claude CLI / Cursor / Gemini CLI / GitHub Copilot CLI / shell sessions / gh"]
  Clients --> Transport["MCP Transport Layer<br/>HTTP / STDIO / launchd / app launchers"]
  Transport --> Kernel["MCP Kernel Layer<br/>toolRegistry / server.ts / core tools / office snapshot"]
  Kernel --> Control["Control-Plane Layer<br/>goal.* / plan.* / task.* / kernel.summary / operator.brief / tool.search / permission.profile / warm.cache / feature.flag / budget.ledger"]
  Kernel --> Autonomy["Autonomy Fabric Layer<br/>autonomy.maintain / autonomy.command / goal.autorun / reaction.engine / eval / optimizer"]
  Kernel --> Orchestration["Orchestration Fabric Layer<br/>office council / tmux controller / runtime.worker / worker.fabric / model.router / provider.bridge"]
  Kernel --> Local["Local Host Control Layer<br/>desktop.* / patient.zero / privileged.exec"]
  Control --> State["Durable State Layer<br/>SQLite / warm cache / artifacts / runs / events / daemon configs / local secrets"]
  Autonomy --> State
  Orchestration --> State
  Local --> State
```

## MCP Capability Wireframe

This is the operator-facing map of the current server surface.

```mermaid
flowchart TD
  Clients["Codex / Cursor / IDE / HTTP Clients"] --> Transport["MCP Transports<br/>stdio / HTTP / launchd"]
  Transport --> Kernel["MCPlayground Core Template Server"]

  Kernel --> Memory["Continuity + Knowledge<br/>memory.* / transcript.* / who_knows / knowledge.query / retrieval.hybrid / imprint.*"]
  Kernel --> Control["Execution Control Plane<br/>goal.* / plan.* / dispatch.autorun / goal.autorun* / playbook.*"]
  Kernel --> Worker["Durable Worker Ops<br/>agent.session.* / agent.claim_next / agent.report_result / task.* / run.* / lock.* / event.*"]
  Kernel --> Evidence["Evidence + Governance<br/>artifact.* / experiment.* / policy.evaluate / preflight.check / postflight.verify / adr.create / decision.link / incident.*"]
  Kernel --> Office["Office + Orchestration Ops<br/>trichat.thread* / trichat.turn* / trichat.autopilot / trichat.tmux_controller / trichat.bus / trichat.adapter_telemetry / trichat.slo / trichat.chaos"]
  Kernel --> Health["Runtime + Recovery<br/>kernel.summary / health.* / migration.status / backups / corruption quarantine"]
  Kernel --> Learning["Bounded Agent Learning<br/>agent.learning_* / mentorship notes / MCP memory / ADR trail"]

  Office --> Dashboard["Agent Office Dashboard<br/>curses TUI + tmux war room + macOS app"]
  Worker --> Packs["Domain Packs + Hooks<br/>agentic pack / pack.plan.generate / pack.verify.run"]
  Evidence --> Packs
  Learning --> Office
  Learning --> Worker
```

## Agent Spawn Wireframe

This is the current ring-leader spawning and delegation shape.

```mermaid
flowchart TD
  User["User / Operator"] --> Ring["Ring Leader<br/>lead agent / council selector / confidence gate / GSD planner"]

  Ring --> DirImpl["implementation-director<br/>implementation planner"]
  Ring --> DirResearch["research-director<br/>research planner"]
  Ring --> DirVerify["verification-director<br/>verification planner"]
  Ring --> LocalImprint["local-imprint<br/>local memory + continuity lane"]
  Ring --> Codex["codex<br/>frontier review / hard problems / integration lane"]

  DirImpl --> CodeSmith["code-smith<br/>leaf SME for implementation slices"]
  DirResearch --> ResearchScout["research-scout<br/>leaf SME for bounded research"]
  DirVerify --> QualityGuard["quality-guard<br/>leaf SME for verification and release checks"]

  Ring --> Claim["agent.claim_next<br/>claim bounded work"]
  Claim --> Council["Office council turn<br/>confidence + plan substance + policy gates"]
  Council --> Execute["Execution router<br/>direct command / tmux dispatch / fallback task batch"]
  Execute --> Leafs["Leaf / SME agents<br/>single-owner bounded tasks"]
  Leafs --> Report["agent.report_result<br/>artifacts / evidence / outcomes / learning signal"]
  Report --> Learn["Bounded learning ledger<br/>prefer / avoid / proof bars / rollback discipline"]
  Learn --> Ring

  Execute --> Tmux["office tmux controller<br/>worker lanes / queue discipline / office telemetry"]
  Tmux --> Dashboard["Agent Office Dashboard<br/>desk work / chat / break / sleep sprites"]
```

## System Interconnects

This is the current end-to-end local topology: launchers, IDEs, terminal bridges, the MCP runtime, the autonomy fabric, and the local-control lanes.

```mermaid
flowchart LR
  subgraph Operator["Operator Surfaces"]
    OfficeGUI["Agent Office GUI<br/>/office/"]
    OfficeTUI["Agent Office TUI / tmux"]
    Suite["Agentic Suite.app"]
    Shell["Shell wrappers<br/>autonomy_*.sh / provider_bridge.sh"]
  end

  subgraph Clients["IDE + Bridge Clients"]
    Codex["Codex"]
    Claude["Claude CLI"]
    Cursor["Cursor"]
    Gemini["Gemini CLI"]
    Copilot["GitHub Copilot CLI"]
    Browser["Safari"]
  end

  subgraph Transport["Local MCP Transport"]
    HTTP["HTTP transport<br/>/ready /office/api/* / MCP bearer auth"]
    STDIO["STDIO transport<br/>single-client / helper calls"]
  end

  subgraph Kernel["MCPlayground MCP Server"]
    Registry["toolRegistry + tool.search"]
    Control["goal.* / plan.* / task.* / agent.session.* / operator.brief / kernel.summary"]
    Fabric["office orchestration / worker.fabric / runtime.worker / model.router / provider.bridge"]
    Flags["permission.profile / feature.flag / budget.ledger / warm.cache"]
    Local["desktop.* / patient.zero / privileged.exec"]
  end

  subgraph State["Durable Local State"]
    SQLite["SQLite state authority<br/>goals / plans / tasks / runs / events / ledgers / daemon configs"]
    Cache["Warm cache + office snapshot cache"]
    Secret["Local secret file<br/>~/.codex/secrets/mcagent_admin_password"]
  end

  subgraph Host["Local Host Capabilities"]
    Desktop["Desktop control<br/>observe / act / listen"]
    Admin["mcagent -> root lane"]
    Runtime["launchd / tmux / local workers"]
  end

  OfficeGUI --> HTTP
  OfficeTUI --> HTTP
  Suite --> HTTP
  Shell --> HTTP
  Codex --> STDIO
  Cursor --> STDIO
  Gemini --> STDIO
  Copilot --> STDIO
  Browser --> HTTP

  HTTP --> Registry
  HTTP --> Control
  HTTP --> Fabric
  STDIO --> Registry
  STDIO --> Control
  STDIO --> Fabric

  Registry --> Flags
  Control --> SQLite
  Fabric --> SQLite
  Flags --> SQLite
  Local --> SQLite
  Control --> Cache
  HTTP --> Cache

  Fabric --> Runtime
  Fabric --> Desktop
  Local --> Desktop
  Local --> Admin
  Admin --> Secret
```

Full diagrams for demos and technical walk-throughs: [System Interconnects](./docs/SYSTEM_INTERCONNECTS.md)

## IDE, CLI, and Office Flow

```mermaid
flowchart LR
  subgraph Entry["Entry Points"]
    OfficeGUI["Agent Office GUI"]
    OfficeTUI["Agent Office tmux"]
    Suite["Agentic Suite.app"]
    Shell["Terminal sessions<br/>bash / zsh / shell wrappers"]
    Codex["Codex"]
    Claude["Claude CLI"]
    Cursor["Cursor"]
    Gemini["Gemini CLI"]
    Copilot["GitHub Copilot CLI"]
    GH["GitHub CLI (gh)"]
  end

  subgraph MCP["Local MCP Surfaces"]
    HTTP["HTTP<br/>/ready /office/api/* / MCP POST"]
    STDIO["STDIO<br/>client-launched MCP sessions"]
  end

  subgraph Runtime["MCPlayground Runtime"]
    Registry["tool registry + capability discovery"]
    Brief["kernel.summary / operator.brief / office.snapshot"]
    Council["office council + autopilot"]
    Workers["runtime.worker / worker.fabric / tmux lanes"]
    LocalCtl["desktop.* / patient.zero / privileged.exec"]
  end

  subgraph State["State + Evidence"]
    DB["SQLite"]
    Cache["warm cache"]
    Events["event trail / runs / artifacts / learning"]
  end

  OfficeGUI --> HTTP
  OfficeTUI --> HTTP
  Suite --> HTTP
  Shell --> HTTP
  Shell --> STDIO
  Codex --> STDIO
  Cursor --> STDIO
  Gemini --> STDIO
  Copilot --> STDIO
  GH --> Shell

  HTTP --> Registry
  STDIO --> Registry
  Registry --> Brief
  Registry --> Council
  Registry --> Workers
  Registry --> LocalCtl
  Brief --> DB
  Council --> DB
  Workers --> DB
  LocalCtl --> DB
  Brief --> Cache
  Council --> Events
  Workers --> Events
  LocalCtl --> Events
```

## Patient Zero Toolkit Flow

```mermaid
flowchart TD
  Operator["Operator"] --> Arm["patient.zero enable"]
  Arm --> PZ["Patient Zero posture"]

  PZ --> Desktop["Desktop lanes<br/>observe / act / listen / Safari"]
  PZ --> Root["Privileged lane<br/>mcagent -> root"]
  PZ --> Maintain["autonomy.maintain<br/>self-drive on"]
  PZ --> Autopilot["office autopilot<br/>trichat.autopilot execute enabled"]

  Autopilot --> Toolkit["Terminal toolkit<br/>codex / claude / cursor / gemini / gh"]
  Autopilot --> Bridges["Bridge-capable agents<br/>codex / claude / cursor / gemini / github-copilot"]
  Autopilot --> Locals["Local office agents<br/>directors / leaves / local-imprint"]

  Desktop --> Audit["event.* / run.* / operator surfaces"]
  Root --> Audit
  Maintain --> Audit
  Autopilot --> Audit
  Toolkit --> Audit
  Bridges --> Audit
  Locals --> Audit
```

## Why This Template Exists

Most MCP projects repeat the same infrastructure work:

- durability and state continuity
- safe/idempotent writes
- local governance and auditability
- task orchestration
- cross-client interoperability

This template centralizes those concerns so teams can build domain tools directly.

## Client-Ready Architecture Pitch

Use this framing with stakeholders:

- This is not a single-purpose assistant.
- This is a local MCP platform with reusable reliability primitives.
- Domain value is delivered through packs, not by rewriting runtime infrastructure.

```mermaid
flowchart LR
  A["Cursor / Codex / IDE Clients"] --> K["Local MCP Kernel"]
  B["Inbox Workers / tmux / Background Automation"] --> K
  C["Office / Council UI"] --> K
  D["Future External Adapters"] --> K

  K --> E["Control Plane
  agent.session.*
  goal.*
  plan.*
  dispatch.autorun"]
  K --> F["Execution + Audit
  task.*
  run.*
  lock.*
  event.*"]
  K --> G["Evidence + Methodology
  artifact.*
  experiment.*
  playbook.*
  pack hooks"]

  G --> H["GSD Delivery Flow"]
  G --> I["autoresearch Optimization Loop"]
  K --> J[("SQLite + local runtime state")]
```

More detail: [Architecture Pitch](./docs/ARCHITECTURE_PITCH.md)

Methodology automation: [Automated GSD + autoresearch Pipeline](./docs/AUTOMATED_GSD_AUTORESEARCH_PIPELINE.md)

Execution roadmap: [Bleeding-Edge Execution Roadmap](./docs/BLEEDING_EDGE_EXECUTION_ROADMAP.md)

Execution substrate additions now shipped in core:

- `worker.fabric` for host registry, telemetry, and resource-aware lane routing
- `cluster.topology` for the durable lab plan: active Mac control plane plus planned future CPU-heavy and GPU-heavy nodes
- `model.router` for measured backend selection across local and remote model runtimes, plus topology-backed future placement recommendations for planned hosts
- `benchmark.*` and `eval.*` for isolated execution scoring and router-aware eval suites
- `task.compile` for durable DAG-style plan compilation with owner/evidence/rollback contracts
- `org.program` for versioned ring leader, director, SME, and leaf operating doctrine

Practical entrypoint:
- use `playbook.run` to instantiate a GSD/autoresearch workflow and immediately enter `goal.execute`
- let `agent.report_result` feed artifacts, experiment observations, evidence gates, and bounded `goal.autorun` continuation back into the kernel
- use `kernel.summary` for one-shot operator state and `goal.autorun_daemon` for bounded unattended continuation

## Operator Briefing

The canonical live brief surface is `operator.brief`.

- `task.compile` writes a durable `compile.brief` artifact for the active plan
- `runtime.worker` writes a concrete handoff `session_brief.md` into the worker workspace
- `office.snapshot` includes `operator_brief` so the office dashboard and GUI can consume the same canonical brief
- `operator.brief` merges current objective, delegation contract, compile brief, runtime handoff brief, and execution backlog into one operator-facing payload

Shell entrypoint:

```bash
npm run brief:current
# compact JSON for scripts / dashboards
npm run brief:current -- --json --compact
```

Raw MCP example:

```bash
node ./scripts/mcp_tool_call.mjs --tool operator.brief --args '{}' --transport http --url http://127.0.0.1:8787/ --origin http://127.0.0.1 --cwd .
```

## Provider Bridge Diagnostics

Use the provider bridge to distinguish three different states:

- client config is installed
- a provider runtime is present on this host
- the provider can actually see the shared MCP server right now

Commands:

```bash
npm run providers:status
npm run providers:diagnose -- claude-cli gemini-cli cursor github-copilot-cli
```

Notes:

- Claude CLI now defaults to a resilient stdio proxy on this host: it targets the MCP HTTP daemon first and falls back to a local stdio server path if the daemon is unhealthy, while still mapping to the `claude` office agent and `autonomy.ide_ingress`.
- Claude model use still depends on Claude Code being authenticated on the host; `provider.bridge diagnose` distinguishes configured MCP install from live authenticated runtime.
- Gemini CLI now installs with an explicit trusted stdio proxy config, working directory, timeout, and HTTP-to-stdio fallback in `~/.gemini/settings.json`.
- Cursor is validated as configured on this host, but runtime MCP status still has to be checked in the Cursor UI because Cursor does not expose a local MCP status CLI on this machine.

## Quick Start

```bash
npm run bootstrap:env
npm run start:stdio
```

If this is your first time with MCPlayground, think of it as a local AI-agent toolbench rather than a normal app you click through manually. You bootstrap the base runtime, then your MCP-capable AI client uses the tools here to build and adapt project-specific scaffolding, status surfaces, memories, and workflows.

On Windows, use the `npm run ...` scripts exactly as shown. Do not manually type bash-style environment prefixes such as `MCP_HTTP=1 node ...`; `npm run start:http` handles that in cross-platform Node code.

## Get or Update This Repo

Fresh clone:

```bash
git clone https://github.com/driverd12/MCPlayground---Core-Template.git
cd MCPlayground---Core-Template
npm run bootstrap:env
```

If you already have a local checkout:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
npm run bootstrap:env
```

Start HTTP transport:

```bash
npm run start:http
```

If Windows prints `'MCP_HTTP' is not recognized`, that checkout is old or a direct shell command was copied. Pull latest `main` and run the npm script above.

Start pure core runtime with workflow hooks disabled:

```bash
npm run start:core
# or
npm run start:core:http
```

## Office TUI and Council Shells

The older `trichat:*` script names are still present for compatibility, but the user-facing surface is the Agent Office and its council/autopilot fabric.

Quick launch:

```bash
npm run trichat:tui
npm run trichat:office:gui
npm run autonomy:command -- "Take this objective from intake to durable execution."
```

Full legacy command reference, roster commands, doctor flows, and validation examples now live in [TriChat Compatibility Reference](./docs/TRICHAT_COMPATIBILITY_REFERENCE.md).

## Agent Office Dashboard

Launch the animated office monitor directly:

```bash
npm run trichat:office
```

Launch the clickable local GUI control deck:

```bash
npm run trichat:office:gui
```

Start the tmux war room with dedicated windows for the office scene, briefing board, lane monitor, and worker queue:

```bash
npm run trichat:office:tmux
```

Open the intake desk directly when you want to hand the office a plain-language objective and let the autonomous stack run with it:

```bash
npm run autonomy:intake:shell
```

The intake desk now uses the same `autonomy.ide_ingress` path as the IDE wrapper, so office intake, Codex/IDE intake, transcript continuity, thread mirroring, memory capture, and durable background execution all stay on one real lane.

This dashboard is MCP-backed and reads live state from office/orchestration tools, kernel summaries, Patient Zero state, privileged execution state, budgets, flags, and warm-cache surfaces. The compatibility-level tool list is kept in [TriChat Compatibility Reference](./docs/TRICHAT_COMPATIBILITY_REFERENCE.md).

The `/office/` GUI is served directly by the HTTP transport. Under normal polling it prefers cached office snapshots; explicit operator actions and forced refreshes are the only paths that demand live snapshot work.

The office scene keeps working agents at their desks, moves active chatter to the coffee and water cooler strip, shows resets in the lounge, and parks long-idle agents on the sofa in sleep mode. Action badges reflect real MCP/tmux signals such as desk work, briefing, chatting, break/reset, blocked, offline, and sleep.

Recent polish added:

- a stylized night-shift office banner with a built-in mascot and richer ASCII sprite poses
- animated per-agent states for desk work, supervision, chatter, break, blocked, offline, and sleep
- a `t` hotkey to cycle dashboard themes (`night`, `sunrise`, `mono`)
- a dedicated `intake` tmux window and `5` hotkey from the office dashboard so the war room can take objectives, not just monitor them
- confidence-check surfacing in the briefing board so ring-leader confidence is explainable, not just numeric

Install the single-click macOS app launcher in `/Applications`:

```bash
npm run trichat:app:install
```

By default the app opens the built-in `/office/` GUI and keeps the tmux-backed Agent Office substrate available underneath it. If you do not pass `--icon`, it generates its own built-in office mascot icon.

Install the umbrella launcher for the broader local suite:

```bash
npm run agentic:suite:app:install
```

That launcher brings up the Agent Office web surface and opens the local desktop tools listed in `AGENTIC_SUITE_OPEN_APPS` (defaults to `Codex,Cursor`).

Keyboard controls inside the TUI:

- `1` office
- `2` briefing
- `3` lanes
- `4` workers
- `h` help
- `r` refresh
- `p` pause
- `t` cycle theme
- `q` quit

Legacy command names, old app-installer naming, and compatibility branding notes now live in [TriChat Compatibility Reference](./docs/TRICHAT_COMPATIBILITY_REFERENCE.md).

## Borrowed Wins

The current office/autonomy environment intentionally borrows and reinterprets the strongest open-source ideas from:

- [RALPH TUI](https://github.com/subsy/ralph-tui): multi-pane operator UX, persistent dashboard feel, session-oriented monitoring, and a more playful terminal surface
- [Get Shit Done](https://github.com/gsd-build/get-shit-done): bounded work packets, single-owner delegation, and orchestration that stays simple while the system grows complex
- [autoresearch](https://github.com/karpathy/autoresearch): small-budget experiment loops, org-first task shaping, and disciplined overnight continuation
- [SuperClaude Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework): confidence-before-action methodology and explicit mode/check thinking before implementation

We also reviewed the DAN-prompt gist for stylistic inspiration only. Unsafe jailbreak behavior is intentionally excluded; the only acceptable lift is playful operator-facing mode naming, not guardrail bypassing.

Upstream coverage matrix: [Upstream Implementation Matrix](./docs/UPSTREAM_IMPLEMENTATION_MATRIX.md)

## Replication Bundle

When GitHub push access is unavailable, export a portable handoff bundle for a stronger server:

```bash
npm run replication:export
```

The export includes:

- a `git bundle` for the current branch and commit
- `.env.example`
- `config/trichat_agents.json`
- `bootstrap-server.sh`
- `replication-manifest.json`

On the target server:

```bash
./bootstrap-server.sh /path/to/target /path/to/MCPlayground---Core-Template-<timestamp>.bundle
```

## Configuration

Copy the template:

```bash
cp .env.example .env
```

Key variables:

- `ANAMNESIS_HUB_DB_PATH` local SQLite path
- `ANAMNESIS_HUB_RUN_QUICK_CHECK_ON_START` run SQLite quick integrity check at startup (`1` by default)
- `ANAMNESIS_HUB_STARTUP_BACKUP` create rotating startup snapshots (`1` by default)
- `ANAMNESIS_HUB_BACKUP_DIR` snapshot directory (default: sibling `backups/` near DB path)
- `ANAMNESIS_HUB_BACKUP_KEEP` retained snapshot count (default: `24`)
- `ANAMNESIS_HUB_AUTO_RESTORE_FROM_BACKUP` auto-restore latest snapshot on startup corruption (`1` by default)
- `ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION` allow empty DB bootstrap if no backup exists (`0` by default)
- `MCP_HTTP_BEARER_TOKEN` auth token for HTTP transport
- `MCP_HTTP_ALLOWED_ORIGINS` comma-separated local origins
- `MCP_DOMAIN_PACKS` comma-separated pack ids (`agentic`, etc.); defaults to `agentic`, set `none` to disable all packs
- `TRICHAT_AGENT_IDS` comma-separated active office council roster
- `TRICHAT_GEMINI_CMD` override full Gemini bridge command
- `TRICHAT_CLAUDE_CMD` override full Claude bridge command
- `TRICHAT_GEMINI_EXECUTABLE` / `TRICHAT_GEMINI_ARGS` provider CLI override
- `TRICHAT_CLAUDE_EXECUTABLE` / `TRICHAT_CLAUDE_ARGS` provider CLI override
- `TRICHAT_CODEX_EXECUTABLE` / `TRICHAT_CURSOR_EXECUTABLE` override the provider binary inside the wrapper
- `TRICHAT_GEMINI_MODE` select `auto`, `cli`, or `api`
- `TRICHAT_GEMINI_MODEL` override Gemini API model (`gemini-2.0-flash` default)
- `TRICHAT_IMPRINT_MODEL` / `TRICHAT_OLLAMA_URL` control the local imprint lane
- `TRICHAT_LOCAL_INFERENCE_PROVIDER` selects `auto`, `ollama`, or `mlx` for the local bridge lane
- `TRICHAT_MLX_PYTHON` / `TRICHAT_MLX_MODEL` / `TRICHAT_MLX_ENDPOINT` define the optional Metal-backed MLX lane
- `TRICHAT_MLX_ADAPTER_PATH` turns the managed MLX lane into an adapter-backed `mlx_lm.server`
- `TRICHAT_LOCAL_ADAPTER_REGISTRATION_PATH` / `TRICHAT_LOCAL_ADAPTER_ACTIVE_PROVIDER` record which accepted adapter is currently integrated and whether it is active through `mlx` or `ollama`
- `TRICHAT_LOCAL_ADAPTER_OLLAMA_MODEL` records the exported Ollama companion model name when the active integration target is `ollama`
- `TRICHAT_MLX_SERVER_ENABLED=1` enables a managed local `mlx_lm.server` launch agent; leave it `0` to keep MLX installed but not auto-served
- `TRICHAT_BRIDGE_TIMEOUT_SECONDS` bound per-bridge request time
- `TRICHAT_BRIDGE_MAX_RETRIES` / `TRICHAT_BRIDGE_RETRY_BASE_MS` control wrapper-level transient retry behavior
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` enable direct Gemini API fallback

The runtime now quarantines non-SQLite/corrupted artifacts into `corrupt/` before recovery attempts so startup failures do not silently overwrite evidence.

Local Metal setup:

- `npm run mlx:setup` creates `.venv-mlx`, installs `mlx` + `mlx-lm`, and writes the repo-local MLX env vars into `.env`
- the control plane now prefers the repo’s `.venv-mlx/bin/python` when probing MLX availability
- local bridges can use the MLX chat-completions endpoint when `TRICHAT_LOCAL_INFERENCE_PROVIDER=mlx` or `auto` with a healthy MLX endpoint
- On Apple Silicon, `npm run doctor` now reports whether the host is ready for Ollama's March 30, 2026 MLX preview path. The official Ollama post calls out `qwen3.5:35b-a3b-coding-nvfp4` on Ollama `0.19+` and recommends a Mac with more than 32 GB of unified memory.
- `npm run ollama:mlx:preview` is the guarded Apple Silicon-only setup path for that Ollama MLX preview model. It refuses to run on Linux or Windows, checks the Ollama runtime floor, and pulls `qwen3.5:35b-a3b-coding-nvfp4`. It does not cut the active local model over until the post-pull gate passes.
- After that pull completes, the same path automatically runs `scripts/ollama_mlx_postpull.mjs` to stress the local Ollama runtime, run the default local benchmark/eval gate, inspect router readiness plus rollback viability, and write a report under `data/imprint/reports/`. Only a fully green gate will cut the active local model over; otherwise the runner records the blockers and leaves the current default untouched. Re-run it manually with `npm run ollama:mlx:postpull`. The runner is single-instance per model, so duplicate manual starts now exit cleanly instead of piling up background waiters.
- `npm run local:training:bootstrap` reuses the repo’s `.venv-mlx` setup path and gives the adapter lane a real local trainer backend on Apple Silicon instead of leaving it in a permanent “missing module” state.
- `npm run local:training:prepare` + `npm run local:training:train` + `npm run local:training:promote` + `npm run local:training:integrate` + `npm run local:training:cutover` + `npm run local:training:soak` now form a truthful bounded training lane: prepare curates the packet, train runs an MLX LoRA pass against a trainable companion model, promote runs the repo's benchmark/eval gate so the adapter is either rejected or registered, integrate materializes the accepted candidate as a real MLX backend or an Ollama companion model, cutover is the explicit router-default switch with rollback if post-cutover verification fails, and soak keeps validating the new primary against the rollback path over repeated cycles.
- On this Apple Silicon host, the current Qwen companion adapter is served through MLX because `mlx_lm.server` supports `--adapter-path`. Ollama companion export remains a real path for supported adapter families, but Ollama's documented adapter import support is narrower than the MLX training surface, so not every accepted adapter will be exportable there.
- “Imprinting” here means durable local memory, profile preferences, and bootstrap context for the control plane. It is not pretending to silently fine-tune model weights.

## Core Tool Surface

Core runtime tools include:

- Memory and continuity: `memory.*` including `memory.reflection_capture` for externally grounded episodic reflections, `transcript.*`, `who_knows`, `knowledge.query`, `retrieval.hybrid`
- Governance and safety: `policy.evaluate`, `preflight.check`, `postflight.verify`, `mutation.check`
- Durable execution: `run.*`, `task.*`, `lock.*`
- Permanent regression capture: `golden.case_capture` turns research, incidents, and traces into verified golden cases that can seed future benchmark/eval fixtures.
- Agentic kernel: `goal.*` including `goal.execute`, `goal.autorun`, and `goal.autorun_daemon`, `kernel.summary`, `plan.*`, `artifact.*`, `experiment.*`, `event.*`, `agent.session.*`, `dispatch.autorun`
- Workflow methodology: `playbook.*` including `playbook.run`, `pack.hooks.list`, `pack.plan.generate`, `pack.verify.run`
- Decision and incident logging: `adr.create`, `decision.link`, `incident.*`
- Runtime ops: `health.*`, `migration.status`, `imprint.*`, `imprint.inbox.*`
- Office orchestration: `trichat.*` (`roster`, `thread/message/turn`, `autopilot`, `tmux_controller`, `bus`, `adapter_telemetry`, `chaos`, `slo`)
- Control-plane discovery and rollout: `tool.search`, `permission.profile`, `feature.flag`, `warm.cache`
- Budget and cost visibility: `budget.ledger`
- Local host control: `desktop.control`, `desktop.observe`, `desktop.act`, `desktop.listen`, `patient.zero`, `privileged.exec`

## Domain Pack Framework

Workflow/domain packs are loaded at startup from `MCP_DOMAIN_PACKS` or `--domain-packs`.

- Framework: `src/domain-packs/types.ts`, `src/domain-packs/index.ts`
- Default workflow pack: `src/domain-packs/agentic.ts`

Pack authoring guide: [Domain Packs](./docs/DOMAIN_PACKS.md)

## IDE and Agent Setup

Connection examples and client setup:

- [Documentation Index](./docs/README.md)
- [Quick Setup](./docs/SETUP.md)
- [IDE + Agent Setup Guide](./docs/IDE_AGENT_SETUP.md)
- [Transport Connection Guide](./docs/CONNECT.md)
- [Coworker Quickstart (Cursor + Codex)](./docs/COWORKER_QUICKSTART_CURSOR_CODEX.md)
- [Provider Bridge Matrix](./docs/PROVIDER_BRIDGE_MATRIX.md)
- [System Interconnects](./docs/SYSTEM_INTERCONNECTS.md)
- [Presentation Runbook](./docs/PRESENTATION_RUNBOOK.md)
- [Ring Leader MCP Ops](./docs/RING_LEADER_MCP_OPS.md)

Provider bridge commands:

```bash
npm run providers:status
npm run providers:export
npm run providers:install -- claude-cli cursor gemini-cli github-copilot-cli
```

`provider.bridge` is the truthful federation surface:

- it reports which clients can really connect into this MCP runtime
- it reports which providers are already available as live outbound council agents
- it projects runtime-eligible outbound providers into bridge-backed `model.router` backend candidates
- `autonomy.bootstrap` seeds those eligible bridge backends automatically without replacing the local default backend
- `autonomy.command`, `goal.execute`, and `plan.dispatch` use router output to augment local-first councils with relevant hosted agents instead of treating provider bridges as a separate side path
- it exports config bundles for Claude CLI, Cursor, Gemini CLI, GitHub Copilot, and Codex
- it installs Claude CLI through the native `claude mcp add` / `add-json` path instead of editing opaque hidden formats directly
- it installs both global and workspace-local Cursor MCP config for better editor reliability
- it defaults Claude CLI and Gemini CLI to a resilient stdio proxy on this host, using the MCP HTTP daemon first and a direct stdio fallback when needed
- it preserves `autonomy.ide_ingress` as the one canonical operator/IDE ingress path

Fast STDIO connection example:

```json
{
  "mcpServers": {
    "mcplayground-core-template": {
      "command": "node",
      "args": ["/absolute/path/to/MCPlayground---Core-Template/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/MCPlayground---Core-Template/data/hub.sqlite"
      }
    }
  }
}
```

Pure core / no-pack connection example:

```json
{
  "mcpServers": {
    "mcplayground-core-only": {
      "command": "node",
      "args": ["/absolute/path/to/MCPlayground---Core-Template/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/MCPlayground---Core-Template/data/hub.sqlite",
        "MCP_DOMAIN_PACKS": "none"
      }
    }
  }
}
```

## Agentic Fork Path

How to publish an agentic-development-focused fork from this template:

- [Agentic Fork Guide](./docs/AGENTIC_FORK_GUIDE.md)

## Validation

```bash
npm test
npm run mvp:smoke
npm run agentic:micro-soak
```

Local HTTP teammate validation:

```bash
npm run launchd:install
npm run it:http:validate
```

Office and council reliability checks:

```bash
npm run trichat:bridges:test
npm run trichat:doctor
npm run production:doctor
npm run autonomy:status
npm run autonomy:maintain
npm run trichat:smoke
npm run trichat:dogfood
npm run trichat:soak:gate -- --hours 1 --interval-seconds 60
```

Background upkeep is real, not advisory: launchd keepalive drives `autonomy.maintain`, which keeps the control plane ready, keeps `goal.autorun_daemon` alive, refreshes bounded learning visibility, maintains tmux worker lanes, and runs the default eval suite only when it is due.

Extended validation flows, tmux dry-run examples, legacy env vars, and older compatibility-named autopilot examples now live in [TriChat Compatibility Reference](./docs/TRICHAT_COMPATIBILITY_REFERENCE.md).

## Repository Layout

- `src/server.ts` core MCP runtime and tool registration
- `src/tools/` core reusable tools
- `src/domain-packs/` optional domain modules
- `bridges/` bridge adapters and client-facing helper lanes
- `config/` roster, bridge, and runtime configuration
- `scripts/` operational scripts and smoke checks
- `docs/` centralized human-facing docs, setup guides, and architecture diagrams
- `tests/` integration and persistence tests
- `data/` local runtime state and SQLite database
- `web/office/` browser-based Agent Office GUI
- `ui/` terminal-facing dashboard surfaces
