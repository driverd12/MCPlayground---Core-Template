# Claude CLI + Codex IDE Symbiosis

This repo now has a first-class control path for using Claude Code visibly in Terminal while also targeting Claude and Codex programmatically through the MASTER-MOLD MCP ingress layer.

Use this document as the handoff note for other threads. The capability exists. It is not hypothetical.

## What now exists

1. A visible Claude Code launcher for macOS Terminal.
2. Explicit agent-targeted MCP ingress for `claude`, `codex`, `cursor`, and `gemini`.
3. Agent Office intake controls that surface those explicit bridge targets in the GUI.
4. A shared path for routing targeted objectives into `autonomy.ide_ingress`.

## Primary operator paths

### 1. Launch visible Claude Code in Terminal

Use the repo wrapper:

```bash
npm run claude:terminal
```

Direct script form:

```bash
./scripts/claude_code_terminal_open.sh
```

One-shot visible prompt:

```bash
./scripts/claude_code_terminal_open.sh --prompt "Summarize the current MASTER-MOLD runtime state."
```

Prompt from file:

```bash
./scripts/claude_code_terminal_open.sh --prompt-file /absolute/path/to/prompt.txt
```

Print the exact Claude command without launching:

```bash
./scripts/claude_code_terminal_open.sh --print-command
```

What this wrapper does:

1. Loads repo environment via `scripts/export_dotenv_env.sh`.
2. Uses `TRICHAT_CLAUDE_EXECUTABLE` and `TRICHAT_CLAUDE_ARGS` when present.
3. Sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
4. Opens a visible macOS Terminal session so the operator can see Claude activity directly.

### 2. Target Claude and Codex through MCP ingress

Use the shell ingress with explicit agent selection:

```bash
./scripts/autonomy_ide_ingress.sh \
  --agent codex \
  --agent claude \
  -- "Help harden the MCP server and report runtime blockers."
```

Dry-run example:

```bash
./scripts/autonomy_ide_ingress.sh \
  --dry-run \
  --no-memory \
  --no-transcript \
  --agent codex \
  --agent claude \
  -- "Prepare an execution plan only."
```

What `--agent` does:

1. Builds explicit `trichat_agent_ids`.
2. Sends them into the `autonomy.ide_ingress` tool payload.
3. Avoids relying on implicit routing when the operator wants named bridges.

### 3. Use the same capability from Agent Office

The Agent Office intake desk now exposes a `Bridge targets` section.

Supported targets:

1. `codex`
2. `claude`
3. `cursor`
4. `gemini`

Selecting targets in the UI causes the intake request to send `trichat_agent_ids`, which the HTTP transport forwards into the same `autonomy.ide_ingress` shell path used above.

## HTTP/MCP shape

`POST /office/api/intake` now accepts either:

1. `trichat_agent_ids`
2. `agent_ids`

Example payload:

```json
{
  "summary": "Help Codex improve MCP reliability",
  "objective": "Investigate launchd recovery, model router freshness, and visible Claude/Codex coordination",
  "priority": "critical",
  "trichat_agent_ids": ["codex", "claude"],
  "dry_run": false
}
```

Expected transport behavior:

1. HTTP receives `trichat_agent_ids` or `agent_ids`.
2. `src/transports/http.ts` maps them to repeatable `--agent` arguments.
3. `scripts/autonomy_ide_ingress.sh` forwards them to `autonomy.ide_ingress`.
4. The control plane sees an explicitly targeted ingress request.

## Files that implement this capability

Visible Claude launcher:

1. `scripts/claude_code_terminal_open.sh`
2. `package.json`

Explicit targeted ingress:

1. `scripts/autonomy_ide_ingress.sh`
2. `src/transports/http.ts`

Office GUI controls:

1. `web/office/app.js`
2. `web/office/styles.css`

## What is proven vs. what still depends on runtime health

### Proven

1. The visible Claude launcher can open a Terminal session and execute Claude Code from the repo.
2. Explicit `--agent` targeting is implemented in the shell ingress.
3. The HTTP intake path accepts and forwards explicit target agent ids.
4. The Office UI exposes the new targeting controls.

### Runtime prerequisites

For full end-to-end intake execution, the following must be healthy:

1. The MASTER-MOLD office listener on `127.0.0.1:8787`
2. The launchd-managed MCP stack
3. A self-start-ready control plane
4. A fresh local model router/backend state

### Current operational caveat

If ingress fails with a message similar to:

```text
autonomy.command requires a self-start-ready control plane before intake can proceed
```

or references:

```text
repairs_needed=model.router.local_backend_stale
```

then the targeting feature is present, but the runtime is not healthy enough to execute the intake request yet.

This is a control-plane readiness issue, not a missing feature issue.

## Recommended operator workflow

When the goal is visible Claude + Codex coordination:

1. Start the managed stack and confirm the office listener is up.
2. Open a visible Claude terminal with `npm run claude:terminal`.
3. Use Agent Office `Bridge targets` or `./scripts/autonomy_ide_ingress.sh --agent ...` to target `codex` and `claude`.
4. Watch the visible Claude terminal for Claude-side activity.
5. Use the office snapshot and transport logs to confirm ingress/dispatch behavior.

## Guidance for other threads

Other threads should assume:

1. Visible Claude Code launching is a supported repo capability.
2. Explicit Claude/Codex targeting through the MCP/office ingress layer is supported.
3. The correct extension points are the files listed above.
4. If behavior is missing, investigate runtime health first before re-implementing the feature.
