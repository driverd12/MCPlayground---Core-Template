#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHECK_ONLY = process.argv.includes("--check-only");
const FORCE_INSTALL = process.argv.includes("--force-install");
const FORCE_BUILD = process.argv.includes("--build");
const INSTALL_MISSING = process.argv.includes("--install-missing");
const IS_WIN = process.platform === "win32";

function readTrimmed(filePath) {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseVersion(raw) {
  const match = String(raw || "").match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || result.stderr || "").trim();
}

function runStreaming(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function versionMatchesNodePin(actual, pin) {
  if (!actual || !pin) {
    return true;
  }
  const actualMajor = String(actual).split(".")[0];
  const pinMajor = String(pin).split(".")[0];
  return actualMajor === pinMajor;
}

function versionMatchesPrefix(actual, pinPrefix) {
  if (!actual || !pinPrefix) {
    return true;
  }
  return actual === pinPrefix || actual.startsWith(`${pinPrefix}.`);
}

function semverGte(actual, required) {
  if (!actual || !required) {
    return true;
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

function detectPythonVersion() {
  const candidates = IS_WIN
    ? [
        ["py", ["-3", "--version"]],
        ["python", ["--version"]],
        ["python3", ["--version"]],
      ]
    : [
        ["/opt/homebrew/bin/python3", ["--version"]],
        ["/usr/local/bin/python3", ["--version"]],
        ["python3", ["--version"]],
      ];
  for (const [command, args] of candidates) {
    const output = runCapture(command, args);
    const version = parseVersion(output);
    if (version) {
      return { command, version, raw: output };
    }
  }
  return null;
}

function platformHint(entry) {
  return entry?.install_hint?.[process.platform] || entry?.install_hint?.linux || null;
}

const manifest = loadJson(resolve(ROOT, "scripts", "platform_manifest.json"));
const packageJson = loadJson(resolve(ROOT, "package.json"));
const nodePin = readTrimmed(resolve(ROOT, ".nvmrc")) || "22";
const pythonPin = readTrimmed(resolve(ROOT, ".python-version")) || "3.12";
const packageManager = String(packageJson.packageManager || "").trim();
const npmPinMatch = packageManager.match(/^npm@(.+)$/);
const npmPin = npmPinMatch ? npmPinMatch[1] : "";

const prereqByName = new Map(
  [
    ...(Array.isArray(manifest?.prerequisites?.required) ? manifest.prerequisites.required : []),
    ...(Array.isArray(manifest?.prerequisites?.recommended) ? manifest.prerequisites.recommended : []),
  ].map((entry) => [entry.name, entry])
);

const nodeVersion = String(process.version || "").replace(/^v/, "");
const npmVersion = parseVersion(runCapture(IS_WIN ? "npm.cmd" : "npm", ["--version"])) || "";
const python = detectPythonVersion();

const checks = [
  {
    name: "node",
    version: nodeVersion,
    expected: `${nodePin}.x`,
    ok: versionMatchesNodePin(nodeVersion, nodePin),
    hint: platformHint(prereqByName.get("node")),
  },
  {
    name: "npm",
    version: npmVersion,
    expected: npmPin || "manifest default",
    ok: versionMatchesPrefix(npmVersion, npmPin),
    hint:
      platformHint(prereqByName.get("npm")) ||
      (npmPin ? `npm install -g npm@${npmPin}` : null),
  },
  {
    name: "python3",
    version: python?.version || "",
    expected: `>=${pythonPin}`,
    ok: semverGte(python?.version || "", pythonPin),
    hint: platformHint(prereqByName.get("python3")),
    command: python?.command || "python3",
  },
];

console.log("");
console.log("[bootstrap:env] Runtime pins");
for (const check of checks) {
  const suffix = check.command ? ` via ${check.command}` : "";
  if (check.ok) {
    console.log(`  ✓ ${check.name} ${check.version}${suffix} (expected ${check.expected})`);
  } else {
    console.log(`  ✗ ${check.name} ${check.version || "missing"}${suffix} (expected ${check.expected})`);
    if (check.hint) {
      console.log(`    remediation: ${check.hint}`);
    }
  }
}

const failedChecks = checks.filter((check) => !check.ok);
if (failedChecks.length > 0) {
  console.log("");
  if (INSTALL_MISSING) {
    console.log("[bootstrap:env] Installing missing pinned prerequisites before continuing.");
    runStreaming(process.execPath, [resolve(ROOT, "scripts", "bootstrap_install.mjs"), "--apply", "--required-only"]);
    runStreaming(process.execPath, [resolve(ROOT, "scripts", "bootstrap_env.mjs")]);
    process.exit(0);
  }
  console.log("[bootstrap:env] Stop: runtime prerequisites do not match the repo pins.");
  console.log("[bootstrap:env] Next step: run `npm run bootstrap:env:install` to install the missing pinned prerequisites automatically.");
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log("");
  console.log("[bootstrap:env] Runtime checks passed.");
  process.exit(0);
}

mkdirSync(resolve(ROOT, "data", "imprint", "office_snapshot_cache", "web"), { recursive: true });
mkdirSync(resolve(ROOT, "data", "imprint", "office_snapshot_cache", "dashboard"), { recursive: true });

if (!existsSync(resolve(ROOT, ".env")) && existsSync(resolve(ROOT, ".env.example"))) {
  copyFileSync(resolve(ROOT, ".env.example"), resolve(ROOT, ".env"));
  console.log("[bootstrap:env] Created .env from .env.example");
}

if (FORCE_INSTALL || !existsSync(resolve(ROOT, "node_modules"))) {
  console.log("[bootstrap:env] Installing npm dependencies");
  runStreaming(IS_WIN ? "npm.cmd" : "npm", ["ci"]);
} else {
  console.log("[bootstrap:env] npm dependencies already present");
}

if (FORCE_BUILD || !existsSync(resolve(ROOT, "dist", "server.js"))) {
  console.log("[bootstrap:env] Building dist output");
  runStreaming(IS_WIN ? "npm.cmd" : "npm", ["run", "build"]);
} else {
  console.log("[bootstrap:env] dist/server.js already present");
}

console.log("[bootstrap:env] Running bootstrap doctor");
runStreaming(process.execPath, [resolve(ROOT, "scripts", "bootstrap_doctor.mjs")]);
