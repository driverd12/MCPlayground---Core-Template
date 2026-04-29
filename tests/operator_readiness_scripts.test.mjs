import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sidecarStepAcceptedAllPeers } from "../scripts/federation_soak.mjs";

const REPO_ROOT = process.cwd();

test("federation soak live validation matches configured peer after locator resolution", () => {
  const step = {
    json: {
      sends: [
        {
          peer: "http://Dans-MBP.local:8787",
          target_peer: "http://10.1.2.76:8787",
          ok: true,
          status: 202,
          response: {
            accepted: true,
            result: {
              worker_fabric_heartbeat_ok: true,
            },
          },
        },
      ],
    },
  };

  assert.equal(sidecarStepAcceptedAllPeers(step, ["http://Dans-MBP.local:8787"]), true);
  assert.equal(sidecarStepAcceptedAllPeers(step, ["http://10.1.2.76:8787"]), true);
});

test("storage guard review is read-only and prepares archive/delete plans", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-review-"));
  try {
    const corruptDir = path.join(tempDir, "data", "corrupt");
    const backupsDir = path.join(tempDir, "data", "backups");
    const archiveDir = path.join(tempDir, "data", "storage-evidence-archive", "older", "corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "hub.sqlite.older.large-db-startup-probe"), "corrupt-db");
    fs.writeFileSync(path.join(backupsDir, "hub.sqlite.latest.sqlite"), "backup-db");
    fs.writeFileSync(path.join(archiveDir, "hub.sqlite.archived.large-db-startup-probe"), "archived-db");

    const output = execFileSync("node", ["scripts/storage_guard_review.mjs", "--repo-root", tempDir, "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.read_only, true);
    assert.equal(parsed.evidence.attention_required, true);
    assert.equal(parsed.evidence.artifact_count, 1);
    assert.equal(parsed.evidence.archived.bucket, "archived_evidence");
    assert.equal(parsed.evidence.archived.artifact_count, 1);
    assert.equal(parsed.evidence.archived.total_bytes, "archived-db".length);
    assert.equal(parsed.open_files.evidence.skipped, true);
    assert.ok(parsed.archive_plan.commands.some((command) => command.includes("mv")));
    assert.ok(parsed.delete_plan.commands.some((command) => command.includes("rm -rf")));
    assert.equal(fs.existsSync(path.join(corruptDir, "hub.sqlite.older.large-db-startup-probe")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("federation peer staging prints checks without executing remote actions", () => {
  const output = execFileSync(
    "node",
    [
      "scripts/federation_stage_peer.mjs",
      "--ssh",
      "user@example.local",
      "--host-id",
      "example-host",
      "--remote-peer",
      "http://example.local:8787",
      "--local-peer",
      "http://local.example:8787",
      "--json",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.staged_only, true);
  assert.equal(parsed.executed_remote_commands, false);
  assert.equal(parsed.peer.host_id, "example-host");
  assert.ok(parsed.safe_remote_checks.length >= 3);
  assert.ok(parsed.idle_required_remote_actions.some((entry) => entry.risk.includes("Interrupts")));
  assert.ok(parsed.local_follow_up_actions.some((entry) => entry.command.includes("federation:soak")));
});
