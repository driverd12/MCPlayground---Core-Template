import os from "node:os";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNullableInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export type PrivilegedAccessStateRecord = {
  account: string;
  target_user: "root";
  secret_backend: "local_file";
  secret_path: string;
  patient_zero_required: true;
  audit_required: boolean;
  last_verified_at: string | null;
  last_verification_ok: boolean | null;
  last_verification_error: string | null;
  last_secret_fingerprint: string | null;
  last_executed_at: string | null;
  last_actor: string | null;
  last_command: string | null;
  last_exit_code: number | null;
  last_error: string | null;
  updated_at: string | null;
  source: "default" | "persisted";
};

export function getDefaultPrivilegedAccessState(): PrivilegedAccessStateRecord {
  return {
    account: "mcagent",
    target_user: "root",
    secret_backend: "local_file",
    secret_path: path.join(os.homedir(), ".codex", "secrets", "mcagent_admin_password"),
    patient_zero_required: true,
    audit_required: true,
    last_verified_at: null,
    last_verification_ok: null,
    last_verification_error: null,
    last_secret_fingerprint: null,
    last_executed_at: null,
    last_actor: null,
    last_command: null,
    last_exit_code: null,
    last_error: null,
    updated_at: null,
    source: "default",
  };
}

export function normalizePrivilegedAccessState(value: unknown, updatedAt: string | null): PrivilegedAccessStateRecord {
  const base = getDefaultPrivilegedAccessState();
  const input = isRecord(value) ? value : {};
  return {
    account: readString(input.account) ?? base.account,
    target_user: "root",
    secret_backend: "local_file",
    secret_path: readString(input.secret_path) ?? base.secret_path,
    patient_zero_required: true,
    audit_required: readBoolean(input.audit_required, base.audit_required),
    last_verified_at: readString(input.last_verified_at),
    last_verification_ok:
      typeof input.last_verification_ok === "boolean" ? input.last_verification_ok : base.last_verification_ok,
    last_verification_error: readString(input.last_verification_error),
    last_secret_fingerprint: readString(input.last_secret_fingerprint),
    last_executed_at: readString(input.last_executed_at),
    last_actor: readString(input.last_actor),
    last_command: readString(input.last_command),
    last_exit_code: readNullableInt(input.last_exit_code),
    last_error: readString(input.last_error),
    updated_at: updatedAt,
    source: updatedAt ? "persisted" : "default",
  };
}

export function summarizePrivilegedAccessState(
  state: PrivilegedAccessStateRecord,
  runtime?: {
    patient_zero_armed?: boolean;
    user_exists?: boolean;
    secret_present?: boolean;
    helper_ready?: boolean;
    secret_fingerprint?: string | null;
  } | null
) {
  const runtimeState = runtime && typeof runtime === "object" ? runtime : {};
  const patientZeroArmed = Boolean(runtimeState.patient_zero_armed);
  const userExists = Boolean(runtimeState.user_exists);
  const secretPresent = Boolean(runtimeState.secret_present);
  const helperReady = Boolean(runtimeState.helper_ready);
  const secretFingerprint = readString(runtimeState.secret_fingerprint);
  const secretFingerprintMatches =
    !secretPresent || !secretFingerprint || state.last_secret_fingerprint === secretFingerprint;
  const verificationFresh =
    Boolean(state.last_verification_ok) &&
    Boolean(state.last_verified_at) &&
    secretFingerprintMatches;
  const rootExecutionReady =
    patientZeroArmed &&
    userExists &&
    secretPresent &&
    helperReady &&
    verificationFresh;
  const blockers: string[] = [];
  if (!patientZeroArmed) {
    blockers.push("patient_zero_disarmed");
  }
  if (!userExists) {
    blockers.push("configured_account_missing");
  }
  if (!secretPresent) {
    blockers.push("secret_not_provisioned");
  }
  if (!helperReady) {
    blockers.push("privileged_helper_unavailable");
  }
  if (secretPresent && helperReady && userExists) {
    if (!secretFingerprintMatches) {
      blockers.push("credential_unverified");
    } else if (state.last_verification_ok === false) {
      blockers.push("credential_invalid");
    } else if (!verificationFresh) {
      blockers.push("credential_unverified");
    }
  }
  return {
    account: state.account,
    target_user: state.target_user,
    secret_backend: state.secret_backend,
    secret_path: state.secret_path,
    patient_zero_required: state.patient_zero_required,
    patient_zero_armed: patientZeroArmed,
    user_exists: userExists,
    secret_present: secretPresent,
    helper_ready: helperReady,
    credential_verified: verificationFresh,
    last_verified_at: state.last_verified_at,
    last_verification_ok: state.last_verification_ok,
    last_verification_error: state.last_verification_error,
    root_execution_ready: rootExecutionReady,
    blockers,
    audit_required: state.audit_required,
    last_executed_at: state.last_executed_at,
    last_actor: state.last_actor,
    last_command: state.last_command,
    last_exit_code: state.last_exit_code,
    last_error: state.last_error,
  };
}
