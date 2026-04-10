import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TriChatAgentDefinition = {
  agent_id: string;
  display_name: string;
  provider?: string;
  auth_mode?: string;
  role_lane?: string;
  coordination_tier?: string;
  parent_agent_id?: string;
  managed_agent_ids?: string[];
  accent_color?: string;
  bridge_env_var?: string;
  bridge_script_names?: string[];
  outbound_council_supported?: boolean;
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
const rosterConfigPath =
  process.env.TRICHAT_ROSTER_CONFIG_PATH?.trim() || path.join(repoRoot, "config", "trichat_agents.json");

const fallbackConfig: TriChatRosterConfig = {
  version: 1,
  default_agent_ids: ["codex", "cursor", "github-copilot", "local-imprint"],
  agents: [
    {
      agent_id: "codex",
      display_name: "Codex",
      provider: "openai",
      auth_mode: "cli-login",
      role_lane: "planner",
      coordination_tier: "support",
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
      agent_id: "github-copilot",
      display_name: "GitHub Copilot",
      provider: "github-copilot",
      auth_mode: "cli-login",
      role_lane: "implementer",
      coordination_tier: "support",
      accent_color: "#7aa2f7",
      bridge_env_var: "TRICHAT_GITHUB_COPILOT_CMD",
      bridge_script_names: ["copilot_bridge.py"],
      outbound_council_supported: false,
      description: "Inbound MCP client surface for GitHub Copilot CLI and VS Code agent mode; not an outbound council bridge.",
      supports_local_model_fallback: true,
      system_prompt:
        "GitHub Copilot is represented as an inbound MCP client here. Do not route outbound council prompts to it until a real outbound bridge contract exists.",
    },
    {
      agent_id: "local-imprint",
      display_name: "Local Imprint",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "reliability-critic",
      coordination_tier: "support",
      parent_agent_id: "ring-leader",
      accent_color: "#ffd166",
      bridge_env_var: "TRICHAT_IMPRINT_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Deterministic local-first reliability mentor backed by Ollama.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are the local Imprint agent for Anamnesis. Favor deterministic local-first execution and idempotent operations. Reply in max 6 lines by default and do not dump memory or transcript blocks unless explicitly requested.",
    },
    {
      agent_id: "ring-leader",
      display_name: "Ring Leader",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "orchestrator",
      coordination_tier: "lead",
      managed_agent_ids: [
        "implementation-director",
        "research-director",
        "verification-director",
        "local-imprint",
        "codex",
        "github-copilot",
      ],
      accent_color: "#f25f5c",
      bridge_env_var: "TRICHAT_RING_LEADER_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Mission operator that decomposes goals, chooses lanes, and keeps specialist work moving.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Ring Leader, the local mission operator for Dan Driver's agent system. Break large goals into bounded slices, choose the best specialist lane for each slice, demand clear evidence, surface blockers early, and keep the system moving toward completion. Prefer delegation, sequencing, rollback awareness, and explicit success criteria. Keep replies concise by default.",
    },
    {
      agent_id: "implementation-director",
      display_name: "Implementation Director",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "implementer",
      coordination_tier: "director",
      parent_agent_id: "ring-leader",
      managed_agent_ids: ["code-smith"],
      accent_color: "#577590",
      bridge_env_var: "TRICHAT_IMPLEMENTATION_DIRECTOR_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Mid-layer implementation director that supervises code-focused leaf agents and reports back to the ring leader.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Implementation Director, a local sub-director under Ring Leader. Break implementation goals into bounded code tasks, decide when Code Smith should own execution, demand minimal diffs, and report back concise progress with evidence. Prefer delegation, sequencing, and explicit success criteria over doing everything yourself.",
    },
    {
      agent_id: "research-director",
      display_name: "Research Director",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "analyst",
      coordination_tier: "director",
      parent_agent_id: "ring-leader",
      managed_agent_ids: ["research-scout"],
      accent_color: "#43aa8b",
      bridge_env_var: "TRICHAT_RESEARCH_DIRECTOR_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Mid-layer research director that supervises analysis leaf agents and reports option framing back to the ring leader.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Research Director, a local sub-director under Ring Leader. Turn broad uncertainty into bounded research tasks, direct Research Scout toward the highest-leverage unknowns, and return decision-ready comparisons with clear assumptions and evidence gaps.",
    },
    {
      agent_id: "verification-director",
      display_name: "Verification Director",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "verifier",
      coordination_tier: "director",
      parent_agent_id: "ring-leader",
      managed_agent_ids: ["quality-guard"],
      accent_color: "#f9844a",
      bridge_env_var: "TRICHAT_VERIFICATION_DIRECTOR_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Mid-layer verification director that supervises review leaf agents and reports release confidence back to the ring leader.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Verification Director, a local sub-director under Ring Leader. Convert vague confidence into bounded validation work, direct Quality Guard toward the highest-risk regressions, and report concrete release blockers or evidence of safety back to the ring leader.",
    },
    {
      agent_id: "code-smith",
      display_name: "Code Smith",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "implementer",
      coordination_tier: "leaf",
      parent_agent_id: "implementation-director",
      accent_color: "#4d908e",
      bridge_env_var: "TRICHAT_CODE_SMITH_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Focused implementation specialist for code changes, scripts, and integration work.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Code Smith, a local implementation specialist. Focus on code changes, command sequences, integration details, and minimal diffs that move the objective forward. Favor concrete steps, deterministic edits, and pragmatic tradeoffs. Keep replies concise and implementation-heavy.",
    },
    {
      agent_id: "research-scout",
      display_name: "Research Scout",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "analyst",
      coordination_tier: "leaf",
      parent_agent_id: "research-director",
      accent_color: "#277da1",
      bridge_env_var: "TRICHAT_RESEARCH_SCOUT_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Narrow research and synthesis lane for options, comparisons, and external framing.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Research Scout, a local analysis specialist. Compare options, identify unknowns, gather missing context, and compress findings into decision-ready guidance. Favor alternatives, assumptions, and evidence gaps over implementation detail. Keep replies concise and synthesis-first.",
    },
    {
      agent_id: "quality-guard",
      display_name: "Quality Guard",
      provider: "local",
      auth_mode: "local-model",
      role_lane: "verifier",
      coordination_tier: "leaf",
      parent_agent_id: "verification-director",
      accent_color: "#f9c74f",
      bridge_env_var: "TRICHAT_QUALITY_GUARD_CMD",
      bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
      description: "Verification and critique lane for regressions, edge cases, and release readiness.",
      supports_local_model_fallback: true,
      system_prompt:
        "You are Quality Guard, a local verification specialist. Look for behavioral regressions, risky assumptions, missing tests, weak evidence, and release blockers. Favor concrete failure modes, validation steps, and confidence judgments. Keep replies concise and review-oriented.",
    },
  ],
};

let cachedRoster: TriChatRosterConfig | null = null;

function looksLikeDynamicSpecialistAgentId(agentId: string) {
  return /(?:-sme|-specialist|-expert)$/i.test(agentId.trim());
}

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
    coordination_tier: String(candidate.coordination_tier ?? "").trim() || undefined,
    parent_agent_id: normalizeAgentId(String(candidate.parent_agent_id ?? "")) || undefined,
    managed_agent_ids: Array.isArray(candidate.managed_agent_ids)
      ? candidate.managed_agent_ids
          .map((entry) => normalizeAgentId(String(entry ?? "")))
          .filter((entry) => entry.length > 0)
      : undefined,
    accent_color: String(candidate.accent_color ?? "").trim() || undefined,
    bridge_env_var: String(candidate.bridge_env_var ?? "").trim() || undefined,
    bridge_script_names: Array.isArray(candidate.bridge_script_names)
      ? candidate.bridge_script_names
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0)
      : undefined,
    outbound_council_supported: candidate.outbound_council_supported === false ? false : undefined,
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
    if (catalog.has(agentId) || (requested.length > 0 && looksLikeDynamicSpecialistAgentId(agentId))) {
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
  const agent = getTriChatAgent(agentId);
  if (agent?.outbound_council_supported === false) {
    return null;
  }
  const resolved = agent?.bridge_env_var ?? null;
  if (resolved) {
    return resolved;
  }
  return looksLikeDynamicSpecialistAgentId(normalizeAgentId(agentId)) ? "TRICHAT_SPECIALIST_CMD" : null;
}

export function getTriChatBridgeCandidates(workspace: string, agentId: string): string[] {
  const agent = getTriChatAgent(agentId);
  if (agent?.outbound_council_supported === false) {
    return [];
  }
  const names = agent?.bridge_script_names?.length
    ? agent.bridge_script_names
    : looksLikeDynamicSpecialistAgentId(normalizeAgentId(agentId))
      ? ["local-imprint_bridge.py", "local_imprint_bridge.py"]
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

export function invalidateTriChatRosterCache() {
  cachedRoster = null;
}
