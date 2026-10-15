-- A deleted book's storage prefixes, kept until they are known to stay empty
-- (apps/api/src/projectStorage.ts writes them before the first delete;
-- apps/api/src/storageDeletionSweep.ts deletes each prefix again every 15
-- minutes and drops the row once it is a day old and a pass found nothing).
-- A book's delete used to try S3 once and answer 200 whatever happened, and a
-- job still running for the book could write into its prefix afterwards. A
-- new, empty table: nothing else reads or writes it, so it locks nothing in use.
CREATE TABLE "PendingStorageDeletion" (
    "prefix" TEXT NOT NULL,
    "projectId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSweptAt" TIMESTAMP(3),
    "lastFound" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "PendingStorageDeletion_pkey" PRIMARY KEY ("prefix")
);

CREATE INDEX "PendingStorageDeletion_lastSweptAt_idx" ON "PendingStorageDeletion"("lastSweptAt");

-- The daily prune of product events past retention (apps/api/src/tablePruneSweep.ts):
-- `WHERE "createdAt" < ?`, which neither existing index leads with. Not
-- CONCURRENTLY: the table arrived in 000096 with this release and is empty
-- when this runs, so the SHARE lock is held for no time at all.
CREATE INDEX "ProductEvent_createdAt_idx" ON "ProductEvent"("createdAt");
