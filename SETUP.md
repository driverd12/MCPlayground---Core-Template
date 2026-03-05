# MCPlayground CFD Analysis Server Setup

Fastest path to run locally.

## 1. Prerequisites

- Node.js `20.x` to `22.x`
- `git`

## 2. Clone

```bash
git clone <your-cfd-fork-url> MCPlayground---CFD-Server
cd MCPlayground---CFD-Server
```

## 3. Install and Build

```bash
npm ci
npm run build
```

## 4. Configure Environment

```bash
cp .env.example .env
```

Default pack mode in this fork is:

```bash
MCP_DOMAIN_PACKS=cfd
```

Core network settings:

```bash
ANAMNESIS_HUB_DB_PATH=./data/hub.sqlite
MCP_HTTP_BEARER_TOKEN=change-me
MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

## 5. Verify

```bash
npm test
```

## 6. Start Server

CFD STDIO (default):

```bash
npm run start:stdio
```

CFD HTTP (default):

```bash
npm run start:http
```

Core-only fallback:

```bash
npm run start:core
npm run start:core:http
```

## 7. Smoke Check

```bash
npm run mvp:smoke
```

## 8. Connect IDE/Agent

Point MCP client command to:

```bash
node /absolute/path/to/MCPlayground---CFD-Server/dist/server.js
```

For full client examples, see [docs/IDE_AGENT_SETUP.md](./docs/IDE_AGENT_SETUP.md).
