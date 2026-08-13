---
name: add-priced-operation
description: Use when charging credits for something new, or changing what an existing operation costs — a new value in `enum CreditOperation`, a new key in `DEFAULT_CREDIT_COSTS`, a new tier rate beside `TIER_PRICED_KEYS`, or any route that calls `reserveCredits` / `startGenerationAttempt` / `commitReservedCredits` / `refundCreditLedgerEntry`. Covers the reserve→commit→refund loop that every failure path has to close, the exhaustive `CREDIT_PRICING_LIMITS` record the compiler checks, the `withChargedEnqueue` skeleton in apps/api/src/mobile/editOperations.ts, the operator pricing dashboard, and the Dart mirror `estimateProjectCredits` that has no server quote route behind it. Reach for it on "how much should this cost", "add a credit price", "make X free", "the user was charged but the job failed", "double charge", or "why is this showing up as unbilled spend".
---

# Pricing a new operation, or changing what one costs

Two independent jobs: getting the *number* into the pricing table (operator-editable, live-reloaded,
mirrored in Dart), and closing the *reserve → commit → refund* loop on every path the work can die
on. Skipping the second is how a user pays for a book that was never written.

Reasoning lives in [`packages/db/CLAUDE.md`](../../../packages/db/CLAUDE.md) (the ledger, the two
credit pools, plan periods) and [`packages/core/CLAUDE.md`](../../../packages/core/CLAUDE.md) (the
pricing snapshot and why prices are not constants). The admin surface is described in
[`apps/api/src/admin/CLAUDE.md`](../../../apps/api/src/admin/CLAUDE.md).

## Step 0 — decide three things

1. **Is it a new `CreditOperation`, or a new price key on an existing one?** A `CreditOperation` is
   what a ledger entry records and what the credit log, the admin economics view and the refund
   paths group by. A price key is just an input to a quote. Adding a key is cheap; adding an
   operation touches the Prisma enum, the `BillingOperation` union, `creditCostForOperation`,
   `OPERATION_TITLES` and the admin JobType→operation map.
2. **Is it tier-priced?** If the quality preset (fast / balanced / premium) routes the work to
   genuinely different models, it needs `Fast` and `Premium` twin keys and must be read through
   `tierPrice`. If the work reaches a tier-blind provider, or it is request overhead rather than
   model spend, keep it flat — see the note beside `TIER_PRICED_KEYS` in
   `packages/core/src/billing.ts`.
3. **Is it free-tier-limited?** Limits live in the same table as prices but are *not* prices; see
   `PLAN_ALLOWANCE_KEYS`. Anything projecting revenue iterates `CREDIT_PRICE_KEYS`, never
   `CREDIT_PRICING_KEYS`, or it invents income from the free tier.

## Step 1 — the price

- `packages/db/prisma/schema.prisma` — `enum CreditOperation`, only for a genuinely new operation.
  Then `pnpm db:generate`.
- `packages/core/src/billing.ts` — the `BillingOperation` union and a `case` in
  `creditCostForOperation` (its `default: assertNever(operation)` makes this one compiler-checked).
  For a tiered key: add it to `TIER_PRICED_KEYS`; `tierPriceKey` and `tierPrice` then work by the
  `…Fast` / `…Premium` suffix convention with no further edits.
- `packages/core/src/creditPricing.ts` — `DEFAULT_CREDIT_COSTS` (the unsuffixed key *is* the
  balanced rate, which is what makes new tier keys migration-free) and `CREDIT_PRICING_LIMITS`.
  `CREDIT_PRICING_LIMITS` is `Record<CreditPricingKey, number>`, so **the compiler catches a
  missed key here and nowhere else in this step**. Per-unit rates get much tighter ceilings than
  flat charges. `PLAN_ALLOWANCE_KEYS` if it is a limit rather than a price.
  `creditPricingInputSchema` and `CREDIT_PRICE_KEYS` derive from these — no edit.
- Read prices with `creditPricing()` and never capture one at module load: overrides are loaded
  from the append-only `CreditPricingRevision` table by `packages/db/src/creditPricing.ts`, applied
  only after the write commits, and re-read by `server.ts` every 15s. Pure pricing functions take
  an optional trailing `pricing` argument so `/api/admin/pricing/preview` can quote unsaved values.

## Step 2 — the charge

Import from the `@book-maker/db/billing` **facade** only. Never from `billingLedger.ts`,
`billingEntitlements.ts`, `billingSubscriptions.ts`, `planPeriods.ts` or `billingInternals.ts`
directly — the API suites `vi.mock("@book-maker/db/billing")`, and a deep import walks straight
past the mock.

Two entry points, and they are not interchangeable:

- **`startGenerationAttempt`** (`packages/db/src/generationAttempts.ts`) — the boundary for
  anything that queues durable work. It claims a semantic command by
  `commandKey` + `requestFingerprint` *before* money moves, then commits the reservation and the
  domain rows in one serializable transaction, and returns `{ attempt, replayed }`. `replayed`
  is what makes a double-tap free. No queue or network call belongs inside its `create` callback;
  dispatch after it returns. It also carries `imageQuotaLimit`, which is how a free-tier
  illustrated-book slot is stamped onto the reservation so the refund path hands it back without
  knowing about quotas.
- **`reserveCredits`** (`packages/db/src/billingLedger.ts`) — the lower-level hold, keyed by
  `idempotencyKey`. Returns `null` when the price is zero. Pair with `commitReservedCredits(id)`
  on success and `refundCreditLedgerEntry(id, reason)` on every failure.

For a charged operation that ends in an enqueue, do not hand-roll this: use `withChargedEnqueue`
in `apps/api/src/mobile/editOperations.ts`. It exists so "every failure path refunds" is enforced
by the shape of the code. Its compensation ordering is the safety property — a refund happens only
after `cancelUndispatchedGenerationJob` provably claimed the row, because a job that already
dispatched *will* run and its charge must stand. Your `run` callback must call
`registerQueuedJob(jobId)` the moment a durable job row exists, or the catch cannot reach it.

## Step 3 — the surfaces that display it

- `apps/api/src/mobile/creditLog.ts` — `OPERATION_TITLES`. A missing entry falls back to
  `sentenceCase(row.operation)`, which reads as `FULL BOOK GENERATION` in the user's credit log.
- `apps/api/src/routes/adminPricing.ts` — GET / PUT / preview. Validation comes from
  `creditPricingInputSchema`; the OpenAPI twin next to it has to be updated alongside.
- `apps/web/src/features/pricing/pricingFields.ts` — the dashboard's field groups, labels and help
  text. A key absent here is uneditable by the operator even though the API accepts it.
- `apps/api/src/admin/operationEconomics.ts` — the JobType→`CreditOperation` `CASE`. Unmapped spend
  lands in the `UNBILLED_*` buckets rather than being attributed by guess; that is a deliberate
  safety property, not a bug to paper over.
- `apps/mobile/lib/features/projects/domain/project_models.dart` — `estimateProjectCredits`, with
  `_tierCost` mirroring `tierPrice`. **This matters only for the tiered keys** the app quotes
  before a book exists. There is no server quote route to fall back on, so the two implementations
  must move together; both sides spell their expected totals out literally in tests
  (`apps/api/src/mobile/creditTierPricing.test.ts` and the Dart tests) rather than deriving them
  from the price table, precisely so a shared bug cannot hide. Do not add a `modelTier` field to
  the project DTO — the mobile leak guard rejects any wire key containing "model"; the app reads
  `qualityPreset`.

## Step 4 — exit checklist: name the code that refunds on each path

Do not mark this done until every row has a named function or a stated reason it cannot happen.

| Failure | Who refunds | Confirm by |
| --- | --- | --- |
| Validation / precondition rejects after reserve | `refundCreditLedgerEntry`, or the reserve never ran | reserve is the *last* thing before the durable write |
| Insufficient credits | `reserveCredits` throws `InsufficientCreditsError`; nothing to refund | route answers 402 without a ledger row |
| Domain transaction rolls back | `startGenerationAttempt`'s serializable transaction | no attempt row, no ledger row |
| Enqueue fails before the job row exists | `withChargedEnqueue` catch → `refundCreditLedgerEntry` | `registerQueuedJob` was never called |
| Enqueue fails after the job row exists | `cancelUndispatchedGenerationJob` first, refund only if it claimed the row | a dispatched job keeps its charge, by design |
| Worker handler throws | `markFailed` → `refundFailedProjectCredits` (`apps/worker/src/runtime/jobLifecycle.ts`) | the job must own the project lifecycle, or refund on its own row |
| User stops the run | `markStopped` in the worker **and** `stopProjectGenerationJobs` in `apps/api/src/queue.ts` | both implementations exist; check which one runs for your job |
| Watchdog / render timeout | same as worker failure | `compile-export` has no BullMQ retry, so one timeout is terminal |
| Job succeeded but bookkeeping failed | nothing — the work is delivered | `durableCompletionCommitted` in `processJob.ts` |
| A free-tier quota slot was claimed | `refundCreditLedgerEntry` returns it via `metadata.imageQuota` | a zero-priced operation writes no ledger entry, so it can carry no claim |

The last row is the trap worth restating as a question: **if the price can be zero, does the
zero-price path still need the quota/entitlement bookkeeping the priced path does?** A zero-priced
operation has no ledger entry to hang a claim on.

## Verify

```bash
pnpm db:generate                     # if schema.prisma moved
pnpm typecheck                       # CREDIT_PRICING_LIMITS + creditCostForOperation's assertNever
pnpm --filter @book-maker/core test  # creditPricing.test.ts, billing.test.ts
pnpm --filter @book-maker/db test    # billing.test.ts, generationAttempts.test.ts, planPeriods.test.ts
pnpm --filter @book-maker/api test   # editOperations.test.ts, billing.test.ts, creditTierPricing.test.ts
make mobile-test                     # only if the Dart mirror moved
pnpm check
```

Then exercise it against `MOCK_AI=true pnpm dev:api` + `MOCK_AI=true pnpm dev:worker`: run the
operation once to success and once to a forced failure, and read the `CreditLedgerEntry` rows both
times. A correct loop leaves exactly one SETTLED spend on success, and a spend plus its refund on
failure — never a RESERVED row still sitting there.
