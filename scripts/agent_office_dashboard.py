#!/usr/bin/env python3
"""Animated MCP-backed office dashboard for local agent monitoring."""

from __future__ import annotations

import argparse
import concurrent.futures
import curses
import json
import os
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def parse_cli_flag_value(argv: List[str], flag: str) -> Optional[str]:
    try:
        index = argv.index(flag)
    except ValueError:
        return None
    if index + 1 >= len(argv):
        return None
    return argv[index + 1]


def load_dotenv_file(dotenv_path: Path) -> None:
    if not dotenv_path.exists():
        return
    try:
        lines = dotenv_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        os.environ[key] = value


def prime_process_env(argv: List[str]) -> None:
    default_repo_root = Path(__file__).resolve().parents[1]
    dotenv_override = os.environ.get("DOTENV_CONFIG_PATH", "").strip()
    if dotenv_override:
        load_dotenv_file(Path(dotenv_override).expanduser())
        return
    repo_root_arg = parse_cli_flag_value(argv, "--repo-root")
    repo_root = Path(repo_root_arg).expanduser() if repo_root_arg else default_repo_root
    load_dotenv_file(repo_root.resolve() / ".env")


prime_process_env(sys.argv[1:])

DEFAULT_THREAD_ID = "ring-leader-main"
DEFAULT_VIEW = "office"
VIEW_ORDER = ["office", "briefing", "lanes", "workers", "help"]
DESK_STATES = {"working", "idle", "blocked", "offline", "supervising"}
STATE_LABELS = {
    "working": "WORK",
    "idle": "IDLE",
    "talking": "CHAT",
    "break": "BREAK",
    "sleeping": "SLEEP",
    "blocked": "BLOCK",
    "offline": "DOWN",
    "supervising": "LEAD",
}
TIER_RANK = {"lead": 0, "director": 1, "leaf": 2, "support": 3}
ROLE_RANK = {
    "orchestrator": 0,
    "implementer": 1,
    "analyst": 2,
    "verifier": 3,
    "planner": 4,
    "reliability-critic": 5,
}


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def truncate(text: str, limit: int = 120) -> str:
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3] + "..."


def compact_single_line(text: str, limit: int = 120) -> str:
    return truncate(" ".join(str(text).split()), limit)


def normalize_agent_id(value: Any) -> str:
    return str(value or "").strip().lower()


def as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def parse_any_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def iso_to_epoch(value: Optional[str]) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def age_seconds(value: Optional[str], now_epoch: Optional[float] = None) -> float:
    epoch = iso_to_epoch(value)
    if epoch <= 0:
        return 1e12
    current = now_epoch if now_epoch is not None else time.time()
    return max(0.0, current - epoch)


def human_duration(seconds: float) -> str:
    if seconds >= 1e11:
        return "n/a"
    if seconds < 60:
        return f"{int(seconds)}s"
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes}m"
    hours = int(minutes // 60)
    minutes = minutes % 60
    return f"{hours}h{minutes:02d}m"


def fit_text(text: str, width: int) -> str:
    width = max(0, int(width))
    if width <= 0:
        return ""
    stripped = str(text)
    if len(stripped) > width:
        return truncate(stripped, width)
    return stripped + (" " * (width - len(stripped)))


def wrap_lines(text: str, width: int, limit: int) -> List[str]:
    if width <= 0 or limit <= 0:
        return []
    wrapped = textwrap.wrap(str(text or ""), width=max(12, width)) or [""]
    return [fit_text(line, width) for line in wrapped[:limit]]


def dedupe(items: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for raw in items:
        item = normalize_agent_id(raw)
        if not item or item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


class McpToolCaller:
    def __init__(
        self,
        repo_root: Path,
        transport: str,
        url: str,
        origin: str,
        stdio_command: str,
        stdio_args: str,
        retries: int,
        retry_delay_seconds: float,
    ) -> None:
        self.repo_root = repo_root
        self.transport = transport
        self.url = url
        self.origin = origin
        self.stdio_command = stdio_command
        self.stdio_args = stdio_args
        self.retries = max(0, retries)
        self.retry_delay_seconds = max(0.05, retry_delay_seconds)
        self.helper = repo_root / "scripts" / "mcp_tool_call.mjs"
        if not self.helper.exists():
            raise RuntimeError(f"missing helper: {self.helper}")

    def call_tool(self, tool: str, args: Dict[str, Any]) -> Any:
        command = [
            "node",
            str(self.helper),
            "--tool",
            tool,
            "--args",
            json.dumps(args, ensure_ascii=True),
            "--transport",
            self.transport,
            "--url",
            self.url,
            "--origin",
            self.origin,
            "--stdio-command",
            self.stdio_command,
            "--stdio-args",
            self.stdio_args,
            "--cwd",
            str(self.repo_root),
        ]
        attempts = self.retries + 1
        last_error = "unknown error"
        for attempt in range(1, attempts + 1):
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode == 0:
                stdout = (proc.stdout or "").strip()
                if not stdout:
                    return {}
                try:
                    return json.loads(stdout)
                except json.JSONDecodeError as error:
                    raise RuntimeError(f"invalid JSON from {tool}: {error}") from error
            stderr = compact_single_line(proc.stderr or "", 360)
            last_error = stderr or f"exit={proc.returncode}"
            if attempt < attempts:
                time.sleep(self.retry_delay_seconds * attempt)
        raise RuntimeError(f"MCP tool failed ({tool}): {last_error}")


@dataclass
class DashboardAgent:
    agent_id: str
    display_name: str
    tier: str
    role: str
    parent_agent_id: str
    managed_agent_ids: List[str]
    accent_color: str
    active: bool

    @property
    def token(self) -> str:
        words = [part for part in self.display_name.split() if part]
        if len(words) >= 2:
            return (words[0][:1] + words[1][:1]).upper()
        if words:
            word = words[0].upper()
            return (word[:2] if len(word) > 1 else word + "X")
        return self.agent_id[:2].upper()


@dataclass
class OfficePresence:
    agent: DashboardAgent
    state: str
    activity: str
    location: str
    actions: List[str]


@dataclass
class DashboardSnapshot:
    thread_id: str
    fetched_at: float
    roster: Dict[str, Any]
    workboard: Dict[str, Any]
    tmux: Dict[str, Any]
    task_summary: Dict[str, Any]
    adapter: Dict[str, Any]
    bus_tail: Dict[str, Any]
    trichat_summary: Dict[str, Any]
    kernel: Dict[str, Any]
    learning: Dict[str, Any]
    autopilot: Dict[str, Any]
    errors: List[str]
    agent_sessions: Dict[str, Any] = field(default_factory=dict)
    task_running: Dict[str, Any] = field(default_factory=dict)
    task_pending: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentTaskSignal:
    state: str
    activity: str
    count: int
    updated_at: str


def build_agent_catalog(roster_payload: Dict[str, Any]) -> Dict[str, DashboardAgent]:
    active_ids = set(dedupe(as_list(roster_payload.get("active_agent_ids"))))
    catalog: Dict[str, DashboardAgent] = {}
    for entry in as_list(roster_payload.get("agents")):
        item = as_dict(entry)
        agent_id = normalize_agent_id(item.get("agent_id"))
        if not agent_id:
            continue
        catalog[agent_id] = DashboardAgent(
            agent_id=agent_id,
            display_name=str(item.get("display_name") or agent_id).strip() or agent_id,
            tier=str(item.get("coordination_tier") or "support").strip().lower() or "support",
            role=str(item.get("role_lane") or "support").strip().lower() or "support",
            parent_agent_id=normalize_agent_id(item.get("parent_agent_id")),
            managed_agent_ids=dedupe(as_list(item.get("managed_agent_ids"))),
            accent_color=str(item.get("accent_color") or "").strip(),
            active=agent_id in active_ids,
        )
    return catalog


def maybe_turn(workboard_payload: Dict[str, Any]) -> Dict[str, Any]:
    active = as_dict(workboard_payload.get("active_turn"))
    if active:
        return active
    latest = as_dict(workboard_payload.get("latest_turn"))
    return latest


def build_task_index(*payloads: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    tasks: Dict[str, Dict[str, Any]] = {}
    for payload in payloads:
        for entry in as_list(as_dict(payload).get("tasks")):
            task = as_dict(entry)
            task_id = str(task.get("task_id") or "").strip()
            if task_id:
                tasks[task_id] = task
    return tasks


def latest_autopilot_session(snapshot: DashboardSnapshot) -> Dict[str, Any]:
    status_session = as_dict(as_dict(snapshot.autopilot.get("session")).get("session"))
    status_metadata = as_dict(status_session.get("metadata"))
    if status_session and str(status_metadata.get("thread_id") or "").strip() == snapshot.thread_id:
        return status_session
    for entry in as_list(snapshot.agent_sessions.get("sessions")):
        session = as_dict(entry)
        metadata = as_dict(session.get("metadata"))
        if str(session.get("client_kind") or "").strip() == "trichat-autopilot" and str(metadata.get("thread_id") or "").strip() == snapshot.thread_id:
            return session
    return status_session


def compact_list_items(items: List[Any], limit: int = 2, item_width: int = 64) -> str:
    tokens = [compact_single_line(str(item), item_width) for item in as_list(items) if str(item).strip()]
    return " | ".join(tokens[:limit])


def primary_delegation_brief(latest_decision: Dict[str, Any], latest_turn: Dict[str, Any], session_metadata: Dict[str, Any]) -> Dict[str, Any]:
    candidates = [
        latest_decision.get("selected_delegation_brief"),
        latest_turn.get("selected_delegation_brief"),
        session_metadata.get("last_selected_delegation_brief"),
    ]
    for candidate in candidates:
        brief = as_dict(candidate)
        if brief:
            return brief
    briefs = as_list(
        latest_decision.get("selected_delegation_briefs")
        or latest_turn.get("selected_delegation_briefs")
        or session_metadata.get("last_selected_delegation_briefs")
    )
    if briefs:
        return as_dict(briefs[0])
    return {}


def add_parent_chain(agent_id: str, catalog: Dict[str, DashboardAgent], bucket: List[str]) -> None:
    current = catalog.get(normalize_agent_id(agent_id))
    while current and current.parent_agent_id:
        if current.parent_agent_id in bucket:
            current = catalog.get(current.parent_agent_id)
            continue
        bucket.append(current.parent_agent_id)
        current = catalog.get(current.parent_agent_id)


def infer_managed_delegate(
    selected: DashboardAgent,
    current_turn: Dict[str, Any],
    catalog: Dict[str, DashboardAgent],
) -> Optional[str]:
    if not selected.managed_agent_ids:
        return None
    haystacks = [
        str(current_turn.get("selected_strategy") or ""),
        str(current_turn.get("decision_summary") or ""),
    ]
    metadata = as_dict(current_turn.get("metadata"))
    for candidate in selected.managed_agent_ids:
        managed = catalog.get(candidate)
        if not managed:
            continue
        display_name = managed.display_name.lower()
        for haystack in haystacks:
            normalized = haystack.lower()
            if candidate in normalized or display_name in normalized:
                return candidate
    specialist_ids = dedupe(as_list(metadata.get("specialist_agent_ids")))
    for candidate in specialist_ids:
        if candidate in selected.managed_agent_ids and candidate in catalog:
            return candidate
    for candidate in selected.managed_agent_ids:
        if candidate in catalog:
            return candidate
    return None


def select_display_agents(
    roster_payload: Dict[str, Any],
    workboard_payload: Dict[str, Any],
) -> List[DashboardAgent]:
    catalog = build_agent_catalog(roster_payload)
    if not catalog:
        return []

    current_turn = maybe_turn(workboard_payload)
    metadata = as_dict(current_turn.get("metadata"))
    desired: List[str] = []

    active_agent_ids = dedupe(as_list(roster_payload.get("active_agent_ids")))
    default_agent_ids = dedupe(as_list(roster_payload.get("default_agent_ids")))

    groups: List[List[str]] = [
        [metadata.get("lead_agent_id"), current_turn.get("selected_agent")],
        as_list(current_turn.get("expected_agents")),
        as_list(metadata.get("specialist_agent_ids")),
        active_agent_ids,
    ]
    if not active_agent_ids:
        groups.append(default_agent_ids)

    for group in groups:
        desired.extend(dedupe(group))

    selected_agent = normalize_agent_id(current_turn.get("selected_agent"))
    if selected_agent in catalog:
        selected = catalog[selected_agent]
        desired.extend(selected.managed_agent_ids)
        delegate = infer_managed_delegate(selected, current_turn, catalog)
        if delegate:
            desired.append(delegate)
            if delegate in catalog:
                desired.extend(catalog[delegate].managed_agent_ids)

    for agent_id in list(dedupe(desired)):
        add_parent_chain(agent_id, catalog, desired)

    if not desired:
        desired.extend(
            agent_id
            for agent_id, agent in sorted(catalog.items())
            if agent.active
        )
    if not desired:
        desired.extend(sorted(catalog.keys()))

    unique = dedupe(desired)
    if len(unique) < min(9, len(catalog)):
        for agent_id, agent in sorted(catalog.items()):
            if not agent.active or agent_id in unique:
                continue
            unique.append(agent_id)

    ordered = [catalog[agent_id] for agent_id in unique if agent_id in catalog]
    ordered.sort(
        key=lambda agent: (
            TIER_RANK.get(agent.tier, 9),
            ROLE_RANK.get(agent.role, 9),
            agent.display_name.lower(),
        )
    )
    return ordered


def build_blocked_notes(adapter_payload: Dict[str, Any], now_epoch: float) -> Dict[str, Tuple[str, str]]:
    blocked: Dict[str, Tuple[str, str]] = {}
    for state_raw in as_list(adapter_payload.get("states")):
        state = as_dict(state_raw)
        agent_id = normalize_agent_id(state.get("agent_id"))
        if not agent_id:
            continue
        last_error = compact_single_line(str(state.get("last_error") or ""), 60)
        last_result = str(state.get("last_result") or "").strip().lower()
        is_open = bool(state.get("open"))
        stale = age_seconds(state.get("updated_at"), now_epoch) > 600
        if stale:
            continue
        if not is_open and last_result not in {"failure", "trip-opened"}:
            continue
        severity = "offline" if "command not found" in last_error or "permission denied" in last_error else "blocked"
        if not last_error:
            last_error = compact_single_line(last_result or "adapter issue", 60)
        blocked[agent_id] = (severity, last_error)
    return blocked


def build_recent_chat_notes(bus_payload: Dict[str, Any], now_epoch: float) -> Dict[str, Tuple[str, float]]:
    notes: Dict[str, Tuple[str, float]] = {}
    for event_raw in reversed(as_list(bus_payload.get("events"))):
        event = as_dict(event_raw)
        agent_id = normalize_agent_id(event.get("source_agent"))
        if not agent_id or agent_id in notes:
            continue
        event_age = age_seconds(event.get("created_at"), now_epoch)
        if event_age > 900:
            continue
        event_type = str(event.get("event_type") or "").strip().lower()
        content = compact_single_line(str(event.get("content") or ""), 56)
        if not content:
            content = compact_single_line(event_type.replace("trichat.", "").replace("_", " "), 56)
        notes[agent_id] = (content or "recent chatter", event_age)
    return notes


def build_adapter_age_map(adapter_payload: Dict[str, Any], now_epoch: float) -> Dict[str, float]:
    ages: Dict[str, float] = {}
    for state_raw in as_list(adapter_payload.get("states")):
        state = as_dict(state_raw)
        agent_id = normalize_agent_id(state.get("agent_id"))
        if not agent_id:
            continue
        age = age_seconds(state.get("updated_at"), now_epoch)
        if agent_id not in ages or age < ages[agent_id]:
            ages[agent_id] = age
    return ages


def infer_task_candidate_agents(
    catalog: Dict[str, DashboardAgent],
    task: Dict[str, Any],
) -> List[str]:
    metadata = as_dict(task.get("metadata"))
    haystacks = " ".join(
        [
            str(task.get("title") or ""),
            str(task.get("command") or ""),
            str(metadata.get("strategy") or ""),
            str(metadata.get("ownership_scope") or ""),
            str(metadata.get("delegate_agent_id") or ""),
            str(as_dict(metadata.get("delegation_brief")).get("delegate_agent_id") or ""),
        ]
    ).lower()
    matches: List[str] = []
    for agent_id, agent in catalog.items():
        if agent_id in haystacks or agent.display_name.lower() in haystacks:
            matches.append(agent_id)
    return dedupe(matches)


def build_agent_task_signal_map(
    catalog: Dict[str, DashboardAgent],
    tmux_payload: Dict[str, Any],
    now_epoch: float,
) -> Dict[str, AgentTaskSignal]:
    status_rank = {"running": 3, "dispatched": 2, "queued": 1}
    signals: Dict[str, AgentTaskSignal] = {}
    for task_raw in as_list(as_dict(tmux_payload.get("state")).get("tasks")):
        task = as_dict(task_raw)
        status = str(task.get("status") or "").strip().lower()
        if status not in status_rank:
            continue
        candidates = infer_task_candidate_agents(catalog, task)
        if not candidates:
            continue
        updated_at = (
            str(task.get("started_at") or task.get("dispatched_at") or task.get("created_at") or "").strip()
        )
        activity = compact_single_line(str(task.get("title") or task.get("command") or "tmux work"), 56)
        for agent_id in candidates:
            existing = signals.get(agent_id)
            if existing and status_rank.get(existing.state, 0) > status_rank.get(status, 0):
                signals[agent_id] = AgentTaskSignal(
                    state=existing.state,
                    activity=existing.activity,
                    count=existing.count + 1,
                    updated_at=existing.updated_at,
                )
                continue
            signals[agent_id] = AgentTaskSignal(
                state=status,
                activity=activity,
                count=(existing.count if existing else 0) + 1,
                updated_at=updated_at,
            )
    return signals


def current_focus_task(tmux_payload: Dict[str, Any]) -> str:
    state = as_dict(tmux_payload.get("state"))
    for task_raw in as_list(state.get("tasks")):
        task = as_dict(task_raw)
        status = str(task.get("status") or "").strip().lower()
        if status not in {"running", "dispatched", "queued"}:
            continue
        title = compact_single_line(str(task.get("title") or ""), 38)
        command = compact_single_line(str(task.get("command") or ""), 38)
        return title or command or "active tmux lane"
    return "waiting for next bounded task"


def infer_role_action(agent: DashboardAgent, activity: str) -> str:
    haystack = f"{agent.role} {activity}".lower()
    if any(token in haystack for token in ("verify", "regression", "test", "release", "failure")):
        return "verify"
    if any(token in haystack for token in ("research", "compare", "unknown", "evidence gap", "option")):
        return "research"
    if any(token in haystack for token in ("delegate", "brief", "handoff", "queue", "orchestr")):
        return "brief"
    if any(token in haystack for token in ("build", "diff", "code", "implement", "fix", "patch")):
        return "code"
    return {
        "orchestrator": "brief",
        "planner": "plan",
        "implementer": "code",
        "analyst": "research",
        "verifier": "verify",
        "reliability-critic": "stabilize",
    }.get(agent.role, "ready")


def build_action_tags(
    agent: DashboardAgent,
    state: str,
    location: str,
    activity: str,
    queue_count: int = 0,
) -> List[str]:
    tags: List[str] = []
    primary = {
        "working": "desk",
        "supervising": "brief",
        "talking": "chat",
        "break": "break",
        "sleeping": "sleep",
        "blocked": "blocked",
        "offline": "offline",
        "idle": "ready",
    }.get(state, "ready")
    tags.append(primary)
    if state in {"working", "supervising", "idle"}:
        tags.append(infer_role_action(agent, activity))
    if location == "cooler":
        tags.append("coffee")
    elif location == "lounge":
        tags.append("reset")
    elif location == "sofa":
        tags.append("nap")
    if queue_count > 1 and state in {"working", "supervising"}:
        tags.append("multi")
    return dedupe(tags)[:3]


def infer_focus_assignment(
    selected_agent_id: str,
    current_turn: Dict[str, Any],
    catalog: Dict[str, DashboardAgent],
) -> Tuple[str, List[str]]:
    selected_id = normalize_agent_id(selected_agent_id)
    if not selected_id or selected_id not in catalog:
        return "", []
    selected = catalog[selected_id]
    supervisors: List[str] = []
    if selected.tier == "director" and selected.managed_agent_ids:
        delegate = infer_managed_delegate(selected, current_turn, catalog)
        if delegate:
            supervisors.append(selected_id)
            return delegate, supervisors
    if selected.tier == "lead" and selected.managed_agent_ids:
        delegate = infer_managed_delegate(selected, current_turn, catalog)
        if delegate and delegate in catalog:
            delegate_agent = catalog[delegate]
            supervisors.append(selected_id)
            if delegate_agent.tier == "director" and delegate_agent.managed_agent_ids:
                nested = infer_managed_delegate(delegate_agent, current_turn, catalog)
                if nested:
                    supervisors.append(delegate)
                    return nested, supervisors
            return delegate, supervisors
    return selected_id, supervisors


def derive_presence_map(
    agents: List[DashboardAgent],
    workboard_payload: Dict[str, Any],
    tmux_payload: Dict[str, Any],
    adapter_payload: Dict[str, Any],
    bus_payload: Dict[str, Any],
    now_epoch: Optional[float] = None,
) -> List[OfficePresence]:
    now_epoch = now_epoch if now_epoch is not None else time.time()
    catalog = {agent.agent_id: agent for agent in agents}
    current_turn = maybe_turn(workboard_payload)
    turn_recent = age_seconds(current_turn.get("updated_at"), now_epoch) <= 300
    expected_agents = set(dedupe(as_list(current_turn.get("expected_agents"))))
    selected_agent = normalize_agent_id(current_turn.get("selected_agent"))
    blocked_notes = build_blocked_notes(adapter_payload, now_epoch)
    recent_chat = build_recent_chat_notes(bus_payload, now_epoch)
    adapter_ages = build_adapter_age_map(adapter_payload, now_epoch)
    task_signals = build_agent_task_signal_map(catalog, tmux_payload, now_epoch)
    focus_agent, supervisors = infer_focus_assignment(selected_agent, current_turn, catalog)
    focus_task = current_focus_task(tmux_payload)
    disagreement = bool(current_turn.get("disagreement"))
    active_tmux = parse_any_int(as_dict(tmux_payload.get("state")).get("counts", {}).get("running")) > 0
    presences: List[OfficePresence] = []

    for agent in agents:
        state = "idle"
        location = "desk"
        activity = "standing by"
        queue_count = 0
        blocked = blocked_notes.get(agent.agent_id)
        task_signal = task_signals.get(agent.agent_id)
        chat_signal = recent_chat.get(agent.agent_id)
        signal_ages = [adapter_ages.get(agent.agent_id, 1e12)]
        if task_signal:
            signal_ages.append(age_seconds(task_signal.updated_at, now_epoch))
            queue_count = task_signal.count
        if chat_signal:
            signal_ages.append(chat_signal[1])
        if turn_recent and (agent.agent_id == focus_agent or agent.agent_id in expected_agents or agent.agent_id in supervisors):
            signal_ages.append(age_seconds(current_turn.get("updated_at"), now_epoch))
        freshest_signal_age = min(signal_ages) if signal_ages else 1e12
        if blocked:
            severity, detail = blocked
            state = "offline" if severity == "offline" else "blocked"
            activity = detail
            location = "desk"
        elif task_signal and task_signal.state == "running":
            state = "working"
            location = "desk"
            activity = task_signal.activity
        elif turn_recent and agent.agent_id == focus_agent:
            state = "working" if active_tmux else "supervising"
            activity = focus_task if active_tmux else compact_single_line(str(current_turn.get("selected_strategy") or ""), 56)
        elif turn_recent and agent.agent_id in supervisors:
            state = "supervising"
            focus_label = catalog.get(focus_agent).display_name if focus_agent in catalog else "delegate"
            activity = compact_single_line(f"directing {focus_label}", 56)
        elif turn_recent and agent.agent_id in expected_agents and (disagreement or agent.agent_id in recent_chat):
            state = "talking"
            location = "cooler"
            activity = chat_signal[0] if chat_signal else "council chatter"
        elif chat_signal and chat_signal[1] <= 240:
            state = "talking"
            location = "cooler"
            activity = chat_signal[0]
        elif chat_signal:
            state = "break"
            location = "lounge"
            activity = chat_signal[0]
        elif task_signal and task_signal.state in {"queued", "dispatched"}:
            state = "idle"
            activity = compact_single_line(f"queued: {task_signal.activity}", 56)
        elif turn_recent and agent.agent_id in expected_agents:
            state = "idle"
            activity = "waiting on the next turn"
        elif agent.active and freshest_signal_age > 1800:
            state = "sleeping"
            location = "sofa"
            activity = "saving energy until the next bounded task"
        actions = build_action_tags(agent, state, location, activity, queue_count=queue_count)
        presences.append(
            OfficePresence(
                agent=agent,
                state=state,
                activity=compact_single_line(activity or "standing by", 56),
                location=location,
                actions=actions,
            )
        )
    return presences


def state_counts(presences: List[OfficePresence]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for presence in presences:
        counts[presence.state] = counts.get(presence.state, 0) + 1
    return counts


def sprite_lines(presence: OfficePresence, frame: int) -> Tuple[str, str]:
    hat = {
        "lead": " ^_^ ",
        "director": " *^* ",
        "leaf": " ._. ",
        "support": " ~^~ ",
    }.get(presence.agent.tier, " .-. ")
    token = presence.agent.token
    if presence.state == "working":
        body = f" <{token}) " if frame % 2 else f" ({token}> "
    elif presence.state == "supervising":
        body = f" ({token})! "
    elif presence.state == "break":
        body = f" ({token})~ "
    elif presence.state == "sleeping":
        body = f" ({token})_ "
    elif presence.state == "blocked":
        body = f" ({token})x "
    elif presence.state == "offline":
        body = f" [{token}]  "
    elif presence.state == "idle":
        body = f" ({token})z "
    else:
        body = f" \\{token}/ "
    return hat, body


def render_agent_card(presence: OfficePresence, width: int, frame: int) -> List[str]:
    width = max(22, width)
    inner = width - 2
    title_left = f"{presence.agent.token} {presence.agent.display_name}"
    title = fit_text(title_left, max(0, inner - 6))
    status = STATE_LABELS.get(presence.state, presence.state[:5].upper())
    top = "." + ("-" * inner) + "."
    bottom = "'" + ("-" * inner) + "'"

    sprite_a, sprite_b = sprite_lines(presence, frame)
    monitor = "[==]" if presence.state == "working" else "[!!]" if presence.state == "blocked" else "[--]" if presence.state == "offline" else "[..]"
    companion = {
        "cooler": "coffee + chat",
        "lounge": "stretch + water",
        "sofa": "nap pod",
    }.get(presence.location, "pc + mug")
    mood = {
        "working": "typing hard",
        "supervising": "briefing team",
        "break": "between tasks",
        "sleeping": "offline dreaming",
        "blocked": "needs help",
        "offline": "bridge down",
        "idle": "light idle",
        "talking": "away at cooler",
    }.get(presence.state, "holding steady")
    badges = " ".join(f"[{tag}]" for tag in presence.actions) or "[ready]"

    return [
        top,
        "|" + fit_text(f"{title}{status.rjust(max(0, inner - len(title)))}", inner) + "|",
        "|" + fit_text(f"{monitor} {companion}", inner) + "|",
        "|" + fit_text(sprite_a, inner) + "|",
        "|" + fit_text(sprite_b, inner) + "|",
        "|" + fit_text(badges, inner) + "|",
        "|" + fit_text(compact_single_line(f"{mood} :: {presence.activity}", inner), inner) + "|",
        bottom,
    ]


def render_card_grid(cards: List[List[str]], columns: int, gap: int = 2) -> List[str]:
    if not cards:
        return []
    columns = max(1, columns)
    card_height = len(cards[0])
    rows: List[str] = []
    for index in range(0, len(cards), columns):
        group = cards[index : index + columns]
        for line_index in range(card_height):
            rows.append((" " * gap).join(card[line_index] for card in group))
        if index + columns < len(cards):
            rows.append("")
    return rows


def render_lounge_line(presences: List[OfficePresence], width: int, frame: int) -> List[str]:
    width = max(20, width)
    chatter = [presence for presence in presences if presence.state == "talking"]
    breakers = [presence for presence in presences if presence.state == "break"]
    sleepers = [presence for presence in presences if presence.state == "sleeping"]
    if not chatter and not breakers and not sleepers:
        return [fit_text("Coffee [::]  Water [OO]  Sofa [__]  Break room is quiet; everyone is on task.", width)]
    lines = [fit_text("Coffee [::]  Water [OO]  Sofa [__]  Break room activity:", width)]
    for label, group in (("Cooler", chatter), ("Break", breakers), ("Sofa", sleepers)):
        if not group:
            continue
        tokens: List[str] = []
        for presence in group:
            _, body = sprite_lines(presence, frame)
            tokens.append(compact_single_line(f"{body.strip()} {presence.agent.display_name}", 22))
        lines.append(fit_text(f"{label}: {'  '.join(tokens)}", width))
    return lines


def render_office_view(snapshot: DashboardSnapshot, width: int, height: int, frame: int) -> List[str]:
    agents = select_display_agents(snapshot.roster, snapshot.workboard)
    presences = derive_presence_map(
        agents,
        snapshot.workboard,
        snapshot.tmux,
        snapshot.adapter,
        snapshot.bus_tail,
        snapshot.fetched_at,
    )
    counts = state_counts(presences)
    banner = (
        f"Books [====]  Coffee [::]  Water [OO]  "
        f"work={counts.get('working', 0)} lead={counts.get('supervising', 0)} "
        f"chat={counts.get('talking', 0)} break={counts.get('break', 0)} "
        f"sleep={counts.get('sleeping', 0)} blocked={counts.get('blocked', 0) + counts.get('offline', 0)} "
        f"learned={parse_any_int(snapshot.learning.get('active_entry_count'))}"
    )
    available_width = max(40, width)
    columns = 3 if available_width >= 94 else 2 if available_width >= 62 else 1
    gap = 2
    card_width = max(22, min(30, (available_width - (gap * (columns - 1))) // columns))
    cards = [render_agent_card(presence, card_width, frame) for presence in presences]
    lines = [
        fit_text("PIXEL OFFICE :: Ring leader, directors, leaf agents, and support lanes", available_width),
        fit_text(banner, available_width),
        "",
    ]
    lines.extend(render_card_grid(cards, columns=columns, gap=gap))
    lines.append("")
    lines.extend(render_lounge_line(presences, available_width, frame))
    return lines[: max(1, height)]


def render_briefing_view(snapshot: DashboardSnapshot, width: int, height: int) -> List[str]:
    workboard = snapshot.workboard
    latest = as_dict(workboard.get("latest_turn"))
    latest_decision = as_dict(workboard.get("latest_decision"))
    task_index = build_task_index(snapshot.task_running, snapshot.task_pending)
    tmux_state = as_dict(snapshot.tmux.get("state"))
    tmux_dashboard = as_dict(snapshot.tmux.get("dashboard"))
    task_counts = as_dict(snapshot.task_summary.get("counts"))
    kernel = snapshot.kernel
    kernel_overview = as_dict(kernel.get("overview"))
    kernel_tasks = as_dict(as_dict(kernel.get("tasks")).get("counts"))
    learning = snapshot.learning
    learning_top_agents = as_list(learning.get("top_agents"))
    kernel_learning = as_dict(kernel.get("learning"))
    learning_coverage = as_dict(kernel_learning.get("active_session_coverage"))
    autopilot = snapshot.autopilot
    autopilot_session = latest_autopilot_session(snapshot)
    autopilot_session_metadata = as_dict(autopilot_session.get("metadata"))
    last_tick = as_dict(autopilot.get("last_tick"))
    if not last_tick:
        last_tick = {
            "ok": autopilot_session_metadata.get("last_tick_ok"),
            "reason": autopilot_session_metadata.get("last_tick_reason"),
        }
    learning_signal = as_dict(last_tick.get("learning_signal"))
    if not learning_signal:
        learning_signal = as_dict(autopilot_session_metadata.get("last_learning_signal"))
    current_task_id = (
        str(autopilot_session_metadata.get("current_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_source_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_claimed_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_execution_task_id") or "").strip()
    )
    current_task = task_index.get(current_task_id, {})
    current_objective = compact_single_line(
        str(
            current_task.get("objective")
            or as_dict(current_task.get("payload")).get("task_objective")
            or autopilot_session_metadata.get("last_source_task_objective")
            or ""
        ),
        220,
    )
    delegation_brief = primary_delegation_brief(latest_decision, latest, autopilot_session_metadata)
    execution_task_ids = dedupe(
        as_list(as_dict(last_tick.get("execution")).get("task_ids"))
        + as_list(autopilot_session_metadata.get("last_execution_task_ids"))
    )
    lines = [
        fit_text("BRIEFING BOARD", width),
        fit_text(f"Thread: {snapshot.thread_id}", width),
        fit_text(f"Snapshot: {now_iso()} | data age {human_duration(time.time() - snapshot.fetched_at)}", width),
        "",
        fit_text(
            "Tasks :: "
            f"pending={parse_any_int(task_counts.get('pending'))} "
            f"running={parse_any_int(task_counts.get('running'))} "
            f"failed={parse_any_int(task_counts.get('failed'))} "
            f"completed={parse_any_int(task_counts.get('completed'))}",
            width,
        ),
        fit_text(
            "Tmux :: "
            f"enabled={'yes' if tmux_state.get('enabled') else 'no'} "
            f"workers={parse_any_int(tmux_state.get('worker_count'))} "
            f"queue={parse_any_int(tmux_dashboard.get('queue_depth'))} "
            f"queue_age={human_duration(float(tmux_dashboard.get('queue_age_seconds') or 0))}",
            width,
        ),
        fit_text(
            "Kernel :: "
            f"state={kernel.get('state') or 'n/a'} "
            f"active_sessions={parse_any_int(kernel_overview.get('active_session_count'))} "
            f"failed={parse_any_int(kernel_tasks.get('failed'))}",
            width,
        ),
        fit_text(
            "Learning :: "
            f"active={parse_any_int(learning.get('active_entry_count'))} "
            f"agents={parse_any_int(learning.get('agents_with_active_entries'))} "
            f"prefer={parse_any_int(learning.get('prefer_count'))} "
            f"avoid={parse_any_int(learning.get('avoid_count'))} "
            f"coverage={parse_any_int(learning_coverage.get('covered_agent_count'))}/{parse_any_int(learning_coverage.get('active_session_agent_count'))}",
            width,
        ),
        "",
        fit_text(
            "Latest decision :: "
            f"selected={latest_decision.get('selected_agent') or latest.get('selected_agent') or 'n/a'} "
            f"novelty={latest.get('novelty_score') if latest else 'n/a'} "
            f"verify={latest.get('verify_status') or 'n/a'}",
            width,
        ),
    ]
    if last_tick:
        adjustment = float(learning_signal.get("confidence_adjustment") or 0)
        lines.append(
            fit_text(
                "Ring leader :: "
                f"tick_ok={'yes' if last_tick.get('ok') else 'no'} "
                f"prefer={parse_any_int(learning_signal.get('matched_prefer'))} "
                f"avoid={parse_any_int(learning_signal.get('matched_avoid'))} "
                f"adj={adjustment:+.2f}",
                width,
            )
        )
        rationale = as_list(learning_signal.get("rationale"))
        if rationale:
            lines.extend(wrap_lines(f"Learning signal: {rationale[0]}", width, 2))
        lines.append("")
    attention = as_list(kernel.get("attention"))[:2]
    if attention:
        lines.append(fit_text("Kernel attention:", width))
        for entry in attention:
            lines.extend(wrap_lines(f"- {entry}", width, 2))
        lines.append("")
    summary_text = latest_decision.get("decision_summary") or latest.get("decision_summary") or "No turn decision recorded yet."
    lines.extend(wrap_lines(summary_text, width, 4))
    strategy = latest_decision.get("selected_strategy") or latest.get("selected_strategy") or ""
    if strategy:
        lines.append("")
        lines.append(fit_text("Selected strategy:", width))
        lines.extend(wrap_lines(strategy, width, 4))
    if current_objective:
        lines.append("")
        lines.append(fit_text("Current objective:", width))
        lines.extend(wrap_lines(current_objective, width, 4))
    if delegation_brief:
        lines.append("")
        lines.append(fit_text("Delegation brief:", width))
        delegate_line = compact_single_line(
            f"delegate={delegation_brief.get('delegate_agent_id') or 'n/a'} objective={delegation_brief.get('task_objective') or 'n/a'}",
            220,
        )
        lines.extend(wrap_lines(delegate_line, width, 4))
        success_summary = compact_list_items(as_list(delegation_brief.get("success_criteria")))
        if success_summary:
            lines.extend(wrap_lines(f"Success: {success_summary}", width, 4))
        evidence_summary = compact_list_items(as_list(delegation_brief.get("evidence_requirements")))
        if evidence_summary:
            lines.extend(wrap_lines(f"Evidence: {evidence_summary}", width, 4))
        rollback_summary = compact_list_items(as_list(delegation_brief.get("rollback_notes")))
        if rollback_summary:
            lines.extend(wrap_lines(f"Rollback: {rollback_summary}", width, 4))
    if execution_task_ids:
        lines.append("")
        lines.append(fit_text("Execution backlog:", width))
        for task_id in execution_task_ids[:4]:
            task = task_index.get(str(task_id), {})
            title = compact_single_line(str(task.get("objective") or task.get("task_id") or task_id), 96)
            lines.append(fit_text(f"- {task_id}: {title}", width))
    if learning_top_agents:
        lines.append("")
        lines.append(fit_text("Most learned agents:", width))
        for agent_raw in learning_top_agents[:4]:
            agent = as_dict(agent_raw)
            top_summaries = as_list(agent.get("top_summaries"))
            summary = compact_single_line(str(top_summaries[0] or "no active lessons"), 72)
            lines.append(
                fit_text(
                    f"- {agent.get('agent_id') or 'agent'} active={parse_any_int(agent.get('active_entry_count'))} "
                    f"prefer={parse_any_int(agent.get('prefer_count'))} avoid={parse_any_int(agent.get('avoid_count'))} :: {summary}",
                    width,
                )
            )
    lines.append("")
    lines.append(fit_text("Busiest threads:", width))
    for thread_raw in as_list(snapshot.trichat_summary.get("busiest_threads"))[:6]:
        thread = as_dict(thread_raw)
        lines.append(
            fit_text(
                f"- {thread.get('thread_id') or 'n/a'} msgs={thread.get('message_count') or 0} status={thread.get('status') or 'n/a'}",
                width,
            )
        )
    return lines[: max(1, height)]


def render_lanes_view(snapshot: DashboardSnapshot, width: int, height: int) -> List[str]:
    tmux_dashboard = as_dict(snapshot.tmux.get("dashboard"))
    tmux_state = as_dict(snapshot.tmux.get("state"))
    lines = [
        fit_text("TMUX LANE MONITOR", width),
        fit_text(
            f"session={tmux_state.get('session_name') or 'n/a'} "
            f"session_active={'yes' if snapshot.tmux.get('session_active') else 'no'} "
            f"enabled={'yes' if tmux_state.get('enabled') else 'no'} "
            f"fail_class={tmux_dashboard.get('failure_class') or 'none'} "
            f"fail_count={parse_any_int(tmux_dashboard.get('failure_count'))}",
            width,
        ),
        fit_text(
            f"queue_depth={parse_any_int(tmux_dashboard.get('queue_depth'))} "
            f"oldest={tmux_dashboard.get('queue_oldest_task_id') or 'n/a'}",
            width,
        ),
        "",
    ]
    workers = as_list(tmux_dashboard.get("worker_load"))
    if not workers:
        lines.append(fit_text("No worker lanes reported yet.", width))
        return lines[: max(1, height)]
    for worker_raw in workers:
        worker = as_dict(worker_raw)
        header = (
            f"{worker.get('worker_id') or 'worker'} "
            f"state={worker.get('lane_state') or 'unknown'} "
            f"queue={parse_any_int(worker.get('active_queue'))} "
            f"load={parse_any_int(worker.get('active_load'))}"
        )
        lines.append(fit_text(header, width))
        signal = compact_single_line(str(worker.get("lane_signal") or "no lane signal"), width)
        lines.append(fit_text(f"  -> {signal}", width))
        updated = str(worker.get("lane_updated_at") or "").strip()
        if updated:
            lines.append(fit_text(f"  updated {updated}", width))
        lines.append("")
    return lines[: max(1, height)]


def render_workers_view(snapshot: DashboardSnapshot, width: int, height: int) -> List[str]:
    tmux_state = as_dict(snapshot.tmux.get("state"))
    tasks = as_list(tmux_state.get("tasks"))
    fallback_backlog = [
        as_dict(task)
        for task in as_list(snapshot.task_pending.get("tasks")) + as_list(snapshot.task_running.get("tasks"))
        if str(as_dict(task).get("source") or "").strip() == "trichat.autopilot"
        or str(as_dict(as_dict(task).get("metadata")).get("task_mode") or "").strip() == "autopilot_specialist_fallback"
    ]
    catalog = build_agent_catalog(snapshot.roster)
    learning_by_agent = {
        normalize_agent_id(as_dict(agent).get("agent_id")): as_dict(agent)
        for agent in as_list(snapshot.learning.get("top_agents"))
    }
    lines = [
        fit_text("WORKER TASK QUEUE", width),
        fit_text(
            f"total={parse_any_int(as_dict(tmux_state.get('counts')).get('total'))} "
            f"running={parse_any_int(as_dict(tmux_state.get('counts')).get('running'))} "
            f"queued={parse_any_int(as_dict(tmux_state.get('counts')).get('queued'))} "
            f"dispatched={parse_any_int(as_dict(tmux_state.get('counts')).get('dispatched'))}",
            width,
        ),
        "",
    ]
    if not tasks and not fallback_backlog:
        lines.append(fit_text("No tmux tasks recorded.", width))
        return lines[: max(1, height)]
    for task_raw in tasks[: max(4, height - 6)]:
        task = as_dict(task_raw)
        metadata = as_dict(task.get("metadata"))
        header = (
            f"{task.get('task_id') or 'task'} "
            f"[{task.get('status') or 'n/a'}] "
            f"{task.get('worker_id') or 'unassigned'}"
        )
        lines.append(fit_text(header, width))
        title = compact_single_line(str(task.get("title") or task.get("command") or "untitled task"), width - 2)
        lines.append(fit_text(f"  {title}", width))
        strategy = compact_single_line(str(metadata.get("strategy") or ""), width - 2)
        if strategy:
            lines.append(fit_text(f"  brief: {strategy}", width))
        ownership_scope = compact_single_line(str(metadata.get("ownership_scope") or ""), width - 2)
        if ownership_scope:
            lines.append(fit_text(f"  scope: {ownership_scope}", width))
        matched_agents = infer_task_candidate_agents(catalog, task)
        for agent_id in matched_agents[:2]:
            learning = learning_by_agent.get(agent_id, {})
            top_summaries = as_list(learning.get("top_summaries"))
            if not learning:
                continue
            lines.append(
                fit_text(
                    f"  learn[{agent_id}]: active={parse_any_int(learning.get('active_entry_count'))} "
                    f"prefer={parse_any_int(learning.get('prefer_count'))} avoid={parse_any_int(learning.get('avoid_count'))} "
                    f"{compact_single_line(str(top_summaries[0] or 'no active lessons'), 54)}",
                    width,
                )
            )
        lines.append("")
    if fallback_backlog:
        lines.append(fit_text("Autopilot specialist backlog:", width))
        for task in fallback_backlog[: max(2, height - len(lines) - 2)]:
            payload = as_dict(task.get("payload"))
            metadata = as_dict(task.get("metadata"))
            task_id = str(task.get("task_id") or "task").strip()
            lines.append(
                fit_text(
                    f"{task_id} [{task.get('status') or 'n/a'}] delegate={payload.get('delegate_agent_id') or metadata.get('delegate_agent_id') or 'n/a'}",
                    width,
                )
            )
            objective = compact_single_line(
                str(task.get("objective") or payload.get("task_objective") or "untitled task"),
                width - 2,
            )
            lines.append(fit_text(f"  {objective}", width))
            evidence_summary = compact_list_items(as_list(payload.get("evidence_requirements")))
            if evidence_summary:
                lines.append(fit_text(f"  evidence: {evidence_summary}", width))
            lines.append("")
    return lines[: max(1, height)]


def render_help_view(width: int, height: int) -> List[str]:
    lines = [
        fit_text("HELP", width),
        fit_text("1 Office   2 Briefing   3 Lanes   4 Workers   h Help", width),
        fit_text("r Refresh  p Pause      q Quit", width),
        "",
        fit_text("The office scene is driven by MCP tools:", width),
        fit_text("- trichat.roster", width),
        fit_text("- trichat.workboard", width),
        fit_text("- trichat.tmux_controller", width),
        fit_text("- trichat.bus", width),
        fit_text("- trichat.adapter_telemetry", width),
        fit_text("- task.summary", width),
        fit_text("- trichat.summary", width),
        fit_text("- kernel.summary", width),
        fit_text("- agent.learning_summary", width),
        fit_text("- agent.session_list", width),
        fit_text("- task.list (running/pending)", width),
        fit_text("- trichat.autopilot(status)", width),
        "",
        fit_text("Agents can stack action badges: desk/code, brief/multi, chat/coffee, break/reset, or sleep/nap.", width),
    ]
    return lines[: max(1, height)]


def render_view(snapshot: DashboardSnapshot, view: str, width: int, height: int, frame: int) -> List[str]:
    if view == "briefing":
        return render_briefing_view(snapshot, width, height)
    if view == "lanes":
        return render_lanes_view(snapshot, width, height)
    if view == "workers":
        return render_workers_view(snapshot, width, height)
    if view == "help":
        return render_help_view(width, height)
    return render_office_view(snapshot, width, height, frame)


def color_for_state(state: str) -> int:
    mapping = {
        "working": 3,
        "supervising": 4,
        "talking": 5,
        "break": 1,
        "sleeping": 7,
        "blocked": 6,
        "offline": 6,
        "idle": 2,
    }
    return mapping.get(state, 2)


def init_colors() -> None:
    if not curses.has_colors():
        return
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_CYAN, -1)
    curses.init_pair(2, curses.COLOR_WHITE, -1)
    curses.init_pair(3, curses.COLOR_GREEN, -1)
    curses.init_pair(4, curses.COLOR_YELLOW, -1)
    curses.init_pair(5, curses.COLOR_MAGENTA, -1)
    curses.init_pair(6, curses.COLOR_RED, -1)
    curses.init_pair(7, curses.COLOR_BLUE, -1)


def safe_addstr(screen: Any, y: int, x: int, text: str, attr: int = 0) -> None:
    try:
        screen.addstr(y, x, text[: max(0, screen.getmaxyx()[1] - x - 1)], attr)
    except curses.error:
        return


def pick_resume_thread(caller: McpToolCaller) -> str:
    try:
        listing = caller.call_tool("trichat.thread_list", {"status": "active", "limit": 20})
    except Exception:
        return DEFAULT_THREAD_ID
    for candidate_raw in as_list(as_dict(listing).get("threads")):
        candidate = as_dict(candidate_raw)
        thread_id = str(candidate.get("thread_id") or "").strip()
        if thread_id and "smoke" not in thread_id.lower():
            return thread_id
    return DEFAULT_THREAD_ID


def fetch_snapshot(caller: McpToolCaller, thread_id: str) -> DashboardSnapshot:
    requests = {
        "roster": ("trichat.roster", {"active_only": False}),
        "workboard": ("trichat.workboard", {"thread_id": thread_id, "limit": 12}),
        "tmux": ("trichat.tmux_controller", {"action": "status"}),
        "task_summary": ("task.summary", {"running_limit": 12}),
        "task_running": ("task.list", {"status": "running", "limit": 32}),
        "task_pending": ("task.list", {"status": "pending", "limit": 32}),
        "agent_sessions": ("agent.session_list", {"limit": 50}),
        "adapter": ("trichat.adapter_telemetry", {"action": "status", "include_events": True, "event_limit": 12}),
        "bus_tail": ("trichat.bus", {"action": "tail", "thread_id": thread_id, "limit": 40}),
        "trichat_summary": ("trichat.summary", {"busiest_limit": 6}),
        "kernel": ("kernel.summary", {"session_limit": 6, "event_limit": 6, "task_running_limit": 8}),
        "learning": ("agent.learning_summary", {"limit": 200, "top_agents_limit": 8, "recent_limit": 8}),
        "autopilot": ("trichat.autopilot", {"action": "status"}),
    }
    results: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(requests)) as pool:
        futures = {
            pool.submit(caller.call_tool, tool, args): name
            for name, (tool, args) in requests.items()
        }
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                results[name] = as_dict(future.result())
            except Exception as error:  # noqa: BLE001
                results[name] = {}
                errors.append(compact_single_line(f"{name}: {error}", 160))
    return DashboardSnapshot(
        thread_id=thread_id,
        fetched_at=time.time(),
        roster=results.get("roster", {}),
        workboard=results.get("workboard", {}),
        tmux=results.get("tmux", {}),
        task_summary=results.get("task_summary", {}),
        task_running=results.get("task_running", {}),
        task_pending=results.get("task_pending", {}),
        agent_sessions=results.get("agent_sessions", {}),
        adapter=results.get("adapter", {}),
        bus_tail=results.get("bus_tail", {}),
        trichat_summary=results.get("trichat_summary", {}),
        kernel=results.get("kernel", {}),
        learning=results.get("learning", {}),
        autopilot=results.get("autopilot", {}),
        errors=errors,
    )


class OfficeDashboardApp:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.repo_root = Path(args.repo_root).resolve()
        self.caller = McpToolCaller(
            repo_root=self.repo_root,
            transport=args.transport,
            url=args.url,
            origin=args.origin,
            stdio_command=args.stdio_command,
            stdio_args=args.stdio_args,
            retries=args.mcp_retries,
            retry_delay_seconds=args.mcp_retry_delay,
        )
        self.thread_id = args.thread_id or (pick_resume_thread(self.caller) if args.resume_latest else DEFAULT_THREAD_ID)
        self.view = args.view if args.view in VIEW_ORDER else DEFAULT_VIEW
        self.paused = False
        self.last_error = ""
        self.snapshot: Optional[DashboardSnapshot] = None
        self.last_refresh_started = 0.0

    def refresh(self) -> None:
        self.last_refresh_started = time.time()
        try:
            self.snapshot = fetch_snapshot(self.caller, self.thread_id)
            if self.snapshot.errors:
                self.last_error = " | ".join(self.snapshot.errors[:2])
            else:
                self.last_error = ""
        except Exception as error:  # noqa: BLE001
            self.last_error = compact_single_line(str(error), 180)

    def run_once(self) -> int:
        self.refresh()
        snapshot = self.snapshot or DashboardSnapshot(
            thread_id=self.thread_id,
            fetched_at=time.time(),
            roster={},
            workboard={},
            tmux={},
            task_summary={},
            adapter={},
            bus_tail={},
            trichat_summary={},
            kernel={},
            learning={},
            autopilot={},
            errors=[self.last_error] if self.last_error else [],
        )
        lines = render_view(snapshot, self.view, self.args.width, self.args.height, frame=0)
        print("\n".join(lines))
        if self.last_error:
            print(f"\nERROR: {self.last_error}")
        return 0

    def run_curses(self) -> int:
        return curses.wrapper(self._curses_main)

    def _curses_main(self, screen: Any) -> int:
        curses.curs_set(0)
        screen.nodelay(True)
        screen.timeout(120)
        init_colors()
        self.refresh()
        next_refresh_at = time.monotonic() + max(0.5, float(self.args.refresh_interval))
        while True:
            height, width = screen.getmaxyx()
            frame = int(time.monotonic() * 4.0)
            if not self.paused and time.monotonic() >= next_refresh_at:
                self.refresh()
                next_refresh_at = time.monotonic() + max(0.5, float(self.args.refresh_interval))
            self._render(screen, width, height, frame)
            key = screen.getch()
            if key < 0:
                continue
            normalized = chr(key).lower() if 0 <= key <= 255 else ""
            if normalized == "q":
                return 0
            if normalized == "1":
                self.view = "office"
            elif normalized == "2":
                self.view = "briefing"
            elif normalized == "3":
                self.view = "lanes"
            elif normalized == "4":
                self.view = "workers"
            elif normalized == "h":
                self.view = "help"
            elif normalized == "r":
                self.refresh()
                next_refresh_at = time.monotonic() + max(0.5, float(self.args.refresh_interval))
            elif normalized == "p":
                self.paused = not self.paused

    def _render(self, screen: Any, width: int, height: int, frame: int) -> None:
        screen.erase()
        snapshot = self.snapshot or DashboardSnapshot(
            thread_id=self.thread_id,
            fetched_at=time.time(),
            roster={},
            workboard={},
            tmux={},
            task_summary={},
            adapter={},
            bus_tail={},
            trichat_summary={},
            kernel={},
            learning={},
            autopilot={},
            errors=[self.last_error] if self.last_error else [],
        )
        header = (
            f"Agent Office Dashboard [{self.view}] "
            f"thread={self.thread_id} refresh={self.args.refresh_interval:.1f}s "
            f"{'PAUSED' if self.paused else 'LIVE'}"
        )
        help_line = "1 office  2 briefing  3 lanes  4 workers  h help  r refresh  p pause  q quit"
        safe_addstr(screen, 0, 0, fit_text(header, width), curses.color_pair(1) | curses.A_BOLD)
        safe_addstr(screen, 1, 0, fit_text(help_line, width), curses.color_pair(2))
        if self.last_error:
            safe_addstr(screen, 2, 0, fit_text(f"Last error: {self.last_error}", width), curses.color_pair(6) | curses.A_BOLD)
        else:
            stale = human_duration(time.time() - snapshot.fetched_at)
            safe_addstr(screen, 2, 0, fit_text(f"Telemetry age: {stale}", width), curses.color_pair(2))

        lines = render_view(snapshot, self.view, max(20, width - 1), max(1, height - 4), frame)
        for index, line in enumerate(lines[: max(0, height - 4)]):
            attr = curses.color_pair(2)
            if "[::]" in line or "[OO]" in line:
                attr = curses.color_pair(1)
            if "BLOCK" in line or "DOWN" in line:
                attr = curses.color_pair(6)
            elif "WORK" in line:
                attr = curses.color_pair(3)
            elif "LEAD" in line:
                attr = curses.color_pair(4)
            elif "BREAK" in line:
                attr = curses.color_pair(1)
            elif "SLEEP" in line:
                attr = curses.color_pair(7)
            elif "CHAT" in line:
                attr = curses.color_pair(5)
            safe_addstr(screen, index + 4, 0, fit_text(line, width), attr)
        screen.refresh()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Animated tmux-friendly office dashboard for local agents.")
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]), help="Repository root.")
    parser.add_argument("--thread-id", default=os.environ.get("TRICHAT_OFFICE_THREAD_ID", ""), help="TriChat thread to monitor.")
    parser.add_argument("--resume-latest", action="store_true", help="Pick the latest active non-smoke thread.")
    parser.add_argument("--view", default=DEFAULT_VIEW, choices=VIEW_ORDER, help="Starting dashboard view.")
    parser.add_argument("--refresh-interval", type=float, default=float(os.environ.get("TRICHAT_OFFICE_REFRESH_SECONDS", "2.0")), help="Refresh interval in seconds.")
    parser.add_argument("--transport", default=os.environ.get("TRICHAT_MCP_TRANSPORT", "stdio"), choices=["stdio", "http"], help="MCP transport.")
    parser.add_argument("--url", default=os.environ.get("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"), help="HTTP MCP URL.")
    parser.add_argument("--origin", default=os.environ.get("TRICHAT_MCP_ORIGIN", "http://127.0.0.1"), help="HTTP origin header.")
    parser.add_argument("--stdio-command", default=os.environ.get("TRICHAT_MCP_STDIO_COMMAND", "node"), help="STDIO MCP command.")
    parser.add_argument("--stdio-args", default=os.environ.get("TRICHAT_MCP_STDIO_ARGS", "dist/server.js"), help="STDIO MCP args.")
    parser.add_argument("--mcp-retries", type=int, default=1, help="Retry count for MCP calls.")
    parser.add_argument("--mcp-retry-delay", type=float, default=0.2, help="Base retry delay for MCP calls.")
    parser.add_argument("--once", action="store_true", help="Render once to stdout without curses.")
    parser.add_argument("--width", type=int, default=118, help="Plain render width when --once is used.")
    parser.add_argument("--height", type=int, default=44, help="Plain render height when --once is used.")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    app = OfficeDashboardApp(args)
    if args.once:
        return app.run_once()
    return app.run_curses()


if __name__ == "__main__":
    raise SystemExit(main())
