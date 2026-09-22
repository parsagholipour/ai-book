# Source pipeline fixes — 21 September 2026

The source failures in the [20-page tier audit](tier-audit-20-pages-2026-09-20.md) are addressed in the composed nonfiction pipeline. Provider selections, tier routing, credentials and search service are unchanged. Discovery still uses the configured Gemini/Google Search adapter; writing and verification use the existing tier adapters.

## P0/P1 disposition

No new P0 was found. These P1 failure paths were repaired:

| Failure | Resulting behavior |
| --- | --- |
| Web document discovery required the case-evidence experiment, and the ordinary worker path did not supply its search adapter. | Quick, Balanced, Premium and Ultra all gather nonfiction source passages with the existing search adapter, independently of those experiment flags. A missing episode plan gets chapter-based research queries. |
| A valid but empty saved dossier suppressed research on resume. | Legacy empty dossiers receive bounded retrieval. Attempted chapters and unresolved research gaps are saved; resumes do not restart unsuccessful searches indefinitely. Supplements merge into the saved plan with a compare-and-swap. |
| Discovery answered with background summaries; direct original papers below the first three results were discarded. | Document searches request originals. Direct PDFs, institutional documents and documentation receive fetch priority before truncation. URL priority is not a provenance verdict: copied passages receive a separate contextual check, which rejects secondary summaries masquerading as originals. |
| Evidence checks covered selected historical cases, leaving ordinary technical and historical assertions unchecked. | Separate inventory and verification calls assess externally verifiable assertions in every nonfiction chapter. Supported/contradicted judgments require exact quotations from provenance-verified passages. Missing support, malformed coverage and provider failure cannot count as a clean check. |
| Missing support did not drive retrieval and repair. | Up to two missing-claim queries seek more passages. Up to two targeted edits correct, narrow or remove unsupported assertions. Semantic acceptance and source re-verification remain required; unsuccessful repairs retain explicit findings for `REVIEW_REQUIRED`. |
| Factual edits inherited the original chapter's forms and target length. | Correction prompts omit composition form assignments and use the current prose length. The live Premium control previously expanded a short repair into a 2,038-word discovery narrative; verification rejected it. The revised path repaired the same control in one edit. |
| A nested verification schema was rejected by Gemini with `400 INVALID_ARGUMENT`. | The unsupported nested array bound is removed from the response schema. The inventory still limits the work to 100 claims, and verdicts are matched to that inventory. A live isolated probe reproduced the failure and verified the compatible schema. |
| Later edits and pagination could conceal findings or reuse an obsolete review. | Final staged text is checked after chapter edits and pagination. Export matches claims across page boundaries and repeated occurrences. A digest mismatch after later editing produces `SOURCE_VERIFICATION_INCOMPLETE`; a reprint makes no extra model call. |
| “2048-bit modulus n = 187” passed arithmetic checks. | The deterministic checker computes the integer's binary length: 187 needs 8 bits. Correct bit lengths, separate toy examples and buffer-width descriptions have regression coverage. |

Fiction retains its existing composition behavior. The new source requirements apply to factual nonfiction, not invented narrative details. The earlier audit's export, page-cut and output-budget fixes remain in the working tree.

## Live evidence

The saved Premium chapter 3 from the original 20-page cryptography audit had **0 documents and 0 excerpts**. Replaying its saved research episodes through the repaired retrieval path fetched **9 distinct documents across two bounded rounds** and retained **4 verified passages from 2 original documents**, in **130.4 seconds**:

- Rivest, Shamir and Adleman's original RSA paper: `https://people.csail.mit.edu/rivest/Rsapaper.pdf`.
- Cocks's original research note: `https://cryptocellar.org/cesg/notense.pdf`.

Reviewing the old chapter against those passages identified **24 claim spans with insufficient evidence**, including the sentence saying the authors were listed alphabetically. This is a finding about support in the retrieved passages, not proof that all 24 statements are false. The old chapter is not certified as factually correct.

The repair control combines the actual retrieved RSA abstract with the unsupported alphabetical-order sentence, then runs the real inventory, passage verification, editor, semantic acceptance and final verification in each tier. This tests both rejection of an unsupported assertion and preservation of supported text. Traces and before/after prose are retained below.

## Remaining P2/P3

- **P2 — Evidence coverage:** four passages do not cover every assertion in the old chapter. Retrieval and repair are deliberately bounded; unsupported material now leads to explicit review. Claim-directed search prioritization, broader passage selection and repeated-topic benchmarks remain useful follow-up work.
- **P2 — Verification recall:** the inventory and entailment judgments remain model judgments. Models can omit a claim, combine several assertions, or be overly strict about equivalent wording or notation. Exact citation validation prevents fabricated support quotations; it cannot prove complete factual accuracy. Independent labeled evaluations are still needed.
- **P2 — Extraction and metadata:** oversized PDFs remain subject to the existing 12 MiB bound. Formula OCR defects and page-number artifacts caused passage rejection in the replay. Bare-domain search titles sometimes confused the provenance reviewer. Better document metadata and mathematical text extraction would improve usable coverage.
- **P2 — Latency:** the source replay added roughly two minutes for one chapter; the four tiers differ substantially in verification and editing latency. Cache normalized documents and verified passages, and benchmark query batching before increasing retrieval budgets.
- **P2 — Reviews after manual edits:** export invalidates stale source checks, but a dedicated user-facing action to refresh only the affected chapter's claim ledger is not implemented. The issue remains visible rather than silently reusing an obsolete verdict.
- **P3 — Review presentation:** the complete claim-to-passage ledger is stored and traced. A dedicated screen for opening the exact passage, its URL and normalized-text offset is still missing; existing QA lists show the affected pages and findings.

## Repository validation

`pnpm check` passed all seven gates in 117.1 seconds: typecheck, lint, file-size budgets, documented gotchas, package subpaths, subpath tests and workspace tests. The workspace suites passed 7,617 tests (existing opt-in skips remain).

Regressions cover web retrieval with case-evidence flags off in all four tiers, legacy empty dossiers and bounded resume, source URL selection, fabricated support quotations, omitted verdicts, verifier outages, targeted removal without case packets, correction length limits, rejected repair candidates, page-spanning and repeated assertions, changed final text, stale export reviews, cancellation, and fiction behavior. `git diff --check` also passed.

## Reproduction artifacts

- Retrieval, source dossiers, schema probes and the old chapter's claim ledger: `.scratch/source-pipeline-2026-09-21/`.
- Final four-tier repair control: `.scratch/source-pipeline-2026-09-21/final/`.
- Full repository checks: `.scratch/source-pipeline-check.log`.

This follow-up uses a live chapter replay and four-tier repair controls. It does **not** represent four newly generated 20-page books or an independent factual certification of the prior exports.
