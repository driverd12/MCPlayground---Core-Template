#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = process.cwd();
const DOGFOOD_SCRIPT = path.join(REPO_ROOT, "scripts", "trichat_dogfood.mjs");
const DEFAULT_PROMPT =
  "Soak gate turn: propose one concrete reliability or latency improvement with executable steps and explicit rollback notes.";

function parseCli(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function printHelp() {
  const lines = [
    "TriChat soak gate runner",
    "",
    "Runs repeated 1-cycle dogfood fanout turns and enforces health assertions.",
    "Designed as a release gate for long-running fanout reliability.",
    "",
    "Usage:",
    "  node ./scripts/trichat_soak_gate.mjs [options]",
    "",
    "Options:",
    "  --hours <1-4>                    Required soak duration budget (default: 1)",
    "  --interval-seconds <n>           Seconds between cycle starts (default: 60)",
    "  --max-cycles <n>                 Optional hard cap for cycles (default: derived from hours)",
    "  --allow-short <true|false>       Allow runtime below --hours budget (default: false)",
    "  --thread-id <id>                 Existing/new thread id (default: trichat-soak-gate-<epoch>)",
    "  --prompt <text>                  Base user prompt for each cycle",
    "  --require-success-agents <n>     Minimum successful agents per cycle (default: 2)",
    "  --bridge-timeout <seconds>       Bridge timeout passed to dogfood (default: 120)",
    "  --execute <true|false>           Enable execute path in dogfood cycles (default: false)",
    "  --max-open-channels <n>          Breaker gate: max open channels allowed (default: 0)",
    "  --max-breaker-trips-per-cycle <n>Breaker gate: max trip_opened events per cycle (default: 3)",
    "  --max-timeout-trips-per-cycle <n>Timeout gate: max timeout/deadline trips per cycle (default: 2)",
    "  --max-adapter-error-rate <0-1>   SLO gate: adapter error rate ceiling (default: 0.35)",
    "  --max-turn-failure-rate <0-1>    SLO gate: turn failure rate ceiling (default: 0.35)",
    "  --max-running-tasks <n>          Leak gate: max running task leases allowed (default: 25)",
    "  --event-limit <n>                Adapter telemetry event window (default: 400)",
    "  --slo-window-minutes <n>         SLO lookback window (default: 120)",
    "  --workboard-settle-seconds <n>   Wait for active turn finalize before leak checks (default: 12)",
    "  --cycle-timeout-seconds <n>      Timeout for one dogfood cycle process (default: 420)",
    "  --transport stdio|http           MCP transport for telemetry checks (default: stdio)",
    "  --url <http_url>                 MCP HTTP URL (default: http://127.0.0.1:8787/)",
    "  --origin <origin>                MCP HTTP Origin (default: http://127.0.0.1)",
    "  --stdio-command <cmd>            MCP stdio command (default: node)",
    "  --stdio-args <args>              MCP stdio args (default: dist/server.js)",
    "",
    "Examples:",
    "  npm run trichat:soak:gate -- --hours 1",
    "  npm run trichat:soak:gate -- --hours 2 --interval-seconds 90",
    "  npm run trichat:soak:gate -- --hours 1 --max-cycles 2 --allow-short true",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseBoundedFloat(value, fallback, min, max) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function compactSingleLine(value, limit = 200) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutationFactory(seed) {
  let counter = 0;
  return (toolName) => {
    counter += 1;
    const safe = String(toolName ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const base = `${seed}-${safe || "tool"}-${counter}`;
    return {
      idempotency_key: base,
      side_effect_fingerprint: `${base}-fingerprint`,
    };
  };
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args ?? {} });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`tool ${name} failed: ${compactSingleLine(text, 320)}`);
  }
  return parseJsonOrText(text);
}

function createTransport(options) {
  if (options.transport === "http") {
    const token = process.env.MCP_HTTP_BEARER_TOKEN;
    if (!token) {
      throw new Error("MCP_HTTP_BEARER_TOKEN is required for --transport http");
    }
    return new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: options.origin,
        },
      },
    });
  }
  return new StdioClientTransport({
    command: options.stdioCommand,
    args: String(options.stdioArgs)
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    cwd: REPO_ROOT,
    env: process.env,
    stderr: "pipe",
  });
}

function parseReportOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new Error("dogfood cycle returned empty stdout");
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start >= 0) {
      const candidate = text.slice(start + 1).trim();
      return JSON.parse(candidate);
    }
    throw new Error(`unable to parse dogfood JSON output: ${compactSingleLine(text, 240)}`);
  }
}

function buildDogfoodArgs(options, cyclePrompt) {
  const args = [
    DOGFOOD_SCRIPT,
    "--cycles",
    "1",
    "--thread-id",
    options.threadId,
    "--prompt",
    cyclePrompt,
    "--require-success-agents",
    String(options.requireSuccessAgents),
    "--bridge-timeout",
    String(options.bridgeTimeoutSeconds),
    "--transport",
    options.transport,
    "--thread-status",
    "archived",
    "--keep-active",
    "false",
    "--execute",
    options.execute ? "true" : "false",
  ];
  if (options.transport === "http") {
    args.push("--url", options.url, "--origin", options.origin);
  } else {
    args.push("--stdio-command", options.stdioCommand, "--stdio-args", options.stdioArgs);
  }
  return args;
}

async function runDogfoodCycle(options, cycle, cyclePrompt) {
  const args = buildDogfoodArgs(options, cyclePrompt);
  const env = {
    ...process.env,
    TRICHAT_BRIDGE_DRY_RUN: options.bridgeDryRun ? "true" : "false",
  };
  return await new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Math.max(30, options.cycleTimeoutSeconds) * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`dogfood cycle ${cycle} exceeded ${options.cycleTimeoutSeconds}s`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `dogfood cycle ${cycle} failed (code=${code ?? "n/a"} signal=${signal ?? "n/a"}): ` +
              compactSingleLine(stderr || stdout, 320)
          )
        );
        return;
      }
      try {
        const parsed = parseReportOutput(stdout);
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isActiveTurnRunning(activeTurn) {
  if (!activeTurn || typeof activeTurn !== "object") {
    return false;
  }
  const status = String(activeTurn.status ?? "")
    .trim()
    .toLowerCase();
  const phaseStatus = String(activeTurn.phase_status ?? "")
    .trim()
    .toLowerCase();
  return status === "running" || phaseStatus === "running";
}

async function waitForWorkboardSettled(client, threadId, settleTimeoutSeconds) {
  const maxWaitMs = Math.max(0, settleTimeoutSeconds) * 1000;
  const deadline = Date.now() + maxWaitMs;
  let latest = await callTool(client, "trichat.workboard", {
    thread_id: threadId,
    limit: 20,
  });
  while (isActiveTurnRunning(latest?.active_turn) && Date.now() < deadline) {
    await sleep(500);
    latest = await callTool(client, "trichat.workboard", {
      thread_id: threadId,
      limit: 20,
    });
  }
  return latest;
}

function evaluateCycleHealth({
  cycle,
  cycleStartedMs,
  cycleResult,
  adapterTelemetry,
  slo,
  workboard,
  taskSummary,
  options,
}) {
  const reasons = [];
  const recentEvents = Array.isArray(adapterTelemetry?.recent_events) ? adapterTelemetry.recent_events : [];
  const cycleEvents = recentEvents.filter((event) => {
    const created = parseTimestamp(event?.created_at);
    if (created === null) {
      return false;
    }
    return created >= cycleStartedMs - 1000;
  });
  const tripEvents = cycleEvents.filter(
    (event) => String(event?.event_type ?? "").trim().toLowerCase() === "trip_opened"
  );
  const timeoutTrips = tripEvents.filter((event) =>
    /timeout|deadline|timed out/i.test(String(event?.error_text ?? ""))
  );

  const successAgents = parseBoundedInt(cycleResult?.success_agents, 0, 0, 10);
  const totalAgents = parseBoundedInt(cycleResult?.total_agents, 0, 0, 10);
  const openChannels = parseBoundedInt(adapterTelemetry?.summary?.open_channels, 0, 0, 10_000);
  const adapterErrorRate = asNumber(slo?.metrics?.adapter?.error_rate, 0);
  const turnFailureRate = asNumber(slo?.metrics?.turns?.failure_rate, 0);
  const runningTasks = Array.isArray(taskSummary?.running) ? taskSummary.running.length : 0;
  const activeTurnRunning = isActiveTurnRunning(workboard?.active_turn);

  if (successAgents < options.requireSuccessAgents) {
    reasons.push(
      `success_agents ${successAgents} below required ${options.requireSuccessAgents}`
    );
  }
  if (openChannels > options.maxOpenChannels) {
    reasons.push(
      `open breaker channels ${openChannels} exceed max ${options.maxOpenChannels}`
    );
  }
  if (tripEvents.length > options.maxBreakerTripsPerCycle) {
    reasons.push(
      `trip_opened events ${tripEvents.length} exceed max ${options.maxBreakerTripsPerCycle}`
    );
  }
  if (timeoutTrips.length > options.maxTimeoutTripsPerCycle) {
    reasons.push(
      `timeout/deadline trips ${timeoutTrips.length} exceed max ${options.maxTimeoutTripsPerCycle}`
    );
  }
  if (adapterErrorRate > options.maxAdapterErrorRate) {
    reasons.push(
      `adapter error rate ${adapterErrorRate.toFixed(3)} exceeds max ${options.maxAdapterErrorRate.toFixed(3)}`
    );
  }
  if (turnFailureRate > options.maxTurnFailureRate) {
    reasons.push(
      `turn failure rate ${turnFailureRate.toFixed(3)} exceeds max ${options.maxTurnFailureRate.toFixed(3)}`
    );
  }
  if (activeTurnRunning) {
    reasons.push("workboard active turn still running after cycle completion");
  }
  if (runningTasks > options.maxRunningTasks) {
    reasons.push(`running task leases ${runningTasks} exceed max ${options.maxRunningTasks}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    snapshot: {
      cycle,
      success_agents: successAgents,
      total_agents: totalAgents,
      open_channels: openChannels,
      trip_events: tripEvents.length,
      timeout_trip_events: timeoutTrips.length,
      adapter_error_rate: adapterErrorRate,
      turn_failure_rate: turnFailureRate,
      running_tasks: runningTasks,
      active_turn_running: activeTurnRunning,
      selected_agent: cycleResult?.selected_agent ?? null,
      novelty_score: cycleResult?.novelty_score ?? null,
      consensus_latest_status: cycleResult?.consensus_latest_status ?? null,
      workboard_active_phase: cycleResult?.workboard_active_phase ?? null,
      decision_summary: compactSingleLine(cycleResult?.decision_summary ?? "", 220),
      gate_failures: reasons,
    },
  };
}

function parseOptions(cli) {
  const transport = String(cli.transport ?? process.env.TRICHAT_SOAK_TRANSPORT ?? "stdio").trim().toLowerCase();
  const hours = parseBoundedInt(cli.hours ?? process.env.TRICHAT_SOAK_HOURS, 1, 1, 4);
  const intervalSeconds = parseBoundedInt(
    cli["interval-seconds"] ?? process.env.TRICHAT_SOAK_INTERVAL_SECONDS,
    60,
    5,
    3600
  );
  const derivedCycles = Math.max(1, Math.floor((hours * 3600) / Math.max(1, intervalSeconds)));
  const maxCycles = parseBoundedInt(
    cli["max-cycles"] ?? process.env.TRICHAT_SOAK_MAX_CYCLES,
    derivedCycles,
    1,
    20_000
  );
  return {
    transport,
    url: String(cli.url ?? process.env.TRICHAT_SOAK_URL ?? "http://127.0.0.1:8787/"),
    origin: String(cli.origin ?? process.env.TRICHAT_SOAK_ORIGIN ?? "http://127.0.0.1"),
    stdioCommand: String(cli["stdio-command"] ?? process.env.TRICHAT_SOAK_STDIO_COMMAND ?? "node"),
    stdioArgs: String(cli["stdio-args"] ?? process.env.TRICHAT_SOAK_STDIO_ARGS ?? "dist/server.js"),
    hours,
    intervalSeconds,
    maxCycles,
    allowShort: parseBool(cli["allow-short"] ?? process.env.TRICHAT_SOAK_ALLOW_SHORT, false),
    execute: parseBool(cli.execute ?? process.env.TRICHAT_SOAK_EXECUTE, false),
    bridgeDryRun: parseBool(cli["bridge-dry-run"] ?? process.env.TRICHAT_SOAK_BRIDGE_DRY_RUN, true),
    prompt: String(cli.prompt ?? process.env.TRICHAT_SOAK_PROMPT ?? DEFAULT_PROMPT).trim() || DEFAULT_PROMPT,
    threadId: String(
      cli["thread-id"] ?? process.env.TRICHAT_SOAK_THREAD_ID ?? `trichat-soak-gate-${Math.floor(Date.now() / 1000)}`
    ).trim(),
    requireSuccessAgents: parseBoundedInt(
      cli["require-success-agents"] ?? process.env.TRICHAT_SOAK_REQUIRE_SUCCESS_AGENTS,
      2,
      1,
      3
    ),
    bridgeTimeoutSeconds: parseBoundedInt(
      cli["bridge-timeout"] ?? process.env.TRICHAT_SOAK_BRIDGE_TIMEOUT,
      120,
      5,
      7200
    ),
    maxOpenChannels: parseBoundedInt(
      cli["max-open-channels"] ?? process.env.TRICHAT_SOAK_MAX_OPEN_CHANNELS,
      0,
      0,
      100
    ),
    maxBreakerTripsPerCycle: parseBoundedInt(
      cli["max-breaker-trips-per-cycle"] ?? process.env.TRICHAT_SOAK_MAX_BREAKER_TRIPS_PER_CYCLE,
      3,
      0,
      100
    ),
    maxTimeoutTripsPerCycle: parseBoundedInt(
      cli["max-timeout-trips-per-cycle"] ?? process.env.TRICHAT_SOAK_MAX_TIMEOUT_TRIPS_PER_CYCLE,
      2,
      0,
      100
    ),
    maxAdapterErrorRate: parseBoundedFloat(
      cli["max-adapter-error-rate"] ?? process.env.TRICHAT_SOAK_MAX_ADAPTER_ERROR_RATE,
      0.35,
      0,
      1
    ),
    maxTurnFailureRate: parseBoundedFloat(
      cli["max-turn-failure-rate"] ?? process.env.TRICHAT_SOAK_MAX_TURN_FAILURE_RATE,
      0.35,
      0,
      1
    ),
    maxRunningTasks: parseBoundedInt(
      cli["max-running-tasks"] ?? process.env.TRICHAT_SOAK_MAX_RUNNING_TASKS,
      25,
      0,
      1000
    ),
    eventLimit: parseBoundedInt(cli["event-limit"] ?? process.env.TRICHAT_SOAK_EVENT_LIMIT, 400, 50, 20_000),
    sloWindowMinutes: parseBoundedInt(
      cli["slo-window-minutes"] ?? process.env.TRICHAT_SOAK_SLO_WINDOW_MINUTES,
      120,
      15,
      1440
    ),
    workboardSettleSeconds: parseBoundedInt(
      cli["workboard-settle-seconds"] ?? process.env.TRICHAT_SOAK_WORKBOARD_SETTLE_SECONDS,
      12,
      0,
      300
    ),
    cycleTimeoutSeconds: parseBoundedInt(
      cli["cycle-timeout-seconds"] ?? process.env.TRICHAT_SOAK_CYCLE_TIMEOUT_SECONDS,
      420,
      30,
      7200
    ),
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (parseBool(cli.help, false)) {
    printHelp();
    process.exit(0);
  }
  const options = parseOptions(cli);
  const requiredDurationMs = options.hours * 3600 * 1000;
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + requiredDurationMs;
  const mutation = mutationFactory(`trichat-soak-gate-${Math.floor(startedAtMs / 1000)}`);
  const client = new Client({ name: "anamnesis-trichat-soak-gate", version: "0.1.0" }, { capabilities: {} });
  const report = {
    ok: true,
    release_gate_passed: false,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: null,
    runtime_seconds: 0,
    required_duration_seconds: Math.floor(requiredDurationMs / 1000),
    allow_short: options.allowShort,
    thread_id: options.threadId,
    transport: options.transport,
    config: {
      hours: options.hours,
      interval_seconds: options.intervalSeconds,
      max_cycles: options.maxCycles,
      require_success_agents: options.requireSuccessAgents,
      bridge_timeout_seconds: options.bridgeTimeoutSeconds,
      execute: options.execute,
      bridge_dry_run: options.bridgeDryRun,
      max_open_channels: options.maxOpenChannels,
      max_breaker_trips_per_cycle: options.maxBreakerTripsPerCycle,
      max_timeout_trips_per_cycle: options.maxTimeoutTripsPerCycle,
      max_adapter_error_rate: options.maxAdapterErrorRate,
      max_turn_failure_rate: options.maxTurnFailureRate,
      max_running_tasks: options.maxRunningTasks,
      event_limit: options.eventLimit,
      slo_window_minutes: options.sloWindowMinutes,
      workboard_settle_seconds: options.workboardSettleSeconds,
    },
    cycles: [],
    failures: [],
  };

  try {
    await client.connect(createTransport(options));
    let cycle = 1;
    for (; cycle <= options.maxCycles; cycle += 1) {
      if (Date.now() >= deadlineMs && cycle > 1) {
        break;
      }
      const cycleStartedMs = Date.now();
      const cyclePrompt =
        options.maxCycles > 1
          ? `${options.prompt}\n\nSoak cycle marker: ${cycle}/${options.maxCycles}`
          : options.prompt;

      const dogfoodReport = await runDogfoodCycle(options, cycle, cyclePrompt);
      const cycleResult =
        Array.isArray(dogfoodReport?.cycles) && dogfoodReport.cycles.length > 0
          ? dogfoodReport.cycles[dogfoodReport.cycles.length - 1]
          : {};
      const turnId = String(cycleResult?.turn_id ?? "").trim();
      if (!options.execute && turnId) {
        await callTool(client, "trichat.turn_orchestrate", {
          mutation: mutation("trichat.turn_orchestrate.verify_finalize"),
          turn_id: turnId,
          action: "verify_finalize",
          verify_status: "skipped",
          verify_summary: "soak gate finalize (execute disabled)",
          verify_details: {
            source: "scripts/trichat_soak_gate.mjs",
            cycle,
            execute_enabled: false,
          },
        });
      }

      const adapterTelemetry = await callTool(client, "trichat.adapter_telemetry", {
        action: "status",
        event_limit: options.eventLimit,
      });
      const slo = await callTool(client, "trichat.slo", {
        action: "status",
        window_minutes: options.sloWindowMinutes,
        event_limit: options.eventLimit * 20,
      });
      const workboard = await waitForWorkboardSettled(
        client,
        options.threadId,
        options.workboardSettleSeconds
      );
      const taskSummary = await callTool(client, "task.summary", {
        running_limit: Math.max(10, options.maxRunningTasks * 2),
      });

      const evaluated = evaluateCycleHealth({
        cycle,
        cycleStartedMs,
        cycleResult,
        adapterTelemetry,
        slo,
        workboard,
        taskSummary,
        options,
      });
      report.cycles.push(evaluated.snapshot);
      process.stderr.write(
        `[soak] cycle=${cycle} success=${evaluated.snapshot.success_agents}/${evaluated.snapshot.total_agents} ` +
          `open=${evaluated.snapshot.open_channels} trips=${evaluated.snapshot.trip_events} ` +
          `timeout_trips=${evaluated.snapshot.timeout_trip_events} ` +
          `adapter_err=${evaluated.snapshot.adapter_error_rate.toFixed(3)} ` +
          `turn_fail=${evaluated.snapshot.turn_failure_rate.toFixed(3)} ` +
          `active_turn_running=${evaluated.snapshot.active_turn_running}\n`
      );

      if (!evaluated.ok) {
        report.ok = false;
        report.failures.push({
          cycle,
          reason: evaluated.reasons.join("; "),
        });
        break;
      }

      const elapsedMs = Date.now() - cycleStartedMs;
      const remainingToDeadlineMs = deadlineMs - Date.now();
      if (remainingToDeadlineMs <= 0) {
        break;
      }
      const sleepMs = Math.max(0, options.intervalSeconds * 1000 - elapsedMs);
      if (sleepMs > 0) {
        await sleep(Math.min(sleepMs, remainingToDeadlineMs));
      }
    }

    if (report.cycles.length === 0) {
      report.ok = false;
      report.failures.push({ cycle: 0, reason: "no soak cycles executed" });
    }

    const runtimeMs = Date.now() - startedAtMs;
    if (!options.allowShort && runtimeMs+500 < requiredDurationMs) {
      report.ok = false;
      report.failures.push({
        cycle: report.cycles.length,
        reason: `runtime ${Math.floor(runtimeMs / 1000)}s below required ${Math.floor(requiredDurationMs / 1000)}s`,
      });
    }
  } catch (error) {
    report.ok = false;
    report.failures.push({
      cycle: report.cycles.length,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const finishedAtMs = Date.now();
    report.finished_at = new Date(finishedAtMs).toISOString();
    report.runtime_seconds = Math.floor((finishedAtMs - startedAtMs) / 1000);
    report.release_gate_passed = report.ok;
    await client.close().catch(() => {});
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
