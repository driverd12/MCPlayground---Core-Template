import fs from "node:fs";
import { z } from "zod";
import { Storage } from "../storage.js";
import { probeLiteLlmProxyHealth, type LiteLlmProxyHealth } from "../litellm_proxy_probe.js";

export const healthToolsSchema = z.object({});
export const healthStorageSchema = z.object({});
export const healthPolicySchema = z.object({});
export const healthLiteLlmProxySchema = z.object({});

export function healthTools(toolNames: string[]) {
  return {
    ok: true,
    tool_count: toolNames.length,
    tools: [...toolNames].sort(),
  };
}

export function healthStorage(storage: Storage) {
  const dbPath = storage.getDatabasePath();
  const counts = storage.getTableCounts();
  const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
  const backups = storage.getStorageBackupStatus({ recent_limit: 6 });
  const guard = storage.getStorageGuardStatus({ recent_limit: 6 });
  const sqliteErrors = storage.getSqliteErrorState();
  return {
    ok: true,
    db_path: dbPath,
    db_exists: Boolean(stats),
    db_size_bytes: stats ? stats.size : 0,
    schema_version: storage.getSchemaVersion(),
    table_counts: counts,
    backups,
    guard,
    sqlite_errors: sqliteErrors,
  };
}

export function healthPolicy() {
  return {
    ok: true,
    mode: "local-only",
    enforced_rules: [
      "two-source confirmation required for destructive actions",
      "protected targets block destructive mutations",
      "idempotency key and side effect fingerprint required for mutating tools",
      "destructive lifecycle actions default to safe mode unless explicitly execute",
    ],
  };
}

export function healthLiteLlmProxy(
  options: {
    probe?: () => LiteLlmProxyHealth;
  } = {}
) {
  const health = options.probe ? options.probe() : probeLiteLlmProxyHealth({ timeout_ms: 2500 });
  const healthyCount = typeof health.healthy_count === "number" ? health.healthy_count : null;
  const unhealthyCount = typeof health.unhealthy_count === "number" ? health.unhealthy_count : null;
  const noHealthyEndpoints = healthyCount !== null && healthyCount <= 0;
  const ok = health.healthy === true && !noHealthyEndpoints;
  return {
    ok,
    status: ok ? (health.degraded || (unhealthyCount ?? 0) > 0 ? "degraded" : "up") : "down",
    endpoint: health.endpoint,
    checked_at: health.checked_at,
    error: health.error,
    healthy_count: healthyCount,
    unhealthy_count: unhealthyCount,
    total_endpoint_count: health.total_endpoint_count,
    routing_strategy: health.routing_strategy,
    model_region_counts: health.model_region_counts,
    inventory_available: health.inventory_available === true,
    service_healthy: health.service_healthy === true,
    health_http: health.health_http ?? null,
    health_path: health.health_path ?? null,
  };
}
