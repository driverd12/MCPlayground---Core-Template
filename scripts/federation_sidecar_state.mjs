import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const SIDECAR_STATE_SCHEMA_VERSION = "master-mold-federation-sidecar-state-v3";

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
  const configuredPeers = Array.isArray(state.configured_peers)
    ? [...new Set(state.configured_peers.map(normalizePeerUrl).filter(Boolean))]
    : [];
  const outbox = Array.isArray(state.outbox) ? state.outbox.filter((entry) => entry && typeof entry === "object") : [];
  const retryLedger = Array.isArray(state.retry_ledger)
    ? state.retry_ledger.filter((entry) => entry && typeof entry === "object").slice(-100)
    : [];
  return {
    ...state,
    configured_peers: configuredPeers,
    peer_results: peerResults,
    outbox,
    retry_ledger: retryLedger,
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
  const result = send?.response && typeof send.response === "object" && !Array.isArray(send.response)
    ? send.response.result && typeof send.response.result === "object" && !Array.isArray(send.response.result)
      ? send.response.result
      : send.response
    : {};
  const responseSequence = Number.isFinite(Number(result.sequence)) ? Math.trunc(Number(result.sequence)) : sequence ?? null;
  const persisted = Boolean(result.event_id || result.event_seq);
  const processed = ok && result.worker_fabric_heartbeat_ok !== false;
  const consecutiveFailures = ok ? 0 : previousConsecutiveFailures + 1;
  const nextRetryMs = !ok ? Date.parse(attemptAt) + Math.min(3600, Math.max(30, 2 ** Math.min(consecutiveFailures, 6) * 15)) * 1000 : Number.NaN;
  const previousResendWindow = Array.isArray(previous.resend_window_sequences)
    ? previous.resend_window_sequences.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
    : [];
  const previousAckSequence = Math.max(
    Number(previous.ack_processed_sequence || 0),
    Number(previous.ack_persisted_sequence || 0)
  );
  const pendingResendWindow = previousResendWindow.filter((entry) => {
    if (!Number.isFinite(previousAckSequence) || previousAckSequence <= 0) {
      return true;
    }
    return Number(entry) > previousAckSequence;
  });
  const resendWindow = ok || persisted
    ? pendingResendWindow.filter((entry) => {
        if (!Number.isFinite(Number(responseSequence))) {
          return true;
        }
        return Number(entry) > Number(responseSequence);
      })
    : [...new Set([...pendingResendWindow, responseSequence].filter((entry) => Number.isFinite(Number(entry))))].slice(-10);
  const errorText = ok ? null : compactSidecarText(send.error || send.response?.error || send.response?.raw || "", 500);
  return {
    peer,
    last_attempt_at: attemptAt,
    last_generated_at: generatedAt ?? previous.last_generated_at ?? null,
    last_sequence: sequence ?? previous.last_sequence ?? null,
    last_ok: ok,
    last_http_status: Number.isFinite(Number(send.status)) ? Number(send.status) : null,
    last_error: errorText,
    last_response: compactSidecarValue(send.response ?? null),
    last_ok_at: ok ? attemptAt : previous.last_ok_at ?? null,
    last_error_at: ok ? previous.last_error_at ?? null : attemptAt,
    success_count: ok ? previousSuccessCount + 1 : previousSuccessCount,
    failure_count: ok ? previousFailureCount : previousFailureCount + 1,
    consecutive_failures: consecutiveFailures,
    ack_persisted_sequence: persisted ? responseSequence : previous.ack_persisted_sequence ?? null,
    ack_event_id: persisted ? String(result.event_id || "") || (previous.ack_event_id ?? null) : previous.ack_event_id ?? null,
    ack_event_seq: persisted && Number.isFinite(Number(result.event_seq)) ? Number(result.event_seq) : previous.ack_event_seq ?? null,
    ack_persisted_at: persisted ? attemptAt : previous.ack_persisted_at ?? null,
    ack_processed_sequence: processed ? responseSequence : previous.ack_processed_sequence ?? null,
    ack_processed_at: processed ? attemptAt : previous.ack_processed_at ?? null,
    last_processing_error: persisted && !processed ? errorText : ok ? null : previous.last_processing_error ?? null,
    last_processing_error_at: persisted && !processed ? attemptAt : ok ? previous.last_processing_error_at ?? null : previous.last_processing_error_at ?? null,
    retry_count: consecutiveFailures,
    next_retry_at: Number.isFinite(nextRetryMs) ? new Date(nextRetryMs).toISOString() : null,
    resend_window_sequences: resendWindow,
  };
}

function payloadDigest(payload) {
  if (payload === undefined) {
    return null;
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function payloadBytes(payload) {
  if (payload === undefined) {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(payload));
}

function updateOutbox(previousOutbox, input, peerResults) {
  const sequence = Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : null;
  if (sequence === null) {
    return Array.isArray(previousOutbox) ? previousOutbox.slice(-25) : [];
  }
  const sends = input.sends || [];
  const peerKeys = sends.map((send) => normalizePeerUrl(send.peer)).filter(Boolean);
  const refreshPendingPeers = (entry) => {
    const entrySequence = Number.isFinite(Number(entry.sequence)) ? Number(entry.sequence) : null;
    const previousPendingPeers = Array.isArray(entry.pending_peers)
      ? entry.pending_peers.map((peer) => normalizePeerUrl(peer)).filter(Boolean)
      : [];
    if (entrySequence === null || previousPendingPeers.length <= 0) {
      return { ...entry, pending_peers: previousPendingPeers };
    }
    const pendingPeers = previousPendingPeers.filter((peer) => {
      const result = peerResults[peer];
      return !result || (Number(result.ack_persisted_sequence || 0) < entrySequence && Number(result.ack_processed_sequence || 0) < entrySequence);
    });
    return {
      ...entry,
      pending_peers: pendingPeers,
      acknowledged_peer_count: Number(entry.peer_count || previousPendingPeers.length) - pendingPeers.length,
      processed_peer_count: Number(entry.peer_count || previousPendingPeers.length) - pendingPeers.length,
      failing_peer_count: pendingPeers.length,
      closed_at: pendingPeers.length === 0 ? input.attemptAt || entry.closed_at || null : null,
    };
  };
  const pendingPeers = peerKeys.filter((peer) => {
    const result = peerResults[peer];
    return !result || (result.ack_persisted_sequence !== sequence && result.ack_processed_sequence !== sequence);
  });
  const acknowledgedPeers = peerKeys.filter((peer) => Number(peerResults[peer]?.ack_persisted_sequence) === sequence);
  const processedPeers = peerKeys.filter((peer) => Number(peerResults[peer]?.ack_processed_sequence) === sequence);
  const existing = (previousOutbox || []).filter((entry) => Number(entry.sequence) !== sequence);
  const generatedAt = input.generatedAt ?? null;
  const expiresAt = generatedAt ? new Date(Date.parse(generatedAt) + 24 * 60 * 60 * 1000).toISOString() : null;
  const message = {
    message_id: `${input.streamId ?? "stream"}:${sequence}`,
    local_host_id: input.hostId ?? null,
    stream_id: input.streamId ?? null,
    sequence,
    generated_at: generatedAt,
    expires_at: expiresAt,
    payload_sha256: payloadDigest(input.payload),
    payload_bytes: payloadBytes(input.payload),
    peer_count: peerKeys.length,
    acknowledged_peer_count: acknowledgedPeers.length,
    processed_peer_count: processedPeers.length,
    failing_peer_count: peerKeys.length - processedPeers.length,
    pending_peers: pendingPeers,
    closed_at: pendingPeers.length === 0 ? input.attemptAt || null : null,
  };
  const nowMs = Date.parse(input.attemptAt || new Date().toISOString());
  return [...existing.map(refreshPendingPeers), message]
    .filter((entry) => {
      const expiresMs = Date.parse(entry.expires_at || "");
      const hasPendingPeers = Array.isArray(entry.pending_peers) && entry.pending_peers.length > 0;
      return hasPendingPeers && (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs) || expiresMs >= nowMs || !entry.closed_at);
    })
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(-25);
}

function buildRetryLedgerEntries(input, peerResults) {
  return (input.sends || []).map((send) => {
    const peer = normalizePeerUrl(send.peer);
    const result = peerResults[peer] || {};
    return {
      attempt_id: `${input.streamId ?? "stream"}:${input.sequence ?? "unknown"}:${peer}:${input.attemptAt}`,
      peer_key: peer,
      message_id: `${input.streamId ?? "stream"}:${input.sequence ?? "unknown"}`,
      sequence: input.sequence ?? null,
      attempted_at: input.attemptAt || null,
      target_peer_url: send.target_peer ?? send.peer ?? null,
      http_status: Number.isFinite(Number(send.status)) ? Number(send.status) : null,
      ok: send.ok === true,
      error_text: send.ok === true ? null : compactSidecarText(send.error || send.response?.error || send.response?.raw || "", 500),
      response_json: compactSidecarValue(send.response ?? null),
      next_retry_at: result.next_retry_at ?? null,
      locator_source: send.locator_source ?? null,
      matched_host_id: send.matched_host_id ?? null,
    };
  });
}

export function recordSidecarCycle(filePath, input) {
  const state = loadSidecarState(filePath);
  const attemptAt = input.attemptAt || new Date().toISOString();
  const configuredPeers = [...new Set((input.sends || []).map((send) => normalizePeerUrl(send.peer)).filter(Boolean))];
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
  const outbox = updateOutbox(state.outbox, input, peerResults);
  const retryLedger = [...(state.retry_ledger || []), ...buildRetryLedgerEntries(input, peerResults)].slice(-100);
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
    configured_peers: configuredPeers,
    peer_results: peerResults,
    outbox,
    retry_ledger: retryLedger,
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
  const configuredPeers = Array.isArray(state?.configured_peers)
    ? new Set(state.configured_peers.map(normalizePeerUrl).filter(Boolean))
    : new Set();
  const allPeerResults = Object.values(state?.peer_results || {}).filter((entry) => entry && typeof entry === "object");
  const peerResults =
    configuredPeers.size > 0 ? allPeerResults.filter((entry) => configuredPeers.has(normalizePeerUrl(entry.peer))) : allPeerResults;
  const outbox = Array.isArray(state?.outbox) ? state.outbox.filter((entry) => entry && typeof entry === "object") : [];
  const pendingOutbox = outbox.filter((entry) => {
    if (entry.closed_at || !Array.isArray(entry.pending_peers) || entry.pending_peers.length <= 0) {
      return false;
    }
    if (configuredPeers.size <= 0) {
      return true;
    }
    return entry.pending_peers.some((peer) => configuredPeers.has(normalizePeerUrl(peer)));
  });
  const lastCycleAt = state?.last_cycle_at ? String(state.last_cycle_at) : null;
  const oldestPendingAt = pendingOutbox
    .map((entry) => Date.parse(String(entry.generated_at || "")))
    .filter((entry) => Number.isFinite(entry))
    .sort((left, right) => left - right)[0];
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
    outbox_depth: pendingOutbox.length,
    oldest_pending_age_seconds: Number.isFinite(oldestPendingAt) ? Math.max(0, Math.round((Date.now() - oldestPendingAt) / 1000)) : null,
    ack_cursor_min_sequence:
      peerResults.length > 0
        ? Math.min(...peerResults.map((entry) => Number(entry.ack_persisted_sequence || 0)).filter((entry) => Number.isFinite(entry)))
        : null,
    processed_cursor_min_sequence:
      peerResults.length > 0
        ? Math.min(...peerResults.map((entry) => Number(entry.ack_processed_sequence || 0)).filter((entry) => Number.isFinite(entry)))
        : null,
    retry_ledger_count: Array.isArray(state?.retry_ledger) ? state.retry_ledger.length : 0,
  };
}
