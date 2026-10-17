# Worker

Consumes the five BullMQ lanes — `book-maker` (long), `book-maker-interactive`,
`book-maker-images`, `book-maker-compile` and `book-maker-background` — with one `Worker` each, in
one process. All book generation happens here; the API never generates.

## Adding a job type

1. Add the value to `enum JobType` in `packages/db/prisma/schema.prisma`, then `pnpm db:generate`.
2. Add a handler in `src/handlers/`, exporting `async function myJob(job: Job)`.
3. Register it in the `switch (job.name)` in `src/processJob.ts`.
4. Add its progress steps to `JOB_STEP_TEMPLATES` in `packages/core/src/jobSteps.ts` — the mobile
   app renders those step labels. That table is `Record<GenerationJobType, …>`, so a missing entry
   is a compile error rather than an empty progress list. `src/runtime/jobProgress.ts` only
   translates the kebab job name to the type and reads it.
5. Enqueue it through `enqueueWorkerJob` in `src/runtime/dispatch.ts`, never `queue.add` directly.
   It takes a `type` and derives the BullMQ name itself; add the type to `WORKER_FANOUT_JOB_TYPES`
   there if the worker fans it out.
6. Give it a lane in `JOB_LANES` (`packages/core/src/jobLanes.ts`) — an exhaustive `Record`, so the
   compiler asks. "Is a reader waiting on this with the app open?" picks interactive; minutes of
   bulk work is long, and within long, "does it start a book's work or continue one?". A
   generation's pictures are `image` and its own compile `compile`; a new job that continues a
   book *after* its text belongs with them, never in the long lane (below). Work nobody waits on
   that is not book work either — today only the composition prep — is `background`, and only if
   it is light: that lane runs four at once and its outage is never a readiness failure.

The full cross-workspace footprint is about fourteen files — the four lists above are only the
worker's share. Use the `add-job-type` skill, which walks the rest.

## Layers

`handlers/` may import from `generation/`, `providers/`, and `runtime/`. Nothing imports back into
`handlers/`. If two handlers need the same logic it belongs in `generation/`.

`runtime/queue.ts` opens a Redis connection at import time. Only `index.ts` and `runtime/dispatch.ts`
import it. Keeping handlers off it is what lets them be imported in tests without a broker.

## Storage

Durable books, illustrations, narration, uploads and run logs use the private S3 bucket
through `@book-maker/storage`; MinIO implements the same contract locally. Use `objectKey`
for keys and `objectReference` for provider reference images. A missing object is `null`;
access and network failures propagate. Local files are scoped renderer/provider scratch
created with `withTemporaryDirectory` and removed in `finally`.

Publication keeps the existing database revision claim and rollback protocol. Back up live
objects with server-side copies before uploading replacements, and restore backups if
publication fails. Record an attempted PUT before awaiting it because a failed response may
follow a successful upload. Run logs append immutable events through `appendRunLog`; read
them through `readRunLog`, and keep diagnostic failures nonfatal.

## Providers

Handlers never construct adapters. `createLoggedProviders(job, providers, input)` in
`providers/loggedAdapters.ts` wraps a job's provider set so every call is:

- appended to the run log at `books/<projectId>/runs/<run>-<job>.jsonl.events/`
- costed into `ProviderCallLog` (opened "live" when streaming starts, settled on completion), under
  the user the delivery spends for (`runtime/providerSpendUser.ts`, see `apps/api/src/admin/CLAUDE.md`)
- checked for a user stop request, which raises `StopRequestedError`
- retried on recoverable network errors, and for images, failed over to the other provider
- for images both providers refused *by name*, retried once from a prompt describing an original
  character instead — see below
- for text, prefixed with the operator's sexual-content rule while the filter is on
  (`providers/contentSafetyRule.ts`, applied at the top of every `LoggingTextModelAdapter` method,
  before the run log records the request; → apps/api/CLAUDE.md, "Content safety")

If you add a provider call, route it through this wrapper or it will be invisible to both the
cost accounting and the progress UI.

- **A source read's provider calls are logged, costed to its owner, unretried by the SDK, and
  stopped by its lease.** `runtime/sourceProcessing.ts` (the `SourceExtraction` lease loop that
  reads an uploaded source) is not a BullMQ job and built its own providers: the SDK's two hidden
  retries stacked on every request of the summary's own budget (up to fifteen HTTP calls a chunk
  summary), no call had a cost
  row, so the spend breaker never saw a long scanned PDF's OCR and summaries, and nothing stopped one
  (pre-launch review, 2026-10-13). It now builds the text model with `maxRetries: 0`, wraps the set
  with `createLoggedProviders` under a job that names only the owner (`data.userId`: the account's
  run log, and no project or `GenerationJob` id for a cost row's key or a stop poll), runs the read
  under `runWithProviderSpendUserId` (`runtime/providerSpendUser.ts`), writes the cloud OCR's cost
  row itself from Gemini's own counts (a page the local OCR read has none), and aborts the call in
  flight when the lease renewal finds nothing to renew — a source deleted with its draft or account,
  or a lease taken over, is the only stop a source read has. Those rows have no `generationJobId`,
  so the Operations tab counts them with inline spend (`UNBILLED_INLINE`); `purpose` is
  `source-summary` / `source-ocr`.

Text settlement merges exact result usage with usage observed on the same physical request.
Missing counts remain unpriced, with `costStatus: unknown_usage`; a blank-line early stop records
`usageUnavailableReason: whitespace_runaway`. A grounded search that fails writes a failed row too,
`provider_error` with `groundedPrompt: "unknown"` and no allowance claim
(`apps/api/src/admin/CLAUDE.md`). Project summaries preserve that unknown status.
Character-count estimates are diagnostic counts, never a substitute for missing billing usage.

Note that `providers/` holds **no model adapters** — only these logging and accounting wrappers.
The adapters themselves are in `packages/core/src/adapters/`.

- **A refused picture gets one rewritten prompt, and only a refusal about a name may have it.**
  `CopyrightSafeRetryImageAdapter` (`providers/copyrightSafeImageRetry.ts`) wraps the *outside* of
  the provider fallback, so only a request both providers refused reaches it: it asks the job's own
  text model to rewrite the prompt (`rewriteImagePromptForCopyright`, in core beside the other
  prompts) and draws once more from the answer. A reader who wants a book about a character they
  love is asking for something ordinary, and "a young masked hero in a red-and-blue suit who climbs
  walls" is the honest version of it — an original design rather than a laundered one.
  `imageRefusalCategory` is the gate, and it is deliberately hard to satisfy in both directions.
  It requires **positive** evidence — a recitation finish reason, or the words a filter uses when it
  means intellectual property — because a bare `SAFETY` or `PROHIBITED_CONTENT` is what Gemini also
  puts on a character likeness and so proves nothing; and it **vetoes** a child-safety or
  sexual-content block outright, before the evidence is read, whatever else that refusal says.
  **The veto reads the filter's vocabulary, never the scene.** A refusal has two halves and they are
  not the same kind of statement: the `reason` is the provider's own code, machine vocabulary that
  describes the filter and nothing else, so a bare word test over it is safe; the prose beside it is
  mostly the text part Gemini's native image models return *instead* of the picture, and that part
  restates the request back. Testing `/child|minor/` against it therefore matched the scene — and
  since nearly every book here is a children's book, "I can't create an image of Spider-Man teaching
  a child to read" vetoed itself and the whole feature was inert for the case it was built for.
  Silently, too: the gate used to short-circuit past every append below it, so the run log showed a
  refused picture with no trace of a rewrite ever being considered — the one decision that can
  quietly cost a picture was the only one nothing wrote down. **A rewrite the gate refuses to offer
  is now appended as `copyright_rewrite_not_offered` before the rethrow**, so a suppressed rewrite
  sits beside `_declined` and `_failed` rather than being invisible. Only for a refusal: an outage
  never reached the gate as a verdict, `image.generate.error` already has it, and a stop is not a
  verdict about this prompt either. That an inert veto had to be *found* rather than seen is what
  made both the false-veto bugs below expensive. Requiring a
  protected-person word to appear *beside* a harm word was the first answer and it was a false floor,
  because both halves of that pair are ordinary IP English: a filter objecting to a cartoon character
  says the picture would "exploit a copyrighted character", calls the request "commercial
  exploitation of a trademarked children's franchise", or an "abuse of the trademark", and `minor` is
  an adjective ("a minor variation on a copyrighted design") before it is a person. Every one of
  those vetoed itself the same silent way. **The harm word now has to govern the person, not merely
  share a clause with it** — as its object ("exploitation of children", "exploits a child") or with
  the person as its subject ("a minor being abused") — and what may stand in the gap is a closed list
  of prepositions, determiners and modifiers, which is the whole difference between a filter naming a
  victim and a filter naming a rights-holder. The harm words that stand alone (`nudity`, `sexual…`,
  `csam`) stand alone because none of them ever describes an illustration a book asked for, and the
  filter's own compound label ("child safety", `child_sexual_abuse_material`) needs no grammar at
  all. Where the two readings genuinely collide the veto keeps the person, which is why "a minor
  being abused" is a child and "a minor character from the film" is a small part. **And the belt
  that grants `minor` its adjective reading asks a closed question now, because the open one was
  already wrong.** It used to list the singular nouns `minor` could be modifying and demand a word
  boundary right after each, so "a minor variation" was the adjective and "minor variations" was a
  child — every plural of every entry escaping into the veto, on ordinary IP English, suppressing
  the rewrite with nothing but a `copyright_rewrite_not_offered` line that does not say the veto
  is why. It asks instead whether `minor` *heads* its noun phrase, which needs no list of nouns
  and no list of inflections: a head noun is followed by a preposition, a copula, a coordinator, a
  relative pronoun, a mark or nothing, and anything else means a noun is standing behind it. The
  rewrite is narrow for the same reason the gate is: it may only replace protected *names* with a
  description of the same archetype, and is told in as many words not to soften, censor or reword
  anything else — so a prompt objectionable for any other reason comes back objectionable in exactly
  the same way. That is what makes one automatic retry safe rather than an evasion.
  **Exactly one, and it does not recurse.** A rewritten prompt refused again means the objection was
  never about the name, and a third ask would be paying to be told so; the second refusal is what
  the caller gets. **And the retry may never leave the caller worse off than not retrying.** Any
  *other* failure of the second render — the rewritten prompt's primary refusing while its fallback
  times out — hands the *original* refusal back rather than itself, because a refusal both providers
  gave is the one image failure `renderCharacterReferenceSheets` tolerates and anything else is fatal
  to `generate-book`. Unwrapped, that was the rewrite turning a book missing one likeness into a
  FAILED project — the attempt costing what never attempting it would not have.
  `copyright_rewrite_render_failed` is where the render that answered nothing is written down, and a
  stop still travels, since a reader who ended the run must not have it continue into the book.
  A rewrite that cannot be produced — the model failed, or found nothing protected — leaves the
  original refusal standing rather than replacing it with a failure to rewrite it, **and the run log
  says which of the two it was**: `copyright_rewrite_declined` is the model reading the prompt and
  finding no protected name in it, `copyright_rewrite_failed` is a call that was paid for and
  answered nothing. Returning one `undefined` for both hid the only symptom the second has. It hid a
  live one: the rewrite's `maxTokens` was `ceil(chars / 2)`, and the reply has to carry the whole
  prompt *back*, so a Persian, Arabic or CJK prompt — where a character is close to a token of its
  own — was given about half the room its own reply needed, truncated, failed the schema, spent
  `generateJsonWithRetry`'s repair attempt on the same budget and gave up, looking exactly like a
  book that named nothing protected. The budget is script-aware now
  (`rewriteOutputTokenBudget`, in core beside the prompt) and deliberately over-generous in both
  classes, because `maxTokens` is a runaway fuse and nothing is paid for the part of it that goes
  unused. What was drawn is recorded on the asset row as `metadata.copyrightRewrite`, because
  `ImageAsset.prompt` is what the book asked for and that is no longer what is in the picture.
  **And `replaced` is checked against the prompt it claims to have cleaned, because that row is the
  only IP-provenance record this product keeps.** `REWRITE_RULES` already tells the model a removed
  name "must not survive anywhere in your rewrite, including inside a comparison such as … 'in
  Spider-Man style'", which is precisely the kind of rule a model is told and still breaks, and
  nothing else re-read the answer. `{ changed: true, replaced: ["Spider-Man"], prompt: "…, in
  Spider-Man style, …" }` satisfied every other gate — it changed, it is non-empty, it is not the
  original — then bought a second full primary→fallback render of a prompt that still names the
  character, which the filter refuses for the reason it refused the first; where the second provider
  drew it anyway, the row said "Spider-Man removed" over a picture of Spider-Man.
  `rewriteImagePromptForCopyright` resolves that reply to **`failed`**, so nothing is retried with it
  and the caller keeps the refusal it already had. Not `declined`, which would record "this book
  named nothing protected" about a book that did; and not the rewrite with `replaced` corrected,
  which keeps the *record* honest and buys the render anyway. The check sits beside the outcome gate
  rather than at the storage site, because by the time the worker writes the row the second render is
  already paid for. Matching is whole-token on **this module's own** boundary pair
  (`tokenStartsAt`/`tokenEndsAt`), over the character class `libraryMentions.ts` declares —
  script-aware, so a Persian joiner or a Devanagari matra continues a word an ASCII `\b` would end
  mid-name, and a hyphen between two words joins them **from either side**. The mention scanner's own
  pair could not be borrowed whole, because it is asymmetric on purpose: the left end of an `@token`
  is the `@`, so its leading test asks whether the *marker* is buried in a word (`bram@example.com`
  keeps its `@`) and no hyphen can ever precede the name. Read as a leading word boundary it is one
  clause short, and `-` is not a name character — so a removed `Luna` correctly ignored a "Luna-Bear"
  the rewrite kept and then fired on a "Bear-Luna". Welding a word onto the archetype is exactly what
  `REWRITE_RULES` asks the model to invent, so "Bear-Luna", "Neo-Tokyo" and "Spider-Bot" were the
  shape of a rewrite that *worked*, each discarded as a leak with two paid text calls spent.
  **Which spellings count as the same name is a third fold, and it normalises how a character was
  encoded rather than which characters a word has.** `toLowerCase` alone — what this was — reads only
  the case, so a rewrite that merely *re-spelled* the name walked through: a ZWNJ dropped inside
  «Spider‌-Man», the decomposed spelling of "Pokémon" against the composed one in `replaced`, a
  non-breaking hyphen, a curly apostrophe, Arabic «ي»/«ك» where a Persian prompt carries «ی»/«ک»,
  Arabic-Indic digits for ASCII ones. `foldRespelling` folds exactly those — NFC,
  `stripInvisibleMarks`, `foldInterchangeableArabicLetters`, `foldArabicIndicDigits`, and one
  hyphen/apostrophe table that the word-joining test reads too, so a spelling cannot join a compound
  in one rule and miss a needle in the other. `foldCharacterName`'s mark folding is still not
  borrowed, and now for a stated reason rather than a hunch: that fold asks "are these two spellings
  one person's name" of two *names* against a snapshot of at most ten, while this asks "does this
  document still contain this exact name" of a twelve-thousand-character prompt, so every pair it
  merges gets a document's worth of chances to collide. Deleting a mark is what merges: Vietnamese
  tone marks tell six words apart, Arabic and Hebrew children's books are the vocalized ones, and
  alef maksura is a letter of its own — «على» ("on") is not «علی» (Ali) —
  which is why `foldArabicKafYehOntoPersian` is taken in halves and only the half that changes no
  letter is used here. Measured both ways: swapping `foldCharacterName` in turns all four of those
  into false leaks and still misses the hyphens and apostrophes it does not fold. What that leaves is
  a franchise whose name is also an ordinary word
  ("Up", "Cars"), where the veto costs one salvage attempt and leaves the caller exactly where never
  rewriting would have, and a name re-spelled with a mark it does not normally carry ("Spidér-Man"),
  which is not a shape a cooperating model produces; a missed leak costs a paid render and a settled
  provenance record that is false, and only the second is unrecoverable.
- **The rewrite touches the prompt, so the provenance record speaks for the prompt: a retry
  that re-sent the reference sheets claims no removal.** The retry
  rewrites the prompt and carries everything else over — the reference images especially, since the
  sheets are what keep a character looking like itself from one page to the next. On the character
  path those sheets are exactly where a protected likeness lives: a book seeded from a library
  character whose portrait *is* the protected one, or a page whose `CHARACTER_REFERENCE` sheet was
  drawn from it. Both providers refuse, the rewrite strips "Spider-Man" from the text, the retry
  re-sends the same pixels with generic words beside them, and the second provider draws the likeness
  out of the image — under a row saying "Spider-Man removed". `survivingReplacedNames` cannot see it;
  it reads the rewritten text, and this is the half of the render that is not text. So
  `copyrightRewrite.replaced` is claimed **only on a render that was handed no reference images**, and
  a render that was handed some records `unverifiedReferenceImages` instead — the count of inputs
  nothing read. **Handed, which is measured off the render and never off the request.** The retry
  deletes `promptForReferenceImages` (it must: the rewritten prompt is the text model's words, and
  re-stating the caller's would hand the protected name back to the filter), so a rewritten render
  whose primary fails reaches `FallbackImageAdapter.refitForFallback` with no way to state a shorter
  attachment — and an unre-statable trim goes out with **none**. Counting the request there stored
  `replaced: []` beside `unverifiedReferenceImages: 5` over a picture drawn from the rewritten text
  alone, which is exactly the case `survivingReplacedNames` had fully verified: both halves false, in
  opposite directions, in the one record whose rule is that a false one is worse than none. What the
  cut was is on `ImageFallbackMetadata.references`, because the layer that made it is the only layer
  that saw it. The alternative was dropping the sheets on the retry, which buys the claim by changing the
  request a second, unstated way: the retry stops being the one rewritten prompt whose narrowness is
  the argument for making it automatically, a second refusal stops meaning "the objection was never
  about the name", and every page salvaged that way carries a character matching no other page in the
  book. A narrower record is free; a false one is what the invariant forbids. The model's own
  `replaced` list and the sheets it travelled with stay together in
  `image.generate.copyright_rewrite`, which is where anyone reconstructing the claim would go.
- **A replacement replaces the provenance record too, and undo brings the old one back with the old bytes.**
  Every *creating* site spreads `imageGenerationMetadata` and is therefore honest by construction.
  The two writers of a row that already exists were not. `applyAssetReplacementInTx`
  (`handlers/applyImageInsertion.ts`) is the chat's "replace the picture on page 7": same
  `ImageAsset` id, different pixels. It wrote `{ path, prompt }` and left `metadata` alone — so a
  redraw bought through the rewrite recorded nothing, and, worse, a row that already said
  `copyrightRewrite: { replaced: ["Spider-Man"] }` kept saying it over the lighthouse that replaced
  it. `withImageRenderProvenance` (core, beside the prompt) installs this render's provenance and
  **deletes** the previous one, merging onto the row the transaction re-read rather than the copy
  the delivery carried in. Only that half moves: `keeperToken`, `keeperPageId` and
  `legacyGenerationJobId` decide which page illustration this is, and a wholesale overwrite orphans
  the picture. The second writer is Undo (`apps/api/src/mobile/manualEdits.ts`), which restores
  `path` — bytes that were never deleted — so the apply records the outgoing picture's own
  provenance on `classifier.previousAsset.generation` and the revert merges it back. A move or a
  remove records none, because neither redraws. A record that outlives its pixels is the false kind,
  and a false one is worse than none.
- **The library portrait keeps the same record, on a table that had nowhere to put it.**
  `generate-character-portrait` renders through the same wrapped provider stack and stores its bytes
  as a `LibraryCharacterImage`, which had no `metadata` column — so the one drawing that seeds every
  book's character reference sheets was the one whose rewrite left no trace at all. The column is
  nullable and per row, for the reason `photoKind` is per row: the character's own pointer is
  overwritten by the next drawing and would then describe a different picture. Absent means nothing
  was rewritten.

## Stopping and failure

`StopRequestedError` (from `runtime/jobTypes.ts`) means the user stopped the run — it converts to
an `UnrecoverableError` so BullMQ does not retry. Anything else goes through
`shouldRecoverJobAttempt` in `runtime/jobLifecycle.ts`, which wraps the pure policy in
`packages/core/src/jobDispatch.ts`. Failed paid work must refund; see `refundFailedProjectCredits`,
also in `runtime/jobLifecycle.ts`. What a *stopped* run refunds is not decided here: the API's
stop stamps the charge with what was delivered before the book can be deleted, and every
settlement this runtime makes of that charge obeys the stamp (`packages/db/CLAUDE.md`).

- **A job row that is gone was deleted with its book, and counts as stopped.**
  `isStoppedGenerationJob(null)` used to answer false. Nothing deletes a `GenerationJob` but the
  cascade from its project, and both delete routes stop the jobs and delete the project in one
  request, so the stop markers stood on the row for milliseconds and an in-flight run usually next
  looked after the row was gone. It kept drafting and drawing a deleted book until a write hit the
  missing project — provider spend nobody pays for, since the stop had already settled what the
  reader owed. Settlement is unchanged by the answer: `markStopped` and `markFailed` claim no
  missing row, so neither refunds anything, and the API's stop had already settled the attempt.

## Queue state and run logs

- **Generation state lives in the database, not in Redis.** A `GenerationJob` row is written
  first, then pushed to BullMQ; `reconcileUndispatchedWorkerJobs` re-pushes anything that was
  persisted but never reached Redis. Preserve that order or a crash between the two strands a book.
- **Run logs are the debugging artifact.** Every provider call is appended as JSON lines under
  `books/<projectId>/runs/`. Read those before adding new logging.
- **Every job type names its lane, and an enqueue routes by that map on both sides of the queue.**
  One queue at concurrency 1 — production until 2026-10 — put every plan, chat edit, portrait
  and assist behind whatever book was being written, and a composed book is one `generate-book`
  job of 9–93 minutes; five approvals in an ad burst queued the fifth reader's plan edits for
  hours. `JOB_LANES` (`packages/core/src/jobLanes.ts`) gives every `jobNames` entry a lane, and
  `generationJobPlacement(type, payload)` is the only thing that picks a queue: the API's
  `dispatchGenerationJob` and this side's `dispatchWorkerGenerationJob` are the repo's only two
  `queue.add` calls, and both read the durable row's type and payload, so one row cannot land in
  two lanes and BullMQ's job-id dedupe keeps holding. Three types are laned by payload because each
  is two jobs: a compile that ends a generation (full review, expected GENERATING) takes the
  compile lane, every other compile is a reader waiting; a generation's pictures take the image
  lane, a revision's cover or a re-typeset is interactive; and a chat edit is interactive until it rewrites more than
  `LONG_LANE_EDIT_PAGE_THRESHOLD` (40) pages, when it starts long work like a continuation — a
  whole-book rewrite of a 200-page book held one of the two interactive slots for tens of minutes
  while every reader's plan queued behind it (pre-launch review, 2026-10-13). That count is
  `affectedPageIndexes` off the payload the Apply wrote (none for a verified `mode: "exact"`
  replacement, which is code), and nothing rewrites an edit's payload, so every reader of
  placement — both dispatches, readiness's oldest-QUEUED per lane, `waitingInLine`, the
  per-account share and its doors — classifies the row through `jobLaneClass` and answers alike.
  Inside the long lane a start (`GENERATE_BOOK`, `IMPORT_BOOK`, `CONTINUE_BOOK`,
  `GENERATE_AUDIOBOOK`, a whole-book `APPLY_BOOK_EDIT`) carries `LONG_LANE_START_PRIORITY` and everything that
  continues a book carries none, and BullMQ runs every unprioritized job first — so book A's
  compile no longer queues behind books B–E's whole runs, and the reader's "N books ahead"
  (`booksAheadInLongLane`) is the order the lane really runs in. The long lane keeps the name
  `book-maker`, which is what drains a previous release's jobs; the reverse is not true, so a
  rollback past the lanes waits for the queues the older release does not read to empty
  (`docs/deployment.md`, "Job lanes"). Every lookup of a Bull job by id — `prepareDurableJobId`, the API's requeue, stop and
  `isBullJobActive`, the lost-delivery sweep — asks every lane (`clearLaneJobIdForAdd`,
  `removeIdleLaneJobs`, `laneJobForSweep`), because a requeue can put a row in a different lane
  from its last delivery and a lookup of one lane would miss the copy still running in another.
- **Work nobody waits on has a lane of its own, and its outage is an alert, never a readiness
  failure.** The speculative composition prep (`handlers/prepareComposition.ts`) plans a composed
  book its reader has not approved yet: about 90 s of provider calls, unbilled. It is not book work
  (no charge, no place in the per-account share, and the long lane would put it behind whole
  books), and no reader is waiting on it. It first waited in the interactive lane behind every
  reader's job (a BullMQ priority) and at most one per process (a cap in the delivery guard), so a
  burst of plans could not hold both production slots. That ran some 40 preps an hour: in the
  2026-10-16/17 smoke rounds three plans landed within a minute and the third prep never started
  before its book did, while a prep that finished first had the book composing 0 s after approval.
  Raising the interactive lane and scaling the cap was the other way out, and the lane rules refuse
  it: that lane holds the compiles that re-typeset a whole book, so each slot added is another
  possible whole-book compile against the 2 GiB (`docs/deployment.md`, "Job lanes"), and a running
  prep still holds a slot a reader's edit then waits for, because a priority orders only what is
  waiting. So `PREPARE_COMPOSITION` is class `background` in `book-maker-background`
  (`WORKER_BACKGROUND_CONCURRENCY`, four), unprioritized, with the cap and the priority deleted. It
  follows every rule above: placed by `generationJobPlacement` on both sides, looked up across
  every lane, and kept out of `isBookWork`, so neither the share nor "N books ahead" counts it. Four
  at once is about 160 an hour, for under 0.1 GiB, at most eight text calls (stance and inventory
  run together) and a handful of short writes on the ten-connection pool. Only light work belongs
  here — nothing that renders or holds a manuscript, since the lane is sized for provider calls. The
  lane beats like every other and its key is in the compose healthcheck, because that gates a deploy
  and a release whose background `Worker` never starts is broken. But its pair of checks,
  `worker_background` and `queue_background` (a prep waiting over 15 minutes), are
  `ADVISORY_CHECKS` in `apps/api/src/monitoring/readiness.ts`: measured with the rest and alerted on
  through `ALERT_CONDITIONS`, never in `ok` or the public body. While the lane is down every book
  still starts, each planning those steps itself about a minute slower to its first chapter, and
  readiness is binary: a 503 is the uptime monitor reporting the deployment down, the same reason a
  provider account out of credit is an email and not a check (`apps/api/CLAUDE.md`). A prep older
  than ten minutes exits without a call when it is finally taken, so a backlog drains at once, and
  one still waiting at fifteen means nothing consumes the lane.
- **A generation's pictures and its compile leave the long lane together, or the compile waits
  behind the next book's run.** At the long lane's production concurrency of one (until
  2026-10-17), a book's pictures could not start until its text job let go of the lane, then drew
  one at a time at 7–10 s each, and another reader's book waited behind all of it (2026-10-15). So
  `GENERATE_IMAGE` for a generation — its pages and its cover, everything but a revision's cover or
  a re-typeset — is class `image` in `book-maker-images` (`WORKER_IMAGE_CONCURRENCY`, 4 in
  production), and the compile that ends a generation is class `compile` in `book-maker-compile`
  (`WORKER_COMPILE_CONCURRENCY`, 3 in production since 2026-10-17). Moving the pictures alone was
  the trap: the compile is queued by the last picture's fan-in (`maybeEnqueueCompile`), which used to run while that picture still
  held the long lane, so the compile — unprioritized — was the lane's next job. With the pictures
  elsewhere the long lane goes idle while they land, the next book's `generate-book` start takes
  it, and a long-lane compile then waits that whole run, 9–93 minutes, on a book whose every page
  and picture is done. In its own lane it waits only for another generation's compile, and it is
  still the one memory-heavy job. It ran one at a time beside the interactive lane's two until
  thirty books finishing together queued sixteen minutes of compiles there; a compile is mostly
  its defect screen's model call and Chromium renders two books at most however many run, so
  production runs three (`docs/deployment.md`, "Job lanes", for the measurement and the 2 GiB
  arithmetic).
  `GENERATE_PAGE` stays long: a story's pages are drafted one after another anyway, so a lane of
  their own would only start the next book's text beside them. Both classes still *continue* a
  book — `isBookWork` — so the per-account share counts them, while `booksAheadInLongLane` reads
  only the long lane's rows, since neither lane holds anybody's place in it. A deploy needs no
  drain: the new worker still consumes `book-maker`, where the previous release's pictures and
  compiles run one last time; only a rollback past these lanes has to wait for both to empty.
- **A generation's compile is queued only once its book run is closed, and the run's own
  completion is a fan-in like its pictures'.** With pictures drawn from the checkpointed draft in
  a lane of their own and the compile's lane idle, the last picture or the cover could land while
  `generate-book` was still writing its tail — the story-delta pass (removed 2026-10-16), the
  composed pass's brief inventory — and its fan-in queued the compile (review of the 2026-10-15 speed changes). That
  compile found no grouped-review snapshot (`shortPictureBookReviewCache.ts` reads only a COMPLETED
  `generate-book`), paid for `runFinalBookQa` and the chapter review again, read empty
  `requirementTargets`, checked coverage against promises no delta had paid yet, and could publish a
  book the run then failed. `maybeEnqueueCompile` now answers `waiting` while any `GENERATE_BOOK`
  row of the project is QUEUED or ACTIVE — the run's own in-handler call included, so nothing is
  queued while the run can still write — after the cover branch, so a missing cover still starts
  early; and `maybeCompileAfterCompletedJob` fans in for `generate-book` too, after its COMPLETED
  write. The run and every page or picture write COMPLETED before they read, so whichever writes
  second sees both closed (all six interleavings, `dispatchBookRunFanIn.test.ts`). That holds on
  every path: every pass and its `already-complete` branch end in the processor's follow-up; a
  retried run is QUEUED and fans in when it completes; a stalled reclaim shares the row id and the
  COMPLETED-replay branch fans in; a failed or stopped run settles the book instead; a staged
  replan's row is terminalized by its own publication and its tail queues the compile; edits,
  continuations, imports and Studio publishes have no open run. A run row that closes without
  completing (a stale cancel) leaves the compile to `reconcileStrandedGeneration`, which takes a
  GENERATING book once every job is terminal. The price is a text-only book's compile queued
  milliseconds later, and a failed follow-up there logged and swept, as a picture's always was.
- **A row BullMQ reclaims while it still runs here waits for the original; it never runs beside
  it.** A job whose lock was not renewed for `lockDuration` is handed out again while its first
  execution carries on, and `markActive` accepts an ACTIVE row on purpose (a crashed worker's job
  must resume), so nothing below the processor can tell the two apart. At concurrency 1 the copy
  could only start after the original ended, and every handler's redelivery path is written for
  that order: a COMPLETED row replays its tail, a settled attempt is refused at the stale check.
  Run side by side, the credits survive — an attempt is never demoted from SUCCEEDED and a charge
  has one reversal (`packages/db/CLAUDE.md`), and an import's completion is a compare-and-set one
  copy loses — but the work does not: two `generate-book` runs draft the same chapters and pages
  and both buy every provider call, the later write winning page by page, and two narrations pass
  the READY skip together and pay for every chapter twice. So with four lanes and several of them
  wider than one in one process, `deliveryGuard.ts` keys running deliveries by the durable row id
  (shared by every lane, so a copy in another queue is held too) and moves a second delivery to
  `delayed` with `DelayedError` — no failure, no attempt spent — until the original is gone. It
  defers rather than refuses because the original has lost its Bull lock and cannot finish its
  own Bull job; the deferred copy is what settles it, through the replay paths above, exactly as
  a reclaimed job did at concurrency 1. A BullMQ retry or a later redelivery is never held: the
  guard is released in `finally`. The lock itself is 2 minutes (`LANE_LOCK_DURATION_MS`), four
  times BullMQ's default, which reclaimed a job after as little as 15 s without a renewal (a Redis
  restart; no job path does synchronous I/O, so a blocked event loop is not the expected cause).
  The guard is one process's: a second worker process still needs a lock lost the same way, and
  the handlers' own fences (delivery tokens, revision claims, the attempt state machine) answer it
  as before.
- **A job is reclaimed up to five times, and the sixth stall is settled the moment BullMQ makes
  it.** `maxStalledCount` was BullMQ's default of one, and BullMQ's stall counter only rises, so the
  *second* reclaim in a job's life failed it: two deploys (each stops the worker after a
  five-minute drain) or a deploy and an OOM kill inside one 60–90 minute book. That failure never
  calls the processor, so nothing settled the row until the lost-delivery sweep did, two hours
  later, while the book read "generating" (pre-launch review, 2026-10-13). `LANE_MAX_STALLED_COUNT`
  is 5 on every lane (`runtime/laneWorkers.ts`). A reclaim is a resume, and has been since the
  first one was allowed — `markActive` takes an ACTIVE row back, a composed book restarts at its
  first unwritten chapter, a COMPLETED row replays its tail, a copy beside the original waits for it
  (above) — so each costs at most what it interrupted, and the bound stays for a job that kills its
  worker every time. Past it BullMQ 5 marks the job (`defa`) and the next worker to fetch it fails
  it unrecoverably *before* the processor, so that worker's `failed` event is the only trace, and
  `startLaneWorkers` listens to it: `settleStalledOutDelivery` (`runtime/lostDeliveries.ts`) fails
  the row through `markFailed` behind the sweep's own claim on the row as read — unless the delivery
  guard says the original still runs here (it settles itself), the row names another Bull job (a
  requeue), or the row was written within half a lock (`STALLED_OUT_QUIET_MS`: a dead holder's lock
  outlives it by at least that, so only a live holder in a second process is that fresh, and it is
  left to the sweep). `close()` waits for a settlement in flight. That handler reads the job it was
  handed, never a finished one back, so the rule below holds. The sweep stays for jobs Redis lost,
  and reads its open rows as a lap — a `(updatedAt, id)` keyset a page per sweep, starting over after
  a short page — because a row legitimately waiting is never written, and twenty of them used to
  keep the oldest-twenty page to themselves while a lost job sat behind them.
- **A finished Bull job is not a record, so retention may remove it and nothing may read one
  back.** Nothing removed finished jobs, and production Redis is `maxmemory 256mb` with
  `noeviction`: it would have refused every enqueue and lock renewal one day.
  `GENERATION_JOB_RETENTION` keeps completed jobs a day (≤1,000 a lane) and failed ones a week
  (≤2,000), on each job's options and on both Workers so an older release's jobs are trimmed too.
  It is safe because the row is the record and dedupe is the row's: `dedupeKey` and the
  QUEUED-without-`bullJobId` claim decide whether work exists, `prepareDurableJobId` removes a
  finished copy before re-adding anyway (an add over a finished id in its own lane is a silent
  no-op), the lost-delivery sweep reads `missing` exactly as `failed`, and a completed Bull job
  always sits under a terminal row that sweep never selects. A late add after the first delivery
  left Redis was always possible and is refused by `markActive` on the COMPLETED row. A new reader
  of `returnvalue`, `failedReason` or a finished job's existence has to read the row instead.

## Liveness

- **A worker lane is alive exactly while its heartbeat key is, and the beat comes from the event
  loop it vouches for.** A dead worker, a wedged one and a stuck queue were all invisible until a
  reader complained (pre-launch review, 2026-10). `runtime/workerHeartbeat.ts` writes
  `book-maker:worker-heartbeat:<queue>` (`workerHeartbeat.ts` in core) every 30 s with a 90 s TTL,
  for each lane whose BullMQ `Worker` still `isRunning()`, carrying the pid, host, process start,
  running jobs and concurrency for the alert email; the API's `/api/ready` and alert sweep read it
  (`apps/api/CLAUDE.md`), and so does the compose healthcheck, which also requires the beat to be
  its own container's (`scripts/worker-healthcheck.sh`, `scripts/CLAUDE.md`). Nothing has to notice
  a death: the key stops existing. BullMQ's own consumer list — what the compose healthcheck asked
  until 2026-10 — cannot replace it, because a process whose
  event loop is wedged keeps its Redis connection and so stays listed; the beat is a timer on that
  same loop, so a wedged process stops vouching for itself as surely as a dead one. One dead lane in
  a live process stops alone. The keys are never deleted: a restart back inside 90 s is not an
  outage, and the heartbeat stops only after `laneWorkers.close()`, so a worker draining its last
  job still says it is alive. Keyed by queue, not process: two worker processes on a lane answer
  "does it have a live consumer" together. A beat waiting on a reconnecting Redis is not doubled,
  and a failing write is logged once per streak. It takes the Redis client as an argument, because
  importing `runtime/queue.ts` opens a connection and only the entry point may. A new lane needs its
  own pair of checks in `apps/api/src/monitoring/readiness.ts` (`worker_<lane>` and
  `queue_<lane>`, with a wait threshold), filed in `READINESS_CHECKS` or, for a lane whose work is
  optional, `ADVISORY_CHECKS` (the test pins that every lane is in exactly one); an alert condition
  in `alertConditions.ts`; and its key in `scripts/worker-healthcheck.sh`, whose test pins the list
  to `GENERATION_JOB_QUEUES`, advisory or not.

## Where the rest of the invariants live

The worker owns a book's outcome, so several of the rules it must respect are enforced by code in
other packages. Read these before changing anything that compiles, publishes, or settles:

- `src/generation/CLAUDE.md` — a compile publishes by *claiming* the revision it compiled; the
  reader-chapter cache and when a compile may not make a model call; character reference sheets.
- `src/handlers/CLAUDE.md` — per-job rules: cover fallback, the project-less portrait job,
  audiobook failure semantics, narration chaptering and timings.
- `packages/core/src/generation/CLAUDE.md` — the browser pool. `index.ts` must trap **SIGHUP**
  alongside INT/TERM and its `shutdown()` must await `closeSharedBrowser()`, or a hangup leaves a
  Chromium reparented to init and reaped by nobody. Budget two pooled browsers in production, one
  per process.
- `packages/db/CLAUDE.md` — failed paid work must refund on **every** path, including the ones
  that are not a thrown error.
- `apps/api/src/mobile/CLAUDE.md` — `apps/api/src/queue.ts` `stopProjectGenerationJobs` is a whole
  parallel implementation of the settlement logic in `runtime/jobLifecycle.ts`. A change to how a
  stopped or detached job settles has to be made in both, or a stop and a worker failure will
  disagree about the same row.
