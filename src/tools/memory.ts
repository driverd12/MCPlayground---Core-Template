import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema } from "./mutation.js";

export const memoryAppendSchema = z
  .object({
    mutation: mutationSchema,
    content: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    // Backward compatibility for older clients.
    text: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.content && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content is required",
        path: ["content"],
      });
    }
  });

export const memorySearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  // Backward compatibility fields are accepted and ignored.
  tags: z.array(z.string()).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
  trust_tiers: z.array(z.string()).optional(),
  include_expired: z.boolean().optional(),
});

export const memoryGetSchema = z.object({
  id: z.number().int().min(1),
  touch: z.boolean().optional(),
});

export const memoryRecentSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

const reflectionEvidenceSchema = z
  .object({
    kind: z.enum(["tool_result", "artifact", "incident", "run", "benchmark", "eval", "notebook", "other"]).default("other"),
    label: z.string().min(1),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.entity_type && !value.entity_id) || (!value.entity_type && value.entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entity_type and entity_id must be provided together",
        path: ["entity_type"],
      });
    }
  });

export const memoryReflectionCaptureSchema = z.object({
  mutation: mutationSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  attempted_action: z.string().min(1),
  grounded_feedback: z.array(z.string().min(1)).min(1).max(20),
  reflection: z.string().min(1),
  next_actions: z.array(z.string().min(1)).max(20).optional(),
  evidence_refs: z.array(reflectionEvidenceSchema).max(20).optional(),
  tags: z.array(z.string().min(1)).max(20).optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export function appendMemory(storage: Storage, input: z.infer<typeof memoryAppendSchema>) {
  const content = (input.content ?? input.text ?? "").trim();
  if (!content) {
    throw new Error("content is required");
  }
  const keywords = dedupeKeywords(input.keywords ?? input.tags ?? []);
  const memory = storage.insertMemory({
    content,
    keywords,
  });
  return {
    id: memory.id,
    created_at: memory.created_at,
    last_accessed_at: memory.last_accessed_at,
    content,
    keywords,
  };
}

export function searchMemory(storage: Storage, input: z.infer<typeof memorySearchSchema>) {
  return storage.searchMemories({
    query: input.query,
    limit: input.limit ?? 10,
  });
}

export function getMemory(storage: Storage, input: z.infer<typeof memoryGetSchema>) {
  const memory = storage.getMemoryById(input.id);
  if (!memory) {
    return {
      found: false,
      id: input.id,
    };
  }
  if (input.touch ?? true) {
    const touched = storage.touchMemory(input.id);
    memory.last_accessed_at = touched.last_accessed_at;
  }
  return {
    found: true,
    memory,
  };
}

export function recentMemory(storage: Storage, input: z.infer<typeof memoryRecentSchema>) {
  const memories = storage.listRecentMemories(input.limit ?? 10);
  return {
    count: memories.length,
    memories,
  };
}

export function captureReflectionMemory(storage: Storage, input: z.infer<typeof memoryReflectionCaptureSchema>) {
  const groundedFeedback = dedupeOrdered(input.grounded_feedback);
  const nextActions = dedupeOrdered(input.next_actions ?? []);
  const evidenceRefs = (input.evidence_refs ?? []).map((entry) => ({
    kind: entry.kind,
    label: entry.label.trim(),
    entity_type: entry.entity_type?.trim() || null,
    entity_id: entry.entity_id?.trim() || null,
  }));

  const content = [
    `Reflection Case: ${input.title.trim()}`,
    `Objective: ${input.objective.trim()}`,
    `Attempted action: ${input.attempted_action.trim()}`,
    "Grounded feedback:",
    ...groundedFeedback.map((entry) => `- ${entry}`),
    "Reflection:",
    input.reflection.trim(),
    ...(nextActions.length > 0 ? ["Next actions:", ...nextActions.map((entry) => `- ${entry}`)] : []),
    ...(evidenceRefs.length > 0
      ? [
          "Evidence references:",
          ...evidenceRefs.map((entry) =>
            `- [${entry.kind}] ${entry.label}${entry.entity_type && entry.entity_id ? ` (${entry.entity_type}:${entry.entity_id})` : ""}`
          ),
        ]
      : []),
  ].join("\n");

  const keywords = dedupeKeywords([
    "reflection",
    "episodic",
    "grounded",
    ...(input.tags ?? []),
    ...groundedFeedback.flatMap((entry) => entry.split(/[^a-zA-Z0-9]+/g).filter(Boolean).slice(0, 3)),
  ]);

  const memory = storage.insertMemory({
    content,
    keywords,
  });

  const event = storage.appendRuntimeEvent({
    event_type: "memory.reflection_captured",
    entity_type: "memory",
    entity_id: String(memory.id),
    status: "active",
    summary: `reflection captured: ${input.title.trim()}`,
    details: {
      objective: input.objective.trim(),
      grounded_feedback_count: groundedFeedback.length,
      next_action_count: nextActions.length,
      evidence_ref_count: evidenceRefs.length,
      tags: dedupeOrdered(input.tags ?? []),
    },
    source_client: input.source_client,
    source_model: input.source_model,
    source_agent: input.source_agent,
  });

  return {
    memory_id: memory.id,
    memory: {
      id: memory.id,
      created_at: memory.created_at,
      last_accessed_at: memory.last_accessed_at,
      content,
      keywords,
    },
    event,
    grounded_feedback_count: groundedFeedback.length,
    next_action_count: nextActions.length,
    evidence_ref_count: evidenceRefs.length,
    keywords,
  };
}

function dedupeKeywords(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const keyword = value.trim().toLowerCase();
    if (keyword) {
      unique.add(keyword);
    }
  }
  return Array.from(unique);
}

function dedupeOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const output = [];
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}
