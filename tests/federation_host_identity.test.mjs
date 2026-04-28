import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hostIdFromIdentityKeyPath,
  resolveFederationHostIdentity,
  safeFederationHostId,
} from "../scripts/federation_host_identity.mjs";

test("resolveFederationHostIdentity prefers existing durable identity over .local hostname", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-federation-host-identity-"));
  try {
    fs.writeFileSync(path.join(tempDir, "dans-macbook-pro-ed25519.pem"), "private");

    const resolved = resolveFederationHostIdentity({
      identityDir: tempDir,
      hostname: "Dans-MacBook-Pro.local",
    });

    assert.equal(resolved.hostId, "dans-macbook-pro");
    assert.equal(resolved.source, "hostname-without-local");
    assert.equal(resolved.identityKeyPath, path.join(tempDir, "dans-macbook-pro-ed25519.pem"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveFederationHostIdentity keeps explicit host id ahead of inventory guesses", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-federation-host-identity-"));
  try {
    fs.writeFileSync(path.join(tempDir, "inventory-host-ed25519.pem"), "private");

    const resolved = resolveFederationHostIdentity({
      identityDir: tempDir,
      hostId: "new-coworker-mac",
      hostname: "inventory-host.local",
    });

    assert.equal(resolved.hostId, "new-coworker-mac");
    assert.equal(resolved.source, "arg");
    assert.equal(resolved.identityKeyPath, path.join(tempDir, "new-coworker-mac-ed25519.pem"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("identity key path can provide host id when host id is not supplied", () => {
  const keyPath = path.join(os.tmpdir(), "m2-max-pro-ed25519.pem");
  assert.equal(hostIdFromIdentityKeyPath(keyPath), "m2-max-pro");
  assert.equal(safeFederationHostId("M2 Max Pro.local"), "m2-max-pro.local");
});
