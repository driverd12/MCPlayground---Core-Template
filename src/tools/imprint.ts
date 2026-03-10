import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Storage, ImprintAutoSnapshotStateRecord } from "../storage.js";
import { assertSafeWritePath } from "../path_safety.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

type ImprintRuntimeOptions = {
  repo_root: string;
  server_name: string;
  server_version: string;
  get_tool_names: () => string[];
};

type AutoSnapshotConfig = {
  profile_id?: string;
  interval_seconds: number;
  include_recent_memories: number;
  include_recent_transcript_lines: number;
  write_file: boolean;
  promote_summary: boolean;
};

type AutoSnapshotTickResult = {
  completed_at: string;
  ok: boolean;
  snapshot_id?: string;
  snapshot_path?: string;
  memory_id?: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
};

const DEFAULT_PROFILE_ID = "default";
const DEFAULT_AUTO_SNAPSHOT_CONFIG: AutoSnapshotConfig = {
  interval_seconds: 900,
  include_recent_memories: 20,
  include_recent_transcript_lines: 40,
  write_file: true,
  promote_summary: false,
};

const autoSnapshotRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  in_tick: boolean;
  config: AutoSnapshotConfig;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  snapshots_created: number;
  memories_promoted: number;
} = {
  running: false,
  timer: null,
  in_tick: false,
  config: { ...DEFAULT_AUTO_SNAPSHOT_CONFIG },
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  snapshots_created: 0,
  memories_promoted: 0,
};

export const imprintProfileSetSchema = z.object({
  mutation: mutationSchema,
  profile_id: z.string().min(1).default(DEFAULT_PROFILE_ID),
  title: z.string().min(1),
  mission: z.string().min(1),
  principles: z.array(z.string().min(1)).min(1).max(50),
  hard_constraints: z.array(z.string().min(1)).max(50).optional(),
  preferred_models: z.array(z.string().min(1)).max(50).optional(),
  project_roots: z.array(z.string().min(1)).max(100).optional(),
  notes: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const imprintProfileGetSchema = z.object({
  profile_id: z.string().min(1).optional(),
});

export const imprintSnapshotSchema = z.object({
  mutation: mutationSchema,
  profile_id: z.string().min(1).optional(),
  summary: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  include_recent_memories: z.number().int().min(0).max(200).optional(),
  include_recent_transcript_lines: z.number().int().min(0).max(1000).optional(),
  write_file: z.boolean().optional(),
  promote_summary: z.boolean().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const imprintBootstrapSchema = z.object({
  profile_id: z.string().min(1).optional(),
  max_memories: z.number().int().min(1).max(200).optional(),
  max_transcript_lines: z.number().int().min(1).max(1000).optional(),
  include_squished_lines: z.boolean().optional(),
  max_snapshots: z.number().int().min(1).max(100).optional(),
});

export const imprintAutoSnapshotSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    profile_id: z.string().min(1).optional(),
    interval_seconds: z.number().int().min(30).max(86400).optional(),
    include_recent_memories: z.number().int().min(0).max(200).optional(),
    include_recent_transcript_lines: z.number().int().min(0).max(1000).optional(),
    write_file: z.boolean().optional(),
    promote_summary: z.boolean().optional(),
    run_immediately: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, and run_once actions",
        path: ["mutation"],
      });
    }
  });

export function initializeImprintAutoSnapshotDaemon(storage: Storage, options: ImprintRuntimeOptions) {
  const persisted = storage.getImprintAutoSnapshotState();
  if (!persisted) {
    autoSnapshotRuntime.config = { ...DEFAULT_AUTO_SNAPSHOT_CONFIG };
    stopAutoSnapshotDaemon();
    return {
      restored: false,
      running: false,
      config: { ...autoSnapshotRuntime.config },
    };
  }

  autoSnapshotRuntime.config = resolveAutoSnapshotConfig(persisted, DEFAULT_AUTO_SNAPSHOT_CONFIG);
  if (persisted.enabled) {
    startAutoSnapshotDaemon(storage, options);
  } else {
    stopAutoSnapshotDaemon();
  }

  return {
    restored: true,
    running: autoSnapshotRuntime.running,
    config: { ...autoSnapshotRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function imprintProfileSet(
  storage: Storage,
  input: z.infer<typeof imprintProfileSetSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "imprint.profile_set",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const upserted = storage.upsertImprintProfile({
        profile_id: input.profile_id,
        title: input.title,
        mission: input.mission,
        principles: input.principles,
        hard_constraints: input.hard_constraints,
        preferred_models: input.preferred_models,
        project_roots: input.project_roots,
        notes: input.notes,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const profile = storage.getImprintProfile(upserted.profile_id);
      return {
        ok: true,
        profile_id: upserted.profile_id,
        created: upserted.created,
        created_at: upserted.created_at,
        updated_at: upserted.updated_at,
        profile,
      };
    },
  });
}

export function imprintProfileGet(
  storage: Storage,
  input: z.infer<typeof imprintProfileGetSchema>
) {
  const profileId = input.profile_id ?? DEFAULT_PROFILE_ID;
  const profile = storage.getImprintProfile(profileId);
  return {
    found: Boolean(profile),
    profile_id: profileId,
    profile,
  };
}

export function imprintSnapshot(
  storage: Storage,
  input: z.infer<typeof imprintSnapshotSchema>,
  options: ImprintRuntimeOptions
) {
  return runIdempotentMutation({
    storage,
    tool_name: "imprint.snapshot",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      captureImprintSnapshot(storage, {
        profile_id: input.profile_id,
        summary: input.summary,
        tags: input.tags,
        include_recent_memories: input.include_recent_memories ?? 20,
        include_recent_transcript_lines: input.include_recent_transcript_lines ?? 40,
        write_file: input.write_file ?? true,
        promote_summary: input.promote_summary ?? true,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }, options),
  });
}

export function imprintBootstrap(
  storage: Storage,
  input: z.infer<typeof imprintBootstrapSchema>,
  options: ImprintRuntimeOptions
) {
  const profileId = input.profile_id ?? DEFAULT_PROFILE_ID;
  const profile = storage.getImprintProfile(profileId);
  const recentMemories = storage.listRecentMemories(input.max_memories ?? 25);
  const recentTranscriptLines = storage.listRecentTranscriptLines({
    limit: input.max_transcript_lines ?? 50,
    include_squished: input.include_squished_lines ?? false,
  });
  const snapshots = storage.listImprintSnapshots({
    limit: input.max_snapshots ?? 5,
    profile_id: profileId,
  });
  const pendingRuns = storage.listTranscriptRunsWithPending(20);
  const tableCounts = storage.getTableCounts();
  const toolNames = options.get_tool_names().slice().sort();

  const lines: string[] = [];
  lines.push("MCPlayground Imprint Bootstrap");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Server: ${options.server_name}@${options.server_version}`);
  lines.push(`Repository: ${options.repo_root}`);
  lines.push(`Database: ${storage.getDatabasePath()}`);
  lines.push(`Schema version: ${storage.getSchemaVersion()}`);
  lines.push(`Tool count: ${toolNames.length}`);
  lines.push("");

  lines.push("Mission Profile:");
  if (!profile) {
    lines.push(`- Missing profile '${profileId}'. Create one with imprint.profile_set.`);
  } else {
    lines.push(`- Profile id: ${profile.profile_id}`);
    lines.push(`- Title: ${profile.title}`);
    lines.push(`- Mission: ${profile.mission}`);
    lines.push("- Principles:");
    for (const principle of profile.principles) {
      lines.push(`  - ${principle}`);
    }
    if (profile.hard_constraints.length > 0) {
      lines.push("- Hard constraints:");
      for (const constraint of profile.hard_constraints) {
        lines.push(`  - ${constraint}`);
      }
    }
    if (profile.project_roots.length > 0) {
      lines.push("- Project roots:");
      for (const root of profile.project_roots) {
        lines.push(`  - ${root}`);
      }
    }
  }
  lines.push("");

  lines.push("Pending Transcript Runs:");
  if (pendingRuns.length === 0) {
    lines.push("- none");
  } else {
    for (const run of pendingRuns.slice(0, 20)) {
      lines.push(`- ${run.run_id}: unsquished=${run.unsquished_count} last=${run.last_timestamp}`);
    }
  }
  lines.push("");

  lines.push("Recent Distilled Memories:");
  if (recentMemories.length === 0) {
    lines.push("- none");
  } else {
    for (const memory of recentMemories) {
      lines.push(
        `- [${memory.id}] ${memory.created_at} keywords=${memory.keywords.join(", ") || "none"} :: ${compact(memory.content, 220)}`
      );
    }
  }
  lines.push("");

  lines.push("Recent Working-Memory Transcript Lines:");
  if (recentTranscriptLines.length === 0) {
    lines.push("- none");
  } else {
    for (const line of recentTranscriptLines) {
      lines.push(
        `- [${line.id}] run=${line.run_id ?? "none"} role=${line.role ?? "unknown"} squished=${line.is_squished} :: ${compact(line.content, 220)}`
      );
    }
  }
  lines.push("");

  lines.push("Latest Imprint Snapshots:");
  if (snapshots.length === 0) {
    lines.push("- none");
  } else {
    for (const snapshot of snapshots) {
      lines.push(
        `- [${snapshot.id}] ${snapshot.created_at} summary=${snapshot.summary ?? ""} path=${snapshot.snapshot_path ?? "n/a"}`
      );
    }
  }

  return {
    generated_at: new Date().toISOString(),
    profile_id: profileId,
    profile_found: Boolean(profile),
    counts: {
      tools: toolNames.length,
      pending_runs: pendingRuns.length,
      recent_memories: recentMemories.length,
      recent_transcript_lines: recentTranscriptLines.length,
      snapshots: snapshots.length,
      imprint_snapshot_total: storage.countImprintSnapshots(profileId),
      memories_total: tableCounts.memories ?? 0,
      transcript_lines_total: tableCounts.transcript_lines ?? 0,
    },
    bootstrap_text: lines.join("\n"),
  };
}

export function imprintAutoSnapshotControl(
  storage: Storage,
  input: z.infer<typeof imprintAutoSnapshotSchema>,
  options: ImprintRuntimeOptions
) {
  if (input.action === "status") {
    return getAutoSnapshotStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "imprint.auto_snapshot",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = autoSnapshotRuntime.running;
        autoSnapshotRuntime.config = resolveAutoSnapshotConfig(input, autoSnapshotRuntime.config);
        startAutoSnapshotDaemon(storage, options);
        let initialTick: AutoSnapshotTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runAutoSnapshotTick(storage, options, autoSnapshotRuntime.config);
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...autoSnapshotRuntime.config },
          persisted: storage.setImprintAutoSnapshotState({
            enabled: true,
            profile_id: autoSnapshotRuntime.config.profile_id,
            interval_seconds: autoSnapshotRuntime.config.interval_seconds,
            include_recent_memories: autoSnapshotRuntime.config.include_recent_memories,
            include_recent_transcript_lines: autoSnapshotRuntime.config.include_recent_transcript_lines,
            write_file: autoSnapshotRuntime.config.write_file,
            promote_summary: autoSnapshotRuntime.config.promote_summary,
          }),
          initial_tick: initialTick,
          status: getAutoSnapshotStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = autoSnapshotRuntime.running;
        stopAutoSnapshotDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setImprintAutoSnapshotState({
            enabled: false,
            profile_id: autoSnapshotRuntime.config.profile_id,
            interval_seconds: autoSnapshotRuntime.config.interval_seconds,
            include_recent_memories: autoSnapshotRuntime.config.include_recent_memories,
            include_recent_transcript_lines: autoSnapshotRuntime.config.include_recent_transcript_lines,
            write_file: autoSnapshotRuntime.config.write_file,
            promote_summary: autoSnapshotRuntime.config.promote_summary,
          }),
          status: getAutoSnapshotStatus(),
        };
      }

      const config = resolveAutoSnapshotConfig(input, autoSnapshotRuntime.config);
      const tick = runAutoSnapshotTick(storage, options, config);
      return {
        running: autoSnapshotRuntime.running,
        tick,
        status: getAutoSnapshotStatus(),
      };
    },
  });
}

function captureImprintSnapshot(
  storage: Storage,
  input: {
    profile_id?: string;
    summary?: string;
    tags?: string[];
    include_recent_memories: number;
    include_recent_transcript_lines: number;
    write_file: boolean;
    promote_summary: boolean;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  },
  options: ImprintRuntimeOptions
) {
  const now = new Date().toISOString();
  const profileId = input.profile_id?.trim() || DEFAULT_PROFILE_ID;
  const profile = storage.getImprintProfile(profileId);
  const toolNames = options.get_tool_names().slice().sort();
  const recentMemories = storage.listRecentMemories(input.include_recent_memories);
  const recentTranscriptLines = storage.listRecentTranscriptLines({
    limit: input.include_recent_transcript_lines,
    include_squished: true,
  });
  const pendingRuns = storage.listTranscriptRunsWithPending(50);

  const state: Record<string, unknown> = {
    captured_at: now,
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    },
    runtime: {
      pid: process.pid,
      node_version: process.version,
      cwd: process.cwd(),
      uptime_seconds: Math.round(process.uptime()),
    },
    server: {
      name: options.server_name,
      version: options.server_version,
      repo_root: options.repo_root,
      tool_count: toolNames.length,
      tools: toolNames,
    },
    storage: {
      db_path: storage.getDatabasePath(),
      schema_version: storage.getSchemaVersion(),
      migration_status: storage.getMigrationStatus(),
      table_counts: storage.getTableCounts(),
    },
    profile,
    pending_runs: pendingRuns,
    recent_memories: recentMemories.map((memory) => ({
      id: memory.id,
      created_at: memory.created_at,
      last_accessed_at: memory.last_accessed_at,
      keywords: memory.keywords,
      decay_score: memory.decay_score,
      content_preview: compact(memory.content, 360),
    })),
    recent_transcript_lines: recentTranscriptLines.map((line) => ({
      id: line.id,
      run_id: line.run_id,
      role: line.role,
      timestamp: line.timestamp,
      is_squished: line.is_squished,
      content_preview: compact(line.content, 360),
    })),
  };

  const snapshotId = randomUUID();
  const summary =
    input.summary?.trim() ||
    `Imprint snapshot: profile=${profileId} pending_runs=${pendingRuns.length} memories=${recentMemories.length} lines=${recentTranscriptLines.length}`;

  let snapshotPath: string | undefined;
  if (input.write_file) {
    const dir = path.join(options.repo_root, "data", "imprint", "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const safeTimestamp = now.replace(/[:.]/g, "-");
    snapshotPath = path.join(dir, `${safeTimestamp}-${snapshotId}.json`);
    assertSafeWritePath(snapshotPath, {
      repo_root: options.repo_root,
      operation: "imprint snapshot write",
    });
    fs.writeFileSync(snapshotPath, JSON.stringify(state, null, 2), "utf8");
  }

  let memoryId: number | undefined;
  if (input.promote_summary) {
    const summaryMemory = storage.insertMemory({
      content: [
        `Imprint snapshot ${snapshotId}`,
        `Captured: ${now}`,
        `Profile: ${profileId}${profile ? ` (${profile.title})` : " (missing profile)"}`,
        `Summary: ${summary}`,
        `Tool count: ${toolNames.length}`,
        `Pending transcript runs: ${pendingRuns.length}`,
        `Recent memories included: ${recentMemories.length}`,
        `Recent transcript lines included: ${recentTranscriptLines.length}`,
      ].join("\n"),
      keywords: dedupeKeywords(["imprint", "snapshot", "continuity", profileId, ...(input.tags ?? [])]),
    });
    memoryId = summaryMemory.id;
  }

  const snapshot = storage.insertImprintSnapshot({
    id: snapshotId,
    profile_id: profileId,
    summary,
    tags: input.tags,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    state,
    snapshot_path: snapshotPath,
    memory_id: memoryId,
  });

  return {
    ok: true,
    snapshot_id: snapshot.id,
    created_at: snapshot.created_at,
    profile_id: profileId,
    profile_found: Boolean(profile),
    snapshot_path: snapshotPath ?? null,
    memory_id: memoryId ?? null,
    summary,
    counts: {
      tools: toolNames.length,
      pending_runs: pendingRuns.length,
      recent_memories: recentMemories.length,
      recent_transcript_lines: recentTranscriptLines.length,
    },
  };
}

function getAutoSnapshotStatus() {
  return {
    running: autoSnapshotRuntime.running,
    in_tick: autoSnapshotRuntime.in_tick,
    config: { ...autoSnapshotRuntime.config },
    started_at: autoSnapshotRuntime.started_at,
    last_tick_at: autoSnapshotRuntime.last_tick_at,
    last_error: autoSnapshotRuntime.last_error,
    stats: {
      tick_count: autoSnapshotRuntime.tick_count,
      snapshots_created: autoSnapshotRuntime.snapshots_created,
      memories_promoted: autoSnapshotRuntime.memories_promoted,
    },
  };
}

function resolveAutoSnapshotConfig(
  input:
    | z.infer<typeof imprintAutoSnapshotSchema>
    | ImprintAutoSnapshotStateRecord
    | Partial<AutoSnapshotConfig>,
  fallback: AutoSnapshotConfig
): AutoSnapshotConfig {
  const profileId = typeof input.profile_id === "string" ? input.profile_id.trim() : undefined;
  return {
    profile_id: profileId || fallback.profile_id,
    interval_seconds: input.interval_seconds ?? fallback.interval_seconds,
    include_recent_memories: input.include_recent_memories ?? fallback.include_recent_memories,
    include_recent_transcript_lines:
      input.include_recent_transcript_lines ?? fallback.include_recent_transcript_lines,
    write_file: input.write_file ?? fallback.write_file,
    promote_summary: input.promote_summary ?? fallback.promote_summary,
  };
}

function startAutoSnapshotDaemon(storage: Storage, options: ImprintRuntimeOptions) {
  stopAutoSnapshotDaemon();
  autoSnapshotRuntime.running = true;
  autoSnapshotRuntime.in_tick = false;
  autoSnapshotRuntime.started_at = new Date().toISOString();
  autoSnapshotRuntime.last_error = null;
  autoSnapshotRuntime.timer = setInterval(() => {
    try {
      runAutoSnapshotTick(storage, options, autoSnapshotRuntime.config);
    } catch (error) {
      autoSnapshotRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, autoSnapshotRuntime.config.interval_seconds * 1000);
  autoSnapshotRuntime.timer.unref?.();
}

function stopAutoSnapshotDaemon() {
  if (autoSnapshotRuntime.timer) {
    clearInterval(autoSnapshotRuntime.timer);
  }
  autoSnapshotRuntime.timer = null;
  autoSnapshotRuntime.running = false;
  autoSnapshotRuntime.in_tick = false;
}

function runAutoSnapshotTick(
  storage: Storage,
  options: ImprintRuntimeOptions,
  config: AutoSnapshotConfig
): AutoSnapshotTickResult {
  if (autoSnapshotRuntime.in_tick) {
    return {
      completed_at: new Date().toISOString(),
      ok: false,
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  autoSnapshotRuntime.in_tick = true;
  try {
    const snapshot = captureImprintSnapshot(
      storage,
      {
        profile_id: config.profile_id,
        summary: "auto snapshot",
        tags: ["auto", "daemon"],
        include_recent_memories: config.include_recent_memories,
        include_recent_transcript_lines: config.include_recent_transcript_lines,
        write_file: config.write_file,
        promote_summary: config.promote_summary,
        source_client: "mcplayground-core-template",
        source_model: "local-deterministic-v1",
        source_agent: "imprint.auto_snapshot",
      },
      options
    );
    const completedAt = new Date().toISOString();
    autoSnapshotRuntime.tick_count += 1;
    autoSnapshotRuntime.snapshots_created += 1;
    if (typeof snapshot.memory_id === "number") {
      autoSnapshotRuntime.memories_promoted += 1;
    }
    autoSnapshotRuntime.last_tick_at = completedAt;
    autoSnapshotRuntime.last_error = null;
    return {
      completed_at: completedAt,
      ok: true,
      snapshot_id: snapshot.snapshot_id,
      snapshot_path: snapshot.snapshot_path ?? undefined,
      memory_id: snapshot.memory_id ?? undefined,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    autoSnapshotRuntime.tick_count += 1;
    autoSnapshotRuntime.last_tick_at = completedAt;
    autoSnapshotRuntime.last_error = message;
    return {
      completed_at: completedAt,
      ok: false,
      error: message,
    };
  } finally {
    autoSnapshotRuntime.in_tick = false;
  }
}

function compact(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function dedupeKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }
  return Array.from(seen);
}
