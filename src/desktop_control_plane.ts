import os from "node:os";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function ageSeconds(value: string | null | undefined) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - parsed) / 1000);
}

export type DesktopControlCapabilityProbeRecord = {
  generated_at: string | null;
  platform: string;
  osascript: boolean;
  screencapture: boolean;
  open: boolean;
  pbcopy: boolean;
  pbpaste: boolean;
  swift: boolean;
  can_observe: boolean;
  can_act: boolean;
  can_listen: boolean;
};

export type DesktopControlStateRecord = {
  enabled: boolean;
  allow_observe: boolean;
  allow_act: boolean;
  allow_listen: boolean;
  screenshot_dir: string;
  action_timeout_ms: number;
  listen_max_seconds: number;
  heartbeat_interval_seconds: number;
  last_heartbeat_at: string | null;
  last_observation_at: string | null;
  last_screenshot_at: string | null;
  last_action_at: string | null;
  last_listen_at: string | null;
  last_frontmost_app: string | null;
  last_frontmost_window: string | null;
  last_error: string | null;
  capability_probe: DesktopControlCapabilityProbeRecord;
  updated_at: string | null;
  source: "default" | "persisted";
};

function defaultCapabilityProbe(): DesktopControlCapabilityProbeRecord {
  return {
    generated_at: null,
    platform: process.platform,
    osascript: false,
    screencapture: false,
    open: false,
    pbcopy: false,
    pbpaste: false,
    swift: false,
    can_observe: false,
    can_act: false,
    can_listen: false,
  };
}

export function getDefaultDesktopControlState(): DesktopControlStateRecord {
  return {
    enabled: false,
    allow_observe: true,
    allow_act: false,
    allow_listen: false,
    screenshot_dir: path.join(os.tmpdir(), "mcplayground-desktop-control"),
    action_timeout_ms: 15_000,
    listen_max_seconds: 15,
    heartbeat_interval_seconds: 300,
    last_heartbeat_at: null,
    last_observation_at: null,
    last_screenshot_at: null,
    last_action_at: null,
    last_listen_at: null,
    last_frontmost_app: null,
    last_frontmost_window: null,
    last_error: null,
    capability_probe: defaultCapabilityProbe(),
    updated_at: null,
    source: "default",
  };
}

export function normalizeDesktopControlState(value: unknown, updatedAt: string | null): DesktopControlStateRecord {
  const base = getDefaultDesktopControlState();
  const input = isRecord(value) ? value : {};
  const probeInput = isRecord(input.capability_probe) ? input.capability_probe : {};
  const probe: DesktopControlCapabilityProbeRecord = {
    generated_at: readString(probeInput.generated_at),
    platform: readString(probeInput.platform) ?? base.capability_probe.platform,
    osascript: readBoolean(probeInput.osascript),
    screencapture: readBoolean(probeInput.screencapture),
    open: readBoolean(probeInput.open),
    pbcopy: readBoolean(probeInput.pbcopy),
    pbpaste: readBoolean(probeInput.pbpaste),
    swift: readBoolean(probeInput.swift),
    can_observe: readBoolean(probeInput.can_observe),
    can_act: readBoolean(probeInput.can_act),
    can_listen: readBoolean(probeInput.can_listen),
  };
  return {
    enabled: readBoolean(input.enabled, base.enabled),
    allow_observe: readBoolean(input.allow_observe, base.allow_observe),
    allow_act: readBoolean(input.allow_act, base.allow_act),
    allow_listen: readBoolean(input.allow_listen, base.allow_listen),
    screenshot_dir: readString(input.screenshot_dir) ?? base.screenshot_dir,
    action_timeout_ms: clampNumber(readFiniteNumber(input.action_timeout_ms) ?? base.action_timeout_ms, 500, 120_000),
    listen_max_seconds: clampNumber(readFiniteNumber(input.listen_max_seconds) ?? base.listen_max_seconds, 1, 300),
    heartbeat_interval_seconds: clampNumber(
      readFiniteNumber(input.heartbeat_interval_seconds) ?? base.heartbeat_interval_seconds,
      5,
      86_400
    ),
    last_heartbeat_at: readString(input.last_heartbeat_at),
    last_observation_at: readString(input.last_observation_at),
    last_screenshot_at: readString(input.last_screenshot_at),
    last_action_at: readString(input.last_action_at),
    last_listen_at: readString(input.last_listen_at),
    last_frontmost_app: readString(input.last_frontmost_app),
    last_frontmost_window: readString(input.last_frontmost_window),
    last_error: readString(input.last_error),
    capability_probe: probe,
    updated_at: updatedAt,
    source: updatedAt ? "persisted" : "default",
  };
}

export function summarizeDesktopControlState(state: DesktopControlStateRecord) {
  const heartbeatAgeSeconds = ageSeconds(state.last_heartbeat_at);
  const stale =
    state.enabled &&
    (!Number.isFinite(heartbeatAgeSeconds) || heartbeatAgeSeconds > Math.max(state.heartbeat_interval_seconds * 3, 300));
  const observeReady = state.enabled && state.allow_observe && state.capability_probe.can_observe;
  const actReady = state.enabled && state.allow_act && state.capability_probe.can_act;
  const listenReady = state.enabled && state.allow_listen && state.capability_probe.can_listen;
  const screenshotProof = observeReady && Boolean(readString(state.last_screenshot_at)) && !state.last_error;
  const actuationProof = actReady && Boolean(readString(state.last_action_at)) && !state.last_error;
  const listenProof = listenReady && Boolean(readString(state.last_listen_at)) && !state.last_error;
  const capabilityCount = [observeReady, actReady, listenReady].filter(Boolean).length;
  return {
    enabled: state.enabled,
    stale,
    observe_enabled: state.allow_observe,
    act_enabled: state.allow_act,
    listen_enabled: state.allow_listen,
    observe_ready: observeReady,
    act_ready: actReady,
    listen_ready: listenReady,
    screen_recording_proven: screenshotProof,
    accessibility_actuation_proven: actuationProof,
    microphone_listen_proven: listenProof,
    available_capability_count: capabilityCount,
    heartbeat_age_seconds: Number.isFinite(heartbeatAgeSeconds) ? Number(heartbeatAgeSeconds.toFixed(2)) : null,
    last_frontmost_app: state.last_frontmost_app,
    last_frontmost_window: state.last_frontmost_window,
    last_error: state.last_error,
    probe: state.capability_probe,
  };
}
