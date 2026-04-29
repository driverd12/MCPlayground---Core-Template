# MASTER MOLD Setup

Fastest path to run locally.

## What This Is

MASTER MOLD is a local toolbench for AI agents. Most users do not operate the MCP server directly day to day; they start the runtime once, then connect an AI client such as Codex, Claude, Cursor, Gemini, or another MCP-capable client. The client uses the MCP server as its shared toolbox, memory layer, office/status surface, and domain-scaffolding workspace.

The mental model is closer to a self-extending 3D printer than a finished static app: first bootstrap the base machine, then the AI agents use the MCP tools to "print" the remaining domain-specific scaffolding, bridges, and workflows needed for your project.

For Windows users: prefer the `npm run ...` commands in this guide. Do not manually type POSIX-style commands such as `MCP_HTTP=1 node ...`; that syntax works in bash/zsh but fails under Windows `cmd.exe` and many npm Windows shells.

## 1. Prerequisites

- Node.js `20.x` to `22.x`
- `python3` `3.9+`
- `git`

## 2. Clone

```bash
git clone https://github.com/driverd12/MASTER-MOLD.git
cd master-mold
```

## 3. Pin the Runtime

Repo-managed version pins:

- `.nvmrc`: Node `22.x`
- `package.json#packageManager`: npm `10.9.4`
- `.python-version`: Python baseline `3.12.0` with newer compatible `3.x` releases allowed by bootstrap checks
- `.tool-versions`: `asdf` / `mise` compatibility for Node and Python

## 4. Bootstrap the Environment

```bash
npm run bootstrap:env:install
```

This is the preferred first-run path. On supported macOS, Windows, Ubuntu, Rocky Linux, and Amazon Linux hosts it can install the pinned prerequisites before continuing with the normal repo bootstrap.

Manual bootstrap without installer:

```bash
npm run bootstrap:env
```

This will:

- install the pinned prerequisites first when you choose `bootstrap:env:install`
- verify the pinned Node, npm, and Python versions before continuing
- create `.env` from `.env.example` when needed
- create the office snapshot cache directories ahead of time
- run `npm ci` if dependencies are missing
- run `npm run build` if `dist/server.js` is missing
- finish with `npm run doctor`

If you jump straight to `npm ci` on an unsupported runtime, the repo now stops early with a direct remediation message instead of falling through into dependency noise. The preferred recovery path is still `npm run bootstrap:env:install`.

When `npm run doctor` finishes with `Result: ready`, the standard MCP runtime is usable. Any remaining recommendations are optional capability lanes, not core bootstrap failures.

Preview the platform install commands without executing them:

```bash
npm run bootstrap:install:plan
```

Check only:

```bash
npm run bootstrap:env:check
```

## 5. Configure Environment

```bash
cp .env.example .env
```

Minimal values:

```bash
ANAMNESIS_HUB_DB_PATH=./data/hub.sqlite
MCP_HTTP_BEARER_TOKEN=change-me
MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

Built-in domain packs:

```bash
# default: agentic
# optional minimal mode:
MCP_DOMAIN_PACKS=none
```

## 6. Verify

```bash
npm run doctor
npm run doctor:macos:authority   # macOS only; explicit Patient Zero authority audit
npm run doctor:chronicle          # macOS/Codex only; human Chronicle desktop-context freshness
npm run local:training:status
npm run local:training:bootstrap # Apple Silicon only; installs repo-local MLX trainer modules
npm test
```

## 7. Start Server

STDIO:

```bash
npm run start:stdio
```

HTTP:

```bash
npm run start:http
```

This script is cross-platform. It sets `MCP_HTTP=1` inside a Node wrapper so it works in PowerShell, `cmd.exe`, Git Bash, macOS, and Linux.

Peer federation sidecar:

```bash
npm run federation:onboard -- \
  --vault Employee \
  --host-id this-host \
  --peer http://Dans-MBP.local:8787
```

`federation:onboard` checks prerequisites, creates or reuses host identity, stores recovery material in 1Password when available, writes non-secret `.env` federation settings, requests remote access from the peer, runs the sidecar once, runs the federation doctor, and prints the next step. Run the same onboarding command on any approved peer and change `--peer` to the other approved MASTER-MOLD HTTP endpoints. This is a mesh/tendril stream: each host captures locally, signs `POST /federation/ingest`, and each receiving peer stores the compact context/event payload in its own runtime events. See [Federation Mesh](./FEDERATION_MESH.md) for the wire diagram and team bootstrap sequence.

Each local sidecar run also writes a bounded per-peer send ledger into `data/federation/<host-id>-sidecar-state.json`, which `npm run federation:doctor` uses to distinguish stale peer freshness from local publish failures or a sidecar that has not run yet. The doctor also reports local host-ID/key drift and whether the federation sidecar launchd agent is installed and loaded on macOS.

The federation bootstrap prefers 1Password CLI for recovery storage, but it can still bootstrap locally when `op` is not installed or not unlocked. In that fallback, it prints `one_password.status="unavailable"` and keeps the bearer token in `data/imprint/http_bearer_token` plus the Ed25519 identity under `~/.master-mold/identity`; use `--require-1password` if a team rollout should fail closed instead.

On macOS, install the same sidecar as a launchd agent after `MASTER_MOLD_FEDERATION_PEERS`, `MASTER_MOLD_HOST_ID`, and `MASTER_MOLD_IDENTITY_KEY_PATH` are set:

```bash
npm run federation:launchd:install
```

Useful operator follow-ups:

```bash
npm run federation:doctor -- --json
npm run federation:soak -- --peer http://Dans-MBP.local:8787 --iterations 3 --json
npm run federation:repair -- --action all --json
```

Agent Office also exposes Hosts/Federation controls for sidecar one-shot publish, launchd repair, doctor refresh, host approval retry, stale cache repair, missing build repair, HTTP repair, and provider config repair.

## 8. Smoke Check

```bash
npm run mvp:smoke
```

Against an already-running HTTP server:

```bash
node ./scripts/run_env.mjs MCP_SMOKE_TRANSPORT=http MCP_HTTP_BEARER_TOKEN=change-me -- node ./scripts/mvp_smoke.mjs
```

## 9. Launch Agent Office

Cross-platform office launcher:

```bash
npm run trichat:office:web
```

Status only:

```bash
npm run trichat:office:web:status
```

## 10. Launch Agentic Suite

Cross-platform suite launcher:

```bash
npm run agentic:suite
```

Status only:

```bash
npm run agentic:suite:status
```

## 11. Connect IDE/Agent

Point MCP client STDIO command to:

```bash
node /absolute/path/to/master-mold/dist/server.js
```

For full client examples, see [IDE + Agent Setup Guide](./IDE_AGENT_SETUP.md).

## Windows Notes

- Use PowerShell, Windows Terminal, Git Bash, or Cursor's integrated terminal. The recommended commands are the same: `npm run bootstrap:env`, `npm run build`, `npm run start:http`, and `npm run trichat:office:web`.
- `npm run start:http` is the Windows-safe way to start the shared HTTP runtime. Older docs or shell snippets that start with `MCP_HTTP=1` are bash/zsh syntax, not Windows npm syntax.
- If Python is installed as the Windows launcher (`py -3`) instead of `python3`, the repo-owned Node wrappers resolve that automatically for npm-driven Python tests and dashboard commands.
- Shell-backed maintenance commands such as `npm run providers:status` and `npm run autonomy:status` go through `scripts/run_sh.mjs`, which finds Git-for-Windows Bash or prints an explicit remediation instead of leaking `cmd.exe` syntax failures.
- Native tmux shell workflows are still Unix-oriented. On Windows, the browser office surface is the primary reassurance UI; use WSL only if you specifically need tmux lanes.

## Troubleshooting

- Build errors: run `npm ci` and `npm run build` again.
- Wrapper bootstrap stops: if `npm run providers:status` or `npm run autonomy:status` says Node MCP client dependencies or `dist/server.js` are missing, run `npm run bootstrap:env` from the repo root before retrying the status command.
- `MCP_HTTP is not recognized`: pull latest `main`, run `npm run bootstrap:env`, then use `npm run start:http` instead of manually typing `MCP_HTTP=1 node ...`.
- npm audit warnings after `npm ci`: pull latest `main` and rerun `npm ci`; the lockfile is kept patched for known transitive HTTP stack advisories when compatible fixes are available.
- Missing tools in client: restart client process and verify it points at `dist/server.js`.
- Missing agentic tools: confirm `MCP_DOMAIN_PACKS` is unset or includes `agentic`; `MCP_DOMAIN_PACKS=none` disables built-ins.
- Version mismatch on bootstrap: switch Node with `nvm use`, `asdf`, or `mise`; switch Python with `pyenv`, `asdf`, or your platform package manager, then rerun `npm run bootstrap:env`.
- macOS + Homebrew mismatch: `brew install npm` by itself can put you on the newest Node/npm pair, which may be outside this repo's supported range. Use `npm run bootstrap:env:install` or install `node@22`, reopen the terminal, and rerun the bootstrap.
- Automated first-run remediation: run `npm run bootstrap:env:install` to install the pinned runtime prerequisites for the current supported platform profile.
- Office GUI stutters or a browser reload hangs: run `npm run agents:off && npm run agents:on` to restart the launchd HTTP runner. The runner defaults office snapshot refreshes to a separate STDIO child process so cached GUI reads do not block `/health`, `/ready`, or other MCP client traffic. During a live office rally, use `/office/api/action-status` as the truth surface while intake/action work is still running; the GUI now pauses its periodic snapshot pulls during that window and resumes snapshot telemetry after the action settles.
- Launchd feels wedged after a reboot, login churn, or repo move: `npm run agents:on` now treats repo-bound LaunchAgents plists that still point at an old workspace path as stale, rewrites them before re-bootstrap, and `./scripts/agents_switch.sh status` plus `npm run production:doctor` now surface `*_plist_current=false` instead of treating those agents as healthy.
- Launchd keepalive misses the first restart window: the autonomy keepalive runner now exits with a temporary failure when the MCP HTTP lane is still coming up, and the generated LaunchAgent is configured to relaunch on unsuccessful exit instead of sleeping until the next `StartInterval`. Check `data/imprint/logs/autonomy-keepalive.out.log` if that retry loop keeps tripping.
- Launchd still looks wedged after a crash even though the plist paths are current: the HTTP runner, keepalive runner, and inbox-worker runner now validate lock ownership with process-incarnation metadata instead of PID alone, so stale lock directories from a crashed wrapper should self-clear on the next restart attempt. If a wedge survives that path, inspect `data/imprint/locks/` alongside the launchd logs.
- Office GUI vs Patient Zero browser lane: the `/office/` operator surface is a general visibility UI and should stay launchable whenever the MCP HTTP surface is healthy, even if Patient Zero browser automation is degraded. Treat those as separate signals.
- `mcp_tool_call` and office snapshots: `office.snapshot` now uses a shorter bounded timeout and falls back to the local office snapshot cache instead of hanging for a full minute when the direct stdio path is overloaded. When the last truthful cache is older than the normal stale window, the HTTP office route still serves it as explicitly expired state while a background refresh runs.
- `npm run production:doctor` is singleton-scoped now. If another readiness run is already active, the second invocation exits instead of stacking more long-lived probe processes on top of the first.
- `npm run production:doctor` also reaps orphan repo-owned `dist/server.js` workers before probing, so stale stdio children do not accumulate and distort the Office or readiness surfaces.
- Large SQLite startup strategy: once the hub DB grows past the small-startup thresholds, startup no longer silently skips integrity and backup work. It downgrades to a lightweight large-DB probe and writes a recoverable bundle snapshot of the main database plus any WAL/SHM artifacts.
- Apple Silicon Ollama MLX preview: the March 30, 2026 Ollama MLX announcement uses `qwen3.5:35b-a3b-coding-nvfp4` on Ollama `0.19+` and recommends more than 32 GB of unified memory. `npm run doctor` now reports whether the local Mac clears those gates before you spend time pulling the model.
- Apple Silicon-only setup path: run `npm run ollama:mlx:preview` after upgrading Ollama. The command refuses to run on Linux or Windows and only pulls the candidate model. It does not cut the router over immediately.
- After that pull completes, the repo automatically runs a post-pull soak and imprint cycle. It writes a capability report into `data/imprint/reports/`, updates imprint preferences, snapshots the result, and appends a distilled memory entry. Re-run that manually with `npm run ollama:mlx:postpull`. The runner is single-instance per model and only promotes the candidate into `.env` when the capability soak passes every required case.
- macOS authority audit: run `npm run doctor:macos:authority` before treating Patient Zero as full-authority-ready. It audits the active console session, Accessibility, Screen Recording, microphone/listen-lane consent, Full Disk Access visibility, and the `mcagent` root helper + secret provisioning path. Screen Recording proof now requires a real `desktop.observe` screenshot event (frontmost-app/clipboard probes no longer count as consent proof), and `patient.zero` now merges this audit into explicit `authority_blockers` (`macos_authority_*`) plus `macos_authority_audit_status` so full-control claims fail closed when macOS authority is unproven. `office.snapshot` now carries those blockers into `setup_diagnostics.patient_zero`, flags `fallback.patient_zero_authority_degraded`, and adds a remediation action pointing back to the doctor command. It does not bypass OS prompts; it makes them explicit and remediation-oriented.
- Chronicle desktop-context doctor: run `npm run doctor:chronicle` from a Codex desktop session when `desktop.context` or the federation sidecar reports stale or missing screen context; use `npm run doctor:chronicle:json` for machine-readable output. It checks the live recorder pid, current rolling frame directory, latest frame freshness, display count, pid path compatibility, and the next operator action without printing OCR text or screenshot content. The default freshness budget is 5 minutes because Chronicle can update sparsely on idle or multi-display Macs; pass `-- --max-freshness-seconds <n>` for stricter visual work. The probe accepts both current `codex_chronicle` and older `codex_tape_recorder` pid locations so remote Macs do not fail open or false-negative during app-version churn.
- Local adapter lane: run `npm run local:training:bootstrap` on Apple Silicon to install the repo-local MLX trainer backend into `.venv-mlx`, then run `npm run local:training:prepare` to curate a local plain-text corpus from imprint snapshots, transcript evidence, and local capability reports into `data/training/local_adapter_lane/`, plus a registry entry in `data/training/model_registry.json`. Follow that with `npm run local:training:train` to run a bounded MLX LoRA pass against the prepared packet and emit adapter artifacts plus `training_metrics.json`, then `npm run local:training:promote` to benchmark and either reject or register the trained adapter. Run `npm run local:training:integrate` to materialize an accepted adapter as a real MLX backend or an Ollama companion model, then `npm run local:training:cutover` if you want that reachable backend to become the router default, `npm run local:training:soak` to validate the new primary across repeated benchmark/route/eval cycles with deterministic rollback if reward regresses against the accepted or baseline contracts, and `npm run local:training:watchdog` to refresh that bounded proof automatically when the last green soak is missing, failed, or stale. `npm run local:training:verify` is the fail-closed verifier for that lane: it re-reads the registry, manifest, dataset splits, promotion proof, rollback metadata, and watchdog freshness from disk so operator surfaces do not rely on stale assumptions. On macOS, `npm run agents:on` now installs that watchdog as its own launchd agent so MLX primary confidence survives logout, reboot, and app restarts. On the current Apple Silicon Qwen path, integration prefers MLX serving because the adapter runtime is real and verified there. Cutover remains explicit, post-verified, and rollback-capable instead of optimistic.
- This remains an operator-visible knowledge/bootstrap path, not a hidden weight fine-tune. The durable state lives in the local MCP memory/imprint layer so other local agents can reuse it truthfully, and the new training lane only claims what it actually prepared.
