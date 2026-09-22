# Promise and brief coverage — 22 September 2026

P2-05 was still present. The publishing compile converted open continuity entries directly into `UNPAID_PROMISE` warnings. Balanced could bypass that check entirely because story extraction was disabled. The composed manuscript read was a deletion/editing pass, with no inventory of the user's requested deliverables.

## Changes

- Initial publication now inventories explicit requirements from the original brief, then reviews every requirement and plan/story promise against the final manuscript. This applies across tiers and generation strategies, independently of story extraction and the optional per-page final review.
- Each fulfilled requirement carries exact Markdown quotations and page indexes. Invented quotations, missing/duplicate verdicts, incomplete reviews and provider failures produce `BRIEF_COVERAGE_UNVERIFIED`; they cannot silently earn a clean score. Missing requirements produce `MISSING_BRIEF_REQUIREMENT`, while a promise judged missing by the manuscript review produces `UNPAID_PROMISE`.
- A required table must exist as a rendered Markdown or HTML table. Prose comparisons, fenced examples and HTML comments do not count. The model checks the table's requested content; the parser checks that a table actually exists.
- Open continuity state alone no longer rejects or rewrites the final page. A compile that stands down before coverage review reports uncertainty rather than asserting an absent payoff.
- The evidence record is stored under `GenerationJob.qualityReport.briefCoverage`, keyed by a SHA-256 of the brief, promises and page indexes/text. Unchanged recompiles reuse it. Edit, presentation and detached recompiles make no new coverage model calls; stale or unavailable evidence remains explicitly unverified. Book-wide findings are withdrawn if any reviewed page changes.

The review uses the configured `read-manuscript` route with separate inventory and verification phases in the provider traces. There are two logical calls per initial review, plus existing bounded JSON/output-budget recovery. The review is capped at 500,000 input characters, 64 brief requirements and 64 promises; exceeding a cap reports incomplete coverage instead of reviewing a prefix as though it were the whole book. Imports retain their own manuscript workflow.

## Saved-book replay

Live replay used the original 20-page records in `.scratch/tier-audit-20-2026-09-20/{balanced,premium}/captured.json`, with current routing revision 55. It did not regenerate or overwrite those books or their historical reports.

| Book | Reviewer | Time | Fulfilled / missing / unverified | Result |
| --- | --- | --- | --- | --- |
| Balanced | gpt-5.6-luna | 47.4 s | 40 / 1 / 3 | The requested comparison table is missing. Coverage no longer returns a clean 100. |
| Premium | gemini-3.7-flash | 72.4 s | 21 / 0 / 4 | The disputed factoring/discrete-logarithm promise is fulfilled, with exact passages on pages 5 and 9. No unpaid-promise warning. |

The remaining unverified entries reflect rejected or insufficient evidence quotations, not established omissions. They stay visible as one coverage warning per book. Semantic coverage still depends on the review model; exact quotation validation does not itself prove that a passage fully answers a requirement or that its factual claims are correct. Factual/source review remains separate.

Replay inputs, outputs, call metadata and verification logs are under `.scratch/promise-coverage-2026-09-22/`.

## Validation

The two export regressions failed before the fix: Balanced had no missing-table finding, and Premium retained `UNPAID_PROMISE` despite a fulfilled manuscript review. Both now pass. Targeted tests also cover missing promises, invalid quotation/page evidence, omitted and duplicate verdicts, real versus fenced/commented tables, cancellation, review limits, stale-cache invalidation, and model-free recompiles.

Repository validation also exposed two existing PDF-export queries missing the newly required `targetPages` field; both queries now select it for the existing renderer contract.

Final `pnpm check`: **all 7 gates passed in 153.0 seconds** (3,363 core, 2,073 worker, 1,894 API, 324 database, 126 web and 7 storage tests passed; existing skips retained). The saved-live-response replay also passes against the final implementation: coverage-only scores are 90 for Balanced and 95 for Premium, with the remaining uncertainty warnings retained. These are coverage-only comparisons, not replacements for either book's complete historical quality report.
