# Worker generation passes

Algorithms shared by more than one handler: the book passes, the page review loop, semantic memory,
plan helpers, export publication, the reader-chapter cache, character preparation and reference
sheets, image layout planning.

If two handlers need the same logic it belongs here. Nothing in `handlers/` may be imported from
this directory — the dependency runs one way.

This is also where a compile decides whether it is allowed to *publish* what it rendered, which is
the subtlest thing the worker does. A compile can take minutes, and the project it started against
may have been edited in the meantime.

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
  it, so a delivery that lost the row inside the tail still published the keeper's story delta —
  behind a model call of its own — its continuity notes, its entity state and its page embedding,
  every one of which the *next* page reads back: the winner's manuscript carrying the loser's facts,
  notes and vectors for prose no reader will ever see. The page row is the one thing that did not
  matter there, because it is keyed on `projectId_index` and the winner drafts the same ids.
  `reviewAndSaveGeneratedPage` is therefore two halves — every provider call first, holding its
  answers in memory and writing nothing (`keeperStoryExtractForSave`, `prepareEmbedding`), then one
  assertion, then only writes with nothing slow between them — and its hook is named
  `assertOwnership` because it is asked three times, not once. The brief repair inside the review
  loop is fenced for the same reason: `casUpdateChapterProductionBrief` is read back by every other
  page in the chapter, and it too sits behind a model call. The hook stays optional, so the callers
  with no lease (the book passes, `continueBook`) are unchanged.
  **A brief repair's durable chapter write waits for the page to keep a draft it briefed.** It is the one durable
  write a review loop makes, and it was committed at the repair — before the single rewrite it
  briefs had been reviewed. On fast and balanced `finalQaRevisionsFor` is 3 and
  `pageQaRecoveryRevision(3, 3)` is 3, so recovery lands on the loop's **last** attempt: a rejected
  rewrite left `bestDraftCandidate` keeping the pre-repair draft, the page shipped FAILED_QA with
  its original prose, and the chapter row permanently claimed that page's assignment was the new
  beat — read back by every later `continueBook`, page regeneration and replan as
  `previousChapterPageBriefs`, steering them away from material the book still contains. The page
  fence could not take it back either, since the chapter committed under its own earlier assertion.
  `repairPageBriefForRecovery` (`pageReviewRecovery.ts`) therefore returns
  `{ beat, chapterBrief, persist }`: the beat and the merged brief steer this page's remaining
  rewrites in memory, and `runPageQualityLoop` takes `persist` only when the candidate it keeps was
  briefed against it — *kept*, not *approved*, because a FAILED_QA page still ships its best draft. The fence is asked for that reason at the repair as a
  stand-down — above the early return, because every page that paid for the repair's model call has
  a rewrite budget worth fencing, including one with no `chapterId` and nothing to stage — and then
  again by the owner that takes `persist`, a page's worth of provider calls later, as the write's own.
  A caller that owns the page save defers that take and runs the page write plus the brief CAS on one
  transaction client behind that one fence. On that combined path, `written` is the only successful
  CAS outcome: `no-stored-brief`, `unclaimable`, and retry exhaustion all throw inside the transaction,
  rolling the staged page back before a repaired brief can be returned or carried. A standalone loop
  caller keeps the established immediate best-effort CAS and may inspect its diagnostic outcome without
  retrying the paid planner and page work. So it is two asks wherever there is something to persist and
  one for a page there is not, never none.
  The once-per-page latch is still spent on the *call*, so a repair whose write is never taken is
  not re-attempted for free.
  **And every copy in memory waits with it, because the callers share one.**
  `repairPageBriefForRecovery` used to `Object.assign` the merge onto the `ChapterBrief` it was
  handed, so the page's remaining rewrites read the fresh beat — a write into whichever object the
  caller passed, at the moment the planner call returned and with nothing yet decided. Every caller
  that briefs a *chapter* from one brief therefore took the repair too: `bookPasses.ts` hands the
  single `ChapterSetup.brief` to every page of a chapter at all three of its passes, and
  `compileExportRepair.ts` parses one brief per chapter and briefs that chapter's other flagged
  pages from it — the carry is deliberate, but only for a repair somebody kept. The page-local edit
  became a chapter-wide one and rebuilt through memory the defect the deferred write had just
  removed through the row: page 10's post-repair rewrite rejected, `persist` correctly skipped, page
  10 shipping its pre-repair prose — and pages 11..N drafted and reviewed against a chapter claiming
  page 10 covers a beat page 10 never delivered, silent about the one it did, disagreeing with the
  row it was parsed from. Fixed once at the compile's call site with a per-page copy, it was still
  live on the generation path, which is what says the fix belongs at the seam. So the repair writes
  into **nothing** it is handed: it returns the merge, `runPageQualityLoop` rebinds its own
  `chapterBrief` to it for this page's remaining rewrites, and the same take that spends `persist`
  is what puts it on the outcome as `repairedChapterBrief`. A caller that shares a brief adopts that
  — `adoptRepairedChapterBrief` onto the `ChapterSetup`, `chapterBriefs.set` onto the per-chapter
  parse — and a caller drafting one page per job ignores it. One condition for the row and for every
  copy, so none of them can claim a repair another refused, and a caller that forgets keeps the
  brief it had rather than a beat nothing delivered. `replacePageBriefInChapterBrief` is **pure**
  for the same reason: the write-through was invisible at a call site, which is how a cache took a
  repair nothing had decided was earned. Acceptance is the gate, not the repair.
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

## Long-range memory

Five modules, split by which question each answers: `semanticRecall.ts` is the `page:` scope's read
side, `researchMemory.ts` is both ends of the `research:` scope, `embeddingWrites.ts` owns every
statement that goes into the `Embedding` table, `embeddingRepair.ts` is the backfill pass over its
holes, and `entityState.ts` (over the shared fold in `entityMentions.ts`) is the per-entity
continuity state. They were one `semanticMemory.ts` until the file reached its size budget.

Whether a book writes any of it is `strategyUsesSemanticMemory`, which lives in
`embeddingWrites.ts` — beside the writes, not beside the recall it is named for. Only the
sequential-pages mode ever *reads* this memory, so every other mode (every book inside the mobile
page ceiling) skips the embedding call per page and the per-entity writes entirely. Its seven call
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
  out of the prepare block in `pageReview.ts` beside `keeperStoryExtractForSave`, which swallows
  every failure but this one.
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

## Compiling and publishing

- **A recompile makes no model call, and that is a cache with one rule.**
  `createReaderChaptersForExport` used to run on *every* compile, including the ones the user was
  told are free and instant — a presentation toggle, an undo, a manual edit. It now returns
  `{ chapters, source }` and `readerChapterCache.ts` memoizes it to `<projectDir>/reader-chapters.json`
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
  `projectDir` mkdir is hoisted above the call site for this; do not move it back down beside the
  `book.md` write.
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
  already ran that detection.
- **A compile publishes by claiming the revision it compiled, and it renders somewhere else until
  it has.** `staleGenerationJobReason` refuses to *start* a compile whose `contentRevision` has
  moved, but that is one instant and the work behind it is minutes of QA, reader chapters and a
  Chromium render. A repair runs against a project that is COMPLETE, which is exactly the state in
  which a reader may edit — and an edit bumps the revision, deletes the compiled files, sets
  EDITING and queues its own recompile. The stale compile used to write `book.md`/`book.pdf`/
  `book.epub` over the fresh ones and then set COMPLETE *unconditionally*, so a book could sit
  finished with the pre-edit PDF for good. `generation/exportPublication.ts` renders to
  `.book-<uuid>.{md,pdf,epub}` beside the real names and publishes only after
  `project.updateMany({ where: { id, contentRevision } })` matches a row: the claim is first, so a
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
  `staleGenerationTargetReason` does with a null.
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
  provenance write two functions away already makes ("a book on disk must not be failed and refunded
  because a hundred bytes of metadata could not be written"), and "no compile may fail, publish
  differently, or retry over the map" is the rule in `packages/core/src/generation/CLAUDE.md`. So an
  unmeasured, legacy or missing map is **degraded** to the stub instead, with a warn line naming the
  project: the ranges go either way, which is the whole of what the invariant protects, and chat
  falling back to model indexes is the graceful path the stub exists for. The stub's cover-skip is
  taken from the offered map when there is one and otherwise from the stored row, read inside the
  publication transaction — the one place that read cannot race the file it describes. A row no
  parser can read a cover flag out of is a row every reader already refuses, so it is left alone
  rather than replaced by a guess.

## Character reference sheets

- **A reference-sheet filename must survive a non-Latin name.** `characterSlug` stripped everything
  outside `[a-z0-9]`, so every Persian, Cyrillic and CJK name emptied out and `safePathPart`
  returned the literal `"unknown"` — three characters in one book all wrote
  `character-reference-unknown.jpg`, and because `hasReferenceForEveryCharacter` compares *names*
  the set looked complete and was never rebuilt, so the whole cast wore whichever face rendered
  last. It now hashes the folded name when the ASCII slug is empty, and
  `characterReferenceFileStems` resolves the **whole cast's** stems together before the concurrent
  renders start, since a per-name slug cannot promise cast-wide uniqueness. The ASCII path is
  byte-for-byte unchanged so no existing book's files move.
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
  (owner-prefix, `libraryCharacterDiskPath`, `stat`) is shared by both paths, so a snapshot naming
  another user's file resolves to nothing on the page path exactly as it does on the seeding path.
