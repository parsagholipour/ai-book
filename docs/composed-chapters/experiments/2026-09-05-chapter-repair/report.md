# Chapter 6–7 repair: a positive local result with limits

The parent specified an offline structural edit; Claude Code Fable 5.1 xhigh supplied its reproducible builder; the parent checked the text; two fresh Sol agents compared anonymous excerpts in opposite reading orders. Both preferred the shortened version. Their equally weighted ten-criterion mean rose from **6.6 to 8.2**. This is a two-chapter comparison, not a whole-book score or a measured improvement to the generation algorithm.

## Blind results

| Reader/order | Original | Edited draft v1 | Preference |
|---|---:|---:|---|
| Reader 1: original first | 6.7 | 8.3 | Edited draft |
| Reader 2: edited first | 6.5 | 8.1 | Edited draft |
| Mean | **6.6** | **8.2** | Both prefer edited |

| Criterion | Original mean | Edited draft mean | Change |
| thesis | 8.0 | 8.0 | +0.0 |
| structure | 5.5 | 8.5 | +3.0 |
| depth | 9.0 | 7.5 | -1.5 |
| reasoning | 8.0 | 8.0 | +0.0 |
| clarity | 7.0 | 9.0 | +2.0 |
| voice | 7.0 | 8.0 | +1.0 |
| engagement | 6.0 | 7.5 | +1.5 |
| pacing | 3.5 | 9.0 | +5.5 |
| craft | 7.0 | 8.0 | +1.0 |
| slopResistance | 5.0 | 8.5 | +3.5 |

The useful signal is less repetition and clearer chapter progression. The adverse signal is a **depth decline from 9.0 to 7.5**. Both readers identified a substantive lost distinction between conquest as a sudden concentration of force and administration as repeated arrival. One also missed conditional explanations of post-conflict incorporation; the other missed illustrations of spatially and temporally uneven implementation. The first 24-item parent coverage inventory did not catch those explanatory losses. It was insufficient on its own.

## Final repair and verification

The initial edit reduced 5,811 words to 2,040. The parent restored the three explanations, using original language and preserving “might,” “remains unknown,” and “would depend.” The final [revised.md](revised.md) contains **2,136 words**, a **63.2% reduction**. Chapter 6 contains 726 words; Chapter 7 contains 1,410.

Both Sol agents subsequently accepted these exact amendments, reporting no remaining material losses or new problems from the cuts. This was a **nonblind follow-up with no new score**. The 8.2 score applies to [evaluated-v1/revised.md](evaluated-v1/revised.md), not to the amended text or the entire book. The final version therefore has positive amendment verification, not a fresh blind numerical rating.

The parent checked all quoted assessment evidence against the actual versions and recomputed all means; checked the final text against 27 retained contribution/uncertainty items; checked exact output against the edit specification; and verified the source manuscript hash was unchanged. All three restored passages preserve their original conditional status. Scanners report no banned-phrase hits, but soft cadence/readability/silhouette warnings remain. Seven preservation-scanner string warnings were adjudicated as removed duplicate fragments, a changed heading, or deleted author-invented slogans, not losses of historical evidence. The detailed adjudication is in [parent-audit.md](parent-audit.md).

The original source and production manuscript, settings, pipeline, and other chapters were not changed. This is a reviewable offline manuscript artifact. Full `pnpm check` passed all seven gates; see [check.log](check.log). Passing code checks does not validate literary quality.

## What this supports

Give repeated cases one primary home and retain a cross-chapter return only when it adds a distinct explanation. Cut recaps, repeated inventories, and repeated caveats without refilling their word budget. Preserve mechanisms and uncertainty through explicit comparison with the uncut text: editorial compression alone can accidentally remove depth.

The reduced material is still primarily close reading of sources. It has no new historical research, richer documented scenes, or newly established causal links. The book's broader research shortages and chronology error outside these chapters are not repaired. The brief Lachish reference depends on the earlier book context and was consequently a weakness for readers shown only these two chapters. Both assessors also found some operational inferences in the original retained postal discussion stronger than the quoted passage alone establishes.

A parent-specified edit to a known weak excerpt is an upper-bound demonstration of editorial value, not evidence that the disabled automated developmental editor can reliably identify or execute the same changes. It does not justify re-enabling the three experimental gates or launching another full book. The next algorithm experiment should test whether a bounded proposal can identify this duplication and preserve the mechanisms, with independent application of valid edit groups and a strict limit on paid passes. Retain this original/final pair as one example, not the whole evaluation set.

## Reproducibility and cost

- [original.md](original.md): untouched input excerpt.
- [edit-plan.json](edit-plan.json): parent-specified final operations and source block references.
- [build_revision.py](build_revision.py): Fable's mechanical builder; run with Python to reproduce the final text and provenance.
- [provenance.json](provenance.json), [changes.diff](changes.diff), [restorations.diff](restorations.diff): exact edit history and hashes.
- [assessment-summary.json](assessment-summary.json): independently checked scores and all material-loss findings.
- [evals/reader1/verdict.json](evals/reader1/verdict.json), [evals/reader2/verdict.json](evals/reader2/verdict.json): full blind results, with neutral packets and rubric retained beside them.
- [evals/reader1/amendments-verdict.json](evals/reader1/amendments-verdict.json), [evals/reader2/amendments-verdict.json](evals/reader2/amendments-verdict.json): nonblind amendment verification.

The CLI recorded the requested primary model `claude-fable-5-1` with `--effort xhigh`. It wrote the builder and reached the configured spending cap before executing it. The parent ran and verified the build without another Fable call. CLI-reported estimated cost was **$1.6376** (including $0.0012 of ancillary Haiku activity), and runtime was 119.6 seconds. This is editorial-tooling cost; Sol assessment usage is separate and no total dollar figure for those agents is available here. There were **no new book-generation calls or jobs**. See [delegation.json](delegation.json) for the actual model usage and termination status.
