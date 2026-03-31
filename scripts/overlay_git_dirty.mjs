#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , rootArg, workspaceArg] = process.argv;

if (!rootArg || !workspaceArg) {
  process.exit(0);
}

const root = path.resolve(rootArg);
const workspace = path.resolve(workspaceArg);
const ignoredPrefixes = [".git/", ".mcp-isolation/", "node_modules/", ".venv/", "dist/"];

function runGit(args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function splitNullDelimited(value) {
  return value
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shouldIgnore(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return (
    normalized.length === 0 ||
    ignoredPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
  );
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function removeTarget(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyEntry(sourcePath, targetPath) {
  const stat = fs.lstatSync(sourcePath);
  removeTarget(targetPath);
  ensureParent(targetPath);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
    return;
  }
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, dereference: false });
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, stat.mode);
}

const dirtyPaths = new Set([
  ...splitNullDelimited(runGit(["diff", "--name-only", "-z", "--no-renames"])),
  ...splitNullDelimited(runGit(["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"])),
  ...splitNullDelimited(runGit(["ls-files", "--others", "--exclude-standard", "-z"])),
]);

for (const relativePath of dirtyPaths) {
  if (shouldIgnore(relativePath)) {
    continue;
  }
  const sourcePath = path.resolve(root, relativePath);
  const targetPath = path.resolve(workspace, relativePath);
  if (!sourcePath.startsWith(root) || !targetPath.startsWith(workspace)) {
    continue;
  }
  if (fs.existsSync(sourcePath)) {
    copyEntry(sourcePath, targetPath);
  } else {
    removeTarget(targetPath);
  }
}
