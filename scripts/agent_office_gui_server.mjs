#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..");
const defaultUiRoot = path.join(defaultRepoRoot, "ui", "agent-office");
const defaultDashboardScript = path.join(defaultRepoRoot, "scripts", "agent_office_dashboard.py");
const defaultHelperScript = path.join(defaultRepoRoot, "scripts", "mcp_tool_call.mjs");
const DEFAULT_THREAD_ID = process.env.TRICHAT_OFFICE_THREAD_ID || "ring-leader-main";

function parseArgs(argv) {
  const out = {
    host: process.env.AGENT_OFFICE_GUI_HOST || "127.0.0.1",
    port: Number(process.env.AGENT_OFFICE_GUI_PORT || 8790),
    repoRoot: process.env.AGENT_OFFICE_GUI_REPO_ROOT || defaultRepoRoot,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--host") {
      out.host = argv[index + 1] || out.host;
      index += 1;
    } else if (token === "--port") {
      out.port = Number(argv[index + 1] || out.port);
      index += 1;
    } else if (token === "--repo-root") {
      out.repoRoot = argv[index + 1] || out.repoRoot;
      index += 1;
    }
  }
  return out;
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function textResponse(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function guessContentType(targetPath) {
  if (targetPath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (targetPath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (targetPath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (targetPath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function runJsonCommand(command, args, options = {}) {
  const completed = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (completed.error) {
    throw completed.error;
  }
  if (completed.status !== 0) {
    const detail = String(completed.stderr || completed.stdout || `exit ${completed.status}`).trim();
    throw new Error(detail || `${command} exited with ${completed.status}`);
  }
  const stdout = String(completed.stdout || "").trim();
  if (!stdout) {
    return {};
  }
  return JSON.parse(stdout);
}

function buildMutation(phase) {
  const nonce = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  return {
    idempotency_key: `agent-office-gui-${phase}-${nonce}`,
    side_effect_fingerprint: `agent-office-gui-${phase}-${nonce}`,
  };
}

function normalizeTransport() {
  if (String(process.env.TRICHAT_MCP_TRANSPORT || "").trim()) {
    return String(process.env.TRICHAT_MCP_TRANSPORT).trim();
  }
  return process.env.MCP_HTTP_BEARER_TOKEN ? "http" : "stdio";
}

function callMcpTool(repoRoot, tool, args) {
  const transport = normalizeTransport();
  const helperArgs = [
    defaultHelperScript,
    "--tool",
    tool,
    "--args",
    JSON.stringify(args ?? {}),
    "--transport",
    transport,
    "--url",
    process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/",
    "--origin",
    process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1",
    "--stdio-command",
    process.env.TRICHAT_MCP_STDIO_COMMAND || "node",
    "--stdio-args",
    process.env.TRICHAT_MCP_STDIO_ARGS || "dist/server.js",
    "--cwd",
    repoRoot,
  ];
  return runJsonCommand("node", helperArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ANAMNESIS_HUB_STARTUP_BACKUP: "0",
    },
  });
}

function fetchOfficeSnapshot(repoRoot, threadId) {
  if (process.env.AGENT_OFFICE_GUI_SNAPSHOT_JSON) {
    return JSON.parse(process.env.AGENT_OFFICE_GUI_SNAPSHOT_JSON);
  }
  const transport = normalizeTransport();
  const args = [
    defaultDashboardScript,
    "--repo-root",
    repoRoot,
    "--transport",
    transport,
    "--url",
    process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/",
    "--origin",
    process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1",
    "--theme",
    process.env.TRICHAT_OFFICE_THEME || "night",
    "--json-snapshot",
  ];
  if (threadId) {
    args.push("--thread-id", threadId);
  } else {
    args.push("--resume-latest");
  }
  return runJsonCommand("python3", args, { cwd: repoRoot, env: process.env, timeoutMs: 45000 });
}

function submitObjective(repoRoot, objective, options = {}) {
  return callMcpTool(repoRoot, "autonomy.ide_ingress", {
    mutation: buildMutation("intake"),
    objective,
    title: String(objective).trim().slice(0, 96),
    dry_run: options.dry_run === true,
    source_client: "agent-office.gui",
    source_agent: "operator",
    mirror_to_thread: true,
    append_memory: true,
    append_transcript: true,
    publish_event: true,
    ensure_bootstrap: true,
    autostart_ring_leader: true,
    bootstrap_run_immediately: false,
    compile_objective: true,
    selected_plan: true,
    thread_id: DEFAULT_THREAD_ID,
    thread_title: "Ring Leader Main",
    thread_status: "active",
    trichat_agent_ids: [
      "implementation-director",
      "research-director",
      "verification-director",
      "local-imprint",
      "gemini",
      "gemma-local",
    ],
  });
}

function runGuiAction(repoRoot, action) {
  if (action === "ensure") {
    return callMcpTool(repoRoot, "autonomy.bootstrap", {
      action: "ensure",
      local_host_id: "local",
      autostart_ring_leader: true,
      source_client: "agent-office.gui",
      mutation: buildMutation("ensure"),
    });
  }
  if (action === "maintain") {
    return callMcpTool(repoRoot, "autonomy.maintain", {
      action: "run_once",
      local_host_id: "local",
      ensure_bootstrap: true,
      autostart_ring_leader: true,
      source_client: "agent-office.gui",
      mutation: buildMutation("maintain"),
    });
  }
  if (action === "ring_leader_tick") {
    return callMcpTool(repoRoot, "trichat.autopilot", {
      action: "run_once",
      thread_id: DEFAULT_THREAD_ID,
      lead_agent_id: "ring-leader",
      source_client: "agent-office.gui",
      mutation: buildMutation("ring-leader-tick"),
    });
  }
  if (action === "open_tmux") {
    const completed = spawnSync(path.join(repoRoot, "scripts", "agent_office_tmux_open.sh"), [], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 30000,
    });
    if (completed.error) {
      throw completed.error;
    }
    if (completed.status !== 0) {
      throw new Error(String(completed.stderr || completed.stdout || "tmux launch failed").trim());
    }
    return { ok: true, opened: "tmux" };
  }
  throw new Error(`Unknown GUI action: ${action}`);
}

export function createAgentOfficeGuiServer(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot);
  const uiRoot = path.resolve(options.uiRoot || defaultUiRoot);
  const getSnapshot = options.getSnapshot || ((threadId) => fetchOfficeSnapshot(repoRoot, threadId));
  const postObjective = options.postObjective || ((objective, config) => submitObjective(repoRoot, objective, config));
  const runAction = options.runAction || ((action) => runGuiAction(repoRoot, action));

  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      if (req.method === "GET" && pathname === "/api/health") {
        return jsonResponse(res, 200, { ok: true, service: "agent-office-gui" });
      }
      if (req.method === "GET" && pathname === "/api/snapshot") {
        const snapshot = await Promise.resolve(getSnapshot(String(requestUrl.searchParams.get("thread_id") || "").trim() || DEFAULT_THREAD_ID));
        return jsonResponse(res, 200, snapshot);
      }
      if (req.method === "POST" && pathname === "/api/intake") {
        const body = await readJsonBody(req);
        const objective = String(body.objective || "").trim();
        if (!objective) {
          return jsonResponse(res, 400, { ok: false, error: "objective is required" });
        }
        const result = await Promise.resolve(postObjective(objective, { dry_run: body.dry_run === true }));
        return jsonResponse(res, 200, { ok: true, result });
      }
      if (req.method === "POST" && pathname === "/api/action") {
        const body = await readJsonBody(req);
        const action = String(body.action || "").trim();
        if (!action) {
          return jsonResponse(res, 400, { ok: false, error: "action is required" });
        }
        const result = await Promise.resolve(runAction(action));
        return jsonResponse(res, 200, { ok: true, action, result });
      }

      const assetPath =
        pathname === "/" ? path.join(uiRoot, "index.html") : path.join(uiRoot, pathname.replace(/^\/+/, ""));
      const normalizedAssetPath = path.normalize(assetPath);
      if (!normalizedAssetPath.startsWith(uiRoot)) {
        return textResponse(res, 403, "Forbidden");
      }
      const body = await fs.readFile(normalizedAssetPath);
      return textResponse(res, 200, body, guessContentType(normalizedAssetPath));
    } catch (error) {
      return jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createAgentOfficeGuiServer({ repoRoot: options.repoRoot });
  await new Promise((resolve) => server.listen(options.port, options.host, resolve));
  process.stdout.write(`agent-office-gui listening on http://${options.host}:${options.port}/\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
