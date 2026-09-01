# Phase 04 - Targeted Prose Review And Publication Policy

## Objective

Use deterministic structural findings to build small, focused review packs containing actual manuscript prose, then map confirmed structural defects to an honest publication state.

This phase does not automatically consolidate duplicated prose. It detects, adjudicates, reports, exports for inspection, and keeps blocking manuscripts review-required.

## Prerequisites

- Phase 03 emits stable structural clusters with page indexes, metrics, and concise evidence.
- Shadow results show acceptable candidate recall.
- Existing compile, repair, and publication-fence tests pass at baseline.

## Starting Seams

- `packages/core/src/generation/pagesReview.ts`
- `packages/core/src/generation/manuscriptQuality.ts`
- `apps/worker/src/handlers/compileExport.ts`
- `apps/worker/src/generation/exportQualityReview.ts`
- `apps/worker/src/handlers/compileExportStandDown.ts`
- `apps/worker/src/handlers/compileExportRepair.ts`
- Existing compile quality, repair, policy, and stand-down tests

Before editing, read `apps/worker/src/handlers/CLAUDE.md`, `apps/worker/src/generation/CLAUDE.md`, and `packages/core/src/generation/CLAUDE.md`.

## Review Responsibility Split

Assign one honest responsibility to each review path.

### Deterministic manuscript audit

Owns:

- Candidate discovery
- Counts, prevalence, and page clustering
- Exact and high-confidence mechanical findings
- Selection of prose that deserves semantic adjudication

### Targeted structural reviewer

Owns:

- Whether candidate pages repeat the same subject treatment
- Whether they reuse materially the same evidence
- Whether their conclusions or explanatory moves are redundant
- Which page contains the strongest treatment
- Whether later pages advance, challenge, apply, or merely restate

### Final-book QA

Owns:

- Opening quality from actual opening prose
- Map-level progression visible from summaries
- Obvious placeholders and export artifacts provided to it
- High-level completeness within the actual supplied payload

It must not claim to have inspected complete manuscript prose when it received summaries.

### Chapter-transition review

Owns:

- Actual end/open transition excerpts
- Chapter-level coherence from explicitly bounded prose

Do not send a very large undifferentiated payload merely because the model context window permits it.

## Review-Pack Module

Add a pure pack builder, recommended as an internal core or worker-generation module:

```ts
buildManuscriptReviewPacks(
  pages: ReviewablePage[],
  findings: ManuscriptQualityIssue[],
  limits: ReviewPackLimits
): ManuscriptReviewPack[]
```

Each pack should contain:

- Finding code and deterministic metrics
- Chapter index and title
- Up to four implicated pages
- Full or generously bounded actual prose for those pages
- Immediate neighboring summaries for sequence context
- Explicit labels distinguishing prose, summary, and detector evidence
- The question the reviewer must answer

Pack construction must be deterministic. Tests should assert the selected pages and content labels, not internal token calculations.

## Candidate Limits

- Group overlapping pair findings into one cluster.
- Prefer the highest-prevalence and highest-evidence clusters.
- Bound each pack to four pages.
- Bound prose per page explicitly.
- Bound packs per provider call.
- Set a maximum number of structural-review calls per book.
- If candidates exceed the review budget, retain deterministic blocking candidates and report unadjudicated warnings rather than pretending review was exhaustive.

Recommended initial budget:

- Up to three packs per call
- Up to two calls per book
- No call when there are no structural candidates

Phase 05 should adjust these bounds from observed token and cost data.

## Reviewer Output

Use a strict structured schema:

```ts
type StructuralReviewResult = {
  clusters: Array<{
    canonicalPageIndex: number;
    duplicatePageIndexes: number[];
    repeatedSubject: string;
    repeatedEvidence: string;
    repeatedConclusion: string;
    confidence: "low" | "medium" | "high";
    recommendedAction: "keep" | "review" | "consolidate";
  }>;
}
```

Validation rules:

- Every page index must come from the supplied pack.
- A canonical page may not also appear in `duplicatePageIndexes`.
- A blocking cluster requires at least one canonical and one duplicate page.
- Empty or generic explanations are rejected by schema or post-validation.
- The model may return no cluster when the deterministic candidate is a legitimate recurring subject.

## Corroborated Findings

Convert a model result into a manuscript issue only when:

- It references a deterministic candidate cluster.
- It names valid page indexes.
- It explains at least two of subject, evidence, and conclusion overlap.
- Its confidence is high for blocking consideration.

Initially:

- High-confidence corroborated clusters become blocking candidates.
- Medium-confidence clusters become warnings.
- Low-confidence results remain diagnostic only.

Do not trust self-reported confidence alone. The underlying deterministic candidate strength must travel with the issue.

## Publication Policy

Deepen `buildManuscriptQualityReport` so its interface owns one clear policy:

- Any blocking integrity issue results in `blocked`.
- Advisory deterministic or model findings result in `review_recommended` when they affect the verdict.
- No findings results in `passed`.

Change blocking evaluation from “deterministic errors only” to explicit issue severity, while ensuring existing model reviewers continue to emit warnings unless the structural corroboration path intentionally constructs an error.

Compile behavior remains:

- Produce the best available Markdown, PDF, EPUB, and reader artifacts.
- Store the complete quality report.
- Set the project to `REVIEW_REQUIRED` for blocked findings.
- Keep `COMPLETE` only for passed or deliberately advisory outcomes.

## Prompt Corrections

Update final-book QA language so:

- `pageMap` is called abbreviated planning or progression context.
- `openingPages` is called actual opening prose.
- The reviewer is not asked to decide full-book repeated-page quality from summaries.
- The instruction no longer says the complete compiled Markdown was supplied when it was not.

Preserve existing page-QA prompt modes and provider-call telemetry when touching shared review code.

## Implementation Tasks

1. Add review-pack types and the pure pack builder.
2. Add strict structural-review output validation.
3. Add a bounded structural-review provider call with a distinct purpose.
4. Add provider logging and usage accounting.
5. Integrate it after deterministic candidate discovery and before final grading.
6. Correct final-book QA payload terminology and responsibilities.
7. Narrow chapter-transition review to clearly labeled actual prose and transition excerpts.
8. Create corroborated structural issues with evidence and severity.
9. Update report grading to act on explicit blocking severity.
10. Preserve artifact publication and project-status fencing.

## Required Tests

### Review packs

- A three-page cluster produces one pack containing actual prose.
- Overlapping pairs merge into one pack.
- Neighboring summaries are labeled and cannot be mistaken for prose.
- Clean findings produce no pack.
- Pack and call limits are deterministic.

### Model review

- Returned indexes outside the pack fail validation.
- A legitimate recurring topic can be cleared.
- A high-confidence subject/evidence/conclusion duplicate becomes a blocking issue.
- Medium confidence remains advisory.
- Provider failure preserves deterministic findings and never claims approval.
- Stop requests escape.
- Clean manuscripts make no structural-review call.

### Compile and publication

- Blocking structural issues still produce exports.
- The project ends `REVIEW_REQUIRED` rather than `COMPLETE`.
- Advisory findings retain `review_recommended` behavior.
- Superseded exports stand down correctly.
- A later edit cannot be graded against stale pages.
- Final-book QA payload tests prove summaries are not described as full manuscript prose.

## Acceptance Criteria

- Structural adjudication reads focused actual prose.
- Clean books incur no new model cost.
- Review calls are bounded and accounted.
- High-confidence corroborated duplication can prevent `COMPLETE`.
- Blocked books retain inspectable artifacts and repair paths.
- Existing compile ownership, repair, revision, and stand-down suites pass.
- The final reviewer no longer criticizes page summaries for being an outline submitted as prose.

## Non-Goals

- Automatic consolidation
- Retroactive mutation of existing complete books
- Removing page-local QA or Smart Unslop
- Treating all model criticism as blocking

## Handoff To Phase 05

Phase 05 calibrates thresholds, costs, quality settings, and style guidance using real shadow and adjudication results before full enforcement.
