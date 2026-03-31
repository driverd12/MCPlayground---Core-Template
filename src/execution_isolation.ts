import crypto from "node:crypto";
import path from "node:path";

export type ExecutionIsolationMode = "git_worktree" | "copy" | "none";

export type IsolatedExecutionPlan = {
  isolation_mode: ExecutionIsolationMode;
  base_workspace: string;
  workspace: string;
  script: string;
};

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeTaskToken(value: string) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const fallbackOverlayScript = path.resolve(process.cwd(), "scripts/overlay_git_dirty.mjs");

export function buildIsolatedWorkspacePath(baseWorkspace: string, taskId: string) {
  const normalizedBase = baseWorkspace.replace(/\\/g, "/").replace(/\/+$/g, "");
  const parent = path.posix.dirname(normalizedBase);
  const baseName = path.posix.basename(normalizedBase) || "workspace";
  const root = path.posix.join(parent, ".mcp-isolation", baseName);
  const token = normalizeTaskToken(taskId) || crypto.randomUUID().slice(0, 10);
  return path.posix.join(root, token);
}

export function buildIsolatedExecutionPlan(input: {
  base_workspace: string;
  command: string;
  task_id: string;
  isolation_mode?: ExecutionIsolationMode | null;
  cleanup_workspace?: boolean;
}) : IsolatedExecutionPlan {
  const isolationMode: ExecutionIsolationMode =
    input.isolation_mode === "copy" || input.isolation_mode === "none" ? input.isolation_mode : "git_worktree";
  const baseWorkspace = path.resolve(input.base_workspace);
  const cleanupWorkspace = input.cleanup_workspace === true;
  if (isolationMode === "none") {
    return {
      isolation_mode: isolationMode,
      base_workspace: baseWorkspace,
      workspace: baseWorkspace,
      script: `cd ${shellQuote(baseWorkspace)} && /bin/sh -lc ${shellQuote(input.command)}`,
    };
  }

  const isolatedWorkspace = buildIsolatedWorkspacePath(baseWorkspace, input.task_id);
  const rootExpr =
    `ROOT=$(git -C "$BASE" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$BASE")`;
  const script = [
    "set -e",
    `BASE=${shellQuote(baseWorkspace)}`,
    `WORKSPACE=${shellQuote(isolatedWorkspace)}`,
    `MODE=${shellQuote(isolationMode)}`,
    `USER_CMD=${shellQuote(input.command)}`,
    `CLEANUP_WORKSPACE=${cleanupWorkspace ? "1" : "0"}`,
    `FALLBACK_OVERLAY_SCRIPT=${shellQuote(fallbackOverlayScript)}`,
    rootExpr,
    'cleanup_workspace(){ if [ "$CLEANUP_WORKSPACE" = "1" ] && [ "$WORKSPACE" != "$BASE" ] && [ -n "$WORKSPACE" ]; then rm -rf "$WORKSPACE"; fi; }',
    'trap cleanup_workspace EXIT INT TERM',
    'mkdir -p "$(dirname "$WORKSPACE")"',
    'rm -rf "$WORKSPACE"',
    'if [ "$MODE" = "git_worktree" ] && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -C "$ROOT" worktree add --detach "$WORKSPACE" HEAD >/dev/null 2>&1 || cp -R "$ROOT" "$WORKSPACE"; else cp -R "$ROOT" "$WORKSPACE"; fi',
    'if [ -d "$ROOT/node_modules" ] && [ ! -e "$WORKSPACE/node_modules" ]; then ln -s "$ROOT/node_modules" "$WORKSPACE/node_modules"; fi',
    'if [ -d "$ROOT/.venv" ] && [ ! -e "$WORKSPACE/.venv" ]; then ln -s "$ROOT/.venv" "$WORKSPACE/.venv"; fi',
    'if [ -d "$ROOT/dist" ] && [ ! -e "$WORKSPACE/dist" ]; then ln -s "$ROOT/dist" "$WORKSPACE/dist"; fi',
    'if [ "$MODE" = "git_worktree" ]; then if [ -f "$ROOT/scripts/overlay_git_dirty.mjs" ]; then node "$ROOT/scripts/overlay_git_dirty.mjs" "$ROOT" "$WORKSPACE" >/dev/null; elif [ -f "$FALLBACK_OVERLAY_SCRIPT" ]; then node "$FALLBACK_OVERLAY_SCRIPT" "$ROOT" "$WORKSPACE" >/dev/null; fi; fi',
    'cd "$WORKSPACE"',
    'export PATH="$WORKSPACE/node_modules/.bin:$WORKSPACE/.venv/bin:$PATH"',
    '/bin/sh -lc "$USER_CMD"',
  ].join("; ");

  return {
    isolation_mode: isolationMode,
    base_workspace: baseWorkspace,
    workspace: isolatedWorkspace,
    script,
  };
}

export function buildRemoteExecutionCommand(input: {
  ssh_destination: string;
  script: string;
}) {
  return `ssh ${shellQuote(input.ssh_destination)} /bin/sh -lc ${shellQuote(input.script)}`;
}
