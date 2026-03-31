#!/usr/bin/env python3
"""TriChat adapter bridge for local inference-backed imprint agent."""

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
DEFAULT_MODEL = "llama3.2:3b"
DEFAULT_MLX_MODEL = "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit"

DEFAULT_AGENT_PROFILE = {
    "role": "local specialist",
    "plain_focus": "Reply directly, keep the answer concise, and ground it in the current workspace.",
    "proposal_focus": "Prefer safe read-only next steps, concrete evidence gathering, and replay-friendly guidance with a clear owner and stop condition.",
    "command_hint": "git status, npm run build, npm test",
    "reports_to": "ring-leader",
    "managed_agents": [],
    "fallback_confidence": 0.68,
    "fallback_strategy": "recommend a compact local reliability pass",
    "fallback_mentorship": "keep proposals compact, safe, replay-friendly, and specific enough to verify.",
}

DIRECTOR_AGENT_PROFILE = {
    "role": "local director",
    "plain_focus": "Reply directly, keep it concise, and convert broad goals into bounded assignments for managed leaf agents.",
    "proposal_focus": "Prefer delegating to the right leaf SME, define clear ownership, and summarize the supervising rationale plus evidence contract for the ring leader.",
    "command_hint": "git status, npm run trichat:roster, npm run ring-leader:status",
    "reports_to": "ring-leader",
    "fallback_confidence": 0.74,
    "fallback_strategy": "delegate the next bounded task to the most appropriate leaf agent",
    "fallback_mentorship": "supervise leaf work, preserve bounded scope, and report concise evidence plus rollback awareness back up the chain.",
}

AGENT_PROFILES = {
    "ring-leader": {
        "role": "local mission operator",
        "plain_focus": "Reply directly, keep it concise, and emphasize delegation, sequencing, and blockers.",
        "proposal_focus": "Choose the next bounded action, favor specialist delegation, and make rollback-safe progress visible with explicit success and evidence bars.",
        "command_hint": "git status, npm run ring-leader:status, npm run trichat:roster, npm run build",
        "managed_agents": [
            "implementation-director",
            "research-director",
            "verification-director",
            "local-imprint",
            "codex",
        ],
        "fallback_confidence": 0.72,
        "fallback_strategy": "propose one bounded orchestration move",
        "fallback_mentorship": "delegate deliberately, surface blockers early, never fake certainty, and keep the loop moving with bounded next steps.",
    },
    "code-smith": {
        "role": "local implementation specialist",
        "plain_focus": "Reply directly, keep it concise, and focus on code changes, commands, and minimal diffs.",
        "proposal_focus": "Prefer implementation details, integration steps, the smallest deterministic change that advances the goal, and proof that the change can be verified.",
        "command_hint": "git status, npm run build, npm test",
        "reports_to": "implementation-director",
        "fallback_confidence": 0.71,
        "fallback_strategy": "suggest the smallest implementation-focused next step",
        "fallback_mentorship": "favor deterministic edits, compact diffs, verification-ready implementation steps, and clear changed-file evidence.",
    },
    "research-scout": {
        "role": "local analysis specialist",
        "plain_focus": "Reply directly, keep it concise, and prioritize options, assumptions, and missing context.",
        "proposal_focus": "Compare alternatives, surface unknowns, and compress findings into decision-ready guidance with explicit evidence gaps and recommendation criteria.",
        "command_hint": "git status, rg -n \"TODO|FIXME|NOTE\" ., npm run trichat:roster",
        "reports_to": "research-director",
        "fallback_confidence": 0.7,
        "fallback_strategy": "summarize the best bounded research next step",
        "fallback_mentorship": "highlight assumptions, evidence gaps, decision criteria, and concrete options before recommending a path.",
    },
    "quality-guard": {
        "role": "local verification specialist",
        "plain_focus": "Reply directly, keep it concise, and focus on regressions, failure modes, and validation steps.",
        "proposal_focus": "Look for weak evidence, risky assumptions, and missing tests before suggesting a release path, and name the fastest check that would change confidence.",
        "command_hint": "git status, npm run build, npm test, npm run ring-leader:status",
        "reports_to": "verification-director",
        "fallback_confidence": 0.72,
        "fallback_strategy": "recommend the highest-signal verification pass",
        "fallback_mentorship": "prefer concrete failure modes, release blockers, the quickest proof that behavior is safe, and explicit rollback triggers.",
    },
    "local-imprint": {
        "role": "local reliability mentor",
        "plain_focus": "Reply directly, keep it concise, and favor deterministic, local-first operations.",
        "proposal_focus": "Prefer idempotent steps, continuity-safe actions, and recovery-aware guidance with explicit proof points.",
        "command_hint": "git status, npm run ring-leader:status, npm run trichat:roster, npm run build",
        "reports_to": "ring-leader",
        "fallback_confidence": 0.68,
        "fallback_strategy": "recommend a staged local reliability pass",
        "fallback_mentorship": "favor deterministic local-first execution, replay-safe reliability improvements, and explicit proof before claiming recovery.",
    },
    "implementation-director": {
        "role": "local implementation director",
        "plain_focus": "Reply directly, keep it concise, and decide when code-smith should take the next bounded implementation slice.",
        "proposal_focus": "Favor delegated implementation tasks, minimal diffs, evidence-rich handoffs back to ring-leader, and explicit stop conditions when scope grows.",
        "command_hint": "git status, npm run build, npm test",
        "managed_agents": ["code-smith"],
        "delegation_target": "code-smith",
    },
    "research-director": {
        "role": "local research director",
        "plain_focus": "Reply directly, keep it concise, and decide when research-scout should investigate the next unknown.",
        "proposal_focus": "Favor delegated research tasks, option framing, and decision-ready evidence back to ring-leader with explicit assumptions and missing proof.",
        "command_hint": "git status, npm run trichat:roster, rg -n \"TODO|FIXME|NOTE\" .",
        "managed_agents": ["research-scout"],
        "delegation_target": "research-scout",
    },
    "verification-director": {
        "role": "local verification director",
        "plain_focus": "Reply directly, keep it concise, and decide when quality-guard should run the next validation pass.",
        "proposal_focus": "Favor delegated verification tasks, explicit failure modes, release-readiness evidence back to ring-leader, and a named confidence-lifting check.",
        "command_hint": "git status, npm run build, npm test, npm run ring-leader:status",
        "managed_agents": ["quality-guard"],
        "delegation_target": "quality-guard",
    },
}


def main() -> int:
    payload = read_payload(LOG_PREFIX)
    context = build_context(payload, "local-imprint")
    provider = resolve_local_provider()

    if context.op == "ping":
        emit_pong(context, bridge=BRIDGE_NAME, meta={"provider": provider})
        return 0

    if is_dry_run():
        emit_response(context, build_dry_run_content(context), bridge=BRIDGE_NAME, meta={"provider": provider, "mode": "dry-run"})
        return 0

    try:
        result = run_inference(context, provider)
    except RuntimeError as error:
        print(f"[{LOG_PREFIX}] {compact(str(error), limit=600)}", file=sys.stderr)
        return 2

    if context.response_mode == "plain":
        content = normalize_plain_response(result.output, agent_id=context.agent_id, objective=context.objective)
    else:
        profile = get_agent_profile(context.agent_id)
        content = normalize_proposal(
            result.output,
            agent_id=context.agent_id,
            objective=context.objective,
            fallback_confidence=float(profile["fallback_confidence"]),
            fallback_mentorship=f"{context.agent_id} mentorship: {profile['fallback_mentorship']}",
            fallback_strategy=f"{context.agent_id} should {profile['fallback_strategy']} for: {context.objective}",
        ).to_json()
    emit_response(context, content, bridge=BRIDGE_NAME, meta=result.meta)
    return 0


def resolve_local_provider() -> str:
    requested = str(os.environ.get("TRICHAT_LOCAL_INFERENCE_PROVIDER") or "auto").strip().lower()
    if requested in {"ollama", "mlx"}:
        return requested
    if requested not in {"", "auto"}:
        return "ollama"
    if mlx_endpoint_healthy():
        return "mlx"
    return "ollama"


def mlx_endpoint_healthy() -> bool:
    endpoint = str(os.environ.get("TRICHAT_MLX_ENDPOINT") or "").strip().rstrip("/")
    if not endpoint:
        return False
    try:
        post_json_request  # keep import use explicit
        from urllib.request import Request, urlopen
        request = Request(f"{endpoint}/health", method="GET")
        with urlopen(request, timeout=3.0) as response:  # noqa: S310 - local trusted endpoint
            return int(getattr(response, "status", 0) or 0) == 200
    except Exception:
        return False


def run_inference(context: BridgeContext, provider: str):
    if provider == "mlx":
        try:
            return run_mlx(context)
        except RuntimeError:
            if str(os.environ.get("TRICHAT_LOCAL_INFERENCE_PROVIDER") or "").strip().lower() == "mlx":
                raise
    return run_ollama(context)


def run_ollama(context: BridgeContext):
    model = resolve_model(context.agent_id)
    base_url = str(os.environ.get("TRICHAT_OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
    timeout_seconds = env_float("TRICHAT_BRIDGE_TIMEOUT_SECONDS", 90.0, minimum=10.0, maximum=600.0)
    return post_json_request(
        url=f"{base_url}/api/generate",
        body=build_ollama_body(context, model),
        headers=None,
        timeout_seconds=timeout_seconds,
        log_prefix=LOG_PREFIX,
        provider=f"ollama:{model}",
        response_extractor=parse_ollama_response,
        mode="http",
    )


def proposal_response_schema() -> dict[str, object]:
    delegation_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "delegate_agent_id": {"type": ["string", "null"]},
            "task_objective": {"type": ["string", "null"]},
            "success_criteria": {"type": "array", "items": {"type": "string"}},
            "evidence_requirements": {"type": "array", "items": {"type": "string"}},
            "rollback_notes": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "delegate_agent_id",
            "task_objective",
            "success_criteria",
            "evidence_requirements",
            "rollback_notes",
        ],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "strategy": {"type": "string"},
            "commands": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"},
            "mentorship_note": {"type": "string"},
            "delegate_agent_id": {"type": ["string", "null"]},
            "task_objective": {"type": ["string", "null"]},
            "success_criteria": {"type": "array", "items": {"type": "string"}},
            "evidence_requirements": {"type": "array", "items": {"type": "string"}},
            "rollback_notes": {"type": "array", "items": {"type": "string"}},
            "delegations": {"type": "array", "items": delegation_schema},
        },
        "required": [
            "strategy",
            "commands",
            "confidence",
            "mentorship_note",
            "delegate_agent_id",
            "task_objective",
            "success_criteria",
            "evidence_requirements",
            "rollback_notes",
            "delegations",
        ],
    }


def build_ollama_body(context: BridgeContext, model: str) -> dict[str, object]:
    keep_alive = str(os.environ.get("TRICHAT_OLLAMA_KEEP_ALIVE") or "10m").strip() or "10m"
    body: dict[str, object] = {
        "model": model,
        "prompt": build_local_prompt(context),
        "stream": False,
        "keep_alive": keep_alive,
        "options": {
            "temperature": 0.2,
        },
    }
    if context.response_mode != "plain":
        body["format"] = proposal_response_schema()
    return body


def run_mlx(context: BridgeContext):
    model = resolve_mlx_model(context.agent_id)
    base_url = str(os.environ.get("TRICHAT_MLX_ENDPOINT") or "http://127.0.0.1:8788").rstrip("/")
    timeout_seconds = env_float("TRICHAT_BRIDGE_TIMEOUT_SECONDS", 90.0, minimum=10.0, maximum=600.0)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a local workspace specialist. Follow the prompt exactly and stay concise."},
            {"role": "user", "content": build_local_prompt(context)},
        ],
        "stream": False,
        "temperature": 0.2,
        "max_tokens": 600,
    }
    return post_json_request(
        url=f"{base_url}/v1/chat/completions",
        body=body,
        headers=None,
        timeout_seconds=timeout_seconds,
        log_prefix=LOG_PREFIX,
        provider=f"mlx:{model}",
        response_extractor=parse_mlx_response,
        mode="http",
    )


def get_agent_profile(agent_id: str) -> dict[str, object]:
    normalized = str(agent_id or "").strip().lower()
    merged = dict(DEFAULT_AGENT_PROFILE)
    if normalized.endswith("-director"):
        merged.update(DIRECTOR_AGENT_PROFILE)
    profile = AGENT_PROFILES.get(normalized)
    if profile:
        merged.update(profile)
    return merged


def resolve_model(agent_id: str) -> str:
    normalized = str(agent_id or "").strip().upper().replace("-", "_")
    env_keys: list[str] = []
    if normalized:
        env_keys.append(f"TRICHAT_{normalized}_MODEL")
    if normalized == "LOCAL_IMPRINT":
        env_keys.append("TRICHAT_IMPRINT_MODEL")
    env_keys.extend(["TRICHAT_SPECIALIST_MODEL", "TRICHAT_IMPRINT_MODEL"])
    seen: set[str] = set()
    for key in env_keys:
        if key in seen:
            continue
        seen.add(key)
        model = str(os.environ.get(key) or "").strip()
        if model:
            return model
    return DEFAULT_MODEL


def resolve_mlx_model(agent_id: str) -> str:
    normalized = str(agent_id or "").strip().upper().replace("-", "_")
    env_keys: list[str] = []
    if normalized:
        env_keys.append(f"TRICHAT_{normalized}_MLX_MODEL")
    env_keys.extend(["TRICHAT_MLX_MODEL", "TRICHAT_SPECIALIST_MLX_MODEL"])
    seen: set[str] = set()
    for key in env_keys:
        if key in seen:
            continue
        seen.add(key)
        model = str(os.environ.get(key) or "").strip()
        if model:
            return model
    return DEFAULT_MLX_MODEL


def build_local_prompt(context: BridgeContext) -> str:
    profile = get_agent_profile(context.agent_id)
    role = str(profile["role"])
    plain_focus = str(profile["plain_focus"])
    proposal_focus = str(profile["proposal_focus"])
    command_hint = str(profile["command_hint"])
    reports_to = str(profile.get("reports_to") or "").strip()
    delegation_target = str(profile.get("delegation_target") or "").strip()
    managed_agents = [
        str(entry).strip()
        for entry in list(profile.get("managed_agents") or [])
        if str(entry).strip()
    ]
    learning_notes = [
        compact(str(entry), 220)
        for entry in list(context.payload.get("agent_learning_notes") or [])
        if compact(str(entry), 220)
    ][:4]
    learning_guardrail = compact(str(context.payload.get("learning_guardrail") or ""), 220)
    confidence_checks = [
        "owner clarity",
        "actionability",
        "evidence bar",
        "rollback readiness",
        "non-echo novelty",
    ]
    method_lines = [
        "- Program the org, not the loop: route work to the right agent or tool instead of inventing self-improvement-only tasks.",
        "- Use small-budget progress loops: prefer the smallest compare/build/verify pass that can change confidence quickly.",
        f"- Before confidence above 0.72, silently pass these checks: {', '.join(confidence_checks)}.",
    ]
    if context.response_mode == "plain":
        plain_lines = [
            f"You are {context.agent_id}, the {role} for workspace: {context.workspace}.",
            "Reply directly to the user in plain text.",
            "- Do not return JSON.",
            "- Keep the answer concise and user-facing.",
            f"- {plain_focus}",
        ]
        if reports_to:
            plain_lines.append(f"- Report ownership and progress back through {reports_to}.")
        plain_lines.extend(method_lines[:2])
        plain_lines.append(f"User message: {context.objective}")
        return "\n".join(plain_lines) + "\n"
    hierarchy_lines: list[str] = []
    if reports_to:
        hierarchy_lines.append(f"- Report upward to {reports_to}.")
    if managed_agents:
        hierarchy_lines.append(f"- You manage: {', '.join(managed_agents)}.")
        hierarchy_lines.append(
            "- Operate in GSD mode: break work into the smallest safe, non-overlapping assignments that can finish cleanly."
        )
        hierarchy_lines.append(
            "- Prefer director-to-leaf delegation chains unless skipping a layer clearly reduces latency without increasing risk."
        )
        hierarchy_lines.append(
            "- When more than one bounded handoff is warranted, emit delegations with one managed agent per item."
        )
        hierarchy_lines.append(
            "- Mirror the highest-priority delegation into delegate_agent_id, task_objective, success_criteria, evidence_requirements, and rollback_notes for backward compatibility."
        )
    else:
        hierarchy_lines.append(
            "- Stay focused on execution. Leave delegate_agent_id and delegations empty unless a narrowly scoped handoff is clearly better than keeping the work local."
        )
        hierarchy_lines.append(
            "- If scope expands or evidence is thin, ask your manager to re-slice the work instead of improvising broad orchestration."
        )
    if delegation_target:
        hierarchy_lines.append(f"- Preferred delegate_agent_id when appropriate: {delegation_target}.")
    proposal_lines = [
        f"You are {context.agent_id}, the {role} for workspace: {context.workspace}.",
        "Return JSON only, no markdown.",
        'Schema: {"strategy": string, "commands": string[], "confidence": number, "mentorship_note": string, "delegate_agent_id": string|null, "task_objective": string|null, "success_criteria": string[], "evidence_requirements": string[], "rollback_notes": string[], "delegations": [{"delegate_agent_id": string|null, "task_objective": string|null, "success_criteria": string[], "evidence_requirements": string[], "rollback_notes": string[]}]}',
        "Requirements:",
        f"- {proposal_focus}",
        f"- commands must be read-only and safe; prefer {command_hint}.",
        "- confidence in [0.05, 0.99].",
        "- keep strategy concise and concrete.",
        "- Use GSD-style instruction writing: crisp owner, bounded task, explicit evidence, explicit stop condition.",
        "- Never claim completion or high confidence without named evidence.",
        "- If your strategy mostly repeats the objective without a clear owner, evidence, or rollback note, lower confidence below 0.55.",
        *method_lines,
        *hierarchy_lines,
        *(
            ["Recent learned patterns:"] + [f"- {note}" for note in learning_notes]
            if learning_notes
            else []
        ),
        *([f"- {learning_guardrail}"] if learning_guardrail else []),
        f"Objective: {context.objective}",
    ]
    return "\n".join(proposal_lines) + "\n"


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


def parse_mlx_response(raw: str) -> str:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()
    if isinstance(parsed, dict):
        choices = parsed.get("choices")
        if isinstance(choices, list) and choices:
            message = choices[0].get("message") if isinstance(choices[0], dict) else None
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content.strip()
    return raw.strip()


if __name__ == "__main__":
    raise SystemExit(main())
