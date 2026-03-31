import fs from "node:fs";
import { z } from "zod";
import { Storage } from "../storage.js";

export const healthToolsSchema = z.object({});
export const healthStorageSchema = z.object({});
export const healthPolicySchema = z.object({});

export function healthTools(toolNames: string[]) {
  return {
    ok: true,
    tool_count: toolNames.length,
    tools: [...toolNames].sort(),
  };
}

export function healthStorage(storage: Storage) {
  const dbPath = storage.getDatabasePath();
  const counts = storage.getTableCounts();
  const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
  const backups = storage.getStorageBackupStatus({ recent_limit: 6 });
  return {
    ok: true,
    db_path: dbPath,
    db_exists: Boolean(stats),
    db_size_bytes: stats ? stats.size : 0,
    schema_version: storage.getSchemaVersion(),
    table_counts: counts,
    backups,
  };
}

export function healthPolicy() {
  return {
    ok: true,
    mode: "local-only",
    enforced_rules: [
      "two-source confirmation required for destructive actions",
      "protected targets block destructive mutations",
      "idempotency key and side effect fingerprint required for mutating tools",
      "destructive lifecycle actions default to safe mode unless explicitly execute",
    ],
  };
}
