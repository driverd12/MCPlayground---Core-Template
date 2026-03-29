import crypto from "node:crypto";
import { z } from "zod";
import { Storage } from "../storage.js";
import { autonomyCommandBaseSchema } from "./autonomy_command.js";
import { runIdempotentMutation } from "./mutation.js";

const recordSchema = z.record(z.unknown());
const threadStatusSchema = z.enum(["active", "paused", "archived", "closed"]);

export const autonomyIdeIngressSchema = autonomyCommandBaseSchema
  .extend({
    session_id: z.string().min(1).max(200).optional(),
    thread_id: z.string().min(1).max(200).optional(),
    thread_title: z.string().min(1).max(200).optional(),
    thread_status: threadStatusSchema.default("active"),
    append_transcript: z.boolean().default(true),
    append_memory: z.boolean().default(true),
    publish_event: z.boolean().default(true),
    mirror_to_thread: z.boolean().default(true),
    start_trichat_turn: z.boolean().default(false),
    thread_metadata: recordSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.target_entity_type && !value.target_entity_id) || (!value.target_entity_type && value.target_entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_entity_type and target_entity_id must be provided together",
        path: ["target_entity_type"],
      });
    }
  });

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

function dedupeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, phase: string) {
  const safePhase = phase.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const digest = crypto
    .createHash("sha256")
    .update(`${base.idempotency_key}|${base.side_effect_fingerprint}|${safePhase}`)
    .digest("hex");
  return {
    idempotency_key: `autonomy-ide-ingress-${safePhase}-${digest.slice(0, 24)}`,
    side_effect_fingerprint: `autonomy-ide-ingress-${safePhase}-${digest.slice(24, 56)}`,
  };
}

function deriveTitle(objective: string) {
  const trimmed = objective.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 84) {
    return trimmed;
  }
  const shortened = trimmed.slice(0, 81).replace(/\s+\S*$/, "");
  return `${shortened || trimmed.slice(0, 81)}...`;
}

function sanitizeIdentifier(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function buildMemoryContent(input: {
  title: string;
  objective: string;
  session_id: string;
  thread_id: string | null;
  source_client: string;
  source_agent: string;
  tags: string[];
}) {
  const lines = [
    `IDE ingress objective: ${input.title}`,
    `Objective: ${input.objective.trim()}`,
    `Session: ${input.session_id}`,
    `Source client: ${input.source_client}`,
    `Source agent: ${input.source_agent}`,
  ];
  if (input.thread_id) {
    lines.push(`TriChat thread: ${input.thread_id}`);
  }
  if (input.tags.length > 0) {
    lines.push(`Tags: ${input.tags.join(", ")}`);
  }
  return lines.join("\n");
}

export async function autonomyIdeIngress(
  storage: Storage,
  invokeTool: InvokeTool,
  input: z.infer<typeof autonomyIdeIngressSchema>
) {
  return runIdempotentMutation({
    storage,
    tool_name: "autonomy.ide_ingress",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const sourceClient = input.source_client?.trim() || "codex.ide";
      const sourceAgent = input.source_agent?.trim() || "codex";
      const source = {
        source_client: sourceClient,
        source_model: input.source_model,
        source_agent: sourceAgent,
      };
      const title = input.title?.trim() || deriveTitle(input.objective);
      const tags = [...new Set(["autonomy", "ide", "ingress", ...dedupeStrings(input.tags)])];
      const sessionId =
        input.session_id?.trim() ||
        `ide-${sanitizeIdentifier(sourceClient || sourceAgent || "codex") || "codex"}-autonomy`;
      const mirrorToThread = input.mirror_to_thread ?? true;
      const threadId = mirrorToThread ? input.thread_id?.trim() || "trichat-autopilot-internal" : null;
      const threadTitle = input.thread_title?.trim() || "TriChat Autopilot";

      const transcript =
        input.append_transcript === false
          ? null
          : ((await invokeTool("transcript.append", {
              mutation: deriveMutation(input.mutation, "transcript.append"),
              session_id: sessionId,
              source_client: sourceClient,
              source_model: input.source_model,
              source_agent: sourceAgent,
              kind: "ide.objective",
              text: input.objective,
            })) as Record<string, unknown>);

      let thread: Record<string, unknown> | null = null;
      let message: Record<string, unknown> | null = null;
      let turn: Record<string, unknown> | null = null;

      if (threadId) {
        thread = (await invokeTool("trichat.thread_open", {
          mutation: deriveMutation(input.mutation, "trichat.thread_open"),
          thread_id: threadId,
          title: threadTitle,
          status: input.thread_status,
          metadata: {
            source: "autonomy.ide_ingress",
            ingress_session_id: sessionId,
            ingress_source_client: sourceClient,
            ingress_source_agent: sourceAgent,
            ...(input.thread_metadata ?? {}),
          },
        })) as Record<string, unknown>;

        message = (await invokeTool("trichat.message_post", {
          mutation: deriveMutation(input.mutation, "trichat.message_post"),
          thread_id: threadId,
          agent_id: "user",
          role: "user",
          content: input.objective,
          metadata: {
            source: "autonomy.ide_ingress",
            ingress_session_id: sessionId,
            ingress_title: title,
            ingress_tags: tags,
          },
        })) as Record<string, unknown>;

        if (input.start_trichat_turn ?? false) {
          const postedMessage = message.message as { message_id?: string } | undefined;
          if (postedMessage?.message_id) {
            turn = (await invokeTool("trichat.turn_start", {
              mutation: deriveMutation(input.mutation, "trichat.turn_start"),
              thread_id: threadId,
              user_message_id: postedMessage.message_id,
              user_prompt: input.objective,
              metadata: {
                source: "autonomy.ide_ingress",
                ingress_session_id: sessionId,
                ingress_title: title,
              },
            })) as Record<string, unknown>;
          }
        }
      }

      const autonomy = (await invokeTool("autonomy.command", {
        mutation: deriveMutation(input.mutation, "autonomy.command"),
        objective: input.objective,
        title,
        priority: input.priority,
        risk_tier: input.risk_tier,
        autonomy_mode: input.autonomy_mode,
        acceptance_criteria: input.acceptance_criteria,
        constraints: input.constraints,
        assumptions: input.assumptions,
        tags,
        metadata: {
          ingress_kind: "ide",
          ingress_session_id: sessionId,
          ingress_thread_id: threadId,
          ...(input.metadata ?? {}),
        },
        owner: input.owner,
        budget: input.budget,
        target_entity_type: input.target_entity_type,
        target_entity_id: input.target_entity_id,
        compile_objective: input.compile_objective,
        workstreams: input.workstreams,
        selected_plan: input.selected_plan,
        ensure_bootstrap: input.ensure_bootstrap,
        autostart_ring_leader: input.autostart_ring_leader,
        bootstrap_run_immediately: input.bootstrap_run_immediately,
        start_goal_autorun_daemon: input.start_goal_autorun_daemon,
        autorun_interval_seconds: input.autorun_interval_seconds,
        goal_scan_limit: input.goal_scan_limit,
        hook_name: input.hook_name,
        context_artifact_ids: input.context_artifact_ids,
        options: input.options,
        dispatch_limit: input.dispatch_limit,
        dry_run: input.dry_run,
        max_passes: input.max_passes,
        trichat_agent_ids: input.trichat_agent_ids,
        trichat_max_rounds: input.trichat_max_rounds,
        trichat_min_success_agents: input.trichat_min_success_agents,
        trichat_bridge_timeout_seconds: input.trichat_bridge_timeout_seconds,
        trichat_bridge_dry_run: input.trichat_bridge_dry_run,
        ...source,
      })) as Record<string, unknown>;

      const autonomyGoal = (autonomy.goal ?? null) as { goal_id?: string } | null;
      const autonomyPlan = (autonomy.plan ?? null) as { plan_id?: string } | null;

      const memory =
        input.append_memory === false
          ? null
          : ((await invokeTool("memory.append", {
              mutation: deriveMutation(input.mutation, "memory.append"),
              content: buildMemoryContent({
                title,
                objective: input.objective,
                session_id: sessionId,
                thread_id: threadId,
                source_client: sourceClient,
                source_agent: sourceAgent,
                tags,
              }),
              keywords: tags,
            })) as Record<string, unknown>);

      const event =
        input.publish_event === false
          ? null
          : ((await invokeTool("event.publish", {
              mutation: deriveMutation(input.mutation, "event.publish"),
              event_type: "autonomy.ide_ingress",
              entity_type: autonomyGoal?.goal_id ? "goal" : undefined,
              entity_id: autonomyGoal?.goal_id,
              status: "accepted",
              summary: `IDE objective accepted into autonomous execution: ${title}`,
              content: input.objective,
              details: {
                ingress_kind: "ide",
                session_id: sessionId,
                thread_id: threadId,
                title,
                goal_id: autonomyGoal?.goal_id ?? null,
                plan_id: autonomyPlan?.plan_id ?? null,
                mirrored_to_thread: Boolean(threadId),
                transcript_appended: input.append_transcript !== false,
                memory_recorded: input.append_memory !== false,
              },
              ...source,
            })) as Record<string, unknown>);

      return {
        ok: true,
        title,
        source,
        session_id: sessionId,
        thread_id: threadId,
        thread_title: threadId ? threadTitle : null,
        transcript,
        thread,
        message,
        turn,
        memory,
        event,
        autonomy,
      };
    },
  });
}
