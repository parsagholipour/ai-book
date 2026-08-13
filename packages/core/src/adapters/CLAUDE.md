# Provider adapters

Every call to an outside model goes through here: Gemini, the OpenAI-compatible providers,
Alibaba, DeepSeek, DeepInfra, plus routing (`textRouting.ts`, `modelTiers.ts`), fallback
(`textFallback.ts`, `imageFallback.ts`) and `retry.ts`.

`factory.ts` decides what a job gets. With `MOCK_AI=true` it returns the fakes in `fake.ts` —
canned text, images, speech, embeddings and research — which is how the whole pipeline runs with no
tokens and no network. With `MOCK_AI=false` and no key it throws rather than silently degrading.

The worker never constructs an adapter directly; it wraps a set with `createLoggedProviders`
(`apps/worker/src/providers/loggedAdapters.ts`) so every call is logged, costed and stop-checked.

## Errors and retries

`ProviderHttpError` **carries the HTTP status as a field**, not just in its message. A status that
only appears inside message text matches none of `isRecoverableNetworkError`'s patterns and would
never be retried — that is a real bug this shape exists to prevent. When a response names a
`retryDelay`, `withRecoverableNetworkRetry` waits it out instead of backing off blindly, but only up
to `PROVIDER_RETRY_AFTER_CEILING_MS`; a longer cooldown is a daily cap rather than a per-minute one,
so it is reported as unrecoverable and every layer gives up at once instead of spending its whole
budget failing the same way.

Stop-abort signalling is currently wired into the DeepSeek and Gemini adapters only.

## Tests

Colocated, and they stub `process.env` rather than reading a `.env` — nothing here needs a real key
to run.

## Research and citations

- **A cited source is stored as the publisher's own address, never Google's.** Search grounding
  hands back every citation as a `vertexaisearch.cloud.google.com/grounding-api-redirect/...`
  wrapper: it names Google as the source in the chat, and it expires — fatal for a Sources list
  recompiled from `ResearchSource` rows forever. `GeminiResearchAdapter.search` unwraps at ingest
  (`packages/core/src/adapters/groundingRedirect.ts`), which is the only moment the wrapper is sure
  to still resolve, and `researchCitationsForExport` retries at compile time for rows written before
  that, writing the fix back. An unresolved wrapper is kept rather than dropped — a worse link still
  beats a missing citation — and the app's `displayHost` names no publisher for one. That retry
  lives in `packages/db` because **two** processes compile a book: the API renders inline when a
  compiled file is missing, and its own copy of the citation map skipped the unwrap entirely, so
  the same book's Sources list named Google or the publisher depending on which side rendered it.

## Speech, retries and quotas

- **Narration fails in three provider-shaped ways, and all three guards are load-bearing.** One bad
  chunk used to lose the whole audiobook. (1) The TTS model answers a bare `400 INVALID_ARGUMENT`
  for a handful of ordinary passages *only* when the style prompt is prefixed to them — either half
  alone is accepted, and it reproduces exactly — so `GeminiSpeechAdapter.synthesize` reads a refused
  chunk again without the direction and flags `stylePromptDropped`. (2) A per-minute speech quota
  makes 429 the normal case rather than an outage, so `ProviderHttpError` carries the status as a
  *field* — a status that appears only inside the message text matches none of
  `isRecoverableNetworkError`'s patterns and would never be retried — along with the `retryDelay` the
  response names, which `withRecoverableNetworkRetry` waits out instead of backing off blindly —
  but only up to `PROVIDER_RETRY_AFTER_CEILING_MS`. A cooldown longer than that is the *daily* cap,
  not the per-minute one, so `isRecoverableNetworkError` calls it unrecoverable and every layer
  gives up at once rather than spending its whole budget failing the same way.
