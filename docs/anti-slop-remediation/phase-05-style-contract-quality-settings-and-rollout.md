# Phase 05 - Style Contract, Quality Settings, And Rollout

## Objective

Correct prompt-level style guidance that encourages repeated rhetorical structure, separate mandatory integrity from tiered polish, calibrate detector thresholds, and roll enforcement out with measurable precision and cost controls.

## Prerequisites

- Strict page-map acceptance and clean-map enforcement are implemented.
- Deterministic structural findings have shadow metrics.
- Targeted prose review is bounded, logged, and connected to publication policy.
- At least one stable detector version is present in diagnostics.

## Starting Seams

- `packages/core/src/generation/planner.ts`
- `packages/core/src/generation/pagesShared.ts`
- `packages/core/src/generation/styleAuditor.ts`
- `packages/core/src/generation/smartUnslop.ts`
- `packages/core/src/generation/qualityGates.ts`
- `apps/worker/src/generation/qualitySettings.ts`
- `apps/api/src/routes/adminGenerationQuality.ts`
- `apps/web/src/features/admin/GenerationQualityScreen.tsx`
- Relevant planner, quality settings, API, and web tests

Preserve concurrent or previously landed page-review telemetry and compact-prompt behavior. Integrate rather than replacing it.

## Structured Style Scope

The current plan arrays mix rules intended for one page with rules intended for the whole manuscript. Introduce an optional backward-compatible structure:

```ts
type StyleContract = {
  localRules: StyleRule[];
  distributionRules: StyleRule[];
}

type StyleRule = {
  id: string;
  instruction: string;
}
```

### Local rules

Examples:

- Avoid unsupported proof-leap transitions.
- Do not invent evidence or citations.
- Avoid generic conclusions and visible prompt scaffolding.
- Use uncertainty only where the evidence requires it.

### Distribution rules

Examples:

- Do not use the same caveat construction as the default ending across chapters.
- Choose only the analytical lens relevant to a page rather than repeating the complete comparison grid.
- Let some pages commit to a bounded conclusion instead of balancing every cause symmetrically.
- Reintroduce a concept only when the later treatment advances, challenges, or applies it.

Page drafting and page review receive local rules. Manuscript structural auditing and final structural review receive distribution rules.

## Plan Contract Normalization

Replace count-based fallback behavior with stable rule identities:

- Required baseline rules are merged by `id`.
- A planner returning six arbitrary anti-AI rules no longer suppresses mandatory rules merely because it exceeded a minimum count.
- User intent remains authoritative where it directly conflicts with an optional house preference.
- Required factuality and prompt-leak protections cannot be removed by planner wording.

Add plan-critic detection for instructions that prescribe repetitive manuscript behavior, including variants of:

- Ask the same questions throughout.
- Always distinguish the same categories.
- Reiterate interacting possibilities on every case.
- Use the same framework for every era or region.

Rewrite such guidance into selective, chapter-scoped instructions.

## Domain And Category Handling

Historical or analytical books may currently use the `CUSTOM` category and miss category-specific rules. Avoid tying all writing behavior to the coarse product category.

Choose one bounded approach:

- Add an optional inferred `writingMode` to the plan, or
- Derive a private writing mode from plan fields for style-contract construction.

The initial modes should remain small and evidence-driven, such as:

- narrative
- analytical history
- instructional
- reference
- children's narrative

Do not create a broad genre taxonomy in this phase.

## Integrity Versus Tiered Polish

Document and enforce two groups.

### Mandatory at every tier

- Generated-response schema validation
- Page-map coverage and ordering
- Generic assignment rejection
- Full-map collision detection and resolution
- Deterministic page integrity checks
- Deterministic manuscript structural audit
- Publication-state grading

### Operator-configurable polish

- General model page review
- Style comparison against excerpts
- Best-of drafting and polishing
- Writer tools
- Broad plan criticism not triggered by an invariant
- Optional nonblocking prose refinement

If the admin console continues to show a former integrity feature such as beat dedup, relabel it to describe only its optional model-polish portion or remove the misleading toggle.

## Quality Revision Migration

The latest stored `GenerationQualityRevision` overrides compiled defaults. Production rollout therefore requires an appended revision.

The rollout revision should:

- Preserve all unrelated current operator choices.
- Enable the intended page-review and style features for balanced only after cost validation.
- Carry prompt-mode settings without dropping unknown future fields.
- Never encode mandatory integrity as a disableable tier list.
- Include an operator note naming the anti-slop rollout and detector version.

Use the existing append-only admin route. Do not edit a historical revision in place.

## Calibration Corpus

Use three groups:

1. Known failures:
   - malformed production-map fixtures
   - same-chapter paraphrase clusters
   - manuscript-wide balanced-caveat saturation
2. Clean controls:
   - analytical books with recurring subjects but distinct evidence
   - fiction with intentional motifs or refrains
   - instructional books with legitimate repeated terminology
3. Boundary cases:
   - imported manuscripts
   - short books
   - non-English books
   - books with deliberate parallel chapter structure

Full manuscripts may be evaluated through a local replay tool. CI should retain distilled stable fixtures.

## Rollout Stages

### Stage 1 - Shadow

- Run strict and structural checks for all tiers.
- Record `would_retry`, `would_regenerate`, and `would_block`.
- Preserve existing user-visible status where enforcement is not yet enabled.

Minimum observation window:

- At least 50 manually classifiable books, or
- Seven days of normal generation volume, whichever produces the larger useful sample

### Stage 2 - Upstream enforcement

- Enforce strict page-map acceptance and clean-map preparation.
- Start with ultra and premium for operational observation, then balanced and fast.
- The behavior must converge to every tier; the tier sequence is deployment control, not permanent product policy.

### Stage 3 - Manuscript status enforcement

- Enable prevalence-based blockers and corroborated structural clusters.
- Continue publishing inspectable artifacts.
- Monitor review-required rate and manual overturn rate.

### Stage 4 - Remove temporary rollout control

- Default mandatory checks on.
- Remove or retire temporary bypasses.
- Preserve detector versioning for future calibration.

## Metrics

Track:

- Invalid chapter-brief response rate by provider/model/tier
- Schema repair success rate
- Dense chapter regeneration rate
- Production-map findings and unresolved failures
- Structural finding rate by code and detector version
- Candidate-to-confirmed model review rate
- Review-required rate and manual overturn rate
- Added model calls and tokens per generated book
- Clean-path no-call rate
- Deterministic audit latency
- Generation completion and retry rates

## Release Gates

- All known malformed responses fail before drafting.
- All known editorial duplicate clusters are detected.
- Aggression-style hedge saturation produces a blocking candidate.
- Hard-block false-positive rate is below 2% in the manually reviewed clean control set.
- Targeted reviewer precision is high enough that fewer than 10% of its high-confidence blockers are manually overturned.
- Clean books incur no structural-review model call.
- Typical risk books require no more than two added structural-review calls.
- Deterministic audit p95 is below 500 ms for a 120-page book.
- No statistically meaningful regression appears in generation completion after accounting for deliberately rejected invalid maps.

Thresholds are provisional until measured. Record any approved threshold changes in Phase 05 output notes with before/after corpus results.

## Existing Books

- Run a read-only offline audit if operationally useful.
- Do not automatically edit prose or change user-visible status.
- Surface affected books to operators with findings and artifact links.
- Any user-facing remediation offer requires a separate product decision about credits, regeneration, and consent.

## Required Tests

- Local rules reach page prompts; distribution rules do not bloat every page prompt.
- Distribution rules reach manuscript review.
- Required style rules merge by ID regardless of planner rule count.
- Repetitive global guidance is rewritten or flagged.
- Legacy plans without `styleContract` still work.
- Unknown quality-revision fields survive admin saves.
- The appended revision preserves unrelated settings.
- Mandatory integrity runs even when every optional quality feature is disabled.
- Shadow and enforcement controls produce the documented behavior.
- Metrics attribute every additional provider call.

## Acceptance Criteria

- Prompt guidance no longer instructs every page to perform the same analytical balancing act.
- Integrity behavior cannot be disabled by model tier.
- The production quality revision reflects the approved rollout settings.
- Thresholds have recorded corpus evidence.
- Precision, cost, latency, and completion gates are met.
- Temporary rollout controls have an explicit removal plan.

## Handoff To Phase 06

Phase 06 may begin only when blocking findings have acceptable precision and operators can reliably identify a canonical treatment within a duplicate cluster.
