# API

Fastify. Validates requests, reads/writes Postgres, enqueues jobs. It must not call AI providers
for anything long-running — that belongs in the worker.

The short-lived exceptions are deliberate and time-boxed: creation-chat turns and the book advisor
call a fast model inline with an explicit timeout (see `mobile/creationBuild.ts` and
`mobileCreation.ts`), and the share-note moderation gate makes one Jev decision with a 25 s budget
of its own (`userTextModeration.ts`). Anything that can take more than a few seconds gets a job.

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

## The two auth systems are unrelated

- **Mobile users** — database-backed accounts under `/api/mobile/auth/*`. Bearer access tokens,
  refresh tokens, only hashes stored in `MobileSession`. Real multi-user auth.
- **Operator console** — a single optional `WEB_PASSWORD` cookie guarding `/api/*`, `/docs` and
  generated assets. Not per-user.

Everything protected is cookie-only except `/api/mobile/*` and the two asset prefixes.
`allowsMobileBearer` in `src/requestAuth.ts` names that surface; `isOperatorOnlyPath` in
`src/auth.ts` is literally its complement.

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
  password and the legal acceptances. The `User` row is kept — email replaced by
  `deleted-<id>@deleted.invalid`, name cleared, `DISABLED` — because `Project` and
  `MobileCreationDraft` restrict its deletion and because the credit ledger, purchases and
  subscriptions it owns are the billing records the policy pages say are retained. A tombstone
  cannot sign in and frees the email for a new account.

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
