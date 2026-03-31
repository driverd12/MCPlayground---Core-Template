import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

export const storageBackupsSchema = z
  .object({
    action: z.enum(["status", "prune"]).default("status"),
    mutation: mutationSchema.optional(),
    recent_limit: z.number().int().min(1).max(100).optional(),
    keep: z.number().int().min(1).max(500).optional(),
    max_total_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    temp_max_age_seconds: z.number().int().min(0).max(604800).optional(),
    dry_run: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "prune" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for prune",
        path: ["mutation"],
      });
    }
  });

export function storageBackups(storage: Storage, input: z.infer<typeof storageBackupsSchema>) {
  if (input.action === "status") {
    return {
      ok: true,
      ...storage.getStorageBackupStatus({
        recent_limit: input.recent_limit,
      }),
    };
  }
  return runIdempotentMutation({
    storage,
    tool_name: "storage.backups",
    mutation: input.mutation!,
    payload: input,
    execute: () => ({
      ok: true,
      ...storage.pruneStorageBackups({
        keep: input.keep,
        max_total_bytes: input.max_total_bytes,
        dry_run: input.dry_run,
        temp_max_age_seconds: input.temp_max_age_seconds,
      }),
      status: storage.getStorageBackupStatus({
        recent_limit: input.recent_limit,
      }),
    }),
  });
}
