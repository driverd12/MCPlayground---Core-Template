import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("cluster.topology seeds the planned lab and syncs only active nodes into worker.fabric", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cluster-topology-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const before = await callTool(session.client, "cluster.topology", {
      action: "status",
    });
    assert.equal(before.summary.node_count, 0);

    const ensured = await callTool(session.client, "cluster.topology", {
      action: "ensure_lab",
      mutation: nextMutation("cluster-topology", "ensure_lab", () => mutationCounter++),
      local_host_id: "local",
      workspace_root: REPO_ROOT,
    });
    assert.equal(ensured.ok, true);
    assert.equal(ensured.summary.node_count, 5);
    assert.equal(ensured.summary.active_node_count, 1);
    assert.equal(ensured.summary.planned_node_count, 4);
    assert.equal(ensured.summary.class_counts["gpu-workstation"], 1);
    assert.ok(ensured.summary.nodes.some((node) => node.node_id === "gpu-5090" && node.desired_backend_count >= 2));

    const synced = await callTool(session.client, "cluster.topology", {
      action: "sync_worker_fabric",
      mutation: nextMutation("cluster-topology", "sync_worker_fabric", () => mutationCounter++),
      local_host_id: "local",
      fallback_shell: "/bin/zsh",
      fallback_worker_count: 2,
    });
    assert.equal(synced.ok, true);
    assert.deepEqual(synced.synced_hosts, ["local"]);
    assert.equal(synced.skipped_nodes.length, 4);

    const fabric = await callTool(session.client, "worker.fabric", {
      action: "status",
      fallback_workspace_root: REPO_ROOT,
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    });
    const localHost = fabric.state.hosts.find((entry) => entry.host_id === "local");
    assert.ok(localHost);
    assert.equal(localHost.metadata.topology_node_id, "mac-control");
    assert.ok(localHost.tags.includes("control-plane"));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("kernel.summary exposes cluster topology counts for the planned lab shape", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cluster-topology-kernel-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "cluster.topology", {
      action: "ensure_lab",
      mutation: nextMutation("cluster-topology-kernel", "ensure_lab", () => mutationCounter++),
      local_host_id: "local",
      workspace_root: REPO_ROOT,
    });

    const summary = await callTool(session.client, "kernel.summary", {});
    assert.equal(summary.cluster_topology.node_count, 5);
    assert.equal(summary.cluster_topology.active_node_count, 1);
    assert.equal(summary.cluster_topology.planned_node_count, 4);
    assert.equal(summary.overview.cluster_topology.node_count, 5);
    assert.equal(summary.overview.cluster_topology.class_counts["gpu-workstation"], 1);
    const codingOutlook = summary.model_router.routing_outlook.find((entry) => entry.task_kind === "coding");
    assert.ok(codingOutlook);
    assert.ok(codingOutlook.planned_backend_count >= 1);
    assert.equal(codingOutlook.top_planned_node_id, "gpu-5090");
    assert.ok(["llama.cpp", "vllm"].includes(codingOutlook.top_planned_provider));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cluster.topology ensure_lab backfills desired backend plans into older topology nodes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cluster-topology-upgrade-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "cluster.topology", {
      action: "upsert_node",
      mutation: nextMutation("cluster-topology-upgrade", "upsert_node", () => mutationCounter++),
      node: {
        node_id: "gpu-5090",
        title: "RTX 5090 Workstation",
        status: "planned",
        node_class: "gpu-workstation",
        host_id: "gpu-5090",
        transport: "ssh",
        tags: ["remote", "gpu"],
        preferred_domains: ["research"],
        desired_backends: [],
      },
    });

    const ensured = await callTool(session.client, "cluster.topology", {
      action: "ensure_lab",
      mutation: nextMutation("cluster-topology-upgrade", "ensure_lab", () => mutationCounter++),
      local_host_id: "local",
      workspace_root: REPO_ROOT,
    });
    const gpuNode = ensured.summary.nodes.find((node) => node.node_id === "gpu-5090");
    assert.ok(gpuNode);
    assert.ok(gpuNode.desired_backend_count >= 2);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "mcp-cluster-topology-test", version: "0.1.0" },
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

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const first = response.content?.[0];
  assert.equal(first?.type, "text");
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${first.text}`);
  }
  return JSON.parse(first.text);
}

function nextMutation(testId, label, nextCounter) {
  const counter = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${counter}`,
    side_effect_fingerprint: `${testId}:${label}:${counter}`,
  };
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
