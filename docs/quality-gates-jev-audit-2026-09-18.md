# Jev opportunities in generation quality gates

Date: 2026-09-18. Scope: current source, quality-gate catalog, worker call sites, and Jev adapter. This is a design audit, not a measured comparison of model accuracy or runtime. Live operator revisions and production usage were not queried. No generation settings or implementation were changed.

The strongest immediate opportunities are a Jev screen before style audits and Smart Unslop rewrites, and a semantic acceptance check after chapter edits. The largest broader substitution is the per-page model reviewer, but its repair instructions and candidate scores require more integration work. Cheap judgment also makes checks on the final rewritten candidate practical.

## What is already implemented

- [Best-of page selection](../packages/core/src/generation/bestOf.ts) uses `decisions.resolve()` and `decideFromCandidates` for `judge-page-drafts`.
- [Best-of chapter selection](../packages/core/src/generation/chapterJudge.ts) uses Jev when configured, compares both candidate orders, and retains the first candidate when the orders disagree. The worker forwards `providers.decisions`.
- [Cover design selection](../packages/core/src/generation/coverDesignSelection.ts) uses the same route for a fixed catalog. This is adjacent to quality gates, rather than a new gate opportunity.
- [Decision routing](../packages/core/src/adapters/decisionRouting.ts) validates choices and distributions, escalates a winning probability below 0.70, handles provider failures and cancellation, and logs physical attempts through [the worker decorator](../apps/worker/src/providers/loggedDecisions.ts).
- The [compiled routing default](../packages/core/src/adapters/generationTextModelRouting.ts) is `fastDecisions: null`. These call sites support Jev; that does not establish that the live operator configuration enables it.

The current [decision contract](../packages/core/src/adapters/decisions.ts) exposes one finite choice. The [Jev adapter](../packages/core/src/adapters/jevDecision.ts) sends exactly one `questions.choice` question. The provider supports choices, scores, boolean probabilities, and multiple questions over shared state in one request. That wider capability is not exposed here yet. [Vercel model documentation](https://vercel.com/ai-gateway/models/jev).

## Recommended first changes

### 1. Screen style audits with Jev

Location: [auditPageStyle](../packages/core/src/generation/styleAuditor.ts), invoked by [qualityEnrichment](../apps/worker/src/generation/qualityEnrichment.ts).

Today, a text-model call returns `styleOk` and `styleIssues`. It runs for the initial page when enabled and excerpts exist; approved revisions can receive up to two additional dedicated style audits.

Ask Jev whether the page has unintended voice drift or a contextual prose defect, using the same pinned excerpts, voice guide, book-specific rules, and explicit reader request. A clear pass can produce the existing empty audit. A suspected defect or inconclusive answer goes to the existing auditor for concrete findings. This avoids generating empty issue lists on clean pages while preserving useful rewrite instructions on failures.

Do not treat a reader-requested tone change as drift. Keep `stylePenalty: 0` for an audited pass and preserve the current handling of comparisons against unaudited candidates.

Priority: first replacement. Frequent, narrow, and has a natural empty success result.

### 2. Judge Smart Unslop candidates before buying a rewrite

Location: [reviewPageWithQualityGates](../apps/worker/src/generation/pageQualityGateReview.ts) and [revisePageDraft](../packages/core/src/generation/pagesReview.ts).

Today, a significant scanner result routes the page into a conditional rewrite before its normal model review. The rewrite model must decide whether the matches are contextual defects and may return the complete draft unchanged.

Give Jev the full page, candidate spans, and genre context. Ask `legitimate_use`, `contextual_defect`, or `needs_review`. Clear legitimate uses can proceed directly to the ordinary checks and review. Confirmed or uncertain candidates retain the current conditional rewrite. Preserve separate local integrity failures and the one-shot scan budget.

This moves the decision about whether a rewrite is justified out of a full-page generation call. Regex matches remain candidates; Jev must consider quotations, literal technical uses, intentional repetition, and essential qualifications.

Priority: first replacement of unnecessary generation work.

### 3. Add semantic acceptance after chapter edits and cuts

Location: [editChapter / cutChapter](../packages/core/src/generation/composedChapter.ts) and [finishChapter](../apps/worker/src/generation/composedChaptersPass.ts).

Today, the chapter editor receives strong preservation instructions. Its local acceptance rejects empty output and output under 62% of the original word count. The worker also rejects degenerate edits. Evidence-enabled chapters get an additional evidence review, but there is no general before/after semantic acceptance check. Deletion-only cuts enforce extractiveness and word budgets, which cannot establish that a deleted qualification was dispensable.

Evaluate original and edited passages with surrounding context. Ask separately whether the change preserves claims, negation, causal relationships, scope, uncertainty, attribution, and quotations, and whether the proposed edit improves the intended defect. For a line edit, accept only a meaning-preserving improvement; retain the original or escalate on uncertainty. For a requested factual correction, judge against the correction and evidence instead of requiring the old claim to survive.

Do not reuse the current chapter competition rubric: it explicitly ignores facts. This needs its own preservation rubric. A failed original must not become approved merely because a bad rewrite was discarded.

Priority: first added judgment for composed books.

### 4. Recheck grounding on the candidate that will actually ship

Location: [enrichPageQualityReport](../apps/worker/src/generation/qualityEnrichment.ts) and [runPageQualityLoop](../apps/worker/src/generation/pageReview.ts).

The dedicated `verifyPageClaims` call runs during initial enrichment. Revisions receive the general page review and, when applicable, bounded style audits; the dedicated claim verifier is not repeated there. The general review does receive research context, so this is a missing dedicated recheck, not an absence of all factual review.

After a factual revision, ask Jev whether the changes introduce unsupported claims, strengthen uncertainty, change attribution, or conflict with supplied evidence. Diagnose flagged changes with the current verifier. Check the final keeper, and avoid repeat work for unchanged text. Preserve `unverified_no_sources`, `unavailable`, and `not_applicable`; insufficient evidence must not become a verified pass.

Priority: first added judgment for per-page factual books.

## Broader substitutions

| Gate or decision | Proposed use | Integration requirement |
| --- | --- | --- |
| `pageModelReview` | Batch decisions for brief fulfillment, progression, reserved future beats, continuity, repetition, and natural style. Clear passes skip the generative reviewer; flags get a diagnostic review. | Preserve local checks and imported-book/opening exemptions. The existing report includes a numeric score used by candidate selection; define a compatible score policy or change selection. A choice probability is not a quality score. |
| `claimVerifier` | Screen pages for support problems; eventually evaluate known claim IDs individually as supported, contradicted, or insufficient evidence. | Jev cannot discover and write an arbitrary list of claim strings through the current choice API. Keep extraction and diagnostic text where needed; provide actual supporting passages. |
| `caseEvidence` packet review | Evaluate already-enumerated claim IDs against their cited passages. This is a particularly clean finite-decision use. | Existing review requires claim coverage, a case match, support judgments, and reasons. Obtain reasons for rejected/uncertain claims through the existing reviewer. Do not replace evidence acquisition or prose finding extraction. |
| `planCritic` / `pageMapCritic` | Decide whether the plan or map needs criticism before asking for a patch. | Retain the patch generator for needed additions, merges, or beat rewrites. Lower priority than per-page work because these calls are less frequent. Mandatory map integrity still runs. |
| Structural manuscript review | Classify an existing candidate cluster as distinct treatment, redundancy, or unresolved. | Current corroboration requires substantive explanations of subject/evidence/conclusion overlap and valid page IDs. A bare choice cannot replace that contract. Start as an additional check; retain mandatory review and its evidence requirements. |
| Final book QA and transition QA | Evaluate concrete opening, ending, or boundary excerpts; escalate failures for page-specific repair instructions. | The final QA page map is abbreviated context, not complete prose. Do not claim a whole-book semantic pass from summaries. Keep the deterministic manuscript audit and publication grading. |
| Page rewrite candidate selection | Compare reviewed candidates directly instead of relying solely on independently generated numeric scores. | Compare within eligible candidates, respect unresolved integrity defects and audit provenance, and retain all failure reports. Pairwise preference is not permission to approve either candidate. |
| Edit adherence | Decide whether the requested change was accomplished and unrelated meaning survived. | Existing adherence returns concrete omissions for repair and can span many pages. Clear passes are candidates for substitution; failures still need diagnosis. |

The page-model reviewer is the largest likely call-volume opportunity. This is inferred from its per-page and per-revision placement, not measured production spend. Some execution modes bypass it, notably composed chapters and the established whole-book local-review path.

## Composed-book opportunities after the first rollout

**Screen before the chapter line edit.** Jev can choose `keep`, `line_edit`, or `needs_review` from the chapter, its assignment, and adjacent context. Skip the editor only for clear keep decisions. Retain generation when length development or a known substantive repair is required. Start after measuring the post-edit guard: the existing edit may improve a chapter even when a broad screen sees no obvious defect.

**Turn deletion-only rewriting into selection over exact spans.** `manuscriptReadCuts` currently asks a text model to return the entire chapter with some sentences removed. A future reader contract could supply exact proposed span IDs and retained evidence span IDs; Jev could approve a coordinated deletion set and code could apply it. This can replace a prose-output call entirely. Preserve existing deletion and word-budget checks, then judge the combined result. Independent decisions must not each delete one of two mutually supporting passages because the other still existed in their inputs. This gate is compiled off, so it is not a first source of default savings.

**Add boundary and contribution checks.** Evaluate adjacent chapter endings/openings for contradiction, repeated conclusions, lost handoffs, and repeated delivery of the same chapter contribution. Use full bounded passages. These can guide the existing reader/editor; they do not replace the whole-manuscript reader's global judgment and written notes.

## Complete gate disposition

The [catalog](../packages/core/src/generation/qualityGates.ts) has 29 IDs, including a retired compatibility key. Defaults are compiled defaults, not observed live settings.

| Gates | Disposition |
| --- | --- |
| `pageLocalQa` | Keep deterministic checks. Add contextual judgment around ambiguous findings, without weakening required integrity. |
| `smartUnslop` | Jev confirmation before conditional rewrite. |
| `pageModelReview` | High-volume screening/substitution candidate with report and scoring redesign. |
| `pageQaRewrite` | Keep prose generation; use Jev before spending and after accepting a changed candidate. |
| `finalBookQa` | Narrow semantic decisions plus existing diagnostics and mandatory audits. |
| `storyExtractAudit` | Keep extraction: it creates facts, promises, and entity updates. Jev can validate a proposed contradiction or state delta, but a finite choice cannot produce the delta. |
| `planCritic`, `pageMapCritic` | Optional Jev triage; retain patch generation. |
| `claimVerifier` | Jev screening/known-claim support judgments plus diagnostics. |
| `compactPageDraftContext`, `styleExcerpts` | No standalone generative call to replace. |
| `styleAuditor` | Best early pass-path substitution. |
| `beatDedup` | Keep mandatory detection and repair; semantic duplicate adjudication is a separate change to the integrity contract. Jev cannot write replacement assignments. |
| `writerTools` | Tool orchestration rather than a judgment gate. Optional retrieval-need routing is separate and must preserve evidence access. |
| `bestOfPolish` | Judge already supports Jev; draft generation remains. |
| `planThinkingBoost` | Changes the existing planner's thinking budget; no extra call to replace. |
| `claimRetrieve` | Retrieves evidence; keep it. Jev can decide whether more evidence is needed, but cannot supply it. |
| `chapterEditorPass` | Keep editor; add semantic acceptance, then evaluate a pre-edit screen. |
| `manuscriptReadPass` | Keep global diagnosis and notes; supplement with bounded checks. |
| `bookDevelopment` | Keep generative planning; finite coverage/support checks can supplement its review. Compiled off. |
| `caseEvidence` | Known-claim review is a good fit; acquisition/extraction/repairs remain generative. Compiled off. |
| `developmentalEdit` | Keep planning and rewrites; add semantic checks on proposed changes and their combined result. Compiled off. |
| `creativeContract` | Prompt contract, not a separate judgment call. Compiled off. |
| `materialFirst` | Plans episodes and acquires/extracts material. Jev may judge selected evidence but cannot replace material production. Compiled off. |
| `coupletRewrite` | Retired; do not restore it. |
| `chapterApparatus`, `figures`, `chapterFocus` | No separate judgment call to replace. Preserve existing deterministic operation; contextual checks could supplement the containing stage if a measured gap warrants them. |
| `manuscriptReadCuts` | Add meaning-preservation guard; later replace full-output deletion with coordinated span selection. Compiled off. |

## Adapter and rollout implications

1. Expose batched typed questions over one shared state, while retaining the existing choice API for its current callers. Question IDs and candidate/span IDs should be stable and code-validated. Validate every answer, not just the first winner.
2. Separate `clean`, `defect`, and `insufficient_context`. A confident decision that an input needs review must still reach review. Probability gating alone does not implement this.
3. Route uncertain screens directly to the existing diagnostic reviewer where practical. The current generic fallback produces another finite choice; following that with a separate diagnostic call can pay for two LLM calls on a failing screen.
4. Calibrate acceptance thresholds per purpose. The current 0.70 is explicitly an initial routing policy, not a measured book-quality guarantee. Especially distinguish false acceptance of a semantic regression from an unnecessary style escalation.
5. Preserve cancellation, bounded attempts, per-physical-call accounting, and diagnostic-write isolation. Record gate/question version, decision, probability, escalation, and whether an LLM call or rewrite was avoided.
6. Reuse source context carefully. [SourceEvidenceContext.prepareDecision](../packages/core/src/sources/generation.ts) performs evidence loading/search for decisions on source-backed books, with a bounded query cache. Measure retrieval plus Jev plus fallback latency; a fast model does not make the whole wrapper free. Batch related checks or reuse a prepared evidence pack while preserving source authorization and cited evidence.
7. Run a shadow comparison on saved drafts and revisions before allowing Jev to skip existing reviews. Label disagreements against prose and evidence, including human review of a sample; the old reviewer is not ground truth. Include intentional repetition, legitimate caveats, requested tone changes, multilingual books, and meaning-changing deletions. Compare defect misses, unnecessary rewrites, retained-draft quality, fallback rate, cost, and p50/p95 latency by pipeline.

The repo prices Jev at $0.042 per million input tokens and zero output cost in [costs.ts](../packages/core/src/costs.ts). At that accounting rate, 100 separate decisions with 5,000 billed input tokens each cost about $0.021 before retrieval and fallbacks. This supports adding multiple narrow judgments; it does not measure their quality or guarantee a shared-state batch's exact billed usage. The current [Vercel listing](https://vercel.com/ai-gateway/models/jev) displays approximately $0.04 per million input tokens.

Recommended order: style screen and Smart Unslop confirmation; chapter-edit semantic acceptance and final-candidate grounding; batched per-page review; then known-claim packet review and the lower-frequency planning/manuscript opportunities.
