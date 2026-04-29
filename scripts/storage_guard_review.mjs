#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = "") {
  const token = `--${name}`;
  const prefix = `${token}=`;
  const inline = process.argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(token);
  const next = process.argv[index + 1];
  return index >= 0 && next && !next.startsWith("--") ? next : fallback;
}

function boolArg(name, fallback = false) {
  const value = String(argValue(name, process.argv.includes(`--${name}`) ? "true" : fallback ? "true" : "false"))
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function intArg(name, fallback, min, max) {
  const parsed = Number(argValue(name, ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeStat(entryPath) {
  try {
    return fs.statSync(entryPath);
  } catch {
    return null;
  }
}

function directoryEntries(dir, recursive = false) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        out.push(...directoryEntries(entryPath, true));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(entryPath);
    out.push({
      path: entryPath,
      basename: path.basename(entryPath),
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      mtime_iso: stat.mtime.toISOString(),
    });
  }
  return out;
}

function summarizeBucket(bucket, dir, topLimit, options = {}) {
  const entries = directoryEntries(dir, options.recursive === true);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const largest = [...entries].sort((left, right) => right.size_bytes - left.size_bytes).slice(0, topLimit);
  const newest = [...entries].sort((left, right) => right.mtime_ms - left.mtime_ms).slice(0, topLimit);
  return {
    bucket,
    path: dir,
    present: fs.existsSync(dir),
    artifact_count: entries.length,
    total_bytes: totalBytes,
    newest_at: newest[0]?.mtime_iso ?? null,
    largest,
    newest,
  };
}

function parseLsof(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function lsof(args, timeoutMs) {
  const result = spawnSync("lsof", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 || result.status === 1,
    status: result.status,
    signal: result.signal,
    timed_out: result.error?.code === "ETIMEDOUT",
    error: result.error?.message ?? null,
    entries: parseLsof(result.stdout),
    stderr: String(result.stderr || "").trim(),
  };
}

function printHelp() {
  console.log(`Usage:
  npm run storage:review -- --json
  npm run storage:review -- --open-scan --json

This command is read-only. It reviews storage guard quarantine/recovery evidence,
checks open-file evidence, and prints archive/delete commands that require
separate action-time approval before execution.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(argValue("repo-root", DEFAULT_REPO_ROOT));
  const topLimit = intArg("top", 8, 1, 50);
  const jsonOnly = boolArg("json", false);
  const openScan = boolArg("open-scan", false);
  const dataRoot = path.join(repoRoot, "data");
  const dbPath = argValue("db", path.join(dataRoot, "hub.sqlite"));
  const corruptDir = argValue("quarantine-dir", path.join(dataRoot, "corrupt"));
  const backupDir = argValue("backup-dir", path.join(dataRoot, "backups"));
  const archiveDir = argValue("archive-dir", path.join(dataRoot, "storage-evidence-archive"));
  const recoveryDirs = fs.existsSync(dataRoot)
    ? fs
        .readdirSync(dataRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("recovery-"))
        .map((entry) => path.join(dataRoot, entry.name))
    : [];

  const buckets = [
    summarizeBucket("quarantine", corruptDir, topLimit),
    summarizeBucket("backup", backupDir, topLimit),
    ...recoveryDirs.map((dir) => summarizeBucket("recovery", dir, topLimit)),
  ];
  const archivedEvidence = summarizeBucket("archived_evidence", archiveDir, topLimit, { recursive: true });
  const evidenceBuckets = buckets.filter((bucket) => bucket.bucket !== "backup");
  const evidenceBytes = evidenceBuckets.reduce((sum, bucket) => sum + bucket.total_bytes, 0);
  const evidenceCount = evidenceBuckets.reduce((sum, bucket) => sum + bucket.artifact_count, 0);
  const liveDbOpen = lsof([dbPath, `${dbPath}-wal`, `${dbPath}-shm`], 10_000);
  const evidenceOpen = openScan
    ? lsof(["+D", corruptDir, ...recoveryDirs.flatMap((dir) => ["+D", dir])], 30_000)
    : {
        ok: true,
        status: null,
        signal: null,
        timed_out: false,
        error: null,
        entries: [],
        stderr: "",
        skipped: true,
        detail: "Pass --open-scan before any archive/delete action to verify evidence files are not open.",
      };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRoot = path.join(dataRoot, "storage-evidence-archive", stamp);
  const archiveCommands = [];
  if (fs.existsSync(corruptDir)) {
    archiveCommands.push(`mkdir -p ${shellQuote(archiveRoot)} && mv ${shellQuote(corruptDir)} ${shellQuote(path.join(archiveRoot, "corrupt"))}`);
  }
  for (const recoveryDir of recoveryDirs) {
    archiveCommands.push(
      `mkdir -p ${shellQuote(archiveRoot)} && mv ${shellQuote(recoveryDir)} ${shellQuote(path.join(archiveRoot, path.basename(recoveryDir)))}`
    );
  }
  const deleteCommands = [];
  if (fs.existsSync(corruptDir)) {
    deleteCommands.push(`rm -rf ${shellQuote(corruptDir)}`);
  }
  for (const recoveryDir of recoveryDirs) {
    deleteCommands.push(`rm -rf ${shellQuote(recoveryDir)}`);
  }

  const output = {
    ok: true,
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    data_root: dataRoot,
    db_path: dbPath,
    read_only: true,
    evidence: {
      attention_required: evidenceCount > 0,
      artifact_count: evidenceCount,
      total_bytes: evidenceBytes,
      buckets,
      archived: archivedEvidence,
    },
    open_files: {
      live_db: liveDbOpen,
      evidence: evidenceOpen,
    },
    action_time_confirmation_required: true,
    archive_plan: {
      preferred: true,
      reason: "Archive quarantine/recovery evidence first when you want Office health to clear without immediately deleting recovery material.",
      commands: archiveCommands,
    },
    delete_plan: {
      preferred: false,
      reason: "Deletion reclaims disk, but should only run after reviewing evidence and confirming no evidence files are open.",
      commands: deleteCommands,
    },
    next_action:
      evidenceCount > 0
        ? "Review the largest/newest evidence and rerun with --open-scan immediately before any archive or delete command."
        : "No quarantine/recovery evidence is present.",
  };

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Storage guard evidence: ${evidenceCount} artifact(s), ${(evidenceBytes / 1024 ** 3).toFixed(1)} GiB`);
  console.log(`Live DB open handles: ${liveDbOpen.entries.length}`);
  console.log(`Evidence open scan: ${evidenceOpen.skipped ? "skipped" : `${evidenceOpen.entries.length} open handle(s)`}`);
  console.log(`Next action: ${output.next_action}`);
  if (archiveCommands.length > 0) {
    console.log("\nArchive commands requiring confirmation:");
    for (const command of archiveCommands) console.log(`  ${command}`);
  }
  if (deleteCommands.length > 0) {
    console.log("\nDelete commands requiring confirmation:");
    for (const command of deleteCommands) console.log(`  ${command}`);
  }
  console.log("\nJSON:");
  console.log(JSON.stringify(output, null, 2));
}

main();
