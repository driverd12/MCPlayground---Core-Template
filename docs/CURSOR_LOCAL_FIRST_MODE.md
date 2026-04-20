# Cursor Local-First Mode

Use Cursor as the editor surface, `MASTER-MOLD` as the control plane, and Ollama/MLX as the default local inference lane.

## Canonical architecture

- `Cursor` is the MCP client and operator UI.
- `MASTER-MOLD` owns memory, routing, transcripts, task state, and escalation policy.
- `Ollama` / `MLX` provide the first-pass local model lane.
- Hosted bridges such as Claude, Codex, Cursor, or Gemini escalate only when explicitly targeted or when durable evidence says local-first was insufficient.

Do not treat Cursor chat history as the durable memory layer. Keep continuity in MCP artifacts and SQLite-backed state.

## Cursor setup

Keep Cursor pointed at the shared `MASTER-MOLD` MCP server through:

- `~/.cursor/mcp.json`
- workspace-local `.cursor/mcp.json`

That keeps Cursor attached to the same control plane the other agents use.

## Inspect local backends from Cursor

Call `model.router` with:

```json
{
  "action": "local_status"
}
```

This returns:

- available local Ollama/MLX-style backends
- the current default backend
- basic health/performance metadata
- the recommended local-first control path

## Select a local backend from Cursor

Call `model.router` with:

```json
{
  "action": "select_local_backend",
  "backend_id": "<local-backend-id>",
  "mutation": {
    "idempotency_key": "cursor-local-backend-select-001",
    "side_effect_fingerprint": "cursor-local-backend-select-001"
  }
}
```

This changes the default router backend to the selected local Ollama/MLX backend while keeping the change durable in `MASTER-MOLD`.

## Recommended intake path

Send work through `autonomy.ide_ingress`, not raw Cursor chat state.

That preserves:

- goal and plan creation
- transcript continuity
- office mirroring
- local-first routing
- durable escalation records

## When to escalate beyond local-first

Use hosted bridges only when one of these is true:

- the work explicitly targets a bridge agent
- the work explicitly asks for hosted providers
- a durable local-attempt record says the local lane could not meet the evidence bar

`MASTER-MOLD` now records local-first attempt and escalation state in autonomy metadata so this stays replay-safe across sessions.

## Optional direct Cursor -> Ollama path

Some Cursor builds expose an OpenAI-compatible base URL override that can point directly at Ollama. That path is version-dependent and is not the canonical setup here.

If you experiment with it:

- keep `MASTER-MOLD` as the authoritative MCP layer
- treat direct Cursor -> Ollama as an optional editor-side shortcut
- avoid storing durable context only in Cursor chat

The recommended production path remains:

`Cursor -> MASTER-MOLD MCP -> local Ollama/MLX -> hosted bridges only when needed`
