-- Structural page deletes remove Page rows, whose ON DELETE CASCADE used to
-- erase every earlier edit snapshot for those pages. Park those snapshots
-- outside the Page foreign key until structural Undo recreates the pages.
CREATE TABLE "ArchivedPageEditSnapshot" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "archiveKey" TEXT NOT NULL,
  "pageIndex" INTEGER NOT NULL,
  "titleBefore" TEXT NOT NULL,
  "markdownBefore" TEXT NOT NULL,
  "summaryBefore" TEXT NOT NULL,
  "revisionBefore" INTEGER NOT NULL,
  "storyDeltaBefore" JSONB,
  "titleAfter" TEXT,
  "markdownAfter" TEXT,
  "summaryAfter" TEXT,
  "revisionAfter" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArchivedPageEditSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ArchivedPageEditSnapshot_projectId_archiveKey_idx"
  ON "ArchivedPageEditSnapshot"("projectId", "archiveKey");
CREATE INDEX "ArchivedPageEditSnapshot_operationId_idx"
  ON "ArchivedPageEditSnapshot"("operationId");
CREATE INDEX "ArchivedPageEditSnapshot_pageId_idx"
  ON "ArchivedPageEditSnapshot"("pageId");

ALTER TABLE "ArchivedPageEditSnapshot"
  ADD CONSTRAINT "ArchivedPageEditSnapshot_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArchivedPageEditSnapshot"
  ADD CONSTRAINT "ArchivedPageEditSnapshot_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "BookEditOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No Page FK and no FK from archiveKey to the structural operation. The first
-- would repeat the data loss this table fixes; the second would expose an older
-- operation's surviving snapshots as a partial Undo if a permanent structural
-- delete later retires its own operation row.
