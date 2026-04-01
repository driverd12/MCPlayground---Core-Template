import { z } from "zod";
import {
  summarizeFeatureFlags,
  summarizePermissionProfiles,
} from "../control_plane.js";
import {
  buildBudgetUsageFromBudget,
  evaluateFeatureFlagForStorage,
  recordBudgetLedgerUsage,
  resolvePermissionProfileChain,
} from "../control_plane_runtime.js";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const permissionProfileIdSchema = z.enum(["read_only", "bounded_execute", "network_enabled", "high_risk"]);
const featureFlagIdSchema = z.enum([
  "control_plane.permission_profiles",
  "control_plane.budget_ledger",
  "control_plane.warm_cache",
  "operator.tool_discovery",
  "provider.bridge.prefetch",
  "operator.rollout_plane",
]);

export const budgetUsageSchema = z.object({
  provider: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  tokens_input: z.number().int().min(0).optional(),
  tokens_output: z.number().int().min(0).optional(),
  tokens_total: z.number().int().min(0).optional(),
  projected_cost_usd: z.number().min(0).optional(),
  actual_cost_usd: z.number().min(0).optional(),
  currency: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const permissionProfilePatchSchema = z.object({
  profile_id: permissionProfileIdSchema,
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  rank: z.number().int().min(1).max(10).optional(),
  allow_read: z.boolean().optional(),
  allow_write: z.boolean().optional(),
  allow_execute: z.boolean().optional(),
  allow_network: z.boolean().optional(),
  max_risk_tier: z.enum(["low", "medium", "high", "critical"]).optional(),
  requires_human_approval: z.boolean().optional(),
  allowed_tool_prefixes: z.array(z.string().min(1)).optional(),
  blocked_tool_prefixes: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
});

export const permissionProfileSchema = z
  .object({
    action: z.enum(["status", "set", "resolve"]).default("status"),
    mutation: mutationSchema.optional(),
    default_profile: permissionProfileIdSchema.optional(),
    profiles: z.array(permissionProfilePatchSchema).optional(),
    goal_id: z.string().min(1).optional(),
    plan_id: z.string().min(1).optional(),
    step_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "set" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=set",
        path: ["mutation"],
      });
    }
  });

const featureFlagPatchSchema = z.object({
  flag_id: featureFlagIdSchema,
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  component: z.enum(["control_plane", "operator", "provider", "autonomy"]).optional(),
  rollout_mode: z.enum(["enabled", "disabled", "percentage", "allow_list"]).optional(),
  rollout_percentage: z.number().min(0).max(100).optional(),
  allow_entities: z.array(z.string().min(1)).optional(),
});

export const featureFlagSchema = z
  .object({
    action: z.enum(["status", "set", "evaluate"]).default("status"),
    mutation: mutationSchema.optional(),
    flags: z.array(featureFlagPatchSchema).optional(),
    flag_id: featureFlagIdSchema.optional(),
    entity_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "set" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=set",
        path: ["mutation"],
      });
    }
    if (value.action === "evaluate" && !value.flag_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "flag_id is required for action=evaluate",
        path: ["flag_id"],
      });
    }
  });

export const budgetLedgerSchema = z
  .object({
    action: z.enum(["summary", "list", "record"]).default("summary"),
    mutation: mutationSchema.optional(),
    ledger_kind: z.enum(["projection", "actual", "adjustment"]).optional(),
    goal_id: z.string().min(1).optional(),
    plan_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model_id: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    recent_limit: z.number().int().min(1).max(100).optional(),
    usage: budgetUsageSchema.optional(),
    notes: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
    source_client: z.string().optional(),
    source_model: z.string().optional(),
    source_agent: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "record" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=record",
        path: ["mutation"],
      });
    }
  });

function mergePermissionProfilePatches(storage: Storage, patches: z.infer<typeof permissionProfilePatchSchema>[]) {
  const existing = storage.getPermissionProfilesState();
  const byId = new Map(existing.profiles.map((entry) => [entry.profile_id, entry]));
  for (const patch of patches) {
    const current = byId.get(patch.profile_id);
    if (!current) {
      continue;
    }
    byId.set(patch.profile_id, {
      ...current,
      ...patch,
      allowed_tool_prefixes: patch.allowed_tool_prefixes ?? current.allowed_tool_prefixes,
      blocked_tool_prefixes: patch.blocked_tool_prefixes ?? current.blocked_tool_prefixes,
      tags: patch.tags ?? current.tags,
    });
  }
  return [...byId.values()];
}

function mergeFeatureFlagPatches(storage: Storage, patches: z.infer<typeof featureFlagPatchSchema>[]) {
  const existing = storage.getFeatureFlagState();
  const byId = new Map(existing.flags.map((entry) => [entry.flag_id, entry]));
  for (const patch of patches) {
    const current = byId.get(patch.flag_id);
    if (!current) {
      continue;
    }
    byId.set(patch.flag_id, {
      ...current,
      ...patch,
      allow_entities: patch.allow_entities ?? current.allow_entities,
    });
  }
  return [...byId.values()];
}

export function permissionProfileControl(storage: Storage, input: z.infer<typeof permissionProfileSchema>) {
  if (input.action === "status") {
    const state = storage.getPermissionProfilesState();
    return {
      state,
      summary: summarizePermissionProfiles({ state }),
      source: "permission.profile",
    };
  }

  if (input.action === "resolve") {
    const resolved = resolvePermissionProfileChain(storage, {
      goal_id: input.goal_id,
      plan_id: input.plan_id,
      step_id: input.step_id,
      task_id: input.task_id,
      session_id: input.session_id,
    });
    return {
      ...resolved,
      summary: summarizePermissionProfiles({
        state: resolved.state,
        session_profile_ids: resolved.chain.session_declared ? [resolved.chain.session_declared] : [],
        task_profile_ids: resolved.chain.task_declared ? [resolved.chain.task_declared] : [],
      }),
      source: "permission.profile",
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "permission.profile",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const state = storage.setPermissionProfilesState({
        default_profile: input.default_profile,
        profiles: input.profiles?.length ? mergePermissionProfilePatches(storage, input.profiles) : undefined,
      });
      return {
        state,
        summary: summarizePermissionProfiles({ state }),
        source: "permission.profile",
      };
    },
  });
}

export function featureFlagControl(storage: Storage, input: z.infer<typeof featureFlagSchema>) {
  if (input.action === "status") {
    const state = storage.getFeatureFlagState();
    return {
      state,
      summary: summarizeFeatureFlags(state),
      source: "feature.flag",
    };
  }

  if (input.action === "evaluate") {
    const evaluation = evaluateFeatureFlagForStorage(storage, input.flag_id!, {
      entity_id: input.entity_id,
      agent_id: input.agent_id,
      thread_id: input.thread_id,
      tags: input.tags,
    });
    return {
      evaluation,
      summary: summarizeFeatureFlags(storage.getFeatureFlagState()),
      source: "feature.flag",
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "feature.flag",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const state = storage.setFeatureFlagState({
        flags: input.flags?.length ? mergeFeatureFlagPatches(storage, input.flags) : undefined,
      });
      return {
        state,
        summary: summarizeFeatureFlags(state),
        source: "feature.flag",
      };
    },
  });
}

export function budgetLedgerControl(storage: Storage, input: z.infer<typeof budgetLedgerSchema>) {
  if (input.action === "summary") {
    return {
      summary: storage.summarizeBudgetLedger({
        ledger_kind: input.ledger_kind,
        run_id: input.run_id,
        task_id: input.task_id,
        provider: input.provider,
        model_id: input.model_id,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        since: input.since,
        recent_limit: input.recent_limit,
      }),
      source: "budget.ledger",
    };
  }

  if (input.action === "list") {
    const entries = storage.listBudgetLedgerEntries({
      ledger_kind: input.ledger_kind,
      run_id: input.run_id,
      task_id: input.task_id,
      provider: input.provider,
      model_id: input.model_id,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      since: input.since,
      limit: input.limit ?? 50,
    });
    return {
      count: entries.length,
      entries,
      summary: storage.summarizeBudgetLedger({
        ledger_kind: input.ledger_kind,
        run_id: input.run_id,
        task_id: input.task_id,
        provider: input.provider,
        model_id: input.model_id,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        since: input.since,
        recent_limit: Math.min(input.limit ?? 50, 10),
      }),
      source: "budget.ledger",
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "budget.ledger",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const fallbackUsage = buildBudgetUsageFromBudget({
        budget: input.metadata,
        metadata: input.metadata,
        provider: input.provider,
        model_id: input.model_id,
        notes: input.notes,
      });
      const entry = recordBudgetLedgerUsage(storage, {
        ledger_kind: input.ledger_kind,
        usage: input.usage ?? fallbackUsage,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        goal_id: input.goal_id,
        plan_id: input.plan_id,
        task_id: input.task_id,
        run_id: input.run_id,
        session_id: input.session_id,
        provider: input.provider,
        model_id: input.model_id,
        notes: input.notes,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        recorded: Boolean(entry),
        entry,
        summary: storage.summarizeBudgetLedger({
          run_id: input.run_id,
          task_id: input.task_id,
          provider: input.provider,
          model_id: input.model_id,
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          recent_limit: 5,
        }),
        source: "budget.ledger",
      };
    },
  });
}
