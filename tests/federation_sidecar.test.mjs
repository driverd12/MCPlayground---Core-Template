import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePeerIngestResponse,
  parseOptionalNonNegativeNumber,
  postPeer,
  resolvePeerTransportTarget,
  resolvePeerPublishTargets,
} from "../scripts/federation_sidecar.mjs";

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

test("sidecar publish aborts a slow peer with structured failure output", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    });

  const started = Date.now();
  const result = await postPeer(
    { peer: "http://peer.example:8787", target_peer: "http://peer.example:8787" },
    { ok: true },
    {
      hostId: "local-host",
      agentRuntime: "federation-sidecar",
      bearerToken: "test-token",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINenNmz+ywU92k5y98Ks+c3za+y4f8BRN34r32aWynFB\n-----END PRIVATE KEY-----\n",
      publishTimeoutMs: 25,
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "peer_publish_timeout");
  assert.match(result.detail, /timed out after 25ms/);
  assert.ok(Date.now() - started < 1000);
});

test("sidecar numeric options preserve fallback when the flag is missing", () => {
  assert.equal(parseOptionalNonNegativeNumber("", 12_000), 12_000);
  assert.equal(parseOptionalNonNegativeNumber(undefined, 12_000), 12_000);
  assert.equal(parseOptionalNonNegativeNumber("8000", 12_000), 8_000);
  assert.equal(parseOptionalNonNegativeNumber("-1", 12_000), 12_000);
});

test("sidecar resolves .local peer hostnames as transport locators without changing peer identity", async () => {
  const resolved = await resolvePeerTransportTarget(
    {
      peer: "http://Dans-MBP.local:8787",
      target_peer: "http://Dans-MBP.local:8787",
      locator_source: "configured",
    },
    {
      resolvePeerHostnames: true,
      peerResolveTimeoutMs: 25,
      dnsLookup: async () => ({ address: "10.1.2.76" }),
    }
  );

  assert.equal(resolved.peer, "http://Dans-MBP.local:8787");
  assert.equal(resolved.target_peer, "http://10.1.2.76:8787");
  assert.equal(resolved.locator_source, "dns_lookup");
  assert.equal(resolved.resolved_hostname, "dans-mbp.local");
  assert.equal(resolved.resolved_address, "10.1.2.76");
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
