-- A page number is presentation state, not identity: deletes and moves reuse
-- `page:<index>`, so continuity notes need the same stable Page ownership that
-- image assets and edit snapshots already have.
ALTER TABLE "ContinuityNote" ADD COLUMN "pageId" TEXT;

-- Backfill books that have never recorded a structural operation: their page
-- indexes have not been reused by this feature, so the mapping is unambiguous.
-- If an earlier application deployment already accepted such an operation, all
-- of that project's legacy page notes stay unowned instead of being guessed at.
-- Runtime code never repeats this inference. Any unowned page-scoped row is
-- excluded from prompts and later discarded by a structural transaction.
UPDATE "ContinuityNote" AS n
SET "pageId" = p."id"
FROM "Page" AS p
WHERE n."projectId" = p."projectId"
  AND n."scope" LIKE 'page:%'
  AND p."index" = substring(n."scope" FROM '^page:([0-9]+)')::integer
  AND NOT EXISTS (
    SELECT 1
    FROM "BookEditOperation" AS o
    WHERE o."projectId" = n."projectId"
      AND o."kind" = 'RESTRUCTURE_PAGES'
  );

CREATE INDEX "ContinuityNote_pageId_idx" ON "ContinuityNote"("pageId");

ALTER TABLE "ContinuityNote"
  ADD CONSTRAINT "ContinuityNote_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
