# MCPlayground Core Template Setup

Fastest path to run locally.

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

## 8. Smoke Check

```bash
npm run mvp:smoke
```

Against an already-running HTTP server:

```bash
MCP_SMOKE_TRANSPORT=http MCP_HTTP_BEARER_TOKEN=change-me ./scripts/mvp_smoke.sh
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

## Troubleshooting

- Build errors: run `npm ci` and `npm run build` again.
- Wrapper bootstrap stops: if `npm run providers:status` or `npm run autonomy:status` says Node MCP client dependencies or `dist/server.js` are missing, run `npm run bootstrap:env` from the repo root before retrying the status command.
- Missing tools in client: restart client process and verify it points at `dist/server.js`.
- Missing agentic tools: confirm `MCP_DOMAIN_PACKS` is unset or includes `agentic`; `MCP_DOMAIN_PACKS=none` disables built-ins.
- Version mismatch on bootstrap: switch Node with `nvm use`, `asdf`, or `mise`; switch Python with `pyenv`, `asdf`, or your platform package manager, then rerun `npm run bootstrap:env`.
- Automated first-run remediation: run `npm run bootstrap:env:install` to install the pinned runtime prerequisites for the current supported platform profile.
- Office GUI stutters or a browser reload hangs: run `npm run agents:off && npm run agents:on` to restart the launchd HTTP runner. The runner defaults office snapshot refreshes to a separate STDIO child process so cached GUI reads do not block `/health`, `/ready`, or other MCP client traffic.
