import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";

const REPO_ROOT = process.cwd();

test("knowledge.query includes signed federated summaries while who_knows stays local by default", async () => {
  const testId = `${Date.now()}-federated-query`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-federated-query-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const client = await openClient(dbPath, {
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(client, "memory.append", {
      mutation: nextMutation(testId, "memory.append", () => mutationCounter++),
      content: "Local printer toner workflow note for the office queue.",
      keywords: ["printer", "toner", "office"],
    });

    const recentMemory = await callTool(client, "memory.recent", { limit: 5 });
    assert.equal(recentMemory.count, 1);
    assert.equal(Array.isArray(recentMemory.memories), true);
    assert.match(recentMemory.memories[0].content, /printer toner workflow/i);

    const storage = new Storage(dbPath);
    storage.appendRuntimeEvent({
      created_at: "2026-04-24T18:00:00.000Z",
      event_type: "federation.ingest",
      entity_type: "worker_fabric_host",
      entity_id: "dans-mbp",
      status: "ok",
      summary: "signed slim federation ingest from dans-mbp",
      details: {
        federation_identity: {
          requesting_host_id: "dans-mbp",
          requesting_remote_address: "192.168.86.28",
          captured_from_host_id: "dans-mbp",
          captured_hostname: "Dans-MBP.local",
          captured_agent_runtime: "claude",
          captured_model_label: "Claude Opus",
          signed_at: "2026-04-24T18:00:00.000Z",
          received_at: "2026-04-24T18:00:01.000Z",
          signature_verification_result: {
            status: "verified",
          },
          approval_scope: {
            status: "approved",
            matched_by: "approved_host_identity",
            permission_profile: "task_worker",
          },
        },
        shared_summaries: {
          status: "available",
          source: "mcp_tool_call",
          memories: [
            {
              memory_id: "mem-remote-1",
              created_at: "2026-04-24T17:58:00.000Z",
              keywords: ["vpn", "onsite", "duo"],
              preview: "Onsite VPN bootstrap requires Duo reset before dispatch.",
            },
          ],
          goals: [
            {
              goal_id: "goal-remote-1",
              updated_at: "2026-04-24T17:59:00.000Z",
              status: "active",
              title: "Normalize VPN bootstrap",
              objective: "Standardize the onsite VPN bootstrap playbook for technicians.",
              tags: ["vpn", "onsite"],
            },
          ],
          tasks: [
            {
              task_id: "task-remote-1",
              updated_at: "2026-04-24T17:59:30.000Z",
              status: "failed",
              objective: "Repair VPN bootstrap on the field laptop.",
              source_agent: "federation-sidecar",
              last_error: "Duo token expired during bootstrap.",
            },
          ],
          capabilities: [
            {
              capability_id: "dans-mbp:capability-summary",
              host_id: "dans-mbp",
              hostname: "Dans-MBP.local",
              worker_fabric: {
                status: "enabled",
                summary: "worker fabric backend accepts local and remote task delegation",
              },
              model_router: {
                status: "available",
                summary: "local model router can explain backend readiness",
              },
              provider_bridge: {
                status: "partial",
                summary: "Claude Codex Cursor provider bridge visibility is present",
              },
              desktop_control: {
                status: "ready",
                summary: "desktop observe freshness is available without screenshot payloads",
              },
            },
          ],
        },
      },
      source_client: "federation.sidecar",
      source_agent: "claude",
      source_model: "Claude Opus",
    });

    const localOnly = await callTool(client, "who_knows", {
      query: "duo reset before dispatch",
      limit: 5,
    });
    assert.equal(localOnly.local_only, true);
    assert.equal(localOnly.counts.federated_matches, 0);
    assert.equal(localOnly.matches.some((entry) => String(entry.type || "").startsWith("federated_")), false);

    const federated = await callTool(client, "knowledge.query", {
      query: "duo reset before dispatch",
      limit: 5,
    });
    assert.equal(federated.local_only, false);
    assert.equal(federated.counts.federated_matches, 1);
    assert.equal(federated.federated_matches.length, 1);
    assert.equal(federated.federated_matches[0].type, "federated_memory");
    assert.equal(federated.federated_matches[0].host_id, "dans-mbp");
    assert.equal(federated.federated_matches[0].hostname, "Dans-MBP.local");
    assert.equal(federated.federated_matches[0].signature_verification_result.status, "verified");
    assert.equal(federated.federated_matches[0].approval_scope.matched_by, "approved_host_identity");
    assert.match(federated.federated_matches[0].text, /duo reset before dispatch/i);
    assert.equal(federated.matches[0].type, "federated_memory");

    const goalOnly = await callTool(client, "knowledge.query", {
      query: "onsite vpn playbook technicians",
      federated_kinds: ["goal"],
      limit: 5,
    });
    assert.equal(goalOnly.counts.federated_matches, 1);
    assert.equal(goalOnly.federated_matches[0].type, "federated_goal");
    assert.equal(goalOnly.federated_matches[0].kind, "goal");
    assert.equal(goalOnly.federated_matches[0].host_id, "dans-mbp");

    const blockerOnly = await callTool(client, "knowledge.query", {
      query: "duo token expired bootstrap",
      federated_focus: "blocker",
      federated_host_ids: ["dans-mbp"],
      federated_trust_statuses: ["verified"],
      federated_provenance: "approved_host_identity",
      limit: 5,
    });
    assert.equal(blockerOnly.counts.federated_matches, 1);
    assert.equal(blockerOnly.federated_matches[0].type, "federated_task");
    assert.equal(blockerOnly.federated_matches[0].kind, "task");
    assert.equal(blockerOnly.federated_matches[0].summary.status, "failed");
    assert.match(blockerOnly.federated_matches[0].text, /duo token expired/i);

    const capabilityOnly = await callTool(client, "knowledge.query", {
      query: "worker fabric provider bridge visibility",
      federated_focus: "capability",
      federated_trust_statuses: ["verified"],
      federated_provenance: "approved_host_identity",
      limit: 5,
    });
    assert.equal(capabilityOnly.counts.federated_matches, 1);
    assert.equal(capabilityOnly.federated_matches[0].type, "federated_capability");
    assert.equal(capabilityOnly.federated_matches[0].kind, "capability");
    assert.equal(capabilityOnly.federated_matches[0].summary.capability_id, "dans-mbp:capability-summary");
  } finally {
    await client.close().catch(() => {});
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
    stderr: "inherit",
  });

  const client = new Client({ name: "mcp-federated-query-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return client;
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
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
