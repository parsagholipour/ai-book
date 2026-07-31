-- Operator-set credit prices. Append-only: the highest version is the current
-- price list, and an empty table means the defaults compiled into packages/core.
CREATE TABLE "CreditPricingRevision" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "changed" JSONB NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditPricingRevision_pkey" PRIMARY KEY ("id")
);

-- Two operators saving at once must collide here rather than both claim the head.
CREATE UNIQUE INDEX "CreditPricingRevision_version_key" ON "CreditPricingRevision"("version");

CREATE INDEX "CreditPricingRevision_createdAt_idx" ON "CreditPricingRevision"("createdAt");
