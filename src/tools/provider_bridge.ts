import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { probeLiteLlmProxyHealth, resolveLiteLlmProxyEndpoint } from "../litellm_proxy_probe.js";
import { Storage } from "../storage.js";
import { getTriChatAgent, getTriChatBridgeCandidates } from "../trichat_roster.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { resolveLocalBridgeResourceGate, type LocalBridgeResourceGate } from "./worker_fabric.js";

const providerBridgeClientSchema = z.enum([
  "codex",
  "claude-cli",
  "cursor",
  "github-copilot-cli",
  "github-copilot-vscode",
  "gemini-cli",
  "chatgpt-developer-mode",
]);
const transportSchema = z.enum(["auto", "http", "stdio"]);
const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const providerBridgeSchema = z
  .object({
    action: z.enum(["status", "diagnose", "export_bundle", "install"]).default("status"),
    mutation: mutationSchema.optional(),
    clients: z.array(providerBridgeClientSchema).max(20).optional(),
    transport: transportSchema.default("auto"),
    server_name: z.string().min(1).max(120).default("master-mold"),
    output_dir: z.string().min(1).optional(),
    include_bearer_token: z.boolean().default(false),
    http_url: z.string().min(1).optional(),
    http_origin: z.string().min(1).optional(),
    stdio_command: z.string().min(1).optional(),
    stdio_args: z.array(z.string().min(1)).optional(),
    db_path: z.string().min(1).optional(),
    workspace_root: z.string().min(1).optional(),
    probe_timeout_ms: z.number().int().min(250).max(30000).optional(),
    force_live: z.boolean().default(false),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if ((value.action === "export_bundle" || value.action === "install") && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for export_bundle and install",
        path: ["mutation"],
      });
    }
  });

type ProviderBridgeClientId = z.infer<typeof providerBridgeClientSchema>;

type ProviderBridgeClientStatus = {
  client_id: ProviderBridgeClientId;
  display_name: string;
  office_agent_id: string | null;
  install_mode: "cli" | "json-config" | "export-only" | "remote-only";
  config_path: string | null;
  installed: boolean;
  binary_present: boolean;
  config_present: boolean;
  supported_transports: Array<"http" | "stdio">;
  preferred_transport: "http" | "stdio";
  inbound_mcp_supported: boolean;
  outbound_council_supported: boolean;
  outbound_agent_id: string | null;
  outbound_bridge_ready: boolean;
  resource_gate_blocked: boolean;
  resource_gate_reason: string | null;
  requires_internet_for_model: boolean;
  notes: string[];
};

type ProviderBridgeRouterBackendCandidate = {
  client_id: ProviderBridgeClientId;
  eligible: boolean;
  reason: string | null;
  backend: {
    backend_id: string;
    provider: "openai" | "google" | "anthropic" | "cursor" | "github-copilot" | "custom";
    model_id: string;
    endpoint: string | null;
    host_id: string | null;
    locality: "remote";
    tags: string[];
    capabilities: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
};

type ProviderBridgeTransportConfig = {
  mode: "http" | "stdio";
  url: string;
  origin: string;
  bearer_token: string;
  command: string;
  args: string[];
  db_path: string;
};

type ProviderBridgeDiagnostic = {
  client_id: ProviderBridgeClientId;
  display_name: string;
  office_agent_id: string | null;
  available: boolean;
  runtime_probed: boolean;
  connected: boolean | null;
  status: "connected" | "disconnected" | "configured" | "unavailable";
  detail: string;
  notes: string[];
  command: string | null;
  config_path: string | null;
  last_probe_at?: string;
  intermittent?: boolean;
  metadata?: Record<string, unknown>;
};

function resolveClientTransportConfig(
  clientId: ProviderBridgeClientId,
  base: ProviderBridgeTransportConfig,
  requestedMode: "auto" | "http" | "stdio"
): ProviderBridgeTransportConfig {
  if (requestedMode !== "auto") {
    return base;
  }
  if (clientId === "gemini-cli" || clientId === "claude-cli") {
    return {
      ...base,
      mode: "stdio",
    };
  }
  return base;
}

type ProviderBridgeSnapshot = {
  canonical_ingress_tool: "autonomy.ide_ingress";
  local_first_ide_agent_ids: string[];
  workspace_root: string;
  server_name: string;
  transport: "http" | "stdio";
  resource_gate: LocalBridgeResourceGate;
  outbound_council_agents: Array<{
    client_id: ProviderBridgeClientId;
    agent_id: string | null;
    bridge_ready: boolean;
    runtime_ready: boolean;
  }>;
  router_backend_candidates: ProviderBridgeRouterBackendCandidate[];
  eligible_router_backends: ProviderBridgeRouterBackendCandidate["backend"][];
  clients: ProviderBridgeClientStatus[];
};

type ProviderBridgeOnboardingEntry = {
  client_id: ProviderBridgeClientId;
  display_name: string;
  office_agent_id: string | null;
  install_mode: ProviderBridgeClientStatus["install_mode"];
  config_path: string | null;
  runtime_status:
    | "connected"
    | "configured"
    | "disconnected"
    | "unavailable"
    | "diagnose_required"
    | "runtime_check_stale"
    | "export_only"
    | "remote_only";
  ready: boolean;
  bridge_ready: boolean;
  runtime_ready: boolean;
  next_action: string;
  next_command: string | null;
  install_command: string | null;
  diagnose_command: string | null;
  export_command: string | null;
  verify_command: string | null;
  repair_command: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  blockers: string[];
};

type ProviderBridgeOnboardingSummary = {
  generated_at: string;
  ready_count: number;
  action_required_count: number;
  installable_count: number;
  needs_binary_count: number;
  needs_install_count: number;
  needs_runtime_verification_count: number;
  export_only_count: number;
  remote_only_count: number;
  stale_runtime_checks: boolean;
  recommended_status_command: string;
  recommended_doctor_command: string;
  recommended_install_command: string;
  recommended_diagnose_command: string;
  recommended_export_command: string;
  recommended_ingress_command: string;
  entries: ProviderBridgeOnboardingEntry[];
};

type CachedProviderBridgeDiagnostics = {
  generated_at: string;
  cached: boolean;
  stale: boolean;
  diagnostics: ProviderBridgeDiagnostic[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distServerPath = path.join(repoRoot, "dist", "server.js");
const providerStdioBridgePath = path.join(repoRoot, "scripts", "provider_stdio_bridge.mjs");
const defaultLocalFirstAgents = [
  "implementation-director",
  "research-director",
  "verification-director",
  "local-imprint",
];
const defaultProviderClients: ProviderBridgeClientId[] = [
  "codex",
  "claude-cli",
  "cursor",
  "github-copilot-cli",
  "github-copilot-vscode",
  "gemini-cli",
  "chatgpt-developer-mode",
];
const legacyProviderServerNames = ["mcplayground"];
const providerBridgeDiagnosticCache = new Map<
  string,
  {
    captured_at: number;
    diagnostics: ProviderBridgeDiagnostic[];
  }
>();

const providerBridgeStatusCache = new Map<
  string,
  {
    captured_at: number;
    statuses: ProviderBridgeClientStatus[];
  }
>();

function isHttpServing() {
  return process.env.MCP_HTTP === "1";
}

function providerBridgeStatusCacheTtlMs() {
  const override = Number(process.env.PROVIDER_BRIDGE_STATUS_CACHE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(5_000, Math.round(override * 1000));
  }
  return 30_000;
}

function providerBridgeDiagnosticsCacheTtlMs() {
  const override = Number(process.env.PROVIDER_BRIDGE_DIAGNOSTICS_CACHE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(5_000, Math.round(override * 1000));
  }
  return 60_000;
}

function providerBridgeDiagnosticsCacheKey(input: {
  workspace_root?: string;
  transport?: "auto" | "http" | "stdio";
  http_url?: string;
  http_origin?: string;
  stdio_command?: string;
  stdio_args?: string[];
  db_path?: string;
  server_name?: string;
  probe_timeout_ms?: number;
}) {
  const workspaceRoot = input.workspace_root?.trim() || repoRoot;
  const transport = resolveTransportConfig({
    transport: input.transport ?? "auto",
    http_url: input.http_url,
    http_origin: input.http_origin,
    stdio_command: input.stdio_command,
    stdio_args: input.stdio_args,
    db_path: input.db_path,
    workspace_root: workspaceRoot,
  });
  const serverName = input.server_name?.trim() || "master-mold";
  return {
    workspaceRoot,
    transport,
    serverName,
    cacheKey: JSON.stringify({
      workspaceRoot,
      serverName,
      transport: transport.mode,
      command: transport.command,
      args: transport.args,
      url: transport.url,
      probeTimeoutMs: input.probe_timeout_ms ?? 5000,
    }),
  };
}

export function resolveProviderBridgeDiagnosticsCached(
  input: {
    workspace_root?: string;
    transport?: "auto" | "http" | "stdio";
    http_url?: string;
    http_origin?: string;
    stdio_command?: string;
    stdio_args?: string[];
    db_path?: string;
    server_name?: string;
    probe_timeout_ms?: number;
  } = {}
): CachedProviderBridgeDiagnostics {
  const { cacheKey } = providerBridgeDiagnosticsCacheKey(input);
  const cached = providerBridgeDiagnosticCache.get(cacheKey);
  const ttlMs = providerBridgeDiagnosticsCacheTtlMs();
  if (!cached) {
    return {
      generated_at: new Date().toISOString(),
      cached: false,
      stale: false,
      diagnostics: [],
    };
  }
  return {
    generated_at: new Date(cached.captured_at).toISOString(),
    cached: true,
    stale: Date.now() - cached.captured_at > ttlMs,
    diagnostics: cached.diagnostics,
  };
}

function normalizePersistedProviderBridgeDiagnostic(value: unknown): ProviderBridgeDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const clientId = String(entry.client_id ?? "").trim();
  if (!defaultProviderClients.includes(clientId as ProviderBridgeClientId)) {
    return null;
  }
  const status = String(entry.status ?? "").trim();
  if (!["connected", "disconnected", "configured", "unavailable"].includes(status)) {
    return null;
  }
  return {
    client_id: clientId as ProviderBridgeClientId,
    display_name: String(entry.display_name ?? clientId).trim() || clientId,
    office_agent_id: typeof entry.office_agent_id === "string" && entry.office_agent_id.trim() ? entry.office_agent_id.trim() : null,
    available: entry.available === true,
    runtime_probed: entry.runtime_probed === true,
    connected: typeof entry.connected === "boolean" ? entry.connected : null,
    status: status as ProviderBridgeDiagnostic["status"],
    detail: String(entry.detail ?? "").trim(),
    notes: Array.isArray(entry.notes) ? entry.notes.map((note) => String(note ?? "").trim()).filter(Boolean) : [],
    command: typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : null,
    config_path: typeof entry.config_path === "string" && entry.config_path.trim() ? entry.config_path.trim() : null,
    metadata:
      entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
        ? (entry.metadata as Record<string, unknown>)
        : undefined,
  };
}

function resolvePersistedProviderBridgeDiagnostics(storage: Storage | null | undefined): CachedProviderBridgeDiagnostics | null {
  if (!storage) {
    return null;
  }
  try {
    const state = storage.getAutonomyMaintainState();
    const diagnostics = Array.isArray(state?.provider_bridge_diagnostics)
      ? state.provider_bridge_diagnostics
          .map((entry) => normalizePersistedProviderBridgeDiagnostic(entry))
          .filter((entry): entry is ProviderBridgeDiagnostic => entry !== null)
      : [];
    if (diagnostics.length === 0) {
      return null;
    }
    const generatedAt = state?.last_provider_bridge_check_at || state?.updated_at || new Date().toISOString();
    const generatedAtMs = Date.parse(generatedAt);
    return {
      generated_at: generatedAt,
      cached: true,
      stale: !Number.isFinite(generatedAtMs) || Date.now() - generatedAtMs > providerBridgeDiagnosticsCacheTtlMs(),
      diagnostics,
    };
  } catch {
    return null;
  }
}

function preferProviderBridgeDiagnostics(
  current: CachedProviderBridgeDiagnostics,
  persisted: CachedProviderBridgeDiagnostics | null
): CachedProviderBridgeDiagnostics {
  if (!persisted) {
    return current;
  }
  if (current.diagnostics.length === 0) {
    return persisted;
  }
  if (current.stale && !persisted.stale) {
    return persisted;
  }
  return current;
}

function resolveDiagnosticsRuntimeReady(
  candidate: { client_id: ProviderBridgeClientId },
  diagnosticsByClient: Map<ProviderBridgeClientId, ProviderBridgeDiagnostic>,
  diagnosticsStale: boolean
) {
  if (diagnosticsStale) {
    return false;
  }
  const diagnostic = diagnosticsByClient.get(candidate.client_id);
  return diagnostic?.status === "connected";
}

function resolveDiagnosticsRuntimeReason(
  candidate: ProviderBridgeRouterBackendCandidate,
  diagnosticsByClient: Map<ProviderBridgeClientId, ProviderBridgeDiagnostic>,
  diagnosticsStale: boolean
) {
  if (!candidate.eligible) {
    return candidate.reason;
  }
  if (diagnosticsStale) {
    return "runtime verification is stale";
  }
  const diagnostic = diagnosticsByClient.get(candidate.client_id);
  if (!diagnostic) {
    return "runtime verification missing";
  }
  if (diagnostic.status === "connected") {
    return null;
  }
  if (diagnostic.status === "configured") {
    return diagnostic.detail || "runtime connectivity is not confirmed";
  }
  if (diagnostic.status === "disconnected" || diagnostic.status === "unavailable") {
    return diagnostic.detail || "client runtime is unavailable";
  }
  return "runtime verification missing";
}

export function applyProviderBridgeDiagnosticsToSnapshot(
  snapshot: ProviderBridgeSnapshot,
  diagnosticsState: CachedProviderBridgeDiagnostics
): ProviderBridgeSnapshot {
  const diagnosticsByClient = new Map(
    diagnosticsState.diagnostics.map((entry) => [entry.client_id, entry] as const)
  );
  const outboundCouncilAgents = snapshot.outbound_council_agents.map((entry) => ({
    ...entry,
    runtime_ready: resolveDiagnosticsRuntimeReady(entry, diagnosticsByClient, diagnosticsState.stale === true),
  }));
  const routerBackendCandidates = snapshot.router_backend_candidates.map((entry) => {
    const runtimeReady = resolveDiagnosticsRuntimeReady(entry, diagnosticsByClient, diagnosticsState.stale === true);
    const reason = resolveDiagnosticsRuntimeReason(entry, diagnosticsByClient, diagnosticsState.stale === true);
    const diagnostic = diagnosticsByClient.get(entry.client_id);
    const diagnosticMetadata =
      diagnostic?.metadata && typeof diagnostic.metadata === "object" && !Array.isArray(diagnostic.metadata)
        ? (diagnostic.metadata as Record<string, unknown>)
        : null;
    return {
      ...entry,
      eligible: entry.eligible && runtimeReady,
      reason,
      backend: {
        ...entry.backend,
        metadata: {
          ...entry.backend.metadata,
          ...(diagnosticMetadata ? diagnosticMetadata : {}),
          runtime_ready: runtimeReady,
          runtime_ready_source:
            diagnosticsState.diagnostics.length > 0
              ? diagnosticsState.cached
                ? "provider_bridge_diagnostics_cache"
                : "provider_bridge_diagnostics_live"
              : "provider_bridge_diagnostics_missing",
          runtime_ready_stale: diagnosticsState.stale === true,
        },
      },
    };
  });
  return {
    ...snapshot,
    outbound_council_agents: outboundCouncilAgents,
    router_backend_candidates: routerBackendCandidates,
    eligible_router_backends: routerBackendCandidates.filter((entry) => entry.eligible).map((entry) => entry.backend),
  };
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function allowSyncCliProbe() {
  return !isHttpServing() || process.env.MCP_HTTP_ALLOW_SYNC_CLI_PROBES === "1";
}

function commandExistsOnPath(command: string) {
  const hasPathSeparator = command.includes("/") || (process.platform === "win32" && /[\\/]/.test(command));
  const candidates = hasPathSeparator
    ? [command]
    : String(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((dir) => {
          if (process.platform !== "win32") {
            return [path.join(dir, command)];
          }
          const extensions = String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .map((entry) => entry.trim())
            .filter(Boolean);
          return extensions.map((extension) => path.join(dir, `${command}${extension}`));
        });
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function commandExists(command: string) {
  if (!allowSyncCliProbe()) {
    return commandExistsOnPath(command);
  }
  const result = spawnSync("which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function commandSucceeds(command: string, args: string[]) {
  if (!allowSyncCliProbe()) {
    return false;
  }
  const result = spawnSync(command, args, {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function runCommandProbe(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 5000,
    killSignal: "SIGKILL",
  });
  return {
    status: result.status,
    signal: result.signal,
    timed_out:
      result.error?.name === "Error" &&
      (() => {
        const message = String(result.error?.message ?? "");
        return message.toLowerCase().includes("timed out") || message.toUpperCase().includes("ETIMEDOUT");
      })(),
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    combined: [String(result.stdout ?? ""), String(result.stderr ?? "")].filter(Boolean).join("\n"),
  };
}

function buildProviderProbeEnv(workspaceRoot: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = env.HOME?.trim() || os.homedir();
  const shell = env.SHELL?.trim() || "/bin/zsh";
  const fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const preferredPathEntries = ["/opt/homebrew/bin", "/usr/local/bin"];
  const existingSegments = String(env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const prioritizedSegments = existingSegments.filter(
    (entry) => !preferredPathEntries.includes(entry)
  );
  for (let index = preferredPathEntries.length - 1; index >= 0; index -= 1) {
    const preferred = preferredPathEntries[index];
    const existingIndex = prioritizedSegments.indexOf(preferred);
    if (existingIndex >= 0) {
      prioritizedSegments.splice(existingIndex, 1);
    }
    const systemIndex = prioritizedSegments.findIndex((entry) =>
      ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].includes(entry)
    );
    if (systemIndex >= 0) {
      prioritizedSegments.splice(systemIndex, 0, preferred);
    } else {
      prioritizedSegments.push(preferred);
    }
  }
  const normalizedPath = prioritizedSegments.length > 0 ? prioritizedSegments.join(path.delimiter) : fallbackPath;
  env.HOME = home;
  env.SHELL = shell;
  env.TERM = env.TERM?.trim() || "xterm-256color";
  env.PWD = workspaceRoot;
  env.PATH = normalizedPath;
  return env;
}

function resolveEntryDbPath(config: ProviderBridgeTransportConfig, cwd?: string) {
  if (path.isAbsolute(config.db_path)) {
    return config.db_path;
  }
  if (cwd) {
    return path.resolve(cwd, config.db_path);
  }
  return path.resolve(repoRoot, config.db_path);
}

function listProcessLines(pattern: string) {
  const result = spawnSync("pgrep", ["-fal", pattern], {
    encoding: "utf8",
    env: process.env,
    timeout: 500,
  });
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isCodexRuntimeObserved() {
  return listProcessLines("Codex").some((line) => line.includes("/Applications/Codex.app"));
}

function isCursorRuntimeObserved(workspaceRoot: string) {
  const lines = listProcessLines("Cursor");
  if (!lines.some((line) => line.includes("/Applications/Cursor.app"))) {
    return false;
  }
  const workspaceLabel = path.basename(workspaceRoot).trim();
  if (!workspaceLabel) {
    return true;
  }
  return lines.some(
    (line) =>
      line.includes(`CURSOR_WORKSPACE_LABEL=${workspaceLabel}`) ||
      line.includes(`Agentic Playground`) ||
      line.includes(workspaceLabel)
  );
}

function isGeminiRuntimeObserved(workspaceRoot: string) {
  const workspaceLabel = path.basename(workspaceRoot).trim();
  const lines = [...listProcessLines("gemini_bridge.py"), ...listProcessLines("gemini")];
  return lines.some((line) => {
    if (!line.includes("gemini")) {
      return false;
    }
    if (line.includes("gemini_bridge.py") || line.includes("/.gemini/")) {
      return true;
    }
    if (!workspaceLabel) {
      return /\bgemini(\s|$)/i.test(line);
    }
    return line.includes(workspaceLabel) || line.includes("Agentic Playground");
  });
}

function hasCopilotCliBinary() {
  return (
    commandExists("copilot") ||
    (commandExists("gh") && commandSucceeds("gh", ["copilot", "--help"]))
  );
}

function readJsonFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function readEnvString(name: string) {
  const value = String(process.env[name] ?? "").trim();
  return value.length > 0 ? value : null;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveGeminiAdcCredentialsPath() {
  return (
    readEnvString("GOOGLE_APPLICATION_CREDENTIALS") ??
    path.join(resolveProviderHome(), ".config", "gcloud", "application_default_credentials.json")
  );
}

function readGeminiAdcState() {
  const credentialsPath = resolveGeminiAdcCredentialsPath();
  const adcPresent = fs.existsSync(credentialsPath);
  return {
    auth_mode: "vertex-ai-adc",
    adc_present: adcPresent,
    credentials_path_configured: Boolean(readEnvString("GOOGLE_APPLICATION_CREDENTIALS")),
    google_cloud_project_present: Boolean(readEnvString("GOOGLE_CLOUD_PROJECT")),
    quota_project_present: Boolean(readEnvString("GOOGLE_CLOUD_QUOTA_PROJECT")),
  };
}

function resolveGeminiProxyEndpoint() {
  return resolveLiteLlmProxyEndpoint();
}

function parseLiteLlmHealthBody(body: string) {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      readiness_status: typeof parsed.status === "string" ? parsed.status : null,
      healthy_count: Array.isArray(parsed.healthy_endpoints) ? parsed.healthy_endpoints.length : null,
      unhealthy_count: Array.isArray(parsed.unhealthy_endpoints) ? parsed.unhealthy_endpoints.length : null,
    };
  } catch {
    return {
      readiness_status: null,
      healthy_count: null,
      unhealthy_count: null,
    };
  }
}

function geminiLiteLlmEndpointAuditTimeoutMs() {
  const override = Number(process.env.TRICHAT_GEMINI_PROXY_ENDPOINT_AUDIT_TIMEOUT_MS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(250, Math.min(override, 15000));
  }
  return 750;
}

function runLiteLlmHealthCurl(endpoint: string, pathSuffix: string, timeoutMs: number) {
  const boundedTimeoutMs = Math.max(250, Math.min(timeoutMs, 15000));
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

function probeGeminiLiteLlmProxy(timeoutMs: number) {
  // Provider status is an operator overview path; keep it lightweight and let
  // health.litellm_proxy perform the deeper endpoint inventory probe.
  const readinessTimeoutMs = Math.max(250, Math.min(timeoutMs, 500));
  return probeLiteLlmProxyHealth({
    timeout_ms: readinessTimeoutMs,
    endpoint_audit_timeout_ms: Math.max(250, Math.min(readinessTimeoutMs, geminiLiteLlmEndpointAuditTimeoutMs(), 250)),
  });
}

function resolveLocalFirstAgents() {
  const envAgents = String(process.env.TRICHAT_IDE_LOCAL_FIRST_AGENT_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return envAgents.length > 0 ? [...new Set(envAgents)] : defaultLocalFirstAgents.slice();
}

function hasGeminiApiAccess() {
  return Boolean(
    readEnvString("GEMINI_API_KEY") ||
    readEnvString("GOOGLE_API_KEY") ||
    readEnvString("GOOGLE_CLOUD_PROJECT") ||
    readEnvString("GOOGLE_APPLICATION_CREDENTIALS") ||
    readGeminiAdcState().adc_present
  );
}

function resolveTransportConfig(
  input: Pick<
    z.infer<typeof providerBridgeSchema>,
    "transport" | "http_url" | "http_origin" | "stdio_command" | "stdio_args" | "db_path" | "workspace_root"
  >
): ProviderBridgeTransportConfig {
  const url = input.http_url?.trim() || process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/";
  const origin = input.http_origin?.trim() || process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1";
  const tokenFile = path.join(repoRoot, "data", "imprint", "http_bearer_token");
  const bearerToken =
    String(process.env.MCP_HTTP_BEARER_TOKEN ?? "").trim() ||
    (fs.existsSync(tokenFile) ? String(fs.readFileSync(tokenFile, "utf8") ?? "").trim() : "");
  const command = input.stdio_command?.trim() || process.execPath;
  const args = input.stdio_args?.length ? input.stdio_args : [distServerPath];
  const dbPath =
    input.db_path?.trim() ||
    String(process.env.ANAMNESIS_HUB_DB_PATH ?? "").trim() ||
    path.join(repoRoot, "data", "hub.sqlite");
  const mode =
    input.transport === "http" ? "http" : input.transport === "stdio" ? "stdio" : bearerToken.length > 0 ? "http" : "stdio";
  return {
    mode,
    url,
    origin,
    bearer_token: bearerToken,
    command,
    args,
    db_path: dbPath,
  };
}

function providerStatusCommand() {
  return "npm run providers:status";
}

function providerDoctorCommand() {
  return "npm run bootstrap:env:check";
}

function providerDiagnoseCommand(clientId: ProviderBridgeClientId) {
  return `npm run providers:diagnose -- ${clientId}`;
}

function providerInstallCommand(clientId: ProviderBridgeClientId, serverName: string) {
  if (clientId === "codex") {
    return `./scripts/codex_mcp_register.sh ${serverName}`;
  }
  if (
    clientId === "claude-cli" ||
    clientId === "cursor" ||
    clientId === "gemini-cli" ||
    clientId === "github-copilot-cli" ||
    clientId === "github-copilot-vscode"
  ) {
    return `npm run providers:install -- ${clientId}`;
  }
  return null;
}

function providerExportCommand() {
  return "npm run providers:export";
}

export function buildProviderBridgeOnboardingSummary(params: {
  clients: ProviderBridgeClientStatus[];
  diagnostics?: ProviderBridgeDiagnostic[];
  server_name?: string;
  generated_at?: string;
  diagnostics_stale?: boolean;
}): ProviderBridgeOnboardingSummary {
  const serverName = params.server_name?.trim() || "master-mold";
  const diagnosticsByClient = new Map(
    (params.diagnostics ?? []).map((entry) => [entry.client_id, entry] as const)
  );
  const diagnosticsStale = params.diagnostics_stale === true;
  const entries = params.clients.map((status) => {
    const diagnostic = diagnosticsByClient.get(status.client_id);
    const installCommand = providerInstallCommand(status.client_id, serverName);
    const verifyCommand = providerDiagnoseCommand(status.client_id);
    const diagnoseCommand =
      status.install_mode === "remote-only" || status.install_mode === "export-only"
        ? null
        : verifyCommand;
    const exportCommand =
      status.install_mode === "export-only" || status.install_mode === "remote-only"
        ? providerExportCommand()
        : null;
    const blockers: string[] = [];
    let runtimeStatus: ProviderBridgeOnboardingEntry["runtime_status"];
    let nextAction = "";
    let nextCommand: string | null = null;
    let failureKind: string | null = null;
    let failureDetail: string | null = null;
    let ready = false;

    if (status.install_mode === "remote-only") {
      runtimeStatus = "remote_only";
      blockers.push("remote_endpoint_required");
      failureKind = "remote_endpoint_required";
      failureDetail = `${status.display_name} requires a reachable remote MCP endpoint; this repo cannot install it as a purely local client config.`;
      nextAction = "Export the remote manifest and expose an intentional remote MCP endpoint instead of pretending this is a local install.";
      nextCommand = exportCommand;
    } else if (status.install_mode === "export-only") {
      runtimeStatus = "export_only";
      blockers.push("editor_merge_required");
      failureKind = "editor_merge_required";
      failureDetail = `${status.display_name} requires an editor/workspace merge step; export the snippet and add it to the target config.`;
      nextAction = "Export the editor-facing MCP snippet and merge it into the target workspace/editor config.";
      nextCommand = exportCommand;
    } else if (!status.binary_present) {
      runtimeStatus = "unavailable";
      blockers.push("client_binary_missing");
      failureKind = "client_binary_missing";
      failureDetail = `${status.display_name} binary is not on PATH or in the supported app location for this host.`;
      nextAction = "Install the client app or CLI on this host first, then write the MCP bridge config.";
      nextCommand = installCommand;
    } else if (!status.installed) {
      runtimeStatus = "unavailable";
      blockers.push("bridge_config_missing");
      failureKind = "bridge_config_missing";
      failureDetail = status.config_path
        ? `MASTER-MOLD is not present in ${status.config_path}.`
        : "No local config path is available for this client.";
      nextAction = "Write the MCP bridge config from the one supported install path, then verify it.";
      nextCommand = installCommand;
    } else if (diagnostic && diagnosticsStale) {
      runtimeStatus = "runtime_check_stale";
      blockers.push("runtime_check_stale");
      failureKind = "runtime_check_stale";
      failureDetail = `Last bridge diagnostic sample is stale; rerun diagnostics for ${status.client_id}.`;
      nextAction = "Runtime bridge evidence is stale. Re-run bridge diagnostics before treating this client as live.";
      nextCommand = diagnoseCommand;
    } else if (diagnostic?.status === "connected") {
      runtimeStatus = "connected";
      ready = true;
      nextAction = "No action needed. The bridge is configured and the client accepted a runtime check.";
      nextCommand = null;
    } else if (diagnostic?.status === "configured") {
      runtimeStatus = "configured";
      blockers.push("runtime_not_confirmed");
      failureKind = "runtime_not_confirmed";
      failureDetail = diagnostic.detail || "Config exists, but the client has not accepted a runtime check.";
      nextAction = "The bridge config exists, but runtime connectivity is not confirmed. Open or authenticate the client, then re-run diagnostics.";
      nextCommand = diagnoseCommand;
    } else if (diagnostic?.status === "disconnected") {
      runtimeStatus = "disconnected";
      blockers.push("client_auth_or_runtime_missing");
      failureKind = "client_auth_or_runtime_missing";
      failureDetail = diagnostic.detail || "Client auth or runtime readiness is missing.";
      nextAction = diagnostic.detail || "The bridge is configured but the client is not currently authenticated or runtime-ready.";
      nextCommand = diagnoseCommand;
    } else if (diagnostic?.status === "unavailable") {
      runtimeStatus = "unavailable";
      blockers.push("runtime_unavailable");
      failureKind = "runtime_unavailable";
      failureDetail = diagnostic.detail || "Client runtime is unavailable.";
      nextAction = diagnostic.detail || "The client is not currently available on this host.";
      nextCommand = installCommand ?? diagnoseCommand;
    } else {
      runtimeStatus = "diagnose_required";
      blockers.push("runtime_check_missing");
      failureKind = "runtime_check_missing";
      failureDetail = "No runtime diagnostic result has been recorded for this client yet.";
      nextAction = "The bridge looks configured, but no runtime verification has been recorded yet. Run diagnostics before treating it as live.";
      nextCommand = diagnoseCommand;
    }

    const repairCommand =
      installCommand && (blockers.includes("bridge_config_missing") || blockers.includes("client_binary_missing"))
        ? installCommand
        : exportCommand && (status.install_mode === "export-only" || status.install_mode === "remote-only")
          ? exportCommand
          : diagnoseCommand;

    return {
      client_id: status.client_id,
      display_name: status.display_name,
      office_agent_id: status.office_agent_id,
      install_mode: status.install_mode,
      config_path: status.config_path,
      runtime_status: runtimeStatus,
      ready,
      bridge_ready: status.outbound_bridge_ready,
      runtime_ready: ready || (diagnostic?.status === "connected" && diagnosticsStale !== true),
      next_action: nextAction,
      next_command: nextCommand,
      install_command: installCommand,
      diagnose_command: diagnoseCommand,
      export_command: exportCommand,
      verify_command: verifyCommand,
      repair_command: repairCommand,
      failure_kind: failureKind,
      failure_detail: failureDetail,
      blockers,
    } satisfies ProviderBridgeOnboardingEntry;
  });

  return {
    generated_at: params.generated_at ?? new Date().toISOString(),
    ready_count: entries.filter((entry) => entry.ready).length,
    action_required_count: entries.filter((entry) => !entry.ready).length,
    installable_count: entries.filter((entry) => entry.install_command !== null).length,
    needs_binary_count: entries.filter((entry) => entry.blockers.includes("client_binary_missing")).length,
    needs_install_count: entries.filter((entry) => entry.blockers.includes("bridge_config_missing")).length,
    needs_runtime_verification_count: entries.filter((entry) =>
      entry.blockers.some((blocker) =>
        blocker === "runtime_not_confirmed" ||
        blocker === "client_auth_or_runtime_missing" ||
        blocker === "runtime_check_missing" ||
        blocker === "runtime_check_stale"
      )
    ).length,
    export_only_count: entries.filter((entry) => entry.install_mode === "export-only").length,
    remote_only_count: entries.filter((entry) => entry.install_mode === "remote-only").length,
    stale_runtime_checks: diagnosticsStale,
    recommended_status_command: providerStatusCommand(),
    recommended_doctor_command: providerDoctorCommand(),
    recommended_install_command: "npm run providers:install -- <client-id>",
    recommended_diagnose_command: "npm run providers:diagnose -- <client-id>",
    recommended_export_command: providerExportCommand(),
    recommended_ingress_command: "npm run autonomy:ide",
    entries,
  };
}

function resolveClientConfigPaths(workspaceRoot: string) {
  const home = process.env.HOME || os.homedir();
  return {
    codex: path.join(home, ".codex", "config.toml"),
    claude: path.join(home, ".claude.json"),
    cursor: path.join(home, ".cursor", "mcp.json"),
    cursorWorkspace: path.join(workspaceRoot, ".cursor", "mcp.json"),
    copilotCli: path.join(home, ".copilot", "mcp-config.json"),
    gemini: path.join(home, ".gemini", "settings.json"),
    vscode: path.join(workspaceRoot, ".vscode", "mcp.json"),
  };
}

function inferTaskKindsForBridgeAgent(agentId: string | null) {
  switch (agentId) {
    case "codex":
      return ["planning", "coding", "verification", "tool_use"];
    case "claude":
      return ["planning", "review", "verification", "chat"];
    case "cursor":
      return ["coding", "verification", "tool_use"];
    case "github-copilot":
      return ["coding", "verification", "tool_use"];
    case "gemini":
      return ["research", "planning", "chat"];
    default:
      return ["planning", "chat"];
  }
}

function inferTagsForBridgeAgent(agentId: string | null, clientId: ProviderBridgeClientId) {
  const tags = new Set<string>(["remote", "hosted", "bridge", clientId]);
  if (agentId === "codex") {
    tags.add("frontier");
    tags.add("planning");
    tags.add("coding");
    tags.add("verification");
  } else if (agentId === "claude") {
    tags.add("frontier");
    tags.add("critic");
    tags.add("review");
    tags.add("planning");
  } else if (agentId === "cursor") {
    tags.add("coding");
    tags.add("implementer");
  } else if (agentId === "github-copilot") {
    tags.add("coding");
    tags.add("implementer");
    tags.add("github");
  } else if (agentId === "gemini") {
    tags.add("frontier");
    tags.add("research");
    tags.add("analysis");
    tags.add("planning");
  }
  return [...tags];
}

function resolveBridgeBackendProvider(clientId: ProviderBridgeClientId) {
  switch (clientId) {
    case "codex":
    case "chatgpt-developer-mode":
      return "openai" as const;
    case "claude-cli":
      return "anthropic" as const;
    case "gemini-cli":
      return "google" as const;
    case "cursor":
      return "cursor" as const;
    case "github-copilot-cli":
    case "github-copilot-vscode":
      return "github-copilot" as const;
    default:
      return "custom" as const;
  }
}

function resolveBridgeModelId(clientId: ProviderBridgeClientId) {
  switch (clientId) {
    case "codex":
      return readEnvString("TRICHAT_CODEX_MODEL") ?? "codex";
    case "claude-cli":
      return readEnvString("TRICHAT_CLAUDE_MODEL") ?? "claude-code";
    case "cursor":
      return readEnvString("TRICHAT_CURSOR_MODEL") ?? "cursor-agent";
    case "gemini-cli":
      return readEnvString("TRICHAT_GEMINI_MODEL") ?? (hasGeminiApiAccess() ? "gemini-2.5-flash" : "gemini-cli");
    case "github-copilot-cli":
    case "github-copilot-vscode":
      return "copilot";
    case "chatgpt-developer-mode":
      return readEnvString("TRICHAT_OPENAI_MODEL") ?? "chatgpt-developer-mode";
    default:
      return clientId;
  }
}

function resolveBridgeEndpoint(clientId: ProviderBridgeClientId) {
  return clientId === "gemini-cli" ? resolveGeminiProxyEndpoint() : null;
}

function isRuntimeReadyClient(status: ProviderBridgeClientStatus) {
  if (!status.outbound_council_supported || !status.outbound_bridge_ready || !status.outbound_agent_id) {
    return false;
  }
  if (status.client_id === "gemini-cli") {
    return status.binary_present || hasGeminiApiAccess();
  }
  return status.binary_present;
}

function buildRouterBackendCandidates(statuses: ProviderBridgeClientStatus[]): ProviderBridgeRouterBackendCandidate[] {
  return statuses
    .filter((status) => status.outbound_council_supported && status.outbound_agent_id)
    .map((status) => {
      const runtimeReady = isRuntimeReadyClient(status);
      const reason =
        status.resource_gate_blocked
          ? status.resource_gate_reason ?? "local resource gate is active"
          : runtimeReady
          ? null
          : status.client_id === "gemini-cli" && status.outbound_bridge_ready
            ? "missing Gemini CLI binary or Vertex/API credentials"
            : !status.outbound_bridge_ready
              ? "bridge adapter is not ready"
              : "required client runtime is missing";
      const agent = status.outbound_agent_id ? getTriChatAgent(status.outbound_agent_id) : null;
      const taskKinds = inferTaskKindsForBridgeAgent(status.outbound_agent_id);
      const geminiAdc = status.client_id === "gemini-cli" ? readGeminiAdcState() : null;
      return {
        client_id: status.client_id,
        eligible: runtimeReady,
        reason,
        backend: {
          backend_id: `bridge-${status.client_id}`,
          provider: resolveBridgeBackendProvider(status.client_id),
          model_id: resolveBridgeModelId(status.client_id),
          endpoint: resolveBridgeEndpoint(status.client_id),
          host_id: null,
          locality: "remote",
          tags: inferTagsForBridgeAgent(status.outbound_agent_id, status.client_id),
          capabilities: {
            task_kinds: taskKinds,
            capability_tier:
              status.outbound_agent_id === "codex" || status.outbound_agent_id === "gemini" ? "frontier" : "enhanced",
            bridge_agent_id: status.outbound_agent_id,
            bridge_client_id: status.client_id,
            role_lane: agent?.role_lane ?? null,
            coordination_tier: agent?.coordination_tier ?? null,
          },
          metadata: {
            seeded_from: "provider.bridge",
            bridge_agent_id: status.outbound_agent_id,
            bridge_client_id: status.client_id,
            runtime_ready: runtimeReady,
            installed: status.installed,
            config_present: status.config_present,
            binary_present: status.binary_present,
            resource_gate_blocked: status.resource_gate_blocked,
            resource_gate_reason: status.resource_gate_reason,
            requires_internet_for_model: status.requires_internet_for_model,
            ...(status.client_id === "gemini-cli"
              ? {
                  auth_mode: "vertex-ai-adc",
                  proxy_endpoint: resolveGeminiProxyEndpoint(),
                  adc_present: geminiAdc?.adc_present === true,
                  google_cloud_project_present: geminiAdc?.google_cloud_project_present === true,
                }
              : {}),
          },
        },
      } satisfies ProviderBridgeRouterBackendCandidate;
    });
}

function formatLocalResourceGateReason(resourceGate: LocalBridgeResourceGate) {
  if (!resourceGate.active) {
    return null;
  }
  const metricSummary = [
    resourceGate.metrics.cpu_utilization !== null
      ? `cpu=${Math.round(resourceGate.metrics.cpu_utilization * 100)}%`
      : null,
    resourceGate.metrics.ram_free_ratio !== null
      ? `ram_free=${Math.round(resourceGate.metrics.ram_free_ratio * 100)}%`
      : null,
    resourceGate.metrics.gpu_memory_free_ratio !== null
      ? `gpu_mem_free=${Math.round(resourceGate.metrics.gpu_memory_free_ratio * 100)}%`
      : null,
    `active_tasks=${resourceGate.metrics.active_tasks}`,
    `queue_depth=${resourceGate.metrics.queue_depth}`,
  ]
    .filter(Boolean)
    .join(", ");
  return [
    resourceGate.detail ?? "Local resource gate is active.",
    metricSummary ? `Current metrics: ${metricSummary}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function applyLocalBridgeResourceGateToStatuses(
  statuses: ProviderBridgeClientStatus[],
  resourceGate: LocalBridgeResourceGate
) {
  const resourceGateReason = formatLocalResourceGateReason(resourceGate);
  return statuses.map((status) => {
    if (!status.outbound_council_supported || !resourceGate.recommendations.suppress_outbound_bridges) {
      return {
        ...status,
        resource_gate_blocked: false,
        resource_gate_reason: null,
      } satisfies ProviderBridgeClientStatus;
    }
    return {
      ...status,
      outbound_bridge_ready: false,
      resource_gate_blocked: true,
      resource_gate_reason: resourceGateReason,
      notes: resourceGateReason ? [...status.notes, resourceGateReason] : status.notes,
    } satisfies ProviderBridgeClientStatus;
  });
}

export function resolveProviderBridgeSnapshot(input: {
  storage?: Storage | null;
  workspace_root?: string;
  transport?: "auto" | "http" | "stdio";
  http_url?: string;
  http_origin?: string;
  stdio_command?: string;
  stdio_args?: string[];
  db_path?: string;
  server_name?: string;
} = {}): ProviderBridgeSnapshot {
  const workspaceRoot = input.workspace_root?.trim() || repoRoot;
  const transport = resolveTransportConfig({
    transport: input.transport ?? "auto",
    http_url: input.http_url,
    http_origin: input.http_origin,
    stdio_command: input.stdio_command,
    stdio_args: input.stdio_args,
    db_path: input.db_path,
    workspace_root: workspaceRoot,
  });
  const serverName = input.server_name?.trim() || "master-mold";
  const resourceGate = resolveLocalBridgeResourceGate({
    storage: input.storage ?? null,
    fallback_workspace_root: workspaceRoot,
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  });
  const clients = applyLocalBridgeResourceGateToStatuses(
    buildClientStatusesCached(workspaceRoot, transport, serverName),
    resourceGate
  );
  const routerBackendCandidates = buildRouterBackendCandidates(clients);
  return {
    canonical_ingress_tool: "autonomy.ide_ingress",
    local_first_ide_agent_ids: resolveLocalFirstAgents(),
    workspace_root: workspaceRoot,
    server_name: serverName,
    transport: transport.mode,
    resource_gate: resourceGate,
    outbound_council_agents: clients
      .filter((entry) => entry.outbound_council_supported)
      .map((entry) => ({
        client_id: entry.client_id,
        agent_id: entry.outbound_agent_id,
        bridge_ready: entry.outbound_bridge_ready,
        runtime_ready: isRuntimeReadyClient(entry),
      })),
    router_backend_candidates: routerBackendCandidates,
    eligible_router_backends: routerBackendCandidates.filter((entry) => entry.eligible).map((entry) => entry.backend),
    clients,
  };
}

function buildHttpEntry(config: ProviderBridgeTransportConfig, serverName: string, includeBearerToken: boolean) {
  const headers: Record<string, string> = {
    Origin: config.origin,
  };
  if (includeBearerToken && config.bearer_token) {
    headers.Authorization = `Bearer ${config.bearer_token}`;
  } else if (config.bearer_token) {
    headers.Authorization = "Bearer <set MCP_HTTP_BEARER_TOKEN>";
  }
  return {
    url: config.url,
    headers,
  };
}

function buildStdioEntry(
  config: ProviderBridgeTransportConfig,
  options: {
    cwd?: string;
    type?: "stdio";
    timeout?: number;
    trust?: boolean;
    description?: string;
  } = {}
) {
  return {
    ...(options.type ? { type: options.type } : {}),
    command: config.command,
    args: config.args,
    env: {
      ANAMNESIS_HUB_DB_PATH: resolveEntryDbPath(config, options.cwd),
    },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : {}),
    ...(typeof options.trust === "boolean" ? { trust: options.trust } : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}

function buildProviderProxyStdioEntry(
  config: ProviderBridgeTransportConfig,
  workspaceRoot: string,
  includeBearerToken: boolean,
  description: string
) {
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [providerStdioBridgePath],
    env: {
      MCP_PROXY_TRANSPORT: "auto",
      MCP_PROXY_HTTP_URL: config.url,
      MCP_PROXY_HTTP_ORIGIN: config.origin,
      ...(includeBearerToken && config.bearer_token
        ? { MCP_PROXY_HTTP_BEARER_TOKEN: config.bearer_token }
        : config.bearer_token
          ? { MCP_PROXY_HTTP_BEARER_TOKEN: "<set MCP_HTTP_BEARER_TOKEN>" }
          : {}),
      MCP_PROXY_STDIO_COMMAND: config.command,
      MCP_PROXY_STDIO_ARGS: JSON.stringify(config.args),
      MCP_PROXY_STDIO_CWD: workspaceRoot,
      MCP_PROXY_STDIO_DB_PATH: resolveEntryDbPath(config, workspaceRoot),
    },
    cwd: workspaceRoot,
    timeout: 600000,
    trust: true,
    description,
  };
}

function buildCursorOrGeminiEntry(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean
) {
  return config.mode === "http" ? buildHttpEntry(config, serverName, includeBearerToken) : buildStdioEntry(config);
}

function buildClaudeCliStdioEntry(
  config: ProviderBridgeTransportConfig,
  workspaceRoot: string,
  includeBearerToken: boolean
) {
  return buildProviderProxyStdioEntry(
    config,
    workspaceRoot,
    includeBearerToken,
    "MASTER MOLD MCP HTTP proxy for Claude CLI"
  );
}

function shellQuote(value: string) {
  return JSON.stringify(value);
}

function buildClaudeCliInstallScript(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean,
  workspaceRoot: string
) {
  if (config.mode === "http") {
    const lines = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `claude mcp remove -s user ${shellQuote(serverName)} >/dev/null 2>&1 || true`,
    ];
    if (!includeBearerToken && config.bearer_token) {
      lines.push('if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then');
      lines.push('  echo "Set MCP_HTTP_BEARER_TOKEN before running this installer." >&2');
      lines.push("  exit 1");
      lines.push("fi");
    }
    const headerArgs = [`-H ${shellQuote(`Origin: ${config.origin}`)}`];
    if (includeBearerToken && config.bearer_token) {
      headerArgs.push(`-H ${shellQuote(`Authorization: Bearer ${config.bearer_token}`)}`);
    } else if (config.bearer_token) {
      headerArgs.push('-H "Authorization: Bearer ${MCP_HTTP_BEARER_TOKEN}"');
    }
    lines.push(
      `claude mcp add -s user -t http ${shellQuote(serverName)} ${shellQuote(config.url)} ${headerArgs.join(" ")}`
    );
    return lines.join("\n");
  }
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `claude mcp remove -s user ${shellQuote(serverName)} >/dev/null 2>&1 || true`,
    `claude mcp add-json -s user ${shellQuote(serverName)} ${shellQuote(
      JSON.stringify(buildClaudeCliStdioEntry(config, workspaceRoot, includeBearerToken))
    )}`,
  ].join("\n");
}

function buildGeminiEntry(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean,
  workspaceRoot: string
) {
  if (config.mode === "http") {
    return {
      type: "http" as const,
      timeout: 600000,
      trust: true,
      description: "MASTER MOLD MCP server",
      ...buildHttpEntry(config, serverName, includeBearerToken),
    };
  }
  return buildProviderProxyStdioEntry(config, workspaceRoot, includeBearerToken, "MASTER MOLD MCP HTTP proxy");
}

function buildCopilotCliEntry(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean
) {
  if (config.mode === "http") {
    return {
      ...buildHttpEntry(config, serverName, includeBearerToken),
      type: "http",
      tools: ["*"],
    };
  }
  return {
    ...buildStdioEntry(config),
    type: "local",
    tools: ["*"],
  };
}

function buildVsCodeEntry(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean
) {
  return {
    servers: {
      [serverName]: config.mode === "http" ? buildHttpEntry(config, serverName, includeBearerToken) : buildStdioEntry(config),
    },
  };
}

function codexInstalled(configPath: string, serverName: string) {
  if (!fs.existsSync(configPath)) {
    return false;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return raw.includes(`[mcp_servers.${serverName}]`) || raw.includes(`[mcp_servers."${serverName}"]`);
  } catch {
    return false;
  }
}

function claudeInstalled(workspaceRoot: string, serverName: string) {
  const configPath = resolveClientConfigPaths(workspaceRoot).claude;
  if (jsonServerInstalled(configPath, serverName)) {
    return true;
  }
  if (isHttpServing() && !allowSyncCliProbe()) {
    return false;
  }
  if (!commandExists("claude")) {
    return false;
  }
  const probe = runCommandProbe("claude", ["mcp", "get", serverName], {
    cwd: workspaceRoot,
    timeout: 4000,
    env: buildProviderProbeEnv(workspaceRoot),
  });
  if (probe.status === 0) {
    return true;
  }
  return /(^|\n)\s*Scope:\s+/m.test(probe.combined) || /(^|\n)\s*Type:\s+/m.test(probe.combined);
}

function readClaudeAuthState(workspaceRoot: string) {
  if (!commandExists("claude")) {
    return {
      available: false,
      connected: false,
      detail: "Claude CLI binary is not installed.",
    };
  }
  const probe = runCommandProbe("claude", ["auth", "status"], {
    cwd: workspaceRoot,
    timeout: 4000,
    env: buildProviderProbeEnv(workspaceRoot),
  });
  if (probe.status !== 0) {
    return {
      available: false,
      connected: false,
      detail: probe.error || probe.combined.trim() || "Claude CLI auth status probe failed.",
    };
  }
  try {
    const parsed = JSON.parse(probe.stdout || probe.combined || "{}") as Record<string, unknown>;
    const loggedIn = Boolean(parsed.loggedIn);
    const authMethod = String(parsed.authMethod ?? "unknown");
    return {
      available: true,
      connected: loggedIn,
      detail: loggedIn
        ? `Claude CLI authentication is active (${authMethod}).`
        : `Claude CLI is installed but not authenticated (${authMethod}).`,
    };
  } catch {
    return {
      available: true,
      connected: false,
      detail: "Claude CLI auth status returned unreadable output.",
    };
  }
}

function jsonServerInstalled(filePath: string, serverName: string) {
  const parsed = readJsonFile(filePath) as Record<string, unknown>;
  const mcpServers = parsed.mcpServers;
  return Boolean(
    mcpServers &&
      typeof mcpServers === "object" &&
      !Array.isArray(mcpServers) &&
      Object.prototype.hasOwnProperty.call(mcpServers, serverName)
  );
}

function buildClientStatuses(
  workspaceRoot: string,
  transport: ProviderBridgeTransportConfig,
  serverName: string
): ProviderBridgeClientStatus[] {
  const configPaths = resolveClientConfigPaths(workspaceRoot);
  const rosterAgentIds: Record<string, string | null> = {
    codex: "codex",
    "claude-cli": "claude",
    cursor: "cursor",
    "gemini-cli": "gemini",
    "github-copilot-cli": null,
    "github-copilot-vscode": null,
    "chatgpt-developer-mode": null,
  };
  const officeAgentIds: Record<ProviderBridgeClientId, string | null> = {
    codex: "codex",
    "claude-cli": "claude",
    cursor: "cursor",
    "github-copilot-cli": "github-copilot",
    "github-copilot-vscode": "github-copilot",
    "gemini-cli": "gemini",
    "chatgpt-developer-mode": null,
  };

  const notes = {
    codex: [
      "Best local install path is the existing Codex CLI MCP registration script.",
      "Outbound council consultation is available through bridges/codex_bridge.py.",
    ],
    "claude-cli": [
      "Claude Code can connect inbound through its native `claude mcp` configuration.",
      "Claude CLI defaults to stdio MCP transport on this host for better local compatibility.",
      "Outbound council consultation is available through bridges/claude_bridge.py.",
      "This repo installs the MCP bridge with `claude mcp add`/`add-json` instead of editing hidden config formats directly.",
    ],
    cursor: [
      "Cursor can connect to the shared HTTP daemon or launch the server via stdio.",
      "For reliability, this repo installs both ~/.cursor/mcp.json and workspace-local .cursor/mcp.json.",
      "Outbound council consultation is available through bridges/cursor_bridge.py.",
      "Use `model.router` actions `local_status` and `select_local_backend` from Cursor to inspect and choose local Ollama/MLX backends while keeping MASTER-MOLD as the canonical control plane.",
    ],
    "github-copilot-cli": [
      "Inbound MCP config is exportable/installable through ~/.copilot/mcp-config.json.",
      "The current official CLI installs as `copilot`; older `gh copilot` extension installs are still detected.",
      "GitHub Copilot is treated as an inbound MCP client here, not an outbound council bridge.",
      "Do not seed Copilot into model.router backends until a real outbound council bridge contract exists.",
    ],
    "github-copilot-vscode": [
      "Workspace-level VS Code/Copilot Agent mode config is exportable as .vscode/mcp.json.",
      "This path is export-only here because editor-specific merges vary by host setup.",
    ],
    "gemini-cli": [
      "Gemini CLI can connect inbound via ~/.gemini/settings.json.",
      "Outbound council consultation is available through bridges/gemini_bridge.py.",
    ],
    "chatgpt-developer-mode": [
      "ChatGPT/OpenAI custom MCP currently requires a remote MCP server path, not a pure local-only config.",
      "This repo exports a truthful manifest for that remote path instead of pretending local install exists.",
    ],
  } satisfies Record<ProviderBridgeClientId, string[]>;

  return [
    {
      client_id: "codex",
      display_name: "Codex",
      office_agent_id: officeAgentIds.codex,
      install_mode: "cli",
      config_path: configPaths.codex,
      installed: codexInstalled(configPaths.codex, serverName),
      binary_present: commandExists("codex"),
      config_present: fs.existsSync(configPaths.codex),
      supported_transports: ["stdio", "http"],
      preferred_transport: "stdio",
      inbound_mcp_supported: true,
      outbound_council_supported: true,
      outbound_agent_id: rosterAgentIds.codex,
      outbound_bridge_ready: resolveOutboundBridgeReady(rosterAgentIds.codex),
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes.codex,
    },
    {
      client_id: "claude-cli",
      display_name: "Claude CLI",
      office_agent_id: officeAgentIds["claude-cli"],
      install_mode: "cli",
      config_path: configPaths.claude,
      installed: claudeInstalled(workspaceRoot, serverName),
      binary_present: commandExists("claude"),
      config_present: fs.existsSync(configPaths.claude),
      supported_transports: ["http", "stdio"],
      preferred_transport: "stdio",
      inbound_mcp_supported: true,
      outbound_council_supported: true,
      outbound_agent_id: rosterAgentIds["claude-cli"],
      outbound_bridge_ready: resolveOutboundBridgeReady(rosterAgentIds["claude-cli"]),
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes["claude-cli"],
    },
    {
      client_id: "cursor",
      display_name: "Cursor",
      office_agent_id: officeAgentIds.cursor,
      install_mode: "json-config",
      config_path: configPaths.cursor,
      installed:
        jsonServerInstalled(configPaths.cursor, serverName) ||
        jsonServerInstalled(configPaths.cursorWorkspace, serverName),
      binary_present: commandExists("cursor") || fs.existsSync("/Applications/Cursor.app"),
      config_present: fs.existsSync(configPaths.cursor) || fs.existsSync(configPaths.cursorWorkspace),
      supported_transports: ["http", "stdio"],
      preferred_transport: transport.mode,
      inbound_mcp_supported: true,
      outbound_council_supported: true,
      outbound_agent_id: rosterAgentIds.cursor,
      outbound_bridge_ready: resolveOutboundBridgeReady(rosterAgentIds.cursor),
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes.cursor,
    },
    {
      client_id: "github-copilot-cli",
      display_name: "GitHub Copilot CLI",
      office_agent_id: officeAgentIds["github-copilot-cli"],
      install_mode: "json-config",
      config_path: configPaths.copilotCli,
      installed: jsonServerInstalled(configPaths.copilotCli, serverName),
      binary_present: hasCopilotCliBinary(),
      config_present: fs.existsSync(configPaths.copilotCli),
      supported_transports: ["http", "stdio"],
      preferred_transport: transport.mode,
      inbound_mcp_supported: true,
      outbound_council_supported: false,
      outbound_agent_id: null,
      outbound_bridge_ready: false,
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes["github-copilot-cli"],
    },
    {
      client_id: "github-copilot-vscode",
      display_name: "GitHub Copilot Agent Mode (VS Code)",
      office_agent_id: officeAgentIds["github-copilot-vscode"],
      install_mode: "export-only",
      config_path: configPaths.vscode,
      installed: false,
      binary_present: fs.existsSync("/Applications/Visual Studio Code.app") || commandExists("code"),
      config_present: fs.existsSync(configPaths.vscode),
      supported_transports: ["http", "stdio"],
      preferred_transport: transport.mode,
      inbound_mcp_supported: true,
      outbound_council_supported: false,
      outbound_agent_id: null,
      outbound_bridge_ready: false,
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes["github-copilot-vscode"],
    },
    {
      client_id: "gemini-cli",
      display_name: "Gemini CLI",
      office_agent_id: officeAgentIds["gemini-cli"],
      install_mode: "json-config",
      config_path: configPaths.gemini,
      installed: jsonServerInstalled(configPaths.gemini, serverName),
      binary_present: commandExists("gemini"),
      config_present: fs.existsSync(configPaths.gemini),
      supported_transports: ["http", "stdio"],
      preferred_transport: "stdio",
      inbound_mcp_supported: true,
      outbound_council_supported: true,
      outbound_agent_id: rosterAgentIds["gemini-cli"],
      outbound_bridge_ready: resolveOutboundBridgeReady(rosterAgentIds["gemini-cli"]),
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes["gemini-cli"],
    },
    {
      client_id: "chatgpt-developer-mode",
      display_name: "ChatGPT Developer Mode",
      office_agent_id: officeAgentIds["chatgpt-developer-mode"],
      install_mode: "remote-only",
      config_path: null,
      installed: false,
      binary_present: false,
      config_present: false,
      supported_transports: ["http"],
      preferred_transport: "http",
      inbound_mcp_supported: true,
      outbound_council_supported: false,
      outbound_agent_id: null,
      outbound_bridge_ready: false,
      resource_gate_blocked: false,
      resource_gate_reason: null,
      requires_internet_for_model: true,
      notes: notes["chatgpt-developer-mode"],
    },
  ];
}

function buildClientStatusesCached(
  workspaceRoot: string,
  transport: ProviderBridgeTransportConfig,
  serverName: string
): ProviderBridgeClientStatus[] {
  const cacheKey = providerBridgeStatusCacheKey(workspaceRoot, transport, serverName);
  const cached = providerBridgeStatusCache.get(cacheKey);
  const ttlMs = providerBridgeStatusCacheTtlMs();
  if (cached && Date.now() - cached.captured_at <= ttlMs) {
    return cached.statuses;
  }
  // When serving over HTTP, return stale cache rather than blocking the event
  // loop with synchronous shell probes (commandExists, claudeInstalled, etc.).
  if (isHttpServing() && cached) {
    return cached.statuses;
  }
  const statuses = buildClientStatuses(workspaceRoot, transport, serverName);
  cacheProviderBridgeStatuses(workspaceRoot, transport, serverName, statuses);
  return statuses;
}

function providerBridgeStatusCacheKey(
  workspaceRoot: string,
  transport: ProviderBridgeTransportConfig,
  serverName: string
) {
  return JSON.stringify({
    workspaceRoot,
    serverName,
    transportMode: transport.mode,
  });
}

function cacheProviderBridgeStatuses(
  workspaceRoot: string,
  transport: ProviderBridgeTransportConfig,
  serverName: string,
  statuses: ProviderBridgeClientStatus[]
) {
  providerBridgeStatusCache.set(providerBridgeStatusCacheKey(workspaceRoot, transport, serverName), {
    captured_at: Date.now(),
    statuses,
  });
}

function resolveOutboundBridgeReady(agentId: string | null) {
  if (!agentId) {
    return false;
  }
  const agent = getTriChatAgent(agentId);
  if (!agent) {
    return false;
  }
  return getTriChatBridgeCandidates(repoRoot, agent.agent_id).some((candidate) => fs.existsSync(candidate));
}

function hasHttpConfiguredServer(filePath: string, serverName: string) {
  const parsed = readJsonFile(filePath) as Record<string, unknown>;
  const mcpServers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  const entry =
    mcpServers && typeof mcpServers[serverName] === "object" && !Array.isArray(mcpServers[serverName])
      ? (mcpServers[serverName] as Record<string, unknown>)
      : null;
  if (!entry) {
    return false;
  }
  return typeof entry.url === "string" && entry.url.trim().length > 0;
}

function resolveProviderHome() {
  return process.env.HOME?.trim() || os.homedir();
}

function readGeminiConfigEntry(filePath: string | null, serverName: string) {
  if (!filePath) {
    return null;
  }
  const parsed = readJsonFile(filePath) as Record<string, unknown>;
  const mcpServers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  const entry =
    mcpServers && typeof mcpServers[serverName] === "object" && !Array.isArray(mcpServers[serverName])
      ? (mcpServers[serverName] as Record<string, unknown>)
      : null;
  return entry;
}

function summarizeGeminiConfigEntry(entry: Record<string, unknown> | null) {
  if (!entry) {
    return {
      present: false,
      valid: false,
      mode: null as "http" | "stdio" | null,
      detail: "Gemini CLI MCP server entry is missing.",
    };
  }
  const type = String(entry.type ?? "").trim().toLowerCase();
  const command = String(entry.command ?? "").trim();
  const args = readStringArray(entry.args);
  const url = String(entry.url ?? "").trim();
  if ((type === "stdio" || command) && command && args.length > 0) {
    return {
      present: true,
      valid: true,
      mode: "stdio" as const,
      detail: `Gemini CLI MCP bridge configured via stdio (${path.basename(command)}).`,
    };
  }
  if ((type === "http" || url) && url) {
    return {
      present: true,
      valid: true,
      mode: "http" as const,
      detail: `Gemini CLI MCP bridge configured via HTTP (${url}).`,
    };
  }
  return {
    present: true,
    valid: false,
    mode: null as "http" | "stdio" | null,
    detail: "Gemini CLI MCP entry exists but is incomplete.",
  };
}

function readGeminiOauthState() {
  const filePath = path.join(resolveProviderHome(), ".gemini", "oauth_creds.json");
  if (!fs.existsSync(filePath)) {
    return {
      available: false,
      connected: false,
      detail: "Gemini CLI OAuth credentials are missing.",
      file_path: filePath,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const expiryDate = Number(parsed.expiry_date ?? 0);
    const refreshToken = String(parsed.refresh_token ?? "").trim();
    const accessToken = String(parsed.access_token ?? "").trim();
    const now = Date.now();
    const hasRefresh = refreshToken.length > 0;
    const hasAccess = accessToken.length > 0;
    const notExpired = Number.isFinite(expiryDate) && expiryDate > now;
    if (hasRefresh || (hasAccess && notExpired)) {
      return {
        available: true,
        connected: true,
        detail:
          hasRefresh && !notExpired
            ? "Gemini CLI OAuth session is renewable via refresh token."
            : "Gemini CLI OAuth session is present.",
        file_path: filePath,
      };
    }
    return {
      available: true,
      connected: false,
      detail: "Gemini CLI OAuth credentials are stale and not refreshable.",
      file_path: filePath,
    };
  } catch {
    return {
      available: true,
      connected: false,
      detail: "Gemini CLI OAuth credentials file is unreadable.",
      file_path: filePath,
    };
  }
}

function readCopilotAuthState() {
  const filePath = path.join(resolveProviderHome(), ".copilot", "config.json");
  if (!fs.existsSync(filePath)) {
    return {
      available: false,
      connected: false,
      detail: "Copilot CLI auth metadata is missing.",
      file_path: filePath,
      mtime_ms: 0,
      login: null as string | null,
    };
  }
  try {
    const stats = fs.statSync(filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const lastLoggedInUser =
      parsed.last_logged_in_user && typeof parsed.last_logged_in_user === "object"
        ? (parsed.last_logged_in_user as Record<string, unknown>)
        : {};
    const loggedInUsers = Array.isArray(parsed.logged_in_users)
      ? parsed.logged_in_users.filter((entry) => entry && typeof entry === "object")
      : [];
    const lastLogin = String(lastLoggedInUser.login ?? "").trim();
    const fallbackLogin = loggedInUsers
      .map((entry) => String((entry as Record<string, unknown>).login ?? "").trim())
      .find(Boolean);
    const login = lastLogin || fallbackLogin || null;
    if (login) {
      return {
        available: true,
        connected: true,
        detail: `Copilot CLI login metadata present for ${login}.`,
        file_path: filePath,
        mtime_ms: stats.mtimeMs,
        login,
      };
    }
    return {
      available: true,
      connected: false,
      detail: "Copilot CLI config is present, but no logged-in user metadata is recorded.",
      file_path: filePath,
      mtime_ms: stats.mtimeMs,
      login: null as string | null,
    };
  } catch {
    return {
      available: true,
      connected: false,
      detail: "Copilot CLI auth metadata file is unreadable.",
      file_path: filePath,
      mtime_ms: 0,
      login: null as string | null,
    };
  }
}

function readRecentFileTail(filePath: string, maxBytes = 4096) {
  try {
    const stats = fs.statSync(filePath);
    const size = Math.max(0, stats.size);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return {
        text: buffer.toString("utf8"),
        mtimeMs: stats.mtimeMs,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function inspectRecentCopilotAuthLogs(options: { newerThanMs?: number } = {}) {
  const logsDir = path.join(resolveProviderHome(), ".copilot", "logs");
  if (!fs.existsSync(logsDir)) {
    return null;
  }
  const candidates = fs
    .readdirSync(logsDir)
    .filter((entry) => entry.endsWith(".log"))
    .map((entry) => path.join(logsDir, entry))
    .map((filePath) => ({
      filePath,
      stats: fs.statSync(filePath),
    }))
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
    .slice(0, 6);
  const recencyCutoff = Date.now() - 1000 * 60 * 60 * 24;
  for (const entry of candidates) {
    if (entry.stats.mtimeMs < recencyCutoff) {
      continue;
    }
    if (typeof options.newerThanMs === "number" && Number.isFinite(options.newerThanMs) && entry.stats.mtimeMs <= options.newerThanMs) {
      continue;
    }
    const tail = readRecentFileTail(entry.filePath, 8192);
    const text = tail?.text || "";
    if (text.includes("No authentication information found.")) {
      return {
        connected: false,
        status: "disconnected" as const,
        detail: "Copilot CLI is installed, but no authenticated session is currently available.",
        source: path.basename(entry.filePath),
      };
    }
  }
  return null;
}

function parseCopilotPromptProbe(output: string) {
  const normalized = output.toLowerCase();
  if (!normalized.trim()) {
    return {
      connected: null,
      status: "configured" as const,
      detail: "Copilot probe returned no output.",
    };
  }
  if (
    normalized.includes("no authentication information found") ||
    normalized.includes("to authenticate") ||
    normalized.includes("copilot can be authenticated")
  ) {
    return {
      connected: false,
      status: "disconnected" as const,
      detail: "Copilot CLI is installed, but no authenticated session is currently available.",
    };
  }
  if (normalized.includes("401") || normalized.includes("unauthorized")) {
    return {
      connected: false,
      status: "disconnected" as const,
      detail: "Copilot CLI authentication appears stale or unauthorized.",
    };
  }
  return {
    connected: null,
    status: "configured" as const,
    detail: compactProbeDetail(output, "Copilot CLI probe did not return a definitive auth result."),
  };
}

function compactProbeDetail(output: string, fallback: string) {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, 240) : fallback;
}

function runProviderDiagnostics(
  workspaceRoot: string,
  serverName: string,
  statuses: ProviderBridgeClientStatus[],
  probeTimeoutMs: number
): ProviderBridgeDiagnostic[] {
  return statuses.map((status) => {
    if (status.client_id === "codex") {
      const observed = status.installed && isCodexRuntimeObserved();
      return {
        client_id: status.client_id,
        display_name: status.display_name,
        office_agent_id: status.office_agent_id,
        available: status.binary_present || status.config_present,
        runtime_probed: observed,
        connected: observed ? true : null,
        status: observed ? "connected" : status.installed ? "configured" : "unavailable",
        detail: observed
          ? "Codex desktop runtime is running and MCP is configured."
          : status.installed
            ? "Codex bridge is configured. Live runtime is not currently observed on this host."
            : "Codex bridge config is missing.",
        notes: status.notes,
        command: null,
        config_path: status.config_path,
      } satisfies ProviderBridgeDiagnostic;
    }
    if (status.client_id === "claude-cli") {
      if (!status.binary_present || !status.installed) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: false,
          runtime_probed: false,
          connected: null,
          status: "unavailable",
          detail: !status.binary_present
            ? "Claude CLI binary is not installed."
            : "Claude CLI MCP bridge is not configured for this host.",
          notes: status.notes,
          command: "claude mcp get master-mold && claude auth status",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      const auth = readClaudeAuthState(workspaceRoot);
      return {
        client_id: status.client_id,
        display_name: status.display_name,
        office_agent_id: status.office_agent_id,
        available: true,
        runtime_probed: true,
        connected: auth.available ? auth.connected : false,
        status: auth.connected ? "connected" : auth.available ? "disconnected" : "configured",
        detail: auth.detail,
        notes: status.notes,
        command: "claude mcp get master-mold + claude auth status",
        config_path: status.config_path,
      } satisfies ProviderBridgeDiagnostic;
    }
    if (status.client_id === "gemini-cli") {
      if (!status.binary_present || !status.config_present) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: false,
          runtime_probed: false,
          connected: null,
          status: "unavailable",
          detail: !status.binary_present
            ? "Gemini CLI binary is not installed."
            : "Gemini CLI config is missing.",
          notes: status.notes,
          command: "gemini mcp list",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      const entry = readGeminiConfigEntry(status.config_path, serverName);
      const configSummary = summarizeGeminiConfigEntry(entry);
      const oauth = readGeminiOauthState();
      const adc = readGeminiAdcState();
      const vertexModeRequested = Boolean(
        adc.adc_present ||
          adc.credentials_path_configured ||
          readEnvString("TRICHAT_GEMINI_PROXY_ENDPOINT") ||
          readEnvString("GOOGLE_VERTEX_BASE_URL")
      );
      const litellmProxy = vertexModeRequested ? probeGeminiLiteLlmProxy(probeTimeoutMs) : null;
      const vertexMetadata = vertexModeRequested
        ? {
            ...adc,
            litellm_proxy: litellmProxy,
          }
        : undefined;
      const observed = status.installed && isGeminiRuntimeObserved(workspaceRoot);
      const notes = [...status.notes];
      if (configSummary.mode === "http" && hasHttpConfiguredServer(status.config_path ?? "", serverName)) {
        notes.push("Gemini CLI is configured over HTTP here; this repo prefers stdio for Gemini because it is more reliable.");
      }
      if (vertexModeRequested) {
        notes.push("Gemini is configured for Vertex AI ADC through LiteLLM; readiness follows ADC and proxy health, not GEMINI_API_KEY.");
      }
      if (litellmProxy?.degraded === true) {
        notes.push("LiteLLM proxy service is ready; the full endpoint inventory health check did not complete inside the operator timeout.");
      }
      if (configSummary.valid && vertexMetadata && adc.adc_present && litellmProxy?.healthy === true) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: `${configSummary.detail} Vertex AI ADC is present and the LiteLLM proxy is healthy at ${litellmProxy.endpoint}.`,
          notes,
          command: "stateful config + Vertex ADC + LiteLLM proxy health",
          config_path: status.config_path,
          last_probe_at: new Date().toISOString(),
          metadata: vertexMetadata,
        } satisfies ProviderBridgeDiagnostic;
      }
      if (configSummary.valid && vertexMetadata && (!adc.adc_present || litellmProxy?.healthy === false)) {
        const blocker = !adc.adc_present
          ? "Vertex AI ADC credentials are missing."
          : `LiteLLM proxy is not healthy at ${litellmProxy?.endpoint ?? resolveGeminiProxyEndpoint()}.`;
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: false,
          status: "disconnected",
          detail: `${configSummary.detail} ${blocker}`,
          notes,
          command: "stateful config + Vertex ADC + LiteLLM proxy health",
          config_path: status.config_path,
          last_probe_at: new Date().toISOString(),
          metadata: vertexMetadata,
        } satisfies ProviderBridgeDiagnostic;
      }
      if (configSummary.valid && oauth.connected && observed) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: `${configSummary.detail} ${oauth.detail}`,
          notes,
          command: "stateful config + oauth heartbeat + runtime probe",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      if (configSummary.valid) {
        const oauthRenewable = oauth.connected || oauth.available;
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: false,
          status: oauth.connected ? "configured" : oauth.available ? "disconnected" : "configured",
          detail: oauth.connected
            ? `${configSummary.detail} ${oauth.detail} Gemini runtime is not currently observed — this is normal when the CLI is idle and does not indicate a missing install.`
            : oauth.detail,
          notes: oauthRenewable
            ? [...notes, "Gemini intermittently shows configured vs connected depending on whether the CLI process is active. This does not indicate a missing install."]
            : notes,
          command: "stateful config + oauth heartbeat + runtime probe",
          config_path: status.config_path,
          last_probe_at: new Date().toISOString(),
          intermittent: oauthRenewable,
        } satisfies ProviderBridgeDiagnostic;
      }
      return {
        client_id: status.client_id,
        display_name: status.display_name,
        office_agent_id: status.office_agent_id,
        available: true,
        runtime_probed: true,
        connected: false,
        status: "disconnected",
        detail: configSummary.detail,
        notes,
        command: "stateful config + oauth heartbeat",
        config_path: status.config_path,
      } satisfies ProviderBridgeDiagnostic;
    }
    if (status.client_id === "cursor") {
      const observed = status.installed && isCursorRuntimeObserved(workspaceRoot);
      return {
        client_id: status.client_id,
        display_name: status.display_name,
        office_agent_id: status.office_agent_id,
        available: status.binary_present || status.config_present,
        runtime_probed: observed,
        connected: observed ? true : null,
        status: observed ? "connected" : status.installed ? "configured" : "unavailable",
        detail: observed
          ? "Cursor is running on this workspace and the MCP bridge is configured."
          : status.installed
            ? "Cursor bridge is configured. Runtime MCP status is not currently observed on this host."
          : "Cursor bridge config is missing.",
        notes: status.notes,
        command: null,
        config_path: status.config_path,
      } satisfies ProviderBridgeDiagnostic;
    }
    if (status.client_id === "github-copilot-cli") {
      if (!status.binary_present || !status.config_present) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: false,
          runtime_probed: false,
          connected: null,
          status: "unavailable",
          detail: !status.binary_present
            ? "Copilot CLI binary is not installed."
            : "Copilot CLI MCP config is missing.",
          notes: status.notes,
          command: "copilot -p \"Respond with OK\" --allow-all-tools --output-format json --stream off",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      const copilotAuthState = readCopilotAuthState();
      const copilotLogState = inspectRecentCopilotAuthLogs({
        newerThanMs: copilotAuthState.connected ? copilotAuthState.mtime_ms : undefined,
      });
      if (copilotAuthState.connected && !copilotLogState) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: true,
          status: "connected",
          detail: copilotAuthState.detail,
          notes: status.notes,
          command: "stateful config + recent log heartbeat",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      if (copilotLogState) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: copilotLogState.connected,
          status: copilotLogState.status,
          detail: `${copilotLogState.detail} (${copilotLogState.source})`,
          notes: status.notes,
          command: "stateful config + recent log heartbeat",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      const probe = runCommandProbe(
        "copilot",
        ["-p", "Respond with OK", "--allow-all-tools", "--output-format", "json", "--stream", "off", "--reasoning-effort", "low"],
        {
          cwd: workspaceRoot,
          timeout: probeTimeoutMs,
          env: buildProviderProbeEnv(workspaceRoot),
        }
      );
      const parsed = parseCopilotPromptProbe(probe.combined);
      return {
        client_id: status.client_id,
        display_name: status.display_name,
        office_agent_id: status.office_agent_id,
        available: true,
        runtime_probed: true,
        connected: parsed.connected,
        status:
          probe.status === 0
            ? "connected"
            : probe.timed_out && parsed.status === "configured"
              ? "configured"
              : parsed.status,
        detail:
          parsed.status === "disconnected"
            ? parsed.detail
            : probe.timed_out
              ? "Copilot CLI auth probe timed out before returning a definitive result."
            : probe.status === 0
            ? "Copilot CLI is authenticated and accepted a non-interactive probe."
            : probe.error
              ? `Copilot CLI probe failed: ${probe.error}`
              : parsed.detail,
        notes: status.notes,
        command: "copilot -p \"Respond with OK\" --allow-all-tools --output-format json --stream off --reasoning-effort low",
        config_path: status.config_path,
      } satisfies ProviderBridgeDiagnostic;
    }
    return {
      client_id: status.client_id,
      display_name: status.display_name,
      office_agent_id: status.office_agent_id,
      available: status.binary_present || status.config_present,
      runtime_probed: false,
      connected: null,
      status: status.installed ? "configured" : "unavailable",
      detail: status.installed
        ? "Bridge is configured."
        : "Bridge is not configured for this client on this host.",
      notes: status.notes,
      command: null,
      config_path: status.config_path,
    } satisfies ProviderBridgeDiagnostic;
  });
}

export function resolveProviderBridgeDiagnostics(
  input: {
    workspace_root?: string;
    transport?: "auto" | "http" | "stdio";
    http_url?: string;
    http_origin?: string;
    stdio_command?: string;
    stdio_args?: string[];
    db_path?: string;
    server_name?: string;
    bypass_cache?: boolean;
    probe_timeout_ms?: number;
  } = {}
) {
  const { workspaceRoot, transport, serverName, cacheKey } = providerBridgeDiagnosticsCacheKey(input);
  const cached = providerBridgeDiagnosticCache.get(cacheKey);
  const ttlMs = providerBridgeDiagnosticsCacheTtlMs();
  const cachedIsFresh = Boolean(cached && Date.now() - cached.captured_at <= ttlMs);
  const refreshStaleCacheLive = Boolean(!input.bypass_cache && cached && !cachedIsFresh && !isHttpServing());
  if (!input.bypass_cache && cached && Date.now() - cached.captured_at <= ttlMs) {
    return {
      generated_at: new Date(cached.captured_at).toISOString(),
      cached: true,
      stale: false,
      diagnostics: cached.diagnostics,
    };
  }
  // If we have stale cache and caller did not explicitly request live probes,
  // return the stale entry immediately so the HTTP server is never blocked by
  // synchronous CLI probes on the request path.
  if (!input.bypass_cache && cached) {
    if (!refreshStaleCacheLive) {
      return {
        generated_at: new Date(cached.captured_at).toISOString(),
        cached: true,
        stale: true,
        diagnostics: cached.diagnostics,
      };
    }
  }
  const statuses = input.bypass_cache || refreshStaleCacheLive
    ? buildClientStatuses(workspaceRoot, transport, serverName)
    : buildClientStatusesCached(workspaceRoot, transport, serverName);
  if (input.bypass_cache || refreshStaleCacheLive) {
    cacheProviderBridgeStatuses(workspaceRoot, transport, serverName, statuses);
  }
  const diagnostics = runProviderDiagnostics(workspaceRoot, serverName, statuses, input.probe_timeout_ms ?? 5000);
  providerBridgeDiagnosticCache.set(cacheKey, {
    captured_at: Date.now(),
    diagnostics,
  });
  return {
    generated_at: new Date().toISOString(),
    cached: false,
    stale: false,
    diagnostics,
  };
}

function mergeJsonServer(
  filePath: string,
  serverName: string,
  entry: Record<string, unknown>,
  options?: { removeLegacyServerNames?: string[] }
) {
  const parsed = readJsonFile(filePath) as Record<string, unknown>;
  const current = parsed.mcpServers;
  const mcpServers =
    current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const legacyServerName of options?.removeLegacyServerNames ?? []) {
    if (legacyServerName && legacyServerName !== serverName) {
      delete mcpServers[legacyServerName];
    }
  }
  mcpServers[serverName] = entry;
  writeJsonFile(filePath, {
    ...parsed,
    mcpServers,
  });
}

function installCodex(serverName: string) {
  const result = spawnSync(path.join(repoRoot, "scripts", "codex_mcp_register.sh"), [serverName], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "codex_mcp_register.sh failed");
  }
  return {
    client_id: "codex",
    install_mode: "cli",
    transport_used: "stdio",
    output: result.stdout?.trim() || null,
  };
}

function installClaudeCli(
  serverName: string,
  config: ProviderBridgeTransportConfig,
  workspaceRoot: string
) {
  const env = buildProviderProbeEnv(workspaceRoot);
  runCommandProbe("claude", ["mcp", "remove", "-s", "user", serverName], {
    cwd: workspaceRoot,
    timeout: 5000,
    env,
  });
  const addArgs =
    config.mode === "http"
      ? [
          "mcp",
          "add",
          "-s",
          "user",
          "-t",
          "http",
          serverName,
          config.url,
          "-H",
          `Origin: ${config.origin}`,
          "-H",
          `Authorization: Bearer ${config.bearer_token}`,
        ]
      : [
          "mcp",
          "add-json",
          "-s",
          "user",
          serverName,
          JSON.stringify(buildClaudeCliStdioEntry(config, workspaceRoot, true)),
        ];
  const result = runCommandProbe("claude", addArgs, {
    cwd: workspaceRoot,
    timeout: 10000,
    env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "claude mcp add failed");
  }
  return {
    client_id: "claude-cli",
    install_mode: "cli",
    transport_used: config.mode,
    config_path: resolveClientConfigPaths(workspaceRoot).claude,
    output: result.stdout?.trim() || result.combined.trim() || null,
  };
}

function selectClients(inputClients: ProviderBridgeClientId[] | undefined) {
  return inputClients?.length ? [...new Set(inputClients)] : defaultProviderClients.slice();
}

function ensureHttpInstallable(config: ProviderBridgeTransportConfig) {
  if (config.mode === "http" && !config.bearer_token) {
    throw new Error("HTTP provider bridge install/export requires MCP_HTTP_BEARER_TOKEN to be set");
  }
}

function writeBundle(
  outputDir: string,
  selectedClients: ProviderBridgeClientId[],
  serverName: string,
  transport: ProviderBridgeTransportConfig,
  requestedTransport: "auto" | "http" | "stdio",
  includeBearerToken: boolean,
  workspaceRoot: string,
  status: ProviderBridgeClientStatus[]
) {
  fs.mkdirSync(outputDir, { recursive: true });
  const snippets: Record<string, string> = {};
  const claudeTransport = resolveClientTransportConfig("claude-cli", transport, requestedTransport);
  const cursorTransport = resolveClientTransportConfig("cursor", transport, requestedTransport);
  const geminiTransport = resolveClientTransportConfig("gemini-cli", transport, requestedTransport);
  const copilotTransport = resolveClientTransportConfig("github-copilot-cli", transport, requestedTransport);
  const vscodeTransport = resolveClientTransportConfig("github-copilot-vscode", transport, requestedTransport);
  const cursorEntry = buildCursorOrGeminiEntry(cursorTransport, serverName, includeBearerToken);
  const geminiEntry = buildGeminiEntry(geminiTransport, serverName, includeBearerToken, workspaceRoot);
  const copilotCliEntry = buildCopilotCliEntry(copilotTransport, serverName, includeBearerToken);
  const vscodeEntry = buildVsCodeEntry(vscodeTransport, serverName, includeBearerToken);
  const configPaths = resolveClientConfigPaths(workspaceRoot);

  if (selectedClients.includes("claude-cli")) {
    const filePath = path.join(outputDir, "claude-cli-mcp-add.sh");
    ensureDirForFile(filePath);
    fs.writeFileSync(
      filePath,
      `${buildClaudeCliInstallScript(claudeTransport, serverName, includeBearerToken, workspaceRoot)}\n`,
      "utf8"
    );
    fs.chmodSync(filePath, 0o755);
    snippets["claude-cli"] = filePath;
  }
  if (selectedClients.includes("cursor")) {
    const filePath = path.join(outputDir, "cursor-mcp.json");
    writeJsonFile(filePath, {
      mcpServers: {
        [serverName]: cursorEntry,
      },
    });
    snippets.cursor = filePath;
    const workspaceFilePath = path.join(outputDir, "cursor-workspace-mcp.json");
    writeJsonFile(workspaceFilePath, {
      mcpServers: {
        [serverName]: cursorEntry,
      },
    });
    snippets["cursor-workspace"] = workspaceFilePath;
  }
  if (selectedClients.includes("gemini-cli")) {
    const filePath = path.join(outputDir, "gemini-settings.json");
    writeJsonFile(filePath, {
      mcpServers: {
        [serverName]: geminiEntry,
      },
    });
    snippets["gemini-cli"] = filePath;
  }
  if (selectedClients.includes("github-copilot-cli")) {
    const filePath = path.join(outputDir, "github-copilot-cli-mcp-config.json");
    writeJsonFile(filePath, {
      mcpServers: {
        [serverName]: copilotCliEntry,
      },
    });
    snippets["github-copilot-cli"] = filePath;
  }
  if (selectedClients.includes("github-copilot-vscode")) {
    const filePath = path.join(outputDir, "vscode-mcp.json");
    writeJsonFile(filePath, vscodeEntry);
    snippets["github-copilot-vscode"] = filePath;
  }
  if (selectedClients.includes("codex")) {
    const filePath = path.join(outputDir, "codex-register.sh");
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `cd "${repoRoot}"`,
      `./scripts/codex_mcp_register.sh "${serverName}"`,
    ].join("\n");
    ensureDirForFile(filePath);
    fs.writeFileSync(filePath, `${script}\n`, "utf8");
    fs.chmodSync(filePath, 0o755);
    snippets.codex = filePath;
  }
  if (selectedClients.includes("chatgpt-developer-mode")) {
    const filePath = path.join(outputDir, "chatgpt-developer-mode.md");
    const body = [
      "# ChatGPT Developer Mode MCP Bridge",
      "",
      "This client is export-only from this repo.",
      "",
      `Canonical ingress tool: \`autonomy.ide_ingress\``,
      `Preferred shared transport: \`${transport.mode}\``,
      "",
      "Important boundary:",
      "- ChatGPT/OpenAI custom MCP requires a remote MCP server path and internet connectivity.",
      "- Do not present this as a pure local-only client bridge.",
      "",
      "Use the local HTTP daemon as the truth source first, then expose a remote MCP facade only if you intentionally open that surface.",
    ].join("\n");
    ensureDirForFile(filePath);
    fs.writeFileSync(filePath, `${body}\n`, "utf8");
    snippets["chatgpt-developer-mode"] = filePath;
  }

  const ingressFile = path.join(outputDir, "canonical-autonomy-ingress.md");
  const ingressDoc = [
    "# Canonical Autonomy Ingress",
    "",
    "All IDE/operator objectives should enter the system through `autonomy.ide_ingress`.",
    "",
    `Local-first IDE council: ${resolveLocalFirstAgents().join(", ")}`,
    "",
    "Why this is the canonical lane:",
    "- transcript continuity",
    "- office thread mirroring",
    "- durable goal/plan creation",
    "- background execution through the same autonomy command path",
    "",
    "Do not invent a second ingress workflow.",
  ].join("\n");
  fs.writeFileSync(ingressFile, `${ingressDoc}\n`, "utf8");

  const manifestPath = path.join(outputDir, "provider-bridge-manifest.json");
  writeJsonFile(manifestPath, {
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    workspace_root: workspaceRoot,
    canonical_ingress_tool: "autonomy.ide_ingress",
    local_first_ide_agent_ids: resolveLocalFirstAgents(),
    server_name: serverName,
    transport: transport.mode,
    http_url: transport.url,
    http_origin: transport.origin,
    selected_clients: selectedClients,
    client_status: status.filter((entry) => selectedClients.includes(entry.client_id)),
    config_paths: configPaths,
    snippets,
    ingress_doc: ingressFile,
  });
  return {
    output_dir: outputDir,
    manifest_path: manifestPath,
    snippets,
    ingress_doc: ingressFile,
  };
}

export async function providerBridge(
  _storage: Storage,
  input: z.infer<typeof providerBridgeSchema>
) {
  const execute = async () => {
    let snapshot = resolveProviderBridgeSnapshot({
      storage: _storage,
      workspace_root: input.workspace_root,
      transport: input.transport,
      http_url: input.http_url,
      http_origin: input.http_origin,
      stdio_command: input.stdio_command,
      stdio_args: input.stdio_args,
      db_path: input.db_path,
      server_name: input.server_name,
    });
    const workspaceRoot = snapshot.workspace_root;
    const transport = resolveTransportConfig(input);
    const serverName = snapshot.server_name;
    const clients = selectClients(input.clients);
    const status = snapshot.clients;
    const selectedStatus = status.filter((entry) => clients.includes(entry.client_id));
    const selectedRouterBackends = snapshot.router_backend_candidates.filter((entry) => clients.includes(entry.client_id));
    const forceLive = input.force_live === true;
    const forceLiveHttpRejection = () => ({
      ok: false,
      error: "force_live is not available over HTTP transport. Use the default cached diagnostics, or run force_live over stdio.",
      hint: "Remove force_live or connect via stdio to run live probes without blocking the HTTP server.",
    });

    if (input.action === "status") {
      if (forceLive && isHttpServing()) {
        return forceLiveHttpRejection();
      }
      let diagnostics = forceLive
        ? resolveProviderBridgeDiagnostics({
            workspace_root: input.workspace_root,
            transport: input.transport,
            http_url: input.http_url,
            http_origin: input.http_origin,
            stdio_command: input.stdio_command,
            stdio_args: input.stdio_args,
            db_path: input.db_path,
            server_name: input.server_name,
            probe_timeout_ms: input.probe_timeout_ms,
            bypass_cache: true,
          })
        : resolveProviderBridgeDiagnosticsCached({
            workspace_root: input.workspace_root,
            transport: input.transport,
            http_url: input.http_url,
            http_origin: input.http_origin,
            stdio_command: input.stdio_command,
            stdio_args: input.stdio_args,
            db_path: input.db_path,
            server_name: input.server_name,
            probe_timeout_ms: input.probe_timeout_ms,
          });
      diagnostics = preferProviderBridgeDiagnostics(diagnostics, resolvePersistedProviderBridgeDiagnostics(_storage));
      if (!forceLive && allowSyncCliProbe() && (diagnostics.stale === true || diagnostics.diagnostics.length === 0)) {
        diagnostics = resolveProviderBridgeDiagnostics({
          workspace_root: input.workspace_root,
          transport: input.transport,
          http_url: input.http_url,
          http_origin: input.http_origin,
          stdio_command: input.stdio_command,
          stdio_args: input.stdio_args,
          db_path: input.db_path,
          server_name: input.server_name,
          probe_timeout_ms: input.probe_timeout_ms,
        });
        diagnostics = preferProviderBridgeDiagnostics(diagnostics, resolvePersistedProviderBridgeDiagnostics(_storage));
        snapshot = resolveProviderBridgeSnapshot({
          storage: _storage,
          workspace_root: input.workspace_root,
          transport: input.transport,
          http_url: input.http_url,
          http_origin: input.http_origin,
          stdio_command: input.stdio_command,
          stdio_args: input.stdio_args,
          db_path: input.db_path,
          server_name: input.server_name,
        });
      }
      const truthySnapshot = applyProviderBridgeDiagnosticsToSnapshot(snapshot, diagnostics);
      const selectedStatus = truthySnapshot.clients.filter((entry) => clients.includes(entry.client_id));
      const selectedDiagnostics = diagnostics.diagnostics.filter((entry) => clients.includes(entry.client_id));
      const selectedRouterBackends = truthySnapshot.router_backend_candidates.filter((entry) => clients.includes(entry.client_id));
      const onboarding = buildProviderBridgeOnboardingSummary({
        clients: selectedStatus,
        diagnostics: selectedDiagnostics,
        server_name: serverName,
        generated_at: diagnostics.generated_at,
        diagnostics_stale: diagnostics.stale ?? false,
      });
      return {
        ok: true,
        canonical_ingress_tool: truthySnapshot.canonical_ingress_tool,
        local_first_ide_agent_ids: truthySnapshot.local_first_ide_agent_ids,
        workspace_root: truthySnapshot.workspace_root,
        server_name: truthySnapshot.server_name,
        transport: truthySnapshot.transport,
        resource_gate: truthySnapshot.resource_gate,
        outbound_council_agents: truthySnapshot.outbound_council_agents.filter((entry) => clients.includes(entry.client_id)),
        router_backend_candidates: selectedRouterBackends,
        eligible_router_backends: selectedRouterBackends.filter((entry) => entry.eligible).map((entry) => entry.backend),
        clients: selectedStatus,
        diagnostics: selectedDiagnostics,
        diagnostics_generated_at: diagnostics.generated_at,
        diagnostics_stale: diagnostics.stale ?? false,
        onboarding,
      };
    }

    if (input.action === "diagnose") {
      // Reject force_live over HTTP to prevent synchronous CLI probes from
      // wedging the single-threaded HTTP server (/health, /ready, other MCP
      // sessions).  Callers should use the default cached path or run
      // force_live over stdio where blocking is acceptable.
      if (forceLive && isHttpServing()) {
        return forceLiveHttpRejection();
      }
      const diagnostics = resolveProviderBridgeDiagnostics({
        workspace_root: input.workspace_root,
        transport: input.transport,
        http_url: input.http_url,
        http_origin: input.http_origin,
        stdio_command: input.stdio_command,
        stdio_args: input.stdio_args,
        db_path: input.db_path,
        server_name: input.server_name,
        bypass_cache: forceLive,
        probe_timeout_ms: input.probe_timeout_ms,
      });
      if (diagnostics.cached === false) {
        snapshot = resolveProviderBridgeSnapshot({
          storage: _storage,
          workspace_root: input.workspace_root,
          transport: input.transport,
          http_url: input.http_url,
          http_origin: input.http_origin,
          stdio_command: input.stdio_command,
          stdio_args: input.stdio_args,
          db_path: input.db_path,
          server_name: input.server_name,
        });
      }
      const selectedStatus = snapshot.clients.filter((entry) => clients.includes(entry.client_id));
      const selectedDiagnostics = diagnostics.diagnostics.filter((entry) => clients.includes(entry.client_id));
      const onboarding = buildProviderBridgeOnboardingSummary({
        clients: selectedStatus,
        diagnostics: selectedDiagnostics,
        server_name: serverName,
        generated_at: diagnostics.generated_at,
        diagnostics_stale: diagnostics.stale ?? false,
      });
      return {
        ok: true,
        canonical_ingress_tool: snapshot.canonical_ingress_tool,
        workspace_root: snapshot.workspace_root,
        server_name: snapshot.server_name,
        generated_at: diagnostics.generated_at,
        cached: diagnostics.cached,
        stale: diagnostics.stale ?? false,
        resource_gate: snapshot.resource_gate,
        diagnostics: selectedDiagnostics,
        clients: selectedStatus,
        onboarding,
      };
    }

    if (input.action === "export_bundle") {
      if (transport.mode === "http") {
        ensureHttpInstallable(transport);
      }
      const outputDir =
        input.output_dir?.trim() || path.join(repoRoot, "data", "exports", "provider-bridge", timestampForPath());
      const bundle = writeBundle(
        outputDir,
        clients,
        serverName,
        transport,
        input.transport,
        input.include_bearer_token === true,
        workspaceRoot,
        status
      );
      return {
        ok: true,
        canonical_ingress_tool: snapshot.canonical_ingress_tool,
        local_first_ide_agent_ids: snapshot.local_first_ide_agent_ids,
        server_name: serverName,
        transport: transport.mode,
        resource_gate: snapshot.resource_gate,
        bundle,
        router_backend_candidates: selectedRouterBackends,
        clients: selectedStatus,
        onboarding: buildProviderBridgeOnboardingSummary({
          clients: selectedStatus,
          server_name: serverName,
        }),
      };
    }

    if (transport.mode === "http") {
      ensureHttpInstallable(transport);
    }

    const configPaths = resolveClientConfigPaths(workspaceRoot);
    const installs: Array<Record<string, unknown>> = [];
    for (const client of clients) {
      if (client === "codex") {
        installs.push(installCodex(serverName));
        continue;
      }
      if (client === "claude-cli") {
        const clientTransport = resolveClientTransportConfig(client, transport, input.transport);
        installs.push(installClaudeCli(serverName, clientTransport, workspaceRoot));
        continue;
      }
      if (client === "cursor") {
        const clientTransport = resolveClientTransportConfig(client, transport, input.transport);
        mergeJsonServer(configPaths.cursor, serverName, buildCursorOrGeminiEntry(clientTransport, serverName, true), {
          removeLegacyServerNames: legacyProviderServerNames,
        });
        mergeJsonServer(
          configPaths.cursorWorkspace,
          serverName,
          buildCursorOrGeminiEntry(clientTransport, serverName, true),
          {
            removeLegacyServerNames: legacyProviderServerNames,
          }
        );
        installs.push({
          client_id: client,
          config_path: configPaths.cursor,
          workspace_config_path: configPaths.cursorWorkspace,
          transport_used: clientTransport.mode,
        });
        continue;
      }
      if (client === "gemini-cli") {
        const clientTransport = resolveClientTransportConfig(client, transport, input.transport);
        mergeJsonServer(configPaths.gemini, serverName, buildGeminiEntry(clientTransport, serverName, true, workspaceRoot));
        installs.push({
          client_id: client,
          config_path: configPaths.gemini,
          transport_used: clientTransport.mode,
        });
        continue;
      }
      if (client === "github-copilot-cli") {
        const clientTransport = resolveClientTransportConfig(client, transport, input.transport);
        mergeJsonServer(configPaths.copilotCli, serverName, buildCopilotCliEntry(clientTransport, serverName, true));
        installs.push({
          client_id: client,
          config_path: configPaths.copilotCli,
          transport_used: clientTransport.mode,
        });
        continue;
      }
      if (client === "github-copilot-vscode") {
        const clientTransport = resolveClientTransportConfig(client, transport, input.transport);
        writeJsonFile(configPaths.vscode, buildVsCodeEntry(clientTransport, serverName, true));
        installs.push({
          client_id: client,
          config_path: configPaths.vscode,
          transport_used: clientTransport.mode,
        });
        continue;
      }
      installs.push({
        client_id: client,
        skipped: true,
        reason: "remote-only client; export a manifest instead of pretending local install exists",
      });
    }

    // Invalidate status cache after install so subsequent status/diagnose calls
    // pick up the freshly installed config.
    providerBridgeStatusCache.clear();
    const postInstallSnapshot = resolveProviderBridgeSnapshot({
      storage: _storage,
      workspace_root: input.workspace_root,
      transport: input.transport,
      http_url: input.http_url,
      http_origin: input.http_origin,
      stdio_command: input.stdio_command,
      stdio_args: input.stdio_args,
      db_path: input.db_path,
      server_name: input.server_name,
    });
    const postInstallStatus = postInstallSnapshot.clients.filter((entry) => clients.includes(entry.client_id));
    return {
      ok: true,
      canonical_ingress_tool: postInstallSnapshot.canonical_ingress_tool,
      local_first_ide_agent_ids: postInstallSnapshot.local_first_ide_agent_ids,
      server_name: serverName,
      transport: transport.mode,
      resource_gate: postInstallSnapshot.resource_gate,
      installs,
      router_backend_candidates: postInstallSnapshot.router_backend_candidates.filter((entry) => clients.includes(entry.client_id)),
      clients: postInstallStatus,
      onboarding: buildProviderBridgeOnboardingSummary({
        clients: postInstallStatus,
        server_name: serverName,
      }),
    };
  };

  if (input.action === "status" || input.action === "diagnose") {
    return execute();
  }
  return runIdempotentMutation({
    storage: _storage,
    tool_name: "provider.bridge",
    mutation: input.mutation!,
    payload: input,
    execute,
  });
}
