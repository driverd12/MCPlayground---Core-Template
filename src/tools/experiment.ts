import { z } from "zod";
import { Storage, type ExperimentRecord, type ExperimentRunRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { ensureWorkspaceFingerprint } from "./workspace_fingerprint.js";

const experimentStatusSchema = z.enum(["draft", "active", "paused", "completed", "archived"]);
const metricDirectionSchema = z.enum(["minimize", "maximize"]);
const experimentRunStatusSchema = z.enum(["proposed", "running", "completed", "crash", "discarded"]);
const experimentVerdictSchema = z.enum(["accepted", "rejected", "inconclusive", "crash"]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const experimentCreateSchema = z.object({
  mutation: mutationSchema,
  experiment_id: z.string().min(1).max(200).optional(),
  goal_id: z.string().min(1).optional(),
  plan_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  hypothesis: z.string().optional(),
  status: experimentStatusSchema.default("draft"),
  metric_name: z.string().min(1),
  metric_direction: metricDirectionSchema.default("minimize"),
  baseline_metric: z.number().finite().optional(),
  current_best_metric: z.number().finite().nullable().optional(),
  acceptance_delta: z.number().finite().min(0).optional(),
  budget_seconds: z.number().int().min(1).max(86400).optional(),
  run_command: z.string().optional(),
  parse_strategy: z.record(z.unknown()).optional(),
  rollback_strategy: z.record(z.unknown()).optional(),
  candidate_scope: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const experimentGetSchema = z.object({
  experiment_id: z.string().min(1),
  run_limit: z.number().int().min(1).max(500).optional(),
});

export const experimentListSchema = z.object({
  status: experimentStatusSchema.optional(),
  goal_id: z.string().min(1).optional(),
  plan_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const experimentRunSchema = z.object({
  mutation: mutationSchema,
  experiment_run_id: z.string().min(1).max(200).optional(),
  experiment_id: z.string().min(1),
  candidate_label: z.string().min(1),
  dispatch_mode: z.enum(["task", "record"]).default("task"),
  status: experimentRunStatusSchema.optional(),
  objective: z.string().min(1).optional(),
  project_dir: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  available_at: z.string().optional(),
  task_tags: z.array(z.string().min(1)).optional(),
  task_metadata: z.record(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
  artifact_ids: z.array(z.string().min(1)).optional(),
  run_id: z.string().min(1).optional(),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const experimentJudgeSchema = z.object({
  mutation: mutationSchema,
  experiment_id: z.string().min(1),
  experiment_run_id: z.string().min(1),
  status: experimentRunStatusSchema.optional(),
  verdict: experimentVerdictSchema.optional(),
  task_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  observed_metric: z.number().finite().optional(),
  observed_metrics: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
  log_excerpt: z.string().optional(),
  error_text: z.string().optional(),
  artifact_ids: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  set_selected_on_accept: z.boolean().default(true),
  experiment_status: experimentStatusSchema.optional(),
  ...sourceSchema.shape,
});

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function resolveComparisonMetric(experiment: ExperimentRecord): number | null {
  return experiment.current_best_metric ?? experiment.baseline_metric;
}

function computeImprovement(
  metricDirection: ExperimentRecord["metric_direction"],
  baselineMetric: number | null,
  observedMetric: number | null
): number | null {
  if (baselineMetric === null || observedMetric === null) {
    return null;
  }
  return metricDirection === "minimize" ? baselineMetric - observedMetric : observedMetric - baselineMetric;
}

function inferVerdict(input: {
  explicitVerdict?: z.infer<typeof experimentVerdictSchema>;
  run: ExperimentRunRecord;
  experiment: ExperimentRecord;
  observedMetric: number | null;
  improvement: number | null;
  errorText?: string;
}): z.infer<typeof experimentVerdictSchema> {
  if (input.explicitVerdict) {
    return input.explicitVerdict;
  }
  if ((input.errorText ?? "").trim()) {
    return "crash";
  }
  const comparisonMetric = resolveComparisonMetric(input.experiment);
  if (input.observedMetric === null) {
    return "inconclusive";
  }
  if (comparisonMetric === null) {
    return "accepted";
  }
  const threshold = Number(input.experiment.acceptance_delta ?? 0);
  if (input.improvement === null) {
    return "inconclusive";
  }
  if (threshold > 0) {
    return input.improvement >= threshold ? "accepted" : "rejected";
  }
  return input.improvement > 0 ? "accepted" : "rejected";
}

function inferRunStatus(
  explicitStatus: z.infer<typeof experimentRunStatusSchema> | undefined,
  verdict: z.infer<typeof experimentVerdictSchema>,
  errorText?: string
): z.infer<typeof experimentRunStatusSchema> {
  if (explicitStatus) {
    return explicitStatus;
  }
  if ((errorText ?? "").trim() || verdict === "crash") {
    return "crash";
  }
  return "completed";
}

export function attachArtifactsToExperiment(
  storage: Storage,
  params: {
    artifact_ids?: string[];
    experiment_id: string;
    experiment_run_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const artifactIds = dedupeStrings(params.artifact_ids);
  const links = [];
  for (const artifactId of artifactIds) {
    if (!storage.getArtifactById(artifactId)) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    const experimentLink = storage.linkArtifact({
      src_artifact_id: artifactId,
      dst_entity_type: "experiment",
      dst_entity_id: params.experiment_id,
      relation: "attached_to",
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
    });
    links.push(experimentLink.link);
    if (params.experiment_run_id) {
      const runLink = storage.linkArtifact({
        src_artifact_id: artifactId,
        dst_entity_type: "experiment_run",
        dst_entity_id: params.experiment_run_id,
        relation: "attached_to",
        source_client: params.source_client,
        source_model: params.source_model,
        source_agent: params.source_agent,
      });
      links.push(runLink.link);
    }
  }
  return {
    artifact_ids: artifactIds,
    links_created: links.length,
    links,
  };
}

export function judgeExperimentRunWithStorage(
  storage: Storage,
  params: {
    experiment_id: string;
    experiment_run_id: string;
    status?: z.infer<typeof experimentRunStatusSchema>;
    verdict?: z.infer<typeof experimentVerdictSchema>;
    task_id?: string;
    run_id?: string;
    observed_metric?: number;
    observed_metrics?: Record<string, unknown>;
    summary?: string;
    log_excerpt?: string;
    error_text?: string;
    artifact_ids?: string[];
    metadata?: Record<string, unknown>;
    set_selected_on_accept?: boolean;
    experiment_status?: z.infer<typeof experimentStatusSchema>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const experiment = storage.getExperimentById(params.experiment_id);
  if (!experiment) {
    throw new Error(`Experiment not found: ${params.experiment_id}`);
  }
  const experimentRun = storage.getExperimentRunById(params.experiment_run_id);
  if (!experimentRun) {
    throw new Error(`Experiment run not found: ${params.experiment_run_id}`);
  }
  if (experimentRun.experiment_id !== experiment.experiment_id) {
    throw new Error(
      `Experiment run ${experimentRun.experiment_run_id} does not belong to experiment ${experiment.experiment_id}`
    );
  }

  const observedMetric =
    params.observed_metric !== undefined ? params.observed_metric : experimentRun.observed_metric ?? null;
  const comparisonMetric = resolveComparisonMetric(experiment);
  const improvement = computeImprovement(experiment.metric_direction, comparisonMetric, observedMetric);
  const verdict = inferVerdict({
    explicitVerdict: params.verdict,
    run: experimentRun,
    experiment,
    observedMetric,
    improvement,
    errorText: params.error_text,
  });
  const status = inferRunStatus(params.status, verdict, params.error_text);

  const updatedRun = storage.updateExperimentRun({
    experiment_run_id: experimentRun.experiment_run_id,
    status,
    verdict,
    task_id: params.task_id,
    run_id: params.run_id,
    artifact_ids: params.artifact_ids,
    observed_metric: observedMetric,
    observed_metrics: params.observed_metrics,
    delta: improvement,
    summary: params.summary,
    log_excerpt: params.log_excerpt,
    error_text: params.error_text,
    metadata: params.metadata,
  });

  const artifactLinks = attachArtifactsToExperiment(storage, {
    artifact_ids: params.artifact_ids,
    experiment_id: experiment.experiment_id,
    experiment_run_id: experimentRun.experiment_run_id,
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent,
  });

  const selectAcceptedRun = (params.set_selected_on_accept ?? true) && verdict === "accepted" && observedMetric !== null;
  const updatedExperiment = storage.updateExperiment({
    experiment_id: experiment.experiment_id,
    status: params.experiment_status,
    current_best_metric: selectAcceptedRun ? observedMetric : undefined,
        selected_run_id: selectAcceptedRun ? experimentRun.experiment_run_id : undefined,
        metadata: {
          last_judged_run_id: experimentRun.experiment_run_id,
          last_verdict: verdict,
          last_observed_metric: observedMetric,
          last_delta: improvement,
        },
      }).experiment;
  const event = storage.appendRuntimeEvent({
    event_type: "experiment.run_judged",
    entity_type: "experiment_run",
    entity_id: experimentRun.experiment_run_id,
    status: updatedRun.experiment_run.status,
    summary: params.summary?.trim() || `Experiment run ${experimentRun.candidate_label} judged as ${verdict}.`,
    details: {
      experiment_id: experiment.experiment_id,
      experiment_run_id: experimentRun.experiment_run_id,
      candidate_label: experimentRun.candidate_label,
      verdict,
      accepted: verdict === "accepted",
      comparison_metric: comparisonMetric,
      observed_metric: observedMetric,
      delta: improvement,
      selected_run_id: updatedExperiment.selected_run_id,
      artifact_ids: artifactLinks.artifact_ids,
      artifact_links_created: artifactLinks.links_created,
    },
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent,
  });

  return {
    ok: true,
    experiment: updatedExperiment,
    experiment_run: updatedRun.experiment_run,
    comparison_metric: comparisonMetric,
    observed_metric: observedMetric,
    delta: improvement,
    verdict,
    accepted: verdict === "accepted",
    artifact_ids: artifactLinks.artifact_ids,
    artifact_links_created: artifactLinks.links_created,
    artifact_links: artifactLinks.links,
    event,
  };
}

export async function experimentCreate(storage: Storage, input: z.infer<typeof experimentCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "experiment.create",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const created = storage.createExperiment({
        experiment_id: input.experiment_id,
        goal_id: input.goal_id,
        plan_id: input.plan_id,
        step_id: input.step_id,
        title: input.title,
        objective: input.objective,
        hypothesis: input.hypothesis,
        status: input.status,
        metric_name: input.metric_name,
        metric_direction: input.metric_direction,
        baseline_metric: input.baseline_metric,
        current_best_metric: input.current_best_metric === null ? undefined : input.current_best_metric,
        acceptance_delta: input.acceptance_delta,
        budget_seconds: input.budget_seconds,
        run_command: input.run_command,
        parse_strategy: input.parse_strategy,
        rollback_strategy: input.rollback_strategy,
        candidate_scope: input.candidate_scope,
        tags: input.tags,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const event =
        created.created
          ? storage.appendRuntimeEvent({
              event_type: "experiment.created",
              entity_type: "experiment",
              entity_id: created.experiment.experiment_id,
              status: created.experiment.status,
              summary: `Experiment ${created.experiment.title} created.`,
              details: {
                goal_id: created.experiment.goal_id,
                plan_id: created.experiment.plan_id,
                step_id: created.experiment.step_id,
                metric_name: created.experiment.metric_name,
                metric_direction: created.experiment.metric_direction,
                baseline_metric: created.experiment.baseline_metric,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            })
          : null;
      return {
        ...created,
        event,
      };
    },
  });
}

export function experimentGet(storage: Storage, input: z.infer<typeof experimentGetSchema>) {
  const experiment = storage.getExperimentById(input.experiment_id);
  if (!experiment) {
    return {
      found: false,
      experiment_id: input.experiment_id,
    };
  }
  const runs = storage.listExperimentRuns({
    experiment_id: input.experiment_id,
    limit: input.run_limit ?? 100,
  });
  return {
    found: true,
    experiment,
    run_count: runs.length,
    runs,
    selected_run:
      experiment.selected_run_id !== null ? storage.getExperimentRunById(experiment.selected_run_id) : null,
  };
}

export function experimentList(storage: Storage, input: z.infer<typeof experimentListSchema>) {
  const experiments = storage.listExperiments({
    status: input.status,
    goal_id: input.goal_id,
    plan_id: input.plan_id,
    step_id: input.step_id,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    goal_id_filter: input.goal_id ?? null,
    plan_id_filter: input.plan_id ?? null,
    step_id_filter: input.step_id ?? null,
    count: experiments.length,
    experiments,
  };
}

export async function experimentRun(storage: Storage, input: z.infer<typeof experimentRunSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "experiment.run",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const experiment = storage.getExperimentById(input.experiment_id);
      if (!experiment) {
        throw new Error(`Experiment not found: ${input.experiment_id}`);
      }
      if (experiment.status === "archived") {
        throw new Error(`Experiment is archived and cannot dispatch new runs: ${input.experiment_id}`);
      }

      const dispatchMode = input.dispatch_mode;
      const taskResult =
        dispatchMode === "task"
          ? storage.createTask({
              objective: input.objective ?? experiment.objective,
              project_dir: input.project_dir ?? ".",
              payload: {
                experiment_id: experiment.experiment_id,
                candidate_label: input.candidate_label,
                title: experiment.title,
                objective: experiment.objective,
                hypothesis: experiment.hypothesis,
                metric_name: experiment.metric_name,
                metric_direction: experiment.metric_direction,
                baseline_metric: resolveComparisonMetric(experiment),
                acceptance_delta: experiment.acceptance_delta,
                run_command: experiment.run_command,
                parse_strategy: experiment.parse_strategy,
                rollback_strategy: experiment.rollback_strategy,
                candidate_scope: experiment.candidate_scope,
                ...input.payload,
              },
              priority: input.priority,
              max_attempts: input.max_attempts,
              available_at: input.available_at,
              source: "experiment.run",
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
              tags: dedupeStrings(["experiment", experiment.metric_name, ...(input.task_tags ?? [])]),
              metadata: {
                experiment_id: experiment.experiment_id,
                goal_id: experiment.goal_id,
                plan_id: experiment.plan_id,
                step_id: experiment.step_id,
                candidate_label: input.candidate_label,
                dispatch_mode: dispatchMode,
                ...input.task_metadata,
              },
            })
          : null;

      if (dispatchMode === "task") {
        ensureWorkspaceFingerprint(storage, input.project_dir ?? ".", {
          source: "experiment.run",
        });
      }

      const createdRun = storage.createExperimentRun({
        experiment_run_id: input.experiment_run_id,
        experiment_id: experiment.experiment_id,
        candidate_label: input.candidate_label,
        status: dispatchMode === "task" ? "running" : input.status ?? "proposed",
        task_id: taskResult?.task.task_id,
        run_id: input.run_id,
        artifact_ids: input.artifact_ids,
        summary: input.summary,
        metadata: {
          dispatch_mode: dispatchMode,
          ...input.metadata,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      const experimentAfter = storage.updateExperiment({
        experiment_id: experiment.experiment_id,
        status: "active",
        metadata: {
          last_run_id: createdRun.experiment_run.experiment_run_id,
          last_candidate_label: input.candidate_label,
          last_dispatch_mode: dispatchMode,
        },
      }).experiment;

      const artifactLinks = attachArtifactsToExperiment(storage, {
        artifact_ids: input.artifact_ids,
        experiment_id: experiment.experiment_id,
        experiment_run_id: createdRun.experiment_run.experiment_run_id,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const event = storage.appendRuntimeEvent({
        event_type: dispatchMode === "task" ? "experiment.run_started" : "experiment.run_created",
        entity_type: "experiment_run",
        entity_id: createdRun.experiment_run.experiment_run_id,
        status: createdRun.experiment_run.status,
        summary: `Experiment run ${createdRun.experiment_run.candidate_label} ${dispatchMode === "task" ? "started" : "created"}.`,
        details: {
          experiment_id: experiment.experiment_id,
          experiment_run_id: createdRun.experiment_run.experiment_run_id,
          candidate_label: createdRun.experiment_run.candidate_label,
          dispatch_mode: dispatchMode,
          task_id: taskResult?.task.task_id ?? null,
          run_id: input.run_id ?? null,
          goal_id: experiment.goal_id,
          plan_id: experiment.plan_id,
          step_id: experiment.step_id,
          artifact_ids: artifactLinks.artifact_ids,
          artifact_links_created: artifactLinks.links_created,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      return {
        ...createdRun,
        experiment: experimentAfter,
        dispatch_mode: dispatchMode,
        task: taskResult?.task ?? null,
        task_created: taskResult?.created ?? false,
        artifact_ids: artifactLinks.artifact_ids,
        artifact_links_created: artifactLinks.links_created,
        artifact_links: artifactLinks.links,
        event,
      };
    },
  });
}

export async function experimentJudge(storage: Storage, input: z.infer<typeof experimentJudgeSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "experiment.judge",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      judgeExperimentRunWithStorage(storage, {
        experiment_id: input.experiment_id,
        experiment_run_id: input.experiment_run_id,
        status: input.status,
        verdict: input.verdict,
        task_id: input.task_id,
        run_id: input.run_id,
        observed_metric: input.observed_metric,
        observed_metrics: input.observed_metrics,
        summary: input.summary,
        log_excerpt: input.log_excerpt,
        error_text: input.error_text,
        artifact_ids: input.artifact_ids,
        metadata: input.metadata,
        set_selected_on_accept: input.set_selected_on_accept,
        experiment_status: input.experiment_status,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}
