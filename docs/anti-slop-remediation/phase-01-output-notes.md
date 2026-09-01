# Phase 01 Output Notes

## Status

Complete

## Implemented

- Generation-only `decodeGeneratedChapterBrief(raw, contract)` accepts a chapter brief or throws `PageMapResponseInvalidError` (`PAGE_MAP_RESPONSE_INVALID`) with chapter index, expected range, violation codes, and affected or missing indexes.
- `generateChapterBrief` no longer uses `schema: z.unknown()`. It uses `generatedChapterBriefResponseSchema(contract)` so `generateJsonWithRetry` can take the schema-repair path.
- Chapter-brief calls use at most two repair attempts (`CHAPTER_BRIEF_REPAIR_ATTEMPTS = 2`) on one logical call. Physical attempts are stamped through `annotatePhysicalAttempt` / `stampChapterBriefPhysicalAttempt`.
- Local-to-global remapping of a complete local sequence is followed by a second contract validation pass.
- Generation-time invention of generic purpose, beat, and ending-pressure for malformed chapter-brief entries is removed on the strict path. Numeric and string page arrays cannot become a `ChapterBrief`.
- Alternate object field names remain accepted only when the value is a substantive object assignment. String beats are not accepted for compatibility.
- Domain schemas in `packages/core/src/schemas/book.ts` stay permissive for persisted data.
- Distilled Mechanics-style fixtures live in `packages/core/src/generation/testing/generatedChapterBriefFixtures.ts` and do not depend on `storage/`.
- Provider logs keep validation context. Job-facing `PAGE_MAP_RESPONSE_INVALID` stays a one-line error. Worker usage accounting records `chapterBriefViolationCodes` and related chapter-brief metadata on the original logical call.

## Files Changed

### Core generation

- `packages/core/src/generation/generatedChapterBriefAcceptance.ts`
- `packages/core/src/generation/generatedChapterBriefAcceptance.test.ts`
- `packages/core/src/generation/generatedPageResponse.ts`
- `packages/core/src/generation/generatedPageResponse.test.ts`
- `packages/core/src/generation/testing/generatedChapterBriefFixtures.ts`
- `packages/core/src/generation/pagesPageMap.ts`
- `packages/core/src/generation/pagesPageMap.test.ts`
- `packages/core/src/generation/pages.ts`
- `packages/core/src/generation/pages.test.ts`
- `packages/core/src/generation/pagesShared.ts`
- `packages/core/src/generation/generateJsonWithRetry.ts`
- `packages/core/src/generation/generateJsonWithRetry.test.ts`
- `packages/core/src/generation/pageQaRewriteTelemetry.ts`

### Core adapters

- `packages/core/src/adapters/types.ts`
- `packages/core/src/adapters/json.ts`
- `packages/core/src/adapters/gemini.ts`
- `packages/core/src/adapters/gemini.test.ts`
- `packages/core/src/adapters/openai.ts`
- `packages/core/src/adapters/openai.test.ts`
- `packages/core/src/adapters/openAiChatCompletionsText.ts`
- `packages/core/src/adapters/deepinfra.test.ts`
- `packages/core/src/adapters/fake.ts`

### Worker accounting

- `apps/worker/src/providers/usageAccounting.ts`
- `apps/worker/src/providers/usageAccounting.test.ts`
- `apps/worker/src/providers/loggedAdapters.ts`
- `apps/worker/src/providers/loggedAdapters.test.ts`
- `apps/worker/src/providers/runLogging.ts`
- `apps/worker/src/providers/textFallbackAccounting.ts`

## Tests Run

- `pnpm -F @book-maker/core test` — 147 files, 2353 tests passed (included in `pnpm check`).
- `pnpm -F @book-maker/worker test` — 141 files passed, 2 skipped; 1744 tests passed, 5 skipped.
- `pnpm check` — typecheck, lint, sizes, gotchas, subpaths, subpath-tests, test. Lint, gotchas, subpaths, subpath-tests, and all workspace tests passed. Core and worker typecheck passed.

Unrelated `pnpm check` failures, not introduced by this phase:

- `apps/api` typecheck errors in `bookEditOperationRetries.ts` / `.test.ts` (`billingLedgerEntryId` missing; `undefined` vs `GenerationRecoveryAttempt`; `null` vs Prisma JSON input). Those files are not in this diff.
- File-size budget on `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, and `restructurePages.test.ts`. None of those files are in this diff, and they are not grandfathered.

## Metrics Or Replay Results

Not applicable. This phase is a generated-response seam with distilled fixtures, not a production-book replay.

## Deviations From Plan

- Shared alias keys live in `generatedPageResponse.ts` rather than inside the chapter-brief decoder. This is not a second page decoder and is not Phase 02 collision repair.
- `PAGE_INDEX_OUT_OF_ORDER` and `CHAPTER_INDEX_MISMATCH` exist as codes. Out-of-order indexes are sorted after acceptance; a mismatched `chapterIndex` on an otherwise valid page is overwritten to the expected chapter. Both match “ordered / expected chapter after permitted normalization.”
- Numeric page arrays have a dedicated fixture and test, but they are not a row in `malformedGeneratedChapterBriefFixtures`. Later phases that only loop that table must still include the dedicated numeric-array fixture.
- Whole-book `generateWholeBookPageMap` (`targetPages ≤ 24`) still uses `pageProductionBeatSchema` plus `parsePageMapFromModel`, which may invent generic assignments on blank fields. The spec’s regression control required that whole-book deterministic fallback stay unchanged outside the chapter-brief path. Phase 02 owns the full-map seam.

## Known Risks

- Books of 24 pages or fewer still take the permissive whole-book path. Phase 02 must not assume those briefs went through `decodeGeneratedChapterBrief`.
- Persisted malformed briefs are untouched (non-goal).
- Generic detection rejects the listed production templates; close cousins that keep leftover stopwords as content can still pass.
- Gemini constrained output uses the canonical ChapterBrief JSON Schema, so alias-shaped replies are a decoder concern for json_object providers, not Gemini.

## Handoff To Phase 02

Phase 02 may assume that newly generated *chapter-brief* responses that pass `decodeGeneratedChapterBrief` are structurally valid (objects, exact coverage, substantive fields, no mixed/duplicate local numbering). It must not assume:

- Independently valid briefs are mutually distinct across the full production map.
- Whole-book maps (`targetPages ≤ 24`) were accepted by the same strict decoder.
- Existing persisted briefs are structurally valid.
