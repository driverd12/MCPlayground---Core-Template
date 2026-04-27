import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadSidecarState,
  matchSidecarPeerResultToHost,
  nextSidecarSequence,
  recordSidecarCycle,
  summarizeSidecarState,
} from "../scripts/federation_sidecar_state.mjs";

test("sidecar state tracks sequence and per-peer send outcomes durably", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-federation-sidecar-state-"));
  const statePath = path.join(tempDir, "mac-lan-sidecar-state.json");
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          sequence: 2,
          peer_results: {
            "http://peer-a.local:8787/": {
              peer: "http://peer-a.local:8787/",
              success_count: 1,
              failure_count: 0,
              consecutive_failures: 0,
              last_ok_at: "2026-04-23T00:00:00.000Z",
            },
          },
        },
        null,
        2
      )
    );

    const sequence = nextSidecarSequence(statePath, {
      hostId: "mac.lan",
      streamId: "mac.lan:master-mold",
    });
    assert.equal(sequence, 3);

    const updated = recordSidecarCycle(statePath, {
      hostId: "mac.lan",
      streamId: "mac.lan:master-mold",
      sequence,
      generatedAt: "2026-04-23T10:00:00.000Z",
      attemptAt: "2026-04-23T10:00:05.000Z",
      intervalSeconds: 30,
      payload: {
        stream_id: "mac.lan:master-mold",
        sequence,
        generated_at: "2026-04-23T10:00:00.000Z",
        host: { host_id: "mac.lan" },
      },
      sends: [
        {
          peer: "http://peer-a.local:8787",
          ok: false,
          status: 502,
          error: "bad gateway",
        },
        {
          peer: "http://peer-b.local:8787",
          ok: true,
          status: 202,
          response: {
            ok: true,
            accepted: true,
            event_id: "evt-fed-1",
            result: {
              sequence,
              event_id: "evt-fed-1",
              event_seq: 42,
              worker_fabric_heartbeat_ok: true,
            },
          },
        },
      ],
    });

    assert.equal(updated.sequence, 3);
    assert.equal(updated.last_cycle_ok, false);
    assert.equal(updated.interval_seconds, 30);

    const reloaded = loadSidecarState(statePath);
    assert.equal(reloaded.host_id, "mac.lan");
    assert.equal(reloaded.stream_id, "mac.lan:master-mold");
    assert.equal(reloaded.sequence, 3);
    assert.equal(reloaded.peer_results["http://peer-a.local:8787/"].failure_count, 1);
    assert.equal(reloaded.peer_results["http://peer-a.local:8787/"].consecutive_failures, 1);
    assert.equal(reloaded.peer_results["http://peer-a.local:8787/"].last_ok_at, "2026-04-23T00:00:00.000Z");
    assert.deepEqual(reloaded.peer_results["http://peer-a.local:8787/"].resend_window_sequences, [3]);
    assert.equal(reloaded.peer_results["http://peer-b.local:8787/"].success_count, 1);
    assert.equal(reloaded.peer_results["http://peer-b.local:8787/"].last_http_status, 202);
    assert.equal(reloaded.peer_results["http://peer-b.local:8787/"].ack_persisted_sequence, 3);
    assert.equal(reloaded.peer_results["http://peer-b.local:8787/"].ack_processed_sequence, 3);
    assert.equal(reloaded.outbox.length, 1);
    assert.equal(reloaded.outbox[0].pending_peers.length, 1);
    assert.equal(reloaded.outbox[0].pending_peers[0], "http://peer-a.local:8787/");
    assert.equal(reloaded.retry_ledger.length, 2);

    const summary = summarizeSidecarState(statePath, reloaded);
    assert.equal(summary.present, true);
    assert.equal(summary.peer_count, 2);
    assert.equal(summary.ok_peer_count, 1);
    assert.equal(summary.failing_peer_count, 1);
    assert.equal(summary.outbox_depth, 1);
    assert.equal(summary.retry_ledger_count, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sidecar peer matching prefers durable hostname identity over locator drift", () => {
  const match = matchSidecarPeerResultToHost(
    {
      "http://192.168.86.28:8787/": {
        peer: "http://192.168.86.28:8787/",
        last_ok: true,
      },
      "http://Dans-MBP.local:8787/": {
        peer: "http://Dans-MBP.local:8787/",
        last_ok: true,
      },
    },
    {
      hostname: "Dans-MBP.local",
      current_remote_address: "192.168.86.28",
      approved_ip_address: "10.1.3.224",
      allowed_addresses: ["10.1.3.224"],
      resolved_addresses: ["192.168.86.28"],
    }
  );

  assert.ok(match);
  assert.equal(match.matched_by, "hostname");
  assert.equal(match.result.peer, "http://Dans-MBP.local:8787/");
});
