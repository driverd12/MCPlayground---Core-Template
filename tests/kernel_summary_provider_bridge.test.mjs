import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Storage } from "../dist/storage.js";
import { kernelSummary } from "../dist/tools/kernel.js";

test("kernel.summary treats missing provider bridge runtime diagnostics as stale instead of probing live on the request path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-summary-provider-bridge-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  try {
    const storage = new Storage(dbPath);
    storage.init();

    const summary = kernelSummary(storage, {});

    assert.equal(summary.provider_bridge.cached, false);
    assert.equal(summary.provider_bridge.stale, true);
    assert.deepEqual(summary.provider_bridge.diagnostics, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
