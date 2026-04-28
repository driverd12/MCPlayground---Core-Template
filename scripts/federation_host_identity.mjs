import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function safeFederationHostId(value, fallback = "host") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

export function federationIdentityDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".master-mold", "identity");
}

export function hostIdFromIdentityKeyPath(filePath) {
  const basename = path.basename(String(filePath || "").trim());
  const match = basename.match(/^(.+)-ed25519\.pem$/);
  return match ? safeFederationHostId(match[1], "") : "";
}

export function listFederationIdentityHostIds(identityDir = federationIdentityDir()) {
  try {
    return fs
      .readdirSync(identityDir)
      .map((entry) => hostIdFromIdentityKeyPath(entry))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

export function resolveFederationHostIdentity(options = {}) {
  const identityDir = options.identityDir || federationIdentityDir(options.homeDir || os.homedir());
  const explicitHostId = safeFederationHostId(options.hostId, "");
  const envHostId = safeFederationHostId(options.envHostId, "");
  const hostnameId = safeFederationHostId(options.hostname || os.hostname(), "local-host");
  const identityKeyPath = String(options.identityKeyPath || "").trim();
  const keyPathHostId = hostIdFromIdentityKeyPath(identityKeyPath);
  const identityHostIds = listFederationIdentityHostIds(identityDir);
  const hostIdWithoutLocal = hostnameId.endsWith(".local") ? hostnameId.slice(0, -".local".length) : "";

  let hostId = explicitHostId;
  let source = "arg";
  if (!hostId && envHostId) {
    hostId = envHostId;
    source = "env";
  }
  if (!hostId && keyPathHostId) {
    hostId = keyPathHostId;
    source = "identity-key-path";
  }
  if (!hostId && identityHostIds.includes(hostnameId)) {
    hostId = hostnameId;
    source = "hostname-identity";
  }
  if (!hostId && hostIdWithoutLocal && identityHostIds.includes(hostIdWithoutLocal)) {
    hostId = hostIdWithoutLocal;
    source = "hostname-without-local";
  }
  if (!hostId && identityHostIds.length === 1) {
    hostId = identityHostIds[0];
    source = "single-identity";
  }
  if (!hostId) {
    hostId = hostnameId;
    source = "hostname";
  }

  return {
    hostId,
    source,
    identityDir,
    identityHostIds,
    identityKeyPath: identityKeyPath || path.join(identityDir, `${hostId}-ed25519.pem`),
  };
}
