#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const explicit = process.argv.find((entry) => entry.startsWith(prefix));
  if (explicit) return explicit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArg(name) {
  const value = argValue(name, "");
  return value.trim() || null;
}

function tmpRoot() {
  const envTmp = process.env.TMPDIR?.trim();
  if (envTmp) return envTmp;
  const darwinTmp = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 1000 });
  return darwinTmp.status === 0 && darwinTmp.stdout.trim() ? darwinTmp.stdout.trim() : os.tmpdir();
}

function recordingRoot() {
  return path.join(tmpRoot(), "chronicle", "screen_recording");
}

function recorderStatus() {
  const pidPath = path.join(tmpRoot(), "codex_tape_recorder", "chronicle-started.pid");
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return { live: false, unavailable_reason: "chronicle_recorder_not_running" };
    try {
      process.kill(pid, 0);
      return { live: true, unavailable_reason: null };
    } catch (error) {
      return error?.code === "EPERM"
        ? { live: true, unavailable_reason: null }
        : { live: false, unavailable_reason: "chronicle_recorder_not_running" };
    }
  } catch {
    return { live: false, unavailable_reason: "chronicle_recorder_not_running" };
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function displayIdFromLatest(filename) {
  const match = filename.match(/-display-(.+)-latest\.jpg$/);
  return match ? match[1] : "unknown";
}

function roundSeconds(value) {
  return Number(value.toFixed(3));
}

function listDisplays({ maxFreshnessSeconds, displayId }) {
  const recorder = recorderStatus();
  const root = recordingRoot();
  if (!recorder.live) {
    return { ok: false, root, displays: [], unavailable_reason: recorder.unavailable_reason, stale_reason: null };
  }
  if (!fs.existsSync(root)) {
    return { ok: false, root, displays: [], unavailable_reason: "chronicle_recording_root_missing", stale_reason: null };
  }
  const nowMs = Date.now();
  const displays = fs
    .readdirSync(root)
    .filter((filename) => filename.endsWith("-latest.jpg"))
    .map((filename) => {
      const id = displayIdFromLatest(filename);
      if (displayId && displayId !== id) return null;
      const segmentId = filename.replace(/-latest\.jpg$/, "");
      const latestFramePath = path.join(root, filename);
      const stat = safeStat(latestFramePath);
      if (!stat) return null;
      const freshnessSeconds = Math.max(0, (nowMs - stat.mtimeMs) / 1000);
      const captureMetadataPath = path.join(root, `${segmentId}.capture.json`);
      const ocrPath = path.join(root, `${segmentId}.ocr.jsonl`);
      const sparseHistoryDir = path.join(root, "1min", segmentId);
      return {
        display_id: id,
        segment_id: segmentId,
        latest_frame_path: latestFramePath,
        latest_frame_mtime: stat.mtime.toISOString(),
        freshness_seconds: roundSeconds(freshnessSeconds),
        stale: freshnessSeconds > maxFreshnessSeconds,
        capture_metadata_path: fs.existsSync(captureMetadataPath) ? captureMetadataPath : null,
        capture_metadata: fs.existsSync(captureMetadataPath) ? safeJson(captureMetadataPath) : null,
        ocr_path: fs.existsSync(ocrPath) ? ocrPath : null,
        sparse_history_dir: fs.existsSync(sparseHistoryDir) ? sparseHistoryDir : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.display_id.localeCompare(right.display_id));
  const staleReason = displays.length > 0 && displays.every((display) => display.stale) ? "chronicle_latest_frames_stale" : null;
  return {
    ok: displays.length > 0 && !staleReason,
    root,
    displays,
    unavailable_reason: displays.length <= 0 ? "chronicle_latest_frame_missing" : null,
    stale_reason: staleReason,
  };
}

function readTail(filePath, maxBytes) {
  const stat = safeStat(filePath);
  if (!stat) return "";
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function collectStrings(value, output = [], depth = 0) {
  if (output.length >= 20 || depth > 4) return output;
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact) output.push(compact);
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output, depth + 1);
    return output;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, output, depth + 1);
  }
  return output;
}

function compactText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function ocrHits(displays, query, maxHits) {
  const needle = query?.trim().toLowerCase();
  if (!needle) return undefined;
  const hits = [];
  for (const display of displays) {
    if (!display.ocr_path || hits.length >= maxHits) continue;
    for (const [index, line] of readTail(display.ocr_path, 2_000_000).split(/\r?\n/).filter(Boolean).entries()) {
      if (hits.length >= maxHits) break;
      if (!line.toLowerCase().includes(needle)) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      hits.push({
        display_id: display.display_id,
        ocr_path: display.ocr_path,
        line_offset_from_tail: index,
        timestamp: record.timestamp ?? record.created_at ?? record.ts ?? record.time ?? null,
        text_excerpt: compactText(collectStrings(parsed).join(" ") || line, 360),
      });
    }
  }
  return hits;
}

function screenshot() {
  const generatedAt = new Date().toISOString();
  const dryRun = process.env.MCP_DESKTOP_CONTROL_DRY_RUN === "1" || process.env.MASTER_MOLD_DESKTOP_CONTEXT_DRY_RUN === "1";
  const outputPath = path.join(tmpRoot(), `master-mold-context-${Date.now()}-${process.pid}.png`);
  if (dryRun) {
    return {
      ok: true,
      status: "degraded",
      source: "desktop_observe",
      generated_at: generatedAt,
      current_utc: generatedAt,
      screenshot_path: outputPath,
      screenshot_base64: null,
      screenshot: { dry_run: true, captured: false, path: outputPath, size_bytes: 0 },
    };
  }
  const capture = spawnSync("screencapture", ["-x", outputPath], { encoding: "utf8", timeout: 15000 });
  if (capture.status !== 0 || !fs.existsSync(outputPath)) {
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: generatedAt,
      current_utc: generatedAt,
      unavailable_reason: "remote_screenshot_failed",
      stderr: compactText(capture.stderr, 1000),
      screenshot_path: outputPath,
      screenshot_base64: null,
    };
  }
  const data = fs.readFileSync(outputPath);
  return {
    ok: true,
    status: "available",
    source: "desktop_observe",
    generated_at: generatedAt,
    current_utc: generatedAt,
    screenshot_path: outputPath,
    screenshot_base64: data.toString("base64"),
    screenshot: { dry_run: false, captured: true, path: outputPath, size_bytes: data.length },
  };
}

function main() {
  const action = argValue("action", "latest");
  if (action === "screenshot") {
    console.log(JSON.stringify({ ...screenshot(), host: hostSummary() }));
    return;
  }
  const generatedAt = new Date().toISOString();
  const context = listDisplays({
    maxFreshnessSeconds: numberArg("max-freshness-seconds", 120),
    displayId: stringArg("display-id"),
  });
  const freshDisplays = context.displays.filter((display) => !display.stale);
  const selectedDisplay = freshDisplays[0] ?? context.displays[0] ?? null;
  const hits = action === "search" || stringArg("query")
    ? ocrHits(context.displays, stringArg("query"), numberArg("ocr-max-hits", 10)) ?? []
    : undefined;
  const status = freshDisplays.length > 0 ? "available" : context.displays.length > 0 ? "degraded" : "unavailable";
  console.log(JSON.stringify({
    ok: status !== "unavailable",
    status,
    source: status === "unavailable" ? "none" : "chronicle",
    generated_at: generatedAt,
    current_utc: generatedAt,
    freshness_seconds: selectedDisplay?.freshness_seconds ?? null,
    displays: context.displays,
    latest_frame_path: selectedDisplay?.latest_frame_path ?? null,
    screenshot_path: null,
    ocr_hits: hits,
    ocr_note: hits ? "OCR hits are noisy triage hints only; use app/file/connectors for authoritative extraction." : undefined,
    stale_reason: context.stale_reason,
    unavailable_reason: context.unavailable_reason,
    host: hostSummary(),
  }));
}

function hostSummary() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    repo_root: process.cwd(),
    generated_by: "master-mold.remote_context_probe",
  };
}

main();
