#!/usr/bin/env node
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transportMode = process.env.MCP_SMOKE_TRANSPORT || "stdio";
const smokeUrl = process.env.MCP_SMOKE_URL || "http://127.0.0.1:8787/";
const smokeOrigin = process.env.MCP_SMOKE_ORIGIN || "http://127.0.0.1";
const runId = process.env.MCP_SMOKE_RUN_ID || `smoke-${Math.floor(Date.now() / 1000)}`;
const stdioCommand = process.env.MCP_SMOKE_STDIO_COMMAND || "node";
const stdioArgs = (process.env.MCP_SMOKE_STDIO_ARGS || "dist/server.js").split(/\s+/).filter(Boolean);

if (transportMode === "http" && !process.env.MCP_HTTP_BEARER_TOKEN) {
  process.stderr.write("error: MCP_HTTP_BEARER_TOKEN is required when MCP_SMOKE_TRANSPORT=http\n");
  process.exit(2);
}

const transport =
  transportMode === "http"
    ? new StreamableHTTPClientTransport(new URL(smokeUrl), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.MCP_HTTP_BEARER_TOKEN}`,
            Origin: smokeOrigin,
          },
        },
      })
    : new StdioClientTransport({
        command: stdioCommand,
        args: stdioArgs,
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
      });

const client = new Client(
  { name: "mcplayground-mvp-smoke", version: "0.1.0" },
  { capabilities: {} }
);

let mutationCounter = 0;
const mutation = (toolName) => {
  const index = mutationCounter++;
  const tool = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `smoke-${runId}-${tool}-${index}`,
    side_effect_fingerprint: `smoke-fingerprint-${runId}-${tool}-${index}`,
  };
};

const extractText = (response) =>
  (response.content || [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

const callTool = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

try {
  await client.connect(transport);

  await callTool("transcript.log", {
    mutation: mutation("transcript.log"),
    run_id: runId,
    role: "user",
    content: `Smoke user line for ${runId}`,
  });
  await callTool("transcript.log", {
    mutation: mutation("transcript.log"),
    run_id: runId,
    role: "assistant",
    content: `Smoke assistant action for ${runId}`,
  });

  const autoRunOnce = await callTool("transcript.auto_squish", {
    action: "run_once",
    mutation: mutation("transcript.auto_squish"),
    batch_runs: 100,
    per_run_limit: 500,
    max_points: 6,
  });

  const autoRunResult = autoRunOnce?.tick?.run_results?.find((entry) => entry.run_id === runId);
  let memoryId = autoRunResult?.memory_id;
  if (!memoryId) {
    const squish = await callTool("transcript.squish", {
      mutation: mutation("transcript.squish"),
      run_id: runId,
      max_points: 6,
    });
    if (!squish.created_memory || !squish.memory_id) {
      throw new Error(`No memory created for ${runId} via auto_squish run_once or transcript.squish`);
    }
    memoryId = squish.memory_id;
  }

  const search = await callTool("memory.search", {
    query: runId,
    limit: 5,
  });
  if (!Array.isArray(search) || search.length === 0) {
    throw new Error(`memory.search returned no matches for ${runId}`);
  }

  const memory = await callTool("memory.get", { id: memoryId });
  const timeline = await callTool("transcript.run_timeline", {
    run_id: runId,
    include_squished: true,
    limit: 20,
  });
  const pending = await callTool("transcript.pending_runs", { limit: 20 });
  const retentionDryRun = await callTool("transcript.retention", {
    mutation: mutation("transcript.retention"),
    older_than_days: 0,
    run_id: runId,
    limit: 100,
    dry_run: true,
  });
  const autoStatus = await callTool("transcript.auto_squish", {
    action: "status",
  });

  const imprintProfileId = `smoke-profile-${runId}`;
  const imprintProfile = await callTool("imprint.profile_set", {
    mutation: mutation("imprint.profile_set"),
    profile_id: imprintProfileId,
    title: "MVP Smoke Imprint",
    mission: "Keep local continuity durable across sessions.",
    principles: [
      "Prefer local-first execution",
      "Use idempotent mutations for side effects",
      "Avoid stdout operational logs",
    ],
    hard_constraints: ["Do not exfiltrate local context"],
    preferred_models: ["llama3.2:3b"],
    project_roots: [process.cwd()],
    source_client: "mvp_smoke.mjs",
  });

  const imprintSnapshot = await callTool("imprint.snapshot", {
    mutation: mutation("imprint.snapshot"),
    profile_id: imprintProfileId,
    summary: "mvp smoke continuity checkpoint",
    tags: ["smoke", "mvp"],
    include_recent_memories: 10,
    include_recent_transcript_lines: 10,
    write_file: false,
    promote_summary: false,
    source_client: "mvp_smoke.mjs",
  });

  const imprintBootstrap = await callTool("imprint.bootstrap", {
    profile_id: imprintProfileId,
    max_memories: 10,
    max_transcript_lines: 10,
    max_snapshots: 5,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: transportMode,
        run_id: runId,
        memory_id: memoryId,
        timeline_count: timeline.count || 0,
        pending_count: pending.count || 0,
        search_count: search.length,
        memory_found: memory.found || false,
        auto_squish_running: autoStatus.running || false,
        retention_candidates: retentionDryRun.candidate_count || 0,
        imprint_profile_id: imprintProfile.profile_id || null,
        imprint_snapshot_id: imprintSnapshot.snapshot_id || null,
        imprint_bootstrap_profile_found: imprintBootstrap.profile_found || false,
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
}
