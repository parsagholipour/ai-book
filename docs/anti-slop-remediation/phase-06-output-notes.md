# Phase 06 Output Notes

## Status

Partial (hardening only; consolidation skipped)

Automatic consolidation did **not** start. Phase 05 recorded live precision gates as unmeasured, so the Phase 06 entry gate failed. Structural findings stay review-only (Phase 04 `REVIEW_REQUIRED` for high-confidence corroborated duplication). Hardening tasks in this phase completed.

## Implemented

- `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY` is still present (default enforce, `shadow` retained). Phase 05 removal plan still requires live observation that has not happened. Named again in the calibration report, worker comments, and generation `CLAUDE.md`.
- Detector versions remain on reports: `manuscript-structural-audit-v1`, `production-map-audit-v1`, `style-contract-v1`.
- Periodic offline evaluation: `pnpm anti-slop:replay` runs `replayAntiSlopCalibration` against distilled fixtures only. It does not read `storage/` or live books. Full manuscripts stay a local caller of `replayDeterministicManuscriptChecks`.
- Operator quality serialization now carries structured `cluster.canonicalPageIndex` / `cluster.duplicatePageIndexes` on corroborated issues. Legacy reports that only named the canonical page in `evidence[0]` recover the same split. `GET /api/projects/:id/status` (and SSE) already expose `quality.issues` with affected pages, evidence, and message. The operator console still shows blocked-page counts, not the issue list; that JSON is the operator quality report. No new reader-facing quality card.
- Duplicate detector inventory: nothing retired. `pageOverlap.ts`, `pagesLocalQa`, `pageBeatDedupDetect`, and Smart Unslop remain in use after the deep manuscript interface.
- Phrase-family tables were not expanded. No fixture evidence said a family was wrong.
- Complete program handoff recorded below. **Automatic consolidation was skipped because the entry gate failed.**

## Files Changed

### Core

- `packages/core/src/generation/manuscriptQualityIssue.ts`
- `packages/core/src/generation/manuscriptQualityIssue.test.ts` (new)
- `packages/core/src/generation/manuscriptQuality.ts`
- `packages/core/src/generation/manuscriptStructuralReview.ts`
- `packages/core/src/generation/manuscriptStructuralReview.test.ts`
- `packages/core/src/generation/manuscriptReviewPacks.ts`
- `packages/core/src/generation/manuscriptReviewPacks.test.ts`
- `packages/core/src/generation/antiSlopCalibration.ts`
- `packages/core/src/generation/antiSlopCalibration.test.ts`
- `packages/core/src/generation/CLAUDE.md`

### Worker

- `apps/worker/src/handlers/compileExportStructuralReview.ts`
- `apps/worker/src/handlers/compileExportStoredQuality.ts`
- `apps/worker/src/handlers/compileExportStoredQuality.test.ts` (new)
- `apps/worker/src/generation/productionMapIntegrity.ts`

### API

- `apps/api/src/projectStatus.ts`
- `apps/api/src/projectStatusProvenance.test.ts`

### Scripts / docs

- `scripts/replay-anti-slop-calibration.ts` (new)
- `scripts/CLAUDE.md`
- `package.json` (`anti-slop:replay`)
- `docs/anti-slop-remediation/phase-06-output-notes.md` (this file)

## Tests Run

- `pnpm -F @book-maker/core exec vitest run src/generation/antiSlopCalibration.test.ts src/generation/manuscriptQualityIssue.test.ts src/generation/manuscriptStructuralReview.test.ts src/generation/manuscriptReviewPacks.test.ts src/generation/manuscriptQuality.test.ts` — 5 files, 53 passed.
- `pnpm -F @book-maker/worker exec vitest run src/handlers/compileExportStoredQuality.test.ts src/handlers/compileExportPolicy.test.ts src/handlers/compileExportStructuralReview.test.ts` — 3 files, 22 passed.
- `pnpm -F @book-maker/api exec vitest run src/projectStatusProvenance.test.ts src/mobile/qualityVerdict.test.ts` — 2 files, 10 passed.
- `pnpm anti-slop:replay` — 27 fixtures, 27 passed, `ok: true`. No `storage/` in the payload.
- `pnpm -F @book-maker/core typecheck` — passed.
- `pnpm -F @book-maker/worker typecheck` — passed.

Full `pnpm check` was not re-run. Known unrelated failures remain: API typecheck in `bookEditOperationRetries.ts` / `.test.ts`, and file-size budget on `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, `restructurePages.test.ts`.

## Metrics Or Replay Results

Distilled fixtures only. No production corpus. Live gates remain `measured: false`. Calibration CLI prints detector versions, the retained production-map env, Phase 04 call bounds, automatic-repair exclusions as remaining policy (not implemented behavior), and corpus owner/cadence.

Replay summary: 27/27 fixtures passed (malformed maps, colliding briefs, Indus paraphrase, hedge saturation, clean distinct-evidence / fiction-motif / instructional-terminology, boundary imported-short / non-English / deliberate-parallel).

## Deviations From Plan

- Did **not** implement automatic cluster consolidation, replacement `PageProductionBeat` generation, durable brief+page repair of duplicate clusters, or any path that rewrites published prose because it was a duplicate cluster.
- Did **not** remove `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY`.
- Did **not** change COMPLETE vs `REVIEW_REQUIRED` policy.
- Did **not** append a live `GenerationQualityRevision` row (still note-only PATCH from Phase 05).
- Did **not** add a new operator UI panel or a reader quality feature. Cluster pages already exist on issues; this phase made canonical vs duplicate structured on the operator quality report JSON.
- Did **not** delete pageOverlap / local QA / Smart Unslop / beat-dedup detection.
- Did **not** add phrase-family entries.

## Known Risks

- Live precision, cost, latency, and completion gates remain unknown. Automatic consolidation must stay off until they are measured.
- Provider failure on structural review still publishes `COMPLETE` when only advisory deterministic warnings remain.
- Pack budget can leave clusters unadjudicated (`STRUCTURAL_REVIEW_BUDGET_EXCEEDED`).
- Same-subject chapters with shared technical vocabulary can still cluster; high-confidence corroboration still blocks `COMPLETE`.

## Handoff To Next Phase

There is no Phase 07 in the program folder. Future work inherits this handoff.

### Automatic consolidation was skipped because the entry gate failed

Phase 05: live precision gates unmeasured. High-confidence overturn rate, hard-block FP on a live clean-control set, classified-book count, and observation window are all unmet. Do not start automatic redrafting until those gates are measured and accepted, including credit, consent, and user-visible repair policy for existing books.

### Final enforced vs shadow thresholds

Enforced (publication):

- Production-map integrity: default ON. `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` logs `would_block` and drafts anyway.
- Strict chapter-brief acceptance (`decodeGeneratedChapterBrief`) on the chapter-brief path.
- High-confidence corroborated duplication (`CORROBORATED_STRUCTURAL_DUPLICATION`, model `error`) → report `blocked` → project `REVIEW_REQUIRED`.
- Deterministic integrity errors (`MISSING_PAGES`, `PAGE_COUNT_MISMATCH`, `STRUCTURAL_SLOP_SATURATION` from the original six families, and other explicit errors).

Shadow / not promoted:

- Phase 03 prevalence `wouldBlock` (`diagnostics.wouldBlock`) is still not the publication switch.
- Treatment/recap cluster of ≥3 pages, structural family on ≥20% of pages, ≥25 occurrences spanning ≥5 chapters: shadow candidates unless Phase 04 corroboration emits an error.
- Sentence-opening cadence: warning candidate only.
- Medium-confidence corroboration: `review_recommended`, still `COMPLETE`.
- Threshold status: **unchanged, provisional**.

Named shadow constants (unchanged):

- `DUPLICATE_CLUSTER_BLOCKING_MIN_PAGES` = 3
- `STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING` = 0.2
- `STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES` = 25
- `STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS` = 5

### Detector and review schema versions

- Manuscript structural audit: `manuscript-structural-audit-v1`
- Production-map audit: `production-map-audit-v1`
- Style contract: `style-contract-v1`
- Structural review purpose: `review-manuscript-structure`
- Integrity provider purposes: `generate-chapter-brief`, `dedupe-page-beats`, `review-manuscript-structure`

### Active quality revision

Note-only. No live DB row was appended in this environment. Operators should `PATCH /api/admin/generation-quality` with `ANTI_SLOP_QUALITY_REVISION_NOTE` (names anti-slop rollout and `manuscript-structural-audit-v1`). Unknown fields and unrelated settings already survive that route. Mandatory integrity is not a disableable tier list.

### Provider-call budgets (Phase 04 bounds)

- ≤3 packs per call
- ≤2 calls per book
- ≤4 pages per pack
- ≤4000 prose characters per page (labeled `\n…\n` cut)
- 1800 output tokens
- temperature 0
- Clean manuscripts (no treatment / recap / cross-chapter candidate packs): **no** structural-review call

Integrity map-repair purposes (`generate-chapter-brief`, `dedupe-page-beats`) remain bounded by existing Phase 02 repair cycles (at most two full repair cycles; sparse batches of twelve; dense regeneration through `generateChapterBrief`). No new unmetered model call was added in Phase 06.

### Automatic repair exclusions (remaining policy; consolidation not implemented)

Do not automatically consolidate:

- Imported manuscripts
- Pages marked as user-edited after generation
- Books already complete before the feature rollout
- Books whose current content revision changed during review
- Clusters involving quotations, deliberate refrains, legal wording, exercises, or reference definitions unless a safe genre-specific policy exists

These cases remain review-required with evidence. Spec repair bounds if consolidation is ever enabled later: at most three redrafted pages per chapter, at most six per book, one consolidation cycle plus one verification cycle. Observed cost: n/a (not implemented).

### Known FP/FN classes (Phases 01–05)

- Generic-assignment cousins that keep leftover content tokens can still pass substantive-field checks (Phase 01).
- Whole-book maps (`targetPages ≤ 24`) can still *generate* generic assignments; Phase 02 refuses them before draft.
- Legitimate same-subject chapters with shared technical vocabulary can cluster (Phase 03/04).
- Recap comparison is whole-book pairwise after a cheap subject check.
- A book stored as `language: "en"` whose prose is not English will run English phrase families; `fa` with English islands is protected.
- Sentence-opening families are English-only.
- Provider failure preserves deterministic warnings and never claims model approval, so a would-block cluster the model never saw can still publish `COMPLETE`.
- Pack budget leaves clusters unadjudicated (`STRUCTURAL_REVIEW_BUDGET_EXCEEDED`).
- `skipFinalReview` edits do not re-run structural adjudication.
- Live hard-block FP, high-confidence overturn rate, cost, latency, and completion regression: **unmeasured**.

### Operational replay and audit commands

```bash
pnpm anti-slop:replay
```

Runs distilled known-failure, clean, and boundary fixtures. No `storage/`. Exit 1 if any fixture fails.

```bash
pnpm -F @book-maker/core exec vitest run src/generation/antiSlopCalibration.test.ts
pnpm -F @book-maker/core exec vitest run src/generation/manuscriptStructuralAudit.test.ts
pnpm -F @book-maker/core exec vitest run src/generation/manuscriptStructuralReview.test.ts
pnpm -F @book-maker/worker exec vitest run src/handlers/compileExportPolicy.test.ts src/handlers/compileExportStructuralReview.test.ts
```

Local full-manuscript replay (caller-supplied pages only): `replayDeterministicManuscriptChecks({ pages, expectedPageCount?, language? })`.

Operator quality report: `GET /api/projects/:id/status` (and SSE) → `quality.issues[]` with `affectedPageIndexes`, `evidence`, and `cluster` when the finding is a corroborated duplicate cluster. The web console currently shows blocked-page counts, not the issue list; the JSON is the operator quality report. Mobile already lists issue pages from the same payload. Do not treat the missing console issue list as a missing product feature for readers.

### Owner and cadence for future corpus calibration

Owner: operators / this repo’s generation-quality admin.
Cadence: after 50 classified books or 7 days.

### Remaining detectors (not dead)

After the deep manuscript interface (`runDeterministicManuscriptChecks` + targeted `review-manuscript-structure`):

- `pageOverlap.ts` — shared overlap measurement
- `pagesLocalQa.ts` — page-time local QA, including repetition
- `pageBeatDedupDetect.ts` — production-map near-duplicate beats (Phase 02)
- `smartUnslop.ts` — optional polish phrase catalog (not an unbounded blacklist)

Do not delete these. They are assignment-time or page-local, not superseded copies of the manuscript audit.

### Removal plan for `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY` (unchanged; still not executed)

Remove the env override after **≥50 classified books or 7 days of normal volume, whichever is larger**, **and** hard-block false-positive rate **<2%** on a live clean-control set. None of those conditions are measured. Until then, keep default enforce and the `shadow` switch.

### README program definition of done

| Item | Status |
| --- | --- |
| Malformed numeric or string page arrays cannot reach persisted chapter briefs | Met (Phase 01) |
| The system never drafts from generic fallback assignments | Met for chapter-brief + full-map audit (Phases 01–02) |
| A production map with more than twelve collisions is fully handled or rejected | Met (Phase 02) |
| Known same-chapter paraphrase clusters are surfaced with page indexes and evidence | Met (Phases 03–04; Phase 06 structured canonical/duplicate) |
| Manuscript-wide cadence saturation can block on prevalence without requiring unrelated warning families | **Not met as publication.** Cadence is warning-only; prevalence `wouldBlock` stays shadow |
| Model structural review consumes actual prose from focused risk clusters | Met (Phase 04) |
| Clean books incur no additional structural-review model call | Met (Phase 04) |
| Blocking findings result in inspectable exports and `REVIEW_REQUIRED`, not `COMPLETE` | Met for high-confidence corroborated duplication and deterministic errors (Phase 04) |
| Quality reports explain the measured recurrence and show actionable page clusters | Met on the operator/mobile quality JSON; console UI still shows page counts only |
| The rollout meets the precision, cost, and latency gates in Phase 05 | **Unmeasured** |
