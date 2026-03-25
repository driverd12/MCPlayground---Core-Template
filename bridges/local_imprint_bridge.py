#!/usr/bin/env python3
"""TriChat adapter bridge for local Ollama-backed imprint agent."""

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
    env_float,
    is_dry_run,
    normalize_plain_response,
    normalize_proposal,
    post_json_request,
    read_payload,
)

LOG_PREFIX = "local_imprint_bridge"
BRIDGE_NAME = "local-imprint-bridge"


def main() -> int:
    payload = read_payload(LOG_PREFIX)
    context = build_context(payload, "local-imprint")

    if context.op == "ping":
        emit_pong(context, bridge=BRIDGE_NAME, meta={"provider": "ollama"})
        return 0

    if is_dry_run():
        emit_response(context, build_dry_run_content(context), bridge=BRIDGE_NAME, meta={"provider": "ollama", "mode": "dry-run"})
        return 0

    try:
        result = run_ollama(context)
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
            fallback_confidence=0.68,
            fallback_mentorship=f"{context.agent_id} mentorship: keep proposals compact, safe, and replay-friendly.",
        ).to_json()
    emit_response(context, content, bridge=BRIDGE_NAME, meta=result.meta)
    return 0


def run_ollama(context: BridgeContext):
    model = str(os.environ.get("TRICHAT_IMPRINT_MODEL") or "llama3.2:3b").strip() or "llama3.2:3b"
    base_url = str(os.environ.get("TRICHAT_OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
    timeout_seconds = env_float("TRICHAT_BRIDGE_TIMEOUT_SECONDS", 90.0, minimum=10.0, maximum=600.0)
    body = {
        "model": model,
        "prompt": build_local_prompt(context),
        "stream": False,
        "options": {
            "temperature": 0.2,
        },
    }
    return post_json_request(
        url=f"{base_url}/api/generate",
        body=body,
        headers=None,
        timeout_seconds=timeout_seconds,
        log_prefix=LOG_PREFIX,
        provider=f"ollama:{model}",
        response_extractor=parse_ollama_response,
        mode="http",
    )


def build_local_prompt(context: BridgeContext) -> str:
    if context.response_mode == "plain":
        return (
            f"You are {context.agent_id}, the local reliability mentor for workspace: {context.workspace}.\n"
            "Reply directly to the user in plain text.\n"
            "- Do not return JSON.\n"
            "- Keep the answer concise and user-facing.\n"
            f"User message: {context.objective}\n"
        )
    return (
        f"You are {context.agent_id}, the local reliability mentor for workspace: {context.workspace}.\n"
        "Return JSON only, no markdown.\n"
        'Schema: {"strategy": string, "commands": string[], "confidence": number, "mentorship_note": string}\n'
        "Requirements:\n"
        "- commands must be read-only and safe; prefer npm run build, npm test, git status.\n"
        "- confidence in [0.05, 0.99].\n"
        "- keep strategy concise and concrete.\n"
        f"Objective: {context.objective}\n"
    )


def parse_ollama_response(raw: str) -> str:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()
    if isinstance(parsed, dict):
        text = parsed.get("response")
        if isinstance(text, str):
            return text.strip()
    return raw.strip()


if __name__ == "__main__":
    raise SystemExit(main())
