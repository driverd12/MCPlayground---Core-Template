import { z } from "zod";
import { Storage, TranscriptLineRecord, TranscriptRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

export const transcriptAppendSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  source_client: z.string().min(1),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  kind: z.string().min(1),
  text: z.string().min(1),
});

export const transcriptLogSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]).or(z.string().min(1)),
  content: z.string().min(1),
  is_squished: z.boolean().optional(),
});

export const transcriptSummarizeSchema = z.object({
  mutation: mutationSchema,
  session_id: z.string().min(1),
  provider: z.enum(["openai", "gemini", "auto"]).optional(),
  max_points: z.number().int().min(3).max(20).optional(),
});

export const transcriptSquishSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().min(1),
  limit: z.number().int().min(1).max(5000).optional(),
  max_points: z.number().int().min(3).max(20).optional(),
});

export const transcriptRunTimelineSchema = z.object({
  run_id: z.string().min(1),
  include_squished: z.boolean().optional(),
  roles: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

export const transcriptPendingRunsSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export const transcriptAutoSquishSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    batch_runs: z.number().int().min(1).max(200).optional(),
    per_run_limit: z.number().int().min(1).max(5000).optional(),
    max_points: z.number().int().min(3).max(20).optional(),
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

export const transcriptRetentionSchema = z.object({
  mutation: mutationSchema,
  older_than_days: z.number().int().min(0).max(3650),
  include_unsquished: z.boolean().optional(),
  run_id: z.string().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  dry_run: z.boolean().optional(),
});

type AutoSquishConfig = {
  interval_seconds: number;
  batch_runs: number;
  per_run_limit: number;
  max_points: number;
};

type SquishRunResult = {
  run_id: string;
  created_memory: boolean;
  squished_count: number;
  memory_id?: number;
  memory_created_at?: string;
  keywords?: string[];
  reason?: string;
};

type AutoSquishRunResult = {
  run_id: string;
  unsquished_before: number;
  created_memory: boolean;
  squished_count: number;
  memory_id?: number;
  reason?: string;
  error?: string;
};

type AutoSquishTickResult = {
  completed_at: string;
  runs_seen: number;
  runs_processed: number;
  memories_created: number;
  lines_squished: number;
  run_results: AutoSquishRunResult[];
  skipped?: boolean;
  reason?: string;
};

const DEFAULT_AUTO_SQUISH_CONFIG: AutoSquishConfig = {
  interval_seconds: 60,
  batch_runs: 10,
  per_run_limit: 200,
  max_points: 8,
};

const autoSquishRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: AutoSquishConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  tick_count: number;
  total_runs_processed: number;
  total_lines_squished: number;
  total_memories_created: number;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_AUTO_SQUISH_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_success_at: null,
  last_error: null,
  tick_count: 0,
  total_runs_processed: 0,
  total_lines_squished: 0,
  total_memories_created: 0,
};

export function initializeAutoSquishDaemon(storage: Storage) {
  const persisted = storage.getTranscriptAutoSquishState();
  if (!persisted) {
    autoSquishRuntime.config = { ...DEFAULT_AUTO_SQUISH_CONFIG };
    stopAutoSquishDaemon();
    return {
      restored: false,
      running: false,
      config: { ...autoSquishRuntime.config },
    };
  }

  autoSquishRuntime.config = resolveAutoSquishConfig(persisted, DEFAULT_AUTO_SQUISH_CONFIG);
  if (persisted.enabled) {
    startAutoSquishDaemon(storage);
  } else {
    stopAutoSquishDaemon();
  }

  return {
    restored: true,
    running: autoSquishRuntime.running,
    config: { ...autoSquishRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export function appendTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptAppendSchema>
) {
  const line = storage.insertTranscriptLine({
    run_id: input.session_id,
    role: input.kind,
    content: input.text,
    is_squished: false,
  });
  const transcript = storage.insertTranscript({
    session_id: input.session_id,
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
    kind: input.kind,
    text: input.text,
  });
  return {
    ...transcript,
    line_id: line.id,
    line_timestamp: line.timestamp,
  };
}

export function logTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptLogSchema>
) {
  return storage.insertTranscriptLine({
    run_id: input.run_id,
    role: input.role,
    content: input.content,
    is_squished: input.is_squished,
  });
}

export function squishTranscript(
  storage: Storage,
  input: Pick<z.infer<typeof transcriptSquishSchema>, "run_id" | "limit" | "max_points">
) {
  return squishRun(storage, input);
}

export function autoSquishControl(
  storage: Storage,
  input: z.infer<typeof transcriptAutoSquishSchema>
) {
  if (input.action === "status") {
    return getAutoSquishStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "transcript.auto_squish",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = autoSquishRuntime.running;
        autoSquishRuntime.config = resolveAutoSquishConfig(input, autoSquishRuntime.config);
        startAutoSquishDaemon(storage);
        let initialTick: ReturnType<typeof runAutoSquishTick> | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runAutoSquishTick(storage, autoSquishRuntime.config);
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...autoSquishRuntime.config },
          persisted: storage.setTranscriptAutoSquishState({
            enabled: true,
            interval_seconds: autoSquishRuntime.config.interval_seconds,
            batch_runs: autoSquishRuntime.config.batch_runs,
            per_run_limit: autoSquishRuntime.config.per_run_limit,
            max_points: autoSquishRuntime.config.max_points,
          }),
          initial_tick: initialTick,
          status: getAutoSquishStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = autoSquishRuntime.running;
        stopAutoSquishDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTranscriptAutoSquishState({
            enabled: false,
            interval_seconds: autoSquishRuntime.config.interval_seconds,
            batch_runs: autoSquishRuntime.config.batch_runs,
            per_run_limit: autoSquishRuntime.config.per_run_limit,
            max_points: autoSquishRuntime.config.max_points,
          }),
          status: getAutoSquishStatus(),
        };
      }

      const config = resolveAutoSquishConfig(input, autoSquishRuntime.config);
      const tick = runAutoSquishTick(storage, config);
      return {
        running: autoSquishRuntime.running,
        tick,
        status: getAutoSquishStatus(),
      };
    },
  });
}

export function applyTranscriptRetention(
  storage: Storage,
  input: z.infer<typeof transcriptRetentionSchema>
) {
  const olderThanIso = new Date(Date.now() - input.older_than_days * 24 * 60 * 60 * 1000).toISOString();
  const includeUnsquished = input.include_unsquished ?? false;
  const dryRun = input.dry_run ?? false;
  const result = storage.pruneTranscriptLines({
    older_than_iso: olderThanIso,
    include_unsquished: includeUnsquished,
    run_id: input.run_id,
    limit: input.limit ?? 1000,
    dry_run: dryRun,
  });

  return {
    older_than_iso: olderThanIso,
    include_unsquished: includeUnsquished,
    run_id: input.run_id ?? null,
    dry_run: dryRun,
    candidate_count: result.candidate_count,
    deleted_count: result.deleted_count,
    deleted_ids: result.deleted_ids,
  };
}

function squishRun(
  storage: Storage,
  input: Pick<z.infer<typeof transcriptSquishSchema>, "run_id" | "limit" | "max_points">
): SquishRunResult {
  const unsquished = storage.getUnsquishedTranscriptLines(input.run_id, input.limit ?? 200);
  if (unsquished.length === 0) {
    return {
      run_id: input.run_id,
      created_memory: false,
      squished_count: 0,
      reason: "no-unsquished-lines",
    };
  }

  const lines = collectTranscriptLineContents(unsquished);
  const summary = buildSquishedSummary(input.run_id, unsquished, lines, input.max_points ?? 8);
  const keywords = extractKeywords(lines, 12);
  const memory = storage.insertMemory({
    content: summary,
    keywords,
  });
  const squished = storage.markTranscriptLinesSquished(unsquished.map((line) => line.id));

  return {
    run_id: input.run_id,
    created_memory: true,
    memory_id: memory.id,
    memory_created_at: memory.created_at,
    squished_count: squished.updated_count,
    keywords,
  };
}

function getAutoSquishStatus() {
  return {
    running: autoSquishRuntime.running,
    in_tick: autoSquishRuntime.in_tick,
    config: { ...autoSquishRuntime.config },
    started_at: autoSquishRuntime.started_at,
    last_tick_at: autoSquishRuntime.last_tick_at,
    last_success_at: autoSquishRuntime.last_success_at,
    last_error: autoSquishRuntime.last_error,
    stats: {
      tick_count: autoSquishRuntime.tick_count,
      total_runs_processed: autoSquishRuntime.total_runs_processed,
      total_lines_squished: autoSquishRuntime.total_lines_squished,
      total_memories_created: autoSquishRuntime.total_memories_created,
    },
  };
}

export function getAutoSquishRuntimeStatus() {
  return getAutoSquishStatus();
}

function resolveAutoSquishConfig(
  input:
    | z.infer<typeof transcriptAutoSquishSchema>
    | Partial<Pick<z.infer<typeof transcriptAutoSquishSchema>, "interval_seconds" | "batch_runs" | "per_run_limit" | "max_points">>,
  fallback: AutoSquishConfig
): AutoSquishConfig {
  return {
    interval_seconds: input.interval_seconds ?? fallback.interval_seconds ?? DEFAULT_AUTO_SQUISH_CONFIG.interval_seconds,
    batch_runs: input.batch_runs ?? fallback.batch_runs ?? DEFAULT_AUTO_SQUISH_CONFIG.batch_runs,
    per_run_limit: input.per_run_limit ?? fallback.per_run_limit ?? DEFAULT_AUTO_SQUISH_CONFIG.per_run_limit,
    max_points: input.max_points ?? fallback.max_points ?? DEFAULT_AUTO_SQUISH_CONFIG.max_points,
  };
}

function startAutoSquishDaemon(storage: Storage) {
  stopAutoSquishDaemon();
  autoSquishRuntime.running = true;
  autoSquishRuntime.in_tick = false;
  autoSquishRuntime.started_at = new Date().toISOString();
  autoSquishRuntime.last_success_at = null;
  autoSquishRuntime.last_error = null;
  autoSquishRuntime.timer = setInterval(() => {
    try {
      runAutoSquishTick(storage, autoSquishRuntime.config);
    } catch (error) {
      autoSquishRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, autoSquishRuntime.config.interval_seconds * 1000);
  autoSquishRuntime.timer.unref?.();
}

function stopAutoSquishDaemon() {
  if (autoSquishRuntime.timer) {
    clearInterval(autoSquishRuntime.timer);
  }
  autoSquishRuntime.timer = null;
  autoSquishRuntime.running = false;
  autoSquishRuntime.in_tick = false;
}

function runAutoSquishTick(storage: Storage, config: AutoSquishConfig): AutoSquishTickResult {
  if (autoSquishRuntime.in_tick) {
    const completedAt = new Date().toISOString();
    return {
      completed_at: completedAt,
      runs_seen: 0,
      runs_processed: 0,
      memories_created: 0,
      lines_squished: 0,
      run_results: [],
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  autoSquishRuntime.in_tick = true;
  try {
    const pending = storage.listTranscriptRunsWithPending(config.batch_runs);
    const runResults: AutoSquishRunResult[] = [];
    const runErrors: string[] = [];
    let linesSquished = 0;
    let memoriesCreated = 0;
    let runsProcessed = 0;

    for (const run of pending) {
      try {
        const result = squishRun(storage, {
          run_id: run.run_id,
          limit: config.per_run_limit,
          max_points: config.max_points,
        });
        runResults.push({
          run_id: run.run_id,
          unsquished_before: run.unsquished_count,
          created_memory: result.created_memory,
          squished_count: result.squished_count,
          memory_id: result.memory_id,
          reason: result.reason,
        });
        runsProcessed += 1;
        linesSquished += result.squished_count;
        if (result.created_memory) {
          memoriesCreated += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runErrors.push(`${run.run_id}: ${message}`);
        runResults.push({
          run_id: run.run_id,
          unsquished_before: run.unsquished_count,
          created_memory: false,
          squished_count: 0,
          error: message,
        });
      }
    }

    const completedAt = new Date().toISOString();
    autoSquishRuntime.tick_count += 1;
    autoSquishRuntime.total_runs_processed += runsProcessed;
    autoSquishRuntime.total_lines_squished += linesSquished;
    autoSquishRuntime.total_memories_created += memoriesCreated;
    autoSquishRuntime.last_tick_at = completedAt;
    autoSquishRuntime.last_success_at = completedAt;
    autoSquishRuntime.last_error = runErrors.length
      ? `${runErrors.length} run(s) failed: ${runErrors[0]}`
      : null;

    return {
      completed_at: completedAt,
      runs_seen: pending.length,
      runs_processed: runsProcessed,
      memories_created: memoriesCreated,
      lines_squished: linesSquished,
      run_results: runResults,
      reason: runErrors.length ? autoSquishRuntime.last_error ?? undefined : undefined,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    autoSquishRuntime.tick_count += 1;
    autoSquishRuntime.last_tick_at = completedAt;
    autoSquishRuntime.last_error = message;
    return {
      completed_at: completedAt,
      runs_seen: 0,
      runs_processed: 0,
      memories_created: 0,
      lines_squished: 0,
      run_results: [],
      reason: message,
    };
  } finally {
    autoSquishRuntime.in_tick = false;
  }
}

export function getTranscriptRunTimeline(
  storage: Storage,
  input: z.infer<typeof transcriptRunTimelineSchema>
) {
  const includeSquished = input.include_squished ?? true;
  const roleFilter = input.roles?.map((role) => role.trim().toLowerCase()).filter(Boolean) ?? [];
  const lines = storage
    .getTranscriptLinesByRun(input.run_id, input.limit ?? 500)
    .filter((line) => {
      if (!includeSquished && line.is_squished) {
        return false;
      }
      if (roleFilter.length > 0 && !roleFilter.includes((line.role ?? "").toLowerCase())) {
        return false;
      }
      return true;
    });

  const first = lines[0];
  const last = lines[lines.length - 1];

  return {
    run_id: input.run_id,
    count: lines.length,
    include_squished: includeSquished,
    roles: roleFilter.length > 0 ? roleFilter : undefined,
    window: first && last ? { from: first.timestamp, to: last.timestamp } : undefined,
    lines,
  };
}

export function getTranscriptPendingRuns(
  storage: Storage,
  input: z.infer<typeof transcriptPendingRunsSchema>
) {
  const runs = storage.listTranscriptRunsWithPending(input.limit ?? 50);
  return {
    count: runs.length,
    runs,
  };
}

export async function summarizeTranscript(
  storage: Storage,
  input: z.infer<typeof transcriptSummarizeSchema>
) {
  const transcripts = storage.getTranscriptsBySession(input.session_id);
  if (transcripts.length === 0) {
    return { enabled: false, reason: "no transcripts for session" };
  }

  const text = buildLocalSummary(input.session_id, transcripts, input.max_points ?? 8);
  const note = storage.insertNote({
    text,
    tags: ["summary", "transcript", "local"],
    source: `transcript:${input.session_id}`,
    source_client: "mcp-playground-hub",
    source_model: "local-deterministic-v2",
    source_agent: "transcript.summarize",
    trust_tier: "verified",
  });

  return {
    enabled: true,
    ok: true,
    method: "local",
    note_id: note.id,
    entries: transcripts.length,
    provider_ignored: input.provider ?? undefined,
  };
}

function buildLocalSummary(sessionId: string, transcripts: TranscriptRecord[], maxPoints: number): string {
  const first = transcripts[0];
  const last = transcripts[transcripts.length - 1];
  const participants = collectParticipants(transcripts);
  const lines = collectTranscriptLines(transcripts);
  const points = collectRecentUnique(lines, maxPoints);
  const decisions = collectPatternMatches(lines, /\b(decision|decide|decided|agreed|approved|chosen)\b/i, 6);
  const actions = collectPatternMatches(
    lines,
    /\b(action|todo|next|follow[ -]?up|owner|pending|need to|should|must)\b/i,
    8
  );
  const questions = collectPatternMatches(lines, /\?/, 6);

  return [
    `Session: ${sessionId}`,
    `Entries: ${transcripts.length}`,
    `Window: ${first.created_at} -> ${last.created_at}`,
    `Participants: ${participants.length ? participants.join(", ") : "unknown"}`,
    "",
    "Key points:",
    ...toBullets(points, "No key points captured."),
    "",
    "Decisions:",
    ...toBullets(decisions, "No explicit decisions detected."),
    "",
    "Action items:",
    ...toBullets(actions, "No explicit action items detected."),
    "",
    "Open questions:",
    ...toBullets(questions, "No open questions detected."),
  ].join("\n");
}

function buildSquishedSummary(
  runId: string,
  transcriptLines: TranscriptLineRecord[],
  lines: string[],
  maxPoints: number
): string {
  const first = transcriptLines[0];
  const last = transcriptLines[transcriptLines.length - 1];
  const points = collectRecentUnique(lines, maxPoints);
  const decisions = collectPatternMatches(lines, /\b(decision|decide|decided|agreed|approved|chosen)\b/i, 6);
  const actions = collectPatternMatches(
    lines,
    /\b(action|todo|next|follow[ -]?up|owner|pending|need to|should|must)\b/i,
    8
  );
  const questions = collectPatternMatches(lines, /\?/, 6);

  return [
    `Run: ${runId}`,
    `Raw lines squished: ${transcriptLines.length}`,
    `Window: ${first.timestamp} -> ${last.timestamp}`,
    "",
    "Key points:",
    ...toBullets(points, "No key points captured."),
    "",
    "Decisions:",
    ...toBullets(decisions, "No explicit decisions detected."),
    "",
    "Action items:",
    ...toBullets(actions, "No explicit action items detected."),
    "",
    "Open questions:",
    ...toBullets(questions, "No open questions detected."),
  ].join("\n");
}

function collectParticipants(transcripts: TranscriptRecord[]): string[] {
  const participants = new Set<string>();
  for (const transcript of transcripts) {
    const tags = [transcript.source_client];
    if (transcript.source_model) {
      tags.push(transcript.source_model);
    }
    if (transcript.source_agent) {
      tags.push(transcript.source_agent);
    }
    participants.add(tags.join(":"));
  }
  return Array.from(participants);
}

function collectTranscriptLines(transcripts: TranscriptRecord[]): string[] {
  const lines: string[] = [];
  for (const transcript of transcripts) {
    const split = transcript.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    lines.push(...split);
  }
  return lines;
}

function collectTranscriptLineContents(lines: TranscriptLineRecord[]): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const split = line.content
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    output.push(...split);
  }
  return output;
}

function collectRecentUnique(lines: string[], limit: number): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = normalizeLine(lines[i]);
    if (!line) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.unshift(line);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function collectPatternMatches(lines: string[], pattern: RegExp, limit: number): string[] {
  const matches: string[] = [];
  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (!line) {
      continue;
    }
    if (pattern.test(line)) {
      matches.push(line);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return dedupe(matches).slice(0, limit);
}

function normalizeLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 280) {
    return trimmed;
  }
  return `${trimmed.slice(0, 280)}...`;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function toBullets(values: string[], fallback: string): string[] {
  if (values.length === 0) {
    return [`- ${fallback}`];
  }
  return values.map((value) => `- ${value}`);
}

function extractKeywords(lines: string[], maxKeywords: number): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "will",
    "into",
    "about",
    "need",
    "next",
    "then",
    "were",
    "when",
    "what",
    "where",
    "which",
    "your",
    "our",
    "you",
    "can",
    "all",
    "not",
  ]);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const words = line.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
    for (const word of words) {
      if (stopWords.has(word)) {
        continue;
      }
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxKeywords)
    .map(([keyword]) => keyword);
}
