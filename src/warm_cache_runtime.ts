type WarmCacheEntry = {
  key: string;
  warmed_at: string;
  duration_ms: number;
  payload: unknown;
};

const warmCacheEntries = new Map<string, WarmCacheEntry>();

export function storeWarmCacheEntry(key: string, payload: unknown, durationMs: number) {
  const entry: WarmCacheEntry = {
    key,
    warmed_at: new Date().toISOString(),
    duration_ms: Math.max(0, Math.round(durationMs)),
    payload,
  };
  warmCacheEntries.set(key, entry);
  return entry;
}

export function readWarmCacheEntry<T = unknown>(key: string, maxAgeMs?: number): WarmCacheEntry | null {
  const entry = warmCacheEntries.get(key);
  if (!entry) {
    return null;
  }
  if (typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs >= 0) {
    const ageMs = Date.now() - Date.parse(entry.warmed_at);
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      return null;
    }
  }
  return entry as WarmCacheEntry & { payload: T };
}

export function summarizeWarmCacheRuntime() {
  const entries = [...warmCacheEntries.values()].sort((left, right) => right.warmed_at.localeCompare(left.warmed_at));
  return {
    entry_count: entries.length,
    newest_warmed_at: entries[0]?.warmed_at ?? null,
    entries: entries.map((entry) => ({
      key: entry.key,
      warmed_at: entry.warmed_at,
      duration_ms: entry.duration_ms,
    })),
  };
}

export function clearWarmCacheRuntime() {
  warmCacheEntries.clear();
}
