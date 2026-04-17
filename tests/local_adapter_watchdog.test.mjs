import test from "node:test";
import assert from "node:assert/strict";

import { buildPrimaryWatchdogConfig, resolveWatchdogDecision } from "../scripts/local_adapter_watchdog.mjs";

function sampleManifest(overrides = {}) {
  return {
    status: "adapter_primary_mlx",
    primary_soak_result: {
      ok: true,
      completed_at: "2026-04-14T10:00:00.000Z",
    },
    primary_watchdog_contract: {
      max_soak_age_minutes: 240,
      soak_cycles: 1,
      interval_seconds: 0,
    },
    ...overrides,
  };
}

test("buildPrimaryWatchdogConfig returns bounded defaults", () => {
  assert.deepEqual(buildPrimaryWatchdogConfig({}), {
    max_soak_age_minutes: 240,
    soak_cycles: 1,
    interval_seconds: 0,
  });
});

test("resolveWatchdogDecision skips fresh successful soak", () => {
  const decision = resolveWatchdogDecision(sampleManifest(), {
    nowMs: Date.parse("2026-04-14T12:00:00.000Z"),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.should_run_soak, false);
  assert.equal(decision.trigger, "primary_soak_fresh");
});

test("resolveWatchdogDecision honors primary evidence when the reported status regresses", () => {
  const decision = resolveWatchdogDecision(
    sampleManifest({
      status: "adapter_registered",
      integration_result: {
        ok: true,
        target: "mlx",
        backend_id: "mlx-adapter-local-adapter-sample",
        model_id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      },
      cutover_result: {
        ok: true,
        promoted: true,
        target: "mlx",
      },
    }),
    { nowMs: Date.parse("2026-04-14T12:00:00.000Z") }
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.applicable, true);
  assert.equal(decision.status, "adapter_primary_mlx");
  assert.equal(decision.trigger, "primary_soak_fresh");
});

test("resolveWatchdogDecision runs when soak is stale", () => {
  const decision = resolveWatchdogDecision(sampleManifest(), {
    nowMs: Date.parse("2026-04-14T15:00:01.000Z"),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.should_run_soak, true);
  assert.equal(decision.trigger, "primary_soak_stale");
});

test("resolveWatchdogDecision runs when soak is missing or failed", () => {
  const missing = resolveWatchdogDecision(
    {
      status: "adapter_primary_mlx",
    },
    { nowMs: Date.parse("2026-04-14T12:00:00.000Z") }
  );
  assert.equal(missing.should_run_soak, true);
  assert.equal(missing.trigger, "primary_soak_missing");

  const failed = resolveWatchdogDecision(
    sampleManifest({
      primary_soak_result: {
        ok: false,
        completed_at: "2026-04-14T11:00:00.000Z",
      },
    }),
    { nowMs: Date.parse("2026-04-14T12:00:00.000Z") }
  );
  assert.equal(failed.should_run_soak, true);
  assert.equal(failed.trigger, "primary_soak_failed");
});

test("resolveWatchdogDecision rejects non-primary adapters", () => {
  const decision = resolveWatchdogDecision(
    sampleManifest({
      status: "adapter_served_mlx",
    }),
    { nowMs: Date.parse("2026-04-14T12:00:00.000Z") }
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.trigger, "not_primary_adapter");
});
