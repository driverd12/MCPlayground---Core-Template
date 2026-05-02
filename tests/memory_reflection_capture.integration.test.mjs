import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("memory.reflection_capture requires grounded feedback and records searchable episodic memory", async () => {
  const testId = `memory-reflection-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-memory-reflection-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const tools = await listTools(client);
    const names = new Set(tools.map((tool) => tool.name));
    assert.equal(names.has("memory.reflection_capture"), true);

    const captured = await callTool(client, "memory.reflection_capture", {
      mutation: nextMutation(testId, "memory.reflection_capture", () => mutationCounter++),
      title: "LangGraph external memory discipline",
      objective: "Ground reflection memory in real tool feedback instead of self-claims.",
      attempted_action: "Use NotebookLM synthesis to decide the next MCP primitive to implement.",
      grounded_feedback: [
        "NotebookLM recommended externally grounded episodic memory as the cleanest missing MCP primitive.",
        "NotebookLM distinguished orchestration-layer control flow from MCP memory primitives."
      ],
      reflection:
        "The next reusable control-plane primitive should be a grounded reflection memory tool, because planning and evaluator loops already largely exist above the tool boundary.",
      next_actions: [
        "Implement a strict reflection-capture tool requiring grounded feedback.",
        "Use runtime events so these reflections can be audited later."
      ],
      evidence_refs: [
        {
          kind: "notebook",
          label: "LangGraph Design Patterns: Workflows and Agents",
        },
      ],
      tags: ["langgraph", "reflection", "memory"],
      source_client: "integration-test",
      source_model: "test-model",
    });

    assert.equal(captured.grounded_feedback_count, 2);
    assert.equal(captured.next_action_count, 2);
    assert.equal(captured.evidence_ref_count, 1);
    assert.equal(captured.memory.content.includes("Grounded feedback:"), true);
    assert.equal(captured.memory.content.includes("Evidence references:"), true);
    assert.ok(captured.keywords.includes("reflection"));
    assert.ok(captured.keywords.includes("langgraph"));

    const fetched = await callTool(client, "memory.get", {
      id: captured.memory_id,
    });
    assert.equal(fetched.found, true);
    assert.equal(fetched.memory.content.includes("LangGraph external memory discipline"), true);

    const search = await callTool(client, "memory.search", {
      query: "LangGraph external memory discipline",
      limit: 10,
    });
    assert.ok(search.some((entry) => entry.id === captured.memory_id));

    const events = await callTool(client, "event.tail", {
      entity_type: "memory",
      entity_id: String(captured.memory_id),
      event_type: "memory.reflection_captured",
      limit: 10,
    });
    assert.equal(events.count, 1);
    assert.equal(events.events[0].details.grounded_feedback_count, 2);
    assert.equal(events.events[0].details.evidence_ref_count, 1);
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
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-memory-reflection-test", version: "0.1.0" }, { capabilities: {} });
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
