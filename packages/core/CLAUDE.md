# Core

Provider adapters, prompts, generation algorithms, schemas. This is the leaf of the dependency
domain graph: `apps/* → packages/db → packages/core`. Durable I/O uses the independent
`@book-maker/storage` package; read [storage.md](../../docs/storage.md) when changing storage or render inputs.
Core must not import from `apps/*` or from
`packages/db`, and nothing in it may open an HTTP server or touch the queue.

Relative imports carry the `.js` extension (`./foo.js`) even from `.ts`. Consumers import the bare
specifier `@book-maker/core`, and the barrel is the default — add to `src/index.ts` rather than
reaching past it.

**A module kept light enough to survive a mock has to be light in both directions.**
The `exports` map has five narrow entries beside `.`, and each one is a module a consumer must be
able to take without the barrel. `./libraryMentions` is imported by
`packages/db/src/libraryMentions.ts` and by nothing else. That db module is itself a subpath so it
survives a wholesale `vi.mock("@book-maker/db")`; taking the strip helpers off this barrel quietly
handed it a *second* mock surface, because a suite that mocks core with a bare factory replaces the
whole barrel — adapters, prompts, PDF — and `generationDescription` then throws
`stripBoundLibraryMentionMarkers is not a function`. What closes that is a specifier
`vi.mock("@book-maker/core")` does not name. `packages/db/src/libraryMentions.test.ts` pins it with
exactly that mock at the top of the file. `./qualityGates` is the other direction:
`apps/web` reads `QUALITY_FEATURE_IDS` and `QUALITY_EFFORT_TIERS` off it for the console's quality
screen, and the barrel would pull puppeteer, sharp and `node:fs` into a Vite browser build. Its
only import is a `type`, so nothing of it survives to runtime but the two arrays — and that is load
bearing twice over, because the web container installs *only* `@book-maker/web` and leaves
`packages/core/node_modules` empty (→ apps/web/CLAUDE.md). Vite serves this module out of the
bind-mounted source with no dependency of core's resolvable, which works precisely because the
transformed module has no import statement left in it: `mediaSettings.ts` one level down imports
zod, and a runtime import here would reach it. `./modelTiers` is
the same shape one step further: both of its own imports are statement-level `import type` as well,
and `./libraryMentions` carries no import statement at all — so those three measure the same, a
runtime closure of zero modules and zero packages. It carries `modelTierForInput`, which used to live in `billing.ts` — a pricing module
whose closure is twelve files and zod. The worker's `generation/qualitySettings.ts` (and
`generation/tuning.ts`, until its tier-scaled page-QA budgets were deleted on 2026-10-16) asks only
which models a book runs, spends no credits, and is `vi.mock`ed with `vi.importActual`, so taking
that one property lookup off the barrel dragged puppeteer, sharp and `node:fs` into its mock
factories — and a suite mocking core with a bare factory would have left `modelTierForInput`
undefined *inside the real module*, blowing up there rather than in the code under test. Moving the accessor was the price of
the subpath, and it is the right home anyway: a tier is what routes the models, not what prices
them. `./jobSteps` is the fourth, and the one a consumer had been asking for by name: the console's
fallback step labels in `apps/web/src/jobsDisplay.ts` were a second per-job-type table kept by hand
— the last one in the repo — because the authored `JOB_STEP_TEMPLATES` lives here and the barrel is
refused there. It measures like the rest and for the same reason: its single import names
`GenerationJobType` inline-`type`, so the statement is erased, and `jobDispatch.ts` beneath it
carries no import at all. What crosses is the whole record rather than two arrays, and the console
takes only each template's `label` — the `key` is worker vocabulary the mobile serializers
translate, so it has no business in a display table. `./collections` is the fifth: the console's
plan-question normalizer needs the same trim/drop/order-preserving string uniqueness as core and
the worker, but the console may not import the barrel. It has no imports of its own, and stays
narrowly about collection construction (`uniqueStrings` and inclusive `range`) rather than
becoming a general utilities drawer. `./editFailure` is the sixth, and it earned itself the same
way: it holds the sentences a failed `BookEditOperation` may show a reader, and both `apps/api` and
`apps/worker` write that column — so the rule has to sit below both, in the one package neither of
them can be without. Its consumers are what make the subpath load-bearing rather than tidy:
`apps/api/src/mobile/editOperations.test.ts` mocks the barrel with a bare factory, and
`apps/worker/src/handlers/restructurePages.test.ts` does the same to `runtime/jobLifecycle.js`, so
either one reaching the classifier through a mocked surface would leave the code under test
shipping a Prisma error to the device with nothing failing. It carries no import statement at all.
`./legal` holds the document versions, effective date, company details and public URLs that the
public legal pages print (`apps/web/src/features/legal/`) and the API stamps on every acceptance; the
pages used to restate them by hand, so the version a reader saw could drift from the version they
were recorded as accepting. It has no imports either.
A new entry has to earn itself the same way: a true leaf on the other end, and a consumer that
breaks without it.

That empty closure is a gate now, not a habit. `scripts/check-core-subpaths.mjs` — the `subpaths`
gate in `pnpm check`, or `pnpm check --only subpaths` on its own — takes every entry in the
`exports` map except `.`, follows **value** imports transitively, and fails if any subpath reaches a
single module or package. Erased at build time and therefore free: statement-level `import type` /
`export type`, and a named import whose every specifier is inline `type`. Everything else counts,
including side-effect imports, `export * from`, `import()` and `require()`. The list comes off
`package.json` rather than a copy in the script, so a new entry is covered the moment it lands —
a hand-written list would be the same prose problem one level up. The failure names the subpath,
quotes the import with its line, and spells out the web container, because that is the only place
the breakage shows: on the host every test, `pnpm check` and `vite build` stay green.

**That second erasure rule is true of a compiler option, so the option is read rather than
believed.** `import { type X } from "y"` is elided whole only while `verbatimModuleSyntax` is off;
turn it on and the same statement emits `import {} from "y"`, which resolves `y` at runtime.
`jobSteps.ts` is spelled exactly that way, so flipping the option — a routine modernization for a
repo already writing `.js` specifiers — would have left it reaching `jobDispatch.ts` while the gate
went on printing "runtime closure empty": the gate's own false green, one level up. It now reads the
option from the tsconfig governing whichever tree it walks, `extends` followed nearest-wins, and
when the option is on it counts inline `type` as surviving and says in the failure which setting
changed the rule. `tsconfig.base.json` pins it to `false` with a note pointing at the script — the
pin is the signpost, the gate is the enforcement, and a green run prints the statements that are
free *only* because of it, so nobody has to take the comment's word for it. Prefer statement-level
`import type` in a subpath entry module either way: it is the spelling that survives the flip.

**Proving the safe imports safe says nothing about which import was written**, so the same script
checks the rule from the consumer end too. Its file list is the `exports` map, which by construction
never contains `.` — and `.` is the entry that breaks the container, because `@book-maker/core` is a
declared `workspace:*` dependency of `apps/web`: `import { jobNames } from "@book-maker/core"` — the
job-step labels `apps/web/CLAUDE.md` invites — typechecks, bundles and passes every test on the
host, and 500s in the web container at request time on an unresolvable `puppeteer`. So the second
half walks every source file of each *narrowly installed* workspace and fails a value import of the
barrel, of a subpath the `exports` map does not declare, or of a relative path into
`packages/core/src`. A type-only import of the barrel passes, by the same erasure rule as above.
Which workspaces those are is derived from `docker-compose.yml`, never named in the script: a
`DEV_PNPM_FILTER` with a `...` tail installs the project *and its dependencies*, so `api` and
`worker` are core's own business, while a filter without one installs that project alone and is
exposed exactly as `apps/web` is. A filter naming no workspace is reported rather than skipped, for
the same reason an unreadable `exports` entry is. The two halves also answer each other: the fix the
consumer failure recommends is to add a subpath export, and the producer half is what then proves
the new entry is empty enough to be worth adding.

## What lives where

- `generation/` — the book pipeline: planner, pages, markdown, PDF/EPUB, covers, characters, the
  browser pool. Has its own `CLAUDE.md`.
- `adapters/` — provider SDK wrappers, routing, fallback and retry. Has its own `CLAUDE.md`.
- `schemas/` — the **domain** zod schemas (`book.ts`, `plan.ts`, `mediaSettings.ts`). These are not
  the HTTP request schemas; those are `apps/api/src/mobile/schemas.ts`.
- `prompting/`, `ingestion/`, `audiobook/`, `context/` — supporting passes.
- `jobDispatch.ts`, `jobScope.ts`, `jobSteps.ts` — the canonical job-type map and the pure policy
  the worker and API both read. `jobNames` is the single source of truth; `GenerationJobType` and
  `WorkerJobName` derive from it.
- `creditPricing.ts`, `billing.ts`, `costs.ts` — prices and rate cards.

## Uploads

- **An upload is parsed in linear time, its zip directory is measured before JSZip reads it, and
  its inflation is counted as it happens.** Imports and
  chat attachments are parsed on the API's only thread, so one crafted file used to stall every
  reader: a lazy `<x…>[\s\S]*?</x>` over unclosed tags is quadratic (40,000 unclosed Word
  paragraphs took 2.5 s, 30k characters of Contents headings 13.7 s), and a 2 MB zip that inflates
  to 2 GiB crashed the heap. Element and tag matching goes through the one-pass scanner in
  `ingestion/markupScan.ts`, which returns exactly what the old patterns did (fuzzed old against
  new). Every `.docx`/`.epub` is read through `DocumentArchive` (`ingestion/documentText.ts`),
  which counts bytes as they leave JSZip's inflater and stops at the limit — the zip header's own
  size is never believed. Past a limit the reader gets `FILE_TOO_LARGE`, a code the app already
  shows as-is.
  **The directory is measured in the bytes before JSZip reads it, and no count in it is believed.**
  `JSZip.loadAsync` builds every entry before a caller can count them: a 17 MB .docx of 200,000
  empty entries held the thread 0.8–3.7 s and took 325 MB, and three at once ran the 512 MB API
  heap out, because the entry cap ran after `loadAsync` (launch review C3, 2026-10-15). Nor does
  JSZip believe the end record: it walks headers until a signature stops, decodes each name from
  the local header the entry points at, and keeps every extra field as an object — so a directory
  declaring one entry held ten thousand, 10,000 entries sharing one 64 KB local name made a 0.5 MB
  file decode 655 MB, and 260 entries of empty extra fields took 700 MB from 17 MB.
  `DocumentArchive.open` first asks `inspectZipDirectory` (`ingestion/zipDirectory.ts`), which
  reads what JSZip 3.10.1's `zipEntries.js` will — the last end record in the file's last
  64 KiB + 22 bytes, the ZIP64 locator and record it follows, the headers it walks, the shift it
  applies for prepended bytes — and counts entries, extra fields and local name bytes as it walks,
  allocating nothing per entry. Past `DOCUMENT_ARCHIVE_MAX_ENTRIES`,
  `DOCUMENT_ARCHIVE_DIRECTORY_MAX_BYTES`, `DOCUMENT_ARCHIVE_MAX_EXTRA_FIELDS`, or local names
  adding up to more than the file, it is `FILE_TOO_LARGE`; where it cannot tell what JSZip would
  read (no end record in reach, a locator pointing nowhere, a ZIP64 record with extensible data,
  an offset outside the file) it is `UNREADABLE_FILE`, the answer JSZip's own failure gave. The
  post-`loadAsync` entry count stays as the second line. The walk mirrors JSZip's reader, so
  `zipDirectory.test.ts` checks its count against JSZip's on every archive shape; after a JSZip
  upgrade that test is the one to believe. What still passes costs at most ~0.3 s and ~50 MB (ten
  thousand entries with long names, measured) — the per-file cost of the entry cap itself. A new parser over uploaded text either uses the scanner or arrives with a timing test
  at full size (see `manuscriptImportLimits.test.ts`); a new zip read goes through
  `DocumentArchive`, never `JSZip.loadAsync(...).async("string")`.
  **Linear is not bounded, so a reader that keeps only the start reads only the start.** A chat
  attachment keeps 12,000 characters, yet it read Word bodies up to the import's 64 MiB and EPUB
  chapters up to 16 MiB: a 225 KB .docx inflating to 63 MB held the thread for 2.5 s (2026-10-13
  launch review). It now reads through `extractDocxTextWithin` / `extractEpubTextWithin` under
  `CREATION_ATTACHMENT_READ_MAX_BYTES` (2 MiB inflated, package files included; the same cut for a
  text, HTML or RTF file's bytes) via `DocumentArchive.textPrefix`, which stops the inflater rather
  than refusing, and stops converting once twice the kept length is out. A longer document is kept
  from its start and marked truncated; a start with no text in it is `FILE_TOO_LARGE`. The worst
  markup to strip, empty paragraphs, costs ~150 ms at that size (`creationAttachmentLimits.test.ts`).

## Production configuration

- **A production process refuses to start without what a purchase, a refund, a password reset and
  the console's lock depend on, and the provider keys it demands are read off the routing, never
  listed.** Every one of these was optional and failed where no deploy could see it (infra review,
  2026-10-12): without the Play keys every purchase answered 503 and Google refunded it three days
  later; without the RTDN pair refunds never took credits back; an unset `WEB_PASSWORD` made
  `auth.ts` let every request into the console, `/api/admin` and `/docs`, guarded only by
  Compose's `:?` — absent on the Dockerfile/Railway path, and an all-spaces value passed it and was
  then trimmed to unset; and a missing provider key failed a reader's book at generation time.
  `productionConfig.ts` is the rule: `enforceProductionConfig(config, "api" | "worker", log)` runs
  at boot in `apps/api/src/server.ts` and `apps/worker/src/index.ts`, is a no-op outside
  `NODE_ENV=production`, and throws one `ProductionConfigError` naming every gap and what breaks
  without it. **It prints names, never values — nor a parse error, because V8's JSON error and a
  URL error quote their input**; `productionConfig.test.ts` plants secrets and asserts none
  surfaces. The worker is asked only for `PUBLIC_API_URL` (it writes stored asset URLs) and the
  provider keys; Google sign-in is a warning, FCM keeps its own warning in `pushSender.ts`.
  `MOCK_GOOGLE_PLAY_BILLING` is forced off outside dev and test, so nothing stands in for Play.
  **The provider set is derived** (`adapters/providerRequirements.ts`): every provider named in
  `compiledGenerationTextRouteCandidates` — the compiled defaults' preference lists, which
  `compiledGenerationTextModelRouting` itself resolves — plus the image defaults, the premium
  cover and the fallback rule `resolveImageFallbackSelection` (moved here from the worker so the
  check can read it), the audiobook's speech providers, the voice providers, and the Gemini-only
  work `createProviders` builds, which the test pins by `instanceof`. Each maps to its settings
  through `PROVIDER_CREDENTIALS` (`adapters/providerCredentials.ts`), an exhaustive `Record` over
  the selection schemas' provider enums, which `textProviderConfigured` reads too — so a provider
  added to a schema is a compile error until its key is named, and one added to a route is
  required with no second list to edit. The pinned checklist in `productionConfig.test.ts` fails on
  purpose when that happens, because `deploy/production.env.example` and `docs/deployment.md`
  name the same keys. **The Quality tab's saved routing is a warning, not a refusal**
  (`routedProvidersWithoutCredentials`, logged by both processes at boot): a saved route survives
  its key's removal by design, and the console that moves it needs the API up. `MOCK_AI` waives the
  keys because it calls no provider, and that is the only waiver: the CI smoke test sets dummy
  Play, RTDN, SMTP and password values rather than an opt-out nobody could forget in production,
  and `ALLOW_MOCK_AI_IN_PRODUCTION` — its one switch — is logged as an error at every boot. The
  deploy runs the same check in the new image before it stops the old release
  (`apps/api/src/checkProductionConfig.ts`), so a gap is a failed deploy rather than an outage. A
  new must-have setting goes into `productionConfig.ts` with a test, the env example and the table
  in `docs/deployment.md`, and the smoke test's `.env` gets a dummy for it.

## Voice calls

- **A call ends at 15 minutes, and its Live context is compacted from the top of the persona,
  because every turn re-bills the whole window.** Gemini Live charges each turn for the whole
  context — the system instruction as text ($0.75 per 1M on 3.1 Flash Live) and the conversation so
  far as audio ($3), piling up at about 25 tokens a second (Google's Live API best practices; rates
  in `liveVoiceUsage.ts`). So what a minute costs is set by how much conversation the window may
  hold, and by how long the call runs. The compaction used to be a fixed `triggerTokens` 24,000 /
  `targetTokens` 12,000, which let a 3,000-token persona's call hold 14 minutes of talk before its
  first compaction and six after, and modelled at $0.34 a minute over a 30-minute call against $0.25
  of revenue (launch review, 2026-10-15; the cap's half of the fix is in
  `apps/api/src/mobile/CLAUDE.md`). Both numbers count the system instruction, which the sliding
  window always keeps (API reference, `SlidingWindow`), and the instruction runs from about 1,500
  tokens on a first call to about 7,000 for a returning caller with a long persona, a large cast and
  the 12,000 characters of remembered talk `voiceCallHistory.ts` allows. So no fixed pair fits: the
  review's suggested 12k/6k would have compacted a 7,000-token caller down to its last turn.
  `geminiLiveContextCompression` (`voiceProviders.ts`) sets the pair per call above the
  instruction's estimated size (`estimateInstructionTokens`: four ASCII characters a token, three
  for other alphabets, one for CJK and Hangul): compaction starts 8,000 tokens of conversation in
  (about five minutes of two-way talk) and keeps the last 3,000 (about two minutes, ~15 turns).
  Modelled at full talk, 8 turns a minute:

  | $ a minute | 5 min | 10 min | 15 min | 30 min |
  |---|---|---|---|---|
  | before: fixed 24k/12k, 3k-token persona | 0.119 | 0.209 | 0.280 | 0.336 |
  | after: persona + 8k / + 3k, 1.5k–7k persona | 0.110–0.143 | 0.126–0.159 | 0.135–0.168 | (capped) |

  Revenue is $0.254 a minute at the cheapest credit, so a 15-minute call keeps at least a 33% margin
  across that persona range. The estimate errs high on purpose, since an estimate that runs low
  costs the conversation, but not by much: a quarter high on the largest persona is a 22% margin,
  and UTF-8 bytes / 4, the first spelling, counted a Persian persona half again too large.
  **Unmeasured**: check the Operations tab's `VOICE_CALL_MINUTE` in the first week, and move these
  two numbers, not the cap, if the conversation forgets too soon or costs too much. The token
  carries the pair locked (`lockAdditionalFields`), so a change reaches calls minted after the
  deploy. The token itself now expires a minute past the window to open plus
  `VOICE_CALL_POLICY.maxCallMinutes`, so the relay's funded deadline always comes first.

## Tests

Colocated (`foo.ts` → `foo.test.ts`), Vitest, no DB and no queue. `packages/core` is the only
workspace whose `test` script does *not* pass `--passWithNoTests`, so a new module is expected to
arrive with one.

## Plan and question schemas

- **A question declares how many of its answers count, and the picker follows.** Both question
  surfaces — the planner's `questions` (`planQuestionSchema` in `packages/core/src/schemas/book.ts`)
  and the creation interviewer's clarification (`apps/api/src/creationQuestion.ts`) — carry
  `answerKind`: `choice` (exactly one), `multi` (several, sent together), `open` (nothing to tap).
  Fewer than two options is `open` whatever the model said, in every normalizer, because one option
  is neither a choice nor a set to combine. Without `multi` the models had no honest way to ask
  "which of these themes?": the app sent the first tap and dropped the rest, so they learned to
  bury the options inside the prompt text and ask for a typed answer — which is why both planner
  prompts now forbid writing "choose one or more" or listing options in the prompt. A `multi`
  answer travels as **one line** (`joinQuestionAnswers`, Dart and web both), separated by the comma
  of its own script, because that line is a real chat message the reader sees and the model reads.
  All four pickers read the same flag: the composer drawer and the plan drawer share
  `_QuestionOptionList` (`creation_chat_question_options.dart`), plus `PlanQuestionsCard` on the
  book page and the operator console's `PlanQuestionStepper`. In the console the picks live in
  `QuestionResponse.picked`, which is also what stops a joined answer being mistaken for a typed
  custom one.

- **An alias is how the model spelled a plan field, never a weaker claim on it, so a candidate's
  aliases are canonicalised before it merges onto the fallback — and an answer the field's own
  schema refuses is dropped under every spelling, canonical included.** `openingHook` may arrive as
  `opening_hook` or `hook`, `writingComplexity` as `complexity`, `writing_complexity`, `writingLevel`
  or `readingLevel`; both are resolved by a first-match lookup down a canonical-first key list. A
  revision is a patch, so it is merged onto a fallback — the current plan, or the template plan
  `makeFallbackPlan` seeds — and that fallback is a *parsed* plan, which always spells its fields
  canonically. Merging first therefore left `{ openingHook: "<old>", opening_hook: "<new>" }`
  standing in one record and the lookup answered with the stale one: the reader asked for a
  different opening, the book kept the old one, and nothing failed. `writingComplexity` had it
  worse — it is required, so the fallback always carries it, and `makeFallbackPlan` fills it from
  the caller's own `input.complexity`, which is why it bit initial planning too and handed back the
  number the request came in with instead of the planner's answer. So `canonicalizePlanAliases`
  runs inside `mergePlanRecords` (`packages/core/src/schemas/plan.ts`), on the candidate alone, off
  `PLAN_ALIASED_FIELDS` — one table the promoter and the reader both consume, so a spelling cannot
  be tolerated by one and unknown to the other.

  `accepts` tests the **value**, not the spelling, so it governs the canonical key exactly as it
  governs the aliases: every key the field cannot use is deleted from the candidate, the merge
  finds no answer there, and the fallback's value stands. Guarding only the promotion left the one
  spelling the planner prompt actually asks for unguarded, which is where both losses came from —
  a `writingComplexity` of `"grade 5"` (NaN, and the field is required) overwrote the fallback's
  number and cost the revision its whole parse, and an `openingHook` emitted as an array erased a
  good stored hook that its `opening_hook` twin was already being refused for. The level predicate
  is `writingComplexitySchema` itself, the same object `bookPlanObjectSchema` takes the field with,
  never a hand-written restatement of its range: a predicate that refuses what the schema would
  have taken drops a usable answer and leaves a required field missing, the same bug pointing the
  other way. A hook is stored trimmed and a hook that trims away is no hook, because every consumer
  gates on truthiness. Nothing is dropped on `bookPlanSchema`'s no-fallback path over a plan-like
  record — the path every worker handler re-reads a stored plan through: it never merges, so
  `canonicalizePlanAliases` never runs on it, the charitable lookup still reads whatever spelling
  the model used, and a non-string hook still degrades to "no hook" rather than failing the whole
  parse.

## Credit pricing

- **A price key with no tier suffix is the *balanced* rate.** The quality preset a reader picks in
  the app's **Effort** section (`fast` / `balanced` / `premium` / `ultra`) routes to genuinely
  different models, so seven rates carry `Fast` / `Premium` / `Ultra` twins beside them —
  `planGeneration`, `planRevision`, `fullBookBase`, `fullBookPerPage`, `imageGeneration`,
  `pageRegenerationPerPage`, `bookTextEditPerPage` (`TIER_PRICED_KEYS`). Read them **only**
  through `tierPrice(pricing, key, tier)`, and name the key to charge with `tierPriceKey` — the
  dashboard's revenue projection buckets by the same function, so a book cannot be quoted against
  one key and counted against another. Leaving the base key meaning balanced is what makes adding
  a twin migration-free: `normalizeCreditPricing` backfills the new keys from the defaults, so
  every `CreditPricingRevision` written before those twins existed still means what it meant.
  Raising a *legacy compiled zero* is the exception — initial planning used to be free, so
  `planGeneration: 0` in a stored revision is not an operator override; migration
  `000061_tiered_plan_generation_pricing` appends a head revision that turns that zero into 40
  and seeds the three new tier keys. Charge the first plan through `planGenerationCreditCost`;
  revise one through `planRevisionCreditCost`, which climbs the same ladder because a revision runs
  the same planner (a flat 40 charged a Quick Draft revision twice its plan); book replans and the
  other `…Base` charges stay flat. Everything else stays
  flat on purpose — audiobooks and voice calls reach a tier-blind provider, and those `…Base`
  charges are request overhead rather than model spend.
  **Pricing reads `mediaSettings.modelTier`, never `mediaSettings.mobile.qualityPreset`**
  (`modelTierForInput`): the tier is what routes the models and what the provider-cost table
  already keys off, while the mobile echo is written only by the app — pricing off it let a
  project that set the tier directly run premium models for free. No tier recorded is *balanced*,
  which is right rather than merely safe: a book from before tier routing runs the legacy single
  model. The per-page rates are floored at the **Max** plan's break-even, not at the ratio to
  balanced — a credit is worth $0.002832 to a Creator subscriber and only $0.002125 to a Max one
  after Play's cut, and Max is the plan someone can spend 80,000 credits of premium writing on, so
  a rate that merely tracked provider cost billed a long premium book at a loss.
- **Pages a finished book gains are priced like the book they join, never at the rewrite rate.**
  A chat continuation's new chapters and a structural insert's new pages used to bill
  `pageRegenerationPerPage` (80 a page on Balanced), so ten more pages cost more than a new ten-page
  book (launch review, 2026-10-13). They now cost the flat `addedPagesBase` (100) plus the book's own
  tier rate `fullBookPerPage` for each page added — `addedPagesCreditCost` in
  `apps/api/src/mobile/bookEditPricing.ts`, the one function the proposal card and the charge both
  read — and nothing at all, base included, when no page is added (a delete or a move). Neither edit
  draws a picture today, so there is no image line; one that starts drawing adds the tier's
  `imageGeneration` per picture there. A rewrite of an existing page keeps the rewrite rate. The
  dashboard's driver report buckets both kinds into those same two keys (`admin/pricingDrivers.ts`).
  The chat rebuild (`book_replan`) is quoted through `estimateBookReplanCreditCost`, the function
  its charge stores as its quote.
- **A book is one charge, the same for a free reader and a subscriber, and no quote carries an
  export unlock.** Every generated book's price used to carry the 150-credit `exportUnlock`, then
  (launch review, 2026-10-13) only a subscriber's did, while their plan also "covered" the unlock
  — so subscribers paid it twice. Since 2026-10-15 a finished book downloads free
  (`apps/api/src/mobile/CLAUDE.md`), and `estimateFullBookCreditCost` /
  `estimateBookReplanCreditCost` take no export option and write no `EXPORT_UNLOCK` line and no
  `includesExportUnlock` assumption. A quote stored before then may still hold that line; every
  reader of a stored quote finds lines by code (the user-stop rates never counted the unlock as
  delivered), so old and new quotes settle alike. **`exportUnlock` is a retired key, not a deleted
  one** (`RETIRED_CREDIT_PRICING_KEYS`): its default and its ceiling are 0, so a write cannot price
  it and every stored price list's 150 reads back as 0, and it is left out of `CREDIT_PRICE_KEYS`,
  so no projection counts it. It stays in the table because the billing payload ships the table and
  installed apps add `creditCosts.exportUnlock` to a subscriber's book quote, falling back to 150
  when the key is missing; at 0 an old build's quote matches the charge without a release.
  `creditCostForOperation("EXPORT_UNLOCK")` is 0 whatever a price list says; the operation stays so
  old ledger rows keep their title. No migration: the ceiling is the whole retirement.
  `freeBookQuote.test.ts` spells the totals out for the Dart twin.
- **A children's picture book draws two pictures for every five pages, rounded to the nearest, at
  least one and at most twelve, and the count never falls as a book grows.** 5 pages draw 2, 10
  draw 4, 12 draw 5, 16 draw 6, 24 draw 10, 29 and longer 12 (`PICTURE_BOOK_MAX_PICTURES`). The
  owner's decision (Parsa, 2026-10-17: "for a 10 page book I think 4 image max is enough"), because
  pictures are about 99% of an illustrated book's provider cost — a 10-page Quick Draft children's
  book spent $0.585 on 15 image calls and $0.006 on all its text. History: a flat four whatever the
  length; then a picture a page to twelve and one per two pages after, which stepped *down* at
  thirteen (12 pages drew 12, 13 drew 7) and was rejected for it; then `min(pages, 12)`
  (coordinator's decision, 2026-10-13), which this replaced. It is integer arithmetic —
  `min(12, max(1, floor((4p + 5) / 10)))`, round(2p/5) with no tie possible — so the Dart twin
  agrees on every length. `pictureBookIllustrationCap` (`generation/illustrationSlots.ts`) is the
  cap for a KIDS book the app made as a children's story (`short_story`) or with no app type; an
  Auto book keeps Auto's ⌈pages/8⌉ because the app quotes Auto before its lane is known. The slots
  it picks are the existing even spread, so 10 pages draw pages 1, 3, 6 and 8. The typesetter gives
  each KIDS scene its own sheet from 5 to 40 pages, caps a picture scene's picture and centres a
  text-only scene (`pdfStoryPages.ts`), so no layout changed. The image rate is the tier's
  `imageGeneration`; the free tier's illustrated-book slot rules are unchanged. Mirrored by
  `estimatedInteriorImageCount` / `pictureBookIllustrationCount` in the app, and both sides spell
  the same table out (`freeBookQuote.test.ts`, `book_quote_test.dart`). **The welcome grant is
  sized to it**: with a drawn cover on Balanced, a free reader's 12-page book is 716 and its plan 40
  (756), a 16-page 833 with its plan, a 24-page 1,077, a 30-page — the free cap — 1,215, so the grant is 1,250 (migration 000110 moves an installation
  still on 1,150, which under `min(pages, 12)` left out every picture book of 22 pages or more).
  `welcomeCredits.test.ts` walks every free length; raise the grant with any price that would push
  one past it. The dashboard's revenue projection (`admin/pricingDrivers.ts`) counts a charged
  book's pictures off the quote its charge stored (`estimatedInteriorImages`, `includesCover`), and
  re-estimates with today's rule only a charge that stored none, so books charged under an earlier
  rule do not project pictures nobody paid for.
- **Credit prices are operator-editable, not constants.** Read them with `creditPricing()` from
  `packages/core/src/creditPricing.ts` — never capture a price at module load, which is why
  `VOICE_CALL_POLICY` no longer carries `creditsPerMinute`. The compiled `DEFAULT_CREDIT_COSTS` are
  only the starting point; `packages/db/src/creditPricing.ts` loads overrides from the append-only
  `CreditPricingRevision` table (highest version wins, empty table means defaults) and pushes them
  into that snapshot. `server.ts` loads at boot and re-reads every 15s; the worker prices nothing
  and deliberately never loads. The pure pricing functions take an optional trailing `pricing`
  argument so `/api/admin/pricing/preview` can quote unsaved values without moving the live ones —
  and the snapshot must only ever be applied *after* a write commits. The console edits this at
  `/pricing`, and `serializeMobileBilling` (`apps/api/src/mobile/billingSerializer.ts`) ships the
  result to the Flutter app, so a price change needs no client release. Free monthly grants are
  permanently disabled (`freeMonthlyCredits: 0`, retained for wire/history compatibility), and
  `messageCreditsFree` has a minimum of 1. Validation rejects other values; normalization enforces
  these bounds when loading or reverting legacy revisions; a key with a floor other than 0 names it
  in `CREDIT_PRICING_MINIMUMS` (`messageCreditsFree` 1, `paidMaxBookPages` 30), which the write
  schema, the read normalizer, the admin route's OpenAPI twin and the console all read. Several keys
  in that table are free-tier *limits* rather than prices (`welcomeCredits`, `welcomeCreditsEnabled`,
  `freeMonthlyCredits`, `freeIllustratedBooksPerMonth`); the message-limit and manuscript-import
  keys are non-price too, and so are two operator switches every account is held to —
  `paidMaxBookPages` (read through `maxGeneratedBookPages`) and `ultraTierEnabled` (read through
  `isUltraTierEnabled`), see `apps/api/src/mobile/CLAUDE.md`. A price list saved before a key
  existed reads its compiled default, which is why `ultraTierEnabled` is *off* for every old
  revision as well. Anything projecting revenue iterates `CREDIT_PRICE_KEYS`, not every key,
  or it invents income from the free tier's limits or a retired key (`exportUnlock`, above). Paid tiers take their monthly credits from
  `DEFAULT_BILLING_PRODUCTS` instead, because those numbers are pinned to a Play price point that
  needs a release anyway.
