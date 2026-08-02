# AI Book Maker

Generates full books from a short brief: plan → chapters → pages → illustrations → PDF/EPUB.
A Flutter app and a React console both talk to one Fastify API; a BullMQ worker does the generation.

## Commands

```bash
pnpm check          # typecheck + lint + file-size budget + all tests. Run this before saying you're done.
pnpm typecheck      # tsc --noEmit across all workspaces
pnpm lint           # oxlint (config in .oxlintrc.json)
pnpm test           # vitest across all workspaces
pnpm check:sizes    # fails when a file grows past its budget (see below)

pnpm dev            # api + worker + web in parallel
MOCK_AI=true pnpm dev:api      # no provider tokens needed; fake adapters return canned text
MOCK_AI=true pnpm dev:worker

make up             # full stack in Docker (postgres, redis, pgadmin, api, worker, web)
make mobile-run     # Flutter app against http://10.0.2.2:4001 (Android emulator)
make mobile-test    # flutter test
make mobile-analyze # flutter analyze
```

Postgres is on host port **55432** (not 5432) to avoid colliding with a local install.
The API serves `http://localhost:4001`, OpenAPI docs at `/docs`.

**`MOCK_AI=true` is the default way to work.** It swaps in fake text/image/research adapters, so
you can exercise the whole pipeline without tokens or network.

## Layout

```
apps/api        Fastify HTTP API — routes only, no generation logic
apps/worker     BullMQ worker — all book generation happens here
apps/web        React/Vite operator console
apps/mobile     Flutter app (the product)
packages/core   Provider adapters, prompts, generation algorithms, schemas. No HTTP, no queue.
packages/db     Prisma client, schema, billing/credit ledger
```

Dependency direction is strictly `apps/* → packages/db → packages/core`. `packages/core` is the
leaf: it must not import from `apps/*` or from `packages/db`.

### apps/worker

One BullMQ queue (`book-maker`), one job per unit of work. `src/index.ts` is only the entry
point: it builds the Worker, dispatches on `job.name`, and owns shutdown. Everything else:

```
runtime/     config, queue handle, job lifecycle (status transitions + progress steps),
             dispatch/fan-out, serialization helpers, stop-signalling
providers/   logging decorators around the core adapters: run logs, token/cost accounting,
             image fallback between providers
generation/  algorithms shared by handlers: book passes, page review loop, semantic memory,
             plan helpers
handlers/    one file per job type — planning, generateBook, generatePage, generateImage,
             generateCover, compileExport, applyBookEdit, importBook, continueBook,
             replanBook, characters
```

Job types live in `JobType` in the Prisma schema and must stay in sync with the `switch` in
`src/index.ts` and with `JOB_STEP_TEMPLATES` in `runtime/jobLifecycle.ts`.

**Importing `runtime/queue.ts` opens a Redis connection.** Only the entry point and the dispatch
layer should depend on it — that is why handlers never import it directly.

### apps/api

```
src/server.ts        app wiring, static assets, retention sweep, queue reconciliation
src/routes/          the legacy operator API (/api/projects, …) used by apps/web
src/admin/           metrics + inspection queries behind /api/admin (the dashboard)
src/mobile/          everything under /api/mobile — this is the surface the Flutter app uses
src/mobileAuth.ts    email/password + bearer/refresh tokens for mobile users
src/auth.ts          WEB_PASSWORD cookie auth for the operator console only
```

Anything under `/api/admin/` is **cookie-only** — `isOperatorOnlyPath` in `src/auth.ts` rejects
mobile bearer tokens there before a handler runs, so admin routes never think about mobile users.
The operator dashboard at `/admin` (overview, users, moderation, pricing) is the only consumer.

`src/mobileProjects.ts` is now a thin composition root. It builds one `MobileRouteContext`
(config, rate limiters, Google Play verifier, AI enrichment hooks) and hands it to route groups
in `src/mobile/routes/`. Those are registered **directly on the same Fastify instance**, not via
`fastify.register`, so they share a single encapsulation context. Keep it that way — switching to
`register` would give each group its own content-type parsers and hooks.

Everything `mobileProjects.ts` re-exports is public API consumed by `server.ts`,
`mobileImports.ts`, or tests. Don't narrow those exports without checking callers.

### Two auth systems

They are unrelated and easy to confuse:

- **Mobile users** — database-backed accounts under `/api/mobile/auth/*`. Bearer access tokens,
  refresh tokens, only hashes stored in `MobileSession`. This is real multi-user auth.
- **Operator console** — a single optional `WEB_PASSWORD` cookie guarding `/api/*`, `/docs` and
  generated assets. Not per-user.

## Testing

Tests are colocated (`foo.ts` → `foo.test.ts`) and run under Vitest with the database and queue
mocked — no Postgres or Redis needed.

The mobile API suites in `apps/api/src/mobile/*.test.ts` share
`src/mobile/testing/mobileApiHarness.ts` (fixture + record factories) and
`src/mobile/testing/mobileApiMocks.ts` (the module mocks).

**`mobileApiMocks.ts` must import nothing but `vitest`.** Vitest calls its factories from inside
`vi.mock(...)`; if that file reaches any module which transitively imports a mocked module, the
mock registry deadlocks and the suite hangs instead of failing.

## Conventions

- ESM everywhere. Relative imports carry the `.js` extension (`./foo.js`), even from `.ts`.
- TypeScript is strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  An optional property means "may be absent", not "may be `undefined`" — write
  `{ ...(x ? { x } : {}) }` rather than `{ x: undefined }`.
- Zod validates request bodies; the JSON-schema copies next to them exist for the OpenAPI docs
  and have to be updated alongside.
- `packages/db/src/generated/` is generated by Prisma and gitignored. Run `pnpm db:generate`
  after touching `schema.prisma`; never edit it by hand.
- Cover fonts must stay OFL-licensed (Inter, Source Serif 4, Playfair Display, Nunito,
  Bebas Neue, Noto Sans). Do not substitute proprietary or unclear-license fonts.

## File size budget

`pnpm check:sizes` fails when a `.ts`/`.tsx`/`.dart` file passes **900 lines**. Files that are
already larger are listed with an explicit ceiling in `scripts/check-file-sizes.mjs`.

Those entries are debts, not permissions. If you need more room, split the file along a real seam
— a job handler, a route group, a widget cluster — rather than raising the number. The script
tells you when a listed file has dropped under the default so the entry can be deleted.

## Gotchas

- **Generation state lives in the database, not in Redis.** A `GenerationJob` row is written
  first, then pushed to BullMQ; `reconcileUndispatchedWorkerJobs` re-pushes anything that was
  persisted but never reached Redis. Preserve that order or a crash between the two strands a book.
- **Run logs are the debugging artifact.** Every provider call is appended as JSON lines under
  `<BOOK_STORAGE_DIR>/<projectId>/runs/`. Read those before adding new logging.
- **Credits are reserved, then committed or refunded.** Any new priced operation has to close that
  loop, including on the failure path. `packages/db/src/billing.ts` is a facade over
  `billingLedger.ts` (balances), `billingEntitlements.ts`, `billingSubscriptions.ts` (Google Play),
  `planPeriods.ts` (allowances and quotas) and `billingInternals.ts` (shared plumbing) — import the
  facade, never a module behind it, or the `vi.mock("@book-maker/db/billing")` in the API suites
  stops covering you.
- **A balance is two pools, and spending draws the expiring one first.** `planCredits` is the
  monthly allowance — free tier or subscription period — and it *resets* at each period boundary
  rather than accumulating; `availableCredits` is what was bought outright and never expires.
  `CreditBalance.availableCredits` is deliberately still the *total* of both, because shipped
  clients compare it against a quote. Each ledger entry records how much of itself came from the
  allowance in `planCreditsDelta`, which is what lets a refund put credits back where they came
  from — and after a period rollover a refund goes entirely to the purchased pool, because that
  period's allowance has already been re-granted in full.
- **The free month is granted lazily, not by a cron.** `ensureCurrentPlanPeriod` runs at the top of
  `reserveCredits` and before `serializeMobileBilling`, so anyone who can spend or look has already
  been granted. It never overwrites a plan period that is still live, which is what stops it
  clobbering a subscription's allowance. Subscription periods are granted only by the Google Play
  verify path and the hourly renewal sweep in `apps/api/src/subscriptionRenewal.ts`, which is why
  `SubscriptionState.purchaseToken` keeps the raw token.
- **The free tier's illustrated-book limit is enforced in exactly one place.**
  `POST /api/mobile/plans/:id/approve` is the only mobile route that starts an image-producing
  generation, so that is where the `UsageCounter` slot is claimed (403 `IMAGE_LIMIT_REACHED` when
  it is gone — never a silent downgrade to text-only). The claim is stamped onto the reservation as
  `metadata.imageQuota`, so `refundCreditLedgerEntry` hands the slot back on every failure path
  without each of them knowing about quotas.
- **Chat replies never name a credit price.** The number travels as
  `metadata.creditsCharged` (queued work) or `metadata.editProposal.credits` (a proposal), and the
  app draws it as the tappable badge in `credit_cost_badge.dart` — one place that also explains what
  credits buy and that failures are refunded. `stripCreditAnnouncement` in
  `apps/api/src/mobile/projectChat.ts` removes the old sentence from transcripts written before
  that, so a new priced reply that writes the price into its text would say it twice.
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
  away. Every `clarify` records `clarification: "scope"` even when the model reports `"none"`
  (`intentFromDecideAction`), because that is what makes `handleProjectChatIntent` store the
  resumable `pendingEdit`; "fixing" that tautology strands the next turn with a bare fragment.
  `bookEditIntent.ts` splits into `bookEditMessage.ts` (reading a message: pages, quotes, scope,
  languages — a leaf) and `bookEditHeuristics.ts` (the model-free classifier), which is why those
  import types back from it but never values.
- **The Sources list at the end of a book is not page text.** `compileBookMarkdown` builds it from
  the project's `ResearchSource` rows on every export, so no page edit can remove it — routed as
  one it charges for rewriting pages that never held it and then recompiles the section straight
  back. "Remove the sources" is a `back_matter` intent instead
  (`apps/api/src/bookEditBackMatter.ts` recognises it, the router has a matching `back_matter`
  edit target): free, it sets `mediaSettings.includeSources` on the project and queues the same
  recompile undo uses. Read that flag with `includeSourcesPreference` from the **project row**,
  never from a plan version's `inputSnapshot`, or toggling it would need a replan to take effect.
- **A non-null `ProviderCallLog.costHint` *is* a settled, priced call.** Provisional, in-flight and
  failed rows all write `null` (`apps/worker/src/providers/usageAccounting.ts`), so real provider
  spend is `SUM("costHint")` — do not replay the rate cards in `packages/core/src/costs.ts` to
  aggregate it. Rows the rate card could not price are counted separately rather than dropped, so
  the total is never quietly short. `calculateProjectCostSummary` still recomputes per project,
  because it also folds in image costs from `ImageAsset` when the log side is thin.
- **"Revenue" is two different numbers and the dashboard shows both.** Cash collected
  (`PurchaseRecord.amountMicros`) is money banked in the window; credits delivered × the credit
  rate is the value of work actually done. They diverge because a reader buys on one day and spends
  over the next month, so pairing either alone against provider spend misstates the margin.
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
- **The Flutter creation chat screen is one library split with `part` files**
  (`creation_chat_screen.dart` plus `creation_chat_*.dart`). Part files have no imports of their
  own; add imports to the parent. This keeps the `_Private` widgets private.
- **The in-app reader renders the compiled `book.pdf` with pdfrx (PDFium).** `main.dart` must call
  `pdfrxFlutterInitialize()` before `runApp`, and the natives are not available under
  `flutter test` — `BookReaderScreen` takes its viewer through `readerViewerBuilderProvider` so
  tests can stub it. PDF pages do not map to `Page.index`: `generateBookPdf` renders the whole
  book as one HTML flow and lets Chrome paginate it, so nothing separates one `Page` from the
  next. A selection is resolved back to a book page by `ReaderPageLocator` and then named
  explicitly in the chat message, which is what `pageIndexesFromMessage` in
  `apps/api/src/bookEditIntent.ts` reads.
- **The reader places the rendered page before it places the selection.** Matching the selected
  text alone resolves a recurring passage to its *first* copy in the book, which is the wrong page
  whenever the reader is past it. `ReaderPageLocator.spanForPage` probes the PDF page's own
  extracted text — which the reader never selected — for a `Page.index` window, and `locate(...,
  within: span)` then searches only there. A probe matching more than one page is discarded rather
  than trusted, and a null span (the cover, the contents page, anchors that disagree) falls back to
  searching the whole book. Keep null cheap and common: it is the safe answer.
- **A voice call's audio never reaches the server.** The app opens its own socket to Gemini with
  an ephemeral token the API mints, so the only transcript we have is the one the app uploads —
  in batches, on the heartbeat it is already sending, because the captions on screen are a capped
  display buffer and a call that dies with the app never sends an end. It lands in
  `VoiceCall.transcript`, and `apps/api/src/mobile/voiceCallHistory.ts` reads the last calls back
  into the next one's system instructions. That is *memory, not resumption*: every call is a fresh
  session, and the prompt says so in as many words. Uploads are at-least-once, so the append drops
  the overlap when a retried batch arrives twice.
- **An audiobook is made *from* a finished book, so failing one must not touch the book.**
  `generate-audiobook` is excluded from `shouldFailProjectForJob`, and `markFailed`/`markStopped`
  route it to a branch that refunds `payload.billingLedgerEntryId` and marks the `Audiobook` row
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
- **The app plays local files, not a URL, and draws one timeline over many of them.** Chapter audio
  is downloaded into `tomeza_audiobook/<projectId>/<audiobookId>/` because the media session keeps
  playing when the app is backgrounded, where a token refresh cannot be relied on. Every chapter has
  a length from the moment it is planned — `estimatedDurationMs` until it is narrated,
  `durationMs` after — which is what lets the seek bar show the whole book while the back half is
  still being made. Lock-screen artwork must be a `file://` URI: the media session fetches it
  outside the Dio client and without the bearer token.
- Docker bind-mounts the repo, so `node_modules` uses anonymous volumes. After changing
  `pnpm-lock.yaml`, rebuild images or run `make deps`, or the containers keep a stale install.
- **`make up` and `pnpm dev` are the same queue.** A host worker defaults to
  `redis://localhost:6379` and `./storage`, which are the published ports and the bind mount of the
  Docker stack — so running both means two workers racing for one book's jobs, and a
  `MOCK_AI=true` host worker will happily answer a real generation with canned text. The container
  writes as root; `scripts/docker-dev-entrypoint.sh` sets `umask 0000` so the host user can still
  write into directories the container created first, but the fix for a stray `EACCES` under
  `storage/` is to stop the duplicate stack, not to loosen permissions further. Check with
  `ps -eo pid,args | grep dev:worker` before blaming the code.
