# Thirty-page Balanced token audit — 23 September 2026

**Completed: 30 manuscript pages, 30 physical PDF pages, five chapters, 14,190 readable words. No P0 found. Two P1 defects fixed.** The baseline correctly finished **REVIEW_REQUIRED**, with exports produced and no failed jobs. This is a completed diagnostic run, not a publication-ready book.

Follow-up: clear P2 fixes were assigned to separate subagents. See [P2 fixes and deferred decisions](token-audit-30-balanced-p2-fixes-2026-09-23.md). The measurements and findings below describe the preserved baseline.

Project: `cmud8ttkk0000wblsiyubz59y`. Planning began **22 September, 22:26:08 UTC**; export finished **22:46:33 UTC**: **20m 25s**. These times are 02:26–02:46 on 23 September in Dubai.

## Measured usage

| Calls | Requests | Input tokens | Output tokens, including reasoning | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: |
| Text | 107 | 773,620 | 139,635 | 9,416 |
| Grounded research | 28 | 5,143 | 52,860 | 25,503 |
| **Total** | **135** | **778,763** | **192,495** | **34,919** |

All **135** requests have provider-reported usage, and input, output, reasoning and reported cache counts reconcile with the settled ledger. There are **zero missing-usage or ledger mismatches in this baseline**. The network-retry P1 below was found through fault injection. Two text requests failed schema validation, consuming **1,036 output tokens**; all jobs ultimately completed. There were **no output-limit truncations**, and no text response consumed 90% of its effective allowance.

The recorded model-token cost hint is **$0.493640**, including research. It excludes search/tool charges and is not an invoice reconciliation. Cached input was **4,709 tokens, 0.60% of input**. Reasoning is included in output and is never added twice. Research accounts for **27.5% of output** and **73.0% of reasoning**; its usage was missing from the earlier, pre-accounting-fix audit, so those old cost totals cannot be compared directly.

Three additional paid inventory probes consumed **10,801 input / 3,288 output tokens**. They are separate diagnostics, excluded from the book totals. Regression tests use provider fixtures and incur no model calls.

### Largest token consumers

| Stage | Requests | Input | Output | Interpretation |
| --- | ---: | ---: | ---: | --- |
| `review-chapter-evidence` | 21 | 134,271 | 21,191 | Verification is now batched; remaining support/completeness gaps are below. |
| `review-chapter-edit-acceptance` | 7 | 129,156 | 1,792 | Full original/candidate comparisons; six successful verdicts, one schema failure. |
| `edit-chapter` | 7 | 91,697 | 27,362 | Includes the false arithmetic repair described in P1-02. |
| `review-dossier-provenance` | 24 | 87,769 | 3,356 | Exact passage provenance checks. |
| `compose-chapter` | 8 | 83,487 | 27,707 | Eight drafts for five chapters; three length retries. |
| `extract-excerpts` | 6 | 66,920 | 3,743 | Primary-source extraction. |
| `inventory-chapter-claims` | 13 | 53,050 | 12,030 | Eleven inventories and two quote-repair calls; six inventories returned no claims. |
| `read-manuscript` | 3 | 44,185 | 6,672 | Manuscript reading and brief-coverage inventory/verification share this purpose. |
| `case-source-search` | 17 | 3,534 | 26,088 | Research responses include reasoning and source search. |
| `chapter-research` | 10 | 1,470 | 20,469 | Chapter background and brief-wide research. |
| `cut-chapter` | 4 | 17,790 | 15,533 | Four full-chapter cut responses; only one reached and passed contextual acceptance. |

A high limit is a ceiling, not a token charge. The evidence supports improving incomplete work and repeated drafts; it does not support reducing every cap. Accepted editorial changes and provenance checks are not automatically waste.

## P1 fixes applied

### P1-01 — Network retries overwrite already reported paid usage

A real OpenAI adapter fixture reports usage, encounters a recoverable stream disconnect, and succeeds on retry under the same logical call ID. The trace records **20 input / 112 output** for the first attempt and **40 / 224** for the second; the original ledger retains only **40 / 224**. A retry reuses the live ledger row and replaces the first attempt's observed usage.

The fix settles each failed invocation before retrying and creates a new live row for the next attempt. A finalization guard prevents duplicate settlement through the outer error handler or provider fallback. Unreported usage remains unpriced.

Eight regression cases cover text, JSON, tools, exhausted retries, unreported usage, and fallback followed by a primary retry. Seven fail against the baseline; all eight pass after the fix. This is a fault-injection reproduction, not a claim that this failure occurred in the live book.

Implementation: [textFallbackAccounting.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/apps/worker/src/providers/textFallbackAccounting.ts:90). Regression: [providerRetryAccounting.test.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/apps/worker/src/providers/providerRetryAccounting.test.ts:1).

### P1-02 — Thousands separators become multiplication and trigger false repairs

Generated manuscript page **18** contains 13 correct RSA intermediate calculations such as `128^2=16\,384`. The checker removes the LaTeX thin-space command and reads two integers as `16 × 384`. That creates false correction evidence, pays for a chapter edit and acceptance review, and retains an arithmetic error in publication QA.

The directly attributable unnecessary repair consumed **33,494 input / 4,666 output tokens across two calls**. It made no accepted arithmetic progress; the correct original values survived. This is measured baseline expenditure, not a full-book savings forecast.

The parser now normalizes complete three-digit groups before removing formatting. Ambiguous digit spacing is skipped instead of asserted to be multiplication. Tests require valid grouped numbers to spend no repair call, while wrong grouped numbers and wrong explicit products remain detectable.

A read-only comparison over **12,463 stored pages** removed precisely these **13 false positives on page 18**. The **seven other findings remained**, with no new finding. Rechecking all five final chapters with the fixed parser reports no arithmetic findings. This check is limited to the supported numeric grammar; it is not a proof of every statement in the book.

Implementation: [arithmeticCheck.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/generation/arithmeticCheck.ts:203). Regressions: [arithmeticGrouping.test.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/generation/arithmeticGrouping.test.ts:1) and [composedArithmeticRepair.test.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/apps/worker/src/generation/composedArithmeticRepair.test.ts:1).

The baseline book and its stored QA were preserved as evidence. Its historical `ARITHMETIC_ERRORS` card still records the pre-fix verdict; it is not evidence that the corrected parser finds those equations wrong. No second full book was generated, and no historical ledger usage was fabricated or backfilled.

## P2 findings — report only

**P2-01 — The claim inventory often performs no review at the configured “none” effort.** Six of eleven inventory operations returned `complete:false, claims:[]`: **24,963 input / 90 output tokens**, with no useful claims. Initial inventories were empty for chapters 1, 3, 4 and 5; finalization recovered inventories for chapters 4 and 5, while chapters 1 and 3 remained empty. Chapter 4 still had an unlocatable quote after quote repair. Final stored coverage is shown below.

An exact chapter-1 replay at the same 9,000-token cap again returned no claims at “none” in 15 output tokens. “Low” returned 56 valid claims but still had two unlocatable quotations after its bounded repair, consuming 3,273 output tokens. More allowance is not the missing ingredient. Calibrate inventory effort and quotation fidelity together, including empty-inventory controls; simply switching effort did not produce a complete review in this sample. No saved routing setting was changed.

**P2-02 — Derived arithmetic is sent through external-source verification.** The inventory instructions exclude calculations derived from explicit toy inputs, but the final review labels `15 mod 12 = 3` and `17 ≡ 5 (mod 12)` unsupported because no supplied source prints those exact numbers. Earlier recovery queries likewise searched for the specified Diffie–Hellman example. This spends retrieval/review tokens on derivations and can authorize removal of valid teaching examples. Separate deterministically checkable arithmetic from externally sourced assertions while continuing to verify empirical premises and historical claims. Final coverage contains **54 supported / 174 inventoried claims**, with **120 unsupported** and none marked contradicted; unsupported does not mean false, and these counts omit chapters whose inventory failed.

**P2-03 — Adding a figure label invalidates a fresh chapter review.** Chapter 2's final stored review checked 41 claims, but compile QA marks pages 7–12 as unverified. Comparing the exact normalized texts shows one insertion: `[Figure: Diffie-Hellman values in the worked example]`. The review was performed before that label was present. Align the review and export representation of figures, or review after insertion, without masking substantive caption or prose changes. The current fail-closed warning is safe, but the paid review cannot clear publication QA.

**P2-04 — Drafts stop short and trigger whole-chapter rewrites despite ample headroom.** Chapters 1, 2 and 4 each needed a second composition request for length. Those three extra drafts used **10,121 output tokens**, with no token-limit error; all eight composition calls together used 27,707. Chapter 2's second draft was shorter than its first. Final chapters all met their production minima after editing, so this is inefficient target adherence rather than an undelivered page count. Test section-level development or expansion of the existing draft before raising output caps.

**P2-05 — A table boundary turns the next paragraph into a table row.** Generated page 15 ends with the comparison table; page 16 starts with the Handbook paragraph. In the PDF, that paragraph becomes an extra first-column cell, leaving three empty cells beside it. The defect is visible on physical PDF page 15, following the table that starts on physical page 14. Preserve a block boundary when joining manuscript pages and regression-check tables crossing that boundary. The text is present, but its layout is wrong. This baseline was retained rather than silently polished during the token measurement.

| Chapter / generated pages | Readable words | Minimum | Final stored source review |
| --- | ---: | ---: | --- |
| 1 / 1–6 | 2,663 | 2,580 | incomplete: 0/0 supported |
| 2 / 7–12 | 2,703 | 2,440 | reviewed: 13/41 supported; digest becomes stale on export |
| 3 / 13–18 | 2,845 | 2,580 | incomplete: 0/0 supported |
| 4 / 19–24 | 3,101 | 2,580 | incomplete: 29/89 supported |
| 5 / 25–30 | 2,878 | 2,580 | reviewed: 12/44 supported |

## P3 findings — report only

**P3-01 — Very little input is cached.** Only 0.60% of input reports a cache hit. Evidence verification and edit acceptance consume 263,427 input tokens between them, with zero reported hits. Inspect cache-prefix stability and provider cache eligibility before cutting context. The before/after prose, exact evidence and counterevidence are necessary checks and should not be removed solely to lower input counts.

**P3-02 — Schema failures add small costs and can discard useful results.** Plan critique returned objects where string arrays were required; its repair returned an all-empty critique. A chapter-3 editorial acceptance response omitted `intentReason` and that edit was rejected. Together the two failed requests used 1,036 output tokens, 0.54% of baseline output. Improve explicit output contracts or narrowly normalize semantically equivalent fields. Do not relax factual quotation or acceptance requirements.

**P3-03 — Brief review and references still need editorial attention.** Brief coverage verified 33 of 41 requirements and left eight unverified, including worked calculations that are visibly present. Unverified is not the same as missing. The PDF's source appendix occupies the end of physical page 28 plus pages 29–30 and largely uses domain names as link labels, making distinct documents hard to identify. Prefer cited document titles and distinguish used evidence from background search candidates. The style checker also flags symmetrical hedging on six generated pages.

## Every generated page

The table below refers to **generated manuscript page indexes**. PDF export reflows the manuscript and includes cover, contents and references, so physical PDF indexes are different. All 30 physical PDF pages were rendered and inspected as contact sheets, with detailed inspection of the table; the P2 layout defect above is explicit.

Each row includes its chapter's measured usage divided across six pages plus its share of book-wide work. The **16 shared requests** account for **81,574 input / 37,927 output tokens** across the book. **No request is unattributed**. Display values are rounded; the JSON reconciliation checks unrounded values.

Full call IDs, purpose, requested/effective limits, provider usage, attribution basis and page associations: [page-traces.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/page-traces.json). Spreadsheet-friendly rows with page titles: [page-traces.csv](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/page-traces.csv).

| Generated page | Chapter | Words | Allocated input | Allocated output | Review note |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1 | 495 | 15,486.5 | 4,874.7 | Empty inventory |
| 2 | 1 | 425 | 15,486.5 | 4,874.7 | Empty inventory |
| 3 | 1 | 371 | 15,486.5 | 4,874.7 | Empty inventory |
| 4 | 1 | 458 | 15,486.5 | 4,874.7 | Empty inventory |
| 5 | 1 | 496 | 15,486.5 | 4,874.7 | Empty inventory |
| 6 | 1 | 418 | 15,486.5 | 4,874.7 | Empty inventory |
| 7 | 2 | 432 | 41,405.0 | 10,107.6 | Support gaps; figure digest stale |
| 8 | 2 | 464 | 41,405.0 | 10,107.6 | Support gaps; figure digest stale |
| 9 | 2 | 476 | 41,405.0 | 10,107.6 | Support gaps; figure digest stale |
| 10 | 2 | 448 | 41,405.0 | 10,107.6 | Support gaps; figure digest stale |
| 11 | 2 | 453 | 41,405.0 | 10,107.6 | Support gaps; figure digest stale |
| 12 | 2 | 430 | 41,405.0 | 10,107.6 | Support gaps; figure digest stale |
| 13 | 3 | 432 | 24,511.8 | 5,532.2 | Empty inventory |
| 14 | 3 | 497 | 24,511.8 | 5,532.2 | Empty inventory |
| 15 | 3 | 467 | 24,511.8 | 5,532.2 | Empty inventory; table boundary |
| 16 | 3 | 465 | 24,511.8 | 5,532.2 | Empty inventory; table boundary |
| 17 | 3 | 507 | 24,511.8 | 5,532.2 | Empty inventory |
| 18 | 3 | 477 | 24,511.8 | 5,532.2 | Empty inventory; 13 false arithmetic alarms fixed |
| 19 | 4 | 542 | 28,899.3 | 6,908.1 | Incomplete inventory; support gaps |
| 20 | 4 | 481 | 28,899.3 | 6,908.1 | Incomplete inventory; support gaps |
| 21 | 4 | 538 | 28,899.3 | 6,908.1 | Incomplete inventory; support gaps |
| 22 | 4 | 523 | 28,899.3 | 6,908.1 | Incomplete inventory; support gaps |
| 23 | 4 | 472 | 28,899.3 | 6,908.1 | Incomplete inventory; support gaps |
| 24 | 4 | 545 | 28,899.3 | 6,908.1 | Incomplete inventory; support gaps |
| 25 | 5 | 467 | 19,491.3 | 4,659.9 | Support gaps |
| 26 | 5 | 452 | 19,491.3 | 4,659.9 | Support gaps |
| 27 | 5 | 522 | 19,491.3 | 4,659.9 | Support gaps |
| 28 | 5 | 483 | 19,491.3 | 4,659.9 | Support gaps |
| 29 | 5 | 463 | 19,491.3 | 4,659.9 | Support gaps |
| 30 | 5 | 491 | 19,491.3 | 4,659.9 | Support gaps |

## Method and validation

The brief was *Keys in Public*, a 30-page English science primer extending the previous 20-page cryptography case. Complexity 7, temperature 0.8, final review enabled; no full illustrations or generated cover image requested, while normal cover design selection and inline figures remained enabled. Balanced used saved routing revision **58**: Luna low for composition, none for inventory/extraction, low for substantive evidence verification. Generation used the existing operator planning/approval/worker queue. Mobile credit reservation and billing settlement were outside the audit.

The run includes the pre-existing uncommitted fixes from earlier work. **All 1,031 sampled source files retained their initial hashes through export.** Proposed fixes ran through isolated module substitutions during generation and were applied afterward. No pre-existing change was reverted. The baseline was frozen before implementation changes.

All physical text requests use unique `(callId, requestIndex)` keys and their last cumulative usage snapshot. Research usage comes from successful provider results. Provider-level HTTP retries hidden inside SDKs cannot be reconstructed if the SDK does not report them. This sample has no missing reported usage; that is not a guarantee about invisible provider-side work.

Validation after applying both fixes:

- Actual worker regression suites: **88 tests passed**, including eight network-retry cases and the no-paid-repair assertion on valid grouped arithmetic.
- Core arithmetic suites: **23 tests passed**. The larger proposed arithmetic/repair run had **29 passing tests**, and proposed provider suites had **148**.
- Fixed-parser replay of the full saved manuscript: all five chapters produce no arithmetic findings. Historical differential scan: 12,463 pages, 13 false findings removed, seven existing findings unchanged.
- **`pnpm check`: all seven gates passed in 218.6s**; workspace suites reported **7,876 passing tests**. Existing lint warnings were non-blocking.
- Reconciliation asserts 135 metered requests, zero ledger gaps, 30 page allocations, no unattributed request, and conservation of input/output totals. PDF metadata confirms 30 physical pages.

These are one live book plus targeted replays, not a comparative benchmark or a claim of universally improved quality. The original export remains REVIEW_REQUIRED for documented source/coverage issues, with its pre-fix arithmetic QA preserved as historical evidence.

Evidence: [manifest.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/manifest.json), [analysis.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/analysis.json), [metrics.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/metrics.json), [inventory-probe.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/inventory-probe.json), [arithmetic-scan.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/arithmetic-scan.json), [pnpm-check.log](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/pnpm-check.log). Full immutable JSONL and exports are under `/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-30-balanced-2026-09-23/baseline/balanced`. Credentials are not included.
