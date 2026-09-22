# Durable generation trace context

Implements P3-03 from the [20-page tier audit](tier-audit-20-pages-2026-09-20.md).

## Provider requests and usage

The immutable run events reconstructed by `readRunLog` now include:

- `text.<operation>.provider_request`: `callId`, `purpose`, `requestIndex`, `provider`, `model`, `requestedMaxTokens`, and `effectiveMaxTokens`. Operations are `generateText`, `generateJson`, `generateWithTools`, and `streamText`.
- `text.<operation>.provider_usage`: the same `callId`, a `providerRequest` object containing the dispatch context, and provider-reported `usage`, including `reasoningTokens` when reported. Streaming usage snapshots are cumulative, not additional charges.
- Existing response/error events retain their format and also include `providerRequest`. Raw stream responses include reported `usage` when available. The original request's `maxTokens` remains for existing readers and gains the explicit `requestedMaxTokens` alias.

For example, an Ultra chapter requested at 10,608 tokens can be dispatched with `requestedMaxTokens: 10608` and `effectiveMaxTokens: 48000`; its usage event records reasoning consumption against that actual allowance. A widened JSON retry records its new 72,000-token request and allowance. A fallback to Gemini has its own provider identity, request index and allowance under the same call ID.

`requestIndex` counts adapter dispatches within a call. A schema/output-budget retry enters a new logged call; network retries and provider fallbacks inside a call increment its index. Transparent HTTP retries inside an SDK reuse the same dispatch parameters. An omitted explicit limit is `null`, not a guessed provider default. Missing reasoning usage remains absent; it is never inferred as zero. Gemini's thinking count is preserved separately while remaining included in its total output count, so it is not billed twice.

OpenAI Responses, Gemini, and the shared chat-completions implementation (Alibaba, DeepSeek, DeepInfra and OpenRouter) emit this telemetry. Observer failures are best-effort and cannot trigger a provider retry. No credentials are added to trace payloads.

## Dossier decisions

`generation.composed_chapters.dossier.*` events include the search host outcomes, drop/rejection reasons, fetch/extraction failures and provenance verdicts already emitted by dossier retrieval. They go to the same durable run log as provider calls, as soon as each decision occurs. Pending writes are awaited on both success and failure.

Every event receives `chapterIndex` and `retrievalStage`. Chapter-source retrieval adds a one-based `round`; case recovery records its `queryOffset`. Core event fields such as deadline `stage` are preserved. A completed chapter retrieval emits `dossier.coverage` with document/excerpt counts and its coverage status. Cancellation does not produce a false completed-coverage event.

## Validation

- `textProviderTracing.test.ts`: provider SDK fixtures through the worker logger and object-store JSONL, covering text, JSON, tools, raw streams, truncation, widened retries, fallback identity, absent/larger limits, and failing observers.
- `sourceDossier.test.ts`: real search and language-drop decisions through object-store JSONL, immediate persistence, both retrieval rounds, cancellation and diagnostic-write failures.
- `composedEvidence.test.ts`: recovery-path event forwarding and draining with chapter/query context.
- `textProviderRequest.test.ts`: direct adapter calls survive synchronous/asynchronous diagnostic callback failures and leave unreported reasoning counts absent.

These checks use injected provider responses and in-memory object storage; they do not make paid model calls or regenerate the original four books.
