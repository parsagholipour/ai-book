# Composed chapter length — 22 September 2026

Fixes the silent underdevelopment reported as P2-04 in the [20-page tier audit](tier-audit-20-pages-2026-09-20.md).

## Cause and change

The ordinary composition path stopped retrying at 70% of its stated minimum. The composition editor could then accept a shorter version above its truncation threshold. Pagination produced the requested number of records regardless of their combined word count, and export integrity did not check chapter length.

- Composition now uses the full minimum on every tier. It retains the existing limit of two attempts, asks the retry to develop assigned material with supported explanations or worked examples, and keeps the longer draft. The attempt count records both calls even when the original wins.
- The composition editor cannot take a chapter below its minimum or worsen an existing deficit. Partial growth remains acceptable. Explicit final edits after structural reallocation and factual corrections can still shorten prose; unsupported assertions are never retained to fill space.
- Export measures the actual accepted chapter text after all edits and repairs. A deficit produces `CHAPTER_LENGTH_SHORTFALL`, including words, minimum, deficit and affected pages, and publishes the book as `REVIEW_REQUIRED`. The check also runs when model final review is skipped and clears when the current text meets the budget. One long chapter cannot compensate for another short chapter.
- Only valid, retained figures receive the existing 140-word space allowance. Figure markup does not count as prose. Chapter reports use this allowance, and checkpointed edited-word counts are recomputed from the staged pages.

No pagination, typography, page-count target or provider routing was changed.

## Correction to the original audit

The audit read the chapter report's undiscounted minimum. Ultra chapters 2 and 3 each contain a valid figure, so their correct prose minimum is **1,580**, not 1,720. Their edited text already met that minimum. The reporting correction matters independently of the retry fix.

Recount of the saved audit manuscripts, using readable words and actual figures:

| Tier / chapter | Readable words | Correct minimum | Shortfall |
| --- | ---: | ---: | ---: |
| Quick 2 | 1,837 | 2,150 | 313 |
| Quick 4 | 1,682 | 1,720 | 38 |
| Balanced 3 | 1,370 | 1,720 | 350 |
| Ultra 2 | 1,646 | 1,580 | 0 |
| Ultra 3 | 1,641 | 1,580 | 0 |

The other saved chapters, including Premium, meet their figure-adjusted minimums. These are measurements of archived artifacts; this change did not replace the published audit books.

## Validation

Deterministic regressions first reproduced the four draft shortages and the shortening editor. Tests cover bounded retries, retaining the better first attempt, exact minimums, separately written opening scenes, partial editorial growth, factual deletions, figures, neighboring chapters, and current text superseding stale report counts. Publication tests exercise the real compile handler with both full and skipped final review; chapter length is the only error in those fixtures.

Four isolated live replays fed the saved first draft into the current composer, then made one real retry through the saved tier routing:

| Tier / chapter | Saved draft | Retry accepted | Prose minimum |
| --- | ---: | ---: | ---: |
| Quick 2 — Qwen 3.7 Flash | 1,779 | 2,511 | 2,150 |
| Balanced 3 — GPT-5.6 Luna | 1,498 | 1,747 | 1,720 |
| Ultra 2 — GPT-5.6 Sol | 1,540 | 1,825 | 1,580 |
| Ultra 3 — GPT-5.6 Sol | 1,266 | 1,774 | 1,580 |

These validate the length recovery, **not finished-book quality**. The Balanced retry contains nine deterministic arithmetic findings; it still requires the normal correction passes. If those repairs leave a shortage, final length QA retains it as a review issue. None of the replay outputs was published. There is no guarantee that a bounded model retry will meet the minimum; the fix prevents any remaining shortage from being silently declared complete.

Local evidence: [replay scripts, request/response traces, baseline counts and check logs](../.scratch/chapter-length-fix-2026-09-22/). These files are ignored by Git.
