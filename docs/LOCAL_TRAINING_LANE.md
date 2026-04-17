# Local Training Lane

The local adapter lane prepares explicit training packets for bounded local adapter or LoRA work. It does not claim that weights changed unless adapter artifacts exist.

## Commands

```bash
npm run local:training:status
npm run local:training:verify
npm run local:training:bootstrap
npm run local:training:prepare
npm run local:training:train
npm run local:training:promote
npm run local:training:integrate
npm run local:training:cutover
npm run local:training:soak
npm run local:training:watchdog
```

## What `prepare` Writes

Each run writes a packet under `data/training/local_adapter_lane/<run_id>/`:

- `corpus.jsonl`: the curated full corpus after dedupe and length filtering
- `train.jsonl`: deterministic train split
- `eval.jsonl`: deterministic eval holdout
- `manifest.json`: the packet contract for the run

The manifest now carries a dataset-integrity contract for those files:

- SHA-256 hashes for `corpus.jsonl`, `train.jsonl`, and `eval.jsonl`
- membership hashes for each split
- proof that train and eval are disjoint and reconstruct the curated corpus exactly
- duplicate and invalid-row counts so later steps can fail closed on tampering or malformed rows

The registry entry is appended to `data/training/model_registry.json` with:

- `candidate_id`: stable local adapter candidate identifier
- `status`: current lane state, such as `prepared_blocked`
- `trainer_ready`: whether the local MLX trainer backend is importable
- `promotion_gate_ready`: whether the latest local capability report is clean
- `readiness_blockers`: explicit reasons the lane is not ready to run or promote

## Verify Command

`npm run local:training:verify` is the filesystem-backed evidence gate for the lane.

- It re-reads the latest registry row, manifest, registration artifact, and corpus/train/eval files from disk instead of trusting previously printed status.
- It fails closed on internal drift such as registry/manifest id mismatches, missing corpus artifacts, packet hash drift, train/eval overlap, split-membership drift, missing adapter artifacts in trained states, missing promotion metadata in registered states, premature `safe_promotion_metadata.allowed_now`, or missing rollback metadata on a live primary.
- It reports stale primary-watchdog confidence as a warning, not a fake success, so a primary adapter can be reachable and still show that its proof is old.
- It does not claim that new weights were trained or promoted on this run; it only verifies whether the lane's persisted evidence still matches the state being reported.

## Packet Guarantees

`manifest.json` now records:

- curation stats and source breakdown
- train and eval counts
- dataset-integrity hashes and split-membership proof
- local evaluation targets for Ollama and MLX context
- benchmark and eval acceptance criteria
- rollback metadata for the currently promoted Ollama model
- safe promotion metadata that stays false until adapter artifacts and gates exist

## Train Command

`npm run local:training:train` runs a bounded MLX LoRA pass against the latest prepared packet.

- It refuses to run on a stale or tampered prepared packet; rerun `npm run local:training:prepare` if the dataset hashes or split proof drift.
- It uses a trainable MLX companion model by default instead of pretending the active Ollama runtime model is directly fine-tuned in place.
- On this Mac, the default companion is the cached `mlx-community/Qwen2.5-Coder-3B-Instruct-4bit` snapshot when present.
- It materializes `train.jsonl`, `valid.jsonl`, and `test.jsonl` for `mlx_lm.lora`, writes adapter artifacts under `adapter/`, records `training_metrics.json`, and runs one adapter-backed generation smoke test.
- It does not auto-promote the adapter into the live Ollama route. Training and promotion remain separate gates.

## Promotion Command

`npm run local:training:promote` runs the bounded registration gate for the latest trained adapter.

- It rechecks the prepared packet-integrity contract before running benchmark or eval gates, so a mutated dataset cannot silently inherit an older training packet identity.
- It shells through the repo's benchmark and eval tooling instead of inventing a parallel acceptance path.
- The benchmark command runs `scripts/local_adapter_eval.mjs`, which scores deterministic base-vs-adapter prompts, writes a reward file, and exits non-zero if the gate fails.
- A passing gate records the candidate as `adapter_registered`, writes a durable registration artifact, and records explicit router/Ollama integration blockers instead of pretending the adapter is live.
- A failing gate records the candidate as `adapter_rejected` with a durable report and leaves the current runtime untouched.
- Promotion is now registration-only: if the candidate already has integration, cutover, or rollback evidence, `promote` fails closed instead of rewriting the manifest or registry back to an earlier stage.

## Integration Command

`npm run local:training:integrate` reads the accepted registration artifact and turns it into a real local backend.

- On Apple Silicon, the preferred path is now a managed `mlx_lm.server --adapter-path ...` launchd lane.
- When the accepted adapter family is compatible with Ollama's documented adapter import path, the same command can export an Ollama companion model from the trained Safetensors base-model directory plus the adapter directory.
- The integration step updates `.env`, verifies the live backend, runs bounded bootstrap and maintain refreshes, and only then records the adapter as live.
- The integration step does not silently make the new backend the router default. Reachable and default are separate decisions.

## Cutover Command

`npm run local:training:cutover` is the explicit router-default switch for an already integrated adapter.

- It refuses to run until the adapter is already reachable as `adapter_served_mlx` or `adapter_exported_ollama`.
- It now also refuses to run unless the integration step recorded a successful live-ready proof for the chosen MLX or Ollama target: `integration_result.ok` must be true, the target's `integration_consideration.*.live_ready` flag must be true, and the target-specific blockers list must be empty.
- It reruns the adapter's eval suite before cutover, switches `model.router.default_backend_id`, runs a bounded maintain refresh, reruns the eval gate, verifies route selection, and rolls back to the previous default if any post-cutover check fails.
- On Ollama companion cutover, it also aligns `.env` with the promoted companion model so CLI-driven local inference does not drift from the router default.
- On success, the lane records `adapter_primary_mlx` or `adapter_primary_ollama`.

## Soak Command

`npm run local:training:soak` is the bounded comparative confidence pass for the new primary backend.

- It only runs after the adapter is already the active router default.
- It reruns the benchmark suite, eval suite, and route verification for several cycles, using the recorded rollback backend as the recovery target.
- It compares each cycle's reward score against the accepted promotion score and the stored baseline contract, then trips deterministic rollback if a severe regression or repeated soft regressions appear.
- If any cycle fails, it restores the previous router default immediately and records the rollback in both the manifest and the registration artifact.
- If every cycle passes, it records a green primary-soak result without changing the rollback path silently.

## Watchdog Command

`npm run local:training:watchdog` is the bounded freshness-enforcement path for the active primary adapter.

- It only applies when the accepted adapter is already the active router default.
- It checks whether the last green soak is missing, failed, or older than the watchdog freshness contract.
- If confidence is still fresh, it records a skip cleanly instead of rerunning work.
- If confidence is stale, it reruns the bounded soak automatically so the primary either refreshes its proof or trips rollback.

## Truthfulness Rules

- `training_intent.weights_modified` remains `false` during `prepare`
- `training_intent.executed` remains `false` during `prepare`
- `safe_promotion_metadata.allowed_now` remains `false` until adapter artifacts exist and the gate is green
- `npm run local:training:verify` must be able to reconstruct the claimed lane state from the filesystem, registry row, and manifest without relying on operator memory
- missing train commands or missing evidence are surfaced as readiness blockers instead of being treated as success
- a red promotion gate does not block training execution; it blocks later promotion and route cutover
- `adapter_registered` does not mean "served live". It means "accepted by the bounded gate and recorded as eligible for integration work."
- `adapter_served_mlx` means the accepted adapter is reachable through the managed MLX runtime.
- `adapter_exported_ollama` means the accepted adapter was exported into a local Ollama companion model and verified.
- `adapter_primary_mlx` or `adapter_primary_ollama` means the adapter is the active router default.
- a green soak result means the new primary survived repeated bounded checks; it does not mean the rollback path should be deleted.
- later persisted integration, cutover, soak, or watchdog evidence outranks a stale top-level status string when the lane reports readiness.
- rerunning `npm run local:training:promote` after integration, cutover, or rollback evidence exists is blocked instead of regressing the lane back to `adapter_registered`.

## Next Best Target

The next bounded implementation step after `soak` is longer-duration production evidence:

- add longer-lived office/autonomy/runtime stress runs while the new primary stays active
- promote only after repeated overnight evidence, not one short soak
- keep rollback explicit instead of allowing silent drift
