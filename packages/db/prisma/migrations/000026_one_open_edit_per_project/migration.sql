-- Enforce at most one open (QUEUED or ACTIVE) BookEditOperation per project.
-- The application-level hasOpenProjectWork() check is check-then-act and can
-- race when two chat messages arrive concurrently; this index is the backstop.

-- Settle any existing duplicate open operations first (keep the newest one).
UPDATE "BookEditOperation" o
SET "status" = 'FAILED',
    "error"  = 'Superseded by a newer edit'
WHERE o."status" IN ('QUEUED', 'ACTIVE')
  AND EXISTS (
    SELECT 1
    FROM "BookEditOperation" n
    WHERE n."projectId" = o."projectId"
      AND n."status" IN ('QUEUED', 'ACTIVE')
      AND n."createdAt" > o."createdAt"
  );

-- Partial unique indexes cannot be expressed in the Prisma schema DSL; this
-- index exists only in SQL. Never `prisma db push` over a database that has it.
CREATE UNIQUE INDEX "BookEditOperation_one_open_per_project"
  ON "BookEditOperation" ("projectId")
  WHERE ("status" IN ('QUEUED', 'ACTIVE'));
