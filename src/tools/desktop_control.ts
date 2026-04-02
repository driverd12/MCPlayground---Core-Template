import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type DesktopControlCapabilityProbeRecord, summarizeDesktopControlState } from "../desktop_control_plane.js";
import { Storage } from "../storage.js";
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
) {
  storage.appendRuntimeEvent({
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
