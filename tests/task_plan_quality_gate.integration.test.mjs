import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("task completion audit enforces declared plan quality gates", async () => {
  const testId = `task-plan-quality-gate-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-plan-quality-gate-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    const taskExecution = {
      task_kind: "planning",
      quality_preference: "quality",
      require_plan_pass: true,
      plan_quality_gate: {
        required: true,
        required_fields: ["constraints_covered", "rollback_noted", "evidence_requirements_mapped"],
        max_planned_steps: 8,
        artifact_policy: "compact_plan_summary_or_steps_only",
        reject_if_missing: true,
      },
    };

    const missingGateTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.missing-gate", () => mutationCounter++),
      objective: "Plan a bounded change while preserving constraints and rollback",
      project_dir: REPO_ROOT,
      routing: {
        allowed_agent_ids: ["plan-gate-worker"],
      },
      task_execution: taskExecution,
      tags: ["plan-quality-gate"],
    });

    const missingGateClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.missing-gate", () => mutationCounter++),
      worker_id: "plan-gate-worker",
      task_id: missingGateTask.task.task_id,
    });
    assert.equal(missingGateClaim.claimed, true);

    const missingGateCompletion = await callTool(client, "task.complete", {
      mutation: nextMutation(testId, "task.complete.missing-gate", () => mutationCounter++),
      task_id: missingGateTask.task.task_id,
      worker_id: "plan-gate-worker",
      summary: "Completed with a plan summary but no explicit plan quality gate.",
      result: {
        plan_summary: "Inspect the objective, then make the narrowest viable change.",
      },
    });

    assert.equal(missingGateCompletion.task.result.reasoning_policy_audit.status, "needs_review");
    assert.equal(typeof missingGateCompletion.auto_reflection.memory_id, "number");
    assert.ok(missingGateCompletion.auto_reflection.keywords.includes("task-reasoning-review"));
    assert.ok(missingGateCompletion.auto_reflection.keywords.includes("missing_plan_quality_constraints_covered"));
    assert.ok(missingGateCompletion.task.result.reasoning_policy_audit.satisfied_fields.includes("plan_pass"));
    assert.deepEqual(
      new Set(missingGateCompletion.task.result.reasoning_policy_audit.missing_fields),
      new Set([
        "plan_quality_constraints_covered",
        "plan_quality_rollback_noted",
        "plan_quality_evidence_requirements_mapped",
      ])
    );

    const satisfiedGateTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.satisfied-gate", () => mutationCounter++),
      objective: "Plan a bounded change with explicit quality-gate evidence",
      project_dir: REPO_ROOT,
      routing: {
        allowed_agent_ids: ["plan-gate-worker"],
      },
      task_execution: taskExecution,
      tags: ["plan-quality-gate"],
    });

    const satisfiedGateClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.satisfied-gate", () => mutationCounter++),
      worker_id: "plan-gate-worker",
      task_id: satisfiedGateTask.task.task_id,
    });
    assert.equal(satisfiedGateClaim.claimed, true);

    const satisfiedGateCompletion = await callTool(client, "task.complete", {
      mutation: nextMutation(testId, "task.complete.satisfied-gate", () => mutationCounter++),
      task_id: satisfiedGateTask.task.task_id,
      worker_id: "plan-gate-worker",
      summary: "Completed with explicit compact plan quality evidence.",
      result: {
        reasoning_policy_evidence: {
          plan_summary: "Inspect constraints, map evidence needs, keep rollback explicit, then execute only the bounded slice.",
          planned_steps: ["Confirm constraints", "Map evidence needs", "Execute bounded slice", "Verify and report"],
          plan_quality_gate: {
            constraints_covered: true,
            rollback_noted: true,
            evidence_requirements_mapped: true,
          },
        },
      },
    });

    assert.equal(satisfiedGateCompletion.task.result.reasoning_policy_audit.status, "satisfied");
    assert.deepEqual(satisfiedGateCompletion.task.result.reasoning_policy_audit.missing_fields, []);
    assert.ok(satisfiedGateCompletion.task.result.reasoning_policy_audit.satisfied_fields.includes("plan_quality_constraints_covered"));
    assert.ok(satisfiedGateCompletion.task.result.reasoning_policy_audit.satisfied_fields.includes("plan_quality_rollback_noted"));
    assert.ok(satisfiedGateCompletion.task.result.reasoning_policy_audit.satisfied_fields.includes("plan_quality_evidence_requirements_mapped"));
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
  const client = new Client({ name: "mcp-task-plan-quality-gate-test", version: "0.1.0" }, { capabilities: {} });
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
