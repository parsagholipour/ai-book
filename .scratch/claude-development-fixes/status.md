# Development-fixes status (Fable 5.1, xhigh)

Times UTC. Live run untouched; no production edits while it is active.

## 05:20 — took over
- Live run `development-fixes-1a-retry` (job cmtnx6j3k0000zig0o9y4ei1g) healthy: 15 chapters through dossier extraction, evidence verification in progress, no fatal errors. Seven `OpenAIJsonValidationError` retries on the reviewer (null `canonicalEpisode.date`, truncated reviewer output, an object where a disagreement string was expected) — all recovered by the schema-repair retry.
- Remaining Sol findings (K1 First Crusade, K7 Josephus) share one root cause: `sequence` is a model-ordered total chain the reviewer approves as a whole, so adjacent pairs with no textual order support pass. K1 additionally carries an unknown written against the *provisional* episode ("not Fulcher…") that the reviewer's metadata correction then made false.

## Plan (generic, no case-specific patches)
1. Drop the model-ordered `sequence`. Chronology lives only inside individually entailed claims ("Edessa fell after the army divided"); a temporal claim is supported only when the passage states the order. Legacy packets keep their stored chain; a fresh review of one is rejected deterministically.
2. Unknowns are about the case's content, never about provenance (author/document identity is structured metadata, corrected by the reviewer). Reviewer judges unknowns against the *corrected* canonical episode; a repair rebuilds against that corrected episode so the final packet is what gets reviewed.
3. Fold the validated candidate rules (atomic claims, adversarial entailment, title qualifiers) into production build/review prompts.
4. Harden the reviewer schema against `null` episode fields (observed retry cause).

## 05:25 — live run FAILED at the developmental replan (job cmtnx6j3k0000zig0o9y4ei1g, 0 pages)
- `developBookPlan` compared the revised stance's thesis to the developed answer by exact string equality; the answer is a paragraph and luna paraphrased it twice. Exported as `runs/development-fixes-1a-retry` (diagnostic, not scorable).
- Replay 5 (adapter-boundary, `candidate-evidence-rules-2.json`): 7/8 expected decisions; K1/K7 defects gone by construction (no sequence; unknowns content-only). Socrates lost on one overclaimed claim the repair could not fix → added claim excision.

## 05:35 — implementation-3 applied, unit-tested (freeze over, worker idle)
- `caseEvidence.ts`/`caseEvidenceReview.ts`/`episodes.ts`: version-2 packets, no model-ordered sequence, temporal order inside claims only, unknowns never provenance, repair built against the corrected episode, rejected claims excised on the final review (floor two), null-tolerant reviewer fields. `bookDevelopment.ts`: thesis := answer by construction.
- Core+worker typecheck pass; 66 focused tests pass; gotchas indexed in CLAUDE.md files.
- Running: replay 6 (production modules, 8 fixtures) and live retry `development-fixes-1b` on the same project/plan.

## 05:40 — replay 6 (production modules): 7/8; implementation-4 frozen
- Both wrong cases rejected; K1/K7 rebuilt clean. Keeley lost on a protocol defect (second reviewer anchor broken by an OCR running header / soft hyphen while the first resolved). Fix: a case is grounded by one resolving anchor; broken extras ignored. Snapshot `implementation-4.json` (53 files).
- Run 1b keeps executing on its original worker process (implementation-3 modules loaded at 05:35; nodemon started a second process for new jobs). Only the anchor rule differs. Full `pnpm check` running → check-4.log.

## 05:53 — 1b and 2a both FAILED at the developmental replan (0 pages each); check-4 passed 7/7
- 1b: deterministic rule rejected the research-gap chapter the planner had correctly written as a synthesis chapter (requires [3,4,6], no case). 2a: deterministic checks passed; the model review rejected the plan twice for comparisons/surveys one verified case per chapter cannot carry, and read the voice sample as invented evidence.

## 06:00 — implementation-5 applied, tested, frozen; retries 1c and 2a-retry launched
- Synthesis chapter (no case, has prerequisites) is accepted and inherits its prerequisites' packets, with a "no new named case" line for the writer; three development attempts; unresolved review objections stored as `bookDevelopment.reviewNotes` and shown to the developmental edit rather than failing the book; prompts accept honestly scoped coverage, voice sample is not evidence.
- Core+worker typecheck; 62 focused tests; gotchas 176 indexed. check-5 running.

## Next
- check-5 result → watch 1c / 2a-retry through develop → compose → developmental edit → finalize → compile → replicates 2b, 2c → blind + ASSESSMENT_READY.md → docs final state → result.md.

## 06:15 — 1c passed the developmental replan (first time through), now planning chapter forms
- Three proposals; review objections (6, then 4, same "one case cannot carry a survey" class) recorded as reviewNotes; composition starts next. 2a-retry is in its replan. check-5 passed 7/7 (6,714 tests).

## 06:20–06:30 — 1c and 2a-retry both reached composition, then failed on chapters 1 and 2 (prose-evidence review)
- 1c: two findings survived the single whole-chapter repair ("1085–1086" inferred from "Christmas 1085 … little more than a year"; "eldest sons"); the pass throws. 2a-retry: a reviewer quote did not resolve verbatim; `reviewChapterCaseEvidence` throws. Both 0 pages.
- **Concurrent editing detected at 06:26 UTC**: while I was writing the fix, `packages/core/src/generation/caseEvidence.ts` was rewritten by another editor (findings with `located`, folded quote matching, `verifyChapterEvidenceRepair` by id, `findingsIntroducedBy`), plus `pipelineStages.ts` and `textRouting.test.ts`. The handoff said the parent would not edit production while I own it. I am keeping the other editor's core design intact and adapting my worker-side pieces to it (bounded repair helper, residuals recorded on the chapter report, compile-time `UNSUPPORTED_CASE_CLAIMS` issue → REVIEW_REQUIRED, non-fatal finalize and developmental edit). Watching for further external edits before writing.

## 06:37 — implementation-6 frozen; 1d and 2a-retry-2 launched
- Peer ai-book-maker-57 reconstructed my `{ issues, dropped }` contract after its accidental overwrite; I messaged it to claim generation code + runs. Its pipelineStages/textRouting purpose edits kept.
- Prose-evidence review never throws: re-quote once then drop; two targeted repairs; residuals → chapter report + run log + compile-time `UNSUPPORTED_CASE_CLAIMS` (REVIEW_REQUIRED). Same door for finalize and developmental edit. check-6 running.

## 08:20 — scope changed to DATA COLLECTION ONLY (user correction); no edits, no launches, no stops
- 1d COMPLETED 07:27 UTC → published REVIEW_REQUIRED (11 residual unsupported-case assertions, duplication 41/49, hedging on 50 pages). Exported `runs/development-fixes-1d`; blinded as **J6** (52,119 words, 15 chapters); `ASSESSMENT_READY.md` written.
- 2a-retry-2 and 3a-retry-2 (other session's project) failed at the developmental-edit word floor; 2a-retry-3 / 3a-retry-3 were launched 08:10 and stopped 08:19 by another session. No experiment job active now.
- Accounting written: `cost-accounting.json` + `cost-accounting.md`. Totals: $6.95 provider-estimated over 1,407 luna calls (+462 unpriced research searches); the one completed job $1.60 / 210 calls / 52 min (resumed from persisted prep) vs rung-5 mean $0.42 / 92 calls / 41 min.
- Other session's post-implementation-6 code changes recorded (developmental-edit length extension, JSON retry widening, quality gates opt-in, admin view); not touched.
