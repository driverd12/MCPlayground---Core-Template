# Local Training Lane

The local adapter lane prepares explicit training packets for bounded local adapter or LoRA work. It does not claim that weights changed unless adapter artifacts exist.

## Commands

```bash
npm run local:training:status
npm run local:training:bootstrap
npm run local:training:prepare
npm run local:training:train
npm run local:training:promote
npm run local:training:integrate
npm run local:training:cutover
```

## What `prepare` Writes

Each run writes a packet under `data/training/local_adapter_lane/<run_id>/`:

- `corpus.jsonl`: the curated full corpus after dedupe and length filtering
- `train.jsonl`: deterministic train split
- `eval.jsonl`: deterministic eval holdout
- `manifest.json`: the packet contract for the run

The registry entry is appended to `data/training/model_registry.json` with:

- `candidate_id`: stable local adapter candidate identifier
- `status`: current lane state, such as `prepared_blocked`
- `trainer_ready`: whether the local MLX trainer backend is importable
- `promotion_gate_ready`: whether the latest local capability report is clean
- `readiness_blockers`: explicit reasons the lane is not ready to run or promote

## Packet Guarantees

`manifest.json` now records:

- curation stats and source breakdown
- train and eval counts
- local evaluation targets for Ollama and MLX context
- benchmark and eval acceptance criteria
- rollback metadata for the currently promoted Ollama model
- safe promotion metadata that stays false until adapter artifacts and gates exist

## Train Command

`npm run local:training:train` runs a bounded MLX LoRA pass against the latest prepared packet.

- It uses a trainable MLX companion model by default instead of pretending the active Ollama runtime model is directly fine-tuned in place.
- On this Mac, the default companion is the cached `mlx-community/Qwen2.5-Coder-3B-Instruct-4bit` snapshot when present.
- It materializes `train.jsonl`, `valid.jsonl`, and `test.jsonl` for `mlx_lm.lora`, writes adapter artifacts under `adapter/`, records `training_metrics.json`, and runs one adapter-backed generation smoke test.
- It does not auto-promote the adapter into the live Ollama route. Training and promotion remain separate gates.

## Promotion Command

`npm run local:training:promote` runs the bounded registration gate for the latest trained adapter.

- It shells through the repo's benchmark and eval tooling instead of inventing a parallel acceptance path.
- The benchmark command runs `scripts/local_adapter_eval.mjs`, which scores deterministic base-vs-adapter prompts, writes a reward file, and exits non-zero if the gate fails.
- A passing gate records the candidate as `adapter_registered`, writes a durable registration artifact, and records explicit router/Ollama integration blockers instead of pretending the adapter is live.
- A failing gate records the candidate as `adapter_rejected` with a durable report and leaves the current runtime untouched.

## Integration Command

`npm run local:training:integrate` reads the accepted registration artifact and turns it into a real local backend.

- On Apple Silicon, the preferred path is now a managed `mlx_lm.server --adapter-path ...` launchd lane.
- When the accepted adapter family is compatible with Ollama's documented adapter import path, the same command can export an Ollama companion model from the trained Safetensors base-model directory plus the adapter directory.
- The integration step updates `.env`, verifies the live backend, runs bounded bootstrap and maintain refreshes, and only then records the adapter as live.
- The integration step does not silently make the new backend the router default. Reachable and default are separate decisions.

## Cutover Command

`npm run local:training:cutover` is the explicit router-default switch for an already integrated adapter.

- It refuses to run until the adapter is already reachable as `adapter_served_mlx` or `adapter_exported_ollama`.
- It reruns the adapter's eval suite before cutover, switches `model.router.default_backend_id`, runs a bounded maintain refresh, reruns the eval gate, verifies route selection, and rolls back to the previous default if any post-cutover check fails.
- On Ollama companion cutover, it also aligns `.env` with the promoted companion model so CLI-driven local inference does not drift from the router default.
- On success, the lane records `adapter_primary_mlx` or `adapter_primary_ollama`.

## Truthfulness Rules

- `training_intent.weights_modified` remains `false` during `prepare`
- `training_intent.executed` remains `false` during `prepare`
- `safe_promotion_metadata.allowed_now` remains `false` until adapter artifacts exist and the gate is green
- missing train commands or missing evidence are surfaced as readiness blockers instead of being treated as success
- a red promotion gate does not block training execution; it blocks later promotion and route cutover
- `adapter_registered` does not mean "served live". It means "accepted by the bounded gate and recorded as eligible for integration work."
- `adapter_served_mlx` means the accepted adapter is reachable through the managed MLX runtime.
- `adapter_exported_ollama` means the accepted adapter was exported into a local Ollama companion model and verified.

## Next Best Target

The next bounded implementation step after `cutover` is comparative soak coverage:

- keep benchmarking the new primary backend against the prior default
- add longer-lived router/office/autonomy soak runs before calling the new primary fully production-stable
- keep rollback explicit instead of allowing silent drift
