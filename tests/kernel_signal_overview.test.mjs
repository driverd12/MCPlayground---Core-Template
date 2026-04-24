import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Storage } from "../dist/storage.js";

test("storage kernel signal overview bundles recent runtime and observability signals for kernel.summary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-signal-overview-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  try {
    const storage = new Storage(dbPath);
    storage.init();

    const recentAt = new Date().toISOString();
    const oldAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

    storage.appendRuntimeEvent({
      created_at: recentAt,
      event_type: "task.created",
      entity_type: "task",
      entity_id: "task-1",
      summary: "task created",
    });
    storage.appendRuntimeEvent({
      created_at: recentAt,
      event_type: "autonomy.command",
      entity_type: "daemon",
      entity_id: "autonomy",
      summary: "router suppression",
      details: {
        model_router_auto_bridge_suppressed_for_local_first: true,
        model_router_suppression_decision_id: "decision-1",
      },
    });
    storage.appendRuntimeEvent({
      created_at: oldAt,
      event_type: "autonomy.command",
      entity_type: "daemon",
      entity_id: "autonomy",
      summary: "older router suppression",
      details: {
        model_router_auto_bridge_suppressed_for_resource_gate: true,
        model_router_suppression_decision_id: "decision-old",
      },
    });

    storage.upsertObservabilityDocument({
      created_at: recentAt,
      updated_at: recentAt,
      index_name: "logs-autonomy",
      source_kind: "integration.test",
      host_id: "local",
      service: "autonomy.maintain",
      level: "critical",
      event_type: "maintain.stale",
      title: "autonomy stale",
      body_text: "autonomy maintain stale",
    });
    storage.upsertObservabilityDocument({
      created_at: recentAt,
      updated_at: recentAt,
      index_name: "logs-fabric",
      source_kind: "integration.test",
      host_id: "local",
      service: "worker.fabric",
      level: "info",
      event_type: "fabric.refresh",
      title: "fabric refresh",
      body_text: "fabric refresh complete",
    });

    const recentWindow = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const overview = storage.getKernelSignalOverview({
      event_limit: 20,
      event_top_count_limit: 12,
      router_suppression_limit: 40,
      observability_since: recentWindow,
      observability_recent_limit: 6,
      observability_alert_limit: 24,
      observability_top_count_limit: 6,
    });

    assert.equal(overview.recent_runtime_events.length >= 2, true);
    assert.equal(overview.runtime_event_summary.count >= 3, true);
    assert.equal(
      overview.runtime_event_summary.event_type_counts.some((entry) => entry.event_type === "autonomy.command"),
      true
    );
    assert.equal(overview.recent_router_suppression_events.length >= 2, true);
    assert.equal(overview.observability_overview.count, 2);
    assert.equal(overview.recent_observability_documents.length, 2);
    assert.equal(overview.recent_observability_alerts.length, 1);
    assert.equal(overview.recent_observability_alerts[0].service, "autonomy.maintain");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
