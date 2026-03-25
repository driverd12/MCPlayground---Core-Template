from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
import urllib.error
import warnings
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_common import post_json_request, run_cli_command  # noqa: E402

warnings.simplefilter("ignore", ResourceWarning)


class _MockHTTPResponse:
    def __init__(self, body: str) -> None:
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


class _MockHTTPError(urllib.error.HTTPError):
    def __init__(self, url: str, code: int, message: str, headers: dict[str, str], body: str) -> None:
        super().__init__(url, code, message, headers, fp=None)
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        return self._body


class RunCliCommandTests(unittest.TestCase):
    def test_retries_transient_non_zero_then_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = Path(tmp_dir) / "state.txt"
            script_path = Path(tmp_dir) / "mock_cli.py"
            script_path.write_text(
                textwrap.dedent(
                    f"""
                    #!/usr/bin/env python3
                    import pathlib
                    import sys

                    state = pathlib.Path({str(state_path)!r})
                    attempt = int(state.read_text() or "0") if state.exists() else 0
                    attempt += 1
                    state.write_text(str(attempt))
                    if attempt == 1:
                        sys.stderr.write("429 rate limit, try again later\\n")
                        raise SystemExit(9)
                    sys.stdout.write("final answer\\n")
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            script_path.chmod(0o755)
            with mock.patch.dict(
                os.environ,
                {
                    "TRICHAT_BRIDGE_TIMEOUT_SECONDS": "20",
                    "TRICHAT_BRIDGE_MAX_RETRIES": "1",
                    "TRICHAT_BRIDGE_RETRY_BASE_MS": "1",
                },
                clear=False,
            ):
                with mock.patch("bridge_common.time.sleep", return_value=None):
                    result = run_cli_command(
                        command=[sys.executable, str(script_path)],
                        workspace=Path(tmp_dir),
                        log_prefix="test-bridge",
                        provider="mock-cli",
                    )
            self.assertEqual(result.output, "final answer")
            self.assertEqual(result.attempts, 2)
            self.assertEqual(result.transient_failures, 1)

    def test_non_zero_exit_with_stdout_is_not_treated_as_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            script_path = Path(tmp_dir) / "mock_cli.py"
            script_path.write_text(
                textwrap.dedent(
                    """
                    #!/usr/bin/env python3
                    import sys

                    sys.stdout.write("partial output that should be ignored\\n")
                    sys.stderr.write("unauthorized access\\n")
                    raise SystemExit(7)
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            script_path.chmod(0o755)
            with mock.patch.dict(
                os.environ,
                {
                    "TRICHAT_BRIDGE_TIMEOUT_SECONDS": "20",
                    "TRICHAT_BRIDGE_MAX_RETRIES": "0",
                },
                clear=False,
            ):
                with self.assertRaises(RuntimeError) as raised:
                    run_cli_command(
                        command=[sys.executable, str(script_path)],
                        workspace=Path(tmp_dir),
                        log_prefix="test-bridge",
                        provider="mock-cli",
                    )
            self.assertIn("provider command failed", str(raised.exception))
            self.assertNotIn("partial output", str(raised.exception))


class PostJsonRequestTests(unittest.TestCase):
    def test_retries_transient_http_error_then_succeeds(self) -> None:
        attempts = {"count": 0}

        def fake_urlopen(request, timeout=0):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise _MockHTTPError(
                    request.full_url,
                    429,
                    "rate limit",
                    {"Retry-After": "0"},
                    '{"error":"rate limit"}',
                )
            return _MockHTTPResponse('{"response":"ok"}')

        with mock.patch.dict(
            os.environ,
            {
                "TRICHAT_BRIDGE_MAX_RETRIES": "1",
                "TRICHAT_BRIDGE_RETRY_BASE_MS": "1",
            },
            clear=False,
        ):
            with mock.patch("bridge_common.time.sleep", return_value=None):
                with mock.patch("bridge_common.urllib.request.urlopen", side_effect=fake_urlopen):
                    result = post_json_request(
                        url="https://example.test/api",
                        body={"hello": "world"},
                        headers=None,
                        timeout_seconds=20,
                        log_prefix="test-http",
                        provider="mock-http",
                        response_extractor=lambda raw: json.loads(raw)["response"],
                        mode="api",
                    )
        self.assertEqual(result.output, "ok")
        self.assertEqual(result.attempts, 2)
        self.assertEqual(result.transient_failures, 1)

    def test_does_not_retry_permanent_http_error(self) -> None:
        def fake_urlopen(request, timeout=0):
            raise _MockHTTPError(
                request.full_url,
                401,
                "unauthorized",
                {},
                '{"error":"unauthorized"}',
            )

        with mock.patch.dict(os.environ, {"TRICHAT_BRIDGE_MAX_RETRIES": "3"}, clear=False):
            with mock.patch("bridge_common.urllib.request.urlopen", side_effect=fake_urlopen):
                with self.assertRaises(RuntimeError) as raised:
                    post_json_request(
                        url="https://example.test/api",
                        body={"hello": "world"},
                        headers=None,
                        timeout_seconds=20,
                        log_prefix="test-http",
                        provider="mock-http",
                        response_extractor=lambda raw: raw,
                        mode="api",
                    )
        self.assertIn("HTTP 401", str(raised.exception))


class WrapperDryRunTests(unittest.TestCase):
    def test_wrappers_emit_valid_dry_run_envelopes(self) -> None:
        wrapper_dir = Path(__file__).resolve().parent
        workspace = wrapper_dir.parent
        payload = {
            "op": "ask",
            "protocol_version": "trichat-bridge-v1",
            "request_id": "test-request",
            "thread_id": "test-thread",
            "prompt": "Verify the dry-run protocol.",
            "workspace": str(workspace),
        }
        wrapper_names = [
            "codex_bridge.py",
            "cursor_bridge.py",
            "gemini_bridge.py",
            "claude_bridge.py",
            "local_imprint_bridge.py",
        ]
        for name in wrapper_names:
            with self.subTest(wrapper=name):
                proc = subprocess.run(
                    [sys.executable, str(wrapper_dir / name)],
                    input=json.dumps(payload),
                    capture_output=True,
                    text=True,
                    env={**os.environ, "TRICHAT_BRIDGE_DRY_RUN": "1"},
                    cwd=str(workspace),
                    check=False,
                )
                self.assertEqual(proc.returncode, 0, msg=proc.stderr)
                envelope = json.loads(proc.stdout)
                self.assertEqual(envelope["kind"], "trichat.adapter.response")
                self.assertEqual(envelope["protocol_version"], "trichat-bridge-v1")
                self.assertEqual(envelope["request_id"], "test-request")
                self.assertTrue(str(envelope.get("bridge") or "").strip())
                content = json.loads(envelope["content"])
                self.assertIn("strategy", content)
                self.assertIn("commands", content)
                self.assertIn("confidence", content)
                self.assertIn("mentorship_note", content)

    def test_wrappers_emit_plain_dry_run_when_requested(self) -> None:
        wrapper_dir = Path(__file__).resolve().parent
        workspace = wrapper_dir.parent
        payload = {
            "op": "ask",
            "protocol_version": "trichat-bridge-v1",
            "request_id": "test-request",
            "thread_id": "test-thread",
            "prompt": "Say hello plainly.",
            "workspace": str(workspace),
            "response_mode": "plain",
        }
        wrapper_names = [
            "codex_bridge.py",
            "cursor_bridge.py",
            "gemini_bridge.py",
            "claude_bridge.py",
            "local_imprint_bridge.py",
        ]
        for name in wrapper_names:
            with self.subTest(wrapper=name):
                proc = subprocess.run(
                    [sys.executable, str(wrapper_dir / name)],
                    input=json.dumps(payload),
                    capture_output=True,
                    text=True,
                    env={**os.environ, "TRICHAT_BRIDGE_DRY_RUN": "1"},
                    cwd=str(workspace),
                    check=False,
                )
                self.assertEqual(proc.returncode, 0, msg=proc.stderr)
                envelope = json.loads(proc.stdout)
                self.assertEqual(envelope["kind"], "trichat.adapter.response")
                self.assertEqual(envelope["protocol_version"], "trichat-bridge-v1")
                self.assertEqual(envelope["request_id"], "test-request")
                self.assertTrue(str(envelope.get("bridge") or "").strip())
                content = str(envelope["content"])
                self.assertTrue(content.strip())
                self.assertFalse(content.lstrip().startswith("{"), msg=content)


if __name__ == "__main__":
    unittest.main()
