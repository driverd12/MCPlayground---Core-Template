import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("server starts with default agentic workflow hooks and exposes core + TriChat tools", async () => {
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
    assert.equal(names.has("goal.autorun"), true);
    assert.equal(names.has("goal.autorun_daemon"), true);
    assert.equal(names.has("goal.execute"), true);
    assert.equal(names.has("goal.get"), true);
    assert.equal(names.has("goal.list"), true);
    assert.equal(names.has("goal.plan_generate"), true);
    assert.equal(names.has("pack.hooks.list"), true);
    assert.equal(names.has("pack.plan.generate"), true);
    assert.equal(names.has("pack.verify.run"), true);
    assert.equal(names.has("event.publish"), true);
    assert.equal(names.has("event.tail"), true);
    assert.equal(names.has("event.summary"), true);
    assert.equal(names.has("kernel.summary"), true);
    assert.equal(names.has("artifact.record"), true);
    assert.equal(names.has("artifact.get"), true);
    assert.equal(names.has("artifact.list"), true);
    assert.equal(names.has("artifact.link"), true);
    assert.equal(names.has("artifact.bundle"), true);
    assert.equal(names.has("experiment.create"), true);
    assert.equal(names.has("experiment.get"), true);
    assert.equal(names.has("experiment.list"), true);
    assert.equal(names.has("experiment.run"), true);
    assert.equal(names.has("experiment.judge"), true);
    assert.equal(names.has("playbook.list"), true);
    assert.equal(names.has("playbook.get"), true);
    assert.equal(names.has("playbook.instantiate"), true);
    assert.equal(names.has("playbook.run"), true);
    assert.equal(names.has("plan.create"), true);
    assert.equal(names.has("plan.get"), true);
    assert.equal(names.has("plan.list"), true);
    assert.equal(names.has("plan.update"), true);
    assert.equal(names.has("plan.select"), true);
    assert.equal(names.has("plan.step_update"), true);
    assert.equal(names.has("plan.step_ready"), true);
    assert.equal(names.has("plan.dispatch"), true);
    assert.equal(names.has("plan.approve"), true);
    assert.equal(names.has("plan.resume"), true);
    assert.equal(names.has("dispatch.autorun"), true);
    assert.equal(names.has("agent.session_open"), true);
    assert.equal(names.has("agent.session_get"), true);
    assert.equal(names.has("agent.session_list"), true);
    assert.equal(names.has("agent.session_heartbeat"), true);
    assert.equal(names.has("agent.session_close"), true);
    assert.equal(names.has("agent.learning_list"), true);
    assert.equal(names.has("agent.learning_summary"), true);
    assert.equal(names.has("agent.claim_next"), true);
    assert.equal(names.has("agent.worklist"), true);
    assert.equal(names.has("agent.current_task"), true);
    assert.equal(names.has("agent.heartbeat_task"), true);
    assert.equal(names.has("agent.report_result"), true);
    assert.equal(names.has("task.create"), true);
    assert.equal(names.has("transcript.log"), true);

    assert.equal(names.has("trichat.thread_open"), true);
    assert.equal(names.has("trichat.tmux_controller"), true);
    assert.equal(names.has("trichat.roster"), true);
    assert.equal(names.has("simulate.workflow"), true);
    assert.equal(names.has("cfd.case.create"), false);

    const roster = await callTool(client, "trichat.roster", {});
    assert.deepEqual(roster.active_agent_ids, [
      "ring-leader",
      "implementation-director",
      "research-director",
      "verification-director",
      "local-imprint",
      "codex",
    ]);
    assert.equal(Array.isArray(roster.agents), true);
    assert.ok(roster.agents.some((agent) => agent.agent_id === "codex" && agent.active === true));
    assert.ok(
      roster.agents.some(
        (agent) =>
          agent.agent_id === "implementation-director" &&
          agent.coordination_tier === "director" &&
          Array.isArray(agent.managed_agent_ids) &&
          agent.managed_agent_ids.includes("code-smith")
      )
    );
    assert.ok(
      roster.agents.some(
        (agent) =>
          agent.agent_id === "code-smith" &&
          agent.coordination_tier === "leaf" &&
          agent.parent_agent_id === "implementation-director"
      )
    );

    const packHooks = await callTool(client, "pack.hooks.list", {});
    assert.equal(packHooks.count, 3);
    assert.ok(packHooks.hooks.some((hook) => hook.hook_id === "agentic.delivery_path"));
    assert.ok(packHooks.hooks.some((hook) => hook.hook_id === "agentic.optimization_loop"));
    assert.ok(packHooks.hooks.some((hook) => hook.hook_id === "agentic.execution_readiness"));

    const learningSummary = await callTool(client, "agent.learning_summary", {
      limit: 25,
      top_agents_limit: 5,
      recent_limit: 5,
    });
    assert.equal(learningSummary.total_entries, 0);
    assert.equal(learningSummary.active_entry_count, 0);
    assert.equal(learningSummary.agent_count, 0);

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

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Initial goal execution plan",
      summary: "Break the goal into inspectable planning and implementation steps",
      selected: true,
      confidence: 0.82,
      success_criteria: ["Plan is persisted", "Goal points at the selected active plan"],
      steps: [
        {
          step_id: "inspect-goal",
          seq: 1,
          title: "Inspect the linked goal",
          step_kind: "analysis",
          executor_kind: "tool",
          tool_name: "goal.get",
        },
        {
          step_id: "wire-runtime",
          seq: 2,
          title: "Wire the durable runtime path",
          step_kind: "mutation",
          executor_kind: "worker",
          depends_on: ["inspect-goal"],
          acceptance_checks: ["Goal remains linked to the selected plan"],
        },
      ],
    });
    assert.equal(createdPlan.created, true);
    assert.equal(typeof createdPlan.plan.plan_id, "string");
    assert.equal(createdPlan.plan.goal_id, createdGoal.goal.goal_id);
    assert.equal(createdPlan.plan.selected, true);
    assert.equal(createdPlan.steps.length, 2);

    const planFetch = await callTool(client, "plan.get", {
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(planFetch.found, true);
    assert.equal(planFetch.plan.plan_id, createdPlan.plan.plan_id);
    assert.equal(planFetch.step_count, 2);
    assert.deepEqual(planFetch.steps[1].depends_on, ["inspect-goal"]);

    const initialReady = await callTool(client, "plan.step_ready", {
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(initialReady.found, true);
    assert.equal(initialReady.ready_count, 1);
    assert.equal(initialReady.readiness[0].step_id, "inspect-goal");
    assert.equal(initialReady.readiness[0].ready, true);
    assert.equal(initialReady.readiness[1].step_id, "wire-runtime");
    assert.equal(initialReady.readiness[1].ready, false);
    assert.deepEqual(initialReady.readiness[1].blocked_by.map((step) => step.step_id), ["inspect-goal"]);

    const completedStep = await callTool(client, "plan.step_update", {
      mutation: nextMutation(testId, "plan.step_update", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
      step_id: "inspect-goal",
      status: "completed",
      run_id: "plan-run-1",
      summary: "Goal inspection complete",
    });
    assert.equal(completedStep.step.status, "completed");
    assert.equal(completedStep.step.run_id, "plan-run-1");
    assert.equal(completedStep.plan.status, "in_progress");

    const readyAfterStepComplete = await callTool(client, "plan.step_ready", {
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(readyAfterStepComplete.ready_count, 1);
    assert.equal(readyAfterStepComplete.readiness[1].step_id, "wire-runtime");
    assert.equal(readyAfterStepComplete.readiness[1].ready, true);

    const planList = await callTool(client, "plan.list", {
      goal_id: createdGoal.goal.goal_id,
      selected_only: true,
      limit: 10,
    });
    assert.ok(planList.count >= 1);
    assert.ok(planList.plans.some((plan) => plan.plan_id === createdPlan.plan.plan_id));

    const goalWithActivePlan = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goalWithActivePlan.found, true);
    assert.equal(goalWithActivePlan.goal.active_plan_id, createdPlan.plan.plan_id);

    const updatedPlan = await callTool(client, "plan.update", {
      mutation: nextMutation(testId, "plan.update", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
      status: "in_progress",
      confidence: 0.9,
      metadata: {
        execution_mode: "bounded",
      },
    });
    assert.equal(updatedPlan.plan.status, "in_progress");
    assert.equal(updatedPlan.plan.confidence, 0.9);
    assert.equal(updatedPlan.plan.metadata.execution_mode, "bounded");

    const alternatePlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.alt", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Alternate plan candidate",
      summary: "Use an explicit selected-plan handoff path",
      confidence: 0.61,
      steps: [
        {
          step_id: "handoff",
          seq: 1,
          title: "Handoff execution to the selected route",
          step_kind: "handoff",
          executor_kind: "trichat",
        },
      ],
    });
    assert.equal(alternatePlan.created, true);
    assert.equal(alternatePlan.plan.selected, false);

    const selectedPlan = await callTool(client, "plan.select", {
      mutation: nextMutation(testId, "plan.select", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      plan_id: alternatePlan.plan.plan_id,
      summary: "Switch to the alternate plan for execution",
    });
    assert.equal(selectedPlan.plan.plan_id, alternatePlan.plan.plan_id);
    assert.equal(selectedPlan.plan.selected, true);

    const goalWithSelectedAlternatePlan = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goalWithSelectedAlternatePlan.goal.active_plan_id, alternatePlan.plan.plan_id);

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

test("playbook tools expose GSD and autoresearch workflow profiles and instantiate durable plans", async () => {
  const testId = `${Date.now()}-playbooks`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-playbook-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const playbooks = await callTool(client, "playbook.list", {
      limit: 20,
    });
    assert.ok(playbooks.count >= 4);
    assert.ok(playbooks.playbooks.some((playbook) => playbook.playbook_id === "gsd.phase_delivery"));
    assert.ok(playbooks.playbooks.some((playbook) => playbook.playbook_id === "autoresearch.optimize_loop"));

    const gsdPlaybook = await callTool(client, "playbook.get", {
      playbook_id: "gsd.phase_delivery",
    });
    assert.equal(gsdPlaybook.found, true);
    assert.equal(gsdPlaybook.playbook.source_repo, "gsd-build/get-shit-done");

    const instantiatedPhase = await callTool(client, "playbook.instantiate", {
      mutation: nextMutation(testId, "playbook.instantiate.gsd", () => mutationCounter++),
      playbook_id: "gsd.phase_delivery",
      title: "Kernel Delivery Slice",
      objective: "Deliver a structured phase using the MCP kernel",
      acceptance_criteria: ["A selected durable plan is created from the playbook"],
      tags: ["external-methods"],
    });
    assert.equal(instantiatedPhase.created, true);
    assert.equal(instantiatedPhase.playbook.playbook_id, "gsd.phase_delivery");
    assert.equal(instantiatedPhase.goal.title, "Kernel Delivery Slice");
    assert.equal(instantiatedPhase.plan.selected, true);
    assert.ok(instantiatedPhase.steps.some((step) => step.step_id === "discuss-gray-areas"));
    assert.ok(instantiatedPhase.steps.some((step) => step.step_id === "approve-scope"));
    assert.ok(instantiatedPhase.goal.tags.includes("external-methods"));
    assert.ok(instantiatedPhase.goal.tags.includes("gsd"));

    const instantiatedOptimize = await callTool(client, "playbook.instantiate", {
      mutation: nextMutation(testId, "playbook.instantiate.autoresearch", () => mutationCounter++),
      playbook_id: "autoresearch.optimize_loop",
      title: "Optimize Local Agent Loop",
      objective: "Improve the local agentic workflow using measurable evidence",
    });
    assert.equal(instantiatedOptimize.created, true);
    assert.equal(instantiatedOptimize.playbook.source_repo, "karpathy/autoresearch");
    assert.ok(instantiatedOptimize.steps.some((step) => step.step_id === "establish-baseline"));
    assert.ok(instantiatedOptimize.steps.some((step) => step.step_id === "accept-or-reject"));

    const fetchedPlan = await callTool(client, "plan.get", {
      plan_id: instantiatedOptimize.plan.plan_id,
    });
    assert.equal(fetchedPlan.found, true);
    assert.equal(fetchedPlan.plan.metadata.playbook_id, "autoresearch.optimize_loop");
    assert.equal(
      fetchedPlan.steps.find((step) => step.step_id === "generate-hypotheses").executor_kind,
      "trichat"
    );
    assert.equal(
      fetchedPlan.steps.find((step) => step.step_id === "accept-or-reject").executor_kind,
      "human"
    );

    const ranPlaybook = await callTool(client, "playbook.run", {
      mutation: nextMutation(testId, "playbook.run", () => mutationCounter++),
      playbook_id: "gsd.map_codebase",
      title: "Kernel Map Run",
      objective: "Map the local agentic kernel before implementing the next slice",
      tags: ["external-methods"],
    });
    assert.equal(ranPlaybook.ok, true);
    assert.equal(ranPlaybook.playbook.playbook_id, "gsd.map_codebase");
    assert.equal(ranPlaybook.plan.metadata.workflow_autorun_enabled, true);
    assert.equal(ranPlaybook.execution.ok, true);
    assert.equal(ranPlaybook.execution.executed, true);
    assert.equal(ranPlaybook.execution.execution_summary.running_count, 1);
    assert.match(ranPlaybook.execution.execution_summary.next_action, /Wait for running tasks or turns to finish/);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute generates a default agentic plan and dispatches the first runnable slice", async () => {
  const testId = `${Date.now()}-goal-execute-generate`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-generate-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Generated execution goal",
      objective: "Drive the kernel from goal.execute with no pre-existing plan",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A default selected plan is generated", "The first runnable worker slice is dispatched"],
      tags: ["agentic"],
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.executed, true);
    assert.equal(executedGoal.created_plan, true);
    assert.equal(executedGoal.plan_resolution, "generated");
    assert.equal(executedGoal.dispatch_mode, "autorun");
    assert.equal(executedGoal.execution.stop_reason, "idle");
    assert.equal(executedGoal.plan.metadata.planner_hook.hook_id, "agentic.delivery_path");
    assert.equal(typeof executedGoal.plan.plan_id, "string");
    assert.equal(executedGoal.plan.metadata.adaptive_plan_routing_summary.mode_counts.none, 3);
    assert.ok(executedGoal.plan.confidence < 0.84);
    assert.equal(executedGoal.execution_summary.completed_count, 1);
    assert.equal(executedGoal.execution_summary.running_count, 1);
    assert.equal(executedGoal.execution_summary.failed_count, 0);
    assert.match(executedGoal.execution_summary.next_action, /Wait for running tasks or turns to finish/);
    assert.ok(executedGoal.adaptive_routing_summary.worker_step_count >= 3);
    assert.ok(executedGoal.adaptive_routing_summary.mode_counts.none >= 1);
    assert.ok(
      executedGoal.adaptive_routing_summary.attention.some((entry) => /no dispatchable adaptive lane guidance/i.test(entry))
    );

    const generatedPlan = await callTool(client, "plan.get", {
      plan_id: executedGoal.plan.plan_id,
    });
    const loadGoalContext = generatedPlan.steps.find((step) => step.title === "Load the durable goal context");
    const mapCodebase = generatedPlan.steps.find((step) => step.title === "Map the relevant codebase and continuity surface");
    const shapeBoundedSlice = generatedPlan.steps.find((step) => step.title === "Shape the next bounded delivery slice with the council");
    assert.ok(loadGoalContext);
    assert.ok(mapCodebase);
    assert.ok(shapeBoundedSlice);
    assert.equal(loadGoalContext.status, "completed");
    assert.equal(mapCodebase.status, "running");
    assert.equal(typeof mapCodebase.task_id, "string");
    assert.equal(shapeBoundedSlice.status, "pending");

    const queuedTasks = await callTool(client, "task.list", {
      status: "pending",
      limit: 20,
    });
    assert.ok(
      queuedTasks.tasks.some(
        (task) =>
          task.task_id === mapCodebase.task_id &&
          /Map the repository structure/.test(task.objective)
      )
    );

    const goalState = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goalState.goal.active_plan_id, executedGoal.plan.plan_id);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute auto-selects the optimization planner and bootstraps an experiment flow", async () => {
  const testId = `${Date.now()}-goal-execute-optimization`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-optimization-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Optimize agent claim latency",
      objective: "Reduce latency of the agent claim loop and benchmark the improvement against the baseline",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: [
        "The kernel creates a durable experiment loop automatically",
        "A baseline and candidate path are prepared with explicit metric semantics",
      ],
      metadata: {
        preferred_metric_name: "latency_ms",
        preferred_metric_direction: "minimize",
        acceptance_delta: 5,
      },
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.created_plan, true);
    assert.equal(executedGoal.plan.metadata.planner_hook.hook_id, "agentic.optimization_loop");
    assert.equal(executedGoal.planner_selection.methodology, "optimization");
    assert.equal(executedGoal.planner_selection.reason, "metric_hint");
    assert.equal(executedGoal.plan.metadata.metric_name, "latency_ms");
    assert.equal(executedGoal.plan.metadata.metric_direction, "minimize");

    const generatedPlan = await callTool(client, "plan.get", {
      plan_id: executedGoal.plan.plan_id,
    });
    assert.ok(
      generatedPlan.steps.some(
        (step) =>
          step.step_id.endsWith("create-experiment-ledger") || step.title === "Create the durable experiment ledger"
      )
    );
    assert.ok(
      generatedPlan.steps.some(
        (step) => step.step_id.endsWith("launch-candidate-run") || step.title === "Launch the measured candidate run"
      )
    );
    assert.equal(
      generatedPlan.steps.find(
        (step) =>
          step.step_id.endsWith("create-experiment-ledger") || step.title === "Create the durable experiment ledger"
      ).status,
      "completed"
    );
    assert.equal(
      generatedPlan.steps.find(
        (step) => step.step_id.endsWith("establish-baseline") || step.title === "Establish the baseline measurement"
      ).status,
      "running"
    );

    const experiments = await callTool(client, "experiment.list", {
      goal_id: createdGoal.goal.goal_id,
      limit: 10,
    });
    assert.equal(experiments.count, 1);
    assert.equal(experiments.experiments[0].metric_name, "latency_ms");
    assert.equal(experiments.experiments[0].metric_direction, "minimize");
    assert.equal(experiments.experiments[0].acceptance_delta, 5);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute downgrades weak optimization intent to the safer delivery path when no viable worker lane exists", async () => {
  const testId = `${Date.now()}-goal-execute-methodology-safety-override`;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-core-template-goal-execute-methodology-safety-override-test-")
  );
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Score tuning goal",
      objective: "Improve score",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A safer delivery plan is chosen when the optimization signal is weak"],
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.executed, true);
    assert.equal(executedGoal.created_plan, true);
    assert.equal(executedGoal.plan_resolution, "generated");
    assert.equal(executedGoal.planner_selection.methodology, "delivery");
    assert.equal(executedGoal.planner_selection.reason, "worker_pool_safety_override");
    assert.equal(executedGoal.methodology_entry_decision.original_selection.methodology, "optimization");
    assert.equal(executedGoal.methodology_entry_decision.selection.methodology, "delivery");
    assert.equal(executedGoal.methodology_entry_decision.selection_strength, "weak");
    assert.equal(executedGoal.methodology_entry_decision.switched_selection, true);
    assert.equal(executedGoal.methodology_entry_decision.hold_generation, false);
    assert.equal(executedGoal.methodology_entry_decision.state, "blocked_by_no_viable_lane");

    const generatedPlan = await callTool(client, "plan.get", {
      plan_id: executedGoal.plan.plan_id,
    });
    assert.equal(generatedPlan.plan.metadata.planner_hook.hook_id, "agentic.delivery_path");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute holds generation before planning when destructive autonomy has no viable worker lane", async () => {
  const testId = `${Date.now()}-goal-execute-held-before-generation`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-held-before-generation-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Destructive score tuning goal",
      objective: "Improve score",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["Generation is held before planning when the live worker pool is not viable"],
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.executed, false);
    assert.equal(executedGoal.held_before_generation, true);
    assert.equal(executedGoal.created_plan, false);
    assert.equal(executedGoal.plan_resolution, "missing");
    assert.equal(executedGoal.planner_selection.methodology, "delivery");
    assert.equal(executedGoal.planner_selection.reason, "worker_pool_safety_override");
    assert.equal(executedGoal.methodology_entry_decision.original_selection.methodology, "optimization");
    assert.equal(executedGoal.methodology_entry_decision.selection.methodology, "delivery");
    assert.equal(executedGoal.methodology_entry_decision.selection_strength, "weak");
    assert.equal(executedGoal.methodology_entry_decision.switched_selection, true);
    assert.equal(executedGoal.methodology_entry_decision.hold_generation, true);
    assert.equal(executedGoal.methodology_entry_decision.state, "blocked_by_no_viable_lane");
    assert.match(executedGoal.message, /held|viable worker lane/i);

    const goalPlans = await callTool(client, "plan.list", {
      goal_id: createdGoal.goal.goal_id,
      limit: 10,
    });
    assert.equal(goalPlans.count, 0);

    const skippedAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.blocked", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(skippedAutorun.executed_count, 0);
    assert.equal(skippedAutorun.skipped_count, 1);
    assert.equal(skippedAutorun.results[0].reason, "held_pre_generation_worker_pool");
    assert.equal(skippedAutorun.results[0].methodology_entry_hold.state, "blocked_by_no_viable_lane");

    const blockedSummary = await callTool(client, "kernel.summary", {
      goal_limit: 10,
      event_limit: 20,
    });
    assert.equal(blockedSummary.state, "blocked");
    assert.ok(blockedSummary.attention.some((entry) => /held before plan generation/i.test(entry)));
    assert.ok(blockedSummary.overview.methodology_entry_hold_count >= 1);
    const blockedGoalSummary = blockedSummary.open_goals.find((entry) => entry.goal_id === createdGoal.goal.goal_id);
    assert.ok(blockedGoalSummary);
    assert.equal(blockedGoalSummary.execution_summary.methodology_entry_held, true);
    assert.equal(blockedGoalSummary.execution_summary.methodology_entry_hold_state, "blocked_by_no_viable_lane");

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "goal-execute-held-before-generation-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    const recoveredAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.recovered", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(recoveredAutorun.executed_count, 1);
    assert.equal(recoveredAutorun.results[0].reason, "generated_plan");
    assert.equal(recoveredAutorun.results[0].execution.executed, true);
    assert.equal(recoveredAutorun.results[0].execution.created_plan, true);

    const goalState = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.notEqual(goalState.goal.active_plan_id, null);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute pauses destructive autonomy when the generated worker pool is too weak", async () => {
  const testId = `${Date.now()}-goal-execute-pause-worker-pool`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-pause-worker-pool-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Destructive autonomy goal",
      objective: "Ship a bounded mutation slice only when a dispatchable live worker pool exists",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["A generated plan pauses instead of auto-running against a weak worker pool"],
      tags: ["agentic", "delivery"],
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.executed, false);
    assert.equal(executedGoal.paused_for_worker_pool, true);
    assert.equal(executedGoal.created_plan, true);
    assert.equal(executedGoal.plan_resolution, "generated");
    assert.equal(executedGoal.plan.selected, false);
    assert.equal(executedGoal.plan_risk_assessment.can_auto_execute, false);
    assert.equal(executedGoal.plan_risk_assessment.adaptive_routing_summary.mode_counts.none, 3);
    assert.match(executedGoal.pause_reason, /dispatchable live worker pool/i);
    assert.equal(executedGoal.execution_summary.completed_count, 0);
    assert.ok(executedGoal.execution_summary.ready_count >= 1);

    const pausedPlan = await callTool(client, "plan.get", {
      plan_id: executedGoal.plan.plan_id,
    });
    assert.equal(pausedPlan.plan.metadata.last_plan_risk_assessment.can_auto_execute, false);
    assert.equal(pausedPlan.plan.metadata.last_plan_risk_assessment.pause_reason, executedGoal.pause_reason);
    assert.equal(pausedPlan.plan.metadata.worker_pool_pause.goal_id, createdGoal.goal.goal_id);
    assert.equal(pausedPlan.plan.metadata.worker_pool_pause.autonomy_mode, "execute_destructive_with_approval");
    assert.equal(pausedPlan.plan.metadata.worker_pool_pause.mode_counts.none, 3);

    const kernelSummary = await callTool(client, "kernel.summary", {
      goal_limit: 10,
      event_limit: 20,
    });
    assert.ok(kernelSummary.attention.some((entry) => /worker-pool risk is pausing/i.test(entry)));
    assert.ok(kernelSummary.overview.worker_pool_paused_count >= 1);
    const pausedGoalSummary = kernelSummary.open_goals.find((entry) => entry.goal_id === createdGoal.goal.goal_id);
    assert.ok(pausedGoalSummary);
    assert.equal(pausedGoalSummary.execution_summary.worker_pool_paused, true);
    assert.match(pausedGoalSummary.execution_summary.next_action, /healthier worker lanes|safer plan/i);

    const goalState = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goalState.goal.active_plan_id, null);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.autorun skips plans that are already paused for weak worker pools", async () => {
  const testId = `${Date.now()}-goal-autorun-worker-pool-paused`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-autorun-worker-pool-paused-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Autorun paused worker pool goal",
      objective: "Skip re-entering worker-pool-paused plans during bounded autorun scans",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["goal.autorun records a worker-pool pause and skips it on the next pass"],
      tags: ["agentic", "delivery"],
    });

    const firstAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.first", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(firstAutorun.executed_count, 1);
    assert.equal(firstAutorun.skipped_count, 0);
    assert.equal(firstAutorun.results[0].action, "executed");
    assert.equal(firstAutorun.results[0].reason, "generated_plan");
    assert.equal(firstAutorun.results[0].execution.paused_for_worker_pool, true);

    const pausedPlanId = firstAutorun.results[0].execution.plan.plan_id;
    const pausedPlan = await callTool(client, "plan.get", {
      plan_id: pausedPlanId,
    });
    assert.equal(pausedPlan.plan.metadata.last_plan_risk_assessment.can_auto_execute, false);
    assert.equal(pausedPlan.plan.metadata.worker_pool_pause.goal_id, createdGoal.goal.goal_id);

    const secondAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.second", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(secondAutorun.executed_count, 0);
    assert.equal(secondAutorun.skipped_count, 1);
    assert.equal(secondAutorun.results[0].action, "skipped");
    assert.equal(secondAutorun.results[0].reason, "worker_pool_paused");
    assert.equal(secondAutorun.results[0].plan_id, pausedPlanId);
    assert.match(secondAutorun.results[0].pause_reason, /worker pool/i);
    assert.equal(secondAutorun.results[0].plan_risk_assessment.can_auto_execute, false);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute replans paused worker-pool goals when a viable live session appears", async () => {
  const testId = `${Date.now()}-goal-execute-worker-pool-recovery`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-worker-pool-recovery-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Worker-pool recovery goal",
      objective: "Replan automatically when viable live worker lanes return",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["A paused plan can be replaced with a lower-risk replanned candidate"],
      tags: ["agentic", "delivery"],
    });

    const initialExecute = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute.initial", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(initialExecute.executed, false);
    assert.equal(initialExecute.paused_for_worker_pool, true);
    const pausedPlanId = initialExecute.plan.plan_id;

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "goal-execute-recovery-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    const recoveredExecute = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute.recovered", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(recoveredExecute.ok, true);
    assert.equal(recoveredExecute.executed, true);
    assert.equal(recoveredExecute.created_plan, true);
    assert.equal(recoveredExecute.generated_plan_reason, "worker_pool_recovery");
    assert.equal(recoveredExecute.plan_resolution, "generated");
    assert.notEqual(recoveredExecute.plan.plan_id, pausedPlanId);
    assert.equal(recoveredExecute.plan_risk_assessment.can_auto_execute, true);
    assert.ok(recoveredExecute.plan_risk_assessment.adaptive_routing_summary.mode_counts.preferred_pool >= 1);
    assert.equal(recoveredExecute.selected_existing_plan, false);

    const recoveredPlan = await callTool(client, "plan.get", {
      plan_id: recoveredExecute.plan.plan_id,
    });
    assert.equal(recoveredPlan.plan.metadata.goal_execute_generation_reason, "worker_pool_recovery");
    assert.equal(recoveredPlan.plan.metadata.replanned_from_plan_id, pausedPlanId);
    assert.equal(recoveredPlan.plan.metadata.last_plan_risk_assessment.can_auto_execute, true);

    const goalState = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goalState.goal.active_plan_id, recoveredExecute.plan.plan_id);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.autorun can recover paused worker-pool goals when a viable live session appears", async () => {
  const testId = `${Date.now()}-goal-autorun-worker-pool-recovery`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-autorun-worker-pool-recovery-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Autorun worker-pool recovery goal",
      objective: "Recover paused destructive plans automatically once a viable lane returns",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["goal.autorun can trigger recovery replanning against the live worker pool"],
      tags: ["agentic", "delivery"],
    });

    const firstAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.first", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(firstAutorun.executed_count, 1);
    assert.equal(firstAutorun.results[0].execution.paused_for_worker_pool, true);
    const pausedPlanId = firstAutorun.results[0].execution.plan.plan_id;

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "goal-autorun-recovery-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    const recoveredAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.second", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(recoveredAutorun.executed_count, 1);
    assert.equal(recoveredAutorun.skipped_count, 0);
    assert.equal(recoveredAutorun.results[0].action, "executed");
    assert.equal(recoveredAutorun.results[0].reason, "worker_pool_recovery");
    assert.equal(recoveredAutorun.results[0].execution.executed, true);
    assert.equal(recoveredAutorun.results[0].execution.generated_plan_reason, "worker_pool_recovery");
    assert.notEqual(recoveredAutorun.results[0].execution.plan.plan_id, pausedPlanId);
    assert.equal(recoveredAutorun.results[0].execution.plan_risk_assessment.can_auto_execute, true);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.autorun does not repeat worker-pool recovery replans against the same weak session pool", async () => {
  const testId = `${Date.now()}-goal-autorun-worker-pool-recovery-fingerprint`;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-core-template-goal-autorun-worker-pool-recovery-fingerprint-test-")
  );
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Worker-pool recovery fingerprint goal",
      objective: "Avoid infinite replanning against the same weak live worker pool",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["Recovery replans only repeat when the live worker pool meaningfully changes"],
      tags: ["agentic", "delivery"],
    });

    const firstAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.first", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(firstAutorun.results[0].execution.paused_for_worker_pool, true);

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.weak", () => mutationCounter++),
      session_id: "goal-autorun-recovery-weak",
      agent_id: "local-imprint",
      client_kind: "local-imprint",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {},
    });

    const recoveryAttempt = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.second", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(recoveryAttempt.executed_count, 1);
    assert.equal(recoveryAttempt.results[0].reason, "worker_pool_recovery");
    assert.equal(recoveryAttempt.results[0].execution.paused_for_worker_pool, true);
    const recoveryPlanId = recoveryAttempt.results[0].execution.plan.plan_id;

    const recoveryPlan = await callTool(client, "plan.get", {
      plan_id: recoveryPlanId,
    });
    assert.ok(recoveryPlan.plan.metadata.worker_pool_recovery_attempt.pool_fingerprint);
    assert.equal(recoveryAttempt.results[0].execution.generated_plan_reason, "worker_pool_recovery");

    const repeatedAutorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun.third", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(repeatedAutorun.executed_count, 0);
    assert.equal(repeatedAutorun.skipped_count, 1);
    assert.equal(repeatedAutorun.results[0].reason, "worker_pool_paused");
    assert.equal(repeatedAutorun.results[0].plan_id, recoveryPlanId);
    assert.equal(repeatedAutorun.results[0].recovery_state, "awaiting_pool_change");
    assert.ok(repeatedAutorun.results[0].suppression_count >= 1);

    const kernelSummary = await callTool(client, "kernel.summary", {
      goal_limit: 10,
      event_limit: 50,
    });
    assert.ok(kernelSummary.attention.some((entry) => /suppressed until the live worker pool changes/i.test(entry)));
    assert.ok(kernelSummary.overview.worker_pool_recovery_waiting_count >= 1);
    const pausedGoalSummary = kernelSummary.open_goals.find((entry) => entry.goal_id === createdGoal.goal.goal_id);
    assert.ok(pausedGoalSummary);
    assert.equal(pausedGoalSummary.execution_summary.worker_pool_recovery_state, "awaiting_pool_change");
    assert.ok(pausedGoalSummary.execution_summary.worker_pool_recovery_suppressed_count >= 1);

    const recoveryEvents = await callTool(client, "event.tail", {
      entity_type: "goal",
      entity_id: createdGoal.goal.goal_id,
      limit: 50,
    });
    assert.ok(recoveryEvents.events.some((event) => event.event_type === "goal.worker_pool_recovery_waiting"));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute prefers a lower-risk existing plan when the active plan is autonomy-blocked", async () => {
  const testId = `${Date.now()}-goal-execute-lower-risk-plan`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-lower-risk-plan-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Prefer lower-risk plan goal",
      objective: "Choose the safer existing plan when destructive autonomy rejects the active worker lane",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["A safer existing plan is selected over the risky active plan"],
    });

    const riskyPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.risky", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Risky worker plan",
      summary: "Selected plan with no dispatchable worker lane guidance",
      selected: true,
      confidence: 0.84,
      metadata: {
        adaptive_plan_routing_summary: {
          worker_step_count: 1,
          mode_counts: {
            preferred_pool: 0,
            fallback_degraded: 0,
            none: 1,
          },
        },
      },
      steps: [
        {
          step_id: "risky-worker",
          seq: 1,
          title: "Risky worker lane",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Attempt a mutation with no live worker pool",
            project_dir: REPO_ROOT,
          },
          metadata: {
            adaptive_assignment: {
              mode: "none",
              lane_kind: "implementation",
              rationale: "No dispatchable worker pool exists.",
            },
          },
        },
      ],
    });
    assert.equal(riskyPlan.plan.selected, true);

    const safePlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.safe", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Safe synchronous plan",
      summary: "Use a synchronous MCP step that does not depend on weak worker lanes",
      confidence: 0.72,
      steps: [
        {
          step_id: "safe-read",
          seq: 1,
          title: "Read the goal safely",
          step_kind: "analysis",
          executor_kind: "tool",
          tool_name: "goal.get",
          input: {
            goal_id: createdGoal.goal.goal_id,
          },
        },
      ],
    });
    assert.equal(safePlan.plan.selected, false);

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.executed, true);
    assert.equal(executedGoal.plan.plan_id, safePlan.plan.plan_id);
    assert.equal(executedGoal.plan_resolution, "latest");
    assert.equal(executedGoal.selected_existing_plan, true);
    assert.equal(executedGoal.final_plan.status, "completed");
    assert.equal(executedGoal.plan_risk_assessment.can_auto_execute, true);
    assert.equal(executedGoal.plan_risk_assessment.worker_step_count, 0);

    const goalState = await callTool(client, "goal.get", {
      goal_id: createdGoal.goal.goal_id,
    });
    assert.equal(goalState.goal.active_plan_id, safePlan.plan.plan_id);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.execute can run an existing synchronous plan to terminal completion", async () => {
  const testId = `${Date.now()}-goal-execute-complete`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-execute-complete-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Synchronous execution goal",
      objective: "Finish an existing selected plan through goal.execute",
      status: "active",
      autonomy_mode: "recommend",
      acceptance_criteria: ["The selected plan reaches a terminal completed state"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Synchronous execution plan",
      summary: "Use two synchronous MCP tool steps so goal.execute can finish the plan",
      selected: true,
      steps: [
        {
          step_id: "read-goal-once",
          seq: 1,
          title: "Read the goal once",
          step_kind: "analysis",
          executor_kind: "tool",
          tool_name: "goal.get",
          input: {
            goal_id: createdGoal.goal.goal_id,
          },
        },
        {
          step_id: "read-goal-twice",
          seq: 2,
          title: "Read the goal twice",
          step_kind: "analysis",
          executor_kind: "tool",
          tool_name: "goal.get",
          depends_on: ["read-goal-once"],
          input: {
            goal_id: createdGoal.goal.goal_id,
          },
        },
      ],
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      plan_id: createdPlan.plan.plan_id,
      max_passes: 4,
    });

    assert.equal(executedGoal.ok, true);
    assert.equal(executedGoal.executed, true);
    assert.equal(executedGoal.created_plan, false);
    assert.equal(executedGoal.plan_resolution, "explicit");
    assert.equal(executedGoal.final_plan.status, "completed");
    assert.equal(executedGoal.execution.stop_reason, "plan_terminal");
    assert.equal(executedGoal.execution_summary.completed_count, 2);
    assert.equal(executedGoal.execution_summary.running_count, 0);
    assert.equal(executedGoal.execution_summary.ready_count, 0);
    assert.match(executedGoal.execution_summary.next_action, /Plan completed/);

    const completedPlan = await callTool(client, "plan.get", {
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(completedPlan.plan.status, "completed");
    assert.ok(completedPlan.steps.every((step) => step.status === "completed"));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("playbook.run routes autoresearch through the dynamic optimization planner", async () => {
  const testId = `${Date.now()}-playbook-run-autoresearch-dynamic`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-playbook-run-autoresearch-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const ranPlaybook = await callTool(client, "playbook.run", {
      mutation: nextMutation(testId, "playbook.run", () => mutationCounter++),
      playbook_id: "autoresearch.optimize_loop",
      title: "Optimize worker claim throughput",
      objective: "Improve worker claim throughput and compare the result to the current baseline",
      max_passes: 4,
      metadata: {
        preferred_metric_name: "throughput_ops_per_sec",
        preferred_metric_direction: "maximize",
        acceptance_delta: 2,
      },
    });

    assert.equal(ranPlaybook.ok, true);
    assert.equal(ranPlaybook.planning_mode, "dynamic_pack_planner");
    assert.equal(ranPlaybook.plan.metadata.planner_hook.hook_id, "agentic.optimization_loop");
    assert.equal(ranPlaybook.execution.planner_selection.methodology, "optimization");
    assert.ok(
      ranPlaybook.steps.some(
        (step) =>
          step.step_id.endsWith("create-experiment-ledger") || step.title === "Create the durable experiment ledger"
      )
    );

    const experiments = await callTool(client, "experiment.list", {
      goal_id: ranPlaybook.goal.goal_id,
      limit: 10,
    });
    assert.equal(experiments.count, 1);
    assert.equal(experiments.experiments[0].metric_name, "throughput_ops_per_sec");
    assert.equal(experiments.experiments[0].metric_direction, "maximize");
    assert.equal(experiments.experiments[0].acceptance_delta, 2);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("playbook.run can hold explicit delivery planning before plan creation when destructive autonomy has no viable lane", async () => {
  const testId = `${Date.now()}-playbook-run-held-before-planning`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-playbook-run-held-before-planning-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const ranPlaybook = await callTool(client, "playbook.run", {
      mutation: nextMutation(testId, "playbook.run", () => mutationCounter++),
      playbook_id: "gsd.phase_delivery",
      title: "Ship a guarded mutation slice",
      objective: "Ship a guarded mutation slice once a viable live worker lane exists",
      autonomy_mode: "execute_destructive_with_approval",
      max_passes: 4,
    });

    assert.equal(ranPlaybook.ok, true);
    assert.equal(ranPlaybook.held_before_planning, true);
    assert.equal(ranPlaybook.planning_mode, "held_pre_generation");
    assert.equal(ranPlaybook.plan, null);
    assert.deepEqual(ranPlaybook.steps, []);
    assert.equal(ranPlaybook.execution, null);
    assert.equal(ranPlaybook.methodology_entry_decision.selection.methodology, "delivery");
    assert.equal(ranPlaybook.methodology_entry_decision.selection_strength, "explicit");
    assert.equal(ranPlaybook.methodology_entry_decision.hold_generation, true);
    assert.equal(ranPlaybook.methodology_entry_decision.switched_selection, false);
    assert.equal(ranPlaybook.methodology_entry_decision.state, "blocked_by_no_viable_lane");

    const goalPlans = await callTool(client, "plan.list", {
      goal_id: ranPlaybook.goal.goal_id,
      limit: 10,
    });
    assert.equal(goalPlans.count, 0);

    const recentEvents = await callTool(client, "event.tail", {
      entity_type: "goal",
      entity_id: ranPlaybook.goal.goal_id,
      limit: 10,
    });
    assert.ok(recentEvents.events.some((event) => event.event_type === "goal.entry_held"));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("playbook.run executes the static delivery path against a viable worker lane without duplicating the goal", async () => {
  const testId = `${Date.now()}-playbook-run-static-delivery`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-playbook-run-static-delivery-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "playbook-run-static-delivery-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    const ranPlaybook = await callTool(client, "playbook.run", {
      mutation: nextMutation(testId, "playbook.run", () => mutationCounter++),
      playbook_id: "gsd.phase_delivery",
      title: "Ship a resilient worker fix",
      objective: "Ship a resilient worker fix through the GSD delivery path",
      autonomy_mode: "execute_bounded",
      max_passes: 4,
      trichat_bridge_dry_run: true,
    });

    assert.equal(ranPlaybook.ok, true);
    assert.equal(ranPlaybook.planning_mode, "static_playbook_plan");
    assert.equal(ranPlaybook.methodology_entry_decision.selection.methodology, "delivery");
    assert.equal(ranPlaybook.goal.active_plan_id, ranPlaybook.plan.plan_id);
    assert.equal(ranPlaybook.plan.goal_id, ranPlaybook.goal.goal_id);
    assert.equal(ranPlaybook.plan.metadata.playbook_id, "gsd.phase_delivery");

    const goalPlans = await callTool(client, "plan.list", {
      goal_id: ranPlaybook.goal.goal_id,
      limit: 10,
    });
    assert.equal(goalPlans.count, 1);
    assert.equal(goalPlans.plans[0].plan_id, ranPlaybook.plan.plan_id);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.autorun executes eligible goals and skips running-worker or human-gated plans", async () => {
  const testId = `${Date.now()}-goal-autorun`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-autorun-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const generatedGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create.generated", () => mutationCounter++),
      title: "Autorun generated goal",
      objective: "Allow goal.autorun to create and execute a plan",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["goal.autorun can enter goal.execute for a goal without a plan"],
      tags: ["agentic"],
    });

    const humanGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create.human", () => mutationCounter++),
      title: "Autorun human gate goal",
      objective: "Ensure goal.autorun skips explicit human gates",
      status: "active",
      acceptance_criteria: ["Blocked human gates are surfaced without execution thrash"],
    });
    const humanPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.human", () => mutationCounter++),
      goal_id: humanGoal.goal.goal_id,
      title: "Human approval plan",
      summary: "Block on one human step",
      selected: true,
      steps: [
        {
          step_id: "needs-human",
          seq: 1,
          title: "Await approval",
          step_kind: "handoff",
          executor_kind: "human",
          input: {
            approval_summary: "Human approval required before continuing.",
          },
        },
      ],
    });
    await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch.human", () => mutationCounter++),
      plan_id: humanPlan.plan.plan_id,
    });

    const runningGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create.running", () => mutationCounter++),
      title: "Autorun running worker goal",
      objective: "Ensure goal.autorun skips goals that already have an in-flight worker step",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Running worker steps are not re-entered prematurely"],
    });
    const runningPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.running", () => mutationCounter++),
      goal_id: runningGoal.goal.goal_id,
      title: "Running worker plan",
      summary: "Dispatch one worker step and leave it in flight",
      selected: true,
      steps: [
        {
          step_id: "worker-in-flight",
          seq: 1,
          title: "Run the worker step",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Longer-running worker step for autorun skip coverage",
            project_dir: ".",
            priority: 5,
            tags: ["goal-autorun", "worker"],
          },
        },
      ],
    });
    await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch.running", () => mutationCounter++),
      plan_id: runningPlan.plan.plan_id,
    });

    const autorun = await callTool(client, "goal.autorun", {
      mutation: nextMutation(testId, "goal.autorun", () => mutationCounter++),
      limit: 10,
      max_passes: 4,
    });

    assert.equal(autorun.ok, true);
    assert.equal(autorun.scanned_count, 3);
    assert.equal(autorun.executed_count, 1);
    assert.equal(autorun.skipped_count, 2);

    const resultByGoalId = new Map(autorun.results.map((result) => [result.goal_id, result]));

    const generatedResult = resultByGoalId.get(generatedGoal.goal.goal_id);
    assert.equal(generatedResult.action, "executed");
    assert.equal(generatedResult.reason, "generated_plan");
    assert.equal(generatedResult.execution.executed, true);
    assert.equal(generatedResult.execution.created_plan, true);

    const humanResult = resultByGoalId.get(humanGoal.goal.goal_id);
    assert.equal(humanResult.action, "skipped");
    assert.equal(humanResult.reason, "human_gate");
    assert.equal(humanResult.blocked_step.title, "Await approval");

    const runningResult = resultByGoalId.get(runningGoal.goal.goal_id);
    assert.equal(runningResult.action, "skipped");
    assert.equal(runningResult.reason, "running_worker");
    assert.equal(runningResult.running_step.title, "Run the worker step");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("goal.autorun_daemon can run once and manage persisted daemon lifecycle", async () => {
  const testId = `${Date.now()}-goal-autorun-daemon`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-goal-autorun-daemon-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Daemon-driven goal",
      objective: "Allow the goal autorun daemon to generate and dispatch a plan",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A single bounded autorun tick can execute eligible work"],
      tags: ["agentic"],
    });

    const runOnce = await callTool(client, "goal.autorun_daemon", {
      action: "run_once",
      mutation: nextMutation(testId, "goal.autorun_daemon.run_once", () => mutationCounter++),
      limit: 5,
      max_passes: 4,
    });
    assert.equal(runOnce.tick.skipped, false);
    assert.equal(runOnce.tick.tick.executed_count, 1);
    assert.ok(runOnce.status.tick_count >= 1);

    const statusBeforeStart = await callTool(client, "goal.autorun_daemon", {
      action: "status",
    });
    assert.equal(statusBeforeStart.running, false);

    const started = await callTool(client, "goal.autorun_daemon", {
      action: "start",
      mutation: nextMutation(testId, "goal.autorun_daemon.start", () => mutationCounter++),
      interval_seconds: 60,
      run_immediately: false,
    });
    assert.equal(started.running, true);
    assert.equal(started.persisted.enabled, true);

    const statusWhileRunning = await callTool(client, "goal.autorun_daemon", {
      action: "status",
    });
    assert.equal(statusWhileRunning.running, true);
    assert.equal(statusWhileRunning.config.interval_seconds, 60);

    const stopped = await callTool(client, "goal.autorun_daemon", {
      action: "stop",
      mutation: nextMutation(testId, "goal.autorun_daemon.stop", () => mutationCounter++),
    });
    assert.equal(stopped.running, false);
    assert.equal(stopped.persisted.enabled, false);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("kernel.summary reports operator-facing state across goals, tasks, sessions, and events", async () => {
  const testId = `${Date.now()}-kernel-summary`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-kernel-summary-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Kernel summary goal",
      objective: "Map the codebase and leave a queued slice for the operator summary",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["The kernel summary reports queued work and the active plan state"],
      tags: ["agentic"],
    });

    const executedGoal = await callTool(client, "goal.execute", {
      mutation: nextMutation(testId, "goal.execute", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(executedGoal.ok, true);

    const summary = await callTool(client, "kernel.summary", {
      goal_limit: 10,
      event_limit: 20,
      artifact_limit: 5,
      session_limit: 10,
    });

    assert.equal(summary.state, "degraded");
    assert.ok(summary.overview.goal_counts.active >= 1);
    assert.ok(summary.overview.task_counts.pending >= 1);
    assert.equal(summary.overview.active_session_count, 0);
    assert.equal(summary.overview.learning_entry_count, 0);
    assert.equal(summary.overview.active_learning_entry_count, 0);
    assert.ok(summary.attention.some((entry) => /no active agent sessions/i.test(entry)));
    assert.ok(summary.attention.some((entry) => /no dispatchable adaptive lane guidance/i.test(entry)));
    assert.ok(summary.overview.adaptive_plan_routing_counts.none >= 1);
    assert.ok(summary.recent_events.length >= 1);

    const goalEntry = summary.open_goals.find((goal) => goal.goal_id === createdGoal.goal.goal_id);
    assert.ok(goalEntry);
    assert.equal(goalEntry.execution_summary.running_count, 1);
    assert.match(goalEntry.execution_summary.next_action, /wait for running work/i);
    assert.ok(goalEntry.adaptive_routing_summary.mode_counts.none >= 1);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent session lifecycle persists across open, heartbeat, list, and close", async () => {
  const testId = `${Date.now()}-agent-session`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-agent-session-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const openResult = await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open", () => mutationCounter++),
      session_id: "session-integration-1",
      agent_id: "codex",
      display_name: "Codex integration session",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      owner_id: "integration-owner",
      lease_seconds: 60,
      status: "active",
      capabilities: {
        reasoning: true,
      },
      tags: ["integration", "session"],
      metadata: {
        scenario: "lifecycle",
      },
    });

    assert.equal(openResult.created, true);
    assert.equal(openResult.session.session_id, "session-integration-1");
    assert.equal(openResult.session.agent_id, "codex");
    assert.equal(openResult.session.status, "active");
    assert.equal(openResult.session.owner_id, "integration-owner");
    assert.equal(openResult.session.metadata.scenario, "lifecycle");

    const fetched = await callTool(client, "agent.session_get", {
      session_id: "session-integration-1",
    });
    assert.equal(fetched.found, true);
    assert.equal(fetched.session.session_id, "session-integration-1");
    assert.equal(fetched.session.agent_id, "codex");
    assert.equal(fetched.session.status, "active");

    const listedActive = await callTool(client, "agent.session_list", {
      agent_id: "codex",
      active_only: true,
      limit: 10,
    });
    assert.ok(listedActive.count >= 1);
    assert.ok(listedActive.sessions.some((session) => session.session_id === "session-integration-1"));

    const heartbeat = await callTool(client, "agent.session_heartbeat", {
      mutation: nextMutation(testId, "agent.session_heartbeat", () => mutationCounter++),
      session_id: "session-integration-1",
      lease_seconds: 120,
      status: "busy",
      owner_id: "integration-owner",
      capabilities: {
        reasoning: true,
        coordination: "turn-based",
      },
      metadata: {
        heartbeat: 1,
      },
    });
    assert.equal(heartbeat.renewed, true);
    assert.equal(heartbeat.session.session_id, "session-integration-1");
    assert.equal(heartbeat.session.status, "busy");
    assert.equal(heartbeat.session.capabilities.coordination, "turn-based");
    assert.equal(heartbeat.session.metadata.scenario, "lifecycle");
    assert.equal(heartbeat.session.metadata.heartbeat, 1);
    assert.equal(typeof heartbeat.session.heartbeat_at, "string");

    const closed = await callTool(client, "agent.session_close", {
      mutation: nextMutation(testId, "agent.session_close", () => mutationCounter++),
      session_id: "session-integration-1",
      metadata: {
        closed_reason: "integration-complete",
      },
    });
    assert.equal(closed.closed, true);
    assert.equal(closed.session.session_id, "session-integration-1");
    assert.equal(closed.session.status, "closed");
    assert.equal(closed.session.metadata.closed_reason, "integration-complete");
    assert.equal(typeof closed.session.ended_at, "string");

    const fetchedClosed = await callTool(client, "agent.session_get", {
      session_id: "session-integration-1",
    });
    assert.equal(fetchedClosed.found, true);
    assert.equal(fetchedClosed.session.status, "closed");

    const activeAfterClose = await callTool(client, "agent.session_list", {
      agent_id: "codex",
      active_only: true,
      limit: 10,
    });
    assert.equal(activeAfterClose.sessions.some((session) => session.session_id === "session-integration-1"), false);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent.worklist and agent.claim_next respect task routing for codex and cursor sessions", async () => {
  const testId = `${Date.now()}-agent-routing`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-agent-routing-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "routing-codex-session",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        coding: true,
        worker: true,
      },
    });

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.cursor", () => mutationCounter++),
      session_id: "routing-cursor-session",
      agent_id: "cursor",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        review: true,
        verify: true,
      },
    });

    const codexOnlyTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.codex", () => mutationCounter++),
      objective: "Codex-only implementation task",
      project_dir: REPO_ROOT,
      priority: 4,
      routing: {
        allowed_agent_ids: ["codex"],
      },
      tags: ["routing", "codex"],
    });

    const cursorOnlyTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.cursor", () => mutationCounter++),
      objective: "Cursor-only review task",
      project_dir: REPO_ROOT,
      priority: 7,
      routing: {
        allowed_agent_ids: ["cursor"],
      },
      tags: ["routing", "cursor"],
    });

    const verifyTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.verify", () => mutationCounter++),
      objective: "Verification task for review-capable agents",
      project_dir: REPO_ROOT,
      priority: 6,
      routing: {
        required_capabilities: ["verify"],
      },
      tags: ["routing", "verify"],
    });

    const codexWorklist = await callTool(client, "agent.worklist", {
      session_id: "routing-codex-session",
      limit: 10,
      include_ineligible: true,
    });
    assert.equal(codexWorklist.found, true);
    assert.equal(codexWorklist.eligible_count, 1);
    assert.equal(codexWorklist.tasks[0].task_id, codexOnlyTask.task.task_id);
    assert.ok(codexWorklist.ineligible_tasks.some((task) => task.task_id === cursorOnlyTask.task.task_id));
    assert.ok(codexWorklist.ineligible_tasks.some((task) => task.task_id === verifyTask.task.task_id));

    const rejectedClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.rejected", () => mutationCounter++),
      session_id: "routing-codex-session",
      task_id: cursorOnlyTask.task.task_id,
    });
    assert.equal(rejectedClaim.claimed, false);
    assert.match(rejectedClaim.reason, /^routing-ineligible:/);

    const codexClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.codex", () => mutationCounter++),
      session_id: "routing-codex-session",
      lease_seconds: 120,
    });
    assert.equal(codexClaim.claimed, true);
    assert.equal(codexClaim.task.task_id, codexOnlyTask.task.task_id);
    assert.equal(codexClaim.routing.eligible, true);

    const cursorWorklist = await callTool(client, "agent.worklist", {
      session_id: "routing-cursor-session",
      limit: 10,
      include_ineligible: true,
    });
    assert.equal(cursorWorklist.found, true);
    assert.equal(cursorWorklist.eligible_count, 2);
    assert.equal(cursorWorklist.tasks[0].task_id, cursorOnlyTask.task.task_id);
    assert.ok(cursorWorklist.tasks.some((task) => task.task_id === verifyTask.task.task_id));

    const cursorClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.cursor", () => mutationCounter++),
      session_id: "routing-cursor-session",
      lease_seconds: 120,
    });
    assert.equal(cursorClaim.claimed, true);
    assert.equal(cursorClaim.task.task_id, cursorOnlyTask.task.task_id);
    assert.equal(cursorClaim.routing.eligible, true);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task.claim skips explicitly agent-routed work for generic workers", async () => {
  const testId = `${Date.now()}-task-claim-routing`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-task-claim-routing-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const routedTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.routed", () => mutationCounter++),
      objective: "Routed task for codex only",
      project_dir: REPO_ROOT,
      priority: 9,
      routing: {
        allowed_agent_ids: ["codex"],
      },
    });

    const genericTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.generic", () => mutationCounter++),
      objective: "Generic worker task",
      project_dir: REPO_ROOT,
      priority: 5,
    });

    const explicitRejection = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.rejected", () => mutationCounter++),
      worker_id: "generic-worker-1",
      task_id: routedTask.task.task_id,
      lease_seconds: 120,
    });
    assert.equal(explicitRejection.claimed, false);
    assert.equal(explicitRejection.reason, "routing-ineligible:agent_id_not_allowed");

    const genericClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.generic", () => mutationCounter++),
      worker_id: "generic-worker-1",
      lease_seconds: 120,
    });
    assert.equal(genericClaim.claimed, true);
    assert.equal(genericClaim.task.task_id, genericTask.task.task_id);

    const pending = await callTool(client, "task.list", {
      status: "pending",
      limit: 10,
    });
    assert.ok(pending.tasks.some((task) => task.task_id === routedTask.task.task_id));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("worker hardening keeps low-tier and generic lanes away from high-complexity tasks", async () => {
  const testId = `${Date.now()}-worker-hardening`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-worker-hardening-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "hardening-codex-session",
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

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.imprint", () => mutationCounter++),
      session_id: "hardening-imprint-session",
      agent_id: "local-imprint",
      client_kind: "imprint",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        background: true,
      },
    });

    const createdTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create", () => mutationCounter++),
      objective: "Implement and verify a bounded refactor across the local agentic kernel codebase with explicit regression checks",
      project_dir: REPO_ROOT,
      priority: 8,
      tags: ["agentic", "implementation"],
    });

    const imprintWorklist = await callTool(client, "agent.worklist", {
      session_id: "hardening-imprint-session",
      limit: 10,
      include_ineligible: true,
    });
    assert.equal(imprintWorklist.eligible_count, 0);
    assert.ok(
      imprintWorklist.ineligible_tasks.some(
        (task) =>
          task.task_id === createdTask.task.task_id &&
          task.blockers.some((blocker) => blocker.startsWith("insufficient_capability_tier"))
      )
    );

    const rejectedLowTierClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.imprint", () => mutationCounter++),
      session_id: "hardening-imprint-session",
      task_id: createdTask.task.task_id,
    });
    assert.equal(rejectedLowTierClaim.claimed, false);
    assert.match(rejectedLowTierClaim.reason, /^routing-ineligible:/);

    const rejectedGenericClaim = await callTool(client, "task.claim", {
      mutation: nextMutation(testId, "task.claim.generic", () => mutationCounter++),
      worker_id: "background-worker",
      task_id: createdTask.task.task_id,
    });
    assert.equal(rejectedGenericClaim.claimed, false);
    assert.equal(rejectedGenericClaim.reason, "routing-ineligible:complexity_high");

    const codexWorklist = await callTool(client, "agent.worklist", {
      session_id: "hardening-codex-session",
      limit: 10,
    });
    assert.ok(codexWorklist.tasks.some((task) => task.task_id === createdTask.task.task_id));
    assert.equal(
      codexWorklist.tasks.find((task) => task.task_id === createdTask.task.task_id).task_profile.complexity,
      "high"
    );

    const codexClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.codex", () => mutationCounter++),
      session_id: "hardening-codex-session",
      task_id: createdTask.task.task_id,
    });
    assert.equal(codexClaim.claimed, true);
    assert.equal(codexClaim.routing.task_profile.complexity, "high");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("adaptive worker scoring penalizes repeated failure and stagnation history during routing", async () => {
  const testId = `${Date.now()}-adaptive-worker-scoring`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-adaptive-worker-scoring-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.steady", () => mutationCounter++),
      session_id: "adaptive-steady-session",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.struggling", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      agent_id: "cursor",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    const createMediumTask = async (label) =>
      callTool(client, "task.create", {
        mutation: nextMutation(testId, `task.create.${label}`, () => mutationCounter++),
        objective: `Debug the adaptive routing kernel path and verify the scoring adjustments for ${label}`,
        project_dir: REPO_ROOT,
        priority: 5,
        tags: ["adaptive-routing"],
      });

    const strugglingTaskOne = await createMediumTask("struggling-one");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.struggling.one", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskOne.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.struggling.one", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskOne.task.task_id,
      outcome: "failed",
      error: "First routed task failed during execution",
      summary: "Failed the first adaptive routing task",
      result: {
        failed: true,
      },
    });

    const strugglingTaskTwo = await createMediumTask("struggling-two");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.struggling.two", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskTwo.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.struggling.one", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskTwo.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.struggling.two", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskTwo.task.task_id,
    });
    const stagnationHeartbeat = await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.struggling.three", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskTwo.task.task_id,
    });
    assert.equal(stagnationHeartbeat.stagnation_signaled, true);
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.struggling.two", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: strugglingTaskTwo.task.task_id,
      outcome: "failed",
      error: "Second routed task failed after repeated stalled heartbeats",
      summary: "Failed the second adaptive routing task after stagnation",
      result: {
        failed: true,
      },
    });

    const steadyTaskOne = await createMediumTask("steady-one");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.steady.one", () => mutationCounter++),
      session_id: "adaptive-steady-session",
      task_id: steadyTaskOne.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.steady.one", () => mutationCounter++),
      session_id: "adaptive-steady-session",
      task_id: steadyTaskOne.task.task_id,
      outcome: "completed",
      summary: "Completed the first adaptive routing task",
      result: {
        completed: true,
      },
    });

    const steadyTaskTwo = await createMediumTask("steady-two");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.steady.two", () => mutationCounter++),
      session_id: "adaptive-steady-session",
      task_id: steadyTaskTwo.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.steady.two", () => mutationCounter++),
      session_id: "adaptive-steady-session",
      task_id: steadyTaskTwo.task.task_id,
      outcome: "completed",
      summary: "Completed the second adaptive routing task",
      result: {
        completed: true,
      },
    });

    const targetTask = await createMediumTask("target");

    const steadyWorklist = await callTool(client, "agent.worklist", {
      session_id: "adaptive-steady-session",
      limit: 10,
    });
    const strugglingWorklist = await callTool(client, "agent.worklist", {
      session_id: "adaptive-struggling-session",
      limit: 10,
      include_ineligible: true,
    });

    const steadyEntry = steadyWorklist.tasks.find((task) => task.task_id === targetTask.task.task_id);
    assert.ok(steadyEntry);
    assert.equal(steadyEntry.task_profile.complexity, "medium");
    assert.ok(steadyEntry.adaptive_score_adjustment >= 0);
    assert.equal(steadyEntry.session_performance.total_completed, 2);

    const strugglingEntry = strugglingWorklist.ineligible_tasks.find((task) => task.task_id === targetTask.task.task_id);
    assert.ok(strugglingEntry);
    assert.ok(strugglingEntry.blockers.some((blocker) => blocker.startsWith("performance_medium_risk")));
    assert.ok(strugglingEntry.adaptive_score_adjustment < steadyEntry.adaptive_score_adjustment);
    assert.equal(strugglingEntry.session_performance.total_failed, 2);
    assert.equal(strugglingEntry.session_performance.total_stagnation_signals, 1);

    const kernelSummary = await callTool(client, "kernel.summary", {
      session_limit: 10,
      goal_limit: 5,
      event_limit: 20,
    });
    const steadySessionSummary = kernelSummary.adaptive_sessions.find(
      (session) => session.session_id === "adaptive-steady-session"
    );
    const strugglingSessionSummary = kernelSummary.adaptive_sessions.find(
      (session) => session.session_id === "adaptive-struggling-session"
    );
    assert.ok(steadySessionSummary);
    assert.ok(strugglingSessionSummary);
    assert.equal(steadySessionSummary.adaptive_state, "healthy");
    assert.equal(strugglingSessionSummary.adaptive_state, "suppressed");
    assert.ok(kernelSummary.overview.adaptive_session_counts.healthy >= 1);
    assert.ok(kernelSummary.overview.adaptive_session_counts.suppressed >= 1);
    assert.ok(kernelSummary.attention.some((entry) => /adaptive routing is suppressing/i.test(entry)));

    const rejectedStrugglingClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.struggling.target", () => mutationCounter++),
      session_id: "adaptive-struggling-session",
      task_id: targetTask.task.task_id,
    });
    assert.equal(rejectedStrugglingClaim.claimed, false);
    assert.match(rejectedStrugglingClaim.reason, /^routing-ineligible:performance_medium_risk/);

    const steadyClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.steady.target", () => mutationCounter++),
      session_id: "adaptive-steady-session",
      task_id: targetTask.task.task_id,
    });
    assert.equal(steadyClaim.claimed, true);
    assert.equal(steadyClaim.task.task_id, targetTask.task.task_id);
    assert.ok(steadyClaim.routing.adaptive_score_adjustment >= 0);
    assert.equal(steadyClaim.routing.session_performance.total_completed, 2);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("adaptive worker health recovers after a completion streak while stale failed tasks stop degrading the kernel", async () => {
  const testId = `${Date.now()}-adaptive-recovery`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-adaptive-recovery-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.recovered", () => mutationCounter++),
      session_id: "adaptive-recovered-session",
      agent_id: "ring-leader",
      client_kind: "trichat-autopilot",
      display_name: "Recovered adaptive session",
      workspace_root: REPO_ROOT,
      transport_kind: "daemon",
      status: "active",
      capabilities: {
        capability_tier: "high",
        planning: true,
      },
    });

    const createRecoveryTask = async (label) =>
      callTool(client, "task.create", {
        mutation: nextMutation(testId, `task.create.${label}`, () => mutationCounter++),
        objective: `Recover the adaptive routing baseline for ${label}`,
        project_dir: REPO_ROOT,
        priority: 5,
        tags: ["adaptive-routing", "recovery"],
      });

    for (const label of ["failed-one", "failed-two"]) {
      const task = await createRecoveryTask(label);
      await callTool(client, "agent.claim_next", {
        mutation: nextMutation(testId, `agent.claim_next.recovered.${label}`, () => mutationCounter++),
        session_id: "adaptive-recovered-session",
        task_id: task.task.task_id,
      });
      await callTool(client, "agent.report_result", {
        mutation: nextMutation(testId, `agent.report_result.recovered.${label}`, () => mutationCounter++),
        session_id: "adaptive-recovered-session",
        task_id: task.task.task_id,
        outcome: "failed",
        error: `${label} failed`,
        summary: `Recovered session failed ${label}`,
        result: {
          failed: true,
        },
      });
    }

    for (const label of ["recovery-one", "recovery-two", "recovery-three", "recovery-four"]) {
      const task = await createRecoveryTask(label);
      await callTool(client, "agent.claim_next", {
        mutation: nextMutation(testId, `agent.claim_next.recovered.${label}`, () => mutationCounter++),
        session_id: "adaptive-recovered-session",
        task_id: task.task.task_id,
      });
      await callTool(client, "agent.report_result", {
        mutation: nextMutation(testId, `agent.report_result.recovered.${label}`, () => mutationCounter++),
        session_id: "adaptive-recovered-session",
        task_id: task.task.task_id,
        outcome: "completed",
        summary: `Recovered session completed ${label}`,
        result: {
          completed: true,
        },
      });
    }

    const targetTask = await createRecoveryTask("target");
    const worklist = await callTool(client, "agent.worklist", {
      session_id: "adaptive-recovered-session",
      limit: 10,
      include_ineligible: true,
    });
    const routingEntry = worklist.tasks.find((task) => task.task_id === targetTask.task.task_id);
    assert.ok(routingEntry);
    assert.equal(routingEntry.session_performance.total_failed, 2);
    assert.ok(routingEntry.adaptive_score_adjustment >= 0);

    const kernelSummary = await callTool(client, "kernel.summary", {
      session_limit: 10,
      goal_limit: 5,
      event_limit: 20,
      task_running_limit: 10,
    });
    const recoveredSessionSummary = kernelSummary.adaptive_sessions.find(
      (session) => session.session_id === "adaptive-recovered-session"
    );
    assert.ok(recoveredSessionSummary);
    assert.equal(recoveredSessionSummary.adaptive_state, "healthy");
    assert.ok(kernelSummary.overview.adaptive_session_counts.healthy >= 1);
    assert.equal(kernelSummary.state, "active");
    assert.ok(kernelSummary.attention.some((entry) => /stale failed task remains in history/i.test(entry)));
    assert.equal(
      kernelSummary.attention.some((entry) => /adaptive routing marks .* degraded/i.test(entry)),
      false
    );
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("adaptive session health counts recent failure pressure once across complexity lanes", async () => {
  const testId = `${Date.now()}-adaptive-health-counts-once`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-adaptive-health-counts-once-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.counts-once", () => mutationCounter++),
      session_id: "adaptive-counts-once-session",
      agent_id: "ring-leader",
      client_kind: "trichat-autopilot",
      display_name: "Adaptive count once session",
      workspace_root: REPO_ROOT,
      transport_kind: "daemon",
      status: "active",
      capabilities: {
        capability_tier: "high",
        planning: true,
      },
    });

    const failedTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.counts-once.failed", () => mutationCounter++),
      objective: "Capture one bounded adaptive failure",
      project_dir: REPO_ROOT,
      priority: 5,
      tags: ["adaptive-routing", "counts-once"],
    });
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.counts-once.failed", () => mutationCounter++),
      session_id: "adaptive-counts-once-session",
      task_id: failedTask.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.counts-once.failed", () => mutationCounter++),
      session_id: "adaptive-counts-once-session",
      task_id: failedTask.task.task_id,
      outcome: "failed",
      error: "bounded failure",
      summary: "Bounded failure for count-once coverage",
      result: {
        failed: true,
      },
    });

    const kernelSummary = await callTool(client, "kernel.summary", {
      session_limit: 10,
      goal_limit: 5,
      event_limit: 20,
      task_running_limit: 10,
    });
    const degradedSessionSummary = kernelSummary.adaptive_sessions.find(
      (session) => session.session_id === "adaptive-counts-once-session"
    );
    assert.ok(degradedSessionSummary);
    assert.equal(degradedSessionSummary.adaptive_state, "degraded");
    assert.ok(
      degradedSessionSummary.adaptive_reasons.some((entry) => /1 recent failed task signal\(s\) still need recovery/i.test(entry))
    );
    assert.equal(
      degradedSessionSummary.adaptive_reasons.some((entry) => /3 recent failed task signal\(s\)/i.test(entry)),
      false
    );
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plan.dispatch injects adaptive assignment guidance into worker tasks", async () => {
  const testId = `${Date.now()}-dispatch-adaptive-assignment`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-dispatch-adaptive-assignment-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.steady", () => mutationCounter++),
      session_id: "dispatch-adaptive-steady",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.suppressed", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      agent_id: "cursor",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    const createAdaptiveTrainingTask = async (label) =>
      callTool(client, "task.create", {
        mutation: nextMutation(testId, `task.create.${label}`, () => mutationCounter++),
        objective: `Debug adaptive dispatch routing history shaping for ${label}`,
        project_dir: REPO_ROOT,
        priority: 5,
        tags: ["adaptive-routing"],
      });

    const suppressedTaskOne = await createAdaptiveTrainingTask("suppressed-one");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.suppressed.one", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskOne.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.suppressed.one", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskOne.task.task_id,
      outcome: "failed",
      error: "Seed one failed",
      summary: "First suppressed history seed failed",
      result: {
        failed: true,
      },
    });

    const suppressedTaskTwo = await createAdaptiveTrainingTask("suppressed-two");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.suppressed.two", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskTwo.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.suppressed.one", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskTwo.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.suppressed.two", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskTwo.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.suppressed.three", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskTwo.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.suppressed.two", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: suppressedTaskTwo.task.task_id,
      outcome: "failed",
      error: "Seed two failed after stagnation",
      summary: "Second suppressed history seed failed",
      result: {
        failed: true,
      },
    });

    const steadyTaskOne = await createAdaptiveTrainingTask("steady-one");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.steady.one", () => mutationCounter++),
      session_id: "dispatch-adaptive-steady",
      task_id: steadyTaskOne.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.steady.one", () => mutationCounter++),
      session_id: "dispatch-adaptive-steady",
      task_id: steadyTaskOne.task.task_id,
      outcome: "completed",
      summary: "Healthy history seed one completed",
      result: {
        completed: true,
      },
    });

    const steadyTaskTwo = await createAdaptiveTrainingTask("steady-two");
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.steady.two", () => mutationCounter++),
      session_id: "dispatch-adaptive-steady",
      task_id: steadyTaskTwo.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.steady.two", () => mutationCounter++),
      session_id: "dispatch-adaptive-steady",
      task_id: steadyTaskTwo.task.task_id,
      outcome: "completed",
      summary: "Healthy history seed two completed",
      result: {
        completed: true,
      },
    });

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Adaptive dispatch guidance goal",
      objective: "Dispatch a worker task with adaptive session assignment guidance",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Dispatch-time routing prefers healthy sessions and excludes suppressed ones"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Adaptive assignment plan",
      summary: "Create one worker step with no explicit routing so dispatch must inject adaptive guidance",
      selected: true,
      steps: [
        {
          step_id: "adaptive-worker",
          seq: 1,
          title: "Dispatch the adaptive worker lane",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Debug the adaptive routing kernel path and verify dispatch assignment guidance",
            project_dir: REPO_ROOT,
            priority: 6,
            tags: ["adaptive-routing"],
          },
        },
      ],
    });

    const dispatched = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(dispatched.dispatched_count, 1);
    assert.equal(dispatched.results[0].adaptive_assignment.mode, "preferred_pool");
    assert.equal(dispatched.results[0].adaptive_assignment.summary.healthy_count, 1);
    assert.equal(dispatched.results[0].adaptive_assignment.summary.suppressed_count, 1);

    const taskRouting = dispatched.results[0].task.task.metadata.task_routing;
    assert.deepEqual(taskRouting.allowed_agent_ids, ["codex"]);
    assert.deepEqual(taskRouting.preferred_agent_ids, ["codex"]);

    const suppressedClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.suppressed.target", () => mutationCounter++),
      session_id: "dispatch-adaptive-suppressed",
      task_id: dispatched.results[0].task_id,
    });
    assert.equal(suppressedClaim.claimed, false);
    assert.match(suppressedClaim.reason, /^routing-ineligible:/);
    assert.match(suppressedClaim.reason, /agent_id_not_allowed/);

    const steadyClaim = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.steady.target", () => mutationCounter++),
      session_id: "dispatch-adaptive-steady",
      task_id: dispatched.results[0].task_id,
    });
    assert.equal(steadyClaim.claimed, true);
    assert.equal(steadyClaim.task.task_id, dispatched.results[0].task_id);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pack.plan.generate shapes worker lanes from adaptive session health", async () => {
  const testId = `${Date.now()}-planner-adaptive-lanes`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-planner-adaptive-lanes-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.codex", () => mutationCounter++),
      session_id: "planner-adaptive-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        planning: true,
      },
    });

    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.cursor", () => mutationCounter++),
      session_id: "planner-adaptive-cursor",
      agent_id: "cursor",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        review: true,
      },
    });

    const codexTrainingTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.codex.seed", () => mutationCounter++),
      objective: "Seed healthy adaptive history for the codex implementation lane",
      project_dir: REPO_ROOT,
      priority: 4,
      tags: ["adaptive-routing", "planner"],
    });
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.codex.seed", () => mutationCounter++),
      session_id: "planner-adaptive-codex",
      task_id: codexTrainingTask.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.codex.seed", () => mutationCounter++),
      session_id: "planner-adaptive-codex",
      task_id: codexTrainingTask.task.task_id,
      outcome: "completed",
      summary: "Healthy codex seed completed",
      result: {
        completed: true,
      },
    });

    const cursorTrainingTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.cursor.seed", () => mutationCounter++),
      objective: "Seed suppressed adaptive history for the cursor verification lane",
      project_dir: REPO_ROOT,
      priority: 4,
      tags: ["adaptive-routing", "planner"],
    });
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.cursor.seed", () => mutationCounter++),
      session_id: "planner-adaptive-cursor",
      task_id: cursorTrainingTask.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.cursor.one", () => mutationCounter++),
      session_id: "planner-adaptive-cursor",
      task_id: cursorTrainingTask.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.cursor.two", () => mutationCounter++),
      session_id: "planner-adaptive-cursor",
      task_id: cursorTrainingTask.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.cursor.three", () => mutationCounter++),
      session_id: "planner-adaptive-cursor",
      task_id: cursorTrainingTask.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.cursor.seed", () => mutationCounter++),
      session_id: "planner-adaptive-cursor",
      task_id: cursorTrainingTask.task.task_id,
      outcome: "failed",
      error: "Cursor seed stagnated and failed",
      summary: "Suppressed cursor seed failed after stagnation",
      result: {
        failed: true,
      },
    });

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Planner adaptive routing goal",
      objective: "Generate a delivery plan that routes work away from weak live lanes",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Planner output prefers healthy sessions before dispatch runs"],
    });

    const generatedPlan = await callTool(client, "pack.plan.generate", {
      mutation: nextMutation(testId, "pack.plan.generate", () => mutationCounter++),
      pack_id: "agentic",
      hook_name: "delivery_path",
      target: {
        entity_type: "goal",
        entity_id: createdGoal.goal.goal_id,
      },
      goal_id: createdGoal.goal.goal_id,
      selected: true,
    });

    assert.equal(generatedPlan.ok, true);
    const mapCodebase = generatedPlan.steps.find((step) => /Map the relevant codebase/.test(step.title));
    const implementSlice = generatedPlan.steps.find((step) => /Implement the approved bounded slice/.test(step.title));
    const verifySlice = generatedPlan.steps.find((step) => /Verify behavior, wiring, and quality gates/.test(step.title));
    assert.ok(mapCodebase);
    assert.ok(implementSlice);
    assert.ok(verifySlice);

    assert.deepEqual(mapCodebase.input.routing.preferred_agent_ids, ["codex"]);
    assert.deepEqual(implementSlice.input.routing.preferred_agent_ids, ["codex"]);
    assert.deepEqual(verifySlice.input.routing.preferred_agent_ids, ["codex"]);
    assert.deepEqual(verifySlice.input.routing.allowed_agent_ids, ["codex"]);
    assert.equal(verifySlice.metadata.adaptive_assignment.mode, "preferred_pool");
    assert.equal(verifySlice.metadata.adaptive_assignment.lane_kind, "verification");
    assert.equal(verifySlice.metadata.adaptive_assignment.health_counts.healthy_count, 1);
    assert.equal(verifySlice.metadata.adaptive_assignment.health_counts.suppressed_count, 1);
    assert.equal(generatedPlan.plan.metadata.adaptive_plan_routing_summary.mode_counts.preferred_pool, 3);
    assert.equal(generatedPlan.plan.metadata.worker_pool_recovery_outlook.state, "dispatchable_now");
    assert.match(generatedPlan.plan.metadata.worker_pool_recovery_outlook.reason, /dispatchable now/i);
    assert.equal(generatedPlan.plan.confidence, 0.84);
    assert.deepEqual(
      verifySlice.metadata.adaptive_assignment.preferred_lane_hints.preferred_agent_ids,
      ["cursor", "codex"]
    );
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pack.verify.run surfaces suppressed worker pools in execution readiness", async () => {
  const testId = `${Date.now()}-execution-readiness-adaptive`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-execution-readiness-adaptive-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open.cursor", () => mutationCounter++),
      session_id: "readiness-adaptive-cursor",
      agent_id: "cursor",
      client_kind: "cursor",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        coding: true,
        review: true,
      },
    });

    const suppressedTask = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create.suppressed", () => mutationCounter++),
      objective: "Seed a suppressed adaptive state for readiness verification",
      project_dir: REPO_ROOT,
      priority: 4,
      tags: ["adaptive-routing", "readiness"],
    });
    await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next.cursor", () => mutationCounter++),
      session_id: "readiness-adaptive-cursor",
      task_id: suppressedTask.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.one", () => mutationCounter++),
      session_id: "readiness-adaptive-cursor",
      task_id: suppressedTask.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.two", () => mutationCounter++),
      session_id: "readiness-adaptive-cursor",
      task_id: suppressedTask.task.task_id,
    });
    await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task.three", () => mutationCounter++),
      session_id: "readiness-adaptive-cursor",
      task_id: suppressedTask.task.task_id,
    });
    await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result.cursor", () => mutationCounter++),
      session_id: "readiness-adaptive-cursor",
      task_id: suppressedTask.task.task_id,
      outcome: "failed",
      error: "Suppressed readiness seed failed after stagnation",
      summary: "Suppressed readiness seed failed",
      result: {
        failed: true,
      },
    });

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Execution readiness adaptive goal",
      objective: "Surface the adaptive worker pool as a first-class readiness signal",
      status: "active",
      acceptance_criteria: ["A selected plan exists", "A verification step exists"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Execution readiness adaptive plan",
      summary: "Keep one ready worker step and one verification step so readiness can evaluate the pool",
      selected: true,
      steps: [
        {
          step_id: "ready-worker",
          seq: 1,
          title: "Ready worker step",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Run the ready worker step once a dispatchable worker exists",
            project_dir: REPO_ROOT,
          },
        },
        {
          step_id: "verification-step",
          seq: 2,
          title: "Verification step",
          step_kind: "verification",
          executor_kind: "tool",
          tool_name: "goal.get",
          depends_on: ["ready-worker"],
          input: {
            goal_id: createdGoal.goal.goal_id,
          },
        },
      ],
    });
    assert.equal(createdPlan.created, true);

    const verification = await callTool(client, "pack.verify.run", {
      mutation: nextMutation(testId, "pack.verify.run", () => mutationCounter++),
      pack_id: "agentic",
      hook_name: "execution_readiness",
      target: {
        entity_type: "goal",
        entity_id: createdGoal.goal.goal_id,
      },
      goal_id: createdGoal.goal.goal_id,
      plan_id: createdPlan.plan.plan_id,
      expectations: {
        require_dispatchable_worker_session: true,
      },
    });

    assert.equal(verification.ok, true);
    assert.equal(verification.verification.pass, false);
    const adaptivePoolCheck = verification.verification.checks.find(
      (check) => check.name === "dispatchable_worker_pool"
    );
    assert.ok(adaptivePoolCheck);
    assert.equal(adaptivePoolCheck.pass, false);
    assert.equal(adaptivePoolCheck.severity, "error");
    assert.match(adaptivePoolCheck.details, /adaptive routing currently marks them all degraded or suppressed/i);
    const recoveryOutlookCheck = verification.verification.checks.find(
      (check) => check.name === "worker_pool_recovery_outlook"
    );
    assert.ok(recoveryOutlookCheck);
    assert.equal(recoveryOutlookCheck.pass, false);
    assert.equal(recoveryOutlookCheck.severity, "error");
    assert.match(recoveryOutlookCheck.details, /blocked by no viable lane/i);
    assert.match(verification.verification.summary, /blocked because no viable worker lane is available/i);

    const readinessArtifact = verification.artifacts.find(
      (artifact) => artifact.artifact_type === "agentic.execution_readiness"
    );
    assert.ok(readinessArtifact);
    assert.deepEqual(readinessArtifact.content_json.dispatchable_agent_ids, []);
    assert.deepEqual(readinessArtifact.content_json.suppressed_agent_ids, ["cursor"]);
    assert.equal(readinessArtifact.content_json.worker_pool_recovery_outlook.state, "blocked_by_no_viable_lane");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent.claim_next and agent.report_result close the worker loop back into plan steps", async () => {
  const testId = `${Date.now()}-agent-worker-loop`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-agent-worker-loop-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const openedSession = await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open", () => mutationCounter++),
      session_id: "agent-worker-loop-session",
      agent_id: "codex",
      display_name: "Kernel worker session",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      lease_seconds: 120,
      status: "active",
      capabilities: {
        worker: true,
      },
    });
    assert.equal(openedSession.created, true);

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Agent worker loop goal",
      objective: "Exercise claim and report through a durable session",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Agents can claim queued work", "Plan step state updates on report"],
    });
    const publishedEvent = await callTool(client, "event.publish", {
      mutation: nextMutation(testId, "event.publish", () => mutationCounter++),
      event_type: "runtime.note",
      entity_type: "goal",
      entity_id: createdGoal.goal.goal_id,
      summary: "Worker-loop integration note",
      details: {
        scenario: "agent-worker-loop",
      },
      source_agent: "codex",
    });
    assert.equal(publishedEvent.event_type, "runtime.note");
    assert.equal(publishedEvent.entity_id, createdGoal.goal.goal_id);

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Agent worker loop plan",
      summary: "Dispatch a worker step and complete it through the session bridge",
      selected: true,
      steps: [
        {
          step_id: "worker-step",
          seq: 1,
          title: "Execute the worker through an agent session",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Complete the worker loop integration task",
            project_dir: REPO_ROOT,
            priority: 6,
            tags: ["agent", "worker-loop"],
            payload: {
              lane: "worker",
            },
          },
        },
      ],
    });

    const dispatchResult = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(dispatchResult.dispatched_count, 1);
    const dispatchedTaskId = dispatchResult.results[0].task_id;
    assert.equal(typeof dispatchedTaskId, "string");

    const claimedTask = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next", () => mutationCounter++),
      session_id: "agent-worker-loop-session",
      lease_seconds: 120,
    });
    assert.equal(claimedTask.claimed, true);
    assert.equal(claimedTask.task.task_id, dispatchedTaskId);
    assert.equal(claimedTask.session.status, "busy");

    const currentTask = await callTool(client, "agent.current_task", {
      session_id: "agent-worker-loop-session",
    });
    assert.equal(currentTask.found, true);
    assert.equal(currentTask.task.task_id, claimedTask.task.task_id);

    const heartbeat = await callTool(client, "agent.heartbeat_task", {
      mutation: nextMutation(testId, "agent.heartbeat_task", () => mutationCounter++),
      session_id: "agent-worker-loop-session",
      lease_seconds: 180,
    });
    assert.equal(heartbeat.ok, true);
    assert.equal(heartbeat.task.task_id, claimedTask.task.task_id);
    assert.equal(heartbeat.session.status, "busy");

    const producedArtifact = await callTool(client, "artifact.record", {
      mutation: nextMutation(testId, "artifact.record.worker-loop", () => mutationCounter++),
      artifact_type: "worker.result",
      producer_kind: "worker",
      task_id: claimedTask.task.task_id,
      content_json: {
        outcome: "success",
      },
      related_entities: [
        {
          entity_type: "task",
          entity_id: claimedTask.task.task_id,
        },
      ],
    });
    assert.equal(producedArtifact.created, true);

    const reported = await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result", () => mutationCounter++),
      session_id: "agent-worker-loop-session",
      task_id: claimedTask.task.task_id,
      outcome: "completed",
      summary: "Worker completed through agent.report_result",
      run_id: "agent-worker-run-1",
      result: {
        completed: true,
      },
      produced_artifact_ids: [producedArtifact.artifact.artifact_id],
    });
    assert.equal(reported.reported, true);
    assert.equal(reported.task.status, "completed");
    assert.equal(reported.session.status, "idle");
    assert.equal(reported.plan_step_update.step.status, "completed");
    assert.equal(reported.plan_step_update.step.run_id, "agent-worker-run-1");
    assert.equal(typeof reported.auto_report_artifact_id, "string");
    assert.ok(reported.produced_artifact_ids.includes(producedArtifact.artifact.artifact_id));
    assert.ok(reported.produced_artifact_ids.includes(reported.auto_report_artifact_id));
    assert.deepEqual(
      new Set(reported.plan_step_update.step.metadata.produced_artifact_ids),
      new Set([producedArtifact.artifact.artifact_id, reported.auto_report_artifact_id])
    );

    const fetchedPlan = await callTool(client, "plan.get", {
      plan_id: createdPlan.plan.plan_id,
    });
    const workerStep = fetchedPlan.steps.find((step) => step.step_id === "worker-step");
    assert.equal(workerStep.status, "completed");
    assert.equal(workerStep.task_id, claimedTask.task.task_id);
    assert.equal(workerStep.run_id, "agent-worker-run-1");
    assert.deepEqual(
      new Set(workerStep.metadata.produced_artifact_ids),
      new Set([producedArtifact.artifact.artifact_id, reported.auto_report_artifact_id])
    );

    const stepBundle = await callTool(client, "artifact.bundle", {
      entity: {
        entity_type: "step",
        entity_id: "worker-step",
      },
      limit: 20,
    });
    assert.equal(stepBundle.found, true);
    assert.ok(
      stepBundle.artifacts.some((artifact) => artifact.artifact_id === producedArtifact.artifact.artifact_id)
    );
    assert.ok(
      stepBundle.artifacts.some(
        (artifact) =>
          artifact.artifact_id === reported.auto_report_artifact_id && artifact.artifact_type === "agent.task_report"
      )
    );

    const autoReportArtifact = await callTool(client, "artifact.get", {
      artifact_id: reported.auto_report_artifact_id,
    });
    assert.equal(autoReportArtifact.found, true);
    assert.equal(autoReportArtifact.artifact.artifact_type, "agent.task_report");
    assert.equal(autoReportArtifact.artifact.task_id, claimedTask.task.task_id);
    assert.equal(autoReportArtifact.artifact.run_id, "agent-worker-run-1");
    assert.equal(autoReportArtifact.artifact.content_json.outcome, "completed");

    const sessionAfterReport = await callTool(client, "agent.session_get", {
      session_id: "agent-worker-loop-session",
    });
    assert.equal(sessionAfterReport.found, true);
    assert.equal(sessionAfterReport.session.status, "idle");
    assert.equal(sessionAfterReport.session.metadata.last_reported_task_id, claimedTask.task.task_id);

    const allEvents = await callTool(client, "event.tail", {
      limit: 200,
    });
    const eventTypes = new Set(allEvents.events.map((event) => event.event_type));
    assert.equal(eventTypes.has("runtime.note"), true);
    assert.equal(eventTypes.has("task.created"), true);
    assert.equal(eventTypes.has("task.claimed"), true);
    assert.equal(eventTypes.has("task.completed"), true);
    assert.equal(eventTypes.has("artifact.recorded"), true);
    assert.equal(eventTypes.has("agent.task_claimed"), true);
    assert.equal(eventTypes.has("agent.task_reported"), true);
    assert.equal(eventTypes.has("plan.step_dispatched"), true);
    assert.equal(eventTypes.has("plan.step_completed"), true);

    const stepEvents = await callTool(client, "event.tail", {
      entity_type: "step",
      entity_id: "worker-step",
      limit: 50,
    });
    assert.ok(stepEvents.events.some((event) => event.event_type === "plan.step_dispatched"));
    assert.ok(stepEvents.events.some((event) => event.event_type === "plan.step_completed"));

    const taskEventSummary = await callTool(client, "event.summary", {
      entity_type: "task",
      entity_id: claimedTask.task.task_id,
      event_types: ["task.created", "task.claimed", "task.completed"],
    });
    assert.equal(taskEventSummary.count, 3);
    assert.ok(taskEventSummary.event_type_counts.some((entry) => entry.event_type === "task.created"));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent.report_result blocks plan advancement when expected evidence artifacts are missing", async () => {
  const testId = `${Date.now()}-agent-missing-evidence`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-agent-missing-evidence-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open", () => mutationCounter++),
      session_id: "agent-missing-evidence-session",
      agent_id: "codex",
      display_name: "Evidence enforcement worker",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      lease_seconds: 120,
      status: "active",
      capabilities: {
        worker: true,
      },
    });

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Evidence-enforced goal",
      objective: "Block downstream advancement when required evidence is missing",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Steps requiring verification evidence stay blocked until that evidence exists"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Evidence-enforced plan",
      summary: "Require a verification artifact before allowing the step to complete",
      selected: true,
      steps: [
        {
          step_id: "verify-step",
          seq: 1,
          title: "Produce a verification report",
          step_kind: "verification",
          executor_kind: "worker",
          expected_artifact_types: ["verification_report"],
          input: {
            objective: "Run verification and attach the verification report artifact",
            project_dir: REPO_ROOT,
          },
        },
      ],
    });

    const dispatched = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });
    const claimed = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next", () => mutationCounter++),
      session_id: "agent-missing-evidence-session",
      lease_seconds: 120,
    });
    assert.equal(claimed.claimed, true);

    const reported = await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result", () => mutationCounter++),
      session_id: "agent-missing-evidence-session",
      task_id: claimed.task.task_id,
      outcome: "completed",
      summary: "Completed the verification task but forgot to attach the evidence artifact",
      result: {
        completed: true,
      },
    });

    assert.equal(reported.reported, true);
    assert.equal(reported.plan_step_update.step.status, "blocked");
    assert.equal(reported.evidence_gate.satisfied, false);
    assert.deepEqual(reported.evidence_gate.missing_artifact_types, ["verification_report"]);
    assert.equal(reported.goal_autorun.triggered, false);
    assert.equal(reported.goal_autorun.reason, "missing_expected_artifacts");

    const fetchedPlan = await callTool(client, "plan.get", {
      plan_id: createdPlan.plan.plan_id,
    });
    const blockedStep = fetchedPlan.steps.find((step) => step.step_id === "verify-step");
    assert.equal(blockedStep.status, "blocked");
    assert.equal(blockedStep.metadata.dispatch_gate_type, "artifact_evidence");
    assert.deepEqual(blockedStep.metadata.artifact_expectations.missing_artifact_types, ["verification_report"]);
    assert.equal(dispatched.dispatched_count, 1);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent.report_result can auto-continue execute-bounded goals into downstream worker steps", async () => {
  const testId = `${Date.now()}-agent-goal-autorun`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-agent-goal-autorun-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open", () => mutationCounter++),
      session_id: "agent-goal-autorun-session",
      agent_id: "codex",
      display_name: "Goal autorun worker",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      lease_seconds: 120,
      status: "active",
      capabilities: {
        worker: true,
      },
    });

    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Agent goal autorun",
      objective: "Continue into the next step after the first worker finishes",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A completed worker step can dispatch its downstream step automatically"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Goal autorun plan",
      summary: "Use two dependent worker steps so the second should dispatch after the first report",
      selected: true,
      steps: [
        {
          step_id: "step-a",
          seq: 1,
          title: "Run the first worker step",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Complete the first bounded worker step",
            project_dir: REPO_ROOT,
          },
        },
        {
          step_id: "step-b",
          seq: 2,
          title: "Run the second worker step",
          step_kind: "mutation",
          executor_kind: "worker",
          depends_on: ["step-a"],
          input: {
            objective: "Complete the downstream bounded worker step",
            project_dir: REPO_ROOT,
          },
        },
      ],
    });

    const dispatched = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(dispatched.dispatched_count, 1);

    const claimed = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next", () => mutationCounter++),
      session_id: "agent-goal-autorun-session",
      lease_seconds: 120,
    });
    assert.equal(claimed.claimed, true);

    const reported = await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result", () => mutationCounter++),
      session_id: "agent-goal-autorun-session",
      task_id: claimed.task.task_id,
      outcome: "completed",
      summary: "Completed the first worker step and allow goal autorun",
      result: {
        completed: true,
      },
    });
    assert.equal(reported.reported, true);
    assert.equal(reported.goal_autorun.ok, true);
    assert.equal(reported.goal_autorun.executed_count, 1);

    const continuedPlan = await waitFor(async () => {
      const fetchedPlan = await callTool(client, "plan.get", {
        plan_id: createdPlan.plan.plan_id,
      });
      const stepById = new Map(fetchedPlan.steps.map((step) => [step.step_id, step]));
      const stepA = stepById.get("step-a");
      const stepB = stepById.get("step-b");
      if (stepA?.status !== "completed") {
        return null;
      }
      if (stepB?.status !== "running" || !stepB.task_id) {
        return null;
      }
      return { stepA, stepB };
    });

    assert.equal(continuedPlan.stepA.status, "completed");
    assert.equal(continuedPlan.stepB.status, "running");
    assert.equal(typeof continuedPlan.stepB.task_id, "string");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("artifact and experiment tools persist evidence and judge candidate runs", async () => {
  const testId = `${Date.now()}-artifact-experiment`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-artifact-experiment-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Artifact experiment integration goal",
      objective: "Exercise artifact and experiment runtime primitives",
      status: "active",
      acceptance_criteria: ["Evidence is durable", "Candidate runs can be judged"],
    });

    const baselineArtifact = await callTool(client, "artifact.record", {
      mutation: nextMutation(testId, "artifact.record.baseline", () => mutationCounter++),
      artifact_type: "benchmark.baseline",
      producer_kind: "tool",
      goal_id: createdGoal.goal.goal_id,
      trust_tier: "verified",
      content_json: {
        latency_ms: 100,
        sample_size: 20,
      },
      related_entities: [
        {
          entity_type: "goal",
          entity_id: createdGoal.goal.goal_id,
        },
      ],
    });
    assert.equal(baselineArtifact.created, true);

    const fetchedBaselineArtifact = await callTool(client, "artifact.get", {
      artifact_id: baselineArtifact.artifact.artifact_id,
    });
    assert.equal(fetchedBaselineArtifact.found, true);
    assert.equal(fetchedBaselineArtifact.artifact.artifact_id, baselineArtifact.artifact.artifact_id);
    assert.ok(
      fetchedBaselineArtifact.links.some(
        (link) => link.dst_entity_type === "goal" && link.dst_entity_id === createdGoal.goal.goal_id
      )
    );

    const goalArtifacts = await callTool(client, "artifact.list", {
      goal_id: createdGoal.goal.goal_id,
      limit: 20,
    });
    assert.ok(goalArtifacts.count >= 1);
    assert.ok(goalArtifacts.artifacts.some((artifact) => artifact.artifact_id === baselineArtifact.artifact.artifact_id));

    const goalBundle = await callTool(client, "artifact.bundle", {
      entity: {
        entity_type: "goal",
        entity_id: createdGoal.goal.goal_id,
      },
      limit: 20,
    });
    assert.equal(goalBundle.found, true);
    assert.ok(goalBundle.artifacts.some((artifact) => artifact.artifact_id === baselineArtifact.artifact.artifact_id));

    const createdExperiment = await callTool(client, "experiment.create", {
      mutation: nextMutation(testId, "experiment.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Latency improvement experiment",
      objective: "Find a candidate that improves latency over the current baseline",
      hypothesis: "A tighter execution path reduces latency",
      status: "draft",
      metric_name: "latency_ms",
      metric_direction: "minimize",
      baseline_metric: 100,
      acceptance_delta: 5,
      parse_strategy: {
        metric_path: "latency_ms",
      },
      rollback_strategy: {
        strategy: "restore-baseline",
      },
      candidate_scope: {
        path: "src/",
      },
      tags: ["experiment", "latency"],
    });
    assert.equal(createdExperiment.created, true);
    assert.equal(createdExperiment.experiment.metric_name, "latency_ms");
    assert.equal(createdExperiment.experiment.current_best_metric, 100);

    const startedRun = await callTool(client, "experiment.run", {
      mutation: nextMutation(testId, "experiment.run", () => mutationCounter++),
      experiment_id: createdExperiment.experiment.experiment_id,
      candidate_label: "candidate-a",
      dispatch_mode: "task",
      objective: "Benchmark candidate A for latency improvement",
      project_dir: REPO_ROOT,
      priority: 4,
      task_tags: ["experiment", "candidate-a"],
      payload: {
        candidate: "a",
      },
      artifact_ids: [baselineArtifact.artifact.artifact_id],
    });
    assert.equal(startedRun.experiment_run.status, "running");
    assert.equal(typeof startedRun.task.task_id, "string");
    assert.equal(startedRun.experiment.status, "active");

    const pendingTasks = await callTool(client, "task.list", {
      status: "pending",
      limit: 20,
    });
    assert.ok(pendingTasks.tasks.some((task) => task.task_id === startedRun.task.task_id));

    const resultArtifact = await callTool(client, "artifact.record", {
      mutation: nextMutation(testId, "artifact.record.result", () => mutationCounter++),
      artifact_type: "benchmark.result",
      producer_kind: "worker",
      task_id: startedRun.task.task_id,
      trust_tier: "raw",
      content_json: {
        latency_ms: 90,
        sample_size: 20,
      },
      related_entities: [
        {
          entity_type: "task",
          entity_id: startedRun.task.task_id,
        },
      ],
    });
    assert.equal(resultArtifact.created, true);

    const explicitArtifactLink = await callTool(client, "artifact.link", {
      mutation: nextMutation(testId, "artifact.link", () => mutationCounter++),
      src_artifact_id: resultArtifact.artifact.artifact_id,
      dst_artifact_id: baselineArtifact.artifact.artifact_id,
      relation: "derived_from",
    });
    assert.equal(explicitArtifactLink.created, true);
    assert.equal(explicitArtifactLink.link.src_artifact_id, resultArtifact.artifact.artifact_id);
    assert.equal(explicitArtifactLink.link.dst_artifact_id, baselineArtifact.artifact.artifact_id);

    const judgedRun = await callTool(client, "experiment.judge", {
      mutation: nextMutation(testId, "experiment.judge", () => mutationCounter++),
      experiment_id: createdExperiment.experiment.experiment_id,
      experiment_run_id: startedRun.experiment_run.experiment_run_id,
      observed_metric: 90,
      observed_metrics: {
        latency_ms: 90,
      },
      artifact_ids: [resultArtifact.artifact.artifact_id],
      summary: "Candidate A improved latency by ten milliseconds",
    });
    assert.equal(judgedRun.ok, true);
    assert.equal(judgedRun.verdict, "accepted");
    assert.equal(judgedRun.accepted, true);
    assert.equal(judgedRun.delta, 10);
    assert.equal(judgedRun.experiment.current_best_metric, 90);
    assert.equal(judgedRun.experiment.selected_run_id, startedRun.experiment_run.experiment_run_id);

    const experimentEvents = await callTool(client, "event.tail", {
      entity_type: "experiment",
      entity_id: createdExperiment.experiment.experiment_id,
      limit: 20,
    });
    assert.ok(experimentEvents.events.some((event) => event.event_type === "experiment.created"));

    const experimentRunEvents = await callTool(client, "event.tail", {
      entity_type: "experiment_run",
      entity_id: startedRun.experiment_run.experiment_run_id,
      limit: 20,
    });
    assert.ok(experimentRunEvents.events.some((event) => event.event_type === "experiment.run_started"));
    assert.ok(experimentRunEvents.events.some((event) => event.event_type === "experiment.run_judged"));

    const fetchedExperiment = await callTool(client, "experiment.get", {
      experiment_id: createdExperiment.experiment.experiment_id,
      run_limit: 10,
    });
    assert.equal(fetchedExperiment.found, true);
    assert.equal(fetchedExperiment.run_count, 1);
    assert.equal(fetchedExperiment.selected_run.experiment_run_id, startedRun.experiment_run.experiment_run_id);
    assert.equal(fetchedExperiment.runs[0].verdict, "accepted");

    const listedExperiments = await callTool(client, "experiment.list", {
      goal_id: createdGoal.goal.goal_id,
      limit: 10,
    });
    assert.ok(listedExperiments.count >= 1);
    assert.ok(
      listedExperiments.experiments.some(
        (experiment) => experiment.experiment_id === createdExperiment.experiment.experiment_id
      )
    );

    const experimentArtifacts = await callTool(client, "artifact.list", {
      linked_entity: {
        entity_type: "experiment",
        entity_id: createdExperiment.experiment.experiment_id,
      },
      limit: 20,
    });
    assert.ok(
      experimentArtifacts.artifacts.some((artifact) => artifact.artifact_id === baselineArtifact.artifact.artifact_id)
    );
    assert.ok(
      experimentArtifacts.artifacts.some((artifact) => artifact.artifact_id === resultArtifact.artifact.artifact_id)
    );

    const experimentBundle = await callTool(client, "artifact.bundle", {
      entity: {
        entity_type: "experiment",
        entity_id: createdExperiment.experiment.experiment_id,
      },
      limit: 20,
    });
    assert.equal(experimentBundle.found, true);
    assert.ok(
      experimentBundle.artifacts.some((artifact) => artifact.artifact_id === resultArtifact.artifact.artifact_id)
    );
    assert.ok(
      experimentBundle.links.some(
        (link) =>
          link.dst_entity_type === "experiment" &&
          link.dst_entity_id === createdExperiment.experiment.experiment_id &&
          link.src_artifact_id === resultArtifact.artifact.artifact_id
      )
    );

    const resultArtifactGraph = await callTool(client, "artifact.get", {
      artifact_id: resultArtifact.artifact.artifact_id,
    });
    assert.equal(resultArtifactGraph.found, true);
    assert.ok(
      resultArtifactGraph.links.some(
        (link) =>
          link.src_artifact_id === resultArtifact.artifact.artifact_id &&
          link.dst_artifact_id === baselineArtifact.artifact.artifact_id &&
          link.relation === "derived_from"
      )
    );
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent.report_result derives experiment metrics from structured worker output", async () => {
  const testId = `${Date.now()}-experiment-derived-metric`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-experiment-derived-metric-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    await callTool(client, "agent.session_open", {
      mutation: nextMutation(testId, "agent.session_open", () => mutationCounter++),
      session_id: "experiment-derived-metric-session",
      agent_id: "codex",
      display_name: "Experiment worker",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      lease_seconds: 120,
      status: "active",
      capabilities: {
        worker: true,
      },
    });

    const createdExperiment = await callTool(client, "experiment.create", {
      mutation: nextMutation(testId, "experiment.create", () => mutationCounter++),
      title: "Derived metric experiment",
      objective: "Allow structured worker output to drive experiment judgment automatically",
      metric_name: "latency_ms",
      metric_direction: "minimize",
      baseline_metric: 100,
      acceptance_delta: 5,
      parse_strategy: {
        path: "metrics.latency_ms",
      },
    });

    const startedRun = await callTool(client, "experiment.run", {
      mutation: nextMutation(testId, "experiment.run", () => mutationCounter++),
      experiment_id: createdExperiment.experiment.experiment_id,
      candidate_label: "candidate-a",
      dispatch_mode: "task",
      project_dir: REPO_ROOT,
    });
    assert.equal(startedRun.task_created, true);

    const claimed = await callTool(client, "agent.claim_next", {
      mutation: nextMutation(testId, "agent.claim_next", () => mutationCounter++),
      session_id: "experiment-derived-metric-session",
      lease_seconds: 120,
    });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.task.task_id, startedRun.task.task_id);

    const reported = await callTool(client, "agent.report_result", {
      mutation: nextMutation(testId, "agent.report_result", () => mutationCounter++),
      session_id: "experiment-derived-metric-session",
      task_id: startedRun.task.task_id,
      outcome: "completed",
      summary: "Worker benchmark completed with latency_ms: 92",
      result: {
        metrics: {
          latency_ms: 92,
        },
      },
    });
    assert.equal(reported.reported, true);
    assert.equal(reported.experiment.ok, true);
    assert.equal(reported.experiment.observed_metric, 92);
    assert.equal(reported.experiment.verdict, "accepted");

    const fetchedExperiment = await callTool(client, "experiment.get", {
      experiment_id: createdExperiment.experiment.experiment_id,
      run_limit: 10,
    });
    assert.equal(fetchedExperiment.selected_run.observed_metric, 92);
    assert.equal(fetchedExperiment.selected_run.metadata.observed_metric_source, "result.path:metrics.latency_ms");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plan.approve and plan.resume unblock a human gate before dispatching downstream work", async () => {
  const testId = `${Date.now()}-approve-resume`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-approve-resume-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Approval integration goal",
      objective: "Exercise the approval and resume tools",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Human-gated work can resume into downstream execution"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Approval-controlled execution plan",
      summary: "Gate one step behind a human approval before handing off to a worker",
      selected: true,
      steps: [
        {
          step_id: "human-gate",
          seq: 1,
          title: "Approve the plan gate",
          step_kind: "handoff",
          executor_kind: "human",
          metadata: {
            human_approval_required: true,
          },
          input: {
            approval_summary: "Approve this plan before the worker stage is resumed.",
          },
        },
        {
          step_id: "downstream-worker",
          seq: 2,
          title: "Run the downstream worker",
          step_kind: "mutation",
          executor_kind: "worker",
          depends_on: ["human-gate"],
          input: {
            objective: "Downstream worker after approval",
            project_dir: ".",
            priority: 4,
            tags: ["approval", "resume"],
            payload: {
              lane: "worker",
            },
          },
        },
      ],
    });

    const readinessBefore = await callTool(client, "plan.step_ready", {
      plan_id: createdPlan.plan.plan_id,
    });
    const humanGateBefore = readinessBefore.readiness.find((step) => step.step_id === "human-gate");
    const workerBefore = readinessBefore.readiness.find((step) => step.step_id === "downstream-worker");
    assert.equal(humanGateBefore.ready, false);
    assert.equal(humanGateBefore.gate_reason, "human_approval_required");
    assert.deepEqual(workerBefore.blocked_by.map((step) => step.step_id), ["human-gate"]);

    await callTool(client, "plan.approve", {
      mutation: nextMutation(testId, "plan.approve", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
      step_id: "human-gate",
      summary: "Human approval granted for the gate step",
    });

    await callTool(client, "plan.resume", {
      mutation: nextMutation(testId, "plan.resume", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });

    const planState = await waitFor(async () => {
      const fetchedPlan = await callTool(client, "plan.get", {
        plan_id: createdPlan.plan.plan_id,
      });
      const stepById = new Map(fetchedPlan.steps.map((step) => [step.step_id, step]));
      const humanGate = stepById.get("human-gate");
      const downstreamWorker = stepById.get("downstream-worker");
      if (humanGate.status !== "completed") {
        return null;
      }
      if (downstreamWorker.status !== "running" || !downstreamWorker.task_id) {
        return null;
      }
      const taskList = await callTool(client, "task.list", {
        status: "pending",
        limit: 20,
      });
      const task = taskList.tasks.find((entry) => entry.task_id === downstreamWorker.task_id);
      if (!task) {
        return null;
      }
      return { fetchedPlan, humanGate, downstreamWorker, task };
    });

    assert.equal(planState.humanGate.status, "completed");
    assert.equal(planState.downstreamWorker.status, "running");
    assert.equal(planState.task.task_id, planState.downstreamWorker.task_id);
    assert.equal(planState.task.objective, "Downstream worker after approval");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("strict policy gates mutation steps until approval while execute-bounded plans dispatch immediately", async () => {
  const testId = `${Date.now()}-policy-approval`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-policy-approval-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const strictGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create.strict", () => mutationCounter++),
      title: "Strict approval goal",
      objective: "Require approval before a mutation step is dispatched",
      status: "active",
      autonomy_mode: "execute_destructive_with_approval",
      acceptance_criteria: ["Mutation execution requires an explicit approval gate"],
    });

    const strictPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.strict", () => mutationCounter++),
      goal_id: strictGoal.goal.goal_id,
      title: "Strict policy plan",
      summary: "Block mutation work behind a policy-backed approval gate",
      selected: true,
      steps: [
        {
          step_id: "policy-worker",
          seq: 1,
          title: "Dispatch the mutation worker only after approval",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Policy-gated worker execution",
            project_dir: ".",
            priority: 5,
            tags: ["policy", "strict"],
          },
        },
      ],
    });

    const strictDispatch = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch.strict", () => mutationCounter++),
      plan_id: strictPlan.plan.plan_id,
    });
    assert.equal(strictDispatch.blocked_count, 1);
    assert.equal(strictDispatch.dispatched_count, 0);
    assert.equal(strictDispatch.results[0].action, "approval_required");
    assert.equal(strictDispatch.results[0].gate_type, "policy");
    assert.equal(strictDispatch.results[0].policy_profile, "strict");

    const blockedStrictPlan = await callTool(client, "plan.get", {
      plan_id: strictPlan.plan.plan_id,
    });
    const blockedStrictStep = blockedStrictPlan.steps.find((step) => step.step_id === "policy-worker");
    assert.equal(blockedStrictStep.status, "blocked");
    assert.equal(blockedStrictStep.metadata.dispatch_gate_type, "policy");
    assert.equal(blockedStrictStep.metadata.human_approval_required, true);
    assert.equal(blockedStrictStep.metadata.policy_profile, "strict");

    const approvedStrictGate = await callTool(client, "plan.approve", {
      mutation: nextMutation(testId, "plan.approve.strict", () => mutationCounter++),
      plan_id: strictPlan.plan.plan_id,
      step_id: "policy-worker",
      summary: "Approve mutation dispatch under the strict policy profile",
    });
    assert.equal(approvedStrictGate.step.status, "pending");
    assert.equal(approvedStrictGate.step.metadata.dispatch_gate_type, null);
    assert.equal(approvedStrictGate.step.metadata.approval.gate_type, "policy");

    await callTool(client, "plan.resume", {
      mutation: nextMutation(testId, "plan.resume.strict", () => mutationCounter++),
      plan_id: strictPlan.plan.plan_id,
    });

    const resumedStrictPlan = await waitFor(async () => {
      const fetchedPlan = await callTool(client, "plan.get", {
        plan_id: strictPlan.plan.plan_id,
      });
      const step = fetchedPlan.steps.find((candidate) => candidate.step_id === "policy-worker");
      if (step.status !== "running" || !step.task_id) {
        return null;
      }
      return {
        step,
        fetchedPlan,
      };
    });
    assert.equal(resumedStrictPlan.step.status, "running");
    assert.equal(typeof resumedStrictPlan.step.task_id, "string");

    const boundedGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create.bounded", () => mutationCounter++),
      title: "Bounded execution goal",
      objective: "Allow bounded mutation work to dispatch without a policy gate",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Mutation execution dispatches directly in bounded mode"],
    });

    const boundedPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create.bounded", () => mutationCounter++),
      goal_id: boundedGoal.goal.goal_id,
      title: "Bounded execution plan",
      summary: "Dispatch the worker directly when the policy profile is bounded",
      selected: true,
      steps: [
        {
          step_id: "bounded-worker",
          seq: 1,
          title: "Dispatch the bounded worker",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Bounded worker execution",
            project_dir: ".",
            priority: 5,
            tags: ["policy", "bounded"],
          },
        },
      ],
    });

    const boundedDispatch = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch.bounded", () => mutationCounter++),
      plan_id: boundedPlan.plan.plan_id,
    });
    assert.equal(boundedDispatch.blocked_count, 0);
    assert.equal(boundedDispatch.dispatched_count, 1);
    assert.equal(boundedDispatch.results[0].action, "task_created");
    assert.equal(typeof boundedDispatch.results[0].task_id, "string");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dispatch.autorun finalizes TriChat steps before dispatching dependent worker tasks", async () => {
  const testId = `${Date.now()}-autorun`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-autorun-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {
    TRICHAT_BRIDGE_DRY_RUN: "1",
  });
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Autorun integration goal",
      objective: "Exercise dispatch.autorun for TriChat plus worker lanes",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["TriChat steps can finalize before downstream workers are dispatched"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Autorun execution plan",
      summary: "Run a TriChat decision step and then a dependent worker step",
      selected: true,
      steps: [
        {
          step_id: "tri-chat-decision",
          seq: 1,
          title: "Run a TriChat decision",
          step_kind: "decision",
          executor_kind: "trichat",
          input: {
            prompt: "Evaluate the next runtime slice using a dry-run bridge.",
            expected_agents: ["codex", "cursor"],
            min_agents: 2,
          },
        },
        {
          step_id: "worker-after-trichat",
          seq: 2,
          title: "Dispatch the dependent worker",
          step_kind: "mutation",
          executor_kind: "worker",
          depends_on: ["tri-chat-decision"],
          input: {
            objective: "Worker dispatch after TriChat finalization",
            project_dir: ".",
            priority: 5,
            tags: ["autorun", "trichat"],
            payload: {
              lane: "worker",
            },
          },
        },
      ],
    });

    await callTool(client, "dispatch.autorun", {
      mutation: nextMutation(testId, "dispatch.autorun", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });

    const autorunState = await waitFor(async () => {
      const fetchedPlan = await callTool(client, "plan.get", {
        plan_id: createdPlan.plan.plan_id,
      });
      const stepById = new Map(fetchedPlan.steps.map((step) => [step.step_id, step]));
      const trichatStep = stepById.get("tri-chat-decision");
      const workerStep = stepById.get("worker-after-trichat");
      if (trichatStep.status !== "completed") {
        return null;
      }
      if (workerStep.status !== "running" || !workerStep.task_id) {
        return null;
      }

      const trichatTurn = await callTool(client, "trichat.turn_get", {
        turn_id: trichatStep.executor_ref,
      });
      if (!trichatTurn.found || trichatTurn.turn.status !== "completed" || trichatTurn.turn.phase_status !== "completed") {
        return null;
      }

      const taskList = await callTool(client, "task.list", {
        status: "pending",
        limit: 20,
      });
      const workerTask = taskList.tasks.find((task) => task.task_id === workerStep.task_id);
      if (!workerTask) {
        return null;
      }

      return { fetchedPlan, trichatStep, workerStep, trichatTurn, workerTask };
    });

    assert.equal(autorunState.trichatStep.status, "completed");
    assert.equal(typeof autorunState.trichatStep.executor_ref, "string");
    assert.equal(autorunState.workerStep.status, "running");
    assert.equal(autorunState.workerTask.task_id, autorunState.workerStep.task_id);
    assert.equal(autorunState.workerTask.objective, "Worker dispatch after TriChat finalization");
    assert.equal(autorunState.trichatTurn.turn.status, "completed");
    assert.equal(autorunState.trichatTurn.turn.phase_status, "completed");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plan.dispatch routes ready steps into tool, worker, TriChat, and human execution lanes", async () => {
  const testId = `${Date.now()}-dispatch`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-dispatch-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {});
  try {
    const createdGoal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Dispatch integration goal",
      objective: "Exercise plan.dispatch across execution lanes",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["Each executor lane is reachable from a durable plan"],
    });

    const createdPlan = await callTool(client, "plan.create", {
      mutation: nextMutation(testId, "plan.create", () => mutationCounter++),
      goal_id: createdGoal.goal.goal_id,
      title: "Dispatchable execution plan",
      summary: "Fan out ready steps into the runtime execution lanes",
      selected: true,
      steps: [
        {
          step_id: "tool-goal",
          seq: 1,
          title: "Fetch the goal via MCP",
          step_kind: "analysis",
          executor_kind: "tool",
          tool_name: "goal.get",
          input: {
            goal_id: createdGoal.goal.goal_id,
          },
        },
        {
          step_id: "worker-queue",
          seq: 2,
          title: "Dispatch through task queue",
          step_kind: "mutation",
          executor_kind: "worker",
          input: {
            objective: "Dispatch through task queue",
            project_dir: ".",
            priority: 6,
            tags: ["dispatch", "worker"],
            payload: {
              lane: "worker",
            },
          },
        },
        {
          step_id: "trichat-fanout",
          seq: 3,
          title: "Start a TriChat turn",
          step_kind: "decision",
          executor_kind: "trichat",
          input: {
            prompt: "Compare implementation options for the next runtime slice.",
            expected_agents: ["codex", "cursor"],
            min_agents: 2,
          },
        },
        {
          step_id: "human-gate",
          seq: 4,
          title: "Await human approval",
          step_kind: "handoff",
          executor_kind: "human",
          input: {
            approval_summary: "Manual approval required before applying the next runtime patch.",
          },
        },
      ],
    });

    const dispatched = await callTool(client, "plan.dispatch", {
      mutation: nextMutation(testId, "plan.dispatch", () => mutationCounter++),
      plan_id: createdPlan.plan.plan_id,
    });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.considered_count, 4);
    assert.equal(dispatched.dispatched_count, 3);
    assert.equal(dispatched.completed_count, 1);
    assert.equal(dispatched.running_count, 2);
    assert.equal(dispatched.blocked_count, 1);
    assert.equal(dispatched.failed_count, 0);

    const resultByStepId = new Map(dispatched.results.map((result) => [result.step_id, result]));

    const toolDispatch = resultByStepId.get("tool-goal");
    assert.equal(toolDispatch.dispatched, true);
    assert.equal(toolDispatch.action, "tool_invoked");
    assert.equal(toolDispatch.tool_name, "goal.get");
    assert.equal(toolDispatch.tool_result.found, true);
    assert.equal(toolDispatch.tool_result.goal.goal_id, createdGoal.goal.goal_id);

    const workerDispatch = resultByStepId.get("worker-queue");
    assert.equal(workerDispatch.dispatched, true);
    assert.equal(workerDispatch.action, "task_created");
    assert.equal(typeof workerDispatch.task_id, "string");

    const trichatDispatch = resultByStepId.get("trichat-fanout");
    assert.equal(trichatDispatch.dispatched, true);
    assert.equal(trichatDispatch.action, "trichat_turn_started");
    assert.equal(typeof trichatDispatch.thread_id, "string");
    assert.equal(typeof trichatDispatch.turn_id, "string");

    const humanDispatch = resultByStepId.get("human-gate");
    assert.equal(humanDispatch.dispatched, false);
    assert.equal(humanDispatch.action, "approval_required");
    assert.equal(humanDispatch.gate_type, "human");
    assert.equal(humanDispatch.requires_human_approval, true);

    const planFetch = await callTool(client, "plan.get", {
      plan_id: createdPlan.plan.plan_id,
    });
    const stepById = new Map(planFetch.steps.map((step) => [step.step_id, step]));
    assert.equal(stepById.get("tool-goal").status, "completed");
    assert.equal(stepById.get("worker-queue").status, "running");
    assert.equal(stepById.get("worker-queue").task_id, workerDispatch.task_id);
    assert.equal(stepById.get("trichat-fanout").status, "running");
    assert.equal(stepById.get("trichat-fanout").executor_ref, trichatDispatch.turn_id);
    assert.equal(stepById.get("human-gate").status, "blocked");
    assert.equal(stepById.get("human-gate").metadata.human_approval_required, true);

    const pendingTasks = await callTool(client, "task.list", {
      status: "pending",
      limit: 20,
    });
    assert.ok(
      pendingTasks.tasks.some(
        (task) => task.task_id === workerDispatch.task_id && task.objective === "Dispatch through task queue"
      )
    );

    const thread = await callTool(client, "trichat.thread_get", {
      thread_id: trichatDispatch.thread_id,
    });
    assert.equal(thread.found, true);

    const turn = await callTool(client, "trichat.turn_get", {
      turn_id: trichatDispatch.turn_id,
    });
    assert.equal(turn.found, true);
    assert.equal(turn.turn.phase, "propose");
    assert.equal(turn.turn.phase_status, "running");

    const readinessAfterDispatch = await callTool(client, "plan.step_ready", {
      plan_id: createdPlan.plan.plan_id,
    });
    const humanReadiness = readinessAfterDispatch.readiness.find((step) => step.step_id === "human-gate");
    assert.equal(humanReadiness.ready, false);
    assert.equal(humanReadiness.gate_reason, "human");
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
      TRICHAT_AGENT_IDS: "",
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

async function waitFor(check, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}
