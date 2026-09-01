# Phase 07 Output Notes

## Status

Superseded on 2026-09-02. The first live book through the page-time gate spent 26 minutes in
final QA with 22 pages stuck in `FAILED_QA`; replayed over 1,200 pages from ten shipped books the
gate rejected 295 model-approved pages and the compile audit clustered whole chapters of distinct
pages in every book (sentence-initial words counted as named entities; two shared cue words counted
as a causal chain). The page-time gate, `scoreTreatmentPair`, `SAME_CHAPTER_TREATMENT_REPETITION`
and the bulk-pass `distinctnessGuidance` were removed. The evidence ledger (assignment-side
anchors) stays. See `packages/core/src/generation/CLAUDE.md` → "Repetition gates and the evidence
ledger". The notes below describe the removed implementation.

## Implemented

- **Shared scorer.** `scoreTreatmentPair` is exported from `manuscriptTreatmentAudit.ts` with a
  `TreatmentMatch` naming shared entities, evidence, causal and conclusion terms; thresholds
  unchanged. `manuscriptSignatures.ts` gains `sharedTerms` and `SAME_CHAPTER_FALLBACK_DISTANCE`.
- **Page-time gate.** `pagesTreatmentQa.ts` (new) scores a draft against its same-chapter finished
  pages and fails `repetitionOk` through one new rule in `pagesLocalQa.ts`. The near-verbatim gate
  (`repeatedRecentPage`) moved into the same module. Message shape:
  `Page re-treats <entities> with <the same evidence (…) / causal chain (…) / closing claim (…)> as an earlier page of this chapter (from page N); advance, challenge, or apply that treatment with different evidence.`
  The pre-existing title rule's "adjacent page N" was respelled `(from page N)` for the same
  harvest.
- **Draft-then-polish guidance.** `treatmentGuidanceForDraft` scores the bulk draft per chapter
  range; `PolishPageOptions.distinctnessGuidance` reaches `polishPageDraft`'s instruction.
- **Evidence ledger.** `claim` / `evidenceAnchors` on `pageProductionBeatSchema` (aliases read,
  absent keys omitted). `evidenceLedger.ts` (new) owns the mode gate and the prompt lines for
  producer / repair / critic / writer / reviewer audiences. All five brief producers, the critic
  merge, the dedup rewrite schema and payload, `compactPageBriefForScope`, the compact review
  scope, the single-page draft system content, the three bulk writers, the polish prompt and the
  reviewer prompt carry it. `productionMapAnchors.ts` (new) audits `SHARED_EVIDENCE_ANCHORS`
  (sparse, non-blocking, non-dense, own `beatFinding`) and `MISSING_EVIDENCE_ANCHORS`
  (diagnostic). `productionMapIntegrity.ts` drives the repair loop on `blocking || sparse` and
  returns with `advisory_unresolved` when only a shared anchor survives the cycles.
- **MOCK_AI.** `dryRunPageBeat` carries `claim` and two anchors; the `dedupe-page-beats` branch
  returns fresh ones for a flagged page that carried them.

## Files Changed

### Core (packages/core/src)

- `generation/manuscriptTreatmentAudit.ts`, `generation/manuscriptSignatures.ts`
- `generation/pagesTreatmentQa.ts` (new), `generation/pagesLocalQa.ts`
- `generation/evidenceLedger.ts` (new), `generation/productionMapAnchors.ts` (new)
- `generation/productionMapAudit.ts`, `generation/generatedPageResponse.ts`,
  `generation/generatedChapterBriefAcceptance.ts`, `generation/pagesPageMap.ts`,
  `generation/pageMapCritic.ts`, `generation/pageBeatDedup.ts`
- `generation/pages.ts`, `generation/pagesShared.ts`, `generation/pagesReview.ts`,
  `generation/pageDraftMessages.ts`
- `schemas/book.ts`, `adapters/fake.ts`, `index.ts`
- `generation/antiSlopCalibration.ts`, `generation/testing/pageBeatDedupFixtures.ts`
- Tests: `pagesTreatmentQa.test.ts` (new), `productionMapAnchors.test.ts` (new),
  `manuscriptStructuralAudit.test.ts`, `pagesFinalLocalQa.test.ts`, `productionMapAudit.test.ts`,
  `pageMapCritic.test.ts`, `pageBeatDedupBatch.test.ts`, `generatedChapterBriefAcceptance.test.ts`,
  `pagesPageMap.test.ts`, `pageDraftMessages.test.ts`, `schemas/book.test.ts`

### Worker (apps/worker/src)

- `generation/bookPasses.ts`, `generation/productionMapIntegrity.ts`
- Tests: `generation/bookPasses.test.ts`, `generation/finalQaPageTargets.test.ts`,
  `generation/bookStateIntegrity.test.ts`

### Docs

- `docs/anti-slop-remediation/phase-07-assignment-ledger-and-page-time-treatment-gate.md`,
  this file, `packages/core/src/generation/CLAUDE.md`, root `CLAUDE.md`.

## Tests Run

- `pnpm check` — the `test` gate passes in every workspace (core, db, api 1706, worker 1767, web
  114). The four other failing gates are pre-existing at the base commit and untouched here: API
  typecheck (`bookEditOperationRetries.ts` / `.test.ts`, `projectStatus.ts:465`), the
  `unicorn/no-useless-spread` error at `planner.ts:213`, the file-size debts on
  `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, `restructurePages.test.ts`, and the
  gotcha-index drift at root `CLAUDE.md:393` ("Integrity is not a quality-gate checkbox…", absent
  from the core generation `CLAUDE.md` at HEAD). `packages/core/src/adapters/fake.ts` crossed the
  budget with the ledger and was split along its dry-run-table seam into `fakeDryRunBeats.ts`.
- `pnpm anti-slop:replay` — 28 fixtures, 28 passed, including `boundary:shared-evidence-anchors`.
- Targeted: `pagesTreatmentQa.test.ts`, `productionMapAnchors.test.ts`, `evidenceLedger.test.ts`,
  `fakeDryRunBeats.test.ts`, `fake.test.ts` (analytical dry run audits clean on both brief
  producers), plus every suite named under Files Changed.
- **Not run:** the live `MOCK_AI` end-to-end. The Docker stack on this host runs real providers
  (no `MOCK_AI` in the worker's environment) and a host mock worker would race it for the same
  queue, so the offline twin in `fake.test.ts` stands in. To run it once the stack is down:
  `MOCK_AI=true pnpm dev:api` + `MOCK_AI=true pnpm dev:worker`, create a HISTORY book and a STORY
  book, and read the `production-map-integrity` log line and the chapter brief's `claim` /
  `evidenceAnchors` in the run log.

## Deviations From Plan

- `MISSING_EVIDENCE_ANCHORS` is diagnostic only (one finding per chapter) rather than a sparse
  repair target: routing a page whose only fault is a missing ledger through the whole-assignment
  rewrite would replace a sound beat to fill two fields.
- The shared-anchor code is named `SHARED_EVIDENCE_ANCHORS` so the existing alphabetical ordering
  in `sparseRewriteFindingsFromAudit` lets a `NEAR_DUPLICATE_BEAT` finding for the same page win
  the rewrite slot.
- `pagesFinalLocalQa.ts` still hands the gate its last four pages with no chapter range (the
  audit's fallback distance applies); widening it was not needed for parity.

## Known Risks

- Named-entity extraction is `\p{Lu}`-based, so the page-time gate is as inert on Persian,
  Arabic and CJK prose as the compile detector it mirrors.
- The ledger depends on the model returning the fields; a map that omits them drafts exactly as
  before, with `MISSING_EVIDENCE_ANCHORS` in the audit log as the only trace.
- Anchor matching is lexical after folding; two spellings that share no token ("Versailles" /
  "the 1919 peace settlement") are not the same anchor.
- Live precision of the page-time gate (rewrites it triggers per book, overturn rate) is
  unmeasured, like every gate in this program.

## Handoff

Live gates from Phase 05 remain unmeasured; Phase 06 automatic consolidation remains off. The
first measurements worth taking are the page-time gate's trigger rate on a clean-control set and
the share of analytical maps that return a complete ledger.
