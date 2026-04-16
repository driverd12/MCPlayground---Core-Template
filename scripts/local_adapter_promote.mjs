#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertPreparedDataset } from "./local_adapter_lane.mjs";
import {
  acquireRunnerSingletonLock,
  callTool,
  loadRunnerEnv,
  repoRootFromMeta,
} from "./mcp_runner_support.mjs";

const REPO_ROOT = repoRootFromMeta(import.meta.url);
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");
const REGISTERED_ROOT = path.join(REPO_ROOT, "data", "training", "registered_adapters");
const REJECTED_ROOT = path.join(REPO_ROOT, "data", "training", "rejected_adapters");

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    transport: "stdio",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[++index] ?? "";
    } else if (token === "--transport") {
      args.transport = argv[++index] ?? "stdio";
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_promote.mjs [--manifest <path>] [--transport stdio|http]",
      "",
      "Notes:",
      "  This runs a bounded benchmark/eval gate for the latest trained local adapter and records either rejection or registration.",
    ].join("\n") + "\n"
  );
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeSlug(value, fallback = "candidate") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function readString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createMutation(candidateId, step, counter) {
  const id = `${candidateId}:${step}:${counter.value++}`;
  return {
    idempotency_key: `local-adapter-promote:${id}`,
    side_effect_fingerprint: `local-adapter-promote:${id}`,
  };
}

function latestManifestPath() {
  const registry = readJson(REGISTRY_PATH);
  const latest = Array.isArray(registry?.runs) ? registry.runs[0] : null;
  if (latest?.manifest_path && fs.existsSync(latest.manifest_path)) {
    return latest.manifest_path;
  }
  return null;
}

function resolveManifest(manifestPath) {
  const chosen = manifestPath || latestManifestPath();
  if (!chosen || !fs.existsSync(chosen)) {
    throw new Error("No trained local adapter manifest found. Run prepare and train first.");
  }
  const manifest = readJson(chosen);
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Could not read manifest at ${chosen}`);
  }
  return {
    manifestPath: chosen,
    manifest,
    runDir: path.dirname(chosen),
  };
}

function benchmarkSuiteIdForManifest(manifest) {
  return `local-adapter-benchmark-${shortHash(manifest.candidate_id || manifest.run_id || "candidate")}`;
}

function evalSuiteIdForManifest(manifest) {
  return `local-adapter-eval-${shortHash(manifest.candidate_id || manifest.run_id || "candidate")}`;
}

function buildBenchmarkSuite({ manifest, manifestPath, rewardFilePath, reportPath }) {
  const suiteId = benchmarkSuiteIdForManifest(manifest);
  const command = [
    shellQuote(process.execPath),
    shellQuote(path.join(REPO_ROOT, "scripts", "local_adapter_eval.mjs")),
    "--manifest",
    shellQuote(manifestPath),
    "--report-path",
    shellQuote(reportPath),
    "--reward-file",
    shellQuote(rewardFilePath),
  ].join(" ");
  return {
    suite_id: suiteId,
    title: `Local adapter gate for ${manifest.candidate_id}`,
    objective: "Verify that a trained local adapter is worth registering before any route integration work.",
    project_dir: REPO_ROOT,
    isolation_mode: "none",
    aggregate_metric_name: "adapter_reward_score",
    aggregate_metric_direction: "maximize",
    cases: [
      {
        case_id: "local-adapter-eval",
        title: "Adapter benchmark gate",
        command,
        timeout_seconds: 900,
        required: true,
        metric_name: "adapter_reward_score",
        metric_direction: "maximize",
        metric_mode: "reward_file",
        reward_file_path: rewardFilePath,
        tags: ["local", "mlx", "adapter", "promotion"],
      },
    ],
    tags: ["local", "mlx", "adapter", "promotion"],
    metadata: {
      source: "local_adapter_promote",
      candidate_id: manifest.candidate_id,
      manifest_path: manifestPath,
      report_path: reportPath,
      reward_file_path: rewardFilePath,
    },
  };
}

function buildEvalSuite(manifest, benchmarkSuiteId) {
  const suiteId = evalSuiteIdForManifest(manifest);
  return {
    suite_id: suiteId,
    title: `Local adapter promotion eval for ${manifest.candidate_id}`,
    objective: "Require the bounded local adapter benchmark gate to pass before registration.",
    aggregate_metric_name: "suite_success_rate",
    aggregate_metric_direction: "maximize",
    cases: [
      {
        case_id: "local-adapter-benchmark",
        title: "Local adapter benchmark gate stays green",
        kind: "benchmark_suite",
        benchmark_suite_id: benchmarkSuiteId,
        required: true,
        weight: 1,
      },
    ],
    tags: ["local", "mlx", "adapter", "promotion"],
    metadata: {
      source: "local_adapter_promote",
      candidate_id: manifest.candidate_id,
      base_model: manifest.base_model,
    },
  };
}

export function buildIntegrationConsideration(manifest, decision) {
  const accepted = decision?.status === "registered";
  const trainingTarget = manifest?.training_target && typeof manifest.training_target === "object" ? manifest.training_target : {};
  const adapterPath = String(manifest?.training_result?.adapter_path || "").trim() || null;
  const targetModelRef =
    readString(trainingTarget.resolved_model_ref) ||
    readString(trainingTarget.requested_model_ref) ||
    readString(trainingTarget.resolved_model_path);
  const targetModelPath = readString(trainingTarget.resolved_model_path);
  const architecture = detectAdapterArchitecture(manifest);
  const ollamaArchitectureSupported =
    architecture !== null && ["llama", "mistral", "mixtral", "gemma"].includes(architecture);
  const hostIsAppleSilicon = manifest?.host?.platform === "darwin" && manifest?.host?.arch === "arm64";
  const mlxEligible =
    accepted && hostIsAppleSilicon && manifest?.trainer?.trainer_ready === true && Boolean(adapterPath) && Boolean(targetModelRef);
  const ollamaEligible =
    accepted &&
    ollamaArchitectureSupported &&
    Boolean(adapterPath) &&
    Boolean(targetModelPath);
  const recommendedTarget = mlxEligible ? "mlx" : ollamaEligible ? "ollama" : null;
  const candidateId = String(manifest?.candidate_id || "candidate");
  const ollamaCompanionModel = buildOllamaCompanionName(manifest);
  return {
    recommended_target: accepted ? recommendedTarget : null,
    router: {
      eligible: mlxEligible,
      live_ready: false,
      blockers: accepted
        ? mlxEligible
          ? ["mlx_integration_pending"]
          : [
              ...(hostIsAppleSilicon ? [] : ["mlx_host_not_apple_silicon"]),
              ...(manifest?.trainer?.trainer_ready === true ? [] : ["mlx_trainer_unavailable"]),
              ...(adapterPath ? [] : ["adapter_artifacts_missing"]),
              ...(targetModelRef ? [] : ["mlx_base_model_missing"]),
            ]
        : ["candidate_not_registered"],
      planned_backend: {
        backend_id: `mlx-adapter-${sanitizeSlug(candidateId, "candidate")}`.slice(0, 96),
        provider: "mlx",
        model_id: String(targetModelRef || manifest?.base_model || "unknown"),
        locality: "local",
        host_id: "local",
        tags: ["local", "mlx", "adapter", "candidate", "apple-silicon"],
        metadata: {
          candidate_id: candidateId,
          adapter_path: adapterPath,
          companion_for_runtime_model: manifest?.base_model ?? null,
          training_target_model_path: targetModelPath,
          serving_status: mlxEligible ? "integration_pending" : "blocked",
        },
      },
    },
    ollama: {
      eligible: ollamaEligible,
      live_ready: false,
      blockers: accepted
        ? ollamaEligible
          ? ["ollama_export_pending"]
          : [
              ...(adapterPath ? [] : ["adapter_artifacts_missing"]),
              ...(targetModelPath ? [] : ["ollama_base_model_path_missing"]),
              ...(architecture === null ? ["ollama_adapter_architecture_unknown"] : []),
              ...(architecture !== null && !ollamaArchitectureSupported
                ? [`ollama_adapter_architecture_unsupported:${architecture}`]
                : []),
            ]
        : ["candidate_not_registered"],
      target_runtime_model: manifest?.base_model ?? null,
      planned_backend: {
        backend_id: `ollama-adapter-${sanitizeSlug(candidateId, "candidate")}`.slice(0, 96),
        provider: "ollama",
        model_id: ollamaCompanionModel,
        locality: "local",
        host_id: "local",
        tags: ["local", "ollama", "adapter", "candidate", "companion"],
        metadata: {
          candidate_id: candidateId,
          adapter_path: adapterPath,
          source_model_path: targetModelPath,
          companion_for_runtime_model: manifest?.base_model ?? null,
          export_status: ollamaEligible ? "pending" : "blocked",
        },
      },
    },
  };
}

export function buildOllamaCompanionName(manifest) {
  const slug = sanitizeSlug(manifest?.candidate_id, "candidate");
  return `mcp-${slug.slice(0, 48)}-${shortHash(slug)}`;
}

export function detectAdapterArchitecture(manifest) {
  const haystack = [
    manifest?.training_target?.resolved_model_ref,
    manifest?.training_target?.requested_model_ref,
    manifest?.training_target?.resolved_model_path,
    manifest?.base_model,
  ]
    .map((entry) => String(entry || "").toLowerCase())
    .join(" ");
  if (!haystack) {
    return null;
  }
  if (haystack.includes("mixtral")) return "mixtral";
  if (haystack.includes("mistral")) return "mistral";
  if (haystack.includes("llama")) return "llama";
  if (haystack.includes("gemma")) return "gemma";
  if (haystack.includes("qwen")) return "qwen";
  if (haystack.includes("phi")) return "phi";
  return null;
}

export function decidePromotion({ manifest, report, evalRun }) {
  const summary = report?.summary && typeof report.summary === "object" ? report.summary : {};
  const accepted = summary.accepted === true && evalRun?.ok === true && Number(evalRun?.aggregate_metric_value ?? 0) === 100;
  const blockers = [
    ...new Set(
      [
        ...(Array.isArray(summary.blockers) ? summary.blockers : []),
        ...(accepted ? [] : ["eval_gate_failed"]),
      ].filter(Boolean)
    ),
  ];
  return {
    status: accepted ? "registered" : "rejected",
    accepted,
    reward_score: Number(summary.reward_score ?? 0),
    baseline_score: Number(summary.baseline_score ?? 0),
    delta_score: Number(summary.delta_score ?? 0),
    blockers,
    integration_consideration: buildIntegrationConsideration(manifest, {
      status: accepted ? "registered" : "rejected",
    }),
  };
}

function updateRegistry(manifest, manifestPath, updates) {
  const registry = readJson(REGISTRY_PATH) || { runs: [] };
  const runs = Array.isArray(registry.runs) ? registry.runs : [];
  let matched = false;
  const nextRuns = runs.map((entry) => {
    if (entry?.run_id === manifest.run_id) {
      matched = true;
      return { ...entry, ...updates };
    }
    return entry;
  });
  if (!matched) {
    nextRuns.unshift({
      lane: "local_adapter_lane",
      run_id: manifest.run_id,
      candidate_id: manifest.candidate_id,
      generated_at: manifest.generated_at,
      manifest_path: manifestPath,
      ...updates,
    });
  }
  writeJson(REGISTRY_PATH, {
    schema_version: registry.schema_version || "training.model_registry.v2",
    updated_at: new Date().toISOString(),
    runs: nextRuns.slice(0, 25),
  });
}

function writeDecisionArtifact(root, manifest, payload) {
  const filePath = path.join(root, `${sanitizeSlug(manifest.candidate_id, "candidate")}.json`);
  writeJson(filePath, payload);
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadRunnerEnv(REPO_ROOT);
  const { manifestPath, manifest, runDir } = resolveManifest(args.manifestPath);
  if (manifest?.training_intent?.executed !== true) {
    throw new Error("The selected manifest has not executed a local adapter training run yet.");
  }
  const datasetAudit = assertPreparedDataset(manifest);
  const promotionDir = path.join(runDir, "promotion");
  const rewardFilePath = path.join(promotionDir, "reward.txt");
  const reportPath = path.join(promotionDir, "eval_report.json");
  const decisionPath = path.join(promotionDir, "decision.json");
  ensureDirectory(promotionDir);

  const lock = await acquireRunnerSingletonLock(
    REPO_ROOT,
    `local-adapter-promote-${sanitizeSlug(manifest.candidate_id, "candidate")}`,
    5000
  );
  if (!lock.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, skipped: true, reason: "already_running", candidate_id: manifest.candidate_id }, null, 2)}\n`
    );
    return;
  }

  try {
    const benchmarkSuite = buildBenchmarkSuite({
      manifest,
      manifestPath,
      rewardFilePath,
      reportPath,
    });
    const evalSuite = buildEvalSuite(manifest, benchmarkSuite.suite_id);
    const mutationCounter = { value: 0 };
    const transport = args.transport === "http" ? "http" : "stdio";

    callTool(REPO_ROOT, {
      tool: "benchmark.suite_upsert",
      args: {
        mutation: createMutation(manifest.candidate_id, "benchmark-suite", mutationCounter),
        ...benchmarkSuite,
      },
      transport,
    });
    callTool(REPO_ROOT, {
      tool: "eval.suite_upsert",
      args: {
        mutation: createMutation(manifest.candidate_id, "eval-suite", mutationCounter),
        ...evalSuite,
      },
      transport,
    });
    const evalRun = callTool(REPO_ROOT, {
      tool: "eval.run",
      args: {
        mutation: createMutation(manifest.candidate_id, "eval-run", mutationCounter),
        suite_id: evalSuite.suite_id,
        candidate_label: manifest.candidate_id,
      },
      transport,
    });

    const report = readJson(reportPath) || {
      generated_at: new Date().toISOString(),
      manifest_path: manifestPath,
      candidate_id: manifest.candidate_id ?? null,
      summary: {
        accepted: false,
        reward_score: 0,
        baseline_score: 0,
        delta_score: 0,
        blockers: ["promotion_report_missing"],
      },
    };
    const decision = decidePromotion({
      manifest,
      report,
      evalRun,
    });
    const artifactPayload = {
      decided_at: new Date().toISOString(),
      manifest_path: manifestPath,
      candidate_id: manifest.candidate_id,
      dataset_integrity: datasetAudit.actual || manifest?.corpus?.integrity || null,
      decision,
      benchmark_suite_id: benchmarkSuite.suite_id,
      eval_suite_id: evalSuite.suite_id,
      eval_run_id: String(evalRun?.run_id || "").trim() || null,
      report_path: reportPath,
      reward_file_path: rewardFilePath,
    };
    const registrationPath = decision.accepted
      ? writeDecisionArtifact(REGISTERED_ROOT, manifest, artifactPayload)
      : writeDecisionArtifact(REJECTED_ROOT, manifest, artifactPayload);

    manifest.promotion_result = {
      status: decision.status,
      decided_at: artifactPayload.decided_at,
      benchmark_suite_id: benchmarkSuite.suite_id,
      eval_suite_id: evalSuite.suite_id,
      eval_run_id: artifactPayload.eval_run_id,
      report_path: reportPath,
      reward_file_path: rewardFilePath,
      reward_score: decision.reward_score,
      baseline_score: decision.baseline_score,
      delta_score: decision.delta_score,
      blockers: decision.blockers,
      dataset_integrity: datasetAudit.actual || manifest?.corpus?.integrity || null,
      registration_path: registrationPath,
      integration_consideration: decision.integration_consideration,
    };
    manifest.safe_promotion_metadata = {
      ...(manifest.safe_promotion_metadata || {}),
      allowed_now: false,
      blockers: decision.accepted
        ? [
            ...decision.integration_consideration.router.blockers,
            ...decision.integration_consideration.ollama.blockers,
          ]
        : decision.blockers,
    };
    manifest.status = decision.accepted ? "adapter_registered" : "adapter_rejected";
    manifest.next_action = decision.accepted
      ? "Run `npm run local:training:integrate` to materialize the accepted adapter as a real MLX backend or Ollama companion before any live cutover."
      : "Inspect the promotion report, adjust the corpus or trainer, and rerun `npm run local:training:train` plus `npm run local:training:promote`.";
    writeJson(manifestPath, manifest);

    updateRegistry(manifest, manifestPath, {
      status: manifest.status,
      promotion_decided_at: artifactPayload.decided_at,
      promotion_status: decision.status,
      reward_score: decision.reward_score,
      baseline_score: decision.baseline_score,
      delta_score: decision.delta_score,
      promotion_report_path: reportPath,
      registration_path: registrationPath,
    });

    const output = {
      ok: decision.accepted,
      manifest_path: manifestPath,
      report_path: reportPath,
      reward_file_path: rewardFilePath,
      decision_path: decisionPath,
      registration_path: registrationPath,
      benchmark_suite_id: benchmarkSuite.suite_id,
      eval_suite_id: evalSuite.suite_id,
      eval_run_id: artifactPayload.eval_run_id,
      decision,
    };
    writeJson(decisionPath, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!decision.accepted) {
      process.exit(1);
    }
  } finally {
    lock.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
