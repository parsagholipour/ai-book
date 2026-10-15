-- Whose spend a provider call was. `ProviderCallLog` named only the book and
-- the job, so "what has this reader cost us today" was a join through
-- `Project` that missed every call with no book behind it (the library
-- portrait job, the creation chat, library-character voice calls). A spend
-- cap per reader needs the answer on the row. Writers fill it from 000098 on;
-- older rows stay null and are still reachable through their project.
--
-- No backfill: every reader of this column sums a recent window, and a
-- whole-table UPDATE here would hold row locks on the table every worker is
-- settling into while the previous deployment is still serving.
--
-- The foreign key is added NOT VALID and validated separately: the add takes
-- only a brief lock and checks no existing row, and VALIDATE takes
-- SHARE UPDATE EXCLUSIVE, which blocks no INSERT while it scans a column that
-- is null on every row. A user row is never hard-deleted (account deletion
-- keeps a tombstone), so SET NULL is the dev-only answer to a deleted user.
-- The two indexes are their own migrations (000099, 000100) because each is
-- built CONCURRENTLY, which must be alone in its file (see 000065).
ALTER TABLE "ProviderCallLog" ADD COLUMN "userId" TEXT;

ALTER TABLE "ProviderCallLog" ADD CONSTRAINT "ProviderCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ProviderCallLog" VALIDATE CONSTRAINT "ProviderCallLog_userId_fkey";
