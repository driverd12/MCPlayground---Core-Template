import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "utf8");

type StorageGuardOptions = {
  backup_dir: string;
  backup_keep: number;
  startup_backup_enabled: boolean;
  startup_quick_check_enabled: boolean;
  auto_restore_from_backup: boolean;
  allow_fresh_on_corruption: boolean;
  quarantine_dir: string;
};

type StorageGuardOutcome = {
  quarantined_paths: string[];
  restored_from_backup: string | null;
};

export type TrustTier = "raw" | "verified" | "policy-backed" | "deprecated";

export type NoteRecord = {
  id: string;
  created_at: string;
  source: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  trust_tier: TrustTier;
  expires_at: string | null;
  promoted_from_note_id: string | null;
  tags: string[];
  related_paths: string[];
  text: string;
  score?: number;
};

export type TranscriptRecord = {
  id: string;
  created_at: string;
  session_id: string;
  source_client: string;
  source_model: string | null;
  source_agent: string | null;
  kind: string;
  text: string;
  score?: number;
};

export type TranscriptLineRecord = {
  id: number;
  run_id: string | null;
  role: string | null;
  content: string;
  timestamp: string;
  is_squished: boolean;
  score?: number;
};

export type MemoryRecord = {
  id: number;
  content: string;
  keywords: string[];
  created_at: string;
  last_accessed_at: string;
  decay_score: number;
  score?: number;
};

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type TaskRecord = {
  task_id: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  priority: number;
  objective: string;
  project_dir: string;
  payload: Record<string, unknown>;
  source: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  max_attempts: number;
  attempt_count: number;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_worker_id: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  lease: TaskLeaseRecord | null;
};

export type TaskLeaseRecord = {
  task_id: string;
  owner_id: string;
  lease_expires_at: string;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
};

export type TaskEventRecord = {
  id: string;
  task_id: string;
  created_at: string;
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  worker_id: string | null;
  summary: string | null;
  details: Record<string, unknown>;
};

export type TriChatThreadStatus = "active" | "archived";

export type TriChatThreadRecord = {
  thread_id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  status: TriChatThreadStatus;
  metadata: Record<string, unknown>;
};

export type TriChatMessageRecord = {
  message_id: string;
  thread_id: string;
  created_at: string;
  agent_id: string;
  role: string;
  content: string;
  reply_to_message_id: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatTurnStatus = "running" | "completed" | "failed" | "cancelled";
export type TriChatTurnPhase = "plan" | "propose" | "critique" | "merge" | "execute" | "verify" | "summarize";
export type TriChatTurnPhaseStatus = "running" | "completed" | "failed" | "skipped";

export type TriChatTurnRecord = {
  turn_id: string;
  thread_id: string;
  user_message_id: string;
  user_prompt: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  finished_at: string | null;
  status: TriChatTurnStatus;
  phase: TriChatTurnPhase;
  phase_status: TriChatTurnPhaseStatus;
  expected_agents: string[];
  min_agents: number;
  novelty_score: number | null;
  novelty_threshold: number | null;
  retry_required: boolean;
  retry_agents: string[];
  disagreement: boolean;
  decision_summary: string | null;
  selected_agent: string | null;
  selected_strategy: string | null;
  verify_status: string | null;
  verify_summary: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatTurnArtifactRecord = {
  artifact_id: string;
  turn_id: string;
  thread_id: string;
  created_at: string;
  phase: TriChatTurnPhase;
  artifact_type: string;
  agent_id: string | null;
  content: string | null;
  structured: Record<string, unknown>;
  score: number | null;
  metadata: Record<string, unknown>;
};

export type TriChatBusEventRecord = {
  event_seq: number;
  event_id: string;
  thread_id: string;
  created_at: string;
  source_agent: string | null;
  source_client: string | null;
  event_type: string;
  role: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatAdapterChannel = "command" | "model";

export type TriChatAdapterStateRecord = {
  agent_id: string;
  channel: TriChatAdapterChannel;
  updated_at: string;
  open: boolean;
  open_until: string | null;
  failure_count: number;
  trip_count: number;
  success_count: number;
  last_error: string | null;
  last_opened_at: string | null;
  turn_count: number;
  degraded_turn_count: number;
  last_result: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatAdapterEventRecord = {
  event_id: string;
  created_at: string;
  agent_id: string;
  channel: TriChatAdapterChannel;
  event_type: string;
  open_until: string | null;
  error_text: string | null;
  details: Record<string, unknown>;
};

export type TriChatAdapterTelemetrySummaryRecord = {
  total_channels: number;
  open_channels: number;
  total_trips: number;
  total_successes: number;
  total_turns: number;
  total_degraded_turns: number;
  newest_state_at: string | null;
  newest_event_at: string | null;
  newest_trip_opened_at: string | null;
  per_agent: Array<{
    agent_id: string;
    channel_count: number;
    open_channels: number;
    total_trips: number;
    total_turns: number;
    degraded_turns: number;
    updated_at: string | null;
  }>;
};

export type TaskSummaryRecord = {
  counts: Record<TaskStatus, number>;
  running: Array<{
    task_id: string;
    objective: string;
    owner_id: string | null;
    lease_expires_at: string | null;
    updated_at: string;
    attempt_count: number;
    max_attempts: number;
  }>;
  last_failed: {
    task_id: string;
    last_error: string | null;
    attempt_count: number;
    max_attempts: number;
    updated_at: string;
  } | null;
};

export type TriChatSummaryRecord = {
  thread_counts: {
    active: number;
    archived: number;
    total: number;
  };
  message_count: number;
  oldest_message_at: string | null;
  newest_message_at: string | null;
  busiest_threads: Array<{
    thread_id: string;
    status: TriChatThreadStatus;
    updated_at: string;
    message_count: number;
  }>;
};

export type MutationMeta = {
  idempotency_key: string;
  side_effect_fingerprint: string;
};

export type MutationStartResult = {
  replayed: boolean;
  result?: unknown;
};

export type RunEventRecord = {
  id: string;
  created_at: string;
  run_id: string;
  event_type: "begin" | "step" | "end";
  step_index: number;
  status: string;
  summary: string;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  details: Record<string, unknown>;
};

export type LockAcquireResult = {
  acquired: boolean;
  lock_key: string;
  owner_id?: string;
  lease_expires_at?: string;
  reason?: string;
};

export type IncidentRecord = {
  incident_id: string;
  created_at: string;
  updated_at: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  tags: string[];
};

export type IncidentEventRecord = {
  id: string;
  created_at: string;
  incident_id: string;
  event_type: string;
  summary: string;
  details: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type TranscriptAutoSquishStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  batch_runs: number;
  per_run_limit: number;
  max_points: number;
  updated_at: string;
};

export type ImprintAutoSnapshotStateRecord = {
  enabled: boolean;
  profile_id: string | null;
  interval_seconds: number;
  include_recent_memories: number;
  include_recent_transcript_lines: number;
  write_file: boolean;
  promote_summary: boolean;
  updated_at: string;
};

export type TaskAutoRetryStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  batch_limit: number;
  base_delay_seconds: number;
  max_delay_seconds: number;
  updated_at: string;
};

export type TriChatAutoRetentionStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  older_than_days: number;
  limit: number;
  updated_at: string;
};

export type TriChatTurnWatchdogStateRecord = {
  enabled: boolean;
  interval_seconds: number;
  stale_after_seconds: number;
  batch_limit: number;
  updated_at: string;
};

export type TriChatAutopilotStateRecord = {
  enabled: boolean;
  away_mode: "safe" | "normal" | "aggressive";
  interval_seconds: number;
  thread_id: string;
  thread_title: string;
  thread_status: "active" | "archived";
  objective: string;
  max_rounds: number;
  min_success_agents: number;
  bridge_timeout_seconds: number;
  bridge_dry_run: boolean;
  execute_enabled: boolean;
  command_allowlist: string[];
  execute_backend: "direct" | "tmux" | "auto";
  tmux_session_name: string;
  tmux_worker_count: number;
  tmux_max_queue_per_worker: number;
  tmux_auto_scale_workers: boolean;
  tmux_sync_after_dispatch: boolean;
  confidence_threshold: number;
  max_consecutive_errors: number;
  lock_key: string | null;
  lock_lease_seconds: number;
  adr_policy: "every_success" | "high_impact" | "manual";
  pause_reason: string | null;
  updated_at: string;
};

export type TriChatTmuxControllerTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TriChatTmuxControllerTaskRecord = {
  task_id: string;
  seq: number;
  title: string;
  command: string;
  priority: number;
  complexity: number;
  worker_id: string | null;
  status: TriChatTmuxControllerTaskStatus;
  created_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  thread_id: string | null;
  turn_id: string | null;
  metadata: Record<string, unknown>;
};

export type TriChatTmuxControllerStateRecord = {
  enabled: boolean;
  session_name: string;
  workspace: string;
  worker_count: number;
  shell: string;
  max_queue_per_worker: number;
  next_task_seq: number;
  tasks: TriChatTmuxControllerTaskRecord[];
  last_dispatch_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export type TriChatChaosEventRecord = {
  event_id: string;
  created_at: string;
  action: string;
  thread_id: string | null;
  turn_id: string | null;
  agent_id: string | null;
  channel: TriChatAdapterChannel | null;
  outcome: string;
  details: Record<string, unknown>;
};

export type TriChatSloSnapshotRecord = {
  snapshot_id: string;
  created_at: string;
  window_minutes: number;
  adapter_sample_count: number;
  adapter_error_count: number;
  adapter_error_rate: number;
  adapter_latency_p95_ms: number | null;
  turn_total_count: number;
  turn_failed_count: number;
  turn_failure_rate: number;
  metadata: Record<string, unknown>;
};

export type ImprintProfileRecord = {
  profile_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  mission: string;
  principles: string[];
  hard_constraints: string[];
  preferred_models: string[];
  project_roots: string[];
  notes: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export type ImprintSnapshotRecord = {
  id: string;
  created_at: string;
  profile_id: string | null;
  summary: string | null;
  tags: string[];
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  state: Record<string, unknown>;
  snapshot_path: string | null;
  memory_id: number | null;
};

export type MigrationStatusRecord = {
  schema_version: number;
  applied_versions: Array<{
    version: number;
    name: string | null;
    applied_at: string | null;
    source: "recorded" | "inferred-user-version";
  }>;
  recorded_count: number;
  inferred_count: number;
};

export class Storage {
  private db: Database.Database;
  private readonly guardOptions: StorageGuardOptions;
  private readonly guardOutcome: StorageGuardOutcome;

  constructor(private dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.guardOptions = resolveStorageGuardOptions(dbPath);
    this.guardOutcome = guardDatabasePathBeforeOpen(dbPath, this.guardOptions);
    this.db = openDatabaseWithGuard(dbPath, this.guardOptions);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  init(): void {
    if (this.guardOutcome.restored_from_backup) {
      writeStorageGuardLog(
        `[storage] restored database from backup: ${this.guardOutcome.restored_from_backup} -> ${this.dbPath}`
      );
    }
    this.ensureStartupIntegrity();
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.ensureMigrationTable();
    this.applyPendingMigrations([
      {
        version: 1,
        name: "bootstrap-core-schema",
        run: () => this.applyCoreSchemaMigration(),
      },
      {
        version: 2,
        name: "add-daemon-config-storage",
        run: () => this.applyDaemonConfigMigration(),
      },
      {
        version: 3,
        name: "add-imprint-schema",
        run: () => this.applyImprintSchemaMigration(),
      },
      {
        version: 4,
        name: "add-task-orchestrator-schema",
        run: () => this.applyTaskSchemaMigration(),
      },
      {
        version: 5,
        name: "add-trichat-thread-message-schema",
        run: () => this.applyTriChatSchemaMigration(),
      },
      {
        version: 6,
        name: "add-trichat-adapter-telemetry-schema",
        run: () => this.applyTriChatAdapterTelemetryMigration(),
      },
      {
        version: 7,
        name: "add-trichat-bus-schema",
        run: () => this.applyTriChatBusMigration(),
      },
      {
        version: 8,
        name: "add-trichat-turn-schema",
        run: () => this.applyTriChatTurnSchemaMigration(),
      },
      {
        version: 9,
        name: "add-trichat-reliability-schema",
        run: () => this.applyTriChatReliabilitySchemaMigration(),
      },
    ]);
    this.ensureRuntimeSchemaCompleteness();
    this.createStartupBackupSnapshot();
  }

  private ensureStartupIntegrity(): void {
    if (!this.guardOptions.startup_quick_check_enabled) {
      return;
    }
    const quickCheck = runQuickCheck(this.db);
    if (quickCheck.ok) {
      return;
    }
    this.recoverFromCorruption(`quick_check failed: ${quickCheck.reason}`, "quick-check");
  }

  private recoverFromCorruption(reason: string, stage: string): void {
    writeStorageGuardLog(`[storage] corruption detected (${stage}): ${reason}`);
    safeCloseDatabase(this.db);
    const quarantined = quarantineDatabaseArtifacts(this.dbPath, this.guardOptions, stage);
    if (quarantined.length > 0) {
      writeStorageGuardLog(`[storage] quarantined artifacts: ${quarantined.join(", ")}`);
    }

    if (this.guardOptions.auto_restore_from_backup) {
      const restoredFrom = restoreLatestDatabaseBackup(this.dbPath, this.guardOptions);
      if (restoredFrom) {
        writeStorageGuardLog(`[storage] attempting restore from backup: ${restoredFrom}`);
        this.db = openDatabaseWithGuard(this.dbPath, this.guardOptions);
        const postRestoreCheck = runQuickCheck(this.db);
        if (postRestoreCheck.ok) {
          writeStorageGuardLog(`[storage] restore succeeded with clean integrity check.`);
          return;
        }
        writeStorageGuardLog(`[storage] restored backup still failed quick_check: ${postRestoreCheck.reason}`);
        safeCloseDatabase(this.db);
      }
    }

    if (!this.guardOptions.allow_fresh_on_corruption) {
      throw new Error(
        [
          `Storage corruption could not be recovered automatically for ${this.dbPath}.`,
          `No healthy backup could be restored from ${this.guardOptions.backup_dir}.`,
          `Set ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION=1 only if you intentionally want a fresh empty DB.`,
        ].join(" ")
      );
    }

    removeDatabaseArtifacts(this.dbPath);
    this.db = openDatabaseWithGuard(this.dbPath, this.guardOptions);
    writeStorageGuardLog(`[storage] initialized fresh empty database after unrecoverable corruption: ${this.dbPath}`);
  }

  private createStartupBackupSnapshot(): void {
    if (!this.guardOptions.startup_backup_enabled) {
      return;
    }
    if (this.dbPath === ":memory:") {
      return;
    }

    fs.mkdirSync(this.guardOptions.backup_dir, { recursive: true });
    const base = path.basename(this.dbPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tmpPath = path.join(this.guardOptions.backup_dir, `${base}.${stamp}.tmp.sqlite`);
    const finalPath = path.join(this.guardOptions.backup_dir, `${base}.${stamp}.sqlite`);
    const escapedTmpPath = tmpPath.replace(/'/g, "''");
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
      this.db.exec(`VACUUM INTO '${escapedTmpPath}'`);
      moveFileWithFallback(tmpPath, finalPath);
      pruneDatabaseBackups(this.dbPath, this.guardOptions);
    } catch (error) {
      removeFileIfExists(tmpPath);
      const message = error instanceof Error ? error.message : String(error);
      writeStorageGuardLog(`[storage] startup backup skipped: ${message}`);
    }
  }

  getSchemaVersion(): number {
    return readUserVersion(this.db);
  }

  getMigrationStatus(): MigrationStatusRecord {
    const schemaVersion = this.getSchemaVersion();
    const rows = this.db
      .prepare(
        `SELECT version, name, applied_at
         FROM schema_migrations
         ORDER BY version ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const recorded = rows
      .map((row) => ({
        version: Number(row.version ?? 0),
        name: asNullableString(row.name),
        applied_at: asNullableString(row.applied_at),
        source: "recorded" as const,
      }))
      .filter((entry) => Number.isInteger(entry.version) && entry.version > 0);

    const recordedVersionSet = new Set<number>(recorded.map((entry) => entry.version));
    const inferred: MigrationStatusRecord["applied_versions"] = [];
    for (let version = 1; version <= schemaVersion; version += 1) {
      if (!recordedVersionSet.has(version)) {
        inferred.push({
          version,
          name: null,
          applied_at: null,
          source: "inferred-user-version",
        });
      }
    }

    const appliedVersions = [...recorded, ...inferred].sort((a, b) => a.version - b.version);
    return {
      schema_version: schemaVersion,
      applied_versions: appliedVersions,
      recorded_count: recorded.length,
      inferred_count: inferred.length,
    };
  }

  insertNote(params: {
    text: string;
    source?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    trust_tier?: TrustTier;
    expires_at?: string;
    promoted_from_note_id?: string;
    tags?: string[];
    related_paths?: string[];
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const tags = params.tags ?? [];
    const relatedPaths = params.related_paths ?? [];
    const trustTier = params.trust_tier ?? "raw";
    const stmt = this.db.prepare(
      `INSERT INTO notes (
        id, created_at, source, source_client, source_model, source_agent,
        trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      createdAt,
      params.source ?? null,
      params.source_client ?? null,
      params.source_model ?? null,
      params.source_agent ?? null,
      trustTier,
      params.expires_at ?? null,
      params.promoted_from_note_id ?? null,
      JSON.stringify(tags),
      JSON.stringify(relatedPaths),
      params.text
    );
    return { id, created_at: createdAt };
  }

  getNoteById(noteId: string): NoteRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at, source, source_client, source_model, source_agent,
                trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapNoteRow(row);
  }

  searchNotes(params: {
    query?: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    trust_tiers?: TrustTier[];
    include_expired?: boolean;
    limit: number;
  }): NoteRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `SELECT id, created_at, source, source_client, source_model, source_agent,
                    trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
             FROM notes
             WHERE text LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, source, source_client, source_model, source_agent,
                    trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
             FROM notes
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit * 20) as Array<Record<string, unknown>>);

    const nowIso = new Date().toISOString();
    const tagFilter = params.tags?.map((tag) => tag.toLowerCase()) ?? [];
    const trustFilter = new Set((params.trust_tiers ?? []).map((tier) => String(tier)));
    const includeExpired = params.include_expired ?? true;

    const results: NoteRecord[] = [];
    for (const row of rows) {
      const note = mapNoteRow(row);
      if (tagFilter.length > 0) {
        const lowerTags = note.tags.map((tag) => tag.toLowerCase());
        const hasAll = tagFilter.every((tag) => lowerTags.includes(tag));
        if (!hasAll) {
          continue;
        }
      }
      if (params.source_client && note.source_client !== params.source_client) {
        continue;
      }
      if (params.source_model && note.source_model !== params.source_model) {
        continue;
      }
      if (params.source_agent && note.source_agent !== params.source_agent) {
        continue;
      }
      if (trustFilter.size > 0 && !trustFilter.has(note.trust_tier)) {
        continue;
      }
      if (!includeExpired && note.expires_at && note.expires_at <= nowIso) {
        continue;
      }
      note.score = computeTermScore(note.text, query);
      results.push(note);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  insertMemory(params: {
    content: string;
    keywords?: string[];
    decay_score?: number;
  }): { id: number; created_at: string; last_accessed_at: string } {
    const now = new Date().toISOString();
    const keywords = normalizeKeywords(params.keywords);
    const stmt = this.db.prepare(
      `INSERT INTO memories (content, keywords, created_at, last_accessed_at, decay_score)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      params.content,
      keywords.join(", "),
      now,
      now,
      params.decay_score ?? 1.0
    );
    return {
      id: Number(result.lastInsertRowid),
      created_at: now,
      last_accessed_at: now,
    };
  }

  getMemoryById(memoryId: number): MemoryRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         WHERE id = ?`
      )
      .get(memoryId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapMemoryRow(row);
  }

  touchMemory(memoryId: number): { touched: boolean; last_accessed_at: string } {
    const timestamp = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`)
      .run(timestamp, memoryId);
    return {
      touched: Number(result.changes ?? 0) > 0,
      last_accessed_at: timestamp,
    };
  }

  searchMemories(params: {
    query: string;
    limit: number;
  }): MemoryRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         WHERE content LIKE ? OR keywords LIKE ?
         ORDER BY last_accessed_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as Array<Record<string, unknown>>;

    const accessedAt = new Date().toISOString();
    const result = rows.map((row) => {
      const memory = mapMemoryRow(row);
      memory.score = computeTermScore(`${memory.content} ${memory.keywords.join(" ")}`, query);
      memory.last_accessed_at = accessedAt;
      return memory;
    });

    if (result.length > 0) {
      const updateStmt = this.db.prepare(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`);
      const tx = this.db.transaction((ids: number[]) => {
        for (const id of ids) {
          updateStmt.run(accessedAt, id);
        }
      });
      tx(result.map((entry) => entry.id));
    }

    return result;
  }

  listRecentMemories(limit: number): MemoryRecord[] {
    if (limit <= 0) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapMemoryRow(row));
  }

  decayNotes(params: {
    older_than_iso: string;
    from_tiers: TrustTier[];
    to_tier: TrustTier;
    limit: number;
  }): { updated_ids: string[] } {
    if (params.from_tiers.length === 0) {
      return { updated_ids: [] };
    }
    const limit = Math.max(1, Math.min(500, params.limit));
    const placeholders = params.from_tiers.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id
         FROM notes
         WHERE created_at <= ?
           AND trust_tier IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(params.older_than_iso, ...params.from_tiers, limit) as Array<Record<string, unknown>>;
    const ids = rows.map((row) => String(row.id));
    if (ids.length === 0) {
      return { updated_ids: [] };
    }
    const updateStmt = this.db.prepare(`UPDATE notes SET trust_tier = ? WHERE id = ?`);
    const tx = this.db.transaction((noteIds: string[]) => {
      for (const noteId of noteIds) {
        updateStmt.run(params.to_tier, noteId);
      }
    });
    tx(ids);
    return { updated_ids: ids };
  }

  insertTranscript(params: {
    session_id: string;
    source_client: string;
    source_model?: string;
    source_agent?: string;
    kind: string;
    text: string;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO transcripts (id, created_at, session_id, source_client, source_model, source_agent, kind, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      createdAt,
      params.session_id,
      params.source_client,
      params.source_model ?? null,
      params.source_agent ?? null,
      params.kind,
      params.text
    );
    return { id, created_at: createdAt };
  }

  insertTranscriptLine(params: {
    run_id?: string;
    role: string;
    content: string;
    is_squished?: boolean;
  }): { id: number; timestamp: string } {
    const timestamp = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO transcript_lines (run_id, role, content, timestamp, is_squished)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      params.run_id ?? null,
      params.role,
      params.content,
      timestamp,
      params.is_squished ? 1 : 0
    );
    return {
      id: Number(result.lastInsertRowid),
      timestamp,
    };
  }

  getTranscriptLinesByRun(runId: string, limit = 1000): TranscriptLineRecord[] {
    const boundedLimit = Math.max(1, Math.min(5000, limit));
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE run_id = ?
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptLineRow(row));
  }

  getTranscriptLineById(lineId: number): TranscriptLineRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE id = ?`
      )
      .get(lineId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTranscriptLineRow(row);
  }

  getUnsquishedTranscriptLines(runId: string, limit = 500): TranscriptLineRecord[] {
    const boundedLimit = Math.max(1, Math.min(5000, limit));
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE run_id = ?
           AND is_squished = 0
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptLineRow(row));
  }

  searchTranscriptLines(params: {
    query: string;
    run_id?: string;
    include_squished?: boolean;
    limit: number;
  }): TranscriptLineRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE content LIKE ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>;

    const includeSquished = params.include_squished ?? true;
    const result: TranscriptLineRecord[] = [];
    for (const row of rows) {
      const line = mapTranscriptLineRow(row);
      if (params.run_id && line.run_id !== params.run_id) {
        continue;
      }
      if (!includeSquished && line.is_squished) {
        continue;
      }
      line.score = computeTermScore(line.content, query);
      result.push(line);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  listRecentTranscriptLines(params: {
    limit: number;
    include_squished?: boolean;
  }): TranscriptLineRecord[] {
    if (params.limit <= 0) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(2000, params.limit));
    const includeSquished = params.include_squished ?? true;
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(boundedLimit * 4) as Array<Record<string, unknown>>;

    const result: TranscriptLineRecord[] = [];
    for (const row of rows) {
      const line = mapTranscriptLineRow(row);
      if (!includeSquished && line.is_squished) {
        continue;
      }
      result.push(line);
      if (result.length >= boundedLimit) {
        break;
      }
    }
    return result;
  }

  markTranscriptLinesSquished(lineIds: number[]): { updated_count: number } {
    if (lineIds.length === 0) {
      return { updated_count: 0 };
    }
    const stmt = this.db.prepare(`UPDATE transcript_lines SET is_squished = 1 WHERE id = ?`);
    const tx = this.db.transaction((ids: number[]) => {
      let updated = 0;
      for (const id of ids) {
        const result = stmt.run(id);
        updated += Number(result.changes ?? 0);
      }
      return updated;
    });
    return { updated_count: tx(lineIds) };
  }

  listTranscriptRunsWithPending(limit = 50): Array<{
    run_id: string;
    unsquished_count: number;
    last_timestamp: string;
  }> {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT run_id, COUNT(*) AS unsquished_count, MAX(timestamp) AS last_timestamp
         FROM transcript_lines
         WHERE run_id IS NOT NULL
           AND is_squished = 0
         GROUP BY run_id
         ORDER BY last_timestamp DESC
         LIMIT ?`
      )
      .all(boundedLimit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      run_id: String(row.run_id ?? ""),
      unsquished_count: Number(row.unsquished_count ?? 0),
      last_timestamp: String(row.last_timestamp ?? ""),
    }));
  }

  pruneTranscriptLines(params: {
    older_than_iso: string;
    include_unsquished: boolean;
    run_id?: string;
    limit: number;
    dry_run?: boolean;
  }): { candidate_count: number; deleted_count: number; deleted_ids: number[] } {
    const limit = Math.max(1, Math.min(5000, params.limit));
    const whereClauses = ["timestamp <= ?"];
    const values: Array<string | number> = [params.older_than_iso];

    if (!params.include_unsquished) {
      whereClauses.push("is_squished = 1");
    }
    if (params.run_id) {
      whereClauses.push("run_id = ?");
      values.push(params.run_id);
    }

    const idRows = this.db
      .prepare(
        `SELECT id
         FROM transcript_lines
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;

    const ids = idRows.map((row) => Number(row.id ?? 0)).filter((id) => Number.isInteger(id) && id > 0);
    if (params.dry_run || ids.length === 0) {
      return {
        candidate_count: ids.length,
        deleted_count: 0,
        deleted_ids: [],
      };
    }

    const deleteStmt = this.db.prepare(`DELETE FROM transcript_lines WHERE id = ?`);
    const tx = this.db.transaction((lineIds: number[]) => {
      let deleted = 0;
      for (const lineId of lineIds) {
        const result = deleteStmt.run(lineId);
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    });

    const deletedCount = tx(ids);
    return {
      candidate_count: ids.length,
      deleted_count: deletedCount,
      deleted_ids: ids,
    };
  }

  getTranscriptAutoSquishState(): TranscriptAutoSquishStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("transcript.auto_squish") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 60, 5, 3600),
      batch_runs: parseBoundedInt(config.batch_runs, 10, 1, 200),
      per_run_limit: parseBoundedInt(config.per_run_limit, 200, 1, 5000),
      max_points: parseBoundedInt(config.max_points, 8, 3, 20),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTranscriptAutoSquishState(params: {
    enabled: boolean;
    interval_seconds: number;
    batch_runs: number;
    per_run_limit: number;
    max_points: number;
  }): TranscriptAutoSquishStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 60, 5, 3600),
      batch_runs: parseBoundedInt(params.batch_runs, 10, 1, 200),
      per_run_limit: parseBoundedInt(params.per_run_limit, 200, 1, 5000),
      max_points: parseBoundedInt(params.max_points, 8, 3, 20),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      batch_runs: normalized.batch_runs,
      per_run_limit: normalized.per_run_limit,
      max_points: normalized.max_points,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("transcript.auto_squish", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTaskAutoRetryState(): TaskAutoRetryStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("task.auto_retry") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const baseDelaySeconds = parseBoundedInt(config.base_delay_seconds, 30, 0, 86400);
    const maxDelaySeconds = parseBoundedInt(config.max_delay_seconds, 3600, 0, 604800);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 60, 5, 3600),
      batch_limit: parseBoundedInt(config.batch_limit, 20, 1, 500),
      base_delay_seconds: baseDelaySeconds,
      max_delay_seconds: Math.max(baseDelaySeconds, maxDelaySeconds),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTaskAutoRetryState(params: {
    enabled: boolean;
    interval_seconds: number;
    batch_limit: number;
    base_delay_seconds: number;
    max_delay_seconds: number;
  }): TaskAutoRetryStateRecord {
    const now = new Date().toISOString();
    const baseDelaySeconds = parseBoundedInt(params.base_delay_seconds, 30, 0, 86400);
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 60, 5, 3600),
      batch_limit: parseBoundedInt(params.batch_limit, 20, 1, 500),
      base_delay_seconds: baseDelaySeconds,
      max_delay_seconds: Math.max(baseDelaySeconds, parseBoundedInt(params.max_delay_seconds, 3600, 0, 604800)),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      batch_limit: normalized.batch_limit,
      base_delay_seconds: normalized.base_delay_seconds,
      max_delay_seconds: normalized.max_delay_seconds,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("task.auto_retry", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatAutoRetentionState(): TriChatAutoRetentionStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.auto_retention") as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 600, 10, 86400),
      older_than_days: parseBoundedInt(config.older_than_days, 30, 0, 3650),
      limit: parseBoundedInt(config.limit, 1000, 1, 5000),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatAutoRetentionState(params: {
    enabled: boolean;
    interval_seconds: number;
    older_than_days: number;
    limit: number;
  }): TriChatAutoRetentionStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 600, 10, 86400),
      older_than_days: parseBoundedInt(params.older_than_days, 30, 0, 3650),
      limit: parseBoundedInt(params.limit, 1000, 1, 5000),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      older_than_days: normalized.older_than_days,
      limit: normalized.limit,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.auto_retention", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatTurnWatchdogState(): TriChatTurnWatchdogStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.turn_watchdog") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      interval_seconds: parseBoundedInt(config.interval_seconds, 30, 5, 3600),
      stale_after_seconds: parseBoundedInt(config.stale_after_seconds, 180, 15, 86400),
      batch_limit: parseBoundedInt(config.batch_limit, 10, 1, 200),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatTurnWatchdogState(params: {
    enabled: boolean;
    interval_seconds: number;
    stale_after_seconds: number;
    batch_limit: number;
  }): TriChatTurnWatchdogStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      interval_seconds: parseBoundedInt(params.interval_seconds, 30, 5, 3600),
      stale_after_seconds: parseBoundedInt(params.stale_after_seconds, 180, 15, 86400),
      batch_limit: parseBoundedInt(params.batch_limit, 10, 1, 200),
    };
    const configJson = stableStringify({
      interval_seconds: normalized.interval_seconds,
      stale_after_seconds: normalized.stale_after_seconds,
      batch_limit: normalized.batch_limit,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.turn_watchdog", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatAutopilotState(): TriChatAutopilotStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.autopilot") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const awayModeRaw = String(config.away_mode ?? "normal").trim().toLowerCase();
    const awayMode: TriChatAutopilotStateRecord["away_mode"] =
      awayModeRaw === "safe" || awayModeRaw === "aggressive" ? awayModeRaw : "normal";
    const threadStatusRaw = String(config.thread_status ?? "archived").trim().toLowerCase();
    const threadStatus: TriChatAutopilotStateRecord["thread_status"] =
      threadStatusRaw === "active" ? "active" : "archived";
    const adrPolicyRaw = String(config.adr_policy ?? "every_success").trim().toLowerCase();
    const adrPolicy: TriChatAutopilotStateRecord["adr_policy"] =
      adrPolicyRaw === "manual" || adrPolicyRaw === "high_impact" ? adrPolicyRaw : "every_success";
    const executeBackendRaw = String(config.execute_backend ?? "auto").trim().toLowerCase();
    const executeBackend: TriChatAutopilotStateRecord["execute_backend"] =
      executeBackendRaw === "direct" || executeBackendRaw === "tmux" ? executeBackendRaw : "auto";
    const commandAllowlist = dedupeNonEmpty(
      Array.isArray(config.command_allowlist)
        ? (config.command_allowlist as unknown[]).map((entry) => String(entry ?? ""))
        : []
    );
    const lockKeyRaw = String(config.lock_key ?? "").trim();

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      away_mode: awayMode,
      interval_seconds: parseBoundedInt(config.interval_seconds, 300, 10, 86400),
      thread_id: String(config.thread_id ?? "trichat-autopilot-internal").trim() || "trichat-autopilot-internal",
      thread_title: String(config.thread_title ?? "TriChat Autopilot").trim() || "TriChat Autopilot",
      thread_status: threadStatus,
      objective:
        String(
          config.objective ??
            "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop."
        ).trim() ||
        "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop.",
      max_rounds: parseBoundedInt(config.max_rounds, 2, 1, 6),
      min_success_agents: parseBoundedInt(config.min_success_agents, 2, 1, 3),
      bridge_timeout_seconds: parseBoundedInt(config.bridge_timeout_seconds, 180, 5, 7200),
      bridge_dry_run: parseBoolean(config.bridge_dry_run, false),
      execute_enabled: parseBoolean(config.execute_enabled, true),
      command_allowlist: commandAllowlist,
      execute_backend: executeBackend,
      tmux_session_name:
        String(config.tmux_session_name ?? "trichat-autopilot").trim() || "trichat-autopilot",
      tmux_worker_count: parseBoundedInt(config.tmux_worker_count, 3, 1, 12),
      tmux_max_queue_per_worker: parseBoundedInt(config.tmux_max_queue_per_worker, 6, 1, 200),
      tmux_auto_scale_workers: parseBoolean(config.tmux_auto_scale_workers, true),
      tmux_sync_after_dispatch: parseBoolean(config.tmux_sync_after_dispatch, true),
      confidence_threshold: parseBoundedFloat(config.confidence_threshold, 0.45, 0.05, 1),
      max_consecutive_errors: parseBoundedInt(config.max_consecutive_errors, 3, 1, 20),
      lock_key: lockKeyRaw || null,
      lock_lease_seconds: parseBoundedInt(config.lock_lease_seconds, 600, 15, 3600),
      adr_policy: adrPolicy,
      pause_reason: asNullableString(config.pause_reason),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatAutopilotState(params: {
    enabled: boolean;
    away_mode: "safe" | "normal" | "aggressive";
    interval_seconds: number;
    thread_id: string;
    thread_title: string;
    thread_status: "active" | "archived";
    objective: string;
    max_rounds: number;
    min_success_agents: number;
    bridge_timeout_seconds: number;
    bridge_dry_run: boolean;
    execute_enabled: boolean;
    command_allowlist: string[];
    execute_backend: "direct" | "tmux" | "auto";
    tmux_session_name: string;
    tmux_worker_count: number;
    tmux_max_queue_per_worker: number;
    tmux_auto_scale_workers: boolean;
    tmux_sync_after_dispatch: boolean;
    confidence_threshold: number;
    max_consecutive_errors: number;
    lock_key?: string | null;
    lock_lease_seconds: number;
    adr_policy: "every_success" | "high_impact" | "manual";
    pause_reason?: string | null;
  }): TriChatAutopilotStateRecord {
    const now = new Date().toISOString();
    const awayMode: TriChatAutopilotStateRecord["away_mode"] =
      params.away_mode === "safe" || params.away_mode === "aggressive" ? params.away_mode : "normal";
    const threadStatus: TriChatAutopilotStateRecord["thread_status"] =
      params.thread_status === "active" ? "active" : "archived";
    const adrPolicy: TriChatAutopilotStateRecord["adr_policy"] =
      params.adr_policy === "manual" || params.adr_policy === "high_impact"
        ? params.adr_policy
        : "every_success";
    const executeBackend: TriChatAutopilotStateRecord["execute_backend"] =
      params.execute_backend === "direct" || params.execute_backend === "tmux"
        ? params.execute_backend
        : "auto";
    const lockKey = String(params.lock_key ?? "").trim();
    const normalized = {
      enabled: Boolean(params.enabled),
      away_mode: awayMode,
      interval_seconds: parseBoundedInt(params.interval_seconds, 300, 10, 86400),
      thread_id: String(params.thread_id ?? "").trim() || "trichat-autopilot-internal",
      thread_title: String(params.thread_title ?? "").trim() || "TriChat Autopilot",
      thread_status: threadStatus,
      objective:
        String(params.objective ?? "").trim() ||
        "Autopilot heartbeat: propose one high-leverage improvement for MCP server reliability and TriChat interop.",
      max_rounds: parseBoundedInt(params.max_rounds, 2, 1, 6),
      min_success_agents: parseBoundedInt(params.min_success_agents, 2, 1, 3),
      bridge_timeout_seconds: parseBoundedInt(params.bridge_timeout_seconds, 180, 5, 7200),
      bridge_dry_run: Boolean(params.bridge_dry_run),
      execute_enabled: Boolean(params.execute_enabled),
      command_allowlist: dedupeNonEmpty(params.command_allowlist ?? []),
      execute_backend: executeBackend,
      tmux_session_name: String(params.tmux_session_name ?? "").trim() || "trichat-autopilot",
      tmux_worker_count: parseBoundedInt(params.tmux_worker_count, 3, 1, 12),
      tmux_max_queue_per_worker: parseBoundedInt(params.tmux_max_queue_per_worker, 6, 1, 200),
      tmux_auto_scale_workers: Boolean(params.tmux_auto_scale_workers),
      tmux_sync_after_dispatch: Boolean(params.tmux_sync_after_dispatch),
      confidence_threshold: parseBoundedFloat(params.confidence_threshold, 0.45, 0.05, 1),
      max_consecutive_errors: parseBoundedInt(params.max_consecutive_errors, 3, 1, 20),
      lock_key: lockKey || null,
      lock_lease_seconds: parseBoundedInt(params.lock_lease_seconds, 600, 15, 3600),
      adr_policy: adrPolicy,
      pause_reason: asNullableString(params.pause_reason),
    };
    const configJson = stableStringify({
      away_mode: normalized.away_mode,
      interval_seconds: normalized.interval_seconds,
      thread_id: normalized.thread_id,
      thread_title: normalized.thread_title,
      thread_status: normalized.thread_status,
      objective: normalized.objective,
      max_rounds: normalized.max_rounds,
      min_success_agents: normalized.min_success_agents,
      bridge_timeout_seconds: normalized.bridge_timeout_seconds,
      bridge_dry_run: normalized.bridge_dry_run,
      execute_enabled: normalized.execute_enabled,
      command_allowlist: normalized.command_allowlist,
      execute_backend: normalized.execute_backend,
      tmux_session_name: normalized.tmux_session_name,
      tmux_worker_count: normalized.tmux_worker_count,
      tmux_max_queue_per_worker: normalized.tmux_max_queue_per_worker,
      tmux_auto_scale_workers: normalized.tmux_auto_scale_workers,
      tmux_sync_after_dispatch: normalized.tmux_sync_after_dispatch,
      confidence_threshold: normalized.confidence_threshold,
      max_consecutive_errors: normalized.max_consecutive_errors,
      lock_key: normalized.lock_key,
      lock_lease_seconds: normalized.lock_lease_seconds,
      adr_policy: normalized.adr_policy,
      pause_reason: normalized.pause_reason,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.autopilot", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  getTriChatTmuxControllerState(): TriChatTmuxControllerStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("trichat.tmux_controller") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    const tasksRaw = Array.isArray(config.tasks) ? (config.tasks as unknown[]) : [];
    const tasks = tasksRaw
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const item = entry as Record<string, unknown>;
        const taskId = String(item.task_id ?? "").trim();
        const command = String(item.command ?? "").trim();
        if (!taskId || !command) {
          return null;
        }
        const statusRaw = String(item.status ?? "queued").trim().toLowerCase();
        const status: TriChatTmuxControllerTaskStatus =
          statusRaw === "dispatched" ||
          statusRaw === "running" ||
          statusRaw === "completed" ||
          statusRaw === "failed" ||
          statusRaw === "cancelled"
            ? statusRaw
            : "queued";
        const createdAtFallback = new Date().toISOString();
        return {
          task_id: taskId,
          seq: parseBoundedInt(item.seq, index + 1, 1, 10_000_000),
          title: String(item.title ?? taskId).trim() || taskId,
          command,
          priority: parseBoundedInt(item.priority, 50, 1, 100),
          complexity: parseBoundedInt(item.complexity, 50, 1, 100),
          worker_id: asNullableString(item.worker_id),
          status,
          created_at: normalizeIsoTimestamp(asNullableString(item.created_at) ?? undefined, createdAtFallback),
          dispatched_at: normalizeOptionalIsoTimestamp(asNullableString(item.dispatched_at)),
          started_at: normalizeOptionalIsoTimestamp(asNullableString(item.started_at)),
          completed_at: normalizeOptionalIsoTimestamp(asNullableString(item.completed_at)),
          exit_code:
            typeof item.exit_code === "number" && Number.isFinite(item.exit_code)
              ? Math.trunc(item.exit_code)
              : item.exit_code === null
                ? null
                : Number.isFinite(Number(item.exit_code))
                  ? Math.trunc(Number(item.exit_code))
                  : null,
          thread_id: asNullableString(item.thread_id),
          turn_id: asNullableString(item.turn_id),
          metadata: parseLooseObject(item.metadata),
        } satisfies TriChatTmuxControllerTaskRecord;
      })
      .filter((entry): entry is TriChatTmuxControllerTaskRecord => Boolean(entry))
      .sort((left, right) => left.seq - right.seq);

    return {
      enabled: Number(row.enabled ?? 0) === 1,
      session_name: String(config.session_name ?? "trichat-controller").trim() || "trichat-controller",
      workspace: String(config.workspace ?? ".").trim() || ".",
      worker_count: parseBoundedInt(config.worker_count, 3, 1, 12),
      shell: String(config.shell ?? "/bin/zsh").trim() || "/bin/zsh",
      max_queue_per_worker: parseBoundedInt(config.max_queue_per_worker, 8, 1, 200),
      next_task_seq: parseBoundedInt(config.next_task_seq, tasks.length + 1, 1, 100_000_000),
      tasks,
      last_dispatch_at: normalizeOptionalIsoTimestamp(asNullableString(config.last_dispatch_at)),
      last_error: asNullableString(config.last_error),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setTriChatTmuxControllerState(params: {
    enabled: boolean;
    session_name: string;
    workspace: string;
    worker_count: number;
    shell: string;
    max_queue_per_worker: number;
    next_task_seq: number;
    tasks: TriChatTmuxControllerTaskRecord[];
    last_dispatch_at?: string | null;
    last_error?: string | null;
  }): TriChatTmuxControllerStateRecord {
    const now = new Date().toISOString();
    const normalizedTasks = (params.tasks ?? [])
      .map((task, index) => {
        const taskId = String(task.task_id ?? "").trim();
        const command = String(task.command ?? "").trim();
        if (!taskId || !command) {
          return null;
        }
        const statusRaw = String(task.status ?? "queued").trim().toLowerCase();
        const status: TriChatTmuxControllerTaskStatus =
          statusRaw === "dispatched" ||
          statusRaw === "running" ||
          statusRaw === "completed" ||
          statusRaw === "failed" ||
          statusRaw === "cancelled"
            ? statusRaw
            : "queued";
        return {
          task_id: taskId,
          seq: parseBoundedInt(task.seq, index + 1, 1, 10_000_000),
          title: String(task.title ?? taskId).trim() || taskId,
          command,
          priority: parseBoundedInt(task.priority, 50, 1, 100),
          complexity: parseBoundedInt(task.complexity, 50, 1, 100),
          worker_id: asNullableString(task.worker_id),
          status,
          created_at: normalizeIsoTimestamp(asNullableString(task.created_at) ?? undefined, now),
          dispatched_at: normalizeOptionalIsoTimestamp(asNullableString(task.dispatched_at)),
          started_at: normalizeOptionalIsoTimestamp(asNullableString(task.started_at)),
          completed_at: normalizeOptionalIsoTimestamp(asNullableString(task.completed_at)),
          exit_code:
            typeof task.exit_code === "number" && Number.isFinite(task.exit_code)
              ? Math.trunc(task.exit_code)
              : task.exit_code === null
                ? null
                : Number.isFinite(Number(task.exit_code))
                  ? Math.trunc(Number(task.exit_code))
                  : null,
          thread_id: asNullableString(task.thread_id),
          turn_id: asNullableString(task.turn_id),
          metadata: parseLooseObject(task.metadata),
        } satisfies TriChatTmuxControllerTaskRecord;
      })
      .filter((entry): entry is TriChatTmuxControllerTaskRecord => Boolean(entry))
      .sort((left, right) => left.seq - right.seq);

    const normalized: TriChatTmuxControllerStateRecord = {
      enabled: Boolean(params.enabled),
      session_name: String(params.session_name ?? "").trim() || "trichat-controller",
      workspace: String(params.workspace ?? "").trim() || ".",
      worker_count: parseBoundedInt(params.worker_count, 3, 1, 12),
      shell: String(params.shell ?? "").trim() || "/bin/zsh",
      max_queue_per_worker: parseBoundedInt(params.max_queue_per_worker, 8, 1, 200),
      next_task_seq: parseBoundedInt(params.next_task_seq, normalizedTasks.length + 1, 1, 100_000_000),
      tasks: normalizedTasks,
      last_dispatch_at: normalizeOptionalIsoTimestamp(asNullableString(params.last_dispatch_at)),
      last_error: asNullableString(params.last_error),
      updated_at: now,
    };

    const configJson = stableStringify({
      session_name: normalized.session_name,
      workspace: normalized.workspace,
      worker_count: normalized.worker_count,
      shell: normalized.shell,
      max_queue_per_worker: normalized.max_queue_per_worker,
      next_task_seq: normalized.next_task_seq,
      tasks: normalized.tasks,
      last_dispatch_at: normalized.last_dispatch_at,
      last_error: normalized.last_error,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("trichat.tmux_controller", normalized.enabled ? 1 : 0, configJson, now);

    return normalized;
  }

  getImprintAutoSnapshotState(): ImprintAutoSnapshotStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT enabled, config_json, updated_at
         FROM daemon_configs
         WHERE daemon_key = ?`
      )
      .get("imprint.auto_snapshot") as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const config = parseJsonObject(row.config_json);
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      profile_id: asNullableString(config.profile_id),
      interval_seconds: parseBoundedInt(config.interval_seconds, 900, 30, 86400),
      include_recent_memories: parseBoundedInt(config.include_recent_memories, 20, 0, 200),
      include_recent_transcript_lines: parseBoundedInt(config.include_recent_transcript_lines, 40, 0, 1000),
      write_file: parseBoolean(config.write_file, true),
      promote_summary: parseBoolean(config.promote_summary, false),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  setImprintAutoSnapshotState(params: {
    enabled: boolean;
    profile_id?: string;
    interval_seconds: number;
    include_recent_memories: number;
    include_recent_transcript_lines: number;
    write_file: boolean;
    promote_summary: boolean;
  }): ImprintAutoSnapshotStateRecord {
    const now = new Date().toISOString();
    const normalized = {
      enabled: Boolean(params.enabled),
      profile_id: params.profile_id ? params.profile_id.trim() || null : null,
      interval_seconds: parseBoundedInt(params.interval_seconds, 900, 30, 86400),
      include_recent_memories: parseBoundedInt(params.include_recent_memories, 20, 0, 200),
      include_recent_transcript_lines: parseBoundedInt(params.include_recent_transcript_lines, 40, 0, 1000),
      write_file: Boolean(params.write_file),
      promote_summary: Boolean(params.promote_summary),
    };
    const configJson = stableStringify({
      profile_id: normalized.profile_id,
      interval_seconds: normalized.interval_seconds,
      include_recent_memories: normalized.include_recent_memories,
      include_recent_transcript_lines: normalized.include_recent_transcript_lines,
      write_file: normalized.write_file,
      promote_summary: normalized.promote_summary,
    });

    this.db
      .prepare(
        `INSERT INTO daemon_configs (daemon_key, enabled, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(daemon_key) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run("imprint.auto_snapshot", normalized.enabled ? 1 : 0, configJson, now);

    return {
      ...normalized,
      updated_at: now,
    };
  }

  upsertImprintProfile(params: {
    profile_id: string;
    title: string;
    mission: string;
    principles: string[];
    hard_constraints?: string[];
    preferred_models?: string[];
    project_roots?: string[];
    notes?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { profile_id: string; created: boolean; created_at: string; updated_at: string } {
    const profileId = params.profile_id.trim();
    if (!profileId) {
      throw new Error("profile_id is required");
    }
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT profile_id, created_at FROM imprint_profiles WHERE profile_id = ?`)
      .get(profileId) as Record<string, unknown> | undefined;

    const title = params.title.trim();
    const mission = params.mission.trim();
    if (!title || !mission) {
      throw new Error("title and mission are required");
    }

    const principles = dedupeNonEmpty(params.principles);
    const hardConstraints = dedupeNonEmpty(params.hard_constraints ?? []);
    const preferredModels = dedupeNonEmpty(params.preferred_models ?? []);
    const projectRoots = dedupeNonEmpty(params.project_roots ?? []);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO imprint_profiles (
             profile_id, created_at, updated_at, title, mission,
             principles_json, hard_constraints_json, preferred_models_json, project_roots_json,
             notes, source_client, source_model, source_agent
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          now,
          now,
          title,
          mission,
          stableStringify(principles),
          stableStringify(hardConstraints),
          stableStringify(preferredModels),
          stableStringify(projectRoots),
          params.notes?.trim() || null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      return {
        profile_id: profileId,
        created: true,
        created_at: now,
        updated_at: now,
      };
    }

    const createdAt = String(existing.created_at ?? now);
    this.db
      .prepare(
        `UPDATE imprint_profiles
         SET updated_at = ?, title = ?, mission = ?,
             principles_json = ?, hard_constraints_json = ?, preferred_models_json = ?, project_roots_json = ?,
             notes = ?, source_client = ?, source_model = ?, source_agent = ?
         WHERE profile_id = ?`
      )
      .run(
        now,
        title,
        mission,
        stableStringify(principles),
        stableStringify(hardConstraints),
        stableStringify(preferredModels),
        stableStringify(projectRoots),
        params.notes?.trim() || null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        profileId
      );
    return {
      profile_id: profileId,
      created: false,
      created_at: createdAt,
      updated_at: now,
    };
  }

  getImprintProfile(profileId = "default"): ImprintProfileRecord | null {
    const normalized = profileId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT profile_id, created_at, updated_at, title, mission,
                principles_json, hard_constraints_json, preferred_models_json, project_roots_json,
                notes, source_client, source_model, source_agent
         FROM imprint_profiles
         WHERE profile_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapImprintProfileRow(row);
  }

  insertImprintSnapshot(params: {
    id: string;
    profile_id?: string;
    summary?: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    state: Record<string, unknown>;
    snapshot_path?: string;
    memory_id?: number;
  }): { id: string; created_at: string } {
    const id = params.id.trim();
    if (!id) {
      throw new Error("snapshot id is required");
    }
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO imprint_snapshots (
           id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
           state_json, snapshot_path, memory_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.profile_id?.trim() || null,
        params.summary?.trim() || null,
        stableStringify(dedupeNonEmpty(params.tags ?? [])),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        stableStringify(params.state),
        params.snapshot_path ?? null,
        params.memory_id ?? null
      );
    return { id, created_at: createdAt };
  }

  getImprintSnapshotById(snapshotId: string): ImprintSnapshotRecord | null {
    const normalized = snapshotId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
                state_json, snapshot_path, memory_id
         FROM imprint_snapshots
         WHERE id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapImprintSnapshotRow(row);
  }

  listImprintSnapshots(params: {
    limit: number;
    profile_id?: string;
  }): ImprintSnapshotRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, params.limit));
    const profileId = params.profile_id?.trim();
    const rows = profileId
      ? (this.db
          .prepare(
            `SELECT id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
                    state_json, snapshot_path, memory_id
             FROM imprint_snapshots
             WHERE profile_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(profileId, boundedLimit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, profile_id, summary, tags_json, source_client, source_model, source_agent,
                    state_json, snapshot_path, memory_id
             FROM imprint_snapshots
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(boundedLimit) as Array<Record<string, unknown>>);
    return rows.map((row) => mapImprintSnapshotRow(row));
  }

  getLatestImprintSnapshot(profileId?: string): ImprintSnapshotRecord | null {
    const snapshots = this.listImprintSnapshots({
      limit: 1,
      profile_id: profileId,
    });
    return snapshots[0] ?? null;
  }

  countImprintSnapshots(profileId?: string): number {
    const normalized = profileId?.trim();
    const row = normalized
      ? (this.db
          .prepare(`SELECT COUNT(*) AS count FROM imprint_snapshots WHERE profile_id = ?`)
          .get(normalized) as Record<string, unknown>)
      : (this.db
          .prepare(`SELECT COUNT(*) AS count FROM imprint_snapshots`)
          .get() as Record<string, unknown>);
    return Number(row.count ?? 0);
  }

  createTask(params: {
    task_id?: string;
    objective: string;
    project_dir: string;
    payload?: Record<string, unknown>;
    priority?: number;
    max_attempts?: number;
    available_at?: string;
    source?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): { created: boolean; task: TaskRecord } {
    const now = new Date().toISOString();
    const taskId = params.task_id?.trim() || crypto.randomUUID();
    const existing = this.getTaskById(taskId);
    if (existing) {
      return {
        created: false,
        task: existing,
      };
    }

    const objective = params.objective.trim();
    if (!objective) {
      throw new Error("task objective is required");
    }
    const projectDir = params.project_dir.trim();
    if (!projectDir) {
      throw new Error("task project_dir is required");
    }

    const priority = parseBoundedInt(params.priority, 0, 0, 100);
    const maxAttempts = parseBoundedInt(params.max_attempts, 3, 1, 20);
    const availableAt = normalizeIsoTimestamp(params.available_at, now);
    const tags = dedupeNonEmpty(params.tags ?? []);
    const payload = params.payload ?? {};
    const metadata = params.metadata ?? {};

    const create = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO tasks (
             task_id, created_at, updated_at, status, priority, objective, project_dir,
             payload_json, source, source_client, source_model, source_agent,
             tags_json, metadata_json, max_attempts, attempt_count, available_at,
             started_at, finished_at, last_worker_id, last_error, result_json
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL)
           ON CONFLICT(task_id) DO NOTHING`
        )
        .run(
          taskId,
          now,
          now,
          priority,
          objective,
          projectDir,
          stableStringify(payload),
          params.source ?? null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null,
          stableStringify(tags),
          stableStringify(metadata),
          maxAttempts,
          availableAt
        );
      const insertedCount = Number(inserted.changes ?? 0);
      if (insertedCount > 0) {
        this.appendTaskEvent({
          task_id: taskId,
          event_type: "created",
          to_status: "pending",
          summary: "Task created.",
          details: {
            priority,
            max_attempts: maxAttempts,
          },
        });
      }
      return insertedCount > 0;
    });
    const created = create();

    const task = this.getTaskById(taskId);
    if (!task) {
      throw new Error(`Failed to read task after create: ${taskId}`);
    }
    return {
      created,
      task,
    };
  }

  listTasks(params: {
    status?: TaskStatus;
    limit: number;
  }): TaskRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const rows = params.status
      ? (this.db
          .prepare(
            `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                    t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                    t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                    t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                    l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                    l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             WHERE t.status = ?
             ORDER BY t.priority DESC, t.created_at ASC
             LIMIT ?`
          )
          .all(params.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                    t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                    t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                    t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                    l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                    l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             ORDER BY
               CASE t.status
                 WHEN 'running' THEN 0
                 WHEN 'pending' THEN 1
                 WHEN 'failed' THEN 2
                 WHEN 'completed' THEN 3
                 ELSE 4
               END,
               t.priority DESC,
               t.updated_at DESC
             LIMIT ?`
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map((row) => mapTaskRow(row));
  }

  getTaskById(taskId: string): TaskRecord | null {
    const normalized = taskId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                l.owner_id AS lease_owner_id, l.lease_expires_at AS lease_expires_at,
                l.heartbeat_at AS lease_heartbeat_at, l.created_at AS lease_created_at, l.updated_at AS lease_updated_at
         FROM tasks t
         LEFT JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.task_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTaskRow(row);
  }

  claimTask(params: {
    worker_id: string;
    lease_seconds: number;
    task_id?: string;
  }): { claimed: boolean; reason: string; task?: TaskRecord; lease_expires_at?: string } {
    const workerId = params.worker_id.trim();
    if (!workerId) {
      throw new Error("worker_id is required");
    }
    const leaseSeconds = parseBoundedInt(params.lease_seconds, 300, 15, 86400);
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const claim = this.db.transaction(() => {
      let candidateId: string | null = null;
      if (params.task_id && params.task_id.trim()) {
        const specific = this.db
          .prepare(
            `SELECT t.task_id, t.status, t.available_at, l.owner_id AS lease_owner_id, l.lease_expires_at
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             WHERE t.task_id = ?`
          )
          .get(params.task_id.trim()) as Record<string, unknown> | undefined;
        if (!specific) {
          return {
            claimed: false,
            reason: "not-found",
          };
        }
        const status = normalizeTaskStatus(specific.status);
        const availableAt = String(specific.available_at ?? "");
        const leaseOwner = asNullableString(specific.lease_owner_id);
        const leaseExpiry = asNullableString(specific.lease_expires_at);
        if (status !== "pending") {
          return {
            claimed: false,
            reason: `not-pending:${status}`,
          };
        }
        if (availableAt > now) {
          return {
            claimed: false,
            reason: "not-ready",
          };
        }
        if (leaseOwner && leaseExpiry && leaseExpiry > now) {
          return {
            claimed: false,
            reason: "leased",
          };
        }
        candidateId = String(specific.task_id ?? "");
      } else {
        const candidate = this.db
          .prepare(
            `SELECT t.task_id
             FROM tasks t
             LEFT JOIN task_leases l ON l.task_id = t.task_id
             WHERE t.status = 'pending'
               AND t.available_at <= ?
               AND (l.task_id IS NULL OR l.lease_expires_at <= ?)
             ORDER BY t.priority DESC, t.created_at ASC
             LIMIT 1`
          )
          .get(now, now) as Record<string, unknown> | undefined;
        if (!candidate) {
          return {
            claimed: false,
            reason: "none-available",
          };
        }
        candidateId = String(candidate.task_id ?? "");
      }

      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'running',
               updated_at = ?,
               attempt_count = attempt_count + 1,
               started_at = ?,
               finished_at = NULL,
               last_worker_id = ?
           WHERE task_id = ?
             AND status = 'pending'
             AND available_at <= ?`
        )
        .run(now, now, workerId, candidateId, now);
      if (Number(updated.changes ?? 0) <= 0) {
        return {
          claimed: false,
          reason: "race-lost",
        };
      }

      this.db
        .prepare(
          `INSERT INTO task_leases (task_id, owner_id, lease_expires_at, heartbeat_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             lease_expires_at = excluded.lease_expires_at,
             heartbeat_at = excluded.heartbeat_at,
             updated_at = excluded.updated_at`
        )
        .run(candidateId, workerId, leaseExpiresAt, now, now, now);

      this.appendTaskEvent({
        task_id: candidateId,
        event_type: "claimed",
        from_status: "pending",
        to_status: "running",
        worker_id: workerId,
        summary: "Task claimed for execution.",
        details: {
          lease_seconds: leaseSeconds,
          lease_expires_at: leaseExpiresAt,
        },
      });

      const task = this.getTaskById(candidateId);
      if (!task) {
        throw new Error(`Claimed task vanished: ${candidateId}`);
      }
      return {
        claimed: true,
        reason: "claimed",
        task,
        lease_expires_at: leaseExpiresAt,
      };
    });

    return claim();
  }

  heartbeatTaskLease(params: {
    task_id: string;
    worker_id: string;
    lease_seconds: number;
  }): {
    ok: boolean;
    reason: string;
    task_id: string;
    owner_id?: string;
    lease_expires_at?: string;
    heartbeat_at?: string;
  } {
    const taskId = params.task_id.trim();
    const workerId = params.worker_id.trim();
    if (!taskId || !workerId) {
      throw new Error("task_id and worker_id are required");
    }
    const leaseSeconds = parseBoundedInt(params.lease_seconds, 300, 15, 86400);
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const lease = this.db
      .prepare(
        `SELECT owner_id, lease_expires_at
         FROM task_leases
         WHERE task_id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!lease) {
      return {
        ok: false,
        reason: "lease-not-found",
        task_id: taskId,
      };
    }
    const ownerId = String(lease.owner_id ?? "");
    if (ownerId !== workerId) {
      return {
        ok: false,
        reason: "owner-mismatch",
        task_id: taskId,
        owner_id: ownerId,
        lease_expires_at: String(lease.lease_expires_at ?? ""),
      };
    }

    const heartbeat = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE task_leases
           SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE task_id = ?`
        )
        .run(leaseExpiresAt, now, now, taskId);
      this.db
        .prepare(`UPDATE tasks SET updated_at = ? WHERE task_id = ?`)
        .run(now, taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "heartbeat",
        from_status: "running",
        to_status: "running",
        worker_id: workerId,
        summary: "Task lease heartbeat.",
        details: {
          lease_seconds: leaseSeconds,
          lease_expires_at: leaseExpiresAt,
        },
      });
    });
    heartbeat();

    return {
      ok: true,
      reason: "heartbeat-recorded",
      task_id: taskId,
      owner_id: workerId,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
    };
  }

  completeTask(params: {
    task_id: string;
    worker_id: string;
    result?: Record<string, unknown>;
    summary?: string;
  }): { completed: boolean; reason: string; task?: TaskRecord } {
    const taskId = params.task_id.trim();
    const workerId = params.worker_id.trim();
    if (!taskId || !workerId) {
      throw new Error("task_id and worker_id are required");
    }
    const now = new Date().toISOString();

    const complete = this.db.transaction(() => {
      const lease = this.db
        .prepare(`SELECT owner_id FROM task_leases WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown> | undefined;
      if (!lease) {
        return {
          completed: false,
          reason: "lease-not-found",
        };
      }
      const ownerId = String(lease.owner_id ?? "");
      if (ownerId !== workerId) {
        return {
          completed: false,
          reason: "owner-mismatch",
        };
      }
      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'completed',
               updated_at = ?,
               finished_at = ?,
               last_worker_id = ?,
               last_error = NULL,
               result_json = ?
           WHERE task_id = ?
             AND status = 'running'`
        )
        .run(now, now, workerId, stableStringify(params.result ?? {}), taskId);
      if (Number(updated.changes ?? 0) <= 0) {
        return {
          completed: false,
          reason: "not-running",
        };
      }
      this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "completed",
        from_status: "running",
        to_status: "completed",
        worker_id: workerId,
        summary: params.summary?.trim() || "Task completed successfully.",
        details: {
          result_keys: Object.keys(params.result ?? {}),
        },
      });
      const task = this.getTaskById(taskId);
      return {
        completed: true,
        reason: "completed",
        task: task ?? undefined,
      };
    });
    return complete();
  }

  failTask(params: {
    task_id: string;
    worker_id: string;
    error: string;
    result?: Record<string, unknown>;
    summary?: string;
  }): { failed: boolean; reason: string; task?: TaskRecord } {
    const taskId = params.task_id.trim();
    const workerId = params.worker_id.trim();
    const errorText = params.error.trim();
    if (!taskId || !workerId || !errorText) {
      throw new Error("task_id, worker_id, and error are required");
    }
    const now = new Date().toISOString();

    const fail = this.db.transaction(() => {
      const lease = this.db
        .prepare(`SELECT owner_id FROM task_leases WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown> | undefined;
      if (!lease) {
        return {
          failed: false,
          reason: "lease-not-found",
        };
      }
      const ownerId = String(lease.owner_id ?? "");
      if (ownerId !== workerId) {
        return {
          failed: false,
          reason: "owner-mismatch",
        };
      }
      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'failed',
               updated_at = ?,
               finished_at = ?,
               last_worker_id = ?,
               last_error = ?,
               result_json = ?
           WHERE task_id = ?
             AND status = 'running'`
        )
        .run(now, now, workerId, errorText, stableStringify(params.result ?? {}), taskId);
      if (Number(updated.changes ?? 0) <= 0) {
        return {
          failed: false,
          reason: "not-running",
        };
      }
      this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "failed",
        from_status: "running",
        to_status: "failed",
        worker_id: workerId,
        summary: params.summary?.trim() || "Task failed during execution.",
        details: {
          error: errorText,
          result_keys: Object.keys(params.result ?? {}),
        },
      });
      const task = this.getTaskById(taskId);
      return {
        failed: true,
        reason: "failed",
        task: task ?? undefined,
      };
    });
    return fail();
  }

  retryTask(params: {
    task_id: string;
    delay_seconds: number;
    reason?: string;
    force?: boolean;
  }): { retried: boolean; reason: string; task?: TaskRecord; available_at?: string } {
    const taskId = params.task_id.trim();
    if (!taskId) {
      throw new Error("task_id is required");
    }
    const delaySeconds = parseBoundedInt(params.delay_seconds, 0, 0, 86400);
    const now = new Date().toISOString();
    const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

    const retry = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT status, attempt_count, max_attempts FROM tasks WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown> | undefined;
      if (!existing) {
        return {
          retried: false,
          reason: "not-found",
        };
      }
      const status = normalizeTaskStatus(existing.status);
      const attemptCount = Number(existing.attempt_count ?? 0);
      const maxAttempts = Number(existing.max_attempts ?? 3);
      if (status !== "failed" && status !== "cancelled") {
        return {
          retried: false,
          reason: `not-retryable:${status}`,
        };
      }
      if (!params.force && attemptCount >= maxAttempts) {
        return {
          retried: false,
          reason: "max-attempts-exceeded",
        };
      }

      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'pending',
               updated_at = ?,
               available_at = ?,
               started_at = NULL,
               finished_at = NULL,
               last_error = NULL,
               result_json = NULL
           WHERE task_id = ?`
        )
        .run(now, availableAt, taskId);
      this.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.appendTaskEvent({
        task_id: taskId,
        event_type: "retried",
        from_status: status,
        to_status: "pending",
        summary: params.reason?.trim() || "Task scheduled for retry.",
        details: {
          delay_seconds: delaySeconds,
          available_at: availableAt,
          force: Boolean(params.force),
        },
      });
      const task = this.getTaskById(taskId);
      return {
        retried: true,
        reason: "retried",
        task: task ?? undefined,
        available_at: availableAt,
      };
    });
    return retry();
  }

  listFailedTasksForAutoRetry(limit: number): Array<{
    task_id: string;
    attempt_count: number;
    max_attempts: number;
    finished_at: string | null;
    last_error: string | null;
  }> {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT t.task_id, t.attempt_count, t.max_attempts, t.finished_at, t.last_error
         FROM tasks t
         LEFT JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.status = 'failed'
           AND t.attempt_count < t.max_attempts
           AND (l.task_id IS NULL OR l.lease_expires_at <= ?)
         ORDER BY
           COALESCE(t.finished_at, t.updated_at) ASC,
           t.updated_at ASC,
           t.task_id ASC
         LIMIT ?`
      )
      .all(new Date().toISOString(), boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      task_id: String(row.task_id ?? ""),
      attempt_count: Number(row.attempt_count ?? 0),
      max_attempts: Number(row.max_attempts ?? 0),
      finished_at: asNullableString(row.finished_at),
      last_error: asNullableString(row.last_error),
    }));
  }

  getTaskTimeline(taskId: string, limit: number): TaskEventRecord[] {
    const normalized = taskId.trim();
    if (!normalized) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db
      .prepare(
        `SELECT id, task_id, created_at, event_type, from_status, to_status, worker_id, summary, details_json
         FROM task_events
         WHERE task_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(normalized, boundedLimit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTaskEventRow(row));
  }

  getTaskSummary(params?: {
    running_limit?: number;
  }): TaskSummaryRecord {
    const runningLimit = parseBoundedInt(params?.running_limit, 10, 1, 200);
    const countRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM tasks
         GROUP BY status`
      )
      .all() as Array<Record<string, unknown>>;

    const counts: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      failed: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const row of countRows) {
      const status = normalizeTaskStatus(row.status);
      counts[status] = Number(row.count ?? 0);
    }

    const runningRows = this.db
      .prepare(
        `SELECT t.task_id, t.objective, t.updated_at, t.attempt_count, t.max_attempts,
                l.owner_id, l.lease_expires_at
         FROM tasks t
         LEFT JOIN task_leases l ON l.task_id = t.task_id
         WHERE t.status = 'running'
         ORDER BY t.priority DESC, t.updated_at DESC
         LIMIT ?`
      )
      .all(runningLimit) as Array<Record<string, unknown>>;

    const failedRow = this.db
      .prepare(
        `SELECT task_id, last_error, attempt_count, max_attempts, updated_at
         FROM tasks
         WHERE status = 'failed'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;

    return {
      counts,
      running: runningRows.map((row) => ({
        task_id: String(row.task_id ?? ""),
        objective: String(row.objective ?? ""),
        owner_id: asNullableString(row.owner_id),
        lease_expires_at: asNullableString(row.lease_expires_at),
        updated_at: String(row.updated_at ?? ""),
        attempt_count: Number(row.attempt_count ?? 0),
        max_attempts: Number(row.max_attempts ?? 0),
      })),
      last_failed: failedRow
        ? {
            task_id: String(failedRow.task_id ?? ""),
            last_error: asNullableString(failedRow.last_error),
            attempt_count: Number(failedRow.attempt_count ?? 0),
            max_attempts: Number(failedRow.max_attempts ?? 0),
            updated_at: String(failedRow.updated_at ?? ""),
          }
        : null,
    };
  }

  getTriChatSummary(params?: {
    busiest_limit?: number;
  }): TriChatSummaryRecord {
    const busiestLimit = parseBoundedInt(params?.busiest_limit, 10, 1, 200);

    const threadCountRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM trichat_threads
         GROUP BY status`
      )
      .all() as Array<Record<string, unknown>>;

    const threadCounts = {
      active: 0,
      archived: 0,
      total: 0,
    };
    for (const row of threadCountRows) {
      const status = normalizeTriChatThreadStatus(row.status);
      const count = Number(row.count ?? 0);
      if (status === "archived") {
        threadCounts.archived = count;
      } else {
        threadCounts.active = count;
      }
    }
    threadCounts.total = threadCounts.active + threadCounts.archived;

    const messageAgg = this.db
      .prepare(
        `SELECT COUNT(*) AS message_count,
                MIN(created_at) AS oldest_message_at,
                MAX(created_at) AS newest_message_at
         FROM trichat_messages`
      )
      .get() as Record<string, unknown>;

    const busiestRows = this.db
      .prepare(
        `SELECT t.thread_id, t.status, t.updated_at, COUNT(m.message_id) AS message_count
         FROM trichat_threads t
         LEFT JOIN trichat_messages m ON m.thread_id = t.thread_id
         GROUP BY t.thread_id, t.status, t.updated_at
         ORDER BY message_count DESC, t.updated_at DESC
         LIMIT ?`
      )
      .all(busiestLimit) as Array<Record<string, unknown>>;

    return {
      thread_counts: threadCounts,
      message_count: Number(messageAgg.message_count ?? 0),
      oldest_message_at: asNullableString(messageAgg.oldest_message_at),
      newest_message_at: asNullableString(messageAgg.newest_message_at),
      busiest_threads: busiestRows.map((row) => ({
        thread_id: String(row.thread_id ?? ""),
        status: normalizeTriChatThreadStatus(row.status),
        updated_at: String(row.updated_at ?? ""),
        message_count: Number(row.message_count ?? 0),
      })),
    };
  }

  upsertTriChatThread(params: {
    thread_id?: string;
    title?: string;
    status?: TriChatThreadStatus;
    metadata?: Record<string, unknown>;
  }): { created: boolean; thread: TriChatThreadRecord } {
    const now = new Date().toISOString();
    const threadId = params.thread_id?.trim() || crypto.randomUUID();
    const existing = this.getTriChatThreadById(threadId);
    const status = normalizeTriChatThreadStatus(params.status);
    const metadata = params.metadata ?? {};
    const title = params.title?.trim() || null;
    this.db
      .prepare(
        `INSERT INTO trichat_threads (thread_id, created_at, updated_at, title, status, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           title = COALESCE(excluded.title, trichat_threads.title),
           status = excluded.status,
           metadata_json = excluded.metadata_json`
      )
      .run(threadId, now, now, title, status, stableStringify(metadata));
    const thread = this.getTriChatThreadById(threadId);
    if (!thread) {
      throw new Error(`Failed to read trichat thread after upsert: ${threadId}`);
    }
    return {
      created: !existing,
      thread,
    };
  }

  getTriChatThreadById(threadId: string): TriChatThreadRecord | null {
    const normalized = threadId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT thread_id, created_at, updated_at, title, status, metadata_json
         FROM trichat_threads
         WHERE thread_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatThreadRow(row);
  }

  listTriChatThreads(params: {
    status?: TriChatThreadStatus;
    limit: number;
  }): TriChatThreadRecord[] {
    const limit = Math.max(1, Math.min(500, params.limit));
    const rows = params.status
      ? (this.db
          .prepare(
            `SELECT thread_id, created_at, updated_at, title, status, metadata_json
             FROM trichat_threads
             WHERE status = ?
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(params.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT thread_id, created_at, updated_at, title, status, metadata_json
             FROM trichat_threads
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map((row) => mapTriChatThreadRow(row));
  }

  appendTriChatMessage(params: {
    thread_id: string;
    agent_id: string;
    role: string;
    content: string;
    reply_to_message_id?: string;
    metadata?: Record<string, unknown>;
  }): TriChatMessageRecord {
    const now = new Date().toISOString();
    const threadId = params.thread_id.trim();
    const agentId = params.agent_id.trim();
    const role = params.role.trim();
    const content = params.content.trim();
    const replyToMessageId = params.reply_to_message_id?.trim() || null;
    if (!threadId || !agentId || !role || !content) {
      throw new Error("thread_id, agent_id, role, and content are required");
    }
    const messageId = crypto.randomUUID();
    const metadata = params.metadata ?? {};

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO trichat_threads (thread_id, created_at, updated_at, title, status, metadata_json)
           VALUES (?, ?, ?, NULL, 'active', '{}')
           ON CONFLICT(thread_id) DO UPDATE SET
             updated_at = excluded.updated_at`
        )
        .run(threadId, now, now);
      this.db
        .prepare(
          `INSERT INTO trichat_messages (
             message_id, thread_id, created_at, agent_id, role, content, reply_to_message_id, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(messageId, threadId, now, agentId, role, content, replyToMessageId, stableStringify(metadata));
      this.db.prepare(`UPDATE trichat_threads SET updated_at = ? WHERE thread_id = ?`).run(now, threadId);
    });
    write();

    return {
      message_id: messageId,
      thread_id: threadId,
      created_at: now,
      agent_id: agentId,
      role,
      content,
      reply_to_message_id: replyToMessageId,
      metadata,
    };
  }

  getTriChatTimeline(params: {
    thread_id: string;
    limit: number;
    since?: string;
    agent_id?: string;
    role?: string;
  }): TriChatMessageRecord[] {
    const threadId = params.thread_id.trim();
    if (!threadId) {
      return [];
    }
    const limit = Math.max(1, Math.min(2000, params.limit));
    const whereClauses = ["thread_id = ?"];
    const values: Array<string | number> = [threadId];

    if (params.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }
    if (params.agent_id?.trim()) {
      whereClauses.push("agent_id = ?");
      values.push(params.agent_id.trim());
    }
    if (params.role?.trim()) {
      whereClauses.push("role = ?");
      values.push(params.role.trim());
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id, created_at, agent_id, role, content, reply_to_message_id, metadata_json
         FROM trichat_messages
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTriChatMessageRow(row));
  }

  createOrGetTriChatTurn(params: {
    turn_id?: string;
    thread_id: string;
    user_message_id: string;
    user_prompt: string;
    status?: TriChatTurnStatus;
    phase?: TriChatTurnPhase;
    phase_status?: TriChatTurnPhaseStatus;
    expected_agents?: string[];
    min_agents?: number;
    novelty_score?: number | null;
    novelty_threshold?: number | null;
    retry_required?: boolean;
    retry_agents?: string[];
    disagreement?: boolean;
    decision_summary?: string | null;
    selected_agent?: string | null;
    selected_strategy?: string | null;
    verify_status?: string | null;
    verify_summary?: string | null;
    metadata?: Record<string, unknown>;
  }): { created: boolean; turn: TriChatTurnRecord } {
    const now = new Date().toISOString();
    const threadId = params.thread_id.trim();
    const userMessageId = params.user_message_id.trim();
    const userPrompt = params.user_prompt.trim();
    if (!threadId || !userMessageId || !userPrompt) {
      throw new Error("thread_id, user_message_id, and user_prompt are required");
    }

    const existing = this.getTriChatTurnByUserMessage(threadId, userMessageId);
    if (existing) {
      return {
        created: false,
        turn: existing,
      };
    }

    const turnId = params.turn_id?.trim() || crypto.randomUUID();
    const status = normalizeTriChatTurnStatus(params.status);
    const phase = normalizeTriChatTurnPhase(params.phase);
    const phaseStatus = normalizeTriChatTurnPhaseStatus(params.phase_status);
    const expectedAgents = dedupeNonEmpty(params.expected_agents ?? []);
    const inferredMinAgents = expectedAgents.length >= 1 ? expectedAgents.length : 3;
    const minAgents = parseBoundedInt(params.min_agents, inferredMinAgents, 1, 12);
    const retryAgents = dedupeNonEmpty(params.retry_agents ?? []);
    const metadata = params.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO trichat_turns (
           turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
           started_at, finished_at, status, phase, phase_status, expected_agents_json,
           min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
           disagreement, decision_summary, selected_agent, selected_strategy,
           verify_status, verify_summary, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turnId,
        threadId,
        userMessageId,
        userPrompt,
        now,
        now,
        now,
        null,
        status,
        phase,
        phaseStatus,
        stableStringify(expectedAgents),
        minAgents,
        params.novelty_score ?? null,
        params.novelty_threshold ?? null,
        params.retry_required ? 1 : 0,
        stableStringify(retryAgents),
        params.disagreement ? 1 : 0,
        asNullableString(params.decision_summary),
        asNullableString(params.selected_agent),
        asNullableString(params.selected_strategy),
        asNullableString(params.verify_status),
        asNullableString(params.verify_summary),
        stableStringify(metadata)
      );

    const turn = this.getTriChatTurnById(turnId);
    if (!turn) {
      throw new Error(`Failed to read tri-chat turn after create: ${turnId}`);
    }
    return {
      created: true,
      turn,
    };
  }

  updateTriChatTurn(params: {
    turn_id: string;
    status?: TriChatTurnStatus;
    phase?: TriChatTurnPhase;
    phase_status?: TriChatTurnPhaseStatus;
    finished_at?: string | null;
    expected_agents?: string[];
    min_agents?: number;
    novelty_score?: number | null;
    novelty_threshold?: number | null;
    retry_required?: boolean;
    retry_agents?: string[];
    disagreement?: boolean;
    decision_summary?: string | null;
    selected_agent?: string | null;
    selected_strategy?: string | null;
    verify_status?: string | null;
    verify_summary?: string | null;
    metadata?: Record<string, unknown>;
  }): TriChatTurnRecord {
    const turnId = params.turn_id.trim();
    if (!turnId) {
      throw new Error("turn_id is required");
    }
    const existing = this.getTriChatTurnById(turnId);
    if (!existing) {
      throw new Error(`Tri-chat turn not found: ${turnId}`);
    }
    const now = new Date().toISOString();

    const status = normalizeTriChatTurnStatus(params.status ?? existing.status);
    const phase = normalizeTriChatTurnPhase(params.phase ?? existing.phase);
    const phaseStatus = normalizeTriChatTurnPhaseStatus(params.phase_status ?? existing.phase_status);
    const expectedAgents = dedupeNonEmpty(params.expected_agents ?? existing.expected_agents);
    const inferredMinAgents = expectedAgents.length >= 1 ? expectedAgents.length : existing.min_agents;
    const minAgents = parseBoundedInt(params.min_agents, inferredMinAgents, 1, 12);
    const retryAgents = dedupeNonEmpty(params.retry_agents ?? existing.retry_agents);
    const shouldFinish = status !== "running" || (phase === "summarize" && phaseStatus === "completed");
    const finishedAt = params.finished_at === null
      ? null
      : normalizeOptionalIsoTimestamp(params.finished_at ?? undefined) ??
          (shouldFinish ? existing.finished_at ?? now : existing.finished_at);
    const metadata = params.metadata ? { ...existing.metadata, ...params.metadata } : existing.metadata;

    this.db
      .prepare(
        `UPDATE trichat_turns
         SET updated_at = ?,
             finished_at = ?,
             status = ?,
             phase = ?,
             phase_status = ?,
             expected_agents_json = ?,
             min_agents = ?,
             novelty_score = ?,
             novelty_threshold = ?,
             retry_required = ?,
             retry_agents_json = ?,
             disagreement = ?,
             decision_summary = ?,
             selected_agent = ?,
             selected_strategy = ?,
             verify_status = ?,
             verify_summary = ?,
             metadata_json = ?
         WHERE turn_id = ?`
      )
      .run(
        now,
        finishedAt,
        status,
        phase,
        phaseStatus,
        stableStringify(expectedAgents),
        minAgents,
        params.novelty_score ?? existing.novelty_score ?? null,
        params.novelty_threshold ?? existing.novelty_threshold ?? null,
        (params.retry_required ?? existing.retry_required) ? 1 : 0,
        stableStringify(retryAgents),
        (params.disagreement ?? existing.disagreement) ? 1 : 0,
        asNullableString(params.decision_summary ?? existing.decision_summary),
        asNullableString(params.selected_agent ?? existing.selected_agent),
        asNullableString(params.selected_strategy ?? existing.selected_strategy),
        asNullableString(params.verify_status ?? existing.verify_status),
        asNullableString(params.verify_summary ?? existing.verify_summary),
        stableStringify(metadata),
        turnId
      );

    const updated = this.getTriChatTurnById(turnId);
    if (!updated) {
      throw new Error(`Failed to read tri-chat turn after update: ${turnId}`);
    }
    return updated;
  }

  getTriChatTurnById(turnId: string): TriChatTurnRecord | null {
    const normalized = turnId.trim();
    if (!normalized) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         WHERE turn_id = ?`
      )
      .get(normalized) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatTurnRow(row);
  }

  getTriChatTurnByUserMessage(threadId: string, userMessageId: string): TriChatTurnRecord | null {
    const normalizedThreadId = threadId.trim();
    const normalizedMessageId = userMessageId.trim();
    if (!normalizedThreadId || !normalizedMessageId) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         WHERE thread_id = ? AND user_message_id = ?`
      )
      .get(normalizedThreadId, normalizedMessageId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatTurnRow(row);
  }

  getLatestTriChatTurn(params: { thread_id: string; include_closed?: boolean }): TriChatTurnRecord | null {
    const threadId = params.thread_id.trim();
    if (!threadId) {
      return null;
    }
    const includeClosed = params.include_closed ?? true;
    const row = includeClosed
      ? (this.db
          .prepare(
            `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                    started_at, finished_at, status, phase, phase_status, expected_agents_json,
                    min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                    disagreement, decision_summary, selected_agent, selected_strategy,
                    verify_status, verify_summary, metadata_json
             FROM trichat_turns
             WHERE thread_id = ?
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1`
          )
          .get(threadId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                    started_at, finished_at, status, phase, phase_status, expected_agents_json,
                    min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                    disagreement, decision_summary, selected_agent, selected_strategy,
                    verify_status, verify_summary, metadata_json
             FROM trichat_turns
             WHERE thread_id = ? AND status = 'running'
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1`
          )
          .get(threadId) as Record<string, unknown> | undefined);
    if (!row) {
      return null;
    }
    return mapTriChatTurnRow(row);
  }

  listTriChatTurns(params: {
    thread_id?: string;
    status?: TriChatTurnStatus;
    phase?: TriChatTurnPhase;
    limit: number;
  }): TriChatTurnRecord[] {
    const limit = parseBoundedInt(params.limit, 25, 1, 500);
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    if (params.status) {
      whereClauses.push("status = ?");
      values.push(normalizeTriChatTurnStatus(params.status));
    }
    if (params.phase) {
      whereClauses.push("phase = ?");
      values.push(normalizeTriChatTurnPhase(params.phase));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         ${whereSql}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatTurnRow(row));
  }

  listStaleRunningTriChatTurns(params: {
    stale_before_iso: string;
    thread_id?: string;
    limit: number;
  }): TriChatTurnRecord[] {
    const staleBeforeIso = normalizeIsoTimestamp(params.stale_before_iso, new Date().toISOString());
    const limit = parseBoundedInt(params.limit, 10, 1, 500);
    const whereClauses = ["status = 'running'", "updated_at <= ?"];
    const values: Array<string | number> = [staleBeforeIso];
    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }

    const rows = this.db
      .prepare(
        `SELECT turn_id, thread_id, user_message_id, user_prompt, created_at, updated_at,
                started_at, finished_at, status, phase, phase_status, expected_agents_json,
                min_agents, novelty_score, novelty_threshold, retry_required, retry_agents_json,
                disagreement, decision_summary, selected_agent, selected_strategy,
                verify_status, verify_summary, metadata_json
         FROM trichat_turns
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY updated_at ASC, created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatTurnRow(row));
  }

  appendTriChatTurnArtifact(params: {
    turn_id: string;
    phase: TriChatTurnPhase;
    artifact_type: string;
    agent_id?: string;
    content?: string;
    structured?: Record<string, unknown>;
    score?: number | null;
    metadata?: Record<string, unknown>;
  }): TriChatTurnArtifactRecord {
    const now = new Date().toISOString();
    const turnId = params.turn_id.trim();
    const artifactType = params.artifact_type.trim();
    if (!turnId || !artifactType) {
      throw new Error("turn_id and artifact_type are required");
    }
    const turn = this.getTriChatTurnById(turnId);
    if (!turn) {
      throw new Error(`Tri-chat turn not found: ${turnId}`);
    }
    const artifactId = crypto.randomUUID();
    const phase = normalizeTriChatTurnPhase(params.phase);
    const score = typeof params.score === "number" && Number.isFinite(params.score) ? params.score : null;
    const structured = params.structured ?? {};
    const metadata = params.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO trichat_turn_artifacts (
           artifact_id, turn_id, thread_id, created_at, phase, artifact_type,
           agent_id, content, structured_json, score, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        turn.turn_id,
        turn.thread_id,
        now,
        phase,
        artifactType,
        asNullableString(params.agent_id),
        asNullableString(params.content),
        stableStringify(structured),
        score,
        stableStringify(metadata)
      );

    const row = this.db
      .prepare(
        `SELECT artifact_id, turn_id, thread_id, created_at, phase, artifact_type, agent_id, content,
                structured_json, score, metadata_json
         FROM trichat_turn_artifacts
         WHERE artifact_id = ?`
      )
      .get(artifactId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read tri-chat turn artifact after insert: ${artifactId}`);
    }
    return mapTriChatTurnArtifactRow(row);
  }

  listTriChatTurnArtifacts(params: {
    turn_id?: string;
    thread_id?: string;
    phase?: TriChatTurnPhase;
    artifact_type?: string;
    agent_id?: string;
    limit: number;
  }): TriChatTurnArtifactRecord[] {
    const limit = parseBoundedInt(params.limit, 100, 1, 2000);
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const turnId = params.turn_id?.trim();
    if (turnId) {
      whereClauses.push("turn_id = ?");
      values.push(turnId);
    }
    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    if (params.phase) {
      whereClauses.push("phase = ?");
      values.push(normalizeTriChatTurnPhase(params.phase));
    }
    const artifactType = params.artifact_type?.trim();
    if (artifactType) {
      whereClauses.push("artifact_type = ?");
      values.push(artifactType);
    }
    const agentId = params.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (whereClauses.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT artifact_id, turn_id, thread_id, created_at, phase, artifact_type, agent_id, content,
                structured_json, score, metadata_json
         FROM trichat_turn_artifacts
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTriChatTurnArtifactRow(row));
  }

  appendTriChatBusEvent(params: {
    thread_id: string;
    event_type: string;
    created_at?: string;
    source_agent?: string;
    source_client?: string;
    role?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    event_id?: string;
  }): TriChatBusEventRecord {
    const now = new Date().toISOString();
    const threadId = params.thread_id.trim();
    const eventType = params.event_type.trim();
    if (!threadId || !eventType) {
      throw new Error("thread_id and event_type are required");
    }

    const createdAt = normalizeIsoTimestamp(params.created_at, now);
    const eventId = params.event_id?.trim() || crypto.randomUUID();
    const sourceAgent = asNullableString(params.source_agent);
    const sourceClient = asNullableString(params.source_client);
    const role = asNullableString(params.role);
    const content = asNullableString(params.content);
    const metadata = params.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO trichat_bus_events (
           event_id, thread_id, created_at, source_agent, source_client, event_type, role, content, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        threadId,
        createdAt,
        sourceAgent,
        sourceClient,
        eventType,
        role,
        content,
        stableStringify(metadata)
      );

    const row = this.db
      .prepare(
        `SELECT event_seq, event_id, thread_id, created_at, source_agent, source_client, event_type, role, content, metadata_json
         FROM trichat_bus_events
         WHERE event_id = ?`
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read tri-chat bus event after insert: ${eventId}`);
    }
    return mapTriChatBusEventRow(row);
  }

  listTriChatBusEvents(params?: {
    thread_id?: string;
    source_agent?: string;
    event_types?: string[];
    since_seq?: number;
    since?: string;
    limit?: number;
  }): TriChatBusEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];

    const threadId = params?.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    const sourceAgent = params?.source_agent?.trim();
    if (sourceAgent) {
      whereClauses.push("source_agent = ?");
      values.push(sourceAgent);
    }

    const eventTypes = (params?.event_types ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }

    const sinceSeq = parseBoundedInt(params?.since_seq, 0, 0, Number.MAX_SAFE_INTEGER);
    if (sinceSeq > 0) {
      whereClauses.push("event_seq > ?");
      values.push(sinceSeq);
    }

    if (params?.since?.trim()) {
      whereClauses.push("created_at > ?");
      values.push(normalizeIsoTimestamp(params.since, params.since));
    }

    const limit = parseBoundedInt(params?.limit, 200, 1, 5000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_seq, event_id, thread_id, created_at, source_agent, source_client, event_type, role, content, metadata_json
         FROM trichat_bus_events
         ${whereSql}
         ORDER BY event_seq DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => mapTriChatBusEventRow(row));
  }

  pruneTriChatMessages(params: {
    older_than_iso: string;
    thread_id?: string;
    limit: number;
    dry_run?: boolean;
  }): { candidate_count: number; deleted_count: number; deleted_message_ids: string[] } {
    const limit = Math.max(1, Math.min(5000, params.limit));
    const whereClauses = ["created_at <= ?"];
    const values: Array<string | number> = [params.older_than_iso];
    if (params.thread_id?.trim()) {
      whereClauses.push("thread_id = ?");
      values.push(params.thread_id.trim());
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id
         FROM trichat_messages
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    const messageIds = rows
      .map((row) => String(row.message_id ?? ""))
      .filter((id) => id.length > 0);
    const threadIds = Array.from(
      new Set(rows.map((row) => String(row.thread_id ?? "")).filter((id) => id.length > 0))
    );

    if (params.dry_run || messageIds.length === 0) {
      return {
        candidate_count: messageIds.length,
        deleted_count: 0,
        deleted_message_ids: [],
      };
    }

    const deleteStmt = this.db.prepare(`DELETE FROM trichat_messages WHERE message_id = ?`);
    const latestMessageStmt = this.db.prepare(
      `SELECT MAX(created_at) AS latest_created_at
       FROM trichat_messages
       WHERE thread_id = ?`
    );
    const threadCreatedStmt = this.db.prepare(
      `SELECT created_at
       FROM trichat_threads
       WHERE thread_id = ?`
    );
    const touchThreadStmt = this.db.prepare(`UPDATE trichat_threads SET updated_at = ? WHERE thread_id = ?`);

    const apply = this.db.transaction((ids: string[], affectedThreadIds: string[]) => {
      let deleted = 0;
      for (const messageId of ids) {
        const result = deleteStmt.run(messageId);
        deleted += Number(result.changes ?? 0);
      }
      for (const threadId of affectedThreadIds) {
        const latestRow = latestMessageStmt.get(threadId) as Record<string, unknown> | undefined;
        const latestCreatedAt = asNullableString(latestRow?.latest_created_at);
        if (latestCreatedAt) {
          touchThreadStmt.run(latestCreatedAt, threadId);
          continue;
        }
        const createdRow = threadCreatedStmt.get(threadId) as Record<string, unknown> | undefined;
        const fallback = asNullableString(createdRow?.created_at) ?? new Date().toISOString();
        touchThreadStmt.run(fallback, threadId);
      }
      return deleted;
    });

    const deletedCount = apply(messageIds, threadIds);
    return {
      candidate_count: messageIds.length,
      deleted_count: deletedCount,
      deleted_message_ids: messageIds,
    };
  }

  upsertTriChatAdapterStates(params: {
    states: Array<{
      agent_id: string;
      channel: TriChatAdapterChannel;
      updated_at?: string;
      open: boolean;
      open_until?: string | null;
      failure_count: number;
      trip_count: number;
      success_count: number;
      last_error?: string | null;
      last_opened_at?: string | null;
      turn_count: number;
      degraded_turn_count: number;
      last_result?: string | null;
      metadata?: Record<string, unknown>;
    }>;
  }): TriChatAdapterStateRecord[] {
    if (!params.states.length) {
      return [];
    }

    const now = new Date().toISOString();
    const upsertStmt = this.db.prepare(
      `INSERT INTO trichat_adapter_states (
         agent_id, channel, updated_at, open, open_until, failure_count, trip_count, success_count,
         last_error, last_opened_at, turn_count, degraded_turn_count, last_result, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         updated_at = excluded.updated_at,
         open = excluded.open,
         open_until = excluded.open_until,
         failure_count = excluded.failure_count,
         trip_count = excluded.trip_count,
         success_count = excluded.success_count,
         last_error = excluded.last_error,
         last_opened_at = excluded.last_opened_at,
         turn_count = excluded.turn_count,
         degraded_turn_count = excluded.degraded_turn_count,
         last_result = excluded.last_result,
         metadata_json = excluded.metadata_json`
    );

    const apply = this.db.transaction((states: typeof params.states) => {
      const records: TriChatAdapterStateRecord[] = [];
      for (const state of states) {
        const agentId = state.agent_id.trim();
        if (!agentId) {
          continue;
        }
        const channel = normalizeTriChatAdapterChannel(state.channel);
        const updatedAt = normalizeIsoTimestamp(state.updated_at, now);
        const openUntil = normalizeOptionalIsoTimestamp(state.open_until);
        const failureCount = parseBoundedInt(state.failure_count, 0, 0, 1_000_000);
        const tripCount = parseBoundedInt(state.trip_count, 0, 0, 1_000_000);
        const successCount = parseBoundedInt(state.success_count, 0, 0, 1_000_000);
        const turnCount = parseBoundedInt(state.turn_count, 0, 0, 1_000_000);
        const degradedTurnCount = parseBoundedInt(state.degraded_turn_count, 0, 0, 1_000_000);
        const lastError = asNullableString(state.last_error);
        const lastOpenedAt = normalizeOptionalIsoTimestamp(state.last_opened_at);
        const lastResult = asNullableString(state.last_result);
        const metadata = state.metadata ?? {};

        upsertStmt.run(
          agentId,
          channel,
          updatedAt,
          state.open ? 1 : 0,
          openUntil,
          failureCount,
          tripCount,
          successCount,
          lastError,
          lastOpenedAt,
          turnCount,
          degradedTurnCount,
          lastResult,
          stableStringify(metadata)
        );

        records.push({
          agent_id: agentId,
          channel,
          updated_at: updatedAt,
          open: Boolean(state.open),
          open_until: openUntil,
          failure_count: failureCount,
          trip_count: tripCount,
          success_count: successCount,
          last_error: lastError,
          last_opened_at: lastOpenedAt,
          turn_count: turnCount,
          degraded_turn_count: degradedTurnCount,
          last_result: lastResult,
          metadata,
        });
      }
      return records;
    });

    return apply(params.states);
  }

  listTriChatAdapterStates(params?: {
    agent_id?: string;
    channel?: TriChatAdapterChannel;
    limit?: number;
  }): TriChatAdapterStateRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const agentId = params?.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params?.channel) {
      whereClauses.push("channel = ?");
      values.push(normalizeTriChatAdapterChannel(params.channel));
    }
    const limit = parseBoundedInt(params?.limit, 500, 1, 5000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT agent_id, channel, updated_at, open, open_until, failure_count, trip_count, success_count,
                last_error, last_opened_at, turn_count, degraded_turn_count, last_result, metadata_json
         FROM trichat_adapter_states
         ${whereSql}
         ORDER BY agent_id ASC, channel ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatAdapterStateRow(row));
  }

  appendTriChatAdapterEvents(params: {
    events: Array<{
      agent_id: string;
      channel: TriChatAdapterChannel;
      event_type: string;
      created_at?: string;
      open_until?: string | null;
      error_text?: string | null;
      details?: Record<string, unknown>;
    }>;
  }): TriChatAdapterEventRecord[] {
    if (!params.events.length) {
      return [];
    }
    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(
      `INSERT INTO trichat_adapter_events (
         event_id, created_at, agent_id, channel, event_type, open_until, error_text, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const apply = this.db.transaction((events: typeof params.events) => {
      const records: TriChatAdapterEventRecord[] = [];
      for (const event of events) {
        const agentId = event.agent_id.trim();
        const eventType = event.event_type.trim();
        if (!agentId || !eventType) {
          continue;
        }
        const channel = normalizeTriChatAdapterChannel(event.channel);
        const createdAt = normalizeIsoTimestamp(event.created_at, now);
        const eventId = crypto.randomUUID();
        const openUntil = normalizeOptionalIsoTimestamp(event.open_until);
        const errorText = asNullableString(event.error_text);
        const details = event.details ?? {};
        insertStmt.run(
          eventId,
          createdAt,
          agentId,
          channel,
          eventType,
          openUntil,
          errorText,
          stableStringify(details)
        );
        records.push({
          event_id: eventId,
          created_at: createdAt,
          agent_id: agentId,
          channel,
          event_type: eventType,
          open_until: openUntil,
          error_text: errorText,
          details,
        });
      }
      return records;
    });

    return apply(params.events);
  }

  listTriChatAdapterEvents(params?: {
    agent_id?: string;
    channel?: TriChatAdapterChannel;
    event_types?: string[];
    limit?: number;
  }): TriChatAdapterEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const agentId = params?.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params?.channel) {
      whereClauses.push("channel = ?");
      values.push(normalizeTriChatAdapterChannel(params.channel));
    }
    const eventTypes = (params?.event_types ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => "?").join(", ");
      whereClauses.push(`event_type IN (${placeholders})`);
      values.push(...eventTypes);
    }

    const limit = parseBoundedInt(params?.limit, 100, 0, 5000);
    if (limit === 0) {
      return [];
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_id, created_at, agent_id, channel, event_type, open_until, error_text, details_json
         FROM trichat_adapter_events
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatAdapterEventRow(row));
  }

  getTriChatAdapterTelemetrySummary(params?: {
    agent_id?: string;
    channel?: TriChatAdapterChannel;
  }): TriChatAdapterTelemetrySummaryRecord {
    const eventWhereClauses: string[] = [];
    const eventValues: Array<string | number> = [];

    const agentId = params?.agent_id?.trim();
    if (agentId) {
      eventWhereClauses.push("agent_id = ?");
      eventValues.push(agentId);
    }
    if (params?.channel) {
      const channel = normalizeTriChatAdapterChannel(params.channel);
      eventWhereClauses.push("channel = ?");
      eventValues.push(channel);
    }

    const eventWhereSql = eventWhereClauses.length > 0 ? `WHERE ${eventWhereClauses.join(" AND ")}` : "";
    const states = this.listTriChatAdapterStates({
      agent_id: agentId,
      channel: params?.channel,
      limit: 5000,
    });

    const eventAgg = this.db
      .prepare(
        `SELECT MAX(created_at) AS newest_event_at,
                MAX(CASE WHEN event_type = 'trip_opened' THEN created_at END) AS newest_trip_opened_at
         FROM trichat_adapter_events
         ${eventWhereSql}`
      )
      .get(...eventValues) as Record<string, unknown>;

    let newestStateAt: string | null = null;
    let openChannels = 0;
    let totalTrips = 0;
    let totalSuccesses = 0;
    let totalTurns = 0;
    let totalDegradedTurns = 0;
    const perAgent = new Map<
      string,
      {
        agent_id: string;
        channel_count: number;
        open_channels: number;
        total_trips: number;
        total_turns: number;
        degraded_turns: number;
        updated_at: string | null;
      }
    >();
    for (const state of states) {
      if (state.open) {
        openChannels += 1;
      }
      totalTrips += state.trip_count;
      totalSuccesses += state.success_count;
      totalTurns += state.turn_count;
      totalDegradedTurns += state.degraded_turn_count;
      if (state.updated_at && (!newestStateAt || state.updated_at > newestStateAt)) {
        newestStateAt = state.updated_at;
      }
      const current = perAgent.get(state.agent_id) ?? {
        agent_id: state.agent_id,
        channel_count: 0,
        open_channels: 0,
        total_trips: 0,
        total_turns: 0,
        degraded_turns: 0,
        updated_at: null,
      };
      current.channel_count += 1;
      if (state.open) {
        current.open_channels += 1;
      }
      current.total_trips += state.trip_count;
      current.total_turns += state.turn_count;
      current.degraded_turns += state.degraded_turn_count;
      if (state.updated_at && (!current.updated_at || state.updated_at > current.updated_at)) {
        current.updated_at = state.updated_at;
      }
      perAgent.set(state.agent_id, current);
    }
    const perAgentRows = [...perAgent.values()].sort((left, right) =>
      left.agent_id.localeCompare(right.agent_id)
    );

    return {
      total_channels: states.length,
      open_channels: openChannels,
      total_trips: totalTrips,
      total_successes: totalSuccesses,
      total_turns: totalTurns,
      total_degraded_turns: totalDegradedTurns,
      newest_state_at: newestStateAt,
      newest_event_at: asNullableString(eventAgg.newest_event_at),
      newest_trip_opened_at: asNullableString(eventAgg.newest_trip_opened_at),
      per_agent: perAgentRows,
    };
  }

  listTriChatAdapterEventsSince(params: {
    since_iso: string;
    limit: number;
    agent_id?: string;
    channel?: TriChatAdapterChannel;
  }): TriChatAdapterEventRecord[] {
    const sinceIso = normalizeIsoTimestamp(params.since_iso, new Date().toISOString());
    const limit = parseBoundedInt(params.limit, 5000, 1, 50000);
    const whereClauses = ["created_at >= ?"];
    const values: Array<string | number> = [sinceIso];
    const agentId = params.agent_id?.trim();
    if (agentId) {
      whereClauses.push("agent_id = ?");
      values.push(agentId);
    }
    if (params.channel) {
      whereClauses.push("channel = ?");
      values.push(normalizeTriChatAdapterChannel(params.channel));
    }

    const rows = this.db
      .prepare(
        `SELECT event_id, created_at, agent_id, channel, event_type, open_until, error_text, details_json
         FROM trichat_adapter_events
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatAdapterEventRow(row));
  }

  getTriChatTurnOutcomeCountsSince(params: {
    since_iso: string;
    thread_id?: string;
  }): { total_count: number; failed_count: number } {
    const sinceIso = normalizeIsoTimestamp(params.since_iso, new Date().toISOString());
    const whereClauses = ["created_at >= ?"];
    const values: Array<string | number> = [sinceIso];
    const threadId = params.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM trichat_turns
         ${whereSql}`
      )
      .get(...values) as Record<string, unknown>;
    return {
      total_count: Number(row.total_count ?? 0),
      failed_count: Number(row.failed_count ?? 0),
    };
  }

  appendTriChatChaosEvent(params: {
    action: string;
    outcome: string;
    thread_id?: string;
    turn_id?: string;
    agent_id?: string;
    channel?: TriChatAdapterChannel;
    created_at?: string;
    details?: Record<string, unknown>;
  }): TriChatChaosEventRecord {
    const action = params.action.trim();
    const outcome = params.outcome.trim();
    if (!action || !outcome) {
      throw new Error("action and outcome are required");
    }
    const eventId = crypto.randomUUID();
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const details = params.details ?? {};
    const channel = params.channel ? normalizeTriChatAdapterChannel(params.channel) : null;

    this.db
      .prepare(
        `INSERT INTO trichat_chaos_events (
           event_id, created_at, action, thread_id, turn_id, agent_id, channel, outcome, details_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        createdAt,
        action,
        asNullableString(params.thread_id),
        asNullableString(params.turn_id),
        asNullableString(params.agent_id),
        channel,
        outcome,
        stableStringify(details)
      );

    const row = this.db
      .prepare(
        `SELECT event_id, created_at, action, thread_id, turn_id, agent_id, channel, outcome, details_json
         FROM trichat_chaos_events
         WHERE event_id = ?`
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read trichat chaos event after insert: ${eventId}`);
    }
    return mapTriChatChaosEventRow(row);
  }

  listTriChatChaosEvents(params?: {
    action?: string;
    outcome?: string;
    thread_id?: string;
    limit?: number;
  }): TriChatChaosEventRecord[] {
    const whereClauses: string[] = [];
    const values: Array<string | number> = [];
    const action = params?.action?.trim();
    if (action) {
      whereClauses.push("action = ?");
      values.push(action);
    }
    const outcome = params?.outcome?.trim();
    if (outcome) {
      whereClauses.push("outcome = ?");
      values.push(outcome);
    }
    const threadId = params?.thread_id?.trim();
    if (threadId) {
      whereClauses.push("thread_id = ?");
      values.push(threadId);
    }
    const limit = parseBoundedInt(params?.limit, 50, 1, 2000);
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT event_id, created_at, action, thread_id, turn_id, agent_id, channel, outcome, details_json
         FROM trichat_chaos_events
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatChaosEventRow(row));
  }

  appendTriChatSloSnapshot(params: {
    created_at?: string;
    window_minutes: number;
    adapter_sample_count: number;
    adapter_error_count: number;
    adapter_error_rate: number;
    adapter_latency_p95_ms?: number | null;
    turn_total_count: number;
    turn_failed_count: number;
    turn_failure_rate: number;
    metadata?: Record<string, unknown>;
  }): TriChatSloSnapshotRecord {
    const snapshotId = crypto.randomUUID();
    const createdAt = normalizeIsoTimestamp(params.created_at, new Date().toISOString());
    const metadata = params.metadata ?? {};
    const rowValues = {
      window_minutes: parseBoundedInt(params.window_minutes, 60, 1, 10080),
      adapter_sample_count: parseBoundedInt(params.adapter_sample_count, 0, 0, 1_000_000),
      adapter_error_count: parseBoundedInt(params.adapter_error_count, 0, 0, 1_000_000),
      adapter_error_rate: clampMetricRate(params.adapter_error_rate),
      adapter_latency_p95_ms:
        typeof params.adapter_latency_p95_ms === "number" && Number.isFinite(params.adapter_latency_p95_ms)
          ? Number(params.adapter_latency_p95_ms)
          : null,
      turn_total_count: parseBoundedInt(params.turn_total_count, 0, 0, 1_000_000),
      turn_failed_count: parseBoundedInt(params.turn_failed_count, 0, 0, 1_000_000),
      turn_failure_rate: clampMetricRate(params.turn_failure_rate),
    };
    this.db
      .prepare(
        `INSERT INTO trichat_slo_snapshots (
           snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
           adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
           turn_failure_rate, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshotId,
        createdAt,
        rowValues.window_minutes,
        rowValues.adapter_sample_count,
        rowValues.adapter_error_count,
        rowValues.adapter_error_rate,
        rowValues.adapter_latency_p95_ms,
        rowValues.turn_total_count,
        rowValues.turn_failed_count,
        rowValues.turn_failure_rate,
        stableStringify(metadata)
      );

    const row = this.db
      .prepare(
        `SELECT snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
                adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
                turn_failure_rate, metadata_json
         FROM trichat_slo_snapshots
         WHERE snapshot_id = ?`
      )
      .get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to read trichat SLO snapshot after insert: ${snapshotId}`);
    }
    return mapTriChatSloSnapshotRow(row);
  }

  getLatestTriChatSloSnapshot(): TriChatSloSnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
                adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
                turn_failure_rate, metadata_json
         FROM trichat_slo_snapshots
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTriChatSloSnapshotRow(row);
  }

  listTriChatSloSnapshots(params?: { limit?: number }): TriChatSloSnapshotRecord[] {
    const limit = parseBoundedInt(params?.limit, 25, 1, 1000);
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, created_at, window_minutes, adapter_sample_count, adapter_error_count,
                adapter_error_rate, adapter_latency_p95_ms, turn_total_count, turn_failed_count,
                turn_failure_rate, metadata_json
         FROM trichat_slo_snapshots
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTriChatSloSnapshotRow(row));
  }

  getTranscriptById(transcriptId: string): TranscriptRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
         FROM transcripts
         WHERE id = ?`
      )
      .get(transcriptId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTranscriptRow(row);
  }

  getTranscriptsBySession(sessionId: string): TranscriptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
         FROM transcripts
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptRow(row));
  }

  searchTranscripts(params: {
    query?: string;
    session_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    limit: number;
  }): TranscriptRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
             FROM transcripts
             WHERE text LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
             FROM transcripts
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit * 20) as Array<Record<string, unknown>>);

    const results: TranscriptRecord[] = [];
    for (const row of rows) {
      const transcript = mapTranscriptRow(row);
      if (params.session_id && params.session_id !== transcript.session_id) {
        continue;
      }
      if (params.source_client && params.source_client !== transcript.source_client) {
        continue;
      }
      if (params.source_model && params.source_model !== transcript.source_model) {
        continue;
      }
      if (params.source_agent && params.source_agent !== transcript.source_agent) {
        continue;
      }
      transcript.score = computeTermScore(transcript.text, query);
      results.push(transcript);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  beginMutation(toolName: string, mutation: MutationMeta, payload: unknown): MutationStartResult {
    const now = new Date().toISOString();
    const payloadHash = hashPayload(payload);
    const existing = this.db
      .prepare(
        `SELECT tool_name, side_effect_fingerprint, status, result_json, error_text
         FROM mutation_journal
         WHERE idempotency_key = ?`
      )
      .get(mutation.idempotency_key) as Record<string, unknown> | undefined;

    if (existing) {
      const existingTool = String(existing.tool_name ?? "");
      const existingFingerprint = String(existing.side_effect_fingerprint ?? "");
      const status = String(existing.status ?? "unknown");
      const resultJson = asNullableString(existing.result_json);
      const errorText = asNullableString(existing.error_text);

      if (existingTool !== toolName) {
        throw new Error(
          `Idempotency key already used by a different tool (expected ${existingTool}, got ${toolName}).`
        );
      }
      if (existingFingerprint !== mutation.side_effect_fingerprint) {
        throw new Error("Idempotency key reuse with mismatched side_effect_fingerprint.");
      }
      if (status === "done") {
        return {
          replayed: true,
          result: parseJsonUnknown(resultJson),
        };
      }
      if (status === "failed") {
        throw new Error(`Previous mutation failed for key ${mutation.idempotency_key}: ${errorText ?? "unknown"}`);
      }
      throw new Error(`Mutation key is already in progress: ${mutation.idempotency_key}`);
    }

    this.db
      .prepare(
        `INSERT INTO mutation_journal (
          idempotency_key, tool_name, side_effect_fingerprint, payload_hash,
          status, result_json, error_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(
        mutation.idempotency_key,
        toolName,
        mutation.side_effect_fingerprint,
        payloadHash,
        now,
        now
      );

    return { replayed: false };
  }

  completeMutation(idempotencyKey: string, result: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mutation_journal
         SET status = 'done', result_json = ?, error_text = NULL, updated_at = ?
         WHERE idempotency_key = ?`
      )
      .run(stableStringify(result), now, idempotencyKey);
  }

  failMutation(idempotencyKey: string, errorText: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mutation_journal
         SET status = 'failed', error_text = ?, updated_at = ?
         WHERE idempotency_key = ?`
      )
      .run(errorText, now, idempotencyKey);
  }

  getMutationStatus(idempotencyKey: string): {
    idempotency_key: string;
    tool_name: string;
    side_effect_fingerprint: string;
    status: string;
    created_at: string;
    updated_at: string;
    error_text: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, tool_name, side_effect_fingerprint, status, created_at, updated_at, error_text
         FROM mutation_journal
         WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      idempotency_key: String(row.idempotency_key),
      tool_name: String(row.tool_name),
      side_effect_fingerprint: String(row.side_effect_fingerprint),
      status: String(row.status),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      error_text: asNullableString(row.error_text),
    };
  }

  insertPolicyEvaluation(params: {
    policy_name: string;
    input: unknown;
    allowed: boolean;
    reason: string;
    violations: Array<Record<string, unknown>>;
    recommendations: string[];
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO policy_evaluations (
          id, created_at, policy_name, input_json, allowed, reason, violations_json, recommendations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.policy_name,
        stableStringify(params.input),
        params.allowed ? 1 : 0,
        params.reason,
        stableStringify(params.violations),
        stableStringify(params.recommendations)
      );
    return { id, created_at: createdAt };
  }

  appendRunEvent(params: {
    run_id: string;
    event_type: "begin" | "step" | "end";
    step_index: number;
    status: string;
    summary: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const details = params.details ?? {};
    this.db
      .prepare(
        `INSERT INTO run_events (
          id, created_at, run_id, event_type, step_index, status, summary,
          source_client, source_model, source_agent, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.run_id,
        params.event_type,
        params.step_index,
        params.status,
        params.summary,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        stableStringify(details)
      );
    return { id, created_at: createdAt };
  }

  getRunTimeline(runId: string, limit: number): RunEventRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, limit));
    const rows = this.db
      .prepare(
        `SELECT id, created_at, run_id, event_type, step_index, status, summary,
                source_client, source_model, source_agent, details_json
         FROM run_events
         WHERE run_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      run_id: String(row.run_id),
      event_type: String(row.event_type) as RunEventRecord["event_type"],
      step_index: Number(row.step_index ?? 0),
      status: String(row.status),
      summary: String(row.summary),
      source_client: asNullableString(row.source_client),
      source_model: asNullableString(row.source_model),
      source_agent: asNullableString(row.source_agent),
      details: parseJsonObject(row.details_json),
    }));
  }

  acquireLock(params: {
    lock_key: string;
    owner_id: string;
    lease_seconds: number;
    metadata?: Record<string, unknown>;
  }): LockAcquireResult {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.lease_seconds * 1000).toISOString();
    const metadata = stableStringify(params.metadata ?? {});

    const existing = this.db
      .prepare(`SELECT owner_id, lease_expires_at FROM locks WHERE lock_key = ?`)
      .get(params.lock_key) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO locks (lock_key, owner_id, lease_expires_at, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(params.lock_key, params.owner_id, expiresAt, metadata, now, now);
      return {
        acquired: true,
        lock_key: params.lock_key,
        owner_id: params.owner_id,
        lease_expires_at: expiresAt,
      };
    }

    const currentOwner = String(existing.owner_id ?? "");
    const currentExpiry = String(existing.lease_expires_at ?? "");
    const isExpired = currentExpiry <= now;

    if (currentOwner === params.owner_id || isExpired) {
      this.db
        .prepare(
          `UPDATE locks
           SET owner_id = ?, lease_expires_at = ?, metadata_json = ?, updated_at = ?
           WHERE lock_key = ?`
        )
        .run(params.owner_id, expiresAt, metadata, now, params.lock_key);
      return {
        acquired: true,
        lock_key: params.lock_key,
        owner_id: params.owner_id,
        lease_expires_at: expiresAt,
        reason: currentOwner === params.owner_id ? "renewed" : "stolen-expired",
      };
    }

    return {
      acquired: false,
      lock_key: params.lock_key,
      owner_id: currentOwner,
      lease_expires_at: currentExpiry,
      reason: "held-by-active-owner",
    };
  }

  releaseLock(params: {
    lock_key: string;
    owner_id: string;
    force?: boolean;
  }): { released: boolean; reason: string } {
    const existing = this.db
      .prepare(`SELECT owner_id FROM locks WHERE lock_key = ?`)
      .get(params.lock_key) as Record<string, unknown> | undefined;
    if (!existing) {
      return { released: false, reason: "not-found" };
    }
    const ownerId = String(existing.owner_id ?? "");
    if (!params.force && ownerId !== params.owner_id) {
      return { released: false, reason: "owner-mismatch" };
    }
    this.db.prepare(`DELETE FROM locks WHERE lock_key = ?`).run(params.lock_key);
    return { released: true, reason: params.force ? "force-released" : "released" };
  }

  upsertDecision(params: {
    decision_id: string;
    title: string;
    rationale: string;
    consequences?: string;
    rollback?: string;
    links?: string[];
    tags?: string[];
    run_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { decision_id: string; created: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT decision_id FROM decisions WHERE decision_id = ?`)
      .get(params.decision_id) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO decisions (
            decision_id, created_at, updated_at, title, rationale, consequences, rollback,
            links_json, tags_json, run_id, source_client, source_model, source_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.decision_id,
          now,
          now,
          params.title,
          params.rationale,
          params.consequences ?? null,
          params.rollback ?? null,
          stableStringify(params.links ?? []),
          stableStringify(params.tags ?? []),
          params.run_id ?? null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      return { decision_id: params.decision_id, created: true };
    }

    this.db
      .prepare(
        `UPDATE decisions
         SET updated_at = ?, title = ?, rationale = ?, consequences = ?, rollback = ?,
             links_json = ?, tags_json = ?, run_id = ?, source_client = ?, source_model = ?, source_agent = ?
         WHERE decision_id = ?`
      )
      .run(
        now,
        params.title,
        params.rationale,
        params.consequences ?? null,
        params.rollback ?? null,
        stableStringify(params.links ?? []),
        stableStringify(params.tags ?? []),
        params.run_id ?? null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        params.decision_id
      );
    return { decision_id: params.decision_id, created: false };
  }

  insertDecisionLink(params: {
    decision_id: string;
    entity_type: string;
    entity_id: string;
    relation: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO decision_links (
          id, created_at, decision_id, entity_type, entity_id, relation, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.decision_id,
        params.entity_type,
        params.entity_id,
        params.relation,
        stableStringify(params.details ?? {})
      );
    return { id, created_at: createdAt };
  }

  openIncident(params: {
    severity: string;
    title: string;
    summary: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { incident_id: string; event_id: string; created_at: string } {
    const incidentId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO incidents (
          incident_id, created_at, updated_at, severity, status, title, summary,
          tags_json, source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        incidentId,
        now,
        now,
        params.severity,
        params.title,
        params.summary,
        stableStringify(params.tags ?? []),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const event = this.appendIncidentEvent({
      incident_id: incidentId,
      event_type: "opened",
      summary: params.summary,
      details: { severity: params.severity, title: params.title },
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
    });

    return { incident_id: incidentId, event_id: event.id, created_at: now };
  }

  appendIncidentEvent(params: {
    incident_id: string;
    event_type: string;
    summary: string;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO incident_events (
          id, created_at, incident_id, event_type, summary, details_json,
          source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.incident_id,
        params.event_type,
        params.summary,
        stableStringify(params.details ?? {}),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    this.db
      .prepare(`UPDATE incidents SET updated_at = ? WHERE incident_id = ?`)
      .run(createdAt, params.incident_id);

    return { id, created_at: createdAt };
  }

  getIncidentTimeline(incidentId: string, limit: number): {
    incident: IncidentRecord | null;
    events: IncidentEventRecord[];
  } {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const incidentRow = this.db
      .prepare(
        `SELECT incident_id, created_at, updated_at, severity, status, title, summary,
                tags_json, source_client, source_model, source_agent
         FROM incidents
         WHERE incident_id = ?`
      )
      .get(incidentId) as Record<string, unknown> | undefined;

    if (!incidentRow) {
      return { incident: null, events: [] };
    }

    const eventRows = this.db
      .prepare(
        `SELECT id, created_at, incident_id, event_type, summary, details_json,
                source_client, source_model, source_agent
         FROM incident_events
         WHERE incident_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(incidentId, boundedLimit) as Array<Record<string, unknown>>;

    const incident: IncidentRecord = {
      incident_id: String(incidentRow.incident_id),
      created_at: String(incidentRow.created_at),
      updated_at: String(incidentRow.updated_at),
      severity: String(incidentRow.severity),
      status: String(incidentRow.status),
      title: String(incidentRow.title),
      summary: String(incidentRow.summary),
      source_client: asNullableString(incidentRow.source_client),
      source_model: asNullableString(incidentRow.source_model),
      source_agent: asNullableString(incidentRow.source_agent),
      tags: safeParseJsonArray(incidentRow.tags_json),
    };

    const events = eventRows
      .map((row) => ({
        id: String(row.id),
        created_at: String(row.created_at),
        incident_id: String(row.incident_id),
        event_type: String(row.event_type),
        summary: String(row.summary),
        details: parseJsonObject(row.details_json),
        source_client: asNullableString(row.source_client),
        source_model: asNullableString(row.source_model),
        source_agent: asNullableString(row.source_agent),
      }))
      .reverse();

    return { incident, events };
  }

  insertAdr(params: {
    id: string;
    title: string;
    status: string;
    content: string;
  }): { id: string } {
    this.db
      .prepare(`INSERT INTO adrs (id, title, status, content) VALUES (?, ?, ?, ?)`)
      .run(params.id, params.title, params.status, params.content);
    return { id: params.id };
  }

  getTableCounts(): Record<string, number> {
    const tables = [
      "notes",
      "transcripts",
      "transcript_lines",
      "memories",
      "adrs",
      "mutation_journal",
      "policy_evaluations",
      "run_events",
      "locks",
      "decisions",
      "decision_links",
      "incidents",
      "incident_events",
      "schema_migrations",
      "daemon_configs",
      "imprint_profiles",
      "imprint_snapshots",
      "tasks",
      "task_events",
      "task_leases",
      "task_artifacts",
      "trichat_threads",
      "trichat_messages",
      "trichat_turns",
      "trichat_turn_artifacts",
      "trichat_bus_events",
      "trichat_adapter_states",
      "trichat_adapter_events",
      "trichat_chaos_events",
      "trichat_slo_snapshots",
    ] as const;
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
      counts[table] = Number(row.count ?? 0);
    }
    return counts;
  }

  private ensureMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }

  private applyPendingMigrations(
    migrations: Array<{ version: number; name: string; run: () => void }>
  ): void {
    const appliedVersions = this.getAppliedMigrationVersions();
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      this.applyMigration(migration.version, migration.name, migration.run);
      appliedVersions.add(migration.version);
    }
  }

  private getAppliedMigrationVersions(): Set<number> {
    const rows = this.db
      .prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`)
      .all() as Array<Record<string, unknown>>;
    const versions = new Set<number>();
    for (const row of rows) {
      const version = Number(row.version ?? 0);
      if (Number.isInteger(version) && version > 0) {
        versions.add(version);
      }
    }

    const userVersion = readUserVersion(this.db);
    for (let version = 1; version <= userVersion; version += 1) {
      versions.add(version);
    }
    return versions;
  }

  private applyMigration(version: number, name: string, run: () => void): void {
    const apply = this.db.transaction(() => {
      run();
      const appliedAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`
        )
        .run(version, name, appliedAt);
      this.db.exec(`PRAGMA user_version = ${version}`);
    });
    apply();
  }

  private ensureRuntimeSchemaCompleteness(): void {
    // Defensive schema replay keeps table/index guarantees intact even if
    // migration metadata was partially imported from legacy environments.
    this.applyCoreSchemaMigration();
    this.applyDaemonConfigMigration();
    this.applyImprintSchemaMigration();
    this.applyTaskSchemaMigration();
    this.applyTriChatSchemaMigration();
    this.applyTriChatAdapterTelemetryMigration();
    this.applyTriChatBusMigration();
    this.applyTriChatTurnSchemaMigration();
    this.applyTriChatReliabilitySchemaMigration();
  }

  private applyCoreSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        source TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        trust_tier TEXT NOT NULL DEFAULT 'raw',
        expires_at TEXT,
        promoted_from_note_id TEXT,
        tags_json TEXT NOT NULL,
        related_paths_json TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_client TEXT NOT NULL,
        source_model TEXT,
        source_agent TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_squished BOOLEAN DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT,
        keywords TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decay_score REAL DEFAULT 1.0
      );
      CREATE TABLE IF NOT EXISTS adrs (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS mutation_journal (
        idempotency_key TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        side_effect_fingerprint TEXT NOT NULL,
        payload_hash TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_evaluations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        policy_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        reason TEXT,
        violations_json TEXT NOT NULL,
        recommendations_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS locks (
        lock_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        consequences TEXT,
        rollback TEXT,
        links_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        run_id TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS decision_links (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS incident_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureColumn("notes", "source_client", "TEXT");
    this.ensureColumn("notes", "source_model", "TEXT");
    this.ensureColumn("notes", "source_agent", "TEXT");
    this.ensureColumn("notes", "trust_tier", "TEXT NOT NULL DEFAULT 'raw'");
    this.ensureColumn("notes", "expires_at", "TEXT");
    this.ensureColumn("notes", "promoted_from_note_id", "TEXT");
    this.ensureColumn("transcripts", "source_model", "TEXT");
    this.ensureColumn("transcripts", "source_agent", "TEXT");

    this.ensureIndex("idx_notes_created", "notes", "created_at DESC");
    this.ensureIndex("idx_notes_trust", "notes", "trust_tier");
    this.ensureIndex("idx_transcripts_session", "transcripts", "session_id, created_at ASC");
    this.ensureIndex("idx_transcript_lines_run", "transcript_lines", "run_id, timestamp ASC");
    this.ensureIndex("idx_transcript_lines_squished", "transcript_lines", "is_squished, timestamp ASC");
    this.ensureIndex("idx_memories_created", "memories", "created_at DESC");
    this.ensureIndex("idx_memories_last_accessed", "memories", "last_accessed_at DESC");
    this.ensureIndex("idx_memories_keywords", "memories", "keywords");
    this.ensureIndex("idx_adrs_status", "adrs", "status");
    this.ensureIndex("idx_run_events_run", "run_events", "run_id, created_at ASC");
    this.ensureIndex("idx_incident_events_incident", "incident_events", "incident_id, created_at ASC");
  }

  private applyDaemonConfigMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_configs (
        daemon_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private applyImprintSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imprint_profiles (
        profile_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        mission TEXT NOT NULL,
        principles_json TEXT NOT NULL,
        hard_constraints_json TEXT NOT NULL,
        preferred_models_json TEXT NOT NULL,
        project_roots_json TEXT NOT NULL,
        notes TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS imprint_snapshots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        profile_id TEXT,
        summary TEXT,
        tags_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        state_json TEXT NOT NULL,
        snapshot_path TEXT,
        memory_id INTEGER
      );
    `);

    this.ensureIndex("idx_imprint_profiles_updated", "imprint_profiles", "updated_at DESC");
    this.ensureIndex("idx_imprint_snapshots_created", "imprint_snapshots", "created_at DESC");
    this.ensureIndex("idx_imprint_snapshots_profile", "imprint_snapshots", "profile_id, created_at DESC");
  }

  private applyTaskSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        objective TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_worker_id TEXT,
        last_error TEXT,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        worker_id TEXT,
        summary TEXT,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        content_json TEXT
      );
    `);

    this.ensureIndex("idx_tasks_status_available", "tasks", "status, available_at, priority DESC, created_at ASC");
    this.ensureIndex("idx_tasks_updated", "tasks", "updated_at DESC");
    this.ensureIndex("idx_task_events_task", "task_events", "task_id, created_at ASC");
    this.ensureIndex("idx_task_leases_expiry", "task_leases", "lease_expires_at ASC");
    this.ensureIndex("idx_task_artifacts_task", "task_artifacts", "task_id, created_at ASC");
  }

  private applyTriChatSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_threads (
        thread_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trichat_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to_message_id TEXT,
        metadata_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_trichat_threads_status_updated", "trichat_threads", "status, updated_at DESC");
    this.ensureIndex("idx_trichat_messages_thread_created", "trichat_messages", "thread_id, created_at ASC");
    this.ensureIndex("idx_trichat_messages_agent_created", "trichat_messages", "agent_id, created_at DESC");
  }

  private applyTriChatAdapterTelemetryMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_adapter_states (
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        open INTEGER NOT NULL DEFAULT 0,
        open_until TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        trip_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_opened_at TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        degraded_turn_count INTEGER NOT NULL DEFAULT 0,
        last_result TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (agent_id, channel)
      );
      CREATE TABLE IF NOT EXISTS trichat_adapter_events (
        event_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        open_until TEXT,
        error_text TEXT,
        details_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_trichat_adapter_states_updated", "trichat_adapter_states", "updated_at DESC");
    this.ensureIndex("idx_trichat_adapter_states_open", "trichat_adapter_states", "open, updated_at DESC");
    this.ensureIndex("idx_trichat_adapter_events_created", "trichat_adapter_events", "created_at DESC");
    this.ensureIndex("idx_trichat_adapter_events_agent_created", "trichat_adapter_events", "agent_id, created_at DESC");
    this.ensureIndex("idx_trichat_adapter_events_type_created", "trichat_adapter_events", "event_type, created_at DESC");
  }

  private applyTriChatBusMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_bus_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_agent TEXT,
        source_client TEXT,
        event_type TEXT NOT NULL,
        role TEXT,
        content TEXT,
        metadata_json TEXT NOT NULL
      );
    `);

    this.ensureIndex("idx_trichat_bus_events_thread_seq", "trichat_bus_events", "thread_id, event_seq DESC");
    this.ensureIndex("idx_trichat_bus_events_created", "trichat_bus_events", "created_at DESC");
    this.ensureIndex("idx_trichat_bus_events_type_seq", "trichat_bus_events", "event_type, event_seq DESC");
    this.ensureIndex("idx_trichat_bus_events_agent_seq", "trichat_bus_events", "source_agent, event_seq DESC");
  }

  private applyTriChatTurnSchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        phase TEXT NOT NULL DEFAULT 'plan',
        phase_status TEXT NOT NULL DEFAULT 'running',
        expected_agents_json TEXT NOT NULL,
        min_agents INTEGER NOT NULL DEFAULT 3,
        novelty_score REAL,
        novelty_threshold REAL,
        retry_required INTEGER NOT NULL DEFAULT 0,
        retry_agents_json TEXT NOT NULL DEFAULT '[]',
        disagreement INTEGER NOT NULL DEFAULT 0,
        decision_summary TEXT,
        selected_agent TEXT,
        selected_strategy TEXT,
        verify_status TEXT,
        verify_summary TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(thread_id, user_message_id)
      );
      CREATE TABLE IF NOT EXISTS trichat_turn_artifacts (
        artifact_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        phase TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        agent_id TEXT,
        content TEXT,
        structured_json TEXT NOT NULL,
        score REAL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    this.ensureIndex("idx_trichat_turns_thread_updated", "trichat_turns", "thread_id, updated_at DESC");
    this.ensureIndex("idx_trichat_turns_status_updated", "trichat_turns", "status, updated_at DESC");
    this.ensureIndex("idx_trichat_turns_phase_updated", "trichat_turns", "phase, updated_at DESC");
    this.ensureIndex(
      "idx_trichat_turn_artifacts_turn_created",
      "trichat_turn_artifacts",
      "turn_id, created_at ASC"
    );
    this.ensureIndex(
      "idx_trichat_turn_artifacts_thread_phase",
      "trichat_turn_artifacts",
      "thread_id, phase, created_at DESC"
    );
    this.ensureIndex(
      "idx_trichat_turn_artifacts_type_phase",
      "trichat_turn_artifacts",
      "artifact_type, phase, created_at DESC"
    );
  }

  private applyTriChatReliabilitySchemaMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trichat_chaos_events (
        event_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        agent_id TEXT,
        channel TEXT,
        outcome TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trichat_slo_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        window_minutes INTEGER NOT NULL,
        adapter_sample_count INTEGER NOT NULL,
        adapter_error_count INTEGER NOT NULL,
        adapter_error_rate REAL NOT NULL,
        adapter_latency_p95_ms REAL,
        turn_total_count INTEGER NOT NULL,
        turn_failed_count INTEGER NOT NULL,
        turn_failure_rate REAL NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    this.ensureIndex("idx_trichat_chaos_events_created", "trichat_chaos_events", "created_at DESC");
    this.ensureIndex(
      "idx_trichat_chaos_events_action_created",
      "trichat_chaos_events",
      "action, created_at DESC"
    );
    this.ensureIndex(
      "idx_trichat_chaos_events_thread_created",
      "trichat_chaos_events",
      "thread_id, created_at DESC"
    );
    this.ensureIndex("idx_trichat_slo_snapshots_created", "trichat_slo_snapshots", "created_at DESC");
    this.ensureIndex(
      "idx_trichat_slo_snapshots_window_created",
      "trichat_slo_snapshots",
      "window_minutes, created_at DESC"
    );
  }

  private appendTaskEvent(params: {
    task_id: string;
    event_type: string;
    from_status?: TaskStatus;
    to_status?: TaskStatus;
    worker_id?: string;
    summary?: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_events (
           id, task_id, created_at, event_type, from_status, to_status, worker_id, summary, details_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.task_id,
        createdAt,
        params.event_type,
        params.from_status ?? null,
        params.to_status ?? null,
        params.worker_id ?? null,
        params.summary ?? null,
        stableStringify(params.details ?? {})
      );
    return { id, created_at: createdAt };
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    const exists = rows.some((row) => String(row.name) === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private ensureIndex(indexName: string, table: string, columns: string): void {
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${columns})`);
  }
}

function mapNoteRow(row: Record<string, unknown>): NoteRecord {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    source: asNullableString(row.source),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    trust_tier: normalizeTrustTier(row.trust_tier),
    expires_at: asNullableString(row.expires_at),
    promoted_from_note_id: asNullableString(row.promoted_from_note_id),
    tags: safeParseJsonArray(row.tags_json),
    related_paths: safeParseJsonArray(row.related_paths_json),
    text: String(row.text ?? ""),
  };
}

function mapTranscriptRow(row: Record<string, unknown>): TranscriptRecord {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    session_id: String(row.session_id),
    source_client: String(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    kind: String(row.kind),
    text: String(row.text ?? ""),
  };
}

function mapTranscriptLineRow(row: Record<string, unknown>): TranscriptLineRecord {
  return {
    id: Number(row.id ?? 0),
    run_id: asNullableString(row.run_id),
    role: asNullableString(row.role),
    content: String(row.content ?? ""),
    timestamp: String(row.timestamp ?? ""),
    is_squished: Number(row.is_squished ?? 0) === 1,
  };
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: Number(row.id ?? 0),
    content: String(row.content ?? ""),
    keywords: parseKeywords(row.keywords),
    created_at: String(row.created_at ?? ""),
    last_accessed_at: String(row.last_accessed_at ?? ""),
    decay_score: Number(row.decay_score ?? 1),
  };
}

function mapImprintProfileRow(row: Record<string, unknown>): ImprintProfileRecord {
  return {
    profile_id: String(row.profile_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    title: String(row.title ?? ""),
    mission: String(row.mission ?? ""),
    principles: safeParseJsonArray(row.principles_json),
    hard_constraints: safeParseJsonArray(row.hard_constraints_json),
    preferred_models: safeParseJsonArray(row.preferred_models_json),
    project_roots: safeParseJsonArray(row.project_roots_json),
    notes: asNullableString(row.notes),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
  };
}

function mapImprintSnapshotRow(row: Record<string, unknown>): ImprintSnapshotRecord {
  return {
    id: String(row.id ?? ""),
    created_at: String(row.created_at ?? ""),
    profile_id: asNullableString(row.profile_id),
    summary: asNullableString(row.summary),
    tags: safeParseJsonArray(row.tags_json),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    state: parseJsonObject(row.state_json),
    snapshot_path: asNullableString(row.snapshot_path),
    memory_id: row.memory_id === null || row.memory_id === undefined ? null : Number(row.memory_id),
  };
}

function mapTaskRow(row: Record<string, unknown>): TaskRecord {
  const leaseOwnerId = asNullableString(row.lease_owner_id);
  const leaseExpiresAt = asNullableString(row.lease_expires_at);
  const leaseHeartbeat = asNullableString(row.lease_heartbeat_at);
  const leaseCreatedAt = asNullableString(row.lease_created_at);
  const leaseUpdatedAt = asNullableString(row.lease_updated_at);
  return {
    task_id: String(row.task_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    status: normalizeTaskStatus(row.status),
    priority: Number(row.priority ?? 0),
    objective: String(row.objective ?? ""),
    project_dir: String(row.project_dir ?? ""),
    payload: parseJsonObject(row.payload_json),
    source: asNullableString(row.source),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    tags: safeParseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json),
    max_attempts: Number(row.max_attempts ?? 3),
    attempt_count: Number(row.attempt_count ?? 0),
    available_at: String(row.available_at ?? ""),
    started_at: asNullableString(row.started_at),
    finished_at: asNullableString(row.finished_at),
    last_worker_id: asNullableString(row.last_worker_id),
    last_error: asNullableString(row.last_error),
    result: parseNullableJsonObject(row.result_json),
    lease:
      leaseOwnerId && leaseExpiresAt && leaseHeartbeat && leaseCreatedAt && leaseUpdatedAt
        ? {
            task_id: String(row.task_id ?? ""),
            owner_id: leaseOwnerId,
            lease_expires_at: leaseExpiresAt,
            heartbeat_at: leaseHeartbeat,
            created_at: leaseCreatedAt,
            updated_at: leaseUpdatedAt,
          }
      : null,
  };
}

function mapTaskEventRow(row: Record<string, unknown>): TaskEventRecord {
  return {
    id: String(row.id ?? ""),
    task_id: String(row.task_id ?? ""),
    created_at: String(row.created_at ?? ""),
    event_type: String(row.event_type ?? ""),
    from_status:
      row.from_status === null || row.from_status === undefined
        ? null
        : normalizeTaskStatus(row.from_status),
    to_status:
      row.to_status === null || row.to_status === undefined
        ? null
        : normalizeTaskStatus(row.to_status),
    worker_id: asNullableString(row.worker_id),
    summary: asNullableString(row.summary),
    details: parseJsonObject(row.details_json),
  };
}

function mapTriChatThreadRow(row: Record<string, unknown>): TriChatThreadRecord {
  return {
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    title: asNullableString(row.title),
    status: normalizeTriChatThreadStatus(row.status),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatMessageRow(row: Record<string, unknown>): TriChatMessageRecord {
  return {
    message_id: String(row.message_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    agent_id: String(row.agent_id ?? ""),
    role: String(row.role ?? ""),
    content: String(row.content ?? ""),
    reply_to_message_id: asNullableString(row.reply_to_message_id),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatTurnRow(row: Record<string, unknown>): TriChatTurnRecord {
  return {
    turn_id: String(row.turn_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    user_message_id: String(row.user_message_id ?? ""),
    user_prompt: String(row.user_prompt ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    started_at: String(row.started_at ?? ""),
    finished_at: asNullableString(row.finished_at),
    status: normalizeTriChatTurnStatus(row.status),
    phase: normalizeTriChatTurnPhase(row.phase),
    phase_status: normalizeTriChatTurnPhaseStatus(row.phase_status),
    expected_agents: safeParseJsonArray(row.expected_agents_json),
    min_agents: parseBoundedInt(row.min_agents, 3, 1, 12),
    novelty_score:
      typeof row.novelty_score === "number" && Number.isFinite(row.novelty_score)
        ? Number(row.novelty_score)
        : row.novelty_score === null || row.novelty_score === undefined
          ? null
          : Number.isFinite(Number(row.novelty_score))
            ? Number(row.novelty_score)
            : null,
    novelty_threshold:
      typeof row.novelty_threshold === "number" && Number.isFinite(row.novelty_threshold)
        ? Number(row.novelty_threshold)
        : row.novelty_threshold === null || row.novelty_threshold === undefined
          ? null
          : Number.isFinite(Number(row.novelty_threshold))
            ? Number(row.novelty_threshold)
            : null,
    retry_required: Number(row.retry_required ?? 0) === 1,
    retry_agents: safeParseJsonArray(row.retry_agents_json),
    disagreement: Number(row.disagreement ?? 0) === 1,
    decision_summary: asNullableString(row.decision_summary),
    selected_agent: asNullableString(row.selected_agent),
    selected_strategy: asNullableString(row.selected_strategy),
    verify_status: asNullableString(row.verify_status),
    verify_summary: asNullableString(row.verify_summary),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatTurnArtifactRow(row: Record<string, unknown>): TriChatTurnArtifactRecord {
  return {
    artifact_id: String(row.artifact_id ?? ""),
    turn_id: String(row.turn_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    phase: normalizeTriChatTurnPhase(row.phase),
    artifact_type: String(row.artifact_type ?? ""),
    agent_id: asNullableString(row.agent_id),
    content: asNullableString(row.content),
    structured: parseJsonObject(row.structured_json),
    score:
      typeof row.score === "number" && Number.isFinite(row.score)
        ? Number(row.score)
        : row.score === null || row.score === undefined
          ? null
          : Number.isFinite(Number(row.score))
            ? Number(row.score)
            : null,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatBusEventRow(row: Record<string, unknown>): TriChatBusEventRecord {
  return {
    event_seq: Number(row.event_seq ?? 0),
    event_id: String(row.event_id ?? ""),
    thread_id: String(row.thread_id ?? ""),
    created_at: String(row.created_at ?? ""),
    source_agent: asNullableString(row.source_agent),
    source_client: asNullableString(row.source_client),
    event_type: String(row.event_type ?? ""),
    role: asNullableString(row.role),
    content: asNullableString(row.content),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTriChatAdapterStateRow(row: Record<string, unknown>): TriChatAdapterStateRecord {
  const openUntil = asNullableString(row.open_until);
  const rawOpen = Number(row.open ?? 0) === 1;
  return {
    agent_id: String(row.agent_id ?? ""),
    channel: normalizeTriChatAdapterChannel(row.channel),
    updated_at: String(row.updated_at ?? ""),
    open: isTriChatCircuitOpen(rawOpen, openUntil),
    open_until: openUntil,
    failure_count: Number(row.failure_count ?? 0),
    trip_count: Number(row.trip_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    last_error: asNullableString(row.last_error),
    last_opened_at: asNullableString(row.last_opened_at),
    turn_count: Number(row.turn_count ?? 0),
    degraded_turn_count: Number(row.degraded_turn_count ?? 0),
    last_result: asNullableString(row.last_result),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function isTriChatCircuitOpen(open: boolean, openUntil: string | null): boolean {
  if (!open) {
    return false;
  }
  if (!openUntil) {
    return true;
  }
  const untilEpoch = Date.parse(openUntil);
  if (!Number.isFinite(untilEpoch)) {
    return true;
  }
  return untilEpoch > Date.now();
}

function mapTriChatAdapterEventRow(row: Record<string, unknown>): TriChatAdapterEventRecord {
  return {
    event_id: String(row.event_id ?? ""),
    created_at: String(row.created_at ?? ""),
    agent_id: String(row.agent_id ?? ""),
    channel: normalizeTriChatAdapterChannel(row.channel),
    event_type: String(row.event_type ?? ""),
    open_until: asNullableString(row.open_until),
    error_text: asNullableString(row.error_text),
    details: parseJsonObject(row.details_json),
  };
}

function mapTriChatChaosEventRow(row: Record<string, unknown>): TriChatChaosEventRecord {
  return {
    event_id: String(row.event_id ?? ""),
    created_at: String(row.created_at ?? ""),
    action: String(row.action ?? ""),
    thread_id: asNullableString(row.thread_id),
    turn_id: asNullableString(row.turn_id),
    agent_id: asNullableString(row.agent_id),
    channel:
      row.channel === null || row.channel === undefined
        ? null
        : normalizeTriChatAdapterChannel(row.channel),
    outcome: String(row.outcome ?? ""),
    details: parseJsonObject(row.details_json),
  };
}

function mapTriChatSloSnapshotRow(row: Record<string, unknown>): TriChatSloSnapshotRecord {
  return {
    snapshot_id: String(row.snapshot_id ?? ""),
    created_at: String(row.created_at ?? ""),
    window_minutes: parseBoundedInt(row.window_minutes, 60, 1, 10080),
    adapter_sample_count: parseBoundedInt(row.adapter_sample_count, 0, 0, 1_000_000),
    adapter_error_count: parseBoundedInt(row.adapter_error_count, 0, 0, 1_000_000),
    adapter_error_rate: clampMetricRate(row.adapter_error_rate),
    adapter_latency_p95_ms:
      typeof row.adapter_latency_p95_ms === "number" && Number.isFinite(row.adapter_latency_p95_ms)
        ? Number(row.adapter_latency_p95_ms)
        : row.adapter_latency_p95_ms === null || row.adapter_latency_p95_ms === undefined
          ? null
          : Number.isFinite(Number(row.adapter_latency_p95_ms))
            ? Number(row.adapter_latency_p95_ms)
            : null,
    turn_total_count: parseBoundedInt(row.turn_total_count, 0, 0, 1_000_000),
    turn_failed_count: parseBoundedInt(row.turn_failed_count, 0, 0, 1_000_000),
    turn_failure_rate: clampMetricRate(row.turn_failure_rate),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function normalizeTrustTier(value: unknown): TrustTier {
  const normalized = String(value ?? "raw");
  if (normalized === "verified" || normalized === "policy-backed" || normalized === "deprecated") {
    return normalized;
  }
  return "raw";
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  const normalized = String(value ?? "pending");
  if (normalized === "running" || normalized === "completed" || normalized === "failed" || normalized === "cancelled") {
    return normalized;
  }
  return "pending";
}

function normalizeTriChatThreadStatus(value: unknown): TriChatThreadStatus {
  return String(value ?? "active") === "archived" ? "archived" : "active";
}

function normalizeTriChatTurnStatus(value: unknown): TriChatTurnStatus {
  const normalized = String(value ?? "running");
  if (normalized === "completed" || normalized === "failed" || normalized === "cancelled") {
    return normalized;
  }
  return "running";
}

function normalizeTriChatTurnPhase(value: unknown): TriChatTurnPhase {
  const normalized = String(value ?? "plan");
  if (
    normalized === "propose" ||
    normalized === "critique" ||
    normalized === "merge" ||
    normalized === "execute" ||
    normalized === "verify" ||
    normalized === "summarize"
  ) {
    return normalized;
  }
  return "plan";
}

function normalizeTriChatTurnPhaseStatus(value: unknown): TriChatTurnPhaseStatus {
  const normalized = String(value ?? "running");
  if (normalized === "completed" || normalized === "failed" || normalized === "skipped") {
    return normalized;
  }
  return "running";
}

function normalizeTriChatAdapterChannel(value: unknown): TriChatAdapterChannel {
  return String(value ?? "model") === "command" ? "command" : "model";
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}

function normalizeKeywords(keywords: string[] | undefined): string[] {
  if (!keywords) {
    return [];
  }
  const unique = new Set<string>();
  for (const keyword of keywords) {
    const normalized = keyword.trim().toLowerCase();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function dedupeNonEmpty(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function parseKeywords(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeParseJsonArray(value: unknown): string[] {
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    }
  } catch {
    return [];
  }
  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    return {};
  }
  return {};
}

function parseLooseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return parseJsonObject(value);
}

function parseNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseJsonUnknown(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resolveStorageGuardOptions(dbPath: string): StorageGuardOptions {
  const dbDir = path.dirname(dbPath);
  const backupDirRaw = String(process.env.ANAMNESIS_HUB_BACKUP_DIR ?? "").trim();
  const backupDir = backupDirRaw ? path.resolve(backupDirRaw) : path.join(dbDir, "backups");
  return {
    backup_dir: backupDir,
    backup_keep: parseBoundedInt(process.env.ANAMNESIS_HUB_BACKUP_KEEP, 24, 1, 500),
    startup_backup_enabled: parseBoolean(process.env.ANAMNESIS_HUB_STARTUP_BACKUP, true),
    startup_quick_check_enabled: parseBoolean(process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_ON_START, true),
    auto_restore_from_backup: parseBoolean(process.env.ANAMNESIS_HUB_AUTO_RESTORE_FROM_BACKUP, true),
    allow_fresh_on_corruption: parseBoolean(process.env.ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION, false),
    quarantine_dir: path.join(dbDir, "corrupt"),
  };
}

function guardDatabasePathBeforeOpen(dbPath: string, options: StorageGuardOptions): StorageGuardOutcome {
  const outcome: StorageGuardOutcome = {
    quarantined_paths: [],
    restored_from_backup: null,
  };
  if (dbPath === ":memory:") {
    return outcome;
  }
  if (!fs.existsSync(dbPath)) {
    return outcome;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch (error) {
    throw new Error(`Unable to stat database path ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.size === 0) {
    return outcome;
  }
  if (hasSqliteHeader(dbPath)) {
    return outcome;
  }

  const quarantined = quarantineDatabaseArtifacts(dbPath, options, "invalid-header");
  outcome.quarantined_paths.push(...quarantined);
  writeStorageGuardLog(
    `[storage] non-SQLite header detected at ${dbPath}; quarantined ${quarantined.length} artifact(s).`
  );

  if (options.auto_restore_from_backup) {
    const restoredFrom = restoreLatestDatabaseBackup(dbPath, options);
    if (restoredFrom) {
      outcome.restored_from_backup = restoredFrom;
      return outcome;
    }
  }

  if (!options.allow_fresh_on_corruption) {
    throw new Error(
      [
        `Database file ${dbPath} is not a valid SQLite file and no backup was restored from ${options.backup_dir}.`,
        `Set ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION=1 to allow an empty database bootstrap (data loss).`,
      ].join(" ")
    );
  }
  return outcome;
}

function openDatabaseWithGuard(dbPath: string, options: StorageGuardOptions): Database.Database {
  try {
    return new Database(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCorruption = /SQLITE_CORRUPT|malformed|file is not a database|disk image is malformed/i.test(message);
    if (!isCorruption) {
      throw error;
    }

    writeStorageGuardLog(`[storage] open failed due to corruption at ${dbPath}: ${message}`);
    const quarantined = quarantineDatabaseArtifacts(dbPath, options, "open-failed");
    if (quarantined.length > 0) {
      writeStorageGuardLog(`[storage] quarantined after open failure: ${quarantined.join(", ")}`);
    }

    if (options.auto_restore_from_backup) {
      const restoredFrom = restoreLatestDatabaseBackup(dbPath, options);
      if (restoredFrom) {
        writeStorageGuardLog(`[storage] restored from backup after open failure: ${restoredFrom}`);
        return new Database(dbPath);
      }
    }

    if (!options.allow_fresh_on_corruption) {
      throw new Error(
        [
          `Unable to open SQLite database at ${dbPath}; corruption detected and no backup could be restored.`,
          `Set ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION=1 only if you intentionally want a fresh database.`,
        ].join(" ")
      );
    }

    removeDatabaseArtifacts(dbPath);
    writeStorageGuardLog(`[storage] opening fresh empty database at ${dbPath} after unrecoverable corruption.`);
    return new Database(dbPath);
  }
}

function runQuickCheck(db: Database.Database): { ok: boolean; reason: string } {
  try {
    const value = String(db.pragma("quick_check", { simple: true }) ?? "").trim();
    if (!value || value.toLowerCase() === "ok") {
      return { ok: true, reason: "ok" };
    }
    return { ok: false, reason: value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function hasSqliteHeader(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const fd = fs.openSync(dbPath, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < SQLITE_HEADER.length) {
      return false;
    }
    return header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

function quarantineDatabaseArtifacts(dbPath: string, options: StorageGuardOptions, reason: string): string[] {
  if (dbPath === ":memory:") {
    return [];
  }
  fs.mkdirSync(options.quarantine_dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffixes = ["", "-wal", "-shm"];
  const moved: string[] = [];
  for (const suffix of suffixes) {
    const artifactPath = `${dbPath}${suffix}`;
    if (!fs.existsSync(artifactPath)) {
      continue;
    }
    const artifactName = path.basename(artifactPath);
    const targetPath = path.join(options.quarantine_dir, `${artifactName}.${stamp}.${reason}`);
    moveFileWithFallback(artifactPath, targetPath);
    moved.push(targetPath);
  }
  return moved;
}

function restoreLatestDatabaseBackup(dbPath: string, options: StorageGuardOptions): string | null {
  if (dbPath === ":memory:") {
    return null;
  }
  if (!fs.existsSync(options.backup_dir)) {
    return null;
  }
  const base = path.basename(dbPath);
  const candidates = fs
    .readdirSync(options.backup_dir)
    .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".sqlite"))
    .map((entry) => path.join(options.backup_dir, entry))
    .filter((entry) => fs.existsSync(entry))
    .sort((left, right) => {
      const leftMs = safeMtimeMs(left);
      const rightMs = safeMtimeMs(right);
      return rightMs - leftMs;
    });

  const selected = candidates[0];
  if (!selected) {
    return null;
  }
  removeDatabaseArtifacts(dbPath);
  fs.copyFileSync(selected, dbPath);
  return selected;
}

function removeDatabaseArtifacts(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    removeFileIfExists(`${dbPath}${suffix}`);
  }
}

function pruneDatabaseBackups(dbPath: string, options: StorageGuardOptions): void {
  if (!fs.existsSync(options.backup_dir)) {
    return;
  }
  const base = path.basename(dbPath);
  const backups = fs
    .readdirSync(options.backup_dir)
    .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".sqlite"))
    .map((entry) => path.join(options.backup_dir, entry))
    .filter((entry) => fs.existsSync(entry))
    .sort((left, right) => safeMtimeMs(right) - safeMtimeMs(left));

  if (backups.length <= options.backup_keep) {
    return;
  }

  const toDelete = backups.slice(options.backup_keep);
  for (const entry of toDelete) {
    removeFileIfExists(entry);
  }
}

function safeCloseDatabase(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // ignore close failures during recovery flow
  }
}

function moveFileWithFallback(fromPath: string, toPath: string): void {
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  try {
    fs.renameSync(fromPath, toPath);
    return;
  } catch {
    fs.copyFileSync(fromPath, toPath);
    fs.unlinkSync(fromPath);
  }
}

function removeFileIfExists(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  fs.unlinkSync(filePath);
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function writeStorageGuardLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
      return false;
    }
  }
  return fallback;
}

function hashPayload(value: unknown): string {
  const normalized = stableStringify(value);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      sorted[key] = sortObject(entry);
    }
    return sorted;
  }
  return value;
}

function readUserVersion(db: Database.Database): number {
  const value = db.pragma("user_version", { simple: true }) as unknown;
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const bounded = Math.max(min, Math.min(max, Math.round(parsed)));
  return bounded;
}

function parseBoundedFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const bounded = Math.max(min, Math.min(max, parsed));
  return Number(bounded.toFixed(4));
}

function clampMetricRate(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  if (parsed <= 0) {
    return 0;
  }
  if (parsed >= 1) {
    return 1;
  }
  return Number(parsed.toFixed(6));
}

function computeTermScore(text: string, query?: string): number {
  if (!query) {
    return 0;
  }
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerText.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function normalizeIsoTimestamp(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed.toISOString();
}

function normalizeOptionalIsoTimestamp(value: string | null | undefined): string | null {
  const normalized = asNullableString(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}
