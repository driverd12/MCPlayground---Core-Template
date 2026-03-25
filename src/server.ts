import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Storage } from "./storage.js";
import { appendMemory, getMemory, memoryAppendSchema, memoryGetSchema, memorySearchSchema, searchMemory } from "./tools/memory.js";
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
import { goalCreate, goalCreateSchema, goalGet, goalGetSchema, goalList, goalListSchema } from "./tools/goal.js";
import {
  planCreate,
  planCreateSchema,
  planGet,
  planGetSchema,
  planList,
  planListSchema,
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
import { incidentOpen, incidentOpenSchema, incidentTimeline, incidentTimelineSchema } from "./tools/incident.js";
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
  taskAutoRetryControl,
  taskAutoRetrySchema,
  initializeTaskAutoRetryDaemon,
} from "./tools/task.js";
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
const storage = new Storage(storagePath);
storage.init();
initializeAutoSquishDaemon(storage);
initializeTaskAutoRetryDaemon(storage);
initializeTriChatAutoRetentionDaemon(storage);
initializeTriChatTurnWatchdogDaemon(storage);
initializeTriChatAutopilotDaemon(storage);
const triChatBusRuntime = new TriChatBusRuntime(storage, {
  socket_path: process.env.TRICHAT_BUS_SOCKET_PATH
    ? path.resolve(process.env.TRICHAT_BUS_SOCKET_PATH)
    : path.join(repoRoot, "data", "trichat.bus.sock"),
});
triChatBusRuntime.initialize({
  auto_start: parseBooleanEnv(process.env.TRICHAT_BUS_AUTOSTART, true),
});

const SERVER_NAME = "mcplayground-core-template";
const SERVER_VERSION = "1.0.0";
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

function registerTool(name: string, description: string, schema: z.ZodTypeAny, handler: ToolEntry["handler"]) {
  const tool: Tool = {
    name,
    description,
    inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Tool["inputSchema"],
  };
  toolRegistry.set(name, { schema, tool, handler });
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

registerTool("memory.search", "Search long-term memory using lexical matching.", memorySearchSchema, (input) =>
  searchMemory(storage, input)
);

registerTool("memory.get", "Fetch a memory by id for deterministic debugging.", memoryGetSchema, (input) =>
  getMemory(storage, input)
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

registerTool("plan.step_ready", "Evaluate which durable plan steps are ready based on current dependencies.", planStepReadySchema, (input) =>
  planStepReady(storage, input)
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
  (input) => whoKnows(storage, input)
);

registerTool(
  "knowledge.query",
  "Query local notes and transcripts in the shared MCP knowledge base.",
  whoKnowsSchema,
  (input) => whoKnows(storage, input)
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

registerTool("task.fail", "Mark a running task as failed and release its lease.", taskFailSchema, (input) =>
  taskFail(storage, input)
);

registerTool("task.retry", "Requeue a failed task for retry with optional delay.", taskRetrySchema, (input) =>
  taskRetry(storage, input)
);

registerTool("task.auto_retry", "Manage failed-task auto-retry daemon with deterministic backoff.", taskAutoRetrySchema, (input) =>
  taskAutoRetryControl(storage, input)
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
  (input) => trichatAutopilotControl(storage, input)
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

registerTool("health.tools", "Check tool registry health.", healthToolsSchema, () =>
  healthTools(Array.from(toolRegistry.keys()))
);

registerTool("health.storage", "Check local storage health.", healthStorageSchema, () =>
  healthStorage(storage)
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

registerTool("query.plan", "Produce a confidence-scored query plan with evidence citations.", queryPlanSchema, (input) =>
  queryPlan(storage, input)
);

registerTool("migration.status", "Read applied schema migration versions and metadata.", migrationStatusSchema, () =>
  migrationStatus(storage)
);

const startupArgs = process.argv.slice(2);
const requestedDomainPacks = parseEnabledDomainPackIds(
  getArgValue(startupArgs, "--domain-packs") ?? process.env.MCP_DOMAIN_PACKS
);
const domainPackRegistration = registerDomainPacks(requestedDomainPacks, {
  storage,
  repo_root: repoRoot,
  server_name: SERVER_NAME,
  server_version: SERVER_VERSION,
  register_tool: registerTool,
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

function createServerInstance() {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
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
    const entry = toolRegistry.get(name);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const parsed = entry.schema.parse(args ?? {});
      const result = await entry.handler(parsed);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      const message = truncate(error instanceof Error ? error.message : String(error));
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const httpEnabled = args.includes("--http") || process.env.MCP_HTTP === "1";

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
    });
  } else {
    await startStdioTransport(createServerInstance());
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
