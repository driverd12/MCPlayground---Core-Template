import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type LiteLlmProxyModelSummary = {
  model_name: string;
  model_id: string | null;
  endpoint_count: number;
  regions: string[];
  provider: "google" | "ollama" | "custom";
};

export type LiteLlmProxyConfigSummary = {
  config_path: string;
  config_present: boolean;
  routing_strategy: string | null;
  total_endpoint_count: number;
  model_region_counts: Record<string, number>;
  models: LiteLlmProxyModelSummary[];
};

export type LiteLlmProxyHealth = {
  endpoint: string;
  healthy: boolean;
  degraded: boolean;
  checked_at: string;
  error: string | null;
  readiness_status?: string | null;
  health_http?: number;
  health_path?: string;
  service_http?: number;
  service_healthy?: boolean;
  endpoint_health_http?: number;
  endpoint_health_error?: string | null;
  inventory_available?: boolean;
  healthy_count: number | null;
  unhealthy_count: number | null;
  total_endpoint_count: number;
  routing_strategy: string | null;
  model_region_counts: Record<string, number>;
  healthy_model_region_counts?: Record<string, number>;
  unhealthy_model_region_counts?: Record<string, number>;
  config_path?: string;
};

function readEnvString(name: string) {
  const value = String(process.env[name] ?? "").trim();
  return value.length > 0 ? value : null;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readYamlScalar(line: string, key: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${key}:`)) {
    return null;
  }
  return stripQuotes(trimmed.slice(key.length + 1));
}

function dedupe(values: string[]) {
  return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
}

function classifyModelProvider(modelId: string | null) {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  if (normalized.startsWith("vertex_ai/") || normalized.includes("gemini")) {
    return "google" as const;
  }
  if (normalized.startsWith("ollama/") || normalized.includes("gemma")) {
    return "ollama" as const;
  }
  return "custom" as const;
}

function normalizeModelName(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/^vertex_ai\//, "").replace(/^ollama\//, "");
}

export function resolveLiteLlmProxyEndpoint() {
  return normalizeBaseUrl(
    readEnvString("TRICHAT_GEMINI_PROXY_ENDPOINT") ??
      readEnvString("GOOGLE_VERTEX_BASE_URL") ??
      readEnvString("GOOGLE_GEMINI_BASE_URL") ??
      "http://127.0.0.1:4000"
  );
}

export function resolveLiteLlmProxyConfigPath() {
  return (
    readEnvString("TRICHAT_LITELLM_CONFIG_PATH") ??
    path.join(readEnvString("HOME") ?? os.homedir(), ".gemini", "proxy", "config.yaml")
  );
}

export function resolveOllamaEndpoint() {
  const raw = readEnvString("TRICHAT_OLLAMA_URL") ?? readEnvString("OLLAMA_HOST") ?? "http://127.0.0.1:11434";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return normalizeBaseUrl(withProtocol);
}

export function readLiteLlmProxyConfigSummary(configPath = resolveLiteLlmProxyConfigPath()): LiteLlmProxyConfigSummary {
  if (!fs.existsSync(configPath)) {
    return {
      config_path: configPath,
      config_present: false,
      routing_strategy: null,
      total_endpoint_count: 0,
      model_region_counts: {},
      models: [],
    };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const entries: Array<{ model_name: string; model_id: string | null; vertex_location: string | null }> = [];
  let current: { model_name: string; model_id: string | null; vertex_location: string | null } | null = null;
  let routingStrategy: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const modelName = readYamlScalar(trimmed.replace(/^- /, ""), "model_name");
    if (modelName !== null) {
      if (current) {
        entries.push(current);
      }
      current = {
        model_name: modelName,
        model_id: null,
        vertex_location: null,
      };
      continue;
    }
    if (!current) {
      const strategy = readYamlScalar(trimmed, "routing_strategy");
      if (strategy !== null) {
        routingStrategy = strategy;
      }
      continue;
    }
    const model = readYamlScalar(trimmed, "model");
    if (model !== null) {
      current.model_id = model;
      continue;
    }
    const location = readYamlScalar(trimmed, "vertex_location");
    if (location !== null) {
      current.vertex_location = location;
      continue;
    }
    const strategy = readYamlScalar(trimmed, "routing_strategy");
    if (strategy !== null) {
      routingStrategy = strategy;
    }
  }
  if (current) {
    entries.push(current);
  }

  const byModel = new Map<string, { model_id: string | null; regions: string[]; count: number }>();
  for (const entry of entries) {
    const existing = byModel.get(entry.model_name) ?? { model_id: entry.model_id, regions: [], count: 0 };
    existing.model_id = existing.model_id ?? entry.model_id;
    if (entry.vertex_location) {
      existing.regions.push(entry.vertex_location);
    }
    existing.count += 1;
    byModel.set(entry.model_name, existing);
  }

  const models = [...byModel.entries()]
    .map(([model_name, summary]) => ({
      model_name,
      model_id: summary.model_id,
      endpoint_count: summary.count,
      regions: dedupe(summary.regions),
      provider: classifyModelProvider(summary.model_id ?? model_name),
    }))
    .sort((left, right) => left.model_name.localeCompare(right.model_name));
  const modelRegionCounts = Object.fromEntries(models.map((model) => [model.model_name, model.endpoint_count]));

  return {
    config_path: configPath,
    config_present: true,
    routing_strategy: routingStrategy,
    total_endpoint_count: entries.length,
    model_region_counts: modelRegionCounts,
    models,
  };
}

function modelNameFromEndpointRecord(record: unknown) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const item = record as Record<string, unknown>;
  const params =
    item.litellm_params && typeof item.litellm_params === "object" && !Array.isArray(item.litellm_params)
      ? (item.litellm_params as Record<string, unknown>)
      : {};
  return (
    normalizeModelName(item.model_name) ??
    normalizeModelName(item.model) ??
    normalizeModelName(params.model_name) ??
    normalizeModelName(params.model)
  );
}

function countEndpointModels(value: unknown) {
  const counts: Record<string, number> = {};
  if (!Array.isArray(value)) {
    return counts;
  }
  for (const entry of value) {
    const modelName = modelNameFromEndpointRecord(entry);
    if (!modelName) {
      continue;
    }
    counts[modelName] = (counts[modelName] ?? 0) + 1;
  }
  return counts;
}

function parseLiteLlmHealthBody(body: string) {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const healthyEndpoints = Array.isArray(parsed.healthy_endpoints) ? parsed.healthy_endpoints : null;
    const unhealthyEndpoints = Array.isArray(parsed.unhealthy_endpoints) ? parsed.unhealthy_endpoints : null;
    const healthyCount =
      typeof parsed.healthy_count === "number"
        ? parsed.healthy_count
        : healthyEndpoints
          ? healthyEndpoints.length
          : null;
    const unhealthyCount =
      typeof parsed.unhealthy_count === "number"
        ? parsed.unhealthy_count
        : unhealthyEndpoints
          ? unhealthyEndpoints.length
          : null;
    return {
      readiness_status: typeof parsed.status === "string" ? parsed.status : null,
      healthy_count: healthyCount,
      unhealthy_count: unhealthyCount,
      healthy_model_region_counts: countEndpointModels(healthyEndpoints),
      unhealthy_model_region_counts: countEndpointModels(unhealthyEndpoints),
      inventory_available: healthyEndpoints !== null || unhealthyEndpoints !== null || healthyCount !== null || unhealthyCount !== null,
    };
  } catch {
    return {
      readiness_status: null,
      healthy_count: null,
      unhealthy_count: null,
      healthy_model_region_counts: {},
      unhealthy_model_region_counts: {},
      inventory_available: false,
    };
  }
}

function compactProbeDetail(output: string, fallback: string) {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, 240) : fallback;
}

function runLiteLlmHealthCurl(endpoint: string, pathSuffix: string, timeoutMs: number) {
  const boundedTimeoutMs = Math.max(250, Math.min(timeoutMs, 3000));
  const maxTimeSeconds = (boundedTimeoutMs / 1000).toFixed(3);
  const result = spawnSync("curl", ["-sS", "--max-time", maxTimeSeconds, "-w", "\n%{http_code}", `${endpoint}${pathSuffix}`], {
    encoding: "utf8",
    env: process.env,
    timeout: boundedTimeoutMs + 500,
    maxBuffer: 1024 * 1024,
  });
  const stdout = String(result.stdout ?? "").trimEnd();
  const lines = stdout.split(/\r?\n/);
  const httpStatusLine = lines.pop() ?? "";
  const body = lines.join("\n").trim();
  const httpStatus = Number.parseInt(httpStatusLine.trim(), 10);
  const healthy = result.status === 0 && Number.isFinite(httpStatus) && httpStatus >= 200 && httpStatus < 300;
  const error = healthy
    ? null
    : compactProbeDetail(
        `${String(result.stderr ?? "").trim()} ${body}`.trim(),
        result.error?.message || `LiteLLM proxy ${pathSuffix} check failed.`
      );
  return {
    body,
    error,
    healthy,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
    path: pathSuffix,
  };
}

export function probeLiteLlmProxyHealth(
  options: {
    endpoint?: string;
    config_path?: string;
    timeout_ms?: number;
    endpoint_audit_timeout_ms?: number;
  } = {}
): LiteLlmProxyHealth {
  const endpoint = normalizeBaseUrl(options.endpoint ?? resolveLiteLlmProxyEndpoint());
  const config = readLiteLlmProxyConfigSummary(options.config_path);
  const timeoutMs = Math.max(250, Math.min(options.timeout_ms ?? 2500, 3000));
  const endpointAuditTimeoutMs = Math.max(250, Math.min(options.endpoint_audit_timeout_ms ?? timeoutMs, 3000));
  const readiness = runLiteLlmHealthCurl(endpoint, "/health/readiness", timeoutMs);
  const endpointAudit = runLiteLlmHealthCurl(endpoint, "/health", endpointAuditTimeoutMs);
  const readinessBody = parseLiteLlmHealthBody(readiness.body);
  const endpointBody = parseLiteLlmHealthBody(endpointAudit.body);
  const readinessHealthy =
    readiness.healthy &&
    (readinessBody.readiness_status === null || readinessBody.readiness_status.toLowerCase() === "healthy");
  const endpointAuditHealthy = endpointAudit.healthy;
  const healthy = readinessHealthy || (!readiness.healthy && endpointAuditHealthy);
  const degraded = healthy && (!endpointAuditHealthy || (endpointBody.unhealthy_count ?? 0) > 0);
  const healthHttp = readiness.healthy ? readiness.httpStatus : endpointAudit.httpStatus;
  const healthPath = readiness.healthy ? readiness.path : endpointAudit.path;
  const error = healthy
    ? null
    : readiness.error ?? endpointAudit.error ?? "LiteLLM proxy health check failed.";
  const healthyCount = endpointBody.healthy_count;
  const unhealthyCount = endpointBody.unhealthy_count;
  const totalEndpointCount =
    (typeof healthyCount === "number" ? healthyCount : 0) +
    (typeof unhealthyCount === "number" ? unhealthyCount : 0);

  return {
    endpoint,
    healthy,
    degraded,
    health_http: healthHttp,
    health_path: healthPath,
    service_http: readiness.httpStatus,
    service_healthy: readinessHealthy,
    endpoint_health_http: endpointAudit.httpStatus,
    endpoint_health_error: endpointAuditHealthy ? null : endpointAudit.error,
    checked_at: new Date().toISOString(),
    error,
    readiness_status: readinessBody.readiness_status ?? endpointBody.readiness_status,
    inventory_available: endpointBody.inventory_available,
    healthy_count: healthyCount,
    unhealthy_count: unhealthyCount,
    total_endpoint_count: totalEndpointCount > 0 ? totalEndpointCount : config.total_endpoint_count,
    routing_strategy: config.routing_strategy,
    model_region_counts: config.model_region_counts,
    healthy_model_region_counts: endpointBody.healthy_model_region_counts,
    unhealthy_model_region_counts: endpointBody.unhealthy_model_region_counts,
    config_path: config.config_path,
  };
}

