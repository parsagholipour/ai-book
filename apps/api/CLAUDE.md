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
