# Book generation

The pipeline that turns a plan into a printed book: planner and pages, markdown assembly, the PDF
and EPUB renderers, covers, the browser pool, character reference sheets, and the export
provenance/temp-file machinery.

Most of this directory is only reachable from the worker, but it is *in core* because two processes
compile a book — the worker at the end of generation, and the API when it rebuilds a missing export
inline. Anything that decides how a book looks or what a file contains must live here, or the two
sides will disagree about the same book. That has happened: the citation map was duplicated once
and the same book's Sources list named Google or the publisher depending on which side rendered it.

## The invariants below are unusually load-bearing

This directory holds the code that produced most of this project's worst incidents — a password
file printed into a PDF, a Chromium leak that survived shutdown, a stylesheet bump that silently
re-typeset every book ever compiled. The rules are not style preferences; each one is an outage
that already happened.

Before changing anything that affects typesetting or page breaks, use the `verify-pdf-typography`
skill. Rendering the fixture corpus is the only way to see what a change does — `pdfDocument.test.ts`
asserting a sha256 is the alarm, not the check.

## Review stages earn their place

- **A review, edit or critic stays only where blind readers prefer the book with it; E4 removed
  the plan critic, form-plan repair, polish, best-of, the short-book reviews and the prose-arithmetic
  screen on every tier.** The owner's rule (Parsa, 2026-10-16): "If reviews/edits add only 5-10%
  improve or not improve at all, let's just disable them/get rid of them." Operationalised: a taste
  stage stays only if blind Opus readers prefer stage-on over stage-off across a representative
  sample of all books or chapters, with a decided-pair win share ≥ 60% and a Wilson 95% lower bound
  above 50%; a model defect screen stays only if it finds and fixes real reader-visible defects in
  at least 10% of books; deterministic code checks are not reviews and stay. Premium and Ultra are
  not exempt for being unmeasured on their models. The E4 audit
  (`.scratch/eval-data/reports/e4-review-audit.md`) measured, on stored Quick Draft and Balanced
  books: per-page polish 1/1/6 against the draft; the short-book reviews (grouped and per-page,
  compile review included) 7/19/2 and 3/7/7 against the draft; best-of 5/8/6 against its own
  candidate 0; the plan critic 2/3/8 downstream; the form-plan repair 4/4/9 downstream; the prose
  arithmetic screen fixed 0 of 48 books. Each removal deleted its code and moved its gate id to
  `REMOVED_QUALITY_FEATURE_IDS`; the entries below that describe them say what replaced them. The
  E5 sweep (`.scratch/eval-data/reports/e5-final-review-sweep.md`) finished the job: the page-map
  critic (`critiquePageMap` and its picture-book scene development) lost 5 wins / 7 ties / 6 losses
  over 41 logged short books — the whole book drafted from its patched map against the one drafted
  from the map it was handed — and was deleted with its gate; and the per-page review chain (model
  review, review-driven rewrites, Smart Unslop, the style audit and the story audit's page
  rejection) came off every page generation drafts on every tier, continuations, inserts and replans
  included, on E4's measurement of the same chain on the same writer. A reader's chat page rewrite is
  the only page still reviewed (→ `apps/worker/src/generation/CLAUDE.md`). Add a review stage back
  only with a measurement that clears the same bar.

## Reading the source of a cover

Read the cover's source through `coverArtSourceFor` (`coverSource.ts`), never `includeCover`
directly. That resolver is what keeps the quote, the dispatch gate and the handler agreeing, and
what lets rows written before the field existed price identically.

## Tests

Colocated. `pdf.test.ts` skips six cases when poppler-utils (`pdftotext`, `pdfinfo`, `pdffonts`,
`pdftoppm`) are absent; `browserProcess.test.ts` skips on win32; `exportTempSweep.test.ts` skips as
root. Both render test files must call `closeSharedBrowser()` in `afterAll` — a live `Browser`
holds the event loop open and vitest will never exit.

## Index

- [Composed chapters](#composed-chapters)
- [Case evidence](#case-evidence)
- [Page 1's opening contract](#page-1s-opening-contract)
- [Style contract routing](#style-contract-routing)
- [Repetition gates and the evidence ledger](#repetition-gates-and-the-evidence-ledger)
- [Whole-set edit adherence](#whole-set-edit-adherence)
- [Surgical page patches](#surgical-page-patches)
- [Page seams](#page-seams)
- [Best-of candidate sampling](#best-of-candidate-sampling) (removed 2026-10-16)
- [Covers](#covers)
- [PDF typesetting and the render transport](#pdf-typesetting-and-the-render-transport)
- [Export provenance and scratch files](#export-provenance-and-scratch-files)
- [Chapter apparatus](#chapter-apparatus)
- [Library characters](#library-characters)
- [Book series](#book-series)
- [Character reference selection](#character-reference-selection)

## Composed chapters

- **Pattern measurements never authorize editing or rejecting valid material.** The 6 September user request removed the coupled rewrite/disclaimer pass, automatic sentence deduplication and paragraph merging, and lexical plan enforcement. Episode overlap and focus counts are advisory; a valid stance and the voice guide survive unchanged. Use the contextual Luna editor and manuscript reader for editorial decisions. Preserve negation, causal relationships, scope, uncertainty and quotations. A cut's code checks verify its operation and hard word allowance, not its meaning. For this change's regressions and the next source-first experiment, read [heuristic removal](../../../../docs/composed-chapters/heuristic-removal-2026-09-06.md). Earlier experiments below describe historical configurations, not instructions to restore their heuristics.

- **For every long book but a picture book the chapter is the unit of composition, and a page is
  where the typesetter cut.** Two 120-page balanced books were blind-reviewed at 6.40 and 5.55/10
  on 2026-09-02 (`.scratch/composed-chapters/spec.md`). The phrase scanner found one and four
  candidates; the slop was shape: every page ran example → evidence limit → symmetrical
  qualification → bounded conclusion, 23–31% of sentences were 4+ item lists, and five page-shape
  signatures covered 76–78% of pages. That shape was *assigned* — every page brief carried a
  bounded `claim`, `evidenceAnchors` and an `endingPressure` landing sentence, and the reviewer
  rejected a page that developed the next page's reserved beat — then executed 120 times under ~25
  prohibition sentences. The gates added between the two books bought +0.85 at 717 calls against
  171, and every one of them is page-local or a literal phrase counter, so 120 individually approved
  pages of identical architecture pass. `composed-chapters` (`strategies/composed.ts`, the
  auto-router's choice for 12+ pages outside KIDS) composes a whole chapter in one prose call
  (`composeChapter`, `composedChapter.ts`) from an author stance — thesis, positions, refusals and a
  voice sample the writer imitates (`authorStance.ts`; the planner is asked for it, the pass
  generates one when a plan lacks it) — and a chapter form plan; no line edit follows (removed
  2026-10-16, below); `paginateChapterMarkdown` (`chapterPagination.ts`) cuts it into exactly the
  chapter's page count at paragraph boundaries, never inside a fence; `describeChapterPages`
  supplies each page's title, summary, continuity notes and, for illustration slots, its image
  prompt; where a revision still opts in (no tier by default since 2026-10-16) `readManuscript` reads the finished book once and
  returns notes, never prose, for at most ⌈chapters/3⌉ (≤6) chapters to cut. The compose and edit prompts carry no `antiAiRules`, no
  page brief, no evidence ledger and no reserved-beat rule, on purpose: the user's own prompt and
  the plan's `voiceGuide` ride along, the prohibition list does not. Each purpose uses its saved
  admin stage model and reasoning selection (`generationTextModelRouting.ts`); tier names never
  elevate effort. `describe-pages` has its own stage setting. Word budgets (`chapterWordBudget`) are sized so the printed book is as long as the
  pages paid for: the per-page prompts' 160–420 guidance produced ~490 words a page in practice.
- **A composed chapter has one landing, and variety is a property of the form plan, checked
  before any prose exists.** `planChapterForms` (`chapterForms.ts`) is one call for the whole
  book — so variety can be global — assigning each chapter its sections, each with a *form* from a
  writing-mode palette (a scene narrated in time, a close reading of one source, a catalogue that
  is allowed to read as a list, an open question left open, a quiet transition with no thesis…),
  a subject, the cases it alone owns, and one `landing` for the chapter's final paragraph.
  Sections are counted from the chapter's *words* (`chapterSectionCount.ts`:
  `sectionCountForPages(pages, words)`, the worker passing `chapterWordBudget(...).target` on
  each `ChapterFormRange`; the palettes live in `chapterFormPalette.ts`): no section averages
  more than `SECTION_ASK_WORDS` (600), the sustained stretch is 40% of a short chapter and at
  most `SUSTAINED_SECTION_WORDS` of a long one (`sustainedSectionShare`), and a chapter has at
  most `MAX_CHAPTER_SECTIONS` (12). See the delivery entry below for why.
  `compositionVarietyIssues` is the contract: no form over half a chapter or 40% of the book, no
  form following itself, no two chapters with the same sequence, no two consecutive chapters
  opening alike. A plan that breaks it is settled by `settleFormVariety` (forms, then positions) and never blocks; a
  provider failure drafts from the rotated fallback. **There is no repair call, on any tier, since
  2026-10-16** (E4, `.scratch/eval-data/reports/e4-review-audit.md`, and the `formPlanRepair` gate
  is in `REMOVED_QUALITY_FEATURE_IDS`): the call re-emitted the whole plan — new wording in 232 of
  299 Balanced chapters, ~54 s on the critical path — and chapters composed from the repaired plan
  lost to the same chapters composed from the rotation alone, 4 wins / 4 ties / 9 losses over 17
  Balanced books (toolkit books, planned by `planInstructionalForms`, were not replayed; Quick Draft
  had already planned them without it since 2026-09-30). The rotation never rewrites a landing, and
  landings never reach the writer (`compositionWriterLines`). The owner's rule (Parsa,
  2026-10-16): a review, edit or critic that improves books by 5–10% or not at all is removed, on
  every tier. A resumed run re-plans the remaining chapters against
  the `fixed` compositions the finished chapters stored. This is where a deterministic check on
  shape belongs — on the plan, where it is cheap and exact — not on the prose, where the 2026-09-02
  replay showed such rules fire on approved pages. `share` accepts any positive number and is
  renormalised, because models answer in percentages; a zero, negative or non-finite share is *no*
  share (the chapter is split evenly, as for a missing one), because refused it failed its section
  and so its whole chapter, which drafted from the keyBeat fallback (`chapterFormsShare.test.ts`).
- **A chapter's length is a property of its plan — its budget, its sections and its page count —
  never of the number the writer is asked for.** The 2026-09-19 evaluation
  (`docs/jev-balanced-100-evaluation-2026-09-19.md`): the Balanced writer's first drafts came in at
  55–104% of the aim, mean 74%, on both a 50-page and a 100-page book, and the 100-page science
  book printed 77 sheets. Three causes, each measured against the saved prompts with the live
  writer before the fix. (1) Asking for more moves nothing: with the aim alone raised (+15%) or the
  aim and every section's words scaled to the budget's max (×1.26), six chapters returned 53–86% of
  the *true* target, exactly as before — and 42–67% of what was asked. The writer's output is a
  property of the section: 430–650 words each whether asked for 440 or 1,235. So the form planner
  counts sections from the chapter's words (`SECTION_ASK_WORDS`) and caps the sustained stretch in
  words; five chapters re-planned that way gained ten points (77% against 67%). (2) The
  diagram-friendly budget (300/380/480 for SCIENCE, EDUCATION, HEALTH) had never been measured: the
  same typesetter prints ~496 words on a full science sheet, the same as any other prose, so 380 a
  page could print 88 of 100 even at full delivery. The budget is now the measured 430/570/640 for
  every adult category; a figure's room is `figureWords`. Scaling every signal of the budget
  together (sentence, sections and payload, ×1.26) did move the same five chapters to 82%, which is
  why the budget matters and a lone number does not. (3) One compose call has never returned more
  than ~4,700 words (7,410 asked came back at 4,667), so a chapter asking more is short by
  construction: the planner's chapter ceiling is `maxComposedChapterPages` — eight pages at 570 a
  page — instead of fourteen, and "what needs more pages is two chapters". Told so in words, the
  third 100-page book's planner still wrote three nine-page chapters, so the ceiling is also a
  guarantee: `normalizePlanPageTargets` takes `maxChapterPages` and `capChapterPages` moves the
  excess a page at a time to the longest chapter with room (the fives stay short), splitting the
  longest chapter in two only when the chapters cannot hold the book under the ceiling. The
  planner passes it for every book whose chapter is the unit of composition (`composesByChapter`,
  the same predicate the strategy router chooses by, in `compositionUnit.ts` so the router stays
  light); per-page books' chapters are storage and keep their plan. The retry floor is the
  recovery, not the lever (the line editor's extension was the other until the edit was removed,
  2026-10-16, and it never lengthened a chapter on average) — and since 2026-10-01 the retry,
  `editChapter`'s length guard and the compile's length gate all read a minimum at
  `LENGTH_FLOOR_SHARE` of it, measured as it prints (`printedLength.ts`; the calibration is in
  `apps/worker/src/generation/CLAUDE.md`).
- **Every rule about shape the writer or editor is shown is performed on schedule, and the blind
  panel names the performance; content assignments are the only lever that moved.** Twenty-one
  composed runs on 2026-09-02 (`.scratch/composed-chapters/spec.md`) hold the evidence. Three
  independent Opus readers score each book blind; three replicates of one configuration on one plan
  spread 0.67 (6.93–7.60), so a three-reader mean carries about ±0.4 and nothing under that is
  readable. The balanced writer sits at ~7.3 and every book gets the same five complaints — the
  "it shows X, not Y" couplet, the paired antithesis closer, one chapter architecture, the thesis
  restated per chapter, recap tails — whether the prompt bans them, measures them into the editor,
  rotates one stance position per chapter, cuts whole paragraphs the read named, hides the plan's
  distribution rules, or is stripped to stance + forms + budget. Measured and rejected, one change
  per run: position rotation (−1.0 with the stripped editor), the read-driven deletion-only cut
  (kept as `cutChapter` + `deletionOnlyResult`, off), best-of-2 with a cross-family judge (settled
  2 of 15 chapters; the judge never picks the panel's worse book but ties on most pairs under a
  one-point gap; its worker wiring was deleted on 2026-10-16 and `judgeChapterDrafts` stays), 480 against 520 words a page (7.32 vs 7.31), voiceGuide/continuityRules/promises
  out of the writer payload (7.08 vs 7.32). Reasoning effort on the writer does nothing (low /
  medium / high: 7.31 / 7.30 / 7.23). The writer *model* moves the panel — DeepSeek V4 Pro 7.67 and
  Gemini 3.7 Flash 7.57 with engagement 7 where luna gets 5–6 — and both under-fill the pages,
  DeepSeek with particulars it invented (`apps/worker/scripts/provenance-probe.ts`). The
  deterministic prose counters (`proseMeasurements.ts`, `pnpm scorecard`) do not track what the
  readers respond to and are diagnostics only. The harness is `scripts/dev-rerun-book.ts`
  (`run --reuse-plan <projectId> --tier <tier>`, `retry`, `resume`, `export`) with
  `scripts/dev-set-tier-writer.ts` for writer A/B through an appended quality revision and
  `scripts/dev-stop-project.ts` to stop a book.
- **The earlier plan contract is historical.** It reacted to the fresh-plan books' repeated "what the source can and cannot establish" assignments by re-asking on regex hits and pruning episodes with shared names. It measured 7.00, then later audit fixtures showed legitimate distinct events and cautious claims being removed. Those interventions are retired. Read the [fresh-plan report](../../../../docs/composed-chapters/experiments/2026-09-06-fresh-plan/report.md) for the measured configurations; the diagnostic helpers in `planContract.ts` have no authority to change a plan.

- **The brief's explicit asks and a guide's example people are content assignments of the form
  plan, made in its one call.** Blind readers kept finding a promised item missing — no question
  bank, no meeting cadence, a tracker or worksheet referred to and never printed — and example
  people who changed jobs between chapters ("Lena is an illustrator in chapter 1 and a translator
  in chapter 6"), in most of the 2026-09-30 Quick Draft books. Nothing assigned either: the
  coverage review found the missing item only after the book was written, and each chapter
  invented its own people. `planChapterForms` now takes `requirements` — the content, table and
  structure asks of the brief's inventory (`briefRequirementsForForms`, worker), each to be named
  by the one section that delivers it — and `exampleCast`: `"plan"` for an instructional or
  reference book asks for two to four people with one fixed role each (`EXAMPLE_CAST_RULE`,
  `exampleCastFrom`), a stored cast (`plan.exampleCast`, written by the worker) is handed back
  unchanged on a resume. The cast rides every return of the planner, the rotated and fallback
  ones included, and `exampleCastLines` gives it to the writer and the editor. Only surface
  consistency is asked for — a name keeps its job — which is all a reader notices.
- **A practical guide or a workbook is planned from what the reader walks away with, and only the
  reader's chosen book type takes that path.** Four editor reviews and sixteen blind trials of the
  2026-09-30/10-01 guides and workbooks scored them 4–5/10, and the prompts showed why: the history
  machinery ran on how-to books. `plan-episodes` returned *documents* ("GitLab Handbook, 1:1s"),
  the form plan's sections owned source titles, the writer was told a chapter "is built from the
  episodes … a person, a place, a date and a document", "do not invent dialogue" turned every
  script into a description of one, the reconstruction rule's "never present an invented person as
  a real one" printed "This is an illustrative scene, not a report of an actual meeting", and the
  plan's `continuityRules` ("label sample figures as illustrative", "keep tax guidance general",
  "do not imply one-on-ones replace formal reporting") rode into every chapter, so every chapter
  said them — the rule that a field present in every chapter is a template, again. The toolkit path
  (`instructionalBook.ts`, `instructionalPlanning.ts`) replaces the assignments, not the pipeline:
  `planResearchLeads` answers under `plan-episodes` with facts a sentence will use (kind `figure`
  or `document` only — an unknown kind parses as `scene`, and a scene opens its chapter through
  `composeScene`) and the one `setting` (country, currency, year) the rules belong to;
  `planInstructionalForms` answers under `plan-chapter-forms` with deliverable sections from
  `TOOLKIT_FORMS` — situation, script, tool, worksheet, decision-rule — each with a `###` `heading`
  and the requirement ids it `covers`, plus a cast introduced in one chapter each, `caveats` each
  homed in one chapter, a few fixed-fact `rules`, and for a workbook one `runningCase` of input
  figures with their year. Coverage of the brief is checked in code before any prose
  (`requirementCoverageIssues`; `homeUncoveredRequirements` places what is left — there is no repair call since 2026-10-16), `deliverableCarriesLength` moves a chapter's long share off a situation (asked in words, the
  planner still gave one 43% of its chapter), the deliverable forms are never rotated
  (`PINNED_FORMS`) and the toolkit plan is not rotated at all (an objection rotated into an exercise
  left its subject behind). The writer gets `bookRules` and its own chapter's `cautions` in place of
  `continuityRules`, research as `facts` rather than `episodes` with no `reservedCases`, the
  `TOOLKIT_LAYOUT_RULE` (headings, dialogue lines, tables of at most five columns printed once filled
  and once blank), `EXAMPLE_PEOPLE_RULE` in place of the reconstruction rule, a quotation rule that
  lets a script be the book's own words, and `TOOLKIT_EXEMPLAR` in place of the pump; the first
  blind panel on the prototype went 8/8 overall and 3/8 on pacing, so each figure, calculation and
  agreed outcome is *owned* by one section and a worksheet is printed exactly twice. Replayed three
  times on the same slots (one draw each, so read the range), a figure's restatements in the
  workbook's prose went from the prototype's 30 to 5, 0 and 15 in the pricing chapter and from 14 to
  11, 3 and 24 in the tax chapter; the guide chapters state almost no figures either way. The path
  is `usesToolkit`: the reader's `bookTypeChoice` is `practical_guide` or `workbook` (or `auto`
  resolved to one of those lanes) **and** the writing mode is instructional — never the category,
  which makes every Business book instructional, a history of Nokia included. `activeToolkit` is the
  only door to the compose and edit prompts, so a book planned before the toolkit existed composes
  exactly as it did, and `instructionalScope.test.ts` holds the prompts of history, fiction,
  children's and off-type Business books byte-identical with a toolkit handed in and without. At
  implementation the compose, edit, episode and form-plan prompts of seven such fixtures (reference
  and science included) were also built by the current tree and by the same tree with this change's
  hunks reversed, and matched byte for byte; a guide planned before the toolkit matched in its
  compose and edit prompts and differs, by design, in its episode planning. Tables and headings print taller than prose: a 13-column tracker put a 3-page workbook
  chapter at six sheets, which is why the column cap is in the palette. With it, every replayed
  chapter printed within its paid pages under `fitBookPdfPageCount`, the workbook's at the fitter's
  full compaction and the guide's where the old chapters sat; the whole-book fit is the full run's
  to measure. The length checks used to read a table as its cells' words alone, so a table-heavy
  chapter read as short while filling its pages; `printedWordCount` adds `TABLE_ROW_ROOM_WORDS` a
  row, the conservative fit to sixteen guides and workbooks rendered with and without their tables.
  `check-chapter-arithmetic` (removed 2026-10-16, see the next entry) ran on these chapters and missed "$53,400 × 92.35% = $49,329.90" in
  three of three replays: the model never proposed it, so code never saw it.
- **No model reads a chapter's prose arithmetic; only the delimited math is checked, by code.**
  `arithmeticFindings` (`arithmeticCheck.ts`) reads delimited math, so "from $800, after $1,200 rent
  and $110 electricity, only $290 remains" is outside it. A model screen read that prose from
  2026-09-30 (`proseArithmeticFindings`, purpose `check-chapter-arithmetic`, gate
  `proseArithmeticCheck`): a call per chapter with numbers proposed wrong results with their
  computation, `verifiedFinding` kept one only when `evaluateExpression` disagreed beyond rounding,
  and a second call had to confirm the sentence *meant* that computation before an edit was
  allowed. **It was removed on every tier on 2026-10-16** (E4,
  `.scratch/eval-data/reports/e4-review-audit.md`): over the 48 Quick Draft and Balanced books whose
  logs hold it (324 chapter checks, 19 proposals) it fixed a real error in **none** — code verified
  six findings in five books, four of them real (a workbook's tax estimate, a hash example's letter
  counts, a stated vote total, a monthly tax reserve), and the intent check refused all four, so
  each stayed in print as a review-only flag. A defect screen stays only if it finds and fixes
  real reader-visible defects in at least 10% of books (the owner's rule), and 0% — or 8% counting
  the unfixed real ones — is under it. `verifiedFinding` and `evaluateExpression` remain because
  `composedEvidenceResiduals` re-checks stored residuals with them; a stored `reviewOnly` residual
  still reads as `ARITHMETIC_REVIEW_REQUIRED`.
- **A book written from no source is a story, whatever its category and cue words said.**
  `inferWritingMode` reads `plan.authorStance.research` (`STANCE_RESEARCH_RULE`): `"none"` makes
  every mode but a children's book `narrative`. The category-and-cue-word guess had a fantasy novel
  about "the last era of a dying dynasty" (Custom) composed with the analytical palette — scene,
  argument, counterargument — after its stance had already said it was invented. The composed
  pass puts a stance it generates onto its in-memory plan so every later mode read sees it.
- **An opening scene's episode is taken back from the section and the material that also held
  it, or the chapter tells it twice.** `composeScene` tells one of a history chapter's episodes
  ahead of the chapter and the pass prints it first. The chapter was still assigned that episode
  three times: in `episodes` ("give each episode a real stretch"), in the form-plan section that
  owns it, and in that section's material — and the sentence telling the writer not to repeat the
  scene lost to all three, the way shape rules always lose to content assignments here. Blind
  readers named it in every round of 2026-09-30 ("the Ideal X voyage is told three times", "each
  scene opening is restated later in its chapter"), and measured on the stored books half to all
  of a scene's numbers came back later in the same chapter. The scene does not even sit over the
  first section: one plan put the voyage third, so the chapter opened on it, went back twenty
  years and told it again. `afterOpeningScene` (`composedSceneTold.ts`, applied in `composeChapter`
  and `editChapter`) finds the section that treats the told episode — 60% of the title's words in
  its subject and material — makes a `scene` or `portrait` there an `aftermath`, drops the
  material entries that name the episode, replaces the note with `sceneToldNote`, and removes the
  episode from `episodes`; the dossier stays whole, since a chapter whose passages all belong to
  that episode would otherwise compose under the no-passage rule. Replayed through old and new
  code over the eleven stored scene chapters, on identical inputs: the scene's numbers repeated
  in the body 51% → 17%, its names 62% → 38%, its five-word runs 4.1% → 1.1%, and the chapters
  ran 1,674 → 1,733 words. Only where the palette has an `aftermath` form, which is the
  analytical one: a narrative book's scenes are its sections (the Apollo 13 book's ran 480–580
  words and repeated a quarter of their numbers), so they are left as planned. The editor is told
  the same thing in one clause, as the second line of defence.
- **A nonfiction scene needs a passage of the record, and a fresh plan rarely has one; telling it anyway was
  measured and reverted.** `composeScene` returns before any call when the chapter's dossier holds no excerpt for
  the episode, so `readers-prescription-8` asked for scene episodes in eleven chapters, made two calls (both on an
  unrelated excerpt, both empty) and told none, while rung 5a, on the Wikisource-friendly old outline, told eight.
  `creative-scenes-9` let the creative contract tell a scene from what the record makes likely: six scenes, "the
  strongest writing in the book", engagement 6.0 → 6.33 — and 7.07 against 7.50 without them, because the scene
  → cases → coda shape became the chapter template again (rung 3's finding) and two chapters re-trod cases the
  collision rule cannot see (Ur-Nammu then Hammurabi share no proper noun). The excerpt gate stays; the lever on
  engagement for a fresh plan is retrieval that reaches its episodes, not a licence to reconstruct.
- **A catalogue search is waited for ten seconds and no longer, and a catalogue that keeps timing
  out is skipped, because a dossier's clock is its slowest host's.** `searchPrimarySources`
  (`primarySources.ts`) asks Wikisource, Gutendex and archive.org together and used to wait for
  all three. The third 100-page Balanced book (2026-09-19) spent 249 of its 1,633 seconds
  fetching four documents for two excerpts: Gutendex answered the unslashed `/books?` address with
  a 301 in 10–19 s and the slashed one in 21–30 s, while Wikisource took 0.5 s and archive.org
  1 s, so each episode search ran to the worker's 15 s request timeout — twice, once per hop. Now the
  address carries the slash, `boundedHostSearch` gives each catalogue `searchTimeoutMs` (10 s,
  twenty times the healthy hosts' latency; the request runs on and its answer is dropped),
  `outageAfterTimeouts` consecutive timeouts skip the catalogue for `outageSkipMs` (five minutes,
  the rest of the book), and one `dossier.search` log line per query records every host's outcome
  and latency. Web discovery is a model call with its own budget and is waited for whole. The
  bound covers a throttled host's queue wait, which is at most two other chapters' requests: three
  dossiers build at once, two seconds apart.
- **A dossier anchor is matched on the fold's word parts, and a search result titled by its domain
  has no title.** Two defects together refused most of every dossier in the 2026-09-30 Quick Draft
  runs. `tokenize` (`dossier.ts`) folded each whitespace word whole, and `foldQuoteText` turns
  punctuation inside a word into a space, so "Check-in" was one token `"check in"` while the
  model's anchor split into `check`, `in`: every anchor crossing a hyphen or an apostrophe
  ("that’s", "mission-oriented") was unmatchable, and the same miss hit window scoring. Each
  folded part is now its own token carrying the source word's span; replayed over the three books'
  115 returned anchors, 79 matched before and 112 after. Separately, Gemini grounding reports a
  result's domain ("irs.gov", "adobe.com") where a title belongs, and the provenance reviewer
  refused 25 of 76 verbatim official passages because that "title" did not match the page.
  `fetchPrimaryDocument` takes the page's own `og:title`/`<title>` when the search named only the
  site (`isSiteNameTitle`), and `reviewDossierProvenance` shows a domain-only title (a PDF, say) as
  no title rather than a claim to check. The writer, the epigraph and the Sources list read the
  same field, which is why a web title also loses the site name a page appends after a bar
  (`withoutSiteSuffix`): the creative contract tells the writer to name the document it quotes,
  and two books printed "The Truck Driver Who Reinvented Shipping | Working Knowledge reports…". The episode searches of one call run together (the throttle still spaces each
  catalogue) and the provenance reviews three at a time, because both used to run one after
  another in the dossier and again in every chapter's claim retrieval. The same day the provenance
  review itself was switched off (`DOSSIER_PROVENANCE_REVIEW`, with the worker's claim review —
  see `apps/worker/src/generation/CLAUDE.md`); the title and parallelism fixes stand for when it
  is switched back on.
- **A history writer is told who said a passage, never what it is called or where it lives, and
  states the rest as fact.** The 2026-09-30 history books narrated their sources instead of their
  subject — "The account at usda.gov says…", "according to *Port Newark: How Malcom McLean Changed
  the World*" twice in two paragraphs, "Mayo and Nohria report that…", "The voyage's recorded
  account ends with the ship's departure" — 23 "account"s in one 13k-word book. Hand-labelled over
  both books (`historySources.ts` has the counts), the causes were prompt and payload, never the
  research notes: the dossier entry carried `document` (a page title, or a PDF's bare domain) and
  `url`, the creative contract said "name the document", the scene call had the `document` but no
  `speaker` — every domain printed in four history books came from a scene — and the scene, the
  reconstruction rule and the shape rule all spoke of "the record" and "a short account", which came
  back verbatim. For `analytical-history` only (`writesHistorySources`; that is also SCIENCE,
  SOCIETY and BIOGRAPHY), `historySources.ts` swaps those lines and sends each passage as
  `{ id, source, text }` — `passageSource` is the speaker or author, a catalogue work's title, a
  four-digit year, and never a web page's title, a URL or a domain. The quote rule names who is
  worth quoting (a participant, an official, a witness, a newspaper of the day) because the first
  wording, "quote only a voice no paraphrase could match", stopped all quoting. The scene wording
  that also told the writer to stop "where the passages stop" returned empty scenes, so the one
  that shipped keeps the old sentence's shape. And `withoutUnfetchedReadings` turns a scene,
  portrait or close reading of an episode no passage came from into a `mechanism` without its
  document line: the form plan is made before the dossier, and the writer "read" the LDDC's annual
  reports it was assigned and never given. Every string is replayed as shipped; guides, workbooks,
  reference books and fiction are pinned unchanged by `historySources.test.ts`. What it costs is
  length — drafts lose their narration padding and take the length retry more often — and a
  two-passage scene that falls under the 80-word floor.
- **Only a history book is owed scenes, and the planner is never offered the shelved arc.** The
  episode planner's "at least half the chapters carry one scene" was measured on history books
  (rung 3, candidate 8) and applied to every non-narrative book on the unfocused path, so a
  freelancer's budgeting workbook got scenes starring a strike leader, a mayor and a governor,
  each then flagged as an unsupported claim; `planEpisodes` gives the quota to
  `analytical-history` alone and tells every other mode a scene is optional. And the initial
  planner's schema (`bookPlanModelOutputSchemaWithFallback`) offered `bookArc` as an optional
  field: the model filled it in on about 40% of plans, so those books alone ran the arc prompts
  `BOOK_ARC` keeps off — a one-on-one meetings guide was told "do not state the book's answer"
  and "a method chapter shows how a trace becomes a claim". It is omitted beside its stored
  siblings; revisions keep the full schema so a stored arc survives the merge.
- **Names and numbers do not prove that an edit preserves meaning.** Candidate 9's coupled rewrite garbled a clean sentence while preserving its anchors. The later audit also demonstrated polarity reversal. The rewrite and acceptance rules were removed; historical results remain in the experiment reports.

- **A composed chapter is printed as drafted: no line edit, and no review of one, on any tier or
  writing mode.** `editChapter` used to rewrite every composed chapter (741 calls in 20 days, 2,387
  output tokens and 15.7 s each), and Balanced then sent the original and the candidate whole to
  `review-chapter-edit-acceptance` at high effort (9–19k input, 23–31 s), which kept 39% of the
  edits. E2 (2026-10-16, `.scratch/eval-data/reports/e2-chapter-edit.md`) put today's edit against
  no edit before blind Opus readers, both orders, on 40 logged edits: fiction 6 wins, 11 ties, 13
  losses for the edit (32% of decided pairs, [15–54]) — one edit deleted "The ground had never
  agreed to stay there" and left the next line's "that disagreement" pointing at nothing — and
  nonfiction 15/26/9 (62% [43–79], three readers), a tie, and a stage that ties is deleted. Its one
  exception was exploratory, Quick Draft guides and workbooks at 8/1/1, where the edit had fixed
  sums that disagreed with their own tables; a confirmatory run on 48 fresh toolkit-era chapters
  (`.scratch/eval-data/reports/h2-instructional-confirm.md`) did not hold it. Quick Draft went
  1/7/16 (6% [1–27]): told to extend almost every draft, the editor added recaps and restatements
  of figures the chapter had already given, and dropped a worksheet table in 3 of 21 chapters.
  Balanced went 8/5/11 (42% [23–64]) even with the edit split into hunks and each judged on its own,
  the review E2 had found non-inferior to the whole-chapter one and keeping 58% of the editor's
  hunks against 37% (prototype unported, in `scripts/eval/variants/chapterEditHunks.ts` and
  `hunkAcceptance.ts`). One reader per order decided both, because no three-reader result could
  have reached the pre-registered bar. Each chapter saves one call on Quick Draft (12–19 s,
  1.7–2.8k output tokens) and two on Balanced (that plus the review), about 2–3 and 7–9 minutes of serial
  `finishChapter` time a ten-chapter book; most of it ran beside the next compose, so the wall
  clock gains mainly the last chapters' tail. Premium and Ultra write on other models and were
  not measured; they lost the edit with the rest by decision. What stays: `editChapter` as the
  repairs' editor —
  `repairChapterArithmetic` and the dormant evidence repair send it a `factualCorrection`, judged
  by `acceptsChapterEdit` against its computation or passages where `chapterEditAcceptance` is on —
  and `cutChapter` with its whole-span review. `chapterEditorPass` is retired, not deleted:
  revisions 73–75 list it on every tier, `qualityFeatureEnabled` answers false whatever they say,
  and the console lists it under Removed with these numbers. The editor prompt keeps its extension
  sentence (E2: without it the editor cut 6–7.5% and the floor refusals quadrupled), though a
  repair, which always passes `allowExtension: false`, never reaches that branch.
- **The chapter-edit gate is the contextual reviewer alone; the decision model that ran ahead of
  it was measured across four books and removed.** `acceptsChapterEdit`
  (`chapterEditAcceptance.ts`) sends the reviewer every byte — the whole original and candidate,
  the removed spans of a cut with their neighbours, the chapters a cut's notes cite — and its one
  JSON verdict (meaning, intent, and for a cut one `removedSpanReviews` entry per span) accepts or
  retains. Jev used to be asked first: a meaning question and an intent question, two confident
  passes accepting without the review, a confident regression vetoing. Across the four Balanced
  evaluations of 2026-09-19 (a 50-page and three 100-page books; `docs/jev-balanced-*.md`) that
  was 168 attempts on 69 comparisons, 87 of them failed (81 gateway 503s, three
  `max_tokens_exceeded`, two 240 s timeouts, one malformed answer), 66 reviews ran anyway, and it
  saved exactly one review. Its meaning screen passed every
  edit the reviewer went on to retain as a regression (five, three of them in a live replay, at
  0.76–0.96) and confirmed none the reviewer disputed; its only two vetoes were on a correct
  arithmetic repair (`2^{14} ≡ 5 (mod 19)` → 6, both repair rounds, 0.76–0.85), so the known-wrong
  statement shipped and `ARITHMETIC_ERRORS` blocked the book. The fitted view (the payload without
  the fields that grow with a chapter's position), the 80 KB whole-comparison budget, the
  meaning-before-intent ordering, the cut exclusion and the factual-correction referral were each
  a narrower cut of the same finding, and each was measured before the next; the gate is what was
  left when nothing Jev said could be acted on. What the reviewer reads beside a cut is the
  chapters the cut's notes cite (`citedChapters` in `chapterCutContext.ts`: a chapter number after
  the book language's word for chapter, or quoted opening words found in a chapter), not the whole
  book — eight cut reviews of the third book carried 270–288 KB of other chapters in 390–405 KB
  payloads, $0.21 of a $0.73 book, and every retained passage the reviewer cited lay in the chapter
  being cut or in the one the note named; scoped, the same eight payloads total 61% less. Notes
  that cite nothing recognisable keep every chapter in view. A factual correction reaches the
  reviewer with its evidence — a source passage, or an exact computation it is told it may redo —
  and only a repair caller may supply one; a deletion-only cut carries none. Since 2026-10-16 those
  are the gate's only two callers: there is no line edit to review (above).
- **A caveat is stated once, where it first matters, and the acceptance reviewer is told the rule
  the editor was.** Blind readers named hedging in 43 of 46 books and repetition in 41
  (2026-10-01), and the repetition was padding against the word minimum: "never state the same
  point twice" in the writer and the editor came back shorter and duller and lost 4 of 12 blind
  pairs, while `CAVEAT_ONCE_EDITOR_RULE` in place of "keep a caveat when it limits an inference; cut
  it only when the same limitation is already stated with the same scope and context" won 12 of 12
  — 8 non-fiction, and 4 fiction, where it follows the pacing sentence and barely moved the length.
  An editor rule that licenses a removal the reviewer's rubric would call lost meaning goes to the
  reviewer too, on exactly the calls the editor got it (`chapterEditAcceptanceSystem`: every line
  edit, never a deletion-only cut), the fact ledger's pattern; it keeps the exception, so a removed
  qualification that added a condition is still a regression. Replayed on the six blind-tested
  chapters with the shipped prompt, length guard and reviewer, the history edit the old guard
  discarded (0.885 of its minimum) now reaches print; judged three times per edit, the reviewer
  accepted 6 of 15 Balanced judgments on the new prompt and 5 of 15 on the old, none of its
  rejections was about a repeated caveat, and each of the five edits it judged drew both verdicts
  across the six sittings — what it still costs these edits is the reviewer's noise. The 12/12 was
  this rule against the old one inside the line edit, never the edit against no edit; that
  comparison removed the line edit (above), so since 2026-10-16 the editor rule reaches a chapter
  only through a repair's correction edit, and the reviewer's twin only through that edit's review.

- **A chapter's arithmetic is redone before it is judged, and a wrong number is a factual correction
  whose evidence is the computation.** `arithmeticFindings` (`arithmeticCheck.ts`) parses every
  `\(…\)`, `\[…\]`, `$$…$$` and `$…$` span for fully numeric statements — integer literals, `+ - ·
  ×`, implicit products, powers, `\gcd`, `\varphi`, `\bmod`, `\pmod` — and evaluates each relation
  in BigInt: `=` exactly, `\equiv` under the trailing `\pmod{n}`. Anything with a variable, a
  decimal, an inequality, an ellipsis or an unknown command is symbolic and skipped, because only a
  fully numeric statement can be wrong here. The 100-page Balanced cryptography book printed a
  worked RSA decryption with all four intermediate residues wrong (`128^2 ≡ 169 (mod 187)`; it is
  115) under a correct final answer, and no gate could see it: the editor preserves quantities, the
  acceptance judge compares meaning, local QA is lexical and the claim verifier reads research notes.
  Measured before shipping on 12,093 stored pages (88 numeric statements): five findings, all on
  that page, zero false positives. The worker puts each finding to the editor as
  `factualCorrection` with the exact computation in `computations`, which `acceptsChapterEdit`
  accepts as the evidence behind the correction (the judge may redo the arithmetic itself); the
  live replay of that chapter corrected all five lines in one edit, and the reviewer accepted it.
  **An equality is read under the moduli its section names before it is called wrong.** The
  second 100-page book wrote "with arithmetic modulo 23, one can calculate `5^2=2`, `5^3=10`,
  `5^4=4`" — the modulus stated once in prose, then left out of every statement it governs, as
  mathematical writing does — and the checker flagged all three and paid a repair round for
  correct prose; the last-round instruction ("replace every wrong number with the value given")
  would have had the editor print `5^2=25, 5^3=125, 5^4=625`, destroying the discrete-log
  example. So `arithmeticScope` collects every modulus a section names (`modulo 23`, `mod 23`,
  `\pmod{23}`, `\bmod 23`, `the modulus n = 187`; a section is the run under one heading, a
  headingless chapter is one section), a failing `=` is excused when it holds under a named
  modulus its right-hand side is a residue of (so `2^{10}=1000` is not excused by "addition
  modulo 2"), a bare `\equiv` is read under the same moduli, and a section that speaks of a
  modulus it never names has its failing equalities skipped: the checker may miss an error,
  never invent one. Re-measured on 12,193 stored pages (230 statements) and on both books'
  chapter drafts: the five real findings remain, the Shor sentence produces none.

- **A composed draft that is not prose is recomposed once and then fails the job; it is never
  edited, paginated and published.** The fast tier's writer returned 12,005 words of a rotating
  three-subject verb-chain with stray CJK tokens for one chapter (composed-13), the short-draft
  retry fires only under 0.7× the minimum, the line edit paraphrased the loop, every page rule
  passed, and the book published as COMPLETE at 2.8/10. `chapterDegeneracy`
  (`chapterIntegrity.ts`) refuses a draft on any of three measures calibrated on the 231 chapters
  of every run to that date — ≥40% of sentences opening on one three-word template repeated six
  or more times (0.58 there, ≤0.26 anywhere else, a deliberate anaphora), more than 1.8× the
  chapter's word maximum (2.8× there, ~1.3× at most elsewhere), more than forty characters of a
  script a Latin-script book is not written in (4 there, 0 elsewhere then; it was two until
  ladder-8 failed two paid books on a quoted Arabic and Greek word, 2026-09-04) — and the pass
  discards an edited chapter that trips it for the draft. The fake adapter's canned chapter opens
  every sentence on its turn number for this reason.
- **A word in a script the book is not written in is recomposed once, the cleaner draft is kept,
  and it never fails the job; a Latin-script book is held only to the fused shape.** E1c
  (2026-10-16, `.scratch/eval-data/reports/e1c-gemini-fiction.md`): gpt-6-luna put three Armenian
  words into a Persian chapter ("یک քայլ جلو آمد، բայց") and Gemini a Russian stem inside a
  Persian word ("покрыیده"); the production draft of that chapter had carried "չէم", which the
  line edit cleaned up until it was removed, and the forty-character rule above runs on Latin books
  only. `findScriptLeaks` (`scriptLeaks.ts`) takes a book's scripts from its language
  (`knownBookScript`, `prompting/script.ts`; a language it does not know is not checked) and allows
  Latin everywhere. Two shapes are leaks: **fused**, another script inside one word with the
  book's own or Latin letters, in any book; **inline**, in a non-Latin book, a word of two or more
  letters standing bare between two of the book's own words on a line, nothing but a space, comma
  or ZWNJ either side. Not leaks: a Greek run of up to three letters (φ(N), αˣ, *ulaγa*), the
  Arabic honorific ligatures (ﷺ), code, math, URLs, and any script the brief is written in or
  names the language of (a reader's Armenian name, a Persian primer of Russian). **Measured before
  it shipped**, over every stored page (18,059: 17,977 English, 39 Portuguese, 43 Persian) and
  every stored chapter draft and edit (5,663 from the run logs and the eval data, 28 Persian):
  4 page hits and 8 chapter hits, every one a real leak — commander傅作义, the索取, with绞合,
  allocation制度, sporadic征税, Ribاط-i Sharaf and E1c's three. The 31 other stored pages carrying a
  foreign letter were all legitimate (ﷺ, *ulaγa*, φ and α in RSA, one 元朝秘史). The inline shape
  on Latin books was measured and left out: it adds that 元朝秘史, quoted bare before its
  transliteration (4 of 5, 80%), to catch "a blunt удар" and "al-Aziz بالله" in two drafts; the
  E1c criterion's count (more than two letters of another script) flags 6 pages, 1 real. Known
  misses: those two, and a lone letter (ನು, and जाएगा inside math, both reasoning spilled into an
  English page). **The non-Latin sample is small and holds no legitimate foreign quote**, so the
  inline shape's precision on one is unmeasured; a word the writer sets off with quotes, brackets
  or emphasis passes. What it does: `chapterDegeneracy` reports `scriptLeaks` without calling the
  chapter `degenerate` — a wrong word is not "not prose" — and `guardComposedDraft` composes a
  leaked draft once more and keeps the one with fewer leaked words, because E1c's chapter leaked in
  three of five draws and failing a paid book over a second one is worse than printing it; a kept
  leak goes to the run log (`generation.composed_chapters.script_leak`). `editChapter` refuses an
  edit that brings in a leak the draft did not have (`addsScriptLeaks`). The page rule in
  `pagesLocalQa.ts` fails `promptLeakFree`, the integrity flag the composed finalize's revise,
  Quick Draft's compile repair, the per-page review loop and a chat patch all act on, and never on
  an author's manuscript. At compile a leak is a `FOREIGN_SCRIPT` warning on its page, for the
  console. Nothing is replaced in place: no measured leak was a homoglyph (покры is a Russian stem,
  the Armenian words mean step, but and high, the Han ones are words), so there is no exact mapping
  to apply.
- **The manuscript read returns notes, so a read that fails is a skipped read, never a failed
  book; and a provider's input filter refusing a chapter is a fallback, never a failed book.**
  Luna at effort high composed every chapter of composed-17 and then failed the whole book at the
  read on `max_output_tokens`, because reasoning shares the read's output budget: `readManuscript`
  now runs with 16k and degrades to `skipped` on any provider failure, with a cancellation still
  propagating. Alibaba answered a chapter about genocide with
  `400 data_inspection_failed: "Input text data may contain inappropriate content."`, a 400 was
  final, and a paid fast-tier book failed at 62% with a fallback writer configured that runs a
  different filter: `isProviderContentFilterError` (`adapters/retry.ts`) makes that a fallback.
  Research notes reach the writer as "title: summary" and a search hit's title is often its bare
  domain, so the writers are told never to name a website, domain or URL in prose. Since 2026-10-16
  the read runs on no tier by default: with its cuts it changed 0.75% of a Balanced book's
  words, under the owner's 5–10% bar for keeping a stage (→ apps/worker/src/generation/CLAUDE.md,
  "The manuscript read and its cuts run on no tier by default"). The compile's coverage read
  shares the `read-manuscript` purpose and is not this read.
- **Every chapter's research is its own, and the writer never says where a fact came from.**
  `expandChapterResearch` used to cap the query list and then the flattened result list at the same
  number, so a 15-chapter book searched 12 chapters and kept 12 sources — all from chapter 1's query —
  and every chapter's writer read the same twelve dictionary snippets while each search's own
  synthesised brief was dropped. It now searches every chapter, keeps `RESEARCH_SOURCES_PER_QUERY`
  sources per query and stores the brief as a URL-less "Research brief" row; the worker's
  `loadResearchNotesForGeneration` reads the whole project's rows when it has a chapter to match, ranks
  the chapter's own query first (its title is in the query), then the brief, then by shared terms, and
  hands the brief over untitled — titled, it was cited ("according to the research brief"), and
  "the figures supplied for this period" followed once the title went, so source-packet language is a
  page leak (`PAGE_PROMPT_LEAK_PATTERNS`) and both writers are told the phrases they may not use. On
  composed-7's plan the inputs fix and the plan-level assignments below moved six replicates to
  7.20–7.60 (mean 7.45) from 7.17–7.43 at the same cost. Section counts are *assigned* per chapter
  (`assignedSectionCount`, walking the range) because the planner asked to vary them returned four or
  five everywhere; `compositionShapeIssues` are advisory only (the repair call they fed was removed 2026-10-16), since `settleFormVariety` cannot change a count. Composed pages fail only the two integrity rules in the
  finalize review (`composedPageQualityReport`): a page is where the typesetter cut, and the dash rule
  was rewriting one cut per book in isolation. The prompt's stable block comes first and OpenAI calls
  carry a `prompt_cache_key`, correct for a prefix-caching provider; the gateway behind
  `gpt-5.6-luna` caches whole prompts only (measured), so no saving is claimed.
- **A sourced chapter's research notes are its leads' answers, and only a chapter without lead
  notes makes a chapter-research search.** H3b, 2026-10-16 (`.scratch/harness-redesign-2026-10-15/staging/H3b/`).
  A sourced composed book paid two grounded fan-outs per chapter: `expandChapterResearch`'s
  `chapter-research`, whose answer became the writer's brief and mostly missed the chapter's planned
  cases, and one `case-source-search` per dossier lead, whose answer was paid for and thrown away.
  On a book whose strategy expands research (`researchDepth`), `leadResearch.ts` keeps each lead's
  answer as that chapter's research: one URL-less "Research brief" row per lead, its text opened by
  the lead's title (the case, never a source) and stripped of every web address (the lead prompt
  asks for document URLs and half its answers print them), beside the sources it cited, all under
  `<chapter title>: <lead query>` so `loadResearchNotesForGeneration` ranks them as the chapter's
  own. The expansion then owes only `researchScopeBeyondLeads`: the chapters no lead answered for
  (5 of the 1,311 chapters of the 144 sourced books in the 45 days before had no planned leads, and
  a chapter given the stand-in episode counts as having none), and each plan research query that
  does not fold into a covered chapter (`researchQueriesByChapter`: three content words shared with
  its title and summary; a Balanced planner restated all eight of its chapters). The lead prompt is
  unchanged, so the dossier is too. Replayed on H3's four stored books (31 chapters, one draw):
  grounded prompts 117 → 76 (a 60-page Balanced book 41 → 27), primary documents 86 against 73/78
  for two draws of the old path, excerpts kept 150 against 169/157, no chapter without excerpts, and
  blind Opus readers preferred the writer's notes 30/1/0 over the old ones. The leak rules stand
  unchanged: the brief is handed over untitled, its opening names the case, and a truncated answer
  keeps its sources and drops its text. A book on the plain composed strategy (no `researchDepth`,
  56 of those 144) never expanded research and records no lead notes. The wiring is in
  `apps/worker/src/generation/CLAUDE.md`.
- **A quality gate names the pipelines it reaches, and the console shows a checkbox beside the
  books it changes.** Every `QUALITY_FEATURES` entry carries `pipelines` (`planning`, `per-page`,
  `composed`) and a `stage`; `pipelineStages.ts` lists each pipeline's stages with the provider
  purposes they spend under and the gates that switch them, and `autoStrategyRoutingMatrix` samples
  the real router per category and page band. `/api/admin/generation-quality` serves all three so
  the console groups the rows by pipeline instead of listing them per tier alone — a row toggled
  for a pipeline a tier's books never take used to change nothing and say nothing.
  `pipelineStages.test.ts` holds the two lists to each other: a gate that names a pipeline appears
  in one of that pipeline's stages, and a stage's gate names that pipeline. **A gate measured off on
  every tier is `shelved`, not offered per tier, and a gate with no reader is deleted, not
  retired.** Five are shelved (2026-10-16): `chapterFocus`, `bookDevelopment`, `caseEvidence`,
  `developmentalEdit` and `changedCandidateGrounding` (which rechecks a reader's chat page rewrite
  only), each `[]` in the compiled defaults and in revision 73. The console lists them in a group of their own with no
  tier boxes. `qualityFeatureEnabled` still reads a stored tier list for them, because a revision is
  how an experiment opts one in (`scripts/dev-set-quality.ts`), and the row shows any it finds.
  `chapterEditorPass` is the one gate retired rather than deleted (2026-10-16): its stage was
  removed by a measurement, every stored revision still lists it, and its row in the console's
  Removed group (`retired: true`, no tier boxes) says when and why, so that key reads as a decision
  rather than a lost switch. `coupletRewrite` (2026-09-06) and `planCritic`, `bestOfPolish`, `formPlanRepair` and `proseArithmeticCheck` (the E4 review audit, 2026-10-16, with their code), and `pageMapCritic` (measured, with its code), `beatDedup` (no reader: the collision rewrite is mandatory integrity), `claimVerifier` and `claimRetrieve` (shelved, their only reader the per-page review chain) (E5, the same day) were deleted from the table; a stored revision
  still carrying it parses (unknown ids are ignored), and the API neither serves it nor writes it
  into the next revision (`REMOVED_QUALITY_FEATURE_IDS`), because served as an unknown id the
  console would draw it as a newer server's gate.
- **A figure is a fenced block the compose call alone is shown, every later pass reads around, and
  the exporters draw.** A bar, line or pie chart, or a flow diagram of a procedure, travels through
  the manuscript as a ```` ```figure ```` block holding one line of JSON (`figures/figureSpec.ts`),
  and nothing about it is an image asset, an image prompt or an illustration slot — which is what
  keeps it off the per-image charge and the free-tier illustrated-book quota. The *decision* is the
  form plan's: `chapterSectionSchema.figure`, asked for only when `usesFigures`
  (`figures/figureEligibility.ts`: analytical, instructional and reference books, never KIDS) and
  the `figures` gate agree, and capped by `capFigures` to one a chapter and three chapters in four
  (`figureCapFor`) — a ceiling against a figure in every chapter, not a target: the first live book,
  on algorithms, got one figure in eight chapters under a rule that said most sections carry none,
  so the rule now invites a figure wherever the material is quantitative or procedural. The
  writer sees the syntax and one example, of the planned kind, only in a chapter that was given a
  figure (`figures/figurePrompt.ts`), so every other prompt in the book is byte-identical to a book
  without figures — the rerun loop's rule that a prompt field present in every chapter is a
  template. **Strings in a block are clipped, never refused**: that book's one figure was thrown
  away whole because its `unit` ran two characters past a limit; only the counts (series,
  categories, nodes, edges) and the magnitude of a value (`FIGURE_LIMITS.value`, 1e15) are hard
  limits, since truncating data would draw a different chart — a value that size belongs in a
  larger unit, and `Number.MAX_VALUE` used to parse as valid and round the axis end up to Infinity,
  which `niceTicks` looped on forever; the tick generator is bounded on its own now
  (`figureSvgShared.ts`), because the renderer is reachable with a spec built directly. A
  `scale: "log"` axis is there for values spanning orders of magnitude, which an operation-count
  chart needs, and falls back to linear over a value at or below zero; the renderer takes it on its
  own when the largest value is a thousand times the smallest, because the rerun's writer drew six
  decades on a linear axis and three of four series were flat. Ticks past ten thousand are compact
  (10K, 1M), the left margin follows the widest tick, and a unit longer than a sign gets a row of its
  own above the plot — the first rendered chart clipped every tick to "0,000,000". In a flow
  diagram, labels keep their words whole, a node's edges are spread along its side, an edge
  that skips a layer bows out past the column it would otherwise run through, `svgOpen` takes the
  sheet width rather than patching the viewBox string, and a chain taller than an A4 content block
  is capped (`MAX_FLOW_HEIGHT` 720) with nodes scaled to fit.   The same book tagged every
  code fence `text` and indented the rest, so highlight.js — which keys on the fence's language name
  — coloured nothing; `codeBlockRules` tells every writer of a book about code (`bookMentionsCode`,
  a cue over the prompt and plan) to tag real code with a language name and tag
  pseudocode as `pseudocode`, and the composed editor is told
  to return a draft's fences byte for byte. That prompt is not the lock: an 8-page algorithms book
  used the whole-book writer, which had never seen the rule, and still wrote `text`.
  `retagColorlessCodeFences` (`retagColorlessCodeFences.ts`) remaps only a colourless tag such as `text` or an empty tag whose body looks
  like code before the PDF and EPUB render, so colour does not depend on the model obeying; an
  explicit `pseudocode` fence stays plaintext. Every call after the compose reads a stand-in line or nothing
  (`figureStandInMarkdown`, `figureFreeProse` in `figures/figureBlocks.ts`) and the block goes back
  beside the paragraph it followed (`reinsertFigureFences`); that includes every prior-page excerpt
  a page prompt is shown (`compactPriorPages`, `pinStyleExcerpts` in `pagesShared.ts`; summaries in that compact go through `pageDraftSummary`) and every
  deterministic rule that reads a page (`pagesLocalQa.ts` reads the figure-free body throughout,
  the final page's ending included; `readerChapters.ts` strips the figure fence and only the figure
  fence, since a code listing is page text).   A per-page draft carries no figure and no stand-in
  from the moment it is parsed — `figureFreeDraft` in `generatePageDraft`, `revisePageDraft` and the tools writer — because only the compose call is ever shown the syntax
  and a strip at the end of a path leaves every review and revision between reading the invention;
  `RevisePageOptions.figures: "keep"` is the chat rewrite whose request names
  the figure, and `figures: "hold"` is the holdFiguresAside path (unnamed chat rewrite, final-QA
  repair): strip invented fences, keep `[Figure: …]` stand-ins so later revises and reviews still
  see the stand-in. Absent, `revisePageDraft` still returns `figureFreeDraft`. And *names* is `mentionsFigure` (`figures/figureMentions.ts`), biased toward precision because a miss keeps the
  block aside and puts it back unchanged (the chat can re-ask) while a false hit hands the model the
  JSON and lets it change or drop a figure nobody asked about. The free exact-replacement walk copies
  fences byte for byte. **The Quick Draft compile screen reads the blocks as stored, and its repair is
  shown one only where a finding is about it** — a quote inside the block, or a target finding that
  names the chart — and may then patch the JSON, the prose around it, or remove the block, never add
  one; `checkQuickDraftFigurePatch` (`quickDraftRepairScope.ts`) refuses a block that no longer
  parses, changes kind or carries a number found neither in the block nor in the page's prose, and
  holds every other figure byte for byte (→ `apps/worker/src/handlers/CLAUDE.md`, "Quick Draft reads
  its book once"). A word that names a chart and nothing
  else fires alone (chart, graph, diagram, flowchart, infographic, histogram, and the qualified chart
  vocabulary: axis labels, tick labels, legend entries, data series); "figure" and "graphic" fire
  only as the head of an artifact phrase — a determiner, then the end of the text or a sentence, or
  a **whitelisted** continuation (as, into, smaller, on page…) — never by a blacklist of person
  continuations, since "this figure skating passage" walked through one and "this figure, a man in
  grey" is an appositive; "plot", "legend", "axis", شکل, 图, 図 and график count only qualified,
  because each is a story, a myth, an axle, a shape, a map or a schedule first.   With the page's own
  specs (`pageFigureSpecs`) a request that quotes a figure's title as a whole phrase of three or
  more characters counts too — a substring of a longer word does not, so "regrowth" is not a name for a figure titled "Growth"; its
  categories and series names never do, since "describe 1950 more vividly" is about the prose.
  European chart words are bounded by Unicode letters, so "photographique" does not name a
  graphique. An opener with no closer, or with an info string after the tag, is still a figure
  attempt: the unclosed span ends at the next blank line so dropping it does not take the rest of
  the chapter, `validateFigureFences` drops it, and the planned kind is enforced when one was passed.
  `reinsertFigureFences` drops any fence the pass invented, since the prose it was handed held
  stand-ins only, and `reviewAppliedBookEdit` reads pages as stand-ins unless the instruction names
  the figure.   The two reads of a stored page that are neither a prior-page context nor a review get
  the same treatment where they meet the model: the writer's `lookup_page` tool (`writerTools.ts`)
  cuts its excerpt from the stand-in form and its summary through `pageDraftSummary`, whatever the injected storage callback returns, and the
  voice-character passes (`voiceCharacters.ts`) sample `figureFreeProse` before collapsing
  whitespace, since a pass that only reads for who speaks has no use for a chart or its stand-in,
  while their summaries — and the gender-inference page summaries beside them
  (`voiceCharacterProfile.ts`) — go through `pageDraftSummary`, so a series named after a character
  cannot vote on their pronouns. The final whole-book QA (`finalQaOpeningPages` in `pagesReview.ts`)
  is shown page 1 as its stand-in form and its page map is `pageDraftSummary` of each page
  (`compactPageMap`); so are chapter-review `pageSummaries` and `manuscriptReviewPacks` neighbor
  summaries. And figures are composed chapters' alone in the other direction too: the whole-book,
  chapter and batch writers (`generateWholeBookDraft`, `generateChapterDraft`, `generateBatchDraft`)
  pass every page through `figureFreeDraft` at the parse, before the page set is normalised; the paginator weighs it as
  `FIGURE_WORD_EQUIVALENT`, never splits it, and hands the next chapter a tail with no block in it.
  `expandFigureFences` (`figures/figureHtml.ts`) turns the block into inline SVG with inline styles
  at render time — in `pdf.ts` after the anchor markers and before the font subset, in `epub.ts`
  before marked — so `book.md` keeps the portable form, `BOOK_PDF_CSS` is untouched and the
  geometry digest does not move, and an unreadable block is a missing figure, never a failed
  compile. The SVG carries no `id` and no `<marker>` (two figures in one book, and
  `neutralizeRenderedReservedIds`), self-closes every empty element (`toXhtml` closes six tag names
  and no more), and inherits the embedded display face. No gate reads a figure: the local checks,
  the manuscript audit, the reader chapterisation and the degeneracy guard (and, until 2026-10-16,
  the review packs and the compile's chapter-transition review) are fence-blind at one seam each,
  and none was added — a rule that fires on a figure would be a rule
  on shipped pages nobody replayed, and a figure cannot fire a chapter-coherence rule. The corpus
  fixture `figures` renders every kind.

## Case evidence

- **An evidence packet carries no model-ordered chronology, and an unknown is never about
  provenance.** `buildCaseEvidence` (`caseEvidence.ts`) used to ask the builder for `sequence`, a
  list of claim IDs "in documented chronological order", and the reviewer
  (`caseEvidenceReview.ts`) for one boolean over the whole list. A list is a total order, so every
  adjacent pair in it is an assertion, and the reviewer approved chains whose pairs no passage
  orders: on 2026-09-05 a blind Sol audit of six rebuilt packets
  (`docs/composed-chapters/experiments/2026-09-05-fixes/packets-sol-audit-3.json`) failed the
  First Crusade packet for placing the founding of the Latin patriarchate after the Crusaders'
  return home, and the Josephus packet for placing Scythopolis after the other Syrian cities — a
  comparison read as a sequel — while each packet's own unknowns said the chronology was not
  established. Version-2 packets (`reviewVersion`, `schemas/episodes.ts`) store an empty
  `sequence`: order is stated inside the claim about the later event, only where the passage
  states it, and the reviewer is told a temporal claim inferred from paragraph order, reporting
  order, thematic logic, a comparison or an interpretation is unsupported. A version-1 chain is
  rejected by `caseEvidenceReviewIssues` deterministically; stored version-1 packets still parse
  and still compose. The same audit found the Crusade packet's unknown "not Fulcher of Chartres or
  the document named in the proposed episode" — true of the search hypothesis, false of the packet,
  because the reviewer had already corrected `canonicalEpisode` to the source actually fetched and
  the unknowns had been written against the hypothesis. Provenance is metadata: builder and
  reviewer both treat an unknown about which author or document the passages come from as
  inaccurate, the repair round is built against the corrected episode, and the final packet is
  what the second review sees. Claims are adjudicated one by one, so a claim the final review
  still rejects is excised rather than costing the case (`supportedClaims`, two the floor);
  identity, disagreement and unknown defects remain the packet's. And the case is grounded by
  **one** anchor that resolves to exact passage text: the reviewer quotes up to three, and the
  Keeley packet was lost twice to a second quote that skipped an OCR running header
  ("170 BEATING SWORDS INTO METAPHORS" mid-sentence) or repaired a soft-hyphen break while the
  first resolved exactly — an anchor is only a grounding check, nothing downstream reads it, so a
  broken extra one is noise rather than a verdict. The rules were measured before they shipped:
  `replay-evidence-4.ts` through `replay-evidence-6.ts` under that experiment directory rebuild
  eight captured packets (the first two at the logged adapter boundary, the last through the
  production modules), and the two wrong cases (Gudea, Iroquois) have to stay rejected.
- **A composed chapter's unsupported case claims are repaired twice, then recorded and flagged for
  review; a prose-review quote that resolves to nothing is re-asked once, then dropped.**
  `reviewChapterCaseEvidence` reads a composed chapter against its packets and answers with exact
  spans. It used to throw on a finding whose quote was not in the chapter, and the pass used to
  throw on any finding left after one whole-chapter edit — so the two live books that first reached
  composition (development-fixes-1c and 2a-retry, 2026-09-05) died on chapter 1 over "1085–1086"
  read into "Christmas 1085 … little more than a year", and on chapter 2 over a reviewer quote
  nobody could locate. The review now returns `{ issues, dropped }`: a finding that does not
  resolve is sent back once as `reviewFeedback` asking for a verbatim re-quote, and what still does
  not resolve is dropped as unactionable and counted. What the pass does with the resolvable ones
  lives in `apps/worker/src/generation/CLAUDE.md`.
- **A developed plan's thesis is its answer by construction, never a string the model is asked to
  copy.** `developBookPlan` (`bookDevelopment.ts`) told the writer "its thesis must equal your
  answer" and then compared the two strings; the answer is a paragraph, luna paraphrased it twice,
  and the first live book to reach the developmental replan (development-fixes-1a-retry,
  2026-09-05) failed after a twenty-minute evidence stage on that comparison. The stance's
  `thesis` is set from `development.answer` after the parse, the prompt says so, and the model
  review that follows checks what a review can — that the positions do not contradict the answer.
- **The deterministic contract gates a developed plan; the model review's objections are
  recorded, and a synthesis chapter inherits its prerequisites' cases.** The next two live books
  after the thesis fix (development-fixes-1b and 2a, 2026-09-05) both died at the same stage with
  zero pages after a complete evidence stage each. 1b: the planner wrote the research-gap chapter
  ("Steppe Powers and Connected Worlds", no verifiable Mongol case) as a synthesis chapter with
  `requires [3, 4, 6]` and an explicit "without inventing an unsupported Mongol episode" — exactly
  what the prompt invites — and `bookDevelopmentIssues` rejected it for owning no case and no
  callback, twice, because the rule read "evidence assigned" and the prompt read "may reason from
  earlier cases". A chapter with no case is now a defect only when it also names no prerequisite,
  and `chapterCaseEvidence` hands such a chapter its prerequisites' packets, so the writer is held
  to those cases (`chapterDevelopmentLines` says so and forbids a new named case) and
  `reviewChapterCaseEvidence` flags anything it invents. 2a: every deterministic check passed and
  the *model* review rejected the plan twice, ten objections long, for regional comparisons and
  surveys the old outline's beats asked for and one verified case a chapter cannot carry — true of
  the material, not of the plan, and not something a third proposal could change — plus the
  stance's voice sample, which it read as invented evidence. The review is editorial judgement,
  so after `DEVELOPMENT_ATTEMPTS` its unresolved issues are stored as `bookDevelopment.reviewNotes`
  (logged in `development_prepared`, shown to the developmental edit, which is told narrowing an
  overclaim is a valid edit) and the plan proceeds; only a proposal that never passes the
  deterministic contract fails the book. Both prompts now say that a requirement scoped to the
  supported material with its gap stated is preserved coverage, and that the voice sample is a
  stylistic sample about a subject outside the book, never evidence.

## Style contract routing

- **Page prompts take local style rules; distribution rules reach no prompt.** Mixing
  manuscript-wide “ask the same questions throughout” lines into `antiAiRules` taught every page to
  perform the same analytical grid. `styleContract.localRules` (and `pagePromptBookStyle`) are what
  page drafts, page review, and the context-pack Avoid line see. `distributionRules` were what the
  targeted manuscript structural review saw (`manuscriptPromptStyleFields`); that review was removed
  on 2026-10-16 (its findings fixed nothing: `apps/worker/src/handlers/CLAUDE.md`, "A compile's
  verdict"), so they are still classified and stored but no prompt reads them. Never move them into a
  page prompt to give them a reader. The plan critic that could rewrite these lines after planning (`mergePlanCriticPatch`) was removed with its gate on 2026-10-16 (E4). Required factuality and prompt-leak ids merge by identity; a
  planner that already returned six anti-AI lines cannot suppress them. Page-local `antiAiRules` routinely differ from `localRules`; classified
  extras merge into the stored contract by id and do not drop planner `distributionRules`. A
  non-Latin anti-AI line whose ASCII slug is empty hashes `foldCharacterName` (the
  `characterSlug` fallback) rather than sharing `planner-rule`. One invalid `localRules` entry is
  dropped; it does not strip the contract. Instruction length is code points, matching `antiAiRules`.
  `QUALITY_FEATURE_IDS` never includes schema validation, page-map
  coverage, generic assignment rejection, collision handling, deterministic audits, or publication
  grading — those live on `MANDATORY_INTEGRITY_CHECKS` and still run when every polish checkbox is
  off. `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` is a rollout switch, not a quality revision.
  Phase 06 did **not** remove it: live precision gates are still unmeasured. Page-local overlap
  (`pageOverlap.ts`, used by `pagesLocalQa` and `pageBeatDedupDetect`) and Smart Unslop are still
  in use after the manuscript structural audit; they are not dead copies of
  `runDeterministicManuscriptChecks`. Detector versions stay on reports:
  `manuscript-structural-audit-v1`, `production-map-audit-v1`, `style-contract-v1`. Offline
  evaluation of the distilled corpus is `pnpm anti-slop:replay` (never `storage/` or live books).

## Repetition gates and the evidence ledger

- **A finding reaches the reader only as a measured type with a page and a quote its detector
  matched; everything else is the console's, and a detector's precision is fixed at the detector.**
  `readerFindings.ts` holds the admission list as data (`READER_FINDING_ADMISSIONS`: `PROMPT_LEAKAGE`,
  `ARITHMETIC_ERRORS`, `BOOK_PRINTED_SHORT`, none allowed to block) and `buildManuscriptQualityReport`
  grades from it alone (→ `apps/worker/src/handlers/CLAUDE.md`, "A reader is shown"). A quote is
  evidence of where a detector looked, never that a claim is true — whole-book review's quoted
  findings verified 36/36 on their pages and were real 5/12 — so admitting a model-backed type takes
  a labelled measurement of it, not a quote. The labelled set (`.scratch/harness-redesign-2026-10-15/h6-labels/`)
  also named false positives that the console and the repair pass read, each fixed where it fires
  and pinned by a test built from the labelled example: the manuscript leak table dropped the bare
  `chain of thought` idiom and quotes the span it matched (`promptLeakSpan`, carried back through
  the orthographic fold); page QA's source-packet patterns take "supplied/provided" only as an
  adjective — after a determiner or after the packet noun — never the verb ("the recording supplied
  material", 8 of 17,865 stored pages); a ```` ```figure ```` block is not story-page artwork
  (`markdownHasArtwork`); `REPEATED_PHRASE` skips a name or title (`isNameOrTitle`);
  `CROSS_CHAPTER_CONCEPT_REPETITION` does not run on a story (`narrative`); and a model's "this page
  has no dialogue" is dropped when the page prints attributed speech (`findingCounterevidence.ts`).
  A new reader type is one entry with its measurement; a new detector meant for the reader states
  the span it matched as `evidence`.

- **A deterministic rule that can veto the model reviewer is measured against shipped pages before
  it ships, and one that fires on pages the reviewer approved is removed, not tuned.** Three such
  rules went on 2026-09-02, after a 120-page book spent 26 minutes in "Doing a final read-through"
  with 22 pages stuck in `FAILED_QA` (every other recent book compiled in 0-5 minutes): the
  reviewer's reserved-closing-beat guardrail in `pagesReview.ts` (three five-letter words shared
  with the next page's brief — "reach, ghetto, occupation, agency" on a Holocaust chapter — vetoing
  approvals scored 88-94), the page-time treatment gate in `pagesLocalQa.ts`, and the
  `SAME_CHAPTER_TREATMENT_REPETITION` audit plus the bulk-pass `distinctnessGuidance` that shared
  its `scoreTreatmentPair`. Replayed over 1,200 pages from ten shipped books, 1,177 of them
  model-approved: the guardrail fired on 76 approved pages, the treatment gate on 295, and the audit
  clustered whole chapters of distinct pages in every book. Its "subject" was named-entity overlap
  over an extractor that took every sentence-initial capitalised word as an entity ("their",
  "such", "once"), and its "causal chain" was two shared cue words ("because, therefore"). The
  near-verbatim gate (`pagesRepetitionQa.ts`) and `RECAP_BACKTRACKING` (`manuscriptRecapAudit.ts`)
  fired on none of those pages and stayed; the phrase-pattern detectors (`SYMMETRICAL_HEDGING`,
  `SENTENCE_OPENING_CADENCE`) count literal matches and were not in question. The replay is the
  standard for the next such rule: dump the pages of shipped books, run the rule, count hits on
  approved pages. `pnpm anti-slop:replay` covers the distilled fixtures, never live books.
- **An analytical page owns its evidence anchors; a shared one is repaired like a near-duplicate
  beat and never blocks.** `claim` and `evidenceAnchors` on `PageProductionBeat` make the evidence
  a page argues from a property of the assignment (`evidenceLedger.ts`), asked of every brief
  producer and shown to every writer and the reviewer for `analytical-history` and `instructional`
  books only. Every explicit rebuild of a beat — `normalizeModelPageBeat`,
  `decodeGeneratedChapterBrief`, `pageMapForWholeBookDraft`, the whole-book citation sanitizer —
  carries them by name through `evidenceLedgerFields`, because zod strips what a projection forgets;
  `mergePageMapCriticPatch` drops them under a whole-assignment rewrite that names none, the
  `imageMoment` rule again. `productionMapAnchors.ts` compares anchors folded (`foldCharacterName`
  plus punctuation) on whole-phrase equality or ≥0.8 token containment with two tokens on the
  smaller side, and `SHARED_EVIDENCE_ANCHORS` is a *sparse* finding with its own `beatFinding` — so
  the bounded `dedupe-page-beats` rewrite is briefed against the owning sibling — that is never in
  `BLOCKING_CODES` and never counts toward a dense chapter. One the two repair cycles cannot clear
  drafts with its distinctness note (`advisory_unresolved`); a map that returned no ledger at all is
  `MISSING_EVIDENCE_ANCHORS`, diagnostic and one per chapter, and drafts as every book did before
  the field. The schema omits absent keys rather than writing `undefined`, so a brief stored before
  the field parses byte-for-byte as it did under the `Chapter.productionBrief` compare-and-swap.
- **A brief prompt names its JSON keys and shows the shape; prose alone has the model spelling
  them from the words.** The chapter-brief prompt used to say only "Return one beat per page. Each
  beat needs purpose, concrete action or explanation, required continuity, ending pressure, and
  optional image moment" — no key ever named, no example shown — and once the strict acceptance
  (`decodeGeneratedChapterBrief`) stopped inventing placeholders for what it could not read, every
  one of the fourteen briefs rejected across three 2026-09-01 runs was a key the model had coined
  from that sentence: `concreteActionOrExplanation`, `concreteAction`, `action_or_explanation`,
  `ending_pressure`, or a `beat` object holding `purpose` and `action`. Each rejection is a full
  re-ask at 0.2, so a sixteen-chapter book paid four extra calls. The prompt now carries the same
  two things the whole-book map prompt always had: a system rule naming the seven keys and saying
  they are top-level and never nested inside `beat`, and an `outputContract` in the payload
  showing one page object (with the evidence-ledger keys when that mode applies, via
  `evidenceLedgerOutputContract`). Widening the decoder's alias table was tried first and covered
  only the nested four; naming the keys covers all fourteen, which is why the aliases stayed as
  they were.

## Page 1's opening contract

- **A reply cut off by its output budget is asked for once more at a wider budget, outside the
  repair count.** `generateJsonWithRetry` used to let an OpenAI `incomplete: max_output_tokens`
  response propagate as the call's failure — it is not a parse error and not a schema error, so no
  repair rule matched — and a `develop-book-plan` schema repair that ran out of its 16k budget failed
  a paid book at the developmental replan (development-fixes-3a-retry, 2026-09-05). The Responses
  API counts reasoning tokens against `max_output_tokens`, so a budget that fit the first proposal
  can miss the repaired one. A truncated reply is the same reply cut short, so
  `isOutputBudgetExhausted` buys exactly one more attempt at `OUTPUT_BUDGET_WIDENING` (1.5×) the
  budget, with the same messages as the attempt that truncated, and does not consume a repair
  attempt; a call with no `maxTokens` gets nothing, because there is no budget to widen.
- **Nothing states page 1's opening contract in its own words: a prompt names an audience and gets
  the ban, the import exemption that silences it, and the hook fused to its payload key — or gets
  nothing.** The contract is two halves gated on different facts. The **opening-quality** half —
  never open on throat-clearing, a welcome, a definition of the topic, or meta framing such as "In
  this book" — is what an imported manuscript is exempt from: page 1 of an import is the author's
  own first sentence, and every one of those rules is a licence to rewrite it
  (`isAuthorManuscript`, `schemas/mediaSettings.ts` — an import or a Studio book; "import" below
  means either). The **hook-delivery** half is gated on the
  plan having committed to an `openingHook` **and on that same provenance**, because an import's
  plan is not a commitment its book was written to: `synthesizeImportedBookPlan`
  (`ingestion/manuscriptImport.ts`) builds it out of the finished manuscript and sets no
  `openingHook` at all, and one appears only when that plan is later *revised* —
  `revisePlanningPackage`'s "Preserve or improve openingHook" line is unconditional — so an import's
  hook is a sentence a model invented from a premise field, having never seen page 1. Leaving it
  ungated was justified as "a repair's replacement page is generated prose", which holds for the
  brief producers and fails for every prompt this contract feeds: `revisePageDraft` rewrites the page it is handed, in place, and a reader's own "make page 1
  sharper" reaches `revisePageDraft` through `rewritePageForUserRequest`
  (`apps/worker/src/generation/textEditRewrite.ts`). Which page is the author's cannot be asked — `Page`
  has no provenance column, so `isAuthorManuscript` reads the *project's* mediaSettings and both
  halves are book-level. That over-applies to prose inserted at the head of an import
  (`resolveStructuralEdit` accepts `anchorPageIndex: 0`, so a generated page can sit at global index
  1) and is right anyway: the hook that page would deliver is the invented one, and hook-without-ban
  is the worst of the four combinations — a page told to make its opening striking with none of the
  rules that say what a striking opening is. Six prompts say something about that page (eight until the polish and the compile's whole-book QA, `runFinalBookQa`, were removed, 2026-10-16): the three bulk writers (`generateWholeBookDraft`, `generateChapterDraft`, `generateBatchDraft`), the single-page draft, `revisePageDraft` and `reviewPageDraft`. Spelled per prompt, the halves came apart four times running, each one a
  different mismatch between the set of prompts *stating* a rule and the set applying its gate: the
  ban fused to the hook sentence in the bulk writers, so a plan with no hook — every `MOCK_AI` run,
  `makeFallbackPlan` itself, every plan stored before the field, any run where the model omits the
  optional key — drafted page 1 with no ban at all and was then failed by the deterministic checker,
  which is gated on provenance and never on the hook; the exemption reaching local QA and neither
  model reviewer, which is *worse* than no exemption, because the local gate's early return in
  `reviewPageDraft` was the only thing that had been keeping the model call off an import's page 1;
  the exemption never reaching `buildPageInstruction`, so a page-1 revision of an import was
  explicitly instructed to rewrite the author's opening after a failure with some unrelated cause;
  and local QA excusing categories the writer prompt banned outright; and the hook half left
  ungated after all four, so an import's page 1 — the author's own first sentence — was handed
  "deliver the plan's `openingHook` in the page's own prose" by the reviser, the polisher (since removed) and the reviewer, after any QA failure with an unrelated cause and on any reader-requested rewrite of
  that page. Every one of those is a rule
  and its gate answered in different places, so the three questions are answered once —
  `openingContractForRange` (`pagesShared.ts`): does this call reach global page 1, may page 1's
  prose be held to the quality rules, did the plan commit to a hook. `openingContractFields` is the
  only way to the sentences. It picks them out of `OPENING_CONTRACT_RULES`, an **exhaustive
  `Record`** over `multiPageWriter`, `pageWriter` and `reviewer`, and returns them fused to the
  payload: spreading `payload` beside `rules` is the only way to use either, so a prompt cannot
  carry the ban without the exemption having been applied, nor name the hook without sending it. A
  ninth prompt names an audience or gets no text at all. The question is asked of a **range**, not
  an index, because a chapter-scoped call has to ask it of the absolute pages it was handed — a
  leading chapter that ended up with no pages hands page 1 to the next one.
  **The reviewer's two sentences are not the writers', and neither difference is cosmetic.**
  `statesCategoryOpening` is true only for the writer audiences, which choose the opening;
  `firstPageOpeningRule`'s category recipes inside a rejection prompt invite rejecting a legitimate
  opening for being the wrong shape. And because the writers are told to deliver the hook "without
  echoing its wording", the reviewer's hook sentence has to say so outright — an unlabelled
  `openingHook` beside `pageBrief` reads as "the page must match this", so a page that transformed
  the hook correctly could be rejected for not reproducing it. (`runFinalBookQa` asked the same contract over the whole book until it was removed; the compile's defect screen judges no opening.)
  **The deterministic twin is the same ban, gated on provenance alone.** `hasWeakFirstPageOpening`
  (`pagesLocalQa.ts`) fires on `pageIndex === 1` for every book the pipeline wrote, with no category
  exemption: `firstPageOpeningRule` grants the signposting categories exactly one concession — "you
  may signpost later on the page, never in the first paragraph" — and `FIRST_PAGE_OPENING_WINDOW`
  *is* that first paragraph, so an exemption there approved the one sentence the instruction never
  did. `isAuthorManuscript` is therefore named in exactly two places in this pipeline, the prompts
  (`pagesShared.ts`) and the gate (`pagesLocalQa.ts`); `pagesReview.ts` names it nowhere and reads
  `statesOpeningQuality` off the contract instead.
  **The sweep measures both sets rather than listing them, which is why editing the test cannot keep
  it green.** `pagesShared.test.ts` runs all eight prompts against a generated book and an imported
  one, a plan with a hook and a plan without, on page 1 and on page 2, and asserts set identities:
  the prompts stating the ban are exactly the ones the import exemption silences, and the prompts
  naming the hook are exactly the ones a hookless plan silences **and** exactly the ones an import
  silences — three measured sets, so no gate can move on its own. A further case asserts the whole
  contract goes quiet on an import's page 1, both halves at once. Its handle on "does this prompt state
  the ban" is `OPENING_QUALITY_RULE_MARKER` — the word "throat-clearing", which all three sentences
  interpolate instead of each phrasing the ban — so a prompt wording it freshly measures as not
  stating it at all, which the "every site states it" assertion is what catches.
- **The page *brief* producers gate the hook and not the ban, and that split is the one deliberate
  asymmetry.** `firstPageBriefFieldsForRange` (`pageBriefContract.ts`) is the single entry point all
  three brief producers reach the contract through — the whole-book map, the per-chapter brief and
  the deterministic `fallbackPageBeatFromChapter`, which takes only the condition because it writes
  no prompt and has no payload key to emit (the QA brief repair, `repairPageBrief`, was the fourth
  until it went with the per-page review chain on 2026-10-16) — and it reads
  its hook off the very same `openingContractForRange`, so an import's page 1 is never *assigned*
  the hook its prompts are no longer told to *deliver*. Leaving that half raw was the last door:
  `synthesizeImportedBookPlan` sets no `openingHook`, a `book_replan` invents one, and a later
  `GENERATE_BOOK` then briefed page 1 to deliver it while the writer prompt — gated — carried no
  `openingHook` key at all, which is the "told to deliver a hook it was never shown" failure the
  whole contract exists to prevent, arriving through the brief instead of the instruction.
  `FIRST_PAGE_IDENTITY_RULE`, the brief side's opening *ban*, stays ungated on purpose: the
  exemption protects an author's own sentence from being rejected and rewritten, and a brief is a
  production assignment for prose about to be generated, so
  the ban over-applies to an import's page 1 without ever reaching a sentence the author wrote. The
  halves part company because their over-application costs different things: a ban costs a
  regenerated page some freedom it was never going to use, a hook costs the author their opening.
  Two things keep that from drifting back. `PageBriefBookScope` **is** `OpeningContractSource` — an
  alias, not a twin — so a producer whose options satisfy one satisfies the other by construction;
  and the raw `(openingHook, lastPageIndex)` form is module-private, so no producer can answer the
  provenance question at its own call site. The page-map critic was the one that did — the worker
  handed it `plan.openingHook` as a string — until it took the book like the others; it was removed
  on 2026-10-16 (E5), and `mergePageMapCriticPatch`, which states no rule, still takes a plain
  `lastPageIndex` for the beat-dedup rewrite's patches.

## Whole-set edit adherence

- **One operation-level verdict does not mean one unbounded prompt.** `reviewAppliedBookEdit`
  sends a small candidate set jointly, but a larger manuscript is divided into stable UTF-8-safe
  page segments under `EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES`. Every leaf returns evidence and exact
  coverage, never a premature global missing verdict; bounded reducers preserve that evidence until
  one final call judges the complete coverage root. A missing segment id, a broken coverage range,
  an oversized call, malformed evidence, or a final verdict that does not accept the root digest
  fails closed. Do not truncate, sample, or independently approve pages to make the request fit.
  The exact-replacement path remains local and precedes this protocol.

  **Coverage is not evidence lineage.** A leaf has an explicit completeness bit, and its bounded
  lists hold one unadvertised slot past the capacity the prompt offers: a list that fills every
  advertised slot is accepted, one that spills into the spare is rejected. The rejection is what
  stops a provider filling the last slot it knows about and silently implying there was no next
  fact — the spare slot is what lets it say so instead of being refused for obeying. Code assigns stable ids to every accepted fact. Reducers may
  summarize positive evidence only by naming every immediate source fact exactly once and in order;
  the summary id hashes that lineage and the evidence digest binds it recursively. Possible
  omissions and contradictions never pass through a reducer at all: code carries their immutable
  facts to the final call, which must accept every id exactly and may resolve only ordered omission
  ids. Any contradiction, unresolved omission, id collision, lost lineage, overflowed output, or
  lossless negative set too large for the final budget fails closed rather than publishing. A fact
  repeated verbatim inside one list is collapsed instead: a repeat carries no information, and
  failing an edit over it refunds work the reader received. A leaf that honestly reports incomplete
  evidence is **backpressure, not failure**: the group is halved and re-asked, twice at most, and
  only then fails closed — the prompt and the guard now give the model the same advice, where the
  prompt used to ask for a flag the guard threw on. Each call's output budget is computed from what
  its own schema forces the model to echo, at one token per response character, because evidence is
  written in the book's language and Devanagari, Han, Kana and Hebrew all tokenise near 1 char/token
  rather than the ~4 an English estimate assumes; the fact id is 16 hex because its width *is* that
  budget, and the final negative ceiling is a bound on what fits, not a constant.

  **`satisfied` is the verdict; the other three fields are the repair order it carries when the
  answer is no.** Nothing distinguishes a suggestion from an unmet requirement in a `string[]`, so a
  list volunteered beside `satisfied: true` may not veto it — that is one model's remark overruling
  the same model's answer in the same response, and it cost the reader three redraft rounds and a
  refund of a correctly applied edit. Both prompts now say the repair order is empty when satisfied
  is true. What may still outrank the boolean is evidence *code* carries: an omission the final call
  declined to resolve by id, and a contradiction it was never offered a way to clear.

  **A verdict says on what basis it was reached, because a review that never ran refused nothing.**
  `basis: "reviewed" | "unverified"` is required on every verdict; `failClosedVerdict` is the only
  producer of `"unverified"` and `normalizeVerdict` the only producer of `"reviewed"`. Everything
  upstream returns `EditAdherenceFindings` — the same shape minus `basis` — and the response schema
  is `.strict()` without it, so no reviewer and no provider can claim one. Callers test the field
  and nothing else: they used to infer it from a five-field shape that only worked because
  `failClosedVerdict` bypasses `normalizeVerdict` and its flagged set happened to equal the caller's
  candidate set. One transient provider error otherwise read as "nothing was applied" and flagged
  every page — two full redraft rounds on a whole-book replan, and on a structural insert a rollback
  that discarded the drafted set and refunded. The basis rides into the stored `adherenceAudit`, so
  `publishedPagesMaySettle` can tell a refusal from an absence months later; a computed exact
  replacement reports `"reviewed"`, because it is the most certain verification here, not the least.

  **The undivided whole-set review is budgeted by the same measurement as every hierarchical call**,
  because it is the common case — everything under `EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES` takes it,
  and most edits are one to three pages. Its schema forces up to 31,380 response characters and an
  ordinary verbose verdict measures 1,579; the flat 1,200 truncated both.

  **The overflow slot is the second spelling of "give me less to read".** A leaf list past the
  advertised capacity is halved and re-asked exactly as `evidenceComplete: false` is. A reducer's
  overflow stays fatal — it has no smaller slice to be given, and its merge must be lossless.

  **A keep-the-same clause is consistency, never a list of things to show.** The router wrote a
  continuation's brief as "Keep the same characters (Salim, the messenger, Nasser, and the memory of
  Mariam)…", and the reviewer refused a chapter that left Mariam out; the repair wrote her in and
  page QA refused that page for repeating her (2026-10-02). `CONSISTENCY_CLAUSE_RULE` tells the
  whole-set, evidence and final calls that such a clause is met by pages consistent with the book,
  and the router is told not to list the characters, setting or tone to keep. Replayed on the three
  logged whole-set calls of that run, with the continuation's chapter-labelled page titles: 2 of 9
  samples satisfied before, 7 of 9 after, and neither false reason recurred.

  **`MOCK_AI` can reach the expensive half of this protocol.** A marker in the edit instruction —
  `[mock-adherence:unsatisfied|incomplete|truncated|failed]` — drives the fake adapter down the
  unsatisfied, backpressure, truncation and provider-error paths. Without it the fake always said
  satisfied, so every failure path this protocol has was invisible in the repo's default way of
  working.

  **Every adherence prompt names its keys and shows the shape, or the guard is inert on a real
  model.** The leaf prompt said "each evidence list has capacity 8" and named only
  `evidenceComplete` and `acceptedInputIds`; on 2026-09-06 all twelve `collect-evidence` calls of
  one edit — and all twelve of the replan before it — came back with a coined `evidence` key and
  none of the four lists the schema requires, and across every stored run the phase had never once
  parsed on a real model. The whole-set prompt had the same gap one key wide (`confidence`) and
  survived only because it gets a repair attempt; the leaf, reducer and final calls ran at zero,
  so one omission was a fail-closed `unverified` verdict and a delivered edit nobody had checked.
  `editAdherencePrompts.ts` holds the four system messages, each ending with a sentence naming its
  keys, beside an `outputContract` the payload carries; `editAdherencePrompts.test.ts` measures
  every schema key against its prompt and every contract against its schema's key set, and the
  three hierarchical calls take one repair. The adapter never sends the zod schema to the model —
  validation is after the fact — so the prompt is the only place the keys are ever stated. **And
  every bound is stated the same way, then enforced by cutting rather than refusing**: the first
  live run after the keys were named failed its leaves on `MAX_EVIDENCE_ITEM_LENGTH` instead — 35
  of 179 facts ran past 180 characters, the longest 293, and a limit the prompt never mentioned
  was again a fail-closed verdict. The limit is 240 now, the prompts say it, and
  `clipEvidenceText` cuts a longer fact (and a longer verdict sentence at
  `MAX_VERDICT_PROSE_LENGTH`) because the bound is an output budget, not a signal — unlike the
  list capacity, whose overflow slot *is* the backpressure signal and stays a refusal. Every
  bound and every response schema lives in `editAdherenceSchemas.ts`, which the prompts state,
  the hierarchy sizes its budgets from, and the whole-set review parses with.
  `apps/worker/scripts/replay-adherence-leaf.ts` re-sends a run log's logged leaf payloads to the
  live model under the current prompt and schema, so the next prompt change is measured on the
  calls that failed rather than on the next paid edit; 5 of 5 previously failed calls parsed.

## Surgical page patches

- **A model-backed page edit is patches first and a page second, and only a rewrite answers to
  page QA.** `pagePatchEdit.ts` is the core half of the chat's surgical tier (the worker's half and
  the incident are in `apps/worker/src/handlers/CLAUDE.md`): the prompt asks for
  `{find, replace}` pairs and names its keys with an `outputContract`; `applyPagePatches` applies
  them in order against the text the earlier ones left, requires each `find` to occur exactly once
  (exact first, then trimmed, then whitespace-insensitive, still unique), and applies none when any
  fails — a partial application would be a silent softening the adherence review then has to
  catch. A result that empties the page or leaves a fence open is refused the same way.
  `pagePatchDecision` reads a patched reply with no replacements as `unchanged`. The budget follows
  the page at one token per character, since the reply echoes every replaced span. `MOCK_AI`
  reaches the declines through `[mock-patch:unchanged|whole_page|miss|failed]` in the instruction,
  the way the adherence fake does.

## Page seams

- **A page is shown where the page before it ends, and a page drafted for an edit is repaired like
  a generated one.** Every prior-page window (`compactPriorPages`) cut its excerpts from the *front*
  of each page, so a page longer than the excerpt never showed the next page where it stopped. A
  continuation's page 14 opened by re-narrating page 13's last beat (oil wiped from the brass, the
  messenger carrying the answer), and its repair could not take it out: the reviser was told the
  page was "a reader-requested edit of finished prose" and to keep every unnamed sentence byte for
  byte, because a continuation passes its brief as `editInstruction` (2026-10-02). The nearest
  prior page now carries `ending` (its last 500 characters, never overlapping the excerpt), and the
  draft, revise and review prompts say what it is (`PRIOR_PAGE_ENDING_RULE`). Pages drafted for an
  edit — a continuation's, an inserted one — pass `draftedForEdit`, which gives them the generation
  rules instead of the finished-prose one, plus "a rejectedDraft that opens by re-narrating that
  ending needs a new opening". A reader's edit of finished prose gets neither seam sentence, so it
  still changes no opening nobody named. Replayed on the logged page-14 revision: the opening
  repeated page 13's close in 3 of 3 samples as sent, 1 of 3 with the ending, 1 of 4 with the
  reviser sentence too.

## Best-of candidate sampling

- **A page is drafted once: no tier samples best-of candidates or asks a judge to pick one, since
  2026-10-16.** Best-of was page 1 of every per-page book on Balanced (2 candidates) and Premium
  and Ultra (3), and every polished page on Ultra (`bestOfPolish`). The E4 review audit
  (`.scratch/eval-data/reports/e4-review-audit.md`) put every recorded `judge-page-drafts` call
  since 2026-09-01 — 19 page-1 judgements, Balanced and Premium — in front of blind Opus readers as
  the judge's pick against candidate 0, the draft the pass makes without candidates: 5 wins, 8 ties
  (7 of them the judge picking candidate 0), 6 losses, a decided share of 45% [21–72]. Under the
  owner's rule (Parsa, 2026-10-16: a review, edit or critic that improves books by 5–10% or not at
  all is removed, Premium and Ultra included) `bestOf.ts`, the judge, the temperature ladder and the
  `bestOfPolish` gate were deleted (`REMOVED_QUALITY_FEATURE_IDS`). `mediaSettings.draftCandidates`
  is accepted and no longer read by generation. The polish the Ultra gate sampled was removed in the
  same audit (polish lost to the unpolished draft, 1 win / 1 tie / 6 losses), so nothing rewrites a
  drafted page before its checks.

## Covers

- **Declining the cover buys a designed one, it does not remove the cover.** `includeCover` only
  ever answered "did a model draw this", so `coverArtSourceFor` (`packages/core/src/generation/
  coverSource.ts`) resolves `false` to `"design"`: the book gets a cover from the 50-entry catalog
  in `coverDesigns.ts` for free, picked by `selectCoverDesign` from the title, premise, audience
  and category. **Read the source through that resolver, never `includeCover` directly** — it is
  what keeps the quote, the dispatch gate and the handler agreeing, and what lets rows written
  before the field existed price identically. Only `"none"` means no cover, and only the operator
  console sets it. A design supplies just the *artwork layer*: `renderCoverPng` still typesets the
  real title with the OFL fonts, which is why nothing downstream — the `cover.jpg` path, the PDF
  cover page, the EPUB `cover-image`, the app's `coverImage` — needed a single change. The design's
  own `template` wins over the book type's `coverTemplate`, because a design was authored as a
  whole. `shouldGenerateCharacterReferences` gates on `=== "ai"` for the same reason a designed
  cover writes `costUsd: 0`: neither may spend on a cover nobody was charged for, and a bundled
  cover left unpriced would land in the Costs tab's `unratedCalls` bucket, which means *understated*
  spend.
- **Two things decide whether a cover design reads, and neither is visible in the code.** Each
  template darkens the half its text panel sits in — science and business blacken the *top*,
  kids/fiction/romance the *bottom* — so a motif that centres its subject where the type goes is
  simply invisible; that is what `FOCUS_BY_TEMPLATE` in `coverDesignArtwork.ts` exists for. And
  every mark is seen through that scrim, so painting in `ground` at low opacity disappears. Render
  the catalog with `pnpm covers:preview` and look at the contact sheet before trusting a palette or
  a motif change. Seeding is off the design id, not the project, so re-rendering a book keeps its
  cover.

## PDF typesetting and the render transport

- **The book is typeset against md-to-pdf's stylesheets, but nothing else of md-to-pdf's remains.**
  `generateBookPdf` no longer calls `mdToPdf()`. `pdfDocument.ts` deep-imports its `getHtml` and
  `defaultConfig` (the package has no `exports` map) so the markdown still goes through
  **marked@4.3.0** with `langPrefix: 'hljs '` — rendering it with this repo's own marked@18 instead
  changes heading ids, email mangling and loose/tight list `<p>` wrapping, which moves every page
  break in every book ever compiled. Everything md-to-pdf used to supply by *default* is now pinned
  by hand in `BOOK_PDF_OPTIONS` and `buildBookPdfDocument`: the `30/40/30/20mm` margins,
  `page_media_type: 'screen'`, and the cascade markdown.css → github.css → ours, which
  `RTL_OVERRIDES` in `pdfCss.ts` exists to undo the first sheet of. **The text block is set by
  `pdfCss.ts`, not by those margins** — `bookPdfCss` writes `@page { margin: 20mm 18mm 22mm }`, and
  Chrome honours that over the CDP parameters, so `BOOK_PDF_OPTIONS.margin` is measurably inert
  (identical page count and line width at 30/40/30/20mm, at 1 cm, and omitted). It is pinned for the
  day that `@page` rule is removed, and asserted by equality rather than through a render, because no
  render can see it. The dependency is pinned to an **exact** version and `pdfDocument.test.ts`
  asserts both stylesheets' sha256, because a bump is otherwise a silent re-typeset. When a digest
  fires, render the fixture corpus with `pnpm render:fixtures` (`scripts/render-book-fixtures.ts`,
  eight books covering both directions, CJK, illustrations, a cover, the coverless title sheet and
  the dense Contents) on each
  side and diff them with `--compare`, which checks `Pages` first;
  byte-comparing PDFs proves nothing, since `/CreationDate`, `/ID` and font-subset ordering differ
  run to run. The old side is rendered by `--baseline <ref>`, never by stashing: it plants a
  throwaway worktree at that ref and copies the *current* harness in, because the change under test
  is routinely the one that adds the corpus, the `render:fixtures` script and the `packages/core`
  exports the harness imports — and because the fixtures are the control, a ref carrying its own
  copy of them would report its text as layout drift. Borrowed `node_modules` are this tree's, so a
  digest that fired *because* the `md-to-pdf` pin moved needs `--install` for the baseline to be
  rendered by the version it is being compared against. A page-count guard only works on **continuous prose**: a fixture with forced
  `page-break` divs pins its own count and reports the same number whatever the stylesheet says.
  **Those two digests pin md-to-pdf's sheets, not ours**, so `bookPdfCss` had no alarm at all: the
  `@page` margins, the counter resets and the title sheet's height could all move every book ever
  compiled with nothing firing. `PAGE_GEOMETRY_SHA256` in `pdfCss.test.ts` is that alarm — a sha256
  over `BOOK_PDF_CSS` with its comments, indentation and colour *values* stripped, so a recolour is
  silent and anything that sizes a box, names a page or decides a line break is not. Subtractive on
  purpose: a property nobody thought of is in scope by default, which is the only way round a
  tripwire fails safe. It is the alarm, not the check — the corpus render is the check.
- **Every face a family is assembled from declares one weight range, or Chrome never falls back
  across its packages.** Chrome groups a family's `@font-face` rules by their exact descriptors,
  picks one group for the requested style and reads `unicode-range` only inside it. Source Serif 4
  declares `200 900` and every script package `100 900` (Noto Naskh `400 700`), so a Persian run
  settled on Vazirmatn's group, never saw Source Serif's Latin face, and every `.`, `:`, `«`, `»` and
  Western digit in a Persian, Arabic, Hebrew, Devanagari or Thai PDF fell to the next family in the
  stack — "Times New Roman", which fontconfig answers with Liberation Serif. `embedFontFaceCss`
  (`fontEmbedding.ts`) now writes the union of a family's ranges onto every face it emits; a variable
  font asked for a weight past its axis clamps. The fixture corpus moved only `persian-rtl` (CJK
  packages carry their own Latin faces), and `pdf.test.ts`'s Persian render refuses any system face.
- **A text-only story sheet is sized to its paragraphs and centred on its sheet, and it wears the
  design the reader chose — or, for a children's book, the one its own words point to.** A picture
  book with no pictures printed each scene at 20pt from 48mm down: a 40-word page filled the top
  quarter of an A4 sheet, and a 120-word one spilled two lines onto a sheet of its own.
  `storySceneLength` (`pdfStoryPages.ts`) estimates each scene's printed height per paragraph — a
  page of short dialogue costs far more than its characters, which is why counting characters sent
  a six-line exchange to two sheets — against `STORY_SCENE_TIERS`, the table the stylesheet is
  generated from, and picks the largest size that fits; the scene is a flex column as tall as the
  writing area, centred by auto margins that collapse to zero when it outgrows the sheet. What
  fills the rest of the sheet is a **design** (`storyPageDesigns.ts`): pastel storybook, night sky,
  under the sea, garden meadow, rainbow, outer space, fairy tale, or plain `classic` — each one data
  (card, colours cycled per sheet, CSS-drawn shapes, face, ornament) from which the stylesheet, the
  estimate's card padding and face width, and the embedded fonts (`STORY_ROUND_FONT` Nunito,
  `STORY_DISPLAY_FONT` Playfair Display, only for a design that sets in them) all derive. Which
  one is `storyPageDesignFor`: the row-owned `mediaSettings.storyPageDesign` the chat's free
  `page_design` edit writes, else for a KIDS book `chooseStoryPageDesign` over the prompt and the
  plan — a design named next to a look-word wins ("a plain layout", "the night sky design"), and a
  design word alone is a subject that only counts as a topic — else nothing, the plain sheet. Both
  compiles call it with the project row and the plan they compile, so they cannot disagree.
  `pdfStoryPages.test.ts` renders the longest scene each size accepts, prose and dialogue, in
  every design and in none, and asserts one sheet each. **A picture book is laid out the same way
  around its pictures** (`PICTURE_STORY`): kept on the house layout, the 6-page illustrated bedtime
  book of 2026-10-02 printed its two text-only sheets as two 11pt lines over a blank page and set
  the words under each picture for an adult. Its text-only scenes now take the same sizes and
  centring as a text-only book's (no design card — the designs stay a text-only book's), and a
  picture scene caps its picture at `PICTURE_MAX_MM` and sizes its words to the space below
  (`storySceneLength(..., { picture: true })`). A book whose scenes carry figures, tables or code
  keeps the house layout throughout. The tier rules are one selector list per block; prefixing
  each whole rule string twice once produced invalid CSS that silently dropped every size. **No margin box may name a face only the cards use**: the faces are
  `font-display: block` and loaded on use, so a Nunito footer on an illustrated children's book —
  where no card uses it — printed invisibly.
- **The coverless title sheet is capped at exactly one page, and it clips from the tail.**
  `@page pdf-title` carries `counter-reset: page 0` like the cover, and it resets on *every* sheet it
  names — so a title page that fragmented left two unnumbered sheets where `printedPageOffset`
  (`pdfPageMap.ts`) counts one, and every number the map, the printed Contents column and the chat
  speak came out one ahead of the footer. Nothing caps a plan's title (a bare `z.string()`), and a
  409-character one fragments measurably, so `.book-title-page` is `height: 245mm; overflow: hidden`
  rather than `min-height`. **The clip is only survivable because the stack is centred by auto
  margins on its first and last child, not by `justify-content: center`**: a centred flex column
  overflows *both* ends, so the first version of this printed a title sheet that began mid-title at
  clause 10 of 30 and lost the book's own name off the top. Auto margins collapse to zero once free
  space is negative, which pins the stack to the top and clips only what runs off the bottom —
  verified pixel-identical to the centred layout for every title that fits. The corpus renders one
  (`title-page-en`), and `pdf.test.ts` renders the absurd one and reads the opening clause back out.
- **Every book has a title page, and only the book's first sheet resets the page counter.**
  Until 2026-10-06 a cover *replaced* the title page, so a covered book never named its own title
  and author inside the file. `formatBookMatter` (`bookMatterPages.ts`) now prints one in every
  book, with the publication details at its foot (the bullet after this one), then a sheet for the
  dedication when there is one, and About the Author as back matter. Behind a cover the title page and the matter sheet are `@page pdf-front`: counted, footer
  hidden, **no `counter-reset`**, so `printedPageOffset` stays the `1 : 0` the whole page map rests
  on and needed no version bump; `pdfPageZone` already calls those sheets `front_matter`. A
  coverless book's title page is still `pdf-title` and still the one reset. The first body page
  therefore prints "Page 3" on a covered book with a dedication, the convention the Contents always
  followed. **The two HTML sections end on a blank line** (`furniture` in
  `compileBookMarkdownWithPageAnchors`): an HTML block runs until one, and the first page joined on
  a single newline was swallowed into the section as raw text, markdown unrendered and `bp-1`
  homeless — latent on every coverless book with an author before this, on every book after it.
  Everything the reader typed is escaped — HTML in the front matter, markdown punctuation in the back
  (`escapeMarkdownText`), so a bio cannot open a heading, a link or a setext rule. **Not `(` or `[`**:
  escaped, they become `\(` and `\[`, which are the math pass's own openers, and "Ada (born 1815)"
  printed "born1815" in math italic in all three formats; escaping `)` and `]` is enough to stop a
  link. **And the math pass skips the compiler's title page and matter sheet**
  (`bookMatterSectionEnd`, read by `markdownMath.ts`), so `$x$` in a pen name prints as typed —
  entities could not do it, because the Word export does not decode them. Image-shaped text in
  matter stays literal too: PDF, EPUB and stored-image preparation share `bookIllustrationAt`
  (`bookIllustrationMarkdown.ts`), which skips matter and escaped bangs before resolving assets.
  About the Author is a markdown `##` so the EPUB gives it a file and the Word export a heading; the
  empty `<div class="book-about-author">` after it is what `h2:has(+ .book-about-author)` starts a
  fresh sheet on, because the heading's own id is marked's slug of a translated label.
  `sourcesOffset` now marks the first back-matter heading, Sources or About the Author, and the
  story split passes that back-matter slice through the chapter splitter, giving Sources and
  About the Author separate EPUB files and navigation entries. Combining them hid the biography
  behind the Sources heading on re-import and let the profile's biography print beside it.
  **The new matter pages come on top of the paid sheets.** `fitBookPdfPageCount` sizes the type so
  the whole file has `targetPages` sheets — cover, a coverless title sheet *with a byline*, Contents
  and Sources included, as they always were; a title page behind a cover, a coverless title page
  with no byline (that book printed an inline `# Title` before), the matter sheet and About the
  Author are not. Counted inside it,
  a ten-page book with a cover, a dedication and a bio set its text near ten points to make room
  for three pages nobody paid for. `generateBookPdfWithPageMap` adds `bookMatterSheetCount` (read
  off the markdown, so a plan-less repair fits the same way) to the target, so a book fits its text
  identically with and without them. **A long dedication is sized, never clipped**: one tier table
  (`matterSheetLayout.ts`: 13pt house, 11, 9.5, 8) drives both the stylesheet class and the estimate,
  with per-character widths measured in Chrome, so realistic dedications stay on one sheet; one too
  long even at 8pt runs on, and the same layout counts the sheets it takes (668 renders matched,
  2,000-character prose to 1,000 one-word lines, CJK and Persian included). `@page pdf-front` keeps
  the house margins whatever the fitter does to the body's. **About the Author is held to the same
  rule**: it was counted as one sheet while it printed at whatever body size the fitter chose, so a
  bio of short paragraphs ran onto sheets nobody paid for and the fitter shrank the whole book.
  It now sits on `@page pdf-back` in fixed point sizes the fitter's `body` rules cannot reach
  (`ABOUT_TIERS`: 11pt house, 10, 9, 8), takes the largest that fits one sheet, runs on past 8pt,
  and `bookMatterSheetCount` reads the bio back and counts the sheets `aboutAuthorLayout` says it
  prints (about 2,500 renders matched; a Chinese bio over twice the limit is the known miss).
  Widths are measured, emoji as whole drawn glyphs (a flag, a skin tone, a ZWJ family is one),
  symbols no book font has at 1em, and the fixed-width spaces at their Unicode widths (an
  ideographic space is a full em: read as an ordinary space, Chinese dedications spaced with it
  printed a sheet more than counted, 5 of 56 renders before and 94 of 94 matched after). The ©
  year is printed in the book's own digits
  (`yearInBookDigits`, the footer's numerals), and the chat quotes it the same way. The generation-leak checks skip them too
  (`withoutBookMatter` in `findBookLikeMarkdownIssues`): a reader's own `generatedat.com` failed
  every compile of the book. The structural checks (a leading frontmatter block, raw page breaks)
  still read the compiled text as written — a coverless book's first page opening `---` is the
  reader's, and the compiler's own output always opens on the title page. An EPUB with no chapter heading keeps its opening file — the whole
  text — first in the navigation, or a short book with a bio listed only "About the Author".
  The © year is `bookMatterYear`: an imported manuscript's own © year (`copyrightYear`) when it
  stated one, else the book's creation year — never the compile's, so a recompile stays
  byte-identical across New Year; the free tier's credit
  is decided per compile (`bookMatterForExport`, `packages/db`) and sits at the title page's foot
  (on the matter sheet of a book compiled before 2026-10-17, or of one with a blank title). The Word export reads both sections back out of the
  HTML (`docxAssets.ts`), as it did the title page. Its generated credit carries the
  `TomezaMadeWithCredit` bookmark (`docxBookMatter.ts`); DOCX import removes only text inside that
  range, preserving page breaks and text added beside it. This lets the next compile decide the
  credit from the current plan without duplicating it or retaining it in a paid book's prose.
  Identical author-written text and older unmarked exports retain their words: wording alone
  does not identify compiler credit. **Text pasted from Word carries control
  characters**, and one U+000B made the EPUB and the Word file unparseable XML on every recompile:
  `cleanMatterText` (and `parseBookMatter`, on read) turns `\v`, `\f`, NEL, U+2028 and U+2029 into
  line breaks (a space in a one-line field) and drops everything else XML 1.0 forbids, and because
  page text has no cleaning of its own both XML writers strip again at one seam each —
  `addXmlDocument` in the EPUB, `withoutXmlIllegalPartCharacters` over the packed Word file (the docx
  library writes text unchanged through too many paths to catch earlier) — removing only what would
  make the file unparseable, so a clean book's parts are byte-identical. The EPUB seam also drops a
  numeric reference to a forbidden code point (`&#11;`, `&#xFFFE;`; `withoutXmlIllegalCharactersOrReferences`),
  because marked and `toXhtml` pass references through; dropped rather than U+FFFD, the way the raw
  character is. The Word file needs no such step: it decodes no entities and the library escapes
  every `&`. The EPUB keeps pictures out
  of About the Author at every bio size, by class prefix and the last marker, as
  `bookMatterPages.ts` does. Corpus: the `matter-pages` fixture; the nine existing fixtures rendered
  pixel-identical across the stylesheet change.
- **A book's publication lines print at its title page's foot, and only a dedication earns a sheet
  of its own.** The © line, "All rights reserved.", the imprint, the ISBN and the free tier's credit
  shared the matter sheet with the dedication, so a book with no dedication spent a whole sheet on
  two © lines under a title page that stood mostly empty ("The Last Table", 2026-10-17: cover,
  title page, a sheet reading "© 2026 Parsa Gholipour / All rights reserved.", then the text).
  `formatBookMatter` writes them as `book-title-page__publication` at the title page's foot, and the
  matter sheet holds the dedication alone; a plan with a blank title prints no title page, so that
  book keeps the combined sheet. **The foot is outside the clip**: a title page with a foot wraps
  the title, subtitle and byline in `book-title-page__stack`, which takes the height the foot
  leaves and clips its own tail (`flex: 1 1 auto; min-height: 0; overflow: hidden`, the auto
  margins inside it), so an overflowing title loses its last lines and never the © line, and the
  fields are bounded (`BOOK_MATTER_LIMITS`), so the foot always fits; `bookMatterPdf.test.ts`
  renders the 60-clause title over every field. A title page with no foot is written byte for byte as before.
  Every reader of the old shape still reads it, because a book compiled before this keeps it until
  it recompiles and a repair renders those bytes: `bookMatterSheetCount`, the credit readers, and
  the `matter-pages-legacy` fixture, pixel-identical. The EPUB follows the markdown (the foot under
  the byline, `epub.ts`), and its import splits the foot back out as a copyright page
  (`epubMatterBlocks.ts`): without that, 56 of the 63 round-trip tests fail, because a title page
  holding © lines is kept as book text. The Word file keeps its own layout (`wordFrontMatter` in
  `docxAssets.ts`), since a DOCX import recognises our title page only when every line is the
  title, subtitle, byline or publisher. The chat names a front-matter page by the same rule
  (`frontMatterForProject`, `apps/api/src/bookPageNumbering.ts`). The matter fixtures are built by
  each side's own `formatBookMatter`, so `--compare` sets the old book against the new one.
- **Chrome reads the book off disk; nothing crosses CDP.** The assembled HTML is written to
  `.book-render-<uuid>.html` inside the renderer’s scoped temporary image directory and opened with `page.goto('file://…')`, so
  the book's relative asset paths (`projectId/filename`) resolve to the real illustrations exactly as
  they did against md-to-pdf's static server. That is what killed the 174 s and 382 s exports: they
  lived in `addStyleTag`/`addScriptTag`, which take **no timeout**, and a legacy illustrated book
  shipped a ~27 MB `JSON.stringify`'d image map through one. Fonts must stay `data:` URIs — a
  `file://` `@font-face` src from a `file://` document is blocked by Chrome's opaque-origin rules.
  The temp file is not web-reachable: `/assets/images/:projectId/:filename` is a two-segment param
  route, not a static mount.
  **What that transport costs is the origin's protection, so the renderer carries an allowlist.**
  A page opened from `file://` may load `file://` subresources, and a manuscript is user text —
  imports arrive as raw prose, an exact-replacement edit writes literal text into a page, and
  markdown passes raw HTML through. `<iframe src="file:///etc/passwd">` in chapter one printed the
  server's password file into the exported PDF, reproducibly, and `/proc/self/environ` would have
  printed its provider keys; the HTTP-origin renderer this replaced refused that for free.
  `renderResourcePolicy.ts` intercepts every request the render makes and permits four things: the
  document this render wrote, `data:` (the fonts), `about:blank`, and non-dot files under the
  compiled project's own image directory — which is why `generateBookPdf` now takes a `projectId`,
  standing in for the `sendOwnedProjectAsset` check the file transport dropped. Everything else is
  aborted, **including `http(s)`**: an iframe of `169.254.169.254` prints the instance's cloud
  credentials the same way, and no legitimate book resource is remote. Interception covers
  navigations, frames, images, CSS `url()` and anything a script starts later, which is why it is
  the control and `stripEmbeddedDocuments` (`pdfDocument.ts`, which deletes
  `iframe`/`object`/`embed`/`frame`/`script`/`link`/`base`/`meta http-equiv` from the assembled
  HTML) is only the second lock. That strip runs on the *rendered* HTML, never the markdown, so a
  book about HTML keeps its `<iframe>` examples — marked has already escaped everything in a code
  fence by then. It is verified by rendering the fixture corpus with the policy off and
  on and diffing: pixel-identical, so the allowlist refuses nothing a real book asks for.
  **The same disclosure had a second door in the EPUB.** Both exports turn
  `/assets/images/<projectId>/<filename>` into a path on disk, and they did it with a copy of the
  resolver each; the filename group matches slashes, and only the PDF's copy checked containment, so
  `![x](/assets/images/p/../../../../etc/passwd)` packaged a server file into the reader's download.
  There is now one `resolveBookImageAsset` (`bookImageAssets.ts`), which decodes before it resolves
  (`%2F..%2F` is a separator) and returns null unless the result is exactly
  `<temporary image directory>/<projectId>/<filename>` — the shape the HTTP route serves.
  **`<projectId>` there means *this* book's, which is a second option and not a wildcard.** Storage
  is shared, so containment only ever said "some project's illustration": a manuscript naming
  `/assets/images/<another-project>/page-3.png` — and manuscripts are user text — read another
  reader's artwork out of it. The PDF survived that by accident, because the renderer's
  `assetRoot` allowlist is already scoped to the compiled project; the EPUB reads the file itself
  and packaged it into the download, with no renderer anywhere to refuse it. So the resolver takes
  an optional `projectId` and compares it against the *resolved* first segment (after decoding, so
  `proj-1/..%2Fproj-2` is `proj-2`), `generateBookEpub` and `generateBookPdf` both pass theirs, and
  the PDF's markdown rewrite refuses what its renderer would have aborted anyway. Omitting it keeps
  the whole storage directory in scope, which is only right for a book belonging to no project —
  `scripts/render-book-fixtures.ts`.
- **One Chromium, many pages — and the reset paths are the point.** `browserPool.ts` is the only
  place that launches a browser (`generateBookPdf` and `renderCoverPng` both go through
  `withRenderPage`). It holds a `Promise<Browser>`, not a `Browser`, and clears it on `disconnected`
  *and* on launch rejection under a **generation counter**, so a stale event cannot evict a newer
  browser. The semaphore is **2**, deliberately below worker concurrency
  (the four job lanes summed, `workerLaneConcurrency` in `jobLanes.ts`; book compiles run in the
  compile and interactive lanes, cover typesetting in the image lane too) — four large books in
  one Chromium is an OOM that takes all four down.
  Recycling after 50 renders **retires** the browser rather than closing it: it stops handing out
  pages and closes once its own last page comes back. Closing inline is only possible when no other
  render is in flight, and with the semaphore at 2 a busy worker always has one — so a close-now rule
  fires only when the pool is idle, which is exactly when recycling does not matter. That is why the
  count lives on the lease and not in a global.
  A disconnect is retried **once, inside `withRenderPage`**, so both callers get it: sharing a
  browser is what turned one crash from "fails the job that owned it" into "fails every render in
  flight", and the cover is where that bites hardest — `renderCoverPng` runs *outside*
  `generateCover`'s artwork fallback, and `GENERATE_COVER` is not in `DERIVATIVE_GENERATION_JOBS`, so
  an unretried disconnect there marks a finished, fully paid book FAILED and refunds
  `FULL_BOOK_GENERATION` because some unrelated compile crashed Chromium. One retry is the whole
  budget — `compile-export` gets no BullMQ-level retry, which would re-run final QA and re-spend real
  credits — and it is skipped when `closeSharedBrowser()` was what took the browser away, or a
  shutdown would launch a replacement and hold the process open. A watchdog timeout is not
  disconnect-shaped and is never retried. Anything passed to `withRenderPage` must therefore be safe
  to run twice. "Disconnect-shaped" means **`TargetCloseError` and nothing else**: puppeteer throws
  that from every path where the far end went away, and its parent `ProtocolError` is the generic CDP
  failure — including the protocol *timeout*, which would pay its whole budget twice. Matching the
  parent covered no case the child did not.
  **A render is leased a browser context, not a page, because the page is not what the manuscript
  is confined to.** `stripEmbeddedDocuments` deletes `<script>` but not the `onerror` on an `<img>`
  whose source `renderResourcePolicy` just refused — that handler is script a manuscript gets to
  run, and one `window.open` from it was a page the pool never leased, never counted against the
  semaphore and never closed. Verified surviving into later renders, still fetching, with no
  interception on it: interception is installed per page, so a page the document opened for itself
  has none. `renderOnce` therefore closes the whole `BrowserContext`, which takes the popups, the
  workers and the storage with it, and `discardStrayTargets` closes any target the content opens on
  sight — watching the *context*, so a popup opened by a popup is caught too, and so a
  `setInterval(window.open)` cannot pile up tabs for the watchdog's whole 90 seconds. What neither
  can stop is the *first* request of each opened window: Chrome reports a target once it exists, by
  which time its navigation is on the wire (`--block-new-web-contents` does not refuse it —
  measured). Closing that needs the document unable to run script at all, i.e. stripping inline
  `on*` handlers in `pdfDocument.ts`.
  Every close is **once and bounded**: a wedged renderer's `close()` never settles, so a
  second attempt would hang the exact case the watchdog exists to unstick. The outcome is acted on
  rather than discarded, and `"failed"` is not `"timeout"` — a rejected close means the target was
  already gone, while one that never settles is a renderer still holding a process. The latter
  **retires** the browser on *every* path, success included: ignoring it on the success path leaked
  pages into a long-lived Chromium (the pool's own accounting said they were gone) for up to fifty
  renders. Retiring rather than closing outright is what reclaims them without failing every render
  sharing that browser.
  **Retiring is a promise to reclaim, so a lease outlives every close it is waiting on.** The
  browser's own `close()` is no more bounded than the context's — puppeteer's CDP path sends
  `Browser.close` and then awaits the process's `exit` event with no deadline of its own — so
  dropping the lease and fire-and-forgetting that promise left a Chromium nothing in the process
  had a handle on: invisible to the idle sweep, to `closeSharedBrowser()`, and to anyone reading
  the code, but not to the container's memory. A lease is now `live`, `retired` or `closing` and
  leaves `leases` only when its reclaim settles, which is bounded end to end: five seconds for
  `close()`, then `terminateBrowserProcess` (`browserProcess.ts`) SIGKILLs the process *group*,
  then two seconds for the exit. The group — the negative pid — is what takes the renderers and
  the zygote with it, and it cannot name this process's own group by accident, because a group id
  is always its leader's pid and that pid belongs to our child. The exit check before it is the
  safety property, not an optimisation: a pid is ours only until Node reaps it, which is exactly
  when `exitCode`/`signalCode` stop being null. What survives even that is recorded rather than
  forgotten — `browserPoolStatus().abandonedProcesses`, which both `shutdown()`s log, and which a
  process that finally dies drops off. `closeSharedBrowser()`
  is wired into both apps' `shutdown()`, both render test files' `afterAll`, and `pnpm covers:preview`
  — a live `Browser` holds the event loop open, so without it vitest never exits. It is bounded for
  the same reason it is awaited in a signal handler: one wedged renderer used to hang the shutdown
  that was supposed to release it, until the supervisor's own SIGKILL left that Chromium reparented
  to init. Never `browser.process()?.unref()`; that orphans Chromium — killing it is the opposite,
  and the only thing that reclaims one. Production reaps it with tini
  (`ENTRYPOINT`), dev with compose `init: true`, because PID 1 is a shell that does not reap — and
  budget **two** pooled browsers in production, one per process.
  **Trapping SIGHUP is part of that wiring, not housekeeping.** Puppeteer's own handlers are off,
  so its only remaining net is an unconditional `process.on("exit")` — which a signal Node does not
  handle never reaches. A hangup (a closed terminal, an `ssh` drop, systemd reload) used to kill the
  API or worker mid-flight and leave Chromium alive, reparented to init and reaped by nobody, so
  both entry points and `scripts/start-production.sh` trap `HUP` alongside `INT`/`TERM`. Registering
  a third signal is also why the two `shutdown()`s are now once-only: a hangup is routinely followed
  by a TERM from the same supervisor. `scripts/tsx-dev.mjs` forwards a hangup as **SIGTERM**,
  because nodemon handles that and not `SIGHUP` — sent verbatim it dies and orphans the app holding
  the browser.

- **A book's render waits as long as its length needs, and the one CDP bound is the longest wait
  any render may have.** Puppeteer's `page.goto()` and `page.pdf()` defaulted to 30 s and the pool's
  watchdog and `protocolTimeout` were 90 s for every book; an 820-page book measured ~15 s a render
  on an i7, a t3 is about twice as slow, illustrations are heavier, the fit renders a book at least
  twice, and a timeout is never retried — so a long book could fail and be refunded after all its
  AI spend (pre-launch review, 2026-10-13). `bookPdfRenderBudgetFor` (`pdfDocument.ts`) counts a
  book's sheets generously — the paid target, the model pages, or 1,500 characters a sheet, whichever
  is most — and its illustrations; `bookPdfRenderBudget` gives each phase 30 s + 100 ms a sheet +
  500 ms an illustration (about five times the i7's rate), capped, and the attempt both phases plus
  30 s, so a book of no length gets exactly the old 30/30/90. `printDocument` (`pdf.ts`) hands them
  to `goto`, to `page.pdf` through `bookPdfPrintOptions` — `BOOK_PDF_OPTIONS` plus `timeout`, which
  is not a `Page.printToPDF` parameter and so cannot move a break — and to `withRenderPage`. A cover
  keeps `DEFAULT_RENDER_TIMEOUT_MS`. `protocolTimeout` is one setting per browser and the print is
  one CDP request, so it is `MAX_RENDER_TIMEOUT_MS` (11 min), which `withRenderPage` also clamps
  every watchdog to: at 90 s it killed a long print whatever `page.pdf()` was told. The reset paths
  are untouched — a wedged render still dies at its own budget and retires its lease — and what the
  scaling costs is that a wedged *long* book holds one of the two permits for longer.

- **The page map is measured from the published PDF's own bytes, and measuring must move nothing.**
  The numbers a reader can see — the printed footer, the Contents column, the pdfrx chrome — skip
  the cover sheet (`counter-reset: page 0` on `@page pdf-cover` / `@page pdf-title`). Stored map
  ranges stay physical: PDF page 1 is the cover when `hasCoverPage` is set. `printedPageForPdfPage`
  and `pdfPageForPrintedPage` convert — but only version-2 maps (what `buildBookPdfPageMap` writes)
  apply that offset. Version-1 maps were measured against PDFs that counted the cover and stay
  on physical numbering, matching the files they describe. Nothing about a model page says where
  it lands: pages normally join on a single newline, so adjacent pages routinely share one
  paragraph. `joinMarkdownPageBlocks` restores a blank line when a page-ending table is followed
  by prose without a cell separator; otherwise GFM consumes that prose as an extra table row. It
  does the same when the next page *starts a table* — a header row and its delimiter, as GFM
  reads them — because on one newline those two lines become rows of the table above: the header
  as data, then a row of `---`. The toolkit prints each worksheet filled and then blank, back to
  back, so a page cut between them did exactly that (r1-bal-guide, r2-bal-workbook, 2026-10-01).
  Replayed over every stored book, it changed those two boundaries of 15,159 and nothing else, and
  130 finished books compile to byte-identical `book.md`.
  Continued table rows keep their single newline, and offsets come from the assembled markdown
  so the extra separator cannot shift a page anchor. `compileBookMarkdownWithPageAnchors`
  therefore returns, beside the byte-identical `book.md`, one destination name per model page — the
  existing `chapter-N` for a chapter opener, `bp-N` plus a markdown offset otherwise — and the PDF
  render injects markers into **its own copy only** (`pdfPageAnchors.ts`): an empty inline
  `<span id>` glued to plain content, an HTML comment line before block syntax, a span *inside* a
  quote or list line when one container straddles the boundary, and a span inside the first cell
  of a pipe-led row when a table straddles it — a comment line there ejects the following rows as
  pipe text and a span *before* the leading pipe becomes a cell of its own and shifts the rest, but
  after the pipe it is inline cell content. While that row took no marker, the page cut between a
  worksheet printed filled and its blank copy — joined then on one newline, so it opened inside the
  first table — was the one unmarked page of r1-bal-guide and r2-bal-workbook (2026-10-01), both
  of which shipped the stub; that boundary now joins on a blank line (above), and body rows
  continuing across a cut are what still reach the in-cell marker. A delimiter row, or a row with
  no leading pipe, still takes no marker and the map fails soft. Each shape is measured
  against marked@4.3.0 to leave the rendered blocks identical, and manuscript-authored `bp-*` ids
  are renamed at equal byte length so user text cannot point a destination somewhere else.
  **`chapter-*` needs the same guard and cannot take the same shortcut, because the compiler writes
  those ids itself.** Chrome resolves a link against the first element wearing a name, so a page that
  merely *reads* like a chapter opener outranks the real one — and that misplaces the Contents link,
  the number rewritten into its row and the reader's fallback outline as well as the map, since
  `buildBookPdfPageMap` only refuses a *decreasing* run of anchors and a stolen destination landing
  in order still yields a full map of the wrong pages. A manuscript reaches the name two ways, so
  there are two renames. In the markdown, `<a id="chapter-2"></a>` is what an author writes for a
  chapter of their own — markdown has no attribute syntax and it is the name anyone would pick, which
  is why the compiler picked it too; nothing in the bytes tells the two apart, so
  `compileBookMarkdownWithPageAnchors` records `existingIdOffset` for each anchor it writes,
  `chapterAnchorMarkup` is the shape both sides agree on, and every *other* tag holding the name is
  renamed — never one inside a fenced block, where it is printed as code rather than rendered. If a
  single recorded offset does not hold its anchor, **nothing** is renamed: a chapter that lost its id
  takes its Contents link with it, which is worse than a stolen destination. After the render,
  `neutralizeRenderedReservedIds` catches what no offset could — `## Chapter 2` is handed
  `id="chapter-2"` by marked's own slugger, an id that exists on neither side of the markdown — and
  renames every reserved id except the renderer's own two marks, the compiled `<a id="chapter-N"></a>`
  (recognised by the heading that must follow it) and the injected empty `<span>`. Names match
  *whole*, so a heading slugging to `chapter-2-the-return` keeps its id and the links to it.
  `placeBookPageAnchorIds` then moves
  every marker onto a box with extent (the following block, the following inline element, the first word), because a
  zero-height marker at a fragmentation boundary lands its destination a page early — the same
  incident `liftChapterAnchorsOntoHeadings` exists for. A `display:none` nav of internal links
  makes Skia emit `/Dests` at all (ids alone emit nothing; hidden links add no annotations, no
  layout — measured). `extractPdfNamedDestinations` (`pdfNamedDestinations.ts`, the dependency-free
  byte parser `pdfPageMap.ts` is the model on top of) reads the names back out of
  the rendered bytes through the classic xref, and `buildBookPdfPageMap` turns starts into
  inclusive ranges, deciding shared boundary pages by the anchor's y against the top-margin band.
  **Failure anywhere returns `undefined`, and no compile may fail, publish differently, or retry
  over the map** — chat without a translatable map keeps the old model-index behaviour. **But it
  is never silent**: a stub looks like a measured book everywhere but chat, so the render hands back
  `pageMapFailure` (`explainBookPdfPageMapFailure`: the pages with no destination, or out of order),
  the worker appends `export.pdf_page_map_fallback` to the compile's run log for every fallback and
  warns when a render with anchors lost pages (`pdfPageMapAfterCompileRender`), and the API's inline
  rebuild warns. Diagnostics only — nothing branches on them. New PDFs
  still skip the cover in CSS, so a failed measurement still records cover-skip numbering
  (`bookPdfCoverNumbering`) for chrome. **That stub says what it is** — `kind: "cover-numbering"` —
  and the marker, not its empty `pages`, is what `parseStoredBookPdfPageMap` refuses it by, because
  "carries no ranges" and "was never a measurement" are different rows and only the second may
  never reach chat. Reading the refusal off `pages` retired a measured map that came back
  rangeless along with the stubs, losing the cover flag and the furniture starts that were still
  true of its file; a row predating the marker is refused anyway, since a stub describes no file
  and so carries no `totalPdfPages`. `parseStoredBookPdfNumbering` ignores the marker — the
  cover-skip fact under it is the whole point of the stub.
  When the
  book prints a Contents, its rows' numbers — which the markdown could only write as model indexes
  — are rewritten to the printed chapter numbers (the cover sheet is not numbered) and the document
  rendered once more, re-measured, and re-checked once: the printed column and the footer now count
  the same pages. That column is rewritten **whole or not at all** — a chapter whose anchor measured
  onto the unnumbered cover has no printed number, and `contentsChapterPrintedPages` refuses the
  whole set rather than letting that one row fall back to its physical sheet, which would print one
  number from the other system in the one column a reader checks against the footer. The rows keep
  their model indexes instead, and the map — physical throughout — is kept either way.   **Replacing
  `book.pdf` without that measured pass must replace the translatable ranges.** A detached repair whose
  recompile does not byte-match the published `book.md` renders those published bytes with no
  plan — no markers, no Contents reprint — and the reprint exists because digit width moves
  breaks, so "same manuscript" is not the same pagination. A stale map mistranslates chat
  targets onto the unreprinted file; a cover-numbering stub is the graceful path — chrome
  still matches the footer, chat stays on model indexes. Keep anchor ids
  ASCII `[a-z0-9-]` (PDF name escaping never applies) and keep the injection out of `book.md`,
  whose bytes are the provenance sha, the EPUB input and the reader-chapter fingerprint.

## Export provenance and scratch files

- **A download says which compile answered it, because the URL cannot.** Every compile of a book is
  published over `book.pdf`, so the availability descriptor the app fetched with is a claim about
  what that URL held when the status was read — and the download most likely to be answered by a
  *newer* compile is the retry after an `EXPORT_NOT_READY`, which is the app being told a compile is
  landing. The app files those bytes under a `contentRevision` three times over (the reader cache,
  the "your edits are in" banner, every highlight and bookmark it stamps), so a stale descriptor made
  all three agree on the wrong book. Sizes cannot separate them: a presentation reprint, a re-applied
  edit and an undo all produce a book of exactly the same length. So every publication records the
  sha256 of what it installed beside it (`book.pdf.provenance.json`), under the revision it claimed
  — `publishCompiledExports` in the worker and `publishRebuiltExport` in the API, both inside the
  transaction that already holds the row lock, after the S3 puts, and never fatally: a published book
  must not be failed and refunded because a hundred bytes of metadata could not be written.
  `readPublishedExport` (`packages/core/src/generation/exportProvenance.ts`) then resolves the bytes
  it read against that record and the mobile route answers with `X-Export-Provenance` and
  `X-Export-Content-Revision`. **The record is read on both sides of the file read**, because a
  publication landing in between moves the file and the record independently as far as the reader is
  concerned; a digest identifies one file, so either read may confirm, and only when neither does is
  the read tried again. **Nothing consults the project row to label bytes** — a row read after a file
  read describes whatever compile is current now, which is the same mistake one layer down, and an
  edit moves the row minutes before the compile that publishes for it.
**Every scratch name in that scheme is built in one module, and swept by age from the same one.**
This used to describe a shared filesystem. Durable exports and predecessor backups now use
private S3; see [docs/storage.md](../../../../docs/storage.md) before changing publication or cleanup.
There is no migration or legacy disk read fallback. `exportTempSweep.ts` still owns local scratch
filenames and their strict patterns. `withTemporaryDirectory` scopes pending renders and image
snapshots to one container, cleans them in `finally`, and maintains a heartbeat for long renders.
Both API and worker sweep their own abandoned helper directories after crashes. The worker also
sweeps S3 predecessor backups through `runtime/exportObjectCleanup.ts`, checking age and metadata
again before deleting. Cleanup is single-flight; shutdown stops it before closing the worker.

- **A companion export never fails the compile, and a new one is one registry entry.** The EPUB
  and the Word file (`docx.ts`, shipped 2026-09-06 as a plan perk) are best-effort: a render that
  fails twice records `<FORMAT>_EXPORT_FAILED` on the quality report, the publication retires that
  format's predecessor and its provenance, and the export-repair lane rebuilds it on demand. The
  PDF is the book and is never one of these. Every list that enumerates the formats derives from
  `exportFormats.ts` — the scratch-file sweep's suffixes, `exportProvenancePaths`, the worker's
  pending paths and `artifactPublications`, the mobile DTO and route table, the repair priority,
  the policy identity letter — because they used to be a dozen `"pdf" | "epub"` spellings that did
  not typecheck against each other, and adding the third format meant finding all of them. Only
  `jobSteps.ts` still spells its `docx` step as a literal: it is a subpath entry and may import
  nothing at runtime. The Word renderer takes the same compiled markdown string the other two
  take and renders **no HTML**: the compiler's title page and Contents are read back into fields
  (`prepareDocxSource`), chapter anchors are dropped and re-made as bookmarks, every other tag is
  discarded, and only `http`, `https` and `mailto` links survive — which is this export's whole
  `stripEmbeddedDocuments` story, since a hyperlink target is the one active thing a manuscript can
  still smuggle into a Word file. Fonts are named per script and never embedded (the EPUB's rule),
  the Contents is a static list of hyperlinks rather than a TOC field (Word would ask to update
  fields on every open), and a figure is rasterised through sharp's librsvg — which cannot see the
  PDF's embedded face, so its labels are set in whatever fontconfig substitutes — and degrades to
  the stand-in sentence when it cannot be drawn.

## Chapter apparatus

- **A book only earns the word "Chapter" by being long enough to need it.** The planner is told to
  make its chapter targets sum to exactly `targetPages`, so a three-page book gets three one-page
  chapters — a good *writing* scaffold, three distinct beats, and an absurd thing to print as
  "Chapter 1" over three paragraphs plus a Contents page costing a quarter of the PDF.
  `chapterPresentationFor` (`packages/core/src/generation/markdown.ts`) sizes the apparatus to the
  finished book instead: `chapters` (numbered headings + Contents), `sections` (the titles alone,
  no Contents — the default style becomes `title_only`), or `none`. Read it off the partition that
  is *about to be printed*, never off `plan.chapters`, which is why one test now covers both the
  plan's chapters and model-written reader chapters — the plan-side guard it replaced had a floor
  of four chapters, so a three-page book cut into three could never trip it. An explicit
  `mediaSettings.chapterHeadingStyle` still outranks all of this; only the default is sized.
  The narrator asks the same question through `narratedChapterLabel`
  (`apps/worker/src/handlers/generateAudiobookSupport.ts`) and drops the spoken label — but it must
  never re-partition, because `chapter-<n>.mp3` and the READY-skip that resumes a failed narration
  are keyed on chapter index.

- **A book composed by chapters is exported in the chapters it was composed in; the model
  chapterization is for the per-page strategies.** `createReaderChaptersForExport`
  (`readerChapters.ts`) asks a model to regroup the finished pages into at most twelve reader
  chapters from 700-character excerpts. That is right for a per-page book, whose plan chapters are
  a writing scaffold. For every long book but a picture book the chapter is the unit of
  composition — planned with a title, composed as one piece to it, its landing on its last page —
  and every page carries the `Chapter` row it was cut from, yet the compile asked the model anyway,
  and nobody compared the Contents page with the plan until the third 100-page Balanced book
  (2026-09-19): twelve invented titles over fifteen composed chapters, a "Chapter 3" heading two
  pages into the composed chapter 3, chapters 5–6 and 14–15 merged so a landing sat mid-chapter,
  and a `chapterize-export` call on every content recompile. The second run's export had done the
  same with nine. `readerChaptersFromComposedChapters` now derives the reader chapters from the
  rows — contiguous runs of `page.chapter`, in page order, planned titles and summaries through the
  same sanitizers — and `compileExport` uses it whenever `strategyComposesChapters(strategy)`, in
  every lane, before the cache and the model; it declines (`undefined`) when any page lacks a
  chapter or a chapter's pages are not one run, and the model grouping stands in. The apparatus is
  still sized by `chapterPresentationFor` from the partition about to be printed.

- **An author's book compiles by its own rules, and a generated book never sees them.**
  `CompileMarkdownInput.authorManuscript` (set from `isAuthorManuscript` by both compiles — the
  worker's and the API's inline rebuild — or the two print different books) changes four things:
  page blocks join on a blank line (`joinMarkdownPageBlocks`' `paragraphBreaks`), because the Studio
  paginator cuts only between blocks and every page is trimmed, so the single-newline join merged the
  paragraphs either side of every cut into one `<p>` — imports did this until their first Studio
  publish; a page is never unwrapped from a whole-page fence and keeps a leading `## Page 3`; the
  generation-leak checks (`bookLikeMarkdown.ts`) are skipped, so an author's own sentence cannot
  FAIL their export; and `runDeterministicManuscriptChecks` keeps content integrity only. A Studio
  picture book prints one sheet per page through `storyPageLayoutFor`, never the short-kids rule.
  The fixture corpus is all generated books, so `pnpm render:fixtures --compare` is the proof a
  change here left them alone. A generated book its owner took over into the Studio
  (`studio.origin: "takeover"`) compiles by these rules from its first recompile, so
  `takenOverPageText` (`authoring/takeoverText.ts`) rewrites each of its pages once into what the
  generated rules *printed* — `sanitizePageMarkdown` under the generated flag, the hero as the first
  line — and the book does not change in print when it changes hands. Its figures stay a composed
  chapter's own under the Studio's AI too: chapter feedback reads stand-ins, a chapter draft never
  sees one in the ending it continues from and never keeps one it invented
  (`authorLongAssists.ts`), and the style profile reads figure-free prose.

## Library characters

- **A library character reaches a book by copy and by name, never by foreign key.** The
  account-wide `LibraryCharacter` table is the user's; at build time the active branch's
  @-mentions are snapshotted into `mediaSettings.mobile.characters`
  (`libraryCharacterSnapshotsForBuild` in `apps/api/src/mobile/creationBuild.ts`), and everything
  downstream — the planner guidance in `planner.ts`, the prompt block in
  `composeMobileProjectPrompt`, the reference-sheet seeding — reads that copy off the input
  snapshot. The plan schema strips unknown keys, so the **verbatim name** is the only link from a
  plan character back to its portrait: `matchLibraryCharacter`
  (`packages/core/src/generation/libraryCharacters.ts`) tries folded exact equality then
  **whole-token** containment, and a rename by the planner degrades to an unseeded sheet, never an
  error. Both halves of that are scars. Everything is compared through `foldCharacterName` (NFD,
  drop the *optional* marks listed in `OPTIONAL_SPELLING_MARKS`, drop ZWNJ/ZWJ/bidi, fold Arabic
  kaf/yeh onto Persian, fold Arabic-Indic digits) because a Persian name saved from one keyboard
  and echoed by a model trained on the other was two different names. That mark list is an
  **allowlist** — Latin/Greek/Cyrillic accents, Hebrew niqqud and the Arabic marks, all things a
  spelling carries or does not — and never `\p{M}`, which it was: Devanagari matras are `Mn`/`Mc`,
  so "मीरा" and "मारा" both folded to "मर" and the matcher seeded one saved character's face onto
  the other. Thai sara and (after the NFD) the Japanese dakuten were the same collision. A script
  nobody enumerated keeps its marks, because a missed match is a character drawn from prose and a
  merged one is the unrecoverable half of the very rule below.   **The mention scanner's rule about
  marks runs the other way, and both are right.** `isLibraryMentionNameCharacterAt`
  (`libraryMentions.ts`), the word-boundary test deciding where a typed `@name`
  ends, matches `\p{M}` on purpose: a combining mark belongs to the letter before it, so with marks
  outside the boundary class `@मीर` ends cleanly in front of the "ा" of `@मीरा` and binds a saved
  character the reader never named — `Luna` seeding `Luna-Bear` again, in a script where the
  sub-token is invisible. One rule says a mark is not part of the *spelling*; the other says it is
  part of the *word*. Neither may be narrowed to agree with the other, because each is closing a
  collision the other cannot see. The boundary class is one rule spelled twice —
  `isLibraryMentionNameCharacterAt` + `libraryMentionTokenEndsAt` in
  `libraryMentions.ts` (the description scanner and the build sweep in
  `apps/api/src/mobile/creationBuild.ts` both call these), and `_nameCharacter` +
  `_endsMentionToken` in the Dart twin (`apps/mobile/lib/features/characters/domain/library_mentions.dart`)
  — and the two only move together:
  the composer and the build sweep disagreeing is how the server silently bound the `Luna` the
  composer had just refused to show inside a typed `@Luna-Bear`. The class carries ZWNJ/ZWJ, so the
  scanner itself no longer reads `علی‌رضا` as ending after `علی`; the trailing rule is that an
  apostrophe after a complete name ends the token (`@Luna's` still binds Luna) while a hyphen
  joining the next word does not (`@Luna-Bear` binds nobody unless `Luna-Bear` is itself saved).
  And containment is whole-token because sub-token matching put one
  reader's saved face on a character they never saved — `Sam` seeded `Sam's Mother`, `Luna` seeded
  `Luna-Bear`, and ZWNJ is category `Cf`, so the old `[^\p{L}\p{N}]` boundary read `علی‌رضا` as a
  word break and matched a library `علی`. An **ambiguous** containment resolves to null: a missing
  seed is a character drawn from prose, a wrong one is a stranger wearing the reader's face, and
  only one of those is recoverable by reading the book. Deleting
  a character deletes rows and files but no book state; a seeding pass that finds the portrait
  file gone skips it silently, which is the deletion-safety valve. Character files live at
  `images/characters/<userId>/` in private S3 — never swept, unreachable from the project asset
  route and the render allowlist — and every path to them resolves through
  `libraryCharacterObjectKey`, which returns null for anything but exactly `<userId>/<fileName>`.
- **Naming every row is not the same as claiming every marker, and a tie is settled rather than
  left standing.** `claimAt` (`libraryMentions.ts`) refuses a span two candidate names tie over —
  "Bram" and "bram" are two legal rows, since `[userId, name]` is case-sensitive, and neither is
  spelled the way `@BRAM` is — because a wrong owner is the unrecoverable half, exactly as it is
  for a typed mention. That refusal is right for a *rewrite*, which needs an owner, and wrong for a
  *strip*, which only ever deletes the `@`: every tied candidate agrees on that edit. Folded into
  one "nobody claimed it", the tie read as the reader's own prose and the marker went into the
  planner brief and `buildLibraryCharacterPortraitPrompt`. So the scan reports ties separately and
  `stripBoundLibraryMentionMarkers` takes them, for a caller whose list is the whole of what the
  prose is bound to. `stripLibraryMentionMarkers` may not: it takes `siblings` whose tokens must
  survive, so a tie there may belong to one of them, and dropping that `@` would leave a stored row
  pointing at a token the prose no longer carries.

- **A character's look lives in pixels, so it has to be written down or the planner invents one.**
  `LibraryCharacter.description` is who the character is — free text the reader writes, routinely
  carrying no appearance at all ("she's a great wife and future mother") — while what they *look
  like* existed only in the portrait, which the planner is a text model and never sees. Told to
  reuse a character it could not picture, it invented a look, wrote it into
  `illustrationPlan.characterReferencePrompts` and every page prompt, and **that text beat the
  reference images attached beside it**: a woman in a black hijab was rendered as a bare-headed
  child in a ponytail, on a page whose prompt did not even use her name. So there is an
  `appearance` column, read off the picture by the same bounded vision call the photo upload
  already makes, snapshotted beside the name, and printed by `libraryCharacterPromptBlock` as its
  own labelled line under its own budget — truncating a look is not a shorter sentence, it is a
  licence to finish the outfit. `libraryCharacterAppearanceRule` then says the only two honest
  things: with an appearance recorded, reuse it word for word; **without** one, write no hair,
  age, build, headwear or clothing anywhere and refer to the character by name only, because the
  picture is attached to the image calls and invisible to the writer. "Invent something
  consistent" is the instruction that caused this.
- **Nothing used to check that the planner obeyed, and now one pass does.**
  `reconcilePlanLibraryCharacters` (`packages/core/src/generation/planLibraryCharacters.ts`) runs
  after **every** plan parse — `createPlanningPackage` and `revisePlanningPackage` both — and
  renames a matched character back to the verbatim name, restores the library's own description
  over the schema placeholder (`"Recurring character in the plan."`, `schemas/plan.ts`), sets
  `visualRules` from the recorded appearance or leaves them empty, re-appends a snapshot character
  the plan dropped, and collapses two entries that resolve to one snapshot. It is what turns
  translation, rename, near-duplicate and invented-twin from silent wrong output into a no-op.
  Revision needed it most: `planLibraryCharacterGuidance` was called from the initial planner
  **only**, and `revisePlanningPackage` serialized no `userInput` and no `mediaSettings` at all, so
  any "make it shorter" after approval re-decided the saved character against nothing. Arrays merge
  as atomic replacements, so whatever came back won.

## Book series

- **A continuation's writers get the earlier book's facts in every chapter and its ending only in
  the opening, never its text; the planner gets the record its mode allows, and an inspired
  book's has no plot.** `bookSeries.ts` reads the snapshot the API copied at Build
  (`mediaSettings.mobile.series`). `planSeriesGuidance` puts the record inline in all four planner
  prompts (create, quick, compact picture book, revise), just before the library rules so a saved
  character's own record speaks last, and `userInput` drops the record (`withoutBookSeriesRecord`)
  so it is not sent twice. For a continuation, a short book (≤ 9,000 characters) travels whole; a
  longer one as its chapter synopsis, the ledger's facts and the last 2,400 characters. An
  inspired book's record is the world — cast, places, rules, voice, style — and never what
  happened: its synopsis is not even copied (`buildBookSeriesSnapshot`), because a planner shown
  the plot of "a new story in its world" retells it. `seriesWriterFields` gives every writer of a continuation — composed chapter,
  page, whole-book, chapter and batch — `previousBook.facts` (≤ 2,500 characters, under
  `SERIES_WRITER_RULE`), and only the call that writes page 1 `previousBook.ending`. An inspired
  book's writers get nothing beyond the plan and the prompt's `Series:` line. Every other book's
  prompts are byte-identical. Unmeasured: handing writers earlier text inside one book lost on
  taste (E7), so the ending is deliberately the only text a writer sees, and a blind measurement
  of sequel openings and recap belongs before anything is added.
- **The earlier book's style and a returning character's look are held on the first plan; a
  revision keeps them unless the reader asks to change them.** `reconcilePlanSeries` sets
  `illustrationPlan.globalStyle` to the earlier book's (recorded only when a model drew its
  pictures) and a matching character's `visualRules` to the earlier book's, by folded exact name,
  after the first plan's parse (`createPlanningPackage`, both paths), and runs before
  `reconcilePlanLibraryCharacters`, so a library character's recorded appearance still wins.
  `revisePlanningPackage` holds nothing: its guidance (`planSeriesGuidance(…, { revision: true })`)
  tells the reviser to keep both "unless the user's message asks to change them", because a hold
  after every parse reverted the one revision a reader asked for ("make the pictures watercolour",
  "give Bram a red scarf").
  Pixel continuity for a returning character who is not in the library is not carried: their sheet
  is redrawn from the same words and style, never from the earlier book's sheet.
- **The earlier book's last chapter is read once, by the plan job, because the ledger never takes
  a book's last chapter.** E6b's continuation regressions were facts the ending had changed.
  `withSeriesEndingFacts` (worker `generation/seriesEndingFacts.ts`) runs `extractChapterFacts`
  over `finalChapter` before planning, appends the facts, drops the text and sets
  `endingFactsTaken`, so the plan version's input snapshot carries them to every later job, and
  the plan job merges the enriched record onto the book's row too (`newlyTakenSeriesEndingFacts`),
  so a chat rebuild, which copies the row, does not pay to read that chapter again; a failed read
  plans from the facts it has, and a stop travels. A designed cover reuses the earlier
  book's design (`coverDesignSelectedBy: "series"`), and a design no longer in the catalog falls
  back to the selector.

## Character reference selection

- **One sheet per character reaches the model, because a superseded cast is still the same cast.**
  `selectCharacterReferenceAssets` (`characterReferences.ts`) scores an asset by whether the
  context names the character its `metadata.characterName` resolves to — a function of the name and
  the prose, never of the file — so several sheets of one character score identically and the sort
  is a tie each of them wins. That was harmless while a book's sheets were one plan version's: the
  worker's render pass used to delete every `CHARACTER_REFERENCE` row on the project before writing
  its own. It no longer may (→ apps/worker/src/generation/CLAUDE.md), so a replan or a continuation
  leaves a whole cast behind permanently, and the one reader that ranges across plan versions —
  `insertionReferenceSelection` in `apps/worker/src/handlers/applyImageInsertion.ts`, which falls
  back to *all* of a project's sheets when the current plan has none — handed this function three
  drawings of Ada beside three of Beatrice. On a book replanned twice, a chat `add_image` then spent
  its entire 3-to-5 reference budget on one character while the rest of the cast was attached to
  nothing and drawn from prose alone, which is the exact failure the sheets exist to prevent. The
  `ordered.length === 1` fallback — the rule that a book with a single character attaches them even
  when the subject does not name them — missed for the same reason, since three copies counted as
  three characters and it returned nothing at all. `oneSheetPerCharacter` collapses by plan-character
  index before any of that, and it keeps the **last** copy: every caller reads the rows
  `orderBy: { createdAt: "asc" }`, so the last sheet for a character is the newest, drawn against
  the most recent plan's description of them. A caller whose sheets are already one plan's is
  unchanged by construction, which is why this is the fix rather than a second plan filter at the
  one call site that has no plan to filter by.

- **A prompt field present in every chapter is a template whatever it says, and withholding the
  thesis from a prompt is not withholding it from the prose.** Arm 1 of the "proposal-first"
  paradigm (`bookArc.ts`, `seams.ts`, `manuscriptRead.ts`, `cutChapterTail`; worker flags
  `BOOK_ARC` and `SEAMS_TOGETHER` in `composedExperiments.ts`, both off) gave
  every chapter a kind, a job, a page count and — at first — a `dispute`; nine blind readers found
  a new move in every chapter of every book ("two named scholars, each partly right, their
  disagreement improves the question"), so the dispute reaches `argument` chapters only. With
  every thesis field then withheld from the middle chapters (`premise` → the question, no
  `promises`, the arc job for the summary, the form planner given the question and no positions;
  `composedChapter.test.ts` renders a middle chapter's whole prompt and asserts it), the
  manuscript read still reported the answer stated in 10–14 of 14 chapters: the writer
  reconstructs it from the question and lands on it. Composed-25 scored 7.39 against 7.46 for the
  iteration-23 default (`.scratch/composed-chapters/spec.md`), engagement and pacing unmoved. The
  modules stay, tested, for the next arm; `arcChapterLines` also drops any job line sharing four
  content words with the answer, and `applyBookArcPages` repairs a cut whose pages do not sum
  (`repairArcPages`) rather than dropping the one axis the arc exists to test.
