#!/usr/bin/env python3
"""TriChat adapter bridge for Codex CLI."""

from __future__ import annotations

import json
import os
import sys

from bridge_common import (
    BridgeContext,
    build_context,
    build_dry_run_content,
    compact,
    emit_pong,
    emit_response,
    is_dry_run,
    normalize_plain_response,
    normalize_proposal,
    read_payload,
    resolve_cli_executable,
    run_cli_command,
)

LOG_PREFIX = "codex_bridge"
BRIDGE_NAME = "codex-bridge"


def main() -> int:
    payload = read_payload(LOG_PREFIX)
    context = build_context(payload, "codex")

    if context.op == "ping":
        emit_pong(context, bridge=BRIDGE_NAME, meta={"provider": "codex-cli"})
        return 0

    if is_dry_run():
        emit_response(context, build_dry_run_content(context), bridge=BRIDGE_NAME, meta={"provider": "codex-cli", "mode": "dry-run"})
        return 0

    try:
        result = run_codex(context)
    except RuntimeError as error:
        print(f"[{LOG_PREFIX}] {compact(str(error), limit=600)}", file=sys.stderr)
        return 2

    if context.response_mode == "plain":
        content = normalize_plain_response(result.output, agent_id=context.agent_id, objective=context.objective)
    else:
        content = normalize_proposal(
            result.output,
            agent_id=context.agent_id,
            objective=context.objective,
            fallback_confidence=0.72,
            fallback_mentorship=f"{context.agent_id} mentorship: keep proposals compact, safe, and replay-friendly.",
        ).to_json()
    emit_response(context, content, bridge=BRIDGE_NAME, meta=result.meta)
    return 0


def run_codex(context: BridgeContext):
    executable = resolve_cli_executable(
        str(os.environ.get("TRICHAT_CODEX_EXECUTABLE") or ""),
        "codex",
        fallback_paths=("/Applications/Codex.app/Contents/Resources/codex",),
    )
    cmd = [
        executable,
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--cd",
        str(context.workspace),
        build_codex_prompt(context),
    ]
    return run_cli_command(
        command=cmd,
        workspace=context.workspace,
        log_prefix=LOG_PREFIX,
        provider="codex-cli",
        stdout_extractor=extract_codex_agent_text,
        strict_extractor=True,
    )


def build_codex_prompt(context: BridgeContext) -> str:
    if context.response_mode == "plain":
        return (
            f"You are {context.agent_id} in a multi-agent council.\n"
            "Reply directly to the user in plain text.\n"
            "- Do not return JSON.\n"
            "- Keep the answer concise and user-facing.\n"
            f"User message: {context.objective}\n"
        )
    return (
        f"You are {context.agent_id} in a multi-agent council.\n"
        "Return JSON only, no markdown.\n"
        'Schema: {"strategy": string, "commands": string[], "confidence": number, "mentorship_note": string}\n'
        "Requirements:\n"
        "- commands must be read-only and safe; prefer npm run build, npm test, git status.\n"
        "- confidence in [0.05, 0.99].\n"
        "- keep strategy concise and concrete.\n"
        f"Objective: {context.objective}\n"
    )


def extract_codex_agent_text(stdout: str) -> str:
    message_text = ""
    for line in stdout.splitlines():
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            event = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") != "item.completed":
            continue
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        if item.get("type") != "agent_message":
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            message_text = text.strip()
    return message_text


if __name__ == "__main__":
    raise SystemExit(main())
