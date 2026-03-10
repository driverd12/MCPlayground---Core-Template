import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mutationSchema } from "./mutation.js";
import { assertSafeWritePath } from "../path_safety.js";

export const inboxEnqueueSchema = z.object({
  mutation: mutationSchema,
  objective: z.string().min(1),
  project_dir: z.string().optional(),
  model: z.string().optional(),
  max_steps: z.number().int().min(1).max(100).optional(),
  command_timeout: z.number().int().min(10).max(3600).optional(),
  dry_run: z.boolean().optional(),
  no_auto_pull_model: z.boolean().optional(),
  imprint_profile_id: z.string().min(1).optional(),
  mcp_transport: z.enum(["stdio", "http"]).optional(),
  mcp_url: z.string().optional(),
  mcp_origin: z.string().optional(),
  mcp_stdio_command: z.string().optional(),
  mcp_stdio_args: z.string().optional(),
  source: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const inboxListSchema = z.object({
  status: z.enum(["pending", "processing", "done", "failed"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export function inboxEnqueue(repoRoot: string, input: z.infer<typeof inboxEnqueueSchema>) {
  const dirs = ensureInboxDirs(repoRoot);
  const now = new Date().toISOString();
  const taskId = `${now.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const fileName = `${taskId}.json`;
  const filePath = path.join(dirs.pending, fileName);

  const payload = {
    task_id: taskId,
    objective: input.objective,
    project_dir: input.project_dir,
    model: input.model,
    max_steps: input.max_steps,
    command_timeout: input.command_timeout,
    dry_run: input.dry_run,
    no_auto_pull_model: input.no_auto_pull_model,
    imprint_profile_id: input.imprint_profile_id,
    mcp_transport: input.mcp_transport,
    mcp_url: input.mcp_url,
    mcp_origin: input.mcp_origin,
    mcp_stdio_command: input.mcp_stdio_command,
    mcp_stdio_args: input.mcp_stdio_args,
    source: input.source ?? "imprint.inbox.enqueue",
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    tags: input.tags,
    metadata: input.metadata,
    created_at: now,
  };

  assertSafeWritePath(filePath, {
    repo_root: repoRoot,
    operation: "imprint inbox enqueue write",
  });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    ok: true,
    status: "pending",
    task_id: taskId,
    path: filePath,
    created_at: now,
  };
}

export function inboxList(repoRoot: string, input: z.infer<typeof inboxListSchema>) {
  const dirs = ensureInboxDirs(repoRoot);
  const statuses = input.status ? [input.status] : (["pending", "processing", "done", "failed"] as const);
  const limit = input.limit ?? 100;

  const items: Array<{
    status: string;
    task_id: string;
    file_name: string;
    path: string;
    updated_at: string;
    size_bytes: number;
    objective?: string;
    project_dir?: string;
    source?: string;
  }> = [];

  for (const status of statuses) {
    const directory = dirs[status];
    const pattern = status === "done" || status === "failed" ? /\.task\.json$/ : /\.json$/;
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => {
        const absolutePath = path.join(directory, entry.name);
        const stat = fs.statSync(absolutePath);
        return {
          status,
          file_name: entry.name,
          path: absolutePath,
          mtime_ms: stat.mtimeMs,
          updated_at: new Date(stat.mtimeMs).toISOString(),
          size_bytes: stat.size,
        };
      })
      .sort((a, b) => b.mtime_ms - a.mtime_ms);

    for (const entry of entries) {
      const taskId = inferTaskId(entry.file_name);
      const payload = safeReadJson(entry.path);
      const objective = typeof payload?.objective === "string" ? payload.objective : undefined;
      const projectDir = typeof payload?.project_dir === "string" ? payload.project_dir : undefined;
      const source = typeof payload?.source === "string" ? payload.source : undefined;
      items.push({
        status: entry.status,
        task_id: taskId,
        file_name: entry.file_name,
        path: entry.path,
        updated_at: entry.updated_at,
        size_bytes: entry.size_bytes,
        objective,
        project_dir: projectDir,
        source,
      });
      if (items.length >= limit) {
        break;
      }
    }
    if (items.length >= limit) {
      break;
    }
  }

  return {
    status_filter: input.status ?? null,
    count: items.length,
    tasks: items,
  };
}

function ensureInboxDirs(repoRoot: string) {
  const root = path.resolve(repoRoot, "data", "imprint", "inbox");
  const dirs = {
    root,
    pending: path.join(root, "pending"),
    processing: path.join(root, "processing"),
    done: path.join(root, "done"),
    failed: path.join(root, "failed"),
  };
  fs.mkdirSync(dirs.pending, { recursive: true });
  fs.mkdirSync(dirs.processing, { recursive: true });
  fs.mkdirSync(dirs.done, { recursive: true });
  fs.mkdirSync(dirs.failed, { recursive: true });
  return dirs;
}

function inferTaskId(fileName: string): string {
  if (fileName.endsWith(".task.json")) {
    return fileName.slice(0, -".task.json".length);
  }
  if (fileName.endsWith(".json")) {
    return fileName.slice(0, -".json".length);
  }
  return fileName;
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
