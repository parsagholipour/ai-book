# Phase 02 Output Notes

## Status

Complete

## Implemented

`prepareChapterSetups` now returns chapter setups whose briefs cover the target book exactly and contain no unresolved blocking assignment-integrity findings; otherwise it throws `PAGE_MAP_INTEGRITY_UNRESOLVED` before `resetBookForDirectGeneration`. Callers do not coordinate critic, batches, re-audits, or dense regeneration.

Full-map `auditProductionMap(briefs, contract)` (async) reports coverage, generic/metadata-only assignments, duplicate fingerprints, near-duplicate beats, chapter corruption density, sparse findings, and dense chapter indexes. Detection scans the complete map with `rewriteSlotLimit: 0`. `MAX_BEAT_DEDUP_FINDINGS = 12` remains a per-call rewrite bound only.

Corruption policy is `PRODUCTION_MAP_DENSE_CORRUPTION_THRESHOLD = 0.25` (exported, tested). Sparse page patches run in batches of twelve. Dense chapters regenerate through Phase 01 `strategy.generateChapterBrief` / `decodeGeneratedChapterBrief`. The entire map is re-audited after every merge or regeneration. At most two full repair cycles. A failed detector, failed merge, or remaining blocking findings do not degrade to a clean map. Progress writes remain best-effort. Stop requests escape every loop.

Integrity is mandatory on every tier and is not gated by `quality("beatDedup")`. Optional `pageMapCritic` still runs only on the whole-book path, after a clean integrity pass, then integrity runs again. Clean maps make no repair or regeneration model call.

Rollout control: `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` logs `would_block` with full finding structure and retains prior draft-anyway behavior. Default is enforcement ON. Independent of model tier. Findings are never hidden.

## Files Changed

### Core

- `packages/core/src/generation/productionMapAudit.ts` (new)
- `packages/core/src/generation/productionMapAudit.test.ts` (new)
- `packages/core/src/generation/pageBeatDedup.ts` (`selectFindingsForRewriteCall`, provider-call metadata)
- `packages/core/src/generation/pageBeatDedupDetect.ts` (`rewriteSlotLimit`)
- `packages/core/src/generation/pageBeatDedup.test.ts`
- `packages/core/src/generation/testing/pageBeatDedupFixtures.ts`
- `packages/core/src/generation/generatedChapterBriefAcceptance.ts` (`isSubstantivePageAssignment` exported)
- `packages/core/src/generation/pages.ts`
- `packages/core/src/generation/pageMapCritic.ts` (comment)
- `packages/core/src/generation/qualityGates.ts` (beatDedup summary)
- `packages/core/src/adapters/types.ts` (`ProductionMapRepairProviderCallMetadata`)
- `packages/core/src/index.ts`

### Worker

- `apps/worker/src/generation/productionMapIntegrity.ts` (new)
- `apps/worker/src/generation/bookState.ts` (`dedupeBriefBeats` replaced)
- `apps/worker/src/generation/bookState.test.ts` (obsolete degrade-and-continue tests removed)
- `apps/worker/src/generation/bookStateIntegrity.test.ts` (new)
- `apps/worker/src/generation/bookPasses.test.ts`
- `apps/worker/src/providers/usageAccounting.ts`
- `apps/worker/src/providers/usageAccounting.test.ts`

## Tests Run

- `pnpm -F @book-maker/core exec vitest run src/generation/productionMapAudit.test.ts src/generation/pageBeatDedup.test.ts src/generation/pageBeatDedupDetect.ts src/generation/pageBeatDedupBatch.test.ts src/generation/pageBeatDedupRewrite.test.ts src/generation/generatedChapterBriefAcceptance.test.ts src/generation/pagesPageMap.test.ts` — 6 files, 95 tests passed.
- `pnpm -F @book-maker/worker exec vitest run src/generation/bookState.test.ts src/generation/bookStateIntegrity.test.ts src/generation/bookPasses.test.ts src/providers/usageAccounting.test.ts` — 4 files, 82 tests passed.
- `pnpm -F @book-maker/core typecheck` — passed.
- `pnpm -F @book-maker/worker typecheck` — passed.
- `pnpm check` — lint, gotchas, subpaths, subpath-tests, and all workspace tests passed (core 2365, worker 1747 passed / 5 skipped). Core and worker typecheck passed.

Unrelated `pnpm check` failures, not introduced by this phase:

- `apps/api` typecheck errors in `bookEditOperationRetries.ts` / `.test.ts` (`billingLedgerEntryId` missing; `undefined` vs `GenerationRecoveryAttempt`; `null` vs Prisma JSON input). Those files are not in this diff.
- File-size budget on `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, and `restructurePages.test.ts`. None of those files are in this diff.

## Metrics Or Replay Results

Not a production-book replay. Distilled fixtures only (including `sparseFivePageCollisionBriefs`, `saturatedBriefs`, Mechanics-style similar-topic chapters, and a 31-chapter / 30-collision sparse map). No `storage/` dependency.

## Deviations From Plan

- `auditProductionMap` is async because `findDuplicatePageBeats` yields the event loop. The spec sketch was synchronous.
- Enforcement defaults ON in this phase, with `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` as a named rollout control. The spec’s “default to enforcement after Phase 05” is implemented early so correctness does not wait on calibration.
- `beatDedup` remains in `GenerationQualityRevision` for operator copy / cost attribution. It no longer gates integrity. Do not treat enabling it in compiled defaults as the fix.
- Whole-book `pageMapCritic` runs only after a clean integrity pass, then integrity runs again. Fan-out still has no critic.
- Full-map audit uses `findDuplicatePageBeats(..., { rewriteSlotLimit: 0 })` so later collisions are first-class findings rather than `suppressedMatches`. Default `rewriteSlotLimit` stays 12 so existing rewrite-slot naming tests remain valid.

## Known Risks

- Shadow mode still returns a dirty map. Leave unset in production.
- The 25% dense threshold is explicit but not calibrated (Phase 05).
- Whole-book maps (`targetPages ≤ 24`) can still *generate* generic assignments; this phase refuses them before draft, at the cost of repair/regen calls.
- `isSubstantivePageAssignment` can still accept close cousins of generic templates that keep leftover content tokens (Phase 01 risk).
- A provider repair failure falls back to dense chapter regeneration of the batch’s chapters, which is heavier than a successful sparse patch.
- Integrity model calls (`dedupe-page-beats`, `generate-chapter-brief`) can occur even when the beatDedup quality checkbox is off. Admin `qualityGateCosts` still maps `beatDedup` → `dedupe-page-beats` only.

## Handoff To Phase 03

Phase 03 may assume new books were drafted from a structurally valid production map: exact coverage, no unresolved generic assignments, and no unresolved blocking duplicate/near-duplicate fingerprints. It still must detect prose-level repetition caused by writer behavior, weak but technically distinct beats, manual edits, or older persisted books.

Do not assume:

- Whole-book ≤24 generation used `decodeGeneratedChapterBrief` (it did not; Phase 02 audit is what caught generics).
- Existing persisted briefs or in-flight books were repaired.
- Quality-state COMPLETE vs REVIEW_REQUIRED changed (non-goal).
- The 25% threshold or beatDedup checkbox is a correctness control.

Rollout flag inherited: `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY` (`shadow` | unset/enforce). Detector version: `production-map-audit-v1`.
