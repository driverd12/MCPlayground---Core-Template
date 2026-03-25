#!/usr/bin/env python3
"""TriChat adapter bridge for Gemini CLI or direct API access."""

from __future__ import annotations

import json
import os
import shlex
import sys

from bridge_common import (
    BridgeContext,
    build_context,
    build_dry_run_content,
    compact,
    emit_pong,
    emit_response,
    env_float,
    is_dry_run,
    normalize_plain_response,
    normalize_proposal,
    post_json_request,
    read_payload,
    run_cli_command,
)

LOG_PREFIX = "gemini_bridge"
BRIDGE_NAME = "gemini-bridge"


def main() -> int:
    payload = read_payload(LOG_PREFIX)
    context = build_context(payload, "gemini")

    if context.op == "ping":
        emit_pong(context, bridge=BRIDGE_NAME, meta={"provider": "gemini"})
        return 0

    if is_dry_run():
        emit_response(context, build_dry_run_content(context), bridge=BRIDGE_NAME, meta={"provider": "gemini", "mode": "dry-run"})
        return 0

    try:
        result = run_gemini(context)
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


def run_gemini(context: BridgeContext):
    mode = str(os.environ.get("TRICHAT_GEMINI_MODE") or "auto").strip().lower()
    api_key = resolve_gemini_api_key()
    cli_error: RuntimeError | None = None

    if mode == "api":
        return run_gemini_api(context, api_key=api_key)
    if mode == "cli":
        return run_gemini_cli(context)

    try:
        return run_gemini_cli(context)
    except RuntimeError as error:
        cli_error = error
        print(f"[{LOG_PREFIX}] cli path failed, considering API fallback: {compact(str(error))}", file=sys.stderr)

    if api_key:
        try:
            return run_gemini_api(context, api_key=api_key)
        except RuntimeError as api_error:
            if cli_error is not None:
                raise RuntimeError(f"cli failed: {cli_error}; api failed: {api_error}") from api_error
            raise

    if cli_error is not None:
        raise cli_error
    raise RuntimeError("gemini provider not configured")


def resolve_gemini_api_key() -> str:
    return str(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()


def run_gemini_cli(context: BridgeContext):
    executable = str(os.environ.get("TRICHAT_GEMINI_EXECUTABLE") or "gemini").strip() or "gemini"
    args = shlex.split(str(os.environ.get("TRICHAT_GEMINI_ARGS") or "-p"))
    workspace_flag = str(os.environ.get("TRICHAT_GEMINI_WORKSPACE_FLAG") or "").strip()
    cmd = [executable, *args]
    if workspace_flag:
        cmd.extend([workspace_flag, str(context.workspace)])
    cmd.append(build_prompt(context))
    return run_cli_command(
        command=cmd,
        workspace=context.workspace,
        log_prefix=LOG_PREFIX,
        provider="gemini-cli",
    )


def run_gemini_api(context: BridgeContext, *, api_key: str):
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY is not set")
    model = str(os.environ.get("TRICHAT_GEMINI_MODEL") or "gemini-2.0-flash").strip() or "gemini-2.0-flash"
    timeout_seconds = env_float("TRICHAT_BRIDGE_TIMEOUT_SECONDS", 90.0, minimum=10.0, maximum=600.0)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_prompt(context)}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
        },
    }
    result = post_json_request(
        url=url,
        body=body,
        headers=None,
        timeout_seconds=timeout_seconds,
        log_prefix=LOG_PREFIX,
        provider=f"gemini-api:{model}",
        response_extractor=parse_gemini_api_response,
        mode="api",
    )
    return result


def build_prompt(context: BridgeContext) -> str:
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


def parse_gemini_api_response(raw: str) -> str:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()

    if isinstance(parsed, dict):
        for candidate in parsed.get("candidates", []):
            if not isinstance(candidate, dict):
                continue
            content = candidate.get("content")
            if not isinstance(content, dict):
                continue
            parts = content.get("parts")
            if not isinstance(parts, list):
                continue
            text_chunks = [str(part.get("text") or "").strip() for part in parts if isinstance(part, dict)]
            text = "\n".join(chunk for chunk in text_chunks if chunk)
            if text.strip():
                return text.strip()
    return raw.strip()


if __name__ == "__main__":
    raise SystemExit(main())
