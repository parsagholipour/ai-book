-- Search grounding allowance: one counter per (allowance pool, Pacific-time
-- day or month), claimed with an upsert-increment in the same transaction as
-- the grounded search's ProviderCallLog row, so each grounded prompt gets a
-- unique ordinal and is priced free inside Google's daily/monthly allowance
-- and at list price past it. See packages/db/src/searchGroundingAllowance.ts.

-- CreateTable
CREATE TABLE "SearchGroundingAllowanceCounter" (
    "pool" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchGroundingAllowanceCounter_pkey" PRIMARY KEY ("pool","period")
);
