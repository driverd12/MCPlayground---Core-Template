#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VAULT = "Employee";

function argValues(name) {
  const values = [];
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === longName && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
      values.push(process.argv[index + 1]);
      index += 1;
    } else if (token.startsWith(prefix)) {
      values.push(token.slice(prefix.length));
    }
  }
  return values;
}

function hasArg(name) {
  const longName = `--${name}`;
  const prefix = `${longName}=`;
  return process.argv.some((token) => token === longName || token.startsWith(prefix));
}

function argValue(name, fallback = "") {
  const values = argValues(name);
  return values.length > 0 ? values[values.length - 1] : fallback;
}

function boolArg(name, fallback = false) {
  const values = argValues(name);
  if (values.length <= 0) {
    return hasArg(name) ? true : fallback;
  }
  const value = String(values[values.length - 1]).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function safeId(value, fallback = "host") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

function expandHome(filePath) {
  const text = String(filePath || "").trim();
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function parsePeers() {
  const raw = [...argValues("peer"), String(argValue("peers", process.env.MASTER_MOLD_FEDERATION_PEERS || ""))]
    .join(",")
    .split(",");
  return [...new Set(raw.map((entry) => entry.trim()).filter(Boolean))];
}

function ensureBearerToken(tokenPath, overrideToken = "") {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  if (overrideToken.trim()) {
    fs.writeFileSync(tokenPath, overrideToken.trim(), { mode: 0o600 });
    return overrideToken.trim();
  }
  if (fs.existsSync(tokenPath)) {
    return fs.readFileSync(tokenPath, "utf8").trim();
  }
  const token = randomBytes(24).toString("hex");
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

function ensureIdentity(hostId, identityDir) {
  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  const privateKeyPath = path.join(identityDir, `${hostId}-ed25519.pem`);
  const publicKeyPath = path.join(identityDir, `${hostId}-ed25519.pub.pem`);
  if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  }
  return {
    privateKeyPath,
    publicKeyPath,
    privateKeyPem: fs.readFileSync(privateKeyPath, "utf8"),
    publicKeyPem: fs.readFileSync(publicKeyPath, "utf8"),
  };
}

function readEnvFile(envPath) {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch {
    return "";
  }
}

function setEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return `${content.replace(/\s*$/, "\n")}${line}\n`;
}

function writeNonSecretEnv(options, identity) {
  const envPath = path.join(options.workspaceRoot, ".env");
  let content = readEnvFile(envPath);
  content = setEnvValue(content, "MASTER_MOLD_HOST_ID", options.hostId);
  content = setEnvValue(content, "MASTER_MOLD_IDENTITY_KEY_PATH", identity.privateKeyPath);
  content = setEnvValue(content, "MASTER_MOLD_FEDERATION_LOCAL_TRANSPORT", options.localTransport);
  if (options.peers.length > 0) {
    content = setEnvValue(content, "MASTER_MOLD_FEDERATION_PEERS", options.peers.join(","));
    content = setEnvValue(content, "MCP_HTTP_HOST", "0.0.0.0");
    content = setEnvValue(content, "MCP_HTTP_ALLOW_LAN", "1");
  }
  fs.writeFileSync(envPath, content, { mode: 0o600 });
}

function runOp(options, args, input = undefined) {
  const fullArgs = [...(options.account ? ["--account", options.account] : []), ...args];
  const result = spawnSync(options.opPath, fullArgs, {
    cwd: options.workspaceRoot,
    encoding: "utf8",
    input,
    timeout: options.opTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `1Password CLI failed (${[options.opPath, ...fullArgs].join(" ")}): ${String(result.stderr || result.stdout || result.error?.message || "").trim()}`
    );
  }
  return result.stdout;
}

function listVaultItems(options) {
  const output = runOp(options, ["item", "list", "--vault", options.vault, "--format", "json"]);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [];
}

function buildItemPayload(options, identity, bearerToken) {
  const now = new Date().toISOString();
  const itemTitle = options.itemTitle || `MASTER-MOLD MCP - ${options.hostId} - ${options.username}`;
  const mcpHttpUrl = options.httpUrl || `http://${options.hostname}:8787`;
  return {
    title: itemTitle,
    category: "API Credential",
    fields: [
      { id: "credential", type: "CONCEALED", label: "credential", value: bearerToken },
      { id: "http_bearer_token", type: "CONCEALED", label: "MCP_HTTP_BEARER_TOKEN", value: bearerToken },
      { id: "identity_private_key", type: "CONCEALED", label: "MASTER_MOLD_IDENTITY_PRIVATE_KEY", value: identity.privateKeyPem },
      { id: "identity_public_key", type: "STRING", label: "MASTER_MOLD_IDENTITY_PUBLIC_KEY", value: identity.publicKeyPem },
      { id: "host_id", type: "STRING", label: "MASTER_MOLD_HOST_ID", value: options.hostId },
      { id: "hostname", type: "STRING", label: "hostname", value: options.hostname },
      { id: "username", type: "STRING", label: "username", value: options.username },
      { id: "workspace_root", type: "STRING", label: "workspace_root", value: options.workspaceRoot },
      { id: "identity_key_path", type: "STRING", label: "MASTER_MOLD_IDENTITY_KEY_PATH", value: identity.privateKeyPath },
      { id: "identity_public_key_path", type: "STRING", label: "MASTER_MOLD_IDENTITY_PUBLIC_KEY_PATH", value: identity.publicKeyPath },
      { id: "federation_peers", type: "STRING", label: "MASTER_MOLD_FEDERATION_PEERS", value: options.peers.join(",") },
      { id: "mcp_http_url", type: "STRING", label: "MCP HTTP URL", value: mcpHttpUrl },
      { id: "launchd_install_command", type: "STRING", label: "launchd install command", value: "npm run federation:launchd:install" },
      { id: "generated_at", type: "STRING", label: "generated_at", value: now },
    ],
    notesPlain: [
      "MASTER-MOLD peer-mesh MCP federation credentials.",
      "Use this item to recover the host bearer token and Ed25519 host identity.",
      "The bearer token file is stored locally at data/imprint/http_bearer_token with 0600 permissions.",
      "The private key is stored locally under ~/.master-mold/identity and is used for per-request host signing.",
      "Do not paste these secrets into shared channels.",
    ].join("\n"),
  };
}

function opItemCategory(category) {
  const value = String(category || "API Credential").trim();
  if (value === "API_CREDENTIAL") {
    return "API Credential";
  }
  if (value === "SECURE_NOTE") {
    return "Secure Note";
  }
  return value;
}

function opTemplateInput(payload) {
  const { category: _category, ...body } = payload;
  return `${JSON.stringify(body)}\n`;
}

function upsertOnePasswordItem(options, payload) {
  const items = listVaultItems(options);
  const existing = items.find((entry) => entry.title === payload.title);
  const tags = "master-mold,mcp,federation,host-identity";
  const input = opTemplateInput(payload);
  const category = opItemCategory(payload.category);
  if (options.dryRun) {
    return {
      action: existing ? "would_update" : "would_create",
      title: payload.title,
      vault: options.vault,
      item_id: existing?.id ?? null,
    };
  }
  if (existing?.id) {
    const output = runOp(
      options,
      ["item", "edit", existing.id, "--vault", options.vault, "--title", payload.title, "--tags", tags, "--format", "json"],
      input
    );
    const parsed = JSON.parse(output);
    return { action: "updated", title: parsed.title ?? payload.title, vault: options.vault, item_id: parsed.id ?? existing.id };
  }
  const output = runOp(
    options,
    ["item", "create", "--category", category, "--title", payload.title, "--vault", options.vault, "--tags", tags, "--format", "json", "-"],
    input
  );
  const parsed = JSON.parse(output);
  return { action: "created", title: parsed.title ?? payload.title, vault: options.vault, item_id: parsed.id ?? null };
}

function onePasswordUnavailableResult(error, options) {
  return {
    status: "unavailable",
    vault: options.vault,
    op_path: options.opPath,
    error: error instanceof Error ? error.message : String(error),
    fallback: "local_secrets_only",
  };
}

function parseOptions() {
  const hostname = String(argValue("hostname", os.hostname())).trim();
  const username = String(argValue("username", os.userInfo().username)).trim();
  const hostId = safeId(argValue("host-id", process.env.MASTER_MOLD_HOST_ID || hostname), "local-host");
  const workspaceRoot = path.resolve(expandHome(argValue("workspace-root", REPO_ROOT)));
  return {
    hostId,
    hostname,
    username,
    workspaceRoot,
    peers: parsePeers(),
    vault: String(argValue("vault", process.env.MASTER_MOLD_1PASSWORD_VAULT || DEFAULT_VAULT)).trim() || DEFAULT_VAULT,
    account: String(argValue("account", process.env.OP_ACCOUNT || "")).trim(),
    opPath: expandHome(argValue("op-path", process.env.OP_PATH || "op")),
    itemTitle: String(argValue("item-title", "")).trim(),
    httpUrl: String(argValue("http-url", "")).trim(),
    localTransport: String(argValue("local-transport", process.env.MASTER_MOLD_FEDERATION_LOCAL_TRANSPORT || "http")).trim(),
    tokenPath: path.resolve(workspaceRoot, "data", "imprint", "http_bearer_token"),
    sharedBearerToken: String(argValue("shared-bearer-token", process.env.MASTER_MOLD_FEDERATION_SHARED_BEARER_TOKEN || "")).trim(),
    identityDir: path.join(os.homedir(), ".master-mold", "identity"),
    writeEnv: boolArg("write-env", false),
    dryRun: boolArg("dry-run", false),
    localOnly: boolArg("local-only", false) || boolArg("skip-1password", false),
    requireOnePassword: boolArg("require-1password", false),
    opTimeoutMs: Math.max(5_000, Number(argValue("op-timeout-ms", "60000")) || 60_000),
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/federation_secret_bootstrap.mjs --vault Employee --host-id my-host --peers http://peer-a:8787 --write-env

Creates or reuses this host's local MCP bearer token and Ed25519 identity key, then upserts a user-scoped
1Password API Credential item containing the recovery material and federation defaults.

Required on team hosts:
  - 1Password CLI on PATH, or pass --op-path /path/to/op
  - An unlocked/signable 1Password account with access to --vault

Useful options:
  --peer <url>              Add one peer. Repeatable.
  --peers <csv>             Add comma-separated peers.
  --shared-bearer-token     Write an existing shared mesh bearer token into this host's token file.
  --item-title <title>      Override the default item title.
  --write-env               Write non-secret federation settings into .env.
  --local-only              Skip 1Password and leave secrets in local files only.
  --require-1password       Fail instead of falling back when 1Password is unavailable.
  --dry-run                 Validate without writing to 1Password.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseOptions();
  const bearerToken = ensureBearerToken(options.tokenPath, options.sharedBearerToken);
  const identity = ensureIdentity(options.hostId, options.identityDir);
  if (options.writeEnv) {
    writeNonSecretEnv(options, identity);
  }
  const payload = buildItemPayload(options, identity, bearerToken);
  let opResult = null;
  let onePassword = null;
  if (options.localOnly) {
    onePassword = {
      status: "skipped",
      vault: options.vault,
      op_path: options.opPath,
      fallback: "local_secrets_only",
    };
  } else {
    try {
      opResult = upsertOnePasswordItem(options, payload);
      onePassword = {
        status: "stored",
        vault: options.vault,
        op_path: options.opPath,
        item_id: opResult.item_id ?? null,
      };
    } catch (error) {
      if (options.requireOnePassword) {
        throw error;
      }
      onePassword = onePasswordUnavailableResult(error, options);
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        host_id: options.hostId,
        hostname: options.hostname,
        vault: options.vault,
        item: opResult,
        one_password: onePassword,
        token_file: options.tokenPath,
        identity_key_path: identity.privateKeyPath,
        public_key_path: identity.publicKeyPath,
        peers: options.peers,
        wrote_env: options.writeEnv,
        secret_values_revealed: false,
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
