# Phase 04 Output Notes

## Status

Complete

## Implemented

Deterministic Phase 03 clusters now drive bounded review packs of **actual manuscript prose**. A distinct mechanical purpose, `review-manuscript-structure`, adjudicates those packs. High-confidence corroborated duplication becomes a model `error` (`CORROBORATED_STRUCTURAL_DUPLICATION`) and maps to `blocked` → project `REVIEW_REQUIRED`. Medium confidence stays a warning (`review_recommended`, still `COMPLETE`). Low confidence and `keep` emit no extra issue. Original deterministic findings are never dropped.

Clean manuscripts (no treatment / recap / cross-chapter candidate clusters) make **no** structural-review call. Outcome compiles still run this path when `skipFinalReview` is false, even if `finalBookQa` is off — integrity is not optional polish. Edits, detached repairs, and presentation reprints skip it.

Pack construction is pure and deterministic:

- Candidate codes: `SAME_CHAPTER_TREATMENT_REPETITION`, `RECAP_BACKTRACKING`, `CROSS_CHAPTER_CONCEPT_REPETITION`
- Overlapping pair findings merge
- Prefer `wouldBlock`, then cluster size / evidence
- ≤4 pages per pack, 4000-character prose bound with a labeled `\n…\n` cut
- ≤3 packs per call, ≤2 calls per book
- Neighboring context is `contentKind: "summary"`; detector excerpts are `detector_evidence`
- Leftover clusters become `STRUCTURAL_REVIEW_BUDGET_EXCEEDED` (warning), not a pretend-exhaustive review

Publication still writes MD/PDF/EPUB. `buildManuscriptQualityReport` now blocks on **any** `severity === "error"`. Existing final-book QA, chapter-transition, and page QA reviewers still emit **warnings**. Shadow `diagnostics.wouldBlock` is still not the live publication rule.

Provider logging goes through the existing logged text adapter (`purpose` + `projectId`). Cost is attributed under `finalBookQa`. No new `CreditOperation`. `MOCK_AI` / `FakeTextModelAdapter` returns `{ clusters: [] }` for this purpose.

Final-book QA language now calls `pageMap` abbreviated planning/progression context and `openingPages` actual opening prose. It no longer says complete compiled Markdown was supplied, and it must not judge full-book repeated-page quality from summaries. Chapter-transition review now sends labeled opening/closing prose excerpts, labeled transition excerpts, and `pageSummaries` marked as summaries — not every page’s undifferentiated body.

No automatic consolidation. No mutation of completed books.

## Files Changed

### Core

- `packages/core/src/generation/manuscriptReviewPacks.ts` (new)
- `packages/core/src/generation/manuscriptReviewPacks.test.ts` (new)
- `packages/core/src/generation/manuscriptStructuralReview.ts` (new; purpose, schema, validation, corroboration)
- `packages/core/src/generation/manuscriptStructuralReview.test.ts` (new)
- `packages/core/src/generation/manuscriptQuality.ts` (block on explicit error severity)
- `packages/core/src/generation/manuscriptQuality.test.ts`
- `packages/core/src/generation/manuscriptQualityIssue.ts` (`manuscriptFinding` may set `source`)
- `packages/core/src/generation/pagesReview.ts` (final-QA terminology)
- `packages/core/src/generation/pagesReviewFinalQaPayload.test.ts` (new)
- `packages/core/src/adapters/modelTiers.ts` (`review-manuscript-structure` mechanical)
- `packages/core/src/adapters/textRouting.test.ts`
- `packages/core/src/adapters/fake.ts` / `fake.test.ts`
- `packages/core/src/index.ts`

### Worker

- `apps/worker/src/handlers/compileExport.ts` (split first; wires structural review after post-repair deterministic checks)
- `apps/worker/src/handlers/compileExportChapterReview.ts` (new; narrowed chapter payload)
- `apps/worker/src/handlers/compileExportChapterReview.test.ts` (new)
- `apps/worker/src/handlers/compileExportStructuralReview.ts` (new; bounded provider call)
- `apps/worker/src/handlers/compileExportStructuralReview.test.ts` (new)
- `apps/worker/src/handlers/compileExportPolicy.test.ts` (publication: REVIEW_REQUIRED vs COMPLETE, clean-path no-call, stop, provider failure)
- `apps/worker/src/handlers/compileExportQuality.test.ts` (chapter describe moved out so this file stays under 900)
- `apps/worker/src/handlers/testing/compileExportMocks.ts` (purpose-aware default JSON)

### API

- `apps/api/src/admin/qualityGateCosts.ts` (attribute `review-manuscript-structure` to `finalBookQa`)
- `apps/api/src/admin/qualityGateCosts.test.ts`

## Tests Run

- `pnpm -F @book-maker/core exec vitest run src/generation/manuscriptReviewPacks.test.ts src/generation/manuscriptStructuralReview.test.ts src/generation/manuscriptQuality.test.ts src/generation/pagesReview.test.ts src/generation/pagesReviewFinalQaPayload.test.ts src/generation/manuscriptStructuralAudit.test.ts src/adapters/textRouting.test.ts src/adapters/fake.test.ts` — 8 files, 94 passed.
- `pnpm -F @book-maker/core exec vitest run src/generation/manuscriptQualityPolicy.test.ts` — passed in the earlier core batch (with structural audit).
- `pnpm -F @book-maker/worker exec vitest run src/handlers/compileExportStructuralReview.test.ts src/handlers/compileExportChapterReview.test.ts src/handlers/compileExportPolicy.test.ts` — 3 files, 21 passed.
- `pnpm -F @book-maker/worker exec vitest run src/handlers/compileExport.test.ts src/handlers/compileExportStandDown.test.ts src/handlers/compileExportQuality.test.ts src/handlers/compileExportStandDownVerdict.test.ts` — 4 files, 84 passed.
- `pnpm -F @book-maker/worker exec vitest run src/handlers/compileExportFenceUnreadable.test.ts src/handlers/compileExportEpubFailure.test.ts src/handlers/compileExportRepairPublication.test.ts` — passed as part of a 7-file / 63-test worker run with policy + structural + chapter.
- `pnpm -F @book-maker/api exec vitest run src/admin/qualityGateCosts.test.ts` — 3 passed.
- `pnpm -F @book-maker/core typecheck` — passed.
- `pnpm -F @book-maker/worker typecheck` — passed.

Full `pnpm check` was not re-run. Known unrelated failures remain API typecheck in `bookEditOperationRetries.ts` / `.test.ts` and file-size budget on `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, `restructurePages.test.ts`. New Phase 04 files are under 900 (`compileExport.ts` is 812 after the split).

## Metrics Or Replay Results

Pack and call limits are named constants, asserted in unit tests, not measured against live books. Local adjudication used distilled Indus paraphrase pages (`fourParaphrasedIndusWeightPages`) plus mocked provider results. No `storage/` dependency. No production cost sample yet — Phase 05 should calibrate `MANUSCRIPT_REVIEW_PACKS_PER_CALL`, `MANUSCRIPT_REVIEW_MAX_CALLS`, and prose bounds from real token logs.

## Deviations From Plan

- `compileExport.ts` was already 899 lines. Chapter-transition review and the new structural call were split onto `compileExportChapterReview.ts` and `compileExportStructuralReview.ts` before adding logic. `compileExport.ts` re-exports the chapter helpers so existing imports still resolve.
- Chapter-transition tests moved to `compileExportChapterReview.test.ts` rather than growing `compileExportQuality.test.ts` (it was 897 lines).
- Candidate packs are only the three structural families above. Cadence, hedging, near-duplicate, and `STRUCTURAL_SLOP_SATURATION` are not sent for this adjudication (`STRUCTURAL_SLOP_SATURATION` is already a deterministic error).
- Structural review is gated on `ownsOutcome && !skipFinalReview`, not the `finalBookQa` quality flag.
- `fourParaphrasedIndusWeightPages` is exported from `@book-maker/core` so worker compile tests can load detector-accurate prose without crossing `rootDir`.
- Corroboration copies deterministic `metrics` (including `wouldBlock`) onto the model issue; self-reported confidence alone cannot block.
- A cluster is valid only when every named page index (canonical and duplicates) belongs to **one** pack in the call. Membership in the call-wide union is not enough: a high-confidence cluster that mixes pack A’s canonical page with a pack B duplicate fails validation and is not corroborated, so it cannot emit `CORROBORATED_STRUCTURAL_DUPLICATION`.

## Known Risks

- A legitimate same-subject chapter that shares technical vocabulary can still cluster; a high-confidence model corroboration will now block `COMPLETE`. Precision is uncalibrated.
- Provider failure preserves deterministic warnings and never claims model approval, so a would-block cluster that the model never saw still publishes `COMPLETE` if those warnings are only advisory.
- Pack budget can leave clusters unadjudicated (`STRUCTURAL_REVIEW_BUDGET_EXCEEDED` is a warning). That is honest, not exhaustive.
- `skipFinalReview` edits do not re-run structural adjudication; a later edit that *introduces* duplication is only caught by deterministic checks, and those warnings still do not re-grade a previously passed book.

## Handoff To Phase 05

Phase 05 may assume:

- Purpose name: **`review-manuscript-structure`** (mechanical lane; compile-attributed under `finalBookQa`; no new billed reader operation).
- Call bounds: 3 packs/call, 2 calls/book, 4 pages/pack, 4000 prose chars/page, 1800 output tokens, temperature 0.
- Blocking map: high-confidence corroborated duplication → model `error` → report `blocked` → `REVIEW_REQUIRED`. Advisory findings remain `review_recommended` and `COMPLETE`. Integrity errors still block.
- `diagnostics.wouldBlock` is still shadow evidence, not the publication switch. Do not treat it as already-enforced.
- Clean path: no structural call when `selectManuscriptReviewPacks` returns no packs.
- `MOCK_AI` default is empty clusters (`keep`).
- Final-book QA and chapter-transition prompts no longer describe summaries as the compiled book.
- Detector version remains `manuscript-structural-audit-v1`.
- No automatic consolidation; that is Phase 06.

Phase 05 should calibrate pack/call/token bounds, treatment/recap overlap thresholds, which families enter the candidate set, and whether medium-confidence corroboration should ever block. Do not add an unbounded manuscript-wide model review. Preserve stop-request escape, ownership, repair, revision, and stand-down fencing. A later edit still cannot be graded against stale pages.
