import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TriChatAgentDefinition = {
  agent_id: string;
  display_name: string;
  provider?: string;
  auth_mode?: string;
  role_lane?: string;
  accent_color?: string;
  bridge_env_var?: string;
  bridge_script_names?: string[];
  description?: string;
  system_prompt: string;
  supports_local_model_fallback?: boolean;
  enabled?: boolean;
};

type TriChatRosterConfig = {
  version: number;
  default_agent_ids: string[];
  agents: TriChatAgentDefinition[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rosterConfigPath = path.join(repoRoot, "config", "trichat_agents.json");

const fallbackConfig: TriChatRosterConfig = {
  version: 1,
  default_agent_ids: ["codex", "cursor", "local-imprint"],
  agents: [
    {
      agent_id: "codex",
      display_name: "Codex",
      provider: "openai",
      auth_mode: "cli-login",
      role_lane: "planner",
      accent_color: "#ff4fd8",
      bridge_env_var: "TRICHAT_CODEX_CMD",
      bridge_script_names: ["codex_bridge.py"],
      description: "High-signal engineering planner and merge strategist.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Codex in tri-chat mode. Respond with concrete, high-signal engineering guidance. Keep replies concise: max 6 lines unless asked for depth. Do not include next actions, thread history, or other scaffolding.",
    },
    {
      agent_id: "cursor",
      display_name: "Cursor",
      provider: "cursor",
      auth_mode: "cli-login",
      role_lane: "implementer",
      accent_color: "#54c6eb",
      bridge_env_var: "TRICHAT_CURSOR_CMD",
      bridge_script_names: ["cursor_bridge.py"],
      description: "Practical implementation guide focused on developer UX and execution details.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Cursor in tri-chat mode. Respond with practical implementation guidance and concise reasoning. Keep replies to max 6 lines unless asked for details. Avoid meta-scaffolding sections.",
    },
    {
      agent_id: "gemini",
      display_name: "Gemini",
      provider: "google",
      auth_mode: "cli-or-env",
      role_lane: "analyst",
      accent_color: "#32c26b",
      bridge_env_var: "TRICHAT_GEMINI_CMD",
      bridge_script_names: ["gemini_bridge.py"],
      description: "Cross-check analyst tuned for synthesis, summarization, and alternative implementation framing.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Gemini in tri-chat mode. Respond with concise analysis, synthesis, and practical alternatives. Keep replies to max 6 lines unless asked for detail. Avoid recap sections and stay implementation-relevant.",
    },
    {
      agent_id: "claude",
      display_name: "Claude",
      provider: "anthropic",
      auth_mode: "cli-or-env",
      role_lane: "critic",
      accent_color: "#f4a261",
      bridge_env_var: "TRICHAT_CLAUDE_CMD",
      bridge_script_names: ["claude_bridge.py"],
      description: "Safety and critique lane for risk review, tradeoff analysis, and counterarguments.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Claude in tri-chat mode. Respond with careful critique, risk surfacing, and concise reasoning. Keep replies to max 6 lines unless asked for detail. Avoid recap sections and focus on tradeoffs that matter.",
    },
    {
      agent_id: "local-imprint",
      display_name: "Local Imprint",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "reliability-critic",
      accent_color: "#ffd166",
      bridge_env_var: "TRICHAT_IMPRINT_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Deterministic local-first reliability mentor backed by Ollama.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are the local Imprint agent for Anamnesis. Favor deterministic local-first execution and idempotent operations. Reply in max 6 lines by default and do not dump memory or transcript blocks unless explicitly requested.",
    },
  ],
};

let cachedRoster: TriChatRosterConfig | null = null;

function normalizeAgentId(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => normalizeAgentId(entry))
    .filter((entry) => entry.length > 0);
}

function loadRosterConfig(): TriChatRosterConfig {
  if (cachedRoster) {
    return cachedRoster;
  }
  try {
    const raw = fs.readFileSync(rosterConfigPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TriChatRosterConfig>;
    const agents = Array.isArray(parsed.agents)
      ? parsed.agents
          .map((entry) => sanitizeAgent(entry))
          .filter((entry): entry is TriChatAgentDefinition => entry !== null)
      : [];
    const defaults = Array.isArray(parsed.default_agent_ids)
      ? parsed.default_agent_ids.map((entry) => normalizeAgentId(String(entry))).filter((entry) => entry.length > 0)
      : [];
    if (agents.length > 0) {
      cachedRoster = {
        version: Number(parsed.version ?? 1),
        default_agent_ids: defaults.length > 0 ? defaults : fallbackConfig.default_agent_ids,
        agents,
      };
      return cachedRoster;
    }
  } catch {
    // Fall back to the built-in roster when the JSON file is missing or invalid.
  }
  cachedRoster = structuredClone(fallbackConfig);
  return cachedRoster;
}

function sanitizeAgent(value: unknown): TriChatAgentDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const agent_id = normalizeAgentId(String(candidate.agent_id ?? ""));
  const display_name = String(candidate.display_name ?? "").trim();
  const system_prompt = String(candidate.system_prompt ?? "").trim();
  if (!agent_id || !display_name || !system_prompt) {
    return null;
  }
  return {
    agent_id,
    display_name,
    provider: String(candidate.provider ?? "").trim() || undefined,
    auth_mode: String(candidate.auth_mode ?? "").trim() || undefined,
    role_lane: String(candidate.role_lane ?? "").trim() || undefined,
    accent_color: String(candidate.accent_color ?? "").trim() || undefined,
    bridge_env_var: String(candidate.bridge_env_var ?? "").trim() || undefined,
    bridge_script_names: Array.isArray(candidate.bridge_script_names)
      ? candidate.bridge_script_names
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0)
      : undefined,
    description: String(candidate.description ?? "").trim() || undefined,
    supports_local_model_fallback: candidate.supports_local_model_fallback !== false,
    enabled: candidate.enabled !== false,
    system_prompt,
  };
}

export function getTriChatRosterConfigPath(): string {
  return rosterConfigPath;
}

export function getTriChatAgentCatalog(): TriChatAgentDefinition[] {
  return loadRosterConfig()
    .agents.filter((agent) => agent.enabled !== false)
    .map((agent) => ({ ...agent }));
}

export function getTriChatAgentMap(): Map<string, TriChatAgentDefinition> {
  return new Map(getTriChatAgentCatalog().map((agent) => [agent.agent_id, agent]));
}

export function getTriChatConfiguredDefaultAgentIds(): string[] {
  const config = loadRosterConfig();
  const catalogIds = new Set(getTriChatAgentCatalog().map((agent) => agent.agent_id));
  const defaults = config.default_agent_ids.filter((agentId) => catalogIds.has(agentId));
  return defaults.length > 0 ? defaults : fallbackConfig.default_agent_ids.slice();
}

export function getTriChatActiveAgentIds(agentIds?: readonly string[]): string[] {
  const requested =
    agentIds && agentIds.length > 0 ? agentIds.map((entry) => normalizeAgentId(entry)) : parseCsv(process.env.TRICHAT_AGENT_IDS);
  const activeSource = requested.length > 0 ? requested : getTriChatConfiguredDefaultAgentIds();
  const catalog = getTriChatAgentMap();
  const deduped = new Set<string>();
  for (const agentId of activeSource) {
    if (catalog.has(agentId)) {
      deduped.add(agentId);
    }
  }
  if (deduped.size > 0) {
    return Array.from(deduped);
  }
  return getTriChatConfiguredDefaultAgentIds();
}

export function getTriChatAgent(agentId: string | null | undefined): TriChatAgentDefinition | null {
  const normalized = normalizeAgentId(agentId);
  return getTriChatAgentMap().get(normalized) ?? null;
}

export function getTriChatAgentDisplayName(agentId: string | null | undefined): string {
  return getTriChatAgent(agentId)?.display_name ?? normalizeAgentId(agentId);
}

export function getTriChatRoleLaneMap(agentIds?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const agentId of getTriChatActiveAgentIds(agentIds)) {
    const lane = getTriChatAgent(agentId)?.role_lane?.trim() || "collaborator";
    out[agentId] = lane;
  }
  return out;
}

export function getTriChatBridgeEnvVar(agentId: string | null | undefined): string | null {
  return getTriChatAgent(agentId)?.bridge_env_var ?? null;
}

export function getTriChatBridgeCandidates(workspace: string, agentId: string): string[] {
  const agent = getTriChatAgent(agentId);
  const names = agent?.bridge_script_names?.length
    ? agent.bridge_script_names
    : [`${normalizeAgentId(agentId)}_bridge.py`, `${normalizeAgentId(agentId).replace(/-/g, "_")}_bridge.py`];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const name of names) {
    const resolved = path.join(workspace, "bridges", name);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    candidates.push(resolved);
  }
  return candidates;
}

export function getTriChatRosterSummary(agentIds?: readonly string[]) {
  const activeAgentIds = getTriChatActiveAgentIds(agentIds);
  return {
    config_path: rosterConfigPath,
    default_agent_ids: getTriChatConfiguredDefaultAgentIds(),
    active_agent_ids: activeAgentIds,
    overridden_by_env: parseCsv(process.env.TRICHAT_AGENT_IDS).length > 0,
    agents: getTriChatAgentCatalog().map((agent) => ({
      ...agent,
      active: activeAgentIds.includes(agent.agent_id),
    })),
  };
}

export function normalizeTriChatAgentId(agentId: string | null | undefined): string {
  return normalizeAgentId(agentId);
}
