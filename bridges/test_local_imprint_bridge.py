from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_common import build_context  # noqa: E402
from local_imprint_bridge import build_local_prompt  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
