# API

Fastify. Validates requests, reads/writes Postgres, enqueues jobs. It must not call AI providers
for anything long-running — that belongs in the worker.

The short-lived exceptions are deliberate and time-boxed: creation-chat turns and the book advisor
call a fast model inline with an explicit timeout (see `mobile/creationBuild.ts` and
`mobileCreation.ts`), and the share-note moderation gate makes one Jev decision with a 25 s budget
of its own (`userTextModeration.ts`). Anything that can take more than a few seconds gets a job.
Mobile voice is a streaming exception: `mobile/voiceRelayConnection.ts` owns a WebSocket pair
so it can close provider access when its durable billing lease or funded time expires.

## Route surfaces

- `src/mobile/routes/` — `/api/mobile/*`, used by the Flutter app. This is the product surface, and
  it has its own `CLAUDE.md` carrying the "adding a route" checklist and the domain invariants.
- `src/routes/` — the older operator API behind `WEB_PASSWORD`, used by `apps/web`. Also has its
  own `CLAUDE.md`; the short version is that a mobile bearer token is rejected there before any
  handler runs, and that is a security property rather than tidiness.
- `src/admin/` — `/api/admin`, read by the operator dashboard only.
- `src/mobile/shares/publicShareRoutes.ts` — `/s/*`, the public book-share pages. Deliberately
  outside `/api/` and the auth hook's protected set, and proxied in production only because
  `deploy/nginx.conf` names `/s/`; see "Book sharing" in `src/mobile/CLAUDE.md`.

`src/mobileProjects.ts` is the composition root: it builds one `MobileRouteContext` and calls each
`registerMobile*Routes(fastify, context)` in turn. They run on the same Fastify instance rather
than through `fastify.register`, so they share one encapsulation context — the
`application/octet-stream` parser registered there covers the attachment upload routes. Moving to
`register` would break that. Everything `mobileProjects.ts` re-exports is public API consumed by
`server.ts`, `mobileImports.ts` or tests; don't narrow those exports without checking callers.

## Project costs

Project cost summaries retain settled calls with unknown usage in `unpricedTextCalls`.
Their estimated token counts contribute no dollars; `projectCosts.ts` filters in-flight calls,
and the core cost summary preserves the recorded unknown status.

## Private durable objects

Every generated book, illustration, voice clip, narration, uploaded original and run artifact
lives in private S3 through `@book-maker/storage`. API routes authorize ownership before reading
bytes and proxy the result; bucket URLs are never returned to clients. Keys use explicit
`books`, `images`, `voice`, `audio` and `attachments` namespaces. Legacy directory arguments on
internal helpers do not select storage or enable a disk fallback. Missing objects return null;
S3 failures propagate rather than masquerading as missing exports and triggering repair work.
Inline renderers use cleaned temporary directories and `imageSource: "object-storage"`.
Tests inject `MemoryObjectStore` in `src/testing/setupObjectStorage.ts`; fixtures seed object keys.

- **A deleted book's prefixes are written down before they are deleted, and deleted again until
  they stay empty.** `deleteProjectStorage` (`src/projectStorage.ts`) tried each of the book's four
  prefixes once: an S3 failure was a log line, the delete still answered 200, nothing retried, and a
  job still running for the book (a stop is a request, not a kill) could write run-log events and
  pictures into the emptied prefix afterwards — bytes the deletion promise to Google Play says are
  gone (launch review, 2026-10-13). It now upserts each prefix into `PendingStorageDeletion`
  (migration 000111) before the first delete, and `runStorageDeletionSweep`
  (`src/storageDeletionSweep.ts`, every 15 minutes) lists and deletes each prefix again, dropping
  the row only once the deletion is a day old **and** that pass found nothing. The return shape and
  the 200 are unchanged, so the reader's delete, the operator's and account deletion need no edit; a
  record that cannot be written is logged (`storage.deletion_unrecorded`) and the delete still runs,
  because the book's row is already gone. The worker is untouched: what the sweep removes is what it
  wrote after the row went. Account deletion records its own objects' prefixes the same way before
  it deletes them — character pictures, draft and import uploads, source originals — and their
  deletes still propagate and keep the request pending (`docs/storage.md`).

## The two auth systems are unrelated

- **Mobile users** — database-backed accounts under `/api/mobile/auth/*`. Bearer access tokens,
  refresh tokens, only hashes stored in `MobileSession`. Real multi-user auth. Installed apps read
  the session response's `accessTokenExpiresIn` (their clock may be wrong) and sign the reader out
  on `SESSION_REVOKED` / `ACCOUNT_DISABLED`; keep both spellings ("Sessions" in
  `apps/mobile/CLAUDE.md`).
- **Operator console** — a single `WEB_PASSWORD` cookie guarding `/api/*`, `/docs` and
  generated assets. Not per-user. Optional locally; production refuses to start without a strong
  one (`packages/core/src/productionConfig.ts`, see "Production configuration" in
  `packages/core/CLAUDE.md`).

Everything protected is cookie-only except `/api/mobile/*` and the two asset prefixes.
`allowsMobileBearer` in `src/requestAuth.ts` names that surface; `isOperatorOnlyPath` in
`src/auth.ts` is literally its complement.

- **Every auth decision reads the route the router matched, never `request.url`, and only the auth
  hook makes an operator.** `request.url` keeps its percent-encoding and find-my-way decodes it
  before matching, so the hook read `GET /%61pi/admin/users` as a path outside `/api/`, protected
  nothing, and the `/api/admin/users` handler ran. nginx forwards `$request_uri` raw, so that was
  the whole console from the internet (found 2026-10-12, before launch). `routedRequestPath`
  (`src/requestAuth.ts`) answers the matched pattern (`request.routeOptions.url`); only a 404 or a
  catch-all (`/*`, CORS's `*`) falls back to the decoded path, and a path that will not decode is
  `null`, protected as operator-only. The auth hook, the 426 app-update gate and the 428 terms gate
  all read it. The hook was also the *only* lock: `resolveProjectActor` made an operator out of a
  missing bearer and the admin handlers called `markOperatorRequest` themselves. That function is
  now private to `src/auth.ts`, and `requireOperatorActor` refuses any request the hook did not
  mark, so a future bypass reaches no one. A new path check takes `routedRequestPath`; a new
  operator route calls `requireOperatorActor`. `src/auth.test.ts` and `src/requestAuth.test.ts`
  pin both halves, the second over every admin and legacy operator route the router holds.
- **Every unauthenticated route that runs scrypt is limited by client network before it hashes,
  and hashing itself is gated.** Sign-up, sign-in, forgot and reset were limited per address +
  email and per email alone, so one address spraying invented emails met a fresh bucket on every
  request, and each request ran scrypt (N=2^14, r=8). About a hundred a second fills Node's four
  libuv threads, which also serve the filesystem, DNS and sharp, so one caller could stall the
  whole API and spray passwords across accounts (pre-launch review, 2026-10). Each of those routes,
  and `POST /api/mobile/auth/google`, now takes a `clientNetworkRateLimitKey` limit
  (`src/rateLimit.ts`) after body validation and before any lookup or hash, and ahead of the
  per-email limits so a refused request spends no bucket that belongs to the address it named. The
  key is the IPv4 address or the IPv6 /64 (`clientNetworkKey`, `src/clientNetwork.ts`, the same
  key the welcome grant counts), because an IPv6 client picks a new address in its /64 for free.
  Defaults: sign-in 30 and reset 30 per 15 min; forgot 10 per 15 min, since each one mails
  someone; sign-up 10 per hour, since an account is once per person and the welcome grant stops
  at one or two per address anyway. That is the trade: a classroom behind one school address
  signing up together queues past the tenth. Many addresses at once still get past any per-caller
  limit, so every derivation (`hashPassword`, `verifyPassword`, `simulatePasswordVerification`
  in `src/passwordHashing.ts`) runs through `passwordHashGate`: two at once, 32 waiting, and the
  next refused with `PasswordHashingBusyError`. Each auth plugin installs
  `passwordHashingErrorHandler`, which answers that as `RATE_LIMITED` with `Retry-After: 1` (the
  code and sentence the app already shows) and rethrows anything else to the server's handler. A
  refusal can land on any hash in a route, so a route hashes before it spends anything a retry
  would need; reset hashes the new password before it consumes the code. Forgot also caps codes
  per email at 10 a day, counted last and before the lookup, so a capped address answers the same
  429 whether or not it has an account. That count is memory and a deploy empties it, so the day is
  counted again in the database and survives a restart: a new code *expires* the pending ones in
  place rather than deleting them (the reset claim and consume re-test expiry on the clock as it is
  then), the lookup carries a filtered `_count` of the account's codes from the last 24 h, and an
  account at the cap gets the unknown account's `{ ok: true }` with nothing issued or mailed — a
  429 there would say the account exists, since only an account has rows to count. Rows older than
  the day are deleted on the next issue. A new unauthenticated route that hashes takes a network
  limit first and lives in a plugin with the handler installed. `src/passwordHashing.test.ts`,
  `src/rateLimit.test.ts` and the three auth suites pin it.
- **An address is proven by a confirmed emailed code or by Google, and only a code mailed to the
  address the account has now can prove it.** The welcome grant waits for `User.emailVerifiedAt`
  (`packages/db/CLAUDE.md`). `POST /api/mobile/auth/email/verification` mails a 6-digit code and
  `…/verification/confirm` takes it (`src/mobileEmailVerification.ts`); sign-up mails the first one
  itself, not awaited and never failing the sign-up (`sendFirstEmailVerificationCode`,
  `src/emailVerificationCodes.ts`, which is a module of its own because the routes import
  `mobileAuth.ts` and sign-up needs the issuer). Both routes sit under `/api/mobile/auth/`, so the
  auth hook leaves them to their handlers, which check the bearer as `/auth/me` does, and no terms
  gate stands in front of them. The account is signed in, so unlike forgot-password a capped
  account is told it is capped: 429 with the real `Retry-After`. Limits: per client network 10 sends
  and 30 confirms per 15 min, per account 5 and 10, and from the rows (so a deploy forgets nothing,
  and sign-up's code counts) one code a minute and ten a day; five guesses per code, claimed before
  the compare. A code is a salted SHA-256, not scrypt: it is no credential (it only confirms an
  address for a reader already holding a session), and staying off the hashing gate keeps a busy
  gate from failing the sign-up that sends it. A row stores the address it was mailed to; confirm
  looks only for codes to the account's current address and stamps the user with `updateMany`
  conditioned on that address, so an email change — which no route offers yet, and which must clear
  `emailVerifiedAt` in the same write — cannot be verified by an older code. A send whose mail
  fails deletes its row, so the failure costs no wait. Google sign-in stamps the account on create,
  on link (the account was found by the address Google vouched for) and on a later sign-in by
  subject whose address still matches; account deletion clears the stamp and the codes. Wire codes
  `EMAIL_ALREADY_VERIFIED` (409, send), `INVALID_VERIFICATION_CODE` (400) and
  `VERIFICATION_EMAIL_UNAVAILABLE` (503: no mailer, or the send failed), each with its one sentence
  in `EMAIL_VERIFICATION_MESSAGES`. Production needs SMTP for anyone new to be welcomed.
  `src/mobileEmailVerification.test.ts`, `src/mobileGoogleAuth.test.ts`.
- **A console cookie is signed with the generation it was issued under, lives a week, and "sign
  out everywhere" moves the generation.** The cookie was a stateless HMAC over a 30-day expiry, so
  logout cleared one browser and a copied cookie stayed good for a month unless `WEB_PASSWORD` was
  rotated (launch review, 2026-10-13). Its payload now carries `epoch`, checked against the one
  `OperatorSessionEpoch` row (migration 000108; no row is 0) through `currentOperatorEpoch`
  (`src/operatorSessions.ts`, cached 30 s, single-flight). `POST /api/auth/logout-everywhere`
  (cookie checked in the handler, since `/api/auth/*` is outside the protected set) increments it,
  which refuses every cookie issued before, its own included. The read happens only for a cookie
  whose signature and expiry already verify, so the mobile surface never pays for it. **It fails
  closed**: a failed read keeps the last generation this process saw, and with none the cookie is
  refused and login answers 503 rather than issue a cookie nothing could verify. A cookie with no
  `epoch`, or an expiry more than a week out, predates this and is refused — the operator signs in
  once after the deploy. The console's sidebar has a **Sign out everywhere** button
  (`logoutEverywhere` beside `logout` in `apps/web/src/features/auth/useAuth.ts`). A suite that signs in with a password needs
  `operatorSessionEpoch` in its `@book-maker/db` mock (an empty `vi.fn()` reads as generation 0).
- **Console and `/docs` responses carry `X-Frame-Options: SAMEORIGIN`, `nosniff` and
  `Referrer-Policy: same-origin`; the app's and the share pages' do not.** An `onSend` hook in
  `registerAuth` sets each one the response has not set itself, on every path `allowsMobileBearer`
  refuses except `/s/`, whose pages set their own. SAMEORIGIN rather than DENY, because the
  console's PDF preview frames an export URL of the same origin. In production nginx serves the
  console's own HTML, so it needs the same three headers in `deploy/nginx.conf`.

## Creation chat

- **A fallback brief says what the lane says; it echoes the idea only where it can tell where the
  echo ends.** `completeRecipe` (`src/mobileCreationAdvisor.ts`) fills the brief the planner is
  shown — "Audience or reader", "Promise or story shape" — from the model's recipe, and from
  `src/mobileCreationLanes.ts` when the model gave none. Those fallbacks used to splice the raw
  idea in: the audience was everything from "for" to the next comma, and the promise was "get a
  useful first step for" plus a six-word "cleaned" title. A Quick Draft guide on 2026-09-30 went
  to the planner with `Audience: new first-time managers on running genuinely useful one-on-one
  meetings with their direct reports: how to structure them` and `Promise: get a useful first step
  for i want a practical , what`. `promiseFallback` now takes only the lane, and `audienceFor`
  returns a span only when it ends at a clause boundary, runs eight words or fewer and contains a
  reader noun (`AUDIENCE_NOUN`), skipping a purpose ("for supply chains today") and a phrasal
  "looking for" on the way to a reader behind it — otherwise it returns nothing, which also lets
  `payload.brief.audience` speak before the lane's generic audience does; it never could, because
  the old function always answered.
- **A creation-chat turn runs at most two grounded searches, counted in the tool, not the loop.**
  `runToolLoop` executes every tool call a model response names, so one response asking for five
  `web_search` calls was five paid grounded searches inside the API process (pre-launch review,
  2026-10). `enrichCreationTurnWithSearch` (`src/mobileCreation.ts`) counts searches in a closure
  rebuilt per turn and stops at `CREATION_CHAT_WEB_SEARCHES_PER_TURN`; a call past it returns
  `CREATION_SEARCH_BUDGET_SPENT_RESULT` as an ordinary result — never a throw, which would set
  `searchFailed` and read to the model as a broken tool. The count is taken before the first
  `await`, so it holds even if the loop ever runs calls concurrently. The cap lives in the tool so
  the loop's semantics stay the same for the worker's writer tools and the edit chat.
  `src/mobileCreationSearchBudget.test.ts` pins one parallel batch, consecutive rounds, and a fresh
  budget per turn.

## App updates

- **An app update is a policy per store release, and only a build that already sends its build
  number can ever be retired.** Each `AppUpdatePolicyRevision` (append-only, edited at
  `/admin/app-updates`) lists store releases, each `silent`, `prompt` or `required` for the builds
  below it. `decideAppUpdate` (`src/appUpdates.ts`) answers a build from the releases newer than it,
  strongest policy winning, so one required release keeps every build below it gated whatever
  ships after. The app sends `X-App-Build` and `X-App-Platform` on every request (`dioProvider`);
  `GET /api/mobile/app-update` is its public launch-and-resume check, and `registerAppUpdateGate`
  answers 426 `APP_UPDATE_REQUIRED` to every other `/api/mobile/*` request from a required build.
  The gate runs ahead of auth, so even sign-in is refused. A request without the headers (the
  console, curl, the suites) is never gated. That is why the client half is load-bearing: an
  installed build only ever does what it shipped knowing, so renaming a header or the 426 body
  strands every build already on phones.
  - **426, never 403.** The app's `ApiException.isAuthFailure` reads 403 as a dead session and
    clears the tokens.
  - **It fails open.** A policy the database cannot return, or one that no longer parses, gates
    nobody. The head is cached for 30 s, and a console save drops that cache in its own process.
  - **The app reads an unknown action as no update** (`AppUpdateAction.fromWire`), so a newer
    server cannot lock an older build out by adding a policy word.
  - **Ask or Require only once Play Console shows 100% rollout**, and about a day after that.
    A reader outside a staged rollout has nothing to install, so a required update locks them out.
    The console says so; nothing enforces it.

## Push notifications

- **A book push is decided by the API's sweep from the status the app already reads, and its
  ending is sent only by the delete that claims the book's row.** The percent the app shows is
  computed only in `apps/api` (`loadSerializedProjectStatus`, from many job rows; the worker never
  stores one), so the pushes are driven from here rather than from worker hooks.
  `runBookPushSweep` (`src/push/bookPushSweep.ts`, every 15 s from `server.ts`) follows every
  `GENERATING` book whose owner has a live device. A progress push is a compare-and-swap on
  `ProjectPushState.version`. The ending (ready, failed, or a silent clear when the owner pressed
  Stop) is sent only by the `deleteMany` that matched the version the sweep read, so two sweeps
  never both announce it. Edits, continuations and narration are deliberately not followed.
  Setup and behaviour are in `docs/push-notifications.md`.
  - **A device is reachable only through the session that filed it**
    (`livePushDeviceWhere`). Logout revokes the session and so stops the phone's pushes without
    an unregister call; account deletion deletes the sessions, and `PushDevice` cascades.
  - **The data keys and `kind` values are a wire contract with installed builds**
    (`src/push/bookPushMessages.ts` ↔ `apps/mobile/lib/features/notifications/domain/book_push.dart`).
    The app ignores a kind it does not know, so adding one is safe; renaming one silences every
    build already on phones. Android gets data-only messages because the app draws the progress
    bar itself; iOS gets only the endings, as APNs alerts.
  - **Only a token FCM calls dead is deleted**: `UNREGISTERED`, `SENDER_ID_MISMATCH`, or an
    `INVALID_ARGUMENT` whose message names the registration token. A bare `INVALID_ARGUMENT` is a
    malformed *message*, and deleting every device over a bug in the payload would be the wrong
    lesson.
  - With no FCM key (and `MOCK_PUSH` off) `createPushSenderFromConfig` returns null and the sweep
    never runs. That is a logged warning, never a failed boot.

## Account deletion

- **A deletion request is carried out a day after it is made, and the user row stays as a tombstone
  that keeps the financial records.** `POST /api/mobile/account/deletion-request` used to record a
  PENDING row and nothing completed one, while the app and the public page promised deletion within
  30 days and Google Play requires it (2026-10-03 launch audit). `runAccountDeletionSweep`
  (`src/accountDeletion.ts`, hourly from `server.ts`) runs `executeAccountDeletion` once
  `ACCOUNT_DELETION_GRACE_MS` (24 h) has passed, and `POST /api/admin/account-deletions/:id/complete`
  runs it at once for a request support received by email. It deletes every book through the same
  stop-jobs, delete and storage cleanup the book's own delete runs, then drafts and their uploads,
  imports, saved characters and their pictures, voice calls with their transcripts, sessions, the
  password, email-verification codes and the verified stamp, the legal acceptances, the author
  profile, retained source extractions (the
  `SourceDocument` delete cascades every version and chunk) and the product analytics events
  (`ProductEvent`). The `User` row is kept — email replaced by
  `deleted-<id>@deleted.invalid`, name cleared, `DISABLED` — because `Project` and
  `MobileCreationDraft` restrict its deletion and because the credit ledger, purchases and
  subscriptions it owns are the billing records the policy pages say are retained. A tombstone
  cannot sign in and frees the email for a new account.
- **Deleting an account stops its Play subscriptions, and keeps a welcome grant's address only
  while the cap still counts it.** Deletion never told Google, so a deleted subscriber kept being
  charged every month for a tombstone — chargebacks, and a deletion that was not final (pre-launch
  review, 2026-10). `executeAccountDeletion` first calls `cancelAccountSubscriptions`
  (`src/accountSubscriptionCancellation.ts`): for each subscription Google may still charge it asks
  Google whether it will renew, and if so cancels it through `subscriptionsv2:cancel` with
  `DEVELOPER_REQUESTED_STOP_PAYMENTS` (the paid period runs out; the reader cannot restore it). A
  closed row drops its raw `purchaseToken`. It is best effort and never throws, so a deletion never
  waits on Google; whatever Google did not confirm keeps its token and
  `retryDeletedAccountSubscriptionCancellations` retries it from every hourly sweep, 20 at a time,
  for accounts whose request is COMPLETED. A paused or on-hold subscription is cancelled whatever it
  says about renewal, because Google resumes it on its own. The renewal sweep skips tombstones
  meanwhile (`src/mobile/CLAUDE.md`). The `WelcomeCreditGrant` row stays, because
  `welcomeCredits.ts` counts GRANTED rows settled inside its 30-day window per address hash:
  clearing a counted hash would let an address be welcomed again just by deleting an account. So
  the hash is nulled at deletion only for a grant that never paid out, and the sweep nulls the rest
  once their window has passed (`welcomeIpHashRelease`); the coarse signup country stays with the
  billing record. The public Terms, Privacy and deletion pages and the app's Delete account card
  say the same: deletion cancels the Play subscription so it does not renew, and uninstalling does
  not. `accountDeletion.test.ts`, `accountSubscriptionCancellation.test.ts`.

## AI spend breaker

- **Every door that starts AI work asks the spend breaker before it reserves anything; the breaker
  fails open on a failed read, but a pause it has already seen holds.** The launch budget is ~$200
  a month for everything, $75–125 of it for providers, and nothing in the product could stop a
  viral day, an account farm or a runaway client from spending a month of it before anyone looked
  (pre-launch review, 2026-10). `spendBreaker.ts` answers "may this reader start this kind of
  work now?" from provider spend (`SUM("costHint")`, so a floor) against the operator's
  `AiSpendControlRevision` (`spendControls.ts`, defaults and their arithmetic there, edited at
  `/admin/spend`). The global caps count free spend and stop only free accounts (next bullet):
  paused is 503 `AI_PAUSED` for everyone; past the monthly ceiling or the hard cap a free account
  (no active plan, `hasActiveSubscriptionEntitlement`) gets 503 `AI_PAUSED` with `resetsAt`; past
  the soft cap it gets 503 `AI_BUSY` for Ultra and its welcome grant waits (the breaker still lists
  voice and audiobooks as `AI_BUSY` kinds, but both are plan perks refused 403
  `SUBSCRIPTION_REQUIRED` before it is asked, so a free account never meets it there, and
  `AI_BUSY_MESSAGE` names Ultra alone);
  past the paid cap a paying reader gets 503 `AI_PAUSED`; and in every state that lets work
  through, a reader past their own daily cap gets 429 `AI_DAILY_LIMIT` with `resetsAt`. The
  console's `local-admin` is never a free account, has no per-reader cap, and the operator routes
  never ask. Each code owns
  its sentence in `mobile/aiCapacity.ts`, which is the door side: `requireAiCapacity` at a route,
  `assertAiCapacity` in a shared start path (its `AiCapacityRefusedError` is answered by
  `sendGenerationAttemptError`), `proposalRunsModel` for the chat's priced cards. **Where it sits is
  the rule**: after auth, validation and any replay of work already paid for, and before every
  reservation, message-usage hold, free-tier slot claim and — where the kind is known that early —
  rate limiter, so a refusal costs and claims nothing and asking again while the breaker is open
  spends no bucket. A gate after a write is worse than none: a chat Apply refused after its
  "Apply" row is written would leave every retry of that requestId reading as still in progress. The doors are the
  creation chat (start with a message, message), the build/preflight/legacy create
  (`prepareMobileCreationBuild`), the book advisor, attachment upload and source retry, plan,
  revise (direct and chat), approve, resume, both edit retries, chat turn and Apply, portrait,
  voice calls (book and library), audiobook start, Studio quick and stored assists, Studio AI
  cover, and import. The character photo upload degrades instead of refusing: it is stored with no
  vision suggestion, exactly as with no vision provider. Deliberately not gated: free actions with
  no model call, the share note's one Jev decision (it degrades to held-for-review anyway), the
  bundled voice samples, and Studio publish/takeover/cover removal (free author actions whose
  worker side makes small design-cover, style and embedding calls). **It never pauses the worker**:
  a queued job was paid for when it was queued, and a connected voice call runs to its end.
  **It fails open** because it protects a budget and must not become a second way for the product
  to go down: a failed controls read keeps the last controls this process saw (a pause included)
  or the defaults, a failed global read keeps the spend already seen today or this month (spend
  only grows within a window, so it is still a floor) or zero, and a reader's spend or plan that
  cannot be read counts as zero and as paid — all logged at error level. Global state is read once
  a minute per process, single-flight; a reader's spend is cached ten seconds, so a reader can run a
  few seconds past their cap. Each process warns `ai_spend.soft_cap_reached` /
  `ai_spend.hard_cap_reached` / `ai_spend.paid_cap_reached` once per UTC day and
  `ai_spend.monthly_cap_reached` once per month. The welcome hold is a predicate `server.ts` installs into `@book-maker/db/billing`
  (`setWelcomeGrantHold`), because every balance read and reservation settles a pending grant and a
  hold threaded through their callers is one the first forgotten caller grants past; the billing
  payload refreshes the breaker before it reads the balance and sends `welcomeCreditsPending`.
  `spendBreaker.test.ts` holds the decision table and the failure modes, and
  `mobile/aiCapacityDoors.test.ts` drives refused doors and asserts nothing was spent.
- **The spend breaker's global caps count what free accounts cost; a paying reader answers only to
  their own cap, the paid cap and a pause.** The caps used to compare everyone's spend, so paying
  readers' books could hold back new readers' welcome credits, and a farm of free accounts — welcome
  credits, capped only per address — could trip the $40 hard cap and pause AI for the people paying
  (launch review, 2026-10-13). `spendBreakdown.ts` splits a window's spend into free readers, paid
  readers and calls that name nobody: one `groupBy` on `userId` over the `(createdAt)` index, then
  one chunked `UserEntitlement` read for the readers it found. The soft ($5/day), hard ($12/day) and
  monthly ($150 per UTC month) caps compare free plus unattributed spend — a deleted account's rows
  lose their user and land there too — and stop only free accounts; the paid cap ($60/day) is a
  catastrophe stop on paid spend, which revenue backs, and stops only paying readers. **Paid is a plan
  held at any moment of the window** (ACTIVE or EXPIRED plan entitlements overlapping it; an
  EXPIRED write always stamps `expiresAt`), not `hasActiveSubscriptionEntitlement` asked now: asked
  at an instant, a subscriber whose plan lapsed at tea time would move the whole day's — or month's
  — spend into the free counter and could trip the free caps for everyone. A refunded (REVOKED)
  plan counts as free. `local-admin`'s console books count as paid. The door still classifies the
  reader asking by `hasActiveSubscriptionEntitlement`. Today's split is read every minute; the
  month's earlier days once per UTC day per process, since they no longer move. The welcome hold
  follows the free state only (soft, hard, monthly or paused), never paid spend. Each refusal owns
  its sentence: a free account past the hard cap or the ceiling is told paid plans are not affected,
  with `resetsAt` (00:00 UTC, or the 1st); the pause and the paid cap keep the plain pause sentence.
  The alert sweep has a condition per cap (`spend_soft`, `spend_hard`, `spend_monthly`,
  `spend_paid`). Migration 000107 added `freeMonthlyCapUsd` and `paidHardDailyCapUsd` nullable,
  so a revision saved before it reads the compiled defaults for those two.

## Content safety

- **The sexual-content filter is on unless a revision says off: its rule rides every text call where
  it leaves the process, a failed switch read keeps it on, request screens fail open and the share
  screen holds for review.** The only guard against sexual content involving minors used to be one
  English regex (`namesChildSexualExploitation`, core `contentRestrictions.ts`) and no prompt said
  anything, so "an erotic story about two 15-year-olds" reached whichever text model the tier routed
  to (pre-launch review B4, 2026-10-13). The switch is `SafetySettingsRevision.sexualContentFilterEnabled`
  (migration 000103), toggled on the console's Safety screen through `PATCH /api/admin/safety-settings`
  (`routes/adminSafety.ts`), which takes either switch alone and carries the other over. **No
  revision is ON** — the opposite of the copyright flag — and so is a row that predates the column
  (`readSexualContentFilterEnabled`, `@book-maker/db/safetySettings`). Every process reads it through
  `createSexualContentFilterFlag`: at most once a minute, single-flight, and a failed read answers ON
  and is cached like any answer. A console save forgets the API process's copy at once; the worker
  and other API processes follow within the minute. A suite's stand-in client with no safety table
  reads as off, as it does for copyright, which is what keeps the rule out of suites that never ask.
  - **The rule** (`SEXUAL_CONTENT_RULE`, core `contentSafetyRule.ts`) is one fixed English paragraph
    *prepended* to the first system message, or sent as the system message when a call has none. The
    same prefix on every call keeps provider prompt caching, and a prompt's own last sentence — the
    one naming a JSON reply's keys (`packages/core/src/generation/CLAUDE.md`) — stays last
    (`generateJsonWithRetry`'s JSON contract lands between the two). It is injected where calls leave
    the process, never in a prompt builder, so no new prompt can be written without it: in the worker
    at the top of every `LoggingTextModelAdapter` method (`apps/worker/src/providers/contentSafetyRule.ts`),
    so every writer, planner, reviewer, rewrite, judge and source summary carries it, bound or not,
    and the run log records what was sent; in the API by both model factories in
    `generationTextModelRouting.ts` (`withContentSafetyRule`, `contentSafety.ts`), the only way an
    inline model is built — creation chat, advisor, build, the book chat's router and composers,
    Studio quick assists, attachment summaries; and in front of the voice persona
    (`connectVoiceCall`). Jev decisions and grounded searches carry none: they write no prose.
  - **The screens** (`contentSafetyScreen.ts`, run only while the switch is on) are the share note's
    Jev gate on two surfaces of its own, `book_request` and `book_text` (`moderateUserText`), each
    offered three options — `allowed`, `sexual`, `child_safety` — whose wording is the classifier
    and is **unmeasured**: measure it on a labelled set the way the caption wording was before
    trusting it, and fix the words, never the threshold. The request screen sits at the doors where a
    request becomes a book — the creation build and its preflight (idea, notes, details and the
    chosen thread's messages), the first plan, a direct plan revision, plan approval (never its
    replay) and every book-chat message but a typed cancel — after auth, validation, replay and the
    spend breaker and before any reservation, slot, hold or write (`mobile/contentSafetyDoors.ts`).
    A confident verdict answers the deterministic screens' own 422 `CONTENT_RESTRICTED`, reason
    `sexual_content` or `minor_sexual_content`, with the sentence core's `sexualContentRefusal` owns,
    so every installed app already shows it. **It fails open**: no verdict — each window gets 8 s,
    not the note gate's 25, since the app gives up at 20 — is a logged
    `content_safety.request_undecided` and the request goes on under the rule, because the product
    must not go down with its moderator. The share screen reads the title, matter and every page in
    8,000-character windows, eight at a time inside a 12 s budget, at create and every mode change,
    after the deterministic book screen — and **again whenever the book's revision moves past the
    revision the share was screened at**, because a share serves only text screened at the book's
    current revision (the share re-screen below). A confident verdict is the same 422 with nothing
    written; windows without one — or past the budget or the 300-window cap — **hold rather than
    allow**: the share goes live with a system `ModerationReport` (`targetSnapshot.kind:
    "book_text_review"`) written in the share's own transaction, the note gate's held-for-review
    answer, because a stranger reads what passes. Verdicts are cached ten minutes by text hash, so a
    preflight and its build, a mode change, or a re-screen after an edit pay for no second read of
    the windows that did not change. The CSAM names regex runs whatever the switch says.
    `contentSafetyScreen.test.ts`, `contentSafety.test.ts`, `mobile/contentSafetyDoors.test.ts`
    and the worker's `providers/contentSafetyRule.test.ts` pin all of it.
  - **A share serves only text screened at the book's current revision, and a refused re-screen
    turns the link off for the author to share again, never takes it down.** Until 2026-10-15 a share was screened once, while `/s/<slug>/book.pdf` serves the
    book's current compile, so an Edit Mode save (no screen at all, not even the CSAM regex), a chat
    edit, undo and redo, a matter edit, a Studio publish or a takeover put text in front of strangers
    nobody had read (launch review 2026-10-15, C2). Every screen now stamps the `contentRevision` it
    read the text at on `BookShare.screenedContentRevision` (migration 000113; null — every share
    from before it — needs a screen), reading the text and the revision in one REPEATABLE READ
    snapshot (`readSharedBookText`). A share whose book has moved past its stamp is answered as being
    updated until it is screened again, by the same two screens with the same meanings
    (`screenSharedBook`): passed stamps the new revision; a confident refusal turns the link off —
    REVOKED with a system reason, never an operator's permanent `TAKEN_DOWN`, because this screen's
    wording is unmeasured and the refused text was never served — and the author's next share runs
    the create-time screen with its 422; no verdict holds it live with one pending
    `book_text_review` per share. The re-screen runs in
    the `share_rescreen` background sweep (a bounded batch every two minutes, 60 s budget, since no
    request is waiting) and on a public request for a stale share — at most once per share and
    revision in this process, never twice at once for one share, and at most two at once across all
    of them, so public traffic cannot buy model spend. The rest is "Book sharing" in
    `src/mobile/CLAUDE.md`; `mobile/shares/shareRescreen.test.ts` pins it.

## Account moderation

- **An operator's suspension is a status, not a tombstone: everything that asks for ACTIVE refuses
  it, and only a deletion's sweeps read DISABLED.** Only account deletion ever changed a user's
  status, so an abusive reader could not be stopped short of deleting them, and a takedown blocked
  one book at a time while the Terms promise the operator can disable sharing for an account (launch
  review, 2026-10-13). `POST /api/admin/users/:id/moderation` (`routes/adminAccounts.ts`, the user
  inspector's buttons) runs `moderateAccount` (`accountModeration.ts`) with `suspend`, `unsuspend`,
  `disable_sharing` or `enable_sharing` and a required reason; each writes an append-only
  `AccountModerationAction` (who, when, why, what it did — migration 000109, beside
  `UserStatus.SUSPENDED` and `User.sharingDisabledAt`). Each refusal code owns one sentence there.
  - **What a suspension does.** Every mobile session is revoked in the same transaction, so the
    next request answers `SESSION_REVOKED` and the app signs out (`apps/mobile/CLAUDE.md`); sign-in
    then answers 403 `ACCOUNT_DISABLED` *after* the password matched (Google sign-in already did),
    with the code's one sentence, `ACCOUNT_DISABLED_MESSAGE` in `mobileAuth.ts`, which says the
    account is suspended and where to write. Push (`livePushDeviceWhere`), password reset and a
    connected voice call's next relay lease (`voiceRelayBilling.ts`) all ask for ACTIVE already.
    Every live share is taken down (`/s/` answers its 410) under the fixed
    `ACCOUNT_SHARE_TAKEDOWN_REASON`, and every QUEUED or ACTIVE job on the account's books is
    stopped through `stopProjectGenerationJobs` after the commit — the reader's own stop, so what
    was delivered is kept and the rest refunded. Stopped rather than finished because finishing
    spends provider money on what the account is suspended for; a stop that fails is counted and
    logged, never a refused suspension. A library portrait (no book) runs out, and a start already
    past auth when the suspension commits can still queue one job.
  - **What it does not do.** It never cancels a Play subscription: Google keeps charging, so the
    renewal sweep (`subscriptionRenewal.ts`) reads ACTIVE *and* SUSPENDED and keeps recording orders
    and granting allowances, and the inspector says so beside the button. The deletion,
    Play-cancellation and welcome-hash sweeps read DISABLED plus a COMPLETED request, so a
    suspended account is none of theirs until it is deleted, and deletion makes it DISABLED.
  - **Lifting it.** `unsuspend` restores ACTIVE; sessions stay revoked and stopped books stay
    stopped. Shares carrying `ACCOUNT_SHARE_TAKEDOWN_REASON` come back, as REVOKED and never live,
    only once neither account action holds (the author shares again, and the share's checks run
    again); a share an operator took down by itself keeps its reason.
  - **Sharing off** takes the live shares down the same way and refuses a share `PUT` and a remix
    from the account with 403 `SHARING_DISABLED` (`mobile/shares/shareCopy.ts`; a 403 the app shows,
    since only the two session codes sign it out). **Both actions and every share write are ordered
    on the user row**: the action takes it `FOR NO KEY UPDATE`, `writeShare` takes it `FOR SHARE`
    (`accountMayShare`) before its own share-row lock, so a share either commits before the
    takedown reads the account's shares or reads the new state and refuses. The console's own
    `local-admin` cannot be moderated. `accountModeration.test.ts`,
    `mobile/shares/shareRecords.test.ts`, `mobile/shareRoutes.test.ts`.

## Monitoring and alerts

`src/monitoring/` holds the readiness probe, its route and the operator alert sweep. The runbook —
what each alert means, the uptime monitor, the CloudWatch alarms in `monitoring.tf` — is
`docs/deployment.md`, "Monitoring and alerts".

- **`/api/health` is liveness and touches nothing; `/api/ready` is readiness and is what a monitor
  watches.** Nothing used to tell the owner production was down (pre-launch review, 2026-10):
  `/api/health` answered `{ ok: true }` without touching a dependency, and that is right for it —
  the compose healthcheck polls it, and that health gates every deploy's `up --wait` and the web
  container's start, so a deep check there fails a release over a long queue or a worker that has
  not beaten yet (and anything that restarts unhealthy containers would restart a fine API over a
  database blip). Keep it shallow. `/api/ready`
  (`readiness.ts`, route in `readinessRoutes.ts`) checks Postgres (`SELECT 1`), Redis (`PING`, and
  never queued behind a disconnected client), the bucket (`HeadBucket`), outgoing mail (the cached
  SMTP verification, next bullet — it opens no connection), each worker lane's
  heartbeat key (`apps/worker/CLAUDE.md`) and the oldest `QUEUED` row per lane against 15 minutes
  (interactive) and 3 hours (long). Each check has a 3 s timeout, they run together, and one report
  is cached for 10 s and shared single-flight, so the public URL costs one round of checks per window
  however hard it is polled. **The public body is `ok`/`fail` per check and nothing else**; the
  reasons go to the log (`readiness.failing`, only when the failing set changes) and the alert
  email. It is public by `shouldProtectPath` in `auth.ts`, beside `/api/health`, and because the hook
  reads `routedRequestPath`, every encoded spelling is the same route; `readinessRoutes.test.ts`
  pins plain, encoded and HEAD, and that `/api/ready/../admin/users` still asks for the cookie. Its
  own plugin rather than `routes/projects.ts`, whose suite asserts every `/api/` route there is the
  operator's. A check that fails only because another did — a heartbeat unreadable while Redis is
  down, a queue unmeasurable while the database is — is `unmeasured`: `fail` in public, but the
  sweep leaves it alone and alerts on the cause. Waiting age is read off the durable rows'
  `updatedAt`, not BullMQ's lists: a prioritized long-lane start sits in a sorted set ordered by
  priority rather than age, a retried Bull job keeps its first timestamp, and an undispatched row is
  waiting just the same. Its lane is core's `jobLaneClass`, so it cannot drift from placement.
- **An alert is a state, not an event: it fires once, recovers once, and survives a restart in its
  row — but the sweep never needs that row to send.** `operatorAlerts.ts` runs every minute from
  `server.ts` and emails `OPERATOR_ALERT_EMAIL` through the password-reset mailer; unset, it only
  logs `operator_alert.firing` / `.recovered`, and the production preflight warns rather than
  refuses (a deploy must not fail over who is told about outages). `alertState.ts` is the pure step:
  a condition fires after `confirmSweeps` failing sweeps in a row and clears after `clearSweeps`
  passing ones, so a deploy's restart or a check at its edge is not mail; a re-fire inside the
  repeat window (an hour; a UTC day for the spend caps) is *firing but not notified* — no email, told
  when the window passes if still firing, dropped silently if it clears first — so every recovery
  answers exactly one alert. Conditions that move in one sweep share one email. State is the
  `OperatorAlert` table (migration 000102), so a restart neither repeats an alert nor forgets the
  recovery it owes, and its `sweep` row is a compare-and-set claim that makes one API process the
  sender per interval. **But the database is one of the things watched**, so a sweep that cannot
  claim, read or write it carries on from memory — the "database is down" email still goes out —
  and `newerAlertState` writes the newer copy back when the table returns. A send that fails, or
  hangs past 30 s (nodemailer's own bounds are `SMTP_TIMEOUTS` in `src/mailer.ts`), is logged as
  `operator_alert.email_failed` and not retried: the state records the alert as told rather than
  hammering a broken SMTP every minute. The spend conditions read the breaker's `globalView` and
  compare spend to the caps themselves, so a pause the operator chose is not an alert. Failed jobs
  exclude a reader's Stop by the same marker pair `isStoppedGenerationJob` reads, spelled with
  explicit `null` branches because SQL `<>` drops null columns. The disk is `statfs("/")` in the
  container, which overlayfs answers for the host disk under Docker. A new condition is an
  `ALERT_CONDITIONS` entry (label, policy, one-line hint), an observation in
  `observeAlertConditions`, and a row in the docs table.
- **An open child-safety report is an alert on the first sweep that sees it, and settling the report
  is what clears it.** Nothing told the owner when a reader filed a child-safety or sexual-content
  report, or when the sexual-content screen held a live share it could not decide (launch review,
  2026-10-13). `safety_reports` (`safetyReportsSource`) counts PENDING `ModerationReport`s whose
  reason is `CHILD_SAFETY` or `SEXUAL_CONTENT` — from any surface: a share's page, a book, a
  picture, a voice call, a chat reply, any AI output — plus system `book_text_review` reports, and
  fires with `confirmSweeps: 1` rather than a readiness check's three, because a report is a fact,
  not a flicker. The email says how many of each are open and when the oldest arrived. It is a
  state like every other condition: more reports while it fires send nothing more (the Moderation
  screen's banner counts them), and it clears on the first sweep with none PENDING — Action,
  Dismiss or Mark reviewed on each, or *Approve book text* / *Approve caption* / a take-down for a
  held book text (`routes/adminShares.ts`).
- **Mail is verified, not assumed, and a broken mailer is a readiness failure because it cannot be
  an email.** The production preflight reads only `SMTP_URL`'s scheme, so a wrong password booted
  fine and then failed every reset code and every alert with one log line each (launch review,
  2026-10-13). `createMailHealth` (`monitoring/mailHealth.ts`) runs the transport's `verify()` —
  connect, greet, log in, send nothing — right after `listen` and every ten minutes (the
  `mail_verify` sweep), bounded at 40 s, logs a failure at error level (`email.verify_failed`), and
  caches the answer; `/api/ready`'s `mail` check reads that cache, so the public URL never opens an
  SMTP connection and keeps its 3 s budget. Unchecked counts as working, so a boot is not an outage;
  no transport at all fails it. The `mail` alert condition's own email cannot be delivered while it
  fires — the uptime monitor on `/api/ready` is what tells the owner — but its recovery email can,
  and it bounds the window of lost alerts and reset codes. Never make a failed verification refuse
  the boot: a mail provider's outage must not fail a deploy. `POST /api/admin/monitoring/test-alert`
  (`monitoring/monitoringRoutes.ts`, cookie-only by its path and `requireOperatorActor`) sends one
  test email to `OPERATOR_ALERT_EMAIL` and records the outcome in the same cache; the console's
  Operations header has a **Send test alert** button that shows the answer (`TestAlertButton.tsx`;
  `docs/deployment.md`, "Send a test alert after every deploy"). Every password-reset and
  email-verification code (sign-up's first one included) goes through `mailerFeedingHealth`, which
  records each send's outcome in that cache the same way, so a mailer that breaks between two
  verifications fails readiness at the first code it cannot send — except a refusal of the
  *recipient* (`isRecipientRejection`: nodemailer's `EENVELOPE` on `RCPT TO`, or an address it
  could not parse), because that address came from a reader and recording it would let anyone
  signing up with a bad address fail `/api/ready`. `Mailer.verify`
  is optional so test doubles may omit it; both real mailers implement it.

## Housekeeping

- **No housekeeping runs before the API listens.** `server.ts` awaited the first pass of the
  attachment, voice-call, account-deletion, message-recovery, Play-renewal and queue sweeps before
  `listen`; several reach S3 or Google, and the S3 client had no timeouts, so one slow dependency
  during a deploy held the new API past the 240 s health wait after the old release was already
  stopped (launch review, 2026-10-13). Every periodic job is now an entry in one
  `createBackgroundSweeps` list (`src/backgroundSweeps.ts`), and `start()` is called after
  `app.listen`: it returns at once, runs each first pass on a later tick, skips a tick whose last
  pass is still running, and logs a thrown pass as `<name>_failed`. Only the credit-pricing load
  stays ahead of `listen`, because nothing may be charged unpriced. A new periodic job is an entry
  in that list, never an `await` before `listen` or a bare `setInterval`. The S3 client's own bounds
  are `S3_HTTP_TIMEOUTS` (`docs/storage.md`). `src/backgroundSweeps.test.ts` listens with a hanging
  sweep.
- **Rows read for a bounded while are pruned once a day; a provider call a book still names is
  kept for the life of the book.** `runTablePruneSweep` (`src/tablePruneSweep.ts`, the
  `table_prune` sweep) deletes `ProviderCallLog` rows with no project older than 400 days,
  `ProductEvent` rows older than 400 days, and `MobileSession` rows revoked or past their refresh
  expiry more than 30 days ago (a token from one then answers `INVALID_SESSION`, which the app's
  refresh treats as the end of the session just like `SESSION_REVOKED`; its push devices cascade).
  Every windowed reader fits inside that: the spend breaker reads this UTC month, the audiobook budget 24 h,
  the dashboards at most 365 days (`resolveWindow` and the routes' zod schemas; the suite pins that
  365 < 400, so widening a dashboard to "all time" fails it). But the operator's per-book views —
  `projectCosts.ts`, `admin/generatedBooks.ts`, `admin/inspection.ts` — sum a book's whole bill, so
  a call row that names a project is never pruned; deleting the book nulls the column and the rows
  age out from there. Each batch selects at most 1,000 ids and deletes exactly those, and a pass
  stops after 100 batches per table, so a backlog drains over days without a long lock. That
  projectless-row query, the per-book reads and the `SetNull` a book's delete runs all ride the
  `(projectId, createdAt)` index of migration 000112, built `CONCURRENTLY` alone in its file as
  000099 and 000100 are (a btree indexes nulls, so `projectId IS NULL` is an equality on it).

## Where the rest of the invariants live

- `src/mobile/CLAUDE.md` — billing surfaces, the edit chat router, free presentation edits, export
  repair, the quality verdict, characters, voice and audiobook routes.
- `src/admin/CLAUDE.md` — how provider spend may and may not be summed.
- `src/routes/CLAUDE.md` — operator-only authorization, and the inline export render.
- `packages/db/CLAUDE.md` — the reserve/commit/refund loop. Any new priced route closes it on
  **every** failure path.
- `packages/core/CLAUDE.md` — credit prices are operator-editable and re-read every 15s by
  `server.ts`; never capture one at module load.
- `packages/core/src/generation/CLAUDE.md` — the browser pool. `server.ts` renders exports inline
  when a compiled file is missing, so its `shutdown()` must await `closeSharedBrowser()` and it
  must trap **SIGHUP** alongside INT/TERM.
- `apps/worker/CLAUDE.md` — `src/queue.ts` `enqueueGenerationJob` must write the `GenerationJob`
  row *before* pushing to BullMQ; a crash between the two is what
  `reconcileUndispatchedWorkerJobs` repairs.

Two things in this app are parallel implementations of worker logic and must move together with it:
`src/queue.ts` `stopProjectGenerationJobs` (settlement on stop and delete) and the export render in
`src/routes/projectExports.ts` (publication). Neither is a wrapper — they are second copies.

## Tests

`src/mobile/*.test.ts` share `src/mobile/testing/mobileApiHarness.ts`. Add fixtures and record
factories there rather than duplicating them per suite. `src/mobile/testing/mobileApiMocks.ts` must
import only `vitest` — see `src/mobile/CLAUDE.md` for why the suite hangs otherwise.

<!-- gotcha-index: pointer-only -->
