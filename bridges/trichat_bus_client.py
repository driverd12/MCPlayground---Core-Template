#!/usr/bin/env python3
"""Small CLI client for the TriChat Unix socket event bus."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

from common import BridgeError, bus_request, default_bus_socket_path


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="TriChat Unix socket bus client")
    parser.add_argument(
        "--socket-path",
        default=str(default_bus_socket_path()),
        help="Path to trichat bus Unix socket (default: env TRICHAT_BUS_SOCKET_PATH or ./data/trichat.bus.sock).",
    )
    parser.add_argument("--timeout", type=float, default=1.5, help="Socket timeout in seconds.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser("status", help="Read bus runtime status.")
    status_parser.set_defaults(func=command_status)

    tail_parser = subparsers.add_parser("tail", help="Read recent persisted bus events.")
    tail_parser.add_argument("--thread-id", default="", help="Optional thread id filter.")
    tail_parser.add_argument("--source-agent", default="", help="Optional source_agent filter.")
    tail_parser.add_argument("--event-type", action="append", dest="event_types", default=[], help="Optional event type filter (repeatable).")
    tail_parser.add_argument("--since-seq", type=int, default=0, help="Only events with event_seq greater than this value.")
    tail_parser.add_argument("--limit", type=int, default=50, help="Maximum events to return.")
    tail_parser.set_defaults(func=command_tail)

    publish_parser = subparsers.add_parser("publish", help="Publish one event into the bus.")
    publish_parser.add_argument("--thread-id", required=True, help="Thread id for the event.")
    publish_parser.add_argument("--event-type", required=True, help="Event type (example: adapter.turn.started).")
    publish_parser.add_argument("--source-agent", required=True, help="Source agent id.")
    publish_parser.add_argument("--source-client", default="bridges/trichat_bus_client.py", help="Source client identifier.")
    publish_parser.add_argument("--role", default="system", help="Event role label.")
    publish_parser.add_argument("--content", default="", help="Optional event content text.")
    publish_parser.add_argument("--metadata-json", default="{}", help="Optional JSON object metadata.")
    publish_parser.set_defaults(func=command_publish)

    subscribe_parser = subparsers.add_parser("subscribe", help="Subscribe to live events and stream NDJSON to stdout.")
    subscribe_parser.add_argument("--thread-id", default="", help="Optional thread id filter.")
    subscribe_parser.add_argument("--source-agent", default="", help="Optional source agent filter.")
    subscribe_parser.add_argument("--event-type", action="append", dest="event_types", default=[], help="Optional event type filter (repeatable).")
    subscribe_parser.add_argument("--since-seq", type=int, default=0, help="Replay events with seq greater than this value.")
    subscribe_parser.add_argument("--replay-limit", type=int, default=200, help="Maximum replay events sent immediately after subscribe.")
    subscribe_parser.add_argument("--max-events", type=int, default=0, help="Stop after this many streamed event messages (0 means no cap).")
    subscribe_parser.add_argument("--run-seconds", type=float, default=0.0, help="Stop after this many seconds (0 means no timeout).")
    subscribe_parser.set_defaults(func=command_subscribe)

    return parser.parse_args(argv)


def command_status(args: argparse.Namespace) -> int:
    with temporary_socket_path(args.socket_path):
        payload = bus_request({"op": "status"}, timeout_seconds=args.timeout)
    print(json.dumps(payload, ensure_ascii=True, indent=2))
    return 0


def command_tail(args: argparse.Namespace) -> int:
    command: Dict[str, Any] = {"op": "tail", "since_seq": max(0, int(args.since_seq)), "limit": max(1, int(args.limit))}
    if args.thread_id.strip():
        command["thread_id"] = args.thread_id.strip()
    if args.source_agent.strip():
        command["source_agent"] = args.source_agent.strip()
    event_types = [entry.strip() for entry in args.event_types if str(entry).strip()]
    if event_types:
        command["event_types"] = event_types
    with temporary_socket_path(args.socket_path):
        payload = bus_request(command, timeout_seconds=args.timeout)
    print(json.dumps(payload, ensure_ascii=True, indent=2))
    return 0


def command_publish(args: argparse.Namespace) -> int:
    metadata = parse_metadata(args.metadata_json)
    command: Dict[str, Any] = {
        "op": "publish",
        "thread_id": args.thread_id.strip(),
        "event_type": args.event_type.strip(),
        "source_agent": args.source_agent.strip(),
        "source_client": args.source_client.strip() or "bridges/trichat_bus_client.py",
        "role": args.role.strip() or "system",
        "content": args.content.strip(),
        "metadata": metadata,
    }
    with temporary_socket_path(args.socket_path):
        payload = bus_request(command, timeout_seconds=args.timeout)
    print(json.dumps(payload, ensure_ascii=True, indent=2))
    return 0


def command_subscribe(args: argparse.Namespace) -> int:
    socket_path = Path(args.socket_path).expanduser().resolve()
    if not socket_path.exists():
        raise BridgeError(f"trichat bus socket not found: {socket_path}")

    command: Dict[str, Any] = {
        "op": "subscribe",
        "since_seq": max(0, int(args.since_seq)),
        "replay_limit": max(1, int(args.replay_limit)),
    }
    if args.thread_id.strip():
        command["thread_id"] = args.thread_id.strip()
    if args.source_agent.strip():
        command["source_agent"] = args.source_agent.strip()
    event_types = [entry.strip() for entry in args.event_types if str(entry).strip()]
    if event_types:
        command["event_types"] = event_types

    max_events = max(0, int(args.max_events))
    run_seconds = max(0.0, float(args.run_seconds))
    deadline = time.monotonic() + run_seconds if run_seconds > 0 else 0.0

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(max(0.2, float(args.timeout)))
        client.connect(str(socket_path))
        client.sendall((json.dumps(command, ensure_ascii=True) + "\n").encode("utf-8"))

        event_count = 0
        while True:
            if deadline and time.monotonic() >= deadline:
                break
            try:
                chunk = client.recv(16384)
            except socket.timeout:
                continue
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            for raw_line in text.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                print(line)
                if is_event_line(line):
                    event_count += 1
                    if max_events and event_count >= max_events:
                        return 0
    return 0


def parse_metadata(raw: str) -> Dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise BridgeError(f"invalid --metadata-json payload: {error}") from error
    if not isinstance(parsed, dict):
        raise BridgeError("--metadata-json must decode to a JSON object")
    return parsed


def is_event_line(line: str) -> bool:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return False
    if not isinstance(parsed, dict):
        return False
    return str(parsed.get("kind") or "").strip().lower() == "event"


class temporary_socket_path:
    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path
        self.original: str | None = None

    def __enter__(self) -> None:
        import os

        self.original = os.environ.get("TRICHAT_BUS_SOCKET_PATH")
        if self.socket_path.strip():
            # Override for helper calls in this process only.
            # noqa: PTH123 - environment variable mutation is intentional.
            os.environ["TRICHAT_BUS_SOCKET_PATH"] = str(Path(self.socket_path).expanduser().resolve())

    def __exit__(self, exc_type, exc, tb) -> None:
        import os

        if self.original is None:
            os.environ.pop("TRICHAT_BUS_SOCKET_PATH", None)
        else:
            os.environ["TRICHAT_BUS_SOCKET_PATH"] = self.original


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    try:
        return int(args.func(args))
    except BridgeError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # noqa: BLE001
        print(f"unexpected trichat bus client error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
