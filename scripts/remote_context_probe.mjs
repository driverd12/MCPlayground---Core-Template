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
  const raw = String(argValue(name, "") ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArg(name) {
  const value = argValue(name, "");
  return value.trim() || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function recorderPidPaths() {
  const root = tmpRoot();
  return uniquePaths([
    process.env.CHRONICLE_PID_PATH,
    path.join(root, "codex_chronicle", "chronicle-started.pid"),
    path.join(root, "codex_chronicle", "codex_chronicle.lock"),
    path.join(root, "codex_tape_recorder", "chronicle-started.pid"),
  ]);
}

function recorderStatus() {
  const pidPathsChecked = recorderPidPaths();
  let firstExistingPidPath = null;
  for (const pidPath of pidPathsChecked) {
    let pid = null;
    try {
      pid = Number(fs.readFileSync(pidPath, "utf8").trim());
      firstExistingPidPath = firstExistingPidPath ?? pidPath;
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      return { live: true, unavailable_reason: null, pid_path: pidPath, pid_paths_checked: pidPathsChecked };
    } catch (error) {
      if (error?.code === "EPERM") {
        return { live: true, unavailable_reason: null, pid_path: pidPath, pid_paths_checked: pidPathsChecked };
      }
    }
  }
  return {
    live: false,
    unavailable_reason: "chronicle_recorder_not_running",
    pid_path: firstExistingPidPath,
    pid_paths_checked: pidPathsChecked,
  };
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
    return {
      ok: false,
      root,
      displays: [],
      unavailable_reason: recorder.unavailable_reason,
      stale_reason: null,
      recorder_pid_path: recorder.pid_path,
      recorder_pid_paths_checked: recorder.pid_paths_checked,
    };
  }
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      root,
      displays: [],
      unavailable_reason: "chronicle_recording_root_missing",
      stale_reason: null,
      recorder_pid_path: recorder.pid_path,
      recorder_pid_paths_checked: recorder.pid_paths_checked,
    };
  }
  const nowMs = Date.now();
  const observedDisplays = fs
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
    .filter(Boolean);
  const newestByDisplay = new Map();
  for (const display of observedDisplays) {
    const existing = newestByDisplay.get(display.display_id);
    if (!existing || Date.parse(display.latest_frame_mtime) > Date.parse(existing.latest_frame_mtime)) {
      newestByDisplay.set(display.display_id, display);
    }
  }
  const displays = [...newestByDisplay.values()].sort((left, right) => left.display_id.localeCompare(right.display_id));
  const staleReason = displays.length > 0 && displays.every((display) => display.stale) ? "chronicle_latest_frames_stale" : null;
  return {
    ok: displays.length > 0 && !staleReason,
    root,
    displays,
    unavailable_reason: displays.length <= 0 ? "chronicle_latest_frame_missing" : null,
    stale_reason: staleReason,
    recorder_pid_path: recorder.pid_path,
    recorder_pid_paths_checked: recorder.pid_paths_checked,
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

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function renderHuman(payload) {
  const displays = Array.isArray(payload.displays) ? payload.displays : [];
  const freshCount = displays.filter((display) => display && display.stale === false).length;
  const latest = payload.latest_frame_path ? String(payload.latest_frame_path) : "none";
  console.log(`Chronicle desktop capture: ${payload.status}`);
  console.log(`Recorder pid: ${payload.recorder_pid_path || "not found"}`);
  console.log(`Fresh displays: ${freshCount}/${displays.length}`);
  console.log(`Freshness budget: ${formatAge(Number(payload.max_freshness_seconds))}`);
  console.log(`Freshness: ${payload.freshness_seconds == null ? "unknown" : formatAge(Number(payload.freshness_seconds))}`);
  console.log(`Latest frame: ${latest}`);
  if (payload.stale_reason) console.log(`Stale reason: ${payload.stale_reason}`);
  if (payload.unavailable_reason) console.log(`Unavailable reason: ${payload.unavailable_reason}`);
  console.log(`Next action: ${payload.recommended_next_action}`);
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
  const maxFreshnessSeconds = numberArg("max-freshness-seconds", 300);
  const context = listDisplays({
    maxFreshnessSeconds,
    displayId: stringArg("display-id"),
  });
  const freshDisplays = context.displays.filter((display) => !display.stale);
  const selectedDisplay = freshDisplays[0] ?? context.displays[0] ?? null;
  const hits = action === "search" || stringArg("query")
    ? ocrHits(context.displays, stringArg("query"), numberArg("ocr-max-hits", 10)) ?? []
    : undefined;
  const status = freshDisplays.length > 0 ? "available" : context.displays.length > 0 ? "degraded" : "unavailable";
  const recommendedNextAction =
    status === "available"
      ? "Use latest_frame_path for visual triage, then switch to app, file, or connector data for authoritative extraction."
      : context.stale_reason
        ? "Refresh the Codex/Chronicle desktop capture lane and retry, or use desktop.context screenshot fallback when allowed."
        : "Start or restart the Codex/Chronicle desktop capture lane and confirm macOS Screen Recording permission.";
  const payload = {
    ok: status !== "unavailable",
    status,
    source: status === "unavailable" ? "none" : "chronicle",
    generated_at: generatedAt,
    current_utc: generatedAt,
    max_freshness_seconds: maxFreshnessSeconds,
    freshness_seconds: selectedDisplay?.freshness_seconds ?? null,
    displays: context.displays,
    latest_frame_path: selectedDisplay?.latest_frame_path ?? null,
    screenshot_path: null,
    recorder_pid_path: context.recorder_pid_path,
    recorder_pid_paths_checked: context.recorder_pid_paths_checked,
    ocr_hits: hits,
    ocr_note: hits ? "OCR hits are noisy triage hints only; use app/file/connectors for authoritative extraction." : undefined,
    stale_reason: context.stale_reason,
    unavailable_reason: context.unavailable_reason,
    recommended_next_action: recommendedNextAction,
    host: hostSummary(),
  };
  if (hasFlag("human")) {
    renderHuman(payload);
    process.exitCode = status === "available" ? 0 : 1;
    return;
  }
  console.log(JSON.stringify(payload));
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
