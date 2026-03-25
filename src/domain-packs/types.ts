import { z } from "zod";
import { Storage } from "../storage.js";
import { runIdempotentMutation } from "../tools/mutation.js";

export type PackToolHandler = (input: any) => Promise<unknown> | unknown;

export type PackToolRegistrar = (
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  handler: PackToolHandler
) => void;

export type PackHookTarget = {
  entity_type: string;
  entity_id: string;
  goal_id?: string;
  artifact_ids?: string[];
};

export type PackPlannerStep = {
  step_id?: string;
  title: string;
  step_kind: "analysis" | "mutation" | "verification" | "decision" | "handoff";
  executor_kind?: "tool" | "task" | "worker" | "human" | "trichat";
  executor_ref?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  depends_on?: string[];
  expected_artifact_types?: string[];
  acceptance_checks?: string[];
  timeout_seconds?: number;
  metadata?: Record<string, unknown>;
};

export type PackPlannerHookResult = {
  summary: string;
  confidence?: number;
  assumptions?: string[];
  success_criteria?: string[];
  rollback?: string[];
  metadata?: Record<string, unknown>;
  steps: PackPlannerStep[];
};

export type PackVerifierHookResult = {
  summary: string;
  pass: boolean;
  score?: number;
  checks?: Array<{
    name: string;
    pass: boolean;
    severity?: "info" | "warn" | "error";
    details?: string;
  }>;
  produced_artifacts?: Array<{
    artifact_type: string;
    content_text?: string;
    content_json?: Record<string, unknown>;
    uri?: string;
    trust_tier?: "raw" | "derived" | "verified" | "policy-backed" | "deprecated";
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
};

export type DomainPackPlannerHook = {
  hook_name: string;
  title: string;
  description?: string;
  target_types: string[];
  plan: (input: {
    storage: Storage;
    target: PackHookTarget;
    options?: Record<string, unknown>;
  }) => Promise<PackPlannerHookResult> | PackPlannerHookResult;
};

export type DomainPackVerifierHook = {
  hook_name: string;
  title: string;
  description?: string;
  target_types: string[];
  verify: (input: {
    storage: Storage;
    target: PackHookTarget;
    artifact_ids?: string[];
    expectations?: Record<string, unknown>;
  }) => Promise<PackVerifierHookResult> | PackVerifierHookResult;
};

export type DomainPackContext = {
  storage: Storage;
  repo_root: string;
  server_name: string;
  server_version: string;
  register_tool: PackToolRegistrar;
  register_planner_hook: (hook: DomainPackPlannerHook) => void;
  register_verifier_hook: (hook: DomainPackVerifierHook) => void;
  run_idempotent_mutation: typeof runIdempotentMutation;
};

export type DomainPackRegistrationContext = Omit<
  DomainPackContext,
  "register_planner_hook" | "register_verifier_hook"
> & {
  register_planner_hook: (pack_id: string, hook: DomainPackPlannerHook) => void;
  register_verifier_hook: (pack_id: string, hook: DomainPackVerifierHook) => void;
};

export type DomainPack = {
  id: string;
  title: string;
  description: string;
  register: (context: DomainPackContext) => void;
};

export type DomainPackRegistrationResult = {
  requested: string[];
  registered: string[];
  unknown: string[];
};
