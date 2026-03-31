import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  try {
    const health = await callTool(client, "health.storage", {});
    assert.equal(health.ok, true);
  } finally {
    await client.close().catch(() => {});
  }

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

test("storage guard skips startup backup when the database exceeds the startup size threshold", async () => {
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
  assert.equal(backups.length, 0);

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
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-storage-guard-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
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
  const response = await client.callTool({ name, arguments: args });
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
