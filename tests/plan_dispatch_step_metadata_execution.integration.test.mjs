import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("plan.dispatch inherits task execution hints from step metadata and preserves focus in queued tasks", async () => {
  const testId = `plan-dispatch-step-metadata-execution-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-plan-dispatch-step-metadata-execution-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Dispatch metadata inheritance goal",
      objective: "Verify that compile-time execution hints survive plan dispatch into queued tasks",
      status: "active",
      priority: 7,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["Queued tasks retain planner execution hints"],
      constraints: ["Keep the test bounded and reversible"],
      tags: ["dispatch", "task_execution"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      title: "Dispatch metadata inheritance plan",
      summary: "Dispatch a worker step whose task execution hints only exist on step metadata.",
      selected: true,
      steps: [
        {
          step_id: "verify-bridge",
          seq: 1,
          title: "Verify the bridge behavior end to end",
          step_kind: "verification",
          executor_kind: "worker",
          input: {
            objective: "Verify the bridge behavior end to end and capture concrete evidence.",
            project_dir: REPO_ROOT,
            priority: 7,
            tags: ["verification", "dispatch"],
            evidence_requirements: ["Show the concrete verification output for the bridge state."],
            rollback_notes: ["Escalate instead of widening scope if bridge truth is contradictory."],
          },
          acceptance_checks: ["Bridge truth is verified with concrete evidence."],
          metadata: {
            owner_role_id: "verification-director",
            checkpoint_required: true,
            checkpoint_cadence: "phase",
            org_program_signals: {
              explicit_evidence: true,
              fail_closed: true,
            },
            memory_preflight: {
              query: "bridge verification failure modes",
              strategy: "hybrid",
              match_count: 2,
              top_matches: [],
              reflection_match_count: 1,
              top_reflections: [
                {
                  id: "reflection-1",
                  text_preview: "Previous bridge drift came from trusting stale UI state over runtime truth.",
                  keywords: ["reflection", "bridge"],
                },
              ],
            },
            working_memory: {
              objective: "Verify bridge behavior using compact state instead of transcript replay.",
              goal_id: goal.goal.goal_id,
              constraints: ["Keep the test bounded and reversible"],
              success_criteria: ["Queued tasks retain planner execution hints"],
              expected_evidence: ["Show the concrete verification output for the bridge state."],
              rollback_notes: ["Escalate instead of widening scope if bridge truth is contradictory."],
              unresolved_questions: ["Confirm provider truth is newer than the UI state."],
              known_failures: [
                {
                  id: "reflection-1",
                  text_preview: "Previous bridge drift came from trusting stale UI state over runtime truth.",
                  keywords: ["reflection", "bridge"],
                },
              ],
              current_plan: [
                {
                  stream_id: "verify-bridge",
                  title: "Verify the bridge behavior end to end",
                  owner_role_id: "verification-director",
                  step_kind: "verification",
                  depends_on: [],
                  evidence_requirements: ["Show the concrete verification output for the bridge state."],
                },
              ],
              memory_citations: [],
              compression_policy: "Use compact working memory before raw transcript replay.",
              generated_at: new Date().toISOString(),
            },
            task_execution: {
              task_kind: "verification",
              quality_preference: "quality",
              focus: "verification",
              preferred_model_tags: ["analysis"],
            },
          },
        },
      ],
    });

    const dispatched = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });

    assert.equal(dispatched.dispatched_count, 1);
    const createdTask = dispatched.results[0].task.task;
    assert.equal(createdTask.metadata.task_execution.task_kind, "verification");
    assert.equal(createdTask.metadata.task_execution.quality_preference, "quality");
    assert.equal(createdTask.metadata.task_execution.focus, "verification");
    assert.ok(createdTask.metadata.task_execution.preferred_model_tags.includes("analysis"));
    assert.equal(createdTask.metadata.owner_role_id, "verification-director");
    assert.equal(createdTask.metadata.checkpoint_required, true);
    assert.equal(createdTask.metadata.checkpoint_cadence, "phase");
    assert.equal(createdTask.metadata.org_program_signals.explicit_evidence, true);
    assert.equal(createdTask.metadata.org_program_signals.fail_closed, true);
    assert.equal(createdTask.metadata.memory_preflight.reflection_match_count, 1);
    assert.equal(createdTask.metadata.working_memory.known_failures.length, 1);
    assert.match(
      createdTask.metadata.working_memory.unresolved_questions[0],
      /provider truth is newer than the UI state/i
    );
    assert.equal(createdTask.payload.delegation_brief.task_objective, "Verify the bridge behavior end to end and capture concrete evidence.");
    assert.deepEqual(createdTask.payload.delegation_brief.success_criteria, ["Bridge truth is verified with concrete evidence."]);
    assert.deepEqual(createdTask.payload.delegation_brief.evidence_requirements, [
      "Show the concrete verification output for the bridge state.",
    ]);
    assert.deepEqual(createdTask.payload.delegation_brief.rollback_notes, [
      "Escalate instead of widening scope if bridge truth is contradictory.",
    ]);
    assert.equal(createdTask.metadata.delegation_brief.task_objective, createdTask.payload.delegation_brief.task_objective);
    assert.match(
      createdTask.metadata.memory_preflight.top_reflections[0].text_preview,
      /stale UI state over runtime truth/i
    );
    assert.ok(createdTask.metadata.task_profile.signals.includes("focus:verification"));
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
  const client = new Client({ name: "mcp-plan-dispatch-step-metadata-execution-test", version: "0.1.0" }, { capabilities: {} });
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
