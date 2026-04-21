import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("task.compile default streams carry explicit focus, routing hints, and adaptive reasoning policy", async () => {
  const testId = `task-compile-default-focus-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-compile-default-focus-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Default focus compile goal",
      objective: "Research, implement, and verify the next bounded MCP hardening slice",
      status: "active",
      priority: 7,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["Default compiled streams expose useful focus hints"],
      constraints: ["Stay bounded and reversible"],
      tags: ["compiler", "focus"],
    });

    const compiled = await callTool(client, "task.compile", {
      mutation: nextMutation(testId, "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Research implementation options, implement the strongest slice, and verify behavior end to end",
      title: "Default focus compile",
      create_plan: true,
      selected: true,
      success_criteria: ["Default streams carry focus metadata"],
    });

    const researchStep = compiled.steps.find((step) => step.metadata.owner_role_id === "research-director");
    const implementationStep = compiled.steps.find((step) => step.metadata.owner_role_id === "implementation-director");
    const verificationStep = compiled.steps.find(
      (step) => step.metadata.owner_role_id === "verification-director" && step.step_kind === "verification"
    );
    const finalDecisionStep = compiled.steps.find((step) => step.step_kind === "decision");
    assert.equal(compiled.working_memory.current_plan.length >= 3, true);
    assert.ok(compiled.working_memory.expected_evidence.some((entry) => /Default streams carry focus metadata/i.test(entry)));
    assert.ok(compiled.working_memory.unresolved_questions.some((entry) => /research/i.test(entry)));
    assert.equal(researchStep?.metadata.task_execution.focus, "implementation_research");
    assert.equal(researchStep?.metadata.task_execution.task_kind, "research");
    assert.equal(researchStep?.metadata.task_execution.quality_preference, "quality");
    assert.equal(researchStep?.metadata.task_execution.reasoning_candidate_count, 2);
    assert.equal(researchStep?.metadata.task_execution.reasoning_selection_strategy, "evidence_rerank");
    assert.equal(researchStep?.metadata.task_execution.reasoning_compute_policy.mode, "adaptive_best_of_n");
    assert.equal(researchStep?.metadata.task_execution.reasoning_compute_policy.candidate_count, 2);
    assert.ok(researchStep?.metadata.task_execution.reasoning_compute_policy.activation_reasons.includes("research_task"));
    assert.equal(researchStep?.metadata.task_execution.require_plan_pass, true);
    assert.equal(implementationStep?.metadata.task_execution.focus, "implementation");
    assert.equal(implementationStep?.metadata.task_execution.task_kind, "coding");
    assert.equal(implementationStep?.metadata.task_execution.quality_preference, "balanced");
    assert.equal(implementationStep?.metadata.task_execution.reasoning_candidate_count, undefined);
    assert.equal(implementationStep?.metadata.task_execution.reasoning_compute_policy, undefined);
    assert.equal(verificationStep?.metadata.task_execution.focus, "verification");
    assert.equal(verificationStep?.metadata.task_execution.task_kind, "verification");
    assert.equal(verificationStep?.metadata.task_execution.quality_preference, "quality");
    assert.equal(verificationStep?.metadata.task_execution.reasoning_candidate_count, 2);
    assert.equal(verificationStep?.metadata.task_execution.reasoning_selection_strategy, "evidence_rerank");
    assert.equal(verificationStep?.metadata.task_execution.reasoning_compute_policy.mode, "adaptive_best_of_n");
    assert.ok(verificationStep?.metadata.task_execution.reasoning_compute_policy.activation_reasons.includes("verification_step"));
    assert.equal(verificationStep?.metadata.task_execution.require_verification_pass, true);
    assert.equal(verificationStep?.metadata.working_memory.current_stream_id, "verification");
    assert.ok(verificationStep?.metadata.working_memory.expected_evidence.length >= 1);
    assert.equal(finalDecisionStep?.metadata.task_execution.task_kind, "verification");
    assert.equal(finalDecisionStep?.metadata.task_execution.focus, "verification");
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_candidate_count, 2);
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_selection_strategy, "evidence_rerank");
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_compute_policy.transcript_policy, "compact_evidence_only");
    assert.equal(finalDecisionStep?.metadata.task_execution.require_plan_pass, true);
    assert.equal(finalDecisionStep?.metadata.task_execution.require_verification_pass, true);
    assert.equal(finalDecisionStep?.metadata.working_memory.current_stream_id, "verification-finalize");
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
  const client = new Client({ name: "mcp-task-compile-default-focus-test", version: "0.1.0" }, { capabilities: {} });
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
