import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

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
    assert.equal(clients.get("cursor")?.outbound_council_supported, true);
    assert.equal(clients.get("cursor")?.outbound_bridge_ready, true);
    assert.equal(clients.get("gemini-cli")?.outbound_council_supported, true);
    assert.equal(clients.get("github-copilot-cli")?.outbound_council_supported, true);
    assert.equal(clients.get("github-copilot-cli")?.outbound_bridge_ready, true);
    assert.equal(clients.get("chatgpt-developer-mode")?.install_mode, "remote-only");

    const routerCandidates = new Map(status.router_backend_candidates.map((entry) => [entry.client_id, entry]));
    assert.ok(routerCandidates.has("codex"));
    assert.ok(routerCandidates.has("cursor"));
    assert.ok(routerCandidates.has("gemini-cli"));
    assert.equal(routerCandidates.get("codex")?.backend.metadata.bridge_agent_id, "codex");
    assert.equal(typeof routerCandidates.get("gemini-cli")?.eligible, "boolean");
    assert.ok(
      status.eligible_router_backends.every((entry) =>
        ["openai", "google", "cursor", "github-copilot", "custom"].includes(entry.provider)
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
  const workspaceRoot = path.join(tempDir, "workspace");
  const exportDir = path.join(tempDir, "exports");
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
    const exported = await callTool(session.client, "provider.bridge", {
      action: "export_bundle",
      mutation: nextMutation("provider-bridge", "export", () => mutationCounter++),
      transport: "http",
      output_dir: exportDir,
      workspace_root: workspaceRoot,
      clients: ["cursor", "gemini-cli", "github-copilot-cli", "github-copilot-vscode", "chatgpt-developer-mode"],
    });

    assert.equal(exported.ok, true);
    assert.equal(exported.bundle.output_dir, exportDir);
    assert.equal(fs.existsSync(exported.bundle.manifest_path), true);
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
      clients: ["cursor", "gemini-cli", "github-copilot-cli", "github-copilot-vscode"],
    });

    assert.equal(installed.ok, true);

    const cursorConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursorConfig.mcpServers?.mcplayground?.url);
    const cursorWorkspaceConfig = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, ".cursor", "mcp.json"), "utf8")
    );
    assert.ok(cursorWorkspaceConfig.mcpServers?.mcplayground?.url);

    const geminiConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".gemini", "settings.json"), "utf8"));
    assert.ok(geminiConfig.mcpServers?.mcplayground?.url);

    const copilotConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".copilot", "mcp-config.json"), "utf8"));
    assert.equal(copilotConfig.mcpServers?.mcplayground?.type, "http");

    const vscodeConfig = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".vscode", "mcp.json"), "utf8"));
    assert.ok(vscodeConfig.servers?.mcplayground?.url);
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
    assert.equal(typeof geminiConfig.mcpServers?.mcplayground?.command, "string");
    assert.ok(Array.isArray(geminiConfig.mcpServers?.mcplayground?.args));
    assert.match(geminiConfig.mcpServers?.mcplayground?.args?.[0] || "", /provider_stdio_bridge\.mjs$/);
    assert.equal(geminiConfig.mcpServers?.mcplayground?.type, "stdio");
    assert.equal(geminiConfig.mcpServers?.mcplayground?.cwd, workspaceRoot);
    assert.equal(geminiConfig.mcpServers?.mcplayground?.trust, true);
    assert.equal(geminiConfig.mcpServers?.mcplayground?.timeout, 600000);
    assert.equal(typeof geminiConfig.mcpServers?.mcplayground?.env?.MCP_PROXY_HTTP_URL, "string");
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
    assert.equal(diagnostics.get("cursor")?.office_agent_id, "cursor");
    assert.equal(diagnostics.get("gemini-cli")?.office_agent_id, "gemini");
    assert.equal(diagnostics.get("github-copilot-cli")?.office_agent_id, "github-copilot");
    for (const entry of diagnose.diagnostics) {
      assert.ok(["connected", "disconnected", "configured", "unavailable"].includes(entry.status));
    }
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provider.bridge diagnose treats Gemini as connected from config plus OAuth state without recursive CLI probing", { concurrency: false }, async () => {
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

  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiDir, "settings.json"),
    JSON.stringify(
      {
        mcpServers: {
          mcplayground: {
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
    assert.equal(gemini.status, "connected");
    assert.equal(gemini.connected, true);
    assert.match(gemini.detail, /OAuth session/i);
    assert.match(gemini.command, /stateful config \+ oauth heartbeat/i);
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
          mcplayground: {
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
          mcplayground: {
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
