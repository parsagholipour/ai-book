# Core

Provider adapters, prompts, generation algorithms, schemas. This is the leaf of the dependency
graph: `apps/* → packages/db → packages/core`. It must not import from `apps/*` or from
`packages/db`, and nothing in it may open an HTTP server or touch the queue.

Relative imports carry the `.js` extension (`./foo.js`) even from `.ts`. Consumers import the bare
specifier `@book-maker/core`, and the barrel is the default — add to `src/index.ts` rather than
reaching past it.

**A module kept light enough to survive a mock has to be light in both directions.**
The `exports` map has one narrow entry beside `.`, and it exists to be un-mockable.
`./libraryMentions` is imported by `packages/db/src/libraryMentions.ts` and by nothing else. That db
module is itself a subpath so it survives a wholesale `vi.mock("@book-maker/db")`; taking the strip
helpers off this barrel quietly handed it a *second* mock surface, because a
suite that mocks core with a bare factory replaces the whole barrel — adapters, prompts, PDF — and
`generationDescription` then throws `stripBoundLibraryMentionMarkers is not a function`. What closes that
is a specifier `vi.mock("@book-maker/core")` does not name. `packages/db/src/libraryMentions.test.ts`
pins it with exactly that mock at the top of the file. A second entry has to earn itself the same
way: a true leaf on the other end, and a test that fails without it.

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
