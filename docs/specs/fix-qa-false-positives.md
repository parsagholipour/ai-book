# Fix QA False Positives

Status: Implemented; ready for code review  
Origin: `.cursor/plans/fix_qa_false_positives_6fa0f4bd.plan.md`

## Objective

Prevent valid pages from entering expensive QA rewrite loops for either of two unsatisfiable reasons:

1. Honest sourcing hedges are mistaken for formulaic AI contrast.
2. A page is required to identify a diary, dispatch, archive, citation, or testimony when the project has no reader-facing source capable of supplying that identity.

Real defects—including invented sources or scenes, factual errors, repetition, overpacking, placeholders, and prompt leakage—must continue to fail and remain eligible for repair.

## Definitions

- **Citeable research note:** A research source backed by a non-blank URL, matching the eligibility rule used by reader-facing Sources back matter. Core may receive these as pre-filtered strings; structured plan notes are citeable only when their URL is present.
- **Source-identity complaint:** A stored page-level QA issue whose sole complaint is that a required diary, dispatch, archive, citation, named testimony, documented civilian account, or equivalent source identity was not named or identified.
- **Repairable defect:** Any substantive manuscript problem, including an invented or fabricated source/scene, factual error, repetition, duplicate material, overpacking, placeholder, prompt leak, or schema leak.

## Requirements

### QA-1: Narrow adjacent-contrast detection

`hasFormulaicAdjacentContrast` must reject a sentence pair only when the first sentence is a real rhetorical setup and the second resolves it as a sweeping thesis contrast.

A bare negation in ordinary prose must not be sufficient. In particular, prose shaped like “does not identify the publication or exact date. It therefore offers limited evidence” must pass local QA when otherwise sound.

### QA-2: Preserve other contrast checks

The local QA rule for repeated “not just X, it is Y” constructions must remain active. Existing rhetorical setups such as “You have been taught…” followed by a sweeping “But what if…” thesis must also remain failures.

### CIT-1: Use one citation contract

Core must expose one citation-contract helper that returns both:

- The source-identity rules a prompt must state.
- The exact `researchNotes` payload those rules describe.

The rules and payload must be derived together so a prompt cannot state a source requirement without carrying the evidence gate that satisfies it.

### CIT-2: Behavior with no citeable notes

When the filtered `researchNotes` list is empty, production and review prompts must:

- Prefer grounded people, places, dates, qualified claims, and other supportable specifics.
- Not assign, require, or invent a diary, dispatch, archive, citation, named testimony, documented civilian account, or other source identity.
- Not reject otherwise sound prose solely because a page brief demanded an unavailable source identity.
- Continue to reject invented named sources, fabricated scenes, factual errors, repetition, and all other real defects.

### CIT-3: Behavior with citeable notes

When citeable notes exist, prompts may require named evidence only from the supplied `researchNotes`. They must not invent or substitute a source identity that is absent from the list.

### CIT-4: Filter generation research at the reader-facing boundary

`loadResearchNotesForGeneration` must exclude URL-less and blank-URL research rows. URL-less bootstrap or grounding summaries must not make the citation contract appear satisfiable.

Semantic research hits must be validated against the same URL-backed source set before they reach generation prompts.

### CIT-5: Apply the contract across production

The citation contract must be present in all relevant page-production stages:

- Whole-book page map and chapter briefs.
- Page-brief repair.
- Single-page, chapter, batch, whole-book, polish, and revision writers.
- Page reviewer and final-book reviewer.
- Worker review/revision/recovery loops, using the filtered research list loaded for the page.

When page-brief repair runs with empty research notes, it must explicitly discard source-identity requirements from the stored bad brief.

### COMPILE-1: Classify legacy source-only failures

Core must provide a tested predicate over stored `Page.qualityReport` text. No new quality-report issue-code enum is required in this change because existing stored reports have only text.

The predicate may return true only when:

- No citeable research notes exist.
- The report contains at least one issue.
- Every issue is an explicit source-identity complaint.
- No issue contains a repairable defect.

The classifier must recognize legacy wording from the affected run, including phrases shaped like “despite the page brief explicitly requiring,” “no specific dispatch date,” and “documented civilian” without broadly matching unrelated QA failures.

### COMPILE-2: Skip only the FAILED_QA union entry

When compile builds the `extraPageIndexes` contributed by pages already in `FAILED_QA`, it must omit pages classified by COMPILE-1.

It must not shrink or reinterpret page indexes extracted from the final-book QA verdict or deterministic manuscript checks. If either of those identifies a real manuscript problem, the page remains repairable.

### COMPILE-3: Preserve repair and publication semantics

A page with mixed source-identity and repairable issues must remain in the repair set. Invented-scene and factual-error pages must remain in the repair set.

Skipping a legacy source-only repair must not change the stored page from `FAILED_QA` to `COMPLETED`; compile simply avoids spending revision calls on an unsatisfiable warning and exports the best stored draft under the existing publication policy.

## Non-goals

- Do not change the page-review approval threshold of 75.
- Do not change final-book QA score thresholds.
- Do not change the Generation quality-gate settings or UI.
- Do not introduce structured issue codes for legacy `PageQualityReport` records in this pass.
- Do not mutate previously stored page briefs or the already-running compile by hand.

## Acceptance Criteria

1. An Ogoja-style sourcing hedge passes local QA.
2. Rhetorical setup/thesis contrast and repeated “not just X” fixtures still fail local QA.
3. Brief, writer, and reviewer prompt sets have identical citation-rule and `researchNotes` payload gate sets for both empty and citeable research.
4. A URL-less research row is absent from generation notes; a URL-backed row remains.
5. Empty research plus a brief demanding a diary can be approved when the page is otherwise sound.
6. An invented named journal is still rejected.
7. Empty-research brief repair discards source-identity requirements; citeable-research repair may preserve them.
8. A source-only legacy `FAILED_QA` page causes no compile revision call.
9. Adding citeable research makes the same legacy page eligible for repair.
10. A mixed source/repetition report and an invented-scene report remain eligible for compile repair.

## Verification Commands

```bash
pnpm --filter @book-maker/core test
pnpm --filter @book-maker/worker test
pnpm --filter @book-maker/core typecheck
pnpm --filter @book-maker/worker typecheck
pnpm lint
```

The repository-wide size check has pre-existing failures in oversized files. This change must not introduce a new oversized production file.
