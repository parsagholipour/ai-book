# Phase 03 Output Notes

## Status

Complete

## Implemented

`runDeterministicManuscriptChecks({ pages, expectedPageCount, language? })` still owns deterministic manuscript findings. Optional `language` is omitted when absent (`exactOptionalPropertyTypes`). `compileExport` passes `input.language` through `runCompileManuscriptChecks`.

New detector families, all evidence-producing and warning-severity (they cannot flip COMPLETE → REVIEW_REQUIRED):

- `SAME_CHAPTER_TREATMENT_REPETITION` — same-chapter pages that share a strong named-entity anchor **and** materially repeat evidence, causal, or conclusion signatures. Recurring subject alone is clean. Clusters, not per-pair issues.
- `RECAP_BACKTRACKING` — later pages that reintroduce a definition/setup, restated evidence, or recap cues without advancing. Clusters.
- `SENTENCE_OPENING_CADENCE` — English sentence-opening families counted across **every** narrative sentence, including interiors. Headings, lists, blockquotes, fences, quoted speech, abbreviations, and fragments under five words are skipped. Distribution signal: one use stays clean; ≥12 occurrences and 4× the clean-corpus baseline (3) is a warning candidate.

Existing grid / hedging / framework / placeholder / research-meta / cross-chapter detectors remain. They now attach optional `metrics` (occurrences, affected page ratio, chapters spanned, cluster count, same paragraph role) and short `evidence` excerpts. Cross-chapter issue shape matches same-chapter findings.

**Shadow policy vs publication:** `evaluateManuscriptBlockingPolicy` computes `wouldBlock` from corroboration (three of the original six structural families) **or** saturation (≥3 pages in one treatment/recap cluster; one structural family on ≥20% of pages; ≥25 occurrences spanning ≥5 chapters). Cadence saturation is a warning candidate only. `diagnostics.wouldBlock` and `metrics.wouldBlock` record that decision. `buildManuscriptQualityReport.state` is **unchanged**: only deterministic **errors** block, and `compileExport` still maps `state === "blocked"` → `REVIEW_REQUIRED`. `STRUCTURAL_SLOP_SATURATION` is still emitted only from the original six families, not from the new Phase 03 codes.

Integrity errors (`MISSING_PAGES`, `PAGE_COUNT_MISMATCH`, and the rest) are unchanged. No new provider calls. No automatic prose rewrites. No mutation of completed books.

Detector version: `manuscript-structural-audit-v1`. Diagnostics are aggregatable by finding code and detector version. JSON field names are camelCase (`wouldBlock`, not `would_block`). No key contains `"model"`.

Language: Unicode tokenization. English phrase families run when `language` is English, or, if omitted, when prose is Latin-majority with at least three distinct English function words. Subject/evidence clustering is script-agnostic. Non-English `language: "fa"` controls do not fire English phrase rules. Prose is not translated.

Replay: `replayDeterministicManuscriptChecks({ pages, expectedPageCount?, language? })` reads caller-supplied pages only. It is not coupled to `storage/`.

## Files Changed

### Core

- `packages/core/src/generation/manuscriptQuality.ts` (orchestrator; split under 900 lines)
- `packages/core/src/generation/manuscriptQualityIssue.ts` (new types, constructors, detector version)
- `packages/core/src/generation/manuscriptQualityPolicy.ts` (named shadow thresholds, `wouldBlock` policy; 3-page cluster limited to treatment/recap)
- `packages/core/src/generation/manuscriptQualityPolicy.test.ts`
- `packages/core/src/generation/manuscriptPageCache.ts` (strip/tokenize once)
- `packages/core/src/generation/manuscriptLexicalRepetition.ts` (near-duplicate / phrase / opening)
- `packages/core/src/generation/manuscriptSignatures.ts` (cached page signatures)
- `packages/core/src/generation/manuscriptLanguage.ts`
- `packages/core/src/generation/manuscriptStructuralSlop.ts` (metrics/evidence; English gate; saturation error moved out)
- `packages/core/src/generation/manuscriptTreatmentAudit.ts`
- `packages/core/src/generation/manuscriptCadence.ts`
- `packages/core/src/generation/manuscriptReplay.ts`
- `packages/core/src/generation/manuscriptStructuralAudit.test.ts`
- `packages/core/src/generation/manuscriptStructuralSlop.test.ts`
- `packages/core/src/generation/testing/manuscriptStructuralAuditFixtures.ts`
- `packages/core/src/index.ts`

### Worker

- `apps/worker/src/generation/compileManuscriptChecks.ts`
- `apps/worker/src/handlers/compileExport.ts` (passes language; no publication-policy change)
- `apps/worker/src/handlers/compileExportStandDown.ts` (`manuscriptPageCount` into the grader)
- `apps/worker/src/handlers/compileExportStoredQuality.ts` (lenient optional metrics/evidence)
- `apps/worker/src/handlers/compileExportPolicy.test.ts`

### API

- `apps/api/src/projectStatus.ts` (optional metrics, evidence, diagnostics passthrough; no Prisma migration)

## Tests Run

- `pnpm -F @book-maker/core exec vitest run src/generation/manuscriptQuality.test.ts src/generation/manuscriptStructuralSlop.test.ts src/generation/manuscriptStructuralAudit.test.ts src/generation/manuscriptQualityPolicy.test.ts` — 4 files, 60 passed.
- `pnpm -F @book-maker/core typecheck` — passed.
- `pnpm -F @book-maker/worker exec vitest run src/handlers/compileExportQuality.test.ts src/handlers/compileExportPolicy.test.ts` — 2 files, 33 passed.
- `pnpm -F @book-maker/worker exec vitest run src/handlers/compileExportStandDown.test.ts src/handlers/compileExportQualityProvenance.test.ts` — 2 files, 16 passed.
- `pnpm -F @book-maker/worker typecheck` — passed.
- `pnpm check:sizes` — Phase 03 files are under 900. Pre-existing failures only: `pagesReview.test.ts`, `pageReview.test.ts`, `pageReview.ts`, `restructurePages.test.ts`.

Full `pnpm check` was not re-run. Known unrelated failures remain API typecheck in `bookEditOperationRetries.ts` / `.test.ts` and the file-size entries above.

## Metrics Or Replay Results

Distilled fixtures only (Indus paraphrase cluster, distinct-evidence control, Bandha recap, 40/120 hedge, interior cadence, non-English hedge islands). No `storage/` dependency.

120-page performance fixture is asserted under **1500 ms** (CI budget). Locally the entire 54-test manuscript suite, including that fixture, finished in ~400 ms of test time, so the 120-page audit is well under the 500 ms p95 target on this machine.

## Deviations From Plan

- Shadow `would_block` is computed and stored, but publication still uses the previous error-only mapping. This is required by the spec for this phase, not an accidental miss.
- JSON uses `wouldBlock` (camelCase) to match `affectedPageIndexes`. Diagnostics live on the report and optionally on issues.
- New finding codes are **warnings** and are **not** counted toward `STRUCTURAL_SLOP_SATURATION`, so two old families plus one new one cannot newly block a book.
- `language` is an optional third field on the existing options object rather than a new function.
- `manuscriptQuality.ts` was split along cache / lexical / slop / treatment / cadence / policy seams instead of raising the 900-line ceiling. `compileExport.ts` gained a worker helper for the same reason.
- When `language` is omitted, English phrase detectors use a Latin-majority + ≥3 function-word classifier so existing English tests (no language field) keep working, while Persian/CJK pages stay gated off.
- The ≥3-page cluster `wouldBlock` rule is restricted to `SAME_CHAPTER_TREATMENT_REPETITION` and `RECAP_BACKTRACKING`. Original corroboration families (grid, hedging, framework, placeholders, research-meta, cross-chapter) become blocking candidates via 20% page-share, 25 occurrences spanning 5 chapters, or three-family corroboration — not merely by appearing on three pages. Those detectors already refuse to fire below 3–4 pages, so applying the cluster floor to them made almost every warning `wouldBlock: true` even at ~5% of a long book. Cadence stays warning-candidate only. Publication mapping remains errors-only.

## Known Risks

- Treatment and recap overlap thresholds are explicit but not calibrated (Phase 05). Legitimate same-subject chapters with shared technical vocabulary could still cluster.
- Recap comparison is whole-book pairwise after a cheap subject check. Fine at 120 pages; very large manuscripts are still synchronous.
- A book whose stored `language` is `en` while the prose is not English will run English phrase families. The inverse (`fa` with English islands) is protected.
- Shadow `diagnostics.wouldBlock === true` can appear on books that still publish COMPLETE. Operators reading diagnostics must not treat that flag as the live publication rule until Phase 04/05.
- Sentence-opening families are English-only; other languages have no cadence detector yet.

## Handoff To Phase 04

Phase 04 may assume:

- Deterministic clusters exist with page indexes, short excerpts, counts/ratios, cluster size, detector version `manuscript-structural-audit-v1`, and shadow `wouldBlock`.
- New families are warnings. Publication COMPLETE vs REVIEW_REQUIRED still follows deterministic **errors** only (`STRUCTURAL_SLOP_SATURATION` from the original six families, plus integrity errors).
- Language is available on the compile path when the project has one.
- `replayDeterministicManuscriptChecks` can drive local packs from supplied pages.

Phase 04 must not:

- Ask a model to rediscover risk from an undifferentiated full manuscript.
- Treat `diagnostics.wouldBlock` as already-enforced status.
- Add unbounded model calls or automatic structural rewrites.
- Mutate completed books retrospectively.

Inherited rollout: `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY` from Phase 02 is unrelated. No new Phase 03 rollout flag; this phase is shadow-by-construction (compute, do not enforce).
