import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Storage, type BenchmarkSuiteRecord, type ExperimentMetricDirection } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { buildIsolatedExecutionPlan, buildRemoteExecutionCommand } from "../execution_isolation.js";
import { buildWorkerFabricSlots, resolveEffectiveWorkerFabric } from "./worker_fabric.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const benchmarkCaseSchema = z.object({
  case_id: z.string().min(1).optional(),
  title: z.string().min(1),
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(5).max(7200).optional(),
  required: z.boolean().optional(),
  metric_name: z.string().min(1).optional(),
  metric_direction: z.enum(["minimize", "maximize"]).optional(),
  metric_mode: z.enum(["duration_ms", "stdout_regex", "stderr_regex", "reward_file"]).optional(),
  metric_regex: z.string().min(1).optional(),
  reward_file_path: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const benchmarkSuiteUpsertSchema = z.object({
  mutation: mutationSchema,
  suite_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  project_dir: z.string().min(1),
  isolation_mode: z.enum(["git_worktree", "copy", "none"]).default("git_worktree"),
  aggregate_metric_name: z.string().min(1).default("suite_success_rate"),
  aggregate_metric_direction: z.enum(["minimize", "maximize"]).default("maximize"),
  cases: z.array(benchmarkCaseSchema).min(1).max(100),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const benchmarkSuiteListSchema = z.object({
  enabled_only: z.boolean().optional(),
});

export const benchmarkRunSchema = z.object({
  mutation: mutationSchema,
  suite_id: z.string().min(1),
  candidate_label: z.string().min(1).default("baseline"),
  experiment_id: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  ...sourceSchema.shape,
});

function readBooleanFlag(value: unknown) {
  return value === true;
}

function readNumberFromRegex(text: string, pattern: string): number | null {
  try {
    const match = new RegExp(pattern, "m").exec(text);
    if (!match) {
      return null;
    }
    const candidate = Number(match[1] ?? match[0]);
    return Number.isFinite(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function readNumberFromRewardFile(filePath: string, workspace: string): number | null {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
    if (!fs.existsSync(resolved)) {
      return null;
    }
    const raw = fs.readFileSync(resolved, "utf8").trim();
    const candidate = Number(raw.split(/\s+/)[0]);
    return Number.isFinite(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const RETRYABLE_WORKSPACE_CLEANUP_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

export async function cleanupIsolatedWorkspaceBestEffort(
  workspace: string,
  input: {
    attempts?: number;
    retry_delay_ms?: number;
  } = {}
) {
  const attempts = Math.max(1, Math.trunc(input.attempts ?? 5));
  const retryDelayMs = Math.max(10, Math.trunc(input.retry_delay_ms ?? 100));
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(workspace, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 25,
      });
      return {
        ok: true,
        attempts: attempt + 1,
        error: null,
      };
    } catch (error) {
      if (!fs.existsSync(workspace)) {
        return {
          ok: true,
          attempts: attempt + 1,
          error: null,
        };
      }
      const code = error && typeof error === "object" ? String((error as NodeJS.ErrnoException).code ?? "") : "";
      if (!RETRYABLE_WORKSPACE_CLEANUP_CODES.has(code) || attempt + 1 >= attempts) {
        lastError = error instanceof Error ? error : new Error(String(error));
        break;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
  return {
    ok: false,
    attempts,
    error: lastError?.message ?? `failed to remove isolated workspace ${workspace}`,
  };
}

function loadBenchmarkSuites(storage: Storage) {
  return storage.getBenchmarkSuitesState() ?? {
    enabled: true,
    suites: [] as BenchmarkSuiteRecord[],
    updated_at: new Date().toISOString(),
  };
}

function resolveAggregateMetric(suite: BenchmarkSuiteRecord, caseResults: Array<{ metric_name: string; metric_value: number | null; ok: boolean }>) {
  const matching = caseResults
    .filter((entry) => entry.metric_name === suite.aggregate_metric_name && entry.metric_value !== null)
    .map((entry) => entry.metric_value as number);
  if (matching.length > 0) {
    return matching.reduce((sum, value) => sum + value, 0) / matching.length;
  }
  const okCount = caseResults.filter((entry) => entry.ok).length;
  return caseResults.length === 0 ? 0 : (okCount / caseResults.length) * 100;
}

function resolveExperimentMetricDirection(direction: ExperimentMetricDirection) {
  return direction === "minimize" ? "minimize" : "maximize";
}

function mapSuiteProjectDirToHost(suiteProjectDir: string, hostWorkspaceRoot: string) {
  const cwd = process.cwd();
  const normalizedSuiteDir = path.resolve(suiteProjectDir);
  const normalizedHostWorkspaceRoot = path.resolve(hostWorkspaceRoot || normalizedSuiteDir);
  const normalizedCwd = path.resolve(cwd);
  const hostWorkspaceLooksLegacy = normalizedHostWorkspaceRoot
    .split(path.sep)
    .some((segment) => segment === "MCPlayground---Core-Template" || segment === "SUPERPOWERS");
  if (fs.existsSync(normalizedSuiteDir) && (!fs.existsSync(normalizedHostWorkspaceRoot) || hostWorkspaceLooksLegacy)) {
    return normalizedSuiteDir;
  }
  if (!normalizedSuiteDir.startsWith(normalizedCwd)) {
    return normalizedHostWorkspaceRoot;
  }
  const relative = path.relative(normalizedCwd, normalizedSuiteDir);
  return relative && relative !== "." ? path.join(normalizedHostWorkspaceRoot, relative) : normalizedHostWorkspaceRoot;
}

async function runBenchmarkCommand(input: {
  command: string;
  timeout_seconds: number;
}) {
  const runtimeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    MASTER_MOLD_NODE_BIN: process.env.MASTER_MOLD_NODE_BIN || process.execPath,
    PATH: [runtimeDir, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
  };
  return await new Promise<{
    stdout: string;
    stderr: string;
    status: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }>((resolve) => {
    const child = spawn("/bin/sh", ["-lc", input.command], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBuffer = 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let processError: Error | null = null;
    let finished = false;
    const timeout = setTimeout(() => {
      processError = new Error(`Benchmark command timed out after ${input.timeout_seconds}s`);
      child.kill("SIGKILL");
    }, input.timeout_seconds * 1000);
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        status,
        signal,
        error: processError,
      });
    };
    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (target === "stdout") {
        stdout = (stdout + text).slice(0, maxBuffer);
        if (stdout.length >= maxBuffer) {
          processError = new Error("Benchmark stdout exceeded maxBuffer");
          child.kill("SIGKILL");
        }
        return;
      }
      stderr = (stderr + text).slice(0, maxBuffer);
      if (stderr.length >= maxBuffer) {
        processError = new Error("Benchmark stderr exceeded maxBuffer");
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));
    child.on("error", (error) => {
      processError = error instanceof Error ? error : new Error(String(error));
    });
    child.on("close", (status, signal) => finish(status, signal));
  });
}

export async function benchmarkSuiteUpsert(storage: Storage, input: z.infer<typeof benchmarkSuiteUpsertSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "benchmark.suite_upsert",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const state = loadBenchmarkSuites(storage);
      const suiteId = input.suite_id?.trim() || `benchmark-suite-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const suite: BenchmarkSuiteRecord = {
        suite_id: suiteId,
        created_at: state.suites.find((entry) => entry.suite_id === suiteId)?.created_at ?? now,
        updated_at: now,
        title: input.title.trim(),
        objective: input.objective.trim(),
        project_dir: path.resolve(input.project_dir),
        isolation_mode: input.isolation_mode,
        aggregate_metric_name: input.aggregate_metric_name.trim(),
        aggregate_metric_direction: resolveExperimentMetricDirection(input.aggregate_metric_direction),
        cases: input.cases.map((entry, index) => ({
          case_id: entry.case_id?.trim() || `case-${index + 1}`,
          title: entry.title.trim(),
          command: entry.command.trim(),
          timeout_seconds: entry.timeout_seconds ?? 600,
          required: entry.required !== false,
          metric_name: entry.metric_name?.trim() || "duration_ms",
          metric_direction: resolveExperimentMetricDirection(entry.metric_direction ?? input.aggregate_metric_direction),
          metric_mode: entry.metric_mode ?? "duration_ms",
          metric_regex: entry.metric_regex?.trim() || null,
          reward_file_path: entry.reward_file_path?.trim() || null,
          tags: [...new Set((entry.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
          metadata: entry.metadata ?? {},
        })),
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
        metadata: input.metadata ?? {},
      };

      const nextSuites = state.suites.filter((entry) => entry.suite_id !== suiteId).concat([suite]);
      const persisted = storage.setBenchmarkSuitesState({
        enabled: state.enabled,
        suites: nextSuites,
      });
      return {
        state: persisted,
        suite,
      };
    },
  });
}

export function benchmarkSuiteList(storage: Storage, _input: z.infer<typeof benchmarkSuiteListSchema>) {
  const state = loadBenchmarkSuites(storage);
  return {
    state,
    count: state.suites.length,
    suites: state.suites,
  };
}

export async function benchmarkRun(storage: Storage, input: z.infer<typeof benchmarkRunSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "benchmark.run",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const suitesState = loadBenchmarkSuites(storage);
      const suite = suitesState.suites.find((entry) => entry.suite_id === input.suite_id);
      if (!suite) {
        throw new Error(`Benchmark suite not found: ${input.suite_id}`);
      }

      const fabric = resolveEffectiveWorkerFabric(storage, {
        fallback_workspace_root: suite.project_dir,
        fallback_worker_count: 1,
        fallback_shell: "/bin/zsh",
      });
      const slots = buildWorkerFabricSlots(storage, {
        fallback_workspace_root: suite.project_dir,
        fallback_worker_count: 1,
        fallback_shell: "/bin/zsh",
      });
      const selectedSlot =
        (input.host_id ? slots.find((slot) => slot.host_id === input.host_id) : null) ??
        (fabric.default_host_id ? slots.find((slot) => slot.host_id === fabric.default_host_id) : null) ??
        slots[0];
      if (!selectedSlot) {
        throw new Error("No worker fabric hosts available for benchmark execution");
      }

      const runId = input.run_id?.trim() || `benchmark-run-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      storage.appendRunEvent({
        run_id: runId,
        event_type: "begin",
        step_index: 0,
        status: "in_progress",
        summary: `Benchmark suite ${suite.suite_id} started on host ${selectedSlot.host_id}.`,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        details: {
          suite_id: suite.suite_id,
          host_id: selectedSlot.host_id,
          isolation_mode: suite.isolation_mode,
        },
      });

      const experimentRecord =
        (input.experiment_id ? storage.getExperimentById(input.experiment_id) : null) ??
        storage.createExperiment({
          experiment_id: input.experiment_id,
          title: `${suite.title} benchmark`,
          objective: suite.objective,
          status: "active",
          metric_name: suite.aggregate_metric_name,
          metric_direction: suite.aggregate_metric_direction,
          tags: [...suite.tags, "benchmark", "eval"],
          metadata: {
            suite_id: suite.suite_id,
            source: "benchmark.run",
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        }).experiment;

      const experimentRun = storage.createExperimentRun({
        experiment_id: experimentRecord.experiment_id,
        candidate_label: input.candidate_label,
        run_id: runId,
        status: "running",
        metadata: {
          suite_id: suite.suite_id,
          host_id: selectedSlot.host_id,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }).experiment_run;

      const cleanupWorkspaces = readBooleanFlag((suite.metadata ?? {}).cleanup_workspaces);
      const caseResults = [];
      for (const [index, entry] of suite.cases.entries()) {
        const hostProjectDir = mapSuiteProjectDirToHost(suite.project_dir, selectedSlot.workspace_root);
        const plan = buildIsolatedExecutionPlan({
          base_workspace: hostProjectDir,
          command: entry.command,
          task_id: `${suite.suite_id}-${entry.case_id}-${crypto.randomUUID().slice(0, 8)}`,
          isolation_mode: suite.isolation_mode,
          cleanup_workspace: cleanupWorkspaces,
        });
        const command =
          selectedSlot.transport === "ssh"
            ? buildRemoteExecutionCommand({
                ssh_destination: selectedSlot.ssh_destination ?? "",
                script: plan.script,
              })
            : plan.script;
        const started = Date.now();
        const spawned = await runBenchmarkCommand({
          command,
          timeout_seconds: entry.timeout_seconds,
        });
        const durationMs = Date.now() - started;
        const stdout = String(spawned.stdout ?? "");
        const stderr = String(spawned.stderr ?? "");
        const metricValue =
          entry.metric_mode === "duration_ms"
            ? durationMs
            : entry.metric_mode === "stdout_regex"
              ? readNumberFromRegex(stdout, entry.metric_regex ?? "")
              : entry.metric_mode === "reward_file"
                ? readNumberFromRewardFile(entry.reward_file_path ?? "reward.txt", plan.workspace)
                : readNumberFromRegex(stderr, entry.metric_regex ?? "");
        const ok = !spawned.error && spawned.signal === null && spawned.status === 0 && metricValue !== null;

        storage.appendRunEvent({
          run_id: runId,
          event_type: "step",
          step_index: index + 1,
          status: ok ? "completed" : "failed",
          summary: `${entry.case_id} ${ok ? "passed" : "failed"} on ${selectedSlot.host_id}`,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
          details: {
            suite_id: suite.suite_id,
            case_id: entry.case_id,
            host_id: selectedSlot.host_id,
            workspace: plan.workspace,
            duration_ms: durationMs,
            metric_name: entry.metric_name,
            metric_value: metricValue,
            exit_code: spawned.status,
            signal: spawned.signal,
            stdout_excerpt: stdout.slice(0, 400),
            stderr_excerpt: stderr.slice(0, 400),
          },
        });

        caseResults.push({
          case_id: entry.case_id,
          title: entry.title,
          ok,
          required: entry.required,
          metric_name: entry.metric_name,
          metric_value: metricValue,
          duration_ms: durationMs,
          exit_code: spawned.status,
          signal: spawned.signal,
          workspace: plan.workspace,
          stdout_excerpt: stdout.slice(0, 1000),
          stderr_excerpt: stderr.slice(0, 1000),
        });

        if (
          cleanupWorkspaces &&
          selectedSlot.transport === "local" &&
          plan.workspace !== plan.base_workspace &&
          plan.workspace.includes(`${path.sep}.mcp-isolation${path.sep}`)
        ) {
          const cleanup = await cleanupIsolatedWorkspaceBestEffort(plan.workspace);
          if (!cleanup.ok) {
            console.warn(
              `[benchmark.cleanup] deferred removing ${plan.workspace}: ${cleanup.error ?? "unknown error"}`
            );
          }
        }
      }

      const aggregateMetric = resolveAggregateMetric(suite, caseResults);
      const requiredFailures = caseResults.filter((entry) => entry.required && !entry.ok);
      const observedMetrics: Record<string, unknown> = {
        suite_success_rate: caseResults.length === 0 ? 0 : (caseResults.filter((entry) => entry.ok).length / caseResults.length) * 100,
        case_results: caseResults,
      };
      for (const entry of caseResults) {
        if (entry.metric_value !== null) {
          observedMetrics[`case.${entry.case_id}.${entry.metric_name}`] = entry.metric_value;
        }
      }

      storage.recordArtifact({
        artifact_type: "benchmark.result",
        status: "active",
        run_id: runId,
        producer_kind: "tool",
        producer_id: "benchmark.run",
        trust_tier: "derived",
        content_json: {
          suite_id: suite.suite_id,
          host_id: selectedSlot.host_id,
          aggregate_metric_name: suite.aggregate_metric_name,
          aggregate_metric_value: aggregateMetric,
          case_results: caseResults,
        },
        metadata: {
          suite_id: suite.suite_id,
          experiment_id: experimentRecord.experiment_id,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });

      const finalStatus = requiredFailures.length === 0 ? "completed" : "crash";
      const summary =
        requiredFailures.length === 0
          ? `Benchmark suite ${suite.suite_id} completed with ${suite.aggregate_metric_name}: ${aggregateMetric}`
          : `Benchmark suite ${suite.suite_id} failed ${requiredFailures.length} required case(s)`;

      const updatedRun = storage.updateExperimentRun({
        experiment_run_id: experimentRun.experiment_run_id,
        status: finalStatus,
        run_id: runId,
        observed_metric: aggregateMetric,
        observed_metrics: observedMetrics,
        summary,
        error_text: requiredFailures.length === 0 ? null : requiredFailures.map((entry) => entry.case_id).join(", "),
        metadata: {
          suite_id: suite.suite_id,
          host_id: selectedSlot.host_id,
          isolation_mode: suite.isolation_mode,
        },
      }).experiment_run;

      storage.appendRunEvent({
        run_id: runId,
        event_type: "end",
        step_index: suite.cases.length + 1,
        status: requiredFailures.length === 0 ? "succeeded" : "failed",
        summary,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        details: {
          suite_id: suite.suite_id,
          aggregate_metric_name: suite.aggregate_metric_name,
          aggregate_metric_value: aggregateMetric,
          required_failures: requiredFailures.map((entry) => entry.case_id),
        },
      });

      return {
        suite,
        host: {
          host_id: selectedSlot.host_id,
          transport: selectedSlot.transport,
          workspace_root: selectedSlot.workspace_root,
        },
        experiment: experimentRecord,
        experiment_run: updatedRun,
        run_id: runId,
        started_at: now,
        completed_at: new Date().toISOString(),
        aggregate_metric_name: suite.aggregate_metric_name,
        aggregate_metric_value: aggregateMetric,
        case_results: caseResults,
        ok: requiredFailures.length === 0,
      };
    },
  });
}
