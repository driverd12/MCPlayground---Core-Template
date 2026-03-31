#!/usr/bin/env node
import process from "node:process";
import {
  callTool,
  loadRunnerEnv,
  parseBoolean,
  parseIntValue,
  repoRootFromMeta,
  resolveTransport,
  waitForHttpReady,
} from "./mcp_runner_support.mjs";

const repoRoot = repoRootFromMeta(import.meta.url);
loadRunnerEnv(repoRoot);

const transport = resolveTransport(repoRoot);
process.env.TRICHAT_RING_LEADER_TRANSPORT = transport;

const now = Date.now();
const args = {
  action: "run",
  mutation: {
    idempotency_key: `autonomy-maintain-run-${now}-${process.pid}`,
    side_effect_fingerprint: `autonomy-maintain-run-${now}-${process.pid}`,
  },
  interval_seconds: parseIntValue(process.env.AUTONOMY_KEEPALIVE_INTERVAL_SECONDS, 120, 5, 3600),
  learning_review_interval_seconds: parseIntValue(
    process.env.AUTONOMY_LEARNING_REVIEW_INTERVAL_SECONDS,
    300,
    60,
    604800
  ),
  eval_interval_seconds: parseIntValue(process.env.AUTONOMY_EVAL_INTERVAL_SECONDS, 21600, 300, 604800),
  bootstrap_run_immediately: parseBoolean(process.env.AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY, false),
  autostart_ring_leader: parseBoolean(process.env.TRICHAT_RING_LEADER_AUTOSTART, true),
  ensure_bootstrap: true,
  start_goal_autorun_daemon: true,
  maintain_tmux_controller: true,
  run_eval_if_due: true,
  eval_suite_id: "autonomy.control-plane",
  minimum_eval_score: 75,
  refresh_learning_summary: true,
  publish_runtime_event: true,
  source_client: "autonomy.keepalive.launchd",
};

async function main() {
  if (transport === "http") {
    const ready = await waitForHttpReady(repoRoot, {
      timeoutMs: parseIntValue(process.env.AUTONOMY_KEEPALIVE_HTTP_READY_TIMEOUT_MS, 20000, 1000, 120000),
      intervalMs: 500,
    });
    if (!ready) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          skipped: true,
          reason: "http_not_ready",
          source_client: "autonomy.keepalive.launchd",
        })}\n`
      );
      return;
    }
  }

  const result = callTool(repoRoot, {
    tool: "autonomy.maintain",
    args,
    transport,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
