# Mobile API

Everything under `/api/mobile` — the surface the Flutter app uses. This is the product; the
operator API in `../routes/` is not.

It is also the largest directory in the repo (115 files, ~39k lines, 60% of the API), so the
invariants below are grouped. Read the group that covers what you are touching.

## Adding a route

1. Put the handler in the matching group under `routes/`, or add a group and call it from
   `../mobileProjects.ts`.
2. Body validation: a Zod schema in `schemas.ts`. If the route is documented, add the parallel
   JSON-schema fragment there too — Fastify's OpenAPI output uses that copy, and there is no
   generator, so the two drift unless changed together.
3. Response shape: a DTO type in `dto.ts`, returned with `satisfies`.
4. Auth: `requireMobileAuth(request, reply)` and bail when it returns null.
5. Anything priced goes through the credit reserve/commit/refund flow in `@book-maker/db/billing`
   — see the `add-priced-operation` skill, and close the loop on the failure path too.

Route groups are registered **directly on the same Fastify instance**, not via `fastify.register`,
so they share one encapsulation context — the `application/octet-stream` parser registered there
covers the attachment upload routes. Moving to `register` would break that.

## Serializers are the API contract

`projectSerializers.ts` decides what the app sees. Provider names, model ids, raw queue state and
internal error text stay out of mobile responses; the `serialize*` functions there and
`sanitizePublicChatMetadata` in `projectChat.ts` enforce that. Widen them deliberately, not by
spreading a row. Note the leak guard rejects any wire key containing "model", which is why the app
reads a `qualityPreset` rather than a `modelTier`.

## A finished book prices every edit as a proposal first

Nothing is reserved or written until Apply, which is what makes the chat router safe to default
aggressively: a wrong guess is one Cancel away. Several invariants below depend on that property —
do not add an edit path that charges or writes before the card is confirmed.

## Tests

`*.test.ts` here share `testing/mobileApiHarness.ts` (fixtures and record factories). Add to it
rather than duplicating per suite.

`testing/mobileApiMocks.ts` must import **only** `vitest`. Its factories run inside `vi.mock(...)`,
so importing anything that transitively reaches a mocked module deadlocks the registry — the suite
hangs rather than failing, which is slow to diagnose.

## Index

- [Billing surfaces](#billing-surfaces)
- [The edit chat router](#the-edit-chat-router)
- [Export repair and the quality verdict](#export-repair-and-the-quality-verdict)
- [Free presentation edits](#free-presentation-edits)
- [Characters](#characters)
- [Voice and audiobook routes](#voice-and-audiobook-routes)

## Billing surfaces

- **Cancelling belongs to Google Play; the app's job is to say what it costs and then re-ask.**
  A real subscription can only be cancelled in the Play subscription centre, so
  `billing_cancel_sheet.dart` states what the reader keeps and what free grants, hands over via
  `playSubscriptionsLauncherProvider`, and then offers `POST /api/mobile/billing/subscription/refresh`
  — which re-verifies the stored `purchaseToken` on demand. Without that the app would keep saying
  "renews" for weeks, because the hourly sweep only re-verifies when `nextCreditGrantAt <= now`,
  i.e. at period end. `plan.cancelAtPeriodEnd` is `status === "CANCELED" || autoRenewing === false`
  — Play reports auto-renew off well before it moves the subscription — and when it is true
  `renewsAt` is null and `endsAt` carries the date, so no surface can call an ending plan renewing.
  `POST /api/mobile/billing/subscription/cancel` really cancels, but **only** under
  `MOCK_GOOGLE_PLAY_BILLING` (`plan.canCancelInApp` tells the app which button to draw): the mock
  verifier always answers ACTIVE, so a dev account that ever bought a plan could otherwise never
  see the free tier again. `endSubscriptionNow` nulls `purchaseToken` for that reason — leaving it
  would let the next refresh or sweep resubscribe you. Restore purchases in a debug build is how
  you get back to Creator for the next run.
- **The free tier's illustrated-book limit has two claiming doors — plan approval and the chat
  `add_image` Apply.** `POST /api/mobile/plans/:id/approve` claims the `UsageCounter` slot for a
  generation planned with images (403 `IMAGE_LIMIT_REACHED` when it is gone — never a silent
  downgrade to text-only), and the chat `add_image` Apply claims one when it is about to make a
  *text-only* book illustrated — only then, and only when the recomputed cost is above zero: an
  already-illustrated book spent its slot at approve (or at a prior `ADD_IMAGE`, which the
  predicate counts even after an undo), and a zero-priced image writes no ledger entry to carry
  the claim, so a failure would leak the slot for good. Either claim is stamped onto the
  reservation as `metadata.imageQuota`, so `refundCreditLedgerEntry` hands the slot back on every
  failure path without each of them knowing about quotas — which is why the confirmed `/resume`
  retry lane, which re-charges a failed attempt, also re-claims: for a `FULL_BOOK_GENERATION`
  retry priced with interior images, and for an `IMAGE_GENERATION` retry whose payload carries
  `imageInsertion`, through the same `addImageQuotaLimit` decision the original Apply used.
  **Known, pre-existing gap:** a chat replan copy carrying `illustrationsEnabled` generates an
  illustrated book through the worker's self-approval, with no approve step and no claim.
- **Chat replies never name a credit price.** The number travels as
  `metadata.creditsCharged` (queued work) or `metadata.editProposal.credits` (a proposal), and the
  app draws it as the tappable badge in `credit_cost_badge.dart` — one place that also explains what
  credits buy and that failures are refunded. `stripCreditAnnouncement` in
  `apps/api/src/mobile/projectChat.ts` removes the old sentence from transcripts written before
  that, so a new priced reply that writes the price into its text would say it twice.

## The edit chat router

- **The edit chat gets one clarifying question per request, and it is enforced three times.**
  A second question is a loop the user cannot escape: a `scope` clarification whose scope is
  `"none"` is satisfied by no reply, so "just add" is met with the same question forever. Once
  `findPendingScopeClarification` reports an open `scope` clarification that the new message
  neither answers nor cancels, `apps/api/src/mobile/routes/projectChat.ts` merges the stored
  request with the follow-up (`messageWithFollowUp`) and sets `clarifyExhausted`. That flag drops
  `clarify` from the router's action enum (`decideActionsFor`), *skips* the
  `BOOK_EDIT_CONFIDENCE_THRESHOLD` demotion — which would otherwise turn the hesitant decision
  straight back into the question — and finally `forcedDecision` coerces any surviving `clarify`
  into a whole-book `page_rewrite`. All three are needed: the prompt covers the model, the
  coercion covers a router timeout and the model-free heuristics, whose catch-all is a clarify.
  Defaulting this aggressively is safe **only** because a completed book prices every edit as a
  proposal card first — nothing is reserved or written until Apply, so a wrong guess is one Cancel
  away. For the same reason the confidence demotion never applies to the proposal-gated edit kinds
  on a finished book (`PROPOSAL_GATED_EDIT_KINDS`): a propose_edit's `assistantMessage` is written
  as a *confirmation* of the edit, so a demoted one replied "I'll rewrite the final page…" with no
  Apply card and no question — a dead end escaped only by insisting. The card is the confirmation,
  so a hesitant or pageless edit flows to `proposeBookEdit` (which resolves quoted targets or asks
  the one real "which page?" question), and `forcedDecision` widens a still-pageless edit to
  `all_pages` once the budget is spent rather than letting that question fire a second time.
  Every `clarify` records `clarification: "scope"` even when the model reports `"none"`
  (`intentFromDecideAction`), because that is what makes `handleProjectChatIntent` store the
  resumable `pendingEdit`; "fixing" that tautology strands the next turn with a bare fragment.
  `bookEditIntent.ts` splits into `bookEditMessage.ts` (reading a message: pages, quotes, scope,
  languages — a leaf), `bookEditHeuristics.ts` (the model-free classifier) and
  `bookEditRouterPrompt.ts` (the action list, the decide schema and the prose — everything the
  model is *told*, as opposed to how its answer is read), which is why those import types back
  from it but never values.
- **The chat speaks the printed page numbers, and the model indexes never reach the reader.**
  A reader saying "page 10" means the number on the PDF page in front of them — the pdfrx
  indicator, the printed footer and the Contents column all count physical PDF pages — while every
  internal target is a model `Page.index`. The translation is `Project.pdfPageMap`: measured at
  publish time from the rendered bytes by both publishers, stamped with the revision they claimed,
  and read through `bookPageMapForProject` (`apps/api/src/bookPageNumbering.ts`), which refuses a
  map from any other revision. On the way in, `pageIndexesFromMessage` and friends resolve spoken
  numbers through the map — an edit target landing on furniture (cover, Contents, Sources) resolves
  to **nothing** rather than to whichever model page shares the number, while read/placement
  targets take the nearest page of prose — and the router model is given each page's `readerPages`
  plus the furniture ranges and told to return model indexes. **Told, and then checked**: a
  decision whose page channels name exactly the printed numbers the message speaks is the
  signature of a model that copied instead of translating, so `modelPagesForCopiedPrintedPages`
  re-reads them through the map before `intentFromProposeEdit` builds the intent — the same
  refusal to trust the model that `withDeterministicContentTarget` already makes for
  `show_content`. It stays deliberately narrow: a translated index (one the message never
  mentions), a printed number that holds no prose, and a request that names its page only in
  another script ("در صفحه ۵") all keep the router's own answer. On the way out, every proposal card,
  queued reply and operation card renders through a `ReaderPageNumbering`
  (`mobile/bookEditCopy.ts`, `mobile/editOperationCopy.ts`), and the DTOs carry a separate
  `readerPageNumbers` array — `affectedPageIndexes` stay model indexes on purpose, because the
  Edit-Mode deep links and the worker payloads navigate by them. A selection composed in the
  reader sends its resolved model page as structured `readerContext` (authoritative over parsing
  its own text, whose visible number is now the PDF page). **No map means the old behaviour
  exactly**: books compiled before the map, or whose measurement failed, keep model-index parsing
  and copy byte for byte, which is also the graceful path for every test and every legacy
  transcript.
- **Moving and removing a picture are free, and neither is a page edit.** `move_image` and
  `remove_image` are their own intent kinds and their own `BookEditOperationKind`s, priced at 0 in
  `bookEditCreditCost` and applied by `apply-book-edit`'s layout fork
  (`apps/worker/src/handlers/applyImageLayout.ts`) with no generation at all. Routing them as page
  rewrites is the expensive mistake this exists to stop — the router prompt says so in as many
  words, and the plan stage demotes both to `answer` because a book with no pages has no pictures.
  **Positioning inside a page is markdown-only, and that is forced rather than chosen**:
  `compileBookMarkdown` prints a page's `ImageAsset` hero above the prose *always*, and a
  chat-added picture has no `ImageAsset` row at all — `applyImageInsertion` writes a file and a
  markdown line and nothing else. So "below the text" demotes a hero to an inline line and clears
  `Page.imagePrompt`, "to the top" of a hero is already true and reports itself as such, and an
  inline line just moves within its own page's markdown — landing *after* a leading ATX heading,
  never before it, because `sanitizePageMarkdown` only strips that heading while it is still line
  one. There is no way to promote an inline picture into a hero, because there is no row to
  promote.
**The card's count is the confirmation, so Apply may not widen it.** The proposal resolves the
whole set through `listReplaceableBookImages` and pins it as `imageLayout.targets`; Apply
re-resolves *those* one by one and never re-runs the scope query, so a picture added between the
card and the tap is not swept into an edit the reader never saw. A layout edit that finds
nothing writes `classifier.layoutMissing` with a reason: the worker cannot write a chat message,
so `layoutSkipSummary` in `mobile/projectSerializers.ts` is where the queued reply's promise gets
corrected, and `operationCanUndo` refuses those rows — they have no snapshots, so
`undoLastBookEdit`'s `snapshots.length > 0` filter would skip them and revert the *previous*
edit instead.

## Export repair and the quality verdict

- **The mobile export routes never render.** A missing `book.pdf` used to be compiled inside the
  Fastify handler — an unbounded Chromium render, with no dedupe, on a route the app hits from the
  reader, the saved-export card and the actions menu. It is reachable in the window a user edit
  opens (`invalidateCompiledProjectExports` deletes the files, `queueUserEditExportRecompile` queues
  the rebuild a moment later). `mobile/routes/exports.ts` now queues that compile and answers 404
  `EXPORT_NOT_READY`. **Watching the status queues it too, and that is the path that matters**: every
  download surface gates on `export.available` — the card's button is disabled and reads "Preparing
  PDF", the reader shows "still being written", the actions menu the same — so a book whose exports
  never came back is never able to *reach* the download route, and the repair there would sit
  unreachable behind the very condition it exists to fix. Both status surfaces call it when the
  **PDF** is missing, and the *stream* is the one the app uses: `projectStatusProvider` subscribes to
  `GET …/status/events` and falls back to polling `GET …/status` only when the stream ends while the
  book is still live. A settled book yields one event and the client returns, so a hook that lived
  only on the poll route never ran for the case it was written for — and the saved-export card's
  four-second refresh invalidates the provider, which re-subscribes to the stream rather than
  polling. The stream re-reads the project row at that moment (`ensureExportRepairQueuedFor`) because
  a connection opened during generation was opened against a status, plan and revision that have
  since moved. **Both formats use a bounded retry budget.** The EPUB was once left out on the grounds
  that its own download route repaired it on demand; it cannot, because the button that reaches that
  route is disabled for exactly as long as the file is missing, so an EPUB-only outage was
  unrecoverable until some unrelated edit bumped the revision. Both formats use a coarse five-minute
  window, with EPUB retaining a format-specific `repair-epub-{revision}-{window}` key so it can get
  a dedicated attempt after a PDF repair completes without producing one. That keeps a burst of
  status reads to one repair while ensuring a transient conversion failure does not permanently
  spend the manuscript revision's key. The hook belongs on that per-project
  route and not in `serializeExportSet`, which the project *list* shares; from there one poll would
  queue a compile per listed book. The file is **read before the unlock is spent**, and the bytes it hands back are
  the ones already in memory — `stat`, charge, then read left a window where that same edit could
  delete the file mid-charge and answer 404 with the reader's credits gone. The entitlement is per
  project and idempotent, so nothing was double-charged and a retry did deliver, but the first unlock
  still settled against nothing. What it queues is a **repair**, and it must
  not borrow the edit recompile's `…:content-{rev}` dedupe key: `enqueueGenerationJob` returns any
  existing row for a key and only re-dispatches one still QUEUED, so the moment that row goes
  COMPLETED or FAILED the key is spent and every later repair for that revision enqueues *nothing*.
  An edit deletes the exports *before* queueing its recompile, so a recompile that failed would
  otherwise leave a book with no files, a terminal key, and an app polling "preparing" forever.
  `exportRepairDedupeKey` carries a coarse five-minute window instead — enough to collapse a burst
  from the reader, the card and the actions menu through the unique index, and to stop a permanently
  failing compile turning a four-second poll into a job per poll. Collapsing with a compile that is
  genuinely in flight is done by reading the job's **state** (`QUEUED`/`ACTIVE`), which holds
  whatever key that compile used — and that read runs in the **same Serializable transaction as the
  insert**, because the unique index cannot collapse the two formats against each other. Their keys
  differ by design, so a status read finding the PDF missing and an EPUB download landing in the same
  millisecond both saw nothing pending and both queued a whole compile of one manuscript: two
  Chromium renders holding both of the browser pool's slots, and two reader-chapter calls, to rebuild
  one file. Serializable refuses the loser's insert, which lands in the same catch as any other
  failure — the caller was answering "not ready" regardless, and by its next poll the winner's job is
  the pending one everyone stands down for. Only these transactions run serializable, so nothing the
  worker is doing to those rows can be aborted by one. **The pending compile is half the decision;
  the file is the other half, and it is re-read inside that same transaction, after the job read.**
  Every caller arrives having already observed a missing file — the download route read it, both
  status surfaces stat it through `serializeExportSet` — and a compile that finishes in between is
  invisible to the job read, so the repair ordered a whole second compile of a book that already had
  its file. The two together have no gap only in that order: a publication renames the artifact into
  place strictly before the row that made it stops being QUEUED/ACTIVE (`publishCompiledExports`
  renames inside its own transaction; the worker marks COMPLETED after the handler returns), so a
  compile still working is caught by the read and one that finished is caught by the stat. Presence
  is the whole predicate — the same one every download surface calls availability — and the
  provenance record beside the file is deliberately neither read nor written here: `unknown` is an
  old file that downloads fine, and `mismatch` means a publication is landing under the read, which
  is the last moment to start a compile. Nothing in the decision takes the project row lock, so it
  can neither deadlock with a publication nor queue a polled request behind one. The repair payload also carries
  `DETACHED_FROM_PROJECT_LIFECYCLE`, and that flag is load-bearing: `compile-export` is two different
  jobs wearing one name. The compile at the end of generation owns the book's outcome and must fail
  it; a compile queued later to rebuild a missing file owns nothing. Without the flag the second kind
  took the first kind's path — `markFailed` flips a COMPLETE project to FAILED, and
  `refundFailedProjectCredits` walks the payload's `planId` to the book's own `GENERATE_BOOK` charge
  and refunds it, so it is not even the vague "latest FULL_BOOK_GENERATION" fallback. `compile-export`
  has no BullMQ retry, so one watchdog timeout on a repair was enough to mark a delivered, paid book
  failed and give the credits back. The flag is checked per *job* rather than per job name for
  exactly that reason; `DERIVATIVE_GENERATION_JOBS` is the wrong granularity here.
  **Two places settle a stopped run's charge, and both have to ask.** The worker's is
  `jobOwnsProjectLifecycle` in `runtime/jobLifecycle.ts`; the API has a whole parallel
  implementation in `stopProjectGenerationJobs` (`apps/api/src/queue.ts`), which every stop and
  *both* delete routes go through. There a repair falls into `settleLegacyStoppedJobs`'s
  attempt-less bucket, `BOOK_RUN_JOB_TYPES` contains `COMPILE_EXPORT`, and the payload's `planId`
  leads to the same `GENERATE_BOOK` charge — so deleting a finished book whose PDF had gone missing
  refunded the purchase, because the status poll had queued a repair a moment earlier. The filter
  that builds `legacyJobs` excludes detached rows for that reason; they are stopped like anything
  else, they just settle nothing. **The charge is only half of what a stop must not touch**: the
  same function's project write was unconditional, so stopping a repair marked the finished book
  FAILED — terminal, because `ensureExportRepairQueued` only queues for COMPLETE and
  REVIEW_REQUIRED and `canRecoverGenerationJob` refuses detached rows, so neither the self-repair
  lane nor either resume route could move it back. It is guarded on the *status* rather than on
  what was stopped (`SETTLED_PROJECT_STATUSES`), because a book reaches those two only by being
  finished while real in-flight work is GENERATING or EDITING — so an unstarted edit or a narration
  stopped on a finished book leaves it finished too, and nothing that should fail a run stopped
  failing it. The operator console draws Stop for any QUEUED or ACTIVE job, which a repair is.
  **Not failing the project is not the same as not being reported as its failure**, and the reading
  side has to ask too. A FAILED repair row is still a FAILED row, so it reached `failureMessage` in
  `mobile/projectSerializers.ts` — the app's `hasFailure`, which is `BookStage.needsAttention` — and
  painted `generationProgress`'s finish step red on a COMPLETE book, permanently and with nothing the
  reader could do. Worse, `canRecoverGenerationJob` accepted it, so `/resume` (either route) would
  requeue it *and set the project GENERATING*, which the flag then stops anything moving back out of.
  `canRecoverGenerationJob` now lives once, in `mobile/generationRecovery.ts`: `routes/projects.ts`
  and `projectStatus.ts` each carried a copy, which is both how a guard like this ends up on one
  path only and how `retryAvailable` can promise a retry that would queue nothing — the status read
  and the resume write have to give the same answer about the same row.
  For operations: a repair that *fails* does block the next one, but only for the rest of its window
  — the window is wall-clock aligned rather than measured from the attempt, so the wait is anywhere
  from a moment to five minutes and never longer. That expiry is the whole difference from the
  content-revision key it replaced, which went terminal and stayed there. The symptom to look for is
  a `GenerationJob` whose `dedupeKey` contains `repair-` sitting FAILED while the project's exports
  are missing; it re-attempts on its own. Note the app gives up watching first: its budget is two
  minutes against a window of up to five, so a book can stop saying "preparing" before the next
  repair is even queued. The two numbers are deliberately unmatched — the watch bounds pointless
  polling, the window bounds pointless compiles, and a repair that keeps failing is a broken book
  that polling faster would not fix.
**Staying silent about the status is only half of it; the report still has to be ignored on the
way out.** A repair writes its own `qualityReport` — deterministic checks alone, since
`skipFinalReview` asks no model anything — and both readers took the newest compile that had one,
so rebuilding a missing PDF erased every chapter-coherence and final-QA warning the book had
earned, along with the `affectedPageIndexes` the quality card's "Fix page N" button is built from.
Nothing brought them back: the next repair erased them again. **Who owns the verdict is a column,
not a scan.** `GenerationJob.ownsQualityVerdict` is written from type + payload where the row is
born — `jobOwnsQualityVerdict` in `packages/core/src/jobScope.ts`, applied in
`enqueueGenerationJob` and `enqueueWorkerJob` beside the `contentRevision` those two already
promote — and `loadProjectQualityReport` (`apps/api/src/mobile/qualityVerdict.ts`) is the one rule
both `projectStatus.ts` and `mobile/projectSerializers.ts` read through: newest owning compile
that *has* reported. That last clause closes the detail serializer's older habit of showing
"pending" for as long as any compile was in flight — the column is set at creation, so a queued
or running compile owns a verdict it has not written and must not blank the card.
It is a column because the two exclusions are payload flags and negating a JSON-path predicate in
SQL drops every row whose payload lacks the key — which is all of them but the flagged ones. So
both readers used to filter in JS over whatever window they held (eight compiles in the detail
serializer, twenty-five jobs *of any type* in the status builder), and job churn — a repair every
five minutes, an audiobook, a burst of image retries — pushed the owning compile out of reach.
The verdict then did not degrade, it vanished, because `normalizeProjectQuality` reads nothing as
`pending`. **The second non-owner is a presentation-only recompile**
(`PRESENTATION_ONLY_RECOMPILE`, set only by `applyPresentationPreference`): the Sources list and
the chapter-heading style change how the book is printed, not one character of `Page.markdown`, so
their deterministic-only report is a *worse* statement about the same manuscript rather than a
newer one. `skipFinalReview` cannot make that call — an edit's own recompile sets it too, and a
manual edit, an undo or `applyBookEdit` really did rewrite prose, so those keep the verdict on
purpose: findings about text the reader just replaced may not outlive it, and nothing runs full QA
on a finished book again. Migration `000040_quality_verdict_owner` backfills the column from the
payloads already stored; presentation reprints predate their flag and stay owners, so no
historical row changes meaning. The one issue that survives all this is `EPUB_EXPORT_FAILED`, and it must:
it describes a *file*, the repair that rebuilds it is exactly the detached compile nobody is
listening to, and a book whose EPUB is now on disk may not keep saying the export failed. So
`qualityWithExportsOnDisk` drops it against `serializeExportSet`'s availability — disk beats a
historical job row — and nothing else, because every other issue is about prose no later compile
of the same manuscript can have fixed.

## Free presentation edits

- **The Sources list at the end of a book is not page text.** `compileBookMarkdown` builds it from
  the project's `ResearchSource` rows on every export, so no page edit can remove it — routed as
  one it charges for rewriting pages that never held it and then recompiles the section straight
  back. "Remove the sources" is a `back_matter` intent instead
  (`apps/api/src/bookEditBackMatter.ts` recognises it, the router has a matching `back_matter`
  edit target): free, it sets `mediaSettings.includeSources` on the project and queues the same
  recompile undo uses. Read that flag with `includeSourcesPreference` from the **project row**,
  never from a plan version's `inputSnapshot`, or toggling it would need a replan to take effect.
  **The chat may only offer what the compile will print**, which is not the same as "the project has
  research": `formatResearchCitation` drops every row without a URL, so a book holding only
  URL-less grounding summaries has no list to remove and none that turning the flag on could make
  appear — it used to answer "Done, the sources list is back", bump `contentRevision` and recompile
  an identical book. `hasReaderFacingSources` is the compiler's own citation builder asked as a
  question, which is what keeps the two from drifting.
- **Chapter headings are not page text either, and the word "Chapter" is stored nowhere.**
  `formatChapterHeading` (`packages/core/src/generation/markdown.ts`) synthesizes `Chapter N: Title`
  at export time from a label table, and its sibling `cleanChapterTitle` *strips* that prefix back
  off a stored title so it cannot be doubled — so the word is in no `Page.markdown` and not even in
  `Chapter.title`. "Don't say Chapter, just the title" is a `chapter_heading` intent
  (`apps/api/src/bookEditChapterHeading.ts`, matching router edit target): free, it sets
  `mediaSettings.chapterHeadingStyle`/`chapterHeadingLabel` and queues the same recompile. Both
  recognisers return **before** `normalizeIntentForStage`, which is load-bearing — `forcedDecision`
  turns any unresolved request into a whole-book `page_rewrite`, and that is what once quoted 960
  credits to rewrite twelve pages that would have recompiled the identical heading.
  `applyPresentationPreference` (`apps/api/src/mobile/presentationEdits.ts`) is the shared mechanism
  for both: one `mediaSettings` field plus a recompile, no `BookEditOperation`, no ledger entry.
- **A verified exact replacement is free, and the verification is what makes it safe.**
  `locallyPatchedPage` was always model-free, but the choice between it and a two-model-call page
  rewrite was made per page *at apply time* and never reached pricing, so a `local_patch` was billed
  `25 + 10/page` either way. `planExactReplacement` (`apps/api/src/mobile/exactReplacementPreview.ts`)
  now computes the result up front: pages that do not contain the text are dropped from the
  operation, the real before/after lines ride on `editProposal.preview`, and the quote is 0. The job
  then carries `mode: "exact"`, which forbids the model fallback — a page that stopped matching is
  skipped, never rewritten, because nothing was charged for rewriting it. Matching goes through
  `hasExactMatch` in `packages/core/src/generation/exactReplacement.ts`, never `String.includes`:
  candidate pages are selected case-insensitively in SQL, so a literal check disagreed with the
  search that chose them. When the literal text appears on no page, the replacement falls back to
  `preserveCase` rather than to a rewrite ("replace rabbit with fly" about a book that writes
  "Rabbit").

## Characters

- **A per-book character list is a copy, and it says which library character it is a copy of.**
  `VoiceCharacter` rows (the "Talk to characters" cast, the only per-book character list the app
  has) are built one-for-one from `plan.characters`, so a saved character reached the sheet as a
  same-named twin with a planner-written description and an avatar re-drawn from that description.
  `VoiceCharacter.libraryCharacterId` is that link — resolved through `matchLibraryCharacter` at
  extraction, deliberately **not** a foreign key, because a book outlives the library row it was
  made from. `loadVoiceCast` is also scoped to the approved plan version: the "do we have a cast
  already" guard counts by `planVersionId` while the read did not, so a continuation or replan
  appended a second cast and listed the same character twice. Do **not** delete superseded
  `VoiceCharacter` rows to fix that — `VoiceCall` and `VoiceCallEvent` cascade from them, so it
  would erase paid call history and the transcripts `voiceCallHistory.ts` reads back as memory.
- **`photoPath` is not a reference; `portraitPath` is, and the upload decides which one an image
  becomes.** The snapshot writes `portraitFile` on `portraitStatus === "READY"` alone, so a photo
  that never became a portrait reached no book at all — the app showed the reader their own face on
  every character surface while the book invented one. `PUT /:id/photo` now makes one bounded, free
  vision call (`characterPhotoVision.ts` in core, `readCharacterPhoto` in `mobile/`) that answers
  two things at once: a `suggestedDescription`, and whether the upload is a photograph or already an
  illustration. An illustration is **adopted** — the same optimized bytes written a second time
  under the portrait name, `portraitSource: ADOPTED_UPLOAD`, no job, no ledger entry — so the
  reader's own artwork is the character verbatim, with no redraw to drift through. A photograph is
  not, and the ask is the existing priced portrait button: `canAdoptCharacterPhoto` demands a
  confident **single-subject** illustration and reads `"unknown"` as a photograph, because a
  mis-adopted face becomes the authoritative design source for every page render with no model in
  the loop, while a mis-classified drawing costs one redraw. The verdict is stored rather than
  recomputed (`photoKind`), and `serializeLibraryCharacter.usedInBooks` is *literally* the snapshot
  writer's condition, so no surface can promise a look the build will not carry. The suggestion is
  offered and never applied — it is screened through `assessCurrentContentRestrictions` like any
  user text, since a photo's visible text reaches the model, and it is dropped rather than failing
  the upload. Every failure here (no vision key, a refusal, a timeout) stores the photo and answers
  200; `CHARACTER_PHOTO_VISION_BUDGET_MS` is not optional, because the Gemini client sets no request
  timeout and Fastify sets none either. Deleting the photo takes an **adopted** reference with it
  (it is the same image) and leaves a `GENERATED` one (a derived work that was paid for), and an
  upload never lands on a READY generated portrait or on a row an open portrait job owns —
  silently, because an upload is not a portrait request.
- **A mentioned character's sheet rides the stored edit request, never the routed text.** In the
  finished-book chat the sheets become `characterContext`, carried on `PendingEditState` (so a
  clarify → confirm → Apply chain keeps it) and appended only where the request reaches a model:
  the `APPLY_BOOK_EDIT`/`CONTINUE_BOOK`/`REPLAN_BOOK` payloads and the plan-revision message
  (`requestWithCharacterContext` in `editOperations.ts`). The bare message is what
  `classifyProjectChatMessage`, `affectedPagesForIntent` and `exactReplacementFromMessage` read —
  a sheet inside it would move page targeting — and the visible transcript and proposal card stay
  as typed. In the creation chat mentions are message-level `{id, name}` refs, so
  `activeThreadPayload` branch-filters them for free, and every turn re-reads the live rows so a
  library edit propagates; the build snapshot is the moment that stops.

## Voice and audiobook routes

- **A voice call's audio never reaches the server.** The app opens its own socket to Gemini with
  an ephemeral token the API mints, so the only transcript we have is the one the app uploads —
  in batches, on the heartbeat it is already sending, because the captions on screen are a capped
  display buffer and a call that dies with the app never sends an end. It lands in
  `VoiceCall.transcript`, and `apps/api/src/mobile/voiceCallHistory.ts` reads the last calls back
  into the next one's system instructions. That is *memory, not resumption*: every call is a fresh
  session, and the prompt says so in as many words. Uploads are at-least-once, so the append drops
  the overlap when a retried batch arrives twice.
- **Restarting a failed narration resumes it; that is a property of the route, not the worker.** The
  worker has always skipped READY chapters, but `POST /api/mobile/projects/:id/audiobook` used to
  delete and recreate the `Audiobook` row every time, so the skip never had anything to skip. It now
  reuses a FAILED row when the voice and `contentRevision` still match — any other change is a
  different audiobook and starts clean. The dedupe key names the run being resumed, because reusing
  the audiobook id alone would match the failed job's row and enqueue nothing at all.
