# API

Fastify. Validates requests, reads/writes Postgres, enqueues jobs. It must not call AI providers
for anything long-running — that belongs in the worker.

The short-lived exceptions are deliberate and time-boxed: creation-chat turns and the book advisor
call a fast model inline with an explicit timeout (see `mobile/creationBuild.ts` and
`mobileCreation.ts`). Anything that can take more than a few seconds gets a job.

## Route surfaces

- `src/mobile/routes/` — `/api/mobile/*`, used by the Flutter app. This is the product surface, and
  it has its own `CLAUDE.md` carrying the "adding a route" checklist and the domain invariants.
- `src/routes/` — the older operator API behind `WEB_PASSWORD`, used by `apps/web`. Also has its
  own `CLAUDE.md`; the short version is that a mobile bearer token is rejected there before any
  handler runs, and that is a security property rather than tidiness.
- `src/admin/` — `/api/admin`, read by the operator dashboard only.

`src/mobileProjects.ts` is the composition root: it builds one `MobileRouteContext` and calls each
`registerMobile*Routes(fastify, context)` in turn. They run on the same Fastify instance rather
than through `fastify.register`, so they share one encapsulation context — the
`application/octet-stream` parser registered there covers the attachment upload routes. Moving to
`register` would break that. Everything `mobileProjects.ts` re-exports is public API consumed by
`server.ts`, `mobileImports.ts` or tests; don't narrow those exports without checking callers.

## The two auth systems are unrelated

- **Mobile users** — database-backed accounts under `/api/mobile/auth/*`. Bearer access tokens,
  refresh tokens, only hashes stored in `MobileSession`. Real multi-user auth.
- **Operator console** — a single optional `WEB_PASSWORD` cookie guarding `/api/*`, `/docs` and
  generated assets. Not per-user.

Everything protected is cookie-only except `/api/mobile/*` and the two asset prefixes.
`allowsMobileBearer` in `src/requestAuth.ts` names that surface; `isOperatorOnlyPath` in
`src/auth.ts` is literally its complement.

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
