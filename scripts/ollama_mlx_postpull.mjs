#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    });
  }
  return caseRuns;
}

function writeReport(reportPath, payload) {
  ensureDirectory(path.dirname(reportPath));
  fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runImprintPersistence({
  model,
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
  const preferredModels = resolvePreferredModelOrder(model, existingProfile.profile?.preferred_models ?? []);
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
    const report = {
      ok: summary.failed_cases === 0,
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
      case_runs: caseRuns,
      report_path: reportPath,
    };

    const imprint = args.skipImprint
      ? null
      : await runImprintPersistence({
          model,
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
