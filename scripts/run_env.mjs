#!/usr/bin/env node
import process from "node:process";
import { spawnStreaming } from "./cross_platform_exec.mjs";

function usage() {
  process.stderr.write("usage: run_env.mjs KEY=value [KEY=value ...] -- command [args...]\n");
}

function parseArgs(rawArgs) {
  const separator = rawArgs.indexOf("--");
  if (separator < 0) {
    throw new Error("missing -- separator before command");
  }

  const assignments = rawArgs.slice(0, separator);
  const command = rawArgs[separator + 1];
  const args = rawArgs.slice(separator + 2);
  if (!command) {
    throw new Error("missing command after --");
  }

  const env = { ...process.env };
  for (const assignment of assignments) {
    const match = String(assignment).match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      throw new Error(`invalid environment assignment: ${assignment}`);
    }
    env[match[1]] = match[2];
  }

  return { env, command, args };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  process.stderr.write(`run_env.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

try {
  const { env, command, args } = parsed;
  const result = spawnStreaming(command, args, { env, cwd: process.cwd() });
  if (result.signal) {
    process.stderr.write(`run_env.mjs: command terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
} catch (error) {
  process.stderr.write(`run_env.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
