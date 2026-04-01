from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "agent_office_dashboard.py"
SPEC = importlib.util.spec_from_file_location("agent_office_dashboard", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AgentOfficeDashboardTests(unittest.TestCase):
    def test_snapshot_max_workers_caps_http_fanout(self) -> None:
        self.assertEqual(MODULE.snapshot_max_workers("http", 15), 4)
        self.assertEqual(MODULE.snapshot_max_workers("http", 1), 1)
        self.assertEqual(MODULE.snapshot_max_workers("stdio", 15), 8)

    def test_snapshot_cache_round_trip_reads_fresh_thread_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = pathlib.Path(temp_dir)
            payload = {
                "thread_id": "ring-leader-main",
                "theme": "night",
                "fetched_at": time.time(),
                "agents": [],
                "summary": {},
                "rooms": {},
                "errors": [],
            }
            cache_path = MODULE.write_snapshot_cache(repo_root, payload)
            self.assertIsNotNone(cache_path)
            self.assertTrue(cache_path.exists())
            cached = MODULE.read_snapshot_cache(repo_root, "ring-leader-main", "night", max_age_seconds=10.0)
            self.assertIsNotNone(cached)
            assert cached is not None
            self.assertEqual(cached["thread_id"], "ring-leader-main")
            self.assertEqual(cached["theme"], "night")
            self.assertEqual(cached["cache"]["source"], "dashboard-refresh")

    def test_snapshot_cache_reads_latest_alias_when_thread_unspecified(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = pathlib.Path(temp_dir)
            payload = {
                "thread_id": "demo-thread",
                "theme": "sunrise",
                "fetched_at": time.time(),
                "agents": [],
                "summary": {},
                "rooms": {},
                "errors": [],
            }
            MODULE.write_snapshot_cache(repo_root, payload)
            cached = MODULE.read_snapshot_cache(repo_root, None, "sunrise", max_age_seconds=10.0)
            self.assertIsNotNone(cached)
            assert cached is not None
            self.assertEqual(cached["thread_id"], "demo-thread")
            self.assertEqual(cached["theme"], "sunrise")

    def test_snapshot_cache_rejects_stale_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = pathlib.Path(temp_dir)
            payload = {
                "thread_id": "stale-thread",
                "theme": "night",
                "fetched_at": time.time() - 120.0,
                "agents": [],
                "summary": {},
                "rooms": {},
                "errors": [],
            }
            MODULE.write_snapshot_cache(repo_root, payload)
            cached = MODULE.read_snapshot_cache(repo_root, "stale-thread", "night", max_age_seconds=5.0)
            self.assertIsNone(cached)

    def test_snapshot_cache_preserves_last_good_office_when_partial_refresh_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = pathlib.Path(temp_dir)
            good_payload = {
                "thread_id": "ring-leader-main",
                "theme": "night",
                "fetched_at": time.time(),
                "agents": [{"agent": {"agent_id": "ring-leader"}}],
                "summary": {"kernel": {"state": "active"}},
                "rooms": {"command": ["ring-leader"], "lounge": [], "build": [], "ops": []},
                "errors": [],
            }
            partial_payload = {
                "thread_id": "ring-leader-main",
                "theme": "night",
                "fetched_at": time.time(),
                "agents": [],
                "summary": {"kernel": {"state": "active"}},
                "rooms": {"command": [], "lounge": [], "build": [], "ops": []},
                "errors": ["roster: timeout"],
            }
            MODULE.write_snapshot_cache(repo_root, good_payload)
            MODULE.write_snapshot_cache(repo_root, partial_payload)
            cached = MODULE.read_snapshot_cache(repo_root, "ring-leader-main", "night", max_age_seconds=10.0)
            self.assertIsNotNone(cached)
            assert cached is not None
            self.assertEqual(len(cached["agents"]), 1)
            self.assertEqual(cached["errors"], ["roster: timeout"])
            self.assertEqual(cached["cache"]["source"], "dashboard-refresh-preserved")

    def test_fetch_snapshot_prefers_http_office_snapshot_when_transport_is_http(self) -> None:
        caller = MODULE.McpToolCaller(
            repo_root=REPO_ROOT,
            transport="http",
            url="http://127.0.0.1:8787/",
            origin="http://127.0.0.1",
            stdio_command="node",
            stdio_args="dist/server.js",
            retries=0,
            retry_delay_seconds=0.05,
            tool_timeout_seconds=1.0,
        )
        payload = {
            "thread_id": "ring-leader-main",
            "roster": {"agents": [{"agent_id": "ring-leader"}]},
            "workboard": {"latest_turn": {"selected_agent": "ring-leader"}},
            "tmux": {},
            "task_summary": {},
            "adapter": {},
            "bus_tail": {},
            "trichat_summary": {},
            "kernel": {"state": "ready"},
            "learning": {},
            "autopilot": {},
            "autonomy_maintain": {},
            "runtime_workers": {},
            "errors": [],
            "agent_sessions": {},
            "task_running": {},
            "task_pending": {},
        }
        with mock.patch.dict(MODULE.os.environ, {"MCP_HTTP_BEARER_TOKEN": "test-token"}, clear=False):
            with mock.patch.object(MODULE.McpToolCaller, "fetch_http_snapshot", return_value=payload) as fetch_mock:
                with mock.patch.object(MODULE.McpToolCaller, "call_tool", side_effect=AssertionError("tool fanout should not run")):
                    snapshot = MODULE.fetch_snapshot(caller, "ring-leader-main", "night")
        self.assertEqual(snapshot.thread_id, "ring-leader-main")
        self.assertEqual(snapshot.kernel["state"], "ready")
        fetch_mock.assert_called_once_with("ring-leader-main", "night")

    def test_build_config_roster_fallback_uses_repo_agent_config(self) -> None:
        workboard = {
            "latest_turn": {
                "selected_agent": "research-director",
                "expected_agents": ["ring-leader", "research-director", "research-scout"],
                "metadata": {
                    "lead_agent_id": "ring-leader",
                    "specialist_agent_ids": ["research-director", "research-scout"],
                },
            }
        }
        roster = MODULE.build_config_roster_fallback(
            REPO_ROOT,
            workboard,
            {"sessions": [{"agent_id": "local-imprint"}]},
            {"top_agents": [{"agent_id": "code-smith"}]},
        )
        ids = {entry["agent_id"] for entry in roster["agents"]}
        self.assertIn("ring-leader", ids)
        self.assertIn("research-director", ids)
        self.assertIn("research-scout", ids)
        self.assertIn("local-imprint", roster["active_agent_ids"])
        self.assertIn("code-smith", roster["active_agent_ids"])

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
        workboard = {"latest_turn": {}}
        tmux = {"state": {"counts": {"running": 0}, "tasks": []}}
        task_running = {
            "tasks": [
                {
                    "task_id": "task-1",
                    "status": "running",
                    "objective": "Implement the bounded patch slice",
                    "payload": {
                        "delegate_agent_id": "code-smith",
                        "task_objective": "Implement the bounded patch slice",
                    },
                    "metadata": {
                        "lead_agent_id": "ring-leader",
                        "selected_agent": "implementation-director",
                        "delegate_agent_id": "code-smith",
                        "delegation_brief": {
                            "delegate_agent_id": "code-smith",
                            "task_objective": "Implement the bounded patch slice",
                        },
                    },
                }
            ]
        }
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(
            agents,
            workboard,
            tmux,
            task_running,
            {"tasks": []},
            {"sessions": []},
            {"states": []},
            {"events": []},
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        states = {presence.agent.agent_id: presence.state for presence in presences}
        evidence = {presence.agent.agent_id: presence.evidence_source for presence in presences}
        self.assertEqual(states["ring-leader"], "supervising")
        self.assertEqual(states["implementation-director"], "supervising")
        self.assertEqual(states["code-smith"], "working")
        self.assertEqual(evidence["code-smith"], "task:delegate")

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
        presences = MODULE.derive_presence_map(
            agents,
            workboard,
            tmux,
            {"tasks": []},
            {"tasks": []},
            {"sessions": []},
            adapter,
            {"events": []},
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "offline")
        self.assertEqual(presences[0].evidence_source, "adapter")

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
            {"tasks": []},
            {"tasks": []},
            {"sessions": []},
            {"states": []},
            bus,
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "break")
        self.assertEqual(presences[0].location, "lounge")
        self.assertIn("break", presences[0].actions)
        self.assertEqual(presences[0].evidence_source, "bus")

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
            {"tasks": []},
            {"tasks": []},
            {"sessions": []},
            {"states": []},
            {"events": []},
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "sleeping")
        self.assertEqual(presences[0].location, "sofa")
        self.assertIn("sleep", presences[0].actions)
        self.assertEqual(presences[0].evidence_source, "none")

    def test_tmux_title_does_not_fake_agent_ownership(self) -> None:
        roster = {
            "active_agent_ids": ["code-smith"],
            "agents": [
                {
                    "agent_id": "code-smith",
                    "display_name": "Code Smith",
                    "coordination_tier": "leaf",
                    "role_lane": "implementer",
                }
            ],
        }
        workboard = {"latest_turn": {}}
        tmux = {
            "state": {
                "counts": {"running": 1},
                "tasks": [
                    {
                        "task_id": "tmux-1",
                        "title": "code-smith hotfix lane",
                        "status": "running",
                        "metadata": {
                            "strategy": "Code smith should maybe own this",
                        },
                    }
                ],
            }
        }
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(
            agents,
            workboard,
            tmux,
            {"tasks": []},
            {"tasks": []},
            {"sessions": []},
            {"states": []},
            {"events": []},
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "sleeping")
        self.assertEqual(presences[0].evidence_source, "none")

    def test_busy_session_can_drive_real_supervising_state(self) -> None:
        roster = {
            "active_agent_ids": ["ring-leader"],
            "agents": [
                {
                    "agent_id": "ring-leader",
                    "display_name": "Ring Leader",
                    "coordination_tier": "lead",
                    "role_lane": "orchestrator",
                }
            ],
        }
        workboard = {"latest_turn": {}}
        tmux = {"state": {"counts": {"running": 0}, "tasks": []}}
        sessions = {
            "sessions": [
                {
                    "session_id": "trichat-autopilot:ring-leader-main",
                    "agent_id": "ring-leader",
                    "status": "busy",
                    "updated_at": "2026-03-27T03:52:40Z",
                    "metadata": {
                        "objective": "Inspect kernel state and choose one next action",
                    },
                }
            ]
        }
        agents = MODULE.select_display_agents(roster, workboard)
        presences = MODULE.derive_presence_map(
            agents,
            workboard,
            tmux,
            {"tasks": []},
            {"tasks": []},
            sessions,
            {"states": []},
            {"events": []},
            now_epoch=MODULE.iso_to_epoch("2026-03-27T03:53:00Z"),
        )
        self.assertEqual(presences[0].state, "supervising")
        self.assertEqual(presences[0].evidence_source, "session")

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
        self.assertIn("AGENT OFFICE :: Night Shift", joined)
        self.assertIn("Coffee [::]", joined)
        self.assertIn("COMMAND DECK", joined)
        self.assertIn("LOUNGE + WATER", joined)
        self.assertIn("BUILD BAY", joined)
        self.assertIn("OPS RACK", joined)
        self.assertIn("learn", joined)

        compact_lines = MODULE.render_office_view(snapshot, width=82, height=30, frame=0)
        compact_joined = "\n".join(compact_lines)
        self.assertIn("COMMAND DECK", compact_joined)

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
                "worker_fabric": {
                    "host_count": 1,
                    "health_counts": {"healthy": 1, "degraded": 0},
                    "default_host_id": "local",
                    "hosts": [
                        {
                            "host_id": "local",
                            "worker_count": 9,
                            "recommended_worker_count": 9,
                            "max_local_model_concurrency": 2,
                            "cpu_utilization": 0.21,
                            "ram_available_gb": 39.5,
                            "ram_total_gb": 48.0,
                            "thermal_pressure": "nominal",
                        }
                    ],
                },
                "model_router": {
                    "default_backend_id": "mac-control-ollama",
                    "backend_count": 2,
                    "enabled_backend_count": 2,
                    "strategy": "balanced",
                    "backends": [
                        {
                            "backend_id": "mac-control-ollama",
                            "latency_ms_p50": 183.0,
                            "throughput_tps": 37.5,
                            "probe_healthy": True,
                            "probe_model_known": True,
                            "probe_model_loaded": True,
                            "probe_resident_model_count": 1,
                            "probe_resident_vram_gb": 1.9,
                        },
                        {
                            "backend_id": "remote-backend",
                            "latency_ms_p50": 42.0,
                            "throughput_tps": 120.0,
                            "probe_healthy": True,
                            "probe_model_known": True,
                        },
                    ],
                    "routing_outlook": [
                        {
                            "task_kind": "planning",
                            "selected_backend_id": "mac-control-ollama",
                            "selected_provider": "ollama",
                            "planned_backend_count": 2,
                            "top_planned_backend_id": "mac-control-bridge-codex",
                            "top_planned_node_id": "mac-control",
                        },
                        {
                            "task_kind": "coding",
                            "selected_backend_id": "remote-backend",
                            "selected_provider": "vllm",
                            "planned_backend_count": 2,
                            "top_planned_backend_id": "gpu-5090-llama-cpp-coder",
                            "top_planned_node_id": "gpu-5090",
                        },
                    ]
                },
                "swarm": {
                    "active_profile_count": 1,
                    "checkpoint_artifact_count": 3,
                    "topology_counts": {
                        "hierarchical": 1,
                        "mesh": 0,
                        "ring": 0,
                        "star": 0,
                        "adaptive": 0,
                    },
                    "active_profiles": [
                        {
                            "goal_id": "goal-1",
                            "plan_id": "plan-1",
                            "topology": "hierarchical",
                            "consensus_mode": "weighted",
                            "queen_mode": "tactical",
                            "execution_mode": "director-fanout",
                            "checkpoint_cadence": "phase",
                            "checkpoint_count": 3,
                            "memory_match_count": 2,
                            "last_checkpoint_at": "2026-03-27T06:50:00Z",
                        }
                    ],
                },
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
            runtime_workers={
                "summary": {
                    "session_count": 2,
                    "active_count": 1,
                    "counts": {"failed": 1},
                },
                "session": {
                    "session_id": "runtime-1",
                    "runtime_id": "codex",
                    "status": "running",
                    "task_id": "task-42",
                },
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
                    "council_confidence": 0.86,
                    "plan_substance": 0.78,
                    "learning_signal": {
                        "matched_prefer": 1,
                        "matched_avoid": 0,
                        "confidence_adjustment": 0.04,
                        "rationale": ["Aligned with learned prefers: bounded delegation"],
                    },
                    "confidence_method": {
                        "mode": "gsd-confidence",
                        "score": 0.83,
                        "confidence_adjustment": 0.05,
                        "checks": {
                            "owner_clarity": 0.9,
                            "actionability": 0.82,
                            "evidence_bar": 0.8,
                            "rollback_ready": 0.74,
                            "anti_echo": 0.88,
                        },
                    },
                }
            },
            errors=[],
        )
        lines = MODULE.render_briefing_view(snapshot, width=120, height=80)
        joined = "\n".join(lines)
        self.assertIn("Learning :: active=4", joined)
        self.assertIn("Ring leader :: tick_ok=yes", joined)
        self.assertIn("Confidence method:", joined)
        self.assertIn("Spawn path: ring-leader -> code-smith", joined)
        self.assertIn("Current objective:", joined)
        self.assertIn("Delegation brief:", joined)
        self.assertIn("Execution backlog:", joined)
        self.assertIn("Most learned agents:", joined)
        self.assertIn("Swarm :: active=1 hier=1 mesh=0 adaptive=0 checkpoints=3", joined)
        self.assertIn("Swarm profile:", joined)
        self.assertIn("topology=hierarchical consensus=weighted queen=tactical mode=director-fanout", joined)
        self.assertIn("Local :: cpu=21% ram=39.5/48.0GB swap=0.0GB thermal=nominal workers=9/9 models=2 age=n/a", joined)
        self.assertIn(
            "Router live :: backend=mac-control-ollama probe=ok known=yes loaded=warm lat=183ms tps=37.5 res=1 vram=1.9GB age=n/a",
            joined,
        )
        self.assertIn("Runtime Workers :: active=1 failed=1 sessions=2 latest=codex:running task=task-42", joined)
        self.assertIn("Hybrid planning :: live=mac-control-ollama/ollama", joined)
        self.assertIn("Hybrid coding :: live=remote-backend/vllm", joined)

    def test_workers_view_surfaces_runtime_worker_sessions(self) -> None:
        snapshot = MODULE.DashboardSnapshot(
            thread_id="ring-leader-main",
            fetched_at=MODULE.iso_to_epoch("2026-03-27T06:53:00Z"),
            roster={"active_agent_ids": [], "agents": []},
            workboard={"latest_turn": {}},
            tmux={"state": {"counts": {"total": 0, "running": 0, "queued": 0, "dispatched": 0}, "tasks": []}},
            task_summary={"counts": {"pending": 0, "running": 0, "failed": 0, "completed": 0}},
            adapter={"states": []},
            bus_tail={"events": []},
            trichat_summary={"busiest_threads": []},
            kernel={},
            learning={},
            runtime_workers={
                "summary": {
                    "session_count": 1,
                    "active_count": 1,
                    "counts": {"failed": 0},
                },
                "sessions": [
                    {
                        "session_id": "runtime-1",
                        "status": "running",
                        "runtime_id": "codex",
                        "task_id": "task-42",
                        "worktree_path": "/tmp/runtime-1",
                    }
                ],
            },
            autopilot={},
            errors=[],
        )
        lines = MODULE.render_workers_view(snapshot, width=120, height=40)
        joined = "\n".join(lines)
        self.assertIn("runtime_sessions=1 runtime_active=1 runtime_failed=0", joined)
        self.assertIn("Runtime worker sessions:", joined)
        self.assertIn("runtime-1 [running] codex task=task-42", joined)

    def test_help_view_mentions_theme_and_methodology(self) -> None:
        lines = MODULE.render_help_view(width=120, height=30, theme="sunrise")
        joined = "\n".join(lines)
        self.assertIn("t Theme", joined)
        self.assertIn("Current theme: Sunrise Sprint", joined)
        self.assertIn("SuperClaude-inspired confidence checks", joined)

    def test_build_gui_snapshot_exports_truthful_presence_and_runtime_summary(self) -> None:
        snapshot = MODULE.DashboardSnapshot(
            thread_id="ring-leader-main",
            fetched_at=MODULE.iso_to_epoch("2026-03-30T08:00:00Z"),
            roster={
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
            },
            workboard={"latest_turn": {"selected_agent": "implementation-director", "metadata": {"lead_agent_id": "ring-leader"}}},
            tmux={"state": {"enabled": True, "worker_count": 4, "tasks": []}, "dashboard": {"queue_depth": 2, "failure_count": 0}},
            task_summary={"counts": {"pending": 1, "running": 1, "failed": 0, "completed": 2}},
            task_running={
                "tasks": [
                    {
                        "task_id": "task-1",
                        "status": "running",
                        "objective": "Implement the runtime worker slice",
                        "payload": {"delegate_agent_id": "code-smith"},
                        "metadata": {
                            "lead_agent_id": "ring-leader",
                            "selected_agent": "implementation-director",
                            "delegate_agent_id": "code-smith",
                        },
                    }
                ]
            },
            task_pending={"tasks": []},
            agent_sessions={"sessions": []},
            adapter={"states": []},
            bus_tail={"events": []},
            trichat_summary={"busiest_threads": []},
            kernel={
                "state": "idle",
                "overview": {"active_session_count": 1},
                "adaptive_session_counts": {"healthy": 1, "degraded": 0},
                "worker_fabric": {
                    "default_host_id": "local",
                    "host_count": 1,
                    "hosts": [
                        {
                            "host_id": "local",
                            "cpu_utilization": 0.32,
                            "ram_available_gb": 20.5,
                            "ram_total_gb": 48.0,
                            "swap_used_gb": 0.2,
                            "thermal_pressure": "nominal",
                            "worker_count": 9,
                            "recommended_worker_count": 9,
                            "max_local_model_concurrency": 2,
                        }
                    ],
                },
                "model_router": {
                    "backend_count": 2,
                    "enabled_backend_count": 2,
                    "default_backend_id": "ollama-llama3-2-3b",
                    "strategy": "measured",
                    "backends": [
                        {
                            "backend_id": "ollama-llama3-2-3b",
                            "probe_healthy": True,
                            "probe_model_known": True,
                            "probe_model_loaded": True,
                            "latency_ms_p50": 183,
                            "throughput_tps": 37.5,
                            "probe_resident_model_count": 1,
                            "probe_resident_vram_gb": 1.9,
                        }
                    ],
                    "routing_outlook": [],
                },
                "runtime_workers": {
                    "session_count": 1,
                    "active_count": 1,
                    "counts": {"failed": 0},
                    "latest_session": {"runtime_id": "codex", "status": "running", "task_id": "task-1"},
                },
                "reaction_engine": {"enabled": True, "runtime": {"running": True}, "stale": False, "channels": ["desktop"], "last_sent_count": 2},
                "autonomy_maintain": {"last_eval_score": 0.91},
                "swarm": {"active_profile_count": 1, "checkpoint_artifact_count": 2, "active_profiles": [{"topology": "hierarchical"}]},
                "workflow_exports": {"bundle_count": 1, "metrics_count": 1, "argo_contract_count": 1},
            },
            learning={"active_entry_count": 3, "agents_with_active_entries": 2, "prefer_count": 2, "avoid_count": 1, "top_agents": [{"agent_id": "ring-leader"}]},
            runtime_workers={
                "summary": {"session_count": 1, "active_count": 1, "counts": {"failed": 0}},
                "session": {"runtime_id": "codex", "status": "running", "task_id": "task-1"},
                "sessions": [{"runtime_id": "codex", "status": "running", "task_id": "task-1"}],
            },
            autopilot={
                "last_tick": {
                    "confidence_method": {"mode": "gsd-confidence", "score": 0.82, "checks": {"owner_clarity": 0.9}},
                    "learning_signal": {"matched_prefer": 1, "matched_avoid": 0},
                }
            },
            autonomy_maintain={
                "state": {"enabled": True},
                "runtime": {"running": True},
                "due": {"stale": False, "eval": False},
                "subsystems": {
                    "transcript_auto_squish": {"enabled": True, "running": True, "stale": False, "last_error": None},
                    "imprint_auto_snapshot": {"enabled": True, "running": True, "stale": False, "last_error": None},
                    "trichat_auto_retention": {"enabled": True, "running": True, "stale": False, "last_error": None},
                    "trichat_turn_watchdog": {"enabled": True, "running": True, "stale": False, "last_error": None},
                },
            },
            provider_bridge={
                "diagnostics": {
                    "generated_at": "2026-03-30T08:00:00Z",
                    "cached": False,
                    "diagnostics": [
                        {
                            "client_id": "cursor",
                            "display_name": "Cursor",
                            "office_agent_id": "cursor",
                            "status": "connected",
                            "detail": "Cursor is running on this workspace and the MCP bridge is configured.",
                        },
                        {
                            "client_id": "gemini-cli",
                            "display_name": "Gemini CLI",
                            "office_agent_id": "gemini",
                            "status": "configured",
                            "detail": "Gemini bridge configured.",
                        },
                    ],
                }
            },
            errors=[],
        )
        payload = MODULE.build_gui_snapshot(snapshot, "night")
        self.assertEqual(payload["thread_id"], "ring-leader-main")
        self.assertEqual(payload["summary"]["runtime_workers"]["active_count"], 1)
        self.assertEqual(payload["summary"]["router"]["default_backend_id"], "ollama-llama3-2-3b")
        self.assertEqual(payload["summary"]["local_host"]["worker_count"], 9)
        self.assertIn("transcript_auto_squish", payload["summary"]["maintain"]["subsystems"])
        self.assertEqual(payload["summary"]["provider_bridge"]["connected_count"], 1)
        self.assertEqual(payload["summary"]["provider_bridge"]["configured_count"], 1)
        self.assertEqual(payload["counts"]["working"], 1)
        self.assertIn("command", payload["rooms"])
        self.assertTrue(any(agent["agent"]["agent_id"] == "code-smith" for agent in payload["agents"]))
        self.assertEqual(payload["current"]["selected_agent"], "implementation-director")


if __name__ == "__main__":
    unittest.main()
