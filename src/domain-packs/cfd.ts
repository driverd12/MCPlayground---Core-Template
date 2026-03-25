import crypto from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { mutationSchema } from "../tools/mutation.js";
import { DomainPack } from "./types.js";

const caseStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "completed",
  "failed",
  "archived",
]);

const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const cfdCaseCreateSchema = z.object({
  mutation: mutationSchema,
  case_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  solver_family: z.string().min(1),
  units: z.string().min(1).default("SI"),
  geometry_ref: z.string().optional(),
  status: caseStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  ...sourceSchema.shape,
});

const cfdCaseGetSchema = z.object({
  case_id: z.string().min(1),
});

const cfdCaseListSchema = z.object({
  status: caseStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const cfdMeshGenerateSchema = z.object({
  mutation: mutationSchema,
  case_id: z.string().min(1),
  mesh_id: z.string().min(1).max(200).optional(),
  strategy: z.string().min(1).default("snappyHexMesh"),
  target_cell_count: z.number().int().min(100).optional(),
  boundary_layers: z.number().int().min(0).max(200).optional(),
  quality_targets: z.record(z.number()).optional(),
  artifact_ref: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

const cfdMeshCheckSchema = z.object({
  mutation: mutationSchema,
  case_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  mesh_id: z.string().min(1).optional(),
  observed: z.object({
    skewness: z.number().nonnegative(),
    non_orthogonality: z.number().nonnegative(),
    min_orthogonality: z.number().nonnegative(),
    max_aspect_ratio: z.number().nonnegative(),
  }),
  thresholds: z
    .object({
      skewness: z.number().nonnegative().default(4),
      non_orthogonality: z.number().nonnegative().default(70),
      min_orthogonality: z.number().nonnegative().default(20),
      max_aspect_ratio: z.number().nonnegative().default(1000),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

const cfdSolveStartSchema = z.object({
  mutation: mutationSchema,
  case_id: z.string().min(1),
  run_id: z.string().min(1).max(200).optional(),
  mesh_id: z.string().optional(),
  solver_version: z.string().optional(),
  config_hash: z.string().optional(),
  command: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

const cfdSolveStatusSchema = z
  .object({
    case_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.case_id && !value.run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "case_id or run_id is required",
        path: ["run_id"],
      });
    }
  });

const cfdSolveStopSchema = z.object({
  mutation: mutationSchema,
  run_id: z.string().min(1),
  status: runStatusSchema.refine((value) => value !== "queued", {
    message: "status must be running/completed/failed/stopped",
  }),
  reason: z.string().optional(),
  residuals: z.record(z.number()).optional(),
  summary: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

const cfdPostExtractSchema = z.object({
  mutation: mutationSchema,
  case_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  metrics: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.number(),
        unit: z.string().optional(),
        source: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
    )
    .min(1),
  ...sourceSchema.shape,
});

const cfdValidateCompareSchema = z.object({
  mutation: mutationSchema,
  case_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  baseline: z.record(z.number()),
  actual: z.record(z.number()),
  tolerances: z.record(z.number()),
  mode: z.enum(["relative", "absolute"]).default("relative"),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

const cfdReportBundleSchema = z.object({
  case_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  metrics_limit: z.number().int().min(1).max(500).optional(),
  validations_limit: z.number().int().min(1).max(200).optional(),
  artifacts_limit: z.number().int().min(1).max(200).optional(),
});

const cfdSchemaStatusSchema = z.object({});

type CfdCaseRecord = {
  case_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  objective: string;
  solver_family: string;
  units: string;
  geometry_ref: string | null;
  status: z.infer<typeof caseStatusSchema>;
  tags: string[];
  metadata: Record<string, unknown>;
};

type CfdRunRecord = {
  run_id: string;
  case_id: string;
  created_at: string;
  updated_at: string;
  status: z.infer<typeof runStatusSchema>;
  mesh_id: string | null;
  solver_version: string | null;
  config_hash: string | null;
  command: string | null;
  started_at: string | null;
  finished_at: string | null;
  reason: string | null;
  residuals: Record<string, unknown>;
  summary: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type CfdMetricRecord = {
  metric_id: string;
  case_id: string;
  run_id: string | null;
  created_at: string;
  metric_name: string;
  metric_value: number;
  metric_unit: string | null;
  metric_source: string | null;
  metadata: Record<string, unknown>;
};

type CfdArtifactRecord = {
  artifact_id: string;
  case_id: string;
  run_id: string | null;
  created_at: string;
  kind: string;
  artifact_ref: string | null;
  metadata: Record<string, unknown>;
};

type CfdValidationRecord = {
  validation_id: string;
  case_id: string;
  run_id: string | null;
  created_at: string;
  validation_type: string;
  pass: boolean;
  summary: string | null;
  baseline: Record<string, unknown>;
  actual: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  deltas: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export const cfdDomainPack: DomainPack = {
  id: "cfd",
  title: "CFD Analysis Pack",
  description:
    "Computational Fluid Dynamics domain tools for case lifecycle, mesh checks, solver orchestration, result validation, and report generation.",
  register: (context) => {
    const dbPath = context.storage.getDatabasePath();

    context.register_tool(
      "cfd.case.create",
      "Create or update a CFD case definition with durable local metadata.",
      cfdCaseCreateSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.case.create",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const now = new Date().toISOString();
              const caseId = input.case_id?.trim() || `cfd-case-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
              const existing = db
                .prepare(`SELECT case_id, created_at FROM cfd_cases WHERE case_id = ?`)
                .get(caseId) as Record<string, unknown> | undefined;

              const metadata = {
                ...(input.metadata ?? {}),
                source_client: input.source_client ?? null,
                source_model: input.source_model ?? null,
                source_agent: input.source_agent ?? null,
              };

              db.prepare(
                `INSERT INTO cfd_cases (
                   case_id, created_at, updated_at, title, objective, solver_family, units,
                   geometry_ref, status, tags_json, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(case_id) DO UPDATE SET
                   updated_at = excluded.updated_at,
                   title = excluded.title,
                   objective = excluded.objective,
                   solver_family = excluded.solver_family,
                   units = excluded.units,
                   geometry_ref = excluded.geometry_ref,
                   status = excluded.status,
                   tags_json = excluded.tags_json,
                   metadata_json = excluded.metadata_json`
              ).run(
                caseId,
                existing ? asNullableString((existing as Record<string, unknown>).created_at) ?? now : now,
                now,
                input.title.trim(),
                input.objective.trim(),
                input.solver_family.trim(),
                input.units.trim(),
                input.geometry_ref?.trim() ?? null,
                input.status ?? "draft",
                JSON.stringify(input.tags ?? []),
                JSON.stringify(metadata)
              );

              const record = getCaseById(db, caseId);
              if (!record) {
                throw new Error(`Failed to read CFD case after upsert: ${caseId}`);
              }

              appendCfdEvent(db, {
                entity_type: "cfd_case",
                entity_id: caseId,
                action: existing ? "case.updated" : "case.created",
                summary: `${existing ? "updated" : "created"} case ${caseId}`,
                details: {
                  status: record.status,
                  solver_family: record.solver_family,
                  units: record.units,
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              return {
                created: !existing,
                case: record,
              };
            }),
        })
    );

    context.register_tool("cfd.case.get", "Read a CFD case by case id.", cfdCaseGetSchema, (input) =>
      withCfdDb(dbPath, (db) => {
        const record = getCaseById(db, input.case_id);
        return {
          found: Boolean(record),
          case: record,
        };
      })
    );

    context.register_tool("cfd.case.list", "List CFD cases with optional status filtering.", cfdCaseListSchema, (input) =>
      withCfdDb(dbPath, (db) => {
        const limit = input.limit ?? 100;
        const rows = input.status
          ? (db
              .prepare(
                `SELECT * FROM cfd_cases
                 WHERE status = ?
                 ORDER BY updated_at DESC
                 LIMIT ?`
              )
              .all(input.status, limit) as Array<Record<string, unknown>>)
          : (db
              .prepare(
                `SELECT * FROM cfd_cases
                 ORDER BY updated_at DESC
                 LIMIT ?`
              )
              .all(limit) as Array<Record<string, unknown>>);

        return {
          count: rows.length,
          status_filter: input.status ?? null,
          cases: rows.map((row) => mapCaseRow(row)),
        };
      })
    );

    context.register_tool(
      "cfd.mesh.generate",
      "Register generated mesh metadata and artifact reference for a CFD case.",
      cfdMeshGenerateSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.mesh.generate",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const caseRecord = requireCase(db, input.case_id);
              const now = new Date().toISOString();
              const meshId = input.mesh_id?.trim() || `mesh-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
              const artifactId = `artifact-${crypto.randomUUID()}`;

              const artifactMetadata = {
                mesh_id: meshId,
                strategy: input.strategy,
                target_cell_count: input.target_cell_count ?? null,
                boundary_layers: input.boundary_layers ?? null,
                quality_targets: input.quality_targets ?? {},
                ...(input.metadata ?? {}),
              };

              db.prepare(
                `INSERT INTO cfd_artifacts (
                   artifact_id, case_id, run_id, created_at, kind, artifact_ref, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`
              ).run(
                artifactId,
                caseRecord.case_id,
                null,
                now,
                "mesh",
                input.artifact_ref?.trim() ?? null,
                JSON.stringify(artifactMetadata)
              );

              db.prepare(
                `UPDATE cfd_cases
                 SET status = ?, updated_at = ?, metadata_json = ?
                 WHERE case_id = ?`
              ).run(
                caseRecord.status === "draft" ? "ready" : caseRecord.status,
                now,
                JSON.stringify({
                  ...caseRecord.metadata,
                  latest_mesh_id: meshId,
                  latest_mesh_artifact_id: artifactId,
                }),
                caseRecord.case_id
              );

              appendCfdEvent(db, {
                entity_type: "cfd_case",
                entity_id: caseRecord.case_id,
                action: "mesh.generated",
                summary: `generated mesh ${meshId} for case ${caseRecord.case_id}`,
                details: artifactMetadata,
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              return {
                case_id: caseRecord.case_id,
                mesh_id: meshId,
                artifact_id: artifactId,
                status: caseRecord.status === "draft" ? "ready" : caseRecord.status,
                created_at: now,
                artifact_ref: input.artifact_ref ?? null,
                metadata: artifactMetadata,
              };
            }),
        })
    );

    context.register_tool(
      "cfd.mesh.check",
      "Evaluate mesh quality metrics against thresholds and persist validation evidence.",
      cfdMeshCheckSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.mesh.check",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const caseRecord = requireCase(db, input.case_id);
              const now = new Date().toISOString();
              const thresholds = {
                skewness: input.thresholds?.skewness ?? 4,
                non_orthogonality: input.thresholds?.non_orthogonality ?? 70,
                min_orthogonality: input.thresholds?.min_orthogonality ?? 20,
                max_aspect_ratio: input.thresholds?.max_aspect_ratio ?? 1000,
              };

              const checks = {
                skewness: {
                  observed: input.observed.skewness,
                  threshold: thresholds.skewness,
                  operator: "<=",
                  pass: input.observed.skewness <= thresholds.skewness,
                },
                non_orthogonality: {
                  observed: input.observed.non_orthogonality,
                  threshold: thresholds.non_orthogonality,
                  operator: "<=",
                  pass: input.observed.non_orthogonality <= thresholds.non_orthogonality,
                },
                min_orthogonality: {
                  observed: input.observed.min_orthogonality,
                  threshold: thresholds.min_orthogonality,
                  operator: ">=",
                  pass: input.observed.min_orthogonality >= thresholds.min_orthogonality,
                },
                max_aspect_ratio: {
                  observed: input.observed.max_aspect_ratio,
                  threshold: thresholds.max_aspect_ratio,
                  operator: "<=",
                  pass: input.observed.max_aspect_ratio <= thresholds.max_aspect_ratio,
                },
              };

              const pass = Object.values(checks).every((entry) => entry.pass);
              const validationId = `validation-${crypto.randomUUID()}`;

              db.prepare(
                `INSERT INTO cfd_validations (
                   validation_id, case_id, run_id, created_at, validation_type, pass,
                   summary, baseline_json, actual_json, thresholds_json, deltas_json, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                validationId,
                caseRecord.case_id,
                input.run_id ?? null,
                now,
                "mesh_quality",
                pass ? 1 : 0,
                pass ? "mesh quality checks passed" : "mesh quality checks failed",
                JSON.stringify({}),
                JSON.stringify(input.observed),
                JSON.stringify(thresholds),
                JSON.stringify({}),
                JSON.stringify({
                  mesh_id: input.mesh_id ?? null,
                  checks,
                  ...(input.metadata ?? {}),
                })
              );

              const metricInsert = db.prepare(
                `INSERT INTO cfd_metrics (
                   metric_id, case_id, run_id, created_at, metric_name, metric_value, metric_unit, metric_source, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              );

              for (const [name, observed] of Object.entries(input.observed)) {
                metricInsert.run(
                  `metric-${crypto.randomUUID()}`,
                  caseRecord.case_id,
                  input.run_id ?? null,
                  now,
                  `mesh.${name}`,
                  observed,
                  null,
                  "cfd.mesh.check",
                  JSON.stringify({ mesh_id: input.mesh_id ?? null })
                );
              }

              appendCfdEvent(db, {
                entity_type: "cfd_case",
                entity_id: caseRecord.case_id,
                action: "mesh.checked",
                summary: pass ? "mesh checks passed" : "mesh checks failed",
                details: {
                  run_id: input.run_id ?? null,
                  mesh_id: input.mesh_id ?? null,
                  pass,
                  checks,
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              return {
                validation_id: validationId,
                case_id: caseRecord.case_id,
                run_id: input.run_id ?? null,
                mesh_id: input.mesh_id ?? null,
                pass,
                checks,
                thresholds,
                observed: input.observed,
                created_at: now,
              };
            }),
        })
    );

    context.register_tool(
      "cfd.solve.start",
      "Create and start a durable CFD solve run for a case.",
      cfdSolveStartSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.solve.start",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const caseRecord = requireCase(db, input.case_id);
              const now = new Date().toISOString();
              const runId = input.run_id?.trim() || `run-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

              db.prepare(
                `INSERT INTO cfd_runs (
                   run_id, case_id, created_at, updated_at, status, mesh_id, solver_version,
                   config_hash, command, started_at, finished_at, reason,
                   residuals_json, summary_json, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id) DO UPDATE SET
                   updated_at = excluded.updated_at,
                   status = excluded.status,
                   mesh_id = excluded.mesh_id,
                   solver_version = excluded.solver_version,
                   config_hash = excluded.config_hash,
                   command = excluded.command,
                   started_at = excluded.started_at,
                   finished_at = excluded.finished_at,
                   reason = excluded.reason,
                   residuals_json = excluded.residuals_json,
                   summary_json = excluded.summary_json,
                   metadata_json = excluded.metadata_json`
              ).run(
                runId,
                caseRecord.case_id,
                now,
                now,
                "running",
                input.mesh_id ?? null,
                input.solver_version ?? null,
                input.config_hash ?? null,
                input.command ?? null,
                now,
                null,
                null,
                JSON.stringify({}),
                JSON.stringify({}),
                JSON.stringify({
                  ...(input.metadata ?? {}),
                  started_by: {
                    source_client: input.source_client ?? null,
                    source_model: input.source_model ?? null,
                    source_agent: input.source_agent ?? null,
                  },
                })
              );

              db.prepare(`UPDATE cfd_cases SET status = ?, updated_at = ? WHERE case_id = ?`).run(
                "running",
                now,
                caseRecord.case_id
              );

              appendCfdEvent(db, {
                entity_type: "cfd_run",
                entity_id: runId,
                action: "solve.started",
                summary: `solve started for case ${caseRecord.case_id}`,
                details: {
                  case_id: caseRecord.case_id,
                  mesh_id: input.mesh_id ?? null,
                  solver_version: input.solver_version ?? null,
                  config_hash: input.config_hash ?? null,
                  command: input.command ?? null,
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              const run = getRunById(db, runId);
              if (!run) {
                throw new Error(`Failed to read CFD run after start: ${runId}`);
              }

              return {
                created_at: now,
                run,
              };
            }),
        })
    );

    context.register_tool(
      "cfd.solve.status",
      "Read CFD solve status for a run id or latest run in a case.",
      cfdSolveStatusSchema,
      (input) =>
        withCfdDb(dbPath, (db) => {
          const run = input.run_id ? getRunById(db, input.run_id) : getLatestRunByCase(db, input.case_id ?? "");
          if (!run) {
            return {
              found: false,
              run_id: input.run_id ?? null,
              case_id: input.case_id ?? null,
            };
          }

          const metrics = (db
            .prepare(
              `SELECT * FROM cfd_metrics
               WHERE run_id = ?
               ORDER BY created_at DESC
               LIMIT 25`
            )
            .all(run.run_id) as Array<Record<string, unknown>>)
            .map((row) => mapMetricRow(row));

          const validations = (db
            .prepare(
              `SELECT * FROM cfd_validations
               WHERE run_id = ?
               ORDER BY created_at DESC
               LIMIT 10`
            )
            .all(run.run_id) as Array<Record<string, unknown>>)
            .map((row) => mapValidationRow(row));

          return {
            found: true,
            run,
            metrics,
            validations,
          };
        })
    );

    context.register_tool(
      "cfd.solve.stop",
      "Finalize or fail a CFD run with residual/summary metadata and case status updates.",
      cfdSolveStopSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.solve.stop",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const run = requireRun(db, input.run_id);
              const now = new Date().toISOString();

              db.prepare(
                `UPDATE cfd_runs
                 SET updated_at = ?, status = ?, finished_at = ?, reason = ?,
                     residuals_json = ?, summary_json = ?, metadata_json = ?
                 WHERE run_id = ?`
              ).run(
                now,
                input.status,
                now,
                input.reason ?? null,
                JSON.stringify(input.residuals ?? run.residuals),
                JSON.stringify(input.summary ?? run.summary),
                JSON.stringify({
                  ...run.metadata,
                  ...(input.metadata ?? {}),
                }),
                run.run_id
              );

              const caseStatus =
                input.status === "failed" ? "failed" : input.status === "completed" ? "completed" : "ready";
              db.prepare(`UPDATE cfd_cases SET status = ?, updated_at = ? WHERE case_id = ?`).run(
                caseStatus,
                now,
                run.case_id
              );

              if (input.residuals && Object.keys(input.residuals).length > 0) {
                const metricInsert = db.prepare(
                  `INSERT INTO cfd_metrics (
                     metric_id, case_id, run_id, created_at, metric_name, metric_value, metric_unit, metric_source, metadata_json
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                );
                for (const [name, value] of Object.entries(input.residuals)) {
                  metricInsert.run(
                    `metric-${crypto.randomUUID()}`,
                    run.case_id,
                    run.run_id,
                    now,
                    `residual.${name}`,
                    value,
                    null,
                    "cfd.solve.stop",
                    JSON.stringify({})
                  );
                }
              }

              appendCfdEvent(db, {
                entity_type: "cfd_run",
                entity_id: run.run_id,
                action: "solve.stopped",
                summary: `run ${run.run_id} marked ${input.status}`,
                details: {
                  case_id: run.case_id,
                  status: input.status,
                  reason: input.reason ?? null,
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              const updated = requireRun(db, run.run_id);

              return {
                run: updated,
                case_id: run.case_id,
                case_status: caseStatus,
              };
            }),
        })
    );

    context.register_tool(
      "cfd.post.extract",
      "Persist extracted CFD quantities-of-interest (QoIs) as durable metrics.",
      cfdPostExtractSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.post.extract",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const caseRecord = requireCase(db, input.case_id);
              const runId = input.run_id ?? getLatestRunByCase(db, caseRecord.case_id)?.run_id ?? null;
              const now = new Date().toISOString();

              const insertMetric = db.prepare(
                `INSERT INTO cfd_metrics (
                   metric_id, case_id, run_id, created_at, metric_name, metric_value, metric_unit, metric_source, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              );

              const createdMetrics: CfdMetricRecord[] = [];
              for (const metric of input.metrics) {
                const metricId = `metric-${crypto.randomUUID()}`;
                insertMetric.run(
                  metricId,
                  caseRecord.case_id,
                  runId,
                  now,
                  metric.name,
                  metric.value,
                  metric.unit ?? null,
                  metric.source ?? "cfd.post.extract",
                  JSON.stringify(metric.metadata ?? {})
                );
                createdMetrics.push({
                  metric_id: metricId,
                  case_id: caseRecord.case_id,
                  run_id: runId,
                  created_at: now,
                  metric_name: metric.name,
                  metric_value: metric.value,
                  metric_unit: metric.unit ?? null,
                  metric_source: metric.source ?? "cfd.post.extract",
                  metadata: metric.metadata ?? {},
                });
              }

              appendCfdEvent(db, {
                entity_type: "cfd_case",
                entity_id: caseRecord.case_id,
                action: "post.extract",
                summary: `persisted ${createdMetrics.length} extracted metrics`,
                details: {
                  run_id: runId,
                  metric_names: createdMetrics.map((entry) => entry.metric_name),
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              return {
                case_id: caseRecord.case_id,
                run_id: runId,
                metrics_count: createdMetrics.length,
                metrics: createdMetrics,
              };
            }),
        })
    );

    context.register_tool(
      "cfd.validate.compare",
      "Compare run outputs against baseline and tolerance thresholds with persisted validation evidence.",
      cfdValidateCompareSchema,
      (input) =>
        context.run_idempotent_mutation({
          storage: context.storage,
          tool_name: "cfd.validate.compare",
          mutation: input.mutation,
          payload: input,
          execute: () =>
            withCfdDb(dbPath, (db) => {
              const caseRecord = requireCase(db, input.case_id);
              const now = new Date().toISOString();
              const runId = input.run_id ?? getLatestRunByCase(db, caseRecord.case_id)?.run_id ?? null;
              const keys = Array.from(
                new Set([...Object.keys(input.baseline), ...Object.keys(input.actual), ...Object.keys(input.tolerances)])
              ).sort();

              const deltas: Record<string, { baseline: number; actual: number; tolerance: number; delta: number; pass: boolean }> = {};
              let pass = true;

              for (const key of keys) {
                const baseline = input.baseline[key] ?? 0;
                const actual = input.actual[key] ?? 0;
                const tolerance = input.tolerances[key] ?? input.tolerances["*"] ?? 0;
                const deltaAbs = Math.abs(actual - baseline);
                const delta =
                  input.mode === "relative"
                    ? baseline === 0
                      ? actual === 0
                        ? 0
                        : Number.POSITIVE_INFINITY
                      : deltaAbs / Math.abs(baseline)
                    : deltaAbs;
                const metricPass = delta <= tolerance;
                if (!metricPass) {
                  pass = false;
                }

                deltas[key] = {
                  baseline,
                  actual,
                  tolerance,
                  delta,
                  pass: metricPass,
                };
              }

              const validationId = `validation-${crypto.randomUUID()}`;
              db.prepare(
                `INSERT INTO cfd_validations (
                   validation_id, case_id, run_id, created_at, validation_type, pass,
                   summary, baseline_json, actual_json, thresholds_json, deltas_json, metadata_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                validationId,
                caseRecord.case_id,
                runId,
                now,
                "result_compare",
                pass ? 1 : 0,
                input.summary ?? (pass ? "validation passed" : "validation failed"),
                JSON.stringify(input.baseline),
                JSON.stringify(input.actual),
                JSON.stringify(input.tolerances),
                JSON.stringify(deltas),
                JSON.stringify({
                  mode: input.mode,
                  ...(input.metadata ?? {}),
                })
              );

              appendCfdEvent(db, {
                entity_type: "cfd_case",
                entity_id: caseRecord.case_id,
                action: "validation.compare",
                summary: pass ? "validation passed" : "validation failed",
                details: {
                  validation_id: validationId,
                  run_id: runId,
                  mode: input.mode,
                  failed_metrics: Object.entries(deltas)
                    .filter(([, value]) => !value.pass)
                    .map(([name]) => name),
                },
                source_client: input.source_client,
                source_model: input.source_model,
                source_agent: input.source_agent,
              });

              return {
                validation_id: validationId,
                case_id: caseRecord.case_id,
                run_id: runId,
                mode: input.mode,
                pass,
                deltas,
                created_at: now,
              };
            }),
        })
    );

    context.register_tool(
      "cfd.report.bundle",
      "Generate a deterministic markdown bundle for a CFD case/run with metrics, validations, and artifacts.",
      cfdReportBundleSchema,
      (input) =>
        withCfdDb(dbPath, (db) => {
          const caseRecord = requireCase(db, input.case_id);
          const run = input.run_id ? getRunById(db, input.run_id) : getLatestRunByCase(db, caseRecord.case_id);
          const metricsLimit = input.metrics_limit ?? 50;
          const validationsLimit = input.validations_limit ?? 20;
          const artifactsLimit = input.artifacts_limit ?? 20;

          const metrics = (db
            .prepare(
              `SELECT * FROM cfd_metrics
               WHERE case_id = ? AND (? IS NULL OR run_id = ?)
               ORDER BY created_at DESC
               LIMIT ?`
            )
            .all(caseRecord.case_id, run?.run_id ?? null, run?.run_id ?? null, metricsLimit) as Array<Record<string, unknown>>)
            .map((row) => mapMetricRow(row));

          const validations = (db
            .prepare(
              `SELECT * FROM cfd_validations
               WHERE case_id = ? AND (? IS NULL OR run_id = ?)
               ORDER BY created_at DESC
               LIMIT ?`
            )
            .all(caseRecord.case_id, run?.run_id ?? null, run?.run_id ?? null, validationsLimit) as Array<Record<string, unknown>>)
            .map((row) => mapValidationRow(row));

          const artifacts = (db
            .prepare(
              `SELECT * FROM cfd_artifacts
               WHERE case_id = ? AND (? IS NULL OR run_id = ?)
               ORDER BY created_at DESC
               LIMIT ?`
            )
            .all(caseRecord.case_id, run?.run_id ?? null, run?.run_id ?? null, artifactsLimit) as Array<Record<string, unknown>>)
            .map((row) => mapArtifactRow(row));

          const reportMarkdown = buildReportMarkdown({
            caseRecord,
            run,
            metrics,
            validations,
            artifacts,
          });

          return {
            generated_at: new Date().toISOString(),
            case: caseRecord,
            run,
            counts: {
              metrics: metrics.length,
              validations: validations.length,
              artifacts: artifacts.length,
            },
            report_markdown: reportMarkdown,
          };
        })
    );

    context.register_tool(
      "cfd.schema.status",
      "Read CFD domain-pack schema counts and metadata.",
      cfdSchemaStatusSchema,
      () =>
        withCfdDb(dbPath, (db) => {
          const counts = {
            cfd_cases: countTable(db, "cfd_cases"),
            cfd_runs: countTable(db, "cfd_runs"),
            cfd_metrics: countTable(db, "cfd_metrics"),
            cfd_artifacts: countTable(db, "cfd_artifacts"),
            cfd_validations: countTable(db, "cfd_validations"),
            cfd_events: countTable(db, "cfd_events"),
          };
          return {
            ok: true,
            db_path: dbPath,
            counts,
          };
        })
    );

    context.register_planner_hook({
      hook_name: "case_lifecycle",
      title: "CFD Case Lifecycle Planner",
      description: "Generate a durable lifecycle plan for a CFD case using the CFD pack toolchain.",
      target_types: ["cfd.case"],
      plan: ({ target, options }) =>
        withCfdDb(dbPath, (db) => {
          const caseRecord = requireCase(db, target.entity_id);
          const meshStrategy =
            typeof options?.mesh_strategy === "string" && options.mesh_strategy.trim()
              ? options.mesh_strategy.trim()
              : "snappyHexMesh";
          const targetCellCount =
            typeof options?.target_cell_count === "number" && Number.isFinite(options.target_cell_count)
              ? Math.max(100, Math.round(options.target_cell_count))
              : 1_200_000;
          const boundaryLayers =
            typeof options?.boundary_layers === "number" && Number.isFinite(options.boundary_layers)
              ? Math.max(0, Math.round(options.boundary_layers))
              : 8;
          const projectDir =
            typeof options?.project_dir === "string" && options.project_dir.trim()
              ? options.project_dir.trim()
              : context.repo_root;
          const solveCommand =
            typeof options?.solve_command === "string" && options.solve_command.trim()
              ? options.solve_command.trim()
              : `simpleFoam -case ./cases/${caseRecord.case_id}`;

          return {
            summary: `Generated a CFD lifecycle plan for case ${caseRecord.case_id}.`,
            confidence: 0.78,
            assumptions: [
              "CFD operators can claim worker steps for solver execution.",
              "Latest run will be discoverable by cfd.report.bundle without an explicit run_id input.",
            ],
            success_criteria: [
              "Case state can be inspected through the CFD pack.",
              "A solver execution task is queued for the attached agent runtime.",
              "Case readiness is verified before the report bundle step.",
            ],
            rollback: [
              "Stop active solve runs before invalidating the plan.",
              "Preserve latest mesh and validation evidence before re-planning.",
            ],
            metadata: {
              case_status: caseRecord.status,
              solver_family: caseRecord.solver_family,
              planner_pack: "cfd",
            },
            steps: [
              {
                step_id: "inspect-case",
                title: "Inspect CFD case state",
                step_kind: "analysis",
                executor_kind: "tool",
                tool_name: "cfd.case.get",
                input: {
                  case_id: caseRecord.case_id,
                },
              },
              {
                step_id: "generate-mesh",
                title: "Generate or refresh the CFD mesh",
                step_kind: "mutation",
                executor_kind: "tool",
                tool_name: "cfd.mesh.generate",
                input: {
                  case_id: caseRecord.case_id,
                  strategy: meshStrategy,
                  target_cell_count: targetCellCount,
                  boundary_layers: boundaryLayers,
                },
                expected_artifact_types: ["mesh"],
              },
              {
                step_id: "run-solve",
                title: "Run the CFD solve workflow",
                step_kind: "mutation",
                executor_kind: "worker",
                depends_on: ["generate-mesh"],
                input: {
                  objective: `Run the CFD solve workflow for case ${caseRecord.case_id}`,
                  project_dir: projectDir,
                  priority: 7,
                  tags: ["cfd", "solve", caseRecord.case_id],
                  payload: {
                    mode: "cfd.solve",
                    case_id: caseRecord.case_id,
                    solver_family: caseRecord.solver_family,
                    recommended_tool: "cfd.solve.start",
                    recommended_command: solveCommand,
                  },
                },
              },
              {
                step_id: "verify-case",
                title: "Verify CFD case readiness",
                step_kind: "verification",
                executor_kind: "tool",
                tool_name: "pack.verify.run",
                depends_on: ["run-solve"],
                input: {
                  pack_id: "cfd",
                  hook_name: "case_readiness",
                  target: {
                    entity_type: "cfd.case",
                    entity_id: caseRecord.case_id,
                  },
                  goal_id: target.goal_id,
                },
                expected_artifact_types: ["verifier_result", "cfd.case_readiness"],
              },
              {
                step_id: "bundle-report",
                title: "Bundle the CFD report",
                step_kind: "verification",
                executor_kind: "tool",
                tool_name: "cfd.report.bundle",
                depends_on: ["verify-case"],
                input: {
                  case_id: caseRecord.case_id,
                },
                expected_artifact_types: ["report"],
              },
            ],
          };
        }),
    });

    context.register_verifier_hook({
      hook_name: "case_readiness",
      title: "CFD Case Readiness Verifier",
      description: "Evaluate whether a CFD case has the mesh, run, and validation state needed for robust execution.",
      target_types: ["cfd.case"],
      verify: ({ target, expectations }) =>
        withCfdDb(dbPath, (db) => {
          const caseRecord = requireCase(db, target.entity_id);
          const latestRun = getLatestRunByCase(db, caseRecord.case_id);
          const latestValidation = getLatestValidationByCase(db, caseRecord.case_id);
          const latestMeshArtifact = getLatestArtifactByCaseAndKind(db, caseRecord.case_id, "mesh");
          const requireRun = expectations?.require_run !== false;
          const requireValidation = expectations?.require_validation !== false;
          const requirePassedValidation = expectations?.require_passed_validation !== false;

          const checks = [
            {
              name: "case_loaded",
              pass: true,
              severity: "info" as const,
              details: `Loaded CFD case ${caseRecord.case_id}.`,
            },
            {
              name: "case_not_archived",
              pass: caseRecord.status !== "archived",
              severity: caseRecord.status === "archived" ? ("error" as const) : ("info" as const),
              details: `Current case status is ${caseRecord.status}.`,
            },
            {
              name: "mesh_registered",
              pass: Boolean(latestMeshArtifact),
              severity: "error" as const,
              details: latestMeshArtifact
                ? `Latest mesh artifact is ${latestMeshArtifact.artifact_id}.`
                : "No mesh artifact has been registered for this case.",
            },
            {
              name: "run_recorded",
              pass: !requireRun || Boolean(latestRun),
              severity: requireRun ? ("error" as const) : ("warn" as const),
              details: latestRun
                ? `Latest run is ${latestRun.run_id} with status ${latestRun.status}.`
                : "No solve run has been recorded for this case.",
            },
            {
              name: "validation_present",
              pass: !requireValidation || Boolean(latestValidation),
              severity: requireValidation ? ("error" as const) : ("warn" as const),
              details: latestValidation
                ? `Latest validation is ${latestValidation.validation_id}.`
                : "No validation result has been recorded for this case.",
            },
            {
              name: "validation_passed",
              pass:
                !requirePassedValidation ||
                (latestValidation ? latestValidation.pass : false),
              severity: requirePassedValidation ? ("error" as const) : ("warn" as const),
              details: latestValidation
                ? `Latest validation pass state is ${latestValidation.pass}.`
                : "Validation pass state is unavailable because no validation exists.",
            },
          ];

          const pass = checks.every((check) => check.pass);
          return {
            summary: pass
              ? `CFD case ${caseRecord.case_id} is ready for downstream execution.`
              : `CFD case ${caseRecord.case_id} is missing readiness requirements.`,
            pass,
            score: pass ? 1 : 0,
            checks,
            produced_artifacts: [
              {
                artifact_type: "cfd.case_readiness",
                trust_tier: pass ? "verified" : "derived",
                content_json: {
                  case: caseRecord,
                  latest_run: latestRun,
                  latest_validation: latestValidation,
                  latest_mesh_artifact: latestMeshArtifact,
                  checks,
                },
                metadata: {
                  case_status: caseRecord.status,
                  latest_run_id: latestRun?.run_id ?? null,
                  latest_validation_id: latestValidation?.validation_id ?? null,
                },
              },
            ],
            metadata: {
              case_status: caseRecord.status,
              latest_run_id: latestRun?.run_id ?? null,
              latest_validation_id: latestValidation?.validation_id ?? null,
              latest_mesh_artifact_id: latestMeshArtifact?.artifact_id ?? null,
            },
          };
        }),
    });
  },
};

function withCfdDb<T>(dbPath: string, run: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  ensureCfdSchema(db);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function ensureCfdSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cfd_cases (
      case_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      solver_family TEXT NOT NULL,
      units TEXT NOT NULL,
      geometry_ref TEXT,
      status TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cfd_runs (
      run_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      mesh_id TEXT,
      solver_version TEXT,
      config_hash TEXT,
      command TEXT,
      started_at TEXT,
      finished_at TEXT,
      reason TEXT,
      residuals_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cfd_metrics (
      metric_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL,
      metric_unit TEXT,
      metric_source TEXT,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cfd_artifacts (
      artifact_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      artifact_ref TEXT,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cfd_validations (
      validation_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      validation_type TEXT NOT NULL,
      pass INTEGER NOT NULL,
      summary TEXT,
      baseline_json TEXT NOT NULL,
      actual_json TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      deltas_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cfd_events (
      event_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      source_client TEXT,
      source_model TEXT,
      source_agent TEXT
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_cases_updated ON cfd_cases (updated_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_cases_status_updated ON cfd_cases (status, updated_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_runs_case_created ON cfd_runs (case_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_runs_status_updated ON cfd_runs (status, updated_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_metrics_case_created ON cfd_metrics (case_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_metrics_run_created ON cfd_metrics (run_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_validations_case_created ON cfd_validations (case_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_validations_run_created ON cfd_validations (run_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_artifacts_case_created ON cfd_artifacts (case_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfd_events_entity_created ON cfd_events (entity_type, entity_id, created_at DESC);`);
}

function getCaseById(db: Database.Database, caseId: string): CfdCaseRecord | null {
  const row = db.prepare(`SELECT * FROM cfd_cases WHERE case_id = ?`).get(caseId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapCaseRow(row);
}

function requireCase(db: Database.Database, caseId: string): CfdCaseRecord {
  const record = getCaseById(db, caseId);
  if (!record) {
    throw new Error(`CFD case not found: ${caseId}`);
  }
  return record;
}

function getRunById(db: Database.Database, runId: string): CfdRunRecord | null {
  const row = db.prepare(`SELECT * FROM cfd_runs WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapRunRow(row);
}

function requireRun(db: Database.Database, runId: string): CfdRunRecord {
  const run = getRunById(db, runId);
  if (!run) {
    throw new Error(`CFD run not found: ${runId}`);
  }
  return run;
}

function getLatestRunByCase(db: Database.Database, caseId: string): CfdRunRecord | null {
  if (!caseId) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT *
       FROM cfd_runs
       WHERE case_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(caseId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapRunRow(row);
}

function getLatestValidationByCase(db: Database.Database, caseId: string): CfdValidationRecord | null {
  if (!caseId) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT *
       FROM cfd_validations
       WHERE case_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(caseId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapValidationRow(row);
}

function getLatestArtifactByCaseAndKind(db: Database.Database, caseId: string, kind: string): CfdArtifactRecord | null {
  if (!caseId || !kind) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT *
       FROM cfd_artifacts
       WHERE case_id = ? AND kind = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(caseId, kind) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapArtifactRow(row);
}

function appendCfdEvent(
  db: Database.Database,
  params: {
    entity_type: string;
    entity_id: string;
    action: string;
    summary: string;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }
) {
  const now = new Date().toISOString();
  const eventId = `event-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO cfd_events (
       event_id, created_at, entity_type, entity_id, action, summary, details_json,
       source_client, source_model, source_agent
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    now,
    params.entity_type,
    params.entity_id,
    params.action,
    params.summary,
    JSON.stringify(params.details ?? {}),
    params.source_client ?? null,
    params.source_model ?? null,
    params.source_agent ?? null
  );
  return {
    event_id: eventId,
    created_at: now,
  };
}

function countTable(db: Database.Database, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as Record<string, unknown>;
  return Number(row.count ?? 0);
}

function mapCaseRow(row: Record<string, unknown>): CfdCaseRecord {
  const statusRaw = String(row.status ?? "draft").trim().toLowerCase();
  const status: CfdCaseRecord["status"] =
    statusRaw === "ready" ||
    statusRaw === "running" ||
    statusRaw === "completed" ||
    statusRaw === "failed" ||
    statusRaw === "archived"
      ? statusRaw
      : "draft";

  return {
    case_id: String(row.case_id ?? ""),
    created_at: asIsoString(row.created_at),
    updated_at: asIsoString(row.updated_at),
    title: String(row.title ?? ""),
    objective: String(row.objective ?? ""),
    solver_family: String(row.solver_family ?? ""),
    units: String(row.units ?? "SI"),
    geometry_ref: asNullableString(row.geometry_ref),
    status,
    tags: parseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapRunRow(row: Record<string, unknown>): CfdRunRecord {
  const statusRaw = String(row.status ?? "queued").trim().toLowerCase();
  const status: CfdRunRecord["status"] =
    statusRaw === "running" ||
    statusRaw === "completed" ||
    statusRaw === "failed" ||
    statusRaw === "stopped"
      ? statusRaw
      : "queued";

  return {
    run_id: String(row.run_id ?? ""),
    case_id: String(row.case_id ?? ""),
    created_at: asIsoString(row.created_at),
    updated_at: asIsoString(row.updated_at),
    status,
    mesh_id: asNullableString(row.mesh_id),
    solver_version: asNullableString(row.solver_version),
    config_hash: asNullableString(row.config_hash),
    command: asNullableString(row.command),
    started_at: asNullableString(row.started_at),
    finished_at: asNullableString(row.finished_at),
    reason: asNullableString(row.reason),
    residuals: parseJsonObject(row.residuals_json),
    summary: parseJsonObject(row.summary_json),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapMetricRow(row: Record<string, unknown>): CfdMetricRecord {
  return {
    metric_id: String(row.metric_id ?? ""),
    case_id: String(row.case_id ?? ""),
    run_id: asNullableString(row.run_id),
    created_at: asIsoString(row.created_at),
    metric_name: String(row.metric_name ?? ""),
    metric_value: Number(row.metric_value ?? 0),
    metric_unit: asNullableString(row.metric_unit),
    metric_source: asNullableString(row.metric_source),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapArtifactRow(row: Record<string, unknown>): CfdArtifactRecord {
  return {
    artifact_id: String(row.artifact_id ?? ""),
    case_id: String(row.case_id ?? ""),
    run_id: asNullableString(row.run_id),
    created_at: asIsoString(row.created_at),
    kind: String(row.kind ?? ""),
    artifact_ref: asNullableString(row.artifact_ref),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapValidationRow(row: Record<string, unknown>): CfdValidationRecord {
  return {
    validation_id: String(row.validation_id ?? ""),
    case_id: String(row.case_id ?? ""),
    run_id: asNullableString(row.run_id),
    created_at: asIsoString(row.created_at),
    validation_type: String(row.validation_type ?? ""),
    pass: Number(row.pass ?? 0) === 1,
    summary: asNullableString(row.summary),
    baseline: parseJsonObject(row.baseline_json),
    actual: parseJsonObject(row.actual_json),
    thresholds: parseJsonObject(row.thresholds_json),
    deltas: parseJsonObject(row.deltas_json),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((entry) => String(entry)).filter(Boolean);
  } catch {
    return [];
  }
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asIsoString(value: unknown): string {
  if (typeof value !== "string") {
    return new Date().toISOString();
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : new Date().toISOString();
}

function buildReportMarkdown(input: {
  caseRecord: CfdCaseRecord;
  run: CfdRunRecord | null;
  metrics: CfdMetricRecord[];
  validations: CfdValidationRecord[];
  artifacts: CfdArtifactRecord[];
}): string {
  const { caseRecord, run, metrics, validations, artifacts } = input;

  const lines: string[] = [];
  lines.push(`# CFD Report Bundle: ${caseRecord.case_id}`);
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Case: ${caseRecord.case_id}`);
  lines.push(`- Title: ${caseRecord.title}`);
  lines.push(`- Status: ${caseRecord.status}`);
  lines.push(`- Solver Family: ${caseRecord.solver_family}`);
  lines.push(`- Units: ${caseRecord.units}`);
  lines.push(`- Geometry Ref: ${caseRecord.geometry_ref ?? "n/a"}`);
  lines.push(`- Objective: ${caseRecord.objective}`);
  lines.push("");

  lines.push("## Run Summary");
  if (!run) {
    lines.push("- No run found for this case.");
  } else {
    lines.push(`- Run ID: ${run.run_id}`);
    lines.push(`- Status: ${run.status}`);
    lines.push(`- Started: ${run.started_at ?? "n/a"}`);
    lines.push(`- Finished: ${run.finished_at ?? "n/a"}`);
    lines.push(`- Mesh ID: ${run.mesh_id ?? "n/a"}`);
    lines.push(`- Solver Version: ${run.solver_version ?? "n/a"}`);
    lines.push(`- Config Hash: ${run.config_hash ?? "n/a"}`);
    if (run.reason) {
      lines.push(`- Reason: ${run.reason}`);
    }
  }
  lines.push("");

  lines.push("## Latest Metrics");
  if (metrics.length === 0) {
    lines.push("- No metrics captured.");
  } else {
    for (const metric of metrics) {
      lines.push(
        `- ${metric.created_at} :: ${metric.metric_name} = ${metric.metric_value}${metric.metric_unit ? ` ${metric.metric_unit}` : ""} (source=${metric.metric_source ?? "n/a"})`
      );
    }
  }
  lines.push("");

  lines.push("## Latest Validations");
  if (validations.length === 0) {
    lines.push("- No validations recorded.");
  } else {
    for (const validation of validations) {
      lines.push(
        `- ${validation.created_at} :: ${validation.validation_type} :: pass=${validation.pass} :: ${validation.summary ?? "n/a"}`
      );
    }
  }
  lines.push("");

  lines.push("## Artifacts");
  if (artifacts.length === 0) {
    lines.push("- No artifacts recorded.");
  } else {
    for (const artifact of artifacts) {
      lines.push(`- ${artifact.created_at} :: ${artifact.kind} :: ${artifact.artifact_ref ?? "n/a"}`);
    }
  }

  return lines.join("\n");
}
