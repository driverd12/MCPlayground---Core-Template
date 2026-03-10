import { z } from "zod";

export const simulateWorkflowSchema = z.object({
  workflow: z.enum(["provision_user", "deprovision_user"]),
  employment_type: z.enum(["FTE", "CON", "INT", "SUP"]),
  execution_mode: z.enum(["log-only", "staged", "execute"]).optional(),
  manager_dn_resolved: z.boolean().optional(),
  scim_ready: z.boolean().optional(),
  actual_outcomes: z.record(z.boolean()).optional(),
});

export function simulateWorkflow(input: z.infer<typeof simulateWorkflowSchema>) {
  const scimReady = input.scim_ready ?? true;
  const managerResolved = input.manager_dn_resolved ?? true;
  const actual = input.actual_outcomes ?? {};

  const expected = buildExpectedOutcomes(input.workflow, input.employment_type, {
    scimReady,
    managerResolved,
    executionMode: input.execution_mode ?? "log-only",
  });

  const steps = Object.entries(expected).map(([name, expectedValue]) => {
    const actualValue = actual[name];
    const status =
      actualValue === undefined ? "expected" : actualValue === expectedValue ? "match" : "mismatch";
    return {
      step: name,
      expected: expectedValue,
      actual: actualValue ?? null,
      status,
    };
  });

  const mismatches = steps.filter((step) => step.status === "mismatch");

  return {
    deterministic: true,
    workflow: input.workflow,
    employment_type: input.employment_type,
    summary: {
      steps: steps.length,
      mismatches: mismatches.length,
      pass: mismatches.length === 0,
    },
    steps,
  };
}

function buildExpectedOutcomes(
  workflow: "provision_user" | "deprovision_user",
  employmentType: "FTE" | "CON" | "INT" | "SUP",
  options: {
    scimReady: boolean;
    managerResolved: boolean;
    executionMode: "log-only" | "staged" | "execute";
  }
): Record<string, boolean> {
  if (workflow === "deprovision_user") {
    return {
      require_two_source_confirmation: true,
      execute_destructive_actions: options.executionMode === "execute",
      preserve_protected_targets: true,
      transfer_owner_assigned: options.managerResolved,
      notify_audit_channel: true,
    };
  }

  return {
    source_record_present: true,
    identity_created: options.scimReady,
    manager_resolved: options.managerResolved,
    base_access_applied: options.scimReady,
    collaboration_access_applied: employmentType !== "SUP" && options.scimReady,
    physical_access_task_created: employmentType !== "SUP" && options.scimReady,
  };
}
