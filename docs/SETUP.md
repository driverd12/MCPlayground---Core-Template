# MCPlayground Core Template Setup

Fastest path to run locally.

## What This Is

MCPlayground is a local toolbench for AI agents. Most users do not operate the MCP server directly day to day; they start the runtime once, then connect an AI client such as Codex, Claude, Cursor, Gemini, or another MCP-capable client. The client uses the MCP server as its shared toolbox, memory layer, office/status surface, and domain-scaffolding workspace.

The mental model is closer to a self-extending 3D printer than a finished static app: first bootstrap the base machine, then the AI agents use the MCP tools to "print" the remaining domain-specific scaffolding, bridges, and workflows needed for your project.

For Windows users: prefer the `npm run ...` commands in this guide. Do not manually type POSIX-style commands such as `MCP_HTTP=1 node ...`; that syntax works in bash/zsh but fails under Windows `cmd.exe` and many npm Windows shells.

## 1. Prerequisites

- Node.js `20.x` to `22.x`
- `python3` `3.9+`
- `git`

## 2. Clone

```bash
git clone https://github.com/driverd12/MCPlayground---Core-Template.git
cd MCPlayground---Core-Template
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
node /absolute/path/to/MCPlayground---Core-Template/dist/server.js
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
- Automated first-run remediation: run `npm run bootstrap:env:install` to install the pinned runtime prerequisites for the current supported platform profile.
- Office GUI stutters or a browser reload hangs: run `npm run agents:off && npm run agents:on` to restart the launchd HTTP runner. The runner defaults office snapshot refreshes to a separate STDIO child process so cached GUI reads do not block `/health`, `/ready`, or other MCP client traffic.
- Apple Silicon Ollama MLX preview: the March 30, 2026 Ollama MLX announcement uses `qwen3.5:35b-a3b-coding-nvfp4` on Ollama `0.19+` and recommends more than 32 GB of unified memory. `npm run doctor` now reports whether the local Mac clears those gates before you spend time pulling the model.
- Apple Silicon-only setup path: run `npm run ollama:mlx:preview` after upgrading Ollama. The command refuses to run on Linux or Windows and updates `.env` to prefer the pulled `qwen3.5:35b-a3b-coding-nvfp4` model for local Ollama routing.
- After that pull completes, the repo automatically runs a post-pull soak and imprint cycle. It writes a capability report into `data/imprint/reports/`, updates the default imprint profile to prefer the active local Ollama model, snapshots the result, and appends a distilled memory entry. Re-run that manually with `npm run ollama:mlx:postpull`.
- This is an operator-visible knowledge/bootstrap path, not a hidden weight fine-tune. The durable state lives in the local MCP memory/imprint layer so other local agents can reuse it truthfully.
