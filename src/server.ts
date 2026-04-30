import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Storage, type GoalRecord, type PlanRecord, type PlanStepRecord } from "./storage.js";
import { listToolCatalogEntries, registerToolCatalogEntry } from "./control_plane.js";
import { isPatientZeroExecutionOverrideEnabled, mergeDeclaredPermissionProfile } from "./control_plane_runtime.js";
import {
  desktopAct,
  desktopActSchema,
  desktopControl,
  desktopControlSchema,
  desktopContext,
  desktopContextSchema,
  desktopListen,
  desktopListenSchema,
  desktopObserve,
  desktopObserveSchema,
} from "./tools/desktop_control.js";
import { patientZeroControl, patientZeroSchema } from "./tools/patient_zero.js";
import { privilegedExec, privilegedExecSchema } from "./tools/privileged_exec.js";
import {
  agentClaimNext,
  agentClaimNextSchema,
  agentCurrentTask,
  agentCurrentTaskSchema,
  agentHeartbeatTask,
  agentHeartbeatTaskSchema,
  agentReportResult,
  agentReportResultSchema,
  recommendAdaptiveDispatchRouting,
  agentWorklist,
  agentWorklistSchema,
  agentSessionCloseSchema,
  agentSessionGetSchema,
  agentSessionHeartbeatSchema,
  agentSessionListSchema,
  agentSessionOpenSchema,
  closeAgentSession,
  getAgentSession,
  heartbeatAgentSession,
  listAgentSessions,
  openAgentSession,
} from "./tools/agent_session.js";
import {
  agentLearningListSchema,
  agentLearningSummarySchema,
  listAgentLearning,
  summarizeAgentLearning,
} from "./tools/agent_learning.js";
import { dispatchAutorunSchema } from "./tools/dispatch.js";
import {
  appendMemory,
  captureReflectionMemory,
  getMemory,
  memoryAppendSchema,
  memoryGetSchema,
  memoryRecentSchema,
  memoryReflectionCaptureSchema,
  memorySearchSchema,
  recentMemory,
  searchMemory,
} from "./tools/memory.js";
import {
  applyTranscriptRetention,
  autoSquishControl,
  initializeAutoSquishDaemon,
  appendTranscript,
  getTranscriptPendingRuns,
  getTranscriptRunTimeline,
  logTranscript,
  squishTranscript,
  summarizeTranscript,
  transcriptAppendSchema,
  transcriptAutoSquishSchema,
  transcriptLogSchema,
  transcriptPendingRunsSchema,
  transcriptRetentionSchema,
  transcriptRunTimelineSchema,
  transcriptSquishSchema,
  transcriptSummarizeSchema,
} from "./tools/transcript.js";
import { adrCreateSchema, createAdr } from "./tools/adr.js";
import {
  artifactBundle,
  artifactBundleSchema,
  artifactGet,
  artifactGetSchema,
  artifactLink,
  artifactLinkSchema,
  artifactList,
  artifactListSchema,
  artifactRecord,
  artifactRecordSchema,
} from "./tools/artifact.js";
import {
  experimentCreate,
  experimentCreateSchema,
  experimentGet,
  experimentGetSchema,
  experimentJudge,
  experimentJudgeSchema,
  experimentList,
  experimentListSchema,
  experimentRun,
  experimentRunSchema,
} from "./tools/experiment.js";
import {
  benchmarkRun,
  benchmarkRunSchema,
  benchmarkSuiteList,
  benchmarkSuiteListSchema,
  benchmarkSuiteUpsert,
  benchmarkSuiteUpsertSchema,
} from "./tools/benchmark.js";
import { evalRun, evalRunSchema, evalSuiteList, evalSuiteListSchema, evalSuiteUpsert, evalSuiteUpsertSchema } from "./tools/eval.js";
import { eventPublish, eventPublishSchema, eventSummary, eventSummarySchema, eventTail, eventTailSchema } from "./tools/event.js";
import {
  countActionableRecentObservabilityDocuments,
  observabilityDashboard,
  observabilityDashboardSchema,
  observabilityIngest,
  observabilityIngestSchema,
  isActionableRecentObservabilityDocument,
  observabilitySearch,
  observabilitySearchSchema,
  observabilityShip,
  observabilityShipSchema,
} from "./tools/observability.js";
import { workflowExport, workflowExportSchema } from "./tools/workflow_export.js";
import { buildOfficeGuiSnapshot } from "./office_gui_snapshot.js";
import {
  goalAutorun,
  goalAutorunDaemonControl,
  goalAutorunDaemonSchema,
  goalAutorunSchema,
  goalCreate,
  goalCreateSchema,
  goalExecute,
  goalExecuteSchema,
  goalHygiene,
  goalHygieneSchema,
  goalGet,
  goalGetSchema,
  initializeGoalAutorunDaemon,
  goalList,
  goalListSchema,
} from "./tools/goal.js";
import { kernelSummary, kernelSummarySchema } from "./tools/kernel.js";
import {
  goalPlanGenerate,
  goalPlanGenerateSchema,
  listPackHooks,
  packHooksListSchema,
  packPlanGenerate,
  packPlanGenerateSchema,
  packVerifyRun,
  packVerifyRunSchema,
  type PackHookRegistry,
  type RegisteredPlannerHook,
  type RegisteredVerifierHook,
} from "./tools/pack_hooks.js";
import {
  playbookGet,
  playbookGetSchema,
  playbookInstantiate,
  playbookInstantiateSchema,
  playbookList,
  playbookListSchema,
  playbookRun,
  playbookRunSchema,
} from "./tools/playbook.js";
import {
  planCreate,
  planCreateSchema,
  planApprove,
  planApproveSchema,
  planDispatchSchema,
  evaluatePlanStepReadiness,
  planGet,
  planGetSchema,
  planList,
  planListSchema,
  planResumeSchema,
  planSelect,
  planSelectSchema,
  planStepReady,
  planStepReadySchema,
  planStepUpdate,
  planStepUpdateSchema,
  planUpdate,
  planUpdateSchema,
} from "./tools/plan.js";
import { whoKnows, whoKnowsSchema } from "./tools/who_knows.js";
import { policyEvaluateSchema, evaluatePolicy } from "./tools/policy.js";
import { runBegin, runBeginSchema, runEnd, runEndSchema, runStep, runStepSchema, runTimeline, runTimelineSchema } from "./tools/run.js";
import { mutationCheck, mutationCheckSchema } from "./tools/idempotency.js";
import { preflightCheck, preflightCheckSchema, postflightVerify, postflightVerifySchema } from "./tools/verification.js";
import { acquireLock, lockAcquireSchema, lockReleaseSchema, releaseLock } from "./tools/locks.js";
import { knowledgeDecay, knowledgeDecaySchema, knowledgePromote, knowledgePromoteSchema, retrievalHybrid, retrievalHybridSchema } from "./tools/knowledge.js";
import { decisionLink, decisionLinkSchema } from "./tools/decision.js";
import { simulateWorkflow, simulateWorkflowSchema } from "./tools/simulate.js";
import { healthPolicy, healthPolicySchema, healthStorage, healthStorageSchema, healthTools, healthToolsSchema } from "./tools/health.js";
import { storageBackups, storageBackupsSchema } from "./tools/storage_maintenance.js";
import { incidentOpen, incidentOpenSchema, incidentTimeline, incidentTimelineSchema } from "./tools/incident.js";
import { goldenCaseCapture, goldenCaseCaptureSchema } from "./tools/golden_case.js";
import { queryPlan, queryPlanSchema } from "./tools/query_plan.js";
import { migrationStatus, migrationStatusSchema } from "./tools/migration.js";
import { runIdempotentMutation } from "./tools/mutation.js";
import { inboxEnqueue, inboxEnqueueSchema, inboxList, inboxListSchema } from "./tools/inbox.js";
import {
  taskClaim,
  taskClaimSchema,
  taskComplete,
  taskCompleteSchema,
  taskCreate,
  taskCreateSchema,
  taskExecutionSchema,
  taskCancel,
  taskCancelSchema,
  taskFail,
  taskFailSchema,
  taskHeartbeat,
  taskHeartbeatSchema,
  taskList,
  taskListSchema,
  taskSummary,
  taskSummarySchema,
  taskTimeline,
  taskTimelineSchema,
  taskRetry,
  taskRetrySchema,
  taskRecoverExpired,
  taskRecoverExpiredSchema,
  taskAutoRetryControl,
  taskAutoRetrySchema,
  initializeTaskAutoRetryDaemon,
} from "./tools/task.js";
import {
  buildWorkerFabricSlots,
  rankWorkerFabricSlots,
  resolveEffectiveWorkerFabric,
  resolveTaskExecutionRouting,
  workerFabric,
  workerFabricSchema,
} from "./tools/worker_fabric.js";
import { clusterTopology, clusterTopologySchema } from "./tools/cluster_topology.js";
import { modelRouter, modelRouterSchema, routeObjectiveBackends } from "./tools/model_router.js";
import { orgProgram, orgProgramSchema } from "./tools/org_program.js";
import { optimizer, optimizerSchema } from "./tools/optimizer.js";
import { swarmProfile, swarmProfileSchema } from "./tools/swarm_profile.js";
import { taskCompile, taskCompileSchema } from "./tools/task_compiler.js";
import { autonomyBootstrap, autonomyBootstrapSchema } from "./tools/autonomy_bootstrap.js";
import {
  autonomyMaintain,
  autonomyMaintainSchema,
  buildEvalHealth,
  computeEvalDependencyFingerprint,
  getAutonomyMaintainRuntimeStatus,
  isAutonomyMaintainAwaitingFirstTick,
  initializeAutonomyMaintainDaemon,
} from "./tools/autonomy_maintain.js";
import { autonomyCommand, autonomyCommandSchema } from "./tools/autonomy_command.js";
import { autonomyIdeIngress, autonomyIdeIngressSchema } from "./tools/autonomy_ide_ingress.js";
import { providerBridge, providerBridgeSchema } from "./tools/provider_bridge.js";
import { runtimeWorker, runtimeWorkerSchema } from "./tools/runtime_worker.js";
import { notifierSend, notifierSendSchema } from "./tools/notifier.js";
import { officeRealtimeSnapshot, officeSnapshot, officeSnapshotSchema } from "./tools/office_snapshot.js";
import { operatorBrief, operatorBriefSchema } from "./tools/operator_brief.js";
import {
  budgetLedgerControl,
  budgetLedgerSchema,
  featureFlagControl,
  featureFlagSchema,
  permissionProfileControl,
  permissionProfileSchema,
} from "./tools/control_plane_admin.js";
import { toolSearch, toolSearchSchema } from "./tools/tool_search.js";
import {
  getReactionEngineRuntimeStatus,
  initializeReactionEngineDaemon,
  reactionEngineControl,
  reactionEngineSchema,
} from "./tools/reaction_engine.js";
import { matchDomainSpecialists, specialistCatalog, specialistCatalogSchema } from "./tools/specialist_catalog.js";
import { initializeWarmCacheLane, startWarmCacheStartupPrefetch, warmCacheControl, warmCacheSchema } from "./tools/warm_cache.js";
import {
  trichatChaos,
  trichatChaosSchema,
  trichatSlo,
  trichatSloSchema,
  trichatAdapterProtocolCheck,
  trichatAdapterProtocolCheckSchema,
  trichatAdapterTelemetry,
  trichatAdapterTelemetrySchema,
  trichatConsensus,
  trichatConsensusSchema,
  trichatNovelty,
  trichatNoveltySchema,
  trichatTurnAdvance,
  trichatTurnAdvanceSchema,
  trichatTurnArtifact,
  trichatTurnArtifactSchema,
  trichatTurnGet,
  trichatTurnGetSchema,
  trichatTurnOrchestrate,
  trichatTurnOrchestrateSchema,
  trichatTurnStart,
  trichatTurnStartSchema,
  trichatWorkboard,
  trichatWorkboardSchema,
  initializeTriChatAutoRetentionDaemon,
  trichatAutoRetentionControl,
  trichatAutoRetentionSchema,
  trichatMessagePost,
  trichatMessagePostSchema,
  trichatRetention,
  trichatRetentionSchema,
  trichatRoster,
  trichatRosterSchema,
  trichatSummary,
  trichatSummarySchema,
  trichatThreadGet,
  trichatThreadGetSchema,
  trichatThreadList,
  trichatThreadListSchema,
  trichatThreadOpen,
  trichatThreadOpenSchema,
  trichatTurnWatchdogControl,
  trichatTurnWatchdogSchema,
  trichatTimeline,
  trichatTimelineSchema,
  initializeTriChatTurnWatchdogDaemon,
  initializeTriChatAutopilotDaemon,
  trichatAutopilotControl,
  trichatAutopilotSchema,
  trichatTmuxController,
  trichatTmuxControllerSchema,
  trichatTurnAutorun,
} from "./tools/trichat.js";
import { TriChatBusRuntime, trichatBusControl, trichatBusSchema } from "./tools/trichat_bus.js";
import {
  imprintAutoSnapshotControl,
  imprintAutoSnapshotSchema,
  imprintBootstrap,
  imprintBootstrapSchema,
  imprintProfileGet,
  imprintProfileGetSchema,
  imprintProfileSet,
  imprintProfileSetSchema,
  imprintSnapshot,
  imprintSnapshotSchema,
  initializeImprintAutoSnapshotDaemon,
} from "./tools/imprint.js";
import { startStdioTransport } from "./transports/stdio.js";
import { startHttpTransport } from "./transports/http.js";
import { truncate } from "./utils.js";
import { type DomainPackPlannerHook, type DomainPackVerifierHook } from "./domain-packs/types.js";
import {
  listBuiltinDomainPacks,
  parseEnabledDomainPackIds,
  registerDomainPacks,
} from "./domain-packs/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.DOTENV_CONFIG_PATH
  ? path.resolve(process.env.DOTENV_CONFIG_PATH)
  : path.join(repoRoot, ".env");
dotenv.config({ path: envPath });

const storagePathEnv = process.env.ANAMNESIS_HUB_DB_PATH ?? process.env.MCP_HUB_DB_PATH;
const storagePath = storagePathEnv
  ? path.resolve(storagePathEnv)
  : path.join(repoRoot, "data", "hub.sqlite");
function resolveDefaultTriChatBusSocketPath(root: string) {
  if (process.env.TRICHAT_BUS_SOCKET_PATH?.trim()) {
    return path.resolve(process.env.TRICHAT_BUS_SOCKET_PATH);
  }
  const legacyPath = path.join(root, "data", "trichat.bus.sock");
  if (Buffer.byteLength(legacyPath) < 100) {
    return legacyPath;
  }
  const digest = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  const cacheBase =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "master-mold")
      : path.join(os.homedir(), ".cache", "master-mold");
  const candidates = [
    path.join(cacheBase, `trichat-${digest}.sock`),
    path.join("/tmp", `master-mold-trichat-${digest}.sock`),
  ];
  return candidates.find((entry) => Buffer.byteLength(entry) < 100) ?? candidates[candidates.length - 1];
}

const storage = new Storage(storagePath);
storage.init();
const startupModeArgs = process.argv.slice(2);
const startupHttpEnabled = startupModeArgs.includes("--http") || process.env.MCP_HTTP === "1";
const backgroundOwnerEnabled = parseBooleanEnv(process.env.MCP_BACKGROUND_OWNER, startupHttpEnabled);
initializeAutoSquishDaemon(storage);
initializeTaskAutoRetryDaemon(storage);
initializeTriChatAutoRetentionDaemon(storage);
initializeTriChatTurnWatchdogDaemon(storage);
initializeTriChatAutopilotDaemon(storage, invokeRegisteredTool);
const triChatBusRuntime = new TriChatBusRuntime(storage, {
  socket_path: resolveDefaultTriChatBusSocketPath(repoRoot),
});
triChatBusRuntime.initialize({
  auto_start: backgroundOwnerEnabled && parseBooleanEnv(process.env.TRICHAT_BUS_AUTOSTART, true),
});
let shutdownRegistered = false;
function registerRuntimeShutdownHandlers() {
  if (shutdownRegistered) {
    return;
  }
  shutdownRegistered = true;
  let stopping = false;
  const stopBus = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      triChatBusRuntime.stop();
    } catch {
      // Best-effort shutdown.
    }
  };
  process.once("SIGTERM", () => {
    stopBus();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    stopBus();
    process.exit(130);
  });
  process.once("exit", () => {
    stopBus();
  });
}
registerRuntimeShutdownHandlers();

const SERVER_NAME = "master-mold";
const SERVER_VERSION = "1.0.0";
const SERVER_INSTRUCTIONS = [
  "Use autonomy.ide_ingress as the canonical operator objective entrypoint.",
  "Prefer local-first specialist routing and bounded execution.",
  "Use operator.brief and office.snapshot for current runtime state before mutating work.",
  "This server exposes durable autonomy, observability, workflow, and office-control tooling.",
].join(" ");
const CONSENSUS_ALERT_MIN_AGENTS = parseConsensusMinAgents(process.env.TRICHAT_CONSENSUS_ALERT_MIN_AGENTS);
const DEFAULT_TRICHAT_VERIFY_COMMAND = String(process.env.TRICHAT_VERIFY_COMMAND ?? "").trim();
const DEFAULT_TRICHAT_VERIFY_TIMEOUT_SECONDS = parseBoundedInt(process.env.TRICHAT_VERIFY_TIMEOUT_SECONDS, 90, 5, 1800);

type ToolEntry = {
  schema: z.ZodTypeAny;
  tool: Tool;
  handler: (input: any) => Promise<unknown> | unknown;
};

const trichatVerifySchema = z.object({
  project_dir: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  timeout_seconds: z.number().int().min(5).max(1800).optional(),
  capture_limit: z.number().int().min(200).max(20000).optional(),
});

const toolRegistry = new Map<string, ToolEntry>();
const packHookRegistry: PackHookRegistry = {
  planners: [],
  verifiers: [],
};

function registerTool(name: string, description: string, schema: z.ZodTypeAny, handler: ToolEntry["handler"]) {
  const tool: Tool = {
    name,
    description,
    inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Tool["inputSchema"],
  };
  toolRegistry.set(name, { schema, tool, handler });
  registerToolCatalogEntry(tool);
}

async function invokeRegisteredTool(name: string, args: unknown) {
  const entry = toolRegistry.get(name);
  if (!entry) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const parsed = entry.schema.parse(args ?? {});
  return entry.handler(parsed);
}

function registerPlannerHook(packId: string, hook: DomainPackPlannerHook) {
  const hookId = `${packId}.${hook.hook_name}`;
  if (packHookRegistry.planners.some((candidate) => candidate.hook_id === hookId)) {
    throw new Error(`Duplicate planner hook registration: ${hookId}`);
  }
  const registered: RegisteredPlannerHook = {
    ...hook,
    pack_id: packId,
    hook_kind: "planner",
    hook_id: hookId,
  };
  packHookRegistry.planners.push(registered);
}

function registerVerifierHook(packId: string, hook: DomainPackVerifierHook) {
  const hookId = `${packId}.${hook.hook_name}`;
  if (packHookRegistry.verifiers.some((candidate) => candidate.hook_id === hookId)) {
    throw new Error(`Duplicate verifier hook registration: ${hookId}`);
  }
  const registered: RegisteredVerifierHook = {
    ...hook,
    pack_id: packId,
    hook_kind: "verifier",
    hook_id: hookId,
  };
  packHookRegistry.verifiers.push(registered);
}

function hashDispatchValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildPlanDispatchDerivedMutation(
  base: { idempotency_key: string; side_effect_fingerprint: string },
  label: string,
  seed: string
) {
  const keyHash = hashDispatchValue(`${base.idempotency_key}|${label}|${seed}`).slice(0, 40);
  const fingerprintHash = hashDispatchValue(`${base.side_effect_fingerprint}|${label}|${seed}`).slice(0, 64);
  return {
    idempotency_key: `plan-dispatch-${keyHash}`,
    side_effect_fingerprint: `plan-dispatch-${fingerprintHash}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateFederationText(value: string, maxLength = 2_000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated:${value.length - maxLength}>` : value;
}

function sanitizeFederationValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncateFederationText(value);
  }
  if (depth >= 5) {
    return "[max_depth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeFederationValue(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return String(value);
  }
  const entries = Object.entries(value).slice(0, 80);
  return Object.fromEntries(entries.map(([key, entry]) => [truncateFederationText(key, 160), sanitizeFederationValue(entry, depth + 1)]));
}

function federationPayloadSummary(payload: Record<string, unknown>) {
  const host = isRecord(payload.host) ? payload.host : {};
  const desktopContext = isRecord(payload.desktop_context) ? payload.desktop_context : {};
  const localMcp = isRecord(payload.local_mcp) ? payload.local_mcp : {};
  const sharedSummaries = isRecord(payload.shared_summaries) ? payload.shared_summaries : {};
  const recentEvents = Array.isArray(payload.recent_events) ? payload.recent_events : [];
  return {
    schema_version: readString(payload.schema_version) ?? "unknown",
    stream_id: readString(payload.stream_id) ?? null,
    sequence: readFiniteNumber(payload.sequence) ?? null,
    generated_at: readString(payload.generated_at) ?? null,
    host: sanitizeFederationValue(host),
    capabilities: sanitizeFederationValue(payload.capabilities ?? {}),
    desktop_context: sanitizeFederationValue(desktopContext),
    local_mcp: sanitizeFederationValue(localMcp),
    shared_summaries: sanitizeFederationValue(sharedSummaries),
    recent_event_count: recentEvents.length,
    recent_events: sanitizeFederationValue(recentEvents.slice(0, 25)),
  };
}

function federationApprovalScope(networkGate: Record<string, unknown>) {
  const approvalScope = isRecord(networkGate.approval_scope) ? networkGate.approval_scope : null;
  const whitelistScope = isRecord(networkGate.whitelist_scope) ? networkGate.whitelist_scope : approvalScope;
  return sanitizeFederationValue(approvalScope ?? whitelistScope ?? null);
}

function federationSignatureVerification(networkGate: Record<string, unknown>) {
  const explicit = isRecord(networkGate.signature_verification) ? networkGate.signature_verification : null;
  if (explicit) {
    return sanitizeFederationValue(explicit);
  }
  const status = readString(networkGate.signature_status) ?? "unknown";
  return {
    status,
    verified: status === "verified",
    signed_at: readString(networkGate.signed_at) ?? null,
    signed_agent_id: readString(networkGate.signed_agent_id) ?? null,
    identity_public_key_fingerprint: readString(networkGate.identity_public_key_fingerprint) ?? null,
  };
}

function federationIdentityEnvelope(payload: Record<string, unknown>, networkGate: Record<string, unknown>, receivedAt: string) {
  const hostPayload = isRecord(payload.host) ? payload.host : {};
  const approvalScope = federationApprovalScope(networkGate);
  return {
    requesting_host_id: readString(networkGate.host_id) ?? null,
    requesting_remote_address: readString(networkGate.remote_address) ?? null,
    captured_from_host_id: readString(hostPayload.host_id) ?? readString(networkGate.host_id) ?? "unknown-peer",
    captured_hostname: readString(hostPayload.hostname) ?? readString(networkGate.host_hostname) ?? null,
    captured_agent_runtime: readString(hostPayload.agent_runtime) ?? readString(networkGate.agent_runtime) ?? null,
    captured_model_label: readString(hostPayload.model_label) ?? readString(networkGate.model_label) ?? null,
    signed_at: readString(networkGate.signed_at) ?? null,
    received_at: readString(networkGate.received_at) ?? receivedAt,
    signature_verification_result: federationSignatureVerification(networkGate),
    approval_scope: approvalScope,
    whitelist_scope: approvalScope,
  };
}

function stableFederationMutation(hostId: string, streamId: string, sequence: number | null, createdAt: string) {
  const digest = crypto.createHash("sha256").update(`${hostId}|${streamId}|${sequence ?? createdAt}`).digest("hex");
  return {
    idempotency_key: `federation-ingest-${digest.slice(0, 40)}`,
    side_effect_fingerprint: `federation-ingest:${digest.slice(0, 64)}`,
  };
}

function classifyWorkerFabricHeartbeatFailure(hostId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === `Unknown worker fabric host: ${hostId}`) {
    return {
      reason: "host_not_staged",
      detail: `Verified peer ${hostId} is not staged in worker.fabric yet. Stage and approve the host before treating federation ingest as healthy.`,
      error: message,
    };
  }
  return {
    reason: "worker_fabric_heartbeat_failed",
    detail: `Federation ingest was accepted but worker.fabric heartbeat failed for ${hostId}.`,
    error: message,
  };
}

function ingestFederationPayload(storage: Storage, payload: Record<string, unknown>, networkGate: Record<string, unknown>) {
  const createdAt = new Date().toISOString();
  const hostPayload = isRecord(payload.host) ? payload.host : {};
  const capturedHostId = readString(hostPayload.host_id);
  const requestHostId = readString(networkGate.host_id);
  const hostId = requestHostId ?? capturedHostId ?? "unknown-peer";
  const streamId = readString(payload.stream_id) ?? `${hostId}:default`;
  const sequence = readFiniteNumber(payload.sequence);
  const roundedSequence = sequence === undefined ? null : Math.round(sequence);
  const summaryPayload = federationPayloadSummary(payload);
  const identityEnvelope = federationIdentityEnvelope(payload, networkGate, createdAt);
  const sourceAgent =
    readString(networkGate.signed_agent_id) ??
    readString(networkGate.agent_runtime) ??
    readString(hostPayload.agent_runtime) ??
    readString(hostPayload.agent_id) ??
    hostId;
  const modelLabel = readString(hostPayload.model_label) ?? readString(networkGate.model_label);
  const event = storage.appendRuntimeEvent({
    created_at: createdAt,
    event_type: "federation.ingest",
    entity_type: "worker_fabric_host",
    entity_id: hostId,
    status: "received",
    summary: `federation ingest from ${hostId}${roundedSequence === null ? "" : ` seq=${roundedSequence}`}`,
    details: {
      ...identityEnvelope,
      network_gate: sanitizeFederationValue(networkGate),
      federation_identity: sanitizeFederationValue(identityEnvelope),
      ...summaryPayload,
    },
    source_client: "federation.sidecar",
    source_model: modelLabel,
    source_agent: sourceAgent,
  });

  let workerFabricHeartbeatOk = false;
  let workerFabricHeartbeatError: string | null = null;
  let workerFabricHeartbeatReason: string | null = null;
  let workerFabricHeartbeatDetail: string | null = null;
  const approvalScope = isRecord(identityEnvelope.approval_scope) ? identityEnvelope.approval_scope : {};
  const remoteLocatorAddress = readString(identityEnvelope.requesting_remote_address);
  try {
    workerFabric(storage, {
      action: "heartbeat",
      mutation: stableFederationMutation(hostId, streamId, roundedSequence, createdAt),
      host_id: hostId,
      capabilities: {
        federation_stream: true,
        federation_sidecar: true,
      },
      metadata: {
        federation: {
          identity: identityEnvelope,
          ...summaryPayload,
          last_ingest_at: createdAt,
          last_ingest_event_id: event.event_id,
          last_stream_id: streamId,
          last_sequence: roundedSequence,
          peer_signature_status: readString(networkGate.signature_status) ?? null,
        },
        ...(remoteLocatorAddress
          ? {
              remote_locator: {
                current_ip_address: remoteLocatorAddress,
                observed_at: createdAt,
                matched_by: readString(approvalScope.matched_by),
                matched_hostname: readString(identityEnvelope.captured_hostname),
                identity_basis: ["hostname", "signed_identity"],
              },
            }
          : {}),
      },
      tags: ["federation-peer"],
      telemetry: {
        heartbeat_at: createdAt,
        health_state: "healthy",
      },
      source_client: "federation.ingest",
      source_model: modelLabel,
      source_agent: sourceAgent,
    } as z.infer<typeof workerFabricSchema>);
    workerFabricHeartbeatOk = true;
  } catch (error) {
    const heartbeatFailure = classifyWorkerFabricHeartbeatFailure(hostId, error);
    workerFabricHeartbeatError = heartbeatFailure.error;
    workerFabricHeartbeatReason = heartbeatFailure.reason;
    workerFabricHeartbeatDetail = heartbeatFailure.detail;
    storage.appendRuntimeEvent({
      created_at: createdAt,
      event_type: "federation.ingest.warning",
      entity_type: "worker_fabric_host",
      entity_id: hostId,
      status: "degraded",
      summary: `federation ingest could not update worker fabric host ${hostId}`,
      details: {
        error: workerFabricHeartbeatError,
        reason: workerFabricHeartbeatReason,
        detail: workerFabricHeartbeatDetail,
        requesting_host_id: identityEnvelope.requesting_host_id,
        requesting_remote_address: identityEnvelope.requesting_remote_address,
        captured_hostname: identityEnvelope.captured_hostname,
        captured_agent_runtime: identityEnvelope.captured_agent_runtime,
        captured_model_label: identityEnvelope.captured_model_label,
        stream_id: streamId,
        sequence: roundedSequence,
      },
      source_client: "federation.sidecar",
      source_model: modelLabel,
      source_agent: sourceAgent,
    });
  }

  return {
    ok: true,
    event_id: event.event_id,
    event_seq: event.event_seq,
    host_id: hostId,
    stream_id: streamId,
    sequence: roundedSequence,
    worker_fabric_heartbeat_ok: workerFabricHeartbeatOk,
    worker_fabric_heartbeat_error: workerFabricHeartbeatError,
    worker_fabric_heartbeat_reason: workerFabricHeartbeatReason,
    worker_fabric_heartbeat_detail: workerFabricHeartbeatDetail,
  };
}

function resolveEffectiveTriChatAgentIds(
  storage: Storage,
  objective: string | undefined,
  explicitAgentIds: readonly string[] | undefined
) {
  const objectiveText = readString(objective) ?? "";
  const matchedAgentIds =
    objectiveText.length > 0
      ? matchDomainSpecialists(storage, objectiveText, 6, 0.3).flatMap((entry) => entry.recommended_trichat_agent_ids)
      : [];
  const mergedExplicit = [
    ...new Set(
      [...(explicitAgentIds ?? []), ...matchedAgentIds].map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry))
    ),
  ];
  if (objectiveText.length === 0) {
    return mergedExplicit.length > 0 ? mergedExplicit : undefined;
  }
  const routed = routeObjectiveBackends(storage, {
    objective: objectiveText,
    explicit_agent_ids: mergedExplicit,
    quality_preference: "balanced",
    fallback_workspace_root: process.cwd(),
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  });
  return routed.effective_agent_ids.length > 0 ? routed.effective_agent_ids : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mergeUniqueStrings(...values: Array<readonly string[] | undefined>) {
  return [
    ...new Set(
      values
        .flatMap((entries) => [...(entries ?? [])])
        .map((entry) => readString(entry))
        .filter((entry): entry is string => Boolean(entry))
    ),
  ];
}

function readQualityPreference(value: unknown): "speed" | "balanced" | "quality" | "cost" | undefined {
  const normalized = readString(value);
  if (normalized === "speed" || normalized === "balanced" || normalized === "quality" || normalized === "cost") {
    return normalized;
  }
  return undefined;
}

function mergePlanDispatchMetadata(stepMetadata: unknown, inputMetadata: unknown) {
  const mergedInput = isRecord(inputMetadata) ? { ...inputMetadata } : {};
  const stepRecord = isRecord(stepMetadata) ? stepMetadata : null;
  const inheritedKeys = [
    "compiler",
    "owner_role_id",
    "org_program_version_id",
    "org_program_summary",
    "org_program_doctrine",
    "org_program_delegation_contract",
    "org_program_evaluation_standard",
    "org_program_signals",
    "swarm_profile",
    "checkpoint_required",
    "checkpoint_cadence",
    "memory_preflight",
    "working_memory",
  ] as const;
  for (const key of inheritedKeys) {
    if (!(key in mergedInput) && stepRecord && key in stepRecord) {
      mergedInput[key] = stepRecord[key];
    }
  }
  const stepTaskExecution = stepRecord && isRecord(stepRecord.task_execution) ? stepRecord.task_execution : null;
  const inputTaskExecution = isRecord(mergedInput.task_execution) ? mergedInput.task_execution : null;
  if (!stepTaskExecution && !inputTaskExecution) {
    return mergedInput;
  }
  return {
    ...mergedInput,
    task_execution: {
      ...(stepTaskExecution ?? {}),
      ...(inputTaskExecution ?? {}),
    },
  };
}

function synthesizePlanDispatchDelegationBrief(step: PlanStepRecord, rawInput: Record<string, unknown>, payload: Record<string, unknown>, metadata: Record<string, unknown>) {
  const payloadBrief = isRecord(payload.delegation_brief) ? payload.delegation_brief : null;
  const metadataBrief = isRecord(metadata.delegation_brief) ? metadata.delegation_brief : null;
  const explicitBrief = payloadBrief ?? metadataBrief;
  const stepInput = isRecord(step.input) ? step.input : {};
  const taskObjective = readString(explicitBrief?.task_objective) ?? readString(rawInput.objective) ?? step.title;
  const successCriteria = mergeUniqueStrings(
    readStringArray(explicitBrief?.success_criteria),
    readStringArray(rawInput.success_criteria),
    step.acceptance_checks
  );
  const evidenceRequirements = mergeUniqueStrings(
    readStringArray(explicitBrief?.evidence_requirements),
    readStringArray(rawInput.evidence_requirements),
    readStringArray(stepInput.evidence_requirements)
  );
  const rollbackNotes = mergeUniqueStrings(
    readStringArray(explicitBrief?.rollback_notes),
    readStringArray(rawInput.rollback_notes),
    readStringArray(stepInput.rollback_notes)
  );
  const delegateAgentId = readString(explicitBrief?.delegate_agent_id) ?? readString(rawInput.delegate_agent_id) ?? null;
  if (!taskObjective && successCriteria.length === 0 && evidenceRequirements.length === 0 && rollbackNotes.length === 0) {
    return null;
  }
  return {
    delegate_agent_id: delegateAgentId,
    task_objective: taskObjective,
    success_criteria: successCriteria,
    evidence_requirements: evidenceRequirements,
    rollback_notes: rollbackNotes,
  };
}

function planDispatchTaskExecution(
  storage: Storage,
  params: {
    objective: string;
    project_dir: string;
    metadata: Record<string, unknown>;
    tags: string[];
  }
) {
  const baseExecution = isRecord(params.metadata.task_execution)
    ? params.metadata.task_execution
    : isRecord(params.metadata.execution)
      ? params.metadata.execution
      : {};
  const basePreferredModelTags = readStringArray(baseExecution.preferred_model_tags);
  const baseRequiredModelTags = readStringArray(baseExecution.required_model_tags);
  const basePreferredBackendIds = readStringArray(baseExecution.preferred_backend_ids);
  const baseRequiredBackendIds = readStringArray(baseExecution.required_backend_ids);
  const qualityPreference = readQualityPreference(baseExecution.quality_preference) ?? "balanced";
  const reasoningSelectionStrategy = readString(baseExecution.reasoning_selection_strategy);
  const modelRouterSelection = routeObjectiveBackends(storage, {
    objective: params.objective,
    preferred_tags: mergeUniqueStrings(basePreferredModelTags, params.tags),
    required_tags: baseRequiredModelTags,
    required_backend_ids: baseRequiredBackendIds,
    quality_preference: qualityPreference,
    fallback_workspace_root: params.project_dir,
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  });
  const selectedBackend = modelRouterSelection.route.selected_backend;
  const plannedCandidates = modelRouterSelection.route.planned_backends.slice(0, 4);
  const taskExecutionInput = {
    preferred_host_ids: mergeUniqueStrings(
      readStringArray(baseExecution.preferred_host_ids),
      selectedBackend?.host_id ? [selectedBackend.host_id] : undefined,
      plannedCandidates.map((entry) => entry.host_id).filter((entry): entry is string => Boolean(entry))
    ),
    allowed_host_ids: readStringArray(baseExecution.allowed_host_ids),
    preferred_host_tags: mergeUniqueStrings(readStringArray(baseExecution.preferred_host_tags)),
    required_host_tags: mergeUniqueStrings(readStringArray(baseExecution.required_host_tags)),
    preferred_backend_ids: mergeUniqueStrings(
      basePreferredBackendIds,
      selectedBackend?.backend_id ? [selectedBackend.backend_id] : undefined
    ),
    required_backend_ids: baseRequiredBackendIds,
    preferred_model_tags: mergeUniqueStrings(basePreferredModelTags, modelRouterSelection.preferred_tags),
    required_model_tags: baseRequiredModelTags,
    isolation_mode: readString(baseExecution.isolation_mode) ?? "git_worktree",
    task_kind: modelRouterSelection.task_kind,
    quality_preference: qualityPreference,
    selected_backend_id: selectedBackend?.backend_id,
    selected_backend_provider: selectedBackend?.provider,
    selected_backend_locality: selectedBackend?.locality,
    selected_host_id: selectedBackend?.host_id,
    routed_bridge_agent_ids: modelRouterSelection.routed_bridge_agent_ids,
    planned_backend_candidates: plannedCandidates.map((entry) => ({
      backend_id: entry.backend_id,
      provider: entry.provider,
      host_id: entry.host_id,
      node_id: entry.node_id,
      title: entry.title,
      score: entry.score,
    })),
    focus: readString(baseExecution.focus),
    reasoning_candidate_count:
      typeof baseExecution.reasoning_candidate_count === "number" && Number.isFinite(baseExecution.reasoning_candidate_count)
        ? Math.max(1, Math.min(4, Math.round(baseExecution.reasoning_candidate_count)))
        : undefined,
    reasoning_selection_strategy:
      reasoningSelectionStrategy === "single_path" || reasoningSelectionStrategy === "evidence_rerank"
        ? reasoningSelectionStrategy
        : undefined,
    require_plan_pass: baseExecution.require_plan_pass === true,
    require_verification_pass: baseExecution.require_verification_pass === true,
  };
  const parsedTaskExecution = taskExecutionSchema.parse(taskExecutionInput);
  const fabricState = resolveEffectiveWorkerFabric(storage, {
    fallback_workspace_root: params.project_dir,
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  });
  const rankedSlots = rankWorkerFabricSlots(
    buildWorkerFabricSlots(storage, {
      fallback_workspace_root: params.project_dir,
      fallback_worker_count: 1,
      fallback_shell: "/bin/zsh",
    }),
    resolveTaskExecutionRouting({ task_execution: parsedTaskExecution }),
    fabricState.strategy,
    fabricState.default_host_id
  );
  return {
    model_router: modelRouterSelection,
    task_execution: {
      ...parsedTaskExecution,
      selected_worker_host_id: rankedSlots[0]?.host_id ?? null,
    },
  };
}

function normalizeRoutingRule(value: unknown) {
  if (!isRecord(value)) {
    return {
      preferred_agent_ids: [] as string[],
      allowed_agent_ids: [] as string[],
      preferred_client_kinds: [] as string[],
      allowed_client_kinds: [] as string[],
      required_capabilities: [] as string[],
      preferred_capabilities: [] as string[],
    };
  }
  return {
    preferred_agent_ids: readStringArray(value.preferred_agent_ids) ?? [],
    allowed_agent_ids: readStringArray(value.allowed_agent_ids) ?? [],
    preferred_client_kinds: readStringArray(value.preferred_client_kinds) ?? [],
    allowed_client_kinds: readStringArray(value.allowed_client_kinds) ?? [],
    required_capabilities: readStringArray(value.required_capabilities) ?? [],
    preferred_capabilities: readStringArray(value.preferred_capabilities) ?? [],
  };
}

function mergeAdaptiveDispatchRouting(
  explicitRouting: unknown,
  adaptiveRouting: ReturnType<typeof normalizeRoutingRule> | null
) {
  const explicit = normalizeRoutingRule(explicitRouting);
  if (!adaptiveRouting) {
    return explicit;
  }
  return {
    preferred_agent_ids: Array.from(new Set([...explicit.preferred_agent_ids, ...adaptiveRouting.preferred_agent_ids])),
    allowed_agent_ids:
      explicit.allowed_agent_ids.length > 0 ? explicit.allowed_agent_ids : adaptiveRouting.allowed_agent_ids,
    preferred_client_kinds: Array.from(
      new Set([...explicit.preferred_client_kinds, ...adaptiveRouting.preferred_client_kinds])
    ),
    allowed_client_kinds:
      explicit.allowed_client_kinds.length > 0 ? explicit.allowed_client_kinds : adaptiveRouting.allowed_client_kinds,
    required_capabilities: Array.from(
      new Set([...explicit.required_capabilities, ...adaptiveRouting.required_capabilities])
    ),
    preferred_capabilities: Array.from(
      new Set([...explicit.preferred_capabilities, ...adaptiveRouting.preferred_capabilities])
    ),
  };
}

type ExecutionPolicyProfile = "strict" | "bounded" | "aggressive";

function normalizeExecutionPolicyProfile(value: unknown): ExecutionPolicyProfile | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized === "strict" || normalized === "bounded" || normalized === "aggressive" ? normalized : null;
}

function goalUsesPatientZeroFullControlDefaults(goal: GoalRecord | null) {
  return Boolean(goal && isRecord(goal.metadata) && goal.metadata.patient_zero_control_eligible === true);
}

function resolvePlanDispatchPolicyProfile(
  goal: GoalRecord | null,
  plan: PlanRecord,
  step: PlanStepRecord
): ExecutionPolicyProfile {
  const stepProfile = normalizeExecutionPolicyProfile(step.metadata.policy_profile);
  if (stepProfile) {
    return stepProfile;
  }
  const inputProfile = isRecord(step.input) ? normalizeExecutionPolicyProfile(step.input.policy_profile) : null;
  if (inputProfile) {
    return inputProfile;
  }
  const planProfile = normalizeExecutionPolicyProfile(plan.metadata.policy_profile);
  if (planProfile) {
    return planProfile;
  }
  const goalProfile = goal ? normalizeExecutionPolicyProfile(goal.metadata.policy_profile) : null;
  if (goalProfile) {
    return goalProfile;
  }
  if (goalUsesPatientZeroFullControlDefaults(goal) && isPatientZeroExecutionOverrideEnabled(storage)) {
    return "aggressive";
  }
  if (goal?.autonomy_mode === "execute_bounded") {
    return "bounded";
  }
  return "strict";
}

function resolvePlanDispatchPolicyGate(
  goal: GoalRecord | null,
  plan: PlanRecord,
  step: PlanStepRecord
): {
  required: boolean;
  profile: ExecutionPolicyProfile;
  reason: string | null;
  risk: string | null;
} {
  const profile = resolvePlanDispatchPolicyProfile(goal, plan, step);
  const explicitExempt = readBoolean(step.metadata.policy_approval_exempt);
  if (explicitExempt === true) {
    return {
      required: false,
      profile,
      reason: "metadata_exempt",
      risk: readString(step.metadata.policy_risk) ?? null,
    };
  }
  const explicitRequired = readBoolean(step.metadata.policy_approval_required);
  const risk = readString(step.metadata.policy_risk) ?? (isRecord(step.input) ? readString(step.input.policy_risk) : undefined) ?? null;
  if (step.executor_kind === "human") {
    return {
      required: false,
      profile,
      reason: null,
      risk,
    };
  }
  if (explicitRequired === true) {
    return {
      required: true,
      profile,
      reason: "metadata_required",
      risk,
    };
  }
  if (profile === "aggressive") {
    return {
      required: false,
      profile,
      reason: null,
      risk,
    };
  }
  if (profile === "bounded") {
    const boundedRiskGate = risk === "destructive" || risk === "scope_commit";
    return {
      required: boundedRiskGate,
      profile,
      reason: boundedRiskGate ? `bounded:${risk}` : null,
      risk,
    };
  }
  const strictGate = step.step_kind === "mutation" || risk === "destructive" || risk === "scope_commit";
  return {
    required: strictGate,
    profile,
    reason: strictGate ? (risk ? `strict:${risk}` : "strict:mutation") : null,
    risk,
  };
}

function buildPlanDispatchThreadId(planId: string, stepId: string) {
  return `plan-dispatch-${hashDispatchValue(`${planId}|${stepId}`).slice(0, 24)}`;
}

function summarizeDispatchValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.parse(truncate(JSON.stringify(value), 1500));
  } catch {
    return truncate(String(value), 1500);
  }
}

function extractTaskId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const direct = readString(value.task_id);
  if (direct) {
    return direct;
  }
  if (isRecord(value.task)) {
    return readString(value.task.task_id) ?? null;
  }
  return null;
}

function extractRunId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const direct = readString(value.run_id);
  if (direct) {
    return direct;
  }
  if (isRecord(value.run)) {
    return readString(value.run.run_id) ?? null;
  }
  return null;
}

function getPlanExecutionSnapshot(planId: string) {
  const plan = storage.getPlanById(planId);
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }
  const steps = storage.listPlanSteps(planId);
  const readiness = evaluatePlanStepReadiness(steps);
  return {
    plan,
    steps,
    readiness,
  };
}

function isPlanTerminalStatus(status: string) {
  return status === "completed" || status === "invalidated" || status === "archived";
}

function appendPlanStepRuntimeEvent(params: {
  event_type: string;
  plan_id: string;
  goal_id: string | null;
  step_id: string;
  title?: string;
  executor_kind?: string | null;
  status?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  source_client?: string;
  source_model?: string;
  source_agent?: string;
  created_at?: string;
}) {
  return storage.appendRuntimeEvent({
    event_type: params.event_type,
    entity_type: "step",
    entity_id: params.step_id,
    status: params.status ?? null,
    summary: params.summary,
    details: {
      plan_id: params.plan_id,
      goal_id: params.goal_id ?? null,
      step_id: params.step_id,
      title: params.title ?? null,
      executor_kind: params.executor_kind ?? null,
      ...(params.details ?? {}),
    },
    source_client: params.source_client,
    source_model: params.source_model,
    source_agent: params.source_agent,
    created_at: params.created_at,
  });
}

async function planDispatch(input: z.infer<typeof planDispatchSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.dispatch",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const plan = storage.getPlanById(input.plan_id);
      if (!plan) {
        throw new Error(`Plan not found: ${input.plan_id}`);
      }
      const goal = plan.goal_id ? storage.getGoalById(plan.goal_id) : null;

      const steps = storage.listPlanSteps(input.plan_id);
      const readiness = evaluatePlanStepReadiness(steps);
      const stepById = new Map(steps.map((step) => [step.step_id, step]));
      const readinessById = new Map(readiness.map((entry) => [entry.step_id, entry]));
      const limit = input.limit ?? 25;

      const rawCandidateSteps = input.step_id
        ? [stepById.get(input.step_id)]
        : readiness
            .filter((entry) => entry.ready)
            .sort((left, right) => left.seq - right.seq)
            .slice(0, limit)
            .map((entry) => stepById.get(entry.step_id));

      const missingStep = input.step_id && !rawCandidateSteps[0];
      if (missingStep) {
        throw new Error(`Plan step not found: ${input.step_id}`);
      }

      const candidateSteps = rawCandidateSteps.filter(
        (step): step is NonNullable<(typeof rawCandidateSteps)[number]> => Boolean(step)
      );
      if (candidateSteps.length === 0) {
        return {
          ok: true,
          plan_id: input.plan_id,
          dry_run: input.dry_run ?? false,
          considered_count: 0,
          dispatched_count: 0,
          completed_count: 0,
          running_count: 0,
          blocked_count: 0,
          failed_count: 0,
          results: [],
          message: input.step_id ? "No matching step was dispatchable." : "No ready plan steps found.",
        };
      }

      const results: Array<Record<string, unknown>> = [];
      let dispatchedCount = 0;
      let completedCount = 0;
      let runningCount = 0;
      let blockedCount = 0;
      let failedCount = 0;

      for (const step of candidateSteps) {
        const readinessEntry = readinessById.get(step.step_id);
        const executorKind = step.executor_kind;
        const nowIso = new Date().toISOString();
        const baseResult: Record<string, unknown> = {
          step_id: step.step_id,
          seq: step.seq,
          title: step.title,
          executor_kind: executorKind,
          step_status_before: step.status,
          ready: readinessEntry?.ready ?? false,
          blocked_by: readinessEntry?.blocked_by ?? [],
          gate_reason: readinessEntry?.gate_reason ?? null,
        };

        if (input.step_id && !(readinessEntry?.ready ?? false) && !input.allow_non_ready) {
          results.push({
            ...baseResult,
            dispatched: false,
            action: "skipped_not_ready",
            step_status_after: step.status,
            reason: readinessEntry?.gate_reason ?? "step is not ready for dispatch",
          });
          continue;
        }

        if (!executorKind) {
          results.push({
            ...baseResult,
            dispatched: false,
            action: "configuration_required",
            step_status_after: step.status,
            reason: "executor_kind is required to dispatch a plan step",
          });
          continue;
        }

        const policyGate = resolvePlanDispatchPolicyGate(goal, plan, step);

        if (input.dry_run) {
          results.push({
            ...baseResult,
            dispatched: false,
            dry_run: true,
            action: "dry_run",
            gate_type: policyGate.required ? "policy" : null,
            policy_profile: policyGate.required ? policyGate.profile : null,
            policy_reason: policyGate.required ? policyGate.reason : null,
            step_status_after: step.status,
          });
          continue;
        }

        try {
          if (policyGate.required) {
            const approvalSummary =
              readString(step.input?.approval_summary) ??
              `Policy approval required before dispatching step ${step.title}`;
            const updated = storage.updatePlanStep({
              plan_id: plan.plan_id,
              step_id: step.step_id,
              status: "blocked",
              metadata: {
                human_approval_required: true,
                dispatch_gate_type: "policy",
                policy_profile: policyGate.profile,
                policy_gate_reason: policyGate.reason,
                policy_risk: policyGate.risk,
                last_dispatch: {
                  kind: executorKind,
                  dispatched_at: nowIso,
                  approval_summary: approvalSummary,
                  policy_profile: policyGate.profile,
                  policy_gate_reason: policyGate.reason,
                  policy_risk: policyGate.risk,
                },
              },
            });
            const blockedEvent = appendPlanStepRuntimeEvent({
              event_type: "plan.step_blocked",
              plan_id: plan.plan_id,
              goal_id: plan.goal_id,
              step_id: step.step_id,
              title: step.title,
              executor_kind: executorKind,
              status: updated.step.status,
              summary: approvalSummary,
              details: {
                gate_type: "policy",
                requires_human_approval: true,
                policy_profile: policyGate.profile,
                policy_gate_reason: policyGate.reason,
                policy_risk: policyGate.risk,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            });
            blockedCount += 1;
            results.push({
              ...baseResult,
              dispatched: false,
              action: "approval_required",
              gate_type: "policy",
              requires_human_approval: true,
              policy_profile: policyGate.profile,
              policy_reason: policyGate.reason,
              policy_risk: policyGate.risk,
              step_status_after: updated.step.status,
              approval_gate: {
                kind: "policy",
                summary: approvalSummary,
              },
              event: blockedEvent,
            });
            continue;
          }

          if (executorKind === "tool") {
            const toolName = readString(step.tool_name) ?? readString(step.executor_ref);
            if (!toolName) {
              results.push({
                ...baseResult,
                dispatched: false,
                action: "configuration_required",
                step_status_after: step.status,
                reason: "tool executor requires tool_name or executor_ref",
              });
              continue;
            }
            if (toolName === "plan.dispatch") {
              results.push({
                ...baseResult,
                dispatched: false,
                action: "configuration_required",
                step_status_after: step.status,
                reason: "plan.dispatch cannot recursively dispatch itself",
              });
              continue;
            }
            const toolInput = isRecord(step.input) ? { ...step.input } : {};
            if (!("mutation" in toolInput)) {
              toolInput.mutation = buildPlanDispatchDerivedMutation(input.mutation, "tool", step.step_id);
            }
            const toolResult = await invokeRegisteredTool(toolName, toolInput);
            const taskId = extractTaskId(toolResult);
            const runId = extractRunId(toolResult);
            const updated = storage.updatePlanStep({
              plan_id: plan.plan_id,
              step_id: step.step_id,
              status: "completed",
              task_id: taskId ?? undefined,
              run_id: runId ?? undefined,
              metadata: {
                human_approval_required: false,
                dispatch_gate_type: null,
                last_dispatch: {
                  kind: "tool",
                  dispatched_at: nowIso,
                  tool_name: toolName,
                  result_preview: summarizeDispatchValue(toolResult),
                },
              },
            });
            const dispatchEvent = appendPlanStepRuntimeEvent({
              event_type: "plan.step_dispatched",
              plan_id: plan.plan_id,
              goal_id: plan.goal_id,
              step_id: step.step_id,
              title: step.title,
              executor_kind: executorKind,
              status: updated.step.status,
              summary: `Tool step ${step.step_id} dispatched via ${toolName}.`,
              details: {
                dispatch_kind: "tool",
                action: "tool_invoked",
                tool_name: toolName,
                task_id: taskId,
                run_id: runId,
                result_preview: summarizeDispatchValue(toolResult),
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            });
            dispatchedCount += 1;
            completedCount += 1;
            results.push({
              ...baseResult,
              dispatched: true,
              action: "tool_invoked",
              tool_name: toolName,
              task_id: taskId,
              run_id: runId,
              step_status_after: updated.step.status,
              tool_result: toolResult,
              event: dispatchEvent,
            });
            continue;
          }

          if (executorKind === "task" || executorKind === "worker") {
            const rawInput = isRecord(step.input) ? step.input : {};
            const payload = isRecord(rawInput.payload) ? rawInput.payload : {};
            const rawMetadata = mergePlanDispatchMetadata(step.metadata, rawInput.metadata);
            const delegationBrief = synthesizePlanDispatchDelegationBrief(step, rawInput, payload, rawMetadata);
            const inheritedPermissionProfile =
              readString(rawInput.permission_profile) ??
              readString(rawMetadata.permission_profile) ??
              readString(step.metadata.permission_profile) ??
              readString(plan.metadata.permission_profile) ??
              readString(goal?.metadata.permission_profile) ??
              undefined;
            const inheritedBudget =
              isRecord(rawInput.budget)
                ? rawInput.budget
                : isRecord(rawMetadata.budget)
                  ? rawMetadata.budget
                  : Object.keys(plan.budget ?? {}).length > 0
                    ? plan.budget
                    : goal?.budget;
            const taskExecutionPlan = planDispatchTaskExecution(storage, {
              objective: readString(rawInput.objective) ?? step.title,
              project_dir: readString(rawInput.project_dir) ?? ".",
              metadata: rawMetadata,
              tags: readStringArray(rawInput.tags) ?? ["plan.dispatch", executorKind],
            });
            const explicitRouting =
              isRecord(rawInput.routing)
                ? rawInput.routing
                : isRecord(rawMetadata.task_routing)
                  ? rawMetadata.task_routing
                  : isRecord(rawMetadata.routing)
                    ? rawMetadata.routing
                    : undefined;
            const adaptiveAssignment = recommendAdaptiveDispatchRouting(storage, {
              objective: readString(rawInput.objective) ?? step.title,
              project_dir: readString(rawInput.project_dir) ?? ".",
              payload,
              tags: readStringArray(rawInput.tags) ?? ["plan.dispatch", executorKind],
              metadata: rawMetadata,
            });
            const routing = mergeAdaptiveDispatchRouting(
              explicitRouting,
              adaptiveAssignment.routing ? normalizeRoutingRule(adaptiveAssignment.routing) : null
            );
            const taskResult = await invokeRegisteredTool("task.create", {
              mutation: buildPlanDispatchDerivedMutation(input.mutation, executorKind, step.step_id),
              task_id: readString(rawInput.task_id),
              objective: readString(rawInput.objective) ?? step.title,
              project_dir: readString(rawInput.project_dir),
              payload: {
                ...payload,
                ...(delegationBrief
                  ? {
                      delegation_brief: delegationBrief,
                    }
                  : {}),
                plan_id: plan.plan_id,
                step_id: step.step_id,
                goal_id: plan.goal_id,
              },
              routing,
              task_execution: taskExecutionPlan.task_execution,
              budget: inheritedBudget,
              permission_profile: inheritedPermissionProfile,
              priority: readInteger(rawInput.priority),
              max_attempts: readInteger(rawInput.max_attempts),
              available_at: readString(rawInput.available_at),
              source: readString(rawInput.source) ?? "plan.dispatch",
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
              tags: readStringArray(rawInput.tags) ?? ["plan.dispatch", executorKind],
              metadata: mergeDeclaredPermissionProfile({
                ...rawMetadata,
                ...(delegationBrief
                  ? {
                      delegation_brief: delegationBrief,
                    }
                  : {}),
                adaptive_assignment: adaptiveAssignment,
                task_execution: taskExecutionPlan.task_execution,
                model_router: taskExecutionPlan.model_router,
                plan_dispatch: {
                  plan_id: plan.plan_id,
                  step_id: step.step_id,
                  goal_id: plan.goal_id,
                  executor_kind: executorKind,
                },
              }, inheritedPermissionProfile),
            });
            const taskId = extractTaskId(taskResult);
            const updated = storage.updatePlanStep({
              plan_id: plan.plan_id,
              step_id: step.step_id,
              status: "running",
              task_id: taskId ?? undefined,
              executor_ref: taskId ?? step.executor_ref ?? undefined,
              metadata: {
                human_approval_required: false,
                dispatch_gate_type: null,
                last_dispatch: {
                  kind: executorKind,
                  dispatched_at: nowIso,
                  task_id: taskId,
                  objective: readString(rawInput.objective) ?? step.title,
                  adaptive_assignment: adaptiveAssignment,
                  task_execution: taskExecutionPlan.task_execution,
                },
              },
            });
            const dispatchEvent = appendPlanStepRuntimeEvent({
              event_type: "plan.step_dispatched",
              plan_id: plan.plan_id,
              goal_id: plan.goal_id,
              step_id: step.step_id,
              title: step.title,
              executor_kind: executorKind,
              status: updated.step.status,
              summary: `${executorKind} step ${step.step_id} dispatched into the task queue.`,
              details: {
                dispatch_kind: executorKind,
                action: "task_created",
                task_id: taskId,
                objective: readString(rawInput.objective) ?? step.title,
                adaptive_assignment: adaptiveAssignment,
                task_execution: taskExecutionPlan.task_execution,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            });
            dispatchedCount += 1;
            runningCount += 1;
            results.push({
              ...baseResult,
              dispatched: true,
              action: "task_created",
              task_id: taskId,
              adaptive_assignment: adaptiveAssignment,
              task_execution: taskExecutionPlan.task_execution,
              step_status_after: updated.step.status,
              task: taskResult,
              event: dispatchEvent,
            });
            continue;
          }

          if (executorKind === "trichat") {
            const rawInput = isRecord(step.input) ? step.input : {};
            const userPrompt =
              readString(rawInput.user_prompt) ??
              readString(rawInput.prompt) ??
              readString(rawInput.content) ??
              step.title;
            const threadId = readString(rawInput.thread_id) ?? buildPlanDispatchThreadId(plan.plan_id, step.step_id);
            const threadTitle = readString(rawInput.thread_title) ?? `${plan.title}: ${step.title}`;
            const expectedAgents = resolveEffectiveTriChatAgentIds(
              storage,
              [goal?.objective, userPrompt].filter(Boolean).join("\n\n"),
              readStringArray(rawInput.expected_agents)
            );
            const minAgents = readInteger(rawInput.min_agents);

            const threadResult = await invokeRegisteredTool("trichat.thread_open", {
              mutation: buildPlanDispatchDerivedMutation(input.mutation, "trichat-thread", step.step_id),
              thread_id: threadId,
              title: threadTitle,
              status: "active",
              metadata: {
                ...(isRecord(rawInput.thread_metadata) ? rawInput.thread_metadata : {}),
                plan_id: plan.plan_id,
                step_id: step.step_id,
                goal_id: plan.goal_id,
              },
            });
            const messageResult = await invokeRegisteredTool("trichat.message_post", {
              mutation: buildPlanDispatchDerivedMutation(input.mutation, "trichat-message", step.step_id),
              thread_id: threadId,
              agent_id: "plan-dispatch",
              role: "user",
              content: userPrompt,
              metadata: {
                kind: "plan.dispatch",
                plan_id: plan.plan_id,
                step_id: step.step_id,
                goal_id: plan.goal_id,
              },
            });
            const userMessageId =
              isRecord(messageResult) && isRecord(messageResult.message)
                ? readString(messageResult.message.message_id)
                : undefined;
            if (!userMessageId) {
              throw new Error(`TriChat dispatch did not return a user message id for step ${step.step_id}`);
            }
            const startedTurn = await invokeRegisteredTool("trichat.turn_start", {
              mutation: buildPlanDispatchDerivedMutation(input.mutation, "trichat-turn-start", step.step_id),
              thread_id: threadId,
              user_message_id: userMessageId,
              user_prompt: userPrompt,
              expected_agents: expectedAgents,
              min_agents: minAgents,
              metadata: {
                plan_id: plan.plan_id,
                step_id: step.step_id,
                goal_id: plan.goal_id,
              },
            });
            const turnId =
              isRecord(startedTurn) && isRecord(startedTurn.turn) ? readString(startedTurn.turn.turn_id) : undefined;
            if (!turnId) {
              throw new Error(`TriChat dispatch did not return a turn id for step ${step.step_id}`);
            }
            const advancedTurn = await invokeRegisteredTool("trichat.turn_advance", {
              mutation: buildPlanDispatchDerivedMutation(input.mutation, "trichat-turn-advance", step.step_id),
              turn_id: turnId,
              status: "running",
              phase: "propose",
              phase_status: "running",
              metadata: {
                dispatched_from_plan_id: plan.plan_id,
                dispatched_from_step_id: step.step_id,
              },
            });
            const updated = storage.updatePlanStep({
              plan_id: plan.plan_id,
              step_id: step.step_id,
              status: "running",
              executor_ref: turnId,
              metadata: {
                human_approval_required: false,
                dispatch_gate_type: null,
                thread_id: threadId,
                user_message_id: userMessageId,
                turn_id: turnId,
                expected_agents: expectedAgents ?? null,
                min_agents: minAgents ?? null,
                last_dispatch: {
                  kind: "trichat",
                  dispatched_at: nowIso,
                  thread_id: threadId,
                  user_message_id: userMessageId,
                  turn_id: turnId,
                },
              },
            });
            const dispatchEvent = appendPlanStepRuntimeEvent({
              event_type: "plan.step_dispatched",
              plan_id: plan.plan_id,
              goal_id: plan.goal_id,
              step_id: step.step_id,
              title: step.title,
              executor_kind: executorKind,
              status: updated.step.status,
              summary: `TriChat step ${step.step_id} dispatched into thread ${threadId}.`,
              details: {
                dispatch_kind: "trichat",
                action: "trichat_turn_started",
                thread_id: threadId,
                user_message_id: userMessageId,
                turn_id: turnId,
                expected_agents: expectedAgents ?? [],
                min_agents: minAgents ?? null,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            });
            dispatchedCount += 1;
            runningCount += 1;
            results.push({
              ...baseResult,
              dispatched: true,
              action: "trichat_turn_started",
              thread_id: threadId,
              user_message_id: userMessageId,
              turn_id: turnId,
              step_status_after: updated.step.status,
              thread: threadResult,
              message: messageResult,
              turn: advancedTurn,
              event: dispatchEvent,
            });
            continue;
          }

          const updated = storage.updatePlanStep({
            plan_id: plan.plan_id,
            step_id: step.step_id,
            status: "blocked",
            metadata: {
              human_approval_required: true,
              dispatch_gate_type: "human",
              last_dispatch: {
                kind: "human",
                dispatched_at: nowIso,
                approval_summary: readString(step.input?.approval_summary) ?? `Human approval required for step ${step.title}`,
              },
            },
          });
          const blockedEvent = appendPlanStepRuntimeEvent({
            event_type: "plan.step_blocked",
            plan_id: plan.plan_id,
            goal_id: plan.goal_id,
            step_id: step.step_id,
            title: step.title,
            executor_kind: executorKind,
            status: updated.step.status,
            summary: readString(step.input?.approval_summary) ?? `Human approval required for step ${step.title}.`,
            details: {
              gate_type: "human",
              requires_human_approval: true,
            },
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
          blockedCount += 1;
          results.push({
            ...baseResult,
            dispatched: false,
            action: "approval_required",
            gate_type: "human",
            requires_human_approval: true,
            step_status_after: updated.step.status,
            approval_gate: {
              kind: "human",
              summary: readString(step.input?.approval_summary) ?? `Human approval required for step ${step.title}`,
            },
            event: blockedEvent,
          });
        } catch (error) {
          const message = truncate(error instanceof Error ? error.message : String(error));
          let stepStatusAfter = "failed";
          let failedEvent: Record<string, unknown> | null = null;
          try {
            const updated = storage.updatePlanStep({
              plan_id: plan.plan_id,
              step_id: step.step_id,
              status: "failed",
              metadata: {
                last_dispatch: {
                  kind: executorKind,
                  dispatched_at: nowIso,
                  error: message,
                },
              },
            });
            stepStatusAfter = updated.step.status;
            failedEvent = appendPlanStepRuntimeEvent({
              event_type: "plan.step_dispatch_failed",
              plan_id: plan.plan_id,
              goal_id: plan.goal_id,
              step_id: step.step_id,
              title: step.title,
              executor_kind: executorKind,
              status: updated.step.status,
              summary: `Dispatch failed for step ${step.step_id}.`,
              details: {
                error: message,
              },
              source_client: input.source_client,
              source_model: input.source_model,
              source_agent: input.source_agent,
            });
          } catch {
            stepStatusAfter = "failed";
          }
          failedCount += 1;
          results.push({
            ...baseResult,
            dispatched: false,
            action: "dispatch_failed",
            step_status_after: stepStatusAfter,
            error: message,
            event: failedEvent,
          });
        }
      }

      return {
        ok: true,
        plan_id: input.plan_id,
        dry_run: input.dry_run ?? false,
        considered_count: candidateSteps.length,
        dispatched_count: dispatchedCount,
        completed_count: completedCount,
        running_count: runningCount,
        blocked_count: blockedCount,
        failed_count: failedCount,
        results,
      };
    },
  });
}

async function planResume(input: z.infer<typeof planResumeSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.resume",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const snapshot = getPlanExecutionSnapshot(input.plan_id);
      let reset = null as null | {
        plan: ReturnType<typeof storage.updatePlanStep>["plan"];
        step: ReturnType<typeof storage.updatePlanStep>["step"];
      };

      if (input.step_id) {
        const step = snapshot.steps.find((candidate) => candidate.step_id === input.step_id);
        if (!step) {
          throw new Error(`Plan step not found: ${input.step_id}`);
        }
        if (input.reset_step) {
          const resettableStatuses = new Set(["blocked", "failed", "skipped", "invalidated"]);
          if (!resettableStatuses.has(step.status)) {
            throw new Error(`Plan step ${input.step_id} cannot be reset from status ${step.status}`);
          }
          reset = storage.updatePlanStep({
            plan_id: input.plan_id,
            step_id: input.step_id,
            status: "pending",
            summary: input.summary?.trim() || `Resumed step ${step.title}`,
            metadata: {
              human_approval_required: false,
              dispatch_gate_type: null,
              last_resume: {
                resumed_at: new Date().toISOString(),
                resumed_by: input.source_agent ?? input.source_client ?? "plan.resume",
                summary: input.summary?.trim() || null,
              },
            },
          });
        }
      }

      if (input.dispatch_after === false) {
        const updatedSnapshot = getPlanExecutionSnapshot(input.plan_id);
        const event = storage.appendRuntimeEvent({
          event_type: "plan.resumed",
          entity_type: "plan",
          entity_id: input.plan_id,
          status: updatedSnapshot.plan.status,
          summary: input.summary?.trim() || `Plan ${input.plan_id} resumed without dispatch.`,
          details: {
            step_id: input.step_id ?? null,
            reset_step_id: reset?.step.step_id ?? null,
            dispatch_after: false,
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        });
        return {
          ok: true,
          resumed: true,
          plan_id: input.plan_id,
          reset_step_id: reset?.step.step_id ?? null,
          dispatch: null,
          plan: updatedSnapshot.plan,
          steps: updatedSnapshot.steps,
          readiness: updatedSnapshot.readiness,
          event,
        };
      }

      const dispatchResult = await invokeRegisteredTool("dispatch.autorun", {
        mutation: buildPlanDispatchDerivedMutation(input.mutation, "resume", input.step_id ?? input.plan_id),
        plan_id: input.plan_id,
        limit: input.limit,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      const updatedSnapshot = getPlanExecutionSnapshot(input.plan_id);
      const event = storage.appendRuntimeEvent({
        event_type: "plan.resumed",
        entity_type: "plan",
        entity_id: input.plan_id,
        status: updatedSnapshot.plan.status,
        summary: input.summary?.trim() || `Plan ${input.plan_id} resumed and re-dispatched.`,
        details: {
          step_id: input.step_id ?? null,
          reset_step_id: reset?.step.step_id ?? null,
          dispatch_after: true,
          dispatch_preview: summarizeDispatchValue(dispatchResult),
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        resumed: true,
        plan_id: input.plan_id,
        reset_step_id: reset?.step.step_id ?? null,
        dispatch: dispatchResult,
        plan: updatedSnapshot.plan,
        steps: updatedSnapshot.steps,
        readiness: updatedSnapshot.readiness,
        event,
      };
    },
  });
}

async function dispatchAutorun(input: z.infer<typeof dispatchAutorunSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "dispatch.autorun",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const maxPasses = input.max_passes ?? 4;
      const passResults: Array<Record<string, unknown>> = [];
      const backendRuns: Array<Record<string, unknown>> = [];
      const processedTriChatTurns = new Set<string>();
      let stopReason = "max_passes_reached";

      for (let pass = 1; pass <= maxPasses; pass += 1) {
        const dispatchResult = (await invokeRegisteredTool("plan.dispatch", {
          mutation: buildPlanDispatchDerivedMutation(input.mutation, "autorun", `${input.plan_id}:${pass}`),
          plan_id: input.plan_id,
          limit: input.limit,
          dry_run: input.dry_run,
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        })) as Record<string, unknown>;

        const passBackendRuns: Array<Record<string, unknown>> = [];
        let backendCompleted = 0;
        let backendFailed = 0;

        if (!(input.dry_run ?? false)) {
          const snapshot = getPlanExecutionSnapshot(input.plan_id);
          const goal = snapshot.plan.goal_id ? storage.getGoalById(snapshot.plan.goal_id) : null;
          const trichatSteps = snapshot.steps.filter((step) => {
            if (step.executor_kind !== "trichat" || step.status !== "running") {
              return false;
            }
            const turnId = readString(step.metadata.turn_id) ?? readString(step.executor_ref);
            if (!turnId || processedTriChatTurns.has(turnId)) {
              return false;
            }
            return true;
          });

          for (const step of trichatSteps) {
            const turnId = readString(step.metadata.turn_id) ?? readString(step.executor_ref);
            if (!turnId) {
              continue;
            }
            processedTriChatTurns.add(turnId);
            try {
              const stepPrompt =
                readString(step.input.user_prompt) ??
                readString(step.input.prompt) ??
                readString(step.input.content) ??
                step.title;
              const effectiveExpectedAgents = resolveEffectiveTriChatAgentIds(
                storage,
                [goal?.objective, stepPrompt].filter(Boolean).join("\n\n"),
                [...(readStringArray(step.input.expected_agents) ?? []), ...(input.trichat_agent_ids ?? [])]
              );
              const autorunResult = await trichatTurnAutorun(storage, {
                turn_id: turnId,
                session_key: `dispatch-autorun:${input.plan_id}:${step.step_id}:${pass}`,
                expected_agents: effectiveExpectedAgents,
                max_rounds: input.trichat_max_rounds,
                min_success_agents: input.trichat_min_success_agents,
                bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
                bridge_dry_run: input.trichat_bridge_dry_run,
                objective: stepPrompt,
                project_dir:
                  readString(step.input.project_dir) ??
                  readString(step.metadata.project_dir) ??
                  process.cwd(),
                verify_summary: `dispatch.autorun completed TriChat backend for step ${step.step_id}`,
              });
              const turnStatus = readString(autorunResult.turn?.status) ?? null;
              const turnFailed = turnStatus === "failed";
              const updated = storage.updatePlanStep({
                plan_id: input.plan_id,
                step_id: step.step_id,
                status: turnFailed ? "failed" : "completed",
                executor_ref: turnId,
                metadata: {
                  last_backend_run: {
                    backend: "trichat",
                    autorun_at: new Date().toISOString(),
                    pass,
                    replayed: Boolean(autorunResult.replayed),
                    turn_id: turnId,
                    turn_status: turnStatus,
                    selected_agent: readString(autorunResult.turn?.selected_agent) ?? null,
                    selected_strategy: readString(autorunResult.turn?.selected_strategy) ?? null,
                    verify_status: readString(autorunResult.turn?.verify_status) ?? null,
                    verify_summary: readString(autorunResult.turn?.verify_summary) ?? null,
                    council_confidence: isRecord(autorunResult.council)
                      ? autorunResult.council.council_confidence ?? null
                      : null,
                    success_agents: isRecord(autorunResult.council)
                      ? Array.isArray(autorunResult.council.success_agents)
                        ? autorunResult.council.success_agents
                        : []
                      : [],
                  },
                },
              });
              const backendEvent = appendPlanStepRuntimeEvent({
                event_type: turnFailed ? "plan.step_backend_failed" : "plan.step_backend_completed",
                plan_id: input.plan_id,
                goal_id: snapshot.plan.goal_id,
                step_id: step.step_id,
                title: step.title,
                executor_kind: step.executor_kind,
                status: updated.step.status,
                summary: turnFailed
                  ? `TriChat backend failed for step ${step.step_id}.`
                  : `TriChat backend completed for step ${step.step_id}.`,
                details: {
                  backend: "trichat",
                  pass,
                  turn_id: turnId,
                  turn_status: turnStatus,
                  selected_agent: readString(autorunResult.turn?.selected_agent) ?? null,
                  selected_strategy: readString(autorunResult.turn?.selected_strategy) ?? null,
                  verify_status: readString(autorunResult.turn?.verify_status) ?? null,
                  verify_summary: readString(autorunResult.turn?.verify_summary) ?? null,
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });
              if (turnFailed) {
                backendFailed += 1;
              } else {
                backendCompleted += 1;
              }
              const backendRun = {
                backend: "trichat",
                step_id: step.step_id,
                turn_id: turnId,
                ok: !turnFailed,
                turn_status: turnStatus,
                step_status_after: updated.step.status,
                result: autorunResult,
                event: backendEvent,
              };
              backendRuns.push(backendRun);
              passBackendRuns.push(backendRun);
            } catch (error) {
              const message = truncate(error instanceof Error ? error.message : String(error));
              const updated = storage.updatePlanStep({
                plan_id: input.plan_id,
                step_id: step.step_id,
                status: "failed",
                metadata: {
                  last_backend_run: {
                    backend: "trichat",
                    autorun_at: new Date().toISOString(),
                    pass,
                    turn_id: turnId,
                    error: message,
                  },
                },
              });
              const backendEvent = appendPlanStepRuntimeEvent({
                event_type: "plan.step_backend_failed",
                plan_id: input.plan_id,
                goal_id: snapshot.plan.goal_id,
                step_id: step.step_id,
                title: step.title,
                executor_kind: step.executor_kind,
                status: updated.step.status,
                summary: `TriChat backend failed for step ${step.step_id}.`,
                details: {
                  backend: "trichat",
                  pass,
                  turn_id: turnId,
                  error: message,
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });
              backendFailed += 1;
              const backendRun = {
                backend: "trichat",
                step_id: step.step_id,
                turn_id: turnId,
                ok: false,
                error: message,
                event: backendEvent,
              };
              backendRuns.push(backendRun);
              passBackendRuns.push(backendRun);
            }
          }
        }

        passResults.push({
          pass,
          dispatch: dispatchResult,
          backend_runs: passBackendRuns,
        });

        if (input.dry_run ?? false) {
          stopReason = "dry_run";
          break;
        }
        if (Number(dispatchResult.failed_count ?? 0) > 0 || backendFailed > 0) {
          stopReason = "failure";
          break;
        }

        const snapshot = getPlanExecutionSnapshot(input.plan_id);
        if (isPlanTerminalStatus(snapshot.plan.status)) {
          stopReason = "plan_terminal";
          break;
        }

        if (Number(dispatchResult.dispatched_count ?? 0) === 0 && backendCompleted === 0) {
          stopReason = "idle";
          break;
        }
      }

      const finalSnapshot = getPlanExecutionSnapshot(input.plan_id);
      return {
        ok: true,
        plan_id: input.plan_id,
        dry_run: input.dry_run ?? false,
        pass_count: passResults.length,
        stop_reason: stopReason,
        pass_results: passResults,
        backend_runs: backendRuns,
        final_plan: finalSnapshot.plan,
        final_steps: finalSnapshot.steps,
        final_readiness: finalSnapshot.readiness,
      };
    },
  });
}

registerTool("memory.append", "Append distilled long-term memory content.", memoryAppendSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "memory.append",
    mutation: input.mutation,
    payload: input,
    execute: () => appendMemory(storage, input),
  })
);

registerTool(
  "memory.reflection_capture",
  "Capture externally grounded episodic reflection memory from tool or environment feedback.",
  memoryReflectionCaptureSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "memory.reflection_capture",
      mutation: input.mutation,
      payload: input,
      execute: () => captureReflectionMemory(storage, input),
    })
);

registerTool("memory.search", "Search long-term memory using lexical matching.", memorySearchSchema, (input) =>
  searchMemory(storage, input)
);

registerTool("memory.get", "Fetch a memory by id for deterministic debugging.", memoryGetSchema, (input) =>
  getMemory(storage, input)
);

registerTool("memory.recent", "List recent long-term memories in compact chronological order.", memoryRecentSchema, (input) =>
  recentMemory(storage, input)
);

registerTool("agent.session_open", "Open or refresh a durable agent session record.", agentSessionOpenSchema, (input) =>
  openAgentSession(storage, input)
);

registerTool("agent.session_get", "Fetch a durable agent session by id.", agentSessionGetSchema, (input) =>
  getAgentSession(storage, input)
);

registerTool("agent.session_list", "List durable agent sessions by status, agent, or client filters.", agentSessionListSchema, (input) =>
  listAgentSessions(storage, input)
);

registerTool("agent.session_heartbeat", "Renew a durable agent session lease and update live capabilities.", agentSessionHeartbeatSchema, (input) =>
  heartbeatAgentSession(storage, input)
);

registerTool("agent.session_close", "Close a durable agent session and release its lease.", agentSessionCloseSchema, (input) =>
  closeAgentSession(storage, input)
);

registerTool("agent.learning_list", "List bounded learning entries captured for agents.", agentLearningListSchema, (input) =>
  listAgentLearning(storage, input)
);

registerTool("agent.learning_summary", "Summarize bounded learning coverage and recent lessons across agents.", agentLearningSummarySchema, (input) =>
  summarizeAgentLearning(storage, input)
);

registerTool("agent.claim_next", "Claim the next runnable task through a durable agent session lease.", agentClaimNextSchema, (input) =>
  agentClaimNext(storage, input)
);

registerTool("agent.worklist", "Preview the best currently claimable tasks for a durable agent session.", agentWorklistSchema, (input) =>
  agentWorklist(storage, input)
);

registerTool("agent.current_task", "Fetch the currently claimed running task for a durable agent session.", agentCurrentTaskSchema, (input) =>
  agentCurrentTask(storage, input)
);

registerTool("agent.heartbeat_task", "Renew the currently claimed task lease through a durable agent session.", agentHeartbeatTaskSchema, (input) =>
  agentHeartbeatTask(storage, input)
);

registerTool("agent.report_result", "Report task completion or failure through a durable agent session and sync plan context.", agentReportResultSchema, (input) =>
  agentReportResult(storage, invokeRegisteredTool, input)
);

registerTool("goal.create", "Create a durable goal with acceptance criteria and autonomy settings.", goalCreateSchema, (input) =>
  goalCreate(storage, input)
);

registerTool("goal.get", "Fetch a durable goal by id.", goalGetSchema, (input) =>
  goalGet(storage, input)
);

registerTool("goal.list", "List durable goals by status or target filters.", goalListSchema, (input) =>
  goalList(storage, input)
);

registerTool("goal.autorun", "Scan eligible goals and re-enter goal.execute where unattended progress is possible.", goalAutorunSchema, (input) =>
  goalAutorun(storage, invokeRegisteredTool, input)
);

registerTool("goal.hygiene", "Archive stale idle ephemeral goals so background autonomy stays focused on live operator work.", goalHygieneSchema, (input) =>
  goalHygiene(storage, invokeRegisteredTool, input)
);

registerTool(
  "goal.autorun_daemon",
  "Manage the bounded periodic goal.autorun daemon for unattended continuation.",
  goalAutorunDaemonSchema,
  (input) => goalAutorunDaemonControl(storage, invokeRegisteredTool, input)
);

registerTool("goal.plan_generate", "Generate and persist a durable plan for a goal through a registered pack planner hook.", goalPlanGenerateSchema, (input) =>
  goalPlanGenerate(storage, packHookRegistry, input)
);

registerTool("goal.execute", "Resolve or generate a durable plan for a goal, then dispatch it through the kernel.", goalExecuteSchema, (input) =>
  goalExecute(storage, invokeRegisteredTool, input)
);

registerTool("pack.hooks.list", "List registered pack planner and verifier hooks by pack or target type.", packHooksListSchema, (input) =>
  listPackHooks(packHookRegistry, input)
);

registerTool("pack.plan.generate", "Generate and persist a durable plan through a registered pack planner hook.", packPlanGenerateSchema, (input) =>
  packPlanGenerate(storage, packHookRegistry, input)
);

registerTool("pack.verify.run", "Run a registered pack verifier hook, persist the hook run, and record evidence artifacts.", packVerifyRunSchema, (input) =>
  packVerifyRun(storage, packHookRegistry, input)
);

registerTool("event.publish", "Persist a generic runtime event into the shared kernel event feed.", eventPublishSchema, (input) =>
  eventPublish(storage, input)
);

registerTool("event.tail", "Tail the shared kernel event feed with type, entity, and source filters.", eventTailSchema, (input) =>
  eventTail(storage, input)
);

registerTool("event.summary", "Summarize the shared kernel event feed by type and entity.", eventSummarySchema, (input) =>
  eventSummary(storage, input)
);

registerTool("observability.ingest", "Ingest normalized observability documents into the shared indexed telemetry store.", observabilityIngestSchema, (input) =>
  observabilityIngest(storage, input)
);

registerTool("observability.search", "Search indexed observability documents and optionally include matching runtime events.", observabilitySearchSchema, (input) =>
  observabilitySearch(storage, input)
);

registerTool("observability.dashboard", "Summarize indexed observability data into a Kibana-like operator dashboard payload.", observabilityDashboardSchema, (input) =>
  observabilityDashboard(storage, input)
);

registerTool("observability.ship", "Ship file, metric, and control-plane data into the indexed observability store.", observabilityShipSchema, (input) =>
  observabilityShip(storage, input)
);

registerTool(
  "kernel.summary",
  "Summarize goals, plans, tasks, sessions, experiments, artifacts, and recent events into one kernel snapshot.",
  kernelSummarySchema,
  (input) => kernelSummary(storage, input)
);

registerTool(
  "office.snapshot",
  "Read a lightweight storage-backed operator snapshot for the Agent Office GUI without fanning out across many heavy MCP calls.",
  officeSnapshotSchema,
  (input) => officeSnapshot(storage, input)
);

registerTool(
  "operator.brief",
  "Return the current operator brief for the active goal, delegation chain, and runtime handoff state.",
  operatorBriefSchema,
  (input) => operatorBrief(storage, input)
);

registerTool("artifact.record", "Persist a durable artifact and optionally link it to goals, plans, tasks, runs, or other entities.", artifactRecordSchema, (input) =>
  artifactRecord(storage, input)
);

registerTool("artifact.get", "Fetch a durable artifact and its immediate provenance links.", artifactGetSchema, (input) =>
  artifactGet(storage, input)
);

registerTool("artifact.list", "List durable artifacts by scope, type, trust tier, or linked entity.", artifactListSchema, (input) =>
  artifactList(storage, input)
);

registerTool("artifact.link", "Create a durable provenance link between artifacts or between an artifact and another entity.", artifactLinkSchema, (input) =>
  artifactLink(storage, input)
);

registerTool("artifact.bundle", "Bundle artifacts and provenance for a single artifact or linked entity.", artifactBundleSchema, (input) =>
  artifactBundle(storage, input)
);

registerTool("experiment.create", "Create a durable benchmark or optimization experiment record.", experimentCreateSchema, (input) =>
  experimentCreate(storage, input)
);

registerTool("experiment.get", "Fetch a durable experiment record and its candidate runs.", experimentGetSchema, (input) =>
  experimentGet(storage, input)
);

registerTool("experiment.list", "List durable experiments by status or goal/plan/step filters.", experimentListSchema, (input) =>
  experimentList(storage, input)
);

registerTool("experiment.run", "Create a durable experiment candidate run and optionally dispatch it as a task.", experimentRunSchema, (input) =>
  experimentRun(storage, input)
);

registerTool("experiment.judge", "Judge a durable experiment run, compute improvement, and optionally promote the best candidate.", experimentJudgeSchema, (input) =>
  experimentJudge(storage, input)
);
registerTool("benchmark.suite_upsert", "Create or update a durable benchmark suite definition.", benchmarkSuiteUpsertSchema, (input) =>
  benchmarkSuiteUpsert(storage, input)
);
registerTool("benchmark.suite_list", "List durable benchmark suite definitions.", benchmarkSuiteListSchema, (input) =>
  benchmarkSuiteList(storage, input)
);
registerTool("benchmark.run", "Execute a benchmark suite against a real host with isolated workspaces and durable evidence.", benchmarkRunSchema, (input) =>
  benchmarkRun(storage, input)
);

registerTool("eval.suite_upsert", "Create or update a durable eval suite that composes benchmark and router cases.", evalSuiteUpsertSchema, (input) =>
  evalSuiteUpsert(storage, input)
);

registerTool("eval.suite_list", "List durable eval suites.", evalSuiteListSchema, (input) =>
  evalSuiteList(storage, input)
);

registerTool("eval.run", "Execute a durable eval suite against real benchmark suites and model-router decisions.", evalRunSchema, (input) =>
  evalRun(storage, input)
);

registerTool(
  "workflow.export",
  "Export a reproducible workflow bundle, JSONL run metrics, and an Argo-style DAG contract from a durable goal or plan.",
  workflowExportSchema,
  (input) => workflowExport(storage, input)
);

registerTool("playbook.list", "List built-in workflow playbooks inspired by external agent methodologies.", playbookListSchema, (input) =>
  playbookList(storage, input)
);

registerTool("playbook.get", "Fetch a built-in workflow playbook by id.", playbookGetSchema, (input) =>
  playbookGet(storage, input)
);

registerTool("playbook.instantiate", "Instantiate a built-in workflow playbook into a durable goal and plan.", playbookInstantiateSchema, (input) =>
  playbookInstantiate(storage, input)
);

registerTool("playbook.run", "Instantiate a built-in workflow playbook and immediately enter goal execution.", playbookRunSchema, (input) =>
  playbookRun(storage, invokeRegisteredTool, input)
);

registerTool("plan.create", "Create a durable candidate plan with structured steps for a goal.", planCreateSchema, (input) =>
  planCreate(storage, input)
);

registerTool("plan.get", "Fetch a durable plan and its steps by id.", planGetSchema, (input) =>
  planGet(storage, input)
);

registerTool("plan.list", "List durable plans by goal, status, or selection state.", planListSchema, (input) =>
  planList(storage, input)
);

registerTool("plan.update", "Update durable plan metadata, status, and selection state.", planUpdateSchema, (input) =>
  planUpdate(storage, input)
);

registerTool("plan.select", "Select a durable plan for a goal and update the goal's active plan.", planSelectSchema, (input) =>
  planSelect(storage, input)
);

registerTool("plan.step_update", "Update durable plan step progress, bindings, and execution metadata.", planStepUpdateSchema, (input) =>
  planStepUpdate(storage, input)
);

registerTool("plan.approve", "Approve a human-gated durable plan step and mark the gate as satisfied.", planApproveSchema, (input) =>
  planApprove(storage, input)
);

registerTool("plan.step_ready", "Evaluate which durable plan steps are ready based on current dependencies.", planStepReadySchema, (input) =>
  planStepReady(storage, input)
);

registerTool("plan.dispatch", "Dispatch ready durable plan steps into tools, tasks, TriChat, or human approval gates.", planDispatchSchema, (input) =>
  planDispatch(input)
);

registerTool("plan.resume", "Resume a durable plan or reset a blocked step, then re-dispatch through the kernel.", planResumeSchema, (input) =>
  planResume(input)
);

registerTool("dispatch.autorun", "Run bounded re-dispatch loops so backend completions can unlock downstream plan steps.", dispatchAutorunSchema, (input) =>
  dispatchAutorun(input)
);

registerTool(
  "imprint.inbox.enqueue",
  "Enqueue a local inbox task for continuous autonomous execution.",
  inboxEnqueueSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "imprint.inbox.enqueue",
      mutation: input.mutation,
      payload: input,
      execute: () => inboxEnqueue(repoRoot, input),
    })
);

registerTool(
  "imprint.inbox.list",
  "List local inbox tasks by status for debugging and triage.",
  inboxListSchema,
  (input) => inboxList(repoRoot, input)
);

registerTool(
  "imprint.profile_set",
  "Upsert durable local identity/profile instructions for autonomous agents.",
  imprintProfileSetSchema,
  (input) => imprintProfileSet(storage, input)
);

registerTool(
  "imprint.profile_get",
  "Read the durable local identity/profile instructions.",
  imprintProfileGetSchema,
  (input) => imprintProfileGet(storage, input)
);

registerTool(
  "imprint.snapshot",
  "Capture a local continuity snapshot (storage/tool/profile context) to SQLite and optional JSON.",
  imprintSnapshotSchema,
  (input) =>
    imprintSnapshot(storage, input, {
      repo_root: repoRoot,
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      get_tool_names: () => Array.from(toolRegistry.keys()),
    })
);

registerTool(
  "imprint.bootstrap",
  "Generate deterministic startup context from local profile, memories, transcript lines, and snapshots.",
  imprintBootstrapSchema,
  (input) =>
    imprintBootstrap(storage, input, {
      repo_root: repoRoot,
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      get_tool_names: () => Array.from(toolRegistry.keys()),
    })
);

registerTool(
  "imprint.auto_snapshot",
  "Manage interval-based continuity snapshots (status/start/stop/run_once).",
  imprintAutoSnapshotSchema,
  (input) =>
    imprintAutoSnapshotControl(storage, input, {
      repo_root: repoRoot,
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      get_tool_names: () => Array.from(toolRegistry.keys()),
    })
);

registerTool("transcript.log", "Log raw transcript lines into working memory.", transcriptLogSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "transcript.log",
    mutation: input.mutation,
    payload: input,
    execute: () => logTranscript(storage, input),
  })
);

registerTool("transcript.squish", "Squish raw transcript lines into distilled memories.", transcriptSquishSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "transcript.squish",
    mutation: input.mutation,
    payload: input,
    execute: () => squishTranscript(storage, input),
  })
);

registerTool(
  "transcript.run_timeline",
  "Read ordered transcript lines for a run with optional filters.",
  transcriptRunTimelineSchema,
  (input) => getTranscriptRunTimeline(storage, input)
);

registerTool(
  "transcript.pending_runs",
  "List run ids that still have unsquished transcript lines.",
  transcriptPendingRunsSchema,
  (input) => getTranscriptPendingRuns(storage, input)
);

registerTool(
  "transcript.auto_squish",
  "Manage interval-based backlog squishing (status/start/stop/run_once).",
  transcriptAutoSquishSchema,
  (input) => autoSquishControl(storage, input)
);

registerTool(
  "transcript.retention",
  "Apply retention policy for old transcript lines with optional dry-run mode.",
  transcriptRetentionSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "transcript.retention",
      mutation: input.mutation,
      payload: input,
      execute: () => applyTranscriptRetention(storage, input),
    })
);

registerTool("transcript.append", "Append a transcript entry with actor attribution.", transcriptAppendSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "transcript.append",
    mutation: input.mutation,
    payload: input,
    execute: () => appendTranscript(storage, input),
  })
);

registerTool(
  "transcript.summarize",
  "Generate a deterministic local summary for a transcript session and store it as a memory note.",
  transcriptSummarizeSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "transcript.summarize",
      mutation: input.mutation,
      payload: input,
      execute: () => summarizeTranscript(storage, input),
    })
);

registerTool("adr.create", "Create an ADR markdown file and record it in local storage.", adrCreateSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "adr.create",
    mutation: input.mutation,
    payload: input,
    execute: () => createAdr(storage, input, repoRoot),
  })
);

registerTool(
  "who_knows",
  "Search local notes and transcripts in the shared MCP knowledge base.",
  whoKnowsSchema,
  (input) => whoKnows(storage, { ...input, include_federated: input.include_federated ?? false })
);

registerTool(
  "knowledge.query",
  "Query the shared MCP knowledge base, including signed federated memory/task/goal summaries when available.",
  whoKnowsSchema,
  (input) => whoKnows(storage, { ...input, include_federated: input.include_federated ?? true })
);

registerTool(
  "policy.evaluate",
  "Evaluate a proposed action against local policy guardrails.",
  policyEvaluateSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "policy.evaluate",
      mutation: input.mutation,
      payload: input,
      execute: () => evaluatePolicy(storage, input),
    })
);

registerTool("run.begin", "Start an append-only execution run ledger.", runBeginSchema, (input) =>
  runBegin(storage, input)
);

registerTool("run.step", "Append a step event to an execution run ledger.", runStepSchema, (input) =>
  runStep(storage, input)
);

registerTool("run.end", "Finalize an execution run ledger.", runEndSchema, (input) =>
  runEnd(storage, input)
);

registerTool("run.timeline", "Read the timeline for an execution run ledger.", runTimelineSchema, (input) =>
  runTimeline(storage, input)
);

registerTool("task.create", "Create a durable local task record for autonomous execution.", taskCreateSchema, (input) =>
  taskCreate(storage, input)
);

registerTool("task.list", "List durable local tasks with optional status filtering.", taskListSchema, (input) =>
  taskList(storage, input)
);

registerTool("task.timeline", "Read ordered task lifecycle events from task_events.", taskTimelineSchema, (input) =>
  taskTimeline(storage, input)
);

registerTool("task.summary", "Summarize task queue reliability state (counts, running leases, last failure).", taskSummarySchema, (input) =>
  taskSummary(storage, input)
);

registerTool("task.claim", "Claim the next available task using a renewable lease.", taskClaimSchema, (input) =>
  taskClaim(storage, input)
);

registerTool("task.heartbeat", "Renew a leased task claim during long-running execution.", taskHeartbeatSchema, (input) =>
  taskHeartbeat(storage, input)
);

registerTool("task.complete", "Mark a running task as completed and release its lease.", taskCompleteSchema, (input) =>
  taskComplete(storage, input)
);

registerTool("task.cancel", "Cancel a pending or failed task so it no longer pages operators as active failed work.", taskCancelSchema, (input) =>
  taskCancel(storage, input)
);

registerTool("task.fail", "Mark a running task as failed and release its lease.", taskFailSchema, (input) =>
  taskFail(storage, input)
);

registerTool("task.retry", "Requeue a failed task for retry with optional delay.", taskRetrySchema, (input) =>
  taskRetry(storage, input)
);

registerTool("task.recover_expired", "Recover running tasks whose leases expired so abandoned work does not stay stuck indefinitely.", taskRecoverExpiredSchema, (input) =>
  taskRecoverExpired(storage, input)
);

registerTool("task.auto_retry", "Manage failed-task auto-retry daemon with deterministic backoff.", taskAutoRetrySchema, (input) =>
  taskAutoRetryControl(storage, input)
);
registerTool("worker.fabric", "Manage the distributed worker fabric across local and remote execution hosts.", workerFabricSchema, (input) =>
  workerFabric(storage, input)
);

registerTool("cluster.topology", "Track the current and planned lab topology so autonomy can reason about active and future execution capacity.", clusterTopologySchema, (input) =>
  clusterTopology(storage, input)
);

registerTool("model.router", "Manage and route across measured local and remote model backends.", modelRouterSchema, (input) =>
  modelRouter(storage, input)
);

registerTool(
  "autonomy.bootstrap",
  "Seed and repair the local autonomy substrate so the ring leader can self-start with real worker, model, org, and eval state.",
  autonomyBootstrapSchema,
  (input) => autonomyBootstrap(storage, invokeRegisteredTool, input)
);

registerTool(
  "autonomy.maintain",
  "Run bounded background upkeep so the control plane stays ready, autorun keeps scanning, learning stays visible, and eval health stays fresh without recursive self-improvement.",
  autonomyMaintainSchema,
  (input) => autonomyMaintain(storage, invokeRegisteredTool, input)
);

registerTool(
  "reaction.engine",
  "Run event-driven human-attention reactions so the system pushes actionable alerts instead of waiting for dashboard polling.",
  reactionEngineSchema,
  (input) => reactionEngineControl(storage, invokeRegisteredTool, input)
);

registerTool("notifier.send", "Send a real desktop or webhook notification from the MCP control plane.", notifierSendSchema, (input) =>
  notifierSend(storage, input)
);

registerTool(
  "autonomy.command",
  "Accept a single operator command, ensure the control plane is ready, compile bounded work, and kick off unattended execution.",
  autonomyCommandSchema,
  (input) => autonomyCommand(storage, invokeRegisteredTool, input)
);

registerTool(
  "autonomy.ide_ingress",
  "Mirror an IDE/operator objective into continuity, the office thread, and the durable autonomy command path.",
  autonomyIdeIngressSchema,
  (input) => autonomyIdeIngress(storage, invokeRegisteredTool, input)
);

registerTool(
  "provider.bridge",
  "Export, install, and truthfully report external client bridges that should point at this MCP runtime and its canonical IDE ingress path.",
  providerBridgeSchema,
  (input) => providerBridge(storage, input)
);

registerTool(
  "specialist.catalog",
  "Match, ensure, and persist narrow domain SMEs that can be routed automatically from real operator objectives.",
  specialistCatalogSchema,
  (input) => specialistCatalog(storage, invokeRegisteredTool, input)
);

registerTool("org.program", "Version and promote role programs for ring leader, directors, SMEs, and leaf agents.", orgProgramSchema, (input) =>
  orgProgram(storage, input)
);

registerTool(
  "optimizer",
  "Generate bounded role-program variants, score them against real compile previews, and promote only measured improvements.",
  optimizerSchema,
  (input) => optimizer(storage, input)
);

registerTool(
  "swarm.profile",
  "Select a concrete collaboration topology, memory preflight, and checkpoint policy for autonomous execution.",
  swarmProfileSchema,
  (input) => swarmProfile(input)
);

registerTool("task.compile", "Compile an objective into a durable DAG-style plan with explicit owners, evidence contracts, and rollback notes.", taskCompileSchema, (input) =>
  taskCompile(storage, input)
);

registerTool(
  "runtime.worker",
  "Launch and manage tmux-backed, worktree-isolated coding-worker runtimes that can execute and close linked MCP tasks.",
  runtimeWorkerSchema,
  (input) => runtimeWorker(storage, input)
);

registerTool("trichat.thread_open", "Create or update a durable tri-chat thread.", trichatThreadOpenSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "trichat.thread_open",
    mutation: input.mutation,
    payload: input,
    execute: () => trichatThreadOpen(storage, input),
  })
);

registerTool("trichat.thread_list", "List durable tri-chat threads by status.", trichatThreadListSchema, (input) =>
  trichatThreadList(storage, input)
);

registerTool("trichat.thread_get", "Read tri-chat thread metadata by thread id.", trichatThreadGetSchema, (input) =>
  trichatThreadGet(storage, input)
);

registerTool("trichat.message_post", "Append a message into a tri-chat thread timeline.", trichatMessagePostSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "trichat.message_post",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      let consensusBefore: unknown = null;
      let consensusAfter: unknown = null;
      let consensusAlertEvent: unknown = null;
      let consensusAlertWarning: string | null = null;
      try {
        consensusBefore = trichatConsensus(storage, {
          thread_id: input.thread_id,
          limit: 300,
          min_agents: CONSENSUS_ALERT_MIN_AGENTS,
          recent_turn_limit: 3,
        });
      } catch (error) {
        consensusAlertWarning = `consensus pre-check failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[trichat.consensus] pre-check failed: ${consensusAlertWarning}`);
      }

      const posted = trichatMessagePost(storage, input);
      let busEvent: unknown = null;
      let busWarning: string | null = null;
      try {
        const publishResult = triChatBusRuntime.publishFromTriChatMessage(posted.message, "mcp:trichat.message_post");
        busEvent = publishResult.event;
      } catch (error) {
        busWarning = error instanceof Error ? error.message : String(error);
        console.error(`[trichat.bus] message_post publish failed: ${busWarning}`);
      }

      try {
        consensusAfter = trichatConsensus(storage, {
          thread_id: input.thread_id,
          limit: 300,
          min_agents: CONSENSUS_ALERT_MIN_AGENTS,
          recent_turn_limit: 3,
        });
        const beforeLatest = getConsensusLatestTurn(consensusBefore);
        const afterLatest = getConsensusLatestTurn(consensusAfter);
        if (shouldEmitConsensusDisagreementAlert(beforeLatest, afterLatest)) {
          const disagreementAgents = afterLatest?.disagreement_agents ?? [];
          const majority = afterLatest?.majority_answer ?? "n/a";
          const responseCount = afterLatest?.response_count ?? 0;
          const requiredCount = afterLatest?.required_count ?? CONSENSUS_ALERT_MIN_AGENTS;
          const userMessageId = afterLatest?.user_message_id ?? "unknown";
          const content = truncate(
            `consensus disagreement detected: user_turn=${userMessageId} disagreement_agents=${
              disagreementAgents.join(",") || "unknown"
            } majority=${majority} responses=${responseCount}/${requiredCount}`,
            600
          );
          const publishResult = triChatBusRuntime.publish({
            thread_id: input.thread_id,
            event_type: "consensus.alert",
            source_agent: "consensus-monitor",
            source_client: "mcp:trichat.message_post",
            role: "system",
            content,
            metadata: {
              kind: "consensus.alert",
              trigger_message_id: posted.message.message_id,
              trigger_agent_id: posted.message.agent_id,
              trigger_role: posted.message.role,
              min_agents: CONSENSUS_ALERT_MIN_AGENTS,
              before_latest: beforeLatest,
              after_latest: afterLatest,
            },
          });
          consensusAlertEvent = publishResult.event;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        consensusAlertWarning = consensusAlertWarning
          ? `${consensusAlertWarning}; consensus post-check failed: ${message}`
          : `consensus post-check failed: ${message}`;
        console.error(`[trichat.consensus] post-check failed: ${message}`);
      }

      return {
        ...posted,
        bus_event: busEvent,
        bus_warning: busWarning,
        consensus_alert_event: consensusAlertEvent,
        consensus_alert_warning: consensusAlertWarning,
      };
    },
  })
);

registerTool(
  "trichat.turn_start",
  "Start or reuse a durable tri-chat turn state machine entry for a user message.",
  trichatTurnStartSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "trichat.turn_start",
      mutation: input.mutation,
      payload: input,
      execute: () => {
        const started = trichatTurnStart(storage, input);
        let busEvent: unknown = null;
        let busWarning: string | null = null;
        try {
          const publishResult = triChatBusRuntime.publish({
            thread_id: started.turn.thread_id,
            event_type: "trichat.turn_start",
            source_agent: "turn-orchestrator",
            source_client: "mcp:trichat.turn_start",
            role: "system",
            content: `turn ${started.turn.turn_id} started for user message ${started.turn.user_message_id}`,
            metadata: {
              kind: "trichat.turn_start",
              turn_id: started.turn.turn_id,
              user_message_id: started.turn.user_message_id,
              phase: started.turn.phase,
              phase_status: started.turn.phase_status,
              status: started.turn.status,
              created: started.created,
            },
          });
          busEvent = publishResult.event;
        } catch (error) {
          busWarning = error instanceof Error ? error.message : String(error);
          console.error(`[trichat.bus] turn_start publish failed: ${busWarning}`);
        }
        return {
          ...started,
          bus_event: busEvent,
          bus_warning: busWarning,
        };
      },
    })
);

registerTool(
  "trichat.turn_advance",
  "Advance tri-chat turn phase/status with persisted decision and verification metadata.",
  trichatTurnAdvanceSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "trichat.turn_advance",
      mutation: input.mutation,
      payload: input,
      execute: () => {
        const advanced = trichatTurnAdvance(storage, input);
        let busEvent: unknown = null;
        let busWarning: string | null = null;
        try {
          const publishResult = triChatBusRuntime.publish({
            thread_id: advanced.turn.thread_id,
            event_type: "trichat.turn_phase",
            source_agent: "turn-orchestrator",
            source_client: "mcp:trichat.turn_advance",
            role: "system",
            content: `turn ${advanced.turn.turn_id} phase=${advanced.turn.phase} phase_status=${advanced.turn.phase_status} status=${advanced.turn.status}`,
            metadata: {
              kind: "trichat.turn_phase",
              turn_id: advanced.turn.turn_id,
              user_message_id: advanced.turn.user_message_id,
              phase: advanced.turn.phase,
              phase_status: advanced.turn.phase_status,
              status: advanced.turn.status,
              retry_required: advanced.turn.retry_required,
              retry_agents: advanced.turn.retry_agents,
              novelty_score: advanced.turn.novelty_score,
              novelty_threshold: advanced.turn.novelty_threshold,
              disagreement: advanced.turn.disagreement,
              selected_agent: advanced.turn.selected_agent,
            },
          });
          busEvent = publishResult.event;
        } catch (error) {
          busWarning = error instanceof Error ? error.message : String(error);
          console.error(`[trichat.bus] turn_advance publish failed: ${busWarning}`);
        }
        return {
          ...advanced,
          bus_event: busEvent,
          bus_warning: busWarning,
        };
      },
    })
);

registerTool(
  "trichat.turn_artifact",
  "Append structured turn artifact content (plan/proposal/critique/merge/verify/summary).",
  trichatTurnArtifactSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "trichat.turn_artifact",
      mutation: input.mutation,
      payload: input,
      execute: () => {
        const result = trichatTurnArtifact(storage, input);
        let busEvent: unknown = null;
        let busWarning: string | null = null;
        try {
          const turn = storage.getTriChatTurnById(result.artifact.turn_id);
          if (turn) {
            const publishResult = triChatBusRuntime.publish({
              thread_id: turn.thread_id,
              event_type: "trichat.turn_artifact",
              source_agent: input.agent_id ?? "turn-orchestrator",
              source_client: "mcp:trichat.turn_artifact",
              role: "system",
              content: `turn ${turn.turn_id} artifact ${result.artifact.artifact_type} from ${result.artifact.agent_id ?? "n/a"}`,
              metadata: {
                kind: "trichat.turn_artifact",
                turn_id: turn.turn_id,
                artifact_id: result.artifact.artifact_id,
                artifact_type: result.artifact.artifact_type,
                phase: result.artifact.phase,
                agent_id: result.artifact.agent_id,
                score: result.artifact.score,
              },
            });
            busEvent = publishResult.event;
          }
        } catch (error) {
          busWarning = error instanceof Error ? error.message : String(error);
          console.error(`[trichat.bus] turn_artifact publish failed: ${busWarning}`);
        }
        return {
          ...result,
          bus_event: busEvent,
          bus_warning: busWarning,
        };
      },
    })
);

registerTool(
  "trichat.turn_get",
  "Read latest turn state and optional artifacts for a thread or specific turn id.",
  trichatTurnGetSchema,
  (input) => trichatTurnGet(storage, input)
);

registerTool(
  "trichat.workboard",
  "Summarize tri-chat orchestration workboard state (turn counts, phases, latest decision).",
  trichatWorkboardSchema,
  (input) => trichatWorkboard(storage, input)
);

registerTool(
  "trichat.novelty",
  "Evaluate proposal novelty and recommend forced-delta retries before merge.",
  trichatNoveltySchema,
  (input) => trichatNovelty(storage, input)
);

registerTool(
  "trichat.turn_orchestrate",
  "Run server-side turn orchestration actions (decision merge and verify finalization).",
  trichatTurnOrchestrateSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "trichat.turn_orchestrate",
      mutation: input.mutation,
      payload: input,
      execute: () => {
        const orchestrated = trichatTurnOrchestrate(storage, input) as Record<string, unknown>;
        let busEvent: unknown = null;
        let busWarning: string | null = null;
        try {
          const turn = (orchestrated.turn ?? null) as { turn_id?: string; thread_id?: string; phase?: string; status?: string } | null;
          const threadId = String(turn?.thread_id ?? "").trim();
          const turnId = String(turn?.turn_id ?? "").trim();
          if (threadId && turnId) {
            const publishResult = triChatBusRuntime.publish({
              thread_id: threadId,
              event_type: "trichat.turn_orchestrate",
              source_agent: "turn-orchestrator",
              source_client: "mcp:trichat.turn_orchestrate",
              role: "system",
              content: `turn ${turnId} orchestrated action=${String(input.action ?? "decide")}`,
              metadata: {
                kind: "trichat.turn_orchestrate",
                action: input.action ?? "decide",
                turn_id: turnId,
                phase: String(turn?.phase ?? ""),
                status: String(turn?.status ?? ""),
              },
            });
            busEvent = publishResult.event;
          }
        } catch (error) {
          busWarning = error instanceof Error ? error.message : String(error);
          console.error(`[trichat.bus] turn_orchestrate publish failed: ${busWarning}`);
        }
        return {
          ...orchestrated,
          bus_event: busEvent,
          bus_warning: busWarning,
        };
      },
    })
);

registerTool(
  "trichat.verify",
  "Run local project verification checks for execute-phase gating and reliability.",
  trichatVerifySchema,
  (input) => runTriChatVerify(input)
);

registerTool("trichat.timeline", "Read ordered messages for a tri-chat thread.", trichatTimelineSchema, (input) =>
  trichatTimeline(storage, input)
);

registerTool("trichat.summary", "Summarize tri-chat thread/message bus state.", trichatSummarySchema, (input) =>
  trichatSummary(storage, input)
);

registerTool("trichat.roster", "Read the configured tri-chat agent roster and active council selection.", trichatRosterSchema, (input) =>
  trichatRoster(storage, input)
);

registerTool(
  "trichat.consensus",
  "Compare configured tri-chat agent answers per user turn and flag disagreement.",
  trichatConsensusSchema,
  (input) => trichatConsensus(storage, input)
);

registerTool(
  "trichat.adapter_telemetry",
  "Record and read persistent tri-chat adapter circuit-breaker telemetry.",
  trichatAdapterTelemetrySchema,
  (input) => trichatAdapterTelemetry(storage, input)
);

registerTool(
  "trichat.adapter_protocol_check",
  "Run bridge protocol diagnostics (ping + optional dry-run ask) for configured tri-chat adapters.",
  trichatAdapterProtocolCheckSchema,
  (input) => trichatAdapterProtocolCheck(storage, input)
);

registerTool(
  "trichat.bus",
  "Manage the unix-socket tri-chat live event bus (status/start/stop/publish/tail).",
  trichatBusSchema,
  (input) => trichatBusControl(storage, triChatBusRuntime, input)
);

registerTool("trichat.retention", "Apply retention policy to old tri-chat messages.", trichatRetentionSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "trichat.retention",
    mutation: input.mutation,
    payload: input,
    execute: () => trichatRetention(storage, input),
  })
);

registerTool(
  "trichat.auto_retention",
  "Manage interval-based tri-chat retention daemon (status/start/stop/run_once).",
  trichatAutoRetentionSchema,
  (input) => trichatAutoRetentionControl(storage, input)
);

registerTool(
  "trichat.turn_watchdog",
  "Manage stale-turn watchdog daemon (status/start/stop/run_once) to auto-fail stalled turns with evidence.",
  trichatTurnWatchdogSchema,
  (input) => trichatTurnWatchdogControl(storage, input)
);

registerTool(
  "trichat.autopilot",
  "Manage autonomous TriChat daemon loops with away-mode safety gates, emergency brake, and mentorship persistence.",
  trichatAutopilotSchema,
  (input) => trichatAutopilotControl(storage, invokeRegisteredTool, input)
);

registerTool(
  "trichat.tmux_controller",
  "Manage tmux-backed nested controller execution for dynamic task allocation and live worker monitoring.",
  trichatTmuxControllerSchema,
  (input) => trichatTmuxController(storage, input)
);

registerTool(
  "trichat.chaos",
  "Inject controlled tri-chat adapter/turn failures and verify auto-finalization invariants.",
  trichatChaosSchema,
  (input) => trichatChaos(storage, input)
);

registerTool(
  "trichat.slo",
  "Compute and persist reliability SLO metrics (adapter p95 latency, adapter error rate, turn failure rate).",
  trichatSloSchema,
  (input) => trichatSlo(storage, input)
);

registerTool(
  "mutation.check",
  "Validate idempotency metadata against recorded mutation journal state.",
  mutationCheckSchema,
  (input) => mutationCheck(storage, input)
);

registerTool(
  "preflight.check",
  "Validate prerequisites and invariants before mutating actions.",
  preflightCheckSchema,
  (input) => preflightCheck(input)
);

registerTool(
  "postflight.verify",
  "Verify post-action assertions after mutating actions.",
  postflightVerifySchema,
  (input) => postflightVerify(input)
);

registerTool("lock.acquire", "Acquire or renew a lease-based lock.", lockAcquireSchema, (input) =>
  acquireLock(storage, input)
);

registerTool("lock.release", "Release a lease-based lock.", lockReleaseSchema, (input) =>
  releaseLock(storage, input)
);

registerTool("knowledge.promote", "Promote note/transcript/memory/transcript_line content into durable knowledge.", knowledgePromoteSchema, (input) =>
  knowledgePromote(storage, input)
);

registerTool("knowledge.decay", "Apply trust tier decay policy to stale notes.", knowledgeDecaySchema, (input) =>
  knowledgeDecay(storage, input)
);

registerTool(
  "retrieval.hybrid",
  "Run local hybrid retrieval with citation-rich results.",
  retrievalHybridSchema,
  (input) => retrievalHybrid(storage, input)
);

registerTool("decision.link", "Record a decision and link it to an entity.", decisionLinkSchema, (input) =>
  decisionLink(storage, input)
);

registerTool(
  "simulate.workflow",
  "Run deterministic workflow simulation for provision/deprovision scenarios.",
  simulateWorkflowSchema,
  (input) => simulateWorkflow(input)
);

registerTool(
  "desktop.control",
  "Manage the local desktop control lane, capability heartbeat, and durable host-control policy.",
  desktopControlSchema,
  (input) => desktopControl(storage, input)
);

registerTool(
  "desktop.observe",
  "Inspect the local desktop through frontmost-app, clipboard, and screenshot observation tools.",
  desktopObserveSchema,
  (input) => desktopObserve(storage, input)
);

registerTool(
  "desktop.context",
  "Read shared screen context from Chronicle when live, or fall back to a logged desktop.observe screenshot capture.",
  desktopContextSchema,
  (input) => desktopContext(storage, input)
);

registerTool(
  "desktop.act",
  "Act on the local desktop by opening apps/URLs, typing text, pressing keys, and setting the clipboard.",
  desktopActSchema,
  (input) => desktopAct(storage, input)
);

registerTool(
  "desktop.listen",
  "Capture short microphone clips to a temp file through the local desktop control lane.",
  desktopListenSchema,
  (input) => desktopListen(storage, input)
);

registerTool(
  "patient.zero",
  "Arm or disarm an explicit high-risk local-control posture with operator-visible desktop access and audit reporting.",
  patientZeroSchema,
  (input) => patientZeroControl(storage, invokeRegisteredTool, input)
);

registerTool(
  "privileged.exec",
  "Run explicit root-level local commands through the mcagent admin account when Patient Zero is armed, with full runtime auditing.",
  privilegedExecSchema,
  (input) => privilegedExec(storage, input)
);

registerTool(
  "tool.search",
  "Search registered MCP tools by name, description, tags, or capability area using the live tool registry.",
  toolSearchSchema,
  (input) => toolSearch(input, listToolCatalogEntries)
);

registerTool(
  "permission.profile",
  "Manage durable session permission profiles and resolve effective inheritance across goals, plans, tasks, and sessions.",
  permissionProfileSchema,
  (input) => permissionProfileControl(storage, input)
);

registerTool(
  "budget.ledger",
  "Record, list, and summarize append-only projected and actual provider/model/run/task budget usage.",
  budgetLedgerSchema,
  (input) => budgetLedgerControl(storage, input)
);

registerTool(
  "warm.cache",
  "Manage the startup prefetch and warm-cache lane for default control-plane summaries.",
  warmCacheSchema,
  (input) => warmCacheControl(storage, input)
);

registerTool(
  "feature.flag",
  "Manage and evaluate durable feature-flag rollout state for autonomy, provider, and operator surfaces.",
  featureFlagSchema,
  (input) => featureFlagControl(storage, input)
);

registerTool("health.tools", "Check tool registry health.", healthToolsSchema, () =>
  healthTools(Array.from(toolRegistry.keys()))
);

registerTool("health.storage", "Check local storage health.", healthStorageSchema, () =>
  healthStorage(storage)
);

registerTool("storage.backups", "Inspect and prune local storage backup artifacts.", storageBackupsSchema, (input) =>
  storageBackups(storage, input)
);

registerTool("health.policy", "Check policy subsystem health and guardrails.", healthPolicySchema, () =>
  healthPolicy()
);

registerTool("incident.open", "Create a local incident record with opening timeline event.", incidentOpenSchema, (input) =>
  incidentOpen(storage, input)
);

registerTool("incident.timeline", "Read incident timeline events.", incidentTimelineSchema, (input) =>
  incidentTimeline(storage, input)
);

registerTool(
  "golden.case_capture",
  "Capture a durable golden case from research, failures, or traces and optionally seed a benchmark case.",
  goldenCaseCaptureSchema,
  (input) => goldenCaseCapture(storage, input)
);

registerTool("query.plan", "Produce a confidence-scored query plan with evidence citations.", queryPlanSchema, (input) =>
  queryPlan(storage, input)
);

registerTool("migration.status", "Read applied schema migration versions and metadata.", migrationStatusSchema, () =>
  migrationStatus(storage)
);

const requestedDomainPacks = parseEnabledDomainPackIds(
  getArgValue(startupModeArgs, "--domain-packs") ?? process.env.MCP_DOMAIN_PACKS
);
const domainPackRegistration = registerDomainPacks(requestedDomainPacks, {
  storage,
  repo_root: repoRoot,
  server_name: SERVER_NAME,
  server_version: SERVER_VERSION,
  register_tool: registerTool,
  register_planner_hook: registerPlannerHook,
  register_verifier_hook: registerVerifierHook,
  run_idempotent_mutation: runIdempotentMutation,
});

if (domainPackRegistration.unknown.length > 0) {
  const available = listBuiltinDomainPacks().map((pack) => pack.id);
  console.warn(
    `[domain-packs] unknown pack ids: ${domainPackRegistration.unknown.join(", ")}; available: ${available.join(", ") || "none"}`
  );
}

if (domainPackRegistration.registered.length > 0) {
  console.error(`[domain-packs] enabled: ${domainPackRegistration.registered.join(", ")}`);
}

initializeImprintAutoSnapshotDaemon(storage, {
  repo_root: repoRoot,
  server_name: SERVER_NAME,
  server_version: SERVER_VERSION,
  get_tool_names: () => Array.from(toolRegistry.keys()),
});
initializeWarmCacheLane(storage);
if (backgroundOwnerEnabled) {
  initializeGoalAutorunDaemon(storage, invokeRegisteredTool);
  initializeAutonomyMaintainDaemon(storage, invokeRegisteredTool);
  initializeReactionEngineDaemon(storage, invokeRegisteredTool);
}

function createServerInstance() {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(toolRegistry.values()).map((entry) => entry.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await invokeRegisteredTool(name, args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      if (storage.isSqliteCorruptionError(error)) {
        storage.recordSqliteError(error);
        const reopen = storage.reopenDatabase();
        const detail = reopen.ok
          ? "SQLite corruption detected; database handle recycled successfully. Retry the request."
          : `SQLite corruption detected; reopen failed: ${reopen.error}. Stop the MCP writer, preserve the current database, restore a healthy backup or validated recovered copy, then restart.`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: detail,
                tool: name,
                reopen_ok: reopen.ok,
                recovery_required: !reopen.ok,
              }),
            },
          ],
          isError: true,
        };
      }
      const message = truncate(error instanceof Error ? error.message : String(error));
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  return server;
}

function buildHttpHealthSnapshot() {
  const workerFabric = resolveEffectiveWorkerFabric(storage, {
    fallback_workspace_root: repoRoot,
    fallback_worker_count: 1,
    fallback_shell: "/bin/zsh",
  });
  const healthCounts = workerFabric.hosts.reduce<Record<"healthy" | "degraded" | "offline", number>>(
    (acc, host) => {
      acc[host.telemetry.health_state] += 1;
      return acc;
    },
    { healthy: 0, degraded: 0, offline: 0 }
  );
  const autonomyState = storage.getAutonomyMaintainState();
  const autonomyRuntime = getAutonomyMaintainRuntimeStatus();
  const minimumEvalScore = Number(autonomyRuntime.config.minimum_eval_score ?? autonomyState?.minimum_eval_score ?? 75);
  const evalHealth = buildEvalHealth(autonomyState, {
    run_eval_if_due: autonomyRuntime.config.run_eval_if_due ?? autonomyState?.run_eval_if_due ?? true,
    eval_interval_seconds: Number(autonomyRuntime.config.eval_interval_seconds ?? autonomyState?.eval_interval_seconds ?? 21600),
    eval_suite_id: String(autonomyRuntime.config.eval_suite_id ?? autonomyState?.eval_suite_id ?? "autonomy.control-plane"),
    minimum_eval_score: minimumEvalScore,
    current_dependency_fingerprint: computeEvalDependencyFingerprint(
      storage,
      String(autonomyRuntime.config.eval_suite_id ?? autonomyState?.eval_suite_id ?? "autonomy.control-plane")
    ),
  });
  const reactionState = storage.getReactionEngineState();
  const reactionRuntime = getReactionEngineRuntimeStatus();
  const observability = storage.summarizeObservabilityDocuments({});
  const observabilityRecentWindow = new Date(Date.now() - 15 * 60_000).toISOString();
  const recentObservabilityDocs = storage.listObservabilityDocuments({
    since: observabilityRecentWindow,
    levels: ["critical", "error", "warn", "info", "debug", "trace"],
    limit: 500,
  });
  const recentCriticalCount = countActionableRecentObservabilityDocuments(storage, recentObservabilityDocs, "critical");
  const recentErrorCount = countActionableRecentObservabilityDocuments(storage, recentObservabilityDocs, "error");
  const attention: string[] = [];
  const autonomyAwaitingFirstTick = isAutonomyMaintainAwaitingFirstTick(autonomyState, {
    running: autonomyRuntime.running,
    last_tick_at: autonomyRuntime.last_tick_at,
  });
  const autonomyStale =
    autonomyState?.enabled === true &&
    Date.now() - Date.parse(autonomyState.last_run_at ?? "") >
      Math.max(
        Number(autonomyRuntime.config.interval_seconds ?? autonomyState?.interval_seconds ?? 120) * 3000,
        300_000
      );
  const reactionStale =
    reactionState?.enabled === true &&
    Date.now() - Date.parse(reactionState.last_run_at ?? "") >
      Math.max(
        Number(reactionState.interval_seconds ?? 120) * 3000,
        300_000
      );
  if (healthCounts.healthy < 1) {
    attention.push("worker_fabric.unhealthy");
  }
  if (autonomyState?.enabled !== true || autonomyRuntime.running !== true) {
    attention.push("autonomy_maintain.not_running");
  } else if (autonomyStale) {
    attention.push("autonomy_maintain.stale");
  }
  if (autonomyAwaitingFirstTick) {
    attention.push("autonomy_maintain.awaiting_first_tick");
  }
  if (autonomyState?.last_error) {
    attention.push("autonomy_maintain.error");
  }
  if (!evalHealth.operational) {
    attention.push("autonomy_eval.unhealthy");
  } else if (evalHealth.due_by_age) {
    attention.push("autonomy_eval.overdue");
  }
  if (reactionState?.enabled !== true || reactionRuntime.running !== true) {
    attention.push("reaction_engine.not_running");
  } else if (reactionStale) {
    attention.push("reaction_engine.stale");
  }
  if (observability.count < 1) {
    attention.push("observability.empty");
  }
  if (recentCriticalCount > 0) {
    attention.push("observability.critical_recent");
  } else if (recentErrorCount > 0) {
    attention.push("observability.error_recent");
  }
  const ready =
    healthCounts.healthy > 0 &&
    autonomyState?.enabled === true &&
    autonomyRuntime.running === true &&
    !autonomyStale &&
    !autonomyAwaitingFirstTick &&
    !autonomyState?.last_error &&
    evalHealth.operational &&
    reactionState?.enabled === true &&
    reactionRuntime.running === true &&
    !reactionStale &&
    !reactionState?.last_error &&
    observability.count > 0 &&
    recentCriticalCount < 1;

  return {
    ready,
    state: ready ? "ready" : "degraded",
    attention,
    worker_fabric: {
      host_count: workerFabric.hosts.length,
      enabled_host_count: workerFabric.hosts.filter((host) => host.enabled).length,
      healthy_host_count: healthCounts.healthy,
      degraded_host_count: healthCounts.degraded,
      offline_host_count: healthCounts.offline,
    },
    autonomy_maintain: {
      enabled: autonomyState?.enabled === true,
      runtime_running: autonomyRuntime.running === true,
      stale: autonomyStale,
      awaiting_first_tick: autonomyAwaitingFirstTick,
      last_run_at: autonomyState?.last_run_at ?? null,
      eval_due: evalHealth.due,
      eval_health: {
        suite_id: evalHealth.suite_id,
        minimum_eval_score: minimumEvalScore,
        last_eval_score: evalHealth.last_eval_score,
        due: evalHealth.due,
        due_by_age: evalHealth.due_by_age,
        due_by_dependency_drift: evalHealth.due_by_dependency_drift,
        below_threshold: evalHealth.below_threshold,
        never_run: evalHealth.never_run,
        operational: evalHealth.operational,
        healthy: evalHealth.healthy,
      },
    },
    reaction_engine: {
      enabled: reactionState?.enabled === true,
      runtime_running: reactionRuntime.running === true,
      stale: reactionStale,
      last_run_at: reactionState?.last_run_at ?? null,
    },
    observability: {
      document_count: observability.count,
      recent_error_count: recentErrorCount,
      recent_critical_count: recentCriticalCount,
    },
    model_router: {
      enabled: Boolean(storage.getModelRouterState()?.enabled),
      backend_count: storage.getModelRouterState()?.backends.length ?? 0,
      enabled_backend_count: (storage.getModelRouterState()?.backends ?? []).filter((backend) => backend.enabled).length,
      default_backend_id: storage.getModelRouterState()?.default_backend_id ?? null,
    },
    ts: new Date().toISOString(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const httpEnabled = args.includes("--http") || process.env.MCP_HTTP === "1";
  const bootstrapOnStart = parseBooleanEnv(process.env.MCP_AUTONOMY_BOOTSTRAP_ON_START, true);
  const maintainOnStart = parseBooleanEnv(process.env.MCP_AUTONOMY_MAINTAIN_ON_START, true);
  const maintainRunImmediatelyOnStart = parseBooleanEnv(
    process.env.MCP_AUTONOMY_MAINTAIN_RUN_IMMEDIATELY_ON_START,
    false
  );
  const startupConvergenceDelayMs = (() => {
    const parsed = Number.parseInt(String(process.env.MCP_AUTONOMY_STARTUP_CONVERGENCE_DELAY_MS ?? "").trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(60_000, parsed);
    }
    return httpEnabled ? 5_000 : 0;
  })();
  const startupNonce = `${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  const runStartupConvergence = async () => {
    if (!backgroundOwnerEnabled) {
      return;
    }
    const persistedAutopilotState = storage.getTriChatAutopilotState();
    const startupAutostartRingLeader =
      parseBooleanEnv(process.env.TRICHAT_RING_LEADER_AUTOSTART, true) && !persistedAutopilotState;
    if (bootstrapOnStart) {
      try {
        await autonomyBootstrap(storage, invokeRegisteredTool, {
          action: "ensure",
          local_host_id: "local",
          mutation: {
            idempotency_key: `server-startup-autonomy-${startupNonce}`,
            side_effect_fingerprint: `server-startup-autonomy-${startupNonce}`,
          },
          probe_ollama_url: process.env.TRICHAT_OLLAMA_URL,
          autostart_ring_leader: startupAutostartRingLeader,
          run_immediately: false,
          seed_org_programs: true,
          seed_benchmark_suite: true,
          seed_eval_suite: true,
          source_client: "server.startup",
        });
      } catch (error) {
        console.warn(
          `[autonomy.bootstrap] startup ensure failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (maintainOnStart) {
      try {
        await autonomyMaintain(storage, invokeRegisteredTool, {
          action: "start",
          local_host_id: "local",
          mutation: {
            idempotency_key: `server-startup-autonomy-maintain-${startupNonce}`,
            side_effect_fingerprint: `server-startup-autonomy-maintain-${startupNonce}`,
          },
          probe_ollama_url: process.env.TRICHAT_OLLAMA_URL,
          ensure_bootstrap: true,
          autostart_ring_leader: startupAutostartRingLeader,
          bootstrap_run_immediately: false,
          start_goal_autorun_daemon: true,
          start_task_auto_retry_daemon: true,
          start_transcript_auto_squish_daemon: true,
          start_imprint_auto_snapshot_daemon: true,
          start_trichat_auto_retention_daemon: true,
          start_trichat_turn_watchdog_daemon: true,
          run_task_recovery: true,
          start_runtime_workers: true,
          maintain_tmux_controller: true,
          run_eval_if_due: true,
          eval_interval_seconds: 21600,
          eval_suite_id: "autonomy.control-plane",
          minimum_eval_score: 75,
          run_optimizer_if_due: true,
          optimizer_interval_seconds: 14400,
          optimizer_min_improvement: 2,
          refresh_learning_summary: true,
          learning_review_interval_seconds: 300,
          run_goal_hygiene: true,
          start_reaction_engine_daemon: true,
          enable_self_drive: true,
          self_drive_cooldown_seconds: 1800,
          interval_seconds: 120,
          publish_runtime_event: true,
          run_immediately: maintainRunImmediatelyOnStart,
          source_client: "server.startup",
        });
      } catch (error) {
        console.warn(
          `[autonomy.maintain] startup run failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const desktopControlState = storage.getDesktopControlState();
    if (desktopControlState.enabled) {
      try {
        await desktopControl(storage, {
          action: "heartbeat",
          mutation: {
            idempotency_key: `server-startup-desktop-control-${startupNonce}`,
            side_effect_fingerprint: `server-startup-desktop-control-${startupNonce}`,
          },
          source_client: "server.startup",
        });
      } catch (error) {
        console.warn(
          `[desktop.control] startup heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  if (httpEnabled) {
    const port = Number(getArgValue(args, "--http-port") ?? process.env.MCP_HTTP_PORT ?? 8787);
    const host = getArgValue(args, "--http-host") ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    const allowedOriginsEnv =
      process.env.MCP_HTTP_ALLOWED_ORIGINS ?? "http://localhost,http://127.0.0.1";
    const allowedOrigins = allowedOriginsEnv.split(",").map((origin) => origin.trim()).filter(Boolean);

    await startHttpTransport(createServerInstance, {
      port,
      host,
      allowedOrigins,
      bearerToken: process.env.MCP_HTTP_BEARER_TOKEN ?? null,
      healthSnapshot: buildHttpHealthSnapshot,
      autonomyMaintainSnapshot: () => {
        const autonomyState = storage.getAutonomyMaintainState();
        const autonomyRuntime = getAutonomyMaintainRuntimeStatus();
        return {
          enabled: autonomyState?.enabled === true,
          runtime_running: autonomyRuntime.running === true,
          awaiting_first_tick: isAutonomyMaintainAwaitingFirstTick(autonomyState, {
            running: autonomyRuntime.running,
            last_tick_at: autonomyRuntime.last_tick_at,
          }),
        };
      },
      officeSnapshot: ({ threadId, theme, forceLive }) =>
        buildOfficeGuiSnapshot(
          officeSnapshot(storage, {
            thread_id: threadId,
            turn_limit: 12,
            task_limit: 24,
            session_limit: 50,
            event_limit: 24,
            learning_limit: 120,
            runtime_worker_limit: 20,
            include_kernel: true,
            include_learning: true,
            include_bus: true,
            include_adapter: true,
            include_runtime_workers: true,
            metadata: forceLive ? { source: "http.live" } : undefined,
          }) as Record<string, unknown>,
          { theme }
        ),
      officeRawSnapshot: ({ threadId }) =>
        officeSnapshot(storage, {
          thread_id: threadId,
          turn_limit: 12,
          task_limit: 24,
          session_limit: 50,
          event_limit: 24,
          learning_limit: 120,
          runtime_worker_limit: 20,
          include_kernel: true,
          include_learning: true,
          include_bus: true,
          include_adapter: true,
          include_runtime_workers: true,
          metadata: { source: "http.raw" },
        }),
      officeRealtimeSnapshot: ({ threadId, theme }) =>
        officeRealtimeSnapshot(storage, {
          thread_id: threadId,
          theme,
        }),
      officeRealtimeSignals: () => {
        const autonomyState = storage.getAutonomyMaintainState();
        const lastCheckAt = String(autonomyState?.last_provider_bridge_check_at ?? "").trim();
        const intervalSecondsRaw = Number(autonomyState?.interval_seconds ?? 120);
        const intervalSeconds = Number.isFinite(intervalSecondsRaw) && intervalSecondsRaw > 0 ? intervalSecondsRaw : 120;
        const parsedLastCheckAt = Date.parse(lastCheckAt);
        const stale =
          !Number.isFinite(parsedLastCheckAt) ||
          Date.now() - parsedLastCheckAt > Math.max(intervalSeconds * 3_000, 300_000);
        return {
          generated_at: autonomyState?.last_provider_bridge_check_at ?? autonomyState?.updated_at ?? new Date().toISOString(),
          stale,
          diagnostics: Array.isArray(autonomyState?.provider_bridge_diagnostics)
            ? autonomyState?.provider_bridge_diagnostics
            : [],
        };
      },
      officeHostFabric: (input) => workerFabric(storage, input as z.infer<typeof workerFabricSchema>),
      federationIngest: ({ payload, networkGate }) =>
        ingestFederationPayload(storage, payload, networkGate as unknown as Record<string, unknown>),
      trustedRemoteHosts: () => storage.getWorkerFabricState()?.hosts ?? [],
    });
    if (startupConvergenceDelayMs > 0) {
      const timer = setTimeout(() => {
        void runStartupConvergence();
      }, startupConvergenceDelayMs);
      timer.unref?.();
    } else {
      void runStartupConvergence();
    }
  } else {
    await startStdioTransport(createServerInstance());
    startWarmCacheStartupPrefetch(storage);
    if (backgroundOwnerEnabled) {
      void runStartupConvergence();
    }
  }
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

type ConsensusLatestTurnSnapshot = {
  status: string;
  user_message_id: string | null;
  disagreement_agents: string[];
  majority_answer: string | null;
  response_count: number;
  required_count: number;
  user_excerpt: string | null;
};

function getConsensusLatestTurn(payload: unknown): ConsensusLatestTurnSnapshot | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const latestRaw = (payload as Record<string, unknown>).latest_turn;
  if (!latestRaw || typeof latestRaw !== "object") {
    return null;
  }
  const latest = latestRaw as Record<string, unknown>;
  const status = typeof latest.status === "string" ? latest.status.trim().toLowerCase() : "";
  if (!status) {
    return null;
  }
  const userMessageId = typeof latest.user_message_id === "string" && latest.user_message_id.trim()
    ? latest.user_message_id.trim()
    : null;
  const disagreementAgents = Array.isArray(latest.disagreement_agents)
    ? latest.disagreement_agents
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  const majorityAnswer = typeof latest.majority_answer === "string" && latest.majority_answer.trim()
    ? latest.majority_answer.trim()
    : null;
  const responseCount =
    typeof latest.response_count === "number" && Number.isFinite(latest.response_count)
      ? Math.max(0, Math.trunc(latest.response_count))
      : 0;
  const requiredCount =
    typeof latest.required_count === "number" && Number.isFinite(latest.required_count)
      ? Math.max(0, Math.trunc(latest.required_count))
      : 0;
  const userExcerpt = typeof latest.user_excerpt === "string" && latest.user_excerpt.trim()
    ? latest.user_excerpt.trim()
    : null;
  return {
    status,
    user_message_id: userMessageId,
    disagreement_agents: disagreementAgents,
    majority_answer: majorityAnswer,
    response_count: responseCount,
    required_count: requiredCount,
    user_excerpt: userExcerpt,
  };
}

function shouldEmitConsensusDisagreementAlert(
  beforeLatest: ConsensusLatestTurnSnapshot | null,
  afterLatest: ConsensusLatestTurnSnapshot | null
): boolean {
  if (!afterLatest || afterLatest.status !== "disagreement") {
    return false;
  }
  if (!beforeLatest) {
    return false;
  }
  if (beforeLatest.user_message_id !== afterLatest.user_message_id) {
    return false;
  }
  return beforeLatest.status !== "disagreement";
}

function parseConsensusMinAgents(value: string | undefined): number {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return 3;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.max(2, Math.min(parsed, 12));
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function runTriChatVerify(input: z.infer<typeof trichatVerifySchema>) {
  const cwd = input.project_dir?.trim() ? path.resolve(input.project_dir) : repoRoot;
  const command = resolveTriChatVerifyCommand(input.command, cwd);
  const timeoutSeconds = parseBoundedInt(
    input.timeout_seconds,
    DEFAULT_TRICHAT_VERIFY_TIMEOUT_SECONDS,
    5,
    1800
  );
  const captureLimit = parseBoundedInt(input.capture_limit, 4000, 200, 20000);

  if (!command) {
    return {
      ok: true,
      executed: false,
      passed: null,
      cwd,
      command: null,
      reason: "No verify command configured or auto-detected.",
    };
  }

  const startedAt = new Date().toISOString();
  const child = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  const finishedAt = new Date().toISOString();
  const stdout = truncate(String(child.stdout ?? ""), captureLimit);
  const stderr = truncate(String(child.stderr ?? ""), captureLimit);
  const timedOut = child.error?.name === "Error" && /ETIMEDOUT|timed out/i.test(String(child.error.message ?? ""));
  const signal = child.signal ?? null;
  const code = typeof child.status === "number" ? child.status : null;
  const passed = !timedOut && signal === null && code === 0;
  return {
    ok: true,
    executed: true,
    passed,
    cwd,
    command,
    timeout_seconds: timeoutSeconds,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: code,
    signal,
    timed_out: timedOut,
    stdout,
    stderr,
    error: child.error ? truncate(String(child.error.message ?? child.error), captureLimit) : null,
  };
}

function resolveTriChatVerifyCommand(inputCommand: string | undefined, cwd: string): string | null {
  const explicit = String(inputCommand ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (DEFAULT_TRICHAT_VERIFY_COMMAND) {
    return DEFAULT_TRICHAT_VERIFY_COMMAND;
  }
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    return "npm test --silent";
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return "go test ./...";
  }
  if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "requirements.txt"))) {
    return "pytest -q";
  }
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
