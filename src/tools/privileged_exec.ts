import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { summarizePrivilegedAccessState } from "../privileged_access_plane.js";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const privilegedExecScriptPath = path.join(repoRoot, "scripts", "privileged_exec.py");

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const privilegedExecSchema = z
  .object({
    action: z.enum(["status", "execute"]).default("status"),
    mutation: mutationSchema.optional(),
    command: z.string().min(1).max(400).optional(),
    args: z.array(z.string().max(4000)).max(256).optional(),
    cwd: z.string().min(1).max(2000).optional(),
    timeout_ms: z.number().int().min(500).max(600000).default(120000),
    env: z.record(z.string().max(4000)).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "execute" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for action=execute",
        path: ["mutation"],
      });
    }
    if (value.action === "execute" && !value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required for action=execute",
        path: ["command"],
      });
    }
  });

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactText(value: string, limit = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function commandExists(command: string) {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 30000,
    env: options.env ?? process.env,
    cwd: repoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function actorLabel(input: z.infer<typeof privilegedExecSchema>) {
  return String(input.source_agent || input.source_client || "operator").trim() || "operator";
}

function secretPathExists(secretPath: string) {
  try {
    return fs.statSync(secretPath).isFile();
  } catch {
    return false;
  }
}

function accountExists(account: string) {
  if (process.env.MCP_PRIVILEGED_EXEC_TEST_ACCOUNT_EXISTS === "1") {
    return true;
  }
  return runCommand("id", [account]).ok;
}

function helperReady() {
  if (process.env.MCP_PRIVILEGED_EXEC_DRY_RUN === "1") {
    return true;
  }
  return commandExists("python3") && fs.existsSync(privilegedExecScriptPath);
}

function readLocalSecret(secretPath: string) {
  const override = readString(process.env.MCP_PRIVILEGED_EXEC_TEST_SECRET);
  if (override) {
    return override;
  }
  if (!secretPathExists(secretPath)) {
    return null;
  }
  const raw = fs.readFileSync(secretPath, "utf8").trim();
  return raw.length > 0 ? raw : null;
}

function buildCommandExcerpt(command: string, args: string[]) {
  return compactText([command, ...args].join(" "), 220);
}

export function buildPrivilegedAccessStatus(storage: Storage) {
  const state = storage.getPrivilegedAccessState();
  const patientZeroState = storage.getPatientZeroState();
  const secretPresent = Boolean(readLocalSecret(state.secret_path));
  const summary = summarizePrivilegedAccessState(state, {
    patient_zero_armed: patientZeroState.enabled,
    user_exists: accountExists(state.account),
    secret_present: secretPresent,
    helper_ready: helperReady(),
  });
  return {
    state,
    summary,
    source: "privileged.exec",
  };
}

function appendPrivilegedEvent(
  storage: Storage,
  input: z.infer<typeof privilegedExecSchema>,
  eventType: string,
  status: string,
  summary: string,
  details: Record<string, unknown>
) {
  storage.appendRuntimeEvent({
    event_type: eventType,
    entity_type: "daemon",
    entity_id: "privileged.access",
    status,
    summary,
    details,
    source_client: input.source_client ?? "privileged.exec",
    source_model: input.source_model,
    source_agent: input.source_agent ?? "operator",
  });
}

function executePrivilegedCommand(storage: Storage, input: z.infer<typeof privilegedExecSchema>) {
  const status = buildPrivilegedAccessStatus(storage);
  const args = Array.isArray(input.args) ? input.args : [];
  const command = input.command!.trim();
  const commandExcerpt = buildCommandExcerpt(command, args);
  const baseDetails = {
    account: status.state.account,
    target_user: status.state.target_user,
    command_excerpt: commandExcerpt,
    cwd: input.cwd?.trim() || repoRoot,
    patient_zero_armed: status.summary.patient_zero_armed,
  };

  if (!status.summary.patient_zero_armed) {
    appendPrivilegedEvent(
      storage,
      input,
      "privileged.exec.denied",
      "denied",
      `Privileged exec denied for ${actorLabel(input)}: Patient Zero is disarmed.`,
      {
        ...baseDetails,
        blockers: status.summary.blockers,
      }
    );
    throw new Error("privileged execution requires Patient Zero to be armed");
  }
  if (!status.summary.user_exists) {
    appendPrivilegedEvent(
      storage,
      input,
      "privileged.exec.denied",
      "error",
      `Privileged exec denied for ${actorLabel(input)}: configured account missing.`,
      {
        ...baseDetails,
        blockers: status.summary.blockers,
      }
    );
    throw new Error(`configured privileged account '${status.state.account}' is not available on this host`);
  }
  const password = readLocalSecret(status.state.secret_path);
  if (!password) {
    appendPrivilegedEvent(
      storage,
      input,
      "privileged.exec.denied",
      "error",
      `Privileged exec denied for ${actorLabel(input)}: secret not provisioned.`,
      {
        ...baseDetails,
        blockers: status.summary.blockers,
        secret_path: status.state.secret_path,
      }
    );
    throw new Error(
      `privileged secret missing at ${status.state.secret_path}; run ./scripts/provision_mcagent_secret.sh`
    );
  }
  if (!status.summary.helper_ready) {
    appendPrivilegedEvent(
      storage,
      input,
      "privileged.exec.denied",
      "error",
      `Privileged exec denied for ${actorLabel(input)}: helper unavailable.`,
      {
        ...baseDetails,
        blockers: status.summary.blockers,
      }
    );
    throw new Error("privileged execution helper is unavailable on this host");
  }

  appendPrivilegedEvent(
    storage,
    input,
    "privileged.exec.requested",
    "in_progress",
    `Privileged exec requested by ${actorLabel(input)}.`,
    baseDetails
  );

  const startedAt = new Date().toISOString();
  const helperPayload = {
    account: status.state.account,
    target_user: status.state.target_user,
    password,
    command,
    args,
    cwd: input.cwd?.trim() || repoRoot,
    timeout_seconds: Number((input.timeout_ms / 1000).toFixed(3)),
    env: input.env ?? {},
  };
  const helper = runCommand("python3", [privilegedExecScriptPath], {
    input: JSON.stringify(helperPayload),
    timeoutMs: input.timeout_ms + 5000,
  });
  let parsed: Record<string, unknown> | null = null;
  if (helper.stdout.trim()) {
    try {
      parsed = JSON.parse(helper.stdout.trim()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  const exitCode =
    typeof parsed?.code === "number" && Number.isFinite(parsed.code)
      ? Math.trunc(parsed.code)
      : typeof helper.status === "number"
        ? helper.status
        : 1;
  const ok = Boolean(parsed?.ok) && exitCode === 0;
  const output = compactText(
    String(parsed?.output ?? helper.stderr ?? helper.stdout ?? helper.error ?? ""),
    8000
  );
  const durationMs =
    typeof parsed?.duration_ms === "number" && Number.isFinite(parsed.duration_ms)
      ? Math.trunc(parsed.duration_ms)
      : null;

  const nextState = storage.setPrivilegedAccessState({
    last_executed_at: startedAt,
    last_actor: actorLabel(input),
    last_command: commandExcerpt,
    last_exit_code: exitCode,
    last_error: ok ? null : compactText(output || "privileged execution failed", 400),
  });
  const nextStatus = buildPrivilegedAccessStatus(storage);

  appendPrivilegedEvent(
    storage,
    input,
    ok ? "privileged.exec.completed" : "privileged.exec.failed",
    ok ? "completed" : "error",
    ok
      ? `Privileged exec completed for ${actorLabel(input)}.`
      : `Privileged exec failed for ${actorLabel(input)}.`,
    {
      ...baseDetails,
      duration_ms: durationMs,
      exit_code: exitCode,
      output_excerpt: compactText(output, 240),
    }
  );

  return {
    state: nextState,
    summary: nextStatus.summary,
    execution: {
      ok,
      code: exitCode,
      duration_ms: durationMs,
      output,
      account: status.state.account,
      target_user: status.state.target_user,
      command_excerpt: commandExcerpt,
    },
    source: "privileged.exec",
  };
}

export function privilegedExec(storage: Storage, input: z.infer<typeof privilegedExecSchema>) {
  if (input.action === "status") {
    return buildPrivilegedAccessStatus(storage);
  }
  return runIdempotentMutation({
    storage,
    tool_name: "privileged.exec",
    mutation: input.mutation!,
    payload: input,
    execute: () => executePrivilegedCommand(storage, input),
  });
}
