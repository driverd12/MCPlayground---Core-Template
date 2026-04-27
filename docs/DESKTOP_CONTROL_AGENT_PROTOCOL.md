# Desktop Control Agent Protocol

MASTER MOLD includes a local macOS desktop-control lane so agents can observe and operate the active workstation when normal shell execution is stale, pointed at the wrong path, or insufficient for the task.

This is not a separate source of truth. Use it as an operator-visible control bridge, then write durable evidence back through MCP artifacts, run ledgers, tasks, memories, or decisions when the work matters.

## Tool Surface

Canonical MCP tool names:

- `desktop.control` - enable/disable desktop lanes, heartbeat capability state, and refresh host-control policy.
- `desktop.observe` - inspect frontmost app, clipboard, or screenshot state.
- `desktop.act` - open apps/URLs, set clipboard, type text, press keys, or paste commands.
- `desktop.listen` - optional microphone lane, disabled unless explicitly allowed.

Some clients expose these with namespace-expanded names, for example `mcp__mcplayground_core_template__desktop_control`, `mcp__mcplayground_core_template__desktop_observe`, and `mcp__mcplayground_core_template__desktop_act`.

## When To Use It

Use desktop control when:

- The normal shell channel cannot spawn commands or is stuck in a stale/missing working directory.
- You need to interact with the real Terminal, Cursor, Codex, browser, or another visible Mac app.
- You need proof of visible state through a frontmost-app probe, clipboard read, or screenshot.
- A local setup or authentication flow requires the operator's active desktop session.

Prefer direct shell execution when it is healthy. Desktop control is the fallback and host-control lane, not the default way to run every command.

## Activation Sequence

Before acting on the desktop:

1. Call `desktop.control` with `action="set"`, `enabled=true`, `allow_observe=true`, and `allow_act=true`.
2. Call `desktop.control` with `action="heartbeat"` to refresh capability probes.
3. Call `desktop.observe` with `action="frontmost_app"` to confirm the active app/window.
4. If Terminal is needed and not active, call `desktop.act` with `action="open_app"` and `app="Terminal"`.

Mutating desktop calls require mutation metadata with a stable `idempotency_key` and `side_effect_fingerprint`. Screenshot observations also require mutation metadata because they write an image artifact to disk.

## Reliable Terminal Command Pattern

For non-trivial commands, do not rely on `type_text`. Put the command on the clipboard, paste it into Terminal, and copy the captured result back to the clipboard.

```bash
(
set -u
cd /absolute/path/to/repo || exit 2

echo '=== preflight ==='
git status -sb

echo '=== work ==='
your_command_here

echo '=== final ==='
git status -sb
) > /tmp/master_mold_agent_task.txt 2>&1
rc=$?
printf '\nEXIT_STATUS=%s\n' "$rc" >> /tmp/master_mold_agent_task.txt
pbcopy < /tmp/master_mold_agent_task.txt
```

Then drive Terminal with:

1. `desktop.act` `{"action":"set_clipboard","text":"<full command>"}`
2. `desktop.act` `{"action":"key_press","key":"v","modifiers":["command"]}`
3. `desktop.act` `{"action":"key_press","key":"return"}`
4. `desktop.observe` `{"action":"clipboard","delay_ms":1000}` to inspect output

For long-running commands, poll `desktop.observe` with `action="clipboard"` every 5-10 seconds. The observe delay should stay at or below `10000` ms. If the clipboard is stale, use `desktop.observe` with `action="screenshot"` and inspect the saved image.

## Safe Repo Update Flow

When updating this repo through desktop control:

1. Run `git status -sb` first.
2. If the worktree is dirty, protect it with a named stash or backup branch before fetching.
3. Add or update the intended remote explicitly.
4. Fetch before merging.
5. Verify the exact target commit with `git cat-file -e <sha>^{commit}` and `git show --no-patch --oneline --decorate <sha>`.
6. Check ancestry with `git merge-base --is-ancestor`.
7. Prefer `git merge --ff-only <sha>` when possible.
8. Do not run destructive commands such as `git reset --hard` or `git checkout -- <path>` unless the operator explicitly approves.
9. Run the practical gate after updating: `npm ci`, `npm run build`, and a targeted smoke such as `npm run mvp:smoke`.

## Evidence Rules

- Treat visible Terminal output as transient until it is copied into `/tmp/...`, clipboard, an artifact, or a run/task result.
- Summarize meaningful desktop-control actions in the active run ledger or task result.
- If desktop control is unavailable, stale, or blocked by macOS permissions, report the blocker instead of pretending the action happened.
- Do not bypass credential prompts or OS consent dialogs. Let the operator complete them, then continue from observed state.
