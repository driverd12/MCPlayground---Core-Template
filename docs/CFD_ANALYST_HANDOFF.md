# CFD Analyst Handoff and Review Guide

This document is for CFD analysts validating and customizing the MCP tooling.

## 1. Purpose and Scope

The `cfd` domain pack currently provides durable workflow orchestration and storage for CFD case/run metadata, mesh checks, metric capture, and baseline comparisons.

Important:

- The pack is intentionally solver-agnostic.
- It does not run a CFD solver by itself.
- It does not claim physical-model correctness out of the box.
- Several thresholds and formulas are generic defaults and must be reviewed by a CFD analyst before production use.

Code reference:

- `src/domain-packs/cfd.ts`

## 2. Where to Modify vs Where to Review

Use this boundary map when making changes.

Safe for tooling engineers:

- API transport, auth, and client wiring (`src/server.ts`, docs, IDE config).
- Metadata persistence fields that do not alter math semantics.
- Artifact path management and report formatting.
- Additional non-mathematical logging/events.

Requires CFD analyst review/sign-off:

- Mesh quality threshold defaults and pass/fail operators.
- Validation delta formulas and tolerance semantics.
- Residual interpretation and solve completion criteria.
- Units, sign conventions, and metric naming conventions.
- Any mapping from solver outputs into `cfd.post.extract` metrics.

Requires joint review (tooling + analyst):

- New solver-specific workflow tools.
- Changes to case/run status transitions.
- Schema changes that affect reproducibility or auditability.

## 3. Tool-by-Tool Behavior and Review Notes

### 3.1 `cfd.case.create` / `cfd.case.get` / `cfd.case.list`

What it does:

- Registers case identity, objective, solver family, units, geometry reference, and metadata.

Where to review:

- Case naming and metadata standards.
- Required fields for traceability in your organization.

Relevant code:

- `src/domain-packs/cfd.ts` lines ~247-365.

### 3.2 `cfd.mesh.generate`

What it does:

- Stores mesh metadata and artifact reference.
- Moves case status from `draft` to `ready` automatically.

Where to review:

- Whether status transition logic matches your CFD workflow.
- Required mesh metadata fields (e.g., y+ targets, prism layers, refinement levels).

Relevant code:

- `src/domain-packs/cfd.ts` lines ~367-444.

### 3.3 `cfd.mesh.check`

What it does:

- Evaluates observed mesh metrics against threshold values.
- Current checks:
  - `skewness <= threshold`
  - `non_orthogonality <= threshold`
  - `min_orthogonality >= threshold`
  - `max_aspect_ratio <= threshold`
- Default thresholds:
  - skewness: `4`
  - non_orthogonality: `70`
  - min_orthogonality: `20`
  - max_aspect_ratio: `1000`

Where to review:

- Whether these metrics and cutoffs are valid for your solver and use case.
- Whether additional metrics are required (e.g., determinant checks, y+ ranges, boundary-layer quality).
- Whether a single boolean pass/fail is sufficient or needs graded severity.

Relevant code:

- Schema: `src/domain-packs/cfd.ts` lines ~66-87.
- Threshold and check logic: lines ~460-495.

### 3.4 `cfd.solve.start` / `cfd.solve.status` / `cfd.solve.stop`

What it does:

- `start`: creates run row and marks case `running`.
- `status`: returns run + recent metrics/validations.
- `stop`: updates run status, records residuals (if provided), updates case status.

Current status mapping on stop:

- `failed` -> case `failed`
- `completed` -> case `completed`
- other non-queued states -> case `ready`

Where to review:

- Whether this status mapping matches your operational process.
- What should constitute run completion beyond status labels.
- Residual naming/units conventions and stopping criteria logic.

Relevant code:

- `start`: lines ~572-666.
- `status`: lines ~668-710.
- `stop`: lines ~712-799.

### 3.5 `cfd.post.extract`

What it does:

- Persists arbitrary QoI metrics (`name`, `value`, optional `unit` and `source`).

Where to review:

- Canonical metric list (e.g., `drag_coefficient`, `pressure_drop`, `mass_flow_rate`).
- Required units and sign conventions.
- Which metrics are mandatory for each scenario type.

Relevant code:

- `src/domain-packs/cfd.ts` lines ~801-872.

### 3.6 `cfd.validate.compare`

What it does:

- Compares `actual` values against `baseline` using per-metric tolerances.
- Supports `relative` and `absolute` mode.

Current formula:

- `delta_abs = |actual - baseline|`
- Absolute mode: `delta = delta_abs`
- Relative mode:
  - if `baseline == 0 && actual == 0` -> `delta = 0`
  - if `baseline == 0 && actual != 0` -> `delta = Infinity`
  - else `delta = delta_abs / |baseline|`
- Pass rule: `delta <= tolerance`

Where to review:

- Whether zero-baseline handling is appropriate for your metrics.
- Whether relative/absolute mode should vary by metric type.
- Whether tolerances should be asymmetric or directional.
- Whether additional statistical checks are required.

Relevant code:

- Schema: lines ~147-158.
- Formula logic: lines ~896-921.

### 3.7 `cfd.report.bundle`

What it does:

- Produces deterministic markdown summary from case/run/metrics/validations/artifacts.

Where to review:

- Required report sections for your release/compliance process.
- Which metrics and validations must be highlighted.

Relevant code:

- `src/domain-packs/cfd.ts` lines ~978-1039 and ~1413-1486.

### 3.8 `cfd.schema.status`

What it does:

- Returns row counts for `cfd_*` tables.

Where to review:

- Operational dashboards can use this to detect ingestion gaps.

Relevant code:

- `src/domain-packs/cfd.ts` lines ~1042-1062.

## 4. Data Model and Reproducibility Fields

CFD pack tables (auto-created by `ensureCfdSchema`):

- `cfd_cases`
- `cfd_runs`
- `cfd_metrics`
- `cfd_artifacts`
- `cfd_validations`
- `cfd_events`

Relevant code:

- `src/domain-packs/cfd.ts` lines ~1078-1173.

Minimum reproducibility metadata recommended per run:

- solver name and version
- configuration hash
- mesh id and artifact path
- units convention
- scenario description and objective
- baseline source/version used for validation

## 5. Mathematical Soundness Checklist

Use this checklist before adopting in production.

1. Mesh quality policy
- Confirm thresholds are scenario-appropriate.
- Confirm pass operators and additional constraints.

2. Convergence and stopping policy
- Define mandatory residual targets and monitor quantities.
- Define criteria for steady vs transient runs.

3. Validation semantics
- Confirm per-metric tolerance type (absolute/relative).
- Confirm zero-baseline handling rules.
- Confirm whether directional error matters.

4. Units and conventions
- Confirm units for every metric name.
- Confirm sign conventions (lift/drag/flux direction).

5. Benchmark alignment
- Document source of baseline values.
- Validate tolerance values against published or internal standards.

6. Report expectations
- Confirm required sections for acceptance and audit.
- Ensure report explicitly lists failed metrics and reasons.

## 6. Suggested Enhancements for Analyst-Led Accuracy

Recommended next tools for mathematically stronger workflows:

- `cfd.convergence.evaluate`
  - evaluate residual decay slope, not only final value.
- `cfd.units.validate`
  - enforce metric-unit compatibility.
- `cfd.validation.profile_apply`
  - apply pre-approved tolerance profiles by scenario type.
- `cfd.mesh.policy.evaluate`
  - centralize mesh policy per solver/regime.

## 7. Test and Sign-Off Procedure

1. Run baseline tests

```bash
npm test
```

2. Execute controlled sample case through full lifecycle.

3. Analyst review outputs:

- `cfd.mesh.check` result details
- `cfd.validate.compare` per-metric deltas
- `cfd.report.bundle` content

4. Log approved decisions:

- create ADR for accepted thresholds/formulas
- link decision to case/run entities using `decision.link`

## 8. Current Known Limitations

- No embedded solver invocation or native log parser.
- No physics-model-specific checks (e.g., turbulence-model suitability).
- No built-in uncertainty quantification.
- Validation is deterministic but simplistic unless customized.

Treat this pack as a durable orchestration and evidence layer, then calibrate the math logic with your CFD analyst before production rollout.
