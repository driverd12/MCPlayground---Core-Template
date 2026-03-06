# CFD Playbook

This fork defaults to `MCP_DOMAIN_PACKS=cfd`.

Before production use, complete:

- [CFD Analyst Handoff](./CFD_ANALYST_HANDOFF.md)
- [CFD Math Review Checklist](./CFD_MATH_REVIEW_CHECKLIST.md)

## Typical Workflow

1. `cfd.case.create` to define objective, solver family, geometry reference.
2. `cfd.mesh.generate` to register mesh generation metadata and artifact path.
3. `cfd.mesh.check` to apply quality thresholds.
4. `cfd.solve.start` to start run tracking.
5. `cfd.post.extract` to store key QoI metrics.
6. `cfd.validate.compare` to gate against benchmark tolerances.
7. `cfd.solve.stop` to finalize status and residual metadata.
8. `cfd.report.bundle` for reproducible reporting output.

## Recommended Governance Sequence

- `preflight.check` before `cfd.solve.start`.
- `policy.evaluate` before any destructive/cleanup actions.
- `run.begin` / `run.step` / `run.end` for end-to-end trace.
- `decision.link` + `adr.create` for major model/mesh/solver changes.

## Suggested Naming Conventions

- Case ids: `case-<program>-<scenario>-<date>`
- Run ids: `run-<case>-<iteration>`
- Artifact refs: stable local paths under `./artifacts/cfd/...`

## Accuracy Controls

- Persist solver version and config hash in `cfd.solve.start`.
- Use explicit mesh thresholds in `cfd.mesh.check`.
- Define tolerances in `cfd.validate.compare` per metric.
- Keep validation outputs and generated report bundles with each run.
- Create ADR records for accepted threshold and formula policy decisions.
