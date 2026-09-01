# Phase 05 Output Notes

## Status

Partial

Code for the style contract, integrity/polish split, distilled-fixture calibration, metrics attribution, and rollout documentation landed. Live release gates were **not** measured and are **not** met. Phase 06 automatic consolidation must not start on the basis of this session.

## Implemented

- Optional backward-compatible `writingMode` and `styleContract` (`localRules` / `distributionRules`) on the plan. Page drafts, page review, context-pack Avoid lines, and the style auditor receive **local** rules. Targeted manuscript structural review receives **distribution** rules.
- Required local ids merge by identity. A planner that already returned six arbitrary anti-AI lines no longer suppresses `no-invented-evidence` or `prompt-leak-ban`. User parallel-structure intent stays distribution-scoped; required protections cannot be removed by planner wording.
- Bounded writing modes: `narrative`, `analytical-history`, `instructional`, `reference`, `children-narrative`. CUSTOM prompts with historical/analytical cues infer `analytical-history`.
- Deterministic rewrite of repetitive global guidance (“ask the same questions throughout”, same framework for every era). Plan critic may emit `styleGuidanceRewrites` on the existing `critique-plan` purpose — no new provider call.
- `MANDATORY_INTEGRITY_CHECKS` documented in `qualityGates.ts`. None of `QUALITY_FEATURE_IDS` can disable integrity. Admin console lists integrity separately; `beatDedup` is relabeled as optional polish only.
- Quality-revision helper is **note-only**. This environment has no operator-owned production table to append in tests. Operators should `PATCH /api/admin/generation-quality` with `ANTI_SLOP_QUALITY_REVISION_NOTE` (names anti-slop rollout and `manuscript-structural-audit-v1`). Unknown fields and unrelated settings already survive that route. No historical revision is edited in place. Mandatory integrity is not encoded as a disableable tier list.
- Distilled calibration replay (`replayAntiSlopCalibration`) covers Phase 01–04 fixtures plus new clean/boundary pages. Full manuscripts remain local-only, not CI, not `storage/`.
- Rollout: Stage 1 shadow already exists. Stage 2 page-map default ON; `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` retained. Stage 3: Phase 04 still blocks high-confidence corroborated clusters; **Phase 03 prevalence stays `wouldBlock`** (not promoted to publication blocks). Stage 4: removal plan documented; the env flag is **not** deleted this phase.
- Metrics: `generate-chapter-brief`, `dedupe-page-beats`, and `review-manuscript-structure` always appear as integrity cost rows, including clean-path zero-call rows, even when every polish checkbox is off.

## Files Changed

### Core

- `packages/core/src/schemas/styleContract.ts` (new)
- `packages/core/src/schemas/plan.ts`
- `packages/core/src/schemas/plan.test.ts`
- `packages/core/src/generation/styleContract.ts` (new)
- `packages/core/src/generation/styleContract.test.ts` (new)
- `packages/core/src/generation/styleContract.prompt.test.ts` (new)
- `packages/core/src/generation/planner.ts`
- `packages/core/src/generation/planner.test.ts`
- `packages/core/src/generation/planCritic.ts`
- `packages/core/src/generation/planCritic.test.ts`
- `packages/core/src/generation/qualityGates.ts`
- `packages/core/src/generation/qualityGates.test.ts`
- `packages/core/src/generation/pages.ts`
- `packages/core/src/generation/pagesPageMap.ts`
- `packages/core/src/generation/pagesReview.ts`
- `packages/core/src/context/contextPack.ts`
- `packages/core/src/prompting/templates.ts`
- `packages/core/src/generation/antiSlopCalibration.ts` (new)
- `packages/core/src/generation/antiSlopCalibration.test.ts` (new)
- `packages/core/src/generation/antiSlopQualityRevision.ts` (new)
- `packages/core/src/generation/antiSlopQualityRevision.test.ts` (new)
- `packages/core/src/generation/testing/antiSlopCalibrationFixtures.ts` (new)
- `packages/core/src/index.ts`
- `packages/core/src/generation/CLAUDE.md`

### Worker

- `apps/worker/src/generation/qualityEnrichment.ts`
- `apps/worker/src/handlers/planning.ts`
- `apps/worker/src/handlers/compileExportStructuralReview.ts`
- `apps/worker/src/handlers/compileExportStructuralReview.test.ts`
- `apps/worker/src/handlers/compileExportPolicy.test.ts`

### API

- `apps/api/src/admin/qualityGateCosts.ts`
- `apps/api/src/admin/qualityGateCosts.test.ts`

### Web

- `apps/web/src/features/admin/GenerationQualityScreen.tsx`
- `apps/web/src/features/admin/GenerationQualityIntegrityPanel.tsx` (new)
- `apps/web/src/features/admin/GenerationQualityIntegrityPanel.test.ts` (new)
- `apps/web/src/styles.css`

### Docs

- `CLAUDE.md`
- `docs/anti-slop-remediation/phase-05-output-notes.md` (this file)

## Tests Run

- Review follow-up (`mergePlanCriticPatch` user prompt): `pnpm -F @book-maker/core exec vitest run src/generation/planCritic.test.ts src/generation/styleContract.test.ts src/generation/planner.test.ts` — 3 files, 40 passed. `pnpm -F @book-maker/core typecheck` and `pnpm -F @book-maker/worker typecheck` passed.
- `pnpm -F @book-maker/core exec vitest run src/generation/styleContract.test.ts src/generation/styleContract.prompt.test.ts src/generation/antiSlopCalibration.test.ts src/generation/antiSlopQualityRevision.test.ts src/generation/qualityGates.test.ts src/generation/planner.test.ts src/generation/planCritic.test.ts src/schemas/plan.test.ts` — 8 files, 66 passed.
- `pnpm -F @book-maker/core exec vitest run src/testing/dryRun.test.ts src/context/contextPack.test.ts src/schemas/book.test.ts` — 3 files, 43 passed.
- `pnpm -F @book-maker/core exec vitest run src/adapters/fake.test.ts src/generation/styleAuditor.test.ts` — 2 files, 20 passed.
- `pnpm -F @book-maker/worker exec vitest run src/generation/bookStateIntegrity.test.ts src/handlers/compileExportPolicy.test.ts src/handlers/compileExportStructuralReview.test.ts` — 3 files, 32 passed (policy re-run 13 passed after a type-only tier fix).
- `pnpm -F @book-maker/api exec vitest run src/admin/qualityGateCosts.test.ts src/routes/adminGenerationQuality.test.ts` — 2 files, 36 passed.
- `pnpm -F @book-maker/web exec vitest run src/features/admin/GenerationQualityScreen.test.ts src/features/admin/GenerationQualityIntegrityPanel.test.ts` — 2 files, 51 passed.
- `pnpm -F @book-maker/core typecheck` — passed.
- `pnpm -F @book-maker/worker typecheck` — passed.
- `pnpm -F @book-maker/web typecheck` — passed.
- `pnpm -F @book-maker/api typecheck` — failed on pre-existing `bookEditOperationRetries.ts` / `.test.ts`, and also `projectStatus.ts` diagnostics `severity` (`string` vs `"error" | "warning"`). Neither file was edited this phase.

Full `pnpm check` was not re-run. Known unrelated file-size budget failures remain: `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, `restructurePages.test.ts`. New Phase 05 files are under 900 (`GenerationQualityScreen.tsx` is 873 after extracting the integrity panel).

## Metrics Or Replay Results

Distilled fixtures only. **No production corpus.** Live gates implemented as named constants and report fields, all `measured: false`:

| Gate | Required | This session |
| --- | --- | --- |
| Classified books | 50 | unmeasured |
| Observation window | 7 days | unmeasured |
| Hard-block FP on live clean-control | <2% | unmeasured |
| High-confidence overturn rate | <10% | unmeasured |
| Completion regression | none statistically meaningful | unmeasured |

Thresholds: **unchanged, provisional** (Phase 03 prevalence constants and Phase 04 pack/call/prose bounds). No fixture evidence supported promoting prevalence-based deterministic blockers to publication blocks.

Detector version: `manuscript-structural-audit-v1`. Production-map detector: `production-map-audit-v1`. Purpose names: `generate-chapter-brief`, `dedupe-page-beats`, `review-manuscript-structure`. Phase 04 bounds inherited: 3 packs/call, 2 calls/book, 4 pages/pack, 4000 chars, 1800 tokens, temperature 0.

## Deviations From Plan

- Did **not** append a live `GenerationQualityRevision` row. Tests have no production DB; the table is operator-owned. Implemented compiled defaults + revision-shape helper + documented note-only PATCH instead.
- Did **not** enable extra polish for balanced after cost validation: there is no live cost sample here, and compiled defaults already run `pageModelReview` on all tiers.
- Did **not** delete `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY`. Spec says remove after the observation window.
- Did **not** turn Phase 03 prevalence into hard publication blocks.
- Did **not** implement Phase 06 automatic consolidation.
- Did **not** auto-edit existing user books or change their status.
- Review follow-up: `ensurePlanStyleContract` no longer treats `antiAiRules` ≠ `localRules` as a stale contract (that path dropped planner `distributionRules`). Classified `antiAiRules` merge into the stored contract by id; required local ids still merge.
- Review follow-up: `mergeStyleRulesById` caps optional extras so required ids always fit. Local contract cap is 24 (`MAX_LOCAL_STYLE_RULES`), matching plan `antiAiRules`. Twelve custom local ids plus the five required ids parse and round-trip; an over-long list is truncated rather than failing `styleContractSchema` and stripping planner `distributionRules`.
- Review follow-up: `parseStyleContract` drops invalid rule entries (bad id, non-object, empty instruction) instead of failing the whole object. Planner `distributionRules` survive a bad local rule. Instruction length uses the same code-point truncation as `antiAiRules`, so a 500-emoji line round-trips instead of taking the contract with it.
- Review follow-up: `mergePlanCriticPatch` re-applies the style contract with the user prompt (threaded from `plan-book`), so `USER_PARALLEL_INTENT` still protects a stored parallel-structure distribution line when the critic rewrites an unrelated rule. Plan critic stays on; no extra model call.

## Known Risks

- Live precision, cost, latency, and completion gates remain unknown.
- `generate-chapter-brief` still names initial briefs, dense regeneration, and map repairs together; they share one purpose.
- `beatDedup` remains a visible polish row that does not gate integrity (integrity rewrite already runs when the box is off).

## Handoff To Next Phase

**Phase 06 automatic consolidation entry gate is NOT met.** Blocking findings do not have acceptable live precision, and operators cannot yet identify a canonical treatment from a production duplicate cluster.

Inherited:

- Detector `manuscript-structural-audit-v1`
- Page-map env `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY` (default enforce, `shadow` retained)
- Prevalence `wouldBlock` only until live calibration
- Structural-review purpose `review-manuscript-structure` with Phase 04 bounds
- Style contract `style-contract-v1`; local vs distribution routing

### Removal plan for `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY`

Remove the env override after **≥50 classified books or 7 days of normal volume, whichever is larger**, **and** hard-block false-positive rate **<2%** on a live clean-control set. None of those conditions are measured here. Until then, keep default enforce and the `shadow` switch.
