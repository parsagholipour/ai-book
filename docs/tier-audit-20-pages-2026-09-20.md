# Four-tier, 20-page live generation audit — 20 September 2026

One matched science brief was run through Quick (`fast`), Balanced, Premium and Ultra with real providers. All four now have 20 saved manuscript pages and published PDF/EPUB exports after recovery. No P0 was observed. Eight P1 defects or guard failures were reproduced and patched (including the September 21 extraction follow-up); the remaining P2/P3 findings are listed below. This is one sample per tier, not a statistical ranking or a certification of factual accuracy.

## Method and first-run results

Baseline: `13bfeef`, initially clean workspace; saved quality revision 52. Every run requested 20 manuscript pages in English, complexity 7, temperature 0.8, automatic strategy, design cover, no full illustrations, and final review enabled. All resolved to `composed-chapters-research`. The operator harness created projects and dispatched the normal worker jobs; this did not exercise mobile onboarding, purchases or credit settlement.

The shared brief, **Keys in Public**, covered public-key cryptography, its history, authentication, implementation failures and post-quantum migration. It required primary sources, no invented anecdotes, a comparison table, and complete, checkable Diffie–Hellman and RSA examples. Expected toy answers: DH public values 8 and 19, shared secret 2; RSA modulus 187, ciphertext 128, recovered message 2.

| Tier | Writer / configured effort | Initial result | Elapsed¹ | Words² | Logged calls³ | Known model cost³ |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Quick | Alibaba `qwen3.7-flash`, thinking enabled | COMPLETE, 20 pages | 38m 32s | 10,093 | 48 | $0.0384 |
| Balanced | OpenAI `gpt-5.6-luna`, low | COMPLETE, 20 pages | 9m 18s | 8,791 | 43 | $0.1561 |
| Premium | Gemini `gemini-3.7-flash`, medium | REVIEW_REQUIRED, 20 pages | 9m 18s | 10,579 | 53 | $0.8253 |
| Ultra | OpenAI `gpt-5.6-sol`, medium | FAILED, 0 pages | 30m 13s | 0 | 11 | $2.0173 |

¹ First plan-job start through the last initial job completion, including queueing. These were overlapping runs on the same local stack. ² Whitespace word counts, including tables/math; production word budgets use the application's readable-word counter. ³ `ProviderCallLog` counts and sum of non-null `costHint`; not an invoice or all-in audit cost. Search and manual diagnostic replays are outside this sum. Ultra had one unpriced call. During these runs, certain planning/composition/editing purposes overrode configured effort to **high** on Premium and **max** on Ultra. This override was removed on September 21; see [stage model settings](admin-stage-model-settings-2026-09-21.md).

Project IDs:

- Quick: `cmua54dap0000phg0n9qfno5j`
- Balanced: `cmua54dbi0002phg0e8odxbf8`
- Premium: `cmua54dbs0004phg0h3hmuio5`
- Ultra: `cmua54dc20006phg0fg87wy68`

## P1 changes

1. **Reasoning consumed the entire completion allowance.** Ultra exhausted 5,000 and 7,500 output tokens planning chapter forms, then all 10,608 tokens composing chapter 1, returning no prose. Elevated chapter-generation purposes now reserve a total allowance of at least 32,000 tokens at high effort and 48,000 at max/xhigh. Ordinary explicit limits and uncapped requests keep their behavior. Gemini also now rejects incomplete responses in text, JSON, tool and streaming paths while retaining paid usage; a live diagnostic replay had returned only about 350 words at its output limit without the adapter rejecting it. Tests cover the allowance and truncation handling. Larger ceilings can increase latency and cost; routing/effort was not downgraded.

   **September 21 retry follow-up:** OpenAI and Gemini budget errors now retain the actual request limit. JSON retries grow that effective limit once (for example, 48,000 to 72,000), preserve the increase through schema/syntax repairs, and stop when documented model output limits or available OpenAI context leave no headroom. If OpenAI returns an unrecognized resolved model ID, the retry uses the known request model's ceiling while usage records retain the returned ID. Requests whose limits are unknown retain the previous bounded retry behavior. Regression tests reproduce the original no-op retry, budget reset and lost ceiling through the real adapters, including streaming, without live provider calls. Effort and routing policies are unchanged.

2. **Fixed: deletion-only cuts preserve Markdown.** The acceptance guard compared and then *returned* whitespace-normalized paragraphs, flattening tables, equations and fenced code. Premium's accepted cuts reproduced the corruption, including malformed Markdown on pages 11–12. Retained blocks now come from the original text, with multiline blocks kept atomic; fenced blocks remain intact across blank lines. Saved cut responses were replayed to recover chapters 3–4 without changing normalized prose. Page descriptions and continuity deltas were refreshed after repagination.

   **September 22 follow-up:** Regression tests found that single-line sentence cuts could still remove code indentation or a list marker, or leave emphasis, inline-code and TeX delimiters open. Sentence cuts now require paragraph structure and unchanged inline Markdown/TeX spans; surrounding prose can still be cut, and malformed candidates retain the original draft. The cut guard and renderer share the same TeX delimiter recognition. All 56 focused cut/composition/math tests pass, including valid and malformed replies through `cutChapter`. Replaying Premium's saved response still accepts the safe cut and preserves both pseudocode blocks byte for byte before pagination; both remain fenced on individual pages afterward. [Replay and check evidence](../.scratch/markdown-cut-fix-2026-09-22/).

   **September 22 validation:** [`pnpm check`](../.scratch/markdown-cut-fix-2026-09-22/check.log) passed all seven gates in 155.1 seconds. All nine PDF fixtures were [pixel-identical to the saved audit baseline](../.scratch/markdown-cut-fix-2026-09-22/fixtures-compare.log). This follow-up replayed saved responses locally; it did not regenerate or modify the historical books.

3. **PDF and EPUB displayed raw TeX.** The Markdown parsers consumed or printed math delimiters without a math renderer. A bounded preprocessing pass protects math from Markdown and restores sanitized, non-executable MathML rendered by KaTeX. It leaves code, links, HTML markup, escaped dollars and ordinary currency alone. EPUB chapters declare MathML in the package manifest. Real book renders show superscripts, fractions and congruences correctly. Unknown TeX remains visible rather than failing the export. DOCX support was added in the September 22 follow-up below.

4. **Wide PDF tables lost their rightmost columns.** The bundled screen stylesheet allowed horizontal overflow, which a PDF clips. Tables with five or more columns now fit the printable width with wrapping and a modestly smaller font. A browser geometry regression reproduced the overflowing cell and now verifies every cell fits. The rebuilt six-column comparison was visually inspected; all nine existing PDF fixtures were pixel-identical to baseline.

5. **Arithmetic checks skipped labeled equations and later chain terms.** A leading label such as `A =` left an empty segment; an early successful congruence returned before checking the rest of the chain. Both paths are fixed and covered through the worker repair entry point. Seeded `A = 5^6 \bmod 23 = 9` now reports the correct result, 8. The existing Balanced run already repaired four RSA findings in two rounds. Rescanning the three finished baseline manuscripts found no additional supported numeric-expression findings; this is a reproduced guard gap, not a claim that those books still contained that seeded wrong equation.

6. **Creative nonfiction prompts authorized unsupported reconstruction.** Premium had zero source documents/excerpts in all five chapter dossiers yet was assigned historical portraits and discovery scenes. The creative contract permitted reconstruction and conflicted with the user's no-invention requirement. Nonfiction now receives source-fidelity/citation rules; without actual passages, proposed episodes and scene assignments are withheld and scene/portrait/close-reading forms become explanation. A live replay through the actual `composeChapter` function produced a 2,111-word RSA explanation without the unsupported room/action narrative. This removes the conflicting instruction; it does not guarantee every generated historical or technical claim is true. The replay was saved separately, not silently substituted into the baseline book.

7. **EPUB bibliography URLs produced invalid XML.** A source URL containing `&section=1.3` was emitted with a bare ampersand in both Balanced and Premium baseline EPUBs. Their XHTML failed an XML parser. Serialization now escapes bare ampersands while preserving XML entities and numeric character references. A parser-based regression verifies valid XHTML, the exact decoded URL, and unchanged visible text.

8. **Story extraction silently discarded returned continuity updates (September 21 follow-up).** The initial prompt described updates without specifying their JSON shape. Qwen returned `facts`, `promises` and `unanswered` instead of the delta fields; Zod stripped those keys and filled the expected fields with empty defaults. This dropped 109 returned fact entries across 19 Quick pages. Ultra also dropped 136 entries under `facts`, with noncanonical delta/entity fields affecting 18 pages. Entity fields such as `state` were stripped too. These were successful calls in the trace, so repair never ran. The extraction prompt now includes the exact output schema and distinguishes delta fields from stored state. Response validation rejects unknown root, delta and entity-update fields, triggering the existing bounded repair; stored-delta parsing stays compatible. Regression tests reproduce fact/entity/promise loss through provider validation, repair and state application, and verify repeated invalid responses fail instead of returning empty success. Replaying the saved responses catches all 19 affected Quick pages and 18 affected Ultra pages; all 20 Premium responses still validate. This changes future extraction, not the historical books or their saved scores. Four isolated real-provider replays with the final prompt all passed on the first attempt: Quick pages 1/13 retained 10/5 fact entries in 44.1/33.3 seconds; Ultra pages 1/20 retained 13/9 in 8.0/8.1 seconds. Providers, effort and the 1,200-token requested budget were unchanged. These samples validate the response contract, not a whole-book speedup.

## Recovery and validation

- Quick, Balanced and Premium exports were rebuilt from their saved manuscripts; Premium additionally received the formatting-only repair described above. Recovery compiles reran deterministic checks and skipped a second model final review. Their COMPLETE status is not a factual-accuracy verdict.
- Ultra resumed from its saved approved plan at 18:59:14 UTC with the same provider/model/effort and published at 19:55:03 UTC: **55m 48s for recovery**, 20 pages, 8,987 words, 29 PDF sheets. All five compositions and edits completed without generation-budget failures. Recovery added 56 logged calls and $5.9681 known model cost; initial attempt plus recovery total 67 calls and $7.9854 known cost, with the original failed compose call still unpriced. Its final heuristic report is **75 / review recommended**: symmetrical-hedging warnings on 12 pages and four unpaid-promise warnings. No export or arithmetic error remains in the checked scope.
- `pnpm check`: **all seven gates passed** in 123.6 seconds. Core: 3,261 tests; API: 1,889; worker: 1,987 passed; database: 324; web: 120; storage: 7. Existing skipped tests remain skipped.
- PDF corpus: nine fixtures, zero pixel differences. New math, cut-preservation, arithmetic, provider-completion and wide-table regressions pass. PDF pages with equations and comparison tables were rendered and inspected.
- Final Quick/Balanced/Premium/Ultra PDFs contain 24/25/31/29 physical sheets, respectively. All four have 20 navigation-map entries and matching stored/actual SHA-256 digests; no extracted text crossed the checked page margins.
- All four EPUBs parse as XML and have no missing internal files or anchors; their MathML declarations were inspected; native e-reader compatibility was not device-tested. Mobile UI was not changed or tested.

Final artifacts (COMPLETE is a lifecycle status, not an independent accuracy assessment):

| Tier | Manuscript pages | PDF sheets | Downloads |
| --- | ---: | ---: | --- |
| Quick | 20 | 24 | [PDF](../.scratch/tier-audit-20-2026-09-20/fast/book.pdf) · [EPUB](../.scratch/tier-audit-20-2026-09-20/fast/book.epub) |
| Balanced | 20 | 25 | [PDF](../.scratch/tier-audit-20-2026-09-20/balanced/book.pdf) · [EPUB](../.scratch/tier-audit-20-2026-09-20/balanced/book.epub) |
| Premium | 20 | 31 | [PDF](../.scratch/tier-audit-20-2026-09-20/premium/book.pdf) · [EPUB](../.scratch/tier-audit-20-2026-09-20/premium/book.epub) |
| Ultra | 20 | 29 | [PDF](../.scratch/tier-audit-20-2026-09-20/ultra/book.pdf) · [EPUB](../.scratch/tier-audit-20-2026-09-20/ultra/book.epub) |

## September 22 follow-up — P2-06 resolved

**Word export now renders editable native equations.** The DOCX converter protects `$…$`, `$$…$$`, `\(…\)` and `\[…\]` before Markdown parsing, then converts the same bounded KaTeX MathML used by PDF/EPUB into Office Math (OMML). Inline equations and centered display equations work in prose, headings, Contents, lists, quotes and tables. Code, escaped dollars, currency and link targets stay literal. Invalid TeX and unsupported MathML remain visible as their original expression rather than dropping content or failing the export.

Rendered fixtures caught a conversion defect where `\bmod` created nested runs inside an XML text node: the XML parsed, but the reader hid “mod.” Token normalization and text-node validation now prevent that defect. Tests also cover XML escaping, named functions, fractions, scripts, roots, sums/integrals, matrices with growing fences, alignment rows and right-to-left prose. TeX cannot authorize embedded files, HTML or external relationships.

The four saved manuscripts were exported locally without new model calls or replacing their published artifacts:

| Tier | Detected expressions | Native Word equations | Fallbacks |
| --- | ---: | ---: | ---: |
| Quick | 56 | 56 | 0 |
| Balanced | 166 | 166 | 0 |
| Premium | 328 | 328 | 0 |
| Ultra | 278 | 278 | 0 |

Validation: 43 focused DOCX/math regressions pass; `pnpm check` passed all seven gates in 149.4 seconds. Every XML part in the four rebuilt DOCX packages parses, and no math text node contains nested elements. English and Persian fixtures were rendered with bundled LibreOffice and visually inspected; Microsoft Word itself was not available for a separate application check. [Replay script, counts and render evidence](../.scratch/docx-math-2026-09-22/).

## P2 — remaining functional/quality gaps

| ID | Finding and evidence | Recommended next change |
| --- | --- | --- |
| P2-01 | **Primary-source coverage and claim verification are weak.** Premium had 0 documents/0 excerpts in every chapter dossier. Balanced had four excerpts in chapter 3 and none in the other four chapters. The saved configuration has `caseEvidence: []`; the ordinary dossier searches archival catalogues, with general web document discovery gated behind case evidence. Search summaries are not passages supporting a specific claim. Premium's original prose calls 187 a “2048-bit modulus” and says Rivest, Shamir, Adleman are listed alphabetically. The source-policy repair does not validate all such statements, and an empty-dossier fallback cannot supply missing evidence. | Measure claim-to-source coverage per chapter; retrieve primary passages for required historical/technical claims and run composed-chapter claim review. Keep unsupported specifics out of explanation as well as scenes. |
| P2-02 | **Quick’s extraction delay was provider-bound in this sample.** Its 21 Qwen calls took 743.414 seconds inside the provider, with only 0.516 seconds total between calls. Premium’s 20 Gemini calls took 49.899 seconds; Balanced had extraction disabled and made zero calls, so the overall tier timings do not isolate model speed. Ultra recovery used 299.633 seconds for 30 calls, including eight output-budget retries and two schema repairs. The separate silent-data-loss bug is fixed as P1-08 above. | Benchmark the same extraction payloads and enabled stages before changing routing or effort. Preserve sequential state semantics; these traces show no material inter-call queue/database delay. |
| P2-03 | **Ultra spends heavily on planning and schema repair.** Initial planning took 19m 49s; the first plan call alone took 701 seconds and used 44,704 output tokens, then failed schema validation because promises were objects instead of strings. After the budget fix, form planning used 33,045 tokens/522 seconds plus a 17,436-token/232-second repair. | Use schema-constrained planning where supported and benchmark purpose-specific effort. The completion-budget repair prevents starvation but does not make max reasoning efficient. |
| P2-04 | **Fixed 22 September: page count hid underdeveloped chapters.** Balanced chapter 3 had 1,370 readable words against a 1,720 minimum; Quick chapter 2 had 1,837 against 2,150, and chapter 4 had 1,682 against 1,720. **Correction:** Ultra chapters 2 and 3 each retained a figure, so their minimum was 1,580; their 1,646 and 1,641 words met it. The original report omitted the figure allowance. | Full-minimum bounded composition retry, protection against shortening in the composition editor, corrected figure-aware reporting, and export QA over the final chapter text. Remaining deficits require review. [Fix and validation](chapter-length-fix-2026-09-22.md). |
| P2-05 | **Fixed 22 September: promise/brief coverage was unreliable.** Premium's unpaid-promise warning asks for the distinction between factoring and discrete logarithms even though the manuscript discusses both. These warnings depend on extracted continuity state and phrasing, not a direct evidence check of the promised passage. Conversely, Balanced received a score of 100 while omitting the explicitly requested comparison table; it is absent from the original drafts as well as the final Markdown. | Final-manuscript review now checks explicit brief requirements and promises with exact page quotations, validates rendered tables, and reports missing versus unverified coverage. Live replay flags Balanced's missing table and verifies Premium's disputed payoff on pages 5 and 9. [Fix and validation](promise-coverage-fix-2026-09-22.md). |

## P3 — polish and observability

- **P3-01: Clarify manuscript pages versus physical sheets.** The request controls 20 manuscript page records. Front matter, bibliography and reflow produce a different physical PDF count. Surface both counts instead of implying a 20-sheet PDF.
- **P3-02: Wide-table typography.** All columns are now visible, but equal widths can split long headings mid-word (for example “Implementations”). Column sizing and repeated headers across page breaks would improve these dense comparisons.
- **P3-03: Persist complete trace context — implemented 2026-09-22.** Durable provider traces now record `requestedMaxTokens` and `effectiveMaxTokens` at adapter dispatch, correlated by `callId` and `requestIndex`, alongside reported `usage.reasoningTokens`. This includes streaming, incomplete responses, application retries and provider fallbacks. Dossier search/drop decisions now start durable writes immediately, with chapter and retrieval-round context, and pending writes drain even when retrieval fails. See [trace format and validation](trace-context-2026-09-22.md). The original audit predates these fields and retains its separate `dossier-console.log`.

## Reproduction and saved evidence

Audit directory: [`.scratch/tier-audit-20-2026-09-20`](../.scratch/tier-audit-20-2026-09-20/). It contains the exact input/routing/revision snapshots (`manifest.json`, `before.json`), immutable initial captures under `baseline/<tier>/`, request/response JSONL logs, page/chapter/job/provider-call records, PDF/EPUB/DOCX artifacts, diagnostic replay scripts, and regression/fixture logs. These local traces are ignored by Git; retain them with this report when sharing the audit.

Useful entry points:

- [`run.ts`](../.scratch/tier-audit-20-2026-09-20/run.ts): launch, watch and capture the actual jobs. The existing manifest deliberately prevents accidental duplicate launches.
- [`baseline`](../.scratch/tier-audit-20-2026-09-20/baseline/): original outcomes, kept separate from recovery.
- [`final-summary.json`](../.scratch/tier-audit-20-2026-09-20/final-summary.json), [`export-validation.json`](../.scratch/tier-audit-20-2026-09-20/export-validation.json), and [`arithmetic-final.json`](../.scratch/tier-audit-20-2026-09-20/arithmetic-final.json): final metrics and validations.
- [`production-compose-replay.ts`](../.scratch/tier-audit-20-2026-09-20/production-compose-replay.ts): real Premium source-policy replay.
- [`check-final-3.log`](../.scratch/tier-audit-20-2026-09-20/check-final-3.log) and [`fixtures-final-compare.log`](../.scratch/tier-audit-20-2026-09-20/fixtures-final-compare.log): full verification results.

September 21 extraction follow-up evidence: [trace summary](../.scratch/story-state-latency-2026-09-21/trace-summary.json) and [saved-trace/live replay harness](../.scratch/story-state-latency-2026-09-21/replay.ts). The live harness replays isolated page requests against the saved judgment models and does not update books.

September 21 validation: 25 focused extraction/retry tests passed; four final live replays passed on their first attempt. Final [`pnpm check`](../.scratch/story-state-latency-2026-09-21/check-verified.log) passed all seven gates in 137.1 seconds (3,313 core, 1,893 API, 2,002 worker, 324 database, 126 web and 7 storage tests passed; existing skips remain). [Final live replay summary](../.scratch/story-state-latency-2026-09-21/live-final-summary.json).
