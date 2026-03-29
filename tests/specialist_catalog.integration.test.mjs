import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("specialist.catalog matches a domain objective, persists the SME, and exposes it through the live roster", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-specialist-catalog-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const matched = await callTool(session.client, "specialist.catalog", {
      action: "match",
      objective: "Design a Docker Compose reverse proxy workflow and verify container health checks.",
    });
    assert.ok(matched.matched_domains.some((entry) => entry.domain_key === "docker"));

    const ensured = await callTool(session.client, "specialist.catalog", {
      action: "ensure",
      mutation: nextMutation("specialist-catalog", "specialist.catalog.ensure", () => mutationCounter++),
      objective: "Design a Docker Compose reverse proxy workflow and verify container health checks.",
    });
    assert.equal(ensured.ok, true);
    assert.ok(ensured.ensured_specialists.some((entry) => entry.agent_id === "docker-sme"));
    assert.ok(ensured.recommended_trichat_agent_ids.includes("docker-sme"));
    assert.ok(ensured.recommended_trichat_agent_ids.includes("implementation-director"));

    const roster = await callTool(session.client, "trichat.roster", {});
    assert.ok(
      roster.agents.some(
        (agent) =>
          agent.agent_id === "docker-sme" &&
          agent.parent_agent_id === "implementation-director" &&
          agent.coordination_tier === "leaf"
      )
    );
    assert.ok(
      roster.agents.some(
        (agent) =>
          agent.agent_id === "implementation-director" &&
          Array.isArray(agent.managed_agent_ids) &&
          agent.managed_agent_ids.includes("docker-sme")
      )
    );
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task.compile folds matched specialist workstreams into direct compile calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-specialist-compile-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("specialist-compile", "goal.create", () => mutationCounter++),
      title: "Docker compile goal",
      objective: "Stand up a Docker Compose reverse proxy stack and verify container health.",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A bounded Docker slice is compiled into the plan."],
    });

    const compiled = await callTool(session.client, "task.compile", {
      mutation: nextMutation("specialist-compile", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Stand up a Docker Compose reverse proxy stack and verify container health.",
      title: "Docker direct compile",
      create_plan: true,
      selected: true,
    });

    assert.equal(compiled.created_plan, true);
    assert.ok(
      compiled.steps.some(
        (step) =>
          step.executor_ref === "implementation-director" &&
          step.metadata?.task_execution?.domain_key === "docker"
      )
    );
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-specialist-catalog-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const first = response.content?.[0];
  assert.equal(first?.type, "text");
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${first.text}`);
  }
  return JSON.parse(first.text);
}

function nextMutation(testId, label, nextCounter) {
  const counter = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${counter}`,
    side_effect_fingerprint: `${testId}:${label}:${counter}`,
  };
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
