# Phase 06 - Structural Consolidation And Long-Term Hardening

## Objective

Optionally add safe automatic consolidation for confirmed duplicate-treatment clusters, then harden the complete system with long-term evaluation, operational tooling, and simplified legacy paths.

This phase is intentionally last. Phrase replacement and independent page rewrites are insufficient for structural duplication; repair must reassign the later pages' work before redrafting them.

## Entry Gate

Do not start automatic consolidation until all are true:

- Phase 05 precision gates are met.
- High-confidence blockers have fewer than 10% manual overturns in the reviewed sample.
- Review packs reliably identify canonical and duplicate pages.
- The product accepts the cost and behavior of automatic redrafting.
- Credit, consent, and user-visible repair policy are decided for existing books.

If these conditions are not met, keep structural findings review-only and complete only the hardening tasks in this phase.

## Starting Seams

- `apps/worker/src/handlers/compileExportRepair.ts`
- `apps/worker/src/generation/pageReviewRecovery.ts`
- `apps/worker/src/generation/pageReview.ts`
- `packages/core/src/generation/pagesPageMap.ts`
- `packages/core/src/generation/pagesReview.ts`
- `packages/core/src/generation/manuscriptQuality.ts`
- Compile repair, publication, recovery, and stand-down tests

Before editing, read every applicable worker generation and handler invariant, especially durable brief repair, publication ownership, stop propagation, and revision fencing.

## Repair Principle

For each confirmed cluster:

1. Keep one canonical page.
2. Decide what later pages should accomplish instead.
3. Repair the later pages' production briefs.
4. Redraft from the repaired briefs.
5. Review the new pages locally and contextually.
6. Re-audit the full affected chapter.
7. Publish only when the cluster is gone and every normal ownership fence still holds.

Never ask a prose rewriter merely to “make this less repetitive” while leaving the duplicate page assignment intact.

## Canonical Page Selection

Use deterministic and reviewed evidence:

- Prefer the earliest complete treatment when later pages merely recap it.
- Prefer the page best aligned with the approved production map.
- Prefer the page with the strongest concrete evidence and most specific bounded conclusion.
- Do not move or delete user-authored pages automatically.
- Do not make canonical selection depend only on model confidence.

If selection is ambiguous, leave the cluster review-required.

## Replacement Assignment Generation

The repair model receives:

- Chapter title and summary
- Full chapter production map
- Canonical page assignment and prose summary
- Duplicate page assignment and prose
- Future reserved beats
- Plan promises and continuity requirements
- The specific reason the old assignment is redundant

It returns a complete replacement `PageProductionBeat` through the strict generation schema from Phase 01.

The new assignment must:

- Advance an uncovered chapter obligation or deepen an existing one from a distinct angle.
- Avoid taking work reserved for another future page.
- Preserve valid continuity.
- Provide a concrete ending pressure.
- Pass full production-map audit before drafting begins.

## Durable Write Semantics

Preserve the repository invariant:

> A brief repair's durable chapter write waits for the page to keep a draft it briefed.

The repair flow should stage the brief and draft together, then commit them under the existing repair ownership fence. A failed or rejected draft must not leave the chapter production brief describing prose that was never published.

## Repair Bounds

- Repair one cluster at a time within a chapter.
- Prefer later duplicate pages; do not rewrite the canonical page automatically.
- Bound pages redrafted per compile.
- Bound repair cycles per chapter.
- Re-audit after each cluster because one replacement may create a collision elsewhere.
- If the bound is exhausted, retain artifacts and `REVIEW_REQUIRED`.

Recommended initial bound:

- At most three redrafted pages per chapter
- At most six redrafted pages per book
- One structural consolidation cycle followed by one verification cycle

Phase output notes must record the observed cost and whether these bounds were changed.

## User And Import Safety

Do not automatically consolidate:

- Imported manuscripts
- Pages marked as user-edited after generation
- Books already complete before the feature rollout
- Books whose current content revision changed during review
- Clusters involving quotations, deliberate refrains, legal wording, exercises, or reference definitions unless a safe genre-specific policy exists

These cases remain review-required with evidence.

## Implementation Tasks

1. Add a structural repair target selector.
2. Add strict replacement-assignment generation.
3. Reuse production-map audit on the staged replacement.
4. Draft and review the replacement page under existing QA gates.
5. Stage brief and page publication under one ownership fence.
6. Re-run chapter and manuscript structural checks.
7. Bound cluster, page, call, and cycle counts.
8. Add user-edit, import, content-revision, and supersession exclusions.
9. Add explicit repair telemetry and accounting.
10. Surface unresolved clusters with canonical and duplicate pages in the operator quality view.

## Required Tests

- The canonical page remains unchanged.
- A replacement brief advances distinct chapter work.
- A replacement taking a future page's reserved beat is rejected.
- A failed draft does not persist the staged brief.
- An accepted draft persists its matching brief and page together.
- Re-audit clears the original cluster.
- Re-audit catches a new collision introduced by repair.
- Repair bounds route remaining work to review-required.
- Imported and user-edited pages are never automatically consolidated.
- Content revision and export supersession stand down safely.
- Stop requests escape every call and verification pass.
- Every provider call and redrafted page is cost-attributed.

## Long-Term Hardening

After consolidation behavior is stable:

- Remove temporary shadow flags and dead compatibility paths.
- Retire duplicate detector implementations superseded by the deep manuscript interface.
- Keep detector versions in reports for historical comparison.
- Add periodic offline evaluation against a curated corpus.
- Track manual overturns and repair acceptance as ongoing quality signals.
- Review phrase-family tables from evidence rather than adding every disliked phrase.
- Revisit thresholds when book-length or language distributions change materially.

## Acceptance Criteria

- Automatic repair changes page assignments before prose.
- Brief and page publication remain consistent under failure and concurrency.
- The repaired chapter passes a fresh structural audit.
- Ambiguous, imported, edited, or stale-revision cases remain review-only.
- Repair is bounded, observable, and accounted.
- Temporary rollout code is removed or has an explicit retained purpose.
- The complete anti-slop program definition of done in the folder README is satisfied.

## Final Program Handoff

Record:

- Final enforced thresholds
- Detector and review schema versions
- Active quality revision
- Provider-call budgets
- Automatic repair exclusions
- Known false-positive and false-negative classes
- Operational replay and audit commands
- The owner and cadence for future corpus calibration
