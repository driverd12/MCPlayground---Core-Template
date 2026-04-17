# SUPERPOWERS Security

## Scope

- Local-first server with SQLite persistence in `./data/hub.sqlite` by default.
- STDIO transport has no network listening surface.
- HTTP transport is intended for loopback/local use.

## HTTP Guardrails

- Requires `Authorization: Bearer <token>` when `MCP_HTTP_BEARER_TOKEN` is set.
- Validates `Origin` against `MCP_HTTP_ALLOWED_ORIGINS`.
- Rejects missing or invalid origin/token requests.
- Default host is `127.0.0.1`.

## Data Handling

- SQLite uses WAL mode for durability and concurrent reads.
- Mutating tools are idempotency-journaled (`idempotency_key` + `side_effect_fingerprint`).
- Policy checks, run events, tasks, incidents, and decision links are persisted locally.
- Domain packs should persist only local data unless explicitly documented otherwise.

## Operational Controls

- Use `preflight.check` before risky writes.
- Use `postflight.verify` for post-action assertions.
- Use `lock.acquire` for shared mutable resources.
- Use `policy.evaluate` for guardrails on sensitive/destructive operations.

## Local-Only Posture

- Cloud consultation providers are disabled by default.
- Continuity and retrieval workflows run on local SQLite data only.
- If remote providers are enabled in downstream forks, document data boundaries explicitly.
