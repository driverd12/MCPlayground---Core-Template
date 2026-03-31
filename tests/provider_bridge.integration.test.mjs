import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("provider.bridge reports truthful client and outbound council coverage", async () => {
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
    assert.equal(clients.get("github-copilot-cli")?.outbound_council_supported, false);
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

test("provider.bridge export_bundle and install create real client config artifacts", async () => {
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
  return { client };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
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
