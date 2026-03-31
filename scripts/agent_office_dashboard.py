#!/usr/bin/env python3
"""Animated MCP-backed office dashboard for local agent monitoring."""

from __future__ import annotations

import argparse
import concurrent.futures
import curses
import dataclasses
import json
import os
import re
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
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


def default_transport() -> str:
    explicit = os.environ.get("TRICHAT_MCP_TRANSPORT", "").strip().lower()
    if explicit in {"stdio", "http"}:
        return explicit
    if os.environ.get("MCP_HTTP_BEARER_TOKEN", "").strip():
        return "http"
    return "stdio"

DEFAULT_THREAD_ID = "ring-leader-main"
DEFAULT_VIEW = "office"
VIEW_ORDER = ["office", "briefing", "lanes", "workers", "help"]
THEME_ORDER = ["night", "sunrise", "mono"]
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
THEME_LABELS = {
    "night": "Night Shift",
    "sunrise": "Sunrise Sprint",
    "mono": "Mono Focus",
}
THEME_SKYLINES = {
    "night": [
        " .     *        .       .          _..._        *       .   ",
        "     .       .       .          .:::::::.           .      ",
        "  .      .        .          .::'  ___  `::.    .       .  ",
    ],
    "sunrise": [
        "   \\   /        .       .      .-''''-.     .      .      ",
        "    .-.      .       .        /  .-.  \\        .          ",
        " -- ( ) --        .        . |  /   \\  |   .       .      ",
    ],
    "mono": [
        "  . . . . . . . . . . . . . . . . . . . . . . . . . . .  ",
        "  ----------- focused operator floor ------------          ",
        "  . . . . . . . . . . . . . . . . . . . . . . . . . . .  ",
    ],
}
THEME_MASCOT = {
    "night": ["      .------.      ", "      | >  < |      ", "      | [__] |      ", "      '------'      "],
    "sunrise": ["      .------.      ", "      | ^  ^ |      ", "      | [__] |      ", "      '------'      "],
    "mono": ["      .------.      ", "      | o  o |      ", "      | [__] |      ", "      '------'      "],
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


def parse_any_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
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


def normalize_theme(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in THEME_ORDER else THEME_ORDER[0]


def next_theme(value: str) -> str:
    normalized = normalize_theme(value)
    index = THEME_ORDER.index(normalized)
    return THEME_ORDER[(index + 1) % len(THEME_ORDER)]


def theme_label(theme: str) -> str:
    return THEME_LABELS.get(normalize_theme(theme), THEME_LABELS[THEME_ORDER[0]])


def snapshot_cache_dir(repo_root: Path) -> Path:
    override = os.environ.get("TRICHAT_OFFICE_SNAPSHOT_CACHE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return repo_root / "data" / "imprint" / "office_snapshot_cache"


def snapshot_cache_token(value: Any, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9._-]+", "-", str(value or "").strip().lower()).strip("-.")
    return normalized or fallback


def snapshot_cache_path(repo_root: Path, thread_id: str, theme: str) -> Path:
    return snapshot_cache_dir(repo_root) / (
        f"thread-{snapshot_cache_token(thread_id, 'ring-leader-main')}"
        f"--theme-{snapshot_cache_token(normalize_theme(theme), THEME_ORDER[0])}.json"
    )


def snapshot_latest_cache_path(repo_root: Path, theme: str) -> Path:
    return snapshot_cache_dir(repo_root) / f"latest--theme-{snapshot_cache_token(normalize_theme(theme), THEME_ORDER[0])}.json"


def snapshot_cache_max_age_seconds(refresh_interval: float) -> float:
    override = os.environ.get("TRICHAT_OFFICE_SNAPSHOT_CACHE_MAX_AGE_SECONDS", "").strip()
    if override:
        try:
            return max(1.0, float(override))
        except ValueError:
            pass
    return max(3.0, min(30.0, max(1.0, float(refresh_interval)) * 2.5))


def _write_json_atomic(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    try:
        temp_path.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
        os.replace(temp_path, path)
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass


def _read_json_if_exists(path: Path) -> Optional[Dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def _snapshot_agent_count(payload: Dict[str, Any]) -> int:
    return len(as_list(payload.get("agents")))


def write_snapshot_cache(repo_root: Path, payload: Dict[str, Any]) -> Optional[Path]:
    thread_id = str(payload.get("thread_id") or "").strip()
    theme = normalize_theme(payload.get("theme"))
    if not thread_id:
        return None
    record = dict(payload)
    record["theme"] = theme
    record["cache"] = {
        "written_at": now_iso(),
        "source": "dashboard-refresh",
        "thread_id": thread_id,
        "theme": theme,
    }
    primary_path = snapshot_cache_path(repo_root, thread_id, theme)
    latest_path = snapshot_latest_cache_path(repo_root, theme)
    previous_primary = _read_json_if_exists(primary_path)
    previous_latest = _read_json_if_exists(latest_path)
    previous_richest = previous_primary
    if _snapshot_agent_count(previous_latest or {}) > _snapshot_agent_count(previous_richest or {}):
        previous_richest = previous_latest
    current_agents = _snapshot_agent_count(record)
    previous_agents = _snapshot_agent_count(previous_richest or {})
    if as_list(record.get("errors")) and previous_agents > current_agents:
        preserved = dict(previous_richest or {})
        preserved["errors"] = list(record.get("errors") or [])
        preserved["theme"] = theme
        preserved["cache"] = {
            "written_at": now_iso(),
            "source": "dashboard-refresh-preserved",
            "thread_id": thread_id,
            "theme": theme,
        }
        record = preserved
    _write_json_atomic(primary_path, record)
    _write_json_atomic(latest_path, record)
    return primary_path


def read_snapshot_cache(
    repo_root: Path,
    thread_id: Optional[str],
    theme: str,
    max_age_seconds: float,
) -> Optional[Dict[str, Any]]:
    normalized_theme = normalize_theme(theme)
    requested_thread_id = str(thread_id or "").strip()
    candidates = [
        snapshot_cache_path(repo_root, requested_thread_id, normalized_theme)
    ] if requested_thread_id else [snapshot_latest_cache_path(repo_root, normalized_theme)]
    for candidate in candidates:
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        payload_thread_id = str(payload.get("thread_id") or "").strip()
        if requested_thread_id and payload_thread_id != requested_thread_id:
            continue
        if normalize_theme(payload.get("theme")) != normalized_theme:
            continue
        fetched_at = parse_any_float(payload.get("fetched_at"), 0.0)
        if fetched_at <= 0:
            continue
        if max(0.0, time.time() - fetched_at) > max(1.0, float(max_age_seconds)):
            continue
        return payload
    return None


def build_scene_banner(theme: str, width: int, frame: int) -> List[str]:
    width = max(24, width)
    normalized = normalize_theme(theme)
    skyline = THEME_SKYLINES[normalized]
    mascot = THEME_MASCOT[normalized]
    shimmer = "." if frame % 2 == 0 else "*"
    marquee = fit_text(
        f"AGENT OFFICE :: {theme_label(normalized)} :: sprites, tmux lanes, MCP telemetry, and bounded delegation",
        width,
    )
    lines = [marquee]
    lines.extend(fit_text(line.replace(".", shimmer, 1), width) for line in skyline)
    lines.extend(fit_text(line, width) for line in mascot)
    return lines


def build_view_tabs(active_view: str, width: int, theme: str) -> str:
    tabs = []
    for index, view in enumerate(VIEW_ORDER[:-1], start=1):
        label = view.upper()
        if view == active_view:
            tabs.append(f"[{index}:{label}*]")
        else:
            tabs.append(f"[{index}:{label}]")
    tabs.append("[5:INTAKE]")
    tabs.append("[H:HELP]")
    tabs.append(f"[T:{theme_label(theme)}]")
    return fit_text(" ".join(tabs), width)


def switch_tmux_window(window_name: str) -> None:
    if not os.environ.get("TMUX"):
        return
    session_name = os.environ.get("TRICHAT_OFFICE_TMUX_SESSION_NAME", "agent-office").strip() or "agent-office"
    try:
        subprocess.run(
            ["tmux", "select-window", "-t", f"{session_name}:{window_name}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return


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
        tool_timeout_seconds: float,
    ) -> None:
        self.repo_root = repo_root
        self.transport = transport
        self.url = url
        self.origin = origin
        self.stdio_command = stdio_command
        self.stdio_args = stdio_args
        self.retries = max(0, retries)
        self.retry_delay_seconds = max(0.05, retry_delay_seconds)
        self.tool_timeout_seconds = max(1.0, tool_timeout_seconds)
        self.helper = repo_root / "scripts" / "mcp_tool_call.mjs"
        if not self.helper.exists():
            raise RuntimeError(f"missing helper: {self.helper}")

    def can_use_http_snapshot(self) -> bool:
        if self.transport != "http":
            return False
        return os.environ.get("AGENT_OFFICE_DISABLE_HTTP_SNAPSHOT", "").strip().lower() not in {"1", "true", "yes"}

    def fetch_http_snapshot(self, thread_id: str, theme: str) -> Dict[str, Any]:
        if not self.can_use_http_snapshot():
            return {}
        base_url = self.url.rstrip("/")
        query = urllib.parse.urlencode({"thread_id": thread_id, "theme": theme, "format": "raw"})
        request = urllib.request.Request(
            f"{base_url}/office/api/snapshot?{query}",
            headers={
                "Accept": "application/json",
                "Origin": self.origin,
                **(
                    {"Authorization": f"Bearer {os.environ.get('MCP_HTTP_BEARER_TOKEN', '').strip()}"}
                    if os.environ.get("MCP_HTTP_BEARER_TOKEN", "").strip()
                    else {}
                ),
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.tool_timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.URLError as error:
            raise RuntimeError(f"http snapshot unavailable: {error}") from error
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"invalid JSON from office snapshot: {error}") from error
        return as_dict(payload)

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
            try:
                proc = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=self.tool_timeout_seconds,
                )
            except subprocess.TimeoutExpired:
                last_error = f"timeout after {self.tool_timeout_seconds:.1f}s"
                if attempt < attempts:
                    time.sleep(self.retry_delay_seconds * attempt)
                    continue
                raise RuntimeError(f"MCP tool failed ({tool}): {last_error}") from None
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


def snapshot_max_workers(transport: str, request_count: int) -> int:
    if request_count <= 1:
        return 1
    if transport == "http":
        return max(2, min(4, request_count))
    return max(2, min(8, request_count))


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
    evidence_source: str
    evidence_detail: str


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
    autonomy_maintain: Dict[str, Any] = field(default_factory=dict)
    runtime_workers: Dict[str, Any] = field(default_factory=dict)
    operator_brief: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    agent_sessions: Dict[str, Any] = field(default_factory=dict)
    task_running: Dict[str, Any] = field(default_factory=dict)
    task_pending: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentTaskSignal:
    state: str
    activity: str
    count: int
    updated_at: str
    source: str
    reference: str


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


def load_roster_config(repo_root: Path) -> Dict[str, Any]:
    config_path = repo_root / "config" / "trichat_agents.json"
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def build_config_roster_fallback(
    repo_root: Path,
    workboard_payload: Dict[str, Any],
    agent_sessions_payload: Dict[str, Any],
    learning_payload: Dict[str, Any],
) -> Dict[str, Any]:
    config = load_roster_config(repo_root)
    agents = as_list(config.get("agents"))
    if not agents:
        return {}
    current_turn = maybe_turn(workboard_payload)
    metadata = as_dict(current_turn.get("metadata"))
    active_agent_ids = dedupe(
        [metadata.get("lead_agent_id"), current_turn.get("selected_agent")]
        + as_list(current_turn.get("expected_agents"))
        + as_list(metadata.get("specialist_agent_ids"))
        + [as_dict(session).get("agent_id") for session in as_list(agent_sessions_payload.get("sessions"))]
        + [as_dict(entry).get("agent_id") for entry in as_list(learning_payload.get("top_agents"))]
        + as_list(config.get("default_agent_ids"))
    )
    return {
        "default_agent_ids": dedupe(as_list(config.get("default_agent_ids"))),
        "active_agent_ids": active_agent_ids,
        "agents": agents,
        "source": "config-fallback",
    }


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


def build_spawn_path(latest_decision: Dict[str, Any], latest_turn: Dict[str, Any], session_metadata: Dict[str, Any]) -> str:
    lead = normalize_agent_id(session_metadata.get("lead_agent_id") or latest_turn.get("lead_agent_id") or "ring-leader")
    selected = normalize_agent_id(
        latest_decision.get("selected_agent") or latest_turn.get("selected_agent") or session_metadata.get("last_selected_agent_id")
    )
    brief = primary_delegation_brief(latest_decision, latest_turn, session_metadata)
    delegate = normalize_agent_id(brief.get("delegate_agent_id") or session_metadata.get("last_selected_delegate_agent_id"))
    chain = [part for part in [lead, selected, delegate] if part]
    if not chain:
        return "n/a"
    compacted: List[str] = []
    for part in chain:
        if part not in compacted:
            compacted.append(part)
    return " -> ".join(compacted)


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
    metadata = as_dict(current_turn.get("metadata"))
    explicit_candidates = dedupe(
        [
            current_turn.get("selected_delegate_agent_id"),
            as_dict(current_turn.get("selected_delegation_brief")).get("delegate_agent_id"),
            as_dict(metadata.get("delegation_brief")).get("delegate_agent_id"),
        ]
        + [
            as_dict(entry).get("delegate_agent_id")
            for entry in as_list(current_turn.get("selected_delegation_briefs")) + as_list(metadata.get("delegation_briefs"))
        ]
        + as_list(as_dict(metadata.get("source_task_routing")).get("preferred_agent_ids"))
    )
    for candidate in explicit_candidates:
        if candidate in selected.managed_agent_ids and candidate in catalog:
            return candidate
    for candidate in selected.managed_agent_ids:
        if candidate in catalog and candidate in dedupe(as_list(current_turn.get("expected_agents"))):
            return candidate
    for candidate in selected.managed_agent_ids:
        if candidate in catalog:
            return candidate
    return None


def iter_task_routing_candidates(*records: Dict[str, Any]) -> Iterable[str]:
    for record in records:
        routing = as_dict(record.get("task_routing"))
        for key in ("preferred_agent_ids", "allowed_agent_ids"):
            for candidate in as_list(routing.get(key)):
                agent_id = normalize_agent_id(candidate)
                if agent_id:
                    yield agent_id


def extract_explicit_task_agents(
    catalog: Dict[str, DashboardAgent],
    task: Dict[str, Any],
) -> Tuple[List[str], List[str], str]:
    metadata = as_dict(task.get("metadata"))
    payload = as_dict(task.get("payload"))
    task_brief = as_dict(metadata.get("delegation_brief"))
    payload_brief = as_dict(payload.get("delegation_brief"))
    delegates = dedupe(
        [
            metadata.get("delegate_agent_id"),
            payload.get("delegate_agent_id"),
            task_brief.get("delegate_agent_id"),
            payload_brief.get("delegate_agent_id"),
        ]
        + [
            as_dict(entry).get("delegate_agent_id")
            for entry in as_list(metadata.get("delegation_briefs"))
            + as_list(payload.get("delegation_briefs"))
            + as_list(metadata.get("selected_delegation_briefs"))
            + as_list(payload.get("selected_delegation_briefs"))
        ]
    )
    selected_agent = normalize_agent_id(metadata.get("selected_agent") or payload.get("selected_agent"))
    lead_agent = normalize_agent_id(metadata.get("lead_agent_id") or payload.get("lead_agent_id"))
    routing_candidates = dedupe(
        list(
            iter_task_routing_candidates(
                metadata,
                payload,
                as_dict(metadata.get("routing")),
                as_dict(payload.get("routing")),
            )
        )
    )
    owners = [agent_id for agent_id in delegates if agent_id in catalog]
    source = "delegate"
    if not owners and selected_agent in catalog:
        owners = [selected_agent]
        source = "selected_agent"
    if not owners:
        fallback_targets = [
            agent_id
            for agent_id in routing_candidates
            if agent_id in catalog and agent_id not in {lead_agent}
        ]
        if len(fallback_targets) == 1:
            owners = fallback_targets
            source = "task_routing"
    supervisors: List[str] = []
    for candidate in [selected_agent, lead_agent]:
        if candidate and candidate in catalog and candidate not in owners and candidate not in supervisors:
            supervisors.append(candidate)
    for owner in owners:
        add_parent_chain(owner, catalog, supervisors)
    supervisors = [agent_id for agent_id in supervisors if agent_id in catalog and agent_id not in owners]
    return owners, supervisors, source


def merge_agent_signal(
    signals: Dict[str, AgentTaskSignal],
    agent_id: str,
    state: str,
    activity: str,
    updated_at: str,
    source: str,
    reference: str,
) -> None:
    status_rank = {"running": 3, "dispatched": 2, "queued": 1}
    existing = signals.get(agent_id)
    if existing and status_rank.get(existing.state, 0) > status_rank.get(state, 0):
        signals[agent_id] = AgentTaskSignal(
            state=existing.state,
            activity=existing.activity,
            count=existing.count + 1,
            updated_at=existing.updated_at,
            source=existing.source,
            reference=existing.reference,
        )
        return
    signals[agent_id] = AgentTaskSignal(
        state=state,
        activity=activity,
        count=(existing.count if existing else 0) + 1,
        updated_at=updated_at,
        source=source,
        reference=reference,
    )


def normalize_task_signal_state(status: str) -> str:
    normalized = str(status or "").strip().lower()
    if normalized in {"running", "dispatched", "queued"}:
        return normalized
    if normalized == "pending":
        return "queued"
    return ""


def task_activity_text(task: Dict[str, Any]) -> str:
    payload = as_dict(task.get("payload"))
    return compact_single_line(
        str(
            task.get("objective")
            or payload.get("task_objective")
            or task.get("title")
            or task.get("command")
            or "bounded task"
        ),
        56,
    )


def build_agent_task_signal_maps(
    catalog: Dict[str, DashboardAgent],
    tmux_payload: Dict[str, Any],
    task_running_payload: Dict[str, Any],
    task_pending_payload: Dict[str, Any],
) -> Tuple[Dict[str, AgentTaskSignal], Dict[str, AgentTaskSignal]]:
    owner_signals: Dict[str, AgentTaskSignal] = {}
    supervisor_signals: Dict[str, AgentTaskSignal] = {}
    task_batches = [
        ("tmux", as_list(as_dict(tmux_payload.get("state")).get("tasks"))),
        ("task", as_list(task_running_payload.get("tasks")) + as_list(task_pending_payload.get("tasks"))),
    ]
    for source_label, entries in task_batches:
        for task_raw in entries:
            task = as_dict(task_raw)
            status = normalize_task_signal_state(task.get("status"))
            if not status:
                continue
            owners, supervisors, target_source = extract_explicit_task_agents(catalog, task)
            if not owners and not supervisors:
                continue
            updated_at = str(
                task.get("started_at")
                or task.get("dispatched_at")
                or task.get("updated_at")
                or task.get("created_at")
                or ""
            ).strip()
            activity = task_activity_text(task)
            task_id = str(task.get("task_id") or task.get("title") or task.get("command") or "task").strip()
            signal_source = f"{source_label}:{target_source}" if target_source else source_label
            for agent_id in owners:
                merge_agent_signal(owner_signals, agent_id, status, activity, updated_at, signal_source, task_id)
            if owners:
                owner_label = compact_single_line(
                    ", ".join(catalog[agent_id].display_name for agent_id in owners if agent_id in catalog),
                    36,
                )
            else:
                owner_label = "delegate"
            for agent_id in supervisors:
                merge_agent_signal(
                    supervisor_signals,
                    agent_id,
                    status,
                    compact_single_line(f"directing {owner_label}: {activity}", 56),
                    updated_at,
                    signal_source,
                    task_id,
                )
    return owner_signals, supervisor_signals


def build_agent_session_signal_map(
    catalog: Dict[str, DashboardAgent],
    agent_sessions_payload: Dict[str, Any],
    task_index: Dict[str, Dict[str, Any]],
    now_epoch: float,
) -> Dict[str, AgentTaskSignal]:
    signals: Dict[str, AgentTaskSignal] = {}
    for session_raw in as_list(agent_sessions_payload.get("sessions")):
        session = as_dict(session_raw)
        agent_id = normalize_agent_id(session.get("agent_id"))
        if agent_id not in catalog:
            continue
        if str(session.get("status") or "").strip().lower() != "busy":
            continue
        updated_at = str(session.get("updated_at") or session.get("heartbeat_at") or "").strip()
        if age_seconds(updated_at, now_epoch) > 900:
            continue
        metadata = as_dict(session.get("metadata"))
        current_task_id = str(
            metadata.get("current_task_id")
            or metadata.get("last_source_task_id")
            or metadata.get("last_claimed_task_id")
            or ""
        ).strip()
        task = task_index.get(current_task_id, {})
        activity = compact_single_line(
            str(
                task.get("objective")
                or as_dict(task.get("payload")).get("task_objective")
                or metadata.get("last_selected_strategy")
                or metadata.get("objective")
                or "active session"
            ),
            56,
        )
        state = "running"
        if catalog[agent_id].tier in {"lead", "director"} or catalog[agent_id].role == "orchestrator":
            activity = compact_single_line(f"orchestrating: {activity}", 56)
        merge_agent_signal(
            signals,
            agent_id,
            state,
            activity,
            updated_at,
            "session",
            str(session.get("session_id") or agent_id),
        )
    return signals


def build_recent_chat_notes(
    catalog: Dict[str, DashboardAgent],
    bus_payload: Dict[str, Any],
    now_epoch: float,
) -> Dict[str, Tuple[str, float, str]]:
    notes: Dict[str, Tuple[str, float, str]] = {}
    for event_raw in reversed(as_list(bus_payload.get("events"))):
        event = as_dict(event_raw)
        agent_id = normalize_agent_id(event.get("source_agent"))
        if not agent_id or agent_id in notes or agent_id not in catalog:
            continue
        if str(event.get("role") or "").strip().lower() == "system":
            continue
        event_age = age_seconds(event.get("created_at"), now_epoch)
        if event_age > 900:
            continue
        event_type = str(event.get("event_type") or "").strip().lower()
        content = compact_single_line(str(event.get("content") or ""), 56)
        if not content and event_type:
            content = compact_single_line(event_type.replace("trichat.", "").replace("_", " "), 56)
        notes[agent_id] = (
            content or "recent chatter",
            event_age,
            str(event.get("event_id") or event.get("event_seq") or agent_id).strip(),
        )
    return notes


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


def derive_presence_map(
    agents: List[DashboardAgent],
    workboard_payload: Dict[str, Any],
    tmux_payload: Dict[str, Any],
    task_running_payload: Dict[str, Any],
    task_pending_payload: Dict[str, Any],
    agent_sessions_payload: Dict[str, Any],
    adapter_payload: Dict[str, Any],
    bus_payload: Dict[str, Any],
    now_epoch: Optional[float] = None,
) -> List[OfficePresence]:
    now_epoch = now_epoch if now_epoch is not None else time.time()
    catalog = {agent.agent_id: agent for agent in agents}
    current_turn = as_dict(workboard_payload.get("active_turn"))
    turn_recent = bool(current_turn) and age_seconds(current_turn.get("updated_at"), now_epoch) <= 300
    expected_agents = set(dedupe(as_list(current_turn.get("expected_agents"))))
    selected_agent = normalize_agent_id(current_turn.get("selected_agent"))
    blocked_notes = build_blocked_notes(adapter_payload, now_epoch)
    recent_chat = build_recent_chat_notes(catalog, bus_payload, now_epoch)
    adapter_ages = build_adapter_age_map(adapter_payload, now_epoch)
    task_index = build_task_index(task_running_payload, task_pending_payload)
    owner_signals, supervisor_signals = build_agent_task_signal_maps(
        catalog,
        tmux_payload,
        task_running_payload,
        task_pending_payload,
    )
    session_signals = build_agent_session_signal_map(catalog, agent_sessions_payload, task_index, now_epoch)
    selected_delegate = ""
    if selected_agent in catalog and turn_recent:
        selected_delegate = infer_managed_delegate(catalog[selected_agent], current_turn, catalog) or ""
    presences: List[OfficePresence] = []

    for agent in agents:
        state = "idle"
        location = "desk"
        activity = "standing by"
        queue_count = 0
        evidence_source = "none"
        evidence_detail = "no current evidence"
        blocked = blocked_notes.get(agent.agent_id)
        owner_signal = owner_signals.get(agent.agent_id)
        supervisor_signal = supervisor_signals.get(agent.agent_id)
        session_signal = session_signals.get(agent.agent_id)
        chat_signal = recent_chat.get(agent.agent_id)
        signal_ages = [adapter_ages.get(agent.agent_id, 1e12)]
        if owner_signal:
            signal_ages.append(age_seconds(owner_signal.updated_at, now_epoch))
            queue_count = max(queue_count, owner_signal.count)
        if supervisor_signal:
            signal_ages.append(age_seconds(supervisor_signal.updated_at, now_epoch))
            queue_count = max(queue_count, supervisor_signal.count)
        if session_signal:
            signal_ages.append(age_seconds(session_signal.updated_at, now_epoch))
        if chat_signal:
            signal_ages.append(chat_signal[1])
        if turn_recent and (agent.agent_id == selected_agent or agent.agent_id in expected_agents):
            signal_ages.append(age_seconds(current_turn.get("updated_at"), now_epoch))
        freshest_signal_age = min(signal_ages) if signal_ages else 1e12
        if blocked:
            severity, detail = blocked
            state = "offline" if severity == "offline" else "blocked"
            activity = detail
            location = "desk"
            evidence_source = "adapter"
            evidence_detail = detail
        elif owner_signal and owner_signal.state == "running":
            state = "working"
            location = "desk"
            activity = owner_signal.activity
            evidence_source = owner_signal.source
            evidence_detail = owner_signal.reference
        elif supervisor_signal and supervisor_signal.state == "running":
            state = "supervising"
            activity = supervisor_signal.activity
            evidence_source = supervisor_signal.source
            evidence_detail = supervisor_signal.reference
        elif session_signal and session_signal.state == "running":
            state = "supervising" if agent.tier in {"lead", "director"} or agent.role == "orchestrator" else "working"
            activity = session_signal.activity
            evidence_source = session_signal.source
            evidence_detail = session_signal.reference
        elif turn_recent and agent.agent_id == selected_agent:
            state = "supervising" if selected_delegate else "working"
            activity = compact_single_line(
                str(current_turn.get("selected_strategy") or current_turn.get("user_prompt") or "active turn"),
                56,
            )
            evidence_source = "turn"
            evidence_detail = str(current_turn.get("turn_id") or "active-turn").strip() or "active-turn"
        elif chat_signal and chat_signal[1] <= 240:
            state = "talking"
            location = "cooler"
            activity = chat_signal[0]
            evidence_source = "bus"
            evidence_detail = chat_signal[2]
        elif chat_signal:
            state = "break"
            location = "lounge"
            activity = chat_signal[0]
            evidence_source = "bus"
            evidence_detail = chat_signal[2]
        elif owner_signal and owner_signal.state in {"queued", "dispatched"}:
            state = "idle"
            activity = compact_single_line(f"queued: {owner_signal.activity}", 56)
            evidence_source = owner_signal.source
            evidence_detail = owner_signal.reference
        elif supervisor_signal and supervisor_signal.state in {"queued", "dispatched"}:
            state = "idle"
            activity = compact_single_line(f"oversight queued: {supervisor_signal.activity}", 56)
            evidence_source = supervisor_signal.source
            evidence_detail = supervisor_signal.reference
        elif turn_recent and agent.agent_id in expected_agents:
            state = "idle"
            activity = "waiting on the next turn"
            evidence_source = "turn"
            evidence_detail = str(current_turn.get("turn_id") or "active-turn").strip() or "active-turn"
        elif agent.active and freshest_signal_age > 1800:
            state = "sleeping"
            location = "sofa"
            activity = "saving energy until the next bounded task"
            evidence_source = "none"
            evidence_detail = f"idle_for={human_duration(freshest_signal_age)}"
        actions = build_action_tags(agent, state, location, activity, queue_count=queue_count)
        presences.append(
            OfficePresence(
                agent=agent,
                state=state,
                activity=compact_single_line(activity or "standing by", 56),
                location=location,
                actions=actions,
                evidence_source=evidence_source,
                evidence_detail=compact_single_line(evidence_detail or "n/a", 56),
            )
        )
    return presences


def state_counts(presences: List[OfficePresence]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for presence in presences:
        counts[presence.state] = counts.get(presence.state, 0) + 1
    return counts


def sprite_lines(presence: OfficePresence, frame: int) -> Tuple[str, str]:
    brow = {
        "lead": " .^^^^. ",
        "director": " .-**-. ",
        "leaf": " .-..-. ",
        "support": " .~~~~. ",
    }.get(presence.agent.tier, " .----. ")
    if presence.state == "working":
        face = " |o  o| " if frame % 2 else " |o  O| "
    elif presence.state == "supervising":
        face = " |>  <| "
    elif presence.state == "talking":
        face = " |^  ^| "
    elif presence.state == "break":
        face = " |u  u| "
    elif presence.state == "sleeping":
        face = " |-  -| "
    elif presence.state == "blocked":
        face = " |x  x| "
    elif presence.state == "offline":
        face = " |.  .| "
    else:
        face = " |.  o| " if frame % 2 else " |o  .| "
    return brow, face


def sprite_scene_lines(presence: OfficePresence, frame: int) -> List[str]:
    top, face = sprite_lines(presence, frame)
    token = presence.agent.token
    if presence.state == "working":
        arms = f" |[{token}]|__"
        feet = "  /||\\  "
    elif presence.state == "supervising":
        arms = f" |[{token}]|>>"
        feet = "  /||\\  "
    elif presence.state == "talking":
        arms = f" |[{token}]|~~"
        feet = "  /||\\  "
    elif presence.state == "break":
        arms = f" |[{token}]|~~"
        feet = "  _/\\_  "
    elif presence.state == "sleeping":
        arms = f" |[{token}]|zZ"
        feet = "  _/\\_  "
    elif presence.state == "blocked":
        arms = f" |[{token}]|!!"
        feet = "  /||\\  "
    elif presence.state == "offline":
        arms = f" |[{token}]|.."
        feet = "   __   "
    else:
        arms = f" |[{token}]|.."
        feet = "  /||\\  "
    return [top, face, arms, feet]


def blank_canvas(width: int, height: int, fill: str = " ") -> List[List[str]]:
    return [[fill for _ in range(max(0, width))] for _ in range(max(0, height))]


def paint_text(canvas: List[List[str]], x: int, y: int, text: str) -> None:
    if y < 0 or y >= len(canvas):
        return
    row = canvas[y]
    for offset, char in enumerate(str(text)):
        target_x = x + offset
        if 0 <= target_x < len(row):
            row[target_x] = char


def paint_box(canvas: List[List[str]], x: int, y: int, width: int, height: int, title: str = "") -> None:
    if width < 2 or height < 2:
        return
    horizontal = "-" * max(0, width - 2)
    paint_text(canvas, x, y, f"+{horizontal}+")
    for row in range(y + 1, y + height - 1):
        paint_text(canvas, x, row, "|" + (" " * max(0, width - 2)) + "|")
    paint_text(canvas, x, y + height - 1, f"+{horizontal}+")
    label = compact_single_line(title, max(0, width - 4))
    if label:
        paint_text(canvas, x + 2, y, label)


def canvas_to_lines(canvas: List[List[str]], width: int) -> List[str]:
    lines: List[str] = []
    for row in canvas:
        line = "".join(row)
        lines.append(fit_text(line[:width], width))
    return lines


def desk_monitor(state: str, frame: int) -> str:
    if state == "working":
        return "[==]" if frame % 2 == 0 else "[=~]"
    if state == "supervising":
        return "[>>]"
    if state == "talking":
        return "[~~]"
    if state == "break":
        return "[::]"
    if state == "sleeping":
        return "[zz]"
    if state == "blocked":
        return "[!!]"
    if state == "offline":
        return "[xx]"
    return "[..]"


def sprite_badge(presence: OfficePresence, frame: int) -> List[str]:
    motion = {
        "working": "W",
        "supervising": ">",
        "talking": "~",
        "break": ":",
        "sleeping": "z",
        "blocked": "!",
        "offline": "x",
        "idle": ".",
    }.get(presence.state, ".")
    blink = "'" if frame % 2 else "."
    token = presence.agent.token[:2].ljust(2)
    return [
        f" .{blink}--{blink}. ",
        f" |{token}{motion}| ",
        " '/__\\' ",
    ]


def place_presence_tile(
    canvas: List[List[str]],
    presence: OfficePresence,
    x: int,
    y: int,
    width: int,
    frame: int,
    label: Optional[str] = None,
    *,
    compact: bool = False,
) -> None:
    label_text = compact_single_line(label or presence.agent.display_name, max(6, width))
    badge = sprite_badge(presence, frame)
    if compact:
        paint_text(canvas, x, y, fit_text(desk_monitor(presence.state, frame), min(4, width)))
        paint_text(canvas, x, y + 1, badge[0][:width])
        paint_text(canvas, x, y + 2, badge[1][:width])
        paint_text(canvas, x, y + 3, label_text[:width])
        return
    paint_text(canvas, x, y, fit_text(desk_monitor(presence.state, frame), min(4, width)))
    paint_text(canvas, x, y + 1, "._[]_.")
    for offset, line in enumerate(badge, start=2):
        paint_text(canvas, x, y + offset, line[:width])
    paint_text(canvas, x, y + 5, label_text[:width])


def compute_room_slots(
    x: int,
    y: int,
    width: int,
    height: int,
    slot_width: int,
    slot_height: int,
    *,
    top_pad: int = 3,
) -> List[Tuple[int, int]]:
    usable_width = max(1, width - 4)
    usable_height = max(1, height - (top_pad + 2))
    columns = max(1, usable_width // max(1, slot_width + 1))
    rows = max(1, usable_height // max(1, slot_height + 1))
    slots: List[Tuple[int, int]] = []
    for row in range(rows):
        for column in range(columns):
            slot_x = x + 2 + (column * (slot_width + 1))
            slot_y = y + top_pad + (row * (slot_height + 1))
            if slot_x + slot_width - 1 <= x + width - 2 and slot_y + slot_height - 1 <= y + height - 2:
                slots.append((slot_x, slot_y))
    return slots


def sort_presence_for_floorplan(presence: OfficePresence) -> Tuple[int, int, int, str]:
    state_rank = {
        "working": 0,
        "supervising": 1,
        "idle": 2,
        "talking": 3,
        "break": 4,
        "sleeping": 5,
        "blocked": 6,
        "offline": 7,
    }.get(presence.state, 8)
    return (
        TIER_RANK.get(presence.agent.tier, 9),
        ROLE_RANK.get(presence.agent.role, 9),
        state_rank,
        presence.agent.display_name.lower(),
    )


def render_floorplan_scene(
    presences: List[OfficePresence],
    width: int,
    height: int,
    frame: int,
    theme: str,
    learned_count: int = 0,
    queue_depth: int = 0,
) -> List[str]:
    width = max(60, width)
    height = max(18, height)
    canvas = blank_canvas(width, height)
    paint_box(canvas, 0, 0, width, height, f" MISSION FLOOR :: {theme_label(theme)} ")
    for row in range(1, height - 1):
        for column in range(1, width - 1):
            if canvas[row][column] == " ":
                canvas[row][column] = "." if (row + column + frame) % 7 == 0 else " "

    side_width = max(22, min(28, width // 3))
    main_width = width - side_width - 3
    top_height = max(8, min(9, height // 2))
    bottom_height = height - top_height - 3

    command_room = (2, 2, main_width, top_height)
    lounge_room = (main_width + 3, 2, side_width, top_height)
    build_room = (2, top_height + 3, main_width, bottom_height)
    ops_room = (main_width + 3, top_height + 3, side_width, bottom_height)

    lounge_presences = [p for p in presences if p.location in {"cooler", "lounge", "sofa"} or p.state in {"talking", "break", "sleeping"}]
    blocked_presences = [p for p in presences if p.state in {"blocked", "offline"} and p not in lounge_presences]
    command_presences = [
        p
        for p in presences
        if p not in lounge_presences
        and p not in blocked_presences
        and (p.agent.tier in {"lead", "director"} or p.agent.role in {"planner", "orchestrator", "reliability-critic"})
    ]
    build_presences = [p for p in presences if p not in lounge_presences and p not in blocked_presences and p not in command_presences]

    paint_box(canvas, *command_room, title=f" COMMAND DECK [{len(command_presences)}] ")
    paint_box(canvas, *lounge_room, title=f" LOUNGE + WATER [{len(lounge_presences)}] ")
    paint_box(canvas, *build_room, title=f" BUILD BAY [{len(build_presences)}] ")
    paint_box(canvas, *ops_room, title=f" OPS RACK [{len(blocked_presences)}] ")

    paint_text(canvas, command_room[0] + 2, command_room[1] + 1, "window ===  map wall []  coffee [::]")
    paint_text(canvas, lounge_room[0] + 2, lounge_room[1] + 1, "water [OO]  sofa [__]  snack bar")
    paint_text(canvas, build_room[0] + 2, build_room[1] + 1, "bench []  docs ==  patch lane <>")
    paint_text(canvas, ops_room[0] + 2, ops_room[1] + 1, "router ##  telemetry []")

    command_slots = compute_room_slots(*command_room, slot_width=10, slot_height=4, top_pad=3)
    lounge_slots = compute_room_slots(*lounge_room, slot_width=10, slot_height=4, top_pad=3)
    build_slots = compute_room_slots(*build_room, slot_width=10, slot_height=6, top_pad=3)
    ops_slots = compute_room_slots(*ops_room, slot_width=10, slot_height=6, top_pad=3)

    for presence, slot in zip(sorted(command_presences, key=sort_presence_for_floorplan), command_slots):
        place_presence_tile(canvas, presence, slot[0], slot[1], 10, frame, compact=True)
    for presence, slot in zip(sorted(build_presences, key=sort_presence_for_floorplan), build_slots):
        place_presence_tile(canvas, presence, slot[0], slot[1], 10, frame)
    for presence, slot in zip(sorted(lounge_presences, key=sort_presence_for_floorplan), lounge_slots):
        place_presence_tile(canvas, presence, slot[0], slot[1], 10, frame, compact=True)
    for presence, slot in zip(sorted(blocked_presences, key=sort_presence_for_floorplan), ops_slots):
        place_presence_tile(canvas, presence, slot[0], slot[1], 10, frame)

    counts = state_counts(presences)
    ops_lines = [
        f"work {counts.get('working', 0):>2}",
        f"lead {counts.get('supervising', 0):>2}",
        f"chat {counts.get('talking', 0):>2}",
        f"rest {counts.get('break', 0) + counts.get('sleeping', 0):>2}",
        f"block {counts.get('blocked', 0) + counts.get('offline', 0):>1}",
        f"learn {learned_count:>2}",
        f"queue {queue_depth:>2}",
    ]
    for index, line in enumerate(ops_lines, start=3):
        paint_text(canvas, ops_room[0] + ops_room[2] - 11, ops_room[1] + index, line[:9])

    return canvas_to_lines(canvas, width)


def render_agent_card(presence: OfficePresence, width: int, frame: int) -> List[str]:
    width = max(24, width)
    inner = width - 2
    tier = presence.agent.tier.upper()[:4]
    title_left = f"{presence.agent.token} {presence.agent.display_name}"
    title = fit_text(title_left, max(0, inner - 10))
    status = STATE_LABELS.get(presence.state, presence.state[:5].upper())
    top = "+" + ("=" * inner) + "+"
    bottom = "+" + ("=" * inner) + "+"
    sprite = sprite_scene_lines(presence, frame)
    monitor = "[==]" if presence.state == "working" else "[!!]" if presence.state == "blocked" else "[--]" if presence.state == "offline" else "[..]"
    companion = {
        "cooler": "coffee + chat",
        "lounge": "stretch + water",
        "sofa": "sofa + blanket",
    }.get(presence.location, "pc + mug")
    mood = {
        "working": "typing hard",
        "supervising": "briefing team",
        "talking": "syncing live",
        "break": "between tasks",
        "sleeping": "offline dreaming",
        "blocked": "needs help",
        "offline": "bridge down",
        "idle": "light idle",
    }.get(presence.state, "holding steady")
    badges = " ".join(f"[{tag}]" for tag in presence.actions) or "[ready]"
    role_line = compact_single_line(f"{tier} :: {presence.agent.role} :: {presence.location}", inner)

    return [
        top,
        "|" + fit_text(f"{title}{status.rjust(max(0, inner - len(title)))}", inner) + "|",
        "|" + fit_text(role_line, inner) + "|",
        "|" + fit_text(f"{monitor} {companion}", inner) + "|",
        "|" + fit_text(sprite[0], inner) + "|",
        "|" + fit_text(sprite[1], inner) + "|",
        "|" + fit_text(sprite[2], inner) + "|",
        "|" + fit_text(sprite[3], inner) + "|",
        "|" + fit_text(badges, inner) + "|",
        "|" + fit_text(compact_single_line(f"src={presence.evidence_source} ref={presence.evidence_detail}", inner), inner) + "|",
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
            tokens.append(compact_single_line(f"{body.strip()} {presence.agent.display_name}", 24))
        lines.append(fit_text(f"{label}: {'  '.join(tokens)}", width))
    return lines


def render_office_view(snapshot: DashboardSnapshot, width: int, height: int, frame: int, theme: str = "night") -> List[str]:
    agents = select_display_agents(snapshot.roster, snapshot.workboard)
    presences = derive_presence_map(
        agents,
        snapshot.workboard,
        snapshot.tmux,
        snapshot.task_running,
        snapshot.task_pending,
        snapshot.agent_sessions,
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
    tmux_dashboard = as_dict(snapshot.tmux.get("dashboard"))
    tmux_queue_depth = parse_any_int(tmux_dashboard.get("queue_depth"))
    kernel_worker_fabric = as_dict(snapshot.kernel.get("worker_fabric"))
    local_host = next(
        (
            as_dict(host)
            for host in as_list(kernel_worker_fabric.get("hosts"))
            if str(as_dict(host).get("host_id") or "").strip()
            == str(kernel_worker_fabric.get("default_host_id") or "local").strip()
        ),
        {},
    )
    local_cpu = parse_any_float(local_host.get("cpu_utilization")) * 100
    local_ram = parse_any_float(local_host.get("ram_available_gb"))
    router = as_dict(snapshot.kernel.get("model_router"))
    router_backend = compact_single_line(str(router.get("default_backend_id") or "n/a"), 28)
    available_width = max(40, width)
    lines = build_scene_banner(theme, available_width, frame)
    lines.append(fit_text(banner, available_width))
    lines.append(
        fit_text(
            "Truth mode :: active states require durable task/session/bus/adapter evidence; no title-guessing",
            available_width,
        )
    )
    lines.append(
        fit_text(
            f"Live infra :: queue={tmux_queue_depth} cpu={local_cpu:.0f}% ram={local_ram:.1f}GB backend={router_backend}",
            available_width,
        )
    )
    lines.append("")
    if available_width >= 80 and height >= 24:
        scene_height = max(18, height - len(lines) - 2)
        lines.extend(
            render_floorplan_scene(
                presences,
                available_width,
                scene_height,
                frame,
                theme,
                learned_count=parse_any_int(snapshot.learning.get("active_entry_count")),
                queue_depth=tmux_queue_depth,
            )
        )
    else:
        columns = 3 if available_width >= 94 else 2 if available_width >= 62 else 1
        gap = 2
        card_width = max(24, min(32, (available_width - (gap * (columns - 1))) // columns))
        cards = [render_agent_card(presence, card_width, frame) for presence in presences]
        lines.extend(render_card_grid(cards, columns=columns, gap=gap))
        lines.append("")
        lines.extend(render_lounge_line(presences, available_width, frame))
    return lines[: max(1, height)]


def partition_office_presences(presences: List[OfficePresence]) -> Dict[str, List[OfficePresence]]:
    lounge_presences = [
        presence
        for presence in presences
        if presence.location in {"cooler", "lounge", "sofa"} or presence.state in {"talking", "break", "sleeping"}
    ]
    blocked_presences = [
        presence for presence in presences if presence.state in {"blocked", "offline"} and presence not in lounge_presences
    ]
    command_presences = [
        presence
        for presence in presences
        if presence not in lounge_presences
        and presence not in blocked_presences
        and (presence.agent.tier in {"lead", "director"} or presence.agent.role in {"planner", "orchestrator", "reliability-critic"})
    ]
    build_presences = [
        presence
        for presence in presences
        if presence not in lounge_presences and presence not in blocked_presences and presence not in command_presences
    ]
    return {
        "command": sorted(command_presences, key=sort_presence_for_floorplan),
        "lounge": sorted(lounge_presences, key=sort_presence_for_floorplan),
        "build": sorted(build_presences, key=sort_presence_for_floorplan),
        "ops": sorted(blocked_presences, key=sort_presence_for_floorplan),
    }


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
    kernel_worker_fabric = as_dict(kernel.get("worker_fabric"))
    kernel_worker_hosts = as_list(kernel_worker_fabric.get("hosts"))
    kernel_cluster_topology = as_dict(kernel.get("cluster_topology"))
    kernel_model_router = as_dict(kernel.get("model_router"))
    kernel_routing_outlook = as_list(kernel_model_router.get("routing_outlook"))
    kernel_model_backends = as_list(kernel_model_router.get("backends"))
    kernel_evals = as_dict(kernel.get("evals"))
    kernel_observability = as_dict(kernel.get("observability"))
    kernel_org_programs = as_dict(kernel.get("org_programs"))
    kernel_swarm = as_dict(kernel.get("swarm"))
    kernel_swarm_profiles = as_list(kernel_swarm.get("active_profiles"))
    kernel_autonomy_maintain = as_dict(kernel.get("autonomy_maintain"))
    kernel_reaction_engine = as_dict(kernel.get("reaction_engine"))
    kernel_workflow_exports = as_dict(kernel.get("workflow_exports"))
    kernel_runtime_workers = as_dict(kernel.get("runtime_workers"))
    learning = snapshot.learning
    autonomy_maintain = snapshot.autonomy_maintain
    autonomy_maintain_state = as_dict(autonomy_maintain.get("state"))
    autonomy_maintain_runtime = as_dict(autonomy_maintain.get("runtime"))
    autonomy_maintain_due = as_dict(autonomy_maintain.get("due"))
    autonomy_maintain_subsystems = as_dict(autonomy_maintain.get("subsystems"))
    runtime_workers = snapshot.runtime_workers
    runtime_worker_summary = as_dict(runtime_workers.get("summary"))
    runtime_worker_latest = as_dict(runtime_workers.get("session") or as_dict(kernel_runtime_workers.get("latest_session")))
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
    confidence_method = as_dict(last_tick.get("confidence_method"))
    if not confidence_method:
        confidence_method = as_dict(autopilot_session_metadata.get("last_confidence_method"))
    current_task_id = (
        str(autopilot_session_metadata.get("current_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_source_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_claimed_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_execution_task_id") or "").strip()
    )
    current_task = task_index.get(current_task_id, {})
    default_host_id = str(kernel_worker_fabric.get("default_host_id") or "local").strip() or "local"
    local_host = next(
        (
            as_dict(host)
            for host in kernel_worker_hosts
            if str(as_dict(host).get("host_id") or "").strip() == default_host_id
        ),
        {},
    )
    default_backend_id = str(kernel_model_router.get("default_backend_id") or "").strip()
    router_backend = {}
    for candidate in kernel_model_backends:
        item = as_dict(candidate)
        backend_id = str(item.get("backend_id") or "").strip()
        if default_backend_id and backend_id == default_backend_id:
            router_backend = item
            break
    if not router_backend and kernel_model_backends:
        router_backend = as_dict(kernel_model_backends[0])
    active_swarm_profile = as_dict(kernel_swarm_profiles[0]) if kernel_swarm_profiles else {}
    operator_brief = as_dict(snapshot.operator_brief)
    operator_brief_delegation = as_dict(operator_brief.get("delegation_brief"))
    operator_brief_compile = as_dict(operator_brief.get("compile_brief_artifact"))
    current_objective = compact_single_line(
        str(
            operator_brief.get("current_objective")
            or current_task.get("objective")
            or as_dict(current_task.get("payload")).get("task_objective")
            or autopilot_session_metadata.get("last_source_task_objective")
            or ""
        ),
        220,
    )
    delegation_brief = operator_brief_delegation or primary_delegation_brief(latest_decision, latest, autopilot_session_metadata)
    spawn_path = (
        build_spawn_path(latest_decision, latest, autopilot_session_metadata)
        if not operator_brief_delegation
        else compact_single_line(
            f"ring-leader -> {operator_brief_delegation.get('delegate_agent_id') or 'n/a'}",
            120,
        )
    )
    execution_task_ids = dedupe(
        as_list(operator_brief.get("execution_backlog"))
        + as_list(as_dict(last_tick.get("execution")).get("task_ids"))
        + as_list(autopilot_session_metadata.get("last_execution_task_ids"))
    )
    maintain_subsystem_tokens = []
    for key, label in [
        ("transcript_auto_squish", "squish"),
        ("imprint_auto_snapshot", "snap"),
        ("trichat_auto_retention", "retain"),
        ("trichat_turn_watchdog", "watch"),
    ]:
        subsystem = as_dict(autonomy_maintain_subsystems.get(key))
        if not subsystem.get("enabled"):
            continue
        token = "ok"
        if subsystem.get("last_error"):
            token = "err"
        elif not subsystem.get("running"):
            token = "down"
        elif subsystem.get("stale"):
            token = "stale"
        maintain_subsystem_tokens.append(f"{label}={token}")
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
        fit_text(
            "Fabric :: "
            f"hosts={parse_any_int(kernel_worker_fabric.get('host_count'))} "
            f"healthy={parse_any_int(as_dict(kernel_worker_fabric.get('health_counts')).get('healthy'))} "
            f"degraded={parse_any_int(as_dict(kernel_worker_fabric.get('health_counts')).get('degraded'))} "
            f"default={kernel_worker_fabric.get('default_host_id') or 'n/a'}",
            width,
        ),
        fit_text(
            "Local :: "
            f"cpu={parse_any_float(local_host.get('cpu_utilization')) * 100:.0f}% "
            f"ram={parse_any_float(local_host.get('ram_available_gb')):.1f}/{parse_any_float(local_host.get('ram_total_gb')):.1f}GB "
            f"swap={parse_any_float(local_host.get('swap_used_gb')):.1f}GB "
            f"thermal={local_host.get('thermal_pressure') or 'n/a'} "
            f"workers={parse_any_int(local_host.get('worker_count'))}/{parse_any_int(local_host.get('recommended_worker_count'))} "
            f"models={parse_any_int(local_host.get('max_local_model_concurrency'))} "
            f"age={human_duration(age_seconds(local_host.get('heartbeat_at')))}",
            width,
        ),
        fit_text(
            "Topology :: "
            f"nodes={parse_any_int(kernel_cluster_topology.get('node_count'))} "
            f"active={parse_any_int(kernel_cluster_topology.get('active_node_count'))} "
            f"planned={parse_any_int(kernel_cluster_topology.get('planned_node_count'))} "
            f"default={kernel_cluster_topology.get('default_node_id') or 'n/a'}",
            width,
        ),
        fit_text(
            "Router :: "
            f"backends={parse_any_int(kernel_model_router.get('backend_count'))} "
            f"enabled={parse_any_int(kernel_model_router.get('enabled_backend_count'))} "
            f"default={kernel_model_router.get('default_backend_id') or 'n/a'} "
            f"strategy={kernel_model_router.get('strategy') or 'n/a'}",
            width,
        ),
        fit_text(
            "Router live :: "
            f"backend={router_backend.get('backend_id') or 'n/a'} "
            f"probe={'ok' if router_backend.get('probe_healthy') is True else 'down' if router_backend.get('probe_healthy') is False else 'n/a'} "
            f"known={'yes' if router_backend.get('probe_model_known') is True else 'no' if router_backend.get('probe_model_known') is False else 'n/a'} "
            f"loaded={'warm' if router_backend.get('probe_model_loaded') is True else 'cold' if router_backend.get('probe_model_loaded') is False else 'n/a'} "
            f"lat={parse_any_float(router_backend.get('latency_ms_p50')):.0f}ms "
            f"tps={parse_any_float(router_backend.get('throughput_tps')):.1f} "
            f"res={parse_any_int(router_backend.get('probe_resident_model_count'))} "
            f"vram={parse_any_float(router_backend.get('probe_resident_vram_gb')):.1f}GB "
            f"age={human_duration(age_seconds(router_backend.get('probe_generated_at') or router_backend.get('heartbeat_at')))}",
            width,
        ),
        fit_text(
            "Evals :: "
            f"suites={parse_any_int(kernel_evals.get('suite_count'))} "
            f"cases={parse_any_int(kernel_evals.get('total_case_count'))} "
            f"router_cases={parse_any_int(kernel_evals.get('router_case_count'))}",
            width,
        ),
        fit_text(
            "Observability :: "
            f"docs={parse_any_int(kernel_observability.get('document_count'))} "
            f"errors15m={parse_any_int(kernel_observability.get('recent_error_count'))} "
            f"critical15m={parse_any_int(kernel_observability.get('recent_critical_count'))} "
            f"top_source={as_dict(as_list(kernel_observability.get('source_kind_counts'))[0] if as_list(kernel_observability.get('source_kind_counts')) else {}).get('source_kind') or 'n/a'} "
            f"top_service={as_dict(as_list(kernel_observability.get('service_counts'))[0] if as_list(kernel_observability.get('service_counts')) else {}).get('service') or 'n/a'}",
            width,
        ),
        fit_text(
            "Org :: "
            f"roles={parse_any_int(kernel_org_programs.get('role_count'))} "
            f"active_versions={parse_any_int(kernel_org_programs.get('active_version_count'))} "
            f"candidates={parse_any_int(kernel_org_programs.get('candidate_version_count'))} "
            f"optimized={parse_any_int(kernel_org_programs.get('optimized_role_count'))}",
            width,
        ),
        fit_text(
            "Swarm :: "
            f"active={parse_any_int(kernel_swarm.get('active_profile_count'))} "
            f"hier={parse_any_int(as_dict(kernel_swarm.get('topology_counts')).get('hierarchical'))} "
            f"mesh={parse_any_int(as_dict(kernel_swarm.get('topology_counts')).get('mesh'))} "
            f"adaptive={parse_any_int(as_dict(kernel_swarm.get('topology_counts')).get('adaptive'))} "
            f"checkpoints={parse_any_int(kernel_swarm.get('checkpoint_artifact_count'))}",
            width,
        ),
        fit_text(
            "Maintain :: "
            f"enabled={'yes' if autonomy_maintain_state.get('enabled') else 'no'} "
            f"running={'yes' if autonomy_maintain_runtime.get('running') else 'no'} "
            f"stale={'yes' if autonomy_maintain_due.get('stale') else 'no'} "
            f"eval_due={'yes' if autonomy_maintain_due.get('eval') else 'no'} "
            f"last_eval={kernel_autonomy_maintain.get('last_eval_score') if kernel_autonomy_maintain.get('last_eval_score') is not None else 'n/a'}",
            width,
        ),
        fit_text(
            "Daemons :: " + (", ".join(maintain_subsystem_tokens) or "none"),
            width,
        ),
        fit_text(
            "Reactions :: "
            f"enabled={'yes' if kernel_reaction_engine.get('enabled') else 'no'} "
            f"running={'yes' if as_dict(kernel_reaction_engine.get('runtime')).get('running') else 'no'} "
            f"stale={'yes' if kernel_reaction_engine.get('stale') else 'no'} "
            f"channels={','.join(as_list(kernel_reaction_engine.get('channels'))[:3]) or 'none'} "
            f"sent={parse_any_int(kernel_reaction_engine.get('last_sent_count'))}",
            width,
        ),
        fit_text(
            "Runtime Workers :: "
            f"active={parse_any_int(kernel_runtime_workers.get('active_count') or runtime_worker_summary.get('active_count'))} "
            f"failed={parse_any_int(as_dict(kernel_runtime_workers.get('counts')).get('failed') or as_dict(runtime_worker_summary.get('counts')).get('failed'))} "
            f"sessions={parse_any_int(kernel_runtime_workers.get('session_count') or runtime_worker_summary.get('session_count'))} "
            f"latest={runtime_worker_latest.get('runtime_id') or 'n/a'}:{runtime_worker_latest.get('status') or 'n/a'} "
            f"task={runtime_worker_latest.get('task_id') or 'n/a'}",
            width,
        ),
        fit_text(
            "Exports :: "
            f"bundles={parse_any_int(kernel_workflow_exports.get('bundle_count'))} "
            f"metrics={parse_any_int(kernel_workflow_exports.get('metrics_count'))} "
            f"argo={parse_any_int(kernel_workflow_exports.get('argo_contract_count'))} "
            f"latest={human_duration(age_seconds(as_dict(kernel_workflow_exports.get('latest_bundle')).get('created_at')))}",
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
    if kernel_routing_outlook:
        for entry in kernel_routing_outlook[:4]:
            item = as_dict(entry)
            task_kind = str(item.get("task_kind") or "n/a").strip() or "n/a"
            selected_backend = str(item.get("selected_backend_id") or "n/a").strip() or "n/a"
            selected_provider = str(item.get("selected_provider") or "n/a").strip() or "n/a"
            top_planned_backend = str(item.get("top_planned_backend_id") or "n/a").strip() or "n/a"
            top_planned_node = str(item.get("top_planned_node_id") or "n/a").strip() or "n/a"
            planned_count = parse_any_int(item.get("planned_backend_count"))
            lines.append(
                fit_text(
                    f"Hybrid {task_kind} :: live={selected_backend}/{selected_provider} "
                    f"next={top_planned_backend}@{top_planned_node} "
                    f"planned={planned_count}",
                    width,
                )
            )
    if last_tick:
        adjustment = float(learning_signal.get("confidence_adjustment") or 0)
        lines.append(
            fit_text(
                "Ring leader :: "
                f"tick_ok={'yes' if last_tick.get('ok') else 'no'} "
                f"confidence={float(last_tick.get('council_confidence') or 0):.2f} "
                f"substance={float(last_tick.get('plan_substance') or 0):.2f} "
                f"prefer={parse_any_int(learning_signal.get('matched_prefer'))} "
                f"avoid={parse_any_int(learning_signal.get('matched_avoid'))} "
                f"adj={adjustment:+.2f}",
                width,
            )
        )
        rationale = as_list(learning_signal.get("rationale"))
        if rationale:
            lines.extend(wrap_lines(f"Learning signal: {rationale[0]}", width, 2))
        if confidence_method:
            checks = as_dict(confidence_method.get("checks"))
            lines.extend(
                wrap_lines(
                    "Confidence method: "
                    f"mode={confidence_method.get('mode') or 'gsd-confidence'} "
                    f"score={float(confidence_method.get('score') or 0):.2f} "
                    f"adj={float(confidence_method.get('confidence_adjustment') or 0):+.2f}",
                    width,
                    2,
                )
            )
            if checks:
                lines.extend(
                    wrap_lines(
                        "Checks: "
                        f"owner={float(checks.get('owner_clarity') or 0):.2f} "
                        f"action={float(checks.get('actionability') or 0):.2f} "
                        f"evidence={float(checks.get('evidence_bar') or 0):.2f} "
                        f"rollback={float(checks.get('rollback_ready') or 0):.2f} "
                        f"anti_echo={float(checks.get('anti_echo') or 0):.2f}",
                        width,
                        2,
                    )
                )
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
    if active_swarm_profile:
        lines.append("")
        lines.append(fit_text("Swarm profile:", width))
        lines.append(
            fit_text(
                "  "
                f"topology={active_swarm_profile.get('topology') or 'n/a'} "
                f"consensus={active_swarm_profile.get('consensus_mode') or 'n/a'} "
                f"queen={active_swarm_profile.get('queen_mode') or 'n/a'} "
                f"mode={active_swarm_profile.get('execution_mode') or 'n/a'}",
                width,
            )
        )
        lines.append(
            fit_text(
                "  "
                f"cadence={active_swarm_profile.get('checkpoint_cadence') or 'n/a'} "
                f"memory_hits={parse_any_int(active_swarm_profile.get('memory_match_count'))} "
                f"checkpoints={parse_any_int(active_swarm_profile.get('checkpoint_count'))} "
                f"last={human_duration(age_seconds(active_swarm_profile.get('last_checkpoint_at')))}",
                width,
            )
        )
    lines.append("")
    lines.append(fit_text(f"Spawn path: {spawn_path}", width))
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
    if operator_brief_compile:
        lines.append("")
        lines.append(
            fit_text(
                "Compile brief :: "
                f"{operator_brief_compile.get('artifact_id') or 'n/a'} "
                f"type={operator_brief_compile.get('artifact_type') or 'n/a'}",
                width,
            )
        )
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


def build_gui_snapshot(snapshot: DashboardSnapshot, theme: str) -> Dict[str, Any]:
    agents = select_display_agents(snapshot.roster, snapshot.workboard)
    presences = derive_presence_map(
        agents,
        snapshot.workboard,
        snapshot.tmux,
        snapshot.task_running,
        snapshot.task_pending,
        snapshot.agent_sessions,
        snapshot.adapter,
        snapshot.bus_tail,
        snapshot.fetched_at,
    )
    rooms = partition_office_presences(presences)
    counts = state_counts(presences)
    kernel = as_dict(snapshot.kernel)
    kernel_overview = as_dict(kernel.get("overview"))
    kernel_worker_fabric = as_dict(kernel.get("worker_fabric"))
    kernel_model_router = as_dict(kernel.get("model_router"))
    kernel_runtime_workers = as_dict(kernel.get("runtime_workers"))
    kernel_reaction_engine = as_dict(kernel.get("reaction_engine"))
    kernel_autonomy_maintain = as_dict(kernel.get("autonomy_maintain"))
    kernel_swarm = as_dict(kernel.get("swarm"))
    kernel_observability = as_dict(kernel.get("observability"))
    kernel_workflow_exports = as_dict(kernel.get("workflow_exports"))
    tmux_state = as_dict(snapshot.tmux.get("state"))
    tmux_dashboard = as_dict(snapshot.tmux.get("dashboard"))
    task_counts = as_dict(snapshot.task_summary.get("counts"))
    learning = as_dict(snapshot.learning)
    workboard = as_dict(snapshot.workboard)
    latest_turn = as_dict(workboard.get("latest_turn"))
    latest_decision = as_dict(workboard.get("latest_decision"))
    autopilot_session = latest_autopilot_session(snapshot)
    autopilot_session_metadata = as_dict(autopilot_session.get("metadata"))
    last_tick = as_dict(snapshot.autopilot.get("last_tick"))
    task_index = build_task_index(snapshot.task_running, snapshot.task_pending)
    current_task_id = (
        str(autopilot_session_metadata.get("current_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_source_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_claimed_task_id") or "").strip()
        or str(autopilot_session_metadata.get("last_execution_task_id") or "").strip()
    )
    current_task = task_index.get(current_task_id, {})
    runtime_workers = as_dict(snapshot.runtime_workers)
    runtime_worker_summary = as_dict(runtime_workers.get("summary"))
    runtime_worker_latest = as_dict(runtime_workers.get("session") or as_dict(kernel_runtime_workers.get("latest_session")))
    default_host_id = str(kernel_worker_fabric.get("default_host_id") or "local").strip() or "local"
    local_host = next(
        (
            as_dict(host)
            for host in as_list(kernel_worker_fabric.get("hosts"))
            if str(as_dict(host).get("host_id") or "").strip() == default_host_id
        ),
        {},
    )
    default_backend_id = str(kernel_model_router.get("default_backend_id") or "").strip()
    router_backend = {}
    for candidate in as_list(kernel_model_router.get("backends")):
        item = as_dict(candidate)
        backend_id = str(item.get("backend_id") or "").strip()
        if default_backend_id and backend_id == default_backend_id:
            router_backend = item
            break
    if not router_backend and as_list(kernel_model_router.get("backends")):
        router_backend = as_dict(as_list(kernel_model_router.get("backends"))[0])
    delegation_brief = primary_delegation_brief(latest_decision, latest_turn, autopilot_session_metadata)
    execution_task_ids = dedupe(
        as_list(as_dict(last_tick.get("execution")).get("task_ids"))
        + as_list(autopilot_session_metadata.get("last_execution_task_ids"))
    )

    return {
        "thread_id": snapshot.thread_id,
        "fetched_at": snapshot.fetched_at,
        "fetched_at_iso": datetime.fromtimestamp(snapshot.fetched_at, tz=timezone.utc).isoformat(),
        "theme": normalize_theme(theme),
        "errors": list(snapshot.errors),
        "counts": counts,
        "agents": [
            {
                "agent": dataclasses.asdict(presence.agent),
                "token": presence.agent.token,
                "state": presence.state,
                "activity": presence.activity,
                "location": presence.location,
                "actions": list(presence.actions),
                "evidence_source": presence.evidence_source,
                "evidence_detail": presence.evidence_detail,
            }
            for presence in presences
        ],
        "rooms": {
            room_name: [presence.agent.agent_id for presence in room_presences]
            for room_name, room_presences in rooms.items()
        },
        "summary": {
            "tasks": {
                "pending": parse_any_int(task_counts.get("pending")),
                "running": parse_any_int(task_counts.get("running")),
                "failed": parse_any_int(task_counts.get("failed")),
                "completed": parse_any_int(task_counts.get("completed")),
            },
            "tmux": {
                "enabled": bool(tmux_state.get("enabled")),
                "worker_count": parse_any_int(tmux_state.get("worker_count")),
                "queue_depth": parse_any_int(tmux_dashboard.get("queue_depth")),
                "queue_age_seconds": float(tmux_dashboard.get("queue_age_seconds") or 0),
                "failure_count": parse_any_int(tmux_dashboard.get("failure_count")),
            },
            "kernel": {
                "state": kernel.get("state") or "n/a",
                "active_sessions": parse_any_int(kernel_overview.get("active_session_count")),
                "healthy": parse_any_int(as_dict(kernel.get("adaptive_session_counts")).get("healthy")),
                "degraded": parse_any_int(as_dict(kernel.get("adaptive_session_counts")).get("degraded")),
                "attention": as_list(kernel.get("attention"))[:6],
            },
            "local_host": {
                "host_id": default_host_id,
                "cpu_utilization": parse_any_float(local_host.get("cpu_utilization")),
                "ram_available_gb": parse_any_float(local_host.get("ram_available_gb")),
                "ram_total_gb": parse_any_float(local_host.get("ram_total_gb")),
                "swap_used_gb": parse_any_float(local_host.get("swap_used_gb")),
                "thermal_pressure": local_host.get("thermal_pressure") or "n/a",
                "worker_count": parse_any_int(local_host.get("worker_count")),
                "recommended_worker_count": parse_any_int(local_host.get("recommended_worker_count")),
                "max_local_model_concurrency": parse_any_int(local_host.get("max_local_model_concurrency")),
            },
            "router": {
                "backend_count": parse_any_int(kernel_model_router.get("backend_count")),
                "enabled_backend_count": parse_any_int(kernel_model_router.get("enabled_backend_count")),
                "default_backend_id": kernel_model_router.get("default_backend_id") or "n/a",
                "strategy": kernel_model_router.get("strategy") or "n/a",
                "routing_outlook": as_list(kernel_model_router.get("routing_outlook"))[:6],
                "live_backend": {
                    "backend_id": router_backend.get("backend_id") or "n/a",
                    "probe_healthy": router_backend.get("probe_healthy"),
                    "probe_model_known": router_backend.get("probe_model_known"),
                    "probe_model_loaded": router_backend.get("probe_model_loaded"),
                    "latency_ms_p50": parse_any_float(router_backend.get("latency_ms_p50")),
                    "throughput_tps": parse_any_float(router_backend.get("throughput_tps")),
                    "probe_resident_model_count": parse_any_int(router_backend.get("probe_resident_model_count")),
                    "probe_resident_vram_gb": parse_any_float(router_backend.get("probe_resident_vram_gb")),
                },
            },
            "runtime_workers": {
                "session_count": parse_any_int(kernel_runtime_workers.get("session_count") or runtime_worker_summary.get("session_count")),
                "active_count": parse_any_int(kernel_runtime_workers.get("active_count") or runtime_worker_summary.get("active_count")),
                "failed_count": parse_any_int(
                    as_dict(kernel_runtime_workers.get("counts")).get("failed")
                    or as_dict(runtime_worker_summary.get("counts")).get("failed")
                ),
                "latest_session": runtime_worker_latest,
            },
            "learning": {
                "active_entry_count": parse_any_int(learning.get("active_entry_count")),
                "agents_with_active_entries": parse_any_int(learning.get("agents_with_active_entries")),
                "prefer_count": parse_any_int(learning.get("prefer_count")),
                "avoid_count": parse_any_int(learning.get("avoid_count")),
                "top_agents": as_list(learning.get("top_agents"))[:8],
            },
            "reaction_engine": {
                "enabled": bool(kernel_reaction_engine.get("enabled")),
                "runtime_running": bool(as_dict(kernel_reaction_engine.get("runtime")).get("running")),
                "stale": bool(kernel_reaction_engine.get("stale")),
                "channels": as_list(kernel_reaction_engine.get("channels"))[:4],
                "last_sent_count": parse_any_int(kernel_reaction_engine.get("last_sent_count")),
            },
            "observability": {
                "document_count": parse_any_int(kernel_observability.get("document_count")),
                "recent_error_count": parse_any_int(kernel_observability.get("recent_error_count")),
                "recent_critical_count": parse_any_int(kernel_observability.get("recent_critical_count")),
                "source_kind_counts": as_list(kernel_observability.get("source_kind_counts"))[:4],
                "service_counts": as_list(kernel_observability.get("service_counts"))[:4],
            },
            "maintain": {
                "enabled": bool(as_dict(snapshot.autonomy_maintain.get("state")).get("enabled")),
                "running": bool(as_dict(snapshot.autonomy_maintain.get("runtime")).get("running")),
                "stale": bool(as_dict(snapshot.autonomy_maintain.get("due")).get("stale")),
                "eval_due": bool(as_dict(snapshot.autonomy_maintain.get("due")).get("eval")),
                "last_eval_score": kernel_autonomy_maintain.get("last_eval_score"),
                "subsystems": as_dict(snapshot.autonomy_maintain.get("subsystems")),
            },
            "swarm": {
                "active_profile_count": parse_any_int(kernel_swarm.get("active_profile_count")),
                "checkpoint_artifact_count": parse_any_int(kernel_swarm.get("checkpoint_artifact_count")),
                "active_profiles": as_list(kernel_swarm.get("active_profiles"))[:4],
            },
            "workflow_exports": {
                "bundle_count": parse_any_int(kernel_workflow_exports.get("bundle_count")),
                "metrics_count": parse_any_int(kernel_workflow_exports.get("metrics_count")),
                "argo_contract_count": parse_any_int(kernel_workflow_exports.get("argo_contract_count")),
            },
        },
        "current": {
            "decision_summary": latest_decision.get("decision_summary") or latest_turn.get("decision_summary") or "",
            "selected_strategy": latest_decision.get("selected_strategy") or latest_turn.get("selected_strategy") or "",
            "selected_agent": latest_decision.get("selected_agent") or latest_turn.get("selected_agent") or "",
            "current_task_id": current_task_id,
            "current_objective": compact_single_line(
                str(
                    current_task.get("objective")
                    or as_dict(current_task.get("payload")).get("task_objective")
                    or autopilot_session_metadata.get("last_source_task_objective")
                    or ""
                ),
                220,
            ),
            "spawn_path": build_spawn_path(latest_decision, latest_turn, autopilot_session_metadata),
            "delegation_brief": delegation_brief,
            "execution_task_ids": execution_task_ids,
            "confidence_method": as_dict(last_tick.get("confidence_method") or autopilot_session_metadata.get("last_confidence_method")),
            "learning_signal": as_dict(last_tick.get("learning_signal") or autopilot_session_metadata.get("last_learning_signal")),
            "last_tick": last_tick,
        },
        "events": as_list(snapshot.bus_tail.get("events"))[:20],
        "runtime_sessions": as_list(runtime_workers.get("sessions"))[:20],
    }


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
    host_load = as_list(tmux_dashboard.get("host_load"))
    if host_load:
        lines.append(fit_text("Hosts:", width))
        for host_raw in host_load[:4]:
            host = as_dict(host_raw)
            lines.append(
                fit_text(
                    f"  {host.get('host_id') or 'host'} "
                    f"health={host.get('health_state') or 'n/a'} "
                    f"score={float(host.get('health_score') or 0):.2f} "
                    f"workers={parse_any_int(host.get('worker_count'))} "
                    f"queue={parse_any_int(host.get('active_queue'))} "
                    f"load={parse_any_int(host.get('active_load'))} "
                    f"cpu={parse_any_float(host.get('cpu_utilization')) * 100:.0f}% "
                    f"ram={parse_any_float(host.get('ram_available_gb')):.1f}GB "
                    f"thermal={host.get('thermal_pressure') or 'n/a'}",
                    width,
                )
            )
        lines.append("")
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
    runtime_worker_state = snapshot.runtime_workers
    runtime_worker_summary = as_dict(runtime_worker_state.get("summary"))
    runtime_worker_sessions = [as_dict(session) for session in as_list(runtime_worker_state.get("sessions"))]
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
            f"runtime_sessions={parse_any_int(runtime_worker_summary.get('session_count'))} "
            f"runtime_active={parse_any_int(runtime_worker_summary.get('active_count'))} "
            f"runtime_failed={parse_any_int(as_dict(runtime_worker_summary.get('counts')).get('failed'))}",
            width,
        ),
        fit_text(
            f"total={parse_any_int(as_dict(tmux_state.get('counts')).get('total'))} "
            f"running={parse_any_int(as_dict(tmux_state.get('counts')).get('running'))} "
            f"queued={parse_any_int(as_dict(tmux_state.get('counts')).get('queued'))} "
            f"dispatched={parse_any_int(as_dict(tmux_state.get('counts')).get('dispatched'))}",
            width,
        ),
        "",
    ]
    if runtime_worker_sessions:
        lines.append(fit_text("Runtime worker sessions:", width))
        for session in runtime_worker_sessions[: max(2, min(6, height - 8))]:
            lines.append(
                fit_text(
                    f"{session.get('session_id') or 'session'} [{session.get('status') or 'n/a'}] "
                    f"{session.get('runtime_id') or 'n/a'} task={session.get('task_id') or 'n/a'}",
                    width,
                )
            )
            lines.append(
                fit_text(
                    f"  worktree: {compact_single_line(str(session.get('worktree_path') or 'n/a'), max(24, width - 12))}",
                    width,
                )
            )
            if session.get("last_error"):
                lines.append(
                    fit_text(
                        f"  error: {compact_single_line(str(session.get('last_error') or ''), max(20, width - 10))}",
                        width,
                    )
                )
            lines.append("")
    if not tasks and not fallback_backlog and not runtime_worker_sessions:
        lines.append(fit_text("No tmux or runtime-worker tasks recorded.", width))
        return lines[: max(1, height)]
    for task_raw in tasks[: max(4, height - 6)]:
        task = as_dict(task_raw)
        metadata = as_dict(task.get("metadata"))
        owners, supervisors, target_source = extract_explicit_task_agents(catalog, task)
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
        if owners or supervisors:
            owner_summary = ", ".join(owners) or "n/a"
            supervisor_summary = ", ".join(supervisors) or "n/a"
            lines.append(
                fit_text(
                    f"  agents: owners={owner_summary} supervise={supervisor_summary} src={target_source or 'explicit'}",
                    width,
                )
            )
        for agent_id in owners[:2]:
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


def render_help_view(width: int, height: int, theme: str = "night") -> List[str]:
    lines = [
        fit_text("HELP", width),
        fit_text("1 Office   2 Briefing   3 Lanes   4 Workers   5 Intake   h Help", width),
        fit_text("r Refresh  p Pause      t Theme   q Quit", width),
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
        fit_text("- autonomy.command (via the tmux intake desk)", width),
        "",
        fit_text("Truth mode:", width),
        fit_text("- WORK / LEAD require explicit task, session, or active-turn evidence", width),
        fit_text("- CHAT / BREAK require real agent bus events", width),
        fit_text("- BLOCK / DOWN require adapter telemetry", width),
        fit_text("- Unowned tmux titles never create fake ownership", width),
        "",
        fit_text("Agents can stack action badges: desk/code, brief/multi, chat/coffee, break/reset, or sleep/nap.", width),
        fit_text(f"Current theme: {theme_label(theme)}", width),
        "",
        fit_text("Built-in methodology wins:", width),
        fit_text("- Ralph-style live operator surface, tabs, and persistent tmux war room", width),
        fit_text("- GSD-style bounded work packets with one owner, evidence, and rollback", width),
        fit_text("- autoresearch-style small-budget loops and org-first delegation discipline", width),
        fit_text("- SuperClaude-inspired confidence checks before high-confidence plans", width),
        fit_text("- 5 jumps to the live intake desk when running inside Agent Office tmux", width),
    ]
    if len(lines) > height:
        compacted: List[str] = []
        blank_budget = max(0, len(lines) - height)
        for line in lines:
            if line == "" and blank_budget > 0:
                blank_budget -= 1
                continue
            compacted.append(line)
        lines = compacted
    return lines[: max(1, height)]


def render_view(snapshot: DashboardSnapshot, view: str, width: int, height: int, frame: int, theme: str = "night") -> List[str]:
    if view == "briefing":
        return render_briefing_view(snapshot, width, height)
    if view == "lanes":
        return render_lanes_view(snapshot, width, height)
    if view == "workers":
        return render_workers_view(snapshot, width, height)
    if view == "help":
        return render_help_view(width, height, theme=theme)
    return render_office_view(snapshot, width, height, frame, theme=theme)


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


def init_colors(theme: str = "night") -> None:
    if not curses.has_colors():
        return
    curses.start_color()
    curses.use_default_colors()
    normalized = normalize_theme(theme)
    palettes = {
        "night": (curses.COLOR_CYAN, curses.COLOR_WHITE, curses.COLOR_GREEN, curses.COLOR_YELLOW, curses.COLOR_MAGENTA, curses.COLOR_RED, curses.COLOR_BLUE, curses.COLOR_CYAN),
        "sunrise": (curses.COLOR_YELLOW, curses.COLOR_WHITE, curses.COLOR_GREEN, curses.COLOR_CYAN, curses.COLOR_MAGENTA, curses.COLOR_RED, curses.COLOR_YELLOW, curses.COLOR_MAGENTA),
        "mono": (curses.COLOR_WHITE, curses.COLOR_WHITE, curses.COLOR_WHITE, curses.COLOR_WHITE, curses.COLOR_WHITE, curses.COLOR_WHITE, curses.COLOR_WHITE, curses.COLOR_WHITE),
    }
    selected = palettes[normalized]
    for index, color in enumerate(selected, start=1):
        curses.init_pair(index, color, -1)


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


def fetch_snapshot(caller: McpToolCaller, thread_id: str, theme: str = "night") -> DashboardSnapshot:
    if caller.can_use_http_snapshot():
        try:
            payload = caller.fetch_http_snapshot(thread_id, theme)
            if payload:
                return DashboardSnapshot(
                    thread_id=str(payload.get("thread_id") or thread_id).strip() or thread_id,
                    fetched_at=time.time(),
                    roster=as_dict(payload.get("roster")),
                    workboard=as_dict(payload.get("workboard")),
                    tmux=as_dict(payload.get("tmux")),
                    task_summary=as_dict(payload.get("task_summary")),
                    adapter=as_dict(payload.get("adapter")),
                    bus_tail=as_dict(payload.get("bus_tail")),
                    trichat_summary=as_dict(payload.get("trichat_summary")),
                    kernel=as_dict(payload.get("kernel")),
                    learning=as_dict(payload.get("learning")),
                    autopilot=as_dict(payload.get("autopilot")),
                    autonomy_maintain=as_dict(payload.get("autonomy_maintain")),
                    runtime_workers=as_dict(payload.get("runtime_workers")),
                    operator_brief=as_dict(payload.get("operator_brief")),
                    errors=[compact_single_line(str(item), 160) for item in as_list(payload.get("errors"))],
                    agent_sessions=as_dict(payload.get("agent_sessions")),
                    task_running=as_dict(payload.get("task_running")),
                    task_pending=as_dict(payload.get("task_pending")),
                )
        except Exception:
            pass

    office_snapshot_error: Optional[str] = None
    try:
        payload = as_dict(
            caller.call_tool(
                "office.snapshot",
                {
                    "thread_id": thread_id,
                    "turn_limit": 12,
                    "task_limit": 24,
                    "session_limit": 50,
                    "event_limit": 24,
                    "learning_limit": 120,
                    "runtime_worker_limit": 20,
                    "include_kernel": True,
                    "include_learning": True,
                    "include_bus": True,
                    "include_adapter": True,
                    "include_runtime_workers": True,
                },
            )
        )
        if payload:
            return DashboardSnapshot(
                thread_id=str(payload.get("thread_id") or thread_id).strip() or thread_id,
                fetched_at=time.time(),
                roster=as_dict(payload.get("roster")),
                workboard=as_dict(payload.get("workboard")),
                tmux=as_dict(payload.get("tmux")),
                task_summary=as_dict(payload.get("task_summary")),
                adapter=as_dict(payload.get("adapter")),
                bus_tail=as_dict(payload.get("bus_tail")),
                trichat_summary=as_dict(payload.get("trichat_summary")),
                kernel=as_dict(payload.get("kernel")),
                learning=as_dict(payload.get("learning")),
                autopilot=as_dict(payload.get("autopilot")),
                autonomy_maintain=as_dict(payload.get("autonomy_maintain")),
                runtime_workers=as_dict(payload.get("runtime_workers")),
                operator_brief=as_dict(payload.get("operator_brief")),
                errors=[compact_single_line(str(item), 160) for item in as_list(payload.get("errors"))],
                agent_sessions=as_dict(payload.get("agent_sessions")),
                task_running=as_dict(payload.get("task_running")),
                task_pending=as_dict(payload.get("task_pending")),
            )
    except Exception as error:  # noqa: BLE001
        office_snapshot_error = compact_single_line(f"office_snapshot: {error}", 160)

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
        "autonomy_maintain": ("autonomy.maintain", {"action": "status"}),
        "runtime_workers": ("runtime.worker", {"action": "status", "limit": 20}),
        "operator_brief": (
            "operator.brief",
            {
                "thread_id": thread_id,
                "include_kernel": False,
                "include_runtime_brief": False,
                "include_compile_brief": True,
            },
        ),
    }
    results: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    if office_snapshot_error:
        errors.append(office_snapshot_error)
    with concurrent.futures.ThreadPoolExecutor(max_workers=snapshot_max_workers(caller.transport, len(requests))) as pool:
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
    if not as_list(as_dict(results.get("roster", {})).get("agents")):
        fallback_roster = build_config_roster_fallback(
            caller.repo_root,
            as_dict(results.get("workboard", {})),
            as_dict(results.get("agent_sessions", {})),
            as_dict(results.get("learning", {})),
        )
        if fallback_roster:
            results["roster"] = fallback_roster
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
        autonomy_maintain=results.get("autonomy_maintain", {}),
        runtime_workers=results.get("runtime_workers", {}),
        operator_brief=results.get("operator_brief", {}),
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
            tool_timeout_seconds=args.mcp_timeout_seconds,
        )
        self.thread_id = args.thread_id or (pick_resume_thread(self.caller) if args.resume_latest else DEFAULT_THREAD_ID)
        self.view = args.view if args.view in VIEW_ORDER else DEFAULT_VIEW
        self.theme = normalize_theme(args.theme)
        self.paused = False
        self.last_error = ""
        self.snapshot: Optional[DashboardSnapshot] = None
        self.last_refresh_started = 0.0

    def refresh(self) -> None:
        self.last_refresh_started = time.time()
        try:
            self.snapshot = fetch_snapshot(self.caller, self.thread_id, self.theme)
            write_snapshot_cache(self.repo_root, build_gui_snapshot(self.snapshot, self.theme))
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
            autonomy_maintain={},
            operator_brief={},
            errors=[self.last_error] if self.last_error else [],
        )
        lines = render_view(snapshot, self.view, self.args.width, self.args.height, frame=0, theme=self.theme)
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
        init_colors(self.theme)
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
            elif normalized == "5":
                switch_tmux_window("intake")
            elif normalized == "h":
                self.view = "help"
            elif normalized == "r":
                self.refresh()
                next_refresh_at = time.monotonic() + max(0.5, float(self.args.refresh_interval))
            elif normalized == "p":
                self.paused = not self.paused
            elif normalized == "t":
                self.theme = next_theme(self.theme)
                init_colors(self.theme)

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
            autonomy_maintain={},
            runtime_workers={},
            operator_brief={},
            errors=[self.last_error] if self.last_error else [],
            agent_sessions={},
            task_running={},
            task_pending={},
        )
        header = (
            f"Agent Office Dashboard [{self.view}] "
            f"thread={self.thread_id} refresh={self.args.refresh_interval:.1f}s "
            f"theme={theme_label(self.theme)} {'PAUSED' if self.paused else 'LIVE'}"
        )
        tabs_line = build_view_tabs(self.view, width, self.theme)
        help_line = "5 intake  r refresh  p pause  t theme  q quit"
        safe_addstr(screen, 0, 0, fit_text(header, width), curses.color_pair(8) | curses.A_BOLD)
        safe_addstr(screen, 1, 0, tabs_line, curses.color_pair(1) | curses.A_BOLD)
        safe_addstr(screen, 2, 0, fit_text(help_line, width), curses.color_pair(2))
        if self.last_error:
            safe_addstr(screen, 3, 0, fit_text(f"Last error: {self.last_error}", width), curses.color_pair(6) | curses.A_BOLD)
        else:
            stale = human_duration(time.time() - snapshot.fetched_at)
            safe_addstr(screen, 3, 0, fit_text(f"Telemetry age: {stale}", width), curses.color_pair(2))

        lines = render_view(snapshot, self.view, max(20, width - 1), max(1, height - 5), frame, theme=self.theme)
        for index, line in enumerate(lines[: max(0, height - 5)]):
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
            safe_addstr(screen, index + 5, 0, fit_text(line, width), attr)
        screen.refresh()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Animated tmux-friendly office dashboard for local agents.")
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]), help="Repository root.")
    parser.add_argument("--thread-id", default=os.environ.get("TRICHAT_OFFICE_THREAD_ID", ""), help="TriChat thread to monitor.")
    parser.add_argument("--resume-latest", action="store_true", help="Pick the latest active non-smoke thread.")
    parser.add_argument("--view", default=DEFAULT_VIEW, choices=VIEW_ORDER, help="Starting dashboard view.")
    parser.add_argument("--refresh-interval", type=float, default=float(os.environ.get("TRICHAT_OFFICE_REFRESH_SECONDS", "2.0")), help="Refresh interval in seconds.")
    parser.add_argument("--transport", default=default_transport(), choices=["stdio", "http"], help="MCP transport.")
    parser.add_argument("--url", default=os.environ.get("TRICHAT_MCP_URL", "http://127.0.0.1:8787/"), help="HTTP MCP URL.")
    parser.add_argument("--origin", default=os.environ.get("TRICHAT_MCP_ORIGIN", "http://127.0.0.1"), help="HTTP origin header.")
    parser.add_argument("--stdio-command", default=os.environ.get("TRICHAT_MCP_STDIO_COMMAND", "node"), help="STDIO MCP command.")
    parser.add_argument("--stdio-args", default=os.environ.get("TRICHAT_MCP_STDIO_ARGS", "dist/server.js"), help="STDIO MCP args.")
    parser.add_argument("--mcp-retries", type=int, default=1, help="Retry count for MCP calls.")
    parser.add_argument("--mcp-retry-delay", type=float, default=0.2, help="Base retry delay for MCP calls.")
    parser.add_argument(
        "--mcp-timeout-seconds",
        type=float,
        default=float(os.environ.get("TRICHAT_OFFICE_TOOL_TIMEOUT_SECONDS", "8.0")),
        help="Per-tool timeout for MCP helper subprocesses.",
    )
    parser.add_argument("--theme", default=os.environ.get("TRICHAT_OFFICE_THEME", "night"), choices=THEME_ORDER, help="Dashboard theme.")
    parser.add_argument("--once", action="store_true", help="Render once to stdout without curses.")
    parser.add_argument("--json-snapshot", action="store_true", help="Print a structured JSON office snapshot and exit.")
    parser.add_argument("--width", type=int, default=118, help="Plain render width when --once is used.")
    parser.add_argument("--height", type=int, default=44, help="Plain render height when --once is used.")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    app = OfficeDashboardApp(args)
    if args.json_snapshot:
        app.refresh()
        snapshot = app.snapshot or DashboardSnapshot(
            thread_id=app.thread_id,
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
            autonomy_maintain={},
            runtime_workers={},
            operator_brief={},
            errors=[app.last_error] if app.last_error else [],
            agent_sessions={},
            task_running={},
            task_pending={},
        )
        print(json.dumps(build_gui_snapshot(snapshot, app.theme), indent=2))
        return 0
    if args.once:
        return app.run_once()
    return app.run_curses()


if __name__ == "__main__":
    raise SystemExit(main())
