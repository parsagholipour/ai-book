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
point: it builds the Worker and owns shutdown; `src/processJob.ts` is the processor — it guards
each delivery (stale check before the ACTIVE claim, follow-ups after the COMPLETED write) and
dispatches on `job.name`. Everything else:

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
`src/processJob.ts` and with `JOB_STEP_TEMPLATES` in `runtime/jobProgress.ts`.

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

**Everything protected is cookie-only except `/api/mobile/*` and the two asset prefixes.**
`allowsMobileBearer` in `src/requestAuth.ts` names that surface — `/api/mobile/`,
`/assets/images/`, `/assets/voice/` — and `isOperatorOnlyPath` in `src/auth.ts` is literally its
complement, so a bearer token is rejected before any other handler runs. It used to be an
allowlist of operator paths instead, which is why `/api/projects/*` and `/api/plans/*` quietly
accepted mobile bearers: every handler there scopes to `actor.userId`, so the app's own user
reached exactly its own books — through routes that charge nothing.
`POST /api/plans/:id/approve` starts a whole book with no credit reservation and no free-tier
image slot, and `GET /api/projects/:id/export/*` renders inline and sends the file without the
entitlement its `/api/mobile/*` twin takes. **Ownership is not authorization here**; the actor's
*kind* is, which is what `requireOperatorActor` asserts at every legacy handler. The assets are
the one shared surface — the serializers hand the app URLs under them — which is why they live in
`routes/projectAssets.ts` and are the only thing in that file group still calling
`resolveProjectActor`. The operator dashboard at `/admin` (overview, users, moderation, pricing)
is the only consumer of `/api/admin/`.

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
- Export fonts must stay OFL-licensed. Latin and friends: Inter, Source Serif 4, Playfair
  Display, Nunito, Bebas Neue, Noto Sans. Other scripts: Vazirmatn (Persian), Noto Naskh
  Arabic (Arabic/Urdu), Noto Serif Hebrew / Devanagari / Thai / SC / JP / KR. Do not
  substitute proprietary or unclear-license fonts. The registry is
  `packages/core/src/generation/bookFonts.ts`.

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
- **A plan period cut short is *adopted*, not re-granted.** `applyPlanPeriodTx` used to return early
  on a duplicate idempotency key, which is right for the concurrent-grant race but wrong for a
  cancellation: someone who took their free month on the 1st, subscribed on the 5th and cancelled on
  the 20th already owns `plan-period:{userId}:free:{month}`, and returning early left them holding
  the *subscription's* allowance on the free tier. It now moves the account onto the period with a
  granted amount of 0 whenever `account.planPeriodKey !== period.key` — that guard is the safety
  property, because the race it must not disturb runs under `runSerializable` and re-reads the
  winner's key. `planCreditsPerPeriod` still gets the period's full size, so the app reads
  "0 of 1,000 monthly credits left" rather than a plan with no allowance at all.
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
  languages — a leaf) and `bookEditHeuristics.ts` (the model-free classifier), which is why those
  import types back from it but never values.
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
- **Declining the cover buys a designed one, it does not remove the cover.** `includeCover` only
  ever answered "did a model draw this", so `coverArtSourceFor` (`packages/core/src/generation/
  coverSource.ts`) resolves `false` to `"design"`: the book gets a cover from the 50-entry catalog
  in `coverDesigns.ts` for free, picked by `selectCoverDesign` from the title, premise, audience
  and category. **Read the source through that resolver, never `includeCover` directly** — it is
  what keeps the quote, the dispatch gate and the handler agreeing, and what lets rows written
  before the field existed price identically. Only `"none"` means no cover, and only the operator
  console sets it. A design supplies just the *artwork layer*: `renderCoverPng` still typesets the
  real title with the OFL fonts, which is why nothing downstream — the `cover.jpg` path, the PDF
  cover page, the EPUB `cover-image`, the app's `coverImage` — needed a single change. The design's
  own `template` wins over the book type's `coverTemplate`, because a design was authored as a
  whole. `shouldGenerateCharacterReferences` gates on `=== "ai"` for the same reason a designed
  cover writes `costUsd: 0`: neither may spend on a cover nobody was charged for, and a bundled
  cover left unpriced would land in the Costs tab's `unratedCalls` bucket, which means *understated*
  spend.
- **A cover that cannot be drawn now finishes the book instead of failing it.** The cover is the
  last thing a book makes, so a total image-provider outage used to mark a fully written, fully paid
  project FAILED and refund `FULL_BOOK_GENERATION` — `generate-image` has no retry attempts
  (`jobRetryPolicy.ts`) and is not in `DERIVATIVE_GENERATION_JOBS`. `generateCover.ts` now catches
  anything that is not a `StopRequestedError` and renders a designed cover, recording
  `coverFallbackReason: "ai_cover_failed"`. The stop check is load-bearing: swallowing it would turn
  every user-cancelled run into a finished book.
- **The book is typeset against md-to-pdf's stylesheets, but nothing else of md-to-pdf's remains.**
  `generateBookPdf` no longer calls `mdToPdf()`. `pdfDocument.ts` deep-imports its `getHtml` and
  `defaultConfig` (the package has no `exports` map) so the markdown still goes through
  **marked@4.3.0** with `langPrefix: 'hljs '` — rendering it with this repo's own marked@18 instead
  changes heading ids, email mangling and loose/tight list `<p>` wrapping, which moves every page
  break in every book ever compiled. Everything md-to-pdf used to supply by *default* is now pinned
  by hand in `BOOK_PDF_OPTIONS` and `buildBookPdfDocument`: the `30/40/30/20mm` margins,
  `page_media_type: 'screen'`, and the cascade markdown.css → github.css → ours, which
  `RTL_OVERRIDES` in `pdfCss.ts` exists to undo the first sheet of. **The text block is set by
  `pdfCss.ts`, not by those margins** — `bookPdfCss` writes `@page { margin: 20mm 18mm 22mm }`, and
  Chrome honours that over the CDP parameters, so `BOOK_PDF_OPTIONS.margin` is measurably inert
  (identical page count and line width at 30/40/30/20mm, at 1 cm, and omitted). It is pinned for the
  day that `@page` rule is removed, and asserted by equality rather than through a render, because no
  render can see it. The dependency is pinned to an **exact** version and `pdfDocument.test.ts`
  asserts both stylesheets' sha256, because a bump is otherwise a silent re-typeset. When a digest
  fires, render the fixture corpus with `pnpm render:fixtures` (`scripts/render-book-fixtures.ts`,
  seven books covering both directions, CJK, illustrations, a cover and the dense Contents) on each
  side and diff them with `--compare`, which checks `Pages` first;
  byte-comparing PDFs proves nothing, since `/CreationDate`, `/ID` and font-subset ordering differ
  run to run. The old side is rendered by `--baseline <ref>`, never by stashing: it plants a
  throwaway worktree at that ref and copies the *current* harness in, because the change under test
  is routinely the one that adds the corpus, the `render:fixtures` script and the `packages/core`
  exports the harness imports — and because the fixtures are the control, a ref carrying its own
  copy of them would report its text as layout drift. Borrowed `node_modules` are this tree's, so a
  digest that fired *because* the `md-to-pdf` pin moved needs `--install` for the baseline to be
  rendered by the version it is being compared against. A page-count guard only works on **continuous prose**: a fixture with forced
  `page-break` divs pins its own count and reports the same number whatever the stylesheet says.
- **Chrome reads the book off disk; nothing crosses CDP.** The assembled HTML is written to
  `.book-render-<uuid>.html` inside `IMAGE_STORAGE_DIR` and opened with `page.goto('file://…')`, so
  the book's relative asset paths (`projectId/filename`) resolve to the real illustrations exactly as
  they did against md-to-pdf's static server. That is what killed the 174 s and 382 s exports: they
  lived in `addStyleTag`/`addScriptTag`, which take **no timeout**, and a legacy illustrated book
  shipped a ~27 MB `JSON.stringify`'d image map through one. Fonts must stay `data:` URIs — a
  `file://` `@font-face` src from a `file://` document is blocked by Chrome's opaque-origin rules.
  The temp file is not web-reachable: `/assets/images/:projectId/:filename` is a two-segment param
  route, not a static mount.
  **What that transport costs is the origin's protection, so the renderer carries an allowlist.**
  A page opened from `file://` may load `file://` subresources, and a manuscript is user text —
  imports arrive as raw prose, an exact-replacement edit writes literal text into a page, and
  markdown passes raw HTML through. `<iframe src="file:///etc/passwd">` in chapter one printed the
  server's password file into the exported PDF, reproducibly, and `/proc/self/environ` would have
  printed its provider keys; the HTTP-origin renderer this replaced refused that for free.
  `renderResourcePolicy.ts` intercepts every request the render makes and permits four things: the
  document this render wrote, `data:` (the fonts), `about:blank`, and non-dot files under the
  compiled project's own image directory — which is why `generateBookPdf` now takes a `projectId`,
  standing in for the `sendOwnedProjectAsset` check the file transport dropped. Everything else is
  aborted, **including `http(s)`**: an iframe of `169.254.169.254` prints the instance's cloud
  credentials the same way, and no legitimate book resource is remote. Interception covers
  navigations, frames, images, CSS `url()` and anything a script starts later, which is why it is
  the control and `stripEmbeddedDocuments` (`pdfDocument.ts`, which deletes
  `iframe`/`object`/`embed`/`frame`/`script`/`link`/`base`/`meta http-equiv` from the assembled
  HTML) is only the second lock. That strip runs on the *rendered* HTML, never the markdown, so a
  book about HTML keeps its `<iframe>` examples — marked has already escaped everything in a code
  fence by then. It is verified by rendering the seven-book fixture corpus with the policy off and
  on and diffing: pixel-identical, so the allowlist refuses nothing a real book asks for.
  **The same disclosure had a second door in the EPUB.** Both exports turn
  `/assets/images/<projectId>/<filename>` into a path on disk, and they did it with a copy of the
  resolver each; the filename group matches slashes, and only the PDF's copy checked containment, so
  `![x](/assets/images/p/../../../../etc/passwd)` packaged a server file into the reader's download.
  There is now one `resolveBookImageAsset` (`bookImageAssets.ts`), which decodes before it resolves
  (`%2F..%2F` is a separator) and returns null unless the result is exactly
  `<IMAGE_STORAGE_DIR>/<projectId>/<filename>` — the shape the HTTP route serves.
  **`<projectId>` there means *this* book's, which is a second option and not a wildcard.** Storage
  is shared, so containment only ever said "some project's illustration": a manuscript naming
  `/assets/images/<another-project>/page-3.png` — and manuscripts are user text — read another
  reader's artwork out of it. The PDF survived that by accident, because the renderer's
  `assetRoot` allowlist is already scoped to the compiled project; the EPUB reads the file itself
  and packaged it into the download, with no renderer anywhere to refuse it. So the resolver takes
  an optional `projectId` and compares it against the *resolved* first segment (after decoding, so
  `proj-1/..%2Fproj-2` is `proj-2`), `generateBookEpub` and `generateBookPdf` both pass theirs, and
  the PDF's markdown rewrite refuses what its renderer would have aborted anyway. Omitting it keeps
  the whole storage directory in scope, which is only right for a book belonging to no project —
  `scripts/render-book-fixtures.ts`.
- **One Chromium, many pages — and the reset paths are the point.** `browserPool.ts` is the only
  place that launches a browser (`generateBookPdf` and `renderCoverPng` both go through
  `withRenderPage`). It holds a `Promise<Browser>`, not a `Browser`, and clears it on `disconnected`
  *and* on launch rejection under a **generation counter**, so a stale event cannot evict a newer
  browser. The semaphore is **2**, deliberately below worker concurrency
  (`max(MAX_PARALLEL_PAGE_JOBS, MAX_PARALLEL_IMAGE_JOBS)`, 4 by default, env-tunable to 32, with no
  separate compile lane) — four large books in one Chromium is an OOM that takes all four down.
  Recycling after 50 renders **retires** the browser rather than closing it: it stops handing out
  pages and closes once its own last page comes back. Closing inline is only possible when no other
  render is in flight, and with the semaphore at 2 a busy worker always has one — so a close-now rule
  fires only when the pool is idle, which is exactly when recycling does not matter. That is why the
  count lives on the lease and not in a global.
  A disconnect is retried **once, inside `withRenderPage`**, so both callers get it: sharing a
  browser is what turned one crash from "fails the job that owned it" into "fails every render in
  flight", and the cover is where that bites hardest — `renderCoverPng` runs *outside*
  `generateCover`'s artwork fallback, and `GENERATE_COVER` is not in `DERIVATIVE_GENERATION_JOBS`, so
  an unretried disconnect there marks a finished, fully paid book FAILED and refunds
  `FULL_BOOK_GENERATION` because some unrelated compile crashed Chromium. One retry is the whole
  budget — `compile-export` gets no BullMQ-level retry, which would re-run final QA and re-spend real
  credits — and it is skipped when `closeSharedBrowser()` was what took the browser away, or a
  shutdown would launch a replacement and hold the process open. A watchdog timeout is not
  disconnect-shaped and is never retried. Anything passed to `withRenderPage` must therefore be safe
  to run twice. "Disconnect-shaped" means **`TargetCloseError` and nothing else**: puppeteer throws
  that from every path where the far end went away, and its parent `ProtocolError` is the generic CDP
  failure — including the protocol *timeout*, which would pay its whole budget twice. Matching the
  parent covered no case the child did not.
  **A render is leased a browser context, not a page, because the page is not what the manuscript
  is confined to.** `stripEmbeddedDocuments` deletes `<script>` but not the `onerror` on an `<img>`
  whose source `renderResourcePolicy` just refused — that handler is script a manuscript gets to
  run, and one `window.open` from it was a page the pool never leased, never counted against the
  semaphore and never closed. Verified surviving into later renders, still fetching, with no
  interception on it: interception is installed per page, so a page the document opened for itself
  has none. `renderOnce` therefore closes the whole `BrowserContext`, which takes the popups, the
  workers and the storage with it, and `discardStrayTargets` closes any target the content opens on
  sight — watching the *context*, so a popup opened by a popup is caught too, and so a
  `setInterval(window.open)` cannot pile up tabs for the watchdog's whole 90 seconds. What neither
  can stop is the *first* request of each opened window: Chrome reports a target once it exists, by
  which time its navigation is on the wire (`--block-new-web-contents` does not refuse it —
  measured). Closing that needs the document unable to run script at all, i.e. stripping inline
  `on*` handlers in `pdfDocument.ts`.
  Every close is **once and bounded**: a wedged renderer's `close()` never settles, so a
  second attempt would hang the exact case the watchdog exists to unstick. The outcome is acted on
  rather than discarded, and `"failed"` is not `"timeout"` — a rejected close means the target was
  already gone, while one that never settles is a renderer still holding a process. The latter
  **retires** the browser on *every* path, success included: ignoring it on the success path leaked
  pages into a long-lived Chromium (the pool's own accounting said they were gone) for up to fifty
  renders. Retiring rather than closing outright is what reclaims them without failing every render
  sharing that browser.
  **Retiring is a promise to reclaim, so a lease outlives every close it is waiting on.** The
  browser's own `close()` is no more bounded than the context's — puppeteer's CDP path sends
  `Browser.close` and then awaits the process's `exit` event with no deadline of its own — so
  dropping the lease and fire-and-forgetting that promise left a Chromium nothing in the process
  had a handle on: invisible to the idle sweep, to `closeSharedBrowser()`, and to anyone reading
  the code, but not to the container's memory. A lease is now `live`, `retired` or `closing` and
  leaves `leases` only when its reclaim settles, which is bounded end to end: five seconds for
  `close()`, then `terminateBrowserProcess` (`browserProcess.ts`) SIGKILLs the process *group*,
  then two seconds for the exit. The group — the negative pid — is what takes the renderers and
  the zygote with it, and it cannot name this process's own group by accident, because a group id
  is always its leader's pid and that pid belongs to our child. The exit check before it is the
  safety property, not an optimisation: a pid is ours only until Node reaps it, which is exactly
  when `exitCode`/`signalCode` stop being null. What survives even that is recorded rather than
  forgotten — `browserPoolStatus().abandonedProcesses`, which both `shutdown()`s log, and which a
  process that finally dies drops off. `closeSharedBrowser()`
  is wired into both apps' `shutdown()`, both render test files' `afterAll`, and `pnpm covers:preview`
  — a live `Browser` holds the event loop open, so without it vitest never exits. It is bounded for
  the same reason it is awaited in a signal handler: one wedged renderer used to hang the shutdown
  that was supposed to release it, until the supervisor's own SIGKILL left that Chromium reparented
  to init. Never `browser.process()?.unref()`; that orphans Chromium — killing it is the opposite,
  and the only thing that reclaims one. Production reaps it with tini
  (`ENTRYPOINT`), dev with compose `init: true`, because PID 1 is a shell that does not reap — and
  budget **two** pooled browsers in production, one per process.
  **Trapping SIGHUP is part of that wiring, not housekeeping.** Puppeteer's own handlers are off,
  so its only remaining net is an unconditional `process.on("exit")` — which a signal Node does not
  handle never reaches. A hangup (a closed terminal, an `ssh` drop, systemd reload) used to kill the
  API or worker mid-flight and leave Chromium alive, reparented to init and reaped by nobody, so
  both entry points and `scripts/start-production.sh` trap `HUP` alongside `INT`/`TERM`. Registering
  a third signal is also why the two `shutdown()`s are now once-only: a hangup is routinely followed
  by a TERM from the same supervisor. `scripts/tsx-dev.mjs` forwards a hangup as **SIGTERM**,
  because nodemon handles that and not `SIGHUP` — sent verbatim it dies and orphans the app holding
  the browser.
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
  **That budget belongs to the book, not to the screen, or it is no budget at all.** Watching a
  settled book with no PDF is what *queues* the repair, so the watch is a cost: every five-minute
  window a watcher is still awake for buys another whole Chromium compile of the same manuscript.
  `projectStatusProvider` is `autoDispose` and is rebuilt constantly — the saved-export card
  invalidates it every four seconds, the reader on open, the book screen on every edit — so a budget
  owned by that stream was handed back in full several times a minute, and its three-second poll ran
  for as long as a screen was open. `exportRepairWatchProvider`
  (`apps/mobile/lib/features/projects/data/export_repair_watch.dart`) holds one
  `ExportRepairWatchBudget` per project *outside* it, deliberately not `autoDispose`, and meters only
  the settled-with-no-PDF case: two minutes of watching by wall clock, then five minutes of standing
  down, so one "preparing" episode is one repair. Wall clock rather than a poll count, because the
  stream half is metered by the same budget and an SSE connection a proxy never closes ticks far
  faster than the poll. Standing down never blanks a screen — a rebuilt stream still reads and yields
  a status, it just does not start a poll loop — a live book is never metered, and a PDF that was on
  disk a moment ago and is gone now is an edit's rebuild, which gets the whole allowance however the
  last wait ended. The saved-export card keeps its own allowance because it also watches the EPUB,
  which the shared watch deliberately does not. The operator routes still render inline, through a single-flight
  helper keyed `projectId:format:contentRevision`: the console downloads via a plain link where a
  404 would just break the download. **That inline render publishes exactly the way a compile
  does**, and for the same reason — it runs for minutes against a project that is COMPLETE, which
  is the one state in which a reader may edit. The revision is in the key because an edit deletes
  the compiled files, so the request arriving a moment later found them missing for a *new* reason
  and must not be answered from the render already in flight; and the render goes to
  `.book-<uuid>.{pdf,epub}` and is renamed onto `book.pdf` only inside `publishRebuiltExport`'s
  transaction, which compare-and-sets `contentRevision` and requires COMPLETE or REVIEW_REQUIRED —
  the same two statuses a detached compile may publish over, refused for the same reason
  (`applyBookEdit` holds the pre-edit revision for as long as it is rewriting pages). Writing
  straight to `book.pdf` meant a render that started before an edit could land *after* the worker's
  recompile published and leave the book sitting finished with its pre-edit PDF until some later
  revision bump rebuilt it. A render that loses the claim publishes nothing and answers with
  whatever is on disk now, falling back to its own bytes — a stale download beats a broken link,
  but it may not become the book. It also passes `projectId` to `generatePdf`, so the renderer's
  file access is scoped to that book's own illustrations as it is in the worker.
- **A download says which compile answered it, because the URL cannot.** Every compile of a book is
  published over `book.pdf`, so the availability descriptor the app fetched with is a claim about
  what that URL held when the status was read — and the download most likely to be answered by a
  *newer* compile is the retry after an `EXPORT_NOT_READY`, which is the app being told a compile is
  landing. The app files those bytes under a `contentRevision` three times over (the reader cache,
  the "your edits are in" banner, every highlight and bookmark it stamps), so a stale descriptor made
  all three agree on the wrong book. Sizes cannot separate them: a presentation reprint, a re-applied
  edit and an undo all produce a book of exactly the same length. So every publication records the
  sha256 of what it installed beside it (`book.pdf.provenance.json`), under the revision it claimed
  — `publishCompiledExports` in the worker and `publishRebuiltExport` in the API, both inside the
  transaction that already holds the row lock, after the renames, and never fatally: a book on disk
  must not be failed and refunded because a hundred bytes of metadata could not be written.
  `readPublishedExport` (`packages/core/src/generation/exportProvenance.ts`) then resolves the bytes
  it read against that record and the mobile route answers with `X-Export-Provenance` and
  `X-Export-Content-Revision`. **The record is read on both sides of the file read**, because a
  publication landing in between moves the file and the record independently as far as the reader is
  concerned; a digest identifies one file, so either read may confirm, and only when neither does is
  the read tried again. **Nothing consults the project row to label bytes** — a row read after a file
  read describes whatever compile is current now, which is the same mistake one layer down, and an
  edit moves the row minutes before the compile that publishes for it. The three states are not
  interchangeable on the client: `exact` is a fact, `unknown` (no record — a file published before
  any of this) leaves the descriptor standing in exactly as it did before, and `mismatch` (a record
  describing other bytes, i.e. the file is being replaced under the read) permits no guess at all —
  `CachedExport.revision` is null, no manifest is written, and the next open fetches again. Only an
  exact revision may re-anchor markup (`CachedExport.exactRevision`), because that pass rewrites
  every mark's revision at once; a stand-in there would have the next pass trust marks it should
  re-search. And a cache entry *newer* than the descriptor is not stale, which is what a download
  answered by an unseen compile leaves behind — treating it as a miss re-downloads the book the
  reader is holding and announces an edit they already have.
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
  **Every scratch name in that scheme is built in one module, and swept by age from the same one.**
  A publication renders to `.book-<uuid>.{md,pdf,epub}`, parks each predecessor at
  `.book-superseded-<uuid>.<ext>` while it moves in, and a PDF render writes `.book-render-<uuid>.html`
  into the image store; every one of them is removed by a `finally`, which covers a thrown render, a
  lost claim and a failed publication — and covers nothing at all when the process does not get to
  run it. A SIGKILL, an OOM kill or an evicted container leaves the file for as long as the volume
  lives, invisible until storage fills. `exportTempSweep.ts` (`packages/core`) both *names* them —
  `pendingExportTempPath`, `supersededExportToken`, `renderDocumentTempPath`, used by
  `exportPublication.ts`, `pdf.ts` and the API's inline rebuild — and collects them, because a writer
  whose name drifts out of the sweep's pattern strands files nothing recognises and nothing fails.
  The collection is **age-based only, never a startup wipe**: a rolling deploy runs two workers, the
  API renders into the same project directories, and `make up` and `pnpm dev` share one storage
  directory, so "this process just started, therefore nothing here is live" is false in every
  deployment here. Quiet time is the only signal, which is why the minimum age is clamped up to
  `EXPORT_TEMP_MIN_AGE_FLOOR_MS` whatever the config says and defaults to six hours against a window
  that is really seconds — the file is written and published back to back. Nothing else is a
  candidate: the patterns demand the prefix, the literal `randomUUID()` token shape and the writer's
  extension, and the scan requires a regular file at both the dirent and an `lstat` and removes it
  with `unlink`, so a symlink wearing a scratch name is skipped rather than followed. The timestamp
  is read **twice**, on either side of a decision the whole directory scan could otherwise sit in,
  and `ctime` counts alongside `mtime` because a writer can backdate one and not the other; ENOENT is
  not an error but the other end of the race working. `startExportTempCleanup`
  (`apps/worker/src/runtime/`) is the only thing that runs it — one collector reaches every orphan
  because the volume is shared, and the sweep is age-based rather than ownership-based precisely so
  it can clean up after the *other* process. It is bounded (an entry budget, a per-root cap and a
  resume cursor) and single-flight, and `shutdown()` stops it **before** `worker.close()`: a scan
  holds an open directory handle and has no job to finish, so it is cancelled through the signal it
  checks between entries and awaited, rather than left running into `prisma.$disconnect()`.
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
- **Two things decide whether a cover design reads, and neither is visible in the code.** Each
  template darkens the half its text panel sits in — science and business blacken the *top*,
  kids/fiction/romance the *bottom* — so a motif that centres its subject where the type goes is
  simply invisible; that is what `FOCUS_BY_TEMPLATE` in `coverDesignArtwork.ts` exists for. And
  every mark is seen through that scrim, so painting in `ground` at low opacity disappears. Render
  the catalog with `pnpm covers:preview` and look at the contact sheet before trusting a palette or
  a motif change. Seeding is off the design id, not the project, so re-rendering a book keeps its
  cover.
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
- **A cited source is stored as the publisher's own address, never Google's.** Search grounding
  hands back every citation as a `vertexaisearch.cloud.google.com/grounding-api-redirect/...`
  wrapper: it names Google as the source in the chat, and it expires — fatal for a Sources list
  recompiled from `ResearchSource` rows forever. `GeminiResearchAdapter.search` unwraps at ingest
  (`packages/core/src/adapters/groundingRedirect.ts`), which is the only moment the wrapper is sure
  to still resolve, and `researchCitationsForExport` retries at compile time for rows written before
  that, writing the fix back. An unresolved wrapper is kept rather than dropped — a worse link still
  beats a missing citation — and the app's `displayHost` names no publisher for one. That retry
  lives in `packages/db` because **two** processes compile a book: the API renders inline when a
  compiled file is missing, and its own copy of the citation map skipped the unwrap entirely, so
  the same book's Sources list named Google or the publisher depending on which side rendered it.
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
- **A book only earns the word "Chapter" by being long enough to need it.** The planner is told to
  make its chapter targets sum to exactly `targetPages`, so a three-page book gets three one-page
  chapters — a good *writing* scaffold, three distinct beats, and an absurd thing to print as
  "Chapter 1" over three paragraphs plus a Contents page costing a quarter of the PDF.
  `chapterPresentationFor` (`packages/core/src/generation/markdown.ts`) sizes the apparatus to the
  finished book instead: `chapters` (numbered headings + Contents), `sections` (the titles alone,
  no Contents — the default style becomes `title_only`), or `none`. Read it off the partition that
  is *about to be printed*, never off `plan.chapters`, which is why one test now covers both the
  plan's chapters and model-written reader chapters — the plan-side guard it replaced had a floor
  of four chapters, so a three-page book cut into three could never trip it. An explicit
  `mediaSettings.chapterHeadingStyle` still outranks all of this; only the default is sized.
  The narrator asks the same question through `narratedChapterLabel`
  (`apps/worker/src/handlers/generateAudiobookSupport.ts`) and drops the spoken label — but it must
  never re-partition, because `chapter-<n>.mp3` and the READY-skip that resumes a failed narration
  are keyed on chapter index.
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
- **A non-null `ProviderCallLog.costHint` *is* a settled, priced call.** Provisional, in-flight and
  failed rows all write `null` (`apps/worker/src/providers/usageAccounting.ts`), so real provider
  spend is `SUM("costHint")` — do not replay the rate cards in `packages/core/src/costs.ts` to
  aggregate it. Rows the rate card could not price are counted separately rather than dropped, so
  the total is never quietly short. `calculateProjectCostSummary` still recomputes per project,
  because it also folds in image costs from `ImageAsset` when the log side is thin.
- **Nothing joins a provider call to the charge that paid for it, so the Operations tab derives it
  three ways.** `apps/api/src/admin/operationEconomics.ts` reads the charge off the job's *payload*
  (`billingLedgerEntryId`) — not `CreditLedgerEntry.generationJobId`, which is set on a minority of
  entries and loses most of the spend — then walks `planId` to reach the fan-out children a run
  charged for, then falls back to a `JobType → CreditOperation` map **gated on operations the
  project was actually charged for**. That gating is the whole safety property: an operator-console
  book has no charge, so its jobs stay unbilled instead of inventing revenue. Whatever is left is
  reported as unbilled spend split by reason, never netted into a margin and never dropped — the
  two must add up to the Costs tab's total. `VOICE_CALL_MINUTE` shows 100% margin honestly and
  wrongly, because the app holds its own socket to Gemini; that is what `OPERATION_NOTES` is for.
- **A costless call has four different causes and the Costs tab splits all four.**
  `apps/api/src/admin/costBreakdown.ts` partitions every logged call into priced + failed +
  in-flight + estimated + unrated, because only `unratedCalls` — settled on real tokens that no rate
  card could price — means the dashboard is *understating* real spend; the other three are
  nothing to fix. Usage is summed over priced calls only, so tokens and dollars always describe the
  same set of calls and a missing rate card cannot flatter the tokens-per-dollar figures. Unrated is
  a text-only signal by construction: `recordProviderImageCost` and `recordProviderAudioCost` return
  early rather than write a row they cannot price, so an unpriced image model leaves no trace at all.
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
- **A library character reaches a book by copy and by name, never by foreign key.** The
  account-wide `LibraryCharacter` table is the user's; at build time the active branch's
  @-mentions are snapshotted into `mediaSettings.mobile.characters`
  (`libraryCharacterSnapshotsForBuild` in `apps/api/src/mobile/creationBuild.ts`), and everything
  downstream — the planner guidance in `planner.ts`, the prompt block in
  `composeMobileProjectPrompt`, the reference-sheet seeding — reads that copy off the input
  snapshot. The plan schema strips unknown keys, so the **verbatim name** is the only link from a
  plan character back to its portrait: `matchLibraryCharacter`
  (`packages/core/src/generation/libraryCharacters.ts`) tries folded exact equality then
  **whole-token** containment, and a rename by the planner degrades to an unseeded sheet, never an
  error. Both halves of that are scars. Everything is compared through `foldCharacterName` (NFD
  then strip marks, drop ZWNJ/ZWJ/bidi, fold Arabic kaf/yeh onto Persian, fold Arabic-Indic
  digits) because a Persian name saved from one keyboard and echoed by a model trained on the
  other was two different names; and containment is whole-token because sub-token matching put one
  reader's saved face on a character they never saved — `Sam` seeded `Sam's Mother`, `Luna` seeded
  `Luna-Bear`, and ZWNJ is category `Cf`, so the old `[^\p{L}\p{N}]` boundary read `علی‌رضا` as a
  word break and matched a library `علی`. An **ambiguous** containment resolves to null: a missing
  seed is a character drawn from prose, a wrong one is a stranger wearing the reader's face, and
  only one of those is recoverable by reading the book. Deleting
  a character deletes rows and files but no book state; a seeding pass that finds the portrait
  file gone skips it silently, which is the deletion-safety valve. Character files live at
  `IMAGE_STORAGE_DIR/characters/<userId>/` — never swept, unreachable from the project asset
  route and the render allowlist — and every path to them resolves through
  `libraryCharacterDiskPath`, which returns null for anything but exactly `<userId>/<fileName>`.
- **A character's look lives in pixels, so it has to be written down or the planner invents one.**
  `LibraryCharacter.description` is who the character is — free text the reader writes, routinely
  carrying no appearance at all ("she's a great wife and future mother") — while what they *look
  like* existed only in the portrait, which the planner is a text model and never sees. Told to
  reuse a character it could not picture, it invented a look, wrote it into
  `illustrationPlan.characterReferencePrompts` and every page prompt, and **that text beat the
  reference images attached beside it**: a woman in a black hijab was rendered as a bare-headed
  child in a ponytail, on a page whose prompt did not even use her name. So there is an
  `appearance` column, read off the picture by the same bounded vision call the photo upload
  already makes, snapshotted beside the name, and printed by `libraryCharacterPromptBlock` as its
  own labelled line under its own budget — truncating a look is not a shorter sentence, it is a
  licence to finish the outfit. `libraryCharacterAppearanceRule` then says the only two honest
  things: with an appearance recorded, reuse it word for word; **without** one, write no hair,
  age, build, headwear or clothing anywhere and refer to the character by name only, because the
  picture is attached to the image calls and invisible to the writer. "Invent something
  consistent" is the instruction that caused this.
- **Nothing used to check that the planner obeyed, and now one pass does.**
  `reconcilePlanLibraryCharacters` (`packages/core/src/generation/planLibraryCharacters.ts`) runs
  after **every** plan parse — `createPlanningPackage` and `revisePlanningPackage` both — and
  renames a matched character back to the verbatim name, restores the library's own description
  over the schema placeholder (`"Recurring character in the plan."`, `schemas/plan.ts`), sets
  `visualRules` from the recorded appearance or leaves them empty, re-appends a snapshot character
  the plan dropped, and collapses two entries that resolve to one snapshot. It is what turns
  translation, rename, near-duplicate and invented-twin from silent wrong output into a no-op.
  Revision needed it most: `mobileLibraryCharacterGuidance` was called from the initial planner
  **only**, and `revisePlanningPackage` serialized no `userInput` and no `mediaSettings` at all, so
  any "make it shorter" after approval re-decided the saved character against nothing. Arrays merge
  as atomic replacements, so whatever came back won.
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
- **A reference-sheet filename must survive a non-Latin name.** `characterSlug` stripped everything
  outside `[a-z0-9]`, so every Persian, Cyrillic and CJK name emptied out and `safePathPart`
  returned the literal `"unknown"` — three characters in one book all wrote
  `character-reference-unknown.jpg`, and because `hasReferenceForEveryCharacter` compares *names*
  the set looked complete and was never rebuilt, so the whole cast wore whichever face rendered
  last. It now hashes the folded name when the ASCII slug is empty, and
  `characterReferenceFileStems` resolves the **whole cast's** stems together before the concurrent
  renders start, since a per-name slug cannot promise cast-wide uniqueness. The ASCII path is
  byte-for-byte unchanged so no existing book's files move.
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
- **The portrait job is the one `GenerationJob` with no project.** `GENERATE_CHARACTER_PORTRAIT`
  runs with `projectId` null, which is why that column is nullable: every project-scoped query
  (stop, settlement, status, `failureMessage`) simply never sees the row, and
  `staleGenerationJobReason` still runs its CANCELED-row and settled-attempt checks before the
  project section it skips. Failure settles through the attempt boundary plus
  `failCharacterPortraitForJob` in `runtime/jobLifecycle.ts`, which flips the `LibraryCharacter`
  row FAILED and touches nothing else; the row's QUEUED/GENERATING claim in
  `POST /api/mobile/characters/:id/portrait` is what makes a second start a 409 rather than a
  second charge.
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
- **The Flutter creation chat screen is one library split with `part` files**
  (`creation_chat_screen.dart` plus `creation_chat_*.dart`). Part files have no imports of their
  own; add imports to the parent. This keeps the `_Private` widgets private. The @-mention
  affordance (`creation_chat_mentions.dart`) derives its state from the composer text alone —
  clearing the composer clears the mentions — and one strip serves both chat stages because the
  composer does.
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
- **Narration fails in three provider-shaped ways, and all three guards are load-bearing.** One bad
  chunk used to lose the whole audiobook. (1) The TTS model answers a bare `400 INVALID_ARGUMENT`
  for a handful of ordinary passages *only* when the style prompt is prefixed to them — either half
  alone is accepted, and it reproduces exactly — so `GeminiSpeechAdapter.synthesize` reads a refused
  chunk again without the direction and flags `stylePromptDropped`. (2) A per-minute speech quota
  makes 429 the normal case rather than an outage, so `ProviderHttpError` carries the status as a
  *field* — a status that appears only inside the message text matches none of
  `isRecoverableNetworkError`'s patterns and would never be retried — along with the `retryDelay` the
  response names, which `withRecoverableNetworkRetry` waits out instead of backing off blindly —
  but only up to `PROVIDER_RETRY_AFTER_CEILING_MS`. A cooldown longer than that is the *daily* cap,
  not the per-minute one, so `isRecoverableNetworkError` calls it unrecoverable and every layer
  gives up at once rather than spending its whole budget failing the same way.
  (3) `synthesizeChunks` stops its siblings on the first failure: `Promise.all` rejects but cannot
  cancel, and workers left running narrate the rest of a chapter nobody will keep, spending the quota
  the *next* attempt needs.
- **Restarting a failed narration resumes it; that is a property of the route, not the worker.** The
  worker has always skipped READY chapters, but `POST /api/mobile/projects/:id/audiobook` used to
  delete and recreate the `Audiobook` row every time, so the skip never had anything to skip. It now
  reuses a FAILED row when the voice and `contentRevision` still match — any other change is a
  different audiobook and starts clean. The dedupe key names the run being resumed, because reusing
  the audiobook id alone would match the failed job's row and enqueue nothing at all.
- **The app plays local files, not a URL, and draws one timeline over many of them.** Chapter audio
  is downloaded into `tomeza_audiobook/<projectId>/<audiobookId>/` because the media session keeps
  playing when the app is backgrounded, where a token refresh cannot be relied on. Every chapter has
  a length from the moment it is planned — `estimatedDurationMs` until it is narrated,
  `durationMs` after — which is what lets the seek bar show the whole book while the back half is
  still being made. Lock-screen artwork must be a `file://` URI: the media session fetches it
  outside the Dio client and without the bearer token.
- **The listening position is device-local, book-global, and stamped with the narration it belongs
  to.** `AudiobookProgressStore` writes `tomeza_audiobook/<projectId>/progress.json` — beside the
  audio rather than inside one narration's directory, so `pruneOtherAudiobooks` (directories only)
  leaves it and `clearProject` takes it. It stores a position in the *whole book*, never a chapter
  offset, because the chapter a position falls in shifts as later chapters are narrated. The
  `audiobookId` is the reset: `_restorePlace` deletes a position saved against any other narration
  instead of using it, since re-narrating replaces the audio and the old number would land somewhere
  plausible and wrong — `narrate()` also clears it outright. It is saved every 5s while playing and
  forced on pause and teardown, because the ordinary end of a session is the OS killing a
  backgrounded app, where nothing gets to run. Restoring is *silent and deferred*: chapters download
  in book order, so `_applyResumeIfReady` waits for the one holding the position and seeks then —
  and `togglePlay`/`seekGlobal` drop the pending resume, because a play button that moves you
  somewhere else a moment later is worse than not resuming at all. `narrate()` must also
  `_resetPlayback()`: the queue is read positionally against the manifest, so appending a new
  narration's chapters to the old queue plays the wrong chapter rather than failing.
- **just_audio's `playing` means the play button is engaged, not that sound is coming out.** It
  stays true when the queue reaches the end of the chapters that exist, so `AudiobookPlayer.playing`
  and `playingStream` fold `ProcessingState.completed` back out — that derived value is what the
  play button renders. Papering over it in the controller instead (forcing `playing: false` when
  `completedStream` fires) desynchronises the two: seeking back into narrated audio resumes the
  player on its own, and because its own `playing` never changed it has nothing to announce, so the
  button sits on Play over audible narration. For the same reason Play cannot mean `play()` when
  the queue has finished — that is a no-op on silence — so `togglePlay` moves to the next chapter
  that has been downloaded since, and `caughtUp` says why playback stopped where it did.
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
