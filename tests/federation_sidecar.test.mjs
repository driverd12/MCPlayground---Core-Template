import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePeerIngestResponse, resolvePeerPublishTargets } from "../scripts/federation_sidecar.mjs";

test("sidecar treats accepted-but-unprocessed federation ingest as a failed publish", () => {
  const evaluation = evaluatePeerIngestResponse(
    {
      ok: true,
      status: 202,
    },
    {
      ok: true,
      accepted: true,
      result: {
        worker_fabric_heartbeat_ok: false,
        worker_fabric_heartbeat_reason: "host_not_staged",
        worker_fabric_heartbeat_detail:
          "Verified peer mesh-peer is not staged in worker.fabric yet. Stage and approve the host before treating federation ingest as healthy.",
      },
      hint: {
        code: "host_not_staged",
        detail:
          "Verified peer mesh-peer is not staged in worker.fabric yet. Stage and approve the host before treating federation ingest as healthy.",
      },
    }
  );

  assert.equal(evaluation.ok, false);
  assert.match(String(evaluation.error || ""), /not staged/i);
});

test("sidecar accepts federation ingest only when peer processed it cleanly", () => {
  const evaluation = evaluatePeerIngestResponse(
    {
      ok: true,
      status: 202,
    },
    {
      ok: true,
      accepted: true,
      result: {
        ok: true,
        worker_fabric_heartbeat_ok: true,
      },
    }
  );

  assert.deepEqual(evaluation, { ok: true, error: null });
});

test("sidecar prefers the current observed locator for publish transport while preserving hostname identity", () => {
  const observedAt = new Date().toISOString();
  const resolved = resolvePeerPublishTargets(["http://Dans-MBP.local:8787"], [
    {
      host_id: "dans-mbp",
      enabled: true,
      metadata: {
        remote_access: {
          status: "approved",
          hostname: "Dans-MBP.local",
          ip_address: "10.1.3.224",
          allowed_addresses: ["10.1.3.224"],
        },
        federation: {
          identity: {
            requesting_remote_address: "192.168.86.28",
            approval_scope: {
              observed_remote_address: "192.168.86.28",
              hostname_resolved_addresses: ["10.1.2.76"],
            },
          },
        },
        remote_locator: {
          current_ip_address: "192.168.86.28",
          observed_at: observedAt,
        },
      },
    },
  ]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].peer, "http://Dans-MBP.local:8787");
  assert.equal(resolved[0].target_peer, "http://192.168.86.28:8787");
  assert.equal(resolved[0].matched_host_id, "dans-mbp");
  assert.equal(resolved[0].matched_by, "hostname");
  assert.equal(resolved[0].locator_source, "remote_current_address");
});

test("sidecar ignores stale observed locators and stays on the configured hostname", () => {
  const resolved = resolvePeerPublishTargets(["http://Dans-MBP.local:8787"], [
    {
      host_id: "dans-mbp",
      enabled: true,
      metadata: {
        remote_access: {
          status: "approved",
          hostname: "Dans-MBP.local",
          ip_address: "10.1.3.224",
          allowed_addresses: ["10.1.3.224"],
        },
        remote_locator: {
          current_ip_address: "192.168.86.28",
          observed_at: "2026-04-22T15:51:39.000Z",
        },
      },
    },
  ]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].peer, "http://Dans-MBP.local:8787");
  assert.equal(resolved[0].target_peer, "http://Dans-MBP.local:8787");
  assert.equal(resolved[0].matched_host_id, "dans-mbp");
  assert.equal(resolved[0].matched_by, "hostname");
  assert.equal(resolved[0].locator_source, "configured");
});

test("sidecar leaves the configured peer target alone when no fresher locator is known", () => {
  const resolved = resolvePeerPublishTargets(["http://Dans-MBP.local:8787"], [
    {
      host_id: "dans-mbp",
      enabled: true,
      metadata: {
        remote_access: {
          status: "approved",
          hostname: "Dans-MBP.local",
          ip_address: "10.1.3.224",
          allowed_addresses: ["10.1.3.224"],
        },
      },
    },
  ]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].peer, "http://Dans-MBP.local:8787");
  assert.equal(resolved[0].target_peer, "http://Dans-MBP.local:8787");
  assert.equal(resolved[0].locator_source, "configured");
});
