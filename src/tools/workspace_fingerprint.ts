import fs from "node:fs";
import path from "node:path";
import { Storage } from "../storage.js";

const FINGERPRINT_PREFIX = "Workspace fingerprint:";
const FINGERPRINT_KEYWORD = "workspace-fingerprint";
const RECENT_FINGERPRINT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOP_LEVEL_ENTRIES = 12;
const MAX_SCAN_DEPTH = 3;
const MAX_SCANNED_FILES = 200;
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".venv",
  "backups",
  "build",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "venv",
]);
const KNOWN_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "Cargo.toml",
  "Cargo.lock",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env",
  ".env.example",
  "Makefile",
  "README.md",
] as const;
const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".cjs", "JavaScript"],
  [".cts", "TypeScript"],
  [".go", "Go"],
  [".js", "JavaScript"],
  [".json", "JSON"],
  [".jsx", "JavaScript"],
  [".md", "Markdown"],
  [".mjs", "JavaScript"],
  [".py", "Python"],
  [".rs", "Rust"],
  [".sh", "Shell"],
  [".sql", "SQL"],
  [".toml", "TOML"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".yaml", "YAML"],
  [".yml", "YAML"],
]);
const LANGUAGE_BY_NAME = new Map<string, string>([
  ["Dockerfile", "Docker"],
  ["Jenkinsfile", "Groovy"],
  ["Makefile", "Make"],
]);

type WorkspaceFingerprintResult = {
  created: boolean;
  workspace: string;
  memory_id?: number;
  reason?: string;
};

export function ensureWorkspaceFingerprint(
  storage: Storage,
  workspacePath: string,
  input?: {
    source?: string;
  }
): WorkspaceFingerprintResult {
  try {
    const workspace = path.resolve(workspacePath || ".");
    if (!fs.existsSync(workspace)) {
      return { created: false, workspace, reason: "workspace-missing" };
    }
    const stat = fs.statSync(workspace);
    if (!stat.isDirectory()) {
      return { created: false, workspace, reason: "workspace-not-directory" };
    }

    const existing = storage
      .searchMemories({
        query: workspace,
        limit: 10,
      })
      .find((memory) => {
        if (!memory.content.startsWith(FINGERPRINT_PREFIX)) {
          return false;
        }
        if (!memory.content.includes(workspace)) {
          return false;
        }
        const createdAtMs = Date.parse(memory.created_at);
        if (!Number.isFinite(createdAtMs)) {
          return false;
        }
        return Date.now() - createdAtMs < RECENT_FINGERPRINT_WINDOW_MS;
      });

    if (existing) {
      return {
        created: false,
        workspace,
        memory_id: existing.id,
        reason: "recent-fingerprint-exists",
      };
    }

    const fingerprint = inspectWorkspace(workspace);
    const content = [
      `${FINGERPRINT_PREFIX} ${workspace}`,
      `Captured at: ${new Date().toISOString()}`,
      `Source: ${input?.source ?? "workspace"}`,
      `Workspace name: ${path.basename(workspace) || workspace}`,
      `Top-level directories: ${fingerprint.top_level_directories.join(", ") || "none"}`,
      `Top-level files: ${fingerprint.top_level_files.join(", ") || "none"}`,
      `Detected manifests: ${fingerprint.manifests.join(", ") || "none"}`,
      `Primary languages: ${fingerprint.primary_languages.join(", ") || "none"}`,
    ].join("\n");
    const keywords = dedupeKeywords([
      FINGERPRINT_KEYWORD,
      "workspace",
      path.basename(workspace),
      ...fingerprint.manifests,
      ...fingerprint.primary_languages,
    ]);
    const memory = storage.insertMemory({
      content,
      keywords,
    });
    return {
      created: true,
      workspace,
      memory_id: memory.id,
    };
  } catch {
    return {
      created: false,
      workspace: path.resolve(workspacePath || "."),
      reason: "fingerprint-capture-failed",
    };
  }
}

function inspectWorkspace(workspace: string) {
  const entries = fs.readdirSync(workspace, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const topLevelDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .slice(0, MAX_TOP_LEVEL_ENTRIES);
  const topLevelFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .slice(0, MAX_TOP_LEVEL_ENTRIES);
  const entryNames = new Set(entries.map((entry) => entry.name));
  const manifests = KNOWN_MANIFESTS.filter((name) => entryNames.has(name));
  const primaryLanguages = collectPrimaryLanguages(workspace);
  return {
    top_level_directories: topLevelDirectories,
    top_level_files: topLevelFiles,
    manifests,
    primary_languages: primaryLanguages,
  };
}

function collectPrimaryLanguages(workspace: string): string[] {
  const counts = new Map<string, number>();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: workspace, depth: 0 }];
  let scannedFiles = 0;

  while (queue.length > 0 && scannedFiles < MAX_SCANNED_FILES) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = safeReadDir(current.directory);
    for (const entry of entries) {
      if (scannedFiles >= MAX_SCANNED_FILES) {
        break;
      }
      const absolutePath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth + 1 <= MAX_SCAN_DEPTH && !SKIP_DIRS.has(entry.name)) {
          queue.push({ directory: absolutePath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scannedFiles += 1;
      const language = LANGUAGE_BY_NAME.get(entry.name) ?? LANGUAGE_BY_EXTENSION.get(path.extname(entry.name).toLowerCase());
      if (!language) {
        continue;
      }
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([language]) => language);
}

function safeReadDir(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function dedupeKeywords(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}
