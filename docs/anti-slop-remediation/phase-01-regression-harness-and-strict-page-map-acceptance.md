# Phase 01 - Regression Harness And Strict Page-Map Acceptance

## Objective

Prevent malformed chapter-brief responses from being normalized into generic production assignments, and establish the regression fixtures used by every later phase.

This phase ends at the generated-response seam. It does not yet perform whole-map semantic deduplication; it guarantees that every chapter brief entering later orchestration is structurally real.

## Why This Phase Comes First

The observed production failure began when the chapter-brief model returned arrays containing numbers or strings instead of page objects. `generateChapterBrief` currently validates the provider response with `z.unknown()`, after which normalization can invent purpose, beat, and ending-pressure fields.

Once those invented assignments reach the drafter, page QA sees individually fluent pages and cannot reconstruct the distinct production plan that never existed.

## Starting Seams

- `packages/core/src/generation/pagesPageMap.ts`
- `packages/core/src/schemas/book.ts`
- `packages/core/src/generation/generateJsonWithRetry.ts`
- `packages/core/src/generation/pagesPageMap.test.ts`
- `packages/core/src/generation/pages.test.ts`

Before editing, read `packages/core/CLAUDE.md` and `packages/core/src/generation/CLAUDE.md`.

## Interface Design

Add a generation-specific strict acceptance module, recommended as:

```ts
decodeGeneratedChapterBrief(
  raw: unknown,
  contract: GeneratedChapterBriefContract
): ChapterBrief
```

The contract should contain only what acceptance requires:

- Expected chapter index
- Expected global page range
- Whether a complete local numbering sequence may be remapped to the global range
- Optional generation mode information needed by a genuine invariant

Do not expose individual normalization helpers. The interface should either return a complete accepted `ChapterBrief` or throw one typed validation error containing structured violations.

## Strict Acceptance Rules

Every returned page must:

- Be a JSON object, not a number or string.
- Contain an integer page index.
- Contain substantive string values for `purpose`, `beat`, and `endingPressure`.
- Use the expected chapter index after permitted normalization.
- Belong to the expected page range.
- Appear exactly once.

The completed chapter brief must:

- Cover every expected page.
- Contain no extra pages.
- Be ordered after normalization.
- Reject mixed local and global numbering.
- Reject duplicate local indexes even if they could be positionally remapped.

Reject assignments matching generic or metadata-only forms, including normalized variants of:

- `Advance the chapter on page N`
- `Advance the chapter with a concrete, non-repetitive beat on page N`
- `pageIndex global N`
- `page N`
- Text containing only the page number, chapter number, or schema field names

Specificity checks must be category-neutral at this seam. Do not require a date or named historical person from fiction, memoir, instructional, or children's books.

## Compatibility Policy

- Keep the existing permissive domain schemas available for legacy persisted data unless evidence proves they can be tightened safely.
- Apply strictness to newly generated provider responses.
- Continue accepting alternate object field names only when the value remains a substantive object assignment.
- Preserve the existing complete local-numbering behavior for later chapters.
- Do not silently accept string beats for compatibility; the model prompt already requires page objects.

## Implementation Tasks

1. Add distilled regression fixtures for:
   - numeric page arrays
   - descriptive string page arrays
   - `pageIndex global N` strings
   - objects missing purpose, beat, or ending pressure
   - blank or metadata-only fields
   - duplicate, missing, extra, and out-of-order page indexes
   - valid global object pages
   - valid complete local-numbered object pages
   - valid alternate object field names, if retained
2. Add the strict response schema or decoder.
3. Replace `schema: z.unknown()` in `generateChapterBrief` with a schema that causes `generateJsonWithRetry` to invoke its schema-repair path.
4. Set the chapter-brief call to use at most two repair attempts.
5. Run contract validation again after any local-to-global remapping.
6. Remove generation-time invention of generic purpose, beat, and ending pressure for malformed entries.
7. Add a typed `PAGE_MAP_RESPONSE_INVALID` error with:
   - chapter index
   - expected range
   - violation codes
   - affected or missing indexes
8. Ensure provider logs still record the detailed call while job-facing errors remain concise.

## Required Tests

### Unit tests

- Each malformed fixture fails with the correct violation code.
- A provider schema failure triggers the repair attempt.
- A repaired valid response succeeds.
- Exhausted invalid responses throw and never return a fallback assignment.
- A valid local-numbered chapter maps to the exact global range.
- Mixed local/global numbering fails.
- Meaningful alternate field aliases remain accepted if compatibility is retained.

### Regression controls

- A valid one-page book still receives the closing-page contract.
- Opening-page citation and source sanitization remains intact.
- Imported-manuscript opening exemptions remain intact.
- The strict schema does not change whole-book deterministic fallback behavior outside the chapter-brief path.

## Observability

Record or expose enough structured information to derive:

- Invalid chapter-brief response count by model and tier
- Violation-code frequency
- Repair-attempt success rate
- Chapters that exhausted schema repair

Use existing provider call accounting. A schema repair is part of the original logical call and must remain attributed accordingly.

## Acceptance Criteria

- Numeric and string page arrays cannot produce a `ChapterBrief`.
- No strict-generation path manufactures `Advance the chapter on page N`.
- Every accepted brief covers the exact expected pages once and in order.
- Existing valid local-numbered responses still work.
- An invalid response is repaired through the existing bounded retry or fails before page drafting.
- Focused core tests and core typecheck pass.
- Distilled Mechanics-style fixtures are committed and independent of `storage/`.

## Non-Goals

- Whole-book collision repair
- Manuscript prose analysis
- Quality-state changes
- Automatic repair of existing persisted malformed briefs

## Handoff To Phase 02

Phase 02 may assume that newly generated individual chapter briefs are structurally valid. It must not assume that independently valid briefs are mutually distinct across the full production map.
