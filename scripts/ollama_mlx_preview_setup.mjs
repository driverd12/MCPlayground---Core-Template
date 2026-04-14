#!/usr/bin/env node

import os from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RECOMMENDED_MODEL = "qwen3.5:35b-a3b-coding-nvfp4";
const MIN_OLLAMA_VERSION = "0.19.0";
const MIN_RECOMMENDED_MEMORY_GB = 32;

function parseVersion(raw) {
  const match = String(raw || "").match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

function semverGte(actual, required) {
  if (!actual || !required) {
    return false;
  }
  const parse = (value) =>
    String(value)
      .split(".")
      .map((entry) => Number.parseInt(entry, 10) || 0);
  const left = parse(actual);
  const right = parse(required);
  const maxLength = Math.max(left.length, right.length, 3);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    if (leftValue > rightValue) {
      return true;
    }
    if (leftValue < rightValue) {
      return false;
    }
  }
  return true;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function runStreaming(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("[ollama:mlx:preview] Stop: this setup path is Apple Silicon only.");
  console.error("[ollama:mlx:preview] Use standard Ollama models on Linux/Windows, or the separate repo MLX lane where supported.");
  process.exit(1);
}

const totalMemoryGb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1));
const ollamaVersionResult = runCapture("ollama", ["--version"]);
if (ollamaVersionResult.status !== 0) {
  console.error("[ollama:mlx:preview] Stop: `ollama` is not available in PATH.");
  console.error("[ollama:mlx:preview] Install or upgrade Ollama first, then rerun this command.");
  process.exit(1);
}

const ollamaVersion = parseVersion(ollamaVersionResult.stdout || ollamaVersionResult.stderr);
if (!semverGte(ollamaVersion, MIN_OLLAMA_VERSION)) {
  console.error(
    `[ollama:mlx:preview] Stop: Ollama ${ollamaVersion || "unknown"} is below the required ${MIN_OLLAMA_VERSION} runtime floor for the Apple Silicon MLX preview.`
  );
  console.error("[ollama:mlx:preview] Upgrade Ollama first, then rerun this command.");
  process.exit(1);
}

if (totalMemoryGb <= MIN_RECOMMENDED_MEMORY_GB) {
  console.warn(
    `[ollama:mlx:preview] Warning: unified memory is ${totalMemoryGb} GB. Ollama's MLX preview guidance recommends more than ${MIN_RECOMMENDED_MEMORY_GB} GB for ${RECOMMENDED_MODEL}.`
  );
}

console.log(`[ollama:mlx:preview] Pulling ${RECOMMENDED_MODEL}`);
runStreaming("ollama", ["pull", RECOMMENDED_MODEL]);

console.log(`[ollama:mlx:preview] pull complete for ${RECOMMENDED_MODEL}`);
console.log("[ollama:mlx:preview] model promotion is now gated behind the post-pull capability soak");

if (String(process.env.OLLAMA_MLX_SKIP_POSTPULL || "").trim() !== "1") {
  console.log("[ollama:mlx:preview] starting post-pull capability soak and imprint pipeline");
  runStreaming(process.execPath, [resolve(ROOT, "scripts", "ollama_mlx_postpull.mjs"), "--model", RECOMMENDED_MODEL]);
} else {
  console.log("[ollama:mlx:preview] post-pull gate was skipped; the active local model was not changed");
}
