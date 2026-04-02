#!/usr/bin/env python3
import json
import os
import pty
import re
import select
import shlex
import signal
import sys
import time


PROMPT_RE = re.compile(r"(Password:|\[sudo\])", re.IGNORECASE)


def sanitize_output(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace")
    text = text.replace("\r", "")
    text = text.replace("[sudo]", "")
    text = text.replace("Password:", "")
    return text.strip()


def valid_env_key(key: str) -> bool:
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key))


def build_shell_command(payload: dict) -> str:
    command = str(payload.get("command") or "").strip()
    if not command:
        raise ValueError("command is required")
    args = [str(entry) for entry in (payload.get("args") or [])]
    cwd = str(payload.get("cwd") or "").strip()
    env = payload.get("env") or {}
    quoted_cmd = " ".join([shlex.quote(command), *[shlex.quote(arg) for arg in args]])
    segments = []
    if cwd:
        segments.append(f"cd {shlex.quote(cwd)}")
    if isinstance(env, dict) and env:
        env_parts = [f"{key}={shlex.quote(str(value))}" for key, value in env.items() if valid_env_key(str(key))]
        if env_parts:
            segments.append(f"exec env {' '.join(env_parts)} {quoted_cmd}")
        else:
            segments.append(f"exec {quoted_cmd}")
    else:
        segments.append(f"exec {quoted_cmd}")
    return " && ".join(segments)


def dry_run(payload: dict) -> int:
    result = {
        "ok": True,
        "code": 0,
        "timed_out": False,
        "output": f"dry-run privileged exec via {payload.get('account', 'mcagent')} -> root: {payload.get('command')} {' '.join(payload.get('args') or [])}".strip(),
        "duration_ms": 0,
        "account": payload.get("account", "mcagent"),
        "target_user": payload.get("target_user", "root"),
    }
    sys.stdout.write(json.dumps(result))
    return 0


def main() -> int:
    payload = json.load(sys.stdin)
    if os.getenv("MCP_PRIVILEGED_EXEC_DRY_RUN") == "1":
        return dry_run(payload)

    account = str(payload.get("account") or "").strip()
    password = str(payload.get("password") or "")
    timeout_seconds = float(payload.get("timeout_seconds") or 120.0)
    if not account:
        raise ValueError("account is required")
    if not password:
        raise ValueError("password is required")

    shell_command = build_shell_command(payload)
    escalated = f"sudo -S -k -p '[sudo]' /bin/sh -lc {shlex.quote(shell_command)}"
    started = time.time()
    pid, fd = pty.fork()
    if pid == 0:
        os.execv("/usr/bin/su", ["su", "-l", account, "-c", escalated])
        return 127

    sent_count = 0
    output = bytearray()
    prompt_buffer = ""
    exit_code = None
    timed_out = False
    try:
        while True:
            now = time.time()
            remaining = max(0.0, timeout_seconds - (now - started))
            if remaining <= 0.0:
                timed_out = True
                os.kill(pid, signal.SIGTERM)
                break
            ready, _, _ = select.select([fd], [], [], min(0.25, remaining))
            if ready:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)
                    prompt_buffer = (prompt_buffer + chunk.decode("utf-8", errors="replace"))[-256:]
                    if PROMPT_RE.search(prompt_buffer) and sent_count < 2:
                        os.write(fd, (password + "\n").encode("utf-8"))
                        sent_count += 1
                        prompt_buffer = ""
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid == pid:
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = 128 + os.WTERMSIG(status)
                else:
                    exit_code = 1
                break
        if timed_out:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.waitpid(pid, 0)
            except OSError:
                pass
            exit_code = 124
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

    result = {
        "ok": exit_code == 0 and not timed_out,
        "code": exit_code,
        "timed_out": timed_out,
        "output": sanitize_output(bytes(output)),
        "duration_ms": int((time.time() - started) * 1000),
        "account": account,
        "target_user": str(payload.get("target_user") or "root"),
    }
    sys.stdout.write(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        sys.stderr.write(f"{exc}\n")
        raise
