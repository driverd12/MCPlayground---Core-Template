#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

export IMPRINT_TRANSPORT="${IMPRINT_TRANSPORT:-stdio}"
export IMPRINT_URL="${IMPRINT_URL:-http://127.0.0.1:8787/}"
export IMPRINT_ORIGIN="${IMPRINT_ORIGIN:-http://127.0.0.1}"
export IMPRINT_STDIO_COMMAND="${IMPRINT_STDIO_COMMAND:-node}"
export IMPRINT_STDIO_ARGS="${IMPRINT_STDIO_ARGS:-dist/server.js}"

export ANAMNESIS_IMPRINT_PROFILE_ID="${ANAMNESIS_IMPRINT_PROFILE_ID:-default}"
export ANAMNESIS_IMPRINT_TITLE="${ANAMNESIS_IMPRINT_TITLE:-Dan Driver Imprint}"
export ANAMNESIS_IMPRINT_MISSION="${ANAMNESIS_IMPRINT_MISSION:-Reduce friction between thought and execution while preserving local-first continuity.}"
export ANAMNESIS_IMPRINT_PRINCIPLES="${ANAMNESIS_IMPRINT_PRINCIPLES:-Local-first by default|Idempotent mutations only|No stdout operational logging|Prefer deterministic execution paths}"
export ANAMNESIS_IMPRINT_CONSTRAINTS="${ANAMNESIS_IMPRINT_CONSTRAINTS:-Do not exfiltrate local data|Use only approved local/runtime tools|Preserve tool-side safety checks}"

if [[ "${IMPRINT_TRANSPORT}" == "http" ]] && [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
  echo "error: MCP_HTTP_BEARER_TOKEN is required when IMPRINT_TRANSPORT=http" >&2
  exit 2
fi

node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transportMode = process.env.IMPRINT_TRANSPORT ?? "stdio";
const profileId = process.env.ANAMNESIS_IMPRINT_PROFILE_ID ?? "default";
const title = process.env.ANAMNESIS_IMPRINT_TITLE ?? "Local Imprint";
const mission = process.env.ANAMNESIS_IMPRINT_MISSION ?? "Preserve local continuity";
const principles = (process.env.ANAMNESIS_IMPRINT_PRINCIPLES ?? "")
  .split("|")
  .map((v) => v.trim())
  .filter(Boolean);
const constraints = (process.env.ANAMNESIS_IMPRINT_CONSTRAINTS ?? "")
  .split("|")
  .map((v) => v.trim())
  .filter(Boolean);

const transport =
  transportMode === "http"
    ? new StreamableHTTPClientTransport(new URL(process.env.IMPRINT_URL), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.MCP_HTTP_BEARER_TOKEN}`,
            Origin: process.env.IMPRINT_ORIGIN,
          },
        },
      })
    : new StdioClientTransport({
        command: process.env.IMPRINT_STDIO_COMMAND ?? "node",
        args: (process.env.IMPRINT_STDIO_ARGS ?? "dist/server.js").split(/\s+/).filter(Boolean),
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
      });

const client = new Client(
  { name: "mcplayground-imprint-bootstrap", version: "0.1.0" },
  { capabilities: {} }
);

let mutationCounter = 0;
const mutation = (toolName) => {
  const idx = mutationCounter++;
  const safe = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const run = Date.now();
  return {
    idempotency_key: `imprint-${run}-${safe}-${idx}`,
    side_effect_fingerprint: `imprint-fingerprint-${run}-${safe}-${idx}`,
  };
};

const extractText = (response) =>
  (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

const callTool = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

try {
  await client.connect(transport);

  const profile = await callTool("imprint.profile_set", {
    mutation: mutation("imprint.profile_set"),
    profile_id: profileId,
    title,
    mission,
    principles: principles.length ? principles : ["Local-first continuity"],
    hard_constraints: constraints,
    preferred_models: ["llama3.2:3b"],
    project_roots: [process.cwd()],
    source_client: "imprint_bootstrap.sh",
  });

  const snapshot = await callTool("imprint.snapshot", {
    mutation: mutation("imprint.snapshot"),
    profile_id: profileId,
    summary: "manual imprint bootstrap",
    tags: ["bootstrap", "manual"],
    include_recent_memories: 25,
    include_recent_transcript_lines: 50,
    write_file: true,
    promote_summary: true,
    source_client: "imprint_bootstrap.sh",
  });

  const bootstrap = await callTool("imprint.bootstrap", {
    profile_id: profileId,
    max_memories: 20,
    max_transcript_lines: 30,
    max_snapshots: 5,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: transportMode,
        profile_id: profile.profile_id,
        profile_updated_at: profile.updated_at,
        snapshot_id: snapshot.snapshot_id,
        snapshot_path: snapshot.snapshot_path,
        snapshot_memory_id: snapshot.memory_id,
        bootstrap_preview: String(bootstrap.bootstrap_text ?? "").split("\n").slice(0, 20).join("\n"),
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
}
NODE
