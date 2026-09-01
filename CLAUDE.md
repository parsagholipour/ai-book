# AI Book Maker

Generates full books from a short brief: plan → chapters → pages → illustrations → PDF/EPUB.
A Flutter app and a React console both talk to one Fastify API; a BullMQ worker does the generation.

## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a multi-context layout. See `docs/agents/domain.md`.

## Commands

```bash
pnpm check          # typecheck + lint + file-size budget + script and workspace tests. Run before saying you're done.
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

- ESM everywhere. Relative imports carry the `.js` extension (`./foo.js`), even from `.ts` — but
  `packages/db` uses `.ts`, to match its generated Prisma client. → packages/db/CLAUDE.md
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
- **A diagnostic write may not decide the render it describes.** → packages/core/src/adapters/CLAUDE.md
- **The portrait job is the one `GenerationJob` with no project.** → apps/worker/src/handlers/CLAUDE.md
- **Every fork out of `applyBookEdit` — structural and both image ones — is decided by the operation's `kind`, never by the payload.** → apps/worker/src/handlers/CLAUDE.md
- **A structural edit's redelivery stamp comes down in the same transaction that puts the book back.** → apps/worker/src/handlers/CLAUDE.md
- **A structural shift and every write after it belong to one durable, expiring delivery lease.** → apps/worker/src/generation/CLAUDE.md + apps/worker/src/handlers/CLAUDE.md
- **Two durable leases share a shape, and neither is the other's configuration — the waiters are the proof.** → apps/worker/src/generation/CLAUDE.md
- **Every read the shift is derived from is taken under the claim, and reconciled against what the claim actually finds.** → apps/worker/src/generation/CLAUDE.md
- **An edit the reader has already undone is terminal for every delivery of it.** → apps/worker/src/handlers/CLAUDE.md
- **A settlement merges onto the classifier it re-reads under its own row lock, never the copy the delivery carried in.** → apps/worker/src/handlers/CLAUDE.md
- **A delivered edit outlives a recompile it could not queue.** → apps/worker/src/handlers/CLAUDE.md
- **The status every apply fork restores rides the payload, because the enqueue is what takes it away.** → apps/worker/src/handlers/CLAUDE.md
- **A stopped continuation always restores while its durable job is QUEUED, and once ACTIVE only under the atomic-candidates publication protocol.** → apps/api/src/mobile/CLAUDE.md
- **A FAILED row the book has already retried is not the book's current trouble.** → apps/api/src/mobile/CLAUDE.md
- **An edit that settles itself as a delivered no-op has to refund itself too.** → apps/worker/src/handlers/CLAUDE.md
- **A delivered no-op is APPLIED too, and the redelivery tail is not idempotent for it.** → apps/worker/src/handlers/CLAUDE.md
- **An exact text edit that skips every target has no publication tail.** → apps/worker/src/handlers/CLAUDE.md
- **A recorded structural insert is indivisible: a delivery that cannot write every page it recorded rolls back and is refunded whole, never by the page.** → apps/worker/src/handlers/CLAUDE.md + packages/db/CLAUDE.md
- **Only the post-APPLIED window is that handler's to flip.** → apps/worker/src/handlers/CLAUDE.md
- **EDITING is a shared state; an edit publication owns it by operation and revision, never by status alone.** → apps/worker/src/handlers/CLAUDE.md
- **Project is the root of the edit lock order.** → apps/worker/src/handlers/CLAUDE.md
- **Every apply fork stays EDITING until its recompile publishes, and the page map is why.** → apps/worker/src/handlers/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A page's long-range memory stops at the page being drafted, because a retry redrafts into a finished book.** → apps/worker/src/generation/CLAUDE.md
- **A repair the provider refuses is written down, or it is paid for again on every page.** → apps/worker/src/generation/CLAUDE.md
- **A brief repair's durable chapter write waits for the page to keep a draft it briefed.** → apps/worker/src/generation/CLAUDE.md
- **A fence that cannot be read has a third answer, and it settles nothing.** → apps/worker/src/handlers/CLAUDE.md
- **The hole set is a query, and the `LIMIT` is what the backoff protects.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **A cancellation raised inside a tool escapes the tool loop; only a tool *failure* becomes a tool result.** → packages/core/src/adapters/CLAUDE.md
- **A page's independent loads fan out, and which failure comes back is decided rather than raced.** → apps/worker/src/handlers/CLAUDE.md
- **Whether the writer tools run at all is decided by what this handler loaded, not by what the book is.** → apps/worker/src/handlers/CLAUDE.md
- **An embedding write may degrade, never fail the page that produced it.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **Both arms build their scope filter from one function, because a fusion is only meaningful over one candidate set.** → packages/db/CLAUDE.md
- **A needle and the column it is scored against are folded together, or not at all.** → packages/db/CLAUDE.md

### Credits and billing

- **Credits are reserved, then committed or refunded.** → packages/db/CLAUDE.md
- **A charge has one cumulative reversal, and partial settlements name their claim.** → packages/db/CLAUDE.md
- **A paid attempt may only be parented onto the job its own `create` callback wrote.** → packages/db/CLAUDE.md
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
- **And a status poll may read which fork an apply took, because the kind is written before the job exists.** → apps/api/src/mobile/CLAUDE.md
- **A question declares how many of its answers count, and the picker follows.** → packages/core/CLAUDE.md
- **An alias is how the model spelled a plan field, never a weaker claim on it, so a candidate's aliases are canonicalised before it merges onto the fallback — and an answer the field's own schema refuses is dropped under every spelling, canonical included.** → packages/core/CLAUDE.md
- **The Sources list at the end of a book is not page text.** → apps/api/src/mobile/CLAUDE.md
- **A cited source is stored as the publisher's own address, never Google's.** → packages/core/src/adapters/CLAUDE.md
- **Chapter headings are not page text either, and the word "Chapter" is stored nowhere.** → apps/api/src/mobile/CLAUDE.md
- **A verified exact replacement is free, and the verification is what makes it safe.** → apps/api/src/mobile/CLAUDE.md
- **The model-free recogniser fires only when the verb's object *is* the page.** → apps/api/src/mobile/CLAUDE.md
- **The chat speaks the printed page numbers, and the model indexes never reach the reader.** → apps/api/src/mobile/CLAUDE.md
- **Changing *which* pages a book has is its own edit, and it used to be a whole new project.** → apps/api/src/mobile/CLAUDE.md
- **Undoing a structural edit moves the book to a different plan version, and the recompile has to follow it there.** → packages/db/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **Undo is offered only for an edit the undo would actually revert, and that is one predicate.** → apps/api/src/mobile/CLAUDE.md

### Drafting and page quality

- **Nothing states page 1's opening contract in its own words: a prompt names an audience and gets the ban, the import exemption that silences it, and the hook fused to its payload key — or gets nothing.** → packages/core/src/generation/CLAUDE.md
- **No best-of candidate samples hotter than the pass would have run at without candidates, and a band too narrow for the ladder compresses the step rather than widening the band.** → packages/core/src/generation/CLAUDE.md
- **Page prompts take local style rules; distribution rules reach manuscript review only.** → packages/core/src/generation/CLAUDE.md
- **A deterministic rule that can veto the model reviewer is measured against shipped pages before it ships, and one that fires on approved pages is removed, not tuned.** → packages/core/src/generation/CLAUDE.md
- **A local QA message names an earlier page only after the word `from`, because the final-QA repair harvests every other `page N` as a page to redraft.** → packages/core/src/generation/CLAUDE.md
- **An analytical page owns its evidence anchors; a shared one is repaired like a near-duplicate beat and never blocks.** → packages/core/src/generation/CLAUDE.md
- **A brief prompt names its JSON keys and shows the shape; prose alone has the model spelling them from the words.** → packages/core/src/generation/CLAUDE.md

### Characters, covers and illustrations

- **Declining the cover buys a designed one, it does not remove the cover.** → packages/core/src/generation/CLAUDE.md
- **A cover that cannot be drawn now finishes the book instead of failing it.** → apps/worker/src/handlers/CLAUDE.md
- **Two things decide whether a cover design reads, and neither is visible in the code.** → packages/core/src/generation/CLAUDE.md
- **A refused picture gets one rewritten prompt, and only a refusal about a name may have it.** → apps/worker/CLAUDE.md
- **The rewrite touches the prompt, so the provenance record speaks for the prompt: a retry that re-sent the reference sheets claims no removal.** → apps/worker/CLAUDE.md
- **A replacement replaces the provenance record too, and undo brings the old one back with the old bytes.** → apps/worker/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A picture that never arrived is not a picture that was refused, and only the second is permanent.** → packages/core/src/adapters/CLAUDE.md
- **An Imagen score table says what the classifier scored, never what the filter blocked on, so it is diagnostics and the sentence is the verdict.** → packages/core/src/adapters/CLAUDE.md
- **A native safety rating asserts only where it says `blocked`, and that flag is the one structured door the child-safety veto has.** → packages/core/src/adapters/CLAUDE.md
- **A refused reference sheet is a settled fact about the plan, and the book finishes without it.** → apps/worker/src/generation/CLAUDE.md
- **A drawing beats a refusal, whoever's commit got there first.** → apps/worker/src/generation/CLAUDE.md
- **The refusal has to be written down, or tolerating it costs more than failing did.** → apps/worker/src/generation/CLAUDE.md
- **The renders no longer sit inside the lock, because tolerating a refusal is what made that budget reachable.** → apps/worker/src/generation/CLAUDE.md
- **A waiter's budget is one owner's, and only a lease that changes hands renews it.** → apps/worker/src/generation/CLAUDE.md
- **The stale set is the rows the commit read, and another plan version's sheets are not among them.** → apps/worker/src/generation/CLAUDE.md
- **A library character reaches a book by copy and by name, never by foreign key.** → packages/core/src/generation/CLAUDE.md
- **A character's look lives in pixels, so it has to be written down or the planner invents one.** → packages/core/src/generation/CLAUDE.md
- **Nothing used to check that the planner obeyed, and now one pass does.** → packages/core/src/generation/CLAUDE.md
- **A per-book character list is a copy, and it says which library character it is a copy of.** → apps/api/src/mobile/CLAUDE.md
- **A reference-sheet filename must survive a non-Latin name.** → apps/worker/src/generation/CLAUDE.md
- **A pass owns every sheet file it wrote, because a per-pass name is unbounded and nothing else sweeps that directory.** → apps/worker/src/generation/CLAUDE.md
- **Which of those files the sweep may unlink is decided by a re-read of the rows, never by an exception.** → apps/worker/src/generation/CLAUDE.md
- **But no later pass runs, which is why a refusal needs a door out of the product.** → apps/worker/src/generation/CLAUDE.md
- **And the second waiter's tick is four queries, so what they each read is the price of waiting.** → apps/worker/src/generation/CLAUDE.md
- **`photoPath` is not a reference; `portraitPath` is, and the upload decides which one an image becomes.** → apps/api/src/mobile/CLAUDE.md
- **A portrait start's prompt inputs are part of its command identity, never a test it is refused on.** → apps/api/src/mobile/CLAUDE.md
- **One sheet per character reaches the model, because a superseded cast is still the same cast.** → packages/core/src/generation/CLAUDE.md + apps/worker/src/generation/CLAUDE.md
- **The face is fed in twice, and only ever into spare budget.** → apps/worker/src/generation/CLAUDE.md
- **A fallback pair reports the primary's reference budget, and the fallback attempt re-fits the request to its own — the prompt included, because the prompt counts the pictures and names the last few.** → packages/core/src/adapters/CLAUDE.md
- **A mentioned character's sheet is supplemental context, never part of the approved edit instruction.** → apps/api/src/mobile/CLAUDE.md
- **The mention scanner's rule about marks runs the other way, and both are right.** → packages/core/src/generation/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A mention row nothing can name is what makes the strip stop trusting the name list.** → packages/db/CLAUDE.md
- **The broad strip's word test reads the prose it is producing, not the prose it was handed.** → packages/db/CLAUDE.md
- **Naming every row is not the same as claiming every marker, and a tie is settled rather than left standing.** → packages/db/CLAUDE.md + packages/core/src/generation/CLAUDE.md
- **A character PATCH re-reads its own row under the claim, because the claim only asserts the name.** → apps/api/src/mobile/CLAUDE.md
- **The text a character write screens is the text it stores, and the text the request typed is refused before anything is claimed — so each route screens twice.** → apps/api/src/mobile/CLAUDE.md
- **Both mention-rewriting transactions claim every source in one statement, and the timeout that survives their ceiling is a 503, not a conflict.** → apps/api/src/mobile/CLAUDE.md
- **One candidate set decides who owns a span, and the source's own name is not in it.** → apps/api/src/mobile/CLAUDE.md
- **A mention a save gives up takes its `@` with it, because the row it was bound to is the only record of where the marker sits.** → apps/api/src/mobile/CLAUDE.md
- **A mention row's kind is required, and one that arrives without it is nobody.** → apps/api/src/mobile/CLAUDE.md + packages/db/CLAUDE.md
- **A ceiling on one transaction is not a ceiling on a request: the delete runs its lane twice, and the patch pays for two reads before it opens one.** → apps/api/src/mobile/CLAUDE.md
- **A budget too small to commit in buys no window at all.** → apps/api/src/mobile/CLAUDE.md
- **A refusal's `reason` reaches the reader only if the route's 422 schema names it.** → apps/api/src/mobile/CLAUDE.md
- **A wire code owns one sentence, and it lives with the code rather than at the call site.** → apps/api/src/mobile/CLAUDE.md
- **An unreadable body is recognised by the parser that refused it, never by a bare 400.** → apps/api/src/mobile/CLAUDE.md
- **One declaration orders every read of a character's mentions, and no read spells it a second time.** → packages/db/CLAUDE.md
- **A claim that writes a row's own value back does not lock it against being mentioned, so the mention rewrite takes the `FOR UPDATE` itself.** → apps/api/src/mobile/CLAUDE.md
- **A lock is not a write, and a claim that writes stamps a clock from before it waited.** → apps/api/src/mobile/CLAUDE.md
- **A mention target deleted mid-write is a 404, not a stack trace.** → apps/api/src/mobile/CLAUDE.md
- **Where two answers are told apart by one exact test and one piece of prose, the prose speaks last.** → apps/api/src/mobile/CLAUDE.md
- **A create tells the link writer it is new, and only the read is allowed to believe it.** → apps/api/src/mobile/CLAUDE.md
- **A route's declared statuses are what its own handler can reach in the shared ladder, never the ladder's full set of rungs.** → apps/api/src/mobile/CLAUDE.md
- **A module kept light enough to survive a mock has to be light in both directions.** → packages/core/CLAUDE.md + packages/db/CLAUDE.md
- **The dependency is on the barrel too, and the barrel is the dangerous half.** → apps/web/CLAUDE.md

### Compiling, rendering and exports

- **The book is typeset against md-to-pdf's stylesheets, but nothing else of md-to-pdf's remains.** → packages/core/src/generation/CLAUDE.md
- **Chrome reads the book off disk; nothing crosses CDP.** → packages/core/src/generation/CLAUDE.md
- **One Chromium, many pages — and the reset paths are the point.** → packages/core/src/generation/CLAUDE.md
- **A recompile makes no model call, and that is a cache with one rule.** → apps/worker/src/generation/CLAUDE.md
- **The mobile export routes never render.** → apps/api/src/mobile/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md + apps/api/src/routes/CLAUDE.md
- **A download says which compile answered it, because the URL cannot.** → packages/core/src/generation/CLAUDE.md + apps/mobile/lib/features/reader/CLAUDE.md
- **A sheet number belongs to one file, so it may only be sent with that file's digest.** → apps/mobile/lib/features/reader/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A compile publishes by claiming the revision it compiled, and it renders somewhere else until it has.** → apps/worker/src/generation/CLAUDE.md + packages/core/src/generation/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **The export barrier blocks the revision it names, not every revision, and only an expired publication lease lets recovery retire it.** → apps/worker/src/generation/CLAUDE.md + apps/api/src/routes/CLAUDE.md
- **A book only earns the word "Chapter" by being long enough to need it.** → packages/core/src/generation/CLAUDE.md
- **The page map is measured from the published PDF's own bytes, and measuring must move nothing.** → packages/core/src/generation/CLAUDE.md
- **A publication may replace the page map; it may never refuse to publish over it.** → apps/worker/src/generation/CLAUDE.md
- **A compile that stands down leaves no verdict about prose it no longer speaks for.** → apps/worker/src/handlers/CLAUDE.md
- **The coverless title sheet is capped at exactly one page, and it clips from the tail.** → packages/core/src/generation/CLAUDE.md
- **Every renumber parks before it lands, because neither unique index is deferrable.** → packages/db/CLAUDE.md
- **A page renumber carries the page map with it; only a sheet that would lose its page clears it.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **A moved page's old chapter rides the same stamp as its old index.** → apps/worker/src/generation/CLAUDE.md
- **A compare-and-swap over a JSON column is staked on the document the row stores, never on what that document parses to.** → apps/worker/src/generation/CLAUDE.md
- **A page that goes away takes its semantic memory with it, because nothing else will.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **One arm of a hybrid retrieval must not be able to settle the other, and an arm nobody engaged is not a survivor.** → packages/db/CLAUDE.md
- **A structural delete parks the page's older Undo history outside the Page cascade.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A deleted page comes back as it was, not as an approved one.** → packages/db/CLAUDE.md
- **The recorded page order is what the edit found, not what the undo will meet.** → packages/db/CLAUDE.md
- **A cross-chapter move has two coordinates to undo.** → packages/db/CLAUDE.md

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
- **The description field refuses rather than truncates, so its bound is a ceiling well above the cap and a mention scan that stops at it.** → apps/mobile/lib/features/characters/CLAUDE.md
- **The reader places the rendered page before it places the selection.** → apps/mobile/lib/features/reader/CLAUDE.md

### Admin dashboards and cost accounting

- **A non-null `ProviderCallLog.costHint` *is* a settled, priced call.** → apps/api/src/admin/CLAUDE.md
- **Nothing joins a provider call to the charge that paid for it, so the Operations tab derives it three ways.** → apps/api/src/admin/CLAUDE.md
- **A costless call has four different causes and the Costs tab splits all four.** → apps/api/src/admin/CLAUDE.md
- **"Revenue" is two different numbers and the dashboard shows both.** → apps/api/src/admin/CLAUDE.md
- **A reversal is an amount, not a boolean.** → apps/api/src/admin/CLAUDE.md
- **Integrity is not a quality-gate checkbox, and its provider calls stay attributable when every polish box is off.** → packages/core/src/generation/CLAUDE.md

### Local stack

- Docker bind-mounts the repo, so `node_modules` uses anonymous volumes. → kept in full under ## Commands above
- **`make up` and `pnpm dev` are the same queue.** → kept in full under ## Commands above
- **An opt-in suite is made inert by not being *loaded*, not by skipping itself.** → packages/db/CLAUDE.md
