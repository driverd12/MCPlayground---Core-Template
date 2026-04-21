import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("runtime.worker session brief includes reasoning policy and grounded reflections from task metadata", async () => {
  const testId = `runtime-worker-reasoning-brief-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runtime-worker-reasoning-brief-"));
  const repoDir = path.join(tempDir, "runtime-brief-repo");
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  fs.mkdirSync(repoDir, { recursive: true });
  run("git init", repoDir);
  run("git config user.email 'codex@example.com'", repoDir);
  run("git config user.name 'Codex'", repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# runtime brief\n", "utf8");
  run("git add README.md", repoDir);
  run("git commit -m 'baseline'", repoDir);

  const { client } = await openClient(dbPath, {});
  try {
    const task = await callTool(client, "task.create", {
      mutation: nextMutation(testId, "task.create", () => mutationCounter++),
      objective: "Verify a bounded runtime-worker execution brief.",
      project_dir: repoDir,
      payload: {
        delegation_brief: {
          delegate_agent_id: "verification-director",
          task_objective: "Verify the runtime brief carries reasoning and reflection guidance.",
          success_criteria: ["session brief includes the expected reasoning guidance"],
          evidence_requirements: ["Show the session brief contents"],
          rollback_notes: ["Fail clearly instead of guessing if the runtime worker launch breaks"],
        },
      },
      task_execution: {
        runtime_id: "shell",
        runtime_strategy: "tmux_worktree",
        runtime_command: [
          "printf 'runtime-brief-ok\\n' > runtime-brief-proof.txt",
          "cat > .mcp-runtime/reasoning-evidence.json <<'JSON'",
          JSON.stringify({
            candidates: [
              { id: "candidate-a", verdict: "rejected", evidence: "did not check the generated brief" },
              { id: "candidate-b", verdict: "rejected", evidence: "checked only task metadata" },
              { id: "candidate-c", verdict: "rejected", evidence: "missed completion handoff evidence" },
              { id: "candidate-d", verdict: "selected", evidence: "checked brief and completion handoff" },
            ],
            selected_candidate_id: "candidate-d",
            selection_rationale: "Selected the path that verifies both runtime brief instructions and completion evidence handoff.",
            plan_summary: "Inspect the brief, write compact completion evidence, then let the wrapper report task completion.",
            verification_summary: "Created runtime-brief-proof.txt and reasoning-evidence.json in the runtime worktree.",
            checks: ["runtime-brief-proof.txt written", "reasoning-evidence.json written"],
          }),
          "JSON",
        ].join("\n"),
        task_kind: "verification",
        quality_preference: "quality",
        focus: "verification",
        reasoning_compute_policy: {
          mode: "adaptive_best_of_n",
          candidate_count: 4,
          max_candidate_count: 4,
          selection_strategy: "evidence_rerank",
          activation_reasons: ["verification_task", "quality_preference", "grounded_reflection_match"],
          evidence_required: true,
          transcript_policy: "compact_evidence_only",
        },
        require_plan_pass: true,
        require_verification_pass: true,
      },
      metadata: {
        org_program_signals: {
          explicit_evidence: true,
          fail_closed: true,
        },
        memory_preflight: {
          query: "verification brief reflections",
          strategy: "hybrid",
          match_count: 1,
          top_matches: [],
          reflection_match_count: 1,
          top_reflections: [
            {
              id: "reflection-brief-1",
              text_preview: "Earlier verification failed because the agent accepted a plausible answer without trying to falsify it.",
              keywords: ["reflection", "verification"],
            },
          ],
        },
        working_memory: {
          objective: "Verify the runtime brief carries reasoning, reflection, and compact state guidance.",
          goal_id: "runtime-worker-reasoning-brief",
          constraints: ["Stay inside the isolated runtime worktree"],
          success_criteria: ["session brief includes the expected reasoning guidance"],
          expected_evidence: [
            "Show the session brief contents",
            "Create runtime-brief-proof.txt",
            "Write compact reasoning-evidence.json",
          ],
          rollback_notes: ["Fail clearly instead of guessing if the runtime worker launch breaks"],
          unresolved_questions: ["Confirm the generated brief renders working memory before task completion."],
          known_failures: [
            {
              id: "reflection-brief-1",
              text_preview: "Earlier verification failed because the agent accepted a plausible answer without trying to falsify it.",
              keywords: ["reflection", "verification"],
            },
          ],
          current_plan: [
            {
              stream_id: "verification",
              title: "Verify runtime brief handoff",
              owner_role_id: "verification-director",
              step_kind: "verification",
              depends_on: [],
              evidence_requirements: ["Show the session brief contents"],
            },
          ],
          current_stream_id: "verification",
          current_owner_role_id: "verification-director",
          current_stream_title: "Verify runtime brief handoff",
          memory_citations: [{ source: "memory", id: "reflection-brief-1" }],
          compression_policy:
            "Use this compact state first; retrieve cited memory only if a decision needs more context.",
          generated_at: new Date().toISOString(),
        },
      },
    });

    const spawned = await callTool(client, "runtime.worker", {
      action: "spawn_task",
      mutation: nextMutation(testId, "runtime.worker.spawn_task", () => mutationCounter++),
      task_id: task.task.task_id,
      runtime_id: "shell",
      runtime_strategy: "tmux_worktree",
    });

    assert.equal(spawned.created, true);
    const runtimeStatus = await waitFor(async () => {
      const status = await callTool(client, "runtime.worker", { action: "status", limit: 20 });
      return status.sessions.find((entry) => entry.task_id === task.task.task_id) ?? null;
    });
    assert.ok(runtimeStatus);
    assert.equal(fs.existsSync(runtimeStatus.brief_path), true);
    const sessionBrief = fs.readFileSync(runtimeStatus.brief_path, "utf8");
    assert.match(sessionBrief, /Reasoning policy/);
    assert.match(sessionBrief, /Adaptive compute policy: best-of-N with 4 candidate/i);
    assert.match(sessionBrief, /Activation reasons: verification_task, quality_preference, grounded_reflection_match/i);
    assert.match(sessionBrief, /Generate 4 bounded candidate approaches or failure hypotheses/i);
    assert.match(sessionBrief, /Rerank candidate paths by concrete evidence and contradiction risk/i);
    assert.match(sessionBrief, /Try to falsify the current answer with concrete checks before declaring success/i);
    assert.match(sessionBrief, /Write a short plan first so unknowns, evidence needs, and rollback are explicit before mutation/i);
    assert.match(sessionBrief, /Choose the path with the strongest evidence trail/i);
    assert.match(sessionBrief, /If evidence is weak or contradictory, stop and report the blocker/i);
    assert.match(sessionBrief, /Keep reasoning evidence compact/i);
    assert.match(sessionBrief, /Grounded reflections/);
    assert.match(sessionBrief, /accepted a plausible answer without trying to falsify it/i);
    assert.match(sessionBrief, /Working memory/);
    assert.match(sessionBrief, /Use compact state first/i);
    assert.match(sessionBrief, /Current lane: verification owned by verification-director/i);
    assert.match(sessionBrief, /Expected evidence: .*runtime-brief-proof\.txt/i);
    assert.match(sessionBrief, /Unresolved questions: .*renders working memory/i);
    assert.match(sessionBrief, /Known failure memory:reflection-brief-1/i);
    assert.match(sessionBrief, /Completion evidence handoff/);
    assert.match(sessionBrief, /reasoning-evidence\.json/);
    assert.match(sessionBrief, /Include candidates or candidate_count showing at least 4 bounded candidates/i);
    assert.match(sessionBrief, /Include selected_candidate_id plus selection_rationale/i);

    const completedTask = await waitFor(async () => {
      const completed = await callTool(client, "task.list", { status: "completed", limit: 20 });
      return completed.tasks.find((entry) => entry.task_id === task.task.task_id) ?? null;
    }, 30000);
    assert.equal(completedTask.result.reasoning_policy_audit.status, "satisfied");
    assert.equal(completedTask.result.reasoning_policy_audit.observed_candidate_count, 4);
    assert.equal(completedTask.result.reasoning_policy_audit.required_candidate_count, 4);
    assert.deepEqual(completedTask.result.reasoning_policy_audit.missing_fields, []);
    assert.equal(completedTask.result.reasoning_policy_audit.selection.selected_candidate_id, "candidate-d");
    assert.equal(completedTask.result.reasoning_policy_audit.selection.selected_candidate_has_evidence, true);
    assert.equal(completedTask.result.reasoning_policy_evidence.candidates.length, 4);
    assert.match(completedTask.result.reasoning_policy_evidence.selection_rationale, /brief instructions and completion evidence/i);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function waitFor(fn, timeoutMs = 20000, delayMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function run(command, cwd) {
  execFileSync("zsh", ["-lc", command], { cwd, stdio: "pipe" });
}

async function openClient(dbPath, extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_AGENT_IDS: "",
      ...extraEnv,
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-runtime-worker-reasoning-brief-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return { client };
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `${testId}-${safeToolName}-${index}`,
  };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
