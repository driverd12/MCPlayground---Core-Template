import crypto from "node:crypto";
import { z } from "zod";
import {
  Storage,
  type OrgProgramRoleRecord,
  type OrgProgramVersionRecord,
  type OrgProgramsStateRecord,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const orgProgramVersionSchema = z.object({
  version_id: z.string().min(1).optional(),
  summary: z.string().min(1),
  doctrine: z.string().min(1),
  delegation_contract: z.string().min(1),
  evaluation_standard: z.string().min(1),
  status: z.enum(["candidate", "active", "archived"]).optional(),
  metadata: recordSchema.optional(),
});

export const orgProgramSchema = z
  .object({
    action: z.enum(["status", "upsert_role", "promote_version", "rollback_role"]).default("status"),
    mutation: mutationSchema.optional(),
    role_id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    lane: z.string().min(1).optional(),
    version: orgProgramVersionSchema.optional(),
    version_id: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for org-program writes",
        path: ["mutation"],
      });
    }
    if (value.action === "upsert_role" && (!value.role_id?.trim() || !value.title?.trim() || !value.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "role_id, title, and version are required for upsert_role",
        path: ["role_id"],
      });
    }
    if ((value.action === "promote_version" || value.action === "rollback_role") && (!value.role_id?.trim() || !value.version_id?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "role_id and version_id are required",
        path: ["version_id"],
      });
    }
  });

export function loadOrgPrograms(storage: Storage): OrgProgramsStateRecord {
  return (
    storage.getOrgProgramsState() ?? {
      enabled: true,
      roles: [],
      updated_at: new Date().toISOString(),
    }
  );
}

function normalizeVersion(version: OrgProgramVersionRecord): OrgProgramVersionRecord {
  return {
    version_id: version.version_id.trim(),
    created_at: version.created_at,
    summary: version.summary.trim(),
    doctrine: version.doctrine.trim(),
    delegation_contract: version.delegation_contract.trim(),
    evaluation_standard: version.evaluation_standard.trim(),
    status: version.status === "active" || version.status === "archived" ? version.status : "candidate",
    metadata: version.metadata ?? {},
  };
}

export type OrgProgramSignals = {
  bounded_execution: boolean;
  explicit_evidence: boolean;
  rollback_ready: boolean;
  local_first: boolean;
  parallel_delegation: boolean;
  specialist_routing: boolean;
  fail_closed: boolean;
  verification_first: boolean;
};

function normalizeSignalsText(version: Pick<OrgProgramVersionRecord, "doctrine" | "delegation_contract" | "evaluation_standard"> | null) {
  if (!version) {
    return "";
  }
  return `${version.doctrine}\n${version.delegation_contract}\n${version.evaluation_standard}`.toLowerCase();
}

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function deriveOrgProgramSignals(
  version: Pick<OrgProgramVersionRecord, "doctrine" | "delegation_contract" | "evaluation_standard"> | null
): OrgProgramSignals {
  const text = normalizeSignalsText(version);
  return {
    bounded_execution: includesAny(text, [/\bbounded\b/, /\bnarrow\b/, /smallest safe/, /single owner/, /\bnon-overlapping\b/]),
    explicit_evidence: includesAny(text, [/\bevidence\b/, /\bproof\b/, /\breproducible\b/, /\bvalidation\b/, /\bartifact\b/]),
    rollback_ready: includesAny(text, [/\brollback\b/, /\breversible\b/, /\brevert\b/]),
    local_first: includesAny(text, [/\blocal-first\b/, /\bprefer local\b/, /\blocal execution\b/, /\bon-device\b/]),
    parallel_delegation: includesAny(text, [/\bparallel\b/, /delegation batch/, /\bbatch\b/, /\bmultiple leaf\b/]),
    specialist_routing: includesAny(text, [/\bspecialist\b/, /\bsubject matter\b/, /\bdomain\b/, /\bleaf\b/, /\bdirector\b/]),
    fail_closed: includesAny(text, [/\bfail closed\b/, /\bescalat\b/, /\bstop when confidence\b/, /\bweak confidence\b/]),
    verification_first: includesAny(text, [/\bverify\b/, /\bverification\b/, /\bacceptance\b/, /\bcheck\b/, /\bgate\b/]),
  };
}

export function getEffectiveOrgProgramSignals(storage: Storage, roleId: string) {
  const effective = getEffectiveOrgProgram(storage, roleId);
  return deriveOrgProgramSignals(effective?.version ?? null);
}

export function upsertVersion(role: OrgProgramRoleRecord, version: OrgProgramVersionRecord) {
  const versions = role.versions.filter((entry) => entry.version_id !== version.version_id).concat([version]).sort((left, right) =>
    left.created_at.localeCompare(right.created_at)
  );
  const activeVersionId =
    version.status === "active"
      ? version.version_id
      : role.active_version_id && versions.some((entry) => entry.version_id === role.active_version_id)
        ? role.active_version_id
        : versions.find((entry) => entry.status === "active")?.version_id ?? null;
  return {
    ...role,
    active_version_id: activeVersionId,
    versions: versions.map((entry) =>
      entry.version_id === activeVersionId ? { ...entry, status: "active" as const } : entry.status === "active" ? { ...entry, status: "candidate" as const } : entry
    ),
  } satisfies OrgProgramRoleRecord;
}

export function getEffectiveOrgProgram(storage: Storage, roleId: string) {
  const state = loadOrgPrograms(storage);
  const role = state.roles.find((entry) => entry.role_id === roleId);
  if (!role) {
    return null;
  }
  const version =
    role.versions.find((entry) => entry.version_id === role.active_version_id) ??
    role.versions.find((entry) => entry.status === "active") ??
    role.versions[role.versions.length - 1] ??
    null;
  if (!version) {
    return null;
  }
  return {
    role,
    version,
  };
}

export async function orgProgram(storage: Storage, input: z.infer<typeof orgProgramSchema>) {
  if (input.action === "status") {
    const state = loadOrgPrograms(storage);
    return {
      state,
      role_count: state.roles.length,
      active_version_count: state.roles.filter((role) => role.active_version_id).length,
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "org.program",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const state = loadOrgPrograms(storage);
      if (input.action === "upsert_role") {
        const now = new Date().toISOString();
        const version: OrgProgramVersionRecord = normalizeVersion({
          version_id: input.version!.version_id?.trim() || `org-version-${crypto.randomUUID()}`,
          created_at: now,
          summary: input.version!.summary,
          doctrine: input.version!.doctrine,
          delegation_contract: input.version!.delegation_contract,
          evaluation_standard: input.version!.evaluation_standard,
          status: input.version!.status ?? "candidate",
          metadata: input.version!.metadata ?? {},
        });
        const existingRole =
          state.roles.find((entry) => entry.role_id === input.role_id) ??
          ({
            role_id: input.role_id!,
            title: input.title!,
            description: input.description?.trim() || null,
            lane: input.lane?.trim() || null,
            active_version_id: null,
            versions: [],
            metadata: {},
            updated_at: now,
          } satisfies OrgProgramRoleRecord);
        const nextRole = upsertVersion(
          {
            ...existingRole,
            title: input.title!.trim(),
            description: input.description?.trim() || existingRole.description || null,
            lane: input.lane?.trim() || existingRole.lane || null,
            updated_at: now,
          },
          version
        );
        const roles = state.roles.filter((entry) => entry.role_id !== nextRole.role_id).concat([nextRole]);
        return {
          state: storage.setOrgProgramsState({
            enabled: input.enabled ?? state.enabled,
            roles,
          }),
          role: nextRole,
        };
      }

      const role = state.roles.find((entry) => entry.role_id === input.role_id);
      if (!role) {
        throw new Error(`Unknown org role: ${input.role_id}`);
      }
      const version = role.versions.find((entry) => entry.version_id === input.version_id);
      if (!version) {
        throw new Error(`Unknown org role version: ${input.version_id}`);
      }

      const nextRole: OrgProgramRoleRecord =
        input.action === "promote_version"
          ? {
              ...role,
              active_version_id: version.version_id,
              versions: role.versions.map((entry) =>
                entry.version_id === version.version_id ? { ...entry, status: "active" as const } : entry.status === "active" ? { ...entry, status: "candidate" as const } : entry
              ),
              updated_at: new Date().toISOString(),
            }
          : {
              ...role,
              active_version_id: version.version_id,
              versions: role.versions.map((entry) =>
                entry.version_id === version.version_id ? { ...entry, status: "active" as const } : entry
              ),
              updated_at: new Date().toISOString(),
            };

      const roles = state.roles.filter((entry) => entry.role_id !== role.role_id).concat([nextRole]);
      return {
        state: storage.setOrgProgramsState({
          enabled: input.enabled ?? state.enabled,
          roles,
        }),
        role: nextRole,
      };
    },
  });
}
