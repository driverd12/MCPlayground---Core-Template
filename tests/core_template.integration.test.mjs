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
    assert.deepEqual(roster.active_agent_ids, ["codex", "cursor", "local-imprint"]);
    assert.equal(Array.isArray(roster.agents), true);
    assert.ok(roster.agents.some((agent) => agent.agent_id === "codex" && agent.active === true));

    const packHooks = await callTool(client, "pack.hooks.list", {});
    assert.equal(packHooks.count, 3);
    assert.ok(packHooks.hooks.some((hook) => hook.hook_id === "agentic.delivery_path"));
    assert.ok(packHooks.hooks.some((hook) => hook.hook_id === "agentic.optimization_loop"));
    assert.ok(packHooks.hooks.some((hook) => hook.hook_id === "agentic.execution_readiness"));

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
    assert.equal(executedGoal.execution_summary.completed_count, 1);
    assert.equal(executedGoal.execution_summary.running_count, 1);
    assert.equal(executedGoal.execution_summary.failed_count, 0);
    assert.match(executedGoal.execution_summary.next_action, /Wait for running tasks or turns to finish/);

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
      autonomy_mode: "recommend",
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
      autonomy_mode: "recommend",
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
      autonomy_mode: "recommend",
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
