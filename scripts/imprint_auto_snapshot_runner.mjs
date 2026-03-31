#!/usr/bin/env node
import process from "node:process";
import {
  callTool,
  loadRunnerEnv,
  parseBoolean,
  parseIntValue,
  repoRootFromMeta,
  resolveTransport,
} from "./mcp_runner_support.mjs";

const repoRoot = repoRootFromMeta(import.meta.url);
loadRunnerEnv(repoRoot);

const transport = resolveTransport(repoRoot);

const now = Date.now();
const args = {
  action: "start",
  mutation: {
    idempotency_key: `imprint-auto-snapshot-start-${now}-${process.pid}`,
    side_effect_fingerprint: `imprint-auto-snapshot-start-${now}-${process.pid}`,
  },
  profile_id: process.env.ANAMNESIS_IMPRINT_PROFILE_ID || "default",
  interval_seconds: parseIntValue(process.env.ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_INTERVAL_SECONDS, 900, 60, 604800),
  include_recent_memories: parseIntValue(process.env.ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RECENT_MEMORIES, 20, 0, 1000),
  include_recent_transcript_lines: parseIntValue(
    process.env.ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RECENT_TRANSCRIPT_LINES,
    40,
    0,
    2000
  ),
  write_file: parseBoolean(process.env.ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_WRITE_FILE, true),
  promote_summary: parseBoolean(process.env.ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_PROMOTE_SUMMARY, true),
  run_immediately: parseBoolean(process.env.ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RUN_IMMEDIATELY, true),
};

const result = callTool(repoRoot, {
  tool: "imprint.auto_snapshot",
  args,
  transport,
});

process.stdout.write(`${JSON.stringify(result)}\n`);
