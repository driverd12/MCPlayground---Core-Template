#!/usr/bin/env node
/**
 * Cross-platform browser URL opener.
 *
 * Usage: node scripts/open_browser.mjs <url>
 *
 * Reads scripts/platform_manifest.json for browser detection order.
 * Falls back to platform-native open commands if manifest is missing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "scripts", "platform_manifest.json");

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: open_browser.mjs <url>\n");
  process.exit(2);
}

function loadManifestBrowsers() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.browsers?.[process.platform] ?? [];
  } catch {
    return [];
  }
}

function commandExists(cmd) {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execFileSync(whichCmd, [cmd], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function resolveWin32ProgramFilesPath(relativePath) {
  if (process.platform !== "win32" || typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return null;
  }
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  for (const root of roots) {
    const candidate = path.resolve(root, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveWin32RegistryPath(registryPath) {
  if (process.platform !== "win32" || typeof registryPath !== "string" || registryPath.trim().length === 0) {
    return null;
  }
  try {
    const output = execFileSync("reg", ["query", registryPath, "/ve"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    });
    const line = String(output)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => /\bREG_(SZ|EXPAND_SZ)\b/i.test(entry));
    if (!line) {
      return null;
    }
    const parts = line.split(/\s{2,}/).filter(Boolean);
    const candidate = parts[parts.length - 1];
    return candidate && fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveWin32LocalAppDataPath(relativePath) {
  if (process.platform !== "win32" || typeof relativePath !== "string" || relativePath.trim().length === 0) {
    return null;
  }
  const root = process.env.LOCALAPPDATA;
  if (!root) {
    return null;
  }
  const candidate = path.resolve(root, relativePath);
  return fs.existsSync(candidate) ? candidate : null;
}

function detectBrowser(candidates) {
  for (const entry of candidates) {
    if (entry.app_path && fs.existsSync(entry.app_path)) {
      return { ...entry, resolved_path: entry.app_path };
    }
    const registryPath = resolveWin32RegistryPath(entry.registry_path);
    if (registryPath) {
      return { ...entry, resolved_path: registryPath };
    }
    const programFilesPath = resolveWin32ProgramFilesPath(entry.program_files_path);
    if (programFilesPath) {
      return { ...entry, resolved_path: programFilesPath };
    }
    const localAppDataPath = resolveWin32LocalAppDataPath(entry.local_app_data_path);
    if (localAppDataPath) {
      return { ...entry, resolved_path: localAppDataPath };
    }
    if (entry.binary && commandExists(entry.binary)) {
      return entry;
    }
  }
  return null;
}

function openUrl(browser, targetUrl) {
  if (process.platform === "win32" && browser.resolved_path) {
    try {
      execFileSync("cmd.exe", ["/c", "start", "", browser.resolved_path, targetUrl], {
        stdio: "ignore",
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }
  const cmd = [...browser.open_cmd, targetUrl];
  try {
    execFileSync(cmd[0], cmd.slice(1), { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function fallbackOpen(targetUrl) {
  const platform = process.platform;
  const fallbacks = {
    darwin: ["open", [targetUrl]],
    linux: ["xdg-open", [targetUrl]],
    win32: ["cmd.exe", ["/c", "start", "", targetUrl]],
  };
  const [cmd, args] = fallbacks[platform] ?? fallbacks.linux;
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const candidates = loadManifestBrowsers();
const browser = detectBrowser(candidates);

if (browser) {
  const result = { browser: browser.name, url };
  if (openUrl(browser, url)) {
    result.opened = true;
  } else {
    result.opened = fallbackOpen(url);
    result.fallback = true;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  const opened = fallbackOpen(url);
  process.stdout.write(JSON.stringify({ browser: "system-default", url, opened, fallback: true }) + "\n");
}
