import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePeerIngestResponse } from "../scripts/federation_sidecar.mjs";

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
