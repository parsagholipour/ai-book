# Core

Provider adapters, prompts, generation algorithms, schemas. This is the leaf of the dependency
graph: `apps/* → packages/db → packages/core`. It must not import from `apps/*` or from
`packages/db`, and nothing in it may open an HTTP server or touch the queue.

Relative imports carry the `.js` extension (`./foo.js`) even from `.ts`. Consumers import the bare
specifier `@book-maker/core`, and the barrel is the default — add to `src/index.ts` rather than
reaching past it.

**A module kept light enough to survive a mock has to be light in both directions.**
The `exports` map has four narrow entries beside `.`, and each one is a module a consumer must be
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
whose closure is twelve files and zod. The worker's `generation/tuning.ts` and
`generation/qualitySettings.ts` ask only which models a book runs, spend no credits, and are both
`vi.mock`ed with `vi.importActual`, so taking that one property lookup off the barrel dragged
puppeteer, sharp and `node:fs` into their mock factories — and a suite mocking core with a bare
factory would have left `modelTierForInput` undefined *inside the real module*, blowing up in
`pageQaRewriteAttemptsFor` rather than in the code under test. Moving the accessor was the price of
the subpath, and it is the right home anyway: a tier is what routes the models, not what prices
them. `./jobSteps` is the fourth, and the one a consumer had been asking for by name: the console's
fallback step labels in `apps/web/src/jobsDisplay.ts` were a second per-job-type table kept by hand
— the last one in the repo — because the authored `JOB_STEP_TEMPLATES` lives here and the barrel is
refused there. It measures like the rest and for the same reason: its single import names
`GenerationJobType` inline-`type`, so the statement is erased, and `jobDispatch.ts` beneath it
carries no import at all. What crosses is the whole record rather than two arrays, and the console
takes only each template's `label` — the `key` is worker vocabulary the mobile serializers
translate, so it has no business in a display table. A fifth entry has to earn itself the same way:
a true leaf on the other end, and a consumer that breaks without it.

That empty closure is a gate now, not a habit. `scripts/check-core-subpaths.mjs` — the `subpaths`
gate in `pnpm check`, or `pnpm check --only subpaths` on its own — takes every entry in the
`exports` map except `.`, follows **value** imports transitively, and fails if any subpath reaches a
single module or package. Erased at build time and therefore free: statement-level `import type` /
`export type`, and a named import whose every specifier is inline `type`. Everything else counts,
including side-effect imports, `export * from`, `import()` and `require()`. The list comes off
`package.json` rather than a copy in the script, so a fifth entry is covered the moment it lands —
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
  the app's **Effort** section (`fast` / `balanced` / `premium`) routes to genuinely different models,
  so five rates carry a `Fast` and a `Premium` twin beside them — `fullBookBase`,
  `fullBookPerPage`, `imageGeneration`, `pageRegenerationPerPage`, `bookTextEditPerPage`
  (`TIER_PRICED_KEYS`). Read them **only** through `tierPrice(pricing, key, tier)`, and name the
  key to charge with `tierPriceKey` — the dashboard's revenue projection buckets by the same
  function, so a book cannot be quoted against one key and counted against another. Leaving the
  base key meaning balanced is what makes this migration-free: `normalizeCreditPricing` backfills
  the new keys from the defaults, so every `CreditPricingRevision` written before tiers were
  priced still means what it meant. Everything else stays flat on purpose — `exportUnlock`
  compiles the same PDF whatever wrote it, audiobooks and voice calls reach a tier-blind provider,
  and the `…Base` charges are request overhead rather than model spend.
  **Pricing reads `mediaSettings.modelTier`, never `mediaSettings.mobile.qualityPreset`**
  (`modelTierForInput`): the tier is what routes the models and what the provider-cost table
  already keys off, while the mobile echo is written only by the app — pricing off it let a
  project that set the tier directly run premium models for free. No tier recorded is *balanced*,
  which is right rather than merely safe: a book from before tier routing runs the legacy single
  model. The per-page rates are floored at the **Max** plan's break-even, not at the ratio to
  balanced — a credit is worth $0.002832 to a Creator subscriber and only $0.002125 to a Max one
  after Play's cut, and Max is the plan someone can spend 80,000 credits of premium writing on, so
  a rate that merely tracked provider cost billed a long premium book at a loss.
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
  result to the Flutter app, so a price change needs no client release. Two keys in that table are
  free-tier *limits* rather than prices (`freeMonthlyCredits`, `freeIllustratedBooksPerMonth`);
  anything projecting revenue iterates `CREDIT_PRICE_KEYS`, not every key, or it invents income
  from the free tier. Paid tiers take their monthly credits from `DEFAULT_BILLING_PRODUCTS`
  instead, because those numbers are pinned to a Play price point that needs a release anyway.
