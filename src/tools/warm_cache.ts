import { z } from "zod";
import { evaluateFeatureFlag, summarizeToolCatalog } from "../control_plane.js";
import { Storage } from "../storage.js";
import { listToolCatalogEntries } from "../control_plane.js";
import { summarizeWarmCacheRuntime, storeWarmCacheEntry } from "../warm_cache_runtime.js";
import { kernelSummary } from "./kernel.js";
import { modelRouter } from "./model_router.js";
import { resolveProviderBridgeDiagnostics, resolveProviderBridgeSnapshot } from "./provider_bridge.js";
import { computeOfficeSnapshot, officeSnapshotSchema } from "./office_snapshot.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const officeSnapshotDefaults = officeSnapshotSchema.parse({});

export const warmCacheSchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    startup_prefetch: z.boolean().optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    ttl_seconds: z.number().int().min(5).max(3600).optional(),
    thread_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for warm-cache writes",
        path: ["mutation"],
      });
    }
  });

function warmCacheKey(target: string, suffix?: string | null) {
  return suffix ? `${target}:${suffix}` : target;
}

function runWarmTarget<T>(target: string, compute: () => T, suffix?: string | null) {
  const startedAt = Date.now();
  const payload = compute();
  const entry = storeWarmCacheEntry(warmCacheKey(target, suffix), payload, Date.now() - startedAt);
  return {
    target,
    cache_key: entry.key,
    warmed_at: entry.warmed_at,
    duration_ms: entry.duration_ms,
  };
}

export function runWarmCachePrefetch(storage: Storage, params?: { thread_id?: string | null }) {
  const state = storage.getWarmCacheState();
  const threadId = params?.thread_id?.trim() || state.thread_id;
  const featureState = storage.getFeatureFlagState();
  const laneEnabled = evaluateFeatureFlag(featureState, "control_plane.warm_cache", { thread_id: threadId });
  if (!laneEnabled.enabled || !state.enabled) {
    return {
      skipped: true,
      reason: !state.enabled ? "disabled" : laneEnabled.reason,
      state,
      runtime: summarizeWarmCacheRuntime(),
      results: [],
    };
  }

  const results = [
    runWarmTarget("kernel.summary", () =>
      kernelSummary(storage, {
        session_limit: 12,
        event_limit: 12,
        task_running_limit: 12,
      })
    ),
    runWarmTarget("office.snapshot", () =>
      computeOfficeSnapshot(
        storage,
        {
        thread_id: threadId,
        ...officeSnapshotDefaults,
      }
      ),
      threadId
    ),
    runWarmTarget("tool.catalog.summary", () => summarizeToolCatalog(listToolCatalogEntries())),
    runWarmTarget("model.router.status", () =>
      modelRouter(storage, {
        action: "status",
        fallback_workspace_root: process.cwd(),
        fallback_worker_count: 1,
        fallback_shell: "/bin/zsh",
      })
    ),
  ];

  const providerPrefetch = evaluateFeatureFlag(featureState, "provider.bridge.prefetch", { thread_id: threadId });
  if (providerPrefetch.enabled) {
    results.push(
      runWarmTarget("provider.bridge.diagnostics", () => ({
        snapshot: resolveProviderBridgeSnapshot({ workspace_root: process.cwd() }),
        diagnostics: resolveProviderBridgeDiagnostics({ workspace_root: process.cwd(), probe_timeout_ms: 1500 }),
      }))
    );
  }

  const totalDurationMs = results.reduce((sum, entry) => sum + entry.duration_ms, 0);
  const nextState = storage.setWarmCacheState({
    enabled: true,
    startup_prefetch: state.startup_prefetch,
    interval_seconds: state.interval_seconds,
    ttl_seconds: state.ttl_seconds,
    thread_id: threadId,
    last_run_at: new Date().toISOString(),
    last_error: null,
    last_duration_ms: totalDurationMs,
    run_count: state.run_count + 1,
    warmed_targets: results.map((entry) => entry.target),
  });

  return {
    skipped: false,
    reason: null,
    state: nextState,
    runtime: summarizeWarmCacheRuntime(),
    results,
  };
}

export function initializeWarmCacheLane(storage: Storage) {
  const state = storage.getWarmCacheState();
  let startup = null;
  if (state.enabled && state.startup_prefetch) {
    startup = runWarmCachePrefetch(storage, { thread_id: state.thread_id });
  }
  return {
    state: storage.getWarmCacheState(),
    runtime: summarizeWarmCacheRuntime(),
    startup,
  };
}

export function warmCacheControl(storage: Storage, input: z.infer<typeof warmCacheSchema>) {
  if (input.action === "status") {
    return {
      state: storage.getWarmCacheState(),
      runtime: summarizeWarmCacheRuntime(),
      source: "warm.cache",
    };
  }

  if (input.action === "run_once") {
    return runIdempotentMutation({
      storage,
      tool_name: "warm.cache",
      mutation: input.mutation!,
      payload: input,
      execute: () => ({
        ...runWarmCachePrefetch(storage, { thread_id: input.thread_id }),
        source: "warm.cache",
      }),
    });
  }

  return runIdempotentMutation({
    storage,
    tool_name: "warm.cache",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const current = storage.getWarmCacheState();
      const enabled = input.action === "start";
      const state = storage.setWarmCacheState({
        enabled,
        startup_prefetch: input.startup_prefetch ?? current.startup_prefetch,
        interval_seconds: input.interval_seconds ?? current.interval_seconds,
        ttl_seconds: input.ttl_seconds ?? current.ttl_seconds,
        thread_id: input.thread_id ?? current.thread_id,
      });
      return {
        state,
        runtime: summarizeWarmCacheRuntime(),
        source: "warm.cache",
      };
    },
  });
}
