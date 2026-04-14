#!/usr/bin/env node
// bootstrap_doctor.mjs — Cross-platform bootstrap health check
// Reads scripts/platform_manifest.json and validates the local environment.
// Usage: node scripts/bootstrap_doctor.mjs
// Exit 0 = all required checks pass, 1 = at least one required check failed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Repo root ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const HTTP_BEARER_TOKEN_PATH = resolve(ROOT, "data", "imprint", "http_bearer_token");

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const isColorSupported =
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR || process.stdout.isTTY);

const c = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  red: isColorSupported ? "\x1b[31m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
};

const PASS = `${c.green}\u2713${c.reset}`;
const FAIL = `${c.red}\u2717${c.reset}`;
const WARN = `${c.yellow}\u25CB${c.reset}`;

function write(line) {
  process.stdout.write(line + "\n");
}

// ── Load manifest ────────────────────────────────────────────────────────────
const manifestPath = resolve(ROOT, "scripts", "platform_manifest.json");
if (!existsSync(manifestPath)) {
  write(
    `${c.red}[doctor] ERROR: platform manifest not found at ${manifestPath}${c.reset}`
  );
  write(
    `${c.dim}         Expected scripts/platform_manifest.json in the repo root.${c.reset}`
  );
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
} catch (err) {
  write(
    `${c.red}[doctor] ERROR: failed to parse platform manifest: ${err.message}${c.reset}`
  );
  process.exit(1);
}

// ── Platform detection ───────────────────────────────────────────────────────
const platform = process.platform; // darwin | linux | win32
const arch = process.arch; // arm64 | x64 | ...

function detectLinuxDistribution() {
  if (platform !== "linux") {
    return null;
  }
  try {
    const raw = readFileSync("/etc/os-release", "utf8");
    const fields = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) {
        continue;
      }
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
  return "linux-generic";
}

const linuxDistribution = detectLinuxDistribution();
const pinnedNodeVersion = readFileSync(resolve(ROOT, ".nvmrc"), "utf8").trim();
const pinnedPythonVersion = existsSync(resolve(ROOT, ".python-version"))
  ? readFileSync(resolve(ROOT, ".python-version"), "utf8").trim()
  : "";
const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const pinnedNpmVersion = String(packageJson.packageManager || "").startsWith("npm@")
  ? String(packageJson.packageManager).slice("npm@".length)
  : "";

write("");
write(
  `${c.bold}[doctor]${c.reset} Platform: ${c.cyan}${platform}${linuxDistribution ? `/${linuxDistribution}` : ""} ${arch}${c.reset}`
);
write(
  `${c.bold}[doctor]${c.reset} Runtime pins: node ${pinnedNodeVersion}.x${pinnedNpmVersion ? ` | npm ${pinnedNpmVersion}` : ""}${pinnedPythonVersion ? ` | python ${pinnedPythonVersion}.x` : ""}`
);

// ── Utility: split a command string respecting simple quoting ────────────────
function shellSplit(cmd) {
  const tokens = [];
  let current = "";
  let inQuote = null;
  for (const ch of cmd) {
    if (!inQuote && (ch === '"' || ch === "'")) { inQuote = ch; continue; }
    if (ch === inQuote) { inQuote = null; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (current.length) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current.length) tokens.push(current);
  return tokens;
}

// ── Utility: run a command and return trimmed stdout, or null on failure ─────
function run(cmd) {
  // Parse command safely: first token is the binary, rest are individual args.
  // Using shellSplit avoids breakage when paths contain spaces (e.g. Windows
  // program-files paths or quoted arguments in the manifest check commands).
  const parts = shellSplit(cmd);
  const bin = parts[0];
  const args = parts.slice(1);
  try {
    const stdout = execFileSync(bin, args, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      // On Windows, use shell so that `where` etc. resolve correctly
      shell: platform === "win32",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function runFirst(commands) {
  for (const command of commands) {
    const output = run(command);
    if (output !== null) {
      return output;
    }
  }
  return null;
}

// ── Utility: check if output matches a version_pattern gate ──────────────────
function matchesVersionPattern(output, patternStr) {
  if (!output || !patternStr) return true;
  return new RegExp(patternStr).test(output);
}

// ── Utility: extract a displayable version string from command output ─────────
function extractVersion(output) {
  if (!output) return null;
  // Grab first semver-ish token (e.g. "v22.12.0" -> "22.12.0", "Python 3.12.4" -> "3.12.4")
  const m = output.match(/(\d+\.\d+[\w.-]*)/);
  return m ? m[1] : null;
}

function resolveWin32ProgramFilesPath(relativePath) {
  if (platform !== "win32" || typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return null;
  }
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  for (const root of roots) {
    const candidate = resolve(root, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveWin32LocalAppDataPath(relativePath) {
  if (platform !== "win32" || typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return null;
  }
  const root = process.env.LOCALAPPDATA;
  if (!root) {
    return null;
  }
  const candidate = resolve(root, relativePath);
  return existsSync(candidate) ? candidate : null;
}

function resolveWin32RegistryPath(registryPath) {
  if (platform !== "win32" || typeof registryPath !== "string" || registryPath.trim().length === 0) {
    return null;
  }
  const output = run(`reg query "${registryPath}" /ve`);
  if (!output) {
    return null;
  }
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /\bREG_(SZ|EXPAND_SZ)\b/i.test(entry));
  if (!line) {
    return null;
  }
  const parts = line.split(/\s{2,}/).filter(Boolean);
  const candidate = parts[parts.length - 1];
  return candidate && existsSync(candidate) ? candidate : null;
}

// ── Utility: compare semver loosely (major.minor.patch) ──────────────────────
function semverGte(actual, required) {
  if (!actual || !required) return true; // skip if we can't compare
  const parse = (v) =>
    v
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = parse(actual);
  const r = parse(required);
  for (let i = 0; i < 3; i++) {
    const av = a[i] || 0;
    const rv = r[i] || 0;
    if (av > rv) return true;
    if (av < rv) return false;
  }
  return true; // equal
}

// ── Check prerequisites ──────────────────────────────────────────────────────
let requiredFails = 0;
let recommendedMissing = 0;
let launcherDegraded = false;
const toolCheckResults = new Map();

function checkPrereq(item, isRequired) {
  let output = run(item.check);
  const version = extractVersion(output);
  const hint =
    item.install_hint && item.install_hint[platform]
      ? item.install_hint[platform]
      : null;

  if (output === null && item.name === "python3" && platform === "win32") {
    output = runFirst(["py -3 --version", "python --version", "python3 --version"]);
  }

  if (output === null && item.name === "python3" && platform !== "win32") {
    output = runFirst(["/opt/homebrew/bin/python3 --version", "/usr/local/bin/python3 --version"]);
  }

  toolCheckResults.set(item.name, {
    output,
    version: extractVersion(output),
    required: isRequired,
  });

  if (output === null) {
    // Not found
    if (isRequired) {
      requiredFails++;
      if (item.name === "git" && platform === "darwin" && existsSync("/usr/bin/git")) {
        write(`  ${FAIL} ${item.name} ${c.red}(installed but blocked \u2014 accept the Xcode license to use git)${c.reset}`);
        return;
      }
      const hintStr = hint ? ` \u2014 ${hint}` : "";
      write(`  ${FAIL} ${item.name} ${c.red}(not installed${hintStr})${c.reset}`);
    } else {
      recommendedMissing++;
      const hintStr = hint ? ` \u2014 ${hint}` : "";
      write(`  ${WARN} ${item.name} ${c.yellow}(not installed${hintStr})${c.reset}`);
    }
    return;
  }

  const resolvedVersion = extractVersion(output);

  // Found — build display string
  const versionStr = resolvedVersion || "";
  const minStr = item.min_version
    ? ` ${c.dim}(required \u2265${item.min_version})${c.reset}`
    : "";

  // Check version_pattern gate (e.g. node must be v20-v22)
  if (
    item.version_pattern &&
    !matchesVersionPattern(output, item.version_pattern)
  ) {
    if (isRequired) {
      requiredFails++;
      const hintStr = hint ? ` \u2014 ${hint}` : "";
      write(
        `  ${FAIL} ${item.name} ${c.red}${versionStr} (version not supported${hintStr})${c.reset}`
      );
    } else {
      recommendedMissing++;
      write(
        `  ${WARN} ${item.name} ${c.yellow}${versionStr} (version not supported)${c.reset}`
      );
    }
    return;
  }

  if (item.min_version && resolvedVersion && !semverGte(resolvedVersion, item.min_version)) {
    // Version too low
    if (isRequired) {
      requiredFails++;
      write(
        `  ${FAIL} ${item.name} ${c.red}${versionStr}${c.reset}${minStr} ${c.red}— update required${c.reset}`
      );
    } else {
      recommendedMissing++;
      write(
        `  ${WARN} ${item.name} ${c.yellow}${versionStr}${c.reset}${minStr}`
      );
    }
    return;
  }

  // All good
  if (isRequired) {
    write(`  ${PASS} ${item.name} ${versionStr}${minStr}`);
  } else {
    write(`  ${PASS} ${item.name} ${versionStr} ${c.dim}(recommended)${c.reset}`);
  }
}

function reportAppleSiliconMlxAdvisory() {
  if (platform !== "darwin" || arch !== "arm64") {
    return;
  }
  const ollamaResult = toolCheckResults.get("ollama");
  if (!ollamaResult?.output) {
    return;
  }

  write(`${c.bold}[doctor]${c.reset} Apple Silicon MLX:`);
  const ollamaVersion = ollamaResult.version;
  const totalMemoryGb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1));
  const requiredMemoryGb = 32;
  const recommendedModel = "qwen3.5:35b-a3b-coding-nvfp4";

  if (!ollamaVersion || !semverGte(ollamaVersion, "0.19.0")) {
    write(
      `  ${WARN} Ollama ${c.yellow}${ollamaVersion || "unknown"}${c.reset} ${c.yellow}(MLX preview from the March 30, 2026 Ollama post requires 0.19+ on Apple Silicon)${c.reset}`
    );
  } else {
    write(`  ${PASS} Ollama ${ollamaVersion} ${c.dim}(meets MLX preview runtime floor)${c.reset}`);
  }

  if (totalMemoryGb < requiredMemoryGb) {
    write(
      `  ${WARN} unified memory ${c.yellow}${totalMemoryGb} GB${c.reset} ${c.yellow}(the Ollama MLX preview post recommends more than 32 GB for ${recommendedModel})${c.reset}`
    );
  } else {
    write(`  ${PASS} unified memory ${totalMemoryGb} GB ${c.dim}(satisfies the >32 GB MLX preview guidance)${c.reset}`);
  }

  write(`  ${PASS} recommended model ${c.dim}(${recommendedModel})${c.reset}`);
  write(`  ${c.dim}Setup path: after upgrading Ollama to 0.19+, run \`npm run ollama:mlx:preview\` on Apple Silicon to pull the model and set it as the preferred local Ollama backend.${c.reset}`);
}

function findManifestTool(name) {
  const all = [
    ...(Array.isArray(manifest?.prerequisites?.required) ? manifest.prerequisites.required : []),
    ...(Array.isArray(manifest?.prerequisites?.recommended) ? manifest.prerequisites.recommended : []),
  ];
  return all.find((entry) => entry?.name === name) || null;
}

function toolCheckCommand(name) {
  const item = findManifestTool(name);
  if (item?.check) {
    return item.check;
  }
  if (platform === "win32") {
    return `where ${name}`;
  }
  return `which ${name}`;
}

function toolInstallHint(name) {
  const item = findManifestTool(name);
  return item?.install_hint?.[platform] || null;
}

function checkLauncherTool(name, isRequired, reason) {
  const output = run(toolCheckCommand(name));
  const hint = toolInstallHint(name);
  if (output === null) {
    const hintStr = hint ? ` — ${hint}` : "";
    if (isRequired) {
      requiredFails++;
      launcherDegraded = true;
      write(`  ${FAIL} ${name} ${c.red}(needed for ${reason}${hintStr})${c.reset}`);
    } else {
      recommendedMissing++;
      launcherDegraded = true;
      write(`  ${WARN} ${name} ${c.yellow}(recommended for ${reason}${hintStr})${c.reset}`);
    }
    return;
  }
  const firstLine = String(output).split(/\r?\n/)[0];
  const label = isRequired ? PASS : PASS;
  const suffix = isRequired ? "" : ` ${c.dim}(fallback)${c.reset}`;
  write(`  ${label} ${name} ${c.dim}(${firstLine})${c.reset}${suffix}`);
}

function reportLauncherSection(label, launcherKey, fallbackEntrypoint) {
  write(`${c.bold}[doctor]${c.reset} ${label}:`);
  const launcherConfig = manifest?.launchers?.[launcherKey]?.[platform] || null;
  const entrypoint =
    typeof launcherConfig?.entrypoint === "string" && launcherConfig.entrypoint.trim().length > 0
      ? launcherConfig.entrypoint.trim()
      : fallbackEntrypoint;
  const entrypointPath = entrypoint.startsWith("node ./")
    ? resolve(ROOT, entrypoint.slice("node ./".length))
    : resolve(ROOT, "scripts");
  if (!existsSync(entrypointPath)) {
    launcherDegraded = true;
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}${entrypoint} missing${c.reset}`);
    return;
  }
  if (!launcherConfig || launcherConfig.supported !== true) {
    launcherDegraded = true;
    recommendedMissing++;
    const reason =
      launcherConfig && typeof launcherConfig.reason === "string" && launcherConfig.reason.trim().length > 0
        ? launcherConfig.reason.trim()
        : "launcher support is not declared for this host";
    write(`  ${WARN} ${c.yellow}${reason}${c.reset}`);
    return;
  }
  const serviceMode =
    typeof launcherConfig.service_mode === "string" && launcherConfig.service_mode.trim().length > 0
      ? launcherConfig.service_mode.trim()
      : "runner";
  const visibleSurface =
    typeof launcherConfig.visible_surface === "string" && launcherConfig.visible_surface.trim().length > 0
      ? launcherConfig.visible_surface.trim()
      : "browser-status";
  write(`  ${PASS} native launcher ${c.dim}(${entrypoint}; mode=${serviceMode}; surface=${visibleSurface})${c.reset}`);
  if (platform === "linux" && Array.isArray(launcherConfig.supported_distributions) && launcherConfig.supported_distributions.length > 0) {
    if (!linuxDistribution || !launcherConfig.supported_distributions.includes(linuxDistribution)) {
      launcherDegraded = true;
      recommendedMissing++;
      write(
        `  ${WARN} ${c.yellow}current distro ${linuxDistribution ?? "unknown"} is outside the primary support set (${launcherConfig.supported_distributions.join(", ")})${c.reset}`
      );
    } else {
      write(`  ${PASS} distro ${linuxDistribution} ${c.dim}(primary Linux support target)${c.reset}`);
    }
  }
  for (const tool of Array.isArray(launcherConfig.required_tools) ? launcherConfig.required_tools : []) {
    checkLauncherTool(tool, true, `${launcherKey} launcher`);
  }
  for (const tool of Array.isArray(launcherConfig.recommended_tools) ? launcherConfig.recommended_tools : []) {
    checkLauncherTool(tool, false, `${launcherKey} launcher fallback`);
  }
}

function detectBrowserEntry(browser) {
  if (browser.app_path && existsSync(browser.app_path)) {
    return browser.app_path;
  }
  if (platform === "win32") {
    const registryPath = resolveWin32RegistryPath(browser.registry_path);
    if (registryPath) {
      return registryPath;
    }
    const programFilesPath = resolveWin32ProgramFilesPath(browser.program_files_path);
    if (programFilesPath) {
      return programFilesPath;
    }
    const localAppDataPath = resolveWin32LocalAppDataPath(browser.local_app_data_path);
    if (localAppDataPath) {
      return localAppDataPath;
    }
  }
  if (browser.binary) {
    const lookup = platform === "win32" ? `where ${browser.binary}` : `which ${browser.binary}`;
    const output = run(lookup);
    if (output) {
      return output.split(/\r?\n/)[0];
    }
  }
  return null;
}

function bootstrapInstallSuggestion() {
  const bootstrapProfile = platform === "linux"
    ? manifest?.bootstrap_install?.linux?.[linuxDistribution || "default"] || manifest?.bootstrap_install?.linux?.default || null
    : manifest?.bootstrap_install?.[platform] || null;
  if (!bootstrapProfile) {
    return null;
  }
  return "Run `npm run bootstrap:env:install` for the automated first-run installer, or `npm run bootstrap:install:plan` to preview the platform commands.";
}

function runJsonScript(scriptPath, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30000,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function runJsonCommand(command, args = [], timeout = 15000, env = undefined) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      env,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function reportMacosAuthoritySection() {
  if (platform !== "darwin") {
    return;
  }
  write(`${c.bold}[doctor]${c.reset} macOS Authority:`);
  const payload = runJsonScript(resolve(ROOT, "scripts", "macos_authority_audit.mjs"), ["--json"]);
  if (!payload) {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}authority audit unavailable — run \`npm run doctor:macos:authority\` directly${c.reset}`);
    return;
  }
  const checks = payload.checks || {};
  const render = (label, check, successStatus) => {
    const ok = check?.status === successStatus;
    const icon = ok ? PASS : WARN;
    const color = ok ? c.dim : c.yellow;
    write(`  ${icon} ${label} ${color}(${check?.status || "unknown"} — ${check?.detail || "no detail"})${c.reset}`);
  };
  render("console session", checks.console_session, "ready");
  render("Accessibility", checks.accessibility, "granted");
  render("Screen Recording", checks.screen_recording, "granted");
  render("Microphone / listen lane", checks.microphone_listen_lane, "granted");
  render("Full Disk Access", checks.full_disk_access, "granted");
  render("mcagent root helper", checks.root_helper, "ready");
  if (!payload.ready_for_patient_zero_full_authority) {
    recommendedMissing++;
    write(
      `  ${WARN} ${c.yellow}Patient Zero full-authority prerequisites are not fully satisfied (${(payload.blockers || []).join(", ") || "unknown blocker"})${c.reset}`
    );
  } else {
    write(`  ${PASS} Patient Zero full-authority prerequisites ${c.dim}(audited and ready)${c.reset}`);
  }
}

function reportLocalTrainingSection() {
  write(`${c.bold}[doctor]${c.reset} Local Training Lane:`);
  const payload = runJsonScript(resolve(ROOT, "scripts", "local_adapter_lane.mjs"), ["status"]);
  if (!payload) {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}local adapter lane status unavailable — run \`npm run local:training:status\`${c.reset}`);
    return;
  }
  write(`  ${PASS} active model ${c.dim}(${payload.current_model || "unknown"})${c.reset}`);
  const trainerReady = payload.trainer?.trainer_ready === true;
  if (trainerReady) {
    write(
      `  ${PASS} trainer backend ${c.dim}(${payload.trainer.backend}${payload.trainer?.python_path ? ` via ${payload.trainer.python_path}` : ""})${c.reset}`
    );
  } else {
    recommendedMissing++;
    write(
      `  ${WARN} ${c.yellow}trainer backend unavailable (${payload.trainer?.detail || "install mlx + mlx_lm for local adapter work"})${c.reset}`
    );
    write(`  ${c.dim}Bootstrap path: run \`npm run local:training:bootstrap\` on this Apple Silicon host.${c.reset}`);
  }
  if (payload.training_command?.available === true) {
    write(
      `  ${PASS} training command ${c.dim}(${payload.training_command.command}${payload.training_command?.source ? ` via ${payload.training_command.source}` : ""})${c.reset}`
    );
  } else {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}local adapter train command is not wired yet${c.reset}`);
  }
  if (payload.promotion_command?.available === true) {
    write(
      `  ${PASS} promotion command ${c.dim}(${payload.promotion_command.command}${payload.promotion_command?.source ? ` via ${payload.promotion_command.source}` : ""})${c.reset}`
    );
  } else {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}local adapter promotion gate is not wired yet${c.reset}`);
  }
  if (payload.integration_command?.available === true) {
    write(
      `  ${PASS} integration command ${c.dim}(${payload.integration_command.command}${payload.integration_command?.source ? ` via ${payload.integration_command.source}` : ""})${c.reset}`
    );
  } else {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}local adapter integration command is not wired yet${c.reset}`);
  }
  if (payload.latest_run?.manifest_path) {
    write(`  ${PASS} prepared corpus ${c.dim}(${payload.latest_run.manifest_path})${c.reset}`);
    if (payload.latest_run?.status) {
      write(`  ${PASS} latest local adapter status ${c.dim}(${payload.latest_run.status})${c.reset}`);
    }
  } else {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}no prepared local adapter corpus yet — run \`npm run local:training:prepare\`${c.reset}`);
  }
}

function reportProviderBridgeSection() {
  write(`${c.bold}[doctor]${c.reset} Provider Bridges:`);
  const buildCommonArgs = (forceLive = false) => [
    resolve(ROOT, "scripts", "mcp_tool_call.mjs"),
    "--tool",
    "provider.bridge",
    "--args",
    JSON.stringify({ action: "diagnose", source_client: "bootstrap_doctor.mjs", force_live: forceLive }),
    "--cwd",
    ROOT,
  ];
  const commonArgs = buildCommonArgs(false);
  let payload = null;
  if (existsSync(HTTP_BEARER_TOKEN_PATH)) {
    const token = readFileSync(HTTP_BEARER_TOKEN_PATH, "utf8").trim();
    if (token) {
      payload = runJsonCommand(
        process.execPath,
        [
          ...commonArgs,
          "--transport",
          "http",
          "--url",
          process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/",
          "--origin",
          process.env.TRICHAT_MCP_ORIGIN || "http://127.0.0.1",
        ],
        8000,
        {
          ...process.env,
          MCP_HTTP_BEARER_TOKEN: token,
          MCP_TOOL_CALL_TIMEOUT_MS: "5000",
        }
      );
    }
  }
  if (!payload) {
    payload = runJsonCommand(
      process.execPath,
      [
        ...commonArgs,
        "--transport",
        "stdio",
        "--stdio-command",
        process.env.TRICHAT_MCP_STDIO_COMMAND || "node",
        "--stdio-args",
        process.env.TRICHAT_MCP_STDIO_ARGS || "dist/server.js",
      ],
      12000,
        {
          ...process.env,
          MCP_TOOL_CALL_TIMEOUT_MS: "8000",
        }
      );
  }
  if (payload?.onboarding?.stale_runtime_checks === true) {
    const livePayload = runJsonCommand(
      process.execPath,
      [
        ...buildCommonArgs(true),
        "--transport",
        "stdio",
        "--stdio-command",
        process.env.TRICHAT_MCP_STDIO_COMMAND || "node",
        "--stdio-args",
        process.env.TRICHAT_MCP_STDIO_ARGS || "dist/server.js",
      ],
      20000,
      {
        ...process.env,
        MCP_TOOL_CALL_TIMEOUT_MS: "15000",
      }
    );
    if (livePayload) {
      payload = livePayload;
    }
  }
  if (!payload) {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}provider bridge status unavailable — run \`npm run providers:status\`${c.reset}`);
    return;
  }
  const onboarding = payload.onboarding || {};
  const readyCount = Number.isFinite(onboarding.ready_count) ? onboarding.ready_count : 0;
  const actionRequired = Number.isFinite(onboarding.action_required_count) ? onboarding.action_required_count : 0;
  const runtimeChecks = Number.isFinite(onboarding.needs_runtime_verification_count)
    ? onboarding.needs_runtime_verification_count
    : 0;
  const stale = onboarding.stale_runtime_checks === true;
  write(`  ${PASS} ready clients ${c.dim}(${readyCount})${c.reset}`);
  if (actionRequired > 0) {
    recommendedMissing++;
    write(
      `  ${WARN} ${c.yellow}clients still need action (${actionRequired}; runtime verification missing for ${runtimeChecks})${c.reset}`
    );
    write(`  ${c.dim}Next path: run \`npm run providers:diagnose -- <client-id>\` for any bridge you expect to be live.${c.reset}`);
  } else {
    write(`  ${PASS} configured provider bridges ${c.dim}(all verified)${c.reset}`);
  }
  if (stale) {
    recommendedMissing++;
    write(`  ${WARN} ${c.yellow}provider bridge diagnostics are stale${c.reset}`);
  }
}

write(`${c.bold}[doctor]${c.reset} Prerequisites:`);

for (const item of manifest.prerequisites.required) {
  checkPrereq(item, true);
}
for (const item of manifest.prerequisites.recommended) {
  checkPrereq(item, false);
}

reportAppleSiliconMlxAdvisory();
reportMacosAuthoritySection();

// ── Browser detection ────────────────────────────────────────────────────────
write(`${c.bold}[doctor]${c.reset} Browser:`);

const browserList = manifest.browsers[platform] || [];
let browserFound = false;

for (const browser of browserList) {
  const detected = detectBrowserEntry(browser);
  if (detected) {
    write(`  ${PASS} ${browser.name} ${c.dim}(${detected})${c.reset}`);
    browserFound = true;
    break;
  }
}

if (!browserFound) {
  write(`  ${WARN} ${c.yellow}No supported browser detected${c.reset}`);
  recommendedMissing++;
}

// ── Build checks ─────────────────────────────────────────────────────────────
write(`${c.bold}[doctor]${c.reset} Build:`);

const nodeModulesExists = existsSync(resolve(ROOT, "node_modules"));
if (nodeModulesExists) {
  write(`  ${PASS} node_modules present`);
} else {
  requiredFails++;
  write(
    `  ${FAIL} node_modules ${c.red}missing \u2014 run: npm ci${c.reset}`
  );
}

const distServerExists = existsSync(resolve(ROOT, "dist", "server.js"));
if (distServerExists) {
  write(`  ${PASS} dist/server.js present`);
} else {
  requiredFails++;
  write(
    `  ${FAIL} dist/server.js ${c.red}missing \u2014 run: npm run build${c.reset}`
  );
}

// ── Config checks ────────────────────────────────────────────────────────────
write(`${c.bold}[doctor]${c.reset} Config:`);

const envExists = existsSync(resolve(ROOT, ".env"));
if (envExists) {
  write(`  ${PASS} .env present`);
} else {
  requiredFails++;
  write(
    `  ${FAIL} .env ${c.red}missing \u2014 copy .env.example to .env and configure${c.reset}`
  );
}

const bearerTokenPath = resolve(
  ROOT,
  "data",
  "imprint",
  "http_bearer_token"
);
const bearerTokenExists = existsSync(bearerTokenPath);
if (bearerTokenExists) {
  write(`  ${PASS} bearer token configured`);
} else {
  write(
    `  ${WARN} bearer token ${c.yellow}not found at data/imprint/http_bearer_token (needed for HTTP mode)${c.reset}`
  );
  recommendedMissing++;
}

// ── Launcher checks ──────────────────────────────────────────────────────────
reportLauncherSection("Office GUI Launcher", "office_gui", "node ./scripts/agent_office_gui.mjs");
reportLauncherSection("Agentic Suite Launcher", "agentic_suite", "node ./scripts/agentic_suite_launch.mjs");
reportLocalTrainingSection();
reportProviderBridgeSection();

// ── Summary ──────────────────────────────────────────────────────────────────
write("");
if (requiredFails === 0) {
  const recNote =
    recommendedMissing > 0
      ? ` ${c.yellow}(${recommendedMissing} recommendation${recommendedMissing > 1 ? "s" : ""} missing)${c.reset}`
      : "";
  const readinessLabel = launcherDegraded ? "ready with launcher caveats" : "ready";
  write(
    `${c.bold}[doctor]${c.reset} Result: ${c.green}${c.bold}${readinessLabel}${c.reset}${recNote}`
  );
} else {
  write(
    `${c.bold}[doctor]${c.reset} Result: ${c.red}${c.bold}not ready${c.reset} \u2014 ${requiredFails} required check${requiredFails > 1 ? "s" : ""} failed`
  );
  const suggestion = bootstrapInstallSuggestion();
  if (suggestion) {
    write(`${c.dim}${suggestion}${c.reset}`);
  }
}

write("");
process.exit(requiredFails > 0 ? 1 : 0);
