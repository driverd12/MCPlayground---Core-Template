import { z } from "zod";
import { mutationSchema } from "./mutation.js";

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const dispatchAutorunSchema = z.object({
  mutation: mutationSchema,
  plan_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  max_passes: z.number().int().min(1).max(20).optional(),
  dry_run: z.boolean().optional(),
  trichat_agent_ids: z.array(z.string().min(1)).max(50).optional(),
  trichat_max_rounds: z.number().int().min(1).max(10).optional(),
  trichat_min_success_agents: z.number().int().min(1).max(10).optional(),
  trichat_bridge_timeout_seconds: z.number().int().min(5).max(1800).optional(),
  trichat_bridge_dry_run: z.boolean().optional(),
  ...sourceSchema.shape,
});
