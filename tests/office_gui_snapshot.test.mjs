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
  assert.equal(agents.get("gemini")?.state, "idle");
  assert.equal(agents.get("cursor")?.state, "idle");
  assert.equal(agents.get("github-copilot")?.state, "blocked");
  assert.equal(snapshot.summary.provider_bridge.connected_count, 2);
  assert.equal(snapshot.summary.maintain.self_drive_enabled, true);
  assert.equal(snapshot.summary.maintain.self_drive_last_goal_id, "goal-self-drive-1");
});
