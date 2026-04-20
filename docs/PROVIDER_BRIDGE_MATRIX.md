# Provider Bridge Matrix

This is the truthful bridge matrix for presentation use. It separates:

1. clients that can connect **into** this MCP server
2. providers the ring leader can already consult **outward** as live council agents

Do not collapse those into one claim.

## Canonical Rule

All operator and IDE objectives should enter through `autonomy.ide_ingress`.

That keeps:

- transcript continuity
- office/TriChat mirroring
- durable goal and plan creation
- ring-leader background execution

on one real lane.

## Local-First IDE Policy

By default, IDE-ingress autonomy uses this local-first council before escalating:

- `implementation-director`
- `research-director`
- `verification-director`
- `local-imprint`

Override with explicit `trichat_agent_ids` only when you intentionally want a different pool.

## Matrix

| Client / Provider | Connects into MCP | Ring leader can query outward | Local-only transport possible | Notes |
| --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes for MCP, no for frontier model inference | Inbound via Codex MCP config; outward via `bridges/codex_bridge.py` |
| Claude CLI | Yes | Yes | Yes for MCP transport, no for Claude model inference | Inbound via native `claude mcp add` / `add-json`; defaults to a resilient `stdio` proxy on this host, using the MCP HTTP daemon first and a local stdio fallback when needed; outward via `bridges/claude_bridge.py`; visible operator control is available through `claude_code_terminal_open.sh` plus `claude_code_terminal_send.sh`; live model use still depends on Claude auth state |
| Cursor | Yes | Yes | Yes for MCP, no for cloud model inference | Inbound via both `~/.cursor/mcp.json` and workspace-local `.cursor/mcp.json`; outward via `bridges/cursor_bridge.py` |
| Gemini CLI | Yes | Yes | Yes for MCP transport, no for Gemini model inference | Inbound via `~/.gemini/settings.json`; standalone `gemini` CLI binary; defaults to the same resilient `stdio` proxy pattern for MCP reliability; outward via `bridges/gemini_bridge.py` |
| GitHub Copilot CLI | Yes | No | Yes for MCP transport, no for Copilot model inference | Inbound via `~/.copilot/mcp-config.json`; current official standalone CLI is `copilot`; keep this as an inbound MCP client until a real outbound council bridge contract exists |
| GitHub Copilot Agent Mode / VS Code | Exportable | No | Yes for MCP transport, no for Copilot model inference | Export workspace `.vscode/mcp.json`; keep this honest as an editor-client integration |
| ChatGPT Developer Mode | Remote-only | No | No | Requires a remote MCP server path and internet connectivity; export manifest only |

## Commands

Status:

```bash
npm run providers:status
npm run providers:diagnose -- claude-cli gemini-cli cursor github-copilot-cli
```

Export a presentation/import bundle:

```bash
npm run providers:export
```

Install the locally supported client configs:

```bash
npm run providers:install -- claude-cli cursor gemini-cli github-copilot-cli
```

Claude CLI and Gemini CLI default to a resilient stdio proxy on this host for better local compatibility, preferring the MCP HTTP daemon and falling back to a direct local stdio path when necessary.

CLI-driven `providers:diagnose` now refreshes stale bridge diagnostics live when it can do so safely over stdio. The HTTP-facing status and diagnosis surfaces still prefer cached or stale results when necessary so the shared daemon stays responsive.

Codex install still uses the dedicated script:

```bash
npm run codex:mcp:register -- master-mold
```

## What `provider.bridge` Actually Does

- reports which clients are really installable vs export-only vs remote-only
- reports which external providers already exist as live outbound council agents
- reports which outbound providers are runtime-eligible as bridge-backed `model.router` backends
- gives `autonomy.bootstrap` the same bridge/backend truth so the control plane can seed hosted backends automatically
- lets local-first councils stay primary while `autonomy.command`, `goal.execute`, and `plan.dispatch` add routed hosted agents only when the router says they are relevant
- exports ready-to-import config snippets and a truthful ChatGPT remote manifest
- installs the supported local client config paths for Claude CLI, Cursor, Gemini CLI, and GitHub Copilot CLI, including workspace-local `.cursor/mcp.json`
- diagnoses bridge truth without conflating “configured” and “runtime connected”
- refreshes stale CLI diagnose evidence into the shared cache so `status` and onboarding surfaces converge after a real operator check
- keeps local Ollama/MLX winners as the default first-pass execution lane instead of auto-injecting near-top hosted bridges, unless the objective explicitly asks for hosted providers or named bridge agents
- preserves `autonomy.ide_ingress` as the one canonical ingress lane

## Source References

- Cursor MCP docs: [cursor.com/docs](https://cursor.com/docs)
- GitHub Copilot MCP docs: [docs.github.com](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- Gemini CLI repo/docs: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- OpenAI Developer Mode docs: [platform.openai.com/docs/developer-mode](https://platform.openai.com/docs/developer-mode)
