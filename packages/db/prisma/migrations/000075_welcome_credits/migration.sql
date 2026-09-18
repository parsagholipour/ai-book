-- One-time welcome credits: a grant operation, a per-account claim row, and
-- no backfill. Existing users keep whatever they already hold and are never
-- welcomed; new accounts get a PENDING row at signup.

ALTER TYPE "CreditOperation" ADD VALUE 'WELCOME_GRANT';

CREATE TYPE "WelcomeCreditOutcome" AS ENUM ('PENDING', 'GRANTED', 'DISABLED', 'RECENT_IP', 'NO_IP');

CREATE TABLE "WelcomeCreditGrant" (
  "userId" TEXT NOT NULL,
  "ipHash" TEXT,
  "outcome" "WelcomeCreditOutcome" NOT NULL DEFAULT 'PENDING',
  "amountCredits" INTEGER NOT NULL DEFAULT 0,
  "ledgerEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),

  CONSTRAINT "WelcomeCreditGrant_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "WelcomeCreditGrant_ledgerEntryId_key" ON "WelcomeCreditGrant"("ledgerEntryId");
CREATE INDEX "WelcomeCreditGrant_ipHash_outcome_settledAt_idx" ON "WelcomeCreditGrant"("ipHash", "outcome", "settledAt");

ALTER TABLE "WelcomeCreditGrant" ADD CONSTRAINT "WelcomeCreditGrant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
