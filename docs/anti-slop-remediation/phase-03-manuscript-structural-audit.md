# Phase 03 - Manuscript Structural Audit

## Objective

Detect editorial repetition that remains invisible to page-local checks and exact lexical similarity: repeated treatment of the same subject, evidence, and conclusion; chapter recaps that do not advance; and manuscript-wide rhetorical cadence saturation.

This phase is deterministic and evidence-producing. It runs in shadow mode first and does not yet add new model calls or automatic prose rewrites.

## Prerequisites

- Phase 02 guarantees structurally valid production maps for newly generated books.
- Complete-map detection and repair no longer truncate after twelve findings.
- Existing `runDeterministicManuscriptChecks` behavior passes at baseline.

## Starting Seams

- `packages/core/src/generation/manuscriptQuality.ts`
- `packages/core/src/generation/manuscriptStructuralSlop.ts`
- `packages/core/src/generation/pageOverlap.ts`
- `packages/core/src/generation/proseShape.ts`
- `packages/core/src/generation/manuscriptQuality.test.ts`
- `packages/core/src/generation/manuscriptStructuralSlop.test.ts`
- `apps/worker/src/handlers/compileExport.ts`

Before editing, read the applicable core generation and worker handler `CLAUDE.md` files.

## External Interface

Keep the primary interface:

```ts
runDeterministicManuscriptChecks({
  pages,
  expectedPageCount
}): ManuscriptQualityIssue[]
```

Deepen its implementation. Do not expose tokenizers, signature builders, thresholds, or pair scorers merely for tests.

Extend `ManuscriptQualityIssue` with optional, backward-compatible evidence:

```ts
metrics?: {
  occurrences?: number;
  affectedPageRatio?: number;
  clusterCount?: number;
}
evidence?: Array<{
  pageIndex: number;
  excerpt: string;
}>
```

If quality-report JSON is validated elsewhere, update the schema and OpenAPI representations without requiring a Prisma migration for optional JSON fields.

## Detector Families

### 1. Same-chapter treatment repetition

Compare pages within the same chapter, including nonadjacent pages. Separate signatures for:

- Named people, places, institutions, events, technologies, and dates
- Evidence, examples, and material objects
- Causal verbs and explanatory relationships
- Conclusions, consequences, and distinctions

Flag duplicate treatment when pages share a strong subject anchor and materially repeat evidence, explanation, or conclusion. Do not flag a recurring subject merely because a chapter remains about that subject.

Candidate pair ranking should prefer:

- Adjacent or near-adjacent pages
- Repeated proper nouns and dates
- Repeated uncommon terms
- Similar causal and conclusion signatures

### 2. Recap and backtracking

Detect when a later page:

- Reintroduces an already established concept as new
- Repeats a definition or historical setup
- Repeats the same evidentiary example
- Returns to the same conclusion without advancing, challenging, applying, or qualifying it

Report clusters rather than one issue per pair to avoid quadratic quality-report noise.

### 3. Sentence-opening cadence

Tokenize sentence openings across every page, not only the opening sentence of each page. Measure exact stems and related construction families.

Initial English risk families should include:

- `Rather than ...`
- `The distinction ...`
- `This/That does not by itself ...`
- `The same ... could also ...`
- `Not merely/just/simply ... but ...`
- Balanced `neither ... nor ...` caveat conclusions
- Repeated abstract pivots such as `fundamentally`

These are distribution signals, not banned phrases. One precise use must remain clean.

### 4. Analytical-grid and caveat topology

Retain current grid and symmetrical-hedging checks, but measure:

- Pages affected
- Chapters spanned
- Occurrences
- Share of manuscript pages
- Whether the construction repeatedly appears in the same paragraph role

### 5. Cross-chapter repetition

Retain current cross-chapter concept comparison. Align its issue evidence and cluster output with same-chapter findings so downstream review can consume one shape.

## Severity Model

Support two independent escalation paths:

1. Corroboration: several structural families recur.
2. Saturation: one family alone recurs at damaging prevalence.

Provisional shadow thresholds:

- Three or more pages in one duplicate-treatment cluster: blocking candidate.
- One structural family affecting at least 20% of manuscript pages: blocking candidate.
- One sentence-opening family appearing at least twelve times and four times above the clean-corpus baseline: warning candidate.
- At least twenty-five occurrences spanning five chapters: blocking candidate.

During this phase, emit the measured severity and `would_block` decision in diagnostics while preserving current publication behavior. Phase 05 will approve final enforcement thresholds.

## Language Policy

- Make tokenization Unicode-aware.
- Run English phrase-family detectors only when the manuscript language is English or the prose is reliably classified as English.
- Keep structural subject/evidence clustering language-neutral where practical.
- Do not translate prose for deterministic analysis.
- Add non-English controls to prevent English-pattern false positives.

## Performance Design

- Strip and tokenize each page once.
- Cache sentence, entity-like, keyword, and causal signatures per page.
- Compare within chapter before considering whole-book pairs.
- Avoid constructing duplicate sets inside pair loops.
- Cluster findings after scoring rather than emitting every matching pair.

Target deterministic audit p95: below 500 ms for 120 normal-length pages on the worker runtime used in production.

## Implementation Tasks

1. Add distilled repetition fixtures based on the known Indus, Banda, and balanced-caveat failures.
2. Add clean controls sharing a subject but using different evidence and conclusions.
3. Add cached manuscript page signatures.
4. Add same-chapter pair scoring and cluster formation.
5. Add recap/backtracking signals.
6. Add sentence-opening and rhetorical-family distribution metrics.
7. Add optional metrics and evidence to issues.
8. Replace the three-family-only blocking calculation with a policy that can also evaluate prevalence.
9. Add shadow diagnostics without changing the project status yet.
10. Add a local full-manuscript replay helper that reads supplied pages but is not coupled to mutable storage paths.

## Required Tests

- Four paraphrased pages repeating the same historical evidence form one cluster.
- A repeated subject with distinct evidence and conclusions remains clean.
- An isolated balanced caveat remains clean.
- Manuscript-wide symmetrical hedging records correct occurrence and page ratios.
- Sentence-opening counts include openings inside pages.
- Sentence fragments, headings, lists, quotations, and abbreviations do not inflate counts incorrectly.
- Same-chapter findings include actionable page indexes and short excerpts.
- Cross-chapter behavior remains intact.
- A single saturated family can produce `would_block` without unrelated families.
- Non-English controls do not trigger English phrase rules.
- The 120-page performance fixture remains within the agreed budget in a non-flaky benchmark or measured replay.

## Acceptance Criteria

- Known same-chapter paraphrase clusters are detected.
- Known clean controls are protected.
- The Aggression-style 40/120 hedge distribution becomes a blocking candidate.
- Findings contain page indexes, counts, ratios, and concise evidence.
- No new provider call is introduced.
- Shadow-mode output can be aggregated by finding code and detector version.
- Core tests, typecheck, and full repository checks pass.

## Non-Goals

- Model adjudication
- Automatic structural rewriting
- Production status enforcement
- Retrospective mutation of completed books

## Handoff To Phase 04

Phase 04 consumes deterministic clusters as candidate selectors. It must not ask a model to rediscover risk by reading an undifferentiated full manuscript payload.
