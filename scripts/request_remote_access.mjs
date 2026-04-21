#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const explicit = process.argv.find((entry) => entry.startsWith(prefix));
  if (explicit) return explicit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function boolArg(name, fallback = false) {
  const value = argValue(name, fallback ? "true" : "false");
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function shell(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

function identityDir() {
  return path.join(os.homedir(), ".master-mold", "identity");
}

function identityKeyBase(hostId) {
  const safeHostId =
    String(hostId || "remote-host")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "remote-host";
  return path.join(identityDir(), `${safeHostId}-ed25519`);
}

function ensureHostIdentity(hostId) {
  const base = identityKeyBase(hostId);
  const privateKeyPath = `${base}.pem`;
  const publicKeyPath = `${base}.pub.pem`;
  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    return {
      privateKeyPath,
      publicKeyPath,
      publicKeyPem: fs.readFileSync(publicKeyPath, "utf8"),
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o644 });
  return { privateKeyPath, publicKeyPath, publicKeyPem };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Usage: node scripts/request_remote_access.mjs --server http://MAIN-MAC:8787 --host-id my-mac --workspace-root /path/to/MASTER-MOLD [--agent-runtime claude] [--model-label "Claude Opus"] [--desktop-context true]

Run this independently on each host that should request MASTER-MOLD access. The script creates a local Ed25519 host identity under ~/.master-mold/identity, stages the public key with the main Mac, and leaves approval operator-controlled in Agent Office.`);
    return;
  }
  const server = argValue("server", process.env.MASTER_MOLD_MAIN_URL || "http://10.1.2.54:8787");
  const repoRoot = argValue("workspace-root", process.cwd());
  const hostname = argValue("hostname", os.hostname());
  const hostId = argValue("host-id", hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const identity = ensureHostIdentity(hostId);
  const sshUser = argValue("ssh-user", os.userInfo().username);
  const sshDestination = argValue("ssh-destination", `${sshUser}@${hostname}`);
  const payload = {
    host_id: hostId,
    display_name: argValue("display-name", hostname),
    hostname,
    ssh_user: sshUser,
    ssh_destination: sshDestination,
    workspace_root: path.resolve(repoRoot),
    worker_count: Number(argValue("worker-count", "1")) || 1,
    agent_runtime: argValue("agent-runtime", process.env.MASTER_MOLD_AGENT_RUNTIME || "unknown"),
    model_label: argValue("model-label", process.env.MASTER_MOLD_MODEL_LABEL || "unknown"),
    permission_profile: argValue("permission-profile", "task_worker"),
    request_desktop_context: boolArg("desktop-context", true),
    mac_address: argValue(
      "mac-address",
      shell("sh", [
        "-lc",
        "networksetup -listallhardwareports 2>/dev/null | awk '/Device:/{dev=$2} /Ethernet Address:/{print $3; exit}' || ifconfig en0 2>/dev/null | awk '/ether/{print $2; exit}'",
      ])
    ),
    device_fingerprint: shell("sh", ["-lc", "ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'\"' '/IOPlatformUUID/{print $4; exit}'"]),
    public_key_fingerprint: shell("sh", ["-lc", "for f in ~/.ssh/*.pub; do [ -f \"$f\" ] && ssh-keygen -lf \"$f\" 2>/dev/null && break; done"]),
    identity_public_key: identity.publicKeyPem,
    operator_note: argValue("note", "Remote host is requesting MASTER-MOLD MCP fabric access."),
  };
  const url = new URL("/remote-access/request", server);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    console.error(JSON.stringify({ ok: false, status: response.status, response: parsed }, null, 2));
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ...parsed,
        host_identity_private_key_path: identity.privateKeyPath,
        host_identity_public_key_path: identity.publicKeyPath,
        mcp_tool_call_env: {
          MASTER_MOLD_HOST_ID: hostId,
          MASTER_MOLD_AGENT_ID: payload.agent_runtime,
          MASTER_MOLD_IDENTITY_KEY_PATH: identity.privateKeyPath,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
