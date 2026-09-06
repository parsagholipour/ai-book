# Remove heuristic editing; improve the material

User request: remove deterministic checks that can produce false positives and propose a solution.

## Implemented

- Removed the regex-triggered couplet rewrite, its names/numbers and sentence-shape acceptance rules, and the every-third-disclaimer deletion pass. Historical cadence measurements remain read-only. The persisted `coupletRewrite` flag is labelled retired and cannot reactivate the pass.
- Removed automatic sentence deduplication and paragraph merging from both chapter finalization and manuscript cuts. A repeated sentence can be a quotation, refrain or an intentional return; a continuation word does not authorize merging paragraphs.
- The episode planner keeps its first structurally valid answer. Shared names and method-shaped wording no longer trigger a paid re-ask, episode deletion, or blanking of an assignment. Old plan diagnostics are advisory; `applyFocusContract` is an inert compatibility wrapper for archived scripts.
- Valid stances no longer regenerate because they mention evidence or a distinction. Voice-guide lines reach the writer unchanged.
- The existing contextual editor now explicitly preserves negation, causality, scope and uncertainty. It can leave a passage unchanged. Numerical style measurements are not targets, and reader notes do not override factual preservation. The manuscript reader must identify both the proposed cut and the retained passage that makes the same point.
- Source windows are no longer discarded for missing shared names; the existing bounded extractor judges relevance in context. Epigraphs no longer require a capitalized-word overlap. Term hits still rank windows, and exact passage extraction still verifies source text.
- A cut with no headroom makes no model call. Its explicit word allowance is enforced in code, independently of the page floor. Small valid cuts no longer have to remove at least 0.5% of a chapter. The actual 7.4 run spent 149.68 seconds on four zero-allowance calls; candidate 8 spent 108.91 seconds on four.

Structural validation, exact-text operation checks, page budgets, source quotation provenance, figure preservation and corruption handling remain. They do not certify semantic equivalence. A model editor can still make a factual mistake; removing these heuristics eliminates a demonstrated source of damage, not that general risk.

## Verification

Regression tests were run before the fix and failed on the actual worker path: a necessary qualification disappeared, an intentional repetition disappeared, and separate paragraphs merged. Cut tests failed because zero allowance still made a call and an over-budget cut was accepted.

After removal, the worker regression preserves those passages even with the old rewrite flag enabled, and no `rewrite-couplets` request occurs. Planning regressions retain Napoleon's 1804 coronation and 1814 abdication and the evidence-focused assignment in one model call. Source regressions allow the extractor and epigraph selection to retain a passage using pronouns without shared proper nouns.

Final `pnpm check`: all seven gates passed in 99.8 seconds (typecheck, lint, sizes, invariant index, subpath checks, subpath tests, workspace tests). Workspace tests: 6,818 passed and five skipped. The first full check caught stale expectations for the removed behavior and the documentation index; those were corrected before the final clean run.

Fable worker: `claude-fable-5-1`, effort `xhigh`, confirmed in its session initialization. It reached its $5 budget after applying the bounded planning changes; the parent reviewed and verified the changes. No book was generated for this removal. Writer/editor routing remains Luna.

## Proposed next quality experiment

The 7.5 book assigned scene material to eleven chapters, but only two chapters received excerpts and neither produced a usable scene. Changing prose rules cannot supply missing material. The next experiment should change how the book selects material, with a fixed retrieval budget:

1. **Retrieve before committing the detailed outline.** Start with a coverage map from the brief, retrieve candidate records, then choose cases that have usable passages. Missing material prompts an alternative case within the same coverage requirement or an explicit coverage gap. Do not fill gaps with invented witnessed details.
2. **Plan from source cards.** Each card contains the event, time, actors, exact source passages and what those passages support. Let Luna judge relevance and distinguish different events involving the same person. Use stable card IDs for references; code checks IDs, not whether names imply duplicate content.
3. **Assign distinct chapter work.** Luna sees the whole card set and assigns each chapter a question, material, and contribution that advances the book. Source-supported accounts, close readings and comparisons should follow the material; there is no scene quota or universal paragraph template.
4. **Keep editing bounded.** Use the existing chapter edit and whole-manuscript read. Require contextual reasons for edits and retained evidence for cuts. Avoid another per-sentence reviewer loop. Log the original and edited passages for inspection.
5. **Measure a whole book.** Generate only one Luna book at a time. Use the same rubric and assessor model for candidate and reference in the same sitting. The user's requested assessor is Sol; old Opus scores are not interchangeable with Sol scores. Stop when one complete book meets the agreed 8+ criterion. Track cost, elapsed time, factual losses, engagement and pacing alongside the mean.

The source-first outline is a proposal, not implemented by this patch. The existing 7.4 and 7.5 scores describe earlier configurations; there is no new whole-book score for these changes.
