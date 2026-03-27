from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "agent_office_dashboard.py"
SPEC = importlib.util.spec_from_file_location("agent_office_dashboard", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AgentOfficeDashboardTests(unittest.TestCase):
    def test_select_display_agents_keeps_director_chain(self) -> None:
        roster = {
            "active_agent_ids": ["ring-leader", "code-smith", "research-scout", "quality-guard", "local-imprint", "codex"],
            "agents": [
                {
                    "agent_id": "ring-leader",
                    "display_name": "Ring Leader",
                    "coordination_tier": "lead",
                    "role_lane": "orchestrator",
                    "managed_agent_ids": ["implementation-director", "research-director", "verification-director"],
                },
                {
                    "agent_id": "implementation-director",
                    "display_name": "Implementation Director",
                    "coordination_tier": "director",
                    "role_lane": "implementer",
                    "parent_agent_id": "ring-leader",
                    "managed_agent_ids": ["code-smith"],
                },
                {
                    "agent_id": "research-director",
                    "display_name": "Research Director",
                    "coordination_tier": "director",
                    "role_lane": "analyst",
                    "parent_agent_id": "ring-leader",
                    "managed_agent_ids": ["research-scout"],
                },
                {
                    "agent_id": "verification-director",
                    "display_name": "Verification Director",
                    "coordination_tier": "director",
                    "role_lane": "verifier",
                    "parent_agent_id": "ring-leader",
                    "managed_agent_ids": ["quality-guard"],
                },
                {
                    "agent_id": "code-smith",
                    "display_name": "Code Smith",
                    "coordination_tier": "leaf",
                    "role_lane": "implementer",
                    "parent_agent_id": "implementation-director",
                },
                {
                    "agent_id": "research-scout",
                    "display_name": "Research Scout",
                    "coordination_tier": "leaf",
                    "role_lane": "analyst",
                    "parent_agent_id": "research-director",
                },
                {
                    "agent_id": "quality-guard",
                    "display_name": "Quality Guard",
                    "coordination_tier": "leaf",
                    "role_lane": "verifier",
                    "parent_agent_id": "verification-director",
                },
                {
                    "agent_id": "local-imprint",
                    "display_name": "Local Imprint",
                    "coordination_tier": "support",
                    "role_lane": "reliability-critic",
                    "parent_agent_id": "ring-leader",
                },
                {
                    "agent_id": "codex",
                    "display_name": "Codex",
                    "coordination_tier": "support",
                    "role_lane": "planner",
                },
            ],
        }
        workboard = {
            "latest_turn": {
                "expected_agents": [
                    "ring-leader",
                    "implementation-director",
                    "research-director",
                    "verification-director",
                    "local-imprint",
                    "codex",
                ],
                "selected_agent": "research-director",
                "metadata": {
                    "lead_agent_id": "ring-leader",
                    "specialist_agent_ids": [
                        "implementation-director",
                        "research-director",
                        "verification-director",
                        "local-imprint",
                        "codex",
                    ]
                },
            }
        }

        agents = MODULE.select_display_agents(roster, workboard)
        ids = [agent.agent_id for agent in agents]
        self.assertIn("implementation-director", ids)
        self.assertIn("research-director", ids)
        self.assertIn("verification-director", ids)
        self.assertIn("ring-leader", ids)

    def test_director_selection_moves_leaf_to_working_and_director_to_supervising(self) -> None:
        roster = {
            "active_agent_ids": ["ring-leader", "implementation-director", "code-smith"],
            "agents": [
                {
                    "agent_id": "ring-leader",
                    "display_name": "Ring Leader",
                    "coordination_tier": "lead",
                    "role_lane": "orchestrator",
                },
                {
                    "agent_id": "implementation-director",
                    "display_name": "Implementation Director",
                    "coordination_tier": "director",
                    "role_lane": "implementer",
                    "managed_agent_ids": ["code-smith"],
                },
                {
                    "agent_id": "code-smith",
                    "display_name": "Code Smith",
                    "coordination_tier": "leaf",
                    "role_lane": "implementer",
                    "parent_agent_id": "implementation-director",
                },
            ],
        }
        workboard = {
            "latest_turn": {
                "selected_agent": "implementation-director",
                "selected_strategy": "Delegate bounded tasks to code-smith with explicit success criteria.",
                "expected_agents": ["ring-leader", "implementation-director"],
                "updated_at": "2026-03-27T03:52:31.612Z",
            }
        }
        tmux = {
            "state": {
                "counts": {"running": 1},
                "tasks": [{"title": "Step 2: npm test", "status": "running"}],
            }
        }
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(agents, workboard, tmux, {"states": []}, {"events": []}, now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"))
        states = {presence.agent.agent_id: presence.state for presence in presences}
        self.assertEqual(states["implementation-director"], "supervising")
        self.assertEqual(states["code-smith"], "working")

    def test_blocked_adapter_state_overrides_other_presence(self) -> None:
        roster = {
            "active_agent_ids": ["research-scout"],
            "agents": [
                {
                    "agent_id": "research-scout",
                    "display_name": "Research Scout",
                    "coordination_tier": "leaf",
                    "role_lane": "analyst",
                }
            ],
        }
        workboard = {"latest_turn": {"updated_at": "2026-03-27T03:52:31.612Z"}}
        tmux = {"state": {"counts": {"running": 0}, "tasks": []}}
        adapter = {
            "states": [
                {
                    "agent_id": "research-scout",
                    "channel": "command",
                    "updated_at": "2026-03-27T03:52:40Z",
                    "open": True,
                    "last_error": "bridge command failed: command not found",
                    "last_result": "trip-opened",
                }
            ]
        }
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(agents, workboard, tmux, adapter, {"events": []}, now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"))
        self.assertEqual(presences[0].state, "offline")

    def test_recent_chat_without_active_turn_becomes_break_state(self) -> None:
        roster = {
            "active_agent_ids": ["local-imprint"],
            "agents": [
                {
                    "agent_id": "local-imprint",
                    "display_name": "Local Imprint",
                    "coordination_tier": "support",
                    "role_lane": "reliability-critic",
                }
            ],
        }
        workboard = {"latest_turn": {}}
        tmux = {"state": {"counts": {"running": 0}, "tasks": []}}
        bus = {
            "events": [
                {
                    "source_agent": "local-imprint",
                    "event_type": "trichat.message",
                    "created_at": "2026-03-27T03:46:10Z",
                    "content": "Quick sync at the water cooler before the next bounded pass.",
                }
            ]
        }
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(
            agents,
            workboard,
            tmux,
            {"states": []},
            bus,
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "break")
        self.assertEqual(presences[0].location, "lounge")
        self.assertIn("break", presences[0].actions)

    def test_active_agent_with_no_recent_signals_falls_asleep(self) -> None:
        roster = {
            "active_agent_ids": ["quality-guard"],
            "agents": [
                {
                    "agent_id": "quality-guard",
                    "display_name": "Quality Guard",
                    "coordination_tier": "leaf",
                    "role_lane": "verifier",
                }
            ],
        }
        workboard = {"latest_turn": {"updated_at": "2026-03-27T01:00:00Z"}}
        tmux = {"state": {"counts": {"running": 0}, "tasks": []}}
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(
            agents,
            workboard,
            tmux,
            {"states": []},
            {"events": []},
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "sleeping")
        self.assertEqual(presences[0].location, "sofa")
        self.assertIn("sleep", presences[0].actions)

    def test_office_view_renders_amenities(self) -> None:
        snapshot = MODULE.DashboardSnapshot(
            thread_id="ring-leader-main",
            fetched_at=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
            roster={
                "active_agent_ids": ["ring-leader"],
                "agents": [
                    {
                        "agent_id": "ring-leader",
                        "display_name": "Ring Leader",
                        "coordination_tier": "lead",
                        "role_lane": "orchestrator",
                    }
                ],
            },
            workboard={"latest_turn": {}},
            tmux={"state": {"counts": {"running": 0}, "tasks": []}},
            task_summary={"counts": {}},
            adapter={"states": []},
            bus_tail={"events": []},
            trichat_summary={},
            kernel={},
            learning={},
            autopilot={},
            errors=[],
        )
        lines = MODULE.render_office_view(snapshot, width=100, height=40, frame=0)
        joined = "\n".join(lines)
        self.assertIn("Coffee [::]", joined)
        self.assertIn("Water [OO]", joined)
        self.assertIn("Sofa [__]", joined)

    def test_briefing_view_surfaces_learning_and_ring_leader_signal(self) -> None:
        snapshot = MODULE.DashboardSnapshot(
            thread_id="ring-leader-main",
            fetched_at=MODULE.iso_to_epoch("2026-03-27T06:53:00Z"),
            roster={"active_agent_ids": ["ring-leader"], "agents": []},
            workboard={"latest_turn": {"selected_agent": "ring-leader", "verify_status": "passed"}},
            tmux={"state": {"counts": {"running": 1}, "tasks": []}, "dashboard": {}},
            task_summary={"counts": {"pending": 1, "running": 1, "failed": 0, "completed": 2}},
            task_pending={
                "tasks": [
                    {
                        "task_id": "trichat-autopilot-fallback-1",
                        "objective": "Tighten the dashboard delegation handoff and keep the evidence contract explicit.",
                        "status": "pending",
                        "source": "trichat.autopilot",
                        "payload": {
                            "delegate_agent_id": "code-smith",
                            "task_objective": "Tighten the dashboard delegation handoff",
                            "evidence_requirements": ["Show the updated dashboard brief in the office TUI."],
                        },
                        "metadata": {"task_mode": "autopilot_specialist_fallback"},
                    }
                ]
            },
            adapter={"states": []},
            bus_tail={"events": []},
            trichat_summary={"busiest_threads": []},
            kernel={
                "state": "active",
                "overview": {"active_session_count": 1},
                "tasks": {"counts": {"failed": 0}},
                "learning": {
                    "active_session_coverage": {
                        "covered_agent_count": 1,
                        "active_session_agent_count": 1,
                    }
                },
            },
            learning={
                "active_entry_count": 4,
                "agents_with_active_entries": 2,
                "prefer_count": 3,
                "avoid_count": 1,
                "top_agents": [
                    {
                        "agent_id": "ring-leader",
                        "active_entry_count": 2,
                        "prefer_count": 2,
                        "avoid_count": 0,
                        "top_summaries": ["Prefer bounded delegation with explicit proof."],
                    }
                ],
            },
            autopilot={
                "session": {
                    "session": {
                        "metadata": {
                            "thread_id": "ring-leader-main",
                            "last_source_task_objective": "Refresh the operator dashboard and keep the ring leader brief stable after restart.",
                            "last_selected_delegation_brief": {
                                "delegate_agent_id": "code-smith",
                                "task_objective": "Tighten the dashboard delegation handoff",
                                "success_criteria": ["Operator brief shows the active delegate and current objective."],
                                "evidence_requirements": ["Show the updated dashboard brief in the office TUI."],
                                "rollback_notes": ["Revert the dashboard MCP fetch expansion if the panel becomes noisy."],
                            },
                            "last_execution_task_ids": ["trichat-autopilot-fallback-1"],
                        }
                    }
                },
                "last_tick": {
                    "ok": True,
                    "learning_signal": {
                        "matched_prefer": 1,
                        "matched_avoid": 0,
                        "confidence_adjustment": 0.04,
                        "rationale": ["Aligned with learned prefers: bounded delegation"],
                    }
                }
            },
            errors=[],
        )
        lines = MODULE.render_briefing_view(snapshot, width=120, height=40)
        joined = "\n".join(lines)
        self.assertIn("Learning :: active=4", joined)
        self.assertIn("Ring leader :: tick_ok=yes", joined)
        self.assertIn("Current objective:", joined)
        self.assertIn("Delegation brief:", joined)
        self.assertIn("Execution backlog:", joined)
        self.assertIn("Most learned agents:", joined)


if __name__ == "__main__":
    unittest.main()
