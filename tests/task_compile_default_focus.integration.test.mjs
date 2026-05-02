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
    assert.equal(researchStep?.metadata.task_execution.reasoning_compute_policy.compute_budget.candidate_budget, 2);
    assert.equal(researchStep?.metadata.task_execution.reasoning_compute_policy.compute_budget.telemetry_required, true);
    assert.ok(
      researchStep?.metadata.task_execution.reasoning_compute_policy.compute_budget.telemetry_fields.includes("estimated_cost_usd")
    );
    assert.deepEqual(researchStep?.metadata.task_execution.reasoning_compute_policy.verifier_rerank.score_fields, [
      "evidence_strength",
      "artifact_fit",
      "contradiction_risk",
      "rollback_safety",
    ]);
    assert.deepEqual(researchStep?.metadata.task_execution.reasoning_compute_policy.verifier_rerank.required_selected_fields, [
      "selected_candidate_id",
      "selection_rationale",
      "verifier_score",
      "contradiction_risk",
    ]);
    assert.ok(researchStep?.metadata.task_execution.reasoning_compute_policy.activation_reasons.includes("research_task"));
    assert.equal(researchStep?.metadata.task_execution.require_plan_pass, true);
    assert.deepEqual(researchStep?.metadata.task_execution.plan_quality_gate.required_fields, [
      "constraints_covered",
      "rollback_noted",
      "evidence_requirements_mapped",
    ]);
    assert.equal(researchStep?.metadata.task_execution.plan_quality_gate.max_planned_steps, 8);
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
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_compute_policy.compute_budget.evidence_char_limit, 6000);
    assert.equal(finalDecisionStep?.metadata.task_execution.require_plan_pass, true);
    assert.equal(finalDecisionStep?.metadata.task_execution.plan_quality_gate.required, true);
    assert.equal(finalDecisionStep?.metadata.task_execution.require_verification_pass, true);
    assert.equal(finalDecisionStep?.metadata.working_memory.current_stream_id, "verification-finalize");
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task.compile enables shallow branch search for hard reasoning branches", async () => {
  const testId = `task-compile-hard-branch-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-compile-hard-branch-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Hard branch compile goal",
      objective: "Research, implement, and verify a high-risk multi-host MCP federation rollout",
      status: "active",
      priority: 9,
      risk_tier: "high",
      autonomy_mode: "recommend",
      acceptance_criteria: ["High-risk compile policies expose bounded branch search"],
      constraints: ["Preserve existing access gates", "Keep rollback explicit", "Fail closed on weak evidence"],
      tags: ["compiler", "reasoning"],
    });

    const compiled = await callTool(client, "task.compile", {
      mutation: nextMutation(testId, "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Research, implement, and verify high-risk signed federation behavior without broad refactors",
      title: "Hard branch compile",
      create_plan: true,
      selected: true,
      success_criteria: ["Hard reasoning branches use bounded branch search"],
    });

    const researchStep = compiled.steps.find((step) => step.metadata.owner_role_id === "research-director");
    const implementationStep = compiled.steps.find((step) => step.metadata.owner_role_id === "implementation-director");
    const verificationStep = compiled.steps.find(
      (step) => step.metadata.owner_role_id === "verification-director" && step.step_kind === "verification"
    );
    const branchSearch = verificationStep?.metadata.task_execution.reasoning_compute_policy.shallow_branch_search;

    assert.equal(researchStep?.metadata.task_execution.reasoning_candidate_count, 3);
    assert.ok(researchStep?.metadata.task_execution.reasoning_compute_policy.activation_reasons.includes("high_risk_goal"));
    assert.equal(implementationStep?.metadata.task_execution.reasoning_compute_policy, undefined);
    assert.equal(verificationStep?.metadata.task_execution.reasoning_candidate_count, 3);
    assert.equal(branchSearch?.enabled, true);
    assert.equal(verificationStep?.metadata.task_execution.reasoning_compute_policy.compute_budget.max_branch_depth, 2);
    assert.equal(verificationStep?.metadata.task_execution.reasoning_compute_policy.compute_budget.max_branch_count, 3);
    assert.equal(branchSearch?.max_depth, 2);
    assert.equal(branchSearch?.branch_count, 3);
    assert.deepEqual(branchSearch?.prune_with, [
      "artifact_fit",
      "contradiction_risk",
      "rollback_safety",
      "environment_feedback",
    ]);
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task.compile keeps budget forcing opt-in for experimental reasoning budgets", async () => {
  const testId = `task-compile-budget-forcing-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-compile-budget-forcing-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Budget forcing compile goal",
      objective: "Verify an experimental budget-forcing reasoning policy stays explicit and bounded",
      status: "active",
      priority: 6,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["Budget forcing is opt-in and evidence-gated"],
      constraints: ["Do not enable budget forcing by default"],
      tags: ["compiler", "reasoning"],
    });

    const compiled = await callTool(client, "task.compile", {
      mutation: nextMutation(testId, "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Verify the budget-forcing policy renders only when explicitly enabled",
      title: "Budget forcing compile",
      create_plan: true,
      selected: true,
      metadata: {
        reasoning_experiments: {
          budget_forcing: true,
        },
      },
      success_criteria: ["Budget forcing policy is present and bounded"],
    });

    const verificationStep = compiled.steps.find(
      (step) => step.metadata.owner_role_id === "verification-director" && step.step_kind === "verification"
    );
    const finalDecisionStep = compiled.steps.find((step) => step.step_kind === "decision");
    const budgetForcing = verificationStep?.metadata.task_execution.reasoning_compute_policy.budget_forcing;
    const computeBudget = verificationStep?.metadata.task_execution.reasoning_compute_policy.compute_budget;

    assert.equal(budgetForcing?.enabled, true);
    assert.equal(budgetForcing?.max_revision_passes, 1);
    assert.equal(computeBudget?.max_revision_passes, 1);
    assert.equal(budgetForcing?.force_after, "initial_candidate_selection");
    assert.ok(
      verificationStep?.metadata.task_execution.reasoning_compute_policy.activation_reasons.includes("budget_forcing_opt_in")
    );
    assert.equal(finalDecisionStep?.metadata.task_execution.reasoning_compute_policy.budget_forcing.enabled, true);
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
