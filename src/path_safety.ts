import fs from "node:fs";
import path from "node:path";

const DB_ARTIFACT_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const COMMAND_BOUNDARY = String.raw`[\s"'` + "`" + String.raw`><|&();]`;
const MUTATING_COMMAND_PATTERN =
  /\b(rm|mv|cp|truncate|dd|tee|touch|install|sed\s+-i|perl\s+-i|python|python3|node|ruby|bash|sh|zsh|sqlite3)\b|(^|[^\w])(>|>>)(?!=)/i;

export type ProtectedDbCommandMatch = {
  matched: boolean;
  artifact_path: string | null;
  matched_alias: string | null;
  reason: string | null;
};

export function resolveHubDatabasePath(repoRoot = process.cwd()): string | null {
  const envValue = String(process.env.ANAMNESIS_HUB_DB_PATH ?? process.env.MCP_HUB_DB_PATH ?? "").trim();
  const raw = envValue || path.join(repoRoot, "data", "hub.sqlite");
  if (raw === ":memory:") {
    return null;
  }
  return path.resolve(raw);
}

export function resolveProtectedDbArtifactPaths(repoRoot = process.cwd()): string[] {
  const dbPath = resolveHubDatabasePath(repoRoot);
  if (!dbPath) {
    return [];
  }
  return DB_ARTIFACT_SUFFIXES.map((suffix) => path.resolve(`${dbPath}${suffix}`));
}

export function assertSafeWritePath(
  targetPath: string,
  input?: {
    repo_root?: string;
    operation?: string;
  }
): void {
  const repoRoot = input?.repo_root ? path.resolve(input.repo_root) : process.cwd();
  const resolvedTarget = normalizePath(targetPath);
  const protectedArtifacts = resolveProtectedDbArtifactPaths(repoRoot);
  for (const artifact of protectedArtifacts) {
    if (resolvedTarget === normalizePath(artifact)) {
      const operation = input?.operation ? String(input.operation).trim() : "filesystem write";
      throw new Error(`Blocked ${operation}: target path is protected database artifact (${artifact}).`);
    }
  }
}

export function commandReferencesProtectedDbArtifact(
  command: string,
  input?: {
    repo_root?: string;
    workspace?: string;
  }
): ProtectedDbCommandMatch {
  const repoRoot = input?.repo_root ? path.resolve(input.repo_root) : process.cwd();
  const workspace = input?.workspace ? path.resolve(input.workspace) : null;
  const artifacts = resolveProtectedDbArtifactPaths(repoRoot);
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return {
      matched: false,
      artifact_path: null,
      matched_alias: null,
      reason: null,
    };
  }

  for (const artifactPath of artifacts) {
    const aliases = buildArtifactAliases(artifactPath, repoRoot, workspace);
    for (const alias of aliases) {
      const boundary = new RegExp(`(?:^|${COMMAND_BOUNDARY})${escapeRegExp(alias)}(?=$|${COMMAND_BOUNDARY})`, "i");
      if (boundary.test(normalizedCommand)) {
        const mutating = isLikelyMutatingShellCommand(normalizedCommand);
        return {
          matched: mutating,
          artifact_path: artifactPath,
          matched_alias: alias,
          reason: mutating ? "mutating command references protected db artifact" : "protected db artifact referenced",
        };
      }
    }
  }

  // Defense-in-depth for default local-first layout even when command uses relative shortcuts.
  if (
    /\bdata\/hub\.sqlite(?:-(?:wal|shm|journal))?\b/i.test(normalizedCommand) &&
    isLikelyMutatingShellCommand(normalizedCommand)
  ) {
    return {
      matched: true,
      artifact_path: path.join(repoRoot, "data", "hub.sqlite"),
      matched_alias: "data/hub.sqlite",
      reason: "mutating command references default protected db artifact alias",
    };
  }

  return {
    matched: false,
    artifact_path: null,
    matched_alias: null,
    reason: null,
  };
}

export function isLikelyMutatingShellCommand(command: string): boolean {
  return MUTATING_COMMAND_PATTERN.test(String(command ?? ""));
}

function buildArtifactAliases(artifactPath: string, repoRoot: string, workspace: string | null): string[] {
  const aliases = new Set<string>();
  const normalizedAbsolute = normalizePath(artifactPath).toLowerCase();
  aliases.add(normalizedAbsolute);

  addRelativeAlias(aliases, artifactPath, repoRoot);
  if (workspace) {
    addRelativeAlias(aliases, artifactPath, workspace);
  }

  const base = path.basename(artifactPath).trim().toLowerCase();
  if (base) {
    aliases.add(base);
    aliases.add(`./${base}`);
  }

  return Array.from(aliases).filter(Boolean);
}

function addRelativeAlias(aliases: Set<string>, artifactPath: string, baseDir: string): void {
  const relative = path.relative(baseDir, artifactPath);
  if (!relative || relative.startsWith("..")) {
    return;
  }
  const normalizedRelative = relative.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
  aliases.add(normalizedRelative);
  aliases.add(`./${normalizedRelative}`);
}

function normalizeCommand(value: string): string {
  return String(value ?? "").replace(/\\/g, "/").trim().toLowerCase();
}

function normalizePath(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const resolved = path.resolve(trimmed);
  const real = resolveRealpathIfExists(resolved);
  const normalized = (real ?? resolved).replace(/\\/g, "/");
  return normalized.toLowerCase();
}

function resolveRealpathIfExists(candidate: string): string | null {
  try {
    if (fs.existsSync(candidate)) {
      return fs.realpathSync.native(candidate);
    }
  } catch {
    return null;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
