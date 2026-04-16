#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireRunnerSingletonLock,
  callTool,
  loadRunnerEnv,
  repoRootFromMeta,
} from "./mcp_runner_support.mjs";

const RECOMMENDED_MODEL = "qwen3.5:35b-a3b-coding-nvfp4";
const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_WAIT_SECONDS = 4 * 60 * 60;
const DEFAULT_WAIT_INTERVAL_SECONDS = 20;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_PROFILE_ID = process.env.ANAMNESIS_IMPRINT_PROFILE_ID || "default";

const REPO_ROOT = repoRootFromMeta(import.meta.url);
const DIST_SERVER_PATH = path.join(REPO_ROOT, "dist", "server.js");
const REPORT_DIR = path.join(REPO_ROOT, "data", "imprint", "reports");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const DEFAULT_BENCHMARK_SUITE_ID = "autonomy.smoke.local";
const DEFAULT_EVAL_SUITE_ID = "autonomy.control-plane";
const DEFAULT_ROUTE_TASK_KIND = "planning";
const DEFAULT_PROMOTION_PREFERRED_TAGS = ["local", "ollama", "gpu", "apple-silicon"];

function parseArgs(argv) {
  const args = {
    model: "",
    endpoint: "",
    profileId: DEFAULT_PROFILE_ID,
    wait: false,
    maxWaitSeconds: DEFAULT_WAIT_SECONDS,
    waitIntervalSeconds: DEFAULT_WAIT_INTERVAL_SECONDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipImprint: false,
    skipMemory: false,
    reportPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--model") {
      args.model = argv[++index] ?? "";
    } else if (token === "--endpoint") {
      args.endpoint = argv[++index] ?? "";
    } else if (token === "--profile-id") {
      args.profileId = argv[++index] ?? DEFAULT_PROFILE_ID;
    } else if (token === "--wait") {
      args.wait = true;
    } else if (token === "--max-wait-seconds") {
      args.maxWaitSeconds = Number.parseInt(argv[++index] ?? "", 10) || DEFAULT_WAIT_SECONDS;
    } else if (token === "--wait-interval-seconds") {
      args.waitIntervalSeconds = Number.parseInt(argv[++index] ?? "", 10) || DEFAULT_WAIT_INTERVAL_SECONDS;
    } else if (token === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(argv[++index] ?? "", 10) || DEFAULT_TIMEOUT_MS;
    } else if (token === "--skip-imprint") {
      args.skipImprint = true;
    } else if (token === "--skip-memory") {
      args.skipMemory = true;
    } else if (token === "--report-path") {
      args.reportPath = argv[++index] ?? "";
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
      "  node scripts/ollama_mlx_postpull.mjs [--wait] [--model <model>] [--endpoint <url>]",
      "",
      "Examples:",
      "  node scripts/ollama_mlx_postpull.mjs --wait",
      "  node scripts/ollama_mlx_postpull.mjs --model qwen3.5:35b-a3b-coding-nvfp4",
    ].join("\n") + "\n"
  );
}

export function parseOllamaList(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^name\s+id\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0]?.trim())
    .filter(Boolean);
}

export function resolvePreferredModelOrder(primaryModel, existingModels = []) {
  const ordered = [];
  const seen = new Set();
  for (const candidate of [primaryModel, ...existingModels, "llama3.2:3b"]) {
    const value = String(candidate || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

export function summarizeCaseRuns(caseRuns) {
  const total = caseRuns.length;
  const passed = caseRuns.filter((entry) => entry.ok).length;
  const latencies = caseRuns.map((entry) => entry.latency_ms).filter((entry) => typeof entry === "number");
  const throughput = caseRuns.map((entry) => entry.throughput_tps).filter((entry) => typeof entry === "number");
  return {
    total_cases: total,
    passed_cases: passed,
    failed_cases: total - passed,
    pass_rate: total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0,
    average_latency_ms:
      latencies.length > 0
        ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2))
        : null,
    best_latency_ms: latencies.length > 0 ? Number(Math.min(...latencies).toFixed(2)) : null,
    worst_latency_ms: latencies.length > 0 ? Number(Math.max(...latencies).toFixed(2)) : null,
    average_throughput_tps:
      throughput.length > 0
        ? Number((throughput.reduce((sum, value) => sum + value, 0) / throughput.length).toFixed(4))
        : null,
  };
}

export function shouldPromoteModel(summary) {
  return Boolean(summary && summary.total_cases > 0 && summary.failed_cases === 0);
}

export function validateModelHostCompatibility({
  model,
  platform = process.platform,
  arch = process.arch,
}) {
  if (String(model || "").trim() !== RECOMMENDED_MODEL) {
    return {
      ok: true,
      requires_apple_silicon: false,
      reason: null,
    };
  }
  const ok = platform === "darwin" && arch === "arm64";
  return {
    ok,
    requires_apple_silicon: true,
    reason: ok ? null : "The Ollama MLX preview model path is Apple Silicon only.",
  };
}

function sanitizeLockSuffix(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";
}

function normalizeEndpoint(raw) {
  const value = String(raw || "").trim();
  return value ? value.replace(/\/+$/, "") : DEFAULT_ENDPOINT;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function readBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function backendIdForModel(model) {
  return `ollama-${sanitizeLockSuffix(model)}`;
}

function buildDefaultEvalSuite(primaryBackendId, preferredTags) {
  return {
    suite_id: DEFAULT_EVAL_SUITE_ID,
    title: "Autonomy control-plane eval",
    objective: "Keep the self-starting worker fabric, router, and benchmark substrate honest.",
    aggregate_metric_name: "suite_success_rate",
    aggregate_metric_direction: "maximize",
    cases: [
      {
        case_id: "autonomy-benchmark-smoke",
        title: "Autonomy smoke benchmark stays green",
        kind: "benchmark_suite",
        benchmark_suite_id: DEFAULT_BENCHMARK_SUITE_ID,
        required: true,
        weight: 1,
      },
      {
        case_id: "router-primary-planning",
        title: "Planning routes to the current primary local backend",
        kind: "router_case",
        task_kind: DEFAULT_ROUTE_TASK_KIND,
        context_tokens: 4000,
        latency_budget_ms: 2000,
        expected_backend_id: primaryBackendId,
        expected_backend_tags: [],
        preferred_tags: normalizeStringArray(preferredTags),
        required: true,
        weight: 1,
      },
    ],
    tags: ["autonomy", "control-plane", "bootstrap"],
    metadata: {
      bootstrap_source: "ollama_mlx_postpull",
      primary_backend_id: primaryBackendId,
      preferred_router_tags: normalizeStringArray(preferredTags),
    },
  };
}

function safeErrorMessage(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function callToolSafely(repoRoot, { tool, args, transport }) {
  try {
    return {
      ok: true,
      result: callTool(repoRoot, { tool, args, transport }),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      result: null,
      error: safeErrorMessage(error),
    };
  }
}

function backendHealthSummary(backend) {
  const capabilities = backend?.capabilities && typeof backend.capabilities === "object" ? backend.capabilities : {};
  return {
    backend_id: String(backend?.backend_id || "").trim() || null,
    model_id: String(backend?.model_id || "").trim() || null,
    enabled: backend?.enabled !== false,
    probe_healthy: readBoolean(capabilities.probe_healthy),
    model_known: readBoolean(capabilities.probe_model_known),
    model_loaded: readBoolean(capabilities.probe_model_loaded),
    benchmark_ok: readBoolean(capabilities.probe_benchmark_ok),
    throughput_tps: readNumber(backend?.throughput_tps) ?? readNumber(capabilities.probe_throughput_tps),
    latency_ms_p50: readNumber(backend?.latency_ms_p50) ?? readNumber(capabilities.probe_benchmark_latency_ms),
    probe_error: String(capabilities.probe_error || "").trim() || null,
    tags: normalizeStringArray(backend?.tags),
  };
}

function summarizeOfficeTruth(officeSnapshot, officeSnapshotError) {
  if (officeSnapshotError) {
    return {
      ok: false,
      blockers: ["office.snapshot_unavailable"],
      generated_at: null,
      error: officeSnapshotError,
      fallback: {},
      provider_bridge: {},
      desktop_control: {},
      patient_zero: {},
      launchers: {},
      next_actions: [],
    };
  }
  const setupDiagnostics =
    officeSnapshot?.setup_diagnostics && typeof officeSnapshot.setup_diagnostics === "object"
      ? officeSnapshot.setup_diagnostics
      : null;
  if (!setupDiagnostics) {
    return {
      ok: false,
      blockers: ["office.setup_diagnostics_missing"],
      generated_at: String(officeSnapshot?.generated_at || "").trim() || null,
      error: null,
      fallback: {},
      provider_bridge: {},
      desktop_control: {},
      patient_zero: {},
      launchers: {},
      next_actions: [],
    };
  }

  const fallback =
    setupDiagnostics.fallback && typeof setupDiagnostics.fallback === "object" ? setupDiagnostics.fallback : {};
  const providerBridge =
    setupDiagnostics.provider_bridge && typeof setupDiagnostics.provider_bridge === "object"
      ? setupDiagnostics.provider_bridge
      : {};
  const desktopControl =
    setupDiagnostics.desktop_control && typeof setupDiagnostics.desktop_control === "object"
      ? setupDiagnostics.desktop_control
      : {};
  const patientZero =
    setupDiagnostics.patient_zero && typeof setupDiagnostics.patient_zero === "object"
      ? setupDiagnostics.patient_zero
      : {};
  const launchers = setupDiagnostics.launchers && typeof setupDiagnostics.launchers === "object" ? setupDiagnostics.launchers : {};
  const officeGuiLauncher = launchers.office_gui && typeof launchers.office_gui === "object" ? launchers.office_gui : {};
  const agenticSuiteLauncher =
    launchers.agentic_suite && typeof launchers.agentic_suite === "object" ? launchers.agentic_suite : {};
  const blockers = [];

  if (fallback.core_usable === false) blockers.push("office.core_unusable");
  if (providerBridge.stale === true) blockers.push("office.provider_bridge_stale");
  if (fallback.provider_bridge_degraded === true) blockers.push("office.provider_bridge_degraded");
  if (fallback.desktop_degraded === true) blockers.push("office.desktop_degraded");
  if (patientZero.enabled === true && patientZero.browser_ready === false) blockers.push("office.browser_degraded");
  if (officeGuiLauncher.supported === true && officeGuiLauncher.ready !== true) blockers.push("office.office_gui_not_ready");
  if (officeGuiLauncher.degraded === true) blockers.push("office.office_gui_degraded");
  if (agenticSuiteLauncher.supported === true && agenticSuiteLauncher.ready !== true) blockers.push("office.agentic_suite_not_ready");
  if (agenticSuiteLauncher.degraded === true) blockers.push("office.agentic_suite_degraded");

  return {
    ok: blockers.length === 0,
    blockers,
    generated_at: String(officeSnapshot?.generated_at || "").trim() || null,
    error: null,
    fallback,
    provider_bridge: providerBridge,
    desktop_control: desktopControl,
    patient_zero: patientZero,
    launchers: {
      office_gui: officeGuiLauncher,
      agentic_suite: agenticSuiteLauncher,
    },
    next_actions: normalizeStringArray(setupDiagnostics.next_actions),
  };
}

export function selectRollbackTarget({ routerState, routeResult, candidateBackendId, currentModel }) {
  const backends = Array.isArray(routerState?.backends) ? routerState.backends : [];
  const healthyLocalOllama = backends.filter((backend) => {
    if (String(backend?.backend_id || "") === String(candidateBackendId || "")) {
      return false;
    }
    if (backend?.enabled === false || String(backend?.provider || "") !== "ollama") {
      return false;
    }
    const health = backendHealthSummary(backend);
    return health.probe_healthy === true && health.model_loaded === true;
  });
  const preferredModelOrder = resolvePreferredModelOrder(currentModel, ["llama3.2:3b"]);
  for (const modelId of preferredModelOrder) {
    const match = healthyLocalOllama.find((backend) => String(backend?.model_id || "") === modelId);
    if (match) {
      return {
        model: String(match.model_id),
        backend_id: String(match.backend_id),
      };
    }
  }
  const fallback = healthyLocalOllama[0];
  if (fallback) {
    return {
      model: String(fallback.model_id),
      backend_id: String(fallback.backend_id),
    };
  }
  const rankedBackends = Array.isArray(routeResult?.ranked_backends) ? routeResult.ranked_backends : [];
  const rankedFallback = rankedBackends
    .map((entry) => entry?.backend)
    .find(
      (backend) =>
        String(backend?.backend_id || "") !== String(candidateBackendId || "") &&
        String(backend?.provider || "") === "ollama"
    );
  return rankedFallback
    ? {
        model: String(rankedFallback.model_id),
        backend_id: String(rankedFallback.backend_id),
      }
    : null;
}

export function evaluatePromotionGate({
  model,
  summary,
  benchmarkRun,
  evalRun,
  routerStatus,
  routeResult,
  bootstrapStatus,
  officeSnapshot,
  officeSnapshotError,
  currentModel,
}) {
  const candidateBackendId = backendIdForModel(model);
  const routerState = routerStatus?.state && typeof routerStatus.state === "object" ? routerStatus.state : {};
  const backends = Array.isArray(routerState.backends) ? routerState.backends : [];
  const candidateBackend = backends.find((backend) => String(backend?.backend_id || "") === candidateBackendId) ?? null;
  const candidate = backendHealthSummary(candidateBackend);
  const rollbackTarget = selectRollbackTarget({
    routerState,
    routeResult,
    candidateBackendId,
    currentModel,
  });
  const selectedBackendId = String(routeResult?.selected_backend?.backend_id || "").trim() || null;
  const topRankedBackendId =
    String(routeResult?.ranked_backends?.[0]?.backend?.backend_id || "").trim() || selectedBackendId;
  const repairsNeeded = normalizeStringArray(bootstrapStatus?.repairs_needed);
  const benchmarkOk = benchmarkRun?.ok === true && readNumber(benchmarkRun?.aggregate_metric_value) === 100;
  const evalOk = evalRun?.ok === true && readNumber(evalRun?.aggregate_metric_value) === 100;
  const currentDefaultBackendId = String(routerState.default_backend_id || "").trim() || null;
  const currentModelBackendId = backendIdForModel(currentModel);
  const candidateIsCurrentDefault =
    currentDefaultBackendId === candidateBackendId || String(currentModel || "").trim() === String(model || "").trim();
  const officeTruth = summarizeOfficeTruth(officeSnapshot, officeSnapshotError);

  const blockers = [];
  if (!shouldPromoteModel(summary)) blockers.push("capability_soak.failed");
  if (!benchmarkOk) blockers.push("benchmark.failed");
  if (!evalOk) blockers.push("eval.failed");
  blockers.push(...officeTruth.blockers);
  if (!candidate.backend_id) blockers.push("router.backend_missing");
  if (candidate.probe_healthy === false) blockers.push("router.candidate_probe_unhealthy");
  if (candidate.model_known === false) blockers.push("router.candidate_model_unknown");
  if (candidate.model_loaded === false) blockers.push("router.candidate_model_unloaded");
  if (candidate.benchmark_ok === false) blockers.push("router.candidate_benchmark_failed");
  if (selectedBackendId !== candidateBackendId || topRankedBackendId !== candidateBackendId) {
    blockers.push("router.route_not_candidate");
  }
  if (!rollbackTarget) blockers.push("rollback.target_unavailable");
  if (candidateIsCurrentDefault && repairsNeeded.includes("eval.suite.default_drift")) {
    blockers.push("eval.default_drift");
  }
  if (repairsNeeded.includes("benchmark.suite.missing_default")) blockers.push("benchmark.default_missing");
  if (repairsNeeded.includes("eval.suite.missing_default")) blockers.push("eval.default_missing");
  if (repairsNeeded.includes("model.router.local_backend_missing")) blockers.push("router.local_backend_missing");
  if (repairsNeeded.includes("model.router.local_backend_stale")) blockers.push("router.local_backend_stale");

  return {
    ready: blockers.length === 0,
    blockers,
    candidate_backend_id: candidateBackendId,
    evidence: {
      capability_soak: {
        ok: shouldPromoteModel(summary),
        pass_rate: readNumber(summary?.pass_rate),
        failed_cases: readNumber(summary?.failed_cases),
        total_cases: readNumber(summary?.total_cases),
      },
      benchmark: {
        ok: benchmarkOk,
        suite_id: String(benchmarkRun?.suite?.suite_id || "") || DEFAULT_BENCHMARK_SUITE_ID,
        aggregate_metric_value: readNumber(benchmarkRun?.aggregate_metric_value),
        run_id: String(benchmarkRun?.run_id || "").trim() || null,
      },
      eval: {
        ok: evalOk,
        suite_id: String(evalRun?.suite?.suite_id || "") || DEFAULT_EVAL_SUITE_ID,
        aggregate_metric_value: readNumber(evalRun?.aggregate_metric_value),
        run_id: String(evalRun?.run_id || "").trim() || null,
      },
      office_truth: officeTruth,
      candidate,
      route: {
        selected_backend_id: selectedBackendId,
        top_ranked_backend_id: topRankedBackendId,
      },
      rollback: {
        available: Boolean(rollbackTarget),
        model: rollbackTarget?.model ?? null,
        backend_id: rollbackTarget?.backend_id ?? null,
      },
      bootstrap: {
        default_backend_id: currentDefaultBackendId,
        current_model_backend_id: currentModelBackendId,
        repairs_needed: repairsNeeded,
      },
    },
  };
}

function createMutation(label, counterRef) {
  counterRef.value += 1;
  return {
    idempotency_key: `ollama-mlx-postpull-${label}-${Date.now()}-${counterRef.value}`,
    side_effect_fingerprint: `ollama-mlx-postpull-${label}-${counterRef.value}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function ensureServerBuild() {
  if (fs.existsSync(DIST_SERVER_PATH)) {
    return;
  }
  const result = spawnSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error("npm run build failed while preparing the imprint pipeline");
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildCases() {
  return [
    {
      case_id: "exact-ready",
      title: "Exact ready response",
      prompt: "Reply with exactly the single word ready. Do not add punctuation or any other text.",
      validate(text) {
        return { ok: String(text || "").trim().toLowerCase() === "ready" };
      },
    },
    {
      case_id: "strict-json",
      title: "Strict JSON operator brief",
      prompt:
        "Return only minified JSON with keys status,risk,next_action. status must be ok. risk must be 7 words or fewer. next_action must be 7 words or fewer.",
      validate(text) {
        const parsed = extractJson(text);
        const risk = String(parsed?.risk ?? "").trim();
        const nextAction = String(parsed?.next_action ?? "").trim();
        return {
          ok:
            Boolean(parsed) &&
            parsed?.status === "ok" &&
            risk.length > 0 &&
            nextAction.length > 0 &&
            risk.split(/\s+/).filter(Boolean).length <= 7 &&
            nextAction.split(/\s+/).filter(Boolean).length <= 7,
        };
      },
    },
    {
      case_id: "js-add-function",
      title: "JavaScript function synthesis",
      prompt:
        "Return only JavaScript code for function add(a, b) that returns the numeric sum. No markdown fences. No explanation.",
      validate(text) {
        const code = String(text || "").trim();
        return {
          ok:
            /function\s+add\s*\(\s*a\s*,\s*b\s*\)/.test(code) &&
            /return\s+\(?\s*a\s*\+\s*b\s*\)?\s*;?/.test(code),
        };
      },
    },
    {
      case_id: "shell-node-version",
      title: "Operator shell command discipline",
      prompt:
        "Return one shell command, and nothing else, that prints the installed Node version on macOS or Linux.",
      validate(text) {
        return { ok: /^node\s+(?:-v|--version)$/.test(String(text || "").trim()) };
      },
    },
    {
      case_id: "hardening-bullets",
      title: "Hardening priorities summary",
      prompt:
        "List exactly three hardening priorities for a local-first MCP control plane. Output exactly three lines, each starting with '- '. No intro.",
      validate(text) {
        const lines = String(text || "")
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        return { ok: lines.length === 3 && lines.every((line) => line.startsWith("- ")) };
      },
    },
  ];
}

async function ollamaGenerate({ endpoint, model, prompt, timeoutMs }) {
  const startedAt = Date.now();
  const response = await fetch(`${endpoint}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        num_predict: 160,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${raw.slice(0, 240)}`);
  }
  const payload = raw.length > 0 ? JSON.parse(raw) : {};
  const latencyMs = Number(Math.max(1, Date.now() - startedAt).toFixed(2));
  const evalCount = Number.isFinite(payload.eval_count) ? Number(payload.eval_count) : null;
  const evalDurationNs = Number.isFinite(payload.eval_duration) ? Number(payload.eval_duration) : null;
  return {
    text: String(payload.response || "").trim(),
    latency_ms: latencyMs,
    total_duration_ms:
      Number.isFinite(payload.total_duration) && payload.total_duration > 0
        ? Number((payload.total_duration / 1_000_000).toFixed(2))
        : null,
    eval_count: evalCount,
    throughput_tps:
      evalCount !== null && evalDurationNs !== null && evalDurationNs > 0
        ? Number((evalCount / (evalDurationNs / 1_000_000_000)).toFixed(4))
        : null,
  };
}

function waitMessage(model, elapsedSeconds, maxWaitSeconds) {
  return `[ollama:mlx:postpull] Waiting for ${model} (${elapsedSeconds}s / ${maxWaitSeconds}s)`;
}

async function waitForOllamaEndpointReady(endpoint, maxWaitSeconds, intervalSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/api/version`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.max(1000, intervalSeconds * 1000)),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling
    }
    await sleep(intervalSeconds * 1000);
  }
  return false;
}

async function waitForModelInstalled(model, maxWaitSeconds, intervalSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastBucket = -1;
  while (Date.now() < deadline) {
    const listResult = runCapture("ollama", ["list"]);
    if (listResult.status === 0 && parseOllamaList(listResult.stdout).includes(model)) {
      return true;
    }
    const elapsed = Math.max(0, Math.round((maxWaitSeconds * 1000 - (deadline - Date.now())) / 1000));
    const bucket = Math.floor(elapsed / Math.max(1, intervalSeconds));
    if (bucket !== lastBucket) {
      console.log(waitMessage(model, elapsed, maxWaitSeconds));
      lastBucket = bucket;
    }
    await sleep(intervalSeconds * 1000);
  }
  return false;
}

async function runCapabilitySoak({ endpoint, model, timeoutMs }) {
  const caseRuns = [];
  for (const caseDef of buildCases()) {
    try {
      const generated = await ollamaGenerate({
        endpoint,
        model,
        prompt: caseDef.prompt,
        timeoutMs,
      });
      const validation = caseDef.validate(generated.text);
      caseRuns.push({
        case_id: caseDef.case_id,
        title: caseDef.title,
        ok: Boolean(validation.ok),
        latency_ms: generated.latency_ms,
        total_duration_ms: generated.total_duration_ms,
        throughput_tps: generated.throughput_tps,
        response_preview: generated.text.slice(0, 240),
        eval_count: generated.eval_count,
        error: null,
      });
    } catch (error) {
      caseRuns.push({
        case_id: caseDef.case_id,
        title: caseDef.title,
        ok: false,
        latency_ms: null,
        total_duration_ms: null,
        throughput_tps: null,
        response_preview: "",
        eval_count: null,
        error: safeErrorMessage(error),
      });
    }
  }
  return caseRuns;
}

function writeReport(reportPath, payload) {
  ensureDirectory(path.dirname(reportPath));
  fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readEnvValue(key) {
  try {
    const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) {
        continue;
      }
      const [rawKey, ...rest] = line.split("=");
      if (String(rawKey || "").trim() === key) {
        return rest.join("=").trim() || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function upsertEnv(updates) {
  const existingLines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const output = [];
  for (const line of existingLines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      output.push(line);
      continue;
    }
    const key = line.split("=", 1)[0].trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      output.push(`${key}=${updates[key]}`);
      seen.add(key);
    } else {
      output.push(line);
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(
    ENV_PATH,
    `${output.filter((line, index, arr) => !(index === arr.length - 1 && line === "")).join("\n")}\n`,
    "utf8"
  );
}

function setEnvValues(updates) {
  upsertEnv(updates);
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value);
  }
}

let officeSnapshotRuntimePromise = null;

async function readOfficeTruthSnapshotDirect() {
  ensureServerBuild();
  loadRunnerEnv(REPO_ROOT);
  if (!officeSnapshotRuntimePromise) {
    officeSnapshotRuntimePromise = Promise.all([
      import(pathToFileURL(path.join(REPO_ROOT, "dist", "storage.js")).href),
      import(pathToFileURL(path.join(REPO_ROOT, "dist", "tools", "office_snapshot.js")).href),
    ]);
  }
  const [{ Storage }, { officeSnapshot }] = await officeSnapshotRuntimePromise;
  const dbPath = process.env.ANAMNESIS_HUB_DB_PATH || path.join(REPO_ROOT, "data", "hub.sqlite");
  const storage = new Storage(dbPath);
  const snapshot = officeSnapshot(storage, {
    thread_id: "ring-leader-main",
    turn_limit: 1,
    task_limit: 1,
    session_limit: 1,
    event_limit: 1,
    learning_limit: 1,
    runtime_worker_limit: 1,
    include_kernel: true,
    include_learning: false,
    include_bus: false,
    include_adapter: false,
    include_runtime_workers: false,
  });
  return {
    generated_at: snapshot?.generated_at ?? null,
    setup_diagnostics: snapshot?.setup_diagnostics ?? null,
  };
}

async function collectPromotionEvidence({ model, summary, currentModel }) {
  ensureServerBuild();
  loadRunnerEnv(REPO_ROOT);
  const transport = "stdio";
  const mutationCounter = { value: 0 };
  const benchmark = callToolSafely(REPO_ROOT, {
    tool: "benchmark.run",
    args: {
      mutation: createMutation("benchmark-run", mutationCounter),
      suite_id: DEFAULT_BENCHMARK_SUITE_ID,
      candidate_label: backendIdForModel(model),
    },
    transport,
  });
  const evalRun = callToolSafely(REPO_ROOT, {
    tool: "eval.run",
    args: {
      mutation: createMutation("eval-run", mutationCounter),
      suite_id: DEFAULT_EVAL_SUITE_ID,
      candidate_label: backendIdForModel(model),
    },
    transport,
  });
  const routerStatus = callToolSafely(REPO_ROOT, {
    tool: "model.router",
    args: {
      action: "status",
      task_kind: DEFAULT_ROUTE_TASK_KIND,
      preferred_tags: DEFAULT_PROMOTION_PREFERRED_TAGS,
      context_tokens: 4000,
      latency_budget_ms: 2000,
    },
    transport,
  });
  const routeResult = callToolSafely(REPO_ROOT, {
    tool: "model.router",
    args: {
      action: "route",
      task_kind: DEFAULT_ROUTE_TASK_KIND,
      preferred_tags: DEFAULT_PROMOTION_PREFERRED_TAGS,
      context_tokens: 4000,
      latency_budget_ms: 2000,
    },
    transport,
  });
  const bootstrapStatus = callToolSafely(REPO_ROOT, {
    tool: "autonomy.bootstrap",
    args: {
      action: "status",
      local_host_id: "local",
    },
    transport,
  });
  let officeSnapshotResult = null;
  let officeSnapshotError = null;
  try {
    officeSnapshotResult = await readOfficeTruthSnapshotDirect();
  } catch (error) {
    officeSnapshotError = safeErrorMessage(error);
  }

  return {
    benchmark_run: benchmark.result,
    benchmark_error: benchmark.error,
    eval_run: evalRun.result,
    eval_error: evalRun.error,
    router_status: routerStatus.result,
    router_error: routerStatus.error,
    route_result: routeResult.result,
    route_error: routeResult.error,
    bootstrap_status: bootstrapStatus.result,
    bootstrap_error: bootstrapStatus.error,
    office_snapshot: officeSnapshotResult,
    office_error: officeSnapshotError,
    gate: evaluatePromotionGate({
      model,
      summary,
      benchmarkRun: benchmark.result,
      evalRun: evalRun.result,
      routerStatus: routerStatus.result,
      routeResult: routeResult.result,
      bootstrapStatus: bootstrapStatus.result,
      officeSnapshot: officeSnapshotResult,
      officeSnapshotError: officeSnapshotError,
      currentModel,
    }),
  };
}

function preferredTagsForBackend(backend) {
  const tags = normalizeStringArray(backend?.tags);
  const preferred = tags.filter((tag) =>
    ["local", "ollama", "gpu", "metal", "apple-silicon", "primary"].includes(tag)
  );
  return preferred.length > 0 ? preferred : DEFAULT_PROMOTION_PREFERRED_TAGS;
}

function rollbackCutover({ rollbackModel, rollbackBackendId, rollbackPreferredTags, mutationCounter }) {
  if (!rollbackModel || !rollbackBackendId) {
    return {
      restored: false,
      reason: "No healthy rollback model was available.",
    };
  }
  setEnvValues({
    TRICHAT_OLLAMA_MODEL: rollbackModel,
    TRICHAT_LOCAL_INFERENCE_PROVIDER: "auto",
  });
  const router = callToolSafely(REPO_ROOT, {
    tool: "model.router",
    args: {
      action: "configure",
      mutation: createMutation("rollback-router-configure", mutationCounter),
      enabled: true,
      strategy: "prefer_quality",
      default_backend_id: rollbackBackendId,
    },
    transport: "stdio",
  });
  const suite = buildDefaultEvalSuite(rollbackBackendId, rollbackPreferredTags);
  const evalSuite = callToolSafely(REPO_ROOT, {
    tool: "eval.suite_upsert",
    args: {
      mutation: createMutation("rollback-eval-suite", mutationCounter),
      suite_id: suite.suite_id,
      title: suite.title,
      objective: suite.objective,
      aggregate_metric_name: suite.aggregate_metric_name,
      aggregate_metric_direction: suite.aggregate_metric_direction,
      cases: suite.cases,
      tags: suite.tags,
      metadata: suite.metadata,
    },
    transport: "stdio",
  });
  return {
    restored: router.ok && evalSuite.ok,
    router_error: router.error,
    eval_error: evalSuite.error,
  };
}

async function applyCutoverDecision(model, summary, promotionEvidence) {
  const previousModel = String(
    readEnvValue("TRICHAT_OLLAMA_MODEL") || process.env.TRICHAT_OLLAMA_MODEL || ""
  ).trim() || null;
  const gate = promotionEvidence?.gate ?? { ready: false, blockers: ["promotion.gate_missing"], evidence: {} };
  if (!gate.ready) {
    return {
      attempted: false,
      promoted: false,
      rolled_back: false,
      previous_model: previousModel,
      active_model: previousModel,
      rollback_model: gate?.evidence?.rollback?.model ?? null,
      blockers: gate.blockers,
      reason: "Promotion gate did not clear; kept the current local model unchanged.",
    };
  }

  const routerState = promotionEvidence?.router_status?.state ?? {};
  const routerBackends = Array.isArray(routerState.backends) ? routerState.backends : [];
  const candidateBackend = routerBackends.find((backend) => String(backend?.backend_id || "") === gate.candidate_backend_id) ?? null;
  const rollbackBackendId = String(gate?.evidence?.rollback?.backend_id || "").trim() || null;
  const rollbackModel = String(gate?.evidence?.rollback?.model || "").trim() || previousModel;
  const rollbackBackend = routerBackends.find((backend) => String(backend?.backend_id || "") === rollbackBackendId) ?? null;
  const mutationCounter = { value: 100 };

  setEnvValues({
    TRICHAT_OLLAMA_MODEL: model,
    TRICHAT_LOCAL_INFERENCE_PROVIDER: "auto",
  });

  const routerConfigure = callToolSafely(REPO_ROOT, {
    tool: "model.router",
    args: {
      action: "configure",
      mutation: createMutation("cutover-router-configure", mutationCounter),
      enabled: true,
      strategy: "prefer_quality",
      default_backend_id: gate.candidate_backend_id,
    },
    transport: "stdio",
  });
  const evalSuite = buildDefaultEvalSuite(gate.candidate_backend_id, preferredTagsForBackend(candidateBackend));
  const evalSuiteUpsert = callToolSafely(REPO_ROOT, {
    tool: "eval.suite_upsert",
    args: {
      mutation: createMutation("cutover-eval-suite", mutationCounter),
      suite_id: evalSuite.suite_id,
      title: evalSuite.title,
      objective: evalSuite.objective,
      aggregate_metric_name: evalSuite.aggregate_metric_name,
      aggregate_metric_direction: evalSuite.aggregate_metric_direction,
      cases: evalSuite.cases,
      tags: evalSuite.tags,
      metadata: evalSuite.metadata,
    },
    transport: "stdio",
  });
  const postCutoverEval = callToolSafely(REPO_ROOT, {
    tool: "eval.run",
    args: {
      mutation: createMutation("cutover-post-eval", mutationCounter),
      suite_id: DEFAULT_EVAL_SUITE_ID,
      candidate_label: gate.candidate_backend_id,
    },
    transport: "stdio",
  });
  const postCutoverRoute = callToolSafely(REPO_ROOT, {
    tool: "model.router",
    args: {
      action: "route",
      task_kind: DEFAULT_ROUTE_TASK_KIND,
      preferred_tags: DEFAULT_PROMOTION_PREFERRED_TAGS,
      context_tokens: 4000,
      latency_budget_ms: 2000,
    },
    transport: "stdio",
  });
  const postCutoverBootstrap = callToolSafely(REPO_ROOT, {
    tool: "autonomy.bootstrap",
    args: {
      action: "status",
      local_host_id: "local",
    },
    transport: "stdio",
  });
  let postCutoverOfficeSnapshotResult = null;
  let postCutoverOfficeSnapshotError = null;
  try {
    postCutoverOfficeSnapshotResult = await readOfficeTruthSnapshotDirect();
  } catch (error) {
    postCutoverOfficeSnapshotError = safeErrorMessage(error);
  }

  const postSelectedBackendId =
    String(postCutoverRoute.result?.selected_backend?.backend_id || "").trim() || null;
  const postRepairs = normalizeStringArray(postCutoverBootstrap.result?.repairs_needed);
  const postCutoverOfficeTruth = summarizeOfficeTruth(
    postCutoverOfficeSnapshotResult,
    postCutoverOfficeSnapshotError
  );
  const cutoverVerified =
    routerConfigure.ok &&
    evalSuiteUpsert.ok &&
    postCutoverEval.ok &&
    postCutoverEval.result?.ok === true &&
    postSelectedBackendId === gate.candidate_backend_id &&
    !postRepairs.includes("eval.suite.default_drift") &&
    postCutoverOfficeTruth.ok;

  if (cutoverVerified) {
    return {
      attempted: true,
      promoted: true,
      rolled_back: false,
      previous_model: previousModel,
      active_model: model,
      rollback_model: rollbackModel,
      blockers: [],
      reason: "Promotion gate passed; updated .env, router default, and eval suite, then verified the cutover.",
      post_cutover: {
        eval_run_id: String(postCutoverEval.result?.run_id || "").trim() || null,
        selected_backend_id: postSelectedBackendId,
        repairs_needed: postRepairs,
        office_truth: postCutoverOfficeTruth,
      },
    };
  }

  const rollback = rollbackCutover({
    rollbackModel,
    rollbackBackendId,
    rollbackPreferredTags: preferredTagsForBackend(rollbackBackend),
    mutationCounter,
  });
  return {
    attempted: true,
    promoted: false,
    rolled_back: rollback.restored,
    previous_model: previousModel,
    active_model: rollback.restored ? rollbackModel : model,
    rollback_model: rollbackModel,
    blockers: [...gate.blockers, "cutover.post_verification_failed"],
    reason: "Promotion gate passed pre-cutover, but post-cutover verification failed and the rollback path was invoked.",
    post_cutover: {
      router_error: routerConfigure.error,
      eval_suite_error: evalSuiteUpsert.error,
      eval_error: postCutoverEval.error,
      selected_backend_id: postSelectedBackendId,
      repairs_needed: postRepairs,
      office_truth: postCutoverOfficeTruth,
      rollback,
    },
  };
}

async function runImprintPersistence({
  model,
  primaryPreferredModel,
  reportPath,
  summary,
  profileId,
  skipMemory,
}) {
  ensureServerBuild();
  loadRunnerEnv(REPO_ROOT);
  const mutationCounter = { value: 0 };
  const existingProfile = callTool(REPO_ROOT, {
    tool: "imprint.profile_get",
    args: { profile_id: profileId },
    transport: "stdio",
  });
  const preferredModels = resolvePreferredModelOrder(
    primaryPreferredModel,
    [model, ...(existingProfile.profile?.preferred_models ?? [])]
  );
  const profile = callTool(REPO_ROOT, {
    tool: "imprint.profile_set",
    args: {
      mutation: createMutation("imprint-profile-set", mutationCounter),
      profile_id: profileId,
      title: existingProfile.profile?.title ?? "Dan Driver Imprint",
      mission:
        existingProfile.profile?.mission ??
        "Reduce friction between thought and execution while preserving local-first continuity.",
      principles:
        existingProfile.profile?.principles?.length > 0
          ? existingProfile.profile.principles
          : [
              "Local-first by default",
              "Idempotent mutations only",
              "Prefer truthful capability signals",
              "Preserve operator-visible continuity",
            ],
      hard_constraints: Array.isArray(existingProfile.profile?.hard_constraints)
        ? existingProfile.profile.hard_constraints
        : [],
      preferred_models: preferredModels,
      project_roots: [
        ...new Set([
          REPO_ROOT,
          ...(Array.isArray(existingProfile.profile?.project_roots) ? existingProfile.profile.project_roots : []),
        ]),
      ],
      source_client: "ollama_mlx_postpull.mjs",
    },
    transport: "stdio",
  });

  const imprintTags = ["ollama", "apple-silicon", "capability-soak"];
  if (model === RECOMMENDED_MODEL) {
    imprintTags.push("mlx-preview");
  }

  let memory = null;
  if (!skipMemory) {
    memory = callTool(REPO_ROOT, {
      tool: "memory.append",
      args: {
        mutation: createMutation("memory-append", mutationCounter),
        content: [
          `Local Ollama capability soak for ${model} on ${os.hostname()} completed.`,
          `Pass rate: ${summary.pass_rate}% (${summary.passed_cases}/${summary.total_cases}).`,
          `Average latency: ${summary.average_latency_ms ?? "n/a"} ms.`,
          `Average throughput: ${summary.average_throughput_tps ?? "n/a"} tokens/s.`,
          `Report: ${reportPath}`,
        ].join(" "),
        keywords: [...imprintTags, model.toLowerCase()],
      },
      transport: "stdio",
    });
  }

  const snapshot = callTool(REPO_ROOT, {
    tool: "imprint.snapshot",
    args: {
      mutation: createMutation("imprint-snapshot", mutationCounter),
      profile_id: profileId,
      summary: `Post-pull local Ollama soak for ${model}: ${summary.passed_cases}/${summary.total_cases} passed, avg latency ${summary.average_latency_ms ?? "n/a"} ms.`,
      tags: imprintTags,
      include_recent_memories: 20,
      include_recent_transcript_lines: 20,
      write_file: true,
      promote_summary: true,
      source_client: "ollama_mlx_postpull.mjs",
    },
    transport: "stdio",
  });

  const bootstrap = callTool(REPO_ROOT, {
    tool: "imprint.bootstrap",
    args: {
      profile_id: profileId,
      max_memories: 20,
      max_transcript_lines: 20,
      max_snapshots: 5,
    },
    transport: "stdio",
  });

  return {
    profile,
    memory,
    snapshot,
    bootstrap_preview: String(bootstrap.bootstrap_text ?? "")
      .split("\n")
      .slice(0, 20)
      .join("\n"),
    preferred_models: preferredModels,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model =
    String(args.model || process.env.TRICHAT_OLLAMA_MODEL || RECOMMENDED_MODEL).trim() || RECOMMENDED_MODEL;
  const endpoint = normalizeEndpoint(args.endpoint || process.env.TRICHAT_OLLAMA_URL);
  const hostCompatibility = validateModelHostCompatibility({ model });
  const reportPath =
    args.reportPath ||
    path.join(REPORT_DIR, `ollama-capability-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  if (!hostCompatibility.ok) {
    throw new Error(hostCompatibility.reason);
  }

  ensureDirectory(REPORT_DIR);
  const lock = await acquireRunnerSingletonLock(
    REPO_ROOT,
    `ollama-postpull-${sanitizeLockSuffix(model)}`,
    500
  );
  if (!lock.ok) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason: "already_running",
          model,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  try {
    const currentModel =
      String(readEnvValue("TRICHAT_OLLAMA_MODEL") || process.env.TRICHAT_OLLAMA_MODEL || model).trim() || model;
    const installedNow = parseOllamaList(runCapture("ollama", ["list"]).stdout).includes(model);
    if (!installedNow) {
      if (!args.wait) {
        throw new Error(`Model is not installed yet: ${model}`);
      }
      const installed = await waitForModelInstalled(model, args.maxWaitSeconds, args.waitIntervalSeconds);
      if (!installed) {
        throw new Error(`Timed out waiting for model install: ${model}`);
      }
    }

    const endpointReady = args.wait
      ? await waitForOllamaEndpointReady(endpoint, Math.min(120, args.maxWaitSeconds), Math.min(5, args.waitIntervalSeconds))
      : true;
    if (!endpointReady) {
      throw new Error(`Timed out waiting for Ollama endpoint readiness: ${endpoint}`);
    }

    const caseRuns = await runCapabilitySoak({
      endpoint,
      model,
      timeoutMs: Math.max(5_000, args.timeoutMs),
    });
    const summary = summarizeCaseRuns(caseRuns);
    const promotionEvidence = await collectPromotionEvidence({
      model,
      summary,
      currentModel,
    });
    const cutover = await applyCutoverDecision(model, summary, promotionEvidence);
    const report = {
      ok: cutover.promoted === true,
      generated_at: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        cpu_count: os.cpus().length,
        total_memory_gb: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1)),
      },
      provider: "ollama",
      model,
      endpoint,
      summary,
      promotion_gate: promotionEvidence.gate,
      promotion_evidence: {
        benchmark_run: promotionEvidence.benchmark_run,
        benchmark_error: promotionEvidence.benchmark_error,
        eval_run: promotionEvidence.eval_run,
        eval_error: promotionEvidence.eval_error,
        router_status: promotionEvidence.router_status,
        router_error: promotionEvidence.router_error,
        route_result: promotionEvidence.route_result,
        route_error: promotionEvidence.route_error,
        bootstrap_status: promotionEvidence.bootstrap_status,
        bootstrap_error: promotionEvidence.bootstrap_error,
      },
      cutover,
      case_runs: caseRuns,
      report_path: reportPath,
    };

    const imprint = args.skipImprint
      ? null
      : await runImprintPersistence({
          model,
          primaryPreferredModel: cutover.promoted ? model : cutover.rollback_model || cutover.previous_model || model,
          reportPath,
          summary,
          profileId: args.profileId,
          skipMemory: args.skipMemory,
        });

    const fullReport = {
      ...report,
      imprint,
    };
    writeReport(reportPath, fullReport);
    process.stdout.write(`${JSON.stringify(fullReport, null, 2)}\n`);
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
