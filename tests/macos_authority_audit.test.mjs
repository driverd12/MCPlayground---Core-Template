import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAppleEventsProbe,
  extractBundlePathFromCommand,
  parseTccRows,
  summarizeAuthorityReadiness,
  summarizeTccService,
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
  ].join("\n"));
  const accessibility = summarizeTccService(rows, "kTCCServiceAccessibility", ["com.apple.Terminal"]);
  const screen = summarizeTccService(rows, "kTCCServiceScreenCapture", ["com.apple.Terminal"]);
  assert.equal(accessibility.status, "granted");
  assert.equal(screen.status, "blocked");
});

test("summarizeAuthorityReadiness requires console, accessibility, screen recording, and root helper", () => {
  const ready = summarizeAuthorityReadiness({
    console_session: { status: "ready" },
    accessibility: { status: "granted" },
    screen_recording: { status: "granted" },
    full_disk_access: { status: "granted" },
    root_helper: { status: "ready" },
  });
  const blocked = summarizeAuthorityReadiness({
    console_session: { status: "ready" },
    accessibility: { status: "blocked" },
    screen_recording: { status: "unknown" },
    full_disk_access: { status: "blocked" },
    root_helper: { status: "blocked" },
  });
  assert.equal(ready.ready_for_patient_zero_full_authority, true);
  assert.deepEqual(blocked.blockers, ["accessibility", "screen_recording", "root_helper", "full_disk_access"]);
});
