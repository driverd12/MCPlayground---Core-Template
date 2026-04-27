import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCommandProbe } from "../dist/tools/provider_bridge.js";
import { getTriChatBridgeCandidates, getTriChatBridgeEnvVar } from "../dist/trichat_roster.js";
import { fetchHttpText, reservePort, stopChildProcess } from "./test_process_helpers.mjs";

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.cwd();

test(
  "provider.bridge hard-kills timed out CLI probes so hung clients cannot freeze the server loop",
  { concurrency: false, timeout: 10_000 },
  () => {
    const startedAt = Date.now();
    const probe = runCommandProbe(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { timeout: 100 }
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(probe.timed_out, true);
    assert.equal(probe.signal, "SIGKILL");
    assert.ok(elapsedMs < 3_000, `expected bounded probe time, saw ${elapsedMs}ms`);
  }
);

test("provider.bridge status trusts Claude config state without shelling out to a hanging CLI probe", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-claude-config-shortcut-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  createFakeClaudeCli(path.join(binDir, "claude"));
  fs.writeFileSync(
    path.join(homeDir, ".claude.json"),
    JSON.stringify(
      {
        mcpServers: {
          "master-mold": {
            type: "http",
            url: "http://127.0.0.1:8787/",
          },
        },
      },
      null,
      2
    )
  );

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    CLAUDE_HANG_MCP_GET: "1",
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-shortcut-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const startedAt = Date.now();
    const status = await callTool(session.client, "provider.bridge", {
      action: "status",
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(status.ok, true);
    assert.equal(status.clients.find((entry) => entry.client_id === "claude-cli")?.installed, true);
    assert.ok(elapsedMs < 2_000, `expected Claude config shortcut, saw ${elapsedMs}ms`);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge reports truthful client and outbound council coverage", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-status-"));
  const homeDir = path.join(tempDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-test-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const status = await callTool(session.client, "provider.bridge", {
      action: "status",
    });

    assert.equal(status.ok, true);
    assert.equal(status.canonical_ingress_tool, "autonomy.ide_ingress");
    assert.deepEqual(status.local_first_ide_agent_ids, [
      "implementation-director",
      "research-director",
      "verification-director",
      "local-imprint",
    ]);

    const clients = new Map(status.clients.map((entry) => [entry.client_id, entry]));
    assert.equal(clients.get("claude-cli")?.outbound_council_supported, true);
    assert.equal(clients.get("claude-cli")?.outbound_bridge_ready, true);
    assert.equal(clients.get("cursor")?.outbound_council_supported, true);
    assert.equal(clients.get("cursor")?.outbound_bridge_ready, true);
    assert.equal(clients.get("gemini-cli")?.outbound_council_supported, true);
    assert.equal(clients.get("github-copilot-cli")?.inbound_mcp_supported, true);
    assert.equal(clients.get("github-copilot-cli")?.outbound_council_supported, false);
    assert.equal(clients.get("github-copilot-cli")?.outbound_agent_id, null);
    assert.equal(clients.get("github-copilot-cli")?.outbound_bridge_ready, false);
    assert.equal(getTriChatBridgeEnvVar("github-copilot"), null);
    assert.deepEqual(getTriChatBridgeCandidates(REPO_ROOT, "github-copilot"), []);
    assert.equal(clients.get("chatgpt-developer-mode")?.install_mode, "remote-only");
    assert.equal(status.onboarding.recommended_doctor_command, "npm run bootstrap:env:check");
    assert.equal(status.onboarding.recommended_status_command, "npm run providers:status");
    const onboardingEntries = new Map(status.onboarding.entries.map((entry) => [entry.client_id, entry]));
    assert.equal(onboardingEntries.get("chatgpt-developer-mode")?.runtime_status, "remote_only");
    assert.equal(onboardingEntries.get("chatgpt-developer-mode")?.next_command, "npm run providers:export");
    assert.equal(typeof onboardingEntries.get("claude-cli")?.next_action, "string");

    const routerCandidates = new Map(status.router_backend_candidates.map((entry) => [entry.client_id, entry]));
    assert.ok(routerCandidates.has("codex"));
    assert.ok(routerCandidates.has("claude-cli"));
    assert.ok(routerCandidates.has("cursor"));
    assert.ok(routerCandidates.has("gemini-cli"));
    assert.equal(routerCandidates.has("github-copilot-cli"), false);
    assert.equal(routerCandidates.get("codex")?.backend.metadata.bridge_agent_id, "codex");
    assert.equal(routerCandidates.get("claude-cli")?.backend.provider, "anthropic");
    assert.equal(typeof routerCandidates.get("gemini-cli")?.eligible, "boolean");
    assert.ok(
      status.eligible_router_backends.every((entry) =>
        ["openai", "google", "anthropic", "cursor", "custom"].includes(entry.provider)
      )
    );
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge export_bundle and install create real client config artifacts", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-export-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  const workspaceRoot = path.join(tempDir, "workspace");
  const exportDir = path.join(tempDir, "exports");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  createFakeClaudeCli(path.join(binDir, "claude"));

  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-install-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const exported = await callTool(session.client, "provider.bridge", {
      action: "export_bundle",
      mutation: nextMutation("provider-bridge", "export", () => mutationCounter++),
      transport: "http",
      output_dir: exportDir,
      workspace_root: workspaceRoot,
      clients: ["claude-cli", "cursor", "gemini-cli", "github-copilot-cli", "github-copilot-vscode", "chatgpt-developer-mode"],
    });

    assert.equal(exported.ok, true);
    assert.equal(exported.bundle.output_dir, exportDir);
    assert.equal(fs.existsSync(exported.bundle.manifest_path), true);
    assert.equal(fs.existsSync(exported.bundle.snippets["claude-cli"]), true);
    assert.equal(fs.existsSync(exported.bundle.snippets.cursor), true);
    assert.equal(fs.existsSync(exported.bundle.snippets["gemini-cli"]), true);
    assert.equal(fs.existsSync(exported.bundle.snippets["github-copilot-cli"]), true);
    assert.equal(fs.existsSync(exported.bundle.snippets["github-copilot-vscode"]), true);
    assert.equal(fs.existsSync(exported.bundle.snippets["chatgpt-developer-mode"]), true);

    const installed = await callTool(session.client, "provider.bridge", {
      action: "install",
      mutation: nextMutation("provider-bridge", "install", () => mutationCounter++),
      transport: "http",
      workspace_root: workspaceRoot,
      clients: ["claude-cli", "cursor", "gemini-cli", "github-copilot-cli", "github-copilot-vscode"],
    });

    assert.equal(installed.ok, true);
    assert.ok(installed.installs.some((entry) => entry.client_id === "claude-cli"));
    assert.equal(fs.existsSync(path.join(homeDir, ".claude.json")), true);
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.type, "http");
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.url, "http://127.0.0.1:8787/");

    const cursorConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursorConfig.mcpServers?.["master-mold"]?.url);
    const cursorWorkspaceConfig = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, ".cursor", "mcp.json"), "utf8")
    );
    assert.ok(cursorWorkspaceConfig.mcpServers?.["master-mold"]?.url);

    const geminiConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".gemini", "settings.json"), "utf8"));
    assert.ok(geminiConfig.mcpServers?.["master-mold"]?.url);

    const copilotConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".copilot", "mcp-config.json"), "utf8"));
    assert.equal(copilotConfig.mcpServers?.["master-mold"]?.type, "http");

    const vscodeConfig = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".vscode", "mcp.json"), "utf8"));
    assert.ok(vscodeConfig.servers?.["master-mold"]?.url);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge installs Gemini CLI via stdio when transport is auto", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-gemini-auto-"));
  const homeDir = path.join(tempDir, "home");
  const workspaceRoot = path.join(tempDir, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-install-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const installed = await callTool(session.client, "provider.bridge", {
      action: "install",
      mutation: nextMutation("provider-bridge", "install-gemini-auto", () => mutationCounter++),
      transport: "auto",
      workspace_root: workspaceRoot,
      clients: ["gemini-cli"],
    });

    assert.equal(installed.ok, true);
    assert.equal(installed.installs[0].transport_used, "stdio");

    const geminiConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".gemini", "settings.json"), "utf8"));
    assert.equal(typeof geminiConfig.mcpServers?.["master-mold"]?.command, "string");
    assert.ok(Array.isArray(geminiConfig.mcpServers?.["master-mold"]?.args));
    assert.match(geminiConfig.mcpServers?.["master-mold"]?.args?.[0] || "", /provider_stdio_bridge\.mjs$/);
    assert.equal(geminiConfig.mcpServers?.["master-mold"]?.type, "stdio");
    assert.equal(geminiConfig.mcpServers?.["master-mold"]?.cwd, workspaceRoot);
    assert.equal(geminiConfig.mcpServers?.["master-mold"]?.trust, true);
    assert.equal(geminiConfig.mcpServers?.["master-mold"]?.timeout, 600000);
    assert.equal(typeof geminiConfig.mcpServers?.["master-mold"]?.env?.MCP_PROXY_HTTP_URL, "string");
    assert.equal(installed.clients[0].preferred_transport, "stdio");
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge installs Claude CLI via stdio proxy when transport is auto", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-claude-auto-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  const workspaceRoot = path.join(tempDir, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  createFakeClaudeCli(path.join(binDir, "claude"));

  let mutationCounter = 0;
  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-install-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const installed = await callTool(session.client, "provider.bridge", {
      action: "install",
      mutation: nextMutation("provider-bridge", "install-claude-auto", () => mutationCounter++),
      transport: "auto",
      workspace_root: workspaceRoot,
      clients: ["claude-cli"],
    });

    assert.equal(installed.ok, true);
    assert.equal(installed.installs[0].transport_used, "stdio");

    const claudeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.type, "stdio");
    assert.equal(typeof claudeConfig.mcpServers?.["master-mold"]?.command, "string");
    assert.ok(Array.isArray(claudeConfig.mcpServers?.["master-mold"]?.args));
    assert.match(String(claudeConfig.mcpServers?.["master-mold"]?.args?.[0] ?? ""), /provider_stdio_bridge\.mjs$/);
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.cwd, workspaceRoot);
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.trust, true);
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.timeout, 600000);
    assert.equal(claudeConfig.mcpServers?.["master-mold"]?.env?.MCP_PROXY_HTTP_URL, "http://127.0.0.1:8787/");
    assert.equal(typeof claudeConfig.mcpServers?.["master-mold"]?.env?.MCP_PROXY_STDIO_COMMAND, "string");
    assert.equal(installed.clients[0].preferred_transport, "stdio");
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose reports office agent mappings and truthful status fields", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-diagnose-"));
  const homeDir = path.join(tempDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
    });
    assert.equal(diagnose.ok, true);
    const diagnostics = new Map(diagnose.diagnostics.map((entry) => [entry.client_id, entry]));
    assert.equal(diagnostics.get("codex")?.office_agent_id, "codex");
    assert.equal(diagnostics.get("claude-cli")?.office_agent_id, "claude");
    assert.equal(diagnostics.get("cursor")?.office_agent_id, "cursor");
    assert.equal(diagnostics.get("gemini-cli")?.office_agent_id, "gemini");
    assert.equal(diagnostics.get("github-copilot-cli")?.office_agent_id, "github-copilot");
    assert.equal(diagnose.onboarding.recommended_diagnose_command, "npm run providers:diagnose -- <client-id>");
    assert.equal(typeof diagnose.onboarding.generated_at, "string");
    const onboardingEntries = new Map(diagnose.onboarding.entries.map((entry) => [entry.client_id, entry]));
    assert.equal(typeof onboardingEntries.get("claude-cli")?.ready, "boolean");
    assert.equal(typeof onboardingEntries.get("codex")?.runtime_status, "string");
    assert.equal(onboardingEntries.get("claude-cli")?.verify_command, "npm run providers:diagnose -- claude-cli");
    assert.equal(onboardingEntries.get("codex")?.verify_command, "npm run providers:diagnose -- codex");
    assert.equal(onboardingEntries.get("cursor")?.verify_command, "npm run providers:diagnose -- cursor");
    assert.equal(onboardingEntries.get("github-copilot-vscode")?.failure_kind, "editor_merge_required");
    assert.match(String(onboardingEntries.get("github-copilot-vscode")?.failure_detail || ""), /editor\/workspace merge/i);
    assert.equal(onboardingEntries.get("github-copilot-vscode")?.verify_command, "npm run providers:diagnose -- github-copilot-vscode");
    assert.equal(onboardingEntries.get("github-copilot-vscode")?.repair_command, "npm run providers:export");
    assert.equal(onboardingEntries.get("chatgpt-developer-mode")?.failure_kind, "remote_endpoint_required");
    assert.match(String(onboardingEntries.get("chatgpt-developer-mode")?.failure_detail || ""), /remote MCP endpoint/i);
    for (const entry of diagnose.diagnostics) {
      assert.ok(["connected", "disconnected", "configured", "unavailable"].includes(entry.status));
    }
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose keeps Gemini configured until runtime is actually observed", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-gemini-diagnose-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "gemini"),
    "#!/bin/sh\nif [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"list\" ]; then\n  echo 'should not run'\n  exit 91\nfi\nexit 0\n",
    { mode: 0o755 }
  );
  fs.chmodSync(path.join(binDir, "gemini"), 0o755);
  fs.writeFileSync(path.join(binDir, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.chmodSync(path.join(binDir, "pgrep"), 0o755);

  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiDir, "settings.json"),
    JSON.stringify(
      {
        mcpServers: {
          "master-mold": {
            type: "stdio",
            command: "node",
            args: ["/tmp/provider_stdio_bridge.mjs"],
            cwd: tempDir,
            timeout: 600000,
            trust: true,
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(geminiDir, "oauth_creds.json"),
    JSON.stringify(
      {
        access_token: "token",
        refresh_token: "refresh",
        expiry_date: Date.now() - 1000,
        token_type: "Bearer",
      },
      null,
      2
    )
  );

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      clients: ["gemini-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });
    assert.equal(diagnose.ok, true);
    assert.equal(diagnose.diagnostics.length, 1);
    const gemini = diagnose.diagnostics[0];
    assert.equal(gemini.client_id, "gemini-cli");
    assert.equal(gemini.status, "configured");
    assert.equal(gemini.connected, false);
    assert.match(gemini.detail, /OAuth session/i);
    assert.match(gemini.detail, /runtime is not currently observed/i);
    assert.match(gemini.command, /runtime probe/i);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge status reuses cached diagnostics so operator readiness stays conservative", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-gemini-status-cache-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "gemini"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 }
  );
  fs.chmodSync(path.join(binDir, "gemini"), 0o755);
  fs.writeFileSync(path.join(binDir, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.chmodSync(path.join(binDir, "pgrep"), 0o755);

  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiDir, "settings.json"),
    JSON.stringify(
      {
        mcpServers: {
          "master-mold": {
            type: "stdio",
            command: "node",
            args: ["/tmp/provider_stdio_bridge.mjs"],
            cwd: tempDir,
            timeout: 600000,
            trust: true,
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(geminiDir, "oauth_creds.json"),
    JSON.stringify(
      {
        access_token: "token",
        refresh_token: "refresh",
        expiry_date: Date.now() - 1000,
        token_type: "Bearer",
      },
      null,
      2
    )
  );

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-status-cache-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      clients: ["gemini-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });
    assert.equal(diagnose.diagnostics[0]?.status, "configured");

    const status = await callTool(session.client, "provider.bridge", {
      action: "status",
      clients: ["gemini-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });

    const outbound = status.outbound_council_agents.find((entry) => entry.client_id === "gemini-cli");
    const router = status.router_backend_candidates.find((entry) => entry.client_id === "gemini-cli");
    const onboarding = status.onboarding.entries.find((entry) => entry.client_id === "gemini-cli");

    assert.equal(outbound?.runtime_ready, false);
    assert.equal(router?.eligible, false);
    assert.match(String(router?.reason || ""), /runtime/i);
    assert.equal(onboarding?.runtime_status, "configured");
    assert.equal(onboarding?.ready, false);
    assert.equal(onboarding?.runtime_ready, false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose treats Copilot as disconnected from recent auth logs without waiting on prompt probe", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-copilot-diagnose-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "copilot"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  fs.chmodSync(path.join(binDir, "copilot"), 0o755);

  const copilotDir = path.join(homeDir, ".copilot");
  const logsDir = path.join(copilotDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(copilotDir, "mcp-config.json"),
    JSON.stringify(
      {
        mcpServers: {
          "master-mold": {
            type: "http",
            url: "http://127.0.0.1:8787/",
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(logsDir, "process-latest.log"),
    "2026-04-01T18:04:19.666Z [ERROR] No authentication information found.\n",
    "utf8"
  );

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      clients: ["github-copilot-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });
    assert.equal(diagnose.ok, true);
    assert.equal(diagnose.diagnostics.length, 1);
    const copilot = diagnose.diagnostics[0];
    assert.equal(copilot.client_id, "github-copilot-cli");
    assert.equal(copilot.status, "disconnected");
    assert.equal(copilot.connected, false);
    assert.match(copilot.detail, /no authenticated session/i);
    assert.match(copilot.command, /stateful config \+ recent log heartbeat/i);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose treats Copilot as connected from config metadata and ignores older stale auth logs", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-copilot-config-diagnose-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "copilot"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  fs.chmodSync(path.join(binDir, "copilot"), 0o755);

  const copilotDir = path.join(homeDir, ".copilot");
  const logsDir = path.join(copilotDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(copilotDir, "mcp-config.json"),
    JSON.stringify(
      {
        mcpServers: {
          "master-mold": {
            type: "http",
            url: "http://127.0.0.1:8787/",
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(logsDir, "process-stale.log"),
    "2026-04-01T18:04:19.666Z [ERROR] No authentication information found.\n",
    "utf8"
  );
  const staleLogPath = path.join(logsDir, "process-stale.log");
  const older = new Date("2026-04-01T18:04:19.666Z");
  fs.utimesSync(staleLogPath, older, older);
  fs.writeFileSync(
    path.join(copilotDir, "config.json"),
    JSON.stringify(
      {
        last_logged_in_user: {
          host: "https://github.com",
          login: "kolonelpanik",
        },
        logged_in_users: [
          {
            host: "https://github.com",
            login: "kolonelpanik",
          },
        ],
      },
      null,
      2
    )
  );

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      clients: ["github-copilot-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });
    assert.equal(diagnose.ok, true);
    assert.equal(diagnose.diagnostics.length, 1);
    const copilot = diagnose.diagnostics[0];
    assert.equal(copilot.client_id, "github-copilot-cli");
    assert.equal(copilot.status, "connected");
    assert.equal(copilot.connected, true);
    assert.match(copilot.detail, /login metadata present/i);
    assert.match(copilot.command, /stateful config \+ recent log heartbeat/i);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose treats Claude as connected from MCP config plus auth state", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-claude-diagnose-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  createFakeClaudeCli(path.join(binDir, "claude"));
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ mcpServers: {} }, null, 2));

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    const install = await callTool(session.client, "provider.bridge", {
      action: "install",
      mutation: nextMutation("provider-bridge", "install-claude", () => 0),
      transport: "http",
      workspace_root: tempDir,
      clients: ["claude-cli"],
    });
    assert.equal(install.ok, true);

    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      clients: ["claude-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });
    assert.equal(diagnose.ok, true);
    assert.equal(diagnose.diagnostics.length, 1);
    const claude = diagnose.diagnostics[0];
    assert.equal(claude.client_id, "claude-cli");
    assert.equal(claude.status, "connected");
    assert.equal(claude.connected, true);
    assert.match(claude.detail, /authentication is active/i);
    assert.match(claude.command, /claude mcp get master-mold \+ claude auth status/i);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose uses cached diagnostics by default and does not block the server", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-diagnose-cache-"));
  const homeDir = path.join(tempDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-cache-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
  });

  try {
    // First call with force_live populates the cache
    const first = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      force_live: true,
    });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);

    // Second call without force_live should return cached result fast
    const startedAt = Date.now();
    const second = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.stale, false);
    assert.ok(elapsedMs < 2_000, `expected cached diagnose to be fast, saw ${elapsedMs}ms`);
    assert.ok(second.diagnostics.length > 0, "cache should contain diagnostics");
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose force_live bypasses cache and runs live probes", { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-diagnose-force-"));
  const homeDir = path.join(tempDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-force-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
    PROVIDER_BRIDGE_DIAGNOSTICS_CACHE_SECONDS: "300",
  });

  try {
    // First call populates cache
    const first = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      force_live: true,
    });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);

    // Second call with force_live should bypass the fresh cache
    const second = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      force_live: true,
    });
    assert.equal(second.ok, true);
    assert.equal(second.cached, false);
    assert.equal(second.stale, false);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose refreshes stale cache automatically over stdio", { concurrency: false, timeout: 45_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-diagnose-stale-refresh-"));
  const homeDir = path.join(tempDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-diagnose-stale-refresh-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
    PROVIDER_BRIDGE_DIAGNOSTICS_CACHE_SECONDS: "1",
  });

  try {
    const first = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      force_live: true,
    });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);

    await new Promise((resolve) => setTimeout(resolve, 5_500));

    const second = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
    });
    assert.equal(second.ok, true);
    assert.equal(second.cached, false);
    assert.equal(second.stale, false);
    assert.ok(second.diagnostics.length > 0, "stale diagnose should refresh live diagnostics over stdio");
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge status self-heals stale runtime truth over stdio after live diagnose", { concurrency: false, timeout: 45_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-status-stale-runtime-truth-"));
  const homeDir = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  createFakeClaudeCli(path.join(binDir, "claude"));
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ mcpServers: {} }, null, 2));

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: path.join(tempDir, "hub.sqlite"),
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    MCP_HTTP_BEARER_TOKEN: "provider-bridge-status-stale-runtime-truth-token",
    TRICHAT_MCP_URL: "http://127.0.0.1:8787/",
    TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
    PROVIDER_BRIDGE_DIAGNOSTICS_CACHE_SECONDS: "1",
  });

  try {
    const initialStatus = await callTool(session.client, "provider.bridge", {
      action: "status",
      clients: ["claude-cli"],
      workspace_root: tempDir,
    });
    assert.equal(initialStatus.ok, true);
    assert.equal(initialStatus.clients[0].installed, false);

    const install = await callTool(session.client, "provider.bridge", {
      action: "install",
      mutation: nextMutation("provider-bridge", "install-claude-status-self-heal", () => 0),
      transport: "http",
      workspace_root: tempDir,
      clients: ["claude-cli"],
    });
    assert.equal(install.ok, true);

    const diagnose = await callTool(session.client, "provider.bridge", {
      action: "diagnose",
      clients: ["claude-cli"],
      probe_timeout_ms: 1000,
      workspace_root: tempDir,
    });
    assert.equal(diagnose.ok, true);
    assert.equal(diagnose.cached, false);
    assert.equal(diagnose.diagnostics[0].status, "connected");

    await new Promise((resolve) => setTimeout(resolve, 5_500));

    const healedStatus = await callTool(session.client, "provider.bridge", {
      action: "status",
      clients: ["claude-cli"],
      workspace_root: tempDir,
      probe_timeout_ms: 1000,
    });
    assert.equal(healedStatus.ok, true);
    assert.equal(healedStatus.onboarding.stale_runtime_checks, false);
    assert.equal(healedStatus.clients[0].installed, true);
    assert.equal(healedStatus.outbound_council_agents[0].runtime_ready, true);
    assert.equal(healedStatus.router_backend_candidates[0].eligible, true);
    assert.equal(healedStatus.router_backend_candidates[0].backend.metadata.runtime_ready, true);
    assert.equal(healedStatus.router_backend_candidates[0].backend.metadata.runtime_ready_stale, false);
    assert.match(
      healedStatus.router_backend_candidates[0].backend.metadata.runtime_ready_source,
      /^provider_bridge_diagnostics_(cache|live)$/
    );
    assert.equal(healedStatus.onboarding.entries[0].runtime_status, "connected");
    assert.equal(healedStatus.onboarding.entries[0].ready, true);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge over HTTP: /health stays responsive during status calls and force_live is rejected", { concurrency: false, timeout: 60_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-bridge-http-health-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const busPath = path.join(tempDir, "trichat.bus.sock");
  const bearerToken = "provider-bridge-http-health-token";
  const httpPort = await reservePort();

  const child = spawn("node", ["dist/server.js", "--http", "--http-port", String(httpPort)], {
    cwd: REPO_ROOT,
    env: inheritedEnv({
      MCP_HTTP: "1",
      MCP_HTTP_PORT: String(httpPort),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_BEARER_TOKEN: bearerToken,
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: busPath,
      TRICHAT_MCP_URL: `http://127.0.0.1:${httpPort}/`,
      TRICHAT_MCP_ORIGIN: "http://127.0.0.1",
      // Disable background daemons to keep the test focused
      TRICHAT_RING_LEADER_AUTOSTART: "0",
      MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
      MCP_AUTONOMY_MAINTAIN_ON_START: "0",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    // Wait for /health to become available
    await waitForHealth(`http://127.0.0.1:${httpPort}/health`, 15_000);

    // Fire a provider.bridge status call via mcp_tool_call.mjs (goes through the MCP session)
    const toolCallPromise = execFileAsync(
      "node",
      [
        "./scripts/mcp_tool_call.mjs",
        "--tool", "provider.bridge",
        "--args", JSON.stringify({ action: "status" }),
        "--transport", "http",
        "--url", `http://127.0.0.1:${httpPort}/`,
        "--origin", "http://127.0.0.1",
        "--cwd", REPO_ROOT,
      ],
      {
        cwd: REPO_ROOT,
        env: inheritedEnv({ MCP_HTTP_BEARER_TOKEN: bearerToken }),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 20_000,
      }
    );

    // While the tool call is in flight, /health must respond quickly
    const healthStart = Date.now();
    const healthBody = await fetchHttpText(`http://127.0.0.1:${httpPort}/health`);
    const healthMs = Date.now() - healthStart;
    const health = JSON.parse(healthBody);
    assert.equal(health.ok, true);
    assert.ok(healthMs < 2_000, `/health took ${healthMs}ms during provider.bridge status — expected < 2s`);

    // Wait for the status call to finish and verify it succeeded
    const statusResult = await toolCallPromise;
    const statusParsed = JSON.parse(statusResult.stdout);
    assert.equal(statusParsed.ok, true);

    // Verify force_live is rejected over HTTP
    const forceLiveResult = await execFileAsync(
      "node",
      [
        "./scripts/mcp_tool_call.mjs",
        "--tool", "provider.bridge",
        "--args", JSON.stringify({ action: "diagnose", force_live: true }),
        "--transport", "http",
        "--url", `http://127.0.0.1:${httpPort}/`,
        "--origin", "http://127.0.0.1",
        "--cwd", REPO_ROOT,
      ],
      {
        cwd: REPO_ROOT,
        env: inheritedEnv({ MCP_HTTP_BEARER_TOKEN: bearerToken }),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 20_000,
      }
    );
    const forceLiveParsed = JSON.parse(forceLiveResult.stdout);
    assert.equal(forceLiveParsed.ok, false);
    assert.match(forceLiveParsed.error, /force_live.*not available.*HTTP/i);
  } finally {
    await stopChildProcess(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await fetchHttpText(url, {}, { timeoutMs: 2_500 });
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-provider-bridge-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return { client };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const first = response.content?.[0];
  assert.equal(first?.type, "text");
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${first.text}`);
  }
  return JSON.parse(first.text);
}

function nextMutation(testId, label, nextCounter) {
  const counter = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${counter}`,
    side_effect_fingerprint: `${testId}:${label}:${counter}`,
  };
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function createFakeClaudeCli(filePath) {
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env python3
import json, os, pathlib, sys

home = pathlib.Path(os.environ.get("HOME", "."))
store = home / ".claude-mcp-test.json"
config = home / ".claude.json"

def load_store():
    if store.exists():
        return json.loads(store.read_text())
    return {}

def save_store(data):
    store.parent.mkdir(parents=True, exist_ok=True)
    store.write_text(json.dumps(data, indent=2))
    config.write_text(json.dumps({"mcpServers": data}, indent=2))

args = sys.argv[1:]
if args[:2] == ["auth", "status"]:
    print(json.dumps({"loggedIn": True, "authMethod": "oauth", "apiProvider": "firstParty"}))
    sys.exit(0)

if len(args) >= 2 and args[0] == "mcp" and args[1] == "remove":
    name = args[-1]
    data = load_store()
    data.pop(name, None)
    save_store(data)
    print("removed")
    sys.exit(0)

if len(args) >= 2 and args[0] == "mcp" and args[1] == "add-json":
    name = args[-2]
    payload = json.loads(args[-1])
    data = load_store()
    data[name] = payload
    save_store(data)
    print("added-json")
    sys.exit(0)

if len(args) >= 2 and args[0] == "mcp" and args[1] == "add":
    tail = args[2:]
    positional = []
    i = 0
    while i < len(tail):
        current = tail[i]
        if current in {"-s", "--scope", "-t", "--transport", "-H", "--header"}:
            i += 2
            continue
        if current.startswith("-"):
            i += 1
            continue
        positional.append(current)
        i += 1
    name = positional[0]
    url = positional[1]
    data = load_store()
    data[name] = {"type": "http", "url": url}
    save_store(data)
    print("added-http")
    sys.exit(0)

if len(args) >= 2 and args[0] == "mcp" and args[1] == "get":
    if os.environ.get("CLAUDE_HANG_MCP_GET") == "1":
        import signal, time
        signal.signal(signal.SIGTERM, lambda *_args: None)
        while True:
            time.sleep(1)
    name = args[-1]
    data = load_store()
    if name in data:
        print(json.dumps(data[name]))
        sys.exit(0)
    print("missing", file=sys.stderr)
    sys.exit(1)

if len(args) >= 2 and args[0] == "mcp" and args[1] == "list":
    print(json.dumps(load_store()))
    sys.exit(0)

print("unsupported", file=sys.stderr)
sys.exit(1)
`,
    { mode: 0o755 }
  );
  fs.chmodSync(filePath, 0o755);
}
