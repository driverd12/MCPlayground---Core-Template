import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";

const REPO_ROOT = process.cwd();

test("storage guard quarantines non-sqlite file and allows fresh bootstrap when enabled", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-fresh-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  fs.writeFileSync(dbPath, "<script>not a sqlite file</script>\n", "utf8");
  fs.writeFileSync(`${dbPath}-wal`, "wal-bytes", "utf8");
  fs.writeFileSync(`${dbPath}-shm`, "shm-bytes", "utf8");

  const { client } = await openClient(dbPath, {
    ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION: "1",
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
  });
  let health;
  try {
    health = await callTool(client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await client.close().catch(() => {});
  }
  assert.equal(health.guard.status, "recovered");
  assert.ok(health.guard.current_boot_quarantined_paths.length >= 1);
  assert.ok(health.guard.quarantine_artifact_count >= 1);
  assert.ok(health.guard.quarantine_total_bytes >= "<script>not a sqlite file</script>\nwal-bytesshm-bytes".length);
  assert.equal(health.guard.recovery_total_bytes, 0);

  const header = fs.readFileSync(dbPath).subarray(0, 16).toString("utf8");
  assert.equal(header, "SQLite format 3\u0000");

  const quarantineDir = path.join(tempDir, "corrupt");
  const quarantined = fs.existsSync(quarantineDir) ? fs.readdirSync(quarantineDir) : [];
  assert.ok(quarantined.some((entry) => entry.startsWith("hub.sqlite.") && entry.endsWith(".invalid-header")));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("storage guard restores from startup backup when db header is corrupted", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-restore-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const marker = `storage-guard-marker-${testId}`;
  let mutationCounter = 0;

  const sessionOne = await openClient(dbPath, {});
  try {
    await callTool(sessionOne.client, "memory.append", {
      mutation: nextMutation(testId, "memory.append", () => mutationCounter++),
      content: marker,
      keywords: ["storage", "guard", "restore"],
    });
  } finally {
    await sessionOne.client.close().catch(() => {});
  }

  // A second clean startup creates a backup that includes the previous session write.
  const sessionTwo = await openClient(dbPath, {});
  try {
    const health = await callTool(sessionTwo.client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await sessionTwo.client.close().catch(() => {});
  }

  const backupDir = path.join(tempDir, "backups");
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  assert.ok(backups.some((entry) => entry.startsWith("hub.sqlite.") && entry.endsWith(".sqlite")));

  fs.writeFileSync(dbPath, "<script>corrupted html payload</script>\n", "utf8");

  const sessionThree = await openClient(dbPath, {});
  try {
    const restored = await callTool(sessionThree.client, "memory.search", {
      query: marker,
      limit: 10,
    });
    assert.ok(Array.isArray(restored));
    assert.ok(restored.some((entry) => String(entry.content ?? "").includes(marker)));
  } finally {
    await sessionThree.client.close().catch(() => {});
  }

  const quarantineDir = path.join(tempDir, "corrupt");
  const quarantined = fs.existsSync(quarantineDir) ? fs.readdirSync(quarantineDir) : [];
  assert.ok(quarantined.some((entry) => entry.startsWith("hub.sqlite.") && entry.endsWith(".invalid-header")));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("storage guard skips a corrupt latest backup and restores the newest healthy backup", async () => {
  const testId = `${Date.now()}-restore-skip-corrupt`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-restore-skip-corrupt-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const marker = `storage-guard-healthy-backup-${testId}`;
  let mutationCounter = 0;

  const sessionOne = await openClient(dbPath, {});
  try {
    await callTool(sessionOne.client, "memory.append", {
      mutation: nextMutation(testId, "memory.append", () => mutationCounter++),
      content: marker,
      keywords: ["storage", "guard", "healthy-backup"],
    });
  } finally {
    await sessionOne.client.close().catch(() => {});
  }

  const sessionTwo = await openClient(dbPath, {});
  try {
    const health = await callTool(sessionTwo.client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await sessionTwo.client.close().catch(() => {});
  }

  const backupDir = path.join(tempDir, "backups");
  const healthyBackup = fs
    .readdirSync(backupDir)
    .filter((entry) => entry.startsWith("hub.sqlite.") && entry.endsWith(".sqlite"))
    .map((entry) => path.join(backupDir, entry))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
  assert.ok(healthyBackup);

  const corruptBackup = path.join(backupDir, "hub.sqlite.9999-12-31T23-59-59-999Z.sqlite");
  fs.copyFileSync(healthyBackup, corruptBackup);
  const fd = fs.openSync(corruptBackup, "r+");
  try {
    const patch = Buffer.from("corrupt-backup-payload");
    fs.writeSync(fd, patch, 0, patch.length, 4096);
  } finally {
    fs.closeSync(fd);
  }
  const future = new Date("2099-01-01T00:00:00.000Z");
  fs.utimesSync(corruptBackup, future, future);

  fs.writeFileSync(dbPath, "<script>corrupted html payload</script>\n", "utf8");

  const sessionThree = await openClient(dbPath, {});
  try {
    const restored = await callTool(sessionThree.client, "memory.search", {
      query: marker,
      limit: 10,
    });
    assert.ok(Array.isArray(restored));
    assert.ok(restored.some((entry) => String(entry.content ?? "").includes(marker)));
  } finally {
    await sessionThree.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("storage guard creates a large-db bundle backup when the database exceeds the vacuum snapshot threshold", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-skip-backup-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const session = await openClient(dbPath, {
    ANAMNESIS_HUB_STARTUP_BACKUP_MAX_BYTES: "1",
  });
  try {
    const health = await callTool(session.client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await session.client.close().catch(() => {});
  }

  const backupDir = path.join(tempDir, "backups");
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  assert.ok(backups.some((entry) => entry.startsWith("hub.sqlite.") && entry.endsWith(".sqlite")));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("storage guard downgrades startup quick_check to a large-db probe when the database exceeds the startup size threshold", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-skip-quick-check-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const initial = await openClient(dbPath, {
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
  });
  try {
    const health = await callTool(initial.client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await initial.client.close().catch(() => {});
  }

  const originalQuickCheckMax = process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES;
  const originalStartupBackup = process.env.ANAMNESIS_HUB_STARTUP_BACKUP;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let capturedStderr = "";
  process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES = "1";
  process.env.ANAMNESIS_HUB_STARTUP_BACKUP = "0";
  process.stderr.write = (chunk, encoding, callback) => {
    capturedStderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return originalStderrWrite(chunk, encoding, callback);
  };

  const storage = new Storage(dbPath);
  try {
    storage.init();
  } finally {
    storage["db"]?.close?.();
    process.stderr.write = originalStderrWrite;
    if (originalQuickCheckMax === undefined) {
      delete process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES;
    } else {
      process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES = originalQuickCheckMax;
    }
    if (originalStartupBackup === undefined) {
      delete process.env.ANAMNESIS_HUB_STARTUP_BACKUP;
    } else {
      process.env.ANAMNESIS_HUB_STARTUP_BACKUP = originalStartupBackup;
    }
  }

  assert.match(capturedStderr, /startup quick_check downgraded to large-db probe/i);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("storage guard large-db probe quarantines and recovers when a critical startup table probe fails", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-large-probe-recover-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const initial = await openClient(dbPath, {
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
  });
  try {
    const health = await callTool(initial.client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await initial.client.close().catch(() => {});
  }

  const originalQuickCheckMax = process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES;
  const originalStartupBackup = process.env.ANAMNESIS_HUB_STARTUP_BACKUP;
  const originalAllowFresh = process.env.ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION;
  const originalPragma = Database.prototype.pragma;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let capturedStderr = "";
  let injectedFailure = false;

  process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES = "1";
  process.env.ANAMNESIS_HUB_STARTUP_BACKUP = "0";
  process.env.ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION = "1";
  process.stderr.write = (chunk, encoding, callback) => {
    capturedStderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return originalStderrWrite(chunk, encoding, callback);
  };
  Database.prototype.pragma = function patchedPragma(source, options) {
    if (!injectedFailure && String(source).includes("integrity_check(agent_sessions)")) {
      injectedFailure = true;
      return "database disk image is malformed";
    }
    return originalPragma.call(this, source, options);
  };

  const storage = new Storage(dbPath);
  try {
    storage.init();
    assert.equal(injectedFailure, true);
    assert.ok(storage.getSchemaVersion() >= 1);
  } finally {
    storage["db"]?.close?.();
    Database.prototype.pragma = originalPragma;
    process.stderr.write = originalStderrWrite;
    if (originalQuickCheckMax === undefined) {
      delete process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES;
    } else {
      process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES = originalQuickCheckMax;
    }
    if (originalStartupBackup === undefined) {
      delete process.env.ANAMNESIS_HUB_STARTUP_BACKUP;
    } else {
      process.env.ANAMNESIS_HUB_STARTUP_BACKUP = originalStartupBackup;
    }
    if (originalAllowFresh === undefined) {
      delete process.env.ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION;
    } else {
      process.env.ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION = originalAllowFresh;
    }
  }

  assert.match(capturedStderr, /large-db startup probe failed/i);
  assert.match(capturedStderr, /initialized fresh empty database/i);
  const quarantineDir = path.join(tempDir, "corrupt");
  const quarantined = fs.existsSync(quarantineDir) ? fs.readdirSync(quarantineDir) : [];
  assert.ok(quarantined.some((entry) => entry.startsWith("hub.sqlite.") && entry.endsWith(".large-db-startup-probe")));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("runtime corruption reopen fails closed when quick_check still fails", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-runtime-corruption-reopen-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const originalQuickCheckMax = process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES;
  const originalStartupBackup = process.env.ANAMNESIS_HUB_STARTUP_BACKUP;
  const originalPragma = Database.prototype.pragma;
  let runtimeQuickCheckCalled = false;

  process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES = "1";
  process.env.ANAMNESIS_HUB_STARTUP_BACKUP = "0";

  const initial = new Storage(dbPath);
  try {
    initial.init();
  } finally {
    initial["db"]?.close?.();
  }

  Database.prototype.pragma = function patchedPragma(source, options) {
    if (String(source) === "quick_check") {
      runtimeQuickCheckCalled = true;
      return "database disk image is malformed";
    }
    return originalPragma.call(this, source, options);
  };

  const storage = new Storage(dbPath);
  try {
    storage.init();
    storage.recordSqliteError(new Error("database disk image is malformed"));
    const reopen = storage.reopenDatabase();
    assert.equal(runtimeQuickCheckCalled, true);
    assert.equal(reopen.ok, false);
    assert.match(reopen.error ?? "", /runtime quick_check failed after reopen/i);
  } finally {
    storage["db"]?.close?.();
    Database.prototype.pragma = originalPragma;
    if (originalQuickCheckMax === undefined) {
      delete process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES;
    } else {
      process.env.ANAMNESIS_HUB_RUN_QUICK_CHECK_MAX_BYTES = originalQuickCheckMax;
    }
    if (originalStartupBackup === undefined) {
      delete process.env.ANAMNESIS_HUB_STARTUP_BACKUP;
    } else {
      process.env.ANAMNESIS_HUB_STARTUP_BACKUP = originalStartupBackup;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("storage guard reports evidence_present with attention_required=false when historical quarantine evidence exists but current boot is clean", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-guard-evidence-present-"));
  const dbPath = path.join(tempDir, "hub.sqlite");

  const sessionOne = await openClient(dbPath, {
    ANAMNESIS_HUB_ALLOW_FRESH_DB_ON_CORRUPTION: "1",
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
  });
  try {
    const health = await callTool(sessionOne.client, "health.storage", {});
    assert.equal(health.ok, true);
    assert.equal(health.guard.status, "healthy");
    assert.equal(health.guard.attention_required, false);
    assert.equal(health.guard.current_boot_clean, true);
  } finally {
    await sessionOne.client.close().catch(() => {});
  }

  const quarantineDir = path.join(tempDir, "corrupt");
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.writeFileSync(
    path.join(quarantineDir, "hub.sqlite.2024-01-01T00-00-00-000Z.large-db-startup-probe"),
    "historical quarantine evidence"
  );

  const sessionTwo = await openClient(dbPath, {
    ANAMNESIS_HUB_STARTUP_BACKUP: "0",
  });
  try {
    const health = await callTool(sessionTwo.client, "health.storage", {});
    assert.equal(health.ok, true);
    assert.equal(health.guard.status, "evidence_present");
    assert.equal(health.guard.attention_required, false);
    assert.equal(health.guard.current_boot_clean, true);
    assert.equal(health.guard.quarantine_artifact_count, 1);
    assert.equal(health.guard.current_boot_quarantined_paths.length, 0);

    const kernel = await callTool(sessionTwo.client, "kernel.summary", {
      session_limit: 1,
      event_limit: 1,
      task_running_limit: 1,
    });
    assert.ok(kernel);

    const officeSnap = await callTool(sessionTwo.client, "office.snapshot", {
      thread_id: "ring-leader-main",
    });
    assert.ok(officeSnap);
  } finally {
    await sessionTwo.client.close().catch(() => {});
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function openClient(dbPath, extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      ...extraEnv,
    }),
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-storage-guard-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return { client };
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
