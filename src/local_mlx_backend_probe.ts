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

export type LocalMlxBackendProbeResult = {
  provider: "mlx";
  endpoint: string;
  requested_model: string;
  service_ok: boolean;
  health_ok: boolean;
  model_known: boolean;
  benchmark_attempted: boolean;
  benchmark_ok: boolean;
  benchmark_latency_ms: number | null;
  benchmark_completion_tokens: number | null;
  throughput_tps: number | null;
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

  let serviceOk = false;
  let healthOk = false;
  let modelKnown = false;
  let benchmarkOk = false;
  let benchmarkLatencyMs: number | null = null;
  let benchmarkCompletionTokens: number | null = null;
  let throughputTps: number | null = null;
  let error: string | null = null;

  try {
    await fetchJson<{ status?: string }>(`${endpoint}/health`, { method: "GET" }, timeoutMs);
    serviceOk = true;
    healthOk = true;
  } catch (probeError) {
    error = probeError instanceof Error ? probeError.message : String(probeError);
  }

  if (serviceOk) {
    try {
      const models = await fetchJson<MlxModelsResponse>(`${endpoint}/v1/models`, { method: "GET" }, timeoutMs);
      const ids = Array.isArray(models.data)
        ? models.data
            .map((entry) => readString(entry?.id))
            .filter((entry): entry is string => Boolean(entry))
        : [];
      modelKnown = ids.includes(modelId);
    } catch (probeError) {
      error = probeError instanceof Error ? probeError.message : String(probeError);
    }
  }

  if (serviceOk && input.benchmark !== false) {
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
    } catch (probeError) {
      error = probeError instanceof Error ? probeError.message : String(probeError);
    }
  }

  return {
    provider: "mlx",
    endpoint,
    requested_model: modelId,
    service_ok: serviceOk,
    health_ok: healthOk,
    model_known: modelKnown,
    benchmark_attempted: input.benchmark !== false,
    benchmark_ok: benchmarkOk,
    benchmark_latency_ms: benchmarkLatencyMs,
    benchmark_completion_tokens: benchmarkCompletionTokens,
    throughput_tps: throughputTps,
    error,
  };
}
