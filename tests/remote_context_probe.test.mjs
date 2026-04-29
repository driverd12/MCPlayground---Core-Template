import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = process.cwd();

test("remote context probe uses default freshness budget when max freshness is omitted", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-remote-context-probe-"));
  try {
    const pidDir = path.join(tempDir, "codex_chronicle");
    const recordingDir = path.join(tempDir, "chronicle", "screen_recording");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.mkdirSync(recordingDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, "chronicle-started.pid"), String(process.pid));

    const framePath = path.join(recordingDir, "2026-04-21T15-00-00.000000+00-00-display-1-latest.jpg");
    fs.writeFileSync(framePath, "jpeg");
    const oldFramePath = path.join(recordingDir, "2026-04-21T14-00-00.000000+00-00-display-1-latest.jpg");
    fs.writeFileSync(oldFramePath, "old-jpeg");
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(oldFramePath, oldTime, oldTime);

    const output = execFileSync("node", ["scripts/remote_context_probe.mjs", "--action=status"], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: `${tempDir}${path.sep}` },
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.status, "available");
    assert.equal(parsed.stale_reason, null);
    assert.equal(parsed.recorder_pid_path, path.join(pidDir, "chronicle-started.pid"));
    assert.equal(parsed.displays.length, 1);
    assert.equal(parsed.latest_frame_path, framePath);
    assert.equal(parsed.displays[0].stale, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remote context probe accepts legacy codex_tape_recorder pid files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-remote-context-probe-legacy-"));
  try {
    const pidDir = path.join(tempDir, "codex_tape_recorder");
    const recordingDir = path.join(tempDir, "chronicle", "screen_recording");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.mkdirSync(recordingDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, "chronicle-started.pid"), String(process.pid));

    const framePath = path.join(recordingDir, "2026-04-21T15-00-00.000000+00-00-display-1-latest.jpg");
    fs.writeFileSync(framePath, "jpeg");

    const output = execFileSync("node", ["scripts/remote_context_probe.mjs", "--action=status"], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: `${tempDir}${path.sep}` },
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.status, "available");
    assert.equal(parsed.recorder_pid_path, path.join(pidDir, "chronicle-started.pid"));
    assert.ok(parsed.recorder_pid_paths_checked.some((entry) => entry.includes("codex_chronicle")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
