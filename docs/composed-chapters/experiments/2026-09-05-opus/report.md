# Opus panel on the development pipeline — 5 September 2026

**The development pipeline (research-led planning, case evidence, developmental editing) made the book worse
by the only instrument the programme has trusted: the first completed book reads 5.90 against 7.82 for the three
rung-5 books and 7.73 for composed-7, all read by the same Opus panel in the same sitting.** The drop is not
noise (a three-reader book mean is ±0.4; replicates of one configuration spread up to 0.8): every one of the three
readers put the new book below every reader of every reference book, and all three name the same causes.

_One completed new-pipeline book was scored (development-fixes-1d). The two replicates re-run under the length-gate
fix (2a-retry-3, 3a-retry-3) were stopped by a user action at 08:19 UTC while polishing chapter 4 of 15; their 120
staged pages remain PENDING and a `retry` would resume them at the developmental edit._

## Design

Protocol in `protocol.md`, registered before any verdict. Three Opus readers (fresh Agent contexts, `model: opus`)
per book on the unchanged rubric `../../rubrics/blind-rubric.md`; every book — references included — was read in
this sitting, because the panel drifts by about 0.6 between sittings. Blinded manuscripts under `blind/<CODE>/`
(N2 composed-7, V2/V8/L7 rung 5a/5b/5c, P7 development-fixes-1d), verdicts and coverage under
`evals/<CODE>/{A,B,C}/`, validated by `summarize.py` (hash, word count, chapter list, score arithmetic, every
quoted highlight and pattern instance verbatim in the manuscript): zero issues. Tables from `tables.py`,
scorecards from `scorecards.py`.

## Scores (Opus, one sitting)

| Book | Arm | Words | Reader A | Reader B | Reader C | Mean | Engagement | Pacing | Slop res. |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| development-fixes-1d | new | 52,119 | 5.9 | 5.7 | 6.1 | **5.90** | 4.00 | 3.00 | 4.33 |
| ladder-5a-apparatus | baseline | 56,471 | 7.9 | 7.8 | 7.7 | **7.80** | 7.00 | 7.00 | 6.00 |
| ladder-5b-apparatus | baseline | 52,939 | 7.7 | 7.7 | 8.0 | **7.80** | 7.00 | 6.33 | 6.33 |
| ladder-5c-apparatus | baseline | 59,472 | 8.0 | 7.8 | 7.8 | **7.87** | 7.00 | 6.33 | 6.33 |
| composed-7 | reference | 52,884 | 7.6 | 7.7 | 7.9 | **7.73** | 6.33 | 6.00 | 6.33 |

| Criterion | new (1 book) | baseline (3 books) | reference (1 book) | new − baseline |
|---|---:|---:|---:|---:|
| **Overall** | 5.90 | 7.82 | 7.73 | **−1.92** |
| Thesis | 8.00 | 9.00 | 9.00 | −1.00 |
| Structure | 5.33 | 8.00 | 8.00 | −2.67 |
| Depth | 5.00 | 8.00 | 8.00 | −3.00 |
| Reasoning/evidence | 7.33 | 8.33 | 9.00 | −1.00 |
| Clarity | 8.00 | 8.89 | 9.00 | −0.89 |
| Voice | 7.33 | 8.11 | 7.67 | −0.78 |
| Engagement | 4.00 | 7.00 | 6.33 | −3.00 |
| Pacing | 3.00 | 6.56 | 6.00 | −3.56 |
| Craft | 6.67 | 8.11 | 8.00 | −1.44 |
| Slop resistance | 4.33 | 6.22 | 6.33 | −1.89 |

Readiness: the new book drew "Needs major revision" once and "Needs moderate revision" twice; every reference
book drew "Needs light revision" from every reader. Calibration: composed-7 read 7.73 on 2 September, 7.07 on
4 September and 7.73 today; rung 5 read 7.74 on 3 September and 7.82 today. The instrument sits where it sat in
the first two sittings, so today's references are the right comparison and the historical numbers agree with them.

## What the readers saw

All three readers open with the same two sentences: the thesis is unusually coherent and honoured through every
chapter (thesis 8, clarity 8), and then "the method eats the book." Their pattern lists (`evals/P7/*/verdict.json`)
name, independently:

1. **The evidence seesaw as the paragraph engine.** "Nearly every paragraph performs the same concede-and-withhold
   move" / "the negation-then-affirmation couplet … several times per page in every chapter" / "used hundreds of
   times." This is the case-evidence writer rule ("use only supported details … preserve who asserts a claim and
   its uncertainty") plus two rounds of evidence repair per chapter that each tell the writer to narrow or delete —
   the shape rule the ladder found is performed on schedule, now performed by the repair loop as well.
2. **The source packet leaking into the prose.** "The sequence before 1206 remains partly unspecified in the
   passages preserved here"; "no second independent early-state case has been placed beside it in a way that
   would support…" — reader B: "the book audits its own dossier on the page; this is scaffolding that should never
   have reached a reader." The chapter-development lines and the honestly-scoped coverage the replan accepted are
   being narrated.
3. **Whole-chapter duplication.** Chapter 7 (the research-gap "synthesis" chapter that inherits its prerequisites'
   packets under implementation-5) re-narrates chapter 6's Mongol material — genealogy, Temüjin's rise, Ögedei's
   post stations — "a structural duplication, not a callback." The developmental edit, whose stated job is
   "different chapters merely repeat an inference," did not remove it.
4. **The aphoristic paired closer** on every section and chapter, and **an obligatory backward comparison
   paragraph** measuring each case against an earlier chapter's — the callback contract, performed.
5. **Chapters ending on a formulaic unresolved question** — the "unknowns" of the packets, read out.

The deterministic scorecard says the same thing without a reader (`scorecards.py`):

| measure | development-fixes-1d | ladder-5a | ladder-5b | ladder-5c |
|---|---:|---:|---:|---:|
| couplets / 1000 sentences | **24.9** | 9.8 | 11.5 | 5.7 |
| negation-contrast / 1000 sentences | **34.4** | 23.0 | 22.9 | 24.2 |
| hedge-ending share | **0.151** | 0.083 | 0.073 | 0.085 |
| paragraph-length CV | **0.241** | 0.360 | 0.333 | 0.336 |
| list-sentence share | 0.126 | 0.168 | 0.154 | 0.177 |

The couplet count is back where the baseline before the couplet rewrite was (34–44), on a book that ran the couplet
rewrite: the evidence repairs, which run after it, write the pairs back in. Paragraph shapes are more uniform than
any rung-5 book.

## Live generation: what it took to get one book

Every launch is in `../2026-09-05-fixes/manifest.json`; the day's blockers and fixes in its `diagnostics-notes.md`.
Twelve attempts on three projects produced one completed book:

| Attempt | Implementation | Died at | Cause |
|---|---|---|---|
| 1a, 1a-retry, 1b, 2a | 1–4 | evidence readiness / developmental replan | coverage gates, thesis string compare, synthesis-chapter rule, model review objections (earlier session) |
| 1c | 5 | chapter 1, composition | fresh re-review after the repair found two new claims; the pass failed the book |
| 2a-retry | 5 | chapter 2, composition | reviewer misquoted a span; the guard failed the book |
| 3a | 5 | stopped | headed for the same wall |
| 3a-retry | 6 | developmental replan | schema-repair reply truncated at `max_output_tokens`; propagated as failure |
| **1d** | 6 | **completed, REVIEW_REQUIRED** | 52 min, 120 pages, 107 PDF pages, 51,977 words |
| 2a-retry-2, 3a-retry-2 | 6 | book-level length gate | 50,194 / 46,651 words against floors of 51,600 / 51,040; 120 pages staged, no repair |
| 2a-retry-3, 3a-retry-3 | 6b | stopped by user, 08:19 | developmental edit re-run with the extension fix; 120 pages staged each |

Fixes made during the test (all with tests; `pnpm check` result in `../2026-09-05-fixes/check-7.log`):

- **implementation-6** (the earlier session, with this one restoring its core contract after a collision): the
  chapter evidence review returns `{ issues, dropped }`, re-asks a misquote once and drops it; two targeted
  repairs, never a failed book; residuals recorded on the chapter and flagged `UNSUPPORTED_CASE_CLAIMS` at
  compile, which is why 1d finished REVIEW_REQUIRED.
- **implementation-6a** (this session): `generateJsonWithRetry` asks once more at 1.5× the budget when the
  provider cut the reply at `max_output_tokens`; `poppler-utils` added to the worker image, because every PDF
  source download today ended in `spawn pdftotext ENOENT` (takes effect at the next image build).
- **implementation-6b** (this session): the developmental edit's length gate develops the chapters furthest
  under budget instead of failing the job, and records any shortfall.
- **Admin**: the Generated books list and detail now include REVIEW_REQUIRED books (the list showed COMPLETE only),
  with a "needs review" note.

Cost of 1d across all four attempts on its project: 546 calls, $2.37, 148 provider-minutes; the completed attempt
alone made 59 chapter edits and 84 chapter evidence reviews for 15 chapters, against one edit per chapter at rung 5.

## Verdict

The three additions were built to move pacing and depth, the two criteria the ladder could not move. They moved
them the other way: pacing 6.56 → 3.00, depth 8.00 → 5.00, engagement 7.00 → 4.00. The mechanism is the one the
programme already wrote down — a rule about shape shown to the writer is performed on schedule — now applied by
a repair loop that rewrites every chapter two to four times with the same instruction, and by a synthesis chapter
that is handed its neighbours' material and told to add nothing. The evidence discipline itself is not the loss:
reasoning fell only one point and the readers praise the source criticism where the book stays with a document.

Recommendation: do not ship `bookDevelopment`, `caseEvidence` or `developmentalEdit` on any tier. Keep the
evidence packets as writer material (they are the particulars that bought rung 3's engagement) and drop the
post-edit review-repair loop; make the synthesis chapter a real chapter or none; keep the developmental edit's
duplicate-inference pass only if it can be shown to remove a duplication the readers found. Measure each on its
own, three replicates, same sitting, before the next composite.

## Artifacts

- `manifest.json` (codes, hashes, word counts), `summary.json` (validated means), `evals/`, `blind/`.
- `tables.py`, `scorecards.py`, `summarize.py`, `blind-books.py`.
- Books: `../../runs/development-fixes-1d/` (book, pages, trace, scorecard); launch record and logs in
  `../2026-09-05-fixes/`.
