import { z } from "zod";
import { Storage, type AgentLearningEntryRecord } from "../storage.js";

const agentLearningStatusValues = ["active", "suppressed"] as const;
const agentLearningKindValues = [
  "execution_pattern",
  "delegation_pattern",
  "verification_pattern",
  "failure_pattern",
  "guardrail",
] as const;
const agentLearningPolarityValues = ["prefer", "avoid"] as const;

const agentLearningStatusSchema = z.enum(agentLearningStatusValues);
const agentLearningKindSchema = z.enum(agentLearningKindValues);
const agentLearningPolaritySchema = z.enum(agentLearningPolarityValues);

export const agentLearningListSchema = z.object({
  agent_id: z.string().min(1).optional(),
  status: agentLearningStatusSchema.optional(),
  lesson_kind: agentLearningKindSchema.optional(),
  polarity: agentLearningPolaritySchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const agentLearningSummarySchema = z.object({
  agent_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  top_agents_limit: z.number().int().min(1).max(25).optional(),
  recent_limit: z.number().int().min(1).max(25).optional(),
});

type AgentLearningOverviewInput = {
  agent_id?: string;
  limit?: number;
  top_agents_limit?: number;
  recent_limit?: number;
};

type AgentLearningAgentSummary = {
  agent_id: string;
  total_entries: number;
  active_entry_count: number;
  suppressed_entry_count: number;
  prefer_count: number;
  avoid_count: number;
  latest_updated_at: string | null;
  strongest_weight: number;
  top_summaries: string[];
};

export type AgentLearningOverview = {
  generated_at: string;
  filter: {
    agent_id: string | null;
  };
  total_entries: number;
  active_entry_count: number;
  suppressed_entry_count: number;
  prefer_count: number;
  avoid_count: number;
  agent_count: number;
  agents_with_active_entries: number;
  kind_counts: Record<(typeof agentLearningKindValues)[number], number>;
  top_agents: AgentLearningAgentSummary[];
  recent_entries: Array<{
    entry_id: string;
    agent_id: string;
    updated_at: string;
    status: (typeof agentLearningStatusValues)[number];
    lesson_kind: (typeof agentLearningKindValues)[number];
    polarity: (typeof agentLearningPolarityValues)[number];
    summary: string;
    confidence: number | null;
    weight: number;
  }>;
};

function compactSummary(value: string, limit = 96): string {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function compareIsoDesc(left: string | null, right: string | null) {
  if ((left ?? "") === (right ?? "")) {
    return 0;
  }
  return (right ?? "").localeCompare(left ?? "");
}

function summarizeAgent(entry: AgentLearningEntryRecord[]): AgentLearningAgentSummary {
  const first = entry[0];
  const active = entry.filter((item) => item.status === "active");
  const topSummaries = [...new Set(
    active
      .slice()
      .sort((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return compareIsoDesc(left.updated_at, right.updated_at);
      })
      .map((item) => compactSummary(item.summary, 88))
      .filter(Boolean)
  )]
    .slice(0, 3);
  const latestUpdatedAt = entry.reduce<string | null>(
    (latest, item) => (!latest || item.updated_at > latest ? item.updated_at : latest),
    null
  );
  return {
    agent_id: first?.agent_id ?? "unknown",
    total_entries: entry.length,
    active_entry_count: active.length,
    suppressed_entry_count: entry.length - active.length,
    prefer_count: entry.filter((item) => item.polarity === "prefer").length,
    avoid_count: entry.filter((item) => item.polarity === "avoid").length,
    latest_updated_at: latestUpdatedAt,
    strongest_weight: entry.reduce((best, item) => Math.max(best, item.weight), 0),
    top_summaries: topSummaries,
  };
}

export function summarizeAgentLearningEntries(
  entries: AgentLearningEntryRecord[],
  input: {
    agent_id?: string;
    top_agents_limit?: number;
    recent_limit?: number;
  } = {}
): AgentLearningOverview {
  const topAgentsLimit = Math.max(1, Math.min(25, input.top_agents_limit ?? 6));
  const recentLimit = Math.max(1, Math.min(25, input.recent_limit ?? 8));
  const byKind: AgentLearningOverview["kind_counts"] = {
    execution_pattern: 0,
    delegation_pattern: 0,
    verification_pattern: 0,
    failure_pattern: 0,
    guardrail: 0,
  };
  const grouped = new Map<string, AgentLearningEntryRecord[]>();
  let activeEntryCount = 0;
  let suppressedEntryCount = 0;
  let preferCount = 0;
  let avoidCount = 0;

  for (const entry of entries) {
    grouped.set(entry.agent_id, [...(grouped.get(entry.agent_id) ?? []), entry]);
    byKind[entry.lesson_kind] += 1;
    if (entry.status === "active") {
      activeEntryCount += 1;
    } else {
      suppressedEntryCount += 1;
    }
    if (entry.polarity === "prefer") {
      preferCount += 1;
    } else {
      avoidCount += 1;
    }
  }

  const topAgents = [...grouped.values()]
    .map((items) => summarizeAgent(items))
    .sort((left, right) => {
      if (right.active_entry_count !== left.active_entry_count) {
        return right.active_entry_count - left.active_entry_count;
      }
      if (right.strongest_weight !== left.strongest_weight) {
        return right.strongest_weight - left.strongest_weight;
      }
      if ((right.latest_updated_at ?? "") !== (left.latest_updated_at ?? "")) {
        return compareIsoDesc(left.latest_updated_at, right.latest_updated_at);
      }
      return left.agent_id.localeCompare(right.agent_id);
    })
    .slice(0, topAgentsLimit);

  const recentEntries = entries
    .slice()
    .sort((left, right) => compareIsoDesc(left.updated_at, right.updated_at))
    .slice(0, recentLimit)
    .map((entry) => ({
      entry_id: entry.entry_id,
      agent_id: entry.agent_id,
      updated_at: entry.updated_at,
      status: entry.status,
      lesson_kind: entry.lesson_kind,
      polarity: entry.polarity,
      summary: compactSummary(entry.summary, 120),
      confidence: entry.confidence,
      weight: entry.weight,
    }));

  return {
    generated_at: new Date().toISOString(),
    filter: {
      agent_id: input.agent_id?.trim() || null,
    },
    total_entries: entries.length,
    active_entry_count: activeEntryCount,
    suppressed_entry_count: suppressedEntryCount,
    prefer_count: preferCount,
    avoid_count: avoidCount,
    agent_count: grouped.size,
    agents_with_active_entries: [...grouped.values()].filter((items) => items.some((entry) => entry.status === "active"))
      .length,
    kind_counts: byKind,
    top_agents: topAgents,
    recent_entries: recentEntries,
  };
}

export function buildAgentLearningOverview(storage: Storage, input: AgentLearningOverviewInput = {}): AgentLearningOverview {
  const entries = storage.listAgentLearningEntries({
    agent_id: input.agent_id,
    limit: Math.max(1, Math.min(500, input.limit ?? 250)),
  });
  return summarizeAgentLearningEntries(entries, input);
}

export function listAgentLearning(storage: Storage, input: z.infer<typeof agentLearningListSchema>) {
  const entries = storage.listAgentLearningEntries({
    agent_id: input.agent_id,
    status: input.status,
    lesson_kind: input.lesson_kind,
    polarity: input.polarity,
    limit: input.limit ?? 25,
  });
  return {
    count: entries.length,
    entries,
  };
}

export function summarizeAgentLearning(storage: Storage, input: z.infer<typeof agentLearningSummarySchema>) {
  return buildAgentLearningOverview(storage, input);
}
