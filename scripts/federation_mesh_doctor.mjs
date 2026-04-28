#!/usr/bin/env node
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  defaultSidecarStatePath,
  loadSidecarState,
  matchSidecarPeerResultToHost,
  safeId,
  summarizeSidecarState,
} from "./federation_sidecar_state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });
const DEFAULT_TIMEOUT_MS = 45_000;
const FEDERATION_STALE_SECONDS = 60 * 60;
const DESKTOP_STALE_SECONDS = 5 * 60;
const SIDECAR_OUTBOX_WARN_SECONDS = 180;
const DEFAULT_SIDECAR_LAUNCHD_LABEL = "com.master-mold.federation.sidecar";

function parseArgs(argv) {
  const out = {
    json: false,
    sshProbe: false,
    hostId: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      out.json = true;
    } else if (token === "--ssh-probe") {
      out.sshProbe = true;
    } else if (token === "--host-id") {
      out.hostId = argv[++index] || "";
    } else if (token.startsWith("--host-id=")) {
      out.hostId = token.slice("--host-id=".length);
    } else if (token === "--timeout-ms") {
      out.timeoutMs = Number.parseInt(argv[++index] || "", 10);
    } else if (token.startsWith("--timeout-ms=")) {
      out.timeoutMs = Number.parseInt(token.slice("--timeout-ms=".length), 10);
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    out.timeoutMs = DEFAULT_TIMEOUT_MS;
  }
  out.hostId = String(out.hostId || "").trim();
  return out;
}

function printHelp() {
  console.log(`Usage:
  npm run federation:doctor -- [--json] [--ssh-probe] [--host-id <id>]

Checks local federation prerequisites and the current worker.fabric peer view.
The doctor never prints bearer tokens or private keys. Use --ssh-probe for an
optional bounded SSH liveness check for approved SSH hosts.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error?.message || null,
  };
}

function compactText(value, maxLength = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function readList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
}

function ageSeconds(iso) {
  const parsed = Date.parse(String(iso || ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
}

function formatAge(seconds) {
  if (seconds === null) {
    return "unknown";
  }
  if (seconds < 90) {
    return `${seconds}s`;
  }
  if (seconds < 7200) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${Math.round(seconds / 3600)}h`;
}

function fileStatus(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      present: stat.isFile(),
      path: filePath,
      bytes: stat.size,
      mode: `0${(stat.mode & 0o777).toString(8)}`,
    };
  } catch {
    return {
      present: false,
      path: filePath,
      bytes: 0,
      mode: null,
    };
  }
}

export function listIdentityKeys(identityDir) {
  const suffix = "-ed25519.pem";
  try {
    return fs
      .readdirSync(identityDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix) && !entry.name.endsWith(".pub.pem"))
      .map((entry) => {
        const hostId = entry.name.slice(0, -suffix.length) || "host";
        const privateKeyPath = path.join(identityDir, entry.name);
        const publicKeyPath = path.join(identityDir, `${hostId}-ed25519.pub.pem`);
        return {
          host_id: hostId,
          private_key_path: privateKeyPath,
          public_key_path: publicKeyPath,
          public_key_present: fs.existsSync(publicKeyPath),
        };
      })
      .sort((left, right) => left.host_id.localeCompare(right.host_id));
  } catch {
    return [];
  }
}

export function summarizeIdentityKeys(identityDir, localHostId, defaultIdentityKeyPath) {
  const keys = listIdentityKeys(identityDir);
  const normalizedLocalHostId = safeId(localHostId, "local-host");
  const matchingKey = keys.find((entry) => entry.host_id === normalizedLocalHostId) || null;
  const drift = !fs.existsSync(defaultIdentityKeyPath) && keys.length > 0;
  return {
    identity_dir: identityDir,
    key_count: keys.length,
    host_ids: keys.map((entry) => entry.host_id),
    matching_host_id: matchingKey?.host_id ?? null,
    suggested_host_id: !matchingKey && keys.length === 1 ? keys[0].host_id : null,
    drift,
    keys,
  };
}

export function parseLaunchctlPrint(text) {
  const raw = String(text || "");
  const match = (pattern) => raw.match(pattern)?.[1]?.trim() || null;
  const numberMatch = (pattern) => {
    const value = match(pattern);
    const parsed = Number.parseInt(String(value || ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    state: match(/^\s*state = (.+)$/m),
    path: match(/^\s*path = (.+)$/m),
    stdout_path: match(/^\s*stdout path = (.+)$/m),
    stderr_path: match(/^\s*stderr path = (.+)$/m),
    working_directory: match(/^\s*working directory = (.+)$/m),
    pid: numberMatch(/^\s*pid = (\d+)$/m),
    runs: numberMatch(/^\s*runs = (\d+)$/m),
    last_terminating_signal: match(/^\s*last terminating signal = (.+)$/m),
  };
}

export function parseLaunchctlDisabled(text, label) {
  const pattern = new RegExp(`"${String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*(enabled|disabled)`);
  const matched = String(text || "").match(pattern);
  if (!matched) {
    return null;
  }
  return matched[1] === "disabled";
}

function plistJson(plistPath) {
  if (!fs.existsSync(plistPath)) {
    return null;
  }
  const result = run("plutil", ["-convert", "json", "-o", "-", plistPath], { timeoutMs: 5_000 });
  if (!result.ok) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function sidecarLaunchdStatus(localHostId) {
  if (process.platform !== "darwin") {
    return {
      label: DEFAULT_SIDECAR_LAUNCHD_LABEL,
      present: false,
      loaded: false,
      disabled: null,
      operational: false,
      path: null,
      state: null,
      pid: null,
      stdout_path: null,
      stderr_path: null,
      working_directory: null,
      working_directory_current: null,
      configured_host_id: null,
      configured_identity_key_path: null,
      configured_identity_key_present: null,
      configured_peers: [],
    };
  }
  const label = String(process.env.MASTER_MOLD_FEDERATION_LAUNCHD_LABEL || DEFAULT_SIDECAR_LAUNCHD_LABEL).trim() || DEFAULT_SIDECAR_LAUNCHD_LABEL;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const plist = plistJson(plistPath);
  const domain = `gui/${process.getuid()}`;
  const disabledResult = run("launchctl", ["print-disabled", domain], { timeoutMs: 5_000 });
  const disabled = disabledResult.ok ? parseLaunchctlDisabled(disabledResult.stdout, label) : null;
  const printed = run("launchctl", ["print", `${domain}/${label}`], { timeoutMs: 5_000 });
  const launched = printed.ok ? parseLaunchctlPrint(printed.stdout) : {};
  const environmentVariables = readRecord(plist?.EnvironmentVariables);
  const configuredHostId = readString(environmentVariables.MASTER_MOLD_HOST_ID);
  const configuredIdentityKeyPath = readString(environmentVariables.MASTER_MOLD_IDENTITY_KEY_PATH);
  const configuredPeers = String(environmentVariables.MASTER_MOLD_FEDERATION_PEERS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const workingDirectory = readString(plist?.WorkingDirectory) || readString(launched.working_directory);
  return {
    label,
    present: fs.existsSync(plistPath),
    loaded: printed.ok,
    disabled,
    operational: printed.ok && disabled !== true && readString(launched.state) === "running",
    path: plistPath,
    state: readString(launched.state),
    pid: Number.isFinite(Number(launched.pid)) ? Number(launched.pid) : null,
    runs: Number.isFinite(Number(launched.runs)) ? Number(launched.runs) : null,
    last_terminating_signal: readString(launched.last_terminating_signal),
    stdout_path: readString(plist?.StandardOutPath) || readString(launched.stdout_path),
    stderr_path: readString(plist?.StandardErrorPath) || readString(launched.stderr_path),
    working_directory: workingDirectory,
    working_directory_current: workingDirectory ? path.resolve(workingDirectory) === REPO_ROOT : null,
    configured_host_id: configuredHostId,
    configured_host_id_matches_local: configuredHostId ? safeId(configuredHostId, "local-host") === safeId(localHostId, "local-host") : null,
    configured_identity_key_path: configuredIdentityKeyPath,
    configured_identity_key_present: configuredIdentityKeyPath ? fs.existsSync(configuredIdentityKeyPath) : null,
    configured_peers: configuredPeers,
  };
}

function opStatus() {
  const candidates = [
    process.env.OP_PATH,
    "op",
    "/opt/homebrew/bin/op",
    "/usr/local/bin/op",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = run(candidate, ["--version"], { timeoutMs: 3000 });
    if (result.ok) {
      return {
        available: true,
        path: candidate,
        version: result.stdout.trim(),
      };
    }
  }
  return {
    available: false,
    path: null,
    version: null,
  };
}

export function buildLocalFindings(localHostId, defaultIdentityKey, identityInventory, sidecarLaunchd, sidecarStateSummary = {}) {
  const findings = [];
  if (!defaultIdentityKey.present && identityInventory.drift) {
    findings.push({
      severity: "warn",
      code: "local_host_identity_drift",
      detail: `default local host_id ${localHostId} has no key, but identity keys exist for ${identityInventory.host_ids.join(", ")}; pin MASTER_MOLD_HOST_ID explicitly`,
    });
  } else if (!defaultIdentityKey.present) {
    findings.push({
      severity: "warn",
      code: "missing_local_identity_key",
      detail: `missing local Ed25519 key for host_id ${localHostId}`,
    });
  }
  if (sidecarLaunchd.present !== true) {
    findings.push({
      severity: "info",
      code: "sidecar_launchd_not_installed",
      detail: `launchd agent ${sidecarLaunchd.label} is not installed`,
    });
  } else {
    if (sidecarLaunchd.working_directory_current === false) {
      findings.push({
        severity: "warn",
        code: "sidecar_launchd_stale_plist",
        detail: `launchd agent ${sidecarLaunchd.label} points at ${sidecarLaunchd.working_directory || "unknown"} instead of ${REPO_ROOT}`,
      });
    }
    if (sidecarLaunchd.loaded !== true) {
      findings.push({
        severity: "warn",
        code: "sidecar_launchd_not_loaded",
        detail: `launchd agent ${sidecarLaunchd.label} is installed but not loaded`,
      });
    }
    if (sidecarLaunchd.disabled === true) {
      findings.push({
        severity: "warn",
        code: "sidecar_launchd_disabled",
        detail: `launchd agent ${sidecarLaunchd.label} is disabled`,
      });
    }
    if (sidecarLaunchd.configured_host_id && sidecarLaunchd.configured_host_id_matches_local === false) {
      findings.push({
        severity: "warn",
        code: "sidecar_launchd_host_id_mismatch",
        detail: `launchd agent host_id ${sidecarLaunchd.configured_host_id} does not match local host_id ${localHostId}`,
      });
    }
    if (sidecarLaunchd.configured_identity_key_path && sidecarLaunchd.configured_identity_key_present === false) {
      findings.push({
        severity: "warn",
        code: "sidecar_launchd_identity_key_missing",
        detail: `launchd agent identity key path is missing: ${sidecarLaunchd.configured_identity_key_path}`,
      });
    }
  }
  const sidecarState = readRecord(sidecarStateSummary);
  if (sidecarState.present === true) {
    const peerCount = Number(sidecarState.peer_count || 0);
    const okPeerCount = Number(sidecarState.ok_peer_count || 0);
    const failingPeerCount = Number(sidecarState.failing_peer_count || 0);
    const outboxDepth = Number(sidecarState.outbox_depth || 0);
    if (peerCount > 0 && sidecarState.last_cycle_ok === false) {
      findings.push({
        severity: "warn",
        code: "sidecar_last_cycle_failed",
        detail: `local federation sidecar last cycle failed; peers ok=${okPeerCount}/${peerCount}, failing=${failingPeerCount}, outbox=${outboxDepth}`,
      });
    }
    const oldestPendingAgeSeconds = Number(sidecarState.oldest_pending_age_seconds);
    if (outboxDepth > 0 && Number.isFinite(oldestPendingAgeSeconds) && oldestPendingAgeSeconds >= SIDECAR_OUTBOX_WARN_SECONDS) {
      findings.push({
        severity: "warn",
        code: "sidecar_outbox_pending",
        detail: `sidecar outbox has ${outboxDepth} pending publish item(s); oldest pending publish is ${formatAge(oldestPendingAgeSeconds)} old`,
      });
    }
  }
  return findings;
}

async function resolveHostname(hostname) {
  if (!hostname) {
    return [];
  }
  try {
    const entries = await dns.lookup(hostname, { all: true, verbatim: true });
    return [...new Set(entries.map((entry) => entry.address).filter(Boolean))];
  } catch {
    return [];
  }
}

function remoteAccessFromHost(host) {
  const metadata = readRecord(host.metadata);
  const configured = readRecord(metadata.remote_access);
  if (Object.keys(configured).length > 0) {
    return configured;
  }
  return {
    status: host.remote_access_status,
    display_name: host.remote_display_name,
    hostname: host.remote_hostname,
    ip_address: host.remote_ip_address,
    allowed_addresses: host.remote_allowed_addresses,
    mac_address: host.remote_mac_address,
    agent_runtime: host.remote_agent_runtime,
    model_label: host.remote_model_label,
    permission_profile: host.remote_permission_profile,
    device_fingerprint: host.remote_device_fingerprint,
    public_key_fingerprint: host.remote_public_key_fingerprint,
    identity_public_key: host.remote_identity_public_key_configured ? "__configured__" : null,
    approved_at: host.remote_approved_at,
  };
}

function latestFederationDetails(latestFederationEvent) {
  return readRecord(latestFederationEvent?.details);
}

function latestFederationIdentity(latestFederationEvent) {
  const details = latestFederationDetails(latestFederationEvent);
  return readRecord(details.federation_identity);
}

async function inspectHost(host, options, latestFederationEvent = null, sidecarState = null) {
  const metadata = readRecord(host.metadata);
  const remoteAccess = remoteAccessFromHost(host);
  const federation = readRecord(metadata.federation);
  const eventDetails = latestFederationDetails(latestFederationEvent);
  const federationIdentity = Object.keys(readRecord(federation.identity)).length > 0 ? readRecord(federation.identity) : latestFederationIdentity(latestFederationEvent);
  const remoteLocator = readRecord(metadata.remote_locator);
  const desktopContext =
    Object.keys(readRecord(metadata.desktop_context)).length > 0
      ? readRecord(metadata.desktop_context)
      : readRecord(host.desktop_context);
  const capabilities = readRecord(host.capabilities);
  const telemetry = readRecord(host.telemetry);
  const hostId = readString(host.host_id) || "unknown-host";
  const remoteStatus = readString(remoteAccess.status);
  const isRemote = readString(host.transport) === "ssh" || Boolean(remoteStatus);
  const approved = remoteStatus === "approved";
  const hostname = readString(remoteAccess.hostname);
  const resolvedAddresses = await resolveHostname(hostname);
  const allowedAddresses = readList(remoteAccess.allowed_addresses);
  const currentAddress = readString(remoteLocator.current_ip_address) || readString(federationIdentity.requesting_remote_address);
  const approvedIp = readString(remoteAccess.ip_address);
  const lastIngestAt = readString(federation.last_ingest_at) || readString(latestFederationEvent?.created_at);
  const lastIngestAgeSeconds = ageSeconds(lastIngestAt);
  const desktopGeneratedAt =
    readString(desktopContext.generated_at) ||
    readString(readRecord(federation.desktop_context).generated_at) ||
    readString(readRecord(eventDetails.desktop_context).generated_at);
  const desktopAgeSeconds = ageSeconds(desktopGeneratedAt);
  const signatureStatus =
    readString(federation.peer_signature_status) ||
    readString(readRecord(federationIdentity.signature_verification_result).status);
  const localPublishMatch = matchSidecarPeerResultToHost(readRecord(sidecarState).peer_results, {
    hostname,
    current_remote_address: currentAddress,
    approved_ip_address: approvedIp,
    allowed_addresses: allowedAddresses,
    resolved_addresses: resolvedAddresses,
  });
  const localPublish = localPublishMatch?.result
    ? {
        peer: readString(localPublishMatch.result.peer),
        matched_by: localPublishMatch.matched_by,
        last_attempt_at: readString(localPublishMatch.result.last_attempt_at),
        last_attempt_age_seconds: ageSeconds(readString(localPublishMatch.result.last_attempt_at)),
        last_ok_at: readString(localPublishMatch.result.last_ok_at),
        last_ok_age_seconds: ageSeconds(readString(localPublishMatch.result.last_ok_at)),
        last_ok: localPublishMatch.result.last_ok === true,
        last_http_status: Number.isFinite(Number(localPublishMatch.result.last_http_status))
          ? Number(localPublishMatch.result.last_http_status)
          : null,
        consecutive_failures: Number(localPublishMatch.result.consecutive_failures || 0),
        last_error: readString(localPublishMatch.result.last_error),
      }
    : null;
  const findings = [];

  if (approved && !readString(remoteAccess.identity_public_key)) {
    findings.push({ severity: "warn", code: "missing_signed_identity", detail: "approved host lacks an Ed25519 identity public key" });
  }
  if (approved && !hostname && !readString(remoteAccess.mac_address) && !readString(remoteAccess.device_fingerprint)) {
    findings.push({ severity: "warn", code: "weak_durable_identity", detail: "approved host lacks hostname, MAC, and device fingerprint metadata" });
  }
  if (approved && capabilities.federation_sidecar === true && !lastIngestAt) {
    findings.push({ severity: "warn", code: "missing_federation_ingest", detail: "approved federation peer has no accepted ingest event yet" });
  }
  if (lastIngestAgeSeconds !== null && lastIngestAgeSeconds > FEDERATION_STALE_SECONDS) {
    findings.push({ severity: "warn", code: "stale_federation_ingest", detail: `last ingest is ${formatAge(lastIngestAgeSeconds)} old` });
  }
  if (approved && signatureStatus && signatureStatus !== "verified") {
    findings.push({ severity: "warn", code: "signature_not_verified", detail: `latest peer signature status is ${signatureStatus}` });
  }
  if (approved && capabilities.desktop_context === true) {
    const desktopStatus = readString(desktopContext.status) || readString(readRecord(federation.desktop_context).status);
    if (desktopStatus && desktopStatus !== "available") {
      findings.push({ severity: "warn", code: "desktop_context_unavailable", detail: `desktop context status is ${desktopStatus}` });
    }
    if (desktopAgeSeconds !== null && desktopAgeSeconds > DESKTOP_STALE_SECONDS) {
      findings.push({ severity: "info", code: "desktop_context_stale", detail: `desktop context is ${formatAge(desktopAgeSeconds)} old` });
    }
  }
  if (currentAddress && approvedIp && currentAddress !== approvedIp) {
    findings.push({
      severity: "info",
      code: "locator_changed",
      detail: `current address ${currentAddress} differs from approved-time IP ${approvedIp}; durable hostname/signature identity should be used`,
    });
  }
  if (approved && hostname && resolvedAddresses.length === 0) {
    findings.push({ severity: "info", code: "hostname_unresolved", detail: `hostname ${hostname} did not resolve from this host` });
  }
  if (approved && localPublish && localPublish.last_ok === false) {
    findings.push({
      severity: "warn",
      code: "local_sidecar_publish_failed",
      detail: `local sidecar publish matched ${localPublish.peer || "peer"} and last failed${localPublish.last_error ? `: ${localPublish.last_error}` : ""}`,
    });
  }

  let sshProbe = null;
  if (options.sshProbe && readString(host.transport) === "ssh" && readString(host.ssh_destination)) {
    const destination = readString(host.ssh_destination);
    const probe = run("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      destination,
      "hostname",
    ], {
      timeoutMs: 12_000,
    });
    sshProbe = {
      ok: probe.ok,
      destination,
      hostname: probe.ok ? probe.stdout.trim() : null,
      error: probe.ok ? null : compactText(probe.error || probe.stderr || probe.stdout || `exit=${probe.status}`),
    };
    if (!sshProbe.ok) {
      findings.push({ severity: "warn", code: "ssh_probe_failed", detail: sshProbe.error || "SSH probe failed" });
    }
  }

  const ok = !findings.some((finding) => finding.severity === "warn");
  return {
    host_id: hostId,
    ok,
    enabled: host.enabled !== false,
    is_remote: isRemote,
    transport: readString(host.transport),
    ssh_destination: readString(host.ssh_destination),
    workspace_root: readString(host.workspace_root),
    remote_access_status: remoteStatus,
    permission_profile: readString(remoteAccess.permission_profile),
    hostname,
    resolved_addresses: resolvedAddresses,
    approved_ip_address: approvedIp,
    allowed_addresses: allowedAddresses,
    current_remote_address: currentAddress,
    mac_address: readString(remoteAccess.mac_address),
    device_fingerprint: readString(remoteAccess.device_fingerprint),
    identity_public_key_configured: Boolean(readString(remoteAccess.identity_public_key)),
    latest_signature_status: signatureStatus,
    last_ingest_at: lastIngestAt,
    last_ingest_age_seconds: lastIngestAgeSeconds,
    last_sequence: federation.last_sequence ?? eventDetails.sequence ?? null,
    last_ingest_event_id: readString(federation.last_ingest_event_id) || readString(latestFederationEvent?.event_id),
    desktop_context_status:
      readString(desktopContext.status) ||
      readString(readRecord(federation.desktop_context).status) ||
      readString(readRecord(eventDetails.desktop_context).status),
    local_mcp_status: readString(readRecord(eventDetails.local_mcp).status),
    desktop_context_age_seconds: desktopAgeSeconds,
    local_publish: localPublish,
    health_state: readString(telemetry.health_state),
    findings,
    ssh_probe: sshProbe,
  };
}

async function loadFabricState() {
  const storagePath = path.join(REPO_ROOT, "dist", "storage.js");
  const workerFabricPath = path.join(REPO_ROOT, "dist", "tools", "worker_fabric.js");
  if (!fs.existsSync(storagePath) || !fs.existsSync(workerFabricPath)) {
    return {
      ok: false,
      error: "dist output is missing; run npm run build before federation:doctor",
      db_path: null,
      storage: null,
      state: null,
    };
  }
  try {
    const [{ Storage }, { resolveEffectiveWorkerFabric }] = await Promise.all([
      import(pathToFileURL(storagePath).href),
      import(pathToFileURL(workerFabricPath).href),
    ]);
    if (!("ANAMNESIS_HUB_STARTUP_BACKUP" in process.env)) {
      process.env.ANAMNESIS_HUB_STARTUP_BACKUP = "0";
    }
    const dbPath = process.env.ANAMNESIS_HUB_DB_PATH || process.env.MCP_HUB_DB_PATH || path.join(REPO_ROOT, "data", "hub.sqlite");
    const storage = new Storage(dbPath);
    const state = resolveEffectiveWorkerFabric(storage, {
      fallback_workspace_root: REPO_ROOT,
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    });
    return {
      ok: true,
      error: null,
      db_path: dbPath,
      storage,
      state,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      db_path: null,
      storage: null,
      state: null,
    };
  }
}

function summarizeFindings(localFindings, hosts, localHostId) {
  const findings = [
    ...localFindings.map((finding) => ({
      scope: "local",
      host_id: localHostId,
      ...finding,
    })),
    ...hosts.flatMap((host) =>
    host.findings.map((finding) => ({
      scope: "remote",
      host_id: host.host_id,
      ...finding,
    }))
  ),
  ];
  return {
    warn_count: findings.filter((entry) => entry.severity === "warn").length,
    info_count: findings.filter((entry) => entry.severity === "info").length,
    findings,
  };
}

export function summarizeUnstagedVerifiedPeers(events, options = {}) {
  const knownHostIds = new Set((options.knownHostIds || []).map((entry) => safeId(entry, "")).filter(Boolean));
  const requestedHostId = safeId(options.hostId || "", "");
  const latestByHost = new Map();
  for (const rawEvent of events || []) {
    const event = readRecord(rawEvent);
    const hostId = safeId(readString(event.entity_id) || "", "");
    if (!hostId) {
      continue;
    }
    if (requestedHostId && hostId !== requestedHostId) {
      continue;
    }
    if (knownHostIds.has(hostId)) {
      continue;
    }
    const details = readRecord(event.details);
    if (readString(details.reason) !== "host_not_staged") {
      continue;
    }
    const currentEventSeq = Number(event.event_seq || 0);
    const previous = latestByHost.get(hostId);
    const previousEventSeq = Number(previous?.event_seq || 0);
    if (previous && previousEventSeq >= currentEventSeq) {
      continue;
    }
    latestByHost.set(hostId, {
      host_id: hostId,
      created_at: readString(event.created_at),
      age_seconds: ageSeconds(readString(event.created_at)),
      reason: readString(details.reason),
      detail: readString(details.detail) || readString(details.error) || "Verified peer is not staged in worker.fabric yet.",
      error: readString(details.error),
      event_id: readString(event.event_id),
      event_seq: currentEventSeq,
    });
  }
  return [...latestByHost.values()].sort((left, right) => Number((right?.event_seq ?? 0)) - Number((left?.event_seq ?? 0)));
}

function printText(report) {
  console.log("MASTER-MOLD federation mesh doctor");
  console.log(`generated_at: ${report.generated_at}`);
  console.log(`repo_root: ${report.repo_root}`);
  console.log("");
  console.log("Local");
  console.log(`  bearer token: ${report.local.bearer_token.present ? `present ${report.local.bearer_token.mode}` : "missing"} (${report.local.bearer_token.path})`);
  console.log(`  default identity key: ${report.local.default_identity_key.present ? `present ${report.local.default_identity_key.mode}` : "missing"} (${report.local.default_identity_key.path})`);
  if (report.local.identity_inventory.key_count > 0) {
    console.log(`  identity keys: ${report.local.identity_inventory.host_ids.join(", ")} (${report.local.identity_inventory.identity_dir})`);
  }
  console.log(`  1Password CLI: ${report.local.one_password.available ? `available ${report.local.one_password.version}` : "unavailable"}`);
  console.log(
    `  sidecar state: ${
      report.local.sidecar_state.present
        ? `${report.local.sidecar_state.last_cycle_ok ? "last cycle ok" : "last cycle failed"} age=${formatAge(report.local.sidecar_state.last_cycle_age_seconds)} peers=${report.local.sidecar_state.peer_count}`
        : "missing"
    } (${report.local.sidecar_state.path})`
  );
  console.log(
    `  sidecar launchd: ${
      report.local.sidecar_launchd.present
        ? `${report.local.sidecar_launchd.operational ? "running" : report.local.sidecar_launchd.loaded ? report.local.sidecar_launchd.state || "loaded" : "not loaded"} host_id=${
            report.local.sidecar_launchd.configured_host_id || "n/a"
          } peers=${report.local.sidecar_launchd.configured_peers.length}`
        : "missing"
    } (${report.local.sidecar_launchd.path || "n/a"})`
  );
  for (const finding of report.local.findings) {
    console.log(`  ${finding.severity.toUpperCase()} ${finding.code}: ${finding.detail}`);
  }
  console.log("");
  if (!report.fabric.ok) {
    console.log(`Fabric: unavailable (${report.fabric.error})`);
  } else {
    console.log(`Fabric: ${report.fabric.host_count} host(s), ${report.fabric.approved_remote_count} approved remote, ${report.fabric.signed_peer_count} signed peer(s)`);
  }
  if (Array.isArray(report.incoming_peers) && report.incoming_peers.length > 0) {
    console.log("");
    console.log("Incoming verified peers not yet staged");
    for (const peer of report.incoming_peers) {
      console.log(`  [warn] ${peer.host_id} age=${formatAge(peer.age_seconds)} ${peer.detail}`);
    }
  }
  for (const host of report.hosts) {
    const verdict = host.ok ? "ok" : "warn";
    console.log("");
    console.log(`[${verdict}] ${host.host_id} ${host.remote_access_status || host.transport || "local"} ${host.permission_profile || ""}`.trim());
    console.log(`  endpoint: ${host.ssh_destination || host.workspace_root || "n/a"}`);
    if (host.is_remote) {
      console.log(`  identity: hostname=${host.hostname || "n/a"} mac=${host.mac_address || "n/a"} device=${host.device_fingerprint || "n/a"} signed_key=${host.identity_public_key_configured ? "yes" : "no"}`);
      console.log(`  locator: current=${host.current_remote_address || "unknown"} approved_ip=${host.approved_ip_address || "none"} dns=${host.resolved_addresses.join(",") || "none"}`);
      console.log(`  federation: signature=${host.latest_signature_status || "none"} last_ingest=${host.last_ingest_at || "none"} age=${formatAge(host.last_ingest_age_seconds)} seq=${host.last_sequence ?? "n/a"}`);
      console.log(`  desktop: ${host.desktop_context_status || "unknown"} age=${formatAge(host.desktop_context_age_seconds)}`);
      if (host.local_publish) {
        console.log(
          `  local_publish: peer=${host.local_publish.peer || "n/a"} last_ok=${host.local_publish.last_ok ? "yes" : "no"} age=${formatAge(
            host.local_publish.last_attempt_age_seconds
          )} status=${host.local_publish.last_http_status ?? "n/a"}`
        );
      }
    }
    if (host.ssh_probe) {
      console.log(`  ssh_probe: ${host.ssh_probe.ok ? `ok hostname=${host.ssh_probe.hostname}` : `failed ${host.ssh_probe.error}`}`);
    }
    for (const finding of host.findings) {
      console.log(`  ${finding.severity.toUpperCase()} ${finding.code}: ${finding.detail}`);
    }
  }
  console.log("");
  console.log(`Findings: ${report.summary.warn_count} warning(s), ${report.summary.info_count} info item(s)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const localHostId = safeId(process.env.MASTER_MOLD_HOST_ID || os.hostname());
  const bearerToken = fileStatus(path.join(REPO_ROOT, "data", "imprint", "http_bearer_token"));
  const defaultIdentityKey = fileStatus(path.join(os.homedir(), ".master-mold", "identity", `${localHostId}-ed25519.pem`));
  const identityInventory = summarizeIdentityKeys(path.join(os.homedir(), ".master-mold", "identity"), localHostId, defaultIdentityKey.path);
  const sidecarStatePath = defaultSidecarStatePath(REPO_ROOT, localHostId);
  const sidecarState = loadSidecarState(sidecarStatePath);
  const sidecarStateSummary = summarizeSidecarState(sidecarStatePath, sidecarState);
  const sidecarLaunchd = sidecarLaunchdStatus(localHostId);
  const localFindings = buildLocalFindings(localHostId, defaultIdentityKey, identityInventory, sidecarLaunchd, sidecarStateSummary);
  const fabricResponse = await loadFabricState();
  const workerFabric = readRecord(fabricResponse.state);
  const rawHosts = Array.isArray(workerFabric.hosts) ? workerFabric.hosts.map(readRecord) : [];
  const knownHostIds = rawHosts.map((host) => readString(host.host_id)).filter(Boolean);
  const unstagedVerifiedPeers =
    fabricResponse.storage?.listFederationIncomingPeerSummaries({
      known_host_ids: knownHostIds,
      host_id: options.hostId,
      limit: 50,
    }) || [];
  const latestFederationEventByHost = new Map(
    (
      fabricResponse.storage?.listLatestFederationIngestEventsByHost({
        host_ids: knownHostIds,
        limit: Math.max(knownHostIds.length, 1),
      }) || []
    ).map((event) => [readString(event.entity_id), event])
  );
  const filteredHosts = options.hostId ? rawHosts.filter((host) => readString(host.host_id) === options.hostId) : rawHosts;
  const hosts = [];
  for (const host of filteredHosts) {
    const hostId = readString(host.host_id);
    const latestFederationEvent = hostId ? latestFederationEventByHost.get(hostId) || null : null;
    hosts.push(await inspectHost(host, options, latestFederationEvent, sidecarState));
  }
  const summary = summarizeFindings(localFindings, hosts, localHostId);
  summary.warn_count += unstagedVerifiedPeers.length;
  summary.findings.push(
    ...unstagedVerifiedPeers.map((peer) => ({
      scope: "incoming",
      host_id: peer.host_id,
      severity: "warn",
      code: "verified_peer_not_staged",
      detail: peer.detail,
    }))
  );
  const report = {
    ok: fabricResponse.ok && summary.warn_count === 0 && bearerToken.present,
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    local: {
      host_id: localHostId,
      bearer_token: bearerToken,
      default_identity_key: defaultIdentityKey,
      identity_inventory: identityInventory,
      one_password: opStatus(),
      sidecar_state: sidecarStateSummary,
      sidecar_launchd: sidecarLaunchd,
      findings: localFindings,
    },
    fabric: {
      ok: fabricResponse.ok,
      error: fabricResponse.ok ? null : fabricResponse.error,
      db_path: fabricResponse.db_path ?? null,
      host_count: rawHosts.length,
      approved_remote_count: rawHosts.filter((host) => readString(remoteAccessFromHost(host).status) === "approved").length,
      signed_peer_count: rawHosts.filter((host) => {
        const remoteAccess = remoteAccessFromHost(host);
        const federation = readRecord(readRecord(host.metadata).federation);
        return Boolean(readString(remoteAccess.identity_public_key)) || readString(federation.peer_signature_status) === "verified";
      }).length,
    },
    hosts,
    incoming_peers: unstagedVerifiedPeers,
    summary,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
  process.exit(report.ok ? 0 : 1);
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryHref === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
