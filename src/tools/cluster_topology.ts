import { z } from "zod";
import {
  type ClusterTopologyNodeClass,
  type ClusterTopologyNodeRecord,
  type ClusterTopologyNodeStatus,
  type ClusterTopologyStateRecord,
  type ModelRouterTaskKind,
  Storage,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { resolveTransportWorkspaceRoot, workerFabric } from "./worker_fabric.js";

const recordSchema = z.record(z.unknown());
const nodeStatusSchema = z.enum(["planned", "provisioning", "active", "maintenance", "retired"]);
const nodeClassSchema = z.enum(["control-plane", "cpu-memory", "gpu-workstation", "virtualization"]);
const transportSchema = z.enum(["local", "ssh"]);

const desiredBackendSchema = z.object({
  backend_id: z.string().min(1),
  provider: z
    .enum(["ollama", "mlx", "llama.cpp", "vllm", "openai", "google", "cursor", "anthropic", "github-copilot", "custom"])
    .default("custom"),
  model_id: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  metadata: recordSchema.optional(),
});

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const clusterTopologyNodeSchema = z.object({
  node_id: z.string().min(1),
  title: z.string().min(1),
  status: nodeStatusSchema.default("planned"),
  node_class: nodeClassSchema.default("cpu-memory"),
  host_id: z.string().min(1).optional(),
  transport: transportSchema.default("local"),
  ssh_destination: z.string().min(1).optional(),
  workspace_root: z.string().min(1).optional(),
  worker_count: z.number().int().min(1).max(64).optional(),
  tags: z.array(z.string().min(1)).optional(),
  preferred_domains: z.array(z.string().min(1)).optional(),
  desired_backends: z.array(desiredBackendSchema).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
});

export const clusterTopologySchema = z
  .object({
    action: z.enum(["status", "ensure_lab", "upsert_node", "remove_node", "sync_worker_fabric"]).default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    default_node_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    node: clusterTopologyNodeSchema.optional(),
    local_host_id: z.string().min(1).default("local"),
    workspace_root: z.string().min(1).optional(),
    fallback_shell: z.string().min(1).optional(),
    fallback_worker_count: z.number().int().min(1).max(64).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for cluster topology writes",
        path: ["mutation"],
      });
    }
    if (value.action === "upsert_node" && !value.node) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "node is required for upsert_node",
        path: ["node"],
      });
    }
    if (value.action === "remove_node" && !value.node_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "node_id is required for remove_node",
        path: ["node_id"],
      });
    }
  });

function dedupeStrings(values: readonly string[] | undefined | null) {
  return [...new Set((values ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeNodeWorkspaceRoot(node: ClusterTopologyNodeRecord): ClusterTopologyNodeRecord {
  if (!node.workspace_root) {
    return node;
  }
  const workspaceRoot =
    resolveTransportWorkspaceRoot(node.transport, node.workspace_root) ??
    (node.transport === "local" ? process.cwd() : node.workspace_root);
  if (workspaceRoot === node.workspace_root) {
    return node;
  }
  return {
    ...node,
    workspace_root: workspaceRoot,
  };
}

function normalizeNodeId(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function scorePlacementStatus(status: ClusterTopologyNodeStatus) {
  switch (status) {
    case "active":
      return 1;
    case "provisioning":
      return 0.75;
    case "planned":
      return 0.58;
    case "maintenance":
      return 0.35;
    case "retired":
      return 0.05;
    default:
      return 0.2;
  }
}

function scorePlacementClass(nodeClass: ClusterTopologyNodeClass, taskKind: ModelRouterTaskKind | null) {
  if (taskKind === "research" || taskKind === "coding" || taskKind === "verification") {
    if (nodeClass === "gpu-workstation") {
      return 1;
    }
    if (nodeClass === "control-plane") {
      return 0.72;
    }
    if (nodeClass === "cpu-memory") {
      return 0.7;
    }
    return 0.45;
  }
  if (taskKind === "tool_use") {
    if (nodeClass === "cpu-memory" || nodeClass === "control-plane") {
      return 0.92;
    }
    return 0.6;
  }
  if (taskKind === "planning" || taskKind === "chat") {
    if (nodeClass === "control-plane") {
      return 0.96;
    }
    if (nodeClass === "cpu-memory") {
      return 0.78;
    }
    return 0.68;
  }
  return 0.7;
}

function scoreTagFit(candidateTags: string[], requiredTags: string[], preferredTags: string[]) {
  const normalized = new Set(candidateTags.map((entry) => entry.toLowerCase()));
  if (requiredTags.some((tag) => !normalized.has(tag.toLowerCase()))) {
    return null;
  }
  if (preferredTags.length === 0) {
    return 0.6;
  }
  const matched = preferredTags.filter((tag) => normalized.has(tag.toLowerCase())).length;
  return matched / preferredTags.length;
}

function resolveEmptyTopology(): ClusterTopologyStateRecord {
  return {
    enabled: false,
    default_node_id: null,
    nodes: [],
    updated_at: new Date().toISOString(),
  };
}

export function resolveClusterTopologyState(storage: Storage) {
  const state = storage.getClusterTopologyState() ?? resolveEmptyTopology();
  const nodes = state.nodes.map((node) => normalizeNodeWorkspaceRoot(node));
  return nodes.some((node, index) => node !== state.nodes[index]) ? { ...state, nodes } : state;
}

export function summarizeClusterTopologyState(state: ClusterTopologyStateRecord) {
  const statusCounts = state.nodes.reduce<Record<ClusterTopologyNodeStatus, number>>(
    (acc, node) => {
      acc[node.status] += 1;
      return acc;
    },
    {
      planned: 0,
      provisioning: 0,
      active: 0,
      maintenance: 0,
      retired: 0,
    }
  );
  const classCounts = state.nodes.reduce<Record<ClusterTopologyNodeClass, number>>(
    (acc, node) => {
      acc[node.node_class] += 1;
      return acc;
    },
    {
      "control-plane": 0,
      "cpu-memory": 0,
      "gpu-workstation": 0,
      virtualization: 0,
    }
  );
  const syncableNodes = state.nodes.filter((node) => node.status === "active" && node.host_id && node.workspace_root);
  return {
    enabled: state.enabled,
    default_node_id: state.default_node_id,
    node_count: state.nodes.length,
    active_node_count: statusCounts.active,
    planned_node_count: statusCounts.planned,
    provisioning_node_count: statusCounts.provisioning,
    maintenance_node_count: statusCounts.maintenance,
    retired_node_count: statusCounts.retired,
    status_counts: statusCounts,
    class_counts: classCounts,
    syncable_worker_host_count: syncableNodes.length,
    nodes: state.nodes.map((node) => ({
      node_id: node.node_id,
      title: node.title,
      status: node.status,
      node_class: node.node_class,
      host_id: node.host_id,
      transport: node.transport,
      workspace_root: node.workspace_root,
      worker_count: node.worker_count,
      tags: node.tags,
      preferred_domains: node.preferred_domains,
      desired_backend_count: node.desired_backends.length,
    })),
  };
}

function buildDefaultLabNodes(input: { local_host_id: string; workspace_root: string }): ClusterTopologyNodeRecord[] {
  const now = new Date().toISOString();
  const workspaceRoot = resolveTransportWorkspaceRoot("local", input.workspace_root) ?? process.cwd();
  return [
    {
      node_id: "mac-control",
      title: "Mac Control Plane",
      status: "active",
      node_class: "control-plane",
      host_id: input.local_host_id,
      transport: "local",
      ssh_destination: null,
      workspace_root: workspaceRoot,
      worker_count: 4,
      tags: ["local", "control-plane", "developer-workstation", "apple-silicon", "ollama", "bridge"],
      preferred_domains: ["autonomy", "orchestration", "planning", "verification"],
      desired_backends: [
        {
          backend_id: "mac-control-ollama",
          provider: "ollama",
          model_id: "llama3.2:3b",
          tags: ["local", "ollama", "planning", "verification", "bridge"],
          metadata: {
            deployment_role: "control-plane-default",
            topology_node_id: "mac-control",
          },
        },
        {
          backend_id: "mac-control-bridge-codex",
          provider: "openai",
          model_id: "codex",
          tags: ["remote", "hosted", "frontier", "planning", "coding", "verification"],
          metadata: {
            deployment_role: "frontier-fallback",
            topology_node_id: "mac-control",
          },
        },
      ],
      capabilities: {
        locality: "local",
        role: "control-plane",
        platform: process.platform,
        arch: process.arch,
      },
      metadata: {
        bootstrap_source: "cluster.topology.ensure_lab",
      },
      created_at: now,
      updated_at: now,
    },
    {
      node_id: "server-cpu-1",
      title: "CPU Server 1",
      status: "planned",
      node_class: "cpu-memory",
      host_id: "server-cpu-1",
      transport: "ssh",
      ssh_destination: null,
      workspace_root: null,
      worker_count: null,
      tags: ["remote", "server", "cpu-heavy", "memory-heavy", "infra", "container", "virtualization"],
      preferred_domains: ["dns", "dhcp", "firewall", "web-server", "docker", "kubernetes", "proxmox"],
      desired_backends: [
        {
          backend_id: "server-cpu-1-ollama-long-context",
          provider: "ollama",
          model_id: "cpu-long-context",
          tags: ["remote", "server", "ollama", "planning", "research", "long-context", "infra"],
          metadata: {
            deployment_role: "analysis-and-planning",
            topology_node_id: "server-cpu-1",
          },
        },
        {
          backend_id: "server-cpu-1-llama-cpp-infra",
          provider: "llama.cpp",
          model_id: "infra-generalist",
          tags: ["remote", "server", "llama.cpp", "tool_use", "verification", "infra", "container"],
          metadata: {
            deployment_role: "infra-specialist",
            topology_node_id: "server-cpu-1",
          },
        },
      ],
      capabilities: {
        cpu_class: "large",
        ram_class: "large",
        planned: true,
      },
      metadata: {
        bootstrap_source: "cluster.topology.ensure_lab",
      },
      created_at: now,
      updated_at: now,
    },
    {
      node_id: "server-cpu-2",
      title: "CPU Server 2",
      status: "planned",
      node_class: "cpu-memory",
      host_id: "server-cpu-2",
      transport: "ssh",
      ssh_destination: null,
      workspace_root: null,
      worker_count: null,
      tags: ["remote", "server", "cpu-heavy", "memory-heavy", "infra", "container", "virtualization"],
      preferred_domains: ["dns", "dhcp", "firewall", "web-server", "docker", "kubernetes", "proxmox"],
      desired_backends: [
        {
          backend_id: "server-cpu-2-ollama-infra",
          provider: "ollama",
          model_id: "infra-operator",
          tags: ["remote", "server", "ollama", "tool_use", "verification", "infra", "virtualization"],
          metadata: {
            deployment_role: "operations-and-verification",
            topology_node_id: "server-cpu-2",
          },
        },
      ],
      capabilities: {
        cpu_class: "large",
        ram_class: "large",
        planned: true,
      },
      metadata: {
        bootstrap_source: "cluster.topology.ensure_lab",
      },
      created_at: now,
      updated_at: now,
    },
    {
      node_id: "server-cpu-3",
      title: "CPU Server 3",
      status: "planned",
      node_class: "cpu-memory",
      host_id: "server-cpu-3",
      transport: "ssh",
      ssh_destination: null,
      workspace_root: null,
      worker_count: null,
      tags: ["remote", "server", "cpu-heavy", "memory-heavy", "infra", "container", "virtualization"],
      preferred_domains: ["dns", "dhcp", "firewall", "web-server", "docker", "kubernetes", "proxmox"],
      desired_backends: [
        {
          backend_id: "server-cpu-3-ollama-web",
          provider: "ollama",
          model_id: "web-stack-specialist",
          tags: ["remote", "server", "ollama", "coding", "verification", "web", "container"],
          metadata: {
            deployment_role: "web-and-platform",
            topology_node_id: "server-cpu-3",
          },
        },
      ],
      capabilities: {
        cpu_class: "large",
        ram_class: "large",
        planned: true,
      },
      metadata: {
        bootstrap_source: "cluster.topology.ensure_lab",
      },
      created_at: now,
      updated_at: now,
    },
    {
      node_id: "gpu-5090",
      title: "RTX 5090 Workstation",
      status: "planned",
      node_class: "gpu-workstation",
      host_id: "gpu-5090",
      transport: "ssh",
      ssh_destination: null,
      workspace_root: null,
      worker_count: null,
      tags: ["remote", "server", "gpu", "nvidia", "rtx-5090", "coding", "research", "verification", "model-serving"],
      preferred_domains: ["coding", "research", "verification", "model-serving"],
      desired_backends: [
        {
          backend_id: "gpu-5090-vllm-frontier-local",
          provider: "vllm",
          model_id: "gpu-frontier-local",
          tags: ["remote", "gpu", "vllm", "research", "coding", "verification", "model-serving", "high-throughput"],
          metadata: {
            deployment_role: "primary-large-local-model",
            topology_node_id: "gpu-5090",
          },
        },
        {
          backend_id: "gpu-5090-llama-cpp-coder",
          provider: "llama.cpp",
          model_id: "gpu-coder-specialist",
          tags: ["remote", "gpu", "llama.cpp", "coding", "verification", "reasoning"],
          metadata: {
            deployment_role: "coding-specialist",
            topology_node_id: "gpu-5090",
          },
        },
      ],
      capabilities: {
        cpu_model_hint: "i7",
        ram_gb: 128,
        gpu_model: "RTX 5090",
        planned: true,
      },
      metadata: {
        bootstrap_source: "cluster.topology.ensure_lab",
      },
      created_at: now,
      updated_at: now,
    },
  ];
}

function mergeDefaultNodes(existing: ClusterTopologyStateRecord, defaults: ClusterTopologyNodeRecord[]) {
  const byId = new Map(existing.nodes.map((node) => [node.node_id, node]));
  for (const node of defaults) {
    const current = byId.get(node.node_id);
    if (!current) {
      byId.set(node.node_id, node);
      continue;
    }
    const mergedDesiredBackends = [
      ...current.desired_backends,
      ...node.desired_backends.filter(
        (candidate) => !current.desired_backends.some((existingBackend) => existingBackend.backend_id === candidate.backend_id)
      ),
    ];
    byId.set(node.node_id, {
      ...current,
      title: current.title || node.title,
      tags: dedupeStrings([...(current.tags ?? []), ...(node.tags ?? [])]),
      preferred_domains: dedupeStrings([...(current.preferred_domains ?? []), ...(node.preferred_domains ?? [])]),
      desired_backends: mergedDesiredBackends,
      capabilities: {
        ...(node.capabilities ?? {}),
        ...(current.capabilities ?? {}),
      },
      metadata: {
        ...(node.metadata ?? {}),
        ...(current.metadata ?? {}),
      },
      updated_at: current.updated_at,
    });
  }
  return [...byId.values()].sort((left, right) => left.node_id.localeCompare(right.node_id));
}

function defaultHostTelemetry() {
  return {
    heartbeat_at: undefined,
    health_state: "degraded" as const,
    queue_depth: 0,
    active_tasks: 0,
    latency_ms: undefined,
    cpu_utilization: undefined,
    ram_available_gb: undefined,
    ram_total_gb: undefined,
    swap_used_gb: undefined,
    gpu_utilization: undefined,
    gpu_memory_available_gb: undefined,
    gpu_memory_total_gb: undefined,
    disk_free_gb: undefined,
    thermal_pressure: undefined,
  };
}

function normalizeWorkerFabricTelemetryInput(telemetry: Record<string, unknown> | null | undefined) {
  const health_state: "healthy" | "degraded" | "offline" =
    telemetry?.health_state === "healthy" || telemetry?.health_state === "offline"
      ? telemetry.health_state
      : "degraded";
  const thermal_pressure: "nominal" | "fair" | "serious" | "critical" | undefined =
    telemetry?.thermal_pressure === "nominal" ||
    telemetry?.thermal_pressure === "fair" ||
    telemetry?.thermal_pressure === "serious" ||
    telemetry?.thermal_pressure === "critical"
      ? telemetry.thermal_pressure
      : undefined;
  return {
    heartbeat_at: typeof telemetry?.heartbeat_at === "string" ? telemetry.heartbeat_at : undefined,
    health_state,
    queue_depth: typeof telemetry?.queue_depth === "number" ? telemetry.queue_depth : 0,
    active_tasks: typeof telemetry?.active_tasks === "number" ? telemetry.active_tasks : 0,
    latency_ms: typeof telemetry?.latency_ms === "number" ? telemetry.latency_ms : undefined,
    cpu_utilization: typeof telemetry?.cpu_utilization === "number" ? telemetry.cpu_utilization : undefined,
    ram_available_gb: typeof telemetry?.ram_available_gb === "number" ? telemetry.ram_available_gb : undefined,
    ram_total_gb: typeof telemetry?.ram_total_gb === "number" ? telemetry.ram_total_gb : undefined,
    swap_used_gb: typeof telemetry?.swap_used_gb === "number" ? telemetry.swap_used_gb : undefined,
    gpu_utilization: typeof telemetry?.gpu_utilization === "number" ? telemetry.gpu_utilization : undefined,
    gpu_memory_available_gb:
      typeof telemetry?.gpu_memory_available_gb === "number" ? telemetry.gpu_memory_available_gb : undefined,
    gpu_memory_total_gb:
      typeof telemetry?.gpu_memory_total_gb === "number" ? telemetry.gpu_memory_total_gb : undefined,
    disk_free_gb: typeof telemetry?.disk_free_gb === "number" ? telemetry.disk_free_gb : undefined,
    thermal_pressure,
  };
}

export function planClusterTopologyBackends(
  storage: Storage,
  input: {
    task_kind?: ModelRouterTaskKind;
    preferred_tags?: string[];
    required_tags?: string[];
    required_backend_ids?: string[];
  }
) {
  const state = resolveClusterTopologyState(storage);
  const taskKind = input.task_kind ?? null;
  const preferredTags = dedupeStrings(input.preferred_tags);
  const requiredTags = dedupeStrings(input.required_tags);
  const requiredBackendIds = new Set(dedupeStrings(input.required_backend_ids));

  return state.nodes
    .flatMap((node) =>
      node.desired_backends.map((backend) => {
        const candidateTags = dedupeStrings([...(node.tags ?? []), ...(backend.tags ?? []), node.node_class, node.status]);
        if (requiredBackendIds.size > 0 && !requiredBackendIds.has(backend.backend_id)) {
          return null;
        }
        const tagFit = scoreTagFit(candidateTags, requiredTags, preferredTags);
        if (tagFit === null) {
          return null;
        }
        const statusScore = scorePlacementStatus(node.status);
        const classScore = scorePlacementClass(node.node_class, taskKind);
        const domainScore =
          taskKind === "research" && candidateTags.includes("research")
            ? 1
            : taskKind === "coding" && candidateTags.includes("coding")
              ? 1
              : taskKind === "verification" && candidateTags.includes("verification")
                ? 1
                : taskKind === "planning" && candidateTags.includes("planning")
                  ? 1
                  : taskKind === "tool_use" && candidateTags.includes("tool_use")
                    ? 1
                    : 0.7;
        const score = Number((statusScore * 0.35 + classScore * 0.3 + tagFit * 0.2 + domainScore * 0.15).toFixed(4));
        return {
          node_id: node.node_id,
          title: node.title,
          node_status: node.status,
          node_class: node.node_class,
          host_id: node.host_id,
          transport: node.transport,
          backend_id: backend.backend_id,
          provider: backend.provider,
          model_id: backend.model_id,
          tags: candidateTags,
          planned: node.status !== "active",
          score,
          reasoning: {
            status_score: statusScore,
            class_score: classScore,
            tag_fit: Number(tagFit.toFixed(4)),
            domain_score: Number(domainScore.toFixed(4)),
          },
          metadata: {
            ...(backend.metadata ?? {}),
            topology_node_id: node.node_id,
            topology_node_status: node.status,
            topology_node_class: node.node_class,
          },
        };
      })
    )
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.backend_id.localeCompare(right.backend_id);
    });
}

export async function clusterTopology(storage: Storage, input: z.infer<typeof clusterTopologySchema>) {
  const executeStatus = () => {
    const state = resolveClusterTopologyState(storage);
    return {
      ok: true,
      state,
      summary: summarizeClusterTopologyState(state),
    };
  };

  if (input.action === "status") {
    return executeStatus();
  }

  return runIdempotentMutation({
    storage,
    tool_name: "cluster.topology",
    mutation: input.mutation!,
    payload: input,
    execute: async () => {
      const source = {
        source_client: input.source_client,
        source_agent: input.source_agent,
        source_model: input.source_model,
      };
      const current = resolveClusterTopologyState(storage);

      if (input.action === "ensure_lab") {
        const nextNodes = mergeDefaultNodes(
          current,
          buildDefaultLabNodes({
            local_host_id: input.local_host_id,
            workspace_root: resolveTransportWorkspaceRoot("local", input.workspace_root) ?? process.cwd(),
          })
        );
        const state = storage.setClusterTopologyState({
          enabled: input.enabled ?? true,
          default_node_id: input.default_node_id?.trim() || current.default_node_id || "mac-control",
          nodes: nextNodes,
        });
        return {
          ok: true,
          state,
          summary: summarizeClusterTopologyState(state),
          actions: ["cluster.topology.ensure_lab"],
        };
      }

      if (input.action === "upsert_node") {
        const node = input.node!;
        const normalizedNodeId = normalizeNodeId(node.node_id);
        const workspaceRoot = node.workspace_root?.trim() || null;
        const nextNodes = current.nodes
          .filter((entry) => entry.node_id !== normalizedNodeId)
          .concat([
            {
              node_id: normalizedNodeId,
              title: node.title.trim(),
              status: node.status,
              node_class: node.node_class,
              host_id: node.host_id?.trim() || null,
              transport: node.transport,
              ssh_destination: node.ssh_destination?.trim() || null,
              workspace_root:
                workspaceRoot === null
                  ? null
                  : resolveTransportWorkspaceRoot(node.transport, workspaceRoot) ??
                    (node.transport === "local" ? process.cwd() : workspaceRoot),
              worker_count: node.worker_count ?? null,
              tags: dedupeStrings(node.tags),
              preferred_domains: dedupeStrings(node.preferred_domains),
              desired_backends: (node.desired_backends ?? []).map((backend) => ({
                backend_id: backend.backend_id.trim(),
                provider: backend.provider,
                model_id: backend.model_id.trim(),
                tags: dedupeStrings(backend.tags),
                metadata: backend.metadata ?? {},
              })),
              capabilities: node.capabilities ?? {},
              metadata: node.metadata ?? {},
              created_at: current.nodes.find((entry) => entry.node_id === normalizedNodeId)?.created_at ?? new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } satisfies ClusterTopologyNodeRecord,
          ])
          .sort((left, right) => left.node_id.localeCompare(right.node_id));
        const state = storage.setClusterTopologyState({
          enabled: input.enabled ?? current.enabled ?? true,
          default_node_id: input.default_node_id?.trim() || current.default_node_id,
          nodes: nextNodes,
        });
        return {
          ok: true,
          state,
          summary: summarizeClusterTopologyState(state),
          actions: [`cluster.topology.upsert_node:${normalizedNodeId}`],
        };
      }

      if (input.action === "remove_node") {
        const nodeId = normalizeNodeId(input.node_id);
        const nextNodes = current.nodes.filter((entry) => entry.node_id !== nodeId);
        const state = storage.setClusterTopologyState({
          enabled: current.enabled,
          default_node_id: current.default_node_id === nodeId ? null : current.default_node_id,
          nodes: nextNodes,
        });
        return {
          ok: true,
          state,
          summary: summarizeClusterTopologyState(state),
          actions: [`cluster.topology.remove_node:${nodeId}`],
        };
      }

      const state = current.enabled ? current : storage.setClusterTopologyState({ enabled: true, default_node_id: current.default_node_id, nodes: current.nodes });
      const syncableNodes = state.nodes.filter((node) => node.status === "active" && node.host_id && node.workspace_root);
      const fabricBefore = storage.getWorkerFabricState();
      if (!fabricBefore?.enabled) {
        await workerFabric(storage, {
          action: "configure",
          mutation: {
            idempotency_key: `${input.mutation!.idempotency_key}:cluster-topology-sync:configure`,
            side_effect_fingerprint: `${input.mutation!.side_effect_fingerprint}:cluster-topology-sync:configure`,
          },
          enabled: true,
          strategy: "resource_aware",
          default_host_id: syncableNodes.find((node) => node.host_id === input.local_host_id)?.host_id ?? syncableNodes[0]?.host_id ?? input.local_host_id,
          ...source,
        });
      }
      const existingHosts = new Map((storage.getWorkerFabricState()?.hosts ?? []).map((host) => [host.host_id, host]));
      const syncedHosts: string[] = [];
      const skippedNodes = state.nodes
        .filter((node) => !syncableNodes.includes(node))
        .map((node) => ({
          node_id: node.node_id,
          reason:
            node.status !== "active"
              ? `node status is ${node.status}`
              : !node.host_id
                ? "host_id missing"
                : "workspace_root missing",
        }));
      for (const node of syncableNodes) {
        const existing = existingHosts.get(node.host_id!);
        await workerFabric(storage, {
          action: "upsert_host",
          mutation: {
            idempotency_key: `${input.mutation!.idempotency_key}:cluster-topology-sync:${node.node_id}`,
            side_effect_fingerprint: `${input.mutation!.side_effect_fingerprint}:cluster-topology-sync:${node.node_id}`,
          },
          host: {
            host_id: node.host_id!,
            enabled: true,
            transport: node.transport,
            ssh_destination: node.ssh_destination ?? undefined,
            workspace_root: node.workspace_root!,
            worker_count: node.worker_count ?? existing?.worker_count ?? input.fallback_worker_count ?? 1,
            shell: existing?.shell ?? input.fallback_shell ?? "/bin/zsh",
            capabilities: {
              ...(existing?.capabilities ?? {}),
              ...(node.capabilities ?? {}),
              topology_node_id: node.node_id,
              topology_node_class: node.node_class,
            },
            tags: dedupeStrings([
              ...(existing?.tags ?? []),
              ...(node.tags ?? []),
              node.node_class,
              node.status,
            ]),
            telemetry: existing?.telemetry
              ? normalizeWorkerFabricTelemetryInput(existing.telemetry as Record<string, unknown>)
              : defaultHostTelemetry(),
            metadata: {
              ...(existing?.metadata ?? {}),
              ...(node.metadata ?? {}),
              topology_node_id: node.node_id,
              topology_node_class: node.node_class,
            },
          },
          ...source,
        });
        syncedHosts.push(node.host_id!);
      }
      const fabricAfter = storage.getWorkerFabricState();
      return {
        ok: true,
        state,
        summary: summarizeClusterTopologyState(state),
        worker_fabric: fabricAfter,
        synced_hosts: syncedHosts,
        skipped_nodes: skippedNodes,
        actions: ["cluster.topology.sync_worker_fabric"],
      };
    },
  });
}
