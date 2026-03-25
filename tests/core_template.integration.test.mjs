import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("server starts without domain packs and exposes core + TriChat tools", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const tools = await listTools(client);
    const names = new Set(tools.map((tool) => tool.name));

    assert.equal(names.has("memory.append"), true);
    assert.equal(names.has("goal.create"), true);
    assert.equal(names.has("goal.get"), true);
    assert.equal(names.has("goal.list"), true);
    assert.equal(names.has("task.create"), true);
    assert.equal(names.has("transcript.log"), true);

    assert.equal(names.has("trichat.thread_open"), true);
    assert.equal(names.has("trichat.tmux_controller"), true);
    assert.equal(names.has("trichat.roster"), true);
    assert.equal(names.has("simulate.workflow"), true);
    assert.equal(names.has("cfd.case.create"), false);

    const roster = await callTool(client, "trichat.roster", {});
    assert.deepEqual(roster.active_agent_ids, ["codex", "cursor", "local-imprint"]);
    assert.equal(Array.isArray(roster.agents), true);
    assert.ok(roster.agents.some((agent) => agent.agent_id === "codex" && agent.active === true));

    await callTool(client, "memory.append", {
      mutation: nextMutation(testId, "memory.append", () => mutationCounter++),
      content: "core template integration memory",
      keywords: ["core", "template"],
    });

    const memories = await callTool(client, "memory.search", {
      query: "integration memory",
      limit: 5,
    });
    assert.equal(Array.isArray(memories), true);
    assert.ok(memories.length >= 1);

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Core template integration goal",
      objective: "Introduce durable goal primitives",
      status: "active",
      priority: 7,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["Goal persists locally", "Goal is readable via MCP tool"],
      constraints: ["Do not change task orchestration behavior"],
      tags: ["core", "goal"],
    });
    assert.equal(createdGoal.created, true);
    assert.equal(typeof createdGoal.goal.goal_id, "string");
    assert.equal(createdGoal.goal.status, "active");

    const fetchedGoal = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(fetchedGoal.found, true);
    assert.equal(fetchedGoal.goal.goal_id, createdGoal.goal.goal_id);

    const listedGoals = await callTool(client, "goal.list", {
      status: "active",
      limit: 10,
    });
    assert.ok(listedGoals.count >= 1);
    assert.ok(listedGoals.goals.some((goal) => goal.goal_id === createdGoal.goal.goal_id));

    const runBegin = await callTool(client, "run.begin", {
      mutation: nextMutation(testId, "run.begin", () => mutationCounter++),
      summary: "core template test run",
    });
    assert.equal(typeof runBegin.run_id, "string");

    await callTool(client, "run.step", {
      mutation: nextMutation(testId, "run.step", () => mutationCounter++),
      run_id: runBegin.run_id,
      step_index: 1,
      status: "completed",
      summary: "step complete",
    });

    await callTool(client, "run.end", {
      mutation: nextMutation(testId, "run.end", () => mutationCounter++),
      run_id: runBegin.run_id,
      status: "succeeded",
      summary: "run complete",
    });

    const timeline = await callTool(client, "run.timeline", {
      run_id: runBegin.run_id,
      limit: 10,
    });
    assert.ok(timeline.count >= 3);

    const task = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create", () => mutationCounter++),
      objective: "Core template queue task",
      priority: 5,
      tags: ["core"],
    });
    assert.equal(typeof task.task.task_id, "string");

    const listed = await callTool(client, "task.list", {
      status: "pending",
      limit: 10,
    });
    assert.ok(listed.count >= 1);

    const storageHealth = await callTool(client, "health.storage", {});
    assert.equal(storageHealth.ok, true);
    assert.ok(storageHealth.schema_version >= 4);
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
      ...extraEnv,
    }),
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-core-template-integration-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
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
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function listTools(client) {
  const response = await client.listTools();
  return response.tools ?? [];
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
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
