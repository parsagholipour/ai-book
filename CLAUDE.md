# AI Book Maker

Generates full books from a short brief: plan → chapters → pages → illustrations → PDF/EPUB.
A Flutter app and a React console both talk to one Fastify API; a BullMQ worker does the generation.

## Commands

```bash
pnpm check          # typecheck + lint + file-size budget + all tests. Run this before saying you're done.
                    # Every gate runs even when an earlier one fails, so one run reports the whole state.
pnpm check:mobile   # flutter analyze + flutter test. NOT part of `pnpm check` — run it if you touched apps/mobile.
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

### While iterating

Whole-repo `pnpm check` is ~50s. Don't reach for it on every edit — these are seconds:

```bash
pnpm -F @book-maker/api exec vitest run src/mobile/foo.test.ts   # one file; path is relative to the WORKSPACE
pnpm -F @book-maker/api exec vitest run -t "manual" src/...      # one test by name
pnpm -F @book-maker/core typecheck                               # 3s, vs 19s for all five workspaces
```

A mistyped path exits 1 with `No test files found, exiting with code 1` in under half a second.
That is not a failing test — check the path before believing it.

### Running the stack locally

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

Job types live in `JobType` in the Prisma schema, and `jobNames` in `packages/core/src/jobDispatch.ts`
is the canonical map every other list derives from. A new one must reach the `switch` in
`src/processJob.ts` and `JOB_STEP_TEMPLATES` in `packages/core/src/jobSteps.ts` — the latter is an
exhaustive `Record`, so it is the one the compiler reminds you about. Use the `add-job-type` skill
for the rest.

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

Every invariant this project learned the hard way, one line each. The line is the rule; the file
after the arrow holds the reasoning, the incident behind it, and the code that enforces it. Those
files load automatically when you edit anything in their directory — open the entry before changing
code in that area, however obvious the rule looks.

### Jobs, queue and failure settlement

- **Generation state lives in the database, not in Redis.** → apps/worker/CLAUDE.md
- **Run logs are the debugging artifact.** → apps/worker/CLAUDE.md
- **The portrait job is the one `GenerationJob` with no project.** → apps/worker/src/handlers/CLAUDE.md
- **Every fork out of `applyBookEdit` — structural and both image ones — is decided by the operation's `kind`, never by the payload.** → apps/worker/src/handlers/CLAUDE.md
- **A structural edit's redelivery stamp comes down in the same transaction that puts the book back.** → apps/worker/src/handlers/CLAUDE.md
- **A structural shift and every write after it belong to one durable, expiring delivery lease.** → apps/worker/src/generation/CLAUDE.md + apps/worker/src/handlers/CLAUDE.md
- **Every read the shift is derived from is taken under the claim, and reconciled against what the claim actually finds.** → apps/worker/src/generation/CLAUDE.md
- **An edit the reader has already undone is terminal for every delivery of it.** → apps/worker/src/handlers/CLAUDE.md
- **A settlement merges onto the classifier it re-reads under its own row lock, never the copy the delivery carried in.** → apps/worker/src/handlers/CLAUDE.md
- **A delivered edit outlives a recompile it could not queue.** → apps/worker/src/handlers/CLAUDE.md
- **An edit that settles itself as a delivered no-op has to refund itself too.** → apps/worker/src/handlers/CLAUDE.md
- **Every apply fork stays EDITING until its recompile publishes, and the page map is why.** → apps/worker/src/handlers/CLAUDE.md + apps/api/src/mobile/CLAUDE.md

### Credits and billing

- **Credits are reserved, then committed or refunded.** → packages/db/CLAUDE.md
- **A balance is two pools, and spending draws the expiring one first.** → packages/db/CLAUDE.md
- **The free month is granted lazily, not by a cron.** → packages/db/CLAUDE.md
- **Cancelling belongs to Google Play; the app's job is to say what it costs and then re-ask.** → apps/api/src/mobile/CLAUDE.md
- **A plan period cut short is *adopted*, not re-granted.** → packages/db/CLAUDE.md
- **The free tier's illustrated-book limit has two claiming doors — plan approval and the chat `add_image` Apply.** → apps/api/src/mobile/CLAUDE.md
- **Chat replies never name a credit price.** → apps/api/src/mobile/CLAUDE.md
- **A price key with no tier suffix is the *balanced* rate.** → packages/core/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md
- **Credit prices are operator-editable, not constants.** → packages/core/CLAUDE.md

### Chat, edits and back matter

- **The edit chat gets one clarifying question per request, and it is enforced three times.** → apps/api/src/mobile/CLAUDE.md
- **Moving and removing a picture are free, and neither is a page edit.** → apps/api/src/mobile/CLAUDE.md + apps/worker/src/generation/CLAUDE.md + apps/worker/src/handlers/CLAUDE.md
- **A question declares how many of its answers count, and the picker follows.** → packages/core/CLAUDE.md
- **The Sources list at the end of a book is not page text.** → apps/api/src/mobile/CLAUDE.md
- **A cited source is stored as the publisher's own address, never Google's.** → packages/core/src/adapters/CLAUDE.md
- **Chapter headings are not page text either, and the word "Chapter" is stored nowhere.** → apps/api/src/mobile/CLAUDE.md
- **A verified exact replacement is free, and the verification is what makes it safe.** → apps/api/src/mobile/CLAUDE.md
- **The model-free recogniser fires only when the verb's object *is* the page.** → apps/api/src/mobile/CLAUDE.md
- **The chat speaks the printed page numbers, and the model indexes never reach the reader.** → apps/api/src/mobile/CLAUDE.md
- **Undoing a structural edit moves the book to a different plan version, and the recompile has to follow it there.** → packages/db/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **Undo is offered only for an edit the undo would actually revert, and that is one predicate.** → apps/api/src/mobile/CLAUDE.md

### Characters, covers and illustrations

- **Declining the cover buys a designed one, it does not remove the cover.** → packages/core/src/generation/CLAUDE.md
- **A cover that cannot be drawn now finishes the book instead of failing it.** → apps/worker/src/handlers/CLAUDE.md
- **Two things decide whether a cover design reads, and neither is visible in the code.** → packages/core/src/generation/CLAUDE.md
- **A library character reaches a book by copy and by name, never by foreign key.** → packages/core/src/generation/CLAUDE.md
- **A character's look lives in pixels, so it has to be written down or the planner invents one.** → packages/core/src/generation/CLAUDE.md
- **Nothing used to check that the planner obeyed, and now one pass does.** → packages/core/src/generation/CLAUDE.md
- **A per-book character list is a copy, and it says which library character it is a copy of.** → apps/api/src/mobile/CLAUDE.md
- **A reference-sheet filename must survive a non-Latin name.** → apps/worker/src/generation/CLAUDE.md
- **`photoPath` is not a reference; `portraitPath` is, and the upload decides which one an image becomes.** → apps/api/src/mobile/CLAUDE.md
- **The face is fed in twice, and only ever into spare budget.** → apps/worker/src/generation/CLAUDE.md
- **A mentioned character's sheet rides the stored edit request, never the routed text.** → apps/api/src/mobile/CLAUDE.md

### Compiling, rendering and exports

- **The book is typeset against md-to-pdf's stylesheets, but nothing else of md-to-pdf's remains.** → packages/core/src/generation/CLAUDE.md
- **Chrome reads the book off disk; nothing crosses CDP.** → packages/core/src/generation/CLAUDE.md
- **One Chromium, many pages — and the reset paths are the point.** → packages/core/src/generation/CLAUDE.md
- **A recompile makes no model call, and that is a cache with one rule.** → apps/worker/src/generation/CLAUDE.md
- **The mobile export routes never render.** → apps/api/src/mobile/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md + apps/api/src/routes/CLAUDE.md
- **A download says which compile answered it, because the URL cannot.** → packages/core/src/generation/CLAUDE.md + apps/mobile/lib/features/reader/CLAUDE.md
- **A physical PDF sheet may only be read against the file it is a sheet of, and only a digest says which that is.** → apps/mobile/lib/features/reader/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A compile publishes by claiming the revision it compiled, and it renders somewhere else until it has.** → apps/worker/src/generation/CLAUDE.md + packages/core/src/generation/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A book only earns the word "Chapter" by being long enough to need it.** → packages/core/src/generation/CLAUDE.md
- **The page map is measured from the published PDF's own bytes, and measuring must move nothing.** → packages/core/src/generation/CLAUDE.md
- **The coverless title sheet is capped at exactly one page, and it clips from the tail.** → packages/core/src/generation/CLAUDE.md
- **A page renumber carries the page map with it; only a sheet that would lose its page clears it.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **A page that goes away takes its semantic memory with it, because nothing else will.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **A structural delete parks the page's older Undo history outside the Page cascade.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A deleted page comes back as it was, not as an approved one.** → packages/db/CLAUDE.md

### Audiobook and voice

- **A voice call's audio never reaches the server.** → apps/api/src/mobile/CLAUDE.md
- **An audiobook is made *from* a finished book, so failing one must not touch the book.** → apps/worker/src/handlers/CLAUDE.md
- **Narration is chaptered deterministically, never by the model.** → apps/worker/src/handlers/CLAUDE.md
- **Sentence timings are measured, not guessed.** → apps/worker/src/handlers/CLAUDE.md
- **Narration fails in three provider-shaped ways, and all three guards are load-bearing.** → packages/core/src/adapters/CLAUDE.md + apps/worker/src/handlers/CLAUDE.md
- **Restarting a failed narration resumes it; that is a property of the route, not the worker.** → apps/api/src/mobile/CLAUDE.md
- **The app plays local files, not a URL, and draws one timeline over many of them.** → apps/mobile/lib/features/audiobook/CLAUDE.md
- **The listening position is device-local, book-global, and stamped with the narration it belongs to.** → apps/mobile/lib/features/audiobook/CLAUDE.md
- **just_audio's `playing` means the play button is engaged, not that sound is coming out.** → apps/mobile/lib/features/audiobook/CLAUDE.md

### Reader and app surfaces

- **The Flutter creation chat screen is one library split with `part` files** → apps/mobile/lib/features/projects/CLAUDE.md
- **The in-app reader renders the compiled `book.pdf` with pdfrx (PDFium).** → apps/mobile/lib/features/reader/CLAUDE.md
- **The reader places the rendered page before it places the selection.** → apps/mobile/lib/features/reader/CLAUDE.md

### Admin dashboards and cost accounting

- **A non-null `ProviderCallLog.costHint` *is* a settled, priced call.** → apps/api/src/admin/CLAUDE.md
- **Nothing joins a provider call to the charge that paid for it, so the Operations tab derives it three ways.** → apps/api/src/admin/CLAUDE.md
- **A costless call has four different causes and the Costs tab splits all four.** → apps/api/src/admin/CLAUDE.md
- **"Revenue" is two different numbers and the dashboard shows both.** → apps/api/src/admin/CLAUDE.md

### Local stack

- Docker bind-mounts the repo, so `node_modules` uses anonymous volumes. → kept in full under ## Commands above
- **`make up` and `pnpm dev` are the same queue.** → kept in full under ## Commands above
