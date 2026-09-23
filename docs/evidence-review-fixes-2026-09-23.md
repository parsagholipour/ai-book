# Evidence review fixes — 23 September 2026

Implemented the six changes proposed for P2-02 of the [20-page token audit](./token-audit-20-pages-2026-09-22.md). The changes reduce repeated work and contain failures while retaining evidence requirements. They do not make unsupported book content verified by assumption.

## Changes

1. **Narrow schema tolerance.** A verdict explicitly labelled `insufficient_evidence` may omit `support`; the stored result normalizes it to `[]`. Supported and contradicted verdicts still require source quotations. Unknown source IDs, fabricated quotations, duplicate/missing verdicts, and incomplete inventory keep coverage incomplete. No provider summary becomes evidence.
2. **Independent inventory routing.** `inventory-chapter-claims` is a registered mechanical stage with its own model/fallback/effort controls and pipeline attribution. Until an operator saves that new stage, it inherits the existing `extract-excerpts` route. `review-chapter-evidence` retains its existing selection. The admin effort guidance includes the new stage. No saved routing revision was rewritten.
3. **Bounded chapter-local caching.** A reviewer session retains inventories keyed by exact manuscript content and inventory-prompt version. Adding evidence does not re-extract unchanged claims. Verification cache keys also include all verified evidence and verifier version; adding counterevidence or changing provenance invalidates verdicts. Only complete batches are cached. Any prose edit triggers a fresh inventory. Caches live only within one chapter-repair session and are capped at eight inventories and 64 batches.
4. **Grouped, bounded retrieval.** Inventory emits an optional shared source/topic label. Recovery prioritizes groups covering more unresolved assertions, searches at most three groups per round over two rounds, and continues to other unresolved groups even if a first round finds a passage. A shared 120-second deadline prevents starting further searches/fetches; in-flight search, extraction, and verification can finish after it. Successfully fetched documents are reused within a 24-entry session cache; failed fetches remain retryable. Each group can take at most two of the existing five document slots, and all grouped claim text helps rank source windows. Extraction and provenance checks remain mandatory.
5. **Independent verification batches.** At most 15 claims are sent in a verification batch. A failed batch preserves the successful batches. A later review retries uncached failed batches without repeating the successful ones. A response that omits or duplicates verdict IDs receives one targeted follow-up containing only those claims; successful verdicts already returned survive a failed follow-up. Each batch includes the chapter's verified passage corpus, so relevance filtering cannot silently remove counterevidence. The corpus remains bounded by dossier/recovery limits.
6. **Retrieval before repair; stop on no progress.** Only a complete review can authorize broad factual editing. Contradictions are actionable immediately; unsupported assertions become actionable only when a search for that exact inventoried assertion returned successfully. An unstarted/failed search or a later rewritten assertion does not inherit permission to remove content. Existing meaning/intent acceptance checks still decide whether an edit is kept. An unchanged, rejected, incomplete-reviewed, or non-improving repair ends the loop; a second repair is allowed only after actual improvement. Unresolved claims remain in publication QA. The shared arithmetic-repair loop also stops after a non-improving attempt.

Two additional bounded recovery paths came from the live replay:

- Invalid inventory quotations get one bounded operation to re-quote only the unresolved spans, at most 20 (a truncated response may widen once). The returned spans must occur exactly in the manuscript. This never promotes an inventory whose model declared it incomplete to complete.
- Cache-hit, batch-completeness, evidence-digest, retrieval-yield, searched-claim, deadline, and unresolved-group events are recorded through the existing run logger with chapter/project context.

## Validation

The original failures were reproduced before implementation: omitted support caused an otherwise usable review to fail; one failed batch discarded the chapter's successful verdicts; source supplementation needlessly re-inventoried unchanged text. Further red/green regressions cover bad inventory quotes and missing verdict IDs.

Tests cover routing independence, unchanged-text reuse, edited-text invalidation, evidence/provenance changes, added counterevidence, failed-batch retry, cancellation, exact-quote validation, grouping beyond the first two claims, bounded retrieval rounds, deadlines, document fetch reuse, retrieval stand-down, failure without deletion authorization, and no-progress stopping. Existing composed-book finalization and arithmetic tests exercise the changed shared paths.

Final `pnpm check`: **all seven gates passed** (typecheck, lint, file sizes, gotcha index, subpaths, subpath tests, and workspace tests). The workspace suites reported **7,838 tests passed / 6 skipped**. Earlier failed checks and their fixes are retained in the local evidence directory; the verified log below is the final run.

## Live checks and limits

Replayed the saved **first chapter from each tier**, without modifying the original books, database plans, or published exports. The first replay included inventory, batched verification, and real source recovery, but deliberately returned unchanged prose from the edit callback to measure evidence independently of claim deletion. It preceded the additional quote/omitted-verdict repair patches; those paths were subsequently checked separately against the saved results.

Inventory selections for this diagnostic were Quick `gpt-5-nano` low, Balanced `gpt-5.6-luna` none, and Premium `gpt-5.6-luna` low. Other stages used the audit's revision-57 selections, including Premium's **high** evidence-verifier effort. These diagnostic overrides were not saved as live settings.

| Initial chapter replay | Quick | Balanced | Premium |
| --- | ---: | ---: | ---: |
| Inventory output tokens | 2,521 | 1,404 | 2,299 |
| Inventory reasoning tokens | 704 | 0 | 43 |
| Inventory calls for unchanged chapter | 1 | 1 | 1 |
| Verification calls, including source supplements | 0 | 6 | 6 |
| Verification output tokens | 0 | 4,634 | 9,736 |
| Research calls | 5 | 6 | 3 |
| All replay calls | 8 | 25 | 14 |
| All output tokens, including research | 18,108 | 19,202 | 22,468 |
| Provider-call errors | 0 | 0 | 0 |
| Elapsed | 152s | 193s | 206s |

These are **single-chapter diagnostic measurements**, not whole-book before/after savings. Zero Quick verification calls means no verified passages were retrieved, not that its claims passed. Balanced's coverage increased from 5 to 7 supported assertions out of the same 24-item inventory during recovery. Premium's stayed at 9/45 despite new passages. Both initially had an unlocatable inventory quotation; Quick also declared its inventory incomplete.

The bounded re-quote check recovered Balanced's missing span in **44 output tokens** and Premium's in **143**, leaving both inventories complete. Quick recovered two spans in 1,060 output tokens but still had an unresolved span and an explicitly incomplete inventory, which stayed incomplete. Final reverification completed for Balanced (**6 supported / 24 checked**) and Premium (**9 / 46**), with no provider-call failures. Quick remained incomplete at **0 / 19**. These runs were independent of prose editing; verdict counts can vary across samples and must not be mistaken for increased factual accuracy.

An independently labelled fixture using the saved original Shannon paper, Diffie–Hellman paper, and RFC passages passed **8/8** live checks with Luna low inventory / high verification: four supported assertions, two deliberate contradictions, and two deliberate unsupported assertions. It consumed 557 inventory and 843 verification output tokens. This checks important failure modes, not all possible factual claims.

Remaining empirical limits are visible rather than hidden: Quick's source extractor returned no usable passages; some authoritative excerpts were rejected by the provenance reviewer; inventories can still be incomplete; supporting passages do not exist for every assertion within the bounded retrieval budget. These need broader source-quality/model calibration, not automatic promotion to a passing verdict. No full-book rerun or universal support-rate improvement is claimed.

## Files and evidence

Core behavior: `sourceClaimInventory.ts`, `sourceClaimReview.ts`, `dossier.ts`, stage routing/registry. Worker orchestration: `composedClaimReview.ts`, `sourceClaimRetrieval.ts`, `sourceDossier.ts`, `composedEvidenceRepair.ts`. Colocated tests cover the new paths.

Local evidence is under `/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/evidence-review-fix-2026-09-23/` (ignored by Git): red/green test logs, `replay-{tier}.json` and JSONL traces, replay results, `quote-repair-replay.json`, `final-verification-{tier}.json`, `gold-check.json`, and verification logs. Provider credentials are not included.

- [Live labelled checks](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/evidence-review-fix-2026-09-23/gold-check.json)
- [Balanced chapter replay](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/evidence-review-fix-2026-09-23/replay-balanced.json)
- [Premium chapter replay](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/evidence-review-fix-2026-09-23/replay-premium.json)
- [Repository verification log](/run/media/parsa/projects/ravanix-book/ai-book-maker/.scratch/evidence-review-fix-2026-09-23/pnpm-check-verified.log)
