import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { Storage } from "../storage.js";
import { assertSafeWritePath } from "../path_safety.js";
import { logEvent } from "../utils.js";
import { mutationSchema } from "./mutation.js";

export const adrCreateSchema = z.object({
  mutation: mutationSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  status: z.string().min(1).optional(),
});

export function createAdr(
  storage: Storage,
  input: z.infer<typeof adrCreateSchema>,
  repoRoot = process.cwd()
) {
  const adrDir = path.resolve(repoRoot, "docs", "adrs");
  fs.mkdirSync(adrDir, { recursive: true });

  const number = nextAdrNumber(adrDir);
  const adrId = `${String(number).padStart(4, "0")}-${slugify(input.title)}`;
  const status = input.status?.trim() || "proposed";
  const filePath = path.join(adrDir, `${adrId}.md`);
  const createdAt = new Date().toISOString();
  const markdown = renderAdrMarkdown({
    id: adrId,
    title: input.title.trim(),
    status,
    created_at: createdAt,
    content: input.content.trim(),
  });

  if (fs.existsSync(filePath)) {
    throw new Error(`ADR file already exists: ${filePath}`);
  }

  assertSafeWritePath(filePath, {
    repo_root: repoRoot,
    operation: "adr markdown write",
  });
  fs.writeFileSync(filePath, markdown, "utf8");
  try {
    storage.insertAdr({
      id: adrId,
      title: input.title.trim(),
      status,
      content: input.content.trim(),
    });
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }

  logEvent("adr.create", { ok: true, id: adrId, status, path: filePath });
  return {
    id: adrId,
    status,
    path: filePath,
    ok: true,
  };
}

function nextAdrNumber(adrDir: string): number {
  const entries = fs.existsSync(adrDir) ? fs.readdirSync(adrDir, { withFileTypes: true }) : [];
  let max = 0;
  const pattern = /^(\d{4})-[a-z0-9-]+\.md$/;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(pattern);
    if (!match) {
      continue;
    }
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function renderAdrMarkdown(params: {
  id: string;
  title: string;
  status: string;
  created_at: string;
  content: string;
}): string {
  return [
    `# ${params.id}: ${params.title}`,
    "",
    `- Status: ${params.status}`,
    `- Date: ${params.created_at}`,
    "",
    "## Content",
    params.content,
    "",
  ].join("\n");
}
