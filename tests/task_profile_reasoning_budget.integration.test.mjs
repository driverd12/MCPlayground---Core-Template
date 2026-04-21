import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("task profiles treat high test-time-compute policy as high complexity for routing", async () => {
  const testId = `task-profile-reasoning-budget-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-profile-reasoning-budget-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, { MCP_NOTIFIER_DRY_RUN: "1" });
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "reasoning-budget-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        coding: true,
        planning: true,
        worker: true,
      },
    });

    const task = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create", () => mutationCounter++),
      objective: "Compare two short options and pick the safer answer.",
      project_dir: REPO_ROOT,
      priority: 7,
      task_execution: {
        task_kind: "verification",
        quality_preference: "quality",
        reasoning_candidate_count: 3,
        reasoning_selection_strategy: "evidence_rerank",
        require_verification_pass: true,
      },
      tags: ["reasoning-budget"],
    });

    assert.equal(task.task.metadata.task_profile.complexity, "high");
    assert.equal(task.task.metadata.task_profile.requires_agent_session, true);
    assert.ok(task.task.metadata.task_profile.signals.includes("reasoning_candidates:3"));
    assert.ok(task.task.metadata.task_profile.signals.includes("reasoning_selection:evidence_rerank"));
    assert.ok(task.task.metadata.task_profile.signals.includes("requires_verification_pass"));

    const taskSummary = await callTool(client, "task.summary", {
      running_limit: 10,
    });
    assert.equal(taskSummary.reasoning_policy.pending_count, 1);
    assert.equal(taskSummary.reasoning_policy.running_count, 0);
    assert.equal(taskSummary.reasoning_policy.total_active_count, 1);
    assert.equal(taskSummary.reasoning_policy.evidence_rerank_count, 1);
    assert.equal(taskSummary.reasoning_policy.verification_pass_count, 1);
    assert.equal(taskSummary.reasoning_policy.total_candidate_count, 3);
    assert.equal(taskSummary.reasoning_policy.max_candidate_count, 3);
    assert.ok(taskSummary.reasoning_policy.high_compute_task_ids.includes(task.task.task_id));

    const kernelSummary = await callTool(client, "kernel.summary", {
      goal_limit: 5,
      event_limit: 10,
      artifact_limit: 5,
      session_limit: 10,
    });
    assert.equal(kernelSummary.tasks.reasoning_policy.pending_count, 1);
    assert.equal(kernelSummary.tasks.reasoning_policy.total_active_count, 1);
    assert.equal(kernelSummary.tasks.reasoning_policy.total_candidate_count, 3);
    assert.equal(kernelSummary.tasks.reasoning_policy.max_candidate_count, 3);

    const rejectedGenericClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.generic", () => mutationCounter++),
      worker_id: "background-worker",
      task_id: task.task.task_id,
    });
    assert.equal(rejectedGenericClaim.claimed, false);
    assert.equal(rejectedGenericClaim.reason, "routing-ineligible:complexity_high");

    const codexClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.codex", () => mutationCounter++),
      session_id: "reasoning-budget-codex",
      task_id: task.task.task_id,
    });
    assert.equal(codexClaim.claimed, true);
    assert.equal(codexClaim.routing.task_profile.complexity, "high");

    const completedWithoutEvidence = await callTool(client, "task.complete", {
      mutation: nextMutation(testId, "task.complete.missing-evidence", () => mutationCounter++),
      task_id: task.task.task_id,
      worker_id: "reasoning-budget-codex",
      summary: "Completed without explicit reasoning evidence.",
      result: {
        completed: true,
      },
    });
    assert.equal(completedWithoutEvidence.completed, true);
    assert.equal(completedWithoutEvidence.task.result.reasoning_policy_audit.status, "needs_review");
    assert.equal(completedWithoutEvidence.task.result.reasoning_policy_audit.required_candidate_count, 3);
    assert.deepEqual(
      new Set(completedWithoutEvidence.task.result.reasoning_policy_audit.missing_fields),
      new Set(["candidate_evidence", "selection_rationale", "verification_pass"])
    );

    const reviewTimeline = await callTool(client, "task.timeline", {
      task_id: task.task.task_id,
      limit: 20,
    });
    const reviewEvent = reviewTimeline.events.find((event) => event.event_type === "reasoning_review_needed");
    assert.ok(reviewEvent);
    assert.equal(reviewEvent.to_status, "completed");
    assert.deepEqual(
      new Set(reviewEvent.details.missing_fields),
      new Set(["candidate_evidence", "selection_rationale", "verification_pass"])
    );
    assert.match(reviewEvent.summary, /reasoning-policy evidence needs review/i);

    const completedSummary = await callTool(client, "task.summary", {
      running_limit: 10,
    });
    assert.equal(completedSummary.reasoning_policy.pending_count, 0);
    assert.equal(completedSummary.reasoning_policy.completion_review.audited_completed_count, 1);
    assert.equal(completedSummary.reasoning_policy.completion_review.needs_review_count, 1);
    assert.equal(completedSummary.reasoning_policy.completion_review.satisfied_count, 0);
    assert.ok(completedSummary.reasoning_policy.completion_review.needs_review_task_ids.includes(task.task.task_id));
    assert.equal(completedSummary.reasoning_policy.completion_review.missing_field_counts.candidate_evidence, 1);
    assert.equal(completedSummary.reasoning_policy.completion_review.missing_field_counts.selection_rationale, 1);
    assert.equal(completedSummary.reasoning_policy.completion_review.missing_field_counts.verification_pass, 1);

    const completedKernelSummary = await callTool(client, "kernel.summary", {
      goal_limit: 5,
      event_limit: 10,
      artifact_limit: 5,
      session_limit: 10,
    });
    assert.equal(completedKernelSummary.tasks.reasoning_policy.completion_review.needs_review_count, 1);

    const ungroundedRerankTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.ungrounded-rerank", () => mutationCounter++),
      objective: "Compare two candidate fixes and select the evidence-backed path.",
      project_dir: REPO_ROOT,
      priority: 6,
      routing: {
        allowed_agent_ids: ["selection-grounding-worker"],
      },
      task_execution: {
        task_kind: "verification",
        quality_preference: "quality",
        reasoning_candidate_count: 2,
        reasoning_selection_strategy: "evidence_rerank",
      },
      tags: ["reasoning-budget", "selection-grounding"],
    });

    const ungroundedRerankClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.ungrounded-rerank", () => mutationCounter++),
      worker_id: "selection-grounding-worker",
      task_id: ungroundedRerankTask.task.task_id,
    });
    assert.equal(ungroundedRerankClaim.claimed, true);

    const ungroundedRerankCompletion = await callTool(client, "task.complete", {
      mutation: nextMutation(testId, "task.complete.ungrounded-rerank", () => mutationCounter++),
      task_id: ungroundedRerankTask.task.task_id,
      worker_id: "selection-grounding-worker",
      summary: "Completed with candidates and rationale but no grounded selected candidate.",
      result: {
        candidates: [
          { id: "candidate-a", evidence: "passed the cheap check" },
          { id: "candidate-b", evidence: "passed the integration check" },
        ],
        selection_rationale: "Candidate B looks strongest, but the selected candidate was not grounded explicitly.",
      },
    });
    assert.equal(ungroundedRerankCompletion.completed, true);
    assert.equal(ungroundedRerankCompletion.task.result.reasoning_policy_audit.status, "needs_review");
    assert.equal(ungroundedRerankCompletion.task.result.reasoning_policy_audit.observed_candidate_count, 2);
    assert.deepEqual(ungroundedRerankCompletion.task.result.reasoning_policy_audit.missing_fields, [
      "selection_rationale",
    ]);
    assert.equal(
      ungroundedRerankCompletion.task.result.reasoning_policy_audit.selection.selection_rationale_present,
      true
    );
    assert.equal(ungroundedRerankCompletion.task.result.reasoning_policy_audit.selection.selected_candidate_id, null);
    assert.match(
      ungroundedRerankCompletion.task.result.reasoning_policy_audit.warnings.join(" "),
      /not grounded in the candidate evidence/
    );

    const failedTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.failure-reflection", () => mutationCounter++),
      objective: "Investigate a brittle verification path and learn from the failed attempt.",
      project_dir: REPO_ROOT,
      priority: 6,
      routing: {
        allowed_agent_ids: ["failure-reflection-worker"],
      },
      task_execution: {
        task_kind: "verification",
        quality_preference: "quality",
        reasoning_compute_policy: {
          mode: "adaptive_best_of_n",
          candidate_count: 3,
          max_candidate_count: 4,
          selection_strategy: "evidence_rerank",
          activation_reasons: ["verification_task", "failed_variant_retry"],
          evidence_required: true,
          transcript_policy: "compact_evidence_only",
        },
      },
      tags: ["reasoning-budget", "failure-reflection"],
    });

    const policyOnlySummary = await callTool(client, "task.summary", {
      running_limit: 10,
    });
    assert.equal(policyOnlySummary.reasoning_policy.pending_count, 1);
    assert.equal(policyOnlySummary.reasoning_policy.total_active_count, 1);
    assert.equal(policyOnlySummary.reasoning_policy.evidence_rerank_count, 1);
    assert.equal(policyOnlySummary.reasoning_policy.total_candidate_count, 3);
    assert.equal(policyOnlySummary.reasoning_policy.max_candidate_count, 3);
    assert.ok(policyOnlySummary.reasoning_policy.high_compute_task_ids.includes(failedTask.task.task_id));

    const failureClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.failure-reflection", () => mutationCounter++),
      worker_id: "failure-reflection-worker",
      task_id: failedTask.task.task_id,
    });
    assert.equal(failureClaim.claimed, true);

    const failed = await callTool(client, "task.fail", {
      mutation: nextMutation(testId, "task.fail.failure-reflection", () => mutationCounter++),
      task_id: failedTask.task.task_id,
      worker_id: "failure-reflection-worker",
      error: "verification contradicted the selected candidate",
      summary: "Selected candidate failed under the verification check.",
      result: {
        selected_candidate: "candidate-a",
        verification_summary: "candidate-a did not satisfy the safety check",
      },
    });
    assert.equal(failed.failed, true);
    assert.equal(typeof failed.auto_reflection.memory_id, "number");
    assert.ok(failed.auto_reflection.keywords.includes("task-failure"));
    assert.ok(failed.auto_reflection.keywords.includes("candidate_count=3"));
    assert.ok(failed.auto_reflection.keywords.includes("selection=evidence_rerank"));

    const reflection = await callTool(client, "memory.get", {
      id: failed.auto_reflection.memory_id,
    });
    assert.equal(reflection.found, true);
    assert.match(reflection.memory.content, /Failed high-compute task/);
    assert.match(reflection.memory.content, /verification contradicted the selected candidate/);
    assert.match(reflection.memory.content, /mode=adaptive_best_of_n/);
    assert.match(reflection.memory.content, /candidate_count=3/);
    assert.match(reflection.memory.content, /selection=evidence_rerank/);
    assert.match(reflection.memory.content, /transcript_policy=compact_evidence_only/);
    assert.match(reflection.memory.content, /activation=failed_variant_retry/);
    assert.match(reflection.memory.content, /Retry should change the candidate, evidence, or verification path/);

    const reflectedSearch = await callTool(client, "memory.search", {
      query: "brittle verification path",
      limit: 10,
    });
    assert.ok(reflectedSearch.some((entry) => entry.id === failed.auto_reflection.memory_id));

    const retried = await callTool(client, "task.retry", {
      mutation: nextMutation(testId, "task.retry.failure-reflection", () => mutationCounter++),
      task_id: failedTask.task.task_id,
      reason: "Retry with auto-captured reflection memory.",
    });
    assert.equal(retried.retried, true);
    assert.equal(retried.task.metadata.memory_preflight.strategy, "retry_reflection");
    assert.equal(retried.task.metadata.memory_preflight.reflection_match_count, 1);
    assert.deepEqual(retried.task.metadata.memory_preflight.retry_reflection_memory_ids, [
      String(failed.auto_reflection.memory_id),
    ]);
    assert.match(
      retried.task.metadata.memory_preflight.top_reflections[0].text_preview,
      /Failed high-compute task/
    );
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
  const client = new Client({ name: "mcp-task-profile-reasoning-budget-test", version: "0.1.0" }, { capabilities: {} });
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
