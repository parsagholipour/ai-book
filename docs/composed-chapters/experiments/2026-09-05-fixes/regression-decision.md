# The development experiment is disabled

The completed manuscript for project `cmtnwyp3d0000fwg07qgd68uo` does not justify the added generation work. One fresh blind Sol reader scored it **6.5/10**, including **4 for pacing and 4 for slop resistance**. The earlier Sol baseline of three rung-5 books averaged **7.19** across nine readers. This comparison uses one new book and one new reader, so it is not a precise causal estimate. It supports no claim of improvement or crossing 8. The independent Opus experiment also reports a regression; its numbers are kept separate from Sol.

## Findings verified by the parent

- The raw manuscript contains 52,119 whitespace words (the generation trace counts 51,977 prose words), 15 chapters, 120 stored pages and 107 PDF pages. Project status is REVIEW_REQUIRED.
- Sol read all 15 chapters. The parent independently checked its score mean and all 18 highlight/pattern quotations against the manuscript.
- The opening describes Domesday's 1085 survey as “A generation before Morgan’s publication”, although the same chapter dates Morgan's publication to 1851. Repeated case reviews did not protect the connective prose from this basic chronological error.
- Chapters 6 and 7 reuse Mongol material. Caveats about the available passages and formulaic contrasts recur through the book, matching the reader's pacing and slop findings.
- The stored developmental-edit report has **no applied groups**. Its complete proposal was rejected for `overlapping range g3-c15-b`. The stage added review/polishing work while delivering none of its intended structural edits.
- The planning recovery accepted unresolved coverage/progression objections as review notes. Synthesis chapters inherited earlier packets. Those changes allowed generation to finish without demonstrating that the original content and progression defects were fixed.

## Cost and runtime

The successful generation job ran for **51.8 wall-clock minutes**, making **210 logged provider calls** costing **$1.598225**. It resumed from prior research/planning, so this is not a fresh-book end-to-end total. It made 58 chapter edits ($0.797631) and 82 chapter evidence reviews ($0.466204); those two purposes account for about 79% of that attempt's logged cost. The raw provider rows independently sum to the same call count and cost.

The three rung-5 book exports recorded $0.425445, $0.398975 and $0.423974, averaging **$0.416131**. The successful new generation job alone cost about **3.84 times** that full-book reference average. All attempts and other logged work on the completed project total **$2.3714**, with 546 provider calls and 188 research-search requests whose prices are absent from ProviderCallLog. These are estimated provider costs, not invoice totals. Diagnostic assessors and unpriced search/download work are excluded. Historical trace `minutes` sum provider durations; they are not comparable to job wall-clock time.

All three experimental projects together incurred $6.9482 in logged provider costs at the accounting snapshot, including failures and stopped runs. See `cost-accounting-parent-verified.json` and `cost-accounting-raw.txt` for provenance and per-attempt detail.

## Decision and implementation

Disable `bookDevelopment`, `caseEvidence` and `developmentalEdit` by default on every tier and in live settings revision 49. Preserve explicit opt-in for controlled future experiments, the earlier balanced creative/material/epigraph/couplet settings, all routing, retrieval repairs, API fixes, and file-size/documentation cleanup. This restores the previous pipeline for new books. It does not rewrite existing experimental plans or manuscripts and does not claim that they are repaired.

The parent chose the rollback, limited Fable 5.1 xhigh to cost collection and the specified small settings/test edit, reviewed that diff, and verified the live effective flags and absence of active experiment jobs. The parent also verified that the new settings revision changed no other settings.

The two remaining experimental polishing jobs were stopped. All staged pages and prior artifacts are retained. Further replicate launches are canceled. Full verification is recorded in `check-disabled-gates.log`: all seven gates passed (type checking, lint, sizes, gotcha index, subpaths, subpath tests, and the full test suite).

## Next design test

Before another generated book, use the existing manuscript to prove one structural operation: remove or merge the duplicate Mongol treatment while preserving every distinct supported contribution. A small edit proposal should validate each independent group separately, so one overlapping range cannot discard all valid groups. Measure actual removed duplication, lost coverage, and blind preference on the affected chapters. Do not add post-edit review loops, increase manuscript length to replace cuts automatically, or enable the operation by default before it earns that position.

Evidence grounding also needs a different interface: enough factual material for the requested coverage, with uncertainty retained where it changes the conclusion. Repeating the retrieval packet's limitations is not historical development. Another blanket instruction to be cautious will not fix this manuscript.
