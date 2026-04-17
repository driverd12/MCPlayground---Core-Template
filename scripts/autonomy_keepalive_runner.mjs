#!/usr/bin/env node
import process from "node:process";
import {
  loadRunnerEnv,
  parseIntValue,
  repoRootFromMeta,
  resolveTransport,
} from "./mcp_runner_support.mjs";
import { runAutonomyKeepaliveOnce } from "./autonomy_keepalive_lib.mjs";

const repoRoot = repoRootFromMeta(import.meta.url);
loadRunnerEnv(repoRoot);

const transport = resolveTransport(repoRoot);
process.env.TRICHAT_RING_LEADER_TRANSPORT = transport;
process.env.MCP_TOOL_CALL_TIMEOUT_MS ||= String(
  parseIntValue(process.env.AUTONOMY_KEEPALIVE_TOOL_TIMEOUT_MS, transport === "http" ? 180000 : 240000, 1000, 300000)
);

async function main() {
  const result = await runAutonomyKeepaliveOnce({
    repoRoot,
    transport,
    env: process.env,
    now: Date.now(),
    pid: process.pid,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result && typeof result === "object" && !Array.isArray(result) && result.ok === false) {
    process.exit(Number.isInteger(result.exit_code) && result.exit_code > 0 ? result.exit_code : 1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
