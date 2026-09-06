# How we tried to get composed chapters past 8

A narrative of the work from 5–6 September 2026. The question was: after a long ladder of algorithm and prompt changes that plateaued around **7**, what would actually take a 120-page nonfiction book past **8** on the blind literary rubric?

The test book throughout is *Aggression Through Time*: English, 15 chapters, 120 pages, balanced-tier writer **gpt-5.6-luna** (low effort). Sol (`gpt-5.6-sol`) is the independent reader, not the writer. Scores are equal-weight means of ten criteria. A single book averaging **8.0** across three fresh Sol readers was later set as a stop rule; no completed book has met it.

Detailed artifacts live under `experiments/`. This file is the story, not the ledger.

## Where we started

The shipped configuration (commit `2984fe4`, quality revision 37, later restored as revision 49 for these runs) already had creative contract, material-first dossiers, couplet rewrite, and chapter apparatus. On the original Opus instrument that work moved the panel from about **7.46** to about **7.74**. Engagement and pacing barely moved. Re-reads of the same manuscript drifted by ~0.6 between sittings, so “7” was never a hard ceiling — but neither was it a solved book.

A later same-day Sol sitting of the old books scored:

| Book | Sol mean |
|---|---:|
| Original composed-7 | **7.67** |
| Rung-5 A / B / C | 7.27 / 7.23 / 7.07 (**7.19** average) |

Pacing and repeated rhetorical patterns were the weak criteria. Historical Opus numbers must not be subtracted from Sol numbers as an implementation effect.

## The first diagnosis

Reading the ladder reports, traces, and chapter samples pointed away from more prose polish. Three constraints stood out:

1. **The “book arc” never redesigned the book.** The planner was required to keep every title and order. Later chapters kept confirming “institutions shape violence” instead of changing what the reader knew.
2. **Vividness outran evidence.** The best Chapter 8 sample had two dossier documents and **zero extracted passages**, then still wrote a detailed Zong scene — and reversed the 1783 verdict (the jury found for the shipowners, not the insurers). The literary rubric does not fact-check, so that error could sit next to a high score.
3. **The manuscript editor could not restructure.** It was told not to flag what needed rewriting. Cuts were often limited to a chapter tail; short chapters were padded. A chapter that spent half its length proving something already established could not be fixed that way.

The recommended next experiment was therefore: rebuild argument and evidence *before* another round of sentence optimization. Four conditions (existing vs unrestricted planning × current research vs verified evidence packets), then calibrate “8” against published passages and other books.

The user said: **apply 1–3**.

## What was built (then disabled)

On 5 September the pipeline gained three optional stages:

1. **Research-led replanning** — chapters may merge, split, reorder, and change length while keeping requested coverage.
2. **Case evidence packets** — documented sequence, passages, disagreements, unknowns; unsupported cases get bounded research or replacement; drafting is supposed to stop if the packet cannot support the treatment.
3. **Developmental editing** — bounded section cuts, moves, and rewrites against a whole-book word budget, before the final line edit.

They were wired into quality gates, persisted on the plan for resume, and covered with regression tests. Retrieval still used public-domain catalogues (Wikisource, Gutenberg, Archive.org). Insufficient evidence was meant to fail the job rather than invent prose.

Those three gates are **off by default on every tier** (live quality revision 49). They remain in the code as explicit opt-in. Do not treat them as the current product path.

## First live test: no manuscript at all

The first two generation attempts never drafted a page.

- Attempt 1: **11 of 15** chapters lacked accepted evidence packets. Nineteen JSON schema failures. An Archive.org bug guessed `<item-id>_djvu.txt` while the Casement Report’s OCR file was `caesement report_djvu.txt`.
- After that filename fix and clearer JSON contracts: **0** format failures, **9/15** chapters accepted — then still **6/15** missing. Zero pages.

A deeper implementation bug: **every old outline chapter had to have a verified case before replanning could run.** Research gaps could not change the book structure. Sol also audited accepted packets and found cases whose passages did not establish the proposed event (e.g. an “Iroquois Mourning War” packet built from a Colden biography and a Brant alliance).

Literary delta: **unavailable**, not zero. We had no new book to score.

## Fixes, then a finished book that got worse

Follow-up work (5 September) removed the old-chapter readiness block, broadened retrieval to actual HTML/text/PDF (never search summaries), separated case identity from incidental biography, and required short verbatim anchors. Unrelated API type errors, oversized files, and documentation-index mismatches were cleaned so `pnpm check` passed.

New bugs appeared in live runs:

- A source-download **timeout was treated as cancelling the whole book**, which restarted research.
- Reviewer quotes sometimes failed exact matching and discarded valid packets.
- Developmental edit applied **zero structural groups** because one overlapping range rejected the entire proposal.
- Recovery started treating coverage/progression objections as review notes so generation could finish.

The completed book (`cmtnwyp3d0000fwg07qgd68uo`, development-fixes-1d) was scored **6.5** by one fresh Sol reader (pacing **4**, slop resistance **4**), against the same-session rung-5 mean of **7.19**. An independent Opus sitting of that book read **5.90** against **7.82** for rung-5. Cost of the successful attempt: **~52 minutes, $1.60** logged provider calls (~3.8× a rung-5 book); **$2.37** including retries on that project. The run made **82 evidence reviews and 58 chapter edits**.

The prose spent its length explaining what the source packets could not establish. Chapters 6 and 7 both retold Temüjin. The opening called Domesday (1085) “a generation before” Morgan (1851). The book’s voice became the pipeline’s limitations.

Those three gates were disabled. Remaining experimental jobs were stopped. Retrieval and infrastructure fixes were kept.

## What was actually wrong in that book

Sol’s split on the trash manuscript was the useful signal: thesis, reasoning, and clarity at **8**; pacing and slop at **4**; engagement and voice at **6**. Making the book more cautious was never going to fix the weak criteria.

Priority of defects:

1. **Research too thin for the chapter’s promise.** “Industrial War and the Civilian Population” stretched a short Armenian-deportation account and then explained that it could not establish industrial machinery. Word targets turned one excerpt into thousands of words.
2. **Chapters repeated cases instead of progressing.** Same genealogy, hardship, rise, postal scheme, fragmentation — twice.
3. **Retrieval limits became style.** Observation → distinction → caveat → unresolved question, until a heading could literally be “the Limits of the Supplied Record.”
4. **Added machinery failed its job.** Zero structural edits applied; connective chronology still wrong.

## Local proof that cutting duplication can help

A parent-specified offline edit of Chapters 6–7 (Lindisfarne stays in 6; Mongol material in 7; no new research; length allowed to fall) was built mechanically and compared blindly.

| | Original excerpt | Edited draft |
|---|---:|---:|
| Overall | 6.6 | **8.2** |
| Pacing | 3.5 | **9.0** |
| Slop resistance | 5.0 | **8.5** |
| Depth | **9.0** | 7.5 |

Both Sol readers preferred the cut. Depth fell; they caught a lost distinction (conquest as sudden force vs administration as repeated arrival). Three short restorations were put back and accepted in a nonblind follow-up. Final excerpt: **2,136 words vs 5,811 (63% shorter)**.

This is an **upper bound on editorial value** on a known weak pair of chapters. It is not a whole-book 8, and it does not show that the automated editor can do the same thing.

## Automated editor: cheaper, still not trusted

The developmental editor was then repaired so that:

- valid groups survive a bad neighbor
- pure deletions need no rewrite call
- unchanged chapters skip downstream polish
- cuts are not refilled with generated filler
- extractive mode copies existing paragraphs only

Four Luna planning replays cost about **$0.085**. Results:

| Excerpt | Original | Edited | Note |
|---|---:|---:|---|
| Weak book (length floor bypassed) | 6.75 | 7.6 | Better pacing; lost details; would violate the real 51,600-word minimum (only **463** words of room) |
| Older composed-7 control | **8.4** | 8.3 | Cuts removed real reasoning the planner called “recap” |

Narrowed to cross-chapter case duplication, the editor left the strong book alone and again blocked the weak cut on length. Stage stays **disabled**. The constraint is structural: you cannot delete thousands of repetitive words from a book sitting on its page floor unless you replace them with new substance.

## Sequential whole books (one at a time, Luna only)

User instruction after the regression: keep going until one book averages **8+**; generate **one book at a time**; Fable 5.1 implements bounded changes; parent designs and verifies; **Luna writes, Sol assesses**.

| Candidate | Change | Sol mean | What happened |
|---|---|---:|---|
| **1** material-routing-1 | Form planner finally receives the chosen episodes; writers see other chapters’ reserved cases | **7.1** (7.0 / 7.1 / 7.2) | Chapter 6/7 Mongol duplication **gone**. Structure/depth 8; pacing 5; slop 4. Magdeburg and Maji Maji scenes had **no excerpts** but ~750 words each. Cajamarca excerpts were about the wrong Inca material. ~23 min, ~$0.39 generation/export |
| **2** chapter-focus-2 | Each chapter gets a question; scenes need excerpts; skip or stay short if unsupported | **6.87** (6.7 / 6.8 / 7.1) | Worse. Fixed “three cases per chapter” made the architecture more uniform: cases → caveats → recap. 45 episodes vs 30. No separate scene calls (execution win, not a literary win) |
| **3** material-progression-3 | Drop equal case treatment, section-form quotas, and paragraph-shape targets on focused chapters | **7.03** (6.8 / 7.6 / 6.7) | Quotas gone from live prompts; method survived. Reused outline still demands bounded conclusions, competing interpretations, and eight pages a chapter. 33 cases, still fairly even |
| **4** fresh-plan-4 | New Luna plan from the original brief (no reused outline) | — | **Stopped at 0 pages.** Luna wrote 14 specific historical chapters nested under `authorStance`. The parser discarded them, substituted generic fallback chapters, and the critic merged those into a **48-page “Opening.”** Confirmed parse bug; repair specified, not yet the next scored book |

Candidates 1–3 used the old approved 15×8-page outline as coverage inventory. Candidate 4 was the first attempt to let planning allocate length and subjects. It never reached prose.

## What we believe now

**Pacing and formula, not thesis, are the ceiling.** Across old rung-5 books, the disabled-pipeline book, and candidates 1–3, readers keep naming the same experience: repeated institutional conclusions, recap endings, and (when evidence gates are on) the packet’s limitations leaking into the voice.

**Wiring cases to the right chapter is necessary and insufficient.** Candidate 1 proved we can stop two chapters telling the same Mongol story. The book still taught the same lesson fifteen times.

**The reused outline is load-bearing.** It asks for a survey and then encodes a single method (distinctions, competing interpretations, bounded conclusions, equal chapter length). Prompting chapters with different questions does not override that.

**Evidence as a post-draft tribunal made the book worse.** Thin research plus a word target plus “do not invent” produces caveat loops. Uncertainty belongs where it changes the conclusion; it should not be the chapter’s subject. Grounding scenes on actual excerpts (or skipping them) is still the right local rule.

**Compression helps only if length can fall or new material fills the hole.** Manual 6–7 cut: 8.2 on the excerpt. Automated cut on the real book: blocked by the 120-page floor. Getting past 8 on a *full-length* book needs richer, chapter-specific explanation at the same length — or an honest shorter book, which this product does not currently sell.

**Passing tests is not passing 8.** Repository checks stayed green through most of this. The literary instrument did not.

## Current production posture

- Balanced writer: Luna, low effort. Do not route writing to Sol.
- Quality revision **49**: `bookDevelopment`, `caseEvidence`, `developmentalEdit` **off**.
- Still on: creative contract, material-first, couplet rewrite, chapter apparatus (the rung-5 set).
- Keep: Archive OCR-filename lookup, source fetch that does not treat its own timeout as job cancellation, episode assignments reaching the form planner, chapter focus fields (candidates 2–3), extractive developmental-edit mechanics (disabled as a live stage).
- Open: recover authored chapters nested under `authorStance` so a fresh plan cannot silently become a generic fallback (see `experiments/2026-09-05-whole-book/plan-recovery-diagnosis.md`). Until that lands, do not launch another “fresh plan” book.

## If we continue

1. Fix the plan parser against the saved candidate-4 response (fourteen authored chapters must survive). That is a bugfix, not a quality claim.
2. Generate **one** Luna book from a recovered fresh plan. Assess with three Sol readers. Stop if the mean is ≥ 8.0.
3. If it misses, do not add another review loop. Inspect whether the new outline actually varies length and question, and whether chapters still close on the same institutional sentence. The next lever is **what the plan asks the book to be**, then **whether each chapter’s material can answer its own question at the allotted length** — not more post-processing.

The 6–7 repair pair remains a useful fixture: any automated editor that claims to help must find that duplication, keep the mechanisms readers flagged, and not refill the cut.

## Where to read more

| Topic | File |
|---|---|
| Shipped ladder and how to read scores | [README.md](README.md) |
| Original 1–3 design | [development-pipeline-2026-09-05.md](development-pipeline-2026-09-05.md) |
| First Sol sitting; failed evidence readiness | [experiments/2026-09-05-sol/report.md](experiments/2026-09-05-sol/report.md) |
| Completed-book regression and rollback | [experiments/2026-09-05-fixes/regression-decision.md](experiments/2026-09-05-fixes/regression-decision.md) |
| Manual Chapters 6–7 cut | [experiments/2026-09-05-chapter-repair/report.md](experiments/2026-09-05-chapter-repair/report.md) |
| Automated extractive editor | [experiments/2026-09-05-automated-repair/report.md](experiments/2026-09-05-automated-repair/report.md) |
| Whole-book candidates 1–4 | [experiments/2026-09-05-whole-book/report.md](experiments/2026-09-05-whole-book/report.md) |
| Fresh-plan parse bug | [experiments/2026-09-05-whole-book/plan-recovery-diagnosis.md](experiments/2026-09-05-whole-book/plan-recovery-diagnosis.md) |
| Blind rubric | [rubrics/blind-rubric.md](rubrics/blind-rubric.md) |

## Continued the same day: candidates 5 and 6 on the Opus panel

Full record in [experiments/2026-09-06-fresh-plan/report.md](experiments/2026-09-06-fresh-plan/report.md).
Assessors this time were three fresh Opus readers a book, with rung 5 and candidate 3 re-read in the same sitting
(Opus reads about half a point above Sol, so compare within the sitting).

| Book | Opus mean | Engagement | Pacing |
|---|---:|---:|---:|
| ladder-5a-apparatus (rung 5, control) | **7.63** | 7.00 | 6.00 |
| material-progression-3 (candidate 3, control) | 7.10 | 5.33 | 5.33 |
| **5** fresh-plan-5 — parser fixed, fresh Luna plan, no other change | **6.87** (7.5 / 6.3 / 6.8) | 5.00 | 4.33 |
| **6** plan-contract-6 — plan contract, fresh Luna plan | **7.00** (6.7 / 6.9 / 7.4) | 5.33 | 5.00 |

1. **The parser bug is fixed** (chapters nested under `authorStance` are recovered; initial planning never
   inherits the fallback outline). Candidate 5's plan was properly authored with varied lengths, and the
   lengths reached the prose.
2. **Candidate 5's defects were assigned by the plan, and the contract removed them.** The episode planner's
   `focus.contribution` had been a distinction ("the reader can distinguish A from B") in 13 of 14 chapters — and
   in candidates 2 and 3 before it — three voice-guide method rules rode every chapter call, and Nataruk, Keeley
   and Nuremberg were planned into two or three chapters each. `planContract.ts` (detector calibrated on the
   stored plans, one episode-planner re-ask, deterministic clean-up, stance gate on a fresh run, method voice
   lines withheld from chapter prompts, one synthesis chapter) took candidate 6's first episode plan from 21
   flagged fields and 5 collisions to 2 and 1, then 1 and 0. Cost-neutral; checks green.
3. **What remains is the writer's own register and the reconstruction contract.** Candidate 6's readers name the
   same assert-then-retract sentence with nothing assigning it (negation contrasts ~42 per 1,000 sentences on the
   focused path against 23 at rung 5). Engagement 5–5.3 against rung 5's 7.0 tracks told scenes: rung 5a told
   eight and kept ten verbatim quotes; candidates 3, 5 and 6 told none and kept four to six, because the
   focused path's strict reconstruction rule needs supplied excerpts and the dossier reaches only 2–3 chapters
   of a fresh plan.

**Posture after this:** keep the parser fix and the plan contract; quality revision 49 unchanged; no candidate 7
launched. The next levers are decisions rather than bounded fixes: the balanced writer's register (a routing
choice), the reconstruction contract on the focused path (honest scenes at engagement 5, or reconstructed scenes
at engagement 7), and retrieval that reaches a fresh plan's episodes. The manuscript read keeps naming the recap
tails and its cut stays off.

**Later the same day, candidate 7b — 7.40 (7.6 / 7.7 / 6.9), committed as the working state.** Back on rung 5's
composition path (`chapterFocus` off), with the manuscript read's whole-chapter deletion cuts on (`manuscriptReadCuts`,
live revision 50) and the couplet rewrite broadened to the assert-then-retract, semicolon-retraction and
"without proving" forms. The rewrite removed those forms from the page (0.9 and 2.2 per 1,000 sentences against
4.6 and 10.6); only one told scene and one applied cut, because the planner chose documents over scenes and the
legacy draft sat at its length floor. Readers: paragraph-final disclaimers, "unresolved question" endings, a foil
repeated in four chapters, one thin chapter, two bad epigraphs. See the report's candidate-7b section.
