# Worker generation passes

Algorithms shared by more than one handler: the book passes, the page review loop, semantic memory,
plan helpers, export publication, the reader-chapter cache, character preparation and reference
sheets, image layout planning.

If two handlers need the same logic it belongs here. Nothing in `handlers/` may be imported from
this directory — the dependency runs one way.

This is also where a compile decides whether it is allowed to *publish* what it rendered, which is
the subtlest thing the worker does. A compile can take minutes, and the project it started against
may have been edited in the meantime.

## Composed chapters

- **A composed chapter's pages are written in one transaction, and a restart resumes at the first
  chapter with none.** `composedChaptersPass.ts` runs the `composed-chapters` execution mode
  (→ packages/core/src/generation/CLAUDE.md for why). Per chapter: compose, repair its arithmetic
  where code finds it wrong, paginate, describe, then `stageComposedChapter` creates the chapter's
  PENDING rows and writes a *derived*
  `Chapter.productionBrief` — one beat per page naming the section the cut fell in, the page's
  summary as its beat, the facts it established as `requiredContinuity`, the chapter's landing
  only on its last page — with the `composition` beside it, which every `chapterBriefSchema` parse
  strips. The derived brief is what chat edits, continuation and restructuring read; the
  `requiredContinuity` is how a finalize after a restart still publishes each page's continuity
  notes. `composedResumeState` is pure: whole chapters count as done, a partial chapter's rows are
  deleted and the chapter redone, all pages present with some PENDING means finalize, none PENDING
  means queue the compile. Three model calls are in flight at most: chapter N is composed while
  N-1 and N-2 are finished and checkpointed (`FINISHES_IN_FLIGHT`), and N reads N-1's *draft* tail, so
  a rejection from a checkpoint is caught when that finish is next awaited and the run fails there,
  resumable — `composedResumeState` takes done chapters as a set, so one checkpointed ahead of its
  neighbour resumes cleanly. It was two until 2026-09-30: a chapter's finish (edit, acceptance
  review, descriptions: 30–40 s) outlasted composing the next (20–28 s), so one finish at a time
  paced the whole loop. **There is no line edit any more** (2026-10-16, → packages/core/src/generation/CLAUDE.md,
  "A composed chapter is printed as drafted"): a finish is the deterministic arithmetic check and its repair (no model reads the prose arithmetic since 2026-10-16, E4), the quote guard, pagination and the page descriptions, so its `edit-chapter` and
  `review-chapter-edit-acceptance` calls are a repair's and nothing else's, and the progress bar has
  no `edit` phase (`generationProgress.ts` still maps the token for older jobs).
- **Finalize goes through the same staged publication as every other pass, with local checks
  only.** `reviewWholeBookDraftPages` (deterministic rules; one revise on a prompt leak or
  placeholder), then `stageGeneratedPageAndBrief` flips PENDING to COMPLETED — or GENERATING plus
  `publishStagedGeneratedPage` for an illustration slot (no story delta since 2026-10-16, E6). The
  compile skips its per-page final-QA repair loop for this mode (`strategyComposesChapters` in
  `compileExport.ts`): the whole-manuscript read replaced it when it was introduced, and a per-page
  rewrite would re-template pages the composer deliberately left ending mid-argument; since
  2026-10-16 no tier reads by default (below), and Quick Draft never did. The deterministic
  manuscript audit still runs, and on every tier the compile's one defect screen and its scoped
  repair (`../handlers/CLAUDE.md`, "The compile's one review"); the structural review that
  adjudicated the audit's duplication clusters was removed that day. `manuscriptReadPass` (with
  `manuscriptReadCuts`) is the read's gate, on no tier by default, and
  `chapterEditAcceptance` the review of a repair's correction and of a cut; `chapterEditorPass` is retired with the line edit and switches nothing,
  whatever a stored revision lists. Nothing else on the Quality tab reaches this pass except the
  material, ledger and arithmetic gates and `pageLocalQa`, `pageQaRewrite` (one revise of a page
  whose integrity checks find a leak or a placeholder) at finalize.
  The console's "How this book is written" panel reads what the pass leaves behind and nothing
  else: a `report` beside each chapter's `composition` (form-plan source and kept issues, draft and
  final word counts, `lineEdited: false` — the column reads "no line edit", where a report from
  before 2026-10-16 says whether the editor changed the chapter — the manuscript read's notes and
  whether the second edit applied) and, when the pass had to generate the author stance, that
  stance written back onto the approved `PlanVersion.planningPackage` — best-effort, never fatal,
  a compare-and-swap like every plan field (`persistPlanField`), and never over a stored stance the
  pass can write from (one `planAuthorStance` refuses is the one it just replaced in memory).
- **The manuscript read and its cuts run on no tier by default: a stage that moves a book by
  under 5–10% is removed.** The owner's rule (2026-10-16): a review or edit stage that improves
  books by only 5–10%, or not at all, goes. E3 (`.scratch/eval-data/reports/e3-read-cut.md`)
  measured Balanced's read → cut → acceptance tail on every Balanced book whose log held a read since
  2026-09-14 (37 books, 96 cut calls). 57% of cut calls changed nothing — 15 not deletion-only, 16
  under the floor, 24 refused by the reviewer — and the 41 that applied touched 20 of the 37 books
  and took out 137 words a book, **0.75% of it**. Readers preferred the cut chapter 32/2/7 (82%
  [67–91]), but a random paragraph deleted from the same chapters scored 4/0/4, 7 of the 41 cuts
  made their chapter worse (a referent or a payoff gone, six of them past the per-span join
  review), and both repetition measures moved under a hundredth of their run-to-run noise. It cost
  a 65 s read and 137 s to the last acceptance at the median (470–520 s on the concurrent 2026-10-15
  books) after the last chapter, about $0.024 a book. So `manuscriptReadPass` is `["ultra",
  "premium"]` and `manuscriptReadCuts` `[]` in the compiled defaults, and the code stays for the
  tiers that write on other models, which nobody measured; the planned rebuild (verified deletion
  patches with one batched review, H1 Stage 2) is cancelled. **The no-read path is the ordinary
  one**: with the gate off the pass makes no `read-manuscript`, `cut-chapter` or cut review call,
  every chapter keeps the continuity notes its own staging wrote and finalize publishes them, the
  progress bar goes from the chapters straight to finalizing with no `read` phase, the reports keep
  empty `readNotes`, and nothing files a skipped-read or unverified diagnostic, because the compile
  never asks whether a read ran (`composedChaptersPass.test.ts`, "skips the read when its gate is
  off"). The console's notes column reads "no notes".
- **The manuscript read's cuts run beside each other against the book as it stood before any of
  them, and a cut whose reviewer was shown another cut chapter must still find every passage it
  quoted.** The read and its cuts live in `composedManuscriptRead.ts`. Balanced used to cut its
  flagged chapters one at a time. Each `cutChapter` call and its high-reasoning acceptance took
  36–107 s, and the tail took 7.8–8.2 minutes of each 2026-10-15 book's wait. Now
  `CUTS_IN_FLIGHT` (4) chapters are cut, reviewed and re-described at once through
  `mapWithConcurrency`. Staging still runs one at a time, in the read's order, because
  `stageComposedChapter(replace: true)` rewrites PENDING rows. Each cut and its reviewer read the
  other chapters as they were before the batch, whereas the serial loop showed a later cut the
  earlier ones' results. A deletion-only cut removes nothing outside its own chapter, so only one
  thing can go wrong: a neighbour's cut deletes the passage this cut's reviewer accepted as
  "retained elsewhere". Two reviewers can each say that about the other. So the guard looks at
  every kept cut whose reviewer was shown a chapter that was also cut. The chapters a reviewer is
  shown are the ones its notes cite, plus the previous chapter, whose tail every review carries.
  Such a cut has to find every quotation in its `removedSpanReviews[].retainedEvidence` verbatim
  in the book as the batch leaves it. The match folds whitespace and quote marks, splits around
  ellipses and `[…]` insertions, and trims punctuation at the edges. If a quotation is missing,
  the cut is dropped, its chapter keeps its original text, and
  `generation.composed_chapters.cut_guard_dropped` goes to the run log. The field is the
  reviewer's own prose and sometimes paraphrases: on the seven cut reviews of 2026-10-15, 41 of 43
  quotations matched and two reviews would have been dropped. A miss is still read as a loss.
  That is conservative on purpose, and it only applies when two chapters in one view were both
  cut, which neither of those books had. Cuts are judged in the read's order against the cuts
  still standing. A drop only puts text back, so no kept cut can lose a quotation to a later
  decision. Core's `acceptsChapterEdit` returns only a boolean, so the cut's text model is
  wrapped to keep the review (`recordingCutReviews`, keyed on the review's purpose). A reviewed
  cut with no quotation recorded is dropped too, so a renamed purpose shows up in the run log
  rather than quietly disarming the guard. **A failure stages nothing.** A cut that throws stops
  the chapters not yet started and waits for the ones in flight. The batch then fails with a stop
  if any cut saw one, and otherwise with the first failure in the read's order, which is the error
  the serial loop would have thrown (`settleIndependentLoads`' rule). Every in-flight call sees a
  stop within seconds through `withStopAbort`, and nothing is written after it. The serial loop
  had staged the chapters before the one that failed. A retry reads the manuscript again either
  way. `composedManuscriptRead.test.ts` keeps the old loop as its reference. It replays the
  recorded calls of the 2026-10-15 nonfiction book (`testing/manuscriptReadCuts1015.json`)
  through both loops and asserts the same rows, briefs, reports, memory and progress.
  **A flagged chapter that ends up uncut is re-staged with the continuity notes its own staging
  wrote, read back from its row.** It used to take them from the chapters the pass loaded at its
  start, which a fresh run empties when it resets the book, so the re-staged brief carried none
  and finalize published no `ContinuityNote` rows for those pages: 3 of 4 flagged chapters of the
  2026-10-15 novel. `stageOutcome` reads them from the `loadComposedBookState` it already makes
  for the pages, which is right on a resume too.
- **A composed chapter's figures are checked once, right after the compose call, and taken out of
  every pass after it.** `composedFigures.ts`: `validateComposedChapterFigures` drops an unreadable,
  unterminated or unplanned block — over the count, or the wrong kind when a kind was planned
  (run log event `generation.composed_chapters.figure_dropped`) — and re-serialises
  the rest to the canonical line; `finishChapter` strips the blocks before the repairs and puts
  them back just before the cut into pages, so a repair's editor sees a stand-in, and the quote guard,
  the reshaping and the epigraph never meet the JSON; the read pass, its cut and the shelved seams
  get the same treatment; `finalizePendingPages` runs the local checks and a revise on
  figure-free drafts (`stripDraftFigures`) and restores each page's blocks before it
  is staged (`restoreFigures`). A chat rewrite (`textEditRewrite.ts`) does the same unless the
  request names the figure, in which case the model sees the block and may change or drop it. The
  derived brief says which page carries the figure, so chat and continuation know it is there.
  The run log line is written through the `runLog` the pass is handed (`createRunLogger(job)` in
  `generateBook.ts`), never through `console.warn` alone: the JSONL under `runs/` is what a rerun is
  measured from, and the first implementation's event reached only stdout.
- **A figure the validator drops stays dropped: the drops are missing data, and a measured repair
  call saved none of them.** In the run logs from 2026-09-18 to 10-15, about 250 compose calls in
  49 books carried a planned figure, and `figure_dropped` fired three times. One was an empty second fence after the figure the chapter
  kept, so nothing was lost. One was a bar of three groups holding only their total, and the
  paragraph after it says the source gives no split. One was a line whose second series the
  writer had no values for (`[*""]`). A one-call repair was measured on the compose route at effort
  none (`.scratch/harness-redesign-2026-10-15/staging/H10/`). It was told never to supply a value,
  and code refused any answer stating a number that neither the block nor its paragraphs held.
  It saved neither real drop in two samples each. On synthetic faults it repaired 30 of 32 syntax
  errors with every value unchanged, and put back all 6 values the prose stated. Of 16 missing
  values it declined or was refused on 15; the sixteenth was a zero padded into a chart of zeros,
  which a number check cannot tell apart. What a reader meets is prose introducing a chart that is
  not there. Any fix belongs with that prose, not with the JSON.
- **A composed chapter's unsupported case claims are repaired twice, then recorded and flagged for
  review; a prose-review quote that resolves to nothing is re-asked once, then dropped.**
  `repairChapterEvidence` (`composedEvidenceRepair.ts`) runs the prose-evidence review, then at most
  `EVIDENCE_REPAIR_ROUNDS` targeted edits — the first told to narrow each quoted span to what the
  passage states, the last told to delete the detail outright rather than hedge it — keeping a
  repaired text only when it carries fewer findings than the one it replaced, and never throwing.
  What stands goes on the chapter report as `evidence.unresolved` (`{ quote, reason }`), into the
  run log as `generation.composed_chapters.evidence_unresolved`, and, because a compile's page rows
  already carry their chapter's brief, `unsupportedCaseClaimIssues`
  (`composedEvidenceResiduals.ts`) matches the quotes against the pages at compile time and appends
  one error-severity `UNSUPPORTED_CASE_CLAIMS` issue naming those pages — a console diagnostic
  since 2026-10-15 (it used to hold the book in REVIEW_REQUIRED; → `../handlers/CLAUDE.md`, "A
  reader is shown"), and a page a reader has edited past the span clears itself. The finalize-time review of a leak-repaired chapter takes the same door through
  `recordChapterEvidenceResiduals` instead of failing the book. Before this, the first two books to
  reach composition (development-fixes-1c and 2a-retry, 2026-09-05) failed on chapters 1 and 2
  after a complete evidence stage and a passed developmental replan each.
- **A composed chapter's wrong arithmetic is repaired through the evidence loop, then recorded and
  flagged for review like an unsupported claim.** `repairChapterArithmetic`
  (`composedArithmeticRepair.ts`) runs after the case-evidence repair in `finishChapter`: it is
  `repairChapterEvidence` with a model-free review (`arithmeticFindings`) and its own notes — the
  first round told to correct the wrong numbers and recompute the steps that follow, the last told
  to delete the intermediate steps and keep the correct result — and each edit carries the
  findings as `factualCorrection.computations`, the evidence the acceptance judge reads. What still
  fails goes on the chapter report as `arithmetic.unresolved` (`{ quote, reason }`), into the run
  log as `generation.composed_chapters.arithmetic`, and `arithmeticErrorIssues`
  (`composedEvidenceResiduals.ts`) matches the quotes against the compile's pages and appends one
  error-severity `ARITHMETIC_ERRORS` issue, which the reader is shown as a warning with each
  statement quoted on its page (`readerFindings.ts`), and a page edited past the statement clears
  itself. A chapter whose arithmetic holds spends no edit at all. **A residual stands only where the
  page prints it as a whole statement and code still finds it wrong.** `includes` found
  `24^{10}\equiv1` at the start of the corrected `24^{10}\equiv16\cdot2\equiv32\pmod{41}` and
  blocked a book whose arithmetic was right (cmusr57zp, labelled 2026-10-15), so `printsStatement`
  refuses a match continued by a digit or a letter, and `stillWrong` redoes the arithmetic over the
  chapter as it now stands — `arithmeticFindings` for delimited math, the stored computation through
  `verifiedFinding` for prose — and files only what code still disagrees with.
  Findings marked `reviewOnly` came only from the model prose check, removed on every tier on
  2026-10-16 (E4: it fixed a real error in 0 of 48 books; → packages/core/src/generation/CLAUDE.md,
  "No model reads a chapter's prose arithmetic"). A chapter report stored before then may still
  carry them, and at compile time they still produce `ARITHMETIC_REVIEW_REQUIRED`, asking to verify
  the rule and inputs before replacing a number.

- **No claim or source is verified on any tier; the review is dormant behind one switch, and
  finalize and compile read the same switch.** Parsa, 2026-09-30: "we want best looking results,
  we shouldn't waste tokens for this". `SOURCE_CLAIM_REVIEW` (`sourceClaimState.ts`) is false, so
  `sourceClaimReviewApplies` answers false and `repairComposedClaims` returns before a call: no
  claim inventory, verification batches, claim searches or factual-repair edits at compose, and
  finalize does not re-run the review for a chapter it finds unreviewed — which it would otherwise
  do for every chapter. `unsupportedCaseClaimIssues` skips `sourceClaimVerificationIssues` on the
  same switch, because an older book's stored ledger would flag every later edit
  SOURCE_VERIFICATION_INCOMPLETE with nothing left to re-verify it. Core's
  `DOSSIER_PROVENANCE_REVIEW` is off with it (the writer reads excerpts as extracted, and without
  `provenanceVerified` no epigraph prints), and the per-page `claimVerifier`, `claimRetrieve` and
  `changedCandidateGrounding` gates default to no tier. Measured on the Quick Draft runs that
  day, the review was 100–300 s of every chapter, 50–70 claims a history chapter with 0–26
  supported, one repair that cut a chapter by 40% and dropped the brief's own subject, and a
  "Review required" verdict on every book, mostly over definitions, caveats and document titles.
  The modules and their tests stay (the tests switch the review on with a module mock), like the
  shelved arc, and the pass reaches them through `reviewChapterClaims` in `composedExperiments.ts`
  (below). Case-evidence packets (`caseEvidence`, shelved) still take their own review, which is
  what that call still runs for a stored plan that carries them. The writer's
  contract follows the same switch: research-led nonfiction was forced onto the grounded contract
  because the review checked it, so with the review off the `creativeContract` gate decides for every
  book (`prepareBookMaterial`), and a nonfiction writer under it gets `CREATIVE_CONTRACT_RULES` and
  the creative dossier line instead of "omit the unsupported specific" — hedging about what the
  sources "do not establish" was the blind readers' first complaint on every grounded book. The forced
  dossier is not the review's, though, and stays on every tier for a book written from sources (the
  entry after next says which that is): making it the switch's too (so Quick
  Draft skipped `plan-episodes` and the dossier, two to three minutes a book) lost 6 of 6 blind
  readings the same day, the readers naming exactly what the passages had carried — the IRS
  thresholds, McLean's own words, the studies a guide cited — and the no-passage instruction turned
  every opening abstract.
- **The composed pass's shelved arms run behind one seam, `composedExperiments.ts`, and what a
  stored plan carries still reaches them.** The pass used to thread five measured-off arms through
  its loop and sat at 889 of 900 lines. The book arc and the seams rewrite (`BOOK_ARC`,
  `SEAMS_TOGETHER`, both off; `prepareBookArc`, `rewriteSeamsAfterRead`), the claim review
  (`reviewChapterClaims`), and the developmental edit (`developmentalEditApplies`, the
  `developmentalEdit` gate, shelved) are each one call from the pass now. A stored arc still re-cuts
  the pages and reaches the prompts, and a stored plan's case-evidence packets are still reviewed,
  because old plans carry both. Best-of-two chapter drafts with a cross-family judge was the fifth
  arm: `COMPOSE_CANDIDATES` was 1, so its `judgeTextModel` and `createLoggedJudgeTextModel` wiring
  was deleted, and core's `judgeChapterDrafts` stays for `scripts/judge-validation.ts`. Proof that
  no live prompt moved (2026-10-16): four stored books (a Balanced and a Quick Draft novel, a
  Balanced and a Quick Draft nonfiction book), each under revision 73 and under the compiled
  defaults, replayed through the pass before and after with each stored chapter as the compose
  answer. All 341 requests across the eight runs, 126 of them compose or edit, were
  byte-identical, as were the rows, briefs, notes and progress. The harness is under
  `.scratch/harness-redesign-2026-10-15/tools/h11-prompt-capture/`. It gives each purpose a fixed
  latency because with instant fakes chapter N's line edit and chapter N-1's staging race on
  microtasks, and that race decides whether N's editor sees N-1's provisional or final digest. The
  race is real in production too; the harness makes the compose call long enough to settle it.

- **The composed pass's preparation overlaps: the research expansion runs beside the episodes and
  the form plan, and the form plan beside the dossier.** These ran one after another on 2026-09-30's Quick Draft books, which took 11–15
  minutes. The research expansion (`maybeExpandStrategyResearch`) is handed to the pass by
  `generateBook` as `research: { start, ready, readyFor, pendingRows }`: the pass starts it once
  the stance has said the book is written from sources (the entry below) and the material has
  settled the episodes, scoped to the chapters no lead answers for (the entry after it), without
  its step (it would move the bar back under the episodes'), and awaits `readyFor(N)` — chapter N's
  own search — before composing chapter N (the per-chapter readiness entry below), and `ready`
  after the last chapter, so a failed expansion still fails the book; a `finally` in
  `generateBook` waits for it too, so a failed pass never leaves it writing rows behind the job.
  Nothing before that await may read the book's `ResearchSource` rows — `loadResearchNotesForGeneration`
  runs only in `composeOptionsFor`. The expansion's existing-rows guard reads before the dossier
  could have written its `primary-source:` rows, which is why it still expands on a fresh run. The
  form plan (`planComposedForms`, `composedFormPlan.ts`) reads the episodes and never the dossier,
  so `prepareBookMaterial` hands it the settled episodes through `onEpisodes` before gathering any
  source; a planner that ever needs the dossier has to start after `prepareBookMaterial` instead.
  Its promise carries a no-op `catch` because a stop can reject it before the pass awaits it, and
  its step is still announced where it is awaited, so the bar reads "gathering sources" while both
  run. The dossier gathers three chapters at a time (`DOSSIER_CHAPTER_CONCURRENCY`) and six under
  `wideSourceGathering` (Quick Draft): six started the first chapter 20–60 s sooner, but Wikisource
  stopped answering in every round after it was tried, at six and back at three, so what it costs
  the catalogue hosts was never measured. (The third overlap, a chapter's story-state extracts at
  finalize, went with story memory on 2026-10-16: "Story memory" below.)
- **A composed book's stance, brief inventory, episodes and form plan are planned while its reader
  reads the plan, and the run adopts each answer where it would have asked for it.** Harness
  redesign H4 (`.scratch/harness-redesign-2026-10-15/plan.md`, owner's "Yes, prepare early"): nothing
  was composed until stance → episodes → forms had run *after* approval — 109 s to the first
  compose on a Quick Draft 60-page history, 148 s on a Balanced one, 36–49 s on the novels
  (2026-10-16 smoke round). `plan-book` and `revise-plan` queue `PREPARE_COMPOSITION`
  (`../handlers/prepareComposition.ts`) when their door stamped `prepareComposition` on the payload
  — the API's breaker allowed `speculative` work, which a free account past the soft cap is refused
  — for a composed book only, while the plan is still the project's current one. The prep
  (`composedSpeculativePrep.ts`) calls exactly the functions the pass calls, with the inputs it
  would have: `generateAuthorStance` (only when the plan has no usable stance), `takeBriefInventory`
  beside it, `settleBookEpisodes` (the episodes half of the material, split out of
  `startBookMaterial` for this), and `planComposedForms` with `persist: false`. It never searches,
  gathers a source or writes a chapter: a grounded search is a fee on a plan nobody may approve. It
  skips the episodes and forms of a book the shelved development or arc would replan. **Every
  write is fenced**: `writePreparedPlan` (`composedPrepRecord.ts`) is `persistPlanField`'s CAS inside
  a transaction that first holds the prep's own `GenerationJob` row `FOR SHARE` while ACTIVE, and
  writes each step's answer with its outcome (`stored`, `skipped`, `failed`) in
  `planningPackage.compositionPrep`, beside a fingerprint of the input, the gate settings and
  `MOCK_AI`. Fields are written once; the form plan is stored as `planningPackage.compositions`
  with a digest of the inputs that vary between runs (stance, ranges, episodes, setting, the brief's
  asks), the cast and toolkit beside it in the same write.
  **The run** (`composedPrepHandoff.ts`, opened at the top of the pass) cancels a prep still QUEUED,
  discards every field a prep planned under another fingerprint (an approval that switched
  illustrations off rewrites the snapshot), and otherwise adopts the record (`adoptedBy`) and
  reads each step with `forStep` exactly where it would have made the call: the stance before
  anything, the inventory beside it, the episodes before the material, the forms where
  `startForms` plans them — so a prep still running is waited for step by step and the dossier
  still overlaps the form plan. A step the prep failed, or did not answer within
  `PREP_STEP_WAIT_MS` (150 s), is the run's again, and the run first **fences** the prep: its row
  goes CANCELED (never FAILED: no alert, no push misread), which waits behind any prep write in
  flight and refuses every later one, so nothing the prep plans afterwards can land beside the run's
  own answer. A failed brief inventory fences nothing, since nothing else depends on it. The run
  also fences before the shelved development and arc, which compare and rewrite the plan.
  `planComposedForms` hands the stored form plan back only on a fresh run whose own digest matches
  (`generation.composed_chapters.forms_reused`), read through the same schema a computed one is, so
  `composedSpeculativePrep.test.ts` holds every compose prompt byte-identical between a book prepared
  before approval and the same book planned after it, through a store that reorders keys as `jsonb`
  does. A revision strips the prep's fields off the plan it revises (they were planned for the old
  chapters), and `persistPreparedComposedPlan` drops `compositions` and `instructionalSetting` when
  development replaces the chapters. The prep's calls are costed to the book's owner
  (`providerSpendUser.ts`), so the breaker counts them; the Operations tab attributes an approved
  plan's prep to its book charge through the job's `planId`, and leaves an abandoned one unbilled.
  Resume is unchanged: `composedResumeState` never reads the record, and a resumed run plans its
  remaining forms against the finished chapters as before (`fixed` non-empty never reuses).
  **What it costs**: the prep's calls on a plan nobody approves (stance, inventory, episodes, forms:
  about $0.005–0.01), and a guide's setting is now stored with its episodes
  (`instructionalSetting`), so a run that adopts stored episodes plans its forms with the same
  country.
- **A composed chapter waits for its own material, never every chapter's, and the whole dossier
  is still stored once.** `startBookMaterial` returns once the episodes are settled and the
  gathering has started: `dossierFor(N)` resolves when chapter N's retrieval does (the stored
  dossier's entries and what this run gathered for N — excerpts and documents are keyed by
  chapter, so N's view is exactly the whole dossier's), `whole` when every chapter has, the dossier
  is persisted through the same `persistPlanField("dossier")` and its rows written in the same one
  `createMany` (`recordDossierSources`), so a resume still finds both or neither. Until then a
  chapter reads the rows gathered so far from memory (`pendingRows`, passed to
  `loadResearchNotesForGeneration`; the expansion's `pendingRows` likewise), so chapter N has its own
  lead notes before the table does; another chapter's rows reach N's notes only if they have
  settled, which moves only the low-ranked tail of a chapter with fewer own rows than the cap. A
  chapter still gathering when the pass starts writing does not move the bar back
  (`progress.muted`), a gathering that fails rejects every chapter still waiting, and the pass waits
  for `whole` before finalize (and in a `finally`, so a failed pass leaves no write behind the job).
  This is the API H8 builds two-at-a-time composition on: `dossierFor(N)` and `readyFor(N)`.
- **A chapter's length is a console diagnostic; the reader hears about length only when the PDF
  printed fewer pages than were paid for.** Since 2026-10-15 `CHAPTER_LENGTH_SHORTFALL` reaches no
  reader's grade (`readerFindings.ts`): every one of the 65 books that carried it in the 20 days
  before printed its paid pages, while it blocked 19 of 26 blocked books. The reader's one length
  finding is `BOOK_PRINTED_SHORT`, measured by the render (→ `../handlers/CLAUDE.md`). What follows
  is how the console's errors and warnings are still told apart.
  **The length floor that errs is the book's, at the share of it that still prints the paid
  pages; a chapter under its own minimum in a book over that floor is a warning, and a stub is
  still an error.** `composedChapterLengthIssues` used to raise an
  error for any chapter 3% or more under its minimum, whatever the rest of the book did. But what
  the reader paid for is the book's pages, the writer's one length retry is against the chapter's
  minimum and keeps the longer draft, and asking for more moves nothing
  (→ packages/core/src/generation/CLAUDE.md), so single chapters land 5–10% under while their
  siblings run over: on 2026-09-30 a history at 108% of its floor and a narrative at 105% both
  went to "Review required" over one chapter 8–9% short. Now a shortfall is an error only when the
  book as a whole is under `LENGTH_FLOOR_SHARE` (0.85, core `printedLength.ts`) of the sum of its
  chapters' minimums, or the chapter is under `STUB_SHARE` (three quarters) of its own; otherwise it
  is a warning that also states the book's total.
  Replayed over the 40 composed books stored since the 2026-09-20 budget fix, the old rule blocked
  ten and this one two — the eight released are 3–17% over their floor as books, the two kept have
  a chapter at 65–69% of its minimum. The near-miss rule (under 3%) is unchanged. The compose
  call's length retry follows the same rule: the pass hands `composeChapter` a `lengthSlack` — what
  earlier drafts ran over their minimums, surpluses counted at `SLACK_KEPT_SHARE` (0.7, set for the
  line editor's cuts and kept for the manuscript read's) — and a shortfall the slack covers is not retried unless the draft is under three
  quarters of its minimum. Quick Draft books had paid one to three serial retries of 20–30 s.
  **The floor is what prints, and every check that reads a minimum reads it the same way.** On
  2026-10-01 the full sum blocked five books (and two more that night) at 0.94–0.995 of it, and
  every one printed exactly its paid pages: the history books had lost their narration padding,
  the fact ledger stopped restatement, and the guides and workbooks print worksheets — so tight the
  fitter had to *tighten* five of the seven. Cutting the densest stored book (a prose-only history)
  paragraph by paragraph through `fitBookPdfPageCount`, it printed all 28 pages down to 0.80 of its
  floor and lost one at 0.74, and at 0.85 the page reads as the house page, a little airier. Replayed
  over the 75 composed books stored since 2026-09-20 the full sum blocked 9 and the share blocks the
  2 with a stub chapter (65–69%), both of which printed full; whether a stub chapter is a defect a
  reader sees has not been measured. The measure counts a table row at its own words plus
  `TABLE_ROW_ROOM_WORDS` (cells were always readable words; a blank worksheet row prints a full row,
  and sixteen rendered guides and workbooks printed 13–38 words of room a row against 4–20 counted),
  which takes 11 of 13 stored workbook chapters off "under minimum". The compose retry fires under
  the share (unless the slack covers it), an edit that is not a factual correction may cut to the
  share and never under it nor under a draft already below it (core `editShortensPastFloor`; the line
  edit was its caller until 2026-10-16), and a length retry whose call fails
  — truncated, refused or unreachable — keeps the earlier draft and writes
  `generation.composed_chapters.length_retry_failed`, since the chapter exists and only its second
  try failed. A Quick Draft guide failed whole on exactly that in both its attempts (a whitespace
  runaway, then five connection errors), and 32 of the 44 stored retries had asked again for a
  draft at 0.85–0.99.
- **The compile's brief inventory is taken while the chapters are written, and only an available
  one is stored.** It is also what gives each of the brief's asks a section in the form plan
  (→ packages/core/src/generation/CLAUDE.md), so `takeBriefInventory` starts at the top of the pass,
  beside the stance, the form plan waits for it (it is ready long before on a sourced book), and
  `storeBriefInventory` writes it later; a book whose every page is written takes none. The
  compile checks the finished book against the request in two calls, one
  after the other: `inventory-brief-requirements`, which reads only the brief, and the coverage
  read, which needs the manuscript — 28 s and 40 s of a 55–90 s compile on the Quick Draft books.
  `manuscriptCoverageForCompile` already reuses an inventory the plan carries
  (`matchingRequirementInventory`: `version: 1`, the same brief — what `requireScope: true`
  produces, and how the picture-book path has always worked), so `takeBriefInventory`
  (`composedBriefInventory.ts`) takes it in the background and writes it to
  `planningPackage.requirementInventory` through `persistPlanField`. It starts after the stance and
  the development step, because `persistPreparedComposedPlan` refuses a plan row that changed
  under it and `persistGeneratedAuthorStance` is a read-modify-write that would lose the field. It
  never rejects, and an `unavailable` attempt is not stored: the compile reuses even a failed
  inventory it finds, so storing one would turn a provider blip into "coverage unverified".
  **No tier makes the coverage read by default** (`briefCoverageReview`, off on fast
  since Parsa, 2026-10-01, and on Balanced since 2026-10-16, when its Balanced findings labelled real
  27–40% of the time, and on Premium and Ultra too, where the owner declined to keep it unmeasured;
  a revision that lists the gate still runs it): it was 26–67 s after the last chapter, and on the 2026-09-30 Quick Draft books it
  marked every requirement fulfilled, gaps the blind readers named included. The skip lives in
  `compileExport.ts` (`coverageSkipped`) and covers every Quick Draft book, composed or written
  page by page: its one compile screen (`reviewQuickDraftManuscript`) is shown the request beside
  the whole manuscript and flags missing essential content, so neither brief call is made. That
  the read is as weak on a per-page book is inferred from the composed measurement, not measured.
  Since 2026-10-16 a per-page book on any tier answers to the same gate (it used to take both calls
  inside the old final review's lease whatever the gate said; → `../handlers/CLAUDE.md`, "A
  compile's verdict"). Skipped, the compile files **nothing** in the read's place: no
  `briefCoverage`, no `BRIEF_COVERAGE_UNVERIFIED`, and no unpaid-promise fallback (the
  `unpaidPromiseQualityIssues` check went with story memory on 2026-10-16). The inventory is still taken, because the form plan is its other reader.
- **A sourced chapter's research notes are its leads' answers, and only a chapter without lead
  notes makes a chapter-research search.** Why and what it measured is in
  `packages/core/src/generation/CLAUDE.md`; this is the wiring. The pass hands `prepareBookMaterial`
  its `case-source-search` as `leadResearch` only when the strategy has a `researchDepth` (the plain
  composed strategy never expanded research), and `retrieveChapterSources` searches each lead
  through `leadSearch`, told which lead the round's query belongs to. Before any source is
  gathered, `prepareBookMaterial` calls `onResearchScope` exactly once: with
  `researchScopeBeyondLeads` of the chapters it is about to gather that have planned leads, or with
  `undefined` — the whole expansion, as before — when none will have lead notes this run (no lead
  search, `persist: false`, or a dossier an earlier run stored). The pass starts the expansion from
  that callback, once, and again after the material as a no-op fallback; `generateBook` searches
  `scopedResearchPlan` of the plan. The lead rows go into `recordDossierSources`' one `createMany`
  with the `primary-source:` rows, after the dossier is persisted, so a resume finds both or
  neither: a resume over a stored dossier gathers nothing, owes the whole expansion, and the
  expansion's existing-rows guard skips it because those rows are there — and a run that crashed
  between persisting the dossier and writing its rows gets today's chapter-research for every
  chapter instead, unless an earlier scoped expansion already wrote. The run log records
  `generation.composed_chapters.research_scope` and `.lead_notes` (answers, truncated, notes).
- **Whether a book is written from sources is the stance's answer about the book as described;
  the writing mode answers only for a stance that did not say.** Parsa, 2026-09-30: "only if the
  description of the book fits it, not for an imaginary novel". Three things gather sources in the
  composed pass — the per-chapter web research (`maybeExpandStrategyResearch`), the episodes and
  the dossier — and what decided them was the category plus a cue-word guess
  (`supportsBookDevelopment`), or nothing at all: the web research ran for every composed book, and
  `materialFirst` (balanced and up on the live revision) planned "documented episodes" and a
  dossier for novels too. A fantasy novel about "the last era of a dying dynasty" read as an
  analytical history and was researched like one; a true story filed under Story was researched
  not at all. The stance now carries `research: "sources" | "none"` (`STANCE_RESEARCH_RULE`, asked
  by `generateAuthorStance` and, in the same words, of the planner), and `sourceResearchFits`
  (core, `bookDevelopment.ts`) reads it: the pass starts the web research only on `sources`,
  `prepareBookMaterial` plans episodes and gathers only on `sources` — under `materialFirst` as
  well — and hands `composeChapter` `sourced: false` otherwise, because that function rewrites a
  nonfiction chapter with no passages ("No actual source passages have been supplied…", scenes
  turned into arguments) and a book that gathered nothing on purpose is not a book whose passages
  went missing. That leaves `materialFirst` inert for every real book: `sourceResearch` is the
  stance's answer whenever `MOCK_AI` is off, so `materialFirst && fits` adds nothing to it. Only a
  `MOCK_AI` run reads the gate, where it lets a sourced book plan its fake episodes and gather a
  dossier from the live catalogues; its console copy says so (2026-10-16). The doubtful case answers `sources`, since skipping them where they were needed
  lost 12 of 12 blind readings the same day; an unreadable answer costs the decision, never the
  stance (`.catch(undefined)`); episodes an earlier run stored stay in use when a regenerated
  stance changes its mind, without gathering anything new; and the run log says which way it went
  and who decided (`generation.composed_chapters.source_research`). The first live run: an Apollo
  13 narrative under Story gathered, and a novel, a fable and that fantasy novel searched nothing.
  The writing mode follows the same answer now (`inferWritingMode`, → packages/core/src/generation/CLAUDE.md);
  the per-page strategies, which have no stance, still expand research for every book.
- **Every per-page path reads a stored figure as its stand-in and stores no figure of its own.**
  `toPriorPageContext` (`bookHelpers.ts`) is where a stored page becomes a prompt's prior-page
  context, so the block becomes `[Figure: title]` there and the summary is run through
  `pageDraftSummary` — for the page writer, the reviewer, the
  style lock, the continuation outline (`continuationOutlineWithModel` cuts its excerpt the same
  way, and its `recentPageSummaries` the same summary helper) and every rewrite path; core's `compactPageContexts` (`compactPriorPages` / `compactFollowingPages`) and `pinStyleExcerpts` do it again for a
  context built in memory, and `reviewAppliedBookEdit` reads its before and after pages the same
  way unless the instruction names the figure. The first implementation sent the raw JSON to the
  continuation's outline and page writer. The other direction lives in core, where the draft is
  parsed: `generatePageDraft`, `revisePageDraft` and the tools writer return
  `figureFreeDraft` — a fence in a page writer's reply is a fabrication and a stand-in line an echo
  of a neighbour's excerpt — so nothing in this package strips a draft after the fact. The first
  fix did (`continuationPageDraft`, a strip at the end of `textEditRewrite.ts`), and every review,
  audit and revision between the model and that strip had already read the invention. Replan
  generate is figure-free the same way; `pageFigureRewriteForDraft` plants the source page's fences
  onto that new prose (`reinsertFigureFences`: stand-in, else after the matching anchor, else before
  the follower, else at the end) and then keep-or-holds them. First generate plants; after a keep
  revise it does not — keep at most one fence from what came back, so a clean omit stays omitted.
  Chat (`textEditRewrite.ts`) and replan
  (`reviewReplanCandidate`) both go through `pageFigureRewrite` (replan via that helper) in
  `composedFigures.ts`, so the keep-or-hold decision and the restore cannot be spelled twice.
  `reviewAndSaveGeneratedPage` forwards `figures` into `runPageQualityLoop` the way the loop already
  forwards it to every revise. Restore runs after review returns, not before: the reviewer and a
  later loop revise see stand-ins on hold (or the block on keep), and a default figure-free revise
  cannot strip the chart. The one per-page call allowed a figure is a rewrite whose request names
  the page's figure: `figures: "keep"` on the revise and on the quality loop, keeping at most one
  block from what comes back. A rewrite that is not about the figure holds the block aside — stand-in
  prose, `figures: "hold"` so later revises strip invented fences but keep the `[Figure: …]`
  stand-in, and `restore` puts the original block back beside the paragraph it followed. The compile's
  final-QA repair (`compileExportRepair.ts`) always holds with `holdFiguresAside` and never runs the
  mention test: the first revise is shown stand-in prose, later revises and reviews keep that stand-in
  via `figures: "hold"`, and `restore` puts the original blocks back on the published draft. A page
  with no figure omits the key, so a neighbour's stand-in echoed into the reply is still stripped. It
  has to: core's figure-free revise meant a page repaired from its raw markdown came back without its
  chart and shipped that way, and although `compileExport.ts` skips this loop for a composed book,
  that gate reads the strategy off the *current* input, so a continuation that moves `targetPages` or
  a routing change sends the same stored pages through it. Parse-time `figureFreeDraft` on a replan
  generate or adherence revise would otherwise publish the rebuilt page without its chart.
- **A composed chapter is written against the facts every chapter before it fixed, never one after
  it, and chapter N waits for chapter N-1's.** Every chapter used to be composed blind to the facts
  of the chapters just before it (and no story state is built at all since 2026-10-16).
  Chapter N-1's page notes were still being described while N was composed, so N saw notes from
  N-2 at best, chapter 2 saw none at all, and `continuityNotesForPrompt` then cut the oldest ones
  away. The 2026-09-30 Quick Draft novel dated its founding battle "Fourth of Ashfall" in chapter 1
  and "Frostwane ninth" in 2 and 5. It made Maelin Avar's mother, then his sister, turned its clerk
  into a rider, and changed the aerie's mark between chapters 3 and 4. The workbook gave Mara $2,000
  of monthly essentials and then $2,400. `extract-chapter-facts` (core `chapterFacts.ts`, gate
  `chapterFactLedger`, every tier) reads each composed *draft* the moment it is validated. It gets
  the ledger so far as `knownFacts` and returns at most 14 new `{subject, attribute, value}` facts:
  people's roles, relations, ages and pronouns; dates; places; who holds a story document and what
  it establishes; identifying marks; and a named example person's situation and figures.
  `composedChapterMemory.ts` chains those reads. `composeOptionsFor`
  awaits `ledger.before(N)`, so the compose, the repair edits and
  `acceptsChapterEdit` all see the same `establishedFacts` (the line edit did too, until 2026-10-16). The wait is the ledger's whole cost on
  the critical path. Replayed over the q2 drafts it was 2.5–4.7 s a chapter (mean per book), about
  $0.0005 a call. Composing N from chapters up to N-2 would have cost nothing and missed three of
  those seven contradictions (the date, the Regent's pronoun, the mark), each between neighbours.
  Asking the extractor to flag contradictions instead found one of about four with no reasoning,
  and took 10–41 s with medium reasoning. That is also why the stage takes Quick Draft's
  `describe-pages` route on every tier (`generationStageRoute`): Balanced's own, luna at low
  effort, answered in 6–10 s. The same replay found 5 of the 7 facts in the ledger reliably, the
  mark in one run of two, and never the Regent's pronoun.
  **The ledger is keyed by chapter index, and so is everything else a chapter is told.** A resumed
  run takes done chapters as a set, so it can hold a chapter checkpointed ahead of the failed one it
  redoes. `before(N)` returns only lower chapters, whatever was seeded. Each chapter's facts ride its
  report (`report.facts`) so a resume seeds them rather than paying again, and a done chapter without
  them is re-read from its stored text. `establishedNotes`, the page notes the pass hands forward,
  used to be one list every finished chapter pushed onto, so that redo was handed the later
  chapter's notes. They are per chapter now and read below N (`earlierChapterContext`), and the
  stored notes are bounded at the chapter's first page. A failed read is a chapter the ledger knows
  nothing about (`facts_failed` in the run log); a stop travels.
  **A fact is an attribute and a short value, never text the writer can copy.** The first ledger
  stored free clauses, and a clause about a document is its wording. In the q3 novel (2026-10-01),
  chapter 2's facts carried three quoted margin notes, a dated agreement and a seal's description.
  Chapter 3 was handed them through `establishedFacts` alone, reprinted all five word for word and
  announced the find again, and chapter 5 quoted three once more. That was 33 and 13 six-word runs
  of prose whose only source was the ledger, where every other chapter of four books had 0–3. The
  facts are keyed by attribute now, and code refuses three shapes of value (`newFacts`): any
  quotation mark, more than 16 words, and a nine-word run shared with the chapter. A six-word copy
  check was tried against the stored ledgers and refused mark descriptions and example people's
  roles, which are the facts the ledger exists for. The writer is told a listed document, mark or
  find "is referred to in a clause by what it is — never quoted, read out, described or discovered
  again"; the editor is never to quote one. Re-extracted from q3's stored chapters and recomposed
  from their logged inputs (two runs each), chapter 3's ledger-only six-grams fell from 33 to 1 and
  0 and chapter 5's from 13 to 5 and 0. The prose's six-grams shared with earlier chapters fell from
  32 to 16 and 5 in chapter 3, and from 23 to 12 and 10 in chapter 5.
  **A cited source is named and filed apart, and the latest value of an attribute wins.** Told only
  to skip publications, the extractor spent 17 of the q3 guide's 31 facts on real books, studies and
  agencies. Asked to record them as `kind: "source"` with no facts, it did, and code drops them: 20
  in the guide and 21 in the workbook, leaving two facts about a cited author out of the guide's 14.
  One line per subject shows each attribute once, with its latest value. A line past 1,000
  characters keeps its first attribute (usually who the subject is) and then the most recently set
  ones. The old 800-character clip cut the newest instead, so the workbook's Maya lost every figure
  from chapter 4 on; her line now tops out at 489 characters with all of them. Latest-wins can
  canonise a contradiction the extractor let through, so it is told to give a known attribute again
  only for a change the chapter narrates ("knownFacts stands").
  **The prompts say "consistent with", never "restate".** A prompt field present in every chapter
  gets performed (→ packages/core/src/generation/CLAUDE.md), and restatement is the readers' first
  complaint. So the writer is told the ledger "is for consistency, not material" and that "a person
  returns without being introduced again". The editor may change a contradicting detail as "the one
  change of fact this edit makes". Chapter 1 and every book with the gate off get byte-identical
  prompts. The last chapter is never read, because nothing reads its facts. Reports written before
  attributes existed still parse (`storedChapterFact`). No finalize story state is written since
  2026-10-16 ("Story memory" below).
  **The ledger leaves most of a novel's contradictions standing, and the one measured remedy cost
  the prose.** E7 (2026-10-17, `.scratch/eval-data/reports/e7-narrative-continuity.md`,
  pre-registered) read 21 Quick Draft and Balanced novels as today's pipeline prints them (drafts,
  then the compile's defect screen and repair): blind Opus readers found 113 code-verified
  contradictions between chapters, 5.4 a book, half of them between chapters further apart than
  neighbours, and the screen had fixed 8 others. By hand, 57% concern a fact the later writer was
  never shown (where an object is and who holds it, what it is made of, which bank or side, what a
  character was already told), 13% a sentence that sat verbatim in `previousChapterTail`, 13% a
  ledger line or page note the writer had, and 9% a ledger line or note that was itself stale or
  wrong. Handing the writer every earlier chapter in full (`bookSoFar`, plus a rule to keep its
  details), with one re-ask when the chapter copied it word for word, halved the contradictions over
  63 chapters (70 → 37) and lost on taste, 19 / 15 / 29 (decided 40%, under the 45% floor): readers
  found the chapters less engaging and less clear. So it is not in the product. Do not hand the
  compose call earlier chapters' text without a measurement that clears both halves of the bar.
  **A continuity screen that patches the later chapter failed on precision, and it is not built.**
  E7b (2026-10-17, `.scratch/eval-data/reports/e7b-continuity-screen.md`, pre-registered) checked
  each chapter against the full text of every earlier one, before pagination, in a chain. The check
  ran on luna at low effort, and code applied only minimal find/replace patches whose quotes,
  span and wording it verified. It was cheap: about $0.015 and 7 s a book (medium effort cost two
  minutes a check at p90). On 12 fresh held-out novels, blind Opus readers with the whole book
  labelled 27 of its 32 patches. Only 12 were real contradictions (44%, against a bar of 80%).
  Fourteen made a new problem (52%, against 10%), and six were real, resolved and harmless. The
  misses were a move or change the later chapter itself narrates, a different guard or delivery
  taken for the same one, a negation flipped to "agree", and a real fix in one sentence that left
  later lines stating the old fact. Code checking the quotes and the edit size cannot catch any of
  these. A next attempt has to show its precision on fresh books before anything is built. Its
  leads: a second, verifying read; or only the kinds that were right (a mark, count, side or
  spelling of one object).
  **Re-aiming the ledger and doubling its slots does not reach the facts that get broken, and it is
  not built.** E8 step 1 (2026-10-17, `.scratch/eval-data/reports/e8-ledger-aim.md`,
  pre-registered) started from an audit of the 21 books' 1,244 stored facts. 66 of 101 chapters
  hit the 14-pair cap, and role and pronoun took 41% of the slots, while people were 12% of the
  contradictions. Objects, possession, place and layout were 40% of the contradictions and got
  under 4% of the slots. The rendered ledger never neared its 6,000 characters (max 3,231).
  E8 reran the extraction over the same drafts with the instructions aimed at things (material,
  count, location, holder), layout, order and knowledge. A change to a listed fact came first,
  outside the cap. With 14 or 28 new pairs, blind Opus labellers asked whether the ledger the
  writer of chapter L would have seen held the contradicted fact. Of the 73 facts the writer was
  never or only partly shown, today's prompt held 7, the re-aimed 14-pair one 11, and the 28-pair
  one 20, against a bar of 37. The commonest answer, 46 of 73 at 28 pairs, was that the ledger
  had the subject but not the property that broke: the charter's rollers but not which side of
  the gate the channel ran, the queen but not that she is Tarin's mother. A list written before
  anyone knows what chapter L will touch cannot guess which of an object's many details it will
  reuse. Recording changes first did work: stale-ledger items held 5–6 of 10 against 1, with no
  more wrong lines (1 against 2). It costs latency on the critical path, though: the next compose
  waits for this call, at a median of 6.6 s (14 pairs) or 12.2 s (28) against 3.9 s. Clearing old
  facts would free nothing and lose the facts half the contradictions break, which are two or more
  chapters back.
  **A briefing aimed by the next chapter's plan does no better, and it is not built.** E9 step 1
  (2026-10-17, `.scratch/eval-data/reports/e9-plan-briefing.md`, pre-registered) tested one luna call
  before each chapter that read every earlier chapter in full together with this chapter's plan, and
  wrote up to 60 attribute pairs about everything the plan reaches. It held 30 (effort none) or 32
  (low) of the 73, against a bar of 37. It also stated 8–10 wrong facts across the 113, against 5,
  which is E7b's conflations again: a living rider put in a generations-old campaign, a brother
  made of a father's son. Its latency was 11.7–16.4 s a chapter on the critical path. No list
  shown to the writer in E8 or E9 held more than 44% of the facts that broke, even taking the union
  of three arms, and E7's writer broke listed facts anyway. So don't build another notes-based fix
  without a new reason.
- **A practical guide's or a workbook's whole-book decisions are planned once, stored like the
  cast, and reach every chapter through the compose options.** (→ packages/core/src/generation/CLAUDE.md
  for why the path exists and who takes it.) `planEpisodes` routes a toolkit book to research leads
  on its own, and `prepareBookMaterial` hands their `setting` to the form plan through `onEpisodes`
  beside the episodes; `planComposedForms` calls `planInstructionalForms` instead of
  `planChapterForms` when `usesToolkit` says so, hands back a stored `plan.toolkit` on every later
  run (fresh or resumed, like `plan.exampleCast`), persists a new one through
  `persistPlanField("toolkit")`, and logs `generation.composed_chapters.toolkit_coverage` when a
  requirement was homed by code or is still uncovered. `composeOptionsFor` passes `forms.toolkit`,
  and core's `activeToolkit` decides whether any prompt acts on it. A book already in flight when
  this shipped re-plans its remaining chapters' forms as a toolkit book if the reader chose a guide
  or a workbook, and keeps the documents its stored episodes name.

## Page review

- **No generated page is reviewed or rewritten by a model, on any tier; a reader's chat page
  rewrite is the only page that is.** Every page generation drafts goes through
  `reviewAndSaveGeneratedPage` or the page job (`../handlers/generatePage.ts`) under
  `withoutPageReview` (`pageReview.ts`): the deterministic local checks run and are recorded, and
  `pageModelReview`, `pageQaRewrite`, `smartUnslop`, `styleAuditor` and `changedCandidateGrounding`
  read as off whatever the revision says — the per-page books of every strategy (a KIDS book over
  40 pages, a picture book on the sequential path, an explicit chapter or batch strategy), a
  whole-book draft under five pages (`wholeBookPageReview.ts`), and the pages a continuation, a
  structural insert or a replan drafts. A page whose checks fail is saved FAILED_QA as drafted.
  E4 measured this chain against the raw draft on the short books, on gpt-6-luna, which drafts every
  tier: 3 wins / 7 ties / 7 losses (`.scratch/eval-data/reports/e4-review-audit.md`); the dev
  database has never held a long per-page book to measure it on, so E5
  (`.scratch/eval-data/reports/e5-final-review-sweep.md`) applied that result to every other page
  generation drafts, under the owner's rule that an unproven review goes. What stays: the edit's own
  adherence review over a continuation's, an insert's or a replan's new pages (the reader's request
  being checked), the repair rounds those loops run on a page that fails its adherence or its local
  checks, the composed finalize's one revise of a page whose integrity checks find a prompt leak or
  a placeholder (`pageQaRewrite`, the repair of a deterministic finding). The story-memory extract
  went too, on 2026-10-16 (E6, "Story memory" below). The chat
  rewrite (`textEditRewrite.ts`) keeps `runPageQualityLoop` and every one of those gates, unchanged.
  The loop's other branches — the brief repair and its durable chapter write, the recovery
  rewrites, the sentence-length repair, the failed-claim retrieve, the no-improvement stop and the
  saved-keeper seed — had no caller after that and were deleted on 2026-10-16 (E6,
  `.scratch/eval-data/reports/e6-story-memory.md`), with core's `repairPageBrief`, its
  `repair-page-brief` route and `tuning.ts`'s tier-scaled page-QA budgets.

## Short books

- **A short book's first draft is checked by code and saved as written: no tier polishes it or puts
  a model review on its pages.** The draft-then-polish pass (5–11 pages, picture books up to 40,
  illustrated stories up to 16; the name is historical) saves each page of the whole-book draft
  through `reviewAndSaveGeneratedPage`, which checks every generated page locally only ("Page
  review" above): the deterministic local checks run and are recorded on the page's report; the model page review, the rewrite loop, Smart Unslop,
  the style audit and the page-time story audit do not, on any tier, and no story state is
  extracted ("Story memory" below). This is the E4 review audit
  (2026-10-16, `.scratch/eval-data/reports/e4-review-audit.md`), blind Opus readers on whole books,
  every arm text the product had produced from the same whole-book draft on today's model:
  per-page polish against the draft, 1 win / 1 tie / 6 losses over 16 Quick Draft books (stopped
  when it could no longer pass); the grouped picture-book review with its finalization repairs and
  the compile's final review against the draft, 7/19/2 over 28 books with three readers per order
  (78% [45–94]: the lower bound is under 50%, 17 books came out byte-identical, a quarter were
  improved); the per-page chain — polish and every review — against the draft, 3/7/7. The review
  loop did beat the *polished* pages (10/5/2), but the readers' reasons were the contradictions and
  repeated beats polish had introduced, and polish is gone. The owner's rule (Parsa, 2026-10-16): a
  review, edit or critic that improves books by 5–10% or not at all is removed, Premium and Ultra
  included. `prepareShortPictureBookReview`, the precomputed-review plumbing in `pageReview.ts`
  and the polish (`polishPageDraft`, `qualityDrafting.ts`) were deleted.
- **`usesShortBookPath` names the short-book path** (it was `usesShortPictureBookReview`), a
  question of shape alone: a children's book of 5–40 requested pages, or an illustrated narrative of
  5–16 on this pass, whose pictures are queued from the draft (below) and whose compile keeps the
  draft's titled partition as its reader chapters. No tier and no setting moves a book on or off it
  since 2026-10-16. The compile's only model read of a short book is the defect screen, on Quick
  Draft alone (H7b: it fixed a real defect in 2 of 17 Quick Draft drafts with every repair preferred,
  and found nothing in 13 Balanced ones; `../handlers/CLAUDE.md`, "The compile's one review"); on
  every other tier, and with `finalBookQa` off, the book is printed as drafted. The old compile final
  review and coordinated short-book repair that `finalReview` (the Balanced, Premium and Ultra
  preset) still ran here were part of the arm that failed above and were deleted that day; the flag
  controls nothing now. Core's `pictureBookReviewKind` still tells a children's book from an
  illustrated story (a story is judged by its own audience, not by age-appropriateness and
  read-aloud simplicity). Only a narrative counts
  (`isNarrativeWritingMode` over `inferWritingMode`, so the planner's `children-narrative` counts
  too — it is what an illustrated children's story filed as STORY carries): a short illustrated
  guide, and a text-only story, stay on their pages. No book takes the cue-word research test,
  because every app CUSTOM Auto brief trips it ("Decide the real book shape"), and a children's
  brief carries the creation chat's own words: "the real treasure" took a 10-page otter story off
  the path on 2026-10-17, so it lost its early pictures and its draft-decided sheets. A research
  strategy still opts out (`researchDepth`), which is where the router sends a factual picture
  book of 12 pages or more.

## Story memory

- **No page pays for story memory: nothing extracts story state on any tier, and later pages read
  the plan's promises.** Story memory (`storyExtractAudit`, "Story memory" on the Quality tab) was one
  `extract-story-state` call per saved page — at the page save, after a whole-book draft
  (`persistBookStoryDeltas`), at the composed finalize (`persistChapterStoryDeltas`), and again for
  every page a continuation, replan, insert or chat edit wrote — folding promises, facts and
  entities into `Page.storyDelta` and `Project.storyState`. Its only route to prose was the
  "Current story state:" block a *later* page's writer reads (`formatStoryStateLines`, as
  `entityState`; at most twelve lines, promises first). Revision 7 had turned it off on Balanced and
  Quick Draft deferred it, so while a book was generated it ran on Premium and Ultra alone. E6
  (`.scratch/eval-data/reports/e6-story-memory.md`, pre-registered in
  `.scratch/eval-data/e6/preregistration.md`) replayed the continuation writer on today's live route
  (gpt-6-luna) over 30 stored books with a complete set of deltas — the next two or three pages after
  a cut at 70%, once with the state folded from the deltas and once with the plan's promises alone —
  and blind Opus readers, both orders, judging continuity first: 7 wins / 4 ties / 10 losses, a
  decided share of 41% [22–64], stopped at 21 of 30 pairs because the rule (≥ 60%, lower bound
  > 50%) could no longer pass; Premium/Ultra books alone went 2 / 0 / 4. Under the owner's rule it
  was removed on every tier, Premium and Ultra included, and `storyNotesTogether`, which only
  scheduled the extracts, with it (both in `REMOVED_QUALITY_FEATURE_IDS`).
  What is left: planning seeds `Project.storyState` with the plan's promises, and every writer that
  read the state reads that seed through `loadProjectStoryState` / `formatStoryStateLines` — the
  arm that won — and an older Premium or Ultra book reads the fold its pages were extracted with.
  Nothing writes a delta: a chat page edit clears the delta of each page it rewrites
  (`storyDeltaAfter: null`, so a page no longer briefs later drafts with what the reader paid to
  change; Undo restores the old one), and Undo, Redo, a structural rollback and the compile still
  rebuild `Project.storyState` from whatever deltas the rows hold (`packages/db`). The compile's
  unpaid-promise warning, which only ran with the gate on, went with it. One reader signal did not
  decide the rule and is reported beside it: in 5 of the 21 judged pairs readers in both orders
  flagged a contradiction of the book only in the arm without memory, and never the other way.
  **E6b followed that signal up with memory nobody pays extra for, and it made continuations
  worse.** (`.scratch/eval-data/reports/e6b-continuation-memory.md`, pre-registered.) A composed
  chapter's continuity ledger (`report.facts`, which `extract-chapter-facts` already writes for every
  chapter but the last) was appended to the promise lines of a continuation's writer — one line a
  subject, latest values, the subjects the next pages name first, inside the story-state slice —
  over 24 Quick Draft and Balanced books cut at a chapter boundary. Code-verified contradictions
  (both quotes found): the ledger arm alone in 4 samples, today's arm alone in **0**, both in 4; on
  taste 7 / 2 / 10, decided 41%. Stopped at 19 of 24 when the pre-registered rule (net ≥ 10% fewer
  contradictions, decided ≥ 45%) could no longer pass. Three of the four traced to what the ledger
  showed: a fact stale since the last chapter, whose facts are never taken ("held by: Mira" after
  Sella took the survey), a partial figure read as the whole record (three months of receipts → "the
  other months are not represented"), and a date used to build a wrong order. So a continuation, an
  insert and a replan read no ledger; do not add one back without a measurement that clears that bar.

## Illustrated page publication

- **The keeper, its generated asset, and terminal status share one ownership protocol.**
  `pagePublication.ts` is the common seam for the direct page handler and whole-book generation:
  keeper prose is staged under an optimistic `updatedAt` claim while the page is non-terminal, a
  tokened `GenerationJob` is made durable with no database transaction held across that queue call,
  and only then does an exact content/version claim expose `COMPLETED` together with page-owned
  continuity notes. A replacement stage retires only assets carrying the previous keeper's token or
  reserved legacy system path in the same transaction as the prose change; same-keeper renders and
  operation-suffixed manual assets survive. Before structural reindexing, numeric legacy filenames
  are resolved against the complete pre-edit index-to-page-id snapshot, even when attached to a
  different page; a missing source receives a durable migration sentinel, so neither cleanup path
  can later adopt the moved asset when its destination inherits that number. Whole-book retries keep
  accepted page ids stable so a job already made durable can prove the same keeper or stand down
  against its replacement. Pages
  the strategy does not illustrate remain terminal in the manuscript transaction and never acquire
  an artificial image dependency.
- **A picture book's pictures are queued from its checkpointed draft, as the job its publication
  would have queued.** A page's picture used to wait for that page's review and save, and on the
  tiers that ran it for the compile's whole final review, although the whole-book draft had already
  fixed the scene: on 2026-09-28 a 10-page Quick Draft picture book finished its draft at 0:53 and
  started its last picture at 5:18. `enqueueDraftPageIllustrations` (`draftIllustrations.ts`) runs
  in the draft-then-polish pass once the reference sheets are committed, on the picture-book path, where nothing in generation changes a page since 2026-10-16 (no polish, no page-time model review), so the draft is the keeper. It queues each illustrated PENDING row's picture under that row's own keeper
  token. **Two things keep that free, and both are easy to break from elsewhere.** The token is
  `title, markdown, summary, imagePrompt, revision`, and an unchanged page stages exactly the
  checkpoint's fields at revision 1, so a token that grows a field the PENDING row does not share
  (its status, say), or a checkpoint that stops writing revision 1, buys every early picture twice.
  And publication, finalization and replan all build the row's identity through
  `pageIllustrationJobDedupeKey`: that is how `publishStagedGeneratedPage` and
  `enqueueFinalizationIllustrations` land on the early row instead of minting a second one. A
  keeper that changes before it is published gets a new token, so the early job stands down at
  `generateImage`'s ownership checks or staging retires what it stored, and the new keeper is drawn
  at publication or at finalization. A changed page can therefore cost one more picture, but it can
  never ship a picture of the old one. Every illustrated page is drawn early, on every tier: the grouped review that used to hold back a page it refused, and the rule that under `finalReview` only a page a model review had approved was drawn early, went with the generation-time review (E4, "Short books" above). The only later change is a repair by Quick Draft's defect screen; that page takes a new revision, so a new keeper token and its own picture at the compile's finalization — the price of a repair is one more picture, never a picture of the old page. And no generation pass defers a picture to the compile any more: the whole-book, chapter and batch passes and `generate-page` used to under `finalReview` (and `generate-page` for parallel waves under `finalBookQa`), waiting for a final review that no longer runs on those books; that publication option is gone.

## Structural page edits

- **A structural shift and every write after it belong to one durable, expiring delivery lease.**
  The stamp `pageRestructure.ts` writes last proves the shift landed, but it does not say which of
  two live Bull deliveries may draft those pages. The old transaction lock stopped a double shift,
  then returned `already-applied` to its loser and deliberately let that loser fall through: both
  deliveries drafted and settled, and either catch could roll the winner's shape back. The shift's
  transaction now opens with one database-time CAS over `structuralLeaseToken` /
  `structuralLeaseExpiresAt`; a live owner makes the loser wait, while expiry lets a real crash
  redelivery take over the stamp's page ids. The owner heartbeats through provider calls, and the
  same unexpired token fences the page save, the APPLIED write, the refusal's own settlement
  (`settleSkippedStructuralPageLeaseTx` — reached *after* a refund the heartbeat has to carry the
  lease through, or expiry lets a replacement start shifting while the stale settle calls its live
  edit a delivered no-op), and the first **operation-row** statement of rollback. Transactions that
  also touch Project take the Project row first, matching Stop; operation-only page writes still
  begin with the lease CAS.
  `structuralLeaseCompletedAt` is written only after the export tail, so a waiter cannot mark the
  shared durable job complete under a winner still running. Lease comparison uses Postgres time:
  an expired zombie may neither renew itself nor publish or revert after its replacement owns the
  row. Keep lease fields out of `classifier`; stamp/rollback merge that whole JSON document.
  **And the page save is not one write.** The fence sat before the `Page` upsert and nowhere after
  it, so a delivery that lost the row inside the tail still published the keeper's story delta
  (extracted until 2026-10-16), its continuity notes, its entity state and its page embedding,
  every one of which the *next* page reads back: the winner's manuscript carrying the loser's facts,
  notes and vectors for prose no reader will ever see. The page row is the one thing that did not
  matter there, because it is keyed on `projectId_index` and the winner drafts the same ids.
  `reviewAndSaveGeneratedPage` is therefore two halves — every provider call first, holding its
  answers in memory and writing nothing (`prepareEmbedding`), then one
  assertion, then only writes with nothing slow between them — and its hook is named
  `assertOwnership` because it is asked three times, not once. The hook stays optional, so the callers
  with no lease (the book passes, `continueBook`) are unchanged. (The page-QA brief repair's durable
  `Chapter.productionBrief` write was fenced the same way, and deferred until the page kept a draft
  the repair briefed; it went with the per-page review chain on 2026-10-16.)
  **And every wait on that lease ends.**   `waitForStructuralPageLease` and
  `waitForStructuralPageLeaseCompletion` polled forever, and neither state they poll for is
  promised. `structuralLeaseCompletedAt` is the *owner's* write, so a delivery whose lease expired
  with nobody left to take it polls for a write nothing is going to make — and nobody can take it,
  because that delivery is still awaiting inside its BullMQ processor, whose job lock keeps being
  renewed, so no redelivery ever arrives. A `busy` claim clears when the owner finishes or its
  lease expires, and an owner wedged on a call that never returns does neither while its heartbeat
  renews. Either shape cost a worker concurrency slot until the process restarted. Both waits now
  stop after `STRUCTURAL_PAGE_LEASE_WAIT_MS` — five renewals' worth, because giving up on a live
  delivery is the expensive mistake — and **say so**: `{ outcome: "abandoned" }` and `"abandoned"`,
  never a silent return that reads like the winner finished. Acquire-wait `abandoned` is still a
  *busy* owner (a 10-page insert routinely outlasts the budget), so the waiter must not complete
  the shared job; completion-wait `abandoned` is an orphaned shift. What each caller owes is in
  `apps/worker/src/handlers/CLAUDE.md`.
- **Every read the shift is derived from is taken under the claim, and reconciled against what the
  claim actually finds.** The claim fences a second delivery of the *same operation* and nothing
  else on the project, so it never closed the window the plan was built in: the quote resolved
  against a page read at propose time, and `restructurePages.ts` took another before the plan
  versions, the providers and the transaction. `applyPageOrder` needs the ordering to name **every**
  page, because `pageOrderStatements` un-parks every negative row in one pass — so a `Page` created
  or deleted in that window is a `23505` on `@@unique([projectId, index])` where a parked row
  collides with a live page, or a silent hole in `1..N` where they miss, invisible until a compile
  refuses the book. The page read now happens inside the claimed transaction and goes through
  `reconcileStructuralPagePlan` (`packages/core/src/generation/pageRestructure.ts`), which **re-fits
  and never re-resolves** — a request names indexes, a plan names ids, so re-resolving would
  silently retarget the edit at whatever now sits at index 7. It drops removed ids that have already
  gone, keeps the planned sequence for pages that survive, appends pages the plan never saw at the
  tail, renumbers from 1, re-clamps an insert anchor past the new end and re-reads the host chapter;
  a plan nothing had to repair comes back by identity, which is what stops it laying its own opinion
  of the chapter counts over the resolver's on every ordinary edit. It re-applies the resolver's own
  guards to the live read and may answer `stale`, which settles free. `restoredPageOrder` in
  `packages/db/src/pageRestructureRevert.ts` is the undo-side twin and does the same four steps; the
  one deliberate asymmetry is that an apply may refuse and an undo may not, because an undo has to
  restore.
  **The plan version's *number* is one of those reads.** `nextPlanVersion` ran before the
  transaction opened, so the entire shift sat between "which number is free" and the `create` that
  takes it, and `PlanVersion` carries `@@unique([projectId, version])`. Any writer committing a plan
  version for the project in that window made the create a `23505` that rolled the whole shift back,
  and `apply-book-edit` has no retry budget — `retryJobOptions` names `generate-page`,
  `generate-book` and `generate-audiobook` and nothing else — so the delivery went to `markFailed`:
  the edit fails and refunds over a number, on a book nothing was wrong with. (It does not fail the
  *book*: an `operationId` on the payload sends `markFailed` down the edit branch, which fails the
  operation, refunds the attempt and puts the project back COMPLETE from EDITING.) It is derived
  inside the transaction now, from `tx`, and deliberately placed one statement after the base
  version is superseded — that `UPDATE` holds the base row's write lock, and superseding the plan
  being replaced is what `continueBook`, `replanBook` and `revisePlan` all do before their own
  create, so a competitor is blocked behind that row before this read runs. A writer that takes no
  such lock (the operator's `plan-book` route, `scripts/repair-plan-from-run-log.ts`) still can, so
  the create is replayed once on a version conflict and only on that one — safe precisely because
  every read now sits inside, so the replay re-reads and re-reconciles instead of writing stale
  numbers over a book that moved. `nextPlanVersion`'s other four callers still read outside their
  transactions and are not protected by that ordering.
- **A moved page's old chapter rides the same stamp as its old index.** A move across chapter
  boundaries updates `Page.chapterId` after applying the order, so restoring the order alone leaves
  the prose under the destination heading. The pre-edit read already carries nullable `chapterId`;
  `StructuralApplication.pageOrderBefore` persists it and the shared DB revert restores it for both
  reader Undo and drafting-failure rollback. Legacy stamps omit the field and deliberately leave
  current membership untouched. **That re-home write carries no chapter predicate of its own**, and
  the reason is three-valued logic: it used to filter `chapterId: { not: destination }` as a second
  opinion, which Prisma compiles to a bare `"chapterId" <> $1` — UNKNOWN, and so no update, for a
  page whose chapter is null. Pages in no chapter are ordinary (`Page.chapter` is
  `onDelete: SetNull`, and the whole-book saves store a page outside every chapter range with a null
  id), so moving one into the middle of a chapter printed it there while it still belonged to
  nothing, and `chapterPageCounts` — which counts truthy ids only — then disagreed with the page
  order the headings are walked against. `pagesToRehome` already drops every page sitting in its
  destination, so the grouping is the whole filter and the statement writes the rows it names.
- **A page renumber carries the page map with it; only a sheet that would lose its page clears it.**
  `pageRestructure.ts` used to null `Project.pdfPageMap` in the apply transaction, and
  `revertStructuralPageChange` (`packages/db`) did the same on the way back, on the grounds that
  the map describes a pagination the book no longer has. It does — but the *file* it describes is
  the one the reader is still looking at, because the exports rebuild asynchronously and
  `bookPageMapForProject` deliberately keeps a behind map in force while the project is EDITING.
  Which is a rule about the *handler* too, not only about this write: `restructurePages.ts` may not
  retire EDITING before its recompile publishes, or the map it just re-pointed is refused from the
  instant the edit lands (see `apps/worker/src/handlers/CLAUDE.md`).
  Nulling it there made a typed "page 12" fall back to a model index while printed page 12 was
  still on screen; selection-composed edits send `pageIndex` and never noticed. So the ranges stay
  and the model indexes move: `pageIndexMovesForStructuralPlan` (core) says where each index
  lands, and `repointedPageMapUpdate` (`packages/db/src/pageOrdering.ts`) is the write both sides
  share — the same shape as `repointPageEmbeddings`, which re-points the `page:<index>` memory
  scopes in that very transaction for the same reason. **A map that would lose a range is refused
  whole**, which is a delete as it is applied and an insert as it is undone: a measured map's
  ranges run contiguously from the first anchor to the last content page, `pdfPageZone` rests on
  that, and a hole would have the chat answer "printed page 5 is the Sources list" about a page
  the reader can still read. No map at all is merely the old behaviour. **What is refused is the
  ranges, not the column**: they degrade to the `bookPdfCoverNumbering` stub, carrying the stored
  map's version and publication stamp, because the file whose cover chrome is matching did not
  move — nulling it instead dropped `hasCoverPage` off the status DTO on every applied delete, and
  the app numbered the cover as page 1 against a footer that prints nothing on it. A blank column
  and a stub already stored are left untouched for the same reason.
- **A compare-and-swap over a JSON column is staked on the document the row stores, never on what
  that document parses to.** `chapterBriefSchema` is a `z.preprocess`, so its parse is not an
  identity: it renames `visualMoment`/`imagePrompt` to `imageMoment`, `.default([])`s
  `requiredContinuity` and `continuityFocus`, and strips every key it does not name. Staking
  `where: { productionBrief: { equals: … } }` on the *parse* therefore named a document the column
  had never held, and matched zero rows on every attempt, forever, for that row — three
  `updateMany` plus three `findUnique` and a "lost the CAS race" line, per repaired page, keeping
  nothing. No writer in the tree today stores a non-canonical brief (both go through
  `chapterBriefSchema.parse` first), which is exactly why it was invisible: a claim that holds only
  for values the writer itself normalised is not a claim about the row. `readStoredChapterBrief`
  hands back the raw JSON beside its parse; the merge runs on the parse and the predicate names the
  document. Document equality is *finer* than brief equality — two spellings can parse alike, one
  document cannot parse two ways — so the race property is strengthened rather than traded away,
  and the first repair to land canonicalises the row.
  **And a miss the row did not move under is a different fault from a lost race.** Both used to
  print the same line and pay the same three attempts. Re-reading after a miss tells them apart: a
  row that moved is a sibling's repair, so retry; a row that did not is a predicate that cannot
  match, so give up on the first miss and say so in words nobody will confuse with contention.
- **A page that goes away takes its semantic memory with it, because nothing else will.**
  `Embedding` cascades on `Project`, not on `Page` — `sourceId` is a plain string with no foreign
  key — so a deleted page's `page:<index>` rows outlived it, and the renumber in that same
  transaction handed that index to the page moving up into it. The orphan then answered as
  long-range memory *for a live page*, quoting text the book no longer contains, and nothing
  downstream could tell the two apart: `retrieveSemanticPageMemory` dedupes by scope and keeps
  whichever row scored higher, so a survivor's own summary could lose to the deleted page's. Both
  sides delete now, through `deletePageEmbeddings` (`packages/db/src/pageOrdering.ts`) — the apply
  takes `removedPageIds`, and the undo takes `insertedPageIds`, which were drafted and so carry
  summaries of their own. Keyed on `sourceId` and held to `page:%` for the same reasons
  `repointPageEmbeddings` is. The rows are not restorable, so an undo brings a deleted page back
  without its memory; discarded embeddings make that bargain even though page-edit snapshots are
  now archived for structural Undo. It is the right way round — a page absent from long-range
  memory until it is next written is a gap,
  while a page whose embedding describes a different page is a wrong answer nothing detects.
  Page-scoped `ContinuityNote` rows follow the same lifecycle through their nullable `pageId`
  foreign key: every writer stamps the id, deletes cascade (and are explicit in both structural
  transactions), and surviving scopes plus numeric page tags are re-pointed by id. Migration
  000053 backfills rows only for projects with no structural operation; runtime code never infers
  an unowned note's owner from `page:<index>` because an edit may already have reused it. The
  generation loader excludes those ambiguous rows and the next structural change retires them.
- **A structural delete archives every older page-edit snapshot before Page's cascade runs.**
  `ArchivedPageEditSnapshot` carries the original snapshot id and every restore field, linked to
  the original operation but not to the Page being removed. The structural stamp carries only a
  bounded `{key, snapshotCount}` pointer, so classifier JSON never absorbs repeated page prose and
  revert can refuse a partial archive while still read-only. More than 1,000 rows settles the free
  delete unchanged instead of truncating history or overrunning the structural transaction.
- **Two durable leases share a shape, and neither is the other's configuration — the waiters are the proof.**
  `structuralPageLease.ts` and `characterReferenceRenderLease.ts` are both a token beside an expiry
  compared in Postgres time, and the resemblance ends there — so extracting a primitive over them
  would be a parameter bag holding one flag per difference, coupling two things that answer the
  same questions differently on purpose. What the first protects is **manuscript correctness**: the
  token *is* the write fence, re-asked at every statement of the delivery (`assertHeld`,
  `renewStructuralPageLeaseTx`, `markStructuralPageLeaseApplied`, both skip settlements, `release`,
  `complete`), so it has to be renewable and is heartbeated at a third of its budget. What the
  second protects is a **bill**: nothing is fenced on its token, its commit is serialized by the
  advisory lock and settled by `supersedes`, and overrunning costs a duplicated render rather than a
  wrong book — so it is deliberately never renewed. Everything else follows from that one
  difference. **The waiters are not even the same kind of function.**
  `waitForStructuralPageLease` returns a *claim* and its loop body is the CAS: waiting there **is**
  claiming, the waiter is a rival delivery of the same operation, and abandoning writes nothing and
  costs nothing, because `processJob` neither completes nor fails on
  `UnownedStructuralDeliveryError`. `waitForCharacterReferenceRender` returns a *value* and its loop
  body is two reads: the waiter is a consumer — an image or cover job that needs the winner's sheets
  — and abandoning under a live render throws them away. That is the whole reason only the second
  renews its deadline on a relay and then needs a ceiling to bound the renewals, and why copying
  that renewal into the first would only hold a worker slot for a delivery with nothing to gain by
  waiting (`structuralPageLease.test.ts` pins the opposite: "a wedged one renews forever"). They
  agree about a fence row that is *gone* — both stand down — and the second learned it the
  expensive way. An operation row that vanished is `settled`; a plan version deleted mid-render used
  to be `claimed` with a null token and rendered **unclaimed**, on the grounds that the page still
  wants its sheets. But the CAS is a `WHERE "id" = $1`, so a row that is not there matches nothing
  for *everybody*: the advisory lock serializes the claims and nothing serializes the renders, so
  every waiting `generate-image` job plus the cover job was told it won at once and each paid for
  the whole cast — one renderer per plan version inverted into `MAX_PARALLEL_IMAGE_JOBS + 1` of
  them, unbilled, for a plan id no current read resolves, whose settlement `updateMany`s a row that
  is gone and whose commits delete each other's rows. `takeRenderLease` answers `gone` now, the
  caller stands down with the sheets that exist, and `claimed` carries a `string` token so a vanished
  row cannot be spelled as a win. There is no lock order between them either: the first is held only
  by `apply-book-edit` deliveries, the second only by `generate-book`, `generate-image` and
  `generate-cover`. What genuinely *is* one protocol is already shared rather than copied —
  `textEditLease.ts` reuses the `BookEditOperation`
  lease outright for the text apply fork, and even there the skip CAS is a deliberate sibling
  because the two forks' durable markers differ. That is the line: reuse a protocol, never a shape.
  The remaining constants differ for the same reasons and are commented where they sit (poll rates:
  a CAS one rival runs, against reads several jobs run); the two waits both capping at fifteen
  minutes is arithmetic — `5 × 3min` and `3 × 5min` — not an agreement, so do not tie them to one
  constant.
  **And the second waiter's tick is four queries, so what they each read is the price of waiting.**
  `MAX_PARALLEL_IMAGE_JOBS + 1` jobs poll one cast every `CHARACTER_REFERENCE_LEASE_POLL_MS` for as
  long as `CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS`, where the advisory-lock wait it replaced polled
  zero times: the stop check, the two `pass.read` makes, and the lease. `ImageAsset` declared no
  `@@index` at all and Postgres does not index a foreign key on its own, so the sheet read was a
  sequential scan and a sort that shipped every row's multi-kilobyte `prompt`, over every plan
  version's sheets — which the commit's id-scoped delete is what leaves standing — before dropping
  all but one plan's in memory. It names a projection and a `metadata.planId` predicate now, behind
  `@@index([projectId, type])` (migration `000065`, and the index is what every other read of a
  project's pictures was missing too). The in-memory narrowing stays as the statement of what that
  function returns, not as an optimization. The tick is still four: `settled` is read *before* the
  lease on purpose, because a tick that returned `expired` over a set that had just settled would
  hand the second wait's caller a stand-down instead of the winner's sheets.

## Long-range memory

Five modules, split by which question each answers: `semanticRecall.ts` is the `page:` scope's read
side, `researchMemory.ts` is both ends of the `research:` scope, `embeddingWrites.ts` owns every
statement that goes into the `Embedding` table, `embeddingRepair.ts` is the backfill pass over its
holes, and `entityState.ts` (over the shared fold in `entityMentions.ts`) is the per-entity
continuity state. They were one `semanticMemory.ts` until the file reached its size budget.

Whether a book writes any of it is `strategyUsesSemanticMemory`, which lives in
`embeddingWrites.ts` — beside the writes, not beside the recall it is named for. Only the
sequential-pages mode ever *reads* the page embeddings, so every other mode (every book inside the
mobile page ceiling) skips the embedding call per page. The per-entity writes are **not** the same
case, and a deferred publication does not gate them on this predicate: `continueBook.ts` loads
entity state unconditionally, so that publication is the only writer of the state a later
continuation of a non-sequential book reads. Its seven call
sites are all writers about to spend that call; no reader has ever asked it, which is why sitting in
`semanticRecall.ts` it only made seven handlers and passes import the read module for a predicate that
never reaches a retrieval.

- **A page's long-range memory stops at the page being drafted, because a retry redrafts into a
  finished book.** `retrieveSemanticPageMemory` takes a required `beforePageIndex` — `Page.index`,
  the space every `page:<index>` scope is written in, never a printed page number — and hands it to
  the db retrieval, which reads the index back out of the scope in SQL. Nothing about the Embedding
  table means "everything written so far": pages generate in waves up to `MAX_PARALLEL_PAGE_JOBS`,
  and a FAILED_QA page is redrafted long after its successors are COMPLETED and embedded. Unbounded,
  the `search_memory` writer tool answered a page-30 search for "the vault" with `Page 41: the vault
  opens and the archive burns` — described to the model as "earlier pages of this book", so the page
  was written against an event the book had not reached, and the same call could hand back page 30's
  own rejected draft. `lookup_page` and `lookupStoredPage` had always clamped `index >= page.index`;
  the memory search was the one door left open, and `excludePageIndexes` could not close it — that
  list is the recency window already in the context pack and says nothing about what lies ahead.
  The bound belongs in the query rather than in a filter over the results: both arms of the hybrid
  retrieval pool and fuse *before* the top-K cut, so dropping a later page afterwards would return
  fewer pages than the caller asked for instead of the right ones. In SQL it resolves any scope that
  is not `page:<integer>` to NULL instead of erroring, which is what lets a `research:` row share the
  sweep — `AND` is not evaluated left to right, so a guard-then-cast predicate would have taken the
  whole retrieval down with it (`packages/db/src/embeddingRetrieval.ts`; the opt-in
  `lexicalRetrieval.integration.test.ts` measures both halves against pg_trgm).
  **Continuity notes are the same memory and take the same bound.**
  `loadContinuityNotes` (`generationContext.ts`) is two arms over `ContinuityNote` — the newest
  notes, and since the trigram arm was added the best-scoring ones — and neither is a prefix of the
  manuscript either. Unbounded, a page-30 redraft's own needles (`Tomas`, `The Vault of Hours`)
  select the notes pages 41-60 wrote *about that page's cast*, because those are the rows naming it
  most, and the ranking puts them last: the end `continuityNotesForPrompt` keeps and the end nearest
  the model's attention. So `beforePageIndex` is a **required** `number | null` on that function and
  on `retrieveLexicalContinuityNotes` (`packages/db/src/lexicalRetrieval.ts`), and it reaches both
  arms. `null` is a claim rather than an opt-out, and all nine call sites that make it — spread over
  six files — mean it. Seven are judging a draft against what the book *now* holds, the pages after
  it included: the page reviewer, the whole-book passes at all four of their note loads, a replan
  and the final-QA repair. A page inserted into finished prose states the same claim hardest, since
  prose exists on both sides of it, which is why that path passes `nextPages` as well. `continueBook` earns it from the other
  end — a continuation is written past the last page, so everything the project holds is behind the
  first page it drafts and the bounded read and the unbounded one are the same set. The bound goes
  through the `pageId` foreign key, not through `pageScopeIndexSql`: the
  schema calls the scope display text and refuses it as identity, and an edit writes
  `page:<index>:edit:<operationId>`, which that pattern resolves to NULL — bounding on it would drop
  every edited page's notes out of the search instead of placing them in time. A surviving note with
  no `pageId` is project-scoped, since the ownership filter has already removed the ambiguous
  page-scoped ones, and nothing bounds a note that belongs to no page. In the query on both sides,
  ahead of the `LIMIT`, for the reason the embedding arms are.
  **And the order the notes come back in is half a contract nothing typechecks.** This loader emits
  ascending priority — the recency window oldest first, then the trigram hits with the best score
  last of all — and every prompt keeps the *tail*. Emitted descending, which is how it shipped, a
  reviewer taking 20 of these 28 threw away all eight top-scoring lexical hits and kept the recency
  window the relevance arm was added to reach past: no test failed, and the arm simply stopped
  paying for itself. So no prompt slices these by hand. `continuityNotesForPrompt` with a budget out
  of `CONTINUITY_NOTE_PROMPT_LIMITS` (`packages/core/src/context/contextPack.ts`) is the only
  truncation there is — the four consumers keep the different budgets they always had, 28 for the
  single-page pack, 24 for the bulk drafts, 20 for the two review prompts — and
  `generationContext.test.ts` asserts a full-size result from this side against every one of them,
  which is the only place the producer's order and the consumers' cut are checked against each other.
- **A repair the provider refuses is written down, or it is paid for again on every page.**
  `repairPageEmbeddings` backfills the three lowest-index pages whose embedding row is missing or
  degraded, and its failure path used to `continue` without recording anything. So a page whose
  summary a provider will not embed — a content filter on its own text — never left the hole set,
  stayed first in the queue, and cost every one of the hundreds of page jobs that followed one
  embedding call: billed, logged, on the page critical path, and permanently holding one of the
  three slots, so three such pages starved every real hole further along out of ever being
  repaired. A failure now writes (or refreshes) the degraded placeholder with `repairAttempts` and
  `repairRetryFromIndex`, and the target query drops a scope inside that window **before** the
  `LIMIT`, so the slots go to pages that can be filled. The clock is `beforeIndex` — page indexes,
  the only clock this pass has — and the wait *doubles*, because a hard attempt cap cannot tell a
  page a provider refuses from a provider outage that fails every page alike: doubling costs the
  unembeddable page ~log2(N) calls over an N-page book while still forgiving an outage that ended,
  with nothing needed to declare it over. The placeholder earns its own keep — a scope with no row
  is invisible to *both* arms of the retrieval, while a vectorless row still carries the page's real
  summary as `text` and is still recallable lexically. Its write is
  `DO UPDATE ... WHERE "Embedding"."vector" IS NULL` **and** the ownership predicate below, the same
  pair `createDegradedEmbedding` carries — the page's own job may have landed a healthy row since
  the read, and a placeholder must never overwrite one — and it must be able to land on a row that
  exists, or the count could never pass one. A success goes through `writePreparedEmbedding` like
  every other caller: the upsert overwrites the placeholder whole, so a repaired page stops looking
  degraded and stops carrying a stale `sourceId`. **Overwrites the placeholder — never another
  page's row.** Every write this pass makes is dispatched against a *stale* reading of who owns the
  scope: the targets are resolved, then a provider call takes seconds, and
  `repointPageEmbeddings` hands `page:<index>` positions to other pages inside that window. An
  unconditional `DO UPDATE SET "sourceId", "text", "vector", "metadata"` replaced a live page's
  summary with the target's — `deletePageEmbeddings`' "a page whose embedding describes a different
  page is a wrong answer nothing detects", reached from the write side. So the repair alone asks for
  the `"same-page"` conflict policy, which appends
  `WHERE "Embedding"."sourceId" = EXCLUDED."sourceId" OR "Embedding"."sourceId" IS NULL` — the
  `sourceId` rather than the vector, because a re-point moves degraded rows too, and NULL because a
  row no page claims is not another page's and must stay repairable. It reaches **all three** of
  this pass's writes: the vector upsert, the degraded fallback behind it, and the backoff stamp
  above — which is the one that matters on a refusal, because a refused summary never reaches
  `writePreparedEmbedding` at all, so the stamp is the whole iteration and nothing else was left to
  refuse it. The stamp is where the drift happened — it was written without the predicate, so it
  could put its target's summary on the new owner's row by the one door the guarded vector upsert
  had closed — so the two vectorless writes are now literally **one statement**,
  `upsertVectorlessEmbedding`, which owns their columns, conflict target, `SET` list and both
  guards; only the vector upsert is written separately, and `SAME_PAGE_ROW_PREDICATE` is the one
  constant tying its guard to theirs. `embeddingVectorlessUpsert.test.ts` asserts the two
  emitted strings are equal rather than checking each against a list, because what was wrong the
  first time was the *difference*. It stays opt-in: every other caller writes a page it has just
  *rewritten*, and that page's own row is its to replace whatever it holds. A guarded write that matches nothing comes back `"superseded"`, and the
  loop then writes **nothing at all**; the stamp is guarded the same way and matches nothing in its
  own right, rather than putting the target's summary on the new owner's row by the other door.
  Nothing is lost by the silence: a renumber carries each page's rows with it, so a page that had no
  row still has none under its new index, and the query offers it there on a later pass with the
  attempt count it always had.
  **A stop is not a refusal, and this is the pass that pays for
  confusing the two.** `prepareEmbedding` used to fold the `StopRequestedError` that
  `LoggingEmbeddingAdapter.embed` raises into its `{ vectorLiteral: null, error }` result, so a
  reader stopping a run mid-draft arrived here as `"degraded"`: every target in the batch took a
  vectorless placeholder stamped `repairAttempts: 1` and `repairRetryFromIndex: beforeIndex + 2`,
  and the loop spent an aborted provider call on each of the ones behind it. Three healthy pages
  deferred exponentially, on the one input the backoff can say nothing about — it is there to tell
  a provider *refusal* from an outage, and a cancellation is neither. The `isStopRequestedError`
  rethrow this pass already had could not fire, because nothing reached it. `prepareEmbedding`
  raises now, which abandons the batch where it stands and leaves every page it did not embed an
  ordinary hole for the next run.
- **An embedding write may degrade, never fail the page that produced it.** `storeEmbedding` is the
  last statement of a page job before `enqueueNextPageIfReady`, and in `pageReview.ts`
  `writePreparedEmbedding` sits after the ownership fence among the publishing writes — so anything
  escaping it stops a book's fan-out over a memory row on a page already saved and COMPLETED. Both
  of its statements name `ON CONFLICT ("projectId", "scope")`, which needs the unique index
  `000056_embedding_project_scope_unique` creates, and a database that could not
  `CREATE EXTENSION pg_trgm` in `000055_trigram_memory_search` halts `prisma migrate deploy` before
  reaching it — the same deployment `degradeRetrievalArm` (`packages/db/src/retrievalArms.ts`) is
  written for. So `createDegradedEmbedding` is the fallback *and* the last line of defence: it
  reports through that shared policy — counted per (arm, message), reported on the first occurrence
  and every power of ten after, because the fault is an environment fact true of every page of every
  book and a line per page job would bury it — and returns. `rethrowIf: isStopRequestedError`
  is the one thing that still travels out, or a stopped run keeps drafting. The provider half owes
  the same: `prepareEmbedding` degrades an embedding the provider refused into
  `{ vectorLiteral: null, error }` and raises a stop, so a cancellation is never persisted as text
  the provider would not embed. That rethrow is what carries a stop out of `storeEmbedding`, and
  out of the prepare block in `pageReview.ts` (where the story extract beside it, removed
  2026-10-16, swallowed every failure but this one).
  **A caught SQL error still aborts its PostgreSQL transaction.** A caller that includes this
  best-effort write in a larger manuscript transaction must isolate it with
  `runBestEffortPageMemoryWrite`: the savepoint keeps the caller's ownership lock and successful
  atomic commit, while `ROLLBACK TO SAVEPOINT` makes the surrounding transaction committable again
  when both the vector write and its degraded fallback were refused.
  **And the placeholder it leaves describes the page as it is now.** That write was `DO NOTHING`,
  so a second failure under a scope already holding a placeholder wrote nothing at all and the row
  kept the *previous* draft's summary — a chat edit rewrites page 12, its embedding fails again,
  and the row still says what the page used to say. A vectorless row is deliberately recallable
  anyway: `retrieveLexicalEmbeddings` (`packages/db`) filters on `text` and never on the vector, so
  `retrieveSemanticPageMemory` handed every later page `Page 12: <text the edit removed>` as
  earlier continuity, indistinguishable downstream from the page's real summary — the pre-diff
  `prisma.embedding.create` at least stored the new text. It is
  `DO UPDATE ... WHERE "Embedding"."vector" IS NULL` now, the shape `recordFailedEmbeddingRepair`
  already carried and for its reason: this statement is only ever reached *after* a provider or
  insert failure, so a row that holds a vector belongs to a writer that succeeded and is left
  exactly alone. It refreshes `text`, which is the point; `sourceId`, the column a renumber carries
  the row by and a delete removes it by, so a row describing this page under another page's id is
  that same wrong answer reached from the other end; and `metadata`, whose `error` and repair
  backoff were earned by text that is gone. `EmbeddingConflictPolicy` reaches this statement too,
  because a re-point moves degraded rows as readily as healthy ones: the repair pass's
  `"same-page"` predicate is appended here as well, while every other caller has just written the
  page and claims the scope outright — guarding *those* on `sourceId` would refuse the row a
  structurally inserted page inherited and leave the stale summary standing, which is the failure
  above.
- **The hole set is a query, and the `LIMIT` is what the backoff protects.** That whole filter used
  to run in memory over two unbounded reads — every COMPLETED page below `beforeIndex` *with its
  summary*, plus every `page:` embedding row of the project — on every page job past the recency
  window: measured on a 300-page book, 123,921 rows and 11.5 MB of manuscript across 281 jobs, to
  answer "nothing to repair" 281 times. `findPageEmbeddingRepairTargets`
  (`packages/db/src/embeddingRepairTargets.ts`) derives it in SQL and returns at most three rows.
  Three things about that query are load-bearing. The backoff is a `WHERE` predicate, so `LIMIT`
  cuts what survives it — the same ordering the `filter`-before-`slice` had, and the whole of the
  anti-starvation property. It is a `NOT EXISTS` anti-join rather than `LEFT JOIN … IS NULL`,
  because only the anti-join stops early: the outer join plans as a merge join over both whole sets
  (2.1 ms and two sorts on that book) while the anti-join walks `Page_projectId_index_key` and halts
  at the third hole (0.14 ms, 0.72 ms on an intact book). And the degraded test is
  `(metadata->'vectorStored' = 'false'::jsonb) **IS TRUE**`: healthy metadata carries no such key,
  `->` yields NULL, and `NOT (NULL AND …)` is NULL — which drops the row from the subquery and calls
  every healthy page a hole. Without `IS TRUE` the query offered all 300 pages of an intact book for
  re-embedding, on every job. `page-repoint:` scopes cannot be seen either way: the correlation is
  equality on `'page:' || index`, never a prefix. The predicate is mocked in the worker's suite and
  measured against a real Postgres in `packages/db/src/embeddingRepairTargets.integration.test.ts`
  (`DB_INTEGRATION=true`). **And the marker that SQL tests for is not written down twice.**
  `researchMemory.ts` asks the same question of a row it already holds — a degraded row must not
  count as embedded, or a failed research embedding is never retried — and its `embeddingIsDegraded`
  is imported from `@book-maker/db`, where it sits beside the SQL spelling of the same test rather
  than in this directory: one rule, two languages, one file, and one table of metadata shapes
  (`packages/db/src/testing/degradedEmbeddingShapes.ts`) both are judged on. The mock factory in
  `researchMemory.test.ts` restates it, for the reason `testing/dbScopeMocks.ts` restates the scope
  vocabulary, so it carries the same obligation to stay equal to the original.
- **Best effort has one spelling in this cluster, and a stop is the one thing it may not swallow.**
  Every pass here is allowed to answer nothing — a page written from its recency window alone beats a
  page not written at all — and every one of them runs *once per page job*. Hand-rolled, that meant
  six `console.warn` lines whose fault was almost always a single fact about the deployment (no
  `pg_trgm`, no `pgvector`, a `prisma migrate deploy` that halted before
  `000056_embedding_project_scope_unique`) printing three hundred times for a three-hundred-page
  book, with the first line — the only one that says anything new — buried under the rest. They all
  go through `degradeRetrievalArm` (`packages/db/src/retrievalArms.ts`) now, which counts per
  (arm, message) per process and reports the 1st, 10th, 100th …: the query embedding and the page
  memory retrieval (`semanticRecall.ts`), the research retrieval (`researchMemory.ts`), both halves
  of the entity state (`entityState.ts`), the whole repair pass (`embeddingRepair.ts`) and the
  degraded write behind every embedding (`embeddingWrites.ts`). The arm names are the old messages
  — the policy prints `<arm> failed for project <id>` — so nothing anyone greps for moved.
  **Every one of them passes `rethrowIf: isStopRequestedError`**, and that is the whole risk of the
  conversion: a degrade *looks* like success, so a stop folded into a fallback is a run the reader
  ended that keeps drafting and keeps billing. `LoggingEmbeddingAdapter.embed` raises the stop from
  inside three of these `try` blocks, and `retrieveHybridEmbeddings` deliberately re-raises rather
  than degrading to one arm's rows precisely so it arrives at these catches — which is why the option
  is required rather than optional in the policy's own signature. The one bare `console.warn` left in
  the group is the CAS-race line in `entityState.ts`, and it stays: nothing *failed* there (every
  write ran, one of them won), it is rare by construction rather than once per page job, and its
  message names an entity id — a fresh census key on every entity that ever lost a race, so the
  ladder could never reach a second rung and the policy's bounded census would churn instead.

## Image layout edits

**A bulk remove is planned in memory and flushed once per page.** "Remove all the pictures" is
ordinarily two pictures on one page, and undo replays `PageEditSnapshot` rows —
`undoLastBookEdit` loads them with no ordering, and there is no unique index on
`(operationId, pageId)` — so a second snapshot for one page would carry the half-stripped
markdown as its `markdownBefore` and undo would restore a page missing the first picture.
`generation/imageLayoutPlan.ts` therefore reads every affected page once, mutates them in
memory, and writes and snapshots each exactly once; `affectedPageIndexes` is written from that
flush rather than guessed before it, so a target that had already gone leaves its page unclaimed.
A stale target is skipped and counted, never fatal: one gone picture must not lose the other
eleven. The classifier's `previousAssets` / `demotedAssets` are arrays for the same reason, and
`mobile/imageEditRecords.ts` still reads the singular `previousAsset` / `demotedAsset` keys —
an operation applied before that change is still inside its undo window and still has a card
to draw.

## Chat page rewrites

- **A rewrite that kept the page's prose inherits the page's approval.** `rewritePageForUserRequest`
  (`textEditRewrite.ts`) is the whole-page tier of a chat edit, reached when the surgical tier
  declined (→ handlers/CLAUDE.md). Its revise used to be followed unconditionally by the model
  page reviewer and the bounded QA loop, and that reviewer is not deterministic between sittings:
  on 2026-09-06 it rejected three pages a code conversion had kept at 0.97–1.00 of their sentences
  — pages it had approved at generation — for "restaging the previous page", and every rejection
  was answered by a from-scratch repair. `retainedProseFraction` (core, `proseRetention.ts`) measures
  what share of the stored page's sentences survive verbatim outside fenced blocks; at or above
  `REWRITE_APPROVAL_INHERITANCE_FLOOR` (0.9), when the stored report was approved and the two
  integrity checks pass on the new text, the rewrite returns with that report annotated and no
  review is spent. The adherence review still judges the change itself. Below the floor, or on a
  page that was FAILED_QA before the edit, or when the new text carries a placeholder or a prompt
  leak, the review runs as before. The revise prompt in core says the same thing in words when
  `editInstruction` is present — keep every sentence nothing named, byte for byte — in place of the
  two generic lines that told it to move the beat and freshen the wording.

## Compiling and publishing

The live export names are private S3 keys. `exportArtifacts.ts` copies each predecessor to
a unique `books/.export-backups/<projectId>/` key, uploads one local candidate at a time under the database claim, and
restores the predecessor set on failure. Local pending files live only inside
`withTemporaryDirectory`. The worker sweeps old S3 backups; each container sweeps its own
heartbeat-protected scratch directories. S3 copies and uploads preserve the publication ordering in the incidents below.

- **A recompile makes no model call, and that is a cache with one rule.**
  `createReaderChaptersForExport` used to run on *every* compile, including the ones the user was
  told are free and instant — a presentation toggle, an undo, a manual edit. It now returns
  `{ chapters, source }` and `readerChapterCache.ts` memoizes it to `books/<projectId>/reader-chapters.json`
  keyed by `readerChapterFingerprint`. Only `source === "model"` is written, and the union has three
  members because there are three outcomes: `"fallback"` is the deterministic grouping standing in
  for a call that failed or whose boundaries were rejected, and `"rejected"` is a reply that came
  back unreadable — no chapters array at all, or a single chapter when the prompt asks for two to
  twelve or none. Both return what they always returned; neither may be cached. `"rejected"` is the
  subtle one: it yields `[]`, which is **indistinguishable from the empty array a long single-arc
  book earns**, so `source` is the only thing separating a real verdict from a miss — and
  `schema: z.unknown()` accepts any JSON, so a misshaped reply is never retried and would otherwise
  be pinned for as long as the manuscript's text is unchanged. A genuine empty array is `"model"`
  and **is** cached — that is the case worth caching. The
  cache lives independently of the compile’s scoped local render directory.
  **The cache is not the whole cost control, because that write rule makes a miss ordinary.** A book
  compiled before the cache existed has no entry, and neither does one whose chapterization fell
  back or came back unreadable — and a detached export repair is queued by a status read or a
  download every five minutes for as long as a compiled file is missing, none of it charged for. So
  a repair has to be free on a *miss* too: `readerChaptersWithCache` takes `allowModelCall`, false
  exactly when `isDetachedFromProjectLifecycle(job.data)` says so. That payload flag is the signal,
  not `skipFinalReview` — an edit's own recompile sets that too, and it is charged work whose
  manuscript is new. On a miss the repair takes `createDeterministicReaderChapters`, the same
  stand-in a provider outage produces, which shares `shouldAttemptReaderChapterization` so a book too
  short to chapterize still gets `[]` rather than an invented Contents; and it writes nothing, so the
  next charged compile of that manuscript still asks. The same flag ends the compile's last fan-out:
  `maybeEnqueueCharacterCandidatePreparation` is another text-model call wearing a job of its own,
  and nothing downstream would have stopped a repair starting it — `enqueueWorkerJob` suffixes a
  dedupe key with the generation attempt's id, and a repair carries no attempt, so the bare
  `prepare-characters:{project}:{plan}` key it computes is free even for a book whose generation
  already ran that detection. None of this applies to a book composed by chapters: its reader
  chapters are its `Chapter` rows (`readerChaptersFromComposedChapters`, taken before the cache in
  every lane), so a composed book makes no chapterization call and has no miss to be free on. An author's book
  (`isAuthorManuscript`: imported or written in the Studio) makes none either, in every lane:
  `resolveCompileReaderLayout` returns `authorReaderChapters` — its `Chapter` rows with the author's
  titles verbatim, or `[]` for the plan partition a publish writes from the same chapters — before
  anything else is asked. Not `readerChaptersFromComposedChapters`, whose sanitizer replaces a title
  that only says "Chapter 3" (the Studio's default) with a phrase lifted from the page.
- **A compile publishes by claiming the revision it compiled, and it renders somewhere else until
  it has.** `staleGenerationJobReason` refuses to *start* a compile whose `contentRevision` has
  moved, but that is one instant and the work behind it is minutes of QA, reader chapters and a
  Chromium render. A repair runs against a project that is COMPLETE, which is exactly the state in
  which a reader may edit — and an edit bumps the revision, deletes the compiled files, sets
  EDITING and queues its own recompile. The stale compile used to write `book.md`/`book.pdf`/
  `book.epub` over the fresh ones and then set COMPLETE *unconditionally*, so a book could sit
  finished with the pre-edit PDF for good. `generation/exportPublication.ts` renders to
  `.book-<uuid>.{md,pdf,epub}` in scoped local scratch and publishes S3 objects only after
  `project.updateMany({ where: { id, contentRevision, OR: [{ exportInvalidationRevision: null },
  { exportInvalidationRevision: { not: contentRevision } }] } })` matches
  a row: the claim is first, so a
  loser publishes nothing rather than publishing a book somebody has since changed. Standing down
  is not a failure — the job still COMPLETEs, because failing it would refund a book that is fine —
  and it cannot strand the project, because **every** `contentRevision` bump queues its own compile
  (`queueUserEditExportRecompile`, `applyBookEdit`, `continueBook`), which is the invariant that
  makes declining the status write safe — and the standing-down compile is exactly what used to
  break it. `maybeEnqueueCompile` refuses to queue while any `COMPILE_EXPORT` is QUEUED or ACTIVE,
  and a repair in flight *is* one, so a chat edit landing on top of one deleted the exports, bumped
  the revision, queued nothing, and left the book EDITING until delayed recovery:
  `reconcileStrandedGeneration` now takes both EDITING and GENERATING after its grace period, while
  `ensureExportRepairQueued` takes COMPLETE and REVIEW_REQUIRED. Immediate handoff is still needed
  to avoid that delay. The count is revision-aware — a compile carrying a superseded revision will
  publish nothing, so it may not stand in for one that will — and `applyBookEdit` asks
  `maybeEnqueueCompile` what it did, restoring COMPLETE on `"not-ready"` rather than trusting that
  *something* was queued. Manual edits never had the hole: `queueUserEditExportRecompile` always
  enqueues. Keep the scratch names per compile: two compiles for one
  project overlapping is the whole case, so a shared name would have them rendering over each
  other. A payload with no revision claims unconditionally, matching what
  `staleGenerationTargetReason` does with a null. The invalidation field is a second, short-lived
  publication fence: a text edit stamps its new revision atomically with the manuscript but removes
  old shared files only after commit, so no worker compile or inline API rebuild may install files
  in that gap. Its tail deletes outside SQL and clears only the exact stamped revision.
  **The export barrier blocks the revision it names, not every revision, and only an expired
  publication lease lets recovery retire it.** A tail killed before it clears used to strand the
  value forever: under a strict null test every
  later compile claimed zero rows, stood down, marked itself COMPLETED, and was re-queued by
  `reconcileStrandedGeneration` to do it again, while the project never left EDITING and
  `ensureExportRepairQueued` — which takes only COMPLETE and REVIEW_REQUIRED — could not reach it.
  Each reader therefore blocks only on a barrier equal to *its own* claimed revision, which the
  revision CAS beside it has already pinned to the row. What that trades away is a compile for a
  *later* revision publishing objects a delayed tail then deletes — the tail's barrier survives a
  non-text revision bump, since only another text edit overwrites it — and that is recoverable,
  because a settled project with a missing file is exactly what the repair lane rebuilds. But that
  trade only ever covered a barrier left at an *older* revision. The value a dying tail strands is
  the revision the project is sitting at — the one every later reader claims — so the tail may not
  be allowed to leave it: a delivery that hands its lease back retires its own barrier first, and
  because the release CAS matches only that delivery's own token, a successful hand-back proves no
  successor is inside the tail. A process kill or a database outage can lose even that hand-back,
  after the durable job is already COMPLETED and Bull has spent its attempts. The delayed
  `reconcileStrandedGeneration` sweep therefore compare-clears an exact current-revision barrier
  only when no APPLIED publication operation holds an unexpired lease, using `CURRENT_TIMESTAMP`
  in the same statement; it queues no doomed compile while a live tail owns the gap.
  `invalidateRevisionOwnedExports` reads a null barrier as "already retired", so a late redelivery
  checkpoints instead of deleting objects the recovery compile may have installed. Only the text,
  continuation and replan forks stamp; the
  structural insert deliberately does not, because its clear would have to live in two other files
  and it has two publication arms, and a stranded barrier is worse than an absent one. The null arm is not decoration: Prisma compiles a bare
  `{ not: n }` to `<> $1`, UNKNOWN for a null column, which would have excluded every healthy
  project — the same three-valued-logic bug as `chapterId: { not: destination }` above.
  **The revision is not the whole claim, because an edit moves the status first and the revision
  last.** `applyBookEdit` sets EDITING before it rewrites a single page and increments only once
  every page is saved; `continueBook` does the same across an appended chapter. For those minutes
  the pre-edit revision is still the project's revision, so a repair compiled for it matched, wrote
  COMPLETE over EDITING and told the reader a half-applied edit was finished — the app's edit
  progress reads `project.status === "EDITING"`, so it retired mid-edit. A detached compile
  therefore writes **no** status at all: `ownsProjectStatus` (the success-side twin of
  `jobOwnsProjectLifecycle`) turns the claim into a lock-taking no-op whose `where` names the two
  statuses a repair may find, COMPLETE and REVIEW_REQUIRED. That also settles its verdict: a repair
  runs `skipFinalReview`, so its report is deterministic-only, and letting it speak could only ever
  clear a REVIEW_REQUIRED that a full compile earned. Nothing is stranded by the silence — a repair
  is queued only for a project already in one of those two statuses, so there is no state it was
  the one to move out of.
- **A publication may replace the page map; it may never refuse to publish over it.** Every
  publication that installs new `book.pdf` bytes owes `Project.pdfPageMap` a current measurement or
  a `bookPdfCoverNumbering` stub, because ranges measured from a different render mistranslate chat
  targets onto the file the reader now has — and a repair publishes under the *same*
  `contentRevision`, so the staleness gate in `bookPageMapForProject` will not catch it.
  `publishCompiledExports` briefly enforced that by **throwing**, which is the one thing it must not
  do: `compile-export` owns the project's outcome and has no retry budget, so the throw reached
  `markFailed` — a book whose pages were already written going FAILED and refunded, or its edit
  settled as a failure, over a few hundred bytes of metadata beside it. That is the same call the
  provenance write two functions away already makes ("a book in object storage must not be failed and refunded
  because a hundred bytes of metadata could not be written"), and "no compile may fail, publish
  differently, or retry over the map" is the rule in `packages/core/src/generation/CLAUDE.md`. So an
  unmeasured, legacy or missing map is **degraded** to the stub instead, with a warn line naming the
  project: the ranges go either way, which is the whole of what the invariant protects, and chat
  falling back to model indexes is the graceful path the stub exists for. The stub's cover-skip is
  taken from the offered map when there is one and otherwise from the stored row, read inside the
  publication transaction — the one place that read cannot race the file it describes. A row no
  parser can read a cover flag out of is a row every reader already refuses, so it is left alone
  rather than replaced by a guess.

- **A companion export never fails the compile, and a new one is one registry entry.** The
  handler's side of that rule is `compileExportCompanions.ts`: one table of renderers keyed by
  `CompanionExportFormat` — step key, one plain retry, the warning issue and the progress
  sentence — so the EPUB and the Word file take one code path and a third companion is one row.
  `exportArtifacts.ts` owns local candidates and S3 publication, split out of
  `exportPublication.ts` when the Word file pushed it past its budget: `publishedExportFormats`
  decides what a full compile or a repair installs, `artifactPublications` retires every
  companion the compile owed and could not render (`companionsProduced`), and both derive from
  the registry in core. A companion repair (`repairFormat` epub or docx) renders no PDF, so it
  neither measures nor degrades the page map — the predicate is `publishesPdf`, never
  `repairFormat !== "epub"`, which would have stamped a cover-numbering stub over a measured map
  on every Word repair.

## Character reference sheets

- **A short book draws a sheet only for a character two of its pictures show, or one the reader
  saved with artwork, and that cast is decided once from its draft and stored on the plan
  version.** A sheet is a consistency aid — it keeps a character looking like itself from one
  picture to the next — so a character drawn once has nothing to be consistent with. Yet every
  illustrated book drew one for its whole plan cast, at $0.039 an image call before any page
  picture, while pictures are ~99% of an illustrated book's provider cost. With a 10-page
  children's book cut to four pictures (pages 1, 3, 6, 8), the Moss book
  (`cmv9ozzbo002b4vqgz5w3ez6t`) named its otter in all four page prompts and a frog, a heron and a
  beaver in one each, and drew four sheets; over the 45 days to 2026-10-17 there were 69 sheet
  calls, some books drawing four sheets for two pictures and three for one. And a KIDS book's
  selection (`selectCharacterReferenceAssets`) attaches every sheet to every page while they fit
  the budget, so the heron's sheet rode on pages with no heron. The rule is core's
  `characterReferenceCastFromDraft`, beside `characterReferenceCast`: the plan characters, in plan
  order, named (`characterNamedIn`, the test the cover cast and the page selection use) in at least
  `CHARACTER_REFERENCE_MIN_PICTURES` (2) of the book's drawn pictures — the draft pages the
  strategy's `shouldIllustratePage` draws with a prompt, exactly what `enqueueDraftPageIllustrations`
  queues, so a slot outside the billed cap counts for nothing, plus the cover when
  `coverArtSourceFor` is `ai`, because an illustrated book's cover attaches the page selection's
  sheets — as a picture of whom its concept names (`coverCastCharacters`), or of the lead
  (`plan.characters[0]`) alone when the concept is only the brief (below). A character matching a
  library snapshot with saved artwork always
  keeps theirs, because `libraryFacesForSheets` attaches the reader's face only beside that
  character's own sheet. `[]` is a legal answer: no sheets at all. **Only the short-book pass
  decides** (`draftThenPolish.ts`, where `usesShortBookPath` is true and the pictures are queued
  from the checkpointed draft), and it decides *before* any sheet is drawn and before the cover and
  pictures are queued: `ensureCharacterReferenceAssets` takes `decideCastFromDraft` (every draft page,
  the resumed run's COMPLETED rows included) and `characterReferenceCastDecision.ts` writes the names
  to `PlanVersion.characterReferenceCast` with a compare-and-set where it is still NULL, then uses
  whatever the row holds — so a resumed run, or a delivery racing the first, reuses the first answer.
  Every other caller — each page's `generate-image`, the cover job through
  `characterReferenceAssetsOrNone`, a resumed `generate-book` — reads that column in the same select
  as the refusals and narrows today's cast to it (plan order kept, a stored name no plan character
  has dropped, never wider than `characterReferenceCast`), so every caller computes the identical
  cast and `characterReferenceSetIsSettled` is satisfied by the decided sheets alone; a page job can
  never re-render the cast because its cast differs. The decision is written before the capability
  check, because the cover may draw on another model than the pages. It only ever moves NULL → an
  answer, once, and every `read` of the pass takes its cast from the row it read, so the render
  draws the cast the claim's read found. NULL means no decision: composed books, per-page books,
  books off the short-book path, and every replan, continuation and revision — each a new
  `PlanVersion` row — keep the whole cast exactly as before. **A cover-only book draws no reference
  sheet: its cover is its one picture.** `characterReferenceCast` answers `[]` without pages to
  illustrate, since by this rule nobody is in two pictures, and "The Last Table" (2026-10-17) spent
  $0.078 of its $0.129 on two sheets for the one cover. A saved library portrait still reaches that cover, which
  attaches it directly (`coverPortraitCharacters`, `selectCoverReferenceImagePaths`). Chat
  `add_image` reads the sheets that exist, as it always did, so a picture added to a cover-only book
  is drawn from its prose and is not held to the cover's look. **A cover concept that is only the brief shows the lead.**
  145 of 172 plans with characters in those 45 days (21 of 25 illustrated KIDS plans) carry the
  planner's fallback cover prompt, `Cover illustration for <title>: <the whole brief>`
  (`makeFallbackPlan`), and a brief names everyone the story has: read as a picture of each of
  them, every one-off friend had a second picture and the Moss book still drew all four sheets (29
  recent illustrated books: 65 sheets under the old rule, 59 so, 52 with the cover not counted).
  `coverConceptIsBrief` (that prefix ending in the prompt, or no concept at all) counts the cover
  for the lead alone, so the Moss book draws one sheet, Moss's, and the cover still has it. That the
  planner leaves the cover concept to the fallback at all is its own question: the cover's artwork
  prompt states that brief as its "primary visual concept".
- **A refused reference sheet is a settled fact about the plan, and the book finishes without it.**
  An image provider that reads the prompt and declines to draw it — a copyrighted character, a
  blocked likeness — has answered, and it answers the same way every time. The render pool used to
  set `failed` and rethrow on any error at all, so one such character failed `GENERATE_BOOK` at its
  "Queue follow-ups" step and the project went FAILED before a single page existed: the one image
  path in the pipeline with no tolerance, while an interior illustration marks `imageFailureReason`
  and a cover that cannot be drawn falls back to a designed one. A sheet is weaker than either — it
  is the *consistency* aid the page renders attach, so losing one costs one character's likeness
  holding still, not a page. `isImageContentRefusalError` (`packages/core/src/adapters/imageRefusal.ts`)
  is what separates that from an outage, and it demands **both** providers refused: a filtered
  primary beside a 503 on the fallback is a drawing that was a minute away, and recording
  "unrenderable" for it would be worse than the failure. Anything that is not a refusal stays fatal,
  because `generate-book` is in `NETWORK_RETRYABLE_JOB_NAMES` and its retry ladder is the right
  answer to an outage.
  **The refusal has to be written down, or tolerating it costs more than failing did.** The gate on
  re-rendering is "does every plan character have a sheet", which a refused character can never
  satisfy — so every illustrated page's image job and the cover job would find the set incomplete,
  take the advisory lock, `deleteMany` the sheets and render the whole cast again: the refusal paid
  for once per page, and every *other* character redrawn per page, which is the consistency the
  sheets exist to provide. `PlanVersion.characterReferenceRefusals` is that record and
  `characterReferenceSetIsSettled` is the gate that reads it — a sheet or a refusal for every
  character of the cast (`characterReferenceCast`: the whole plan cast for a book with illustrated
  pages — or the cast a short book's draft decided, above — and nobody for a cover-only AI book).
  It is written in the same transaction as the `ImageAsset` rows, because a settlement
  without them re-renders nothing and sheets without it rebuild per page. The pass that runs owns
  the whole answer: it attempted every character of the cast, so a name it does not refuse this time is one it
  drew, and a later pass that draws everyone clears the column.
  **But no later pass runs, which is why a refusal needs a door out of the product.** That clearing
  is real — `supersedes` is built on it — and it is only ever reached by a pass that was *already
  running* when the refusal committed. A refusal is precisely what stops the next one from starting:
  `characterReferenceSetIsSettled` is satisfied by it, and `ensureCharacterReferenceAssets` answers
  from that check before it goes near the lock, so no page, no cover, no `generate-book` retry and no
  provider or configuration change ever attempts that character again for the life of the plan
  version. Which is right when the provider meant it and unrecoverable when it did not — and
  `isImageContentRefusalError` is a reading of a provider's words that has had several false
  positives found in it. The only recovery was a replan: a new `PlanVersion`, whose column is NULL
  because it is a new row. `scripts/clear-character-reference-refusals.ts` is that recovery without
  the replan — `--apply`-gated, per project, plan or character name — and it is deliberately only
  half a fix, because clearing the column merely unsettles the set: the *next* `generate-image` or
  `generate-cover` job for that plan is what redraws the cast, which for a finished book means
  regenerating one page's illustration afterwards. The refusal's own `console.warn` names the
  `planId` for that reason. It is the line an operator sees — the run-log entry beside it is a file
  inside the project’s object prefix — and without the plan version it named the fact rather than the
  row that holds it. What it does *not* write is a
  settlement the row already holds — the ordinary pass refuses nobody against a column already NULL,
  and `DbNull` over NULL is a row version and a dead tuple for no change inside the transaction that
  holds the lock. Only equality is skipped, so the clearing above still happens; and order is not
  part of the answer, since the render pool decides which refused name lands first.
- **The renders no longer sit inside the lock, because tolerating a refusal is what made that
  budget reachable.** The pass was one `prisma.$transaction` with a five-minute timeout:
  `pg_advisory_xact_lock` at the top, then every image call, every file write and every row write
  under it. That was already minutes of model latency spent holding a pooled connection
  idle-in-transaction and a cross-process lock every other image job blocks on — and a refused
  character used to end it in milliseconds. It no longer does: the rest of the cast keeps rendering,
  and a *copyright* refusal additionally buys a text call to rewrite the prompt (two, if the reply
  needs repairing) plus a second full primary→fallback render. A cast with two or three of those
  outruns 300s, and the abort was the worst answer available — every sheet already rendered and paid
  for rolled back, its objects left in storage with no rows, and every waiting image job blocked for the
  whole window. `characterReferenceRenderLease.ts` splits it into **claim, render, commit**: the
  advisory lock is still taken and still fences the check-then-claim, but what it now protects is a
  `PlanVersion.characterReferenceLease*` compare-and-set, in database time, taken and released in
  milliseconds. The renders run between the two transactions with nothing held. The lease is what the
  lock was doing across them, made durable, and it is the whole of the cost control — without it
  every illustrated page's image job and the cover job would render the cast again. Its budget is
  deliberately the *old transaction timeout*, because that is the render budget this pass always had;
  what changed is the price of missing it, which is now a duplicated render rather than destroyed
  work. Waiting is no longer free either — the lock used to block a loser until the winner's
  transaction ended, and the winner's transaction *was* the render — so a loser polls, and that wait
  **ends**: a lease whose owner died mid-render is a state nobody will write the end of, and giving
  up means rendering the page with the sheets that exist, never failing the book. The commit is still
  one transaction and still atomic exactly as before: the stale set's delete, the new rows and the
  settlement land together or not at all.
- **A waiter's budget is one owner's, and only a lease that changes hands renews it.** That wait's
  deadline was fixed at entry, and the lease is deliberately never renewed — so the one way it could
  stay live across the deadline was to be *taken again*, by a pass that found it expired and is
  drawing the cast right now. Reaching the deadline at all was therefore proof of a relay, read as
  proof of the opposite. A waiter that entered thirty seconds into a five-minute lease gave up
  ninety seconds into the *next* owner's, warned `character_reference_lease_abandoned`, and handed
  its page the sheets that existed — which mid-pass is **none**, since a pass commits its whole cast
  in one transaction at the end. So an illustrated page drew with no reference sheet for any
  character, a minute before every one of them landed, and the cost control worked exactly as
  designed while the consistency it buys was thrown away. `readRenderLease` returns the lease token
  beside its liveness for that reason — with no heartbeat, a token that moved is the whole of a
  waiter's evidence that someone else took over — and a relay buys the new owner the same budget the
  old one had, bounded by `CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS`: three leases, so about three
  owners, generous for the reason `structuralPageLease.ts`'s waits are. The ceiling is not
  optional — renewal with no bound is that file's wedged-owner poll reached from the other side, a
  worker slot held for as long as passes keep claiming and expiring. `abandoned` now means what it
  always said: nobody is finishing this cast.
  **The ceiling is the job's, not the call's.** `runCharacterReferenceRenderPass` takes it once and
  hands it down, because that function enters the wait *twice*: a first wait that relayed through
  owners for the whole budget answers `expired` when the last of them dies, the re-claim behind it
  comes back `busy` because another worker was quicker, and a ceiling taken on entry to the wait then
  started a second fifteen minutes — half an hour of a held worker slot out of a bound documented as
  "the whole wait, however many owners it spans, taken once".
  **And a reader who pressed Stop ends it.** Nothing else in that loop can see one — `pass.read` and
  `readRenderLease` are plain selects, no abort signal reaches the driver, and `processJob`'s own
  check runs only once the handler has returned or thrown — so a stopped run sat here for the whole
  ceiling while the book kept billing behind it. The tick opens with `assertJobNotStopped`, raising
  `StopRequestedError` the way every other pass in the worker does, so the delivery settles through
  `markStopped` rather than as a book that finished with no sheets.
  **And the stand-down is legible.** `runCharacterReferenceRenderPass` returns
  `{ answer, outcome }`, because `[]` is the same answer for four different facts — this cast has no
  sheets yet, a provider refused one, the plan version went away, or this caller gave up on a render
  somebody else was still paying for. The last two now also append
  `character.reference.stand_down` to the run log beside the refusal lines, since from the finished
  book they look identical. None of it is written to `PlanVersion.characterReferenceRefusals`: an
  abandoned wait is not a refusal, and only a refusal is permanent.
- **A drawing beats a refusal, whoever's commit got there first.** Two passes over one cast is what
  leaving the lock bought, and the loser's commit used to stand down on `state.settled` alone —
  "the first one already answered for the whole cast, so ours is a duplicate, not a correction."
  For two passes that *drew* the cast it is. But the answers are not all of one kind: a pass can
  also come back refused, and a refusal is permanent by design — `characterReferenceSetIsSettled`
  is satisfied by it, so nothing re-renders that set for the life of the plan version. So a slow
  pass that drew Beatrice, standing down for the expired-lease re-claim that was refused her, threw
  away the only sheet she was ever going to have, and the book's permanent answer for a character
  was decided by which transaction won a race rather than by which render produced a picture. They
  really can disagree: a copyright refusal buys a *text* call to rewrite the prompt
  (`providers/copyrightSafeImageRetry.ts`), so the second attempt is not the same prompt twice.
  `renderAndCommit` therefore asks the pass — `supersedes`, beside `read`/`render`/`commit`, so the
  lease stays about coordination and `characterReferences.ts` keeps the domain rule. That rule is
  *we drew somebody it only recorded a refusal for, and we drew everybody it has a sheet for*. The
  second half is load-bearing: the commit replaces the rows it read rather than merging with them,
  so without it a pass refused Ada would take Beatrice's refusal back by recording Ada's, and the
  two could ping-pong. Answers neither of which covers the other are left with whoever committed
  first, and two full successes are a tie — the one thing arrival order settles well. The drawn set
  only grows, bounded by the cast, so this supersedes at most once per character.
- **The stale set is the rows the commit read, and another plan version's sheets are not among
  them.** `currentCharacterReferences` filters by `metadata.planId`, so what a pass reads under the
  lock and what its creates replace are both one plan's cast — but the delete named
  `{ projectId, type }` and took every plan version's sheets on the project. Rows the transaction
  never counted and does not replace, deleted as collateral by a statement guarded on a set that
  does not contain them: the guard narrowed to the plan when the render was first claimed and only
  the `where` stayed behind. Two handlers read the superseded rows on purpose —
  `handlers/characters.ts` filters a replanned project's sheets by plan *because* the older ones are
  still there, and `insertionReferenceSelection` in `handlers/applyImageInsertion.ts` deliberately
  falls back to them when the current plan has none, so a chat `add_image` on a replanned book drew
  a cast the reader recognises from prose alone. And the loss is paid for twice: an undo of a
  structural edit moves the book back to an earlier plan version, whose whole cast then re-renders
  unbilled. The delete is staked on `current.assets`' ids now. It is a **row** scoping and not a
  file one on purpose — sheet filenames carry a per-pass render id, so a row that goes away leaves
  an orphan file, which is the same storage noise `generateImage` and `applyImageInsertion` accept.
  **What that narrowing hands the reader is a cast per plan version, so the reader collapses.**
  Nothing sweeps a superseded cast — no replan, no continuation, no undo, and nothing in this repo
  deletes under `images/<projectId>/` short of the project being deleted — so a book's
  `CHARACTER_REFERENCE` rows now grow by one full cast per plan version, for good. Every reader
  scoped to a plan is unaffected by construction, and the one that is not,
  `insertionReferenceSelection`, met three identically-scoring drawings of one character where it
  expected one. That is the crowding `selectCharacterReferenceAssets` collapses per character, and
  the rule lives with the selection because it is a property of what a reference set *is*
  (→ packages/core/src/generation/CLAUDE.md). The **growth** is not fixed and should not be fixed by
  widening the delete back: a project-wide sweep is the collateral this bullet is about, and an undo
  of a structural edit can make an older plan version current again, so a superseded cast is not
  reliably dead. Bounding it — keeping the current plan's cast plus the *n* most recent — is a
  separate change with its own question about which plan versions an undo can still reach.
- **A reference-sheet filename must survive a non-Latin name.** `characterSlug` stripped everything
  outside `[a-z0-9]`, so every Persian, Cyrillic and CJK name emptied out and `safePathPart`
  returned the literal `"unknown"` — three characters in one book all wrote
  `character-reference-unknown.jpg`, and because `characterReferenceSetIsSettled` compares *names*
  the set looked complete and was never rebuilt, so the whole cast wore whichever face rendered
  last. It now hashes the folded name when the ASCII slug is empty, and
  `characterReferenceFileStems` resolves the **whole cast's** stems together before the concurrent
  renders start, since a per-name slug cannot promise cast-wide uniqueness. The ASCII path is
  byte-for-byte unchanged so no existing book's files move.
  **And cast-wide uniqueness is only half of it, because the passes overlap now too.** Once the
  renders left the advisory lock, two of them can run over one cast — a lease that expired under a
  slow render, or two plan versions of one book, whose leases are separate rows while this prefix
  is shared. Named from
  the cast alone that is one path with two writers, and the loser is the dangerous half: `writeFile`
  truncates in place under a page render reading the same path, and its bytes land on a sheet the
  winner has already committed an `ImageAsset` for, leaving a published row describing a picture
  that is no longer there — `applyImageInsertion`'s "the loser's writeFile silently swapped the
  artwork under the winner's published markdown", reached from the other end. So
  `characterReferenceFileStems` takes the pass's own `renderId` and puts it on every stem. The pure
  naming rules live in `characterReferenceFileNames.ts` — they left `characterReferences.ts` when it
  reached its size budget, as `characterReferenceSettlement.ts` and `characterReferenceSheetFiles.ts`
  later did.
- **A pass owns every sheet file it wrote, because a per-pass name is unbounded and nothing else
  sweeps that object prefix.** Naming a stem after its character alone made the object set bounded by the
  cast: a re-render overwrote the same paths however many times a book redrew them, which is what
  made "a losing pass leaves an orphan file" the cheap trade it was written as. The render id took
  that away. Nothing in this repo deletes anything under `images/<projectId>/` short of
  the project being deleted — `attachmentStorage.ts` expires user uploads and
  `startExportTempCleanup` expires export scratch, and that is the whole list — so **every** pass
  that does not publish leaves a *whole cast* behind for good: a provider timeout half way through
  the cast (the job's retry ladder then draws it again under a fresh id), a lease that expired under
  a slow render, a commit that stood down as a duplicate, a commit that rolled back. On a flaky
  provider day that is several casts for one book. So the pass sweeps its own, through
  `characterReferenceSheetFiles.ts`. It is safe where the commit's stale-**row** delete deliberately
  is not: a stem is unique to the pass that wrote it and the only way anything learns of a sheet is
  the `ImageAsset` row naming it, so a file whose row never landed is unreachable rather than merely
  stale, while a *published* sheet's path may still be in the hands of a page render that read it a
  moment ago. Those stay the storage noise `applyImageInsertion` and `generateImage` accept, and they
  are bounded — at most one cast per supersede. The render sweeps a cast it abandoned and
  `characterReferenceRenderLease.ts` sweeps the rest through a required `discard` hook,
  called after the lease is released, because the lease module is generic over `Rendered` and could
  not name those files if it wanted to. Required rather than optional for the same reason: a pass
  that does not sweep is a pass nothing sweeps for. And the render's first failure is *held* rather
  than thrown — a rejected `Promise.all` settles while its siblings are still inside a render, and
  their `writeFile`s would land behind the sweep.
- **Which of those objects the sweep may delete is decided by a re-read of the rows, never by an
  exception.** The hook above is called at the ways out that keep somebody else's answer, and three
  of them are settled by the commit transaction *returning*: it committed, it stood down against an
  answer this pass does not supersede, or its plan version had gone. The fourth is a throw, and the
  first version of the sweep read a throw as a rollback — `settlement` is `undefined` either way, so
  `settlement?.kind !== "committed"` swept. But a throw out of `prisma.$transaction` is not one fact:
  a callback that raised did roll back, while a `P1017`, a socket dropped between the server's COMMIT
  and the client seeing the ack, and a `$transaction` timeout raised after the callback had already
  returned all name a commit that **landed**. Sweeping those deleted every sheet of a cast whose
  rows are on the table, and the rows are what makes it unrecoverable rather than merely wasteful:
  `characterReferenceSetIsSettled` is satisfied by them, so no page, no cover and no retry ever
  redraws that cast, and every reference path the book resolves for the life of the plan version
  ENOENTs — "a published row names a picture that is no longer there", which is the outcome this
  module gave up the advisory lock to avoid. So an unknown outcome is re-read and put to
  `published`, a hook beside `supersedes` for the reason that one is beside `commit`: only the pass
  can say whether the rows name what *it* wrote, and it says so from the render id every stem
  carries, which is what makes a read taken after the lease was released sound — a rival's cast can
  neither answer for this pass nor be mistaken for it. **Both ways the question can fail lean the
  same way.** A database that cannot be read and a predicate that throws both keep the files, because
  an object deletion cannot be taken back while a leaked cast is the bounded storage noise the paragraph above
  already accepts; the two are not close enough in cost to be raced. A kept cast is written to the
  run log as `character.reference.sweep_declined` rather than left silent, since nothing else will
  ever sweep it. A stand-down that really did write nothing still sweeps, and asks the rows nothing
  to do it.
- **The face is fed in twice, and only ever into spare budget.** A page render is two redraws from
  the image the reader recognises (artwork → per-book sheet → page), so `selectReferenceImagePaths`
  appends the character's own library file *after* the sheets, capped by
  `maxReferenceImages - sheets.length` — 3 to 5 depending on the model. It may not displace a sheet:
  losing another character's design to strengthen one character's face trades one consistency
  problem for a worse one, and a page with as many characters as the budget allows keeps every
  sheet. `libraryCharacterFaceInstruction` names those trailing images as the authority on **face
  only**, because a shoulders-up avatar cannot supply pose, outfit or the book's art style. The
  sheet render's own sentence is source-aware (`characterReferenceSeedInstruction`): a drawn
  portrait is a likeness to *extend into* the book's style, adopted artwork is a design to *re-pose*
  and not restyle. That is why `portraitSource` rides the snapshot at all — and the ownership trio
  (owner-prefix, `libraryCharacterObjectKey`, object HEAD) is shared by both paths, so a snapshot naming
  another user's file resolves to nothing on the page path exactly as it does on the seeding path.
