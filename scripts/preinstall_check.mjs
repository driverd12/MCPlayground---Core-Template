import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const NVMRC_PATH = path.join(REPO_ROOT, ".nvmrc");
const TOOL_VERSIONS_PATH = path.join(REPO_ROOT, ".tool-versions");
const PLATFORM_MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "platform_manifest.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

function parsePinnedNodeVersion(toolVersionsSource) {
  const match = toolVersionsSource.match(/^nodejs\s+([^\s]+)$/m);
  return match?.[1] || null;
}

function parseRange(range) {
  const lowerMatch = range.match(/>=\s*(\d+)/);
  const upperMatch = range.match(/<\s*(\d+)/);
  return {
    lower: lowerMatch ? Number.parseInt(lowerMatch[1], 10) : null,
    upperExclusive: upperMatch ? Number.parseInt(upperMatch[1], 10) : null,
  };
}

function parseMajor(version) {
  const normalized = String(version || "").trim().replace(/^v/i, "");
  const majorText = normalized.split(".")[0];
  const major = Number.parseInt(majorText, 10);
  return Number.isFinite(major) ? major : null;
}

function parseNpmVersion() {
  const override = process.env.MCP_PREINSTALL_NPM_VERSION;
  if (override) {
    return override;
  }
  const direct = process.env.npm_config_npm_version;
  if (direct) {
    return direct;
  }
  const userAgent = process.env.npm_config_user_agent || "";
  const match = userAgent.match(/\bnpm\/([0-9]+(?:\.[0-9]+){0,2})\b/i);
  return match?.[1] || null;
}

function parseNodeVersion() {
  return process.env.MCP_PREINSTALL_NODE_VERSION || process.version;
}

function isMajorSupported(version, range) {
  const major = parseMajor(version);
  const { lower, upperExclusive } = parseRange(range);
  if (major === null) {
    return false;
  }
  if (lower !== null && major < lower) {
    return false;
  }
  if (upperExclusive !== null && major >= upperExclusive) {
    return false;
  }
  return true;
}

function describeMajorRange(range) {
  const { lower, upperExclusive } = parseRange(range);
  if (lower !== null && upperExclusive !== null) {
    return `${lower}-${upperExclusive - 1}`;
  }
  return range;
}

function readInstallHints(platform) {
  try {
    const manifest = readJson(PLATFORM_MANIFEST_PATH);
    const profile =
      platform === "linux"
        ? manifest?.bootstrap_install?.linux?.default || null
        : manifest?.bootstrap_install?.[platform] || null;
    return {
      node: profile?.commands?.node || null,
      npm: profile?.commands?.npm || null,
    };
  } catch {
    return { node: null, npm: null };
  }
}

const packageJson = readJson(PACKAGE_JSON_PATH);
const nodeEngine = packageJson.engines?.node || ">=20 <23";
const npmEngine = packageJson.engines?.npm || ">=10 <11";
const pinnedNodeMajor = readText(NVMRC_PATH);
const pinnedNodeVersion = parsePinnedNodeVersion(readText(TOOL_VERSIONS_PATH));
const pinnedNpmVersion = String(packageJson.packageManager || "").split("@")[1] || null;
const currentNodeVersion = parseNodeVersion();
const currentNpmVersion = parseNpmVersion();
const nodeSupported = isMajorSupported(currentNodeVersion, nodeEngine);
const npmSupported = currentNpmVersion ? isMajorSupported(currentNpmVersion, npmEngine) : true;

if (nodeSupported && npmSupported) {
  process.exit(0);
}

const installHints = readInstallHints(process.platform);
const platformLabel =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform;

const lines = [
  "[preinstall] Stop: unsupported runtime for SUPERPOWERS.",
  "",
  "This repo requires:",
  `  - Node ${nodeEngine} (supported majors: ${describeMajorRange(nodeEngine)}; repo pin: ${pinnedNodeMajor}${pinnedNodeVersion ? ` / ${pinnedNodeVersion}` : ""})`,
  `  - npm ${npmEngine} (supported majors: ${describeMajorRange(npmEngine)}; repo pin: ${pinnedNpmVersion || "10.x"})`,
  "",
  "Current runtime:",
  `  - Node ${currentNodeVersion}`,
  `  - npm ${currentNpmVersion || "unknown"}`,
  "",
  "Preferred fix:",
  "  npm run bootstrap:env:install",
  "",
  "If you prefer to repair the runtime manually:",
];

if (installHints.node) {
  lines.push(`  - ${installHints.node}`);
}
if (installHints.npm) {
  lines.push(`  - ${installHints.npm}`);
}
if (!installHints.node && !installHints.npm) {
  lines.push("  - install the pinned Node 22.x runtime and npm 10.x, then rerun the bootstrap");
}

lines.push("");
lines.push(
  `${platformLabel} note: avoid relying on the latest package-manager runtime alone for this repo; it can overshoot the supported Node/npm range.`
);
lines.push("If you just changed Node or npm, close and reopen the terminal so PATH refreshes, then rerun:");
lines.push("  npm ci");

process.stderr.write(`${lines.join("\n")}\n`);
process.exit(1);
