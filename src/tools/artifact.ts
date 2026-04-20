import { z } from "zod";
import { type ArtifactRecord, Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const artifactStatusSchema = z.enum(["active", "superseded", "invalid", "archived"]);
const artifactTrustTierSchema = z.enum(["raw", "derived", "verified", "policy-backed", "deprecated"]);

const entityRefSchema = z.object({
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
});

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const artifactRecordSchema = z
  .object({
    mutation: mutationSchema,
    artifact_id: z.string().min(1).max(200).optional(),
    artifact_type: z.string().min(1),
    status: artifactStatusSchema.optional(),
    goal_id: z.string().min(1).optional(),
    plan_id: z.string().min(1).optional(),
    step_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    turn_id: z.string().min(1).optional(),
    pack_id: z.string().min(1).optional(),
    producer_kind: z.enum(["tool", "worker", "verifier", "planner", "human", "system"]),
    producer_id: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    content_text: z.string().optional(),
    content_json: z.record(z.unknown()).optional(),
    hash: z.string().min(1).optional(),
    trust_tier: artifactTrustTierSchema.optional(),
    freshness_expires_at: z.string().optional(),
    supersedes_artifact_id: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
    related_entities: z
      .array(
        z.object({
          entity_type: z.string().min(1),
          entity_id: z.string().min(1),
          relation: z.string().min(1).optional(),
        })
      )
      .optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (!value.uri && !value.content_text && !value.content_json) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uri, content_text, or content_json is required",
        path: ["content_text"],
      });
    }
  });

export const artifactGetSchema = z.object({
  artifact_id: z.string().min(1),
});

export const artifactListSchema = z
  .object({
    artifact_type: z.string().min(1).optional(),
    trust_tier: artifactTrustTierSchema.optional(),
    goal_id: z.string().min(1).optional(),
    plan_id: z.string().min(1).optional(),
    step_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    turn_id: z.string().min(1).optional(),
    pack_id: z.string().min(1).optional(),
    linked_entity: entityRefSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.linked_entity && !value.linked_entity.entity_type.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "linked_entity.entity_type is required",
        path: ["linked_entity", "entity_type"],
      });
    }
  });

export const artifactLinkSchema = z
  .object({
    mutation: mutationSchema,
    src_artifact_id: z.string().min(1),
    dst_artifact_id: z.string().min(1).optional(),
    dst_entity: entityRefSchema.optional(),
    relation: z.enum(["derived_from", "verifies", "invalidates", "supports", "references", "supersedes", "attached_to"]),
    rationale: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (!value.dst_artifact_id && !value.dst_entity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dst_artifact_id or dst_entity is required",
        path: ["dst_artifact_id"],
      });
    }
  });

export const artifactBundleSchema = z
  .object({
    artifact_id: z.string().min(1).optional(),
    entity: entityRefSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.artifact_id && !value.entity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifact_id or entity is required",
        path: ["artifact_id"],
      });
    }
  });

function collectRelatedArtifactIds(links: Array<{ src_artifact_id: string; dst_artifact_id: string | null }>, anchorId: string) {
  const related = new Set<string>();
  for (const link of links) {
    if (link.src_artifact_id !== anchorId) {
      related.add(link.src_artifact_id);
    }
    if (link.dst_artifact_id && link.dst_artifact_id !== anchorId) {
      related.add(link.dst_artifact_id);
    }
  }
  return [...related];
}

function readLatestRouterSuppression(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractArtifactLatestRouterSuppression(artifact: ArtifactRecord | null): Record<string, unknown> | null {
  if (!artifact) {
    return null;
  }
  return (
    readLatestRouterSuppression((artifact.content_json as Record<string, unknown> | null)?.latest_router_suppression) ??
    readLatestRouterSuppression((artifact.metadata as Record<string, unknown> | null)?.latest_router_suppression)
  );
}

function resolveArtifactsLatestRouterSuppression(artifacts: ArtifactRecord[]) {
  const ordered = [...artifacts].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  for (const artifact of ordered) {
    const snapshot = extractArtifactLatestRouterSuppression(artifact);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

function artifactScopeFiltersForEntity(entityType: string, entityId: string): Record<string, string> | null {
  switch (entityType) {
    case "goal":
      return { goal_id: entityId };
    case "plan":
      return { plan_id: entityId };
    case "step":
      return { step_id: entityId };
    case "task":
      return { task_id: entityId };
    case "run":
      return { run_id: entityId };
    case "thread":
      return { thread_id: entityId };
    case "turn":
      return { turn_id: entityId };
    default:
      return null;
  }
}

export async function artifactRecord(storage: Storage, input: z.infer<typeof artifactRecordSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "artifact.record",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const recorded = storage.recordArtifact({
        artifact_id: input.artifact_id,
        artifact_type: input.artifact_type,
        status: input.status,
        goal_id: input.goal_id,
        plan_id: input.plan_id,
        step_id: input.step_id,
        task_id: input.task_id,
        run_id: input.run_id,
        thread_id: input.thread_id,
        turn_id: input.turn_id,
        pack_id: input.pack_id,
        producer_kind: input.producer_kind,
        producer_id: input.producer_id,
        uri: input.uri,
        content_text: input.content_text,
        content_json: input.content_json,
        hash: input.hash,
        trust_tier: input.trust_tier,
        freshness_expires_at: input.freshness_expires_at,
        supersedes_artifact_id: input.supersedes_artifact_id,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const createdLinks = [];
      if (input.supersedes_artifact_id) {
        const link = storage.linkArtifact({
          src_artifact_id: recorded.artifact.artifact_id,
          dst_artifact_id: input.supersedes_artifact_id,
          relation: "supersedes",
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        createdLinks.push(link.link);
      }
      for (const related of input.related_entities ?? []) {
        const link = storage.linkArtifact({
          src_artifact_id: recorded.artifact.artifact_id,
          dst_entity_type: related.entity_type,
          dst_entity_id: related.entity_id,
          relation: related.relation ?? "attached_to",
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        createdLinks.push(link.link);
      }
      const event = storage.appendRuntimeEvent({
        event_type: "artifact.recorded",
        entity_type: "artifact",
        entity_id: recorded.artifact.artifact_id,
        status: recorded.artifact.status,
        summary: `artifact ${recorded.artifact.artifact_type} recorded`,
        details: {
          artifact_type: recorded.artifact.artifact_type,
          goal_id: recorded.artifact.goal_id,
          plan_id: recorded.artifact.plan_id,
          step_id: recorded.artifact.step_id,
          task_id: recorded.artifact.task_id,
          run_id: recorded.artifact.run_id,
          links_created: createdLinks.length,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ...recorded,
        links_created: createdLinks.length,
        links: createdLinks,
        event,
      };
    },
  });
}

export function artifactGet(storage: Storage, input: z.infer<typeof artifactGetSchema>) {
  const artifact = storage.getArtifactById(input.artifact_id);
  if (!artifact) {
    return {
      found: false,
      artifact_id: input.artifact_id,
    };
  }
  const links = storage.listArtifactLinks({
    artifact_id: input.artifact_id,
    limit: 500,
  });
  const relatedArtifactIds = collectRelatedArtifactIds(links, input.artifact_id);
  const relatedArtifacts = relatedArtifactIds
    .map((artifactId) => storage.getArtifactById(artifactId))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return {
    found: true,
    artifact,
    latest_router_suppression: extractArtifactLatestRouterSuppression(artifact),
    link_count: links.length,
    links,
    related_artifacts: relatedArtifacts,
  };
}

export function artifactList(storage: Storage, input: z.infer<typeof artifactListSchema>) {
  const artifacts = storage.listArtifacts({
    artifact_type: input.artifact_type,
    trust_tier: input.trust_tier,
    goal_id: input.goal_id,
    plan_id: input.plan_id,
    step_id: input.step_id,
    task_id: input.task_id,
    run_id: input.run_id,
    thread_id: input.thread_id,
    turn_id: input.turn_id,
    pack_id: input.pack_id,
    linked_entity_type: input.linked_entity?.entity_type,
    linked_entity_id: input.linked_entity?.entity_id,
    limit: input.limit ?? 100,
  });
  return {
    artifact_type_filter: input.artifact_type ?? null,
    trust_tier_filter: input.trust_tier ?? null,
    linked_entity_filter: input.linked_entity ?? null,
    count: artifacts.length,
    artifacts,
  };
}

export async function artifactLink(storage: Storage, input: z.infer<typeof artifactLinkSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "artifact.link",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const linked = storage.linkArtifact({
        src_artifact_id: input.src_artifact_id,
        dst_artifact_id: input.dst_artifact_id,
        dst_entity_type: input.dst_entity?.entity_type,
        dst_entity_id: input.dst_entity?.entity_id,
        relation: input.relation,
        rationale: input.rationale,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const event = storage.appendRuntimeEvent({
        event_type: "artifact.linked",
        entity_type: "artifact",
        entity_id: input.src_artifact_id,
        summary: `artifact link ${input.relation} created`,
        details: {
          src_artifact_id: input.src_artifact_id,
          dst_artifact_id: input.dst_artifact_id ?? null,
          dst_entity_type: input.dst_entity?.entity_type ?? null,
          dst_entity_id: input.dst_entity?.entity_id ?? null,
          relation: input.relation,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ...linked,
        event,
      };
    },
  });
}

export function artifactBundle(storage: Storage, input: z.infer<typeof artifactBundleSchema>) {
  const limit = input.limit ?? 200;
  if (input.artifact_id) {
    const artifact = storage.getArtifactById(input.artifact_id);
    if (!artifact) {
      return {
        found: false,
        artifact_id: input.artifact_id,
      };
    }
    const links = storage.listArtifactLinks({
      artifact_id: input.artifact_id,
      limit,
    });
    const relatedArtifactIds = collectRelatedArtifactIds(links, input.artifact_id);
    const relatedArtifacts = relatedArtifactIds
      .map((artifactId) => storage.getArtifactById(artifactId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return {
      found: true,
      artifact,
      latest_router_suppression:
        extractArtifactLatestRouterSuppression(artifact) ?? resolveArtifactsLatestRouterSuppression(relatedArtifacts),
      links,
      related_artifacts: relatedArtifacts,
    };
  }

  const entity = input.entity!;
  const scopeFilters = artifactScopeFiltersForEntity(entity.entity_type, entity.entity_id);
  const directArtifacts = scopeFilters
    ? storage.listArtifacts({
        ...scopeFilters,
        limit,
      })
    : [];
  const linkedArtifacts = storage.listArtifacts({
    linked_entity_type: entity.entity_type,
    linked_entity_id: entity.entity_id,
    limit,
  });
  const links = storage.listArtifactLinks({
    entity_type: entity.entity_type,
    entity_id: entity.entity_id,
    limit,
  });
  const artifactsById = new Map<string, ReturnType<typeof storage.getArtifactById>>();
  for (const artifact of [...directArtifacts, ...linkedArtifacts]) {
    artifactsById.set(artifact.artifact_id, artifact);
  }
  return {
    found: true,
    entity,
    count: artifactsById.size,
    latest_router_suppression: resolveArtifactsLatestRouterSuppression([...artifactsById.values()] as ArtifactRecord[]),
    artifacts: [...artifactsById.values()],
    links,
  };
}
