# Worker generation passes

Algorithms shared by more than one handler: the book passes, the page review loop, semantic memory,
plan helpers, export publication, the reader-chapter cache, character preparation and reference
sheets, image layout planning.

If two handlers need the same logic it belongs here. Nothing in `handlers/` may be imported from
this directory — the dependency runs one way.

This is also where a compile decides whether it is allowed to *publish* what it rendered, which is
the subtlest thing the worker does. A compile can take minutes, and the project it started against
may have been edited in the meantime.

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
  edit a delivered no-op), and the **first statement** of rollback.
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
  the revision, queued nothing, and left the book EDITING for good: no sweep looks at EDITING
  (`reconcileStrandedGeneration` only takes GENERATING) and `ensureExportRepairQueued` only at
  COMPLETE and REVIEW_REQUIRED, so the auto-repair lane could not reach the state its own repair
  had caused. That count is now revision-aware — a compile carrying a superseded revision will
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
