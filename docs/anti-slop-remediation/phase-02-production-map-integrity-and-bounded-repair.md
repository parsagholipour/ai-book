# Phase 02 - Production-Map Integrity And Bounded Repair

## Objective

Guarantee that `prepareChapterSetups` returns a complete and materially distinct production map before any chapter or page row is created.

Sparse collisions should be repaired in bounded batches. Densely corrupted chapters should be regenerated as chapters. Unresolved structural corruption should stop generation before drafting rather than degrade into advisory notes.

## Prerequisites

- Phase 01 strict generated-response acceptance is complete.
- Invalid numeric and string page arrays fail before becoming `ChapterBrief` values.
- Existing beat-dedup tests pass at baseline.

## Starting Seams

- `apps/worker/src/generation/bookState.ts`
- `packages/core/src/generation/pageBeatDedupDetect.ts`
- `packages/core/src/generation/pageBeatDedup.ts`
- `packages/core/src/generation/pageMapCritic.ts`
- `packages/core/src/generation/pageOverlap.ts`
- Associated worker and core tests

Before editing, read `apps/worker/CLAUDE.md`, `apps/worker/src/generation/CLAUDE.md`, `packages/core/CLAUDE.md`, and `packages/core/src/generation/CLAUDE.md`.

## Clean-Map Guarantee

The observable contract of `prepareChapterSetups` becomes:

> Return chapter setups whose briefs cover the target book exactly and contain no unresolved blocking assignment-integrity findings; otherwise throw before durable page-generation state is reset.

Keep this guarantee behind the existing interface. Callers should not coordinate critic passes, batches, re-audits, or dense-chapter regeneration.

## Full-Map Audit

Add or deepen a pure core interface:

```ts
auditProductionMap(
  briefs: ChapterBrief[],
  contract: ProductionMapContract
): ProductionMapAudit
```

The audit should report:

- Exact page and chapter coverage
- Generic or metadata-only assignments that escaped earlier compatibility reads
- Duplicate assignment fingerprints
- Strong near-duplicate beats
- Chapter-level corruption density
- Sparse findings eligible for page-level repair
- Dense findings requiring chapter regeneration

Detection must scan the complete map. A provider-call batch limit must never terminate detection.

## Corruption Classification

Use two repair classes.

### Sparse corruption

Use page-level patching when:

- Findings affect less than 25% of the chapter's pages.
- The remaining chapter assignments provide enough distinct context for a repair.
- Page coverage and schema structure are otherwise valid.

### Dense corruption

Regenerate the chapter brief when:

- At least 25% of its assignments share a generic or duplicate fingerprint.
- The chapter has no reliable sequence around the affected pages.
- Repairing individual pages would require inventing most of the chapter map from one summary.

Treat the 25% value as an explicit policy constant with tests. Phase 05 may calibrate it, but it must not be hidden in prompt prose.

## Bounded Repair Algorithm

1. Audit the complete map.
2. Regenerate dense chapters using the Phase 01 strict acceptance path.
3. Group remaining sparse findings by chapter.
4. Send at most twelve findings per provider call.
5. Merge the returned patch.
6. Re-audit the entire map, not only repaired pages.
7. Repeat for at most two full repair cycles.
8. Throw `PAGE_MAP_INTEGRITY_UNRESOLVED` if blocking findings remain.

The existing twelve-finding constant remains a per-call token and response bound. It no longer limits the number of findings the book can detect or handle.

## Failure And Degradation Policy

- Progress-message writes may remain best-effort.
- Deterministic detection may not degrade to an empty finding list.
- A provider repair failure may fall back to dense chapter regeneration when safe.
- A failed merge may not return the original corrupt map as if it were clean.
- A stop request must escape every retry and batch loop.
- No page or chapter persistence begins until the final audit is clean.

This phase intentionally changes the current principle that a chapter-brief failure should never fail the book. Structural planning integrity is cheaper to retry than 120 pages of unusable drafting.

## Tier Policy

Move mandatory behavior outside `GenerationQualityRevision`:

- Exact map validation
- Full-map collision detection
- Generic assignment detection
- Blocking repair or regeneration

The following may remain configurable:

- General model page-map criticism when no deterministic defect exists
- Optional enrichment or polish of already distinct beats

Do not merely enable `beatDedup` in compiled defaults. Stored revisions can override defaults, and correctness must not depend on an operator checkbox.

## Implementation Tasks

1. Add the full-map audit result and typed finding codes.
2. Split detection results from findings selected for one rewrite call.
3. Add deterministic corruption-density classification.
4. Refactor `dedupeBriefBeats` into batch orchestration behind `prepareChapterSetups`.
5. Add dense chapter regeneration through the strict Phase 01 path.
6. Re-audit after every merge or regeneration.
7. Enforce a bounded full-cycle limit.
8. Ensure `resetBookForDirectGeneration` is unreachable until the map is clean.
9. Preserve plan-thinking routing and provider accounting across retries.
10. Add progress messages that distinguish detection, page repair, chapter regeneration, and unresolved failure.

## Required Tests

### Core

- Detection returns more than twelve findings when the map contains them.
- Findings after position twelve still carry evidence and classification.
- Sparse findings group deterministically by chapter.
- Dense corruption crosses the documented threshold.
- Similar chapter topics with distinct page assignments remain clean.
- Re-audit catches collisions introduced by a model patch.

### Worker

- Thirty sparse findings are processed across several calls.
- A densely generic chapter is regenerated instead of patched page by page.
- A valid regeneration replaces only the affected chapter.
- Two unsuccessful repair cycles fail before persistence.
- A stop request exits during a later batch.
- A failed progress write does not suppress the repair call.
- A failed integrity detector does not degrade to a clean map.
- Every model call has bounded input, purpose metadata, logging, and accounting.
- Clean maps make no dedup repair call.

## Acceptance Criteria

- The complete map is always scanned regardless of repair-call limits.
- No unresolved generic or blocking duplicate assignment reaches the drafter.
- More than twelve collisions are handled or generation fails explicitly.
- Dense corruption causes chapter regeneration.
- Integrity behavior is identical across quality tiers.
- Clean books add no model cost.
- Stop, progress, provider routing, and persistence ordering tests pass.

## Rollback Strategy

During initial deployment, a temporary enforcement rollout control may record `would_block` while retaining prior behavior. It must:

- Be independent of model tier.
- Default to enforcement after Phase 05 calibration.
- Never hide metrics or findings.
- Be removed once rollback confidence is established.

## Handoff To Phase 03

Phase 03 may assume new books were drafted from a structurally valid production map. It still must detect prose-level repetition caused by writer behavior, weak but technically distinct beats, manual edits, or older persisted books.
