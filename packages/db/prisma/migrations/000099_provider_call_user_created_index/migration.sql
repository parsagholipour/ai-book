-- A reader's provider spend since a moment: `WHERE "userId" = ? AND
-- "createdAt" >= ?`, summed by `providerSpendSince` (packages/db/src/providerSpend.ts).
--
-- CONCURRENTLY for the reason 000065 gives at length: every worker inserts into
-- this table on every provider call, and a plain CREATE INDEX takes SHARE,
-- which blocks each of those inserts for the whole build while the previous
-- deployment is still serving. Alone in its file so a failed build is one
-- idempotent statement to recover: `DROP INDEX CONCURRENTLY
-- "ProviderCallLog_userId_createdAt_idx"` and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ProviderCallLog_userId_createdAt_idx" ON "ProviderCallLog"("userId", "createdAt");
