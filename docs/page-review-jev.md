# Jev model page review

The integration is implemented behind `BOOK_MAKER_PAGE_REVIEW_DECISIONS=off|shadow|pass`.
The default is `shadow`; it also requires the existing Fast decisions route to resolve
Jev. No operator routing or production setting was changed. Callers can override the
mode through `ReviewPageOptions.pageReviewDecisionMode` for experiments.

`pageModelReview` remains the controlling quality gate. Whole-book and composed-chapter
paths that already disable model page review still do so. Existing page/chapter/cover
selection, style screening, Smart Unslop and chapter-edit acceptance checks remain.

## Decisions and context

`DecisionModelAdapter.evaluate` accepts multiple stable-ID typed questions over one
shared context. Choice, boolean probability, and score questions are supported. Scores
are expected zero-based rubric levels (including fractional values), with a validated
probability-weighted mean when a distribution is supplied. They are not page scores.
Existing `choose` callers retain their result shape and LLM fallback policy.

The page screen asks separately about current brief fulfillment, progression, repetition,
continuity, reserved future beats, and contextual style. A seventh grounding question
preserves the diagnostic reviewer's factual-support and private-citation responsibilities.
Every question uses `clean`, `defect`, and `insufficient_context`. Every answer must have
an exact question ID, matching type, allowed choice and valid complete distribution.
All seven must select `clean` with probability at least 0.70 to skip diagnosis. This is
an initial conservative routing policy, not a calibrated accuracy guarantee.

Both paths use `buildPageReviewPrompt`: the same opening contract/import exemption,
sanitized current brief, chapter scope, later reservations, final-page rule, local style
rules, pinned excerpts, reader edit intent, public research notes and retrieved research.
The approved user request overrides stale assignments and intended tone shifts are
protected. Screens additionally make the available complete neighboring prose and full
reservation scope available to both paths, even when compact review mode is selected.
A missing current brief, immediately preceding prose on a non-opening page, or incomplete
remaining chapter map goes directly to diagnosis. Edit callers may infer bounds from a complete
chapter brief when its size matches the declared chapter length. Summaries do not establish novelty.

Deterministic checks still precede screening. Disabling configurable local QA retains its
existing mandatory opening check. The screen additionally refuses to bypass diagnosis
when the existing deterministic placeholder/prompt-leak checks fail. It does not re-enable
optional stylistic heuristics as rejection rules. Unknown routing, unsupported batch
adapters, source preparation failures, malformed answers, weak probabilities and suspected
defects reach the existing `review-page` diagnostic without an intermediate generic LLM
choice. Its repair instructions, report normalization, bounded JSON repairs and legacy
malformed-JSON local fallback remain in place.

The authorized `SourceAwareTextModel.prepareReviewContext` loads a source pack once. All
questions and diagnostic retries share that pack, including exact cited passages and
citation-marker validation. The prepared diagnostic model retains the logged provider
beneath it. Standalone typed decisions still get source enrichment from their decision
wrapper. SDK retries are disabled; the route owns bounded network attempts and one generic
LLM fallback stage for callers that do not request caller escalation. Every physical
attempt gets its own existing `decision.choose.attempt` event and provider-cost row, with
all answers, usage, latency and escalation. A batch is one call, not seven cost rows.
Cancellation escapes without fallback. Diagnostic writes cannot buy another model call.

## Keeper selection policy

A Jev pass carries `scoreBasis: screened_unscored`. Its `score: 75` is a fixed legacy
schema compatibility value and is never calculated from probabilities. It is not a prose
rating. The schema preserves this provenance through persistence and edit inheritance.
Diagnostic reports carry `scoreBasis: reviewer`; older reports without a marker retain
legacy treatment.

`styleAuditedScoreBeats`, used by the worker's `bestDraftCandidate`, applies this policy:

| Candidates being compared | Policy |
| --- | --- |
| Both scored, including legacy reports | Existing reviewer-score comparison. Style penalties count only when both candidates were audited; ties keep the incumbent. |
| Either is unscored | Approved candidate wins over rejected candidate. Between candidates with the same approval state, a candidate free of mandatory placeholder/prompt-leak defects wins over one with those defects. Otherwise keep the incumbent. Never compare numeric scores or probabilities. |

The loop still returns an approved candidate immediately and retains the best failed draft
when the repair budget ends. A later claim/story/style rejection remains a rejection and
keeps its repair instructions and provenance. In mixed failed comparisons this policy
intentionally gives up numeric ranking rather than inventing a quality estimate. The
quality impact of those stable ties remains an evaluation question. Style-audit budgets,
penalty provenance, one-shot Smart Unslop, user-edit inheritance and brief persistence
rules are unchanged.

## Shadow comparison and replay

Shadow always runs the diagnostic and returns its result. The logical
`decision.gate.outcome` records version, mode, per-question answers, escalation,
`wouldAvoidReview`, `reviewAvoided`, screen latency (including route/context preparation),
total review latency, diagnostic approval and disagreement. A disagreement means the
screen's acceptance policy and diagnostic approval differ, including uncertainty that
routes an otherwise acceptable page to diagnosis. It is not automatically a defect miss.
Missing comparisons are null/absent rather than zero-error evidence.

```sh
pnpm page-reviews:compare --output /tmp/page-review-context-coverage.json
pnpm page-reviews:compare --synthetic --live --output /tmp/page-review-smoke.json
pnpm page-reviews:compare --fixtures /path/to/saved-review-fixtures.json --live --output /tmp/page-review-shadow.json
```

The default reads 12 actual saved manuscript pages from three checked-in composed runs.
It audits context availability offline, with mocked decisions/uncaptured diagnostics.
`--synthetic` uses the saved English/Persian finite-choice prose with an explicitly
constructed two-page assignment. Because those are short excerpts, this smoke disables
configurable length/style local gates; mandatory opening and screen integrity remain.
That choice is recorded in each row's provenance. `--live` spends real provider calls;
it uses compiled Fast judgments as the diagnostic baseline and never changes live settings.

The fixture schema in `pageReviewEvaluation.ts` accepts `{id, provenance, options,
frozenReview?, adjudication?}` records. `options` contains real review inputs (input,
plan, page/chapter briefs and bounds, draft, neighbors, continuity, research and optional
reader request). Do not manufacture missing briefs from the candidate's own summary.
Only independently reviewed labels belong in `adjudication`. Private-source fixtures
require an authorized source-aware replay; this standalone harness refuses them.

## Measured results and remaining evaluation gaps

[Saved-context replay](page-review-jev-saved-evaluation.json): 12/12 examples required
diagnosis because context was incomplete, with zero Jev calls, zero avoided or
potentially avoidable diagnostic calls, and no comparable
reviewer verdicts. These composed exports have prose and summaries but no original
page production briefs or page-model reviews. Offline p50/p95 values in that artifact
measure local orchestration only. These are coverage findings, not model-quality results
or production fallback estimates; composed pipelines do not use this model gate.

[Live smoke](page-review-jev-live-smoke.json): four English/Persian synthetic examples,
four Jev physical calls and four DeepSeek v4 Flash diagnostic calls, with no unpriced calls.
All four Jev calls succeeded. Three of four required diagnostic escalation (75%):
two had suspected defects and one had a clean label below the acceptance threshold.
The report's `fallbackFrequency` measures this diagnostic routing, not a provider failure rate.
One could have skipped diagnosis; actual skipped calls were zero
because this was shadow. Screen p50/p95 was 644/1491 ms; complete shadow review was
3416/4048 ms. Known spend was $0.002814: $0.000696 on decisions and $0.002118 on diagnostics.
The one potentially avoided diagnostic cost $0.000707. These tiny cached-prompt smoke
costs do not establish production savings.

Chrome inspection of the
[Gateway logs](https://vercel.com/parsagholipours-projects/~/ai-gateway/logs) on
2026-09-19 independently confirmed HTTP 200 for these four requests at
16:08:36–16:08:46 Asia/Dubai, with Gateway durations of 0.37–0.97 seconds.
Those provider durations exclude the additional work included in screen latency above.

Two acceptance disagreements need interpretation:

- English specific opening: all labels were clean, but fulfillment probability was 0.52,
  so the screen escalated; the diagnostic approved. The saved assignment says *missing*
  payment while the candidate says *duplicate* payment, a plausible reason for uncertainty.
- Persian specific opening: every dimension cleared the threshold, while the diagnostic
  rejected the excerpt as underdeveloped. The English excerpt is similarly brief and was
  approved. This may expose inconsistent reviewer expectations, a Jev development miss,
  or the mismatch between excerpt smoke and full-page review. It is not an adjudicated miss.

No independent human labels were collected. Calibration, full-page multilingual quality,
false acceptance of meaning changes, intentional repetition/caveats, requested tone edits,
real private-source retrieval latency, retained-draft quality under mixed-score ties,
and end-to-end production latency/cost remain unevaluated. Keep shadow until a representative
corpus with original assignments, revisions and evidence is independently adjudicated.
