import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("task.compile surfaces grounded reflection memories in memory preflight and compile brief output", async () => {
  const testId = `task-compile-reflection-${Date.now()}`;
  const reflectionToken = `reflection-token-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-compile-reflection-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Reflection-guided compile goal",
      objective: `Use grounded reflections to sharpen the next bounded compile plan for ${reflectionToken}`,
      status: "active",
      priority: 7,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["The compile brief includes grounded reflection guidance"],
      constraints: ["Stay bounded and reversible"],
      tags: ["reflection", "compiler"],
    });

    await callTool(client, "memory.reflection_capture", {
      mutation: nextMutation(testId, "memory.reflection_capture", () => mutationCounter++),
      title: `Bridge-targets intake hardening ${reflectionToken}`,
      objective: `Keep ${reflectionToken} bridge target truth explicit instead of reconstructing it from partial office payloads.`,
      attempted_action: `Derived ${reflectionToken} bridge target state indirectly from roster-only payloads in Agent Office.`,
      grounded_feedback: [
        `The formatted office snapshot omitted explicit ${reflectionToken} bridge target data even though provider bridge truth already existed.`,
        `The ${reflectionToken} intake surface needed a stable contract, not another local reconstruction path.`
      ],
      reflection:
        `Promote ${reflectionToken} bridge target truth into a first-class payload field and feed that compact guidance into future compile passes.`,
      next_actions: [
        "Prefer explicit bridge target exports over UI-side reconstruction.",
        "Surface grounded reflections in compile briefs when retrieval finds them."
      ],
      tags: [reflectionToken, "bridge-targets", "reflection", "office"],
      source_client: "integration-test",
      source_model: "test-model",
    });

    const compiled = await callTool(client, "task.compile", {
      mutation: nextMutation(testId, "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: `${reflectionToken} bridge-targets intake hardening with grounded reflection`,
      title: "Reflection-guided compile",
      create_plan: true,
      selected: true,
      success_criteria: ["Compile brief carries grounded reflection guidance"],
    });

    assert.equal(compiled.created_plan, true);
    assert.ok(compiled.memory_preflight.match_count >= 1);
    assert.ok(compiled.memory_preflight.reflection_match_count >= 1);
    assert.ok(compiled.memory_preflight.top_reflections.length >= 1);
    assert.ok(compiled.memory_preflight.top_reflections[0].keywords.includes("reflection"));
    assert.match(compiled.compile_brief.content_text, /grounded_reflections:/i);
    assert.match(compiled.compile_brief.content_text, /Working memory/i);
    assert.ok(compiled.compile_brief.metadata.reflection_match_count >= 1);
    assert.ok(compiled.compile_brief.metadata.working_memory_known_failure_count >= 1);
    assert.ok(compiled.compile_brief.content_json.memory_preflight.reflection_match_count >= 1);
    assert.ok(compiled.compile_brief.content_json.working_memory.known_failures.length >= 1);
    assert.match(compiled.working_memory.known_failures[0].text_preview, /bridge[- ]target/i);
    assert.ok(compiled.working_memory.unresolved_questions.length >= 1);
    const verificationStep = compiled.steps.find(
      (step) => step.metadata.owner_role_id === "verification-director" && step.step_kind === "verification"
    );
    const finalDecisionStep = compiled.steps.find((step) => step.step_kind === "decision");
    assert.equal(verificationStep?.metadata.task_execution.reasoning_candidate_count, 3);
    assert.equal(verificationStep?.metadata.task_execution.reasoning_selection_strategy, "evidence_rerank");
    assert.equal(verificationStep?.metadata.task_execution.require_verification_pass, true);
    assert.equal(verificationStep?.metadata.working_memory.current_stream_id, "verification");
    assert.ok(verificationStep?.metadata.working_memory.known_failures.length >= 1);
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_candidate_count, 3);
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_selection_strategy, "evidence_rerank");
    assert.equal(finalDecisionStep?.metadata.task_execution.require_plan_pass, true);
    assert.equal(finalDecisionStep?.metadata.task_execution.require_verification_pass, true);
    assert.equal(finalDecisionStep?.metadata.working_memory.current_stream_id, "verification-finalize");
    assert.ok(finalDecisionStep?.metadata.working_memory.known_failures.length >= 1);

    const compileBriefArtifacts = await callTool(client, "artifact.list", {
      plan_id: compiled.plan.plan_id,
      artifact_type: "compile.brief",
      limit: 10,
    });
    assert.equal(compileBriefArtifacts.artifacts.length >= 1, true);
    assert.match(compileBriefArtifacts.artifacts[0].content_text, /grounded_reflections:/i);
    assert.ok(compileBriefArtifacts.artifacts[0].content_json.working_memory.known_failures.length >= 1);
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
  const client = new Client({ name: "mcp-task-compile-reflection-test", version: "0.1.0" }, { capabilities: {} });
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
