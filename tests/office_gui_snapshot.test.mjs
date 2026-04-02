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
  assert.equal(copilot.state, "sleeping");
  assert.notEqual(copilot.evidence_source, "provider_bridge");
});
