# DB

Prisma client, schema, and the billing/credit ledger. This package is what makes a reserve, a
commit or a refund *mean* something — nothing above it can change that.

`src/generated/` is produced by Prisma and gitignored. Run `pnpm db:generate` after touching
`prisma/schema.prisma`; never edit it by hand.

**Relative imports in this package carry `.ts`, not `.js`** — the opposite of `apps/*` and
`packages/core`, and deliberate. `schema.prisma` sets `importFileExtension = "ts"`, so the
generated client's own imports read `./enums.ts`, and `src/client.ts` and `src/index.ts` reach
into that tree the same way. Nothing here is ever compiled to JavaScript — every `build` script
is `tsc --noEmit`, `exports` points at `./src/index.ts`, and the API, worker and seed run the
sources under `tsx` — so a `.js` specifier names a file that does not exist and only resolves
because TypeScript and `tsx` both substitute the `.ts` back. It therefore typechecks, which is
why a stray `.js` import can sit here unnoticed. Match the package, not the root convention, and
don't flip the generator setting to make the root convention true.

## Importing billing

`src/billing.ts` is a facade over `billingLedger.ts` (balances), `billingEntitlements.ts`,
`billingSubscriptions.ts` (Google Play), `planPeriods.ts` (allowances and quotas),
`welcomeCredits.ts` (one-time welcome grant) and `billingInternals.ts` (shared plumbing), with
`ledgerReversal.ts` (a settled charge's one cumulative reversal) and `userStopSettlement.ts` (what
a reader's own stop keeps) behind the ledger.

**Import `@book-maker/db/billing`, never a module behind it.** The API suites mock the facade with
`vi.mock("@book-maker/db/billing")`; a deep import silently escapes that mock and the test stops
covering you. The package's `exports` map names only whole facades — `.`, `./billing`,
`./libraryMentions`, `./pageIllustrationOwnership`, `./searchGroundingAllowance`,
`./safetySettings` and `./providerSpend` — and nothing
behind one, to keep that honest.

`./libraryMentions` is a subpath for the opposite reason: it holds no client at all (its Prisma
import is types only), and both apps import it. The mobile API suites mock `@book-maker/db`
wholesale from a factory that may import nothing but `vitest`, so a name on the main entry has to
be re-implementable there — a mention scanner is not. Off the subpath the real module loads under
those mocks, which is what makes one definition of the include and the description safe to share.

**A module kept light enough to survive a mock has to be light in both directions.**
Being light is a claim about every import it has, not just the Prisma one. The types-only
Prisma import is half the reason; the other half is that the strip helpers come off
`@book-maker/core/libraryMentions` and not the core barrel. A suite that mocks core with a bare
factory takes the barrel down whole, and this module would go with it — the same breakage the
subpath exists to avoid, aimed at the other package. → packages/core/CLAUDE.md

`./pageIllustrationOwnership` follows the same boundary and is likewise **not re-exported from
the main DB entry**. The worker and the DB restructure compensation share its ownership rules,
while worker suites may replace both `@book-maker/db` and `@book-maker/core` with bare factories.
Its Prisma dependency is types only and its record guard is local, so importing the subpath loads
neither package barrel at runtime.

`./searchGroundingAllowance` is the third of that shape. It owns the one statement that decides
what a grounded search costs — the upsert-increment that hands each grounded prompt its ordinal in
Google's free allowance — and both the worker's `recordProviderUsage` and the API's
`recordInlineProviderUsage` run it, inside the transaction that writes the call's
`ProviderCallLog` row, against the client they pass in. Its Prisma import is types only and it
imports nothing from core (the pricing is core's `applySearchGroundingAllowance`, applied by the
caller), so a suite that mocks `@book-maker/db` wholesale still runs the real claim against its own
stand-in client. What only Postgres can settle — every ordinal handed out once under concurrent
first inserts, and a rolled-back claim not spent — is measured in
`searchGroundingAllowance.integration.test.ts`. Why the counter exists at all is in
`packages/core/src/adapters/CLAUDE.md`.

`./safetySettings` is the fourth: `readCopyrightRestrictionsEnabled(client)` is the one read of
the copyright flag, shared by the API's screens and the worker's legacy import restore so the two
cannot disagree about what the current setting is. Same shape — client passed in, Prisma for types.
It also owns the sexual-content filter's switch, `readSexualContentFilterEnabled` — **ON when no
revision exists**, the copyright flag's opposite — and `createSexualContentFilterFlag`, the cached,
single-flight read both apps ask on every text call, which answers ON when the read fails
(→ apps/api/CLAUDE.md, "Content safety").

`./providerSpend` is the fifth: `providerSpendSince(client, since, { userId? })` is provider spend
in USD since a moment — everyone's, or one reader's off `ProviderCallLog.userId` — summed from
`costHint` alone, so it is a floor on real spend and never replays a rate card
(`apps/api/src/admin/CLAUDE.md`). It is what a spend cap reads, served by the `(userId, createdAt)`
and `(createdAt)` indexes of migrations 000099 and 000100. Same shape — client passed in, Prisma for
types.

## Adding a priced operation

Add the value to `enum CreditOperation` in `prisma/schema.prisma` **and** to the `BillingOperation`
union in `packages/core/src/billing.ts` — one column, two declarations, because core is the leaf of
the dependency order and cannot import the generated client. `CreditOperationsAgree`
(`src/billingInternals.ts`) is where they are held equal, so editing one and not the other stops
compiling there by name rather than surfacing as this package rejecting a row its own client
returns. Add the price key to `DEFAULT_CREDIT_COSTS` and `CREDIT_PRICING_LIMITS` in
`packages/core/src/creditPricing.ts` (the latter is an exhaustive `Record`, so the compiler catches
a missed key), then close the loop:
reserve through `startGenerationAttempt` (`src/generationAttempts.ts`) or `reserveCredits`
(`src/billingLedger.ts`), commit with `commitReservedCredits`, refund with
`refundCreditLedgerEntry`. The `add-priced-operation` skill walks the surfaces above this package.

A refund also hands back whatever rode on the reservation — `metadata.imageQuota` is how a free-tier
illustrated-book slot is returned without the refund path knowing quotas exist. Do not drop unknown
reservation metadata.

## Page ordering

`src/pageOrdering.ts` and `src/pageRestructureRevert.ts` are here rather than in the worker because
both ends of the queue need them: the worker shifts `Page.index` when it applies a structural edit,
and the API runs the identical steps when the reader taps Undo. Two copies of a compensation is how
those ends start disagreeing about the same row.

`compensateStructuralPageChangeTx` is the ownership wrapper shared by worker failure rollback and
API Stop. Callers hand it an existing transaction; it takes Project before `BookEditOperation`,
checks the exact `structuralApplication.appliedAt` and (for a worker) lease token, refuses APPLIED or
newer-revision winners, and commits the revert, stamp removal, and durable completion marker as one
unit. Do not recreate any of those checks in either app. Reader Undo deliberately calls the
lower-level revert because it keeps the application stamp as operation history.

- **Every renumber parks before it lands, because neither unique index is deferrable.**
  `@@unique([projectId, index])` on `Page` and `@@unique([projectId, scope])` on `Embedding` are
  both plain `CREATE UNIQUE INDEX`, checked row by row as a statement runs, and a renumber overlaps
  by construction — inserting one page after page 3 writes 4 onto the 5 another row still holds. One
  statement therefore raises `23505` mid-flight and rolls back the whole restructure transaction:
  every page insert, delete and move, and every Undo of one. `Page` parks in the negative half of
  its range; `Embedding.scope` parks under `EMBEDDING_REPOINT_PARK_PREFIX`, which is deliberately
  *not* `page:-<index>` — every page-scope reader in the repo filters `LIKE 'page:%'` or
  `startsWith: "page:"`, and all of them match `page:-4`. Both second passes are unconditional over
  the project, so no parked row can be left behind.
  **A park key names the destination *and* the scope the row came from, because `sourceId -> page:%`
  is one-to-many.** `deletePageEmbeddings` matches with `startsWith` for exactly that reason: a row
  is upserted on `(projectId, scope)` and nothing holds a page to one of them, so
  `repairPageEmbeddings` — which resolves the page sitting at an index and only then spends a
  provider call — inserts `page:<old>` for a page that by now holds `page:<new>` when an edit commits
  inside that window, and a page job lagging in BullMQ backoff (the race `000056` was written for)
  writes its own stale index the same way. Keyed on the destination alone, one statement set *both*
  of that page's rows to the one `page-repoint:<index>` value: `23505` from **pass one**, the failure
  the split exists to prevent, and before 000056 a silent collapse of two rows into one. With the
  row's own scope in the key the parked values are as distinct as the rows are, since
  `(projectId, scope)` is unique, so pass one can collide with neither a live scope nor another
  parked one.
  A pass two that lands everything at once carries a precondition pass one cannot check: the
  ordering must name every page **currently holding one of its own destination indexes**, or a
  parked row is written onto a live one and the `23505` the split exists to prevent arrives from the
  statement that was supposed to be safe. `pageOrderStatements` states it as "name every page" and
  every caller obliges. The embedding re-point is deliberately looser — an insert names only the
  tail it shifted, whose destinations all sit past the head it leaves out — so
  `repointPageEmbeddings` asserts it instead of assuming it, *between* the two passes. That
  placement is what makes the check exact rather than conservative: by then the parked rows **are**
  the set pass two will write, so one join over the scopes they are about to become answers the
  question with no reference to the ordering and no array of ids to ship, and a destination whose
  page owns no `page:%` row at all is correctly not a collision. Both sides of that join go through
  `landedPageScopeSql`, the same fragment pass two's own `SET` is written with — one function rather
  than two `regexp_replace` literals a test holds equal, the hazard `lexicalMatchSql` is written
  against one section down, because a probe asking a slightly different question than the statement
  it guards answers "no collision" to a collision. Applying it to the *other* side too is what makes
  one join cover both hazards: the fragment is the identity on a scope that is not parked, so a live
  `page:5` compares as itself while a second parked row of the same page compares as the index it is
  headed for. It costs the live side the `(projectId, scope)` index probe it used to get — a
  function on both sides is not a lookup — and a range scan over one project's rows once per
  structural edit is the right price for a hazard the indexed spelling could not see at all. A hit
  throws `PageEmbeddingRepointCollisionError`, which names the fault and carries the scopes that
  prove it, rather than a constraint name arriving from inside a transaction that has already
  deleted pages, renumbered the book and written a `PlanVersion`. It also catches the two violations
  no ordering can repair: a `page:%` row whose page is already gone, which pass one keys on
  `sourceId` and therefore cannot park, and a page holding two page scopes, which have no one index
  to become. The assertion has no skip in it: `RawExecutor` requires
  `$queryRawUnsafe` alongside `$executeRawUnsafe`, so an executor that cannot answer the probe
  cannot park rows either. That read was optional once, only so a hand-written stand-in stayed a
  legal executor, and the check therefore turned itself off for exactly the executors the suites
  hand it — green over a re-point nothing guarded. And the guard is on the only *composed* path:
  `pageEmbeddingRepointPasses` returns a named `{ park, land }` rather than the
  `PageOrderingStatement[]` it used to, because that array was precisely what
  `runPageOrderingStatements` takes — park-then-land with no probe between them was an assembly the
  two exported signatures offered, and the integration suite took it. The raw path stays reachable
  on purpose, since that suite is where the `23505` itself is measured against a real Postgres, but
  reaching it is now a caller naming both passes rather than handing one builder's result to a
  runner that happened to accept it. `pageOrdering.integration.test.ts` is where that `23505` and
  the parked-against-parked case are measured, because a stand-in that models a unique index is not
  the index.
- **A page renumber carries the page map with it; only a sheet that would lose its page clears it.**
  Everything keyed on `Page.index` moves with it, and that is more than the `Page` table: the
  `page:<index>` semantic-memory scopes go through `repointPageEmbeddings`, and
  `Project.pdfPageMap` through `repointedPageMapUpdate`. The map still describes the PDF the reader
  is looking at until the recompile lands — `bookPageMapForProject` keeps a behind map in force
  while the project is EDITING — so it is carried across the renumber rather than cleared, and its
  *ranges* refused whole when one would lose its page. Refused, not nulled: what is left is the
  `bookPdfCoverNumbering` stub, stamped as the stored map was, because the cover-skip fact under
  those ranges describes the unchanged file and chrome reads `hasCoverPage` off it — nulling the
  column dropped that flag from the status DTO on every applied delete. See
  `apps/worker/src/generation/CLAUDE.md` for why a hole in the ranges is worse than no map at all.
- **A page that goes away takes its semantic memory with it, because nothing else will.**
  `Embedding` cascades on `Project`, not on `Page`, and `sourceId` carries no foreign key — so a
  deleted page's `page:<index>` rows survived it, and the renumber immediately after gave that
  index to the page that moved up. `deletePageEmbeddings` is the write both ends share:
  `applyStructuralPageChange` takes `removedPageIds`, `revertStructuralPageChange` takes
  `insertedPageIds`. Any new path that removes a `Page` row has to take them too — the schema will
  not do it for you.
  `ContinuityNote` used to have the same index-only ownership problem. New page notes carry a
  nullable `pageId` foreign key with `ON DELETE CASCADE`, and both structural directions still
  delete them explicitly for mocked/test clients; `repointPageContinuityNotes` updates their
  display scope and numeric page tag by that id. Migration 000053 backfills existing rows only for
  projects with no structural operation, where this feature cannot have reused an index. Any
  page-scoped row that remains unowned stays that way: a prior edit may already have reused its
  number, so generation excludes it and a structural change discards it instead of guessing which
  page wrote it.
- **A structural delete parks the page's older Undo history outside the Page cascade.**
  `PageEditSnapshot.pageId` must cascade for an ordinary permanent page removal, but that same
  cascade erased earlier edits' undo records during a reversible structural delete. The apply
  transaction now moves those rows to `ArchivedPageEditSnapshot` first, preserving the original
  ids, operation linkage, before/after fields and timestamps. The archive deliberately has no Page
  foreign key, and its `archiveKey` deliberately has no structural-operation foreign key: an absent
  page cannot cascade the history, and retiring a permanent structural delete cannot make the
  surviving half of an older multi-page edit look undoable. Revert checks the stamp's bounded count,
  recreates the Page, restores snapshots with their original ids using `skipDuplicates`, and only
  then deletes the archive, all in its existing transaction. A failed rollback therefore leaves
  either the original rows or the complete archive, never a truncated undo chain.
- **A deleted page comes back as it was, not as an approved one.** `revertStructuralPageChange`
  recreates the row from `StructuralApplication.removedPages` and nothing else — a `PageEditSnapshot`
  would have cascaded away with the page — so a field the record omits is a field the reader loses on
  the tap that promised to put the page back. It used to write `status: "COMPLETED"` flat and record
  no `qualityReport` or `imageFailureReason` at all: undoing the deletion of a `FAILED_QA` page
  silently approved prose the review had refused, and undoing the deletion of the only page whose
  illustration failed erased one of the four markers `projectAlreadyIllustrated`
  (`apps/api/src/mobile/addImageOperations.ts`) reads — the book stopped counting as illustrated and
  the next chat `add_image` could claim a second free-tier illustrated-book slot in the same month.
  All three now ride `removedPageRecordSchema` as **optional** fields, written by the shift and
  restored by the revert. Optional for exactly one reason: stamps already stored carry none of them,
  and their restore must keep the old defaults — `COMPLETED`, no report, no failure reason. Absent,
  never null: `qualityReport` is `Json?`, and an explicit JSON null is not the same value as no
  report at all.
- **The recorded page order is what the edit found, not what the undo will meet.**
  `pageOrderStatements` requires a list naming **every** page of the project — pass two brings every
  parked row back at once, so a page it leaves out keeps a positive index a parked row may land on
  (`23505`), and where they miss each other it leaves a hole nothing notices until a compile refuses
  the book for not being contiguous from 1. `StructuralApplication.pageOrderBefore` cannot promise
  that on its own: `undoLastBookEdit` picks the newest *undoable* operation and `CONTINUE_BOOK` is
  not one of those kinds, so a continuation appended on top of a structural edit is still in the book
  when that edit is undone and its pages appear in no stamp. `restoredPageOrder`
  (`src/pageRestructureRevert.ts`) reconciles instead of trusting: the recorded pages go back in
  their recorded sequence, pages the stamp never saw keep their order behind them, pages the stamp
  names but the book has lost are dropped, and the whole list is renumbered from 1 — which is a no-op
  for a book that did not drift, because a recorded order already runs `1..n`. The `pdfPageMap`
  re-point and `repointPageEmbeddings` read that same reconciled list, or they would describe indexes
  the pages never land on.
  **The stamp keeps that book in two lists, and the revert reads a different one for each half.**
  Rows come back from `removedPages`, parked at `-index`; the ordering that un-parks them is built
  from `pageOrderBefore`. They agree by construction — the shift reads both out of one `findMany`,
  and `reconcileStructuralPagePlan` has already dropped every removed id that read does not hold —
  but a removed page missing from `pageOrderBefore` would be created at a negative index no ordering
  entry names, and `pageOrderStatements` parks by name while it un-parks by *sign*: pass one drives
  whichever restored page was headed for that number onto the slot the recreated row already holds
  (`23505`, and the whole Undo rolls back), or — only when it was the book's last page and nothing has
  been appended since — pass two brings it back one past the end, a book longer than the `targetPages`
  written beside it.
  `recordedPageOrder` folds those pages in by their recorded index rather than asserting, because the
  revert recreates the rows unconditionally either way and refusing would abandon prose the stamp is
  still holding on a tap that promised to put it back; the fold is also what keeps them out of
  `drifted`, which means the *book* gained or lost a page, not that one list forgot one.
- **A cross-chapter move has two coordinates to undo.** `applyPageOrder` restores only indexes, while
  the apply side also changes `Page.chapterId` for pages moved under a different heading. New
  `StructuralApplication.pageOrderBefore` entries therefore carry their original nullable
  `chapterId`, and `revertStructuralPageChange` restores it for both API Undo and worker failure
  rollback. The field is optional on read only for stamps already stored without it; a missing value
  means leave membership alone, never move the page to a null chapter.
- **Undoing a structural edit moves the book to a different plan version, and the recompile has to
  follow it there.** Applying one approves a `PlanVersion` of its own and points the project at it.
  While that version is still current, `revertStructuralPageChange` deletes it and restores the
  version it superseded — which makes the plan id its caller was holding a moment earlier a row
  that no longer exists. A later continuation changes the answer: its pages are deliberately
  retained by `restoredPageOrder`, so restoring the pre-structural plan would leave them under a
  plan that never contained them and orphan the continuation plan. The revert validates the
  P1 -> P2 target delta against that later plan before changing any page, keeps the later plan
  current, and removes only that delta from its chapter targets and input snapshot; an unrelated
  later plan is refused transactionally rather than guessed at. It *returns* `currentPlanId` for
  both paths, and the reader's Undo queues its recompile against what it returns. Naming the stale
  one queued `compile-export` against a deleted plan, and that job owns the book's outcome: it
  threw, `markFailed` flipped a finished, delivered book to FAILED and
  `refundFailedProjectCredits` handed the generation back — from a free undo. A caller that gets
  `null` has no plan to compile at all and must put the project back rather than leave it in EDITING.

## Hybrid retrieval

One module per arm: `src/embeddingRetrieval.ts` is the cosine (pgvector) arm,
`src/lexicalRetrieval.ts` is the `pg_trgm` arm and its script fold, `src/hybridRetrieval.ts` fuses
the two, `src/retrievalArms.ts` is the degrade policy below — which the worker also uses over
continuity notes — `src/embeddingRepairTargets.ts` is the hole query, and `src/retrievalQuery.ts`
holds the pieces the queries are assembled from, including the `RetrievalCandidate` row shape every
arm returns. `src/index.ts` re-exports the arms **by name** rather than with `export *`, because
they hand each other helpers (the builders in `retrievalQuery.ts`, `cleanLexicalTerms`, and the
already-cleaned `retrieveCleanedLexicalEmbeddings` the latter feeds) that are seams inside the
split, not surface this package offers — `RetrievalCandidate` is the exception, because it is what
a caller's rows are and it has to be nameable.

- **Both arms build their scope filter from one function, because a fusion is only meaningful over
  one candidate set.** `embeddingScopeConditions` (`src/retrievalQuery.ts`) emits the `scopePrefix`
  / `excludeScopes` / `beforePageIndex` conditions in the arm's own spelling of the scope column
  (`"scope"`, `e."scope"`) and returns them **with** the parameter list they are numbered against —
  numbering read off `params.length` rather than tracked in a counter, so a placeholder cannot come
  to name a value that is not there. The two arms used to be two transcriptions of the same three
  blocks, each with its own hand-counted `let nextParam = 3`; a condition added to one and not the
  other would have made the fusion a comparison between two different books, and nothing would have
  failed. `retrievalQuery.test.ts` is that missing failure: it compares everything in each arm's
  emitted `WHERE` that is not the arm's own conditions, so an extra filter on one side alone is
  caught rather than merely the shared ones being present. That hazard has a second home one level
  up, where `retrieveHybridEmbeddings` has to *forward* the filter into each arm: every field of an
  `EmbeddingScopeFilter` is optional, so a hand-copied enumeration reaching one arm and not the
  other compiles exactly as quietly as the two transcriptions did. It builds one `armFilter` value
  and spreads it into both calls, and `hybridRetrieval.test.ts` repeats the builder suite's
  comparison over the whole hybrid — isolating each arm's scope conditions by the column they name,
  which neither arm's own conditions mention, and comparing them whole. Forwarding is also where
  the filter's deliberate asymmetry lives: `scopePrefix` and `excludeScopes` are tested for
  truthiness because an empty prefix and an empty exclusion list narrow nothing, while
  `beforePageIndex` is tested against `undefined` because 0 is falsy and means "no earlier page" —
  the bound the book's first page retrieves under. It is a module of its own rather than a
  corner of the cosine arm because `embeddingRepairTargets.ts` borrows the row cap from it and is
  deliberately not one of the arms. That cap (`retrievalRowLimit`, 1..50) takes a number and has no
  default folded into it: the arms name `DEFAULT_RETRIEVAL_TOP_K` themselves, while the repair
  pass's `limit` is required and carries its caller's own batch size — `retrievalTopK` is where the
  arms name that default, so `options.topK ?? DEFAULT_RETRIEVAL_TOP_K` is written once rather than
  at each arm and again at the fusion.
  **The row the arms hand back is spelled there too, for the same reason the filter is.**
  `RetrievalCandidate` (and `RetrievalCandidateSqlRow` / `mapRetrievalCandidates`, which coerce the
  `similarity` a driver may decode as a string) were two transcriptions of one object literal, one
  per arm, next to the `WHERE` blocks that were two transcriptions until `embeddingScopeConditions`
  was extracted. `fuseHybridEmbeddingRanks` merges the arms by `id` and spreads a row of either into
  one `HybridEmbedding`, so a field one arm selects and the other does not is a field whose presence
  depends on which arm ranked the page first, and no RRF score reveals it.

`retrieveLexicalContinuityNotes` searches `ContinuityNote` rather than `Embedding`, and its
`beforePageIndex` is a **required** `number | null` — the whole-book callers say `null` — because
the worker's `loadContinuityNotes` had shipped its trigram arm without inheriting the forward bound
its embedding twin already had (`apps/worker/src/generation/CLAUDE.md`). It bounds through the
`pageId` foreign key rather than `pageScopeIndexSql` (`src/retrievalQuery.ts`): an edit's notes
are scoped `page:<index>:edit:<operationId>`, which that pattern resolves to NULL, so bounding on
the scope would drop every edited page's notes instead of placing them in time. Notes with no
`pageId` are project-scoped once the ownership predicate has run, and no page bounds them.

- **One arm of a hybrid retrieval must not be able to settle the other, and an arm nobody engaged
  is not a survivor.** `retrieveHybridEmbeddings` runs a cosine arm and a `pg_trgm` arm and fuses
  their rankings. It ran them as one `Promise.all`, so a database where migration
  `000055_trigram_memory_search` could not `CREATE EXTENSION pg_trgm` — no superuser on a managed
  Postgres, or a stack migrated before that branch — failed the *whole* call on every page:
  `retrieveSemanticPageMemory` caught it and returned `[]`, and every page past the recency window
  lost all long-range continuity, which is strictly worse than the vector-only behaviour the lexical
  arm was added to improve on. The arms settle separately now and either one degrades to the other's
  rows through `degradeRetrievalArm` — the same policy the worker's `loadContinuityNotes` wraps
  its optional promise in. That wrap was hand-rolled there first, which is exactly how it came to
  be missing here, so the policy is one exported function rather than a habit.
  Fusion needs no special case: an RRF score is a sum over the rankings a row appears in, so an
  empty ranking contributes nothing and the survivor keeps its own order and its whole `topK`.
  What still throws is a retrieval where *nothing* answered — both arms engaged and both failed
  (as an `AggregateError`, so a chronic fault under a transient one is still in the log), or the one
  engaged arm failing in vector-only or lexical-only mode — because an empty array there reads to
  every caller as "no page matched". A degraded arm is *counted* per (arm, message) per process and
  reported on a ladder — the first occurrence, then every power of ten. A missing extension fails on
  every page of every book, so one line per page job would bury the only thing worth knowing; but
  reporting only the first line is right for a permanent fault and wrong for an intermittent one,
  and the two reach this code as the same stable message — a connection reset that recurs would
  otherwise be reported by the first page job that met it and by none of the ten thousand after.
  Each later rung carries the running count and the project it hit, so the same message on a book
  that is not the one in the first line reads as a fault spreading rather than an environment fact
  standing still. A message not seen before still prints, so a new SQL fault is not hidden behind an
  older one, and the 64-key cap on the census is a memory bound and nothing else: a count it drops
  restarts that message's ladder, which can only make reporting louder.
  **Which arms are engaged is one derivation, not two.** The needles are cleaned once, at the top of
  `retrieveHybridEmbeddings`, and that array is both what the count is read from and what the lexical
  arm searches with — `retrieveCleanedLexicalEmbeddings` takes a branded `CleanLexicalTerms` so a
  caller cannot hand the raw ones on and have them folded, deduped and cut a second time. It used to
  do exactly that: the same per-character fold over every needle twice per retrieval, and, more than
  wasted work, two separate answers to the question the paragraph above settles a whole call on. The
  count decides whether a failing arm degrades or throws, so nothing may be able to say "engaged"
  here and "nothing to search" one function down.
  **And a degrade must not swallow a stop.** `rethrowIf` is a **required** `((error: unknown) =>
  boolean) | null` on this function — the worker passes `isStopRequestedError`, the package's own
  integration suites pass `null` — for the reason `retrieveLexicalContinuityNotes`' `beforePageIndex`
  is required: every production caller is inside a page job a reader can stop, an optional predicate
  is silently absent at the next call site, and a degrade *looks* like success, so what an omission
  costs is a stopped generation coming back as a slightly thinner memory instead of as a stop.
  `loadContinuityNotes` had been passing one to `degradeRetrievalArm` all along and this entry point
  passed none, which is the same shape of hole as the `Promise.all` above. It reaches both arms'
  `degradeRetrievalArm` calls and, separately, the both-arms-failed path: `isStopRequestedError` does
  not look inside an `AggregateError`, so a stop bundled into one is a stop lost just as surely.
  **`degradeRetrievalArm` itself requires it too, so the argument above is a type rather than a
  habit.** Requiring it only at this entry point left the shared policy taking `rethrowIf?:` — the
  very shape the paragraph rules out — and the helper is what a *new* degrade site imports: the
  worker's `loadContinuityNotes` and `createDegradedEmbedding` (`apps/worker/src/generation/`) call
  it directly, without passing through here. Every existing caller was already passing a predicate,
  so nothing changed but the compiler's answer to the next one that forgets. This function forwards
  its own `rethrowIf` into both arms unconditionally now, rather than through a
  `{ ...(x ? { x } : {}) }` spread that made a `null` claim and a forgotten option indistinguishable
  one level down.

- **A needle and the column it is scored against are folded together, or not at all.** The worker
  picks a page's trigram needles with `foldCharacterName`, so a plan character named "علی" is
  correctly recognised in a brief that spells him "علي" — and then it handed the *raw* plan name
  to `strict_word_similarity`, where Postgres folds nothing. Measured: 0.333 against a summary
  written with the Arabic yeh, 0.077 for "یاسمین", 0.0 for "کریم" — all under
  `LEXICAL_SIMILARITY_FLOOR`, so a Persian book's pages were unreachable by their own characters'
  names while the docblock said otherwise. `foldLexicalText` now folds every needle inside
  `cleanLexicalTerms` and `lexicalFoldSql` folds the column in the same query, because folding one
  side only moves the mismatch. Both trigram queries — over `Embedding.text` and over
  `ContinuityNote.body` — build that scoring block from one `lexicalMatchSql`, which takes the
  branded `CleanLexicalTerms` and emits the folded column, the needle placeholder numbered against
  them, the floor and the ranking together: the pairing is what the signature is for, rather than
  something two transcriptions of one lateral happened to agree on. Only that block is shared —
  the two `SELECT` lists, tables, ownership predicates and page bounds stay at their call sites,
  because the embeddings arm bounds on the `page:<index>` scope and the note search on the
  `pageId` foreign key. It is deliberately *not* `foldCharacterName`: that fold answers
  "same person" and deletes ZWNJ, collapses whitespace and drops a per-script list of optional
  marks, while pg_trgm scores *words* — "علی" against "علی‌محمدیان" measures 1.0 on the ZWNJ word
  break and 0.25 once it is deleted, so adopting it would have bought the fix with a regression.
  Its mark list cannot cross into SQL either: Postgres regex has no Unicode-property classes, so
  the enumeration would have to be copied into the query (or into an index) and thereafter kept in
  step by migration. A 1:1 `translate()` map can change neither length nor word boundaries.
  That map is **one** `[from, to]` table and both `translate()` arguments are derived from it,
  because the two strings carry an equal-length invariant nothing in the language holds them to:
  `translate` *deletes* a `from` character the `to` string is too short to answer, so an addition on
  one side alone folds the column into a space the needle is not folded into — every needle carrying
  that character scores 0, no arm degrades, nothing raises. `compileLexicalFold` refuses at module
  load what a pair table still cannot state on its own: an entry that is not one character on each
  side (codepoints, not UTF-16 units), a repeated source character (`translate` keeps the first
  mapping and `Map` the last), and a quote or backslash the SQL literal could not carry. Nothing is
  lost to folding a column: `000055_trigram_memory_search` dropped the trigram GIN indexes on purpose — `gin_trgm_ops`
  cannot serve a `strict_word_similarity(...) > floor` predicate at all — and `translate` is
  IMMUTABLE, so an expression index stays available if that ever changes. The measurements live in
  the opt-in `lexicalRetrieval.integration.test.ts`.

- **Finding what a page's memory is *missing* belongs here too, and the `LIMIT` is the point.**
  `findPageEmbeddingRepairTargets` answers "which pages below this index have no usable
  `page:<index>` row", for the worker's per-page repair pass. It is in this package rather than in
  the worker because it is a query over two tables this package owns, and because it is the kind of
  SQL a mock cannot vouch for — `embeddingRepairTargets.integration.test.ts` measures it against a
  real Postgres. Three properties are not stylistic. The backoff window is a `WHERE` predicate so
  the `LIMIT` cuts what survives it — a limit taken first would let three pages a provider refuses
  hold every repair slot forever, which is the starvation the worker's backoff exists to prevent.
  It is `NOT EXISTS`, not `LEFT JOIN … IS NULL`, because only the anti-join lets the `LIMIT` stop
  the scan early (measured on a 300-page book: 0.72 ms against 2.1 ms and two sorts) and because an
  outer join would emit a page twice on a database that predates `000056`'s unique index. And the
  degraded test ends in `IS TRUE`, because the predicate is used *negated*: healthy metadata has no
  `vectorStored` key, `->` gives NULL, and `NOT (NULL AND …)` is NULL — which silently reclassified
  every healthy page as a hole until the integration suite caught it.
  **What counts as degraded is one rule with two spellings, and both live in that file.**
  `embeddingIsDegraded` reads a row Prisma handed back, `degradedEmbeddingSql` reads the `jsonb`
  column, and they cannot share an implementation — so they share a file, under the docblock that
  says why they mean the same thing: the boolean `false`, never the string `"false"`, and metadata
  that is not an object at all is not degraded. The function used to live in
  `apps/worker/src/generation/researchMemory.ts`, one package away from the query it had to agree
  with; that pass imports it from here now. What they cannot share in code they share in
  `src/testing/degradedEmbeddingShapes.ts` — one table of metadata shapes stating the rule's
  answers, run through the function by `embeddingRepairTargets.test.ts` with no database and
  through Postgres, shape by shape against the function, by the integration suite. The worker's
  research suite restates the function in its `@book-maker/db` mock factory for `dbScopeMocks`'
  reasons, and carries that file's "keep it equal" note.

## Library mentions

`src/libraryMentions.ts` is the shared reading of a character's `@mention` rows — the include, the
cast, the scan set, and `generationDescription`, the one function here that hands prose to a model.
The ordering those reads carry is under [Tests](#tests), with the suite that measures it.

- **A mention row nothing can name is what makes the strip stop trusting the name list.**
  The narrow strip (`stripLibraryMentionMarkers`) finds each marker by scanning for its owner's
  name, which is exact and only as complete as the list it is given. A row
  `libraryMentionTargetName` answers `null` for — a LOCATION or OTHER row, whose target table does
  not exist yet; a CHARACTER row whose join a narrow `select` dropped — is a marker the reader
  bound, standing somewhere in that prose, that no scan can locate. It was walked past, so
  `@Harbor` — a UI-only token — went into the planner brief (`creationBuild.ts`) and into
  `buildLibraryCharacterPortraitPrompt` verbatim. Nothing kept that shut but `REPLACED_MENTION_KINDS`
  (`apps/api/src/mobile/libraryMentionLinks.ts`) still being `["CHARACTER"]` alone: the first row of
  another kind anything wrote was the leak, with no code change anywhere to notice it. So the answer
  is read off the rows every time rather than remembered for that day — any unnameable row in the
  set switches `generationDescription` to `stripEveryLibraryMentionMarker`
  (`@book-maker/core/libraryMentions`), which takes the `@` off every token-opening marker, claimed
  or not. It is the scanner's own word test, so an `@` inside a word is still an email address and
  one with nothing after it is still prose. What it costs is the reader's own `@handle` elsewhere in
  *that* description losing its marker; what it buys is that no marker can survive by being
  unnameable — and nothing has to be changed back either, since the day the Location library lands
  and its join goes into `libraryMentionInclude` the row becomes nameable and the strip by name
  covers it again. The app-side half of the same hole is still open: `libraryMentionRefs` withholds
  a row it cannot name, so a stored `@Harbor` would be a link only the database knows about.

- **Naming every row is not the same as claiming every marker, and a tie is settled rather than
  left standing.** `[userId, name]` is
  case-sensitive, so "Bram" and "bram" are two legal rows — and `claimAt`
  (`@book-maker/core/libraryMentions`) refuses a span two names tie over, because a wrong owner is
  the unrecoverable half. Both rows are perfectly nameable, so `generationDescription`'s test above
  sends that description down the *narrow* branch, where an `@` nobody claimed is left standing as
  the reader's own text: `@BRAM` beside those two rows reached the planner brief and
  `buildLibraryCharacterPortraitPrompt` with its marker on. The narrow strip cannot fix that itself
  — it takes `siblings` whose tokens must survive, so a tie may belong to one of them — which is
  why the model-facing read uses `stripBoundLibraryMentionMarkers` instead: same scan, and a tie
  settled rather than skipped, because with no surviving sibling every candidate agrees on the one
  deletion. The broad strip is not the answer here either; it would take the reader's own `@handle`
  with it for a marker that is perfectly locatable.

- **The broad strip's word test reads the prose it is producing, not the prose it was handed.**
  `stripEveryLibraryMentionMarker` decides "does this `@` open a word" from the character in front
  of it, and then deletes characters out of the very string it just read. Two markers escaped
  through that gap. `@Bram@Harbor`, with only Bram nameable, came back `Bram@Harbor`: the second
  `@` is preceded by `m`, so the test walked past it — but that `m` is the tail of a token whose
  own `@` was already going. `@@Harbor` was worse, deleting one marker and returning `@Harbor` —
  the exact UI-only token the branch exists to keep out of a prompt, one deletion later. Both are
  closed by measuring against the result rather than the input: a claimed range's `end` is a word
  boundary, and the scan runs right to left so a marker's verdict is in before its left neighbour
  asks. What makes the first safe is that the claim is evidence *from the rows* that those letters
  are a token — the strip never chains off its own heuristic, so with nobody nameable
  `@bram@example.com` keeps both. Inferring a second marker from a first that was itself a guess is
  how an address loses its `@`. The function is a fixed point now: nothing it returns opens a word.
  **The bound strip takes the run half of that rule, and only the run half.** `@@Bram`, with Bram
  claimed, dropped the marker at offset 1 and answered `@Bram` — reachable rather than theoretical,
  because `libraryMentionQueryAt` opens a mention query on an `@` whose left neighbour is an `@`, so
  typing `@@` and tapping the suggestion chip stores exactly that with a live CHARACTER row bound to
  it; `@@BRAM` beside "Bram" and "bram" leaked identically through the contested half. So an `@`
  standing in front of a marker that strip is deleting goes with it, and its guarantee is the
  narrower twin of the fixed point above: nothing it returns stands where a deleted marker stood.
  What it does **not** take is the `tokenEnds` exemption — that is evidence about a marker the broad
  strip cannot name, and this caller's list is the whole of what the prose is bound to, so
  `@Bram@Harbor` keeps its second `@` and the reader's own `@handle` is never at risk on this
  branch.


## Tests

`src/testing/billingTestDb.ts` is the shared harness. Nothing here needs a live Postgres — except
the four opt-in suites (`*.integration.test.ts`), which `vitest.config.ts` leaves out of collection
unless `DB_INTEGRATION=true`.

`libraryMentions.integration.test.ts` is the one that measures a claim about **Prisma** rather than
about a query of ours: `libraryMentionOrder` names the `orderBy` terms of every read of a
character's mentions, and every character suite in the repo mocks `@book-maker/db` or `prisma`, so
none of them reaches the client at all. It reads through `libraryMentionInclude` and through a
respelling of the API's hand-written `incomingSourceSelect`, over a fixture seeded in an order no
term of the read order produces — and, for `incomingLibraryMentionOrder`, over three sources naming
one target where the one that sorts first is written last. Since the include now splices the
declaration itself, asserting
`libraryMentionOrder` is unchanged after a burst of concurrent reads is a real measurement of "a
real client does not write into the args it is given" — where against a per-read copy it was
measuring something nobody shared. A future client that normalises args in place fails here with a
diff rather than by silently reordering rows.

- **One declaration orders every read of a character's mentions, and no read spells it a second
  time.** `libraryMentionOrder` names the `orderBy` terms of every read of these rows, and the
  order is load-bearing in a way a second spelling would silently break: kind first because
  `sortOrder` is per write per kind, `targetId` last because it closes the primary key. It used to
  be deep-frozen, and `libraryMentionInclude` used to expose `orderBy` as a *getter* over a fresh
  copy per read, to defend against a client extension or `$use` middleware writing into the args
  object it was handed. That bet is not one anything in this repo is taking — there is exactly one
  client construction (`client.ts`, `new PrismaClient({ adapter, log })`, nothing chained), no
  `$extends` and no `$use` anywhere outside the generated client's own type declaration, and no
  `prisma-extension*` package in the lockfile — and it was paid for on every read, in three
  indirections and an allocation per query, to be exercised only by a test poking the declaration
  directly. What is left is the narrower rule the ordering actually needs: the include splices the
  declaration itself, so an equal-but-separate second spelling fails the unit test, and the opt-in
  integration suite measures that a real client hands a plain args object back exactly as given.
  `libraryMentionOrderArgs()` survives for the two hand-written reads outside the include, which
  hold it differently. `incomingSourceSelect` (`apps/api/src/mobile/libraryMentionRewrites.ts`) is a
  module constant every rename and delete read shares, so it takes a disposable copy per read rather
  than keeping an array of its own. `storedMentionLinks`
  (`apps/api/src/mobile/libraryMentionLinks.ts`) builds its whole `findMany` args per call, and there
  the order is load-bearing in a way it is nowhere else: `mentionLinksAlreadyStored` compares those
  rows **positionally** against an insertion batch numbered `0..n-1`, so an unordered read answers
  "not identical" at random and puts every ordinary description save back on the `deleteMany` plus
  `createMany` pair the skip exists to avoid — two statements inside the transaction holding the
  character's row lock, and the primary-key collision `namesMentionPrimaryKey` has to translate into
  a 409 for a save that asked for no link change at all.
  What no API write lane does is read these rows back to *hand them on*: `replaceLibraryMentions`
  returns the batch it just wrote, typed as `LibraryCharacterWithMentions["outgoingMentions"]` so a
  join landing in `libraryMentionInclude` stops compiling there instead of shipping half a row. It satisfies the
  declaration by construction rather than by spelling it — one kind numbered `0..n-1` in first-token
  order already *is* kind → `sortOrder` → `targetId`. A write that holds the ordering is not a
  second declaration of it; a write that sorted would be.
  **One declaration per axis, and the outer read is an axis of its own.** That rule was written and
  then applied at one level only: `incomingSourceSelect` takes those terms on its *nested*
  `outgoingMentions`, while the `findMany` that produces the sources it is nested in —
  `incomingMentionSources`, the first statement of every character rename and delete — asked for no
  order at all. An ordered list of mentions inside a list of characters the plan sequenced, past the
  same rule, one level up. `incomingLibraryMentionOrder` is that read's declaration, and it is a
  second declaration rather than a second spelling because the axis really is different:
  `libraryMentionOrder` is read under a fixed `sourceCharacterId` and closes on the rest of the key,
  while this one is read under a fixed `targetCharacterId`, where `targetKind` is the constant
  instead — the arc CHECK forces `targetCharacterId IS NULL` for LOCATION and OTHER, so every row
  the incoming read can return is a CHARACTER row and those terms would leave the whole set tied.
  The answer is `@@id([sourceCharacterId, targetKind, targetId])` whole, which is what makes it
  total; the source id leads because it is the only one of those three that sorts these rows at all,
  `targetKind` being the constant above and `targetId` constant with it — one write stores it
  equal to `targetCharacterId`, which the filter has already fixed. It used to be argued as a lock
  order: `claimCharacterRows` locks the set in one `SELECT … FOR NO KEY UPDATE` `ORDER BY "id"`, so
  ascending source id was said to make `rewriteMentioningDescriptions` issue its per-row `UPDATE`s
  in the sequence their locks were granted in. There are no per-row `UPDATE`s — that write is one
  `UPDATE … FROM unnest(…)`, which takes no lock the claim is not already holding, so its array
  order is not a lock order — and what the leading term buys is that the read is ordered at all.
  What the missing order actually cost is small and real: which sibling a
  `CHARACTER_MENTION_TOO_LONG` refusal names when a rename is too long for more than one
  description, and which of a source's duplicate rows wins the dedupe. Neither is visible to a suite
  that mocks Prisma, which is why the opt-in suite above is where that read is measured.

- **An opt-in suite is made inert by not being *loaded*, not by skipping itself.** All four of
  those files import `prisma` from `src/client.ts`, and `describe.skipIf(!enabled)` skips only the
  test bodies — the file's imports still ran, so every ordinary `pnpm test` built a `PrismaPg` adapter and
  a `PrismaClient` against the default `localhost:55432` URL: a pg pool per suite, and a handle for
  vitest to tear down, in the run that is supposed to need no database at all. The exclusion in
  `vitest.config.ts` is what actually makes them inert, and it is a glob over `*.integration.test.ts`
  rather than a list of files, so the next opt-in suite written by copying one of these cannot bring
  the pool back. The `skipIf` stays as a second guard, for a runner that reaches the file under some
  other config. One consequence worth knowing: without the variable, naming one of those files on the
  command line reports "No test files found" — that is this exclusion, not a mistyped path.

## The reserve, commit, refund loop

- **Credits are reserved, then committed or refunded.** Any new priced operation has to close that
  loop, including on the failure path. `packages/db/src/billing.ts` is a facade over
  `billingLedger.ts` (balances), `billingEntitlements.ts`, `billingSubscriptions.ts` (Google Play),
  `planPeriods.ts` (allowances and quotas), `welcomeCredits.ts` (one-time welcome grant) and
  `billingInternals.ts` (shared plumbing) — import the facade, never a module behind it, or the
  `vi.mock("@book-maker/db/billing")` in the API suites stops covering you.

- **A paid attempt may only be parented onto the job its own `create` callback wrote.**
  `startGenerationAttempt` gets that job id from a callback, and every callback gets it from
  `enqueueGenerationJob`, which returns whatever row already stands under its `dedupeKey` instead
  of creating one. So a key another path already spent hands back a job this attempt never made,
  and the writes after the callback used to re-parent the attempt *and its committed spend* onto
  it unconditionally. Where that row is already some attempt's `primaryJobId` the unique index on
  that column catches it — as a raw `P2002` several statements later — but where it is not, nothing
  did: an unbilled row (`generate-book:<projectId>:<planId>`, written for free by the operator
  approval route in `apps/api/src/routes/projects.ts`, which takes no attempt at all) or the second
  job of a multi-job attempt. And the damage is not a mispointed column: worker settlement reads
  `attemptId` off the **BullMQ payload**, not off `GenerationJob`, and the payload is written once
  at dispatch — a row that already carries a `bullJobId`, or is already terminal, will never carry
  the new attempt's id to a worker. Nothing then marks that attempt succeeded or failed;
  `reconcileGenerationAttemptRefunds` only sees `refundPending` terminal rows, so a QUEUED attempt
  holding a committed SPEND is invisible to it forever. A charge with no settlement is the one shape
  this loop has no answer for. `assertPrimaryJobBelongsToAttempt` is the guard, and it lives in this
  function rather than at each caller because the contract is this function's:
  `enqueueGenerationJob`'s `attemptId` is optional, so nothing above it compiles differently for
  getting this wrong. The test is exact — the row must *already* carry `claimed.id`, which every
  caller stamps at enqueue — because `attemptId: null` is precisely the unbilled row being refused,
  so there is no tolerated middle and a forgotten stamp is a loud `GenerationAttemptJobClaimError`
  rather than a silent re-parent.
  **But it can only vouch for the job the callback *named*, so the same refusal is also a
  precondition of `enqueueGenerationJob` itself.** A `create` callback may enqueue more than one job
  — `POST /api/mobile/projects/:id/resume` loops over the failed run's rows and keeps the first as
  `primaryJobId` — and every job after that first one reached the commit neither stamped nor
  verified. Answered from a key another path had spent, such a job leaves the charge committed while
  the dispatch query `where: { attemptId }` cannot find it: fewer actions queued than the reader
  paid for, and no settlement at all if that pre-existing row had already finished.
  `assertEnqueueMayClaimFoundJob` (`apps/api/src/queue.ts`) refuses at the one place the hazard is
  created — both when a `dedupeKey` lookup finds a row and when the concurrent-create `P2002`
  recovery reads one back — so it covers every job of every attempt. It is inert for a caller that
  passes no `attemptId`: the operator routes, the export repair, the free presentation recompiles
  and `enqueueOrRequeueGenerationJob`, whose options carry none. Neither check subsumes the other,
  which is why both stand: `packages/db` may not import `apps/api`, and `create` hands back an *id*
  that could have come from a hand-written `generationJob.create` or off another row entirely — and
  this one is the only check that answers "no such job". The worker's own `enqueueWorkerJob`
  (`apps/worker/src/runtime/dispatch.ts`) needs neither, because it appends `:attempt:<attemptId>`
  to its dedupe key: a row it finds under that key already belongs to the attempt asking.
  Both spellings raise `GenerationAttemptJobClaimError`, deliberately not a
  `GenerationAttemptConflictError`: that one is a 409 the reader can act on, and this is a wiring
  fault nothing above can. Refusing inside
  the attempt transaction is what makes the refusal free — the reservation, the spend, the quota
  slot and every domain write roll back with it. Callers keep their own local guards where they can
  give a better answer than a 500 — and the better answer is not the same one twice.
  `queueInitialMobilePlan` (`apps/api/src/mobile/projectRecords.ts`) refuses first, with a 409 and a
  sentence: a row under `plan-book:<projectId>` means planning already started, and a failed one is
  retried for a fresh charge through `POST /api/mobile/projects/:id/resume` — which enqueues under
  its own `generation-retry:` key — never by re-running this command. "First" is now literal: it
  reads the row *before* it enqueues, because the enqueue refuses the same disagreement itself and
  a check over what the enqueue returned would never run. The legacy-approval branch in
  `apps/api/src/mobile/routes/plans.ts` *replays* instead, answering 202: an unbilled
  `generate-book:<projectId>:<planId>` row is a full book already queued for free, so it dispatches
  that row if it is still QUEUED and undispatched rather than charging a second package for work
  that is already under way.

- **A charge has one cumulative reversal, and partial settlements name their claim.**
  `refundCreditLedgerEntryPortion` is the ledger's only partial reversal, for work priced by the
  page that delivered fewer than it billed. Its first production caller was a structural insert
  that resumed against a book holding two of its five recorded pages; a recorded insert is now
  indivisible and settles whole, and the caller it has today is a reader's own stop of a book that
  had written some of its pages (the entry below). The unique `reversesEntryId` still links one REFUND row,
  but that row's amount is the cumulative total returned; the partial caller's stable claim key in
  metadata makes a redelivery a no-op. `failEditOperation`, `failGenerationAttempt`, the fallback
  project refund and the attempt reconciler may later reach the same charge: they top that row up by
  exactly the unpaid remainder. Balance pools follow the source allowance cumulatively, including a
  period rollover between portion and top-up. Entitlements and quota slots are indivisible, so the
  portion leaves them alone and the top-up that reaches the whole charge revokes/releases them. Any
  consumer of `reversedByEntry` must compare `amountCredits`; presence means *some* refund, not a
  whole refund.
  **Only the amount is cumulative.** `balanceAfterCredits` is a point-in-time stamp — the spendable
  balance right after the write that created the row — and a top-up used to rewrite it, naming a
  moment nothing records (`updatedAt` is selected nowhere) while replacing the reason the partial
  settlement gave. The row now keeps the stamp it was born with, its `description` accumulates the
  distinct reasons in order, and `metadata.refundSettlements` carries each settlement's own credits,
  resulting balance, reason and time — the trail one row cannot hold on its own, and the only place a
  later settlement's balance survives. A reversal written before that trail existed has its first
  settlement reconstructed from the row's own columns by the top-up that reaches it. A second reversal
  row is not an option: `reversesEntryId` is unique and every reader treats `reversedByEntry` as one
  row, so `refundedLedgerEntryIds` and `refundLatestProjectOperationCredits` would under-count a split
  reversal and redeliver or re-refund a charge.

- **A reader's own stop or delete refunds only what was not delivered, and an ended month's
  allowance lapses instead of turning permanent.** Every stop route and both delete routes go
  through `stopProjectGenerationJobs` (`apps/api/src/queue.ts`), which refunded a paid run whole
  however much of it had been delivered. The app previews every page row while a book is written
  (900 characters, a whole picture-book page) and serves its pictures, so a book could be read and
  then deleted for every credit back, and a free account could repeat that on welcome credits with
  its illustrated-book slot handed back each time. And `refundPoolSplit` sent the allowance share of
  any refund to the never-expiring purchased pool once its period had rolled over: a Max subscriber
  who started 80,000 credits of books before the reset and deleted them after it held 160,000
  spendable, 80,000 of them permanent (found 2026-10-12, before launch). The stop transaction now
  calls `recordUserStopSettlementTx` (`userStopSettlement.ts`) for every attempt it terminalizes,
  before a delete can cascade the pages away, and stamps the **charge** with
  `metadata.userStopSettlement`. What was delivered is page rows holding prose, whatever their
  status — the app previews every one, and a composed chapter's pages sit PENDING with their whole
  prose until finalize — plus interior pictures and a model-drawn cover. It is priced at the quote
  the approval stored beside the charge (`creditEstimate`, or a paid retry's source's), with the
  base fee only once a page exists; premium review and the export unlock are never delivered by a
  stopped run. Three charges are priced by delivery (launch review 2026-10-13, H3, closed the two
  that still came back whole after the reader had them). `FULL_BOOK_GENERATION` as above. A chat
  rebuild or translated copy, `BOOK_REPLAN`, by the same rule against the **copy** — its attempt
  and charge belong to the copy's project, so the source book's pages are never counted — at the
  quote `replanCopyOperations.ts` stores beside it (core's `estimateBookReplanCreditCost`: a
  `BOOK_REPLAN` re-planning line, read as base, then the copy's full-book lines); a rebuild charged
  before that quote was stored has none and refunds whole. A narration, `AUDIOBOOK_GENERATION`:
  READY chapters are downloadable the moment they flip, so it keeps its base once one is READY plus
  the READY chapters' share of the length-priced part, weighed by each chapter's
  `estimatedDurationMs` (the text it reads, which the per-word rate prices) and rounded down —
  only the audiobook row whose `generationJobId` is the attempt's own job counts. A quote that does
  not add up to the charge refunds whole. Every other charge (an edit, a plan) is stamped as keeping
  nothing: refunded whole as before, but still as the reader's own. The stamp is on the ledger
  entry because the attempt-less refund paths only ever see the entry, and it binds every
  settlement whichever path runs it.
  `refundCreditLedgerEntryTx` routes a stamp that kept something through the partial reversal under
  `user-stop:<attemptId>`. The reversal never grows past `refundableCredits`, so no reconciler,
  legacy fallback, worker failure or later partial under another claim tops it up.
  `refundLatestProjectOperationCredits` treats a charge settled to its stamp as no longer standing.
  The kept part consumes the charge the way spending does, allowance first, so what comes back is
  the purchased share first. A plan share whose period has ended lapses (`refundPoolSplit`'s
  `lapseExpiredPlanShare`). It is counted in the reversal, so the charge reads settled and a stop
  that kept nothing still releases its quota slot; and it is written as its own `ADJUSTMENT` with
  `expiredPlanPeriodKey`, the shape a boundary gives expiring allowance, so the reader's log adds up
  and a store refund of that period (`googlePlayRefunds.ts`) counts it as allowance that expired.
  That row carries `PLAN_ALLOWANCE_GRANT`, never the charge's operation: a negative SETTLED row under
  the charge's operation and project is exactly what `refundLatestProjectOperationCredits` scans
  for, and it would "refund" the lapse into the purchased pool. A failure the reader did not cause
  keeps today's split exactly. The illustrated-book slot (and, on a charge from before 2026-10-15,
  the export entitlement granted beside it) stays indivisible: any kept credit keeps it, and a
  stop that kept nothing returns it.

- **A delivered attempt's charge is final: the ledger refuses to reverse a charge whose attempt
  SUCCEEDED.** `failGenerationAttemptTx` always refused a SUCCEEDED attempt, but the attempt-less
  settlements never ask the attempt — they *walk* to a charge: the API's legacy stop
  (`apps/api/src/stopLegacySettlement.ts`) and the worker's `refundFailedProjectCredits` follow a
  row's `planId` to the book's `GENERATE_BOOK` payload, and `refundLatestProjectOperationCredits`
  takes the newest charge. A free edit's recompile (a manual save, Undo, Redo, a Studio publish or
  takeover) is attempt-less and carries the book's `planId`, so a one-word edit then a delete
  reversed the whole `FULL_BOOK_GENERATION` charge of a book already downloaded, and after a period
  rollover its allowance share landed in the permanent pool (launch review 2026-10-13, B3). Those
  recompiles no longer own the book's outcome (`FREE_EDIT_RECOMPILE`,
  `apps/worker/src/handlers/CLAUDE.md`), and this is the defence behind that:
  `refundCreditLedgerEntryTx` reads the attempt the charge names (`metadata.generationAttemptId`,
  written by `startGenerationAttempt`, and the attempt must name the charge back) and returns null
  for a SETTLED charge whose attempt SUCCEEDED, so no walk can reach past it. The latest-charge scan
  then stops there rather than refunding an older charge behind it — every caller of it is an
  attempt-less fallback. It is in the shared function on purpose, and nothing legitimate is refused:
  a failure or a stop terminalizes the attempt FAILED/CANCELED before its refund, the reconciler
  only sees those, a skipped edit closes its attempt CANCELED first, a purchased cover's design
  fallback refunds before completion marks it SUCCEEDED, holds and message/voice charges carry no
  attempt, store refunds reverse grants rather than spends, and a delivered shortfall is a partial
  reversal under its own claim (`refundCreditLedgerEntryPortion`), which does not come through
  here. A new path that must give back delivered work is a grant, not a reversal.

- **No charge carries or grants an export unlock, and nothing here writes one.** A book is one
  charge at plan approval and its finished file downloads free (2026-10-15,
  `apps/api/src/mobile/CLAUDE.md`). `startGenerationAttempt` used to take `grantExportEntitlement`
  and write an `EXPORT_UNLOCK` entitlement in the attempt's transaction, and
  `ensureProjectExportEntitlementOrSpend` settled a download — an unlock held, a free
  `source: "plan_included"` one for a subscriber, or a 150-credit spend. Both are gone. What stays
  is history: the `EXPORT_UNLOCK` operation and entitlement type, the rows written before (a refund
  of the charge an old entitlement was granted beside still revokes it), and old quotes whose
  `EXPORT_UNLOCK` line the user-stop rates read like any other line and never count as delivered.
  A paid retry of an attempt charged before the change re-charges its stored price, unlock
  included, and `startGenerationAttempt`'s equality with the source's `quotedCredits` is what
  makes that the only price it can take. `grantProjectEntitlement` and
  `hasActiveProjectEntitlement` remain as the generic project-entitlement primitives; no
  production path calls either today.

## Balances and plan periods

- **A balance is two pools, and spending draws the expiring one first.** `planCredits` is the
  paid subscription allowance and it *resets* at each period boundary
  rather than accumulating; `availableCredits` is what was bought outright and never expires.
  `CreditBalance.availableCredits` is deliberately still the *total* of both, because shipped
  clients compare it against a quote. Each ledger entry records how much of itself came from the
  allowance in `planCreditsDelta`, which is what lets a refund put credits back where they came
  from — and after a period rollover a refund goes entirely to the purchased pool, because that
  period's allowance has already been re-granted in full. A refund the reader chose by stopping the
  work lets that share lapse instead (the user-stop entry above).
- **Welcome credits are granted lazily, once, not by a cron.** Signup writes a PENDING
  `WelcomeCreditGrant`; `ensureCurrentPlanPeriod` settles it on the first balance read or reserve.
  The operator toggle and amount live on the price list (`welcomeCreditsEnabled`, `welcomeCredits`;
  1,500 by default since migration 000116, sized to the largest free picture book with its plan —
  "Credit pricing" in `packages/core/CLAUDE.md`).
  `welcomeCreditIpLimit` reads the signup country's cap from
  `welcomeCreditsAccountsPerIpHighIncome` or `welcomeCreditsAccountsPerIpLowMiddleIncome`
  (defaults three and two since migration 000110: a verified email gates the grant now, so the
  cap only has to stop a farm, and at one every reader behind a carrier NAT past the first got
  nothing). Unknown countries use the latter; zero settles DISABLED.
  Caps apply inside 30 days even with regional amounts disabled, and all successful same-IP
  grants count toward the quota. Further claims settle silent
  RECENT_IP; a missing IP settles silent NO_IP — neither writes a ledger GRANT.
  A user with no row is never welcomed. Credits land in the purchased pool.
  While the API's spend breaker is paused or free accounts' spend is past its soft cap or monthly
  ceiling (paying readers' spend never holds it), a free account's grant stays PENDING: `setWelcomeGrantHold` installs the API's predicate, `ensureWelcomeCreditsTx` asks it
  (and the plan, so a reader who subscribed on day one is still welcomed), and the next balance
  read after it clears settles the grant exactly as it would have. This package never reads the
  spend controls; with no hold installed (the worker, the suites) nothing is held.
- **A welcome grant pays out only to a verified email, and the gate is inside
  `ensureWelcomeCreditsTx`, where no caller can grant past it.** The grant used to settle on the
  first balance read behind nothing but the per-address cap, so a farm rotating addresses and
  inventing emails took the welcome credits once per account and could push free spend past the
  breaker's caps for everyone (launch review, 2026-10-13). `User.emailVerifiedAt` (migration
  000106) is set by a confirmed emailed code or by Google sign-in, whose token must say
  `email_verified` (→ apps/api/CLAUDE.md); the migration stamps Google-linked accounts and every
  account whose grant was already GRANTED, and leaves the rest unverified. The check is read off the
  same `findUnique` that loads the grant (`include: { user }`), after the hold, the toggle and the
  missing-address checks, and it is not a hold threaded through callers for the reason the spend
  hold is not. An unverified account still settles every outcome that grants nothing — DISABLED,
  NO_IP, and RECENT_IP on an address already at its cap, counted without the lock because it writes
  no grant — so the app never promises credits the address cannot receive; otherwise it stays
  PENDING with nothing written and is granted, under the lock, on the first read after
  verification. Only GRANTED rows count toward the cap, so on a shared address the first account to
  *verify* is the one welcomed. A paid plan does not excuse it. `describePendingWelcomeGrant` says
  why a pending grant waits (`email_unverified` before `spend_hold`, since verifying is the step the
  reader can take) and what it would pay now — the payload's `welcomeCreditsPendingReason` and
  `welcomeCreditsPendingCredits`. The billing test harness reads every user as verified unless the
  suite adds it to `unverifiedEmailUsers`. `welcomeCredits.test.ts` ("email verification").
- **Free accounts spend welcome or purchased credits; only paid plans receive recurring grants.**
  Free calendar periods carry zero allowance. `ensureCurrentPlanPeriod` retires unused legacy
  `free:` balances with a ledger adjustment before a balance read or reservation, preserving
  welcome/purchased balances and live paid periods. Every free-plan chat message costs at least
  one credit; the daily message ceiling limits abuse and never grants credits. Google Play
  verification and `apps/api/src/subscriptionRenewal.ts` own paid recurring grants.
- **A plan period cut short is *adopted*, not re-granted.** `applyPlanPeriodTx` used to return early
  on a duplicate idempotency key, which is right for the concurrent-grant race but wrong for a
  cancellation: someone who entered a free period on the 1st, subscribed on the 5th and cancelled on
  the 20th already owns `plan-period:{userId}:free:{month}`, and returning early left them holding
  the *subscription's* allowance on the free tier. It now moves the account onto the period with a
  granted amount of 0 whenever `account.planPeriodKey !== period.key` — that guard is the safety
  property, because the race it must not disturb runs under `runSerializable` and re-reads the
  winner's key. Both `planCredits` and `planCreditsPerPeriod` are zero on the free period.
- **A store refund's debt is paid at the next period boundary, first by the allowance it hid and
  then by the new one.** A Google Play refund of spent credits leaves the purchased pool
  (`availableCredits`) negative, and a reservation is checked against both pools together, so the
  debt hides that much of a live allowance. `applyPlanPeriodTx` reset `planCredits` beside it and
  never touched it: the hidden part expired at every boundary and the debt never shrank. A Creator
  subscriber whose spent October was refunded mid-November saw 6,000 plan credits and 0 spendable
  in November, December and January, indefinitely (found 2026-10-12, before launch). `planDebt.ts`
  now settles it inside the transition. The outgoing remainder pays up to the debt instead of
  expiring — that is exactly the part the debt was hiding, and settling only from the new grant
  would charge a mid-period debt twice, once as the hidden part expiring and again out of the next
  allowance. Then the new allowance pays the rest, spread over as many periods as it takes. Each
  part is an `ADJUSTMENT` of amount 0 whose `planCreditsDelta` is the move, keyed on the incoming
  period (`plan-debt:{userId}:{periodKey}`, the remainder's with `:remainder:{outgoingKey}`) and read
  before it is written, so a re-run settles nothing twice and a free month (no remainder, no
  allowance) settles nothing at all. The grant row still records the whole allowance and the
  settlement carries no top-level `expiredPlanPeriodKey`: a refund of the period that paid a debt
  reverses all of it, and that is what brings the debt back. A debt that arrives mid-period stays
  negative until the boundary; the live allowance is never cut under the reader. Purchases and
  welcome credits need none of this — they are added to the pool the debt is in. The credit log
  sends the row with 0 credits and the amount in its title (`apps/api/src/mobile/creditLog.ts`),
  because the refund's own line already took them, and the app draws a zero line with no amount
  (`credit_log_tile.dart`).
- **A plan's allowance is granted a month at a time, worth what its phase paid for: the yearly
  plan's 6,000 every month of its paid year, an intro offer's own credits, a switched plan's share
  of a short month.** The yearly plan (`tomeza.creator_yearly`, $179.99) granted all 72,000 credits
  the day it was bought, so a reader could spend the year in days and then refund inside Play's
  window (launch review, 2026-10-15). Every order's paid period is now laid out in calendar months
  (`subscriptionAllowance.ts`, the pure half; `subscriptionMonths.ts`, the ledger half) and each
  month is one grant, lapsing at its own end like any monthly allowance.
  - **The schedule is laid out once, by the order's first granted month, and stored on every
    month's grant** (`metadata.allowanceSchedule`: order key, start, the paid end it was laid out
    against, the monthly credits, the basis; `allowanceMonth` is the month's index). Later months
    read it back, so a period end Google corrects or a grace period extends never moves a boundary:
    the last month runs to the end Google reports now (a slide, as a monthly period's always did),
    and no month runs past it. Month 1 starts one billing period before the paid end — a renewal
    starts where the last one ended, and Google reports no other start: its `startTime` is when the
    subscription began — except a plan switch's first order, which starts at the switch, because its
    period also holds the time Google carried over from the replaced plan (`newAllowanceSchedule`).
    A deferred downgrade's first order carried nothing, and starts one period back like a renewal.
    A tail under a day past the last whole month is absorbed by it.
  - **One grant per (order, month)**: month 1 keeps the order's own key
    (`google-play:subscription:<token hash>:<order>`), month *n* appends `:month:<n>`
    (`allowanceMonthKey`), and its plan period is `sub:<token hash>:<month end>`. That is what makes
    the app's verify, the sweep and RTDN racing over one month harmless. An order granted before
    schedules existed has no stored schedule and stays one grant for its whole period.
  - **The sweep is what grants months two to twelve.** The recording path sets the state row's
    `nextCreditGrantAt` to the next month's start while the paid period has months left
    (`apps/api/src/mobile/CLAUDE.md`, the renewal sweep). A cancelled plan keeps being granted to
    its paid end, because it was paid for; a refund or revocation stops it (the row is EXPIRED and
    `planRecordedOrderMonthTx` refuses a refunded order), and a deleted account is never swept.
    `PurchaseRecord.creditsGranted` is what the current order's months have granted so far.
  - **A refund reverses every month the order granted**, each against its own month
    (`applyGooglePlayRefundTx`): the grant whose `planPeriodKey` the account is still on gives back
    what is left of it, and an earlier month counts what expired unspent at its end as never
    delivered. Asked of the order alone, every month "owned" the live period and each reversal drained
    it again, overcharging the debt by every lapsed month's leftover. Spent credits become plan debt
    as before (`planDebt.ts`).
  - **What a month grants.** A trial grants 0. An intro month grants the offer's `creditAmount` from
    core's `SUBSCRIPTION_INTRO_OFFERS` (4,000 for `creator-intro-first-month`, the Max-plan floor of
    `$0.002125` after Play's 15% at $9.99; it granted all 6,000 once, $0.00142 a credit), and an
    intro under an ID that table does not know still grants the plan's allowance, because nothing
    says what it cost — add the offer there before selling it. A whole month grants the product's
    `creditAmount` divided by its billing period's months (core's `monthlyPlanCredits`; the yearly
    plan's `creditAmount` stays the 72,000 one payment buys, which is what a credit is valued
    against; the billing payload sends each plan's month as `products[].monthlyCreditAmount`, which
    the app shows as "6,000 credits every month, billed yearly"). A short month of a switch — `proration`, or any replacement purchase
    (`linkedPurchaseToken`) — grants `floor(credits × covered / whole month)`, the month counted from
    its own start as Google bills it, with a day's slack; so does the tail of carried time after a
    switch's last whole month. A fresh order's own short period is Google's to set and grants in full
    (Play's test cycles run a month in five minutes). A switch charged at full price used to grant
    one allowance for its whole period, carried time and all; yearly to Pro carries up to about four
    months of Pro, so that lost up to ~60,000 credits of paid value, and each of those months is now
    granted (launch review 2026-10-15, Medium). Upgrading away from the yearly plan forfeits only the
    month in hand. The verifier reads a proration period that absorbed the new offer's first phase
    (`originalOfferPhaseType`) as that trial or intro. A grant that was not a whole month's allowance
    stamps `allowanceBasis` (and `coveredFraction`).
  `subscriptionAllowance.test.ts`, `subscriptionYearlyPlan.test.ts` (twelve months through a
  simulated sweep, races, the clipped last month, cancel, refund, switches both ways),
  `subscriptionPlanChanges.test.ts`, `purchasePayments.test.ts`, and core's `billing.test.ts`, which
  prices its margin tests at the cheapest credit sold — intro offers included — rather than at Max
  by name.
- **A downgrade starts at the renewal date, and until then the token Play issued for it carries the
  plan it replaces.** The app switches down with `ReplacementMode.deferred` (`apps/mobile/CLAUDE.md`),
  because a full-price switch forfeited what was left of the bigger allowance the reader had paid
  for. Play issues the new token at once: its old line item keeps the paid expiry and names the
  plan replacing it (`deferredItemReplacement`), the new item has no expiry and no order yet, and
  the old token reads as expired. The verifier (`mapDeferredReplacement`) accepts either product,
  reports the plan it renews into, the old item's expiry as the period end, **no order id** (the old
  item's order is the old token's payment), and `subscription.deferredReplacement`; it stays
  `grantable` so it is acknowledged now, or Play refunds it. Recording it grants the new plan nothing
  and records no payment. `retireReplacedSubscriptionTx` still stamps the old record
  `replacedByPurchaseTokenHash` — so Google's "expired" for the old token is a no-op — but in
  deferred mode it does not expire the old entitlement and the old state row keeps the end of the
  period it paid for; the old plan's entitlement moves onto the new record (a further switch away
  from that token must take it down), and the allowance stays on the old period. **The old plan's
  paid months keep coming from the new token**: its row is the one the sweep polls, due at the old
  order's next month and then at `takesEffectAt`, and each verification of it grants the old order's
  current month under the old token's keys and record (`planRecordedOrderMonthTx`, `carriedBy:
  "deferred_replacement"`) — a monthly plan has none left, a yearly one up to eleven. A refund of the
  old order stops those months and revokes the carried entitlement where it now sits, because it
  still names the order that paid for it. At `takesEffectAt` the first paid period of the new plan
  grants through the ordinary path, which also expires the carried plan entitlement. Meanwhile
  `getPlanSummary` reports the plan being run out as `productSku`, the new token's hash, and
  `pendingChange`, so the app's next switch matches what Play holds. Not handled: a reader who
  undoes the pending change inside Play leaves a token holding only the old product, which
  re-verifies against the state's new product as `GOOGLE_PLAY_PRODUCT_MISMATCH` until a restore
  records it again. `subscriptionPlanChanges.test.ts`, `subscriptionYearlyPlan.test.ts` and
  `googlePlayBilling.test.ts` pin it.
- **A paid period outlives a token Google calls expired: only its paid end, a refund or its
  replacement ends it, whichever of Google's reports lands first.** A non-grantable verification
  ended the plan on the spot: entitlement expired, `planPeriodEnd` set to now, the account dropped to
  free. Google reports a deferred downgrade's old token expired the moment the new one is issued,
  and when that report was recorded first — an RTDN for the old token, the cancel sheet's refresh
  re-checking the stored one, a verify of the new token that failed first — a Max subscriber lost
  about 50,000 unspent credits and sat on free until the renewal date, because the new token then
  found no live plan to carry (launch review 2026-10-15, C6). `keepPaidPeriodTx`
  (`subscriptionMonths.ts`) now answers first: a token whose state row last recorded it live
  (ACTIVE, grace or cancelled) with its paid end still ahead, and no refund or revocation against
  its order (those return earlier, as REVOKED), keeps its plan, entitlement and allowance; the row
  becomes CANCELED — running out, not over — with that paid end kept, due again at the order's next
  month or the paid end, and the order's months keep being granted from what it recorded (`carriedBy:
  "paid_period_kept"`). The purchase record is left as it was. The new token's arrival then retires
  the old one exactly as in the other order, so both end in the same state (the suite compares them
  whole). A genuine end still ends it: a lapsed renewal or a payment failure past grace is reported
  after the recorded paid end, a refund or revocation leaves its marker, an account deletion's cancel
  runs the period out, and a revocation whose refund notice is late is kept only until that notice
  lands. `subscriptionPlanChanges.test.ts` ("launch review C6", and "a genuine expiry still ends the
  plan").
- **A payment's local price is the buyer's own currency for analytics, and it never decides a
  grant.** `PurchasePayment.localPriceMicros` / `localCurrency` / `localPriceSource` (migration
  000104) hold what an order charged in the buyer's currency, before tax and Google's cut, beside
  the USD catalog figure `amountMicros` keeps. `client` is the app's report from Play's product
  details at verify time (the pricing phase bought for a subscription, price × quantity for a pack);
  `play_recurring_price` is Google's `autoRenewingPlan.recurringPrice` for a full-price period nobody
  verified from the app (the sweep, RTDN) — never for an intro or prorated one, which charged
  something else. Set once, never repriced: a later report only fills a payment recorded without
  one. `PurchaseRecord` keeps the app's latest report too, so a pack still pending when the app
  reported it gets its price when RTDN grants it. The app sends both or neither and old builds send
  neither (`apps/api/src/mobile/schemas.ts`).
