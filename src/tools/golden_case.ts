import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const relatedEntitySchema = z.object({
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  relation: z.string().min(1).optional(),
});

const benchmarkSeedSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(5).max(7200).optional(),
  reward_file_path: z.string().min(1).optional(),
});

export const goldenCaseCaptureSchema = z.object({
  mutation: mutationSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  source_kind: z.enum(["incident", "failure", "success", "trace", "postmortem", "research"]).default("failure"),
  scenario_prompt: z.string().min(1),
  expected_outcomes: z.array(z.string().min(1)).min(1).max(20),
  tool_expectations: z.array(z.string().min(1)).max(20).optional(),
  invariant_checks: z.array(z.string().min(1)).max(20).optional(),
  regression_tags: z.array(z.string().min(1)).max(20).optional(),
  notes: z.string().optional(),
  severity: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  benchmark_seed: benchmarkSeedSchema.optional(),
  goal_id: z.string().min(1).optional(),
  plan_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  turn_id: z.string().min(1).optional(),
  related_entities: z.array(relatedEntitySchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

function normalizeStringList(values: string[] | undefined) {
  const seen = new Set<string>();
  const normalized = [];
  for (const value of values ?? []) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function slugify(input: string) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildGoldenCaseContent(input: z.infer<typeof goldenCaseCaptureSchema>, goldenCaseId: string, createdAt: string) {
  const expectedOutcomes = normalizeStringList(input.expected_outcomes);
  const toolExpectations = normalizeStringList(input.tool_expectations);
  const invariantChecks = normalizeStringList(input.invariant_checks);
  const regressionTags = normalizeStringList(input.regression_tags);
  return {
    schema_version: "golden_case.v1",
    golden_case_id: goldenCaseId,
    captured_at: createdAt,
    title: input.title.trim(),
    objective: input.objective.trim(),
    source_kind: input.source_kind,
    scenario_prompt: input.scenario_prompt.trim(),
    expected_outcomes: expectedOutcomes,
    tool_expectations: toolExpectations,
    invariant_checks: invariantChecks,
    regression_tags: regressionTags,
    severity: input.severity ?? null,
    notes: input.notes?.trim() || null,
    benchmark_seed: input.benchmark_seed
      ? {
          command: input.benchmark_seed.command.trim(),
          timeout_seconds: input.benchmark_seed.timeout_seconds ?? 120,
          reward_file_path: input.benchmark_seed.reward_file_path?.trim() || "logs/reward.txt",
        }
      : null,
  };
}

export function buildSuggestedBenchmarkCase(input: z.infer<typeof goldenCaseCaptureSchema>, goldenCaseId: string) {
  if (!input.benchmark_seed) {
    return null;
  }
  const tags = normalizeStringList(["golden-case", input.source_kind, ...(input.regression_tags ?? [])]);
  return {
    case_id: goldenCaseId,
    title: input.title.trim(),
    command: input.benchmark_seed.command.trim(),
    timeout_seconds: input.benchmark_seed.timeout_seconds ?? 120,
    metric_name: "reward_score",
    metric_direction: "maximize" as const,
    metric_mode: "reward_file" as const,
    reward_file_path: input.benchmark_seed.reward_file_path?.trim() || "logs/reward.txt",
    tags,
    metadata: {
      golden_case_id: goldenCaseId,
      source_kind: input.source_kind,
      objective: input.objective.trim(),
    },
  };
}

export async function goldenCaseCapture(storage: Storage, input: z.infer<typeof goldenCaseCaptureSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "golden.case_capture",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const createdAt = new Date().toISOString();
      const goldenCaseId = `golden-${slugify(input.title)}-${createdAt.replace(/[:.]/g, "-")}`;
      const content = buildGoldenCaseContent(input, goldenCaseId, createdAt);
      const recorded = storage.recordArtifact({
        artifact_type: "golden_case",
        goal_id: input.goal_id,
        plan_id: input.plan_id,
        step_id: input.step_id,
        task_id: input.task_id,
        run_id: input.run_id,
        thread_id: input.thread_id,
        turn_id: input.turn_id,
        producer_kind: "planner",
        trust_tier: "verified",
        content_json: content,
        metadata: {
          golden_case_id: goldenCaseId,
          source_kind: input.source_kind,
          regression_tags: normalizeStringList(input.regression_tags),
          severity: input.severity ?? null,
          ...(input.metadata ?? {}),
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const createdLinks = [];
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
        event_type: "golden.case_captured",
        entity_type: "artifact",
        entity_id: recorded.artifact.artifact_id,
        status: "active",
        summary: `golden case captured: ${input.title.trim()}`,
        details: {
          golden_case_id: goldenCaseId,
          source_kind: input.source_kind,
          links_created: createdLinks.length,
          benchmark_seeded: Boolean(input.benchmark_seed),
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        golden_case_id: goldenCaseId,
        artifact: recorded.artifact,
        links_created: createdLinks.length,
        links: createdLinks,
        event,
        suggested_benchmark_case: buildSuggestedBenchmarkCase(input, goldenCaseId),
      };
    },
  });
}
