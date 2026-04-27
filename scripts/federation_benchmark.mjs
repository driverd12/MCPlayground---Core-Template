#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = "") {
  const token = `--${name}`;
  const prefix = `${token}=`;
  const inline = process.argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(token);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function boolArg(name, fallback = false) {
  const value = argValue(name, process.argv.includes(`--${name}`) ? "true" : fallback ? "true" : "false");
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runTimed(label, command, args, env) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    label,
    ok: result.status === 0,
    status: result.status,
    elapsed_ms: Number(elapsedMs.toFixed(3)),
    stdout_bytes: Buffer.byteLength(String(result.stdout || "")),
    stderr: String(result.stderr || "").slice(0, 1000),
  };
}

async function seedDatabase(dbPath, hostCount, eventsPerHost) {
  const { Storage } = await import(pathToFileURL(path.join(REPO_ROOT, "dist", "storage.js")).href);
  const storage = new Storage(dbPath);
  storage.init();
  const now = Date.now();
  for (let hostIndex = 0; hostIndex < hostCount; hostIndex += 1) {
    const hostId = `bench-host-${hostIndex + 1}`;
    for (let eventIndex = 0; eventIndex < eventsPerHost; eventIndex += 1) {
      const createdAt = new Date(now - (hostIndex * eventsPerHost + eventIndex) * 1000).toISOString();
      storage.appendRuntimeEvent({
        created_at: createdAt,
        event_type: "federation.ingest",
        entity_type: "worker_fabric_host",
        entity_id: hostId,
        status: "ok",
        summary: `benchmark federation ingest from ${hostId}`,
        details: {
          federation_identity: {
            requesting_host_id: hostId,
            captured_from_host_id: hostId,
            captured_hostname: `${hostId}.local`,
            captured_agent_runtime: "benchmark",
            captured_model_label: "benchmark",
            received_at: createdAt,
            signature_verification_result: { status: "verified" },
            approval_scope: { status: "approved", matched_by: "benchmark", permission_profile: "task_worker" },
          },
          shared_summaries: {
            status: "available",
            source: "benchmark",
            memories: [
              {
                memory_id: `${hostId}-memory`,
                created_at: createdAt,
                keywords: ["benchmark", "federation", "peer"],
                preview: `Peer ${hostId} benchmark memory for shared context query.`,
              },
            ],
            goals: [
              {
                goal_id: `${hostId}-goal`,
                updated_at: createdAt,
                status: eventIndex % 3 === 0 ? "blocked" : "active",
                title: `Benchmark ${hostId} goal`,
                objective: "Keep multi-peer federation operator surfaces fast.",
                tags: ["benchmark", "federation"],
              },
            ],
            tasks: [
              {
                task_id: `${hostId}-task`,
                updated_at: createdAt,
                status: eventIndex % 4 === 0 ? "failed" : "pending",
                objective: "Repair benchmark peer freshness.",
                source_agent: "benchmark",
                last_error: eventIndex % 4 === 0 ? "benchmark stale peer" : null,
              },
            ],
            capabilities: [
              {
                capability_id: `${hostId}:capability-summary`,
                generated_at: createdAt,
                host_id: hostId,
                hostname: `${hostId}.local`,
                worker_fabric: { host_count: hostCount, worker_count: 3, active_worker_count: 2 },
                model_router: { backend_count: 4, enabled_backend_count: 3, strategy: "benchmark" },
                provider_bridge: { connected_count: 2, disconnected_count: 1 },
              },
            ],
          },
        },
        source_client: "federation.benchmark",
        source_agent: "benchmark",
      });
    }
  }
  storage.close?.();
}

async function main() {
  if (!fs.existsSync(path.join(REPO_ROOT, "dist", "server.js"))) {
    const build = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit", timeout: 180_000 });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  const hostCount = Math.max(1, Math.min(20, Math.trunc(numberArg("hosts", 3))));
  const eventsPerHost = Math.max(1, Math.min(500, Math.trunc(numberArg("events-per-host", 80))));
  const jsonOnly = boolArg("json", false);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-federation-benchmark-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  await seedDatabase(dbPath, hostCount, eventsPerHost);
  const env = {
    ...process.env,
    ANAMNESIS_HUB_DB_PATH: dbPath,
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
    TRICHAT_BUS_AUTOSTART: "0",
    TRICHAT_RING_LEADER_AUTOSTART: "0",
    MCP_AUTONOMY_BOOTSTRAP_ON_START: "0",
    MCP_AUTONOMY_MAINTAIN_ON_START: "0",
  };
  const measures = [
    runTimed("office.snapshot", process.execPath, ["scripts/mcp_tool_call.mjs", "--tool", "office.snapshot", "--args", "{}", "--transport", "stdio", "--stdio-command", "node", "--stdio-args", "dist/server.js", "--cwd", REPO_ROOT], env),
    runTimed("kernel.summary", process.execPath, ["scripts/mcp_tool_call.mjs", "--tool", "kernel.summary", "--args", "{}", "--transport", "stdio", "--stdio-command", "node", "--stdio-args", "dist/server.js", "--cwd", REPO_ROOT], env),
    runTimed("knowledge.query", process.execPath, ["scripts/mcp_tool_call.mjs", "--tool", "knowledge.query", "--args", JSON.stringify({ query: "benchmark peer freshness", include_notes: false, include_transcripts: false, federated_focus: "blocker", limit: 10 }), "--transport", "stdio", "--stdio-command", "node", "--stdio-args", "dist/server.js", "--cwd", REPO_ROOT], env),
    runTimed("federation.doctor", "npm", ["run", "--silent", "federation:doctor", "--", "--json"], env),
  ];
  const output = {
    ok: measures.every((entry) => entry.ok),
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    db_path: dbPath,
    simulated_hosts: hostCount,
    simulated_federation_ingest_events: hostCount * eventsPerHost,
    measures,
  };
  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`MASTER-MOLD federation benchmark: ${hostCount} host(s), ${hostCount * eventsPerHost} ingest event(s)`);
    for (const measure of measures) {
      console.log(`${measure.ok ? "OK" : "FAIL"} ${measure.label}: ${measure.elapsed_ms}ms`);
    }
    console.log("\nJSON:");
    console.log(JSON.stringify(output, null, 2));
  }
  process.exitCode = output.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
