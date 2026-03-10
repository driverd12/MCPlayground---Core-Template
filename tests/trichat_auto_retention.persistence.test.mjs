import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("trichat.auto_retention persists daemon state across server restarts", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trichat-retention-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  try {
    const sessionOne = await openClient(dbPath);
    try {
      const started = await callTool(sessionOne.client, "trichat.auto_retention", {
        action: "start",
        mutation: nextMutation(testId, "trichat.auto_retention-start", () => mutationCounter++),
        interval_seconds: 19,
        older_than_days: 61,
        limit: 789,
        run_immediately: false,
      });
      assert.equal(started.running, true);
      assert.equal(started.persisted.enabled, true);

      const storageHealth = await callTool(sessionOne.client, "health.storage", {});
      assert.equal(typeof storageHealth.schema_version, "number");
      assert.ok(storageHealth.schema_version >= 6);
      assert.equal(typeof storageHealth.table_counts.daemon_configs, "number");
    } finally {
      await sessionOne.client.close().catch(() => {});
    }

    const sessionTwo = await openClient(dbPath);
    try {
      const status = await callTool(sessionTwo.client, "trichat.auto_retention", {
        action: "status",
      });
      assert.equal(status.running, true);
      assert.equal(status.config.interval_seconds, 19);
      assert.equal(status.config.older_than_days, 61);
      assert.equal(status.config.limit, 789);

      const stopped = await callTool(sessionTwo.client, "trichat.auto_retention", {
        action: "stop",
        mutation: nextMutation(testId, "trichat.auto_retention-stop", () => mutationCounter++),
      });
      assert.equal(stopped.running, false);
      assert.equal(stopped.persisted.enabled, false);
    } finally {
      await sessionTwo.client.close().catch(() => {});
    }

    const sessionThree = await openClient(dbPath);
    try {
      const status = await callTool(sessionThree.client, "trichat.auto_retention", {
        action: "status",
      });
      assert.equal(status.running, false);
      assert.equal(status.config.interval_seconds, 19);
      assert.equal(status.config.older_than_days, 61);
      assert.equal(status.config.limit, 789);
    } finally {
      await sessionThree.client.close().catch(() => {});
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(dbPath) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(path.dirname(dbPath), "trichat.bus.sock"),
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-trichat-retention-persistence-test", version: "0.1.0" },
    { capabilities: {} }
  );
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
