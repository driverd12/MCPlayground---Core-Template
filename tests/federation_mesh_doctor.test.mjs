import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseLaunchctlDisabled,
  parseLaunchctlPrint,
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
