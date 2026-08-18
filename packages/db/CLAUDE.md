# DB

Prisma client, schema, and the billing/credit ledger. This package is what makes a reserve, a
commit or a refund *mean* something — nothing above it can change that.

`src/generated/` is produced by Prisma and gitignored. Run `pnpm db:generate` after touching
`prisma/schema.prisma`; never edit it by hand.

## Importing billing

`src/billing.ts` is a facade over `billingLedger.ts` (balances), `billingEntitlements.ts`,
`billingSubscriptions.ts` (Google Play), `planPeriods.ts` (allowances and quotas) and
`billingInternals.ts` (shared plumbing).

**Import `@book-maker/db/billing`, never a module behind it.** The API suites mock the facade with
`vi.mock("@book-maker/db/billing")`; a deep import silently escapes that mock and the test stops
covering you. The package's `exports` map has exactly two entries (`.` and `./billing`) to keep
that honest.

## Adding a priced operation

Add the value to `enum CreditOperation` in `prisma/schema.prisma`, add the price key to
`DEFAULT_CREDIT_COSTS` and `CREDIT_PRICING_LIMITS` in `packages/core/src/creditPricing.ts` (the
latter is an exhaustive `Record`, so the compiler catches a missed key), then close the loop:
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

## Tests

`src/testing/billingTestDb.ts` is the shared harness. Nothing here needs a live Postgres.

## The reserve, commit, refund loop

- **Credits are reserved, then committed or refunded.** Any new priced operation has to close that
  loop, including on the failure path. `packages/db/src/billing.ts` is a facade over
  `billingLedger.ts` (balances), `billingEntitlements.ts`, `billingSubscriptions.ts` (Google Play),
  `planPeriods.ts` (allowances and quotas) and `billingInternals.ts` (shared plumbing) — import the
  facade, never a module behind it, or the `vi.mock("@book-maker/db/billing")` in the API suites
  stops covering you.

- **A charge has one cumulative reversal, and partial settlements name their claim.**
  `refundCreditLedgerEntryPortion` is the ledger's only partial reversal, for work priced by the
  page that delivered fewer than it billed — a structural insert that resumed against a book
  holding two of its five recorded pages. The unique `reversesEntryId` still links one REFUND row,
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

## Balances and plan periods

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
- **A plan period cut short is *adopted*, not re-granted.** `applyPlanPeriodTx` used to return early
  on a duplicate idempotency key, which is right for the concurrent-grant race but wrong for a
  cancellation: someone who took their free month on the 1st, subscribed on the 5th and cancelled on
  the 20th already owns `plan-period:{userId}:free:{month}`, and returning early left them holding
  the *subscription's* allowance on the free tier. It now moves the account onto the period with a
  granted amount of 0 whenever `account.planPeriodKey !== period.key` — that guard is the safety
  property, because the race it must not disturb runs under `runSerializable` and re-reads the
  winner's key. `planCreditsPerPeriod` still gets the period's full size, so the app reads
  "0 of 1,000 monthly credits left" rather than a plan with no allowance at all.
