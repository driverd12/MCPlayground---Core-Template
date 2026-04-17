# Agentic Fork Guide

This guide explains how to publish a dedicated agentic-development fork from the core template.

## Goal

Create a fork whose default posture is:

- local-first MCP runtime
- shared continuity across Cursor and Codex
- agentic planning, dispatch, verification, and experiment loops
- no domain-specific vertical tooling in the default server surface

## Step 1: Fork The Repo

```bash
git clone https://github.com/driverd12/SUPERPOWERS.git MCPlayground---Agentic-Server
cd MCPlayground---Agentic-Server
npm ci
npm run build
```

## Step 2: Keep The Default Workflow Pack

The repo now loads the `agentic` workflow pack by default when `MCP_DOMAIN_PACKS` is unset.

Normal startup:

```bash
npm run start:stdio
# or
npm run start:http
```

Pure core without workflow hooks:

```bash
npm run start:core
# or
npm run start:core:http
```

## Step 3: Lean On The Agentic Kernel

The default fork should emphasize:

- `goal.*`
- `plan.*`
- `artifact.*`
- `experiment.*`
- `event.*`
- `agent.session.*`
- `dispatch.autorun`
- `playbook.*`
- `pack.hooks.list`, `goal.plan_generate`, `pack.verify.run`

## Step 4: Keep Client Config Simple

For Cursor and Codex, prefer one shared server entry pointing at the same HTTP or STDIO runtime and the same SQLite database.

STDIO example:

```json
{
  "mcpServers": {
    "mcplayground-agentic": {
      "command": "node",
      "args": ["/absolute/path/to/MCPlayground---Agentic-Server/dist/server.js"],
      "env": {
        "ANAMNESIS_HUB_DB_PATH": "/absolute/path/to/MCPlayground---Agentic-Server/data/hub.sqlite"
      }
    }
  }
}
```

## Step 5: Validate The Runtime

```bash
npm test
npm run trichat:doctor
npm run trichat:smoke
```

From the MCP client, validate:

1. `health.tools`
2. `pack.hooks.list`
3. `goal.create`
4. `goal.plan_generate`
5. `dispatch.autorun`
6. `agent.session_open`
7. `experiment.create`

## Suggested Next Fork-Specific Work

- add more GSD-derived playbooks and delivery heuristics
- add more autoresearch-style experiment helpers and evidence parsers
- add adapter bridges so Cursor and Codex can claim and complete work from the same kernel
- add stronger verifier packs for specific internal workflows once the agentic base is stable
