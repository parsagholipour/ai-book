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
6. Anything that starts AI work asks the spend breaker (`requireAiCapacity` / `assertAiCapacity`
   in `aiCapacity.ts`) after any replay and before the first reservation, slot claim or limiter
   hit — "AI spend breaker" in `../../CLAUDE.md`.

Route groups are registered **directly on the same Fastify instance**, not via `fastify.register`,
so they share one encapsulation context — the `application/octet-stream` parser registered there
covers the attachment upload routes. Moving to `register` would break that.

## Serializers are the API contract

The three `project*Serializers.ts` modules decide what the app sees: summary/detail metadata,
status/progress/recovery, and plan/image/asset/export artifacts. `projectSerializers.ts` is only a
compatibility façade. Provider names, model ids, raw queue state and internal error text stay out
of mobile responses; the `serialize*` functions in the owning modules and
`sanitizePublicChatMetadata` in `projectChat.ts` enforce that. Widen them deliberately, not by
spreading a row. Note the leak guard rejects any wire key containing "model", which is why the app
reads a `qualityPreset` rather than a `modelTier`.

- **An image URL carries its version, because a redrawn cover keeps its path and a replaced
  picture keeps its row.** Every image URL sent to the app — `serializeImage` (covers, page
  visuals, character portraits) and the Studio's `cover.imageUrl` (`loadManuscriptCover`) — ends in
  the `?v=` from `versionedImageAssetUrl` (`support.ts`), a digest of the `ImageAsset` row's id and
  its stored `path`. The Flutter image cache keys by URL, and so would any HTTP cache under the
  routes' `private, max-age=300`. Before this, a drawn cover (always `cover.<ext>`) kept the
  Studio's bare path across every redraw, so the app showed the old picture. A chat picture
  replacement keeps its row and points it at a new file, so `/assets/:assetId` kept naming the old
  bytes. The key needs both halves: `generateCover` and every Studio cover change delete and create
  the COVER row over one file, while replace, undo and redo keep the row and swap `path`. Metadata
  stays out on purpose, because a move or a keeper-token rebind rewrites it without touching a
  byte. A writer that rewrites an image's bytes must therefore mint a new row or a new filename:
  overwriting a file under a row that stays is the one write this version cannot see.
  (`generateCover` puts the file before it swaps the row, so a swap that fails leaves the old row
  over new bytes. That window is rare and not closed.) The routes ignore the query and authorize
  as before, and the app uses the URL exactly as it arrives (`cacheBuster: null`). That is why the
  Studio's per-session cover epoch is gone.

- **A failed book says which step failed, and says its credits came back only when the ledger
  does.** `failureMessage` used to be `We hit a problem while ${phase}: ${error}` with the job's
  raw `GenerationJob.error` — the worker's `errorMessage(error)`, so a provider's 429 body, a
  Prisma code or a model id reached the reader (launch review H4, 2026-10-13).
  `failureMessageForJob` (`projectFailureCopy.ts`) now sends the phase sentence alone, and the raw
  text only when it is one of the sentences written for the reader (`READER_FAILURE_SENTENCES`:
  core's `editFailure` copy and the import handler's two) — an allowlist, so a sentence reworded
  where it is thrown falls back to the phase sentence rather than leaking. The column itself is
  unchanged: the operator console and the logs still read it. "Credits for this attempt were
  returned." is appended only when `attemptChargeReturned` reads the failed job's attempt as
  FAILED or CANCELED, not `refundPending`, and its charge released (`REFUNDED`) or reversed in
  full — presence of a reversal is not enough, it may be partial. An attempt-less row, a pending
  or partial refund and a read that fails all say nothing about credits; a curated sentence that
  already mentions credits is not told twice. `loadSerializedProjectStatus` makes that one read,
  for the same row `currentOwningFailedJob` reports. `projectFailureCopy.test.ts` pins it.
- **A status stream sends what changed, proves it is alive with a comment, and answers to the
  session it was opened with — three to an account.** `GET …/status/events` re-read the whole
  status (about nine queries, a HEAD per export format, an entitlement read) every second for
  every open stream, wrote it whether or not it changed — and each write rebuilt the app's chat
  screen — had no cap per account, and checked auth only at connect (launch review, 2026-10-13).
  Now it polls every 3 s and writes an `event: status` only when the serialized status differs
  from the last one sent; a `: ping` comment line every 15 s proves the socket (the app's parser,
  `_decodeServerSentEvents`, skips comment lines, so a client's idle timeout must be measured on
  received bytes or lines, never on yielded events); every 60 s it re-runs
  `verifyMobileAccessToken` on the token it opened with and ends on a revoked session, a disabled
  account or an expired token. That end is `event: error` with `STATUS_STREAM_SESSION_ENDED`,
  never `SESSION_REVOKED`: an ordinary refresh revokes the session row its old token belongs to,
  so a client that signed out on it would sign out every 15 minutes — the next HTTP request is
  what decides. An account holds `STATUS_STREAMS_PER_USER` (3) per process; a fourth *ends the
  oldest* with `STATUS_STREAM_REPLACED` rather than refusing the new one, because the app opens a
  stream per screen and the newest is the screen in front of the reader
  (`statusStreams.ts`). Every `error` event is informational: the app ignores events that are not
  `status`, and a stream that ends while the book is live drops to its three-second poll. And
  `loadSerializedProjectStatus` skips the export HEADs while the book is PLANNING or GENERATING
  (it cannot have gained a file; the push sweep reads the same function every 15 s), reporting
  every format unavailable — EDITING keeps them, since the reader is still reading its file.
  `statusStreams.test.ts` drives real sockets.
- **A time-left estimate is seconds left, rounded so the stream does not churn, and null whenever
  a number would be a guess.** Asked for on 2026-10-17 ("Est remaining time when the book/plan is
  being generated"). `planningProgress.estimatedSecondsLeft` and
  `generationProgress.estimatedSecondsLeft` (`generationEstimate.ts`) are seconds, never a
  finishing time, because the phone's clock may be wrong and the app counts down on its own
  between statuses (`TimeLeftNote`, `apps/mobile/lib/features/projects/CLAUDE.md`). The number
  blends the schedule — a typical run less the time this one has run — with, once a fifth of the
  run's bar is behind it, the pace (the time so far stretched over the bar that is left); never
  under 20 s while the work runs, never over three typical runs. A plan is timed from its open
  job's `startedAt`; a book from its open `FULL_BOOK_GENERATION` attempt's, which is stamped once
  at the first claim and stays open until the compile publishes — the book job's own stamp moves
  on every reclaim, and the job can fall out of the status read's 25-row window. The book's
  fraction is measured from `BOOK_PROGRESS_START` (20, `generationProgress.ts`), where its share of
  the bar begins, so a run that has just started is not read as a fifth done. *Typical* is
  measured: the last 30 days of finished first runs, one raw query per ten minutes per process,
  single-flight. Each run is divided by the compiled model for its own tier, pictures and length
  (`modelSeconds`, dev's timings of 2026-10-17), and the median ratio over the narrowest pool with
  five runs — same tier, pictures and page bucket (≤12, 13–40, 41–80, 81+), then without the
  bucket, without the pictures, without the tier — scales this book's model. Ratios rather than raw
  durations, so a widened pool does not hand a 60-page book the median of the 10-page books it was
  pooled with. **The rounding is the stream's rule**: up to the next 30 s under ten minutes and the
  next minute above, so the value moves about twice a minute at most — `…/status/events` writes
  only a status whose JSON changed, and an unrounded number would send one every three seconds.
  **Null is the honest answer**: a book waiting in line, work queued and not started, a paid retry
  (it resumes part-way, so its clock started late against a bar that did not start at the
  bottom), a run past its schedule with under a fifth of its bar done, and anything stopped,
  failed, finished or an edit. A settled or waiting book costs no read for it. A failed history
  read uses the model alone and is asked again a minute later; a failed attempt read answers null;
  neither fails the status, and both log at error level. The push sweep needed nothing: its loader
  reads only `progressPercent` and `currentAction`, so a moving estimate sends no extra push. The
  key has no "model" or "queue" in it, for the leak tests' sake. `generationEstimate.test.ts`,
  `generationEstimateStatus.test.ts`.

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

Its `$transaction` mock rolls nothing back — there is no store to roll back — so it **accounts**
instead: each interactive transaction records the options it was handed, the writes issued through
the `tx` client it handed out, and whether the callback threw, and `survivingWrites()` reads those
back as the statements a database would still hold. That is how a rollback claim is asserted here
(`characterWriteRollback.test.ts`). Attribution is by client rather than by wall clock on purpose:
a callback reaching for the imported `prisma` instead of its `tx` lands on no record and is
reported as surviving, which is the escape a rollback-capable mock could not simulate.

## Index

- [Billing surfaces](#billing-surfaces)
- [The edit chat router](#the-edit-chat-router)
- [Export repair and the quality verdict](#export-repair-and-the-quality-verdict)
- [Free presentation edits](#free-presentation-edits)
- [Characters](#characters)
- [Voice and audiobook routes](#voice-and-audiobook-routes)
- [Writing Studio](#writing-studio)
- [Book notes](#book-notes)
- [Book sharing](#book-sharing)
- [Reporting AI output](#reporting-ai-output)

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
- **A subscription token is granted only for the plan its own line items name, and the server
  acknowledges what it records.** Google's subscription endpoint (`subscriptionsv2`) is keyed by the
  token alone, and the verifier fell back to the first line item when none matched the SKU the app
  sent — so a Creator token posted as Max was granted Max, and the hourly renewal sweep kept granting
  it (2026-10-03 launch audit). `mapSubscriptionPurchase` (`googlePlayBilling.ts`) now throws
  `GooglePlayProductMismatchError` (400 `GOOGLE_PLAY_PRODUCT_MISMATCH`); one-time products were safe,
  because their endpoint takes the product id. Acknowledgement used to be the app's alone, after the
  server had granted the credits, and Play refunds anything unacknowledged after three days — an app
  killed in between kept the credits and lost the payment. The verify route now acknowledges a
  grantable purchase Google still reports pending (`purchaseNeedsAcknowledgement`), best-effort and
  idempotent on Google's side; the app still consumes credit packs. Refunds now arrive at
  `POST /api/billing/google-play/rtdn`, authenticated with Google's Pub/Sub OIDC token. Full refunds
  reverse the original grant; spent credits remain a negative purchased balance. Partial refunds use
  Google's remaining quantity, and ordinary cancellation keeps the paid period. Refund markers and
  purchase grants share serializable transactions so duplicates and late claims cannot restore credits.
  Setup and retry behaviour: `docs/google-play-rtdn.md`.
  The one product a token may be verified as besides its own line item is a deferred downgrade's
  target, because Play files that token under the replaced plan until it takes effect
  (`packages/db/CLAUDE.md`).
- **A blank order id is no order id.** `in_app_purchase_android` hands over a purchase Google has
  not given an order id yet — a slow card still pending, a promo-code redemption — as `''`, and the
  verify body took `transactionId` as `min(1)` in a `.strict()` object, so that purchase answered
  400. That was the app's "record the pending purchase" step failing quietly: nothing recorded the
  token, nothing acknowledged it, and Play refunded a paid purchase three days later (pre-launch
  review H5). `mobileGooglePlayVerificationBodySchema` now reads a blank (or null) `transactionId`
  as absent, its JSON-schema copy accepts it, and the app sends one only when it is non-empty, so
  every installed build and every newer one both work. The same body takes `localPriceMicros` +
  `localCurrency` (both or neither, analytics only — `packages/db/CLAUDE.md`). `billing.test.ts`.
- **The renewal sweep wakes at every month of a paid period, a check that grants nothing is pushed
  back, and a deleted account is never renewed into.** A plan's allowance is granted a month at a
  time (`packages/db/CLAUDE.md`): the yearly plan's 6,000 every month, and the months of carried
  time a plan switch adds to a period. Google says nothing at a month boundary inside a period it
  was paid for, so the recording path sets `nextCreditGrantAt` to the next month's start while the
  period has months left — or, for a deferred downgrade, to the old plan's next paid month on the
  new token's row — and `runSubscriptionRenewalSweep` (`src/subscriptionRenewal.ts`) is what grants
  months two to twelve, one grant per order and month however the app's verify and RTDN race it.
  It takes the 25 oldest-due rows an hour, and a check that failed, found the subscription paused or
  on hold, or found Google had not renewed yet used to leave `nextCreditGrantAt` in the past — so 25
  stuck rows came first on every pass and starved every real renewal behind them. Each such check
  now moves the row to `now + clamp(overdue / 2, 1 h, 24 h)`, overdue counted from the period end
  Google last reported, which a recheck does not move, so the wait grows on its own: a renewal
  Google is slow to report is asked about within the hour, a subscription paused for months once a
  day, and a month inside a paid year — nothing overdue yet — within the hour. A month the app
  already granted grants nothing here, and the recording has already moved the row to the next one.
  The write only ever moves the date forward and never from null, so a recording that expired the
  row or set a new period end wins. A paused or on-hold subscription with Google's `autoResumeTime`
  is due then instead (on hold is recorded as `PAUSED`; as `INACTIVE` it had dropped out of the
  sweep for good). The query skips a deleted account (`DISABLED`): its subscriptions are cancelled
  by the deletion sweep (`apps/api/CLAUDE.md`), and a renewal that slips through has nobody to grant
  to. A suspended one is swept, because Google keeps charging it. `subscriptionRenewal.test.ts`, and
  the db package's `subscriptionYearlyPlan.test.ts`, which drives the real recording path the way
  the sweep does.
- **The free tier's illustrated-book limit is claimed at plan approval, chat `add_image`, and illustrated rebuilds.**
  `POST /api/mobile/plans/:id/approve` claims the `UsageCounter` slot for a
  generation planned with images (403 `IMAGE_LIMIT_REACHED` when it is gone — never a silent
  downgrade to text-only), and the chat `add_image` Apply claims one when it is about to make a
  *text-only* book illustrated — only then, and only when the recomputed cost is above zero: an
  already-illustrated book spent its slot at approve (or at a prior `ADD_IMAGE`, which the
  predicate counts even after an undo), and a zero-priced image writes no ledger entry to carry
  the claim, so a failure would leak the slot for good. Each claim is stamped onto the
  reservation as `metadata.imageQuota`, so `refundCreditLedgerEntry` hands the slot back on every
  failure path without each of them knowing about quotas — which is why the confirmed `/resume`
  retry lane, which re-charges a failed attempt, also re-claims: for a `FULL_BOOK_GENERATION`
  or `BOOK_REPLAN` retry priced with interior images, and for an `IMAGE_GENERATION` retry whose payload carries
  `imageInsertion`, through the same `addImageQuotaLimit` decision the original Apply used.
  A chat replan creates a **new book**, so a priced `queueChatBookReplanCopy` claims a fresh slot
  even when the source already has illustrations. The requested settings determine the claim: rebuilding
  without interior illustrations claims nothing, and a cover alone does not count. The claim,
  charge, copy, and job share the generation-attempt transaction; a refusal creates no copy and
  returns a fresh Apply card for an upgrade or the next period. A failed rebuild refunds its slot;
  confirmed retries re-claim from the copy's settings, including retries of downstream page jobs.
- **A generated book's length is a rule asked at every door that starts generating one, not a
  quota: the free tier's limit first for a free account, and a ceiling every plan shares.** A free
  account gets books of up to `freeMaxBookPages` (30, operator-tunable at `/pricing`); longer is a
  plan perk, up to `paidMaxBookPages` (200 at launch, 30–600) — the longest book *any* account may
  have generated until a long illustrated compile is measured on the production host (launch
  review, 2026-10-13; the schemas' own `max(600)` sits above it). `bookPageLimit.ts` owns the check
  (`pageLimitRefusal`), both sentences and both 403 bodies, which share
  `pageLimit: { limit, requestedPages, maxPages }` — so a route that *declares* its 403 must use
  `pageLimitExceededError`, or the serializer ships the sentence without the numbers. **The ceiling
  is asked first**, before the plan read, so a free account asking for 300 pages is told nothing
  that long is available rather than sold a plan that would refuse it too. The two refusals are told
  apart by their code because the app answers them differently: `PAGE_LIMIT_EXCEEDED` (`kind:
  "free"`, `maxPages` = the ceiling) opens the long-book offer, while `BOOK_LENGTH_UNAVAILABLE`
  (`kind: "ceiling"`, `limit` = `maxPages` = the ceiling) is a sentence with nothing to buy — every
  shipped app shows an unknown code's message, and `pageLimitFromError` reads only the first code, so
  an older build never offers a plan for it. The doors: the creation Build and `/projects/:id/plan`
  (before planning is charged, on the built input's `targetPages`, which covers a legacy draft's
  book-type default), plan approval and the paid full-book `/resume` (the authoritative two — a plan
  sized while subscribed is refused once the plan lapses), and the chat's `book_replan`,
  `continue_book` and `restructure_pages`, gated at the proposal and again at Apply. Past the free
  limit the reply says why, the priced card still follows and `metadata.pageLimit` draws the unlock
  row, and Apply answers like `imageLimitChatMessage` with a fresh resume pair so the card's Apply
  works once they upgrade. Past the ceiling the reply is the sentence alone — no card, no
  `pageLimit`, the pending edit closed (`pageCeilingChatReply`) — because no plan and no Apply could
  run it; a card quoted before an operator lowered the ceiling gets the same reply at Apply. Nothing
  is claimed, so a refusal has nothing to hand back. Only *generation* is held to it: an author's or
  imported book is theirs at any length, a page change is refused only when it makes the book longer
  (`restructuredBookPages`), and deleting from or rewriting a long book stays open — but continuing
  or inserting into a long import *is* generation, so it is refused once the result passes the
  limit that applies. The model's page-count recommendations are offered only at or under the
  ceiling (`normalizePageCountRecommendations` falls back to the deterministic ones otherwise), and a
  share remix copies a longer book's format at the ceiling. The preflight's `maxPages` and the
  billing payload's `maxBookPages` (the free cap, null on any plan) and `paidMaxBookPages` (the
  ceiling, every account) are how the app locks the free lengths and stops its pickers at the
  ceiling before anything is sent.
- **A new book may not start on Ultra while the operator has it switched off, and a book already
  on Ultra keeps it.** Ultra is unmeasured on today's routing — its one measured run failed and cost
  $8 — so it launched hidden behind `ultraTierEnabled` (a non-price key in the price list, default 0,
  outside `CREDIT_PRICE_KEYS`; edited at `/pricing`, "Generation limits"). The billing payload ships
  it as `ultraTierEnabled` and the app's Effort picker drops Ultra while it is false; the server does
  not trust the picker. `ultraTier.ts` owns the rule and the one sentence (422
  `QUALITY_TIER_UNAVAILABLE`, which every installed app shows as it shows any refusal), asked where a
  book *starts*: the creation Build, its preflight and the legacy create (`prepareMobileCreationBuild`,
  on the presets' tier, before the breaker and the advisor's calls), a draft created directly
  (`POST /api/mobile/projects`, free, but one that could never be planned), the first plan of a draft
  (`queueInitialMobilePlan`, inside its replay check, as `UltraTierUnavailableError` answered by
  `sendGenerationAttemptError`) and plan approval (never its replay). Everything on a book that
  already started at Ultra keeps its tier — chat edits and rebuilds (a rebuild copies its source's
  tier, and `ReplanSettings` cannot change one), retries, Studio assists, narration — because the
  reader chose it, and the set of such books is whatever was approved while the switch was on. A
  draft priced at Ultra before the switch went off is refused at plan and approval; its plan
  revisions are not gated. A share remix of an Ultra book is offered at Premium while the switch is
  off. The spend breaker's soft-cap rule for Ultra (`AI_BUSY` for free accounts) still applies once
  an operator turns it on.
- **One account holds at most its share of the long lane, asked at every door that starts long
  work, after the breaker and before anything is claimed.** The worker's long lane ran one book
  at a time in production until 2026-10-17 (thirty since; `docs/deployment.md`, "Job lanes"), and
  nothing stopped one account approving ten plans in a row and holding every other reader's book
  behind its own for a day. Thirty slots make that rarer, not impossible, so the share stays.
  `booksInProgress.ts` counts the account's books with long-lane work QUEUED or ACTIVE — read off
  the `GenerationJob` rows and classified by the same `JOB_LANES` map the enqueue sides route by,
  so an edit's recompile does not count and a generation's waiting compile or pictures do (they
  run in the compile and image lanes now, beside the long one, but the book is still being made:
  `isBookWork`), and the book being started never counts against itself — and refuses past one on a free account, three on
  any plan (`hasActiveSubscriptionEntitlement`, the spend breaker's notion of paid; an
  unreadable plan counts as paid). The doors: plan approval (not its replay), a paid `/resume`
  whose jobs take the long lane, audiobook start, manuscript import, and the chat Apply of a
  `continue_book` or `book_replan` card — the button and a typed confirmation both, before the
  "Apply" row is written. A text edit that rewrites more than `LONG_LANE_EDIT_PAGE_THRESHOLD`
  pages takes the long lane too (`apps/worker/CLAUDE.md`, the lanes), so its card's Apply and the
  page-rewrite paid retry (`bookEditOperationRetries.ts`) are doors as well; both ask the lane map
  itself — the Apply with the card's pages and a free `local_patch` read as the verified
  `mode: "exact"` it is, the retry with the very payload it is about to enqueue — never a copy of
  the threshold. Where it sits is the spend breaker's rule, right after it: after auth,
  validation and any replay, before every reservation, slot claim, upload write or row, so a
  refusal costs and claims nothing. The answer is 429 `BOOKS_IN_PROGRESS_LIMIT` with
  `booksInProgress: { limit, inProgress }`; the sentence lives with the code
  (`booksInProgressMessage`) and every app surface that starts a book already snackbars
  `error.message`, so no screen changed. It is a check, not a lock: two approvals in the same
  instant can both pass, which costs one more book in line, never money.
- **A waiting book is told how many books are ahead of it, counted in the order the long lane
  really runs.** `waitingInLine: { booksAhead }` on the status payload (null while none of the
  book's long work waits) comes from `longLaneQueuePosition.ts`, which reads open long-lane rows —
  durable rows, because a row whose Redis dispatch is still deferred is still in line — once per
  three seconds per process, adds the asking book's own fresh rows, and counts books with core's
  `booksAheadInLongLane`, the rule that sits beside the placement that makes it true (continuations
  before starts, FIFO within each). It takes the lane's slot count, read from the same
  `WORKER_LONG_CONCURRENCY` the worker reads (`workerLaneConcurrency`): books queued before this one
  are ahead of it, but books already running hold it up only once every slot is taken, so they
  count as `running − (slots − 1)` and never below zero. At thirty slots a book first in line
  behind twenty-nine running books is told it is first; counted as at one slot it was told
  twenty-nine. Only long-lane rows take part: a generation's pictures and its
  compile wait in lanes of their own and drain in seconds to minutes, so a book down to those is
  ahead of nobody and is not itself told it is waiting in line. The key has no "queue" in it on purpose: the status payload's
  leak tests forbid raw queue state, and this is a count of books. A failed read answers null,
  never a failed status. The app's words for it — "Waiting in line — 2 books ahead of yours",
  "Starting soon" — are in `waitingInLineLabel` (`project_status_models.dart`).
- **A finished book downloads free — every book a reader owns, PDF and EPUB, with no charge, no
  entitlement row and no 402; the export wire stays only for installed builds.** Parsa, 2026-10-15:
  "Charge once he approves the plan, a single cost for the book that we take before, and once the
  book is ready it is simply downloadable without any locks." Until then a per-book 150-credit
  `EXPORT_UNLOCK` was settled by the download route: bundled into a subscriber's book price *and*
  "covered" by their plan, so subscribers paid it twice, while a free reader's price left it out and
  the download almost never sold it. It went in three steps — bundled into every price, then split
  out for free readers on 2026-10-13, then removed — and nothing of it charges any more.
  `routes/exports.ts` hands the owner the bytes of a generated book, a Studio book, an import, a
  book made before the change or made while free alike: no `spendCredits`, no entitlement, never
  `INSUFFICIENT_CREDITS`. `readUrl` (`GET …/read/pdf`, inline) stays, because installed apps open
  their reader from it. **The export DTO's three unlock fields are constants now, kept for the
  builds already on phones**: `unlocked: true`, `creditsRequired: 0` (the app's parser requires the
  key) and `planIncludesUnlock: false` (the app offered a plan beside the credit unlock only where it
  was true) — `serializeExport` (`projectArtifactSerializers.ts`) writes them and reads no
  entitlement, which took a query off every status read. Old `EXPORT_UNLOCK` entitlements and
  ledger rows stay: the billing payload still lists them and the credit log still titles them
  "Export unlock". The Word file stays a plan perk — a gate on the format, never a charge (the Word
  entry below). `accessAndExports.test.ts` downloads each book kind with no credits and no plan.
- **A book is one charge, taken when its plan is approved and the same for a free reader and a
  subscriber; a retry of an attempt charged before that keeps its stored price.** Plan approval,
  the chat rebuild's card and its Apply, and every preview price a book through core's
  `estimateFullBookCreditCost` / `estimateBookReplanCreditCost`, which carry no export line
  (`packages/core/CLAUDE.md`), and none of them asks whether the reader holds a plan.
  `startGenerationAttempt` writes no entitlement beside the charge (`packages/db/CLAUDE.md`).
  **Installed apps quote books themselves** — `estimateProjectCredits` adds
  `creditCosts.exportUnlock` for a subscriber and falls back to 150 when the key is missing — so the
  billing payload keeps shipping that key, at 0 (core `RETIRED_CREDIT_PRICING_KEYS`), and an old
  build's subscriber quote matches the charge without a release. **The paid `/resume` re-charges
  exactly its source attempt's `quotedCredits`**, the `credits` the retry quote showed the reader
  before they confirmed. An attempt charged before 2026-10-15 stored a price with the 150 inside it
  (for every reader, before the 2026-10-13 split), and its retry keeps it: the retry repeats the
  approval the reader agreed to, the quote and the charge stay one number, and
  `startGenerationAttempt` refuses a retry priced apart from its source. Dropping the old line
  instead would have needed a second price read on every failed book's status, a looser equality
  in the shared attempt check, and a quote the user-stop settlement could no longer add up
  (`quotedFullBookRates`), for a handful of retries; a stop or failure of that retry still returns
  the 150, which no run delivers. Nothing is granted for it. A *replayed* approval (the same plan
  approved again) of a book charged before the change re-quotes without the line and answers the
  attempt conflict, exactly as a price save in between does; the first approval's book is already
  generating. The dashboard counts no export unlock at all (`admin/pricingDrivers.ts`).
  `creditTierPricing.test.ts`, `projectChatReplan.test.ts`, `plansResumeExportUnlock.test.ts`.
- **Chat replies never name a credit price.** The number travels as
  `metadata.creditsCharged` (queued work) or `metadata.editProposal.credits` (a proposal), and the
  app draws it as the tappable badge in `credit_cost_badge.dart` — one place that also explains what
  credits buy and that failures are refunded. `stripCreditAnnouncement` in
  `apps/api/src/mobile/projectChat.ts` removes the old sentence from transcripts written before
  that, so a new priced reply that writes the price into its text would say it twice.
- **A credit-history line names what a charge bought, never the rate it was billed at.** A ledger
  `operation` is a rate: a page rewrite, a chapter rewrite, a structural insert, a continuation and
  the Studio's chapter draft are all `PAGE_REGENERATION`, and the Studio's notes, consistency check
  and outline borrow `BOOK_TEXT_EDIT`, `PREMIUM_REVIEW` and `PLAN_GENERATION`. Titled by it, the log
  called an added page "Page rewrite" and its refund "Page rewrite refunded". `creditLogActions.ts`
  reads the label off what the charge recorded — `intent.kind`, `writingAssist`, or for a retry-lane
  charge the edit operation it re-ran (one batched read) — and titles a refund from the charge it
  reverses (`reversesEntry`), since a refund records only why. No new operation was added, because
  the rate is right and every pricing, retry and economics query keys off it; the label being read
  from the row also corrects every line already in the ledger. `description` is never read: it holds
  refund reasons that are often raw provider errors.

## The edit chat router

- **The edit chat gets one clarifying question per request, and it is enforced three times.**
  A second question is a loop the user cannot escape: a `scope` clarification whose scope is
  `"none"` is satisfied by no reply, so "just add" is met with the same question forever. Once
  `findPendingScopeClarification` reports an open `scope` (or the matter composer's `matter`)
  clarification that the new message neither answers nor cancels, `apps/api/src/mobile/routes/projectChat.ts` merges the stored
  request with the follow-up (`messageWithFollowUp`) and sets `clarifyExhausted`. That flag drops
  `clarify` from the router's action enum (`decideActionsFor`), *skips* the
  `BOOK_EDIT_CONFIDENCE_THRESHOLD` demotion — which would otherwise turn the hesitant decision
  straight back into the question — and finally `forcedDecision` coerces any surviving `clarify`
  into a whole-book `page_rewrite`. All three are needed: the prompt covers the model, the
  coercion covers a router timeout and the model-free heuristics, whose catch-all is a clarify.
  **A question is open for one reply only**: once an assistant message follows it, it is spent and
  never re-found — before, nothing marked the turn that spent it, so every later message was merged
  with the old request ("make page 3 funnier" reached the router as a follow-up to "add an ISBN").
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
- **A regex over chat text gives each optional word its own whitespace and starts a run at its first character, because the API reads it on its only thread.**
  Every recogniser the chat runs is synchronous on the API's event loop, so one slow pattern is
  every user's outage, and no time box around a model call can interrupt it. Six were found on
  2026-10-06/07, each from one message under the 5,000-character limit: the matter composer's
  style-instruction pattern (97 s), a byline name pattern on joined capitals (1.3 s), the page-count
  reader `explicitTargetPagesFromText` (57 s on "page" and spaces), the language guard (23 s), the
  page-design recogniser (22 s on 809 characters) and the swap recogniser (2.7 s on 98). The shapes
  were always the same — two quantifiers that can split one run of whitespace or separators
  (`\s*,?\s*`, three optional words each with `\s*` around it), overlapping adjacent classes, an
  unbounded tail started inside a word, an end-anchored run retried from every position — and the
  rewrites are exact: each optional word carries its own trailing `\s*`, adjacent classes are
  disjoint, a run starts at its first character (`(?<!\s)\s+`, `(?<![.!?])[.!?]+$`), and a
  recogniser applied to every word of a chain skips in code. Each fixed recogniser keeps a corpus
  pinned to its old answers and a timing battery read at 1,000 characters before 10,000.
- **The chat speaks the printed page numbers, and the model indexes never reach the reader.**
  A reader saying "page 10" means the number on the PDF page in front of them — the printed
  footer, the Contents column and the pdfrx chrome, which skip the cover sheet — while every
  internal target is a model `Page.index`. Stored map ranges are physical (cover = PDF page 1);
  `printedPageForPdfPage` / `pdfPageForPrintedPage` convert, gated on map version: version 1
  stays on physical numbering (those PDFs counted the cover), version 2+ skips the cover.
  The translation is `Project.pdfPageMap`: measured at publish time from the rendered
  bytes by both publishers, stamped with the revision they claimed, and read through
  `bookPageMapForProject`
  (`apps/api/src/bookPageNumbering.ts`), which refuses a map from any other revision — except
  during EDITING, when the new PDF has not been published yet and the reader is still looking at
  the file that map describes. Dropping it there would make a typed "page 12" fall back to a
  model index while printed page 12 is still on screen; selection-composed edits already send
  `pageIndex`, so they never hit this. On the way in, `pageIndexesFromMessage` and friends
  resolve spoken numbers through the map — an edit target landing on furniture (Contents,
  Sources — the cover has no printed number) resolves to **nothing** rather than to whichever
  model page shares the number, while read/placement targets take the nearest page of prose —
  and the router model is given each page's `readerPages`
  plus the furniture ranges and told to return model indexes. **Told, and then checked**: a
  decision whose page channels name exactly the printed numbers the message speaks is the
  signature of a model that copied instead of translating, so `modelPagesForCopiedPrintedPages`
  re-reads them through the map before `intentFromProposeEdit` builds the intent — the same
  refusal to trust the model that `withDeterministicContentTarget` already makes for
  `show_content`. It stays deliberately narrow: a translated index (one the message never
  mentions) and a printed number that holds no prose keep the router's own answer. Spoken
  numbers include the same page-words the length parser already knows, so "صفحه ۵" is a
  copy just as much as "page 5". **The parser has to read the whole list or the guard cannot
  fire**: it once took only the first number after the word, so "edit pages 3, 5 and 7" spoke `{3}`
  against a router that named `{3,5,7}`, the set comparison failed, and three *printed* numbers
  were used as model indexes — the wrong three pages, with the card rendering them back through
  `displayPages` so the confirmation looked right. The comparison stays an **equality** rather than
  a containment: a router that translated correctly can also answer a subset of the numbers spoken
  (an index that happens to equal one of them), and translating that a second time moves the edit
  to a page nobody named. **A number the router had to compute is invisible to the guard, so
  nothing may ask it to compute one**: the structural anchor was once specified as "one less than
  the named page" when the reader says *before*, and a decremented number is exactly the signature
  of a model that translated — so the guard declined, the printed anchor was consumed as a model
  index, and "add a page before page 10" opened the gap after model page 9. The router now names
  the page itself with `structuralAnchorPosition` beside it, and `anchorPageIndexFromDecision`
  (`bookEditDecision.ts`) takes the step afterwards, in model pages, off whichever end of the
  translated span the side calls for. **Which end is one rule with two readers**, so it lives in
  `anchorModelPageIndex` (`bookEditMessage.ts`) rather than beside either of them: a printed sheet
  routinely holds several short model pages — one ending on it, one wholly inside it, one starting
  there — and `structuralIntentFromDecision` borrows the model-free recogniser's anchor whenever
  the router named none. The recogniser resolved that sheet to a *single* page, the first one to
  start on it (`primaryModelPageForPdfPage`), so "add a page after page 10" opened the gap past the
  sheet or in the middle of it depending only on whether the router had filled the channel.
  On the way out, every proposal card,
  queued reply and operation card renders through a `ReaderPageNumbering`
  (`mobile/bookEditCopy.ts`, `mobile/editOperationCopy.ts`), and **the way out has two ends of the
  span as well**: `displayPage` is the number a reader calls a model page by, `displayPageEnd` is
  the last sheet it prints on, and every "after page N" — the insert chip's `afterReaderPage`, the
  proposal bubble, the move destination, the applied insert's card — is the *end*, because that is
  the sheet the new or moved pages actually follow. Printing the start named a sheet before where
  the prose lands on any page long enough to span two, which is the same widening
  `anchorModelPageIndex` takes `Math.max` over on the way in. **And a place the reader named by the
  page after it is named that way back** (`StructuralPageEdit.anchorSide`, display only;
  `readerPlaceOfGap`): on a book of short pages two of them share a sheet, so the gap between them
  is "after page 4" and "before page 4" at once, and "move page 6 before page 4", "swap pages 4 and
  5" and "put a new page before page 7" were confirmed "… after page 4/7" (2026-10-02). "Before page
  N" is the sheet the page past the gap begins on, which is true of every gap; the wire sends
  `placement: "before"` with `beforeReaderPage` and keeps `afterReaderPage` for builds that predate
  it. A "before" anchor is also taken ahead of the pages that *begin* on its sheet
  (`beforeAnchorPages`), never ahead of one that began a sheet earlier and runs onto it — that put
  the new page before page 9's text for "before page 10". **A place the card cannot name is
  left out of the sentence rather than approximated, and there are two ways to fail to name one.**
  `displayPageEnd` answers a page the map has never seen with the model index, which is the right
  degradation inside a *list* of pages — dropping one out of "pages 3 and 4" is worse — and the
  wrong one where the number stands alone as a place, because "after page 8" is read as a printed
  number and names a sheet holding something else; `printedPageEnd` is that same end answering
  `undefined` instead, and the applied insert's card drops the clause on it. The other way is the
  anchor itself: that card derives it as the first page the apply *wrote*, less one, which is
  `insertAfterIndex` only while the whole run is in the book. A live insert is indivisible — the
  worker writes every recorded id or rolls the set back — but a historical row can still show
  fewer written indexes than the stamp recorded, so `insertedPagesLocation` compares the stamp's
  `insertedPageIds` against the pages written and names only the count when they disagree — one
  less than the first survivor is a page of the insert itself or the gap another left, and neither
  has a sheet in the map that was measured before either existed. The two placements the *request*
  settles outright are read from it and not from the pages: `0` survives the resolver's clamp and
  `null` is clamped to the last page, so "the front" and "the end" are true of every delivery.
  The operation DTO reports that settlement as `creditsRefundedAmount`; `creditsRefunded` is true
  only when the cumulative reversal covers the whole charge. The app shows both the net kept amount
  and the returned portion for a partial delivery rather than striking through the gross price.
  **Before Apply the placement is resolved once and every surface reads that one answer.**
  `structuralPlacementOf` (`mobile/structuralPageEdits.ts`) answers `front` | `after` a printed page
  | `end` | `unnamed`, and the three rules live only there: an insert's landing page is the
  resolver's clamped `insertAfterIndex` while a move's is the request's own anchor — a plan that is
  not an insert carries `insertAfterIndex: 0`, so a move reading it would send every page to the
  front of the book — the number is the anchor's `printedPageEnd`, and `unnamed` covers both a
  delete, which puts its pages nowhere, and a destination the map cannot place. Each surface keeps
  only its own words for it: `structuralProposalSummary` the sentence, `structuralCardBlock` the
  wire, `MobileEditProposal.pageLabel` the chip. They used to resolve it separately and had already
  drifted — the wire fields were gated on `action === "insert"`, so "Move page 3 after page 5" was
  drawn beside a chip naming no destination at all, and both halves read the anchor through
  `displayPageEnd`, which hands back the model index for a page an earlier, not-yet-recompiled edit
  added. The block sends `atFrontOfBook`/`afterReaderPage` beside the resolved `placement` because
  shipped app builds read those two, and a proposal lives on the chat message: a card written before
  `placement` existed is still read by inferring one from them
  (`MobileStructuralPlacement._placementFrom`, `project_chat_models.dart`).
  The DTOs carry a separate
  `readerPageNumbers` array — `affectedPageIndexes` stay model indexes on purpose, because the
  Edit-Mode deep links and the worker payloads navigate by them. A selection composed in the
  reader sends its resolved model page as structured `readerContext` (authoritative over parsing
  its own text, whose visible number is now the printed page). When its local locator resolved
  nothing, that context falls back to the **physical pdfrx sheet** — and a sheet number belongs to
  one file, so it travels with that file's `pdfDigest` and
  `modelPageForReaderContext` translates it only against a map measured from those exact bytes.
  The revision is not enough on either side: a repair republishes the same `contentRevision` over a
  new PDF and stamps the new map with it, so the revisions still agree while sheet 7 of the file
  still open is a different page from sheet 7 of the file the map now describes. Missing identity —
  a legacy map with no digest, an older app that sends none — refuses the sheet rather than
  guessing; the message's own printed numbers still route as they always did. The resolved
  `pageIndex` is unaffected either way, because a model page is a page of the manuscript rather
  than a sheet of one compile of it. **No translatable map means the
  old chat behaviour exactly**: books compiled before the map, or whose measurement failed, keep
  model-index parsing and copy byte for byte, which is also the graceful path for every test and
  every legacy transcript. Measurement failure is not a blank column: new PDFs always skip the
  cover in CSS, so the compile still records cover-skip numbering (`hasCoverPage` on status)
  and chrome matches the footer. Status exposes that flag together with the stored numbering's
  own `contentRevision` and `pdfDigest` as `pdfPageNumbering`; the app compares the digest with the
  downloaded bytes before using it. The project revision is not a substitute — EDITING keeps a
  behind map deliberately, and a repair may replace PDF bytes at the same revision and size.
  Legacy maps missing either stamp expose no numbering identity and the app stays physical. Chat
  stays on model indexes because a stub has no ranges.
- **Changing *which* pages a book has is its own edit, and it used to be a whole new project.**
  `restructure_pages` covers insert, delete and move; which one it was rides
  `structuralEdit` on the intent and the operation's classifier, so the dozen lists that switch on
  a kind gained one arm rather than three. It is a **fork of `apply-book-edit`**
  (`handlers/restructurePages.ts`), not a job type: everything a new type would buy already covers
  `APPLY_BOOK_EDIT`, and a new one needs entries in eight cross-workspace lists that do not
  typecheck against each other. Before it existed the request had nowhere to land — the router
  prompt calls a length change `structural`, and the model-free battery in
  `classifyWithDegradedHeuristics` matched `add|remove|delete|new (a) chapter|section|page` — so
  "add 3 pages after page 10" became a `book_replan`, which forks a **second `Project` row** and
  regenerates the book, priced as a whole book. Both halves had to be narrowed; fixing only the
  regex leaves the live path exactly as it was. Two things about it are load-bearing:
  it **forks before `affectedPagesForIntent`** in both `proposeBookEdit` and `queueChatBookEdit`,
  because that resolver filters against pages which *currently exist* and a page about to be
  created is not one — reaching it, an insert is answered "which page or exact phrase should I
  edit?" and never gets a card at all; and `anchorPageIndex` is `number | null` where **`0` is the
  front of the book and `null` is "no place named"**, an insert appending for the second and a move
  refusing it. Deleting and reordering call no model, so both are **free**, the same reasoning that
  prices `move_image` and `remove_image` at zero — only `pagesBilled` (an insert's new pages) is
  charged, at the rate a continuation pays. `resolveStructuralPageEdit`
  (`packages/core/src/generation/pageRestructure.ts`) is the one resolver the quote and the job both
  run, and it refuses rather than throws: a delete that would empty the book or leave a `Chapter`
  row with no pages settles for free with a sentence naming what is in the way.
  **A delete or move is direct only while its whole instruction is structural.** The canonical
  instruction separates coordinates from `Content requirements:`; if the latter is non-empty,
  `compoundStructuralReplanIntent` changes the proposal to `book_replan` before pricing, preserving
  the resolved target page count and the structural edit as audit context. The shared core classifier
  (one definition in `packages/core`, read by both sides) has two doors. A request that writes
  "page" in English is decided solely by a closed action/placement grammar. A request naming its
  page in one of the other scripts `BOOK_PAGE_WORD_PATTERN` covers may also reach the cheap path,
  but only on positive evidence of bareness — no more distinct page numbers than the edit has
  coordinates, and a residue inside a small character budget — because the alternative was quoting
  a Persian reader a whole regeneration for deleting one page. Ambiguity outside both doors still
  buys whole-book generation and adherence rather than letting a free row-ordering path promise
  prose it never drafts. Apply repeats the check so an older free card is re-proposed, never silently repriced.
  **Its caps are its own, and nothing upstream may clamp a request down to them.** A request the
  resolver refuses is answered free, in prose naming the real limit ("I can add up to 10 pages at a
  time"); the same request quietly narrowed on the way in is a card, a price and a charge for an
  edit nobody asked for, with the pages that were dropped mentioned nowhere. `bookEditDecision.ts`
  used to `Math.min` the router's `structuralPageCount` against `MAX_INSERTED_PAGES`, and
  `structuralPageCount`'s zod bound *was* that cap — which reaches the model as `maximum`, so a
  router asked for twelve pages answered ten — while the model-free recogniser clamped nothing at
  all: one message, "add 12 pages after page 10", got a ten-page insert through the router and a
  free refusal through a router outage. Both bounds are now well above the cap and only the
  resolver reads it. The floor on that same line is a different rule and stays: it is what turns a
  router that named no count, and a borrowed recognition that is not an insert, into the one page
  "add a page" means.
  **The stored `structuralEdit` is the Apply's whole instruction, so an Apply that lost it settles
  for free instead of defaulting.** `structuralEditFromMetadata` drops a stored edit that no longer
  parses rather than half-reading it, and `structuralEditForProposal`'s one-page-append default
  belongs to the *proposal* side, where nothing is reserved and the card is one Cancel away. Read on
  the Apply it turned a confirmed "Remove page 2" into a priced append at the end of the book —
  under the quote ceiling on any card that quoted more than one page, so it charged — and left the
  free ones bouncing back as a brand-new proposal for an edit nobody asked for.
  **It is reviewed from its stamp, because it snapshots nothing.** `changesAvailable` counted
  `PageEditSnapshot` rows, and a structural edit writes none — it rewrites no page, and a removed
  page's snapshot would cascade away with the page it describes — so the app's only review
  affordance was switched off for the one edit that moves whole pages, and the Flutter screen's
  `restructure_pages` arm could not be reached at all. `editChangesAvailable`
  (`mobile/projectChat.ts`) asks `hasBookEditUndoRecord`, which reads
  `classifier.structuralApplication` beside the count — the
  same stamp `operationCanUndo` and the worker's redelivery fence rest on: written in the
  transaction that shifted the indexes, erased by the rollback, so its presence *is* "this edit
  changed the book's shape". A delivered no-op (`structuralSkipped`) returns before the shift and
  carries no stamp, so it stays unreviewable for the same reason it stays un-undoable.
  `loadEditChanges` then builds the diff **from the stamp** rather than from snapshots: an inserted
  page's text is read live off the `Page` row drafting wrote and shown wholly added, a removed
  page's rides the stamp whole and is shown wholly removed, and a moved page kept every word — so it
  carries `pageIndexBefore` instead of a diff, and **which** pages moved is the request's own
  `structuralEdit.pageIndexes`, never a comparison of the two orders: shifting one page renumbers
  every page it passed, and none of those moved in any sense the reader means. Answering with the
  two word totals alone was honest about the snapshots and useless to the reader — an insert's whole
  point is the page it added, and "+240 −0" is not that page. The generic summary line still has to
  be right, because an insert the reader undid lists nothing again: the revert deletes the pages it
  made. **The live progress card said the
  opposite of that same fact**: sharing `APPLY_BOOK_EDIT`'s step keys means sharing its reader copy,
  so the step the worker spends shifting page indexes was announced as "Saving a version to undo".
  The worker's own step title is right and unusable — `advanceJobStep` puts it in
  `GenerationJob.message`, which these serializers never forward — so `editProgress.ts` keeps the
  words and picks them per `structuralEdit.action` (falling back on `intentKind`), the same payload
  discriminator the admin operations map reads.
- **A page change is one action, read by code where the reader spoke only numbers, and words that only locate or excuse a page are not prose to price.**
  Words that only locate, excuse or soften a page change were each a free delete quoted at 520–550
  credits (2026-10-02): courtesy at either end ("can you…", "please and
  thanks"), a reason that only says the page is redundant ("it repeats page 4"), pages picked by a
  pattern or by what they hold ("every other page", "all the pages about shopping") and a swap of two
  pages are all in the closed grammar now. A locator is a few words with no conjunction or edit verb
  in it, so "delete the page about X and rewrite page 8" still reaches the replan.
  **A request one card cannot carry is answered before any card.** A structural edit is one action
  with one anchor, so "add a page after page 4 and delete page 9" became an insert whose brief said
  "Also delete page 9" — prose the drafter cannot perform — and a swap of two pages with others
  between them would be half done by any one move. `multipleStructuralActionsMessage` and
  `unswappablePagesMessage` (`structuralPageEdits.ts`) answer both free; a swap of neighbours is the
  one move `swapPagesFromMessage` (`bookEditStructure.ts`) builds, read whole — pages *and* anchor —
  because the router writes one swap two ways and code's pages beside its anchor move a page after
  itself.
  **A request that names its pages by number alone is translated by code, even where the router
  guessed elsewhere** (`codeTranslatedSelection`, `bookEditDecision.ts`): "delete page 0" was offered
  as "Remove page 2". A page named by what it holds is still the router's. Ranges read "to" and
  "through" as core's grammar does — read with the dash alone, "pages 3 to 5" was page 3.
  **An insert's instruction carries what to write, never where**: the router restated the place in a
  new form on every run ("so they fall between printed page 4 and printed page 5", "(internal page
  index 4)"), and each one reached the card as a requirement. It is told to leave the place to the
  structural fields, and an opening sentence or aside made only of page references and placement
  words is dropped as a backstop (`withoutPlacementOnlySentence`).
  **A numbered delete or move the router asked about is settled by code** (`numberedStructuralIntent`,
  `bookEditDecision.ts`): on a sheet two pages share, the router asked "which one?" for "remove page
  three" and offered a card for "remove page 3". The pages that begin on the sheet are the answer
  either way, so a bare request code resolves to real pages becomes that card whatever the router
  said; a number holding no page, a move with nowhere to go or a second request stays the router's.
- **The model-free recogniser fires only when the verb's object *is* the page.** `bookEditStructure.ts`
  runs third in `classifyWithDegradedHeuristics`, ahead of the replan battery and with no image or
  patch recogniser in front of it (image requests have no regex fast path by design), so whatever it
  claims is what an outage turns the request into. Its delete and move patterns used to allow twenty
  arbitrary characters between the verb and the page word, which reads "a page word nearby" — and
  nearby is where a reader writes what the page *holds*: "remove the picture on page 3" was answered
  with "I'll remove that page and renumber the rest of the book", as were the title, the last line
  and the photo on a page, and "move the picture on page 3 to after page 5" moved the page. So the
  object is now a closed grammar — determiner, qualifiers, then a page the message **names** —
  composed from the same list sources `pageIndexesFromMessage` reads (`NAMED_PAGE_LIST_SOURCE`), with
  the exceptions written down rather than approximated: a trailing noun means the page was a locator
  ("add page numbers", "delete page 3's picture"), a shortening clause is a rewrite ("cut page 3 down
  to half"), and a negation is not a request. Targets come from the matched clause, never the whole
  message, so "delete page 3, it repeats page 7" removes one page. **Fixing that pattern alone makes
  things worse, which is why the other half moved with it**: `negativeMediaPreferenceFromMessage`
  matches "remove … picture" anywhere, so what falls through lands on `structural` and quotes a whole
  rebuild *with illustrations switched off* — that reading is now gated on the request naming no page
  (`bookWideReplanSettings`), and a page-scoped picture request degrades to `clarify`, which is the
  landing the model-free path was designed to give it.
- **Undoing a structural edit moves the book to a different plan version, and the recompile has to
  follow it there.** `undoLastBookEdit` is handed a `project` read before its transaction, and
  every other undo can queue its recompile against that row's `currentPlanId`. A structural one
  cannot: applying it approved a `PlanVersion` of its own, and when that version is still current
  `revertStructuralPageChange` deletes it inside the same transaction — so the id in hand names a
  plan that is gone by the time the compile runs. If a continuation has since advanced the plan,
  the revert keeps and reconciles that later version instead, because it also keeps the pages the
  continuation appended; restoring the pre-structural plan would make the page set and plan
  disagree. The revert returns whichever version is current afterwards and the recompile names
  that; the compatibility/refusal policy and the `null` case are in `packages/db/CLAUDE.md`. This
  is not a compile that merely fails: it owns the book's outcome, so its throw marked a finished,
  delivered book FAILED and refunded the generation — the most expensive possible result of a
  free undo.
  It also runs under `PAGE_RESTRUCTURE_TRANSACTION_OPTIONS`, the ceiling the apply side names,
  because it replays that work backwards in one transaction — the raw index shifts, both
  `PlanVersion` writes, then every snapshot on top — and Prisma's 5 s default aborts that midway
  on a long book — the very edit that was allowed 30 s to make the shape cannot be given back
  under 5 s, and the reader's Undo just errors.
- **Moving and removing a picture are free, and neither is a page edit.** `move_image` and
  `remove_image` are their own intent kinds and their own `BookEditOperationKind`s, priced at 0 in
  `bookEditCreditCost` and applied by `apply-book-edit`'s layout fork
  (`apps/worker/src/handlers/applyImageLayout.ts`) with no generation at all. Routing them as page
  rewrites is the expensive mistake this exists to stop — the router prompt says so in as many
  words, and the plan stage demotes both to `answer` because a book with no pages has no pictures.
  **And a status poll may read which fork an apply took, because the kind is written before the
  job exists.** `createOpenBookEditOperation` (`editOperationClaims.ts`) inserts the row with its
  `kind` and only then opens the transaction that enqueues, all four `APPLY_BOOK_EDIT` sites follow
  that order and put `operationId` on the payload, and nothing anywhere updates `kind` — so the
  value a poll reads mid-flight is the value `applyBookEdit` will fork on. That is what lets
  `projectPageCounts.ts` answer "is a page rewrite owed" at the granularity the truth lives at:
  `JOB_PAGE_REWRITE_SCOPE` in `packages/core` must say `always` for `APPLY_BOOK_EDIT`, because the
  leaf cannot make a database read, and a picture move is an apply that rewrites nothing. Left
  coarse, a reader moving a picture watched a delivered 200-page book count down to 197/200 and its
  Pages step re-open for the length of a free edit, then snap back — and a stalled operation row
  held it there. The refinement only ever *narrows* the coarse answer, and every unknown it meets —
  no `operationId`, a missing row, a kind this build does not know — answers "owed", because
  under-reporting a finished book is the failure it exists to stop.
  **A replacement is the one image edit whose undo has to move a record as well as a file.** Move
  and remove never redraw, so the row's `metadata.copyrightRewrite` still describes the pixels it
  always did; replacing a picture puts different pixels behind the same `ImageAsset` id, and the
  worker records the outgoing render's provenance on `classifier.previousAsset.generation` for this
  revert to merge back (`withImageRenderProvenance`, core). Restoring `path` without it left the
  *replacement's* claim standing over a picture drawn before anyone asked — the false kind, and a
  false one is worse than none. Merged onto the row read inside the transaction rather than written
  whole, because `keeperToken` and its siblings on that document decide illustration ownership.
  All four enqueue sites also stamp `PRE_EDIT_PROJECT_STATUS` from that same pre-transaction
  project row before changing it to EDITING. The worker cannot reconstruct COMPLETE versus
  REVIEW_REQUIRED after commit, so text rewrite, image insertion, image layout and restructure
  payloads all carry the settled status their own no-op/failure exits may restore.
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
so `layoutSkipSummary` in `mobile/editOperationCopy.ts` is where the queued reply's promise gets
corrected, and no Undo is offered for those rows — they write no snapshot, so the shared undo
predicate below refuses them where `undoLastBookEdit` would otherwise revert the *previous*
edit instead.

- **Undo is offered only for an edit the undo would actually revert, and that is one predicate.**
  `canUndoBookEdit` (`mobile/manualEdits.ts`) is the whole rule: APPLIED, an undoable kind, not
  already undone, and carrying the record the undo restores from — `PageEditSnapshot` rows for
  anything that rewrote text or moved a picture, the `structuralApplication` stamp for an edit that
  changed which pages the book has. The card's button (`operationCanUndo`), the picker inside
  `undoLastBookEdit` and "See changes" (`editChangesAvailable`, which is the record half,
  `hasBookEditUndoRecord`, on its own) all read it. A row one of them says yes to and another skips
  is not a harmless no-op Undo: the picker takes the newest row *with* a record, so the reader taps
  Undo on this edit's card and the edit before it is reverted, under this one's confirmation
  sentence. The three used to be written out separately, and the card's copy enumerated the ways a
  record can be missing — `classifier.layoutMissing`, then `classifier.structuralSkipped` — which
  is how the two shapes that carry no marker at all were missed: a structural apply whose
  `rollbackStructuralChange` erased the stamp while the `updateMany` flipping the row APPLIED →
  FAILED afterwards is `.catch()`ed away, and an exact-mode edit whose skipped pages had their
  snapshots deleted (`applyBookEdit`). Ask for the record rather than for the absence of a marker,
  and the next shape is covered too. The snapshot count is the one thing the predicate cannot fetch
  itself, so a caller that did not select `_count` reads as zero and the button goes missing —
  which is the degraded state worth having.
  **The picker asks it a second time inside its own transaction, under the operation row's write
  lock**, the way `settleSkippedRestructure` does on the worker side — the row moves in the window
  the picker's read opens. The reader taps Undo while a structural apply is still drafting; the
  drafting dies, `rollbackStructuralChange` puts the pages back, erases `structuralApplication` and
  writes `structuralRolledBackAt`, and the row goes FAILED (or stays APPLIED, because that flip is
  `.catch()`ed). The undo then ran `revertStructuralPageChange` a *second* time over an
  already-restored book — deleting a `newPlanVersionId` that is gone, re-approving the base plan —
  and wrote `{ ...pre-rollback classifier, undoneAt }` back over the rollback's own record, putting
  the stamp back and dropping `structuralRolledBackAt`. So the transaction opens with a conditional
  `updateMany` claiming the still-APPLIED row (its count is the status half), re-reads the
  classifier under that lock, and asks `canUndoBookEdit` again before anything else is written —
  including the project's EDITING/`contentRevision` bump, which now comes after the claim rather
  than before it, so a refused undo leaves no revision behind and nothing to recompile. A refusal
  answers "nothing to undo" rather than falling through to the next row: the picker takes the
  newest row *with* a record, so falling through reverts the edit before this one under this one's
  confirmation. It also settles two undos racing each other — the second waits on the lock, then
  reads its own `undoneAt`.
  A structural delete can leave one live snapshot and park another from the same older multi-page
  operation. `_count.archivedSnapshots` is therefore part of that predicate too: any archived row
  makes the older operation incomplete and neither reviewable nor undoable. Structural Undo restores
  those rows under their original operation ids before its own `undoneAt` lands, so the next Undo in
  the chain sees the older edit whole again. If the delete instead becomes permanent, the archive's
  plain key outlives retirement of the structural operation and keeps that partial history hidden.

- **Redo is offered only for an undone edit the redo would actually restore, and that is one predicate.**
  `canRedoBookEdit` (`mobile/bookEditRedo.ts`) is the whole rule: APPLIED, an undoable kind, already
  undone (`undoneAt` is a string), and carrying a snapshot-backed record Redo can invert — not a
  `structuralApplication` stamp. The API cannot replay a structural shift, and the stamp does not
  keep the after-order or inserted bodies, so a structural undo is honest: no button. The card
  (`pickRedoableBookEdit` in `loadProjectChatResponse`), the picker inside `redoLastBookEdit` and
  the claim under the operation row lock all read that predicate. A later not-undone APPLIED
  undoable edit blocks Redo — restoring the older after-state over the newer one would be the
  wrong edit. Among unblocked candidates the newest `undoneAt` wins, not `appliedAt`: after Undo B
  then Undo A, Redo puts A back. `find(canRedo)` on `createdAt desc` would pick B. Undo stamps
  `redoable` when the snapshots have after fields or a picture record to invert, so a row with
  nothing to write does not advertise the button. A refusal answers "nothing to redo" rather than
  falling through to another undone row.
  Undo stamps each snapshot page's live `Page.storyDelta` onto
  `classifier.storyDeltasAfter` (JSON `null` when the after extract is empty — never `DbNull`)
  because `PageEditSnapshot` has no after column; Redo writes those back before
  `rebuildStoryStateAfterUndo`. Leaving the page on the undone before leaves `Project.storyState`
  on the undone fold while the reader sees the after prose — later AI work reads the wrong book.
  A legacy undo with no stash leaves `storyDelta` off the page write rather than inventing one.
  Redo drops the stash with `undoneAt` so the next Undo restamps from the live pages.

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
  queue a compile per listed book. The file is **read whole before anything is answered**, and the
  bytes it hands back are the ones already in memory — when a download still settled the export
  unlock, `stat`, charge, then read left a window where that same edit could delete the file
  mid-charge and answer 404 with the reader's credits gone; nothing settles now (downloads are
  free), and the read-first order still keeps a found file from turning into a 404 half-way through.
  What it queues is a **repair**, and it must
  not borrow the edit recompile's normalized revision-and-policy dedupe key: `enqueueGenerationJob` returns any
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
  else, they just settle nothing. A free edit's recompile (a manual save, Undo, Redo, a Studio
  publish or takeover), and since 2026-10-13 a paid chat edit's too (its attempt settled when the
  edit published), is excluded by the same `payloadOwnsProjectOutcome` test and restored like a
  presentation reprint — "A free edit's recompile owns its verdict, never the paid book's failure"
  in `apps/worker/src/handlers/CLAUDE.md` — and the ledger refuses a delivered attempt's charge
  whatever walks to it (`packages/db/CLAUDE.md`). **The charge is only half of what a stop must not touch**: the
  same function's project write was unconditional, so stopping a repair marked the finished book
  FAILED — terminal, because `ensureExportRepairQueued` only queues for COMPLETE and
  REVIEW_REQUIRED and `canRecoverGenerationJob` refuses detached rows, so neither the self-repair
  lane nor either resume route could move it back. It is guarded on the *status* rather than on
  what was stopped (`SETTLED_PROJECT_STATUSES`), because a book reaches those two only by being
  finished while real in-flight work is GENERATING or EDITING — so an unstarted edit or a narration
  stopped on a finished book leaves it finished too, and nothing that should fail a run stopped
  failing it. The operator console draws Stop for any QUEUED or ACTIVE job, which a repair is.
  **A stopped continuation always restores while its durable job is QUEUED, and once ACTIVE only
  under the atomic-candidates publication protocol.** Enqueue moves the settled book to EDITING
  before the worker sees it, and `markActive` claims the job row before any plan or manuscript
  write — so QUEUED, read under Stop's own claim, proves that transition is the only mutation and
  the payload's pre-edit status is safe to restore. QUEUED restores unconditionally: a mixed or
  unrecognised protocol marker is not evidence of a publication, and failing closed on one took a
  finished book to FAILED the day the protocol version moves. ACTIVE cannot identify a phase:
  `continueBook` may still be outlining, or it may already have atomically installed its extended
  plan and chapters and partially drafted the appended pages, including page-owned semantic state.
  The API does not own enough of that handler's snapshot to compensate it safely, so Stop leaves an
  ACTIVE continuation's project FAILED — unless the durable classifier *and* the payload both carry
  the atomic-candidates marker, which is the worker saying it holds every candidate until one
  publication transaction and so published atomically or not at all; any winner is caught earlier by
  the APPLIED handoff branch. Apply can restore after its publication lease is revoked. That FAILED status is the barrier that prevents a partial append reading as delivered if
  the worker's best-effort rollback is interrupted. APPLIED remains a different durable fact: Stop
  excludes that job from terminalization and refund so its idempotent publication handoff can finish.
  Keep the APPLIED query on the full pre-edit job set even though the immediate-restore filter treats
  ACTIVE Continue differently; repeated Stop then sees no newly claimable work in either branch.
  **Not failing the project is not the same as not being reported as its failure**, and the reading
  side has to ask too. A FAILED repair row is still a FAILED row, so it reached `failureMessage` in
  `mobile/projectStatusSerializers.ts` — the app's `hasFailure`, which is `BookStage.needsAttention` — and
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
  non-windowed compile-intent key it replaced, which went terminal and stayed there. The symptom to look for is
  a `GenerationJob` whose `dedupeKey` contains `repair-` sitting FAILED while the project's exports
  are missing; it re-attempts on its own. Note the app gives up watching first: its budget is two
  minutes against a window of up to five, so a book can stop saying "preparing" before the next
  repair is even queued. The two numbers are deliberately unmatched — the watch bounds pointless
  polling, the window bounds pointless compiles, and a repair that keeps failing is a broken book
  that polling faster would not fix.
  **A FAILED row the book has already retried is not the book's current trouble.** Retry leaves the
  old `GenerationJob` FAILED. `failureMessage` is the app's `hasFailure`, which is
  `BookStage.needsAttention` even while project status is PLANNING or GENERATING, so a leftover
  `PLAN_BOOK` after the reader clicked retry kept the plan error on screen after the retry had
  already succeeded. `canRecoverGenerationJob` is the resume question against the current plan, not
  this one — a completed retry of the same page is still "recoverable" in that sense.
  `laterJobSupersedesOwningFailure` is the reporting filter: a later QUEUED, ACTIVE or COMPLETED row
  that itself owns the project outcome, for the same work, replaces the leftover. Planning is one
  family; `GENERATE_BOOK` and an owning `COMPILE_EXPORT` match by type; fan-out jobs match by
  `pageId` / cover; edits (`APPLY_BOOK_EDIT`, `CONTINUE_BOOK`, `REPLAN_BOOK`) match by `operationId`.
  A detached repair wearing `COMPILE_EXPORT` is not a retry of the generation compile, and another
  page (or another edit) completing must not hide work that is still failed. Both reporting surfaces
  read it through `findCurrentOwningFailure`.
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
both `projectStatus.ts` and `mobile/projectSummarySerializers.ts` read through: newest owning compile
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

- **The app's quality card is the reader's findings, in the fields installed builds already read,
  and the console's diagnostics never cross the wire.** Since 2026-10-15 a compile's report is
  split (`readerPolicy` set; core `readerFindings.ts`, Parsa's "verified defects only"):
  `normalizeProjectQuality` (`../projectStatus.ts`) puts the reader's findings in `issues`, keeps
  `state`, `score` and `affectedPageIndexes` as graded from them, and hands the rest of the ledger
  over as `diagnosticIssues`, which the operator status route serves and the console's "Quality
  verdict" card draws apart (`apps/web/src/features/projects/QualitySection.tsx`).
  `qualityForReader` drops `diagnosticIssues` on the way to the app, so the mobile wire only gained
  `readerPolicy` and lost nothing an installed build parses (`MobileProjectQuality` reads `state`,
  `score`, `issues` and `affectedPageIndexes`). A report made before the split is served exactly as
  it was graded, `qualityWithExportsOnDisk` and the reviewer-uncertainty filter included, because
  the project status the app also reads (REVIEW_REQUIRED or COMPLETE) was decided from it and a card
  re-graded under the new rule would contradict that status; the book's next owning compile grades
  it the new way. Nothing in a split report blocks today, so a new compile publishes COMPLETE and
  "passed" with an empty list is the common card.

- **A reader's own stop or delete refunds only what was not delivered, and an ended month's
  allowance lapses instead of turning permanent.** The ledger half — what counts as delivered, how
  it is priced, the ceiling and the lapse — is in `packages/db/CLAUDE.md`. The API half is *when*
  it is decided: inside the stop's own transaction. `stopProjectGenerationJobs` calls
  `recordUserStopSettlementTx` for each attempt that transaction claimed (`count === 1`), right
  after stamping its `refundPending` and before commit. Both delete routes delete the project the
  moment the stop returns, and the cascade takes the pages with it, so a settlement that counted
  later — the reconciler, after the post-commit `failGenerationAttempt` failed — would find nothing
  delivered and refund whole. An attempt the stop did not claim already belongs to the settlement
  that got there first, a failure the reader did not cause, and is left unstamped. Every caller is
  the reader's own: the mobile delete, account deletion (the owner asked for it), and the operator
  console's stop and delete, which reach only the operator's own books (`ownedProjectWhere`). The
  worker needs no twin of this: `markStopped`, the reconciler and the legacy fallbacks all settle
  the one stamped charge, so the stop and the worker cannot disagree about what a user stop is
  owed. What the stamp can price depends on the quote stored beside the charge, and that is this
  directory's half too: plan approval stores the full book's, the chat rebuild
  (`replanCopyOperations.ts`) stores `estimateBookReplanCreditCost`'s — only when it is the price
  being charged, so a price save between the two reads leaves none and the stop refunds whole —
  and the audiobook start stores the narration's (launch review 2026-10-13, H3: a rebuild's copy and
  a narration are read while they are made, and both came back whole on a delete). The attempt-less
  rows still settle whole through `settleLegacyStoppedJobs`
  (`apps/api/src/stopLegacySettlement.ts`, split out of `queue.ts` at its size budget), and the
  ledger's ceiling stops that walk reaching past a stamp on an attempt's charge, or into a charge
  whose attempt SUCCEEDED at all. The reader is told
  before and after: the delete dialog (`deleteProjectConfirmationMessage` in `book_screen.dart`)
  says a book still being written keeps what was made and an ended month's credits do not come
  back, and the credit log titles the refund `… stopped: unused credits returned` and a lapsed
  share `Returned monthly credits expired` (`creditLog.ts`). Not settled yet: a paid retry
  (`/resume`) of an attempt a stop settled in part re-charges the whole quote and claims another
  illustrated-book slot while the generator keeps the pages already written. Today only the
  operator console can reach it, because the app's only stop is a delete.

- **The Word route refuses a free account before it reads a byte or queues a repair, and charges
  a subscriber nothing.** The Word file (shipped 2026-09-06) is a plan perk:
  `routes/exports.ts` registers one route per format in the core registry, and a format whose
  `exportRequiresSubscription` is true asks `hasActiveSubscriptionEntitlement` — a fresh read, never
  the 60-second `isSubscriberForRateLimit` cache, which reads a lookup failure as "free" — right
  after the owner lookup and *before* `readProjectExportArtifact` and `ensureExportRepairQueued`,
  because a repair compile for a file the reader cannot download is spend for nothing. The answer
  is `sendSubscriptionRequired`, 403 `SUBSCRIPTION_REQUIRED`: the manuscript-import route's code,
  so every shipped app already opens the paywall on it. The subscription gates the *format* and is
  never a price: until 2026-10-15 the per-book `EXPORT_UNLOCK` also gated the *book*, so a
  subscriber who had not unlocked the PDF paid 150 for the Word file after the bytes were read;
  now a subscriber's Word download, like every PDF and EPUB, charges nothing and writes nothing
  ("A finished book downloads free" above).
  `missingExportFormat` answers in registry order (pdf, epub, docx), so a book compiled before the
  Word export existed queues one detached Word repair on its next status read — Chromium-free and
  model-free, at most one per five-minute window, keyed `repair-docx-…` so it never shares the
  EPUB's window — and `qualityWithExportsOnDisk` drops `DOCX_EXPORT_FAILED` the same way it drops
  the EPUB's issue once the file is on disk.   The DTO carries `requiresSubscription` per format so
  the app draws the lock from the export entry beside its own billing state rather than asking for
  a second read, and ships `label` from the same registry; the route enforces the lock regardless.

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
  for both: one `mediaSettings` field plus a recompile, no `BookEditOperation`, no ledger entry. The
  preference/EDITING/revision update and the undispatched `COMPILE_EXPORT` row are one database
  transaction; only after it commits does the API push that row to BullMQ. A crash in the handoff
  therefore leaves the durable row for `reconcileUndispatchedGenerationJobs`, never a committed
  presentation revision with no policy source for worker recovery. **Free does not mean
  lifecycle-free:** when another project job is open, `routes/projectChat.ts` saves either
  presentation request through `busyEditReply` and resumes it after that owner settles. Letting it
  pass the busy gate makes its transaction meet an ordinary edit's `EDITING` with no presentation
  predecessor to supply the settled-status fallback; guessing one would let the reprint steal that
  edit's lifecycle and quality policy.
- **A picture book's page design is not page text either, and it is changed only where it shows.**
  A children's book printed one scene a sheet without pictures wears a design from the catalog in
  `packages/core/src/generation/storyPageDesigns.ts` — night sky, under the sea, fairy tale, plain
  classic… — chosen from its own words unless the reader picked one. "Make the pages look like the
  night sky", "plain layout please", "change the design" is a `page_design` intent
  (`apps/api/src/bookEditPageDesign.ts`, matching router edit target and `pageDesign` field): free,
  it sets `mediaSettings.storyPageDesign` through `applyPresentationPreference`
  (`mobile/pageDesignEdits.ts`), and both compiles read it back through `storyPageDesignFor`. The
  recogniser needs a design word *next to* a look-word and refuses a named page, "writing style",
  "the story's theme", the cover, the illustrations and the font, because each of those is a real
  edit a free reprint would answer with nothing; "something different" (no design named, or the
  only one named refused) picks the book's own match or the next design, never plain; "which
  designs are there?" is answered from the catalog, changes nothing, and is allowed while a job
  runs. **The preference is written only where the stylesheet dresses the sheets** — the story
  layout (`storyPageLayoutFor`) with no picture, figure, table or code in any scene and no
  illustration row on a page. Anywhere else the edit says so and changes nothing: writing it would
  recompile an identical book and tell the reader it changed. The three presentation kinds are
  dispatched from `mobile/presentationIntents.ts`.
- **A book's title is not page text either, and only an AI cover makes changing it cost anything.**
  "Change the book title to …" was quoted as a 550-credit whole-book rebuild (2026-10-02): nothing
  recognised it, the router prompt had no target for it, and the model-free battery listed "title"
  beside the premise and the ending. It is a `book_title` intent now (`bookEditBookTitle.ts` reads a
  title the reader spelled out before the router — past the matter guard too when the whole message
  is the rename (`isWholeBookTitleRename`), so "Rename the book to 'The Dedication'" stays free; the router's `book_title` target writes one when
  they asked for it to be invented; the heuristics ask "What should the new title be?" instead of
  rebuilding). `bookTitleEdits.ts` writes the title to the project row *and* the current plan — the
  app, cover typesetting and file names read the first, the compile's title page, cover alt text and
  EPUB/Word metadata the second — through `commitCoverChange` (`coverChange.ts`, shared with the
  Studio's cover routes), one transaction with the revision bump, the presentation reprint and the
  cover row. **What it costs is the cover's**: a designed cover is re-set free in the design it
  wears (a revision-owned cover row, with `coverArtSource: "design"` written into the plan snapshot
  too, because the cover job reads its source there); no cover, or an uploaded one, has nothing to
  redraw; a drawn cover that kept its artwork (`ai-kept`, every cover drawn since 2026-10-06) is
  re-set over it free (`drawCover.retypeset`); an older AI cover holds the old title in its pixels
  and its artwork is not stored apart, so the change is a card priced at `coverRegeneration`, charged and settled like the Studio's paid cover,
  and claimed by a `BOOK_TITLE` operation row so Cancel and Apply cannot both win. A cover row that
  names neither a design nor an upload is read as AI — a cover from before the source was recorded
  was drawn by a model, and read as a design it would be swapped for a fresh pick, free. A
  children's book with no chosen page design has the one its old title picked written down, or the
  new title could re-dress it. An author's book (a Studio book or an import) is sent to the Studio's
  settings, whose publish already re-typesets its cover; a chat write would leave the Studio's
  published record behind.
- **A book's matter pages are its own copy of the author profile, and changing them is free.**
  The pen name, bio, website, copyright holder, imprint and rights toggle live on `AuthorProfile`
  (`authorProfile.ts`, `GET/PUT /api/mobile/author-profile`); every new book — generated, imported,
  Studio — copies them into `Project.authorName` and `Project.bookMatter` at creation
  (`authorDefaultsForNewBook`), and the creation route asks nothing. A book made from a share remix
  is the remixer's own new book and takes the remixer's profile; nothing of the shared book's matter
  crosses. Editing the profile
  never reprints a published book. **The chat reads the profile, though, because a book made before
  it was filled in has none of it**: "include my info in the cover pages" on such a book was asked
  for the name again, and "Whatever I added in my profile" was told no matter change was found
  (2026-10-17, "The Last Table"). The matter composer is shown the profile as a new book would copy
  it (`savedAuthorProfile` in `bookMatterChatEdits.ts`), its values ground a change like the
  reader's own words, and a message pointing at it ("use my profile", "add my author info") asks for
  the fields a change copies from it exactly — sets only, "All rights reserved" included — through
  the profile door in core `authoring/bookMatterProfile.ts`. An unreadable profile is no profile.
  `PATCH /api/mobile/projects/:id/book-matter`
  (`bookMatterEdits.ts`) changes one book: on a finished book through `commitCoverChange`, the
  title edit's transaction, with a free reprint and a free re-set of a design or `ai-kept` cover
  (an older drawn cover answers `keeps_old_name` rather than a price nobody asked for); on a book
  still being written as a plain row write the first compile prints — **refused while a
  `COMPILE_EXPORT` is open**, because that compile read the row when it started and would publish
  without the change; refused while EDITING. An ISBN is checked on this PATCH as in the chat (check
  digit; `INVALID_ISBN`, stored as typed with a leading "ISBN" label dropped, since the page prints
  it; the label comes off before the 24-character limit is checked). The whole decision is taken under the Project row's
  `FOR UPDATE`, re-reading status and matter there, so a first compile that publishes while the
  request waits sends it down the reprint path instead of writing behind the published files.
  Cover reads inside that lock use the same transaction client (`currentCoverKind(projectId, tx)`);
  reaching for the global Prisma client there needs a second pooled connection and can stall
  concurrent saves while each transaction holds its first connection.
  A new compile row's Project foreign key takes `FOR KEY SHARE`, which conflicts with that lock:
  insertion waits for the save to commit, or the save waits and sees the open compile. Keep the
  explicit `FOR UPDATE`; a non-key column update alone takes a weaker lock. Fan-in can still read
  the old byline before insertion, so `compileExport` rechecks cover drift against its fresh snapshot.
  **The chat reaches the same write, and a model composes it.** Every matter field — the printed
  author name, the dedication, About the Author, the website, the © holder, the publisher, the
  ISBN, the "All rights reserved" toggle — is one free `book_matter` intent: no operation, no ledger
  entry, no card, never a page rewrite (the byline rule tells writers never to put a dedication in
  page text). *Whether* is the router's `book_matter` target, shown the book's matter
  (`bookMatterForRouter`), with `mentionsBookMatter` (`bookEditMatter.ts`) as the model-free
  detector for an outage and as the guard that keeps a matter request off the fast paths (the
  Sources recogniser read "add a dedication: For my sources of strength" as Sources; the exact
  replacement read "replace the dedication with a poem"). Bare "dedicated" and "dedicate a chapter
  to…" are content, and so is a matter word in a request that names a page by number ("rewrite
  page 4 so the publisher sounds meaner") — except the dedication, dedicating the book, the ISBN and
  "All rights reserved", which stay matter there (`evenOnAPage`). It is decided per request, not
  per sentence — a message splits where a new request starts (an edit verb, "can you", "page N"),
  never at every comma — so "Change the publisher to Lantern and make page 2 shorter" is a matter
  edit whose reply names the page edit as separate. Prose-word exclusions apply to the cue's own
  clause too; another clause's "chapter" cannot suppress a publisher or byline change. Translated
  boundaries are shared with the composer and work in either request order. A whole-message rename is let past
  the guard (above); an unquoted new title with a matter word after a break still goes to the router. *What* is composed at apply time (`bookMatterChatEdits.ts`, prompt and decisions in
  core `authoring/bookMatterChatEdit.ts`, the field cues, folding, ISBN check and quote test beside it
  in `authoring/bookMatterWords.ts`, which fields may change in `authoring/bookMatterAskedFor.ts`, the
  left-over and `runs_on` reading in `authoring/bookMatterRequests.ts`) by one time-boxed call on the
  chat's routing model, shown
  the message, the last turns, the book's language and the **current** matter, because a matter
  edit is an edit: the regex extractor this replaced (2026-10-06 review) printed "For mention my
  sister too", the tail of "and redo the cover", "For a poem", and deleted a whole dedication for
  "remove my ex's name from the dedication" — it never saw the dedication it was editing. Code then
  keeps only fields the reader asked for, and **what that gate exists to stop is a second field
  nobody asked for** (a Persian dedication request once also turned on "All rights reserved" and
  deleted the bio). A change is kept when its quote — whole words of the message — names its field
  by cue, or by the value the field prints now (a publisher, holder or author name whole, an ISBN by
  its digits, a website by its host, a dedication or bio by three running words of it: "Remove
  Lantern Press", "take Ruiz Media off the book"), unless another change in the answer prints that
  value as its own content; when a name change's quote holds both the old and the new name ("Change
  Ana Ruiz to Ana Park, my publisher prefers it"); when its quote
  names no field and the last matter reply changed or asked about that field (follow-ups point back:
  "mention my sister in it too", "make it shorter"); or when it is the answer's only change and the
  message names no other field ("Sam Lee wrote this book"). A cue word that the change itself prints
  is its content, not a request for another field ("add that I'm a proud dog owner" is not the ©
  holder), and a rider that quotes only words another change prints is that change's content, not
  a second field. This includes a cue inside unspaced text: a Chinese dedication to a mother who
  works at a publishing house names no publisher to remove. A separate removal still counts when
  the request names the publisher again outside the supplied dedication.
  Never "All rights reserved", and never the removal of a field nothing named, by
  either of the last two. A gate that kept only cue-named fields dropped 38 of 40
  follow-ups and 48 of 76 bylines (`bookMatterAskedFor.measured.test.ts`, written before the gate:
  40/40, 76/76 and 24/24 single-field requests that never name the field kept; 25/25 unasked riders
  dropped; then 70/70 follow-ups whose content holds another field's cue word, and 0 of 38 riders
  kept, including byline removals quoting the whole message; then 34/37 changes named by value and
  18/18 renames quoted whole kept, and 0 of 28 removals that rode on a cue word the asked bio or
  dedication prints). The cues (in English, Persian,
  Arabic and the major European and Asian languages; "copyright" never names "All rights
  reserved", which only an explicit request sets; "author", "writer", "co-author", "make the author
  X", "X is the author", "the author needs to be X", "the book is by X", "credit the book to X",
  "list me as X", "put X on the title page", "publish it as / under the name X", "credited to X",
  "sign it as X", "X wrote this book", "my real/full/legal/maiden name", "written by" in five
  languages, Persian "X نویسنده‌ی
  کتاب است" and the European nouns (autor, auteur, Autorin, autore…) in the same shapes name the
  byline, while "about the author", "author bio", "the author's note", "as the author would",
  "writers block", "the author of two novels", "publish it as an ebook", "credited to the publisher"
  (the imprint), "Ich arbeite als Autorin" and "نویسنده رو معرفی کن" never do; "owner" names the ©
  holder and "site"/"web" the website only in request shapes — "copyright owner", "Owner:", "my
  site" — never as content) still decide a
  message that changes several fields. Turkish bylines recognize name and pen-name phrases with
  possessive/object suffixes and dotted-I forms, while a profession or biography mention alone
  names no byline; compound requests keep each explicitly named field.
  **They read whitespace-folded text, and no pattern puts an
  optional separator inside a repetition, and no name or stem pattern reads an unbounded tail from a
  start inside a word**: one did the first, and a single 5,000-character message held the API's
  event loop for 97 s; a name tail did the second for 1.3 s on joined capitals (`Ab’Ab’…`). The
  10k-character timing batteries in `bookMatterWords.test.ts` and `bookEditMatter.test.ts` are the
  guard; the page-count reader (`replanSettings.ts`, 57 s on "page" and spaces) and the
  end-anchored trims in `bookEditScopeText.ts`/`bookEditMessage.ts` were fixed for the same reason. Code also holds `BOOK_MATTER_LIMITS`, refuses an ISBN that
  fails its check digit or was never typed, and refuses facts nobody gave: a name, publisher or
  holder matched on whole words, a website equal to one the reader typed, and in a dedication or bio
  every number, address and capitalised name found nowhere in the reader's words or the current
  matter. Translated mother/father terms and finite grammatical forms in the book's language also
  pass when the source supplies that relationship (`bookMatterKinship.ts`); this exception applies
  to prose, never to identity fields. A capital inside a sentence is otherwise a name unless it is
  a closed-class word; **one that opens a
  sentence or a line is never checked by the capital heuristic**, whatever follows it — the rules
  that tried to tell "Sarah teaches math." from "Fittingly, gardening is how she recharges." refused
  about one honest bio in eight. Novel biographies and dedications instead require a complete-text
  grounding review, including sentence-initial names and credentials, in every language. Words joining names
  ("and", "with") may join a byline,
  holder or publisher the reader typed as separate names. Attached localized connectors are checked
  across the whole value before tokenization, trimming spaces only at connector boundaries; the
  original name spelling and internal spaces survive. The independent grounding review lives in
  `bookMatterProseGrounding.ts`. Complete text already supplied by the reader or current matter,
  and finite dedication wrappers whose complete recipient is supplied or a provable parent term,
  need no extra call. The
  reviewer sees the complete candidate and the reader's sources, including current matter;
  the composer's own claims cannot approve it. Its receipt is bound to the exact field, text and
  sources. Missing, malformed, incomplete or failed reviews leave the candidate unapproved and
  use the existing localized `not_given` reply, retaining any separate request. This one extra
  call takes at most 10 seconds within the composer's existing 20.5-second total envelope, with
  no repair or network retry. `MOCK_AI` leaves novel prose unapproved. Measured in
  `bookMatterChatEdit.measured.test.ts`: 86 bios and 50 dedications written for the test, none
  refused and none given a spurious left-over note (novel biographies and dedications supply a
  positive grounding-review fixture, testing normalization rather than model accuracy;
  a second batch of 33 passed on its first run);
  then 46 bios with "I also…" and refinements, 33 dedications and 45 bylines in seven languages,
  written before running: all passed but one byline and one of 36 negatives on the first run, both
  then fixed.
  Every reply names
  a left-over request — quoting it when the model returned the reader's words, generically when it
  paraphrased or code found an unreported "and redo the cover" — so nothing is dropped silently.
  Everything after the first field-naming colon (read with its colon, so "Author: J. R. Ellis.
  Redo the cover." names the cover, and initials like "S. J." or "Dr." end no sentence), the first
  "say"/"read" after a field's name, or a field's name followed by "to" ("change the dedication to
  For my students. Please keep asking questions.") is the field's own words, where only a request
  aimed at the editor counts: a book reference after an editor's verb ("redo the cover", "change the
  pictures in the book" — never "keep the pictures in this book close to your heart", spoken to the
  dedicatee) or a sentence-initial also/plus/lastly/finally — never a bare content noun, and never
  "then", "please" or "can you" alone, which leave it to what was printed. After "to", a clause the
  change did not print is still named back ("change the dedication to my mom and fix the typos").
  A translated cover noun must belong to this book: supplied Italian, Spanish or French prose about
  changing the cover of someone's notebook remains biography text, even when its verb also
  spells an imperative. An actual book-cover request beside that prose still needs a left-over note.
  "Add a dedication: For my daughter. Keep drawing." and "…Please write to me." print, "…For my mom.
  Also redo the cover." names the cover, and a value that runs on into an editor's request is
  refused as `runs_on`, never printed. A mid-sentence also/then/plus starts a new clause only at a
  boundary — sentence start, comma, semicolon, dash, "and"/"but", past an aside — and never after a
  subject, so "She and her husband also make cheese" and "Good stories also make good people" are
  the reader's own sentences (47/47 such values, 25/25 dedication lines about the book, 24/24
  unquoted "change X to …" and 25/25 compound messages measured in
  `bookMatterChatEdit.measured.test.ts`). Anywhere, a style instruction
  about the field ("use third person", "keep my age out of it"), a refinement whose object the
  change printed ("Also add my dad" beside "For my mom and dad"), a request clause the change
  printed (light stemming, pronouns swapped) or one continuing the reader's own "I …" is content,
  not a left-over; "None." or "N/A" as `unhandled` is nothing left over;
  then it screens, splits off the Studio-owned fields of an author's book, and calls
  `applyBookMatterPatch`. A failed or timed-out call writes nothing and says so (and points at the
  Title & credits sheet). Under `MOCK_AI` the composer is `fakeBookMatterChatEdit` (core
  `adapters/`), a deterministic stand-in that answers in the composer's own schema, so the
  normalizer above runs on its reply: it changes only shapes whose matter part visibly ends — a
  quoted dedication, "dedicate it to <short noun phrase>" closing the message (English books only),
  a bare "remove the dedication", "the ISBN is <digits>" — names back what follows a sentence break
  or "and/also/then" as `unhandled`, word for word, and asks the question for everything else. It
  guesses nothing, because its first regex printed "For my mom and redo the cover". A missing
  value is the request's one question, stored as `clarification: "matter"` so the answer always
  merges as the follow-up — never read as a scope ("For my mom, who stood by me throughout") — and a
  second is never asked: once it has been, every
  reply — refusals included — is a statement saying what to send in one message or pointing at Title
  & credits, and sets no `pendingEdit`. What the message asked
  beyond the matter is named back ("… is a separate change — send it as its own message"), never
  silently dropped; the reply's `bookMatterEdit: { before, after }` keeps what an
  undo would need, and every value the reply quotes is kept literal (`chatMarkdownLiteral`), because
  the bubble is light markdown and the page prints "For *Mom*" with its asterisks. Its invisible
  marks are the bubble's alone: the router and the composer read saved replies through
  `withoutChatMarkdownLiteral`, and `cleanMatterText` drops any a model copied anyway, because
  stored they print invisibly and split the words grounding compares. Replies use the
  conversation language, independently of the book language. The router selects `responseLanguage`
  from the request and recent conversation; the matter composer can refine it in its existing call.
  The conversation-language vocabulary covers all 25 app languages, independently of the narrower
  deterministic matter-request grammars. The schema and fixed matter, credit and busy replies share
  that vocabulary, so a supported language cannot silently fall back to English — and so do the
  chat's own cancel and busy undo/redo replies (`projectChatReplyCopy.ts`) and every book-title
  reply (`bookTitleChatCopy.ts`), which record `replyLanguage` the same way.
  `matterChatLanguage` validates that model decision, falling back to the latest saved assistant
  `replyLanguage` or `intent.responseLanguage`, then English. It never infers language from words or
  scripts. The saved language reaches the router and composer as `conversationLanguage`, so bare
  values retain context; with none saved the field is omitted (`establishedChatLanguage`), never
  the English default, which told both prompts a pre-language Persian chat was English. Quoted values keep their exact spelling. Localized copy derives every
  saved-change, refusal, cover and export claim from the validated decision and actual outcome.
  Busy replies use the same decision and persist `replyLanguage` with the saved request, so its
  later resumption keeps the conversation language. The quoted `apply it` command remains literal
  because the pending-edit confirmation parser accepts that spelling.
  "Remove the title
  page" is answered: every book keeps one — and so is a removal inside a compound message
  (`asksToRemoveTitlePage`, which carries a "don't" across a comma and shares a removal verb with a
  verbless "and the title page"), whose change reply adds that the title page stays. The instant
  answer is refused whenever the rest of the message names a field by core's own cues
  (`bookMatterFieldsNamedIn`), so "Author: Sam Lee. Remove the title page." reaches the composer. The demotion to a
  question is skipped for `book_matter` — its composer asks, and the router's text is a
  confirmation. **Front matter is named to the router** (`readerPageContext.frontMatter`, from
  `frontMatterForProject`): a covered book's title page precedes its matter sheet, which can span
  several pages. The map's cover flag also names an unnumbered fallback title, so front-matter
  page counts cannot identify the first numbered sheet. Ambiguous pages, and maps without a
  matching revision stamp, get neutral labels. `withoutFurniturePageEdit` takes a page edit the router still aimed only at printed
  furniture off it — a text edit of front matter to `book_matter`; a delete or move of it, and any
  edit of the Contents or back matter, to the furniture answer. Both replacements retain the
  router's `responseLanguage`, including when a later composer call fails before it can refine the
  language. And since About the Author can now be the first back
  matter, the chat names that page by what the book prints there (`bookPageNumbering.ts`), and the
  router is sent `backMatterStartPage`, never `sourcesStartPage`. An author's book takes its byline and dedication from
  the Studio (`SET_IN_STUDIO`): publish writes the Studio's dedication onto `bookMatter`, and a
  takeover seeds the Studio's from it. Every field is screened on its own, as printed text
  (`matterContentScreen.ts`, `assessContentRestrictions(…, { printed: true })`), because it is
  printed and shared: the child-exploitation names and the operator's copyright rule apply, while
  the request-shaped rules — "how to" beside an attack, "fake" beside a passport — do not, because
  they refused memorial dedications and history bios, and screened together two fields that passed
  alone were refused as a pair. The 422's `fields` names exactly the fields refused by their own
  words. The chat message itself is still screened as a request before routing, so a memorial
  dedication typed into the chat can be refused there; the Title & credits sheet takes it. The account's display name is only ever
  `suggestedPenName` — books are public through `/s/`, and printing a real name is the reader's call.
  "Made with Tomeza" is the free tier's (Parsa, 2026-10-06), decided per compile, never stored.
  Subscribing re-renders nothing — a library reprinted on one purchase is a compile burst for books
  nobody opened — so a subscriber takes the line off one book at a time, free:
  `POST …/book-matter/remove-credit` and the chat's `tomeza_credit` intent share `removeTomezaCredit`
  (`tomezaCredit.ts`), a fresh plan read then a no-change `commitCoverChange` reprint, while a free
  account gets 403 `SUBSCRIPTION_REQUIRED` (the chat: a plan offer). Whether there is anything to
  take off is read from the published `book.md` (`creditPrinted`), never from the plan, because a
  book compiled before the purchase still prints it. While the book is EDITING it reads false and a
  removal answers that the book is being updated — and promises nothing, because not every EDITING
  window ends in a recompile: "if the line is still there once it's ready, ask again". A
  subscriber's book still being written needs nothing: its first compile leaves the line out, and
  the chat and the route say the same.
  Credit-removal replies use `matterChatLanguage` above and save `replyLanguage` for follow-ups.
  A precise removal (`isTomezaCreditRemoval`) never reaches the router: its language was the
  router's only contribution, a paid tool loop per request. Those shapes are English alone, so any
  other language still routes; a recognised request keeps the established `conversationLanguage`
  (the fallback a failed router call takes), else English — an English removal no longer switches
  a Persian chat back to English, while the next message the router reads still can. Localized copy in
  `tomezaCreditChatCopy.ts` follows the actual removal outcome, including the plan offer.
- **An imported manuscript's own matter is lifted into the book's matter and out of its pages, so it prints once.**
  The compiler prints a title page, the matter sheet and About the Author for every book, and an
  import used to keep the manuscript's own as chapters beside them — a .docx ending "About the
  Author" printed two bios, its © page two © statements. `separateManuscriptMatter` (core
  `ingestion/manuscriptMatter.ts`) runs in every import format: only standalone sections at the very
  front or back (a heading's section, an EPUB file, a page the author ended with a page break) are
  read, as whole-line headings in the compiler's languages, so a mid-book "About the Author" chapter
  stays content. Plain text and RTF also split at localized numbered chapter headings through
  core's `manuscriptHeadingLines.ts`; otherwise a middle bio heading can swallow the following
  chapter and look like back matter. Written chapter numbers need the same boundary protection
  beyond ten, including compounds such as Persian «فصل بیست و یکم» and French «Chapitre vingt-deux».
  Translated chapter words alone are too broad to split prose.
  Older story EPUBs combined Sources and the biography in one file. `epubMatterBlocks` recognizes
  the compiler's empty `book-about-author` marker immediately after its heading as a boundary;
  ordinary body subheadings remain in their original section.
  The manuscript's words win and the profile fills only what it does not say
  (`bookMatterForImportedManuscript`, called from `mobileImports.ts`): its bio and dedication are
  lifted into `bookMatter` (left in the pages when too long for the field, and then the profile's
  bio is left out); its © page gives the holder, `copyrightYear`, the rights line, the ISBN and the
  publisher, and is dropped only when nothing else is left on it (a "Cover design by …" line keeps
  it); a title page is dropped only when every line maps to something the house title page prints
  (title, `Project.subtitle`, byline, publisher). The compiler's colonless localized author labels
  require a matching known author, supplied by DOCX core properties, EPUB creator metadata or the
  upload's saved hints; document metadata corroborates a printed byline rather than supplying one.
  An unheaded sheet combining a dedication and publication details is split at its recognized
  publication boundary: the dedication-shaped prefix is lifted, then the existing copyright rules
  read the remainder. Explicit dedication headings and EPUB hints keep their entire text literal.
  A Contents page is dropped only when every entry names a
  heading in the book. Nothing is removed that does not land in `bookMatter` or is the legal
  boilerplate the compiler reprints. The API persists its upload-time `knownAuthors` in the durable
  import payload, including an empty array, and the worker reuses it so later byline edits cannot
  change which manuscript lines become body text. Legacy jobs without hints keep the prior byline
  fallback. The merged manuscript/profile matter is screened field by field as printed text before
  upload storage or an import quota claim. Legacy worker restoration screens the fields it will
  write under the Project lock, using the same pure policy from core, and drops a refused field
  alone rather than failing the import: no reader is there to fix it, and the old import never
  lifted it (`screenRestoredImportMatter`; run-log `import.matter_refused` names field and
  reason, never the words). Sharing screens the stored
  byline and matter too, so older records pass the policy before publication.
  The old EPUB rule — any section under 1,500 characters whose title began like matter was
  deleted, a bio included — is gone; it also deleted short chapters.
- **A chat matter change is kept when the reader named it, pointed back to it, or asked for it alone — never a second field nobody named.**
  "Named" is by a cue or by the value the field prints now. `changesAskedFor` (core
  `authoring/bookMatterAskedFor.ts`) is the whole rule, fed by
  `matterFieldsOfLastReply` (`bookMatterChatEdits.ts`), which reads the nearer of the last two
  assistant turns. Its job is the incident in the bullet above — a model that also turned on "All
  rights reserved" and deleted the bio — and nothing else: a gate that kept only cue-named fields
  dropped follow-ups that point back ("mention my sister in it too") and a third of bylines, which is
  a check refusing the reader's input far past the ~99% bar. So a quote naming no field may change
  the field the last matter reply changed or asked about, and a lone change may stand when the
  message names no other field beyond the words that change prints; a rider repeating another
  change's printed content is not a second field; neither door opens for "All rights reserved" or
  for removing a field nothing named. A clarification inherits its original request through these
  same content-ownership checks: "Write my bio: I am a publisher" authorizes the biography, while
  "publisher" inside its supplied prose authorizes no imprint removal. Terse answers still inherit
  genuine requests, including separate compound changes and fields named by their current value.
- **Every model call the book chat makes inline writes its cost row.** `routes/projectChat.ts`
  wraps the routing model with `withInlineProviderUsage` (`../inlineProviderUsage.ts`) for the
  message route and the proposal Apply/Cancel routes, so the edit router, the book-matter composer
  and every follow-up call write a `ProviderCallLog` row under the book (`generationJobId: null`,
  which the Operations tab reads as unbilled inline spend), priced only from token counts the
  provider reported. Before, none of them did, and the Costs tab could not see the chat at all.
  Streamed text passes through unrecorded, as everywhere inline: it is priced from no guess.
- **A request about one kind of content is an edit of the pages that carry it, and the router is
  told what each page carries.** The router sees page titles and summaries, and a summary does not
  say whether a page has a code block; "Use JavaScript in the codes" therefore routed as
  `whole_book` on 2026-09-06, quoting and re-drafting four pages that had no code at all (the
  worker's patch tier now declines those, but they were still priced). `loadChatPageFeatures`
  (`projectChat.ts`) counts each page's fenced code blocks in SQL — bound-parameter patterns,
  because a template literal cannot hold the backticks — and `chatPagesForProject` puts
  `codeBlocks` on `BookEditPageContext` when a caller loaded them; absent means unknown, never
  zero. The router payload carries it per page entry and the prompt says a request about one kind
  of content (code, a figure, a picture, a named character, a quoted phrase) is `pages` naming the
  entries that show it, even when the user says "all" or "throughout", with `read_page` for the
  cases the entries cannot tell. The model-free twin is `codeLanguageRequest` +
  `pageIndexesNeedingCodeLanguage` (`bookEditCodeScope.ts`, read by `bookEditHeuristics.ts`): a
  code request that names one language and is not asking to *add* code is an `explicit_pages`
  rewrite of the pages whose blocks are not already in it, and it counts as change intent, since "use X in the codes" carries none of the edit verbs — routed on a
  router outage it used to be answered rather than edited. With no features loaded the heuristic
  guesses no pages. **The same query reads each page's fence tags (`codeLanguages`), because
  which pages carry code is only half the question.** The first reader to try the scoped router
  sent "Use JavaScript in the codes" straight after "On pages 3 and 4, use Python…": the router
  carried those two pages out of `recentConversation` into the new request, both were already
  JavaScript, the patch tier declined both, and the card said "Nothing was changed" over five
  Python pages. So `narrowCodeLanguageIntent` (`bookEditCodeScope.ts`) runs on every path out of
  `classifyProjectChatMessage`: a `page_rewrite` whose message names code and exactly one
  language (`codeLanguageRequest`) is scoped to the pages whose tags are not already that language
  (`pageNeedsCodeLanguage`; unknown tags count as needing it, since a declined patch is one cheap
  call and a dropped page is a request left half done); a message naming no page and sent from no
  reader selection is scoped over every code page, whatever the previous turn named; and when no
  page needs it the reply is an `answer` — "The code in this book is already in JavaScript" —
  rather than a priced no-op. The router prompt says both halves too. It never widens past the
  pages that carry code and never touches `local_patch`, whose literal may sit in prose on a page
  whose fences are all the named language.
- **A verified exact replacement is free, and the verification is what makes it safe.**
  Exact eligibility is proved from the complete standalone `editInstruction`, never inferred by
  taking everything between a replacement verb and its connector. Unquoted terms must each be one
  atomic token; multiword phrases, roles ("the hero Rabbit") and punctuation need explicit quotes —
  only "the word / term / name X" is read as naming X. A message that *is* one such swap is
  recognised before the router (`exactReplacementIntentFromMessage`), because the router rewrote
  "replace the word tray with saucer everywhere" into a plural-aware instruction the parse refused
  and quoted a model edit of every page; a word the book does not hold is told so, never priced. Two
  plain lowercase words swap as words (`wordForms`): the regular plural, and the capitalised form
  only where English capitalises any word (sentence start, heading, title) — a mid-sentence "Rose"
  is a name. The queue payload drops the flag, so the worker re-derives it from the instruction. Router
  `replacementFrom`/`replacementTo` fields only corroborate that shared core parse, and an
  incomplete or disagreeing pair is stored as an explicit null on the intent so proposal rebuild,
  Apply and worker redelivery cannot re-enable the fast path by parsing again without that evidence.
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

The library routes split by what they write, not by which noun is in the path.
`routes/characters.ts` owns the record and its prose — the list, create, PATCH, delete — which is
the lane that claims sibling rows and shares one client budget. `routes/characterImages.ts` owns
every route that moves the two picture pointers: the photo upload, the priced portrait job, the
byte GETs, and the retained history behind them. They register on one Fastify instance, so the
`application/octet-stream` parser covers the upload wherever its file sits.

Mentions split the same way — by what the code does to a row, not by the noun in it.
`libraryMentionRows.ts` holds the readings of a row that is already stored and touches no client:
`libraryMentionRefs` (the wire list), `claimingNames` (who may hold a span of prose) and
`survivingMentionIds` (what an old client's edit leaves behind). `libraryMentionGraph.ts` reads the
library by id and walks the links behind a tapped cast. `libraryMentionLinks.ts` is the outgoing
write — the complete link set one description owns, and the two constants that keep its `deleteMany`
and its `createMany` naming the same kinds. `libraryMentionRewrites.ts` is the incoming direction:
every *other* description, claimed as a set under the target's own `FOR UPDATE`, when that target is
renamed or deleted. The readings are one file because of the one-candidate-set rule below — a span
the write binds has to be one all three of them can still find.

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
  the upload. Every *vision* failure here (no vision key, a refusal, a timeout) stores the photo and
  answers 200; `CHARACTER_PHOTO_VISION_BUDGET_MS` is not optional, because the Gemini client sets no
  request timeout and Fastify sets none either. The one non-200 exit after the writes is a character
  deleted mid-upload, and it is a 404: the handler's first read is deliberately the lean
  `ownedCharacter` (it wants a name and an id, and joining the mention graph in front of a
  multi-second vision call bought nothing), so the row it would once have fallen back to predates
  every write the handler just made and would have answered `hasPhoto: false` for the picture it
  had just stored. `DELETE /:id/photo` is a **pointer clear and nothing else** now — it nulls
  `photoPath`, `photoKind` and `suggestedDescription` and leaves every reference and every byte
  where they are. It used to unlink the file and drop an *adopted* reference with it, on the
  grounds that the reader had swapped the picture out; retaining every version made that untrue —
  the artwork is still in the strip and still what the books draw — and the app calls the per-image
  delete instead, so the route stays only for clients already in the wild. An upload never lands on
  a READY generated portrait or on a row an open portrait job owns — silently, because an upload is
  not a portrait request.
- **A portrait start's prompt inputs are part of its command identity, never a test it is refused
  on.** `assertMatchingCommand` refuses a known `commandKey` whose stored `requestFingerprint` or
  `quotedCredits` moved, so where the fingerprint sits decides what a retained `requestId` can do:
  folded *into* the key, the same request replays onto one attempt and one charge while a moved
  input mints a key nothing has used and draws what the reader is now asking for; sat *beside* it,
  the same move is a 409. Beside it the fingerprint could never protect a live job anyway — a
  second tap while the portrait is QUEUED or GENERATING is refused by `PORTRAIT_OPEN_STATUSES` well
  before the ledger — so it only ever fired on a *settled* attempt, which is exactly where "start
  the new drawing" is the answer. It carried `hasPhoto`, and then `appearance`, and
  `storeCharacterPhotoUpload` moves `photoPath` and `appearance` together: the server writing a
  look the reader never touched turned Redraw into a permanent dead button, because
  `character_profile_screen.dart` clears `_portraitRequestId` only inside the try after a start it
  saw succeed, so the retained id could only 409 again until the screen was disposed. `cost` is in
  the key for the same reason — it is the other value the refusal is made on, and prices are
  operator-editable and re-read every 15s.
- **A mentioned character's sheet is supplemental context, never part of the approved edit
  instruction.** In the finished-book chat the sheets become `characterContext`, carried on
  `PendingEditState` so a clarify → confirm → Apply chain keeps them, then stored separately on the
  `BookEditOperation` and queue payload. Retry and recovery copy that field unchanged. The
  standalone operation `request`, payload `editInstruction` and `perPageInstructions` remain the
  reader-approved edit contract, byte-for-byte free of character sheets; adherence-bearing worker
  prompt builders place `characterContext` in its own supplemental section and adherence review
  judges only `editInstruction`. This split is load-bearing: `classifyProjectChatMessage`,
  `affectedPagesForIntent` and
  `exactReplacementFromMessage` read the bare message, while `applyBookEdit.ts` can substitute a
  page's own instruction for the whole-book one without losing the character canon.
  `requestWithCharacterContext` remains only at two compatibility boundaries whose existing
  consumer still expects a single derived string: the image insertion and layout payload
  request. Those payloads still carry the separate durable
  `characterContext` and bare `editInstruction`; the derived string is neither an adherence
  contract nor permission to compose sheets into `request`, `editInstruction`,
  `perPageInstructions`, or the `REVISE_PLAN` message. `REVISE_PLAN` follows `REPLAN_BOOK`:
  the worker composes `authoritativeReplanMessage` for the model and writes the approved
  `editInstruction` onto `planVersion.messages`. In the creation chat mentions are message-level
  `{id, name}` refs, so
  `activeThreadPayload` branch-filters them for free, and every turn re-reads the live rows so a
  library edit propagates; the build snapshot is the moment that stops. Where a *typed* `@name`
  ends is `isLibraryMentionNameCharacterAt` in core, which the build sweep calls rather than
  keeping its own copy, and its `\p{M}` is deliberate: it is the exact
  opposite of what `foldCharacterName` does with combining marks one package over, because a
  word-boundary test needs the mark that a spelling-fold has to drop. Both halves are argued
  together in `packages/core/src/generation/CLAUDE.md`; neither may be narrowed to agree with the
  other. The boundary rule is spelled twice — those core helpers, and the Dart composer's
  `_nameCharacter` — and the two only
  move together, because a token the composer refuses and the build sweep then binds is an
  invisible cast member. The rows themselves are read through `expandLibraryCharacterGraph`, which
  follows durable description links of `targetKind` CHARACTER outward from the mentioned
  characters: every explicitly tapped character always reaches the model, the ten-cap bounds
  only the linked expansion behind them, Location/Other edges on the same join are ignored, and
  the mention routes derive their 404 from its `missingIds` instead of a second read.

- **A character PATCH re-reads its own row under the claim, because the claim only asserts the
  name.** `claimCharacterRow` guards the rename race and nothing else, so everything the handler
  derived from the pre-transaction `ownedCharacter` snapshot — the description, and the link set
  `libraryMentionRefs` read off it — was still the request's own stale copy. Two devices editing
  one character was enough: a `{mentionedCharacterIds}` PATCH read `description`, a `{description}`
  PATCH from elsewhere committed first, the claim passed because the *name* never moved, and
  `body.data.description ?? character.description` wrote the old prose back over the new. The
  transaction now opens with a `findFirst` on its own row under `libraryMentionInclude` and drives
  the update, `replaceLibraryMentions`, `survivingMentionIds` and `rewriteIncomingLibraryMentions`
  off that `live` read; a row that moved out from under it raises `CharacterRowMovedError` and
  retries. The outer read survives for the 404 and for the name the claim asserts, and nothing
  else — and that is now a `select`, `characterClaimSubject`, so the compiler is what refuses the
  next attempt to read prose off the stale snapshot rather than a comment asking nobody to. The asymmetry was the tell: `claimedMentionSource` already went to lengths to re-read every
  *other* character under the claim, and the route never re-read itself.
- **The text a character write screens is the text it stores, and the text the request typed is
  refused before anything is claimed — so each route screens twice.**
  `enforceContentRestrictions` ran on the outer snapshot, which stopped being what gets stored the
  moment the update was driven off `live`: a PATCH carrying only `mentionedCharacterIds`
  canonicalizes and writes `live.description` — prose saved on another device that this request
  never passed through the screener. So the assessment runs on the row the `update` is about to
  leave behind: the merge of `live` and the patch, screened under the claim but *before*
  `rewriteIncomingLibraryMentions` and `replaceLibraryMentions`, with the canonicalized prose
  re-screened only when canonicalization actually moved the string.
  **That is the only screen that can read those strings, and it is the wrong place for the refusal
  almost every refused request earns.** Held there alone, a description nothing was ever going to
  store first claimed the row, claimed every character whose description mentions it — up to 99 —
  rewrote the ones that moved and rolled all of it back, with every other character write on that
  account queued behind the lock window for the length of it; create paid for the row and its whole
  link set the same way. So both routes screen what the body carries *before* the transaction
  opens and screen the stored row inside it: the door answers the reader's own prose, the inner one
  answers everything the reader never typed. The door alone did not settle it, because the prose
  it cannot see is exactly the prose that was paying that bill — a PATCH refused on a description
  saved from another device kept claiming the 99 and rolling them back until the inner screen moved
  ahead of the rewrites. Moving it also put the ladder in `sendCharacterWriteError` back the way it
  is written: a request that is both content-refused and too long for a sibling's description now
  answers the 422 rather than the `CHARACTER_MENTION_TOO_LONG` 409 the rewrite used to raise on the
  way past. Neither is redundant and neither is the other's
  fallback — `characterContentScreen.test.ts` records **which string** each screen was given,
  because canonicalization is case-only and `assessContentRestrictions` lowercases, so the verdict
  cannot tell the two orderings apart and would not until a rule stops being case-blind.
  `name` is reasoned about field by field rather than screened as a blanket copy: the claim asserts
  it, so the screened name and the stored one are the same string by construction, and `appearance`
  and `fields` are only ever written from the body. What the transaction cannot do is *answer*:
  `assessContentRestrictions` is synchronous but the operator flag behind it is a query on another
  pool connection, so `copyrightRestrictionsEnabled` is read before the transaction opens rather
  than while it holds up to 99 sibling row locks — and awaited *beside* the route's own read in one
  `Promise.all`, because neither needs the other and both are charged against the client budget
  below. A refusal throws `ContentRestrictedError` — which rolls the mention writes back with it
  and leaves the 422 to the catch, where every other answer on this route is written. That class
  lives beside the screen in `apps/api/src/contentRestrictions.ts` and carries the whole refusal, so
  the wire `code` is derived once by `contentRestrictionCode`; the route never spells one. **`POST`
  held the rule wrongly for longer**: it screened `request.body` and then stored whatever
  `replaceLibraryMentions` canonicalized — a case-only respelling that today's case-blind rules
  cannot tell apart, which is exactly why nothing caught it and why the ordering is worth pinning
  rather than arguing. Both routes read the rule out of `characterContentScreen.ts`
  (`characterContentText` + `assertCharacterContentAllowed`), which also owns the throw. On create
  the row and its links are written *before* the inner screen — a mention needs a source row to hang
  off — so the rollback is what keeps a refusal from leaving half a character behind, the same thing
  it does for PATCH's sibling descriptions.
  **A refusal's `reason` reaches the reader only if the route's 422 schema names it.** —
  fast-json-stringify drops what the response schema omits, which is how all three character
  surfaces came to answer `{code, message}` while `enforceContentRestrictions` was building three
  fields. `contentRestrictedError` in `apps/api/src/contentRestrictions.ts` is that declaration —
  beside `sendContentRestricted` rather than with the other OpenAPI fragments in `mobile/schemas.ts`,
  because the body and the schema that lets it out only work together.
- **Both mention-rewriting transactions claim every source in one statement, and the timeout that
  survives their ceiling is a 503, not a conflict.** `LIBRARY_CHARACTER_LIMIT_PER_USER` is 100, so
  up to 99 characters can name one target, and `rewriteIncomingLibraryMentions` /
  `unlinkIncomingLibraryMentions` used to issue a claim, a re-read and a write per source — around
  300 serial round trips at the cap, 81 measured for thirty sources, inside Prisma's default
  5-second interactive transaction, which a perfectly valid rename could exhaust while holding a
  row lock on all 99 of them. They now cost **five statements, whatever the library holds**: the
  target's own `FOR UPDATE` below, then `incomingMentionSources` reads the set,
  `claimCharacterRows` claims it in a single row-locking `SELECT` whose tuples still name every row
  by id, owner and the name the read found — a short row count is a row that moved and raises
  `CharacterRowMovedError`, exactly as the per-row `false` did — and the same query then runs again
  under the claim, because a source's own links
  can only move under its own claim, so the re-read that keeps a concurrent PATCH from being
  overwritten is a set operation too. A row in only one of the two reads is skipped rather than
  written: one this transaction never claimed is the whole thing the claim exists to stop, and one
  that no longer links here has no link for the rename to follow. The fifth is the write itself:
  one `UPDATE … FROM unnest($ids::text[], $descriptions::text[])` carrying a description per row
  whose text actually moved — the idiom `claimCharacterRows` already uses, adopted because that
  write was the last of the three costs that still grew with the library, awaited once per changed
  row while all 99 were locked. The count is pinned in `libraryMentionRewrites.test.ts`, which is
  where it went when the mention suites split, because nothing about the result of either function
  says how many statements it took. `CHARACTER_MENTION_TRANSACTION_OPTIONS` is therefore
  `{ timeout: 10_000, maxWait: 5_000 }` rather than the `{ 30_000, 10_000 }` the loop needed — the
  shape `PAGE_RESTRUCTURE_TRANSACTION_OPTIONS` uses one package over, and a lock window before it
  is a budget: it is how long one rename can make every other character edit on that account wait,
  and it has to stay under the app's 20-second default receive timeout (`api_client.dart`, which
  these routes do not raise) or the 503 below is written after the device has already given up.
  **A ceiling on one transaction is not a ceiling on a request: the delete runs its lane twice,
  and the patch pays for two reads before it opens one.** The delete
  runs its lane twice — claim, then a stale-claim retry — so the pair shares
  `CHARACTER_WRITE_CLIENT_BUDGET_MS` through `characterRetryTransactionOptions(elapsedMs)`
  (`characterWriteBudget.ts`), which
  hands the retry what the first attempt left rather than a second full window. `PATCH /:id` opens
  one transaction and asks that same function what is left, because what it spends first comes out
  of the same 20 s: `characterClaimSubject` and `copyrightRestrictionsEnabled()`, the latter read
  out there precisely so it is not read while the transaction holds up to 99 sibling row locks.
  Sized against the ceiling alone it still opened the full 15 s behind them. Those two are now one
  `Promise.all` — neither needs the other, and two waits for a pool connection is exactly what the
  budget is spent on under the pressure it was written for. **The clock itself starts before
  `requireMobileAuth`, on every route that asks the function anything**: `characterWriteLane.ts`
  starts timed lanes before it calls the auth guard and exposes both elapsed time and fresh
  transaction options to the route body. The session lookup is a `MobileSession` query, a pool
  acquisition under that same pressure, so a lane started after it
  reported `elapsedMs ≈ 0` for seconds it had already spent and opened the full ceiling behind
  them. Reading the per-transaction ceiling as a per-request one is what put the 503 past the
  budget it was chosen to fit inside.
  **A budget too small to commit in buys no window at all.** `CHARACTER_RETRY_FLOOR_MS` used to be
  a clamp — a window under it was widened back up to the floor — and a clamp is the one arithmetic
  that can put the lane back over the budget everything above holds it to: a first attempt that
  spent its whole 15 s leaves 3 s, floored to 4.5 s, so the delete answered at ~19.5 s *plus* the
  liveness read, past the 18 s `CHARACTER_WRITE_RESERVE_MS` was sized to leave and at or over the
  app's 20 s receive timeout. Both halves of the floor's trade were being paid at once: a window too
  small for the claim and the unlink to commit in, **and** a `CHARACTER_EDIT_BUSY` written to a
  device that had already shown a bare network error. So `characterRetryTransactionOptions` returns
  `null` there and the route answers `sendCharacterWriteBusy` itself — the same 503, arriving while
  someone is still reading. It also makes the bound inductive rather than approximate: every window
  it hands out is what is left or less, so `elapsed + window` cannot pass the budget for any attempt
  of either lane.
  The status matters as much: P2028 is deliberately **not** in `isRetryableTransactionConflict`,
  because that predicate means "you lost a race, send it again now" and answering a timeout that
  way just burns another window — and P2028 also covers "transaction already closed", which is no
  race at all. `isTransactionTimeout` routes it to `sendCharacterWriteBusy`, a 503
  `CHARACTER_EDIT_BUSY` the app already surfaces through `_mapDioException` with no Dart change.
  **Three routes send that 503 and only two carry the ceiling.** `POST /api/mobile/characters`
  keeps Prisma's 5-second default on purpose: the ceiling exists to pay for work that grows with
  the library, and creation has none — it writes the row, one bounded read of the mentioned ids,
  the link set and the canonicalized description, a fixed handful of statements whatever the
  library holds. A wider window would buy that nothing and cost it something, because the ceiling
  is also how long a stalled attempt keeps its pool connection and the new row's lock. What
  creation did need is the *answer*: a `P2028` there used to fall through as a 500 for a character
  the reader typed correctly, so `isTransactionTimeout` is checked on that path too, above the
  `P2002` name-clash branch — a clash is something they have to fix and a timeout is not.
  **And it is checked there because there is one ladder and one catch, not three.**
  `sendCharacterWriteError` (`characterWriteConflicts.ts`) is every answer a failed character
  write gives, in one order — refusal, mention error, timeout, conflict, `P2002` — and
  `characterWriteLane.ts` calls it around the route body, returning when it answered and rethrowing
  what it does not recognise. The three old catches had drifted in every direction three copies
  allow: create knew the timeout rung and not the conflict one, delete neither the refusal nor the
  mention one, and only patch asked `namesMentionPrimaryKey` whether its `P2002` really named the
  library's own unique. The rung that matters next is the mention one —
  LOCATION and OTHER share `LibraryMention` with the cast (`REPLACED_MENTION_KINDS`), so a refusal
  taught to one catch would have answered 500 from the other two. The ladder imports the pure
  timeout/conflict classifiers from `characterWriteBudget.ts` and the Prisma/driver traversal plus
  LibraryMention predicates from `libraryMentionConstraintErrors.ts`; row locks and moved/lost-claim
  errors live separately in `characterRowClaims.ts`, so neither `libraryMentionRewrites.ts` nor
  `characterPhotoWrites.ts` reaches through the response module.
- **A wire code owns one sentence, and it lives with the code rather than at the call site.** The
  app snackbars `error.message` verbatim, so a reader who meets one wall from three gestures is
  told three different things about one state — which is what `PORTRAIT_IN_PROGRESS` had become:
  five sites (promote, the per-image delete, the portrait route's status guard and its own
  `PortraitInProgressError`, and `DELETE /:id` on a live claim) spelling three sentences, because
  the constant extracted during the route split was private to `routes/characterImages.ts` and the
  record route could not reach it. `sendPortraitInProgress` and `sendCharacterImageChanged` sit
  beside `sendCharacterEditConflict` and `sendCharacterWriteBusy` in `characterWriteConflicts.ts`
  for the same reason the ladder does: both route groups answer a character conflict, so the answer
  belongs to neither of them. The noun follows the **app's** vocabulary rather than the column's —
  `character_reference_copy.dart` says *illustration* wherever it addresses a reader, and
  `referenceWanted` calls "generate portrait" the secondary framing — while `portrait` stays in the
  wire code, the columns and the internal error class, because a shipped client recognises the code
  and renaming one buys nothing. And the sentence says what to do next: the block lifts when the
  job settles, so "try again when it finishes" is the whole recovery where "is already being drawn"
  is a snackbar nobody can act on.
- **An unreadable body is recognised by the parser that refused it, never by a bare 400.**
  `sendUnreadableBodyError` is installed as a route-level `errorHandler`, and Fastify calls that for
  every error the route's handler and hooks throw — not only for a body the content-type parser
  could not read. Keyed on `statusCode === 400` alone it rewrote *any* of them into
  `VALIDATION_ERROR` "That request could not be read.", so a domain error from `startGenerationAttempt`
  or `dispatchGenerationJob` on `POST /:id/portrait` reached the reader as a malformed body, with its
  own code and message gone and nothing logged — the handler never called `reply.send`. The predicate
  is now the parser's: a 400 whose `code` starts `FST_ERR_CTP_`, **or** whose error object is
  `request.raw.errored` — the one genuine parser failure with no CTP code, because `rawBody`'s
  `onEnd` stamps 400 onto whatever the payload stream threw (a client hanging up mid-body arrives as
  `ECONNRESET`). `request.body === undefined` is not the discriminator it looks like: a bodyless POST
  with no `content-type` reaches the handler the same way, and the portrait route reads
  `request.body ?? {}`, so that test would rebuild the bug on the route that motivated the fix. The
  400 gate is deliberate — `FST_ERR_CTP_BODY_TOO_LARGE` is 413 and `FST_ERR_CTP_INVALID_MEDIA_TYPE`
  is 415, no route installing this declares either, and translating them would answer "that photo is
  too big" with "could not be read". Those two still reach the app in Fastify's own
  `{statusCode, error, message}` shape rather than the mobile envelope.
- **One candidate set decides who owns a span, and the source's own name is not in it.** A
  description is scanned whole and the longest name wins a nested span, so the names in play at
  write time and at rename time have to be one set — or a span bound by one is invisible to the
  other. They were not: `claimingNames` added the source's own name, which the write never had. A
  character called "Luna Vega" linked to a "Luna", describing herself as "@Luna Vega is my hero and
  @Luna is my friend", bound both spans to Luna at save; renaming Luna to Nova then handed `[0,10)`
  to the longer "Luna Vega" and left it — "@Luna Vega is my hero and @Nova is my friend" — and
  deleting Luna left "@Luna Vega" naming nobody, inside text no later scan can reach, which is the
  exact failure the whole-set scan exists to prevent. `claimingNames` was the outlier, not the
  write: the editor resolves a description against the library **minus the character being edited**
  (`excludeCharacterId` in `library_mentions.dart`), so teaching the write side to bind the source's
  own name instead would make the server answer 400 "the description no longer contains @Luna" for
  a token the app is highlighting as Luna — a save the reader cannot fix. Write,
  `survivingMentionIds`, rename and delete now all read the description's own links through
  `libraryMentionCharacterRefs`.

- **A mention a save gives up takes its `@` with it, because the row it was bound to is the only
  record of where the marker sits.** `replaceLibraryMentions`' `deleteMany` clears the rows a new
  description no longer names, and a `deleteMany` over prose that keeps the token leaves an `@Mina`
  naming nobody — permanently, since every later scan is driven by the rows that statement just
  removed. `generationDescription` (`@book-maker/db`) then finds its name list and the surviving
  rows the same length, strips *by name*, and hands the raw token to the planner brief
  (`creationBuild.ts`) and to `buildLibraryCharacterPortraitPrompt`, which is the one place a UI
  token must never reach. Deleting a character already strips its markers out of every other
  description (`unlinkIncomingLibraryMentions`); dropping one out of your own is the same event
  from the other end and gets the same answer — the marker goes, the reader's own spelling stays as
  ordinary prose. Nothing upstream can stand in for it, because
  `{mentionedCharacterIds: []}` carries no description at all and so there is no edit to have taken
  the tokens out. **The strip runs before the canonicalizing scan and is handed the survivors as
  `siblings`**, so the two passes cannot disagree about a span: one pass over dropped ∪ kept keeps
  "@Luna Vega" as Vega's and takes only the "@Luna" beside it, and once a dropped name has no `@`
  left the kept set really is the whole candidate set for the prose that remains. Stripping after
  canonicalizing is the same two scans asking different questions of one span — a longer dropped
  name would take the marker off a link this write is *storing*. The one set the single scan cannot
  bind is refused rather than read a second way: a kept target whose only token is the prefix of a
  dropped name ("@Luna Vega" kept as Vega, sent as Luna) comes back `missing` and answers 400
  `INVALID_CHARACTER_MENTION`, where binding it to the nested span is the bug the whole-set scan
  exists to prevent. No shipped client can send such a set — the editor resolves against the whole
  library, longest name first — and the derived path cannot either, since `survivingMentionIds`
  selects from the same rows under the same names. The read that finds the dropped targets is the
  one `mentionLinksAlreadyStored` was already taking; it moved ahead of the validating scan because
  the drop decides what that scan is handed, so a refused save pays one indexed read inside a
  transaction that rolls back anyway.

- **A mention row's kind is required, and one that arrives without it is nobody.** Location and
  Other share `LibraryMention` with the cast, so the kind is the only thing separating a character
  from a place — and `isCharacterMention` used to read a missing `targetKind` as CHARACTER. That
  was safe only while CHARACTER was the sole kind: a narrower `select` that forgets the column
  turns a location into a cast member, which earns it a reference sheet and puts it in front of the
  planner as a person. Nothing made the compiler say so, and `incomingSourceSelect` had to be
  widened by hand to prove it. `LibraryMentionRow.targetKind` is therefore **required** — an
  omitting `select` no longer compiles — and the runtime answer for a row that gets past the type
  anyway is *not a character*, never the other way round. `claimingNames` takes the shared
  `LibraryMentionRows` for the same reason: the hand-rolled copy of that shape it used to declare
  was laxer than the real one, so it would have swallowed the error at the one call site that had
  to see it. `packages/db/src/libraryMentions.test.ts` pins the type with a `@ts-expect-error` that
  fails the build if the field goes optional again. What the kind still cannot buy is a **name**:
  `LibraryMention_target_arc` forces `targetCharacterId IS NULL` for both other kinds and there is
  no table to join in their place, so `libraryMentionNames` and `libraryMentionCharacterRefs`
  return the same rows today, `generationDescription` leaves a marker it cannot name where the
  reader put it, and `libraryMentionRefs` withholds such a row rather than shipping it with an
  empty name. Those joins landing in `libraryMentionInclude` is the one change that lifts all four.

- **A claim that writes a row's own value back does not lock it against being mentioned, so the
  mention rewrite takes the `FOR UPDATE` itself.** `claimCharacterRow` and `claimCharacterRows` both
  assert a row by writing a column it already holds, and Postgres escalates an `UPDATE` to
  `FOR UPDATE` only when a key column's value **actually changes** — `heap_update` compares old
  against new, it does not read the `SET` list. Measured against the dev database: with
  `SET name = name` held open, a concurrent `LibraryMention` insert naming that row **succeeds**;
  with `SET name = 'Anita'` it blocks. So both claims take `FOR NO KEY UPDATE`, which is exactly the
  mode `FOR KEY SHARE` — the lock an FK check takes — was designed not to wait behind. That left
  `claimedMentionSources` deriving its whole source set from an unlocked read, and claiming *nothing
  at all* when that read came back empty: a DELETE could see no mentions, a concurrent PATCH could
  commit `"Best friends with @Ana."` plus its link row, and the delete's cascade would then take
  that row away and leave `@Ana` in another character's stored prose with nothing behind it —
  dangling permanently, in text nothing will scan again, naming somebody nothing can now identify.
  `lockMentionTarget` takes a real `SELECT … FOR UPDATE` on the target before the snapshot read, so
  no transaction can *begin* mentioning it while the rewrite holds it; that is what turns the empty
  short-circuit from "nobody had committed one yet" into "nobody mentions this, and nobody can
  start to". Both lanes go through `claimedMentionSources`, so the rename window closes in the same
  place. The cost is priced and accepted: the lock order is target-then-sources while a PATCH of a
  source claims itself first, so two writes over the same pair can deadlock — Postgres detects it,
  reports `40P01`, and `isRetryableTransactionConflict` already answers that as a retryable 409. A
  detected collision the app re-sends, in exchange for a marker nothing can repair.

- **A lock is not a write, and a claim that writes stamps a clock from before it waited.**
  `claimCharacterRows` was an `UPDATE` writing each row its own `userId` back, and taking an
  explicit `data: { updatedAt: new Date() }` out of it fixed nothing, because **`@updatedAt` is
  stamped when Prisma *builds* the statement, not when Postgres runs it**: it compiles to
  `UPDATE … SET "userId" = $1, "updatedAt" = $2` and binds `$2` from the client's clock before the
  query is sent. Measured: a claim issued at `T` and blocked 4.0 s on a real row lock wrote
  `T + 20 ms`. A claim is the one statement here that routinely waits, so a rename claiming 99
  siblings stamped `t0`, queued behind a PATCH of sibling B that committed `t1 > t0`, and landed
  `t0` over it — and that column is not bookkeeping, `character_avatar.dart` spends it as the
  portrait URL's `v=` cache-buster, so the device kept bytes it already had and a portrait replaced
  in that window stayed stale until something else edited B. It is now a
  `SELECT … FOR NO KEY UPDATE`, which gives both things the claim actually wanted — the row lock,
  and a predicate re-evaluated once the lock is granted — while touching nothing.
  `FOR NO KEY UPDATE` and not `FOR UPDATE`, deliberately: it is the mode the `UPDATE` already took,
  and the stronger lock would start blocking the `FOR KEY SHARE` of every `LibraryMention` insert
  against claims that do not conflict with them. The comparison is row-wise —
  `("id", "userId", "name") IN (SELECT * FROM unnest(…))` — because matched column by column a
  character renamed into a name another row of the same claim was read under satisfies every term
  and is reported as a row this claim holds; `[userId, name]` is unique so it takes two renames to
  arrange, and the window is ten seconds. Measured on the statement as written: the borrowed-name
  set matches zero rows where the column-wise spelling matches both.

- **A mention target deleted mid-write is a 404, not a stack trace.** `mentionedTargets` reads its
  targets with no lock, so one deleted between that read and the `createMany` below it violates
  `LibraryMention_targetCharacterId_fkey` — SQLSTATE 23503, Prisma `P2003`. `sendCharacterWriteError`
  recognised `ContentRestrictedError`, `LibraryMentionError`, `P2028`, `40P01`, the CHECKs and
  `P2002` and nothing else, so the route rethrew and a whole character save was lost to a 500 — for
  an ordinary concurrent-delete race whose answer, `CHARACTER_NOT_FOUND` with `mentionedTargets`'
  own sentence, was already implemented one rung up. The rung sits below the typed
  `LibraryMentionError` (that one knows *which* id went and reads no constraint name to find out)
  and above `P2002`; the three constraint rungs are disjoint by SQLSTATE, so their order among
  themselves is grouping rather than precedence. It fires on a `LibraryMention…_fkey` constraint
  name, or on `23503`/`P2003` that also mentions `LibraryMention` — both FKs on that table point at
  `LibraryCharacter`, so any 23503 naming it *is* a character that went away, while
  `LibraryCharacter_userId_fkey` stays a 500. Note the shape this reads: on Prisma 7.8 with
  `@prisma/adapter-pg` the SQLSTATE arrives under `meta.driverAdapterError.cause`, and every rung
  that needs it reads one `constraintErrorText` (`libraryMentionConstraintErrors.ts`) — the single
  record of where an adapter
  puts a SQLSTATE, which `characterPhotoWrites.ts` borrows for its own deleted-character rung
  rather than keeping a second copy. It was three copies of that traversal, and one of them was
  not a copy: `namesMentionCheckConstraint` read `meta.code` and `meta.column_name` and never
  walked the adapter cause at all, so a CHECK reported the way a foreign key is reported was
  invisible to it. The shared text is the union of what the three read, so no predicate narrowed;
  the CHECK rung widened onto the shape it had been blind to.

- **Where two answers are told apart by one exact test and one piece of prose, the prose speaks
  last.** `isTransactionTimeout` sits above the conflict rung and falls back to matching
  `/transaction already closed|expired transaction/i` over any error's `message`, so a wrapper error
  quoting that phrase while reporting a serialization failure was answered `CHARACTER_EDIT_BUSY`
  ("try again in a moment") instead of `CHARACTER_EDIT_CONFLICT` ("open it again and retry") — the
  two sentences this module exists to keep apart. Two narrowings, neither of them a tighter phrase
  (the fallback exists for shapes nobody can enumerate, so anchoring the prose only moves the
  guess): `isRetryableTransactionConflict` is asked after the exact `P2028` test and **wins**,
  because every test it makes is exact; and an error carrying any `code` other than `P2028` never
  reaches the string at all, because a coded error has already said what it is.

- **A create tells the link writer it is new, and only the read is allowed to believe it.**
  `mentionLinksAlreadyStored` exists because the common save changes prose and no links, and
  re-writing an unchanged link set is two statements for nothing — but that is a PATCH property. On
  `POST /characters` the `sourceCharacterId` was created moments earlier in the same transaction, so
  the query can only ever return zero rows: a round trip inside the transaction holding the new
  row's lock, decided by the length check alone. `replaceLibraryMentions` therefore takes
  `sourceCreatedInThisTransaction`, and only the **read** is skipped — the `deleteMany` still runs.
  A wrongly-passed flag that skips the read still performs a correct full replace; one that skipped
  the delete would hit `createMany` on its own primary key. Absent is the safe default.

- **A route's declared statuses are what its own handler can reach in the shared ladder, never the
  ladder's full set of rungs.** Routing three catches through one `sendCharacterWriteError` means
  the ladder can answer things a given route never declared: `DELETE /characters/:id` declared
  `{401, 404, 409, 503}` while the ladder could hand it a 400 or a 422, and none of the three
  declared the 429 `hitAuthenticatedLimit` emits. Fastify falls back to the default serializer so
  no field is dropped, but `/docs` then documents a set the handler does not have — the same class
  of mismatch the `contentRestrictedError` schema work exists to close. The maps are now audited per
  route against what that handler can actually throw, which cuts both ways: DELETE gained the 429
  and deliberately **not** the 400 or 422, because it screens no content and writes no
  `LibraryMention` row, so neither has a statement in that lane to come out of. Declaring a refusal
  a route cannot give is the same lie as omitting one it can.

  The picture routes in `routes/characterImages.ts` are audited to the same standard, and every
  gap there ran the one way — a rung the handler reaches and the map left out. All four rationed
  ones — promote, the per-image delete, the photo upload, the portrait — omitted the 429 their
  limiters emit, and `PUT /:id/photo` and `POST /:id/portrait` omitted the 400 they send
  themselves. The other five gained nothing: the four byte-and-list reads and the legacy
  `DELETE /:id/photo` ration nothing and refuse nothing past the 404 they already declared. The
  portrait route is also where the fallback stops being free. It documents a body, so ajv used to
  answer a short `requestId` before the handler ran — and Fastify cannot push its own
  `{ statusCode, error, message }` through a declared `mobileAuthError`, so naming the 400 turned
  that reply into a 500 (`FST_ERR_FAILED_ERROR_SERIALIZATION`). Declaring a status means owning
  every reply served at it: the route now carries `attachValidation: true` like every other mobile
  route with a documented body, which leaves the zod parse as the only gate and its
  `VALIDATION_ERROR` as the only 400.

## Voice and audiobook routes

- **Voice calls and audiobooks are plan perks, refused to a free account before the spend breaker
  and before anything is held.** Both reach a tier-blind provider that bills real money per second:
  a busy ten-minute call was modelled at $0.57–2.60 and never measured, so at the old 60 credits a
  minute it lost money on every plan, and a free account could spend its welcome grant on calls or
  narrate an import on it (launch review, 2026-10-13). `planPerks.ts` holds the gate,
  `requirePaidPlanPerk`, and the two sentences: 403 `SUBSCRIPTION_REQUIRED` — the Word export's and
  the import's code, so every shipped app already opens the paywall on it or shows the sentence — with
  "Voice calls are part of the Creator plan." / "Audiobooks are part of the Creator plan.". "Paid" is
  `hasActiveSubscriptionEntitlement`, a fresh read like the Word route's; a read that fails is a 500,
  never a free pass. Where it sits: both call routes (book cast and library) after the character
  lookup, its status checks and the provider-key check, and before the breaker, the persona build,
  the rate limiter and the minute hold; the audiobook start after the replay of a narration already
  running (paid for when it started) and before the breaker, the books-in-progress limit and the
  charge — a resumed failed narration is a new paid start, so it asks too. Before the breaker on
  purpose: a free reader is told what unlocks the perk rather than that Tomeza is busy, which makes
  the breaker's soft-cap `AI_BUSY` for voice and audiobooks unreachable by a free account. Reading
  an audiobook already made, the cast list and the narrator samples stay open. The app draws both
  entry points as plan perks from the billing payload's plan (`apps/mobile`), and the rate is
  `voiceCallPerMinute` 120 until a call is measured on the Operations tab.
- **Voice provider access is controlled by a funded server relay.** `routes/voice.ts` requires
  `transport: "relay-v1"` and returns a single-use relay ticket; Gemini credentials and session
  handles stay server-side. `voiceRelayConnection.ts` accepts only rate-limited PCM audio, renews
  its durable lease independently of client heartbeats, and closes upstream before settlement.
  `packages/db/src/voiceRelayBilling.ts` atomically reserves/commits minute holds at the start's
  price, permits one ACTIVE/ENDING call per user, and refunds unused minutes after closure.
  A connected call costs at least one minute; a call that never connects is refunded entirely.
  HTTP heartbeats only read billing state and upload captions. An end on another API instance
  marks ENDING and retains the hold until the owner stops or its lease expires. Recovery waits
  past the lease deadline; every forwarded frame checks that deadline too. The legacy sweep
  must exclude relay rows and preserve holds belonging to ENDING calls.
  The relay is also the only process that sees the call's provider spend: it meters every Gemini
  Live `usageMetadata` into `ProviderCallLog` segments under the caller (`voiceRelayUsage.ts`; the
  rule is "Every provider call row names the user it was spent for" in `../admin/CLAUDE.md`).
  The app still uploads transcript batches into `VoiceCall.transcript`; `voiceCallHistory.ts`
  reads them into the next call as memory. Overlap is dropped on a retried batch.
  Deploy migration `000092_voice_relay`, API/proxy WebSocket support and the matching mobile app.
  Already-issued direct Gemini tokens remain usable for up to 30 minutes after issuance; stop
  old API instances and allow that window to drain before treating the rollout as fully protected.
- **A call ends at 15 minutes, and its Live context is compacted from the top of the persona,
  because every turn re-bills the whole window.** Gemini Live bills each turn for everything in the
  context, so a minute of call costs more the longer the call has run. At the old 30-minute cap and
  a fixed 24k/12k compaction, a busy call was modelled at $0.21 a minute at 10 minutes and $0.34
  at 30, against $0.25 of revenue a minute at the cheapest credit (120 × $0.00212, intro, yearly
  and Max): a 30-minute call lost 24–32% on those plans (launch review, 2026-10-15). The cap is
  `VOICE_CALL_POLICY.maxCallMinutes` (`packages/core/src/voiceCallMetering.ts`), and every bound
  derives from it: the minutes `authorizeVoiceRelay` will fund and the `VOICE_CALL_CLOSED` past
  them (`packages/db/src/voiceRelayBilling.ts`), the settlement, the legacy path's clamps in
  `voiceCalls.ts`, the provider token's expiry (`voiceProviders.ts`: the open window, the cap and a
  minute, so the relay's funded deadline always comes first), and the `maxCallSeconds` both the
  cast and the session send — which is all the app reads for "up to 15 min" and "Calls stop at 15
  minutes", so the change needed no app release. The compaction is the other half (→
  `packages/core/CLAUDE.md`, "Voice calls"): modelled the same way, a 15-minute call now costs
  $0.14–0.17 a minute across the persona sizes a call can carry, a margin of at least 33% on the
  cheapest credit. **That margin is a model, not a measurement**: busy talk both ways, 8 turns a
  minute, 25 audio tokens a second. Check the Operations tab's `VOICE_CALL_MINUTE` margin in the
  first week; the relay costs every call from the provider's own token counts
  (`../admin/CLAUDE.md`).
- **A relayed call's runway is its holds plus what the balance can still hold, and it reaches
  zero before the relay closes the socket.** The app counts the meter's `secondsRemaining` down and
  hangs up at zero, naming the end from `endingReason` ("Out of credits" or "Calls stop at 15
  minutes"). The relay holds only about a minute ahead, so `secondsRemaining` used to be that hold
  alone: it fell to 10–20 s every minute and read as `credits` with a full balance. A heartbeat that
  landed in that window had the app count down and hang up on the reader as out of credits; with a
  heartbeat every 20 s that is about half of all calls, three minutes in (found by replaying the
  meter, 2026-10-15; no live call had been measured). And at the real
  end, the app's zero and the relay's socket close landed within a second of each other; when the
  close won, the app showed "The call was disconnected." rather than the ending it was counting
  toward. `voiceRelayCallRunway` (core) now answers both: the runway is the reserved minutes plus
  the whole minutes the spendable balance could still hold at the call's own price
  (`readVoiceRelayMeter` reads the account row, without settling the period), capped at the length
  cap and less `endingLeadSeconds` (5), so the app's hang-up always lands first. `endingReason`
  names the last three minutes (`reserveBlockMinutes`), `limit` when the cap ends the call and
  `credits` when the balance does, as `voiceCallEndingReason` already did on the legacy path. No
  billing changed: the holds, the commits and the deadline are where they were. A row that is not
  ACTIVE answers as before. The session's opening `secondsRemaining` is still the first hold (180),
  corrected by the first heartbeat 20 s in. `voiceRelayBilling.test.ts` ("the runway the app counts
  down") walks a whole call.
- **A call names one callee, and a library character is the callee with no book.** `VoiceCall`
  carries either `projectId` + `characterId` (a book's cast row, cascading with it as before) or
  `libraryCharacterId` alone (one of the reader's saved characters, `SetNull` on delete so the
  metered rows — an ACTIVE one included — outlive the character and the sweep can still settle
  them); `VoiceCall_one_callee` in migration 000070 is the CHECK that holds both halves.
  `VoiceCallee` in `voiceCalls.ts` is the discriminated form every metering path takes, and
  `routes/voice.ts` funnels both casts through one `connectVoiceCall`: the book route and
  `/api/mobile/voice/characters/:characterId/calls` decide *who may be rung*, and from the rate
  limit onwards — the hold, the token, the connect-failed release, every heartbeat and hang-up — a
  library call *is* a book call. What differs is what a library callee lacks. There is no project,
  so the ledger entries carry `projectId: null` exactly as a portrait charge does. There is no page,
  so the body carries only the relay capability and no spoiler guard is written. There is no persona job — the persona is
  the reader's own notes composed at call time by `buildLibraryCharacterInstructions`
  (`packages/core/src/generation/libraryVoiceCharacters.ts`), so a saved character is never
  `preparing` — and the description reaches the prompt through `generationDescription`, `@`
  markers stripped, with the characters it mentions and the ones that mention it as its cast
  (`loadLibraryAcquaintances`). And the memory is its own: `loadVoiceCallHistory` is keyed by
  `voiceCalleeIdentity`, so a book's cast row and the library character it was copied from never
  read each other's calls — the book calls happen inside a story the library character has never
  been in, and would leak its plot. The cast avatar is served through the retained picture's
  immutable `/images/:id` URL rather than the `/portrait` or `/photo` alias, because the call
  avatar loads with no cache-buster and an alias whose bytes changed would draw the picture the
  reader just replaced.
- **Restarting a failed narration resumes it; that is a property of the route, not the worker.** The
  worker has always skipped READY chapters, but `POST /api/mobile/projects/:id/audiobook` used to
  delete and recreate the `Audiobook` row every time, so the skip never had anything to skip. It now
  reuses a FAILED row when the voice and `contentRevision` still match — any other change is a
  different audiobook and starts clean. The dedupe key names the run being resumed, because reusing
  the audiobook id alone would match the failed job's row and enqueue nothing at all.

## Writing Studio

Authors write their own books in the app (`manuscript/`, `routes/manuscript.ts`). The Studio edits a
**working copy** (`Manuscript` / `ManuscriptChapter`); the book people read is still the `Page` rows,
and only **publish** (`manuscript/manuscriptPublish.ts`) turns one into the other. Spec and wire
contract: `.scratch/writing-studio/spec.md`.

- **A publish is free, and rationed per account.** It queues a whole Chromium compile, a cover and
  the embedding and style passes, and nothing bounded how often a client could ask (launch review,
  2026-10-13). `POST …/manuscript/publish` takes `STUDIO_PUBLISH_RATE_LIMIT` (20 an hour per
  account, `routes/manuscript.ts`) after the dry-run branch — a checklist read costs nothing and
  counts nothing — and answers `RATE_LIMITED` like every other limited route; the 429 is in its
  declared statuses. `manuscriptPublishRateLimit.test.ts`.
- **A publish seals every earlier edit, because undo writes text without a revision check.**
  `undoLastBookEdit` restores a `PageEditSnapshot`'s before-text and redo its after-text onto the page
  as it stands; neither asks whether the page changed since. After a publish that text is the
  author's, so a chat Undo of an edit made *before* the publish would overwrite what they just
  published. The publish transaction stamps `classifier.sealedAt` on every APPLIED operation in one
  statement, and the single predicates `canUndoBookEdit` / `canRedoBookEdit` refuse a sealed row;
  `editChangesAvailable` hides "See changes" for sealed structural edits, whose diff reads live pages.
  `MANUSCRIPT_PUBLISH` itself is not undoable — undo across a publish is the Studio's version history.
- **A publish reuses rows by position and never shifts an index.** `Page` and `Chapter` both carry a
  non-deferrable `@@unique([projectId, index])`, so slot *i* is updated in place, the tail is created
  and the surplus tail deleted — no parking. A changed slot loses everything its old text owned
  (summary, image prompt and failure, QA verdict, story delta, embeddings, continuity notes, a hero
  `ImageAsset`'s `pageId`), and a shrinking book degrades `pdfPageMap` to the cover-numbering stub.
- **A publish stamps no `publicationRevision`, and its compile and cover are rows in its own
  commit.** A stamped revision makes the compile's publication claim stand down whenever a later job
  exists, and a first publish always queues a cover. The rows are created with `dispatch:false` and
  dispatched after commit; the worker's fan-in only compiles when `inputSnapshot.targetPages` ===
  the page count === `project.targetPages`, every page is COMPLETED and indexed 1..n, and the plan's
  chapters' `targetPages` match the pages — break one and the book sits in EDITING.
- **The working copy never overwrites the book blindly: drift is a conflict, not a merge.** Chat
  edits, Edit Mode, pictures, restructures, continuations and undo all write `Page` rows after a
  publish. `ManuscriptChapter.publishedPages` records `{pageId, revision}` per chapter; a chapter with
  no unpublished edits refreshes silently from the book, one with edits gets a conflict the author
  settles, and a publish that meets unsettled drift under its lock answers `BOOK_CHANGED`.
- **An author's book refuses every generation route.** After its first publish a Studio book has an
  APPROVED, current plan like any other, so `POST /plans/:id/approve` would charge a full book and
  regenerate over the author's pages. Plan create/revise/approve, the operator plan routes and page
  retry answer 409 `AUTHOR_MANUSCRIPT` for `isAuthorManuscript`, and the chat never reports stage
  `approved_plan` for one. Imports had the same hole. The chat's own door is `book_replan`, which
  forks a copy that inherits the book's media settings — the Studio or import record with them — and
  regenerates it whole: `refuseAuthorBookReplan` (`authorBookReplan.ts`) answers it at the proposal
  *and* at Apply, because a card quoted before a takeover can still be applied after it.
  `continue_book` stays open — it exists for imports, and derivation appends its chapters.
- **An author's book offers no book report, and a picture offers one only if a model drew it.**
  Reporting exists for AI content, and an author's text is theirs — the preview already left off
  its "AI-generated content" line for the same reason (`isAuthorManuscript`). Image DTOs carry
  `aiGenerated` (`imageIsAiGenerated`): false for `coverArtSource: "design"` and `source: "upload"`,
  true for everything else, a legacy cover with no source included. An AI cover or a Studio AI
  picture in an author's book stays reportable. The app reads a missing field as true.
- **An uploaded picture never makes a book "illustrated".** `projectAlreadyIllustrated` decides
  whether an `add_image` needs a free-tier illustrated-book slot; counting an author's own
  `upload-…` photo would let one upload unlock unlimited free AI pictures. It skips `upload-` files;
  AI Studio pictures (`studio-image-…`) still count and claim the slot.
- **Studio text is screened where it leaves the working copy, in request-sized windows, and never
  on autosave.** The screen is the app's own `assessContentRestrictions` with the same operator
  copyright flag — nothing stricter (`manuscript/manuscriptContentScreen.ts`). Its rules are
  whole-string co-occurrence tests sized for a typed request, and `normalize` reads only 50,000
  characters, so a 200,000-character chapter screened whole would be refused for "passport" in one
  scene and "fake" in another, and never read past its first quarter: a chapter is read in
  overlapping 5,000-character windows (the chat message cap) a half-window apart. Publish screens
  **only what changed since the last publish** — printed chapters with unpublished edits, and the
  book-level fields that differ from `settings.published` — **under its lock, on the rows it is
  about to write** (a pre-read would miss an autosave that lands before the lock), with the flag
  read before the transaction opens. A refusal is thrown, so nothing is written, charged or spent
  (the requestId publishes once the text changes), and answers the screen's own 422 plus
  `chapters: [{chapterId, title}]` and `fields` — which the publish, settings and create routes can
  only send because their 422 schema, `manuscriptContentRestrictedError`, names them. Settings and
  creation screen the fields the body carries; the assists screen the typed instruction, picture
  prompt and notes (the book chat screens its message), never the selection. Autosave is not
  screened — the working copy is private, and refusing a save loses the author's words. Uploaded
  pictures are not screened because nothing in the app moderates image bytes. A flag read that
  fails fails the request, as on every screening route. An import's text is still unscreened at
  import, and stays so in the Studio until a chapter is edited.
- **A Studio picture is reclaimed only when no row of its book names it and neither the picture nor
  the working copy has changed for 30 days.** Before this, only deleting the book removed an
  `upload-…`, `cover-upload-…` or `studio-image-…` object; every photo an author tried and took out
  stayed forever. `studioImageSweep.ts` runs in the API beside the chat-attachment retention sweep —
  it is the same kind of work (user-owned objects, age-based, no job), the API owns the upload
  routes, and nearly every row it reads is a Studio or chat table — hourly, bounded (50 books, 500
  deletes, 100 per book, 60 s), with an in-memory cursor. Only those three prefixes are ever
  candidates (`isSweptStudioImage`); a drawn `cover.<ext>`, chat and generation pictures and sheets
  are not, whatever the rows say. **The server cannot see what a device holds, so the grace is two
  rules.** The app keeps every unsaved chapter in a device buffer with **no expiry**, replayed only
  when that chapter next opens; the editor's undo stack, the clipboard and a second device's stale
  buffer can put back a picture the server copy dropped, and a removal that small writes no
  version. So an object must be older than 30 days *and* the book's `Manuscript`,
  `ManuscriptChapter` and `ManuscriptAssist` clocks older than 30 days. No number is a proof; 30
  and not 14 because a kept orphan costs a fraction of a cent a month and a wrong delete is a hole
  in the author's book with nothing on the server to restore it from. **A reference is an exact,
  URL-decoded filename in `images/<thisProject>/…`** read from every row that can put a picture back
  (`studioImageReferences.ts`): chapters (soft-deleted ones, conflict copies and notes included),
  versions, pages, live and archived undo snapshots, `ImageAsset` path and metadata, edit
  classifiers, moderation snapshots, and assists — READY always, APPLIED for 30 days after it was
  applied, QUEUED/RUNNING by their `studio-image-<id>` stem; DISMISSED and FAILED name nothing.
  Another project's URL never counts, because no exporter prints it. **The decision is a re-read,
  never an exception**: any failed read keeps that book whole for the next pass, and right before
  deleting it HEADs each candidate, re-reads the rows narrowed to the candidates' names, and re-reads
  the quiet stamp *last*, so a save that landed mid-pass keeps everything. What remains is a device
  replaying a reference after 30 quiet days, and a non-Studio write in the milliseconds between the
  last stamp read and the delete — every server-side copy (undo, redo, publish, restore) copies from
  a row the pass already counted. `STUDIO_IMAGE_SWEEP` is `delete` in production and `dry-run`
  (logs `studio_images.would_reclaim`) everywhere else, because the dev stacks share one bucket.
- **A takeover writes its provenance into the plan's snapshot too, because the worker compiles
  from the snapshot and the API from the row.** "Continue in Writing Studio"
  (`manuscript/manuscriptTakeover.ts`, `POST /manuscript/takeover`, design in
  `.scratch/writing-studio/takeover.md`) turns a finished generated book into what a Studio book is
  after its first publish. `compileExport` builds its input from the current plan's `inputSnapshot`
  (`inputForPlanVersion`), and every API reader — the inline export rebuild, the plan guards, the
  chat stage — reads `Project.mediaSettings`; a record on only one of them compiles one book by the
  generated rules while the API treats it as the author's. So `mobile.studio` (`origin: "takeover"`,
  `takeoverRequestId`, layout, kind, art style) is written to both, and the snapshot's `targetPages`
  becomes the real page count, because the author compile's `PAGE_COUNT_MISMATCH` is an error
  against it. Every other snapshot key is kept. `origin` is read with `.catch(undefined)`: a value a
  build does not know must never fail the record, which would silently turn the book back into a
  generated one. The layout is `picture` exactly when the book prints one sheet a page today
  (`shortKidsStoryPageLayout` over the snapshot and the pages), so the author rule prints the same.
- **A takeover rewrites each page into what the generated compile printed, hero first, and
  detaches every hero in the same commit that seals earlier edits.** The author compile never
  unwraps a model's whole-page fence, keeps a leading `## Page 3` or page-title heading, and prints
  no hero — a Studio picture is a line in the text. `takenOverPageText` (core
  `authoring/takeoverText.ts`) runs the generated `sanitizePageMarkdown` over the page (the chapter
  it opens named, so a repeat of its heading goes too) and puts the hero — the first attached
  non-cover row, the one the compile printed — first as `![<localized Illustration>](/assets/images/…)`;
  every attached non-cover row then gets `pageId = null`, so the picture prints once, from its line,
  and the first Update has no hero left to detach. Nothing re-attaches one: no generation route runs
  on an author's book, the finalization re-illustration needs a final review author books never
  get, and `generateImage`'s keeper token stands down on the changed text. Undo restores snapshots
  with no revision check, so an undo of a pre-takeover edit would drop a line whose hero is gone —
  the takeover runs publish's `sealEarlierOperations` in the same transaction, and records itself as
  a free `MANUSCRIPT_PUBLISH` (`classifier.takeover`) with no `publicationRevision`.
- **A taken-over book is cut into the chapters its reader saw, and the published Contents is the
  only record of them.** Every generated book has `Chapter` rows, but a per-page one was *printed*
  in the model's `chapterize-export` partition, which no column stores; the working copy groups
  pages by `Chapter` row, and the author compile prints those rows. So the takeover reads the
  published `book.md` (before its transaction; a storage failure fails the request rather than
  silently picking the wrong chapters) and, when its Contents parses and covers every page
  (`readerChaptersFromPublishedMarkdown`, now in core for this), rewrites the rows to it by position
  — update in place, create the tail, re-point the pages, delete the surplus — and replaces the
  plan's `chapters` to match, because a continuation numbers new chapters off the plan. A composed
  book's Contents repeats its rows, so only its sanitized titles move. No Contents — a short or
  sectioned book — keeps the rows: that is what printed.
- **A takeover clears the generator's page verdicts and image slots, because the author compile
  still reads them.** `pageQualityAdvisoryIssues` / `unresolvedPageQualityIssues` fold
  `Page.qualityReport` into the verdict whatever the provenance, so a generator's FAILED_QA page
  would mark the author's book "review recommended" on its first compile. Every page is set
  COMPLETED with `qualityReport`, `imagePrompt` and `imageFailureReason` nulled — the verdict is the
  author rules' integrity-only one from then on. `storyDelta`, summaries, titles, embeddings and
  continuity notes stay: the prose did not change, and a continuation of an older book still reads
  the story state folded from those deltas (nothing writes new ones since 2026-10-16, E6).

## Book notes

A private notebook per book (`BookNote`: title, plain-text body, pinned) in `routes/notes.ts` and
`bookNotes.ts`; spec and wire contract in `.scratch/book-notes/spec.md`. It is not the Studio's
`ManuscriptChapter.notes` (a chapter's plan, which the AI drafts from) and not the reader's
device-local highlights.

- **Every book the caller owns has notes, whatever made it and whatever its status.** The routes
  check ownership and nothing else (`ownedNoteProject`), never `authorProjectOrReply` or a status.
  A book the caller does not own is `PROJECT_NOT_FOUND`; a note outside that book is
  `NOTE_NOT_FOUND`. Both are 404, never 403.
- **A note never leaves the account, which is why nothing screens it.** No compile, export,
  prompt, context pack, chat, embedding or project serializer reads `BookNote`. The content screen
  exists for text that is printed or sent to a model, and a note is neither; refusing a save would
  only lose the owner's words, the same reasoning that leaves Studio autosave unscreened. If a note
  ever feeds a prompt, screen it where it leaves, in request-sized windows as the Studio does, and
  never on save. Titles and bodies are stored verbatim; trimming only decides whether a create is
  blank (`EMPTY_NOTE`).
- **A pin is not an edit.** `revision` and `editedAt` move only when the title or body changes, so
  pinning on one device never turns another device's open editor into a `NOTE_CONFLICT`, and a
  pinned note does not jump to the top of "recently edited". A text write must carry
  `baseRevision`, and the check lives in the `updateMany`'s `where`, because a check on a pre-read
  alone loses races. A lost race answers the winner's copy inside `error`, as `CHAPTER_CONFLICT`
  does. A `baseRevision` sent with a pin-only write is still honoured.
- **Delete is hard, and Undo is a new create.** Soft-deleted rows never pile up: the app keeps
  the deleted note and re-POSTs it under a fresh `requestId`, and a DELETE that finds nothing is
  `NOTE_NOT_FOUND`, which the app reads as done. The FK cascades, so deleting the book deletes its
  notes. A replan fork or a takeover copies none of them.
- **Only create and delete are rate limited.** PATCH is the editor's autosave, like the Studio's
  chapter PUT (which is also unlimited), and `draftLimiter`'s 120 an hour would refuse a long
  note mid-sentence. The 200-note cap is a count taken before the insert. It stops a runaway
  client, but two creates racing at 199 can both pass it, so nothing may treat it as a guarantee.

## Book sharing

A finished book published to an unlisted link: `routes/shares.ts` is the author's side
(`/api/mobile/projects/:id/share` GET/PUT/DELETE, and `/api/mobile/shares/:slug/remix`), and
`shares/publicShareRoutes.ts` is the stranger's (`/s/<slug>`, its `book.pdf`, `cover.jpg`,
`report`, and the page's own files under `/s/_/`). One `BookShare` per book, updated in place;
spec and measurement in `.scratch/book-sharing/`.

- **The public share surface is `/s/`, outside `/api/` and the auth complement, and it exists in
  production only because `deploy/nginx.conf` names it.** `shouldProtectPath` (`../auth.ts`) guards
  `/api/`, `/docs` and the two asset prefixes, so nothing under `/s/` sees a cookie check or a
  bearer; `allowsMobileBearer` and `isOperatorOnlyPath` are untouched, which
  `shares/publicShareRoutes.test.ts` pins from both sides (a junk bearer on `/s/` still gets the
  page; `/api/projects` and `/api/mobile/*` answer exactly as before). What a stranger reaches
  is decided by the share row alone: ACTIVE serves the book, anything else — revoked, taken
  down, a slug retired by a re-share, a book since deleted — is a 410 with no bytes and no book
  details. **`deploy/nginx.conf` proxies only the prefixes it names and serves the operator
  SPA for every other path**, so a public prefix missing there works under `pnpm dev` and 404s,
  or renders the console, in production; `/s` is in its `location` regex, and `server.ts`'s
  local SPA fallback answers 404 under `/s/` rather than `index.html`. The page is plain
  server-rendered HTML under `script-src 'self'`: every person-written value is escaped in
  `sharePage.ts`, `share.js` reads its inputs from `data-` attributes, and pdf.js is vendored
  (`pdfjs-dist` legacy build, served from `/s/_/pdfjs/`) because Android Chrome downloads a
  PDF instead of showing it. Every answer says `noindex` twice (header and meta), share bytes
  cache for at most five minutes so a revoke bites quickly, and a view is counted on the
  **PDF** fetch only — link-preview crawlers fetch just the HTML, so that keeps them out without
  a user-agent list.
- **The share note's Jev gate holds the note for review on no verdict and never allows on one; it
  is a gate, not a screen, which is why it stays.** `moderateUserText`
  (`../userTextModeration.ts`) is one `choose` on the Quality tab's fast-decision route. A
  confident `allowed` shows the note; a confident violation — Jev at 0.70 or better, or the
  fallback model it escalates to — is a 422 with one wire code per category (`shares/shareCopy.ts`)
  and nothing written. Everything else is *no verdict*: the route resolves to `undefined`
  because the operator moved fast decisions off Jev, the routing read fails, both attempts fail,
  or the gate's own 25 s budget runs out. The share still goes live, **without** the note,
  `captionStatus: PENDING_REVIEW`, and a system `ModerationReport` (`reporterUserId: null`,
  `targetSnapshot.kind: "caption_review"`, every attempt's probabilities) is written in the same
  transaction as the share. The client going away is a cancellation (`reply.raw`'s `close` before
  the answer is written), not a verdict, and writes nothing — and it is read off the *response*:
  Node destroys an `IncomingMessage` once its body is read, so `request.raw.destroyed` is true in
  every handler with a body, and reading it cancelled every gate over a real socket while
  `inject` never showed it. `allowed` is the first option on purpose: under `MOCK_AI` the
  `FakeDecisionAdapter` picks the first option. Links are refused by `containsLink` before any
  model runs. An unchanged note is never re-moderated, which is also what makes an operator's
  REMOVED stick to that exact text. **This Jev path is a gate, not a screen, and that is why it
  stays** although the adapters `CLAUDE.md` removes Jev screens that cannot show a paid call they
  skipped: it replaces no call, it *is* the decision, so it is measured by its verdicts — 39/39
  on the labelled set after one wording fix, benign dark blurbs at 0.93–1.00, ~0.4 s and
  ~$0.00004 a note (`.scratch/book-sharing/jev-measurement.md`). A refused benign note is a bug
  in the option wording: fix the words, never the threshold, and re-run the set. Every physical
  attempt writes a `ProviderCallLog` row through `../inlineDecisionUsage.ts`, the API twin of the
  worker's `recordDecisionAttempt`.
- **The preview cap is the author's choice of how much a stranger reads, and it is applied again at
  serve time.** A preview is a real PDF, free to anyone holding the link, and it is what an author
  picks who wants to show the opening and keep the rest; `maxPreviewPages`
  (`shares/sharePageRange.ts`, half the book's reading pages, at least one) is what keeps "a
  preview" meaning that, so a 29-of-30 preview is refused rather than being the whole book under
  another name. It used to be argued as the export loophole's only lock, while a full share and the
  download both cost the export unlock; that unlock is gone (2026-10-15) and a full share is free,
  so the cap guards the author's intent, not a price. The cap is checked when the author saves and
  **again at serve time**, because a later edit can shrink the book under a preview that was legal
  when saved. N counts reading pages, not sheets: the cover,
  title sheet and Contents are always shown and never counted, measured from the published page
  map only when its `pdfDigest` and sheet count describe the bytes being served, which also leaves
  the back matter (Sources, About the Author) out of the count and the slice. Without a measured
  map for the current bytes, the reading count is unknown and the preview cap is one sheet after
  any digest-verified cover. The owner response, save validation and public slice use that same
  cap: a long biography can otherwise inflate half the total sheets into the entire manuscript.
  The slice is cut
  server-side (`shares/sharePreviewPdf.ts`, pdf-lib) and cached under the book's own
  `books/<projectId>/share-previews/`, keyed by the compile's digest. `copyPages` follows every
  reference a page holds and `save` writes every object it copied, so a kept page's internal
  links, article beads and additional actions are cut from the *source* before the copy — only
  URI links survive — or the rest of the book rides along unseen.
- **A full share is free, and the share routes keep the unlock's wire only for installed builds.**
  A full share used to settle the book's export unlock last, through the download's own helper,
  idempotency key and plan rule; the per-book unlock was removed on 2026-10-15 ("Charge once he
  approves the plan … once the book is ready it is simply downloadable without any locks"), so a
  share of any book — generated, Studio, imported, made while free — charges nothing in either
  mode. `PUT` runs its checks — the published PDF, the rights and likeness confirmations, the cap,
  the book text screen (the deterministic screens, then the sexual-content filter's model screen —
  "Content safety" in `../../CLAUDE.md`), the note's link check and its verdict — and writes. It
  reads no entitlement and calls nothing in `@book-maker/db/billing`, and `shareRoutes.test.ts`
  asserts exactly that. For the app builds already installed, which branch on the old fields: the
  body's `acceptExportUnlock` is still accepted and ignored, the share state reports
  `exportUnlocked: true` and `exportUnlockCredits: 0` for every book, a save answers
  `exportUnlockCharged: false`, and the route never answers 402 (`EXPORT_UNLOCK_REQUIRED` and the
  402 schema are gone).
- **A share serves only text screened at the book's current revision, and a refused re-screen
  turns the link off for the author to share again, never takes it down.** A share was screened when it was created or changed mode, and
  `/s/<slug>/book.pdf` serves the book's *current* compile, so every later edit — Edit Mode
  (`routes/book.ts`, which screens nothing, not even the CSAM regex), a chat edit, undo and redo,
  matter, a Studio publish, a takeover — reached strangers unread (launch review 2026-10-15, C2):
  share a clean book, rewrite it, and the rewrite was public. Every screen now stamps the
  `contentRevision` it read the text at on `BookShare.screenedContentRevision` (migration 000113),
  and `readSharedBookText` reads that revision and the title, matter and pages in one REPEATABLE
  READ snapshot, because every edit writes its text and bumps the revision in one commit — read
  apart, an edit landing between them would be stamped as screened. `shareServesCurrentText`
  (`shares/shareRecords.ts`) is the whole test: the stamp equals the book's revision, and a null
  stamp (every share from before 000113) never does. A share that fails it is a book being updated
  to strangers: the page shows the being-updated state and names neither the title, subtitle nor
  author (`A book on Tomeza`, `A Tomeza author`; the note stays, being the author's own and
  moderated on its own), the PDF answers the 503 — before any preview slice, cached or not, is
  read — the cover is the generic image, no view is counted, and the remix route sends an empty
  `title` (the app then writes its opening line without one). `PUT` screens a live share whose
  stamp is stale even in the same mode, and stamps forward only (`writeShare` keeps the larger of
  the two, since a concurrent re-screen may have read a later revision and revisions never go back).
  `shares/shareRescreen.ts` brings a stale share back with `screenSharedBook` — the two screens
  the create path runs, with the create path's three meanings: passed stamps the new revision and
  the share serves again; a confident refusal (deterministic or model) **turns the link off, it
  does not take the share down**: `REVOKED` with `SHARE_TEXT_OFFLINE_REASON`
  (`shares/shareCopy.ts`), no report, nothing public (strangers get the plain "no longer shared"
  410), and the cached preview slices cleared. It was briefly an operator-style `TAKEN_DOWN`, which
  is permanent, and the coordinator reversed it the same day: the model screen's wording is
  unmeasured, so one false positive would have locked sharing for that book for good, and the
  refused text was never served — the share was already "being updated" — so this is the create
  path's 422 arriving later, not a moderator's verdict. The reason lives in the `takedownReason`
  column, which every return to ACTIVE clears and an author's own stop never sets, and reaches the
  author as the share DTO's `stoppedReason` (non-null only while revoked; `takedownReason` stays
  the operator's, only while taken down). Installed builds show a revoked share as the normal form
  with its old settings, which is "share again"; they do not read `stoppedReason` yet. Sharing
  again is an ordinary re-share: `rightsConfirmed`, the full create-time screen with its 422 if
  the text still fails, and a new slug. An operator's `TAKEN_DOWN` is never written or touched
  here and stays permanent. No verdict stamps it and keeps it live with a `book_text_review` report, at most one pending per
  share so an author editing a held book does not file one per edit. The outcome is applied under
  the project's row lock (`FOR SHARE`, so the revision cannot move) and then `writeShare`'s own
  share lock, in a project delete's order: a book that moved again while it was read is
  `superseded` and nothing is applied, and a share revoked, taken down or already stamped at that
  revision or later is left alone. Two doors start one. The `share_rescreen` background sweep
  (`server.ts`, every two minutes from 30 s after listen) re-screens at most ten stale ACTIVE
  shares a pass, oldest first on the `(status, createdAt)` index, one after another, with a 60 s
  model budget because no request is waiting. And a public request for a stale page or PDF asks
  the rescreener without waiting for it — **at most once per share and revision** in this
  process, never while one runs for that share, and at most `PUBLIC_RESCREEN_CONCURRENCY` (two) at
  once across all shares; whatever it declines, the sweep reaches. The model screen's verdict cache
  means the windows an edit left alone are not paid for again. Not covered: bytes a cache already
  holds (share bytes say `max-age=300`, as for a revoke), and a published PDF older than the stamp —
  a share made while an edit's recompile is still landing serves that compile's text until the new
  one publishes, as the download does. `shares/shareRescreen.test.ts`, `shareRoutes.test.ts` ("the
  screened revision") and `shares/publicShareRoutes.test.ts` pin it.
- **The share follows the book's current compile, and there is no older copy to fall back on.**
  An Edit Mode save deletes the published PDF until its recompile lands
  (`invalidateCompiledProjectExports`), so a share in that window serves a "being updated" page
  and a 503 for the PDF, and queues the same export repair the status watch does — and the same
  save moves the book's revision past the share's stamp, so the share stays "being updated" after
  the recompile lands until it has been screened again (above).
- **A slug is never reissued because every slug ever minted is a row in `ShareSlug`.** Nothing
  deletes from it — not a revoke, a re-share (which mints a new slug) or a project delete — so its
  primary key is the guarantee, and a slug found there but on no live share answers 410, not 404.
- **An account an operator turned sharing off shares nothing and remixes nothing, and the share
  write asks again under the user row's lock.** A takedown used to block one book, while the Terms
  promise the operator can disable sharing for an account (launch review, 2026-10-13). Turning it
  off (`../accountModeration.ts`, from the user inspector) takes every live share down and sets
  `User.sharingDisabledAt`; a suspension takes the shares down too. `PUT …/share` asks
  `accountMayShare` after the body and before it reads the book, and refuses with 403
  `SHARING_DISABLED` (`shares/shareCopy.ts`) — a 403 the share
  sheet shows as a refusal, because only `SESSION_REVOKED` and `ACCOUNT_DISABLED` sign the app out.
  `GET /api/mobile/shares/:slug/remix` refuses the same account the same way. Neither route check
  is the lock: `writeShare` reads the account again `FOR SHARE` before its share-row lock, and the
  operator's action takes the row `FOR NO KEY UPDATE` before it reads the account's shares, so a
  share either commits first and is taken down, or waits and refuses (`SharingDisabledError`). A
  share an account action took down carries `ACCOUNT_SHARE_TAKEDOWN_REASON` and comes back REVOKED,
  never live, once the account is clear on both counts ("Account moderation" in `../../CLAUDE.md`).
- **"Make a book like this" returns the format and nothing else.** `shares/shareRemix.ts` reads
  the preset echo, the category and the page count; it never loads the brief, plan, chat, cast or
  text. The chat it starts records `MobileCreationDraft.originShareId` — a column, because every
  chat turn rebuilds the draft payload from scratch and a payload key would be gone by the second
  message — and the Overview's sharing funnel (`../admin/shareFunnel.ts`) counts from it.
- **An install from a share page finds its remix through Play's install referrer, so the link's
  keys are a wire contract.** `playStoreUrl` (`shares/sharePage.ts`) puts
  `utm_source=share&utm_content=<slug>` on the Play link; the app reads it once per install, posts
  `install_attributed` (source, medium, the slug) to `POST /api/mobile/events`, and offers the remix
  once on its home screen (`apps/mobile/CLAUDE.md`, "Install attribution"). Every share link already
  out there carries those keys, so renaming either strands those installs; a new key is safe.

## Reporting AI output

- **Every surface that shows AI output has a Report action, and a route that snapshots what it
  showed.** Google Play's AI-generated content policy requires in-app reporting of AI output, and a
  reviewer meets the creation chat first. Until 2026-10-12 its replies, the plan card, a drawn
  saved-character picture and every Writing Studio suggestion had none — "Report book" appears only
  once a manuscript exists, so nothing covered the chat that comes before it. Books, book pictures,
  voice calls and book-chat replies report through `../mobileSafety.ts`; creation-chat replies
  (`/creation-sessions/:id/messages/:messageId/reports`), plans (`/projects/:id/plans/:planId/reports`),
  character pictures (`/characters/:id/images/:imageId/reports`), stored Studio assists
  (`/projects/:id/manuscript/assists/:aid/reports`) and quick Studio suggestions
  (`/projects/:id/manuscript/assist/reports`) through `../aiOutputReports.ts`. Every one is the
  owner's only (another reader's row is a 404, never a 403), shares the one report limiter, writes
  a `ModerationReport` through `../moderationReports.ts`, and snapshots what the reader was shown,
  read field by field rather than spread, because a plan package or an illustration's result
  carries provider provenance. A chat branches, a plan is revised and a suggestion is discarded long
  before anyone reviews it, so the snapshot is the evidence, not the row. A quick suggestion is
  never stored, so its report carries the app's text and says `origin: "app"`. A target the reader
  made is refused 422 `NOT_AI_GENERATED`: an uploaded or adopted character picture, the plan of an
  author's book. A picture report names its file, which is what lets the operator route
  `GET /api/admin/moderation/reports/:id/picture` serve it and what keeps a Studio picture out of
  the image sweep (`studioImageReferences.ts` reads report snapshots). A new AI surface needs all
  three halves: the app's Report through `reportAiContent`
  (`apps/mobile/lib/features/projects/presentation/ai_content_report.dart`), a route here that
  snapshots it, and a target type the operator queue renders
  (`apps/web/src/features/admin/ReportSnapshot.tsx`). A new target type is
  an `ALTER TYPE` migration on its own, as `000097_report_ai_output` is: Postgres will not use an
  enum value in the transaction that added it.
