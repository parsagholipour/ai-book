ALTER TABLE "MobileCreationDraft"
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "MobileCreationDraft_userId_archived_updatedAt_idx"
  ON "MobileCreationDraft"("userId", "archived", "updatedAt");
