#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PLAN_ONLY = process.argv.includes("--plan");
const APPLY = process.argv.includes("--apply") || !PLAN_ONLY;
const REQUIRED_ONLY = process.argv.includes("--required-only");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readTrimmed(filePath, fallback = "") {
  try {
    return readFileSync(filePath, "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
}

function parseVersion(raw) {
  const match = String(raw || "").match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: options.shell === true,
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || result.stderr || "").trim();
}

function runShell(command) {
  const result = spawnSync(command, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`installer command failed: ${command}`);
  }
}

function detectLinuxDistribution() {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const raw = readFileSync("/etc/os-release", "utf8");
    const fields = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) continue;
      fields[match[1]] = match[2].replace(/^"/, "").replace(/"$/, "");
    }
    const id = String(fields.ID || "").toLowerCase();
    const like = String(fields.ID_LIKE || "").toLowerCase();
    if (id === "ubuntu" || like.includes("ubuntu") || like.includes("debian")) {
      return "ubuntu";
    }
    if (id === "rocky" || like.includes("rhel") || like.includes("fedora")) {
      return "rocky";
    }
    if (id === "amzn" || id === "amazon" || like.includes("amzn") || like.includes("amazon")) {
      return "amazon-linux";
    }
  } catch {}
  return "default";
}

function versionMatchesNodePin(actual, pin) {
  if (!actual || !pin) {
    return true;
  }
  return String(actual).split(".")[0] === String(pin).split(".")[0];
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
  const parse = (value) => String(value).split(".").map((entry) => Number.parseInt(entry, 10) || 0);
  const left = parse(actual);
  const right = parse(required);
  const maxLength = Math.max(left.length, right.length, 3);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    if (leftValue > rightValue) return true;
    if (leftValue < rightValue) return false;
  }
  return true;
}

function detectPythonVersion() {
  const isWin = process.platform === "win32";
  const candidates = isWin
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
      return { command, version };
    }
  }
  return null;
}

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  return Boolean(runCapture(lookup, [command]));
}

function checkManager(profile) {
  const command = String(profile?.manager_check || "").trim();
  if (!command) {
    return true;
  }
  return Boolean(runCapture(command, [], { shell: true }));
}

const manifest = readJson(resolve(ROOT, "scripts", "platform_manifest.json"));
const packageJson = readJson(resolve(ROOT, "package.json"));
const nodePin = readTrimmed(resolve(ROOT, ".nvmrc"), "22");
const pythonPin = readTrimmed(resolve(ROOT, ".python-version"), "3.12.0");
const npmPinMatch = String(packageJson.packageManager || "").match(/^npm@(.+)$/);
const npmPin = npmPinMatch ? npmPinMatch[1] : "";

const nodeVersion = String(process.version || "").replace(/^v/, "");
const npmVersion = parseVersion(runCapture(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"])) || "";
const python = detectPythonVersion();
const linuxDistro = detectLinuxDistribution();

const profile =
  process.platform === "linux"
    ? manifest?.bootstrap_install?.linux?.[linuxDistro || "default"] || manifest?.bootstrap_install?.linux?.default || null
    : manifest?.bootstrap_install?.[process.platform] || null;

if (!profile) {
  console.error(`[bootstrap:install] No install profile is defined for ${process.platform}${linuxDistro ? `/${linuxDistro}` : ""}.`);
  process.exit(1);
}

const requiredPrereqs = Array.isArray(manifest?.prerequisites?.required) ? manifest.prerequisites.required : [];
const recommendedPrereqs = Array.isArray(manifest?.prerequisites?.recommended) ? manifest.prerequisites.recommended : [];
const prereqs = REQUIRED_ONLY ? requiredPrereqs : [...requiredPrereqs, ...recommendedPrereqs];

function needsInstall(name, item) {
  if (name === "node") {
    return !versionMatchesNodePin(nodeVersion, nodePin);
  }
  if (name === "npm") {
    return !versionMatchesPrefix(npmVersion, npmPin);
  }
  if (name === "python3") {
    return !semverGte(python?.version || "", pythonPin);
  }
  if (process.platform === "win32" && name === "tmux") {
    return false;
  }
  const check = String(item?.check || "").trim();
  if (!check) {
    return false;
  }
  return !Boolean(runCapture(check, [], { shell: true }));
}

const commands = [];
const seen = new Set();

for (const item of prereqs) {
  const name = String(item?.name || "").trim();
  if (!name || !needsInstall(name, item)) {
    continue;
  }
  const command = profile?.commands?.[name];
  if (!command) {
    continue;
  }
  if (!seen.has(command)) {
    seen.add(command);
    commands.push({
      name,
      command,
      reason: name === "npm" ? `pin npm to ${npmPin}` : `install or align ${name}`,
    });
  }
}

console.log("");
console.log(
  `[bootstrap:install] Platform profile: ${process.platform}${linuxDistro ? `/${linuxDistro}` : ""} via ${profile.manager_label || "system installer"}`
);

if (!checkManager(profile)) {
  console.log(
    `[bootstrap:install] Stop: ${profile.manager_label || "package manager"} is not available. ${profile.manager_hint || ""}`.trim()
  );
  process.exit(1);
}

if (commands.length === 0) {
  console.log("[bootstrap:install] No missing pinned runtime or launcher prerequisites were detected.");
  console.log("[bootstrap:install] Run `npm run bootstrap:env` to complete repo bootstrap.");
  process.exit(0);
}

console.log("[bootstrap:install] Planned actions:");
for (const entry of commands) {
  console.log(`  - ${entry.reason}: ${entry.command}`);
}

if (PLAN_ONLY) {
  console.log("[bootstrap:install] Plan only; no commands were executed.");
  process.exit(0);
}

for (const entry of commands) {
  console.log(`[bootstrap:install] ${entry.reason}`);
  runShell(entry.command);
}

console.log("[bootstrap:install] Rechecking pinned runtime after install...");
const checkResult = spawnSync(process.execPath, [resolve(ROOT, "scripts", "bootstrap_env.mjs"), "--check-only"], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});
process.exit(checkResult.status ?? 0);
