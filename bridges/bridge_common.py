#!/usr/bin/env python3
"""Shared helpers for TriChat bridge wrappers."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

BRIDGE_PROTOCOL_VERSION = "trichat-bridge-v1"
RESPONSE_KIND = "trichat.adapter.response"
PONG_KIND = "trichat.adapter.pong"
DEFAULT_OBJECTIVE = "Propose a safe reliability improvement for TriChat."
DEFAULT_COMMANDS = [
    "npm run build",
    "npm test",
    "git status",
]

TRANSIENT_FAILURE_MARKERS = (
    "429",
    "408",
    "500",
    "502",
    "503",
    "504",
    "deadline exceeded",
    "timed out",
    "timeout",
    "try again",
    "temporarily unavailable",
    "temporarily overloaded",
    "service unavailable",
    "connection reset",
    "connection refused",
    "network is unreachable",
    "resource exhausted",
    "rate limit",
    "quota",
    "overloaded",
    "econnreset",
    "econnrefused",
    "etimedout",
)

PERMANENT_FAILURE_MARKERS = (
    "command not found",
    "no such file or directory",
    "not logged in",
    "login required",
    "unauthorized",
    "forbidden",
    "permission denied",
    "invalid api key",
    "api key not valid",
    "unrecognized arguments",
    "unknown option",
    "usage:",
)


@dataclass(frozen=True)
class BridgeContext:
    payload: dict[str, Any]
    op: str
    agent_id: str
    request_id: str
    protocol_version: str
    thread_id: str
    objective: str
    response_mode: str
    workspace: Path


@dataclass(frozen=True)
class DelegationBrief:
    delegate_agent_id: str | None = None
    task_objective: str | None = None
    success_criteria: list[str] | None = None
    evidence_requirements: list[str] | None = None
    rollback_notes: list[str] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "delegate_agent_id": self.delegate_agent_id,
            "task_objective": self.task_objective,
            "success_criteria": list(self.success_criteria or []),
            "evidence_requirements": list(self.evidence_requirements or []),
            "rollback_notes": list(self.rollback_notes or []),
        }


@dataclass(frozen=True)
class Proposal:
    strategy: str
    commands: list[str]
    confidence: float
    mentorship_note: str
    delegate_agent_id: str | None = None
    task_objective: str | None = None
    success_criteria: list[str] | None = None
    evidence_requirements: list[str] | None = None
    rollback_notes: list[str] | None = None
    delegations: list[DelegationBrief] | None = None

    def to_json(self) -> str:
        return json.dumps(
            {
                "strategy": self.strategy,
                "commands": self.commands,
                "confidence": self.confidence,
                "mentorship_note": self.mentorship_note,
                "delegate_agent_id": self.delegate_agent_id,
                "task_objective": self.task_objective,
                "success_criteria": list(self.success_criteria or []),
                "evidence_requirements": list(self.evidence_requirements or []),
                "rollback_notes": list(self.rollback_notes or []),
                "delegations": [item.as_dict() for item in list(self.delegations or [])],
            },
            ensure_ascii=True,
        )


@dataclass(frozen=True)
class BridgeCallResult:
    output: str
    attempts: int
    transient_failures: int
    provider: str
    meta: dict[str, Any]


def read_payload(log_prefix: str) -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"[{log_prefix}] invalid json payload: {error}", file=sys.stderr)
        return {}
    if isinstance(parsed, dict):
        return parsed
    print(f"[{log_prefix}] invalid payload type: expected object", file=sys.stderr)
    return {}


def build_context(payload: dict[str, Any], default_agent_id: str) -> BridgeContext:
    agent_id = str(payload.get("agent_id") or default_agent_id).strip() or default_agent_id
    request_id = str(payload.get("request_id") or f"req-{os.getpid()}").strip()
    protocol_version = str(payload.get("protocol_version") or BRIDGE_PROTOCOL_VERSION).strip() or BRIDGE_PROTOCOL_VERSION
    thread_id = str(payload.get("thread_id") or "thread").strip() or "thread"
    return BridgeContext(
        payload=payload,
        op=str(payload.get("op", "ask")).strip().lower(),
        agent_id=agent_id,
        request_id=request_id,
        protocol_version=protocol_version,
        thread_id=thread_id,
        objective=extract_objective(payload),
        response_mode=normalize_response_mode(payload.get("response_mode")),
        workspace=resolve_workspace(payload),
    )


def extract_objective(payload: dict[str, Any]) -> str:
    for key in ("prompt", "user_prompt", "objective", "content"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return re.sub(r"\s+", " ", value).strip()
    return DEFAULT_OBJECTIVE


def resolve_workspace(payload: dict[str, Any]) -> Path:
    for key in ("workspace", "project_dir", "cwd"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return Path(value).expanduser().resolve()
    return Path.cwd().resolve()


def is_dry_run() -> bool:
    return env_flag("TRICHAT_BRIDGE_DRY_RUN")


def normalize_response_mode(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text == "plain":
        return "plain"
    return "json"


def env_flag(name: str, default: bool = False) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        value = int(float(str(os.environ.get(name, default)).strip() or default))
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def env_float(name: str, default: float, minimum: float = 0.0, maximum: float | None = None) -> float:
    try:
        value = float(str(os.environ.get(name, default)).strip() or default)
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def emit_pong(context: BridgeContext, *, bridge: str, meta: Mapping[str, Any] | None = None) -> None:
    emit_envelope(
        kind=PONG_KIND,
        protocol_version=context.protocol_version,
        request_id=context.request_id,
        agent_id=context.agent_id,
        thread_id=context.thread_id,
        content="pong",
        bridge=bridge,
        meta=dict(meta or {}),
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )


def emit_response(
    context: BridgeContext,
    content: str,
    *,
    bridge: str,
    meta: Mapping[str, Any] | None = None,
) -> None:
    emit_envelope(
        kind=RESPONSE_KIND,
        protocol_version=context.protocol_version,
        request_id=context.request_id,
        agent_id=context.agent_id,
        thread_id=context.thread_id,
        content=content,
        bridge=bridge,
        meta=dict(meta or {}),
    )


def emit_envelope(
    *,
    kind: str,
    protocol_version: str,
    request_id: str,
    agent_id: str,
    thread_id: str,
    content: str,
    bridge: str,
    meta: Mapping[str, Any] | None = None,
    timestamp: str | None = None,
) -> None:
    envelope: dict[str, Any] = {
        "kind": kind,
        "protocol_version": protocol_version,
        "request_id": request_id,
        "agent_id": agent_id,
        "thread_id": thread_id,
        "bridge": bridge,
        "content": content,
    }
    if meta:
        envelope["meta"] = dict(meta)
    if timestamp:
        envelope["timestamp"] = timestamp
    sys.stdout.write(json.dumps(envelope, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def build_dry_run_proposal(agent_id: str, objective: str, workspace: Path) -> Proposal:
    return Proposal(
        strategy=f"{agent_id} dry-run bridge verified for {workspace.name or workspace}",
        commands=list(DEFAULT_COMMANDS),
        confidence=0.51,
        mentorship_note=f"{agent_id} dry-run protocol response for objective: {objective}",
        delegate_agent_id=None,
        task_objective=None,
        success_criteria=[],
        evidence_requirements=[],
        rollback_notes=[],
        delegations=[],
    )


def build_dry_run_content(context: BridgeContext) -> str:
    if context.response_mode == "plain":
        return f"{context.agent_id} dry-run bridge verified for {context.workspace.name or context.workspace}."
    return build_dry_run_proposal(context.agent_id, context.objective, context.workspace).to_json()


def normalize_proposal(
    raw: str,
    *,
    agent_id: str,
    objective: str,
    fallback_confidence: float,
    fallback_mentorship: str,
    fallback_strategy: str | None = None,
) -> Proposal:
    parsed = try_parse_json_object(raw)
    if isinstance(parsed, dict):
        nested_brief = parsed.get("delegation_brief")
        delegation = nested_brief if isinstance(nested_brief, dict) else {}
        parsed_delegations = normalize_delegation_briefs(
            parsed.get("delegations")
            or parsed.get("delegation_batch")
            or parsed.get("delegation_briefs")
            or parsed.get("task_batch")
            or parsed.get("work_items")
        )
        primary_delegation = normalize_delegation_brief(
            {
                "delegate_agent_id": normalize_text(parsed.get("delegate_agent_id"))
                or normalize_text(delegation.get("delegate_agent_id")),
                "task_objective": normalize_text(parsed.get("task_objective"))
                or normalize_text(delegation.get("task_objective")),
                "success_criteria": normalize_text_list(parsed.get("success_criteria"))
                or normalize_text_list(delegation.get("success_criteria")),
                "evidence_requirements": normalize_text_list(parsed.get("evidence_requirements"))
                or normalize_text_list(delegation.get("evidence_requirements")),
                "rollback_notes": normalize_text_list(parsed.get("rollback_notes"))
                or normalize_text_list(delegation.get("rollback_notes")),
            }
        )
        delegations = dedupe_delegation_briefs(
            ([primary_delegation] if primary_delegation else []) + parsed_delegations
        )
        selected_delegation = delegations[0] if delegations else primary_delegation
        strategy = normalize_text(parsed.get("strategy")) or normalize_text(parsed.get("summary"))
        strategy = strategy or fallback_strategy or f"{agent_id} recommends a staged reliability pass for: {objective}"
        commands = normalize_commands(parsed.get("commands"))
        confidence = normalize_confidence(parsed.get("confidence"), fallback=fallback_confidence)
        mentorship_note = normalize_text(parsed.get("mentorship_note")) or fallback_mentorship
        return Proposal(
            strategy=strategy,
            commands=commands,
            confidence=confidence,
            mentorship_note=mentorship_note,
            delegate_agent_id=selected_delegation.delegate_agent_id if selected_delegation else None,
            task_objective=selected_delegation.task_objective if selected_delegation else None,
            success_criteria=selected_delegation.success_criteria if selected_delegation else [],
            evidence_requirements=selected_delegation.evidence_requirements if selected_delegation else [],
            rollback_notes=selected_delegation.rollback_notes if selected_delegation else [],
            delegations=delegations,
        )

    strategy = normalize_text(raw) or fallback_strategy or f"{agent_id} recommends a staged reliability pass for: {objective}"
    return Proposal(
        strategy=strategy,
        commands=list(DEFAULT_COMMANDS),
        confidence=round(max(0.05, min(0.99, fallback_confidence)), 3),
        mentorship_note=fallback_mentorship,
        delegate_agent_id=None,
        task_objective=None,
        success_criteria=[],
        evidence_requirements=[],
        rollback_notes=[],
        delegations=[],
    )


def normalize_delegation_brief(value: Any) -> DelegationBrief | None:
    if not isinstance(value, dict):
        return None
    delegate_agent_id = normalize_text(value.get("delegate_agent_id")) or None
    task_objective = normalize_text(value.get("task_objective")) or None
    success_criteria = normalize_text_list(value.get("success_criteria"))
    evidence_requirements = normalize_text_list(value.get("evidence_requirements"))
    rollback_notes = normalize_text_list(value.get("rollback_notes"))
    if (
        delegate_agent_id is None
        and task_objective is None
        and not success_criteria
        and not evidence_requirements
        and not rollback_notes
    ):
        return None
    return DelegationBrief(
        delegate_agent_id=delegate_agent_id,
        task_objective=task_objective,
        success_criteria=success_criteria,
        evidence_requirements=evidence_requirements,
        rollback_notes=rollback_notes,
    )


def normalize_delegation_briefs(value: Any) -> list[DelegationBrief]:
    raw_items = value if isinstance(value, list) else [value] if isinstance(value, dict) else []
    return dedupe_delegation_briefs(
        [brief for brief in (normalize_delegation_brief(item) for item in raw_items) if brief is not None]
    )


def dedupe_delegation_briefs(items: list[DelegationBrief]) -> list[DelegationBrief]:
    seen: set[str] = set()
    output: list[DelegationBrief] = []
    for item in items:
        key = "::".join(
            [
                item.delegate_agent_id or "",
                item.task_objective or "",
                "|".join(item.success_criteria or []),
                "|".join(item.evidence_requirements or []),
                "|".join(item.rollback_notes or []),
            ]
        )
        if key in seen:
            continue
        seen.add(key)
        output.append(item)
    return output


def normalize_plain_response(
    raw: str,
    *,
    agent_id: str,
    objective: str,
    fallback_text: str | None = None,
) -> str:
    text = normalize_text(raw)
    if text:
        return text
    return fallback_text or f"{agent_id} is available but did not return a usable reply for: {objective}"


def resolve_cli_executable(preferred: str, default_name: str, fallback_paths: list[str] | tuple[str, ...] | None = None) -> str:
    candidate = str(preferred or "").strip()
    if candidate:
        return candidate
    resolved = shutil.which(default_name)
    if resolved:
        return resolved
    for entry in fallback_paths or ():
        path = Path(entry).expanduser()
        if path.exists():
            return str(path)
    return default_name


def normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def normalize_commands(value: Any) -> list[str]:
    commands: list[str] = []
    if isinstance(value, list):
        for item in value:
            text = normalize_text(item)
            if text:
                commands.append(text)
    deduped: list[str] = []
    seen: set[str] = set()
    for command in commands:
        key = command.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(command)
    return deduped or list(DEFAULT_COMMANDS)


def normalize_text_list(value: Any) -> list[str]:
    items: list[str] = []
    if isinstance(value, list):
        for item in value:
            text = normalize_text(item)
            if text:
                items.append(text)
    elif isinstance(value, str):
        text = normalize_text(value)
        if text:
            items.append(text)
    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def normalize_confidence(value: Any, *, fallback: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = fallback
    numeric = max(0.05, min(0.99, numeric))
    return round(numeric, 3)


def try_parse_json_object(raw: str) -> dict[str, Any] | None:
    text = normalize_text(raw)
    if not text:
        return None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    for match in re.finditer(r"\{[\s\S]*\}", text):
        snippet = match.group(0)
        try:
            parsed = json.loads(snippet)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def compact(value: str, limit: int = 400) -> str:
    text = normalize_text(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def is_transient_failure(text: str) -> bool:
    normalized = normalize_text(text).lower()
    if not normalized:
        return False
    if any(marker in normalized for marker in PERMANENT_FAILURE_MARKERS):
        return False
    return any(marker in normalized for marker in TRANSIENT_FAILURE_MARKERS)


def sleep_for_retry(deadline: float, attempt_index: int, log_prefix: str) -> None:
    base_ms = env_int("TRICHAT_BRIDGE_RETRY_BASE_MS", 350, minimum=50, maximum=5000)
    multiplier = min(4, max(1, attempt_index))
    delay = (base_ms * multiplier) / 1000.0
    remaining = deadline - time.monotonic()
    if remaining <= 0.15:
        return
    sleep_seconds = min(delay, max(0.0, remaining - 0.1))
    if sleep_seconds <= 0:
        return
    print(f"[{log_prefix}] retrying after {sleep_seconds:.2f}s backoff", file=sys.stderr)
    time.sleep(sleep_seconds)


def build_attempt_meta(*, attempts: int, transient_failures: int, provider: str, mode: str, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "provider": provider,
        "mode": mode,
        "attempts": attempts,
        "transient_failures": transient_failures,
    }
    if extra:
        payload.update(dict(extra))
    return payload


def run_cli_command(
    *,
    command: list[str],
    workspace: Path,
    log_prefix: str,
    provider: str,
    stdout_extractor: Callable[[str], str] | None = None,
    strict_extractor: bool = False,
) -> BridgeCallResult:
    timeout_seconds = env_float("TRICHAT_BRIDGE_TIMEOUT_SECONDS", 90.0, minimum=10.0, maximum=600.0)
    max_retries = env_int("TRICHAT_BRIDGE_MAX_RETRIES", 1, minimum=0, maximum=4)
    deadline = time.monotonic() + timeout_seconds
    attempts = 0
    transient_failures = 0
    last_error = "provider execution failed"

    while attempts <= max_retries:
        attempts += 1
        remaining = max(1.0, deadline - time.monotonic())
        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=remaining,
                cwd=str(workspace),
                check=False,
            )
        except FileNotFoundError as error:
            raise RuntimeError(f"command not found: {command[0]} ({error})") from error
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout if isinstance(error.stdout, str) else (error.stdout or b"").decode("utf-8", errors="replace")
            stderr = error.stderr if isinstance(error.stderr, str) else (error.stderr or b"").decode("utf-8", errors="replace")
            last_error = compact(stderr or stdout or f"command timed out after {remaining:.1f}s")
            if attempts <= max_retries:
                transient_failures += 1
                print(f"[{log_prefix}] timeout on attempt {attempts}: {last_error}", file=sys.stderr)
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(last_error) from error
        except Exception as error:  # noqa: BLE001
            last_error = compact(str(error) or error.__class__.__name__)
            if attempts <= max_retries and is_transient_failure(last_error):
                transient_failures += 1
                print(f"[{log_prefix}] transient cli error on attempt {attempts}: {last_error}", file=sys.stderr)
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(last_error) from error

        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        if stderr.strip():
            print(f"[{log_prefix}] stderr: {compact(stderr)}", file=sys.stderr)

        if proc.returncode != 0:
            last_error = compact(stderr or stdout or f"exit={proc.returncode}")
            if attempts <= max_retries and is_transient_failure(last_error):
                transient_failures += 1
                print(
                    f"[{log_prefix}] transient non-zero exit on attempt {attempts} (exit={proc.returncode}): {last_error}",
                    file=sys.stderr,
                )
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(f"provider command failed (exit={proc.returncode}): {last_error}")

        candidate = stdout_extractor(stdout) if stdout_extractor else stdout.strip()
        if not candidate.strip() and stdout_extractor and not strict_extractor:
            candidate = stdout.strip()
        if candidate.strip():
            return BridgeCallResult(
                output=candidate.strip(),
                attempts=attempts,
                transient_failures=transient_failures,
                provider=provider,
                meta=build_attempt_meta(
                    attempts=attempts,
                    transient_failures=transient_failures,
                    provider=provider,
                    mode="cli",
                ),
            )

        last_error = compact(stderr or stdout or "provider returned empty output")
        if attempts <= max_retries and is_transient_failure(last_error):
            transient_failures += 1
            print(f"[{log_prefix}] empty transient output on attempt {attempts}: {last_error}", file=sys.stderr)
            sleep_for_retry(deadline, attempts, log_prefix)
            continue
        raise RuntimeError(last_error or "provider returned empty output")

    raise RuntimeError(last_error)


def post_json_request(
    *,
    url: str,
    body: Mapping[str, Any],
    headers: Mapping[str, str] | None,
    timeout_seconds: float,
    log_prefix: str,
    provider: str,
    response_extractor: Callable[[str], str],
    mode: str,
) -> BridgeCallResult:
    max_retries = env_int("TRICHAT_BRIDGE_MAX_RETRIES", 1, minimum=0, maximum=4)
    deadline = time.monotonic() + timeout_seconds
    attempts = 0
    transient_failures = 0
    payload_bytes = json.dumps(body, ensure_ascii=True).encode("utf-8")
    request_headers = {"Content-Type": "application/json", **dict(headers or {})}
    last_error = "request failed"

    while attempts <= max_retries:
        attempts += 1
        remaining = max(1.0, deadline - time.monotonic())
        request = urllib.request.Request(
            url=url,
            data=payload_bytes,
            headers=request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=remaining) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            last_error = compact(detail or f"HTTP {error.code}")
            should_retry = error.code in {408, 409, 429, 500, 502, 503, 504}
            if attempts <= max_retries and should_retry:
                transient_failures += 1
                retry_after = parse_retry_after_seconds(error.headers)
                print(f"[{log_prefix}] transient http {error.code} on attempt {attempts}: {last_error}", file=sys.stderr)
                if retry_after > 0:
                    sleep_seconds = min(retry_after, max(0.0, deadline - time.monotonic() - 0.1))
                    if sleep_seconds > 0:
                        time.sleep(sleep_seconds)
                else:
                    sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(f"HTTP {error.code}: {last_error}") from error
        except urllib.error.URLError as error:
            last_error = compact(str(error.reason) or str(error))
            if attempts <= max_retries and is_transient_failure(last_error):
                transient_failures += 1
                print(f"[{log_prefix}] transient url error on attempt {attempts}: {last_error}", file=sys.stderr)
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(last_error) from error
        except socket.timeout as error:
            last_error = compact(str(error) or "request timed out")
            if attempts <= max_retries:
                transient_failures += 1
                print(f"[{log_prefix}] socket timeout on attempt {attempts}: {last_error}", file=sys.stderr)
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(last_error) from error
        except TimeoutError as error:
            last_error = compact(str(error) or "request timed out")
            if attempts <= max_retries:
                transient_failures += 1
                print(f"[{log_prefix}] timeout on attempt {attempts}: {last_error}", file=sys.stderr)
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(last_error) from error
        except Exception as error:  # noqa: BLE001
            last_error = compact(str(error) or error.__class__.__name__)
            if attempts <= max_retries and is_transient_failure(last_error):
                transient_failures += 1
                print(f"[{log_prefix}] transient request error on attempt {attempts}: {last_error}", file=sys.stderr)
                sleep_for_retry(deadline, attempts, log_prefix)
                continue
            raise RuntimeError(last_error) from error

        extracted = response_extractor(raw)
        if extracted.strip():
            return BridgeCallResult(
                output=extracted.strip(),
                attempts=attempts,
                transient_failures=transient_failures,
                provider=provider,
                meta=build_attempt_meta(
                    attempts=attempts,
                    transient_failures=transient_failures,
                    provider=provider,
                    mode=mode,
                ),
            )

        last_error = compact(raw or "provider returned empty output")
        if attempts <= max_retries and is_transient_failure(last_error):
            transient_failures += 1
            print(f"[{log_prefix}] empty transient response on attempt {attempts}: {last_error}", file=sys.stderr)
            sleep_for_retry(deadline, attempts, log_prefix)
            continue
        raise RuntimeError(last_error or "provider returned empty output")

    raise RuntimeError(last_error)


def parse_retry_after_seconds(headers: Mapping[str, Any] | None) -> float:
    if not headers:
        return 0.0
    raw = str(headers.get("Retry-After") or headers.get("retry-after") or "").strip()
    if not raw:
        return 0.0
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 0.0
