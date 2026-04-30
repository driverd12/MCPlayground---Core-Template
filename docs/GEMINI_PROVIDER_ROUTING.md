# Gemini Provider Routing Prep

This is the operator plan for making Gemini useful in MASTER-MOLD without depending on a fragile logged-in desktop session.

## Current Stance

- Gemini CLI can remain visible in Agent Office as a configured support lane, but it should not be treated as ready when the operator is logged out, quota-exhausted, or cooled down.
- Do not piggyback a Gemini CLI or Code Assist OAuth session for other agents. The supported automation path is a Google AI Studio API key or Vertex AI identity.
- Gemini 429s should be modeled as provider/router state: project/model quota, model pressure, retry-after/cooldown, and fallback routing.

## Routing Model

1. Prefer cheap, fast Gemini models for bounded support work.
   - Routine summaries, critique, and comparison: Flash lane.
   - High-value deep analysis: Pro lane only when the task asks for it.
2. Track cooldowns per backend key.
   - Developer API key lane: `provider=gemini`, `mode=developer_api`, `project_id`, `model_id`.
   - Vertex lane: `provider=gemini`, `mode=vertex`, `project_id`, `location`, `model_id`.
3. On quota exhaustion or service overload:
   - Record the 429 and any retry metadata.
   - Mark that backend temporarily ineligible.
   - Cut over to the next eligible Gemini backend only if it is a distinct configured backend with its own supported auth/project/location.
   - Fall back to Claude/Codex/local lanes when all Gemini backends are cooling down.
4. Only use region cutover for Vertex AI.
   - Vertex exposes regional and global endpoints.
   - AI Studio/Gemini Developer API quotas are project/model/tier concerns; random region switching should not be used as a quota workaround.

## Non-Secret Config Shape

These names are intentionally non-secret placeholders. Secrets belong in 1Password or the existing provider secret bridge, not in tracked files.

```dotenv
GEMINI_PROVIDER_MODE=developer_api
GEMINI_DEFAULT_MODEL=gemini-2.5-flash
GEMINI_FALLBACK_MODELS=gemini-2.5-flash-lite,gemini-2.5-flash
GEMINI_RATE_LIMIT_COOLDOWN_SECONDS=90
GEMINI_RATE_LIMIT_MAX_COOLDOWN_SECONDS=900
GEMINI_VERTEX_LOCATIONS=global,us-central1,us-east5
GEMINI_ROUTER_FALLBACK_PROVIDERS=codex,claude-cli,ollama
```

## Operator Checklist

- Confirm which path is intended: AI Studio API key, Vertex AI, or CLI-only/manual.
- Add non-secret backend metadata to provider config.
- Store keys/service-account material only through the provider secret bridge.
- Probe each configured backend with a tiny request before marking it ready.
- Surface last 429, cooldown expiry, selected backend, and fallback reason in Agent Office.

## References

- Gemini CLI FAQ: supported third-party automation should use a Vertex AI or Google AI Studio API key, not OAuth piggybacking. <https://geminicli.com/docs/resources/faq/>
- Gemini API rate limit docs: limits vary by model/tier and can be upgraded or increased through the Google project billing/quota path. <https://ai.google.dev/gemini-api/docs/rate-limits>
- Vertex AI generative AI locations docs: regional and global endpoints are a Vertex deployment concern. <https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations>
