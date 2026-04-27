import { z } from "zod";
import { Storage } from "../storage.js";

const trustTierSchema = z.enum(["raw", "verified", "policy-backed", "deprecated"]);
const federatedKindSchema = z.enum(["memory", "goal", "task", "capability"]);

export const whoKnowsSchema = z.object({
  query: z.string().min(1),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  trust_tiers: z.array(trustTierSchema).optional(),
  include_notes: z.boolean().optional(),
  include_transcripts: z.boolean().optional(),
  include_federated: z.boolean().optional(),
  federated_host_ids: z.array(z.string().min(1)).max(100).optional(),
  federated_kinds: z.array(federatedKindSchema).max(10).optional(),
  federated_freshness_seconds: z.number().int().min(1).max(30 * 24 * 60 * 60).optional(),
  federated_statuses: z.array(z.string().min(1).max(80)).max(20).optional(),
  federated_trust_statuses: z.array(z.string().min(1).max(80)).max(20).optional(),
  federated_focus: z.enum(["goal", "task", "blocker", "capability"]).optional(),
  federated_provenance: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  consult: z.boolean().optional(),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeQueryTerms(query: string) {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function computeFederatedScore(text: string, query: string) {
  const haystack = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  const terms = normalizeQueryTerms(query);
  if (!haystack || !normalizedQuery || terms.length <= 0) {
    return 0;
  }
  let score = haystack.includes(normalizedQuery) ? 1.5 : 0;
  let matchedTerms = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      matchedTerms += 1;
      score += 1 / terms.length;
    }
  }
  if (!haystack.includes(normalizedQuery)) {
    if (terms.length === 1 && matchedTerms < 1) {
      return 0;
    }
    if (terms.length > 1 && matchedTerms < Math.min(2, terms.length)) {
      return 0;
    }
  }
  return score;
}

function buildFederatedSearchText(kind: z.infer<typeof federatedKindSchema>, summary: Record<string, unknown>) {
  if (kind === "memory") {
    return [readString(summary.preview), ...asList(summary.keywords).map((entry) => readString(entry)).filter(Boolean)].join(" ");
  }
  if (kind === "goal") {
    return [
      readString(summary.title),
      readString(summary.objective),
      readString(summary.status),
      ...asList(summary.tags).map((entry) => readString(entry)).filter(Boolean),
    ].join(" ");
  }
  if (kind === "capability") {
    return [
      readString(summary.capability_id),
      readString(summary.host_id),
      readString(summary.hostname),
      JSON.stringify(summary.worker_fabric ?? {}),
      JSON.stringify(summary.model_router ?? {}),
      JSON.stringify(summary.provider_bridge ?? {}),
      JSON.stringify(summary.desktop_control ?? {}),
    ].join(" ");
  }
  return [
    readString(summary.objective),
    readString(summary.status),
    readString(summary.source_agent),
    readString(summary.last_error),
  ].join(" ");
}

function normalizedSet(values: unknown[] | undefined) {
  return new Set((values ?? []).map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean));
}

function federatedFocusKinds(input: z.infer<typeof whoKnowsSchema>) {
  if (input.federated_focus === "goal") return new Set(["goal"]);
  if (input.federated_focus === "task" || input.federated_focus === "blocker") return new Set(["task"]);
  if (input.federated_focus === "capability") return new Set(["capability"]);
  return null;
}

function statusMatches(kind: z.infer<typeof federatedKindSchema>, summary: Record<string, unknown>, input: z.infer<typeof whoKnowsSchema>) {
  const statuses = normalizedSet(input.federated_statuses);
  const status = String(summary.status ?? "").trim().toLowerCase();
  if (input.federated_focus === "blocker") {
    return kind === "task" && ["blocked", "failed", "pending", "running"].includes(status);
  }
  return statuses.size === 0 || statuses.has(status);
}

function provenanceMatches(identity: Record<string, unknown>, input: z.infer<typeof whoKnowsSchema>) {
  const signature = asRecord(identity.signature_verification_result) ?? {};
  const approval = asRecord(identity.approval_scope) ?? {};
  const trustStatuses = normalizedSet(input.federated_trust_statuses);
  const signatureStatus = String(signature.status ?? "").trim().toLowerCase();
  const approvalStatus = String(approval.status ?? "").trim().toLowerCase();
  if (trustStatuses.size > 0 && !trustStatuses.has(signatureStatus) && !trustStatuses.has(approvalStatus)) {
    return false;
  }
  const provenance = String(input.federated_provenance ?? "").trim().toLowerCase();
  if (!provenance) {
    return true;
  }
  const haystack = [
    signatureStatus,
    approvalStatus,
    String(approval.matched_by ?? ""),
    String(approval.permission_profile ?? ""),
    String(identity.captured_agent_runtime ?? ""),
    String(identity.captured_model_label ?? ""),
    String(identity.captured_hostname ?? ""),
  ].join(" ").toLowerCase();
  return haystack.includes(provenance);
}

function searchFederatedSummaries(storage: Storage, input: z.infer<typeof whoKnowsSchema>, limit: number) {
  const hostFilter = normalizedSet(input.federated_host_ids);
  const explicitKindFilter = normalizedSet(input.federated_kinds);
  const focusKindFilter = federatedFocusKinds(input);
  const kindFilter = focusKindFilter ?? explicitKindFilter;
  const maxFreshnessSeconds = input.federated_freshness_seconds ?? null;
  const events = storage.listLatestFederationIngestEventsByHost({
    host_ids: [...hostFilter],
    limit: Math.max(40, limit * 20),
  });
  const nowMs = Date.now();
  const latestByHost = new Map<string, { event_id: string; created_at: string; identity: Record<string, unknown>; shared: Record<string, unknown> }>();

  for (const event of events) {
    const details = asRecord(event.details) ?? {};
    const identity =
      asRecord(details.federation_identity) ??
      ({
        captured_from_host_id: details.captured_from_host_id,
        captured_hostname: details.captured_hostname,
        captured_agent_runtime: details.captured_agent_runtime,
        captured_model_label: details.captured_model_label,
        signed_at: details.signed_at,
        received_at: details.received_at,
        signature_verification_result: details.signature_verification_result,
        approval_scope: details.approval_scope,
      } satisfies Record<string, unknown>);
    const shared = asRecord(details.shared_summaries) ?? {};
    if (readString(shared.status) !== "available") {
      continue;
    }
    const hostId =
      readString(identity.captured_from_host_id) ??
      readString(identity.requesting_host_id) ??
      readString(event.entity_id);
    if (!hostId) {
      continue;
    }
    const normalizedHostId = hostId.toLowerCase();
    if (hostFilter.size > 0 && !hostFilter.has(normalizedHostId)) {
      continue;
    }
    if (maxFreshnessSeconds !== null) {
      const receivedAt = readString(identity.received_at) ?? event.created_at;
      const receivedMs = Date.parse(receivedAt);
      if (Number.isFinite(receivedMs) && nowMs - receivedMs > maxFreshnessSeconds * 1000) {
        continue;
      }
    }
    if (!provenanceMatches(identity, input)) {
      continue;
    }
    if (!latestByHost.has(normalizedHostId)) {
      latestByHost.set(normalizedHostId, {
        event_id: event.event_id,
        created_at: event.created_at,
        identity,
        shared,
      });
    }
  }

  const matches: Array<Record<string, unknown>> = [];
  for (const [hostId, snapshot] of latestByHost.entries()) {
    const sharedKinds: Array<[z.infer<typeof federatedKindSchema>, unknown[]]> = [
      ["memory", asList(snapshot.shared.memories)],
      ["goal", asList(snapshot.shared.goals)],
      ["task", asList(snapshot.shared.tasks)],
      ["capability", asList(snapshot.shared.capabilities)],
    ];
    for (const [kind, entries] of sharedKinds) {
      if (kindFilter.size > 0 && !kindFilter.has(kind)) {
        continue;
      }
      for (const rawEntry of entries) {
        const summary = asRecord(rawEntry);
        if (!summary) {
          continue;
        }
        if (!statusMatches(kind, summary, input)) {
          continue;
        }
        const text = buildFederatedSearchText(kind, summary);
        const score = computeFederatedScore(text, input.query);
        if (score <= 0) {
          continue;
        }
        matches.push({
          type: `federated_${kind}`,
          id:
            readString(summary[`${kind}_id`]) ??
            readString(summary.capability_id) ??
            readString(summary.goal_id) ??
            readString(summary.task_id) ??
            readString(summary.memory_id) ??
            `${hostId}:${kind}:${snapshot.event_id}`,
          created_at: readString(summary.created_at) ?? snapshot.created_at,
          updated_at: readString(summary.updated_at) ?? null,
          received_at: readString(snapshot.identity.received_at) ?? snapshot.created_at,
          host_id: hostId,
          hostname: readString(snapshot.identity.captured_hostname) ?? null,
          agent_runtime: readString(snapshot.identity.captured_agent_runtime) ?? null,
          model_label: readString(snapshot.identity.captured_model_label) ?? null,
          signature_verification_result: asRecord(snapshot.identity.signature_verification_result) ?? null,
          approval_scope: asRecord(snapshot.identity.approval_scope) ?? null,
          event_id: snapshot.event_id,
          kind,
          score,
          summary,
          text,
        });
      }
    }
  }

  return matches
    .sort((a, b) => (Number(b.score ?? 0) - Number(a.score ?? 0)) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, limit);
}

export async function whoKnows(storage: Storage, input: z.infer<typeof whoKnowsSchema>) {
  const limit = input.limit ?? 10;
  const includeNotes = input.include_notes ?? true;
  const includeTranscripts = input.include_transcripts ?? true;
  const includeFederated = input.include_federated ?? false;

  const notes = includeNotes
    ? storage.searchNotes({
        query: input.query,
        tags: input.tags,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        trust_tiers: input.trust_tiers,
        limit,
      })
    : [];

  const transcripts = includeTranscripts
    ? storage.searchTranscripts({
        query: input.query,
        session_id: input.session_id,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        limit,
      })
    : [];

  const memories = includeNotes
    ? storage.searchMemories({
        query: input.query,
        limit,
      })
    : [];

  const transcriptLines = includeTranscripts
    ? storage.searchTranscriptLines({
        query: input.query,
        run_id: input.session_id,
        limit,
      })
    : [];

  const federatedSearchMatches = includeFederated ? searchFederatedSummaries(storage, input, limit) : [];

  const matches = [
    ...notes.map((note) => ({
      type: "note",
      id: note.id,
      created_at: note.created_at,
      source: note.source,
      source_client: note.source_client,
      source_model: note.source_model,
      source_agent: note.source_agent,
      trust_tier: note.trust_tier,
      score: note.score ?? 0,
      text: note.text,
    })),
    ...transcripts.map((transcript) => ({
      type: "transcript",
      id: transcript.id,
      created_at: transcript.created_at,
      session_id: transcript.session_id,
      source_client: transcript.source_client,
      source_model: transcript.source_model,
      source_agent: transcript.source_agent,
      kind: transcript.kind,
      score: transcript.score ?? 0,
      text: transcript.text,
    })),
    ...memories.map((memory) => ({
      type: "memory",
      id: memory.id,
      created_at: memory.created_at,
      last_accessed_at: memory.last_accessed_at,
      decay_score: memory.decay_score,
      keywords: memory.keywords,
      score: memory.score ?? 0,
      text: memory.content,
    })),
    ...transcriptLines.map((line) => ({
      type: "transcript_line",
      id: line.id,
      created_at: line.timestamp,
      run_id: line.run_id,
      role: line.role,
      is_squished: line.is_squished,
      score: line.score ?? 0,
      text: line.content,
    })),
    ...federatedSearchMatches,
  ]
    .sort(
      (a, b) =>
        Number(b.score ?? 0) - Number(a.score ?? 0) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
    )
    .slice(0, limit);

  return {
    local_only: !includeFederated,
    query: input.query,
    counts: {
      notes: notes.length,
      memories: memories.length,
      transcripts: transcripts.length,
      transcript_lines: transcriptLines.length,
      federated_matches: federatedSearchMatches.length,
      matches: matches.length,
    },
    consult_ignored: input.consult ? "consult flag ignored in local-only mode" : undefined,
    notes,
    memories,
    transcripts,
    transcript_lines: transcriptLines,
    federated_matches: federatedSearchMatches,
    matches,
  };
}
