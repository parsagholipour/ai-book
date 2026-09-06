# Live benchmark and blind Sol assessment — 5 September 2026

**No measured improvement yet. Both live generation attempts failed before drafting, so the new pipeline has no manuscript to score.** The twelve complete reference-book assessments are useful calibration; they do not establish the effect of the new implementation.

## Assessment design

Same source request, balanced tier, original 15-chapter/120-page approved plan as the coverage inventory, five fixed stance positions, and a designed cover. The new implementation may replan from the research. Quality settings are revision 48 (restored revision 37); the balanced writer remains `gpt-5.6-luna`, low effort. Sol performs the independent book and source-packet assessments. No global model or quality setting was changed.

Three fresh `gpt-5.6-sol` subagents read each of four complete old manuscripts, one manuscript per agent, in sequential bounded chunks. They received neutral manuscript IDs and the unchanged ten-criterion rubric, without past scores, arm labels, code, traces, other manuscripts, or web access. Scores are averaged within books, then equally across the three rung-5 replicate books. The original composed-7 book is a separate reference.

The validator checks manuscript hashes, word counts, all 15 chapter titles per reader, score ranges and arithmetic, and every quoted highlight/pattern against the assigned manuscript. One draft quote was corrected to exact manuscript wording without changing scores. Final validation: zero issues. This is a text-only literary assessment, not an external historical fact check.

## Same-session reference scores

| Book | Words | Reader A | Reader B | Reader C | Mean |
|---|---:|---:|---:|---:|---:|
| composed-7 | 52,884 | 7.2 | 7.8 | 8.0 | **7.67** |
| ladder-5a-apparatus | 56,471 | 7.8 | 7.0 | 7.0 | **7.27** |
| ladder-5b-apparatus | 52,939 | 7.8 | 7.1 | 6.8 | **7.23** |
| ladder-5c-apparatus | 59,472 | 6.9 | 7.2 | 7.1 | **7.07** |

The rung-5 baseline mean is **7.19**, against **7.67** for the original reference. None of the four three-reader book means exceeds 8. Individual reader means range from 6.8 to 8.0; readers of the same book differ by as much as 1.0 point. These are model judgments, not independent human-reader measurements, and the small spread among rung-5 book means does not remove judge uncertainty.

| Criterion | Original composed-7 | Rung-5 mean |
|---|---:|---:|
| Thesis | 9.00 | 8.78 |
| Structure | 8.00 | 8.00 |
| Depth | 8.67 | 8.11 |
| Reasoning/evidence | 8.33 | 7.22 |
| Clarity | 8.67 | 8.33 |
| Voice | 7.67 | 7.22 |
| Engagement | 7.67 | 7.33 |
| Pacing | 5.67 | 5.22 |
| Craft | 8.00 | 7.22 |
| Slop resistance | 5.00 | 4.44 |

All twelve readers identify repeated arguments or chapter moves as a weakness. The rung-5 summaries also repeatedly question the internal support for cinematic scene details. For example, J4 reader B flags “The knife entered below the ribs.” as a precise scene detail whose support the manuscript does not establish. This is a finding about the text's handling of evidence, not proof from external research that the event was invented.

The deterministic scorecards improve from the original to rung 5: couplets fall from 32.0 per 1,000 sentences to 5.6–11.2, and list sentences from 21.3% to 15.4–17.7%. Sol nevertheless rates the original higher. The improvement in those counts does not establish improvement in whole-book reading quality. The reference assessment reverses the ranking found in some previous Opus sittings; historical Opus numbers must not be subtracted from this Sol sitting as an implementation effect.

## Live generation

The first attempt failed before drafting. After bounded retrieval and replacement-case recovery, chapters 2, 3, 4, 5, 7, 8, 9, 10, 11, 14, and 15 had no accepted evidence packet. Four chapters had accepted reviews. The job spent 13.50 minutes and logged 77 text calls, with a provider cost estimate of $0.1234, producing zero pages. Nineteen JSON calls failed schema validation: eleven extraction calls and eight verification calls.

The test exposed a reproducible Archive.org download bug: the downloader guessed `<item-id>_djvu.txt`, while the Casement Report item actually advertises `caesement report_djvu.txt`. A narrowly scoped metadata fallback now finds that file; replaying the original live fetch retrieves 15,442 normalized words. Regression tests also cover missing, private, and dark OCR files. Evidence-call prompts now show the exact result fields to address missing claim `text` and JSON Schema returned instead of result data. Neither fix weakens evidence acceptance.

The retry also failed evidence readiness, in chapters **1, 6, 7, 8, 13, and 15**. It produced zero pages and never reached research-led replanning, drafting, developmental editing, or PDF compilation. All 77 JSON calls returned valid result objects, compared with 19 format failures in the first attempt. Nine chapters had accepted reviews, versus four initially. This is improved processing of evidence calls, not measured improvement in prose or independently verified source accuracy. The case/source selection also changed between runs, so the coverage difference cannot be attributed solely to the fixes.

| Attempt | Duration | Text calls | JSON errors | Chapters with accepted reviews | Pages | Provider cost estimate |
|---|---:|---:|---:|---:|---:|---:|
| Initial implementation | 13.50 min | 77 | 19 | 4/15 | 0 | $0.1234 |
| Revised retry | 13.85 min | 77 | 0 | 9/15 | 0 | $0.1283 |

Total recorded generation-provider estimate: **$0.2517**. These are per-job `ProviderCallLog.costHint` estimates, not invoices; they exclude the Sol subagent assessment usage and do not measure any unlogged service cost. The ordinary retry export combines project calls across attempts, so [per-job accounting](job-accounting.json) is authoritative for this table. Reused research caches also make elapsed times an imperfect controlled cost comparison.

The retry's final replacement cases had no retrieved passages for Tollense, Baghdad's fall, the court of Özbeg Khan, an enslaved African's Atlantic account, the Akayesu judgment, and the Peers Commission report. This does not establish that sources do not exist; it establishes that the current retrieval path did not supply usable passages within its budget. The backend searches Wikisource, Gutenberg, and eligible Archive.org texts, which is a limited fit for the full archaeological-to-contemporary coverage.

The two further planned new replicates were not launched, following the recorded amendment to stop multiplying coverage failures. The literary quality delta is **unavailable**, not zero and not a failed book's 0/10 score.

## Exploratory source audit

A separate Sol subagent checked a frozen convenience sample of eight accepted packets: four from the first attempt and the first four retry acceptances available at the time. Its initial audit was retained. A second adjudication clarified that episode metadata is a search hypothesis and a sequence may include only a subset of claims. Under those rules, Sol flagged four packets with substantive defects, two needing metadata correction only, and two without a found defect; one sequence-omission finding was withdrawn. Every quote in the adjudicated audit matches the supplied input.

These are one model reader's diagnostic findings, not a measured false-acceptance rate or an external historical fact check. The clearest mismatch is the proposed **Iroquois Mourning War**: its claims summarize a Colden biographical notice and a separate Brant alliance narrative, neither establishing mourning-war practices. A **Standard Inscription of Gudea** packet also relies on an incidental secondary reference that does not identify that particular inscription. The Socrates and Wannsee chronology findings should be retained for adjudication/replay; especially for a protocol, the order of reporting must be distinguished from the dates of the underlying events.

## What to fix before another quality comparison

1. **Let research inform replanning before enforcing one case per old chapter.** `prepareComposedDevelopment` calls `prepareVerifiedCases`, which throws for any original chapter without a packet, before `developBookPlan` runs. Return the supported material and explicit gaps to the planner; preserve requested topic coverage, then require valid support for the cases actually selected in the developed plan. Conceptual and synthesis chapters need appropriate evidence, but forcing a new episode into every old chapter defeats the proposed restructuring.
2. **Make source retrieval and case matching an explicit readiness test.** Extend retrieval to source collections suitable for the missing periods and documents, preserve retrieved passages and attribution, and replay these exact failures. A shared subject or author is insufficient to establish the specific case. Correct stale episode metadata when a supported replacement changes the source. Do not lower claim-entailment requirements to obtain a completed book.
3. **Calibrate the evidence reviewer on saved accepted and rejected packets before treating it as a factual guarantee.** Separate chronology, source identity, and individual unsupported claims so bounded repair can address the actual defect. Retain the Iroquois/Gudea mismatches and disputed sequence cases as evaluation fixtures. Once generation completes, run the originally planned three new replicates and fresh Sol readers against these fixed references. Until then, the benefits of replanning and whole-book editing remain unmeasured.

## Engineering checks

`pnpm check`: all 6,682 tests pass, five skipped. Core, worker, database, and web type checks pass. The overall check still fails on four API type errors, four oversized files, and two documentation-index mismatches outside this task's edits. The targeted primary-source/case-evidence suite passes 19 tests, and the original failed archive fetch was replayed successfully. See `check.log` for details.

## Reproduction and artifacts

- [Protocol](protocol.md), [manifest](manifest.json), [quality settings](quality-snapshot.json), and [initial source hashes](source-snapshot.json), and the [implementation under test](implementation-under-test.patch).
- [Machine-readable scores](summary.json), [rubric](rubric.md), and per-reader verdicts/coverage in `evals/`. Exact blinded manuscripts are in `blind/`.
- [Structural scorecards](structural-scorecards.txt): columns are composed-7, ladder-5a, ladder-5b, ladder-5c. These use standardized ~450-word windows, not rendered PDF pages.
- [Sol source audit](diagnostics/accepted-packets-sol-adjudication.json), its [original audit](diagnostics/accepted-packets-sol-audit.json), and the [frozen source input](diagnostics/accepted-packets-audit-input.json).
- [First attempt diagnostics](diagnostics/development-1a.json), [retry diagnostics](diagnostics/development-1a-retry.json), and [archive replay](diagnostics/replay-archive.ts).
- `python3 docs/composed-chapters/experiments/2026-09-05-sol/summarize.py` validates and recomputes scores.
- `python3 docs/composed-chapters/experiments/2026-09-05-sol/diagnose_runs.py` reconstructs per-job evidence diagnostics from local storage logs.
- `pnpm exec tsx docs/composed-chapters/experiments/2026-09-05-sol/capture_jobs.ts` reads final job state and per-job accounting from the development database.

Live job IDs and exports are preserved even when generation fails. A zero-page export is diagnostic output, never a scored book.
