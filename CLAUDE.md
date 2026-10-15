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
- **`make up` and `pnpm dev` are the same queue.** Both use the published Redis service and
  the same MinIO bucket. Running both can race one book's jobs, and a `MOCK_AI=true` host worker
  can answer a real generation with canned text. Check for duplicate workers before debugging.
- **Storage:** before changing asset, export, upload, cleanup, or run-log I/O, read
  [docs/storage.md](docs/storage.md). Durable bytes use `@book-maker/storage`; local paths are scoped scratch.

## Layout

```
apps/api        Fastify HTTP API — routes only, no generation logic
apps/worker     BullMQ worker — all book generation happens here
apps/web        React/Vite operator console
apps/mobile     Flutter app (the product)
packages/core   Provider adapters, prompts, generation algorithms, schemas. No HTTP, no queue.
packages/storage Private S3 object I/O, immutable run logs, and scoped local scratch.
packages/db     Prisma client, schema, billing/credit ledger
```

Domain dependency direction is `apps/* → packages/db → packages/core`. Core must not import
from apps or db. API, worker, and core may use the independent `packages/storage` infrastructure package.

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
             replanBook, characters, writingAssist (the Writing Studio's AI tools)
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
src/monitoring/      /api/ready (readiness) and the operator alert sweep that emails the owner
src/mobile/          everything under /api/mobile — this is the surface the Flutter app uses
src/mobile/manuscript/  the Writing Studio: an author's working copy, versions, AI assists, publish
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
image slot, and `GET /api/projects/:id/export/*` renders inline and sends any format, the Word
file included, without the plan its `/api/mobile/*` twin asks for. **Ownership is not authorization here**; the actor's
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
- **Operator console** — a single `WEB_PASSWORD` cookie guarding `/api/*`, `/docs` and
  generated assets. Not per-user. Optional locally; production refuses to start without a strong one.

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
- **A job row that is gone was deleted with its book, and counts as stopped.** → apps/worker/CLAUDE.md
- **Every job type names its lane, and an enqueue routes by that map on both sides of the queue.** → apps/worker/CLAUDE.md
- **A row BullMQ reclaims while it still runs here waits for the original; it never runs beside it.** → apps/worker/CLAUDE.md
- **A job is reclaimed up to five times, and the sixth stall is settled the moment BullMQ makes it.** → apps/worker/CLAUDE.md
- **A source read's provider calls are logged, costed to its owner, unretried by the SDK, and stopped by its lease.** → apps/worker/CLAUDE.md
- **A finished Bull job is not a record, so retention may remove it and nothing may read one back.** → apps/worker/CLAUDE.md
- **One account holds at most its share of the long lane, asked at every door that starts long work, after the breaker and before anything is claimed.** → apps/api/src/mobile/CLAUDE.md
- **A waiting book is told how many books are ahead of it, counted in the order the long lane really runs.** → apps/api/src/mobile/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md
- **A diagnostic write may not decide the render it describes.** → packages/core/src/adapters/CLAUDE.md
- **The portrait job is the one `GenerationJob` with no project.** → apps/worker/src/handlers/CLAUDE.md
- **A free edit's recompile owns its verdict, never the paid book's failure.** → apps/worker/src/handlers/CLAUDE.md
- **A paid chat edit's recompile is the same kind of compile, because its charge settled before it was queued.** → apps/worker/src/handlers/CLAUDE.md
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
- **A Jev attempt carries its own deadline, and the deadline firing is a 504, never a cancellation.** → packages/core/src/adapters/CLAUDE.md
- **A grounded search carries its own deadline, and the deadline firing is a 504, never a cancellation.** → packages/core/src/adapters/CLAUDE.md
- **A page's independent loads fan out, and which failure comes back is decided rather than raced.** → apps/worker/src/handlers/CLAUDE.md
- **Whether the writer tools run at all is decided by what this handler loaded, not by what the book is.** → apps/worker/src/handlers/CLAUDE.md
- **An embedding write may degrade, never fail the page that produced it.** → apps/worker/src/generation/CLAUDE.md + packages/db/CLAUDE.md
- **Both arms build their scope filter from one function, because a fusion is only meaningful over one candidate set.** → packages/db/CLAUDE.md
- **A needle and the column it is scored against are folded together, or not at all.** → packages/db/CLAUDE.md

### Credits and billing

- **Credits are reserved, then committed or refunded.** → packages/db/CLAUDE.md
- **A charge has one cumulative reversal, and partial settlements name their claim.** → packages/db/CLAUDE.md
- **A reader's own stop or delete refunds only what was not delivered, and an ended month's allowance lapses instead of turning permanent.** → packages/db/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A delivered attempt's charge is final: the ledger refuses to reverse a charge whose attempt SUCCEEDED.** → packages/db/CLAUDE.md
- **A paid attempt may only be parented onto the job its own `create` callback wrote.** → packages/db/CLAUDE.md
- **A balance is two pools, and spending draws the expiring one first.** → packages/db/CLAUDE.md
- **Welcome credits are granted lazily, once, not by a cron.** → packages/db/CLAUDE.md
- **A welcome grant pays out only to a verified email, and the gate is inside `ensureWelcomeCreditsTx`, where no caller can grant past it.** → packages/db/CLAUDE.md
- **Every door that starts AI work asks the spend breaker before it reserves anything; the breaker fails open on a failed read, but a pause it has already seen holds.** → apps/api/CLAUDE.md
- **The spend breaker's global caps count what free accounts cost; a paying reader answers only to their own cap, the paid cap and a pause.** → apps/api/CLAUDE.md
- **Free accounts spend welcome or purchased credits; only paid plans receive recurring grants.** → packages/db/CLAUDE.md
- **Cancelling belongs to Google Play; the app's job is to say what it costs and then re-ask.** → apps/api/src/mobile/CLAUDE.md
- **A plan period cut short is *adopted*, not re-granted.** → packages/db/CLAUDE.md
- **A store refund's debt is paid at the next period boundary, first by the allowance it hid and then by the new one.** → packages/db/CLAUDE.md
- **The free tier's illustrated-book limit is claimed at plan approval, chat `add_image`, and illustrated rebuilds.** → apps/api/src/mobile/CLAUDE.md
- **A generated book's length is a rule asked at every door that starts generating one, not a quota: the free tier's limit first for a free account, and a ceiling every plan shares.** → apps/api/src/mobile/CLAUDE.md
- **A new book may not start on Ultra while the operator has it switched off, and a book already on Ultra keeps it.** → apps/api/src/mobile/CLAUDE.md
- **Voice calls and audiobooks are plan perks, refused to a free account before the spend breaker and before anything is held.** → apps/api/src/mobile/CLAUDE.md
- **Pages a finished book gains are priced like the book they join, never at the rewrite rate.** → packages/core/CLAUDE.md
- **A finished book downloads free — every book a reader owns, PDF and EPUB, with no charge, no entitlement row and no 402; the export wire stays only for installed builds.** → apps/api/src/mobile/CLAUDE.md
- **A book is one charge, taken when its plan is approved and the same for a free reader and a subscriber; a retry of an attempt charged before that keeps its stored price.** → apps/api/src/mobile/CLAUDE.md + packages/core/CLAUDE.md + packages/db/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md
- **A free reader's first finished book is offered a plan once, unasked.** → apps/mobile/lib/features/projects/CLAUDE.md
- **A written book's PDF and EPUB open, share and download in one tap; only the Word file keeps a lock, and it is a plan's, never credits.** → apps/mobile/lib/features/projects/CLAUDE.md
- **Chat replies never name a credit price.** → apps/api/src/mobile/CLAUDE.md
- **A credit-history line names what a charge bought, never the rate it was billed at.** → apps/api/src/mobile/CLAUDE.md
- **A price key with no tier suffix is the *balanced* rate.** → packages/core/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md
- **Credit prices are operator-editable, not constants.** → packages/core/CLAUDE.md
- **A subscription token is granted only for the plan its own line items name, and the server acknowledges what it records.** → apps/api/src/mobile/CLAUDE.md
- **A deletion request is carried out a day after it is made, and the user row stays as a tombstone that keeps the financial records.** → apps/api/CLAUDE.md
- **The Play purchase stream has one owner, and it lives as long as the session, not the paywall.** → apps/mobile/CLAUDE.md
- **A checkout's outcome is told to the growth funnel by the processor, once; its start by the controller that asked.** → apps/mobile/CLAUDE.md
- **A plan is priced at its base plan, and an intro offer is sold only by the id the server names.** → apps/mobile/CLAUDE.md
- **A plan's allowance is granted a month at a time, worth what its phase paid for: the yearly plan's 6,000 every month of its paid year, an intro offer's own credits, a switched plan's share of a short month.** → packages/db/CLAUDE.md
- **A downgrade starts at the renewal date, and until then the token Play issued for it carries the plan it replaces.** → packages/db/CLAUDE.md + apps/mobile/CLAUDE.md
- **A paid period outlives a token Google calls expired: only its paid end, a refund or its replacement ends it, whichever of Google's reports lands first.** → packages/db/CLAUDE.md
- **A downgrade is deferred to the renewal date, and Play answers it with no purchase.** → apps/mobile/CLAUDE.md
- **A payment's local price is the buyer's own currency for analytics, and it never decides a grant.** → packages/db/CLAUDE.md + apps/mobile/CLAUDE.md
- **A blank order id is no order id.** → apps/api/src/mobile/CLAUDE.md
- **The renewal sweep wakes at every month of a paid period, a check that grants nothing is pushed back, and a deleted account is never renewed into.** → apps/api/src/mobile/CLAUDE.md
- **Deleting an account stops its Play subscriptions, and keeps a welcome grant's address only while the cap still counts it.** → apps/api/CLAUDE.md

### Chat, edits and back matter

- **The edit chat gets one clarifying question per request, and it is enforced three times.** → apps/api/src/mobile/CLAUDE.md
- **A fallback brief says what the lane says; it echoes the idea only where it can tell where the echo ends.** → apps/api/CLAUDE.md
- **A creation-chat turn runs at most two grounded searches, counted in the tool, not the loop.** → apps/api/CLAUDE.md
- **Moving and removing a picture are free, and neither is a page edit.** → apps/api/src/mobile/CLAUDE.md + apps/worker/src/generation/CLAUDE.md + apps/worker/src/handlers/CLAUDE.md
- **And a status poll may read which fork an apply took, because the kind is written before the job exists.** → apps/api/src/mobile/CLAUDE.md
- **A question declares how many of its answers count, and the picker follows.** → packages/core/CLAUDE.md
- **An alias is how the model spelled a plan field, never a weaker claim on it, so a candidate's aliases are canonicalised before it merges onto the fallback — and an answer the field's own schema refuses is dropped under every spelling, canonical included.** → packages/core/CLAUDE.md
- **The Sources list at the end of a book is not page text.** → apps/api/src/mobile/CLAUDE.md
- **A cited source is stored as the publisher's own address, never Google's.** → packages/core/src/adapters/CLAUDE.md
- **A grounded search is priced at its tokens plus the grounding fee Google actually bills — nothing inside its pool's free allowance, list price past it — and on 2.5 Flash it runs with thinking off.** → packages/core/src/adapters/CLAUDE.md + packages/db/CLAUDE.md
- **Chapter headings are not page text either, and the word "Chapter" is stored nowhere.** → apps/api/src/mobile/CLAUDE.md
- **A picture book's page design is not page text either, and it is changed only where it shows.** → apps/api/src/mobile/CLAUDE.md
- **A book's title is not page text either, and only an AI cover makes changing it cost anything.** → apps/api/src/mobile/CLAUDE.md
- **A book's matter pages are its own copy of the author profile, and changing them is free.** → apps/api/src/mobile/CLAUDE.md
- **An imported manuscript's own matter is lifted into the book's matter and out of its pages, so it prints once.** → apps/api/src/mobile/CLAUDE.md
- **A chat matter change is kept when the reader named it, pointed back to it, or asked for it alone — never a second field nobody named.** → apps/api/src/mobile/CLAUDE.md
- **A verified exact replacement is free, and the verification is what makes it safe.** → apps/api/src/mobile/CLAUDE.md
- **A model-backed page edit is patches first and a page second, and only a rewrite answers to page QA.** → apps/worker/src/handlers/CLAUDE.md + packages/core/src/generation/CLAUDE.md
- **A rewrite that kept the page's prose inherits the page's approval.** → apps/worker/src/generation/CLAUDE.md
- **A request about one kind of content is an edit of the pages that carry it, and the router is told what each page carries.** → apps/api/src/mobile/CLAUDE.md
- **Every adherence prompt names its keys and shows the shape, or the guard is inert on a real model.** → packages/core/src/generation/CLAUDE.md
- **A keep-the-same clause is consistency, never a list of things to show.** → packages/core/src/generation/CLAUDE.md
- **A page-QA repair round may improve a set the adherence reviewer accepted, never cost it.** → apps/worker/src/handlers/CLAUDE.md
- **The model-free recogniser fires only when the verb's object *is* the page.** → apps/api/src/mobile/CLAUDE.md
- **A regex over chat text gives each optional word its own whitespace and starts a run at its first character, because the API reads it on its only thread.** → apps/api/src/mobile/CLAUDE.md
- **The chat speaks the printed page numbers, and the model indexes never reach the reader.** → apps/api/src/mobile/CLAUDE.md
- **A chat reply is light markdown on both sides of the wire, and neither side may forget the other.** → apps/mobile/lib/features/projects/CLAUDE.md
- **Changing *which* pages a book has is its own edit, and it used to be a whole new project.** → apps/api/src/mobile/CLAUDE.md
- **A page change is one action, read by code where the reader spoke only numbers, and words that only locate or excuse a page are not prose to price.** → apps/api/src/mobile/CLAUDE.md
- **Undoing a structural edit moves the book to a different plan version, and the recompile has to follow it there.** → packages/db/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **Undo is offered only for an edit the undo would actually revert, and that is one predicate.** → apps/api/src/mobile/CLAUDE.md
- **Redo is offered only for an undone edit the redo would actually restore, and that is one predicate.** → apps/api/src/mobile/CLAUDE.md

### Drafting and page quality

- **For every long book but a picture book the chapter is the unit of composition, and a page is where the typesetter cut.** → packages/core/src/generation/CLAUDE.md + apps/worker/src/generation/CLAUDE.md
- **A composed chapter has one landing, and variety is a property of the form plan, checked before any prose exists.** → packages/core/src/generation/CLAUDE.md
- **A chapter's length is a property of its plan — its budget, its sections and its page count — never of the number the writer is asked for.** → packages/core/src/generation/CLAUDE.md
- **A composed chapter is written against the facts every chapter before it fixed, never one after it, and chapter N waits for chapter N-1's.** → apps/worker/src/generation/CLAUDE.md
- **Nothing states page 1's opening contract in its own words: a prompt names an audience and gets the ban, the import exemption that silences it, and the hook fused to its payload key — or gets nothing.** → packages/core/src/generation/CLAUDE.md
- **No best-of candidate samples hotter than the pass would have run at without candidates, and a band too narrow for the ladder compresses the step rather than widening the band.** → packages/core/src/generation/CLAUDE.md
- **Page prompts take local style rules; distribution rules reach manuscript review only.** → packages/core/src/generation/CLAUDE.md
- **A deterministic rule that can veto the model reviewer is measured against shipped pages before it ships, and one that fires on pages the reviewer approved is removed, not tuned.** → packages/core/src/generation/CLAUDE.md
- **A local QA message names an earlier page only after the word `from`, because the final-QA repair harvests every other `page N` as a page to redraft.** → packages/core/src/generation/CLAUDE.md
- **An analytical page owns its evidence anchors; a shared one is repaired like a near-duplicate beat and never blocks.** → packages/core/src/generation/CLAUDE.md
- **A brief prompt names its JSON keys and shows the shape; prose alone has the model spelling them from the words.** → packages/core/src/generation/CLAUDE.md
- **A reply cut off by its output budget is asked for once more at a wider budget, outside the repair count.** → packages/core/src/generation/CLAUDE.md
- **A page is shown where the page before it ends, and a page drafted for an edit is repaired like a generated one.** → packages/core/src/generation/CLAUDE.md
- **A figure is a fenced block the compose call alone is shown, every later pass reads around, and the exporters draw.** → packages/core/src/generation/CLAUDE.md + apps/worker/src/generation/CLAUDE.md
- **Every per-page path reads a stored figure as its stand-in and stores no figure of its own.** → apps/worker/src/generation/CLAUDE.md
- **Every rule about shape the writer or editor is shown is performed on schedule, and the blind panel names the performance; content assignments are the only lever that moved.** → packages/core/src/generation/CLAUDE.md
- **The earlier plan contract is historical.** → packages/core/src/generation/CLAUDE.md
- **The brief's explicit asks and a guide's example people are content assignments of the form plan, made in its one call.** → packages/core/src/generation/CLAUDE.md
- **A chapter's prose arithmetic is proposed by a model and decided by code.** → packages/core/src/generation/CLAUDE.md
- **A book written from no source is a story, whatever its category and cue words said.** → packages/core/src/generation/CLAUDE.md
- **An opening scene's episode is taken back from the section and the material that also held it, or the chapter tells it twice.** → packages/core/src/generation/CLAUDE.md
- **A nonfiction scene needs a passage of the record, and a fresh plan rarely has one; telling it anyway was measured and reverted.** → packages/core/src/generation/CLAUDE.md
- **A catalogue search is waited for ten seconds and no longer, and a catalogue that keeps timing out is skipped, because a dossier's clock is its slowest host's.** → packages/core/src/generation/CLAUDE.md
- **A dossier anchor is matched on the fold's word parts, and a search result titled by its domain has no title.** → packages/core/src/generation/CLAUDE.md
- **Only a history book is owed scenes, and the planner is never offered the shelved arc.** → packages/core/src/generation/CLAUDE.md
- **Names and numbers do not prove that an edit preserves meaning.** → packages/core/src/generation/CLAUDE.md
- **A composed draft that is not prose is recomposed once and then fails the job; it is never edited, paginated and published.** → packages/core/src/generation/CLAUDE.md
- **The manuscript read returns notes, so a read that fails is a skipped read, never a failed book; and a provider's input filter refusing a chapter is a fallback, never a failed book.** → packages/core/src/generation/CLAUDE.md
- **A prompt field present in every chapter is a template whatever it says, and withholding the thesis from a prompt is not withholding it from the prose.** → packages/core/src/generation/CLAUDE.md
- **An evidence packet carries no model-ordered chronology, and an unknown is never about provenance.** → packages/core/src/generation/CLAUDE.md
- **A developed plan's thesis is its answer by construction, never a string the model is asked to copy.** → packages/core/src/generation/CLAUDE.md
- **The deterministic contract gates a developed plan; the model review's objections are recorded, and a synthesis chapter inherits its prerequisites' cases.** → packages/core/src/generation/CLAUDE.md
- **No claim or source is verified on any tier; the review is dormant behind one switch, and finalize and compile read the same switch.** → apps/worker/src/generation/CLAUDE.md
- **The composed pass's preparation overlaps: the research expansion runs beside the episodes and the form plan, the form plan beside the dossier, and a chapter's story-state calls beside each other.** → apps/worker/src/generation/CLAUDE.md
- **Whether a book is written from sources is the stance's answer about the book as described; the writing mode answers only for a stance that did not say.** → apps/worker/src/generation/CLAUDE.md
- **The length floor that blocks is the book's, at the share of it that still prints the paid pages; a chapter under its own minimum in a book over that floor is a warning, and a stub still blocks.** → apps/worker/src/generation/CLAUDE.md
- **A caveat is stated once, where it first matters, and the acceptance reviewer is told the rule the editor was.** → packages/core/src/generation/CLAUDE.md
- **A streamed OpenAI reply that runs into blank lines has ended, and is returned as it stood.** → packages/core/src/adapters/CLAUDE.md
- **The compile's brief inventory is taken while the chapters are written, and only an available one is stored.** → apps/worker/src/generation/CLAUDE.md
- **A composed chapter's unsupported case claims are repaired twice, then recorded and flagged for review; a prose-review quote that resolves to nothing is re-asked once, then dropped.** → apps/worker/src/generation/CLAUDE.md + packages/core/src/generation/CLAUDE.md
- **The chapter-edit gate is the contextual reviewer alone; the decision model that ran ahead of it was measured across four books and removed.** → packages/core/src/generation/CLAUDE.md
- **Jev is a screen that skips a paid call on a confident pass, kept only where a measured pass has skipped one; a screen whose pass never accepts, or that runs beside the call it should replace, is removed rather than tuned.** → packages/core/src/adapters/CLAUDE.md
- **A chapter's arithmetic is redone before it is judged, and a wrong number is a factual correction whose evidence is the computation.** → packages/core/src/generation/CLAUDE.md
- **A composed chapter's wrong arithmetic is repaired through the evidence loop, then recorded and flagged for review like an unsupported claim.** → apps/worker/src/generation/CLAUDE.md
- **A practical guide or a workbook is planned from what the reader walks away with, and only the reader's chosen book type takes that path.** → packages/core/src/generation/CLAUDE.md + apps/worker/src/generation/CLAUDE.md
- **A history writer is told who said a passage, never what it is called or where it lives, and states the rest as fact.** → packages/core/src/generation/CLAUDE.md

### Characters, covers and illustrations

- **Declining the cover buys a designed one, it does not remove the cover.** → packages/core/src/generation/CLAUDE.md
- **A cover's words follow the book's row, and setting them again never draws and never fails the book.** → apps/worker/src/handlers/CLAUDE.md
- **A cover that cannot be drawn now finishes the book instead of failing it.** → apps/worker/src/handlers/CLAUDE.md
- **A purchased cover's attempt is settled by its own cover job, never by the compile after it.** → apps/worker/src/handlers/CLAUDE.md
- **Two things decide whether a cover design reads, and neither is visible in the code.** → packages/core/src/generation/CLAUDE.md
- **An image URL carries its version, because a redrawn cover keeps its path and a replaced picture keeps its row.** → apps/api/src/mobile/CLAUDE.md
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
- **A children's picture book draws `min(pages, 12)` pictures: one a page up to twelve pages, and twelve spread across any longer book.** → packages/core/CLAUDE.md
- **A library character reaches a book by copy and by name, never by foreign key.** → packages/core/src/generation/CLAUDE.md
- **A character's look lives in pixels, so it has to be written down or the planner invents one.** → packages/core/src/generation/CLAUDE.md
- **Nothing used to check that the planner obeyed, and now one pass does.** → packages/core/src/generation/CLAUDE.md
- **A per-book character list is a copy, and it says which library character it is a copy of.** → apps/api/src/mobile/CLAUDE.md
- **A reference-sheet filename must survive a non-Latin name.** → apps/worker/src/generation/CLAUDE.md
- **A pass owns every sheet file it wrote, because a per-pass name is unbounded and nothing else sweeps that object prefix.** → apps/worker/src/generation/CLAUDE.md
- **Which of those objects the sweep may delete is decided by a re-read of the rows, never by an exception.** → apps/worker/src/generation/CLAUDE.md
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
- **Every book has a title page, and only the book's first sheet resets the page counter.** → packages/core/src/generation/CLAUDE.md
- **Chrome reads the book off disk; nothing crosses CDP.** → packages/core/src/generation/CLAUDE.md
- **One Chromium, many pages — and the reset paths are the point.** → packages/core/src/generation/CLAUDE.md
- **A book's render waits as long as its length needs, and the one CDP bound is the longest wait any render may have.** → packages/core/src/generation/CLAUDE.md
- **A recompile makes no model call, and that is a cache with one rule.** → apps/worker/src/generation/CLAUDE.md
- **The mobile export routes never render.** → apps/api/src/mobile/CLAUDE.md + apps/mobile/lib/features/projects/CLAUDE.md + apps/api/src/routes/CLAUDE.md
- **A download says which compile answered it, because the URL cannot.** → packages/core/src/generation/CLAUDE.md + apps/mobile/lib/features/reader/CLAUDE.md
- **A companion export never fails the compile, and a new one is one registry entry.** → packages/core/src/generation/CLAUDE.md + apps/worker/src/generation/CLAUDE.md
- **The Word route refuses a free account before it reads a byte or queues a repair, and charges a subscriber nothing.** → apps/api/src/mobile/CLAUDE.md
- **A sheet number belongs to one file, so it may only be sent with that file's digest.** → apps/mobile/lib/features/reader/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A compile publishes by claiming the revision it compiled, and it renders somewhere else until it has.** → apps/worker/src/generation/CLAUDE.md + packages/core/src/generation/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **The export barrier blocks the revision it names, not every revision, and only an expired publication lease lets recovery retire it.** → apps/worker/src/generation/CLAUDE.md + apps/api/src/routes/CLAUDE.md
- **A book only earns the word "Chapter" by being long enough to need it.** → packages/core/src/generation/CLAUDE.md
- **A book composed by chapters is exported in the chapters it was composed in; the model chapterization is for the per-page strategies.** → packages/core/src/generation/CLAUDE.md
- **The page map is measured from the published PDF's own bytes, and measuring must move nothing.** → packages/core/src/generation/CLAUDE.md
- **A publication may replace the page map; it may never refuse to publish over it.** → apps/worker/src/generation/CLAUDE.md
- **A compile that stands down leaves no verdict about prose it no longer speaks for.** → apps/worker/src/handlers/CLAUDE.md
- **Every face a family is assembled from declares one weight range, or Chrome never falls back across its packages.** → packages/core/src/generation/CLAUDE.md
- **A text-only story sheet is sized to its paragraphs and centred on its sheet, and it wears the design the reader chose — or, for a children's book, the one its own words point to.** → packages/core/src/generation/CLAUDE.md
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

- **Voice provider access is controlled by a funded server relay.** → apps/api/src/mobile/CLAUDE.md
- **A call ends at 15 minutes, and its Live context is compacted from the top of the persona, because every turn re-bills the whole window.** → packages/core/CLAUDE.md + apps/api/src/mobile/CLAUDE.md
- **A relayed call's runway is its holds plus what the balance can still hold, and it reaches zero before the relay closes the socket.** → apps/api/src/mobile/CLAUDE.md
- **A call names one callee, and a library character is the callee with no book.** → apps/api/src/mobile/CLAUDE.md + apps/mobile/lib/features/characters/CLAUDE.md
- **Narrating is a plan perk; listening is not.** → apps/mobile/lib/features/audiobook/CLAUDE.md
- **An audiobook is made *from* a finished book, so failing one must not touch the book.** → apps/worker/src/handlers/CLAUDE.md
- **Narration is chaptered deterministically, never by the model.** → apps/worker/src/handlers/CLAUDE.md
- **Sentence timings are measured, not guessed.** → apps/worker/src/handlers/CLAUDE.md
- **Narration fails in three provider-shaped ways, and all three guards are load-bearing.** → packages/core/src/adapters/CLAUDE.md + apps/worker/src/handlers/CLAUDE.md
- **Restarting a failed narration resumes it; that is a property of the route, not the worker.** → apps/api/src/mobile/CLAUDE.md
- **The app plays local files, not a URL, and draws one timeline over many of them.** → apps/mobile/lib/features/audiobook/CLAUDE.md
- **The listening position is device-local, book-global, and stamped with the narration it belongs to.** → apps/mobile/lib/features/audiobook/CLAUDE.md
- **just_audio's `playing` means the play button is engaged, not that sound is coming out.** → apps/mobile/lib/features/audiobook/CLAUDE.md

### Reader and app surfaces

- **Every surface that shows AI output has a Report action, and a route that snapshots what it showed.** → apps/api/src/mobile/CLAUDE.md
- **The Flutter creation chat screen is one library split with `part` files** → apps/mobile/lib/features/projects/CLAUDE.md
- **Two operator switches bound a new book, and both ride the billing payload.** → apps/mobile/lib/features/projects/CLAUDE.md
- **The in-app reader renders the compiled `book.pdf` with pdfrx (PDFium).** → apps/mobile/lib/features/reader/CLAUDE.md
- **The description field refuses rather than truncates, so its bound is a ceiling well above the cap and a mention scan that stops at it.** → apps/mobile/lib/features/characters/CLAUDE.md
- **The reader places the rendered page before it places the selection.** → apps/mobile/lib/features/reader/CLAUDE.md
- **A failed book says which step failed, and says its credits came back only when the ledger does.** → apps/api/src/mobile/CLAUDE.md
- **A status stream sends what changed, proves it is alive with a comment, and answers to the session it was opened with — three to an account.** → apps/api/src/mobile/CLAUDE.md
- **An app update is a policy per store release, and only a build that already sends its build number can ever be retired.** → apps/api/CLAUDE.md
- **A release build is signed with the upload key or not built at all.** → apps/mobile/CLAUDE.md
- **A book push is decided by the API's sweep from the status the app already reads, and its ending is sent only by the delete that claims the book's row.** → apps/api/CLAUDE.md + apps/mobile/CLAUDE.md
- **A resource named only from Dart is listed in `res/raw/tomeza_keep.xml`, or a release build deletes it.** → apps/mobile/CLAUDE.md
- **A dead session signs the reader out; it never leaves them on error screens.** → apps/mobile/CLAUDE.md
- **A cold start that cannot reach the server opens the session the phone holds, offline; only a refusal signs the reader out.** → apps/mobile/CLAUDE.md
- **An email sign-up opens on its code, and the credits it waits for are named by the server.** → apps/mobile/CLAUDE.md
- **A reader asked for credits while free ones wait on their email is offered the email first.** → apps/mobile/CLAUDE.md
- **A token's expiry is the server's clock, so every test of it is made on the server's clock.** → apps/mobile/CLAUDE.md

### Admin dashboards and cost accounting

- **A non-null `ProviderCallLog.costHint` *is* a settled, priced call.** → apps/api/src/admin/CLAUDE.md
- **Nothing joins a provider call to the charge that paid for it, so the Operations tab derives it four ways.** → apps/api/src/admin/CLAUDE.md
- **A costless call has four different causes and the Costs tab splits all four.** → apps/api/src/admin/CLAUDE.md
- **"Revenue" is two different numbers and the dashboard shows both.** → apps/api/src/admin/CLAUDE.md
- **A credit is valued by where it came from, net of Google's fee, and a welcome credit is worth nothing.** → apps/api/src/admin/CLAUDE.md
- **A reversal is an amount, not a boolean.** → apps/api/src/admin/CLAUDE.md
- **A grounded search's `costHint` includes only the grounding fee Google bills, decided by the prompt's ordinal in its pool's free allowance when the row is written.** → apps/api/src/admin/CLAUDE.md
- **Every provider call row names the user it was spent for, and a voice call's usage is recorded from the provider's own token counts.** → apps/api/src/admin/CLAUDE.md
- **Rows read for a bounded while are pruned once a day; a provider call a book still names is kept for the life of the book.** → apps/api/CLAUDE.md
- **An app event says what kind of thing happened and nothing a reader wrote, and a completed purchase is never one.** → apps/api/src/admin/CLAUDE.md + apps/mobile/CLAUDE.md
- **An install is attributed by its first report, which only exists once a reader signs in.** → apps/api/src/admin/CLAUDE.md
- **Intro conversion is a later full-price subscription payment by the same reader; churn is a reader who held a paid plan as a UTC month opened and none as it closed.** → apps/api/src/admin/CLAUDE.md

### Writing Studio (author-written books)

- **A publish seals every earlier edit, because undo writes text without a revision check.** → apps/api/src/mobile/CLAUDE.md
- **A publish is free, and rationed per account.** → apps/api/src/mobile/CLAUDE.md
- **A publish reuses rows by position and never shifts an index.** → apps/api/src/mobile/CLAUDE.md
- **A publish stamps no `publicationRevision`, and its compile and cover are rows in its own commit.** → apps/api/src/mobile/CLAUDE.md
- **The working copy never overwrites the book blindly: drift is a conflict, not a merge.** → apps/api/src/mobile/CLAUDE.md
- **An author's book refuses every generation route.** → apps/api/src/mobile/CLAUDE.md
- **An author's book offers no book report, and a picture offers one only if a model drew it.** → apps/api/src/mobile/CLAUDE.md
- **An uploaded picture never makes a book "illustrated".** → apps/api/src/mobile/CLAUDE.md
- **Studio text is screened where it leaves the working copy, in request-sized windows, and never on autosave.** → apps/api/src/mobile/CLAUDE.md
- **A Studio picture is reclaimed only when no row of its book names it and neither the picture nor the working copy has changed for 30 days.** → apps/api/src/mobile/CLAUDE.md
- **A takeover writes its provenance into the plan's snapshot too, because the worker compiles from the snapshot and the API from the row.** → apps/api/src/mobile/CLAUDE.md
- **A takeover rewrites each page into what the generated compile printed, hero first, and detaches every hero in the same commit that seals earlier edits.** → apps/api/src/mobile/CLAUDE.md
- **A taken-over book is cut into the chapters its reader saw, and the published Contents is the only record of them.** → apps/api/src/mobile/CLAUDE.md
- **A takeover clears the generator's page verdicts and image slots, because the author compile still reads them.** → apps/api/src/mobile/CLAUDE.md
- **An author's book compiles by its own rules, and a generated book never sees them.** → packages/core/src/generation/CLAUDE.md
- **A revision-owned cover re-typesets the design the book already wears.** → apps/worker/src/handlers/CLAUDE.md
- **A hidden mark is still a character, so the cursor, the keyboard and the buttons all have to be taught that it is not there.** → apps/mobile/lib/features/studio/CLAUDE.md
- **A blank line is short, and the field's caret arithmetic assumes it is not.** → apps/mobile/lib/features/studio/CLAUDE.md

### Book sharing

- **The public share surface is `/s/`, outside `/api/` and the auth complement, and it exists in production only because `deploy/nginx.conf` names it.** → apps/api/src/mobile/CLAUDE.md
- **The share note's Jev gate holds the note for review on no verdict and never allows on one; it is a gate, not a screen, which is why it stays.** → apps/api/src/mobile/CLAUDE.md
- **The preview cap is the author's choice of how much a stranger reads, and it is applied again at serve time.** → apps/api/src/mobile/CLAUDE.md
- **A full share is free, and the share routes keep the unlock's wire only for installed builds.** → apps/api/src/mobile/CLAUDE.md
- **A share serves only text screened at the book's current revision, and a refused re-screen turns the link off for the author to share again, never takes it down.** → apps/api/src/mobile/CLAUDE.md + apps/api/CLAUDE.md
- **An install from a share page finds its remix through Play's install referrer, so the link's keys are a wire contract.** → apps/api/src/mobile/CLAUDE.md + apps/mobile/CLAUDE.md
- **The install referrer is read once per install, reported once, and its share's remix offered once; the raw referrer never leaves the phone.** → apps/mobile/CLAUDE.md
- **An account an operator turned sharing off shares nothing and remixes nothing, and the share write asks again under the user row's lock.** → apps/api/src/mobile/CLAUDE.md + apps/api/CLAUDE.md

### Security

- **Every auth decision reads the route the router matched, never `request.url`, and only the auth hook makes an operator.** → apps/api/CLAUDE.md + apps/api/src/routes/CLAUDE.md
- **Every unauthenticated route that runs scrypt is limited by client network before it hashes, and hashing itself is gated.** → apps/api/CLAUDE.md
- **An address is proven by a confirmed emailed code or by Google, and only a code mailed to the address the account has now can prove it.** → apps/api/CLAUDE.md
- **A console cookie is signed with the generation it was issued under, lives a week, and "sign out everywhere" moves the generation.** → apps/api/CLAUDE.md
- **Console and `/docs` responses carry `X-Frame-Options: SAMEORIGIN`, `nosniff` and `Referrer-Policy: same-origin`; the app's and the share pages' do not.** → apps/api/CLAUDE.md
- **An operator's suspension is a status, not a tombstone: everything that asks for ACTIVE refuses it, and only a deletion's sweeps read DISABLED.** → apps/api/CLAUDE.md
- **An upload is parsed in linear time, its zip directory is measured before JSZip reads it, and its inflation is counted as it happens.** → packages/core/CLAUDE.md
- **A production process refuses to start without what a purchase, a refund, a password reset and the console's lock depend on, and the provider keys it demands are read off the routing, never listed.** → packages/core/CLAUDE.md
- **A deleted book's prefixes are written down before they are deleted, and deleted again until they stay empty.** → apps/api/CLAUDE.md
- **The sexual-content filter is on unless a revision says off: its rule rides every text call where it leaves the process, a failed switch read keeps it on, request screens fail open and the share screen holds for review.** → apps/api/CLAUDE.md

### Production images and disk

- **The dependency layer is built from manifests alone, or every deploy ships a new gigabyte.** → scripts/CLAUDE.md
- **The host keeps the current and previous release's images by name; `docker image prune` would delete the rollback.** → scripts/CLAUDE.md
- **Postgres and Redis are the last things the kernel may kill, and every Node process knows its heap ceiling.** → scripts/CLAUDE.md
- **The worker drains while the API still serves, so a deploy's outage is the API's stop, the dump, the migration and the start.** → scripts/CLAUDE.md
- **Nothing is migrated until the database it changes is in S3.** → scripts/CLAUDE.md
- **The worker's healthcheck counts only its own container's heartbeat, because a lane's key outlives the worker that wrote it.** → scripts/CLAUDE.md
- **A deleted or overwritten object stays recoverable for 30 days, and no longer.** → scripts/CLAUDE.md

### Monitoring and alerts

- **`/api/health` is liveness and touches nothing; `/api/ready` is readiness and is what a monitor watches.** → apps/api/CLAUDE.md
- **An alert is a state, not an event: it fires once, recovers once, and survives a restart in its row — but the sweep never needs that row to send.** → apps/api/CLAUDE.md
- **A worker lane is alive exactly while its heartbeat key is, and the beat comes from the event loop it vouches for.** → apps/worker/CLAUDE.md
- **Mail is verified, not assumed, and a broken mailer is a readiness failure because it cannot be an email.** → apps/api/CLAUDE.md
- **An open child-safety report is an alert on the first sweep that sees it, and settling the report is what clears it.** → apps/api/CLAUDE.md
- **No housekeeping runs before the API listens.** → apps/api/CLAUDE.md

### Local stack

- Docker bind-mounts the repo, so `node_modules` uses anonymous volumes. → kept in full under ## Commands above
- **`make up` and `pnpm dev` are the same queue.** → kept in full under ## Commands above
- **An opt-in suite is made inert by not being *loaded*, not by skipping itself.** → packages/db/CLAUDE.md
