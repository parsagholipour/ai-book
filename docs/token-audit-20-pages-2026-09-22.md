# Twenty-page token audit — 22 September 2026

Three real, matched runs completed with **20 manuscript pages and 20 physical PDF pages each**. All reached **REVIEW_REQUIRED**, with exports produced and no failed jobs. This is completion of the pipeline, not a clean quality verdict. No P0 was found. Two P1 accounting defects are fixed. After the follow-up request, **P2-01 is also fixed** in code and live routing revision 58; P2-05 is also fixed below, preserving dynamic chapter structure. Other findings retain their individual follow-up status.

## Runs and method

| Tier | Project | Plan started → export finished (UTC) | Elapsed |
| --- | --- | --- | --- |
| Quick (`fast`) | `cmucvlwhm0000jbls7ag6f1ao` | 16:16:04 → 17:20:04 | 64m 00s |
| Balanced | `cmucvlwic0002jblsje961o0k` | 16:16:04 → 16:52:41 | 36m 36s |
| Premium | `cmucvlwim0004jblsi40jkvnp` | 16:16:04 → 17:49:05 | 93m 01s |

The shared brief was *Keys in Public*, a 20-page English science primer on public-key cryptography, including specified Diffie–Hellman and RSA toy calculations, historical primary sources, implementation failures, post-quantum migration, and a comparison table. Complexity 7, temperature 0.8, final review enabled, no full illustrations or cover image requested. Normal cover-design selection and inline figures remained available. The harness used the existing operator planning/approval/generation queue; mobile credit reservation and purchase settlement were outside this audit.

Live routing revision **57**: Quick used `openai/gpt-5-nano`, medium effort. Balanced and Premium used `openai/gpt-5.6-luna` with different stage overrides: Balanced mostly none/low; Premium medium for source extraction and high for chapter evidence review, while chapter composition used low. Balanced's story-state extraction gate was disabled; Quick and Premium's were enabled. These are comparisons of the configured products, not controlled comparisons of effort alone.

The runs launched concurrently. Source hashes were unchanged throughout generation; the working changes present at launch were committed during the run as `21e92c6`. Fixes in this report were applied only after all three exports finished. One sample per tier is diagnostic evidence, not a latency or quality benchmark distribution.

Accounting uses unique `(callId, requestIndex)` physical text requests and the last cumulative usage snapshot for each. Reasoning is already included in output; it is **not added again**. All **392** text requests had exact usage, and their input/output counts reconcile with the settled ledger. Failures below mean adapter invocations that ended in an error, even when a retry or fallback later allowed the job to complete.

## Measured tokens and cost gaps

| Metric | Quick | Balanced | Premium |
| --- | ---: | ---: | ---: |
| Text requests | 98 | 140 | 154 |
| Input tokens | 549,166 | 1,111,167 | 1,147,411 |
| Output tokens, including reasoning | 469,286 | 181,874 | 500,580 |
| Reasoning tokens | 430,144 | 12,172 | 300,049 |
| Reasoning share of output | **91.7%** | **6.7%** | **59.9%** |
| Failed text requests | **74** | 5 | 22 |
| Output charged on failed requests | **312,254** | 10,525 | **162,933** |
| Failed-request share of output | 66.5% | 5.8% | 32.5% |
| Cached input tokens | 69,376 | 11,165 | 40,239 |
| Research calls missing from ledger | **14** | **42** | **43** |
| Recorded text-model cost hint, USD | $0.212051 | $0.493425 | $0.878249 |
| Final readable prose words | 8,965 | 9,605 | 9,469 |

**These dollar amounts are partial costs.** All **99 grounded research calls** were omitted by the pre-fix research adapter/logger. Their raw provider usage was discarded, so historical token counts cannot be reconstructed from these traces. Search/tool charges also remain outside model-token pricing. Cost hints use the repository's price catalog, not an invoice reconciliation.

Largest output consumers (failed counts include exhausted retries and schema errors):

| Tier / stage | Calls (failed) | Input | Output | Reasoning |
| --- | ---: | ---: | ---: | ---: |
| Quick: evidence review | 16 (15) | 51,488 | 178,769 | 173,824 |
| Quick: chapter composition | 6 (0) | 128,557 | 55,315 | 39,296 |
| Quick: story-state extraction | 36 (35) | 46,910 | 52,876 | 52,736 |
| Quick: manuscript review | 5 (2) | 43,087 | 40,913 | 36,864 |
| Balanced: evidence review | 39 (5) | 161,609 | 88,445 | 6,081 |
| Balanced: chapter editing | 15 (0) | 263,097 | 34,208 | 2,862 |
| Balanced: chapter composition | 5 (0) | 62,060 | 12,378 | 807 |
| Premium: evidence review | 39 (17) | 165,194 | 338,226 | 233,302 |
| Premium: chapter editing | 13 (0) | 254,509 | 30,268 | 6,093 |
| Premium: manuscript review | 3 (0) | 31,813 | 25,021 | 16,421 |
| Premium: chapter composition | 7 (0) | 86,363 | 17,000 | 744 |

## P1 fixes applied

**P1-01 — Grounded research vanished from token and cost accounting.** `GeminiResearchAdapter.search` now preserves provider identity, resolved model, and provider usage. `LoggingResearchAdapter` persists that usage with project/job/call correlation using the existing accounting path. Reasoning is counted within output once; cache usage is preserved. Optional usage keeps custom/unmetered providers compatible and avoids inventing a zero-dollar result when usage is unavailable. This fixes future calls; it does not backfill the 99 baseline searches.

Changed: `packages/core/src/adapters/types.ts`, `packages/core/src/adapters/gemini.ts`, `apps/worker/src/providers/loggedAdapters.ts`.

**P1-02 — Failed prose and raw-stream calls could discard exact paid usage.** Failed prose now uses the same settlement path as JSON/tools; raw streams settle from provider usage rather than a character estimate when counts are available. A later unstructured stream error also preserves usage already observed for that attempt. Provider transitions clear observed usage so a fallback cannot inherit the previous provider's counts. Existing fallback settlement guards prevent double recording. Usage-free streams remain provisional and unpriced.

Changed: `apps/worker/src/providers/loggedAdapters.ts`, `apps/worker/src/providers/textFallbackAccounting.ts`. This defect was reproduced with actual adapter SDK fixtures; the completed baseline itself had no text-ledger reconciliation gaps. Tool-failure coverage protects the already-supported path as well.

Regression coverage in `apps/worker/src/providers/textProviderTracing.test.ts` exercises OpenAI/Gemini truncation, successful and failed raw streams, late unstructured failure, research adapter → logger → ledger/trace, reasoning accounting, and absent usage. Red runs were captured before the fixes. A separate live fixed research call returned **213 input / 492 output / 373 reasoning tokens** in 6.437 seconds; these counts survived the adapter. That diagnostic call is excluded from the baseline table.

## P2 findings — report only

**P2-01 — Fixed after follow-up: Quick's configured reasoning effort and small stage budgets were poorly matched.** Of its 74 failed requests, 73 were incomplete responses. Episode planning exhausted both 12,000 and 18,000 limits, spending **29,952 output tokens entirely on reasoning**. All eight page-description calls and both chapter-form calls failed; story extraction failed 35/36 times. This creates long waits and leaves quality/continuity checks incomplete. The review-required verdict was preserved, but the extraction failure rate was unacceptable.

A replay of the identical episode request at **low** effort with its original allowance succeeded for all four chapters in **23.46s**, consuming **3,337 output / 1,280 reasoning tokens**, without retry—89% less output than the baseline's two failed attempts. A second replay kept medium effort but raised plan-critique allowance from 1,200 to 8,000; it succeeded using 1,224 output tokens. These single samples support benchmarking stage-specific effort and allowance together. They do not establish a universal replacement setting. Raising every ceiling would increase exposure without addressing the cause. The baseline used routing revision 57; the follow-up fix below explicitly changes eight Quick stage settings.

**Why 35 of 36 failed.** There were 18 eligible pages, each with a 1,200-token initial call and one 1,800-token retry: 36 physical requests. All 18 first calls and 17 retries failed. Only page 1's retry succeeded. Pages 10 and 20 were already `FAILED_QA`, so the finalizer's approved-page gate skipped their story extraction. This was not an unbounded retry loop. `max_output_tokens` includes reasoning and JSON together. Every failed extraction spent its entire reported output on reasoning; the retry restarted the same prompt with a small increase, rather than continuing the earlier reasoning. The old allowance helper protected certain chapter stages only at high/max effort; it did not protect story extraction at medium.

**Implemented correction.** Saved and read back routing revision **58**, changing the primary effort to **low** for Quick's story extraction, page descriptions, plan critique, cover selection, provenance review, edit acceptance, chapter forms, and episode planning. The exact partial PATCH is [quick-stage-routing-2026-09-22.json](/run/media/parsa/projects/ravanix-book/ai-book-maker/docs/quick-stage-routing-2026-09-22.json). API read-back assertions confirmed the patch changed only those eight stage efforts.

`chapterOutputBudget.ts` now gives six small structured stages a total output allowance of at least **4,000 for low / 8,000 for medium / 16,000 for high / 24,000 for xhigh or max**. It preserves the selected effort, explicit larger limits, absent limits, and ordinary unrelated calls. None/minimal retain their original allowance. This is additional room to finish, not a request to consume that many tokens. The existing one-widened-retry bound and provider ceiling still apply. Chapter forms/episode planning retain their stage budgets and use the calibrated low setting.

Controlled replays of all 18 original story requests:

| Configuration | Valid results | Physical requests | Output tokens including reasoning |
| --- | ---: | ---: | ---: |
| Original medium, 1,200→1,800 | 1/18 | 36 | 52,876 |
| Minimal, original caps (rejected candidate) | 17/18 | 27 | 7,100 |
| Low, original caps (effort-only probe) | 18/18 | 18 | 15,004 |
| Medium, 6,000 cap (budget-only probe) | 18/18 | 18 | 57,881 |
| **Final low + reasoning-aware allowance** | **18/18** | **18** | **16,508** |

The final replay used **68.8% less output** than the failed baseline and produced 18 valid deltas. Minimal was rejected because schema failures survived repair. Low also passed four live behavioral controls: extract a new fact, pay an explained promise, detect an explicit contradiction, and keep an unexplained promise open.

Nine further captured requests (four page-description batches plus critique, episodes, cover, provenance, and edit acceptance) passed at low on their first attempt. Chapter forms produced all four valid compositions after one bounded budget retry (4,300→6,450); its final answer used 4,310 output tokens. A preliminary harness wrongly applied a stricter figure schema than production; the corrected check uses production's `normalizeChapterCompositions` and confirms it retained each model-provided through-line rather than substituting fallback chapters.

Regression tests in `structuredOutputBudget.test.ts` drove the actual extractor → JSON retry → provider adapter path using the observed medium response size. The original code failed all 13 initial cases; the fixed suite also covers both OpenAI/Gemini wire limits, effective-limit widening, preserved efforts, absent/larger limits, and unrelated calls. Final **`pnpm check`: all seven gates passed in 150.0s**. Evidence: `.scratch/quick-stage-fix-2026-09-22/` contains the live red repro, all three effort/budget comparisons, final replays, four behavioral controls, other-stage probes, routing before/after and verification logs. These are stage replays, not a regenerated whole book; original books and baseline totals remain unchanged.

**P2-02 — Evidence review dominates spend while retrieval leaves most assertions unverified.** Implementation follow-up: [23 September fixes and replay validation](./evidence-review-fixes-2026-09-23.md). Premium spent **338,226 output tokens** on evidence review—67.6% of all its output and almost 20× its composition output. Balanced spent 88,445 (48.6%). Premium's inventory phase alone used **199,300 output / 159,836 reasoning tokens** across 21 calls; Balanced used 33,110 / 923 across 17. Repeated whole-chapter inventories, verification, repair, and re-review multiply cost.

Final claim coverage was **0/26 supported** for Quick (three chapters unavailable, one incomplete), **53/191** for Balanced, and **78/415** for Premium. These are model-extracted inventories of different manuscripts, not comparable factual-accuracy scores. “Unsupported” means no adequate supplied passage, not necessarily a false claim. Balanced had two incomplete chapter reviews; Premium had three. All three books correctly retained source-verification warnings/errors.

Five verification failures in Balanced and five in Premium included missing required `support` arrays, provoking retries of large payloads. Recommend narrowly normalizing missing support to an empty array for explicitly insufficient-evidence verdicts, while preserving strict quote validation for supported claims. Retrieve targeted passages for unresolved claims and reuse inventories only while the chapter content hash is unchanged. Benchmark lower effort for inventory extraction separately from substantive verification.

**P2-03 — Large research summaries are repeatedly included in prompts.** Quick's first chapter request contained **71.6k characters** of compact-serialized `researchNotes` within a 77,884-character user payload, versus 18.5k/36,275 for Balanced and 20.7k/38,077 for Premium. Quick had no verified dossier in that request. Note counts are bounded but summary lengths are not; chapter composition/edit retries keep paying to ingest them. Bound chapter-specific summary length, deduplicate it, and retain a separate budget for exact source passages needed to verify claims. Do not solve this by indiscriminately cutting evidence.

Edit-acceptance comparisons are another input hotspot: **308,504 input tokens** in Balanced and **258,172** in Premium. Only 8/17 successful Balanced verdicts and 7/13 successful Premium verdicts accepted both meaning and intent. Rejected edits are useful protection, not automatically wasted calls; target smaller edits and measure accepted improvements per token before relaxing those guards.

**P2-03 implementation update (23 September):** shared summary limits and deduplication now cover compose, edit and acceptance prompts, with source passages and full semantic comparisons preserved. Saved-payload replay reduces acceptance input characters by 55.8% / 11.1% / 14.1% for Quick / Balanced / Premium. See [implementation and validation](chapter-research-context-fix-2026-09-23.md). These are size projections; editorial acceptance-rate improvements are not claimed.

**P2-04 — Page count alone hides content shortfalls.** Quick chapter 1 ended at **1,367 readable words against a 2,150-word minimum**, 783 short after drafting/retry/editing. All final Balanced/Premium chapters met their production minima after inline-figure allowances. Premium nevertheless omitted the requested comparison table; Balanced's review reported missing Shor coverage. Production arithmetic checks found no findings in these final chapters; this is not a proof of overall correctness. Use unresolved brief/length checks as repair targets, rather than counting 20 pages as full delivery.

**P2-05 — Fixed 23 September: review the evolving manuscript's actual structure.** Balanced's review said there were no four/five distinct chapters even though the stored manuscript and export had five. Coverage now receives the same current titles and page ranges used by export, after prose repairs and chapter grouping. Structural requirements can cite those divisions without requiring headings inside page prose; content requirements still need exact prose evidence. Split, merge, rename and boundary changes invalidate cached coverage. The initial plan remains provisional: its chapter count and placement are not mandatory targets. Only explicit structural constraints in the user's brief constrain coverage; deviations remain visible rather than forcing the book back to its first outline. No fixed chapter-count enforcement was added. A live replay against the saved Balanced manuscript now recognizes its five chapters and separately verifies the clear argument from exact prose evidence (6.882s; 14,530 input / 523 output tokens, including 173 reasoning tokens). Regression coverage exercises fewer/more chapters than planned, shared review/export grouping, structure-dependent cache invalidation, unknown structure, explicit user constraints, and rejection of unsupported content claims. Final `pnpm check` passed all seven gates in 187.6s. Follow-up verification artifacts are in `.scratch/dynamic-chapter-coverage/`.

## P3 findings — report only

- **P3-01: Incomplete dispatch metadata.** Text traces preserve the requested/effective token cap and provider identity, but not the selected reasoning effort and routing revision per physical request. This audit needed the separate revision-57 configuration snapshot. Persist that routing context with dispatch telemetry so later audits survive settings changes. `plan-book` also logged a null effective cap in all three runs; that means provider-default/unknown, not measured unlimited capacity.
- **P3-02: Grounded-search cost remains partial.** The fix records model tokens; Google search/tool fees are not represented by `calculateTextGenerationCost`. Keep those fees explicitly separate/unknown until the provider's relevant billing counters can be recorded and priced. The baseline omitted usage cannot be safely backfilled from character estimates.
- **P3-03 — Implemented 23 September: research latency breakdown.** Individual successful baseline research operations took up to **60.4s Quick, 255.2s Balanced, 233.5s Premium**. Future Gemini research responses now preserve `result.timings` in the durable `research.search.response` event: `providerRequestMs` measures the provider SDK call (model/search and any SDK retries), `groundingRedirectsMs` measures the redirect batch including unsuccessful resolutions, and `totalMs` includes local response processing. Measurements use a monotonic clock and describe the successful adapter attempt; the existing operation duration additionally includes caller retries/backoff and logging overhead. Provider-managed search cannot be separated from model time through this SDK response. Historical timings cannot be reconstructed. See [implementation and validation](research-timings-2026-09-23.md).

## Validation and artifacts

- All three captures assert 20 pages, a finished project state, and completed export jobs. PDF metadata reports 20 physical pages for each; EPUB/DOCX ZIP integrity and XML parsing pass. No visual-layout claim is made by these structural checks.
- All 392 baseline text dispatches reconcile with settled ledger input/output usage. The baseline research gap is retained explicitly, not converted into zero usage.
- Initial focused accounting suite: **110 passed**. Final `pnpm check`: **all seven gates passed in 150.5s** (typecheck, lint, file sizes, gotcha index, subpath checks, subpath tests, workspace tests). Workspace suites reported **7,798 passed / 6 skipped**; the final tracing fixture suite contains 57 tests, including the additional late-stream-error regression. Existing unrelated lint warnings remain warnings.
- Diagnostic effort replays and the live fixed research request are separate from baseline totals. Full books were not regenerated after the accounting-only fixes.

Local evidence root: `/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-20-2026-09-22/` (ignored by Git). It contains the input/routing snapshot (`before.json`, `manifest.json`), source hashes, immutable captured baseline copies (`baseline/`), each tier's `captured.json`, JSONL traces and PDF/EPUB/DOCX, `token-analysis.json`, `final-metrics.json`, `quality-check.json`, export checks, red/green regression output, and replay results.

- [Quick PDF](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-20-2026-09-22/fast/book.pdf)
- [Balanced PDF](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-20-2026-09-22/balanced/book.pdf)
- [Premium PDF](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-20-2026-09-22/premium/book.pdf)
- [Per-stage/attempt trace analysis](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-20-2026-09-22/token-analysis.json)
- [Full verification log](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/token-audit-20-2026-09-22/pnpm-check.log)
