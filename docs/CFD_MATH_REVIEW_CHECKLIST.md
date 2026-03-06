# CFD Math Review Checklist

Use this as a quick sign-off sheet for each scenario/workflow configuration.

## A. Mesh Criteria

- [ ] Thresholds are approved for scenario and solver.
- [ ] Required mesh metrics are complete.
- [ ] Pass/fail operators match team policy.
- [ ] Boundary-layer/y+ expectations are encoded or documented.

## B. Solve Completion Logic

- [ ] Residual variables required for sign-off are defined.
- [ ] Residual target values are documented.
- [ ] Additional convergence monitors are captured (forces, mass balance, etc.).
- [ ] Case status transition policy is accepted.

## C. Validation Formula Policy

- [ ] Relative vs absolute tolerance mode is defined per metric.
- [ ] Zero-baseline handling is accepted.
- [ ] Directional/biased error behavior is considered where needed.
- [ ] Wildcard tolerance (`*`) behavior is approved.

## D. Units and Naming

- [ ] Every metric name has canonical unit.
- [ ] Sign convention is documented.
- [ ] QoI naming is standardized across teams.

## E. Baseline Integrity

- [ ] Baseline source is versioned and traceable.
- [ ] Baseline values are scenario-compatible.
- [ ] Tolerance values are justified and documented.

## F. Reporting and Audit

- [ ] Report bundle includes required acceptance fields.
- [ ] Failed validations are visible and actionable.
- [ ] ADR exists for threshold/formula choices.

## G. Production Readiness Decision

- [ ] Approved for pilot.
- [ ] Approved for production.
- [ ] Not approved (action items recorded).
