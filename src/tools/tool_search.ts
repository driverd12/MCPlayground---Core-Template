import { z } from "zod";
import { searchToolCatalog, summarizeToolCatalog, type ToolCatalogEntry } from "../control_plane.js";

export const toolSearchSchema = z.object({
  query: z.string().min(1).optional(),
  capability_area: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export function toolSearch(input: z.infer<typeof toolSearchSchema>, listTools: () => ToolCatalogEntry[]) {
  const entries = listTools();
  const result = searchToolCatalog({
    query: input.query,
    capability_area: input.capability_area,
    tags: input.tags,
    limit: input.limit,
  });
  return {
    ...result,
    available_catalog: summarizeToolCatalog(entries),
    source: "tool.search",
  };
}
