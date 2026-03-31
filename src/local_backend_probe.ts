import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

type OllamaModelTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
  }>;
};

type OllamaGenerateResponse = {
  response?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  done?: boolean;
};

type OllamaPsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    size_vram?: number;
    context_length?: number;
    expires_at?: string;
  }>;
};

export type LocalBackendProbeResult = {
  provider: "ollama";
  generated_at: string;
  endpoint: string;
  requested_model: string;
  service_ok: boolean;
  version: string | null;
  version_latency_ms: number | null;
  tags_ok: boolean;
  tags_latency_ms: number | null;
  ps_ok: boolean;
  ps_latency_ms: number | null;
  model_known: boolean;
  model_loaded: boolean;
  resident_model_count: number;
  resident_vram_gb: number | null;
  resident_context_length: number | null;
  resident_expires_at: string | null;
  processor_summary: string | null;
  gpu_offload_ratio: number | null;
  known_models: string[];
  benchmark_attempted: boolean;
  benchmark_ok: boolean;
  benchmark_latency_ms: number | null;
  benchmark_total_duration_ms: number | null;
  benchmark_eval_count: number | null;
  benchmark_eval_duration_ms: number | null;
  throughput_tps: number | null;
  error: string | null;
};

export type LocalOllamaResidencyActionResult = {
  ok: boolean;
  action: "prewarm" | "unload";
  endpoint: string;
  model_id: string;
  keep_alive: string | number;
  elapsed_ms: number | null;
  generated_at: string;
  error: string | null;
};

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const elapsedMs = Number((performance.now() - startedAt).toFixed(4));
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 240)}` : ""}`);
  }
  return {
    elapsed_ms: elapsedMs,
    payload: text.trim().length > 0 ? (JSON.parse(text) as T) : ({} as T),
  };
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value) : null;
}

function parseOllamaProcessorSummary(modelId: string) {
  const result = spawnSync("ollama", ["ps"], { encoding: "utf8" });
  if (result.status !== 0) {
    return { processor_summary: null, gpu_offload_ratio: null };
  }
  const lines = String(result.stdout || "")
    .split(/\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const line of lines.slice(1)) {
    const columns = line.split(/\s{2,}/).map((entry) => entry.trim());
    if (columns[0] !== modelId || columns.length < 4) {
      continue;
    }
    const processorSummary = columns[3] || null;
    if (!processorSummary) {
      return { processor_summary: null, gpu_offload_ratio: null };
    }
    const mixedMatch = /^(\d+)%\/(\d+)%\s+CPU\/GPU$/i.exec(processorSummary);
    if (mixedMatch) {
      const gpuPercent = Number.parseInt(mixedMatch[2], 10);
      return {
        processor_summary: processorSummary,
        gpu_offload_ratio: Number.isFinite(gpuPercent) ? Number((gpuPercent / 100).toFixed(4)) : null,
      };
    }
    const singleMatch = /^(\d+)%\s+(GPU|CPU)$/i.exec(processorSummary);
    if (singleMatch) {
      const percent = Number.parseInt(singleMatch[1], 10);
      return {
        processor_summary: processorSummary,
        gpu_offload_ratio:
          Number.isFinite(percent) && singleMatch[2].toUpperCase() === "GPU" ? Number((percent / 100).toFixed(4)) : 0,
      };
    }
    return { processor_summary: processorSummary, gpu_offload_ratio: null };
  }
  return { processor_summary: null, gpu_offload_ratio: null };
}

export async function probeLocalOllamaBackend(input: {
  endpoint: string;
  model_id: string;
  benchmark?: boolean;
  service_timeout_ms?: number;
  benchmark_timeout_ms?: number;
}): Promise<LocalBackendProbeResult> {
  const baseUrl = normalizeBaseUrl(input.endpoint);
  const serviceTimeoutMs =
    typeof input.service_timeout_ms === "number" && Number.isFinite(input.service_timeout_ms)
      ? Math.max(500, Math.round(input.service_timeout_ms))
      : 4000;
  const benchmarkTimeoutMs =
    typeof input.benchmark_timeout_ms === "number" && Number.isFinite(input.benchmark_timeout_ms)
      ? Math.max(1000, Math.round(input.benchmark_timeout_ms))
      : 15000;
  const generatedAt = new Date().toISOString();
  let version: string | null = null;
  let versionLatencyMs: number | null = null;
  let tagsLatencyMs: number | null = null;
  let psLatencyMs: number | null = null;
  let tagsOk = false;
  let psOk = false;
  let serviceOk = false;
  let modelKnown = false;
  let modelLoaded = false;
  let residentModelCount = 0;
  let residentVramGb: number | null = null;
  let residentContextLength: number | null = null;
  let residentExpiresAt: string | null = null;
  let processorSummary: string | null = null;
  let gpuOffloadRatio: number | null = null;
  let knownModels: string[] = [];
  let benchmarkAttempted = false;
  let benchmarkOk = false;
  let benchmarkLatencyMs: number | null = null;
  let benchmarkTotalDurationMs: number | null = null;
  let benchmarkEvalCount: number | null = null;
  let benchmarkEvalDurationMs: number | null = null;
  let throughputTps: number | null = null;
  let error: string | null = null;

  try {
    const versionResponse = await fetchJson<{ version?: string }>(
      `${baseUrl}/api/version`,
      { method: "GET" },
      serviceTimeoutMs
    );
    versionLatencyMs = versionResponse.elapsed_ms;
    version = readString(versionResponse.payload.version);
    serviceOk = true;
  } catch (probeError) {
    error = probeError instanceof Error ? probeError.message : String(probeError);
  }

  try {
    const tagsResponse = await fetchJson<OllamaModelTagsResponse>(
      `${baseUrl}/api/tags`,
      { method: "GET" },
      serviceTimeoutMs
    );
    tagsLatencyMs = tagsResponse.elapsed_ms;
    tagsOk = true;
    serviceOk = true;
    knownModels = (Array.isArray(tagsResponse.payload.models) ? tagsResponse.payload.models : [])
      .flatMap((entry) => [readString(entry?.name), readString(entry?.model)])
      .filter((entry): entry is string => Boolean(entry));
    modelKnown = knownModels.includes(input.model_id);
  } catch (probeError) {
    error = error ?? (probeError instanceof Error ? probeError.message : String(probeError));
  }

  try {
    const psResponse = await fetchJson<OllamaPsResponse>(`${baseUrl}/api/ps`, { method: "GET" }, serviceTimeoutMs);
    psLatencyMs = psResponse.elapsed_ms;
    psOk = true;
    serviceOk = true;
    const residentModels = Array.isArray(psResponse.payload.models) ? psResponse.payload.models : [];
    residentModelCount = residentModels.length;
    const residentMatch =
      residentModels.find((entry) => readString(entry?.name) === input.model_id) ??
      residentModels.find((entry) => readString(entry?.model) === input.model_id) ??
      null;
    modelLoaded = residentMatch !== null;
    if (residentMatch) {
      const residentVramBytes = readNumber(residentMatch.size_vram);
      residentVramGb =
        residentVramBytes === null ? null : Number((residentVramBytes / 1024 / 1024 / 1024).toFixed(4));
      residentContextLength = readNumber(residentMatch.context_length);
      residentExpiresAt = readString(residentMatch.expires_at);
      const processorProbe = parseOllamaProcessorSummary(input.model_id);
      processorSummary = processorProbe.processor_summary;
      gpuOffloadRatio = processorProbe.gpu_offload_ratio;
    }
  } catch (probeError) {
    error = error ?? (probeError instanceof Error ? probeError.message : String(probeError));
  }

  if (input.benchmark === true && serviceOk && modelKnown) {
    benchmarkAttempted = true;
    try {
      const benchmarkResponse = await fetchJson<OllamaGenerateResponse>(
        `${baseUrl}/api/generate`,
        {
          method: "POST",
          body: JSON.stringify({
            model: input.model_id,
            prompt: "Return the word ok.",
            stream: false,
            keep_alive: "30s",
            options: {
              temperature: 0,
              num_predict: 8,
              num_ctx: 256,
            },
          }),
        },
        benchmarkTimeoutMs
      );
      benchmarkLatencyMs = benchmarkResponse.elapsed_ms;
      benchmarkTotalDurationMs = readNumber(benchmarkResponse.payload.total_duration);
      benchmarkTotalDurationMs =
        benchmarkTotalDurationMs === null ? null : Number((benchmarkTotalDurationMs / 1_000_000).toFixed(4));
      benchmarkEvalCount = readNumber(benchmarkResponse.payload.eval_count);
      benchmarkEvalDurationMs = readNumber(benchmarkResponse.payload.eval_duration);
      benchmarkEvalDurationMs =
        benchmarkEvalDurationMs === null ? null : Number((benchmarkEvalDurationMs / 1_000_000).toFixed(4));
      if (benchmarkEvalCount !== null && benchmarkEvalDurationMs !== null && benchmarkEvalDurationMs > 0) {
        throughputTps = Number(((benchmarkEvalCount * 1000) / benchmarkEvalDurationMs).toFixed(4));
      }
      benchmarkOk = benchmarkResponse.payload.done === true || benchmarkEvalCount !== null;
    } catch (probeError) {
      error = error ?? (probeError instanceof Error ? probeError.message : String(probeError));
    }
  }

  return {
    provider: "ollama",
    generated_at: generatedAt,
    endpoint: baseUrl,
    requested_model: input.model_id,
    service_ok: serviceOk,
    version,
    version_latency_ms: versionLatencyMs,
    tags_ok: tagsOk,
    tags_latency_ms: tagsLatencyMs,
    ps_ok: psOk,
    ps_latency_ms: psLatencyMs,
    model_known: modelKnown,
    model_loaded: modelLoaded,
    resident_model_count: residentModelCount,
    resident_vram_gb: residentVramGb,
    resident_context_length: residentContextLength,
    resident_expires_at: residentExpiresAt,
    processor_summary: processorSummary,
    gpu_offload_ratio: gpuOffloadRatio,
    known_models: [...new Set(knownModels)],
    benchmark_attempted: benchmarkAttempted,
    benchmark_ok: benchmarkOk,
    benchmark_latency_ms: benchmarkLatencyMs,
    benchmark_total_duration_ms: benchmarkTotalDurationMs,
    benchmark_eval_count: benchmarkEvalCount,
    benchmark_eval_duration_ms: benchmarkEvalDurationMs,
    throughput_tps: throughputTps,
    error,
  };
}

export async function setLocalOllamaModelResidency(input: {
  endpoint: string;
  model_id: string;
  action: "prewarm" | "unload";
  keep_alive?: string | number;
  timeout_ms?: number;
}): Promise<LocalOllamaResidencyActionResult> {
  const baseUrl = normalizeBaseUrl(input.endpoint);
  const timeoutMs =
    typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
      ? Math.max(500, Math.round(input.timeout_ms))
      : 15000;
  const keepAlive =
    input.action === "unload"
      ? 0
      : input.keep_alive === undefined || input.keep_alive === null
        ? "10m"
        : input.keep_alive;
  try {
    const response = await fetchJson<Record<string, unknown>>(
      `${baseUrl}/api/generate`,
      {
        method: "POST",
        body: JSON.stringify({
          model: input.model_id,
          stream: false,
          keep_alive: keepAlive,
        }),
      },
      timeoutMs
    );
    return {
      ok: true,
      action: input.action,
      endpoint: baseUrl,
      model_id: input.model_id,
      keep_alive: keepAlive,
      elapsed_ms: response.elapsed_ms,
      generated_at: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      action: input.action,
      endpoint: baseUrl,
      model_id: input.model_id,
      keep_alive: keepAlive,
      elapsed_ms: null,
      generated_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
