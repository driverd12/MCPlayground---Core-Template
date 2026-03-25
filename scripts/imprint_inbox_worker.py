#!/usr/bin/env python3
"""
MCPlayground Imprint Inbox Worker

Drains durable tasks from SQLite with lease-based claims and heartbeats.
Legacy file tasks dropped into data/imprint/inbox/pending are imported into
the durable task queue automatically.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_POLL_INTERVAL = 5
DEFAULT_BATCH_SIZE = 3
DEFAULT_LEASE_SECONDS = 300
DEFAULT_HEARTBEAT_INTERVAL = 30
MAX_TEXT_PREVIEW = 8000


class InboxWorker:
    def __init__(
        self,
        repo_root: Path,
        poll_interval: int,
        batch_size: int,
        lease_seconds: int,
        heartbeat_interval: int,
        once: bool,
        worker_id: str,
    ) -> None:
        self.repo_root = repo_root.resolve()
        self.poll_interval = max(1, poll_interval)
        self.batch_size = max(1, batch_size)
        self.lease_seconds = max(15, lease_seconds)
        self.heartbeat_interval = max(5, heartbeat_interval)
        self.once = once
        self.worker_id = worker_id

        self.inbox_root = self.repo_root / "data" / "imprint" / "inbox"
        self.pending_dir = self.inbox_root / "pending"
        self.processing_dir = self.inbox_root / "processing"
        self.done_dir = self.inbox_root / "done"
        self.failed_dir = self.inbox_root / "failed"

        self.agent_loop_path = self.repo_root / "agent_loop.py"
        self.db_path = resolve_db_path(self.repo_root)

    def run(self) -> int:
        if not self.agent_loop_path.exists():
            self._log(f"error: agent loop not found: {self.agent_loop_path}")
            return 2

        self._ensure_dirs()
        self._ensure_task_schema()
        self._recover_processing_orphans()

        self._log(
            f"started worker_id={self.worker_id} repo_root={self.repo_root} "
            f"db_path={self.db_path} poll_interval={self.poll_interval}s "
            f"batch_size={self.batch_size} lease_seconds={self.lease_seconds}s "
            f"heartbeat_interval={self.heartbeat_interval}s once={self.once}"
        )

        while True:
            processed = self._process_batch()
            if self.once:
                return 0
            if processed == 0:
                time.sleep(self.poll_interval)

    def _ensure_dirs(self) -> None:
        for directory in [self.inbox_root, self.pending_dir, self.processing_dir, self.done_dir, self.failed_dir]:
            directory.mkdir(parents=True, exist_ok=True)

    def _open_db(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    def _ensure_task_schema(self) -> None:
        with self._open_db() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                  task_id TEXT PRIMARY KEY,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  status TEXT NOT NULL,
                  priority INTEGER NOT NULL DEFAULT 0,
                  objective TEXT NOT NULL,
                  project_dir TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  source TEXT,
                  source_client TEXT,
                  source_model TEXT,
                  source_agent TEXT,
                  tags_json TEXT NOT NULL,
                  metadata_json TEXT NOT NULL,
                  max_attempts INTEGER NOT NULL DEFAULT 3,
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  available_at TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT,
                  last_worker_id TEXT,
                  last_error TEXT,
                  result_json TEXT
                );
                CREATE TABLE IF NOT EXISTS task_events (
                  id TEXT PRIMARY KEY,
                  task_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  event_type TEXT NOT NULL,
                  from_status TEXT,
                  to_status TEXT,
                  worker_id TEXT,
                  summary TEXT,
                  details_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS task_leases (
                  task_id TEXT PRIMARY KEY,
                  owner_id TEXT NOT NULL,
                  lease_expires_at TEXT NOT NULL,
                  heartbeat_at TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS task_artifacts (
                  id TEXT PRIMARY KEY,
                  task_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  path TEXT,
                  content_json TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_tasks_status_available
                  ON tasks (status, available_at, priority DESC, created_at ASC);
                CREATE INDEX IF NOT EXISTS idx_task_events_task
                  ON task_events (task_id, created_at ASC);
                CREATE INDEX IF NOT EXISTS idx_task_leases_expiry
                  ON task_leases (lease_expires_at ASC);
                """
            )

    def _recover_processing_orphans(self) -> None:
        orphan_count = 0
        for task_path in sorted(self.processing_dir.glob("*.json")):
            recovered_name = f"recovered-{int(time.time())}-{task_path.name}"
            recovered_path = self.pending_dir / recovered_name
            try:
                task_path.rename(recovered_path)
                orphan_count += 1
            except FileNotFoundError:
                continue
            except OSError as error:
                self._log(f"warn: failed to recover orphan task {task_path}: {error}")
        if orphan_count > 0:
            self._log(f"recovered {orphan_count} orphan task(s) from processing/")

    def _process_batch(self) -> int:
        processed = 0
        for _ in range(self.batch_size):
            claim = self._claim_next_task()
            if claim is None:
                imported = self._import_legacy_pending(limit=1)
                if imported > 0:
                    claim = self._claim_next_task()
            if claim is None:
                break
            self._execute_claimed_task(claim)
            processed += 1
        return processed

    def _normalize_string_list(self, value: Any) -> List[str]:
        if not isinstance(value, list):
            return []
        seen: set[str] = set()
        normalized: List[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            trimmed = item.strip()
            if not trimmed:
                continue
            lowered = trimmed.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            normalized.append(trimmed)
        return normalized

    def _resolve_task_routing(self, task: Dict[str, Any]) -> Dict[str, List[str]]:
        merged = {
            "preferred_agent_ids": [],
            "allowed_agent_ids": [],
            "preferred_client_kinds": [],
            "allowed_client_kinds": [],
            "required_capabilities": [],
            "preferred_capabilities": [],
        }
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
        candidates = [
            metadata.get("task_routing"),
            metadata.get("routing"),
            payload.get("task_routing"),
            payload.get("routing"),
        ]
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            for key in merged.keys():
                merged[key] = self._normalize_string_list(merged[key] + self._normalize_string_list(candidate.get(key)))
        return merged

    def _task_is_claimable_by_worker(self, task: Dict[str, Any]) -> bool:
        routing = self._resolve_task_routing(task)
        normalized_worker_id = self.worker_id.strip().lower()

        allowed_agent_ids = {value.lower() for value in routing["allowed_agent_ids"]}
        if allowed_agent_ids and normalized_worker_id not in allowed_agent_ids:
            return False

        if routing["allowed_client_kinds"]:
            return False

        if routing["required_capabilities"]:
            return False

        return True

    def _claim_next_task(self) -> Optional[Dict[str, Any]]:
        now = utc_now_iso()
        lease_expires_at = iso_after_seconds(self.lease_seconds)
        with self._open_db() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                candidate_rows = conn.execute(
                    """
                    SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                           t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                           t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                           t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                           l.owner_id AS lease_owner_id, l.lease_expires_at, l.heartbeat_at
                    FROM tasks t
                    LEFT JOIN task_leases l ON l.task_id = t.task_id
                    WHERE t.status = 'pending'
                      AND t.available_at <= ?
                      AND (l.task_id IS NULL OR l.lease_expires_at <= ?)
                    ORDER BY t.priority DESC, t.created_at ASC
                    LIMIT 50
                    """,
                    (now, now),
                ).fetchall()

                candidate_task: Optional[Dict[str, Any]] = None
                for row in candidate_rows:
                    task = self._row_to_task(row)
                    if self._task_is_claimable_by_worker(task):
                        candidate_task = task
                        break

                if candidate_task is None:
                    conn.execute("COMMIT")
                    return None

                task_id = str(candidate_task["task_id"])
                updated = conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'running',
                        updated_at = ?,
                        attempt_count = attempt_count + 1,
                        started_at = ?,
                        finished_at = NULL,
                        last_worker_id = ?
                    WHERE task_id = ?
                      AND status = 'pending'
                      AND available_at <= ?
                    """,
                    (now, now, self.worker_id, task_id, now),
                )
                if updated.rowcount <= 0:
                    conn.execute("ROLLBACK")
                    return None

                conn.execute(
                    """
                    INSERT INTO task_leases (task_id, owner_id, lease_expires_at, heartbeat_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(task_id) DO UPDATE SET
                      owner_id = excluded.owner_id,
                      lease_expires_at = excluded.lease_expires_at,
                      heartbeat_at = excluded.heartbeat_at,
                      updated_at = excluded.updated_at
                    """,
                    (task_id, self.worker_id, lease_expires_at, now, now, now),
                )
                self._insert_task_event(
                    conn=conn,
                    task_id=task_id,
                    event_type="claimed",
                    from_status="pending",
                    to_status="running",
                    worker_id=self.worker_id,
                    summary="Task claimed for execution.",
                    details={
                        "lease_seconds": self.lease_seconds,
                        "lease_expires_at": lease_expires_at,
                    },
                )
                row = self._select_task_row(conn, task_id)
                conn.execute("COMMIT")
                if row is None:
                    return None
                return self._row_to_task(row)
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def _heartbeat_task(self, task_id: str) -> bool:
        now = utc_now_iso()
        lease_expires_at = iso_after_seconds(self.lease_seconds)
        with self._open_db() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                lease = conn.execute(
                    "SELECT owner_id FROM task_leases WHERE task_id = ?",
                    (task_id,),
                ).fetchone()
                if lease is None:
                    conn.execute("ROLLBACK")
                    return False
                owner_id = str(lease["owner_id"])
                if owner_id != self.worker_id:
                    conn.execute("ROLLBACK")
                    return False

                conn.execute(
                    """
                    UPDATE task_leases
                    SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
                    WHERE task_id = ?
                    """,
                    (lease_expires_at, now, now, task_id),
                )
                conn.execute(
                    "UPDATE tasks SET updated_at = ? WHERE task_id = ?",
                    (now, task_id),
                )
                conn.execute("COMMIT")
                return True
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def _complete_task(self, task_id: str, result: Dict[str, Any]) -> Tuple[bool, str]:
        now = utc_now_iso()
        with self._open_db() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                lease = conn.execute(
                    "SELECT owner_id FROM task_leases WHERE task_id = ?",
                    (task_id,),
                ).fetchone()
                if lease is None:
                    conn.execute("ROLLBACK")
                    return False, "lease-not-found"
                if str(lease["owner_id"]) != self.worker_id:
                    conn.execute("ROLLBACK")
                    return False, "owner-mismatch"

                updated = conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'completed',
                        updated_at = ?,
                        finished_at = ?,
                        last_worker_id = ?,
                        last_error = NULL,
                        result_json = ?
                    WHERE task_id = ?
                      AND status = 'running'
                    """,
                    (now, now, self.worker_id, stable_json(result), task_id),
                )
                if updated.rowcount <= 0:
                    conn.execute("ROLLBACK")
                    return False, "not-running"

                conn.execute("DELETE FROM task_leases WHERE task_id = ?", (task_id,))
                self._insert_task_event(
                    conn=conn,
                    task_id=task_id,
                    event_type="completed",
                    from_status="running",
                    to_status="completed",
                    worker_id=self.worker_id,
                    summary="Task completed successfully.",
                    details={"result_keys": sorted(list(result.keys()))},
                )
                conn.execute("COMMIT")
                return True, "completed"
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def _fail_task(self, task_id: str, error_text: str, result: Dict[str, Any]) -> Tuple[bool, str]:
        now = utc_now_iso()
        with self._open_db() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                lease = conn.execute(
                    "SELECT owner_id FROM task_leases WHERE task_id = ?",
                    (task_id,),
                ).fetchone()
                if lease is None:
                    conn.execute("ROLLBACK")
                    return False, "lease-not-found"
                if str(lease["owner_id"]) != self.worker_id:
                    conn.execute("ROLLBACK")
                    return False, "owner-mismatch"

                updated = conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'failed',
                        updated_at = ?,
                        finished_at = ?,
                        last_worker_id = ?,
                        last_error = ?,
                        result_json = ?
                    WHERE task_id = ?
                      AND status = 'running'
                    """,
                    (now, now, self.worker_id, error_text, stable_json(result), task_id),
                )
                if updated.rowcount <= 0:
                    conn.execute("ROLLBACK")
                    return False, "not-running"

                conn.execute("DELETE FROM task_leases WHERE task_id = ?", (task_id,))
                self._insert_task_event(
                    conn=conn,
                    task_id=task_id,
                    event_type="failed",
                    from_status="running",
                    to_status="failed",
                    worker_id=self.worker_id,
                    summary="Task failed during execution.",
                    details={
                        "error": error_text,
                        "result_keys": sorted(list(result.keys())),
                    },
                )
                conn.execute("COMMIT")
                return True, "failed"
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def _insert_task_event(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        event_type: str,
        from_status: Optional[str],
        to_status: Optional[str],
        worker_id: Optional[str],
        summary: str,
        details: Dict[str, Any],
    ) -> None:
        conn.execute(
            """
            INSERT INTO task_events (
              id, task_id, created_at, event_type, from_status, to_status, worker_id, summary, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                make_uuid(),
                task_id,
                utc_now_iso(),
                event_type,
                from_status,
                to_status,
                worker_id,
                summary,
                stable_json(details),
            ),
        )

    def _select_task_row(self, conn: sqlite3.Connection, task_id: str) -> Optional[sqlite3.Row]:
        return conn.execute(
            """
            SELECT t.task_id, t.created_at, t.updated_at, t.status, t.priority, t.objective, t.project_dir,
                   t.payload_json, t.source, t.source_client, t.source_model, t.source_agent,
                   t.tags_json, t.metadata_json, t.max_attempts, t.attempt_count, t.available_at,
                   t.started_at, t.finished_at, t.last_worker_id, t.last_error, t.result_json,
                   l.owner_id AS lease_owner_id, l.lease_expires_at, l.heartbeat_at
            FROM tasks t
            LEFT JOIN task_leases l ON l.task_id = t.task_id
            WHERE t.task_id = ?
            """,
            (task_id,),
        ).fetchone()

    def _row_to_task(self, row: sqlite3.Row) -> Dict[str, Any]:
        payload = safe_parse_json_object(row["payload_json"])
        metadata = safe_parse_json_object(row["metadata_json"])
        tags = safe_parse_json_array(row["tags_json"])
        result = safe_parse_json_object_nullable(row["result_json"])
        lease = None
        if row["lease_owner_id"] is not None:
            lease = {
                "owner_id": str(row["lease_owner_id"]),
                "lease_expires_at": str(row["lease_expires_at"] or ""),
                "heartbeat_at": str(row["heartbeat_at"] or ""),
            }
        return {
            "task_id": str(row["task_id"]),
            "created_at": str(row["created_at"] or ""),
            "updated_at": str(row["updated_at"] or ""),
            "status": str(row["status"] or "pending"),
            "priority": int(row["priority"] or 0),
            "objective": str(row["objective"] or ""),
            "project_dir": str(row["project_dir"] or ""),
            "payload": payload,
            "source": as_nullable_str(row["source"]),
            "source_client": as_nullable_str(row["source_client"]),
            "source_model": as_nullable_str(row["source_model"]),
            "source_agent": as_nullable_str(row["source_agent"]),
            "tags": tags,
            "metadata": metadata,
            "max_attempts": int(row["max_attempts"] or 3),
            "attempt_count": int(row["attempt_count"] or 0),
            "available_at": str(row["available_at"] or ""),
            "started_at": as_nullable_str(row["started_at"]),
            "finished_at": as_nullable_str(row["finished_at"]),
            "last_worker_id": as_nullable_str(row["last_worker_id"]),
            "last_error": as_nullable_str(row["last_error"]),
            "result": result,
            "lease": lease,
        }

    def _import_legacy_pending(self, limit: int) -> int:
        imported = 0
        for task_path in self._list_pending_files()[: max(1, limit)]:
            claimed = self._claim_legacy_file(task_path)
            if claimed is None:
                continue

            task_id_hint = claimed.stem
            started_at = utc_now_iso()
            try:
                raw_task = self._read_json_file(claimed)
                normalized = self._normalize_task(task_id_hint, raw_task)
                created, status = self._upsert_legacy_task(normalized, raw_task)
                result = {
                    "task_id": normalized["task_id"],
                    "status": "queued",
                    "created": created,
                    "existing_status": status if not created else None,
                    "started_at": started_at,
                    "finished_at": utc_now_iso(),
                    "source_file": str(claimed),
                }
                self._archive_legacy_import(claimed, normalized["task_id"], result, success=True)
                imported += 1
            except Exception as error:  # noqa: BLE001
                result = {
                    "task_id": task_id_hint,
                    "status": "failed",
                    "started_at": started_at,
                    "finished_at": utc_now_iso(),
                    "error": f"{type(error).__name__}: {error}",
                    "source_file": str(claimed),
                }
                self._archive_legacy_import(claimed, task_id_hint, result, success=False)
                imported += 1
        return imported

    def _list_pending_files(self) -> List[Path]:
        tasks = [path for path in self.pending_dir.glob("*.json") if path.is_file()]
        tasks.sort(key=lambda path: (path.stat().st_mtime, path.name))
        return tasks

    def _claim_legacy_file(self, pending_path: Path) -> Optional[Path]:
        claimed_path = self.processing_dir / pending_path.name
        try:
            pending_path.rename(claimed_path)
            return claimed_path
        except FileNotFoundError:
            return None
        except OSError as error:
            self._log(f"warn: failed to claim legacy file {pending_path}: {error}")
            return None

    def _read_json_file(self, file_path: Path) -> Dict[str, Any]:
        try:
            raw = file_path.read_text(encoding="utf-8")
        except OSError as error:
            raise ValueError(f"failed to read task file {file_path}: {error}") from error
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid task JSON in {file_path}: {error}") from error
        if not isinstance(parsed, dict):
            raise ValueError(f"task payload in {file_path} must be a JSON object")
        return parsed

    def _upsert_legacy_task(self, task: Dict[str, Any], raw: Dict[str, Any]) -> Tuple[bool, str]:
        now = utc_now_iso()
        task_id = task["task_id"]
        with self._open_db() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute(
                    "SELECT status FROM tasks WHERE task_id = ?",
                    (task_id,),
                ).fetchone()
                if existing is not None:
                    status = str(existing["status"] or "unknown")
                    conn.execute("COMMIT")
                    return False, status

                payload = build_task_payload_for_storage(task, raw)
                conn.execute(
                    """
                    INSERT INTO tasks (
                      task_id, created_at, updated_at, status, priority, objective, project_dir,
                      payload_json, source, source_client, source_model, source_agent,
                      tags_json, metadata_json, max_attempts, attempt_count, available_at,
                      started_at, finished_at, last_worker_id, last_error, result_json
                    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL)
                    """,
                    (
                        task_id,
                        now,
                        now,
                        int(task.get("priority", 0)),
                        task["objective"],
                        task["project_dir"],
                        stable_json(payload),
                        task.get("source"),
                        task.get("source_client"),
                        task.get("source_model"),
                        task.get("source_agent"),
                        stable_json(task.get("tags", [])),
                        stable_json(task.get("metadata", {})),
                        int(task.get("max_attempts", 3)),
                        now,
                    ),
                )
                self._insert_task_event(
                    conn=conn,
                    task_id=task_id,
                    event_type="created",
                    from_status=None,
                    to_status="pending",
                    worker_id=None,
                    summary="Legacy inbox file imported into durable queue.",
                    details={"legacy_source": str(raw.get("source") or "unknown")},
                )
                conn.execute("COMMIT")
                return True, "pending"
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def _archive_legacy_import(self, processing_path: Path, task_id: str, result: Dict[str, Any], success: bool) -> None:
        target_dir = self.done_dir if success else self.failed_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        safe_task_id = sanitize_task_id(task_id)
        archived_task_path = unique_path(target_dir, f"{safe_task_id}.legacy.task.json")
        result_path = unique_path(target_dir, f"{safe_task_id}.legacy.result.json")
        write_json_atomic(result_path, result)
        processing_path.rename(archived_task_path)

    def _execute_claimed_task(self, claimed_task: Dict[str, Any]) -> None:
        task_id = claimed_task["task_id"]
        started_at = utc_now_iso()
        task_config = self._effective_task_config(claimed_task)
        command = self._build_agent_command(task_config)
        timeout_seconds = max(300, task_config["command_timeout"] * task_config["max_steps"] + 120)

        stop_event = threading.Event()
        heartbeat_thread = threading.Thread(
            target=self._lease_heartbeat_loop,
            args=(task_id, stop_event),
            daemon=True,
        )
        heartbeat_thread.start()

        try:
            proc = subprocess.run(
                command,
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except Exception as error:  # noqa: BLE001
            stop_event.set()
            heartbeat_thread.join(timeout=2)
            result = {
                "task_id": task_id,
                "status": "failed",
                "worker_id": self.worker_id,
                "started_at": started_at,
                "finished_at": utc_now_iso(),
                "duration_ms": elapsed_ms(started_at),
                "task": task_config,
                "command": command,
                "error": f"{type(error).__name__}: {error}",
            }
            self._fail_task(task_id, result["error"], result)
            self._archive_execution(claimed_task, result, success=False)
            self._log(f"task={task_id} status=failed error={result['error']}")
            return

        stop_event.set()
        heartbeat_thread.join(timeout=2)

        stdout_text = (proc.stdout or "").strip()
        stderr_text = (proc.stderr or "").strip()
        stdout_json: Optional[Dict[str, Any]] = None
        if stdout_text:
            try:
                parsed = json.loads(stdout_text)
                if isinstance(parsed, dict):
                    stdout_json = parsed
            except json.JSONDecodeError:
                stdout_json = None

        task_ok = proc.returncode == 0 and (stdout_json.get("ok", True) if stdout_json else True)
        status = "succeeded" if task_ok else "failed"

        result = {
            "task_id": task_id,
            "status": status,
            "worker_id": self.worker_id,
            "started_at": started_at,
            "finished_at": utc_now_iso(),
            "duration_ms": elapsed_ms(started_at),
            "task": task_config,
            "command": command,
            "returncode": proc.returncode,
            "stdout_json": stdout_json,
            "stdout_preview": truncate_text(stdout_text, MAX_TEXT_PREVIEW),
            "stderr_preview": truncate_text(stderr_text, MAX_TEXT_PREVIEW),
        }

        if task_ok:
            completed, reason = self._complete_task(task_id, result)
            if not completed:
                task_ok = False
                status = "failed"
                result["status"] = "failed"
                result["completion_error"] = reason
                self._fail_task(task_id, f"completion failed: {reason}", result)
        else:
            error_text = f"agent_loop returncode={proc.returncode}"
            self._fail_task(task_id, error_text, result)

        self._archive_execution(claimed_task, result, success=task_ok)
        self._log(f"task={task_id} status={status} returncode={proc.returncode}")

    def _lease_heartbeat_loop(self, task_id: str, stop_event: threading.Event) -> None:
        while not stop_event.wait(self.heartbeat_interval):
            try:
                ok = self._heartbeat_task(task_id)
                if not ok:
                    self._log(f"warn: heartbeat rejected for task={task_id}")
                    return
            except Exception as error:  # noqa: BLE001
                self._log(f"warn: heartbeat failed for task={task_id}: {type(error).__name__}: {error}")
                return

    def _effective_task_config(self, claimed_task: Dict[str, Any]) -> Dict[str, Any]:
        task_id = str(claimed_task.get("task_id") or "")
        payload = claimed_task.get("payload")
        if isinstance(payload, dict):
            raw = dict(payload)
        else:
            raw = {}
        raw.setdefault("objective", claimed_task.get("objective"))
        raw.setdefault("project_dir", claimed_task.get("project_dir"))
        raw.setdefault("source", claimed_task.get("source"))
        raw.setdefault("source_client", claimed_task.get("source_client"))
        raw.setdefault("source_model", claimed_task.get("source_model"))
        raw.setdefault("source_agent", claimed_task.get("source_agent"))
        raw.setdefault("tags", claimed_task.get("tags"))
        raw.setdefault("metadata", claimed_task.get("metadata"))
        return self._normalize_task(task_id, raw)

    def _normalize_task(self, task_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
        objective = str(raw.get("objective", "")).strip()
        if not objective:
            raise ValueError("task objective is required")

        project_dir_raw = raw.get("project_dir")
        if isinstance(project_dir_raw, str) and project_dir_raw.strip():
            requested = Path(project_dir_raw.strip())
            project_dir = requested.resolve() if requested.is_absolute() else (self.repo_root / requested).resolve()
        else:
            project_dir = self.repo_root

        if not project_dir.exists() or not project_dir.is_dir():
            raise ValueError(f"project_dir is not a valid directory: {project_dir}")

        model = str(raw.get("model") or os.environ.get("ANAMNESIS_INBOX_DEFAULT_MODEL") or "llama3.2:3b").strip()
        max_steps = bounded_int(raw.get("max_steps"), fallback=12, min_value=1, max_value=100)
        command_timeout = bounded_int(raw.get("command_timeout"), fallback=120, min_value=10, max_value=3600)

        dry_run = parse_bool(raw.get("dry_run"), fallback=False)
        no_auto_pull_model = parse_bool(raw.get("no_auto_pull_model"), fallback=False)
        priority = bounded_int(raw.get("priority"), fallback=0, min_value=0, max_value=100)
        max_attempts = bounded_int(raw.get("max_attempts"), fallback=3, min_value=1, max_value=20)

        imprint_profile_id = str(
            raw.get("imprint_profile_id") or os.environ.get("ANAMNESIS_IMPRINT_PROFILE_ID") or "default"
        ).strip()

        mcp_transport = str(
            raw.get("mcp_transport") or os.environ.get("ANAMNESIS_INBOX_MCP_TRANSPORT") or "stdio"
        ).strip().lower()
        if mcp_transport not in {"stdio", "http"}:
            mcp_transport = "stdio"

        mcp_url = str(raw.get("mcp_url") or os.environ.get("ANAMNESIS_INBOX_MCP_URL") or "http://127.0.0.1:8787/").strip()
        mcp_origin = str(raw.get("mcp_origin") or os.environ.get("ANAMNESIS_INBOX_MCP_ORIGIN") or "http://127.0.0.1").strip()
        mcp_stdio_command = str(raw.get("mcp_stdio_command") or os.environ.get("ANAMNESIS_INBOX_MCP_STDIO_COMMAND") or "node").strip()
        mcp_stdio_args = str(raw.get("mcp_stdio_args") or os.environ.get("ANAMNESIS_INBOX_MCP_STDIO_ARGS") or "dist/server.js").strip()

        source = str(raw.get("source") or "imprint.inbox.worker").strip()
        source_client = as_nullable_str(raw.get("source_client"))
        source_model = as_nullable_str(raw.get("source_model"))
        source_agent = as_nullable_str(raw.get("source_agent"))

        tags = normalize_tags(raw.get("tags"))
        metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}

        return {
            "task_id": task_id,
            "objective": objective,
            "project_dir": str(project_dir),
            "model": model,
            "max_steps": max_steps,
            "command_timeout": command_timeout,
            "dry_run": dry_run,
            "no_auto_pull_model": no_auto_pull_model,
            "priority": priority,
            "max_attempts": max_attempts,
            "imprint_profile_id": imprint_profile_id,
            "mcp_transport": mcp_transport,
            "mcp_url": mcp_url,
            "mcp_origin": mcp_origin,
            "mcp_stdio_command": mcp_stdio_command,
            "mcp_stdio_args": mcp_stdio_args,
            "source": source,
            "source_client": source_client,
            "source_model": source_model,
            "source_agent": source_agent,
            "tags": tags,
            "metadata": metadata,
        }

    def _build_agent_command(self, task: Dict[str, Any]) -> List[str]:
        command = [
            sys.executable,
            str(self.agent_loop_path),
            "--project-dir",
            task["project_dir"],
            "--objective",
            task["objective"],
            "--model",
            task["model"],
            "--max-steps",
            str(task["max_steps"]),
            "--command-timeout",
            str(task["command_timeout"]),
            "--imprint-profile-id",
            task["imprint_profile_id"],
            "--mcp-transport",
            task["mcp_transport"],
            "--mcp-url",
            task["mcp_url"],
            "--mcp-origin",
            task["mcp_origin"],
            "--mcp-stdio-command",
            task["mcp_stdio_command"],
            "--mcp-stdio-args",
            task["mcp_stdio_args"],
        ]
        if task["dry_run"]:
            command.append("--dry-run")
        if task["no_auto_pull_model"]:
            command.append("--no-auto-pull-model")
        return command

    def _archive_execution(self, task: Dict[str, Any], result: Dict[str, Any], success: bool) -> None:
        target_dir = self.done_dir if success else self.failed_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        task_id = sanitize_task_id(str(task.get("task_id") or "task"))
        task_path = unique_path(target_dir, f"{task_id}.task.json")
        result_path = unique_path(target_dir, f"{task_id}.result.json")
        task_payload = {
            "task_id": task.get("task_id"),
            "status": task.get("status"),
            "objective": task.get("objective"),
            "project_dir": task.get("project_dir"),
            "payload": task.get("payload"),
            "source": task.get("source"),
            "source_client": task.get("source_client"),
            "source_model": task.get("source_model"),
            "source_agent": task.get("source_agent"),
            "tags": task.get("tags"),
            "metadata": task.get("metadata"),
            "attempt_count": task.get("attempt_count"),
            "max_attempts": task.get("max_attempts"),
        }
        write_json_atomic(task_path, task_payload)
        write_json_atomic(result_path, result)

    @staticmethod
    def _log(message: str) -> None:
        sys.stderr.write(f"[imprint-inbox-worker] {message}\n")
        sys.stderr.flush()


def build_task_payload_for_storage(task: Dict[str, Any], raw: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(raw)
    payload["task_id"] = task["task_id"]
    payload["objective"] = task["objective"]
    payload["project_dir"] = task["project_dir"]
    payload["model"] = task["model"]
    payload["max_steps"] = task["max_steps"]
    payload["command_timeout"] = task["command_timeout"]
    payload["dry_run"] = task["dry_run"]
    payload["no_auto_pull_model"] = task["no_auto_pull_model"]
    payload["imprint_profile_id"] = task["imprint_profile_id"]
    payload["mcp_transport"] = task["mcp_transport"]
    payload["mcp_url"] = task["mcp_url"]
    payload["mcp_origin"] = task["mcp_origin"]
    payload["mcp_stdio_command"] = task["mcp_stdio_command"]
    payload["mcp_stdio_args"] = task["mcp_stdio_args"]
    payload["source"] = task["source"]
    payload["source_client"] = task["source_client"]
    payload["source_model"] = task["source_model"]
    payload["source_agent"] = task["source_agent"]
    payload["tags"] = task["tags"]
    payload["metadata"] = task["metadata"]
    payload["priority"] = task["priority"]
    payload["max_attempts"] = task["max_attempts"]
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MCPlayground local inbox worker daemon")
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parent.parent),
        help="Repository root path.",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL,
        help="Idle polling interval in seconds.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="Max tasks to process per loop iteration.",
    )
    parser.add_argument(
        "--lease-seconds",
        type=int,
        default=int(os.environ.get("ANAMNESIS_INBOX_LEASE_SECONDS", DEFAULT_LEASE_SECONDS)),
        help="Task lease duration in seconds.",
    )
    parser.add_argument(
        "--heartbeat-interval",
        type=int,
        default=int(os.environ.get("ANAMNESIS_INBOX_HEARTBEAT_INTERVAL", DEFAULT_HEARTBEAT_INTERVAL)),
        help="Lease heartbeat interval in seconds.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process at most one polling batch and exit.",
    )
    parser.add_argument(
        "--worker-id",
        default=f"{socket.gethostname()}-{os.getpid()}",
        help="Worker id used in lease ownership and result metadata.",
    )
    return parser.parse_args()


def resolve_db_path(repo_root: Path) -> Path:
    db_env = os.environ.get("ANAMNESIS_HUB_DB_PATH") or os.environ.get("MCP_HUB_DB_PATH")
    if db_env:
        raw = Path(db_env.strip())
        return raw if raw.is_absolute() else (repo_root / raw).resolve()
    return (repo_root / "data" / "hub.sqlite").resolve()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_after_seconds(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=max(1, seconds))).isoformat().replace("+00:00", "Z")


def elapsed_ms(started_at_iso: str) -> int:
    try:
        started = datetime.fromisoformat(started_at_iso.replace("Z", "+00:00"))
    except ValueError:
        return 0
    now = datetime.now(timezone.utc)
    delta = now - started
    return int(delta.total_seconds() * 1000)


def bounded_int(value: Any, fallback: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(min_value, min(max_value, parsed))


def parse_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return fallback


def truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}... [truncated {len(text) - max_chars} chars]"


def normalize_tags(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    tags: List[str] = []
    seen = set()
    for entry in value:
        normalized = str(entry).strip()
        if not normalized:
            continue
        lower = normalized.lower()
        if lower in seen:
            continue
        seen.add(lower)
        tags.append(normalized)
    return tags


def safe_parse_json_object(value: Any) -> Dict[str, Any]:
    if value is None:
        return {}
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        if isinstance(parsed, dict):
            return parsed
    except Exception:  # noqa: BLE001
        return {}
    return {}


def safe_parse_json_object_nullable(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    parsed = safe_parse_json_object(value)
    return parsed


def safe_parse_json_array(value: Any) -> List[str]:
    if value is None:
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        if isinstance(parsed, list):
            return [str(entry) for entry in parsed]
    except Exception:  # noqa: BLE001
        return []
    return []


def as_nullable_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def stable_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=True)


def write_json_atomic(path: Path, payload: Dict[str, Any]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")
    temp_path.replace(path)


def unique_path(directory: Path, file_name: str) -> Path:
    candidate = directory / file_name
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = "".join(candidate.suffixes)
    return directory / f"{stem}-{int(time.time() * 1000)}{suffix}"


def sanitize_task_id(task_id: str) -> str:
    sanitized = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in task_id.strip())
    return sanitized or "task"


def make_uuid() -> str:
    return os.urandom(16).hex()


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    if not repo_root.exists() or not repo_root.is_dir():
        sys.stderr.write(f"error: invalid --repo-root: {repo_root}\n")
        return 2

    worker = InboxWorker(
        repo_root=repo_root,
        poll_interval=args.poll_interval,
        batch_size=args.batch_size,
        lease_seconds=args.lease_seconds,
        heartbeat_interval=args.heartbeat_interval,
        once=args.once,
        worker_id=args.worker_id,
    )
    return worker.run()


if __name__ == "__main__":
    sys.exit(main())
