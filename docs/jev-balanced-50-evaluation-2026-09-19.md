# Jev: live Balanced book evaluation, 19 September 2026

**Verdict:** Jev was useful and inexpensive for focused page decisions. It did not avoid a single full chapter acceptance review in this book. The conservative fallback protected the run, but the chapter integration currently adds cost and latency. One P1 was reproduced and fixed: the claim verifier could approve the original text while overlooking an unsupported sentence in the candidate that Jev had correctly flagged.

This is one real book plus a small controlled evaluation, not a calibrated accuracy benchmark. An independent agent read all 11 natural chapter edit/cut pairs; the diagnostic model's answer was not treated as ground truth.

## The actual run

| Item | Observed result |
| --- | --- |
| Book | **The Making of Standard Time**, English history, Balanced, target 50 |
| Project | `cmu8f9gqt0000odti502lc9hg` |
| Reviewed changes | Last five commits, `6a5720e..c399fff` |
| Configuration | Live revision 52; `MOCK_AI=false`; automatic strategy selection |
| Writer / reviewer | `gpt-5.6-luna`, writer effort low, judgment effort none |
| Decisions | `typesafe-ai/jev` through Vercel AI Gateway |
| Selected strategy | `composed-chapters-research` |
| Production path | Plan → approve → durable dispatch → material gathering → compose/edit eight chapters → manuscript reading/three cut proposals → paginate/finalize → export |
| Completion | All 50 manuscript page rows completed; PDF, EPUB and DOCX generated |
| Timing | Planning 61s; book generation **12m 29s**; export 8s |
| Known main-run provider cost | **$0.278105**, including **$0.010863** for Jev |
| Main-run provider records | 91, including 40 Jev physical attempts |
| Export QA | `review_recommended`, structural score 95; warnings on manuscript pages 9, 19, 30, 34 |

The requested 50 is the application's manuscript page count. Flowing A4 export produced **47 physical PDF pages**, including front/back matter. Eight generation chapters were regrouped into seven export chapters. The PDF opened and representative physical pages 3, 25 and 47 rendered legibly; this was a layout spot check, not a visual inspection of every page.

Costs are recorded provider cost hints, not a reconciled invoice. Research charges and failed calls without usage are excluded. The 24 unsuccessful main-run Jev calls have unknown cost, not proven zero cost. Main-run totals filter on non-null `generationJobId`; isolated evaluation calls share the project but have null job IDs and are excluded.

The completed book is evidence, not an editorially approved publication. All 50 saved page reports passed local checks; these scores do not represent 50 factual/model reviews. The export warning is a structural warning, not a grounding certificate. An epigraph on manuscript page 1 exposes an additional source-quality problem described below.

## Coverage and measurements

The normal 50-page route primarily exercised the new chapter acceptance gate. Composed finalization uses local page checks; it does not run the sequential page review/style/rewrite pipeline on every generated page. Balanced also had `styleAuditor`, `styleExcerpts` and `claimVerifier` disabled, and page review decision mode was the default `shadow`. These settings were left unchanged.

To exercise the remaining gates, three real full pages were separately generated from predeclared briefs using the same Balanced routing. The evidence packet was the public-domain 1884 conference proceedings. Controlled additions reversed a negation, reversed delegates' attribution, fabricated a unanimous vote, added generic promotional prose, and added explicitly requested explanatory parallelism. Those fixtures were never inserted into the main book. The page quality loop was also invoked; the clean pass branch was replayed using the exact captured Jev response, with no new inference.

| Gate | Observed behavior | Assessment |
| --- | --- | --- |
| Chapter semantic acceptance | Eight edits + three cuts; **11/11 required diagnostic fallback** | No review savings in this run |
| Meaning dimension | Six probability-qualified passes; remaining five escalated | The six passes were consistent with the inspected changes |
| Intent dimension | No probability-qualified pass | Too uncertain/unavailable to substitute for the reviewer here |
| Page style | Two natural pages and requested parallelism cleared; injected promotional prose escalated | Three full style audits avoided; roughly 0.6s screens |
| Smart unslop | Injected slop: contextual defect 1.00. Requested parallelism: legitimate use 0.97 | Correctly distinguished defects from intentional form; one rewrite avoided |
| Changed grounding | All three injected factual defects flagged by Jev, initially 0.99–1.00; valid title change supported at 0.98 | Useful screening; exposed the downstream P1 |
| Page model review | One natural page: all seven dimensions clear, matching reviewer approval. Another page: two HTTP 503s, safe fallback. Final page: local heuristic veto before Jev | Too little live agreement data to justify broad pass-mode rollout |

The main book's 39 chapter Jev attempts returned 15 responses and 24 provider failures: **21 HTTP 503s and three HTTP 400 `max_tokens_exceeded` errors**. Across 22 logical dimensions: six confident passes, eight low-probability escalations, seven exhausted provider attempts, one invalid probability distribution. The three context errors had approximately 212–213k characters of context. Input size was not fixed by retrying.

Main-run Jev responses, including cover selection and the invalid distribution, had median latency **1.071s**, nearest-rank p95 **1.835s** (16 responses). Chapter Jev calls alone consumed 46.477s of summed physical call time, plus retry waiting. They added $0.010737 known cost, while all 11 diagnostic reviews still ran for $0.069909 and 55.014s of summed call time. These sums are not book wall-clock time, and no counterfactual faster book was run.

Independent chapter adjudication found seven acceptances and four retentions, with **no demonstrated material meaning-changing false acceptance**. The Chapter 8 fallback correctly prevented a duplicated sentence. That benefit belongs to the full fallback path, not a Jev-only verdict. The natural changes mostly preserved meaning; they do not establish Jev's sensitivity to rare serious regressions.

## P1 fixed: the diagnostic read the wrong text

The exact changed candidate appended a false unanimous-vote sentence. Jev selected `defect` at 0.99, but `verify-page-claims` returned `groundedOk: true` and no unsupported claims. `checkChangedPageGrounding` consequently stamped the candidate `verified`. An exact worker-shaped replay reproduced the false pass. With negation and attribution mutations, the verifier instead criticized unrelated original wording and missed the injected sentence.

The prompt placed the proposed `markdown` before a complete `original` object without explicitly identifying which was the sole approval target. Controlled candidate-labeling replay caught all three injections. The production fix in [claimVerifier.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/generation/claimVerifier.ts:66) now:

- Names `candidate.title` and `candidate.markdown` as the sole text being verified; labels the original as before-edit context.
- Places the complete candidate after the evidence, request and original, and explicitly asks the verifier to read through its final sentence.
- Prioritizes added/changed contradictions while allowing supported paraphrase and direct implications.
- Specifies that each finding is one string containing the quote, mismatch and repair. The first replay otherwise needed JSON repair because the model emitted objects; the final replay needed none.

The prompt-contract regression failed before the change. The final real-provider replay **rejected all three injected defects with the exact offending quotation and accepted both valid controls**: an unchanged page with a new title, and removal of the fabricated statistic. Jev was uncertain about the removal, and the diagnostic correctly accepted it. The final replay used nine physical calls, cost $0.002756, and had zero JSON validation errors.

This fixes an observed ambiguity rather than making model output infallible. It does not turn a suspected Jev defect into an unconditional veto. Missing-source handling, cancellation, bounded retries and authorized source-context reuse retain their existing behavior. No P0 was identified, and no other confirmed P1 remains from this evaluation.

## P2 findings from the original evaluation

1. **Chapter cut context can exceed Jev's accepted request size.** [chapterEditAcceptance.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/generation/chapterEditAcceptance.ts:56) includes complete surrounding chapters in addition to full before/after text. Three observed requests failed with `max_tokens_exceeded`; the fallback preserved correctness. Bound the evidence/context deliberately, preserve the actual passages needed to establish redundancy, and route oversized comparisons directly to a capable reviewer. Do not silently truncate qualifications or lower confidence thresholds to increase pass rate. Low confidence remains a valid escalation, not itself a correctness bug.

2. **A safe partial cut was rejected for not performing an infeasible second cut.** Chapter 7's original had 2,283 words; the candidate safely removed 89, leaving 2,194 against a 2,150 floor. The intent diagnostic demanded another requested cut of the opening six paragraphs: 735 words, leaving 1,548 and violating both the 25% limit and opening protection. Supply the actual binding cut constraints to [the acceptance judge](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/generation/chapterEditAcceptance.ts:72), allow useful feasible subsets, and retain unfulfilled notes as outstanding work. Do not make all advisory notes mandatory.

3. **A lexical ending rule rejects a concrete factual page before Jev can judge it.** The third supplemental page contains “the beginning of the civil day” in its technical explanation. [hasVagueEnding](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/generation/pagesLocalQa.ts:742) scans the whole page and matches “the beginning”; its fiction-oriented resolution vocabulary does not rescue this history page. The local veto survives the repair loop even when the fabricated fact is removed. Treat this pattern as a reason for a small contextual decision, with the actual ending and assignment, rather than an automatic rejection. This is a pre-existing rule exposed by the live evaluation.

4. **Grounding failure provenance can be weakened when serialized again.** [changedCandidateGrounding.ts](/run/media/parsa/projects/ravanix-book/ai-book-maker/apps/worker/src/generation/changedCandidateGrounding.ts:54) overwrites an existing failed status with `unavailable`/`unverified_no_sources` while retaining `groundedOk: false`. [The schema normalizer](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/schemas/book.ts:199) then derives `groundedOk: true` from any status other than `failed`. Existing `approved: false` survives, so this is a report/provenance defect, not a demonstrated publication approval bypass. Preserve the existing failure and store verification availability separately. Static reproduction, not a main-book incident.

5. **The ordinary composed route still lacks coverage for source/edition problems.** Manuscript page 1's epigraph contains visible OCR defects (“Ephkmeris”, “Baine”) and refers to 1842 while its attribution labels the volume 1767. Neither the chapter preservation gate nor final local checks flagged it. [Composed finalization](/run/media/parsa/projects/ravanix-book/ai-book-maker/apps/worker/src/generation/composedChaptersFinalize.ts:71) and the active Balanced settings explain the coverage gap. Add an evidence-aware provenance/quotation check at material or chapter acceptance time; distinguish author, volume/edition date and quoted passage date. Existing research summaries also reused synthesized text across unrelated source URLs. These are pre-existing source-path issues, not evidence that Jev approved their truth.

6. **Private-source retrieval embeddings bypass the logged/stoppable wrapper.** [createLoggedProviders](/run/media/parsa/projects/ravanix-book/ai-book-maker/apps/worker/src/providers/loggedAdapters.ts:93) passes raw `providers.embedding` into source-aware text/decision wrappers. [Source search](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/db/src/sources.ts:21) calls it directly and catches every failure. Use the logged embedding adapter and propagate cancellation. This pre-existing seam is more relevant as evidence-aware Jev screens increase retrieval calls. Static finding; this public-research book did not exercise private-source embedding retrieval.

## P3 findings from the original evaluation

- **Inspect every deleted span and resulting join.** Chapter 4's accepted cut removed two paragraphs, while the diagnostic described only one. It removed the nearby antecedent for “The portability mattered.” The important claims remain elsewhere, but the transition is weaker. Give the judge explicit removed spans and retained neighbors alongside the full context. The independent [chapter adjudication](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/chapter-adjudication.md) documents the exact before/after evidence.
- **Chapter fallback uses the writer lane.** `review-chapter-edit-acceptance` is classified as prose in [routing tests](/run/media/parsa/projects/ravanix-book/ai-book-maker/packages/core/src/adapters/textRouting.test.ts:75), rather than the mechanical judgment set. Balanced uses the same model name but different effort; higher tiers may differ more. Evaluate routing this structured diagnostic to the configured judgment lane. Savings/accuracy impact were not measured here.
- **Chapter outcome events lack direct comparison identity.** Raw requests contain enough evidence to reconstruct chapter/operation/candidate groups, so no production logging was necessary to complete this audit. Adding chapter index, operation and a comparison ID to outcomes would make latency, disagreement and avoided-review reporting easier without parsing full prose logs.

## Original P1 validation and artifacts

**Final `pnpm check`: all seven gates passed in 119.2s**, including 7,536 workspace tests and 14 tooling tests. The complete result is recorded in [check.log](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/check.log). Six existing workspace tests are skipped. Existing unused-import warnings are unrelated to this change. A temporary replay-script lint error and a model response-shape ambiguity found during verification were corrected before this final run. `git diff --check` also passed.

Evidence directory: [.scratch/jev-balanced-50-2026-09-19](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19). It contains the configuration snapshot, launch/approval/capture scripts, exact provider requests/responses, decisions and probabilities, DB snapshots, before/after comparisons, exported PDF/EPUB/DOCX and manuscript Markdown. Provider secrets are not included. The durable production logs remain under `books/cmu8f9gqt0000odti502lc9hg/runs/` in object storage.

Key evidence: [baseline supplemental evaluation](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/page-evaluation.json), [exact false-pass replay](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/page-evaluation-replay.json), [final fixed replay](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/page-evaluation-after-fix.json), [main-run metrics](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/metrics.json), and [manuscript](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/book.md).

Files named `invalid-prebind` are discarded harness experiments: their temporary adapter override did not bind as intended. They are retained for provenance but are not evidence for the fix. The final replay invokes the production implementation directly. Frozen pass-mode replay verifies branch behavior, not an additional independent Jev judgment.


## P2/P3 remediation and live replay

The six P2 items and three P3 items above now have code changes and regression coverage. The findings above describe the original run, before these changes.

| Finding | Implemented behavior |
| --- | --- |
| Oversized chapter comparisons | A conservative 80,000-byte local context budget routes directly to the contextual reviewer. The full original, candidate and surrounding chapters remain available; no evidence is truncated. Both skipped decision dimensions record `context_budget_exceeded`. This is a local routing budget, not a published provider limit. |
| Infeasible cut notes | The writer and reviewer receive the actual minimum, 25% allowance, explicit caller allowance, and opening constraint. The judge may accept a useful feasible subset while recording outstanding notes. |
| False vague-ending veto | Phrase matches are advisory. Jev's progression screen and the contextual reviewer judge the actual ending and assignment. Technical uses of “beginning” no longer force a rewrite. |
| Lost grounding failure | A prior failed check remains failed through unavailable verification, missing sources, JSON serialization and schema normalization. `groundingAvailability` records the separate availability result and clears after a real verification result. |
| Source and edition coverage | Newly extracted passages receive a Jev provenance screen, then a bounded judgment review when uncertain or suspect, before composition. The review sees the real document opening and matching source windows, including original wrapping. Unsupported attribution, edition mismatches, unusable OCR and unresolved provenance keep excerpts out. Epigraph selection requires the persisted verification marker. Gemini source summaries now contain only segments explicitly grounded to that URL; the aggregate synthesis is kept separately. |
| Retrieval embeddings | Text and decision source retrieval share the logged, stoppable embedding adapter. Source search propagates cancellation while retaining the existing fallback for ordinary embedding outages. |
| Missed cut spans and joins | Both judges receive every exact removed span and its surviving paragraph neighbors. Fallback reviews must provide one meaning and join verdict for every span; missing, duplicate, uncertain or failing join reviews retain the original. |
| Fallback routing | Chapter acceptance and provenance diagnostics use the configured judgment lane. The real Balanced replay used `gpt-5.6-luna` with zero reasoning tokens. |
| Outcome identity | Chapter decisions and fallback outcomes include `comparisonId`, chapter index, operation and context byte count; the request context carries the same identity. |

The latest replay invoked the production gates with the original saved before/after chapter text and pinned Balanced routing. It used real providers, not mocked responses, and did not overwrite the original book.

| Saved case | Latest production result |
| --- | --- |
| Chapter 7: 89-word partial cut | Accepted. The infeasible additional request no longer vetoes the safe subset. |
| Chapter 4: two deletions | Rejected. The per-span review specifically marks the join at “The portability” as `needs_review` because its local antecedent was deleted. |
| Chapter 6: three deletions | Accepted after all three spans received explicit passing meaning and join verdicts. |
| Original Almanac epigraph | Jev selected `defect` at 0.99; the diagnostic identified the 1842/1767 edition mismatch and unsupported attribution. The excerpt was excluded. |
| Valid 1884 Resolution V quotation | In the final provenance control, Jev selected supported at 0.56 (below the confidence threshold); the diagnostic accepted the exact quotation with supported metadata. No wording was repaired or invented. |
| Supplemental final page | Reached contextual review, with progression accepted. The latest diagnostic scored 78 and requested factual-scope revisions about Resolution VI. The earlier replay scored 94; this variation is retained in the evidence. Neither result treats “beginning of the civil day” as a deterministic defect. |

All three chapter comparisons exceeded the local Jev budget, so they incurred **zero chapter Jev calls** and one judgment review each. The final six-case replay completed in **30.1 seconds**, made **10 physical provider calls**, and recorded **$0.033751** in known cost. This is a small saved-case replay, not a new estimate of whole-book savings or proof of model accuracy across books. The final-page full reviewer varied between runs: the earlier Jev pass agreed with a 94-point diagnostic; in the later 78-point diagnostic run Jev was unavailable after two HTTP 503s. This is not a same-run Jev/reviewer disagreement.

A follow-up provenance control corrected the valid quotation fixture’s copied host, episode label and word count. The two-case rerun again rejected the original epigraph (Jev defect 0.99) and accepted the valid quotation after fallback (Jev supported 0.56). It recorded $0.000558 in known cost. See [final provenance controls](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/p2-provenance-controls.json).

The first remediation replay failed to present the original epigraph to a model because its harness and the new matcher compared raw line breaks with normalized excerpt whitespace. A failing regression exposed this, the matcher was corrected without changing source words, and the final replay asserts that the original window exists. Only the final replay above is evidence of the model's provenance judgment. The intermediate artifact is retained as `p2-live-replay-before-span-verdicts.json`.

Existing published pages and exports remain the original evaluation artifacts. This patch does not migrate older cached dossiers or rewrite already published text; fresh extraction uses the new provenance gate, and epigraph selection excludes unverified cached excerpts.

Validation: **all seven `pnpm check` gates passed in 132.7 seconds**, including **7,564 workspace tests and 14 tooling tests**, with six existing skips. Type checks, lint, file-size budgets, gotcha index and subpath checks all passed. The first full run found an outdated ending-veto expectation and the expanded Gemini test file exceeded its size budget; the expectation was updated, the research-adapter tests were split along their existing seam, and the complete check was rerun successfully. Existing unused-import warnings are unrelated. `git diff --check` also passed.

Evidence: [final remediation replay](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/p2-live-replay.json), [replay runner](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/p2-live-replay.ts), and [full check log](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/p2-final-check.log). The replay JSON retains requests, responses, per-span explanations, outcomes, timing and provider cost rows. Earlier failing and focused regression runs are also in the evidence directory.


## How much Jev helps: token and quality accounting

The measured full-book baseline avoided **zero of eleven chapter acceptance reviews**. Chapter Jev responses consumed **255,659 provider-reported input tokens and 623 output tokens** in addition to the full reviews, with $0.010737 known chapter-screen cost. Failed attempts without provider usage are excluded from these token sums; the accounting rows contain 12-token placeholders for those failures, which are not measured provider tokens. Including cover selection, Jev cost $0.010863, about 3.9% of the main run's known $0.278105 cost.

An **offline replay of the current production routing code**, using all eleven saved comparison inputs and fake uncertain verdicts solely to inspect routing, sends eight comparisons directly to the full reviewer. Those eight comparisons previously caused 32 of the 39 chapter Jev attempts, consumed **168,212 reported input + 377 output tokens**, cost $0.007064 where priced, and took 39.312 seconds of summed physical call time. Thus the new budget removes about **65.8% of this trace's chapter Jev token overhead**. This is a counterfactual application to the saved trace, not a measured reduction in a newly generated book. It does not count new provenance checks or measure wall-clock savings. The three oversized cuts were also replayed with real providers and made zero Jev calls.

Jev's value is often replacing a more expensive model, rather than reducing the sum of tokens. On the same natural page in the supplemental run, Jev's multi-question review consumed **6,687 tokens** and cost **$0.000268**, while the full review consumed **4,476 tokens** and cost **$0.001254**. If that confident screen alone replaces the review, the gate costs about **78.6% less**, despite using about 49.4% more tokens under the respective tokenizers. In the actual shadow-mode run both calls executed, so that example saved no review cost. Token counts across models are not directly equivalent units of work.

Focused supplementary gates skipped three style audits, permitted skipping an unnecessary rewrite for requested parallelism, and skipped verification for a title-only factual-preserving change. The unexecuted calls have no observed token counts, so their exact net token savings cannot honestly be stated. These gates were not all enabled in the normal Balanced composed-book route.

Quality evidence supports Jev as a focused screen with fallback: it detected all three deliberately injected factual mutations, separated promotional slop from requested parallelism, and detected the bad epigraph at 0.99. This is a small test set, not an accuracy estimate. The valid primary quotation needed fallback because Jev's 0.56 supported probability was below the threshold. Safe partial-cut acceptance and broken-transition rejection in the latest replay came from better full-review context and structured span verdicts; those improvements must not be attributed to Jev itself. Provider 503s remain a separate reliability problem and occurred in the latest replay too.

Reproducible routing evidence: [token analysis](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/token-analysis.json) and [offline runner](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/jev-balanced-50-2026-09-19/token-analysis.ts).
