# Practical Reasoning Scaling for MASTER-MOLD

## Objective

Increase planning horizon, answer reliability, and next-step predictiveness in MASTER-MOLD without drifting into novelty-chasing or transcript-only "thinking harder."

The practical thesis is simple:

- use more test-time compute only when task difficulty justifies it
- branch and verify instead of emitting one long unverified trace
- compress working state into durable memory instead of repeatedly rereading transcripts
- use environment feedback whenever the task can support it

This is the shortest path to making the system feel more anticipatory and less reactive.

## What To Prioritize First

### 1. Adaptive self-consistency and best-of-N

Why it matters:

- Self-consistency improves reasoning by sampling multiple candidate paths and selecting the most consistent answer rather than trusting one greedy decode.
- In MASTER-MOLD terms, this is the cheapest immediate way to improve "token predictiveness" for planning, diagnosis, and verification tasks.

Where it fits:

- [src/tools/playbook.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/playbook.ts:404)
- [src/tools/task_compiler.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/task_compiler.ts:469)
- [src/tools/model_router.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/model_router.ts:214)

Implementation shape:

1. Only activate on `planning`, `research`, and `verification` tasks above a difficulty threshold.
2. Generate `N=2..4` bounded candidates instead of a single candidate.
3. Score candidates with the existing verification or evidence lane instead of majority vote alone.
4. Log candidate count, selection rationale, token cost, and downstream success.

Current MASTER-MOLD contract:

- `task.compile` now emits an explicit `task_execution.reasoning_compute_policy` for adaptive best-of-N lanes.
- Runtime workers render that policy into their session brief and require compact `reasoning-evidence.json` instead of hidden reasoning dumps.
- The durable policy records activation reasons, candidate count, evidence rerank strategy, and compact-evidence-only transcript handling.
- Adaptive policies now carry a non-blocking `compute_budget` contract so workers can log candidate count, latency, token usage, and estimated cost for ROI review.
- `task.summary`, `kernel.summary`, and Agent Office now aggregate compute telemetry from completed reasoning audits so high-compute ROI is operator-visible.
- Kernel and Agent Office summaries now also expose compute-telemetry coverage, missing telemetry task IDs, and an attention item when completed high-compute work skipped requested telemetry.
- Completion audits now mark adaptive tasks `needs_review` when observed candidates exceed the declared compute-budget cap, even if the selected candidate evidence is otherwise valid.

Do not:

- run best-of-N on every task
- confuse longer traces with better traces

## 2. Plan-and-solve decomposition before execution

Why it matters:

- Many failures are not "reasoning depth" failures. They are missing-step failures.
- A separate planning pass improves horizon length even before adding more compute.

Where it fits:

- [src/tools/task_compiler.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/task_compiler.ts:487)
- [src/tools/playbook.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/playbook.ts:420)
- [src/tools/trichat.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/trichat.ts:8094)

Implementation shape:

1. Force a short plan pass for multi-step objectives before mutation or external action.
2. Convert the plan into explicit subtasks with expected artifacts.
3. Reject plans that skip constraints, rollback notes, or evidence requirements.

Good default:

- use this by default for broad objectives
- skip it for tiny single-step tasks

Current MASTER-MOLD contract:

- Compiler-generated tasks that require a plan pass now carry `task_execution.plan_quality_gate`.
- The gate requires compact proof that constraints were covered, rollback was noted, and evidence requirements were mapped before mutation or final decision.
- Completion audits mark the reasoning policy `needs_review` when a declared plan quality gate is missing, while legacy hand-written tasks that only set `require_plan_pass` remain compatible.

## 3. Critique-revise loops with durable reflection

Why it matters:

- Reflexion-style gains come from storing concise lessons from failure and injecting them on the next attempt.
- This is closer to "agent consciousness" than endless inner monologue because it creates durable self-correction.

Where it fits:

- [src/tools/playbook.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/playbook.ts:440)
- [src/tools/eval.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/eval.ts:1)
- [src/tools/knowledge.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/knowledge.ts:103)

Implementation shape:

1. After a failed variant, persist a tiny reflection artifact:
   - what failed
   - what evidence exposed it
   - what should change on retry
2. Feed only the compressed reflection into the next attempt.
3. Cap reflection length aggressively so memory stays sharp instead of bloated.

Do not:

- append full prior transcripts
- let reflection mutate into vague postmortems

Current MASTER-MOLD contract:

- High-compute task failures capture a compact, grounded reflection and inject it into retry memory preflight.
- Completed tasks that fail reasoning-policy audit now also capture a `task-reasoning-review` reflection instead of treating `needs_review` as a transient event only.
- Agent-session recovery tasks inherit the review reflection through `memory_preflight.top_reflections`, so the next attempt sees the missing evidence fields without replaying transcripts.

## 4. Verifier-guided reranking

Why it matters:

- The biggest practical jump usually comes from better candidate selection, not better first-pass sampling.
- MASTER-MOLD already has evidence and verification primitives; use them as selection pressure.

Where it fits:

- [src/tools/playbook.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/playbook.ts:478)
- [src/tools/task_compiler.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/task_compiler.ts:537)

Implementation shape:

1. Add a verifier score to planning and mutation candidates.
2. Prefer candidates that satisfy artifact expectations and reduce contradiction risk.
3. Keep the verifier cheap and local-first for most tasks.

This is the right bridge toward process-based verifiers later.

Current MASTER-MOLD contract:

- `verifier_rerank.required_selected_fields` is now enforced by task completion audits when evidence rerank is active.
- A selected candidate must provide compact selected-path verifier evidence such as `verifier_score` and `contradiction_risk`; otherwise the task can complete, but the reasoning policy is marked `needs_review`.

## 5. Retrieval-backed working memory compression

Why it matters:

- Long conversations make the system less predictive because important state gets diluted.
- Compression plus retrieval beats carrying raw transcript mass.

Where it fits:

- [src/tools/knowledge.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/knowledge.ts:103)
- [src/tools/task_compiler.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/task_compiler.ts:469)

Implementation shape:

1. Maintain a small state object for each active objective:
   - goal
   - constraints
   - current plan
   - unresolved questions
   - known failures
2. Retrieve from durable memory first, then only pull transcript slices when needed.
3. Refresh summaries when the system learns something materially new.

Current MASTER-MOLD contract:

- `task.compile` emits a compact `working_memory.memory_budget` with limits for expected evidence, unresolved questions, known failures, citations, and text previews.
- Runtime worker briefs render the memory budget and explicitly block raw transcript replay by default.
- `working_memory.refresh_triggers` tells workers when to refresh the compact state: failed reasoning audits, new grounded reflections, plan or constraint changes, or contradiction from fresh evidence.
- Retry and reasoning-review recovery paths now normalize merged `memory_preflight.top_reflections`, dedupe by memory ID, cap previews at 320 chars, and cap keywords so stale transcript-sized reflections cannot leak back into retries.

## 6. Shallow tree search on hard branches

Why it matters:

- Tree-of-Thoughts and LATS-style methods help when local greedy decisions cause global failure.
- They are useful for hard planning and tool-using tasks, but too expensive as a default.

Where it fits:

- [src/tools/task_compiler.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/task_compiler.ts:487)
- [src/tools/autonomy_maintain.ts](/Users/dan.driver/Documents/Playground/Agentic%20Playground/MASTER-MOLD/src/tools/autonomy_maintain.ts:847)

Implementation shape:

1. Restrict search depth to `2..3`.
2. Expand only the top `2..3` branches.
3. Use environment feedback, tests, or verifiers to prune aggressively.
4. Fall back to single-path execution when branch confidence is high.

This should be reserved for:

- web or desktop automation
- repo-wide debugging
- multi-option repair tasks

Current MASTER-MOLD contract:

- `task.compile` now tags hard planning and verification branches with a bounded `reasoning_compute_policy.shallow_branch_search` contract.
- Activation is limited to high or critical risk goals, multi-stream plans, or constraint-heavy objectives; ordinary mutation lanes stay single-path.
- The policy caps search at depth 2, expands only top-scoring candidates, and prunes with artifact fit, contradiction risk, rollback safety, and environment feedback.
- Runtime worker briefs now render the branch-search contract and task completion audits require compact branch-search evidence before marking the reasoning policy satisfied.
- Completion audits now extract observed branch count and depth from compact branch evidence and mark shallow-search tasks `needs_review` when they exceed declared branch budgets.
- Task summaries and Agent Office now expose active branch-search counts so operators can see when this expensive lane is in use.

## 7. Newer lane worth testing, but not making default

### Budget forcing and simple test-time scaling

Why it matters:

- The `s1` result suggests some reasoning models improve when you explicitly control how long they keep thinking and force a second look before termination.

How to use it here:

- keep it as an experimental router policy on reasoning-capable backends
- measure whether extra thinking tokens improve verification pass rate more than they increase latency

Current MASTER-MOLD contract:

- Budget forcing is explicit opt-in through `metadata.reasoning_experiments.budget_forcing` or a direct `reasoning_compute_policy.budget_forcing` contract.
- Runtime worker briefs require one bounded forced second-look pass after initial candidate selection.
- Completion audits mark the reasoning policy `needs_review` unless compact `budget_forcing_review` or `forced_second_look` evidence is present.
- Task summaries and Agent Office expose active budget-forcing counts so this experimental lane stays operator-visible.

Do not:

- assume this helps all providers
- apply it to mundane execution tasks

## What Not To Prioritize Tonight

- deep MCTS everywhere
- training-heavy approaches like Quiet-STaR or process reward model training
- giant hidden chain-of-thought dumps
- any method that cannot be evaluated with current local tests, benchmarks, or operator-visible behavior

## Suggested Experiment Order

1. Add adaptive best-of-N plus verifier reranking for planning and verification tasks.
2. Add compact reflection artifacts on failed variants inside the autoresearch loop.
3. Tighten working-memory compression so active objectives stop depending on raw transcript replay.
4. Add shallow branch search only to the hardest automation or debugging tasks.
5. Test budget-forcing only on backends that already benefit from explicit reasoning budgets.

## Metrics That Actually Matter

- pass rate on bounded evals
- contradiction rate between plan and execution
- number of retries per completed objective
- latency and token cost per accepted result
- operator-visible truthfulness in Agent Office

If a method increases visible "thinking" but does not improve these, it is theater.

## Source Papers

- Self-consistency: [arXiv:2203.11171](https://arxiv.org/abs/2203.11171)
- ReAct: [arXiv:2210.03629](https://arxiv.org/abs/2210.03629)
- Plan-and-Solve: [arXiv:2305.04091](https://arxiv.org/abs/2305.04091)
- Tree of Thoughts: [arXiv:2305.10601](https://arxiv.org/abs/2305.10601)
- Reflexion: [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)
- LATS: [arXiv:2310.04406](https://arxiv.org/abs/2310.04406)
- Compute-optimal test-time scaling: [arXiv:2408.03314](https://arxiv.org/abs/2408.03314)
- Tree Search for Language Model Agents: [arXiv:2407.01476](https://arxiv.org/abs/2407.01476)
- s1 simple test-time scaling: [arXiv:2501.19393](https://arxiv.org/abs/2501.19393)
