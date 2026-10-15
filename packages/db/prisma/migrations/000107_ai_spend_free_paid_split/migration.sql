-- The AI spend breaker's global caps now count free spend only (readers with no
-- active plan, plus calls that name no reader), so a farm of free accounts can
-- no longer pause AI for paying readers. Two caps join them: a ceiling on free
-- spend per UTC month, and a catastrophe stop on paid readers' spend per UTC
-- day. Nullable, so a revision saved before this reads the compiled defaults in
-- apps/api/src/spendControls.ts; every save from the console writes both.
ALTER TABLE "AiSpendControlRevision" ADD COLUMN "freeMonthlyCapUsd" DOUBLE PRECISION;
ALTER TABLE "AiSpendControlRevision" ADD COLUMN "paidHardDailyCapUsd" DOUBLE PRECISION;
