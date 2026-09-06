# Automated developmental editing: mechanics fixed; literary result still experimental

The user authorized further implementation and experiments after the manually specified Chapters 6–7 repair. The parent designed the changes and verified them. Claude Code **Fable 5.1 xhigh** wrote four specified regression tests. Production-writer replays used **gpt-5.6-luna, low effort**, through the existing logged adapters. Fresh **Sol** agents assessed anonymous excerpts without access to edit instructions or earlier scores.

## Implementation

- Valid independent groups survive a malformed, overlapping or out-of-range group. Only accepted groups reserve ranges, IDs, and the shared edit budget. A move's source and destination remain atomic, and all coordinates refer to the original manuscript.
- Pure deletions use no rewrite call. An explicit extractive mode can assemble selected existing paragraphs verbatim; generated prose is rejected in that mode. Actual copied word counts, figure protection, editable chapter scope and the whole-book word budget are enforced.
- The experimental worker uses extractive editing. Unchanged chapters receive no composition-option load, line edit, evidence review or description call. Changed chapters get evidence review and pagination; residual findings are recorded without a new whole-chapter rewrite/repair loop. The ordinary compose-time line edit remains in its original place, including when this experimental stage is opted in.
- The automatic length-extension loop is removed from this stage. A requested cut cannot buy its length back with rewritten filler. The core rejects a group that falls below the requested minimum; a pre-existing shortfall may still be recorded by the worker without another paid extension.
- After the control failed, the worker's experiment was narrowed to repeated case treatments across chapters. Proposed groups must identify retained case paragraphs in another chapter; missing/deleted anchors and disappearance of numeric details are rejected. Empty chapters and changes that reproduce the existing text are also rejected.
- Page comparison-and-swap checks still cover all staged pages, including unchanged rows, and linked changes plus the restart marker commit together. No changes were made to live quality settings or defaults: the three experimental stages remain disabled.

The numeric guard is deliberately conservative and incomplete. It catches a disappearing unique date, not all factual or attribution losses; a number retained elsewhere is not evidence that its original claim survived. Explicit retained paragraphs are a mechanical reference check, not semantic proof. These guards do not establish that an edit is good enough to publish.

## Replays and blind readings

| Run | Result | Logged writer cost | Wall time |
|---|---|---:|---:|
| candidate-1 | Rejected cut: length floor | $0.023848 | 12.1s |
| reference-control-1 | Applied 4 groups | $0.019441 | 21.6s |
| candidate-2 | Rejected cut: length floor | $0.023776 | 8.8s |
| reference-control-2 | No edit proposed | $0.017631 | 6.1s |

Every replay used one planning call, with a two-attempt diagnostic cap; no prose-generation call was made. The first pair allowed general extractive cuts in Chapters 6–8. The second pair restricted them to cross-chapter case duplication. All other chapters were readable context but outside the editable scope. Source-file hashes remained unchanged.

**Weak book:** the first planner correctly found repeated Mongol material, proposing two deletions in Chapter 6. The real budget rejected them: the book has 52,063 readable prose words against a 51,600 minimum, leaving only 463 words to cut. The proposal removes 1,654 words, which would leave a 1,191-word shortfall. No structural changes were applied to the real-length candidate.

To test the prose separately from length, the captured proposal was replayed locally through the production application code with a diagnostic lower floor. This spent **zero additional model calls**, changed no production configuration, and published nothing. The excerpt fell from 5,811 to 4,157 whitespace words. Two fresh Sol readers in opposite orders preferred it:

| Reader | Original excerpt | Proposed cut |
|---|---:|---:|
| Revised first | 6.8 | 7.7 |
| Original first | 6.7 | 7.5 |
| Mean | **6.75** | **7.6** |

This was still a failed publication candidate. One reader found the omitted approximate birth date (1160), and a Chapter 6 comparison now referred to material introduced only in Chapter 7. Parent inspection also finds distinct details such as Hulagu's attribution and Alan Gua's widowhood/abandonment in the removed passages; literal copying alone cannot preserve them if their paragraphs are deleted. Chapter 7's repetitive coda survived. These are not grounds to claim an 8+ result or re-enable the feature.

**Older reference control:** the first planner removed 725 words in four groups, all inside Chapters 6 and 8, and remained within the requested length. Sol narrowly preferred the original **8.4 to 8.3**. More significant than that small score difference were specific losses: the labour-demand causal distinction, cultural reconstruction as a form of resistance, and the state's double role. The cut also stranded “The Royal African Company illustrates the difference.” The planner called these passages recap; the reader found substantive contributions. The scores are excerpt judgments and should not be compared with the historical full-book score for this reference.

**Narrowed second pair:** the stronger reference was left unchanged. The weak-book planner retained its opening (and birth date) and proposed a different cross-chapter cut, but the real length floor again rejected it. Neither final output changed. These unchanged outputs received no new literary score. The latest version therefore demonstrates safer abstention on this control, not a proven new quality gain. The second proposal also remains unverified for full semantic preservation; its retained-paragraph list is no substitute for reading.

## Verification

Four focused tests failed against the saved original implementation and passed against the repair. The first test specification used a minimum too high for its pure-deletion fixture; the parent corrected the fixture to isolate the intended bug and reran the original implementation red before accepting the fix. Additional tests exercise extractive moves, missing source references, generated-prose rejection, editable scope, actual copied-word accounting, retained-case anchors, a disappearing unique date, unchanged edits and empty chapters. The worker regression reproduces the original paid no-op polishing behavior, then verifies that it spends no downstream model calls after the fix. Worker tests also cover residual recording, lack of automatic refill, figures, restart, page coverage and concurrent edits.

The old integration assertion requiring a post-plan line-edit call failed after the intentional removal; it now verifies that the stage does not add that call. All original logs, including the initial full-check failure, remain in this directory. The final `pnpm check` passed all seven gates: typecheck, lint, sizes, gotchas, subpaths, subpath tests and workspace tests. The workspace suites passed 6,740 tests, with 5 skipped; the separate subpath suite passed 14 tests. See [check-final.log](check-final.log).

The parent independently validated all three blind verdicts, every quoted evidence substring and all score arithmetic. No provider secrets were captured in experiment summaries. Source manuscripts, database manuscripts and live quality settings were not changed. No whole-book generation jobs, new book projects, commits, pushes or deployments were performed.

## Cost and next decision

Four logged planning calls total **$0.084696** in estimated provider costs. Fable's bounded test-writing session reported **$0.88508125**, including $0.001777 of ancillary Haiku usage; its primary model was the requested `claude-fable-5-1`, with `--effort xhigh`. Sol and parent-assistant usage are separate and no dollar total for them is available here. This was inexpensive in generation-provider calls; it is not a total task-cost claim.

Keep the experimental stage disabled. The repair prevents demonstrated waste and preserves independent operations, but broad automated cutting did not reliably preserve the book's argument. The next substantive test should improve **chapter-specific material and coverage before drafting**, using an existing weak chapter as a fixed input. It must add documented explanation that the chapter needs and compare it blindly at the same length, so an apparent win cannot be explained only by shorter text. If length-preserving depth cannot be demonstrated on that chapter, another full-book run is premature. A separate broader book sample is also needed before treating the safer cross-chapter abstention as general behavior.

Artifacts: [summary.json](summary.json), [candidate-1-editorial/revised.md](candidate-1-editorial/revised.md), [evals](evals/), [replay.ts](replay.ts), [apply-proposal.ts](apply-proposal.ts), [core-red.log](core-red.log), [worker-red.log](worker-red.log), [core-green.log](core-green.log), [worker-green.log](worker-green.log), and [check-final.log](check-final.log).
