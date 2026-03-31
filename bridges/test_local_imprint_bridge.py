from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_common import build_context  # noqa: E402
from local_imprint_bridge import (  # noqa: E402
    build_local_prompt,
    build_ollama_body,
    parse_mlx_response,
)


class LocalImprintBridgePromptTests(unittest.TestCase):
    def test_includes_agent_learning_notes_and_guardrail(self) -> None:
        context = build_context(
            {
                "agent_id": "ring-leader",
                "op": "ask",
                "thread_id": "thread",
                "prompt": "Inspect the next bounded delivery opportunity.",
                "response_mode": "json",
                "workspace": str(Path.cwd()),
                "agent_learning_notes": [
                    "Prefer bounded director-to-leaf delegation with explicit proof bars.",
                    "Avoid vague plans that restate the objective without evidence.",
                ],
                "learning_guardrail": (
                    "Use learned patterns only when they materially improve the current external task. "
                    "Never create self-improvement-only work from memory."
                ),
            },
            default_agent_id="ring-leader",
        )

        prompt = build_local_prompt(context)

        self.assertIn("Recent learned patterns:", prompt)
        self.assertIn("Prefer bounded director-to-leaf delegation with explicit proof bars.", prompt)
        self.assertIn("Avoid vague plans that restate the objective without evidence.", prompt)
        self.assertIn("Never create self-improvement-only work from memory.", prompt)

    def test_parse_mlx_response_extracts_chat_completion_content(self) -> None:
        raw = (
            '{"choices":[{"message":{"role":"assistant","content":"bounded result"}}],'
            '"model":"mlx-community/example"}'
        )

        parsed = parse_mlx_response(raw)

        self.assertEqual(parsed, "bounded result")

    def test_build_ollama_body_enforces_structured_output_for_json_mode(self) -> None:
        context = build_context(
            {
                "agent_id": "implementation-director",
                "op": "ask",
                "thread_id": "thread",
                "prompt": "Delegate a bounded implementation task to code-smith.",
                "response_mode": "json",
                "workspace": str(Path.cwd()),
            },
            default_agent_id="local-imprint",
        )

        body = build_ollama_body(context, "llama3.2:3b")

        self.assertEqual(body["model"], "llama3.2:3b")
        self.assertEqual(body["stream"], False)
        self.assertEqual(body["keep_alive"], "10m")
        self.assertIn("format", body)
        self.assertEqual(body["format"]["type"], "object")
        self.assertIn("delegations", body["format"]["properties"])
        self.assertIn('"delegate_agent_id"', str(body["prompt"]))

    def test_build_ollama_body_keeps_plain_mode_unstructured(self) -> None:
        context = build_context(
            {
                "agent_id": "ring-leader",
                "op": "ask",
                "thread_id": "thread",
                "prompt": "Give a concise plain-text status update.",
                "response_mode": "plain",
                "workspace": str(Path.cwd()),
            },
            default_agent_id="local-imprint",
        )

        body = build_ollama_body(context, "llama3.2:3b")

        self.assertNotIn("format", body)


if __name__ == "__main__":
    unittest.main()
