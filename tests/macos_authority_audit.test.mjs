import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAppleEventsProbe,
  extractBundlePathFromCommand,
  parseTccRows,
  summarizeAuthorityReadiness,
  summarizeTccService,
  upgradeStatusWithDesktopProof,
} from "../scripts/macos_authority_audit.mjs";

test("extractBundlePathFromCommand finds app bundle paths in ancestor commands", () => {
  assert.equal(
    extractBundlePathFromCommand("/Applications/Codex.app/Contents/MacOS/Codex --flag"),
    "/Applications/Codex.app"
  );
  assert.equal(extractBundlePathFromCommand("/usr/bin/node dist/server.js"), null);
});

test("classifyAppleEventsProbe recognizes blocked accessibility probes", () => {
  const blocked = classifyAppleEventsProbe({
    ok: false,
    stderr: "osascript is not allowed assistive access. (-1719)",
    stdout: "",
    error: null,
  });
  const granted = classifyAppleEventsProbe({
    ok: true,
    stderr: "",
    stdout: "42",
    error: null,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(granted.status, "granted");
});

test("parseTccRows and summarizeTccService classify matched clients", () => {
  const rows = parseTccRows([
    "kTCCServiceAccessibility\tcom.apple.Terminal\t2\t4",
    "kTCCServiceScreenCapture\tcom.apple.Terminal\t0\t4",
    "kTCCServiceMicrophone\tcom.apple.Terminal\t2\t4",
  ].join("\n"));
  const accessibility = summarizeTccService(rows, "kTCCServiceAccessibility", ["com.apple.Terminal"]);
  const screen = summarizeTccService(rows, "kTCCServiceScreenCapture", ["com.apple.Terminal"]);
  const microphone = summarizeTccService(rows, "kTCCServiceMicrophone", ["com.apple.Terminal"]);
  assert.equal(accessibility.status, "granted");
  assert.equal(screen.status, "blocked");
  assert.equal(microphone.status, "granted");
});

test("summarizeAuthorityReadiness requires console, accessibility, screen recording, microphone listen lane, and root helper", () => {
  const ready = summarizeAuthorityReadiness({
    console_session: { status: "ready" },
    accessibility: { status: "granted" },
    screen_recording: { status: "granted" },
    microphone_listen_lane: { status: "granted" },
    full_disk_access: { status: "granted" },
    root_helper: { status: "ready" },
  });
  const blocked = summarizeAuthorityReadiness({
    console_session: { status: "ready" },
    accessibility: { status: "blocked" },
    screen_recording: { status: "unknown" },
    microphone_listen_lane: { status: "unknown" },
    full_disk_access: { status: "blocked" },
    root_helper: { status: "blocked" },
  });
  assert.equal(ready.ready_for_patient_zero_full_authority, true);
  assert.deepEqual(blocked.blockers, ["accessibility", "screen_recording", "microphone_listen_lane", "root_helper", "full_disk_access"]);
});

test("upgradeStatusWithDesktopProof accepts recent live desktop lane evidence", () => {
  const microphone = upgradeStatusWithDesktopProof(
    { status: "unknown", detail: "No matching TCC rows were found for the active shell/app clients." },
    {
      state: { last_listen_at: "2026-04-14T13:32:10.111Z", last_error: null },
      summary: { listen_ready: true },
    },
    "microphone"
  );
  const screenWithoutScreenshot = upgradeStatusWithDesktopProof(
    { status: "unknown", detail: "No matching TCC rows were found for the active shell/app clients." },
    {
      state: { last_observation_at: "2026-04-14T13:35:00.000Z", last_error: null },
      summary: { observe_ready: true },
    },
    "screen"
  );
  const screenWithScreenshot = upgradeStatusWithDesktopProof(
    { status: "unknown", detail: "No matching TCC rows were found for the active shell/app clients." },
    {
      state: {
        last_observation_at: "2026-04-14T13:35:00.000Z",
        last_screenshot_at: "2026-04-14T13:36:00.000Z",
        last_error: null,
      },
      summary: { observe_ready: true },
    },
    "screen"
  );
  assert.equal(microphone.status, "granted");
  assert.match(microphone.detail, /Live desktop\.listen proof succeeded/);
  assert.equal(screenWithoutScreenshot.status, "unknown");
  assert.equal(screenWithScreenshot.status, "granted");
  assert.match(screenWithScreenshot.detail, /screenshot proof succeeded/);
});
