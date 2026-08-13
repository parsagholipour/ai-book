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

## Tests

`src/testing/billingTestDb.ts` is the shared harness. Nothing here needs a live Postgres.

## The reserve, commit, refund loop

- **Credits are reserved, then committed or refunded.** Any new priced operation has to close that
  loop, including on the failure path. `packages/db/src/billing.ts` is a facade over
  `billingLedger.ts` (balances), `billingEntitlements.ts`, `billingSubscriptions.ts` (Google Play),
  `planPeriods.ts` (allowances and quotas) and `billingInternals.ts` (shared plumbing) — import the
  facade, never a module behind it, or the `vi.mock("@book-maker/db/billing")` in the API suites
  stops covering you.

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
