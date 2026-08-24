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

Stop-abort signalling is wired into every provider HTTP text adapter. OpenAI-wire adapters pass
the signal as the SDK's per-request option via `openAiRequestOptions`; Gemini passes it as
`abortSignal` in the request config. Every request path on those adapters must preserve it,
including streamed JSON and tool calls; adapters with no HTTP client ignore it.

- **A cancellation raised inside a tool escapes the tool loop; only a tool *failure* becomes a tool
  result.** `runToolLoop`'s whole point is that a tool blowing up is recoverable — the throw comes
  back as `{error: "The <tool> tool failed: …"}` and the model works around it. A stop is the one
  error that must not: answered that way it reads to the model as "that tool is unavailable", so
  the loop continues, the model finishes, and the caller writes and bills an answer for a run the
  reader already cancelled. `executeToolCall` (`toolLoop.ts`) therefore rethrows whatever the
  loop's `rethrowIf` claims, defaulting to `isCancellationError` (`retry.ts`). That predicate asks
  the error *who it is* — an `AbortError` or `StopRequestedError` `name`, an `ABORT_ERR` code, over
  the error and every nested `cause` — and not what it says, because the class it is really looking
  for, the worker's `StopRequestedError`, sits on the far side of
  `apps/* → packages/db → packages/core` and cannot be imported here; it holds the line the worker
  holds with `isStopRequestedError` in `prepareEmbedding`, `writePreparedEmbedding` and
  `degradeRetrievalArm`'s `rethrowIf`. **Identity, not prose**: the older `isStopOrAbortError`
  reads message text too, which is right where a false positive only *suppresses* something — a
  retry not taken in `isSpeechProviderFallbackError`, a fallback provider not tried in
  `isTextProviderFallbackError`, an error that still surfaces as the failure it is — and wrong
  here, where it would promote a recoverable failure to a fatal one. This one loop is shared by the
  worker's writer tools and by the API's two chat loops, so a provider or HTTP client whose message
  merely says "request aborted" would have ended a chat turn the model could have worked around.
  Narrowing costs the worker nothing: `LoggingEmbeddingAdapter.embed` runs `assertJobNotStopped` on
  its way out, so a cancellation reaching a tool is already a `StopRequestedError` when it is
  thrown, and everything downstream gates on `instanceof StopRequestedError`, narrower still. The
  rule belongs to the loop rather than to one tool because every tool inherits it: `search_memory`
  (`generation/writerTools.ts`) is only the first writer tool that reaches a provider at all —
  `lookup_page`, `lookup_entity` and `search_research` read what is already in memory or in the
  database — and the stop comes from the `assertJobNotStopped` inside
  `LoggingEmbeddingAdapter.embed`, which `searchStoredMemory` reaches through
  `retrieveSemanticPageMemory`. **The caller owes the same.**
  `generatePageDraftWithWriterTools` catches everything the loop throws, because a tool-loop fault
  must not fail a book — but a stop caught there falls back to the ordinary draft path and writes
  the page anyway, so it re-raises instead. The API's two loops (`mobileCreation.ts`,
  `bookEditIntent.ts`) have no stop signal to honour at all, and today nothing of theirs can trip
  the default either — `web_search` replaces whatever it caught with fixed model-facing prose,
  `read_page` swallows its load with `.catch(() => null)`, and the settings tools cannot throw. That
  is an accident of three handlers rather than a property of the surface, which is what
  `rethrowIf: null` is for: an explicit "nothing a tool throws ends this turn", worth passing at
  both call sites the next time either grows a tool that reaches the network directly.

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
