import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLocalFindings,
  parseLaunchctlDisabled,
  parseLaunchctlPrint,
  summarizeUnstagedVerifiedPeers,
  summarizeIdentityKeys,
} from "../scripts/federation_mesh_doctor.mjs";

test("summarizeIdentityKeys reports local host identity drift when only older host ids have keys", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-federation-doctor-identity-"));
  try {
    fs.writeFileSync(path.join(tempDir, "dans-macbook-pro-ed25519.pem"), "private");
    fs.writeFileSync(path.join(tempDir, "dans-macbook-pro-ed25519.pub.pem"), "public");

    const summary = summarizeIdentityKeys(tempDir, "mac.lan", path.join(tempDir, "mac.lan-ed25519.pem"));
    assert.equal(summary.key_count, 1);
    assert.deepEqual(summary.host_ids, ["dans-macbook-pro"]);
    assert.equal(summary.matching_host_id, null);
    assert.equal(summary.suggested_host_id, "dans-macbook-pro");
    assert.equal(summary.drift, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseLaunchctlPrint extracts running state and log paths", () => {
  const parsed = parseLaunchctlPrint(`
gui/501/com.master-mold.federation.sidecar = {
  path = /Users/dan.driver/Library/LaunchAgents/com.master-mold.federation.sidecar.plist
  state = running
  working directory = /Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD
  stdout path = /Users/dan.driver/Library/Application Support/master-mold/launchd-logs/federation-sidecar.out.log
  stderr path = /Users/dan.driver/Library/Application Support/master-mold/launchd-logs/federation-sidecar.err.log
  runs = 7
  pid = 4242
  last terminating signal = Terminated: 15
}
`);

  assert.equal(parsed.state, "running");
  assert.equal(parsed.path, "/Users/dan.driver/Library/LaunchAgents/com.master-mold.federation.sidecar.plist");
  assert.equal(parsed.working_directory, "/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD");
  assert.equal(parsed.stdout_path, "/Users/dan.driver/Library/Application Support/master-mold/launchd-logs/federation-sidecar.out.log");
  assert.equal(parsed.stderr_path, "/Users/dan.driver/Library/Application Support/master-mold/launchd-logs/federation-sidecar.err.log");
  assert.equal(parsed.runs, 7);
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.last_terminating_signal, "Terminated: 15");
});

test("parseLaunchctlDisabled reads enabled and disabled labels", () => {
  const disabledSnapshot = `
disabled services = {
  "com.master-mold.federation.sidecar" => enabled
  "com.master-mold.mlx.server" => disabled
}
`;

  assert.equal(parseLaunchctlDisabled(disabledSnapshot, "com.master-mold.federation.sidecar"), false);
  assert.equal(parseLaunchctlDisabled(disabledSnapshot, "com.master-mold.mlx.server"), true);
  assert.equal(parseLaunchctlDisabled(disabledSnapshot, "com.master-mold.mcp.server"), null);
});

test("buildLocalFindings surfaces failed sidecar cycles and aged outbox", () => {
  const findings = buildLocalFindings(
    "dans-macbook-pro",
    { present: true },
    { drift: false, host_ids: [] },
    { present: true, loaded: true, disabled: false },
    {
      present: true,
      last_cycle_ok: false,
      peer_count: 2,
      ok_peer_count: 1,
      failing_peer_count: 1,
      outbox_depth: 3,
      oldest_pending_age_seconds: 181,
    }
  );

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["sidecar_last_cycle_failed", "sidecar_outbox_pending"]
  );
  assert.equal(findings[0].severity, "warn");
  assert.match(findings[0].detail, /failing=1/);
  assert.match(findings[1].detail, /oldest pending publish is 3m old/);
});

test("summarizeUnstagedVerifiedPeers keeps only latest unstaged verified peers outside the current fabric", () => {
  const peers = summarizeUnstagedVerifiedPeers(
    [
      {
        event_id: "evt-1",
        event_seq: 7,
        entity_id: "mesh-a",
        created_at: "2026-04-23T20:00:00.000Z",
        details: {
          reason: "host_not_staged",
          detail: "Verified peer mesh-a is not staged in worker.fabric yet.",
        },
      },
      {
        event_id: "evt-2",
        event_seq: 8,
        entity_id: "mesh-a",
        created_at: "2026-04-23T20:01:00.000Z",
        details: {
          reason: "host_not_staged",
          detail: "Verified peer mesh-a is still not staged in worker.fabric yet.",
        },
      },
      {
        event_id: "evt-3",
        event_seq: 9,
        entity_id: "mesh-b",
        created_at: "2026-04-23T20:02:00.000Z",
        details: {
          reason: "worker_fabric_heartbeat_failed",
          detail: "generic heartbeat problem",
        },
      },
      {
        event_id: "evt-4",
        event_seq: 10,
        entity_id: "dans-mbp",
        created_at: "2026-04-23T20:03:00.000Z",
        details: {
          reason: "host_not_staged",
          detail: "old warning for a host that is now staged",
        },
      },
    ],
    {
      knownHostIds: ["dans-mbp"],
    }
  );

  assert.equal(peers.length, 1);
  assert.equal(peers[0].host_id, "mesh-a");
  assert.equal(peers[0].event_id, "evt-2");
  assert.match(String(peers[0].detail || ""), /still not staged/i);
});
