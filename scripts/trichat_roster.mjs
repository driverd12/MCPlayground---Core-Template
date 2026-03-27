#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH
    ? path.resolve(process.env.DOTENV_CONFIG_PATH)
    : path.join(repoRoot, ".env"),
});

const fallback = {
  version: 1,
  default_agent_ids: ["codex", "cursor", "local-imprint"],
  agents: [
    {
      agent_id: "codex",
      display_name: "Codex",
      role_lane: "planner",
      bridge_env_var: "TRICHAT_CODEX_CMD",
      bridge_script_names: ["codex_bridge.py"],
      supports_local_model_fallback: true,
      description: "High-signal engineering planner and merge strategist.",
    },
    {
      agent_id: "cursor",
      display_name: "Cursor",
      role_lane: "implementer",
      bridge_env_var: "TRICHAT_CURSOR_CMD",
      bridge_script_names: ["cursor_bridge.py"],
      supports_local_model_fallback: true,
      description: "Practical implementation guide focused on developer UX and execution details.",
    },
    {
      agent_id: "local-imprint",
      display_name: "Local Imprint",
      role_lane: "reliability-critic",
      bridge_env_var: "TRICHAT_IMPRINT_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      supports_local_model_fallback: true,
      description: "Deterministic local-first reliability mentor backed by Ollama.",
    },
  ],
};

function normalizeAgentId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => normalizeAgentId(entry))
    .filter(Boolean);
}

function loadRosterConfig() {
  const configPath = path.join(repoRoot, "config", "trichat_agents.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const agents = Array.isArray(parsed.agents)
      ? parsed.agents
          .filter((entry) => entry && typeof entry === "object" && entry.enabled !== false)
          .map((entry) => ({
            agent_id: normalizeAgentId(entry.agent_id),
            display_name: String(entry.display_name ?? entry.agent_id ?? "").trim(),
            provider: String(entry.provider ?? "").trim() || undefined,
            auth_mode: String(entry.auth_mode ?? "").trim() || undefined,
            role_lane: String(entry.role_lane ?? "").trim() || undefined,
            bridge_env_var: String(entry.bridge_env_var ?? "").trim() || undefined,
            bridge_script_names: Array.isArray(entry.bridge_script_names)
              ? entry.bridge_script_names.map((name) => String(name).trim()).filter(Boolean)
              : [],
            supports_local_model_fallback: entry.supports_local_model_fallback !== false,
            description: String(entry.description ?? "").trim() || undefined,
          }))
          .filter((entry) => entry.agent_id && entry.display_name)
      : [];
    const defaults = Array.isArray(parsed.default_agent_ids)
      ? parsed.default_agent_ids.map((entry) => normalizeAgentId(entry)).filter(Boolean)
      : [];
    if (agents.length > 0) {
      return {
        version: Number(parsed.version ?? 1),
        default_agent_ids: defaults.length > 0 ? defaults : fallback.default_agent_ids,
        agents,
      };
    }
  } catch {
    // fall through
  }
  return fallback;
}

function resolveBridgeCandidates(agent) {
  const names =
    Array.isArray(agent.bridge_script_names) && agent.bridge_script_names.length > 0
      ? agent.bridge_script_names
      : [`${agent.agent_id}_bridge.py`, `${agent.agent_id.replace(/-/g, "_")}_bridge.py`];
  return names.map((name) => path.join(repoRoot, "bridges", name));
}

const roster = loadRosterConfig();
const catalogIds = new Set(roster.agents.map((agent) => agent.agent_id));
const requestedIds = parseCsv(process.env.TRICHAT_AGENT_IDS);
const activeIds = (requestedIds.length > 0 ? requestedIds : roster.default_agent_ids).filter((agentId) =>
  catalogIds.has(agentId)
);

const summary = {
  config_path: path.join(repoRoot, "config", "trichat_agents.json"),
  default_agent_ids: roster.default_agent_ids,
  active_agent_ids: activeIds.length > 0 ? activeIds : roster.default_agent_ids,
  overridden_by_env: requestedIds.length > 0,
  agents: roster.agents.map((agent) => ({
    ...agent,
    active: (activeIds.length > 0 ? activeIds : roster.default_agent_ids).includes(agent.agent_id),
    resolved_bridge_candidates: resolveBridgeCandidates(agent),
  })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
