-- Operator-controlled AI spend breaker. Each revision is the whole set of
-- controls: the manual pause and the four daily USD caps (soft and hard on
-- everyone's provider spend, and one per reader for free and paid plans).
-- Empty table = the compiled defaults in apps/api/src/spendControls.ts, never
-- "no limits".
CREATE TABLE "AiSpendControlRevision" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "softDailyCapUsd" DOUBLE PRECISION NOT NULL,
    "hardDailyCapUsd" DOUBLE PRECISION NOT NULL,
    "freeUserDailyCapUsd" DOUBLE PRECISION NOT NULL,
    "paidUserDailyCapUsd" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSpendControlRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiSpendControlRevision_version_key" ON "AiSpendControlRevision"("version");
CREATE INDEX "AiSpendControlRevision_createdAt_idx" ON "AiSpendControlRevision"("createdAt");
