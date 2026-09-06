# Research-led planning, case evidence, and developmental editing

**Current status:** experimental and disabled by default on every tier, including live revision 49. The completed-book assessment regressed; see the [parent diagnosis and rollback](experiments/2026-09-05-fixes/regression-decision.md). The implementation history below records the experiment, not an enabled recommendation.
Implemented on 5 September 2026 following the assessment of the composed-chapters plateau. This applies recommendations 1–3. It does not change the scoring rubric or establish a new book-quality score.

## What changes

The new nonfiction flow is:

1. Gather candidate cases and source passages.
2. Extract case claims and review their support against those passages. Retry missing research, then try replacement cases within a fixed budget.
3. Develop the book from the accepted material. Chapters may merge, split, change order, change titles, and change length.
4. Compose and checkpoint whole chapters, checking their case assertions against the evidence.
5. Read the staged manuscript and execute bounded section edits across chapters.
6. Perform the final chapter line edit, check case assertions again, paginate, and atomically save the revised manuscript and its completion marker.
7. Run local page checks and publish through the existing finalization path. A page repair receives the evidence; changed case assertions are checked before publication.

All new model calls use the selected tier's writer. Extraction of verbatim source passages retains the existing adapter route. Figures remain outside prose editing and are restored before pagination and persistence.

## 1. A plan that can change its architecture

`bookDevelopment.ts` treats the old outline as an inventory of requested coverage. Each original chapter summary, key beat, and promise receives a stable coverage ID. The proposal assigns those IDs to new chapters and states each chapter's contribution and prerequisites.

The code checks complete coverage, valid chapter order and prerequisites, total page count, and evidence assignments. Each case gets one chapter for its full treatment. A later callback must identify an earlier owner and a specific new inference. A separate model review checks whether the actual chapter beats fulfill the coverage labels and whether different chapters merely repeat an inference, including cases disguised under different IDs.

The proposal also revises the author stance to fit the evidence. Its thesis must match the developed answer; the stance must retain enough positions and a usable voice sample. The writer receives this revised stance.

There are at most two proposals and their reviews, in addition to normal bounded JSON repair. Failure stops the run before drafting. The accepted chapter structure, stance, episodes, and remapped dossier are persisted together before page creation. A stale legacy arc is removed. Persistence uses a serializable transaction and checks that the plan has not changed while research was running.

## 2. Evidence packets for the cases

`caseEvidence.ts` stores source passages with URLs, claim IDs and their supporting passage IDs, documented event order, source disagreements, and details that remain unknown. Passages are sliced from retrieved documents by the existing anchor extractor; generated summaries are not treated as verbatim evidence.

Extraction and adjudication are separate calls. Every claim needs a supported verdict. Missing or duplicate verdicts, nonexistent source references, an unsupported sequence, and irrelevant material fail acceptance. This is model-assisted checking of source entailment; it is not a guarantee that a historical source is accurate or that a model reviewer cannot err. Attribution and uncertainty must survive into the prose.

An unsupported candidate is excluded from the writer's episodes. A chapter with no accepted case gets one additional retrieval using its next query, followed by one replacement-case search. The recovery phase has a ten-minute shared retrieval deadline. For fixed-chapter runs, missing material still stops generation. When research-led development is enabled, the accepted packets and explicit gaps go to the planner, which can merge and reorder the old coverage. Every resulting chapter must own a supported case or use an earlier case for a new inference; requested coverage remains mandatory. An empty evidence pool still fails before drafting.

Source discovery also uses the logged research provider to find public document URLs beyond the three catalogues. It downloads actual HTML, plain text or PDF content; search summaries never become evidence. The worker bounds downloads and PDF extraction and validates public addresses again after redirects. The reviewer checks case identity independently from individual claims, corrects provisional source attribution for the same case, and requires short verbatim anchors. A factual or chronological defect gets one extraction repair followed by a fresh review against the same passages; a wrong case requires new research.

Composition, documented scenes, developmental rewrites, final line edits, and local page repairs receive the relevant evidence. The chapter checks flag reversed findings, invented dialogue or sensory detail, inaccurate attribution, and newly introduced purportedly real cases without packets. There is one bounded factual repair followed by another check; unresolved findings keep the manuscript unpublished.

**Current retrieval limitation:** the backend remains Wikisource, Gutenberg, and eligible Archive.org material. Contemporary, specialist, and some non-English topics may fail readiness because this collection does not contain the needed sources. The change makes that limitation visible; it does not add broader contemporary-source retrieval.

## 3. Development before final polish

`developmentalEdit.ts` reads the full text with paragraph indexes. It proposes deletions, insertions, moves, combinations, or replacements. A move's source and destination belong to the same group, so an invalid destination cannot leave the source deleted.

The limits are six groups, six affected chapters, eight operations per group, and 8,000 affected/target words per group. The sum of the larger of original and replacement lengths for each operation may not exceed 30% of manuscript words, with a 600-word floor. Overlapping ranges, missing replacements, unacceptable lengths, degenerate prose, and changes touching a figure are rejected. Unselected paragraphs are copied from the original text. Manuscripts over 110,000 words skip the full-text developmental proposal and record that limitation.

Length is checked for the whole book, with figure space deducted. Cuts can be balanced by developing a named unanswered question elsewhere from the available evidence. The final line editor receives `allowExtension: false`; it does not automatically refill a cut chapter. Its ordinary polishing result is accepted only within 10% of the candidate's length. The final manuscript must still meet the book's minimum and maximum.

The revised page rows, derived chapter briefs, reports, and manuscript digest are committed in one serializable transaction. Concurrent page or plan changes abort that commit. A matching stored digest skips repeated developmental work on restart. Once publication has begun, a restart does not rewrite a mixture of published and pending pages.

## Controls and compatibility

The Quality settings add `bookDevelopment`, `caseEvidence`, and `developmentalEdit`, enabled by default for every tier. Their execution is limited to composed nonfiction. Research-led planning requires case verification even when its separate gate is disabled. Developmental editing replaces the legacy notes-only manuscript read for eligible runs; the `chapterEditorPass` gate still controls the final line edit.

Existing manuscripts with pages retain their chapter boundaries and are not retroactively replanned. A stored developed plan must match its chapters and retain valid evidence on resume. The offline `MOCK_AI` workflow skips the new production development stages; deterministic fixtures exercise them in tests without network access or paid model calls. Per-page and narrative generation retain their existing paths.

No database migration is required. Development metadata and evidence live in the planning package; edit reports also live beside the chapter composition. Provider purposes identify the new calls, and `generation.composed_chapters.development_prepared` records chapter count, packet count, excluded attempts, and whether a development plan is present.

## Verification and remaining measurement

- Core suite: 2,734 tests passed. The changed development/evidence/edit tests also passed after the final stance integration.
- Worker suite: 1,838 tests passed, five skipped. Coverage includes research recovery, preserving coverage during chapter merging, evidence failures, linked moves, figure preservation and displacement, concurrent writes, and a full staged compose/edit/finalize/restart run.
- Core, worker, web, and database type checks passed. The repository-wide type check remains blocked by existing API errors in `bookEditOperationRetries.ts`, its test, and `projectStatus.ts`.
- Lint passes with unrelated warnings. The file-size check reports existing oversized files: core `pagesReview.test.ts` and `costs.ts`, worker `pageReview.test.ts` and `restructurePages.test.ts`. Changed production files stay within the 900-line limit.

The subsequent [live benchmark and blind Sol assessment](experiments/2026-09-05-sol/report.md) ran two paid generation attempts. Both failed before drafting: the first lacked accepted packets in 11/15 chapters; the revised retry lacked them in 6/15. A reproduced Archive.org filename bug was fixed, and explicit evidence output examples eliminated the retry's JSON schema failures, but neither attempt reached research-led replanning or developmental editing. The readiness gate currently requires a case for every old chapter before replanning, preventing the planner from responding to research gaps. An exploratory Sol audit also identified source-to-case mismatches among accepted packets.

Twelve fresh Sol assessments of four complete reference books give composed-7 a mean of 7.67 and the three rung-5 books a mean of 7.19. No new manuscript exists to compare, so there is no measured quality improvement and no evidence of crossing 8. The full repository suite now passes 6,682 tests (five skipped), while the repository check retains unrelated API type, file-size, and documentation-index failures. These passing tests do not establish live pipeline readiness.

## Follow-up fixes and validation

The [follow-up experiment](experiments/2026-09-05-fixes/protocol.md) removes the old-chapter readiness dependency, broadens actual-document retrieval, and separates case identity from provisional document metadata. It also fixes the reported API type errors, splits the four oversized files, and reconciles the broken CLAUDE index entries. Full `pnpm check` now passes all seven gates: 6,704 tests passed, five skipped. The network smoke test retrieved the Yale Wannsee document and Gutenberg Apology text. Paid packet replay and full book generation are in progress; these passing checks alone do not establish a literary improvement.
