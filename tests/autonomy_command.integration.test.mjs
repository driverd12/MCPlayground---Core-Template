import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

test("autonomy.command turns a cold control plane into a durable autonomous goal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-command-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const intake = await callTool(session.client, "autonomy.command", {
      mutation: nextMutation("autonomy-command", "autonomy.command", () => mutationCounter++),
      objective: "Take a single operator command, compile bounded work, and continue without chat babysitting.",
      title: "Operator command autonomy intake",
      acceptance_criteria: [
        "A durable goal exists for the operator command.",
        "A bounded plan exists with explicit owners and verification.",
      ],
      constraints: ["Stay bounded and reversible."],
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
    });

    assert.equal(intake.ok, true);
    assert.equal(intake.bootstrap.status.self_start_ready, true);
    assert.equal(intake.goal.title, "Operator command autonomy intake");
    assert.equal(
      intake.goal.objective,
      "Take a single operator command, compile bounded work, and continue without chat babysitting."
    );
    assert.equal(intake.plan.goal_id, intake.goal.goal_id);
    assert.equal(intake.execution.ok, true);
    assert.equal(intake.execution.executed, true);

    const goal = await callTool(session.client, "goal.get", { goal_id: intake.goal.goal_id });
    assert.equal(goal.found, true);
    assert.equal(goal.goal.active_plan_id, intake.plan.plan_id);

    const plan = await callTool(session.client, "plan.get", { plan_id: intake.plan.plan_id });
    assert.equal(plan.found, true);
    assert.ok(plan.step_count >= 3);
    assert.ok(plan.steps.some((step) => step.executor_kind === "worker" && typeof step.executor_ref === "string"));
    assert.ok(plan.steps.some((step) => step.executor_ref === "verification-director"));

    const daemonRunning =
      intake.goal_autorun_daemon?.status?.running ??
      intake.goal_autorun_daemon?.status?.status?.running ??
      intake.goal_autorun_daemon?.running ??
      false;
    assert.equal(Boolean(daemonRunning), true);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.command inherits Patient Zero full-control defaults when mode is omitted", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-command-patient-zero-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    MCP_PRIVILEGED_EXEC_DRY_RUN: "1",
    MCP_PRIVILEGED_EXEC_TEST_ACCOUNT_EXISTS: "1",
    MCP_PRIVILEGED_EXEC_TEST_SECRET: "integration-secret",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    await callTool(session.client, "patient.zero", {
      action: "enable",
      mutation: nextMutation("autonomy-command-patient-zero", "patient.zero.enable", () => mutationCounter++),
      source_client: "integration-test",
      source_agent: "operator",
    });

    const intake = await callTool(session.client, "autonomy.command", {
      mutation: nextMutation("autonomy-command-patient-zero", "autonomy.command", () => mutationCounter++),
      objective: "Take over this Mac locally and complete the operator's requested build-and-verify loop.",
      title: "Patient Zero elevated autonomy intake",
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
    });

    assert.equal(intake.ok, true);
    assert.equal(intake.patient_zero_full_control_defaults_applied, true);
    assert.equal(intake.effective_autonomy_mode, "execute_destructive_with_approval");
    assert.equal(intake.effective_permission_profile, "high_risk");
    assert.equal(intake.goal.autonomy_mode, "execute_destructive_with_approval");
    assert.equal(intake.goal.metadata.patient_zero_control_eligible, true);
    assert.equal(intake.goal.metadata.patient_zero_effective_autonomy_mode, "execute_destructive_with_approval");
    assert.equal(intake.goal.metadata.patient_zero_effective_permission_profile, "high_risk");
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.command auto-spawns matched SMEs and folds their bounded workstreams into the plan", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-command-specialist-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const intake = await callTool(session.client, "autonomy.command", {
      mutation: nextMutation("autonomy-command-specialist", "autonomy.command", () => mutationCounter++),
      objective:
        "Set up a Docker Compose reverse proxy stack, verify container health, and keep the change bounded and reversible.",
      title: "Docker specialist autonomy intake",
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
    });

    assert.equal(intake.ok, true);
    assert.ok(intake.specialists);
    assert.ok(intake.specialists.matched_domains.some((entry) => entry.domain_key === "docker"));
    assert.ok(intake.goal.metadata.matched_specialist_domains.includes("docker"));
    assert.ok(intake.goal.metadata.specialist_agent_ids.includes("docker-sme"));

    const roster = await callTool(session.client, "trichat.roster", {});
    assert.ok(
      roster.agents.some(
        (agent) =>
          agent.agent_id === "docker-sme" &&
          agent.parent_agent_id === "implementation-director" &&
          agent.coordination_tier === "leaf"
      )
    );

    const plan = await callTool(session.client, "plan.get", { plan_id: intake.plan.plan_id });
    assert.ok(
      plan.steps.some(
        (step) =>
          step.metadata?.owner_role_id === "docker-sme" &&
          step.metadata?.task_execution?.domain_key === "docker"
      )
    );
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.command uses routed bridge candidates to augment research intake without dropping local specialists", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-command-router-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    GOOGLE_API_KEY: "test-gemini-key",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const intake = await callTool(session.client, "autonomy.command", {
      mutation: nextMutation("autonomy-command-router", "autonomy.command", () => mutationCounter++),
      objective: "Research and compare hosted versus local model-routing strategies for tomorrow's presentation.",
      title: "Research routing intake",
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
    });

    assert.equal(intake.ok, true);
    assert.ok(intake.model_router);
    assert.equal(intake.model_router.task_kind, "research");
    assert.ok(intake.model_router.routed_bridge_agent_ids.includes("gemini"));
    assert.ok(intake.model_router.effective_agent_ids.includes("research-director"));
    assert.ok(intake.model_router.effective_agent_ids.includes("gemini"));
    assert.equal(intake.goal.metadata.model_router_task_kind, "research");
    assert.ok(intake.goal.metadata.routed_bridge_agent_ids.includes("gemini"));
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.command keeps local-first intake on the local backend when the objective does not explicitly request hosted bridges", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-command-local-first-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    GOOGLE_API_KEY: "test-gemini-key",
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    const intake = await callTool(session.client, "autonomy.command", {
      mutation: nextMutation("autonomy-command-local-first", "autonomy.command", () => mutationCounter++),
      objective: "Fix local Ollama routing reliability and implement tighter MLX fallback behavior on this Mac.",
      title: "Local routing hardening intake",
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
    });

    assert.equal(intake.ok, true);
    assert.ok(intake.model_router);
    assert.equal(intake.model_router.task_kind, "coding");
    assert.equal(intake.model_router.route?.selected_backend?.provider, "ollama");
    assert.equal(intake.model_router.auto_bridge_suppressed_for_local_first, true);
    assert.deepEqual(intake.model_router.routed_bridge_agent_ids, []);
    assert.ok(intake.model_router.effective_agent_ids.includes("implementation-director"));
    assert.equal(intake.model_router.effective_agent_ids.includes("gemini"), false);
    assert.deepEqual(intake.goal.metadata.routed_bridge_agent_ids, []);
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("autonomy.command selects a swarm profile, reuses prior memory, and records checkpoint artifacts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-command-swarm-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const ollama = await startFakeOllamaServer({
    models: [{ name: "llama3.2:3b" }],
  });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
    TRICHAT_OLLAMA_URL: ollama.url,
    TRICHAT_RING_LEADER_AUTOSTART: "1",
    TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
    TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
    TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
  });

  try {
    await callTool(session.client, "memory.append", {
      mutation: nextMutation("autonomy-command-swarm", "memory.append", () => mutationCounter++),
      text: "dns cutover rollback verification bounded dns cutover rollback verification",
      tags: ["dns", "rollback", "verification"],
    });

    const intake = await callTool(session.client, "autonomy.command", {
      mutation: nextMutation("autonomy-command-swarm", "autonomy.command", () => mutationCounter++),
      objective: "Plan a bounded DNS cutover with rollback and verification for tomorrow morning.",
      title: "DNS cutover autonomy intake",
      trichat_bridge_dry_run: true,
      dispatch_limit: 12,
      max_passes: 3,
    });

    assert.equal(intake.ok, true);
    assert.equal(typeof intake.swarm.profile.topology, "string");
    assert.equal(intake.goal.metadata.swarm_profile.topology, intake.swarm.profile.topology);
    assert.equal(intake.plan.metadata.swarm_profile.topology, intake.swarm.profile.topology);
    assert.equal(intake.swarm.memory_preflight.match_count >= 1, true);
    assert.equal(intake.plan.metadata.memory_preflight.match_count >= 1, true);
    assert.equal(intake.swarm.checkpoints.length >= 2, true);

    const artifacts = await callTool(session.client, "artifact.list", {
      goal_id: intake.goal.goal_id,
      artifact_type: "swarm.checkpoint",
      limit: 10,
    });
    assert.equal(artifacts.artifacts.length >= 2, true);
    assert.ok(
      artifacts.artifacts.some((artifact) => artifact.plan_id === intake.plan.plan_id || artifact.goal_id === intake.goal.goal_id)
    );
  } finally {
    await session.client.close().catch(() => {});
    await ollama.close();
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
    { name: "mcp-autonomy-command-test", version: "0.1.0" },
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

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
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

async function startFakeOllamaServer({ models }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake Ollama server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
