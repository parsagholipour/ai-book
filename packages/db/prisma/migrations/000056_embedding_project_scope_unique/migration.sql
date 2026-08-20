-- One Embedding row per (projectId, scope). Repair races otherwise insert a
-- second healthy row: waves are top-up based, so a page stuck in BullMQ retry
-- backoff can lag well behind the frontier, complete, and sit between its
-- COMPLETED write and its own storeEmbedding — exactly when a sibling's
-- repairPageEmbeddings sees "COMPLETED, no row" and inserts. Two page jobs in
-- the same wave can also both repair the same missing scope. Retrieval already
-- dedupes by scope, so the cost is wasted embed calls and permanent duplicates,
-- not wrong answers. Collapse extras first (keep a vectored row over a
-- degraded placeholder, then newest createdAt) so uniqueness does not pin an
-- outage forever, then replace the non-unique init index.
DELETE FROM "Embedding" AS dupe
USING (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY "projectId", "scope"
      ORDER BY
        CASE WHEN "vector" IS NOT NULL THEN 0 ELSE 1 END,
        "createdAt" DESC,
        id ASC
    ) AS rn
  FROM "Embedding"
) AS keep
WHERE dupe.id = keep.id AND keep.rn > 1;

DROP INDEX IF EXISTS "Embedding_projectId_scope_idx";
CREATE UNIQUE INDEX "Embedding_projectId_scope_key" ON "Embedding"("projectId", "scope");
