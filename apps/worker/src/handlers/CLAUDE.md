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

## Image layout

**A hero leaves `pageId` only in the same step that gives it a markdown line.** The demote path
used to write the destination page without the line and unlink the asset anyway whenever
`assetsImagePathFrom` came back null, which took the picture out of the book with nothing in the
manuscript to show for it — reachable in any deployment whose `PUBLIC_API_URL` carries a path
prefix, since `new URL(path).pathname` is then `/api/assets/images/…`. That resolver
(`packages/core/src/generation/bookImageAssets.ts`) is shared with `editChanges.ts` for the same
reason, and a null answer refuses the whole move rather than half-applying it.

## Covers and portraits

- **A cover that cannot be drawn now finishes the book instead of failing it.** The cover is the
  last thing a book makes, so a total image-provider outage used to mark a fully written, fully paid
  project FAILED and refund `FULL_BOOK_GENERATION` — `generate-image` has no retry attempts
  (`jobRetryPolicy.ts`) and is not in `DERIVATIVE_GENERATION_JOBS`. `generateCover.ts` now catches
  anything that is not a `StopRequestedError` and renders a designed cover, recording
  `coverFallbackReason: "ai_cover_failed"`. The stop check is load-bearing: swallowing it would turn
  every user-cancelled run into a finished book.
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
