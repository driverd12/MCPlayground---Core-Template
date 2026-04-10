import { spawnSync } from "node:child_process";
import process from "node:process";

export function commandSucceeds(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: "ignore",
    timeout: options.timeoutMs || 3000,
    windowsHide: true,
  });
  return result.status === 0;
}

export function resolvePythonCommand(env = process.env) {
  if (env.PYTHON_BIN) {
    return { command: env.PYTHON_BIN, argsPrefix: [] };
  }

  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", argsPrefix: ["-3"] },
          { command: "python", argsPrefix: [] },
          { command: "python3", argsPrefix: [] },
        ]
      : [
          { command: "python3", argsPrefix: [] },
          { command: "/opt/homebrew/bin/python3", argsPrefix: [] },
          { command: "/usr/local/bin/python3", argsPrefix: [] },
          { command: "python", argsPrefix: [] },
        ];

  for (const candidate of candidates) {
    if (commandSucceeds(candidate.command, [...candidate.argsPrefix, "--version"], { env })) {
      return candidate;
    }
  }

  return { command: process.platform === "win32" ? "python" : "python3", argsPrefix: [] };
}

export function resolveScriptCommand(command, env = process.env) {
  if (command === "node") {
    return { command: process.execPath, argsPrefix: [] };
  }
  if (command === "npm" && process.platform === "win32") {
    return { command: "npm.cmd", argsPrefix: [] };
  }
  if (command === "python3" || command === "python") {
    return resolvePythonCommand(env);
  }
  return { command, argsPrefix: [] };
}

export function spawnStreaming(command, args = [], options = {}) {
  const env = options.env || process.env;
  const resolved = resolveScriptCommand(command, env);
  const result = spawnSync(resolved.command, [...resolved.argsPrefix, ...args], {
    cwd: options.cwd || process.cwd(),
    env,
    stdio: options.stdio || "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}
