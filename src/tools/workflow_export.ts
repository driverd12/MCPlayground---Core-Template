import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import {
  type ArtifactLinkRecord,
  type ArtifactRecord,
  type GoalRecord,
  type PlanRecord,
  type PlanStepRecord,
  type TaskEventRecord,
  type TaskRecord,
  Storage,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { resolveClusterTopologyState, summarizeClusterTopologyState } from "./cluster_topology.js";
import { routeModelBackends } from "./model_router.js";
import { resolveEffectiveWorkerFabric } from "./worker_fabric.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const workflowExportSchema = z
  .object({
    mutation: mutationSchema,
    goal_id: z.string().min(1).optional(),
    plan_id: z.string().min(1).optional(),
    output_dir: z.string().min(1).optional(),
    export_argo_contract: z.boolean().default(true),
    export_metrics_jsonl: z.boolean().default(true),
    include_artifacts: z.boolean().default(true),
    include_runtime_state: z.boolean().default(true),
    namespace: z.string().min(1).optional(),
    workflow_name: z.string().min(1).optional(),
    metadata: recordSchema.optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (!value.goal_id?.trim() && !value.plan_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "goal_id or plan_id is required",
        path: ["goal_id"],
      });
    }
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value), null, 2);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      sorted[key] = sortObject(entry);
    }
    return sorted;
  }
  return value;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function slugify(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || fallback;
}

function yamlScalar(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "''";
  }
  const text = String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout ?? "").trim() || null;
}

function resolveGoalPlan(storage: Storage, goal: GoalRecord): PlanRecord | null {
  if (goal.active_plan_id) {
    const active = storage.getPlanById(goal.active_plan_id);
    if (active && active.goal_id === goal.goal_id) {
      return active;
    }
  }
  return (
    storage
      .listPlans({
        goal_id: goal.goal_id,
        selected_only: true,
        limit: 10,
      })[0] ??
    storage
      .listPlans({
        goal_id: goal.goal_id,
        limit: 10,
      })[0] ??
    null
  );
}

function resolveGoalAndPlan(storage: Storage, input: { goal_id?: string; plan_id?: string }) {
  const explicitPlan = input.plan_id?.trim() ? storage.getPlanById(input.plan_id) : null;
  const explicitGoal =
    input.goal_id?.trim() ? storage.getGoalById(input.goal_id) : explicitPlan ? storage.getGoalById(explicitPlan.goal_id) : null;
  const goal = explicitGoal ?? (explicitPlan ? storage.getGoalById(explicitPlan.goal_id) : null);
  if (!goal) {
    throw new Error(`Goal not found: ${input.goal_id ?? explicitPlan?.goal_id ?? "unknown"}`);
  }
  const plan = explicitPlan ?? resolveGoalPlan(storage, goal);
  if (!plan) {
    throw new Error(`No plan found for goal ${goal.goal_id}`);
  }
  if (plan.goal_id !== goal.goal_id) {
    throw new Error(`Plan ${plan.plan_id} does not belong to goal ${goal.goal_id}`);
  }
  return {
    goal,
    plan,
    steps: storage.listPlanSteps(plan.plan_id),
  };
}

function dedupeById<T extends { artifact_id?: string | null; id?: string | null }>(records: T[]) {
  const byId = new Map<string, T>();
  for (const record of records) {
    const id = (record.artifact_id ?? record.id ?? "").trim();
    if (!id) {
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, record);
    }
  }
  return [...byId.values()];
}

function collectScopedArtifacts(
  storage: Storage,
  goal: GoalRecord,
  plan: PlanRecord,
  steps: PlanStepRecord[]
): { artifacts: ArtifactRecord[]; links: ArtifactLinkRecord[] } {
  const artifacts: ArtifactRecord[] = [];
  const runIds = new Set<string>();
  const taskIds = new Set<string>();

  artifacts.push(...storage.listArtifacts({ goal_id: goal.goal_id, limit: 250 }));
  artifacts.push(...storage.listArtifacts({ plan_id: plan.plan_id, limit: 250 }));
  for (const step of steps) {
    artifacts.push(...storage.listArtifacts({ step_id: step.step_id, limit: 100 }));
    if (step.run_id) {
      runIds.add(step.run_id);
      artifacts.push(...storage.listArtifacts({ run_id: step.run_id, limit: 100 }));
    }
    if (step.task_id) {
      taskIds.add(step.task_id);
      artifacts.push(...storage.listArtifacts({ task_id: step.task_id, limit: 100 }));
    }
  }

  const dedupedArtifacts = dedupeById(artifacts);
  const links = dedupeById([
    ...storage.listArtifactLinks({ entity_type: "goal", entity_id: goal.goal_id, limit: 500 }),
    ...storage.listArtifactLinks({ entity_type: "plan", entity_id: plan.plan_id, limit: 500 }),
    ...dedupedArtifacts.flatMap((artifact) => storage.listArtifactLinks({ artifact_id: artifact.artifact_id, limit: 200 })),
  ]);

  return {
    artifacts: dedupedArtifacts,
    links: links as ArtifactLinkRecord[],
  };
}

function collectLinkedTasks(storage: Storage, steps: PlanStepRecord[]) {
  const tasks = steps
    .map((step) => (step.task_id ? storage.getTaskById(step.task_id) : null))
    .filter((task): task is TaskRecord => task !== null);
  const byId = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (!byId.has(task.task_id)) {
      byId.set(task.task_id, task);
    }
  }
  return [...byId.values()];
}

function collectRuntimeLedgers(storage: Storage, steps: PlanStepRecord[], tasks: TaskRecord[]) {
  const runIds = [...new Set(steps.map((step) => step.run_id).filter((runId): runId is string => Boolean(runId)))];
  const taskIds = [...new Set(tasks.map((task) => task.task_id))];
  const runTimelines = runIds.map((runId) => ({
    run_id: runId,
    events: storage.getRunTimeline(runId, 10_000),
  }));
  const taskTimelines = taskIds.map((taskId) => ({
    task_id: taskId,
    events: storage.getTaskTimeline(taskId, 10_000),
  }));
  return {
    run_timelines: runTimelines,
    task_timelines: taskTimelines,
  };
}

function extractStepExecutionSummary(step: PlanStepRecord) {
  const metadata = isRecord(step.metadata) ? step.metadata : {};
  const taskExecution = isRecord(metadata.task_execution) ? metadata.task_execution : {};
  return {
    step_id: step.step_id,
    seq: step.seq,
    title: step.title,
    status: step.status,
    step_kind: step.step_kind,
    executor_kind: step.executor_kind,
    executor_ref: step.executor_ref,
    task_id: step.task_id,
    run_id: step.run_id,
    depends_on: step.depends_on,
    expected_artifact_types: step.expected_artifact_types,
    acceptance_checks: step.acceptance_checks,
    task_execution: taskExecution,
    org_program_version_id: readString(metadata.org_program_version_id),
    owner_role_id: readString(metadata.owner_role_id),
    checkpoint_required: metadata.checkpoint_required === true,
  };
}

function routeOutlookForPlan(storage: Storage, steps: PlanStepRecord[]) {
  const taskKinds = [...new Set(
    steps
      .map((step) => {
        const taskExecution = isRecord(step.metadata?.task_execution) ? step.metadata.task_execution : {};
        const kind = readString(taskExecution.task_kind) ?? readString(step.step_kind);
        return kind === "planning" || kind === "coding" || kind === "research" || kind === "verification" || kind === "chat" || kind === "tool_use"
          ? kind
          : null;
      })
      .filter((kind): kind is "planning" | "coding" | "research" | "verification" | "chat" | "tool_use" => Boolean(kind))
  )];
  return taskKinds.map((taskKind) => {
    const route = routeModelBackends(storage, {
      task_kind: taskKind,
    });
    return {
      task_kind: taskKind,
      selected_backend_id: route.selected_backend?.backend_id ?? null,
      selected_provider: route.selected_backend?.provider ?? null,
      selected_host_id: route.selected_backend?.host_id ?? null,
      planned_backends: route.planned_backends.slice(0, 5),
    };
  });
}

function buildRunMetricsLines(input: {
  export_id: string;
  generated_at: string;
  goal: GoalRecord;
  plan: PlanRecord;
  steps: PlanStepRecord[];
  tasks: TaskRecord[];
  task_timelines: Array<{ task_id: string; events: TaskEventRecord[] }>;
  run_timelines: Array<{ run_id: string; events: ReturnType<Storage["getRunTimeline"]> }>;
}) {
  const lines: Record<string, unknown>[] = [
    {
      kind: "workflow.export",
      export_id: input.export_id,
      generated_at: input.generated_at,
      goal_id: input.goal.goal_id,
      plan_id: input.plan.plan_id,
      step_count: input.steps.length,
      task_count: input.tasks.length,
      run_count: input.run_timelines.length,
    },
  ];
  for (const step of input.steps) {
    lines.push({
      kind: "plan.step",
      generated_at: input.generated_at,
      goal_id: input.goal.goal_id,
      plan_id: input.plan.plan_id,
      step_id: step.step_id,
      seq: step.seq,
      title: step.title,
      status: step.status,
      step_kind: step.step_kind,
      executor_kind: step.executor_kind,
      executor_ref: step.executor_ref,
      task_id: step.task_id,
      run_id: step.run_id,
      depends_on: step.depends_on,
      task_execution: isRecord(step.metadata?.task_execution) ? step.metadata.task_execution : {},
    });
  }
  for (const task of input.tasks) {
    lines.push({
      kind: "task",
      generated_at: input.generated_at,
      task_id: task.task_id,
      status: task.status,
      priority: task.priority,
      objective: task.objective,
      project_dir: task.project_dir,
      routing: isRecord(task.metadata?.task_routing) ? task.metadata.task_routing : {},
      task_execution: isRecord(task.metadata?.task_execution) ? task.metadata.task_execution : {},
      metadata: task.metadata,
    });
  }
  for (const timeline of input.task_timelines) {
    for (const event of timeline.events) {
      lines.push({
        kind: "task.event",
        generated_at: input.generated_at,
        task_id: timeline.task_id,
        event_id: event.id,
        created_at: event.created_at,
        event_type: event.event_type,
        from_status: event.from_status,
        to_status: event.to_status,
        worker_id: event.worker_id,
        summary: event.summary,
        details: event.details,
      });
    }
  }
  for (const timeline of input.run_timelines) {
    for (const event of timeline.events) {
      lines.push({
        kind: "run.event",
        generated_at: input.generated_at,
        run_id: timeline.run_id,
        event_id: event.id,
        created_at: event.created_at,
        event_type: event.event_type,
        step_index: event.step_index,
        status: event.status,
        summary: event.summary,
        details: event.details,
      });
    }
  }
  return lines.map((entry) => JSON.stringify(sortObject(entry))).join("\n") + "\n";
}

function buildArgoContractYaml(input: {
  namespace: string;
  workflow_name: string;
  goal: GoalRecord;
  plan: PlanRecord;
  steps: PlanStepRecord[];
}) {
  const stepTemplates = input.steps
    .map((step) => {
      const metadata = isRecord(step.metadata) ? step.metadata : {};
      const taskExecution = isRecord(metadata.task_execution) ? metadata.task_execution : {};
      const templateName = `step-${String(step.seq).padStart(2, "0")}-${slugify(step.title, step.step_id).slice(0, 34)}`;
      return {
        template_name: templateName,
        step,
        annotations: {
          "mcplayground.io/goal-id": input.goal.goal_id,
          "mcplayground.io/plan-id": input.plan.plan_id,
          "mcplayground.io/plan-step-id": step.step_id,
          "mcplayground.io/step-kind": step.step_kind,
          "mcplayground.io/executor-kind": step.executor_kind ?? "",
          "mcplayground.io/executor-ref": step.executor_ref ?? "",
          "mcplayground.io/isolation-mode": readString(taskExecution.isolation_mode) ?? "",
          "mcplayground.io/selected-backend-id": readString(taskExecution.selected_backend_id) ?? "",
          "mcplayground.io/selected-host-id": readString(taskExecution.selected_host_id) ?? "",
          "mcplayground.io/contract-mode": "suspend",
        },
      };
    });

  const lines: string[] = [
    "apiVersion: argoproj.io/v1alpha1",
    "kind: WorkflowTemplate",
    "metadata:",
    `  name: ${slugify(input.workflow_name, `plan-${input.plan.plan_id}`).slice(0, 63)}`,
    `  namespace: ${slugify(input.namespace, "default")}`,
    "  annotations:",
    `    mcplayground.io/export-contract: ${yamlScalar("true")}`,
    `    mcplayground.io/goal-id: ${yamlScalar(input.goal.goal_id)}`,
    `    mcplayground.io/plan-id: ${yamlScalar(input.plan.plan_id)}`,
    `    mcplayground.io/title: ${yamlScalar(input.plan.title)}`,
    "spec:",
    "  entrypoint: compiled-plan",
    "  templates:",
    "    - name: compiled-plan",
    "      dag:",
    "        tasks:",
  ];

  for (const template of stepTemplates) {
    lines.push(`          - name: ${template.template_name}`);
    lines.push(`            template: ${template.template_name}`);
    if (template.step.depends_on.length > 0) {
      lines.push("            dependencies:");
      for (const dependency of template.step.depends_on) {
        const dependencyTemplate = stepTemplates.find((entry) => entry.step.step_id === dependency);
        if (dependencyTemplate) {
          lines.push(`              - ${dependencyTemplate.template_name}`);
        }
      }
    }
  }

  for (const template of stepTemplates) {
    lines.push(`    - name: ${template.template_name}`);
    lines.push("      metadata:");
    lines.push("        annotations:");
    for (const [key, value] of Object.entries(template.annotations)) {
      lines.push(`          ${key}: ${yamlScalar(value)}`);
    }
    lines.push("      suspend: {}");
  }

  return `${lines.join("\n")}\n`;
}

export async function workflowExport(storage: Storage, input: z.infer<typeof workflowExportSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "workflow.export",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const { goal, plan, steps } = resolveGoalAndPlan(storage, input);
      const exportId = `workflow-export-${crypto.randomUUID()}`;
      const generatedAt = new Date().toISOString();
      const timestampTag = generatedAt.replace(/[:.]/g, "-");
      const outputDir = path.resolve(
        input.output_dir?.trim() || path.join(process.cwd(), "data", "exports", "workflow", `${timestampTag}-${plan.plan_id}`)
      );
      fs.mkdirSync(outputDir, { recursive: true });

      const linkedTasks = collectLinkedTasks(storage, steps);
      const runtimeLedgers = collectRuntimeLedgers(storage, steps, linkedTasks);
      const artifactSnapshot = input.include_artifacts !== false ? collectScopedArtifacts(storage, goal, plan, steps) : { artifacts: [], links: [] };

      const repoRoot = process.cwd();
      const gitSnapshot = {
        repo_root: repoRoot,
        branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
        head_sha: runGit(["rev-parse", "HEAD"], repoRoot),
        is_dirty: Boolean(runGit(["status", "--short"], repoRoot)),
        status: runGit(["status", "--short"], repoRoot),
      };

      const bundle = sortObject({
        export_id: exportId,
        generated_at: generatedAt,
        target: {
          goal_id: goal.goal_id,
          plan_id: plan.plan_id,
          goal_title: goal.title,
          plan_title: plan.title,
        },
        goal,
        plan: {
          record: plan,
          steps,
          step_execution: steps.map((step) => extractStepExecutionSummary(step)),
          edges: steps.flatMap((step) => step.depends_on.map((dependencyId) => ({ from_step_id: dependencyId, to_step_id: step.step_id }))),
        },
        reproducibility: {
          git: gitSnapshot,
          worker_fabric_state: input.include_runtime_state !== false ? storage.getWorkerFabricState() : null,
          worker_fabric_effective: input.include_runtime_state !== false
            ? resolveEffectiveWorkerFabric(storage, {
                fallback_workspace_root: repoRoot,
                fallback_worker_count: 1,
                fallback_shell: "/bin/zsh",
              })
            : null,
          cluster_topology_state: input.include_runtime_state !== false ? resolveClusterTopologyState(storage) : null,
          cluster_topology_summary:
            input.include_runtime_state !== false ? summarizeClusterTopologyState(resolveClusterTopologyState(storage)) : null,
          model_router_state: input.include_runtime_state !== false ? storage.getModelRouterState() : null,
          routing_outlook: input.include_runtime_state !== false ? routeOutlookForPlan(storage, steps) : [],
          benchmark_suites_state: input.include_runtime_state !== false ? storage.getBenchmarkSuitesState() : null,
          eval_suites_state: input.include_runtime_state !== false ? storage.getEvalSuitesState() : null,
          org_programs_state: input.include_runtime_state !== false ? storage.getOrgProgramsState() : null,
          domain_specialists_state: input.include_runtime_state !== false ? storage.getDomainSpecialistRegistryState() : null,
        },
        runtime: {
          tasks: linkedTasks,
          run_timelines: runtimeLedgers.run_timelines,
          task_timelines: runtimeLedgers.task_timelines,
        },
        swarm: {
          swarm_profile:
            (isRecord(plan.metadata?.swarm_profile) ? plan.metadata.swarm_profile : null) ??
            (isRecord(goal.metadata?.swarm_profile) ? goal.metadata.swarm_profile : null),
          memory_preflight:
            (isRecord(plan.metadata?.memory_preflight) ? plan.metadata.memory_preflight : null) ??
            (isRecord(goal.metadata?.memory_preflight) ? goal.metadata.memory_preflight : null),
        },
        provenance: {
          artifacts: artifactSnapshot.artifacts,
          links: artifactSnapshot.links,
        },
        metadata: input.metadata ?? {},
      });

      const bundleText = `${stableStringify(bundle)}\n`;
      const bundlePath = path.join(outputDir, "workflow-bundle.json");
      fs.writeFileSync(bundlePath, bundleText, "utf8");
      const bundleSha = sha256(bundleText);

      let metricsPath: string | null = null;
      let metricsSha: string | null = null;
      let metricsLineCount = 0;
      if (input.export_metrics_jsonl !== false) {
        const metricsText = buildRunMetricsLines({
          export_id: exportId,
          generated_at: generatedAt,
          goal,
          plan,
          steps,
          tasks: linkedTasks,
          task_timelines: runtimeLedgers.task_timelines,
          run_timelines: runtimeLedgers.run_timelines,
        });
        metricsPath = path.join(outputDir, "run-metrics.jsonl");
        fs.writeFileSync(metricsPath, metricsText, "utf8");
        metricsSha = sha256(metricsText);
        metricsLineCount = metricsText.trim().length === 0 ? 0 : metricsText.trim().split("\n").length;
      }

      let argoPath: string | null = null;
      let argoSha: string | null = null;
      if (input.export_argo_contract !== false) {
        const workflowName = input.workflow_name?.trim() || `${goal.title} ${plan.title}`;
        const argoText = buildArgoContractYaml({
          namespace: input.namespace?.trim() || "default",
          workflow_name: workflowName,
          goal,
          plan,
          steps,
        });
        argoPath = path.join(outputDir, "argo-workflow-contract.yaml");
        fs.writeFileSync(argoPath, argoText, "utf8");
        argoSha = sha256(argoText);
      }

      const manifest = {
        export_id: exportId,
        generated_at: generatedAt,
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        output_dir: outputDir,
        files: {
          bundle_json: bundlePath,
          run_metrics_jsonl: metricsPath,
          argo_contract_yaml: argoPath,
        },
        hashes: {
          bundle_sha256: bundleSha,
          run_metrics_sha256: metricsSha,
          argo_contract_sha256: argoSha,
        },
        counts: {
          step_count: steps.length,
          task_count: linkedTasks.length,
          run_count: runtimeLedgers.run_timelines.length,
          task_timeline_count: runtimeLedgers.task_timelines.length,
          artifact_count: artifactSnapshot.artifacts.length,
          artifact_link_count: artifactSnapshot.links.length,
          run_metrics_line_count: metricsLineCount,
        },
      };
      const manifestPath = path.join(outputDir, "workflow-export-manifest.json");
      fs.writeFileSync(manifestPath, `${stableStringify(manifest)}\n`, "utf8");

      const bundleArtifact = storage.recordArtifact({
        artifact_type: "workflow.bundle",
        status: "active",
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        producer_kind: "tool",
        producer_id: "workflow.export",
        trust_tier: "derived",
        uri: bundlePath,
        hash: bundleSha,
        content_json: {
          export_id: exportId,
          generated_at: generatedAt,
          step_count: steps.length,
          task_count: linkedTasks.length,
          run_count: runtimeLedgers.run_timelines.length,
          artifact_count: artifactSnapshot.artifacts.length,
          bundle_sha256: bundleSha,
        },
        metadata: {
          export_id: exportId,
          manifest_path: manifestPath,
          repo_root: repoRoot,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      if (metricsPath && metricsSha) {
        const metricsArtifact = storage.recordArtifact({
          artifact_type: "workflow.metrics_jsonl",
          status: "active",
          goal_id: goal.goal_id,
          plan_id: plan.plan_id,
          producer_kind: "tool",
          producer_id: "workflow.export",
          trust_tier: "derived",
          uri: metricsPath,
          hash: metricsSha,
          content_json: {
            export_id: exportId,
            generated_at: generatedAt,
            line_count: metricsLineCount,
            run_count: runtimeLedgers.run_timelines.length,
            task_timeline_count: runtimeLedgers.task_timelines.length,
          },
          metadata: {
            export_id: exportId,
            manifest_path: manifestPath,
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        storage.linkArtifact({
          src_artifact_id: metricsArtifact.artifact.artifact_id,
          dst_artifact_id: bundleArtifact.artifact.artifact_id,
          relation: "derived_from",
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
      }

      if (argoPath && argoSha) {
        const argoArtifact = storage.recordArtifact({
          artifact_type: "workflow.argo_contract",
          status: "active",
          goal_id: goal.goal_id,
          plan_id: plan.plan_id,
          producer_kind: "tool",
          producer_id: "workflow.export",
          trust_tier: "derived",
          uri: argoPath,
          hash: argoSha,
          content_json: {
            export_id: exportId,
            generated_at: generatedAt,
            contract_mode: "argo-workflow-template-suspend-dag",
            step_count: steps.length,
            namespace: input.namespace?.trim() || "default",
          },
          metadata: {
            export_id: exportId,
            manifest_path: manifestPath,
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        storage.linkArtifact({
          src_artifact_id: argoArtifact.artifact.artifact_id,
          dst_artifact_id: bundleArtifact.artifact.artifact_id,
          relation: "derived_from",
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
      }

      storage.appendRuntimeEvent({
        event_type: "workflow.exported",
        entity_type: "plan",
        entity_id: plan.plan_id,
        status: "completed",
        summary: `workflow bundle exported for plan ${plan.plan_id}`,
        details: {
          export_id: exportId,
          goal_id: goal.goal_id,
          output_dir: outputDir,
          bundle_path: bundlePath,
          metrics_path: metricsPath,
          argo_path: argoPath,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      return {
        ok: true,
        export_id: exportId,
        generated_at: generatedAt,
        goal_id: goal.goal_id,
        plan_id: plan.plan_id,
        output_dir: outputDir,
        manifest_path: manifestPath,
        bundle: {
          path: bundlePath,
          sha256: bundleSha,
        },
        run_metrics_jsonl: metricsPath
          ? {
              path: metricsPath,
              sha256: metricsSha,
              line_count: metricsLineCount,
            }
          : null,
        argo_contract: argoPath
          ? {
              path: argoPath,
              sha256: argoSha,
              contract_mode: "argo-workflow-template-suspend-dag",
            }
          : null,
        artifact_counts: {
          artifacts: artifactSnapshot.artifacts.length,
          links: artifactSnapshot.links.length,
        },
      };
    },
  });
}
