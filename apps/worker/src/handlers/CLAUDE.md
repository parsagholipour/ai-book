# Job handlers

One file per job type. A handler is the only thing that may decide a job's outcome, and several of
them decide a *book's* outcome, which is why the rules below are per-handler rather than general.

A handler may import from `../generation/`, `../providers/` and `../runtime/`. Nothing imports back
into this directory. Handlers must never import `runtime/queue.ts` — it opens a Redis connection at
import time, and keeping handlers off it is what lets them be imported in tests without a broker.

Every handler returns a `JobCompletion` from `runtime/jobTypes.ts`. Raising `StopRequestedError`
means the user stopped the run and converts to an `UnrecoverableError` so BullMQ does not retry;
**never swallow it**, including inside a fallback path — doing so turns every user-cancelled run
into a finished book.

## Which jobs own the project

Not every failure is the book's failure. `markFailed` and `markStopped` in
`runtime/jobLifecycle.ts` are a chain of early-returning branches on `job.name`, checked *before*
the default path that sets the project FAILED and refunds — `generate-audiobook` and
`generate-character-portrait` each divert to their own settlement, and a detached `compile-export`
(one carrying `DETACHED_FROM_PROJECT_LIFECYCLE`) owns nothing at all. Work out which branch your
job lands in before writing a status or a refund; the wrong answer marks a delivered, fully paid
book FAILED and hands the credits back.

Note the two predicates that decide this — `jobOwnsProjectLifecycle` in `runtime/jobLifecycle.ts`
and `ownsProjectStatus` in `compileExport.ts` — are both module-private. You cannot import and
reuse them; read them and add your branch alongside the others.

**A fence that cannot be read has a third answer, and it settles nothing.** The export repair's
ownership fence asks Postgres two or three times per repaired page across the minutes a long book
takes: advisory `exportPublicationSuperseded` reads around provider work, then a no-op
`Project.contentRevision` CAS as the first statement of the page/brief publication transaction. A
brief repair's `chapter` read and CAS ask Postgres again. A throw
from any of them is not an `ExportRepairSupersededError`, so it travelled straight out of the catch
written to keep this compile away from `markFailed` — and `compile-export` is not in
`DERIVATIVE_GENERATION_JOBS`, so BullMQ retries nothing: one pool hiccup marked a finished, fully
paid book FAILED and refunded `FULL_BOOK_GENERATION`. Standing down instead is not the fix either.
Only three compiles reach this fence at all, and one holds EDITING while another holds GENERATING.
Their immediate handoffs must not guess over an unanswered `SELECT`; the delayed
`reconcileStrandedGeneration` sweep reaches both statuses only after its grace period and after every
job is terminal, while `ensureExportRepairQueued` covers COMPLETE and REVIEW_REQUIRED.
`compileExportFence.ts` therefore
retries the read a bounded number of times and then raises `ExportRepairFenceUnreadableError`,
which stops the repair without settling the compile: the handler re-reads the manuscript and falls
through to its own supersede read and to `publishCompiledExports`' compare-and-set, both of which
bind. That successful re-read becomes the handler's manuscript for the deterministic report,
Markdown compilation and format render; otherwise pages already repaired before the failed fence
would be durable in Postgres but absent from files published under that same revision. The chapter
sweep and first whole-book verdict are not re-run: their page-scoped findings survive only for
unchanged pages, and their unscoped book-wide findings survive only when no page changed, matching
the superseded stand-down's withdrawal semantics. The truncated-pass warning records the incomplete
repair separately, while a distinct `FINAL_QA_REPAIR_INCOMPLETE` error finding keeps the exported
best-effort book in REVIEW_REQUIRED without preserving a stale content complaint or buying another
model review; any durable FAILED_QA pages are its page links. Assuming
"not superseded" would not let a loser publish — publication claims on
`contentRevision` — but it would keep the pass rewriting page rows over a reader's paid edit, which
is the harm the fence is actually for. The transaction CAS is the binding page fence: a paid edit
that commits after the preceding read makes it miss, and both page branches plus any accepted brief
repair roll back and take the same superseded stand-down. If the re-read fails too, that failure settles the compile —
a compile that cannot reach the database has earned `markFailed` — but it travels *composed*, or the
fence's evidence dies with it: `markFailed` writes `error.message` and nothing else onto the row, so
a driver error thrown in place of the fence's marked a fully written, fully paid book FAILED with no
record that its repair had stopped, and none of what stopped it. `manuscriptUnreadableAfterFence`
raises an `ExportManuscriptUnreadableError` instead, whose message says how much of the repair had
finished and then keeps the driver's own words, whose `cause` is the fence error, and which copies
that progress, `barriersCleared` and the read the fence gave up on into own *enumerable* fields — the
only form that survives `serializeError` and the JSON of `processJob`'s `job.failed` line, since a
nested `Error` renders as `{}`. A `StopRequestedError` from that read is handed back untouched. **And
a pass that stops early says so**, because the book it ships is indistinguishable from a repaired one:
`recordTruncatedRepairPass` files the structured warning every sibling stand-down files, plus a
run-log line in the same `.jsonl` as the provider calls of the pass that stopped — job progress is no
use here, since `markCompleted` overwrites it moments later. It records how far the pass got, and it
is called after the manuscript re-read, so a compile that cannot re-read settles on the composed
failure instead of filing a note about a pass it will not finish, two of whose numbers are measured
against a manuscript it never got back. **How far it got is counted in pages, by the pass.** The
fence's own tally is barriers, and it is asked twice per repaired page and *three* times for any page that
reaches a brief repair (`repairPagesFromFinalQa` at the loop top and before its writes,
`repairPageBriefForRecovery` after the planner call; the brief CAS shares the write fence), so the arithmetic that
number invited was wrong by exactly the pages that took the expensive route. `repairPagesFromFinalQa`
counts the pages it saw through to their writes — a page it could not fix included, since that page
spent its whole budget and saved its best draft — and stamps `TruncatedRepairProgress` onto the fence
error on its way out, at the throw, where the count is still what it was when the database went quiet.
**Both halves of that fraction are pages the book has.** The targets are a union of indexes — the
FAILED_QA ones, every error-severity deterministic finding's `affectedPageIndexes`, and the verdict's
own, bounded only by the book's highest index — so the pass resolves them to rows before it walks
them, and the denominator is that resolved list. Counting the raw indexes named a target the pass
could never reach and made it look one page less finished for each, which is the same arithmetic
error `barriersCleared` was demoted for; a verdict resolving to no rows at all is no pass, and
returns nothing rather than buying the caller a second `runFinalBookQa` over an unrewritten book.
`barriersCleared` stays as evidence about the fence: it is exact, and it is the only number that exists
when a fence goes dark before anything has been written.

**A final-QA rewrite never ships with the generated picture of the keeper it replaced.** The repair
prepares its story extract and embedding before opening a transaction, then claims both the queued
`contentRevision` and the exact page snapshot it reviewed. One transaction stages an illustrated
keeper as GENERATING, retires only system-owned assets for the old keeper, creates the tokened
`GENERATE_IMAGE` row, re-reads that exact job id and verifies its project, type, page, plan, prompt and
keeper token, then compare-and-swaps the staged page fields and version to terminal. Those are three
ordered statements but one durable commit: a crash before terminalization rolls back the page, asset
retirement, job and brief together, so no committed GENERATING page can wait for a callback that will
never come. A failed Redis dispatch happens after the commit and leaves the durable QUEUED row for
reconciliation. The compile itself stands down whenever it created a
replacement, and the image job's normal fan-in queues the export after no image jobs remain open.
`compileExport` repeats that open-image-job gate before any QA or render work because a Bull
redelivery bypasses fan-in: a crash after the atomic commit but before dispatch/stand-down has a
terminal keeper and a QUEUED replacement row, and may not render merely because the page is terminal.
That entry gate is only a cheap preflight. `publishCompiledExports` repeats the count after taking
the same project/content-revision lock that repair publication takes as its first statement, before
the compile-job claim, artifact renames, or project status write. The lock makes the final answer
ordered: a sibling cannot commit a replacement job between that count and publication.
Its after-completion readiness check covers the inverse race where the image finished while the
redelivered compile row was still ACTIVE and therefore could not queue its own successor. That
callback names the completed compile as its predecessor: dispatch appends one fixed successor
identity derived from that durable row id, preserving its attempt scope, so the terminal row cannot
consume the enqueue while duplicate callbacks still collapse onto one successor. The stranded
sweep recovers the same predecessor from the latest unpublished current-revision compile, so its
replay races the callback on the same key rather than creating a second row. The callback is a
latency optimization, not the only owner: `reconcileStrandedGeneration` includes
EDITING as well as GENERATING projects once their grace period has passed and no job remains open,
so a transient callback failure is replayed durably instead of stranding an edited book. Every
compile completion that makes this handoff returns
`lifecycleSettlement: "defer-to-successor"`: `markCompleted` still terminalizes the predecessor
row, which is what releases successor dedupe/fan-in, but leaves the shared `GenerationAttempt` and
`BookEditOperation` open. The successor preserves both ids and is the only compile allowed to settle
them; otherwise the predecessor's ordinary success path marks the attempt SUCCEEDED and the edit
APPLIED before a replacement image can fail, and the later failure cannot refund the already-settled
attempt. The completed row's handoff message preserves that choice across a stalled Bull redelivery,
where the in-memory `JobCompletion` no longer exists. Ordinary publishing compiles keep the default
settlement. Every handoff carries
`CompilePublicationPolicy`: review/no-verdict flags, expected publication status,
presentation fallback, and detached repair format/lifecycle. A page/image fan-in without explicit
options recovers that policy from the latest compile for the current content revision, so a free
presentation reprint or detached repair cannot silently turn into an outcome-owning full-QA pass.
If that revision has no compile row yet — an image edit that returned waiting because
GENERATE_IMAGE jobs were still open — it recovers from the latest APPLIED edit, the same mapping
`strandedCompileRecoveryPolicy` uses, so the wait cannot upgrade skip-review into full QA.
Presentation edits created before their compile intent became transactional have one narrower
legacy recovery door: when the current EDITING revision has neither a compile nor an APPLIED edit,
the immediately preceding revision's presentation compile supplies both the non-owning policy and
its exact COMPLETE/REVIEW_REQUIRED fallback. An unrelated or unfinished predecessor supplies
neither; an unknown EDITING state therefore stays untouched instead of being guessed into full QA
or COMPLETE.
For the first presentation change, the narrower historical signature is a presentation preference
on the project plus a completed, verdict-owning compile for exactly the preceding revision. Its
stored verdict supplies the old settled status; when that legacy report is unreadable, recovery
uses REVIEW_REQUIRED rather than claiming COMPLETE. The new compile is presentation-owned either
way, so it neither runs full QA nor replaces the manuscript's quality verdict.
The shared core policy module also materializes those fields into the payload and builds the durable
dedupe identity from `contentRevision` plus the complete normalized policy (and, for worker fan-in,
the page-revision fingerprint). An open compile suppresses only the same normalized policy; the same
pages queued for a presentation fallback, a detached format, or no-verdict publication are different
intents, while an exact retry remains idempotent.
Manual/operation-suffixed assets are never retired. A retry or sibling compile loses the original
page-version claim before it can reuse a terminal dedupe row; a reader edit loses the project claim.
Story delta, continuity notes, entity state and embedding writes live in
`compileExportRepairSemantics.ts`: one transaction starts with the same `contentRevision` fence, locks
the exact repaired keeper, and only then writes every memory row. There is no provider call inside it,
and an ownership miss writes none of the semantic tail.

**A compile that stands down leaves no verdict about prose it no longer speaks for.**
There are four ways out of `compileExport.ts` with nothing published — the repair losing the
manuscript mid-page, the compile's own supersede read before the render,
`publishCompiledExports`' compare-and-set answering somebody else, and open `GENERATE_IMAGE` jobs
at the top of the handler — and for a while only the first of them corrected the report. The two
late doors run *below* `recordCompileQualityReport`, so the row already holds the pass's findings
by the time they decide to stand down, and nothing is coming to replace them: the compile that
supersedes this one may own no verdict at all (a `MARKDOWN_RECOMPILE_WITHOUT_VERDICT` image edit)
or report `finalReviewRan: false` (an edit's own recompile), so `loadProjectQualityReport` kept
serving a `blocked` card about the page the reader had just paid to replace — a deterministic error
being the one finding that survives every gate in `buildManuscriptQualityReport`. The image-job
gate used to retract the column to `DbNull` instead, which is how a first attempt with no findings
could grade `passed` over a previous `blocked` card: standing down with an empty in-memory set is
the same claim. A compile that has not measured yet just requeues. Every newly stored report carries
worker-private provenance — `finalReviewRan` plus page index, revision and a title/prose digest — so
a redelivery can reconstruct `StandDownFindings` against the exact reviewed keepers without storing
a second manuscript. It must never pass the current pages it loaded as that historical snapshot:
a sibling repair can replace a keeper and open its image job under the same `contentRevision` before
the redelivery reads either. A legacy or unreadable report with no such proof retracts; none of these
doors re-runs deterministic or model QA over prose this attempt did not review. All four now go through `standDownForNewerExport`,
which takes the compile's `StandDownFindings` and *is* the thing that settles them: it withdraws every finding
naming a page the book no longer holds in that form and writes what is left of them. Filtering at
one door is a property somebody has to remember; filtering inside the only door is one that cannot
be forgotten. The findings are carried rather than the report because
`buildManuscriptQualityReport` is a grader — once it has answered there is no way back to the pages
each finding was about — and they are *withheld* rather than re-measured, because a fresh sweep
over the reader's manuscript would invent a `PAGE_COUNT_MISMATCH` the moment their edit added a
page. **A finding whose subject is the manuscript is scored against the whole book**, not kept by
default, and there are two shapes of it. One names no page — a final-QA complaint naming no page
number, the chapter sweep's empty `affectedPageIndexes`, `MISSING_PAGES`. The other names a page it
is not about: `UNPAID_PROMISE` carries the book's last page because that is where a promise gets
paid off, and read as a location that anchor was unfalsifiable, since a truncated repair moves a
prefix of the book and never reaches the last page — so a compile whose own repair had rewritten
(and possibly paid off) the promise stood down complaining about it. Both survive only a book
nothing has moved in, and the code is what tells the second apart, spelled once beside the producer
that stamps the signpost. Nothing here can tell a cosmetic edit from a paid rewrite, and the
publishing path answers the same question by re-running `runFinalBookQa` over the repaired pages,
which a stand-down cannot do — re-folding the promises over the reader's rows instead is the
`PAGE_COUNT_MISMATCH` mistake in another column, so the fold stays on the pages this compile read.
**A withdrawal that leaves nothing behind is not a pass.** An empty report is a claim, not a
silence: no findings grades `passed`, score 100 — "Quality checks passed" — so the filter written to
take a `blocked` card off a page the reader had just paid to replace could write that sentence over
the compile's own `blocked` instead, which is the one direction a stand-down may never move a row.
It is the reachable shape rather than an exotic one: a book whose only finding is the deterministic
error on the page the reader edited has exactly one finding to withhold. So an all-withheld
withdrawal is the same fact as a manuscript nobody could re-read — this compile has no claim to
make — and takes the same door below. A same-delivery compile that *measured* nothing keeps its pass,
and the asymmetry is the point: that report is already on the row at the two late doors, so writing
it again upgrades nothing. A redelivery keeps that prior measured clean pass when its durable
fingerprints still match every current page; movement makes the old clean grade unproven and retracts
it rather than throwing away or asserting a verdict on guesswork.
`withheldEveryFindingItMeasured` is where the two are told apart, and it asks about the findings
rather than about the report, because a grade cannot say which of the two produced it.
**And a read that cannot answer is a third thing to say.** The manuscript re-read the withdrawal
rests on is taken *outside* the best-effort write and on the fence's own retry budget, because a
read decides what to write and only the write itself may be dropped: folded inside it, one timeout
against the same unhealthy pool cancelled the whole write, leaving the unfiltered `blocked` card
standing at the two late doors and no verdict at all at the early one. A compile that still cannot
measure **retracts** — `recordCompileQualityReport(…, null)` clears `qualityReport` with
`Prisma.DbNull`, and `loadProjectQualityReport` selects `not: DbNull`, so the book falls back to the
last verdict measured against a manuscript that existed. Not the stale snapshot, and not an empty
report either: no findings grades `passed`, which tells the reader a book nobody re-measured is fine.
Both of that function's writes are best-effort for the same reason the repair's catch existed:
a P2025 from a retired `GenerationJob` row travelling out of a stand-down would mark a finished,
fully paid book FAILED. A `StopRequestedError` still escapes, and so does everything else — the
`recordTruncatedRepairPass` note above is guarded inside itself for exactly that reason, since a
trace filed on a path that may not fail must not be the thing that fails it.

## Page generation

- **A page's independent loads fan out, and which failure comes back is decided rather than raced.**
  `generate-page` opens with six loads that read nothing any of the others writes — the recency
  window, the continuity notes, the query embedding, the entity state, the quality context and the
  story state — so they go out together and every database read finishes underneath the one provider
  round trip in the set instead of after it. `Promise.all` is the wrong tool for that twice over. It
  settles on the *first* rejection and leaves the siblings running behind the handler's own failure
  settlement, which is a warn line or a stray provider call landing in the next job's run log; and it
  makes which error wins a matter of who lost the race. The second half is the expensive one.
  `embedSemanticQuery` re-raises the `StopRequestedError` that `LoggingEmbeddingAdapter.embed` throws
  when the reader stops a run, while `loadEntityStateLines` and `loadProjectStoryState` swallow
  everything *except* that error — so a stop is the one rejection several of these loads can produce,
  and an ordinary database error from a sibling read would mask it. `generate-page` is one of the
  three jobs with a BullMQ attempt budget (`retryJobOptions`), so a masked stop comes back as a retry
  of a run the reader already cancelled and the book is charged for it: the "never swallow it" rule
  at the top of this file, reached without swallowing anything. `settleIndependentLoads` therefore
  waits for every load and then *chooses* — a stop wins wherever in the set it came from, and
  otherwise the earliest failure in argument order, which is the failure the serial chain it replaced
  would have thrown. `allSettled` holds the rest, so none of them can surface as an unhandled
  rejection either. Keep the fan-out bounded and keep it to **reads**: at most seven statements leave
  a page job at once, which a wave of `MAX_PARALLEL_PAGE_JOBS` queues on the worker's ten-connection
  pool rather than exhausting, and nothing in it holds a transaction open across an await. Everything
  after it stays serial on real dependencies — both retrievals want that vector, and the repair pass
  writes the very embedding rows the retrieval then reads, so overlapping them would have a page read
  the memory it is in the middle of backfilling.
- **Every illustrated keeper is published in three fenced steps.** `generatePage` first claims the
  page's loaded `updatedAt` version, then commits the keeper content (and any earned chapter-brief repair)
  while the page remains GENERATING,
  then creates the image job, then exposes COMPLETED with a status-only compare-and-swap on that exact
  content. This ordering means neither a failed brief CAS can leak a picture job nor a sibling compile
  can observe a terminal page before its job exists. The job's versioned `keeperToken` is a digest of
  the project id, stable page id and page fields the image depicts; it is part of the dedupe key, and
  `generateImage` checks it before provider work, after rendering and under the asset-publication row
  lock. Content-only tokens already in the queue remain a read-only migration alias, but no producer
  may mint one. Tokenless jobs already in the queue must prove the matching durable `GenerationJob`
  and that the page version strictly predates its creation (equality is ambiguous at millisecond
  precision); a replacement stage advances that
  version even when its new enqueue fails. Keep those checks, the row-version transitions, stable
  page-id filenames and ownership-scoped asset deletion together: they make an overlapping retry
  stand down instead of overwriting a newer keeper's prose, image row, failure marker, manual asset,
  or bytes, including across a structural reindex.
  Completion and page-owned continuity notes are one transaction. After it, the story, entity and
  embedding helpers are best-effort and rethrow only `StopRequestedError` (which is unrecoverable);
  the sole retryable tail is deduped next-page fan-out. A same-plan COMPLETED redelivery therefore
  replays that fan-out only — it never reclaims or redrafts the terminal page.
- **Whether the writer tools run at all is decided by what this handler loaded, not by what the book
  is.** `shouldSkipWriterTools` (`packages/core/src/generation/writerTools.ts`) is there to keep a
  tool loop off a page with nothing to look up: on an empty story state and no research notes,
  `lookup_entity` and `search_research` can only spend model calls being told twice that there is
  nothing there. `search_memory` broke that equivalence — it reaches stored pages *outside* the
  prompt, through the `searchStoredMemory` this handler injects, and the empty story state of a long
  unresearched novel says nothing whatever about them, so page 200 of exactly the book long-range
  recall exists for was answering the gate with the state of a book that has no memory at all.
  Injecting the callback is not the answer either, because this handler injects it for every page it
  drafts, and while the recency window still reaches page 1 the whole past of the book is already in
  the prompt and a search can only hand back what the model can read. **The window starting above
  page 1 is the evidence**, which makes the gate a fact about `previousPages` as this handler loads
  it — every COMPLETED page below this one, newest first, up to a `take` that is `RECENT_PAGE_WINDOW`
  itself, which is why the gate opens on exactly the page `pastRecencyWindow` does and not one
  either side. Narrow that load, filter it, or stop passing it, and the gate quietly changes meaning
  for every book. It is read off the window rather than compared against a page number because
  `RECENT_PAGE_WINDOW` sits on the far side of `apps/* → packages/db → packages/core`: a second copy
  in core could only drift from the boundary this handler already crosses before it will spend an
  embedding call on long-range retrieval at all. What the search may reach once it runs is bounded
  separately, and that rule lives in `../generation/CLAUDE.md`.

## Image layout

**The image forks are decided by the operation's `kind` too, and the payload they used to read is
the more expensive half of that mistake.** `applyBookEdit` gated `applyImageLayout` on
`job.data.imageLayout` and `applyImageInsertion` on `job.data.imageInsertion` — the exact shape the
structural fork below was moved off — so a `MOVE_IMAGE`, `REMOVE_IMAGE` or `ADD_IMAGE` job whose
payload was rebuilt without its key fell through to the text-rewrite path. That is worse here than
for a structural job, because an image payload's `affectedPageIndexes` is **not** empty: it names
the pages the pictures sit on, so the loop found them and rewrote them. "Remove the illustration on
page 3" became a model rewrite of page 3's prose — two calls on an edit priced at zero — and an
`add_image` spent the picture's charge rewriting the page it was going on, both settling APPLIED
with snapshots for a text edit nobody asked for, and both **outside** the handlers' own redelivery
fences, because the unconditional ACTIVE and EDITING writes come before the fork. Each handler now
reads its request off the payload first and off `BookEditOperation.classifier` second
(`layoutPayloadFromClassifier`, `insertionFromClassifier`): the Apply writes the resolved intent
there in the same transaction that creates the row, and those two translate its shape — `targets`
carrying an asset id, a marker, or the operation id `chat-image-<id>` is built from — into the
queue-time one, by the same rule `resolveStoredLayoutTarget` and `queueChatAddImage` use on the API
side. A job carrying **neither** copy parts ways with price: a move or a remove is free, so it
settles as a delivered no-op through `markLayoutSkipped`, the path a vanished picture already takes;
an insertion is the whole purchase, so it throws, and only the failure path hands back the charge
and the free-tier image slot with it (`markFailed` → the attempt → `failEditOperation`, then the
project out of EDITING). That throw is asked *after* both settle checks — an APPLIED redelivery
still owes the book its export refresh — and *before* the EDITING write.

**A hero leaves `pageId` only in the same step that gives it a markdown line.** The demote path
used to write the destination page without the line and unlink the asset anyway whenever
`assetsImagePathFrom` came back null, which took the picture out of the book with nothing in the
manuscript to show for it — reachable in any deployment whose `PUBLIC_API_URL` carries a path
prefix, since `new URL(path).pathname` is then `/api/assets/images/…`. That resolver
(`packages/core/src/generation/bookImageAssets.ts`) is shared with `editChanges.ts` for the same
reason, and a null answer refuses the whole move rather than half-applying it.

## Text page edits

- **Text-edit publication is one set-based manuscript transaction followed by a durable tail.**
  `ACTIVE` is a lifecycle state, not an owner: matching it let a stalled Bull delivery and its
  replacement both rewrite and publish. Each invocation therefore carries a database-time lease
  token through provider work. Once every rewrite, story extract and optional embedding has been
  prepared in memory, `textEditPublication.ts` locks Project, the durable GenerationJob and the
  operation in that order, then publishes every page and before/after snapshot with one
  `jsonb_to_recordset` statement. The statement compares the complete before-image (including page
  revision, image prompt, quality report and story delta) and returns six cardinalities; anything
  other than one exact page/snapshot pair per input aborts the transaction. The same transaction
  advances `contentRevision`, persists the rebuilt project story state, marks the operation APPLIED,
  and settles the job and attempt. Its number of database round trips is independent of page count,
  so a whole-book edit does not turn the publication timeout into a per-page budget.
  Slow filesystem deletion, optional vector persistence and queue dispatch happen only after that
  commit. Their progress lives in `classifier.textEditFollowUp` (`exports`, `memory`, `compile`,
  `status`), so a crash returns to the missing step instead of redrafting or advancing the revision
  again. `Project.exportInvalidationRevision` is stamped with the new revision in the manuscript
  transaction; both worker and inline-API publishers refuse to install shared
  export filenames while it names the revision *they* are claiming — null, or any other revision,
  lets them through, because nothing sweeps this column and a tail killed before it clears would
  otherwise fence the book off from every future compile. The tail removes the files outside SQL, then clears only its exact barrier and
  checkpoints under the lease. Repeating an unlink is safe; a different pending revision belongs to
  a newer tail and is never touched. Memory writes re-check the project revision/plan/status and the
  exact page id/index/revision/summary, while compile dispatch carries the exact publication revision.
  A superseded tail therefore completes its still-owned lease without touching newer files, memory
  or status. Legacy APPLIED rows are adopted only through the existing exact publication claim and
  start after exports/memory, because their old publication already performed those steps.
- **An exact text edit that skips every target has no publication tail.** A partial exact replacement
  is still a real manuscript edit: its untouched snapshots are deleted, `skippedPageIndexes` is
  recorded for the operation card, and its changed pages take the ordinary export invalidation,
  `contentRevision` and compile path. But when the literal has disappeared from *every* target,
  `updatedPageIndexes` is empty and that same tail is destructive work for a manuscript that did not
  move. The delivery therefore settles under its existing text lease instead: it proves ownership,
  calls `refundSkippedEditOperation` before the APPLIED claim (so a refund failure leaves ACTIVE for
  normal failure settlement), then one transaction CASes the still-live token to APPLIED/completed,
  merges `classifier.textExactSkipped: true` and `skippedPageIndexes` onto the classifier returned by
  that lock-taking statement, deletes all unused snapshots, and restores the stamped pre-edit project
  status. The marker is text-specific — never `structuralSkipped`, whose kind and redelivery tail are
  different — and both the first operation read and the APPLIED-tail row-lock read recognize it.
  A sequential delivery therefore never claims the text publication tail; a concurrent loser sees
  the completed lease (or waits for it after losing the post-refund CAS), so neither delivery repeats
  the refund, invalidates exports, advances `contentRevision`, or queues a compile.

## Structural page edits

- **Every fork out of `applyBookEdit` — structural and both image ones — is decided by the operation's `kind`, never by the payload.**
  (The image half is written up under *Image layout* above, where the same gate cost more.)
  `applyBookEdit` gated on `job.data.structuralEdit`, which made
  `structuralEditFromClassifier` — the fallback `restructurePageOperations.ts` writes the request
  onto the classifier *for* — unreachable, and sent any structural job whose payload lost the field
  down the text-rewrite path instead. That path is not a no-op but something odder: a
  `RESTRUCTURE_PAGES` payload's `affectedPageIndexes` is always `[]`, so it claimed the operation
  ACTIVE and the project EDITING **outside** the redelivery fence and then died on "No matching
  pages found for this edit" — a paid insert failed for a reason that is not what went wrong, with
  the shift never attempted. `BookEditOperation.kind` is a non-null column written once at creation
  and touched by nothing afterwards; the payload is JSON a hand-requeue, a reconciler or a future
  trim can rebuild without a key. Gate on the column, and let the handler find the edit on either
  copy. A job carrying neither settles through `settleSkippedRestructure` with
  `structuralSkipped: "missing_request"` rather than throwing — see the refund rule below, and note
  that throwing would restore the book as COMPLETE whatever it came in as and leave the row
  recoverable, so `/resume` would charge again for a request that is still not there.
- **A structural edit's redelivery stamp comes down in the same transaction that puts the book back.**
  `restructurePages.ts` fences a second delivery on `classifier.structuralApplication`, written by
  the transaction that shifted the indexes: its presence is proof the shift landed, and a resumed
  delivery skips straight to drafting the page *ids* it recorded. Worker rollback and API Stop both
  call `compensateStructuralPageChangeTx`: it takes Project first, locks the operation, requires the
  worker's lease token when there is one and the exact stamp `appliedAt`, then erases the stamp in
  the revert's own transaction and records durable compensation completion —
  a stamp outliving the shape it describes sent the next delivery past the shift, into
  `findUnique`s that all miss and `continue`, and out the far side marking the operation APPLIED
  and recompiling an unchanged book, which the paid retry lane had just charged for again. If the
  revert *fails* the stamp survives on purpose: nothing was put back, so resuming into drafting is
  right. That delivery must not fall into `markFailed` — generic settlement refunds the ACTIVE
  operation, clears its lease and restores COMPLETE over a manuscript that is still shifted. It
  yields the lease, requeues the durable job and exits unrecoverably
  (`StructuralRollbackRedeliveryError`) so the next delivery can draft the ids the stamp still
  names. `stampDescribesBook` asks the same question of the book itself before resuming — an
  insert whose recorded ids the book does not hold in full (none, or a subset) does not get
  resumed on the strength of the stamp alone — so the fence does not rest on two writes agreeing.
  What that answer buys is a second, *locked* look and not a re-apply: it sends the delivery back
  through `applyStructuralPageChange`, whose lease CAS still answers `resumed` while the stamp is
  on the row, so the shift re-runs only once compensation has taken the stamp down too. Drafting
  then throws on a subset rather than publishing it. An APPLIED edit or a newer content revision
  wins instead; worker, Stop, and redelivery losers stand down and never refund through an
  unclaimed cleanup.
- **A direct delete or move may carry coordinates, never prose work.** New compound proposals are
  rerouted to full-book replan before pricing, but legacy or tampered `RESTRUCTURE_PAGES` rows still
  reach this handler. `guardCompoundStructuralDelivery` uses the same core instruction classifier:
  unstamped rows fail before a shift; stamped rows acquire the exact structural lease, compensate
  the exact `appliedAt` stamp through the shared DB primitive, then enter normal failure/refund
  settlement. A publication winner or another lease owner is never failed or refunded by the loser.
- **An edit the reader has already undone is terminal for every delivery of it.** The reader's Undo
  runs the same `revertStructuralPageChange` the rollback does but deliberately *keeps*
  `structuralApplication` — it is the record of what the edit did and what the operation card reads
  back — and stamps `classifier.undoneAt` in the same transaction. So a redelivery finds a stamp
  that still says "the shift landed" describing a shape the book no longer has, and the row is
  still APPLIED: it took the export tail, which deletes the PDF the undo's own recompile had just
  published and bumps `contentRevision` past the revision that compile is waiting to claim, all for
  an edit that is already gone. `restructurePages.ts` stands down on `undoneAt` before any of that,
  on the handed-in row and again on the re-read one (an undo can only land on an APPLIED row, which
  is the status the ACTIVE claim skips, so the re-read is the first thing that can see one that
  arrived mid-delivery). It writes **nothing** on that path — no refund, no pre-edit status restore,
  no classifier rewrite — and that is the second half of the rule: `canUndoBookEdit`
  (`apps/api/src/mobile/manualEdits.ts`) reads exactly `undoneAt`, so any settlement written here —
  `settleSkippedRestructure` merging a classifier read before the undo, say — would put an
  already-reverted edit back in front of the reader as undoable and revert it a second time. The
  predicate is asked with the button's own test for that reason.
- **A settlement merges onto the classifier it re-reads under its own row lock, never the copy the
  delivery carried in.** `settleSkippedRestructure` wrote `{ ...stored.classifier, structuralSkipped }`
  onto a row read near the top of the handler — before the plan-version reads, the provider
  construction and the whole `applyStructuralPageChange` transaction — so anything written into that
  JSON across the window came straight back off: a concurrent rollback's `structuralRolledBackAt`, a
  stamp a racing delivery had just committed, and the reader's `undoneAt`. That last one is the
  expensive one, and this was the remaining door by which it could be erased — an undo runs against
  an APPLIED row, so it commits while this delivery holds the row ACTIVE on its way to a refusal, by
  which time the terminal branch above has already read the row. `canUndoBookEdit` reads exactly
  `undoneAt`, so putting the pre-undo copy back re-offers Undo on an already-reverted edit and runs
  `revertStructuralPageChange` a second time over a restored book, un-deleting its pages and
  re-approving the base plan. The settle now opens its transaction with the APPLIED claim, which is
  what takes the row's write lock, reads the classifier under that lock and merges onto what it
  found — the rule `applyStructuralPageChange` writes its own stamp by
  (`apps/worker/src/generation/CLAUDE.md`), and the reason the lease columns live outside
  `classifier` at all. Both writes stay in the one transaction, so the marker still cannot land
  before the write that takes the book out of EDITING.
- **The stamp proves the shift; the durable lease owns everything after it.** The transaction locks
  Project first, then its database-time operation CAS gives one delivery the expiring token, so one
  delivery shifts and every cancellation path follows the same order.
  A concurrent `already-applied` loser waits instead of falling through: returning immediately
  would mark the shared `GenerationJob` COMPLETED under the winner, while drafting would give both
  deliveries the same inserted page ids. If the owner crashes, expiry lets the waiting redelivery
  resume those ids; if it crashed after APPLIED, the replacement owns only the export tail. A
  heartbeat keeps ordinary provider waits live, and structural insert review is deferred: drafting,
  page QA, adherence review, embedding preparation and story extraction produce only an in-memory
  publication candidate. After any shortfall refund and the last heartbeat barrier, one short
  Project-first transaction renews and locks the exact ACTIVE owner, publishes every inserted page
  and its optional savepoint-isolated memory, stores the adherence audit, increments
  `contentRevision`, and marks the operation APPLIED with that publication revision. Stop therefore
  either wins before this transaction and rolls the placeholder/index/plan shift back with no prose
  or success audit left behind, or waits on Project and finds an APPLIED edit it cannot cancel; there
  is no published-prose/ACTIVE interval. A legacy row from the former split publication whose pages
  and satisfied audit are already durable takes the same transaction with no candidates, closing it
  APPLIED without regenerating or rewriting prose. Rollback begins by proving that same unexpired
  token under the operation's own row lock. A stale catch therefore cannot revert, fail or refund
  the winner — but the proof is an assertion, not a renewal, so it buys the critical section the
  lock covers and not the minutes a renewal used to add after commit. **An uncompensatable delivery
  requeues only while its stamp is still on the row**: `redeliverWorkerGenerationJob` has no attempt
  cap, so an outcome that can never change — a `structuralApplication` that no longer parses, a
  kind or project mismatch — settles through `markFailed` and refunds instead, and the outcomes are
  an exhaustive switch so the next one added is a compile error rather than an infinite requeue.
  The lease completes only after the compile dispatch tail; its columns are deliberately
  outside `classifier`, whose whole-document merges would otherwise erase a concurrent heartbeat.
  **The pre-flight refusal settles under the same lease**, which is the half that was missing: the
  page read `resolveStructuralPageEdit` answers against is taken outside every claim, and "the pages
  this request names are not in the book" is exactly what a *winning* delivery leaves behind — it
  deleted them, or moved the indexes the request was written against. Settling on that read refunded
  the charge, marked the row APPLIED with `structuralSkipped` and put the book back down under a
  delivery that had already shifted it, whose own APPLIED write then failed (it claims ACTIVE) and
  whose rollback could not run either, because that renews the lease the settlement had just
  cleared: a shifted manuscript, the pre-edit PDF with no recompile coming, a refund, and a row
  saying the edit was delivered as a no-op — which `operationCanUndo` refuses an Undo.
  `settleRefusedRestructure` therefore takes the claim **before** the refund, settles only while it
  owns an unstamped, unfinished row, and hands every other answer to `resumeClaimedStructuralDelivery`
  the way the shift's own losers are handed there. **Acquiring that lease is only half of holding
  it.** The settle then refunded with no heartbeat and wrote unconditionally, so a ledger call, a
  paused process or a failover outlasting the three-minute expiry let a replacement acquire and
  begin shifting while this transaction marked *its* live edit APPLIED with `structuralSkipped`,
  cleared its token and restored the project — the same three writes one lease later, with the
  charge handed back under a delivery still working against it. `settleSkippedRestructure`
  (`restructurePagesSettlement.ts`, its own file for that reason) runs a heartbeat for the whole
  call, proves ownership at the barrier *before* the refund — the last moment the money can still
  be declined — and writes through `settleSkippedStructuralPageLeaseTx`, the skip's twin of
  `markStructuralPageLeaseApplied`: the same database-time CAS on this token, an unexpired lease
  and an ACTIVE row, returning the classifier the marker merges onto. Zero rows writes **nothing**
  — not the marker, not the project's status — and returns rather than throwing, because throwing
  hands a book somebody else is editing to `markFailed`. The refund is already spent by then and
  logged loudly; that order is deliberate, since the alternative is an APPLIED row no refund path
  reaches. A reader's Undo landing since the handler's
  re-read is not that skip-settle: the winner's shift is already back, Undo is allowed as soon as
  the row is APPLIED (before `markCompleted` succeeds the still-ACTIVE attempt), and skip-settling
  would refund that attempt and overwrite the Undo's EDITING + `contentRevision` bump with the
  pre-edit COMPLETE — after which `bookPageMapForProject` refuses the behind map. That path writes
  nothing, the same as the early `undoneAt` branches. The `stale` branch was
  always fenced — `applyStructuralPageChange` asks the resolver's question again under the claim it
  is holding — and this is the same fence given to the refusal decided before that transaction.
  **A wait that gives up is not a successful return.** Both waits carry a deadline now (see
  `apps/worker/src/generation/CLAUDE.md`), so every caller has a third answer to hold.
  `resumeClaimedStructuralDelivery` reads acquire-wait `abandoned` as owning nothing and **throws
  `UnownedStructuralDeliveryError`**: no tail to replay, no EDITING to hand back, and no return
  into `markCompleted`, which would mark the shared `GenerationJob` COMPLETED under a live owner
  still drafting (a 10-page insert routinely outlasts the wait). `processJob` must not `markFailed`
  that error either — acquire-wait `abandoned` is a *busy* owner, so failing the row would refund
  and fail an insert that is still writing. The waiter exits unrecoverably so it does not occupy a
  slot; the owner keeps the durable job. The two lease-lost catches around drafting and rollback
  still **rethrow** the lost-lease error after a *completion* wait that answers `abandoned`: that
  wait means nobody finished the shift, so `markFailed` settles it the way it settles any other
  drafting failure, with the refund, the FAILED row and the book out of EDITING. Returning there
  instead would leave the project in the state the stranded sweep cannot reach while this shared
  durable row remains ACTIVE, over a wait that had already given up. The three waits *after* the
  export tail ignore the answer on purpose: the recompile is queued
  by then, so all that is missing is the lease's own completion write, and the next delivery
  replays that tail idempotently.
- **A delivered edit outlives a recompile it could not queue.** `maybeEnqueueCompile` is the last
  thing every apply handler does, and by then the pages are written, the operation is APPLIED and
  the old exports are already deleted — so its failure has nothing to do with whether the edit
  landed. `restructurePages.ts` used to make the call from inside the same `try` as drafting, and a
  Redis blip after a successful insert therefore reverted the shift, flipped the delivered
  operation FAILED and rethrew into `markFailed`, which marked a book that was COMPLETE a moment
  earlier FAILED: the reader's new pages vanished, the book asked for attention, and the leftover
  stamp met the next delivery. `queueRestructureCompile` swallows it instead, the way
  `applyBookEdit` and `applyImageInsertion` already swallowed theirs — and so does
  `replayAppliedRestructure`, where the operation is APPLIED before the job even starts. The
  recovery is the same for all three: a project left COMPLETE with its files missing is exactly
  what `ensureExportRepairQueued` rebuilds. **EDITING is the state to avoid** once nothing is coming
  to leave it: `reconcileStrandedGeneration` can recover it only after its grace period and after
  every job is terminal, while the repair lane refuses it. All four forks therefore restore a
  settled status on `not-ready`, the one dispatch outcome that already proves no immediate compile
  is behind it.
- **The status every apply fork restores rides the payload, because the enqueue is what takes it away.** It is
  COMPLETE for almost every book and REVIEW_REQUIRED for the ones the reader still has to look at,
  and nothing on this side can tell them apart: `queueChatRestructurePages` writes
  `status: "EDITING"` in the same committed transaction as the `GenerationJob` row, so the project
  already says EDITING before the first delivery starts. `restructurePages.ts` read it one line
  *after* its own EDITING write and then tested `project.status === "REVIEW_REQUIRED"`; moving that
  read one line *earlier* only relocated the dead code, and a book with open quality findings still
  came out of any restructure looking finished. A redelivery has it worse still, because the first
  delivery leaves EDITING on purpose, so `replayAppliedRestructure`'s own read was never a pre-edit
  status either. All four Apply enqueue sites now stamp `PRE_EDIT_PROJECT_STATUS`
  (`packages/core/src/jobScope.ts`, beside the presentation reprint's own fallback key) onto the
  payload from the row each transaction is about to move. Text, insertion, layout and restructure
  read `preEditProjectStatus(job.data)` once in their own fork and thread it through every path that
  settles the book itself: skipped-edit no-ops, missing-plan exits, `not-ready`/failed compile
  handoffs and APPLIED replays. `runtime/jobLifecycle.ts` uses the same stamp for failed and stopped
  edit exits. A job with no key means COMPLETE, which is what every row enqueued before it meant. It
  is a *fallback*, never a publish: queued or waiting recompiles keep the project EDITING until the
  compile earns its own verdict and writes the status itself.
- **Every apply fork stays EDITING until its recompile publishes, and the page map is why.**
  `restructurePages.ts` used to retire EDITING before invalidating the exports, so that the outcome
  of a lost enqueue was already the state the repair lane rebuilds. But EDITING is not only a
  progress light: `bookPageMapForProject` (`apps/api/src/bookPageNumbering.ts`) reads it as "the new
  PDF has not been published, so the reader is still looking at the file this map was measured
  from", and it is the *only* window in which a map behind the manuscript is kept in force. Retiring
  it in the same write that bumped `contentRevision` therefore refused the `pdfPageMap` that
  transaction had just carefully re-pointed (`repointedPageMapUpdate`), from the instant the edit
  landed until the recompile published minutes later — and a book that is COMPLETE is a book the
  chat will take an edit for, so the reader's next "page 12" was read as model page 12 while printed
  page 12 was still on screen. The status now moves the way `applyBookEdit`, `applyImageInsertion`
  and `applyImageLayout` move it, with `queueRestructureCompile` restoring the pre-edit status on
  `not-ready`. The write that *puts* it there is conditional for the mirror-image reason
  (`claimProjectEditing`), and its count is what every abandoning path reads. The ACTIVE claim
  above it fences nothing concurrent — ACTIVE matches ACTIVE — so a second delivery can settle the
  whole edit between that statement and this one, and settling puts the book back *down*. An
  unconditional `update` then lifted a finished book into EDITING, and the forks that follow it
  write nothing and queue nothing: the shift's claim answering `completed` or `settled` on a
  skipped row, and a waited lease that was already complete, all returned with the book stranded
  until the delayed EDITING sweep's grace period elapsed. `releaseProjectEditingClaim` preserves
  the immediate handoff by putting `preEditProjectStatus` back on exactly those forks, and only
  when the count says this delivery is what moved the book — a
  `false` count means the project was already EDITING, which is the owning fork's window and has
  to be left standing.
- **An edit that settles itself as a delivered no-op has to refund itself too.** `restructurePages`
  answers a resolver refusal — the book changed under the card — by marking the operation APPLIED
  with `classifier.structuralSkipped` and returning normally, which is right: nothing broke, and
  throwing would mark a finished book FAILED. But *completing* is the one path no refund reaches.
  The attempt behind a chat edit reserves **and commits** its credits when the edit is queued
  (`startGenerationAttempt`), so `markCompleted` marks that attempt SUCCEEDED and the spend is
  final; `markFailed`, `failGenerationAttempt` and `failEditOperation` never run. A skipped
  *insert* was charged `pagesBilled × pageRegenerationPerPage` for pages nobody will ever read, and
  `operationCanUndo` refuses the row, so the reader had no recovery either. The branch now calls
  `refundSkippedEditOperation` (`runtime/jobLifecycle.ts`, the only file in the worker that
  refunds) **before** claiming the operation APPLIED, and that order is the point twice over: the
  attempt is closed CANCELED so the completion behind it cannot claim a SUCCEEDED it would clear
  `refundPending` with, and a settlement that throws leaves the ACTIVE row `failEditOperation`
  claims. A free delete or move goes through the same call — it is a no-op on an operation with no
  ledger entry, and branching on the price is how the next priced skip inherits this bug.
- **A delivered no-op is APPLIED too, and the redelivery tail is not idempotent for it.** Both the
  entry fence and the `activated.count === 0` re-read used to answer any APPLIED row with
  `replayAppliedRestructure`, which is right for a row that shifted pages — its exports are already
  deleted, and the recompile its first delivery may have died before queueing has to be queued again
  — and destructive for one carrying `classifier.structuralSkipped`. That row changed *nothing*: no
  shift, no drafting, no export invalidated, `contentRevision` untouched. Replaying it deletes the
  finished PDF the reader is holding, moves the manuscript past the `pdfPageMap` measured from it
  (held in force only while the project is EDITING, so a `not-ready` dispatch restores COMPLETE with
  the map one revision behind and the chat silently drops back to model indexes for a book whose
  printed numbers never moved), and queues a full unbilled `compile-export` — no `skipFinalReview`,
  not detached, so it owns the verdict and a `blocked` report hands a COMPLETE book back as
  REVIEW_REQUIRED. All off a redelivery of an edit that did nothing. Every door that can resume that
  tail reads `classifier.structuralSkipped` off the row before it does — the entry fence, the
  `activated.count === 0` re-read, and the `"settled"` outcome a delivery meets when another one
  finished the operation while this one was resolving its plan — a marker that already existed and
  is the same one `operationCanUndo` reads to refuse the row an Undo. The reachable door is not the crash window but the racing one: `staleGenerationJobReason`
  cancels a redelivery whose attempt the refund closed CANCELED, but a second delivery already past
  that check — a stalled lock reclaimed, a stray host worker on the same queue — lands on the
  APPLIED row the first one just wrote. For the same reason the skip's two writes are now **one
  transaction**: the marker is what tells that second delivery to stand down, so it may not land
  before the write that takes the project out of EDITING.
- **A recorded structural insert is indivisible: a delivery that cannot write every page it
  recorded rolls back and is refunded whole, never by the page.** A resumed insert drafts the exact page ids the
  shift stamped. If any recorded id is missing, `draftInsertedPages` logs the missing rows, publishes
  none of the survivors, and throws into the existing exact-owner rollback; treating a surviving
  subset as delivery would claim adherence for an edit the reader did not receive. When the whole
  set exists, its ids drive `affectedPageIndexes`. Nothing prices this fork by the page any more:
  a surviving subset is never published, so the throw reaches `markFailed` and the reader is
  refunded the whole charge rather than a slice of a book with blank pages in it — which is why
  `refundUnwrittenEditPages` now has no production caller. Redelivery safety for any refund is the
  ledger's operation-derived settlement key. See `packages/db/CLAUDE.md`.
- **Only the post-APPLIED window is that handler's to flip.** The `updateMany` after the rollback
  claims `status: "APPLIED"` and deliberately does not claim ACTIVE: a drafting failure — the
  ordinary one — leaves the operation ACTIVE, and `markFailed` settles exactly that row through
  the attempt and `failEditOperation`. Widening the claim takes the row out from under the refund.
- **EDITING is a shared state; an edit publication owns it by operation and revision, never by
  status alone.** A delayed APPLIED delivery can meet EDITING from a newer edit before that edit
  advances `contentRevision`, and a presentation reprint can open the same state without changing
  manuscript revision at all. `BookEditOperation.publicationRevision` is written with APPLIED and
  the project revision in the mutation transaction. `editProjectStatus.ts` then locks Project
  first (the export-publication/stop order), locks the named operation, and accepts a claim or
  restore only when its phase and revision still match and neither a later operation nor a later
  project job exists. The operation's own apply job is exempt; a compile additionally exempts its
  own durable row. Exact-text and layout no-ops use the ACTIVE owner for first-delivery settlement
  and their APPLIED no-op marker for replay, since they deliberately have no publication revision.
  Compile publication repeats the operation/revision fence under its project lock, because a newer
  enqueue can start after the handler's claim and before a minutes-long render publishes.
  **An APPLIED structural replay never creates a second revision.** Its mutation transaction already
  incremented `Project.contentRevision` and stamped that exact value on the operation; repeating the
  increment made the replacement compile anonymous, so owner inference could not bind it back to the
  edit. The replay claims that original operation/revision under the structural lease, invalidates only
  while the claim still owns the lifecycle, and requires compile dispatch to match the stamped revision.
  A newer revision or lifecycle makes the stale tail stand down without touching files or status.
  **A null publication stamp is legacy evidence only while its apply job is still open.** Migration
  000059 and `editProjectStatus.ts` adopt the current project revision only for an APPLIED mutation
  whose own project-scoped `APPLY_BOOK_EDIT` row remains QUEUED/ACTIVE, with no later operation or
  project job. No-op, rolled-back and undone classifiers are excluded. The migration covers rows
  already in that crash window; the locked runtime check covers an old worker crossing the migration
  during a rolling deploy. Every other historical null stays ambiguous and owns nothing.
  **Project is the root of the edit lock order.** Any transaction that can lock both Project and
  BookEditOperation takes Project first; a publication that also locks its durable GenerationJob
  takes Project, then GenerationJob, then BookEditOperation. Stop uses that same order before it
  revokes an ACTIVE lease. Operation-only snapshot/page writes may still begin with their lease CAS,
  because they never wait for Project while holding it.

## Covers and portraits

- **A cover that cannot be drawn now finishes the book instead of failing it.** The cover is the
  last thing a book makes, so a total image-provider outage used to mark a fully written, fully paid
  project FAILED and refund `FULL_BOOK_GENERATION` — `generate-image` has no retry attempts
  (`retryJobOptions` in packages/core/src/jobDispatch.ts) and is not in
  `DERIVATIVE_GENERATION_JOBS`. `generateCover.ts` now catches anything that is not a
  `StopRequestedError` and renders a designed cover, recording
  `coverFallbackReason: "ai_cover_failed"`. The stop check is load-bearing: swallowing it would turn
  every user-cancelled run into a finished book.
  **The reference sheets are on the far side of that guard, and they are an enhancement rather than
  a precondition.** `ensureCharacterReferenceAssets` is awaited some seventy lines *above* the
  `try`, which was safe only while it blocked on `pg_advisory_xact_lock` and could not really fail
  from contention. `characterReferenceRenderLease.ts` split it into two interactive transactions
  with a `maxWait` of `CHARACTER_REFERENCE_POOL_WAIT_MS`, nothing between them catches, and
  `MAX_PARALLEL_IMAGE_JOBS + 1` jobs reach the claim at once by design — so a P2024 pool timeout is
  an *expected* outcome, and it travelled straight past the fallback into the FAILED-and-refunded
  path this rule closed, for a consistency aid rather than for a cover. Both handlers that own a
  picture and no retry budget now take the sheets through `characterReferenceAssetsOrNone`
  (`../generation/characterReferenceTolerance.ts`): the cover is drawn without them, and the
  designed-cover fallback still stands behind it if the artwork also fails. `generateImage.ts` calls
  it for the same reason at a smaller price — its own catch writes `Page.imageFailureReason`, which
  is durable and which nothing retries, so a ten-second pool timeout permanently cost a page an
  illustration nobody had attempted. The tolerance lives at those two call sites and **not** inside
  `ensureCharacterReferenceAssets`: `generate-book` is in `NETWORK_RETRYABLE_JOB_NAMES` and its
  ladder is the right answer to an outage that costs a whole cast. A stop still travels, and the
  give-up is written to the character-reference run log as `character.reference.unavailable`, since
  it is the fifth way a page ends up drawn with no sheet and they are indistinguishable from the
  book.
- **The portrait job is the one `GenerationJob` with no project.** `GENERATE_CHARACTER_PORTRAIT`
  runs with `projectId` null, which is why that column is nullable: every project-scoped query
  (stop, settlement, status, `failureMessage`) simply never sees the row, and
  `staleGenerationJobReason` still runs its CANCELED-row and settled-attempt checks before the
  project section it skips. Failure settles through the attempt boundary plus
  `failCharacterPortraitForJob` in `runtime/jobLifecycle.ts`, which flips the `LibraryCharacter`
  row FAILED and touches nothing else; the row's QUEUED/GENERATING claim in
  `POST /api/mobile/characters/:id/portrait` is what makes a second start a 409 rather than a
  second charge.

## Audiobook narration

- **An audiobook is made *from* a finished book, so failing one must not touch the book.**
  `markFailed`/`markStopped` return early for `generate-audiobook`, routing it to
  `failAudiobookForJob`, which refunds `payload.billingLedgerEntryId` and marks the `Audiobook` row
  FAILED. The default path would set a COMPLETE project to FAILED and refund
  `FULL_BOOK_GENERATION` — someone else's charge entirely.
- **Narration is chaptered deterministically, never by the model.** `audiobookChapterPlans` uses the
  book's own `Chapter` rows, or `createDeterministicReaderChapters` when it has none — deliberately
  not `createReaderChaptersForExport`, which the exporter uses. A retry has to produce the same
  partition, or it would renumber chapters whose audio is already on disk and marked READY. For the
  same reason a chapter flips to READY only after *both* `chapter-<n>.mp3` and
  `chapter-<n>.timeline.json` are renamed into place, which is what makes a resumed job safe.
- **Sentence timings are measured, not guessed.** A TTS request ("chunk") holds whole consecutive
  sentences of one paragraph under ~400 characters, so every chunk boundary is a real audio boundary
  with an exact time. Only *within* a multi-sentence chunk is the span split by character count, and
  that error is erased at the next boundary rather than accumulating. The result is a sidecar
  `chapter-<n>.timeline.json` — the transcript the app highlights is rendered from those segments,
  not from `Page.markdown`, so what is shown is exactly what was spoken.
(3) `synthesizeChunks` stops its siblings on the first failure: `Promise.all` rejects but cannot
cancel, and workers left running narrate the rest of a chapter nobody will keep, spending the quota
the *next* attempt needs.
