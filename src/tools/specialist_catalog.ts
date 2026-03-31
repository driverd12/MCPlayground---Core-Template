import crypto from "node:crypto";
import { z } from "zod";
import {
  type DomainSpecialistRecord,
  type DomainSpecialistRegistryStateRecord,
  Storage,
} from "../storage.js";
import { type TriChatAgentDefinition, getTriChatAgent } from "../trichat_roster.js";
import { getEffectiveOrgProgram } from "./org_program.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const specialistCatalogSchema = z
  .object({
    action: z.enum(["status", "match", "ensure"]).default("status"),
    mutation: mutationSchema.optional(),
    objective: z.string().min(1).optional(),
    domain_keys: z.array(z.string().min(1)).max(32).optional(),
    auto_spawn: z.boolean().default(true),
    max_matches: z.number().int().min(1).max(32).default(6),
    minimum_score: z.number().min(0).max(1).default(0.34),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "ensure" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for ensure",
        path: ["mutation"],
      });
    }
    if ((value.action === "match" || value.action === "ensure") && !value.objective?.trim() && !(value.domain_keys?.length ?? 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "objective or domain_keys is required",
        path: ["objective"],
      });
    }
  });

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

type MatchedSpecialist = {
  specialist: DomainSpecialistRecord;
  score: number;
  learning_entry_count: number;
  local_ready: boolean;
  recommended_trichat_agent_ids: string[];
  support_agent_ids: string[];
  recommended_workstream: Record<string, unknown>;
};

const DEFAULT_SUPPORT_AGENT_IDS = ["codex", "gemini", "cursor", "claude"];

function dedupeStrings(values: readonly string[] | undefined | null) {
  return [...new Set((values ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeDomainKey(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function humanizeDomainKey(domainKey: string) {
  return domainKey
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function laneToStepKind(lane: string | null | undefined) {
  const normalized = String(lane ?? "").trim().toLowerCase();
  if (normalized === "analyst" || normalized === "research") {
    return "analysis";
  }
  if (normalized === "verifier" || normalized === "verification") {
    return "verification";
  }
  return "mutation";
}

function laneToParentAgentId(lane: string | null | undefined) {
  const normalized = String(lane ?? "").trim().toLowerCase();
  if (normalized === "analyst" || normalized === "research") {
    return "research-director";
  }
  if (normalized === "verifier" || normalized === "verification") {
    return "verification-director";
  }
  return "implementation-director";
}

function defaultSystemPrompt(input: {
  title: string;
  description: string | null;
  parent_agent_id: string | null;
  domain_key: string;
}) {
  const focus = input.description?.trim() || `Focus only on ${input.title} tasks and nothing else.`;
  return [
    `You are ${input.title}, a narrow local leaf SME for ${humanizeDomainKey(input.domain_key)}.`,
    focus,
    `Report upward to ${input.parent_agent_id ?? "ring-leader"}.`,
    "Stay narrow, avoid broad orchestration, and never volunteer work outside your domain.",
    "Prefer crisp single-owner tasks, explicit evidence, rollback notes, and bounded stop conditions.",
    "If the task goes outside your specialty, say so and hand it back up the hierarchy.",
  ].join(" ");
}

function defaultPreferredHostTags(domainKey: string) {
  switch (normalizeDomainKey(domainKey)) {
    case "docker":
      return ["container", "server", "local", "ollama"];
    case "dns":
    case "dhcp":
    case "firewall":
      return ["infra", "server", "local"];
    case "web-server":
      return ["web", "server", "local"];
    case "kubernetes":
      return ["container", "orchestration", "server", "local"];
    case "proxmox":
      return ["virtualization", "server", "local"];
    default:
      if (/\b(gpu|cuda|llm|model|training)\b/.test(domainKey)) {
        return ["gpu", "server", "local"];
      }
      return ["server", "local"];
  }
}

function buildDefaultSpecialists(): DomainSpecialistRecord[] {
  const now = new Date().toISOString();
  const raw = [
    {
      domain_key: "docker",
      title: "Docker SME",
      description: "Expert on Docker, Compose, container builds, container runtime behavior, and image hygiene.",
      lane: "implementer",
      keywords: ["docker", "docker compose", "compose.yaml", "container", "containers", "image build"],
      preferred_host_tags: defaultPreferredHostTags("docker"),
    },
    {
      domain_key: "dns",
      title: "DNS SME",
      description: "Expert on DNS servers, zones, records, resolvers, Bind, Unbound, and name resolution.",
      lane: "analyst",
      keywords: ["dns", "bind", "named", "unbound", "resolver", "zone file", "record", "cname", "mx"],
      preferred_host_tags: defaultPreferredHostTags("dns"),
    },
    {
      domain_key: "dhcp",
      title: "DHCP SME",
      description: "Expert on DHCP scopes, leases, reservations, relay, and IP assignment workflows.",
      lane: "implementer",
      keywords: ["dhcp", "dhcpd", "lease", "reservation", "relay", "scope", "ip assignment"],
      preferred_host_tags: defaultPreferredHostTags("dhcp"),
    },
    {
      domain_key: "firewall",
      title: "Firewall SME",
      description: "Expert on firewall rules, NAT, packet filtering, nftables, iptables, pf, and segmentation.",
      lane: "verifier",
      keywords: ["firewall", "iptables", "nftables", "ufw", "pf", "nat", "acl", "packet filter"],
      preferred_host_tags: defaultPreferredHostTags("firewall"),
    },
    {
      domain_key: "web-server",
      title: "Web Server SME",
      description: "Expert on Nginx, Apache, Caddy, reverse proxying, TLS termination, and virtual hosts.",
      lane: "implementer",
      keywords: ["nginx", "apache", "caddy", "reverse proxy", "virtual host", "tls", "web server"],
      preferred_host_tags: defaultPreferredHostTags("web-server"),
    },
    {
      domain_key: "kubernetes",
      title: "Kubernetes SME",
      description: "Expert on Kubernetes, Helm, manifests, service exposure, and container orchestration.",
      lane: "implementer",
      keywords: ["kubernetes", "k8s", "helm", "kubectl", "deployment", "service mesh", "ingress"],
      preferred_host_tags: defaultPreferredHostTags("kubernetes"),
    },
    {
      domain_key: "proxmox",
      title: "Proxmox SME",
      description: "Expert on Proxmox VE, LXC, QEMU VMs, storage pools, and host virtualization workflows.",
      lane: "implementer",
      keywords: ["proxmox", "pve", "lxc", "qemu", "vm", "virtual machine", "cluster node"],
      preferred_host_tags: defaultPreferredHostTags("proxmox"),
    },
  ];
  return raw.map((entry) => {
    const parentAgentId = laneToParentAgentId(entry.lane);
    const agentId = `${entry.domain_key}-sme`;
    return {
      domain_key: entry.domain_key,
      agent_id: agentId,
      role_id: agentId,
      title: entry.title,
      description: entry.description,
      lane: entry.lane,
      coordination_tier: "leaf",
      parent_agent_id: parentAgentId,
      managed_agent_ids: [],
      match_rules: {
        keywords: dedupeStrings(entry.keywords),
        tags: [entry.domain_key],
        paths: [],
      },
      routing_hints: {
        preferred_host_tags: dedupeStrings(entry.preferred_host_tags),
        required_host_tags: [],
        preferred_agent_ids: dedupeStrings([agentId, parentAgentId]),
        support_agent_ids: DEFAULT_SUPPORT_AGENT_IDS.slice(),
        preferred_model_tags: ["local", entry.domain_key],
        quality_preference: "balanced",
        local_learning_entry_target: 3,
      },
      system_prompt: defaultSystemPrompt({
        title: entry.title,
        description: entry.description,
        parent_agent_id: parentAgentId,
        domain_key: entry.domain_key,
      }),
      status: "active",
      metadata: {
        bootstrap_source: "specialist.catalog.default",
      },
      created_at: now,
      updated_at: now,
    } satisfies DomainSpecialistRecord;
  });
}

function getEffectiveRegistry(storage: Storage): DomainSpecialistRegistryStateRecord {
  const persisted = storage.getDomainSpecialistRegistryState();
  const merged = new Map<string, DomainSpecialistRecord>();
  for (const specialist of buildDefaultSpecialists()) {
    merged.set(specialist.domain_key, specialist);
  }
  for (const specialist of persisted?.specialists ?? []) {
    merged.set(specialist.domain_key, specialist);
  }
  return {
    enabled: persisted?.enabled ?? true,
    specialists: [...merged.values()].sort((left, right) => left.domain_key.localeCompare(right.domain_key)),
    updated_at: persisted?.updated_at ?? new Date().toISOString(),
  };
}

export function getDomainSpecialistAgentDefinition(storage: Storage, agentId: string | null | undefined): TriChatAgentDefinition | null {
  const normalizedAgentId = normalizeDomainKey(agentId);
  if (!normalizedAgentId) {
    return null;
  }
  const specialist = getEffectiveRegistry(storage).specialists.find(
    (entry) => entry.status === "active" && entry.agent_id === normalizedAgentId
  );
  if (!specialist) {
    return null;
  }
  return mapSpecialistToAgentDefinition(specialist);
}

function mapSpecialistToAgentDefinition(specialist: DomainSpecialistRecord): TriChatAgentDefinition {
  return {
    agent_id: specialist.agent_id,
    display_name: specialist.title,
    provider: "local",
    auth_mode: "local-model",
    role_lane: specialist.lane ?? "implementer",
    coordination_tier: specialist.coordination_tier ?? "leaf",
    parent_agent_id: specialist.parent_agent_id ?? undefined,
    managed_agent_ids: specialist.managed_agent_ids,
    accent_color: "#8ecae6",
    bridge_env_var: "TRICHAT_SPECIALIST_CMD",
    bridge_script_names: ["local-imprint_bridge.py", "local_imprint_bridge.py"],
    description: specialist.description ?? undefined,
    supports_local_model_fallback: true,
    enabled: specialist.status === "active",
    system_prompt: specialist.system_prompt,
  };
}

export function listDomainSpecialistAgentDefinitions(storage: Storage): TriChatAgentDefinition[] {
  return getEffectiveRegistry(storage).specialists
    .filter((entry) => entry.status === "active")
    .map((entry) => mapSpecialistToAgentDefinition(entry));
}

function countLearningEntries(storage: Storage, agentId: string) {
  return storage.listAgentLearningEntries({
    agent_id: agentId,
    status: "active",
    limit: 250,
  }).length;
}

function objectiveText(value: string | undefined | null) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9./:_ -]+/g, " ");
}

function scoreSpecialistMatch(specialist: DomainSpecialistRecord, objective: string) {
  const haystack = ` ${objectiveText(objective)} `;
  const keywords = specialist.match_rules.keywords;
  let score = 0;
  for (const keyword of keywords) {
    const normalizedKeyword = objectiveText(keyword).trim();
    if (!normalizedKeyword) {
      continue;
    }
    if (haystack.includes(` ${normalizedKeyword} `)) {
      score += normalizedKeyword.includes(" ") ? 0.28 : 0.18;
    } else if (haystack.includes(normalizedKeyword)) {
      score += normalizedKeyword.includes(" ") ? 0.16 : 0.1;
    }
  }
  if (haystack.includes(` ${specialist.domain_key.replace(/-/g, " ")} `)) {
    score += 0.24;
  }
  if (haystack.includes(objectiveText(specialist.title).trim())) {
    score += 0.18;
  }
  return Number(Math.min(0.99, score).toFixed(4));
}

function buildSuggestedWorkstream(specialist: DomainSpecialistRecord, objective: string): Record<string, unknown> {
  const parentAgentId = specialist.parent_agent_id ?? laneToParentAgentId(specialist.lane);
  return {
    stream_id: specialist.domain_key,
    title: `Advance the ${specialist.title} slice`,
    owner_role_id: specialist.role_id,
    executor_ref: parentAgentId || specialist.role_id,
    step_kind: laneToStepKind(specialist.lane),
    evidence_requirements: [
      `${specialist.title} produces concrete evidence tied to the objective.`,
      "Bounded proof shows the slice moved forward or failed closed.",
    ],
    rollback_notes: [
      "Keep the domain slice reversible and bounded.",
      "Escalate back to the parent director when the work leaves the specialist boundary.",
    ],
    task_metadata: {
      domain_key: specialist.domain_key,
      domain_title: specialist.title,
      specialist_agent_id: specialist.agent_id,
      specialist_parent_agent_id: parentAgentId,
      task_routing: {
        preferred_agent_ids: dedupeStrings([specialist.agent_id, parentAgentId]),
        allowed_agent_ids: dedupeStrings([specialist.agent_id, parentAgentId, "ring-leader"]),
      },
      task_execution: {
        preferred_host_tags: specialist.routing_hints.preferred_host_tags,
        required_host_tags: specialist.routing_hints.required_host_tags,
        isolation_mode: "git_worktree",
        preferred_model_tags: specialist.routing_hints.preferred_model_tags,
        quality_preference: specialist.routing_hints.quality_preference,
      },
      objective_excerpt: objective.slice(0, 240),
    },
  };
}

export function matchDomainSpecialists(
  storage: Storage,
  objective: string,
  maxMatches: number,
  minimumScore: number
): MatchedSpecialist[] {
  return getEffectiveRegistry(storage).specialists
    .filter((entry) => entry.status === "active")
    .map((specialist) => {
      const learningEntryCount = countLearningEntries(storage, specialist.agent_id);
      const localReady = learningEntryCount >= specialist.routing_hints.local_learning_entry_target;
      const score = scoreSpecialistMatch(specialist, objective);
      return {
        specialist,
        score,
        learning_entry_count: learningEntryCount,
        local_ready: localReady,
        recommended_trichat_agent_ids: dedupeStrings([specialist.parent_agent_id ?? "", specialist.agent_id]),
        support_agent_ids: localReady ? [] : specialist.routing_hints.support_agent_ids,
        recommended_workstream: buildSuggestedWorkstream(specialist, objective),
      } satisfies MatchedSpecialist;
    })
    .filter((entry) => entry.score >= minimumScore)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.specialist.domain_key.localeCompare(right.specialist.domain_key);
    })
    .slice(0, maxMatches);
}

function buildGenericSpecialist(domainKey: string): DomainSpecialistRecord {
  const now = new Date().toISOString();
  const title = `${humanizeDomainKey(domainKey)} SME`;
  const parentAgentId = "implementation-director";
  const agentId = `${domainKey}-sme`;
  return {
    domain_key: domainKey,
    agent_id: agentId,
    role_id: agentId,
    title,
    description: `Expert on ${humanizeDomainKey(domainKey)} and nothing else.`,
    lane: "implementer",
    coordination_tier: "leaf",
    parent_agent_id: parentAgentId,
    managed_agent_ids: [],
    match_rules: {
      keywords: [domainKey.replace(/-/g, " "), domainKey],
      tags: [domainKey],
      paths: [],
    },
    routing_hints: {
      preferred_host_tags: defaultPreferredHostTags(domainKey),
      required_host_tags: [],
      preferred_agent_ids: [agentId, parentAgentId],
      support_agent_ids: DEFAULT_SUPPORT_AGENT_IDS.slice(),
      preferred_model_tags: ["local", domainKey],
      quality_preference: "balanced",
      local_learning_entry_target: 3,
    },
    system_prompt: defaultSystemPrompt({
      title,
      description: `Focus only on ${humanizeDomainKey(domainKey)} tasks and escalate everything else.`,
      parent_agent_id: parentAgentId,
      domain_key: domainKey,
    }),
    status: "active",
    metadata: {
      bootstrap_source: "specialist.catalog.generic",
    },
    created_at: now,
    updated_at: now,
  };
}

function deriveExplicitDomainKeys(input: z.infer<typeof specialistCatalogSchema>) {
  return dedupeStrings(input.domain_keys).map((entry) => normalizeDomainKey(entry)).filter(Boolean);
}

function buildOrgProgramVersion(specialist: DomainSpecialistRecord) {
  return {
    summary: `${specialist.title} doctrine for narrow ${specialist.domain_key} execution`,
    doctrine: specialist.system_prompt,
    delegation_contract: `Only invoke ${specialist.agent_id} when the objective clearly matches ${specialist.domain_key}. Keep work bounded, evidence-backed, and escalated back to ${specialist.parent_agent_id ?? "ring-leader"} when it leaves the specialty.`,
    evaluation_standard: `${specialist.title} succeeds only when it stays inside domain boundaries, names concrete evidence, and fails closed when confidence is weak.`,
    status: "active" as const,
    metadata: {
      domain_key: specialist.domain_key,
      coordination_tier: specialist.coordination_tier,
      parent_agent_id: specialist.parent_agent_id,
    },
  };
}

export async function specialistCatalog(
  storage: Storage,
  invokeTool: InvokeTool,
  input: z.infer<typeof specialistCatalogSchema>
) {
  const executeStatus = () => {
    const state = getEffectiveRegistry(storage);
    return {
      ok: true,
      state,
      specialist_count: state.specialists.length,
      active_specialist_count: state.specialists.filter((entry) => entry.status === "active").length,
      local_ready_specialist_count: state.specialists.filter(
        (entry) => countLearningEntries(storage, entry.agent_id) >= entry.routing_hints.local_learning_entry_target
      ).length,
    };
  };

  if (input.action === "status") {
    return executeStatus();
  }

  if (input.action === "match") {
    const objective = input.objective?.trim() || deriveExplicitDomainKeys(input).join(" ");
    const matched = matchDomainSpecialists(storage, objective, input.max_matches, input.minimum_score);
    return {
      ok: true,
      objective,
      matched_domains: matched.map((entry) => ({
        ...entry.specialist,
        score: entry.score,
        learning_entry_count: entry.learning_entry_count,
        local_ready: entry.local_ready,
      })),
      recommended_trichat_agent_ids: dedupeStrings(matched.flatMap((entry) => entry.recommended_trichat_agent_ids)),
      support_agent_ids: dedupeStrings(matched.flatMap((entry) => entry.support_agent_ids)),
      recommended_workstreams: matched.map((entry) => entry.recommended_workstream),
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "specialist.catalog",
    mutation: input.mutation!,
    payload: input,
    execute: async () => {
      const current = getEffectiveRegistry(storage);
      const explicitDomainKeys = deriveExplicitDomainKeys(input);
      const objective = input.objective?.trim() || explicitDomainKeys.join(" ");
      const matched = objective
        ? matchDomainSpecialists(storage, objective, input.max_matches, input.minimum_score)
        : [];
      const requestedDomainKeys = dedupeStrings([
        ...explicitDomainKeys,
        ...matched.map((entry) => entry.specialist.domain_key),
      ]);
      const nextByDomain = new Map(current.specialists.map((entry) => [entry.domain_key, entry]));
      const ensured: DomainSpecialistRecord[] = [];

      for (const domainKey of requestedDomainKeys) {
        const specialist = nextByDomain.get(domainKey) ?? buildGenericSpecialist(domainKey);
        if (input.auto_spawn !== false) {
          nextByDomain.set(domainKey, {
            ...specialist,
            status: "active",
            updated_at: new Date().toISOString(),
          });
          ensured.push(nextByDomain.get(domainKey)!);
        }
      }

      const persisted = storage.setDomainSpecialistRegistryState({
        enabled: true,
        specialists: [...nextByDomain.values()],
      });

      for (const specialist of ensured) {
        const existing = getEffectiveOrgProgram(storage, specialist.role_id);
        await invokeTool("org.program", {
          action: "upsert_role",
          mutation: {
            idempotency_key: `specialist-org-${specialist.domain_key}-${crypto.randomUUID().slice(0, 8)}`,
            side_effect_fingerprint: `specialist-org-${specialist.domain_key}-${crypto.randomUUID().slice(0, 8)}`,
          },
          role_id: specialist.role_id,
          title: specialist.title,
          description: specialist.description ?? `${specialist.title} role`,
          lane: specialist.lane ?? "implementer",
          version: existing?.version ?? buildOrgProgramVersion(specialist),
          enabled: true,
          source_client: input.source_client ?? "specialist.catalog",
          source_model: input.source_model,
          source_agent: input.source_agent ?? "ring-leader",
        });
      }

      const nextMatched = objective
        ? matchDomainSpecialists(storage, objective, input.max_matches, input.minimum_score)
        : [];

      return {
        ok: true,
        objective,
        state: persisted,
        ensured_specialists: ensured,
        matched_domains: nextMatched.map((entry) => ({
          ...entry.specialist,
          score: entry.score,
          learning_entry_count: entry.learning_entry_count,
          local_ready: entry.local_ready,
        })),
        recommended_trichat_agent_ids: dedupeStrings(nextMatched.flatMap((entry) => entry.recommended_trichat_agent_ids)),
        support_agent_ids: dedupeStrings(nextMatched.flatMap((entry) => entry.support_agent_ids)),
        recommended_workstreams: nextMatched.map((entry) => entry.recommended_workstream),
      };
    },
  });
}
