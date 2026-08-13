# Worker generation passes

Algorithms shared by more than one handler: the book passes, the page review loop, semantic memory,
plan helpers, export publication, the reader-chapter cache, character preparation and reference
sheets, image layout planning.

If two handlers need the same logic it belongs here. Nothing in `handlers/` may be imported from
this directory — the dependency runs one way.

This is also where a compile decides whether it is allowed to *publish* what it rendered, which is
the subtlest thing the worker does. A compile can take minutes, and the project it started against
may have been edited in the meantime.

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
