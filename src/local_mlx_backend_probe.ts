type MlxModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

type MlxChatCompletionResponse = {
  usage?: {
    completion_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type MlxProbeFailureStage = "endpoint" | "model_list" | "generation";

export type LocalMlxBackendProbeResult = {
  provider: "mlx";
  endpoint: string;
  requested_model: string;
  endpoint_ok: boolean;
  service_ok: boolean;
  model_list_ok: boolean;
  health_ok: boolean;
  model_known: boolean;
  benchmark_attempted: boolean;
  generation_ok: boolean | null;
  benchmark_ok: boolean;
  benchmark_latency_ms: number | null;
  benchmark_completion_tokens: number | null;
  throughput_tps: number | null;
  healthy: boolean;
  failure_stage: MlxProbeFailureStage | null;
  error: string | null;
};

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    }
    return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  } finally {
    clearTimeout(timer);
  }
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function probeLocalMlxBackend(input: {
  endpoint: string;
  model_id: string;
  benchmark?: boolean;
  timeout_ms?: number;
}): Promise<LocalMlxBackendProbeResult> {
  const endpoint = String(input.endpoint || "").trim().replace(/\/+$/, "");
  const modelId = String(input.model_id || "").trim();
  const timeoutMs = Math.max(1000, Math.min(60000, input.timeout_ms ?? 20000));

  let endpointOk = false;
  let modelListOk = false;
  let modelKnown = false;
  let generationOk: boolean | null = null;
  let benchmarkOk = false;
  let benchmarkLatencyMs: number | null = null;
  let benchmarkCompletionTokens: number | null = null;
  let throughputTps: number | null = null;
  let failureStage: MlxProbeFailureStage | null = null;
  let error: string | null = null;

  try {
    await fetchJson<{ status?: string }>(`${endpoint}/health`, { method: "GET" }, timeoutMs);
    endpointOk = true;
  } catch (probeError) {
    failureStage = "endpoint";
    error = probeError instanceof Error ? probeError.message : String(probeError);
  }

  if (endpointOk) {
    try {
      const models = await fetchJson<MlxModelsResponse>(`${endpoint}/v1/models`, { method: "GET" }, timeoutMs);
      const ids = Array.isArray(models.data)
        ? models.data
            .map((entry) => readString(entry?.id))
            .filter((entry): entry is string => Boolean(entry))
        : [];
      modelKnown = ids.includes(modelId);
      modelListOk = modelKnown;
      if (!modelListOk) {
        failureStage = "model_list";
        error = `Model ${modelId} was not listed by the MLX backend.`;
      }
    } catch (probeError) {
      failureStage = "model_list";
      error = probeError instanceof Error ? probeError.message : String(probeError);
    }
  }

  if (endpointOk && modelListOk && input.benchmark !== false) {
    const startedAt = Date.now();
    try {
      const response = await fetchJson<MlxChatCompletionResponse>(
        `${endpoint}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "Respond with the single word: ready" }],
            temperature: 0,
            max_tokens: 8,
            stream: false,
          }),
        },
        timeoutMs
      );
      benchmarkLatencyMs = Number(Math.max(1, Date.now() - startedAt).toFixed(3));
      const completionTokens = Number.isFinite(response?.usage?.completion_tokens)
        ? Number(response.usage!.completion_tokens)
        : null;
      const fallbackText = readString(response?.choices?.[0]?.message?.content);
      benchmarkCompletionTokens =
        completionTokens ??
        (fallbackText ? Math.max(1, fallbackText.split(/\s+/).filter(Boolean).length) : null);
      throughputTps =
        benchmarkCompletionTokens !== null && benchmarkLatencyMs > 0
          ? Number(((benchmarkCompletionTokens * 1000) / benchmarkLatencyMs).toFixed(4))
          : null;
      benchmarkOk = true;
      generationOk = true;
    } catch (probeError) {
      generationOk = false;
      failureStage = "generation";
      error = probeError instanceof Error ? probeError.message : String(probeError);
    }
  }

  const healthy = endpointOk && modelListOk && (input.benchmark === false ? true : generationOk === true);

  return {
    provider: "mlx",
    endpoint,
    requested_model: modelId,
    endpoint_ok: endpointOk,
    service_ok: endpointOk,
    model_list_ok: modelListOk,
    health_ok: healthy,
    model_known: modelKnown,
    benchmark_attempted: input.benchmark !== false,
    generation_ok: generationOk,
    benchmark_ok: benchmarkOk,
    benchmark_latency_ms: benchmarkLatencyMs,
    benchmark_completion_tokens: benchmarkCompletionTokens,
    throughput_tps: throughputTps,
    healthy,
    failure_stage: failureStage,
    error,
  };
}
