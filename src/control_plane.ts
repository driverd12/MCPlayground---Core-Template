import crypto from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry)))];
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

const TOOL_TOKEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "into",
  "from",
  "that",
  "this",
  "then",
  "when",
  "have",
  "your",
  "their",
  "through",
  "local",
  "durable",
  "record",
  "records",
  "state",
  "states",
  "tool",
  "tools",
]);

function tokenizeText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2 && !TOOL_TOKEN_STOPWORDS.has(entry));
}

function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export type ToolCatalogEntry = {
  name: string;
  description: string;
  capability_area: string;
  tags: string[];
  schema_properties: string[];
  search_text: string;
};

const toolCatalogRuntime = new Map<string, ToolCatalogEntry>();

export function deriveCapabilityArea(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return "misc";
  }
  const [area] = normalized.split(".");
  return area || normalized;
}

function readSchemaProperties(inputSchema: Tool["inputSchema"] | undefined): string[] {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) {
    return [];
  }
  return Object.keys(inputSchema.properties)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

export function deriveToolCatalogEntry(tool: Tool): ToolCatalogEntry {
  const capabilityArea = deriveCapabilityArea(tool.name);
  const schemaProperties = readSchemaProperties(tool.inputSchema);
  const nameParts = tokenizeText(tool.name.replace(/[._-]+/g, " "));
  const descriptionParts = tokenizeText(tool.description ?? "");
  const tags = [...new Set([capabilityArea, ...nameParts, ...schemaProperties, ...descriptionParts])].sort((left, right) =>
    left.localeCompare(right)
  );
  return {
    name: tool.name,
    description: tool.description ?? "",
    capability_area: capabilityArea,
    tags,
    schema_properties: schemaProperties,
    search_text: [tool.name, tool.description ?? "", capabilityArea, ...tags, ...schemaProperties].join(" ").toLowerCase(),
  };
}

export function registerToolCatalogEntry(tool: Tool) {
  toolCatalogRuntime.set(tool.name, deriveToolCatalogEntry(tool));
}

export function listToolCatalogEntries() {
  return [...toolCatalogRuntime.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function summarizeToolCatalog(entries = listToolCatalogEntries()) {
  const capabilityAreaCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    capabilityAreaCounts.set(entry.capability_area, (capabilityAreaCounts.get(entry.capability_area) ?? 0) + 1);
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return {
    total_count: entries.length,
    capability_area_counts: [...capabilityAreaCounts.entries()]
      .map(([capability_area, count]) => ({ capability_area, count }))
      .sort((left, right) => right.count - left.count || left.capability_area.localeCompare(right.capability_area)),
    top_tags: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
      .slice(0, 20),
  };
}

export function searchToolCatalog(params: {
  query?: string | null;
  capability_area?: string | null;
  tags?: string[];
  limit?: number;
}) {
  const queryTokens = tokenizeText(params.query ?? "");
  const capabilityArea = readString(params.capability_area)?.toLowerCase() ?? null;
  const requiredTags = normalizeStringArray(params.tags).map((entry) => entry.toLowerCase());
  const limit = clampNumber(params.limit ?? 25, 1, 200);

  const matches = listToolCatalogEntries()
    .map((entry) => {
      if (capabilityArea && entry.capability_area !== capabilityArea) {
        return null;
      }
      if (requiredTags.length > 0 && requiredTags.some((tag) => !entry.tags.includes(tag))) {
        return null;
      }
      let score = 0;
      const matchedTokens: string[] = [];
      if (queryTokens.length === 0) {
        score = 1;
      } else {
        for (const token of queryTokens) {
          if (entry.name.toLowerCase() === token) {
            score += 30;
            matchedTokens.push(token);
            continue;
          }
          if (entry.name.toLowerCase().includes(token)) {
            score += 18;
            matchedTokens.push(token);
            continue;
          }
          if (entry.tags.includes(token)) {
            score += 12;
            matchedTokens.push(token);
            continue;
          }
          if (entry.description.toLowerCase().includes(token) || entry.search_text.includes(token)) {
            score += 6;
            matchedTokens.push(token);
            continue;
          }
          return null;
        }
      }
      return {
        entry,
        score,
        matched_tokens: [...new Set(matchedTokens)],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    .slice(0, limit);

  return {
    query: readString(params.query),
    capability_area_filter: capabilityArea,
    tags_filter: requiredTags,
    count: matches.length,
    results: matches.map((match) => ({
      ...match.entry,
      score: match.score,
      matched_tokens: match.matched_tokens,
    })),
    summary: summarizeToolCatalog(matches.map((match) => match.entry)),
  };
}

export type PermissionProfileId = "read_only" | "bounded_execute" | "network_enabled" | "high_risk";
export type RiskTier = "low" | "medium" | "high" | "critical";

export type PermissionProfileRecord = {
  profile_id: PermissionProfileId;
  label: string;
  description: string;
  rank: number;
  allow_read: boolean;
  allow_write: boolean;
  allow_execute: boolean;
  allow_network: boolean;
  max_risk_tier: RiskTier;
  requires_human_approval: boolean;
  allowed_tool_prefixes: string[];
  blocked_tool_prefixes: string[];
  tags: string[];
};

export type PermissionProfilesStateRecord = {
  default_profile: PermissionProfileId;
  profiles: PermissionProfileRecord[];
  updated_at: string | null;
  source: "default" | "persisted";
};

const RISK_TIER_RANK: Record<RiskTier, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const DEFAULT_PERMISSION_PROFILES: PermissionProfileRecord[] = [
  {
    profile_id: "read_only",
    label: "Read only",
    description: "Inspect state, read artifacts, and avoid mutation, execution, or network side effects.",
    rank: 1,
    allow_read: true,
    allow_write: false,
    allow_execute: false,
    allow_network: false,
    max_risk_tier: "low",
    requires_human_approval: false,
    allowed_tool_prefixes: ["memory.", "goal.get", "goal.list", "plan.get", "plan.list", "task.list", "kernel.", "office."],
    blocked_tool_prefixes: ["task.", "goal.create", "plan.create", "plan.dispatch", "provider.bridge", "autonomy.command"],
    tags: ["read", "safe", "inspection"],
  },
  {
    profile_id: "bounded_execute",
    label: "Bounded execute",
    description: "Read and write bounded local state, create tasks, and execute non-networked local actions.",
    rank: 2,
    allow_read: true,
    allow_write: true,
    allow_execute: true,
    allow_network: false,
    max_risk_tier: "medium",
    requires_human_approval: true,
    allowed_tool_prefixes: ["goal.", "plan.", "task.", "artifact.", "run.", "operator.", "office.", "kernel.", "autonomy.maintain"],
    blocked_tool_prefixes: ["provider.bridge", "feature.flag", "worker.fabric"],
    tags: ["local", "bounded", "execute"],
  },
  {
    profile_id: "network_enabled",
    label: "Network enabled",
    description: "Bounded execution plus provider and network-facing actions with explicit operator visibility.",
    rank: 3,
    allow_read: true,
    allow_write: true,
    allow_execute: true,
    allow_network: true,
    max_risk_tier: "high",
    requires_human_approval: true,
    allowed_tool_prefixes: ["provider.", "autonomy.", "notifier.", "worker.fabric", "model.router", "feature.flag", "warm.cache"],
    blocked_tool_prefixes: [],
    tags: ["network", "provider", "execute"],
  },
  {
    profile_id: "high_risk",
    label: "High risk",
    description: "Full control-plane mutation authority for critical or destructive bounded operations.",
    rank: 4,
    allow_read: true,
    allow_write: true,
    allow_execute: true,
    allow_network: true,
    max_risk_tier: "critical",
    requires_human_approval: true,
    allowed_tool_prefixes: [],
    blocked_tool_prefixes: [],
    tags: ["critical", "operator", "destructive"],
  },
];

const DEFAULT_PERMISSION_PROFILE_BY_ID = new Map(DEFAULT_PERMISSION_PROFILES.map((entry) => [entry.profile_id, entry]));

export function normalizePermissionProfileId(value: unknown): PermissionProfileId | null {
  const normalized = readString(value)?.toLowerCase();
  return normalized === "read_only" ||
    normalized === "bounded_execute" ||
    normalized === "network_enabled" ||
    normalized === "high_risk"
    ? normalized
    : null;
}

function normalizeRiskTier(value: unknown, fallback: RiskTier): RiskTier {
  const normalized = readString(value)?.toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical"
    ? normalized
    : fallback;
}

function normalizePermissionProfileRecord(value: unknown): PermissionProfileRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const profileId = normalizePermissionProfileId(value.profile_id);
  if (!profileId) {
    return null;
  }
  const base = DEFAULT_PERMISSION_PROFILE_BY_ID.get(profileId);
  if (!base) {
    return null;
  }
  const rank = readFiniteNumber(value.rank);
  return {
    profile_id: profileId,
    label: readString(value.label) ?? base.label,
    description: readString(value.description) ?? base.description,
    rank: Math.trunc(rank ?? base.rank),
    allow_read: readBoolean(value.allow_read, base.allow_read),
    allow_write: readBoolean(value.allow_write, base.allow_write),
    allow_execute: readBoolean(value.allow_execute, base.allow_execute),
    allow_network: readBoolean(value.allow_network, base.allow_network),
    max_risk_tier: normalizeRiskTier(value.max_risk_tier, base.max_risk_tier),
    requires_human_approval: readBoolean(value.requires_human_approval, base.requires_human_approval),
    allowed_tool_prefixes: normalizeStringArray(value.allowed_tool_prefixes),
    blocked_tool_prefixes: normalizeStringArray(value.blocked_tool_prefixes),
    tags: normalizeStringArray(value.tags),
  };
}

export function getDefaultPermissionProfilesState(): PermissionProfilesStateRecord {
  return {
    default_profile: "bounded_execute",
    profiles: DEFAULT_PERMISSION_PROFILES.map((entry) => ({ ...entry })),
    updated_at: null,
    source: "default",
  };
}

export function normalizePermissionProfilesState(value: unknown, updatedAt: string | null = null): PermissionProfilesStateRecord {
  const base = getDefaultPermissionProfilesState();
  if (!isRecord(value)) {
    return base;
  }
  const profiles = new Map(base.profiles.map((entry) => [entry.profile_id, entry]));
  for (const override of Array.isArray(value.profiles) ? value.profiles : []) {
    const normalized = normalizePermissionProfileRecord(override);
    if (normalized) {
      profiles.set(normalized.profile_id, normalized);
    }
  }
  return {
    default_profile: normalizePermissionProfileId(value.default_profile) ?? base.default_profile,
    profiles: [...profiles.values()].sort((left, right) => left.rank - right.rank),
    updated_at: updatedAt,
    source: updatedAt ? "persisted" : "default",
  };
}

export function resolvePermissionProfile(
  profileId: PermissionProfileId | null | undefined,
  state: PermissionProfilesStateRecord
) {
  const normalizedProfileId = profileId ?? state.default_profile;
  return state.profiles.find((entry) => entry.profile_id === normalizedProfileId) ?? state.profiles[0];
}

export function resolveInheritedPermissionProfileId(
  state: PermissionProfilesStateRecord,
  ...candidates: unknown[]
): PermissionProfileId {
  for (const candidate of candidates) {
    const normalized = normalizePermissionProfileId(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return state.default_profile;
}

export function permissionProfileAllowsRequirement(params: {
  current_profile_id: PermissionProfileId;
  required_profile_id: PermissionProfileId;
  state: PermissionProfilesStateRecord;
}) {
  const current = resolvePermissionProfile(params.current_profile_id, params.state);
  const required = resolvePermissionProfile(params.required_profile_id, params.state);
  return current.rank >= required.rank;
}

export function permissionProfileAllowsRisk(
  profileId: PermissionProfileId,
  riskTier: RiskTier,
  state: PermissionProfilesStateRecord
) {
  const profile = resolvePermissionProfile(profileId, state);
  return RISK_TIER_RANK[profile.max_risk_tier] >= RISK_TIER_RANK[riskTier];
}

export function summarizePermissionProfiles(params: {
  state: PermissionProfilesStateRecord;
  session_profile_ids?: string[];
  task_profile_ids?: string[];
}) {
  const countProfileIds = (values: string[] | undefined) => {
    const counts = new Map<string, number>();
    for (const value of values ?? []) {
      const normalized = normalizePermissionProfileId(value) ?? params.state.default_profile;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([profile_id, count]) => ({ profile_id, count }))
      .sort((left, right) => right.count - left.count || left.profile_id.localeCompare(right.profile_id));
  };
  return {
    default_profile: params.state.default_profile,
    profiles: params.state.profiles,
    session_counts: countProfileIds(params.session_profile_ids),
    task_counts: countProfileIds(params.task_profile_ids),
    updated_at: params.state.updated_at,
    source: params.state.source,
  };
}

export type BudgetLedgerKind = "projection" | "actual" | "adjustment";

export type BudgetUsageRecord = {
  provider: string | null;
  model_id: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  projected_cost_usd: number | null;
  actual_cost_usd: number | null;
  currency: string;
  notes: string | null;
  metadata: Record<string, unknown>;
};

function readRoundedInteger(value: unknown): number | null {
  const parsed = readFiniteNumber(value);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

function readRoundedCurrency(value: unknown): number | null {
  const parsed = readFiniteNumber(value);
  return parsed === null ? null : Number(parsed.toFixed(6));
}

export function normalizeBudgetUsage(value: unknown): BudgetUsageRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const tokensInput = readRoundedInteger(value.tokens_input ?? value.input_tokens);
  const tokensOutput = readRoundedInteger(value.tokens_output ?? value.output_tokens);
  const explicitTotal = readRoundedInteger(value.tokens_total ?? value.total_tokens);
  const projectedCost = readRoundedCurrency(value.projected_cost_usd ?? value.projected_cost);
  const actualCost = readRoundedCurrency(value.actual_cost_usd ?? value.cost_usd ?? value.actual_cost);
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  return {
    provider: readString(value.provider),
    model_id: readString(value.model_id ?? value.model),
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    tokens_total: explicitTotal ?? (tokensInput !== null || tokensOutput !== null ? (tokensInput ?? 0) + (tokensOutput ?? 0) : null),
    projected_cost_usd: projectedCost,
    actual_cost_usd: actualCost,
    currency: readString(value.currency)?.toUpperCase() ?? "USD",
    notes: readString(value.notes ?? value.summary),
    metadata,
  };
}

export function extractBudgetUsage(...sources: unknown[]): BudgetUsageRecord | null {
  for (const source of sources) {
    const direct = normalizeBudgetUsage(source);
    if (direct) {
      return direct;
    }
    if (!isRecord(source)) {
      continue;
    }
    const nested = normalizeBudgetUsage(source.usage ?? source.token_usage ?? source.budget_ledger);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export type WarmCacheTargetId =
  | "office.snapshot"
  | "kernel.summary"
  | "provider.bridge.diagnostics"
  | "model.router.status"
  | "tool.catalog.summary";

export type WarmCacheStateRecord = {
  enabled: boolean;
  startup_prefetch: boolean;
  interval_seconds: number;
  ttl_seconds: number;
  thread_id: string;
  last_run_at: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  run_count: number;
  warmed_targets: WarmCacheTargetId[];
  updated_at: string | null;
  source: "default" | "persisted";
};

const DEFAULT_WARM_CACHE_TARGETS: WarmCacheTargetId[] = [
  "office.snapshot",
  "kernel.summary",
  "provider.bridge.diagnostics",
  "model.router.status",
  "tool.catalog.summary",
];

export function getDefaultWarmCacheState(): WarmCacheStateRecord {
  return {
    enabled: true,
    startup_prefetch: true,
    interval_seconds: 300,
    ttl_seconds: 180,
    thread_id: "ring-leader-main",
    last_run_at: null,
    last_error: null,
    last_duration_ms: null,
    run_count: 0,
    warmed_targets: [...DEFAULT_WARM_CACHE_TARGETS],
    updated_at: null,
    source: "default",
  };
}

export function normalizeWarmCacheState(value: unknown, updatedAt: string | null = null): WarmCacheStateRecord {
  const base = getDefaultWarmCacheState();
  if (!isRecord(value)) {
    return base;
  }
  const warmedTargets = normalizeStringArray(value.warmed_targets).filter(
    (entry): entry is WarmCacheTargetId =>
      entry === "office.snapshot" ||
      entry === "kernel.summary" ||
      entry === "provider.bridge.diagnostics" ||
      entry === "model.router.status" ||
      entry === "tool.catalog.summary"
  );
  return {
    enabled: readBoolean(value.enabled, base.enabled),
    startup_prefetch: readBoolean(value.startup_prefetch, base.startup_prefetch),
    interval_seconds: Math.round(clampNumber(readFiniteNumber(value.interval_seconds) ?? base.interval_seconds, 5, 3600)),
    ttl_seconds: Math.round(clampNumber(readFiniteNumber(value.ttl_seconds) ?? base.ttl_seconds, 5, 3600)),
    thread_id: readString(value.thread_id) ?? base.thread_id,
    last_run_at: readString(value.last_run_at),
    last_error: readString(value.last_error),
    last_duration_ms: readFiniteNumber(value.last_duration_ms),
    run_count: Math.max(0, Math.round(readFiniteNumber(value.run_count) ?? base.run_count)),
    warmed_targets: warmedTargets.length > 0 ? warmedTargets : base.warmed_targets,
    updated_at: updatedAt,
    source: updatedAt ? "persisted" : "default",
  };
}

export type FeatureFlagId =
  | "control_plane.permission_profiles"
  | "control_plane.budget_ledger"
  | "control_plane.warm_cache"
  | "operator.tool_discovery"
  | "provider.bridge.prefetch"
  | "operator.rollout_plane";

export type FeatureFlagComponent = "control_plane" | "operator" | "provider" | "autonomy";
export type FeatureFlagRolloutMode = "enabled" | "disabled" | "percentage" | "allow_list";

export type FeatureFlagRecord = {
  flag_id: FeatureFlagId;
  title: string;
  description: string;
  component: FeatureFlagComponent;
  rollout_mode: FeatureFlagRolloutMode;
  rollout_percentage: number;
  allow_entities: string[];
  updated_at: string | null;
};

export type FeatureFlagStateRecord = {
  flags: FeatureFlagRecord[];
  updated_at: string | null;
  source: "default" | "persisted";
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlagRecord[] = [
  {
    flag_id: "control_plane.permission_profiles",
    title: "Permission profiles",
    description: "Enforce durable session permission profiles across autonomy, task, and plan dispatch.",
    component: "control_plane",
    rollout_mode: "enabled",
    rollout_percentage: 100,
    allow_entities: [],
    updated_at: null,
  },
  {
    flag_id: "control_plane.budget_ledger",
    title: "Budget ledger",
    description: "Track projected and actual provider/model/task/run usage in the append-only budget ledger.",
    component: "control_plane",
    rollout_mode: "enabled",
    rollout_percentage: 100,
    allow_entities: [],
    updated_at: null,
  },
  {
    flag_id: "control_plane.warm_cache",
    title: "Warm cache lane",
    description: "Prefetch default office, kernel, provider, and router payloads on startup and maintain ticks.",
    component: "control_plane",
    rollout_mode: "enabled",
    rollout_percentage: 100,
    allow_entities: [],
    updated_at: null,
  },
  {
    flag_id: "operator.tool_discovery",
    title: "Operator tool discovery",
    description: "Expose searchable tool discovery metadata in operator-facing summaries and snapshots.",
    component: "operator",
    rollout_mode: "enabled",
    rollout_percentage: 100,
    allow_entities: [],
    updated_at: null,
  },
  {
    flag_id: "provider.bridge.prefetch",
    title: "Provider diagnostics prefetch",
    description: "Warm provider bridge diagnostics through the startup prefetch lane.",
    component: "provider",
    rollout_mode: "enabled",
    rollout_percentage: 100,
    allow_entities: [],
    updated_at: null,
  },
  {
    flag_id: "operator.rollout_plane",
    title: "Rollout plane",
    description: "Expose explicit feature-flag rollout state in operator-facing summaries.",
    component: "operator",
    rollout_mode: "enabled",
    rollout_percentage: 100,
    allow_entities: [],
    updated_at: null,
  },
];

const DEFAULT_FEATURE_FLAG_BY_ID = new Map(DEFAULT_FEATURE_FLAGS.map((entry) => [entry.flag_id, entry]));

export function normalizeFeatureFlagId(value: unknown): FeatureFlagId | null {
  const normalized = readString(value);
  return DEFAULT_FEATURE_FLAG_BY_ID.has(normalized as FeatureFlagId) ? (normalized as FeatureFlagId) : null;
}

function normalizeFeatureFlagRecord(value: unknown): FeatureFlagRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const flagId = normalizeFeatureFlagId(value.flag_id);
  if (!flagId) {
    return null;
  }
  const base = DEFAULT_FEATURE_FLAG_BY_ID.get(flagId);
  if (!base) {
    return null;
  }
  const rolloutMode = readString(value.rollout_mode)?.toLowerCase();
  return {
    flag_id: flagId,
    title: readString(value.title) ?? base.title,
    description: readString(value.description) ?? base.description,
    component:
      readString(value.component) === "operator" ||
      readString(value.component) === "provider" ||
      readString(value.component) === "autonomy"
        ? (readString(value.component) as FeatureFlagComponent)
        : base.component,
    rollout_mode:
      rolloutMode === "enabled" || rolloutMode === "disabled" || rolloutMode === "percentage" || rolloutMode === "allow_list"
        ? rolloutMode
        : base.rollout_mode,
    rollout_percentage: clampNumber(readFiniteNumber(value.rollout_percentage) ?? base.rollout_percentage, 0, 100),
    allow_entities: normalizeStringArray(value.allow_entities),
    updated_at: readString(value.updated_at),
  };
}

export function getDefaultFeatureFlagState(): FeatureFlagStateRecord {
  return {
    flags: DEFAULT_FEATURE_FLAGS.map((entry) => ({ ...entry })),
    updated_at: null,
    source: "default",
  };
}

export function normalizeFeatureFlagState(value: unknown, updatedAt: string | null = null): FeatureFlagStateRecord {
  const base = getDefaultFeatureFlagState();
  if (!isRecord(value)) {
    return base;
  }
  const flags = new Map(base.flags.map((entry) => [entry.flag_id, entry]));
  for (const override of Array.isArray(value.flags) ? value.flags : []) {
    const normalized = normalizeFeatureFlagRecord(override);
    if (normalized) {
      flags.set(normalized.flag_id, {
        ...normalized,
        updated_at: updatedAt,
      });
    }
  }
  return {
    flags: [...flags.values()].sort((left, right) => left.flag_id.localeCompare(right.flag_id)),
    updated_at: updatedAt,
    source: updatedAt ? "persisted" : "default",
  };
}

export function evaluateFeatureFlag(
  state: FeatureFlagStateRecord,
  flagId: FeatureFlagId,
  context?: {
    entity_id?: string | null;
    agent_id?: string | null;
    thread_id?: string | null;
    tags?: string[];
  }
) {
  const flag = state.flags.find((entry) => entry.flag_id === flagId) ?? getDefaultFeatureFlagState().flags.find((entry) => entry.flag_id === flagId)!;
  let enabled = false;
  let reason: string = flag.rollout_mode;
  const subject =
    readString(context?.entity_id) ??
    readString(context?.agent_id) ??
    readString(context?.thread_id) ??
    normalizeStringArray(context?.tags).join("|") ??
    "global";
  if (flag.rollout_mode === "enabled") {
    enabled = true;
  } else if (flag.rollout_mode === "disabled") {
    enabled = false;
  } else if (flag.rollout_mode === "allow_list") {
    enabled = flag.allow_entities.includes(subject);
    reason = enabled ? "allow_list_match" : "allow_list_miss";
  } else if (flag.rollout_mode === "percentage") {
    const bucket = parseInt(stableHash(`${flag.flag_id}|${subject}`).slice(0, 8), 16) % 100;
    enabled = bucket < flag.rollout_percentage;
    reason = `percentage:${bucket}<${flag.rollout_percentage}`;
  }
  return {
    flag,
    enabled,
    reason,
    subject,
  };
}

export function summarizeFeatureFlags(state: FeatureFlagStateRecord) {
  const componentCounts = new Map<FeatureFlagComponent, number>();
  let enabledCount = 0;
  let disabledCount = 0;
  for (const flag of state.flags) {
    componentCounts.set(flag.component, (componentCounts.get(flag.component) ?? 0) + 1);
    if (flag.rollout_mode === "disabled") {
      disabledCount += 1;
    } else {
      enabledCount += 1;
    }
  }
  return {
    updated_at: state.updated_at,
    source: state.source,
    total_count: state.flags.length,
    enabled_count: enabledCount,
    disabled_count: disabledCount,
    component_counts: [...componentCounts.entries()]
      .map(([component, count]) => ({ component, count }))
      .sort((left, right) => left.component.localeCompare(right.component)),
    flags: state.flags,
  };
}
