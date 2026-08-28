# Worker

Consumes the `book-maker` BullMQ queue. All book generation happens here; the API never generates.

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

The full cross-workspace footprint is about fourteen files — the four lists above are only the
worker's share. Use the `add-job-type` skill, which walks the rest.

## Layers

`handlers/` may import from `generation/`, `providers/`, and `runtime/`. Nothing imports back into
`handlers/`. If two handlers need the same logic it belongs in `generation/`.

`runtime/queue.ts` opens a Redis connection at import time. Only `index.ts` and `runtime/dispatch.ts`
import it. Keeping handlers off it is what lets them be imported in tests without a broker.

## Providers

Handlers never construct adapters. `createLoggedProviders(job, providers, input)` in
`providers/loggedAdapters.ts` wraps a job's provider set so every call is:

- appended to the run log at `<BOOK_STORAGE_DIR>/<projectId>/runs/<run>-<job>.jsonl`
- costed into `ProviderCallLog` (opened "live" when streaming starts, settled on completion)
- checked for a user stop request, which raises `StopRequestedError`
- retried on recoverable network errors, and for images, failed over to the other provider
- for images both providers refused *by name*, retried once from a prompt describing an original
  character instead — see below

If you add a provider call, route it through this wrapper or it will be invisible to both the
cost accounting and the progress UI.

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
also in `runtime/jobLifecycle.ts`.

## Queue state and run logs

- **Generation state lives in the database, not in Redis.** A `GenerationJob` row is written
  first, then pushed to BullMQ; `reconcileUndispatchedWorkerJobs` re-pushes anything that was
  persisted but never reached Redis. Preserve that order or a crash between the two strands a book.
- **Run logs are the debugging artifact.** Every provider call is appended as JSON lines under
  `<BOOK_STORAGE_DIR>/<projectId>/runs/`. Read those before adding new logging.

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
