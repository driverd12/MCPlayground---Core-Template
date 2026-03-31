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
    action: z.enum(["status", "export_bundle", "install"]).default("status"),
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
    provider: "openai" | "google" | "cursor" | "github-copilot" | "custom";
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
const defaultLocalFirstAgents = [
  "implementation-director",
  "research-director",
  "verification-director",
  "local-imprint",
];
const defaultProviderClients: ProviderBridgeClientId[] = [
  "codex",
  "cursor",
  "github-copilot-cli",
  "github-copilot-vscode",
  "gemini-cli",
  "chatgpt-developer-mode",
];

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
  const bearerToken = String(process.env.MCP_HTTP_BEARER_TOKEN ?? "").trim();
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
    cursor: path.join(home, ".cursor", "mcp.json"),
    copilotCli: path.join(home, ".copilot", "mcp-config.json"),
    gemini: path.join(home, ".gemini", "settings.json"),
    vscode: path.join(workspaceRoot, ".vscode", "mcp.json"),
  };
}

function inferTaskKindsForBridgeAgent(agentId: string | null) {
  switch (agentId) {
    case "codex":
      return ["planning", "coding", "verification", "tool_use"];
    case "cursor":
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
  } else if (agentId === "cursor") {
    tags.add("coding");
    tags.add("implementer");
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

function buildStdioEntry(config: ProviderBridgeTransportConfig) {
  return {
    command: config.command,
    args: config.args,
    env: {
      ANAMNESIS_HUB_DB_PATH: config.db_path,
    },
  };
}

function buildCursorOrGeminiEntry(
  config: ProviderBridgeTransportConfig,
  serverName: string,
  includeBearerToken: boolean
) {
  return config.mode === "http" ? buildHttpEntry(config, serverName, includeBearerToken) : buildStdioEntry(config);
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
    cursor: "cursor",
    "gemini-cli": "gemini",
    "github-copilot-cli": null,
    "github-copilot-vscode": null,
    "chatgpt-developer-mode": null,
  };

  const notes = {
    codex: [
      "Best local install path is the existing Codex CLI MCP registration script.",
      "Outbound council consultation is available through bridges/codex_bridge.py.",
    ],
    cursor: [
      "Cursor can connect to the shared HTTP daemon or launch the server via stdio.",
      "Outbound council consultation is available through bridges/cursor_bridge.py.",
    ],
    "github-copilot-cli": [
      "Inbound MCP config is exportable/installable through ~/.copilot/mcp-config.json.",
      "There is no truthful local outbound council bridge for Copilot in this repo yet.",
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
      client_id: "cursor",
      display_name: "Cursor",
      install_mode: "json-config",
      config_path: configPaths.cursor,
      installed: jsonServerInstalled(configPaths.cursor, serverName),
      binary_present: commandExists("cursor") || fs.existsSync("/Applications/Cursor.app"),
      config_present: fs.existsSync(configPaths.cursor),
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
      install_mode: "json-config",
      config_path: configPaths.copilotCli,
      installed: jsonServerInstalled(configPaths.copilotCli, serverName),
      binary_present: commandExists("gh") && commandSucceeds("gh", ["copilot", "--help"]),
      config_present: fs.existsSync(configPaths.copilotCli),
      supported_transports: ["http", "stdio"],
      preferred_transport: transport.mode,
      inbound_mcp_supported: true,
      outbound_council_supported: false,
      outbound_agent_id: null,
      outbound_bridge_ready: false,
      requires_internet_for_model: true,
      notes: notes["github-copilot-cli"],
    },
    {
      client_id: "github-copilot-vscode",
      display_name: "GitHub Copilot Agent Mode (VS Code)",
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
      install_mode: "json-config",
      config_path: configPaths.gemini,
      installed: jsonServerInstalled(configPaths.gemini, serverName),
      binary_present: commandExists("gemini"),
      config_present: fs.existsSync(configPaths.gemini),
      supported_transports: ["http", "stdio"],
      preferred_transport: transport.mode,
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
  includeBearerToken: boolean,
  workspaceRoot: string,
  status: ProviderBridgeClientStatus[]
) {
  fs.mkdirSync(outputDir, { recursive: true });
  const snippets: Record<string, string> = {};
  const cursorGeminiEntry = buildCursorOrGeminiEntry(transport, serverName, includeBearerToken);
  const copilotCliEntry = buildCopilotCliEntry(transport, serverName, includeBearerToken);
  const vscodeEntry = buildVsCodeEntry(transport, serverName, includeBearerToken);
  const configPaths = resolveClientConfigPaths(workspaceRoot);

  if (selectedClients.includes("cursor")) {
    const filePath = path.join(outputDir, "cursor-mcp.json");
    writeJsonFile(filePath, {
      mcpServers: {
        [serverName]: cursorGeminiEntry,
      },
    });
    snippets.cursor = filePath;
  }
  if (selectedClients.includes("gemini-cli")) {
    const filePath = path.join(outputDir, "gemini-settings.json");
    writeJsonFile(filePath, {
      mcpServers: {
        [serverName]: cursorGeminiEntry,
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
      if (client === "cursor") {
        mergeJsonServer(configPaths.cursor, serverName, buildCursorOrGeminiEntry(transport, serverName, true));
        installs.push({
          client_id: client,
          config_path: configPaths.cursor,
          transport_used: transport.mode,
        });
        continue;
      }
      if (client === "gemini-cli") {
        mergeJsonServer(configPaths.gemini, serverName, buildCursorOrGeminiEntry(transport, serverName, true));
        installs.push({
          client_id: client,
          config_path: configPaths.gemini,
          transport_used: transport.mode,
        });
        continue;
      }
      if (client === "github-copilot-cli") {
        mergeJsonServer(configPaths.copilotCli, serverName, buildCopilotCliEntry(transport, serverName, true));
        installs.push({
          client_id: client,
          config_path: configPaths.copilotCli,
          transport_used: transport.mode,
        });
        continue;
      }
      if (client === "github-copilot-vscode") {
        writeJsonFile(configPaths.vscode, buildVsCodeEntry(transport, serverName, true));
        installs.push({
          client_id: client,
          config_path: configPaths.vscode,
          transport_used: transport.mode,
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

  if (input.action === "status") {
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
