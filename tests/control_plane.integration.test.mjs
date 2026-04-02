import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("tool.search discovers registered control-plane tools and kernel exposes the derived catalog", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-tools-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const { client } = await openClient(tempDir, dbPath, {
    MCP_PRIVILEGED_EXEC_DRY_RUN: "1",
    MCP_PRIVILEGED_EXEC_TEST_ACCOUNT_EXISTS: "1",
    MCP_PRIVILEGED_EXEC_TEST_SECRET: "integration-secret",
  });
  try {
    const tools = await listTools(client);
    const names = new Set(tools.map((tool) => tool.name));

    assert.equal(names.has("tool.search"), true);
    assert.equal(names.has("permission.profile"), true);
    assert.equal(names.has("budget.ledger"), true);
    assert.equal(names.has("warm.cache"), true);
    assert.equal(names.has("feature.flag"), true);

    const search = await callTool(client, "tool.search", {
      query: "budget ledger",
      capability_area: "budget",
      tags: ["ledger"],
      limit: 5,
    });
    assert.equal(search.source, "tool.search");
    assert.equal(search.capability_area_filter, "budget");
    assert.equal(search.available_catalog.total_count, tools.length);
    assert.ok(search.results.some((entry) => entry.name === "budget.ledger"));

    const kernel = await callTool(client, "kernel.summary", {});
    assert.ok(kernel.tool_catalog.total_count >= tools.length);
    assert.equal(kernel.overview.tool_catalog.total_count, kernel.tool_catalog.total_count);
    assert.ok(
      kernel.tool_catalog.capability_area_counts.some(
        (entry) => entry.capability_area === "tool" && entry.count >= 1
      )
    );
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session permission profiles resolve through tasks and gate agent worklists", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-permissions-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath);
  try {
    const status = await callTool(client, "permission.profile", {});
    assert.equal(status.source, "permission.profile");
    assert.equal(status.state.default_profile, "bounded_execute");

    const task = await callTool(client, "task.create", {
      mutation: nextMutation("permission-profile", "task.create", () => mutationCounter++),
      objective: "Reach a network provider bridge",
      priority: 90,
      permission_profile: "network_enabled",
      tags: ["network"],
    });

    const session = await callTool(client, "agent.session_open", {
      mutation: nextMutation("permission-profile", "agent.session_open", () => mutationCounter++),
      agent_id: "codex",
      client_kind: "integration-test",
      display_name: "codex read only",
      permission_profile: "read_only",
      status: "idle",
      metadata: {
        thread_id: "ring-leader-main",
      },
    });

    const resolved = await callTool(client, "permission.profile", {
      action: "resolve",
      task_id: task.task.task_id,
    });
    assert.equal(resolved.resolved_profile_id, "network_enabled");
    assert.equal(resolved.chain.task_declared, "network_enabled");

    const worklist = await callTool(client, "agent.worklist", {
      session_id: session.session.session_id,
      include_ineligible: true,
      limit: 10,
    });
    assert.equal(worklist.eligible_count, 0);

    const blocked = worklist.ineligible_tasks.find((entry) => entry.task_id === task.task.task_id);
    assert.ok(blocked);
    assert.equal(blocked.session_permission_profile_id, "read_only");
    assert.equal(blocked.task_permission_profile_id, "network_enabled");
    assert.ok(blocked.blockers.some((entry) => entry.includes("permission_profile_insufficient")));

    const kernel = await callTool(client, "kernel.summary", {});
    assert.ok(
      kernel.permission_profiles.task_counts.some(
        (entry) => entry.profile_id === "network_enabled" && entry.count >= 1
      )
    );
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("budget.ledger records projected, actual, and adjustment usage and surfaces totals to operators", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-budget-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath);
  try {
    const task = await callTool(client, "task.create", {
      mutation: nextMutation("budget-ledger", "task.create", () => mutationCounter++),
      objective: "Track budgeted task execution",
      budget: {
        projected_cost_usd: 1.25,
        token_budget: 300,
        currency: "USD",
      },
      priority: 50,
      tags: ["budget"],
    });

    await callTool(client, "task.claim", {
      mutation: nextMutation("budget-ledger", "task.claim", () => mutationCounter++),
      task_id: task.task.task_id,
      worker_id: "worker-budget",
      lease_seconds: 120,
    });

    await callTool(client, "task.complete", {
      mutation: nextMutation("budget-ledger", "task.complete", () => mutationCounter++),
      task_id: task.task.task_id,
      worker_id: "worker-budget",
      summary: "Task completed within budget",
      usage: {
        provider: "openai",
        model_id: "gpt-5.4",
        tokens_input: 120,
        tokens_output: 80,
        actual_cost_usd: 0.75,
        currency: "USD",
      },
    });

    await callTool(client, "budget.ledger", {
      action: "record",
      mutation: nextMutation("budget-ledger", "budget.ledger.record", () => mutationCounter++),
      ledger_kind: "adjustment",
      entity_type: "task",
      entity_id: task.task.task_id,
      task_id: task.task.task_id,
      usage: {
        actual_cost_usd: 0.05,
        currency: "USD",
        notes: "Manual cost correction",
      },
      notes: "Manual cost correction",
      metadata: {
        reason: "post-hoc adjustment",
      },
    });

    const ledger = await callTool(client, "budget.ledger", {
      action: "list",
      task_id: task.task.task_id,
      limit: 10,
    });
    assert.equal(ledger.count, 3);
    assert.deepEqual(
      new Set(ledger.entries.map((entry) => entry.ledger_kind)),
      new Set(["projection", "actual", "adjustment"])
    );

    const summary = await callTool(client, "budget.ledger", {
      action: "summary",
      task_id: task.task.task_id,
      recent_limit: 5,
    });
    assert.equal(summary.summary.total_entries, 3);
    assert.equal(summary.summary.projected_cost_usd, 1.25);
    assert.equal(summary.summary.actual_cost_usd, 0.8);
    assert.equal(summary.summary.tokens_total, 500);

    const kernel = await callTool(client, "kernel.summary", {});
    assert.equal(kernel.budget_ledger.total_entries, 3);
    assert.equal(kernel.budget_ledger.projected_cost_usd, 1.25);
    assert.equal(kernel.budget_ledger.actual_cost_usd, 0.8);

    const brief = await callTool(client, "operator.brief", {
      thread_id: "ring-leader-main",
      include_kernel: true,
      include_runtime_brief: false,
      include_compile_brief: false,
      compact: true,
    });
    assert.equal(brief.control_plane_summary.budget_ledger.total_entries, 3);
    assert.equal(brief.control_plane_summary.budget_ledger.actual_cost_usd, 0.8);
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("warm.cache runs a startup-prefetch lane and serves cached office snapshots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-warm-cache-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath);
  try {
    const status = await callTool(client, "warm.cache", {});
    assert.equal(status.source, "warm.cache");
    assert.equal(status.state.enabled, true);

    const warmed = await callTool(client, "warm.cache", {
      action: "run_once",
      mutation: nextMutation("warm-cache", "warm.cache.run_once", () => mutationCounter++),
      thread_id: "ring-leader-main",
    });
    assert.equal(warmed.skipped, false);
    assert.ok(warmed.results.some((entry) => entry.target === "office.snapshot"));
    assert.ok(warmed.results.some((entry) => entry.target === "kernel.summary"));

    const snapshot = await callTool(client, "office.snapshot", {
      thread_id: "ring-leader-main",
    });
    assert.equal(snapshot.cache.hit, true);
    assert.equal(snapshot.cache.key, "office.snapshot:ring-leader-main");

    const kernel = await callTool(client, "kernel.summary", {});
    assert.equal(kernel.warm_cache.state.enabled, true);
    assert.ok(kernel.warm_cache.runtime.entry_count >= warmed.results.length);
    assert.equal(kernel.overview.warm_cache.enabled, true);
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feature.flag drives explicit rollout decisions for operator and permission-profile behavior", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-flags-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath);
  try {
    const task = await callTool(client, "task.create", {
      mutation: nextMutation("feature-flag", "task.create", () => mutationCounter++),
      objective: "Reach a network-only task",
      permission_profile: "network_enabled",
      priority: 80,
      tags: ["network"],
    });

    const session = await callTool(client, "agent.session_open", {
      mutation: nextMutation("feature-flag", "agent.session_open", () => mutationCounter++),
      agent_id: "codex",
      client_kind: "integration-test",
      display_name: "codex read only",
      permission_profile: "read_only",
      status: "idle",
    });

    const before = await callTool(client, "agent.worklist", {
      session_id: session.session.session_id,
      include_ineligible: true,
      limit: 10,
    });
    assert.equal(before.eligible_count, 0);

    await callTool(client, "feature.flag", {
      action: "set",
      mutation: nextMutation("feature-flag", "feature.flag.set", () => mutationCounter++),
      flags: [
        {
          flag_id: "control_plane.permission_profiles",
          rollout_mode: "disabled",
        },
        {
          flag_id: "operator.tool_discovery",
          rollout_mode: "disabled",
        },
      ],
    });

    const evaluation = await callTool(client, "feature.flag", {
      action: "evaluate",
      flag_id: "control_plane.permission_profiles",
      entity_id: task.task.task_id,
      agent_id: "codex",
      tags: ["network"],
    });
    assert.equal(evaluation.evaluation.enabled, false);

    const after = await callTool(client, "agent.worklist", {
      session_id: session.session.session_id,
      include_ineligible: true,
      limit: 10,
    });
    assert.equal(after.eligible_count, 1);
    assert.equal(after.tasks[0].task_id, task.task.task_id);

    const kernel = await callTool(client, "kernel.summary", {});
    assert.equal(kernel.tool_catalog, null);
    assert.ok(kernel.feature_flags.disabled_count >= 2);

    const brief = await callTool(client, "operator.brief", {
      thread_id: "ring-leader-main",
      include_kernel: true,
      include_runtime_brief: false,
      include_compile_brief: false,
      compact: true,
    });
    assert.ok(brief.control_plane_summary.feature_flags.disabled_count >= 2);
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("patient.zero arms and disarms explicit elevated local control with an operator-visible report", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-patient-zero-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath, {
    MCP_PRIVILEGED_EXEC_DRY_RUN: "1",
    MCP_PRIVILEGED_EXEC_TEST_ACCOUNT_EXISTS: "1",
    MCP_PRIVILEGED_EXEC_TEST_SECRET: "integration-secret",
  });
  try {
    const initial = await callTool(client, "patient.zero", {
      action: "status",
    });
    assert.equal(initial.state.enabled, false);
    assert.equal(initial.summary.posture, "standby");
    assert.equal(initial.state.permission_profile, "high_risk");
    assert.equal(initial.report.scope_notice.includes("self-report"), true);

    const armed = await callTool(client, "patient.zero", {
      action: "enable",
      mutation: nextMutation("patient-zero", "patient.zero.enable", () => mutationCounter++),
      operator_note: "Taking over while the operator steps away.",
      source_client: "integration-test",
      source_agent: "operator",
    });
    assert.equal(armed.state.enabled, true);
    assert.equal(armed.summary.posture, "armed");
    assert.equal(typeof armed.summary.browser_ready, "boolean");
    assert.equal(armed.summary.root_shell_enabled, true);
    assert.equal(armed.summary.autonomous_control_enabled, true);
    assert.equal(armed.summary.full_control_authority, false);
    assert.equal(armed.summary.last_operator_note, "Taking over while the operator steps away.");
    assert.equal(armed.desktop_control.state.enabled, true);
    assert.equal(armed.desktop_control.state.allow_observe, true);
    assert.equal(armed.desktop_control.state.allow_act, true);
    assert.equal(armed.desktop_control.state.allow_listen, true);
    assert.equal(armed.autonomy_control.maintain.self_drive_enabled, true);
    assert.equal(armed.autonomy_control.autopilot.execute_enabled, true);
    assert.equal(armed.report.activity_summary.length >= 0, true);

    const maintain = await callTool(client, "autonomy.maintain", {
      action: "status",
    });
    assert.equal(maintain.self_drive.enabled, true);

    const autopilot = await callTool(client, "trichat.autopilot", {
      action: "status",
    });
    assert.equal(autopilot.config.execute_enabled, true);

    const kernel = await callTool(client, "kernel.summary", {});
    assert.equal(kernel.patient_zero.summary.enabled, true);
    assert.equal(kernel.overview.patient_zero.posture, "armed");
    assert.equal(kernel.overview.patient_zero.autonomy_enabled, true);

    const disarmed = await callTool(client, "patient.zero", {
      action: "disable",
      mutation: nextMutation("patient-zero", "patient.zero.disable", () => mutationCounter++),
      operator_note: "Operator back at the keyboard.",
      source_client: "integration-test",
      source_agent: "operator",
    });
    assert.equal(disarmed.state.enabled, false);
    assert.equal(disarmed.summary.posture, "standby");
    assert.equal(disarmed.desktop_control.state.enabled, false);
    assert.equal(disarmed.desktop_control.state.allow_observe, false);
    assert.equal(disarmed.desktop_control.state.allow_act, false);
    assert.equal(disarmed.desktop_control.state.allow_listen, false);
    assert.equal(disarmed.summary.autonomous_control_enabled, false);
    assert.equal(disarmed.autonomy_control.maintain.self_drive_enabled, false);
    assert.equal(disarmed.autonomy_control.autopilot.execute_enabled, false);
    assert.equal(disarmed.summary.last_operator_note, "Operator back at the keyboard.");
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("privileged.exec only runs when Patient Zero is armed and logs every privileged action", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-plane-privileged-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(tempDir, dbPath, {
    MCP_PRIVILEGED_EXEC_DRY_RUN: "1",
    MCP_PRIVILEGED_EXEC_TEST_ACCOUNT_EXISTS: "1",
    MCP_PRIVILEGED_EXEC_TEST_SECRET: "integration-secret",
  });
  try {
    const initial = await callTool(client, "privileged.exec", {
      action: "status",
    });
    assert.equal(initial.summary.account, "mcagent");
    assert.equal(initial.summary.root_execution_ready, false);
    assert.equal(initial.summary.credential_verified, false);
    assert.equal(initial.summary.patient_zero_armed, false);

    await assert.rejects(
      () =>
        callTool(client, "privileged.exec", {
          action: "execute",
          mutation: nextMutation("privileged-exec", "privileged.exec.execute.denied", () => mutationCounter++),
          command: "/usr/bin/id",
          args: ["-u"],
          source_agent: "ring-leader",
          source_client: "integration-test",
        }),
      /Patient Zero to be armed|requires Patient Zero to be armed|requires Patient Zero/i
    );

    await callTool(client, "patient.zero", {
      action: "enable",
      mutation: nextMutation("privileged-exec", "patient.zero.enable", () => mutationCounter++),
      source_agent: "operator",
      source_client: "integration-test",
    });

    const armed = await callTool(client, "privileged.exec", {
      action: "status",
    });
    assert.equal(armed.summary.patient_zero_armed, true);
    assert.equal(armed.summary.secret_present, true);
    assert.equal(armed.summary.credential_verified, true);
    assert.equal(armed.summary.root_execution_ready, true);

    const executed = await callTool(client, "privileged.exec", {
      action: "execute",
      mutation: nextMutation("privileged-exec", "privileged.exec.execute", () => mutationCounter++),
      command: "/usr/bin/id",
      args: ["-u"],
      source_agent: "ring-leader",
      source_client: "integration-test",
    });
    assert.equal(executed.execution.ok, true);
    assert.equal(executed.execution.account, "mcagent");
    assert.equal(executed.execution.target_user, "root");

    const deniedEvents = await callTool(client, "event.tail", {
      event_type: "privileged.exec.denied",
      source_agent: "ring-leader",
      limit: 10,
    });
    assert.ok(deniedEvents.events.length >= 1);

    const completedEvents = await callTool(client, "event.tail", {
      event_type: "privileged.exec.completed",
      source_agent: "ring-leader",
      limit: 10,
    });
    assert.ok(completedEvents.events.length >= 1);
    assert.equal(completedEvents.events[0].entity_id, "privileged.access");

    const kernel = await callTool(client, "kernel.summary", {});
    assert.equal(kernel.privileged_access.summary.account, "mcagent");
    assert.equal(kernel.privileged_access.summary.root_execution_ready, true);
  } finally {
    await closeClient(client);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(tempDir, dbPath, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      MCP_NOTIFIER_DRY_RUN: "1",
      TRICHAT_AGENT_IDS: "",
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      ...extraEnv,
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-control-plane-integration-test", version: "0.1.0" },
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

async function closeClient(client) {
  await client.close().catch(() => {});
}

async function listTools(client) {
  const response = await client.listTools();
  return response.tools ?? [];
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

function nextMutation(testId, label, nextCounter) {
  const index = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${index}`,
    side_effect_fingerprint: `${testId}:${label}:${index}`,
  };
}
