-- Everyone's provider spend since a moment: `WHERE "createdAt" >= ?`, summed by
-- `providerSpendSince` (packages/db/src/providerSpend.ts). The existing
-- `(provider, model, purpose, createdAt)` index cannot serve it — its leading
-- columns are not in the predicate.
--
-- CONCURRENTLY and alone in its file, for the reasons 000065 and 000099 give.
-- Recovery from a failed build: `DROP INDEX CONCURRENTLY
-- "ProviderCallLog_createdAt_idx"` and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ProviderCallLog_createdAt_idx" ON "ProviderCallLog"("createdAt");
