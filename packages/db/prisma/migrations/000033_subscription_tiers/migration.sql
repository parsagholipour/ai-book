-- Subscription tiers: a monthly allowance pool alongside the purchased balance,
-- a third paid plan, and the per-month usage counters the free tier is capped by.

ALTER TYPE "UserEntitlementType" ADD VALUE IF NOT EXISTS 'MAX_PLAN';
ALTER TYPE "CreditOperation" ADD VALUE IF NOT EXISTS 'PLAN_ALLOWANCE_GRANT';

-- The allowance pool. Existing balances stay in "availableCredits" (purchased,
-- never expires) — no backfill, so nobody loses credits they already hold.
ALTER TABLE "UserCreditAccount"
    ADD COLUMN "planCredits" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "planCreditsPerPeriod" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "planPeriodStart" TIMESTAMP(3),
    ADD COLUMN "planPeriodEnd" TIMESTAMP(3),
    ADD COLUMN "planPeriodKey" TEXT;

-- How much of an entry moved the allowance pool rather than the purchased one.
-- Pre-existing rows are all purchased-pool, which 0 says correctly.
ALTER TABLE "CreditLedgerEntry"
    ADD COLUMN "planCreditsDelta" INTEGER NOT NULL DEFAULT 0;

-- Raw Play token, so the renewal sweep can re-verify a subscription without the
-- app checking in. Every other record keeps only the hash.
ALTER TABLE "SubscriptionState"
    ADD COLUMN "purchaseToken" TEXT;

CREATE INDEX "SubscriptionState_status_nextCreditGrantAt_idx"
    ON "SubscriptionState"("status", "nextCreditGrantAt");

CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- One row per user per counter per period: the conditional increment that
-- enforces a limit needs a single row to contend on.
CREATE UNIQUE INDEX "UsageCounter_userId_kind_periodKey_key"
    ON "UsageCounter"("userId", "kind", "periodKey");

CREATE INDEX "UsageCounter_userId_kind_idx" ON "UsageCounter"("userId", "kind");

ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
