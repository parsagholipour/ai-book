# Anti-Slop Remediation Plan

This folder contains the phased implementation plan for preventing polished but structurally repetitive books from passing generation and export quality controls.

The plan is based on two observed failure classes:

- A malformed production map was normalized into generic page assignments, after which individually fluent pages repeated the same subjects, evidence, and conclusions.
- Manuscript-wide rhetorical repetition was detected only as advisory warnings because page-local checks, phrase catalogues, and publication policy did not treat its prevalence as blocking.

The remediation is deliberately ordered from upstream prevention to downstream detection. Later review and repair must not compensate for a page map that never assigned distinct work to each page.

## Start Here

Every implementation run should read, in order:

1. [Agent Runbook](./AGENT-RUNBOOK.md)
2. This README
3. The current phase document
4. Output notes from all completed phases in this folder
5. The applicable repository `CLAUDE.md` files for every code directory being changed

## Target Outcome

The generation pipeline should enforce this sequence:

1. Accept only structurally valid generated chapter briefs.
2. Audit the completed production map before any page is drafted.
3. Repair sparse collisions and regenerate densely corrupted chapter briefs.
4. Draft pages only from a clean, distinct production map.
5. Audit completed prose at sentence, page, chapter, and manuscript scale.
6. Send focused actual prose to model reviewers only when deterministic evidence identifies a risk cluster.
7. Produce readable artifacts for review while preventing blocking manuscripts from being labeled complete.

## Phase Order

1. [Phase 01 - Regression Harness And Strict Page-Map Acceptance](./phase-01-regression-harness-and-strict-page-map-acceptance.md)
2. [Phase 02 - Production-Map Integrity And Bounded Repair](./phase-02-production-map-integrity-and-bounded-repair.md)
3. [Phase 03 - Manuscript Structural Audit](./phase-03-manuscript-structural-audit.md)
4. [Phase 04 - Targeted Prose Review And Publication Policy](./phase-04-targeted-prose-review-and-publication-policy.md)
5. [Phase 05 - Style Contract, Quality Settings, And Rollout](./phase-05-style-contract-quality-settings-and-rollout.md)
6. [Phase 06 - Structural Consolidation And Long-Term Hardening](./phase-06-structural-consolidation-and-hardening.md)

Phases 01 and 02 form the prevention milestone. Phases 03 and 04 form the detection and enforcement milestone. Phase 05 calibrates the behavior for production. Phase 06 is optional until the earlier phases demonstrate sufficient precision.

## Global Invariants

These are correctness properties, not optional quality features:

- A generated page assignment is an object with a valid page index and substantive purpose, beat, and ending pressure.
- No missing model field is converted into generic reader-facing work such as `Advance the chapter on page N`.
- Every expected global page is assigned exactly once and in order.
- Every page is assigned work distinct from the pages around it and from materially similar pages elsewhere in its chapter.
- A repair budget may bound one provider call, but it may not truncate whole-book detection.
- An operator quality setting may disable optional polish, but it may not disable structural integrity validation.
- Summaries are never represented to a reviewer as complete manuscript prose.
- A blocking quality report may still produce inspectable artifacts, but the project must remain review-required.
- Imported or manually edited prose is not silently rewritten by structural detection.

## Module Design

Prefer deepening the existing generation interfaces over adding pass-through layers:

- `generateChapterBrief` owns strict response acceptance.
- `prepareChapterSetups` owns full-map preparation, repair, and the clean-map guarantee handed to drafting.
- `runDeterministicManuscriptChecks` owns deterministic manuscript integrity findings.
- Compile quality orchestration owns focused model adjudication and publication state.
- `buildManuscriptQualityReport` owns the final mapping from findings to quality state.

Pure detection belongs in `packages/core`. Database, job progress, provider logging, retries across chapters, and publication fencing belong in `apps/worker`.

## Non-Goals

- Do not turn Smart Unslop into an unbounded blacklist of disliked words.
- Do not send an entire long book to one model call and call that semantic review.
- Do not make every stylistic warning blocking.
- Do not automatically rewrite completed user books during rollout.
- Do not change quality tiers to hide integrity failures.
- Do not weaken existing stop, ownership, publication-fence, or edit-revision semantics.

## Program Definition Of Done

- Malformed numeric or string page arrays cannot reach persisted chapter briefs.
- The system never drafts from generic fallback assignments.
- A production map with more than twelve collisions is fully handled or rejected, never partially repaired and silently accepted.
- Known same-chapter paraphrase clusters are surfaced with page indexes and evidence.
- Manuscript-wide cadence saturation can block on prevalence without requiring unrelated warning families.
- Model structural review consumes actual prose from focused risk clusters.
- Clean books incur no additional structural-review model call.
- Blocking findings result in inspectable exports and `REVIEW_REQUIRED`, not `COMPLETE`.
- Quality reports explain the measured recurrence and show actionable page clusters.
- The rollout meets the precision, cost, and latency gates in Phase 05.

## Output Notes

At the end of each phase, add `phase-NN-output-notes.md` to this folder using the handoff template in the runbook. Output notes are part of the next phase's starting context and must record deviations from the plan.
