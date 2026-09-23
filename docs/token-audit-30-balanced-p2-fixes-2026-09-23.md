# Balanced 30-page audit: P2 follow-up

The follow-up assigns each clear P2 fix to a separate subagent. Inventory effort and chapter expansion strategy remain unchanged because they require a quality/cost choice. The original [30-page audit](token-audit-30-balanced-2026-09-23.md), saved book, provider traces, token totals and stored QA remain the baseline.

| Finding | Disposition |
| --- | --- |
| P2-01: empty or incomplete claim inventories | Deferred: effort and quotation-fidelity calibration |
| P2-02: derived arithmetic sent for external verification | Fixed for a narrow, positively proven numeric subset |
| P2-03: restored figure label invalidates source review | Fixed: review the publication projection |
| P2-04: repeated whole-chapter drafts for length | Deferred: expansion strategy and coherence tradeoff |
| P2-05: next page's paragraph becomes a table row | Fixed: preserve the table-to-prose block boundary |

## Changes

### P2-02 — Numeric proof before external verification

The source reviewer excludes a calculation only when the numeric parser positively proves it and every occurrence has a recognized mathematical context. An empty arithmetic-error list is not proof: the parser also returns no findings for syntax it cannot evaluate. Standalone calculations and a small closed set of mathematical sentence forms qualify; empirical premises, attribution, units, citations, mixed prose, unknown variables, unsupported syntax and wrong calculations remain in source review.

Exclusions happen before verifier batching and source retrieval can act on the review. Claim IDs stay stable, incomplete inventories stay incomplete, and the trace records excluded and remaining counts. Excluded calculations are not recorded as source-supported facts. Broader symbolic derivations and explanation classification remain outside this fix.

Offline replay of the 174 captured final claims excludes exactly four unsupported calculations in chapter 2 (`c7`, `c8`, `c25`, `c30`), retaining all other 170 claims. The retained unsupported subset is 116 rather than 120; this is a deterministic reclassification, not a new model verdict or a change to stored QA. Even a correct calculation stays in review when introduced by a colon, because that introduction might attribute it to a source. Evidence: [arithmetic replay](../.scratch/token-audit-30-balanced-2026-09-23/p2-arithmetic/result.json).

Implementation: [sourceClaimArithmetic.ts](../packages/core/src/generation/sourceClaimArithmetic.ts), [arithmeticCheck.ts](../packages/core/src/generation/arithmeticCheck.ts), [sourceClaimReview.ts](../packages/core/src/generation/sourceClaimReview.ts). Regression: [sourceClaimArithmetic.test.ts](../packages/core/src/generation/sourceClaimArithmetic.test.ts).

### P2-03 — Review the restored publication draft

Finalization now restores each page's figure once before final source verification. Verification reads the same figure stand-in representation that compile checks, and publication uses that prepared draft. The digest itself remains sensitive to substantive text changes; no new text is hidden to make an old verdict pass.

The frozen chapter-2 replay reproduces the old mismatch on generated pages 7–12 and confirms that the restored representation matches compile. It preserves all 41 original claim verdicts and the unsupported findings. Tests also cover reuse of an unchanged reviewed figure and invalidation after changed prose, titles, stand-ins and captions written in prose.

Captions and data inside raw figure JSON were already outside the source-review projection. This fix does not claim to verify them. Expanding that coverage needs a separate decision about review scope and cost.

Implementation: [composedChaptersFinalize.ts](../apps/worker/src/generation/composedChaptersFinalize.ts). Regression: [composedChaptersFinalizeFigures.test.ts](../apps/worker/src/generation/composedChaptersFinalizeFigures.test.ts). Evidence: [figure-finalize-replay.json](../.scratch/p2-fixes-30-balanced-2026-09-23/figure-finalize-replay.json).

### P2-05 — Keep following prose outside a table

Markdown assembly now inserts a blank block boundary when a page-ending table is followed by a block without a table cell separator. It retains single-newline continuation for tables, ordinary paragraphs, lists, quotations and code, while keeping page-anchor offsets aligned with the assembled manuscript. The shared Markdown fix reaches PDF, EPUB and Word.

The regression exercises actual export rendering, including a table spanning three pages, following prose with an escaped pipe, and a following image and caption. Replaying captured pages 15–16 changes the malformed 16-cell table to its correct 12 cells and places the Handbook paragraph outside the table, with all page-anchor offsets valid. The candidate PDF was rendered and visually inspected. All nine typography fixtures, totaling 51 pages, have zero pixel drift.

The captured page bodies are the reproduction input: the audit's reconstructed `book.md` already includes page comments and blank boundaries, so that file alone does not reproduce the original PDF defect. Evidence: [captured-page-replay.json](../.scratch/p2-table-boundary/captured-page-replay.json), [candidate excerpt PDF](../.scratch/p2-table-boundary/excerpt-after.pdf), [typography comparison](../.scratch/p2-table-fixtures-compare.log).

Implementation: [markdownPageBoundaries.ts](../packages/core/src/generation/markdownPageBoundaries.ts), [markdown.ts](../packages/core/src/generation/markdown.ts). Regression: [markdownPageBoundaries.test.ts](../packages/core/src/generation/markdownPageBoundaries.test.ts).

## Deferred decisions

- **P2-01:** Raising inventory effort increases token use, and the existing low-effort replay still produced unlocatable quotations. Choose effort only after measuring inventory completeness and quotation fidelity together; no routing setting was changed.
- **P2-04:** Developing selected sections instead of regenerating the chapter could reduce repeated output, but changes the coherence and editing behavior. Compare the alternatives before choosing a strategy.
- **Broader review scope:** Symbolic or mixed-prose derivations and factual content inside figure JSON require additional review design; they are not covered by the narrow fixes above.

P3 findings remain report-only in the original audit. No full book was regenerated and no live-book QA was rewritten during this follow-up, so targeted replay results are not a measured full-book token-savings claim.

## Validation

Targeted regressions reproduced each original defect before implementation. Final validation:

- Source-claim and arithmetic suites: **97 tests passed**, including attribution across paragraph boundaries, decimal fragments, ambiguous precedence and bounded powers.
- Figure/finalization worker suites: **45 tests passed**, including review reuse and substantive-change invalidation.
- Export suites: **88 tests passed**, including PDF, EPUB, Word and page-anchor behavior. Nine typography fixtures, 51 pages: **zero pixel drift**.
- Fresh **`pnpm check`: all seven gates passed in 147.0 seconds; 7,944 workspace tests passed**, with six existing skips. [Full check log](../.scratch/p2-fixes-30-balanced-2026-09-23/pnpm-check.log).
- All **17 frozen baseline files** retain their initial hashes. The changed-file manifest records this follow-up separately from pre-existing workspace changes. [Verification manifest](../.scratch/p2-fixes-30-balanced-2026-09-23/verification-manifest.json).
