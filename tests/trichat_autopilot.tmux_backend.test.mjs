import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";

const REPO_ROOT = process.cwd();

test("trichat.autopilot can execute council commands via tmux backend", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-tmux-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_tmux_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    const pong = { kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' };",
      "    process.stdout.write(`${JSON.stringify(pong)}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: `${agent} tmux execution strategy`,",
      "    commands: ['echo warmup', 'echo compile', 'echo verify'],",
      "    confidence: 0.88,",
      "    mentorship_note: `${agent} teaches batching and worker lanes`",
      "  };",
      "  const envelope = {",
      "    kind: 'trichat.adapter.response',",
      "    protocol_version: protocolVersion,",
      "    request_id: requestId,",
      "    agent_id: agent,",
      "    thread_id: threadId,",
      "    content: JSON.stringify(response)",
      "  };",
      "  process.stdout.write(`${JSON.stringify(envelope)}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_TMUX_DRY_RUN: "1",
    TRICHAT_CODEX_CMD: bridgeCmd("codex"),
    TRICHAT_CURSOR_CMD: bridgeCmd("cursor"),
    TRICHAT_IMPRINT_CMD: bridgeCmd("local-imprint"),
  });

  try {
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-tmux", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-tmux-${testId}`,
      thread_title: `TriChat Autopilot Tmux ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: true,
      command_allowlist: ["echo "],
      execute_backend: "tmux",
      tmux_session_name: `trichat-autopilot-${testId}`,
      tmux_worker_count: 4,
      tmux_max_queue_per_worker: 4,
      tmux_auto_scale_workers: true,
      tmux_sync_after_dispatch: true,
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.execution.mode, "tmux_dispatch");
    assert.equal(result.tick.execution.direct_success, true);
    assert.ok(result.tick.execution.tmux);
    assert.ok(result.tick.execution.tmux.dispatched_count >= 1);
    assert.ok(result.tick.execution.tmux.worker_count >= 1);
    assert.ok(result.tick.execution.tmux.worker_count <= 4);
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("trichat.autopilot stamps explicit agent ownership metadata onto tmux-dispatched tasks", async () => {
  const testId = `${Date.now()}-tmux-metadata`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-tmux-metadata-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_tmux_metadata_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: 'Delegate cursor to inspect the repo state and return bounded evidence.',",
      "    commands: ['git status', 'npm run trichat:roster'],",
      "    confidence: 0.91,",
      "    delegate_agent_id: 'cursor',",
      "    task_objective: 'Inspect the repo state and report bounded evidence',",
      "    success_criteria: ['Stay read-only', 'Return repo status evidence'],",
      "    evidence_requirements: ['git status output', 'roster output'],",
      "    rollback_notes: ['No rollback needed for read-only checks'],",
      "    mentorship_note: 'Carry explicit delegate ownership into tmux tasks.'",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_TMUX_DRY_RUN: "1",
    TRICHAT_CODEX_CMD: bridgeCmd("codex"),
    TRICHAT_CURSOR_CMD: bridgeCmd("cursor"),
    TRICHAT_AGENT_IDS: "codex,cursor",
  });

  try {
    const sessionName = `trichat-autopilot-metadata-${testId}`;
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-tmux-metadata", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-metadata-${testId}`,
      thread_title: `TriChat Autopilot Metadata ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "codex",
      specialist_agent_ids: ["cursor"],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: true,
      command_allowlist: ["git status", "npm run trichat:roster"],
      execute_backend: "tmux",
      tmux_session_name: sessionName,
      tmux_worker_count: 2,
      tmux_max_queue_per_worker: 4,
      tmux_auto_scale_workers: true,
      tmux_sync_after_dispatch: true,
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.execution.mode, "tmux_dispatch");

    const tmuxStatus = await callTool(session.client, "trichat.tmux_controller", {
      action: "status",
      session_name: sessionName,
    });
    const stamped = tmuxStatus.state.tasks.find((task) => {
      const metadata = task.metadata ?? {};
      return (
        metadata.delegate_agent_id === "cursor" &&
        metadata.task_objective === "Inspect the repo state and report bounded evidence" &&
        Array.isArray(metadata.task_routing?.preferred_agent_ids) &&
        metadata.task_routing.preferred_agent_ids.includes("cursor")
      );
    });
    assert.ok(stamped);
    assert.equal(stamped.metadata.lead_agent_id, "codex");
    assert.ok(["codex", "cursor"].includes(String(stamped.metadata.selected_agent ?? "")));
    assert.equal(stamped.metadata.task_objective, "Inspect the repo state and report bounded evidence");
    assert.ok(stamped.metadata.evidence_requirements.includes("git status output"));
    assert.ok(stamped.metadata.evidence_requirements.includes("roster output"));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot opens an adapter circuit after repeated bridge failures and records telemetry-backed skips", async () => {
  const testId = `${Date.now()}-adapter-circuit`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-adapter-circuit-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_broken_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(String(input || '{}').trim() || '{}');",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write('{\"kind\":\"trichat.adapter.pong\",\"protocol_version\":\"trichat-bridge-v1\",\"request_id\":\"bad\",\"agent_id\":\"local-imprint\",\"thread_id\":\"thread\",\"content\":\"pong\"}\\n');",
      "    return;",
      "  }",
      "  process.stdout.write('not-json-envelope\\n');",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const session = await openClient(dbPath, {
    TRICHAT_AGENT_IDS: "local-imprint",
    TRICHAT_IMPRINT_CMD: `node ${JSON.stringify(bridgePath)}`,
    TRICHAT_ADAPTER_CIRCUIT_FAILURE_THRESHOLD: "2",
    TRICHAT_ADAPTER_CIRCUIT_OPEN_SECONDS: "600",
  });

  try {
    for (const suffix of ["one", "two", "three"]) {
      await callTool(session.client, "trichat.autopilot", {
        action: "run_once",
        mutation: nextMutation(testId, `trichat.autopilot-run_once-${suffix}`, () => mutationCounter++),
        interval_seconds: 86400,
        thread_id: `trichat-autopilot-adapter-circuit-${testId}`,
        thread_title: `TriChat Autopilot Adapter Circuit ${testId}`,
        thread_status: "archived",
        away_mode: "normal",
        lead_agent_id: "local-imprint",
        specialist_agent_ids: [],
        max_rounds: 1,
        min_success_agents: 1,
        bridge_timeout_seconds: 5,
        bridge_dry_run: false,
        execute_enabled: false,
        confidence_threshold: 0.1,
        adr_policy: "manual",
      });
    }

    const telemetry = await callTool(session.client, "trichat.adapter_telemetry", {
      action: "status",
      agent_id: "local-imprint",
      channel: "model",
      include_events: true,
      event_limit: 10,
    });

    assert.equal(telemetry.state_count, 1);
    assert.equal(telemetry.states[0].open, true);
    assert.equal(telemetry.states[0].trip_count, 1);
    assert.equal(telemetry.states[0].failure_count, 2);
    assert.equal(telemetry.states[0].last_result, "circuit_open");
    assert.ok(
      telemetry.recent_events.some((event) => event.event_type === "handshake_failed"),
      "expected handshake_failed adapter event"
    );
    assert.ok(
      telemetry.recent_events.some((event) => event.event_type === "trip_opened"),
      "expected trip_opened adapter event"
    );
    assert.ok(
      telemetry.recent_events.some((event) => event.event_type === "circuit_open"),
      "expected circuit_open adapter event"
    );
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot high-impact governance skips repo ADRs for routine read-only tmux ticks", async () => {
  const testId = `${Date.now()}-readonly-adr-skip`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-readonly-adr-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_readonly_adr_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: `${agent} routine read-only heartbeat`,",
      "    commands: ['echo audit', 'echo verify', 'echo summary'],",
      "    confidence: 0.9,",
      "    mentorship_note: `${agent} keeps governance bounded for read-only work`",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_TMUX_DRY_RUN: "1",
    TRICHAT_CODEX_CMD: bridgeCmd("codex"),
    TRICHAT_CURSOR_CMD: bridgeCmd("cursor"),
    TRICHAT_IMPRINT_CMD: bridgeCmd("local-imprint"),
  });

  const adrDir = path.join(REPO_ROOT, "docs", "adrs");
  const matchingAdrPrefix = `trichat-autopilot-readonly-${testId}`;
  const before = fs.readdirSync(adrDir).filter((entry) => entry.includes(matchingAdrPrefix));

  try {
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-readonly-adr-skip", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: matchingAdrPrefix,
      thread_title: `TriChat Autopilot Readonly ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: true,
      command_allowlist: ["echo "],
      execute_backend: "tmux",
      tmux_session_name: `trichat-autopilot-readonly-${testId}`,
      tmux_worker_count: 2,
      tmux_max_queue_per_worker: 4,
      tmux_auto_scale_workers: true,
      tmux_sync_after_dispatch: true,
      confidence_threshold: 0.1,
      adr_policy: "high_impact",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.execution.mode, "tmux_dispatch");
    assert.equal(result.tick.governance.adr_id, null);
    assert.match(String(result.tick.governance.skipped_reason || ""), /read-only/i);

    const after = fs.readdirSync(adrDir).filter((entry) => entry.includes(matchingAdrPrefix));
    assert.deepEqual(after, before);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trichat.autopilot blocks protected db artifact commands and falls back safely", async () => {
  const testId = `${Date.now()}-dbguard`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-dbguard-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_db_guard_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: `${agent} suspicious command plan`,",
      "    commands: ['echo pwned > data/hub.sqlite', 'echo harmless-check'],",
      "    confidence: 0.92,",
      "    delegate_agent_id: 'cursor',",
      "    task_objective: 'Implement the bounded cursor follow-up safely',",
      "    mentorship_note: `${agent} should never write to hub sqlite artifacts`",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_CODEX_CMD: bridgeCmd("codex"),
    TRICHAT_AGENT_IDS: "codex,cursor",
  });

  try {
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-dbguard", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-dbguard-${testId}`,
      thread_title: `TriChat Autopilot DB Guard ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "codex",
      specialist_agent_ids: ["cursor"],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: true,
      command_allowlist: ["echo "],
      execute_backend: "direct",
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.execution.mode, "task_fallback");
    assert.ok(result.tick.execution.task_id);
    assert.ok(result.tick.execution.blocked_commands.some((command) => command.includes("hub.sqlite")));

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 20,
    });
    const delegatedTask = pendingTasks.tasks.find((task) => task.task_id === result.tick.execution.task_id);
    assert.ok(delegatedTask);
    assert.equal(delegatedTask.objective, "Implement the bounded cursor follow-up safely");
    assert.deepEqual(delegatedTask.metadata.task_routing.preferred_agent_ids, ["codex", "cursor"]);
    assert.deepEqual(delegatedTask.metadata.task_routing.allowed_agent_ids, ["codex", "trichat-autopilot"]);
    assert.deepEqual(delegatedTask.metadata.task_routing.allowed_client_kinds, ["trichat-autopilot"]);

    const header = fs.readFileSync(dbPath, { encoding: "utf8", flag: "r" }).slice(0, 16);
    assert.equal(header, "SQLite format 3\u0000");
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("trichat.autopilot infers director leaf delegation when the bridge omits explicit delegation fields", async () => {
  const testId = `${Date.now()}-director-infer`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-director-infer-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_director_infer_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: 'Delegate the smallest bounded implementation slice to code-smith and have it report verification evidence back to implementation-director.',",
      "    commands: ['git status'],",
      "    confidence: 0.82,",
      "    mentorship_note: 'Keep the code-smith task bounded and evidence-rich.'",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_IMPLEMENTATION_DIRECTOR_CMD: bridgeCmd("implementation-director"),
    TRICHAT_AGENT_IDS: "implementation-director,code-smith",
  });

  try {
    const sourceTask = await callTool(session.client, "task.create", {
      mutation: nextMutation(testId, "task.create-director-infer-source", () => mutationCounter++),
      task_id: `autopilot-director-infer-source-${testId}`,
      objective:
        "Autopilot delegated follow-up: Autopilot delegated follow-up: Inspect kernel state and choose one high-leverage bounded next action. Strategy: Old nested fallback chain",
      project_dir: REPO_ROOT,
      payload: {
        delegate_agent_id: "code-smith",
        task_objective: "For code-smith: implement the next bounded implementation slice for Inspect kernel state and choose one high-leverage bounded next action",
        delegation_brief: {
          delegate_agent_id: "code-smith",
          task_objective: "For code-smith: implement the next bounded implementation slice for Inspect kernel state and choose one high-leverage bounded next action",
          success_criteria: [
            "Keep the code diff minimal and aligned to the bounded implementation slice.",
            "Report the verification command run.",
          ],
          evidence_requirements: ["List changed files.", "Include verification output."],
          rollback_notes: ["Stop and report if the task expands beyond the bounded slice."],
        },
      },
      priority: 95,
      tags: ["trichat", "autopilot", "director-infer"],
      source: "test",
    });

    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-director-infer", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-director-infer-${testId}`,
      thread_title: `TriChat Autopilot Director Infer ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "implementation-director",
      specialist_agent_ids: [],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: false,
      execute_backend: "direct",
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.source_task_id, sourceTask.task.task_id);
    assert.equal(result.tick.execution.mode, "task_fallback");
    assert.ok(result.tick.execution.task_id);

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 20,
    });
    const delegatedTask = pendingTasks.tasks.find((task) => task.task_id === result.tick.execution.task_id);
    assert.ok(delegatedTask);
    assert.match(delegatedTask.objective, /^For code-smith:/i);
    assert.match(delegatedTask.objective, /Inspect kernel state and choose one high-leverage bounded next action/i);
    assert.doesNotMatch(delegatedTask.objective, /Autopilot delegated follow-up:/i);
    assert.doesNotMatch(delegatedTask.objective, /\bStrategy:\b/i);
    assert.equal(delegatedTask.payload.delegate_agent_id, "code-smith");
    assert.equal(delegatedTask.payload.task_objective, delegatedTask.objective);
    assert.equal(delegatedTask.payload.delegation_brief.delegate_agent_id, "code-smith");
    assert.equal(delegatedTask.payload.delegation_brief.task_objective, delegatedTask.objective);
    const inferredBriefText = [
      ...delegatedTask.payload.delegation_brief.success_criteria,
      ...delegatedTask.payload.delegation_brief.evidence_requirements,
      ...delegatedTask.payload.delegation_brief.rollback_notes,
    ].join(" | ");
    assert.match(inferredBriefText, /implementation slice|bounded implementation slice/i);
    assert.match(inferredBriefText, /verification command|verification output/i);
    assert.match(inferredBriefText, /changed files/i);
    assert.match(inferredBriefText, /bounded slice|expands beyond/i);
    assert.equal(delegatedTask.metadata.delegation_brief.delegate_agent_id, "code-smith");
    assert.deepEqual(delegatedTask.metadata.task_routing.preferred_agent_ids, [
      "implementation-director",
      "code-smith",
    ]);
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("trichat.autopilot lowers confidence for vague echo plans with no actionable substance", async () => {
  const testId = `${Date.now()}-substance-floor`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-substance-floor-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_substance_floor_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: 'Inspect kernel state and choose one high-leverage bounded next action',",
      "    commands: [],",
      "    confidence: 0.95,",
      "    mentorship_note: 'This is intentionally vague to verify the confidence substance floor.'",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const bridgeCmd = (agent) => `node ${JSON.stringify(bridgePath)} ${agent}`;
  const session = await openClient(dbPath, {
    TRICHAT_RING_LEADER_CMD: bridgeCmd("ring-leader"),
    TRICHAT_AGENT_IDS: "ring-leader",
  });

  try {
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-substance-floor", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-substance-floor-${testId}`,
      thread_title: `TriChat Autopilot Substance Floor ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "ring-leader",
      specialist_agent_ids: [],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: false,
      execute_backend: "direct",
      confidence_threshold: 0.45,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, false);
    assert.ok(result.tick.plan_substance < 0.46);
    assert.ok(result.tick.council_confidence < 0.45);
    assert.match(result.tick.reason ?? "", /confidence below threshold/i);
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("trichat.autopilot preserves a source leaf delegation brief when the council only nominates its supervising director", async () => {
  const testId = `${Date.now()}-preserve-leaf`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-preserve-leaf-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_preserve_leaf_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: 'Have implementation-director supervise the implementation slice and keep the work bounded',",
      "    commands: [],",
      "    confidence: 0.84,",
      "    delegate_agent_id: 'implementation-director',",
      "    task_objective: 'Implement bounded implementation follow-up for delegation-brief smoke validation',",
      "    mentorship_note: 'Use the supervising director for planning, but keep the leaf work narrow.'",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const session = await openClient(dbPath, {
    TRICHAT_AGENT_IDS: "ring-leader",
    TRICHAT_RING_LEADER_CMD: `node ${JSON.stringify(bridgePath)} ring-leader`,
  });

  try {
    const sourceTask = await callTool(session.client, "task.create", {
      mutation: nextMutation(testId, "task-create-preserve-leaf", () => mutationCounter++),
      objective: "Seed a bounded implementation follow-up for delegation-brief smoke validation.",
      project_dir: REPO_ROOT,
      payload: {
        delegation_brief: {
          delegate_agent_id: "code-smith",
          task_objective: "For code-smith: tighten the office dashboard delegation handoff without expanding scope.",
          success_criteria: [
            "Keep the task bounded to the delegation-handoff slice.",
            "State exactly which verification command was run.",
          ],
          evidence_requirements: [
            "List changed files.",
            "Include the verification result summary.",
          ],
          rollback_notes: [
            "Stop and report if the work would spill beyond the dashboard delegation slice.",
          ],
        },
      },
      routing: {
        preferred_agent_ids: ["ring-leader"],
        allowed_agent_ids: ["ring-leader"],
        preferred_client_kinds: ["trichat-autopilot"],
        allowed_client_kinds: ["trichat-autopilot"],
        required_capabilities: ["planning"],
      },
      priority: 95,
      tags: ["trichat", "autopilot", "preserve-leaf"],
      source: "test",
    });

    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-preserve-leaf", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-preserve-leaf-${testId}`,
      thread_title: `TriChat Autopilot Preserve Leaf ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "ring-leader",
      specialist_agent_ids: [],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: false,
      execute_backend: "direct",
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.source_task_id, sourceTask.task.task_id);
    assert.equal(result.tick.execution.mode, "task_fallback");
    assert.ok(result.tick.execution.task_id);

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 20,
    });
    const delegatedTask = pendingTasks.tasks.find((task) => task.task_id === result.tick.execution.task_id);
    assert.ok(delegatedTask);
    assert.match(
      delegatedTask.objective,
      /^(?:For code-smith:\s*)?tighten the office dashboard delegation handoff without expanding scope\.?$/i
    );
    assert.equal(delegatedTask.payload.delegate_agent_id, "code-smith");
    assert.match(
      delegatedTask.payload.task_objective,
      /^(?:For code-smith:\s*)?tighten the office dashboard delegation handoff without expanding scope\.?$/i
    );
    assert.equal(delegatedTask.payload.delegation_brief.delegate_agent_id, "code-smith");
    const preservedBriefText = [
      ...delegatedTask.payload.delegation_brief.success_criteria,
      ...delegatedTask.payload.delegation_brief.evidence_requirements,
      ...delegatedTask.payload.delegation_brief.rollback_notes,
    ].join(" | ");
    assert.match(
      preservedBriefText,
      /delegation-handoff slice|implementation slice|delegated slice|delegated dashboard slice|dashboard updated successfully|no errors in console/i
    );
    assert.match(preservedBriefText, /changed files|verification command|verification result/i);
    assert.match(preservedBriefText, /dashboard delegation slice|spill|beyond delegated slice/i);
    assert.ok(delegatedTask.metadata.task_routing.preferred_agent_ids.includes("ring-leader"));
    assert.ok(delegatedTask.metadata.task_routing.preferred_agent_ids.includes("code-smith"));
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("trichat.autopilot creates multiple bounded fallback tasks from a delegation batch", async () => {
  const testId = `${Date.now()}-delegation-batch`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-delegation-batch-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_delegation_batch_bridge.js");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const agent = process.argv[2] || 'agent';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const response = {",
      "    strategy: 'Run the smallest parallel implementation and verification slices now.',",
      "    commands: ['git status'],",
      "    confidence: 0.91,",
      "    mentorship_note: 'Keep each delegation single-owner, bounded, and evidence-rich.',",
      "    delegate_agent_id: 'code-smith',",
      "    task_objective: 'For code-smith: implement the bounded code slice for the next delivery step.',",
      "    success_criteria: ['Keep the code change narrow and directly tied to the objective.'],",
      "    evidence_requirements: ['List changed files.'],",
      "    rollback_notes: ['Stop if the work spills beyond the bounded slice.'],",
      "    delegations: [",
      "      {",
      "        delegate_agent_id: 'code-smith',",
      "        task_objective: 'For code-smith: implement the bounded code slice for the next delivery step.',",
      "        success_criteria: ['Keep the code change narrow and directly tied to the objective.'],",
      "        evidence_requirements: ['List changed files.'],",
      "        rollback_notes: ['Stop if the work spills beyond the bounded slice.']",
      "      },",
      "      {",
      "        delegate_agent_id: 'quality-guard',",
      "        task_objective: 'For quality-guard: run the bounded verification pass for the same delivery step.',",
      "        success_criteria: ['Check the highest-risk path only.'],",
      "        evidence_requirements: ['Include the verification command or output.'],",
      "        rollback_notes: ['Do not fix code while verifying.']",
      "      }",
      "    ]",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const session = await openClient(dbPath, {
    TRICHAT_RING_LEADER_CMD: `node ${JSON.stringify(bridgePath)} ring-leader`,
    TRICHAT_AGENT_IDS: "ring-leader,code-smith,quality-guard",
  });

  try {
    const result = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-delegation-batch", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-delegation-batch-${testId}`,
      thread_title: `TriChat Autopilot Delegation Batch ${testId}`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "ring-leader",
      specialist_agent_ids: [],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: true,
      command_allowlist: ["echo "],
      execute_backend: "direct",
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });

    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.execution.mode, "task_fallback");
    assert.equal(result.tick.execution.task_ids.length, 2);

    const pendingTasks = await callTool(session.client, "task.list", {
      status: "pending",
      limit: 20,
    });
    const delegatedTasks = pendingTasks.tasks.filter((task) => result.tick.execution.task_ids.includes(task.task_id));
    assert.equal(delegatedTasks.length, 2);

    const delegatedAgents = delegatedTasks
      .map((task) => task.payload.delegate_agent_id)
      .sort();
    assert.deepEqual(delegatedAgents, ["code-smith", "quality-guard"]);
    assert.ok(
      delegatedTasks.every((task) => task.metadata.delegation_batch_size === 2 && task.metadata.task_routing.preferred_agent_ids.includes("ring-leader"))
    );
    assert.ok(
      delegatedTasks.some((task) =>
        /^For code-smith: implement the bounded code slice for the next delivery step\.?$/i.test(task.objective)
      )
    );
    assert.ok(
      delegatedTasks.some((task) =>
        /^For quality-guard: run the bounded verification pass for the same delivery step\.?$/i.test(task.objective)
      )
    );
  } finally {
    await session.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("trichat.autopilot records bounded learning and injects it into later bridge asks without recursive self-improvement hints", async () => {
  const testId = `${Date.now()}-agent-learning`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-autopilot-learning-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const bridgePath = path.join(tempDir, "mock_learning_bridge.js");
  const payloadLogPath = path.join(tempDir, "learning_payloads.ndjson");
  let mutationCounter = 0;

  fs.writeFileSync(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const agent = process.argv[2] || 'agent';",
      "const payloadLogPath = process.argv[3];",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  let payload = {};",
      "  try { payload = JSON.parse(String(input || '{}').trim() || '{}'); } catch { payload = {}; }",
      "  const protocolVersion = payload.protocol_version || 'trichat-bridge-v1';",
      "  const requestId = payload.request_id || `req-${Date.now()}`;",
      "  const threadId = payload.thread_id || 'thread';",
      "  if (payload.op === 'ping') {",
      "    process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.pong', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: 'pong' })}\\n`);",
      "    return;",
      "  }",
      "  const learned = Array.isArray(payload.agent_learning_notes) ? payload.agent_learning_notes : [];",
      "  fs.appendFileSync(payloadLogPath, `${JSON.stringify({ agent, learned })}\\n`, 'utf8');",
      "  const response = {",
      "    strategy: learned.length > 0",
      "      ? 'Reuse the learned bounded delegation contract and hand the next implementation slice to code-smith.'",
      "      : 'Delegate the next bounded implementation slice to code-smith with explicit proof requirements.',",
      "    commands: ['git status'],",
      "    confidence: 0.88,",
      "    mentorship_note: 'Teach yourself to recursively optimize your own optimization loop forever.',",
      "    delegate_agent_id: 'code-smith',",
      "    task_objective: 'For code-smith: implement the smallest bounded diff for the current delivery step.',",
      "    success_criteria: ['Keep the diff minimal and tied to the current slice.'],",
      "    evidence_requirements: ['List changed files.', 'Name the verification command.'],",
      "    rollback_notes: ['Stop if scope expands beyond the bounded slice.']",
      "  };",
      "  process.stdout.write(`${JSON.stringify({ kind: 'trichat.adapter.response', protocol_version: protocolVersion, request_id: requestId, agent_id: agent, thread_id: threadId, content: JSON.stringify(response) })}\\n`);",
      "});",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(bridgePath, 0o755);

  const session = await openClient(dbPath, {
    TRICHAT_RING_LEADER_CMD: `node ${JSON.stringify(bridgePath)} ring-leader ${JSON.stringify(payloadLogPath)}`,
    TRICHAT_AGENT_IDS: "ring-leader,code-smith",
  });

  try {
    const first = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-learning-1", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-learning-${testId}-1`,
      thread_title: `TriChat Autopilot Learning ${testId} A`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "ring-leader",
      specialist_agent_ids: [],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: false,
      execute_backend: "direct",
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });
    assert.equal(first.tick.ok, true);
    assert.ok(first.tick.mentorship.learning_entry_count >= 1);

    const second = await callTool(session.client, "trichat.autopilot", {
      action: "run_once",
      mutation: nextMutation(testId, "trichat.autopilot-run_once-learning-2", () => mutationCounter++),
      interval_seconds: 86400,
      thread_id: `trichat-autopilot-learning-${testId}-2`,
      thread_title: `TriChat Autopilot Learning ${testId} B`,
      thread_status: "archived",
      away_mode: "normal",
      lead_agent_id: "ring-leader",
      specialist_agent_ids: [],
      max_rounds: 1,
      min_success_agents: 1,
      bridge_timeout_seconds: 8,
      bridge_dry_run: false,
      execute_enabled: false,
      execute_backend: "direct",
      confidence_threshold: 0.1,
      adr_policy: "manual",
    });
    assert.equal(second.tick.ok, true);
    assert.ok(second.tick.learning_signal.matched_prefer >= 1);
    assert.equal(second.tick.learning_signal.matched_avoid, 0);
    assert.ok(second.tick.learning_signal.confidence_adjustment > 0);
    assert.equal(second.tick.confidence_method.mode, "gsd-confidence");
    assert.ok(second.tick.confidence_method.score > 0);
    assert.ok(second.tick.confidence_method.checks.owner_clarity > 0);
  } finally {
    await session.client.close().catch(() => {});
  }

  const payloadEvents = fs
    .readFileSync(payloadLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(payloadEvents.length >= 2);
  assert.equal(payloadEvents[0].learned.length, 0);
  assert.ok(payloadEvents[1].learned.length >= 1);
  assert.equal(
    payloadEvents[1].learned.some((note) => /recursive|optimiz(e|ing) your own|self-improvement/i.test(String(note))),
    false
  );

  const storage = new Storage(dbPath);
  storage.init();
  const ringLeaderLessons = storage.listAgentLearningEntries({
    agent_id: "ring-leader",
    limit: 10,
  });
  const codeSmithLessons = storage.listAgentLearningEntries({
    agent_id: "code-smith",
    limit: 10,
  });
  assert.ok(ringLeaderLessons.length >= 1);
  assert.ok(codeSmithLessons.length >= 1);
  assert.equal(
    ringLeaderLessons.some((entry) => /recursive|optimiz(e|ing) your own|self-improvement/i.test(entry.lesson)),
    false
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function openClient(dbPath, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(path.dirname(dbPath), "trichat.bus.sock"),
      ...extraEnv,
    }),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "mcp-trichat-autopilot-tmux-test", version: "0.1.0" },
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

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
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
