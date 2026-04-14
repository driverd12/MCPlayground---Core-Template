import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("golden.case_capture persists a verified golden case, event, and linked benchmark seed", async () => {
  const testId = `golden-case-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-golden-case-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const tools = await listTools(client);
    const names = new Set(tools.map((tool) => tool.name));
    assert.equal(names.has("golden.case_capture"), true);

    const incident = await callTool(client, "incident.open", {
      mutation: nextMutation(testId, "incident.open", () => mutationCounter++),
      severity: "P2",
      title: "Office snapshot stale-state regression",
      summary: "Operator truth degraded after a cached snapshot recovered slowly.",
      tags: ["office", "snapshot", "regression"],
      source_client: "integration-test",
    });

    const golden = await callTool(client, "golden.case_capture", {
      mutation: nextMutation(testId, "golden.case_capture", () => mutationCounter++),
      title: "Cached snapshot must degrade truthfully",
      objective: "Prevent office refresh regressions from overstating readiness or losing stale fallback state.",
      source_kind: "research",
      scenario_prompt:
        "Simulate a slow office snapshot refresh, then verify the control plane serves stale-but-truthful state instead of hanging or returning false readiness.",
      expected_outcomes: [
        "Office snapshot returns cached or stale truth instead of timing out.",
        "Operator-facing readiness remains conservative.",
      ],
      tool_expectations: ["office.snapshot should prefer cached truth under load", "event.tail should record the captured golden case"],
      invariant_checks: ["No false ready state after stale refresh", "No empty office roster when cached state exists"],
      regression_tags: ["office", "snapshot", "cache", "truth"],
      severity: "P2",
      benchmark_seed: {
        command: "node ./scripts/production_readiness.sh --office-smoke",
        timeout_seconds: 180,
        reward_file_path: "logs/reward.txt",
      },
      related_entities: [
        {
          entity_type: "incident",
          entity_id: incident.incident_id,
          relation: "attached_to",
        },
      ],
      source_client: "integration-test",
      source_model: "test-model",
    });

    assert.equal(golden.ok, true);
    assert.equal(golden.artifact.artifact_type, "golden_case");
    assert.equal(golden.artifact.trust_tier, "verified");
    assert.equal(golden.links_created, 1);
    assert.equal(golden.suggested_benchmark_case.metric_mode, "reward_file");
    assert.equal(golden.suggested_benchmark_case.reward_file_path, "logs/reward.txt");

    const fetchedArtifact = await callTool(client, "artifact.get", {
      artifact_id: golden.artifact.artifact_id,
    });
    assert.equal(fetchedArtifact.found, true);
    assert.equal(fetchedArtifact.artifact.artifact_type, "golden_case");
    assert.equal(fetchedArtifact.artifact.content_json.golden_case_id, golden.golden_case_id);
    assert.equal(fetchedArtifact.artifact.content_json.source_kind, "research");
    assert.deepEqual(fetchedArtifact.artifact.content_json.regression_tags, ["office", "snapshot", "cache", "truth"]);

    const incidentBundle = await callTool(client, "artifact.bundle", {
        entity: {
          entity_type: "incident",
          entity_id: incident.incident_id,
        },
      limit: 20,
    });
    assert.equal(incidentBundle.found, true);
    assert.ok(incidentBundle.artifacts.some((artifact) => artifact.artifact_id === golden.artifact.artifact_id));

    const events = await callTool(client, "event.tail", {
      entity_type: "artifact",
      entity_id: golden.artifact.artifact_id,
      event_type: "golden.case_captured",
      limit: 10,
    });
    assert.equal(events.count, 1);
    assert.equal(events.events[0].event_type, "golden.case_captured");
    assert.equal(events.events[0].details.golden_case_id, golden.golden_case_id);
    assert.equal(events.events[0].details.benchmark_seeded, true);
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(dbPath, extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_AGENT_IDS: "",
      ...extraEnv,
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-golden-case-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return { client };
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `${testId}-${safeToolName}-${index}`,
  };
}

async function listTools(client) {
  const response = await client.listTools();
  return response.tools ?? [];
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
