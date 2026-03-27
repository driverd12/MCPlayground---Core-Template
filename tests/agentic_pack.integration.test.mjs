import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("default agentic pack generates delivery and optimization hooks for local development goals", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agentic-pack-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});

  try {
    const tools = await listTools(client);
    const names = new Set(tools.map((tool) => tool.name));
    assert.equal(names.has("cfd.case.create"), false);
    assert.equal(names.has("pack.hooks.list"), true);
    assert.equal(names.has("goal.plan_generate"), true);
    assert.equal(names.has("pack.verify.run"), true);

    const hookList = await callTool(client, "pack.hooks.list", {
      pack_id: "agentic",
    });
    assert.ok(hookList.hooks.some((hook) => hook.hook_kind === "planner" && hook.hook_name === "delivery_path"));
    assert.ok(hookList.hooks.some((hook) => hook.hook_kind === "planner" && hook.hook_name === "optimization_loop"));
    assert.ok(
      hookList.hooks.some((hook) => hook.hook_kind === "verifier" && hook.hook_name === "execution_readiness")
    );

    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Ship agentic workflow improvements",
      objective: "Improve local multi-agent execution for Cursor and Codex",
      status: "active",
      target_entity_type: "workspace",
      target_entity_id: "repo-root",
      acceptance_criteria: [
        "A selected plan exists for the goal",
        "Verification steps are explicit",
      ],
      constraints: ["Keep changes bounded and reversible"],
      tags: ["agentic", "delivery"],
    });
    assert.equal(goal.created, true);

    const codexSession = await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "session-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      capabilities: {
        planning: true,
        coding: true,
      },
    });
    const cursorSession = await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.cursor", () => mutationCounter++),
      session_id: "session-cursor",
      agent_id: "cursor",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      capabilities: {
        planning: true,
        review: true,
      },
    });
    assert.equal(codexSession.session.agent_id, "codex");
    assert.equal(cursorSession.session.agent_id, "cursor");

    const deliveryPlan = await callTool(client, "goal.plan_generate", {
      mutation: nextMutation(testId, "goal.plan_generate.delivery", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      pack_id: "agentic",
      hook_name: "delivery_path",
    });
    assert.equal(deliveryPlan.ok, true);
    assert.equal(deliveryPlan.plan.planner_id, "agentic.delivery_path");
    assert.ok(deliveryPlan.steps.some((step) => step.tool_name === "goal.get"));
    assert.ok(deliveryPlan.steps.some((step) => step.tool_name === "pack.verify.run"));
    assert.deepEqual(
      deliveryPlan.steps.find((step) => step.title === "Map the relevant codebase and continuity surface").input.routing
        .preferred_agent_ids,
      ["codex", "cursor"]
    );
    assert.deepEqual(
      deliveryPlan.steps.find((step) => step.title === "Verify behavior, wiring, and quality gates").input.routing
        .preferred_agent_ids,
      ["cursor", "codex"]
    );
    assert.ok(
      deliveryPlan.steps.some(
        (step) =>
          step.executor_kind === "trichat" &&
          Array.isArray(step.input.expected_agents) &&
          step.input.expected_agents.includes("codex") &&
          step.input.expected_agents.includes("cursor")
      )
    );

    const readiness = await callTool(client, "pack.verify.run", {
      mutation: nextMutation(testId, "pack.verify.run", () => mutationCounter++),
      pack_id: "agentic",
      hook_name: "execution_readiness",
      target: {
        entity_type: "goal",
        entity_id: goal.goal.goal_id,
      },
      goal_id: goal.goal.goal_id,
      plan_id: deliveryPlan.plan.plan_id,
      step_id: "check-execution-readiness",
      expectations: {
        require_active_sessions: true,
        minimum_active_sessions: 2,
      },
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.verification.pass, true);
    assert.equal(readiness.hook_run.status, "completed");
    assert.ok(readiness.artifact_ids.length >= 1);

    const optimizationPlan = await callTool(client, "goal.plan_generate", {
      mutation: nextMutation(testId, "goal.plan_generate.optimize", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      pack_id: "agentic",
      hook_name: "optimization_loop",
      selected: false,
      options: {
        metric_name: "throughput",
        metric_direction: "maximize",
        acceptance_delta: 0.05,
      },
    });
    assert.equal(optimizationPlan.ok, true);
    assert.equal(optimizationPlan.plan.planner_id, "agentic.optimization_loop");
    assert.ok(
      optimizationPlan.steps.some(
        (step) => step.tool_name === "experiment.create" && step.input.metric_name === "throughput"
      )
    );
    assert.ok(optimizationPlan.steps.some((step) => step.tool_name === "experiment.run"));
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
    { name: "mcp-agentic-pack-integration-test", version: "0.1.0" },
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
  return JSON.parse(text);
}

function extractText(response) {
  const chunks = [];
  for (const item of response.content ?? []) {
    if (item.type === "text") {
      chunks.push(item.text);
    }
  }
  return chunks.join("");
}
