import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("transcript.auto_squish persists daemon state across server restarts", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auto-squish-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  try {
    const sessionOne = await openClient(dbPath);
    try {
      const started = await callTool(sessionOne.client, "transcript.auto_squish", {
        action: "start",
        mutation: nextMutation(testId, "transcript.auto_squish-start", () => mutationCounter++),
        interval_seconds: 17,
        batch_runs: 9,
        per_run_limit: 123,
        max_points: 7,
        run_immediately: false,
      });
      assert.equal(started.running, true);
      assert.equal(started.persisted.enabled, true);

      const storageHealth = await callTool(sessionOne.client, "health.storage", {});
      assert.equal(typeof storageHealth.schema_version, "number");
      assert.ok(storageHealth.schema_version >= 4);
      assert.equal(typeof storageHealth.table_counts.schema_migrations, "number");
      assert.equal(typeof storageHealth.table_counts.daemon_configs, "number");
    } finally {
      await sessionOne.client.close().catch(() => {});
    }

    const sessionTwo = await openClient(dbPath);
    try {
      const status = await callTool(sessionTwo.client, "transcript.auto_squish", {
        action: "status",
      });
      assert.equal(status.running, true);
      assert.equal(status.config.interval_seconds, 17);
      assert.equal(status.config.batch_runs, 9);
      assert.equal(status.config.per_run_limit, 123);
      assert.equal(status.config.max_points, 7);

      const stopped = await callTool(sessionTwo.client, "transcript.auto_squish", {
        action: "stop",
        mutation: nextMutation(testId, "transcript.auto_squish-stop", () => mutationCounter++),
      });
      assert.equal(stopped.running, false);
      assert.equal(stopped.persisted.enabled, false);
    } finally {
      await sessionTwo.client.close().catch(() => {});
    }

    const sessionThree = await openClient(dbPath);
    try {
      const status = await callTool(sessionThree.client, "transcript.auto_squish", {
        action: "status",
      });
      assert.equal(status.running, false);
      assert.equal(status.config.interval_seconds, 17);
      assert.equal(status.config.batch_runs, 9);
      assert.equal(status.config.per_run_limit, 123);
      assert.equal(status.config.max_points, 7);
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
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-auto-squish-persistence-test", version: "0.1.0" },
    { capabilities: {} }
  );
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
