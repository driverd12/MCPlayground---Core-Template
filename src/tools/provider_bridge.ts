import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Storage } from "../storage.js";
import { getTriChatAgent, getTriChatBridgeCandidates } from "../trichat_roster.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

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
    server_name: z.string().min(1).max(120).default("mcplayground"),
    output_dir: z.string().min(1).optional(),
    include_bearer_token: z.boolean().default(false),
    http_url: z.string().min(1).optional(),
    http_origin: z.string().min(1).optional(),
    stdio_command: z.string().min(1).optional(),
    stdio_args: z.array(z.string().min(1)).optional(),
    db_path: z.string().min(1).optional(),
    workspace_root: z.string().min(1).optional(),
    probe_timeout_ms: z.number().int().min(250).max(30000).optional(),
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
const providerBridgeDiagnosticCache = new Map<
  string,
  {
    captured_at: number;
    diagnostics: ProviderBridgeDiagnostic[];
  }
>();

function providerBridgeDiagnosticsCacheTtlMs() {
  const override = Number(process.env.PROVIDER_BRIDGE_DIAGNOSTICS_CACHE_SECONDS || "");
  if (Number.isFinite(override) && override > 0) {
    return Math.max(5_000, Math.round(override * 1000));
  }
  return 60_000;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function commandExists(command: string) {
  const result = spawnSync("which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function commandSucceeds(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runCommandProbe(
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
  const existingPath = env.PATH?.trim();
  const fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  env.HOME = home;
  env.SHELL = shell;
  env.TERM = env.TERM?.trim() || "xterm-256color";
  env.PWD = workspaceRoot;
  env.PATH = existingPath && existingPath.length > 0 ? existingPath : fallbackPath;
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
    timeout: 5000,
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

function resolveLocalFirstAgents() {
  const envAgents = String(process.env.TRICHAT_IDE_LOCAL_FIRST_AGENT_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return envAgents.length > 0 ? [...new Set(envAgents)] : defaultLocalFirstAgents.slice();
}

function hasGeminiApiAccess() {
  return Boolean(readEnvString("GEMINI_API_KEY") || readEnvString("GOOGLE_API_KEY"));
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
      return readEnvString("TRICHAT_GEMINI_MODEL") ?? (hasGeminiApiAccess() ? "gemini-2.0-flash" : "gemini-cli");
    case "github-copilot-cli":
    case "github-copilot-vscode":
      return "copilot";
    case "chatgpt-developer-mode":
      return readEnvString("TRICHAT_OPENAI_MODEL") ?? "chatgpt-developer-mode";
    default:
      return clientId;
  }
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
        runtimeReady
          ? null
          : status.client_id === "gemini-cli" && status.outbound_bridge_ready
            ? "missing gemini CLI binary and API key"
            : !status.outbound_bridge_ready
              ? "bridge adapter is not ready"
              : "required client runtime is missing";
      const agent = status.outbound_agent_id ? getTriChatAgent(status.outbound_agent_id) : null;
      const taskKinds = inferTaskKindsForBridgeAgent(status.outbound_agent_id);
      return {
        client_id: status.client_id,
        eligible: runtimeReady,
        reason,
        backend: {
          backend_id: `bridge-${status.client_id}`,
          provider: resolveBridgeBackendProvider(status.client_id),
          model_id: resolveBridgeModelId(status.client_id),
          endpoint: null,
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
            requires_internet_for_model: status.requires_internet_for_model,
          },
        },
      } satisfies ProviderBridgeRouterBackendCandidate;
    });
}

export function resolveProviderBridgeSnapshot(input: {
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
  const serverName = input.server_name?.trim() || "mcplayground";
  const clients = buildClientStatuses(workspaceRoot, transport, serverName);
  const routerBackendCandidates = buildRouterBackendCandidates(clients);
  return {
    canonical_ingress_tool: "autonomy.ide_ingress",
    local_first_ide_agent_ids: resolveLocalFirstAgents(),
    workspace_root: workspaceRoot,
    server_name: serverName,
    transport: transport.mode,
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

function buildCursorOrGeminiEntry(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean
) {
  return config.mode === "http" ? buildHttpEntry(config, serverName, includeBearerToken) : buildStdioEntry(config);
}

function buildClaudeCliStdioEntry(config: ProviderBridgeTransportConfig, workspaceRoot: string) {
  return {
    type: "stdio" as const,
    ...buildStdioEntry(config, {
      cwd: workspaceRoot,
    }),
  };
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
      JSON.stringify(buildClaudeCliStdioEntry(config, workspaceRoot))
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
      description: "MCPlayground MCP server",
      ...buildHttpEntry(config, serverName, includeBearerToken),
    };
  }
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [providerStdioBridgePath],
    env: {
      MCP_PROXY_HTTP_URL: config.url,
      MCP_PROXY_HTTP_ORIGIN: config.origin,
      ...(includeBearerToken && config.bearer_token
        ? { MCP_PROXY_HTTP_BEARER_TOKEN: config.bearer_token }
        : config.bearer_token
          ? { MCP_PROXY_HTTP_BEARER_TOKEN: "<set MCP_HTTP_BEARER_TOKEN>" }
          : {}),
    },
    cwd: workspaceRoot,
    timeout: 600000,
    trust: true,
    description: "MCPlayground MCP HTTP proxy",
  };
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
    "github-copilot-cli": "github-copilot",
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
    ],
    "github-copilot-cli": [
      "Inbound MCP config is exportable/installable through ~/.copilot/mcp-config.json.",
      "The current official CLI installs as `copilot`; older `gh copilot` extension installs are still detected.",
      "Outbound council consultation is available through bridges/copilot_bridge.py.",
      "The outbound bridge disables MCP servers for the council prompt path because Copilot rejects the full local tool catalog shape.",
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
      outbound_council_supported: true,
      outbound_agent_id: rosterAgentIds["github-copilot-cli"],
      outbound_bridge_ready: resolveOutboundBridgeReady(rosterAgentIds["github-copilot-cli"]),
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
      requires_internet_for_model: true,
      notes: notes["chatgpt-developer-mode"],
    },
  ];
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
          command: "claude mcp get mcplayground && claude auth status",
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
        command: "claude mcp get mcplayground + claude auth status",
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
      const notes = [...status.notes];
      if (configSummary.mode === "http" && hasHttpConfiguredServer(status.config_path ?? "", serverName)) {
        notes.push("Gemini CLI is configured over HTTP here; this repo prefers stdio for Gemini because it is more reliable.");
      }
      if (configSummary.valid && oauth.connected) {
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
          command: "stateful config + oauth heartbeat",
          config_path: status.config_path,
        } satisfies ProviderBridgeDiagnostic;
      }
      if (configSummary.valid) {
        return {
          client_id: status.client_id,
          display_name: status.display_name,
          office_agent_id: status.office_agent_id,
          available: true,
          runtime_probed: true,
          connected: false,
          status: oauth.available ? "disconnected" : "configured",
          detail: oauth.detail,
          notes,
          command: "stateful config + oauth heartbeat",
          config_path: status.config_path,
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
  const serverName = input.server_name?.trim() || "mcplayground";
  const cacheKey = JSON.stringify({
    workspaceRoot,
    serverName,
    transport: transport.mode,
    command: transport.command,
    args: transport.args,
    url: transport.url,
    probeTimeoutMs: input.probe_timeout_ms ?? 5000,
  });
  const cached = providerBridgeDiagnosticCache.get(cacheKey);
  if (!input.bypass_cache && cached && Date.now() - cached.captured_at <= providerBridgeDiagnosticsCacheTtlMs()) {
    return {
      generated_at: new Date(cached.captured_at).toISOString(),
      cached: true,
      diagnostics: cached.diagnostics,
    };
  }
  const statuses = buildClientStatuses(workspaceRoot, transport, serverName);
  const diagnostics = runProviderDiagnostics(workspaceRoot, serverName, statuses, input.probe_timeout_ms ?? 5000);
  providerBridgeDiagnosticCache.set(cacheKey, {
    captured_at: Date.now(),
    diagnostics,
  });
  return {
    generated_at: new Date().toISOString(),
    cached: false,
    diagnostics,
  };
}

function mergeJsonServer(filePath: string, serverName: string, entry: Record<string, unknown>) {
  const parsed = readJsonFile(filePath) as Record<string, unknown>;
  const current = parsed.mcpServers;
  const mcpServers =
    current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
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
          JSON.stringify(buildClaudeCliStdioEntry(config, workspaceRoot)),
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
    const snapshot = resolveProviderBridgeSnapshot({
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

    if (input.action === "status") {
      return {
        ok: true,
        canonical_ingress_tool: snapshot.canonical_ingress_tool,
        local_first_ide_agent_ids: snapshot.local_first_ide_agent_ids,
        workspace_root: snapshot.workspace_root,
        server_name: snapshot.server_name,
        transport: snapshot.transport,
        outbound_council_agents: snapshot.outbound_council_agents,
        router_backend_candidates: selectedRouterBackends,
        eligible_router_backends: selectedRouterBackends.filter((entry) => entry.eligible).map((entry) => entry.backend),
        clients: selectedStatus,
      };
    }

    if (input.action === "diagnose") {
      const diagnostics = resolveProviderBridgeDiagnostics({
        workspace_root: input.workspace_root,
        transport: input.transport,
        http_url: input.http_url,
        http_origin: input.http_origin,
        stdio_command: input.stdio_command,
        stdio_args: input.stdio_args,
        db_path: input.db_path,
        server_name: input.server_name,
        bypass_cache: true,
        probe_timeout_ms: input.probe_timeout_ms,
      });
      return {
        ok: true,
        canonical_ingress_tool: snapshot.canonical_ingress_tool,
        workspace_root: snapshot.workspace_root,
        server_name: snapshot.server_name,
        generated_at: diagnostics.generated_at,
        cached: diagnostics.cached,
        diagnostics: diagnostics.diagnostics.filter((entry) => clients.includes(entry.client_id)),
        clients: selectedStatus,
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
        bundle,
        router_backend_candidates: selectedRouterBackends,
        clients: selectedStatus,
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
        mergeJsonServer(configPaths.cursor, serverName, buildCursorOrGeminiEntry(clientTransport, serverName, true));
        mergeJsonServer(configPaths.cursorWorkspace, serverName, buildCursorOrGeminiEntry(clientTransport, serverName, true));
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

    const postInstallStatus = buildClientStatuses(workspaceRoot, transport, serverName).filter((entry) =>
      clients.includes(entry.client_id)
    );
    return {
      ok: true,
      canonical_ingress_tool: snapshot.canonical_ingress_tool,
      local_first_ide_agent_ids: snapshot.local_first_ide_agent_ids,
      server_name: serverName,
      transport: transport.mode,
      installs,
      router_backend_candidates: selectedRouterBackends,
      clients: postInstallStatus,
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
