ALTER TABLE "ProjectChatMessage"
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "isActiveChild" BOOLEAN NOT NULL DEFAULT true;

WITH ordered AS (
  SELECT
    "id",
    LAG("id") OVER (PARTITION BY "projectId" ORDER BY "createdAt", "id") AS "parentId"
  FROM "ProjectChatMessage"
)
UPDATE "ProjectChatMessage" AS message
SET "parentId" = ordered."parentId"
FROM ordered
WHERE message."id" = ordered."id"
  AND ordered."parentId" IS NOT NULL;

CREATE INDEX "ProjectChatMessage_projectId_parentId_idx"
  ON "ProjectChatMessage"("projectId", "parentId");

CREATE INDEX "ProjectChatMessage_parentId_idx"
  ON "ProjectChatMessage"("parentId");

ALTER TABLE "ProjectChatMessage"
  ADD CONSTRAINT "ProjectChatMessage_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "ProjectChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
