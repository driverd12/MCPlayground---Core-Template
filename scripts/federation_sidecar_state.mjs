import fs from "node:fs";
import path from "node:path";

export const SIDECAR_STATE_SCHEMA_VERSION = "master-mold-federation-sidecar-state-v2";

export function safeId(value, fallback = "host") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

export function defaultSidecarStatePath(repoRoot, hostId) {
  return path.join(repoRoot, "data", "federation", `${safeId(hostId, "host")}-sidecar-state.json`);
}

export function compactSidecarText(value, maxLength = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function compactSidecarValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 1_000 ? `${value.slice(0, 1_000)}...<truncated:${value.length - 1_000}>` : value;
  }
  if (depth >= 4) {
    return "[max_depth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => compactSidecarValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return String(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, entry]) => [key, compactSidecarValue(entry, depth + 1)])
  );
}

export function normalizePeerUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadSidecarState(filePath) {
  const raw = readJsonFile(filePath, {});
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const peerResults = state.peer_results && typeof state.peer_results === "object" && !Array.isArray(state.peer_results)
    ? state.peer_results
    : {};
  return {
    ...state,
    peer_results: peerResults,
  };
}

export function nextSidecarSequence(filePath, input) {
  const state = loadSidecarState(filePath);
  const previous = Number(state.sequence || 0);
  const sequence = Number.isFinite(previous) ? Math.max(0, Math.floor(previous)) + 1 : 1;
  writeJsonFile(filePath, {
    ...state,
    schema_version: SIDECAR_STATE_SCHEMA_VERSION,
    host_id: input.hostId,
    stream_id: input.streamId,
    sequence,
    updated_at: new Date().toISOString(),
  });
  return sequence;
}

function normalizedPeerResult(send, attemptAt, generatedAt, sequence, previous) {
  const peer = normalizePeerUrl(send.peer);
  const ok = send.ok === true;
  const previousSuccessCount = Number(previous.success_count || 0);
  const previousFailureCount = Number(previous.failure_count || 0);
  const previousConsecutiveFailures = Number(previous.consecutive_failures || 0);
  return {
    peer,
    last_attempt_at: attemptAt,
    last_generated_at: generatedAt ?? previous.last_generated_at ?? null,
    last_sequence: sequence ?? previous.last_sequence ?? null,
    last_ok: ok,
    last_http_status: Number.isFinite(Number(send.status)) ? Number(send.status) : null,
    last_error: ok ? null : compactSidecarText(send.error || send.response?.error || send.response?.raw || "", 500),
    last_response: compactSidecarValue(send.response ?? null),
    last_ok_at: ok ? attemptAt : previous.last_ok_at ?? null,
    last_error_at: ok ? previous.last_error_at ?? null : attemptAt,
    success_count: ok ? previousSuccessCount + 1 : previousSuccessCount,
    failure_count: ok ? previousFailureCount : previousFailureCount + 1,
    consecutive_failures: ok ? 0 : previousConsecutiveFailures + 1,
  };
}

export function recordSidecarCycle(filePath, input) {
  const state = loadSidecarState(filePath);
  const attemptAt = input.attemptAt || new Date().toISOString();
  const peerResults = { ...state.peer_results };
  for (const send of input.sends || []) {
    const peer = normalizePeerUrl(send.peer);
    if (!peer) {
      continue;
    }
    peerResults[peer] = normalizedPeerResult(
      send,
      attemptAt,
      input.generatedAt ?? null,
      input.sequence ?? null,
      peerResults[peer] && typeof peerResults[peer] === "object" ? peerResults[peer] : {}
    );
  }
  const nextState = {
    ...state,
    schema_version: SIDECAR_STATE_SCHEMA_VERSION,
    host_id: input.hostId ?? state.host_id ?? null,
    stream_id: input.streamId ?? state.stream_id ?? null,
    sequence: input.sequence ?? state.sequence ?? null,
    interval_seconds: input.intervalSeconds ?? state.interval_seconds ?? null,
    updated_at: attemptAt,
    last_cycle_at: attemptAt,
    last_cycle_generated_at: input.generatedAt ?? null,
    last_cycle_ok: (input.sends || []).every((entry) => entry.ok === true),
    peer_results: peerResults,
  };
  writeJsonFile(filePath, nextState);
  return nextState;
}

function hostMatchCandidates(host) {
  const values = [
    host.hostname,
    host.current_remote_address,
    host.approved_ip_address,
    ...(Array.isArray(host.allowed_addresses) ? host.allowed_addresses : []),
    ...(Array.isArray(host.resolved_addresses) ? host.resolved_addresses : []),
  ];
  return [...new Set(values.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
}

export function matchSidecarPeerResultToHost(peerResults, host) {
  const candidates = hostMatchCandidates(host);
  if (candidates.length <= 0) {
    return null;
  }
  let best = null;
  for (const entry of Object.values(peerResults || {})) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const peer = normalizePeerUrl(entry.peer);
    if (!peer) {
      continue;
    }
    let score = 0;
    let matchedBy = null;
    try {
      const url = new URL(peer);
      const peerHost = String(url.hostname || "").trim().toLowerCase();
      if (host.hostname && peerHost === String(host.hostname).trim().toLowerCase()) {
        score = 100;
        matchedBy = "hostname";
      } else if (candidates.includes(peerHost)) {
        score = 80;
        matchedBy = "address";
      }
    } catch {
      const raw = peer.toLowerCase();
      if (host.hostname && raw.includes(String(host.hostname).trim().toLowerCase())) {
        score = 60;
        matchedBy = "string_hostname";
      } else if (candidates.some((candidate) => raw.includes(candidate))) {
        score = 40;
        matchedBy = "string_address";
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = {
        score,
        matched_by: matchedBy,
        result: entry,
      };
    }
  }
  return best;
}

export function summarizeSidecarState(filePath, state) {
  const peerResults = Object.values(state?.peer_results || {}).filter((entry) => entry && typeof entry === "object");
  const lastCycleAt = state?.last_cycle_at ? String(state.last_cycle_at) : null;
  return {
    present: fs.existsSync(filePath),
    path: filePath,
    last_cycle_at: lastCycleAt,
    last_cycle_age_seconds: lastCycleAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastCycleAt)) / 1000)) : null,
    last_cycle_ok: state?.last_cycle_ok === true,
    sequence: Number.isFinite(Number(state?.sequence)) ? Number(state.sequence) : null,
    peer_count: peerResults.length,
    ok_peer_count: peerResults.filter((entry) => entry.last_ok === true).length,
    failing_peer_count: peerResults.filter((entry) => entry.last_ok !== true).length,
  };
}
