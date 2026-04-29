#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = "") {
  const token = `--${name}`;
  const prefix = `${token}=`;
  const inline = process.argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(token);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function boolArg(name, fallback = false) {
  const value = String(argValue(name, process.argv.includes(`--${name}`) ? "true" : fallback ? "true" : "false"))
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sshCommand(sshDestination, remoteCommand) {
  return `ssh ${shellQuote(sshDestination)} ${shellQuote(remoteCommand)}`;
}

function remoteEnv(nodePath) {
  return `export PATH=${shellQuote(`${nodePath}:/opt/homebrew/bin:/usr/local/bin:$PATH`)}`;
}

function printHelp() {
  console.log(`Usage:
  npm run federation:stage-peer -- --ssh dan.driver@Dans-MBP.local --host-id dans-mbp --remote-peer http://Dans-MBP.local:8787 --local-peer http://Dans-MacBook-Pro.local:8787 --json

This command does not SSH or mutate either host. It prints the exact safe checks
and the separate idle-required remote actions for the operator to run later.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const jsonOnly = boolArg("json", false);
  const sshDestination = argValue("ssh", "dan.driver@Dans-MBP.local");
  const hostId = argValue("host-id", "");
  const workspaceRoot = argValue("workspace", REPO_ROOT);
  const nodePath = argValue("node-path", "$HOME/.nvm/versions/node/v22.22.2/bin");
  const remotePeer = argValue("remote-peer", "http://Dans-MBP.local:8787");
  const localPeer = argValue("local-peer", `http://${os.hostname()}:8787`);
  const env = remoteEnv(nodePath);
  const cd = `cd ${shellQuote(workspaceRoot)}`;
  const remotePrefix = `${env}; ${cd}`;
  const localPrefix = `cd ${shellQuote(REPO_ROOT)}`;

  const safeRemoteChecks = [
    {
      label: "Remote repo/head status",
      command: sshCommand(sshDestination, `${cd} && git status --short --branch && git log -1 --oneline --decorate`),
      purpose: "Confirm the peer is on the expected commit before any repair.",
    },
    {
      label: "Remote Chronicle freshness",
      command: sshCommand(sshDestination, `${remotePrefix} && npm run --silent doctor:chronicle:json`),
      purpose: "Measure whether the peer desktop-context lane is still stale.",
    },
    {
      label: "Remote federation doctor",
      command: sshCommand(sshDestination, `${remotePrefix} && npm run --silent federation:doctor -- --json`),
      purpose: "Confirm sidecar state, signed peer trust, and outbox depth from the peer side.",
    },
    {
      label: "Remote Office HTTP status",
      command: sshCommand(sshDestination, `${remotePrefix} && npm run trichat:office:web:status`),
      purpose: "Verify the peer's 8787 Office lane without restarting it.",
    },
    {
      label: "Remote provider status",
      command: sshCommand(sshDestination, `${remotePrefix} && npm run providers:status`),
      purpose: "Capture provider drift separately from federation transport health.",
    },
  ];

  const idleRequiredRemoteActions = [
    {
      label: "Restart remote Codex desktop app and Chronicle recorder",
      command: sshCommand(
        sshDestination,
        `osascript -e ${shellQuote('tell application id "com.openai.codex" to quit')} >/dev/null 2>&1; sleep 2; open -a Codex`
      ),
      risk: "Interrupts the active Codex IDE session on the peer and may disrupt the user currently using that Mac.",
    },
    {
      label: "Restart remote MASTER-MOLD MCP and federation sidecar launchd jobs",
      command: sshCommand(
        sshDestination,
        `${remotePrefix} && uid=$(id -u); launchctl kickstart -k "gui/$uid/com.master-mold.mcp.server"; launchctl kickstart -k "gui/$uid/com.master-mold.federation.sidecar"`
      ),
      risk: "Interrupts active MASTER-MOLD MCP sessions on the peer.",
    },
    {
      label: "Remote-to-local live signed soak",
      command: sshCommand(
        sshDestination,
        `${remotePrefix} && npm run federation:soak -- --peer ${shellQuote(localPeer)} --iterations 3 --json --apply`
      ),
      risk: "Runs peer-side restart/repair steps because --apply is set.",
    },
  ];

  const localActions = [
    {
      label: "Local federation doctor",
      command: `${localPrefix} && npm run --silent federation:doctor -- --json`,
      purpose: "Verify this Mac still sees the peer as healthy after any staged remote work.",
    },
    {
      label: "Local-to-remote live signed soak",
      command: `${localPrefix} && npm run federation:soak -- --peer ${shellQuote(remotePeer)} --iterations 3 --json --apply`,
      purpose: "Revalidate this Mac publishing to the peer after the peer is idle.",
    },
    {
      label: "Local storage evidence review",
      command: `${localPrefix} && npm run storage:review -- --open-scan --json`,
      purpose: "Confirm storage evidence is not open before any archive/delete action.",
    },
  ];

  const manualSteps = [
    "On the peer Mac, verify System Settings > Privacy & Security > Screen Recording includes Codex and is enabled if Chronicle stays stale after app restart.",
    "Do not delete or archive storage evidence until the open-file scan has just been run and the operator confirms the exact archive/delete command.",
    "Keep host identity anchored to host_id/device fingerprint; treat DNS/IP as the current locator only.",
  ];

  const output = {
    ok: true,
    generated_at: new Date().toISOString(),
    staged_only: true,
    executed_remote_commands: false,
    repo_root: REPO_ROOT,
    peer: {
      host_id: hostId || null,
      ssh_destination: sshDestination,
      workspace_root: workspaceRoot,
      remote_peer_url: remotePeer,
      local_peer_url: localPeer,
    },
    safe_remote_checks: safeRemoteChecks,
    idle_required_remote_actions: idleRequiredRemoteActions,
    local_follow_up_actions: localActions,
    manual_steps: manualSteps,
    next_action: "Run safe_remote_checks when you want read-only peer evidence; wait for explicit operator clearance before idle_required_remote_actions.",
  };

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Staged peer: ${sshDestination}${hostId ? ` (${hostId})` : ""}`);
  console.log("No remote commands were executed.");
  console.log("\nSafe remote checks:");
  for (const step of safeRemoteChecks) console.log(`- ${step.label}: ${step.command}`);
  console.log("\nRequires peer idle/clearance:");
  for (const step of idleRequiredRemoteActions) console.log(`- ${step.label}: ${step.command}`);
  console.log("\nLocal follow-up:");
  for (const step of localActions) console.log(`- ${step.label}: ${step.command}`);
  console.log(`\nNext action: ${output.next_action}`);
}

main();
