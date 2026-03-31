import { z } from "zod";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const riskTierSchema = z.enum(["low", "medium", "high", "critical"]);
const swarmTopologySchema = z.enum(["hierarchical", "mesh", "ring", "star", "adaptive"]);
const swarmConsensusSchema = z.enum(["majority", "weighted", "escalating"]);
const swarmQueenModeSchema = z.enum(["strategic", "tactical", "adaptive"]);
const swarmCheckpointCadenceSchema = z.enum(["milestone", "phase", "step"]);

const swarmWorkstreamSchema = z.object({
  stream_id: z.string().min(1).optional(),
  title: z.string().min(1),
  owner_role_id: z.string().min(1).optional(),
  executor_ref: z.string().min(1).optional(),
  step_kind: z.enum(["analysis", "mutation", "verification", "decision", "handoff"]).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  evidence_requirements: z.array(z.string().min(1)).optional(),
  rollback_notes: z.array(z.string().min(1)).optional(),
  task_metadata: recordSchema.optional(),
});

export const swarmProfileSchema = z.object({
  objective: z.string().min(1),
  risk_tier: riskTierSchema.optional(),
  matched_domains: z.array(z.string().min(1)).optional(),
  routed_bridge_agent_ids: z.array(z.string().min(1)).optional(),
  trichat_agent_ids: z.array(z.string().min(1)).optional(),
  workstreams: z.array(swarmWorkstreamSchema).optional(),
  budget: recordSchema.optional(),
  ...sourceSchema.shape,
});

export type SwarmTopology = z.infer<typeof swarmTopologySchema>;
export type SwarmConsensusMode = z.infer<typeof swarmConsensusSchema>;
export type SwarmQueenMode = z.infer<typeof swarmQueenModeSchema>;
export type SwarmCheckpointCadence = z.infer<typeof swarmCheckpointCadenceSchema>;

export type SwarmProfileRecord = {
  profile_id: string;
  topology: SwarmTopology;
  consensus_mode: SwarmConsensusMode;
  queen_mode: SwarmQueenMode;
  execution_mode: "director-fanout" | "peer-mesh" | "sequential-handoff" | "hub-spoke" | "adaptive-failover";
  memory_preflight: {
    tool_name: "retrieval.hybrid";
    query: string;
    limit: number;
    required: boolean;
  };
  checkpoint_policy: {
    enabled: true;
    cadence: SwarmCheckpointCadence;
    interval_steps: number;
    max_staleness_minutes: number;
    artifact_type: "swarm.checkpoint";
    phases: string[];
  };
  coordination: {
    fanout_target: number;
    supervisor_required: boolean;
    local_first_bias: boolean;
    bridge_advisory_count: number;
  };
  rationale: string[];
  drift_guardrails: string[];
};

export type SwarmMemoryPreflightSummary = {
  query: string;
  strategy: string;
  match_count: number;
  top_matches: Array<{
    type: string;
    id: string;
    score: number | null;
    text_preview: string;
    citation: Record<string, unknown>;
  }>;
};

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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeWorkstreams(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => swarmWorkstreamSchema.safeParse(entry))
    .filter((result): result is { success: true; data: z.infer<typeof swarmWorkstreamSchema> } => result.success)
    .map((result) => result.data);
}

function compactText(value: string, limit: number) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function buildMemoryQuery(objective: string, matchedDomains: string[]) {
  const stopwords = new Set([
    "about",
    "after",
    "allow",
    "before",
    "between",
    "bound",
    "bounded",
    "carry",
    "change",
    "complete",
    "drive",
    "during",
    "ensure",
    "execute",
    "explicit",
    "flow",
    "from",
    "goal",
    "have",
    "into",
    "keep",
    "morning",
    "operator",
    "plan",
    "prepare",
    "should",
    "that",
    "then",
    "this",
    "tomorrow",
    "with",
  ]);
  const objectiveKeywords = objective
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3 && !stopwords.has(entry));
  const rankedKeywords = [...new Set([...matchedDomains.map((entry) => entry.toLowerCase()), ...objectiveKeywords])];
  const primary = rankedKeywords[0] ?? "";
  return compactText(primary || objective, 40);
}

export function summarizeMemoryPreflight(result: unknown, fallbackQuery: string): SwarmMemoryPreflightSummary {
  const record = isRecord(result) ? result : {};
  const query = readString(record.query) ?? fallbackQuery;
  const strategy = readString(record.strategy) ?? "unknown";
  const matches = Array.isArray(record.matches) ? record.matches : [];
  return {
    query,
    strategy,
    match_count: matches.length,
    top_matches: matches.slice(0, 3).flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const idValue = entry.id;
      const id =
        typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : cryptoSafeId(entry.citation);
      return [
        {
          type: readString(entry.type) ?? "unknown",
          id,
          score: typeof entry.score === "number" && Number.isFinite(entry.score) ? Number(entry.score.toFixed(4)) : null,
          text_preview: compactText(String(entry.text ?? ""), 140),
          citation: isRecord(entry.citation) ? entry.citation : {},
        },
      ];
    }),
  };
}

function cryptoSafeId(value: unknown) {
  if (!isRecord(value)) {
    return "unknown";
  }
  const entityType = readString(value.entity_type) ?? "entity";
  const entityId = readString(value.entity_id) ?? "unknown";
  return `${entityType}:${entityId}`;
}

export function resolveSwarmProfile(input: z.infer<typeof swarmProfileSchema>): SwarmProfileRecord {
  const workstreams = normalizeWorkstreams(input.workstreams);
  const matchedDomains = normalizeStringArray(input.matched_domains);
  const routedBridgeAgentIds = normalizeStringArray(input.routed_bridge_agent_ids);
  const explicitAgentIds = normalizeStringArray(input.trichat_agent_ids);
  const streamCount = Math.max(1, workstreams.length);
  const dependencyCount = workstreams.reduce((sum, stream) => sum + (stream.depends_on?.length ?? 0), 0);
  const sequentialHandOff =
    streamCount >= 3 && dependencyCount >= Math.max(1, streamCount - 1) && workstreams.filter((stream) => (stream.depends_on?.length ?? 0) > 0).length >= 2;
  const analysisCount = workstreams.filter((stream) => stream.step_kind === "analysis").length;
  const mutationCount = workstreams.filter((stream) => stream.step_kind === "mutation").length;
  const verificationCount = workstreams.filter((stream) => stream.step_kind === "verification" || stream.step_kind === "decision").length;
  const bridgeCount = routedBridgeAgentIds.length;
  const riskTier = input.risk_tier ?? "medium";

  let topology: SwarmTopology = "hierarchical";
  let consensusMode: SwarmConsensusMode = "weighted";
  let queenMode: SwarmQueenMode = "tactical";
  let executionMode: SwarmProfileRecord["execution_mode"] = "director-fanout";
  const rationale: string[] = [];

  if ((riskTier === "high" || riskTier === "critical") && (streamCount >= 4 || bridgeCount >= 2)) {
    topology = "adaptive";
    consensusMode = "escalating";
    queenMode = "adaptive";
    executionMode = "adaptive-failover";
    rationale.push("High-risk or multi-provider work benefits from adaptive fallback rather than a single static hierarchy.");
  } else if (analysisCount >= Math.max(2, mutationCount) && streamCount >= 3) {
    topology = "mesh";
    consensusMode = "majority";
    queenMode = "strategic";
    executionMode = "peer-mesh";
    rationale.push("Research-heavy work benefits from multiple peers exploring in parallel before convergence.");
  } else if (sequentialHandOff && verificationCount > 0) {
    topology = "ring";
    consensusMode = "weighted";
    queenMode = "tactical";
    executionMode = "sequential-handoff";
    rationale.push("Strong dependency chains are safer when each bounded slice hands off explicitly to the next.");
  } else if (streamCount <= 2 && bridgeCount === 0 && explicitAgentIds.length <= 3) {
    topology = "star";
    consensusMode = "majority";
    queenMode = "tactical";
    executionMode = "hub-spoke";
    rationale.push("Small bounded work stays cheapest and easiest to supervise through a ring-leader hub.");
  } else {
    rationale.push("Defaulting to hierarchical fan-out keeps owner contracts explicit while still allowing specialist delegation.");
  }

  if (matchedDomains.length > 0) {
    rationale.push(`Matched specialist domains detected: ${matchedDomains.slice(0, 4).join(", ")}.`);
  }
  if (bridgeCount > 0) {
    rationale.push(`Bridge-capable advisory agents are available: ${routedBridgeAgentIds.slice(0, 4).join(", ")}.`);
  }

  const checkpointCadence: SwarmCheckpointCadence =
    topology === "adaptive" || riskTier === "critical"
      ? "step"
      : topology === "mesh" || topology === "hierarchical"
        ? "phase"
        : "milestone";
  const intervalSteps = checkpointCadence === "step" ? 1 : checkpointCadence === "phase" ? 2 : 3;
  const maxStalenessMinutes =
    checkpointCadence === "step" ? 10 : checkpointCadence === "phase" ? 20 : 30;
  const memoryQuery = buildMemoryQuery(input.objective, matchedDomains);
  const memoryLimit = topology === "adaptive" || topology === "mesh" ? 8 : 5;

  return {
    profile_id: `${topology}:${consensusMode}:${checkpointCadence}`,
    topology,
    consensus_mode: consensusMode,
    queen_mode: queenMode,
    execution_mode: executionMode,
    memory_preflight: {
      tool_name: "retrieval.hybrid",
      query: memoryQuery,
      limit: memoryLimit,
      required: true,
    },
    checkpoint_policy: {
      enabled: true,
      cadence: checkpointCadence,
      interval_steps: intervalSteps,
      max_staleness_minutes: maxStalenessMinutes,
      artifact_type: "swarm.checkpoint",
      phases: ["intake", "plan-compiled", "execution-started", "recovery"],
    },
    coordination: {
      fanout_target:
        topology === "mesh"
          ? Math.min(6, Math.max(3, streamCount))
          : topology === "adaptive"
            ? Math.min(8, Math.max(4, streamCount + bridgeCount))
            : Math.min(4, Math.max(2, streamCount)),
      supervisor_required: topology !== "mesh" || riskTier !== "low",
      local_first_bias: bridgeCount === 0 || topology !== "mesh",
      bridge_advisory_count: bridgeCount,
    },
    rationale,
    drift_guardrails: [
      "Re-check bounded evidence before escalating confidence across the hierarchy.",
      "Prefer local-first execution unless routed bridge agents materially improve the task fit.",
      "Checkpoint plan state whenever ownership, topology, or execution intent changes.",
    ],
  };
}

export function swarmProfile(input: z.infer<typeof swarmProfileSchema>) {
  return {
    ok: true,
    profile: resolveSwarmProfile(input),
  };
}
