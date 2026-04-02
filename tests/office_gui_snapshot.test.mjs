import assert from "node:assert/strict";
import test from "node:test";
import { buildOfficeGuiSnapshot } from "../dist/office_gui_snapshot.js";

test("office gui snapshot reflects provider heartbeat states and self-drive summary", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["gemini", "cursor"],
        agents: [
          { agent_id: "gemini", display_name: "Gemini", coordination_tier: "support", role_lane: "support" },
          { agent_id: "cursor", display_name: "Cursor", coordination_tier: "support", role_lane: "support" },
          {
            agent_id: "github-copilot",
            display_name: "GitHub Copilot",
            coordination_tier: "support",
            role_lane: "support",
          },
        ],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
        self_drive: {
          enabled: true,
          last_run_at: "2026-04-01T17:00:00.000Z",
          last_goal_id: "goal-self-drive-1",
        },
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T17:00:00.000Z",
          cached: true,
          diagnostics: [
            { client_id: "gemini-cli", display_name: "Gemini CLI", status: "connected", detail: "connected" },
            { client_id: "cursor", display_name: "Cursor", status: "connected", detail: "connected" },
            {
              client_id: "github-copilot-cli",
              display_name: "GitHub Copilot CLI",
              status: "disconnected",
              detail: "auth missing",
            },
          ],
        },
      },
    },
    { theme: "dark" }
  );

  const agents = new Map(snapshot.agents.map((entry) => [entry.agent.agent_id, entry]));
  assert.equal(agents.get("gemini")?.evidence_source, "provider_bridge");
  assert.equal(agents.get("gemini")?.state, "ready");
  assert.equal(agents.get("gemini")?.location, "ops");
  assert.equal(agents.get("cursor")?.state, "ready");
  assert.equal(agents.get("github-copilot")?.state, "blocked");
  assert.equal(snapshot.summary.provider_bridge.connected_count, 2);
  assert.equal(snapshot.summary.maintain.self_drive_enabled, true);
  assert.equal(snapshot.summary.maintain.self_drive_last_goal_id, "goal-self-drive-1");
});

test("office gui snapshot surfaces control-plane rollup signals", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["ring-leader"],
        agents: [{ agent_id: "ring-leader", display_name: "Ring Leader", coordination_tier: "lead", role_lane: "ops" }],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
        tool_catalog: { total_count: 123 },
        permission_profiles: { default_profile: "bounded_execute" },
        budget_ledger: { projected_cost_usd: 4.5, actual_cost_usd: 2.25 },
        warm_cache: { state: { enabled: true }, stale: false },
        feature_flags: { disabled_count: 2 },
        desktop_control: {
          summary: {
            enabled: true,
            stale: false,
            observe_ready: true,
            act_ready: true,
            listen_ready: false,
            last_frontmost_app: "Cursor",
          },
        },
        patient_zero: {
          summary: {
            enabled: true,
            posture: "armed",
            severity: "critical",
            permission_profile: "high_risk",
            browser_app: "Safari",
            browser_ready: true,
            root_shell_enabled: true,
            root_shell_reason: "Privileged root lane ready via mcagent.",
            autonomy_enabled: true,
            armed_at: "2026-04-01T17:05:00.000Z",
            armed_by: "operator",
            last_operator_note: "Take over while I step away.",
          },
        },
        privileged_access: {
          summary: {
            root_execution_ready: true,
            credential_verified: true,
            account: "mcagent",
            target_user: "root",
            patient_zero_armed: true,
            secret_present: true,
            helper_ready: true,
            secret_path: "/Users/dan.driver/.codex/secrets/mcagent_admin_password",
            blockers: [],
            last_verified_at: "2026-04-01T17:05:01.000Z",
            last_verification_ok: true,
            last_verification_error: null,
            last_actor: "ring-leader",
            last_command: "pmset sleepnow",
            last_exit_code: 0,
          },
        },
      },
      patient_zero: {
        report: {
          stance: "Armed for operator-visible high-risk local control.",
          priority_pull: "Keep pushing the current objective.",
          concern: "No fresh runtime error spike is visible.",
          desire: "Convert explicit operator intent into bounded execution.",
          activity_summary: ["Running: Ship the next slice", "Queued: Verify the runtime"],
          scope_notice: "Operator-facing self-report only.",
        },
        autonomy_control: {
          toolkit: {
            bridge_agents: [{ agent_id: "codex", armed: true }],
            local_agents: [{ agent_id: "local-imprint", armed: true }],
            terminal_commands: [{ command: "gh", armed: true }],
            bridge_toolkit_ready: true,
            local_agent_spawn_ready: true,
            terminal_toolkit_ready: true,
            imprint_ready: true,
            github_cli_ready: true,
          },
        },
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T17:00:00.000Z",
          cached: true,
          diagnostics: [],
        },
      },
    },
    { theme: "dark" }
  );

  assert.equal(snapshot.summary.control_plane.tool_catalog_count, 123);
  assert.equal(snapshot.summary.control_plane.permission_default_profile, "bounded_execute");
  assert.equal(snapshot.summary.control_plane.projected_cost_usd, 4.5);
  assert.equal(snapshot.summary.control_plane.actual_cost_usd, 2.25);
  assert.equal(snapshot.summary.control_plane.warm_cache_enabled, true);
  assert.equal(snapshot.summary.control_plane.warm_cache_stale, false);
  assert.equal(snapshot.summary.control_plane.disabled_feature_flags, 2);
  assert.equal(snapshot.summary.desktop_control.enabled, true);
  assert.equal(snapshot.summary.desktop_control.observe_ready, true);
  assert.equal(snapshot.summary.desktop_control.act_ready, true);
  assert.equal(snapshot.summary.desktop_control.listen_ready, false);
  assert.equal(snapshot.summary.desktop_control.last_frontmost_app, "Cursor");
  assert.equal(snapshot.summary.patient_zero.enabled, true);
  assert.equal(snapshot.summary.patient_zero.posture, "armed");
  assert.equal(snapshot.summary.patient_zero.autonomous_control_enabled, false);
  assert.equal(snapshot.summary.patient_zero.full_control_authority, false);
  assert.equal(snapshot.summary.patient_zero.browser_app, "Safari");
  assert.equal(snapshot.summary.patient_zero.browser_ready, true);
  assert.equal(snapshot.summary.patient_zero.root_shell_enabled, true);
  assert.equal(snapshot.summary.patient_zero.toolkit.github_cli_ready, true);
  assert.equal(snapshot.summary.patient_zero.toolkit.imprint_ready, true);
  assert.equal(snapshot.summary.patient_zero.report.activity_summary.length, 2);
  assert.equal(snapshot.summary.control_plane.patient_zero_enabled, true);
  assert.equal(snapshot.summary.control_plane.patient_zero_autonomous_control_enabled, false);
  assert.equal(snapshot.summary.control_plane.patient_zero_full_control_authority, false);
  assert.equal(snapshot.summary.privileged_access.root_execution_ready, true);
  assert.equal(snapshot.summary.privileged_access.credential_verified, true);
  assert.equal(snapshot.summary.privileged_access.account, "mcagent");
  assert.equal(snapshot.summary.control_plane.privileged_root_ready, true);
});

test("office gui snapshot marks Patient Zero full authority only when autonomy and all local lanes are armed", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["ring-leader"],
        agents: [{ agent_id: "ring-leader", display_name: "Ring Leader", coordination_tier: "lead", role_lane: "ops" }],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {
        state: {
          config: {
            execute_enabled: true,
          },
        },
      },
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
        desktop_control: {
          summary: {
            enabled: true,
            stale: false,
            observe_ready: true,
            act_ready: true,
            listen_ready: true,
          },
        },
        patient_zero: {
          summary: {
            enabled: true,
            posture: "armed",
            severity: "critical",
            permission_profile: "high_risk",
            browser_app: "Safari",
            browser_ready: true,
            root_shell_enabled: true,
            root_shell_reason: "Privileged root lane ready via mcagent.",
            autonomy_enabled: true,
          },
        },
        privileged_access: {
          summary: {
            root_execution_ready: true,
            credential_verified: true,
            account: "mcagent",
            target_user: "root",
            patient_zero_armed: true,
            secret_present: true,
            helper_ready: true,
            blockers: [],
          },
        },
      },
      patient_zero: {
        report: {
          activity_summary: [],
        },
        autonomy_control: {
          toolkit: {
            bridge_agents: [{ agent_id: "codex", armed: true }],
            local_agents: [{ agent_id: "local-imprint", armed: true }],
            terminal_commands: [{ command: "gh", armed: true }],
            bridge_toolkit_ready: true,
            local_agent_spawn_ready: true,
            terminal_toolkit_ready: true,
            imprint_ready: true,
            github_cli_ready: true,
          },
        },
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
        self_drive: {
          enabled: true,
        },
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T17:00:00.000Z",
          cached: true,
          diagnostics: [],
        },
      },
    },
    { theme: "dark" }
  );

  assert.equal(snapshot.summary.patient_zero.autonomous_control_enabled, true);
  assert.equal(snapshot.summary.patient_zero.full_control_authority, true);
  assert.equal(snapshot.summary.control_plane.patient_zero_autonomous_control_enabled, true);
  assert.equal(snapshot.summary.control_plane.patient_zero_full_control_authority, true);
});

test("office gui snapshot exposes live autopilot execution posture and council state", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["ring-leader", "implementation-director", "research-director", "verification-director"],
        agents: [
          { agent_id: "ring-leader", display_name: "Ring Leader", coordination_tier: "lead", role_lane: "orchestrator" },
          {
            agent_id: "implementation-director",
            display_name: "Implementation Director",
            coordination_tier: "director",
            role_lane: "implementer",
          },
          {
            agent_id: "research-director",
            display_name: "Research Director",
            coordination_tier: "director",
            role_lane: "analyst",
          },
          {
            agent_id: "verification-director",
            display_name: "Verification Director",
            coordination_tier: "director",
            role_lane: "verifier",
          },
        ],
      },
      workboard: {
        latest_turn: {
          turn_id: "turn-exec",
          updated_at: new Date().toISOString(),
          selected_agent: "implementation-director",
          selected_strategy: "Dispatch a bounded execution slice",
        },
      },
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: {
        sessions: [
          {
            session_id: "trichat-autopilot:ring-leader-main",
            agent_id: "ring-leader",
            client_kind: "trichat-autopilot",
            status: "busy",
            metadata: {
              thread_id: "ring-leader-main",
              current_task_id: "task-exec",
              last_execution_mode: "tmux_dispatch",
            },
          },
        ],
      },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {
        state: {
          running: true,
          local_running: true,
          in_tick: false,
          config: {
            execute_enabled: true,
            execute_backend: "tmux",
            objective: "Ship bounded execution through the MCP runtime",
          },
          effective_agent_pool: {
            lead_agent_id: "ring-leader",
            specialist_agent_ids: ["implementation-director", "research-director", "verification-director"],
            council_agent_ids: ["ring-leader", "implementation-director", "research-director", "verification-director"],
          },
          last_tick: {
            ok: true,
            success_agents: 4,
            execution: {
              mode: "tmux_dispatch",
              task_ids: ["task-exec"],
            },
          },
        },
      },
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T17:00:00.000Z",
          cached: true,
          diagnostics: [],
        },
      },
    },
    { theme: "dark" }
  );

  assert.equal(snapshot.summary.autopilot.running, true);
  assert.equal(snapshot.summary.autopilot.execute_enabled, true);
  assert.equal(snapshot.summary.autopilot.last_execution_mode, "tmux_dispatch");
  assert.equal(snapshot.summary.autopilot.council_agent_count, 4);
  assert.equal(snapshot.current.execution_mode, "tmux_dispatch");
  assert.equal(snapshot.current.execute_enabled, true);
  assert.deepEqual(snapshot.current.council_agent_ids, [
    "ring-leader",
    "implementation-director",
    "research-director",
    "verification-director",
  ]);
});

test("office gui snapshot clears briefing current context when autopilot is idle and no live task is active", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["ring-leader", "quality-guard"],
        agents: [
          { agent_id: "ring-leader", display_name: "Ring Leader", coordination_tier: "lead", role_lane: "orchestrator" },
          { agent_id: "quality-guard", display_name: "Quality Guard", coordination_tier: "leaf", role_lane: "verifier" },
        ],
      },
      workboard: {
        latest_turn: {
          turn_id: "turn-stale",
          updated_at: new Date().toISOString(),
          selected_agent: "quality-guard",
          selected_strategy: "Inspect kernel state to check for weak evidence and risky assumptions",
          decision_summary: "turn decision: selected quality-guard strategy.",
        },
      },
      tmux: {
        state: { enabled: true, worker_count: 1 },
        dashboard: { queue_depth: 0, queue_age_seconds: 0, failure_count: 0 },
      },
      task_summary: { counts: {} },
      task_running: { tasks: [] },
      task_pending: { tasks: [] },
      agent_sessions: {
        sessions: [
          {
            session_id: "trichat-autopilot:ring-leader-main",
            agent_id: "ring-leader",
            client_kind: "trichat-autopilot",
            status: "idle",
            metadata: {
              thread_id: "ring-leader-main",
              last_source_task_objective:
                "Complete orchestration functionality and autonomous MCP control for MCPlayground tonight.",
              last_execution_mode: "advisory",
            },
          },
        ],
      },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {
        state: {
          running: false,
          local_running: false,
          in_tick: false,
          config: {
            execute_enabled: false,
            execute_backend: "tmux",
            objective: "",
          },
          effective_agent_pool: {
            lead_agent_id: "ring-leader",
            specialist_agent_ids: ["quality-guard"],
            council_agent_ids: ["ring-leader", "quality-guard"],
          },
          last_tick: {},
        },
      },
      runtime_workers: { summary: { active_count: 0, session_count: 0 }, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T17:00:00.000Z",
          cached: true,
          diagnostics: [],
        },
      },
    },
    { theme: "dark" }
  );

  assert.equal(snapshot.current.current_objective, "");
  assert.equal(snapshot.current.decision_summary, "");
  assert.equal(snapshot.current.selected_strategy, "");
  assert.equal(snapshot.current.selected_agent, "");
  assert.equal(snapshot.current.spawn_path, "");
  assert.deepEqual(snapshot.current.delegation_brief, {});
});

test("office gui snapshot keeps active roster agents desk-ready when they are armed but idle", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["research-director"],
        agents: [
          {
            agent_id: "research-director",
            display_name: "Research Director",
            coordination_tier: "director",
            role_lane: "analyst",
          },
        ],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T17:00:00.000Z",
          cached: true,
          diagnostics: [],
        },
      },
    },
    { theme: "dark" }
  );

  const agent = snapshot.agents[0];
  assert.equal(agent.agent.agent_id, "research-director");
  assert.equal(agent.state, "ready");
  assert.equal(agent.location, "desk");
  assert.equal(agent.activity, "armed for the next bounded task");
  assert.equal(agent.evidence_source, "roster");
  assert.equal(agent.evidence_detail, "active-agent-pool");
});

test("office gui snapshot prefers a connected Copilot bridge over an unavailable export-only Copilot entry", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["github-copilot"],
        agents: [
          {
            agent_id: "github-copilot",
            display_name: "GitHub Copilot",
            coordination_tier: "support",
            role_lane: "implementer",
          },
        ],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: {
        state: {},
        runtime: {},
        due: {},
      },
      provider_bridge: {
        diagnostics: {
          generated_at: "2026-04-01T23:05:00.000Z",
          cached: true,
          diagnostics: [
            {
              client_id: "github-copilot-cli",
              display_name: "GitHub Copilot CLI",
              office_agent_id: "github-copilot",
              status: "connected",
              detail: "Copilot CLI login metadata present",
            },
            {
              client_id: "github-copilot-vscode",
              display_name: "GitHub Copilot Agent Mode (VS Code)",
              office_agent_id: "github-copilot",
              status: "unavailable",
              detail: "Bridge is not configured for this client on this host.",
            },
          ],
        },
      },
    },
    { theme: "dark" }
  );

  const copilot = snapshot.agents.find((entry) => entry.agent.agent_id === "github-copilot");
  assert.ok(copilot);
  assert.equal(copilot.state, "ready");
  assert.equal(copilot.evidence_source, "provider_bridge");
  assert.match(copilot.activity, /bridge connected/i);
});

test("office gui snapshot keeps fresh latest-turn presence even after active_turn clears", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["ring-leader", "implementation-director"],
        agents: [
          { agent_id: "ring-leader", display_name: "Ring Leader", coordination_tier: "lead", role_lane: "orchestrator" },
          {
            agent_id: "implementation-director",
            display_name: "Implementation Director",
            coordination_tier: "director",
            role_lane: "implementer",
          },
        ],
      },
      workboard: {
        latest_turn: {
          turn_id: "turn-123",
          updated_at: new Date().toISOString(),
          selected_agent: "ring-leader",
          expected_agents: ["implementation-director"],
          selected_strategy: "Dispatch the next bounded implementation pass",
        },
      },
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: { state: {}, runtime: {}, due: {} },
      provider_bridge: { diagnostics: { generated_at: "", cached: false, diagnostics: [] } },
    },
    { theme: "dark" }
  );

  const agents = new Map(snapshot.agents.map((entry) => [entry.agent.agent_id, entry]));
  assert.equal(agents.get("ring-leader")?.state, "supervising");
  assert.equal(agents.get("ring-leader")?.evidence_source, "turn");
  assert.equal(agents.get("implementation-director")?.state, "idle");
  assert.equal(agents.get("implementation-director")?.evidence_source, "turn");
});

test("office gui snapshot keeps healthy idle sessions visible as ready", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["local-imprint"],
        agents: [
          {
            agent_id: "local-imprint",
            display_name: "Local Imprint",
            coordination_tier: "support",
            role_lane: "support",
          },
        ],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: {
        sessions: [
          {
            session_id: "session-local-imprint",
            agent_id: "local-imprint",
            status: "idle",
            updated_at: new Date().toISOString(),
            metadata: {
              current_focus: "watching the office for the next handoff",
            },
          },
        ],
      },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: { state: {}, runtime: {}, due: {} },
      provider_bridge: { diagnostics: { generated_at: "", cached: false, diagnostics: [] } },
    },
    { theme: "dark" }
  );

  const localImprint = snapshot.agents.find((entry) => entry.agent.agent_id === "local-imprint");
  assert.ok(localImprint);
  assert.equal(localImprint.state, "ready");
  assert.equal(localImprint.evidence_source, "session");
  assert.match(localImprint.activity, /watching the office/i);
});

test("office gui snapshot lets fresh session presence outrank adapter blockers", () => {
  const nowIso = new Date().toISOString();
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["codex"],
        agents: [{ agent_id: "codex", display_name: "Codex", coordination_tier: "support", role_lane: "support" }],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: {
        sessions: [
          {
            session_id: "session-codex",
            agent_id: "codex",
            status: "active",
            updated_at: nowIso,
            metadata: {
              current_focus: "awaiting the next bounded coding task",
            },
          },
        ],
      },
      adapter: {
        states: [
          {
            agent_id: "codex",
            updated_at: nowIso,
            open: true,
            last_error: "bridge command failed",
            last_result: "trip-opened",
          },
        ],
      },
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: { state: {}, runtime: {}, due: {} },
      provider_bridge: { diagnostics: { generated_at: "", cached: false, diagnostics: [] } },
    },
    { theme: "dark" }
  );

  const codex = snapshot.agents.find((entry) => entry.agent.agent_id === "codex");
  assert.ok(codex);
  assert.equal(codex.state, "ready");
  assert.equal(codex.evidence_source, "session");
  assert.doesNotMatch(codex.activity, /bridge command failed/i);
});

test("office gui snapshot ignores stale provider diagnostics before marking agents blocked", () => {
  const snapshot = buildOfficeGuiSnapshot(
    {
      roster: {
        active_agent_ids: ["github-copilot"],
        agents: [
          {
            agent_id: "github-copilot",
            display_name: "GitHub Copilot",
            coordination_tier: "support",
            role_lane: "implementer",
          },
        ],
      },
      workboard: {},
      tmux: {},
      task_summary: { counts: {} },
      task_running: {},
      task_pending: {},
      agent_sessions: { sessions: [] },
      adapter: {},
      bus_tail: {},
      trichat_summary: {},
      learning: {},
      autopilot: {},
      runtime_workers: { summary: {}, sessions: [] },
      kernel: {
        overview: {},
        worker_fabric: { hosts: [] },
        model_router: { backends: [] },
        runtime_workers: {},
        autonomy_maintain: {},
        reaction_engine: {},
        observability: {},
        swarm: {},
        workflow_exports: {},
      },
      autonomy_maintain: { state: {}, runtime: {}, due: {} },
      provider_bridge: {
        diagnostics: {
          generated_at: new Date(Date.now() - 60_000).toISOString(),
          cached: true,
          stale: true,
          diagnostics: [
            {
              client_id: "github-copilot-cli",
              display_name: "GitHub Copilot CLI",
              status: "disconnected",
              detail: "stale disconnected bridge state",
            },
          ],
        },
      },
    },
    { theme: "dark" }
  );

  const copilot = snapshot.agents.find((entry) => entry.agent.agent_id === "github-copilot");
  assert.ok(copilot);
  assert.equal(copilot.state, "ready");
  assert.equal(copilot.evidence_source, "roster");
  assert.notEqual(copilot.evidence_source, "provider_bridge");
});
