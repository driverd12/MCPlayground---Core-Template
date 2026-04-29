import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type DesktopControlCapabilityProbeRecord, summarizeDesktopControlState } from "../desktop_control_plane.js";
import { type RuntimeEventRecord, Storage, type WorkerFabricHostRecord } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopListenScriptPath = path.join(repoRoot, "scripts", "desktop_listen.swift");

const modifierSchema = z.enum(["command", "control", "option", "shift"]);
const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const desktopControlSchema = z
  .object({
    action: z.enum(["status", "set", "heartbeat"]).default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    allow_observe: z.boolean().optional(),
    allow_act: z.boolean().optional(),
    allow_listen: z.boolean().optional(),
    screenshot_dir: z.string().min(1).optional(),
    action_timeout_ms: z.number().int().min(500).max(120000).optional(),
    listen_max_seconds: z.number().int().min(1).max(300).optional(),
    heartbeat_interval_seconds: z.number().int().min(5).max(86400).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if ((value.action === "set" || value.action === "heartbeat") && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=set and action=heartbeat",
        path: ["mutation"],
      });
    }
  });

export const desktopObserveSchema = z
  .object({
    action: z.enum(["status", "frontmost_app", "clipboard", "screenshot"]).default("status"),
    mutation: mutationSchema.optional(),
    format: z.enum(["png"]).default("png"),
    filename: z.string().min(1).max(200).optional(),
    delay_ms: z.number().int().min(0).max(10000).default(0),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "screenshot" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=screenshot",
        path: ["mutation"],
      });
    }
  });

export const desktopActSchema = z
  .object({
    action: z.enum(["open_app", "open_url", "type_text", "key_press", "set_clipboard"]),
    mutation: mutationSchema,
    app: z.string().min(1).max(200).optional(),
    url: z.string().url().optional(),
    text: z.string().min(1).max(20000).optional(),
    key: z.string().min(1).max(40).optional(),
    modifiers: z.array(modifierSchema).max(4).optional(),
    target_app: z.string().min(1).max(200).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "open_app" && !value.app) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "app is required for action=open_app", path: ["app"] });
    }
    if (value.action === "open_url" && !value.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url is required for action=open_url", path: ["url"] });
    }
    if ((value.action === "type_text" || value.action === "set_clipboard") && !value.text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "text is required for the requested action", path: ["text"] });
    }
    if (value.action === "key_press" && !value.key) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "key is required for action=key_press", path: ["key"] });
    }
  });

export const desktopListenSchema = z
  .object({
    action: z.enum(["status", "record"]).default("status"),
    mutation: mutationSchema.optional(),
    duration_seconds: z.number().min(1).max(300).optional(),
    format: z.enum(["m4a"]).default("m4a"),
    filename: z.string().min(1).max(200).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "record" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=record",
        path: ["mutation"],
      });
    }
  });

export const desktopContextSchema = z
  .object({
    action: z.enum(["status", "latest", "search"]).default("latest"),
    prefer_source: z.enum(["auto", "chronicle", "desktop_observe"]).default("auto"),
    fallback_screenshot: z.boolean().default(true),
    mutation: mutationSchema.optional(),
    query: z.string().min(1).max(500).optional(),
    max_freshness_seconds: z.number().min(1).max(3600).default(120),
    ocr_max_hits: z.number().int().min(1).max(50).default(10),
    host_id: z.string().min(1).max(120).optional(),
    display_id: z.string().min(1).max(120).optional(),
    filename: z.string().min(1).max(200).optional(),
    delay_ms: z.number().int().min(0).max(10000).default(0),
    requesting_host_id: z.string().min(1).max(120).optional(),
    requesting_remote_address: z.string().min(1).max(120).optional(),
    requesting_network_gate_reason: z.string().min(1).max(120).optional(),
    requesting_permission_profile: z.string().min(1).max(120).optional(),
    requesting_signature_status: z.string().min(1).max(120).optional(),
    requesting_signed_at: z.string().min(1).max(120).optional(),
    requesting_received_at: z.string().min(1).max(120).optional(),
    requesting_signed_agent_id: z.string().min(1).max(200).optional(),
    requesting_identity_public_key_fingerprint: z.string().min(1).max(240).optional(),
    requesting_hostname: z.string().min(1).max(255).optional(),
    requesting_mac_address: z.string().min(1).max(120).optional(),
    requesting_display_name: z.string().min(1).max(200).optional(),
    requesting_agent_runtime: z.string().min(1).max(120).optional(),
    requesting_model_label: z.string().min(1).max(200).optional(),
    signed_at: z.string().min(1).max(120).optional(),
    received_at: z.string().min(1).max(120).optional(),
    signature_verification_result: z.record(z.unknown()).optional(),
    approval_scope: z.record(z.unknown()).optional(),
    whitelist_scope: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "search" && !value.query?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "query is required for action=search",
        path: ["query"],
      });
    }
  });

type CommandResult = {
  ok: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

function isDryRunEnabled() {
  return process.env.MCP_DESKTOP_CONTROL_DRY_RUN === "1";
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function compactText(value: string, limit = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit <= 3) {
    return normalized.slice(0, limit);
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function commandExists(command: string) {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000,
    input: options.input,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function ensureDirectory(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function extensionForFormat(format: "png" | "m4a") {
  return format;
}

function buildOutputPath(baseDir: string, prefix: string, format: "png" | "m4a", filename?: string) {
  ensureDirectory(baseDir);
  const provided = readString(filename);
  if (provided) {
    const ext = path.extname(provided).toLowerCase();
    if (ext === `.${format}`) {
      return path.join(baseDir, provided);
    }
    return path.join(baseDir, `${provided}.${extensionForFormat(format)}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(baseDir, `${prefix}-${stamp}.${extensionForFormat(format)}`);
}

function readFrontmostOverride() {
  const override = readString(process.env.MCP_DESKTOP_CONTROL_TEST_FRONTMOST);
  if (!override) {
    return null;
  }
  const [appName, windowTitle = ""] = override.split("|");
  return {
    app_name: appName.trim(),
    window_title: windowTitle.trim(),
  };
}

function readClipboardOverride() {
  return readString(process.env.MCP_DESKTOP_CONTROL_TEST_CLIPBOARD);
}

function buildCapabilityProbe(): DesktopControlCapabilityProbeRecord {
  const osascript = commandExists("osascript");
  const screencapture = commandExists("screencapture");
  const open = commandExists("open");
  const pbcopy = commandExists("pbcopy");
  const pbpaste = commandExists("pbpaste");
  const swift = commandExists("swift") && fs.existsSync(desktopListenScriptPath);
  return {
    generated_at: new Date().toISOString(),
    platform: process.platform,
    osascript,
    screencapture,
    open,
    pbcopy,
    pbpaste,
    swift,
    can_observe: osascript || screencapture || pbpaste,
    can_act: open || osascript || pbcopy,
    can_listen: process.platform === "darwin" && swift,
  };
}

function buildStatusPayload(storage: Storage) {
  const state = storage.getDesktopControlState();
  return {
    state,
    summary: summarizeDesktopControlState(state),
    source: "desktop.control",
  };
}

function requireDesktopEnabled(storage: Storage, capability: "observe" | "act" | "listen") {
  const state = storage.getDesktopControlState();
  if (!state.enabled) {
    throw new Error("desktop control is disabled");
  }
  if (capability === "observe" && !state.allow_observe) {
    throw new Error("desktop observation is disabled by policy");
  }
  if (capability === "act" && !state.allow_act) {
    throw new Error("desktop actuation is disabled by policy");
  }
  if (capability === "listen" && !state.allow_listen) {
    throw new Error("desktop listening is disabled by policy");
  }
  return state;
}

function recordRuntimeEvent(
  storage: Storage,
  params: {
    event_type: string;
    status: string;
    summary: string;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
): RuntimeEventRecord {
  return storage.appendRuntimeEvent({
    event_type: params.event_type,
    entity_type: "daemon",
    entity_id: "desktop.control",
    status: params.status,
    summary: params.summary,
    details: params.details ?? {},
    source_client: params.source_client ?? "desktop.control",
    source_model: params.source_model,
    source_agent: params.source_agent ?? "ring-leader",
  });
}

function currentTmpDir() {
  return readString(process.env.TMPDIR) ?? os.tmpdir();
}

function chronicleRecordingRoot() {
  return path.join(currentTmpDir(), "chronicle", "screen_recording");
}

function uniquePaths(paths: Array<string | null>) {
  return [...new Set(paths.filter((entry): entry is string => Boolean(readString(entry))))];
}

function chronicleRecorderPidPaths() {
  const root = currentTmpDir();
  return uniquePaths([
    readString(process.env.CHRONICLE_PID_PATH),
    path.join(root, "codex_chronicle", "chronicle-started.pid"),
    path.join(root, "codex_tape_recorder", "chronicle-started.pid"),
  ]);
}

function chronicleRecorderStatus() {
  const pidPathsChecked = chronicleRecorderPidPaths();
  let firstExistingPidPath: string | null = null;
  for (const pidPath of pidPathsChecked) {
    let rawPid = "";
    try {
      rawPid = fs.readFileSync(pidPath, "utf8").trim();
      firstExistingPidPath = firstExistingPidPath ?? pidPath;
    } catch {
      continue;
    }
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    try {
      process.kill(pid, 0);
      return { live: true, unavailable_reason: null as string | null, pid_path: pidPath, pid_paths_checked: pidPathsChecked };
    } catch (error) {
      const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
      if (code === "EPERM") {
        return { live: true, unavailable_reason: null as string | null, pid_path: pidPath, pid_paths_checked: pidPathsChecked };
      }
    }
  }
  return {
    live: false,
    unavailable_reason: "chronicle_recorder_not_running",
    pid_path: firstExistingPidPath,
    pid_paths_checked: pidPathsChecked,
  };
}

function safeStat(filePath: string) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function roundSeconds(value: number) {
  return Number(value.toFixed(3));
}

function latestFrameDisplayId(filename: string) {
  const match = filename.match(/-display-(.+)-latest\.jpg$/);
  return match ? match[1] : "unknown";
}

type ChronicleDisplayContext = {
  display_id: string;
  segment_id: string;
  latest_frame_path: string;
  latest_frame_mtime: string;
  freshness_seconds: number;
  stale: boolean;
  capture_metadata_path: string | null;
  capture_metadata: Record<string, unknown> | null;
  ocr_path: string | null;
  sparse_history_dir: string | null;
};

function chronicleNextAction(params: { status: string; stale_reason?: string | null; unavailable_reason?: string | null }) {
  if (params.status === "available") {
    return "Use the frame path for visual context, then switch to app, file, or connector data once the target is identified.";
  }
  if (params.stale_reason) {
    return "Refresh the Codex/Chronicle desktop capture lane or call desktop.context with fallback_screenshot=true and a mutation to capture a fresh screenshot.";
  }
  if (params.unavailable_reason === "chronicle_recorder_not_running") {
    return "Start or restart the Codex/Chronicle desktop capture lane and confirm macOS Screen Recording permission.";
  }
  return "Refresh Chronicle or call desktop.context with fallback_screenshot=true and a mutation to capture a fresh screenshot.";
}

function listChronicleDisplays(input: { max_freshness_seconds: number; display_id?: string }) {
  const recorder = chronicleRecorderStatus();
  const root = chronicleRecordingRoot();
  if (!recorder.live) {
    return {
      ok: false,
      root,
      displays: [] as ChronicleDisplayContext[],
      unavailable_reason: recorder.unavailable_reason ?? "chronicle_recorder_not_running",
      stale_reason: null as string | null,
      recorder_pid_path: recorder.pid_path,
      recorder_pid_paths_checked: recorder.pid_paths_checked,
    };
  }
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      root,
      displays: [] as ChronicleDisplayContext[],
      unavailable_reason: "chronicle_recording_root_missing",
      stale_reason: null as string | null,
      recorder_pid_path: recorder.pid_path,
      recorder_pid_paths_checked: recorder.pid_paths_checked,
    };
  }

  const nowMs = Date.now();
  const displayFilter = readString(input.display_id);
  const observedDisplays = fs
    .readdirSync(root)
    .filter((filename) => filename.endsWith("-latest.jpg"))
    .map((filename) => {
      const displayId = latestFrameDisplayId(filename);
      if (displayFilter && displayFilter !== displayId) {
        return null;
      }
      const segmentId = filename.replace(/-latest\.jpg$/, "");
      const latestFramePath = path.join(root, filename);
      const stat = safeStat(latestFramePath);
      if (!stat) {
        return null;
      }
      const captureMetadataPath = path.join(root, `${segmentId}.capture.json`);
      const ocrPath = path.join(root, `${segmentId}.ocr.jsonl`);
      const sparseHistoryDir = path.join(root, "1min", segmentId);
      const freshnessSeconds = Math.max(0, (nowMs - stat.mtimeMs) / 1000);
      return {
        display_id: displayId,
        segment_id: segmentId,
        latest_frame_path: latestFramePath,
        latest_frame_mtime: stat.mtime.toISOString(),
        freshness_seconds: roundSeconds(freshnessSeconds),
        stale: freshnessSeconds > input.max_freshness_seconds,
        capture_metadata_path: fs.existsSync(captureMetadataPath) ? captureMetadataPath : null,
        capture_metadata: fs.existsSync(captureMetadataPath) ? safeReadJsonRecord(captureMetadataPath) : null,
        ocr_path: fs.existsSync(ocrPath) ? ocrPath : null,
        sparse_history_dir: fs.existsSync(sparseHistoryDir) ? sparseHistoryDir : null,
      };
    })
    .filter((entry): entry is ChronicleDisplayContext => entry !== null);
  const newestByDisplay = new Map<string, ChronicleDisplayContext>();
  for (const display of observedDisplays) {
    const existing = newestByDisplay.get(display.display_id);
    if (!existing || Date.parse(display.latest_frame_mtime) > Date.parse(existing.latest_frame_mtime)) {
      newestByDisplay.set(display.display_id, display);
    }
  }
  const displays = [...newestByDisplay.values()].sort((left, right) => left.display_id.localeCompare(right.display_id));

  const unavailableReason = displays.length <= 0 ? "chronicle_latest_frame_missing" : null;
  const staleReason =
    displays.length > 0 && displays.every((display) => display.stale) ? "chronicle_latest_frames_stale" : null;
  return {
    ok: displays.length > 0 && !staleReason,
    root,
    displays,
    unavailable_reason: unavailableReason,
    stale_reason: staleReason,
    recorder_pid_path: recorder.pid_path,
    recorder_pid_paths_checked: recorder.pid_paths_checked,
  };
}

function readFileTail(filePath: string, maxBytes: number) {
  const stat = safeStat(filePath);
  if (!stat) {
    return "";
  }
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function collectStringFragments(value: unknown, fragments: string[] = [], depth = 0) {
  if (fragments.length >= 20 || depth > 4) {
    return fragments;
  }
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact) {
      fragments.push(compact);
    }
    return fragments;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringFragments(entry, fragments, depth + 1);
      if (fragments.length >= 20) break;
    }
    return fragments;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStringFragments(entry, fragments, depth + 1);
      if (fragments.length >= 20) break;
    }
  }
  return fragments;
}

function chronicleOcrHits(displays: ChronicleDisplayContext[], query: string | undefined, maxHits: number) {
  const needle = readString(query)?.toLowerCase();
  if (!needle) {
    return undefined;
  }
  const hits: Array<Record<string, unknown>> = [];
  for (const display of displays) {
    if (!display.ocr_path || hits.length >= maxHits) {
      continue;
    }
    const text = readFileTail(display.ocr_path, 2_000_000);
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let index = 0; index < lines.length && hits.length < maxHits; index += 1) {
      const line = lines[index];
      if (!line.toLowerCase().includes(needle)) {
        continue;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const fragments = collectStringFragments(parsed).join(" ");
      const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      hits.push({
        display_id: display.display_id,
        ocr_path: display.ocr_path,
        line_offset_from_tail: index,
        timestamp:
          readString(parsedRecord.timestamp) ??
          readString(parsedRecord.created_at) ??
          readString(parsedRecord.ts) ??
          readString(parsedRecord.time),
        text_excerpt: compactText(fragments || line, 360),
      });
    }
  }
  return hits;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  const record = readRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remoteAccessForHost(host: WorkerFabricHostRecord) {
  return readRecord(readRecord(host.metadata).remote_access);
}

function desktopContextIdentity(input: z.infer<typeof desktopContextSchema>, params?: {
  captured_from_host_id?: string | null;
  captured_hostname?: string | null;
  captured_agent_runtime?: string | null;
  captured_model_label?: string | null;
}) {
  const capturedFromHostId = params?.captured_from_host_id ?? input.host_id ?? "local";
  return {
    requesting_host_id: readString(input.requesting_host_id) ?? null,
    requesting_remote_address: readString(input.requesting_remote_address) ?? null,
    requesting_network_gate_reason: readString(input.requesting_network_gate_reason) ?? null,
    requesting_permission_profile: readString(input.requesting_permission_profile) ?? null,
    requesting_signature_status: readString(input.requesting_signature_status) ?? null,
    requesting_signed_agent_id: readString(input.requesting_signed_agent_id) ?? null,
    requesting_identity_public_key_fingerprint: readString(input.requesting_identity_public_key_fingerprint) ?? null,
    requesting_hostname: readString(input.requesting_hostname) ?? null,
    requesting_mac_address: readString(input.requesting_mac_address) ?? null,
    requesting_display_name: readString(input.requesting_display_name) ?? null,
    requesting_agent_runtime: readString(input.requesting_agent_runtime) ?? null,
    requesting_model_label: readString(input.requesting_model_label) ?? null,
    captured_from_host_id: capturedFromHostId,
    captured_hostname: params?.captured_hostname ?? (capturedFromHostId === "local" ? os.hostname() : null),
    captured_agent_runtime: params?.captured_agent_runtime ?? (capturedFromHostId === "local" ? "local" : null),
    captured_model_label: params?.captured_model_label ?? null,
    signed_at: readString(input.signed_at) ?? readString(input.requesting_signed_at) ?? null,
    received_at: readString(input.received_at) ?? readString(input.requesting_received_at) ?? null,
    signature_verification_result: readOptionalRecord(input.signature_verification_result),
    approval_scope: readOptionalRecord(input.approval_scope),
    whitelist_scope: readOptionalRecord(input.whitelist_scope),
  };
}

function parseRemoteProbeJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function runRemoteContextProbe(params: {
  host: WorkerFabricHostRecord;
  action: "latest" | "search" | "screenshot";
  input: z.infer<typeof desktopContextSchema>;
  timeoutMs: number;
}) {
  const probeArgs = [
    `--action=${params.action}`,
    `--max-freshness-seconds=${params.input.max_freshness_seconds}`,
    `--ocr-max-hits=${params.input.ocr_max_hits}`,
  ];
  if (params.input.display_id) {
    probeArgs.push(`--display-id=${params.input.display_id}`);
  }
  if (params.input.query) {
    probeArgs.push(`--query=${params.input.query}`);
  }
  const remoteRuntimePrelude = [
    "[ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1 || true;",
    "for candidate in \"$HOME\"/.nvm/versions/node/*/bin /opt/homebrew/bin /usr/local/bin \"$HOME\"/.local/node-*/bin; do",
    "[ -d \"$candidate\" ] && PATH=\"$candidate:$PATH\";",
    "done;",
    "export PATH;",
  ].join(" ");
  const command = [
    remoteRuntimePrelude,
    `cd ${shellQuote(params.host.workspace_root)}`,
    "&&",
    "node",
    "./scripts/remote_context_probe.mjs",
    ...probeArgs.map(shellQuote),
  ].join(" ");
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", params.host.ssh_destination ?? "", command],
    {
      encoding: "utf8",
      timeout: Math.max(10_000, params.timeoutMs + 5_000),
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  return {
    result,
    parsed: result.status === 0 ? parseRemoteProbeJson(result.stdout) : null,
  };
}

function remoteProbeStatus(parsed: Record<string, unknown> | null) {
  const status = readString(parsed?.status);
  return status === "available" || status === "degraded" || status === "unavailable" ? status : "unavailable";
}

function remoteProbeDisplays(parsed: Record<string, unknown> | null) {
  return Array.isArray(parsed?.displays) ? parsed.displays : [];
}

function remoteProbeOcrHits(parsed: Record<string, unknown> | null) {
  return Array.isArray(parsed?.ocr_hits) ? parsed.ocr_hits : undefined;
}

function remoteHostContextIdentity(input: z.infer<typeof desktopContextSchema>, host: WorkerFabricHostRecord, parsed?: Record<string, unknown> | null) {
  const remoteAccess = remoteAccessForHost(host);
  const hostInfo = readRecord(parsed?.host);
  return desktopContextIdentity(input, {
    captured_from_host_id: host.host_id,
    captured_hostname: readString(hostInfo.hostname) ?? readString(remoteAccess.hostname) ?? host.host_id,
    captured_agent_runtime: readString(remoteAccess.agent_runtime),
    captured_model_label: readString(remoteAccess.model_label),
  });
}

function recordHostDesktopContext(
  storage: Storage,
  hostId: string,
  context: {
    status: string;
    source: string;
    generated_at: string;
    freshness_seconds?: number | null;
    display_count?: number;
    latest_frame_path?: string | null;
    screenshot_path?: string | null;
    stale_reason?: string | null;
    unavailable_reason?: string | null;
    event_id?: string | null;
  }
) {
  const state = storage.getWorkerFabricState();
  if (!state?.hosts.some((host) => host.host_id === hostId)) {
    return;
  }
  const updatedAt = new Date().toISOString();
  storage.setWorkerFabricState({
    enabled: state.enabled,
    strategy: state.strategy,
    default_host_id: state.default_host_id,
    hosts: state.hosts.map((host) =>
      host.host_id === hostId
        ? {
            ...host,
            metadata: {
              ...host.metadata,
              desktop_context: {
                ...context,
                stale: context.status !== "available",
                updated_at: updatedAt,
              },
            },
            updated_at: updatedAt,
          }
        : host
    ),
  });
}

function desktopContextRemote(
  storage: Storage,
  input: z.infer<typeof desktopContextSchema>,
  params: {
    generatedAt: string;
    authoritySummary: ReturnType<typeof summarizeDesktopControlState>;
    timeoutMs: number;
    screenshotDir: string;
  }
) {
  const hostId = input.host_id?.trim();
  const fabric = storage.getWorkerFabricState();
  const host = fabric?.hosts.find((entry) => entry.host_id === hostId) ?? null;
  if (!host) {
    const identity = desktopContextIdentity(input, { captured_from_host_id: hostId ?? null });
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: `desktop.context unavailable: unknown remote host ${hostId ?? "unknown"}`,
            details: {
              ...identity,
              source: "none",
              action: input.action,
              unavailable_reason: "remote_host_unknown",
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      current_utc: params.generatedAt,
      freshness_seconds: null,
      displays: [],
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: null,
      unavailable_reason: "remote_host_unknown",
      authority_summary: params.authoritySummary,
      recommended_next_action: "Stage and approve the remote host before requesting its desktop context.",
      event_id: event?.event_id ?? null,
      ...identity,
    };
  }

  const remoteAccess = remoteAccessForHost(host);
  const desktopContextAllowed =
    host.capabilities.desktop_context === true ||
    host.capabilities.desktop_observe === true ||
    readString(remoteAccess.permission_profile) === "operator";
  const approved =
    host.enabled &&
    host.transport === "ssh" &&
    Boolean(host.ssh_destination) &&
    readString(remoteAccess.status) === "approved" &&
    desktopContextAllowed;
  const baseIdentity = remoteHostContextIdentity(input, host);
  if (!approved) {
    const unavailableReason = desktopContextAllowed ? "remote_host_not_approved" : "remote_host_desktop_context_not_allowed";
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: `desktop.context unavailable: remote host ${host.host_id} is not approved for SSH context capture`,
            details: {
              ...baseIdentity,
              source: "none",
              action: input.action,
              unavailable_reason: unavailableReason,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    recordHostDesktopContext(storage, host.host_id, {
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      freshness_seconds: null,
      display_count: 0,
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: null,
      unavailable_reason: unavailableReason,
      event_id: event?.event_id ?? null,
    });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      current_utc: params.generatedAt,
      freshness_seconds: null,
      displays: [],
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: null,
      unavailable_reason: unavailableReason,
      authority_summary: params.authoritySummary,
      recommended_next_action: "Approve the host in Agent Office with desktop-context permission before using it as a context source.",
      event_id: event?.event_id ?? null,
      ...baseIdentity,
    };
  }

  const probeAction = input.action === "search" ? "search" : "latest";
  const shouldTryChronicle = input.prefer_source !== "desktop_observe";
  const shouldTryScreenshot = input.prefer_source === "desktop_observe" || input.fallback_screenshot;
  const chronicle = shouldTryChronicle
    ? runRemoteContextProbe({ host, action: probeAction, input, timeoutMs: params.timeoutMs })
    : null;
  const chroniclePayload = chronicle?.parsed ?? null;
  const chronicleStatus = chronicle ? remoteProbeStatus(chroniclePayload) : "unavailable";
  const shouldReturnChronicle =
    chronicle &&
    (chronicleStatus === "available" || input.prefer_source === "chronicle" || input.action === "status" || !shouldTryScreenshot);
  if (shouldReturnChronicle) {
    const identity = remoteHostContextIdentity(input, host, chroniclePayload);
    const chronicleStaleReason = readString(chroniclePayload?.stale_reason);
    const chronicleUnavailableReason =
      readString(chroniclePayload?.unavailable_reason) ??
      (chronicleStatus === "unavailable"
        ? chronicleStaleReason ?? (chronicle.result.status === 0 ? "remote_context_source_unavailable" : "remote_context_probe_failed")
        : null);
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: chronicleStatus,
            summary:
              chronicleStatus === "available"
                ? `desktop.context read remote Chronicle context from ${host.host_id}`
                : `desktop.context remote Chronicle degraded for ${host.host_id}`,
            details: {
              ...identity,
              source: readString(chroniclePayload?.source) ?? "chronicle",
              action: input.action,
              latest_frame_path: readString(chroniclePayload?.latest_frame_path),
              freshness_seconds: typeof chroniclePayload?.freshness_seconds === "number" ? chroniclePayload.freshness_seconds : null,
              stale_reason: chronicleStaleReason,
              unavailable_reason: chronicleUnavailableReason,
              ocr_hit_count: remoteProbeOcrHits(chroniclePayload)?.length ?? 0,
              ssh_destination: host.ssh_destination,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    recordHostDesktopContext(storage, host.host_id, {
      status: chronicleStatus,
      source: chronicleStatus === "unavailable" ? "none" : (readString(chroniclePayload?.source) ?? "chronicle"),
      generated_at: readString(chroniclePayload?.generated_at) ?? params.generatedAt,
      freshness_seconds: typeof chroniclePayload?.freshness_seconds === "number" ? chroniclePayload.freshness_seconds : null,
      display_count: remoteProbeDisplays(chroniclePayload).length,
      latest_frame_path: readString(chroniclePayload?.latest_frame_path),
      screenshot_path: null,
      stale_reason: chronicleStaleReason,
      unavailable_reason: chronicleUnavailableReason,
      event_id: event?.event_id ?? null,
    });
    return {
      ok: chronicleStatus !== "unavailable",
      status: chronicleStatus,
      source: chronicleStatus === "unavailable" ? "none" : (readString(chroniclePayload?.source) ?? "chronicle"),
      generated_at: readString(chroniclePayload?.generated_at) ?? params.generatedAt,
      current_utc: readString(chroniclePayload?.current_utc) ?? params.generatedAt,
      freshness_seconds: typeof chroniclePayload?.freshness_seconds === "number" ? chroniclePayload.freshness_seconds : null,
      displays: remoteProbeDisplays(chroniclePayload),
      latest_frame_path: readString(chroniclePayload?.latest_frame_path),
      screenshot_path: null,
      ocr_hits: remoteProbeOcrHits(chroniclePayload),
      ocr_note: readString(chroniclePayload?.ocr_note),
      stale_reason: chronicleStaleReason,
      unavailable_reason: chronicleUnavailableReason,
      authority_summary: params.authoritySummary,
      recommended_next_action:
        chronicleStatus === "available"
          ? "Use the remote frame path for visual context, then switch to app/file/connectors for authoritative work."
          : "Refresh Chronicle on the remote host or retry with fallback_screenshot=true and a mutation.",
      event_id: event?.event_id ?? null,
      ...identity,
    };
  }

  if (!shouldTryScreenshot) {
    const reason =
      readString(chroniclePayload?.stale_reason) ??
      readString(chroniclePayload?.unavailable_reason) ??
      (chronicle?.result.status === 0 ? "remote_context_source_unavailable" : "remote_context_probe_failed");
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: `desktop.context unavailable for ${host.host_id}: ${reason}`,
            details: {
              ...baseIdentity,
              source: "none",
              action: input.action,
              unavailable_reason: reason,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    recordHostDesktopContext(storage, host.host_id, {
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      freshness_seconds: null,
      display_count: remoteProbeDisplays(chroniclePayload).length,
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: readString(chroniclePayload?.stale_reason),
      unavailable_reason: reason,
      event_id: event?.event_id ?? null,
    });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      current_utc: params.generatedAt,
      freshness_seconds: null,
      displays: remoteProbeDisplays(chroniclePayload),
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: readString(chroniclePayload?.stale_reason),
      unavailable_reason: reason,
      authority_summary: params.authoritySummary,
      recommended_next_action: "Enable remote screenshot fallback or restore Chronicle on the requested host.",
      event_id: event?.event_id ?? null,
      ...baseIdentity,
    };
  }

  if (!input.mutation) {
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: `desktop.context remote screenshot fallback for ${host.host_id} requires an idempotent mutation`,
            details: {
              ...baseIdentity,
              source: "none",
              action: input.action,
              unavailable_reason: "desktop_context_screenshot_requires_mutation",
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    recordHostDesktopContext(storage, host.host_id, {
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      freshness_seconds: null,
      display_count: remoteProbeDisplays(chroniclePayload).length,
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: readString(chroniclePayload?.stale_reason),
      unavailable_reason: "desktop_context_screenshot_requires_mutation",
      event_id: event?.event_id ?? null,
    });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: params.generatedAt,
      current_utc: params.generatedAt,
      freshness_seconds: null,
      displays: remoteProbeDisplays(chroniclePayload),
      latest_frame_path: null,
      screenshot_path: null,
      stale_reason: readString(chroniclePayload?.stale_reason),
      unavailable_reason: "desktop_context_screenshot_requires_mutation",
      authority_summary: params.authoritySummary,
      recommended_next_action: "Retry with a mutation so MASTER-MOLD can capture and log the remote screenshot fallback.",
      event_id: event?.event_id ?? null,
      ...baseIdentity,
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "desktop.context",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const screenshotProbe = runRemoteContextProbe({ host, action: "screenshot", input, timeoutMs: params.timeoutMs });
      const screenshotPayload = screenshotProbe.parsed;
      const identity = remoteHostContextIdentity(input, host, screenshotPayload);
      const capturedAt = readString(screenshotPayload?.generated_at) ?? new Date().toISOString();
      const outputPath = buildOutputPath(params.screenshotDir, `desktop-context-${host.host_id}`, "png", input.filename);
      const base64 = readString(screenshotPayload?.screenshot_base64);
      const remoteScreenshot = readRecord(screenshotPayload?.screenshot);
      const dryRun = Boolean(remoteScreenshot.dry_run);
      let sizeBytes = typeof remoteScreenshot.size_bytes === "number" ? remoteScreenshot.size_bytes : 0;
      let captured = false;
      if (base64 && !dryRun) {
        const buffer = Buffer.from(base64, "base64");
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, buffer);
        sizeBytes = buffer.length;
        captured = true;
      }
      const status = captured ? "available" : screenshotProbe.result.status === 0 ? "degraded" : "unavailable";
      const event = recordRuntimeEvent(storage, {
        event_type: "desktop.context",
        status,
        summary: `desktop.context ${captured ? "captured" : "planned"} remote screenshot fallback from ${host.host_id} -> ${outputPath}`,
        details: {
          ...identity,
          source: captured || screenshotProbe.result.status === 0 ? "desktop_observe" : "none",
          action: input.action,
          screenshot_path: outputPath,
          remote_screenshot_path: readString(screenshotPayload?.screenshot_path),
          dry_run: dryRun,
          size_bytes: sizeBytes,
          fallback_from: readString(chroniclePayload?.stale_reason) ?? readString(chroniclePayload?.unavailable_reason),
          screen_recording_proven: captured,
          ssh_destination: host.ssh_destination,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      recordHostDesktopContext(storage, host.host_id, {
        status,
        source: status === "unavailable" ? "none" : "desktop_observe",
        generated_at: capturedAt,
        freshness_seconds: captured ? 0 : null,
        display_count: remoteProbeDisplays(chroniclePayload).length,
        latest_frame_path: null,
        screenshot_path: outputPath,
        stale_reason: readString(chroniclePayload?.stale_reason),
        unavailable_reason:
          status === "unavailable"
            ? readString(screenshotPayload?.unavailable_reason) ?? "remote_screenshot_failed"
            : readString(chroniclePayload?.unavailable_reason),
        event_id: event.event_id,
      });
      return {
        ok: status !== "unavailable",
        status,
        source: status === "unavailable" ? "none" : "desktop_observe",
        generated_at: capturedAt,
        current_utc: capturedAt,
        freshness_seconds: captured ? 0 : null,
        displays: remoteProbeDisplays(chroniclePayload),
        latest_frame_path: null,
        screenshot_path: outputPath,
        screenshot: {
          dry_run: dryRun,
          captured,
          output_path: outputPath,
          remote_output_path: readString(screenshotPayload?.screenshot_path),
          size_bytes: sizeBytes,
          format: "png",
        },
        ocr_hits: input.query ? [] : undefined,
        stale_reason: readString(chroniclePayload?.stale_reason),
        unavailable_reason:
          status === "unavailable"
            ? readString(screenshotPayload?.unavailable_reason) ?? "remote_screenshot_failed"
            : readString(chroniclePayload?.unavailable_reason),
        authority_summary: params.authoritySummary,
        recommended_next_action: "Use the ingested remote screenshot as visual context, then switch to app, file, or connector data for authoritative work.",
        event_id: event.event_id,
        ...identity,
      };
    },
  });
}

function runFrontmostAppQuery(timeoutMs: number) {
  const override = readFrontmostOverride();
  if (override) {
    return override;
  }
  if (process.platform !== "darwin") {
    throw new Error("frontmost app inspection is currently supported on macOS only");
  }
  const script = [
    'tell application "System Events"',
    "set frontProcess to first application process whose frontmost is true",
    "set appName to name of frontProcess",
    'set windowTitle to ""',
    "try",
    "if (count of windows of frontProcess) > 0 then set windowTitle to name of front window of frontProcess",
    "end try",
    "return appName & linefeed & windowTitle",
    "end tell",
  ];
  const result = runCommand(
    "osascript",
    script.flatMap((line) => ["-e", line]),
    { timeoutMs }
  );
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "frontmost app query failed", 300));
  }
  const [appName = "", windowTitle = ""] = result.stdout.split(/\r?\n/);
  return {
    app_name: appName.trim(),
    window_title: windowTitle.trim(),
  };
}

function readClipboardText(timeoutMs: number) {
  const override = readClipboardOverride();
  if (override !== null) {
    return override;
  }
  if (process.platform !== "darwin") {
    throw new Error("clipboard inspection is currently supported on macOS only");
  }
  const result = runCommand("pbpaste", [], { timeoutMs });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "clipboard read failed", 300));
  }
  return result.stdout;
}

function writeClipboardText(text: string, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return { dry_run: true };
  }
  if (process.platform !== "darwin") {
    throw new Error("clipboard writes are currently supported on macOS only");
  }
  const result = runCommand("pbcopy", [], {
    input: text,
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "clipboard write failed", 300));
  }
  return { dry_run: false };
}

function captureScreenshot(outputPath: string, delayMs: number, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return {
      dry_run: true,
      output_path: outputPath,
      size_bytes: 0,
    };
  }
  if (process.platform !== "darwin") {
    throw new Error("desktop screenshots are currently supported on macOS only");
  }
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  const result = runCommand("screencapture", ["-x", "-t", "png", outputPath], {
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "screenshot capture failed", 300));
  }
  const stat = fs.statSync(outputPath);
  return {
    dry_run: false,
    output_path: outputPath,
    size_bytes: stat.size,
  };
}

function openApp(appName: string, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return { dry_run: true };
  }
  if (process.platform !== "darwin") {
    throw new Error("opening applications is currently supported on macOS only");
  }
  const result = runCommand("open", ["-a", appName], { timeoutMs });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "open app failed", 300));
  }
  return { dry_run: false };
}

function openUrl(url: string, appName: string | null, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return { dry_run: true };
  }
  if (process.platform !== "darwin") {
    throw new Error("opening URLs is currently supported on macOS only");
  }
  const args = appName ? ["-a", appName, url] : [url];
  const result = runCommand("open", args, { timeoutMs });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "open url failed", 300));
  }
  return { dry_run: false };
}

function modifierList(modifiers: string[] | undefined) {
  const ordered = [...new Set((modifiers ?? []).map((entry) => String(entry).trim()).filter(Boolean))];
  if (ordered.length <= 0) {
    return null;
  }
  return `{${ordered.map((entry) => `${entry} down`).join(", ")}}`;
}

const specialKeyCodeMap: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

function sendTextToFrontmostApp(text: string, targetApp: string | null, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return { dry_run: true };
  }
  if (process.platform !== "darwin") {
    throw new Error("text input is currently supported on macOS only");
  }
  const script = [
    "on run argv",
    'set typedText to item 1 of argv',
    'set targetApp to ""',
    'if (count of argv) > 1 then set targetApp to item 2 of argv',
    'if targetApp is not "" then tell application targetApp to activate',
    "delay 0.1",
    'tell application "System Events" to keystroke typedText',
    "end run",
  ];
  const args = script.flatMap((line) => ["-e", line]);
  args.push(text);
  if (targetApp) {
    args.push(targetApp);
  }
  const result = runCommand("osascript", args, { timeoutMs });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "text input failed", 300));
  }
  return { dry_run: false };
}

function pressKey(key: string, modifiers: string[] | undefined, targetApp: string | null, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return { dry_run: true };
  }
  if (process.platform !== "darwin") {
    throw new Error("key presses are currently supported on macOS only");
  }
  const lowerKey = key.trim().toLowerCase();
  const usingClause = modifierList(modifiers);
  const body =
    specialKeyCodeMap[lowerKey] !== undefined
      ? `key code ${specialKeyCodeMap[lowerKey]}${usingClause ? ` using ${usingClause}` : ""}`
      : `keystroke ${JSON.stringify(key)}${usingClause ? ` using ${usingClause}` : ""}`;
  const script = [
    'set targetApp to ""',
    ...(targetApp ? [`set targetApp to ${JSON.stringify(targetApp)}`, 'tell application targetApp to activate', "delay 0.1"] : []),
    'tell application "System Events"',
    body,
    "end tell",
  ];
  const result = runCommand(
    "osascript",
    script.flatMap((line) => ["-e", line]),
    { timeoutMs }
  );
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "key press failed", 300));
  }
  return { dry_run: false };
}

function recordMicrophoneClip(outputPath: string, durationSeconds: number, timeoutMs: number) {
  if (isDryRunEnabled()) {
    return {
      dry_run: true,
      output_path: outputPath,
      size_bytes: 0,
    };
  }
  if (process.platform !== "darwin") {
    throw new Error("microphone capture is currently supported on macOS only");
  }
  if (!fs.existsSync(desktopListenScriptPath)) {
    throw new Error("desktop listen helper is missing");
  }
  const result = runCommand("swift", [desktopListenScriptPath, outputPath, String(durationSeconds)], {
    timeoutMs: Math.max(timeoutMs, Math.ceil(durationSeconds * 1000) + 15_000),
  });
  if (!result.ok) {
    throw new Error(compactText(result.error || result.stderr || result.stdout || "microphone capture failed", 300));
  }
  const stat = fs.statSync(outputPath);
  return {
    dry_run: false,
    output_path: outputPath,
    size_bytes: stat.size,
  };
}

export function desktopControl(storage: Storage, input: z.infer<typeof desktopControlSchema>) {
  if (input.action === "status") {
    return buildStatusPayload(storage);
  }

  if (input.action === "heartbeat") {
    return runIdempotentMutation({
      storage,
      tool_name: "desktop.control",
      mutation: input.mutation!,
      payload: input,
      execute: () => {
        const current = storage.getDesktopControlState();
        const capabilityProbe = buildCapabilityProbe();
        let frontmost = { app_name: "", window_title: "" };
        let lastError: string | null = null;
        if (current.enabled && current.allow_observe && capabilityProbe.osascript) {
          try {
            frontmost = runFrontmostAppQuery(current.action_timeout_ms);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        const state = storage.setDesktopControlState({
          enabled: current.enabled,
          allow_observe: current.allow_observe,
          allow_act: current.allow_act,
          allow_listen: current.allow_listen,
          screenshot_dir: current.screenshot_dir,
          action_timeout_ms: current.action_timeout_ms,
          listen_max_seconds: current.listen_max_seconds,
          heartbeat_interval_seconds: current.heartbeat_interval_seconds,
          last_heartbeat_at: new Date().toISOString(),
          last_frontmost_app: frontmost.app_name || current.last_frontmost_app,
          last_frontmost_window: frontmost.window_title || current.last_frontmost_window,
          last_error: lastError,
          capability_probe: capabilityProbe,
        });
        if (lastError) {
          recordRuntimeEvent(storage, {
            event_type: "desktop.control.heartbeat_failed",
            status: "failed",
            summary: `desktop.control heartbeat failed: ${compactText(lastError, 180)}`,
            details: { last_error: lastError },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
        }
        return {
          ok: !lastError,
          state,
          summary: summarizeDesktopControlState(state),
          source: "desktop.control",
        };
      },
    });
  }

  return runIdempotentMutation({
    storage,
    tool_name: "desktop.control",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const state = storage.setDesktopControlState({
        enabled: input.enabled,
        allow_observe: input.allow_observe,
        allow_act: input.allow_act,
        allow_listen: input.allow_listen,
        screenshot_dir: input.screenshot_dir,
        action_timeout_ms: input.action_timeout_ms,
        listen_max_seconds: input.listen_max_seconds,
        heartbeat_interval_seconds: input.heartbeat_interval_seconds,
      });
      recordRuntimeEvent(storage, {
        event_type: "desktop.control.updated",
        status: "updated",
        summary: `desktop.control updated (enabled=${state.enabled}, observe=${state.allow_observe}, act=${state.allow_act}, listen=${state.allow_listen})`,
        details: {
          enabled: state.enabled,
          allow_observe: state.allow_observe,
          allow_act: state.allow_act,
          allow_listen: state.allow_listen,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        state,
        summary: summarizeDesktopControlState(state),
        source: "desktop.control",
      };
    },
  });
}

export function desktopObserve(storage: Storage, input: z.infer<typeof desktopObserveSchema>) {
  if (input.action === "status") {
    const state = storage.getDesktopControlState();
    return {
      state,
      summary: summarizeDesktopControlState(state),
      source: "desktop.observe",
    };
  }

  const state = requireDesktopEnabled(storage, "observe");
  if (input.action === "frontmost_app") {
    const frontmost = runFrontmostAppQuery(state.action_timeout_ms);
    const nextState = storage.setDesktopControlState({
      last_observation_at: new Date().toISOString(),
      last_frontmost_app: frontmost.app_name,
      last_frontmost_window: frontmost.window_title,
      last_error: null,
    });
    return {
      state: nextState,
      summary: summarizeDesktopControlState(nextState),
      observation: frontmost,
      source: "desktop.observe",
    };
  }

  if (input.action === "clipboard") {
    const clipboardText = readClipboardText(state.action_timeout_ms);
    const nextState = storage.setDesktopControlState({
      last_observation_at: new Date().toISOString(),
      last_error: null,
    });
    return {
      state: nextState,
      summary: summarizeDesktopControlState(nextState),
      observation: {
        text: clipboardText,
        length: clipboardText.length,
      },
      source: "desktop.observe",
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "desktop.observe",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const outputPath = buildOutputPath(state.screenshot_dir, "desktop-screenshot", input.format, input.filename);
      const screenshot = captureScreenshot(outputPath, input.delay_ms, state.action_timeout_ms);
      const frontmost = readFrontmostOverride() ?? { app_name: state.last_frontmost_app ?? "", window_title: state.last_frontmost_window ?? "" };
      const nextState = storage.setDesktopControlState({
        last_observation_at: new Date().toISOString(),
        last_screenshot_at: new Date().toISOString(),
        last_frontmost_app: frontmost.app_name || state.last_frontmost_app,
        last_frontmost_window: frontmost.window_title || state.last_frontmost_window,
        last_error: null,
      });
      recordRuntimeEvent(storage, {
        event_type: "desktop.observe.screenshot",
        status: "captured",
        summary: `desktop screenshot ${screenshot.dry_run ? "planned" : "captured"} -> ${outputPath}`,
        details: screenshot,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        state: nextState,
        summary: summarizeDesktopControlState(nextState),
        observation: {
          ...screenshot,
          format: input.format,
          frontmost_app: nextState.last_frontmost_app,
          frontmost_window: nextState.last_frontmost_window,
        },
        source: "desktop.observe",
      };
    },
  });
}

export function desktopContext(storage: Storage, input: z.infer<typeof desktopContextSchema>) {
  const generatedAt = new Date().toISOString();
  const state = storage.getDesktopControlState();
  const authoritySummary = summarizeDesktopControlState(state);
  const observationAllowed = state.enabled && state.allow_observe;
  const requestedHostId = input.host_id?.trim() || "local";

  if (!observationAllowed) {
    const identity = desktopContextIdentity(input, { captured_from_host_id: requestedHostId });
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: "desktop.context unavailable: desktop observation is disabled by policy",
            details: {
              ...identity,
              source: "none",
              unavailable_reason: "desktop_observation_disabled_by_policy",
              action: input.action,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: generatedAt,
      current_utc: generatedAt,
      freshness_seconds: null,
      displays: [],
      latest_frame_path: null,
      screenshot_path: null,
      ocr_hits: input.query ? [] : undefined,
      unavailable_reason: "desktop_observation_disabled_by_policy",
      stale_reason: null,
      authority_summary: authoritySummary,
      recommended_next_action: "Enable desktop.control with allow_observe before exposing screen context to MCP clients.",
      event_id: event?.event_id ?? null,
      ...identity,
    };
  }

  if (requestedHostId !== "local") {
    return desktopContextRemote(storage, input, {
      generatedAt,
      authoritySummary,
      timeoutMs: state.action_timeout_ms,
      screenshotDir: state.screenshot_dir,
    });
  }

  const identity = desktopContextIdentity(input, { captured_from_host_id: "local" });

  const shouldTryChronicle = input.prefer_source !== "desktop_observe";
  const shouldTryScreenshot = input.prefer_source === "desktop_observe" || input.fallback_screenshot;
  const chronicle = shouldTryChronicle
    ? listChronicleDisplays({
        max_freshness_seconds: input.max_freshness_seconds,
        display_id: input.display_id,
      })
    : null;

  if (chronicle && (chronicle.displays.length > 0 || input.prefer_source === "chronicle" || input.action === "status")) {
    const freshDisplays = chronicle.displays.filter((display) => !display.stale);
    const selectedDisplay = freshDisplays[0] ?? chronicle.displays[0] ?? null;
    const status = freshDisplays.length > 0 ? "available" : chronicle.displays.length > 0 ? "degraded" : "unavailable";
    const ocrHits = input.action === "search" || input.query ? chronicleOcrHits(chronicle.displays, input.query, input.ocr_max_hits) ?? [] : undefined;
    if (status === "available" || input.prefer_source === "chronicle" || input.action === "status") {
      const event =
        input.action === "status"
          ? null
          : recordRuntimeEvent(storage, {
              event_type: "desktop.context",
              status,
              summary:
                status === "available"
                  ? `desktop.context read ${freshDisplays.length} fresh Chronicle display frame(s)`
                  : `desktop.context Chronicle degraded: ${chronicle.stale_reason ?? chronicle.unavailable_reason ?? "unknown"}`,
              details: {
                ...identity,
                source: "chronicle",
                action: input.action,
                display_count: chronicle.displays.length,
                fresh_display_count: freshDisplays.length,
                latest_frame_path: selectedDisplay?.latest_frame_path ?? null,
                freshness_seconds: selectedDisplay?.freshness_seconds ?? null,
                recorder_pid_path: chronicle.recorder_pid_path,
                stale_reason: chronicle.stale_reason,
                unavailable_reason: chronicle.unavailable_reason,
                ocr_hit_count: ocrHits?.length ?? 0,
                ocr_is_noisy: Boolean(ocrHits),
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            });
      return {
        ok: status !== "unavailable",
        status,
        source: status === "unavailable" ? "none" : "chronicle",
        generated_at: generatedAt,
        current_utc: generatedAt,
        freshness_seconds: selectedDisplay?.freshness_seconds ?? null,
        displays: chronicle.displays,
        latest_frame_path: selectedDisplay?.latest_frame_path ?? null,
        screenshot_path: null,
        recorder_pid_path: chronicle.recorder_pid_path,
        recorder_pid_paths_checked: chronicle.recorder_pid_paths_checked,
        ocr_hits: ocrHits,
        ocr_note: ocrHits ? "OCR hits are noisy triage hints only; use app/file/connectors for authoritative extraction." : undefined,
        stale_reason: chronicle.stale_reason,
        unavailable_reason: chronicle.unavailable_reason,
        authority_summary: authoritySummary,
        recommended_next_action: chronicleNextAction({
          status,
          stale_reason: chronicle.stale_reason,
          unavailable_reason: chronicle.unavailable_reason,
        }),
        event_id: event?.event_id ?? null,
        ...identity,
      };
    }
  }

  if (!shouldTryScreenshot) {
    const reason = chronicle?.stale_reason ?? chronicle?.unavailable_reason ?? "desktop_context_source_unavailable";
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: `desktop.context unavailable: ${reason}`,
            details: {
              ...identity,
              source: "none",
              action: input.action,
              unavailable_reason: reason,
              recorder_pid_path: chronicle?.recorder_pid_path ?? null,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: generatedAt,
      current_utc: generatedAt,
      freshness_seconds: null,
      displays: chronicle?.displays ?? [],
      latest_frame_path: null,
      screenshot_path: null,
      recorder_pid_path: chronicle?.recorder_pid_path ?? null,
      recorder_pid_paths_checked: chronicle?.recorder_pid_paths_checked ?? [],
      ocr_hits: input.query ? [] : undefined,
      stale_reason: chronicle?.stale_reason ?? null,
      unavailable_reason: reason,
      authority_summary: authoritySummary,
      recommended_next_action: chronicleNextAction({
        status: "unavailable",
        stale_reason: chronicle?.stale_reason,
        unavailable_reason: chronicle?.unavailable_reason ?? reason,
      }),
      event_id: event?.event_id ?? null,
      ...identity,
    };
  }

  if (!input.mutation) {
    const reason = chronicle?.stale_reason ?? chronicle?.unavailable_reason ?? "desktop_context_screenshot_requires_mutation";
    const event =
      input.action === "status"
        ? null
        : recordRuntimeEvent(storage, {
            event_type: "desktop.context",
            status: "unavailable",
            summary: "desktop.context screenshot fallback requires an idempotent mutation",
            details: {
              ...identity,
              source: "none",
              action: input.action,
              unavailable_reason: reason,
              fallback_screenshot: true,
              recorder_pid_path: chronicle?.recorder_pid_path ?? null,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
    return {
      ok: false,
      status: "unavailable",
      source: "none",
      generated_at: generatedAt,
      current_utc: generatedAt,
      freshness_seconds: null,
      displays: chronicle?.displays ?? [],
      latest_frame_path: null,
      screenshot_path: null,
      recorder_pid_path: chronicle?.recorder_pid_path ?? null,
      recorder_pid_paths_checked: chronicle?.recorder_pid_paths_checked ?? [],
      ocr_hits: input.query ? [] : undefined,
      stale_reason: chronicle?.stale_reason ?? null,
      unavailable_reason: "desktop_context_screenshot_requires_mutation",
      authority_summary: authoritySummary,
      recommended_next_action: "Retry with a mutation so MASTER-MOLD can capture and log a fresh screenshot fallback.",
      event_id: event?.event_id ?? null,
      ...identity,
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "desktop.context",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const capturedAt = new Date().toISOString();
      const outputPath = buildOutputPath(state.screenshot_dir, "desktop-context", "png", input.filename);
      const screenshot = captureScreenshot(outputPath, input.delay_ms, state.action_timeout_ms);
      const frontmost = readFrontmostOverride() ?? { app_name: state.last_frontmost_app ?? "", window_title: state.last_frontmost_window ?? "" };
      const nextState = storage.setDesktopControlState({
        last_observation_at: capturedAt,
        last_screenshot_at: screenshot.dry_run ? state.last_screenshot_at : capturedAt,
        last_frontmost_app: frontmost.app_name || state.last_frontmost_app,
        last_frontmost_window: frontmost.window_title || state.last_frontmost_window,
        last_error: null,
      });
      const nextAuthoritySummary = summarizeDesktopControlState(nextState);
      const status = input.prefer_source === "desktop_observe" && !screenshot.dry_run ? "available" : "degraded";
      const event = recordRuntimeEvent(storage, {
        event_type: "desktop.context",
        status,
        summary: `desktop.context ${screenshot.dry_run ? "planned" : "captured"} screenshot fallback -> ${outputPath}`,
        details: {
          ...identity,
          source: "desktop_observe",
          action: input.action,
          screenshot_path: outputPath,
          dry_run: screenshot.dry_run,
          size_bytes: screenshot.size_bytes,
          recorder_pid_path: chronicle?.recorder_pid_path ?? null,
          fallback_from: chronicle?.stale_reason ?? chronicle?.unavailable_reason ?? null,
          screen_recording_proven: !screenshot.dry_run,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        status,
        source: "desktop_observe",
        generated_at: capturedAt,
        current_utc: capturedAt,
        freshness_seconds: 0,
        displays: chronicle?.displays ?? [],
        latest_frame_path: null,
        screenshot_path: outputPath,
        recorder_pid_path: chronicle?.recorder_pid_path ?? null,
        recorder_pid_paths_checked: chronicle?.recorder_pid_paths_checked ?? [],
        screenshot: {
          ...screenshot,
          format: "png",
          captured: !screenshot.dry_run,
          frontmost_app: nextState.last_frontmost_app,
          frontmost_window: nextState.last_frontmost_window,
        },
        ocr_hits: input.query ? [] : undefined,
        stale_reason: chronicle?.stale_reason ?? null,
        unavailable_reason: chronicle?.unavailable_reason ?? null,
        authority_summary: nextAuthoritySummary,
        recommended_next_action: "Use the screenshot as current visual context, then switch to app, file, or connector data for authoritative work.",
        event_id: event.event_id,
        ...identity,
      };
    },
  });
}

export function desktopAct(storage: Storage, input: z.infer<typeof desktopActSchema>) {
  const state = requireDesktopEnabled(storage, "act");
  return runIdempotentMutation({
    storage,
    tool_name: "desktop.act",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      let dryRun = false;
      if (input.action === "open_app") {
        dryRun = openApp(input.app!, state.action_timeout_ms).dry_run;
      } else if (input.action === "open_url") {
        dryRun = openUrl(input.url!, readString(input.app) ?? readString(input.target_app), state.action_timeout_ms).dry_run;
      } else if (input.action === "set_clipboard") {
        dryRun = writeClipboardText(input.text!, state.action_timeout_ms).dry_run;
      } else if (input.action === "type_text") {
        dryRun = sendTextToFrontmostApp(input.text!, readString(input.target_app), state.action_timeout_ms).dry_run;
      } else if (input.action === "key_press") {
        dryRun = pressKey(input.key!, input.modifiers, readString(input.target_app), state.action_timeout_ms).dry_run;
      }

      const nextState = storage.setDesktopControlState({
        last_action_at: new Date().toISOString(),
        last_error: null,
      });
      recordRuntimeEvent(storage, {
        event_type: "desktop.act",
        status: "executed",
        summary: `desktop.act ${input.action}${dryRun ? " (dry-run)" : ""}`,
        details: {
          action: input.action,
          app: input.app ?? null,
          url: input.url ?? null,
          key: input.key ?? null,
          modifiers: input.modifiers ?? [],
          target_app: input.target_app ?? null,
          dry_run: dryRun,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        state: nextState,
        summary: summarizeDesktopControlState(nextState),
        result: {
          action: input.action,
          dry_run: dryRun,
        },
        source: "desktop.act",
      };
    },
  });
}

export function desktopListen(storage: Storage, input: z.infer<typeof desktopListenSchema>) {
  if (input.action === "status") {
    const state = storage.getDesktopControlState();
    return {
      state,
      summary: summarizeDesktopControlState(state),
      source: "desktop.listen",
    };
  }

  const state = requireDesktopEnabled(storage, "listen");
  return runIdempotentMutation({
    storage,
    tool_name: "desktop.listen",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const durationSeconds = Math.max(1, Math.min(state.listen_max_seconds, Math.round(input.duration_seconds ?? state.listen_max_seconds)));
      const outputPath = buildOutputPath(state.screenshot_dir, "desktop-audio", input.format, input.filename);
      const recording = recordMicrophoneClip(outputPath, durationSeconds, state.action_timeout_ms);
      const nextState = storage.setDesktopControlState({
        last_listen_at: new Date().toISOString(),
        last_error: null,
      });
      recordRuntimeEvent(storage, {
        event_type: "desktop.listen",
        status: "recorded",
        summary: `desktop.listen ${recording.dry_run ? "planned" : "recorded"} ${durationSeconds}s -> ${outputPath}`,
        details: {
          duration_seconds: durationSeconds,
          format: input.format,
          ...recording,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        state: nextState,
        summary: summarizeDesktopControlState(nextState),
        recording: {
          duration_seconds: durationSeconds,
          format: input.format,
          ...recording,
        },
        source: "desktop.listen",
      };
    },
  });
}
