INSERT INTO "User" ("id", "email", "displayName", "status", "createdAt", "updatedAt")
VALUES ('local-admin', 'local-admin@ai-book-maker.local', 'Local Admin', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("email") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "updatedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "Project" ADD COLUMN "userId" TEXT;

UPDATE "Project"
SET "userId" = (
  SELECT "id"
  FROM "User"
  WHERE "email" = 'local-admin@ai-book-maker.local'
  LIMIT 1
)
WHERE "userId" IS NULL;

ALTER TABLE "Project" ALTER COLUMN "userId" SET NOT NULL;

CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");
CREATE INDEX "Project_userId_createdAt_idx" ON "Project"("userId", "createdAt");

ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
